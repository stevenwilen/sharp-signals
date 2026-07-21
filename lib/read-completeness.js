// COMPLETENESS SCOPING — a selected video is bankable ONLY if EVERY one of its selected ranges read
// completely. One chunk the extractor cannot parse drops the whole VIDEO (never a partial bank) — but
// it must NOT drop the whole CARD. These decisions are pure + unit-tested because the old inline guard
// scoped a correct refusal catastrophically: on 2026-07-21 a single unparseable chunk in ONE video
// (TelKi7EaLL0) called process.exit(2) inside run-card-evidence and froze collect/forecast/alerts for
// the ENTIRE 26-bout card for a day. Dropping a video is fail-CLOSED: strictly less evidence, never
// more, so the origins-not-voices magnitude can only shrink, never inflate.

// A video is complete iff every range read completely. Missing/undefined coverage is treated as
// INCOMPLETE, never as complete — missing data is a refusal, not a pass.
function videoReadVerdict(rangeResults) {
  const results = Array.isArray(rangeResults) ? rangeResults : [];
  const incompleteRanges = results
    .map((r, i) => ({ i, complete: !!(r && r.complete === true), unprocessed: (r && r.unprocessed) || [] }))
    .filter((r) => !r.complete);
  return { complete: incompleteRanges.length === 0, incompleteRanges };
}

// Refuse the whole card only when the failure is SYSTEMIC — strictly more videos unreadable than
// readable (a model/quota outage), not the isolated bad chunk this scoping exists to survive. Exactly
// half dropped still proceeds on the readable half; a strict majority refuses.
function cardReadVerdict({ videoCount = 0, droppedCount = 0 } = {}) {
  const survivors = videoCount - droppedCount;
  if (droppedCount > 0 && droppedCount > survivors)
    return { ok: false, why: `dropped ${droppedCount}/${videoCount} videos for incomplete reads — systemic extraction failure, not isolated bad content` };
  return { ok: true, why: null };
}

module.exports = { videoReadVerdict, cardReadVerdict };
