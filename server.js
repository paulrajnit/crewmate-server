/**
 * CrewMate Backend Server v6
 * Auto-detects Chromium path across environments
 */

import express      from "express";
import puppeteer    from "puppeteer";
import * as cheerio from "cheerio";
import crypto       from "crypto";
import { execSync } from "child_process";
import fs           from "fs";

const app  = express();
const PORT = process.env.PORT || 3000;

const ALLOWED_ORIGINS = [
  "https://crewmate-beta.vercel.app",
  "http://localhost:5173",
];

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin))
    res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.json());

const CWP_BASE   = "https://roc.jetstar.com/CWP_WA";
const CWP_LOGIN  = `${CWP_BASE}/CWPLogin.aspx`;
const CWP_ROSTER = `${CWP_BASE}/CWP_RosterTW.aspx`;
const CWP_PDF    = `${CWP_BASE}/CWP_WindowRosterPDF.aspx`;

const sessions    = new Map();
const SESSION_TTL = 4 * 60 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [k,v] of sessions)
    if (now - v.createdAt > SESSION_TTL) sessions.delete(k);
}, 15 * 60 * 1000);

// ── Find Chromium executable ──────────────────────────────────────────────
function findChromium() {
  // 1. Environment variable (set by nixpacks)
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    if (fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
      console.log(`Chromium: env var → ${process.env.PUPPETEER_EXECUTABLE_PATH}`);
      return process.env.PUPPETEER_EXECUTABLE_PATH;
    }
  }

  // 2. Common paths on Railway/Nix
  const candidates = [
    "/run/current-system/sw/bin/chromium",
    "/run/current-system/sw/bin/chromium-browser",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/nix/var/nix/profiles/default/bin/chromium",
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      console.log(`Chromium: found at ${p}`);
      return p;
    }
  }

  // 3. Try which command
  try {
    const found = execSync("which chromium || which chromium-browser || which google-chrome", 
      { encoding:"utf8" }).trim().split("\n")[0];
    if (found && fs.existsSync(found)) {
      console.log(`Chromium: which → ${found}`);
      return found;
    }
  } catch(e) {}

  // 4. Search nix store
  try {
    const nixSearch = execSync("find /nix -name 'chromium' -type f 2>/dev/null | head -1",
      { encoding:"utf8", timeout:5000 }).trim();
    if (nixSearch && fs.existsSync(nixSearch)) {
      console.log(`Chromium: nix store → ${nixSearch}`);
      return nixSearch;
    }
  } catch(e) {}

  // 5. Use puppeteer's bundled browser as last resort
  console.log("Chromium: using puppeteer bundled browser");
  return null;
}

// ── Browser singleton ─────────────────────────────────────────────────────
let browser = null;
async function getBrowser() {
  if (browser) {
    try {
      await browser.version(); // test if still alive
      return browser;
    } catch(e) {
      browser = null;
    }
  }

  const execPath = findChromium();
  const launchOpts = {
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-first-run",
      "--no-zygote",
      "--single-process",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-default-apps",
      "--disable-sync",
      "--metrics-recording-only",
      "--mute-audio",
      "--no-first-run",
      "--safebrowsing-disable-auto-update",
    ],
  };

  if (execPath) launchOpts.executablePath = execPath;

  console.log("Launching browser...");
  browser = await puppeteer.launch(launchOpts);
  console.log("Browser ready:", await browser.version());
  return browser;
}

