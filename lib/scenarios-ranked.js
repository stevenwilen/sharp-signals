// RANKED, FALSIFIABLE FIGHT SCENARIOS.
//
// WHY V1 FAILED ITS OWN TEST. The first scenario layer scored "winning path represented: 12/12" —
// and that number was worthless. Every set was FORCED to cover both fighters, so it could not be
// wrong. Checking whether it discriminated: mechanism paths named BOTH fighters in all 5 evaluable
// bouts; ZERO pointed only at the eventual winner. A claim that cannot fail is not a forecast.
//
// WHAT CHANGED. Paths are now ranked, and the ranking is falsifiable:
//   * Shares come from the ALREADY-SEALED outcome tree. No model invents a probability here; the
//     tree's own cells are the shares, so coherence is structural rather than promised.
//   * Every path names what would falsify it BEFORE the fight — an observable development, not a
//     result. "Falsified if the fight reaches the final bell" can be checked; "the better man won"
//     cannot.
//   * Paths without mechanism support are DOWNWEIGHTED and say so, instead of being dressed up as
//     an equal-and-opposite path to guarantee the winner is covered somewhere.
//
// This module RANKS and EXPLAINS the sealed numbers. It never changes them, and it never sees an
// outcome. v7.0.0's numerical rules are untouched.
require("./env");
const crypto = require("crypto");
const E = require("./evidence-eval");

const METHODS = ["KO/TKO", "Submission", "Decision"];
const TREE_KEY = { "KO/TKO": "byKO", Submission: "bySubmission", Decision: "byDecision" };

// Which tree cell a mechanism argues for. Fixed, declared here, and NOT fitted to any outcome —
// a mapping tuned on results would launder hindsight into a "prediction".
const MECH_METHOD = {
  striking: "KO/TKO",
  durability: "KO/TKO",
  activity: "KO/TKO",
  grappling: "Submission",
  cardio: "Decision",
  condition: "Decision",
  style: "Decision",
  physical: "Decision",
};

// What would make each path WRONG, stated as something an observer can check during the fight.
// These are the falsifiers the scenario evaluation grades against, so they are written once, here,
// deterministically — never generated per-fight by a model that has seen the evidence and could
// quietly choose an unfalsifiable phrasing.
const MECH_FALSIFIER = {
  striking: (w, l) => `${l} wins the striking exchanges in round 1, or the fight is grounded for most of round 1`,
  durability: (w, l) => `${l} absorbs ${w}'s best shots without visible damage`,
  activity: (w, l) => `${l} starts sharply with no visible ring rust`,
  grappling: (w, l) => `${w} fails to complete a takedown through round 2, or the fight stays standing`,
  cardio: (w, l) => `the fight ends inside round 1 — a cardio edge never gets to matter`,
  condition: (w, l) => `${l} shows no sign of the reported condition in round 1`,
  style: (w, l) => `the stylistic pattern does not appear in the first two rounds`,
  physical: (w, l) => `${l} closes distance freely and neutralises the physical edge`,
};
const METHOD_FALSIFIER = {
  "KO/TKO": (w) => `the fight reaches the final bell with ${w} unable to hurt the opponent`,
  Submission: (w) => `the fight reaches the final bell with no meaningful submission attempt by ${w}`,
  Decision: (w) => `the fight ends inside the distance`,
};

const sha = (o) => crypto.createHash("sha256").update(JSON.stringify(o)).digest("hex").slice(0, 16);

// Round range implied by a tree cell. Finishes are front-loaded (the tree spreads them 45/32/23
// across rounds 1-3); a decision is terminal by definition.
function roundRangeFor(method) {
  return method === "Decision" ? "goes the distance" : "1-3";
}

