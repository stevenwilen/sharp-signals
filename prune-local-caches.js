// PRUNE LOCAL CACHES — evicts stale entries from the gitignored, RE-FETCHABLE caches only
// (data/wiki, data/bfo, data/backups). These are not committed; the cloud re-fetches them every run, so
// this only reclaims LOCAL disk and can NEVER affect git history, the committed corpus, or an audit trail.
//
// FAILS CLOSED: it refuses to touch any path outside the allow-listed cache dirs, and it is DRY-RUN by
// default — it prints what it would delete and changes nothing unless you pass --apply.
//
//   node prune-local-caches.js                 # dry run, default policy (older than 30 days)
//   node prune-local-caches.js --older-than=14 # evict entries not modified in 14 days
//   node prune-local-caches.js --apply         # actually delete
require("./lib/env");
const fs = require("fs");
const path = require("path");
const { paths } = require("./lib/store");

// ALLOW-LIST (not a deny-list): only these re-fetchable caches are ever eligible. Anything else is refused.
const ALLOWED = ["wiki", "bfo", "backups"];
const arg = (n, d) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d; };
const APPLY = process.argv.includes("--apply");
const OLDER_DAYS = Number(arg("older-than", "30"));
const cutoffMs = Date.now() - OLDER_DAYS * 86400e3;
const say = (s) => process.stdout.write(s + "\n");
const MB = (b) => (b / 1048576).toFixed(1);

// Resolve + assert a cache dir really lives under data/ and is allow-listed — a hard guard against a path
// that escapes the intended targets.
function safeDir(name) {
  const p = path.resolve(paths.data, name);
  const base = path.resolve(paths.data);
  if (!ALLOWED.includes(name) || p !== path.join(base, name) || !p.startsWith(base + path.sep)) {
    throw new Error(`refusing to prune ${name}: not an allow-listed cache under data/`);
  }
  return p;
}

let totalFiles = 0, totalBytes = 0, totalOld = 0, totalOldBytes = 0;
for (const name of ALLOWED) {
  let dir; try { dir = safeDir(name); } catch (e) { say(`  SKIP ${name}: ${e.message}`); continue; }
  if (!fs.existsSync(dir)) { say(`  ${name}/  (absent)`); continue; }
  let files = 0, bytes = 0, oldFiles = 0, oldBytes = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { stack.push(p); continue; }
      let st; try { st = fs.statSync(p); } catch { continue; }
      files++; bytes += st.size;
      if (st.mtimeMs < cutoffMs) {
        oldFiles++; oldBytes += st.size;
        if (APPLY) { try { fs.unlinkSync(p); } catch {} }
      }
    }
  }
  totalFiles += files; totalBytes += bytes; totalOld += oldFiles; totalOldBytes += oldBytes;
  say(`  ${name.padEnd(9)} ${String(files).padStart(6)} files ${MB(bytes).padStart(8)} MB  ->  ${APPLY ? "evicted" : "would evict"} ${oldFiles} files (${MB(oldBytes)} MB) older than ${OLDER_DAYS}d`);
}

say(`\n${APPLY ? "PRUNED" : "DRY RUN"}: ${APPLY ? "evicted" : "would evict"} ${totalOld}/${totalFiles} files, reclaiming ${MB(totalOldBytes)} MB of ${MB(totalBytes)} MB local cache.`);
if (!APPLY) say(`(nothing changed — re-run with --apply to delete. These caches are re-fetchable and never committed.)`);
process.exit(0);
