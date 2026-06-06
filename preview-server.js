const http = require("http");
const dns = require("dns");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const { spawn } = require("child_process");
const Busboy = require("busboy");
const JSZip = require("jszip");
const QRCode = require("qrcode");
const dotenv = require("dotenv");
const { Pool } = require("pg");

dns.setDefaultResultOrder("ipv4first");

const root = __dirname;
const host = process.env.HOST || "0.0.0.0";
const configuredPort = Number(process.env.PORT || 8765);
const ports = [configuredPort, 8766, 8767, 8768].filter((value, index, list) => value && list.indexOf(value) === index);
const uploadLimitBytes = Number(process.env.UPLOAD_LIMIT_BYTES || 10 * 1024 * 1024);
const serverDir = path.join(root, ".server");
dotenv.config({ path: path.join(serverDir, ".env") });
const configPath = path.join(serverDir, "ai-config.json");
const localDataPath = path.join(serverDir, "portal-data.json");
const sessionSecretPath = path.join(serverDir, "session-secret");
const sijichanRepoDir = path.join(serverDir, "sijichan-shuju");
const sijichanRepoUrl = "https://github.com/oldxianyu/sijichan-shuju.git";
const reportsDir = path.join(serverDir, "reports");
const publicReportBaseUrl = (process.env.PUBLIC_REPORT_BASE_URL || `http://localhost:${configuredPort}`).replace(/\/+$/, "");
const supabaseProjectRef = "gqinewwwnfdxwqtnapjl";
const dbConfig = {
  connectionString: process.env.DATABASE_URL || "",
  host: process.env.DB_HOST || `db.${supabaseProjectRef}.supabase.co`,
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME || "postgres",
  user: process.env.DB_USER || "sijichan",
  password: process.env.DB_PASSWORD || "",
  ssl: process.env.DB_SSL === "false" ? false : { rejectUnauthorized: false },
};
const cookieName = "sop_session";
const sessionMaxAgeMs = Number(process.env.SESSION_MAX_AGE_MS || 1000 * 60 * 60 * 24 * 7);
let pool = null;
let dbReady = false;
let dbChecked = false;

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".doc": "application/msword",
};

const expectedSheets = [
  "销售变化_上上月对比",
  "销售变化_上上月-上月趋势",
  "上月活动商品销售统计",
  "店员提现情况及账户总览",
  "活动参加类型_上月",
  "店员晒单厂家给额外激励",
];

function ensureServerDir() {
  fs.mkdirSync(serverDir, { recursive: true });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function sendNoContent(res, headers = {}) {
  res.writeHead(204, headers);
  res.end();
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        return [decodeURIComponent(part.slice(0, index)), decodeURIComponent(part.slice(index + 1))];
      }),
  );
}

function getSessionSecret() {
  ensureServerDir();
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (!fs.existsSync(sessionSecretPath)) {
    fs.writeFileSync(sessionSecretPath, crypto.randomBytes(32).toString("hex"), "utf8");
  }
  return fs.readFileSync(sessionSecretPath, "utf8").trim();
}

function signSession(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto.createHmac("sha256", getSessionSecret()).update(body).digest("base64url");
  return `${body}.${signature}`;
}

function verifySessionToken(token) {
  if (!token || !token.includes(".")) return null;
  const [body, signature] = token.split(".");
  const expected = crypto.createHmac("sha256", getSessionSecret()).update(body).digest("base64url");
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  if (!payload.exp || payload.exp < Date.now()) return null;
  return payload;
}

