// AUTOMATIC RESEARCH (§1/§12). The cloud investigates a report itself — over collected sources and,
// behind a flag, a grounded web search — so routine operation no longer needs verify-news. The load-
// bearing guarantee: whatever a search "finds" is funnelled through the ONE origin counter, so ten
// outlets citing one reporter stay one origin and a prose summary is never an origin at all. URLs,
// timestamps and lineage are preserved; leaked (post-seal) sources are dropped; a genuine access
// failure surfaces as HUMAN_ACTION_REQUIRED.
const IR = require("../lib/intel-research");
const I = require("../lib/intelligence");

let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${e !== undefined ? " -> " + e : ""}`); } };
const run = (fn) => { let done = false; fn().then(() => { done = true; }).catch((e) => { console.log("ERROR", e); process.exit(1); }); return () => done; };

const record = { intelligenceId: "intel_x", fighter: "Kevin Holland", claim: "Holland may have withdrawn with a knee injury", topic: "injury_health" };
const SEAL = "2026-07-18T00:00:00Z";
const src = (o) => ({ outlet: "MMA Fighting", origin: "helwani", url: "https://mmafighting.com/x", quote: "Holland is out per Ariel Helwani, knee injury", publishedAt: "2026-07-16T10:00:00Z", stance: "supports", sourceType: "media", ...o });
// A provider that just returns a fixed set of candidate results (no network).
const provider = (results, summary) => async () => ({ enabled: true, results, summary: summary || "found some reports" });

(async () => {
  console.log("GROUNDED SEARCH IS OFF BY DEFAULT (shadow mode) — no web origins invented");
  {
    const prev = process.env.INTEL_WEB_SEARCH; delete process.env.INTEL_WEB_SEARCH;
    const r = await IR.research(record, { seal: SEAL });   // default provider, flag off
    ok("web search disabled", r.webEnabled === false);
    ok("no supporting origins added from a disabled search", r.addedSupportingOrigins === 0);
    if (prev !== undefined) process.env.INTEL_WEB_SEARCH = prev;
  }

  console.log("\nTEN OUTLETS CITING ONE REPORTER ARE STILL ONE ORIGIN");
  {
    const ten = Array.from({ length: 10 }, (_, i) => src({ outlet: `Outlet${i}`, url: `https://o${i}.com/x` }));
    const r = await IR.research(record, { seal: SEAL, provider: provider(ten) });
    ok("ten amplifiers of one reporter → ONE added origin", r.addedSupportingOrigins === 1, r.addedSupportingOrigins);
    ok("...and the amplification is recorded", r.amplifiedOnly.length === 1);
  }

  console.log("\nA SEARCH SUMMARY IS NEVER AN ORIGIN");
  {
    // one real source + two 'summary' results with no url/quote (the model prosing instead of citing).
    const mixed = [src(), { outlet: "blog", stance: "supports" }, { summary: "everyone is saying he's out" }];
    const r = await IR.research(record, { seal: SEAL, provider: provider(mixed, "he is reportedly out") });
    ok("uncheckable 'summaries' are dropped, not counted", r.droppedNonSources === 2, r.droppedNonSources);
    ok("only the one real checkable source counts as an origin", r.addedSupportingOrigins === 1, r.addedSupportingOrigins);
    ok("the search summary is kept for the record but never as evidence", r.searchSummaries.length === 1);
  }

  console.log("\nTWO GENUINELY INDEPENDENT SUPPORTING ORIGINS COUNT AS TWO");
  {
    const two = [src({ origin: "helwani" }), src({ outlet: "ESPN", origin: "okamoto", url: "https://espn.com/x", quote: "Brett Okamoto reports Holland is out with a knee" })];
    const r = await IR.research(record, { seal: SEAL, provider: provider(two) });
    ok("two independent reporters → two added origins", r.addedSupportingOrigins === 2, r.addedSupportingOrigins);
  }

  console.log("\nLEAKAGE: A SOURCE AT/AFTER THE SEAL IS DROPPED");
  {
    const leaky = [src({ publishedAt: "2026-07-19T00:00:00Z" })];   // after the seal
    const r = await IR.research(record, { seal: SEAL, provider: provider(leaky) });
    ok("post-seal source is dropped", r.leakedDropped === 1, r.leakedDropped);
    ok("...and contributes no origin", r.addedSupportingOrigins === 0);
  }

  console.log("\nCONFIRMATION / DISPROOF FROM OFFICIAL SOURCES");
  {
    const confirmed = await IR.research(record, { seal: SEAL, provider: provider([src({ outlet: "UFC.com", sourceType: "official promotion", origin: "ufc" })]) });
    ok("an official supporting source → verdict hint CONFIRMED", confirmed.verdictHint === "confirmed", confirmed.verdictHint);
    ok("...maps to the assessor's confirmed flag", IR.toAssessOpts(confirmed).confirmed === true);

    const disproved = await IR.research(record, { seal: SEAL, provider: provider([src({ outlet: "Athletic Commission", sourceType: "commission", origin: "commission", stance: "refutes", quote: "the commission confirms Holland is cleared and on the card" })]) });
    ok("an official refuting source → verdict hint DISPROVED", disproved.verdictHint === "disproved", disproved.verdictHint);
    ok("...and populates disproofs", disproved.disproofs.length === 1);
    ok("...maps to the assessor's disproved flag", IR.toAssessOpts(disproved).disproved === true);
  }

  console.log("\nLINEAGE PRESERVED; INACCESSIBLE → HUMAN_ACTION_REQUIRED");
  {
    const r = await IR.research(record, { seal: SEAL, provider: provider([src()]) });
    const s = r.sourcesUsed[0];
    ok("source url preserved", s.url === "https://mmafighting.com/x");
    ok("source publishedAt preserved", s.publishedAt === "2026-07-16T10:00:00Z");
    ok("source origin (who knew it) preserved", s.origin === "helwani");

    const blocked = await IR.research(record, { seal: SEAL, provider: async () => ({ enabled: true, results: [], inaccessible: "source behind a login" }) });
    ok("a blocked source is reported as inaccessible", /login/.test(blocked.inaccessible || ""));
    // an inaccessible material report routes to HUMAN_ACTION_REQUIRED, not a fabricated 'nothing found'.
    const rec = { reportType: I.REPORT_TYPE.EVENT_STATUS, mechanismStrength: "strong", truthStatus: I.TRUTH_STATUS.UNCERTAIN };
    ok("...and the classifier asks for a human", I.classifyAction(rec, { unreachable: !!blocked.inaccessible }).action === I.ACTION_STATUS.HUMAN_ACTION_REQUIRED);
  }

  console.log("\nROUTINE RESEARCH NEEDS NO verify-news (it IS the automatic replacement)");
  {
    const r = await IR.research(record, { seal: SEAL, provider: provider([src()]) });
    ok("research returns a complete result with no human step", r && typeof r === "object" && "verdictHint" in r && "sourcesUsed" in r);
    const merged = IR.attachResearch({ confirmations: [], contradictions: [], disproofs: [] }, r);
    ok("findings attach to the record with lineage", merged.researchSources.length === 1 && merged.confirmations.length === 1);
  }

  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
})();
