const http = require("http");
const https = require("https");
const fs = require("fs");
const net = require("net");
const path = require("path");
const { spawn } = require("child_process");

const root = process.cwd();
const explicitBaseUrl = (process.env.SMOKE_BASE_URL || "").replace(/\/+$/, "");
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS || 15000);
const smokeLogin = process.env.SMOKE_LOGIN || "";
const smokePassword = process.env.SMOKE_PASSWORD || "";
const smokeReportId = process.env.SMOKE_REPORT_ID || "";

function request(method, targetUrl, options = {}) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const url = new URL(targetUrl);
    const transport = url.protocol === "https:" ? https : http;
    const req = transport.request(
      {
        method,
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        headers: options.headers || {},
        timeout: options.timeoutMs || timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => {
          chunks.push(chunk);
        });
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body,
            elapsedMs: Date.now() - startedAt,
          });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error(`Request timed out after ${options.timeoutMs || timeoutMs}ms`)));
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function waitForServer(baseUrl, child) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (child?.exitCode !== null) {
      throw new Error(`Server exited early with code ${child.exitCode}`);
    }
    try {
      const response = await request("GET", `${baseUrl}/api/ai-config/status`, { timeoutMs: 2000 });
      if (response.status < 500) return;
      lastError = new Error(`Unexpected status ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  throw lastError || new Error("Server did not become ready.");
}

function assertStatus(result, expected, label) {
  const allowed = Array.isArray(expected) ? expected : [expected];
  if (!allowed.includes(result.status)) {
    throw new Error(`${label}: expected HTTP ${allowed.join("/")} but got ${result.status}\n${result.body.slice(0, 500)}`);
  }
}

function assertIncludes(text, needle, label) {
  if (!String(text || "").includes(needle)) {
    throw new Error(`${label}: response does not include ${needle}`);
  }
}

function assertJson(result, label) {
  try {
    return JSON.parse(result.body);
  } catch (error) {
    throw new Error(`${label}: response is not JSON\n${result.body.slice(0, 500)}`);
  }
}

function cookieHeaderFrom(setCookie) {
  const values = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  return values.map((value) => String(value).split(";")[0]).filter(Boolean).join("; ");
}

async function loginForSmoke(baseUrl) {
  if (!smokeLogin || !smokePassword) return "";
  const result = await request("POST", `${baseUrl}/api/auth/login`, {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ login: smokeLogin, password: smokePassword }),
  });
  assertStatus(result, 200, "smoke login");
  const json = assertJson(result, "smoke login");
  if (!json.user?.id) throw new Error("smoke login: missing user");
  const cookie = cookieHeaderFrom(result.headers["set-cookie"]);
  if (!cookie) throw new Error("smoke login: missing session cookie");
  return cookie;
}

function assertLightweightReportList(json, label) {
  const items = json.items || json.reports || [];
  if (!Array.isArray(items)) throw new Error(`${label}: items is not an array`);
  const text = JSON.stringify(items);
  const forbiddenKeys = ['"summary"', '"report"', '"markdown"', '"summary_json"', '"report_json"', '"rawData"', '"interfaceDiagnostics"'];
  const leaked = forbiddenKeys.find((key) => text.includes(key));
  if (leaked) throw new Error(`${label}: list response contains heavy payload key ${leaked}`);
  for (const item of items) {
    if (item && typeof item === "object" && Object.prototype.hasOwnProperty.call(item, "rowCounts") && item.rowCounts && typeof item.rowCounts !== "object") {
      throw new Error(`${label}: rowCounts should remain structured metadata`);
    }
  }
}

function localReportIdForSmoke() {
  if (smokeReportId) return smokeReportId;
  if (explicitBaseUrl) return "";
  const reportsDir = path.join(root, ".server", "reports");
  if (!fs.existsSync(reportsDir)) return "";
  return fs
    .readdirSync(reportsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(reportsDir, entry.name, "report.json")))
    .map((entry) => entry.name)
    .sort()
    .pop() || "";
}

function assertLightweightReportArtifact(json, label) {
  const text = JSON.stringify(json || {});
  const forbiddenKeys = ['"rawData"', '"interfaceDiagnostics"', '"summary_json"', '"report_json"'];
  const leaked = forbiddenKeys.find((key) => text.includes(key));
  if (leaked) throw new Error(`${label}: report artifact contains heavy payload key ${leaked}`);
  if (!json.report || !json.shareUrl) throw new Error(`${label}: missing report or shareUrl`);
}

async function runChecks(baseUrl) {
  const checks = [];
  async function check(label, fn) {
    const startedAt = Date.now();
    await fn();
    checks.push({ label, elapsedMs: Date.now() - startedAt });
  }

  await check("home page", async () => {
    const result = await request("GET", `${baseUrl}/`);
    assertStatus(result, 200, "home page");
    assertIncludes(result.body, "海典四季蝉", "home page");
  });

  await check("login page", async () => {
    const result = await request("GET", `${baseUrl}/?page=login`);
    assertStatus(result, 200, "login page");
    assertIncludes(result.body, "海典四季蝉", "login page");
  });

  await check("register page", async () => {
    const result = await request("GET", `${baseUrl}/?page=register`);
    assertStatus(result, 200, "register page");
    assertIncludes(result.body, "海典四季蝉", "register page");
  });

  await check("oms friend link", async () => {
    const result = await request("GET", `${baseUrl}/oms`);
    assertStatus(result, 200, "oms friend link");
  });

  const contentFiles = ["home", "calendar", "incentive", "selection", "monthly-marketing"];
  for (const name of contentFiles) {
    await check(`content/${name}.json`, async () => {
      const result = await request("GET", `${baseUrl}/content/${name}.json`);
      assertStatus(result, 200, `content/${name}.json`);
      const json = assertJson(result, `content/${name}.json`);
      if (!json || typeof json !== "object") throw new Error(`content/${name}.json: empty JSON`);
    });
  }

  await check("ai config status", async () => {
    const result = await request("GET", `${baseUrl}/api/ai-config/status`);
    assertStatus(result, 200, "ai config status");
    const json = assertJson(result, "ai config status");
    if (!Object.prototype.hasOwnProperty.call(json, "configured")) {
      throw new Error("ai config status: missing configured flag");
    }
  });

  await check("anonymous auth state", async () => {
    const result = await request("GET", `${baseUrl}/api/auth/me`);
    assertStatus(result, 200, "anonymous auth state");
    const json = assertJson(result, "anonymous auth state");
    if (json.user !== null) throw new Error("anonymous auth state: expected user to be null");
  });

  const protectedEndpoints = [
    "/api/review-reports",
    "/api/review-reports/running",
    "/api/review-reports/status?ids=test",
    "/api/admin/users",
    "/api/capability-test-submissions",
    "/api/monthly-marketing-recommendations",
    "/api/review-prompt",
  ];
  for (const endpoint of protectedEndpoints) {
    await check(`protected ${endpoint}`, async () => {
      const result = await request("GET", `${baseUrl}${endpoint}`);
      assertStatus(result, 401, `protected ${endpoint}`);
      const json = assertJson(result, `protected ${endpoint}`);
      if (!json.error) throw new Error(`protected ${endpoint}: missing error message`);
      if (result.body.includes("summary_json") || result.body.includes("report_json") || result.body.includes("markdown")) {
        throw new Error(`protected ${endpoint}: response leaked payload fields`);
      }
    });
  }

  const sessionCookie = await loginForSmoke(baseUrl);
  if (sessionCookie) {
    await check("authenticated history list is lightweight", async () => {
      const result = await request("GET", `${baseUrl}/api/review-reports?page=1&pageSize=3`, {
        headers: { cookie: sessionCookie },
      });
      assertStatus(result, 200, "authenticated history list");
      const json = assertJson(result, "authenticated history list");
      assertLightweightReportList(json, "authenticated history list");
    });

    await check("authenticated running report metadata", async () => {
      const result = await request("GET", `${baseUrl}/api/review-reports/running`, {
        headers: { cookie: sessionCookie },
      });
      assertStatus(result, 200, "authenticated running report metadata");
      const json = assertJson(result, "authenticated running report metadata");
      const text = JSON.stringify(json.report || {});
      if (text.includes('"rawData"') || text.includes('"markdown"') || text.includes('"interfaceDiagnostics"')) {
        throw new Error("authenticated running report metadata: response contains heavy payload");
      }
    });
  } else {
    checks.push({ label: "authenticated checks skipped (SMOKE_LOGIN not set)", elapsedMs: 0 });
  }

  const reportId = localReportIdForSmoke();
  if (reportId) {
    await check("report share page", async () => {
      const result = await request("GET", `${baseUrl}/reports/${encodeURIComponent(reportId)}/`);
      assertStatus(result, 200, "report share page");
      assertIncludes(result.body, "<!doctype html>", "report share page");
      assertIncludes(result.body, "<title>", "report share page");
      assertIncludes(result.body, "AI DATA REVIEW", "report share page");
    });

    await check("report svg", async () => {
      const result = await request("GET", `${baseUrl}/reports/${encodeURIComponent(reportId)}/report.svg`);
      assertStatus(result, 200, "report svg");
      assertIncludes(result.body, "<svg", "report svg");
    });

    await check("report qr svg", async () => {
      const result = await request("GET", `${baseUrl}/reports/${encodeURIComponent(reportId)}/qr.svg`);
      assertStatus(result, 200, "report qr svg");
      assertIncludes(result.body, "<svg", "report qr svg");
    });

    await check("report artifact json is lightweight", async () => {
      const result = await request("GET", `${baseUrl}/reports/${encodeURIComponent(reportId)}/report.json`);
      assertStatus(result, 200, "report artifact json");
      const json = assertJson(result, "report artifact json");
      assertLightweightReportArtifact(json, "report artifact json");
    });
  } else {
    checks.push({ label: "report artifact checks skipped (no local report sample)", elapsedMs: 0 });
  }

  return checks;
}

async function main() {
  let child = null;
  let baseUrl = explicitBaseUrl;
  try {
    if (!baseUrl) {
      const port = await getFreePort();
      baseUrl = `http://127.0.0.1:${port}`;
      child = spawn(process.execPath, ["preview-server.js"], {
        cwd: root,
        env: {
          ...process.env,
          HOST: "127.0.0.1",
          PORT: String(port),
          PUBLIC_REPORT_BASE_URL: baseUrl,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", (chunk) => process.stdout.write(`[server] ${chunk}`));
      child.stderr.on("data", (chunk) => process.stderr.write(`[server] ${chunk}`));
      await waitForServer(baseUrl, child);
    }

    const checks = await runChecks(baseUrl);
    for (const item of checks) {
      console.log(`ok ${item.label} ${item.elapsedMs}ms`);
    }
    console.log(`SMOKE_OK ${baseUrl}`);
  } finally {
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
