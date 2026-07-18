// Sharp Signals dashboard server.
//
// READ-ONLY, AND STRUCTURALLY INCAPABLE OF TRADING. There is no order endpoint, no arm endpoint,
// and no pipeline-trigger endpoint. Triggering a run from here would re-do work the cloud already
// did and burn quota for nothing; placing an order from here is simply not a thing this build can
// express.
//
// EVERY NUMBER SERVED HERE COMES FROM lib/dashboard-data.js, which reads SEALED artifacts and never
// recomputes. If an artifact's hash does not reproduce, the endpoint says so instead of rendering
// numbers no sealed record contains. That check earned its keep on its first run: it caught a
// decisionHash that excluded its own lineage.
//
// The V1 source track-record board is still reachable at /research/sources — as ARCHIVED RESEARCH.
// It is not a live betting signal, and the page says so: the 24-month backfill it summarises found
// no source with an edge that generalised.
require("./lib/env");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { capabilities } = require("./lib/env");
const { paths, readJson } = require("./lib/store");
const DD = require("./lib/dashboard-data");

const PORT = process.env.PORT || 4400;

function updatedAt() {
  try { return fs.statSync(paths.graded).mtime.toISOString(); } catch (_) { return null; }
}

// Which cards have a sealed forecast we can render?
function cards() {
  return fs.readdirSync(path.join(paths.root, "data"))
    .map((f) => (f.match(/^forecast-(\d{4}-\d{2}-\d{2})\.json$/) || [])[1])
    .filter(Boolean).sort().reverse();
}

const json = (res, body, code = 200) => {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  if (p === "/" || p === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    return res.end(fs.readFileSync(path.join(paths.root, "public", "index.html")));
  }

  // ---- the primary board ----
  if (p === "/api/status") return json(res, DD.systemStatus({ nowTs: Date.now() }));
  if (p === "/api/cards") return json(res, { cards: cards() });
  if (p === "/api/card") {
    const d = url.searchParams.get("date") || cards()[0];
    if (!d) return json(res, { ok: false, reason: "no sealed forecast exists" }, 404);
    return json(res, DD.upcomingCard(d));
  }
  if (p === "/api/fight") {
    const d = url.searchParams.get("date"), b = url.searchParams.get("bout");
    if (!d || !b) return json(res, { ok: false, reason: "date and bout are required" }, 400);
    return json(res, DD.fightDetail(d, b, {}));
  }
  if (p === "/api/contracts") return json(res, DD.contractComparison(url.searchParams.get("date") || cards()[0]));
  if (p === "/api/portfolio") return json(res, DD.portfolioView(url.searchParams.get("date") || cards()[0]));
  if (p === "/api/forward-record") return json(res, DD.forwardRecord());

  // ---- ARCHIVED RESEARCH — not a live signal ----
  if (p === "/api/research/sources") {
    return json(res, {
      archived: true,
      status: "ARCHIVED RESEARCH — NOT A LIVE BETTING SIGNAL",
      why: "A 24-month backfill graded 12,597 picks from these sources. The market was efficient (-0.4% average ROI) and NO source showed an edge that generalised out of sample. These track records are kept because they are a real measurement, not because they predict anything.",
      doNotUse: "Do not use this page to select a bet. Source track record is not an input to any forecast in the current pipeline.",
      supersededBy: "The evidence pipeline keeps sources' REASONING and discards their picks.",
      updatedAt: updatedAt(),
      capabilities: capabilities(),
      graded: Object.values(readJson(paths.graded, {})),
    });
  }
  if (p === "/research/sources") {
    const f = path.join(paths.root, "public", "research-sources.html");
    if (!fs.existsSync(f)) return json(res, { ok: false, reason: "archived page not built" }, 404);
    res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    return res.end(fs.readFileSync(f));
  }
  // The legacy endpoint is kept so old bookmarks do not silently 404 — it points at the archive and
  // says plainly that the board it used to serve is not a signal.
  if (p === "/api/data") return json(res, {
    moved: "/api/research/sources",
    status: "ARCHIVED RESEARCH — NOT A LIVE BETTING SIGNAL",
    note: "The source track-record board is no longer the primary dashboard and is not a live signal. The primary board is /api/status, /api/card, /api/contracts, /api/portfolio, /api/forward-record.",
  }, 410);

  res.writeHead(404);
  res.end("not found");
});

server.listen(PORT, () => console.log(`Sharp Signals dashboard: http://localhost:${PORT}  (read-only; alerts DISARMED; no order path)`));
