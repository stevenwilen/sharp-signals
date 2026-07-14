// Provider-agnostic prediction extractor. Uses Gemini (free tier) if GEMINI_API_KEY
// is set, else Claude if ANTHROPIC_API_KEY. Same input/output either way.
require("./env");
const https = require("https");

// DIRECTION is the failure mode that matters. Naive "capture implicit leans" prompting
// inverts the pick: it sees negative talk ABOUT fighter A and tags A as the pick, when the
// author actually favours A's opponent. A backwards pick is far worse than a missing one —
// it poisons the track records. Hence this rule is stated first and hard.
const DIRECTION_RULE = `
DIRECTION IS THE MOST IMPORTANT THING — GET IT RIGHT.
"pick" = the competitor the author expects to WIN. It is NOT simply the person they mention.
  - "His body is gone" (said about A)        -> pick = A's OPPONENT (they think A loses)
  - "A looked awful in camp"                 -> pick = A's OPPONENT
  - "I don't see how A gets out of round 2"  -> pick = A's OPPONENT
  - "B at +250 is free money"                -> pick = B
If you cannot confidently name WHO THEY THINK WINS, omit the item. A wrong direction is far worse
than a missing pick.`;

const SYSTEM = `You extract prediction-market signals from combat-sports (UFC/boxing) social posts.
Capture BOTH kinds of signal:
 (a) EXPLICIT picks — "I'm taking Usman", "Holloway by TKO", "my pick is X".
 (b) IMPLICIT LEANS — the author reveals who they favour without a formal pick: value/odds talk
     ("+250 is free money", "the market is sleeping on his wrestling"), matchup/style reads,
     camp/form intel, or a hedged lean ("I lean Holloway"). These ARE signals — keep them.
${DIRECTION_RULE}
For each signal return: {"i": <post index>, "pick": "<who they expect to WIN>",
"opponent": "<other competitor or null>", "event": "<event/date hint or null>",
"directness": "explicit" | "implicit", "confidence": <0..1 how strongly they back it>,
"quote": "<short supporting snippet>"}.
Ignore pure hype/insults with no directional view, and method/round-only talk with no winner.
Return ONLY a single JSON array for all posts, nothing else.`;

function httpsPost(opts, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      let d = ""; res.on("data", (c) => (d += c));
      res.on("end", () => resolve({ status: res.statusCode, text: d }));
    });
    req.on("error", reject); req.on("timeout", () => req.destroy(new Error("timeout")));
    req.write(body); req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Free tier is ~10 req/min — retry with backoff on 429 instead of failing silently.
async function callGemini(system, user) {
  const key = process.env.GEMINI_API_KEY;
  const model = process.env.EXTRACT_MODEL || "gemini-flash-latest";
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ parts: [{ text: user }] }],
    // thinkingBudget:0 is REQUIRED — flash "thinking" otherwise consumes the whole
    // output budget on long transcripts and returns an empty response.
    generationConfig: { temperature: 0, maxOutputTokens: 8192, thinkingConfig: { thinkingBudget: 0 } },
  });
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await httpsPost({
      host: "generativelanguage.googleapis.com",
      path: `/v1beta/models/${model}:generateContent?key=${key}`,
      method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      timeout: 120000,
    }, body);
    if (r.status === 429) { await sleep(15000 * (attempt + 1)); continue; } // backoff
    const j = JSON.parse(r.text);
    if (j.error) throw new Error("gemini: " + (j.error.message || r.status));
    return ((j.candidates || [])[0]?.content?.parts || []).map((p) => p.text || "").join("");
  }
  throw new Error("gemini: rate-limited after retries");
}

async function callClaude(system, user) {
  const key = process.env.ANTHROPIC_API_KEY;
  const model = process.env.EXTRACT_MODEL || "claude-haiku-4-5-20251001";
  const body = JSON.stringify({ model, max_tokens: 2048, system, messages: [{ role: "user", content: user }] });
  const r = await httpsPost({
    host: "api.anthropic.com", path: "/v1/messages", method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01",
      "content-type": "application/json", "content-length": Buffer.byteLength(body) },
    timeout: 60000,
  }, body);
  const j = JSON.parse(r.text);
  if (j.error) throw new Error("claude: " + (j.error.message || r.status));
  return (j.content || []).map((b) => b.text || "").join("");
}

function provider() {
  const pref = process.env.EXTRACT_PROVIDER;
  if (pref === "gemini" || (!pref && process.env.GEMINI_API_KEY)) return { name: "gemini", call: callGemini };
  if (process.env.ANTHROPIC_API_KEY) return { name: "claude", call: callClaude };
  if (process.env.GEMINI_API_KEY) return { name: "gemini", call: callGemini };
  return null;
}

// Returns an array, or NULL when the output was not a usable JSON array.
//
// THIS DISTINCTION IS LOAD-BEARING. `[]` means "the model read the transcript and found no
// picks" — a real answer, worth caching. `null` means "we never got an answer" (truncated at
// maxOutputTokens, safety-blocked, 5xx HTML body, empty candidates). Returning [] for the
// second case is indistinguishable from the first, and once the picks-cache writes it to
// disk and commits it, that video is blank FOREVER — no TTL, no retry. One Gemini hiccup
// during fight week would permanently erase a 14-pick card breakdown and nobody would know.
function parseArray(text) {
  const s = String(text ?? "").indexOf("["), e = String(text ?? "").lastIndexOf("]");
  if (s < 0 || e < 0 || e < s) return null;
  try {
    const j = JSON.parse(String(text).slice(s, e + 1));
    return Array.isArray(j) ? j : null;
  } catch (_) { return null; }
}

