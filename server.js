/**
 * CrewMate Backend Server v2
 * Fixed roster HTML parser for Jetstar CWP actual structure
 */

import express     from "express";
import axios       from "axios";
import * as cheerio from "cheerio";
import tough       from "tough-cookie";
import { wrapper } from "axios-cookiejar-support";
import crypto      from "crypto";

const app  = express();
const PORT = process.env.PORT || 3000;

const ALLOWED_ORIGINS = [
  "https://crewmate-beta.vercel.app",
  "http://localhost:5173",
];

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
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

const sessions = new Map();
const SESSION_TTL_MS = 4 * 60 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [token, session] of sessions)
    if (now - session.createdAt > SESSION_TTL_MS) sessions.delete(token);
}, 15 * 60 * 1000);

function makeClient(jar) {
  return wrapper(axios.create({
    jar, withCredentials: true, timeout: 20000,
    headers: {
      "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-AU,en;q=0.9",
    },
  }));
}

async function fetchLoginFields(client) {
  const res = await client.get(CWP_LOGIN);
  const $   = cheerio.load(res.data);
  return {
    viewstate:       $("[name=__VIEWSTATE]").val()          || "",
    viewstategen:    $("[name=__VIEWSTATEGENERATOR]").val() || "",
    eventvalidation: $("[name=__EVENTVALIDATION]").val()    || "",
    // Discover actual field names from the form
    usernameField:   $("input[type=text]").first().attr("name") || "txtUsername",
    passwordField:   $("input[type=password]").first().attr("name") || "txtPassword",
    submitButton:    $("input[type=submit]").first().attr("name") || "btnLogin",
    html: res.data,
  };
}

async function submitLogin(client, username, password, fields) {
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
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Referer": CWP_LOGIN,
    },
    maxRedirects: 10,
  });
  const finalUrl = res.request?.res?.responseUrl || res.config?.url || "";
  const isLoggedIn = finalUrl.includes("Roster") ||
                     res.data?.includes("RosterTW") ||
                     !res.data?.includes("CWPLogin") ||
                     res.data?.includes("lblEmployeeName") ||
                     res.data?.includes("Sign Out") ||
                     res.data?.includes("Logout");
  return { success: isLoggedIn, html: res.data, finalUrl };
}

