// Minimal .env loader (no dependency) + key-presence helpers.
const fs = require("fs");
const path = require("path");

function loadEnv() {
  const file = path.join(__dirname, "..", ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
      v = v.slice(1, -1);
    if (process.env[m[1]] === undefined && v !== "") process.env[m[1]] = v;
  }
}
loadEnv();

const have = (k) => !!(process.env[k] && process.env[k].trim());

// Report which capabilities are unlocked by the keys currently present.
function capabilities() {
  return {
    kalshiMarketReads: true, // always (public)
    kalshiTrading: have("KALSHI_KEY_ID") && have("KALSHI_PRIVATE_KEY_PATH"),
    extractPredictions: have("GEMINI_API_KEY") || have("ANTHROPIC_API_KEY"),
    extractProvider: have("GEMINI_API_KEY") ? "gemini (free)" : have("ANTHROPIC_API_KEY") ? "claude" : "none",
    pullTwitter: have("TWITTERAPI_KEY"),
    pullYouTube: have("YOUTUBE_API_KEY"),
    transcripts: have("BLOTATO_API_KEY"),
    transcribe: have("ASSEMBLYAI_KEY"),
  };
}

module.exports = { loadEnv, have, capabilities };
