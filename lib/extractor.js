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

// ---- GLOBAL GEMINI THROTTLE -----------------------------------------------------------
// The backfill runs 6 workers in parallel, each firing a ~15k-token request. That blew
// straight through Gemini's rate limit: 237 of 775 extractions (31%) failed on a real run, the
// abort guard fired, and the whole rebuild was refused. The workers exist to parallelise the
// SLOW part (Blotato transcript polling, ~60s each); Gemini is fast and rate-limited, so it
// should not be parallelised at all. One gate, shared by every worker, is the fix.
//
// This is deliberately conservative. An extraction that fails costs a whole re-run; an
// extraction that waits two seconds costs two seconds.
const GEMINI_CONCURRENCY = Number(process.env.GEMINI_CONCURRENCY || 2);
const GEMINI_MIN_GAP_MS = Number(process.env.GEMINI_MIN_GAP_MS || 1200);
let active = 0, lastStart = 0;
const waiting = [];

async function acquire() {
  if (active >= GEMINI_CONCURRENCY) await new Promise((r) => waiting.push(r));
  active++;
  const gap = Date.now() - lastStart;
  if (gap < GEMINI_MIN_GAP_MS) await sleep(GEMINI_MIN_GAP_MS - gap);
  lastStart = Date.now();
}
function release() {
  active--;
  const next = waiting.shift();
  if (next) next();
}

// ---- OUT OF CREDIT IS NOT A RATE LIMIT --------------------------------------------------
// These look identical on the wire (both arrive as 429 / RESOURCE_EXHAUSTED) and could not be
// more different in what you should DO about them:
//
//   rate-limited  -> wait, it clears on its own. Backing off is exactly right.
//   out of credit -> waiting achieves NOTHING. It clears when a human tops up the account.
//
// A real backfill died this way and I misread it as rate-limiting. With the retry policy that
// diagnosis produced, an out-of-credit run would patiently back off for up to 10 minutes PER
// VIDEO across hundreds of videos: it would burn the entire 6-hour job, produce nothing, and
// look like a slow failure rather than an obvious "your account is empty".
//
// So: if enough calls fail in a row with a credit/billing error, stop the whole run at once
// and say so in one sentence. Nothing is lost — no failure is ever cached, so a re-run after
// topping up resumes exactly where it stopped.
const BILLING_RE = /billing|payment|suspend|disabled|exceeded your current quota|insufficient|credit/i;
let consecutiveBilling = 0;

class OutOfCreditError extends Error {
  constructor(msg) { super(msg); this.outOfCredit = true; }
}

async function callGemini(system, user) {
  await acquire();
  try {
    const out = await callGeminiInner(system, user);
    consecutiveBilling = 0; // a success proves the account is alive
    return out;
  } catch (e) {
    if (e.outOfCredit) throw e;
    if (e.billingHint) {
      consecutiveBilling++;
      // 3 in a row with nothing succeeding in between: the account is out, not busy.
      if (consecutiveBilling >= 3) {
        throw new OutOfCreditError(
          "GEMINI_OUT_OF_CREDIT: " + e.message +
          " — three calls in a row failed on billing/quota with no successes in between. " +
          "Waiting will not fix this. Top up the Gemini account and re-run; nothing is lost, " +
          "because failed extractions are never cached."
        );
      }
    }
    throw e;
  } finally { release(); }
}

