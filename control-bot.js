const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");
const path = require("path");

function startControlBot({ db, firebaseSync, getClient, isConnected, getAccounts, maxAccounts, uploadsDir, getPaused, setPaused }) {
  const token = process.env.BOT_TOKEN;
  const ownerId = String(process.env.BOT_OWNER_ID || "");
  if (!token || !ownerId) {
    console.log("Control bot disabled: set BOT_TOKEN and BOT_OWNER_ID in .env.");
    return null;
  }

  const bot = new TelegramBot(token, { polling: true });
  const states = new Map();

  const mainKeyboard = {
    reply_markup: {
      keyboard: [
        [{ text: "📊 Status" }, { text: "📂 Groups" }],
        [{ text: "➕ Add Group" }, { text: "➖ Remove Group" }],
        [{ text: "✍️ Create Post" }, { text: "🗓 Scheduled Posts" }],
        [{ text: "📜 Post History" }, { text: "⏸ Pause" }],
        [{ text: "▶️ Resume" }, { text: "🛑 Stop All" }]
      ],
      resize_keyboard: true
    }
  };

  function authorized(msg) {
    return String(msg.from?.id || "") === ownerId;
  }
  function authCallback(query) {
    return String(query.from?.id || "") === ownerId;
  }
  async function say(chatId, text, extra = {}) {
    return bot.sendMessage(chatId, text, { ...extra, disable_web_page_preview: true });
  }
  function groups() {
    return db.prepare("SELECT * FROM groups ORDER BY account_id, title COLLATE NOCASE").all();
  }
  function accLabel(id) {
    const a = getAccounts().find(x => x.id === id);
    return `Account ${id}${a && a.label ? " (" + a.label + ")" : ""}`;
  }
  function accountKeyboard(prefix, onlyConnected) {
    const list = getAccounts().filter(a => !onlyConnected || a.connected);
    return {
      reply_markup: {
        inline_keyboard: [
          ...list.map(a => [{ text: `${a.connected ? "✅" : "❌"} ${accLabel(a.id)}`, callback_data: `${prefix}:${a.id}` }]),
          [{ text: "Cancel", callback_data: "wizard:cancel" }]
        ]
      }
    };
  }
  function groupKeyboard(list) {
    return {
      reply_markup: {
        inline_keyboard: list.map(g => [{
          text: `[A${g.account_id}] ${g.title || g.username} (@${g.username})`,
          callback_data: `choose_group:${g.id}`
        }])
      }
    };
  }
  const TIMEZONE = process.env.TIMEZONE || "Asia/Dhaka";
  const TZ_OFFSET_HOURS = Number(process.env.TIMEZONE_OFFSET_HOURS !== undefined ? process.env.TIMEZONE_OFFSET_HOURS : 6);

  function fmtDate(value) {
    if (!value) return "—";
    try {
      return new Date(value).toLocaleString("en-US", { timeZone: TIMEZONE, hour12: true });
    } catch (_) {
      return new Date(value).toLocaleString();
    }
  }

  function parseUserDateTime(input) {
    const str = String(input || "").trim().toLowerCase();
    const now = Date.now();
    // Relative format: 1m, 10m, 30m, 1h
    const relMatch = str.match(/^(\d+)\s*(m|min|minute|minutes|h|hr|hour|hours)$/);
    if (relMatch) {
      const num = Number(relMatch[1]);
      const unit = relMatch[2];
      const ms = unit.startsWith("h") ? num * 3600000 : num * 60000;
      return new Date(now + ms);
    }
    // Full format: YYYY-MM-DD HH:mm
    const fullMatch = str.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})$/);
    if (fullMatch) {
      const y = Number(fullMatch[1]);
      const m = Number(fullMatch[2]) - 1;
      const d = Number(fullMatch[3]);
      const h = Number(fullMatch[4]);
      const min = Number(fullMatch[5]);
      const utcMs = Date.UTC(y, m, d, h, min) - (TZ_OFFSET_HOURS * 3600000);
      return new Date(utcMs);
    }
    // Time-only format: HH:mm
    const timeMatch = str.match(/^(\d{1,2}):(\d{2})$/);
    if (timeMatch) {
      const h = Number(timeMatch[1]);
      const min = Number(timeMatch[2]);
      const nowInTz = new Date(now + TZ_OFFSET_HOURS * 3600000);
      const y = nowInTz.getUTCFullYear();
      const m = nowInTz.getUTCMonth();
      let d = nowInTz.getUTCDate();
      let utcMs = Date.UTC(y, m, d, h, min) - (TZ_OFFSET_HOURS * 3600000);
      if (utcMs <= now) {
        d += 1;
        utcMs = Date.UTC(y, m, d, h, min) - (TZ_OFFSET_HOURS * 3600000);
      }
      return new Date(utcMs);
    }
    return null;
  }

  function intervalKeyboard() {
    return {
      reply_markup: {
        inline_keyboard: [
          [{ text: "একবারই (No repeat)", callback_data: "interval:0" }],
          [{ text: "প্রতি ১ মিনিট", callback_data: "interval:1" }, { text: "প্রতি ৫ মিনিট", callback_data: "interval:5" }],
          [{ text: "প্রতি ১০ মিনিট", callback_data: "interval:10" }, { text: "প্রতি ৩০ মিনিট", callback_data: "interval:30" }],
          [{ text: "প্রতি ১ ঘণ্টা", callback_data: "interval:60" }, { text: "প্রতি ৩ ঘণ্টা", callback_data: "interval:180" }],
          [{ text: "প্রতি ৬ ঘণ্টা", callback_data: "interval:360" }, { text: "প্রতি ১২ ঘণ্টা", callback_data: "interval:720" }],
          [{ text: "প্রতি ২৪ ঘণ্টা", callback_data: "interval:1440" }, { text: "✍️ Custom মিনিট", callback_data: "interval:custom" }],
          [{ text: "Cancel", callback_data: "wizard:cancel" }]
        ]
      }
    };
  }
  function addSchedule({ groupId, text, mediaPath, scheduleAt, intervalMinutes }) {
    const row = db.prepare(`
      INSERT INTO posts (group_id, text, media_path, schedule_at, interval_minutes, next_run_at, active)
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `).run(groupId, text || "", mediaPath || null, scheduleAt, intervalMinutes || 0, scheduleAt);
    if (firebaseSync) {
      const post = db.prepare("SELECT * FROM posts WHERE id = ?").get(row.lastInsertRowid);
      if (post) firebaseSync.syncPost(post);
    }
    return row;
  }
  function helpText() {
    return [
      "🤖 *Telegram Auto Poster Control*",
      "",
      "এই Bot দিয়ে আপনার Personal Telegram Account-এর posting system নিয়ন্ত্রণ করতে পারবেন।",
      "",
      "/status — Account ও automation status",
      "/groups — Group list",
      "/addgroup — Public group যোগ করুন",
      "/removegroup — Group remove করুন",
      "/post — নতুন post তৈরি করুন",
      "/schedule — Scheduled posts",
      "/history — Post history",
      "/pause — সব scheduled posting সাময়িক Pause",
      "/resume — আবার চালু",
      "/stop — সব active schedule বন্ধ",
      "",
      "নোট: আপনার Personal Account-এ যে Group-এ পোস্ট করার অনুমতি আছে, শুধু সেখানেই পোস্ট হবে।"
    ].join("\n");
  }

  bot.on("message", async msg => {
    if (!msg.chat || msg.chat.type !== "private") return;
    if (!authorized(msg)) {
      console.warn(`[Control Bot] Ignored message from unauthorized user ID: ${msg.from?.id} (configured BOT_OWNER_ID is: ${ownerId})`);
      return;
    }
    const chatId = msg.chat.id;
    const text = String(msg.text || "").trim();
    const state = states.get(String(msg.from.id));

    try {
      if (text === "/start" || text === "/help") {
        states.delete(String(msg.from.id));
        return say(chatId, helpText(), { parse_mode: "Markdown", ...mainKeyboard });
      }
      if (text === "/status" || text === "📊 Status") {
        const active = db.prepare("SELECT COUNT(*) AS n FROM posts WHERE active=1").get().n;
        const groupCount = db.prepare("SELECT COUNT(*) AS n FROM groups").get().n;
        return say(chatId,
          `📊 *System Status*\n\n${getAccounts().map(a => `${a.connected ? "✅" : "❌"} Account ${a.id}${a.label ? " — " + a.label : ""}`).join("\n")}\nGroups: ${groupCount}\nActive schedules: ${active}\nAutomation: ${getPaused() ? "⏸ Paused" : "▶️ Running"}\nControl bot: ✅ Online`,
          { parse_mode: "Markdown", ...mainKeyboard });
      }
      if (text === "/groups" || text === "📂 Groups") {
        const list = groups();
        if (!list.length) return say(chatId, "এখনো কোনো Group যোগ করা হয়নি। /addgroup ব্যবহার করুন।", mainKeyboard);
        return say(chatId, "📂 *Your Groups*\n" + list.map((g,i)=>`${i+1}. [A${g.account_id}] ${g.title || g.username} — @${g.username}`).join("\n"), { parse_mode:"Markdown", ...mainKeyboard });
      }
      if (text === "/addgroup" || text === "➕ Add Group") {
        states.set(String(msg.from.id), { step: "choose_account" });
        return say(chatId, "কোন Telegram Account দিয়ে Group যোগ করবেন?", accountKeyboard("add_acc", true));
      }
      if (text === "/removegroup" || text === "➖ Remove Group") {
        const list = groups();
        if (!list.length) return say(chatId, "কোনো Group নেই।", mainKeyboard);
        return say(chatId, "কোন Group remove করবেন?", {
          reply_markup: { inline_keyboard: list.map(g => [{ text: `❌ [A${g.account_id}] ${g.title || g.username}`, callback_data: `remove_group:${g.id}` }]) }
        });
      }
      if (text === "/post" || text === "✍️ Create Post") {
        if (!getAccounts().some(a => a.connected)) return say(chatId, "আগে Web Dashboard থেকে Personal Telegram Account connect করুন।");
        const list = groups();
        if (!list.length) return say(chatId, "আগে /addgroup দিয়ে একটি Group যোগ করুন।", mainKeyboard);
        states.set(String(msg.from.id), { step: "post_account" });
        return say(chatId, "কোন Account থেকে পোস্ট করবেন?", accountKeyboard("post_acc", true));
      }
      if (text === "/schedule" || text === "🗓 Scheduled Posts") {
        const rows = db.prepare(`
          SELECT p.*, g.username, g.account_id FROM posts p JOIN groups g ON g.id=p.group_id
          ORDER BY p.next_run_at ASC LIMIT 30
        `).all();
        if (!rows.length) return say(chatId, "কোনো scheduled post নেই।", mainKeyboard);
        const lines = rows.map(p => `#${p.id} [A${p.account_id}] @${p.username}\n${(p.text || "🖼 Image post").slice(0,80)}\nNext: ${fmtDate(p.next_run_at)} | ${p.interval_minutes ? p.interval_minutes+" min repeat" : "Once"} | ${p.active ? "Active" : "Paused/Done"}`);
        return say(chatId, "🗓 *Scheduled Posts*\n\n" + lines.join("\n\n"), { parse_mode:"Markdown", ...mainKeyboard });
      }
      if (text === "/history" || text === "📜 Post History") {
        const rows = db.prepare("SELECT * FROM history ORDER BY posted_at DESC LIMIT 20").all();
        if (!rows.length) return say(chatId, "এখনো কোনো post history নেই।", mainKeyboard);
        return say(chatId, "📜 *Recent Post History*\n\n" + rows.map(r=>`${r.result==="SUCCESS"?"✅":"❌"} @${r.group_name}\n${fmtDate(r.posted_at)}\n${String(r.detail||"").slice(0,150)}`).join("\n\n"), { parse_mode:"Markdown", ...mainKeyboard });
      }
      if (text === "/pause" || text === "⏸ Pause") {
        setPaused(true);
        return say(chatId, "⏸ Automation paused. Scheduled posts queue-তে থাকবে।", mainKeyboard);
      }
      if (text === "/resume" || text === "▶️ Resume") {
        setPaused(false);
        return say(chatId, "▶️ Automation resumed.", mainKeyboard);
      }
      if (text === "/stop" || text === "🛑 Stop All") {
        db.prepare("UPDATE posts SET active=0 WHERE active=1").run();
        if (firebaseSync) firebaseSync.syncAllPostsActive(0);
        setPaused(false);
        return say(chatId, "🛑 সব active scheduled post বন্ধ করা হয়েছে।", mainKeyboard);
      }

      // Wizard states
      if (state?.step === "add_group") {
        if (!state.accountId || !isConnected(state.accountId)) return say(chatId, "Selected Telegram Account connected নয়। Dashboard থেকে login করুন।");
        const username = text.replace(/^https?:\/\/t\.me\//i, "").replace(/^@/, "").replace(/\/.*$/, "");
        if (!username || !/^[a-zA-Z0-9_]{5,}$/.test(username)) return say(chatId, "সঠিক @username বা t.me link দিন।");
        const entity = await getClient(state.accountId).getEntity(username);
        db.prepare("INSERT OR IGNORE INTO groups (account_id,username,title) VALUES (?,?,?)").run(state.accountId, username, entity.title || username);
        const groupRow = db.prepare("SELECT * FROM groups WHERE account_id = ? AND username = ?").get(state.accountId, username);
        if (firebaseSync && groupRow) firebaseSync.syncGroup(groupRow);
        states.delete(String(msg.from.id));
        return say(chatId, `✅ Group যোগ হয়েছে: ${entity.title || username} (@${username}) — ${accLabel(state.accountId)}`, mainKeyboard);
      }
      if (state?.step === "content") {
        const caption = String(msg.caption || msg.text || "").trim();
        if (!caption && !msg.photo) return say(chatId, "Text লিখুন অথবা একটি Image পাঠান।");
        let mediaPath = null;
        if (msg.photo?.length) {
          const photo = msg.photo[msg.photo.length - 1];
          const filePath = await bot.downloadFile(photo.file_id, uploadsDir);
          mediaPath = filePath;
        }
        state.text = caption;
        state.mediaPath = mediaPath;
        state.step = "timing";
        return say(chatId, "কখন পোস্ট করবেন?", {
          reply_markup: { inline_keyboard: [[
            { text: "🚀 Post Now", callback_data: "timing:now" },
            { text: "🗓 Schedule", callback_data: "timing:later" }
          ], [{ text: "Cancel", callback_data: "wizard:cancel" }]] }
        });
      }
      if (state?.step === "schedule_time") {
        const date = parseUserDateTime(text);
        if (!date || Number.isNaN(date.getTime()) || date.getTime() <= Date.now()) {
          return say(chatId, "সঠিক সময় দিন।\nউদাহরণ:\n• `10m` (১০ মিনিট পর)\n• `1m` (১ মিনিট পর)\n• `18:30` (আজকের সময়)\n• `2026-11-04 18:30` (সম্পূর্ণ তারিখ ও সময়)", { parse_mode: "Markdown" });
        }
        state.scheduleAt = date.toISOString();
        state.step = "interval";
        return say(chatId, `সময় সেট করা হয়েছে: *${fmtDate(state.scheduleAt)}*\n\nকতক্ষণ পরপর Repeat হবে?`, {
          parse_mode: "Markdown",
          ...intervalKeyboard()
        });
      }
      if (state?.step === "custom_interval") {
        const num = Number(text);
        if (Number.isNaN(num) || num < 0 || num > 10080) {
          return say(chatId, "সঠিক মিনিট সংখ্যা দিন (যেমন: 1, 10, 45, 120)।");
        }
        addSchedule({
          groupId: state.groupId,
          text: state.text,
          mediaPath: state.mediaPath,
          scheduleAt: state.scheduleAt,
          intervalMinutes: num
        });
        states.delete(String(msg.from.id));
        return say(chatId, `✅ Post schedule saved.\nGroup: @${state.groupName}\nFirst run: ${fmtDate(state.scheduleAt)}\nRepeat: ${num ? num + " minutes" : "Once"}`, mainKeyboard);
      }
    } catch (e) {
      console.error("Control bot message error:", e);
      return say(chatId, "❌ Error: " + String(e.message || e).slice(0,300));
    }
  });

  bot.on("callback_query", async query => {
    if (!authCallback(query)) return bot.answerCallbackQuery(query.id, { text: "Not authorized." });
    const chatId = query.message.chat.id;
    const key = String(query.from.id);
    const data = query.data || "";
    const state = states.get(key);
    try {
      if (data === "wizard:cancel") {
        states.delete(key);
        await bot.answerCallbackQuery(query.id, { text: "Cancelled" });
        return say(chatId, "Post creation cancelled.", mainKeyboard);
      }
      if (data.startsWith("post_acc:")) {
        if (!state || state.step !== "post_account") return bot.answerCallbackQuery(query.id, { text: "Start /post again." });
        const id = Number(data.split(":")[1]);
        if (!isConnected(id)) return bot.answerCallbackQuery(query.id, { text: "Account not connected." });
        const list = groups().filter(g => Number(g.account_id) === id);
        await bot.answerCallbackQuery(query.id, { text: "Account selected" });
        if (!list.length) {
          states.delete(key);
          return say(chatId, `${accLabel(id)}-এ কোনো Group নেই। আগে /addgroup দিয়ে এই Account-এ Group যোগ করুন।`, mainKeyboard);
        }
        state.accountId = id;
        state.step = "choose_group";
        return say(chatId, `${accLabel(id)} নির্বাচিত।\nকোন Group-এ পোস্ট করবেন?`, groupKeyboard(list));
      }
      if (data.startsWith("add_acc:")) {
        if (!state || state.step !== "choose_account") return bot.answerCallbackQuery(query.id, { text: "Start /addgroup again." });
        const id = Number(data.split(":")[1]);
        if (!isConnected(id)) return bot.answerCallbackQuery(query.id, { text: "Account not connected." });
        state.accountId = id;
        state.step = "add_group";
        await bot.answerCallbackQuery(query.id, { text: "Account selected" });
        return say(chatId, `${accLabel(id)} নির্বাচিত।\nযে Public Group-এ এই Account পোস্ট করার অনুমতি রাখে, তার @username অথবা t.me link পাঠান।`);
      }
      if (data.startsWith("remove_group:")) {
        const id = Number(data.split(":")[1]);
        const g = db.prepare("SELECT * FROM groups WHERE id=?").get(id);
        if (g) {
          db.prepare("DELETE FROM posts WHERE group_id=?").run(id);
          db.prepare("DELETE FROM groups WHERE id=?").run(id);
          if (firebaseSync) firebaseSync.deleteGroup(id);
        }
        await bot.answerCallbackQuery(query.id, { text: "Group removed" });
        return say(chatId, `Removed ${g ? "@"+g.username : "group"}.`, mainKeyboard);
      }
      if (data.startsWith("choose_group:")) {
        if (!state || state.step !== "choose_group") return bot.answerCallbackQuery(query.id, { text: "Start /post again." });
        const id = Number(data.split(":")[1]);
        const g = db.prepare("SELECT * FROM groups WHERE id=?").get(id);
        if (!g) return bot.answerCallbackQuery(query.id, { text: "Group not found." });
        if (state.accountId && Number(g.account_id) !== state.accountId) return bot.answerCallbackQuery(query.id, { text: "This group belongs to another account.", show_alert: true });
        if (!isConnected(g.account_id)) return bot.answerCallbackQuery(query.id, { text: `${accLabel(g.account_id)} is disconnected.`, show_alert: true });
        state.groupId = id;
        state.groupName = g.username;
        state.step = "content";
        await bot.answerCallbackQuery(query.id, { text: "Group selected" });
        return say(chatId, `Selected @${g.username} (${accLabel(g.account_id)}).\nএখন Post Text লিখুন অথবা Image + Caption পাঠান। শুধু Image-ও পাঠাতে পারেন।`);
      }
      if (data.startsWith("timing:")) {
        if (!state || state.step !== "timing") return bot.answerCallbackQuery(query.id, { text: "Post flow expired." });
        if (data === "timing:now") {
          state.scheduleAt = new Date().toISOString();
          state.step = "interval";
          await bot.answerCallbackQuery(query.id);
          return say(chatId, "কতক্ষণ পরপর Repeat হবে?", intervalKeyboard());
        } else {
          state.step = "schedule_time";
          await bot.answerCallbackQuery(query.id);
          return say(chatId, "কখন পোস্ট করবেন? সময় লিখে পাঠান:\n\n• `10m` (১০ মিনিট পর)\n• `1m` (১ মিনিট পর)\n• `18:30` (আজকের সময়)\n• `2026-11-04 18:30` (তারিখ ও সময়)", { parse_mode:"Markdown" });
        }
      }
      if (data === "interval:custom") {
        if (!state || state.step !== "interval") return bot.answerCallbackQuery(query.id, { text: "Post flow expired." });
        state.step = "custom_interval";
        await bot.answerCallbackQuery(query.id);
        return say(chatId, "কত মিনিট পরপর Repeat হবে? মিনিট সংখ্যা লিখে পাঠান (যেমন: 1, 10, 45, 120):");
      }
      if (data.startsWith("interval:")) {
        if (!state || state.step !== "interval") return bot.answerCallbackQuery(query.id, { text: "Post flow expired." });
        const interval = Number(data.split(":")[1]);
        if (Number.isNaN(interval) || interval < 0 || interval > 10080) return bot.answerCallbackQuery(query.id, { text: "Invalid interval." });
        addSchedule({
          groupId: state.groupId,
          text: state.text,
          mediaPath: state.mediaPath,
          scheduleAt: state.scheduleAt,
          intervalMinutes: interval
        });
        states.delete(key);
        await bot.answerCallbackQuery(query.id, { text: "Saved" });
        return say(chatId, `✅ Post schedule saved.\nGroup: @${state.groupName}\nFirst run: ${fmtDate(state.scheduleAt)}\nRepeat: ${interval ? interval+" minutes" : "Once"}`, mainKeyboard);
      }
      await bot.answerCallbackQuery(query.id);
    } catch (e) {
      console.error("Control bot callback error:", e);
      await bot.answerCallbackQuery(query.id, { text: "Error occurred." });
      return say(chatId, "❌ " + String(e.message || e).slice(0,300));
    }
  });

  bot.on("polling_error", err => console.error("Control bot polling error:", err.message));
  console.log("Telegram control bot started (owner-only).");
  return bot;
}

module.exports = { startControlBot };
