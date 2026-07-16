// Unit tests for the market-baseline waterfall.
//
// These are the cases that produce a plausible-but-wrong price. A baseline that is merely usually
// right is a liability: it is the prior every forecast is measured against, so a silent error here
// looks like system skill rather than a data bug. Each test below asserts a REFUSAL or an explicit
// label, never a best guess.
const M = require("../lib/market-baseline");

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? " -> " + extra : ""}`); } };

const BOUT = { boutId: "b1", a: { name: "Alice Ace", norm: "alice ace" }, b: { name: "Bob Bruiser", norm: "bob bruiser" } };
const T0 = Date.parse("2026-07-11T20:00:00Z");           // forecast timestamp
const H = 3600 * 1000;
const q = (o) => ({ book: "DK", fighterA: "Alice Ace", fighterB: "Bob Bruiser", mlA: "-150", mlB: "+130", observedAt: T0 - H, ...o });
const snap = (quotes) => ({ quotes });
// a BFO-shaped fight row: mls = [open, close-low, close-high]
const hit = (aMls, bMls) => ({ me: { name: "Alice Ace", mls: aMls, closeProb: 0.6 }, opp: { name: "Bob Bruiser", mls: bMls, closeProb: 0.45 }, ft: {} });

console.log("DE-VIG CORRECTNESS");
{
  // -150 => 0.60, +130 => 0.4348. overround 1.0348. fair A = 0.60/1.0348 = 0.5798
  const pA = M.parseAmerican("-150"), pB = M.parseAmerican("+130");
  ok("−150 parses to 0.600", Math.abs(pA - 0.6) < 1e-9, String(pA));
  ok("+130 parses to 0.4348", Math.abs(pB - 0.434783) < 1e-5, String(pB));
  const dv = M.deVig(pA, pB);
  ok("overround = sum of vig-included probs", Math.abs(dv.overround - (pA + pB)) < 1e-12);
  ok("de-vigged sides sum to exactly 1", Math.abs(dv.probA + dv.probB - 1) < 1e-12);
  ok("de-vigged A = 0.5798", Math.abs(dv.probA - 0.579832) < 1e-5, String(dv.probA));
  // a perfectly balanced book must give exactly 50/50
  const even = M.deVig(M.parseAmerican("+100"), M.parseAmerican("+100"));
  ok("pick'em de-vigs to exactly 0.5", even.probA === 0.5);
  ok("de-vig refuses a null side", M.deVig(null, 0.5) === null);
  ok("de-vig refuses prob >= 1", M.deVig(1.0, 0.5) === null);
}

console.log("\nMALFORMED ODDS");
{
  ok("empty string refused (Number('')===0 would imply 100%)", M.parseAmerican("") === null);
  ok("null refused (Number(null)===0)", M.parseAmerican(null) === null);
  ok("undefined refused", M.parseAmerican(undefined) === null);
  ok("non-numeric refused", M.parseAmerican("+abc") === null);
  ok("zero refused", M.parseAmerican("0") === null);
  ok("sub-±100 moneyline refused (impossible)", M.parseAmerican("-50") === null);
  ok("decimal-odds mistake refused", M.parseAmerican("1.91") === null);
  ok("valid negative accepted", M.parseAmerican("-200") !== null);
  ok("valid positive accepted", M.parseAmerican("+250") !== null);
  const r = M.buildBaseline(BOUT, { liveSnapshot: snap([q({ mlA: "abc" }), q({ book: "FD", mlA: "" })]) }, T0);
  ok("malformed live quotes fall through, never coerce", r.fallbackLevel === "D");
  ok("malformed reason is explicit", r.missingSourceReasons.some((x) => /malformed/.test(x)), JSON.stringify(r.missingSourceReasons));
}

console.log("\nSTALE PRICES");
{
  const fresh = M.buildBaseline(BOUT, { liveSnapshot: snap([q({ observedAt: T0 - 2 * H }), q({ book: "FD", observedAt: T0 - 3 * H })]) }, T0);
  ok("fresh multi-book prices reach tier A", fresh.fallbackLevel === "A", fresh.fallbackLevel);
  const stale = M.buildBaseline(BOUT, { liveSnapshot: snap([q({ observedAt: T0 - 100 * H }), q({ book: "FD", observedAt: T0 - 99 * H })]) }, T0);
  ok("stale prices are REJECTED, not used as current", stale.fallbackLevel === "D", stale.fallbackLevel);
  ok("staleness reason names the age", stale.missingSourceReasons.some((x) => /stale/.test(x)));
  // one stale + one fresh = only one usable book -> cannot be a multi-book consensus
  const mixed = M.buildBaseline(BOUT, { liveSnapshot: snap([q({ observedAt: T0 - 2 * H }), q({ book: "FD", observedAt: T0 - 99 * H })]) }, T0);
  ok("one stale book drops the tier rather than averaging stale with fresh", mixed.fallbackLevel === "D", mixed.fallbackLevel);
}

console.log("\nTIMESTAMPS AFTER THE FORECAST SEAL (leakage)");
{
  const future = M.buildBaseline(BOUT, { liveSnapshot: snap([q({ observedAt: T0 + H }), q({ book: "FD", observedAt: T0 + 2 * H })]) }, T0);
  ok("prices quoted AFTER the forecast are refused", future.fallbackLevel === "D", future.fallbackLevel);
  ok("post-seal reason is explicit", future.missingSourceReasons.some((x) => /after the forecast/.test(x)));
  // the exact Phase 7 bug: a price from the future must not be admissible under any tier
  const kFuture = M.buildBaseline(BOUT, { kalshi: { markets: {
    a: { fighter: "Alice Ace", opponent: "Bob Bruiser", last: { ask: 0.6, t: new Date(T0 + H).toISOString() } },
    b: { fighter: "Bob Bruiser", opponent: "Alice Ace", last: { ask: 0.45, t: new Date(T0 + H).toISOString() } } } } }, T0);
  ok("Kalshi quote after the seal is refused too", kFuture.fallbackLevel === "D", kFuture.fallbackLevel);
  ok("no admissible tier ever returns a future price", kFuture.probability === null);
}

console.log("\nDUPLICATED BOOKS");
{
  const { unique, dropped } = M.dedupeBooks([q({ book: "DK" }), q({ book: "dk" }), q({ book: " DraftKings " }), q({ book: "FD" })]);
  ok("same book in different case is ONE book", unique.length === 3, `got ${unique.length}`);
  ok("duplicate drop is recorded", dropped.some((d) => /duplicate/.test(d.why)));
  // three feeds of one book must not manufacture a multi-book consensus
  const r = M.buildBaseline(BOUT, { liveSnapshot: snap([q({ book: "DK" }), q({ book: "DK" }), q({ book: "dk" })]) }, T0);
  ok("three feeds of one book != multi-book consensus", r.fallbackLevel === "D", r.fallbackLevel);
  ok("reason states the book shortfall", r.missingSourceReasons.some((x) => /need 2|only 1 usable/.test(x)), JSON.stringify(r.missingSourceReasons));
  // dedupe keeps the fresher quote
  const { unique: u2 } = M.dedupeBooks([q({ book: "DK", mlA: "-150", observedAt: T0 - 5 * H }), q({ book: "DK", mlA: "-200", observedAt: T0 - H })]);
  ok("duplicate resolution keeps the fresher quote", u2[0].mlA === "-200", u2[0].mlA);
}

console.log("\nONE / SEVERAL BOOKS MISSING");
{
  const two = M.buildBaseline(BOUT, { liveSnapshot: snap([q({ book: "DK" }), q({ book: "FD" })]) }, T0);
  ok("two books = valid tier A", two.fallbackLevel === "A");
  ok("tier A records both books", two.bookCount === 2 && two.sourceBooks.length === 2);
  const one = M.buildBaseline(BOUT, { liveSnapshot: snap([q({ book: "DK" })]) }, T0);
  ok("one book cannot be a multi-book consensus -> falls through", one.fallbackLevel !== "A", one.fallbackLevel);
  // several missing -> falls to B when BFO has the row
  const toB = M.buildBaseline(BOUT, { liveSnapshot: snap([q({ book: "DK" })]), bfoHit: hit(["-150", "-160", "-140"], ["+130", "+140", "+120"]) }, T0);
  ok("books missing -> waterfall falls to tier B", toB.fallbackLevel === "B", toB.fallbackLevel);
  ok("the tier-A failure reason survives onto the tier-B record", toB.missingSourceReasons.some((x) => /^A:/.test(x)), JSON.stringify(toB.missingSourceReasons));
}

console.log("\nCONFLICTING PRICES");
{
  // two books wildly apart: consensus is their mean, and dispersion must SHOW the disagreement
  const r = M.buildBaseline(BOUT, { liveSnapshot: snap([
    q({ book: "DK", mlA: "-300", mlB: "+250" }),     // A ~0.7317 devig
    q({ book: "FD", mlA: "+120", mlB: "-140" }),     // A ~0.4380 devig
  ]) }, T0);
  ok("conflicting books still produce a consensus", r.fallbackLevel === "A");
  ok("dispersion is large and reported, not smoothed away", r.marketDispersion > 20, String(r.marketDispersion));
  ok("consensus sits between the two books", r.probability > 0.43 && r.probability < 0.74, String(r.probability));
  ok("every raw price is preserved for audit", r.rawPrices.length === 2);
  // agreeing books => near-zero dispersion
  const agree = M.buildBaseline(BOUT, { liveSnapshot: snap([q({ book: "DK", mlA: "-150", mlB: "+130" }), q({ book: "FD", mlA: "-150", mlB: "+130" })]) }, T0);
  ok("agreeing books => ~0 dispersion", agree.marketDispersion === 0, String(agree.marketDispersion));
}

console.log("\nFAVORITE / UNDERDOG ORIENTATION");
{
  const aFav = M.buildBaseline(BOUT, { liveSnapshot: snap([q({ book: "DK", mlA: "-300", mlB: "+250" }), q({ book: "FD", mlA: "-280", mlB: "+240" })]) }, T0);
  ok("A favoured -> favorite is A", aFav.orientation.favorite === "Alice Ace", JSON.stringify(aFav.orientation));
  ok("A favoured -> probability > 0.5", aFav.probability > 0.5);
  const bFav = M.buildBaseline(BOUT, { liveSnapshot: snap([q({ book: "DK", mlA: "+250", mlB: "-300" }), q({ book: "FD", mlA: "+240", mlB: "-280" })]) }, T0);
  ok("B favoured -> favorite is B", bFav.orientation.favorite === "Bob Bruiser", JSON.stringify(bFav.orientation));
  ok("B favoured -> probability < 0.5", bFav.probability < 0.5);
  ok("probability is always FOR fighter A regardless of who is favoured", bFav.forFighter === "Alice Ace");
  ok("both sides sum to 1", Math.abs(bFav.probability + bFav.probabilityOther - 1) < 1e-9);
  // quotes listed with the fighters swapped must be re-oriented, not mis-assigned
  const swapped = M.buildBaseline(BOUT, { liveSnapshot: snap([
    q({ book: "DK", fighterA: "Bob Bruiser", fighterB: "Alice Ace", mlA: "+250", mlB: "-300" }),
    q({ book: "FD", fighterA: "Bob Bruiser", fighterB: "Alice Ace", mlA: "+240", mlB: "-280" }),
  ]) }, T0);
  ok("swapped-order quotes are re-oriented to A", swapped.probability > 0.5 && swapped.orientation.favorite === "Alice Ace",
    `${swapped.probability} ${JSON.stringify(swapped.orientation)}`);
}

console.log("\nFALLBACK BEHAVIOUR + VISIBILITY");
{
  const b = M.buildBaseline(BOUT, { bfoHit: hit(["-150", "-160", "-140"], ["+130", "+140", "+120"]) }, T0);
  ok("no live snapshot -> tier B", b.fallbackLevel === "B");
  ok("tier B is LOGICAL_OPEN, not wall-clock", b.clockBasis === "LOGICAL_OPEN", b.clockBasis);
  ok("tier B declares staleness UNenforceable rather than implying freshness", b.staleCheckEnforceable === false);
  ok("tier B timestamp is null and says why", b.priceTimestamps[0].observedAt === null && /does not publish/.test(b.priceTimestamps[0].note));
  ok("tier B carries cross-book dispersion from the closing WIDTH", b.marketDispersion !== null);
  ok("dispersion basis states it is a width, not a level", /width/.test(b.dispersionBasis) && /no directional/.test(b.dispersionBasis));
  const c = M.buildBaseline(BOUT, { kalshi: { markets: {
    a: { fighter: "Alice Ace", opponent: "Bob Bruiser", last: { ask: 0.62, t: new Date(T0 - H).toISOString() } },
    b: { fighter: "Bob Bruiser", opponent: "Alice Ace", last: { ask: 0.43, t: new Date(T0 - H).toISOString() } } } } }, T0);
  ok("A and B unavailable -> tier C", c.fallbackLevel === "C", c.fallbackLevel);
  ok("tier C admits it has no dispersion", c.marketDispersion === null && /single venue/.test(c.reasons ? c.reasons.join() : c.missingSourceReasons.join()));
  ok("every record names the tier that produced it", [b, c].every((x) => x.tier && x.tierMeaning));
  ok("every record carries a content hash", [b, c].every((x) => typeof x.contentHash === "string" && x.contentHash.length === 16));
  ok("every record states the de-vig method", [b, c].every((x) => /normalisation/.test(x.deVigMethod)));
}

console.log("\nFULL ABSENCE OF PRICES");
{
  const d = M.buildBaseline(BOUT, {}, T0);
  ok("no sources at all -> BASELINE UNAVAILABLE", d.status === "BASELINE UNAVAILABLE");
  ok("tier D level is D", d.fallbackLevel === "D");
  ok("tier D invents no probability", d.probability === null);
  ok("tier D gives a reason per attempted tier", d.missingSourceReasons.length >= 3, JSON.stringify(d.missingSourceReasons));
  ok("tier D is still hashed and auditable", typeof d.contentHash === "string");
  const empty = M.buildBaseline(BOUT, { liveSnapshot: snap([]), kalshi: { markets: {} }, bfoHit: null }, T0);
  ok("empty-but-present sources also yield D", empty.fallbackLevel === "D");
}

console.log("\nCLOSING LINE IS EVALUATION-ONLY");
{
  const cl = M.closingForEvaluation(BOUT, hit(["-150", "-160", "-140"], ["+130", "+140", "+120"]));
  ok("closing line is flagged evaluation-only", cl.__EVALUATION_ONLY__ === true);
  ok("closing line carries a never-use-as-prior warning", /published after/.test(cl.__NEVER_USE_AS_PRIOR__));
  ok("closing line does NOT expose a `probability` key a forecaster could read", !("probability" in cl));
  ok("closing value lives under a distinct name", typeof cl.closingProbability === "number");
  // the structural guarantee: no baseline record can be produced from the closing line
  const b = M.buildBaseline(BOUT, { bfoHit: hit(["-150", "-160", "-140"], ["+130", "+140", "+120"]) }, T0);
  ok("tier B uses the OPEN, not the close", Math.abs(b.probability - 0.5798) < 0.01, String(b.probability));
  ok("baseline probability differs from the closing probability", Math.abs(b.probability - cl.closingProbability) > 1e-6);
}

console.log("\nFAIL-CLOSED INVARIANTS");
{
  let threw = false;
  try { M.buildBaseline(BOUT, {}, undefined); } catch (e) { threw = true; }
  ok("a missing forecast timestamp throws rather than defaulting to now()", threw);
  threw = false;
  try { M.buildBaseline(BOUT, {}, NaN); } catch (e) { threw = true; }
  ok("NaN forecast timestamp throws", threw);
  const r = M.buildBaseline(BOUT, { bfoHit: hit(["-150", "-160", "-140"], ["+130", "+140", "+120"]) }, T0);
  ok("probability is always within (0,1)", r.probability > 0 && r.probability < 1);
  // a bad scrape produces an insane overround -> must be refused, not believed
  const bad = M.buildBaseline(BOUT, { bfoHit: hit(["-2000", "-160", "-140"], ["-2000", "+140", "+120"]) }, T0);
  ok("insane overround (bad parse) is refused", bad.fallbackLevel === "D", `${bad.fallbackLevel} p=${bad.probability}`);
  ok("bad-parse reason mentions overround", bad.missingSourceReasons.some((x) => /overround/.test(x)));
}

console.log("\nLEAKAGE GUARD: THE LOGICAL_OPEN EXCEPTION CANNOT BE ABUSED");
{
  const L = require("../lib/leakage-guard");
  const seal = T0;
  const base = (o) => ({ probability: 0.58, forFighter: "Alice Ace", clockBasis: "LOGICAL_OPEN",
    derivedFrom: "opening line", timestamp: null, priceTimestamps: [{ book: "BFO", observedAt: null }], ...o });
  const throws = (fn) => { try { fn(); return false; } catch (e) { return !!e.leakage; } };

  ok("a well-formed LOGICAL_OPEN baseline is admitted", L.checkBaseline(base(), seal) === true);
  ok("LOGICAL_OPEN without declaring the opening line is REFUSED",
    throws(() => L.checkBaseline(base({ derivedFrom: null }), seal)));
  ok("LOGICAL_OPEN carrying a wall-clock price timestamp is REFUSED (cannot opt out by label)",
    throws(() => L.checkBaseline(base({ priceTimestamps: [{ book: "DK", observedAt: new Date(T0 - H).toISOString() }] }), seal)));
  ok("LOGICAL_OPEN whose own timestamp is at/after the seal is REFUSED",
    throws(() => L.checkBaseline(base({ timestamp: new Date(seal).toISOString() }), seal)));
  ok("LOGICAL_OPEN still cannot smuggle an outcome field",
    throws(() => L.checkBaseline(base({ result: 1 }), seal)));

  // THE ORIGINAL BUG: a closing line wearing a fabricated pre-seal timestamp.
  const fabricated = { probability: 0.768, forFighter: "Alice Ace", clockBasis: "WALL_CLOCK",
    timestamp: new Date(seal - 2 * H).toISOString(), priceTimestamps: [] };
  ok("a wall-clock price stamped before the seal is admitted (the guard cannot detect a lie in the value)",
    L.checkBaseline(fabricated, seal) === true);
  ok("...which is WHY the live path never synthesises a timestamp — market-baseline.js emits null instead",
    M.tierB(BOUT, hit(["-150", "-160", "-140"], ["+130", "+140", "+120"]), M.DEFAULTS).clock === "LOGICAL_OPEN");
  ok("a wall-clock price AT the seal is refused", throws(() => L.checkBaseline({ ...fabricated, timestamp: new Date(seal).toISOString() }, seal)));
  ok("a wall-clock price after the seal is refused", throws(() => L.checkBaseline({ ...fabricated, timestamp: new Date(seal + H).toISOString() }, seal)));
  ok("a wall-clock price with no timestamp is refused", throws(() => L.checkBaseline({ ...fabricated, timestamp: null }, seal)));
  ok("an unknown clockBasis falls through to the strict timestamp rule",
    throws(() => L.checkBaseline({ ...fabricated, clockBasis: "MADE_UP", timestamp: null }, seal)));
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