// ── Login and extract roster text ─────────────────────────────────────────
async function getRenderedRoster(username, password) {
  const br   = await getBrowser();
  const page = await br.newPage();

  try {
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );

    // Block images/fonts to speed up
    await page.setRequestInterception(true);
    page.on("request", req => {
      if (["image","font","media"].includes(req.resourceType())) req.abort();
      else req.continue();
    });

    // ── Step 1: Login ──────────────────────────────────────────────────
    console.log("  → Navigating to login...");
    await page.goto(CWP_LOGIN, { waitUntil:"domcontentloaded", timeout:30000 });

    await page.waitForSelector("input[type=password]", { timeout:10000 });

    // Fill username
    const userSel = "input[type=text], input[type=email], input[name*='user' i], input[name*='User' i]";
    await page.type(userSel, username, { delay:30 });
    await page.type("input[type=password]", password, { delay:30 });

    console.log("  → Submitting...");
    await Promise.all([
      page.waitForNavigation({ waitUntil:"domcontentloaded", timeout:30000 }),
      page.keyboard.press("Enter"),
    ]);

    const url1 = page.url();
    console.log(`  → Post-login: ${url1}`);

    // Check login failure
    if (url1.includes("Login") || url1.includes("login")) {
      const bodyText = await page.evaluate(() => document.body.innerText.toLowerCase());
      if (bodyText.includes("invalid") || bodyText.includes("incorrect") || bodyText.includes("failed")) {
        throw new Error("LOGIN_FAILED");
      }
    }

    // ── Step 2: Dismiss any popup ─────────────────────────────────────
    await dismissPopup(page);

    // ── Step 3: Go to PDF roster page (most reliable) ─────────────────
    console.log("  → Fetching roster PDF page...");
    await page.goto(CWP_PDF, { waitUntil:"networkidle2", timeout:30000 });
    await dismissPopup(page);

    // Wait for roster content
    let rosterText = "";
    try {
      await page.waitForFunction(() => {
        const t = document.body ? document.body.innerText : "";
        return t.includes("RGD") || t.includes("JQ1") || t.includes("OFF") || t.includes("PHO");
      }, { timeout:15000 });
      rosterText = await page.evaluate(() => document.body.innerText);
      console.log(`  → PDF page text length: ${rosterText.length}`);
    } catch(e) {
      console.log("  → PDF page timeout, trying roster page...");
    }

    // Fallback: try main roster page
    if (!rosterText.includes("RGD") && !rosterText.includes("JQ")) {
      await page.goto(CWP_ROSTER, { waitUntil:"networkidle2", timeout:30000 });
      await dismissPopup(page);
      try {
        await page.waitForFunction(() => {
          const t = document.body ? document.body.innerText : "";
          return t.includes("RGD")||t.includes("JQ1")||t.includes("OFF");
        }, { timeout:15000 });
      } catch(e) {}
      rosterText = await page.evaluate(() => document.body.innerText);
      console.log(`  → Roster page text length: ${rosterText.length}`);
    }

    console.log(`  → Preview: ${rosterText.slice(0,200)}`);
    return rosterText;

  } finally {
    await page.close().catch(()=>{});
  }
}

async function dismissPopup(page) {
  try {
    const clicked = await page.evaluate(() => {
      const keywords = ["close","dismiss","skip","ok","no thanks","later","continue","cancel","not now"];
      const els = document.querySelectorAll("button,input[type=button],input[type=submit],a");
      for (const el of els) {
        const txt = (el.textContent||el.value||"").toLowerCase().trim();
        if (txt.length > 0 && txt.length < 25 && keywords.some(k=>txt.includes(k))) {
          el.click();
          return txt;
        }
      }
      return null;
    });
    if (clicked) {
      console.log(`  → Dismissed popup: "${clicked}"`);
      await new Promise(r=>setTimeout(r,800));
    }
  } catch(e) {}
}

