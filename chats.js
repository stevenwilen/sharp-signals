// Show every Telegram chat that has messaged the bot, so you can add recipients.
//   1) each person sends any message to the bot (@claude3k_bot)
//   2) node chats.js
//   3) put the ids in .env, comma-separated:  TELEGRAM_CHAT_ID=111,222
require("./lib/env");
const { listChats } = require("./lib/notify");
(async () => {
  const chats = await listChats();
  if (!chats.length) return console.log("No chats yet — message the bot once, then re-run.");
  console.log("Chats that have messaged the bot:");
  for (const c of chats) console.log(`  ${c.id}  (${c.name})`);
  console.log(`\nTELEGRAM_CHAT_ID=${chats.map((c) => c.id).join(",")}`);
})();
