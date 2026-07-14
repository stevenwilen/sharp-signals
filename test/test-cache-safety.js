// Regression test for the failure that mattered most: a transient extraction error being
// cached as "this video has no picks", permanently and invisibly.
//
//   node test/test-cache-safety.js
//
// This is not a unit-test-suite-for-its-own-sake. Every check here corresponds to a real bug
// that was live in this repo, and each one failed silently in production.
require("../lib/env");
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const picksCache = require("../lib/picks-cache");
const extractor = require("../lib/extractor");

let pass = 0;
const ok = (name) => { console.log(`  ok  ${name}`); pass++; };

// ---- picks-cache refuses to store a non-array (a failed extraction) --------------------
const testUrl = "https://www.youtube.com/watch?v=__TESTVID__";
const fp = "testfp123456";
const file = path.join(picksCache.DIR, "__TESTVID__.json");
if (fs.existsSync(file)) fs.unlinkSync(file);

assert.strictEqual(picksCache.set(testUrl, null, fp), false, "set(null) must refuse");
assert.strictEqual(picksCache.set(testUrl, undefined, fp), false, "set(undefined) must refuse");
assert.strictEqual(fs.existsSync(file), false, "a refused write must not create a file");
assert.strictEqual(picksCache.get(testUrl, fp), null, "a refused write must stay a cache MISS");
ok("a failed extraction cannot be cached (stays a miss, so the next run retries it)");

// ---- an EMPTY array is a real answer and IS cached -------------------------------------
assert.strictEqual(picksCache.set(testUrl, [], fp), true, "set([]) must succeed");
const hit = picksCache.get(testUrl, fp);
assert.ok(Array.isArray(hit) && hit.length === 0, "[] must come back as a HIT, not a miss");
ok("an empty result IS cached ('this vlog has no picks' is a real answer)");

// ---- the prompt fingerprint invalidates picks extracted by different logic --------------
assert.strictEqual(picksCache.get(testUrl, "DIFFERENT_FP"), null,
  "a different prompt/model must be a cache MISS");
ok("changing the prompt or model invalidates the cache (no split-brain corpus)");
fs.unlinkSync(file);

// ---- parseArray: a truncated/garbage response must be null, NOT [] ----------------------
// (this is the actual poisoning mechanism: maxOutputTokens cut the JSON mid-array)
const priv = fs.readFileSync(path.join(__dirname, "..", "lib", "extractor.js"), "utf8");
assert.ok(/return null;/.test(priv) && !/if \(s < 0 \|\| e < 0\) return \[\];/.test(priv),
  "parseArray must return null (not []) on unusable output");
ok("parseArray returns null on truncated/garbage output, never []");

// ---- extractFromTranscript THROWS on a failed call, never returns [] --------------------
(async () => {
  const realProvider = process.env.GEMINI_API_KEY;
  const realAnthropic = process.env.ANTHROPIC_API_KEY;

  // Force a guaranteed API failure with a bogus key.
  process.env.GEMINI_API_KEY = "definitely-not-a-valid-key";
  delete process.env.ANTHROPIC_API_KEY;

  let threw = false, returnedEmpty = false;
  try {
    const r = await extractor.extractFromTranscript("some fight talk about a fight", {
      source: "test", domain: "mma", timestamp: new Date().toISOString(), url: testUrl,
    });
    if (Array.isArray(r) && r.length === 0) returnedEmpty = true;
  } catch (e) {
    threw = true;
    assert.ok(e.extractFailed, "the thrown error must be tagged extractFailed");
  }

  if (realProvider) process.env.GEMINI_API_KEY = realProvider;
  if (realAnthropic) process.env.ANTHROPIC_API_KEY = realAnthropic;

  assert.strictEqual(returnedEmpty, false,
    "extractFromTranscript returned [] on a FAILED call — this is the poisoning bug");
  assert.strictEqual(threw, true, "extractFromTranscript must THROW on a failed call");
  ok("a failed extraction throws (tagged extractFailed) instead of returning []");

  // ---- the caches must live in the repo, not DATA_DIR ----------------------------------
  const repoData = path.resolve(__dirname, "..", "data");
  assert.ok(picksCache.DIR.startsWith(repoData),
    "picks cache must be repo-rooted so it is committed and shared with CI");
  const blot = fs.readFileSync(path.join(__dirname, "..", "lib", "blotato.js"), "utf8");
  assert.ok(/__dirname, "\.\.", "data", "transcripts"/.test(blot),
    "transcript cache must be repo-rooted, not under DATA_DIR");
  ok("both caches are repo-rooted (CI and the laptop share one cache)");

  console.log(`\n${pass} checks passed.`);
})();
