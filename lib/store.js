// JSON persistence for the pipeline's data files.
//
// DATA_DIR (in .env) lets several machines share one results folder — e.g. point both
// installs at a synced cloud folder (OneDrive/Dropbox/Drive). Then whoever runs the bot
// writes there, and the other person's dashboard (which polls every 8s) updates itself.
//   Windows path from WSL:  DATA_DIR=/mnt/c/Users/steve/OneDrive/SharpSignals-data
//   Native Windows:         DATA_DIR=C:\Users\steve\OneDrive\SharpSignals-data
require("./env");
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const DATA = process.env.DATA_DIR && process.env.DATA_DIR.trim()
  ? path.resolve(process.env.DATA_DIR.trim())
  : path.join(ROOT, "data");
if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true });

const paths = {
  root: ROOT, data: DATA,
  config: path.join(ROOT, "config.json"),
  sources: path.join(ROOT, "sources.json"),
  rawPosts: path.join(DATA, "raw_posts.json"),         // pulled social posts
  predictions: path.join(DATA, "predictions.json"),    // extracted structured picks
  graded: path.join(DATA, "sources_graded.json"),      // per-source track records
  signals: path.join(DATA, "signals.json"),            // ranked live signals
};

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return fallback; }
}
function writeJson(file, obj) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}
module.exports = { paths, readJson, writeJson };
