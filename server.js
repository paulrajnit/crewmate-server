/**
 * CrewMate Backend Server v4
 * Handles post-login popups/surveys that block roster access
 */

import express      from "express";
import axios        from "axios";
import * as cheerio from "cheerio";
import tough        from "tough-cookie";
import { wrapper }  from "axios-cookiejar-support";
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

const CWP_BASE   = "https://roc.jetstar.com/CWP_WA";
const CWP_LOGIN  = `${CWP_BASE}/CWPLogin.aspx`;
const CWP_ROSTER = `${CWP_BASE}/CWP_RosterTW.aspx`;

// All pages that might contain roster data
const ROSTER_FRAMES = [
  `${CWP_BASE}/CWP_WindowRosterPDF.aspx`,  // PDF source — plain HTML table, best bet
  `${CWP_BASE}/CWP_RosterTW.aspx`,
  `${CWP_BASE}/CWP_RosterDetail.aspx`,
  `${CWP_BASE}/CWP_Roster.aspx`,
];

// Pages that are known popup/survey intermediaries to auto-dismiss
const POPUP_INDICATORS = [
  "feedback", "survey", "notification", "announcement",
  "btnClose", "btnOK", "btnContinue", "btnSkip", "btnNoThanks",
  "lnkClose", "lnkSkip", "lnkContinue",
];

const sessions    = new Map();
const SESSION_TTL = 4 * 60 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [k,v] of sessions) if (now - v.createdAt > SESSION_TTL) sessions.delete(k);
}, 15 * 60 * 1000);

function makeClient(jar) {
  return wrapper(axios.create({
    jar, withCredentials: true, timeout: 20000,
    headers: {
      "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-AU,en;q=0.9",
    },
  }));
}

// ── Auto-dismiss any popup/survey page ────────────────────────────────────
async function dismissPopup(client, html, currentUrl) {
  const $ = cheerio.load(html);
  const pageText = html.toLowerCase();

  // Check if this looks like a popup/intermediate page
  const isPopup = POPUP_INDICATORS.some(ind => pageText.includes(ind.toLowerCase())) &&
                  !html.includes("CWP_RosterTW") &&
                  !html.includes("RGD") && !html.includes("JQ");

  if (!isPopup) return false;

  console.log(`  Popup detected at ${currentUrl} — attempting auto-dismiss`);

  // Strategy 1: Find and click any dismiss/skip/close button via POST
  const dismissButtons = [
    "btnClose","btnOK","btnContinue","btnSkip","btnNoThanks",
    "lnkClose","lnkSkip","lnkContinue","btnLater","btnDismiss",
    "_btnClose","_btnOK","_btnSkip","_btnContinue",
  ];

  const viewstate   = $("[name=__VIEWSTATE]").val() || "";
  const viewstategen = $("[name=__VIEWSTATEGENERATOR]").val() || "";
  const eventval    = $("[name=__EVENTVALIDATION]").val() || "";

  for (const btnName of dismissButtons) {
    const btn = $(`[name="${btnName}"], [id$="${btnName}"]`).first();
    if (btn.length) {
      const actualName = btn.attr("name") || btnName;
      console.log(`  Found dismiss button: ${actualName}`);
      try {
        const params = new URLSearchParams({
          "__VIEWSTATE":          viewstate,
          "__VIEWSTATEGENERATOR": viewstategen,
          "__EVENTVALIDATION":    eventval,
          "__EVENTTARGET":        "",
          "__EVENTARGUMENT":      "",
          [actualName]:           btn.attr("value") || "OK",
        });
        await client.post(currentUrl, params.toString(), {
          headers: { "Content-Type":"application/x-www-form-urlencoded", "Referer":currentUrl },
          maxRedirects: 5,
        });
        console.log(`  Popup dismissed via ${actualName}`);
        return true;
      } catch(e) { console.log(`  Dismiss failed: ${e.message}`); }
    }
  }

  // Strategy 2: LinkButton click via __EVENTTARGET
  const linkBtns = [];
  $("a[href*='javascript'], input[type=button], input[type=submit]").each((_,el) => {
    const txt = ($(el).text() + " " + ($(el).attr("value")||"")).toLowerCase();
    if (txt.includes("close") || txt.includes("skip") || txt.includes("ok") ||
        txt.includes("continue") || txt.includes("no thanks") || txt.includes("later")) {
      linkBtns.push($(el).attr("name") || $(el).attr("id") || "");
    }
  });

  for (const target of linkBtns.filter(Boolean)) {
    try {
      const params = new URLSearchParams({
        "__VIEWSTATE":          viewstate,
        "__VIEWSTATEGENERATOR": viewstategen,
        "__EVENTVALIDATION":    eventval,
        "__EVENTTARGET":        target,
        "__EVENTARGUMENT":      "",
      });
      await client.post(currentUrl, params.toString(), {
        headers: { "Content-Type":"application/x-www-form-urlencoded", "Referer":currentUrl },
        maxRedirects: 5,
      });
      console.log(`  Popup dismissed via EventTarget ${target}`);
      return true;
    } catch(e) {}
  }

  // Strategy 3: Just navigate directly to roster — many popups don't actually block navigation
  console.log("  Could not find dismiss button — navigating directly to roster");
  return false;
}