function setSessionCookie(res, user) {
  const token = signSession({ userId: user.id, role: user.role, exp: Date.now() + sessionMaxAgeMs });
  res.setHeader("Set-Cookie", `${cookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(sessionMaxAgeMs / 1000)}`);
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function readLocalData() {
  if (!fs.existsSync(localDataPath)) {
    return { users: [], customerProfiles: [], aiConfigs: [], customerDatasets: [], reviewReports: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(localDataPath, "utf8"));
  } catch {
    return { users: [], customerProfiles: [], aiConfigs: [], customerDatasets: [], reviewReports: [] };
  }
}

function writeLocalData(data) {
  ensureServerDir();
  fs.writeFileSync(localDataPath, JSON.stringify(data, null, 2), "utf8");
}

function createId(prefix = "id") {
  return `${prefix}_${crypto.randomBytes(12).toString("hex")}`;
}

function jsonClone(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeXml(value) {
  return escapeHtml(value);
}

function stripMarkdown(value) {
  return String(value ?? "").replace(/[#*_`>~-]/g, "").trim();
}

function wrapText(text, maxChars) {
  const source = stripMarkdown(text);
  const lines = [];
  let current = "";
  for (const char of source) {
    const charWidth = /[A-Za-z0-9.,;:!?()/%+\- ]/.test(char) ? 0.55 : 1;
    const currentWidth = [...current].reduce((sum, item) => sum + (/[A-Za-z0-9.,;:!?()/%+\- ]/.test(item) ? 0.55 : 1), 0);
    if (current && currentWidth + charWidth > maxChars) {
      lines.push(current);
      current = char.trimStart();
    } else {
      current += char;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

function readJsonBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("请求内容过大。"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8") || "{}";
        resolve(JSON.parse(text));
      } catch {
        reject(new Error("请求格式不是有效JSON。"));
      }
    });
    req.on("error", reject);
  });
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || root,
      env: options.env || process.env,
      shell: false,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} 执行超时。`));
    }, options.timeoutMs || 120000);
    child.stdout.on("data", (data) => (stdout += data.toString()));
    child.stderr.on("data", (data) => (stderr += data.toString()));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error((stderr || stdout || `${command} 执行失败。`).trim()));
    });
  });
}

function shouldUseDatabase() {
  return Boolean(dbConfig.connectionString || dbConfig.password);
}

async function getPool() {
  if (!shouldUseDatabase()) return null;
  if (!pool) {
    pool = new Pool(
      dbConfig.connectionString
        ? { connectionString: dbConfig.connectionString, ssl: dbConfig.ssl, max: 8 }
        : {
            host: dbConfig.host,
            port: dbConfig.port,
            database: dbConfig.database,
            user: dbConfig.user,
            password: dbConfig.password,
            ssl: dbConfig.ssl,
            max: 8,
          },
    );
  }
  return pool;
}

async function queryDb(text, params = []) {
  const activePool = await getPool();
  if (!activePool) throw new Error("数据库未配置。");
  await ensureDatabase();
  return activePool.query(text, params);
}

async function ensureDatabase() {
  if (dbReady) return true;
  if (dbChecked) return dbReady;
  dbChecked = true;
  const activePool = await getPool();
  if (!activePool) return false;
  try {
    await activePool.query("create extension if not exists pgcrypto");
  } catch {
    // Some Supabase roles may not be allowed to create extensions; fallback schemas use text ids.
  }
  try {
    await activePool.query(`
      create table if not exists users (
      id text primary key default gen_random_uuid()::text,
      name text not null,
      phone text unique,
      email text unique,
      password_hash text not null,
      role text not null default 'customer',
      status text not null default 'active',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create table if not exists customer_profiles (
      id text primary key default gen_random_uuid()::text,
      user_id text not null references users(id) on delete cascade,
      company_name text,
      contact_name text,
      contact_phone text,
      notes text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique(user_id)
    );
    create table if not exists ai_configs (
      id text primary key default gen_random_uuid()::text,
      base_url text not null,
      model text not null,
      protocol text not null,
      api_key_encrypted text not null,
      updated_by text references users(id),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create table if not exists customer_datasets (
      id text primary key default gen_random_uuid()::text,
      user_id text references users(id),
      source_type text not null,
      filename text,
      row_counts_json jsonb,
      sheet_status_json jsonb,
      metadata_json jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create table if not exists review_reports (
      id text primary key default gen_random_uuid()::text,
      user_id text references users(id),
      customer_profile_id text references customer_profiles(id),
      source_type text not null,
      source_name text,
      summary_json jsonb not null,
      report_json jsonb not null,
      markdown text,
      report_id text unique not null,
      share_url text,
      svg_url text,
      qr_svg_url text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create index if not exists idx_review_reports_user_created on review_reports(user_id, created_at desc);
    create index if not exists idx_customer_datasets_user_created on customer_datasets(user_id, created_at desc);
  `);
    dbReady = true;
    return true;
  } catch (error) {
    dbChecked = false;
    throw error;
  }
}

async function isDbAvailable() {
  try {
    return await ensureDatabase();
  } catch (error) {
    console.warn(`Database unavailable, using local fallback: ${error.message}`);
    dbReady = false;
    return false;
  }
}

function loadConfig() {
  if (!fs.existsSync(configPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    return {};
  }
}

function saveConfig(config) {
  ensureServerDir();
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.pbkdf2Sync(password, salt, 120000, 32, "sha256").toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!password || !stored || !stored.includes(":")) return false;
  const [salt, expected] = stored.split(":");
  const actual = hashPassword(password, salt).split(":")[1];
  return crypto.timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    phone: user.phone || "",
    email: user.email || "",
    role: user.role,
    status: user.status,
  };
}

function normalizeUserRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    phone: row.phone || "",
    email: row.email || "",
    password_hash: row.password_hash || row.passwordHash,
    role: row.role || "customer",
    status: row.status || "active",
    created_at: row.created_at || row.createdAt,
    updated_at: row.updated_at || row.updatedAt,
  };
}

async function getUserCount() {
  if (await isDbAvailable()) {
    const result = await queryDb("select count(*)::int as count from users");
    return result.rows[0].count;
  }
  return readLocalData().users.length;
}

async function findUserByLogin(login) {
  const value = String(login || "").trim();
  if (!value) return null;
  if (await isDbAvailable()) {
    const result = await queryDb("select * from users where lower(coalesce(email,'')) = lower($1) or phone = $1 limit 1", [value]);
    return normalizeUserRow(result.rows[0]);
  }
  const data = readLocalData();
  return normalizeUserRow(data.users.find((user) => String(user.email || "").toLowerCase() === value.toLowerCase() || user.phone === value));
}

async function getUserById(id) {
  if (!id) return null;
  if (await isDbAvailable()) {
    const result = await queryDb("select * from users where id = $1 limit 1", [id]);
    return normalizeUserRow(result.rows[0]);
  }
  return normalizeUserRow(readLocalData().users.find((user) => user.id === id));
}

async function createUser({ name, phone, email, password, companyName }) {
  const firstUser = (await getUserCount()) === 0;
  const role = firstUser ? "admin" : "customer";
  const passwordHash = hashPassword(password);
  if (await isDbAvailable()) {
    const result = await queryDb(
      "insert into users(name, phone, email, password_hash, role, status) values($1,$2,$3,$4,$5,'active') returning *",
      [name, phone || null, email || null, passwordHash, role],
    );
    const user = normalizeUserRow(result.rows[0]);
    await queryDb(
      "insert into customer_profiles(user_id, company_name, contact_name, contact_phone) values($1,$2,$3,$4) on conflict(user_id) do update set company_name=excluded.company_name, contact_name=excluded.contact_name, contact_phone=excluded.contact_phone, updated_at=now()",
      [user.id, companyName || "", name || "", phone || ""],
    );
    return user;
  }

  const data = readLocalData();
  const user = {
    id: createId("usr"),
    name,
    phone: phone || "",
    email: email || "",
    passwordHash,
    role,
    status: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  data.users.push(user);
  data.customerProfiles.push({
    id: createId("cpr"),
    userId: user.id,
    companyName: companyName || "",
    contactName: name || "",
    contactPhone: phone || "",
    notes: "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  writeLocalData(data);
  return normalizeUserRow(user);
}

async function getCustomerProfile(userId) {
  if (await isDbAvailable()) {
    const result = await queryDb("select * from customer_profiles where user_id = $1 limit 1", [userId]);
    const row = result.rows[0];
    return row
      ? { id: row.id, userId: row.user_id, companyName: row.company_name || "", contactName: row.contact_name || "", contactPhone: row.contact_phone || "", notes: row.notes || "" }
      : null;
  }
  const row = readLocalData().customerProfiles.find((profile) => profile.userId === userId);
  return row || null;
}

async function saveCustomerProfile(userId, body) {
  const next = {
    companyName: String(body.companyName || "").trim(),
    contactName: String(body.contactName || "").trim(),
    contactPhone: String(body.contactPhone || "").trim(),
    notes: String(body.notes || "").trim(),
  };
  if (await isDbAvailable()) {
    const result = await queryDb(
      `insert into customer_profiles(user_id, company_name, contact_name, contact_phone, notes)
       values($1,$2,$3,$4,$5)
       on conflict(user_id) do update set company_name=excluded.company_name, contact_name=excluded.contact_name, contact_phone=excluded.contact_phone, notes=excluded.notes, updated_at=now()
       returning *`,
      [userId, next.companyName, next.contactName, next.contactPhone, next.notes],
    );
    const row = result.rows[0];
    return { id: row.id, userId: row.user_id, companyName: row.company_name || "", contactName: row.contact_name || "", contactPhone: row.contact_phone || "", notes: row.notes || "" };
  }
  const data = readLocalData();
  let row = data.customerProfiles.find((profile) => profile.userId === userId);
  if (!row) {
    row = { id: createId("cpr"), userId, createdAt: new Date().toISOString() };
    data.customerProfiles.push(row);
  }
  Object.assign(row, next, { updatedAt: new Date().toISOString() });
  writeLocalData(data);
  return row;
}

function encryptSecret(value) {
  const secret = crypto.createHash("sha256").update(getSessionSecret()).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", secret, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64url")}.${tag.toString("base64url")}.${encrypted.toString("base64url")}`;
}

function decryptSecret(value) {
  if (!value || !String(value).includes(".")) return "";
  const [ivText, tagText, encryptedText] = String(value).split(".");
  const secret = crypto.createHash("sha256").update(getSessionSecret()).digest();
  const decipher = crypto.createDecipheriv("aes-256-gcm", secret, Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encryptedText, "base64url")), decipher.final()]).toString("utf8");
}

async function loadAiConfig() {
  if (await isDbAvailable()) {
    const result = await queryDb("select * from ai_configs order by updated_at desc limit 1");
    const row = result.rows[0];
    if (row) {
      return {
        apiKey: decryptSecret(row.api_key_encrypted),
        baseUrl: row.base_url,
        model: row.model,
        protocol: row.protocol,
        updatedAt: row.updated_at,
      };
    }
  }
  return loadConfig();
}

async function saveAiConfig(next, userId) {
  if (await isDbAvailable()) {
    await queryDb(
      "insert into ai_configs(base_url, model, protocol, api_key_encrypted, updated_by) values($1,$2,$3,$4,$5)",
      [next.baseUrl, next.model, next.protocol, encryptSecret(next.apiKey), userId || null],
    );
    return next;
  }
  saveConfig(next);
  return next;
}

async function publicConfigStatus(config = null) {
  const activeConfig = config || (await loadAiConfig());
  return {
    configured: Boolean(activeConfig.apiKey && activeConfig.model),
    adminReady: true,
    hasApiKey: Boolean(activeConfig.apiKey),
    baseUrl: activeConfig.baseUrl || "https://api.openai.com/v1",
    model: activeConfig.model || "gpt-5.2",
    protocol: activeConfig.protocol || (String(activeConfig.baseUrl || "").includes("deepseek") ? "chat_completions" : "responses"),
    database: (await isDbAvailable()) ? "connected" : "local-fallback",
  };
}

function normalizeBaseUrl(value) {
  return String(value || "https://api.openai.com/v1").trim().replace(/\/+$/, "");
}

function assertAdmin(config, adminPassword) {
  if (!config.adminHash) return true;
  return verifyPassword(adminPassword, config.adminHash);
}

async function getCurrentUser(req) {
  const token = parseCookies(req)[cookieName];
  const payload = verifySessionToken(token);
  if (!payload?.userId) return null;
  const user = await getUserById(payload.userId);
  if (!user || user.status !== "active") return null;
  return user;
}

async function requireUser(req, res) {
  const user = await getCurrentUser(req);
  if (!user) {
    sendJson(res, 401, { error: "请先登录后再使用该功能。" });
    return null;
  }
  return user;
}

async function requireAdmin(req, res) {
  const user = await requireUser(req, res);
  if (!user) return null;
  if (user.role !== "admin") {
    sendJson(res, 403, { error: "仅管理员可以执行该操作。" });
    return null;
  }
  return user;
}

async function saveDatasetRecord(userId, sourceType, summary, filename = "") {
  const rowCounts = summary.rowCounts || {};
  const sheetStatus = summary.sheetStatus || summary.datasetFiles || [];
  const metadata = {
    source: summary.source || "",
    generatedAt: summary.generatedAt || new Date().toISOString(),
    sessionId: summary.sessionId || "",
  };
  if (await isDbAvailable()) {
    const result = await queryDb(
      `insert into customer_datasets(user_id, source_type, filename, row_counts_json, sheet_status_json, metadata_json)
       values($1,$2,$3,$4,$5,$6) returning id`,
      [userId, sourceType, filename, jsonClone(rowCounts), jsonClone(sheetStatus), jsonClone(metadata)],
    );
    return result.rows[0].id;
  }
  const data = readLocalData();
  const record = {
    id: createId("dat"),
    userId,
    sourceType,
    filename,
    rowCountsJson: rowCounts,
    sheetStatusJson: sheetStatus,
    metadataJson: metadata,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  data.customerDatasets.push(record);
  writeLocalData(data);
  return record.id;
}

async function saveReviewReportRecord(userId, sourceType, sourceName, summary, generated) {
  const profile = await getCustomerProfile(userId);
  if (await isDbAvailable()) {
    const result = await queryDb(
      `insert into review_reports(user_id, customer_profile_id, source_type, source_name, summary_json, report_json, markdown, report_id, share_url, svg_url, qr_svg_url)
       values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
      [
        userId,
        profile?.id || null,
        sourceType,
        sourceName,
        jsonClone(summary),
        jsonClone(generated.report),
        generated.markdown || "",
        generated.reportId,
        generated.shareUrl,
        generated.svgUrl,
        generated.qrSvgUrl,
      ],
    );
    return result.rows[0].id;
  }
  const data = readLocalData();
  const record = {
    id: createId("rep"),
    userId,
    customerProfileId: profile?.id || "",
    sourceType,
    sourceName,
    summaryJson: summary,
    reportJson: generated.report,
    markdown: generated.markdown || "",
    reportId: generated.reportId,
    shareUrl: generated.shareUrl,
    svgUrl: generated.svgUrl,
    qrSvgUrl: generated.qrSvgUrl,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  data.reviewReports.push(record);
  writeLocalData(data);
  return record.id;
}

function normalizeReviewReportRow(row) {
  return {
    id: row.id,
    userId: row.user_id || row.userId,
    sourceType: row.source_type || row.sourceType,
    sourceName: row.source_name || row.sourceName || "",
    reportTitle: row.report_json?.title || row.reportJson?.title || "四季蝉AI复盘报告",
    report: row.report_json || row.reportJson || null,
    summary: row.summary_json || row.summaryJson || null,
    markdown: row.markdown || "",
    reportId: row.report_id || row.reportId,
    shareUrl: row.share_url || row.shareUrl,
    svgUrl: row.svg_url || row.svgUrl,
    qrSvgUrl: row.qr_svg_url || row.qrSvgUrl,
    createdAt: row.created_at || row.createdAt,
  };
}

async function listReviewReports(user) {
  if (await isDbAvailable()) {
    const result =
      user.role === "admin"
        ? await queryDb("select * from review_reports order by created_at desc limit 100")
        : await queryDb("select * from review_reports where user_id = $1 order by created_at desc limit 100", [user.id]);
    return result.rows.map(normalizeReviewReportRow);
  }
  const data = readLocalData();
  return data.reviewReports
    .filter((report) => user.role === "admin" || report.userId === user.id)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, 100)
    .map(normalizeReviewReportRow);
}

async function getReviewReport(user, id) {
  if (await isDbAvailable()) {
    const result =
      user.role === "admin"
        ? await queryDb("select * from review_reports where id = $1 limit 1", [id])
        : await queryDb("select * from review_reports where id = $1 and user_id = $2 limit 1", [id, user.id]);
    return normalizeReviewReportRow(result.rows[0]);
  }
  const report = readLocalData().reviewReports.find((item) => item.id === id && (user.role === "admin" || item.userId === user.id));
  return report ? normalizeReviewReportRow(report) : null;
}

async function parseMultipartFile(req) {
  return new Promise((resolve, reject) => {
    const busboy = Busboy({
      headers: req.headers,
      limits: { files: 1, fileSize: uploadLimitBytes },
    });
    let fileBuffer = null;
    let filename = "";
    let limitHit = false;

    busboy.on("file", (_name, file, info) => {
      filename = info.filename || "";
      const chunks = [];
      file.on("limit", () => {
        limitHit = true;
        file.resume();
      });
      file.on("data", (chunk) => chunks.push(chunk));
      file.on("end", () => {
        if (!limitHit) fileBuffer = Buffer.concat(chunks);
      });
    });
    busboy.on("error", reject);
    busboy.on("finish", () => {
      if (limitHit) {
        reject(new Error("文件超过10MB，请压缩或拆分后再上传。"));
        return;
      }
      if (!fileBuffer) {
        reject(new Error("没有收到Excel文件。"));
        return;
      }
      resolve({ buffer: fileBuffer, filename });
    });
    req.pipe(busboy);
  });
}

function toNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const text = String(value ?? "").replace(/[,，￥元%]/g, "").trim();
  if (!text) return 0;
  const num = Number(text);
  return Number.isFinite(num) ? num : 0;
}

function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

function compactRows(rows) {
  return rows.filter((row) => Object.values(row).some(hasValue));
}

function selectColumns(row, fields) {
  return fields.reduce((out, field) => {
    if (row[field] !== undefined && row[field] !== "") out[field] = row[field];
    return out;
  }, {});
}

function topRows(rows, field, fields, limit = 8, desc = true) {
  return [...rows]
    .filter((row) => toNumber(row[field]) !== 0)
    .sort((a, b) => (desc ? toNumber(b[field]) - toNumber(a[field]) : toNumber(a[field]) - toNumber(b[field])))
    .slice(0, limit)
    .map((row) => selectColumns(row, fields));
}

function sumField(rows, field) {
  return rows.reduce((sum, row) => sum + toNumber(row[field]), 0);
}

function countPositive(rows, field) {
  return rows.filter((row) => toNumber(row[field]) > 0).length;
}

function xmlDecode(text) {
  return String(text || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function parseAttributes(fragment) {
  const attrs = {};
  const pattern = /([\w:]+)="([^"]*)"/g;
  let match;
  while ((match = pattern.exec(fragment))) {
    attrs[match[1]] = xmlDecode(match[2]);
  }
  return attrs;
}

function columnIndex(cellRef) {
  const letters = String(cellRef || "").match(/[A-Z]+/i)?.[0] || "";
  let index = 0;
  for (const letter of letters.toUpperCase()) {
    index = index * 26 + (letter.charCodeAt(0) - 64);
  }
  return Math.max(index - 1, 0);
}

function extractTextNodes(xml) {
  const parts = [];
  const pattern = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
  let match;
  while ((match = pattern.exec(xml))) {
    parts.push(xmlDecode(match[1]));
  }
  return parts.join("");
}

async function readZipText(zip, filePath) {
  const normalized = filePath.replace(/\\/g, "/");
  const file = zip.file(normalized) || Object.values(zip.files).find((entry) => entry.name.replace(/\\/g, "/") === normalized);
  return file ? await file.async("string") : "";
}

async function parseSharedStrings(zip) {
  const xml = await readZipText(zip, "xl/sharedStrings.xml");
  if (!xml) return [];
  const values = [];
  const pattern = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let match;
  while ((match = pattern.exec(xml))) {
    values.push(extractTextNodes(match[1]));
  }
  return values;
}

function parseRelationships(xml) {
  const rels = {};
  const pattern = /<Relationship\b([^>]*?)\/?>/g;
  let match;
  while ((match = pattern.exec(xml))) {
    const attrs = parseAttributes(match[1]);
    if (attrs.Id && attrs.Target) {
      rels[attrs.Id] = attrs.Target.replace(/\\/g, "/").replace(/^\/+/, "");
    }
  }
  return rels;
}

function parseWorkbookSheets(xml) {
  const sheets = [];
  const pattern = /<sheet\b([^>]*?)\/?>/g;
  let match;
  while ((match = pattern.exec(xml))) {
    const attrs = parseAttributes(match[1]);
    if (attrs.name && attrs["r:id"]) {
      sheets.push({ name: attrs.name, relId: attrs["r:id"] });
    }
  }
  return sheets;
}

function parseCellValue(attrs, cellXml, sharedStrings) {
  if (attrs.t === "inlineStr") return extractTextNodes(cellXml);
  const value = xmlDecode(cellXml.match(/<v\b[^>]*>([\s\S]*?)<\/v>/)?.[1] || "");
  if (attrs.t === "s") return sharedStrings[Number(value)] || "";
  if (attrs.t === "str") return value;
  return value;
}

function parseSheetRows(xml, sharedStrings) {
  const parsedRows = [];
  const rowPattern = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let rowMatch;
  while ((rowMatch = rowPattern.exec(xml))) {
    const rowValues = [];
    const cellPattern = /<c\b([^>]*?)>([\s\S]*?)<\/c>/g;
    let cellMatch;
    while ((cellMatch = cellPattern.exec(rowMatch[1]))) {
      const attrs = parseAttributes(cellMatch[1]);
      rowValues[columnIndex(attrs.r)] = parseCellValue(attrs, cellMatch[2], sharedStrings);
    }
    parsedRows.push(rowValues.map((value) => value || ""));
  }
  return parsedRows;
}

async function parseWorkbook(buffer, filename) {
  const zip = await JSZip.loadAsync(buffer);
  const workbookXml = await readZipText(zip, "xl/workbook.xml");
  const relsXml = await readZipText(zip, "xl/_rels/workbook.xml.rels");
  const sharedStrings = await parseSharedStrings(zip);
  const rels = parseRelationships(relsXml);
  const workbookSheets = parseWorkbookSheets(workbookXml);
  const sheets = {};
  const sheetHeaders = {};

  for (const sheet of workbookSheets) {
    const target = rels[sheet.relId];
    if (!target) continue;
    const targetPath = target.startsWith("xl/") ? target : `xl/${target}`;
    const xml = await readZipText(zip, targetPath);
    const parsedRows = parseSheetRows(xml, sharedStrings);
    const headers = (parsedRows[0] || []).map((value, index) => String(value || `列${index + 1}`).trim());
    sheetHeaders[sheet.name] = headers;

    const rows = [];
    for (const values of parsedRows.slice(1)) {
      if (!values.some(hasValue)) continue;
      const record = {};
      headers.forEach((header, index) => {
        record[header] = values[index] || "";
      });
      rows.push(record);
    }

    sheets[sheet.name] = compactRows(rows);
  }

  const sheetStatus = expectedSheets.map((name) => ({
    name,
    exists: Boolean(sheets[name]),
    rows: sheets[name] ? sheets[name].length : 0,
    headers: sheetHeaders[name] || [],
  }));

  const comparison = sheets["销售变化_上上月对比"] || [];
  const trend = sheets["销售变化_上上月-上月趋势"] || [];
  const activity = sheets["上月活动商品销售统计"] || [];
  const cashout = sheets["店员提现情况及账户总览"] || [];
  const incentive = sheets["活动参加类型_上月"] || [];
  const shareReward = sheets["店员晒单厂家给额外激励"] || [];

  const rewardFields = [
    "单品奖励金额",
    "疗程奖励金额",
    "关联奖励金额",
    "单品目标奖励金额",
    "系列目标奖励金额",
    "组合目标奖励金额",
    "早鸟奖励金额",
    "排名奖励金额",
  ];

  const summary = {
    filename,
    sheetStatus,
    rowCounts: Object.fromEntries(sheetStatus.map((item) => [item.name, item.rows])),
    salesChange: {
      topQuantityGrowth: topRows(comparison, "销售数量比上期（%）", ["商品名称", "商品规格", "商品编码", "销售数量比上期（%）", "销售数量", "销售金额", "购买顾客数"], 10, true),
      weakQuantityGrowth: topRows(comparison, "销售数量比上期（%）", ["商品名称", "商品规格", "商品编码", "销售数量比上期（%）", "销售数量", "销售金额", "购买顾客数"], 10, false),
      topSalesAmount: topRows(comparison, "销售金额", ["商品名称", "商品规格", "商品编码", "销售金额", "销售数量", "购买顾客数", "订单数"], 10, true),
    },
    trend: {
      topQuantityGrowth: topRows(trend, "销售数量比上期（%）", ["商品名称", "商品规格", "商品编码", "销售数量比上期（%）", "销售数量", "销售金额", "购买顾客数"], 10, true),
      weakQuantityGrowth: topRows(trend, "销售数量比上期（%）", ["商品名称", "商品规格", "商品编码", "销售数量比上期（%）", "销售数量", "销售金额", "购买顾客数"], 10, false),
      topSalesAmount: topRows(trend, "销售金额", ["商品名称", "商品规格", "商品编码", "销售金额", "销售数量", "购买顾客数", "订单数"], 10, true),
    },
    activity: {
      skuCount: activity.length,
      totalSalesAmount: sumField(activity, "激励商品销售金额"),
      totalRewardAmount: sumField(activity, "奖励金额"),
      totalRewardTimes: sumField(activity, "激励次数"),
      topSalesAmount: topRows(activity, "激励商品销售金额", ["商品名称", "商品编码", "动销门店数", "动销员工数", "激励商品销售金额", "激励次数", "奖励金额"], 10, true),
      topRewardAmount: topRows(activity, "奖励金额", ["商品名称", "商品编码", "动销门店数", "动销员工数", "激励商品销售金额", "激励次数", "奖励金额"], 10, true),
    },
    cashout: {
      employeeCount: cashout.length,
      incomeEmployeeCount: cashout.filter((row) => toNumber(row["累计及时豆（元）"]) + toNumber(row["累计延时豆（元）"]) > 0).length,
      cashoutEmployeeCount: cashout.filter((row) => toNumber(row["累计提现及时豆（元）"]) > 0).length,
      totalInstantBeans: sumField(cashout, "累计及时豆（元）"),
      totalDelayBeans: sumField(cashout, "累计延时豆（元）"),
      totalCashout: sumField(cashout, "累计提现及时豆（元）"),
      totalBalance: sumField(cashout, "当前及时豆余额（元）"),
    },
    incentive: {
      skuCount: incentive.length,
      rewardTypes: rewardFields.map((field) => ({
        name: field,
        skuCount: countPositive(incentive, field),
        amount: sumField(incentive, field),
        used: countPositive(incentive, field) > 0,
      })),
    },
    shareReward: {
      recordCount: shareReward.length,
      employeeCount: new Set(shareReward.map((row) => row["员工编码"]).filter(hasValue)).size,
      factoryCount: new Set(shareReward.map((row) => row["激励厂家"]).filter(hasValue)).size,
      totalAmount: sumField(shareReward, "激励总金额"),
      topFactories: topRows(shareReward, "激励总金额", ["激励厂家", "激励总金额", "员工姓名", "所属机构", "晒单时间", "激励内容"], 10, true),
    },
  };

  return summary;
}

function hasUsableDetail(summary) {
  return expectedSheets.some((name) => (summary.rowCounts[name] || 0) > 0);
}

function buildPrompt(summary) {
  return [
    "你是海典四季蝉重点品数字化动销平台的运营复盘顾问。",
    "请基于客户上传的Excel数据摘要，输出品种动销复盘报告。",
    "固定业务口径：AAA品种是销售额、毛利额、客流量都进入核心贡献区间的主力赚钱品种。",
    "四季蝉不是单纯红包工具，而是把厂家、连锁总部、门店店员、顾客连接起来，围绕重点品完成选品、培训、激励、销售、提现、统计、复盘的数字化运营平台。",
    "不要加入与客户数据无关的营销节点、季节场景或泛化品类建议。",
    "请关注：品种增长/下滑、活动商品销售与奖励闭环、激励方式使用/未使用价值、店员提现参与、厂家晒单打赏、下一步动作。",
    "输出必须是JSON，不要输出Markdown代码块。",
    "数据摘要如下：",
    JSON.stringify(summary),
  ].join("\n");
}

const reportSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "executiveSummary", "highlights", "risks", "sections", "nextActions"],
  properties: {
    title: { type: "string" },
    executiveSummary: { type: "string" },
    highlights: { type: "array", items: { type: "string" } },
    risks: { type: "array", items: { type: "string" } },
    sections: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["heading", "bullets"],
        properties: {
          heading: { type: "string" },
          bullets: { type: "array", items: { type: "string" } },
        },
      },
    },
    nextActions: { type: "array", items: { type: "string" } },
  },
};

function extractOutputText(data) {
  if (typeof data.output_text === "string") return data.output_text;
  const chunks = [];
  for (const output of data.output || []) {
    for (const content of output.content || []) {
      if (typeof content.text === "string") chunks.push(content.text);
    }
  }
  return chunks.join("\n").trim();
}

async function callOpenAI(config, input, useSchema = true) {
  const endpoint = `${normalizeBaseUrl(config.baseUrl)}/responses`;
  const body = {
    model: config.model,
    input,
    max_output_tokens: 2200,
  };

  if (useSchema) {
    body.text = {
      format: {
        type: "json_schema",
        name: "sijichan_review_report",
        strict: true,
        schema: reportSchema,
      },
    };
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const message = data?.error?.message || text || `AI接口返回 ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return extractOutputText(data);
}

async function callChatCompletions(config, input) {
  const endpoint = `${normalizeBaseUrl(config.baseUrl)}/chat/completions`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        {
          role: "system",
          content: "你是严谨的医药连锁重点品数字化动销复盘顾问。请严格输出JSON对象，不要输出Markdown代码块。",
        },
        {
          role: "user",
          content: `${input}\n\n请输出JSON对象，字段必须包含：title、executiveSummary、highlights、risks、sections、nextActions。sections数组每项包含heading和bullets。`,
        },
      ],
      response_format: { type: "json_object" },
      temperature: 0.2,
      max_tokens: 2600,
    }),
  });

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const message = data?.error?.message || text || `AI接口返回 ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data?.choices?.[0]?.message?.content || "";
}

async function callConfiguredAI(config, prompt) {
  const protocol = config.protocol || (String(config.baseUrl || "").includes("deepseek") ? "chat_completions" : "responses");
  if (protocol === "chat_completions") {
    return callChatCompletions(config, prompt);
  }

  try {
    return await callOpenAI(config, prompt, true);
  } catch (error) {
    if (error.status === 400) {
      return callOpenAI(config, `${prompt}\n请按JSON对象返回，字段包含title、executiveSummary、highlights、risks、sections、nextActions。`, false);
    }
    throw error;
  }
}

function parseReportJson(text) {
  const clean = String(text || "").replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
  return JSON.parse(clean);
}

function reportToMarkdown(report) {
  const lines = [`# ${report.title || "四季蝉AI复盘报告"}`, "", report.executiveSummary || ""];
  if (report.highlights?.length) {
    lines.push("", "## 核心亮点", ...report.highlights.map((item) => `- ${item}`));
  }
  if (report.risks?.length) {
    lines.push("", "## 风险与短板", ...report.risks.map((item) => `- ${item}`));
  }
  for (const section of report.sections || []) {
    lines.push("", `## ${section.heading}`, ...(section.bullets || []).map((item) => `- ${item}`));
  }
  if (report.nextActions?.length) {
    lines.push("", "## 下一步动作", ...report.nextActions.map((item) => `- ${item}`));
  }
  return lines.filter((line, index) => line !== "" || lines[index - 1] !== "").join("\n");
}

