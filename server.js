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
const admin = require("firebase-admin");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const HOST = "0.0.0.0";
// Render Free has no Persistent Disk. Keep writable local files under the app
// directory; Telegram session persistence is handled separately by Firebase.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
const SESSION_FILE = path.join(DATA_DIR, "telegram-session.enc");
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Firebase Realtime Database is used for the encrypted Telegram session.
// Set FIREBASE_SERVICE_ACCOUNT_JSON to the full service-account JSON content.
let firebaseSessionRef = null;
let firebaseError = null;

function parseServiceAccount(raw) {
  let cleaned = String(raw || "").trim();
  if ((cleaned.startsWith('"') && cleaned.endsWith('"')) || (cleaned.startsWith("'") && cleaned.endsWith("'"))) {
    cleaned = cleaned.slice(1, -1).trim();
  }
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (_) {
    parsed = JSON.parse(Buffer.from(cleaned, "base64").toString("utf8"));
  }
  if (typeof parsed === "string") {
    parsed = JSON.parse(parsed);
  }
  if (parsed && typeof parsed.private_key === "string") {
    parsed.private_key = parsed.private_key.replace(/\\n/g, "\n");
  }
  return parsed;
}

try {
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  let databaseURL = String(process.env.FIREBASE_DATABASE_URL || "").trim().replace(/^['"]|['"]$/g, "");
  if (serviceAccountJson) {
    const serviceAccount = parseServiceAccount(serviceAccountJson);
    if (!databaseURL && serviceAccount.project_id) {
      databaseURL = `https://${serviceAccount.project_id}-default-rtdb.firebaseio.com`;
    }
    if (databaseURL && !/^https?:\/\//i.test(databaseURL)) {
      databaseURL = `https://${databaseURL}`;
    }
    if (!databaseURL) {
      throw new Error("FIREBASE_DATABASE_URL is missing.");
    }
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL
      });
    }
    firebaseSessionRef = admin.database().ref("private/telegramSession");
    console.log("Firebase session storage initialized:", databaseURL);
  } else {
    firebaseError = "FIREBASE_SERVICE_ACCOUNT_JSON is not set in environment variables.";
    console.warn("Firebase session storage is not configured; using local session file only.");
  }
} catch (e) {
  firebaseError = e.message;
  console.error("Firebase initialization failed:", e.message);
}
const API_ID = Number(process.env.API_ID || 0);
const API_HASH = process.env.API_HASH || "";
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || "";
const DASHBOARD_SESSION_SECRET = process.env.DASHBOARD_SESSION_SECRET || process.env.SESSION_ENCRYPTION_KEY || "";
const db = new Database(path.join(DATA_DIR, "data.sqlite"));
db.pragma("journal_mode = WAL");

