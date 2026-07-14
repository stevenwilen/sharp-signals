// Sharp Signals dashboard: source track records + live signals + key status.
//
// READ-ONLY ON PURPOSE. The pipeline runs in GitHub Actions every 4h; the Desktop
// shortcut git-pulls those results before launching this. So closing and reopening
// the dashboard = fresh data.
//
// There is deliberately NO "refresh" endpoint: triggering a pipeline run from here
// would re-do work the cloud already did, burning YouTube quota, Gemini calls and
// Blotato credits for nothing.
require("./lib/env");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { capabilities } = require("./lib/env");
const { paths, readJson } = require("./lib/store");

const PORT = process.env.PORT || 4400;

// When were the results last written? (so the UI can show how stale it is)
function updatedAt() {
  try { return fs.statSync(paths.graded).mtime.toISOString(); } catch (_) { return null; }
}

function data() {
  return {
    caps: capabilities(),
    graded: Object.values(readJson(paths.graded, {})),
    signals: readJson(paths.signals, []),
    updatedAt: updatedAt(),
  };
}

const server = http.createServer((req, res) => {
  if (req.url === "/" || req.url === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html" });
    return res.end(fs.readFileSync(path.join(paths.root, "public", "index.html")));
  }
  if (req.url === "/api/data") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(data()));
  }
  res.writeHead(404);
  res.end("not found");
});

server.listen(PORT, () => console.log(`Sharp Signals dashboard: http://localhost:${PORT}`));
