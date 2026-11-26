// Tiny dependency-free local server for previewing demo.html during development.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".jpg": "image/jpeg",
};

http.createServer((request, response) => {
  const requested = request.url === "/" ? "/demo.html" : request.url.split("?")[0];
  const target = path.resolve(root, `.${requested}`);
  if (!target.startsWith(root)) {
    response.writeHead(403).end("Forbidden");
    return;
  }
  fs.readFile(target, (error, data) => {
    if (error) {
      response.writeHead(404).end("Not found");
      return;
    }
    response.writeHead(200, { "Content-Type": mime[path.extname(target)] || "application/octet-stream" });
    response.end(data);
  });
}).listen(8765, "127.0.0.1", () => {
  console.log("Synthetic demo: http://127.0.0.1:8765/demo.html");
});

