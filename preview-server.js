const http = require("http");
const fs = require("fs");
const path = require("path");

const root = __dirname;
const ports = [8765, 8766, 8767, 8768];
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml; charset=utf-8",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".doc": "application/msword",
};

function createServer() {
  return http.createServer((req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const decoded = decodeURIComponent(url.pathname);
      const safe = path.normalize(decoded).replace(/^([/\\])+/, "");
      let filePath = path.resolve(root, safe || "index.html");

      if (filePath !== root && !filePath.startsWith(root + path.sep)) {
        res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Forbidden");
        return;
      }

      if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
        filePath = path.join(filePath, "index.html");
      }

      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Not found");
          return;
        }
        res.writeHead(200, { "Content-Type": mime[path.extname(filePath).toLowerCase()] || "application/octet-stream" });
        res.end(data);
      });
    } catch (error) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(String(error));
    }
  });
}

function listenOn(portIndex = 0) {
  if (portIndex >= ports.length) {
    throw new Error("No preview port is available.");
  }

  const port = ports[portIndex];
  const server = createServer();

  server.on("error", () => listenOn(portIndex + 1));
  server.listen(port, "127.0.0.1", () => {
    fs.writeFileSync(path.join(root, ".preview-url"), `http://localhost:${port}/?v=preview-server\n`, "utf8");
    console.log(`Preview: http://localhost:${port}/?v=preview-server`);
  });
}

listenOn();
