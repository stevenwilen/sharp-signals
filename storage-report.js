// STORAGE REPORT — a READ-ONLY audit of data/. Writes nothing; prints a breakdown so storage decisions
// are made on ground truth, not guesses. Distinguishes:
//   COMMITTED corpus  — tracked in git ON PURPOSE (transcripts/picks/evidence persist the corpus between
//                       ephemeral cloud runs). Heavy but deliberate; pruning it is a reviewed tradeoff.
//   LOCAL cache       — gitignored + re-fetchable (wiki/bfo/backups). Safe to cap/evict locally; the
//                       cloud re-fetches it every run, so this only reclaims local disk.
//   VERSIONED seals   — *.vNNN.json intermediates kept for provenance; prunable-with-review per card.
//
//   node storage-report.js
require("./lib/env");
const fs = require("fs");
const path = require("path");
const { paths } = require("./lib/store");

const DATA = paths.data;
// From .gitignore: these data subdirs are IGNORED (local, re-fetchable). Everything else under data/ is
// tracked. Kept in sync with .gitignore by hand; storage-report is advisory, not authoritative.
const LOCAL_CACHE_DIRS = new Set(["wiki", "bfo", "backups"]);
const COMMITTED_CACHE_DIRS = new Set(["transcripts", "picks", "evidence"]);
const MB = (b) => b / 1048576;
const fmt = (b) => `${MB(b).toFixed(1)} MB`;

// Fast in-process walk (avoids spawning a stat per file). Returns { bytes, files }.
function measure(dir) {
  let bytes = 0, files = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else { try { bytes += fs.statSync(p).size; files++; } catch {} }
    }
  }
  return { bytes, files };
}

const top = fs.readdirSync(DATA, { withFileTypes: true });
const dirs = [], looseFiles = [];
for (const e of top) {
  if (e.isDirectory()) dirs.push(e.name);
  else looseFiles.push(e.name);
}

let committedCache = 0, localCache = 0, other = 0, totalFiles = 0;
const rows = [];
for (const name of dirs) {
  const { bytes, files } = measure(path.join(DATA, name));
  totalFiles += files;
  const kind = LOCAL_CACHE_DIRS.has(name) ? "LOCAL cache (re-fetchable)" : COMMITTED_CACHE_DIRS.has(name) ? "COMMITTED corpus" : "other";
  if (kind.startsWith("LOCAL")) localCache += bytes; else if (kind === "COMMITTED corpus") committedCache += bytes; else other += bytes;
  rows.push({ name: `${name}/`, bytes, files, kind });
}
// loose JSON artifacts
let looseBytes = 0, versioned = 0, versionedBytes = 0;
for (const f of looseFiles) {
  const b = (() => { try { return fs.statSync(path.join(DATA, f)).size; } catch { return 0; } })();
  looseBytes += b; totalFiles++;
  if (/\.v[0-9a-f]+\.json$/.test(f)) { versioned++; versionedBytes += b; }
}
other += looseBytes;
rows.push({ name: "(loose *.json artifacts)", bytes: looseBytes, files: looseFiles.length, kind: `other · ${versioned} versioned seals = ${fmt(versionedBytes)}` });

rows.sort((a, b) => b.bytes - a.bytes);
const total = committedCache + localCache + other;

const say = (s) => process.stdout.write(s + "\n");
say(`\nSTORAGE REPORT — ${DATA}`);
say(`  total: ${fmt(total)} across ${totalFiles} files\n`);
say(`  by area:`);
for (const r of rows) say(`    ${fmt(r.bytes).padStart(9)}  ${String(r.files).padStart(6)} files  ${r.name.padEnd(28)} ${r.kind}`);
say(`\n  rollup:`);
say(`    COMMITTED corpus (deliberate, in git):   ${fmt(committedCache)}  — pruning is a reviewed tradeoff (audit vs weight)`);
say(`    LOCAL cache (gitignored, re-fetchable):  ${fmt(localCache)}  — safe to cap/evict locally (prune-local-caches.js)`);
say(`    other artifacts/state:                   ${fmt(other)}  (${versioned} versioned seals = ${fmt(versionedBytes)})`);
say(`\n  levers, safest first:`);
say(`    1. prune-local-caches.js --apply         reclaims up to ${fmt(localCache)} of LOCAL disk, zero git/audit impact`);
say(`    2. compress settled-card corpus (gzip)   biggest systemic win (${fmt(committedCache)}); needs reader changes + your sign-off`);
say(`    3. prune old versioned seals             ${fmt(versionedBytes)}; keep canonical + latest per card`);
process.exit(0);
