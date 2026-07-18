// AUTOMATIC RESEARCH (§1). Replaces the human verify-news step for routine operation: over the sources
// the cloud already collected, plus — behind a feature flag — a grounded web search, it reconstructs
// lineage, searches for confirmation and contradiction, and hands the result to the assessor.
//
// THE ONE INVARIANT THIS FILE PROTECTS: a search NEVER asserts origins. Whatever a grounded model
// "finds," it produces candidate SOURCES (outlet, url, quote, publishedAt, who-actually-knew-it); those
// go through the SAME origin counter the whole system uses (verified-news.countOrigins), where ten
// outlets citing one reporter collapse to one origin. A search SUMMARY — prose with no checkable source
// — is not a source and can never be an origin. Verification ADDS origins; it cannot ASSERT them.
//
// Grounded web search is OFF unless INTEL_WEB_SEARCH=1 (and a key exists). In shadow mode it never runs.
require("./env");
const https = require("https");
const VN = require("./verified-news");

const OFFICIAL = /official|commission|athletic commission|ufc\b|promotion|primary|weigh.?in results|usada|vada/i;
const ref = (s) => ({ outlet: s.outlet, origin: s.origin, url: s.url, quote: s.quote, publishedAt: s.publishedAt, sourceType: s.sourceType || null, stance: s.stance || null });

// The default provider: grounded Gemini search, gated by the flag. Returns { enabled, results[], summary,
// inaccessible?, error? }. It NEVER returns an origin count — only candidate sources.
async function geminiGroundedProvider(record, opts = {}) {
  if (process.env.INTEL_WEB_SEARCH !== "1") return { enabled: false, results: [], reason: "INTEL_WEB_SEARCH not set" };
  if (!process.env.GEMINI_API_KEY) return { enabled: false, results: [], reason: "no GEMINI_API_KEY" };
  try {
    return await callGrounded(record, opts);
  } catch (e) {
    // A failed web search is a genuine access failure — surface it as inaccessible so the record can be
    // routed to HUMAN_ACTION_REQUIRED rather than silently treated as "nothing found."
    return { enabled: true, results: [], error: String(e && e.message || e), inaccessible: "grounded web search failed" };
  }
}

// Best-effort grounded call. Dormant in shadow mode (flag off), so it is defensive rather than clever:
// it asks for a JSON list of checkable sources with the person who actually knew each fact, and parses
// leniently. Any shape problem degrades to "no results", never a throw that stops the pipeline.
function callGrounded(record, opts) {
  const key = process.env.GEMINI_API_KEY;
  const model = process.env.INTEL_SEARCH_MODEL || "gemini-2.5-flash";
  const prompt = [
    `Research this MMA report and return ONLY checkable sources. Report: "${record.claim}" about ${record.fighter}.`,
    `For each source give JSON: {outlet, origin (the PERSON who actually knew this, not who republished), url, quote (>=12 chars), publishedAt (ISO), stance ("supports"|"refutes"|"unrelated"), sourceType}.`,
    `Do NOT summarize instead of citing. Ten outlets citing one reporter is ONE origin — name that reporter as origin.`,
    `Return {"sources":[...], "summary":"one sentence"}.`,
  ].join(" ");
  const body = JSON.stringify({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    tools: [{ google_search: {} }],
    generationConfig: { temperature: 0 },
  });
  return new Promise((resolve) => {
    const req = https.request({
      host: "generativelanguage.googleapis.com",
      path: `/v1beta/models/${model}:generateContent?key=${key}`,
      method: "POST", headers: { "Content-Type": "application/json" }, timeout: 30000,
    }, (r) => {
      let d = ""; r.on("data", (c) => (d += c));
      r.on("end", () => {
        try {
          const j = JSON.parse(d);
          const text = (((j.candidates || [])[0] || {}).content || {}).parts?.map((p) => p.text).join("") || "";
          const m = text.match(/\{[\s\S]*\}/);
          const parsed = m ? JSON.parse(m[0]) : { sources: [], summary: null };
          resolve({ enabled: true, results: parsed.sources || [], summary: parsed.summary || null });
        } catch (e) { resolve({ enabled: true, results: [], error: "parse failed", inaccessible: "grounded web search unparseable" }); }
      });
    });
    req.on("error", () => resolve({ enabled: true, results: [], error: "request failed", inaccessible: "grounded web search failed" }));
    req.on("timeout", () => { req.destroy(); resolve({ enabled: true, results: [], error: "timeout", inaccessible: "grounded web search timed out" }); });
    req.write(body); req.end();
  });
}

