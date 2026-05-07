/**
 * CrewMate Backend Server v5
 * Uses Puppeteer (headless Chromium) to run CWP JavaScript
 * and extract roster after dynamic rendering completes.
 */

import express     from "express";
import puppeteer   from "puppeteer";
import * as cheerio from "cheerio";
import crypto      from "crypto";

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

// Sessions store cookies (not passwords)
const sessions    = new Map();
const SESSION_TTL = 4 * 60 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [k,v] of sessions)
    if (now - v.createdAt > SESSION_TTL) sessions.delete(k);
}, 15 * 60 * 1000);

// ── Launch Puppeteer browser (shared instance) ────────────────────────────
let browser = null;
async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  console.log("Launching Chromium...");
  browser = await puppeteer.launch({
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || "/run/current-system/sw/bin/chromium",
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
    ],
  });
  console.log("Chromium ready");
  return browser;
}

// ── Login + fetch roster via Puppeteer ────────────────────────────────────
async function loginAndFetchRoster(username, password) {
  const br   = await getBrowser();
  const page = await br.newPage();

  try {
    // Mobile viewport — lighter page weight
    await page.setViewport({ width: 390, height: 844 });
    await page.setUserAgent(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
    );

    console.log("Navigating to login page...");
    await page.goto(CWP_LOGIN, { waitUntil: "networkidle2", timeout: 30000 });

    // Fill login form
    console.log("Filling credentials...");
    await page.waitForSelector("input[type=text], input[type=email]", { timeout: 10000 });

    const userField = await page.$("input[type=text], input[type=email]");
    const passField = await page.$("input[type=password]");
    const submitBtn = await page.$("input[type=submit], button[type=submit]");

    if (!userField || !passField) throw new Error("Login form fields not found");

    await userField.click({ clickCount: 3 });
    await userField.type(username, { delay: 50 });
    await passField.click({ clickCount: 3 });
    await passField.type(password, { delay: 50 });

    console.log("Submitting login...");
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }),
      submitBtn ? submitBtn.click() : page.keyboard.press("Enter"),
    ]);

    const postLoginUrl = page.url();
    console.log(`Post-login URL: ${postLoginUrl}`);

    // Check for failed login
    if (postLoginUrl.includes("Login") || postLoginUrl.includes("login")) {
      const pageText = await page.evaluate(() => document.body.innerText);
      if (pageText.toLowerCase().includes("invalid") ||
          pageText.toLowerCase().includes("incorrect") ||
          pageText.toLowerCase().includes("failed")) {
        throw new Error("LOGIN_FAILED");
      }
    }

    // Dismiss any popup/survey/notification that appears
    await dismissAnyPopup(page);

    // Navigate to roster page
    console.log("Navigating to roster...");
    await page.goto(CWP_ROSTER, { waitUntil: "networkidle2", timeout: 30000 });
    await dismissAnyPopup(page);

    // Wait for roster content to render
    console.log("Waiting for roster to render...");
    await page.waitForFunction(() => {
      const text = document.body.innerText;
      return text.includes("RGD") || text.includes("JQ") || text.includes("OFF") ||
             text.includes("BLH") || text.includes("PHO");
    }, { timeout: 20000 }).catch(() => console.log("Roster wait timed out — proceeding anyway"));

    // Also try the PDF source page which may be more reliable
    let rosterHtml = await page.content();
    let rosterText = await page.evaluate(() => document.body.innerText);

    // If no duties visible, try the PDF page
    if (!rosterText.includes("RGD") && !rosterText.includes("JQ")) {
      console.log("Trying PDF source page...");
      await page.goto(`${CWP_BASE}/CWP_WindowRosterPDF.aspx`,
        { waitUntil: "networkidle2", timeout: 20000 });
      await page.waitForFunction(() => {
        const t = document.body.innerText;
        return t.includes("RGD")||t.includes("JQ")||t.includes("OFF")||t.length > 500;
      }, { timeout: 15000 }).catch(()=>{});
      rosterHtml = await page.content();
      rosterText = await page.evaluate(() => document.body.innerText);
    }

    console.log(`Roster text length: ${rosterText.length}`);
    console.log(`Preview: ${rosterText.slice(0,300)}`);

    // Extract cookies for session storage
    const cookies = await page.cookies();

    return { rosterHtml, rosterText, cookies };

  } finally {
    await page.close();
  }
}

