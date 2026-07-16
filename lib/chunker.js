// TRANSCRIPT CHUNKER — provable coverage, structural boundaries.
//
// WHY THIS EXISTS: the unchunked extractor returned raw=14 claims from an 87k transcript AND raw=14
// from a 359k one. Identical counts from a 4x length difference is an OUTPUT CEILING, not a claim
// count — the model was answering "give me a reasonable list", not "extract everything". So the
// yield was never representative and must not be treated as one. Chunking moves the limit from
// per-transcript to per-chunk, where it can actually be satisfied.
//
// WHAT THE TRANSCRIPTS ACTUALLY ARE (measured, not assumed):
//   - NO timestamps. 0 of 6,999 carry any time pattern, so time windows are impossible; we use
//     character windows sized to ~12 minutes of speech (~150wpm ≈ 12k chars) to honour the intent.
//   - Speaker turns DO exist, double-escaped as "&amp;gt;&amp;gt;", in 2,739 transcripts (39%).
//     Where present they are the best boundary available: a claim rarely straddles a speaker change.
//   - Sentence ends are dense (~1 per 60-85 chars), so a clean split is always within reach and we
//     never cut mid-sentence.
//
// COVERAGE IS THE CONTRACT: chunks are emitted such that every character of the transcript belongs
// to at least one chunk, and verifyCoverage() proves it rather than trusting it. A gap would be a
// silently unread range — the exact class of loss this project keeps finding after the fact.

const SPEAKER = /&amp;gt;&amp;gt;|&gt;&gt;|>>/g;

// ~12 minutes of speech at ~150 wpm ≈ 12,000 chars; ~2 minutes of overlap ≈ 2,000 chars.
// Overlap exists so a claim spoken across a boundary is seen whole by at least one chunk; the
// duplicates it creates are the deduper's problem, and duplicates are cheaper than lost claims.
const DEFAULTS = { targetChars: 12000, overlapChars: 2000, minChunk: 1500 };

// Boundary offsets in TWO TIERS.
//
// Speaker turns are the better split (a claim rarely straddles a speaker change) but they are not
// evenly spread: the 394k podcast has a 31,999-char stretch without a single one. Snapping to
// speakers alone therefore fell through to a raw character cut in exactly those regions, slicing
// sentences — and a claim cut in half is a claim lost from both chunks. Sentence ends are dense
// (~1 per 60-85 chars) and always reachable, so they backstop the gaps.
function boundaries(text) {
  let m;
  const speakers = [];
  SPEAKER.lastIndex = 0;
  while ((m = SPEAKER.exec(text))) speakers.push(m.index);

  const sent = [];
  const re = /[.!?]\s/g;
  while ((m = re.exec(text))) sent.push(m.index + 1);

  const nl = [];
  const rn = /\n/g;
  while ((m = rn.exec(text))) nl.push(m.index);

  const fallback = sent.length >= 4 ? sent : nl;
  // speaker turns are only the primary tier if dense enough to land near our targets
  const dense = speakers.length >= Math.max(4, text.length / 20000);
  if (dense) return { kind: "speaker-turn", offsets: speakers, fallback, fallbackKind: sent.length >= 4 ? "sentence" : "line-break" };
  if (sent.length >= 4) return { kind: "sentence", offsets: sent, fallback: nl, fallbackKind: "line-break" };
  if (nl.length >= 4) return { kind: "line-break", offsets: nl, fallback: [], fallbackKind: "none" };
  return { kind: "hard-cut", offsets: [], fallback: [], fallbackKind: "none" };
}

const MAX_BACKSTEP = 3000; // how far back a primary boundary may pull us before we prefer a closer fallback