async function callGeminiInner(system, user) {
  const key = process.env.GEMINI_API_KEY;
  // PINNED to a specific version, NOT the "-latest" alias. On 2026-07-21 Google silently repointed
  // gemini-flash-lite-latest to Gemini 3.x, retiring thinkingBudget:0 and freezing the whole pipeline
  // for ~20h — a pinned version cannot be swapped out from under us. flash-lite is ~3x cheaper than
  // flash and gets DIRECTION right on every trap (test/test-model.js), the only thing that poisons a
  // record. 3.5-flash-lite is what -latest resolves to today, so extraction behaviour is unchanged —
  // just locked. Override with EXTRACT_MODEL; re-pin here AND in lib/evidence.js (its own fingerprint)
  // when 3.5-flash-lite is eventually retired.
  const model = process.env.EXTRACT_MODEL || "gemini-3.5-flash-lite";
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ parts: [{ text: user }] }],
    // Keep model "thinking" minimal — it otherwise eats the whole output budget on long transcripts
    // and returns an empty response. Google repointed the -latest aliases to Gemini 3.x on ~2026-07-21,
    // which RETIRED thinkingBudget:0 (the API now 400s "Request contains an invalid argument") and
    // replaced it with thinkingLevel. "low" is the Gemini-3 equivalent, verified to return complete
    // JSON (finishReason STOP, zero thought tokens) on long chunks. This 400 froze the whole pipeline.
    generationConfig: { temperature: 0, maxOutputTokens: 8192, thinkingConfig: { thinkingLevel: "low" } },
  });
  // 8 attempts with exponential backoff + jitter. The old 5 linear retries topped out at ~75s
  // of waiting, which a sustained rate-limit burst outlasts easily. This tops out at ~10 min,
  // and a request that takes 10 minutes but SUCCEEDS is infinitely better than one that fails:
  // a failure aborts the entire rebuild.
  let lastErr = "unknown";
  for (let attempt = 0; attempt < 8; attempt++) {
    const r = await httpsPost({
      host: "generativelanguage.googleapis.com",
      path: `/v1beta/models/${model}:generateContent?key=${key}`,
      method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      timeout: 120000,
    }, body).catch((e) => ({ status: 0, text: "", err: e.message }));

    // 429 = rate limited. 5xx = transient. Both are worth waiting out.
    //
    // BUT READ THE BODY FIRST. Out-of-credit ALSO arrives as a 429/RESOURCE_EXHAUSTED, and this
    // branch used to back off and `continue` before anything parsed it — which made the
    // out-of-credit guard below (BILLING_RE) unreachable for the exact status it was written for.
    // The comment above it predicted the consequence precisely, and then it happened: a depleted
    // account ("Your prepayment credits are depleted") spent ~4 minutes of backoff PER CHUNK,
    // failed all 8 attempts, and killed an 84-video run while looking like slow rate-limiting.
    // Waiting cannot fix an empty account, so the body is inspected BEFORE the backoff.
    if (r.status === 429 || r.status >= 500 || r.status === 0) {
      let msg429 = "";
      try { msg429 = (JSON.parse(r.text).error || {}).message || ""; } catch (_) {}
      if (msg429 && BILLING_RE.test(msg429)) {
        const e = new Error(`gemini billing/quota: ${msg429}`);
        e.billingHint = true;   // 3 of these in a row -> OutOfCreditError, and the run stops
        throw e;
      }
      lastErr = r.status === 429 ? `rate-limited${msg429 ? ": " + msg429.slice(0, 80) : ""}` : `http ${r.status}${r.err ? " " + r.err : ""}`;
      const backoff = Math.min(60000, 2000 * Math.pow(2, attempt)) + Math.random() * 1000;
      await sleep(backoff);
      continue;
    }
    let j;
    try { j = JSON.parse(r.text); }
    catch (_) { lastErr = `unparseable response (http ${r.status})`; await sleep(2000); continue; }
    if (j.error) {
      // A quota/rate error can also arrive as a 200 with an error body.
      const msg = j.error.message || String(r.status);
      // Out of credit: do not sit here backing off. Surface it so the caller can stop the run.
      if (BILLING_RE.test(msg)) {
        throw Object.assign(new Error("gemini: " + msg), { billingHint: true });
      }
      if (/quota|rate|exhaust|overload/i.test(msg)) {
        lastErr = msg;
        await sleep(Math.min(60000, 2000 * Math.pow(2, attempt)) + Math.random() * 1000);
        continue;
      }
      throw new Error("gemini: " + msg);
    }
    // Usage ledger: token counts from the response, estimated cost, bounded store. Never fatal.
    try {
      const u = j.usageMetadata || {};
      require("./gemini-ledger").record({ model, purpose: "extract", ok: true,
        inputTokens: u.promptTokenCount ?? null, outputTokens: u.candidatesTokenCount ?? null,
        cachedTokens: u.cachedContentTokenCount ?? null });
    } catch (_) {}
    return ((j.candidates || [])[0]?.content?.parts || []).map((p) => p.text || "").join("");
  }
  // Exhausted the retries on a 429. If the account is empty this is what it looks like from
  // here, so tag it: three of these in a row with no success between them means out of credit.
  try { require("./gemini-ledger").record({ model, purpose: "extract", ok: false, error: lastErr }); } catch (_) {}
  throw Object.assign(new Error(`gemini: gave up after 8 attempts (${lastErr})`),
    { billingHint: /rate-limited|quota|exhaust/i.test(lastErr) });
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
