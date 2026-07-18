// DASHBOARD VERIFICATION OVERLAY — a human-checked review item must show its resolution on the
// dashboard WITHOUT touching the sealed forecast, the origin counts, or any bet.
//
// The case that forced this: Kevin Holland withdrew (confirmed), his bout's Kalshi market settled on
// 2026-07-13, and the bout was off the board — yet the dashboard still rendered it as a normal upcoming
// bout carrying "UNVERIFIED · 1 origin", which reads like live, actionable news. data/verification-<card>.json
// is a SEPARATE, additive record overlaid at display time. These tests pin that it (a) resolves Holland,
// (b) leaves the two genuinely-unverified items alone, and (c) changes no forecast number.
const fs = require("fs");
const path = require("path");
const DD = require("../lib/dashboard-data");

let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${e ? " -> " + e : ""}`); } };

const CARD = "2026-07-18";

// Precondition: the committed card artifacts this test pins must exist. If the card is ever rotated
// out, that is a real change to the fixture, not a silent skip — fail loudly so it gets updated.
const verPath = path.join(__dirname, "..", "data", `verification-${CARD}.json`);
ok("the verification record for the card exists", fs.existsSync(verPath), verPath);

console.log("THE VERIFICATION RECORD IS WELL-FORMED (the renderer keys on these exact literals)");
{
  const rec = JSON.parse(fs.readFileSync(verPath, "utf8"));
  const items = Array.isArray(rec) ? rec : rec.items || [];
  const holland = items.find((i) => /holland/i.test(i.about || ""));
  ok("a Kevin Holland item is present", !!holland, JSON.stringify(items.map((i) => i.about)));
  ok("status is exactly CONFIRMED_WITHDRAWN", holland && holland.status === "CONFIRMED_WITHDRAWN", holland && holland.status);
  ok("marketState is exactly SETTLED", holland && holland.marketState === "SETTLED", holland && holland.marketState);
  ok("it declares it moves the forecast by nothing", holland && holland.movesForecast === false);
  ok("it carries a boutId to key against", holland && /^UFC-/.test(holland.boutId || ""), holland && holland.boutId);
  ok("it carries real sources with URLs", holland && Array.isArray(holland.sources) && holland.sources.every((s) => /^https?:\/\//.test(s.url || "")));
  ok("it carries the real market-settled timestamp (not invented)", holland && /^2026-07-13T/.test(holland.marketSettledAt || ""), holland && holland.marketSettledAt);
}

const u = DD.buildUnifiedDashboard(CARD);
ok("the unified dashboard builds", u && u.ok !== false, u && u.reason);

console.log("\nTHE HOLLAND ITEM RESOLVES — NO LONGER BARE 'UNVERIFIED'");
{
  const holland = (u.humanReviewAlerts || []).find((h) => /holland/i.test(h.about || ""));
  ok("Holland appears in the top-level human-review list", !!holland);
  ok("it now carries a verification overlay", holland && !!holland.verification);
  ok("...with status CONFIRMED_WITHDRAWN", holland && holland.verification && holland.verification.status === "CONFIRMED_WITHDRAWN");
  ok("...and market SETTLED", holland && holland.verification && holland.verification.marketState === "SETTLED");
  ok("its origin count is UNCHANGED (overlay never rewrites origins)", holland && holland.origins === 1, holland && String(holland.origins));

  const b01 = u.bouts.find((b) => b.boutId === "UFC-2026-07-18-B01");
  ok("the Smith/Holland bout is flagged withdrawn", b01 && b01.verification.boutWithdrawn === true);
  ok("...and market-settled", b01 && b01.verification.marketSettled === true);
  ok("...so it no longer counts as unverified news (amber pill suppressed)", b01 && b01.verification.hasUnverifiedNews === false);
  ok("...and its unresolved-item count is zero", b01 && b01.verification.unverifiedItems === 0);
  ok("the per-bout review item also carries the resolution", b01 && b01.humanReview[0] && b01.humanReview[0].verification && b01.humanReview[0].verification.status === "CONFIRMED_WITHDRAWN");
}

console.log("\nTHE TWO GENUINELY-UNVERIFIED ITEMS ARE LEFT ALONE (overlay is scoped, not global)");
{
  for (const [name, boutId] of [["Kamaru Usman", "UFC-2026-07-18-B03"], ["Chase Hooper", "UFC-2026-07-18-B05"]]) {
    const top = (u.humanReviewAlerts || []).find((h) => h.boutId === boutId);
    ok(`${name} has NO verification overlay`, top && top.verification == null, top && JSON.stringify(top.verification));
    const b = u.bouts.find((x) => x.boutId === boutId);
    ok(`${name}'s bout is still UNVERIFIED (amber)`, b && b.verification.hasUnverifiedNews === true && b.verification.boutWithdrawn === false);
    ok(`${name}'s origin count is untouched`, top && top.origins === 1);
  }
}

console.log("\nTHE FORECAST AND POSITIONS ARE UNTOUCHED (this is a display overlay, not a re-forecast)");
{
  ok("bout count is unchanged", u.totalBouts === 13, String(u.totalBouts));
  const b01 = u.bouts.find((b) => b.boutId === "UFC-2026-07-18-B01");
  ok("the withdrawn bout is still PRESENT (marked, not deleted)", !!b01);
  ok("...it still carries its sealed final probability", b01 && !!b01.finalProbability);
  // The overlay must not add or remove positions — the exposure list comes straight from the sealed
  // alerts artifact and the verification file has no path to it.
  const rawAlerts = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", `entertainment-alerts-${CARD}.json`), "utf8"));
  ok("the overlay added/removed no position (exposure = sealed alerts)", (u.exposure.activePositions || []).length === (rawAlerts.buyInstructions || []).length, `${(u.exposure.activePositions || []).length} vs ${(rawAlerts.buyInstructions || []).length}`);
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
