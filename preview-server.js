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
const reportsDir = path.join(serverDir, "reports");
const publicReportBaseUrl = (process.env.PUBLIC_REPORT_BASE_URL || `http://localhost:${configuredPort}`).replace(/\/+$/, "");
const sijichanApiOrigin = "https://merchants.hydee.cn";
const sijichanManagerBase = `${sijichanApiOrigin}/businesses-gateway/mer-manager/1.0/`;
const sijichanMerchantBase = `${sijichanApiOrigin}/businesses-gateway/merchant/1.0/`;
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
    return { users: [], customerProfiles: [], aiConfigs: [], customerDatasets: [], reviewReports: [], capabilityTestSubmissions: [] };
  }
  try {
    const data = JSON.parse(fs.readFileSync(localDataPath, "utf8"));
    return {
      users: data.users || [],
      customerProfiles: data.customerProfiles || [],
      aiConfigs: data.aiConfigs || [],
      customerDatasets: data.customerDatasets || [],
      reviewReports: data.reviewReports || [],
      capabilityTestSubmissions: data.capabilityTestSubmissions || [],
    };
  } catch {
    return { users: [], customerProfiles: [], aiConfigs: [], customerDatasets: [], reviewReports: [], capabilityTestSubmissions: [] };
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
    const baseEnv = options.env || process.env;
    const nodeBinDir = path.dirname(process.execPath);
    const pathKey = Object.keys(baseEnv).find((key) => key.toLowerCase() === "path") || "PATH";
    const env = {
      ...baseEnv,
      [pathKey]: [nodeBinDir, baseEnv[pathKey] || ""].filter(Boolean).join(path.delimiter),
    };
    const child = spawn(command, args, {
      cwd: options.cwd || root,
      env,
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
    create table if not exists capability_test_submissions (
      id text primary key default gen_random_uuid()::text,
      name text not null,
      department text,
      test_date text,
      total_questions integer not null default 0,
      answered_questions integer not null default 0,
      completion_rate numeric(5,2) not null default 0,
      answers_json jsonb not null,
      user_agent text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create index if not exists idx_review_reports_user_created on review_reports(user_id, created_at desc);
    create index if not exists idx_customer_datasets_user_created on customer_datasets(user_id, created_at desc);
    create index if not exists idx_capability_test_submissions_created on capability_test_submissions(created_at desc);
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
    const result = await queryDb("select * from users where lower(coalesce(email,'')) = lower($1) or phone = $1 or lower(name) = lower($1) limit 1", [value]);
    return normalizeUserRow(result.rows[0]);
  }
  const data = readLocalData();
  return normalizeUserRow(
    data.users.find(
      (user) =>
        String(user.email || "").toLowerCase() === value.toLowerCase() ||
        user.phone === value ||
        String(user.name || "").toLowerCase() === value.toLowerCase(),
    ),
  );
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
    excelUrl: generated.excelUrl,
    normalizedDataUrl: generated.normalizedDataUrl,
    diagnosticsUrl: generated.diagnosticsUrl,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  data.reviewReports.push(record);
  writeLocalData(data);
  return record.id;
}

function normalizeCapabilityAnswer(item, index) {
  const question = String(item?.question || "").trim().slice(0, 500);
  const answer = String(item?.answer || "").trim().slice(0, 6000);
  const section = String(item?.section || "").trim().slice(0, 120);
  const score = String(item?.score || "").trim().slice(0, 40);
  return {
    index: Number(item?.index || index + 1),
    number: String(item?.number || `${index + 1}`).trim().slice(0, 20),
    section,
    question,
    score,
    answer,
    answered: Boolean(answer),
  };
}

function normalizeCapabilitySubmissionRow(row) {
  return {
    id: row.id,
    name: row.name,
    department: row.department || "",
    testDate: row.test_date || row.testDate || "",
    totalQuestions: Number(row.total_questions || row.totalQuestions || 0),
    answeredQuestions: Number(row.answered_questions || row.answeredQuestions || 0),
    completionRate: Number(row.completion_rate || row.completionRate || 0),
    answers: row.answers_json || row.answersJson || [],
    createdAt: row.created_at || row.createdAt,
  };
}

async function saveCapabilitySubmission(body, req) {
  const rawAnswers = Array.isArray(body.answers) ? body.answers : [];
  const answers = rawAnswers.map(normalizeCapabilityAnswer);
  const totalQuestions = answers.length;
  const answeredQuestions = answers.filter((item) => item.answered).length;
  const completionRate = totalQuestions ? Math.round((answeredQuestions / totalQuestions) * 10000) / 100 : 0;
  const submission = {
    name: String(body.name || "").trim().slice(0, 80),
    department: String(body.department || "").trim().slice(0, 120),
    testDate: String(body.testDate || "").trim().slice(0, 40),
    totalQuestions,
    answeredQuestions,
    completionRate,
    answers,
    userAgent: String(req.headers["user-agent"] || "").slice(0, 500),
  };
  if (!submission.name) {
    const error = new Error("请先填写姓名。");
    error.statusCode = 400;
    throw error;
  }
  if (!submission.totalQuestions) {
    const error = new Error("未找到可提交的测评题目。");
    error.statusCode = 400;
    throw error;
  }

  if (await isDbAvailable()) {
    const result = await queryDb(
      `insert into capability_test_submissions(name, department, test_date, total_questions, answered_questions, completion_rate, answers_json, user_agent)
       values($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
      [
        submission.name,
        submission.department,
        submission.testDate,
        submission.totalQuestions,
        submission.answeredQuestions,
        submission.completionRate,
        jsonClone(submission.answers),
        submission.userAgent,
      ],
    );
    return normalizeCapabilitySubmissionRow(result.rows[0]);
  }

  const data = readLocalData();
  const record = {
    id: createId("cap"),
    name: submission.name,
    department: submission.department,
    testDate: submission.testDate,
    totalQuestions: submission.totalQuestions,
    answeredQuestions: submission.answeredQuestions,
    completionRate: submission.completionRate,
    answersJson: submission.answers,
    userAgent: submission.userAgent,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  data.capabilityTestSubmissions.push(record);
  writeLocalData(data);
  return normalizeCapabilitySubmissionRow(record);
}

async function listCapabilitySubmissions() {
  if (await isDbAvailable()) {
    const result = await queryDb("select * from capability_test_submissions order by created_at desc limit 200");
    return result.rows.map(normalizeCapabilitySubmissionRow);
  }
  return readLocalData().capabilityTestSubmissions
    .slice()
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
    .slice(0, 200)
    .map(normalizeCapabilitySubmissionRow);
}

function normalizePublicArtifactUrl(value) {
  if (!value) return "";
  const text = String(value);
  try {
    const url = new URL(text, publicReportBaseUrl);
    if (!url.pathname.startsWith("/reports/")) return text;
    return `${publicReportBaseUrl}${url.pathname}${url.search}${url.hash}`;
  } catch {
    return text;
  }
}

function reportArtifactUrl(shareUrl, filename) {
  if (!shareUrl) return "";
  return `${shareUrl.replace(/\/?$/, "/")}${filename}`;
}

function normalizeReviewReportRow(row) {
  const shareUrl = normalizePublicArtifactUrl(row.share_url || row.shareUrl);
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
    shareUrl,
    svgUrl: normalizePublicArtifactUrl(row.svg_url || row.svgUrl || reportArtifactUrl(shareUrl, "report.svg")),
    qrSvgUrl: normalizePublicArtifactUrl(row.qr_svg_url || row.qrSvgUrl || reportArtifactUrl(shareUrl, "qr.svg")),
    excelUrl: normalizePublicArtifactUrl(row.excel_url || row.excelUrl || reportArtifactUrl(shareUrl, "review.xlsx")),
    normalizedDataUrl: normalizePublicArtifactUrl(row.normalized_data_url || row.normalizedDataUrl || reportArtifactUrl(shareUrl, encodeURIComponent("四季蝉登录获取标准化数据.json"))),
    diagnosticsUrl: normalizePublicArtifactUrl(row.diagnostics_url || row.diagnosticsUrl || reportArtifactUrl(shareUrl, encodeURIComponent("四季蝉接口诊断.json"))),
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

function ratioPercent(numerator, denominator) {
  const base = toNumber(denominator);
  if (!base) return 0;
  return Math.round((toNumber(numerator) / base) * 10000) / 100;
}

function sumCandidates(rows, candidates) {
  return (rows || []).reduce((sum, row) => {
    const key = candidates.find((candidate) => row && row[candidate] !== undefined && row[candidate] !== "");
    return sum + (key ? toNumber(row[key]) : 0);
  }, 0);
}

function sumAllCandidateFields(rows, candidates) {
  return (rows || []).reduce((sum, row) => {
    return sum + candidates.reduce((rowSum, candidate) => rowSum + toNumber(row?.[candidate]), 0);
  }, 0);
}

function uniqueCountCandidates(rows, candidates) {
  const values = new Set();
  for (const row of rows || []) {
    const value = pickField(row, candidates);
    if (hasValue(value)) values.add(String(value).trim());
  }
  return values.size;
}

function countRowsWithPositiveCandidate(rows, candidates) {
  return (rows || []).filter((row) => candidates.some((candidate) => toNumber(row?.[candidate]) > 0)).length;
}

function rateLevel(value, good, warning) {
  if (value >= good) return "healthy";
  if (value >= warning) return "watch";
  return "risk";
}

function money(value) {
  return Math.round(toNumber(value) * 100) / 100;
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
  summary.operationInsights = deriveOperationInsights({
    salesRows: [...comparison, ...trend],
    activityRows: activity,
    cashoutRows: cashout,
    incentiveRows: incentive,
    shareRewardRows: shareReward,
  });

  return summary;
}

function hasUsableDetail(summary) {
  return expectedSheets.some((name) => (summary.rowCounts[name] || 0) > 0);
}

function summaryForAi(summary) {
  if (!summary || typeof summary !== "object") return summary;
  const { rawData, ...rest } = summary;
  return rest;
}

function buildPrompt(summary) {
  return [
    "你是海典四季蝉重点品数字化动销平台的运营复盘顾问。",
    "请基于客户上传的Excel数据摘要，输出品种动销复盘报告。",
    "固定业务口径：AAA品种是销售额、毛利额、客流量都进入核心贡献区间的主力赚钱品种。",
    "四季蝉不是单纯红包工具，而是把厂家、连锁总部、门店店员、顾客连接起来，围绕重点品完成选品、培训、激励、销售、提现、统计、复盘的数字化运营平台。",
    "不要加入与客户数据无关的营销节点、季节场景或泛化品类建议。",
    "请关注：品种增长/下滑、活动商品销售与奖励闭环、激励方式使用/未使用价值、店员提现参与、厂家晒单打赏、下一步动作。",
    "新增复盘目标：通过数据证明四季蝉价值，引导客户持续使用，降低流失风险。必须使用 operationInsights 中的健康度、续用风险、价值证明点和建议动作。",
    "请明确输出：1）客户继续使用四季蝉的价值证据；2）可能导致客户流失的风险信号；3）下月应推动客户多用哪些模块或玩法；4）总部、门店、厂家三方各自的跟进动作。",
    "输出必须是JSON，不要输出Markdown代码块。",
    "数据摘要如下：",
    JSON.stringify(summaryForAi(summary)),
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, options, label, retries = 3) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      return await fetch(url, options);
    } catch (error) {
      lastError = error;
      if (attempt < retries) await sleep(1500 * attempt);
    }
  }
  throw new Error(`${label}请求失败（${url}）：${lastError?.message || "网络连接失败"}`);
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

  const response = await fetchWithRetry(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  }, "AI接口");

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
  const response = await fetchWithRetry(endpoint, {
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
  }, "AI接口");

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
  try {
    return JSON.parse(clean);
  } catch (error) {
    const start = clean.indexOf("{");
    const end = clean.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(clean.slice(start, end + 1));
    throw error;
  }
}

function arrayOfText(value) {
  if (Array.isArray(value)) {
    return value
      .flatMap((item) => arrayOfText(item))
      .map((item) => String(item || "").trim())
      .filter(Boolean);
  }
  if (value && typeof value === "object") {
    return Object.entries(value)
      .map(([key, item]) => `${key}：${typeof item === "object" ? JSON.stringify(item) : item}`)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  const text = String(value || "").trim();
  return text ? [text] : [];
}

function normalizeReport(report) {
  const safe = report && typeof report === "object" ? report : {};
  return {
    title: String(safe.title || "四季蝉AI复盘报告").trim(),
    executiveSummary: String(safe.executiveSummary || safe.summary || "").trim(),
    highlights: arrayOfText(safe.highlights),
    risks: arrayOfText(safe.risks),
    sections: Array.isArray(safe.sections)
      ? safe.sections.map((section, index) => ({
          heading: String(section?.heading || section?.title || `复盘模块${index + 1}`).trim(),
          bullets: arrayOfText(section?.bullets || section?.items || section?.content),
        }))
      : arrayOfText(safe.sections).map((item, index) => ({ heading: `复盘模块${index + 1}`, bullets: [item] })),
    nextActions: arrayOfText(safe.nextActions || safe.actions || safe.recommendations),
  };
}

function fallbackReportFromSummary(summary, reason = "") {
  const insights = summary?.operationInsights || {};
  const files = summary?.datasetFiles || [];
  const detailFiles = files.filter((file) => (file.rowCount || 0) > 0);
  const metricFiles = files.filter((file) => (file.metricCount || 0) > 0 && !(file.rowCount || 0));
  const metrics = insights.metrics || {};
  const health = insights.healthScore ?? "暂无";
  const risk = insights.retentionRisk || "待判断";
  return normalizeReport({
    title: "四季蝉客户数据复盘报告",
    executiveSummary: `本次复盘已完成数据读取和运营洞察计算。客户续用健康度为 ${health}，续用风险为 ${risk}。${reason ? "AI返回格式异常，系统已基于结构化数据生成兜底报告。" : ""}`,
    highlights: [
      ...((insights.valueProofPoints || []).length ? insights.valueProofPoints : ["已完成销售、活动、奖励、培训、厂家协同等数据源识别。"]),
      detailFiles.length ? `识别到 ${detailFiles.length} 个有明细的数据源：${detailFiles.map((file) => file.label || file.name).join("、")}。` : "",
      metricFiles.length ? `识别到 ${metricFiles.length} 个指标型数据源：${metricFiles.map((file) => file.label || file.name).join("、")}。` : "",
    ].filter(Boolean),
    risks: [
      ...((insights.riskItems || []).map((item) => item.explanation || item.label).filter(Boolean)),
      !(metrics.usedRewardPlayCount > 0) ? "当前激励玩法使用信号偏弱，需要避免客户只把四季蝉理解为单次活动工具。" : "",
      !(metrics.shareRecordCount > 0 || metrics.shareRewardAmount > 0) ? "厂家晒单/打赏信号不足，厂家资源协同价值还需要继续放大。" : "",
    ].filter(Boolean),
    sections: [
      {
        heading: "续用健康度",
        bullets: [
          `健康度评分：${health}`,
          `续用风险：${risk}`,
          `活动覆盖率：${metrics.activityCoverageRate ?? 0}%`,
          `已使用激励玩法数：${metrics.usedRewardPlayCount ?? 0}`,
        ],
      },
      {
        heading: "数据源状态",
        bullets: files.map((file) => `${file.label || file.name}：${file.statusText || file.status || ""}，明细 ${file.rowCount || 0} 行，指标 ${file.metricCount || 0} 项。`),
      },
      {
        heading: "运营提升方向",
        bullets: insights.recommendedActions || [],
      },
    ],
    nextActions: insights.recommendedActions || [
      "围绕AAA主力赚钱品扩大活动覆盖。",
      "把培训、考试、激励、销售和提现放到同一张复盘表中向客户展示闭环价值。",
      "推动厂家晒单打赏或活动费用支持，形成厂家复投证据。",
    ],
  });
}

function reportToMarkdown(report) {
  report = normalizeReport(report);
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
  items = arrayOfText(items);
  return items.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
}

function renderReportHtml({ report, markdown, summary, shareUrl, svgUrl, qrSvgUrl }) {
  report = normalizeReport(report);
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
  const excelUrl = `${shareUrl}review.xlsx`;
  const diagnosticsUrl = `${shareUrl}${encodeURIComponent("四季蝉接口诊断.json")}`;
  const normalizedDataUrl = `${shareUrl}${encodeURIComponent("四季蝉登录获取标准化数据.json")}`;

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
    .actions { display:grid; grid-template-columns:1fr 190px; gap:18px; align-items:center; margin-top:22px; padding:22px; border-radius:18px; border:1px solid var(--line); background:#fff; }
    .buttons { display:flex; flex-wrap:wrap; gap:10px; margin-top:14px; }
    a.button { display:inline-flex; align-items:center; justify-content:center; min-height:40px; padding:0 16px; border-radius:10px; text-decoration:none; color:#fff; background:var(--blue); font-weight:800; }
    a.button.secondary { color:var(--navy); background:#fff; border:1px solid var(--line); }
    .qr-button { width:170px; padding:10px; border:1px solid var(--line); border-radius:16px; background:#fff; justify-self:end; cursor:pointer; box-shadow:0 12px 28px rgba(24,52,126,.08); }
    .qr-button img { display:block; width:100%; height:auto; }
    .qr-button span { display:block; margin-top:8px; color:var(--muted); font-size:13px; text-align:center; }
    .qr-modal[hidden] { display:none; }
    .qr-modal { position:fixed; inset:0; z-index:30; display:grid; place-items:center; padding:20px; background:rgba(17,24,39,.45); backdrop-filter:blur(4px); }
    .qr-dialog { width:min(340px,100%); padding:20px; border-radius:18px; border:1px solid var(--line); background:#fff; box-shadow:0 24px 70px rgba(12,21,48,.24); text-align:center; }
    .qr-dialog img { width:240px; max-width:100%; height:auto; padding:10px; border:1px solid var(--line); border-radius:14px; }
    .qr-dialog h3 { margin:4px 0 12px; color:var(--navy); font-size:20px; }
    .qr-close { margin-top:14px; min-height:38px; padding:0 16px; border:0; border-radius:10px; color:#fff; background:var(--blue); font-weight:800; cursor:pointer; }
    .markdown { white-space:pre-wrap; display:none; }
    @media (max-width:760px){ h1{font-size:32px}.grid,.actions{grid-template-columns:1fr}.qr-button{justify-self:start;width:140px}.hero{padding:24px} }
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
          <a class="button secondary" href="${escapeHtml(excelUrl)}" download>下载Excel汇总</a>
          <a class="button secondary" href="${escapeHtml(diagnosticsUrl)}" download>接口诊断</a>
          <a class="button secondary" href="${escapeHtml(normalizedDataUrl)}" download>标准化数据</a>
          <a class="button secondary" href="${escapeHtml(shareUrl)}">刷新报告页</a>
        </div>
      </div>
      <button class="qr-button" id="openQr" type="button" aria-label="查看报告二维码">
        <img src="${escapeHtml(qrSvgUrl)}" alt="报告二维码" />
        <span>点击查看二维码</span>
      </button>
    </section>
    <div class="qr-modal" id="qrModal" hidden>
      <div class="qr-dialog" role="dialog" aria-modal="true" aria-labelledby="qrTitle">
        <h3 id="qrTitle">扫码查看报告</h3>
        <img src="${escapeHtml(qrSvgUrl)}" alt="报告二维码" />
        <button class="qr-close" id="closeQr" type="button">关闭</button>
      </div>
    </div>
    <pre class="markdown">${escapeHtml(markdown)}</pre>
  </main>
  <script>
    const openQr = document.getElementById("openQr");
    const closeQr = document.getElementById("closeQr");
    const qrModal = document.getElementById("qrModal");
    openQr?.addEventListener("click", () => { qrModal.hidden = false; });
    closeQr?.addEventListener("click", () => { qrModal.hidden = true; });
    qrModal?.addEventListener("click", (event) => {
      if (event.target === qrModal) qrModal.hidden = true;
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && qrModal) qrModal.hidden = true;
    });
  </script>
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

function renderReportSvg({ report, summary, shareUrl, qrSvg }) {
  report = normalizeReport(report);
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

  parts.push(`<rect x="60" y="${y - 30}" width="1080" height="210" rx="22" fill="#1f3f95"/>`);
  parts.push(svgText(["扫码查看完整网页报告", shareUrl], 88, y + 34, { size: 25, weight: 800, fill: "#ffffff", lineHeight: 38 }));
  parts.push(`<rect x="942" y="${y - 4}" width="142" height="142" rx="14" fill="#ffffff"/>`);
  parts.push(inlineQrSvg(qrSvg, 954, y + 8, 118));
  parts.push(`<text x="958" y="${y + 158}" font-size="18" font-weight="800" fill="#ffffff">扫码查看报告</text>`);
  y += 230;

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

function inlineQrSvg(qrSvg, x, y, size) {
  const viewBoxMatch = qrSvg.match(/viewBox="([^"]+)"/i);
  const bodyMatch = qrSvg.match(/<svg[^>]*>([\s\S]*?)<\/svg>/i);
  if (!viewBoxMatch || !bodyMatch) return "";
  const [, , width] = viewBoxMatch[1].split(/\s+/).map(Number);
  const scale = width ? size / width : 1;
  const body = bodyMatch[1].replace(/<\?xml[^>]*>/g, "").trim();
  return `<g transform="translate(${x} ${y}) scale(${scale})">${body}</g>`;
}

function excelColumnName(index) {
  let name = "";
  let n = index + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

function sanitizeSheetName(name, fallback) {
  return String(name || fallback).replace(/[\\/?*\[\]:]/g, "").slice(0, 31) || fallback;
}

function sheetRowsFromObjects(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const headers = [];
  const seen = new Set();
  for (const row of list) {
    for (const key of Object.keys(row || {})) {
      if (!seen.has(key)) {
        seen.add(key);
        headers.push(key);
      }
    }
  }
  if (!headers.length) return [["说明"], ["暂无数据"]];
  return [headers, ...list.map((row) => headers.map((header) => row?.[header] ?? ""))];
}

function worksheetXml(matrix) {
  const rows = matrix.map((row, rIndex) => {
    const cells = row.map((value, cIndex) => {
      const ref = `${excelColumnName(cIndex)}${rIndex + 1}`;
      const text = escapeXml(value === null || value === undefined ? "" : String(value));
      return `<c r="${ref}" t="inlineStr"><is><t>${text}</t></is></c>`;
    }).join("");
    return `<row r="${rIndex + 1}">${cells}</row>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheetData>${rows}</sheetData>
</worksheet>`;
}

function workbookSheets(summary, report) {
  report = normalizeReport(report);
  const raw = summary.rawData || {};
  const windows = summary.windows || {};
  const metrics = summary.metricRows || {};
  const insights = summary.operationInsights || {};
  const insightRows = [
    { 模块: "客户续用健康度", 指标: "健康度评分", 数值: insights.healthScore ?? "", 结论: insights.retentionRisk ? `续用风险：${insights.retentionRisk}` : "", 建议动作: "用于判断客户是否已经把四季蝉用成持续运营工具，而不是一次性红包活动。" },
    ...((insights.scoreItems || []).map((item) => ({
      模块: "健康度拆解",
      指标: item.label || item.key || "",
      数值: item.value ?? "",
      结论: item.level === "healthy" ? "表现较好" : item.level === "watch" ? "需要关注" : "流失风险",
      建议动作: item.explanation || "",
    }))),
    ...((insights.valueProofPoints || []).map((item) => ({ 模块: "价值证明点", 指标: "客户继续使用证据", 数值: "", 结论: item, 建议动作: "复盘会上优先展示，用数据证明四季蝉带来的动销、激励和协同价值。" }))),
    ...((insights.riskItems || []).map((item) => ({ 模块: "流失风险信号", 指标: item.label || "", 数值: item.value ?? "", 结论: item.explanation || "", 建议动作: "形成下月跟进清单，避免客户只看到成本，看不到持续运营收益。" }))),
    ...((insights.recommendedActions || []).map((item, index) => ({ 模块: "下月推动动作", 指标: `动作${index + 1}`, 数值: "", 结论: item, 建议动作: item }))),
    ...((insights.weakActivityItems || []).map((item) => ({ 模块: "弱活动品种", 指标: item.商品名称 || item.商品编码 || "", 数值: item.指标值 ?? "", 结论: item.数据路径 || "", 建议动作: "检查是否存在有奖励但无销售的品种，必要时调整选品、门店覆盖或店员培训。" }))),
  ].filter((row) => Object.values(row).some((value) => value !== "" && value !== undefined && value !== null));
  const statusRows = (summary.datasetFiles || []).map((file) => ({
    数据源: file.label || file.name,
    文件标识: file.name,
    状态: file.statusText || "",
    明细行数: file.rowCount || 0,
    指标数量: file.metricCount || 0,
    说明: file.note || "",
  }));
  const overviewRows = [
    { 指标: "销售明细行数", 明细值: summary.rowCounts?.["sales.json"] || 0, 校验结果: (summary.rowCounts?.["sales.json"] || 0) > 0 ? "有明细" : "无明细", 说明: "来自销售汇总接口" },
    { 指标: "我的活动列表行数", 明细值: summary.rowCounts?.["activity_catalog.json"] || 0, 校验结果: (summary.rowCounts?.["activity_catalog.json"] || 0) > 0 ? "有明细" : "无明细", 说明: "来自我的活动列表接口" },
    { 指标: "活动汇总行数", 明细值: summary.rowCounts?.["activity_summary.json"] || 0, 校验结果: (summary.rowCounts?.["activity_summary.json"] || 0) > 0 ? "有明细" : "无明细", 说明: "来自活动汇总接口" },
    { 指标: "奖励统计行数", 明细值: summary.rowCounts?.["reward_statistics.json"] || 0, 校验结果: (summary.rowCounts?.["reward_statistics.json"] || 0) > 0 ? "有明细" : "无明细", 说明: "来自奖励统计接口" },
    { 指标: "奖励发放明细行数", 明细值: summary.rowCounts?.["reward_distribution.json"] || 0, 校验结果: (summary.rowCounts?.["reward_distribution.json"] || 0) > 0 ? "有明细" : "看指标/诊断", 说明: "来自奖励发放明细页接口" },
    { 指标: "员工豆豆账户/提现行数", 明细值: summary.rowCounts?.["employee_account.json"] || 0, 校验结果: (summary.rowCounts?.["employee_account.json"] || 0) > 0 ? "有明细" : "看指标/诊断", 说明: "来自员工账户、提现、核销与结算接口" },
    { 指标: "培训明细行数", 明细值: summary.rowCounts?.["training.json"] || 0, 校验结果: (summary.rowCounts?.["training.json"] || 0) > 0 ? "有明细" : "接口成功，业务值为0", 说明: "培训概览指标见“培训情况”页" },
    { 指标: "厂家打赏行数", 明细值: summary.rowCounts?.["manufacturer_tips.json"] || 0, 校验结果: (summary.rowCounts?.["manufacturer_tips.json"] || 0) > 0 ? "有明细" : "接口成功，业务值为0", 说明: "厂家打赏汇总见“厂家打赏”页" },
    ...((metrics.overview || []).map((row) => ({ 指标: row.数据路径, 明细值: row.指标值, 校验结果: "有指标", 说明: "来自四季蝉概览页指标接口" }))),
  ];
  const trainingRows = [
    ...((metrics.training || []).map((row) => ({ 类型: "培训概览指标", 指标路径: row.数据路径, 指标: row.指标, 指标值: row.指标值 }))),
    ...((raw.training?.roleLearning || []).map((row) => ({ 类型: "角色学习明细", ...row }))),
    ...((raw.training?.storeLearning || []).map((row) => ({ 类型: "门店学习明细", ...row }))),
    ...((raw.training?.employeeLearning || []).map((row) => ({ 类型: "员工学习明细", ...row }))),
    ...((raw.training?.courseLearning || []).map((row) => ({ 类型: "课程学习明细", ...row }))),
  ];
  const manufacturerTipRows = [
    ...((metrics.manufacturerTips || []).map((row) => ({ 类型: "厂家打赏汇总", 指标路径: row.数据路径, 指标: row.指标, 指标值: row.指标值 }))),
    ...((raw.manufacturerTips?.rows || []).map((row) => ({ 类型: "厂家打赏明细", ...row }))),
  ];
  const rewardDistributionRows = [
    ...((metrics.rewardDistribution || []).map((row) => ({ 类型: "奖励发放统计", 指标路径: row.数据路径, 指标: row.指标, 指标值: row.指标值 }))),
    ...((raw.rewardDistribution?.nearHalf?.rows || []).map((row) => ({ 类型: "奖励发放明细", ...row }))),
  ];
  const employeeAccountRows = [
    ...((metrics.employeeAccount || []).map((row) => ({ 类型: "员工账户指标", 指标路径: row.数据路径, 指标: row.指标, 指标值: row.指标值 }))),
    ...((raw.employeeAccount?.withdrawRows || []).map((row) => ({ 类型: "提现明细", ...row }))),
    ...((raw.employeeAccount?.writeOffRows || []).map((row) => ({ 类型: "延时豆核销明细", ...row }))),
    ...((raw.employeeAccount?.settleRows || []).map((row) => ({ 类型: "结算明细", ...row }))),
  ];
  return [
    { name: "数据口径说明", rows: [
      { 项目: "数据来源", 内容: summary.source || "登录获取" },
      { 项目: "客户名称", 内容: summary.requestInfo?.merName || raw.meta?.merName || "" },
      { 项目: "客户编码", 内容: summary.requestInfo?.merCode || raw.meta?.merCode || "" },
      { 项目: "上月", 内容: `${windows.lastMonth?.start || ""} 至 ${windows.lastMonth?.end || ""}` },
      { 项目: "上上月", 内容: `${windows.previousMonth?.start || ""} 至 ${windows.previousMonth?.end || ""}` },
      { 项目: "前两月对比期", 内容: `${windows.priorTwoMonths?.start || ""} 至 ${windows.priorTwoMonths?.end || ""}` },
      { 项目: "近半年", 内容: `${windows.nearHalf?.start || ""} 至 ${windows.nearHalf?.end || ""}` },
      { 项目: "上期半年", 内容: `${windows.previousHalf?.start || ""} 至 ${windows.previousHalf?.end || ""}` },
    ] },
    { name: "接口诊断", rows: (summary.interfaceDiagnostics || []).map((item) => ({
      模块: item.模块 || "",
      接口: item.接口 || "",
      类型: item.类型 || "",
      状态: item.状态 || "",
      状态说明: item.状态说明 || "",
      HTTP状态: item.HTTP状态 || "",
      业务码: item.业务码 || "",
      业务消息: item.业务消息 || "",
      明细行数: item.明细行数 || 0,
      指标数量: item.指标数量 || 0,
      请求参数: item.请求参数 || "",
      取数时间: item.取数时间 || "",
    })) },
    { name: "数据源状态", rows: statusRows },
    { name: "概览校验", rows: overviewRows },
    { name: "我的活动列表", rows: raw.activityCatalog?.joined || [] },
    { name: "奖励统计-半年", rows: raw.rewardStatistics?.nearHalf?.rows || [] },
    { name: "奖励发放明细", rows: rewardDistributionRows.length ? rewardDistributionRows : [{ 类型: "奖励发放", 说明: "当前口径未识别到奖励发放明细或指标，请查看接口诊断。" }] },
    { name: "员工豆豆账户与提现", rows: employeeAccountRows.length ? employeeAccountRows : [{ 类型: "员工收益闭环", 说明: "当前口径未识别到员工账户、提现、核销或结算数据，请查看接口诊断。" }] },
    { name: "销售汇总-上月_vs_前两月", rows: raw.sales?.lastMonth_vs_priorTwoMonths?.rows || [] },
    { name: "销售汇总-近半年_vs_上期", rows: raw.sales?.nearHalf_vs_previousHalf?.rows || [] },
    { name: "活动汇总-5月_vs_4月", rows: [...(raw.activitySummary?.lastMonth?.rows || []), ...(raw.activitySummary?.previousMonth?.rows || [])] },
    { name: "培训情况", rows: trainingRows },
    { name: "厂家打赏", rows: manufacturerTipRows.length ? manufacturerTipRows : [{ 类型: "厂家打赏汇总", 指标: "当前口径厂家打赏", 指标值: 0, 说明: "接口成功返回，但无打赏金额和明细记录" }] },
    { name: "续用风险与运营提升", rows: insightRows.length ? insightRows : [{ 模块: "运营洞察", 指标: "暂无可计算洞察", 数值: "", 结论: "当前数据不足", 建议动作: "补齐销售、活动、奖励、培训、提现或厂家协同数据后再复盘。" }] },
    { name: "经营复盘结论", rows: [
      { 类型: "Executive Summary", 内容: report?.executiveSummary || "" },
      ...((report?.highlights || []).map((item) => ({ 类型: "关键发现", 内容: item }))),
      ...((report?.risks || []).map((item) => ({ 类型: "风险问题", 内容: item }))),
      ...((report?.nextActions || []).map((item) => ({ 类型: "下一步动作", 内容: item }))),
    ] },
  ];
}

async function writeReviewWorkbook(filePath, summary, report) {
  const zip = new JSZip();
  const sheets = workbookSheets(summary, report).map((sheet, index) => ({
    id: index + 1,
    name: sanitizeSheetName(sheet.name, `Sheet${index + 1}`),
    matrix: sheetRowsFromObjects(sheet.rows),
  }));
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  ${sheets.map((sheet) => `<Override PartName="/xl/worksheets/sheet${sheet.id}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("\n  ")}
</Types>`);
  zip.folder("_rels").file(".rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`);
  zip.folder("xl").file("workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    ${sheets.map((sheet) => `<sheet name="${escapeXml(sheet.name)}" sheetId="${sheet.id}" r:id="rId${sheet.id}"/>`).join("\n    ")}
  </sheets>
</workbook>`);
  zip.folder("xl").folder("_rels").file("workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${sheets.map((sheet) => `<Relationship Id="rId${sheet.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${sheet.id}.xml"/>`).join("\n  ")}
</Relationships>`);
  const worksheets = zip.folder("xl").folder("worksheets");
  for (const sheet of sheets) {
    worksheets.file(`sheet${sheet.id}.xml`, worksheetXml(sheet.matrix));
  }
  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  fs.writeFileSync(filePath, buffer);
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
  const excelUrl = `${shareUrl}review.xlsx`;
  const normalizedDataUrl = `${shareUrl}${encodeURIComponent("四季蝉登录获取标准化数据.json")}`;
  const diagnosticsUrl = `${shareUrl}${encodeURIComponent("四季蝉接口诊断.json")}`;
  const qrSvg = await QRCode.toString(shareUrl, {
    type: "svg",
    errorCorrectionLevel: "M",
    margin: 1,
    color: { dark: "#1f3f95", light: "#ffffff" },
  });
  const reportSvg = renderReportSvg({ report, summary, shareUrl, qrSvg });
  const html = renderReportHtml({ report, markdown, summary, shareUrl, svgUrl, qrSvgUrl });

  fs.writeFileSync(path.join(reportDir, "report.json"), JSON.stringify({ report, markdown, summary, shareUrl, svgUrl, qrSvgUrl, excelUrl, normalizedDataUrl, diagnosticsUrl }, null, 2), "utf8");
  fs.writeFileSync(path.join(reportDir, "四季蝉登录获取标准化数据.json"), JSON.stringify(summary.rawData || {}, null, 2), "utf8");
  fs.writeFileSync(path.join(reportDir, "四季蝉接口诊断.json"), JSON.stringify(summary.interfaceDiagnostics || [], null, 2), "utf8");
  fs.writeFileSync(path.join(reportDir, "index.html"), html, "utf8");
  fs.writeFileSync(path.join(reportDir, "report.svg"), reportSvg, "utf8");
  fs.writeFileSync(path.join(reportDir, "qr.svg"), qrSvg, "utf8");
  await writeReviewWorkbook(path.join(reportDir, "review.xlsx"), summary, report);

  return { reportId, shareUrl, svgUrl, qrSvgUrl, excelUrl, normalizedDataUrl, diagnosticsUrl };
}

async function refreshExistingReportArtifacts() {
  if (!fs.existsSync(reportsDir)) return;
  const entries = fs.readdirSync(reportsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  for (const entry of entries) {
    const reportDir = path.join(reportsDir, entry.name);
    const jsonPath = path.join(reportDir, "report.json");
    if (!fs.existsSync(jsonPath)) continue;
    try {
      const saved = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
      if (!saved.report || !saved.shareUrl) continue;
      const qrSvg = await QRCode.toString(saved.shareUrl, {
        type: "svg",
        errorCorrectionLevel: "M",
        margin: 1,
        color: { dark: "#1f3f95", light: "#ffffff" },
      });
      const svgUrl = saved.svgUrl || `${saved.shareUrl.replace(/\/+$/, "")}/report.svg`;
      const qrSvgUrl = saved.qrSvgUrl || `${saved.shareUrl.replace(/\/+$/, "")}/qr.svg`;
      const reportSvg = renderReportSvg({ report: saved.report, summary: saved.summary, shareUrl: saved.shareUrl, qrSvg });
      const html = renderReportHtml({
        report: saved.report,
        markdown: saved.markdown || "",
        summary: saved.summary,
        shareUrl: saved.shareUrl,
        svgUrl,
        qrSvgUrl,
      });
      fs.writeFileSync(path.join(reportDir, "index.html"), html, "utf8");
      fs.writeFileSync(path.join(reportDir, "report.svg"), reportSvg, "utf8");
      fs.writeFileSync(path.join(reportDir, "qr.svg"), qrSvg, "utf8");
      fs.writeFileSync(path.join(reportDir, "四季蝉登录获取标准化数据.json"), JSON.stringify(saved.summary?.rawData || {}, null, 2), "utf8");
      fs.writeFileSync(path.join(reportDir, "四季蝉接口诊断.json"), JSON.stringify(saved.summary?.interfaceDiagnostics || [], null, 2), "utf8");
      await writeReviewWorkbook(path.join(reportDir, "review.xlsx"), saved.summary || {}, saved.report);
    } catch (error) {
      console.warn(`Refresh report artifact failed for ${entry.name}: ${error.message}`);
    }
  }
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
  let report;
  try {
    report = normalizeReport(parseReportJson(reportText));
  } catch (error) {
    report = fallbackReportFromSummary(summary, error.message);
  }
  const markdown = reportToMarkdown(report);
  const artifact = await persistReportArtifact({ report, markdown, summary });
  return { report, markdown, ...artifact };
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function dateOnly(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function atStart(date) {
  return `${date} 00:00:00`;
}

function atEnd(date) {
  return `${date} 23:59:59`;
}

function addMonths(date, delta) {
  return new Date(date.getFullYear(), date.getMonth() + delta, 1);
}

function monthStart(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function monthEnd(date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0);
}

function monthWindow(date) {
  return {
    start: atStart(dateOnly(monthStart(date))),
    end: atEnd(dateOnly(monthEnd(date))),
  };
}

function buildSijichanWindows(asOfText = "2026-06-06") {
  const asOf = new Date(`${asOfText || "2026-06-06"}T12:00:00`);
  const last = addMonths(asOf, -1);
  const prev = addMonths(asOf, -2);
  const priorTwoStart = addMonths(asOf, -3);
  const nearStart = addMonths(asOf, -6);
  const prevHalfStart = addMonths(asOf, -12);
  const prevHalfEnd = addMonths(asOf, -7);
  return {
    lastMonth: { label: "上月", ...monthWindow(last) },
    previousMonth: { label: "上上月", ...monthWindow(prev) },
    priorTwoMonths: {
      label: "前两月对比期",
      start: atStart(dateOnly(monthStart(priorTwoStart))),
      end: atEnd(dateOnly(monthEnd(prev))),
    },
    nearHalf: {
      label: "近半年",
      start: atStart(dateOnly(monthStart(nearStart))),
      end: atEnd(dateOnly(monthEnd(last))),
    },
    previousHalf: {
      label: "上期半年",
      start: atStart(dateOnly(monthStart(prevHalfStart))),
      end: atEnd(dateOnly(monthEnd(prevHalfEnd))),
    },
  };
}

function md5Upper(value) {
  return crypto.createHash("md5").update(value, "utf8").digest("hex").toUpperCase();
}

function randomClientId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function networkErrorMessage(error) {
  const parts = [error?.message].filter(Boolean);
  const cause = error?.cause;
  if (cause?.code) parts.push(cause.code);
  if (cause?.message && cause.message !== error?.message) parts.push(cause.message);
  if (cause?.errno && !parts.includes(String(cause.errno))) parts.push(String(cause.errno));
  return parts.join(" / ") || "未知网络错误";
}

async function sijichanLogin({ username, password }) {
  const account = String(username || "").trim();
  const pwd = String(password || "");
  if (!account || !pwd) throw new Error("请填写四季蝉账号和密码。");
  let response;
  try {
    response = await fetch(`${sijichanMerchantBase}acc/_login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        account,
        pwd: md5Upper(pwd),
        verificationCode: "",
        clientId: randomClientId(),
        imgVerificationCode: "",
        loginSourceType: 1,
      }),
    });
  } catch (error) {
    throw new Error(`四季蝉登录接口请求失败：${networkErrorMessage(error)}`);
  }
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!response.ok || json.code !== "10000" || !json.data?.token) {
    throw new Error(`四季蝉登录失败：${json.msg || json.raw || `HTTP ${response.status}`}。如后台要求验证码，请先在浏览器完成验证后再试。`);
  }
  return {
    token: json.data.token,
    userName: json.data.userName || account,
    merName: json.data.merName || "",
    loginSystem: json.data.system?.reEngSystem || json.data.system?.reSystem || "",
  };
}

function sijichanHeaders(token, merCode) {
  const headers = {
    "content-type": "application/json",
    Authorization: token,
  };
  if (merCode) {
    headers.merCode = merCode;
    headers.isSuper = "1";
  }
  return headers;
}

async function sijichanPost(endpoint, body, token, merCode) {
  let response;
  try {
    response = await fetch(`${sijichanManagerBase}${endpoint}`, {
      method: "POST",
      headers: sijichanHeaders(token, merCode),
      body: JSON.stringify(body || {}),
    });
  } catch (error) {
    throw new Error(`${endpoint} 接口请求失败：${networkErrorMessage(error)}`);
  }
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (json.code && String(json.code) !== "10000") {
    if (String(json.code) === "40301") {
      throw new Error(`${endpoint} 接口返回 40301：登录成功但业务接口无权限，或 token 不被该接口接受。`);
    }
    throw new Error(`${endpoint} 接口返回失败：${json.msg || json.code}`);
  }
  return {
    endpoint,
    status: response.status,
    request: body || {},
    response: json,
    fetchedAt: new Date().toISOString(),
  };
}

async function sijichanPagedPost(endpoint, baseBody, token, merCode, pageSize = 1000, options = {}) {
  const pages = [];
  const rows = [];
  const maxPages = Number(options.maxPages || 0);
  let totalCount = 0;
  let totalPages = 1;
  for (let currentPage = 1; currentPage <= totalPages; currentPage += 1) {
    const result = await sijichanPost(endpoint, { ...baseBody, currentPage, pageSize }, token, merCode);
    pages.push(result);
    const data = result.response?.data;
    if (currentPage === 1) {
      totalCount = Number(data?.totalCount || data?.total || data?.count || 0);
      const explicitPages = Number(data?.totalPages || data?.totalPage || data?.pages || 0);
      totalPages = explicitPages || Math.max(1, Math.ceil(totalCount / pageSize));
    }
    rows.push(...rowsFromPaged(data));
    if (maxPages > 0 && currentPage >= maxPages && currentPage < totalPages) break;
  }
  return {
    endpoint,
    baseRequest: baseBody,
    pageSize,
    totalCount,
    totalPages,
    fetchedPages: pages.length,
    truncated: totalPages > pages.length,
    rows,
    pages,
    fetchedAt: new Date().toISOString(),
  };
}

function sanitizeSijichanRequest(value) {
  if (!value || typeof value !== "object") return value || {};
  const blocked = new Set(["password", "pwd", "token", "authorization"]);
  const walk = (node) => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object") return node;
    return Object.fromEntries(
      Object.entries(node).map(([key, child]) => [
        key,
        blocked.has(key.toLowerCase()) ? "***" : walk(child),
      ]),
    );
  };
  return walk(value);
}

function emptySijichanPostResult(endpoint, body, error) {
  return {
    endpoint,
    status: 0,
    request: body || {},
    response: { code: "ERROR", msg: error.message || "接口请求失败", data: null },
    error: error.message || String(error),
    fetchedAt: new Date().toISOString(),
  };
}

function emptySijichanPagedResult(endpoint, body, error, pageSize = 1000) {
  return {
    endpoint,
    baseRequest: body || {},
    pageSize,
    totalCount: 0,
    totalPages: 0,
    fetchedPages: 0,
    truncated: false,
    rows: [],
    pages: [],
    error: error.message || String(error),
    fetchedAt: new Date().toISOString(),
  };
}

function diagnosticStatusText(item) {
  if (item.status === "failed") return `失败：${item.message || "未知错误"}`;
  if (item.rowCount > 0) return `成功，有明细 ${item.rowCount}行`;
  if (item.metricCount > 0 && item.hasNonZeroMetric) return `成功，有指标 ${item.metricCount}项`;
  if (item.metricCount > 0) return "成功，业务值为0";
  return "成功，无明细";
}

function buildSijichanDiagnostic({ label, endpoint, kind, request, result, rows = [], metricRows = [], error }) {
  const failed = Boolean(error || result?.error);
  const item = {
    模块: label,
    接口: endpoint,
    类型: kind,
    状态: failed ? "failed" : "success",
    状态说明: "",
    HTTP状态: result?.status || "",
    业务码: result?.response?.code || "",
    业务消息: result?.response?.msg || "",
    明细行数: rows.length,
    指标数量: metricRows.length,
    总明细数: result?.totalCount ?? "",
    总页数: result?.totalPages ?? "",
    已取页数: result?.fetchedPages ?? "",
    是否截断: result?.truncated ? "是" : "",
    请求参数: JSON.stringify(sanitizeSijichanRequest(request || result?.request || result?.baseRequest || {})),
    取数时间: result?.fetchedAt || new Date().toISOString(),
    message: error?.message || result?.error || "",
    rowCount: rows.length,
    metricCount: metricRows.length,
    totalCount: result?.totalCount ?? null,
    totalPages: result?.totalPages ?? null,
    fetchedPages: result?.fetchedPages ?? null,
    truncated: Boolean(result?.truncated),
    hasNonZeroMetric: hasNonZeroMetric(metricRows),
    status: failed ? "failed" : "success",
  };
  item.状态说明 = diagnosticStatusText(item);
  return item;
}

function createSijichanClient(token, merCode, diagnostics) {
  return {
    async post(label, endpoint, body) {
      try {
        const result = await sijichanPost(endpoint, body, token, merCode);
        const metricRows = metricRowsFromObject(responseData(result), `${endpoint}.json`, "data");
        diagnostics.push(buildSijichanDiagnostic({ label, endpoint, kind: "post", request: body, result, metricRows }));
        return result;
      } catch (error) {
        const result = emptySijichanPostResult(endpoint, body, error);
        diagnostics.push(buildSijichanDiagnostic({ label, endpoint, kind: "post", request: body, result, error }));
        return result;
      }
    },
    async paged(label, endpoint, body, pageSize = 1000, options = {}) {
      try {
        const result = await sijichanPagedPost(endpoint, body, token, merCode, pageSize, options);
        diagnostics.push(buildSijichanDiagnostic({ label, endpoint, kind: "paged", request: body, result, rows: result.rows || [] }));
        return result;
      } catch (error) {
        const result = emptySijichanPagedResult(endpoint, body, error, pageSize);
        diagnostics.push(buildSijichanDiagnostic({ label, endpoint, kind: "paged", request: body, result, error }));
        return result;
      }
    },
  };
}

function saleBody(window, comparison) {
  return {
    beginTime: window.start,
    endTime: window.end,
    comparisonBeginTime: comparison ? comparison.start : undefined,
    comparisonEndTime: comparison ? comparison.end : undefined,
    authorizeBusinessCode: "",
    commodityCodeList: [],
    saleChannel: "",
    orgClassList: [],
    areaIds: [],
    regionCodes: null,
    subOrgCodes: [],
    goodString: "",
  };
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
  const groups = [];
  const ROW_CONTAINER_KEYS = new Set(["rows", "data", "records", "items", "list", "products", "details", "summary"]);
  const META_KEYS = new Set(["name", "path", "description", "title", "module", "file", "generatedAt", "source"]);
  const isMetadataPath = (pathParts) => {
    const last = pathParts[pathParts.length - 1];
    return ["modules", "headers", "columns", "fields"].includes(last);
  };
  const isMetadataRows = (rows) => {
    if (!rows.length) return true;
    return rows.every((row) => {
      const keys = Object.keys(row || {});
      return keys.length > 0 && keys.every((key) => META_KEYS.has(key));
    });
  };
  const scalarFieldCount = (row) =>
    Object.values(row || {}).filter((val) => val === null || ["string", "number", "boolean"].includes(typeof val)).length;
  const looksLikeBusinessRow = (row) => {
    const keys = Object.keys(row || {});
    if (!keys.length) return false;
    if (keys.every((key) => META_KEYS.has(key))) return false;
    return scalarFieldCount(row) >= 2 || keys.some((key) => /金额|数量|销售|毛利|奖励|提现|客流|商品|品种|门店|员工|amount|count|qty|sales|profit|reward|cash|sku|goods|product|store|clerk/i.test(key));
  };
  const objectMapRows = (node) => {
    const entries = Object.entries(node || {});
    if (entries.length < 2) return [];
    const objectEntries = entries.filter(([, child]) => child && typeof child === "object" && !Array.isArray(child));
    if (objectEntries.length !== entries.length) return [];
    const rows = objectEntries
      .filter(([, child]) => looksLikeBusinessRow(child))
      .map(([key, child]) => ({ 数据键: key, ...child }));
    return rows.length === entries.length ? rows : [];
  };
  const pushGroup = (pathParts, rows) => {
    if (!rows.length || isMetadataPath(pathParts) || isMetadataRows(rows)) return;
    groups.push({
      path: pathParts.join(".") || "root",
      rows,
    });
  };
  const visit = (node, pathParts = []) => {
    if (!node) return;
    if (Array.isArray(node)) {
      const objectRows = node.filter((item) => item && typeof item === "object" && !Array.isArray(item) && looksLikeBusinessRow(item));
      pushGroup(pathParts, objectRows);
      node.forEach((item, index) => {
        if (item && typeof item === "object" && !Array.isArray(item)) visit(item, [...pathParts, String(index)]);
      });
      return;
    }
    if (typeof node !== "object") return;
    const lastPath = pathParts[pathParts.length - 1];
    const mapRows = objectMapRows(node);
    if (mapRows.length && ROW_CONTAINER_KEYS.has(lastPath)) pushGroup(pathParts, mapRows);
    for (const [key, child] of Object.entries(node)) {
      visit(child, [...pathParts, key]);
    }
  };
  visit(value);
  return groups;
}

function headersFromRows(rows) {
  const headers = [];
  const seen = new Set();
  for (const row of rows) {
    for (const key of Object.keys(row || {})) {
      if (seen.has(key)) continue;
      seen.add(key);
      headers.push(key);
      if (headers.length >= 40) return headers;
    }
  }
  return headers;
}

function metricRowsFromObject(value, fileName, basePath = "") {
  const rows = [];
  const visit = (node, pathParts = []) => {
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) return;
    if (typeof node !== "object") {
      rows.push({
        数据文件: fileName,
        数据路径: [basePath, ...pathParts].filter(Boolean).join("."),
        指标: pathParts[pathParts.length - 1] || basePath || "value",
        指标值: node,
      });
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      visit(child, [...pathParts, key]);
    }
  };
  visit(value);
  return rows.filter((row) => hasValue(row.指标值));
}

function hasNonZeroMetric(rows) {
  return rows.some((row) => {
    const value = row.指标值;
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    const text = String(value ?? "").trim();
    if (!text) return false;
    if (/^(true|yes|是|有)$/i.test(text)) return true;
    return toNumber(text) !== 0;
  });
}

function datasetStatus({ name, rows = [], metricRows = [], label = name, note = "" }) {
  const rowCount = rows.length;
  const metricCount = metricRows.length;
  let status = "empty";
  let statusText = "业务为0";
  if (rowCount > 0) {
    status = "detail";
    statusText = `有明细 ${rowCount}行`;
  } else if (metricCount > 0 && hasNonZeroMetric(metricRows)) {
    status = "metrics";
    statusText = "有指标无明细";
  } else if (metricCount > 0) {
    status = "empty";
    statusText = "接口成功，业务值为0";
  } else if (rowCount === 0 && name === "manufacturer_tips.json") {
    status = "empty";
    statusText = "接口成功，业务值为0";
  }
  return {
    name,
    label,
    status,
    statusText,
    rowCount,
    metricCount,
    headers: headersFromRows(rows),
    note,
  };
}

function pickField(row, candidates) {
  for (const key of candidates) {
    if (row && hasValue(row[key])) return row[key];
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

function deriveOperationInsights({
  salesRows = [],
  activityRows = [],
  rewardRows = [],
  trainingRows = [],
  tipsRows = [],
  cashoutRows = [],
  incentiveRows = [],
  shareRewardRows = [],
  activityCatalogRows = [],
  employeeAccountRows = [],
  rewardDistributionRows = [],
  metricRows = {},
} = {}) {
  const productCodeCandidates = ["commodityCode", "wareIspCode", "erpCode", "productCode", "goodsCode", "skuCode", "商品编码"];
  const productNameCandidates = ["commodityName", "productName", "goodsName", "skuName", "商品名称"];
  const salesAmountCandidates = ["saleCommodityAmount", "rewardCommodityAmount", "saleAmount", "salesAmount", "销售金额", "激励商品销售金额"];
  const rewardAmountCandidates = ["rewardSaleAmount", "rewardMoney", "rewardBookingMoney", "rewardAmount", "singleRewardMoney", "multiRewardMoney", "combineRewardMoney", "commodityTargetRewardMoney", "serialTargetRewardMoney", "combinationTargetRewardMoney", "dayRankRewardMoney", "rankingRewardMoney", "amount", "奖励金额", "激励总金额"];
  const storeCandidates = ["saleStoreNum", "storeNum", "storeCode", "merCode", "门店编码", "动销门店数"];
  const employeeCandidates = ["employeeCode", "empCode", "empId", "employeeName", "empName", "clerkName", "员工编码", "员工姓名"];
  const employeeCountCandidates = ["saleEmpNum", "rewardEmpNum", "empNum", "employeeNum", "参与员工数", "奖励员工数"];
  const activityBudgetCandidates = ["totalSubsidy", "activityMoney", "activityBudget", "budgetAmount", "活动预算"];
  const activityUsedBudgetCandidates = ["alreadySubsidy", "gotSubsidyAmount", "usedSubsidy", "usedAmount", "已发放金额"];
  const activityRemainBudgetCandidates = ["surplusSubsidy", "remainSubsidy", "balanceAmount", "剩余金额"];
  const rewardPlayFields = [
    ["单品销售奖励", "singleRewardMoney", "单品奖励金额"],
    ["疗程销售奖励", "multiRewardMoney", "疗程奖励金额"],
    ["关联销售奖励", "combineRewardMoney", "关联奖励金额"],
    ["单品目标奖励", "commodityTargetRewardMoney", "单品目标奖励金额"],
    ["系列目标奖励", "serialTargetRewardMoney", "系列目标奖励金额"],
    ["组合目标奖励", "combinationTargetRewardMoney", "组合目标奖励金额"],
    ["早鸟奖励", "dayRankRewardMoney", "早鸟奖励金额"],
    ["排名奖励", "rankingRewardMoney", "排名奖励金额"],
  ];

  const salesSkuCount = uniqueCountCandidates(salesRows, productCodeCandidates);
  const activeSkuCount = uniqueCountCandidates(activityRows, productCodeCandidates);
  const rewardSkuCount = uniqueCountCandidates(rewardRows, productCodeCandidates);
  const joinedActivityCount = activityCatalogRows.length;
  const onlineActivityCount = (activityCatalogRows || []).filter((row) => [1, 3, 62, "1", "3", "62"].includes(row.status)).length;
  const endedActivityCount = (activityCatalogRows || []).filter((row) => [5, 6, "5", "6"].includes(row.status)).length;
  const activityCatalogSalesAmount = money(sumCandidates(activityCatalogRows, ["activitySaleAmount", "saleAmount", "salesAmount"]));
  const activityCatalogRelationSaleAmount = money(sumCandidates(activityCatalogRows, ["relationSaleAmount", "relatedSaleAmount"]));
  const activityBudgetAmount = money(sumCandidates(activityCatalogRows, activityBudgetCandidates));
  const activityUsedBudgetAmount = money(sumCandidates(activityCatalogRows, activityUsedBudgetCandidates));
  const activityRemainBudgetAmount = money(sumCandidates(activityCatalogRows, activityRemainBudgetCandidates));
  const totalSalesAmount = money(sumCandidates(salesRows, salesAmountCandidates));
  const activitySalesAmount = money(sumCandidates(activityRows, salesAmountCandidates));
  const rewardRowsAmount = money(sumAllCandidateFields(rewardRows, rewardPlayFields.flatMap(([, ...fields]) => fields)));
  const activityRewardAmount = money(sumCandidates(activityRows, rewardAmountCandidates));
  const rewardDistributionAmount = money(sumCandidates(rewardDistributionRows, rewardAmountCandidates));
  const employeeAccountMetricRows = metricRows.employeeAccount || [];
  const rewardDistributionMetricRows = metricRows.rewardDistribution || [];
  const metricObjects = (rows) => rows.map((row) => ({ [row.指标]: row.指标值 }));
  const yuanFromBeanUnit = (value) => {
    const amount = toNumber(value);
    return Math.abs(amount) >= 10000 ? money(amount / 100) : money(amount);
  };
  const maxMetricCandidate = (rows, candidates) => {
    const values = rows.flatMap((row) => candidates.map((candidate) => toNumber(row?.[candidate]))).filter((value) => value > 0);
    return values.length ? Math.max(...values) : 0;
  };
  const employeeMetricObjects = metricObjects(employeeAccountMetricRows);
  const totalWithdrawMoney = yuanFromBeanUnit(maxMetricCandidate(employeeMetricObjects, ["totalWithdrawMoney", "withdrawMoney", "withdrawAmount"]));
  const availableMoney = yuanFromBeanUnit(maxMetricCandidate(employeeMetricObjects, ["availableMoney"]));
  const totalPeas = yuanFromBeanUnit(maxMetricCandidate(employeeMetricObjects, ["totalPeas", "totalIntegral"]));
  const writeOffIntegralMoney = yuanFromBeanUnit(maxMetricCandidate(employeeMetricObjects, ["writeOffIntegralMoney", "integralMoney"]));
  const rewardDistributionMetricAmount = money(sumCandidates(metricObjects(rewardDistributionMetricRows), rewardAmountCandidates));
  const totalRewardAmount = rewardRowsAmount || rewardDistributionAmount || rewardDistributionMetricAmount || activityRewardAmount;
  const rewardEfficiency = activitySalesAmount ? money((totalRewardAmount / activitySalesAmount) * 100) : 0;
  const activityCoverageRate = ratioPercent(activeSkuCount || rewardSkuCount, salesSkuCount || activeSkuCount || rewardSkuCount);
  const storeCoverage = uniqueCountCandidates([...salesRows, ...activityRows], storeCandidates);
  const employeeCoverage = uniqueCountCandidates([...activityRows, ...cashoutRows, ...shareRewardRows, ...employeeAccountRows, ...rewardDistributionRows], employeeCandidates);
  const trainingMetricRows = metricRows.training || [];
  const trainingHasSignal = trainingRows.length > 0 || hasNonZeroMetric(trainingMetricRows);
  const shareRecordCount = (tipsRows.length || shareRewardRows.length);
  const shareRewardAmount = money(sumCandidates(tipsRows, rewardAmountCandidates) || sumCandidates(shareRewardRows, rewardAmountCandidates));
  const factoryCollaborationLevel = shareRecordCount > 0 || shareRewardAmount > 0 ? "healthy" : "risk";
  const cashoutEmployeeCount = cashoutRows.length ? cashoutRows.filter((row) => toNumber(row["累计提现及时豆（元）"]) > 0 || toNumber(row["累计提现金额"]) > 0).length : 0;
  const incomeEmployeeCount = cashoutRows.length
    ? cashoutRows.filter((row) => toNumber(row["累计及时豆（元）"]) + toNumber(row["累计延时豆（元）"]) + toNumber(row["累计收益"]) > 0).length
    : 0;
  const cashoutRate = incomeEmployeeCount ? ratioPercent(cashoutEmployeeCount, incomeEmployeeCount) : 0;
  const employeeAccountHasSignal = employeeAccountRows.length > 0 || hasNonZeroMetric(employeeAccountMetricRows);
  const rewardDistributionHasSignal = rewardDistributionRows.length > 0 || hasNonZeroMetric(rewardDistributionMetricRows);
  const employeeParticipationSignal = employeeCoverage || money(sumCandidates(activityRows, employeeCountCandidates)) || totalWithdrawMoney || totalPeas || cashoutRate || (employeeAccountHasSignal ? 1 : 0);
  const usedRewardPlays = rewardPlayFields
    .map(([name, ...fields]) => ({ name, amount: money(sumCandidates([...rewardRows, ...incentiveRows], fields)), skuCount: countRowsWithPositiveCandidate([...rewardRows, ...incentiveRows], fields) }))
    .filter((item) => item.amount > 0 || item.skuCount > 0);
  const unusedRewardPlays = rewardPlayFields.map(([name]) => name).filter((name) => !usedRewardPlays.some((item) => item.name === name));
  const zeroOrWeakActivityRows = (activityRows || []).filter((row) => sumCandidates([row], salesAmountCandidates) <= 0 && sumCandidates([row], rewardAmountCandidates) > 0);
  const lowActivityRows = topGenericRows(zeroOrWeakActivityRows, rewardAmountCandidates, [
    { name: "商品名称", candidates: productNameCandidates },
    { name: "商品编码", candidates: productCodeCandidates },
    { name: "数据路径", candidates: ["数据路径"] },
  ], 8, true);

  const scoreItems = [
    { key: "activitySustainability", label: "活动持续运营", value: joinedActivityCount, level: onlineActivityCount ? "healthy" : joinedActivityCount ? "watch" : "risk", explanation: joinedActivityCount ? `已识别 ${joinedActivityCount} 个已参加/已配置活动，其中当前上架/发布约 ${onlineActivityCount} 个，活动销售额约 ${activityCatalogSalesAmount}。` : "未识别到已参加活动列表，客户可能还没有形成持续活动运营池。" },
    { key: "activityCoverage", label: "活动覆盖", value: activityCoverageRate, level: rateLevel(activityCoverageRate, 35, 15), explanation: `活动覆盖约 ${activityCoverageRate}% 的动销品种；覆盖越低，客户越容易把四季蝉理解成少数单品红包。` },
    { key: "rewardClosure", label: "激励闭环", value: rewardEfficiency, level: activitySalesAmount ? rateLevel(Math.min(rewardEfficiency, 100), 8, 2) : "risk", explanation: activitySalesAmount ? `每100元活动销售对应约 ${rewardEfficiency} 元奖励，需结合毛利判断激励效率。` : "当前没有识别到活动销售额，难以证明奖励带动销售。" },
    { key: "employeeParticipation", label: "员工参与", value: employeeParticipationSignal, level: employeeParticipationSignal ? (totalWithdrawMoney || employeeCoverage ? "healthy" : "watch") : "risk", explanation: employeeParticipationSignal ? `识别到店员参与/豆豆/提现信号约 ${employeeParticipationSignal}，提现金额约 ${totalWithdrawMoney}。` : "缺少员工参与或提现信号，店员感知弱时客户续用风险会上升。" },
    { key: "trainingConversion", label: "培训承接", value: trainingRows.length || trainingMetricRows.length, level: trainingHasSignal ? "watch" : "risk", explanation: trainingHasSignal ? "已有培训或学习指标，可进一步与销售结果绑定。" : "培训数据为空，建议把重点品培训、考试和激励任务连成闭环。" },
    { key: "factoryCollaboration", label: "厂家协同", value: shareRewardAmount || shareRecordCount, level: factoryCollaborationLevel, explanation: shareRecordCount || shareRewardAmount ? `厂家晒单/打赏已有 ${shareRecordCount} 条记录，金额约 ${shareRewardAmount}。` : "厂家打赏和晒单为空，厂家资源没有被充分转化为门店执行证据。" },
  ];
  const riskItems = scoreItems.filter((item) => item.level === "risk");
  const watchItems = scoreItems.filter((item) => item.level === "watch");
  const rawHealthScore = scoreItems.reduce((sum, item) => sum + (item.level === "healthy" ? 20 : item.level === "watch" ? 12 : 5), 0);
  const healthScore = Math.max(0, Math.min(100, Math.round((rawHealthScore / Math.max(1, scoreItems.length * 20)) * 100)));
  const retentionRisk = healthScore >= 72 ? "低" : healthScore >= 48 ? "中" : "高";
  const valueProofPoints = [
    totalSalesAmount ? `已识别重点品销售额约 ${totalSalesAmount}，可用于向客户证明重点品经营规模。` : "",
    joinedActivityCount ? `已参加/配置活动 ${joinedActivityCount} 个，当前上架/发布约 ${onlineActivityCount} 个，可证明客户已有活动运营资产。` : "",
    activityBudgetAmount || activityUsedBudgetAmount ? `活动预算约 ${activityBudgetAmount}，已发/已用约 ${activityUsedBudgetAmount}，剩余约 ${activityRemainBudgetAmount}，可用于推动客户做费用复盘。` : "",
    activitySalesAmount ? `活动商品销售额约 ${activitySalesAmount}，奖励金额约 ${totalRewardAmount}，可沉淀为“费用换动销”的投入产出证据。` : "",
    totalWithdrawMoney || totalPeas ? `店员豆豆账户/提现已有可复盘信号：累计豆豆约 ${totalPeas}，提现约 ${totalWithdrawMoney}，余额约 ${availableMoney}。` : "",
    rewardDistributionHasSignal ? "奖励发放明细已接入，可向客户展示“销售产生奖励、奖励触达店员”的执行证据。" : "",
    usedRewardPlays.length ? `已使用 ${usedRewardPlays.length} 类激励玩法：${usedRewardPlays.map((item) => item.name).join("、")}。` : "",
    storeCoverage ? `识别到 ${storeCoverage} 个门店/机构相关覆盖信号，可用于做门店分层追踪。` : "",
  ].filter(Boolean);
  const recommendedActions = [
    onlineActivityCount ? "梳理当前上架活动，把高销售、高奖励、高提现的活动沉淀为下月复用模板。" : "补齐活动池：优先恢复或新建上架活动，避免客户只在单次项目里使用四季蝉。",
    activityCoverageRate < 35 ? "扩大活动覆盖：把AAA主力赚钱品、黄金单品和任务品分层配置，避免只做零散单品。" : "保留当前活动覆盖，并按品种层级做标杆门店复制。",
    usedRewardPlays.length < 3 ? `释放玩法价值：优先补齐 ${unusedRewardPlays.slice(0, 3).join("、")}，让客户看到四季蝉不只是单品红包。` : "复用已跑通的激励玩法，沉淀为客户月度活动模板。",
    trainingHasSignal ? "把培训结果与活动销售做同屏复盘，证明学习能转化为店员推荐动作。" : "补齐培训考试：每个重点品至少配置卖点学习、考试奖励和销售任务。",
    factoryCollaborationLevel === "risk" ? "引入厂家协同：推动厂家提供晒单打赏或活动费用，用数据证明费用落到门店执行层。" : "把厂家打赏和晒单沉淀成大单分享、排行榜和厂家复投证据。",
    employeeParticipationSignal ? "继续强化店员感知：复盘提现、排行榜、高收益员工案例，并用豆豆账户数据证明激励已触达店员。" : "补齐店员收益闭环：重点展示及时豆、延时豆、可提现收益和到账案例。",
  ];

  return {
    healthScore,
    retentionRisk,
    scoreItems,
    riskItems,
    watchItems,
    valueProofPoints,
    recommendedActions,
    metrics: {
      salesSkuCount,
      joinedActivityCount,
      onlineActivityCount,
      endedActivityCount,
      activityCatalogSalesAmount,
      activityCatalogRelationSaleAmount,
      activityBudgetAmount,
      activityUsedBudgetAmount,
      activityRemainBudgetAmount,
      activeSkuCount,
      rewardSkuCount,
      activityCoverageRate,
      totalSalesAmount,
      activitySalesAmount,
      totalRewardAmount,
      rewardEfficiency,
      storeCoverage,
      employeeCoverage,
      employeeParticipationSignal,
      cashoutRate,
      totalWithdrawMoney,
      availableMoney,
      totalPeas,
      writeOffIntegralMoney,
      usedRewardPlayCount: usedRewardPlays.length,
      unusedRewardPlays,
      shareRecordCount,
      shareRewardAmount,
      weakActivitySkuCount: zeroOrWeakActivityRows.length,
    },
    weakActivityItems: lowActivityRows,
  };
}

function rowsFromPaged(paged) {
  if (Array.isArray(paged)) return paged;
  if (!paged || typeof paged !== "object") return [];
  if (Array.isArray(paged.rows)) return paged.rows;
  if (Array.isArray(paged.data)) return paged.data;
  if (Array.isArray(paged.list)) return paged.list;
  if (Array.isArray(paged.records)) return paged.records;
  if (Array.isArray(paged.result)) return paged.result;
  if (paged.response?.data) return rowsFromPaged(paged.response.data);
  return [];
}

function responseData(result) {
  return result?.response?.data || {};
}

async function collectSijichanData(body) {
  const login = await sijichanLogin(body);
  const token = login.token;
  const merCode = String(body.merCode || "").trim();
  const merName = String(body.merName || login.merName || "").trim();
  const windows = buildSijichanWindows(body.asOf || "2026-06-06");
  const withMerCode = (payload = {}) => (merCode ? { merCode, ...payload } : payload);
  const diagnostics = [];
  const client = createSijichanClient(token, merCode, diagnostics);

  const salesPeriods = {
    lastMonth_vs_priorTwoMonths: [windows.lastMonth, windows.priorTwoMonths],
    previousMonth: [windows.previousMonth, null],
    priorTwoMonths: [windows.priorTwoMonths, null],
    nearHalf_vs_previousHalf: [windows.nearHalf, windows.previousHalf],
    previousHalf: [windows.previousHalf, null],
  };
  const sales = {};
  for (const [name, [window, comparison]] of Object.entries(salesPeriods)) {
    const request = saleBody(window, comparison);
    sales[name] = {
      label: window.label,
      request,
      overview: await client.post(`销售概览-${window.label}`, "industryOrder/queryProductOverview", request),
      products: await client.paged(`销售商品明细-${window.label}`, "industryOrder/queryStatisticsByProductAndMer", request),
    };
  }

  const trainBase = withMerCode({ startTime: windows.nearHalf.start, endTime: windows.nearHalf.end, authorizeBusinessCode: "" });
  const activityBody = (w) => ({ timeType: 1, startTime: w.start, endTime: w.end, summaryType: 1 });
  const rewardBody = { timeType: 1, startTime: windows.nearHalf.start, endTime: windows.nearHalf.end };
  const rewardDistributionBody = { timeType: 1, startTime: windows.nearHalf.start, endTime: windows.nearHalf.end };
  const employeeAccountBody = withMerCode({ timeType: 1, startTime: windows.nearHalf.start, endTime: windows.nearHalf.end });
  const activityCatalogBody = {
    status: null,
    activityName: "",
    commodityName: "",
    commodityCode: "",
    ispName: "",
    storeCodeList: [],
    areaIds: [],
    fromType: null,
  };
  const tipsBody = { startTime: windows.nearHalf.start, endTime: windows.nearHalf.end };

  return {
    meta: {
      source: "登录获取",
      merCode,
      merName,
      generatedAt: new Date().toISOString(),
      windows,
      loginUserName: login.userName,
      loginSystem: login.loginSystem,
    },
    sales,
    rewardStatistics: {
      nearHalf: {
        rows: await client.paged("奖励统计-近半年", "imActivityReward/commodity/rewardTypeStatistics", rewardBody),
        sum: await client.post("奖励统计合计-近半年", "imActivityReward/commodity/rewardTypeStatistics/sum", rewardBody),
      },
    },
    rewardDistribution: {
      nearHalf: {
        statistics: await client.post("奖励发放统计-近半年", "imActivityReward/queryRewardStatistics", rewardDistributionBody),
        rows: await client.paged("奖励发放明细-近半年", "imActivityReward/queryRewardList", rewardDistributionBody, 1000, { maxPages: 20 }),
      },
    },
    activityCatalog: {
      joined: await client.paged("我的活动列表", "industryMarket/queryAlreadyActivity", activityCatalogBody),
    },
    activitySummary: {
      lastMonth: {
        rows: await client.paged("活动汇总-5月", "imActivityReward/summary/page", activityBody(windows.lastMonth)),
        sum: await client.post("活动汇总合计-5月", "imActivityReward/summary/sum", activityBody(windows.lastMonth)),
      },
      previousMonth: {
        rows: await client.paged("活动汇总-4月", "imActivityReward/summary/page", activityBody(windows.previousMonth)),
        sum: await client.post("活动汇总合计-4月", "imActivityReward/summary/sum", activityBody(windows.previousMonth)),
      },
      nearHalf: {
        rows: await client.paged("活动汇总-近半年", "imActivityReward/summary/page", activityBody(windows.nearHalf)),
        sum: await client.post("活动汇总合计-近半年", "imActivityReward/summary/sum", activityBody(windows.nearHalf)),
      },
    },
    training: {
      courseOverview: await client.post("培训课程概览", "report/course/courseOverview", { ...trainBase, currentPage: 1, pageSize: 10, timeType: 1 }),
      resourceOverview: await client.post("培训资源概览", "report/course/resourceOverview", { ...trainBase, currentPage: 1, pageSize: 10, timeType: 1 }),
      roleLearning: await client.paged("培训角色学习统计", "employeeTrainingStatistics/queryStatisticsByRole", trainBase),
      storeLearning: await client.paged("培训门店学习统计", "employeeTrainingStatistics/queryStatisticsByStore", trainBase),
      employeeLearning: await client.paged("培训员工学习统计", "employeeTrainingStatistics/queryStatisticsByEmployee", trainBase),
      courseLearning: await client.paged("培训课程学习统计", "employeeTrainingStatistics/queryStatisticsByCourse", trainBase),
    },
    manufacturerTips: {
      summary: await client.post("店员圈厂家打赏汇总", "orderShareMoment/shareRewardDetailSum", tipsBody),
      rows: await client.paged("店员圈厂家打赏明细", "orderShareMoment/queryShareRewardDetailList", tipsBody),
    },
    employeeAccount: {
      accountSummary: await client.post("员工豆豆账户汇总-近半年", "isp_account/emp/view/list/sum", employeeAccountBody),
      withdrawSummary: await client.post("员工提现汇总-近半年", "isp_account/emp/view/withdraw/sum", employeeAccountBody),
      withdrawRows: await client.paged("员工提现明细-近半年", "isp_account/emp/view/withdraw_list", employeeAccountBody),
      writeOffRows: await client.paged("延时豆核销明细-近半年", "integral/reward/queryEmpWriteOffPage", employeeAccountBody),
      settleSummary: await client.post("员工结算汇总-近半年", "account/emp/settle/page/sum", employeeAccountBody),
      settleRows: await client.paged("员工结算明细-近半年", "account/emp/settle/page", employeeAccountBody),
    },
    overview: {
      activityTopStatistic: await client.post("概览-活动奖励核心指标", "report/activityReward/queryTopStatisticData", withMerCode({})),
      rewardStat: await client.post("概览-员工奖励提现指标", "report/account/emp/overview/queryRewardStat", withMerCode({ startTime: windows.nearHalf.start, endTime: windows.nearHalf.end, timeType: 1 })),
      orderShareSummary: await client.post("概览-店员圈指标", "report/order_share/orderShareMomentSummary", withMerCode({ startTime: windows.nearHalf.start, endTime: windows.nearHalf.end })),
    },
    diagnostics,
  };
}

function withDataMeta(rows, fileName, dataPath) {
  return (rows || []).map((row) => ({ ...row, 数据文件: fileName, 数据路径: dataPath }));
}

function summarizeSijichanRaw(raw) {
  const salesRows = [
    ...withDataMeta(rowsFromPaged(raw.sales.lastMonth_vs_priorTwoMonths.products), "sales.json", "lastMonth_vs_priorTwoMonths.products"),
    ...withDataMeta(rowsFromPaged(raw.sales.previousMonth.products), "sales.json", "previousMonth.products"),
    ...withDataMeta(rowsFromPaged(raw.sales.priorTwoMonths.products), "sales.json", "priorTwoMonths.products"),
    ...withDataMeta(rowsFromPaged(raw.sales.nearHalf_vs_previousHalf.products), "sales.json", "nearHalf_vs_previousHalf.products"),
    ...withDataMeta(rowsFromPaged(raw.sales.previousHalf.products), "sales.json", "previousHalf.products"),
  ];
  const activityRows = [
    ...withDataMeta(rowsFromPaged(raw.activitySummary.lastMonth.rows), "activity_summary.json", "lastMonth.rows"),
    ...withDataMeta(rowsFromPaged(raw.activitySummary.previousMonth.rows), "activity_summary.json", "previousMonth.rows"),
    ...withDataMeta(rowsFromPaged(raw.activitySummary.nearHalf.rows), "activity_summary.json", "nearHalf.rows"),
  ];
  const activityCatalogRows = withDataMeta(rowsFromPaged(raw.activityCatalog?.joined), "activity_catalog.json", "joined");
  const rewardRows = withDataMeta(rowsFromPaged(raw.rewardStatistics.nearHalf.rows), "reward_statistics.json", "nearHalf.rows");
  const rewardDistributionRows = withDataMeta(rowsFromPaged(raw.rewardDistribution?.nearHalf?.rows), "reward_distribution.json", "nearHalf.rows");
  const trainingRows = [
    ...withDataMeta(rowsFromPaged(raw.training.roleLearning), "training.json", "roleLearning"),
    ...withDataMeta(rowsFromPaged(raw.training.storeLearning), "training.json", "storeLearning"),
    ...withDataMeta(rowsFromPaged(raw.training.employeeLearning), "training.json", "employeeLearning"),
    ...withDataMeta(rowsFromPaged(raw.training.courseLearning), "training.json", "courseLearning"),
  ];
  const tipsRows = withDataMeta(rowsFromPaged(raw.manufacturerTips.rows), "manufacturer_tips.json", "rows");
  const employeeAccountRows = [
    ...withDataMeta(rowsFromPaged(raw.employeeAccount?.withdrawRows), "employee_account.json", "withdrawRows"),
    ...withDataMeta(rowsFromPaged(raw.employeeAccount?.writeOffRows), "employee_account.json", "writeOffRows"),
    ...withDataMeta(rowsFromPaged(raw.employeeAccount?.settleRows), "employee_account.json", "settleRows"),
  ];
  const rawData = {
    meta: raw.meta,
    diagnostics: raw.diagnostics || [],
    sales: Object.fromEntries(Object.entries(raw.sales).map(([key, value]) => [key, { overview: responseData(value.overview), rows: rowsFromPaged(value.products) }])),
    activityCatalog: { joined: rowsFromPaged(raw.activityCatalog?.joined) },
    rewardStatistics: { nearHalf: { rows: rowsFromPaged(raw.rewardStatistics.nearHalf.rows), sum: responseData(raw.rewardStatistics.nearHalf.sum) } },
    rewardDistribution: { nearHalf: { statistics: responseData(raw.rewardDistribution?.nearHalf?.statistics), rows: rowsFromPaged(raw.rewardDistribution?.nearHalf?.rows) } },
    activitySummary: Object.fromEntries(Object.entries(raw.activitySummary).map(([key, value]) => [key, { rows: rowsFromPaged(value.rows), sum: responseData(value.sum) }])),
    training: {
      courseOverview: responseData(raw.training.courseOverview),
      resourceOverview: responseData(raw.training.resourceOverview),
      roleLearning: rowsFromPaged(raw.training.roleLearning),
      storeLearning: rowsFromPaged(raw.training.storeLearning),
      employeeLearning: rowsFromPaged(raw.training.employeeLearning),
      courseLearning: rowsFromPaged(raw.training.courseLearning),
    },
    manufacturerTips: { summary: responseData(raw.manufacturerTips.summary), rows: rowsFromPaged(raw.manufacturerTips.rows) },
    employeeAccount: {
      accountSummary: responseData(raw.employeeAccount?.accountSummary),
      withdrawSummary: responseData(raw.employeeAccount?.withdrawSummary),
      withdrawRows: rowsFromPaged(raw.employeeAccount?.withdrawRows),
      writeOffRows: rowsFromPaged(raw.employeeAccount?.writeOffRows),
      settleSummary: responseData(raw.employeeAccount?.settleSummary),
      settleRows: rowsFromPaged(raw.employeeAccount?.settleRows),
    },
    overview: Object.fromEntries(Object.entries(raw.overview).map(([key, value]) => [key, responseData(value)])),
  };
  const trainingMetricRows = [
    ...metricRowsFromObject(rawData.training.courseOverview, "training.json", "courseOverview"),
    ...metricRowsFromObject(rawData.training.resourceOverview, "training.json", "resourceOverview"),
  ];
  const tipsMetricRows = metricRowsFromObject(rawData.manufacturerTips.summary, "manufacturer_tips.json", "summary");
  const overviewMetricRows = Object.entries(rawData.overview).flatMap(([key, value]) => metricRowsFromObject(value, "overview.json", key));
  const salesMetricRows = Object.entries(rawData.sales).flatMap(([key, value]) => metricRowsFromObject(value.overview, "sales.json", `${key}.overview`));
  const activityMetricRows = Object.entries(rawData.activitySummary).flatMap(([key, value]) => metricRowsFromObject(value.sum, "activity_summary.json", `${key}.sum`));
  const rewardMetricRows = metricRowsFromObject(rawData.rewardStatistics.nearHalf.sum, "reward_statistics.json", "nearHalf.sum");
  const rewardDistributionMetricRows = metricRowsFromObject(rawData.rewardDistribution.nearHalf.statistics, "reward_distribution.json", "nearHalf.statistics");
  const employeeAccountMetricRows = [
    ...metricRowsFromObject(rawData.employeeAccount.accountSummary, "employee_account.json", "accountSummary"),
    ...metricRowsFromObject(rawData.employeeAccount.withdrawSummary, "employee_account.json", "withdrawSummary"),
    ...metricRowsFromObject(rawData.employeeAccount.settleSummary, "employee_account.json", "settleSummary"),
  ];
  const metricRows = {
    sales: salesMetricRows,
    activityCatalog: [],
    activitySummary: activityMetricRows,
    rewardStatistics: rewardMetricRows,
    rewardDistribution: rewardDistributionMetricRows,
    training: trainingMetricRows,
    manufacturerTips: tipsMetricRows,
    employeeAccount: employeeAccountMetricRows,
    overview: overviewMetricRows,
  };
  const files = [
    { name: "sales.json", label: "销售汇总", rows: salesRows, metricRows: salesMetricRows, note: "销售商品明细接口，同时包含销售概览指标。" },
    { name: "activity_catalog.json", label: "我的活动列表", rows: activityCatalogRows, metricRows: [], note: "已参加/已配置活动列表，用于判断客户是否形成持续活动运营池。" },
    { name: "activity_summary.json", label: "活动汇总", rows: activityRows, metricRows: activityMetricRows, note: "活动商品明细接口，同时包含活动汇总合计。" },
    { name: "reward_statistics.json", label: "奖励统计", rows: rewardRows, metricRows: rewardMetricRows, note: "奖励统计明细接口，同时包含奖励金额合计。" },
    { name: "reward_distribution.json", label: "奖励发放明细", rows: rewardDistributionRows, metricRows: rewardDistributionMetricRows, note: "奖励发放页接口，用于证明奖励从活动执行流向店员。" },
    { name: "training.json", label: "培训情况", rows: trainingRows, metricRows: trainingMetricRows, note: "培训接口成功返回；明细为0时以课程/资源概览判断是否有培训承接。" },
    { name: "manufacturer_tips.json", label: "厂家打赏", rows: tipsRows, metricRows: tipsMetricRows, note: "厂家打赏接口成功返回；金额和明细为0代表当前口径未发生厂家额外激励。" },
    { name: "employee_account.json", label: "员工豆豆账户/提现", rows: employeeAccountRows, metricRows: employeeAccountMetricRows, note: "员工账户、提现、核销与结算接口，用于证明店员收益闭环。" },
    { name: "overview.json", label: "概览校验", rows: [], metricRows: overviewMetricRows, note: "首页概览是指标型数据，不产生明细行。" },
  ];
  const allRows = files.flatMap((file) => file.rows);
  const productName = [{ name: "商品名称", candidates: ["commodityName", "productName", "goodsName", "skuName", "name", "商品名称"] }];
  const productCode = [{ name: "商品编码", candidates: ["commodityCode", "wareIspCode", "productCode", "goodsCode", "skuCode", "code", "商品编码"] }];
  const commonFields = [...productName, ...productCode, { name: "数据文件", candidates: ["数据文件"] }, { name: "数据路径", candidates: ["数据路径"] }];
  const salesMetric = ["saleCommodityAmount", "rewardSaleAmount", "saleAmount", "salesAmount", "amount", "销售额"];
  const growthMetric = ["saleCommodityLastRate", "growthRate", "increaseRate", "环比增长率", "增长率"];
  const rewardMetric = ["rewardCommodityAmount", "singleRewardMoney", "rewardAmount", "amount", "奖励金额"];

  return {
    source: "登录获取",
    requestInfo: {
      asOf: "2026-06-06",
      merCode: raw.meta.merCode || "",
      merName: raw.meta.merName || "",
    },
    windows: raw.meta.windows,
    generatedAt: raw.meta.generatedAt,
    datasetFiles: files.map(datasetStatus),
    interfaceDiagnostics: raw.diagnostics || [],
    rowCounts: Object.fromEntries(files.map((file) => [file.name, file.rows.length])),
    metricRows,
    rawData,
    operationInsights: deriveOperationInsights({
      salesRows: withDataMeta(rowsFromPaged(raw.sales.nearHalf_vs_previousHalf.products), "sales.json", "nearHalf_vs_previousHalf.products"),
      activityRows: withDataMeta(rowsFromPaged(raw.activitySummary.nearHalf.rows), "activity_summary.json", "nearHalf.rows"),
      activityCatalogRows,
      rewardRows,
      trainingRows,
      tipsRows,
      employeeAccountRows,
      rewardDistributionRows,
      metricRows,
    }),
    salesChange: {
      topSalesAmount: topGenericRows(allRows, salesMetric, commonFields, 10, true),
      topQuantityGrowth: topGenericRows(allRows, growthMetric, commonFields, 10, true),
      weakQuantityGrowth: topGenericRows(allRows, growthMetric, commonFields, 10, false),
    },
    activity: {
      skuCount: new Set(activityRows.map((row) => pickField(row, ["commodityCode", "wareIspCode", "productCode", "商品编码"])).filter(hasValue)).size,
      totalSalesAmount: sumField(activityRows, "rewardSaleAmount"),
      totalRewardAmount: sumField(activityRows, "rewardCommodityAmount"),
      topSalesAmount: topGenericRows(activityRows, salesMetric, commonFields, 10, true),
      topRewardAmount: topGenericRows(activityRows, rewardMetric, commonFields, 10, true),
    },
    cashout: { topCashout: [] },
    incentive: {
      rewardTypes: [
        ["单品销售奖励", "singleRewardMoney"],
        ["疗程销售奖励", "multiRewardMoney"],
        ["关联销售奖励", "combineRewardMoney"],
        ["单品目标奖励", "commodityTargetRewardMoney"],
        ["系列目标奖励", "serialTargetRewardMoney"],
        ["组合目标奖励", "combinationTargetRewardMoney"],
        ["早鸟奖励", "dayRankRewardMoney"],
        ["排名奖励", "rankingRewardMoney"],
      ].map(([name, field]) => ({ name, skuCount: countPositive(rewardRows, field), amount: sumField(rewardRows, field), used: countPositive(rewardRows, field) > 0 })),
    },
    shareReward: {
      recordCount: tipsRows.length,
      totalAmount: sumField(tipsRows, "rewardAmount") || sumField(tipsRows, "amount"),
      topFactories: topGenericRows(tipsRows, ["rewardAmount", "amount"], [
        { name: "激励厂家", candidates: ["factoryName", "manufacturer", "supplierName"] },
        { name: "员工姓名", candidates: ["employeeName", "clerkName", "empName"] },
        { name: "数据文件", candidates: ["数据文件"] },
      ], 10, true),
    },
  };
}

async function runSijichanExport(body) {
  const raw = await collectSijichanData(body);
  return summarizeSijichanRaw(raw);
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
  const { report, markdown, reportId, shareUrl, svgUrl, qrSvgUrl, excelUrl, normalizedDataUrl, diagnosticsUrl } = await generateReportFromSummary(summary);
  const dbReportId = await saveReviewReportRecord(user.id, "excel", filename, summary, { report, markdown, reportId, shareUrl, svgUrl, qrSvgUrl, excelUrl, normalizedDataUrl, diagnosticsUrl });
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
    excelUrl,
    normalizedDataUrl,
    diagnosticsUrl,
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

  const summary = await runSijichanExport(body);
  const files = summary.datasetFiles || [];
  if (!files.some((file) => file.rowCount > 0)) {
    sendJson(res, 422, { error: "接口成功返回，但该账号/客户在当前口径无可复盘明细数据。", summary });
    return;
  }
  await saveDatasetRecord(user.id, "login", summary, summary.source || "登录获取");
  const { report, markdown, reportId, shareUrl, svgUrl, qrSvgUrl, excelUrl, normalizedDataUrl, diagnosticsUrl } = await generateReportFromSummary(summary);
  const dbReportId = await saveReviewReportRecord(user.id, "login", "登录获取", summary, { report, markdown, reportId, shareUrl, svgUrl, qrSvgUrl, excelUrl, normalizedDataUrl, diagnosticsUrl });
  sendJson(res, 200, { ok: true, id: dbReportId, summary, report, markdown, reportId, shareUrl, svgUrl, qrSvgUrl, excelUrl, normalizedDataUrl, diagnosticsUrl });
}

async function handleRegister(req, res) {
  const body = await readJsonBody(req);
  const name = String(body.name || "").trim();
  const companyName = String(body.companyName || "").trim();
  const phone = String(body.phone || "").trim();
  const email = String(body.email || "").trim();
  const password = String(body.password || "");
  if (!name || !password || (!phone && !email)) {
    sendJson(res, 400, { error: "请填写姓名、手机号或邮箱、密码。" });
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

async function handleSubmitCapabilityTest(req, res) {
  const body = await readJsonBody(req, 1024 * 1024 * 2);
  const submission = await saveCapabilitySubmission(body, req);
  sendJson(res, 200, { ok: true, submission });
}

async function handleListCapabilityTests(req, res) {
  const user = await requireAdmin(req, res);
  if (!user) return;
  sendJson(res, 200, { submissions: await listCapabilitySubmissions() });
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
      if (url.pathname === "/api/capability-test-submissions" && req.method === "POST") return await handleSubmitCapabilityTest(req, res);
      if (url.pathname === "/api/capability-test-submissions" && req.method === "GET") return await handleListCapabilityTests(req, res);
      const reportMatch = url.pathname.match(/^\/api\/review-reports\/([^/]+)$/);
      if (reportMatch && req.method === "GET") return await handleGetReport(req, res, decodeURIComponent(reportMatch[1]));
      return serveStatic(req, res);
    } catch (error) {
      const status = error.statusCode || (error.message && error.message.includes("超过10MB") ? 413 : 500);
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
    try {
      fs.writeFileSync(path.join(root, ".preview-url"), `http://localhost:${port}/?v=preview-server\n`, "utf8");
    } catch (error) {
      console.warn(`Preview URL file write skipped: ${error.message}`);
    }
    console.log(`Preview: http://localhost:${port}/?v=preview-server`);
  });
}

refreshExistingReportArtifacts().catch((error) => {
  console.warn(`Refresh existing reports failed: ${error.message}`);
});
listenOn();

