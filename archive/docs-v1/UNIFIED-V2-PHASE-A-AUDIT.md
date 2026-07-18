# SharpSignals — Phase A AUDIT (unify V1 + V2 into one cloud pipeline)

**Scope:** read-only synthesis of 12 adversarially-verified subsystem audits, plus direct re-verification of the load-bearing citations (arming, workflows, origin counting, the lift, `getAll`, the fee gate, the forward record).
**Date:** 2026-07-17. **Card in flight:** UFC-2026-07-18 (tomorrow).
**Standard applied:** a check that cannot see its own case is worse than no check; missing data is a refusal. Applied to this document's own findings — every "UNKNOWN" below is a refusal, not a hedge.

---

## 1. Current V1 cloud workflow (crons, scripts, what sends)

Four GitHub Actions workflows. **Three are on live crons. All four run V1 — the rejected guru-track-record thesis. None runs any V2 script.**

| Workflow | Cron | Script | Timeout | Concurrency group |
|---|---|---|---|---|
| `pipeline.yml` | `0 * * * *` (:13) — hourly | `node pipeline.js` (:50) | 45m (:29) | `sharp-signals` (:23) |
| `watch.yml` | `*/15 * * * *` (:12) — 4/h | `node pipeline.js --watch` (:40) | 10m (:27) | `sharp-signals` (:21) |
| `listing-watch.yml` | `10,40 * * * *` (:19) — 2/h | `node listing-watch.js` (:47) | 15m (:34) | `sharp-signals` (:28) |
| `backfill.yml` | **DISABLED** (`# - cron: "30 9 * * 1"`, :22-23) | `node backfill.js` (:79) | 350m (:55) | `sharp-signals-backfill` (:46) |

Additional entry points: `pipeline.yml:14` `workflow_dispatch`, `pipeline.yml:15-17` push on `trigger.txt`; `backfill.yml:24-36` dispatch + push on `backfill-trigger.txt`.

All four end `if: always()` → `bash .github/save-data.sh <label>` (pipeline.yml:58-59, watch.yml:43-44, listing-watch.yml:50-51, backfill.yml:87-88).

**What `pipeline.js` does per run:** scan YouTube → Gemini extract → grade in memory (`grade.gradeAll`, :265) → match to Kalshi (`lib/match`) → size (`sizeBet`, :438) → record paper position (:444-451) → alert (:465-477). Writes `data/signals.json` (:381), `data/pick-ledger.json` (:390), `data/positions.json` (:499), one `data/picks/<id>.json` per newly-extracted video (:115), `data/alerts_sent.json` only if `pruneOld` drops something (:395).

`--watch` (pipeline.js:60-74) skips YouTube/Gemini/Blotato/Twitter but **still writes signals/ledger/positions and still runs the full sizing + paper + alert block**; it suppresses only the daily summary (:483).

### What actually sends today (Telegram, all via `lib/notify`)

| Send | Line | Gate | Live? |
|---|---|---|---|
| BUY alert | pipeline.js:475 | `!ALERTS_ARMED` (:465, hardcoded false) **AND** `alertLedger.shouldSend` (:470) | **No** — 0 of 173 signals in `data/signals.json` pass `qualifying` (:406) |
| Daily paper summary | pipeline.js:492 | `posState && !WATCH` (:483) **AND** (`FORCE_HEARTBEAT==="1"` **OR** UTC hour ∈ [12,16)) (:486) **AND** `meta.lastSummaryDate !== today` (:487) — **no arming consult** | **YES**, once per UTC day |
| Pipeline failure | pipeline.js:504 (`run().catch`) | none | **YES** |
| Market-birth report | listing-watch.js:128 | none | **YES**, 2/h |
| Backfill abort/stop/summary | backfill.js:58,67,122,163,170,206,227,233 | none | Manual dispatch only |

`ALERTS_ARMED` at pipeline.js:465 only chooses the summary's *status string* (:489-491) — it does not gate the send. `data/positions.json` `meta.lastSummaryDate` is `2026-07-16`; the next run landing in the 12:00–16:00 UTC window sends.

**Central finding:** the arming flag governing the hourly cloud cron is `pipeline.js:32`, **not** `lib/arming.js`. `pipeline.js` never requires `lib/arming` (verified: requires at :5-15 are env, store, grade, match, notify, sizing, alert-ledger, pick-ledger, positions, kalshi). Neither `checkArmingPrerequisites()` nor `assertNoTradingPath()` executes in **any** cloud workflow.

---

## 2. Current manual V2 path (exact command sequence)

**Zero V2 scripts are referenced by any workflow or by `package.json`.** The chain is 100% hand-run from the repo root (every script resolves `data/` relative to cwd).

```
 1  node make-card-selection.js 26JUL18 2026-07-18 <out.json>
 2  node run-card-evidence.js <selection.json>
 3  node run-evidence-eval.js data/card-evidence-<date>.json
 4  node run-forecast.js data/evidence-eval-<date>.json --seal=<ISO> --live [--live-event=/events/x]
 5  node run-phase7-seal.js  data/forecast-<date>.json data/evidence-eval-<date>.json
 6  node run-seal-scenarios.js data/forecast-<date>.json data/evidence-eval-<date>.json
 7  node run-baselines.js --cards=26JUL18            # writes data/baselines.json
 8  node run-phase8-shadow.js data/forecast-<date>.json     # MUST run >=2x with differing content
 9  node run-phase9-shadow.js data/forecast-<date>.json
10  <<< HUMAN HAND-AUTHORS data/phase9-fresh-run.json {passed:true} >>>   <-- no script writes this
11  node run-entertainment-alerts.js data/forecast-<date>.json --eval=data/evidence-eval-<date>.json --send
```

**Post-fight only, never schedule before settlement:** `node run-scenario-eval.js` — the only script in the repo that loads outcomes (run-scenario-eval.js:5), and it verifies the seal hash before doing so (:50-53).

