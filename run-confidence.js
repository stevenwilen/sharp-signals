// RUN CONFIDENCE — the new pick engine's entry point. Produces data/card-confidence-<date>.json:
// for every fight on the card, the rank-weighted consensus pick + a calibrated win-%, coverage, a
// tier label, the WHY (the reasons the pick wins, and an honest counterpoint), and the WHO (which
// ranked channels back it). No prices, no stakes, no bet. The dashboard renders this file directly.
//
//   node run-confidence.js [<eventDate>]     (defaults to the active card in dispatch-receipts)
//
// There is no Kalshi write path and none is created here — this only reads picks, evidence and the
// channel ranking off disk and writes one JSON artifact.
require("./lib/env");
const fs = require("fs");
const path = require("path");
const C = require("./lib/confidence");
const N = require("./lib/names");

const ROOT = __dirname;
const DATA = path.join(ROOT, "data");
const readJson = (p, f) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return f; } };

function activeCardDate() {
  const r = readJson(path.join(DATA, "dispatch-receipts.json"), {});
  return (r.lastCard && r.lastCard.eventDate) || null;
}

// Reasons from the evidence eval that FAVOUR one fighter: a claim praising him (favors_about) or one
// knocking his opponent (against_about). Deduped by claim text, strongest (most independent origins)
// first. Returns [{ topic, claim, origins }].
function reasonsFavouring(evBout, forName, againstName, limit = 4) {
  if (!evBout) return [];
  const claims = [...(evBout.strongestFactual || []), ...(evBout.strongestMatchupObservations || [])];
  const seen = new Set();
  const out = [];
  for (const c of claims) {
    if (!c || !c.claim) continue;
    const aboutFor = N.surname(c.about) && C.surnameEq(N.surname(c.about), N.surname(forName));
    const aboutAgainst = N.surname(c.about) && C.surnameEq(N.surname(c.about), N.surname(againstName));
    const favours = (aboutFor && c.direction === "favors_about") || (aboutAgainst && c.direction === "against_about");
    if (!favours) continue;
    const key = String(c.claim).toLowerCase().slice(0, 60);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ topic: c.topic || null, claim: String(c.claim).trim(),
      origins: c.origins || c.independentObservations || 1 });
  }
  return out.sort((a, b) => b.origins - a.origins).slice(0, limit);
}

function tierCounts(contributors) {
  const c = {};
  for (const x of contributors) c[x.tier] = (c[x.tier] || 0) + 1;
  return c;
}

// ONE-SIDED IS A WEAKNESS, NOT A STRENGTH. UFC 330 showed a 92% STRONG read (Njokuani vs Alvarez)
// carrying four reasons FOR and an empty counterpoint — presented as if the other side had been
// examined and found wanting, when in truth nobody had made the other case at all. Seventeen channels
// repeating one direction is not seventeen independent confirmations; it is one case, seventeen times.
// It lost. Say so on the artifact instead of rendering an empty list.
//
// A fight with NO evidence either way is not one-sided, it is uncovered — `coverage`/NO-READ already
// says that, and flagging it here too would cry wolf on every thinly-covered prelim.
function evidenceBalanceOf(why, counterpoint, opponent) {
  const oneSided = counterpoint.length === 0 && why.length > 0;
  return {
    for: why.length, against: counterpoint.length, oneSided,
    note: oneSided
      ? `No channel made a case for ${opponent}. That is one-directional evidence, not a stress-tested read: treat this % as less settled than it looks, however high it is.`
      : null,
  };
}

function main() {
  const eventDate = process.argv[2] || activeCardDate();
  if (!eventDate) { console.error("no event date (pass one or run after a card is active)"); process.exit(2); }

  const forecast = readJson(path.join(DATA, `forecast-${eventDate}.json`), {});
  const ev = readJson(path.join(DATA, `evidence-eval-${eventDate}.json`), { bouts: [] });
  const evByBout = new Map((ev.bouts || []).map((b) => [b.boutId, b]));

  const card = C.buildCard(eventDate);

  const fights = card.fights.map((f) => {
    if (!f.pick) {
      return { boutId: f.boutId, fight: f.fight, a: f.a, b: f.b, pick: null,
        label: "NO-READ", coverage: 0, confidencePct: null,
        note: "no channel on the roster has made a pick on this fight yet" };
    }
    const opp = f.pick === f.a ? f.b : f.a;
    const evBout = evByBout.get(f.boutId);
    // WHO: pick-side backers first (best tier first), then the dissenters — honest about disagreement.
    const backers = f.contributors
      .map((c) => ({ source: c.source, tier: c.tier, side: c.side,
        picks: c.side === f.side ? f.pick : opp,
        pickConfidence: c.pickConfidence, directness: c.directness,
        quote: c.quote ? String(c.quote).slice(0, 160) : null }))
      .sort((a, b) => (a.picks === f.pick ? 0 : 1) - (b.picks === f.pick ? 0 : 1));
    const withPick = backers.filter((b) => b.picks === f.pick).length;
    const why = reasonsFavouring(evBout, f.pick, opp, 4);
    const counterpoint = reasonsFavouring(evBout, opp, f.pick, 3);   // the honest case against the pick
    const balance = evidenceBalanceOf(why, counterpoint, opp);
    return {
      boutId: f.boutId, fight: f.fight, a: f.a, b: f.b,
      pick: f.pick, opponent: opp,
      confidencePct: f.confidencePct, label: f.label,
      coverage: f.coverage, share: f.share,
      consensus: `${withPick} of ${f.coverage} ranked channels`,
      why,
      counterpoint,
      evidenceBalance: balance,
      who: { tierCounts: tierCounts(f.contributors), backers: backers.slice(0, 14) },
    };
  });

  const out = {
    card: eventDate,
    event: forecast.event || (forecast.forecasts && forecast.forecasts[0] && forecast.forecasts[0].event) || null,
    generatedAt: new Date().toISOString(),
    channelsWithARead: card.channelsWithARead,
    calibration: card.calibration,
    reads: fights.filter((f) => f.pick).length,
    fights,
  };

  const file = path.join(DATA, `card-confidence-${eventDate}.json`);
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2));
  fs.renameSync(tmp, file);
  const strong = fights.filter((f) => f.label === "STRONG").length;
  const oneSided = fights.filter((f) => f.pick && f.evidenceBalance.oneSided);
  console.log(`confidence: ${out.reads}/${fights.length} fights read · ${card.channelsWithARead} channels · ${strong} STRONG · ${card.calibration.method}`);
  // Surfaced in the run log too, not only in the JSON: a high % on one-directional evidence is the
  // exact shape that burned this operator, and it should be visible without opening the file.
  if (oneSided.length) {
    console.log(`  ${oneSided.length} read(s) built on ONE-DIRECTIONAL evidence (nobody argued the other side):`);
    for (const f of oneSided) console.log(`    ${String(f.confidencePct).padStart(3)}% ${f.label.padEnd(9)} ${f.fight} -> ${f.pick}`);
  }
  console.log(`  -> data/card-confidence-${eventDate}.json`);
  if (!out.reads) { console.error("WARNING: produced no reads — did selection/picks run for this card?"); }
  process.exit(0);
}

if (require.main === module) main();
module.exports = { reasonsFavouring, tierCounts, evidenceBalanceOf };
