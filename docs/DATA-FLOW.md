# Data Flow

The single production decision path. The hourly workflow `unified-v2.yml` runs `node dispatch.js`, which
self-heals missed crons (GitHub fires ~14–40% of a public-repo schedule) and spawns the SAME tested
scripts the manual path uses — there is no second, simplified cloud implementation.

## The canonical pipeline (dispatch.js stages)

```
V1 SENSING  (pipeline.yml, hourly): lib/youtube.findVideos → lib/blotato.getTranscript → data/transcripts/*.txt
                                     (feeds V2's evidence base via the shared transcript cache)
        │
        ▼
COLLECT     make-card-selection.js   (data/predictions.json + Kalshi card → card-selection-<date>.json)
            run-card-evidence.js      (data/transcripts/*.txt + data/evidence cache → card-evidence-<date>.json)
        │
        ▼
EVALUATE    run-evidence-eval.js      → evidence-eval-<date>.json   [SEALED]
                                        (origins-not-voices dedupe, leakage admission, topic/mechanism eval)
        │
        ▼
FORECAST    run-baselines.js          (Kalshi + odds-history + live sportsbook → baselines.json)
            run-forecast.js --seal=auto --live
                                        core v7.0.0 + capped creative exploration + market prior
                                        → forecast-<date>.json   [IMMUTABLE, hash-last; prior → .v<ts>.json]
            run-phase7-seal.js / run-seal-scenarios.js  (scenario + uncertainty output, sealed)
            run-phase8-shadow.js      (contract mapping + executable-price/fee/liquidity checks, disk-only)
            run-attest.js --write     → attestation.json  (machine attestation the arming gate checks)
        │
        ▼
DECIDE+SEND run-entertainment-alerts.js --send   THE single armed mouth (see arming below)
            run-intel.js              fight-intelligence lifecycle → intelligence-<date>.json,
                                        combined/threaded Telegram, market before/after snapshots
        │
        ▼
GRADE       run-grade-card.js         → learning-ledger.json (append-only) → mechanism-reliability.json
(post-      run-scenario-eval.js      (grades the sealed scenario set against real outcomes)
 settle)    run-convergence-eval.js   → convergence-eval.json
```

Two satellites reuse the same tested scripts on their own cadence:
- **fight-day-sentinel.yml** (Fri/Sat) loops `run-entertainment-alerts.js` (+ shadow `run-intel.js`) on
  a 15-min wall-clock cadence hourly cron cannot provide.
- **listing-watch.yml** (every 30 min) records Kalshi birth-price/convergence → `listing-watch.json`
  (read by `run-forecast.js` and `run-convergence-eval.js`). Research only; never bets.

`server.js` serves the read-only dashboard from the sealed/operational stores.

## The arming gate (the only place a bet instruction leaves)

`run-entertainment-alerts.js --send` sends only when **all** hold:
`ARMING.ALERTS_ARMED` (committed) **&&** `checkArmingPrerequisites` (attestation matches this card +
sealHash, fresh, machine-written) **&&** `SHARP_PRODUCTION=1` (repo variable) — plus
`assertNoTradingPath()`. Kalshi is read-only throughout.

## Store classes (one canonical location each)

| Class | Stores |
|---|---|
| **IMMUTABLE_SEALED** | `forecast-<date>.json` (+`.v<ts>`), `evidence-eval-<date>.json`, `card-evidence-<date>.json`, `scenarios-ranked-<date>.json`, `phase7/8-<date>.json`, `attestation.json` |
| **APPEND_ONLY_LEARNING** | `learning-ledger.json`, `mechanism-reliability.json`, `convergence-eval.json` |
| **MUTABLE_OPERATIONAL** | `alert-ledger-v2.json` (atomic write), `manual-bankroll.json` (real money), `positions.json` (paper), `intelligence-<date>.json`, `dispatch-receipts.json`, `listing-watch.json` |
| **REBUILDABLE_CACHE** | `data/transcripts/`, `data/evidence/`, `data/picks/`, `data/bfo/`, `data/wiki/` |
| **ARCHIVED_RESEARCH** | `predictions.json`, `sources_graded.json`, `signals.json`, `raw_posts.json`, `pick-ledger.json` (V1 corpus; not read by V2 decisions) |

**Persistence** = git. `.github/save-data.sh` commits `data/` and rebases onto `origin/main` before
pushing, failing loudly on conflict. Sealed records are never overwritten (hash-last + `.v<ts>`
preservation). `DATA_DIR` is **not fully supported** — some stores honor it, some hardcode `data/`; do
not point it at a synced folder without unifying first.
