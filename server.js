/**
 * CrewMate Backend Server
 * Handles CWP session management and roster fetching for Jetstar NZ crew
 * 
 * Stack: Node.js + Express + Axios + cheerio
 * Deploy: Railway.app (free tier)
 * 
 * SECURITY:
 * - Passwords are NEVER stored. Only session cookies are kept (in memory).
 * - Sessions expire when the server restarts or after 4 hours.
 * - All data is in-memory only. Nothing written to disk or database.
 * - HTTPS enforced by Railway automatically.
 */

import express     from "express";
import axios       from "axios";
import * as cheerio from "cheerio";
import tough       from "tough-cookie";
import { wrapper } from "axios-cookiejar-support";
import crypto      from "crypto";

const app  = express();
const PORT = process.env.PORT || 3000;

// ── CORS: only allow requests from your Vercel app ─────────────────────────
const ALLOWED_ORIGINS = [
  "https://crewmate-beta.vercel.app",
  "http://localhost:5173",  // local dev
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

// ── CWP URLs ────────────────────────────────────────────────────────────────
const CWP_BASE   = "https://roc.jetstar.com/CWP_WA";
const CWP_LOGIN  = `${CWP_BASE}/CWPLogin.aspx`;
const CWP_ROSTER = `${CWP_BASE}/CWP_RosterTW.aspx`;

// ── In-memory session store (token → cookie jar + metadata) ────────────────
// Sessions expire after 4 hours. Nothing is persisted to disk.
const sessions = new Map();
const SESSION_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

function cleanExpiredSessions() {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (now - session.createdAt > SESSION_TTL_MS) {
      sessions.delete(token);
    }
  }
}
setInterval(cleanExpiredSessions, 15 * 60 * 1000); // clean every 15 min

function makeClient(jar) {
  return wrapper(axios.create({
    jar,
    withCredentials: true,
    timeout: 15000,
    headers: {
      "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-NZ,en;q=0.9",
      "Accept-Encoding": "gzip, deflate, br",
    },
  }));
}

// ── STEP 1: GET login page → extract ASP.NET hidden fields ─────────────────
async function fetchLoginFields(client) {
  const res  = await client.get(CWP_LOGIN);
  const $    = cheerio.load(res.data);

  const viewstate        = $("#__VIEWSTATE").val()          || $("[name=__VIEWSTATE]").val()          || "";
  const viewstategen     = $("#__VIEWSTATEGENERATOR").val() || $("[name=__VIEWSTATEGENERATOR]").val() || "";
  const eventvalidation  = $("#__EVENTVALIDATION").val()    || $("[name=__EVENTVALIDATION]").val()    || "";

  // Find the actual input field names (they may vary by CWP version)
  let usernameField = "txtUsername";
  let passwordField = "txtPassword";
  let loginButton   = "btnLogin";

  $("input[type=text], input[type=email]").each((_, el) => {
    const name = $(el).attr("name") || "";
    if (name.toLowerCase().includes("user")) usernameField = name;
  });
  $("input[type=password]").each((_, el) => {
    const name = $(el).attr("name") || "";
    if (name) passwordField = name;
  });
  $("input[type=submit], input[type=button]").each((_, el) => {
    const name = $(el).attr("name") || "";
    if (name.toLowerCase().includes("log") || name.toLowerCase().includes("sign")) loginButton = name;
  });

  return { viewstate, viewstategen, eventvalidation, usernameField, passwordField, loginButton };
}

// ── STEP 2: POST credentials ────────────────────────────────────────────────
async function submitLogin(client, username, password, fields) {
  const params = new URLSearchParams({
    "__VIEWSTATE":          fields.viewstate,
    "__VIEWSTATEGENERATOR": fields.viewstategen,
    "__EVENTVALIDATION":    fields.eventvalidation,
    "__EVENTTARGET":        "",
    "__EVENTARGUMENT":      "",
    [fields.usernameField]: username,
    [fields.passwordField]: password,
    [fields.loginButton]:   "Login",
  });

  const res = await client.post(CWP_LOGIN, params.toString(), {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Referer": CWP_LOGIN,
    },
    maxRedirects: 5,
  });

  // Check if we landed on the roster page or are still on login
  const isLoggedIn = res.request?.res?.responseUrl?.includes("Roster") ||
                     res.config?.url?.includes("Roster") ||
                     !res.data?.includes("CWPLogin") ||
                     res.data?.includes("CWP_RosterTW");

  return { success: isLoggedIn, html: res.data, finalUrl: res.request?.res?.responseUrl || "" };
}

// ── STEP 3: Fetch roster page ───────────────────────────────────────────────
async function fetchRosterPage(client) {
  const res = await client.get(CWP_ROSTER, {
    headers: { "Referer": CWP_BASE },
  });
  return res.data;
}