async function dismissAnyPopup(page) {
  try {
    // Look for close/dismiss/skip buttons
    const dismissed = await page.evaluate(() => {
      const keywords = ["close","dismiss","skip","ok","continue","no thanks","later","cancel"];
      const elements = document.querySelectorAll(
        "button, input[type=button], input[type=submit], a[href*=javascript]"
      );
      for (const el of elements) {
        const txt = (el.textContent || el.value || "").toLowerCase().trim();
        if (keywords.some(k => txt.includes(k)) && txt.length < 20) {
          el.click();
          return true;
        }
      }
      return false;
    });
    if (dismissed) {
      console.log("  Popup dismissed");
      await new Promise(r => setTimeout(r, 1000));
    }
  } catch(e) {}
}

// ── Roster parser ─────────────────────────────────────────────────────────
const MS  = ["","Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const DM  = {MON:"Mon",TUE:"Tue",WED:"Wed",THU:"Thu",FRI:"Fri",SAT:"Sat",SUN:"Sun"};
const MN  = {JAN:1,FEB:2,MAR:3,APR:4,MAY:5,JUN:6,JUL:7,AUG:8,SEP:9,OCT:10,NOV:11,DEC:12};
const DUTY_CODES = new Set(["OFF","RGD","PHO","STR","AVL","SBY","SIM","TRN","LVE","XAV",
  "UFD","ADM","WVL","AOF","FTG","DBF","ESB","RAS","WDO","STB","MAT","TVL","TCH","HTC","PAS","HLV"]);
const NOT_IATA = new Set(["JQ","NEO","BLH","RGD","PHO","OFF","STR","ATA","ATD","REQ","RQD",
  "PL","SBY","AVL","SIM","TRN","LVE","XAV","UFD","ADM","WVL","AOF","FTG","DBF","ESB","RAS",
  "WDO","STB","MAT","TVL","TCH","HTC","PAS","HLV","320","321","787","CM","DD","CI","CO","AC"]);

function getIatas(txt) {
  const r=[]; const re=/\b([A-Z]{3})\b/g; let m;
  while((m=re.exec(txt))) if(!NOT_IATA.has(m[1])) r.push(m[1]);
  return r;
}
function getTimes(txt) {
  const r=[]; const re=/\b(\d{2}:\d{2})\b/g; let m;
  while((m=re.exec(txt))) if(m[1]!=="00:00"&&m[1]!=="24:00") r.push(m[1]);
  return r;
}

function parseRosterText(text) {
  const DATE_RE = /\b(\d{2})(MON|TUE|WED|THU|FRI|SAT|SUN)\b/;
  const FLT_RE  = /\b(JQ\d{2,4})\b/;
  const nameM   = text.match(/([A-Z]{2,}\s+[A-Z]{2,})\s+(\d{5,7})/);
  const blhM    = text.match(/BLH[:\s]+(\d+):(\d+)/i);
  const perM    = text.match(/\d{2}([A-Z]{3})\d{2}\s*[-–]\s*\d{2}([A-Z]{3})(\d{2})/);
  const month   = perM?(MN[perM[2]]||4):4;
  const year    = perM?(2000+parseInt(perM[3])):2026;
  const duties  = [];
  let curDateStr = null;

  for (const line of text.split(/[\n\r]+/).map(l=>l.trim()).filter(Boolean)) {
    if (line.includes("Crew Web Portal")||line.includes("Individual Roster")||
        line.includes("Page ")||line.includes("Date DD")||line.includes("E-CEA")) continue;
    if (line.startsWith("BLH:")||line.startsWith("CDUTY:")) continue;
    if (line.startsWith("Crew onboard")||line.startsWith("Hotels")) break;

    const dm = DATE_RE.exec(line);
    if (dm) curDateStr = `${DM[dm[2]]} ${parseInt(dm[1])} ${MS[month]}`;
    if (!curDateStr) continue;

    FLT_RE.lastIndex = 0;
    if (FLT_RE.test(line)) {
      FLT_RE.lastIndex = 0;
      const fm  = FLT_RE.exec(line);
      const rest = line.slice(fm.index+fm[0].length);
      const iatas = getIatas(rest);
      const times = getTimes(rest);
      if (!times.length||(!iatas.length&&times.length===1)) continue;
      duties.push({type:"flight", date:curDateStr, flightNo:fm[1],
        from:iatas[0]||"AKL", to:iatas[1]||null,
        signOn:times[0]||null, ata:times[1]||null,
        signOff:times[times.length-1]||null});
    } else {
      for (const code of DUTY_CODES) {
        if (new RegExp(`\\b${code}\\b`).test(line)) {
          const times = getTimes(line);
          duties.push({type:"duty", date:curDateStr, code,
            signOn:times[0]||null,
            signOff:times.length>1?times[times.length-1]:null});
          break;
        }
      }
    }
  }

  return {
    crewName: nameM?nameM[1]:"", empId: nameM?nameM[2]:"",
    blh: blhM?`${blhM[1]}:${blhM[2]}`:"0:00",
    month, year, duties, fetchedAt: new Date().toISOString(),
  };
}

// ── ROUTES ─────────────────────────────────────────────────────────────────
app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username||!password)
    return res.status(400).json({error:"Username and password required"});
  try {
    console.log(`\n=== Login: ${username} ===`);
    const { cookies } = await loginAndFetchRoster(username, password);
    const token = crypto.randomBytes(32).toString("hex");
    sessions.set(token, { username, password, cookies, createdAt:Date.now() });
    return res.json({success:true, token, expiresInHours:4});
  } catch(e) {
    console.error("Login error:", e.message);
    if (e.message === "LOGIN_FAILED")
      return res.status(401).json({error:"Login failed — check your CWP username and password."});
    return res.status(500).json({error:"Could not reach CWP: "+e.message});
  }
});

