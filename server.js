// Sharp Signals dashboard: source track records + live signals + key status.
require("./lib/env");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { capabilities } = require("./lib/env");
const { paths, readJson } = require("./lib/store");

const PORT = process.env.PORT || 4400;
let refreshing = false;

function data() {
  return {
    caps: capabilities(),
    graded: Object.values(readJson(paths.graded, {})),
    signals: readJson(paths.signals, []),
    refreshing,
  };
}

function refresh(mock) {
  if (refreshing) return;
  refreshing = true;
  const args = ["pipeline.js"]; if (mock) args.push("--mock");
  const child = spawn(process.execPath, args, { cwd: paths.root, stdio: "ignore" });
  child.on("exit", () => { refreshing = false; });
}

const server = http.createServer((req, res) => {
  const send = (c, o) => { res.writeHead(c, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
  if (req.url === "/" || req.url === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html" });
    return res.end(fs.readFileSync(path.join(paths.root, "public", "index.html")));
  }
  if (req.url === "/api/data") return send(200, data());
  if (req.url === "/api/refresh" && req.method === "POST") { refresh(false); return send(200, { ok: true }); }
  if (req.url === "/api/refresh-mock" && req.method === "POST") { refresh(true); return send(200, { ok: true }); }
  res.writeHead(404); res.end("not found");
});
server.listen(PORT, () => console.log(`Sharp Signals dashboard: http://localhost:${PORT}`));
