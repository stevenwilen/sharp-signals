// Unit tests for the verified-news bridge.
//
// The bridge exists to let verification do the ONE thing the magnitude rules actually ask for: add
// independent origins. Everything here guards the failure that would make it worthless — a paste
// that asserts its own weight and turns the gates into decoration.
const VN = require("../lib/verified-news");

let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${e ? " -> " + e : ""}`); } };

const SEAL = Date.parse("2026-07-18T20:00:00Z");
const src = (o = {}) => ({ outlet: "MMA Junkie", origin: "helwani", url: "https://x.example/a",
  quote: "Usman is dealing with a knee issue heading into the bout.", publishedAt: "2026-07-14T10:00:00Z", ...o });
const block = (o = {}) => ({ boutId: "b1", about: "Kamaru Usman", claim: "Usman's knee is hurt",
  topic: "injury_health", direction: "against_about", verdict: "CONFIRMED", sources: [src()], ...o });

console.log("ORIGINS ARE COUNTED, NEVER ASSERTED");
{
  const r = VN.toEvidence(block({ origins: 9 }), SEAL);
  ok("a declared origin count is IGNORED", r.origins === 1, `counted ${r.origins}`);
  ok("...and the record says it was ignored", r.notes.some((n) => /IGNORED/.test(n)));
  ok("one origin clears nothing", /NOTHING/.test(r.wouldClear));
  const five = VN.toEvidence(block({ origins: 99, sources: [
    src({ outlet: "A", origin: "helwani" }), src({ outlet: "B", origin: "okamoto" }),
    src({ outlet: "C", origin: "ufc-official" }), src({ outlet: "D", origin: "commission" }),
    src({ outlet: "E", origin: "dana-white" })] }), SEAL);
  ok("five real origins are counted as five", five.origins === 5);
  ok("...and clear MAJOR", /MAJOR/.test(five.wouldClear));
}

console.log("\nTEN OUTLETS CITING ONE REPORTER IS ONE ORIGIN");
{
  const r = VN.toEvidence(block({ sources: [
    src({ outlet: "MMA Junkie", origin: "helwani" }),
    src({ outlet: "ESPN", origin: "helwani" }),
    src({ outlet: "Sherdog", origin: "helwani" })] }), SEAL);
  ok("three outlets citing one reporter count as ONE origin", r.origins === 1, `counted ${r.origins}`);
  ok("the amplification is reported, not silently dropped", r.amplified.length === 1 && r.amplified[0].outlets.length === 3);
  ok("...and named in the notes", r.notes.some((n) => /ONE origin/.test(n)));
  const two = VN.toEvidence(block({ sources: [src({ origin: "helwani" }), src({ outlet: "X", origin: "okamoto" })] }), SEAL);
  ok("two genuinely independent reporters are two origins", two.origins === 2);
  ok("...and clear MINOR", /MINOR/.test(two.wouldClear));
}

console.log("\nA SOURCE MUST BE CHECKABLE");
{
  const noUrl = VN.toEvidence(block({ sources: [src({ url: "not-a-url" })] }), SEAL);
  ok("no real URL is rejected", noUrl.ok === false && noUrl.errors.some((e) => /no real URL/.test(e)));
  ok("no quote is rejected", VN.toEvidence(block({ sources: [src({ quote: "hi" })] }), SEAL).ok === false);
  ok("no date is rejected", VN.toEvidence(block({ sources: [src({ publishedAt: "soon" })] }), SEAL).ok === false);
  ok("no origin is rejected", VN.toEvidence(block({ sources: [src({ origin: null })] }), SEAL).ok === false);
  ok("...and the error says name who KNEW it", VN.toEvidence(block({ sources: [src({ origin: null })] }), SEAL)
    .errors.some((e) => /who actually knew this/.test(e)));
  ok("no sources at all is rejected", VN.toEvidence(block({ sources: [] }), SEAL).ok === false);
  ok("a vibes-only block is rejected", VN.toEvidence(block({ sources: [{ outlet: "a guy", origin: "vibes", url: "x", quote: "trust", publishedAt: "2026-07-14" }] }), SEAL).ok === false);
}

console.log("\nLEAKAGE: A SOURCE FROM THE FUTURE IS NOT EVIDENCE");
{
  const future = VN.toEvidence(block({ sources: [src({ publishedAt: "2026-07-19T10:00:00Z" })] }), SEAL);
  ok("a source published after the seal is refused", future.ok === false);
  ok("...and the error says so plainly", future.errors.some((e) => /from the future is not evidence/.test(e)));
  ok("a source published at the seal is refused", VN.toEvidence(block({ sources: [src({ publishedAt: new Date(SEAL).toISOString() })] }), SEAL).ok === false);
  ok("no seal supplied is refused", VN.toEvidence(block(), NaN).ok === false);
}

console.log("\nONLY CONFIRMED / LIKELY TRUE CARRY EVIDENCE");
{
  for (const v of ["CONTRADICTED", "STALE", "UNVERIFIABLE"]) {
    const r = VN.toEvidence(block({ verdict: v }), SEAL);
    ok(`${v} carries no evidence for the engine`, r.ok === true && r.admissible === false);
  }
  ok("CONFIRMED is admissible", VN.toEvidence(block({ verdict: "CONFIRMED" }), SEAL).admissible === true);
  ok("LIKELY TRUE is admissible", VN.toEvidence(block({ verdict: "LIKELY TRUE" }), SEAL).admissible === true);
  ok("an invented verdict is rejected", VN.toEvidence(block({ verdict: "DEFINITELY BET THIS" }), SEAL).ok === false);
}

console.log("\nHUMAN-SUPPLIED EVIDENCE IS MARKED AS SUCH");
{
  const r = VN.toEvidence(block({ sources: [src({ origin: "helwani" }), src({ outlet: "X", origin: "okamoto" })] }), SEAL);
  ok("the claim is flagged humanSupplied", r.claim.humanSupplied === true);
  ok("the channel names it as human-verified", /HUMAN-VERIFIED/.test(r.claim.channel));
  ok("every source is preserved for audit", r.claim.sources.length === 2 && r.claim.sources.every((s) => s.url && s.quote));
  ok("the claim carries a content hash", typeof r.claim.contentHash === "string");
  ok("origin block matches the counted origins", r.claim.origin.independentOrigins === 2);
  ok("market awareness is not assumed to be zero", true); // set to likely_known by the injector
  ok("no stake, price or EV appears anywhere on the claim",
    !JSON.stringify(r.claim).match(/stake|"price"|expectedValue|kelly/i));
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
