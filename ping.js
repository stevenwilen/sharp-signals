// Send an ad-hoc Telegram update:  node ping.js "message"
require("./lib/env");
const { notify } = require("./lib/notify");
(async () => {
  const msg = process.argv.slice(2).join(" ") || "(no message)";
  const r = await notify(msg);
  console.log(JSON.stringify(r));
})();
