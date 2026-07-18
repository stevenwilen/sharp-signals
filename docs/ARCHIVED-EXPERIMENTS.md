# Archived Experiments

These approaches were tried and **rejected**. They are kept for reproducibility and to stop anyone
re-discovering them as if new. **None is a current betting signal.** The code lives under
`archive/v1-research/`-adjacent paths and the still-present V1 scripts (`pipeline.js`, `backfill.js`,
the `diag-*`/`regrade*` CLIs); the docs live under [archive/docs-v1/](../archive/docs-v1/).

## Rejected: the V1 guru / beat-the-line thesis

The original product followed a roster of MMA-prediction YouTube/Twitter "gurus," graded their picks
against closing lines, and sized paper bets on the highest-ranked sources.

- A 24-month backfill graded **~12,600 picks across ~50 sources**. Out of sample, **0 of 50 sources**
  survived with an edge that generalized; average result ≈ break-even-to-negative after vig.
- The guru track-record board is therefore **archived research, not a signal**. `pipeline.js` still
  records these as **paper** positions ($0 real money, excluded from real-bankroll P&L) purely as an
  out-of-sample scoreboard, and no longer sends its own Telegram by default.

## Rejected hypotheses / contaminated evaluations

- **Conviction sizing** — sizing up on a source's high-confidence picks did not improve out-of-sample
  results; it amplified variance without edge.
- **Age signal** — fighter-age as a standalone edge did not generalize.
- **Closing-line contamination** — the one evaluation that appeared to show an edge was **void**: it
  compared a backdated closing line to itself (the "synthetic timestamp" bug). Never trust a result
  built on a fabricated timestamp; absence is the truthful value.
- **Opening-line vs live-price mismatch** — treating an opening line and a later live price as the same
  observation manufactured phantom edges; the forecast now fails closed on asynchronous prices.
- **Amplification-as-corroboration** — counting ten channels repeating one report as ten origins. The
  whole "origins, not voices" machinery exists to refuse this.

## Why V1 sensing is kept

The V1 collection layer (YouTube discovery → transcript fetch) is the only live harvester feeding V2's
evidence base via the shared `data/transcripts` cache, and `backfill.js` is the sole writer of
`data/predictions.json` (V2's candidate-video universe). So V1 **sensing** continues; V1 **betting/
decision** logic is inert and cannot alert (see `test/test-v1-no-buy-alert.js`).

## Recoverability

Everything here is recoverable: the V1 scripts still run manually (`workflow_dispatch`), the corpus is
committed, and the rollback tags (`rollback-<date>-<commit>`) restore any prior deployed state. Nothing
was deleted that is needed to interpret a historical sealed artifact.
