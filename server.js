require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");
const Database = require("better-sqlite3");
const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { computeCheck } = require("telegram/Password");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const HOST = "0.0.0.0";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
const SESSION_FILE = path.join(DATA_DIR, "telegram-session.enc");
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
const API_ID = Number(process.env.API_ID || 0);
const API_HASH = process.env.API_HASH || "";
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || "";
const db = new Database(path.join(DATA_DIR, "data.sqlite"));
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  title TEXT,
  added_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL,
  text TEXT DEFAULT '',
  media_path TEXT,
  schedule_at TEXT,
  interval_minutes INTEGER DEFAULT 0,
  next_run_at TEXT,
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(group_id) REFERENCES groups(id)
);
CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER,
  group_name TEXT,
  result TEXT NOT NULL,
  detail TEXT,
  posted_at TEXT DEFAULT CURRENT_TIMESTAMP
);
`);

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(UPLOADS_DIR));
app.get("/health", (_req, res) => res.status(200).send("ok"));

const upload = multer({
  dest: UPLOADS_DIR,
  limits: { fileSize: 10 * 1024 * 1024 }
});

let client = null;
let pendingLogin = null;
let isConnected = false;
let loginBusy = false;
let clientConnecting = false;
let automationPaused = false;

function requireDashboard(req, res, next) {
  if (!DASHBOARD_PASSWORD) return res.status(503).json({ error: "Set DASHBOARD_PASSWORD in .env before using the dashboard." });
  const supplied = req.headers["x-dashboard-password"];
  if (supplied !== DASHBOARD_PASSWORD) return res.status(401).json({ error: "Dashboard password required." });
  next();
}
app.use("/api", requireDashboard);

function ensureConfig() {
  if (!API_ID || !API_HASH) throw new Error("Add API_ID and API_HASH to your .env file. Get them from my.telegram.org.");
}
function createClient(session = "") {
  ensureConfig();
  return new TelegramClient(new StringSession(session), API_ID, API_HASH, {
    connectionRetries: 5,
    autoReconnect: true
  });
}

function getSessionKey() {
  const secret = process.env.SESSION_ENCRYPTION_KEY || "";
  if (!secret) throw new Error("SESSION_ENCRYPTION_KEY is required to save Telegram login securely.");
  return crypto.createHash("sha256").update(secret).digest();
}
function saveEncryptedSession(sessionString) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getSessionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(sessionString, "utf8"), cipher.final()]);
  fs.writeFileSync(SESSION_FILE, Buffer.concat([iv, cipher.getAuthTag(), encrypted]), { mode: 0o600 });
}
function readEncryptedSession() {
  if (!fs.existsSync(SESSION_FILE)) return "";
  const raw = fs.readFileSync(SESSION_FILE);
  if (raw.length < 29) throw new Error("Saved Telegram session file is invalid.");
  const decipher = crypto.createDecipheriv("aes-256-gcm", getSessionKey(), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
}
function persistCurrentSession() {
  const sessionString = client?.session?.save?.() || "";
  if (!sessionString) throw new Error("Telegram session is empty; cannot persist login.");
  saveEncryptedSession(sessionString);
}

async function connectSavedSession() {
  if (clientConnecting || client) return;
  clientConnecting = true;
  try {
    const savedSession = process.env.SESSION_STRING || readEncryptedSession();
    if (!savedSession) return;
    client = createClient(savedSession);
    await client.connect();
    isConnected = await client.checkAuthorization();
    if (!isConnected) { await client.disconnect(); client = null; }
  } catch (e) {
    console.error("Saved Telegram session could not connect:", e.message);
    client = null; isConnected = false;
  } finally { clientConnecting = false; }
}
function requireTelegram(req, res, next) {
  if (!client || !isConnected) return res.status(400).json({ error: "Connect your Telegram account first." });
  next();
}
function normalizeUsername(value) {
  return String(value || "").trim().replace(/^https?:\/\/t\.me\//i, "").replace(/^@/, "").replace(/\/.*$/, "");
}

// Account status
app.get("/api/status", async (req, res) => {
  res.json({ connected: isConnected, phone: pendingLogin?.phone || null });
});

// Login: send code
app.post("/api/login/send-code", async (req, res) => {
  try {
    ensureConfig();
    const phone = String(req.body.phone || "").trim();
    if (!phone.startsWith("+")) return res.status(400).json({ error: "Use international format, e.g. +8801XXXXXXXXX." });
    if (loginBusy) return res.status(409).json({ error: "A login attempt is already in progress." });
    loginBusy = true;
    const temp = createClient();
    await temp.connect();
    const sent = await temp.sendCode({ apiId: API_ID, apiHash: API_HASH }, phone);
    pendingLogin = { temp, phone, phoneCodeHash: sent.phoneCodeHash };
    res.json({ ok: true, message: "Telegram login code sent. Enter it in the dashboard." });
  } catch (e) {
    loginBusy = false;
    res.status(400).json({ error: e.message });
  }
});

// Login: verify code; if 2FA is enabled, submit password next.
app.post("/api/login/verify", async (req, res) => {
  try {
    if (!pendingLogin) return res.status(400).json({ error: "Request a login code first." });
    const code = String(req.body.code || "").trim();
    try {
      await pendingLogin.temp.invoke(new Api.auth.SignIn({
        phoneNumber: pendingLogin.phone,
        phoneCodeHash: pendingLogin.phoneCodeHash,
        phoneCode: code
      }));
    } catch (e) {
      if (String(e.errorMessage || e.message).includes("SESSION_PASSWORD_NEEDED")) {
        return res.json({ needs2FA: true, message: "Two-step verification is enabled. Enter your Telegram 2FA password." });
      }
      throw e;
    }
    client = pendingLogin.temp;
    isConnected = true;
    persistCurrentSession();
    pendingLogin = null; loginBusy = false;
    res.json({ ok: true, message: "Telegram account connected." });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post("/api/login/2fa", async (req, res) => {
  try {
    if (!pendingLogin) return res.status(400).json({ error: "Login session expired. Request a new code." });
    const password = String(req.body.password || "");
    const passwordInfo = await pendingLogin.temp.invoke(new Api.account.GetPassword());
    const passwordCheck = await computeCheck(passwordInfo, password);
    await pendingLogin.temp.invoke(new Api.auth.CheckPassword({
      password: passwordCheck
    }));
    client = pendingLogin.temp;
    isConnected = true;
    persistCurrentSession();
    pendingLogin = null; loginBusy = false;
    res.json({ ok: true, message: "Telegram account connected." });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post("/api/logout", async (req, res) => {
  try {
    if (client) await client.disconnect();
    client = null; isConnected = false;
    process.env.SESSION_STRING = "";
    if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Groups: add only groups where this account is allowed to post.
app.get("/api/groups", (req, res) => {
  res.json(db.prepare("SELECT * FROM groups ORDER BY added_at DESC").all());
});
app.post("/api/groups", requireTelegram, async (req, res) => {
  try {
    const username = normalizeUsername(req.body.username);
    if (!username) return res.status(400).json({ error: "Enter a public group username or t.me link." });
    const entity = await client.getEntity(username);
    const title = entity.title || username;
    // Verify the account can resolve the group. Actual send permission is checked by Telegram at post time.
    const result = db.prepare("INSERT OR IGNORE INTO groups (username, title) VALUES (?, ?)").run(username, title);
    const row = db.prepare("SELECT * FROM groups WHERE username = ?").get(username);
    res.json(row);
  } catch (e) { res.status(400).json({ error: "Could not add group: " + e.message }); }
});
app.delete("/api/groups/:id", (req, res) => {
  const id = Number(req.params.id);
  db.prepare("DELETE FROM posts WHERE group_id = ?").run(id);
  db.prepare("DELETE FROM groups WHERE id = ?").run(id);
  res.json({ ok: true });
});

// Create scheduled post (one group per scheduled item)
app.post("/api/posts", requireTelegram, upload.single("image"), (req, res) => {
  try {
    const groupId = Number(req.body.group_id);
    const group = db.prepare("SELECT * FROM groups WHERE id = ?").get(groupId);
    if (!group) return res.status(400).json({ error: "Choose a group first." });
    const text = String(req.body.text || "").trim();
    const interval = Math.max(0, Math.min(10080, Number(req.body.interval_minutes || 0)));
    const scheduleAt = req.body.schedule_at ? new Date(req.body.schedule_at).toISOString() : new Date().toISOString();
    if (!text && !req.file) return res.status(400).json({ error: "Enter text or attach an image." });
    if (interval > 0 && interval < 60) return res.status(400).json({ error: "For safety, the minimum repeat interval is 60 minutes." });
    const mediaPath = req.file ? req.file.path : null;
    const row = db.prepare(`
      INSERT INTO posts (group_id, text, media_path, schedule_at, interval_minutes, next_run_at, active)
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `).run(groupId, text, mediaPath, scheduleAt, interval, scheduleAt);
    res.json({ ok: true, id: row.lastInsertRowid });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get("/api/posts", (req, res) => {
  res.json(db.prepare(`
    SELECT posts.*, groups.title AS group_title, groups.username
    FROM posts JOIN groups ON groups.id = posts.group_id
    ORDER BY posts.created_at DESC
  `).all());
});
app.post("/api/posts/:id/toggle", (req, res) => {
  const id = Number(req.params.id);
  const post = db.prepare("SELECT * FROM posts WHERE id = ?").get(id);
  if (!post) return res.status(404).json({ error: "Post not found." });
  db.prepare("UPDATE posts SET active = ? WHERE id = ?").run(post.active ? 0 : 1, id);
  res.json({ ok: true });
});
app.delete("/api/posts/:id", (req, res) => {
  db.prepare("DELETE FROM posts WHERE id = ?").run(Number(req.params.id));
  res.json({ ok: true });
});
app.get("/api/history", (req, res) => {
  res.json(db.prepare("SELECT * FROM history ORDER BY posted_at DESC LIMIT 100").all());
});

// Scheduler: due items are processed sequentially, not in parallel.
let schedulerBusy = false;
async function processDuePosts() {
  if (schedulerBusy || automationPaused || !client || !isConnected) return;
  schedulerBusy = true;
  try {
    const now = new Date().toISOString();
    const due = db.prepare(`
      SELECT posts.*, groups.username
      FROM posts JOIN groups ON groups.id = posts.group_id
      WHERE posts.active = 1 AND posts.next_run_at <= ?
      ORDER BY posts.next_run_at ASC LIMIT 1
    `).all(now);
    if (!due.length) return;
    const post = due[0];
    try {
      const entity = await client.getEntity(post.username);
      if (post.media_path && fs.existsSync(post.media_path)) {
        await client.sendFile(entity, { file: post.media_path, caption: post.text || "" });
      } else {
        await client.sendMessage(entity, { message: post.text });
      }
      db.prepare("INSERT INTO history (post_id, group_name, result, detail) VALUES (?, ?, 'SUCCESS', 'Posted successfully')").run(post.id, post.username);
    } catch (e) {
      db.prepare("INSERT INTO history (post_id, group_name, result, detail) VALUES (?, ?, 'FAILED', ?)").run(post.id, post.username, e.message.slice(0, 500));
      // Stop repeat on permission/invalid peer errors; don't repeatedly retry a forbidden destination.
      const msg = String(e.message).toLowerCase();
      if (msg.includes("write_forbidden") || msg.includes("chat_write_forbidden") || msg.includes("private") || msg.includes("not enough rights")) {
        db.prepare("UPDATE posts SET active = 0 WHERE id = ?").run(post.id);
      }
    }
    if (post.interval_minutes > 0) {
      const next = new Date(Date.now() + post.interval_minutes * 60000).toISOString();
      db.prepare("UPDATE posts SET next_run_at = ? WHERE id = ?").run(next, post.id);
    } else {
      db.prepare("UPDATE posts SET active = 0 WHERE id = ?").run(post.id);
    }
  } finally { schedulerBusy = false; }
}
setInterval(processDuePosts, 15000);

app.listen(PORT, HOST, async () => {
  console.log(`Dashboard listening on ${HOST}:${PORT}`);
  await connectSavedSession();
  const { startControlBot } = require("./control-bot");
  startControlBot({
    db,
    getClient: () => client,
    isConnected: () => isConnected,
    uploadsDir: UPLOADS_DIR,
    getPaused: () => automationPaused,
    setPaused: value => { automationPaused = Boolean(value); }
  });
});