// RESEARCH one record. opts: { seal (ISO/ms), provider (async, default grounded Gemini), inaccessible }.
async function research(record, opts = {}) {
  const provider = opts.provider || geminiGroundedProvider;
  const sealMs = typeof opts.seal === "number" ? opts.seal : (opts.seal ? Date.parse(opts.seal) : NaN);
  const web = await provider(record, opts) || { enabled: false, results: [] };

  const candidates = (web.results || []).filter(Boolean);
  // A candidate is a SOURCE only if it is checkable (real url, a quote, a date, and a named origin).
  // Everything else — including a prose "summary" — is dropped and can never contribute an origin.
  const valid = [], droppedNonSources = [];
  for (const c of candidates) (VN.validateSource(c, 0).length ? droppedNonSources : valid).push(c);

  // Leakage: a source at or after the seal is information from the future, not evidence.
  const leaked = [], admissible = [];
  for (const s of valid) (Number.isFinite(sealMs) && Date.parse(s.publishedAt) >= sealMs ? leaked : admissible).push(s);

  const supporting = admissible.filter((s) => s.stance === "supports");
  const refuting = admissible.filter((s) => s.stance === "refutes");
  // THE COUNTER — not the model — decides how many independent origins these are.
  const supportOrigins = VN.countOrigins(supporting);
  const refuteOrigins = VN.countOrigins(refuting);

  const verdictHint = refuting.some((s) => OFFICIAL.test(s.sourceType || "") || OFFICIAL.test(s.outlet || "")) ? "disproved"
    : supporting.some((s) => OFFICIAL.test(s.sourceType || "") || OFFICIAL.test(s.outlet || "")) ? "confirmed" : null;

  const inaccessible = opts.inaccessible || web.inaccessible || (web.error ? `research error: ${web.error}` : null) || null;

  return {
    webEnabled: web.enabled === true,
    searchSummaries: web.summary ? [String(web.summary)] : [],
    droppedNonSources: droppedNonSources.length,   // summaries / uncheckable — NEVER origins
    leakedDropped: leaked.length,
    addedSupportingOrigins: supportOrigins.count,   // counted, not asserted — 10 outlets/1 reporter = 1
    addedSupportingOriginIds: supportOrigins.originIds,
    amplifiedOnly: supportOrigins.amplified,
    refutingOrigins: refuteOrigins.count,
    confirmations: supporting.map(ref),
    contradictions: refuting.map(ref),
    disproofs: verdictHint === "disproved" ? refuting.map(ref) : [],
    sourcesUsed: admissible.map(ref),   // url + publishedAt + origin preserved — full lineage
    verdictHint, inaccessible,
  };
}

// Map a research result to the assessor's external-evidence opts (§3) and to the classifier's
// unreachable flag (§5 HUMAN_ACTION_REQUIRED — only for a genuine access failure).
function toAssessOpts(result) {
  return { confirmed: result.verdictHint === "confirmed", disproved: result.verdictHint === "disproved" };
}

// Attach research findings to a record (lineage preserved) without recomputing origins on the record.
function attachResearch(record, result) {
  return {
    ...record,
    confirmations: [...(record.confirmations || []), ...result.confirmations],
    contradictions: [...new Set([...(record.contradictions || []), ...result.contradictions.map((c) => c.url)])],
    disproofs: [...(record.disproofs || []), ...result.disproofs],
    researchSources: [...(record.researchSources || []), ...result.sourcesUsed],
    researchSummaries: [...(record.researchSummaries || []), ...result.searchSummaries],
    inaccessible: result.inaccessible || record.inaccessible || null,
  };
}

module.exports = { research, geminiGroundedProvider, toAssessOpts, attachResearch, OFFICIAL };
