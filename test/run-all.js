// RUN EVERY TEST. `npm test`.
//
// The house rule is "tests assert refusals, and you keep them green" — but until now nothing actually
// ran them: there was no runner and no CI step, so green was an article of faith. Each test file is a
// standalone process that exits non-zero on failure; this runs them all and fails on the first
// non-zero exit it collects, printing the full roster either way.
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const DIR = __dirname;
const files = fs.readdirSync(DIR).filter((f) => /^test-.*\.js$/.test(f)).sort();
if (!files.length) { console.error("FATAL: no test files found — a runner that tests nothing must not pass"); process.exit(1); }

// Exit 3 means SKIPPED — a test that needs live API keys and has none (test-model.js). It is not a
// pass and must never be counted as one, but failing the suite (and now the whole cloud pipeline) over
// a secret the test step deliberately does not get would be worse. Skips are printed, counted, and
// listed again at the end so they cannot quietly become permanent.
const SKIP = 3;

const failed = [], skipped = [];
const t0 = Date.now();
for (const f of files) {
  const r = spawnSync(process.execPath, [path.join(DIR, f)], { cwd: path.join(DIR, ".."), encoding: "utf8" });
  const out = `${r.stdout || ""}${r.stderr || ""}`;
  if (r.status === SKIP) { skipped.push({ f, out }); process.stdout.write(`  skip  ${f}\n`); continue; }
  const okRun = r.status === 0;
  if (!okRun) failed.push({ f, status: r.status, out });
  process.stdout.write(`${okRun ? "  ok  " : "  FAIL"}  ${f}\n`);
}

const ran = files.length - skipped.length;
process.stdout.write(`\n${ran - failed.length}/${ran} test files passed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
process.stdout.write(skipped.length ? ` (${skipped.length} skipped: ${skipped.map((x) => x.f).join(", ")})\n` : "\n");
for (const x of skipped) process.stdout.write(`  ${x.f}: ${x.out.trim().split("\n")[0]}\n`);
for (const x of failed) {
  process.stdout.write(`\n===== ${x.f} (exit ${x.status}) =====\n${x.out.trim()}\n`);
}
process.exit(failed.length ? 1 : 0);