function renderList(items = []) {
  return items.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
}

function renderReportHtml({ report, markdown, summary, shareUrl, svgUrl, qrSvgUrl }) {
  const sections = (report.sections || [])
    .map(
      (section) => `
        <section class="report-section">
          <h2>${escapeHtml(section.heading)}</h2>
          <ul>${renderList(section.bullets)}</ul>
        </section>
      `,
    )
    .join("");

  const sourceName = summary?.source || summary?.filename || "四季蝉复盘数据";
  const generatedAt = new Date().toLocaleString("zh-CN", { hour12: false });

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(report.title || "四季蝉AI复盘报告")}</title>
  <style>
    :root { --blue:#2a4bff; --navy:#1f3f95; --ink:#172033; --muted:#63708a; --line:#dbe4ff; --warm:#ff7a2f; --soft:#f5f7ff; }
    * { box-sizing: border-box; }
    body { margin:0; font-family:"Segoe UI","Microsoft YaHei",sans-serif; color:var(--ink); background:linear-gradient(135deg,#f8fbff,#eef2ff 48%,#fff7f0); }
    .page { width:min(1120px, calc(100% - 32px)); margin:0 auto; padding:32px 0 46px; }
    .hero { position:relative; overflow:hidden; border:1px solid var(--line); border-radius:22px; padding:34px; background:linear-gradient(135deg,rgba(255,255,255,.96),rgba(239,244,255,.92)); box-shadow:0 24px 60px rgba(31,63,149,.12); }
    .hero:after { content:""; position:absolute; right:-120px; top:-160px; width:360px; height:360px; border-radius:50%; background:radial-gradient(circle,rgba(42,75,255,.18),transparent 68%); }
    .kicker { display:inline-flex; align-items:center; gap:8px; padding:8px 14px; border:1px solid #9eb7ff; color:var(--blue); background:#fff; border-radius:999px; font-weight:800; }
    h1 { max-width:850px; margin:18px 0 14px; color:var(--navy); font-size:44px; line-height:1.12; letter-spacing:0; }
    .summary { max-width:860px; color:#3f4b62; font-size:18px; line-height:1.8; }
    .meta { display:flex; flex-wrap:wrap; gap:10px; margin-top:18px; color:var(--muted); }
    .meta span { padding:8px 12px; border-radius:999px; background:#fff; border:1px solid var(--line); }
    .grid { display:grid; grid-template-columns:1fr 1fr; gap:18px; margin-top:22px; }
    .card, .report-section { border:1px solid var(--line); border-radius:18px; background:rgba(255,255,255,.94); box-shadow:0 14px 34px rgba(24,52,126,.07); }
    .card { padding:22px; }
    .card h2, .report-section h2 { margin:0 0 12px; color:var(--navy); font-size:24px; }
    ul { margin:0; padding-left:22px; line-height:1.75; }
    li + li { margin-top:7px; }
    .report-section { margin-top:18px; padding:24px; }
    .actions { display:grid; grid-template-columns:1fr 260px; gap:18px; align-items:center; margin-top:22px; padding:22px; border-radius:18px; border:1px solid var(--line); background:#fff; }
    .buttons { display:flex; flex-wrap:wrap; gap:10px; margin-top:14px; }
    a.button { display:inline-flex; align-items:center; justify-content:center; min-height:40px; padding:0 16px; border-radius:10px; text-decoration:none; color:#fff; background:var(--blue); font-weight:800; }
    a.button.secondary { color:var(--navy); background:#fff; border:1px solid var(--line); }
    .qr { width:220px; height:220px; padding:12px; border-radius:16px; border:1px solid var(--line); background:#fff; justify-self:end; }
    .markdown { white-space:pre-wrap; display:none; }
    @media (max-width:760px){ h1{font-size:32px}.grid,.actions{grid-template-columns:1fr}.qr{justify-self:start;width:180px;height:180px}.hero{padding:24px} }
  </style>
</head>
<body>
  <main class="page">
    <section class="hero">
      <div class="kicker">四季蝉 AI DATA REVIEW</div>
      <h1>${escapeHtml(report.title || "四季蝉AI复盘报告")}</h1>
      <p class="summary">${escapeHtml(report.executiveSummary || "")}</p>
      <div class="meta"><span>数据来源：${escapeHtml(sourceName)}</span><span>生成时间：${escapeHtml(generatedAt)}</span></div>
    </section>
    <section class="grid">
      <div class="card"><h2>核心亮点</h2><ul>${renderList(report.highlights)}</ul></div>
      <div class="card"><h2>风险与短板</h2><ul>${renderList(report.risks)}</ul></div>
    </section>
    ${sections}
    <section class="report-section"><h2>下一步动作</h2><ul>${renderList(report.nextActions)}</ul></section>
    <section class="actions">
      <div>
        <h2>扫码查看与导出</h2>
        <p>此页面可直接分享给客户查看，也可下载SVG长图用于汇报材料。</p>
        <div class="buttons">
          <a class="button" href="${escapeHtml(svgUrl)}" download>下载SVG长图</a>
          <a class="button secondary" href="${escapeHtml(qrSvgUrl)}" download>下载二维码</a>
          <a class="button secondary" href="${escapeHtml(shareUrl)}">刷新报告页</a>
        </div>
      </div>
      <img class="qr" src="${escapeHtml(qrSvgUrl)}" alt="报告二维码" />
    </section>
    <pre class="markdown">${escapeHtml(markdown)}</pre>
  </main>
</body>
</html>`;
}

function svgText(lines, x, y, options = {}) {
  const size = options.size || 28;
  const fill = options.fill || "#172033";
  const weight = options.weight || 500;
  const lineHeight = options.lineHeight || Math.round(size * 1.55);
  return lines
    .map((line, index) => `<text x="${x}" y="${y + index * lineHeight}" font-size="${size}" font-weight="${weight}" fill="${fill}">${escapeXml(line)}</text>`)
    .join("");
}

function renderReportSvg({ report, summary, shareUrl }) {
  const width = 1200;
  let y = 92;
  const parts = [];
  const addBlock = (title, items) => {
    parts.push(`<rect x="60" y="${y - 38}" width="1080" height="${Math.max(120, 74 + items.length * 54)}" rx="22" fill="#ffffff" stroke="#dbe4ff"/>`);
    parts.push(svgText([title], 88, y, { size: 30, weight: 900, fill: "#1f3f95" }));
    y += 52;
    for (const item of items) {
      const wrapped = wrapText(item, 46);
      parts.push(`<circle cx="96" cy="${y - 10}" r="5" fill="#ff7a2f"/>`);
      parts.push(svgText(wrapped, 114, y, { size: 23, fill: "#273349", lineHeight: 34 }));
      y += wrapped.length * 34 + 16;
    }
    y += 32;
  };

  const titleLines = wrapText(report.title || "四季蝉AI复盘报告", 18);
  const summaryLines = wrapText(report.executiveSummary || "", 38);
  parts.push(`<rect x="0" y="0" width="${width}" height="100%" fill="#f5f7ff"/>`);
  parts.push(`<rect x="36" y="36" width="1128" height="320" rx="28" fill="url(#hero)" stroke="#cfdcff"/>`);
  parts.push(`<text x="76" y="${y}" font-size="24" font-weight="900" fill="#2a4bff">四季蝉 AI DATA REVIEW</text>`);
  y += 62;
  parts.push(svgText(titleLines, 76, y, { size: 52, weight: 900, fill: "#1f3f95", lineHeight: 62 }));
  y += titleLines.length * 62 + 22;
  parts.push(svgText(summaryLines.slice(0, 4), 76, y, { size: 25, fill: "#3f4b62", lineHeight: 40 }));
  y = 430;

  addBlock("核心亮点", report.highlights || []);
  addBlock("风险与短板", report.risks || []);
  for (const section of report.sections || []) addBlock(section.heading, section.bullets || []);
  addBlock("下一步动作", report.nextActions || []);

  parts.push(`<rect x="60" y="${y - 30}" width="1080" height="130" rx="22" fill="#1f3f95"/>`);
  parts.push(svgText(["扫码查看完整网页报告", shareUrl], 88, y + 24, { size: 25, weight: 800, fill: "#ffffff", lineHeight: 38 }));
  y += 150;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${y}" viewBox="0 0 ${width} ${y}">
  <defs>
    <linearGradient id="hero" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="55%" stop-color="#eef2ff"/>
      <stop offset="100%" stop-color="#fff7f0"/>
    </linearGradient>
  </defs>
  ${parts.join("\n")}
</svg>`;
}

async function persistReportArtifact({ report, markdown, summary }) {
  ensureServerDir();
  fs.mkdirSync(reportsDir, { recursive: true });
  const reportId = `${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${crypto.randomBytes(8).toString("hex")}`;
  const reportDir = path.join(reportsDir, reportId);
  fs.mkdirSync(reportDir, { recursive: true });

  const shareUrl = `${publicReportBaseUrl}/reports/${reportId}/`;
  const svgUrl = `${shareUrl}report.svg`;
  const qrSvgUrl = `${shareUrl}qr.svg`;
  const qrSvg = await QRCode.toString(shareUrl, {
    type: "svg",
    errorCorrectionLevel: "M",
    margin: 1,
    color: { dark: "#1f3f95", light: "#ffffff" },
  });
  const reportSvg = renderReportSvg({ report, summary, shareUrl });
  const html = renderReportHtml({ report, markdown, summary, shareUrl, svgUrl, qrSvgUrl });

  fs.writeFileSync(path.join(reportDir, "report.json"), JSON.stringify({ report, markdown, summary, shareUrl, svgUrl, qrSvgUrl }, null, 2), "utf8");
  fs.writeFileSync(path.join(reportDir, "index.html"), html, "utf8");
  fs.writeFileSync(path.join(reportDir, "report.svg"), reportSvg, "utf8");
  fs.writeFileSync(path.join(reportDir, "qr.svg"), qrSvg, "utf8");

  return { reportId, shareUrl, svgUrl, qrSvgUrl };
}

async function generateReportFromSummary(summary) {
  const config = await loadAiConfig();
  if (!config.apiKey || !config.model) {
    const error = new Error("AI服务未配置，请先进入AI配置页面。");
    error.statusCode = 400;
    throw error;
  }

  const prompt = buildPrompt(summary);
  const reportText = await callConfiguredAI(config, prompt);
  const report = parseReportJson(reportText);
  const markdown = reportToMarkdown(report);
  const artifact = await persistReportArtifact({ report, markdown, summary });
  return { report, markdown, ...artifact };
}

async function ensureSijichanRepo() {
  ensureServerDir();
  if (fs.existsSync(path.join(sijichanRepoDir, ".git"))) {
    await runCommand("git", ["fetch", "origin", "main"], { cwd: sijichanRepoDir, timeoutMs: 120000 });
    await runCommand("git", ["reset", "--hard", "origin/main"], { cwd: sijichanRepoDir, timeoutMs: 120000 });
  } else {
    if (fs.existsSync(sijichanRepoDir)) {
      fs.rmSync(sijichanRepoDir, { recursive: true, force: true });
    }
    await runCommand("git", ["clone", "--depth", "1", sijichanRepoUrl, sijichanRepoDir], { timeoutMs: 180000 });
  }

  if (fs.existsSync(path.join(sijichanRepoDir, "package.json")) && !fs.existsSync(path.join(sijichanRepoDir, "node_modules"))) {
    if (fs.existsSync(path.join(sijichanRepoDir, "package-lock.json"))) {
      await runCommand("npm", ["ci", "--omit=dev"], { cwd: sijichanRepoDir, timeoutMs: 180000 });
    } else {
      await runCommand("npm", ["install", "--omit=dev"], { cwd: sijichanRepoDir, timeoutMs: 180000 });
    }
  }
}

function listJsonFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJsonFiles(full));
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".json")) out.push(full);
  }
  return out;
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function rowsFromAnyJson(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.rows)) return value.rows;
  if (Array.isArray(value?.data)) return value.data;
  if (Array.isArray(value?.records)) return value.records;
  if (Array.isArray(value?.items)) return value.items;
  if (Array.isArray(value?.list)) return value.list;
  return [];
}

function pickField(row, candidates) {
  for (const key of candidates) {
    if (row && row[key] !== undefined && row[key] !== "") return row[key];
  }
  return "";
}

function topGenericRows(rows, metricCandidates, fields, limit = 10, desc = true) {
  const metricKey = metricCandidates.find((key) => rows.some((row) => toNumber(row[key]) !== 0));
  if (!metricKey) return [];
  return [...rows]
    .filter((row) => toNumber(row[metricKey]) !== 0)
    .sort((a, b) => (desc ? toNumber(b[metricKey]) - toNumber(a[metricKey]) : toNumber(a[metricKey]) - toNumber(b[metricKey])))
    .slice(0, limit)
    .map((row) => {
      const out = {};
      for (const field of fields) {
        const value = pickField(row, field.candidates);
        if (value !== "") out[field.name] = value;
      }
      out[metricKey] = row[metricKey];
      return out;
    });
}

function summarizeSijichanDataset(outDir, requestInfo) {
  const datasetDir = path.join(outDir, "dataset");
  const jsonFiles = listJsonFiles(datasetDir);
  const files = jsonFiles.map((filePath) => {
    const data = readJsonFile(filePath);
    const rows = rowsFromAnyJson(data);
    return {
      name: path.relative(datasetDir, filePath).replace(/\\/g, "/"),
      rows,
      rowCount: rows.length,
      headers: rows[0] ? Object.keys(rows[0]).slice(0, 40) : [],
    };
  });

  const allRows = files.flatMap((file) => file.rows.map((row) => ({ ...row, 数据文件: file.name })));
  const productName = [{ name: "商品名称", candidates: ["商品名称", "品种名称", "通用名", "productName", "goodsName", "skuName", "name"] }];
  const productCode = [{ name: "商品编码", candidates: ["商品编码", "品种编码", "productCode", "goodsCode", "skuCode", "code"] }];
  const commonFields = [...productName, ...productCode, { name: "数据文件", candidates: ["数据文件"] }];

  const salesMetric = ["销售金额", "激励商品销售金额", "saleAmount", "salesAmount", "amount", "销售额"];
  const growthMetric = ["销售数量比上期（%）", "growthRate", "increaseRate", "环比增长率", "增长率"];
  const rewardMetric = ["奖励金额", "激励总金额", "单品奖励金额", "rewardAmount", "amount"];
  const cashoutMetric = ["累计提现及时豆（元）", "提现金额", "cashoutAmount", "withdrawAmount"];

  return {
    source: "登录获取",
    sessionId: "019e990b-bed6-7fa0-9aaf-02058375c7f0",
    repository: "oldxianyu/sijichan-shuju",
    requestInfo,
    generatedAt: new Date().toISOString(),
    datasetFiles: files.map(({ name, rowCount, headers }) => ({ name, rowCount, headers })),
    rowCounts: Object.fromEntries(files.map((file) => [file.name, file.rowCount])),
    salesChange: {
      topSalesAmount: topGenericRows(allRows, salesMetric, commonFields, 10, true),
      topQuantityGrowth: topGenericRows(allRows, growthMetric, commonFields, 10, true),
      weakQuantityGrowth: topGenericRows(allRows, growthMetric, commonFields, 10, false),
    },
    activity: {
      skuCount: new Set(allRows.map((row) => pickField(row, ["商品编码", "品种编码", "productCode", "goodsCode", "skuCode"])).filter(hasValue)).size,
      topSalesAmount: topGenericRows(allRows, salesMetric, commonFields, 10, true),
      topRewardAmount: topGenericRows(allRows, rewardMetric, commonFields, 10, true),
    },
    cashout: {
      topCashout: topGenericRows(allRows, cashoutMetric, [
        { name: "员工姓名", candidates: ["员工姓名", "clerkName", "employeeName", "name"] },
        { name: "门店名称", candidates: ["门店名称", "storeName", "机构名称"] },
        { name: "数据文件", candidates: ["数据文件"] },
      ], 10, true),
    },
    incentive: {
      rewardTypes: [
        "单品奖励金额",
        "疗程奖励金额",
        "关联奖励金额",
        "单品目标奖励金额",
        "系列目标奖励金额",
        "组合目标奖励金额",
        "早鸟奖励金额",
        "排名奖励金额",
      ].map((field) => ({
        name: field,
        skuCount: countPositive(allRows, field),
        amount: sumField(allRows, field),
        used: countPositive(allRows, field) > 0,
      })),
    },
    shareReward: {
      topFactories: topGenericRows(allRows, ["激励总金额", "rewardAmount", "amount"], [
        { name: "激励厂家", candidates: ["激励厂家", "factoryName", "manufacturer"] },
        { name: "员工姓名", candidates: ["员工姓名", "employeeName", "clerkName"] },
        { name: "数据文件", candidates: ["数据文件"] },
      ], 10, true),
    },
  };
}

async function runSijichanExport(body) {
  await ensureSijichanRepo();

  const scriptPath = path.join(sijichanRepoDir, "sijichan_data_export.js");
  if (!fs.existsSync(scriptPath)) {
    throw new Error("sijichan-shuju仓库中未找到 sijichan_data_export.js。");
  }

  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "sijichan-data-"));
  const args = [scriptPath, "--out-dir", outDir];
  if (body.asOf) args.push("--as-of", String(body.asOf));
  if (body.merCode) args.push("--mer-code", String(body.merCode));
  if (body.merName) args.push("--mer-name", String(body.merName));
  if (body.operator) args.push("--operator", String(body.operator));

  const env = {
    ...process.env,
    HTTP_PROXY: "",
    HTTPS_PROXY: "",
    ALL_PROXY: "",
    SJC_USERNAME: body.username || "",
    SJC_PASSWORD: body.password || "",
    SJC_TOKEN: body.token || "",
  };

  if (!env.SJC_TOKEN && (!env.SJC_USERNAME || !env.SJC_PASSWORD)) {
    fs.rmSync(outDir, { recursive: true, force: true });
    throw new Error("请填写四季蝉账号密码，或填写已有Token。");
  }

  try {
    await runCommand("node", args, { cwd: sijichanRepoDir, env, timeoutMs: 180000 });
    return { outDir, summary: summarizeSijichanDataset(outDir, {
      asOf: body.asOf || "",
      merCode: body.merCode || "",
      merName: body.merName || "",
      operator: body.operator || "",
    }) };
  } catch (error) {
    fs.rmSync(outDir, { recursive: true, force: true });
    throw error;
  }
}

async function handleConfigStatus(_req, res) {
  sendJson(res, 200, await publicConfigStatus());
}

async function handleSaveConfig(req, res) {
  const user = await requireAdmin(req, res);
  if (!user) return;
  const body = await readJsonBody(req);
  const current = await loadAiConfig();

  const next = {
    apiKey: body.apiKey ? String(body.apiKey).trim() : current.apiKey,
    baseUrl: normalizeBaseUrl(body.baseUrl || current.baseUrl),
    model: String(body.model || current.model || "gpt-5.2").trim(),
    protocol: String(body.protocol || current.protocol || "responses").trim(),
    updatedAt: new Date().toISOString(),
  };

  if (!next.apiKey) {
    sendJson(res, 400, { error: "请填写API Key。" });
    return;
  }

  await saveAiConfig(next, user.id);
  sendJson(res, 200, { ok: true, status: await publicConfigStatus(next) });
}

async function handleTestConfig(req, res) {
  const user = await requireAdmin(req, res);
  if (!user) return;
  const body = await readJsonBody(req);
  const saved = await loadAiConfig();

  const config = {
    apiKey: body.apiKey ? String(body.apiKey).trim() : saved.apiKey,
    baseUrl: normalizeBaseUrl(body.baseUrl || saved.baseUrl),
    model: String(body.model || saved.model || "gpt-5.2").trim(),
    protocol: String(body.protocol || saved.protocol || "responses").trim(),
  };

  if (!config.apiKey) {
    sendJson(res, 400, { error: "请先填写或保存API Key。" });
    return;
  }

  const output = (config.protocol || "").includes("chat")
    ? await callChatCompletions(config, "请只回复JSON：{\"message\":\"连接成功\"}")
    : await callOpenAI(config, "请只回复“连接成功”。", false);
  sendJson(res, 200, { ok: true, message: output || "连接成功" });
}

async function handleReviewReport(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  const { buffer, filename } = await parseMultipartFile(req);
  if (!/\.xlsx$/i.test(filename)) {
    sendJson(res, 400, { error: "仅支持上传 .xlsx 文件。" });
    return;
  }

  const summary = await parseWorkbook(buffer, filename);
  if (!hasUsableDetail(summary)) {
    sendJson(res, 422, { error: "缺少明细数据。请在标准模板的Sheet3之后粘贴客户明细数据后再上传。", summary });
    return;
  }

  await saveDatasetRecord(user.id, "excel", summary, filename);
  const { report, markdown, reportId, shareUrl, svgUrl, qrSvgUrl } = await generateReportFromSummary(summary);
  const dbReportId = await saveReviewReportRecord(user.id, "excel", filename, summary, { report, markdown, reportId, shareUrl, svgUrl, qrSvgUrl });
  sendJson(res, 200, {
    ok: true,
    id: dbReportId,
    summary,
    report,
    markdown,
    reportId,
    shareUrl,
    svgUrl,
    qrSvgUrl,
  });
}

async function handleSijichanReviewReport(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  const body = await readJsonBody(req, 1024 * 1024);
  const config = await loadAiConfig();
  if (!config.apiKey || !config.model) {
    sendJson(res, 400, { error: "AI服务未配置，请先进入AI配置页面。" });
    return;
  }

  const { outDir, summary } = await runSijichanExport(body);
  try {
    const files = summary.datasetFiles || [];
    if (!files.some((file) => file.rowCount > 0)) {
      sendJson(res, 422, { error: "接口已返回数据包，但没有可用于复盘的明细数据。", summary });
      return;
    }
    await saveDatasetRecord(user.id, "login", summary, summary.source || "登录获取");
    const { report, markdown, reportId, shareUrl, svgUrl, qrSvgUrl } = await generateReportFromSummary(summary);
    const dbReportId = await saveReviewReportRecord(user.id, "login", "登录获取", summary, { report, markdown, reportId, shareUrl, svgUrl, qrSvgUrl });
    sendJson(res, 200, { ok: true, id: dbReportId, summary, report, markdown, reportId, shareUrl, svgUrl, qrSvgUrl });
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

async function handleRegister(req, res) {
  const body = await readJsonBody(req);
  const name = String(body.name || "").trim();
  const companyName = String(body.companyName || "").trim();
  const phone = String(body.phone || "").trim();
  const email = String(body.email || "").trim();
  const password = String(body.password || "");
  if (!name || !companyName || !password || (!phone && !email)) {
    sendJson(res, 400, { error: "请填写姓名、公司名称、手机号或邮箱、密码。" });
    return;
  }
  if (password.length < 6) {
    sendJson(res, 400, { error: "密码至少需要6位。" });
    return;
  }
  if (await findUserByLogin(email || phone)) {
    sendJson(res, 409, { error: "该手机号或邮箱已注册。" });
    return;
  }
  const user = await createUser({ name, phone, email, password, companyName });
  setSessionCookie(res, user);
  sendJson(res, 200, { ok: true, user: publicUser(user), profile: await getCustomerProfile(user.id) });
}

async function handleLogin(req, res) {
  const body = await readJsonBody(req);
  const login = String(body.login || "").trim();
  const password = String(body.password || "");
  const user = await findUserByLogin(login);
  if (!user || !verifyPassword(password, user.password_hash)) {
    sendJson(res, 401, { error: "账号或密码不正确。" });
    return;
  }
  if (user.status !== "active") {
    sendJson(res, 403, { error: "账号当前不可用，请联系管理员。" });
    return;
  }
  setSessionCookie(res, user);
  sendJson(res, 200, { ok: true, user: publicUser(user), profile: await getCustomerProfile(user.id) });
}

async function handleLogout(_req, res) {
  clearSessionCookie(res);
  sendJson(res, 200, { ok: true });
}

async function handleMe(req, res) {
  const user = await getCurrentUser(req);
  sendJson(res, 200, { user: publicUser(user), profile: user ? await getCustomerProfile(user.id) : null, database: (await isDbAvailable()) ? "connected" : "local-fallback" });
}

async function handleGetProfile(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  sendJson(res, 200, { profile: await getCustomerProfile(user.id) });
}

async function handleSaveProfile(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  const body = await readJsonBody(req);
  sendJson(res, 200, { ok: true, profile: await saveCustomerProfile(user.id, body) });
}

async function handleListReports(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  const reports = await listReviewReports(user);
  sendJson(res, 200, { reports });
}

async function handleGetReport(req, res, id) {
  const user = await requireUser(req, res);
  if (!user) return;
  const report = await getReviewReport(user, id);
  if (!report) {
    sendJson(res, 404, { error: "报告不存在或无权查看。" });
    return;
  }
  sendJson(res, 200, { report });
}

function serveStatic(req, res) {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname.startsWith("/reports/")) {
    const decodedReportPath = decodeURIComponent(url.pathname.replace(/^\/reports\/?/, ""));
    const safeReportPath = path.normalize(decodedReportPath).replace(/^([/\\])+/, "");
    let reportPath = path.resolve(reportsDir, safeReportPath);
    if (reportPath !== reportsDir && !reportPath.startsWith(reportsDir + path.sep)) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Forbidden");
      return;
    }
    if (fs.existsSync(reportPath) && fs.statSync(reportPath).isDirectory()) {
      reportPath = path.join(reportPath, "index.html");
    }
    fs.readFile(reportPath, (err, data) => {
      if (err) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Report not found");
        return;
      }
      res.writeHead(200, { "Content-Type": mime[path.extname(reportPath).toLowerCase()] || "application/octet-stream" });
      res.end(data);
    });
    return;
  }

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
}