async function fetchLoginFields(client) {
  const res = await client.get(CWP_LOGIN);
  const $   = cheerio.load(res.data);
  return {
    viewstate:       $("[name=__VIEWSTATE]").val()          || "",
    viewstategen:    $("[name=__VIEWSTATEGENERATOR]").val() || "",
    eventvalidation: $("[name=__EVENTVALIDATION]").val()    || "",
    usernameField:   $("input[type=text]").first().attr("name")     || "txtUsername",
    passwordField:   $("input[type=password]").first().attr("name") || "txtPassword",
    submitButton:    $("input[type=submit]").first().attr("name")   || "btnLogin",
  };
}

async function doLogin(client, username, password) {
  const fields = await fetchLoginFields(client);
  console.log(`Fields: ${fields.usernameField}/${fields.passwordField}/${fields.submitButton}`);

  const params = new URLSearchParams({
    "__VIEWSTATE":          fields.viewstate,
    "__VIEWSTATEGENERATOR": fields.viewstategen,
    "__EVENTVALIDATION":    fields.eventvalidation,
    "__EVENTTARGET":        "",
    "__EVENTARGUMENT":      "",
    [fields.usernameField]: username,
    [fields.passwordField]: password,
    [fields.submitButton]:  "Login",
  });

  const res = await client.post(CWP_LOGIN, params.toString(), {
    headers: { "Content-Type":"application/x-www-form-urlencoded", "Referer":CWP_LOGIN },
    maxRedirects: 10,
  });

  const finalUrl = res.request?.res?.responseUrl || res.config?.url || "";
  console.log(`Post-login URL: ${finalUrl}`);

  // Check for popup on landing page
  if (!finalUrl.includes("Roster") && !res.data.includes("CWPLogin")) {
    await dismissPopup(client, res.data, finalUrl);
  }

  // Also try to navigate directly to roster regardless
  // This bypasses popups that don't actually enforce a gate
  const rosterCheck = await client.get(CWP_ROSTER, { 
    headers: { Referer: finalUrl },
    maxRedirects: 5,
    validateStatus: () => true,
  });

  const isLoggedIn = !rosterCheck.data?.includes("CWPLogin") ||
                     rosterCheck.data?.includes("lblEmployeeName") ||
                     rosterCheck.data?.includes("Sign Out");

  return { success: isLoggedIn, finalUrl };
}

// ── Roster text parser ────────────────────────────────────────────────────
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

function parseRosterText(text, month, year) {
  const DATE_RE = /\b(\d{2})(MON|TUE|WED|THU|FRI|SAT|SUN)\b/;
  const FLT_RE  = /\b(JQ\d{2,4})\b/;
  const duties  = [];
  let curDateStr = null;

  for (const line of text.split(/[\n\r\t]+/).map(l=>l.trim()).filter(Boolean)) {
    if (line.includes("Crew Web Portal")||line.includes("Individual Roster")||
        line.includes("Page ")||line.includes("Date DD")||
        line.includes("E-CEA")) continue;
    if (line.startsWith("BLH:")||line.startsWith("CDUTY:")) continue;
    if (line.startsWith("Crew onboard")||line.startsWith("Hotels")) break;

    const dm = DATE_RE.exec(line);
    if (dm) curDateStr = `${DM[dm[2]]} ${parseInt(dm[1])} ${MS[month]}`;
    if (!curDateStr) continue;

    FLT_RE.lastIndex = 0;
    if (FLT_RE.test(line)) {
      FLT_RE.lastIndex = 0;
      const fm   = FLT_RE.exec(line);
      const rest = line.slice(fm.index + fm[0].length);
      const iatas = getIatas(rest);
      const times = getTimes(rest);
      if (!times.length || (!iatas.length && times.length===1)) continue;
      duties.push({ type:"flight", date:curDateStr, flightNo:fm[1],
        from:iatas[0]||"AKL", to:iatas[1]||null,
        signOn:times[0]||null, ata:times[1]||null,
        signOff:times[times.length-1]||null });
    } else {
      for (const code of DUTY_CODES) {
        if (new RegExp(`\\b${code}\\b`).test(line)) {
          const times = getTimes(line);
          duties.push({ type:"duty", date:curDateStr, code,
            signOn:times[0]||null,
            signOff:times.length>1?times[times.length-1]:null });
          break;
        }
      }
    }
  }
  return duties;
}

function parseRosterHTML(html) {
  const $     = cheerio.load(html);
  const text  = $.text();
  const nameM = text.match(/([A-Z]{2,}\s+[A-Z]{2,})\s+(\d{5,7})/);
  const blhM  = text.match(/BLH[:\s]+(\d+):(\d+)/i);
  const perM  = text.match(/\d{2}([A-Z]{3})\d{2}\s*[-–]\s*\d{2}([A-Z]{3})(\d{2})/);
  const month = perM?(MN[perM[2]]||4):4;
  const year  = perM?(2000+parseInt(perM[3])):2026;
  return {
    crewName:nameM?nameM[1]:"", empId:nameM?nameM[2]:"",
    blh:blhM?`${blhM[1]}:${blhM[2]}`:"0:00",
    month, year,
    duties: parseRosterText(text, month, year),
    fetchedAt: new Date().toISOString(),
  };
}

