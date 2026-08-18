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

// ONE MOMENT IS NOT A PATTERN, and this table exists because the difference is the whole ballgame.
//
// Listing five things to watch for, all weighted the same, is worse than listing none: every fight
// produces a takedown, a hard shot, a bad thirty seconds. Watching a fight with five undifferentiated
// red flags in hand means the first one that occurs looks like the read collapsing, when a takedown the
// favourite immediately stands up from is not evidence of anything at all.
//
// So every cue carries the threshold that separates signal from noise:
//   cue       — what you would SEE
//   confirms  — what makes it real: repetition, or duration. This is the bar.
//   dismisses — the false alarm that looks identical for two seconds and means nothing.
//
// Fixed table, no model call — the extractor emits a closed topic vocabulary. Deliberately written in
// plain fight-watching language, because it is read live with one eye on the screen.
const OBSERVABLE = {
  wrestling_offense: {
    cue: "gets the fight to the mat",
    confirms: "it STAYS there — a sustained period of control, or it goes straight back down next round",
    dismisses: "a single takedown {o} pops right back up from",
  },
  takedown_defense: {
    cue: "stuffs {o}’s takedowns",
    confirms: "three or four failed attempts, and {o} stops shooting altogether",
    dismisses: "one stuffed shot early",
  },
  submission_offense: {
    cue: "threatens a submission",
    confirms: "a second real attempt, or {o} visibly changes how they engage to avoid it",
    dismisses: "a hopeful grab shrugged off in seconds",
  },
  submission_defense: {
    cue: "calmly survives {o}’s submission attempts",
    confirms: "escaping {o}’s best position without ever looking troubled",
    dismisses: "surviving one attempt",
  },
  striking_offense: {
    cue: "lands clean at range",
    confirms: "the same shot keeps landing and {o} never adjusts",
    dismisses: "a couple of clean shots in an otherwise even exchange",
  },
  striking_defense: {
    cue: "makes {o}’s best shots miss",
    confirms: "a full round of {o} swinging at air",
    dismisses: "a few misses while {o} finds the range",
  },
  power: {
    cue: "visibly hurts {o}",
    confirms: "it happens twice, or {o} never gets their composure back",
    dismisses: "one flash knockdown cleared within seconds",
  },
  cardio: {
    cue: "is still there late while {o} fades",
    confirms: "{o}’s output drops round on round and stays down",
    dismisses: "heavy breathing between rounds",
  },
  pressure_pace: {
    cue: "walks {o} down and wins the volume",
    confirms: "{o} spends a whole round going backwards",
    dismisses: "one strong thirty-second burst",
  },
  durability: {
    cue: "eats {o}’s best shot and walks through it",
    confirms: "{o} lands their very best and gets no reaction at all",
    dismisses: "surviving one good shot",
  },
  speed: {
    cue: "beats {o} to the punch",
    confirms: "it is still true once the opening exchanges settle",
    dismisses: "one fast opening flurry",
  },
  size_reach: {
    cue: "uses size or reach to dictate the range",
    confirms: "{o} cannot get inside for a whole round",
    dismisses: "being kept at range early while finding a way in",
  },
  fight_iq: {
    cue: "chooses where the fight happens",
    confirms: "{o} keeps ending up exactly where they do not want to be",
    dismisses: "one good positional sequence",
  },
  style_matchup: {
    cue: "shows the stylistic edge",
    confirms: "the same pattern repeats across rounds",
    dismisses: "one sequence going their way",
  },
  weight_cut: {
    cue: "looks the fresher of the two",
    confirms: "it shows in {o}’s output from round one and gets worse",
    dismisses: "{o} looking slow in the first minute",
  },
  injury_health: {
    cue: "targets the injury, and it tells",
    confirms: "{o} keeps favouring it, or stops using that weapon entirely",
    dismisses: "one wince",
  },
  recent_form: {
    live: false,
    cue: "fights like their recent run, not their record",
    confirms: "it holds up past the first round",
    dismisses: "a good opening two minutes",
  },
  quality_of_opposition: {
    live: false,
    cue: "looks a level above what the record suggested",
    confirms: "still winning exchanges once {o} has had time to adjust",
    dismisses: "an encouraging start",
  },
};

// Anything the table does not cover still gets an honest threshold rather than none. Vague, but it says
// the one thing that matters: once is not a pattern.
const DEFAULT_THRESHOLD = {
  confirms: "it keeps happening, or it lasts",
  dismisses: "a single isolated instance",
};

// {o} is THE OTHER FIGHTER, filled in per use. The same cue serves both directions — as a threat from
// the opponent ("Emmers gets the fight to the mat", {o} = the pick) and as the pick's own case
// ("Douglas walks {o} down", {o} = the opponent) — and without the placeholder the second direction
// produced self-referential nonsense like "Douglas walks the pick down".
//
// No he/his anywhere either: this roster has women's divisions, and a cue table that calls Shanelle Dyer
// "he" is wrong on the screen the moment it renders.
const fill = (text, other) => String(text || "").replace(/\{o\}/g, other);

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