function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === "/api/auth/register" && req.method === "POST") return await handleRegister(req, res);
      if (url.pathname === "/api/auth/login" && req.method === "POST") return await handleLogin(req, res);
      if (url.pathname === "/api/auth/logout" && req.method === "POST") return await handleLogout(req, res);
      if (url.pathname === "/api/auth/me" && req.method === "GET") return await handleMe(req, res);
      if (url.pathname === "/api/customer/profile" && req.method === "GET") return await handleGetProfile(req, res);
      if (url.pathname === "/api/customer/profile" && req.method === "POST") return await handleSaveProfile(req, res);
      if (url.pathname === "/api/ai-config/status" && req.method === "GET") return handleConfigStatus(req, res);
      if (url.pathname === "/api/ai-config" && req.method === "POST") return await handleSaveConfig(req, res);
      if (url.pathname === "/api/ai-config/test" && req.method === "POST") return await handleTestConfig(req, res);
      if (url.pathname === "/api/review-report" && req.method === "POST") return await handleReviewReport(req, res);
      if (url.pathname === "/api/sijichan-review-report" && req.method === "POST") return await handleSijichanReviewReport(req, res);
      if (url.pathname === "/api/review-reports" && req.method === "GET") return await handleListReports(req, res);
      const reportMatch = url.pathname.match(/^\/api\/review-reports\/([^/]+)$/);
      if (reportMatch && req.method === "GET") return await handleGetReport(req, res, decodeURIComponent(reportMatch[1]));
      return serveStatic(req, res);
    } catch (error) {
      const status = error.message && error.message.includes("超过10MB") ? 413 : 500;
      sendJson(res, status, { error: error.message || "服务器处理失败。" });
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
  server.listen(port, host, () => {
    fs.writeFileSync(path.join(root, ".preview-url"), `http://localhost:${port}/?v=preview-server\n`, "utf8");
    console.log(`Preview: http://localhost:${port}/?v=preview-server`);
  });
}

listenOn();