// ── Parse roster from rendered text ──────────────────────────────────────
const MS  = ["","Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const DM  = {MON:"Mon",TUE:"Tue",WED:"Wed",THU:"Thu",FRI:"Fri",SAT:"Sat",SUN:"Sun"};
const MN  = {JAN:1,FEB:2,MAR:3,APR:4,MAY:5,JUN:6,JUL:7,AUG:8,SEP:9,OCT:10,NOV:11,DEC:12};
const DUTY_CODES = new Set(["OFF","RGD","PHO","STR","AVL","SBY","SIM","TRN","LVE","XAV",
  "UFD","ADM","WVL","AOF","FTG","DBF","ESB","RAS","WDO","STB","MAT","TVL","TCH","HTC","PAS","HLV"]);
const NOT_IATA = new Set(["JQ","NEO","BLH","RGD","PHO","OFF","STR","ATA","ATD","REQ","RQD",
  "PL","SBY","AVL","SIM","TRN","LVE","XAV","UFD","ADM","WVL","AOF","FTG","DBF","ESB","RAS",
  "WDO","STB","MAT","TVL","TCH","HTC","PAS","HLV","320","321","787","CM","DD","CI","CO","AC"]);

function getIatas(txt){const r=[];const re=/\b([A-Z]{3})\b/g;let m;while((m=re.exec(txt)))if(!NOT_IATA.has(m[1]))r.push(m[1]);return r;}
function getTimes(txt){const r=[];const re=/\b(\d{2}:\d{2})\b/g;let m;while((m=re.exec(txt)))if(m[1]!=="00:00"&&m[1]!=="24:00")r.push(m[1]);return r;}

function parseRosterText(text) {
  const DATE_RE = /\b(\d{2})(MON|TUE|WED|THU|FRI|SAT|SUN)\b/;
  const FLT_RE  = /\b(JQ\d{2,4})\b/;
  const nameM   = text.match(/([A-Z]{2,}\s+[A-Z]{2,})\s+(\d{5,7})/);
  const blhM    = text.match(/BLH[:\s]+(\d+):(\d+)/i);
  const perM    = text.match(/\d{2}([A-Z]{3})\d{2}\s*[-–]\s*\d{2}([A-Z]{3})(\d{2})/);
  const month   = perM?(MN[perM[2]]||4):4;
  const year    = perM?(2000+parseInt(perM[3])):2026;
  const duties  = [];
  let cur = null;

  for (const line of text.split(/[\n\r]+/).map(l=>l.trim()).filter(Boolean)) {
    if (line.includes("Crew Web Portal")||line.includes("Individual Roster")||
        line.includes("Date DD")||line.includes("E-CEA")) continue;
    if (line.startsWith("BLH:")||line.startsWith("CDUTY:")) continue;
    if (line.startsWith("Crew onboard")) break;

    const dm = DATE_RE.exec(line);
    if (dm) cur = `${DM[dm[2]]} ${parseInt(dm[1])} ${MS[month]}`;
    if (!cur) continue;

    FLT_RE.lastIndex=0;
    if (FLT_RE.test(line)) {
      FLT_RE.lastIndex=0;
      const fm=FLT_RE.exec(line);
      const rest=line.slice(fm.index+fm[0].length);
      const iatas=getIatas(rest); const times=getTimes(rest);
      if (!times.length||(!iatas.length&&times.length===1)) continue;
      duties.push({type:"flight",date:cur,flightNo:fm[1],
        from:iatas[0]||"AKL",to:iatas[1]||null,
        signOn:times[0]||null,ata:times[1]||null,
        signOff:times[times.length-1]||null});
    } else {
      for (const code of DUTY_CODES) {
        if (new RegExp(`\\b${code}\\b`).test(line)) {
          const times=getTimes(line);
          duties.push({type:"duty",date:cur,code,
            signOn:times[0]||null,
            signOff:times.length>1?times[times.length-1]:null});
          break;
        }
      }
    }
  }
  return { crewName:nameM?nameM[1]:"", empId:nameM?nameM[2]:"",
    blh:blhM?`${blhM[1]}:${blhM[2]}`:"0:00",
    month, year, duties, fetchedAt:new Date().toISOString() };
}

// ── ROUTES ─────────────────────────────────────────────────────────────────
app.post("/login", async (req,res) => {
  const {username,password}=req.body;
  if (!username||!password) return res.status(400).json({error:"Username and password required"});
  try {
    console.log(`\n=== Login: ${username} ===`);
    await getRenderedRoster(username, password); // validate credentials
    const token=crypto.randomBytes(32).toString("hex");
    // NOTE: we store credentials to re-login on each roster fetch
    // This is because Puppeteer sessions don't persist between requests
    sessions.set(token,{username,password,createdAt:Date.now()});
    return res.json({success:true,token,expiresInHours:4});
  } catch(e) {
    console.error("Login error:",e.message);
    if (e.message==="LOGIN_FAILED")
      return res.status(401).json({error:"Login failed — check your CWP username and password."});
    return res.status(500).json({error:"Could not reach CWP: "+e.message});
  }
});

app.get("/roster", async (req,res) => {
  const token=(req.headers.authorization||"").replace("Bearer ","").trim();
  if (!token||!sessions.has(token)) return res.status(401).json({error:"Invalid or expired session."});
  const session=sessions.get(token);
  if (Date.now()-session.createdAt>SESSION_TTL) {
    sessions.delete(token); return res.status(401).json({error:"Session expired."});
  }
  try {
    console.log(`\n=== Roster fetch: ${session.username} ===`);
    const text=await getRenderedRoster(session.username,session.password);
    const roster=parseRosterText(text);
    console.log(`Parsed: ${roster.duties.length} duties`);
    if (!roster.duties.length)
      return res.status(422).json({
        error:"Roster fetched but no duties found.",
        preview:text.slice(0,500)
      });
    return res.json({success:true,roster});
  } catch(e) {
    console.error("Roster error:",e.message);
    return res.status(500).json({error:"Could not fetch roster: "+e.message});
  }
});

app.get("/status",(_,res)=>res.json({
  status:"running",sessions:sessions.size,uptime:Math.round(process.uptime())+"s"
}));
app.post("/logout",(req,res)=>{
  sessions.delete((req.headers.authorization||"").replace("Bearer ","").trim());
  res.json({success:true});
});

// Pre-warm browser on startup
getBrowser().catch(e=>console.error("Browser pre-warm failed:",e.message));

app.listen(PORT,()=>console.log(`CrewMate server v6 (Puppeteer) on port ${PORT}`));