// Build the ranked scenario set for one bout.
//   forecast : the SEALED forecast (read, never recomputed)
//   boutEval : the Phase 6 evidence evaluation
// Returns { scenarios:[...], coherence:{...}, hash }
function rankedScenariosFor(boutEval, forecast, A, B) {
  const tree = forecast.outcomeTree;
  if (!tree || !tree[A] || !tree[B]) {
    return { scenarios: [], coherence: { ok: false, reason: "no outcome tree — cannot derive shares without inventing them" }, hash: null };
  }
  const applied = (forecast.appliedAdjustments || []).filter((a) => a.finalAppliedLogOdds > 0);

  // 1. Attach mechanisms to the tree cell each argues for. Several mechanisms may argue for the
  //    same cell — they MERGE into one path rather than becoming duplicate paths, the same
  //    cluster-never-stack rule the engine applies to magnitudes.
  const cells = [];
  for (const fighter of [A, B]) {
    for (const method of METHODS) {
      const share = tree[fighter][TREE_KEY[method]];
      const mechs = applied.filter((a) => E.norm(a.fighterFavored) === E.norm(fighter) &&
        (MECH_METHOD[a.mechanism] || null) === method);
      cells.push({ fighter, method, share, mechs });
    }
  }

  // 2. Rank strictly by the tree's own share. Deterministic and coherent by construction.
  //    Ties broken by mechanism support, then by a fixed method order — never randomly, so the
  //    same inputs always produce the same ranking.
  cells.sort((x, y) => (y.share - x.share) || (y.mechs.length - x.mechs.length) ||
    (METHODS.indexOf(x.method) - METHODS.indexOf(y.method)));
  cells.forEach((c, i) => { c.rank = i + 1; });

  // 3. Assign roles. PRIMARY is the highest-share path that evidence actually supports — not merely
  //    the biggest tree cell. A path nothing supports leading the set is how v1 ended up asserting
  //    both fighters at once.
  const supported = cells.filter((c) => c.mechs.length > 0);
  const primary = supported[0] || cells[0];
  const secondary = cells.find((c) => c !== primary && (c.fighter !== primary.fighter || c.method !== primary.method));
  // The upset path must have a DIFFERENT winner. If primary and secondary already disagree on the
  // winner, the alternative is a genuine method-alternative for the primary's fighter instead.
  const upset = cells.find((c) => c !== primary && c !== secondary && c.fighter !== primary.fighter)
    || cells.find((c) => c !== primary && c !== secondary);

  const roleOf = (c) => c === primary ? "PRIMARY" : c === secondary ? "SECONDARY"
    : c === upset ? "UPSET_OR_ALTERNATIVE" : "DOWNWEIGHTED";

  const scenarios = cells.map((c) => {
    const loser = c.fighter === A ? B : A;
    const role = roleOf(c);
    const mechNames = [...new Set(c.mechs.map((m) => m.mechanism))];
    const origins = [...new Set(c.mechs.flatMap((m) => m.originIds || []))];

    // Why this path sits where it does — derived, not asserted.
    const why = [];
    why.push(`tree share ${(c.share * 100).toFixed(1)}% (${c.fighter} win ${(tree[c.fighter].win * 100).toFixed(1)}% x ${c.method} split)`);
    if (c.mechs.length) why.push(`${c.mechs.length} supporting mechanism(s) across ${origins.length} independent origin(s): ${mechNames.join(", ")}`);
    else why.push("no mechanism in the evidence argues for this path — it is the residual the market already prices");
    if (role !== "PRIMARY" && primary) {
      const d = ((primary.share - c.share) * 100).toFixed(1);
      why.push(`ranks below PRIMARY (${primary.fighter} by ${primary.method}) by ${d} share points`);
    }

    // Falsifiers: the method-level one always applies; each mechanism adds its own.
    const falsifiers = [METHOD_FALSIFIER[c.method](c.fighter)];
    for (const m of mechNames) if (MECH_FALSIFIER[m]) falsifiers.push(MECH_FALSIFIER[m](c.fighter, loser));

    // Contradicting evidence: a mechanism arguing for the OTHER fighter on the same topic cluster.
    const against = applied.filter((a) => E.norm(a.fighterFavored) !== E.norm(c.fighter) &&
      mechNames.includes(a.mechanism));

    return {
      scenarioId: `${c.fighter === A ? "A" : "B"}-${c.method.replace(/\W/g, "")}`,
      rank: c.rank,
      role,
      winner: c.fighter,
      expectedMethod: c.method,
      expectedRoundRange: roundRangeFor(c.method),
      share: +c.share.toFixed(4),
      sharePercent: +(c.share * 100).toFixed(2),
      supported: c.mechs.length > 0,
      decisiveMechanisms: mechNames,
      requiredConditions: c.mechs.length
        ? mechNames.map((m) => `${c.fighter}'s ${m} advantage is real and not already in the price`)
        : [`the mechanisms favouring ${loser} do not materialise`],
      supportingEvidence: c.mechs.map((m) => ({ adjustmentId: m.adjustmentId, mechanism: m.mechanism,
        topics: m.evidenceTopics, independentOrigins: m.informationOriginCount })),
      contradictingEvidence: against.map((m) => ({ adjustmentId: m.adjustmentId, mechanism: m.mechanism,
        topics: m.evidenceTopics, favours: m.fighterFavored })),
      whyRankedHere: why,
      falsifiedBy: falsifiers,
      evidenceLimitations: c.mechs.length
        ? [...new Set(c.mechs.flatMap((m) => [
            `${m.informationOriginCount} independent origin(s)`,
            ...(m.capOrReductionReason ? [m.capOrReductionReason] : []),
          ]))]
        : ["no mechanism-level support for this path"],
    };
  });

  // 4. Coherence must be VERIFIED, not assumed. A scenario set whose shares do not reconcile with
  //    the sealed tree is worse than none: it looks like the model's belief while contradicting it.
  const total = scenarios.reduce((s, x) => s + x.share, 0);
  const perFighter = {};
  for (const f of [A, B]) perFighter[f] = scenarios.filter((s) => s.winner === f).reduce((s, x) => s + x.share, 0);
  const near = (x, y, tol = 0.005) => Math.abs(x - y) <= tol;
  const errs = [];
  if (!near(total, 1)) errs.push(`shares sum to ${total.toFixed(4)}, not 1`);
  for (const f of [A, B]) if (!near(perFighter[f], tree[f].win))
    errs.push(`${f} scenario shares sum to ${perFighter[f].toFixed(4)} but the tree says win=${tree[f].win}`);
  const p = scenarios.find((s) => s.role === "PRIMARY");
  if (!near(p.share, tree[p.winner][TREE_KEY[p.expectedMethod]])) errs.push("PRIMARY share does not match its tree cell");

  const coherence = {
    ok: errs.length === 0,
    errors: errs,
    sharesSumTo: +total.toFixed(4),
    perFighterShares: Object.fromEntries(Object.entries(perFighter).map(([k, v]) => [k, +v.toFixed(4)])),
    treeWinProbs: { [A]: tree[A].win, [B]: tree[B].win },
    checkedAgainst: "the sealed outcome tree — shares are its cells, not new numbers",
  };
  return { scenarios, coherence, hash: sha(scenarios) };
}

module.exports = { rankedScenariosFor, MECH_METHOD, MECH_FALSIFIER, METHOD_FALSIFIER, METHODS, TREE_KEY, roundRangeFor, sha };