app.get("/roster", async (req, res) => {
  const token = (req.headers.authorization||"").replace("Bearer ","").trim();
  if (!token||!sessions.has(token))
    return res.status(401).json({error:"Invalid or expired session."});
  const session = sessions.get(token);
  if (Date.now()-session.createdAt>SESSION_TTL) {
    sessions.delete(token);
    return res.status(401).json({error:"Session expired. Please log in again."});
  }
  try {
    console.log(`\n=== Roster fetch: ${session.username} ===`);
    const { rosterText } = await loginAndFetchRoster(session.username, session.password);
    const roster = parseRosterText(rosterText);
    console.log(`Parsed: ${roster.duties.length} duties`);
    if (!roster.duties.length)
      return res.status(422).json({
        error:"Roster fetched but no duties found.",
        preview: rosterText.slice(0,500),
      });
    return res.json({success:true, roster});
  } catch(e) {
    console.error("Roster error:", e.message);
    return res.status(500).json({error:"Could not fetch roster: "+e.message});
  }
});

app.get("/status", (_,res) => res.json({
  status:"running", sessions:sessions.size, uptime:Math.round(process.uptime())+"s"
}));
app.post("/logout",(req,res)=>{
  sessions.delete((req.headers.authorization||"").replace("Bearer ","").trim());
  res.json({success:true});
});

// Pre-launch browser on startup
getBrowser().catch(e => console.error("Browser launch failed:", e.message));

app.listen(PORT, () => console.log(`CrewMate server v5 (Puppeteer) on port ${PORT}`));
