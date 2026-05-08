import express      from "express";
import puppeteer    from "puppeteer";
import crypto       from "crypto";

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

const CWP_BASE  = "https://roc.jetstar.com/CWP_WA";
const CWP_LOGIN = `${CWP_BASE}/CWPLogin.aspx`;
const CWP_PDF   = `${CWP_BASE}/CWP_WindowRosterPDF.aspx`;
const CWP_MAIN  = `${CWP_BASE}/CWP_RosterTW.aspx`;

const sessions    = new Map();
const SESSION_TTL = 4 * 60 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [k,v] of sessions)
    if (now - v.createdAt > SESSION_TTL) sessions.delete(k);
}, 15 * 60 * 1000);

// ── Browser — use puppeteer's own bundled Chromium ────────────────────────
let browser = null;
async function getBrowser() {
  if (browser) {
    try { await browser.version(); return browser; } catch(e) { browser = null; }
  }
  console.log("Launching bundled Chromium...");
  browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--single-process",
      "--no-zygote",
    ],
  });
  console.log("Browser ready:", await browser.version());
  return browser;
}

// ── Login + fetch rendered roster text ───────────────────────────────────
async function getRenderedRoster(username, password) {
  const br   = await getBrowser();
  const page = await br.newPage();
  try {
    // Speed: block images, fonts, media
    await page.setRequestInterception(true);
    page.on("request", r => {
      if (["image","font","media","stylesheet"].includes(r.resourceType())) r.abort();
      else r.continue();
    });

    await page.setViewport({ width:1280, height:800 });
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");

    // ── Login ─────────────────────────────────────────────────────────
    console.log("  Navigating to login...");
    await page.goto(CWP_LOGIN, { waitUntil:"domcontentloaded", timeout:30000 });
    await page.waitForSelector("input[type=password]", { timeout:10000 });

    // Type credentials into the fields identified from logs
    await page.evaluate((u, p) => {
      const inputs = document.querySelectorAll("input");
      for (const el of inputs) {
        const n = (el.name||"").toLowerCase();
        if (el.type === "text" || el.type === "email" || n.includes("user")) {
          el.value = u; el.dispatchEvent(new Event("change",{bubbles:true}));
        }
        if (el.type === "password") {
          el.value = p; el.dispatchEvent(new Event("change",{bubbles:true}));
        }
      }
    }, username, password);

    console.log("  Submitting login...");
    await Promise.all([
      page.waitForNavigation({ waitUntil:"domcontentloaded", timeout:30000 }),
      page.evaluate(() => {
        const btn = document.querySelector("input[type=submit], button[type=submit]");
        if (btn) btn.click();
        else document.querySelector("form").submit();
      }),
    ]);

    const url1 = page.url();
    console.log(`  Post-login: ${url1}`);

    if (url1.toLowerCase().includes("login")) {
      const body = await page.evaluate(() => document.body.innerText.toLowerCase());
      if (body.includes("invalid")||body.includes("incorrect")||body.includes("failed"))
        throw new Error("LOGIN_FAILED");
    }

    // ── Dismiss popup if present ──────────────────────────────────────
    await dismissPopup(page);

    // ── Try PDF roster page first (most likely to have plain text) ────
    console.log("  Fetching PDF roster page...");
    await page.goto(CWP_PDF, { waitUntil:"networkidle2", timeout:30000 });
    await dismissPopup(page);

    // Wait for actual roster content
    const hasDuties = await page.waitForFunction(() => {
      const t = document.body.innerText;
      return t.includes("RGD")||t.includes("JQ1")||t.includes("PHO")||t.includes("01MON")||
             t.includes("01TUE")||t.includes("01WED")||t.includes("BLH");
    }, { timeout:15000 }).then(()=>true).catch(()=>false);

    let text = await page.evaluate(() => document.body.innerText);
    console.log(`  PDF page: ${text.length} chars, hasDuties=${hasDuties}`);
    console.log(`  Preview: ${text.slice(0,300)}`);

    // ── Fallback: main roster page ────────────────────────────────────
    if (!hasDuties || (!text.includes("RGD") && !text.includes("JQ"))) {
      console.log("  Trying main roster page...");
      await page.goto(CWP_MAIN, { waitUntil:"networkidle2", timeout:30000 });
      await dismissPopup(page);
      await page.waitForFunction(() => {
        const t = document.body.innerText;
        return t.includes("RGD")||t.includes("JQ1")||t.includes("BLH")||t.length>1000;
      }, { timeout:15000 }).catch(()=>{});
      text = await page.evaluate(() => document.body.innerText);
      console.log(`  Main roster: ${text.length} chars`);
      console.log(`  Preview: ${text.slice(0,300)}`);
    }

    return text;
  } finally {
    await page.close().catch(()=>{});
  }
}