// Cache key ingredient. If the prompt or the model changes, previously-cached picks were
// derived by DIFFERENT logic and must not be silently reused — that would leave the corpus
// permanently split-brain (old videos on the old DIRECTION_RULE, new ones on the new).
function promptFingerprint() {
  const model = process.env.EXTRACT_MODEL || "gemini-flash-latest";
  return require("crypto").createHash("sha1")
    .update(TRANSCRIPT_SYSTEM + "|" + model).digest("hex").slice(0, 12);
}

// Models sometimes return confidence as "high"/"medium"/"low" instead of 0..1.
const CONF_WORDS = { high: 0.75, strong: 0.75, medium: 0.62, moderate: 0.62, low: 0.55, lean: 0.55, slight: 0.55 };
function normConf(c) {
  if (typeof c === "number" && c >= 0 && c <= 1) return c;
  if (typeof c === "string") {
    const k = c.trim().toLowerCase();
    if (CONF_WORDS[k] != null) return CONF_WORDS[k];
    const n = parseFloat(k);
    if (!isNaN(n) && n >= 0 && n <= 1) return n;
    if (!isNaN(n) && n > 1 && n <= 100) return n / 100;
  }
  return null;
}

// posts: [{source,domain,timestamp,url,text}] -> [prediction...]  (batched)
async function extractPredictions(posts, { batchSize = 10, batchDelayMs = 0, log = () => {} } = {}) {
  const p = provider();
  if (!p) throw new Error("NO_KEY: set GEMINI_API_KEY (free) or ANTHROPIC_API_KEY in .env");
  const out = [];
  const total = Math.ceil(posts.length / batchSize);
  for (let b = 0; b < posts.length; b += batchSize) {
    if (b > 0 && batchDelayMs) await new Promise((r) => setTimeout(r, batchDelayMs));
    log(`  extract batch ${b / batchSize + 1}/${total}`);
    const batch = posts.slice(b, b + batchSize);
    const user = batch.map((x, i) => `POST ${i}: ${x.text}`).join("\n\n");
    let items = null;
    try { items = parseArray(await p.call(SYSTEM, user)); } catch (e) {
      if (String(e.message).startsWith("NO_KEY")) throw e;
      log(`  extract batch failed: ${e.message}`);
      continue;
    }
    if (items === null) { log(`  extract batch returned unusable output — skipped`); continue; }
    for (const it of items) {
      const post = batch[it.i] || batch[0];
      if (!it || !it.pick || !post) continue;
      out.push({ source: post.source, domain: post.domain, pick: it.pick,
        opponent: it.opponent || null, event: it.event || null,
        directness: it.directness === "implicit" ? "implicit" : "explicit",
        confidence: normConf(it.confidence),
        quote: it.quote || "", timestamp: post.timestamp, url: post.url || null });
    }
  }
  return out;
}

const TRANSCRIPT_SYSTEM = `You are given a TRANSCRIPT of a combat-sports (UFC/boxing) prediction video or podcast.
Extract EVERY fight-outcome view the speaker expresses across the whole card — BOTH:
 (a) EXPLICIT picks — "I'm going with X", "X by TKO".
 (b) IMPLICIT LEANS — they reveal who they favour without a formal pick: value/odds talk
     ("X at +250 is free money"), matchup/style reads, camp/form intel, or a hedged lean
     ("I lean X"). These ARE signals — keep them.
${DIRECTION_RULE}
Return a JSON array; each item: {"pick": "<who they expect to WIN>", "opponent": "<other or null>",
"directness": "explicit" | "implicit", "confidence": <0..1 how strongly>, "quote": "<short snippet>"}.
Ignore method/round-only talk with no winner, and fights where they truly decline to lean either way.
Return ONLY the JSON array.`;

// Extract all picks from a long transcript. meta = { source, domain, timestamp, url }.
//
// THROWS on failure (tagged `extractFailed`). It must never return [] for a failed call —
// callers cache the result permanently, so a swallowed error becomes permanent data loss.
// A genuine "no picks in this video" still returns [], and that IS cacheable.
async function extractFromTranscript(text, meta) {
  const p = provider();
  if (!p) throw new Error("NO_KEY: set GEMINI_API_KEY (free) or ANTHROPIC_API_KEY in .env");
  let items;
  try { items = parseArray(await p.call(TRANSCRIPT_SYSTEM, String(text).slice(0, 200000))); }
  catch (e) {
    if (String(e.message).startsWith("NO_KEY")) throw e;
    throw Object.assign(new Error("EXTRACT_FAILED: " + e.message), { extractFailed: true });
  }
  if (items === null) {
    throw Object.assign(new Error("EXTRACT_FAILED: model returned no usable JSON array"),
      { extractFailed: true });
  }
  return items.filter((it) => it && it.pick).map((it) => ({
    source: meta.source, domain: meta.domain, pick: it.pick, opponent: it.opponent || null,
    directness: it.directness === "implicit" ? "implicit" : "explicit",
    confidence: normConf(it.confidence),
    quote: it.quote || "", timestamp: meta.timestamp, url: meta.url || null,
  }));
}

module.exports = { extractPredictions, extractFromTranscript, provider, promptFingerprint,
  SYSTEM, TRANSCRIPT_SYSTEM };
