// Prediction extractor via the Claude Messages API.
// Turns a raw social post/transcript into structured picks. Needs ANTHROPIC_API_KEY.
require("./env");
const https = require("https");

const MODEL = process.env.EXTRACT_MODEL || "claude-haiku-4-5-20251001";

function callClaude({ system, user, maxTokens = 1024, model = MODEL }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return Promise.reject(new Error("NO_KEY: set ANTHROPIC_API_KEY in .env"));
  const body = JSON.stringify({
    model, max_tokens: maxTokens, system,
    messages: [{ role: "user", content: user }],
  });
  const opts = {
    host: "api.anthropic.com", path: "/v1/messages", method: "POST",
    headers: {
      "x-api-key": key, "anthropic-version": "2023-06-01",
      "content-type": "application/json", "content-length": Buffer.byteLength(body),
    }, timeout: 60000,
  };
  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      let d = ""; res.on("data", (c) => (d += c));
      res.on("end", () => {
        try {
          const j = JSON.parse(d);
          if (j.error) return reject(new Error(j.error.message || "claude error"));
          resolve((j.content || []).map((b) => b.text || "").join(""));
        } catch (e) { reject(new Error("bad response: " + d.slice(0, 200))); }
      });
    });
    req.on("error", reject); req.on("timeout", () => req.destroy(new Error("timeout")));
    req.write(body); req.end();
  });
}

const SYSTEM = `You extract prediction-market signals from combat-sports (UFC/boxing) social posts.
Given ONE post, return a JSON array (possibly empty) of predictions it makes about a fight OUTCOME.
Each item: {"pick": "<competitor the author favors to WIN>", "opponent": "<other competitor or null>",
"event": "<event/date hint or null>", "confidence": <0..1 how strongly they back the pick>,
"quote": "<short supporting snippet>"}.
Rules: only OUTCOME predictions (who wins), not method/round talk. If the post hedges or makes no pick, return [].
Return ONLY the JSON array, nothing else.`;

function parseArray(text) {
  const s = text.indexOf("["), e = text.lastIndexOf("]");
  if (s < 0 || e < 0) return [];
  try { return JSON.parse(text.slice(s, e + 1)); } catch (_) { return []; }
}

// posts: [{ source, domain, timestamp, url, text }] -> [prediction...]
async function extractPredictions(posts, { model = MODEL } = {}) {
  const out = [];
  for (const post of posts) {
    let items = [];
    try {
      const text = await callClaude({ system: SYSTEM, user: post.text, model });
      items = parseArray(text);
    } catch (e) {
      if (String(e.message).startsWith("NO_KEY")) throw e; // surface missing key
      continue; // skip a post that errored
    }
    for (const it of items) {
      if (!it || !it.pick) continue;
      out.push({
        source: post.source, domain: post.domain,
        pick: it.pick, opponent: it.opponent || null, event: it.event || null,
        confidence: typeof it.confidence === "number" ? it.confidence : null,
        quote: it.quote || "", timestamp: post.timestamp, url: post.url || null,
      });
    }
  }
  return out;
}

module.exports = { extractPredictions, callClaude, MODEL };
