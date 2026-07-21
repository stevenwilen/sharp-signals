// COMPLETENESS SCOPING — refusal-first. A video that did not read completely is REFUSED whole (never
// banked partial); a card only refuses on a SYSTEMIC failure. This pins the fix for the 2026-07-21
// stall, where one unparseable chunk in one video fatally killed evidence for a whole 26-bout card.
const { videoReadVerdict, cardReadVerdict } = require("../lib/read-completeness");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; process.stdout.write(`  PASS  ${m}\n`); } else { fail++; process.stdout.write(`  FAIL  ${m}\n`); } };

// ---- videoReadVerdict: a video is bankable only if EVERY range read completely ----
{
  const v = videoReadVerdict([{ complete: true, unprocessed: [] }, { complete: true, unprocessed: [] }]);
  ok(v.complete === true && v.incompleteRanges.length === 0, "1. every range complete -> video is bankable");
}
{
  const v = videoReadVerdict([{ complete: true, unprocessed: [] }, { complete: false, unprocessed: [[4010, 8423]] }]);
  ok(v.complete === false, "2. one incomplete range -> whole video REFUSED (never a partial bank)");
  ok(v.incompleteRanges.length === 1 && JSON.stringify(v.incompleteRanges[0].unprocessed) === "[[4010,8423]]",
    "2b. the unprocessed range is carried through for the record");
}
// 3. MISSING DATA IS A REFUSAL: absent/garbage coverage is treated as INCOMPLETE, never as complete.
ok(videoReadVerdict([{ complete: undefined }]).complete === false, "3. undefined completeness -> REFUSED (missing data is not a pass)");
ok(videoReadVerdict([{}]).complete === false, "3b. empty coverage object -> REFUSED");
ok(videoReadVerdict([null]).complete === false, "3c. null range result -> REFUSED");
ok(videoReadVerdict([{ complete: "yes" }]).complete === false, "3d. truthy-but-not-true completeness -> REFUSED (strict === true)");
// 4. A video with no ranges is vacuously complete (selection guarantees ranges; this must not crash).
ok(videoReadVerdict([]).complete === true, "4. zero ranges -> vacuously complete (no crash)");
ok(videoReadVerdict(undefined).complete === true, "4b. missing rangeResults -> handled, not thrown");

// ---- cardReadVerdict: refuse the whole card ONLY on a systemic majority-drop ----
ok(cardReadVerdict({ videoCount: 13, droppedCount: 0 }).ok === true, "5. nothing dropped -> card proceeds");
ok(cardReadVerdict({ videoCount: 13, droppedCount: 1 }).ok === true, "6. one bad video of 13 -> card STILL proceeds (the whole point)");
ok(cardReadVerdict({ videoCount: 4, droppedCount: 2 }).ok === true, "7. exactly half dropped -> proceeds on the readable half");
ok(cardReadVerdict({ videoCount: 4, droppedCount: 3 }).ok === false, "8. strict majority dropped -> card REFUSED (systemic)");
ok(cardReadVerdict({ videoCount: 3, droppedCount: 3 }).ok === false, "9. every video dropped -> card REFUSED (systemic)");
ok(cardReadVerdict({}).ok === true, "10. no videos -> vacuously ok (earlier guards handle empty selection)");

process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
process.exit(fail ? 1 : 0);