// ORDERED, STRONGEST FIRST — [0] is the headline and the rest are secondary. Ranking matters more than
// completeness here: the operator is watching a fight, not reading a list, and five equal bullet points
// is the same as no guidance. `origins` (how many INDEPENDENT channels raised that path) is the only
// honest ranking available, so it is both the sort key and shown, rather than a confidence number the
// system has never measured for live observation and would only be inventing.
// A CLAIM YOU CANNOT SEE IS A BAD LIVE CUE, however many channels said it. "Fights like their recent
// run, not their record" is true background and useless at 22:04 on a Saturday — it outranked
// "gets the fight to the mat" on origins alone and became the headline on three straight fights.
// Live-observable topics sort above background ones first, and only then by origins.
const liveRank = (c) => ((OBSERVABLE[c && c.topic] || {}).live === false ? 0 : 1);

function watchFor(counterClaims, opponent, pick) {
  return counterClaims
    .slice()
    .sort((a, b) => liveRank(b) - liveRank(a) || (b.origins || 0) - (a.origins || 0))
    .map((c, i) => {
      const o = OBSERVABLE[c.topic];
      return {
        rank: i === 0 ? "primary" : "secondary",
        signal: o ? `${opponent} ${fill(o.cue, pick)}` : `${opponent}: ${c.claim}`,
        confirms: fill((o || DEFAULT_THRESHOLD).confirms, pick),
        dismisses: fill((o || DEFAULT_THRESHOLD).dismisses, pick),
        because: c.claim,
        topic: c.topic || null,
        origins: c.origins,
      };
    });
}

// WHAT THE READ LOOKS LIKE WHEN IT IS WORKING — the counterweight to a card of nothing but red flags.
//
// Given only falsifiers, every fight looks like it is going wrong: something on the list happens in
// every fight ever contested. The strongest reason the pick was favoured, expressed the same observable
// way, gives the operator something to check the fight AGAINST rather than only things to fear.
function expectedOf(whyClaims, pick, opponent) {
  const ranked = (whyClaims || []).slice()
    .sort((x, y) => liveRank(y) - liveRank(x) || (y.origins || 0) - (x.origins || 0));
  const c = ranked[0];
  if (!c) return null;
  const o = OBSERVABLE[c.topic];
  return {
    signal: o ? `${pick} ${fill(o.cue, opponent)}` : `${pick}: ${c.claim}`,
    because: c.claim,
    topic: c.topic || null,
    origins: c.origins,
  };
}

// The standing checks — the ones the pick corpus structurally CANNOT supply, so they apply to every
// fight and live at card level rather than being copy-pasted onto each one. These are prompts for the
// operator's own eyes, explicitly NOT system evidence and never counted toward a confidence number.
// THE ONE RULE THAT GOVERNS ALL OF IT. Stated once, at the top, because it is the thing that stops a
// single takedown from reading like a collapse — and it applies to every cue on every fight.
const LIVE_WATCH_PRINCIPLE =
  "One moment is not a pattern. Every fight contains a takedown, a hard shot, a bad thirty seconds — none " +
  "of that breaks a read on its own. A signal only counts when it REPEATS or PERSISTS, and each fight's " +
  "watch item says exactly what that bar is. If the pick is losing exchanges but still doing the thing he " +
  "was picked for, the read is intact.";

// The standing checks, cut from four to three: the fourth ("is the underdog landing his thing") is now
// per-fight and concrete, so keeping a generic version of it here was noise. What remains is only what
// the pick corpus structurally cannot supply — demeanour and intent, which no pre-fight breakdown sees.
const LIVE_WATCH_PROTOCOL = [
  "Walkout and staredown: does the favourite look reluctant or deferential toward someone he has said he respects? A favourite who does not want to hurt his opponent is not the favourite the numbers describe. This is the one that beat us at UFC 330.",
  "First 90 seconds: is the favourite INITIATING, or only countering and waiting? The consensus assumes he imposes himself — a passive favourite is off that assumption before anything has even gone wrong.",
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
      // The read working, and the single biggest way it breaks — in that order, because a page of
      // falsifiers with nothing to weigh them against makes every fight look like it is going wrong.
      expect: expectedOf(why, f.pick, opp),
      watchFor: watchFor(counterpoint, opp, f.pick),
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
    // Operator-side guidance the pick corpus cannot supply. Card-level so it is stated ONCE rather than
    // repeated per fight. Not evidence, not part of any confidence number.
    liveWatchPrinciple: LIVE_WATCH_PRINCIPLE,
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
module.exports = { reasonsFavouring, tierCounts, evidenceBalanceOf, watchFor, expectedOf, OBSERVABLE,
  DEFAULT_THRESHOLD, LIVE_WATCH_PRINCIPLE, LIVE_WATCH_PROTOCOL };
