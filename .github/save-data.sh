#!/usr/bin/env bash
# Commit data/ back to the repo. Shared by both workflows.
#
# WHY THIS IS NOT THREE LINES OF `git ... || true`:
#
# The old version ended with `git pull --rebase --autostash || true` and `git push || true`.
# The pipeline (every 4h) and the backfill (up to ~6h) are in SEPARATE concurrency groups, so
# they run concurrently by design. When both had written the same JSON file, the rebase hit a
# conflict, halted, `|| true` swallowed it, the push then failed on a detached HEAD, `|| true`
# swallowed THAT — and the step exited 0. The job went GREEN, the runner was destroyed, and a
# five-hour backfill (hundreds of paid transcripts) vanished. Meanwhile backfill.js had already
# Telegrammed "Backfill complete."
#
# A push that fails must fail the job. That is the whole point.
#
# The two jobs no longer write the same files (the pipeline stopped writing sources_graded.json
# and raw_posts.json — those belong to the backfill), and the caches under data/picks/ and
# data/transcripts/ are one-file-per-video, so concurrent runs add disjoint files. Conflicts
# should now be impossible. The retry loop is here for the ordinary case: two jobs pushing at
# the same moment, where one simply needs to rebase onto the other and try again.
set -uo pipefail

WHO="${1:-run}"

git config user.name  "sharp-signals-bot"
git config user.email "actions@github.com"

git add -A data/
if git diff --staged --quiet; then
  echo "nothing to save"
  exit 0
fi

git commit -m "${WHO}: $(date -u '+%Y-%m-%d %H:%M UTC')"

for attempt in 1 2 3 4 5; do
  git fetch origin main || { echo "fetch failed (attempt ${attempt})"; sleep 5; continue; }

  if ! git rebase origin/main; then
    git rebase --abort || true
    echo "REBASE CONFLICT on attempt ${attempt}."
    echo "This should be impossible now that the jobs write disjoint files."
    echo "Failing loudly rather than guessing which side to keep."
    exit 1
  fi

  if git push origin HEAD:main; then
    echo "pushed (attempt ${attempt})"
    exit 0
  fi

  echo "push rejected (attempt ${attempt}) — someone else pushed first; rebasing and retrying"
  sleep $((attempt * 5))
done

echo "FAILED TO PUSH after 5 attempts. Data for this run is NOT saved."
exit 1