async function fetchRosterFromAllSources(client) {
  for (const url of ROSTER_FRAMES) {
    try {
      console.log(`Trying: ${url}`);
      const res    = await client.get(url, { headers:{Referer:CWP_ROSTER}, validateStatus:()=>true });
      
      // Check for popup on this page too
      if (res.data && !res.data.includes("RGD") && !res.data.includes("JQ1")) {
        await dismissPopup(client, res.data, url);
        // Retry after dismissal
        const retry = await client.get(url, { headers:{Referer:CWP_ROSTER}, validateStatus:()=>true });
        if (retry.data) {
          const parsed = parseRosterHTML(retry.data);
          console.log(`  After dismiss → ${parsed.duties.length} duties`);
          if (parsed.duties.length > 0) return {...parsed, sourceUrl:url};
        }
      }

      const parsed = parseRosterHTML(res.data);
      console.log(`  → ${parsed.duties.length} duties`);
      if (parsed.duties.length > 0) return {...parsed, sourceUrl:url};

      // Crawl iframes
      const $ = cheerio.load(res.data);
      const frameUrls = [];
      $("iframe,frame").each((_,el) => {
        let src = $(el).attr("src")||"";
        if (!src) return;
        if (!src.startsWith("http")) src = `${CWP_BASE}/${src.replace(/^\//,"")}`;
        frameUrls.push(src);
      });

      for (const fUrl of frameUrls) {
        try {
          console.log(`  Frame: ${fUrl}`);
          const fr = await client.get(fUrl, { headers:{Referer:url}, validateStatus:()=>true });
          const fp = parseRosterHTML(fr.data);
          console.log(`    → ${fp.duties.length} duties`);
          if (fp.duties.length > 0) return {...fp, sourceUrl:fUrl};
        } catch(e) { console.log(`    Error: ${e.message}`); }
      }
    } catch(e) { console.log(`Error at ${url}: ${e.message}`); }
  }
  return null;
}

// ── ROUTES ─────────────────────────────────────────────────────────────────
app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username||!password)
    return res.status(400).json({error:"Username and password required"});
  try {
    const jar    = new tough.CookieJar();
    const client = makeClient(jar);
    console.log(`\n=== Login: ${username} ===`);
    const result = await doLogin(client, username, password);
    console.log(`Login success: ${result.success}`);
    if (!result.success)
      return res.status(401).json({error:"Login failed — check your CWP credentials."});
    const token = crypto.randomBytes(32).toString("hex");
    sessions.set(token, {jar, username, createdAt:Date.now()});
    return res.json({success:true, token, expiresInHours:4});
  } catch(e) {
    console.error("Login error:", e.message);
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
    return res.status(401).json({error:"Session expired."});
  }
  try {
    console.log(`\n=== Roster fetch: ${session.username} ===`);
    const client = makeClient(session.jar);
    const roster = await fetchRosterFromAllSources(client);
    if (!roster||roster.duties.length===0)
      return res.status(422).json({
        error:"Roster fetched but no duties found.",
        hint:"Try again — a popup may have intercepted the request.",
      });
    console.log(`Success: ${roster.duties.length} duties from ${roster.sourceUrl}`);
    return res.json({success:true, roster});
  } catch(e) {
    console.error("Roster error:", e.message);
    return res.status(500).json({error:"Could not fetch roster: "+e.message});
  }
});

app.get("/debug-roster", async (req, res) => {
  const token = (req.headers.authorization||"").replace("Bearer ","").trim();
  if (!token||!sessions.has(token))
    return res.status(401).json({error:"Not logged in"});
  try {
    const client  = makeClient(sessions.get(token).jar);
    const results = {};
    for (const url of ROSTER_FRAMES) {
      try {
        const r  = await client.get(url, {validateStatus:()=>true});
        const $  = cheerio.load(r.data);
        const iframes = [];
        $("iframe,frame").each((_,el)=>iframes.push($(el).attr("src")));
        results[url] = {
          status:   r.status,
          length:   r.data.length,
          hasRGD:   r.data.includes("RGD"),
          hasJQ:    r.data.includes("JQ1"),
          iframes,
          preview:  $.text().slice(0,800),
        };
      } catch(e) { results[url]={error:e.message}; }
    }
    res.json(results);
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.get("/status", (_,res) => res.json({
  status:"running", sessions:sessions.size, uptime:Math.round(process.uptime())+"s"
}));
app.post("/logout", (req,res) => {
  sessions.delete((req.headers.authorization||"").replace("Bearer ","").trim());
  res.json({success:true});
});

app.listen(PORT, () => console.log(`CrewMate server v4 on port ${PORT}`));
