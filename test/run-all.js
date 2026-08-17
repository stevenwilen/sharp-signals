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

const failed = [];
const t0 = Date.now();
for (const f of files) {
  const r = spawnSync(process.execPath, [path.join(DIR, f)], { cwd: path.join(DIR, ".."), encoding: "utf8" });
  const okRun = r.status === 0;
  if (!okRun) failed.push({ f, status: r.status, out: `${r.stdout || ""}${r.stderr || ""}` });
  process.stdout.write(`${okRun ? "  ok  " : "  FAIL"}  ${f}\n`);
}

process.stdout.write(`\n${files.length - failed.length}/${files.length} test files passed in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
for (const x of failed) {
  process.stdout.write(`\n===== ${x.f} (exit ${x.status}) =====\n${x.out.trim()}\n`);
}
process.exit(failed.length ? 1 : 0);