const MAX_ACCOUNTS = Math.max(1, Number(process.env.MAX_ACCOUNTS || 2));
const GROUPS_SCHEMA = `(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL DEFAULT 1,
  username TEXT NOT NULL,
  title TEXT,
  added_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(account_id, username)
)`;
db.exec(`
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY,
  label TEXT,
  phone TEXT,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS groups ${GROUPS_SCHEMA};
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
// Migrate single-account databases: existing groups belong to account 1.
if (!db.prepare("PRAGMA table_info(groups)").all().some(c => c.name === "account_id")) {
  db.pragma("foreign_keys = OFF");
  db.transaction(() => {
    db.exec(`CREATE TABLE groups_new ${GROUPS_SCHEMA};
      INSERT INTO groups_new (id, username, title, added_at) SELECT id, username, title, added_at FROM groups;
      DROP TABLE groups;
      ALTER TABLE groups_new RENAME TO groups;`);
  })();
  db.pragma("foreign_keys = ON");
}

const { createFirebaseSync } = require("./firebase-sync");
const firebaseSync = createFirebaseSync({
  db,
  admin,
  uploadsDir: UPLOADS_DIR
});

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(UPLOADS_DIR));
app.get("/health", (_req, res) => res.status(200).send("ok"));

const upload = multer({
  dest: UPLOADS_DIR,
  limits: { fileSize: 10 * 1024 * 1024 }
});

const clients = new Map(); // account id -> connected TelegramClient
const restorePromises = new Map();
let pendingLogin = null;
let loginBusy = false;
let automationPaused = false;
let dataRestoreReady = false;

function requireDashboard(req, res, next) {
  if (!DASHBOARD_PASSWORD) return res.status(503).json({ error: "Set DASHBOARD_PASSWORD in .env before using the dashboard." });
  const token = String(req.headers.cookie || "").split(";").map(part => part.trim()).find(part => part.startsWith("dashboard_session="))?.slice("dashboard_session=".length);
  let validCookie = false;
  if (token && DASHBOARD_SESSION_SECRET) {
    try {
      const [expires, signature] = decodeURIComponent(token).split(".");
      if (expires && signature && Number(expires) > Date.now()) {
        const expected = crypto.createHmac("sha256", DASHBOARD_SESSION_SECRET).update(expires).digest("hex");
        const actualBuffer = Buffer.from(signature, "hex");
        const expectedBuffer = Buffer.from(expected, "hex");
        validCookie = actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
      }
    } catch (_) {}
  }
  if (!validCookie) return res.status(401).json({ error: "Dashboard password required." });
  next();
}

app.post("/auth/login", (req, res) => {
  if (!DASHBOARD_PASSWORD) return res.status(503).json({ error: "Set DASHBOARD_PASSWORD in .env before using the dashboard." });
  if (String(req.body?.password || "") !== DASHBOARD_PASSWORD) return res.status(401).json({ error: "Incorrect dashboard password." });
  if (!DASHBOARD_SESSION_SECRET) return res.status(503).json({ error: "Set SESSION_ENCRYPTION_KEY to enable secure dashboard sessions." });
  const expires = String(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const signature = crypto.createHmac("sha256", DASHBOARD_SESSION_SECRET).update(expires).digest("hex");
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `dashboard_session=${encodeURIComponent(`${expires}.${signature}`)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${secure}`);
  res.json({ ok: true });
});
app.post("/auth/logout", (_req, res) => {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `dashboard_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`);
  res.json({ ok: true });
});
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
function encryptSession(sessionString) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getSessionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(sessionString, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
}
function decryptSession(encoded) {
  const raw = Buffer.from(encoded, "base64");
  if (raw.length < 29) throw new Error("Saved Telegram session data is invalid.");
  const decipher = crypto.createDecipheriv("aes-256-gcm", getSessionKey(), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
}

function parseAccountId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1 || id > MAX_ACCOUNTS) throw new Error(`Choose a valid account (1-${MAX_ACCOUNTS}).`);
  return id;
}
function sessionFile(id) {
  return id === 1 ? SESSION_FILE : path.join(DATA_DIR, `telegram-session-${id}.enc`);
}
function sessionRef(id) {
  return firebaseSessionRef ? admin.database().ref(`private/telegramSessions/${id}`) : null;
}
async function saveEncryptedSession(id, sessionString) {
  const encrypted = encryptSession(sessionString);
  const ref = sessionRef(id);
  if (ref) {
    await ref.set({ encrypted, updatedAt: new Date().toISOString(), version: 2 });
    console.log(`Encrypted Telegram session for account ${id} saved to Firebase Realtime Database.`);
    return;
  }
  // Local fallback is useful for development, but is not persistent on Render Free.
  const file = sessionFile(id);
  const tempFile = file + ".tmp";
  fs.writeFileSync(tempFile, Buffer.from(encrypted, "utf8"), { mode: 0o600 });
  fs.renameSync(tempFile, file);
  console.warn(`Telegram session for account ${id} saved locally only; configure Firebase for Render Free persistence.`);
}
async function readEncryptedSession(id) {
  const ref = sessionRef(id);
  if (ref) {
    const value = (await ref.get()).val();
    if (value && value.encrypted) return decryptSession(value.encrypted);
    if (id === 1) {
      // Legacy single-account location.
      const legacy = (await firebaseSessionRef.get()).val();
      if (legacy && legacy.encrypted) return decryptSession(legacy.encrypted);
    }
  }
  const file = sessionFile(id);
  if (!fs.existsSync(file)) return "";
  return decryptSession(fs.readFileSync(file, "utf8"));
}
async function removeStoredSession(id) {
  const ref = sessionRef(id);
  if (ref) await ref.remove();
  if (id === 1 && firebaseSessionRef) await firebaseSessionRef.remove();
  const file = sessionFile(id);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

async function activateAccount(id, tgClient) {
  const sessionString = tgClient?.session?.save?.() || "";
  if (!sessionString) throw new Error("Telegram session is empty; cannot persist login.");
  await saveEncryptedSession(id, sessionString);
  const old = clients.get(id);
  clients.set(id, tgClient);
  if (old && old !== tgClient) { try { await old.disconnect(); } catch (_) {} }
  try {
    const me = await tgClient.getMe();
    const name = [me.firstName, me.lastName].filter(Boolean).join(" ") || me.username || `Account ${id}`;
    const phone = me.phone ? "+" + me.phone : "";
    db.prepare(`INSERT INTO accounts (id, label, phone, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET label = excluded.label, phone = excluded.phone, updated_at = excluded.updated_at`)
      .run(id, name, phone, new Date().toISOString());
    firebaseSync.syncAccount(db.prepare("SELECT * FROM accounts WHERE id = ?").get(id));
  } catch (e) {
    console.warn(`Could not read profile for account ${id}:`, e.message);
  }
}

async function connectSavedSession(id) {
  if (clients.has(id)) return true;
  if (restorePromises.has(id)) return restorePromises.get(id);

  const promise = (async () => {
    let restoredClient = null;
    try {
      const savedSession = (id === 1 && process.env.SESSION_STRING) || await readEncryptedSession(id);
      if (!savedSession) {
        console.log(`No saved Telegram session for account ${id}; login is required.`);
        return false;
      }
      restoredClient = createClient(savedSession);
      await restoredClient.connect();
      if (!(await restoredClient.checkAuthorization())) {
        await restoredClient.disconnect();
        console.warn(`Saved Telegram session for account ${id} is no longer authorized.`);
        return false;
      }
      clients.set(id, restoredClient);
      console.log(`Saved Telegram session for account ${id} restored successfully.`);
      return true;
    } catch (e) {
      console.error(`Saved Telegram session for account ${id} could not be restored:`, e.message);
      if (restoredClient) { try { await restoredClient.disconnect(); } catch (_) {} }
      clients.delete(id);
      return false;
    } finally {
      restorePromises.delete(id);
    }
  })();
  restorePromises.set(id, promise);
  return promise;
}
async function connectAllSavedSessions() {
  for (let id = 1; id <= MAX_ACCOUNTS; id++) await connectSavedSession(id);
}
function anyConnected() { return clients.size > 0; }
function accountList() {
  const rows = db.prepare("SELECT * FROM accounts").all();
  return Array.from({ length: MAX_ACCOUNTS }, (_, i) => {
    const id = i + 1;
    const row = rows.find(r => r.id === id);
    return { id, label: row?.label || "", phone: row?.phone || "", connected: clients.has(id) };
  });
}
// Resolve the Telegram client for an account, restoring a saved session if needed.
async function getAccountClient(id) {
  if (!dataRestoreReady) throw new Error("Stored dashboard data is still restoring. Try again shortly.");
  if (!clients.has(id)) await connectSavedSession(id);
  const c = clients.get(id);
  if (!c) throw new Error(`Telegram account ${id} is disconnected. Please connect it again.`);
  return c;
}
function normalizeUsername(value) {
  return String(value || "").trim().replace(/^https?:\/\/t\.me\//i, "").replace(/^@/, "").replace(/\/.*$/, "");
}

// Account status
app.get("/api/status", async (req, res) => {
  // Wait for session restoration before reporting status. This avoids a false
  // "Disconnected" immediately after a Render restart or a new page load.
  await connectAllSavedSessions();
  res.json({
    connected: anyConnected(),
    accounts: accountList(),
    pendingAccount: pendingLogin?.accountId || null,
    phone: pendingLogin?.phone || null,
    firebaseConfigured: Boolean(firebaseSessionRef),
    firebaseError: firebaseError || null,
    dataRestored: dataRestoreReady
  });
});

// Login: send code (for the selected account slot)
app.post("/api/login/send-code", async (req, res) => {
  try {
    ensureConfig();
    const accountId = parseAccountId(req.body.account_id);
    const phone = String(req.body.phone || "").trim();
    if (!phone.startsWith("+")) return res.status(400).json({ error: "Use international format, e.g. +8801XXXXXXXXX." });
    if (loginBusy) return res.status(409).json({ error: "A login attempt is already in progress." });
    loginBusy = true;
    const temp = createClient();
    await temp.connect();
    const sent = await temp.sendCode({ apiId: API_ID, apiHash: API_HASH }, phone);
    pendingLogin = { accountId, temp, phone, phoneCodeHash: sent.phoneCodeHash };
    res.json({ ok: true, message: `Telegram login code sent for Account ${accountId}. Enter it in the dashboard.` });
  } catch (e) {
    loginBusy = false;
    res.status(400).json({ error: e.message });
  }
});

async function finishLogin(res) {
  const { accountId, temp } = pendingLogin;
  await activateAccount(accountId, temp);
  pendingLogin = null; loginBusy = false;
  res.json({ ok: true, message: `Telegram Account ${accountId} connected.` });
}

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
    await finishLogin(res);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post("/api/login/2fa", async (req, res) => {
  try {
    if (!pendingLogin) return res.status(400).json({ error: "Login session expired. Request a new code." });
    const password = String(req.body.password || "");
    const passwordInfo = await pendingLogin.temp.invoke(new Api.account.GetPassword());
    const passwordCheck = await computeCheck(passwordInfo, password);
    await pendingLogin.temp.invoke(new Api.auth.CheckPassword({ password: passwordCheck }));
    await finishLogin(res);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Disconnect one Telegram account (account_id) or all of them (no account_id).
app.post("/api/logout", async (req, res) => {
  try {
    const ids = req.body?.account_id ? [parseAccountId(req.body.account_id)] : Array.from({ length: MAX_ACCOUNTS }, (_, i) => i + 1);
    for (const id of ids) {
      const c = clients.get(id);
      if (c) { try { await c.disconnect(); } catch (_) {} }
      clients.delete(id);
      if (id === 1) process.env.SESSION_STRING = "";
      await removeStoredSession(id);
    }
    if (pendingLogin?.temp && ids.includes(pendingLogin.accountId)) { try { await pendingLogin.temp.disconnect(); } catch (_) {} pendingLogin = null; loginBusy = false; }
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Groups: each group belongs to one Telegram account; add only groups where that account may post.
app.get("/api/groups", (req, res) => {
  if (!dataRestoreReady) return res.status(503).json({ error: "Stored dashboard data is still restoring. Try again shortly." });
  res.json(db.prepare("SELECT * FROM groups ORDER BY account_id, added_at DESC").all());
});
app.post("/api/groups", async (req, res) => {
  try {
    const accountId = parseAccountId(req.body.account_id);
    const tg = await getAccountClient(accountId);
    const username = normalizeUsername(req.body.username);
    if (!username) return res.status(400).json({ error: "Enter a public group username or t.me link." });
    const entity = await tg.getEntity(username);
    const title = entity.title || username;
    // Verify the account can resolve the group. Actual send permission is checked by Telegram at post time.
    db.prepare("INSERT OR IGNORE INTO groups (account_id, username, title) VALUES (?, ?, ?)").run(accountId, username, title);
    const row = db.prepare("SELECT * FROM groups WHERE account_id = ? AND username = ?").get(accountId, username);
    if (row) firebaseSync.syncGroup(row);
    res.json(row);
  } catch (e) { res.status(400).json({ error: "Could not add group: " + e.message }); }
});
app.delete("/api/groups/:id", (req, res) => {
  const id = Number(req.params.id);
  db.prepare("DELETE FROM posts WHERE group_id = ?").run(id);
  db.prepare("DELETE FROM groups WHERE id = ?").run(id);
  firebaseSync.deleteGroup(id);
  res.json({ ok: true });
});

function parseScheduleAt(value) {
  if (!value) return new Date().toISOString();
  const str = String(value).trim();
  if (str.endsWith("Z") || /[+-]\d{2}:?\d{2}$/.test(str)) {
    const d = new Date(str);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  const tzHours = Number(process.env.TIMEZONE_OFFSET_HOURS !== undefined ? process.env.TIMEZONE_OFFSET_HOURS : 6);
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})[T\s](\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    const y = Number(m[1]);
    const mon = Number(m[2]) - 1;
    const d = Number(m[3]);
    const h = Number(m[4]);
    const min = Number(m[5]);
    const s = Number(m[6] || 0);
    const utcMs = Date.UTC(y, mon, d, h, min, s) - (tzHours * 3600000);
    return new Date(utcMs).toISOString();
  }
  const d = new Date(str);
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

// Create scheduled post (one group per scheduled item)
app.post("/api/posts", upload.single("image"), async (req, res) => {
  try {
    const groupId = Number(req.body.group_id);
    const group = db.prepare("SELECT * FROM groups WHERE id = ?").get(groupId);
    if (!group) return res.status(400).json({ error: "Choose a group first." });
    await getAccountClient(group.account_id);
    const text = String(req.body.text || "").trim();
    const interval = Math.max(0, Math.min(10080, Number(req.body.interval_minutes || 0)));
    const scheduleAt = parseScheduleAt(req.body.schedule_at);
    if (!text && !req.file) return res.status(400).json({ error: "Enter text or attach an image." });
    if (interval < 0) return res.status(400).json({ error: "Interval cannot be negative." });
    const mediaPath = req.file ? req.file.path : null;
    const row = db.prepare(`
      INSERT INTO posts (group_id, text, media_path, schedule_at, interval_minutes, next_run_at, active)
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `).run(groupId, text, mediaPath, scheduleAt, interval, scheduleAt);
    const postRow = db.prepare("SELECT * FROM posts WHERE id = ?").get(row.lastInsertRowid);
    if (postRow) firebaseSync.syncPost(postRow);
    res.json({ ok: true, id: row.lastInsertRowid });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get("/api/posts", (req, res) => {
  if (!dataRestoreReady) return res.status(503).json({ error: "Stored dashboard data is still restoring. Try again shortly." });
  res.json(db.prepare(`
    SELECT posts.*, groups.title AS group_title, groups.username, groups.account_id
    FROM posts JOIN groups ON groups.id = posts.group_id
    ORDER BY posts.created_at DESC
  `).all());
});
app.post("/api/posts/:id/toggle", (req, res) => {
  const id = Number(req.params.id);
  const post = db.prepare("SELECT * FROM posts WHERE id = ?").get(id);
  if (!post) return res.status(404).json({ error: "Post not found." });
  const newActive = post.active ? 0 : 1;
  db.prepare("UPDATE posts SET active = ? WHERE id = ?").run(newActive, id);
  firebaseSync.syncPostField(id, "active", newActive);
  res.json({ ok: true });
});
app.delete("/api/posts/:id", (req, res) => {
  const id = Number(req.params.id);
  db.prepare("DELETE FROM posts WHERE id = ?").run(id);
  firebaseSync.deletePost(id);
  res.json({ ok: true });
});
app.get("/api/history", (req, res) => {
  if (!dataRestoreReady) return res.status(503).json({ error: "Stored dashboard data is still restoring. Try again shortly." });
  res.json(db.prepare("SELECT * FROM history ORDER BY posted_at DESC LIMIT 100").all());
});

// Scheduler: due items are processed sequentially, not in parallel.
let schedulerBusy = false;
async function processDuePosts() {
  if (!dataRestoreReady || schedulerBusy || automationPaused || !clients.size) return;
  schedulerBusy = true;
  try {
    const now = new Date().toISOString();
    const due = db.prepare(`
      SELECT posts.*, groups.username, groups.account_id
      FROM posts JOIN groups ON groups.id = posts.group_id
      WHERE posts.active = 1 AND posts.next_run_at <= ?
        AND groups.account_id IN (${Array.from(clients.keys()).join(",")})
      ORDER BY posts.next_run_at ASC LIMIT 1
    `).all(now);
    if (!due.length) return;
    const post = due[0];
    try {
      const tg = clients.get(post.account_id);
      const entity = await tg.getEntity(post.username);
      if (post.media_path && fs.existsSync(post.media_path)) {
        await tg.sendFile(entity, { file: post.media_path, caption: post.text || "" });
      } else {
        await tg.sendMessage(entity, { message: post.text });
      }
      const hRow = db.prepare("INSERT INTO history (post_id, group_name, result, detail) VALUES (?, ?, 'SUCCESS', 'Posted successfully')").run(post.id, post.username);
      firebaseSync.syncHistory({ id: hRow.lastInsertRowid, post_id: post.id, group_name: post.username, result: "SUCCESS", detail: "Posted successfully", posted_at: new Date().toISOString() });
    } catch (e) {
      const hRow = db.prepare("INSERT INTO history (post_id, group_name, result, detail) VALUES (?, ?, 'FAILED', ?)").run(post.id, post.username, e.message.slice(0, 500));
      firebaseSync.syncHistory({ id: hRow.lastInsertRowid, post_id: post.id, group_name: post.username, result: "FAILED", detail: e.message.slice(0, 500), posted_at: new Date().toISOString() });
      // Stop repeat on permission/invalid peer errors; don't repeatedly retry a forbidden destination.
      const msg = String(e.message).toLowerCase();
      if (msg.includes("write_forbidden") || msg.includes("chat_write_forbidden") || msg.includes("private") || msg.includes("not enough rights")) {
        db.prepare("UPDATE posts SET active = 0 WHERE id = ?").run(post.id);
        firebaseSync.syncPostField(post.id, "active", 0);
      }
    }
    if (post.interval_minutes > 0) {
      const next = new Date(Date.now() + post.interval_minutes * 60000).toISOString();
      db.prepare("UPDATE posts SET next_run_at = ? WHERE id = ?").run(next, post.id);
      firebaseSync.syncPostField(post.id, "next_run_at", next);
    } else {
      db.prepare("UPDATE posts SET active = 0 WHERE id = ?").run(post.id);
      firebaseSync.syncPostField(post.id, "active", 0);
    }
  } finally { schedulerBusy = false; }
}
app.listen(PORT, HOST, async () => {
  console.log(`Dashboard listening on ${HOST}:${PORT}`);
  const restored = await firebaseSync.restoreAllFromFirebase();
  if (!restored) {
    firebaseError = firebaseError || "Dashboard data could not be restored from Firebase. Check Firebase credentials, database URL, and rules.";
  }
  dataRestoreReady = restored;
  if (!restored) console.error("[Firebase Sync] Startup is waiting for a successful data restore; scheduled posting remains paused.");
  await connectAllSavedSessions();
  const { startControlBot } = require("./control-bot");
  startControlBot({
    db,
    firebaseSync,
    getClient: id => clients.get(id) || null,
    isConnected: id => clients.has(id),
    getAccounts: accountList,
    maxAccounts: MAX_ACCOUNTS,
    uploadsDir: UPLOADS_DIR,
    getPaused: () => automationPaused,
    setPaused: value => { automationPaused = Boolean(value); }
  });
  setInterval(processDuePosts, 15000);
});
