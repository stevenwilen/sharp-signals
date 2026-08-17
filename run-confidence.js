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

// A claim's topic turned into the thing you would SEE if that claim is the one deciding the fight.
// Deterministic lookup, no model call: the topic vocabulary is a fixed set the extractor already emits.
// Anything unmapped falls back to the claim itself rather than inventing a cue.
const OBSERVABLE = {
  wrestling_offense: "he shoots and the fight hits the mat",
  takedown_defense: "the takedowns keep getting stuffed",
  submission_offense: "he threatens off his back or in scrambles",
  submission_defense: "he calmly survives the submission threat",
  striking_offense: "he is landing clean at range",
  striking_defense: "the good shots keep missing",
  power: "he visibly hurts him early",
  cardio: "he is still pushing the pace late",
  pressure_pace: "he is walking him down and winning the volume",
  durability: "he eats the best shot and walks through it",
  speed: "he is beating him to the punch",
  size_reach: "the size or reach is dictating the range",
  fight_iq: "he is choosing where the fight happens",
  style_matchup: "the stylistic edge is showing early",
  weight_cut: "he looks drained or slow from the cut",
  injury_health: "the injury is visibly affecting him",
  recent_form: "he looks like the fighter of his recent run",
  quality_of_opposition: "he looks a level up on this opposition",
};

// WHAT WOULD MEAN THIS READ IS GOING WRONG — the pre-fight briefing turned into something checkable
// while the fight is actually on.
//
// This exists because the corpus is nearly blind to intangibles: across 1,700 evaluated claims on six
// cards, 21 were tagged `psychological` (~1%). A favourite who is technically better but fights
// reluctantly — too much respect, no urgency, waiting instead of initiating — is invisible to a
// consensus of pre-fight breakdowns, and no amount of channel-weighting will fix that. The operator
// watching the fight can see it in ninety seconds.
//
// So the system does not try to predict it. It states, per fight, the opponent's actual routes to
// winning (from the evidence, with the channel count behind each) so that what the operator sees has
// something concrete to be checked against. It says nothing about stakes, hedging or in-play trading —
// that is the operator's call and always was.
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

function watchFor(counterClaims, opponent) {
  return counterClaims.map((c) => ({
    signal: OBSERVABLE[c.topic] ? `${opponent}: ${OBSERVABLE[c.topic]}` : `${opponent}: ${c.claim}`,
    because: c.claim,
    topic: c.topic || null,
    origins: c.origins,
  }));
}

// The standing checks — the ones the pick corpus structurally CANNOT supply, so they apply to every
// fight and live at card level rather than being copy-pasted onto each one. These are prompts for the
// operator's own eyes, explicitly NOT system evidence and never counted toward a confidence number.
const LIVE_WATCH_PROTOCOL = [
  "Walkout and staredown: does the favourite look reluctant or deferential toward someone he has said he respects? A favourite who does not want to hurt his opponent is not the favourite the numbers describe.",
  "First 90 seconds: is the favourite INITIATING, or only countering and waiting? The consensus assumes he imposes himself. If he is being passive, the read is already off its assumption.",
  "Is the underdog landing the specific thing the evidence said he does well? (see each fight's watchFor)",
  "Between rounds: is the corner asking for urgency? A corner begging for output is telling you what they can see and the pre-fight breakdowns could not.",
];

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
    // ONE-SIDED IS A WEAKNESS, NOT A STRENGTH. UFC 330 showed a 92% STRONG read (Njokuani vs Alvarez)
    // carrying four reasons FOR and an empty counterpoint — presented as if the other side had been
    // examined and found wanting, when in truth nobody had made the other case at all. Seventeen
    // channels repeating one direction is not seventeen independent confirmations; it is one case,
    // seventeen times. It lost. Say so on the artifact instead of showing an empty list.
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
      watchFor: watchFor(counterpoint, opp),
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
    // Operator-side checks the pick corpus cannot supply (see LIVE_WATCH_PROTOCOL). Card-level so it
    // is stated once. Not evidence, not part of any confidence number.
    liveWatchProtocol: LIVE_WATCH_PROTOCOL,
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
module.exports = { reasonsFavouring, tierCounts, evidenceBalanceOf, watchFor, OBSERVABLE, LIVE_WATCH_PROTOCOL };
