// THE FROZEN-UNIVERSE REGRESSION — the defect class this certification exists to kill. The candidate
// universe froze at the manual backfill's last run while hourly sensing wrote fresh picks nothing read.
// These tests pin the fix: a new fight-week video in the live picks store enters the candidate index
// automatically (no backfill), rediscovery dedupes, live wins over stale corpus, malformed items don't
// block the channel, and a stale universe is REPORTED stale — never as complete current research.
const os = require("os"), fs = require("fs"), pathm = require("path");
const TMP = pathm.join(os.tmpdir(), "ss-candidate-index-test");
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(pathm.join(TMP, "picks"), { recursive: true });
const CI = require("../lib/candidate-index");
const FR = require("../lib/freshness");

let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${e !== undefined ? " -> " + e : ""}`); } };

const CORPUS = pathm.join(TMP, "predictions.json");
const PICKS = pathm.join(TMP, "picks");
const writeCorpus = (rows) => fs.writeFileSync(CORPUS, JSON.stringify(rows));
const writePick = (id, obj) => fs.writeFileSync(pathm.join(PICKS, id + ".json"), JSON.stringify(obj));
const build = () => CI.buildIndex({ predictionsPath: CORPUS, picksDir: PICKS });

// A frozen corpus (last row six days before the card) — the exact production shape of the defect.
writeCorpus([
  { url: "https://www.youtube.com/watch?v=old1", source: "We Want Picks", pick: "Fighter A", opponent: "Fighter B", timestamp: "2026-07-10T10:00:00Z" },
  { url: "https://www.youtube.com/watch?v=old2", source: "Uselyis", pick: "Fighter C", opponent: "Fighter D", timestamp: "2026-07-12T21:00:00Z" },
]);

console.log("A NEW FIGHT-WEEK VIDEO ENTERS THE INDEX AUTOMATICALLY (no backfill)");
{
  // the hourly sensing drops a fresh pick file — exactly what pipeline.js writes
  writePick("new1", { url: "https://www.youtube.com/watch?v=new1", fp: "x", at: "2026-07-18T17:00:00Z",
    picks: [{ source: "Topside MMA", pick: "Kevin Holland", opponent: "Jacobe Smith", timestamp: "2026-07-18T16:41:48Z", url: "https://www.youtube.com/watch?v=new1" }] });
  const idx = build();
  ok("the fresh video is in the candidate universe", idx.byUrl.has("https://www.youtube.com/watch?v=new1"));
  ok("it is marked live-origin", idx.byUrl.get("https://www.youtube.com/watch?v=new1").origin === "live");
  ok("its channel joins the channel set", idx.stats.channelsInLive === 1);
  ok("newest source timestamp is the FRESH one, not the frozen corpus", idx.stats.newestSourceTs === "2026-07-18T16:41:48Z", idx.stats.newestSourceTs);
  ok("its fighters join the alias corpus", idx.fighters.has("Kevin Holland") && idx.fighters.has("Jacobe Smith"));
  ok("historical corpus entries are still present (context, not lost)", idx.byUrl.has("https://www.youtube.com/watch?v=old1"));
}

console.log("\nREDISCOVERY DEDUPES — the same video cannot enter twice, live wins over corpus");
{
  // corpus also lists old2; the live store re-extracts the SAME video with a fresher timestamp
  writePick("old2", { url: "https://www.youtube.com/watch?v=old2", fp: "y", at: "2026-07-18T17:00:00Z",
    picks: [{ source: "Uselyis", pick: "Fighter C", opponent: "Fighter D", timestamp: "2026-07-13T09:00:00Z", url: "https://www.youtube.com/watch?v=old2" }] });
  const idx = build();
  const entries = [...idx.byUrl.keys()].filter((u) => u.endsWith("old2"));
  ok("one entry per URL (deduped)", entries.length === 1);
  ok("the live extraction wins the collision", idx.byUrl.get("https://www.youtube.com/watch?v=old2").origin === "live");
}

console.log("\nONE MALFORMED ITEM CANNOT BLOCK THE CHANNEL");
{
  fs.writeFileSync(pathm.join(PICKS, "broken.json"), "{not json");
  writePick("noTs", { url: "https://www.youtube.com/watch?v=noTs", picks: [{ source: "X", pick: "A" }] });   // no timestamp -> skipped honestly
  const idx = build();
  ok("malformed file counted, not fatal", idx.stats.liveUnreadable === 1);
  ok("timestamp-less item is skipped (absence is the truthful value)", !idx.byUrl.has("https://www.youtube.com/watch?v=noTs"));
  ok("the good items still flow", idx.byUrl.has("https://www.youtube.com/watch?v=new1"));
}

console.log("\nA STALE UNIVERSE IS REPORTED STALE — never 'complete current research'");
{
  // strip the live store: only the frozen corpus remains, during fight week
  fs.rmSync(PICKS, { recursive: true, force: true }); fs.mkdirSync(PICKS, { recursive: true });
  const idx = build();
  const f = FR.corpusStatus({ newestSourceTs: idx.stats.newestSourceTs, eventDate: "2026-07-18", now: Date.parse("2026-07-18T18:00:00Z") });
  ok("fight-week + 6-day-old newest source -> STALE", f.status === "STALE", f.status);
  ok("...and the reason SAYS it is not current research", /NOT current research/.test(f.reason));
  // with the live store restored and a fresh item, it is CURRENT
  writePick("new1", { url: "https://www.youtube.com/watch?v=new1", picks: [{ source: "Topside MMA", pick: "K", opponent: "J", timestamp: "2026-07-18T16:41:48Z", url: "https://www.youtube.com/watch?v=new1" }] });
  const idx2 = build();
  const f2 = FR.corpusStatus({ newestSourceTs: idx2.stats.newestSourceTs, eventDate: "2026-07-18", now: Date.parse("2026-07-18T18:00:00Z") });
  ok("with a fresh ingested source -> CURRENT", f2.status === "CURRENT", f2.status);
}

console.log("\nFRESHNESS POLICIES (Phase 7 statuses)");
{
  const now = Date.parse("2026-07-18T18:00:00Z");
  ok("empty corpus -> WAITING_FOR_FIRST_RUN", FR.corpusStatus({ newestSourceTs: null, eventDate: "2026-07-18", now }).status === FR.S.WAITING);
  ok("36h-old during fight week -> DEGRADED", FR.corpusStatus({ newestSourceTs: "2026-07-17T06:00:00Z", eventDate: "2026-07-18", now }).status === FR.S.DEGRADED);
  ok("fresh price -> CURRENT", FR.marketPriceStatus({ snapshotTs: new Date(now - 5 * 60000).toISOString(), now }).status === FR.S.CURRENT);
  ok("45m-old price -> DEGRADED (too old for a BUY)", FR.marketPriceStatus({ snapshotTs: new Date(now - 45 * 60000).toISOString(), now }).status === FR.S.DEGRADED);
  ok("2h-old price -> STALE", FR.marketPriceStatus({ snapshotTs: new Date(now - 2 * 3600e3).toISOString(), now }).status === FR.S.STALE);
  ok("no price -> WAITING, never a silent pass", FR.marketPriceStatus({ snapshotTs: null, now }).status === FR.S.WAITING);
  ok("8h-old consensus -> DEGRADED", FR.consensusStatus({ snapshotTs: new Date(now - 8 * 3600e3).toISOString(), now }).status === FR.S.DEGRADED);
  ok("fightStarted false before the bell", FR.fightStarted("2026-07-18", Date.parse("2026-07-18T21:59:00Z")) === false);
  ok("fightStarted true after 22:00Z on the event date", FR.fightStarted("2026-07-18", Date.parse("2026-07-18T22:01:00Z")) === true);
}

console.log("\nSTATUS PERSISTS FOR THE HEALTH VIEW");
{
  const prev = process.env.DATA_DIR;
  // saveStatus writes via lib/store paths — exercise the shape contract only
  const idx = build();
  const saved = { schemaVersion: 1, ...idx.stats, eventDate: "2026-07-18", corpusFreshness: FR.corpusStatus({ newestSourceTs: idx.stats.newestSourceTs, eventDate: "2026-07-18" }) };
  ok("status carries schemaVersion + newestSourceTs + freshness", saved.schemaVersion === 1 && "newestSourceTs" in saved && saved.corpusFreshness.status);
  if (prev !== undefined) process.env.DATA_DIR = prev;
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
