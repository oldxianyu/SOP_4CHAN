const fs = require("fs");
const path = require("path");

const root = process.cwd();
const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
const releaseRoot = path.join(root, ".server", "releases", `sop-4chan-${timestamp}`);

const includePaths = [
  ".gitignore",
  "README.md",
  "index.html",
  "preview-server.js",
  "package.json",
  "package-lock.json",
  "assets",
  "content",
  "docs",
  "links",
  "oms",
  "scripts",
  "vendor",
  "协议文件",
];

const requiredPaths = [
  "index.html",
  "preview-server.js",
  "package.json",
  "package-lock.json",
  "content/home.json",
  "content/calendar.json",
  "content/incentive.json",
  "content/selection.json",
  "content/monthly-marketing.json",
  "scripts/assert-architecture.js",
  "scripts/smoke-test.js",
];

const blockedTopLevel = new Set([".git", ".server", "node_modules", "video_frames"]);
const blockedFilePatterns = [
  /^wecom-.*\.(png|json)$/i,
  /^npm-debug\.log/i,
];
const secretPatterns = [
  /sk-[A-Za-z0-9_-]{16,}/,
  new RegExp(["Xianyu", "98#"].join(""), "i"),
  new RegExp(["Sijichan", "2026"].join(""), "i"),
  new RegExp(["Hydeesoft", "2026"].join(""), "i"),
];

function fail(message) {
  throw new Error(message);
}

function relativeToRoot(filePath) {
  return path.relative(root, filePath).replace(/\\/g, "/");
}

function shouldSkip(relativePath) {
  const parts = relativePath.split(/[\\/]+/).filter(Boolean);
  if (parts.some((part, index) => index === 0 && blockedTopLevel.has(part))) return true;
  const base = parts[parts.length - 1] || "";
  return blockedFilePatterns.some((pattern) => pattern.test(base));
}

function ensureRequiredFiles() {
  const missing = requiredPaths.filter((relativePath) => !fs.existsSync(path.join(root, relativePath)));
  if (missing.length) fail(`缺少发布必需文件：${missing.join(", ")}`);
}

function scanForSecrets(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (![".js", ".json", ".html", ".md", ".txt", ".css", ".sh"].includes(ext)) return;
  const text = fs.readFileSync(filePath, "utf8");
  const matched = secretPatterns.find((pattern) => pattern.test(text));
  if (matched) fail(`发布文件疑似包含敏感信息：${relativeToRoot(filePath)}`);
}

function copyFile(source, target) {
  scanForSecrets(source);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function copyPath(relativePath, manifest) {
  if (shouldSkip(relativePath)) return;
  const source = path.join(root, relativePath);
  if (!fs.existsSync(source)) return;
  const stat = fs.statSync(source);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      copyPath(path.join(relativePath, entry.name), manifest);
    }
    return;
  }
  if (!stat.isFile()) return;
  const target = path.join(releaseRoot, relativePath);
  copyFile(source, target);
  manifest.files.push({ path: relativePath.replace(/\\/g, "/"), bytes: stat.size });
}

function main() {
  ensureRequiredFiles();
  const manifest = {
    createdAt: new Date().toISOString(),
    releaseRoot,
    files: [],
  };
  for (const relativePath of includePaths) {
    copyPath(relativePath, manifest);
  }
  manifest.files.sort((a, b) => a.path.localeCompare(b.path));
  fs.writeFileSync(path.join(releaseRoot, "release-manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  console.log(JSON.stringify({
    ok: true,
    releaseRoot,
    fileCount: manifest.files.length,
    bytes: manifest.files.reduce((sum, file) => sum + file.bytes, 0),
  }, null, 2));
}

main();