**Calling rules that are load-bearing:**
- **Never pass `--out=` on steps 3–6.** `lib/dashboard-data.js` resolves by hardcoded filename: `forecast-${cardDate}.json` / `phase8-shadow-${cardDate}.json` (:145-146), `scenarios-ranked-${cardDate}.json` (:212), `baselines.json` (:60), `fee-verification.json` (:59). Chaining works by string-replace (run-evidence-eval.js:37, run-forecast.js:306, run-phase7-seal.js:87, run-seal-scenarios.js:53).
- **`--live` is required** (run-forecast.js:177-184). Without it `liveConsensus` stays null and every bout falls to tier B (`LOGICAL_OPEN`), which `lib/contract-value.js:155-168` classifies `NO BET` — Phase 8 then refuses every contract. `--live-event=` is optional (BFO event auto-discovery, lib/sportsbook-live.js:378).
- **Never pass `--market=`** (run-forecast.js:161). It is dead config that writes an unread label into a hash-sealed artifact (see §11 #16).
- `run-card-evidence.js:3`'s usage header shows space-separated `--out data/…` but the parser only accepts `--out=` (:32) — copying the header silently ignores the flag.
- `run-phase9-shadow.js:3` advertises `[--card=…]`; it is never parsed (cardDate comes from the forecast at :50).
- Git Bash mangles `--live-event=/events/x` → `C:/Program Files/Git/events/x`. `lib/sportsbook-live.js normaliseEventPath()` recovers it.

**Last real run reproduced the documented state:** `data/entertainment-alerts-2026-07-18.json` — `buyInstructions: 0`, `humanReviewAlerts: 3`, `delivery.transport: "none loaded"`. `data/forecast-2026-07-18.json` — 12 forecasts, 1 bout with an applied adjustment, statuses {LIMITED EVIDENCE: 7, INSUFFICIENT EVIDENCE: 5}, tiers {A: 9, B: 3}.

---

## 3. Current alert paths (every message type + its gate)

**Two independent stacks.** Only `run-entertainment-alerts.js` lazily requires the transport behind a gate (`:217-218`). `pipeline.js:10`, `backfill.js:18`, `listing-watch.js:28`, `ping.js:3` and `chats.js:6` all import `lib/notify` **eagerly at module top level with no gate**.

### V2 stack — the armed one

| Type | Builder | Gate chain | Reachable? |
|---|---|---|---|
| **buyInstruction** | lib/telegram-messages.js:258 → run-entertainment-alerts.js:222 | `--send` (:79) **AND** `gate.armed` = `checkArmingPrerequisites()` + `ARMING.ALERTS_ARMED` + `assertNoTradingPath()` (:39-42) **AND** classification === `"ACTIONABLE EXPERIMENTAL"` (lib/entertainment.js:47,68) **AND** `stake > 0` (:141) **AND** `AL.shouldSend` (:195) | **Armed. Has never fired.** |
| **humanReview** | lib/telegram-messages.js:334-359 → run-entertainment-alerts.js:227 | `--send` **AND** `gate.armed` **AND** an `--eval=` file exists (:51) **AND** `AL.shouldSend` (:210). Deliberately **not** gated on anything qualifying as a bet (:205-207) | **Armed. Fired 3× on 2026-07-17T01:20:08Z** (data/alert-ledger-v2.json) |
| positionWithdrawn | lib/telegram-messages.js:135 | — | **Defined, tested, NEVER wired to Telegram.** Only caller is run-phase9-shadow.js:98 (disk sink, :30-35) |
| experimentalPosition / priceUpdate / evidenceUpdate / noBetStatusChange / dailyShadowSummary / pipelineFailure | lib/telegram-messages.js | — | Shadow only (run-phase9-shadow.js:98,112,120,129) + tests |

**Content guarantees that do hold:** `assertNoConfidenceScore()` runs in all 9 builders. `humanReview` calls `assertNotABettingInstruction()` (lib/telegram-messages.js:357) over the **final constructed text** including interpolated untrusted fields, and **throws** rather than sanitising (:330); the template carries no price/stake/EV field at all (:334-359). `reasonsFor` (lib/telegram-messages.js:228) dedupes by `originIds` into a Set (:234) and gates at `>= 2` origins (:235) — **it counts origins, not voices**, and prints no channel count.

### V1 stack — self-built messages, not in `lib/telegram-messages.js`

| Type | Builder → send | Gate |
|---|---|---|
| BUY alert | pipeline.js:199-213 `buildAlert` → :475 | `pipeline.js:32 ALERTS_ARMED` + `alert-ledger` v1 |
| Daily paper summary | pipeline.js:217-243 `buildSummary` → :492 | time window + `lastSummaryDate` only. **Reachable now.** Prints channel names at :226 via `[${(p.sources||[]).join(", ")}]` and stake % at :226 |
| Failure | raw string → pipeline.js:504 | none |
| Market birth | raw string → listing-watch.js:128 | none |

`lib/notify.js` is a dumb transport: multi-recipient comma-split `TELEGRAM_CHAT_ID`, no-ops only if the token is absent (:42), truncates to 3900 chars (:51). `buyInstruction` places its no-edge warning in the **last two lines** (lib/telegram-messages.js:303-304) — a long message could sever it.

---

## 4. Current arming sources (every flag, its value, the contradiction)

| # | Flag | File:line | Value | Read by |
|---|---|---|---|---|
| 1 | `ARMING.ALERTS_ARMED` | lib/arming.js:20 | **`true`** (`armedAt: "2026-07-17"`) | run-entertainment-alerts.js:33,39; test/test-phase9.js:329 |
| 2 | `const ALERTS_ARMED` | **pipeline.js:32** | **`false`** | pipeline.js:465 **only**. Module-local; never imported from lib/arming.js |
| 3 | `process.env.ALERTS_ARMED` | run-phase9-shadow.js:41 | **never set anywhere** — no workflow, no `.env`, no `.env.example` | Nothing. **Cannot fire, and cannot observe #2** |
| 4 | `ARMING.TRADING_ENABLED` | lib/arming.js:30 | `false` | Nothing. Documented as non-functional (:31) |
| 5 | `armed: false` literals | run-phase8-shadow.js:123, run-phase9-shadow.js:178 | `false` | Shadow records — **not reads of lib/arming.js**. Propagate to `data/phase9-shadow-2026-07-18.json:90` and `lib/dashboard-data.js:90` as `alerts: "DISARMED"` |
| 6 | Hardcoded DISARMED strings | lib/telegram-messages.js:86, :197, :219 | "Alerts remain disarmed" / "Alerts: DISARMED" | Untrue as of #1. Shadow-only today |
| 7 | `ARMING.standingWarning` | lib/arming.js:38-39 | "…Every alert carries this." | **Nothing** except test/test-phase9.js:336, which checks its own wording. **Dead config.** Only `buyInstruction` carries a no-edge warning, and it is **hardcoded** at lib/telegram-messages.js:303-304, not read from ARMING |
| 8 | `V2-REFRESH-AUDIT.md:75` | doc | "ALERTS_ARMED currently OFF. Must stay off." | A note, not a check |

### The contradiction, stated exactly

`lib/arming.js:1` claims to be "what this system is permitted to do, **stated in one place**." It is not:

- **#1 and #2 are the same name holding opposite values with no link between them.** A reader reconciling them can fix it in the wrong direction (see §12 T1).
- `checkArmingPrerequisites()` (lib/arming.js:44-52) — the runtime re-check that exists so "the flag cannot get ahead of the evidence" (:9-11) — is called from **exactly one place**: run-entertainment-alerts.js:39. **Not from any cloud entrypoint.** Verified.
- `assertNoTradingPath()` (lib/arming.js:55-61) — same: only run-entertainment-alerts.js:42. Verified. It returns `true` today; there is genuinely no Kalshi write call (lib/kalshi.js:170-174 exports reads only, and the only POSTs in the repo target api.anthropic.com / blotato / transcripts).
- **Four Telegram paths ignore lib/arming.js entirely** and send today (§3). Setting `ARMING.ALERTS_ARMED = false` cannot silence any of them.
- The dashboard publishes `alerts: "DISARMED"` (lib/dashboard-data.js:90) while lib/arming.js says ARMED.
- The V1 daily summary states "⚠️ Alerts are PAUSED — do not bet from this yet" (pipeline.js:491) while CLAUDE.md and lib/arming.js:20 both state ARMED. Both are true of different subsystems; nothing in the message identifies which subsystem is speaking.

### What actually holds arming open right now

`checkArmingPrerequisites()` currently returns `{ok: true, blockers: [], smallOrderTickets: 2}`. Its two prerequisites:
1. `data/fee-examples.json` has ≥1 taker example with `totalCost` in [2,5] (lib/arming.js:47-48). **Two exist.** Note: the prerequisite *text* (:34) asserts they "reproduce exactly" — the check never re-runs `tradingFee` against them. (They do; independently verified 7/7.)
2. `data/phase9-fresh-run.json` exists and `.passed` is truthy (lib/arming.js:49-50). **See §11 #1 — this is the single worst finding in the audit.**

---

## 5. Current persistence behavior (what survives an ephemeral runner, what does not)

**Mechanism: git commit to `main`, and nothing else.** Zero `actions/upload-artifact`, `download-artifact`, or `actions/cache` anywhere in `.github/`. No S3, no gist, no external upload.

`.github/save-data.sh`: `git add -A data/` (:28) → `nothing to save` → exit 0 (:29-32) → commit (:34) → 5× {fetch, rebase, push} (:36-57) → rebase conflict = `--abort` + **exit 1** (:39-45) → 5 failures = **exit 1** (:56-57). No force-push, no `|| true` on the push. This is the one component that already learned its lesson (:4-20).

### Survives
- Every tracked path under `data/` on a run whose push lands. 13,925 files tracked; `data/` is committed on purpose (`.gitignore:8-12`); `git status --porcelain data/` is empty. Verified: signals.json, pick-ledger.json, positions.json, picks/ are all un-ignored.
- All `.v<ts>` / `.v<hash>` superseded artifacts are tracked — the version chain is durable, not local-only.
- `.gitattributes:1-4` (`*.sh text eol=lf`) keeps save-data.sh from breaking under CRLF.

### Does NOT survive
1. **Any run whose push fails.** Loud (red job) by design — the correct behaviour.
2. **Four gitignored trees:**
   - `data/wiki/` (325M) and `data/bfo/` (50M) — **have a durable home**: `data/BACKUP_MANIFEST.md` records SHA-256, file counts, two storage locations, and verify/restore commands.
   - `data/backups/` (13M) — redundant by design.
   - **`data/evidence/` (2.5M; 37 per-video JSONs + 247 chunk files) — HAS NO HOME AT ALL.** Not committed (`.gitignore:28`, ignored from birth in commit 2813974, and the only one of the four with no explanatory comment), not in BACKUP_MANIFEST.md, not backed up. It is the paid Gemini extraction the entire V2 refresh rests on, on one laptop disk.
3. **Anything written with `DATA_DIR` set.** `lib/store.js:12-14` redirects outputs outside the repo; save-data.sh:28 stages only repo `data/`; the script prints `nothing to save` and exits 0 — indistinguishable from a genuine no-op. `HANDOFF.md:56-69` instructs contributors to set it. No workflow sets it.
4. **Every sealed V2 artifact.** No workflow references any seal/forecast/evidence script. The strongest durability assertion in the sealing path is a local `existsSync` (run-forecast.js:334, run-phase8-shadow.js:193). A sealed, hash-covered, "immutable" forecast lives on one laptop until a human commits it by hand.

### Versioning + hashing
- Forecast: keyed by wall-clock ms — rename prior to `.v${Date.now()}.json`, attach `supersedes` (run-forecast.js:320-328). Phase 8: content-addressed — `.v${priorContentHash}.json` (run-phase8-shadow.js:171-183).
- **Hash-last is correctly implemented in both.** run-forecast.js:329 `payload.sealHash = sha(payload)` after :325 attaches `supersedes`; run-phase8-shadow.js:184-191 `record.decisionHash = C.sha(record)` after :180. The twice-repeated "hash before lineage" bug is genuinely fixed here. Two-tier by design: `contentHash` excludes lineage (reproducible), `sealHash`/`decisionHash` covers it.
- **Both immutability guards fail open** (§11 #17), and **no test covers the versioning path** — `grep supersedes test/` returns one hit (test/test-phase9.js:210) against a hand-built object.

### Write primitives
- `lib/store.js:30-34 writeJson` — tmp + rename, atomic in the ordinary sense. No fsync. Fixed tmp name `file + ".tmp"` (no pid/random) → two concurrent writers to the same JSON interleave. `*.tmp` is **not** gitignored → an interrupted write leaves a committed half-artifact beside the real one (none present today).
- **The two paid caches bypass it:** `lib/picks-cache.js:54-56` and `lib/blotato.js:41-43` use bare `fs.writeFileSync`.

---

## 6. Current source-memory data (shape, size, global-only vs conditional)

**Shape.** `data/sources_graded.json`. All 50 records **currently** carry 19 fields: `source, domain, type, handle, platform, n, effN, hitRate, avgLinePrice, roi, shrunkRoi, roiSe, roiLcb, brier, explicit, implicit, trusted, oos, survives`. **This is an observation about one artifact, not a schema guarantee.** Shape is variable: 19 only when the source has ≥1 resolved pick **and** the caller supplied `sourceMeta` (backfill.js:215, finish-backfill.js:51); **15** without sourceMeta (regrade.js:44, regrade-close.js:46, regrade-close2.js:55, holdout.js:40); **10** when no picks resolve (grade.js:78 early return). Construction is two-stage: grade.js:187 spreads `source + meta + gradeSource(...)`, then grade.js:205-206 adds `survives` and replaces `oos`.

**Size and result.**
- 50 sources; **6,968 deduped** graded picks (11,452 raw rows in `data/predictions.json`; dedupe keys `source|marketTicker||pick`, keeps earliest, grade.js:23-32). Sum of `n` = 6,968 exactly.
- **15 trusted in-sample. 2 with `roiLcb > 0`. 0 of 50 survive.** Held-out baseline roi = +0.008 over 2,287 picks; Šidák z = 3.03 across 42 eligible.
- Best: Michael Chiesa (n=65, shrunkRoi 0.242, roiLcb 0.075, `survives: false`); Belal Muhammad (n=30, shrunkRoi 0.235, roiLcb 0.019, `survives: false`).
- Measured live edge: **+0.30% deduped** (hit rate 60.4%), **-1.77% raw**.
- **The published "12,597 picks / -0.4% ROI" (CLAUDE.md:34, server.js:73, listing-watch.js:4) no longer reproduces.** It traces to a superseded pre-dedupe deep-backfill run (deep-backfill.log:239-241). The adjacent "0 of 50 survive" **does** reproduce exactly. The published figure errs against the repo's interest, but it is asserted as a measurement and is not one.

**Producers/consumers.** `data/sources_graded.json` is written **only** by backfill.js:216 and finish-backfill.js:52. `pipeline.js` deliberately stopped writing it (:256-260) and re-grades **in memory every run** from `data/predictions.json` — there is **no append-only history** of what the gate believed at any past moment. Read by server.js:78, prune.js:14, regrade.js:15 — all research surfaces, none on the alert path. The live V1 decision reads the in-memory grade, not the file.

**GLOBAL-ONLY. There is no conditional source memory.**
- No per-fighter, per-topic, per-weight-class, per-mechanism or per-timing breakdown exists anywhere in the grading path.
- The **only** conditional slice is `directness` (explicit/implicit), grade.js:122-128 — a bare **unweighted** mean `roi` + `hitRate` with **no `roiSe`, no `roiLcb`, no multiplicity correction**, contradicting the same file's own argument at :99-118 that sizing off the mean of a high-variance ROI distribution "is how you go broke while being theoretically right." It is also inconsistent with the headline `roi`, which *is* recency-weighted. Live example: "Show Me The Money" publishes `implicit {n:36, roi:0.146, hitRate:0.667}`. **Zero consumers read it** — published-but-unused.
- `type` (fighter/analyst/coach/bettor) and `domain` are source-level metadata injected from `sourceMeta`, not per-slice ROI.

**Can conditional memory be built from the existing corpus? No.**
- `data/predictions.json` (11,452 rows, 50 sources, 2024-07-13..2026-07-13, 183 tickers) has **outcomes but no topic field**: `source, domain, pick, opponent, directness, confidence, quote, timestamp, url, marketTicker, fightTime, priceAtCall, result, priceSource, oddsOverround`. A pick is a *winner* pick.
- `data/evidence/*.json` (2,199 claims, 36 videos, 20 channels) has a **26-topic taxonomy but no outcome label**: `corroborated` is null on **2,199/2,199** and `knownBeforeBet` is null on **2,199/2,199**. The two fields that would carry ground truth are 0% populated. **The grading target does not exist.**
- `lib/evidence-eval.js` is fully disconnected from source memory — no reference to `bySource|byChannel|sources_graded|trusted|result|outcome|roi|graded`.
- **Sizing the injury question:** running the real `topicOf()` over the 2,199-claim corpus yields **64 `injury_health` claims across 14 channels**. Largest cell = 14 (MMA EXPERTS). **Every cell is below the repo's own `minSampleForTrust = 15`.**
- **Multiplicity:** `gradeAll` already Šidák-corrects across 42 sources and needs z=3.03. 50 × 26 = **1,300 cells** would need ≈ z 4.2 by the same logic while dividing every cell's n by ~26. No cell could clear it.
- Corpus overlap: evidence spans 2026-06-25..2026-07-12 (2 cards); 19/20 evidence channels have a track record; only **212/428** evidence `about` names appear anywhere in predictions.

**`data/pick-ledger.json`** (1,085 entries) is a *watch list* keyed `source|pick` — lifecycle only (`status`, `settledReason` is a text reason, not a result). No forecast, no price, no outcome.

---

## 7. Current learning gaps — is there a feedback loop? **Definitive answer**

### There is no prospective, forecast-changing feedback loop. Precisely:

**(a) The V2 forecast never sees an outcome at runtime.** No graded/position/ledger file is read by run-forecast.js, run-evidence-eval.js, run-phase7-seal.js, lib/forecast.js or lib/evidence-eval.js. `lib/forecast.js:11-17` requires only `./env, fs, path, crypto, ./evidence-eval` and reads exactly one data file: `config/forecast-rules.json`.

**But the leakage guarantee is narrower than it reads.** Outcome-**field** leakage is a hard refusal (run-forecast.js:171-172, exit 2) over a **case-sensitive exact-match deny-list of 13 keys** (lib/leakage-guard.js:16-17), capped at depth 6 (:94) and 500 array elements (:96) — `Winner`, `RESULT`, `fight_result`, `methodOfVictory` all pass. **Prose-level and post-seal-publication leakage is detected and then discarded**: run-forecast.js:227 computes `adm = L.admissibleClaims(...)`, counts `adm.rejected.length` into `leakageRejected`, and **never reads `adm.admitted`**; :230 forecasts from the raw `be`. A claim saying "he defeated X last night" increments the counter and still moves the number. The gate is also structurally inert (§11 #8).

**(b) The V2 settlement pass does not exist.** `run-phase8-shadow.js:162-164` declares `outcomeTracking: {closingPrice: null, settlement: null, netResultAfterCosts: null, couldRealisticallyFill: null, note: "to be filled by a later settlement pass"}`. **Repo-wide: zero writers.** Sole reader `lib/dashboard-data.js:380` passes the null through. Every phase-8 record ever written is permanently unresolvable.

**(c) The dashboard's forward record is hardcoded** — `lib/dashboard-data.js:396-398`: `settledPositions: 0`, `netPaperResultAfterVerifiedCosts: null`, `calibration: "not computable yet — no shadow position has settled"`. **Literals.** Building the settlement pass would not change them.

**(d) V1 has one grading computation feeding TWO outcome→future-behaviour paths** (`grade.gradeAll`, pipeline.js:265):
1. **Source selection** — `survives`/`trusted` → `qualifying` gate (pipeline.js:406) → paper position + alert.
2. **Pricing and sizing** — the same `sourceRoiLcb` → `sizeBet` (pipeline.js:438-440) → `lib/sizing.js:68 p = c*(1+f)`, `:71 pAdj`, `:74` quarter-Kelly → **a forecast probability** (`size.p`, "what we think it's worth", lib/sizing.js:86) and a stake %, persisted at pipeline.js:447 `fairValueCents: size.p` and printed into the alert (:201, :209).

This does **not** weaken the safety posture — sizing off the lower bound rather than the mean is deliberate and documented (lib/sizing.js:20-35), and no path reaches a trade. Both paths emit **zero today** (0 of 173 signals qualify). That is a **data fact, not a structural guarantee**: a chalk-cold holdout window could flip a source to `survives: true` with no code change.

**(e) What is actually missing is a CONSUMER, not data and not a key.**
- V1's `data/positions.json` **already carries a forecast**: `fairValueCents` (lib/positions.js:67) alongside `result` filled by `settle()` (:81-93). It is structurally capable of a calibration curve; it has **0 settled / 3 open**.
- The two ledgers **already share a working join key — the Kalshi ticker** — and all three current positions join to phase8 decisions.
- No code joins them, and V2 never ingests outcomes.
- `lib/positions.js:112-118` **deletes** settled rows at 365d (`SETTLED_KEEP_DAYS = 20`… `= 365`), destroying the track record the file's own header (:1-14) calls "the honest scoreboard."
- `positions.json` stores no `rulesVersion`, no gate snapshot, no `forecastHash`/`decisionHash` (lib/positions.js:63-73) — a position cannot be attributed to the rule that admitted it.

**(f) All grading that exists is retrospective.** regrade.js:1-2, backfill.js:4-5. Even `holdout.js:7-9` is a train/test split over past fights, not a forward commitment.

**(g) The convergence experiment has no analyzer.** `data/listing-watch.json`'s only reader outside listing-watch.js is `run-forecast.js:136` — inside `baselineFromKalshi_SUPERSEDED`, which has **zero call sites**. The recorder is sound (samples `{t, ask, bid, depth, sharp, gap}`, :83; `gap = sharp − ask`, :82; honest `preExisting` exclusion, :53-56, :91). **The data cannot support a verdict yet, and the reason is duration, not sampling design.** 34 runs over 7.5h; 22 of 24 markets excluded as pre-existing; the 2 births are the two **sides of one fight** born at the same instant (`26JUL18ELLAND-ELL` gap −0.0255, `-AND` gap −0.0245 — one de-vigged line, n=1 **event**, not 2 samples), with **exactly one sharp reading each**. The 6h sharp cadence (listing-watch.js:33) is a stated politeness tradeoff (:31-32), not a bias: `gap` is only formed at paired instants (:82-83) and birth is sampled synchronously by construction (:71). `V2-REFRESH-AUDIT.md:114` already says "OPEN — verdict needs convergence data."
- Two real defects in the recorder: `MAX_SAMPLES = 400` (:35) truncates **oldest-first** (`slice(-400)`, :99) — a market listed 4 weeks out at 30-min polling produces ~1,340 samples and loses its birth-to-week-1 window before the fight (`birth` survives; the trajectory does not). And `staleSharp` (:69) reads `sharpAt`, stamped only when a value came back (:97), so a market whose line never resolves has `hoursSince(undefined) === Infinity` (:46) and gets a BFO fetch attempted on **every 30-min run** — the opposite of the politeness the cadence buys.

---

## 8. Scripts that will be REUSED by the unified path (verbatim list)

**Call as-is. No changes required.**
- `.github/save-data.sh` — invoke as `bash .github/save-data.sh <label>` from an `if: always()` step (canonical copy: pipeline.yml:57-59). Do not reimplement commit/rebase/push.
- `.gitattributes:1-4` (`*.sh text eol=lf`).
- Workflow skeleton: `actions/checkout@v4` + `actions/setup-node@v4` node 20 + `permissions: contents: write` + `if: always()` save step.
- `lib/arming.js` → `checkArmingPrerequisites()`, `assertNoTradingPath()` — **call at the top of every unified entrypoint**, which no cloud path has ever done. (Both need hardening — §11 #1, #10.)
- `lib/store.js` → `readJson`, `writeJson`, `paths`. The only atomic writer in the repo; route the two caches through it.
- `lib/kalshi.js` → `marketsAll`, `impliedYes`, `orderbook`, `bestBid`, `settlement`, `candlesticks`, `loadAuth`, and the 429/5xx retry with backoff+jitter (:42-58). Read-only surface; verified zero write functions. **Do not use `getAll` for any "is this complete?" question (§11 #11).**
- `lib/match.js` → `cardDate(eventTicker)` (:33-39). The only reliable fight date — `close_time` on the live board is a placeholder (verified: `KXUFCFIGHT-26JUL18DUUSM` close_time = `2026-08-02T01:20:00Z` for a Jul 18 fight).
- `lib/names.js` → `canonical()`, `nameScore()`. Single home for name handling (match.js:22, pick-ledger.js:17). The comment at match.js:18-21 records the drift bug that forced consolidation — do not fork.
- `lib/evidence-eval.js` → `norm`, `kindOf`, `topicOf`, `TOPICS`, `relevanceOf`, `freshnessOf`, `credibilityOf`, `originAnalysis`. **Never reimplement origin counting.** (`kindOf` needs the fix in §11 #2.)
- `lib/bout-evidence.js` → `evaluateBout(bout, claims)` — unions origin ids across topics (:95-97), emits `originBreakdown` (:102-107).
- `lib/claim-dedupe.js` → `dedupe`, `conflictTopics`. Counts channels, computes `corroborated` itself rather than trusting the model (:77-82).
- `lib/forecast.js` → `mechanismOf`, `logit`/`sig`/`clamp` (:19-21), `magnitudeClassFor` (the honest, un-lifted gate), `buildTree`/`verifyTree` (:153-186). No module-level mutable state; `buildAdjustments` has exactly one non-test call site (run-forecast.js:230).
- `lib/leakage-guard.js` → `checkBaseline`, `assertNoOutcomeFields`, `admissibleClaims`. **Unlike run-forecast.js:227, actually USE the return value.**
- `lib/market-baseline.js` + `lib/sportsbook-live.js` → `buildBaseline`, `consensusForCard`/`consensusFor`, `checkSynchronisation`, `normaliseEventPath`, `parseAmerican`, `deVigBook`. The solved prior path. A lane must consume the same baseline object, never re-derive a prior. (`detectMirrors` needs wiring — §11 #19.)
- `lib/odds-history.js` → `fetchCached` (settled fights only) vs `fetchLive` (uncached, 700ms throttled), `closingLine`, `liveLine`. **Preserve the distinction exactly** — a cached live price is a silent lie.
- `lib/contracts.js` → `tradingFee` (BigInt ceil-to-cent, reproduces 7/7 authenticated tickets exactly — independently re-verified, including the ceil 7/7 · floor 0/7 · round-half-up 4/7 discriminator tally), `withinVerifiedEnvelope` (correct fail-closed allowlist on all six dimensions), `FEES.verifiedScope` (read it, never flatten to a boolean), `executableBuy`, `priceOrder`, `C.sha`. Frozen at v7.0.0 — do not retune.
- `lib/contract-value.js` → `valueContract`, `verifyTreeCoherence`. The classification authority; the stale-baseline (`LOGICAL_OPEN`, :155-168), no-opinion (:172-179) and fill (:225-226) gates all fail closed.
- `lib/portfolio.js` → `sizePosition`, `applyPortfolioCaps`, `CAPS` (0.5%/1%/3%, quarter-Kelly on the conservative probability), `rankContracts` (+ the independent outright-only re-check at :158-163).
- `lib/entertainment.js` → `ELIGIBLE` allowlist (:47), `tierFor` (:55-61), `BANKROLL`, `CAPS`. (Cap scaler needs §11 #5.)
- `lib/alert-ledger-v2.js` → `TRIGGERS`, `shouldSend`, `record`. **The trigger logic is correct**; the defects are at the call sites (§11 #6, #7).
- `lib/telegram-messages.js` → `buyInstruction`, `humanReview`, `reasonsFor`, `assertNoConfidenceScore`, `assertNotABettingInstruction`, `BETTING_WORDS`.
- `lib/notify.js` → `notify()`. Correct that it holds no policy; keep the gate above it. Single Telegram egress point — route everything through it so arming can gate one place.
- `lib/dashboard-data.js` → `readSealed(file, hashField)`. The hash-reproduction check that caught the Phase 8 lineage bug. Every learning-ledger reader should go through it.
- `lib/positions.js` → `recordOpen`/`settle`/`pnlDollars`/`prune` (entry locked at first sighting, everything labelled paper). Fix the empty catch (:39-45) and the 365d delete (:112-118) before reuse.
- `lib/grade.js` → `statsFor` (:36-50 — **already generic over an arbitrary slice**, returns `{n, effN, roi, shrunk, roiLcb, roiSe}`; the one piece a conditional build would not rewrite), `probit` (:54-67 — needed to extend Šidák from 42 sources to N cells; do NOT hardcode 1.645), `dedupePicks` (:23-32), `roiOf`, `gradeAll`'s *structure* (contemporaneous baseline + correction sized to what was auditioned). **Reuse the arithmetic; not the `trusted`/`survives` verdicts.**
- `holdout.js` — the train/test discipline. Run against any conditional slice before believing it.
- `lib/ufc-results.js`, `lib/results.js` — resolved-outcome readers for the settlement pass; do not re-scrape.
- `lib/scenarios.js` — **the template for a "beside" lane**: reads a sealed forecast, adds fields, provably cannot feed back (:3-5). `test/test-phase9.js:41` asserts by source inspection that the downstream lane never calls `buildAdjustments`.
- `run-phase9-shadow.js:37-42 assertNoProductionTelegram()` — refuses to run if `lib/notify` is in `require.cache`. **A stronger structural check than `assertNoTradingPath`'s name list. Copy this pattern.**
- `test/test-runner-guards.js` — the correct test pattern (`fs.mkdtempSync(os.tmpdir())` :26, `fs.rmSync` :86, asserts nonzero exit **and** that it says why).
- `data/BACKUP_MANIFEST.md` — the executed procedure for giving a gitignored tree a durable home. Point `data/evidence/` at it; do not invent another.
- `data/fee-examples.json` — the 7 authenticated unsubmitted tickets; the sole evidentiary basis for the envelope. Read-only.

**The V2 chain, called with these exact invocations** (§2 steps 1–9, 11) — `make-card-selection.js`, `run-card-evidence.js`, `run-evidence-eval.js`, `run-forecast.js`, `run-phase7-seal.js`, `run-seal-scenarios.js`, `run-baselines.js`, `run-phase8-shadow.js`, `run-phase9-shadow.js`, `run-entertainment-alerts.js`.

---

## 9. Components to ISOLATE (rejected V1 decision logic — every entry point)

> **The flag only silences the last step. Disabling the SCHEDULES is what removes the standing capability.**

### Entry points (the actual isolation surface)
| # | Entry point | File:line |
|---|---|---|
| E1 | Hourly cron → `node pipeline.js` | `.github/workflows/pipeline.yml:13` → `:50` |
| E2 | 15-min cron → `node pipeline.js --watch` | `.github/workflows/watch.yml:12` → `:40` |
| E3 | `workflow_dispatch` on pipeline | `pipeline.yml:14` |
| E4 | push on `trigger.txt` → pipeline | `pipeline.yml:15-17` |
| E5 | `workflow_dispatch` + push on `backfill-trigger.txt` → `node backfill.js` | `backfill.yml:24-36` → `:79` (cron already correctly disabled at `:22-23` with a full rationale at `:3-20` — **do not "fix" it back on**) |
| E6 | `workflow_dispatch` on watch | `watch.yml` |
| E7 | Hand-run `node pipeline.js` / `--watch` / `--mock` | — |
| E8 | Dashboard read of the archived board | `server.js:78` (already correctly labelled `archived: true` / "NOT A LIVE BETTING SIGNAL" / `doNotUse` at `server.js:70-75` — **do not re-promote**) |

### Code
- **`pipeline.js:32` `const ALERTS_ARMED = false`** — the second, competing arming source of truth. **Delete, do not re-point** (§12 T1).
- **`pipeline.js:17-31`** — the SAFETY banner. Its four bug descriptions are stale (all four fixed; see §11 #14 for the one that is only *partly* fixed) and its closing line "Flip this to true only when Tier-1 is fixed and verified" is now a **satisfied trigger**. Archive with the flag; it must not survive as a checklist that reads as complete.
- `pipeline.js:198-213 buildAlert()` — the only code that can emit "🥊 BUY" with a stake. Dead behind :32.
- `pipeline.js:402-421` — the `qualifying`/`trusted` selection (`survives && !isFighter && sourceRoiLcb > 0`, :406). The V1 decision gate.
- `pipeline.js:423-477` — the whole BETS block: `sizeBet` (:438), `recordOpen` (:444-451), the alert loop (:465-477).
- `pipeline.js:261-271, :375, :406` — `gradeAll` + the ranked track-record table wired to an hourly cron.
- `pipeline.js:483-497` — the daily summary. **Keep the paper-scoreboard idea; isolate this implementation**: it Telegrams on an hourly cloud cron with no arming consult, reports the V1 paper book, and prints channel names at `:226`.
- `pipeline.js:470-473` — `alertLedger.shouldSend/record`. Rejected dedupe semantics (ticker + source-name set + 1pt stake move).
- **`lib/sizing.js` — the whole module.** A bet-size recommender fed by the archived track record; **no test file imports it**; fails open to the mean at `:59`.
- `lib/grade.js` `trusted` (:153) and `survives` (:205) **verdicts** — the board *as a signal*. Keep the file readable for the dashboard; nothing on a decision path may read them.
- `lib/match.js matchToMarket()` (:59-157) — its refusals are excellent and `cardDate`/`names` are reusable, but the function exists to answer "which side do I buy from this pundit's sentence."
- `lib/pick-ledger.js` — the guru watch list; exists to "pounce at the open" (:12-14).
- `lib/alert-ledger.js` + `data/alerts_sent.json` — superseded by v2; **the data file does not exist on disk**. Its dedupe is the logic alert-ledger-v2.js:3-10 explicitly repudiates.
- `run-forecast.js:43-62 baselineFromBfo_SUPERSEDED` — zero call sites; **reads the graded pick ledger AND contains the synthetic-timestamp bug verbatim** (`new Date(sealTs - 2*3600*1000)`, `:56`), sitting 60 lines above the live path that exists to avoid it. Move to `archive/`.
- `run-forecast.js:135-155 baselineFromKalshi_SUPERSEDED` — zero call sites. It is also **the sole reason a grep for "who reads the convergence data" returns a false positive** (`:136`).
- `run-forecast.js:161` `--market=` — dead config that launders an unused CLI flag into a hash-sealed provenance field.
- `regrade.js` / `regrade-close.js` / `regrade-close2.js` / `prune.js` / `diag-line.js` / `diag-linebias.js` / `diag-noline.js` / `compare-sports.js` / `finish-backfill.js` — retrospective diagnostics against the void evaluation. Keep readable, keep off every prospective path.

### Data
- `data/signals.json` **as a consumed artifact** — 173 entries rewritten hourly from the rejected thesis.
- `data/sources_graded.json` **as a signal** — 12,597-pick backfill, no generalising edge. Research read = fine; a sizing or alert path = never.
- `data/raw_posts.json`, `data/backups/predictions-*.json` — the same corpus.
- **`data/alert-ledger-v2.json` (all three keys)** — mis-bound to the current card (§11 #3). Archive; re-key on fighter identity + claim hash.
- **`data/entertainment-alerts-2026-07-18.json`** — an orphan. Its `forecastHash c15427c5d791dea8` (:44) matches **no forecast in the repo** (the three on disk hash `09ff1000…`, `d1c02982…`, `f869d7bd…`), and the eval it was built from is gone. Archive; do not let it read as a record of what the system believes.
- The six stale `data/phase8-shadow-2026-07-18.v*.json` — **but read §12 T13 before touching them.**
- **`data/positions.json`'s 3 open positions** — §12 T14. Time-critical.
- **`data/phase9-fresh-run.json`** — §11 #1. Quarantine.

---

## 10. Components to INTEGRATE

**One entrypoint, one arming gate, one ledger, one durable write.**

1. **A single `assertSafeToRun()` preamble** on every unified entrypoint — cloud and local. Calls `ARM.checkArmingPrerequisites()` **and** `ARM.assertNoTradingPath()` (today: only run-entertainment-alerts.js:39-42) **and** `assertNoProductionTelegram()`-style `require.cache` checks for shadow lanes (the pattern at run-phase9-shadow.js:37-42, which is structurally stronger than the name list). Explicit exemption list for sends that must survive a disarm (failure alerts — pipeline.js:30's "the system cannot die quietly" is a real constraint; §12 T2).
2. **One arming authority.** `lib/arming.js` becomes the only place `ALERTS_ARMED` is decided. `pipeline.js:32` is deleted (not re-pointed). `process.env.ALERTS_ARMED` (run-phase9-shadow.js:41) either gets a writer or is removed. `ARMING.standingWarning` gets **wired** to the builders or its "Every alert carries this" sentence is deleted (§12 T16). The `armed: false` literals (run-phase8-shadow.js:123, run-phase9-shadow.js:178) and the DISARMED strings (lib/telegram-messages.js:86,197,219; lib/dashboard-data.js:90) read from ARMING or say which subsystem they describe.
3. **The V2 chain as the cloud pipeline**, called with the §2 invocations (defaults on `--out=`, `--live` mandatory, no `--market=`, `cd` to repo root), each stage ending `if: always()` → `save-data.sh`.
4. **A machine-written, card-keyed, hash-keyed `phase9-fresh-run` artifact** replacing the hand-authored file. `checkArmingPrerequisites()` compares `fresh.card` to the card being alerted and `fresh.forecastHash` to the sealed forecast, and refuses on a mismatch instead of a truthiness pass.
5. **Identity-first joins everywhere.** A stable bout identity from normalised fighter names (order-independent), with `B01` demoted to a display ordinal. Every artifact join cross-checks fighter identity — the check `lib/contracts.js:265-268` + `lib/contract-value.js:33-36` already implement and `run-entertainment-alerts.js:100` already models. `run-phase7-seal.js` and `run-seal-scenarios.js` compare `ev.card.eventId` to `fc.card.eventId` and refuse.
6. **One alert ledger (v2)**, re-keyed: buy keys on `boutId|ticker` → identity|ticker; review keys on `identity|topic|about|claimHash`. `AL.prune(activeKeys)` (lib/alert-ledger-v2.js:111 — currently never called) gets a caller. The review-state object carries the fields the triggers inspect so escalation can fire (§11 #6).
7. **The fee gate wired to block** — `productionAlertAllowed` read at run-entertainment-alerts.js:141, recomputed after `applyEntertainmentCaps` scales, fed the real `avgExecutionPrice`, real `side`, real `fillCount`, and its suppression made **loud** (§12 T3).
8. **The settlement pass** — reads a sealed phase-8 record + `lib/kalshi.js settlement()` + a real pre-seal closing price, and **APPENDS** a settlement row keyed by `decisionHash`, never editing the sealed decision (run-phase8-shadow.js:164). Nullable `closingPrice` whose null is a **refusal to grade**, not a zero (CLAUDE.md: "Absence is the truthful value"). `L.assertNoOutcomeFields` called on the decision side before appending. `lib/dashboard-data.js:396-398` derives from data instead of literals.
9. **The calibration consumer that already has its inputs** — join V1's `positions.json` (`fairValueCents` + `result`) and phase-8 decisions **on the Kalshi ticker they already share**, and add `rulesVersion` + `forecastHash`/`decisionHash` + gate snapshot to `lib/positions.js:63-73` so a row can be attributed to the rule that admitted it. Append-only; no update-in-place; no 365d delete (`lib/positions.js:112-118`).
10. **`data/evidence/` given a durable home** via the `BACKUP_MANIFEST.md` procedure (tarball + sha256 + two locations), or committed under the `lib/picks-cache.js:24-26` reasoning ("only valuable if it is COMMITTED — or every local run is a cold start that re-buys what the cloud already paid for").
11. **A test runner** with three segregated lanes: offline unit suites (the 798-assertion set), network probes (`test-bfo.js`, `test-results-source.js`, `test-model.js`), and data-mutating suites repointed at `os.tmpdir()`. `package.json:9`'s `exit 1` stub replaced. The assertion count **produced by the runner, not typed** (CLAUDE.md: "Recompute tallies, never edit them by hand").
12. **Concurrency groups split** — pipeline / watch / listing-watch off the shared `sharp-signals` group (§11 #18).
13. **`writeJson` as the single write primitive** — `lib/picks-cache.js:54-56` and `lib/blotato.js:41-43` routed through it, with a completion marker or length/hash on the transcript cache (§11 #21).

---

## 11. CRITICAL BUGS, ranked

> Ranked by: can it reach a human with a false instruction, and is it live now.

### Tier 1 — live, reaches a human, or holds arming open

**#1 — The arming gate is held open by a hand-written attestation that no script produces, checked by truthiness, keyed to no card. `lib/arming.js:49-50`.**
`data/phase9-fresh-run.json` has **no writer anywhere in the repo** (verified: `grep -rn "phase9-fresh-run" --include=*.js` returns only lib/arming.js:35 and :49 — reader only). `checkArmingPrerequisites()` tests `fresh.passed` and nothing else: never `fresh.card` vs the card being alerted, never `ranAt` recency, never the artifacts it claims. **Every number in it contradicts the artifacts on disk:** it says "13 bouts" (forecast says 12), "47 claims" (eval says 38), "3 items queued for human review" (eval `reviewQueue` has 2), "coverage 2 PARTIALLY / 7 THINLY / 4 INSUFFICIENT" (eval: 2/5/5), "13 forecasts" (12). It is pinned to `UFC-2026-07-18`. `run-phase9-shadow.js:194-195` writes only `phase9-test-messages.json` and `phase9-shadow-<date>.json`.
**Failure scenario:** the 2026-07-25 card runs. Nothing regenerates the file. `checkArmingPrerequisites()` reads `passed: true` about a different card, returns `{ok: true}`, `gate.armed` is true, and `run-entertainment-alerts.js --send` Telegrams a buy instruction on the strength of a stale human-typed claim about a card it never saw. This is CLAUDE.md's "a gate that failed open" **and** "an armed flag whose evidence has gone missing" **and** "a script that exits 0 without producing its artifact," simultaneously, on the one file that authorizes money instructions. It cannot be repaired by re-running — nothing generates it.

**#2 — The origins rule has a classification hole: N channels can become N origins. `lib/evidence-eval.js:77-89` + `:122-133`.**
`independentOrigins` is a per-claim Set cardinality (correct), but the identity function does not deliver the collapse the module promises. **Only** claims that `kindOf` routes to `rumor`/`secondhand_report` collapse to a `report:` id (`:125-128`). `kindOf:84` maps `claimClass === "injury_health"` → `"current_condition_report"`, which falls to the **else-branch** at `:131-132` and mints `analyst:<channel>` **per channel**. The `else` also catches `unsupported_narrative`.
**Failure scenario:** five channels each report "Holland has a staph infection," phrased without a `SECONDHAND` cue (`:76`) and tagged `injury_health` by the extractor. `originAnalysis` returns **5 origins**. `config/forecast-rules.json:24` MAJOR requires `minIndependentOrigins: 5` — met. One reporter's story moves the forecast 0.28 log-odds. This is the exact megaphone-as-consensus inversion the module's own header (`:92-102`) and the union-per-claim comment (`:113-119`) say the module exists to prevent. Two additional edges: two **unnamed** rumours falsely share `report:unnamed` (`:128`) — undercounting; and stats collapse only when the first 28 normalized characters match verbatim (`:130`), so **paraphrases of one stat mint separate `record:` ids** — overcounting.

**#3 — BUG 1: positional `boutId` re-binds; stale alerts reached a human's phone. `lib/target-card.js:68`.**
`boutId = ${eventId}-B${String(i+1).padStart(2,"0")}` over a `pairs` array whose order is Kalshi's response order and whose `.filter(a => a.length === 2)` renumbers on any drop (make-card-selection.js:31-36; same pattern run-baselines.js:59-64). `a[0]`/`a[1]` also make the a/b role assignment order-dependent. The id carries **no fighter identity**.
**Live proof:** `data/entertainment-alerts-2026-07-18.json` B01 = "Jacobe Smith vs Kevin Holland"; `data/evidence-eval-2026-07-18.json` B01 = "Kamaru Usman vs Dricus Du Plessis". B03: Usman-in-alerts vs Ramirez/Hooper-in-eval. B05: Hooper vs Ricci/Kline. **No Holland bout exists on the card at all.** `data/alert-ledger-v2.json` records `lastSentAt: 2026-07-17T01:20:08Z`, `messageCount: 1` for all three — **three Telegram messages were actually sent.** The alert file (`ranAt 01:20:52Z`) is *newer* than the eval (16:30) and forecast (20:03) it disagrees with.
**The mechanism that let it through:** `run-entertainment-alerts.js:56` takes `fight` from the forecast (`f.fight`), `:63` takes `about`/`claim` from the eval bout (`r.about`, `r.example`), and **never compares them — even though `b.fight` is on the object being iterated** (verified: every eval bout carries `fight`). A one-line `if (f && b.fight && f.fight !== b.fight) refuse` would have caught the shipped artifact. **The exact check already exists in the contract path:** `lib/contracts.js:265-268` (`matches neither fighter in the mapped bout`) → `:291 mappable` → `lib/contract-value.js:113-117` refuses; and `lib/contract-value.js:33-36` independently re-checks. **Reuse, not invent.**
*(The precise re-index cannot be reconstructed — both Usman and Hooper shifted exactly −2 while the bout count differs by only 1, so ordering changed too, or more than one pair moved; and the 12-bout eval **predates** the 13-bout run, which inverts the obvious "Holland withdrew" story. The artifacts it was generated from are gone. **UNKNOWN — and the fact that it is unknowable is itself the finding**: positional ids cannot distinguish their own vintages.)*

**#4 — The fee envelope blocks nothing. `lib/entertainment.js:101` vs `run-entertainment-alerts.js:141`.**
`feeGate.productionAlertAllowed = env.inside` is computed, embedded in the Telegram body, and stored in the ledger. **No production code reads it** (verified: only lib/entertainment.js:101 and two tests). `run-entertainment-alerts.js:141` filters on `eligible && stake > 0` only. Nothing in the classification path consults the envelope either — `lib/contract-value.js:225-226` awards ACTIONABLE EXPERIMENTAL on conservative EV + fill alone, and `lib/contracts.js:426-428` sets `ok: true` **unconditionally** after pushing an advisory reason.
**Failure scenario:** an order whose fee is EXTRAPOLATED produces a buy instruction and is delivered. Its own `why` string (lib/entertainment.js:103) tells the human "Until then this position is TEST MODE only" — in a message that is not test mode. **This is the `makerRate: 0.0` failure exactly**: config in the fee object that nothing reads, while the config looks handled.

**#5 — The cap scaler invalidates the fee gate and never rechecks it. `lib/entertainment.js:136-138`, `:146-148`.**
`applyEntertainmentCaps` recomputes `stake` and `contracts` (`Math.floor(stake/allInPrice)`) but **not `feeGate`**.
**Verified by execution:** 5 eligible $5 positions at 0.59, card cap binds → before: `$5 / 8c, inside=true, alertOK=true`; after: `$2 / 3c, inside=true, alertOK=true`; ground truth on the post-scaling numbers: **`inside=false — size 3 is outside the verified band 3.28–823.81 contracts`**. CLAUDE.md's "a denominator incremented without rechecking the numerator," in the gate that authorizes production alerts. It also silently falsifies the ledger's `withinEnvelope` state, **disabling the `envelope-left` trigger for exactly the case that created the violation.**

**#6 — HUMAN REVIEW alerts are permanently suppressed after the first send. `lib/alert-ledger-v2.js:37-73` + `run-entertainment-alerts.js:210`.**
Every trigger except `first` begins `!prev ? null :` and inspects fields the review state (`{newsKey, about, topic, origins, why}`) does not carry (`ask`, `classification`, `forecastHash`, `stakePercent`, `stale`, `pipelineFailed`, `withinEnvelope`). **Verified by execution: a review escalating `origins` 1 → 5 fires ZERO triggers** → `{send: false, why: "no material change since the last message"}`.
**Failure scenario:** Kevin Holland is recorded at `origins: 1` right now. Under the governing rule 1 origin moves *exactly zero* and 5 origins is MAJOR. **The single transition the human most needs to be told is the one that can never be sent.**

**#7 — Four v2 ledger triggers are unreachable from the live runner. `run-entertainment-alerts.js:141, 156, 195`.**
`shouldSend` is only ever called on `eligible` contracts, and eligibility requires `classification === "ACTIONABLE EXPERIMENTAL"` and non-stale data (`lib/entertainment.js:47, 69-79`). The moment a position is withdrawn / goes stale / crosses its max price, it **drops out of `eligible`**, its key is never re-evaluated, and `withdrawn`, `data-stale`, `price-crossed-max` and `envelope-left` **can never fire**. The ledger's stated reason for existing (`lib/alert-ledger-v2.js:6-10` — "a ticker alerted once could go stale, cross its maximum price, be withdrawn entirely, and the human would hear NOTHING") **is still true in production.** The tests pass because they call `TRIGGERS` directly with synthetic prev/now (test/test-phase9.js:217).
**Compounding:** `TM.positionWithdrawn()` (lib/telegram-messages.js:135) is defined, tested, and **never wired to Telegram**. **There is no code path by which a human who placed a manual bet is ever told the system disowned it.**

**#8 — The claim-level leakage gate is inert, and a borrowed timestamp is latent inside it. `run-forecast.js:226-228`.**
`lib/bout-evidence.js:37-39` never emits `publishedAt` (confirmed on disk: 0/38 topic claims in `data/evidence-eval-2026-07-18.json` have it). So `.filter(c => c.publishedAt)` at `:227` empties the array, `admissibleClaims()` is handed `[]`, and `leakageRejected` is structurally always 0 (confirmed: `[0]` × 12 in the sealed forecast). Worse, **`adm` is only counted** — `:230` passes `be` wholesale, so a claim detected as post-seal would still contribute to the adjustment. **And `:226` substitutes `be.topics[0].claims[0].publishedAt` for any claim missing one** — a fabricated timestamp attributed to a different claim, the same family as the `sealTs - 2h` bug CLAUDE.md lists first. It is harmless **only** because the borrowed value is also `undefined`.
**Failure scenario:** someone plumbs `publishedAt` through `lib/bout-evidence.js` — the obvious fix for the inert gate. Every undated claim now silently inherits another claim's date and is waved through the leakage guard. **The fix activates the bug.** (The **baseline** leakage gate at `run-forecast.js:189-192` is real and does fail closed with `process.exit`.)

**#9 — The MODERATE→MAJOR lift bypasses the frozen MAJOR gate. `lib/forecast.js:100-102`.**
`if (cls !== "NONE" && supporting >= 3 && supportOrigins.size >= 3 && ORDER.indexOf(cls) < 3)` — a **hardcoded, config-invisible threshold of 3** that promotes MODERATE → MAJOR **without re-checking the promoted class's own rule**. `config/forecast-rules.json:24` MAJOR demands `minIndependentOrigins: 5`, `requiredStrength: ["strong"]`, `requiredKinds: [verified_hard_fact | verifiable_statistical_claim]`. **All three are bypassed.** The effective MAJOR origin threshold is **3 in code vs 5 in config**; changing the config would not close it.
**Verified by execution:** 3 striking-cluster topics, each `strength: "moderate"`, `kinds: ["film_study_observation"]`, `independentOrigins: 3` → `{raw: "MODERATE", lifted: "MAJOR", origins: 3, applied: 0.28}` — the largest adjustment the engine can emit.
**Important qualification:** the lift **does** gate on distinct origin IDs (`:98 supportOrigins.size >= 3`), so this is a **threshold bypass, not an origins-vs-voices violation.** It is frozen v7.0.0 code and documented as intentional ("one step only") — reported as a discrepancy between the stated rule and the shipped behaviour, **not** as a number to retune.
**Test cannot see its own case:** `test/test-forecast.js:100` asserts "4 origins cannot reach MAJOR (needs 5)" against `magnitudeClassFor` — **which the lift routes around.** No test exercises `buildAdjustments`' lift against the MAJOR threshold. *(UNKNOWN — needs a suite run: whether any test covers the 3-origin lift; `test/test-engine-static.js:26` fixtures sit at `independentOrigins >= 5`, reaching MAJOR by the legitimate route.)*

**#10 — `assertNoTradingPath()` is a five-name deny-list that cannot see its own case. `lib/arming.js:57-58`.**
It checks `typeof k[w] === "function"` for exactly `["createOrder","placeOrder","submitOrder","cancelOrder","batchCreateOrders"]` on `lib/kalshi.js`'s exports. **`lib/kalshi.js:171` exports a generic `request(method, path, {query, body, auth})`** that signs `KALSHI-ACCESS-SIGNATURE` over `method` (`:71-77`), serializes a JSON body (`:79-84`) and writes it (`:99`).
**Failure scenario:** `k.request("POST", "/portfolio/orders", {body: {...}, auth: true})` places a real order. `assertNoTradingPath()` returns `true`. The guard proves "no function is **named** `createOrder`", not "no order can be placed." This is CLAUDE.md's "deny-list of one string ... Allowlist, don't deny-list," generalized to five, on the assertion CLAUDE.md itself cites as the trading guarantee. **No live hole today** (verified: zero write functions exist). But: it runs at **exactly one call site** (run-entertainment-alerts.js:42) — never in any cloud workflow — and **no test ever makes it throw** (test/test-phase9.js:342 asserts only the direction that trivially passes). `run-phase9-shadow.js:37-42`'s `require.cache` check is a structurally stronger pattern already in the repo.

**#11 — `getAll()` silently truncates at 2000 and returns a short array indistinguishable from a complete one. `lib/kalshi.js:114`.**
`} while (cursor && out.length < 2000);` — the cursor is **discarded**, with no flag, no throw, no residual-cursor report.
**This is why the "Kalshi lists no method/round/distance markets" premise is not just wrong but unanswerable from this repo.** That premise is written into `data/phase9-fresh-run.json` ("24 active contracts, all FIGHTER_WINS (Kalshi lists no method/round markets)") and `docs/method-model-plan.md:40-42`. Verification identified **sibling series carrying exactly those markets — `KXUFCMOF`, `KXUFCMOV`, `KXUFCVICROUND`, `KXUFCROUNDS`, `KXUFCDISTANCE`** — on the same bouts, simply not inside `KXUFCFIGHT`, which is the only series `lib/match.js:26` ever queries (`SERIES = {mma: "KXUFCFIGHT"}`). **The repo already maintains live mapping code for non-outright types** (`lib/contracts.js:218-232`) and marks them `UNVALIDATED METHOD MODEL` (`:289`). **UNKNOWN — the exact inventory needs a cursor-honest enumeration that treats an unexhausted cursor as a refusal rather than a count.** See §12 T6 and §13 Q4.

### Tier 2 — silent corruption / unfixable-by-rerun / fix-activates-bug

**#12 — `forwardRecord`'s settled/calibration metrics are literals. `lib/dashboard-data.js:396-398`.** `settledPositions: 0`, `netPaperResultAfterVerifiedCosts: null`, `calibration: "not computable yet — no shadow position has settled"` — hardcoded inside the returned object; nothing derives them from `all` or from `d.outcomeTracking` (which **is** threaded in at `:380` and then never read). If the settlement pass is built, the dashboard **still** reports zero settled. A check that cannot see its own case — **worse than no check, because it will actively assert the false negative after the gap is fixed.**

**#13 — `run-inject-verified.js`: no identity check, silent drop under `--write`, hand-built tally.**
`:48` and `:70` find the bout by `boutId` alone and **never compare `result.claim.about` to `bout.fight`.** The identity check cannot live in `lib/verified-news.js` either — `:105` passes `block.boutId` through verbatim and `toEvidence` never sees the eval file. `:71 if (!bout) continue;` drops **silently** under `--write`, while the **dry-run** path at `:49` *does* warn — the safer mode tells you, the mutating mode does not; neither changes the exit code (`:97`). `:89-93` builds `ev.verifiedInjections` from **all** admissible blocks while `added` counts only what attached, so `ev.verifiedInjections` can claim an injection that never happened and the console count diverges from the file's own ledger. **CLAUDE.md's "recompute tallies, never edit them by hand," in the tally itself.**
*(The bridge's origin core is sound and not implicated: `lib/verified-news.js:80-83` **ignores** declared origins with an explicit note; `:39-49 countOrigins` keys on `s.origin`; `:109-110` thresholds 5/3/2 with single origin → "NOTHING"; `:101` hashes the claim **last** over everything. The identity dimension has **no test** — `test/test-verified-news.js` covers origins exhaustively; the only identity test in the repo is `test/test-phase8.js:98`, contracts path.)*

**#14 — The surname-only wrong-side guard is one layer, not three. `pipeline.js:338`.**
The bug **is** fixed at `lib/match.js:103-116` (refuses `pickS < 2 && !oppConfirms`, refuses names-both-fighters, refuses an equal-scoring runner-up), corroborated on the grading path by `lib/results.js:66-67`. **But the two defenses cited as backup do not back anything up.** `pipeline.js:338`'s `nameScore(f.pick, mkt.fighter) < 1` and `test/test-match.js:37`'s `>= 1` **both accept a bare-surname match (score 1)** — precisely what the wrong side returns for "Usman over Du Plessis" (→ Dricus **Du Plessis** = 1) and "Usman by KO" (→ Seok Hyun **Ko** = 1). Both thresholds would need `< 2` / `>= 2` — or, since a legitimate `pickS=1 + oppConfirms` match is intended and would then be wrongly refused, the assertion should compare against the matcher's own `pickS`/`oppConfirms` rather than re-deriving a score it cannot interpret. **The regression test is a live-network integration script that is not in the test suite and cannot fail on the wrong-side outcome.**

**#15 — Seal scripts never compare `eventId`. `run-phase7-seal.js:29`, `run-seal-scenarios.js`.**
Neither compares `ev.card.eventId` to `fc.card.eventId`. `run-phase7-seal.js:29` checks only that `fc.forecasts` and `ev.bouts` exist; `run-seal-scenarios.js` has **no shape check at all**. Both **print** `fc.card.eventId` (`:30` / `:26`) while never validating the eval came from the same event.
**Failure scenario:** a 2026-07-11 eval is paired with a 2026-07-18 forecast. Accepted silently. `run-phase7-seal.js:95` then seals `evidenceHash: sha(ev.bouts)` — **hashing the wrong card's evidence into the artifact's lineage as if it were the right one.**
Two narrower related items: `run-phase7-seal.js:72-74` (a vintage/boutId mismatch lets the **wrong bout's `coverage`** decide whether this bout gets the generic stub — a gate misfire; fighter names never cross objects). And `run-seal-scenarios.js:32-34` is **not a bug** — `be` is passed to a parameter `lib/scenarios-ranked.js` never reads; the honest finding is the inverse: `rankedScenariosFor` **advertises a `boutEval` parameter** (documented at `:69` as "the Phase 6 evidence evaluation") and silently ignores it. A signature promising an evidence input that has no effect.
**Related fail-soft:** `lib/scenarios.js:44-45` takes the same branch for `!boutEval` (lookup failed) and `coverage === "INSUFFICIENT EVIDENCE"` (genuinely thin), emitting the same reason string. Missing data becomes a plausible artifact with a false reason attached.

**#16 — `--market=` mislabels a hash-sealed immutable artifact. `run-forecast.js:161` → `:308` → `:320`.**
Parsed, written as `marketSource`, folded into `contentHash` and `sealHash`. **Nothing reads it to choose a market** — `buildBaselines()` ignores it and both `baselineFrom*_SUPERSEDED` functions have zero call sites. **It is already wrong on disk:** `data/forecast-2026-07-18.json` says `marketSource: "bfo"` while 9 of 12 baselines are tier A live multi-book consensus. `--market=kalshi` would seal a permanent artifact claiming Kalshi pricing that never happened, and the hash would faithfully certify the false label. The `makerRate` pattern at the provenance layer.

**#17 — Both immutability guards are truthiness-gated and fail open. `run-forecast.js:322`, `run-phase8-shadow.js:174-175`.**
`if (prior.contentHash && prior.contentHash !== payload.contentHash)` is the only guard between `:320 existsSync` and `:333 writeJson`. A pre-existing sealed file lacking `contentHash` (older format, hand-edited, truncated write) short-circuits: **no `.v*` rename, no `supersedes`, `writeJson` overwrites the sealed artifact.** Sitting directly under `run-forecast.js:310`'s "IMMUTABILITY: a sealed file is never overwritten." **CLAUDE.md's "gate that failed open," verbatim, in both writers, with no test covering the path.**
Related: **`run-seal-scenarios.js:63` `writeJson(outPath, payload)` with no existsSync/rename guard at all** — it overwrites its sealed artifact with no version preservation, destroying the prior `scenarioSetHash` that `run-scenario-eval.js` would have graded, while `:59` declares `immutable: true`.

**#18 — Concurrency group collision: the exact bug this repo already diagnosed and fixed for the backfill only.**
`pipeline.yml:23`, `watch.yml:21`, `listing-watch.yml:28` all `group: sharp-signals` with `cancel-in-progress: false` = **7 runs/hour contending**. GitHub keeps only **one** pending run per group, so a third arrival silently cancels the pending one. `backfill.yml:41-44` documents the mechanism verbatim ("the pipeline ... kept cancelling the queued backfill ... the backfill silently never ran") and fixed it for itself. During any long pipeline run (45m timeout), queued watch/listing-watch runs are cancelled without a trace — and `listing-watch.yml:49` is the one workflow whose whole premise is "a caught birth is unrepeatable."
**Compounding:** `pipeline.js:129-130` gates the Twitter harvest on `getUTCHours() % 24 === 0` — one run per day. If that run is cancelled by this group or delayed past the hour boundary, the harvest silently skips the entire day (`:144` prints a console line).

**#19 — `detectMirrors()` is defined, exported, tested, and never called. `lib/sportsbook-live.js:62, :402`.**
`consensusFor` de-duplicates using **only** the static `SAME_OPERATOR` list (`:55-57`, `:251-257`). The comment at `:60-61` asserts "Don't rely on this list staying complete... **This runs on live data** and flags the pair rather than silently counting it twice." **It does not run on live data** (only caller: test/test-sportsbook-live.js:109).
**Failure scenario:** an unregistered mirror is counted twice — inflating `booksIncluded` past the `minBooks = 2` floor **and** shrinking observed dispersion under `maxDispersionPoints = 12`. A thin consensus reads as both broader and more unanimous — precisely the failure the comment claims to prevent. **CLAUDE.md's "a tool that couldn't catch its own case."**
Related: **BFO columns 26 and 27 are `approved: true` while admittedly unidentified** (`lib/sportsbook-live.js:39-40` — "column present on BFO but unnamed in the header; treated as a real book, flagged for identification"). They count toward `booksIncluded` and the independence floor. Missing data is being approved, not refused. Aggravating: **book 26 is empirically a BetRivers mirror** (`:55-57`) — unnamed columns are exactly where duplicate feeds hide. (The registry *does* fail closed for ids absent from `BOOKS`, `:159`.)

**#20 — Silent write failures on the ledgers.**
`lib/positions.js:39-45` — `function save(state) { try { …writeFileSync…renameSync… } catch (_) {} }`. An ENOSPC/EPERM/rename failure **silently discards every mutation from the run — including settlements** — leaves `meta.lastSummaryDate` unpersisted (→ the daily summary re-sends next run), and `pipeline.js:499` checks no return value. `load()` (`:28-37`) is carefully hardened to **throw** on a corrupt file, "refusing to rebuild over it" — and `save()` throws that discipline away. Violates "a script that exits 0 without producing its artifact is a failure." `lib/alert-ledger.js:22-24` is identical.
`lib/alert-ledger-v2.js:22` is the **opposite**: `const save = (o) => fs.writeFileSync(FILE, JSON.stringify(o, null, 2));` — unguarded. Since `record()` runs **after** `notify()` succeeded (run-entertainment-alerts.js:222), a write failure means the human receives the message and the ledger never learns → **next run re-sends.**
`lib/alert-ledger-v2.js:111 prune()` is **never called** from the live runner — the ledger grows unbounded and stale review keys persist indefinitely, which (given #6) means a rumour key suppressed today stays suppressed across future cards.

**#21 — The transcript cache read is fail-open on truncation. `lib/blotato.js:33-39`, `:41-43`.**
`readCache` accepts **any** file longer than 20 characters. `writeCache` is a bare non-atomic `fs.writeFileSync`.
**Failure scenario:** a process is killed mid-write (runner timeout, crash — precisely what `if: always()` exists for). A truncated `.txt` passes the `> 20` check, is committed by save-data.sh, and is thereafter served **forever** as a complete transcript. Every claim extracted from it is silently derived from a partial document and nothing downstream can detect it. **The length check cannot see its own case: no expected length, no hash, no completion marker.** `lib/picks-cache.js:40-46` self-heals because a truncated JSON fails `JSON.parse` → cache miss; the `.txt` cache has no such parse to fail.

**#22 — `save-data.sh`'s central assertion is false, and it is load-bearing. `.github/save-data.sh:16-20`.**
"the caches under data/picks/ and data/transcripts/ are one-file-per-video, so concurrent runs add disjoint files. **Conflicts should now be impossible.**" This is the justification for treating a conflict as an emergency exit rather than a handled case. But pipeline (`group: sharp-signals`) and backfill (`group: sharp-signals-backfill`) are in **different** groups by design, and **both write `data/picks/<videoId>.json`, whose content embeds a wall-clock timestamp** (`lib/picks-cache.js:54-56`, `at: new Date().toISOString()`). Two runs extracting the same video (both scan the same YouTube channels) produce **different bytes at the same new path** → add/add conflict → rebase fails → `exit 1` → **the entire run, up to a ~350-minute paid backfill, is discarded.** Exposure is currently reduced (backfill cron commented out, `:22-23`) but **not removed** — it is manual-dispatchable.

### Tier 3 — latent / library-level

**#23 — `sizeBet` fails open to the mean. `lib/sizing.js:59`.** `const edges = preds.map(p => (p.roiLcb != null ? p.roiLcb : (p.shrunkRoi || 0)))` — falls back to the flattering in-sample **mean** when the lower bound is null, which the file's own header (`:28-33`) says must never size a bet. `roiLcb` is null exactly when `effN <= 1` (grade.js:116) — the smallest samples, where the mean is least trustworthy. **1 of 50 sources has it null today.** Latent: `pipeline.js:406`'s `(s.sourceRoiLcb || 0) > 0` coerces null to 0 and filters it. **The hole is in the library, reachable by any caller that does not replicate the pipeline's gate — and `lib/sizing.js` has no test file** (`grep -rn "sizeBet" test/` returns nothing).

**#24 — The `singleMechanismLogOdds` cap is unreachable. `lib/forecast.js:115-118`.** `caps.singleMechanismLogOdds = 0.28` (config:17) and the largest `magnitudeClasses` value is **also exactly 0.28** (config:11), so `applied > 0.28` is never true. Verified: `0.28 > 0.28 === false`. The cap can never fire, its `capReason` string is dead, and it provides **no protection against the lift in #9, which lands precisely on 0.28.** It reads as a live guard and is decoration. **FROZEN — do not retune 0.28 to make it fire.**

**#25 — Contradiction-zeroed adjustments vanish from the sealed record. `lib/forecast.js:147`.** `return adjustments.filter(a => a.finalAppliedLogOdds !== 0 || a.rawMagnitudeClass === "NONE")`. An adjustment that earned MINOR and was reduced to NONE by a same-mechanism contradiction has `finalAppliedLogOdds === 0` and `rawMagnitudeClass === "MINOR"` → **dropped entirely.** It appears in neither `appliedAdjustments` nor `consideredButZero` (run-forecast.js:269 counts only survivors). Verified by execution: returns `[]`, not one zeroed object. The **number** is right (zero); the **provenance** is lost — `capOrReductionReason`, the contradiction that killed it, and the origin ids never reach the artifact. A reader cannot distinguish "no evidence" from "evidence that cancelled."

**#26 — The output deny-list is six strings. `run-forecast.js:330-332`.** `["stake","kelly","recommendation","buy","sell","edgeClaim"]` matched as exact JSON keys. `stakePct`, `kellyFraction`, `betSize`, `action`, `side` all pass. **CLAUDE.md's "Allowlist, don't deny-list" — and this is the only guard on what a new lane's fields may be called.**

**#27 — Cross-module gates coupled by bare string literals.** `lib/entertainment.js:71-72` `probabilityModelStatus === "UNVALIDATED METHOD MODEL"` must exactly match the independently-written literal at `lib/contract-value.js:132`, and a third at `lib/contracts.js:289`. **No shared constant**; any drift silently opens the gate. Mitigated by `lib/portfolio.js:158-163` independently re-blocking non-`FIGHTER_WINS` types. (The classification gate is safe — `ELIGIBLE` is an allowlist, `lib/entertainment.js:47`.)

**#28 — `eventDetail()` reads the wrong key. `lib/kalshi.js:125`.** Kalshi returns `{event: {markets: [...]}, markets: []}` — the top-level `markets` is **empty** while the real markets sit under `event.markets`. Verified live: `d.markets len 0`, `d.event.markets len 2`. **Zero callers today**, but it is exported and it is the single most natural function to reach for when expanding contract discovery per-event — which is exactly the task in §13 Q4.

**#29 — `sizeEntertainment` returns `eligible: true` with `contracts: 0`.** `lib/entertainment.js:87` `const contracts = price > 0 ? Math.floor(stake/price) : 0;` — the `: 0` branch is not a refusal, `stake` stays at the full tier value, and `run-entertainment-alerts.js:141`'s `stake > 0` filter admits it. A buy instruction for zero contracts.

**#30 — `assertNotABettingInstruction` throws from an unguarded loop. `run-entertainment-alerts.js:61` → `:209` → `:271`.** `r.example` (raw transcript text) is interpolated at `lib/telegram-messages.js:341`. One transcript rumour containing "price" or "bet" throws, propagates, `exit 1` — **killing the entire run, all buy instructions and all other human-review alerts, producing no artifact.** Fail-closed, but it takes the whole pipeline with it.

**#31 — Missing origin data is rendered as "unknown" instead of refused, on the path that knows it exactly.** `lib/bout-evidence.js:142-143` gates the branch on `t.origin.independentOrigins === 1` and then **omits the field** — unlike the sibling push at `:141` which includes `origins: t.origin.independentOrigins`. `lib/telegram-messages.js:346` renders `Independent origins: ${r.origins == null ? "unknown" : r.origins}`. **Live in the shipped artifact:** `data/entertainment-alerts-2026-07-18.json` B03 prints "Independent origins: unknown" immediately followed by "a one-origin report cannot clear the magnitude rules, so this moved nothing." Two of the three recorded review entries (Usman, Hooper) have **no `origins` field at all**.
**Compounding:** `run-entertainment-alerts.js:65-66` hardcodes that sentence from a **bout-level** fact (`applied.length === 0`) and **never consults `r.origins`** — a 3-origin claim on a bout with no adjustments would still be narrated as one-origin.

**#32 — Duplicate review alerts are possible.** `lib/bout-evidence.js:140-143` — one topic can match **both** `reviewItem` branches (injury_health+rumor, and 1-origin+newly_emerging+not-very-weak), producing two items with identical `(topic, about)` → identical ledger key. `run-entertainment-alerts.js:210` filters with `shouldSend` before any `record` (`:227`), so both see no prev, both send, and the second `record` overwrites the first.

**#33 — `verify-fees.js` does not enforce its own declared scope.** `:66-72` gates `treatment` only; it never checks `market` series or `side` against `FEES.verifiedScope` and **never calls `withinVerifiedEnvelope`**. A NO-side or non-KXUFCFIGHT example would be scored against the taker formula, match, and be stamped "FEE CONFIG VERIFIED" into `data/fee-verification.json` — **certifying the exact two dimensions `FEES.doesNotEstablish` disclaims** (`lib/contracts.js:82`, `:85`). "A tool that couldn't catch its own case," one level up from the maker bug it already fixed. *(Display bug: `verify-fees.js:31-32` prints `makerRate: undefined` and `verified : undefined` on a PASS, because both were correctly removed from FEES without updating the reader.)*

**#34 — Documentation/provenance drift asserted as measurement.**
- `lib/entertainment.js:27-33` claims "$3 … lands inside across the whole 0.59-0.89 band — $3 at 0.89 is 3.33 contracts." **False both ways:** `Math.floor` (`:87`) puts $3 at 0.80 and 0.89 at **3 contracts**, below the 3.28 floor — and `$3/0.89 = 3.37`, not 3.33 (3.33 is $3/0.90). `test/test-phase9.js:276-280` asserts the opposite in the same file whose banner at `:345` reads "ALL LAND INSIDE THE FEE ENVELOPE." Fail-**closed**, so a false claim, not an unsafe number.
- `lib/entertainment.js:88-89` says "far below the **82.37**-contract floor" while `lib/arming.js:34` says "envelope floor **now 3.28** contracts."
- `test/test-phase9.js:270-280` — the "$2 order at 0.59 (3.28 contracts)" assertions run on a **$4 (6-contract)** and a **$3 (3-contract)** fixture (`expectedValueConservative: 0.05` → STRONG). They pass while testing a case other than the one they name; `:268` concedes it (`[3,4,5].includes(good.stake)`). **The $2/3.28 boundary is unpinned.**
- `pipeline.yml:47-48` claims "FORCE_HEARTBEAT=1 would ping on EVERY run (6x/day)" — both halves false (cron is hourly = 24/day; `lastSummaryDate` caps at one/day regardless). Same "every 4h" drift at `save-data.sh:7` and `backfill.yml:42`.
- The "12,597 picks / -0.4% ROI" headline (CLAUDE.md:34, server.js:73, listing-watch.js:4) — see §6.
- CLAUDE.md:70's "792 across 11 suites" — 798 measured; the "11" boundary is undefined (§13 Q8).

---

## 12. TRAPS — where following the instructions literally causes harm

**T1 (the known one, and it is worse than stated). "Use one shared arming source / remove contradictory alert flags."**
Naively consolidating `pipeline.js:32` (`false`) onto `lib/arming.js:20` (`true`) **arms V1's buy-alert path**, which bypasses `checkArmingPrerequisites()` entirely (pipeline.js never requires lib/arming). The danger is **not** that the banner is a stale warning a careful reader would respect. It is the reverse: **the banner's four bugs are fixed** (in `c89c568`), so `pipeline.js:31`'s "Flip this to true only when Tier-1 is fixed and verified" is a **satisfied trigger sitting one line above the flag.** A reader who does the diligent thing — verify the banner's own claims — concludes the flag should flip.
**The surviving reason to stay disarmed is nowhere near the banner:** `V2-REFRESH-AUDIT.md:75` ("ALERTS_ARMED currently OFF. Must stay off"), `:244` ("no automatic execution during the refresh"), `:246` ("the dead premise"), and CLAUDE.md's "It has never demonstrated a predictive edge."
**Correct action:** rewrite `pipeline.js:17-32` to record the bugs as **fixed in c89c568** *and* point at the surviving reason, **removing the "flip this when Tier-1 is fixed" trigger** — then delete the const. Do **not** arm.
**Do not take false comfort in "it would send nothing anyway."** It is true today (0 of 173 signals qualify at `pipeline.js:406`) and it is a **data fact, not a structural guarantee** — one chalk-cold holdout window flips a source to `survives: true` with no code change, and #23 means the library beneath it fails open to the mean.

**T2. "Route every send through lib/arming.js."**
Correct for buy instructions, human reviews, summaries and birth reports. **Not for the failure alert.** `pipeline.js:30` states the constraint: "Failure alerts still go out, so the system cannot die quietly." Gating `pipeline.js:504` on arming means the moment `data/phase9-fresh-run.json` goes missing (which is *when*, not *if* — #1), the system loses both its alerts **and its ability to tell you it lost them.** The consolidation needs an explicit exemption list, not a blanket gate. See §13 Q5.

**T3. "Fix the fee gate so it actually blocks."**
Making `run-entertainment-alerts.js:141` filter on `productionAlertAllowed` is the obvious fix and it **silently suppresses a whole tier**. `Math.floor` at `lib/entertainment.js:87` puts the **STANDARD $3 tier below the 3.28-contract floor at prices 0.80 and 0.89** (`test/test-phase9.js:276-280` already asserts this). The run would print "0 eligible" — **indistinguishable from "nothing qualified"**, which is `run-entertainment-alerts.js:143`'s existing message. **If you enable the gate, the suppression must be loud**, and #5 (recompute after scaling) must land in the same change or the gate is enabled and immediately lying.

**T4. "Plumb `publishedAt` through so the leakage check works."**
`run-forecast.js:226` **already** borrows `be.topics[0].claims[0].publishedAt` for any claim missing one. Today the borrowed value is `undefined`, so it is inert. **The moment `lib/bout-evidence.js:37-39` emits `publishedAt`, every undated claim silently inherits another claim's date and is waved through the guard** — the synthetic-timestamp bug, activated by its own fix. **Delete `:226`'s fallback first**, and make `adm.admitted` actually **exclude** claims (`:230` passes raw `be`), or the check remains decorative with a new coat of paint.

**T5. "The tests are green — 792 across 11 suites; keep them green."**
There is no runner. `package.json:9` makes `npm test` exit 1 by design. `node test/*.js` **spends money and mutates the owner's data**: `test-model.js` calls the live `gemini-flash-latest` alias via `lib/extractor.js:139` on every run and gates 4/4 on a nondeterministic LLM; `test-bfo.js` scrapes bestfightodds.com; `test-results-source.js` hits Kalshi + Wikipedia. `test-positions.js:61` and `test-ledger-fixes.js:56` **truncate/delete/rewrite the real tracked `data/positions.json` and `data/pick-ledger.json`** as fixtures and restore from an in-memory backup in a `finally` — **not crash-safe, not concurrency-safe**. `test-cache-safety.js` mkdirs and writes inside the real `data/picks/`. And `test-ledger-fixes.js:70-72` only restores `if (backup != null)` — **on a machine without `data/pick-ledger.json` it leaves a fabricated ledger behind**; it survives today only because the file is committed.
Also: "798 across the 11 offline suites, all passing" **reproduces**; the **"11" boundary is defined nowhere** (CLAUDE.md:70 prose, commit d37e692). Under "every suite that prints a pass/fail counter" it is **13 suites / 829 assertions**, also all passing. Do not build a CI gate around an undocumented set. See §13 Q8.
*(Note on `test-bfo.js` / `test-results-source.js`: they print "VERDICT: NEEDS REVIEW" without `process.exit`, but they are **hand-run** network gates a human reads before funding historical extraction (headers at `test-bfo.js:1-4`, `test-results-source.js:1-2`), no automated consumer exists, and their verdict logic **already refuses on zero coverage**. Adding `process.exitCode = 1` is reasonable latent hardening if a runner appears — not a present defect. Isolate them to `probes/` so a runner never counts them.)*

**T6. "Kalshi lists no method/round markets, so outright is the whole board."**
**Refuted.** This belief is written into `data/phase9-fresh-run.json` ("24 active contracts, all FIGHTER_WINS (Kalshi lists no method/round markets)") and `docs/method-model-plan.md:40-42`. Verification identified sibling series carrying method/round/distance markets on the same bouts (`KXUFCMOF`, `KXUFCMOV`, `KXUFCVICROUND`, `KXUFCROUNDS`, `KXUFCDISTANCE`). `lib/match.js:26` only ever queries `KXUFCFIGHT`. **But do not swing to the opposite error either:** the inventory rests on a probe that is **not reproducible from this repo**, and `lib/kalshi.js:114` silently truncates at 2000 — **the repo structurally cannot answer "what does Kalshi list?" today.** UNKNOWN, needs a cursor-honest enumerator (§13 Q4).
- **Sub-trap A: `KXFIGHTMENTION`.** Per-bout, on the same 2026-07-18 card, **identical event-code convention** (`26JUL18BASDEL`, `26JUL18DUUSM`), 14 markets/event, strikes literally named "Knockout / Knock Out / Knocked Out" and "Decision / Judge" — **but they resolve on what the ANNOUNCERS SAY** ("What will the announcers say during Austin Bashi vs Jose Delgado Fight?"). This is the highest-probability contamination vector for a method-market hunt, and `lib/match.js`'s `SERIES` currently (correctly) cannot see it.
- **Sub-trap B: title-text regexes.** A naive `/KO|TKO|decision|round|distance/` over `title`/`yes_sub_title` returns 8 hits on KXUFCFIGHT — **100% false positives**, all fighter surnames the both-fighters title carries (Seok Hyun **Ko**, Donchen**ko**). Any discovery filter must key on series/`strike_type`/market structure, **never on title text.**

**T7. "Consolidate the two alert ledgers into v2."**
v2's **trigger logic is correct**; its **review-key semantics are broken two ways** and migrating the three existing keys as-is carries the mis-binding forward. `run-entertainment-alerts.js:60` keys `review|${boutId}|${topic}|${about}` — (a) `boutId` re-binds (#3), so `review|…-B01|injury_health|Kevin Holland` now asserts a Holland rumour against **Usman's** bout, and today's eval generates `review|…-B01|injury_health|Kamaru Usman` with **no prev** → `first` fires → **both already-sent rumours re-send**; (b) the key **omits the claim text**, so a genuinely new rumour about the same fighter+topic is silently suppressed as "no material change" — **a withdrawal rumour swallowed because a knee rumour was already sent.** Re-key on identity + claim hash before migrating; do not carry `data/alert-ledger-v2.json` across.

**T8. "Add a commit exit-status check to save-data.sh — it's silently losing data."**
Worth doing, **but not for that reason and not at that priority.** A failed commit does **not** produce a green job: it exits 1 at `.github/save-data.sh:44` via the rebase guard at `:39`, because the failed commit leaves the index dirty and `git rebase` refuses. The residual defect is **diagnostic** — the script prints "REBASE CONFLICT on attempt 1" and "This should be impossible now that the jobs write disjoint files" (`:41-42`) when the cause was a failed commit, **sending an operator to chase a phantom concurrency bug.** File it as a message fix. The real data-loss exposure is **T9/#22**. *(UNSURE on one narrow point: whether an exotic `git commit` failure could fail **and** leave the index clean, which would restore the original path; no such mode was constructible, since a failed commit retains staged content by definition.)*

**T9. "Conflicts are impossible — the jobs write disjoint files" (`save-data.sh:16-20`).** See #22. **This assertion is false and it is the justification for the emergency-exit design.** Do not build the unified path on it.

**T10. "Set DATA_DIR so your runs update the owner's dashboard" (`HANDOFF.md:56-69`).**
With `DATA_DIR` set, `lib/store.js:12-14` redirects outputs outside the repo, `save-data.sh:28`'s `git add -A data/` stages nothing, `:29-32` prints "nothing to save" and **exits 0** — indistinguishable from a genuine no-op. Not a CI defect (no workflow sets it) but a live trap for any unified path that documents it. Either make save-data.sh refuse when `DATA_DIR` is set outside the repo, or delete the instruction.

**T11. "Numerical rules are frozen at v7.0.0 — don't touch lib/forecast.js."**
Correct about the **numbers**. But the freeze is currently protecting two things that are not rules: the **unreachable cap** at `:115-118` (0.28 > 0.28 is never true — decoration presenting as a guard) and the **hardcoded, config-invisible lift threshold** at `:100` (which makes the effective MAJOR origin threshold 3, not the 5 declared in config). **Freezing the numbers must not mean freezing the false statements about the numbers.** Concretely for the unified path: **a lane that calls `buildAdjustments` inherits the bypass; a lane that calls `magnitudeClassFor` does not. Prefer the latter.** And any new lane must define its own cap constants in its own config file, so the frozen v7.0.0 numbers never become a tuning surface for new work.

**T12. "Reuse `pipeline.js --mock` as the safe no-keys self-test."**
`pipeline.js:3-4` documents it as exactly that, and MOCK is carefully guarded against **every write** (`:253`, `:381`, `:389`). It is **not** guarded at the alert block (`:465-477`). **It cannot alert today** — but only because no `lib/mock.js` source can pass `pipeline.js:406`'s `survives && sourceRoiLcb > 0` (all six fixtures: `survives=false`, `testN=0`, `roiLcb` negative; date-independent, `grade.js:176`/`:179` vs mock.js's missing `fightTime`). **That barrier is emergent and undeclared:** no comment at `:465` or in `mock.js` says mock must not alert, and no test asserts it. Anyone adding a `fightTime` and a positive `targetRoi` to `mock.js` to exercise the OOS gate — a plausible future edit — removes the last barrier but the flag, and the sample sources are named "Daniel Cormier" and "Chael Sonnen." *(UNSURE: `node pipeline.js --mock` was not executed end-to-end — it writes via `alertLedger.pruneOld` at `:395`, outside read-only scope. Reachability established by static tracing plus a direct `grade.gradeAll` evaluation, not by observed run.)*

**T13. "Clean up data/ — archive the six stale phase8-shadow `.v*` files."**
**Both directions are wrong until the check is fixed.** `run-phase9-shadow.js:107-109` hard-fails required scenario 5 (`no superseded decision found — lineage is untested`) unless a superseded phase8 record exists, and `lib/dashboard-data.js:363` scans `phase8-shadow-*` with **no card filter** (`:367` derives `superseded` from a **filename regex**). So: **deleting them breaks phase9 → `checkArmingPrerequisites()` blocks → alerts stop.** **Keeping them means any future card's phase9 passes on another card's lineage** — a brand-new card run once through phase8 fails outright, and it passes today only because six stale `2026-07-18.v*` files sit in `data/`. Add the card filter first, then archive. And note the operational consequence: **the cloud must run step 8 at least twice with differing content, or phase9 fails or lies.**

**T14. "Carry positions.json into the unified paper book — it's the track record." — TIME-CRITICAL.**
`data/positions.json` holds **3 open positions the current gate would refuse.** All three are sourced to **"Michael Chiesa"**, who is `type: "fighter"` in `sources.json` and `survives: false` in `data/sources_graded.json` — failing **both** clauses of `pipeline.js:406`. They were opened **before the gate landed** (gate commit `b1399bd` 2026-07-16 15:01:48 UTC; positions opened 2026-07-15T01:46:50Z ×2 and **2026-07-16T15:01:40.724Z — eight seconds before the gate commit**). `lib/positions.js:53-62` `recordOpen` returns null forever once a ticker exists, so **no later run can re-evaluate or withdraw them.** `settlePositions` (pipeline.js:177-195) **will** settle them from Kalshi and their `pnlPct` **will** enter the daily paper summary (pipeline.js:232-243) as though the current system produced them. Because the record stores **no `rulesVersion`** (lib/positions.js:63-73), nothing downstream can tell.
**The fights are 2026-07-18. Tomorrow.** The first numbers this book ever produces will be attributed to a gate that would have refused all three. See §13 Q3.

**T15. "verify-fees.js says FEE CONFIG VERIFIED — the fee model is certified."** See #33. It certifies the taker formula in-scope (genuinely — 7/7 exact, independently re-verified). It does **not** verify the two dimensions its own config disclaims, and it would stamp them verified if handed them.

**T16. "lib/arming.js is the single source of truth, and every alert carries the standing warning."**
`ARMING.standingWarning` (lib/arming.js:38-39) is **dead config** — read by nothing except `test/test-phase9.js:336`, which checks its own wording. Its sentence "Every alert carries this" is unenforced and, taken literally, **false for 7 of the 8 builders**: only `buyInstruction` carries a no-edge warning (lib/telegram-messages.js:303-304), and it is **hardcoded, not read from ARMING**; `experimentalPosition` gets one only if its caller supplies `against` from `reasonsFor` (`:244`). Consolidating on "ARMING is the one place" **without wiring `standingWarning` to the builders keeps the `makerRate` dead-config pattern alive under a new name.** (Minor: `assertNotABettingInstruction` does throw on `standingWarning`'s "edge" — but no code path passes them to each other, and a reworded warning passes. That is a latent collision, not a live gap.)

**T17. "Delete `run-forecast.js`'s SUPERSEDED functions — they're dead code, harmless."**
They are dead (zero call sites) **and** they are the only reason a grep for "who reads the convergence data" returns a hit (`:136`, inside `baselineFromKalshi_SUPERSEDED`) — so anyone auditing listing-watch's consumers gets a false positive. **And `baselineFromBfo_SUPERSEDED:56` contains CLAUDE.md's failure #1 verbatim** (`new Date(sealTs - 2*3600*1000)`) sitting 60 lines above the live path that exists to avoid it, **and it reads the graded pick ledger** (`:44`, `paths.predictions`) inside the forecast runner. Move to `archive/` so old sealed artifacts stay reproducible; do not leave them in the runner, and do not cite `run-forecast.js:44` as evidence the forecast reads the pick ledger — it doesn't, at runtime.

---

## 13. OPEN QUESTIONS — genuinely need the owner's decision

**Q1. Does V1's decision path exist at all in the unified system?**
It runs hourly, records sized paper positions every run, and its thesis failed out-of-sample (0 of 50 survive; CLAUDE.md calls the board archived research). Options: (a) delete the BETS block and the schedules entirely; (b) keep it recording paper positions with **no** alert path and no cloud cron; (c) keep as-is behind the flag. **Cannot be resolved from code** — it turns on whether the paper book has research value worth a standing hourly capability whose only barrier is one boolean. *(Note the sizing path also produces a probability, not just a source selection — §7(d).)*

**Q2. What regenerates `data/phase9-fresh-run.json`, and what does "passed" mean?**
No script writes it. A card-matched, hash-matched, machine-written artifact is the obvious replacement — but the current file records "12/13 admissible baselines (92.3%)" and "tiers A=9 B=3 **D=1**" as `ok: true`. **Is a 92.3% baseline rate a pass? Is a D-tier baseline a pass? Must every stage pass?** UNKNOWN — needs the owner's definition of a passing run before the gate can be rebuilt. Until then the gate should **block**, not carry the current file forward.

**Q3. The three pre-gate Chiesa positions settle into the track record, or get expelled? — decide before 2026-07-18.**
`lib/positions.js:53-62` cannot expel them; expelling is a manual data edit (which this repo's own rules discourage — "recompute tallies, never edit them by hand"); leaving them attributes a repealed gate's picks to the current system in the paper P&L. **A third option** — add `rulesVersion`/`gateVersion` to the record and mark these three `admittedUnder: "pre-b1399bd"` — preserves the history honestly but requires a schema decision now. See T14.

**Q4. Does the unified path pursue non-outright markets?**
The "no method markets exist" premise is **refuted** (sibling series identified: `KXUFCMOF`, `KXUFCMOV`, `KXUFCVICROUND`, `KXUFCROUNDS`, `KXUFCDISTANCE`), but the inventory is **not reproducible from this repo** and `lib/kalshi.js:114` truncates silently. The repo is already half-built for it: `lib/contracts.js:218-232` maps non-outright types and `:289` marks them `UNVALIDATED METHOD MODEL`. **The costs are real and separable:** a cursor-honest enumerator (mandatory regardless — #11), a method model that does not currently exist, and **a fee envelope that does not cover those series** (`FEES.verifiedScope` is `KXUFCFIGHT` / YES / taker only, `lib/contracts.js:42-89`; `:85` explicitly disclaims "any series other than KXUFCFIGHT"). Scope decision. **The enumerator should be built either way** — it is the only thing that makes `phase9-fresh-run.json`'s "Kalshi lists no method/round markets" claim checkable, and `docs/method-model-plan.md:40-42` needs correcting regardless of the answer.

**Q5. Which sends are exempt from arming?**
`ARMING.permits` (lib/arming.js:26) authorizes the **content** of "daily summaries, pipeline failures." But gating the failure alert on arming means the system can die quietly, which `pipeline.js:30` says must not happen. Needs an explicit, written rule. My recommendation (needs your ratification, not my assumption): **failure alerts exempt; everything else gated.** But that means a failure alert can fire from a subsystem the arming gate has disowned — which is a policy call, not a code call.

**Q6. Bout identity: migrate the sealed artifacts, or run the new id alongside?**
The fix (normalized fighter-name pair, order-independent, with `B01` demoted to a display ordinal) is not in doubt. But **every artifact on disk keys on the positional id** (`lib/target-card.js:68`). Migrating breaks the reproducibility of sealed hashes; not migrating carries the re-bind into every historical join. Third option: dual-key going forward and treat pre-migration artifacts as a closed archive. **Needs a decision, because it determines whether the settlement pass (§10.8) can join to anything older than the migration.**

**Q7. Where does `data/evidence/` live?**
Commit it (following `lib/picks-cache.js:24-26`'s reasoning — "only valuable if it is COMMITTED, or every local run is a cold start that re-buys everything the cloud already paid for"), or give it the `BACKUP_MANIFEST.md` treatment (tarball + sha256 + two locations)? **That it has no home today is not in dispute** (§5). The choice is the owner's — it turns on whether the 2.5M / 284 files belong in git history and whether CI needs cache hits on it.

**Q8. What is the "11 suites / 792" set?**
CLAUDE.md:70 asserts it in prose (commit `d37e692`); membership is defined **nowhere** in the codebase or git history. Measured: **798 across the 11 offline suites**, all passing; **829 across 13** under "every suite that prints a pass/fail counter," also all passing. A plausible-but-unwritten rationale for the 11-cut exists (`test-ledger-fixes` and `test-positions` are the only two that mutate `data/`) — **but it is not stated, so it can only be guessed, and by this repo's own standard a guess is a refusal.** Needs the owner to state the set so a runner can produce the number instead of a human typing it.

**Q9. Does `--send` run unattended on a cron?**
"One cloud pipeline" implies the V2 chain moves to Actions. Several things that are currently safe **only by being manual** stop being safe: `run-scenario-eval.js` is the only outcome-loading script and must never be scheduled before a card settles; `run-forecast.js --seal=<ISO>` requires a human-chosen seal timestamp (**UNKNOWN — needs X: what picks the seal time in an unattended run?**); and `run-entertainment-alerts.js --send` is the only armed Telegram path. **The whole arming design assumes a human is in the loop deciding to run step 11.** If that becomes a cron, the `phase9-fresh-run` prerequisite (Q2) is the only thing standing between a scheduler and a buy instruction — and today it is a text file.

**Q10. How long does listing-watch accumulate before an analyzer is written?**
It is the only open experiment (`V2-REFRESH-AUDIT.md:101`). Building an analyzer now produces a verdict from **n=1 event** (7.5h, two births that are the two sides of one fight, one sharp reading each). The **recorder needs two fixes now** regardless (`MAX_SAMPLES` truncating oldest-first, `:35`/`:99`; the `Infinity` staleness bug at `:69`/`:46` fetching BFO every 30 min for unresolved lines). But **when** there is enough data to earn a verdict is a research-patience question, not a code question. UNKNOWN — needs the owner's threshold (n births? weeks of trajectory?).

---

### Bottom line for Phase B

The three things that must be settled before a line of unified code is written:
1. **#1 / Q2** — arming currently rests on a text file no script produces, checked by truthiness, describing a different card than the one on disk. Nothing else in this document matters more.
2. **T1** — the arming consolidation the owner asked for arms the rejected thesis, and the code's own banner tells the next reader to do it.
3. **T14 / Q3** — three positions from a repealed gate settle **tomorrow** into the paper book that will become the unified track record.

And one correction to the repo's stated map of the world: **Kalshi does list non-outright UFC markets** (§11 #11) — but `lib/kalshi.js:114` means this repo cannot yet prove what Kalshi lists, in either direction.