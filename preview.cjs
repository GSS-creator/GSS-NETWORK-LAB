const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const root = __dirname;
const files = {
  "/": ["renderer/index.html", "text/html"],
  "/topology": ["renderer/index.html", "text/html"],
  "/management": ["renderer/index.html", "text/html"],
  "/app.js": ["renderer/app.js", "text/javascript"],
  "/styles.css": ["renderer/styles.css", "text/css"],
  "/topo.png": ["renderer/topo.png", "image/png"],
};

http.createServer((request, response) => {
  const url = new URL(request.url || "/", "http://127.0.0.1");
  const file = files[url.pathname];
  if (!file) { response.writeHead(404); response.end("Not found"); return; }
  try { response.writeHead(200, { "content-type": file[1], "access-control-allow-origin": "*" }); response.end(fs.readFileSync(path.join(root, file[0]))); }
  catch { response.writeHead(500); response.end("Preview file unavailable"); }
}).listen(8787, "127.0.0.1", () => {
  console.log("GSS topology preview: http://127.0.0.1:8787/topology?screen=topology");
});