// ── Robust CWP roster parser ───────────────────────────────────────────────
// CWP renders roster as plain text rows, not a proper HTML table.
// Strategy: extract all text, then parse line by line (same as our PDF parser).
function parseRosterHTML(html) {
  const $ = cheerio.load(html);

  // Extract crew info
  const pageText = $.text();
  const nameM  = pageText.match(/([A-Z]{2,}\s+[A-Z]{2,})\s+(\d{5,7})/);
  const blhM   = pageText.match(/BLH[:\s]+(\d+):(\d+)/i);
  const perM   = pageText.match(/(\d{2})([A-Z]{3})(\d{2})\s*[-–]\s*(\d{2})([A-Z]{3})(\d{2})/);

  const MONTH_NUM = {JAN:1,FEB:2,MAR:3,APR:4,MAY:5,JUN:6,JUL:7,AUG:8,SEP:9,OCT:10,NOV:11,DEC:12};
  const month = perM ? (MONTH_NUM[perM[5]] || 4) : 4;
  const year  = perM ? (2000 + parseInt(perM[6])) : 2026;

  // Get all text from the roster content area
  // Try to find the main roster container first
  let rosterText = "";
  const containers = ["#pnlRoster","#rosterPanel",".rosterContent","#ContentPlaceHolder1","form"];
  for (const sel of containers) {
    const el = $(sel);
    if (el.length && el.text().includes("RGD") || el.text().includes("JQ")) {
      rosterText = el.text();
      break;
    }
  }
  if (!rosterText) rosterText = pageText;

  // Parse using the same logic as our PDF parser
  // Lines contain patterns like: "01WED RGD 10:00 AKL 10:00 AKL 17:05 17:05"
  //                         or:  "13MON JQ115 13:55 AKL 15:10 320"
  const DATE_RE = /\b(\d{2})(MON|TUE|WED|THU|FRI|SAT|SUN)\b/;
  const FLT_RE  = /\b(JQ\d{2,4})\b/;
  const TIME_RE = /\b(\d{2}:\d{2})\b/g;
  const DUTY_CODES = new Set(["OFF","RGD","PHO","STR","AVL","SBY","SIM","TRN","LVE","XAV",
    "UFD","ADM","WVL","AOF","FTG","DBF","ESB","RAS","WDO","STB","MAT","TVL","TCH","HTC","PAS","HLV"]);
  const NOT_IATA = new Set(["JQ","NEO","BLH","RGD","PHO","OFF","STR","ATA","ATD","REQ","RQD",
    "PL","SBY","AVL","SIM","TRN","LVE","XAV","UFD","ADM","WVL","AOF","FTG","DBF","ESB","RAS",
    "WDO","STB","MAT","TVL","TCH","HTC","PAS","HLV","320","321","787","CM","DD","CI","CO","AC"]);

  const MS = ["","Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const DM = {MON:"Mon",TUE:"Tue",WED:"Wed",THU:"Thu",FRI:"Fri",SAT:"Sat",SUN:"Sun"};

  const getTimes = (txt) => {
    const r=[]; let m; const re=/\b(\d{2}:\d{2})\b/g;
    while((m=re.exec(txt))) if(m[1]!=="00:00"&&m[1]!=="24:00") r.push(m[1]);
    return r;
  };
  const getIatas = (txt) => {
    const r=[]; const re=/\b([A-Z]{3})\b/g; let m;
    while((m=re.exec(txt))) if(!NOT_IATA.has(m[1])) r.push(m[1]);
    return r;
  };

  // Split into lines and group by date
  const rawLines = rosterText.split(/[\n\r]+/).map(l=>l.trim()).filter(Boolean);
  const duties = [];
  let curDate = null;
  let curDateStr = null;

  for (const line of rawLines) {
    const dm = DATE_RE.exec(line);
    if (dm) {
      curDate = { day: parseInt(dm[1]), dow: dm[2] };
      curDateStr = `${DM[dm[2]]} ${parseInt(dm[1])} ${MS[month]}`;
    }
    if (!curDate) continue;

    const hasFlight = FLT_RE.test(line);
    if (hasFlight) {
      FLT_RE.lastIndex = 0;
      const fm = FLT_RE.exec(line);
      const fno = fm[1];
      const rest = line.slice(fm.index + fm[0].length);
      const iatas = getIatas(rest);
      const times = getTimes(rest);
      if (times.length === 0 || (iatas.length === 0 && times.length === 1)) continue;
      const dep = times[0];
      const arr = times.length >= 2 ? times[1] : null;
      duties.push({
        type: "flight", date: curDateStr,
        flightNo: fno,
        from: iatas[0] || "AKL",
        to:   iatas[1] || null,
        signOn: dep, atd: times[1] || null,
        ata: arr, signOff: times[times.length-1] || null,
      });
    } else {
      // Check for duty code
      for (const code of DUTY_CODES) {
        if (new RegExp(`\\b${code}\\b`).test(line)) {
          const times = getTimes(line);
          duties.push({
            type: "duty", date: curDateStr, code,
            signOn:  times[0] || null,
            signOff: times.length > 1 ? times[times.length-1] : null,
          });
          break;
        }
      }
    }
  }

  // Also try table-based parsing as fallback
  if (duties.length === 0) {
    $("tr").each((_, row) => {
      const cells = $(row).find("td").map((_, td) => $(td).text().trim()).get();
      if (cells.length < 2) return;
      const dm2 = cells[0]?.match(/^(\d{2})(MON|TUE|WED|THU|FRI|SAT|SUN)$/);
      if (!dm2) return;
      const dateStr = `${DM[dm2[2]]} ${parseInt(dm2[1])} ${MS[month]}`;
      const activity = cells[1] || "";
      if (/^JQ\d{2,4}$/.test(activity)) {
        duties.push({
          type:"flight", date:dateStr, flightNo:activity,
          from:cells[3]||"AKL", to:cells[5]||null,
          signOn:cells[2]||null, atd:cells[4]||null,
          ata:cells[6]||null, signOff:cells[7]||null,
        });
      } else if (DUTY_CODES.has(activity)) {
        duties.push({ type:"duty", date:dateStr, code:activity,
          signOn:cells[2]||null, signOff:cells[7]||cells[6]||null });
      }
    });
  }

  console.log(`Parsed: ${duties.length} duties (${duties.filter(d=>d.type==="flight").length} flights, ${duties.filter(d=>d.type==="duty").length} ground duties)`);

  return {
    crewName: nameM ? nameM[1] : "",
    empId:    nameM ? nameM[2] : "",
    blh:      blhM  ? `${blhM[1]}:${blhM[2]}` : "0:00",
    month, year,
    duties,
    fetchedAt: new Date().toISOString(),
  };
}

// ── ROUTE: POST /login ──────────────────────────────────────────────────────
app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: "Username and password required" });

  try {
    const jar    = new tough.CookieJar();
    const client = makeClient(jar);
    const fields = await fetchLoginFields(client);

    console.log(`Login attempt: ${username}`);
    console.log(`Fields found: user=${fields.usernameField}, pass=${fields.passwordField}, btn=${fields.submitButton}`);

    const result = await submitLogin(client, username, password, fields);

    console.log(`Login result: success=${result.success}, url=${result.finalUrl}`);

    if (!result.success) {
      return res.status(401).json({
        error: "Login failed — check your CWP username and password.",
        finalUrl: result.finalUrl,
      });
    }

    const token = crypto.randomBytes(32).toString("hex");
    sessions.set(token, { jar, username, createdAt: Date.now() });

    return res.json({ success: true, token, expiresInHours: 4 });

  } catch (err) {
    console.error("Login error:", err.message);
    return res.status(500).json({ error: "Could not reach CWP: " + err.message });
  }
});