async function dismissPopup(page) {
  try {
    const clicked = await page.evaluate(() => {
      const kw = ["close","dismiss","skip","ok","no thanks","later","continue","not now","x"];
      for (const el of document.querySelectorAll("button,input[type=button],input[type=submit],a")) {
        const txt = (el.textContent||el.value||"").toLowerCase().trim();
        if (txt && txt.length < 20 && kw.some(k=>txt===k||txt.includes(k))) {
          el.click(); return txt;
        }
      }
      return null;
    });
    if (clicked) {
      console.log(`  Dismissed: "${clicked}"`);
      await new Promise(r=>setTimeout(r,800));
    }
  } catch(e) {}
}

// ── Roster parser ────────────────────────────────────────────────────────
const MS  = ["","Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const DM  = {MON:"Mon",TUE:"Tue",WED:"Wed",THU:"Thu",FRI:"Fri",SAT:"Sat",SUN:"Sun"};
const MN  = {JAN:1,FEB:2,MAR:3,APR:4,MAY:5,JUN:6,JUL:7,AUG:8,SEP:9,OCT:10,NOV:11,DEC:12};
const DUTY_CODES = new Set(["OFF","RGD","PHO","STR","AVL","SBY","SIM","TRN","LVE","XAV",
  "UFD","ADM","WVL","AOF","FTG","DBF","ESB","RAS","WDO","STB","MAT","TVL","TCH","HTC","PAS","HLV"]);
const NOT_IATA = new Set(["JQ","NEO","BLH","RGD","PHO","OFF","STR","ATA","ATD","REQ","RQD",
  "PL","SBY","AVL","SIM","TRN","LVE","XAV","UFD","ADM","WVL","AOF","FTG","DBF","ESB","RAS",
  "WDO","STB","MAT","TVL","TCH","HTC","PAS","HLV","320","321","787","CM","DD","CI","CO","AC"]);

function getIatas(t){const r=[];const re=/\b([A-Z]{3})\b/g;let m;while((m=re.exec(t)))if(!NOT_IATA.has(m[1]))r.push(m[1]);return r;}
function getTimes(t){const r=[];const re=/\b(\d{2}:\d{2})\b/g;let m;while((m=re.exec(t)))if(m[1]!=="00:00"&&m[1]!=="24:00")r.push(m[1]);return r;}

function parseRoster(text) {
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
      const fm=FLT_RE.exec(line), rest=line.slice(fm.index+fm[0].length);
      const iatas=getIatas(rest), times=getTimes(rest);
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
  return {crewName:nameM?nameM[1]:"",empId:nameM?nameM[2]:"",
    blh:blhM?`${blhM[1]}:${blhM[2]}`:"0:00",
    month,year,duties,fetchedAt:new Date().toISOString()};
}

// ── Routes ───────────────────────────────────────────────────────────────
app.post("/login", async (req,res) => {
  const {username,password}=req.body;
  if (!username||!password) return res.status(400).json({error:"Username and password required"});
  try {
    console.log(`\n=== Login: ${username} ===`);
    await getRenderedRoster(username, password);
    const token=crypto.randomBytes(32).toString("hex");
    sessions.set(token,{username,password,createdAt:Date.now()});
    return res.json({success:true,token,expiresInHours:4});
  } catch(e) {
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
    const roster=parseRoster(text);
    console.log(`Parsed: ${roster.duties.length} duties`);
    if (!roster.duties.length)
      return res.status(422).json({error:"No duties found.",preview:text.slice(0,500)});
    return res.json({success:true,roster});
  } catch(e) {
    return res.status(500).json({error:"Could not fetch roster: "+e.message});
  }
});

app.get("/status",(_,res)=>res.json({status:"running",sessions:sessions.size,uptime:Math.round(process.uptime())+"s"}));
app.post("/logout",(req,res)=>{sessions.delete((req.headers.authorization||"").replace("Bearer ","").trim());res.json({success:true});});

getBrowser().catch(e=>console.error("Pre-warm failed:",e.message));
app.listen(PORT,()=>console.log(`CrewMate v6 on port ${PORT}`));
