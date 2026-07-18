# Pre-registered plan: replacing the fixed method priors

**Status:** PRE-REGISTERED, NOT STARTED
**Written:** 2026-07-16
**Rules version this replaces:** v7.0.0 `methodPriors` (`ko: 0.33, submission: 0.17, decision: 0.50`)

This document is written **before** any model is fitted. It is registered now so that the design
cannot be adjusted after seeing results and then described as if it had been planned. Anything
below that changes after fitting begins must be recorded as an amendment with a date and a reason,
not silently edited.

---

## 1. Why the current priors must be replaced

v7.0.0 assigns every fight the same method split. Two consequences follow, and both are established
by evidence already in hand — neither is a hunch:

1. **Decision is the primary path by construction.** Because `decision (0.50) > ko (0.33) >
   submission (0.17)` for every fighter in every fight, the highest-share cell is always
   `(favourite, Decision)`. Static inspection of the ranked scenario layer confirmed this: PRIMARY
   was "by Decision" in **5 of 5** bouts. The method dimension carries no fight-specific information.

2. **It performed at chance on its first blind test.** The sealed scenario evaluation scored method
   **1/5**. Four of the five fights ended inside the distance while the model called Decision every
   time.

The priors are not merely unvalidated; they are non-discriminative by design. That is the defect.

## 2. What is blocked until this model passes

Enforced in code, not by convention (`lib/contracts.js` `UNVALIDATED_TYPES`, `lib/contract-value.js`,
and independently re-checked in `lib/portfolio.js` `rankContracts`):

- Method, round, KO, submission, decision, and distance contracts are **ANALYSIS ONLY**.
- They may be mapped and displayed. They receive **no stake**.
- They trigger **no alert**.
- They may **not** be called highest leverage.

Note: at the time of writing **Kalshi lists no UFC method or round markets at all** — all 224
`KXUFCFIGHT` markets are outright winner contracts, verified by settlement rules rather than ticker.
So this restriction currently binds on nothing live. It must remain enforced anyway: the moment such
a market lists, the block must already be in place rather than remembered.

## 3. The cardinal rule

**The five known July 11 outcomes may not be used to fit, select, tune, or reject any candidate
model.** They are burned. They appear in no training set, no validation set, and no holdout. They
have been discussed at length in this project's history and are no longer capable of being a blind
test of anything.

Rationale: I have already read those results and reasoned about them out loud. Any model I build
that happens to fit them is unfalsifiable — I cannot prove I did not steer toward them, and neither
can anyone reviewing this.

## 4. Candidate inputs

Declared in advance. Adding an input later is an amendment, not a discovery.

| Input | Rationale | Leakage risk |
|---|---|---|
| Fighter career finish rate (KO / sub / dec) | direct base rate for the target | must use only fights **before** the bout date |
| Opponent-adjusted finish rate | a finisher against poor defence is not a finisher against good | same cutoff; opponent history also date-bounded |
| Opponent finish-absorbed rate | being finished is a property of the man opposite | same cutoff |
| Weight class | heavier classes finish more; this is well established | static, no leakage |
| Scheduled rounds (3 vs 5) | more rounds, more finish opportunity, different decision base rate | known pre-fight |
| Market win probability | the market's view of who wins constrains method shares | must be the **contemporaneous** price, not the close |
| Style matchup (striker/grappler) | mechanism-level prior on method | derived from pre-fight evidence only |
| Recent performance (last N fights) | form and durability drift | strict date cutoff |
| Age and durability | chins decline; finish-absorbed rates rise with age | known pre-fight |
| Takedown / submission tendency | drives the submission share specifically | date-bounded |

Every input is subject to the same rule that governs the rest of this system: **it must be provably
knowable before the fight**, checked by `lib/leakage-guard.js`, not asserted.

## 5. Design: chronological, with an untouched holdout

Random k-fold is **prohibited**. It would train on 2026 fights to predict 2025 ones, and fighter
careers are autocorrelated — a random split leaks a fighter's future into their own past.

```
|<------ TRAIN ------>|<-- VALIDATION -->|<---- HOLDOUT ---->|
 earliest ... cutoff A   cutoff A ... B     cutoff B ... latest
                                            (SEALED, UNREAD)
```

- **TRAIN** — fit candidates. Unlimited iteration permitted here.
- **VALIDATION** — select among candidates and tune. Unlimited iteration permitted here.
- **HOLDOUT** — **read exactly once**, after the final model is sealed and hashed. If it fails, the
  model is rejected. It is not re-tuned and re-tested against the same holdout; that converts the
  holdout into a validation set and destroys it permanently.

Cutoffs are set from the data's date range before any fitting, and recorded in the sealed artifact.
The July 11 and July 18 cards sit outside all three partitions.

## 6. Pre-registered success criteria

The model must beat **both** baselines on the holdout, on the primary metric, or it is rejected:

1. **The fixed priors** (v7.0.0: 0.33 / 0.17 / 0.50) — the thing being replaced.
2. **The unconditional base rate** — the empirical method distribution of the training set. A model
   that cannot beat "always guess the overall average" has learned nothing fight-specific, which is
   exactly the failure v7.0.0 already has.

**Primary metric:** multiclass log loss over `{KO/TKO, Submission, Decision}`.
**Secondary, reported but not decisive:** accuracy, per-class calibration, and — the point of the
exercise — whether the PRIMARY scenario path becomes fight-specific rather than always "Decision".

**Pass condition:** the model beats both baselines on holdout log loss, **and** its calibration does
not degrade for any single method class.

Deliberately *not* a criterion: any target expressed in profit, edge, or ROI. A method model is
judged on whether it describes fights correctly. Wiring it to money is a separate decision made
after it earns one.

## 7. Prospective test before any stake

Passing the holdout is **necessary and not sufficient**. Before method contracts may leave
ANALYSIS ONLY:

1. The model is sealed and hashed.
2. It forecasts **≥ 3 full upcoming cards** in shadow mode, sealed before each event.
3. Those prospective results are evaluated with the same criteria as the holdout.
4. Only then is a decision made about lifting the block — and it is a separate decision, taken
   deliberately, not an automatic consequence of a passing number.

Sample size honesty: three cards is roughly 30–45 fights. That is enough to detect a gross failure
and **not** enough to establish skill. The prospective test is a safety check, not a proof.

## 8. Failure is a permitted outcome

If no candidate beats both baselines, the correct result is to **keep the fixed priors and keep
method contracts blocked forever**, while stating plainly that this system cannot predict method.
That is a legitimate finding, not a setback to be engineered around.

The record of this project so far is five hypotheses tested and five rejected (tipster edge, venue
lag, two-sided arbitrage, CLV, conviction/youth), plus one measured edge that turned out to be a
leak. A sixth rejection would be entirely consistent with the evidence, and pretending otherwise is
how a research system turns into a treadmill.
