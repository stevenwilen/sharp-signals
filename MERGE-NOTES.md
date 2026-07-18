# Merge notes — review/unified-v2-repairs ⇄ origin/main

The cloud (V1 workflows on old code) keeps committing `data/*` every hour. When this branch merges
`origin/main`, the **only** file that conflicts is `data/positions.json` — the paper-trade ledger,
which both sides write. This note is the standing resolution so the merge is never guessed.

## Why it conflicts

- **This branch** quarantined the three Michael Chiesa positions (opened under the repealed
  pre-`b1399bd` gate) and rewrote `lib/positions.js` to a full lifecycle
  (ACTIVE/WITHDRAWN/SUPERSEDED/QUARANTINED/SETTLED) with provenance.
- **origin/main** runs the old `pipeline.js`, which still writes those positions as plain `open`.

## The resolution (apply every time)

Take **ours** (the quarantined ledger) as the base, because it is a strict superset — the pre-quarantine
state is preserved verbatim under each row's `quarantine.originalRecord`. Then reconcile field-by-field:

1. **Preserve every quarantined position.** Never let a merge restore one to `active`/`open`.
2. **Preserve `quarantine.originalRecord`** (the byte-for-byte pre-quarantine snapshot).
3. **Preserve `includedInPerformance: false`, `includedInLearning: false`, `includedInSourceScoring: false`.**
4. **Carry forward newer harmless metadata** — take the later `meta.lastSummaryDate` (a duplicate-send
   guard; the cloud may have sent a summary this branch doesn't know about).
5. **Preserve any genuinely new settlement or position** the cloud opened that this branch lacks — add
   it, do not drop it. (At the 2026-07-18 deploy there were none: identical ticker set, no settlements,
   fights not yet run.)
6. **Never fabricate.** If a field cannot be reconciled from the two sides, stop and inspect — do not
   invent a value.

## Mechanics

```
git merge origin/main --no-edit          # conflicts on data/positions.json
git checkout --ours data/positions.json  # quarantined ledger as the base
# then, in a script, carry forward the newer meta.lastSummaryDate and any new cloud rows:
node -e '...'                            # (see the deploy transcript for the exact reconcile)
git add data/positions.json
git commit --no-edit
```

## Always re-run after resolving

```
node test/test-quarantine.js
node test/test-position-lifecycle.js
node run-entertainment-alerts.js data/forecast-<card>.json --eval=data/evidence-eval-<card>.json  # TEST mode
```

and confirm `positions.counts()` shows the three still `quarantined` with `countsInPerformance === false`.

## Do not

- Force-push or rewrite published history.
- Blindly `checkout --theirs` (restores the quarantined positions to open).
- Blindly `checkout --ours` without carrying forward the cloud's newer `lastSummaryDate` / new rows.
