# Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| **Red GitHub workflow** | A stage exited non-zero; `dispatch.js` throws on a hard failure so a bad run never looks green. | Open the run log, find the failing `[run] node …` stage. A partial run **never sends a betting instruction** — the alert stage runs only after a clean forecast + attestation. |
| **Missing Telegram message** | `SHARP_PRODUCTION` unset, arming attestation stale/mismatched, or the record was correctly deduped (nothing material changed). | Check the run log for `mode=SHADOW`/`send=false` and the `[intel] N sent` line. Confirm `SHARP_PRODUCTION=1` and a fresh `attestation.json` matching the sealed forecast. NO BET / no material change is a valid silent outcome. |
| **Duplicate alert** | Two jobs (sentinel + dispatcher) wrote `alert-ledger-v2.json` and a rebase dropped an "already sent" record. | The ledger now writes atomically and `record()` reloads before writing its own key; if a dupe still appears, check for a `save-data.sh` rebase conflict on `alert-ledger-v2.json` in the run log. |
| **Stale dashboard** | Server is reading an older sealed artifact, or the cloud commit didn't land. | `git pull`; confirm the latest `forecast-<date>.json` / `intelligence-<date>.json` are committed. The dashboard **reads sealed artifacts only** — it never recomputes, so it lags the cloud commit, not the truth. |
| **Missing artifact** | A stage was skipped (not due) or `data/transcripts/*.txt` was absent so `run-card-evidence.js` failed closed. | Transcripts are fed by `pipeline.yml` (V1 sensing). If evidence is starved, run `pipeline.yml` (or `backfill.yml` for the candidate-video corpus) manually. A script that exits 0 without its artifact is treated as a failure. |
| **Incorrect price** | A stale or asynchronous Kalshi/sportsbook read. | Prices fail closed: `run-forecast --seal=auto` fixes the seal AFTER the live fetch so every quote provably predates it; a post-seal quote is refused as leakage. Re-run the forecast stage. |
| **Failed attestation** | `attestation.json` doesn't match the active card + sealHash, is stale (>TTL), or wasn't machine-written. | Re-run the forecast stage (it re-attests via `run-attest.js --write`). The arming gate is *meant* to refuse a mismatched attestation — that is the safety working. |
| **Persistence conflict** | Two workflows committed `data/` concurrently and `save-data.sh` couldn't rebase. | Re-run; `save-data.sh` retries the rebase and fails loudly rather than silently dropping state. Sealed files never overwrite (hash-last + `.v<ts>`). |
| **Quarantined position showing in performance** | It shouldn't. | Quarantined entries (`run-quarantine-positions.js`, `includedInPerformance:false`) are excluded from P&L and learning by construction. If one appears, check its provenance fields. |
| **A report needs a source the cloud can't reach** | Private/authenticated link; the researcher marked it `HUMAN_ACTION_REQUIRED`. | Optional fallback: `/verify-news`, then `run-inject-verified.js` (dry run first). Not needed for normal operation. |
| **`--live-event=/events/x` mangled to `C:/Program Files/Git/...`** | Git Bash path rewriting of a leading-slash arg. | Quote it or use `--live-event=events/x`; it's a shell artifact, not a data outage. |

## Known gaps (documented, low-impact)

- **`DATA_DIR` split-brain:** some stores honor `DATA_DIR`, some hardcode `data/`. Do not point
  `DATA_DIR` at a synced folder without unifying — the real-money ledger and the forecasts could split.
- **Candidate-video freeze:** `make-card-selection.js` draws from `data/predictions.json`, written only
  by the manual `backfill.js`. Fresh videos for a new card require a manual backfill run. This is
  deliberate (the guru corpus is frozen); do **not** "fix" it by re-enabling backfill's schedule.
