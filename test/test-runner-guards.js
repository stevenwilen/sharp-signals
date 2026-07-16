// Regression tests for the SILENT-EXIT bug.
//
// The original runner buffered all output until the end of an async loop, so any early death
// produced a run with zero output and exit code 0 — a failure wearing a success code, and
// indistinguishable from "there was nothing to do". These tests assert that every way of producing
// nothing now exits NONZERO and says why.
const { execFileSync, execFileSync: run } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const SCRIPT = path.join(__dirname, "..", "run-card-evidence.js");
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? " -> " + extra : ""}`); } };

// run the script and capture {code, out} without throwing
function exec(args) {
  try {
    const out = execFileSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status == null ? -1 : e.status, out: (e.stdout || "") + (e.stderr || "") };
  }
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cardguard-"));
const write = (name, obj) => { const p = path.join(tmp, name); fs.writeFileSync(p, JSON.stringify(obj)); return p; };

console.log("SILENT-EXIT REGRESSION GUARDS");

// 1. THE ORIGINAL BUG: a run that produces nothing must never exit 0.
{
  const r = exec([]);
  ok("no args -> nonzero exit (never a silent success)", r.code !== 0, `code=${r.code}`);
  ok("  ...and it says why", /usage|FATAL/i.test(r.out), JSON.stringify(r.out.slice(0, 60)));
}
// 2. Missing input file is a failure, not an empty success.
{
  const r = exec([path.join(tmp, "nope.json")]);
  ok("missing selection file -> nonzero", r.code !== 0, `code=${r.code}`);
  ok("  ...names the missing file", /not found/i.test(r.out));
}
// 3. Malformed input must fail before any model call.
{
  const p = path.join(tmp, "bad.json"); fs.writeFileSync(p, "{not json");
  const r = exec([p]);
  ok("invalid JSON -> nonzero", r.code !== 0, `code=${r.code}`);
  ok("  ...identifies it as a JSON problem", /valid JSON/i.test(r.out));
}
// 4. Structurally incomplete input must fail before any model call.
{
  const p = write("missing-keys.json", { card: { eventId: "X", eventDate: "2026-01-01", bouts: [{}] } });
  const r = exec([p]);
  ok("selection missing include/byVideo -> nonzero", r.code !== 0, `code=${r.code}`);
  ok("  ...names the missing key", /missing "include"|missing "byVideo"/.test(r.out));
}
// 5. THE CASE THAT MATTERS MOST: zero videos is a legitimate SELECTION outcome, but it is NOT a
//    successful card build. It must exit nonzero AND state the reason — never look like success.
{
  const p = write("empty.json", { card: { eventId: "X", eventDate: "2026-01-01", bouts: [{ boutId: "B1", a: { norm: "a" }, b: { norm: "b" } }] },
    include: [], byVideo: {} });
  const r = exec([p]);
  ok("zero videos selected -> nonzero (not a silent success)", r.code !== 0, `code=${r.code}`);
  ok("  ...states the reason explicitly", /NOTHING TO PROCESS/.test(r.out), r.out.slice(0, 80));
  ok("  ...explains it is a selection result, not a crash", /selection result/.test(r.out));
}
// 6. Inconsistent selection (byVideo references a video include[] never scored) must fail loudly.
{
  const p = write("inconsistent.json", {
    card: { eventId: "X", eventDate: "2026-01-01", bouts: [{ boutId: "B1", a: { norm: "a", aliases: [] }, b: { norm: "b", aliases: [] } }] },
    include: [], byVideo: { ghostvideo: [{ from: 0, to: 10 }] },
  });
  const r = exec([p]);
  ok("byVideo references a video with no include row -> nonzero", r.code !== 0, `code=${r.code}`);
  // it fails at the transcript check or the consistency check; either is a loud, named failure
  ok("  ...and names the problem", /missing|inconsistent|not found/i.test(r.out));
}
// 7. Every failure path prints SOMETHING. The original bug was silence.
{
  for (const [label, args] of [["no args", []], ["missing file", [path.join(tmp, "x.json")]]]) {
    const r = exec(args);
    ok(`${label}: produced output (silence is the bug)`, r.out.trim().length > 0, `out=${JSON.stringify(r.out.slice(0, 40))}`);
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
