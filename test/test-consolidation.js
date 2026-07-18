// CONSOLIDATION GUARANTEES. After removing dead code, archiving stale docs, single-sourcing the money
// constants and reducing V1 to sensing-only, prove that NO safety guarantee regressed: no trading path,
// Kalshi stays read-only, the removed modules are gone and unreferenced, the archive holds no runnable
// code, and the production entry points are intact.
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");

let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${e !== undefined ? " -> " + e : ""}`); } };
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const jsFilesUnder = (dir) => { const out = []; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith(".js")) out.push(p); } }; if (fs.existsSync(dir)) walk(dir); return out; };

console.log("NO TRADING PATH (unchanged by consolidation)");
{
  const ARM = require("../lib/arming");
  ok("assertNoTradingPath() passes", (() => { try { ARM.assertNoTradingPath(); return true; } catch { return false; } })());
  const K = require("../lib/kalshi");
  // request() must refuse a write SYNCHRONOUSLY (not a rejected promise a sync try/catch would miss).
  ok("kalshi.request('POST', ...) throws synchronously", (() => { try { K.request("POST", "/portfolio/orders", {}); return false; } catch { return true; } })());
  ok("kalshi.request('DELETE', ...) throws synchronously", (() => { try { K.request("DELETE", "/x", {}); return false; } catch { return true; } })());
  ok("kalshi exports no order function", !("createOrder" in K) && !("placeOrder" in K) && !("submitOrder" in K) && !("cancelOrder" in K));
  // No source INVOKES an order call. Match only an actual invocation `.createOrder(` — not the
  // fail-closed guards that assert these functions are ABSENT (`typeof k.createOrder === "function"`),
  // which the house style deliberately uses.
  const bad = jsFilesUnder(path.join(ROOT, "lib")).concat(jsFilesUnder(ROOT).filter((f) => path.dirname(f) === ROOT))
    .filter((f) => /\.(createOrder|placeOrder|submitOrder|cancelOrder)\s*\(/.test(fs.readFileSync(f, "utf8").replace(/\/\/.*|\/\*[\s\S]*?\*\//g, "")));
  ok("no code INVOKES an order call", bad.length === 0, bad.map((f) => path.basename(f)).join(", "));
}

console.log("\nDEAD MODULES REMOVED AND UNREFERENCED");
{
  ok("lib/claude.js is gone", !fs.existsSync(path.join(ROOT, "lib/claude.js")));
  ok("lib/transcripts.js is gone", !fs.existsSync(path.join(ROOT, "lib/transcripts.js")));
  const refs = jsFilesUnder(path.join(ROOT, "lib")).concat(jsFilesUnder(ROOT).filter((f) => path.dirname(f) === ROOT))
    .filter((f) => /require\(["']\.\/(lib\/)?claude["']\)|require\(["']\.\/(lib\/)?transcripts["']\)/.test(fs.readFileSync(f, "utf8")));
  ok("nothing requires the removed modules", refs.length === 0, refs.map((f) => path.basename(f)).join(", "));
}

console.log("\nARCHIVE HOLDS NO RUNNABLE CODE (docs only)");
{
  const archived = jsFilesUnder(path.join(ROOT, "archive"));
  ok("archive/ contains no .js files", archived.length === 0, archived.join(", "));
  ok("archived V1 docs are present (history preserved)", fs.existsSync(path.join(ROOT, "archive/docs-v1/README.md")));
}

console.log("\nONE CANONICAL MONEY SOURCE");
{
  const MONEY = require("../config/bankroll.json");
  const EN = require("../lib/entertainment");
  const XR = require("../config/exploration-rules.json");
  ok("bankroll.json is the source ($100, $3/$4/$5, $5/$10)", MONEY.bankrollDollars === 100 && MONEY.tiers.tier1.dollars === 3 && MONEY.maxPerFightDollars === 5 && MONEY.maxPerCardDollars === 10);
  ok("entertainment lane derives from it", EN.BANKROLL.amount === MONEY.bankrollDollars && EN.TIERS.STANDARD.dollars === MONEY.tiers.tier1.dollars);
  ok("exploration lane matches it (no drift)", XR.caps_exposure.bankrollDollars === MONEY.bankrollDollars && XR.tiers["CREATIVE SPECULATIVE"].stake === MONEY.tiers.tier1.dollars);
}

console.log("\nPRODUCTION ENTRY POINTS INTACT (parse without error)");
{
  const { execFileSync } = require("child_process");
  for (const entry of ["dispatch.js", "sentinel.js", "run-intel.js", "server.js", "run-entertainment-alerts.js", "run-forecast.js"]) {
    ok(`${entry} parses`, (() => { try { execFileSync(process.execPath, ["-c", path.join(ROOT, entry)], { stdio: "ignore" }); return true; } catch { return false; } })());
  }
}

console.log("\nV1 IS SENSING-ONLY: its paper-summary Telegram is opt-in, not default");
{
  const src = read("pipeline.js");
  ok("the V1 paper-summary send is gated behind V1_PAPER_SUMMARY", /V1_PAPER_SUMMARY\s*===\s*["']1["']/.test(src));
  ok("watch.yml's 15-min schedule is disabled", /#\s*-\s*cron:\s*"\*\/15/.test(read(".github/workflows/watch.yml")));
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