// Nearest clean split at or before `want`, never at/before `floor`.
// Tries the primary tier; if the best primary sits more than MAX_BACKSTEP behind `want` (or there is
// none), takes the nearest fallback instead. Returns `want` only when the text has no structure at all.
function snap(offsets, want, floor, fallback = []) {
  const last = (arr) => {
    let best = -1;
    for (const o of arr) { if (o > want) break; if (o > floor) best = o; }
    return best;
  };
  const p = last(offsets);
  if (p > floor && p >= want - MAX_BACKSTEP) return p;
  const f = last(fallback);
  if (f > floor && (p < 0 || f > p)) return f;   // a closer clean split than the primary offered
  return p > floor ? p : want;
}

// chunk(text, opts) -> { chunks: [{id, startChar, endChar, text, approxMinute}], meta }
// Every character belongs to >= 1 chunk. Chunks overlap by ~overlapChars.
function chunk(text, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const len = text.length;
  const b = boundaries(text);
  const chunks = [];

  if (len <= o.targetChars) {
    chunks.push({ id: 0, startChar: 0, endChar: len, text, approxMinute: 0 });
    return { chunks, meta: coverageMeta(text, chunks, b, o) };
  }

  // ADVANCE BY A FIXED STEP, never by "end minus overlap".
  //
  // The first version derived the next start from the SNAPPED end. Boundaries are not evenly
  // spaced — this transcript has a 31,999-char stretch with no speaker turn — so when a snap pulled
  // an end backwards, the next start followed it back, and the chunks crawled: starts advanced by
  // as little as 37 characters, producing 77 chunks instead of ~40 and re-extracting the same
  // speech many times. Cost doubles and the deduper is handed avoidable work.
  //
  // Stepping a fixed distance makes progress independent of where the end happened to land; the end
  // snap only ever trims the tail we read, never the pace we advance.
  const step = Math.max(o.minChunk, o.targetChars - o.overlapChars);
  let start = 0, id = 0;
  while (start < len) {
    const wantEnd = Math.min(start + o.targetChars, len);
    // snap the END to a boundary, but never so far back that the chunk becomes tiny
    const end = wantEnd >= len ? len : snap(b.offsets, wantEnd, start + o.minChunk, b.fallback);
    chunks.push({
      id, startChar: start, endChar: end, text: text.slice(start, end),
      approxMinute: Math.round(start / 12000 * 12), // ~150wpm; ESTIMATE only, no real timestamps exist
    });
    if (end >= len) break;

    // Next start: a fixed step forward, clamped to `end` so a gap is impossible, snapped to a
    // boundary for a clean read, and guaranteed to move.
    let want = Math.min(start + step, end);
    let next = snap(b.offsets, want, start, b.fallback);
    if (next <= start) next = want;   // no boundary in range -> take the raw offset
    if (next <= start) next = end;    // still stuck -> jump to end: no overlap, but always progress
    start = next;
    id++;
  }
  return { chunks, meta: coverageMeta(text, chunks, b, o) };
}

function coverageMeta(text, chunks, b, o) {
  return {
    totalChars: text.length,
    chunks: chunks.length,
    boundaryKind: b.kind,
    boundaryCount: b.offsets.length,
    targetChars: o.targetChars,
    overlapChars: o.overlapChars,
    approxMinutes: Math.round(text.length / 12000 * 12),
  };
}

// PROVE coverage rather than assume it. Returns every uncovered range; [] means complete.
// A transcript with ANY gap must not be marked complete — an unread range is an invisible hole in
// the evidence base, and it looks exactly like "the analyst didn't say anything there".
function verifyCoverage(textLen, chunks) {
  const sorted = chunks.slice().sort((a, b2) => a.startChar - b2.startChar);
  const gaps = [];
  let cursor = 0;
  for (const c of sorted) {
    if (c.startChar > cursor) gaps.push({ from: cursor, to: c.startChar });
    cursor = Math.max(cursor, c.endChar);
  }
  if (cursor < textLen) gaps.push({ from: cursor, to: textLen });
  const covered = textLen - gaps.reduce((s, g) => s + (g.to - g.from), 0);
  return { complete: gaps.length === 0, gaps, coveredChars: covered, totalChars: textLen };
}

module.exports = { chunk, verifyCoverage, boundaries, DEFAULTS };
