// Telegram notifications — ping the user when a run finishes or needs input.
// Set TELEGRAM_BOT_TOKEN (from @BotFather). TELEGRAM_CHAT_ID is auto-discovered
// from getUpdates the first time (message your bot once), then cached to .env.
require("./env");
const https = require("https");
const fs = require("fs");
const path = require("path");

const TOKEN = () => process.env.TELEGRAM_BOT_TOKEN;

function api(method, params = {}) {
  const qs = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
  return new Promise((resolve, reject) => {
    https.get({ host: "api.telegram.org", path: `/bot${TOKEN()}/${method}?${qs}`, timeout: 20000 },
      (r) => { let d = ""; r.on("data", (c) => (d += c));
        r.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); })
      .on("error", reject);
  });
}

// Find the chat id of whoever messaged the bot, and persist it to .env.
async function discoverChatId() {
  const j = await api("getUpdates");
  const upd = (j.result || []).filter((u) => u.message && u.message.chat);
  if (!upd.length) return null;
  const id = String(upd[upd.length - 1].message.chat.id);
  const envPath = path.join(__dirname, "..", ".env");
  try {
    let env = fs.readFileSync(envPath, "utf8");
    if (/^TELEGRAM_CHAT_ID=.*$/m.test(env)) env = env.replace(/^TELEGRAM_CHAT_ID=.*$/m, `TELEGRAM_CHAT_ID=${id}`);
    else env += `\nTELEGRAM_CHAT_ID=${id}\n`;
    fs.writeFileSync(envPath, env);
  } catch (_) {}
  process.env.TELEGRAM_CHAT_ID = id;
  return id;
}

// Send a message to every recipient. TELEGRAM_CHAT_ID may be a comma-separated
// list (e.g. "123,456") so several people can receive the same alerts.
async function notify(text) {
  if (!TOKEN()) return { skipped: "no TELEGRAM_BOT_TOKEN" };
  let ids = String(process.env.TELEGRAM_CHAT_ID || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!ids.length) {
    const found = await discoverChatId();
    if (found) ids = [found];
  }
  if (!ids.length) return { error: "no chat id — message the bot once, then retry" };
  const sent = [], failed = [];
  for (const id of ids) {
    const j = await api("sendMessage", { chat_id: id, text: String(text).slice(0, 3900) });
    (j.ok ? sent : failed).push(id);
  }
  return failed.length ? { ok: sent.length > 0, sent, failed } : { ok: true, sent };
}

// List every chat that has messaged the bot (to find a new recipient's id).
async function listChats() {
  const j = await api("getUpdates");
  const seen = new Map();
  for (const u of j.result || []) {
    const m = u.message || u.edited_message;
    if (m && m.chat) seen.set(String(m.chat.id), m.chat.username || m.chat.first_name || "?");
  }
  return [...seen.entries()].map(([id, name]) => ({ id, name }));
}

module.exports = { notify, discoverChatId, listChats, api };
