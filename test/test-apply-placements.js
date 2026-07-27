// APPLY PLACEMENTS — the mobile "I placed this" button drops a {ticker, fillPriceCents, contracts} file
// into data/placements/; this consumer records it into the REAL bankroll at the EXACT price. Refusal-first:
// a fake/missing price is rejected (never guessed), a non-UFC ticker is quarantined, and a re-run is
// idempotent (a placement is applied ONCE). Isolated in a temp DATA_DIR; no network, no real ledger touched.
const os = require("os"), fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");
const ROOT = path.join(__dirname, "..");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; process.stdout.write(`  PASS  ${m}\n`); } else { fail++; process.stdout.write(`  FAIL  ${m}\n`); } };

const TMP = path.join(os.tmpdir(), `ss-apply-${process.pid}`);
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(path.join(TMP, "placements"), { recursive: true });
const env = { ...process.env, DATA_DIR: TMP };
const node = (code) => execFileSync(process.execPath, ["-e", code], { cwd: ROOT, env, stdio: "pipe" }).toString();
const drop = (name, obj) => fs.writeFileSync(path.join(TMP, "placements", name), JSON.stringify(obj));
const applyRun = () => { try { return execFileSync(process.execPath, [path.join(ROOT, "run-apply-placements.js")], { cwd: ROOT, env, stdio: "pipe" }).toString(); } catch (e) { return (e.stdout ? e.stdout.toString() : "") + (e.stderr ? e.stderr.toString() : ""); } };
const entry = (ticker) => JSON.parse(node(`const MB=require("./lib/manual-bankroll");const e=Object.values(MB.load().entries||{}).find(x=>x.ticker===${JSON.stringify(ticker)});process.stdout.write(JSON.stringify(e||null))`));

// Seed a system recommendation the human can confirm.
const TK = "KXUFCFIGHT-26AUG01AAABBB-AAA";
node(`const MB=require("./lib/manual-bankroll");const s=MB.load();MB.recordRecommendation(s,{key:"k1",ticker:${JSON.stringify(TK)},fight:"A vs B",lane:"core",classification:"BUY",recommendedFraction:0.05,recommendedStakeDollars:5,maximumAcceptablePrice:0.30,ask:0.21});MB.save(s)`);

// 1. A valid confirmation records at the EXACT price + contracts.
drop("good.json", { ticker: TK, fillPriceCents: 21, contracts: 14 });
applyRun();
{
  const e = entry(TK);
  ok(e && e.status === "MANUALLY_PLACED" && e.executionPrice === 0.21 && e.actualContracts === 14, "1. valid placement -> MANUALLY_PLACED at the exact price (21c x 14)");
  ok(e && Math.abs(e.actualStake - 2.94) < 0.005, "2. stake = contracts x price ($2.94)");
}
// 3. Idempotent: dropping the same placement again does NOT double-record.
drop("dup.json", { ticker: TK, fillPriceCents: 21, contracts: 14 });
{ const out = applyRun(); ok(/already placed|skipping/i.test(out) && entry(TK).status === "MANUALLY_PLACED", "3. re-submitting an already-placed ticker is an idempotent skip, not a double-record"); }

// 4. A fake/absent price is REFUSED (never guessed) and quarantined to failed/.
drop("noprice.json", { ticker: "KXUFCFIGHT-26AUG01CCCDDD-CCC", fillPriceCents: 0, contracts: 5 });
{ const out = applyRun(); ok(/✗|cents price/i.test(out) && fs.existsSync(path.join(TMP, "placements", "failed", "noprice.json")), "4. a 0/absent price is refused and quarantined (never faked)"); }
// 5. A non-UFC ticker is refused.
drop("badticker.json", { ticker: "AAPL-YES", fillPriceCents: 50, contracts: 1 });
{ const out = applyRun(); ok(/KXUFCFIGHT/i.test(out) && fs.existsSync(path.join(TMP, "placements", "failed", "badticker.json")), "5. a non-KXUFCFIGHT ticker is refused"); }
// 6. The inbox is drained (no .json left at the top level -> never re-applies).
ok(fs.readdirSync(path.join(TMP, "placements")).filter((f) => f.endsWith(".json")).length === 0, "6. inbox drained after processing (nothing re-applies next run)");

fs.rmSync(TMP, { recursive: true, force: true });
process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
process.exit(fail ? 1 : 0);