// ── STEP 4: Parse roster HTML → structured data ─────────────────────────────
function parseRosterHTML(html) {
  const $ = cheerio.load(html);
  const duties = [];

  // CWP renders roster as a table — find duty rows
  // Row pattern: date | activity | C/I | Orig | ATD | Dest | ATA | C/O | AC | BLH
  $("tr").each((_, row) => {
    const cells = $(row).find("td").map((_, td) => $(td).text().trim()).get();
    if (cells.length < 3) return;

    // Date cell: "01WED", "13MON" etc.
    const dateMatch = cells[0]?.match(/^(\d{2})(MON|TUE|WED|THU|FRI|SAT|SUN)$/);
    if (!dateMatch) return;

    const dayNum  = dateMatch[1];
    const dayName = dateMatch[2];
    const activity = cells[1] || "";

    // Flight row: activity matches JQ###
    if (/^JQ\d{2,4}$/.test(activity)) {
      duties.push({
        type:       "flight",
        date:       `${dayNum}${dayName}`,
        flightNo:   activity,
        signOn:     cells[2] || null,  // C/I
        from:       cells[3] || null,  // Orig
        atd:        cells[4] || null,  // ATD
        to:         cells[5] || null,  // Dest
        ata:        cells[6] || null,  // ATA
        signOff:    cells[7] || null,  // C/O
        aircraft:   cells[8] || null,  // AC
        blh:        cells[9] || null,  // BLH
      });
    } else {
      // Duty row: RGD, OFF, PHO, AVL etc.
      duties.push({
        type:     "duty",
        date:     `${dayNum}${dayName}`,
        code:     activity,
        signOn:   cells[2] || null,
        signOff:  cells[7] || cells[6] || null,
      });
    }
  });

  // Extract crew name + employee ID from page
  const nameMatch = html.match(/([A-Z]{2,}\s+[A-Z]{2,})\s+(\d{5,7})/);
  const blhMatch  = html.match(/BLH[:\s]+(\d+):(\d+)/);

  return {
    crewName:   nameMatch ? nameMatch[1] : "",
    empId:      nameMatch ? nameMatch[2] : "",
    blh:        blhMatch  ? `${blhMatch[1]}:${blhMatch[2]}` : "0:00",
    duties,
    fetchedAt:  new Date().toISOString(),
    rawLength:  html.length,
  };
}

// ── ROUTE: POST /login ──────────────────────────────────────────────────────
// Body: { username, password }
// Returns: { token } — a session token the app stores locally
// The password is used ONCE here and then discarded. Never stored.
app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: "Username and password required" });
  }

  try {
    const jar    = new tough.CookieJar();
    const client = makeClient(jar);

    // 1. Get login page + extract hidden fields
    const fields = await fetchLoginFields(client);

    // 2. Submit credentials
    const loginResult = await submitLogin(client, username, password, fields);

    if (!loginResult.success) {
      return res.status(401).json({
        error: "Login failed. Check your CWP username and password.",
        hint:  "Make sure you're using your employee number as username.",
      });
    }

    // 3. Generate a secure session token — store jar, NOT the password
    const token = crypto.randomBytes(32).toString("hex");
    sessions.set(token, {
      jar,
      username,          // stored for re-login if session expires
      // password intentionally NOT stored
      createdAt: Date.now(),
    });

    console.log(`Login: ${username} — session created`);

    return res.json({
      success: true,
      token,
      expiresInHours: 4,
      message: "Logged in. Token expires in 4 hours.",
    });

  } catch (err) {
    console.error("Login error:", err.message);
    return res.status(500).json({ error: "Could not reach CWP. Try again.", detail: err.message });
  }
});

// ── ROUTE: GET /roster ──────────────────────────────────────────────────────
// Header: Authorization: Bearer <token>
// Returns: parsed roster data
app.get("/roster", async (req, res) => {
  const auth  = req.headers.authorization || "";
  const token = auth.replace("Bearer ", "").trim();

  if (!token || !sessions.has(token)) {
    return res.status(401).json({ error: "Invalid or expired session. Please log in again." });
  }

  const session = sessions.get(token);

  // Check if session is expired
  if (Date.now() - session.createdAt > SESSION_TTL_MS) {
    sessions.delete(token);
    return res.status(401).json({ error: "Session expired. Please log in again." });
  }

  try {
    const client = makeClient(session.jar);
    const html   = await fetchRosterPage(client);

    // If redirected back to login page, session has expired on CWP side
    if (html.includes("CWPLogin") && !html.includes("RosterTW")) {
      sessions.delete(token);
      return res.status(401).json({ error: "CWP session expired. Please log in again." });
    }

    const roster = parseRosterHTML(html);
    return res.json({ success: true, roster });

  } catch (err) {
    console.error("Roster fetch error:", err.message);
    return res.status(500).json({ error: "Could not fetch roster.", detail: err.message });
  }
});

// ── ROUTE: GET /status ──────────────────────────────────────────────────────
app.get("/status", (req, res) => {
  res.json({
    status:   "running",
    sessions: sessions.size,
    uptime:   Math.round(process.uptime()) + "s",
  });
});

// ── ROUTE: POST /logout ─────────────────────────────────────────────────────
app.post("/logout", (req, res) => {
  const auth  = req.headers.authorization || "";
  const token = auth.replace("Bearer ", "").trim();
  sessions.delete(token);
  res.json({ success: true });
});

app.listen(PORT, () => {
  console.log(`CrewMate server running on port ${PORT}`);
  console.log(`Sessions are in-memory only. Passwords are never stored.`);
});