// ── ROUTE: GET /roster ──────────────────────────────────────────────────────
app.get("/roster", async (req, res) => {
  const token = (req.headers.authorization || "").replace("Bearer ", "").trim();
  if (!token || !sessions.has(token))
    return res.status(401).json({ error: "Invalid or expired session. Please log in again." });

  const session = sessions.get(token);
  if (Date.now() - session.createdAt > SESSION_TTL_MS) {
    sessions.delete(token);
    return res.status(401).json({ error: "Session expired. Please log in again." });
  }

  try {
    const client = makeClient(session.jar);
    const html   = await client.get(CWP_ROSTER, { headers: { Referer: CWP_BASE } });
    const data   = html.data;

    if (data.includes("CWPLogin") && !data.includes("Roster")) {
      sessions.delete(token);
      return res.status(401).json({ error: "CWP session expired. Please log in again." });
    }

    // Save raw HTML for debugging (first 2000 chars)
    console.log("Roster HTML preview:", data.slice(0, 2000));

    const roster = parseRosterHTML(data);
    return res.json({ success: true, roster });

  } catch (err) {
    console.error("Roster error:", err.message);
    return res.status(500).json({ error: "Could not fetch roster: " + err.message });
  }
});

// ── ROUTE: GET /debug-roster (returns raw HTML for inspection) ─────────────
app.get("/debug-roster", async (req, res) => {
  const token = (req.headers.authorization || "").replace("Bearer ", "").trim();
  if (!token || !sessions.has(token))
    return res.status(401).json({ error: "Not logged in" });

  try {
    const client = makeClient(sessions.get(token).jar);
    const html   = await client.get(CWP_ROSTER);
    // Return first 5000 chars of HTML for inspection
    res.json({ html: html.data.slice(0, 5000) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/status", (_, res) => res.json({
  status:"running", sessions:sessions.size, uptime:Math.round(process.uptime())+"s"
}));

app.post("/logout", (req, res) => {
  const token = (req.headers.authorization||"").replace("Bearer ","").trim();
  sessions.delete(token);
  res.json({ success: true });
});

app.listen(PORT, () => console.log(`CrewMate server v2 on port ${PORT}`));
