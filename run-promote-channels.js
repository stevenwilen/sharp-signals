// AUTO-PROMOTE proven discovered channels into the roster. A channel the coverage search found (not already
// in sources.json) whose GRADED picks clear the promotion gate — a real sample AND a positive ROI even at
// the lower confidence bound (roiLcb > 0) — earns a permanent spot in sources.json, so it is scanned every
// collect thereafter. It is GRADE-driven, never frequency-driven: a channel the search keeps finding but
// that never grades out is NOT promoted (origins-not-voices — no amplifiers earn a spot on volume).
//
//   node run-promote-channels.js            # DRY RUN: list what WOULD be promoted
//   node run-promote-channels.js --apply    # append qualifying channels to sources.json
//   node run-promote-channels.js --min-n=15 # require a larger graded sample
//
// DATA-GATED: it correctly promotes NOTHING until searched channels have graded picks (fights must settle
// first). Today every graded source is already on the roster, so it is a no-op — by design, not a bug.
require("./lib/env");
const fs = require("fs");
const path = require("path");
const { paths, readJson, writeJson } = require("./lib/store");
const { selectPromotable } = require("./lib/promote-gate");
const YT = require("./lib/youtube");

const say = (s) => process.stdout.write(s + "\n");
const APPLY = process.argv.includes("--apply");
const numArg = (n, d) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? Number(a.slice(n.length + 3)) : d; };
const MIN_N = numArg("min-n", 10);

(async () => {
  const graded = readJson(paths.graded, null);
  if (!graded) { say("run-promote-channels: no sources_graded.json yet — nothing to promote."); return 0; }
  const sourcesDoc = readJson(paths.sources, { sources: [] });
  const sources = sourcesDoc.sources || [];
  const rosterNames = new Set(sources.map((s) => s.name).filter(Boolean));

  const promotable = selectPromotable(graded, rosterNames, { minN: MIN_N });
  if (!promotable.length) { say(`run-promote-channels: 0 channels clear the gate (n>=${MIN_N}, roiLcb>0, non-roster). Nothing to promote${APPLY ? "" : " (dry run)"}.`); return 0; }

  // channelTitle -> channelId from every coverage-search receipt, so a promotable channel with no handle can
  // have one resolved.
  const nameToChannelId = {};
  try {
    for (const f of fs.readdirSync(paths.data)) {
      if (!/^coverage-search-.*\.json$/.test(f)) continue;
      const r = readJson(path.join(paths.data, f), null);
      for (const [name, info] of Object.entries((r && r.discoveredChannels) || {})) if (info && info.channelId) nameToChannelId[name] = info.channelId;
    }
  } catch {}

  say(`run-promote-channels: ${promotable.length} channel(s) clear the promotion gate${APPLY ? "" : " (DRY RUN)"}:`);
  const toAdd = [];
  for (const p of promotable) {
    let handle = p.handle;
    if (!handle && nameToChannelId[p.source]) handle = await YT.resolveHandleById(nameToChannelId[p.source]);
    say(`  ${p.source}  n=${p.n} roiLcb=${p.roiLcb} hitRate=${p.hitRate}  handle=${handle || "(unresolved — add manually)"}`);
    if (handle) toAdd.push({ name: p.source, domain: p.domain, type: p.type, platform: "youtube", handle, note: `auto-promoted: graded n=${p.n}, roiLcb=${p.roiLcb}`, trusted: false });
  }

  if (!APPLY) { say(`(dry run — re-run with --apply to append ${toAdd.length} channel(s) with a resolved handle to sources.json)`); return 0; }
  if (!toAdd.length) { say("nothing had a resolvable handle — added 0 (resolve those handles manually if you want them)."); return 0; }
  sources.push(...toAdd);
  sourcesDoc.sources = sources;
  writeJson(paths.sources, sourcesDoc);
  say(`added ${toAdd.length} channel(s) to sources.json.`);
  return 0;
})().then((c) => process.exit(c || 0)).catch((e) => { console.error("run-promote-channels error:", e.message); process.exit(1); });
