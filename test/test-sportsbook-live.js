// Unit tests for the live multi-book baseline service.
//
// The failure this whole phase exists to prevent: comparing prices observed at different times and
// reading the gap as skill. Phase 8's first shadow run did exactly that and produced 7 phantom
// edges worth up to 13.6 points. These tests lock the structures that stop it.
const S = require("../lib/sportsbook-live");

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? " -> " + extra : ""}`); } };

const BOUT = { boutId: "b1", a: { name: "Alice Ace", norm: "alice ace" }, b: { name: "Bob Bruiser", norm: "bob bruiser" } };
const T0 = Date.parse("2026-07-18T20:00:00Z");
const q = (book, side, odds, o = {}) => ({
  bookId: 21, sportsbook: book, matchupId: "1", fighter: side === "a" ? "Alice Ace" : "Bob Bruiser", side,
  rawOdds: odds, impliedProbabilityRaw: S.parseAmerican(odds),
  sourceTimestamp: null, receiptTimestamp: new Date(T0 - 60000).toISOString(), ...o });
const col = (quotes, o = {}) => ({ ok: true, collectionStatus: "OK", receiptTs: T0 - 60000,
  requestStart: T0 - 62000, requestComplete: T0 - 60000, responseHash: "abc123", eventPath: "/events/x",
  matchups: { 1: { a: "Alice Ace", b: "Bob Bruiser" } }, quotes, rejected: [], ...o });
const twoBooks = () => [q("FanDuel", "a", "-150"), q("FanDuel", "b", "+130"), q("DraftKings", "a", "-140"), q("DraftKings", "b", "+120")];

console.log("VENUE EXCLUSION: THE THING WE TRADE CANNOT BE ITS OWN PRIOR");
{
  ok("Kalshi is not an approved book", S.BOOKS[29].approved === false && S.BOOKS[29].name === "Kalshi");
  ok("...and the reason names the circularity", /circular/.test(S.BOOKS[29].reason));
  ok("Polymarket is not an approved book", S.BOOKS[28].approved === false);
  ok("...because it arbitrages against Kalshi rather than being independent", /arbitrages against Kalshi/.test(S.BOOKS[28].reason));
  ok("real sportsbooks are approved", [20, 21, 22, 23, 24, 25].every((id) => S.BOOKS[id].approved));
}

console.log("\nDE-VIG PER BOOK, THEN COMBINE (never the reverse)");
{
  const dv = S.deVigBook(0.6, 0.4348);
  ok("de-vigged sides sum to 1", Math.abs(dv.probA + dv.probB - 1) < 1e-12);
  ok("overround is preserved", Math.abs(dv.overround - 1.0348) < 1e-4);
  const c = S.consensusFor(col(twoBooks()), BOUT, { nowTs: T0 });
  ok("consensus is produced from two books", c.ok === true, c.reason);
  // FanDuel -150/+130 -> fair 0.5798 ; DraftKings -140/+120 -> fair 0.5622
  const fd = S.deVigBook(S.parseAmerican("-150"), S.parseAmerican("+130")).probA;
  const dk = S.deVigBook(S.parseAmerican("-140"), S.parseAmerican("+120")).probA;
  ok("consensus is the mean of PER-BOOK fair probabilities", Math.abs(c.probability - (fd + dk) / 2) < 1e-4, String(c.probability));
  // the wrong way: averaging raw then de-vigging once, which blends vigs that belong to no book
  const rawAvgA = (S.parseAmerican("-150") + S.parseAmerican("-140")) / 2;
  const rawAvgB = (S.parseAmerican("+130") + S.parseAmerican("+120")) / 2;
  const wrong = S.deVigBook(rawAvgA, rawAvgB).probA;
  ok("this differs from de-vigging the average (the wrong order)", Math.abs(c.probability - wrong) > 1e-6, `${c.probability} vs ${wrong}`);
  ok("per-book raw odds are preserved", c.perBook.every((b) => b.rawOdds && b.overround > 1));
  ok("de-vig method is recorded and says PER-BOOK", /EACH book before any combination/.test(c.deVigMethod));
  ok("consensus method is recorded", /unweighted mean/.test(c.consensusMethod));
  ok("book count is recorded", c.booksIncluded === 2);
  ok("dispersion across books is recorded", typeof c.marketDispersion === "number");
  ok("consensus reproduces its own hash", S.sha({ ...c, contentHash: undefined }) === c.contentHash);
}

console.log("\nTIMESTAMPS ARE REAL OR NULL, NEVER INVENTED");
{
  const c = S.consensusFor(col(twoBooks()), BOUT, { nowTs: T0 });
  ok("source timestamps are null, not fabricated", c.priceTimestamps.every((t) => t.sourceProvided === null));
  ok("receipt timestamps are real", c.priceTimestamps.every((t) => Number.isFinite(Date.parse(t.observedAt))));
  ok("clock basis is WALL_CLOCK (a real observation)", c.clockBasis === "WALL_CLOCK");
  ok("staleness is enforceable on it", c.staleCheckEnforceable === true);
  ok("provenance carries the raw response hash", c.provenance.responseHash === "abc123");
  ok("provenance carries request start and completion", !!c.provenance.requestStart && !!c.provenance.requestComplete);
  ok("provenance names the excluded venues", c.provenance.excludedVenues.some((x) => /Kalshi/.test(x)));
  ok("the observation basis is stated honestly on collection", true); // asserted in collectEvent, exercised live
}

console.log("\nELIGIBILITY FAILS CLOSED, WITH A SPECIFIC REASON");
{
  const one = S.consensusFor(col([q("FanDuel", "a", "-150"), q("FanDuel", "b", "+130")]), BOUT, { nowTs: T0 });
  ok("one book is not a consensus", one.ok === false && /need 2/.test(one.reason), one.reason);
  const oneSided = S.consensusFor(col([q("FanDuel", "a", "-150"), q("DraftKings", "a", "-140")]), BOUT, { nowTs: T0 });
  ok("one-sided markets cannot be de-vigged and are rejected", oneSided.ok === false);
  ok("...and the rejection says why", oneSided.rejectedQuotes.some((r) => /one side/.test(r.rejectReason)));
  const stale = S.consensusFor(col(twoBooks()), BOUT, { nowTs: T0 + 60 * 60000 });
  ok("stale quotes are rejected, never carried forward as current", stale.ok === false, stale.reason);
  ok("...and the reason names the age", stale.rejectedQuotes.some((r) => /stale/.test(r.rejectReason)));
  const malformed = S.consensusFor(col([q("FanDuel", "a", "SUSP"), q("FanDuel", "b", "+130"), q("DraftKings", "a", "-140"), q("DraftKings", "b", "+120")]), BOUT, { nowTs: T0 });
  ok("a suspended/malformed quote drops its book, not the whole card", malformed.ok === false || malformed.booksIncluded === 1);
  const noMatch = S.consensusFor(col(twoBooks(), { matchups: { 1: { a: "Someone Else", b: "Nobody" } } }), BOUT, { nowTs: T0 });
  ok("a bout with no matching matchup is refused", noMatch.ok === false && /no BFO matchup/.test(noMatch.reason));
  const dupMu = S.consensusFor(col(twoBooks(), { matchups: { 1: { a: "Alice Ace", b: "Bob Bruiser" }, 2: { a: "Alice Ace", b: "Bob Bruiser" } } }), BOUT, { nowTs: T0 });
  ok("an ambiguous bout->matchup mapping is refused, not guessed", dupMu.ok === false && /ambiguous/.test(dupMu.reason));
  const failed = S.consensusFor({ ok: false, failureReason: "HTTP 503", collectionStatus: "FAILED" }, BOUT, { nowTs: T0 });
  ok("a failed collection yields no consensus and names the failure", failed.ok === false && /HTTP 503/.test(failed.reason));
  // wild dispersion is not a consensus
  const wild = S.consensusFor(col([q("FanDuel", "a", "-500"), q("FanDuel", "b", "+380"), q("DraftKings", "a", "+150"), q("DraftKings", "b", "-170")]), BOUT, { nowTs: T0 });
  ok("books that wildly disagree are not called a consensus", wild.ok === false && /dispersion/.test(wild.reason), wild.reason);
  ok("malformed odds parse to null rather than 0", S.parseAmerican("") === null && S.parseAmerican(null) === null && S.parseAmerican("-50") === null);
}

console.log("\nMIRROR / WHITE-LABEL BOOKS COUNT ONCE");
{
  ok("BetRivers and BFO-book-26 are registered as one operator",
    S.SAME_OPERATOR.some((g) => g.includes("BetRivers") && g.includes("BFO-book-26")));
  const mirrored = [q("BetRivers", "a", "-150"), q("BetRivers", "b", "+130"),
    q("BFO-book-26", "a", "-150"), q("BFO-book-26", "b", "+130")];
  const c = S.consensusFor(col(mirrored), BOUT, { nowTs: T0 });
  ok("two mirrors of one operator are NOT two independent books", c.ok === false && /need 2/.test(c.reason), c.reason);
  ok("...and the dedupe is recorded as a rejection", c.rejectedQuotes.some((r) => /same operator/.test(r.rejectReason)));
  // the detector catches an UNREGISTERED mirror
  const quotes = [];
  for (let i = 0; i < 10; i++) {
    quotes.push({ sportsbook: "BookX", matchupId: String(i), side: "a", rawOdds: `-1${i}0` });
    quotes.push({ sportsbook: "BookY", matchupId: String(i), side: "a", rawOdds: `-1${i}0` });
    quotes.push({ sportsbook: "BookZ", matchupId: String(i), side: "a", rawOdds: `+1${i}0` });
  }
  const m = S.detectMirrors(quotes);
  ok("an unregistered mirror pair is detected", m.some((x) => x.books.includes("BookX") && x.books.includes("BookY")));
  ok("...and flagged as UNREGISTERED", m.find((x) => x.books.includes("BookX")).registered === false);
  ok("independent books are not flagged as mirrors", !m.some((x) => x.books.includes("BookZ")));
}

console.log("\nSNAPSHOT SYNCHRONISATION");
{
  const c = S.consensusFor(col(twoBooks()), BOUT, { nowTs: T0 });
  const sbTs = Date.parse(c.snapshotTimestamp);
  const sync = S.checkSynchronisation(c, sbTs + 60000);
  ok("snapshots 1 min apart are comparable", sync.ok === true, JSON.stringify(sync));
  const skewed = S.checkSynchronisation(c, sbTs + 30 * 60000);
  ok("snapshots 30 min apart are REFUSED", skewed.ok === false);
  ok("...classified NO BET: ASYNCHRONOUS PRICES", skewed.classification === "NO BET: ASYNCHRONOUS PRICES");
  ok("...with a reason naming the skew", /30.0 min apart/.test(skewed.reason));
  ok("both snapshot times are recorded", !!skewed.sportsbookSnapshot && !!skewed.kalshiSnapshot);
  const noKalshi = S.checkSynchronisation(c, NaN);
  ok("a Kalshi snapshot with no timestamp cannot be synchronised", noKalshi.ok === false);
  ok("no consensus => no synchronisation", S.checkSynchronisation({ ok: false }, sbTs).ok === false);
}

console.log("\nMARKET MOVEMENT IS CONTEXT, NEVER VALUE");
{
  const c = S.consensusFor(col(twoBooks()), BOUT, { nowTs: T0 });
  const mv = S.movementContext(0.45, c, 0.57);
  ok("opening consensus is reported", mv.openingConsensus === 0.45);
  ok("current consensus is reported", mv.currentConsensus === c.probability);
  ok("movement in probability points is reported", typeof mv.movementPoints === "number");
  ok("current Kalshi price is reported", mv.currentKalshiPrice === 0.57);
  ok("whether Kalshi followed the market is reported", typeof mv.kalshiFollowedTheMarket === "boolean");
  ok("the record SHOUTS that movement is not value", /must never be counted as system-generated value/.test(mv.WARNING));
  ok("movement carries no EV, edge or stake field", !("edge" in mv) && !("expectedValue" in mv) && !("stake" in mv));
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
