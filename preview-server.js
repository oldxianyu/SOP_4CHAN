const http = require("http");
const dns = require("dns");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const net = require("net");
const os = require("os");
const { spawn } = require("child_process");
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");
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
const localReviewPayloadPath = path.join(serverDir, "review-report-payloads.json");
const sessionSecretPath = path.join(serverDir, "session-secret");
const reportsDir = path.join(serverDir, "reports");
const publicReportBaseUrl = (process.env.PUBLIC_REPORT_BASE_URL || `http://localhost:${configuredPort}`).replace(/\/+$/, "");
const sijichanApiOrigin = "https://merchants.hydee.cn";
const sijichanManagerPathBase = "/businesses-gateway/mer-manager/1.0/";
const sijichanMerchantPathBase = "/businesses-gateway/merchant/1.0/";
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
const activeReviewJobs = new Map();
const activeWorkbookJobs = new Set();
const activeWeComBrowserSessions = new Map();
const activeWeComAutoReports = new Set();
const workbookDetailRowLimit = Number(process.env.WORKBOOK_DETAIL_ROW_LIMIT || 5000);
const reviewWorkbookTimeoutMs = Number(process.env.REVIEW_WORKBOOK_TIMEOUT_MS || 10 * 60 * 1000);
const weComTokenBodyLimitBytes = Number(process.env.WE_COM_TOKEN_BODY_LIMIT_BYTES || 128 * 1024);
const weComTokenScanTextLimit = Number(process.env.WE_COM_TOKEN_SCAN_TEXT_LIMIT || 256 * 1024);
const disableLocalDataFallback = process.env.DISABLE_LOCAL_DATA_FALLBACK === "true";
let localReviewPayloadStorageChecked = false;

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

const defaultReviewPromptInstruction = `# 角色设定
你是海典四季蝉（重点品数字化动销平台）的资深运营复盘顾问。你的核心任务是通过深度解析客户上传的Excel数据摘要及传入的 operationInsights 数据，输出一份专业、精准且具有业务导向的品种动销复盘报告。

# 平台与业务背景
- 四季蝉定位：绝非单纯的“发红包工具”，而是深度连接【厂家、连锁总部、门店店员、顾客】四端的数字化动销平台，完整覆盖“选品-培训-激励-销售-提现-统计-复盘”全链路闭环。
- 业务口径（AAA品种）：指销售额、毛利额、客流量三项指标均进入核心贡献区间的主力赚钱品种。
- 复盘终极目标：用真实数据向中国医药连锁客户自证四季蝉的业务价值，有效引导客户持续深挖平台功能，前置化解客户流失风险。

# 工作任务与数据聚焦点
请基于传入的数据源（Excel数据摘要 + operationInsights 中的健康度、价值证明点和建议动作）生成复盘报告。分析必须聚焦：
1. 品种表现：增长/下滑趋势、AAA品种表现、上月与去年同月同比、近半年与去年同期同比。
2. 活动商品销售与奖励闭环健康度。
3. 激励方式的实际应用价值，必须体现“用与不用”的差异对比。
4. 店员提现参与度与厂家晒单打赏活跃度。
5. 一个豆豆能带动的销售金额，格式严格写成“每1个豆豆奖励带动……元销售额。”。
6. 当月与上月同期活动数据对比：如果当月只有1日至11日，就只能对比上月1日至11日，严禁用当月未完整周期对比上月整月。重点看活动个数、活动商品数、活动销售额。
7. 大盘业绩对比：销售额、毛利额、毛利率，用于回答“赚没赚钱、规模多大”。同比或近半年同期对比时，只能计算两期都有销售记录的品种；去年同期或半年前没有销售的新品，不得纳入同比增幅。
8. 活动执行情况对比：门店动销率、人员动销率、品种动销率，用于回答“员工有没有真正推、目标商品动没动”。
9. 商品与结构对比：联合用药率、重点品占比、滞销品消化率，用于回答“卖出去的东西结构健不健康”。
10. 投入产出对比：ROI、费效比是否变化，用于回答“花出去的钱值不值”。ROI口径必须说明为“活动销售额 ÷ 奖励金额”，费效比口径必须说明为“奖励金额 ÷ 活动销售额 × 100%”。如果奖励金额或活动销售额缺失，不得强行判断健康。
11. 店员激励闭环必须补充店员认证总人数与提现总人数对比，并说明提现参与率。

# 严格约束条件
1. 纯中文业务表达：报告面向中国医药连锁客户，所有可见文字必须是自然流畅的中文。严禁在正文出现 role、actions、bullets、headquarters、stores、factories、operationInsights 等任何英文键名或代码字段。
2. 拒绝无效发散：严格基于客户实际数据输出，绝对禁止生搬硬套与数据无关的营销节点、节假日场景或泛泛的品类建议。
3. 不要输出独立风险章节，不要使用“续用风险”作为章节或卡片。
4. 在“下一步跟进动作”部分，必须严格使用“总部：……”“门店：……”“厂家：……”的中文句式开头。

# 输出结构要求
请严格按以下结构组织并输出报告：

一、四季蝉当期核心价值证明
提取 operationInsights 中的价值证明点，结合Excel数据，直观展示四季蝉为客户带来的实际增长与闭环价值。

二、动销数据深度解析
围绕AAA品种升降、激励应用价值、店员提现与厂家打赏、当月/上月活动执行对比、大盘业绩、商品结构和投入产出进行复盘。

三、下月运营重点与功能推进
明确指出下月应重点推动客户多使用四季蝉的哪些模块或具体玩法，以提升平台粘性。

四、三方协同下一步跟进动作
总部：[填写具体动作]
门店：[填写具体动作]
厂家：[填写具体动作]`;

function ensureServerDir() {
  fs.mkdirSync(serverDir, { recursive: true });
}

function sendJson(res, status, payload, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(payload));
}

function sendNoContent(res, headers = {}) {
  res.writeHead(204, headers);
  res.end();
}

function weComCaptureCorsHeaders(req) {
  const origin = String(req.headers.origin || "").replace(/\/+$/, "");
  const allowed = new Set(["https://merchants.hydee.cn", "https://sijichan.top", "http://192.168.1.200:8765"]);
  return {
    "Access-Control-Allow-Origin": allowed.has(origin) ? origin : "https://merchants.hydee.cn",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
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

function signHandoff(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto.createHmac("sha256", getSessionSecret()).update(`handoff:${body}`).digest("base64url");
  return `${body}.${signature}`;
}

function verifyHandoffToken(token) {
  if (!token || !token.includes(".")) return null;
  const [body, signature] = token.split(".");
  const expected = crypto.createHmac("sha256", getSessionSecret()).update(`handoff:${body}`).digest("base64url");
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

function emptyLocalData() {
  return { users: [], customerProfiles: [], aiConfigs: [], customerDatasets: [], reviewReports: [], reviewJobs: [], reviewJobEvents: [], capabilityTestSubmissions: [], systemSettings: [] };
}

function emptyLocalReviewPayloadData() {
  return { reviewReports: {} };
}

function writeLocalDataRaw(data) {
  ensureServerDir();
  fs.writeFileSync(localDataPath, JSON.stringify(data, null, 2), "utf8");
}

function readLocalReviewPayloadData() {
  if (disableLocalDataFallback) return emptyLocalReviewPayloadData();
  if (!fs.existsSync(localReviewPayloadPath)) {
    return emptyLocalReviewPayloadData();
  }
  try {
    const data = JSON.parse(fs.readFileSync(localReviewPayloadPath, "utf8"));
    return {
      reviewReports: data.reviewReports && typeof data.reviewReports === "object" ? data.reviewReports : {},
    };
  } catch {
    return emptyLocalReviewPayloadData();
  }
}

function writeLocalReviewPayloadData(data) {
  if (disableLocalDataFallback) {
    throw new Error("本地JSON兜底存储已关闭，请检查数据库连接。");
  }
  ensureServerDir();
  fs.writeFileSync(localReviewPayloadPath, JSON.stringify({ reviewReports: data.reviewReports || {} }, null, 2), "utf8");
}

function normalizeLocalReviewPayloadEntry(value) {
  return {
    summaryJson: value?.summaryJson || value?.summary_json || value?.summary || null,
    reportJson: value?.reportJson || value?.report_json || value?.report || null,
    markdown: value?.markdown || "",
  };
}

function stripLocalReviewReportPayloadFields(row) {
  if (!row || typeof row !== "object") return row;
  const next = { ...row };
  delete next.summaryJson;
  delete next.summary_json;
  delete next.reportJson;
  delete next.report_json;
  delete next.markdown;
  return next;
}

function extractLocalReviewPayload(row) {
  return normalizeLocalReviewPayloadEntry({
    summaryJson: row?.summaryJson || row?.summary_json || null,
    reportJson: row?.reportJson || row?.report_json || null,
    markdown: row?.markdown || "",
  });
}

function hasLocalInlineReviewPayload(row) {
  return Boolean(
    row &&
      (
        row.summaryJson ||
        row.summary_json ||
        row.reportJson ||
        row.report_json ||
        row.markdown
      ),
  );
}

function saveLocalReviewPayload(reportId, payload) {
  if (disableLocalDataFallback || !reportId) return;
  const data = readLocalReviewPayloadData();
  data.reviewReports[reportId] = normalizeLocalReviewPayloadEntry(payload);
  writeLocalReviewPayloadData(data);
}

function getLocalReviewPayload(reportId) {
  if (disableLocalDataFallback || !reportId) return null;
  const row = readLocalReviewPayloadData().reviewReports[reportId];
  return row ? normalizeLocalReviewPayloadEntry(row) : null;
}

function migrateLocalReviewPayloadStorage(data) {
  if (disableLocalDataFallback || localReviewPayloadStorageChecked) return data;
  localReviewPayloadStorageChecked = true;
  let changed = false;
  const payloadData = readLocalReviewPayloadData();
  const reviewReports = (data.reviewReports || []).map((row) => {
    if (!row?.id || !hasLocalInlineReviewPayload(row)) return row;
    payloadData.reviewReports[row.id] = extractLocalReviewPayload(row);
    changed = true;
    return stripLocalReviewReportPayloadFields(row);
  });
  if (!changed) return data;
  writeLocalReviewPayloadData(payloadData);
  const nextData = { ...data, reviewReports };
  writeLocalDataRaw(nextData);
  return nextData;
}

function readLocalData() {
  if (disableLocalDataFallback) return emptyLocalData();
  if (!fs.existsSync(localDataPath)) {
    return emptyLocalData();
  }
  try {
    const data = JSON.parse(fs.readFileSync(localDataPath, "utf8"));
    return migrateLocalReviewPayloadStorage({
      users: data.users || [],
      customerProfiles: data.customerProfiles || [],
      aiConfigs: data.aiConfigs || [],
      customerDatasets: data.customerDatasets || [],
      reviewReports: data.reviewReports || [],
      reviewJobs: data.reviewJobs || [],
      reviewJobEvents: data.reviewJobEvents || [],
      capabilityTestSubmissions: data.capabilityTestSubmissions || [],
      systemSettings: data.systemSettings || [],
    });
  } catch {
    return emptyLocalData();
  }
}

function writeLocalData(data) {
  if (disableLocalDataFallback) {
    throw new Error("本地JSON兜底存储已关闭，请检查数据库连接。");
  }
  writeLocalDataRaw(data);
}

function createId(prefix = "id") {
  return `${prefix}_${crypto.randomBytes(12).toString("hex")}`;
}

function jsonClone(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

function jsonParam(value, fallback = null) {
  return JSON.stringify(value ?? fallback);
}

function normalizePageNumber(value, fallback = 1) {
  const num = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(num) && num > 0 ? num : fallback;
}

function normalizePageSize(value, fallback = 20, max = 100) {
  const num = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.min(num, max);
}

function parsePagination(url, fallbackPageSize = 20, maxPageSize = 100) {
  return {
    page: normalizePageNumber(url.searchParams.get("page"), 1),
    pageSize: normalizePageSize(url.searchParams.get("pageSize"), fallbackPageSize, maxPageSize),
  };
}

function normalizeOptionalTextFilter(value, maxLength = 80) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, maxLength) : "";
}

function normalizeOptionalEnumFilter(value, allowedValues = []) {
  const text = String(value ?? "").trim();
  return allowedValues.includes(text) ? text : "";
}

function includesKeyword(value, keyword) {
  return String(value || "").toLowerCase().includes(String(keyword || "").toLowerCase());
}

function parseReviewReportListOptions(url) {
  const paging = parsePagination(url, 8, 50);
  return {
    ...paging,
    status: normalizeOptionalEnumFilter(url.searchParams.get("status"), ["running", "completed", "failed", "cancelled"]),
    sourceType: normalizeOptionalEnumFilter(url.searchParams.get("sourceType"), ["excel", "login", "wecom_browser", "wecom_token"]),
    keyword: normalizeOptionalTextFilter(url.searchParams.get("keyword"), 120),
  };
}

function parseAdminUserListOptions(url) {
  const paging = parsePagination(url, 10, 50);
  return {
    ...paging,
    role: normalizeOptionalEnumFilter(url.searchParams.get("role"), ["admin", "customer"]),
    status: normalizeOptionalEnumFilter(url.searchParams.get("status"), ["active", "disabled"]),
    keyword: normalizeOptionalTextFilter(url.searchParams.get("keyword"), 120),
  };
}

function parseCapabilitySubmissionListOptions(url) {
  const paging = parsePagination(url, 10, 50);
  return {
    ...paging,
    completionBand: normalizeOptionalEnumFilter(url.searchParams.get("completionBand"), ["low", "medium", "high"]),
    keyword: normalizeOptionalTextFilter(url.searchParams.get("keyword"), 120),
  };
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
  let trigramReady = false;
  try {
    await activePool.query("create extension if not exists pgcrypto");
  } catch {
    // Some Supabase roles may not be allowed to create extensions; fallback schemas use text ids.
  }
  try {
    await activePool.query("create extension if not exists pg_trgm");
    trigramReady = true;
  } catch {
    // Optional acceleration for ILIKE keyword filters; skip when the database role cannot create extensions.
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
      owner_user_id text references users(id) on delete cascade,
      base_url text not null,
      model text not null,
      protocol text not null,
      api_key_encrypted text not null,
      updated_by text references users(id),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create table if not exists system_settings (
      key text primary key,
      value_json jsonb not null default '{}'::jsonb,
      updated_by text references users(id) on delete set null,
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
      status text not null default 'completed',
      report_title text,
      row_counts_json jsonb not null default '{}'::jsonb,
      health_score numeric,
      risk_level text,
      summary_json jsonb not null default '{}'::jsonb,
      report_json jsonb not null default '{}'::jsonb,
      markdown text,
      report_id text unique not null,
      job_key text,
      cancel_requested boolean not null default false,
      heartbeat_at timestamptz,
      progress_stage text,
      progress_text text,
      progress_percent integer not null default 0,
      error_message text,
      retry_payload_json jsonb not null default '{}'::jsonb,
      started_at timestamptz,
      finished_at timestamptz,
      share_url text,
      svg_url text,
      qr_svg_url text,
      excel_url text,
      excel_status text not null default '',
      excel_error text,
      normalized_data_url text,
      diagnostics_url text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create table if not exists review_report_payloads (
      report_db_id text primary key references review_reports(id) on delete cascade,
      summary_json jsonb not null,
      report_json jsonb not null,
      markdown text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create table if not exists review_jobs (
      id text primary key default gen_random_uuid()::text,
      job_key text not null,
      report_db_id text references review_reports(id) on delete cascade,
      user_id text references users(id) on delete set null,
      source_type text not null,
      source_name text,
      status text not null default 'running',
      progress_stage text,
      progress_text text,
      progress_percent integer not null default 0,
      cancel_requested boolean not null default false,
      retry_payload_json jsonb not null default '{}'::jsonb,
      error_message text,
      started_at timestamptz not null default now(),
      heartbeat_at timestamptz,
      finished_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create table if not exists review_job_events (
      id text primary key default gen_random_uuid()::text,
      review_job_id text references review_jobs(id) on delete cascade,
      report_db_id text references review_reports(id) on delete cascade,
      user_id text references users(id) on delete set null,
      job_key text,
      event_type text not null,
      status text,
      progress_stage text,
      progress_percent integer,
      message text,
      metadata_json jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now()
    );
    create table if not exists ai_review_uploads (
      id text primary key default gen_random_uuid()::text,
      user_id text references users(id) on delete set null,
      dataset_id text references customer_datasets(id) on delete set null,
      report_db_id text references review_reports(id) on delete set null,
      source_type text not null,
      source_name text,
      filename text,
      row_counts_json jsonb not null default '{}'::jsonb,
      status text not null default 'parsed',
      error_message text,
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
    create table if not exists auth_operation_logs (
      id text primary key default gen_random_uuid()::text,
      user_id text references users(id) on delete set null,
      login_identifier text,
      operation_type text not null,
      success boolean not null default false,
      failure_reason text,
      ip_address inet,
      user_agent text,
      metadata_json jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create table if not exists sijichan_account_authorizations (
      id text primary key default gen_random_uuid()::text,
      user_id text references users(id) on delete set null,
      username text not null,
      password_encrypted text not null,
      auth_type text not null default 'password',
      token_encrypted text,
      token_expires_at timestamptz,
      mer_name text,
      mer_code text not null default '',
      status text not null default 'active',
      last_report_db_id text references review_reports(id) on delete set null,
      last_success_at timestamptz,
      last_error text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create table if not exists monthly_marketing_recommendations (
      id text primary key default gen_random_uuid()::text,
      month_key text not null,
      auth_id text references sijichan_account_authorizations(id) on delete set null,
      user_id text references users(id) on delete set null,
      customer_name text,
      customer_code text,
      status text not null default 'completed',
      activity_count integer not null default 0,
      product_count integer not null default 0,
      summary_json jsonb not null default '{}'::jsonb,
      recommendation_json jsonb not null default '{}'::jsonb,
      markdown text,
      error_message text,
      generated_at timestamptz not null default now(),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create table if not exists sijichan_token_handoffs (
      id text primary key,
      user_id text references users(id) on delete cascade,
      mer_name text,
      mer_code text not null default '',
      status text not null default 'pending',
      token_encrypted text,
      token_expires_at timestamptz,
      captured_at timestamptz,
      used_at timestamptz,
      last_error text,
      expires_at timestamptz not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create index if not exists idx_customer_datasets_user_created on customer_datasets(user_id, created_at desc);
    create index if not exists idx_ai_review_uploads_user_created on ai_review_uploads(user_id, created_at desc);
    create unique index if not exists idx_ai_review_uploads_dataset_unique on ai_review_uploads(dataset_id) where dataset_id is not null;
    create index if not exists idx_ai_review_uploads_report on ai_review_uploads(report_db_id);
    create index if not exists idx_ai_review_uploads_status_created on ai_review_uploads(status, created_at desc);
    create index if not exists idx_capability_test_submissions_created on capability_test_submissions(created_at desc);
    create index if not exists idx_capability_test_submissions_completion_created on capability_test_submissions(completion_rate, created_at desc);
    create index if not exists idx_auth_logs_user_created on auth_operation_logs(user_id, created_at desc);
    create index if not exists idx_auth_logs_identifier_created on auth_operation_logs(login_identifier, created_at desc);
    create index if not exists idx_auth_logs_success_created on auth_operation_logs(success, created_at desc);
    create index if not exists idx_users_role_status_created on users(role, status, created_at desc);
    create index if not exists idx_users_phone_created on users(phone, created_at desc);
    create index if not exists idx_review_reports_user_status_created on review_reports(user_id, status, created_at desc);
    create index if not exists idx_review_reports_source_status_created on review_reports(source_type, status, created_at desc);
    create index if not exists idx_review_jobs_key_status_created on review_jobs(job_key, status, created_at desc);
    create index if not exists idx_review_jobs_report on review_jobs(report_db_id);
    create index if not exists idx_review_jobs_running_heartbeat on review_jobs(status, heartbeat_at desc);
    create index if not exists idx_review_jobs_user_created on review_jobs(user_id, created_at desc);
    create index if not exists idx_review_job_events_job_created on review_job_events(review_job_id, created_at desc);
    create index if not exists idx_review_job_events_report_created on review_job_events(report_db_id, created_at desc);
    create index if not exists idx_review_job_events_user_created on review_job_events(user_id, created_at desc);
    create unique index if not exists idx_sijichan_auth_unique on sijichan_account_authorizations(user_id, username, mer_code);
    create index if not exists idx_sijichan_auth_status_updated on sijichan_account_authorizations(status, updated_at desc);
    create index if not exists idx_sijichan_handoff_user_created on sijichan_token_handoffs(user_id, created_at desc);
    create index if not exists idx_sijichan_handoff_status_expires on sijichan_token_handoffs(status, expires_at);
    create unique index if not exists idx_monthly_marketing_unique_all on monthly_marketing_recommendations(month_key, auth_id);
    create index if not exists idx_monthly_marketing_month_created on monthly_marketing_recommendations(month_key, created_at desc);
    create index if not exists idx_monthly_marketing_user_created on monthly_marketing_recommendations(user_id, created_at desc);
  `);
    await activePool.query(`
      alter table review_reports add column if not exists status text not null default 'completed';
      alter table review_reports add column if not exists report_title text;
      alter table review_reports add column if not exists row_counts_json jsonb not null default '{}'::jsonb;
      alter table review_reports add column if not exists health_score numeric;
      alter table review_reports add column if not exists risk_level text;
      alter table review_reports add column if not exists excel_url text;
      alter table review_reports add column if not exists excel_status text not null default '';
      alter table review_reports alter column excel_status set default '';
      alter table review_reports add column if not exists excel_error text;
      alter table review_reports add column if not exists normalized_data_url text;
      alter table review_reports add column if not exists diagnostics_url text;
      alter table review_reports add column if not exists job_key text;
      alter table review_reports add column if not exists cancel_requested boolean not null default false;
      alter table review_reports add column if not exists heartbeat_at timestamptz;
      alter table review_reports add column if not exists progress_stage text;
      alter table review_reports add column if not exists progress_text text;
      alter table review_reports add column if not exists progress_percent integer not null default 0;
      alter table review_reports add column if not exists error_message text;
      alter table review_reports add column if not exists retry_payload_json jsonb not null default '{}'::jsonb;
      alter table review_reports add column if not exists started_at timestamptz;
      alter table review_reports add column if not exists finished_at timestamptz;
      create table if not exists review_jobs (
        id text primary key default gen_random_uuid()::text,
        job_key text not null,
        report_db_id text references review_reports(id) on delete cascade,
        user_id text references users(id) on delete set null,
        source_type text not null,
        source_name text,
        status text not null default 'running',
        progress_stage text,
        progress_text text,
        progress_percent integer not null default 0,
        cancel_requested boolean not null default false,
        retry_payload_json jsonb not null default '{}'::jsonb,
        error_message text,
        started_at timestamptz not null default now(),
        heartbeat_at timestamptz,
        finished_at timestamptz,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create table if not exists review_job_events (
        id text primary key default gen_random_uuid()::text,
        review_job_id text references review_jobs(id) on delete cascade,
        report_db_id text references review_reports(id) on delete cascade,
        user_id text references users(id) on delete set null,
        job_key text,
        event_type text not null,
        status text,
        progress_stage text,
        progress_percent integer,
        message text,
        metadata_json jsonb not null default '{}'::jsonb,
        created_at timestamptz not null default now()
      );
      create index if not exists idx_review_reports_job_key on review_reports(job_key);
      create index if not exists idx_review_reports_running_heartbeat on review_reports(status, heartbeat_at desc);
      create index if not exists idx_review_reports_user_status_created on review_reports(user_id, status, created_at desc);
      create index if not exists idx_review_reports_source_status_created on review_reports(source_type, status, created_at desc);
      create index if not exists idx_review_jobs_key_status_created on review_jobs(job_key, status, created_at desc);
      create index if not exists idx_review_jobs_report on review_jobs(report_db_id);
      create index if not exists idx_review_jobs_running_heartbeat on review_jobs(status, heartbeat_at desc);
      create index if not exists idx_review_jobs_user_created on review_jobs(user_id, created_at desc);
      create index if not exists idx_review_job_events_job_created on review_job_events(review_job_id, created_at desc);
      create index if not exists idx_review_job_events_report_created on review_job_events(report_db_id, created_at desc);
      create index if not exists idx_review_job_events_user_created on review_job_events(user_id, created_at desc);
      create index if not exists idx_users_role_status_created on users(role, status, created_at desc);
      create index if not exists idx_users_phone_created on users(phone, created_at desc);
      create index if not exists idx_capability_test_submissions_completion_created on capability_test_submissions(completion_rate, created_at desc);
      drop function if exists get_review_report_list(text, boolean, integer);
    `);
    await activePool.query(`
      create or replace function set_updated_at()
      returns trigger
      language plpgsql
      as $$
      begin
        new.updated_at = now();
        return new;
      end;
      $$;
      create or replace function record_auth_operation(
        p_user_id text,
        p_login_identifier text,
        p_operation_type text,
        p_success boolean,
        p_failure_reason text,
        p_ip_address inet,
        p_user_agent text,
        p_metadata_json jsonb default '{}'::jsonb
      )
      returns text
      language plpgsql
      as $$
      declare
        v_id text;
      begin
        insert into auth_operation_logs(user_id, login_identifier, operation_type, success, failure_reason, ip_address, user_agent, metadata_json)
        values(p_user_id, p_login_identifier, p_operation_type, coalesce(p_success, false), p_failure_reason, p_ip_address, p_user_agent, coalesce(p_metadata_json, '{}'::jsonb))
        returning id into v_id;
        return v_id;
      end;
      $$;
      create or replace function cleanup_auth_operation_logs(p_success_retention_days integer, p_failure_retention_days integer)
      returns integer
      language plpgsql
      as $cleanup_auth_logs$
      declare
        v_removed integer := 0;
      begin
        delete from auth_operation_logs
        where (
            success = true
            and created_at < now() - (greatest(1, coalesce(p_success_retention_days, 90))::text || ' days')::interval
          )
          or (
            success = false
            and created_at < now() - (greatest(1, coalesce(p_failure_retention_days, 180))::text || ' days')::interval
          );

        get diagnostics v_removed = row_count;
        return v_removed;
      end;
      $cleanup_auth_logs$;
      create or replace function record_review_job_event()
      returns trigger
      language plpgsql
      as $review_job_event$
      declare
        v_message text;
        v_metadata jsonb;
        v_event_types text[];
        v_event_type text;
      begin
        if TG_OP = 'INSERT' then
          v_event_types := array['created'];
        elsif TG_OP = 'UPDATE' then
          v_event_types := array[]::text[];
          if coalesce(old.cancel_requested, false) = false and coalesce(new.cancel_requested, false) = true then
            v_event_types := array_append(v_event_types, 'cancel_requested');
          end if;
          if old.status is distinct from new.status then
            v_event_types := array_append(v_event_types, 'status_changed');
          end if;
          if old.progress_stage is distinct from new.progress_stage
             or old.progress_text is distinct from new.progress_text
             or old.progress_percent is distinct from new.progress_percent then
            v_event_types := array_append(v_event_types, 'progress');
          end if;
          if coalesce(array_length(v_event_types, 1), 0) = 0 then
            return new;
          end if;
        else
          return new;
        end if;

        v_message := coalesce(nullif(new.error_message, ''), nullif(new.progress_text, ''), new.status, v_event_type);
        if TG_OP = 'UPDATE' then
          v_metadata := jsonb_strip_nulls(jsonb_build_object(
            'operation', TG_OP,
            'sourceType', new.source_type,
            'sourceName', new.source_name,
            'oldStatus', old.status,
            'newStatus', new.status,
            'oldProgressStage', old.progress_stage,
            'newProgressStage', new.progress_stage,
            'oldProgressPercent', old.progress_percent,
            'newProgressPercent', new.progress_percent,
            'cancelRequested', new.cancel_requested,
            'heartbeatAt', new.heartbeat_at,
            'finishedAt', new.finished_at
          ));
        else
          v_metadata := jsonb_strip_nulls(jsonb_build_object(
            'operation', TG_OP,
            'sourceType', new.source_type,
            'sourceName', new.source_name,
            'newStatus', new.status,
            'newProgressStage', new.progress_stage,
            'newProgressPercent', new.progress_percent,
            'cancelRequested', new.cancel_requested,
            'heartbeatAt', new.heartbeat_at,
            'finishedAt', new.finished_at
          ));
        end if;

        foreach v_event_type in array v_event_types loop
          insert into review_job_events(
            review_job_id,
            report_db_id,
            user_id,
            job_key,
            event_type,
            status,
            progress_stage,
            progress_percent,
            message,
            metadata_json
          )
          values(
            new.id,
            new.report_db_id,
            new.user_id,
            new.job_key,
            v_event_type,
            new.status,
            new.progress_stage,
            new.progress_percent,
            v_message,
            coalesce(v_metadata, '{}'::jsonb)
          );
        end loop;

        return new;
      end;
      $review_job_event$;
      create or replace function sync_review_job_to_report()
      returns trigger
      language plpgsql
      as $sync_review_job$
      begin
        if new.report_db_id is null then
          return new;
        end if;

        update review_reports r
        set
          status = coalesce(new.status, r.status),
          cancel_requested = coalesce(new.cancel_requested, r.cancel_requested),
          heartbeat_at = coalesce(new.heartbeat_at, r.heartbeat_at),
          progress_stage = coalesce(new.progress_stage, r.progress_stage),
          progress_text = coalesce(new.progress_text, r.progress_text),
          progress_percent = coalesce(new.progress_percent, r.progress_percent),
          error_message = case
            when new.status in ('running', 'completed') then null
            when new.status in ('failed', 'cancelled') then coalesce(nullif(new.error_message, ''), r.error_message)
            else r.error_message
          end,
          started_at = coalesce(r.started_at, new.started_at),
          finished_at = case
            when new.status in ('completed', 'failed', 'cancelled') then coalesce(new.finished_at, r.finished_at, now())
            else r.finished_at
          end,
          report_title = case
            when new.status = 'failed' then '复盘报告生成失败'
            when new.status = 'cancelled' then '复盘报告已取消'
            else r.report_title
          end,
          updated_at = now()
        where r.id = new.report_db_id
          and (
            r.status is distinct from coalesce(new.status, r.status)
            or r.cancel_requested is distinct from coalesce(new.cancel_requested, r.cancel_requested)
            or r.heartbeat_at is distinct from coalesce(new.heartbeat_at, r.heartbeat_at)
            or r.progress_stage is distinct from coalesce(new.progress_stage, r.progress_stage)
            or r.progress_text is distinct from coalesce(new.progress_text, r.progress_text)
            or r.progress_percent is distinct from coalesce(new.progress_percent, r.progress_percent)
            or r.error_message is distinct from case
              when new.status in ('running', 'completed') then null
              when new.status in ('failed', 'cancelled') then coalesce(nullif(new.error_message, ''), r.error_message)
              else r.error_message
            end
            or (new.status in ('completed', 'failed', 'cancelled') and r.finished_at is null)
          );

        return new;
      end;
      $sync_review_job$;
      create or replace function apply_report_status_to_ai_review_upload()
      returns trigger
      language plpgsql
      as $apply_upload_report_status$
      declare
        v_report record;
      begin
        if new.report_db_id is null then
          return new;
        end if;

        select status, error_message
        into v_report
        from review_reports
        where id = new.report_db_id;

        if not found then
          return new;
        end if;

        new.status = case
          when v_report.status = 'completed' then 'completed'
          when v_report.status = 'running' then 'processing'
          when v_report.status = 'cancelled' then 'cancelled'
          when v_report.status = 'failed' then 'failed'
          else coalesce(new.status, 'parsed')
        end;
        new.error_message = case
          when v_report.status in ('failed', 'cancelled') then coalesce(nullif(v_report.error_message, ''), new.error_message)
          else null
        end;
        new.updated_at = now();
        return new;
      end;
      $apply_upload_report_status$;
      create or replace function sync_ai_review_uploads_from_report()
      returns trigger
      language plpgsql
      as $sync_uploads_from_report$
      begin
        update ai_review_uploads u
        set status = case
              when new.status = 'completed' then 'completed'
              when new.status = 'running' then 'processing'
              when new.status = 'cancelled' then 'cancelled'
              when new.status = 'failed' then 'failed'
              else u.status
            end,
            error_message = case
              when new.status in ('failed', 'cancelled') then coalesce(nullif(new.error_message, ''), u.error_message)
              else null
            end,
            updated_at = now()
        where u.report_db_id = new.id
          and (
            u.status is distinct from case
              when new.status = 'completed' then 'completed'
              when new.status = 'running' then 'processing'
              when new.status = 'cancelled' then 'cancelled'
              when new.status = 'failed' then 'failed'
              else u.status
            end
            or u.error_message is distinct from case
              when new.status in ('failed', 'cancelled') then coalesce(nullif(new.error_message, ''), u.error_message)
              else null
            end
          );
        return new;
      end;
      $sync_uploads_from_report$;
      create or replace function expire_stale_review_jobs(p_timeout_ms bigint, p_message text)
      returns table(job_key text, report_db_id text, source_table text)
      language plpgsql
      as $expire_review_jobs$
      begin
        return query
        with expired_jobs as (
          update review_jobs j
          set status='failed',
              error_message=p_message,
              cancel_requested=false,
              progress_stage='failed',
              progress_text=p_message,
              finished_at=now(),
              updated_at=now()
          where j.status='running'
            and coalesce(j.cancel_requested, false)=false
            and coalesce(j.heartbeat_at, j.started_at, j.created_at) < now() - (greatest(coalesce(p_timeout_ms, 1), 1)::text || ' milliseconds')::interval
          returning j.job_key, j.report_db_id
        ),
        expired_reports as (
          update review_reports r
          set status='failed',
              report_title='复盘报告生成失败',
              error_message=p_message,
              cancel_requested=false,
              progress_stage='failed',
              progress_text=p_message,
              finished_at=now(),
              updated_at=now()
          where (
              r.id in (select ej.report_db_id from expired_jobs ej where ej.report_db_id is not null)
              or (
                r.status='running'
                and coalesce(r.cancel_requested, false)=false
                and coalesce(r.heartbeat_at, r.started_at, r.created_at) < now() - (greatest(coalesce(p_timeout_ms, 1), 1)::text || ' milliseconds')::interval
              )
            )
          returning r.job_key, r.id as report_db_id
        )
        select ej.job_key, ej.report_db_id, 'review_jobs'::text
        from expired_jobs ej
        union all
        select er.job_key, er.report_db_id, 'review_reports'::text
        from expired_reports er;
      end;
      $expire_review_jobs$;
      create or replace function cleanup_review_job_events(p_retention_days integer, p_max_per_job integer)
      returns integer
      language plpgsql
      as $cleanup_review_events$
      declare
        v_removed integer := 0;
        v_count integer := 0;
      begin
        if coalesce(p_retention_days, 0) > 0 then
          delete from review_job_events
          where created_at < now() - (greatest(p_retention_days, 1)::text || ' days')::interval;
          get diagnostics v_count = row_count;
          v_removed := v_removed + coalesce(v_count, 0);
        end if;

        if coalesce(p_max_per_job, 0) > 0 then
          delete from review_job_events e
          using (
            select id
            from (
              select
                id,
                row_number() over (
                  partition by coalesce(review_job_id, report_db_id, job_key, id)
                  order by created_at desc, id desc
                ) as row_no
              from review_job_events
            ) ranked
            where row_no > greatest(p_max_per_job, 1)
          ) expired
          where e.id = expired.id;
          get diagnostics v_count = row_count;
          v_removed := v_removed + coalesce(v_count, 0);
        end if;

        return v_removed;
      end;
      $cleanup_review_events$;
      create or replace function expire_stale_review_workbooks(p_timeout_ms bigint, p_message text)
      returns table(expired_report_db_id text)
      language plpgsql
      as $expire_review_workbooks$
      begin
        return query
        with expired as (
          update review_reports r
          set excel_status='failed',
              excel_url='',
              excel_error=p_message,
              updated_at=now()
          where coalesce(r.excel_status, '') = 'generating'
            and extract(epoch from (now() - coalesce(r.updated_at, r.created_at))) * 1000 > p_timeout_ms
          returning r.id, r.user_id, r.job_key
        ),
        logged as (
          insert into review_job_events(review_job_id, report_db_id, user_id, job_key, event_type, status, progress_stage, progress_percent, message, metadata_json)
          select null::text, e.id, e.user_id, e.job_key, 'excel_status', 'completed', 'excel_failed', 100, p_message, jsonb_build_object('timeout', true)
          from expired e
          returning review_job_events.report_db_id
        )
        select e.id
        from expired e
        left join logged l on l.report_db_id = e.id;
      end;
      $expire_review_workbooks$;
      create or replace function get_review_report_list(p_user_id text, p_is_admin boolean, p_limit integer default 100)
      returns table(
        id text,
        user_id text,
        source_type text,
        source_name text,
        status text,
        report_title text,
        report_id text,
        row_counts_json jsonb,
        health_score numeric,
        risk_level text,
        share_url text,
        svg_url text,
        qr_svg_url text,
        excel_url text,
        excel_status text,
        excel_error text,
        normalized_data_url text,
        diagnostics_url text,
        job_key text,
        error_message text,
        started_at timestamptz,
        finished_at timestamptz,
        created_at timestamptz
      )
      language sql
      stable
      as $$
        select
          r.id,
          r.user_id,
          r.source_type,
          r.source_name,
          r.status,
          r.report_title,
          r.report_id,
          r.row_counts_json,
          r.health_score,
          r.risk_level,
          r.share_url,
          r.svg_url,
          r.qr_svg_url,
          r.excel_url,
          r.excel_status,
          r.excel_error,
          r.normalized_data_url,
          r.diagnostics_url,
          r.job_key,
          r.error_message,
          r.started_at,
          r.finished_at,
          r.created_at
        from review_reports r
        where coalesce(p_is_admin, false) or r.user_id = p_user_id
        order by r.created_at desc
        limit greatest(1, least(coalesce(p_limit, 100), 500));
      $$;
      create or replace function review_report_payload_count()
      returns integer
      language sql
      stable
      as $$
        select count(*)::integer from review_report_payloads;
      $$;
      create or replace view review_report_list_view as
        select
          r.id,
          r.user_id,
          r.customer_profile_id,
          r.source_type,
          r.source_name,
          r.status,
          r.report_title,
          r.report_id,
          r.row_counts_json,
          r.health_score,
          r.risk_level,
          r.share_url,
          r.svg_url,
          r.qr_svg_url,
          r.excel_url,
          r.excel_status,
          r.excel_error,
          r.normalized_data_url,
          r.diagnostics_url,
          r.job_key,
          r.cancel_requested,
          r.heartbeat_at,
          r.progress_stage,
          r.progress_text,
          r.progress_percent,
          r.error_message,
          r.started_at,
          r.finished_at,
          r.created_at
        from review_reports r;
      create or replace view running_review_report_view as
        select *
        from review_report_list_view
        where status = 'running'
          and coalesce(cancel_requested, false) = false;
      create or replace view admin_user_overview_view as
        select
          u.id,
          u.name,
          u.phone,
          u.email,
          u.role,
          u.status,
          u.created_at,
          u.updated_at,
          coalesce(cp.company_name, '') as company_name,
          coalesce(rr.report_count, 0)::int as report_count,
          coalesce(cd.dataset_count, 0)::int as dataset_count,
          coalesce(ac.ai_config_count, 0)::int as ai_config_count,
          al.last_login_at
        from users u
        left join (
          select user_id, max(company_name) as company_name
          from customer_profiles
          group by user_id
        ) cp on cp.user_id = u.id
        left join (
          select user_id, count(*)::int as report_count
          from review_reports
          group by user_id
        ) rr on rr.user_id = u.id
        left join (
          select user_id, count(*)::int as dataset_count
          from customer_datasets
          group by user_id
        ) cd on cd.user_id = u.id
        left join (
          select coalesce(owner_user_id, updated_by) as user_id, count(*)::int as ai_config_count
          from ai_configs
          group by coalesce(owner_user_id, updated_by)
        ) ac on ac.user_id = u.id
        left join (
          select user_id, max(created_at) as last_login_at
          from auth_operation_logs
          where operation_type = 'login' and success = true
          group by user_id
        ) al on al.user_id = u.id;
      create or replace view user_account_stats_view as
        select
          count(*)::int as total_users,
          count(*) filter (where role = 'admin')::int as admin_users,
          count(*) filter (where role <> 'admin')::int as customer_users,
          count(*) filter (where status <> 'active')::int as disabled_users
        from users;
      create or replace view capability_submission_list_view as
        select
          id,
          name,
          department,
          test_date,
          total_questions,
          answered_questions,
          completion_rate,
          created_at
        from capability_test_submissions;
      create or replace view monthly_marketing_list_view as
        select
          id,
          month_key,
          user_id,
          customer_name,
          customer_code,
          status,
          activity_count,
          product_count,
          error_message,
          generated_at,
          created_at,
          coalesce(recommendation_json->'focusProducts', '[]'::jsonb) as focus_products_json,
          coalesce(recommendation_json->'nextActions', '[]'::jsonb) as next_actions_json
        from monthly_marketing_recommendations;
      create or replace function get_monthly_marketing_aggregate(p_month_key text, p_user_id text, p_is_admin boolean)
      returns table(
        source_count integer,
        failed_count integer,
        activity_count integer,
        product_count integer,
        updated_at timestamptz,
        focus_products_json jsonb,
        next_actions_json jsonb
      )
      language sql
      stable
      as $monthly_marketing_aggregate$
        with scoped as (
          select *
          from monthly_marketing_list_view
          where month_key = p_month_key
            and (coalesce(p_is_admin, false) or user_id = p_user_id)
        ),
        stats as (
          select
            count(*) filter (where status = 'completed')::int as source_count,
            count(*) filter (where status <> 'completed')::int as failed_count,
            coalesce(sum(activity_count) filter (where status = 'completed'), 0)::int as activity_count,
            coalesce(sum(product_count) filter (where status = 'completed'), 0)::int as product_count,
            max(generated_at) filter (where status = 'completed') as updated_at
          from scoped
        ),
        focus as (
          select coalesce(jsonb_agg(value order by score desc, value), '[]'::jsonb) as focus_products_json
          from (
            select value, count(*)::int as score
            from (
              select trim(focus_item.value) as value
              from scoped s
              cross join lateral jsonb_array_elements_text(coalesce(s.focus_products_json, '[]'::jsonb)) as focus_item(value)
              where s.status = 'completed'
                and trim(focus_item.value) <> ''
            ) focus_items
            group by value
            order by score desc, value
            limit 14
          ) limited_focus
        ),
        actions as (
          select coalesce(jsonb_agg(value order by score desc, value), '[]'::jsonb) as next_actions_json
          from (
            select value, count(*)::int as score
            from (
              select trim(action_item.value) as value
              from scoped s
              cross join lateral jsonb_array_elements_text(coalesce(s.next_actions_json, '[]'::jsonb)) as action_item(value)
              where s.status = 'completed'
                and trim(action_item.value) <> ''
            ) action_items
            group by value
            order by score desc, value
            limit 8
          ) limited_actions
        )
        select
          stats.source_count,
          stats.failed_count,
          stats.activity_count,
          stats.product_count,
          stats.updated_at,
          focus.focus_products_json,
          actions.next_actions_json
        from stats
        cross join focus
        cross join actions;
      $monthly_marketing_aggregate$;
      do $$
      declare
        t text;
        trigger_name text;
      begin
        foreach t in array array[
          'users',
          'customer_profiles',
          'ai_configs',
          'system_settings',
          'customer_datasets',
          'ai_review_uploads',
          'review_reports',
          'review_report_payloads',
          'review_jobs',
          'capability_test_submissions',
          'auth_operation_logs',
          'sijichan_account_authorizations',
          'sijichan_token_handoffs',
          'monthly_marketing_recommendations'
        ]
        loop
          trigger_name := 'trg_' || t || '_updated_at';
          if not exists (select 1 from pg_trigger where tgname = trigger_name and not tgisinternal) then
            execute format('create trigger %I before update on %I for each row execute function set_updated_at()', trigger_name, t);
          end if;
        end loop;
      end;
      $$;
      drop trigger if exists trg_review_jobs_event_log on review_jobs;
      create trigger trg_review_jobs_event_log
        after insert or update on review_jobs
        for each row execute function record_review_job_event();
      drop trigger if exists trg_review_jobs_sync_report on review_jobs;
      create trigger trg_review_jobs_sync_report
        after insert or update on review_jobs
        for each row execute function sync_review_job_to_report();
      alter table review_reports add column if not exists status text not null default 'completed';
      alter table review_reports add column if not exists report_title text;
      alter table review_reports add column if not exists row_counts_json jsonb not null default '{}'::jsonb;
      alter table review_reports add column if not exists health_score numeric;
      alter table review_reports add column if not exists risk_level text;
      alter table review_reports add column if not exists excel_url text;
      alter table review_reports add column if not exists excel_status text not null default '';
      alter table review_reports alter column excel_status set default '';
      alter table review_reports add column if not exists excel_error text;
      alter table review_reports add column if not exists normalized_data_url text;
      alter table review_reports add column if not exists diagnostics_url text;
      alter table review_reports add column if not exists job_key text;
      alter table review_reports add column if not exists cancel_requested boolean not null default false;
      alter table review_reports add column if not exists heartbeat_at timestamptz;
      alter table review_reports add column if not exists progress_stage text;
      alter table review_reports add column if not exists progress_text text;
      alter table review_reports add column if not exists progress_percent integer not null default 0;
      alter table review_reports add column if not exists error_message text;
      alter table review_reports add column if not exists retry_payload_json jsonb not null default '{}'::jsonb;
      alter table review_reports add column if not exists started_at timestamptz;
      alter table review_reports add column if not exists finished_at timestamptz;
      create table if not exists review_jobs (
        id text primary key default gen_random_uuid()::text,
        job_key text not null,
        report_db_id text references review_reports(id) on delete cascade,
        user_id text references users(id) on delete set null,
        source_type text not null,
        source_name text,
        status text not null default 'running',
        progress_stage text,
        progress_text text,
        progress_percent integer not null default 0,
        cancel_requested boolean not null default false,
        retry_payload_json jsonb not null default '{}'::jsonb,
        error_message text,
        started_at timestamptz not null default now(),
        heartbeat_at timestamptz,
        finished_at timestamptz,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      alter table review_jobs add column if not exists job_key text not null default '';
      alter table review_jobs add column if not exists report_db_id text references review_reports(id) on delete cascade;
      alter table review_jobs add column if not exists user_id text references users(id) on delete set null;
      alter table review_jobs add column if not exists source_type text not null default 'unknown';
      alter table review_jobs add column if not exists source_name text;
      alter table review_jobs add column if not exists status text not null default 'running';
      alter table review_jobs add column if not exists progress_stage text;
      alter table review_jobs add column if not exists progress_text text;
      alter table review_jobs add column if not exists progress_percent integer not null default 0;
      alter table review_jobs add column if not exists cancel_requested boolean not null default false;
      alter table review_jobs add column if not exists retry_payload_json jsonb not null default '{}'::jsonb;
      alter table review_jobs add column if not exists error_message text;
      alter table review_jobs add column if not exists started_at timestamptz not null default now();
      alter table review_jobs add column if not exists heartbeat_at timestamptz;
      alter table review_jobs add column if not exists finished_at timestamptz;
      create table if not exists review_job_events (
        id text primary key default gen_random_uuid()::text,
        review_job_id text references review_jobs(id) on delete cascade,
        report_db_id text references review_reports(id) on delete cascade,
        user_id text references users(id) on delete set null,
        job_key text,
        event_type text not null,
        status text,
        progress_stage text,
        progress_percent integer,
        message text,
        metadata_json jsonb not null default '{}'::jsonb,
        created_at timestamptz not null default now()
      );
      alter table ai_configs add column if not exists owner_user_id text references users(id) on delete cascade;
      alter table ai_review_uploads add column if not exists report_db_id text references review_reports(id) on delete set null;
      alter table ai_review_uploads add column if not exists error_message text;
      alter table auth_operation_logs add column if not exists metadata_json jsonb not null default '{}'::jsonb;
      alter table sijichan_account_authorizations add column if not exists last_report_db_id text references review_reports(id) on delete set null;
      alter table sijichan_account_authorizations add column if not exists last_success_at timestamptz;
      alter table sijichan_account_authorizations add column if not exists last_error text;
      alter table sijichan_account_authorizations add column if not exists auth_type text not null default 'password';
      alter table sijichan_account_authorizations add column if not exists token_encrypted text;
      alter table sijichan_account_authorizations add column if not exists token_expires_at timestamptz;
      create table if not exists sijichan_token_handoffs (
        id text primary key,
        user_id text references users(id) on delete cascade,
        mer_name text,
        mer_code text not null default '',
        status text not null default 'pending',
        token_encrypted text,
        token_expires_at timestamptz,
        captured_at timestamptz,
        used_at timestamptz,
        last_error text,
        expires_at timestamptz not null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      alter table monthly_marketing_recommendations add column if not exists error_message text;
      drop trigger if exists trg_ai_review_uploads_apply_report_status on ai_review_uploads;
      create trigger trg_ai_review_uploads_apply_report_status
        before insert or update of report_db_id on ai_review_uploads
        for each row execute function apply_report_status_to_ai_review_upload();
      drop trigger if exists trg_review_reports_sync_uploads on review_reports;
      create trigger trg_review_reports_sync_uploads
        after update of status, error_message on review_reports
        for each row execute function sync_ai_review_uploads_from_report();
      create index if not exists idx_review_reports_user_created on review_reports(user_id, created_at desc);
      create index if not exists idx_review_reports_created on review_reports(created_at desc);
      create index if not exists idx_review_reports_status_created on review_reports(status, created_at desc);
      create index if not exists idx_review_reports_job_key on review_reports(job_key);
      create index if not exists idx_review_reports_running_heartbeat on review_reports(status, heartbeat_at desc);
      create index if not exists idx_review_jobs_key_status_created on review_jobs(job_key, status, created_at desc);
      create index if not exists idx_review_jobs_report on review_jobs(report_db_id);
      create index if not exists idx_review_jobs_running_heartbeat on review_jobs(status, heartbeat_at desc);
      create index if not exists idx_review_jobs_user_created on review_jobs(user_id, created_at desc);
      create index if not exists idx_review_job_events_job_created on review_job_events(review_job_id, created_at desc);
      create index if not exists idx_review_job_events_report_created on review_job_events(report_db_id, created_at desc);
      create index if not exists idx_review_job_events_user_created on review_job_events(user_id, created_at desc);
      create index if not exists idx_system_settings_updated on system_settings(updated_at desc);
      update ai_configs set owner_user_id = updated_by where owner_user_id is null and updated_by is not null;
      create index if not exists idx_ai_configs_owner_updated on ai_configs(owner_user_id, updated_at desc);
      create index if not exists idx_ai_review_uploads_user_created on ai_review_uploads(user_id, created_at desc);
      create unique index if not exists idx_ai_review_uploads_dataset_unique on ai_review_uploads(dataset_id) where dataset_id is not null;
      create index if not exists idx_ai_review_uploads_report on ai_review_uploads(report_db_id);
      create index if not exists idx_ai_review_uploads_status_created on ai_review_uploads(status, created_at desc);
      create index if not exists idx_auth_logs_user_created on auth_operation_logs(user_id, created_at desc);
      create index if not exists idx_auth_logs_identifier_created on auth_operation_logs(login_identifier, created_at desc);
      create index if not exists idx_auth_logs_success_created on auth_operation_logs(success, created_at desc);
      create unique index if not exists idx_sijichan_auth_unique on sijichan_account_authorizations(user_id, username, mer_code);
      create index if not exists idx_sijichan_auth_status_updated on sijichan_account_authorizations(status, updated_at desc);
      create index if not exists idx_sijichan_handoff_user_created on sijichan_token_handoffs(user_id, created_at desc);
      create index if not exists idx_sijichan_handoff_status_expires on sijichan_token_handoffs(status, expires_at);
      create unique index if not exists idx_monthly_marketing_unique_all on monthly_marketing_recommendations(month_key, auth_id);
      create index if not exists idx_monthly_marketing_month_created on monthly_marketing_recommendations(month_key, created_at desc);
      create index if not exists idx_monthly_marketing_user_created on monthly_marketing_recommendations(user_id, created_at desc);
      insert into ai_review_uploads(user_id, dataset_id, source_type, source_name, filename, row_counts_json, status, created_at, updated_at)
      select
        d.user_id,
        d.id,
        d.source_type,
        coalesce(d.metadata_json->>'source', d.source_type),
        d.filename,
        coalesce(d.row_counts_json, '{}'::jsonb),
        'migrated',
        d.created_at,
        d.updated_at
      from customer_datasets d
      where not exists (
        select 1 from ai_review_uploads u where u.dataset_id = d.id
      );
      insert into review_report_payloads(report_db_id, summary_json, report_json, markdown, created_at, updated_at)
      select id, summary_json, report_json, markdown, created_at, updated_at
      from review_reports
      where not exists (
        select 1 from review_report_payloads where review_report_payloads.report_db_id = review_reports.id
      );
      update review_reports
      set
        report_title = coalesce(report_title, nullif(report_json->>'title', ''), '四季蝉AI复盘报告'),
        row_counts_json = case when row_counts_json = '{}'::jsonb then coalesce(summary_json->'rowCounts', '{}'::jsonb) else row_counts_json end,
        health_score = coalesce(
          health_score,
          case
            when coalesce(summary_json#>>'{operationInsights,healthScore}', '') ~ '^-?[0-9]+(\\.[0-9]+)?$'
            then (summary_json#>>'{operationInsights,healthScore}')::numeric
            else null
          end
        ),
        risk_level = coalesce(risk_level, nullif(summary_json#>>'{operationInsights,retentionRisk}', '')),
        status = coalesce(nullif(status, ''), 'completed'),
        updated_at = updated_at;
      update review_reports
      set
        summary_json = coalesce(row_counts_json, '{}'::jsonb),
        report_json = jsonb_build_object('title', coalesce(report_title, report_json->>'title', '四季蝉AI复盘报告')),
        markdown = ''
      where pg_column_size(summary_json) > 4096
         or pg_column_size(report_json) > 4096
         or length(coalesce(markdown, '')) > 2048;
    `);
    if (trigramReady) {
      await activePool.query(`
        create index if not exists idx_users_name_trgm on users using gin ((coalesce(name, '')) gin_trgm_ops);
        create index if not exists idx_users_phone_trgm on users using gin ((coalesce(phone, '')) gin_trgm_ops);
        create index if not exists idx_users_email_trgm on users using gin ((coalesce(email, '')) gin_trgm_ops);
        create index if not exists idx_customer_profiles_company_trgm on customer_profiles using gin ((coalesce(company_name, '')) gin_trgm_ops);
        create index if not exists idx_review_reports_title_trgm on review_reports using gin ((coalesce(report_title, '')) gin_trgm_ops);
        create index if not exists idx_review_reports_source_name_trgm on review_reports using gin ((coalesce(source_name, '')) gin_trgm_ops);
        create index if not exists idx_review_reports_report_id_trgm on review_reports using gin ((coalesce(report_id, '')) gin_trgm_ops);
        create index if not exists idx_capability_submissions_name_trgm on capability_test_submissions using gin ((coalesce(name, '')) gin_trgm_ops);
        create index if not exists idx_capability_submissions_department_trgm on capability_test_submissions using gin ((coalesce(department, '')) gin_trgm_ops);
        create index if not exists idx_capability_submissions_test_date_trgm on capability_test_submissions using gin ((coalesce(test_date, '')) gin_trgm_ops);
      `);
    }
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

function normalizeAdminUserRow(row) {
  const user = normalizeUserRow(row);
  if (!user) return null;
  return {
    id: user.id,
    name: user.name || "",
    phone: user.phone || "",
    email: user.email || "",
    role: user.role || "customer",
    status: user.status || "active",
    companyName: row.company_name || row.companyName || "",
    reportCount: Number(row.report_count ?? row.reportCount ?? 0),
    datasetCount: Number(row.dataset_count ?? row.datasetCount ?? 0),
    aiConfigCount: Number(row.ai_config_count ?? row.aiConfigCount ?? 0),
    lastLoginAt: row.last_login_at || row.lastLoginAt || "",
    createdAt: user.created_at || "",
    updatedAt: user.updated_at || "",
  };
}

async function listAdminUsers(options = {}) {
  const page = normalizePageNumber(options.page, 1);
  const pageSize = normalizePageSize(options.pageSize, 20, 100);
  const offset = (page - 1) * pageSize;
  const roleFilter = normalizeOptionalEnumFilter(options.role, ["admin", "customer"]);
  const statusFilter = normalizeOptionalEnumFilter(options.status, ["active", "disabled"]);
  const keyword = normalizeOptionalTextFilter(options.keyword, 120);
  if (await isDbAvailable()) {
    const statsResult = await queryDb("select * from user_account_stats_view");
    const filters = [];
    const params = [];
    if (roleFilter) {
      params.push(roleFilter);
      filters.push(`role = $${params.length}`);
    }
    if (statusFilter) {
      params.push(statusFilter);
      filters.push(`status = $${params.length}`);
    }
    if (keyword) {
      params.push(keyword);
      const index = params.length;
      filters.push(`(
        coalesce(name, '') ilike '%' || $${index} || '%'
        or coalesce(phone, '') ilike '%' || $${index} || '%'
        or coalesce(email, '') ilike '%' || $${index} || '%'
        or coalesce(company_name, '') ilike '%' || $${index} || '%'
      )`);
    }
    const whereClause = filters.length ? `where ${filters.join(" and ")}` : "";
    const result = await queryDb(
      `with filtered as (
         select *
         from admin_user_overview_view
         ${whereClause}
       ),
       counted as (
         select count(*)::int as total_count from filtered
       ),
       page_rows as (
         select *
         from filtered
         order by created_at desc
         limit $${params.length + 1} offset $${params.length + 2}
       )
       select page_rows.*, counted.total_count
       from counted
       left join page_rows on true`,
      [...params, pageSize, offset],
    );
    const statsRow = statsResult.rows[0] || {};
    const pageRows = result.rows.filter((row) => row.id);
    return {
      items: pageRows.map(normalizeAdminUserRow),
      total: Number(result.rows[0]?.total_count || 0),
      page,
      pageSize,
      stats: {
        totalUsers: Number(statsRow.total_users || 0),
        adminUsers: Number(statsRow.admin_users || 0),
        customerUsers: Number(statsRow.customer_users || 0),
        disabledUsers: Number(statsRow.disabled_users || 0),
      },
    };
  }

  const data = readLocalData();
  const countByUser = (rows, getUserId) => {
    const counts = new Map();
    for (const row of rows || []) {
      const userId = getUserId(row);
      if (!userId) continue;
      counts.set(userId, (counts.get(userId) || 0) + 1);
    }
    return counts;
  };
  const profilesByUser = new Map();
  for (const profile of data.customerProfiles || []) {
    const userId = profile.userId || profile.user_id;
    if (userId && !profilesByUser.has(userId)) profilesByUser.set(userId, profile);
  }
  const reportCounts = countByUser(data.reviewReports, (item) => item.userId || item.user_id);
  const datasetCounts = countByUser(data.customerDatasets, (item) => item.userId || item.user_id);
  const aiConfigCounts = countByUser(data.aiConfigs, (item) => item.ownerUserId || item.updatedBy || item.owner_user_id || item.updated_by);
  const items = data.users
    .map((user) => {
      const userId = user.id;
      const profile = profilesByUser.get(userId) || {};
      return {
        ...user,
        companyName: profile.companyName || profile.company_name || "",
        reportCount: reportCounts.get(userId) || 0,
        datasetCount: datasetCounts.get(userId) || 0,
        aiConfigCount: aiConfigCounts.get(userId) || 0,
      };
    })
    .filter((item) => !roleFilter || item.role === roleFilter)
    .filter((item) => !statusFilter || item.status === statusFilter)
    .filter((item) => {
      if (!keyword) return true;
      return [item.name, item.phone, item.email, item.companyName].some((value) => includesKeyword(value, keyword));
    })
    .sort((a, b) => String(b.createdAt || b.created_at || "").localeCompare(String(a.createdAt || a.created_at || "")));
  return {
    items: items.slice(offset, offset + pageSize).map(normalizeAdminUserRow),
    total: items.length,
    page,
    pageSize,
    stats: {
      totalUsers: items.length,
      adminUsers: items.filter((item) => item.role === "admin").length,
      customerUsers: items.filter((item) => item.role !== "admin").length,
      disabledUsers: items.filter((item) => item.status !== "active").length,
    },
  };
}

function normalizeAdminUserUpdate(body, current) {
  const next = {
    name: String(body.name ?? current.name ?? "").trim(),
    phone: String(body.phone ?? current.phone ?? "").trim(),
    email: String(body.email ?? current.email ?? "").trim(),
    role: String(body.role ?? current.role ?? "customer").trim(),
    status: String(body.status ?? current.status ?? "active").trim(),
  };
  if (!next.name) {
    const error = new Error("请填写用户姓名。");
    error.statusCode = 400;
    throw error;
  }
  if (!["admin", "customer"].includes(next.role)) {
    const error = new Error("用户角色不正确。");
    error.statusCode = 400;
    throw error;
  }
  if (!["active", "disabled"].includes(next.status)) {
    const error = new Error("用户状态不正确。");
    error.statusCode = 400;
    throw error;
  }
  return next;
}

async function updateAdminUser(adminUser, userId, body) {
  const current = await getUserById(userId);
  if (!current) {
    const error = new Error("用户不存在。");
    error.statusCode = 404;
    throw error;
  }
  const next = normalizeAdminUserUpdate(body, current);
  if (adminUser.id === userId && (next.role !== "admin" || next.status !== "active")) {
    const error = new Error("不能停用或降级当前登录的管理员账号。");
    error.statusCode = 400;
    throw error;
  }

  if (await isDbAvailable()) {
    try {
      const result = await queryDb(
        `update users
         set name = $2,
             phone = nullif($3, ''),
             email = nullif($4, ''),
             role = $5,
             status = $6,
             updated_at = now()
         where id = $1
         returning *`,
        [userId, next.name, next.phone, next.email, next.role, next.status],
      );
      return normalizeAdminUserRow(result.rows[0]);
    } catch (error) {
      if (error.code === "23505") {
        const friendly = new Error("手机号或邮箱已被其他用户使用。");
        friendly.statusCode = 409;
        throw friendly;
      }
      throw error;
    }
  }

  const data = readLocalData();
  const index = data.users.findIndex((user) => user.id === userId);
  if (index < 0) {
    const error = new Error("用户不存在。");
    error.statusCode = 404;
    throw error;
  }
  if (next.phone && data.users.some((user) => user.id !== userId && user.phone === next.phone)) {
    const error = new Error("手机号已被其他用户使用。");
    error.statusCode = 409;
    throw error;
  }
  if (next.email && data.users.some((user) => user.id !== userId && String(user.email || "").toLowerCase() === next.email.toLowerCase())) {
    const error = new Error("邮箱已被其他用户使用。");
    error.statusCode = 409;
    throw error;
  }
  Object.assign(data.users[index], next, { updatedAt: new Date().toISOString() });
  writeLocalData(data);
  return (await listAdminUsers()).find((user) => user.id === userId) || normalizeAdminUserRow(data.users[index]);
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

function aiConfigFromRow(row, source = "self", owner = null) {
  if (!row) return null;
  return {
    apiKey: decryptSecret(row.api_key_encrypted),
    baseUrl: row.base_url,
    model: row.model,
    protocol: row.protocol,
    updatedAt: row.updated_at,
    source,
    ownerUserId: row.owner_user_id || row.updated_by || owner?.id || "",
    ownerName: owner?.name || "",
  };
}

async function findHydeeAdminUser() {
  if (await isDbAvailable()) {
    const result = await queryDb(
      "select * from users where lower(name) = 'hydee' and role = 'admin' and status = 'active' order by created_at asc limit 1",
    );
    return normalizeUserRow(result.rows[0]);
  }
  return normalizeUserRow(readLocalData().users.find((user) => String(user.name || "").toLowerCase() === "hydee" && user.role === "admin" && user.status !== "disabled"));
}

async function loadAiConfigByOwner(userId, source = "self", owner = null) {
  if (!userId) return null;
  if (await isDbAvailable()) {
    const result = await queryDb(
      `select * from ai_configs
       where owner_user_id = $1 or (owner_user_id is null and updated_by = $1)
       order by updated_at desc
       limit 1`,
      [userId],
    );
    return aiConfigFromRow(result.rows[0], source, owner);
  }
  const row = readLocalData().aiConfigs
    .filter((item) => item.ownerUserId === userId || item.updatedBy === userId)
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))[0];
  if (!row) return null;
  return { ...row, source, ownerUserId: userId, ownerName: owner?.name || "" };
}

async function loadOwnAiConfig(user) {
  return loadAiConfigByOwner(user?.id, "self", user);
}

async function loadHydeeFallbackConfig(skipUserId = "") {
  const hydee = await findHydeeAdminUser();
  if (!hydee?.id || hydee.id === skipUserId) return null;
  const config = await loadAiConfigByOwner(hydee.id, "hydee", hydee);
  return config ? { ...config, fallbackUserId: hydee.id, fallbackUserName: hydee.name || "hydee" } : null;
}

async function loadAiConfigForUser(user = null) {
  const own = await loadOwnAiConfig(user);
  if (own?.apiKey && own?.model) return { ...own, source: "self" };

  const fallback = await loadHydeeFallbackConfig(user?.id || "");
  if (fallback?.apiKey && fallback?.model) return fallback;

  const legacy = loadConfig();
  return legacy?.apiKey ? { ...legacy, source: "legacy", ownerName: "hydee" } : legacy;
}

async function loadAiConfig() {
  return loadAiConfigForUser(null);
}

async function saveAiConfig(next, userId) {
  if (await isDbAvailable()) {
    await queryDb(
      "insert into ai_configs(owner_user_id, base_url, model, protocol, api_key_encrypted, updated_by) values($1,$2,$3,$4,$5,$6)",
      [userId || null, next.baseUrl, next.model, next.protocol, encryptSecret(next.apiKey), userId || null],
    );
    return { ...next, source: "self", ownerUserId: userId || "" };
  }
  const data = readLocalData();
  data.aiConfigs.push({
    id: createId("aic"),
    ownerUserId: userId || "",
    updatedBy: userId || "",
    ...next,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  writeLocalData(data);
  return { ...next, source: "self", ownerUserId: userId || "" };
}

function aiConfigSourceLabel(source) {
  if (source === "self") return "当前账号";
  if (source === "hydee") return "hydee管理员兜底";
  if (source === "legacy") return "hydee兜底";
  return "未配置";
}

async function publicConfigStatus(user = null, config = null) {
  const own = await loadOwnAiConfig(user);
  const fallback = await loadHydeeFallbackConfig(user?.id || "");
  const activeConfig = config || (own?.apiKey && own?.model ? own : fallback) || loadConfig();
  const source = config?.source || (own?.apiKey && own?.model ? "self" : fallback?.apiKey && fallback?.model ? "hydee" : activeConfig?.apiKey ? "legacy" : "none");
  return {
    configured: Boolean(activeConfig.apiKey && activeConfig.model),
    adminReady: true,
    hasApiKey: Boolean(activeConfig.apiKey),
    hasOwnConfig: Boolean(own?.apiKey && own?.model),
    fallbackConfigured: Boolean(fallback?.apiKey && fallback?.model),
    source,
    sourceLabel: aiConfigSourceLabel(source),
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

function getClientIp(req) {
  const candidates = [
    req.headers["cf-connecting-ip"],
    req.headers["x-real-ip"],
    String(req.headers["x-forwarded-for"] || "").split(",")[0],
    req.socket?.remoteAddress,
  ];
  for (const value of candidates) {
    let text = String(value || "").trim();
    if (!text) continue;
    if (text.startsWith("::ffff:")) text = text.slice(7);
    if (net.isIP(text)) return text;
  }
  return null;
}

async function recordAuthOperation(req, { userId = null, loginIdentifier = "", operationType = "login", success = false, failureReason = "", metadata = {} }) {
  try {
    if (!(await isDbAvailable())) return null;
    const result = await queryDb(
      "select record_auth_operation($1,$2,$3,$4,$5,$6,$7,$8) as id",
      [
        userId || null,
        String(loginIdentifier || "").slice(0, 200),
        String(operationType || "login").slice(0, 60),
        Boolean(success),
        failureReason ? String(failureReason).slice(0, 500) : null,
        getClientIp(req),
        String(req.headers["user-agent"] || "").slice(0, 500),
        jsonParam(metadata || {}, {}),
      ],
    );
    return result.rows[0]?.id || null;
  } catch (error) {
    console.warn(`Auth operation log skipped: ${error.message}`);
    return null;
  }
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
       values($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb) returning id`,
      [userId, sourceType, filename, jsonParam(rowCounts, {}), jsonParam(sheetStatus, []), jsonParam(metadata, {})],
    );
    const datasetId = result.rows[0].id;
    await queryDb(
      `insert into ai_review_uploads(user_id, dataset_id, source_type, source_name, filename, row_counts_json, status)
       values($1,$2,$3,$4,$5,$6::jsonb,'parsed')`,
      [userId, datasetId, sourceType, summary.source || sourceType, filename, jsonParam(rowCounts, {})],
    );
    return datasetId;
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

async function linkDatasetToReviewReport(datasetId, reportDbId, status = "completed", errorMessage = "") {
  if (!datasetId || !(await isDbAvailable())) return;
  await queryDb(
    `update ai_review_uploads
     set report_db_id = $2, status = $3, error_message = nullif($4, ''), updated_at = now()
     where dataset_id = $1`,
    [datasetId, reportDbId || null, status, errorMessage || ""],
  );
}

function reviewReportDigest(summary, report) {
  return {
    source: summary.source || "",
    generatedAt: summary.generatedAt || new Date().toISOString(),
    rowCounts: summary.rowCounts || {},
    requestInfo: summary.requestInfo || {},
    windows: summary.windows || {},
    sheetStatus: (summary.sheetStatus || []).map((sheet) => ({
      name: sheet.name,
      exists: Boolean(sheet.exists),
      rows: Number(sheet.rows || sheet.rowCount || 0),
    })),
    datasetFiles: (summary.datasetFiles || []).map((file) => ({
      name: file.name,
      label: file.label,
      status: file.status || "",
      rowCount: file.rowCount || 0,
      metricCount: file.metricCount || 0,
      statusText: file.statusText || "",
      note: file.note || "",
    })),
    reportTitle: report?.title || "四季蝉AI复盘报告",
    executiveSummary: report?.executiveSummary || "",
    healthScore: summary.operationInsights?.healthScore ?? null,
    riskLevel: summary.operationInsights?.retentionRisk || "",
  };
}

function numericOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeReviewProgressPercent(value, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(100, Math.round(number)));
}

function pendingReportId() {
  return `pending-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

function reviewStatusLabel(status) {
  return {
    running: "生成中",
    completed: "已完成",
    failed: "生成失败",
    cancelled: "已取消",
  }[status] || status || "未知";
}

function normalizeReviewJobRow(row = {}) {
  return {
    id: row.id || "",
    jobKey: row.job_key || row.jobKey || "",
    reportDbId: row.report_db_id || row.reportDbId || "",
    userId: row.user_id || row.userId || "",
    sourceType: row.source_type || row.sourceType || "",
    sourceName: row.source_name || row.sourceName || "",
    status: row.status || "running",
    progressStage: row.progress_stage || row.progressStage || "",
    progressText: row.progress_text || row.progressText || "",
    progressPercent: normalizeReviewProgressPercent(row.progress_percent ?? row.progressPercent ?? 0, 0),
    cancelRequested: Boolean(row.cancel_requested ?? row.cancelRequested ?? false),
    retryPayloadJson: row.retry_payload_json || row.retryPayloadJson || {},
    errorMessage: row.error_message || row.errorMessage || "",
    startedAt: row.started_at || row.startedAt || "",
    heartbeatAt: row.heartbeat_at || row.heartbeatAt || "",
    finishedAt: row.finished_at || row.finishedAt || "",
    createdAt: row.created_at || row.createdAt || "",
    updatedAt: row.updated_at || row.updatedAt || "",
  };
}

function normalizeReviewJobEventRow(row = {}) {
  return {
    id: row.id || "",
    reviewJobId: row.review_job_id || row.reviewJobId || "",
    reportDbId: row.report_db_id || row.reportDbId || "",
    userId: row.user_id || row.userId || "",
    jobKey: row.job_key || row.jobKey || "",
    eventType: row.event_type || row.eventType || "",
    status: row.status || "",
    progressStage: row.progress_stage || row.progressStage || "",
    progressPercent: normalizeReviewProgressPercent(row.progress_percent ?? row.progressPercent ?? 0, 0),
    message: row.message || "",
    metadata: row.metadata_json || row.metadataJson || {},
    createdAt: row.created_at || row.createdAt || "",
  };
}

function appendLocalReviewJobEvent(data, job = {}, eventType = "progress", message = "", metadata = {}) {
  if (disableLocalDataFallback || !data || !job) return;
  data.reviewJobEvents = Array.isArray(data.reviewJobEvents) ? data.reviewJobEvents : [];
  data.reviewJobEvents.push({
    id: createId("jbe"),
    reviewJobId: job.id || job.reviewJobId || "",
    reportDbId: job.reportDbId || job.report_db_id || "",
    userId: job.userId || job.user_id || "",
    jobKey: job.jobKey || job.job_key || "",
    eventType,
    status: job.status || "",
    progressStage: job.progressStage || job.progress_stage || "",
    progressPercent: normalizeReviewProgressPercent(job.progressPercent ?? job.progress_percent ?? 0, 0),
    message: String(message || job.errorMessage || job.error_message || job.progressText || job.progress_text || reviewStatusLabel(job.status)).slice(0, 2000),
    metadataJson: { localFallback: true, ...metadata },
    createdAt: new Date().toISOString(),
  });
}

async function createReviewJobRecord(meta = {}) {
  const nowIso = new Date().toISOString();
  const record = {
    id: createId("job"),
    jobKey: meta.jobKey || meta.key || "",
    reportDbId: meta.reportDbId || "",
    userId: meta.userId || "",
    sourceType: meta.sourceType || "unknown",
    sourceName: meta.sourceName || "",
    status: "running",
    progressStage: meta.progressStage || "queued",
    progressText: meta.progressText || "任务已创建，等待开始处理。",
    progressPercent: normalizeReviewProgressPercent(meta.progressPercent ?? 2, 2),
    cancelRequested: false,
    retryPayloadJson: meta.retryPayload || {},
    errorMessage: "",
    startedAt: nowIso,
    heartbeatAt: nowIso,
    finishedAt: "",
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  if (await isDbAvailable()) {
    const update = await queryDb(
      `update review_jobs
       set job_key=$2, user_id=$3, source_type=$4, source_name=$5, status='running',
           progress_stage=$6, progress_text=$7, progress_percent=$8,
           cancel_requested=false, retry_payload_json=$9::jsonb, error_message=null,
           started_at=coalesce(started_at, now()), heartbeat_at=now(), finished_at=null, updated_at=now()
       where report_db_id=$1
       returning *`,
      [
        record.reportDbId,
        record.jobKey,
        record.userId || null,
        record.sourceType,
        record.sourceName,
        record.progressStage,
        record.progressText,
        record.progressPercent,
        jsonParam(record.retryPayloadJson, {}),
      ],
    );
    if (update.rows[0]) return normalizeReviewJobRow(update.rows[0]);
    const result = await queryDb(
      `insert into review_jobs(
        job_key, report_db_id, user_id, source_type, source_name, status, progress_stage,
        progress_text, progress_percent, cancel_requested, retry_payload_json, heartbeat_at
      )
       values($1,$2,$3,$4,$5,'running',$6,$7,$8,false,$9::jsonb,now())
       returning *`,
      [
        record.jobKey,
        record.reportDbId || null,
        record.userId || null,
        record.sourceType,
        record.sourceName,
        record.progressStage,
        record.progressText,
        record.progressPercent,
        jsonParam(record.retryPayloadJson, {}),
      ],
    );
    return normalizeReviewJobRow(result.rows[0]);
  }
  const data = readLocalData();
  const existing = data.reviewJobs.find((job) => job.reportDbId === record.reportDbId);
  if (existing) {
    Object.assign(existing, { ...record, id: existing.id, createdAt: existing.createdAt || record.createdAt });
  } else {
    data.reviewJobs.push(record);
  }
  appendLocalReviewJobEvent(data, existing || record, "created", record.progressText, {
    sourceType: record.sourceType,
    sourceName: record.sourceName,
  });
  writeLocalData(data);
  return normalizeReviewJobRow(existing || record);
}

async function updateReviewJobProgress(reportDbId, stage = "", text = "", percent = null) {
  if (!reportDbId) return;
  const nextStage = String(stage || "").trim();
  const nextText = String(text || "").trim();
  const nextPercent = percent === null || percent === undefined ? null : normalizeReviewProgressPercent(percent, 0);
  if (await isDbAvailable()) {
    await queryDb(
      `update review_jobs
       set progress_stage = nullif($2, ''),
           progress_text = nullif($3, ''),
           progress_percent = case
             when $4::int is null then progress_percent
             else greatest(0, least(100, $4::int))
           end,
           heartbeat_at = now(),
           updated_at = now()
       where report_db_id = $1
         and status = 'running'`,
      [reportDbId, nextStage, nextText, nextPercent],
    );
    return;
  }
  const data = readLocalData();
  const job = data.reviewJobs
    .filter((item) => item.reportDbId === reportDbId)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
  if (!job) return;
  const priorStage = job.progressStage || "";
  const priorText = job.progressText || "";
  const priorPercent = job.progressPercent ?? null;
  job.progressStage = nextStage;
  job.progressText = nextText;
  if (nextPercent !== null) job.progressPercent = nextPercent;
  job.heartbeatAt = new Date().toISOString();
  job.updatedAt = new Date().toISOString();
  if (priorStage !== job.progressStage || priorText !== job.progressText || (nextPercent !== null && priorPercent !== job.progressPercent)) {
    appendLocalReviewJobEvent(data, job, "progress", job.progressText || "任务进度已更新。", {
      previousStage: priorStage,
      previousPercent: priorPercent,
    });
  }
  writeLocalData(data);
}

async function markReviewJobStatus(reportDbId, status, errorMessage = "") {
  if (!reportDbId) return;
  const finalText = status === "completed"
    ? "复盘报告已生成。"
    : String(errorMessage || "").trim() || reviewStatusLabel(status);
  if (await isDbAvailable()) {
    await queryDb(
      `update review_jobs
       set status=$2,
           error_message=nullif($3, ''),
           cancel_requested=case
             when $2='cancelled' then true
             when $2 in ('failed','completed') then false
             else cancel_requested
           end,
           heartbeat_at=case when $2='running' then now() else heartbeat_at end,
           progress_stage=case
             when $2 in ('completed','failed','cancelled') then $2
             else progress_stage
           end,
           progress_text=case
             when $2 in ('completed','failed','cancelled') then nullif($4, '')
             else progress_text
           end,
           progress_percent=case
             when $2='completed' then 100
             else progress_percent
           end,
           finished_at=case when $2 in ('failed','cancelled','completed') then now() else finished_at end,
           updated_at=now()
       where report_db_id=$1`,
      [reportDbId, status, String(errorMessage || "").slice(0, 2000), finalText],
    );
    return;
  }
  const data = readLocalData();
  const jobs = data.reviewJobs.filter((item) => item.reportDbId === reportDbId);
  if (!jobs.length) return;
  const nowIso = new Date().toISOString();
  for (const job of jobs) {
    const previousStatus = job.status || "";
    const previousCancelRequested = Boolean(job.cancelRequested);
    job.status = status;
    job.errorMessage = errorMessage || "";
    job.cancelRequested = status === "cancelled" ? true : ["failed", "completed"].includes(status) ? false : job.cancelRequested;
    if (["completed", "failed", "cancelled"].includes(status)) {
      job.progressStage = status;
      job.progressText = finalText;
      job.finishedAt = nowIso;
    }
    if (status === "completed") job.progressPercent = 100;
    if (status === "running") job.heartbeatAt = nowIso;
    job.updatedAt = nowIso;
    if (status === "cancelled" && !previousCancelRequested) {
      appendLocalReviewJobEvent(data, job, "cancel_requested", finalText, { previousStatus });
    }
    if (previousStatus !== status) {
      appendLocalReviewJobEvent(data, job, "status_changed", finalText, { previousStatus });
    }
  }
  writeLocalData(data);
}

async function createRunningReviewReportRecord(userId, sourceType, sourceName, jobKey, retryPayload = {}) {
  const profile = await getCustomerProfile(userId);
  const reportTitle = `${sourceName || "AI复盘报告"}生成中`;
  const initialStage = "queued";
  const initialText = "任务已创建，等待开始处理。";
  const initialPercent = 2;
  if (await isDbAvailable()) {
    const recent = await queryDb(
      `select id from review_reports
       where user_id=$1
         and source_type=$2
         and status = 'running'
         and coalesce(job_key, '')=$3
         and created_at > now() - interval '2 minutes'
       order by created_at desc
       limit 1`,
      [userId, sourceType, jobKey],
    );
    if (recent.rows[0]?.id) return recent.rows[0].id;
    const result = await queryDb(
      `insert into review_reports(
        user_id, customer_profile_id, source_type, source_name, status, report_title, row_counts_json,
        summary_json, report_json, markdown, report_id, job_key, cancel_requested, heartbeat_at,
        progress_stage, progress_text, progress_percent, retry_payload_json, started_at
      )
       values($1,$2,$3,$4,'running',$5,'{}'::jsonb,'{}'::jsonb,$6::jsonb,'',$7,$8,false,now(),$9,$10,$11,$12::jsonb,now())
       returning id`,
      [
        userId,
        profile?.id || null,
        sourceType,
        sourceName,
        reportTitle,
        jsonParam({ title: reportTitle, status: "running" }, {}),
        pendingReportId(),
        jobKey,
        initialStage,
        initialText,
        initialPercent,
        jsonParam(retryPayload, {}),
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
    status: "running",
    reportTitle,
    rowCountsJson: {},
    reportId: pendingReportId(),
    jobKey,
    cancelRequested: false,
    heartbeatAt: new Date().toISOString(),
    progressStage: initialStage,
    progressText: initialText,
    progressPercent: initialPercent,
    retryPayloadJson: retryPayload || {},
    errorMessage: "",
    startedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  data.reviewReports.push(record);
  writeLocalData(data);
  saveLocalReviewPayload(record.id, {
    summaryJson: {},
    reportJson: { title: reportTitle, status: "running" },
    markdown: "",
  });
  return record.id;
}

async function updateReviewReportProgress(reportDbId, stage = "", text = "", percent = null) {
  if (!reportDbId) return;
  const nextStage = String(stage || "").trim();
  const nextText = String(text || "").trim();
  const nextPercent = percent === null || percent === undefined ? null : normalizeReviewProgressPercent(percent, 0);
  if (await isDbAvailable()) {
    await queryDb(
      `update review_reports
       set progress_stage = nullif($2, ''),
           progress_text = nullif($3, ''),
           progress_percent = case
             when $4::int is null then progress_percent
             else greatest(0, least(100, $4::int))
           end,
           heartbeat_at = now(),
           updated_at = now()
       where id = $1`,
      [reportDbId, nextStage, nextText, nextPercent],
    );
    await updateReviewJobProgress(reportDbId, nextStage, nextText, nextPercent).catch(() => null);
    return;
  }
  const data = readLocalData();
  const record = data.reviewReports.find((item) => item.id === reportDbId);
  if (!record) return;
  record.progressStage = nextStage;
  record.progressText = nextText;
  if (nextPercent !== null) record.progressPercent = nextPercent;
  record.heartbeatAt = new Date().toISOString();
  record.updatedAt = new Date().toISOString();
  writeLocalData(data);
  await updateReviewJobProgress(reportDbId, nextStage, nextText, nextPercent).catch(() => null);
}

async function markReviewReportStatus(reportDbId, status, errorMessage = "") {
  if (!reportDbId) return;
  const finalProgress = status === "completed" ? 100 : null;
  const finalText = status === "completed"
    ? "复盘报告已生成。"
    : String(errorMessage || "").trim() || reviewStatusLabel(status);
  if (await isDbAvailable()) {
    await queryDb(
      `update review_reports
       set status=$2, error_message=nullif($3, ''), report_title=case
             when $2='failed' then '复盘报告生成失败'
             when $2='cancelled' then '复盘报告已取消'
             else report_title
           end,
           cancel_requested=case
             when $2='cancelled' then true
             when $2 in ('failed','completed') then false
             else cancel_requested
           end,
           heartbeat_at=case when $2='running' then now() else heartbeat_at end,
           progress_stage=case
             when $2='completed' then 'completed'
             when $2='failed' then 'failed'
             when $2='cancelled' then 'cancelled'
             else progress_stage
           end,
           progress_text=case
             when $2 in ('completed','failed','cancelled') then nullif($4, '')
             else progress_text
           end,
           progress_percent=case
             when $2='completed' then 100
             else progress_percent
           end,
           finished_at=case when $2 in ('failed','cancelled','completed') then now() else finished_at end,
           updated_at=now()
       where id=$1`,
      [reportDbId, status, String(errorMessage || "").slice(0, 2000), finalText],
    );
    await markReviewJobStatus(reportDbId, status, errorMessage).catch(() => null);
    return;
  }
  const data = readLocalData();
  const record = data.reviewReports.find((item) => item.id === reportDbId);
  if (!record) return;
  record.status = status;
  record.errorMessage = errorMessage || "";
  record.reportTitle = status === "failed" ? "复盘报告生成失败" : status === "cancelled" ? "复盘报告已取消" : record.reportTitle;
  record.cancelRequested = status === "cancelled" ? true : ["failed", "completed"].includes(status) ? false : record.cancelRequested;
  record.progressStage = ["completed", "failed", "cancelled"].includes(status) ? status : record.progressStage;
  record.progressText = finalText;
  if (finalProgress !== null) record.progressPercent = finalProgress;
  record.finishedAt = ["failed", "cancelled", "completed"].includes(status) ? new Date().toISOString() : record.finishedAt;
  record.updatedAt = new Date().toISOString();
  writeLocalData(data);
  await markReviewJobStatus(reportDbId, status, errorMessage).catch(() => null);
  const payload = getLocalReviewPayload(reportDbId) || {};
  saveLocalReviewPayload(reportDbId, {
    ...payload,
    reportJson: {
      ...(payload.reportJson || {}),
      title: record.reportTitle || payload.reportJson?.title || "四季蝉AI复盘报告",
      status,
    },
  });
}

async function saveReviewReportRecord(userId, sourceType, sourceName, summary, generated, options = {}) {
  const profile = await getCustomerProfile(userId);
  const excelStatus = String(generated.excelStatus || (generated.excelUrl ? "ready" : "") || "").trim();
  const excelError = String(generated.excelError || "").trim();
  if (await isDbAvailable()) {
    const activePool = await getPool();
    await ensureDatabase();
    const client = await activePool.connect();
    const digest = reviewReportDigest(summary, generated.report);
    const reportTitle = generated.report?.title || digest.reportTitle || "四季蝉AI复盘报告";
    try {
      await client.query("begin");
      let id = options.reportDbId || "";
      if (id) {
        const result = await client.query(
          `update review_reports
           set customer_profile_id=$2, source_type=$3, source_name=$4, status='completed', report_title=$5,
               row_counts_json=$6::jsonb, health_score=$7, risk_level=$8, summary_json=$9::jsonb,
               report_json=$10::jsonb, markdown='', report_id=$11, share_url=$12, svg_url=$13,
               qr_svg_url=$14, excel_url=$15, excel_status=coalesce(nullif($16, ''), excel_status),
               excel_error=nullif($17, ''), normalized_data_url=$18, diagnostics_url=$19,
               error_message=null, cancel_requested=false, heartbeat_at=now(), progress_stage='completed',
               progress_text='复盘报告已生成。', progress_percent=100, finished_at=now(), updated_at=now()
           where id=$1 and user_id=$20
           returning id`,
          [
            id,
            profile?.id || null,
            sourceType,
            sourceName,
            reportTitle,
            jsonParam(summary.rowCounts || {}, {}),
            numericOrNull(summary.operationInsights?.healthScore),
            summary.operationInsights?.retentionRisk || "",
            jsonParam(digest, {}),
            jsonParam({ title: reportTitle, executiveSummary: generated.report?.executiveSummary || "" }, {}),
            generated.reportId,
            generated.shareUrl,
            generated.svgUrl,
            generated.qrSvgUrl,
            generated.excelUrl || "",
            excelStatus,
            excelError,
            generated.normalizedDataUrl || "",
            generated.diagnosticsUrl || "",
            userId,
          ],
        );
        id = result.rows[0]?.id || "";
      }
      if (!id) {
        const result = await client.query(
          `insert into review_reports(
            user_id, customer_profile_id, source_type, source_name, status, report_title, row_counts_json, health_score, risk_level,
            summary_json, report_json, markdown, report_id, share_url, svg_url, qr_svg_url, excel_url, excel_status, excel_error, normalized_data_url, diagnostics_url,
            job_key, progress_stage, progress_text, progress_percent, finished_at
          )
           values($1,$2,$3,$4,'completed',$5,$6::jsonb,$7,$8,$9::jsonb,$10::jsonb,'',$11,$12,$13,$14,$15,coalesce(nullif($16, ''), case when coalesce($15, '') <> '' then 'ready' else '' end),nullif($17, ''),$18,$19,$20,'completed','复盘报告已生成。',100,now())
           returning id`,
          [
            userId,
            profile?.id || null,
            sourceType,
            sourceName,
            reportTitle,
            jsonParam(summary.rowCounts || {}, {}),
            numericOrNull(summary.operationInsights?.healthScore),
            summary.operationInsights?.retentionRisk || "",
            jsonParam(digest, {}),
            jsonParam({ title: reportTitle, executiveSummary: generated.report?.executiveSummary || "" }, {}),
            generated.reportId,
            generated.shareUrl,
            generated.svgUrl,
            generated.qrSvgUrl,
            generated.excelUrl || "",
            excelStatus,
            excelError,
            generated.normalizedDataUrl || "",
            generated.diagnosticsUrl || "",
            options.jobKey || null,
          ],
        );
        id = result.rows[0].id;
      }
      await client.query(
        `insert into review_report_payloads(report_db_id, summary_json, report_json, markdown)
         values($1,$2::jsonb,$3::jsonb,$4)
         on conflict(report_db_id) do update set summary_json=excluded.summary_json, report_json=excluded.report_json, markdown=excluded.markdown, updated_at=now()`,
        [id, jsonParam(summary, {}), jsonParam(generated.report, {}), generated.markdown || ""],
      );
      await client.query("commit");
      await markReviewJobStatus(id, "completed").catch(() => null);
      return id;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
  const data = readLocalData();
  const record = {
    id: options.reportDbId || createId("rep"),
    userId,
    customerProfileId: profile?.id || "",
    sourceType,
    sourceName,
    status: "completed",
    rowCountsJson: summary.rowCounts || {},
    healthScore: numericOrNull(summary.operationInsights?.healthScore),
    riskLevel: summary.operationInsights?.retentionRisk || "",
    reportId: generated.reportId,
    reportTitle: generated.report?.title || "四季蝉AI复盘报告",
    shareUrl: generated.shareUrl,
    svgUrl: generated.svgUrl,
    qrSvgUrl: generated.qrSvgUrl,
    excelUrl: generated.excelUrl,
    excelStatus: excelStatus || (generated.excelUrl ? "ready" : ""),
    excelError,
    normalizedDataUrl: generated.normalizedDataUrl,
    diagnosticsUrl: generated.diagnosticsUrl,
    jobKey: options.jobKey || "",
    progressStage: "completed",
    progressText: "复盘报告已生成。",
    progressPercent: 100,
    errorMessage: "",
    finishedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const existingIndex = data.reviewReports.findIndex((item) => item.id === record.id);
  if (existingIndex >= 0) {
    data.reviewReports[existingIndex] = { ...data.reviewReports[existingIndex], ...record, createdAt: data.reviewReports[existingIndex].createdAt || record.createdAt };
  } else {
    data.reviewReports.push(record);
  }
  writeLocalData(data);
  saveLocalReviewPayload(record.id, {
    summaryJson: summary,
    reportJson: generated.report,
    markdown: generated.markdown || "",
  });
  await markReviewJobStatus(record.id, "completed").catch(() => null);
  return record.id;
}

async function upsertSijichanAuthorization(userId, body, summary, reportDbId = "") {
  if (!(await isDbAvailable())) return null;
  const username = String(body.username || "").trim();
  const password = String(body.password || "");
  if (!userId || !username || !password) return null;
  const requestInfo = summary?.requestInfo || {};
  const merCode = String(body.merCode || requestInfo.merCode || "").trim();
  const merName = String(body.merName || requestInfo.merName || "").trim();
  const result = await queryDb(
    `insert into sijichan_account_authorizations(user_id, username, password_encrypted, mer_name, mer_code, status, last_report_db_id, last_success_at, last_error)
     values($1,$2,$3,$4,$5,'active',$6,now(),null)
     on conflict(user_id, username, mer_code)
     do update set
       password_encrypted = excluded.password_encrypted,
       mer_name = coalesce(nullif(excluded.mer_name, ''), sijichan_account_authorizations.mer_name),
       status = 'active',
       last_report_db_id = excluded.last_report_db_id,
       last_success_at = now(),
       last_error = null,
       updated_at = now()
     returning id`,
    [userId, username, encryptSecret(password), merName, merCode, reportDbId || null],
  );
  return result.rows[0]?.id || null;
}

async function upsertSijichanTokenAuthorization(userId, body, summary, reportDbId = "") {
  if (!(await isDbAvailable())) return null;
  const token = normalizeSijichanToken(body.token || body.authorization || "");
  if (!userId || !token) return null;
  const requestInfo = summary?.requestInfo || {};
  const merCode = String(body.merCode || requestInfo.merCode || "").trim();
  const merName = String(body.merName || requestInfo.merName || "").trim();
  const tokenFingerprint = crypto.createHash("sha256").update(token).digest("hex").slice(0, 12);
  const username = String(body.username || body.account || `wecom_token_${tokenFingerprint}`).trim();
  const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
  const result = await queryDb(
    `insert into sijichan_account_authorizations(user_id, username, password_encrypted, auth_type, token_encrypted, token_expires_at, mer_name, mer_code, status, last_report_db_id, last_success_at, last_error)
     values($1,$2,'','token',$3,$4,$5,$6,'active',$7,now(),null)
     on conflict(user_id, username, mer_code)
     do update set
       auth_type = 'token',
       token_encrypted = excluded.token_encrypted,
       token_expires_at = excluded.token_expires_at,
       mer_name = coalesce(nullif(excluded.mer_name, ''), sijichan_account_authorizations.mer_name),
       status = 'active',
       last_report_db_id = excluded.last_report_db_id,
       last_success_at = now(),
       last_error = null,
       updated_at = now()
     returning id`,
    [userId, username, encryptSecret(token), expiresAt && !Number.isNaN(expiresAt.getTime()) ? expiresAt.toISOString() : null, merName, merCode, reportDbId || null],
  );
  return result.rows[0]?.id || null;
}

function normalizeSijichanAuthorizationRow(row) {
  return {
    id: row.id,
    userId: row.user_id,
    username: row.username,
    password: row.password_encrypted ? decryptSecret(row.password_encrypted) : "",
    authType: row.auth_type || "password",
    token: row.token_encrypted ? decryptSecret(row.token_encrypted) : "",
    tokenExpiresAt: row.token_expires_at || null,
    merName: row.mer_name || "",
    merCode: row.mer_code || "",
    status: row.status || "active",
    lastReportDbId: row.last_report_db_id || "",
    lastSuccessAt: row.last_success_at || null,
    lastError: row.last_error || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function listSijichanAuthorizations(scopeUser = null) {
  if (!(await isDbAvailable())) return [];
  const params = [];
  let where = "where status = 'active'";
  if (scopeUser?.role !== "admin") {
    params.push(scopeUser?.id || "");
    where += ` and user_id = $${params.length}`;
  }
  const result = await queryDb(
    `select * from sijichan_account_authorizations ${where} order by coalesce(last_success_at, updated_at) desc limit 200`,
    params,
  );
  return result.rows.map(normalizeSijichanAuthorizationRow);
}

async function createSijichanTokenHandoff(user, body = {}) {
  if (!(await isDbAvailable())) throw new Error("数据库未连接，暂不能创建企微授权交接会话。");
  const id = createId("whf");
  const merCode = String(body.merCode || "").trim();
  const merName = String(body.merName || "").trim();
  const ttlMs = Math.max(5 * 60 * 1000, Math.min(Number(body.ttlMs || 30 * 60 * 1000), 12 * 60 * 60 * 1000));
  const expiresAt = new Date(Date.now() + ttlMs);
  await queryDb(
    `insert into sijichan_token_handoffs(id, user_id, mer_name, mer_code, status, expires_at)
     values($1,$2,$3,$4,'pending',$5)`,
    [id, user.id, merName, merCode, expiresAt.toISOString()],
  );
  const handoffToken = signHandoff({ id, userId: user.id, exp: expiresAt.getTime() });
  return { id, handoffToken, merCode, merName, expiresAt: expiresAt.toISOString() };
}

function normalizeSijichanTokenHandoff(row, includeToken = false) {
  return {
    id: row.id,
    userId: row.user_id,
    merName: row.mer_name || "",
    merCode: row.mer_code || "",
    status: row.status || "pending",
    captured: Boolean(row.token_encrypted),
    token: includeToken && row.token_encrypted ? decryptSecret(row.token_encrypted) : "",
    tokenExpiresAt: row.token_expires_at || null,
    capturedAt: row.captured_at || null,
    usedAt: row.used_at || null,
    lastError: row.last_error || "",
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function getSijichanTokenHandoffForUser(user, id, includeToken = false) {
  if (!(await isDbAvailable())) return null;
  const params = [id];
  let where = "where id = $1";
  if (user.role !== "admin") {
    params.push(user.id);
    where += ` and user_id = $${params.length}`;
  }
  const result = await queryDb(`select * from sijichan_token_handoffs ${where} limit 1`, params);
  return result.rows[0] ? normalizeSijichanTokenHandoff(result.rows[0], includeToken) : null;
}

async function findRecentSijichanMerInfoForUser(userId) {
  if (!userId || !(await isDbAvailable())) return null;
  const result = await queryDb(
    `select mer_code, mer_name
     from sijichan_token_handoffs
     where user_id=$1 and coalesce(mer_code,'') <> ''
     order by created_at desc
     limit 1`,
    [userId],
  ).catch(() => ({ rows: [] }));
  const row = result.rows[0];
  return row ? { merCode: row.mer_code || "", merName: row.mer_name || "" } : null;
}

async function captureSijichanTokenHandoff(handoffToken, token, details = {}) {
  const payload = verifyHandoffToken(handoffToken);
  if (!payload?.id || !payload?.userId) throw new Error("企微授权交接码无效或已过期。");
  const normalizedToken = assertSijichanTokenFormat(token);
  if (!(await isDbAvailable())) throw new Error("数据库未连接，无法保存企微授权token。");
  const existing = await queryDb(
    "select mer_code from sijichan_token_handoffs where id=$1 and user_id=$2 limit 1",
    [payload.id, payload.userId],
  ).catch(() => ({ rows: [] }));
  const validation = await validateSijichanTokenCandidate(normalizedToken, existing.rows[0]?.mer_code || "");
  if (!validation.ok) {
    throw new Error(`授权token验证失败：HTTP ${validation.status || "-"}${validation.code ? ` / ${validation.code}` : ""}${validation.message ? ` / ${validation.message}` : ""}`);
  }
  const tokenExpiresAt = details.expiresAt ? new Date(details.expiresAt) : null;
  const result = await queryDb(
    `update sijichan_token_handoffs
     set status='captured',
         token_encrypted=$3,
         token_expires_at=$4,
         captured_at=now(),
         last_error=null,
         updated_at=now()
     where id=$1 and user_id=$2 and expires_at > now()
     returning *`,
    [payload.id, payload.userId, encryptSecret(normalizedToken), tokenExpiresAt && !Number.isNaN(tokenExpiresAt.getTime()) ? tokenExpiresAt.toISOString() : null],
  );
  if (!result.rows[0]) throw new Error("企微授权交接会话不存在或已过期。");
  const handoff = normalizeSijichanTokenHandoff(result.rows[0], true);
  if (!handoff.merCode) {
    const recent = await findRecentSijichanMerInfoForUser(payload.userId);
    if (recent?.merCode) {
      handoff.merCode = recent.merCode;
      handoff.merName = handoff.merName || recent.merName || "";
    }
  }
  triggerWeComTokenAutoReport(payload.userId, handoff, normalizedToken, details.from || "handoff-capture");
  return normalizeSijichanTokenHandoff(result.rows[0]);
}

async function markSijichanHandoffError(handoffToken, message) {
  const payload = verifyHandoffToken(handoffToken);
  if (!payload?.id || !(await isDbAvailable())) return;
  await queryDb(
    "update sijichan_token_handoffs set last_error=$2, updated_at=now() where id=$1",
    [payload.id, String(message || "").slice(0, 1000)],
  ).catch(() => null);
}

async function exchangeWeComCodeForSijichanToken({ code, handoffId = "", state = "" } = {}) {
  if (!code) return { token: "", diagnostics: ["missing_code"] };
  const jumpUrl = `${sijichanApiOrigin}/app-jump/super-admin-login?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state || "WWLogin")}${handoffId ? `&handoffId=${encodeURIComponent(handoffId)}` : ""}`;
  const diagnostics = [`GET ${jumpUrl.replace(code, "[code]")}`];
  let response;
  try {
    response = await fetch(jumpUrl, {
      method: "GET",
      redirect: "manual",
      headers: {
        "user-agent": "Mozilla/5.0 SOP_4CHAN token handoff",
        accept: "text/html,application/json,*/*",
      },
    });
  } catch (error) {
    return { token: "", diagnostics: [...diagnostics, `request_failed:${networkErrorMessage(error)}`] };
  }
  const location = response.headers.get("location") || "";
  const setCookie = response.headers.get("set-cookie") || "";
  const text = await response.text().catch(() => "");
  const token = extractSijichanTokenFromText([location, setCookie, text].join("\n"));
  diagnostics.push(`status:${response.status}`);
  if (location) diagnostics.push(`location:${location.slice(0, 300)}`);
  diagnostics.push(token ? "candidate_token_extracted_unverified" : "token_not_found");
  return { token, diagnostics };
}

function monthKeyFromDate(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
}

function monthWindowFromKey(monthKey = "") {
  const match = String(monthKey || "").match(/^(\d{4})-(\d{2})$/);
  const now = new Date();
  const year = match ? Number(match[1]) : now.getFullYear();
  const monthIndex = match ? Number(match[2]) - 1 : now.getMonth();
  return { key: `${year}-${pad2(monthIndex + 1)}`, ...monthWindow(new Date(year, monthIndex, 1)) };
}

function genericTopRows(rows, metrics, labelFields, limit = 8, desc = true) {
  return topGenericRows(rows, metrics, labelFields, limit, desc);
}

function marketingValue(row, fields) {
  return fields.reduce((total, field) => total + toNumber(row[field]), 0);
}

function buildMarketingRecommendationSummary(raw) {
  const activityRows = withDataMeta(rowsFromPaged(raw.activitySummary.rows), "activity_summary.json", "currentMonth.rows");
  const activityCatalogRows = withDataMeta(rowsFromPaged(raw.activityCatalog.joined), "activity_catalog.json", "joined");
  const labelFields = [
    { name: "活动名称", candidates: ["activityName", "marketActivityName", "name", "活动名称"] },
    { name: "商品名称", candidates: ["commodityName", "productName", "goodsName", "skuName", "商品名称"] },
    { name: "商品编码", candidates: ["commodityCode", "wareIspCode", "productCode", "goodsCode", "商品编码"] },
  ];
  const saleFields = ["rewardSaleAmount", "saleCommodityAmount", "activitySaleAmount", "saleAmount", "salesAmount", "销售额"];
  const rewardFields = ["rewardCommodityAmount", "singleRewardMoney", "rewardAmount", "奖励金额"];
  const zeroOrWeakRows = activityRows
    .filter((row) => marketingValue(row, [...saleFields, ...rewardFields]) <= 0)
    .slice(0, 12);
  const uniqueProductCount = new Set(activityRows.map((row) => pickField(row, ["commodityCode", "wareIspCode", "productCode", "goodsCode", "商品编码"])).filter(hasValue)).size;
  return {
    source: "月初登录获取",
    monthKey: raw.meta.monthKey,
    monthRange: raw.meta.monthRange,
    customerName: raw.meta.merName || raw.meta.username || "",
    customerCode: raw.meta.merCode || "",
    generatedAt: raw.meta.generatedAt,
    rowCounts: {
      activityCatalog: activityCatalogRows.length,
      activityProducts: activityRows.length,
    },
    activityCatalog: {
      totalCount: activityCatalogRows.length,
      onlineCount: activityCatalogRows.filter((row) => [1, 3, 62, "1", "3", "62"].includes(row.status)).length,
      topActivities: genericTopRows(activityCatalogRows, saleFields, labelFields, 8, true),
    },
    activityProducts: {
      skuCount: uniqueProductCount || activityRows.length,
      topSales: genericTopRows(activityRows, saleFields, labelFields, 10, true),
      topRewards: genericTopRows(activityRows, rewardFields, labelFields, 10, true),
      weakItems: zeroOrWeakRows.map((row) => ({
        活动名称: pickField(row, ["activityName", "marketActivityName", "活动名称"]),
        商品名称: pickField(row, ["commodityName", "productName", "goodsName", "skuName", "商品名称"]),
        商品编码: pickField(row, ["commodityCode", "wareIspCode", "productCode", "goodsCode", "商品编码"]),
      })),
    },
    diagnostics: raw.diagnostics || [],
  };
}

function buildDeterministicMarketingRecommendation(summary) {
  const monthLabel = summary.monthKey ? `${Number(summary.monthKey.slice(5, 7))}月` : "当月";
  const topSales = summary.activityProducts?.topSales || [];
  const topRewards = summary.activityProducts?.topRewards || [];
  const weakItems = summary.activityProducts?.weakItems || [];
  const focusProducts = [...topSales, ...topRewards]
    .map((row) => row["商品名称"] || row["活动名称"] || "")
    .filter(Boolean)
    .filter((value, index, arr) => arr.indexOf(value) === index)
    .slice(0, 12);
  const actions = [
    focusProducts.length ? `围绕 ${focusProducts.slice(0, 6).join("、")} 做${monthLabel}重点品任务池，优先配置单品突破和排行榜。` : "先补齐当月活动商品明细，确认可激励、可陈列、可复盘的重点品。",
    topRewards.length ? "把奖励金额靠前的商品沉淀为店员重点讲解清单，配套卖点培训和考试奖励。" : "补充奖励政策，让店员能清楚看到卖什么、怎么卖、卖了赚多少。",
    weakItems.length ? `对 ${weakItems.slice(0, 5).map((row) => row["商品名称"] || row["活动名称"]).filter(Boolean).join("、")} 等弱动销品做下架、换品或重新包装。` : "保持活动商品复盘节奏，每周看销量、奖励、提现闭环。",
  ];
  return {
    title: `${summary.customerName || "客户"}${monthLabel}营销推荐`,
    executiveSummary: `本次月初自动读取活动列表 ${summary.rowCounts.activityCatalog} 条、活动商品明细 ${summary.rowCounts.activityProducts} 条，形成${monthLabel}重点品动销建议。`,
    focusProducts,
    sections: [
      { heading: "重点活动商品", bullets: topSales.slice(0, 8).map((row) => `${row["商品名称"] || row["活动名称"] || "重点商品"}：优先查看销售和奖励闭环。`) },
      { heading: "激励优先级", bullets: topRewards.slice(0, 8).map((row) => `${row["商品名称"] || row["活动名称"] || "激励商品"}：适合做店员任务和排行榜。`) },
      { heading: "需要复盘的弱项", bullets: weakItems.slice(0, 8).map((row) => `${row["商品名称"] || row["活动名称"] || "未命名商品"}：当前动销/奖励信号弱，建议复核活动政策。`) },
    ],
    nextActions: actions,
  };
}

function marketingRecommendationMarkdown(recommendation) {
  const lines = [`# ${recommendation.title}`, "", recommendation.executiveSummary || ""];
  for (const section of recommendation.sections || []) {
    lines.push("", `## ${section.heading}`, ...(section.bullets || []).map((item) => `- ${item}`));
  }
  if (recommendation.nextActions?.length) lines.push("", "## 下一步动作", ...recommendation.nextActions.map((item) => `- ${item}`));
  return lines.join("\n");
}

async function collectMonthlyMarketingData(auth, monthKey = monthKeyFromDate()) {
  const isTokenAuth = auth.authType === "token";
  if (isTokenAuth && auth.tokenExpiresAt && new Date(auth.tokenExpiresAt).getTime() <= Date.now()) {
    throw new Error("企微扫码授权token已过期，请重新扫码获取授权。");
  }
  const login = isTokenAuth ? null : await sijichanLogin({ username: auth.username, password: auth.password });
  const token = isTokenAuth ? auth.token : login.token;
  const merCode = String(auth.merCode || "").trim();
  const diagnostics = [];
  const client = createSijichanClient(token, merCode, diagnostics);
  const window = monthWindowFromKey(monthKey);
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
  const activityBody = { timeType: 1, startTime: window.start, endTime: window.end, summaryType: 1 };
  return {
    meta: {
      source: "当月营销推荐",
      monthKey: window.key,
      monthRange: { start: window.start, end: window.end },
      username: auth.username,
      merCode,
      merName: auth.merName || login?.merName || "",
      generatedAt: new Date().toISOString(),
    },
    activityCatalog: {
      joined: await client.paged("我的活动列表-当月推荐", "industryMarket/queryAlreadyActivity", activityCatalogBody),
    },
    activitySummary: {
      rows: await client.paged("活动商品明细-当月推荐", "imActivityReward/summary/page", activityBody),
      sum: await client.post("活动商品合计-当月推荐", "imActivityReward/summary/sum", activityBody),
    },
    diagnostics,
  };
}

async function saveMonthlyMarketingRecommendation(auth, summary, recommendation, status = "completed", errorMessage = "") {
  if (!(await isDbAvailable())) return null;
  const markdown = marketingRecommendationMarkdown(recommendation);
  const result = await queryDb(
    `insert into monthly_marketing_recommendations(
       month_key, auth_id, user_id, customer_name, customer_code, status, activity_count, product_count,
       summary_json, recommendation_json, markdown, error_message, generated_at
     )
     values($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12,now())
     on conflict(month_key, auth_id)
     do update set
       customer_name=excluded.customer_name,
       customer_code=excluded.customer_code,
       status=excluded.status,
       activity_count=excluded.activity_count,
       product_count=excluded.product_count,
       summary_json=excluded.summary_json,
       recommendation_json=excluded.recommendation_json,
       markdown=excluded.markdown,
       error_message=excluded.error_message,
       generated_at=now(),
       updated_at=now()
     returning *`,
    [
      summary.monthKey,
      auth.id,
      auth.userId || null,
      summary.customerName || auth.merName || auth.username,
      summary.customerCode || auth.merCode || "",
      status,
      summary.rowCounts?.activityCatalog || 0,
      summary.rowCounts?.activityProducts || 0,
      jsonParam(summary, {}),
      jsonParam(recommendation, {}),
      markdown,
      errorMessage || "",
    ],
  );
  return result.rows[0];
}

function normalizeMonthlyMarketingRow(row) {
  return {
    id: row.id,
    monthKey: row.month_key,
    customerName: row.customer_name || "",
    customerCode: row.customer_code || "",
    status: row.status,
    activityCount: Number(row.activity_count || 0),
    productCount: Number(row.product_count || 0),
    summary: row.summary_json || {},
    recommendation: row.recommendation_json || {},
    markdown: row.markdown || "",
    errorMessage: row.error_message || "",
    generatedAt: row.generated_at || row.created_at,
  };
}

function normalizeMonthlyMarketingListRow(row) {
  return {
    id: row.id,
    monthKey: row.month_key,
    customerName: row.customer_name || "",
    customerCode: row.customer_code || "",
    status: row.status,
    activityCount: Number(row.activity_count || 0),
    productCount: Number(row.product_count || 0),
    focusProducts: Array.isArray(row.focus_products_json) ? row.focus_products_json : [],
    nextActions: Array.isArray(row.next_actions_json) ? row.next_actions_json : [],
    errorMessage: row.error_message || "",
    generatedAt: row.generated_at || row.created_at,
  };
}

function uniqText(values, limit = 12) {
  return (values || [])
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .filter((value, index, arr) => arr.indexOf(value) === index)
    .slice(0, limit);
}

function normalizeTextArray(values, limit = 20) {
  return uniqText(Array.isArray(values) ? values : [], limit);
}

function anonymizedMarketingCard(index, sourceItems, monthKey) {
  const monthLabel = monthKey ? `${Number(monthKey.slice(5, 7))}月` : "当月";
  const allFocus = uniqText(sourceItems.flatMap((item) => item.focusProducts || item.recommendation?.focusProducts || []), 14);
  const allActions = uniqText(sourceItems.flatMap((item) => item.nextActions || item.recommendation?.nextActions || []), 8);
  const totalActivity = sourceItems.reduce((sum, item) => sum + Number(item.activityCount || 0), 0);
  const totalProduct = sourceItems.reduce((sum, item) => sum + Number(item.productCount || 0), 0);
  const title = index === 0 ? `${monthLabel}重点品动销组合` : `${monthLabel}激励玩法建议`;
  const fallbackAction = index === 0
    ? "优先选择活动数据里同时具备销售、奖励和门店覆盖信号的品种，做单品突破与排行榜。"
    : "把奖励靠前的商品沉淀为店员卖点清单，配套培训考试、陈列晒单和周复盘。";
  return {
    id: `anonymized-${monthKey || "current"}-${index + 1}`,
    title,
    summary: "",
    products: index === 0 ? allFocus.slice(0, 10) : allFocus.slice(4, 14),
    actions: allActions.slice(index * 3, index * 3 + 3).length ? allActions.slice(index * 3, index * 3 + 3) : [fallbackAction],
    tags: index === 0 ? ["合并分析", "重点品", "动销任务"] : ["激励策略", "培训承接", "周复盘"],
  };
}

function redactMarketingText(value, rows = []) {
  let text = String(value || "");
  const sensitive = uniqText(
    rows.flatMap((item) => [
      item.customerName,
      item.customerCode,
      item.summary?.customerName,
      item.summary?.customerCode,
    ]),
    100,
  ).filter((item) => item.length >= 2);
  for (const word of sensitive) {
    text = text.split(word).join("客户数据");
  }
  return text;
}

function redactMarketingCard(card, rows) {
  return {
    ...card,
    title: redactMarketingText(card.title, rows),
    summary: redactMarketingText(card.summary, rows),
    products: (card.products || []).map((item) => redactMarketingText(item, rows)),
    actions: (card.actions || []).map((item) => redactMarketingText(item, rows)),
    tags: (card.tags || []).map((item) => redactMarketingText(item, rows)),
  };
}

function aggregateMonthlyMarketingRecommendations(rows, monthKey) {
  const completed = rows.filter((item) => item.status === "completed");
  const totalActivity = completed.reduce((sum, item) => sum + Number(item.activityCount || 0), 0);
  const totalProduct = completed.reduce((sum, item) => sum + Number(item.productCount || 0), 0);
  const cards = [];
  if (completed.length) {
    cards.push(anonymizedMarketingCard(0, completed, monthKey));
    if (uniqText(completed.flatMap((item) => item.nextActions || item.recommendation?.nextActions || []), 6).length > 1) {
      cards.push(anonymizedMarketingCard(1, completed, monthKey));
    }
  }
  return {
    monthKey,
    sourceCount: completed.length,
    failedCount: rows.filter((item) => item.status !== "completed").length,
    activityCount: totalActivity,
    productCount: totalProduct,
    cards: cards.map((card) => redactMarketingCard(card, completed)),
    updatedAt: completed[0]?.generatedAt || rows[0]?.generatedAt || null,
  };
}

function buildMonthlyMarketingAggregateFromDbRow(row, monthKey) {
  const monthLabel = monthKey ? `${Number(String(monthKey).slice(5, 7))}月` : "当月";
  const focusProducts = normalizeTextArray(row?.focus_products_json || row?.focusProductsJson, 14);
  const nextActions = normalizeTextArray(row?.next_actions_json || row?.nextActionsJson, 8);
  const cards = [];
  if (focusProducts.length || nextActions.length) {
    cards.push({
      id: `anonymized-${monthKey || "current"}-1`,
      title: `${monthLabel}重点品动销组合`,
      summary: "",
      products: focusProducts.slice(0, 10),
      actions: nextActions.slice(0, 3).length
        ? nextActions.slice(0, 3)
        : ["优先选择活动数据里同时具备销售、奖励和门店覆盖信号的品种，做单品突破与排行榜。"],
      tags: ["合并分析", "重点品", "动销任务"],
    });
    if (nextActions.length > 1 || focusProducts.length > 6) {
      cards.push({
        id: `anonymized-${monthKey || "current"}-2`,
        title: `${monthLabel}激励玩法建议`,
        summary: "",
        products: focusProducts.slice(4, 14),
        actions: nextActions.slice(3, 6).length
          ? nextActions.slice(3, 6)
          : ["把奖励靠前的商品沉淀为店员卖点清单，配套培训考试、陈列晒单和周复盘。"],
        tags: ["激励策略", "培训承接", "周复盘"],
      });
    }
  }
  return {
    monthKey,
    sourceCount: Number(row?.source_count || row?.sourceCount || 0),
    failedCount: Number(row?.failed_count || row?.failedCount || 0),
    activityCount: Number(row?.activity_count || row?.activityCount || 0),
    productCount: Number(row?.product_count || row?.productCount || 0),
    cards,
    updatedAt: row?.updated_at || row?.updatedAt || null,
  };
}

async function listMonthlyMarketingRecommendations(user, monthKey = monthKeyFromDate()) {
  if (!(await isDbAvailable())) return [];
  const params = [monthKey];
  let where = "where m.month_key = $1";
  if (user.role !== "admin") {
    params.push(user.id);
    where += ` and m.user_id = $${params.length}`;
  }
  const result = await queryDb(
    `select m.* from monthly_marketing_list_view m ${where} order by m.generated_at desc limit 100`,
    params,
  );
  return result.rows.map(normalizeMonthlyMarketingListRow);
}

async function getMonthlyMarketingAggregate(user, monthKey = monthKeyFromDate()) {
  if (await isDbAvailable()) {
    const result = await queryDb(
      `select *
       from get_monthly_marketing_aggregate($1::text, $2::text, $3::boolean)`,
      [monthKey, user.id, user.role === "admin"],
    );
    return buildMonthlyMarketingAggregateFromDbRow(result.rows[0] || {}, monthKey);
  }
  const recommendations = await listMonthlyMarketingRecommendations(user, monthKey);
  return aggregateMonthlyMarketingRecommendations(recommendations, monthKey);
}

async function generateMonthlyMarketingBatch(user, monthKey = monthKeyFromDate()) {
  const auths = await listSijichanAuthorizations(user);
  const results = [];
  for (const auth of auths) {
    try {
      const raw = await collectMonthlyMarketingData(auth, monthKey);
      const summary = buildMarketingRecommendationSummary(raw);
      const recommendation = buildDeterministicMarketingRecommendation(summary);
      const row = await saveMonthlyMarketingRecommendation(auth, summary, recommendation, "completed", "");
      await queryDb("update sijichan_account_authorizations set last_success_at=now(), last_error=null, updated_at=now() where id=$1", [auth.id]).catch(() => null);
      results.push({ ok: true, authorizationId: auth.id, recommendation: normalizeMonthlyMarketingRow(row) });
    } catch (error) {
      await queryDb("update sijichan_account_authorizations set last_error=$2, updated_at=now() where id=$1", [auth.id, error.message]).catch(() => null);
      const summary = {
        monthKey,
        customerName: auth.merName || auth.username,
        customerCode: auth.merCode || "",
        rowCounts: { activityCatalog: 0, activityProducts: 0 },
      };
      const recommendation = { title: `${summary.customerName}当月营销推荐`, executiveSummary: "取数失败，暂未生成推荐。", sections: [], nextActions: [] };
      const row = await saveMonthlyMarketingRecommendation(auth, summary, recommendation, "failed", error.message).catch(() => null);
      results.push({ ok: false, authorizationId: auth.id, error: error.message, recommendation: row ? normalizeMonthlyMarketingRow(row) : null });
    }
  }
  return results;
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

function normalizeCapabilitySubmissionRow(row, options = {}) {
  const next = {
    id: row.id,
    name: row.name,
    department: row.department || "",
    testDate: row.test_date || row.testDate || "",
    totalQuestions: Number(row.total_questions || row.totalQuestions || 0),
    answeredQuestions: Number(row.answered_questions || row.answeredQuestions || 0),
    completionRate: Number(row.completion_rate || row.completionRate || 0),
    createdAt: row.created_at || row.createdAt,
  };
  if (options.includeAnswers !== false) {
    next.answers = row.answers_json || row.answersJson || [];
  }
  return next;
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
       values($1,$2,$3,$4,$5,$6,$7::jsonb,$8) returning *`,
      [
        submission.name,
        submission.department,
        submission.testDate,
        submission.totalQuestions,
        submission.answeredQuestions,
        submission.completionRate,
        jsonParam(submission.answers, []),
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

async function listCapabilitySubmissions(options = {}) {
  const page = normalizePageNumber(options.page, 1);
  const pageSize = normalizePageSize(options.pageSize, 20, 100);
  const offset = (page - 1) * pageSize;
  const completionBand = normalizeOptionalEnumFilter(options.completionBand, ["low", "medium", "high"]);
  const keyword = normalizeOptionalTextFilter(options.keyword, 120);
  if (await isDbAvailable()) {
    const filters = [];
    const params = [];
    if (completionBand === "low") filters.push("completion_rate < 60");
    if (completionBand === "medium") filters.push("completion_rate >= 60 and completion_rate < 90");
    if (completionBand === "high") filters.push("completion_rate >= 90");
    if (keyword) {
      params.push(keyword);
      const index = params.length;
      filters.push(`(
        coalesce(name, '') ilike '%' || $${index} || '%'
        or coalesce(department, '') ilike '%' || $${index} || '%'
        or coalesce(test_date, '') ilike '%' || $${index} || '%'
      )`);
    }
    const whereClause = filters.length ? `where ${filters.join(" and ")}` : "";
    const result = await queryDb(
      `with filtered as (
         select *
         from capability_submission_list_view
         ${whereClause}
       ),
       counted as (
         select count(*)::int as total_count from filtered
       ),
       page_rows as (
         select *
         from filtered
         order by created_at desc
         limit $${params.length + 1} offset $${params.length + 2}
       )
       select page_rows.*, counted.total_count
       from counted
       left join page_rows on true`,
      [...params, pageSize, offset],
    );
    const pageRows = result.rows.filter((row) => row.id);
    return {
      items: pageRows.map((row) => normalizeCapabilitySubmissionRow(row, { includeAnswers: false })),
      total: Number(result.rows[0]?.total_count || 0),
      page,
      pageSize,
    };
  }
  const filteredItems = readLocalData().capabilityTestSubmissions
    .slice()
    .filter((row) => {
      if (completionBand === "low") return Number(row.completionRate || row.completion_rate || 0) < 60;
      if (completionBand === "medium") {
        const value = Number(row.completionRate || row.completion_rate || 0);
        return value >= 60 && value < 90;
      }
      if (completionBand === "high") return Number(row.completionRate || row.completion_rate || 0) >= 90;
      return true;
    })
    .filter((row) => {
      if (!keyword) return true;
      return [row.name, row.department, row.testDate || row.test_date].some((value) => includesKeyword(value, keyword));
    })
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  return {
    items: filteredItems.slice(offset, offset + pageSize).map((row) => normalizeCapabilitySubmissionRow(row, { includeAnswers: false })),
    total: filteredItems.length,
    page,
    pageSize,
  };
}

async function getCapabilitySubmission(id) {
  if (await isDbAvailable()) {
    const result = await queryDb("select * from capability_test_submissions where id = $1 limit 1", [id]);
    return result.rows[0] ? normalizeCapabilitySubmissionRow(result.rows[0]) : null;
  }
  const row = readLocalData().capabilityTestSubmissions.find((item) => item.id === id);
  return row ? normalizeCapabilitySubmissionRow(row) : null;
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

function normalizeReviewReportRow(row, options = {}) {
  const shareUrl = normalizePublicArtifactUrl(row.share_url || row.shareUrl);
  const includePayload = options.includePayload !== false;
  const report = includePayload ? (row.payload_report_json || row.payloadReportJson || row.report_json || row.reportJson || null) : null;
  const summary = includePayload
    ? (row.payload_summary_json || row.payloadSummaryJson || row.summary_json || row.summaryJson || row.summary || null)
    : null;
  const rawExcelStatus = String(row.excel_status || row.excelStatus || "").trim();
  const excelUrl = normalizePublicArtifactUrl(row.excel_url || row.excelUrl || (!rawExcelStatus && shareUrl ? reportArtifactUrl(shareUrl, "review.xlsx") : ""));
  const excelStatus = rawExcelStatus || (excelUrl ? "ready" : "");
  const next = {
    id: row.id,
    userId: row.user_id || row.userId,
    sourceType: row.source_type || row.sourceType,
    sourceName: row.source_name || row.sourceName || "",
    status: row.status || "completed",
    reportTitle: row.report_title || row.reportTitle || report?.title || "四季蝉AI复盘报告",
    rowCounts: row.row_counts_json || row.rowCountsJson || null,
    healthScore: row.health_score ?? row.healthScore ?? null,
    riskLevel: row.risk_level || row.riskLevel || "",
    reportId: row.report_id || row.reportId,
    shareUrl,
    svgUrl: normalizePublicArtifactUrl(row.svg_url || row.svgUrl || reportArtifactUrl(shareUrl, "report.svg")),
    qrSvgUrl: normalizePublicArtifactUrl(row.qr_svg_url || row.qrSvgUrl || reportArtifactUrl(shareUrl, "qr.svg")),
    excelUrl,
    excelStatus,
    excelError: row.excel_error || row.excelError || "",
    normalizedDataUrl: normalizePublicArtifactUrl(row.normalized_data_url || row.normalizedDataUrl || reportArtifactUrl(shareUrl, encodeURIComponent("四季蝉登录获取标准化数据.json"))),
    diagnosticsUrl: normalizePublicArtifactUrl(row.diagnostics_url || row.diagnosticsUrl || reportArtifactUrl(shareUrl, encodeURIComponent("四季蝉接口诊断.json"))),
    jobKey: row.job_key || row.jobKey || "",
    progressStage: row.progress_stage || row.progressStage || "",
    progressText: row.progress_text || row.progressText || "",
    progressPercent: normalizeReviewProgressPercent(row.progress_percent ?? row.progressPercent ?? (row.status === "completed" ? 100 : 0), row.status === "completed" ? 100 : 0),
    errorMessage: row.error_message || row.errorMessage || "",
    startedAt: row.started_at || row.startedAt || "",
    heartbeatAt: row.heartbeat_at || row.heartbeatAt || "",
    finishedAt: row.finished_at || row.finishedAt || "",
    cancelRequested: Boolean(row.cancel_requested ?? row.cancelRequested ?? false),
    createdAt: row.created_at || row.createdAt,
  };
  if (includePayload) {
    next.report = report;
    next.summary = summary;
    next.markdown = row.payload_markdown || row.payloadMarkdown || row.markdown || "";
  }
  return next;
}
async function listReviewReports(user, options = {}) {
  const page = normalizePageNumber(options.page, 1);
  const pageSize = normalizePageSize(options.pageSize, 20, 100);
  const offset = (page - 1) * pageSize;
  const statusFilter = normalizeOptionalEnumFilter(options.status, ["running", "completed", "failed", "cancelled"]);
  const sourceTypeFilter = normalizeOptionalEnumFilter(options.sourceType, ["excel", "login", "wecom_browser", "wecom_token"]);
  const keyword = normalizeOptionalTextFilter(options.keyword, 120);
  if (await isDbAvailable()) {
    const filters = [];
    const params = [];
    if (user.role !== "admin") {
      params.push(user.id);
      filters.push(`user_id = $${params.length}`);
    }
    if (statusFilter) {
      params.push(statusFilter);
      filters.push(`status = $${params.length}`);
    }
    if (sourceTypeFilter) {
      params.push(sourceTypeFilter);
      filters.push(`source_type = $${params.length}`);
    }
    if (keyword) {
      params.push(keyword);
      const index = params.length;
      filters.push(`(
        coalesce(report_title, '') ilike '%' || $${index} || '%'
        or coalesce(source_name, '') ilike '%' || $${index} || '%'
        or coalesce(report_id, '') ilike '%' || $${index} || '%'
      )`);
    }
    const whereClause = filters.length ? `where ${filters.join(" and ")}` : "";
    const result = await queryDb(
      `with filtered as (
         select id, user_id, source_type, source_name, status, report_title, report_id, row_counts_json,
                health_score, risk_level, share_url, svg_url, qr_svg_url, excel_url, excel_status, excel_error, normalized_data_url,
                diagnostics_url, job_key, cancel_requested, heartbeat_at, progress_stage, progress_text, progress_percent,
                error_message, started_at, finished_at, created_at
         from review_report_list_view
         ${whereClause}
       ),
       counted as (
         select count(*)::int as total_count from filtered
       ),
       page_rows as (
         select *
         from filtered
         order by created_at desc
         limit $${params.length + 1} offset $${params.length + 2}
       )
       select page_rows.*, counted.total_count
       from counted
       left join page_rows on true`,
      [...params, pageSize, offset],
    );
    const pageRows = result.rows.filter((row) => row.id);
    return {
      items: pageRows.map((row) => normalizeReviewReportRow(row, { includePayload: false })),
      total: Number(result.rows[0]?.total_count || 0),
      page,
      pageSize,
    };
  }
  const data = readLocalData();
  const items = data.reviewReports
    .map((row) => normalizeReviewReportRow(row, { includePayload: false }))
    .filter((report) => user.role === "admin" || report.userId === user.id)
    .filter((report) => !statusFilter || report.status === statusFilter)
    .filter((report) => !sourceTypeFilter || report.sourceType === sourceTypeFilter)
    .filter((report) => {
      if (!keyword) return true;
      return [report.reportTitle, report.sourceName, report.reportId].some((value) => includesKeyword(value, keyword));
    })
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return {
    items: items.slice(offset, offset + pageSize),
    total: items.length,
    page,
    pageSize,
  };
}

function reviewSourceTypesForGroup(sourceGroup = "") {
  const group = String(sourceGroup || "").trim();
  if (!group || group === "all") return [];
  if (group === "excel") return ["excel"];
  if (group === "sijichan") return ["login"];
  if (group === "wecom") return ["wecom_browser", "wecom_token"];
  return [group];
}

async function getLatestRunningReviewReport(user, sourceGroup = "") {
  const sourceTypes = reviewSourceTypesForGroup(sourceGroup);
  if (await isDbAvailable()) {
    const params = [user.id];
    let typeSql = "";
    if (sourceTypes.length) {
      params.push(sourceTypes);
      typeSql = ` and source_type = any($${params.length}::text[])`;
    }
    const result = await queryDb(
      `select id, user_id, source_type, source_name, status, report_title, report_id, row_counts_json,
              health_score, risk_level, share_url, svg_url, qr_svg_url, excel_url, excel_status, excel_error, normalized_data_url,
              diagnostics_url, job_key, cancel_requested, heartbeat_at, progress_stage, progress_text, progress_percent,
              error_message, started_at, finished_at, created_at
       from running_review_report_view
       where user_id = $1
         ${typeSql ? typeSql.replace(/^ and /, "and ") : ""}
       order by coalesce(heartbeat_at, started_at, created_at) desc, created_at desc
       limit 1`,
      params,
    );
    return result.rows[0] ? normalizeReviewReportRow(result.rows[0], { includePayload: false }) : null;
  }
  const items = readLocalData().reviewReports
    .filter((report) => report.userId === user.id)
    .map((row) => normalizeReviewReportRow(row, { includePayload: false }))
    .filter((report) => report.status === "running" && (!sourceTypes.length || sourceTypes.includes(report.sourceType)))
    .sort((a, b) => String(b.heartbeatAt || b.startedAt || b.createdAt).localeCompare(String(a.heartbeatAt || a.startedAt || a.createdAt)));
  return items[0] || null;
}

async function getReviewReport(user, id) {
  if (await isDbAvailable()) {
    const columns = `
      r.id,
      r.user_id,
      r.source_type,
      r.source_name,
      r.status,
      r.report_title,
      r.report_id,
      r.row_counts_json,
      r.health_score,
      r.risk_level,
      r.share_url,
      r.svg_url,
      r.qr_svg_url,
      r.excel_url,
      r.excel_status,
      r.excel_error,
      r.normalized_data_url,
      r.diagnostics_url,
      r.job_key,
      r.cancel_requested,
      r.heartbeat_at,
      r.progress_stage,
      r.progress_text,
      r.progress_percent,
      r.error_message,
      r.started_at,
      r.finished_at,
      r.created_at,
      jsonb_build_object('source', coalesce(r.source_name, ''), 'rowCounts', coalesce(r.row_counts_json, '{}'::jsonb)) as summary_json,
      p.report_json as payload_report_json,
      p.markdown as payload_markdown
    `;
    const result =
      user.role === "admin"
        ? await queryDb(`select ${columns} from review_reports r left join review_report_payloads p on p.report_db_id = r.id where r.id = $1 limit 1`, [id])
        : await queryDb(`select ${columns} from review_reports r left join review_report_payloads p on p.report_db_id = r.id where r.id = $1 and r.user_id = $2 limit 1`, [id, user.id]);
    if (!result.rows[0]) return null;
    return normalizeReviewReportRow(result.rows[0]);
  }
  const report = readLocalData().reviewReports.find((item) => item.id === id && (user.role === "admin" || item.userId === user.id));
  if (!report) return null;
  const payload = getLocalReviewPayload(report.id) || {};
  return normalizeReviewReportRow({
    ...report,
    summaryJson: payload.summaryJson || payload.summary_json,
    reportJson: payload.reportJson || payload.report_json,
    markdown: payload.markdown || "",
  });
}

async function getReviewReportMeta(user, id) {
  if (await isDbAvailable()) {
    const result =
      user.role === "admin"
        ? await queryDb(
            `select id, user_id, source_type, source_name, status, report_title, report_id, row_counts_json,
                    health_score, risk_level, share_url, svg_url, qr_svg_url, excel_url, excel_status, excel_error, normalized_data_url,
                    diagnostics_url, job_key, cancel_requested, heartbeat_at, progress_stage, progress_text,
                    progress_percent, error_message, started_at, finished_at, created_at
             from review_report_list_view
             where id = $1
             limit 1`,
            [id],
          )
        : await queryDb(
            `select id, user_id, source_type, source_name, status, report_title, report_id, row_counts_json,
                    health_score, risk_level, share_url, svg_url, qr_svg_url, excel_url, excel_status, excel_error, normalized_data_url,
                    diagnostics_url, job_key, cancel_requested, heartbeat_at, progress_stage, progress_text,
                    progress_percent, error_message, started_at, finished_at, created_at
             from review_report_list_view
             where id = $1 and user_id = $2
             limit 1`,
            [id, user.id],
          );
    return result.rows[0] ? normalizeReviewReportRow(result.rows[0], { includePayload: false }) : null;
  }
  const report = readLocalData().reviewReports.find((item) => item.id === id && (user.role === "admin" || item.userId === user.id));
  return report ? normalizeReviewReportRow(report, { includePayload: false }) : null;
}

async function listReviewReportStatuses(user, ids = []) {
  const uniqueIds = Array.from(new Set((ids || []).map((id) => String(id || "").trim()).filter(Boolean))).slice(0, 50);
  if (!uniqueIds.length) return [];
  if (await isDbAvailable()) {
    const result =
      user.role === "admin"
        ? await queryDb(
            `select id, user_id, source_type, source_name, status, report_title, report_id, row_counts_json,
                    health_score, risk_level, share_url, svg_url, qr_svg_url, excel_url, excel_status, excel_error, normalized_data_url,
                    diagnostics_url, job_key, cancel_requested, heartbeat_at, progress_stage, progress_text,
                    progress_percent, error_message, started_at, finished_at, created_at
             from review_report_list_view
             where id = any($1::text[])`,
            [uniqueIds],
          )
        : await queryDb(
            `select id, user_id, source_type, source_name, status, report_title, report_id, row_counts_json,
                    health_score, risk_level, share_url, svg_url, qr_svg_url, excel_url, excel_status, excel_error, normalized_data_url,
                    diagnostics_url, job_key, cancel_requested, heartbeat_at, progress_stage, progress_text,
                    progress_percent, error_message, started_at, finished_at, created_at
             from review_report_list_view
             where id = any($1::text[])
               and user_id = $2`,
            [uniqueIds, user.id],
          );
    const order = new Map(uniqueIds.map((id, index) => [id, index]));
    return result.rows
      .map((row) => normalizeReviewReportRow(row, { includePayload: false }))
      .sort((a, b) => (order.get(a.id) ?? 9999) - (order.get(b.id) ?? 9999));
  }
  const idSet = new Set(uniqueIds);
  const order = new Map(uniqueIds.map((id, index) => [id, index]));
  return readLocalData().reviewReports
    .filter((item) => idSet.has(item.id) && (user.role === "admin" || item.userId === user.id))
    .map((row) => normalizeReviewReportRow(row, { includePayload: false }))
    .sort((a, b) => (order.get(a.id) ?? 9999) - (order.get(b.id) ?? 9999));
}

async function listReviewJobEvents(user, reportDbId) {
  const report = await getReviewReportMeta(user, reportDbId);
  if (!report) return null;
  if (await isDbAvailable()) {
    const result = await queryDb(
      `select *
       from review_job_events
       where report_db_id = $1
          or (coalesce($2, '') <> '' and coalesce(job_key, '') = $2)
       order by created_at asc, id asc
       limit 300`,
      [report.id, report.jobKey || ""],
    );
    return {
      report,
      events: result.rows.map(normalizeReviewJobEventRow),
    };
  }
  const data = readLocalData();
  const storedEvents = (data.reviewJobEvents || [])
    .filter((event) => event.reportDbId === report.id || (report.jobKey && event.jobKey === report.jobKey))
    .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")))
    .slice(0, 300)
    .map(normalizeReviewJobEventRow);
  if (storedEvents.length) {
    return { report, events: storedEvents };
  }
  const jobs = (data.reviewJobs || [])
    .filter((job) => job.reportDbId === report.id || (report.jobKey && job.jobKey === report.jobKey))
    .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
  return {
    report,
    events: jobs.map((job) => normalizeReviewJobEventRow({
      id: `${job.id || job.reportDbId || report.id}-current`,
      reviewJobId: job.id || "",
      reportDbId: job.reportDbId || report.id,
      userId: job.userId || report.userId,
      jobKey: job.jobKey || report.jobKey,
      eventType: "current_state",
      status: job.status || report.status,
      progressStage: job.progressStage || report.progressStage,
      progressPercent: job.progressPercent ?? report.progressPercent,
      message: job.errorMessage || job.progressText || report.errorMessage || report.progressText || reviewStatusLabel(job.status || report.status),
      metadataJson: {
        sourceType: job.sourceType || report.sourceType,
        sourceName: job.sourceName || report.sourceName,
        localFallback: true,
      },
      createdAt: job.updatedAt || job.createdAt || report.createdAt,
    })),
  };
}

async function updateReviewReportByUser(user, id, changes) {
  let updatedStatus = changes.status;
  let updatedErrorMessage = changes.errorMessage;
  if (await isDbAvailable()) {
    const params = [id, user.id, user.role === "admin"];
    const assignments = [];
    if (changes.status !== undefined) {
      params.push(changes.status);
      assignments.push(`status=$${params.length}`);
    }
    if (changes.errorMessage !== undefined) {
      params.push(changes.errorMessage || "");
      assignments.push(`error_message=nullif($${params.length}, '')`);
    }
    if (changes.cancelRequested !== undefined) {
      params.push(Boolean(changes.cancelRequested));
      assignments.push(`cancel_requested=$${params.length}`);
    }
    if (changes.progressStage !== undefined) {
      params.push(changes.progressStage || "");
      assignments.push(`progress_stage=nullif($${params.length}, '')`);
    }
    if (changes.progressText !== undefined) {
      params.push(changes.progressText || "");
      assignments.push(`progress_text=nullif($${params.length}, '')`);
    }
    if (changes.progressPercent !== undefined) {
      params.push(normalizeReviewProgressPercent(changes.progressPercent, 0));
      assignments.push(`progress_percent=$${params.length}`);
    }
    if (changes.heartbeatNow) assignments.push("heartbeat_at=now()");
    if (changes.clearFinishedAt) assignments.push("finished_at=null");
    if (changes.finishNow) assignments.push("finished_at=now()");
    if (changes.startedNow) assignments.push("started_at=now()");
    assignments.push("updated_at=now()");
    const result = await queryDb(
      `update review_reports set ${assignments.join(", ")}
       where id=$1 and ($3::boolean or user_id=$2)
       returning *`,
      params,
    );
    const row = result.rows[0];
    if (row && updatedStatus !== undefined) {
      await markReviewJobStatus(row.id, updatedStatus, updatedErrorMessage || "").catch(() => null);
    }
    return normalizeReviewReportRow(row, { includePayload: false });
  }
  const data = readLocalData();
  const report = data.reviewReports.find((item) => item.id === id && (user.role === "admin" || item.userId === user.id));
  if (!report) return null;
  if (changes.status !== undefined) report.status = changes.status;
  if (changes.errorMessage !== undefined) report.errorMessage = changes.errorMessage || "";
  if (changes.cancelRequested !== undefined) report.cancelRequested = Boolean(changes.cancelRequested);
  if (changes.progressStage !== undefined) report.progressStage = changes.progressStage || "";
  if (changes.progressText !== undefined) report.progressText = changes.progressText || "";
  if (changes.progressPercent !== undefined) report.progressPercent = normalizeReviewProgressPercent(changes.progressPercent, 0);
  if (changes.heartbeatNow) report.heartbeatAt = new Date().toISOString();
  if (changes.clearFinishedAt) report.finishedAt = "";
  if (changes.finishNow) report.finishedAt = new Date().toISOString();
  if (changes.startedNow) report.startedAt = new Date().toISOString();
  report.updatedAt = new Date().toISOString();
  writeLocalData(data);
  if (updatedStatus !== undefined) {
    await markReviewJobStatus(report.id, updatedStatus, updatedErrorMessage || "").catch(() => null);
  }
  return normalizeReviewReportRow(report, { includePayload: false });
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
  const expectedSheetSet = new Set(expectedSheets);
  const sheets = {};
  const sheetHeaders = {};

  for (const sheet of workbookSheets) {
    if (!expectedSheetSet.has(sheet.name)) continue;
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

function compactText(value, maxLength = 240) {
  const text = String(value ?? "").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function compactSheetStatusForResponse(sheet = {}) {
  return {
    name: compactText(sheet.name, 80),
    exists: Boolean(sheet.exists),
    rows: Number(sheet.rows || sheet.rowCount || 0),
  };
}

function compactDatasetFileForResponse(file = {}) {
  return {
    name: compactText(file.name, 80),
    label: compactText(file.label || file.name, 80),
    status: compactText(file.status, 32),
    statusText: compactText(file.statusText, 120),
    rowCount: Number(file.rowCount || 0),
    metricCount: Number(file.metricCount || 0),
    note: compactText(file.note, 160),
  };
}

function compactOperationInsightsForResponse(insights = {}) {
  if (!insights || typeof insights !== "object") return undefined;
  const metrics = insights.metrics || {};
  return {
    healthScore: insights.healthScore ?? null,
    retentionRisk: insights.retentionRisk || "",
    valueProofPoints: arrayOfText(insights.valueProofPoints).slice(0, 6),
    recommendedActions: arrayOfText(insights.recommendedActions).slice(0, 6),
    metrics: {
      salesSkuCount: metrics.salesSkuCount ?? null,
      joinedActivityCount: metrics.joinedActivityCount ?? null,
      onlineActivityCount: metrics.onlineActivityCount ?? null,
      activityCoverageRate: metrics.activityCoverageRate ?? null,
      totalSalesAmount: metrics.totalSalesAmount ?? null,
      activitySalesAmount: metrics.activitySalesAmount ?? null,
      totalRewardAmount: metrics.totalRewardAmount ?? null,
      rewardEfficiency: metrics.rewardEfficiency ?? null,
      employeeCoverage: metrics.employeeCoverage ?? null,
      totalWithdrawMoney: metrics.totalWithdrawMoney ?? null,
      usedRewardPlayCount: metrics.usedRewardPlayCount ?? null,
      shareRecordCount: metrics.shareRecordCount ?? null,
      shareRewardAmount: metrics.shareRewardAmount ?? null,
    },
  };
}

function summaryForResponse(summary) {
  if (!summary || typeof summary !== "object") return summary;
  const next = {
    source: compactText(summary.source, 80),
    requestInfo: summary.requestInfo || {},
    windows: summary.windows || {},
    generatedAt: summary.generatedAt || "",
    rowCounts: summary.rowCounts || {},
  };
  if (Array.isArray(summary.sheetStatus)) {
    next.sheetStatus = summary.sheetStatus.map(compactSheetStatusForResponse);
  }
  if (Array.isArray(summary.datasetFiles)) {
    next.datasetFiles = summary.datasetFiles.map(compactDatasetFileForResponse);
  }
  const compactInsights = compactOperationInsightsForResponse(summary.operationInsights);
  if (compactInsights) next.operationInsights = compactInsights;
  if (Array.isArray(summary.interfaceDiagnostics)) {
    next.diagnostics = {
      total: summary.interfaceDiagnostics.length,
      errorCount: summary.interfaceDiagnostics.filter((item) => String(item?.status || item?.statusText || "").toLowerCase().includes("error") || item?.error).length,
    };
  }
  return next;
}

async function loadSystemSetting(key) {
  const normalizedKey = String(key || "").trim();
  if (!normalizedKey) return null;
  if (await isDbAvailable()) {
    const result = await queryDb("select * from system_settings where key = $1 limit 1", [normalizedKey]);
    return result.rows[0] || null;
  }
  const data = readLocalData();
  return data.systemSettings.find((item) => item.key === normalizedKey) || null;
}

async function saveSystemSetting(key, valueJson, userId = "") {
  const normalizedKey = String(key || "").trim();
  if (!normalizedKey) {
    const error = new Error("系统配置键不能为空。");
    error.statusCode = 400;
    throw error;
  }
  const payload = jsonClone(valueJson ?? {});
  if (await isDbAvailable()) {
    const result = await queryDb(
      `insert into system_settings(key, value_json, updated_by)
       values($1, $2::jsonb, $3)
       on conflict (key) do update
       set value_json = excluded.value_json,
           updated_by = excluded.updated_by,
           updated_at = now()
       returning *`,
      [normalizedKey, JSON.stringify(payload), userId || null],
    );
    return result.rows[0] || null;
  }
  const data = readLocalData();
  const now = new Date().toISOString();
  const index = data.systemSettings.findIndex((item) => item.key === normalizedKey);
  const next = {
    key: normalizedKey,
    valueJson: payload,
    updatedBy: userId || "",
    createdAt: index >= 0 ? data.systemSettings[index].createdAt || now : now,
    updatedAt: now,
  };
  if (index >= 0) data.systemSettings[index] = next;
  else data.systemSettings.push(next);
  writeLocalData(data);
  return next;
}

async function loadReviewPromptInstruction() {
  const setting = await loadSystemSetting("review_prompt_instruction");
  const instruction = setting?.value_json?.instruction ?? setting?.valueJson?.instruction ?? "";
  return String(instruction || defaultReviewPromptInstruction).trim() || defaultReviewPromptInstruction;
}

async function saveReviewPromptInstruction(instruction, userId = "") {
  const text = String(instruction || "").trim();
  if (!text) {
    const error = new Error("复盘AI指令不能为空。");
    error.statusCode = 400;
    throw error;
  }
  if (text.length > 20000) {
    const error = new Error("复盘AI指令过长，请控制在 20000 字以内。");
    error.statusCode = 400;
    throw error;
  }
  return saveSystemSetting("review_prompt_instruction", { instruction: text }, userId);
}

function buildPrompt(summary, instruction = defaultReviewPromptInstruction) {
  return [
    String(instruction || defaultReviewPromptInstruction).trim(),
    "",
    "系统固定输出要求：输出必须是JSON，不要输出Markdown代码块。",
    "字段必须包含：title、executiveSummary、highlights、sections、nextActions。不要输出 risks 字段，不要输出独立风险章节。",
    "sections 数组每项必须包含 heading 和 bullets；所有可见文字必须使用中文。",
    "数据摘要如下：",
    JSON.stringify(summaryForAi(summary)),
  ].join("\n");
}

const reportSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "executiveSummary", "highlights", "sections", "nextActions"],
  properties: {
    title: { type: "string" },
    executiveSummary: { type: "string" },
    highlights: { type: "array", items: { type: "string" } },
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

async function fetchWithRetry(url, options, label, retries = 1) {
  let lastError;
  const timeoutMs = Number(process.env.AI_REQUEST_TIMEOUT_MS || 60000);
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      return await fetch(url, {
        ...options,
        signal: options?.signal || AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      lastError = error;
      if (attempt < retries) await sleep(1500 * attempt);
    }
  }
  const message = lastError?.name === "TimeoutError"
    ? `超过 ${Math.round(timeoutMs / 1000)} 秒未返回`
    : lastError?.message || "网络连接失败";
  throw new Error(`${label}请求失败（${url}）：${message}`);
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
          content: `${input}\n\n请输出JSON对象，字段必须包含：title、executiveSummary、highlights、sections、nextActions，不要输出risks字段，不要输出独立风险章节。sections数组每项包含heading和bullets。`,
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
      return callOpenAI(config, `${prompt}\n请按JSON对象返回，字段包含title、executiveSummary、highlights、sections、nextActions，不要输出risks字段，不要输出独立风险章节。`, false);
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
    const roleItems = roleActionItems(value);
    if (roleItems) return roleItems;
    return Object.entries(value)
      .flatMap(([key, item]) => {
        const label = reportActionLabel(key);
        if (Array.isArray(item)) return arrayOfText(item).map((text) => `${label}：${text}`);
        if (item && typeof item === "object") return arrayOfText(item).map((text) => `${label}：${text}`);
        return [`${label}：${item}`];
      })
      .map((item) => item.trim())
      .filter(Boolean);
  }
  const text = String(value || "").trim();
  const labeledItems = parseLabeledActionItems(text);
  if (labeledItems) return labeledItems;
  return text ? [text] : [];
}

function roleActionItems(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const hasRole =
    Object.prototype.hasOwnProperty.call(value, "role") ||
    Object.prototype.hasOwnProperty.call(value, "roles") ||
    Object.prototype.hasOwnProperty.call(value, "角色");
  const actionValue =
    value.actions ??
    value.action ??
    value.bullets ??
    value.bullet ??
    value.items ??
    value.tasks ??
    value["动作"] ??
    value["行动"] ??
    value["要点"] ??
    value["建议"];
  if (!hasRole || actionValue === undefined) return null;
  const role = reportActionLabel(value.role || value.roles || value["角色"] || "动作");
  const actions = arrayOfText(actionValue)
    .map((item) => stripActionKeyPrefix(item))
    .filter(Boolean);
  if (!actions.length) return role ? [`${role}：待补充动作`] : [];
  return actions.map((item) => `${role}：${item}`);
}

function reportActionLabel(key) {
  const labels = {
    role: "角色",
    roles: "角色",
    actions: "动作",
    action: "动作",
    bullets: "要点",
    bullet: "要点",
    headquarters: "总部",
    headquarter: "总部",
    hq: "总部",
    stores: "门店",
    store: "门店",
    shops: "门店",
    clerks: "店员",
    clerk: "店员",
    factories: "厂家",
    factory: "厂家",
    manufacturers: "厂家",
    manufacturer: "厂家",
    chain: "连锁总部",
  };
  return labels[String(key || "").trim()] || String(key || "").trim();
}

function parseLabeledActionItems(text) {
  const match = String(text || "").match(/^([A-Za-z_][\w-]*)\s*[：:]\s*([\s\S]+)$/);
  if (!match) return null;
  const payload = match[2].trim();
  if (!/^[\[{]/.test(payload)) return null;
  try {
    const parsed = JSON.parse(payload);
    const label = reportActionLabel(match[1]);
    return arrayOfText(parsed)
      .map((item) => `${label}：${item}`)
      .filter(Boolean);
  } catch (_error) {
    return null;
  }
}

function stripActionKeyPrefix(value) {
  return String(value || "")
    .replace(/^(actions?|bullets?|items?|tasks?|动作|行动|要点|建议)\s*[：:]\s*/i, "")
    .trim();
}

function normalizeNextActions(value) {
  const items = arrayOfText(value);
  const normalized = [];
  let currentRole = "";
  for (const item of items) {
    const roleMatch = String(item).match(/^(role|roles|角色)\s*[：:]\s*(.+)$/i);
    if (roleMatch) {
      currentRole = reportActionLabel(roleMatch[2]);
      continue;
    }
    const actionMatch = String(item).match(/^(actions?|bullets?|items?|tasks?|动作|行动|要点|建议)\s*[：:]\s*(.+)$/i);
    if (actionMatch) {
      const action = stripActionKeyPrefix(actionMatch[2]);
      normalized.push(currentRole ? `${currentRole}：${action}` : action);
      continue;
    }
    normalized.push(item);
  }
  return normalized;
}

function reportCustomerLabel(summary = {}) {
  const raw = summary.rawData || {};
  const requestInfo = summary.requestInfo || {};
  const candidates = [
    requestInfo.merName,
    requestInfo.customerName,
    summary.customerName,
    summary.customer_name,
    raw.meta?.merName,
    raw.meta?.customerName,
    raw.meta?.name,
  ];
  const name = candidates.map((value) => String(value || "").trim()).find(Boolean);
  if (name) return name;
  const code = [
    requestInfo.merCode,
    requestInfo.customerCode,
    summary.customerCode,
    summary.customer_code,
    raw.meta?.merCode,
    raw.meta?.customerCode,
  ].map((value) => String(value || "").trim()).find(Boolean);
  return code ? `客户${code}` : "";
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function customerTitleAliases(customer = "") {
  const text = String(customer || "").trim();
  if (!text) return [];
  const aliases = new Set([text]);
  const suffixes = [
    "医药连锁有限公司",
    "医药有限公司",
    "连锁有限公司",
    "有限公司",
    "股份有限公司",
    "有限责任公司",
    "公司",
  ];
  for (const suffix of suffixes) {
    if (text.endsWith(suffix) && text.length > suffix.length + 1) aliases.add(text.slice(0, -suffix.length));
  }
  return [...aliases].filter(Boolean).sort((a, b) => b.length - a.length);
}

function stripCustomerPrefixFromTitle(title, summary = {}, customer = "") {
  let next = String(title || "").trim() || "四季蝉AI复盘报告";
  const raw = summary.rawData || {};
  const requestInfo = summary.requestInfo || {};
  const code = [
    requestInfo.merCode,
    requestInfo.customerCode,
    summary.customerCode,
    summary.customer_code,
    raw.meta?.merCode,
    raw.meta?.customerCode,
  ].map((value) => String(value || "").trim()).find(Boolean);
  const aliases = [
    ...customerTitleAliases(customer),
    ...(code ? [`客户${code}`, code] : []),
  ];
  for (const alias of aliases) {
    const pattern = new RegExp(`^${escapeRegExp(alias)}\\s*(?:[｜|:：\\-—－_·、,，]\\s*)?`);
    next = next.replace(pattern, "").trim();
  }
  return next || "四季蝉AI复盘报告";
}

function reportTitleWithCustomer(title, summary = {}) {
  const base = String(title || "四季蝉AI复盘报告").trim() || "四季蝉AI复盘报告";
  const customer = reportCustomerLabel(summary);
  if (!customer) return base;
  const cleanBase = stripCustomerPrefixFromTitle(base, summary, customer);
  if (cleanBase === customer) return customer;
  return `${customer}｜${cleanBase}`;
}

function sanitizeReportVisibleText(value) {
  return String(value || "")
    .replace(/续用风险/g, "运营补强需求")
    .replace(/流失风险/g, "持续运营压力")
    .replace(/运营健康度/g, "运营评分")
    .trim();
}

function sanitizeReportVisibleList(items) {
  return arrayOfText(items).map(sanitizeReportVisibleText).filter(Boolean);
}

function normalizeReport(report) {
  const safe = report && typeof report === "object" ? report : {};
  const sections = Array.isArray(safe.sections)
    ? safe.sections.map((section, index) => ({
        heading: sanitizeReportVisibleText(section?.heading || section?.title || `复盘模块${index + 1}`),
        bullets: sanitizeReportVisibleList(section?.bullets || section?.items || section?.content),
      }))
    : sanitizeReportVisibleList(safe.sections).map((item, index) => ({ heading: `复盘模块${index + 1}`, bullets: [item] }));
  return {
    title: sanitizeReportVisibleText(safe.title || "四季蝉AI复盘报告"),
    executiveSummary: sanitizeReportVisibleText(safe.executiveSummary || safe.summary || ""),
    highlights: sanitizeReportVisibleList(safe.highlights),
    risks: [],
    sections: sections.filter((section) => !/续用风险|运营补强需求|运营评分|运营健康度|数据源状态|风险与短板/i.test(section.heading || "")),
    nextActions: normalizeNextActions(safe.nextActions || safe.actions || safe.recommendations).map(sanitizeReportVisibleText).filter(Boolean),
  };
}

function applyCustomerTitleToReport(report, summary = {}) {
  const normalized = normalizeReport(report);
  normalized.title = reportTitleWithCustomer(normalized.title, summary);
  return normalized;
}

function fallbackReportFromSummary(summary, reason = "") {
  const insights = summary?.operationInsights || {};
  const files = summary?.datasetFiles || [];
  const detailFiles = files.filter((file) => (file.rowCount || 0) > 0);
  const metricFiles = files.filter((file) => (file.metricCount || 0) > 0 && !(file.rowCount || 0));
  const metrics = insights.metrics || {};
  const health = insights.healthScore ?? "暂无";
  return applyCustomerTitleToReport({
    title: "四季蝉客户数据复盘报告",
    executiveSummary: `本次复盘已完成数据读取和运营洞察计算。客户运营评分为 ${health}。${reason ? "AI返回格式异常，系统已基于结构化数据生成兜底报告。" : ""}`,
    highlights: [
      ...((insights.valueProofPoints || []).length ? insights.valueProofPoints : ["已完成销售、活动、奖励、培训、厂家协同等数据源识别。"]),
      detailFiles.length ? `识别到 ${detailFiles.length} 个有明细的数据源：${detailFiles.map((file) => file.label || file.name).join("、")}。` : "",
      metricFiles.length ? `识别到 ${metricFiles.length} 个指标型数据源：${metricFiles.map((file) => file.label || file.name).join("、")}。` : "",
    ].filter(Boolean),
    risks: [],
    sections: [
      {
        heading: "运营健康度",
        bullets: [
          `健康度评分：${health}`,
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
  }, summary);
}

function reportToMarkdown(report) {
  report = normalizeReport(report);
  const lines = [`# ${markdownHeadingIcon(report.title || "四季蝉AI复盘报告")}`, "", report.executiveSummary || ""];
  if (report.highlights?.length) {
    lines.push("", `## ${markdownHeadingIcon("核心亮点")}`, ...report.highlights.map((item) => `- ${item}`));
  }
  for (const section of report.sections || []) {
    lines.push("", `## ${markdownHeadingIcon(section.heading)}`, ...(section.bullets || []).map((item) => `- ${item}`));
  }
  if (report.nextActions?.length) {
    lines.push("", `## ${markdownHeadingIcon("下一步动作")}`, ...report.nextActions.map((item) => `- ${item}`));
  }
  return lines.filter((line, index) => line !== "" || lines[index - 1] !== "").join("\n");
}

function renderList(items = []) {
  items = arrayOfText(items);
  return items.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
}

function reportIconForText(text = "") {
  const value = String(text || "");
  if (/核心|亮点|价值|证明/.test(value)) return "✨";
  if (/销售|动销|品种|商品|AAA/.test(value)) return "📈";
  if (/活动|激励|奖励|豆豆|提现/.test(value)) return "🎯";
  if (/培训|学习|考试/.test(value)) return "🎓";
  if (/厂家|晒单|打赏|协同/.test(value)) return "🤝";
  if (/动作|建议|下月|推进|运营重点/.test(value)) return "🚀";
  if (/数据|口径|来源|诊断/.test(value)) return "📊";
  if (/扫码|导出|分享/.test(value)) return "🔗";
  return "📌";
}

function renderHtmlHeading(title, level = 2) {
  const tag = level === 1 ? "h1" : "h2";
  return `<${tag}><span class="heading-icon" aria-hidden="true">${escapeHtml(reportIconForText(title))}</span>${escapeHtml(title)}</${tag}>`;
}

function markdownHeadingIcon(title) {
  return `${reportIconForText(title)} ${title}`;
}

function renderReportHtml({ report, markdown, summary, shareUrl, svgUrl, qrSvgUrl, excelUrl = "", excelStatus = "", excelError = "" }) {
  report = applyCustomerTitleToReport(report, summary);
  const sections = (report.sections || [])
    .map(
      (section) => `
        <section class="report-section">
          ${renderHtmlHeading(section.heading)}
          <ul>${renderList(section.bullets)}</ul>
        </section>
      `,
    )
    .join("");

  const sourceName = summary?.source || summary?.filename || "四季蝉复盘数据";
  const generatedAt = new Date().toLocaleString("zh-CN", { hour12: false });
  const resolvedExcelUrl = String(excelUrl || "").trim();
  const resolvedExcelStatus = String(excelStatus || (resolvedExcelUrl ? "ready" : "generating")).trim();
  const excelActionHtml = resolvedExcelStatus === "ready" && resolvedExcelUrl
    ? `<a class="button secondary" id="excelAction" data-excel-status="ready" href="${escapeHtml(resolvedExcelUrl)}" download>下载Excel汇总</a>`
    : resolvedExcelStatus === "failed"
      ? `<span class="button disabled danger" id="excelAction" data-excel-status="failed" title="${escapeHtml(excelError || "Excel汇总生成失败")}">Excel生成失败</span>`
      : `<span class="button disabled" id="excelAction" data-excel-status="generating">Excel后台生成中</span>`;
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
    .grid { display:grid; grid-template-columns:1fr; gap:18px; margin-top:22px; }
    .card, .report-section { border:1px solid var(--line); border-radius:18px; background:rgba(255,255,255,.94); box-shadow:0 14px 34px rgba(24,52,126,.07); }
    .card { padding:22px; }
    .card h2, .report-section h2 { display:flex; align-items:center; gap:10px; margin:0 0 12px; color:var(--navy); font-size:24px; }
    .heading-icon { display:inline-grid; place-items:center; flex:0 0 auto; width:34px; height:34px; border-radius:12px; background:#eef3ff; border:1px solid #d5e0ff; box-shadow:inset 0 1px 0 rgba(255,255,255,.85); font-size:19px; line-height:1; }
    ul { margin:0; padding-left:22px; line-height:1.75; }
    li + li { margin-top:7px; }
    .report-section { margin-top:18px; padding:24px; }
    .actions { display:grid; grid-template-columns:1fr 190px; gap:18px; align-items:center; margin-top:22px; padding:22px; border-radius:18px; border:1px solid var(--line); background:#fff; }
    .buttons { display:flex; flex-wrap:wrap; gap:10px; margin-top:14px; }
    a.button, span.button { display:inline-flex; align-items:center; justify-content:center; min-height:40px; padding:0 16px; border-radius:10px; text-decoration:none; color:#fff; background:var(--blue); font-weight:800; }
    a.button.secondary, span.button.secondary { color:var(--navy); background:#fff; border:1px solid var(--line); }
    span.button.disabled { color:var(--muted); background:#f3f6ff; border:1px dashed var(--line); cursor:not-allowed; }
    span.button.danger { color:#a34100; background:#fff4e8; border-color:#ffd4ae; }
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
      <div class="kicker"><span aria-hidden="true">📊</span> 四季蝉 AI DATA REVIEW</div>
      <h1>${escapeHtml(report.title || "四季蝉AI复盘报告")}</h1>
      <p class="summary">${escapeHtml(report.executiveSummary || "")}</p>
      <div class="meta"><span>数据来源：${escapeHtml(sourceName)}</span><span>生成时间：${escapeHtml(generatedAt)}</span></div>
    </section>
    <section class="grid">
      <div class="card">${renderHtmlHeading("核心亮点")}<ul>${renderList(report.highlights)}</ul></div>
    </section>
    ${sections}
    <section class="report-section">${renderHtmlHeading("下一步动作")}<ul>${renderList(report.nextActions)}</ul></section>
    <section class="actions">
      <div>
        ${renderHtmlHeading("扫码查看与导出")}
        <p>此页面可直接分享给客户查看，也可下载SVG长图用于汇报材料。</p>
        <div class="buttons">
          <a class="button" href="${escapeHtml(svgUrl)}" download>下载SVG长图</a>
          <a class="button secondary" href="${escapeHtml(qrSvgUrl)}" download>下载二维码</a>
          ${excelActionHtml}
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
    const excelAction = document.getElementById("excelAction");
    function replaceExcelAction(status, url, error) {
      if (!excelAction || status === "generating") return;
      const next = status === "ready" && url
        ? document.createElement("a")
        : document.createElement("span");
      next.id = "excelAction";
      next.className = status === "ready" && url ? "button secondary" : "button disabled danger";
      next.dataset.excelStatus = status;
      if (status === "ready" && url) {
        next.href = url;
        next.setAttribute("download", "");
        next.textContent = "下载Excel汇总";
      } else {
        next.title = error || "Excel汇总生成失败";
        next.textContent = "Excel生成失败";
      }
      excelAction.replaceWith(next);
    }
    async function refreshExcelAction() {
      try {
        const response = await fetch("status.json?t=" + Date.now(), { cache: "no-store" });
        if (!response.ok) return;
        const data = await response.json();
        replaceExcelAction(String(data.excelStatus || ""), data.excelUrl || "", data.excelError || "");
      } catch (_error) {}
    }
    if (excelAction?.dataset.excelStatus === "generating") {
      refreshExcelAction();
      const excelTimer = window.setInterval(() => {
        if (document.getElementById("excelAction")?.dataset.excelStatus !== "generating") {
          window.clearInterval(excelTimer);
          return;
        }
        refreshExcelAction();
      }, 5000);
    }
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
  report = applyCustomerTitleToReport(report, summary);
  const width = 1200;
  let y = 92;
  const parts = [];
  const addBlock = (title, items) => {
    parts.push(`<rect x="60" y="${y - 38}" width="1080" height="${Math.max(120, 74 + items.length * 54)}" rx="22" fill="#ffffff" stroke="#dbe4ff"/>`);
    parts.push(svgText([`${reportIconForText(title)} ${title}`], 88, y, { size: 30, weight: 900, fill: "#1f3f95" }));
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
  parts.push(`<text x="76" y="${y}" font-size="24" font-weight="900" fill="#2a4bff">📊 四季蝉 AI DATA REVIEW</text>`);
  y += 62;
  parts.push(svgText(titleLines, 76, y, { size: 52, weight: 900, fill: "#1f3f95", lineHeight: 62 }));
  y += titleLines.length * 62 + 22;
  parts.push(svgText(summaryLines.slice(0, 4), 76, y, { size: 25, fill: "#3f4b62", lineHeight: 40 }));
  y = 430;

  addBlock("核心亮点", report.highlights || []);
  for (const section of report.sections || []) addBlock(section.heading, section.bullets || []);
  addBlock("下一步动作", report.nextActions || []);

  parts.push(`<rect x="60" y="${y - 30}" width="1080" height="210" rx="22" fill="#1f3f95"/>`);
  parts.push(svgText(["🔗 扫码查看完整网页报告", shareUrl], 88, y + 34, { size: 25, weight: 800, fill: "#ffffff", lineHeight: 38 }));
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

const workbookHeaderNameMap = {
  id: "记录ID",
  type: "类型",
  source: "数据来源",
  status: "状态",
  statusText: "状态说明",
  statusCode: "状态码",
  code: "业务码",
  msg: "业务消息",
  message: "业务消息",
  path: "数据路径",
  dataPath: "数据路径",
  file: "数据文件",
  name: "名称",
  label: "标签",
  value: "数值",
  key: "指标键",
  level: "等级",
  role: "角色",
  actions: "行动建议",
  bullets: "要点",
  headquarters: "总部",
  stores: "门店",
  factories: "厂家",
  merCode: "客户编码",
  merName: "客户名称",
  username: "账号",
  province: "省份",
  city: "城市",
  createdAt: "创建时间",
  updatedAt: "更新时间",
  generatedAt: "生成时间",
  startTime: "开始时间",
  endTime: "结束时间",
  beginTime: "开始时间",
  closeTime: "结束时间",
  activityName: "活动名称",
  marketActivityName: "活动名称",
  activityCode: "活动编码",
  activityId: "活动ID",
  commodityName: "商品名称",
  productName: "商品名称",
  goodsName: "商品名称",
  skuName: "商品名称",
  commodityCode: "商品编码",
  productCode: "商品编码",
  goodsCode: "商品编码",
  wareIspCode: "商品编码",
  erpCode: "ERP编码",
  specSku: "规格",
  spec: "规格",
  origin: "产地",
  manufacturer: "厂家",
  factoryName: "厂家名称",
  storeCode: "门店编码",
  storeName: "门店名称",
  storeCodeList: "门店编码列表",
  areaIds: "区域ID列表",
  empCode: "员工编码",
  empName: "员工姓名",
  employeeCode: "员工编码",
  employeeName: "员工姓名",
  courseName: "课程名称",
  saleMerNum: "动销客户数",
  saleStoreNum: "动销门店数",
  joinStoreNum: "参与门店数",
  stockStoreNum: "有库存门店数",
  saleCommodityNum: "销售数量",
  saleCommodityLastNum: "上期销售数量",
  saleCommodityLastRate: "销售数量环比",
  saleCommodityAmount: "销售金额",
  saleAmount: "销售金额",
  salesAmount: "销售金额",
  rewardSaleAmount: "活动销售金额",
  activitySaleAmount: "活动销售金额",
  saleCommodityAmountRate: "销售金额环比",
  customersNum: "购买顾客数",
  averageCustomersNum: "客流均值",
  orderNum: "订单数",
  toSaleCommodityNum: "正向销售数量",
  returnSaleCommodityNum: "退货数量",
  commodityRefundNumber: "商品退款数量",
  returnRate: "退货率",
  rewardAmount: "奖励金额",
  rewardCommodityAmount: "奖励商品金额",
  singleRewardMoney: "单品奖励金额",
  withdrawAmount: "提现金额",
  balance: "余额",
  pageNo: "页码",
  pageSize: "每页数量",
  total: "总数",
  totalCount: "总数",
  rowCount: "明细行数",
  metricCount: "指标数量",
};

function workbookHeaderLabel(header) {
  const key = String(header || "").trim();
  if (!key) return "字段";
  if (/[\u4e00-\u9fa5]/.test(key)) return key;
  if (workbookHeaderNameMap[key]) return workbookHeaderNameMap[key];
  const lowerKey = key.toLowerCase();
  for (const [candidate, label] of Object.entries(workbookHeaderNameMap)) {
    if (candidate.toLowerCase() === lowerKey) return label;
  }
  return `字段：${key}`;
}

function uniqueWorkbookHeaders(headers) {
  const counts = new Map();
  return headers.map((header) => {
    const label = workbookHeaderLabel(header);
    const count = (counts.get(label) || 0) + 1;
    counts.set(label, count);
    return count === 1 ? label : `${label}${count}`;
  });
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
  return [uniqueWorkbookHeaders(headers), ...list.map((row) => headers.map((header) => row?.[header] ?? ""))];
}

function capWorkbookRows(rows, label, limit = workbookDetailRowLimit) {
  const list = Array.isArray(rows) ? rows : [];
  if (list[0] && typeof list[0] === "object" && list[0].原始明细行数 !== undefined && list[0].Excel保留行数 !== undefined) {
    return list;
  }
  if (!limit || list.length <= limit) return list;
  return [
    {
      说明: `${label}共 ${list.length} 行，Excel汇总仅保留前 ${limit} 行用于打开和分享；完整明细总量请查看接口诊断和标准化数据。`,
      原始明细行数: list.length,
      Excel保留行数: limit,
    },
    ...list.slice(0, limit),
  ];
}

function capWorkbookInputRows(rows, label, limit = workbookDetailRowLimit) {
  const list = Array.isArray(rows) ? rows : [];
  if (!limit || list.length <= limit) return list;
  return [
    {
      说明: `${label}共 ${list.length} 行，Excel汇总仅保留前 ${limit} 行用于打开和分享；完整明细总量请查看接口诊断和标准化数据。`,
      原始明细行数: list.length,
      Excel保留行数: limit,
    },
    ...list.slice(0, limit),
  ];
}

function compactWorkbookDiagnostics(items, limit = 1000) {
  const list = Array.isArray(items) ? items : [];
  if (!limit || list.length <= limit) return list;
  return [
    {
      模块: "系统说明",
      接口: "接口诊断",
      类型: "裁剪提示",
      状态: "已裁剪",
      状态说明: `接口诊断共 ${list.length} 条，Excel汇总仅保留前 ${limit} 条；完整诊断请查看接口诊断JSON。`,
      明细行数: list.length,
    },
    ...list.slice(0, Math.max(1, limit - 1)),
  ];
}

function prepareReviewWorkbookInput(summary = {}, report = {}) {
  const raw = summary.rawData || {};
  const nextRawData = {
    meta: raw.meta || {},
    overview: raw.overview || {},
    rewardStatistics: {
      nearHalf: {
        ...(raw.rewardStatistics?.nearHalf || {}),
        rows: capWorkbookInputRows(raw.rewardStatistics?.nearHalf?.rows || [], "奖励统计-半年"),
      },
    },
    sales: {
      currentMonth_vs_previousMonthSamePeriod: {
        ...(raw.sales?.currentMonth_vs_previousMonthSamePeriod || {}),
        rows: capWorkbookInputRows(raw.sales?.currentMonth_vs_previousMonthSamePeriod?.rows || [], "销售汇总-当月_vs_上月同期"),
      },
      currentMonth: {
        ...(raw.sales?.currentMonth || {}),
        rows: capWorkbookInputRows(raw.sales?.currentMonth?.rows || [], "销售汇总-当月"),
      },
      lastMonth_vs_priorTwoMonths: {
        ...(raw.sales?.lastMonth_vs_priorTwoMonths || {}),
        rows: capWorkbookInputRows(raw.sales?.lastMonth_vs_priorTwoMonths?.rows || [], "销售汇总-上月_vs_前两月"),
      },
      lastMonth_vs_sameMonthLastYear: {
        ...(raw.sales?.lastMonth_vs_sameMonthLastYear || {}),
        rows: capWorkbookInputRows(raw.sales?.lastMonth_vs_sameMonthLastYear?.rows || [], "销售汇总-上月_vs_去年同月"),
      },
      nearHalf_vs_previousHalf: {
        ...(raw.sales?.nearHalf_vs_previousHalf || {}),
        rows: capWorkbookInputRows(raw.sales?.nearHalf_vs_previousHalf?.rows || [], "销售汇总-近半年_vs_上期"),
      },
      nearHalf_vs_sameNearHalfLastYear: {
        ...(raw.sales?.nearHalf_vs_sameNearHalfLastYear || {}),
        rows: capWorkbookInputRows(raw.sales?.nearHalf_vs_sameNearHalfLastYear?.rows || [], "销售汇总-近半年_vs_去年同期"),
      },
    },
    activitySummary: {
      currentMonth: {
        ...(raw.activitySummary?.currentMonth || {}),
        rows: capWorkbookInputRows(raw.activitySummary?.currentMonth?.rows || [], "活动汇总-当月"),
      },
      previousMonthSamePeriod: {
        ...(raw.activitySummary?.previousMonthSamePeriod || {}),
        rows: capWorkbookInputRows(raw.activitySummary?.previousMonthSamePeriod?.rows || [], "活动汇总-上月同期"),
      },
      lastMonth: {
        ...(raw.activitySummary?.lastMonth || {}),
        rows: capWorkbookInputRows(raw.activitySummary?.lastMonth?.rows || [], "活动汇总-上月"),
      },
      previousMonth: {
        ...(raw.activitySummary?.previousMonth || {}),
        rows: capWorkbookInputRows(raw.activitySummary?.previousMonth?.rows || [], "活动汇总-上上月"),
      },
      sameMonthLastYear: {
        ...(raw.activitySummary?.sameMonthLastYear || {}),
        rows: capWorkbookInputRows(raw.activitySummary?.sameMonthLastYear?.rows || [], "活动汇总-去年同月"),
      },
      nearHalf: {
        ...(raw.activitySummary?.nearHalf || {}),
        rows: capWorkbookInputRows(raw.activitySummary?.nearHalf?.rows || [], "活动汇总-近半年"),
      },
      sameNearHalfLastYear: {
        ...(raw.activitySummary?.sameNearHalfLastYear || {}),
        rows: capWorkbookInputRows(raw.activitySummary?.sameNearHalfLastYear?.rows || [], "活动汇总-去年同期近半年"),
      },
    },
    activityCatalog: {
      joined: capWorkbookInputRows(raw.activityCatalog?.joined || [], "我的活动列表"),
    },
    training: {
      courseOverview: raw.training?.courseOverview || {},
      resourceOverview: raw.training?.resourceOverview || {},
      roleLearning: capWorkbookInputRows(raw.training?.roleLearning || [], "角色学习明细"),
      storeLearning: capWorkbookInputRows(raw.training?.storeLearning || [], "门店学习明细"),
      employeeLearning: capWorkbookInputRows(raw.training?.employeeLearning || [], "员工学习明细"),
      courseLearning: capWorkbookInputRows(raw.training?.courseLearning || [], "课程学习明细"),
    },
    manufacturerTips: {
      summary: raw.manufacturerTips?.summary || {},
      rows: capWorkbookInputRows(raw.manufacturerTips?.rows || [], "厂家打赏"),
    },
    rewardDistribution: {
      nearHalf: {
        ...(raw.rewardDistribution?.nearHalf || {}),
        rows: capWorkbookInputRows(raw.rewardDistribution?.nearHalf?.rows || [], "奖励发放明细"),
      },
    },
    employeeAccount: {
      accountSummary: raw.employeeAccount?.accountSummary || {},
      withdrawSummary: raw.employeeAccount?.withdrawSummary || {},
      settleSummary: raw.employeeAccount?.settleSummary || {},
      withdrawRows: capWorkbookInputRows(raw.employeeAccount?.withdrawRows || [], "提现明细"),
      writeOffRows: capWorkbookInputRows(raw.employeeAccount?.writeOffRows || [], "延时豆核销明细"),
      settleRows: capWorkbookInputRows(raw.employeeAccount?.settleRows || [], "结算明细"),
    },
  };
  const nextSummary = {
    ...summary,
    interfaceDiagnostics: compactWorkbookDiagnostics(summary.interfaceDiagnostics || []),
    rawData: nextRawData,
  };
  return { summary: nextSummary, report };
}

function workbookColumnWidth(header, index) {
  const text = String(header || "");
  if (index === 0) return 18;
  if (/内容|说明|建议|动作|结论|请求参数|业务消息|风险|证据/.test(text)) return 46;
  if (/时间|日期/.test(text)) return 22;
  if (/名称|商品|活动|客户|门店|厂家|课程/.test(text)) return 26;
  if (/金额|数量|数值|行数|比例|评分|编码|状态/.test(text)) return 16;
  return Math.min(Math.max(Math.ceil(text.length * 2.1), 14), 28);
}

function workbookRowStyleId(row, sheetName) {
  const text = (Array.isArray(row) ? row.join(" ") : String(row || "")).toLowerCase();
  if (/流失风险|续用风险|风险问题|需要关注|当前数据不足|无明细|失败|异常|停用|risk|warning/.test(text)) return 3;
  if (/重点|关键发现|价值证明|客户继续使用证据|总览结论|健康度评分|下一步动作|总部|门店|厂家/.test(text)) return 2;
  if (/运营健康度|复盘结论/.test(sheetName)) return 4;
  return 4;
}

function worksheetXml(matrix, options = {}) {
  const rowCount = Math.max(matrix.length, 1);
  const columnCount = Math.max(...matrix.map((row) => row.length), 1);
  const lastCell = `${excelColumnName(columnCount - 1)}${rowCount}`;
  const headers = matrix[0] || [];
  const cols = Array.from({ length: columnCount }, (_, index) => {
    const width = workbookColumnWidth(headers[index], index);
    return `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`;
  }).join("");
  const rows = matrix.map((row, rIndex) => {
    const cells = row.map((value, cIndex) => {
      const ref = `${excelColumnName(cIndex)}${rIndex + 1}`;
      const text = escapeXml(value === null || value === undefined ? "" : String(value));
      const styleId = rIndex === 0 ? 1 : workbookRowStyleId(row, options.name || "");
      return `<c r="${ref}" t="inlineStr" s="${styleId}"><is><t>${text}</t></is></c>`;
    }).join("");
    const height = rIndex === 0 ? 24 : 30;
    return `<row r="${rIndex + 1}" ht="${height}" customHeight="1">${cells}</row>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <dimension ref="A1:${lastCell}"/>
  <sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
  <cols>${cols}</cols>
  <sheetData>${rows}</sheetData>
  <autoFilter ref="A1:${lastCell}"/>
</worksheet>`;
}

function workbookStylesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="4">
    <font><sz val="11"/><name val="Microsoft YaHei"/></font>
    <font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Microsoft YaHei"/></font>
    <font><b/><sz val="11"/><color rgb="FF17327A"/><name val="Microsoft YaHei"/></font>
    <font><b/><sz val="11"/><color rgb="FF9A3412"/><name val="Microsoft YaHei"/></font>
  </fonts>
  <fills count="6">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF1F3F95"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFFF1D6"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFFE8E0"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFF8FAFF"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="2">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border><left style="thin"><color rgb="FFD7E0FF"/></left><right style="thin"><color rgb="FFD7E0FF"/></right><top style="thin"><color rgb="FFD7E0FF"/></top><bottom style="thin"><color rgb="FFD7E0FF"/></bottom><diagonal/></border>
  </borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="5">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="2" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="3" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="0" fillId="5" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
  <dxfs count="0"/>
  <tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>
</styleSheet>`;
}

function workbookSheets(summary, report) {
  report = normalizeReport(report);
  const raw = summary.rawData || {};
  const windows = summary.windows || {};
  const metrics = summary.metricRows || {};
  const insights = summary.operationInsights || {};
  const monthlyComparisonRows = Object.entries(summary.monthlyComparison || {}).flatMap(([group, values]) => {
    if (!values || typeof values !== "object" || !["marketPerformance", "activityExecution", "productStructure", "inputOutput"].includes(group)) return [];
    const groupName = {
      marketPerformance: "大盘业绩",
      activityExecution: "活动执行情况",
      productStructure: "商品与结构",
      inputOutput: "投入产出",
    }[group] || group;
    const metricNames = {
      salesAmount: "销售额",
      grossProfit: "毛利额",
      grossMargin: "毛利率",
      activityCount: "活动个数",
      activitySkuCount: "活动商品数",
      activitySalesAmount: "活动销售额",
      storeActivationRate: "门店动销率",
      employeeActivationRate: "人员动销率",
      skuActivationRate: "品种动销率",
      jointMedicationRate: "联合用药率",
      keyProductRatio: "重点品占比",
      slowMovingClearanceRate: "滞销品消化率",
      rewardAmount: "奖励金额",
      roi: "投入产出比ROI",
      feeEfficiencyRate: "费效比",
    };
    return Object.entries(values).map(([key, metric]) => ({
      对比模块: groupName,
      指标: metricNames[key] || key,
      当月: metric?.current ?? "",
      上月: metric?.previous ?? "",
      差额: metric?.diff ?? "",
      变化率: metric?.changeRate === undefined || metric?.changeRate === "" ? "" : `${metric.changeRate}%`,
    }));
  });
  const comparableProductRows = [
    { 对比口径: "近半年同比-同品种", 共同销售品种数: summary.comparableProductComparison?.nearHalfSameProducts?.commonProductCount ?? "", 指标: "销售额", 本期: summary.comparableProductComparison?.nearHalfSameProducts?.salesAmount?.current ?? "", 对比期: summary.comparableProductComparison?.nearHalfSameProducts?.salesAmount?.previous ?? "", 变化率: summary.comparableProductComparison?.nearHalfSameProducts?.salesAmount?.changeRate === undefined ? "" : `${summary.comparableProductComparison.nearHalfSameProducts.salesAmount.changeRate}%`, 说明: summary.comparableProductComparison?.rule || "" },
    { 对比口径: "上月同比-同品种", 共同销售品种数: summary.comparableProductComparison?.lastMonthSameProducts?.commonProductCount ?? "", 指标: "销售额", 本期: summary.comparableProductComparison?.lastMonthSameProducts?.salesAmount?.current ?? "", 对比期: summary.comparableProductComparison?.lastMonthSameProducts?.salesAmount?.previous ?? "", 变化率: summary.comparableProductComparison?.lastMonthSameProducts?.salesAmount?.changeRate === undefined ? "" : `${summary.comparableProductComparison.lastMonthSameProducts.salesAmount.changeRate}%`, 说明: summary.comparableProductComparison?.rule || "" },
  ];
  const employeeParticipationRows = [{
    指标: "店员认证与提现参与",
    店员认证总人数: summary.employeeParticipationComparison?.certifiedEmployeeCount ?? "",
    提现总人数: summary.employeeParticipationComparison?.withdrawEmployeeCount ?? "",
    提现参与率: summary.employeeParticipationComparison?.withdrawParticipationRate === undefined ? "" : `${summary.employeeParticipationComparison.withdrawParticipationRate}%`,
    说明: summary.employeeParticipationComparison?.note || "",
  }];
  const insightRows = [
    { 重点标注: "重点：运营健康度", 模块: "客户运营健康度", 指标: "健康度评分", 数值: insights.healthScore ?? "", 结论: "", 建议动作: "用于判断客户是否已经把四季蝉用成持续运营工具，而不是一次性红包活动。" },
    ...((insights.scoreItems || []).map((item) => ({
      重点标注: item.level === "risk" ? "重点补强" : item.level === "watch" ? "重点关注" : "持续保持",
      模块: "健康度拆解",
      指标: item.label || item.key || "",
      数值: item.value ?? "",
      结论: item.level === "healthy" ? "表现较好" : item.level === "watch" ? "需要关注" : "需要补强",
      建议动作: sanitizeReportVisibleText(item.explanation || ""),
    }))),
    ...((insights.valueProofPoints || []).map((item) => ({ 重点标注: "重点价值证据", 模块: "价值证明点", 指标: "客户继续使用证据", 数值: "", 结论: item, 建议动作: "复盘会上优先展示，用数据证明四季蝉带来的动销、激励和协同价值。" }))),
    ...((insights.riskItems || []).map((item) => ({ 重点标注: "重点补强", 模块: "运营补强信号", 指标: item.label || "", 数值: item.value ?? "", 结论: sanitizeReportVisibleText(item.explanation || ""), 建议动作: "形成下月跟进清单，让客户持续看到运营收益。" }))),
    ...((insights.recommendedActions || []).map((item, index) => ({ 重点标注: "重点动作", 模块: "下月推动动作", 指标: `动作${index + 1}`, 数值: "", 结论: sanitizeReportVisibleText(item), 建议动作: sanitizeReportVisibleText(item) }))),
    ...((insights.weakActivityItems || []).map((item) => ({ 重点标注: "重点跟进品种", 模块: "弱活动品种", 指标: item.商品名称 || item.商品编码 || "", 数值: item.指标值 ?? "", 结论: item.数据路径 || "", 建议动作: "检查是否存在有奖励但无销售的品种，必要时调整选品、门店覆盖或店员培训。" }))),
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
  const conclusionRows = [
    { 重点标注: "重点摘要", 类型: "总览结论", 内容: report?.executiveSummary || "" },
    ...((report?.highlights || []).map((item) => ({ 重点标注: "重点亮点", 类型: "关键发现", 内容: item }))),
    ...((report?.nextActions || []).map((item) => ({ 重点标注: "重点动作", 类型: "下一步动作", 内容: item }))),
  ];
  return [
    { name: "运营健康度", rows: insightRows.length ? insightRows : [{ 重点标注: "重点关注", 模块: "运营洞察", 指标: "暂无可计算洞察", 数值: "", 结论: "当前数据不足", 建议动作: "补齐销售、活动、奖励、培训、提现或厂家协同数据后再复盘。" }] },
    { name: "复盘结论", rows: conclusionRows },
    { name: "当月_vs_上月同期经营对比", rows: monthlyComparisonRows.length ? monthlyComparisonRows : [{ 对比模块: "当月与上月同期经营对比", 指标: "暂无可计算指标", 当月: "", 上月同期: "", 差额: "", 变化率: "" }] },
    { name: "同品种同比对比", rows: comparableProductRows },
    { name: "店员认证与提现对比", rows: employeeParticipationRows },
    { name: "数据口径说明", rows: [
      { 项目: "数据来源", 内容: summary.source || "登录获取" },
      { 项目: "客户名称", 内容: summary.requestInfo?.merName || raw.meta?.merName || "" },
      { 项目: "客户编码", 内容: summary.requestInfo?.merCode || raw.meta?.merCode || "" },
      { 项目: "当月", 内容: `${windows.currentMonth?.start || ""} 至 ${windows.currentMonth?.end || ""}` },
      { 项目: "上月同期", 内容: `${windows.previousMonthSamePeriod?.start || ""} 至 ${windows.previousMonthSamePeriod?.end || ""}` },
      { 项目: "上月", 内容: `${windows.lastMonth?.start || ""} 至 ${windows.lastMonth?.end || ""}` },
      { 项目: "上上月", 内容: `${windows.previousMonth?.start || ""} 至 ${windows.previousMonth?.end || ""}` },
      { 项目: "去年同月", 内容: `${windows.sameMonthLastYear?.start || ""} 至 ${windows.sameMonthLastYear?.end || ""}` },
      { 项目: "前两月对比期", 内容: `${windows.priorTwoMonths?.start || ""} 至 ${windows.priorTwoMonths?.end || ""}` },
      { 项目: "近半年", 内容: `${windows.nearHalf?.start || ""} 至 ${windows.nearHalf?.end || ""}` },
      { 项目: "去年同期近半年", 内容: `${windows.sameNearHalfLastYear?.start || ""} 至 ${windows.sameNearHalfLastYear?.end || ""}` },
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
    { name: "我的活动列表", rows: capWorkbookRows(raw.activityCatalog?.joined || [], "我的活动列表") },
    { name: "奖励统计-半年", rows: capWorkbookRows(raw.rewardStatistics?.nearHalf?.rows || [], "奖励统计-半年") },
    { name: "奖励发放明细", rows: rewardDistributionRows.length ? capWorkbookRows(rewardDistributionRows, "奖励发放明细") : [{ 类型: "奖励发放", 说明: "当前口径未识别到奖励发放明细或指标，请查看接口诊断。" }] },
    { name: "员工豆豆账户与提现", rows: employeeAccountRows.length ? capWorkbookRows(employeeAccountRows, "员工豆豆账户与提现") : [{ 类型: "员工收益闭环", 说明: "当前口径未识别到员工账户、提现、核销或结算数据，请查看接口诊断。" }] },
    { name: "销售汇总-当月_vs_上月同期", rows: capWorkbookRows(raw.sales?.currentMonth_vs_previousMonthSamePeriod?.rows || [], "销售汇总-当月_vs_上月同期") },
    { name: "销售汇总-上月_vs_前两月", rows: capWorkbookRows(raw.sales?.lastMonth_vs_priorTwoMonths?.rows || [], "销售汇总-上月_vs_前两月") },
    { name: "销售汇总-上月_vs_去年同月", rows: capWorkbookRows(raw.sales?.lastMonth_vs_sameMonthLastYear?.rows || [], "销售汇总-上月_vs_去年同月") },
    { name: "销售汇总-近半年_vs_上期", rows: capWorkbookRows(raw.sales?.nearHalf_vs_previousHalf?.rows || [], "销售汇总-近半年_vs_上期") },
    { name: "销售汇总-近半年_vs_去年同期", rows: capWorkbookRows(raw.sales?.nearHalf_vs_sameNearHalfLastYear?.rows || [], "销售汇总-近半年_vs_去年同期") },
    { name: "活动汇总-当月_vs_上月同期", rows: capWorkbookRows([...(raw.activitySummary?.currentMonth?.rows || []), ...(raw.activitySummary?.previousMonthSamePeriod?.rows || [])], "活动汇总-当月_vs_上月同期") },
    { name: "活动汇总-5月_vs_4月", rows: capWorkbookRows([...(raw.activitySummary?.lastMonth?.rows || []), ...(raw.activitySummary?.previousMonth?.rows || [])], "活动汇总-5月_vs_4月") },
    { name: "活动汇总-上月_vs_去年同月", rows: capWorkbookRows([...(raw.activitySummary?.lastMonth?.rows || []), ...(raw.activitySummary?.sameMonthLastYear?.rows || [])], "活动汇总-上月_vs_去年同月") },
    { name: "活动汇总-近半年_vs_去年同期", rows: capWorkbookRows([...(raw.activitySummary?.nearHalf?.rows || []), ...(raw.activitySummary?.sameNearHalfLastYear?.rows || [])], "活动汇总-近半年_vs_去年同期") },
    { name: "培训情况", rows: capWorkbookRows(trainingRows, "培训情况") },
    { name: "厂家打赏", rows: manufacturerTipRows.length ? capWorkbookRows(manufacturerTipRows, "厂家打赏") : [{ 类型: "厂家打赏汇总", 指标: "当前口径厂家打赏", 指标值: 0, 说明: "接口成功返回，但无打赏金额和明细记录" }] },
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
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
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
  <Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`);
  zip.folder("xl").file("styles.xml", workbookStylesXml());
  const worksheets = zip.folder("xl").folder("worksheets");
  for (const sheet of sheets) {
    worksheets.file(`sheet${sheet.id}.xml`, worksheetXml(sheet.matrix, { name: sheet.name }));
  }
  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  fs.writeFileSync(filePath, buffer);
}

function workbookDateStamp(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

function safeWorkbookFileSegment(value, fallback) {
  const text = String(value || fallback || "")
    .replace(/\.xlsx$/i, "")
    .replace(/[\\/:*?"<>|\r\n\t]/g, "")
    .replace(/\s+/g, "")
    .trim();
  return (text || fallback || "四季蝉客户").slice(0, 48);
}

function workbookCustomerName(summary) {
  const raw = summary?.rawData || {};
  return (
    summary?.requestInfo?.merName ||
    raw.meta?.merName ||
    summary?.customerName ||
    summary?.customer_name ||
    summary?.requestInfo?.merCode ||
    raw.meta?.merCode ||
    summary?.customerCode ||
    summary?.customer_code ||
    summary?.filename ||
    "四季蝉客户"
  );
}

function reviewWorkbookFileName(summary, date = new Date()) {
  const customerName = safeWorkbookFileSegment(workbookCustomerName(summary), "四季蝉客户");
  return `${customerName}_${workbookDateStamp(date)}_四季蝉复盘报告.xlsx`;
}

function reportArtifactEncodedUrl(shareUrl, filename) {
  return `${String(shareUrl || "").replace(/\/?$/, "/")}${encodeURIComponent(filename)}`;
}

function reportArtifactDir(reportId) {
  const safeId = String(reportId || "").trim();
  if (!/^[a-zA-Z0-9_-]+$/.test(safeId)) throw new Error("报告ID不合法，无法写入报告产物。");
  return path.join(reportsDir, safeId);
}

function reportArtifactStatusPayload(artifact = {}, overrides = {}) {
  return {
    reportId: overrides.reportId || artifact.reportId || "",
    shareUrl: overrides.shareUrl || artifact.shareUrl || "",
    svgUrl: overrides.svgUrl || artifact.svgUrl || "",
    qrSvgUrl: overrides.qrSvgUrl || artifact.qrSvgUrl || "",
    excelUrl: overrides.excelUrl || artifact.excelUrl || "",
    excelStatus: overrides.excelStatus || artifact.excelStatus || "",
    excelError: overrides.excelError || artifact.excelError || "",
    normalizedDataUrl: overrides.normalizedDataUrl || artifact.normalizedDataUrl || "",
    diagnosticsUrl: overrides.diagnosticsUrl || artifact.diagnosticsUrl || "",
    updatedAt: new Date().toISOString(),
  };
}

function reportArtifactJsonPayload({ report, markdown, summary, reportId, shareUrl, svgUrl, qrSvgUrl, excelUrl = "", excelStatus = "", excelError = "", excelFileName = "", normalizedDataUrl = "", diagnosticsUrl = "" }) {
  return {
    report,
    markdown: markdown || "",
    summary: summaryForResponse(summary),
    reportId,
    shareUrl,
    svgUrl,
    qrSvgUrl,
    excelUrl,
    excelStatus,
    excelError,
    excelFileName,
    normalizedDataUrl,
    diagnosticsUrl,
  };
}

function writeReportArtifactStatus(reportDir, artifact = {}, overrides = {}) {
  fs.writeFileSync(
    path.join(reportDir, "status.json"),
    JSON.stringify(reportArtifactStatusPayload(artifact, overrides), null, 2),
    "utf8",
  );
}

function updateReportArtifactExcelState(artifact, summary, report, markdown, excelStatus, excelUrl = "", excelError = "") {
  if (!artifact?.reportId) return;
  const reportDir = reportArtifactDir(artifact.reportId);
  fs.mkdirSync(reportDir, { recursive: true });
  const resolvedExcelStatus = String(excelStatus || artifact.excelStatus || "").trim();
  const resolvedExcelUrl = resolvedExcelStatus === "ready"
    ? (excelUrl || artifact.excelUrl || "")
    : "";
  const next = {
    ...artifact,
    reportId: artifact.reportId,
    shareUrl: artifact.shareUrl || "",
    svgUrl: artifact.svgUrl || "",
    qrSvgUrl: artifact.qrSvgUrl || "",
    excelUrl: resolvedExcelUrl,
    excelStatus: resolvedExcelStatus,
    excelError: excelError || "",
    normalizedDataUrl: artifact.normalizedDataUrl || "",
    diagnosticsUrl: artifact.diagnosticsUrl || "",
  };
  writeReportArtifactStatus(reportDir, next);
  if (report && next.shareUrl) {
    fs.writeFileSync(
      path.join(reportDir, "index.html"),
      renderReportHtml({
        report,
        markdown: markdown || "",
        summary: summary || {},
        shareUrl: next.shareUrl,
        svgUrl: next.svgUrl,
        qrSvgUrl: next.qrSvgUrl,
        excelUrl: next.excelUrl,
        excelStatus: next.excelStatus,
        excelError: next.excelError,
      }),
      "utf8",
    );
  }
}

function runReviewWorkbookWorker(workerOptions) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, {
      workerData: {
        type: "review-workbook",
        ...workerOptions,
      },
    });
    let settled = false;
    let timeout = null;
    const settle = (error, value) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (error) reject(error);
      else resolve(value);
    };
    if (reviewWorkbookTimeoutMs > 0) {
      timeout = setTimeout(() => {
        worker.terminate().catch(() => null);
        settle(new Error(`Excel汇总生成超过${Math.ceil(reviewWorkbookTimeoutMs / 60000)}分钟未完成，已转为后台失败状态。`));
      }, reviewWorkbookTimeoutMs);
    }
    worker.once("message", (message) => {
      if (message?.ok) settle(null, message);
      else settle(new Error(message?.error || "Excel汇总生成线程处理失败。"));
    });
    worker.once("error", (error) => settle(error));
    worker.once("exit", (code) => {
      if (code !== 0) settle(new Error(`Excel汇总生成线程异常退出：${code}`));
    });
  });
}

async function handleReviewWorkbookWorker() {
  const options = workerData || {};
  const workbookInputPath = String(options.workbookInputPath || "");
  const reportJsonPath = String(options.reportJsonPath || "");
  const workbookPath = String(options.workbookPath || "");
  const legacyWorkbookPath = String(options.legacyWorkbookPath || "");
  if ((!workbookInputPath && !reportJsonPath) || !workbookPath) {
    throw new Error("Excel汇总生成参数不完整。");
  }
  const saved = JSON.parse(fs.readFileSync(workbookInputPath || reportJsonPath, "utf8"));
  await writeReviewWorkbook(workbookPath, saved.summary || {}, saved.report || {});
  if (legacyWorkbookPath && path.resolve(legacyWorkbookPath) !== path.resolve(workbookPath)) {
    fs.copyFileSync(workbookPath, legacyWorkbookPath);
  }
}

async function updateReviewWorkbookStatus(reportDbId, excelStatus, excelUrl = "", excelError = "") {
  if (!reportDbId) return;
  const status = String(excelStatus || "").trim();
  const url = String(excelUrl || "").trim();
  const errorText = String(excelError || "").trim().slice(0, 2000);
  if (await isDbAvailable()) {
    await queryDb(
      `update review_reports
       set excel_status=$2,
           excel_url=case
             when $2 = 'ready' and coalesce($3, '') <> '' then $3
             when $2 in ('generating', 'failed') then ''
             else excel_url
           end,
           excel_error=nullif($4, ''),
           updated_at=now()
       where id=$1`,
      [reportDbId, status, url, errorText],
    );
    await queryDb(
      `insert into review_job_events(report_db_id, event_type, status, progress_stage, progress_percent, message, metadata_json)
       values($1,'excel_status','completed',$2,100,$3,$4::jsonb)`,
      [
        reportDbId,
        status === "ready" ? "excel_ready" : status === "failed" ? "excel_failed" : "excel_generating",
        status === "ready" ? "Excel汇总已生成，可下载。" : status === "failed" ? `Excel汇总生成失败：${errorText || "未知错误"}` : "Excel汇总正在后台生成。",
        jsonParam({ excelStatus: status, excelUrl: url, excelError: errorText }, {}),
      ],
    ).catch(() => null);
    return;
  }
  const data = readLocalData();
  const record = data.reviewReports.find((item) => item.id === reportDbId);
  if (!record) return;
  record.excelStatus = status;
  if (url) record.excelUrl = url;
  if (!url && ["generating", "failed"].includes(status)) record.excelUrl = "";
  record.excelError = errorText;
  record.updatedAt = new Date().toISOString();
  appendLocalReviewJobEvent(data, {
    reportDbId,
    userId: record.userId,
    jobKey: record.jobKey,
    status: "completed",
    progressStage: status === "ready" ? "excel_ready" : status === "failed" ? "excel_failed" : "excel_generating",
    progressPercent: 100,
  }, "excel_status", status === "ready" ? "Excel汇总已生成，可下载。" : status === "failed" ? `Excel汇总生成失败：${errorText || "未知错误"}` : "Excel汇总正在后台生成。", {
    excelStatus: status,
    excelUrl: url,
    excelError: errorText,
  });
  writeLocalData(data);
}

function queueReviewWorkbookGeneration(reportDbId, summary, report, markdown, artifact) {
  if (!reportDbId || !artifact?.reportId) return;
  const jobKey = `${reportDbId}:${artifact.reportId}`;
  if (activeWorkbookJobs.has(jobKey)) return;
  activeWorkbookJobs.add(jobKey);
  let workbookInputPath = "";
  setImmediate(async () => {
    try {
      const lightweightSummary = summaryForResponse(summary) || {};
      artifact.excelStatus = "generating";
      artifact.excelUrl = "";
      updateReportArtifactExcelState(artifact, lightweightSummary, report, markdown, "generating", "", "");
      await updateReviewWorkbookStatus(reportDbId, "generating", "", "");
      const reportDir = reportArtifactDir(artifact.reportId);
      fs.mkdirSync(reportDir, { recursive: true });
      const excelFileName = artifact.excelFileName || reviewWorkbookFileName(summary);
      const workbookPath = path.join(reportDir, excelFileName);
      workbookInputPath = path.join(reportDir, "workbook-input.json");
      fs.writeFileSync(workbookInputPath, JSON.stringify(prepareReviewWorkbookInput(summary, report)), "utf8");
      summary = lightweightSummary;
      await runReviewWorkbookWorker({
        workbookInputPath,
        workbookPath,
        legacyWorkbookPath: path.join(reportDir, "review.xlsx"),
      });
      const readyExcelUrl = reportArtifactEncodedUrl(artifact.shareUrl, excelFileName);
      artifact.excelStatus = "ready";
      artifact.excelUrl = readyExcelUrl;
      updateReportArtifactExcelState(artifact, lightweightSummary, report, markdown, "ready", readyExcelUrl, "");
      await updateReviewWorkbookStatus(reportDbId, "ready", readyExcelUrl, "");
      console.log(`[workbook] ready ${reportDbId} ${artifact.reportId}`);
    } catch (error) {
      const message = error?.message || "Excel汇总生成失败。";
      artifact.excelStatus = "failed";
      artifact.excelUrl = "";
      updateReportArtifactExcelState(artifact, summaryForResponse(summary) || {}, report, markdown, "failed", "", message);
      await updateReviewWorkbookStatus(reportDbId, "failed", "", message).catch(() => null);
      console.error(`[workbook] failed ${reportDbId}:`, error);
    } finally {
      if (workbookInputPath) fs.rmSync(workbookInputPath, { force: true });
      activeWorkbookJobs.delete(jobKey);
    }
  });
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
  const excelFileName = reviewWorkbookFileName(summary);
  const excelUrl = "";
  const excelStatus = "generating";
  const excelError = "";
  const normalizedDataUrl = `${shareUrl}${encodeURIComponent("四季蝉登录获取标准化数据.json")}`;
  const diagnosticsUrl = `${shareUrl}${encodeURIComponent("四季蝉接口诊断.json")}`;
  const qrSvg = await QRCode.toString(shareUrl, {
    type: "svg",
    errorCorrectionLevel: "M",
    margin: 1,
    color: { dark: "#1f3f95", light: "#ffffff" },
  });
  const reportSvg = renderReportSvg({ report, summary, shareUrl, qrSvg });
  const html = renderReportHtml({ report, markdown, summary, shareUrl, svgUrl, qrSvgUrl, excelUrl, excelStatus, excelError });

  fs.writeFileSync(path.join(reportDir, "report.json"), JSON.stringify(reportArtifactJsonPayload({ report, markdown, summary, reportId, shareUrl, svgUrl, qrSvgUrl, excelUrl, excelStatus, excelError, excelFileName, normalizedDataUrl, diagnosticsUrl }), null, 2), "utf8");
  writeReportArtifactStatus(reportDir, { reportId, shareUrl, svgUrl, qrSvgUrl, excelUrl, excelStatus, excelError, normalizedDataUrl, diagnosticsUrl });
  fs.writeFileSync(path.join(reportDir, "四季蝉登录获取标准化数据.json"), JSON.stringify(summary.rawData || {}, null, 2), "utf8");
  fs.writeFileSync(path.join(reportDir, "四季蝉接口诊断.json"), JSON.stringify(summary.interfaceDiagnostics || [], null, 2), "utf8");
  fs.writeFileSync(path.join(reportDir, "index.html"), html, "utf8");
  fs.writeFileSync(path.join(reportDir, "report.svg"), reportSvg, "utf8");
  fs.writeFileSync(path.join(reportDir, "qr.svg"), qrSvg, "utf8");

  return { reportId, shareUrl, svgUrl, qrSvgUrl, excelUrl, excelStatus, excelError, excelFileName, normalizedDataUrl, diagnosticsUrl };
}

async function refreshExistingReportArtifacts(targetReportId = "") {
  if (!fs.existsSync(reportsDir)) return;
  const entries = fs
    .readdirSync(reportsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && (!targetReportId || entry.name === targetReportId));
  for (const entry of entries) {
    const reportDir = path.join(reportsDir, entry.name);
    const jsonPath = path.join(reportDir, "report.json");
    if (!fs.existsSync(jsonPath)) continue;
    try {
      const saved = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
      if (!saved.report || !saved.shareUrl) continue;
      const report = applyCustomerTitleToReport(saved.report, saved.summary || {});
      const markdown = reportToMarkdown(report);
      const qrSvg = await QRCode.toString(saved.shareUrl, {
        type: "svg",
        errorCorrectionLevel: "M",
        margin: 1,
        color: { dark: "#1f3f95", light: "#ffffff" },
      });
      const svgUrl = saved.svgUrl || `${saved.shareUrl.replace(/\/+$/, "")}/report.svg`;
      const qrSvgUrl = saved.qrSvgUrl || `${saved.shareUrl.replace(/\/+$/, "")}/qr.svg`;
      const excelFileName = saved.excelFileName || reviewWorkbookFileName(saved.summary || {});
      const namedWorkbookPath = path.join(reportDir, excelFileName);
      const legacyWorkbookPath = path.join(reportDir, "review.xlsx");
      const workbookExists = fs.existsSync(namedWorkbookPath) || fs.existsSync(legacyWorkbookPath);
      const savedExcelStatus = String(saved.excelStatus || saved.excel_status || "").trim();
      const excelStatus = savedExcelStatus || (workbookExists ? "ready" : "generating");
      const excelUrl = saved.excelUrl || saved.excel_url || (workbookExists ? reportArtifactEncodedUrl(saved.shareUrl, excelFileName) : "");
      const excelError = saved.excelError || saved.excel_error || "";
      const reportSvg = renderReportSvg({ report, summary: saved.summary, shareUrl: saved.shareUrl, qrSvg });
      const html = renderReportHtml({
        report,
        markdown,
        summary: saved.summary,
        shareUrl: saved.shareUrl,
        svgUrl,
        qrSvgUrl,
        excelUrl,
        excelStatus,
        excelError,
      });
      const reportId = saved.reportId || entry.name;
      const normalizedDataUrl = saved.normalizedDataUrl || `${saved.shareUrl}${encodeURIComponent("四季蝉登录获取标准化数据.json")}`;
      const diagnosticsUrl = saved.diagnosticsUrl || `${saved.shareUrl}${encodeURIComponent("四季蝉接口诊断.json")}`;
      const refreshed = { ...saved, report, markdown, reportId, svgUrl, qrSvgUrl, excelUrl, excelStatus, excelError, excelFileName, normalizedDataUrl, diagnosticsUrl };
      fs.writeFileSync(path.join(reportDir, "report.json"), JSON.stringify(reportArtifactJsonPayload({ report, markdown, summary: saved.summary || {}, reportId, shareUrl: saved.shareUrl, svgUrl, qrSvgUrl, excelUrl, excelStatus, excelError, excelFileName, normalizedDataUrl, diagnosticsUrl }), null, 2), "utf8");
      writeReportArtifactStatus(reportDir, refreshed);
      fs.writeFileSync(path.join(reportDir, "index.html"), html, "utf8");
      fs.writeFileSync(path.join(reportDir, "report.svg"), reportSvg, "utf8");
      fs.writeFileSync(path.join(reportDir, "qr.svg"), qrSvg, "utf8");
      if (saved.summary?.rawData) {
        fs.writeFileSync(path.join(reportDir, "四季蝉登录获取标准化数据.json"), JSON.stringify(saved.summary.rawData || {}, null, 2), "utf8");
      }
      if (saved.summary?.interfaceDiagnostics) {
        fs.writeFileSync(path.join(reportDir, "四季蝉接口诊断.json"), JSON.stringify(saved.summary.interfaceDiagnostics || [], null, 2), "utf8");
      }
      if (await isDbAvailable()) {
        await queryDb(
          `update review_reports
           set report_title=$2,
               report_json=jsonb_set(coalesce(report_json, '{}'::jsonb), '{title}', to_jsonb($2::text), true),
               updated_at=now()
           where report_id=$1`,
          [reportId, report.title || "四季蝉AI复盘报告"],
        ).catch(() => null);
        await queryDb(
          `update review_report_payloads p
           set report_json=jsonb_set(coalesce(p.report_json, '{}'::jsonb), '{title}', to_jsonb($2::text), true),
               markdown=$3,
               updated_at=now()
           from review_reports r
           where p.report_db_id=r.id and r.report_id=$1`,
          [reportId, report.title || "四季蝉AI复盘报告", markdown],
        ).catch(() => null);
      }
    } catch (error) {
      console.warn(`Refresh report artifact failed for ${entry.name}: ${error.message}`);
    }
  }
}


async function generateReportFromSummary(summary, user = null) {
  const config = await loadAiConfigForUser(user);
  if (!config.apiKey || !config.model) {
    const error = new Error("AI服务未配置，请在AI配置页面保存自己的API Key，或联系管理员hydee配置兜底API。");
    error.statusCode = 400;
    throw error;
  }

  let report;
  try {
    const promptInstruction = await loadReviewPromptInstruction();
    const prompt = buildPrompt(summary, promptInstruction);
    const reportText = await callConfiguredAI(config, prompt);
    report = normalizeReport(parseReportJson(reportText));
  } catch (error) {
    report = fallbackReportFromSummary(summary, error.message);
  }
  report = applyCustomerTitleToReport(report, summary);
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

function currentSijichanAsOfDate() {
  return dateOnly(new Date());
}

function buildSijichanWindows(asOfText = "") {
  const asOf = new Date(`${asOfText || currentSijichanAsOfDate()}T12:00:00`);
  const current = asOf;
  const last = addMonths(asOf, -1);
  const prev = addMonths(asOf, -2);
  const priorTwoStart = addMonths(asOf, -3);
  const nearStart = addMonths(asOf, -6);
  const prevHalfStart = addMonths(asOf, -12);
  const prevHalfEnd = addMonths(asOf, -7);
  const sameMonthLastYear = addMonths(last, -12);
  const sameNearHalfStart = addMonths(nearStart, -12);
  const sameNearHalfEnd = addMonths(last, -12);
  const previousMonthSamePeriodEnd = new Date(last.getFullYear(), last.getMonth(), Math.min(current.getDate(), monthEnd(last).getDate()));
  return {
    currentMonth: {
      label: "当月",
      start: atStart(dateOnly(monthStart(current))),
      end: atEnd(dateOnly(current)),
    },
    previousMonthSamePeriod: {
      label: "上月同期",
      start: atStart(dateOnly(monthStart(last))),
      end: atEnd(dateOnly(previousMonthSamePeriodEnd)),
    },
    lastMonth: { label: "上月", ...monthWindow(last) },
    previousMonth: { label: "上上月", ...monthWindow(prev) },
    sameMonthLastYear: { label: "去年同月", ...monthWindow(sameMonthLastYear) },
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
    sameNearHalfLastYear: {
      label: "去年同期近半年",
      start: atStart(dateOnly(monthStart(sameNearHalfStart))),
      end: atEnd(dateOnly(monthEnd(sameNearHalfEnd))),
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

function normalizeSijichanToken(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.replace(/^authorization\s*:\s*/i, "").replace(/^bearer\s+/i, "").trim();
}

function assertSijichanTokenFormat(token) {
  const text = normalizeSijichanToken(token);
  if (!text) throw new Error("缺少可用于新零售管理平台接口的授权token。");
  if (text.length < 20) throw new Error("授权token格式过短，请粘贴完整的 Authorization token。");
  return text;
}

function extractSijichanTokenFromText(text) {
  const source = String(text || "");
  const patterns = [
    /(?:Authorization|authorization)\s*[:=]\s*["']?(Bearer\s+)?([A-Za-z0-9._\-]{20,})/i,
    /(?:token|access_token|merchant_token)\s*[:=]\s*["']([A-Za-z0-9._\-]{20,})["']/i,
    /(?:token|access_token|merchant_token)=([A-Za-z0-9._\-]{20,})/i,
  ];
  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match) return normalizeSijichanToken(match[2] || match[1]);
  }
  return "";
}

function clampWeComTokenScanText(value) {
  const text = String(value || "");
  return text.length > weComTokenScanTextLimit ? text.slice(0, weComTokenScanTextLimit) : text;
}

function shouldScanWeComTokenBody({ contentType = "", contentLength = "", url = "", allowSsoJump = false } = {}) {
  const type = String(contentType || "");
  if (!/json|text|html/i.test(type)) return false;
  const length = Number(contentLength || 0);
  if (Number.isFinite(length) && length > weComTokenBodyLimitBytes) return false;
  const href = String(url || "");
  if (allowSsoJump && isWeComSsoJumpUrl(href)) return true;
  if (/industryOrder|imActivityReward|orderShareMoment|report\/(course|activityReward|account|order_share)|queryStatistics|query.*List|summary\/page|rewardTypeStatistics/i.test(href)) {
    return false;
  }
  if (/login|auth|token|sso|app-jump|ewx|wwlogin|super-admin-login|acc\/_login|authorization|session/i.test(href)) return true;
  return Boolean(length && length <= Math.min(32 * 1024, weComTokenBodyLimitBytes));
}

function renderWeComHandoffHelperScript({ endpoint, handoffToken, merCode }) {
  const helperSource = String.raw`
(function(){
  const endpoint = __ENDPOINT__;
  const handoffToken = __HANDOFF_TOKEN__;
  const merCode = __MER_CODE__;
  if (window.__sop4chanTokenHelper) {
    alert("四季蝉授权助手已在监听中，请在新零售页面点击首页、活动或报表页面触发接口请求。");
    return;
  }
  window.__sop4chanTokenHelper = true;
  const sent = new Set();
  const CAPTURE_BODY_LIMIT = 131072;
  const CAPTURE_TEXT_LIMIT = 262144;
  const tokenPattern = /(?:Authorization|authorization)\s*[:=]\s*["']?(?:Bearer\s+)?([A-Za-z0-9._\-]{20,})|(?:token|access_token|merchant_token|accessToken)\s*["']?\s*[:=]\s*["']([A-Za-z0-9._\-]{20,})["']/i;
  const pick = (value) => String(value || "").replace(/^authorization\s*:\s*/i, "").replace(/^Bearer\s+/i, "").trim();
  const looksLikeToken = (value) => {
    const token = pick(value);
    return token.length >= 20 && /^[A-Za-z0-9._\-]+$/.test(token);
  };
  const isBusinessDataUrl = (url) => /industryOrder|imActivityReward|orderShareMoment|report\/(course|activityReward|account|order_share)|queryStatistics|query.*List|summary\/page|rewardTypeStatistics/i.test(String(url || ""));
  const isAuthLikeUrl = (url) => /login|auth|token|sso|app-jump|ewx|wwlogin|super-admin-login|acc\/_login|authorization|session/i.test(String(url || ""));
  const shouldScanBody = (url, contentType, contentLength) => {
    if (!/json|text|html/i.test(String(contentType || ""))) return false;
    const length = Number(contentLength || 0);
    if (Number.isFinite(length) && length > CAPTURE_BODY_LIMIT) return false;
    if (isBusinessDataUrl(url)) return false;
    return isAuthLikeUrl(url) || Boolean(length && length <= 32768);
  };
  const tokenFromText = (text) => {
    const match = String(text || "").slice(0, CAPTURE_TEXT_LIMIT).match(tokenPattern);
    return match ? pick(match[1] || match[2] || "") : "";
  };
  async function send(raw, from) {
    const token = pick(raw);
    if (!looksLikeToken(token) || sent.has(token)) return;
    sent.add(token);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handoffToken, token, merCode, from, href: location.href, capturedAt: new Date().toISOString() }),
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok) {
        window.__sop4chanTokenCaptured = true;
        alert("已捕获新零售授权token并交给四季蝉服务器，可以回到门户生成报告。");
      } else {
        console.warn("四季蝉授权交接失败", data);
        alert(data.error || "授权交接失败");
      }
    } catch (error) {
      console.error("四季蝉授权交接请求失败", error);
      alert("授权交接请求失败：" + ((error && error.message) || error));
    }
  }
  function scanHeaders(headers, from) {
    if (!headers) return;
    try {
      const normalized = new Headers(headers);
      send(normalized.get("Authorization") || normalized.get("authorization"), from + ":authorization");
      normalized.forEach((value, key) => {
        if (/token|authorization/i.test(key) || /Bearer\s+|token|access_token|merchant_token/i.test(value)) {
          send(value, from + ":" + key);
        }
      });
    } catch (error) {
      if (Array.isArray(headers)) {
        headers.forEach((item) => {
          if (Array.isArray(item)) scanHeaders({ [item[0]]: item[1] }, from);
        });
      } else if (headers && typeof headers === "object") {
        Object.keys(headers).forEach((key) => {
          const value = headers[key];
          if (/token|authorization/i.test(key) || /Bearer\s+|token|access_token|merchant_token/i.test(value)) {
            send(value, from + ":" + key);
          }
        });
      }
    }
  }
  function scanText(text, from) {
    const token = tokenFromText(text);
    if (token) send(token, from);
  }
  function scanStore() {
    [localStorage, sessionStorage].forEach((store) => {
      try {
        ["token", "access_token", "accessToken", "Authorization", "authorization", "sijichan_token", "merchant_token"].forEach((key) => {
          send(store.getItem(key), "storage:" + key);
        });
        for (let index = 0; index < store.length; index += 1) {
          const key = store.key(index);
          const value = store.getItem(key) || "";
          if (/token|authorization/i.test(key)) send(value, "storage-key:" + key);
          scanText(value, "storage-value:" + key);
        }
      } catch (error) {}
    });
  }
  scanStore();
  const originalFetch = window.fetch;
  if (originalFetch && !originalFetch.__sop4chanWrapped) {
    const wrappedFetch = function(input, init) {
      try {
        scanHeaders(input && input.headers, "fetch-input");
        scanHeaders(init && init.headers, "fetch-init");
        if (input && input.url) scanText(input.url, "fetch-url");
        if (typeof input === "string") scanText(input, "fetch-url");
      } catch (error) {}
      return originalFetch.apply(this, arguments).then((response) => {
        try {
          scanHeaders(response && response.headers, "fetch-response");
          const contentType = response.headers && response.headers.get && response.headers.get("content-type");
          const contentLength = response.headers && response.headers.get && response.headers.get("content-length");
          const responseUrl = response.url || (input && input.url) || (typeof input === "string" ? input : "");
          if (shouldScanBody(responseUrl, contentType, contentLength)) {
            response.clone().text().then((text) => scanText(text, "fetch-body")).catch(() => {});
          }
        } catch (error) {}
        return response;
      });
    };
    wrappedFetch.__sop4chanWrapped = true;
    window.fetch = wrappedFetch;
  }
  const xhrProto = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
  if (xhrProto && !xhrProto.__sop4chanWrapped) {
    xhrProto.__sop4chanWrapped = true;
    const originalOpen = xhrProto.open;
    const originalSetHeader = xhrProto.setRequestHeader;
    xhrProto.open = function(method, url) {
      this.__sop4chanUrl = url;
      scanText(url, "xhr-url");
      return originalOpen.apply(this, arguments);
    };
    xhrProto.setRequestHeader = function(key, value) {
      if (/token|authorization/i.test(key) || /Bearer\s+|token|access_token|merchant_token/i.test(value)) {
        send(value, "xhr-request:" + key);
      }
      return originalSetHeader.apply(this, arguments);
    };
    const originalSend = xhrProto.send;
    xhrProto.send = function(body) {
      scanText(this.__sop4chanUrl, "xhr-send-url");
      scanText(body, "xhr-send-body");
      this.addEventListener("load", function() {
        try {
          send(this.getResponseHeader("Authorization"), "xhr-response:authorization");
          if (shouldScanBody(this.responseURL || this.__sop4chanUrl, this.getResponseHeader("content-type"), this.getResponseHeader("content-length"))) {
            scanText(this.responseText, "xhr-response-body");
          }
        } catch (error) {}
      });
      return originalSend.apply(this, arguments);
    };
  }
  let rounds = 0;
  const timer = setInterval(() => {
    scanStore();
    rounds += 1;
    if (window.__sop4chanTokenCaptured || rounds >= 120) clearInterval(timer);
  }, 5000);
  alert("四季蝉授权助手已启动：请在新零售页面点击首页/活动/报表等页面，助手会自动捕获接口token并回传服务器。");
})();`;
  return helperSource
    .replace("__ENDPOINT__", JSON.stringify(endpoint))
    .replace("__HANDOFF_TOKEN__", JSON.stringify(handoffToken))
    .replace("__MER_CODE__", JSON.stringify(merCode || ""))
    .replace(/\s+/g, " ")
    .trim();
}

function findChromiumExecutable() {
  const configured = String(process.env.CHROMIUM_EXECUTABLE_PATH || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "").trim();
  const candidates = [
    configured,
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/snap/bin/chromium",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || "";
}

function playwrightLaunchOptions() {
  const executablePath = findChromiumExecutable();
  const homeDir = process.env.HOME || os.homedir() || "/home/hydee";
  const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
  return {
    ...(executablePath ? { executablePath } : {}),
    headless: true,
    env: {
      ...process.env,
      HOME: homeDir,
      XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${uid}`,
      PATH: `${process.env.PATH || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"}:/snap/bin`,
    },
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  };
}

function weComBrowserProfileDir(userId = "", sessionId = "") {
  const safeUser = String(userId || "default").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "default";
  const safeSession = String(sessionId || "").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
  const dir = safeSession
    ? path.join(serverDir, "wecom-browser-profile", safeUser, safeSession)
    : path.join(serverDir, "wecom-browser-profile", safeUser);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function markSijichanHandoffCapturedById(handoffId, userId, token, details = {}) {
  const normalizedToken = assertSijichanTokenFormat(token);
  if (!(await isDbAvailable())) throw new Error("数据库未连接，无法保存企微授权token。");
  const tokenExpiresAt = details.expiresAt ? new Date(details.expiresAt) : null;
  const result = await queryDb(
    `update sijichan_token_handoffs
     set status='captured',
         token_encrypted=$3,
         token_expires_at=$4,
         captured_at=now(),
         last_error=null,
         updated_at=now()
     where id=$1 and user_id=$2 and expires_at > now()
     returning *`,
    [handoffId, userId, encryptSecret(normalizedToken), tokenExpiresAt && !Number.isNaN(tokenExpiresAt.getTime()) ? tokenExpiresAt.toISOString() : null],
  );
  if (!result.rows[0]) throw new Error("企微授权交接会话不存在或已过期。");
  return normalizeSijichanTokenHandoff(result.rows[0]);
}

async function updateSijichanHandoffMerName(handoffId, userId, merName) {
  const name = String(merName || "").trim();
  if (!handoffId || !userId || !name || !(await isDbAvailable())) return;
  await queryDb(
    `update sijichan_token_handoffs
     set mer_name=$3, updated_at=now()
     where id=$1 and user_id=$2 and coalesce(mer_name, '') <> $3`,
    [handoffId, userId, name],
  ).catch(() => null);
}

function getWeComBrowserSessionDebug(session) {
  return {
    exportProbeDetails: Array.isArray(session?.exportProbeDetails) ? session.exportProbeDetails.slice(0, 8) : [],
    ssoDiagnostics: Array.isArray(session?.ssoDiagnostics) ? session.ssoDiagnostics.slice(-8) : [],
    openPages: Array.isArray(session?.openPages) ? session.openPages.slice(-8) : [],
  };
}

function getWeComBrowserSessionPublic(session, options = {}) {
  const merchantReady = Boolean(session.currentUrl && canProbeMerchantBusiness(session.currentUrl));
  const loginPageReady = Boolean(session.currentUrl && /merchants\.hydee\.cn\/app-login/i.test(session.currentUrl));
  const next = {
    id: session.id,
    handoffId: session.handoff?.id || "",
    status: session.status,
    captured: session.status === "captured",
    merchantReady,
    loginPageReady,
    profileReuse: Boolean(session.profileReuse),
    exportReady: Boolean(session.exportReady),
    exportProbeAt: session.exportProbeAt || "",
    exportProbeError: session.exportProbeError || "",
    autoReport: session.autoReport || null,
    merCodeFilled: Boolean(session.merCodeFilled),
    merCodeSubmitTried: Boolean(session.merCodeSubmitTried),
    merchantCodeFillAvailable: Boolean(session.merchantCodeFillAvailable),
    scanStage: session.scanStage || "",
    scanHint: session.scanHint || "",
    pageTextHint: session.pageTextHint || "",
    qrImage: session.qrImage || "",
    currentUrl: session.currentUrl || "",
    lastRequestUrl: session.lastRequestUrl || "",
    pageTitle: session.pageTitle || "",
    screenshotUrl: session.id ? `/api/wecom-browser-session/${encodeURIComponent(session.id)}/screenshot` : "",
    lastError: session.lastError || "",
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    expiresAt: session.handoff?.expiresAt || session.expiresAt || "",
  };
  if (options.includeDebug) Object.assign(next, getWeComBrowserSessionDebug(session));
  return next;
}

function logWeComSessionState(session, reason = "state") {
  if (!session) return;
  const compactUrl = (value) => {
    try {
      const parsed = new URL(String(value || ""));
      return `${parsed.origin}${parsed.pathname}`;
    } catch {
      return String(value || "").slice(0, 180);
    }
  };
  const snapshot = {
    status: session.status || "",
    captured: session.status === "captured",
    merchantReady: Boolean(session.currentUrl && canProbeMerchantBusiness(session.currentUrl)),
    exportReady: Boolean(session.exportReady),
    pageTitle: session.pageTitle || "",
    scanStage: session.scanStage || "",
    scanHint: session.scanHint || "",
    currentUrl: compactUrl(session.currentUrl || ""),
    openPages: Array.isArray(session.openPages) ? session.openPages.slice(-4).map((page) => ({
      title: page.title || "",
      url: compactUrl(page.url || ""),
      merchantReady: Boolean(page.url && canProbeMerchantBusiness(page.url)),
    })) : [],
    exportProbeError: session.exportProbeError || "",
    exportProbeDetails: Array.isArray(session.exportProbeDetails) ? session.exportProbeDetails.slice(0, 4) : [],
    ssoDiagnostics: Array.isArray(session.ssoDiagnostics) ? session.ssoDiagnostics.slice(-3) : [],
  };
  const nextKey = JSON.stringify(snapshot);
  if (session.lastLoggedStateKey === nextKey) return;
  session.lastLoggedStateKey = nextKey;
  console.log(`[wecom-browser] ${reason} ${session.id} ${nextKey}`);
}

async function closeWeComBrowserSession(session, status = "") {
  if (!session) return;
  if (session.pollTimer) clearInterval(session.pollTimer);
  if (session.expireTimer) clearTimeout(session.expireTimer);
  session.pollTimer = null;
  session.expireTimer = null;
  if (status && session.status !== "captured") session.status = status;
  session.updatedAt = new Date().toISOString();
  try {
    if (session.context) await session.context.close();
    if (session.browser) await session.browser.close();
  } catch (error) {
    console.warn(`WeCom browser close skipped: ${error.message}`);
  }
  session.context = null;
  session.browser = null;
  if (session.profileDir && !session.profileReuse) {
    fs.rm(session.profileDir, { recursive: true, force: true }, () => {});
  }
  if (session.id) activeWeComBrowserSessions.delete(session.id);
}

async function closeActiveWeComBrowserSessionsForUser(userId, keepSessionId = "") {
  const targets = Array.from(activeWeComBrowserSessions.values())
    .filter((session) => session.userId === userId && session.id !== keepSessionId);
  await Promise.allSettled(targets.map((session) => closeWeComBrowserSession(session, "closed")));
}

async function clearExpiredMerchantState(context) {
  if (!context) return;
  await context.clearCookies().catch(() => null);
  const cleanupPage = await context.newPage().catch(() => null);
  if (!cleanupPage) return;
  try {
    await cleanupPage.goto(`${sijichanApiOrigin}/`, { waitUntil: "domcontentloaded", timeout: 12000 }).catch(() => null);
    await cleanupPage.evaluate(() => {
      try { localStorage.clear(); } catch {}
      try { sessionStorage.clear(); } catch {}
      try {
        if (window.indexedDB?.databases) {
          window.indexedDB.databases().then((items) => {
            (items || []).forEach((item) => item?.name && window.indexedDB.deleteDatabase(item.name));
          }).catch(() => null);
        }
      } catch {}
      try {
        if (window.caches?.keys) {
          window.caches.keys().then((keys) => keys.forEach((key) => window.caches.delete(key))).catch(() => null);
        }
      } catch {}
      try {
        document.cookie.split(";").forEach((item) => {
          const name = item.split("=")[0]?.trim();
          if (name) document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/`;
        });
      } catch {}
    }).catch(() => null);
  } finally {
    await cleanupPage.close().catch(() => null);
  }
}

async function dataUrlFromRemoteImage(url) {
  if (!url) return "";
  const response = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 SOP_4CHAN QR fetch",
      accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
    },
  });
  if (!response.ok) throw new Error(`二维码图片获取失败：${response.status}`);
  const contentType = response.headers.get("content-type") || "image/png";
  const bytes = Buffer.from(await response.arrayBuffer());
  return `data:${contentType.split(";")[0]};base64,${bytes.toString("base64")}`;
}

function isMerchantRuntimeUrl(url) {
  try {
    const parsed = new URL(String(url || ""), sijichanApiOrigin);
    if (parsed.hostname !== "merchants.hydee.cn") return false;
    if (/\/app-login/i.test(parsed.pathname)) return false;
    if (/\/app-jump\/(super-admin-login|ewx-login)/i.test(parsed.pathname)) return false;
    if (/^\/(home|index|dashboard)?$/i.test(parsed.pathname)) return true;
    const routeText = `${parsed.pathname}${parsed.hash}${parsed.search}`;
    return /businesses-gateway|super-admin|merchant|mer-manager|report|activity|industryOrder|imActivityReward|orderShareMoment/i.test(routeText);
  } catch {
    return false;
  }
}

function isMerchantHostUrl(url) {
  try {
    return new URL(String(url || ""), sijichanApiOrigin).hostname === "merchants.hydee.cn";
  } catch {
    return false;
  }
}

function canProbeMerchantBusiness(url) {
  try {
    const parsed = new URL(String(url || ""), sijichanApiOrigin);
    if (parsed.hostname !== "merchants.hydee.cn") return false;
    if (/\/app-login/i.test(parsed.pathname)) return false;
    if (/\/app-jump\/(super-admin-login|ewx-login)/i.test(parsed.pathname)) return false;
    return parsed.pathname === "/" || /^\/(home|index|dashboard)?$/i.test(parsed.pathname) || isMerchantRuntimeUrl(parsed.href);
  } catch {
    return false;
  }
}

function canAttemptMerchantCodeFill(url) {
  try {
    const parsed = new URL(String(url || ""), sijichanApiOrigin);
    if (parsed.hostname !== "merchants.hydee.cn") return false;
    if (/\/app-login/i.test(parsed.pathname)) return false;
    return true;
  } catch {
    return false;
  }
}

function isWeComSsoJumpUrl(url) {
  try {
    const parsed = new URL(String(url || ""), sijichanApiOrigin);
    return parsed.hostname === "merchants.hydee.cn" && /\/app-jump\/(super-admin-login|ewx-login)/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

async function detectMerchantCodeInputInPage(page) {
  if (!page || page.isClosed()) return false;
  return page.evaluate(() => {
    const isVisible = (node) => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const dialog = [...document.querySelectorAll(".h-modal, .ant-modal, .el-dialog, .modal, [role='dialog'], body")]
      .find((node) => isVisible(node) && /选择适用用户|商户编码|客户编码|适用用户/i.test(node.textContent || ""));
    if (dialog && [...dialog.querySelectorAll("input, textarea")].some(isVisible)) return true;
    const candidates = Array.from(document.querySelectorAll("input, textarea"));
    return candidates.some((input) => {
      const text = [
        input.name,
        input.id,
        input.placeholder,
        input.getAttribute("aria-label"),
        input.closest("label")?.textContent,
        input.parentElement?.textContent,
        input.closest(".h-form-item, .ant-form-item, .h-modal, .ant-modal, .el-dialog, .modal")?.textContent,
      ].filter(Boolean).join(" ");
      return /客户编码|客户代码|商户编码|适用用户|门店编码|merCode|merchantCode|customerCode/i.test(text);
    });
  }).catch(() => false);
}

async function fillMerchantCodeInPage(page, merCode) {
  if (!page || page.isClosed()) return false;
  const code = String(merCode || "").trim();
  if (!code) return false;
  return page.evaluate((nextMerCode) => {
    const isVisible = (node) => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const dialog = [...document.querySelectorAll(".h-modal, .ant-modal, .el-dialog, .modal, [role='dialog'], body")]
      .find((node) => isVisible(node) && /选择适用用户|商户编码|客户编码|适用用户/i.test(node.textContent || ""));
    const dialogInput = dialog ? [...dialog.querySelectorAll("input, textarea")].find(isVisible) : null;
    const candidates = Array.from(document.querySelectorAll("input, textarea"));
    const target = dialogInput || candidates.find((input) => {
      const text = [
        input.name,
        input.id,
        input.placeholder,
        input.getAttribute("aria-label"),
        input.closest("label")?.textContent,
        input.parentElement?.textContent,
        input.closest(".h-form-item, .ant-form-item, .h-modal, .ant-modal, .el-dialog, .modal")?.textContent,
      ].filter(Boolean).join(" ");
      return /客户编码|客户代码|商户编码|适用用户|门店编码|merCode|merchantCode|customerCode/i.test(text);
    });
    if (!target) return false;
    target.focus();
    target.value = nextMerCode;
    target.dispatchEvent(new Event("input", { bubbles: true }));
    target.dispatchEvent(new Event("change", { bubbles: true }));
    ["keydown", "keypress", "keyup"].forEach((type) => {
      target.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", bubbles: true }));
    });
    const buttonScope = dialog || document;
    const buttons = Array.from(buttonScope.querySelectorAll("button, [role='button'], .ant-btn, .h-button, .el-button"));
    const action = buttons.find((button) => /确认|确定|登录|进入|查询|切换|提交|搜索|下一步|授权/i.test(button.textContent || button.getAttribute("aria-label") || ""));
    if (action) {
      action.click();
      return "filled-clicked";
    }
    return "filled";
  }, code).catch(() => false);
}

async function createWeComBrowserSession(user, body = {}) {
  let chromium;
  try {
    ({ chromium } = require("playwright-core"));
  } catch (error) {
    throw new Error("服务器未安装 playwright-core，暂不能使用服务器扫码模式。");
  }
  await closeActiveWeComBrowserSessionsForUser(user.id);
  const profileReuse = Boolean(body.profileReuse);
  const handoff = await createSijichanTokenHandoff(user, { ...body, ttlMs: profileReuse ? 6 * 60 * 60 * 1000 : 30 * 60 * 1000 });
  const baseUrl = publicReportBaseUrl.replace(/\/+$/, "");
  const merchantRedirect = `${sijichanApiOrigin}/app-jump/super-admin-login`;
  const merchantWecomSsoUrl = `https://login.work.weixin.qq.com/wwlogin/sso/login/?login_type=CorpApp&appid=ww408c023179829552&agentid=1000157&redirect_uri=${encodeURIComponent(merchantRedirect)}&state=WWLogin`;
  const session = {
    id: createId("wbs"),
    userId: user.id,
    handoff,
    status: "opening",
    qrImage: "",
    currentUrl: "",
    lastRequestUrl: "",
    openPages: [],
    pageTitle: "",
    scanStage: "",
    scanHint: "",
    ssoDiagnostics: [],
    lastError: "",
    browser: null,
    context: null,
    page: null,
    profileReuse,
    merchantCodeFillAvailable: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    expiresAt: handoff.expiresAt,
  };
  activeWeComBrowserSessions.set(session.id, session);
  const tokenPattern = /(?:Authorization|authorization)\s*[:=]\s*["']?(?:Bearer\s+)?([A-Za-z0-9._\-]{20,})|(?:token|access_token|merchant_token|accessToken)\s*["']?\s*[:=]\s*["']([A-Za-z0-9._\-]{20,})["']/i;
  const addSsoDiagnostic = (item = {}) => {
    session.ssoDiagnostics = Array.isArray(session.ssoDiagnostics) ? session.ssoDiagnostics : [];
    const next = {
      at: new Date().toISOString(),
      from: item.from || "",
      status: item.status || "",
      path: item.path || "",
      location: item.location || "",
      codeSeen: Boolean(item.codeSeen),
      tokenFound: Boolean(item.tokenFound),
      message: item.message || "",
    };
    session.ssoDiagnostics.push(next);
    session.ssoDiagnostics = session.ssoDiagnostics.slice(-12);
    session.updatedAt = next.at;
  };
  const refreshOpenPages = async () => {
    const context = session.browser?.contexts?.()?.[0];
    const pages = context?.pages?.() || [];
    const items = [];
    for (const pageItem of pages) {
      if (!pageItem || pageItem.isClosed()) continue;
      if (pageItem.url() === "about:blank" && pageItem !== session.page) continue;
      items.push({
        url: pageItem.url(),
        title: await pageItem.title().catch(() => ""),
        current: pageItem === session.page,
      });
    }
    session.openPages = items.sort((a, b) => Number(Boolean(b.current)) - Number(Boolean(a.current))).slice(0, 10);
    session.updatedAt = new Date().toISOString();
  };
  const selectBestMerchantPage = async () => {
    const context = session.browser?.contexts?.()?.[0];
    const pages = context?.pages?.() || [];
    const visiblePages = pages.filter((pageItem) => pageItem && !pageItem.isClosed() && pageItem.url() !== "about:blank");
    const runtimePage = visiblePages.find((pageItem) => canProbeMerchantBusiness(pageItem.url()));
    const codePage = visiblePages.find((pageItem) => canAttemptMerchantCodeFill(pageItem.url()) && !/login\.work\.weixin\.qq\.com/i.test(pageItem.url()));
    const best = runtimePage || codePage || session.page;
    if (best && !best.isClosed() && best !== session.page) {
      session.page = best;
      session.currentUrl = best.url();
      session.pageTitle = await best.title().catch(() => session.pageTitle || "");
    }
    await refreshOpenPages().catch(() => null);
    return best && !best.isClosed() ? best : null;
  };
  const syncMerchantHeaderUserName = async (reason = "") => {
    if (!session.page || session.page.isClosed() || !isMerchantHostUrl(session.page.url())) return "";
    const merName = await session.page.evaluate(() => {
      const selectors = [
        ".vi-header-user__name span",
        ".vi-header-user__name",
        "[class*='vi-header-user__name'] span",
        "[class*='vi-header-user__name']",
      ];
      for (const selector of selectors) {
        const node = document.querySelector(selector);
        const text = (node?.textContent || "").replace(/\s+/g, " ").trim();
        if (text && !/退出登录|个人信息|打印服务/i.test(text)) return text;
      }
      return "";
    }).catch(() => "");
    const name = String(merName || "").trim();
    if (!name) return "";
    if (session.handoff) {
      session.handoff.merName = name;
      await updateSijichanHandoffMerName(session.handoff.id, user.id, name);
    }
    session.detectedMerName = name;
    session.updatedAt = new Date().toISOString();
    if (reason) logWeComSessionState(session, `merchant-name:${reason}`);
    return name;
  };
  const refreshScanStage = async () => {
    await selectBestMerchantPage().catch(() => null);
    if (!session.page || session.page.isClosed()) return;
    const pageUrl = session.page.url();
    if (/merchants\.hydee\.cn\/app-login/i.test(pageUrl)) {
      session.scanStage = "login_expired";
      session.scanHint = session.qrImage ? "企微二维码已生成，请扫码确认登录" : "服务器登录态已失效，请重新企微扫码";
      return;
    }
    if (isMerchantRuntimeUrl(pageUrl)) {
      session.scanStage = "merchant";
      session.scanHint = "已进入新零售管理平台";
      await syncMerchantHeaderUserName("scan-stage").catch(() => "");
      session.pageTextHint = await session.page.evaluate(() => (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 220)).catch(() => "");
      return;
    }
    const state = await session.page.evaluate(() => {
      const text = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
      const image = document.querySelector(".wwLogin_qrcode_img") || [...document.images].find((img) => /qrcode/i.test(img.src || ""));
      return { text: text.slice(0, 500), hasQr: Boolean(image) };
    }).catch(() => ({ text: "", hasQr: false }));
    const text = state.text || "";
    if (/选择访问用户|商户编码|客户编码|访问用户|适用用户/i.test(text)) {
      session.scanStage = "merchant_code";
      session.scanHint = "已进入访问用户页面，请手动填写客户编码并点击登录";
      session.pageTextHint = text.slice(0, 220);
    } else if (/已扫码|扫描成功|请在企业微信中确认|请在手机上确认|请确认|确认登录/i.test(text)) {
      session.scanStage = "confirming";
      session.scanHint = "已扫码，等待企业微信手机端确认";
    } else if (/二维码已失效|二维码失效|已过期|重新刷新|刷新二维码/i.test(text)) {
      session.scanStage = "qr_expired";
      session.scanHint = "二维码已过期，请重新生成";
    } else if (/登录失败|扫码失败|无权限|未授权|拒绝/i.test(text)) {
      session.scanStage = "failed";
      session.scanHint = text.slice(0, 160) || "企微扫码失败";
    } else if (state.hasQr || /扫码|二维码|企业微信/i.test(text)) {
      session.scanStage = "waiting_scan";
      session.scanHint = "等待企业微信扫码";
    } else {
      session.scanStage = "unknown";
      session.scanHint = text.slice(0, 160);
    }
    session.pageTextHint = text.slice(0, 220);
  };
  const openWeComFromMerchantLogin = async () => {
    if (!session.page || session.page.isClosed()) return false;
    if (!/merchants\.hydee\.cn\/app-login/i.test(session.page.url())) return false;
    let clicked = false;
    for (const pattern of [/企微扫码登录/, /企业微信扫码登录/, /企业微信/]) {
      try {
        const locator = session.page.getByText(pattern).last();
        if (await locator.count()) {
          await locator.click({ timeout: 3000 });
          clicked = true;
          break;
        }
      } catch {
        // try the DOM fallback below
      }
    }
    if (!clicked) clicked = await session.page.evaluate(() => {
      const candidates = [
        ...document.querySelectorAll("button, a, span, div, p"),
      ].map((node) => {
        const rect = node.getBoundingClientRect();
        return { node, text: (node.innerText || node.textContent || "").trim(), area: rect.width * rect.height, visible: rect.width > 0 && rect.height > 0 };
      }).filter((item) => item.visible && /企微扫码登录|企业微信扫码登录|企业微信|企微/i.test(item.text))
        .sort((a, b) => a.area - b.area);
      const targetItem = candidates.find((item) => {
        const node = item.node;
        const rect = node.getBoundingClientRect();
        return rect.width > 20 && rect.height > 12 && rect.width < 260 && rect.height < 80;
      });
      const target = targetItem?.node?.closest?.("button,a,[role='button']") || targetItem?.node;
      if (!target) return false;
      target.click();
      return true;
    }).catch(() => false);
    if (clicked) {
      session.scanStage = "opening_wecom";
      session.scanHint = "正在打开企微扫码登录";
      session.updatedAt = new Date().toISOString();
      await session.page.waitForTimeout(1200).catch(() => null);
      await refreshOpenPages().catch(() => null);
      await refreshScanStage().catch(() => null);
      return true;
    }
    await session.page.goto(merchantWecomSsoUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => null);
    session.currentUrl = session.page.url();
    session.pageTitle = await session.page.title().catch(() => session.pageTitle || "");
    await refreshOpenPages().catch(() => null);
    await refreshScanStage().catch(() => null);
    return true;
  };
  const refreshWeComQrImage = async (reason = "") => {
    if (!session.page || session.page.isClosed() || isMerchantRuntimeUrl(session.page.url())) return false;
    await openWeComFromMerchantLogin().catch(() => false);
    const now = Date.now();
    if (reason === "expired" && session.lastQrReloadAt && now - session.lastQrReloadAt < 60000) return false;
    if (reason === "expired") {
      session.qrRefreshCount = Number(session.qrRefreshCount || 0) + 1;
      if (session.qrRefreshCount > 8) return false;
      session.lastQrReloadAt = now;
      await session.page.goto(merchantWecomSsoUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => null);
    }
    const qrImageUrl = await session.page.evaluate(() => {
      const image = document.querySelector(".wwLogin_qrcode_img") || [...document.images].find((img) => /qrcode/i.test(img.src || ""));
      return image ? image.src : "";
    }).catch(() => "");
    if (qrImageUrl) {
      session.qrImage = await dataUrlFromRemoteImage(qrImageUrl);
      session.currentUrl = session.page.url();
      session.pageTitle = await session.page.title().catch(() => session.pageTitle || "");
      await refreshOpenPages().catch(() => null);
      await refreshScanStage().catch(() => null);
      session.updatedAt = new Date().toISOString();
      logWeComSessionState(session, reason === "expired" ? "qr-refreshed" : "qr-image");
      return true;
    }
    return false;
  };
  const maybeCapture = async (raw, from, sourceUrl = "", options = {}) => {
    if (session.status === "captured") return;
    const runtimeUrl = sourceUrl || session.currentUrl || "";
    const allowSsoJump = Boolean(options.allowSsoJump);
    const allowMerchantHost = Boolean(options.allowMerchantHost);
    if (!isMerchantRuntimeUrl(runtimeUrl) && !(allowSsoJump && isWeComSsoJumpUrl(runtimeUrl)) && !(allowMerchantHost && isMerchantHostUrl(runtimeUrl))) return;
    const sourceText = clampWeComTokenScanText(raw);
    const match = sourceText.match(tokenPattern);
    if (!match && !options.explicitToken) return;
    const token = normalizeSijichanToken(match ? (match[1] || match[2] || "") : raw);
    if (!token || token.length < 20 || !/^[A-Za-z0-9._\-]+$/.test(token)) return;
    try {
      const validation = await validateSijichanTokenCandidate(token, handoff.merCode);
      if (!validation.ok) {
        const message = `候选授权不可用：HTTP ${validation.status || "-"}${validation.code ? ` / ${validation.code}` : ""}${validation.message ? ` / ${validation.message}` : ""}`;
        if (allowSsoJump || isWeComSsoJumpUrl(runtimeUrl)) {
          addSsoDiagnostic({ from, path: "/app-jump/super-admin-login", tokenFound: false, message });
        }
        session.lastError = message;
        session.updatedAt = new Date().toISOString();
        logWeComSessionState(session, `candidate-token-rejected:${from}`);
        return;
      }
      const capturedHandoff = await markSijichanHandoffCapturedById(handoff.id, user.id, token, { from, href: runtimeUrl });
      if (!capturedHandoff.merCode) {
        const recent = await findRecentSijichanMerInfoForUser(user.id);
        if (recent?.merCode) {
          capturedHandoff.merCode = recent.merCode;
          capturedHandoff.merName = capturedHandoff.merName || recent.merName || "";
        }
      }
      await upsertSijichanTokenAuthorization(user.id, {
        token,
        merCode: capturedHandoff.merCode,
        merName: capturedHandoff.merName,
        username: `wecom_${capturedHandoff.merCode || capturedHandoff.id}`,
      }, { requestInfo: { merCode: capturedHandoff.merCode, merName: capturedHandoff.merName } }).catch((error) => {
        console.warn(`[wecom-browser] token authorization persist skipped: ${error.message}`);
      });
      session.status = "captured";
      session.lastError = "";
      session.updatedAt = new Date().toISOString();
      if (allowSsoJump || isWeComSsoJumpUrl(runtimeUrl)) {
        addSsoDiagnostic({ from, path: "/app-jump/super-admin-login", tokenFound: true, message: "企微跳转中发现可用授权" });
      }
      logWeComSessionState(session, `captured:${from}`);
      triggerWeComTokenAutoReport(user.id, capturedHandoff, token, `server-browser:${from}`);
      triggerWeComBrowserAutoReport(session, `captured:${from}`);
    } catch (error) {
      session.lastError = error.message || "服务器扫码 token 保存失败。";
      session.updatedAt = new Date().toISOString();
    }
  };
  const inspectSsoJumpResponse = async (response, from = "response") => {
    const url = response.url();
    if (!isWeComSsoJumpUrl(url)) return;
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      parsed = null;
    }
    const headers = await response.allHeaders().catch(() => response.headers());
    const setCookies = await response.headerValues("set-cookie").catch(() => []);
    const location = headers.location || headers.Location || await response.headerValue("location").catch(() => "") || "";
    const status = response.status();
    const contentType = headers["content-type"] || "";
    const headerText = [
      ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
      ...setCookies.map((value) => `set-cookie: ${value}`),
    ].join("\n");
    const headerCandidateToken = extractSijichanTokenFromText(`${location}\n${headerText}`);
    addSsoDiagnostic({
      from,
      status,
      path: parsed ? parsed.pathname : "/app-jump/super-admin-login",
      location: location ? location.slice(0, 240) : "",
      codeSeen: Boolean(parsed?.searchParams?.get("code")),
      tokenFound: Boolean(headerCandidateToken),
      message: headerCandidateToken ? "检测到企微 SSO 跳转响应，发现候选授权，正在验证" : "检测到企微 SSO 跳转响应",
    });
    await maybeCapture(`${location}\n${headerText}`, `server-browser-sso-${from}-headers`, url, { allowSsoJump: true });
    if (shouldScanWeComTokenBody({ contentType, contentLength: headers["content-length"], url, allowSsoJump: true })) {
      const text = await response.text().catch(() => "");
      if (text) {
        const scanText = clampWeComTokenScanText(text);
        const bodyCandidateToken = extractSijichanTokenFromText(scanText);
        addSsoDiagnostic({
          from: `${from}-body`,
          status,
          path: parsed ? parsed.pathname : "/app-jump/super-admin-login",
          codeSeen: Boolean(parsed?.searchParams?.get("code")),
          tokenFound: Boolean(bodyCandidateToken),
          message: `${bodyCandidateToken ? "发现候选授权，正在验证；" : ""}${scanText.slice(0, 180).replace(/\s+/g, " ")}`,
        });
        await maybeCapture(scanText, `server-browser-sso-${from}-body`, url, { allowSsoJump: true });
      }
    }
  };
  const scanMerchantPageStorage = async () => {
    if (!session.page || session.page.isClosed() || !isMerchantHostUrl(session.page.url())) return;
    const storageItems = await session.page.evaluate(() => {
      const items = [];
      const readStore = (store, storeName) => {
        for (let index = 0; index < store.length; index += 1) {
          const key = store.key(index);
          const value = store.getItem(key) || "";
          if (/token|authorization|access/i.test(key) || /token|authorization|access_token|Bearer\s+/i.test(value)) {
            items.push({ key, value, storeName });
          }
        }
      };
      try { readStore(localStorage, "localStorage"); } catch {}
      try { readStore(sessionStorage, "sessionStorage"); } catch {}
      return items.slice(0, 30);
    }).catch(() => []);
    for (const item of storageItems) {
      await maybeCapture(item.value, `server-browser-${item.storeName}:${item.key}`, session.page.url(), { allowMerchantHost: true });
    }
  };
  const scanMerchantCookies = async () => {
    if (!session.page || session.page.isClosed() || !isMerchantHostUrl(session.page.url())) return;
    const cookies = await session.page.context().cookies(sijichanApiOrigin).catch(() => []);
    for (const cookie of cookies) {
      const key = cookie?.name || "";
      const value = cookie?.value || "";
      if (/token|authorization|access|jwt|_?pati/i.test(key) || /Bearer\s+/i.test(value)) {
        await maybeCapture(value, `server-browser-cookie:${key}`, session.page.url(), { allowMerchantHost: true });
      }
    }
  };
  const updateMerchantCodeFillAvailability = async () => {
    if (!session.page || session.page.isClosed() || !canAttemptMerchantCodeFill(session.page.url())) {
      session.merchantCodeFillAvailable = false;
      return false;
    }
    session.merchantCodeFillAvailable = await detectMerchantCodeInputInPage(session.page);
    if (session.merchantCodeFillAvailable && !session.merCodeSubmitTried) {
      session.scanStage = "merchant_code";
      session.scanHint = "已进入访问用户页面，正在自动填写客户编码";
      session.pageTextHint = await session.page.evaluate(() => (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 220)).catch(() => session.pageTextHint || "");
      session.updatedAt = new Date().toISOString();
    }
    return session.merchantCodeFillAvailable;
  };
  const autoFillMerchantCodeIfReady = async (reason = "") => {
    if (!session.page || session.page.isClosed() || session.merCodeSubmitTried) return false;
    const merCode = String(session.handoff?.merCode || body.merCode || "").trim();
    if (!/^\d{6}$/.test(merCode)) {
      if (session.merchantCodeFillAvailable) {
        session.lastError = "已进入访问用户页面，但未提供6位客户编码，无法自动填写。";
        session.scanHint = "已进入访问用户页面，请先填写6位客户编码";
        session.updatedAt = new Date().toISOString();
      }
      return false;
    }
    if (!canAttemptMerchantCodeFill(session.page.url())) return false;
    const available = await updateMerchantCodeFillAvailability().catch(() => false);
    if (!available) return false;
    session.scanStage = "merchant_code";
    session.scanHint = "已进入访问用户页面，正在自动填写客户编码";
    session.updatedAt = new Date().toISOString();
    const filled = await fillMerchantCodeInPage(session.page, merCode);
    if (!filled) {
      session.lastError = "已检测到客户编码输入框，但自动填写失败，可点击“重新提交客户编码”。";
      session.updatedAt = new Date().toISOString();
      logWeComSessionState(session, `auto-mer-code-failed:${reason}`);
      return false;
    }
    session.handoff.merCode = merCode;
    session.handoff.merName = String(session.handoff?.merName || body.merName || "").trim();
    session.merCodeFilled = true;
    session.merCodeSubmitTried = filled === "filled-clicked";
    session.merchantCodeFillAvailable = false;
    session.lastError = "";
    session.scanStage = "merchant_code_submitted";
    session.scanHint = "客户编码已自动提交，正在进入新零售管理平台";
    session.updatedAt = new Date().toISOString();
    await session.page.waitForTimeout(3000).catch(() => null);
    await session.page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => null);
    await selectBestMerchantPage().catch(() => null);
    if (session.page && !session.page.isClosed()) {
      session.currentUrl = session.page.url();
      session.pageTitle = await session.page.title().catch(() => session.pageTitle || "");
    }
    await refreshOpenPages().catch(() => null);
    await refreshScanStage().catch(() => null);
    await syncMerchantHeaderUserName("auto-code").catch(() => "");
    await scanMerchantPageStorage().catch(() => null);
    await scanMerchantCookies().catch(() => null);
    await triggerMerchantProbe().catch(() => null);
    await probeExportReady().catch(() => null);
    logWeComSessionState(session, `auto-mer-code-${filled}:${reason}`);
    return true;
  };
  const noteMerchantReady = () => {
    const ready = Boolean(session.page && !session.page.isClosed() && canProbeMerchantBusiness(session.page.url()));
    if (ready && !session.merchantReadyAt) session.merchantReadyAt = Date.now();
    if (!ready) session.merchantReadyAt = 0;
    return ready;
  };
  const merchantStableEnough = (delayMs = 6000) => {
    if (!noteMerchantReady()) return false;
    return Boolean(session.merchantReadyAt && Date.now() - session.merchantReadyAt >= delayMs);
  };
  const triggerMerchantProbe = async () => {
    if (!session.page || session.page.isClosed() || !merchantStableEnough()) return;
    const now = Date.now();
    if (session.lastProbeAt && now - session.lastProbeAt < 8000) return;
    session.lastProbeAt = now;
    const probeUrls = [
      `${sijichanMerchantPathBase}report/activityReward/queryTopStatisticData`,
      `${sijichanMerchantPathBase}report/account/emp/overview/queryRewardStat`,
      `${sijichanMerchantPathBase}report/order_share/orderShareMomentSummary`,
    ];
    for (const url of probeUrls) {
      await session.page.evaluate((nextUrl) => {
        fetch(nextUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
          credentials: "include",
        }).catch(() => null);
      }, url).catch(() => null);
    }
    session.updatedAt = new Date().toISOString();
  };
  const probeExportReady = async () => {
    if (!session.page || session.page.isClosed() || !merchantStableEnough() || session.exportReady) return;
    const now = Date.now();
    if (session.lastExportProbeAt && now - session.lastExportProbeAt < 10000) return;
    session.lastExportProbeAt = now;
    try {
      const probes = [
        { label: "活动奖励概览", url: `${sijichanManagerPathBase}report/activityReward/queryTopStatisticData`, body: {} },
        { label: "店员奖励概览", url: `${sijichanManagerPathBase}report/account/emp/overview/queryRewardStat`, body: {} },
        { label: "晒单打赏概览", url: `${sijichanManagerPathBase}report/order_share/orderShareMomentSummary`, body: {} },
        { label: "销售概览", url: `${sijichanManagerPathBase}industryOrder/queryProductOverview`, body: saleBody(buildSijichanWindows("2026-06-06").lastMonth) },
      ];
      const results = await session.page.evaluate(async ({ items, origin }) => {
        const readJson = (text) => {
          try { return JSON.parse(text); } catch { return { raw: text }; }
        };
        const run = async (item) => {
          try {
            const response = await fetch(item.url, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(item.body || {}),
              credentials: "include",
            });
            const text = await response.text();
            const json = readJson(text);
            return {
              label: item.label,
              path: new URL(item.url, origin).pathname,
              status: response.status,
              code: json?.code || "",
              msg: json?.msg || json?.message || "",
              hasData: Boolean(json?.data),
              dataType: Array.isArray(json?.data) ? "array" : json?.data && typeof json.data === "object" ? "object" : typeof json?.data,
            };
          } catch (error) {
            return { label: item.label, path: "", status: 0, code: "", msg: error?.message || "probe failed", hasData: false, dataType: "" };
          }
        };
        return Promise.all(items.map(run));
      }, { items: probes, origin: sijichanApiOrigin });
      session.exportProbeDetails = results;
      const success = results.find((item) => item.status >= 200 && item.status < 500 && (!item.code || String(item.code) === "10000"));
      if (success) {
        session.exportReady = true;
        session.exportProbeError = "";
        triggerWeComBrowserAutoReport(session, `export-ready:${success.label || ""}`);
      } else {
        const firstError = results.find((item) => item.msg || item.code || item.status);
        session.exportProbeError = firstError ? `${firstError.label}：${firstError.msg || firstError.code || `HTTP ${firstError.status}`}` : "业务接口探测未返回有效结果";
      }
      session.exportProbeAt = new Date().toISOString();
      session.updatedAt = session.exportProbeAt;
      logWeComSessionState(session, "export-probe");
    } catch (error) {
      session.exportProbeError = error.message || "服务器浏览器导出探测失败。";
      session.exportProbeAt = new Date().toISOString();
      session.updatedAt = session.exportProbeAt;
      logWeComSessionState(session, "export-probe-error");
    }
  };
  session.prepareBrowserExport = async () => {
    await selectBestMerchantPage().catch(() => null);
    if (!session.page || session.page.isClosed()) return;
    await syncMerchantHeaderUserName("prepare").catch(() => "");
    await updateMerchantCodeFillAvailability().catch(() => null);
    await autoFillMerchantCodeIfReady("prepare").catch(() => null);
    await syncMerchantHeaderUserName("prepare-after-code").catch(() => "");
    await triggerMerchantProbe().catch(() => null);
    await probeExportReady().catch(() => null);
  };
  session.focusBestMerchantPage = selectBestMerchantPage;
  const tryExchangeWeComCodeFromUrl = async (pageUrl) => {
    if (session.weComCodeExchangeTried || session.status === "captured") return;
    let parsed;
    try {
      parsed = new URL(String(pageUrl || ""));
    } catch {
      return;
    }
    const code = parsed.searchParams.get("code") || "";
    const state = parsed.searchParams.get("state") || "";
    if (!code) return;
    session.weComCodeExchangeTried = true;
    session.updatedAt = new Date().toISOString();
    try {
      const exchanged = await exchangeWeComCodeForSijichanToken({ code, handoffId: handoff.id, state });
      if (exchanged.token) {
        const validation = await validateSijichanTokenCandidate(exchanged.token, handoff.merCode);
        if (!validation.ok) {
          const message = `企微code候选授权验证失败：HTTP ${validation.status || "-"}${validation.code ? ` / ${validation.code}` : ""}${validation.message ? ` / ${validation.message}` : ""}`;
          session.lastError = message;
          addSsoDiagnostic({ from: "server-browser-code", path: "/app-jump/super-admin-login", tokenFound: false, message });
          await markSijichanHandoffError(state || handoff.handoffToken, message);
          logWeComSessionState(session, "code-token-rejected");
          return;
        }
        const capturedHandoff = await markSijichanHandoffCapturedById(handoff.id, user.id, exchanged.token, {
          from: "server-browser-wecom-code",
          href: pageUrl,
        });
        session.status = "captured";
        session.lastError = "";
        session.updatedAt = new Date().toISOString();
        await upsertSijichanTokenAuthorization(user.id, {
          token: exchanged.token,
          merCode: capturedHandoff.merCode || handoff.merCode,
          merName: capturedHandoff.merName || handoff.merName,
          username: `wecom_${capturedHandoff.merCode || handoff.merCode || handoff.id}`,
        }, { requestInfo: { merCode: capturedHandoff.merCode || handoff.merCode, merName: capturedHandoff.merName || handoff.merName } }).catch((error) => {
          console.warn(`[wecom-browser] code token authorization persist skipped: ${error.message}`);
        });
        triggerWeComTokenAutoReport(user.id, capturedHandoff, exchanged.token, "server-browser-code");
        triggerWeComBrowserAutoReport(session, "server-browser-code");
        logWeComSessionState(session, "code-token-captured");
      } else {
        const message = (exchanged.diagnostics || []).join("；") || "企微code未换取到业务token";
        session.lastError = message;
        await markSijichanHandoffError(state || handoff.handoffToken, message);
        logWeComSessionState(session, "code-token-empty");
      }
    } catch (error) {
      session.lastError = error.message || "企微code换取业务token失败";
      await markSijichanHandoffError(state || handoff.handoffToken, session.lastError);
      logWeComSessionState(session, "code-token-error");
    }
  };
  try {
    session.profileDir = weComBrowserProfileDir(user.id, body.profileReuse ? "" : session.id);
    const context = await chromium.launchPersistentContext(session.profileDir, {
      ...playwrightLaunchOptions(),
      viewport: { width: 1280, height: 900 },
    });
    session.context = context;
    const browser = context.browser();
    session.browser = browser;
    if (!session.profileReuse) await clearExpiredMerchantState(context);
    browser?.on("disconnected", () => {
      if (session.status !== "captured" && session.status !== "expired" && session.status !== "error") {
        session.status = "error";
        session.lastError = "服务器浏览器进程已退出，请重新创建扫码会话。";
        session.updatedAt = new Date().toISOString();
      }
    });
    const attachMerchantPage = (nextPage) => {
      if (!nextPage || nextPage === session.page || nextPage.isClosed()) return;
      if (/merchants\.hydee\.cn\/app-login/i.test(nextPage.url())) return;
      session.page = nextPage;
      session.currentUrl = nextPage.url();
      nextPage.title().then((title) => {
        session.pageTitle = title || session.pageTitle || "";
        session.updatedAt = new Date().toISOString();
        refreshOpenPages().catch(() => null);
        refreshScanStage().catch(() => null);
        logWeComSessionState(session, "merchant-popup");
      }).catch(() => null);
      nextPage.on("close", () => {
        if (session.page === nextPage && session.status !== "captured" && session.status !== "expired" && session.status !== "error") {
          session.status = "error";
          session.lastError = "服务器浏览器页面已关闭，请重新创建扫码会话。";
          session.updatedAt = new Date().toISOString();
        }
      });
      nextPage.on("request", (request) => {
        session.lastRequestUrl = request.url();
        tryExchangeWeComCodeFromUrl(request.url()).catch(() => null);
        if (isWeComSsoJumpUrl(request.url())) {
          let parsed;
          try { parsed = new URL(request.url()); } catch { parsed = null; }
          addSsoDiagnostic({
            from: "request",
            path: parsed ? parsed.pathname : "/app-jump/super-admin-login",
            codeSeen: Boolean(parsed?.searchParams?.get("code")),
            message: "浏览器请求企微 SSO 跳转地址",
          });
        }
        const headers = request.headers();
        maybeCapture(headers.authorization || headers.Authorization, "server-browser-request-header", request.url(), { explicitToken: true });
        maybeCapture(request.url(), "server-browser-request-url", request.url());
        const postData = request.postData();
        if (postData) maybeCapture(postData, "server-browser-request-body", request.url());
      });
      nextPage.on("response", async (response) => {
        session.lastRequestUrl = response.url();
        tryExchangeWeComCodeFromUrl(response.url()).catch(() => null);
        await inspectSsoJumpResponse(response, "response").catch((error) => {
          addSsoDiagnostic({ from: "response-error", path: "/app-jump/super-admin-login", message: error.message || "SSO 响应检查失败" });
        });
        const headers = response.headers();
        maybeCapture(headers.authorization || headers.Authorization, "server-browser-response-header", response.url(), { explicitToken: true });
        const contentType = headers["content-type"] || "";
        if (shouldScanWeComTokenBody({ contentType, contentLength: headers["content-length"], url: response.url() })) {
          response.text().then((text) => maybeCapture(clampWeComTokenScanText(text), "server-browser-response-body", response.url())).catch(() => null);
        }
      });
      nextPage.on("framenavigated", (frame) => {
        if (frame === nextPage.mainFrame()) {
          session.currentUrl = frame.url();
          nextPage.title().then((title) => {
            session.pageTitle = title || "";
            session.updatedAt = new Date().toISOString();
            refreshOpenPages().catch(() => null);
            refreshScanStage().catch(() => null);
            logWeComSessionState(session, "navigate");
          }).catch(() => null);
          session.updatedAt = new Date().toISOString();
          logWeComSessionState(session, "navigate");
          tryExchangeWeComCodeFromUrl(session.currentUrl).catch(() => null);
          selectBestMerchantPage().catch(() => null);
          noteMerchantReady();
          if (canProbeMerchantBusiness(session.currentUrl)) triggerWeComBrowserAutoReport(session, "merchant-ready-navigate");
          scanMerchantPageStorage().catch(() => null);
          scanMerchantCookies().catch(() => null);
          updateMerchantCodeFillAvailability().then(() => autoFillMerchantCodeIfReady("popup-navigate")).catch(() => null);
          triggerMerchantProbe().catch(() => null);
          probeExportReady().catch(() => null);
        }
      });
    };
    context.on("page", (nextPage) => {
      nextPage.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => null).finally(() => {
        if (canAttemptMerchantCodeFill(nextPage.url())) attachMerchantPage(nextPage);
      });
      nextPage.on("framenavigated", () => {
        if (canAttemptMerchantCodeFill(nextPage.url())) attachMerchantPage(nextPage);
      });
    });
    await context.exposeBinding("sop4chanCaptureToken", async (source, payload = {}) => {
      const from = payload.from || `server-browser-binding:${source.frame?.url?.() || ""}`;
      const href = payload.href || source.frame?.url?.() || session.currentUrl;
      await maybeCapture(payload.token || payload.authorization || payload.text || "", from, href);
    });
    await context.addInitScript(() => {
      if (window.__sop4chanServerHookInstalled) return;
      window.__sop4chanServerHookInstalled = true;
      const CAPTURE_BODY_LIMIT = 131072;
      const CAPTURE_TEXT_LIMIT = 262144;
      const tokenPattern = /(?:Authorization|authorization)\s*[:=]\s*["']?(?:Bearer\s+)?([A-Za-z0-9._\-]{20,})|(?:token|access_token|merchant_token|accessToken)\s*["']?\s*[:=]\s*["']([A-Za-z0-9._\-]{20,})["']/i;
      const pushToken = (value, from) => {
        const text = (typeof value === "string" ? value : JSON.stringify(value || "")).slice(0, CAPTURE_TEXT_LIMIT);
        const match = text.match(tokenPattern);
        const token = match ? (match[1] || match[2] || "") : text;
        if (!token || token.length < 20 || !window.sop4chanCaptureToken) return;
        window.sop4chanCaptureToken({ token, from, href: location.href }).catch(() => null);
      };
      const isBusinessDataUrl = (url) => /industryOrder|imActivityReward|orderShareMoment|report\/(course|activityReward|account|order_share)|queryStatistics|query.*List|summary\/page|rewardTypeStatistics/i.test(String(url || ""));
      const isAuthLikeUrl = (url) => /login|auth|token|sso|app-jump|ewx|wwlogin|super-admin-login|acc\/_login|authorization|session/i.test(String(url || ""));
      const shouldScanBody = (url, contentType, contentLength) => {
        if (!/json|text|html/i.test(String(contentType || ""))) return false;
        const length = Number(contentLength || 0);
        if (Number.isFinite(length) && length > CAPTURE_BODY_LIMIT) return false;
        if (isBusinessDataUrl(url)) return false;
        return isAuthLikeUrl(url) || Boolean(length && length <= 32768);
      };
      const headersToText = (headers) => {
        try {
          if (!headers) return "";
          if (headers instanceof Headers) return Array.from(headers.entries()).map(([key, value]) => `${key}: ${value}`).join("\n");
          if (Array.isArray(headers)) return headers.map(([key, value]) => `${key}: ${value}`).join("\n");
          if (typeof headers === "object") return Object.entries(headers).map(([key, value]) => `${key}: ${value}`).join("\n");
          return String(headers);
        } catch {
          return "";
        }
      };
      const originalFetch = window.fetch;
      if (originalFetch) {
        window.fetch = async function patchedFetch(input, init) {
          try {
            pushToken(headersToText(init?.headers || input?.headers), "fetch-request-headers");
            pushToken(init?.body || "", "fetch-request-body");
          } catch {}
          const response = await originalFetch.apply(this, arguments);
          try {
            pushToken(headersToText(response.headers), "fetch-response-headers");
            const contentType = response.headers?.get?.("content-type") || "";
            const contentLength = response.headers?.get?.("content-length") || "";
            const responseUrl = response.url || input?.url || (typeof input === "string" ? input : "");
            if (shouldScanBody(responseUrl, contentType, contentLength)) {
              response.clone().text().then((text) => pushToken(text, "fetch-response-body")).catch(() => null);
            }
          } catch {}
          return response;
        };
      }
      const originalOpen = XMLHttpRequest.prototype.open;
      const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
      const originalSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function patchedOpen(method, url) {
        this.__sop4chanUrl = url;
        this.__sop4chanHeaders = {};
        return originalOpen.apply(this, arguments);
      };
      XMLHttpRequest.prototype.setRequestHeader = function patchedSetRequestHeader(name, value) {
        this.__sop4chanHeaders = this.__sop4chanHeaders || {};
        this.__sop4chanHeaders[name] = value;
        pushToken(`${name}: ${value}`, "xhr-request-header");
        return originalSetRequestHeader.apply(this, arguments);
      };
      XMLHttpRequest.prototype.send = function patchedSend(body) {
        pushToken(headersToText(this.__sop4chanHeaders), "xhr-request-headers");
        pushToken(body || "", "xhr-request-body");
        this.addEventListener("load", () => {
          try {
            pushToken(this.getAllResponseHeaders(), "xhr-response-headers");
            if (shouldScanBody(this.responseURL || this.__sop4chanUrl, this.getResponseHeader("content-type"), this.getResponseHeader("content-length"))) {
              pushToken(this.responseText || "", "xhr-response-body");
            }
          } catch {}
        });
        return originalSend.apply(this, arguments);
      };
    });
    const page = await context.newPage();
    session.page = page;
    page.on("close", () => {
      if (session.page === page && session.status !== "captured" && session.status !== "expired" && session.status !== "error") {
        session.status = "error";
        session.lastError = "服务器浏览器页面已关闭，请重新创建扫码会话。";
        session.updatedAt = new Date().toISOString();
      }
    });
    page.on("request", (request) => {
      session.lastRequestUrl = request.url();
      tryExchangeWeComCodeFromUrl(request.url()).catch(() => null);
      if (isWeComSsoJumpUrl(request.url())) {
        let parsed;
        try { parsed = new URL(request.url()); } catch { parsed = null; }
        addSsoDiagnostic({
          from: "request",
          path: parsed ? parsed.pathname : "/app-jump/super-admin-login",
          codeSeen: Boolean(parsed?.searchParams?.get("code")),
          message: "浏览器请求企微 SSO 跳转地址",
        });
      }
      const headers = request.headers();
      maybeCapture(headers.authorization || headers.Authorization, "server-browser-request-header", request.url(), { explicitToken: true });
      maybeCapture(request.url(), "server-browser-request-url", request.url());
      const postData = request.postData();
      if (postData) maybeCapture(postData, "server-browser-request-body", request.url());
    });
    page.on("response", async (response) => {
      session.lastRequestUrl = response.url();
      tryExchangeWeComCodeFromUrl(response.url()).catch(() => null);
      await inspectSsoJumpResponse(response, "response").catch((error) => {
        addSsoDiagnostic({ from: "response-error", path: "/app-jump/super-admin-login", message: error.message || "SSO 响应检查失败" });
      });
      const headers = response.headers();
      maybeCapture(headers.authorization || headers.Authorization, "server-browser-response-header", response.url(), { explicitToken: true });
      const contentType = headers["content-type"] || "";
      if (shouldScanWeComTokenBody({ contentType, contentLength: headers["content-length"], url: response.url() })) {
        response.text().then((text) => maybeCapture(clampWeComTokenScanText(text), "server-browser-response-body", response.url())).catch(() => null);
      }
    });
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) {
        session.currentUrl = frame.url();
        page.title().then((title) => {
          session.pageTitle = title || "";
          session.updatedAt = new Date().toISOString();
          refreshOpenPages().catch(() => null);
          refreshScanStage().catch(() => null);
          logWeComSessionState(session, "navigate");
        }).catch(() => null);
        session.updatedAt = new Date().toISOString();
        logWeComSessionState(session, "navigate");
        tryExchangeWeComCodeFromUrl(session.currentUrl).catch(() => null);
        selectBestMerchantPage().catch(() => null);
        noteMerchantReady();
        if (canProbeMerchantBusiness(session.currentUrl)) triggerWeComBrowserAutoReport(session, "merchant-ready-navigate");
        scanMerchantPageStorage().catch(() => null);
        scanMerchantCookies().catch(() => null);
        updateMerchantCodeFillAvailability().then(() => autoFillMerchantCodeIfReady("main-navigate")).catch(() => null);
        triggerMerchantProbe().catch(() => null);
        probeExportReady().catch(() => null);
      }
    });
    const initialUrl = session.profileReuse ? `${sijichanApiOrigin}/` : merchantWecomSsoUrl;
    await page.goto(initialUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    session.currentUrl = page.url();
    session.pageTitle = await page.title().catch(() => "");
    await refreshOpenPages().catch(() => null);
    await refreshScanStage().catch(() => null);
    if (session.profileReuse && canProbeMerchantBusiness(page.url())) {
      noteMerchantReady();
      if (canProbeMerchantBusiness(page.url())) triggerWeComBrowserAutoReport(session, "profile-reuse-merchant-ready");
      await scanMerchantPageStorage().catch(() => null);
      await scanMerchantCookies().catch(() => null);
      await updateMerchantCodeFillAvailability().catch(() => null);
      await triggerMerchantProbe().catch(() => null);
      await probeExportReady().catch(() => null);
    } else if (session.profileReuse) {
      await page.goto(merchantWecomSsoUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => null);
      session.currentUrl = page.url();
      session.pageTitle = await page.title().catch(() => "");
      await refreshOpenPages().catch(() => null);
      await refreshScanStage().catch(() => null);
    }
    if (page.isClosed()) throw new Error("服务器浏览器页面已关闭，无法生成企微二维码。");
    const qrLoaded = !isMerchantRuntimeUrl(page.url()) && /login\.work\.weixin\.qq\.com\/wwlogin\/sso\/login/i.test(page.url())
      ? await (async () => {
          const qrImageUrl = await page.evaluate(() => {
            const image = document.querySelector(".wwLogin_qrcode_img") || [...document.images].find((img) => /qrcode/i.test(img.src || ""));
            return image ? image.src : "";
          }).catch(() => "");
          if (!qrImageUrl) return false;
          session.qrImage = await dataUrlFromRemoteImage(qrImageUrl);
          session.currentUrl = page.url();
          session.pageTitle = await page.title().catch(() => session.pageTitle || "");
          await refreshOpenPages().catch(() => null);
          await refreshScanStage().catch(() => null);
          session.updatedAt = new Date().toISOString();
          logWeComSessionState(session, "qr-image");
          return true;
        })()
      : isMerchantRuntimeUrl(page.url()) ? false : await refreshWeComQrImage("initial");
    if (!qrLoaded && !isMerchantRuntimeUrl(page.url())) session.qrImage = `data:image/png;base64,${(await page.screenshot({ fullPage: false })).toString("base64")}`;
    page.waitForTimeout(1000)
      .then(async () => {
        if (!page.isClosed() && session.status === "waiting_scan" && /login\.work\.weixin\.qq\.com\/wwlogin\/sso\/login/i.test(page.url())) {
          const nextQrImageUrl = await page.evaluate(() => {
            const image = document.querySelector(".wwLogin_qrcode_img") || [...document.images].find((img) => /qrcode/i.test(img.src || ""));
            return image ? image.src : "";
          }).catch(() => "");
          if (nextQrImageUrl) session.qrImage = await dataUrlFromRemoteImage(nextQrImageUrl);
          session.currentUrl = page.url();
          session.pageTitle = await page.title().catch(() => session.pageTitle || "");
          await refreshOpenPages().catch(() => null);
          await refreshScanStage().catch(() => null);
          session.updatedAt = new Date().toISOString();
        }
      })
      .catch(() => null);
    session.status = "waiting_scan";
    session.updatedAt = new Date().toISOString();
    logWeComSessionState(session, "qr-ready");
    session.pollTimer = setInterval(async () => {
      try {
        if (session.page && !["expired", "error"].includes(session.status)) {
          session.currentUrl = session.page.url();
          session.pageTitle = await session.page.title().catch(() => session.pageTitle || "");
          await refreshOpenPages();
          await refreshScanStage();
          await selectBestMerchantPage();
          noteMerchantReady();
          if (canProbeMerchantBusiness(session.currentUrl)) triggerWeComBrowserAutoReport(session, "merchant-ready-poll");
          if (session.scanStage === "qr_expired") await refreshWeComQrImage("expired");
          session.updatedAt = new Date().toISOString();
          await scanMerchantPageStorage();
          await scanMerchantCookies();
          await updateMerchantCodeFillAvailability();
          await autoFillMerchantCodeIfReady("poll");
          await triggerMerchantProbe();
          await probeExportReady();
        }
      } catch {
        // keep session alive until expiry
      }
    }, 3000);
    session.pollTimer.unref?.();
    session.expireTimer = setTimeout(async () => {
      if (session.status !== "expired") {
        session.status = "expired";
        session.lastError = session.profileReuse ? "服务器扫码监控会话已过期，已保留浏览器登录资料，可重新检测服务器已登录态。" : "服务器扫码会话已过期，请重新创建。";
        session.updatedAt = new Date().toISOString();
        await closeWeComBrowserSession(session, "expired");
      }
    }, session.profileReuse ? 6 * 60 * 60 * 1000 : 30 * 60 * 1000);
    session.expireTimer.unref?.();
    return getWeComBrowserSessionPublic(session);
  } catch (error) {
    session.status = "error";
    session.lastError = error.message || "服务器扫码会话创建失败。";
    session.updatedAt = new Date().toISOString();
    console.error(`[wecom-browser] session ${session.id} failed:`, error);
    await closeWeComBrowserSession(session, "error");
    throw new Error(session.lastError);
  }
}

async function createWeComBrowserProfileSession(user, body = {}) {
  const publicSession = await createWeComBrowserSession(user, { ...body, profileReuse: true });
  const session = activeWeComBrowserSessions.get(publicSession.id);
  if (!session) return publicSession;
  session.profileReuse = true;
  if (session.page && !session.page.isClosed()) {
    await session.page.goto(`${sijichanApiOrigin}/`, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => null);
    session.currentUrl = session.page.url();
    session.pageTitle = await session.page.title().catch(() => session.pageTitle || "");
    session.updatedAt = new Date().toISOString();
  }
  return getWeComBrowserSessionPublic(session);
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
    Cookie: `_pati=${token}`,
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

async function validateSijichanTokenCandidate(token, merCode = "") {
  const normalizedToken = assertSijichanTokenFormat(token);
  let response;
  try {
    response = await fetch(`${sijichanManagerBase}report/activityReward/queryTopStatisticData`, {
      method: "POST",
      headers: sijichanHeaders(normalizedToken, merCode),
      body: JSON.stringify(merCode ? { merCode } : {}),
    });
  } catch (error) {
    return { ok: false, token: normalizedToken, status: 0, code: "", message: `验证请求失败：${networkErrorMessage(error)}` };
  }
  const text = await response.text().catch(() => "");
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  const code = String(json?.code || "");
  const ok = response.ok && (!code || code === "10000");
  return {
    ok,
    token: normalizedToken,
    status: response.status,
    code,
    message: json?.msg || json?.message || (ok ? "token验证通过" : text.slice(0, 180)),
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

function createSijichanBrowserClient(page, merCode, diagnostics) {
  const browserPost = async (endpoint, body) => {
    if (!page || page.isClosed()) throw new Error("服务器浏览器会话已关闭，无法继续取数。");
    const url = `${sijichanManagerPathBase}${endpoint}`;
    const result = await page.evaluate(
      async ({ url, body, merCode }) => {
        const headers = { "content-type": "application/json" };
        if (merCode) {
          headers.merCode = merCode;
          headers.isSuper = "1";
        }
        const response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body || {}),
          credentials: "include",
        });
        const text = await response.text();
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          json = { raw: text };
        }
        return {
          status: response.status,
          response: json,
        };
      },
      { url, body: body || {}, merCode },
    );
    if (result.response?.code && String(result.response.code) !== "10000") {
      if (String(result.response.code) === "40301") {
        throw new Error(`${endpoint} 接口返回 40301：服务器浏览器已打开页面，但当前登录态无权限或已失效。`);
      }
      throw new Error(`${endpoint} 接口返回失败：${result.response.msg || result.response.code}`);
    }
    return {
      endpoint,
      status: result.status,
      request: body || {},
      response: result.response,
      fetchedAt: new Date().toISOString(),
    };
  };
  const browserPaged = async (endpoint, baseBody, pageSize = 1000, options = {}) => {
    const pages = [];
    const rows = [];
    const maxPages = Number(options.maxPages || 0);
    let totalCount = 0;
    let totalPages = 1;
    for (let currentPage = 1; currentPage <= totalPages; currentPage += 1) {
      const result = await browserPost(endpoint, { ...baseBody, currentPage, pageSize });
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
  };
  return {
    async post(label, endpoint, body) {
      try {
        const result = await browserPost(endpoint, body);
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
        const result = await browserPaged(endpoint, body, pageSize, options);
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
    { key: "employeeParticipation", label: "员工参与", value: employeeParticipationSignal, level: employeeParticipationSignal ? (totalWithdrawMoney || employeeCoverage ? "healthy" : "watch") : "risk", explanation: employeeParticipationSignal ? `识别到店员参与/豆豆/提现信号约 ${employeeParticipationSignal}，提现金额约 ${totalWithdrawMoney}。` : "缺少员工参与或提现信号，店员感知会变弱。" },
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
  return collectSijichanDataWithToken({
    token: login.token,
    merCode: body.merCode,
    merName: body.merName || login.merName,
    loginUserName: login.userName,
    loginSystem: login.loginSystem,
    source: "登录获取",
    asOf: body.asOf,
  });
}

async function collectSijichanDataWithToken({ token, merCode: inputMerCode = "", merName: inputMerName = "", loginUserName = "", loginSystem = "", source = "企微扫码授权", asOf = "" } = {}) {
  const normalizedToken = assertSijichanTokenFormat(token);
  const merCode = String(inputMerCode || "").trim();
  const merName = String(inputMerName || "").trim();
  const diagnostics = [];
  const client = createSijichanClient(normalizedToken, merCode, diagnostics);
  return collectSijichanDataWithClient({ client, diagnostics, merCode, merName, loginUserName, loginSystem, source, asOf });
}

async function collectSijichanDataWithBrowserSession(session, { merCode: inputMerCode = "", merName: inputMerName = "", source = "企微扫码授权", asOf = "" } = {}) {
  if (typeof session?.focusBestMerchantPage === "function") await session.focusBestMerchantPage().catch(() => null);
  if (typeof session?.prepareBrowserExport === "function") await session.prepareBrowserExport().catch(() => null);
  if (!session?.page || session.page.isClosed()) throw new Error("服务器扫码浏览器会话已关闭，请重新扫码。");
  if (!canProbeMerchantBusiness(session.page.url())) throw new Error("服务器浏览器尚未进入新零售管理平台，请扫码确认登录后再生成报告。");
  const merCode = String(inputMerCode || session.handoff?.merCode || "").trim();
  const merName = String(inputMerName || session.handoff?.merName || "").trim();
  const diagnostics = [];
  const client = createSijichanBrowserClient(session.page, merCode, diagnostics);
  return collectSijichanDataWithClient({
    client,
    diagnostics,
    merCode,
    merName,
    loginUserName: "企微扫码服务器浏览器",
    loginSystem: "wecom-browser-session",
    source,
    asOf,
  });
}

async function collectSijichanDataWithClient({ client, diagnostics, merCode = "", merName = "", loginUserName = "", loginSystem = "", source = "企微扫码授权", asOf = "" } = {}) {
  const effectiveAsOf = asOf || currentSijichanAsOfDate();
  const windows = buildSijichanWindows(effectiveAsOf);
  const withMerCode = (payload = {}) => (merCode ? { merCode, ...payload } : payload);

  const salesPeriods = {
    currentMonth_vs_previousMonthSamePeriod: [windows.currentMonth, windows.previousMonthSamePeriod],
    currentMonth: [windows.currentMonth, null],
    previousMonthSamePeriod: [windows.previousMonthSamePeriod, null],
    lastMonth_vs_priorTwoMonths: [windows.lastMonth, windows.priorTwoMonths],
    lastMonth_vs_sameMonthLastYear: [windows.lastMonth, windows.sameMonthLastYear],
    previousMonth: [windows.previousMonth, null],
    sameMonthLastYear: [windows.sameMonthLastYear, null],
    priorTwoMonths: [windows.priorTwoMonths, null],
    nearHalf_vs_previousHalf: [windows.nearHalf, windows.previousHalf],
    nearHalf_vs_sameNearHalfLastYear: [windows.nearHalf, windows.sameNearHalfLastYear],
    previousHalf: [windows.previousHalf, null],
    sameNearHalfLastYear: [windows.sameNearHalfLastYear, null],
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
      source,
      merCode,
      merName,
      generatedAt: new Date().toISOString(),
      asOf: effectiveAsOf,
      windows,
      loginUserName,
      loginSystem,
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
      currentMonth: {
        rows: await client.paged("活动汇总-当月", "imActivityReward/summary/page", activityBody(windows.currentMonth)),
        sum: await client.post("活动汇总合计-当月", "imActivityReward/summary/sum", activityBody(windows.currentMonth)),
      },
      previousMonthSamePeriod: {
        rows: await client.paged("活动汇总-上月同期", "imActivityReward/summary/page", activityBody(windows.previousMonthSamePeriod)),
        sum: await client.post("活动汇总合计-上月同期", "imActivityReward/summary/sum", activityBody(windows.previousMonthSamePeriod)),
      },
      lastMonth: {
        rows: await client.paged("活动汇总-5月", "imActivityReward/summary/page", activityBody(windows.lastMonth)),
        sum: await client.post("活动汇总合计-5月", "imActivityReward/summary/sum", activityBody(windows.lastMonth)),
      },
      previousMonth: {
        rows: await client.paged("活动汇总-4月", "imActivityReward/summary/page", activityBody(windows.previousMonth)),
        sum: await client.post("活动汇总合计-4月", "imActivityReward/summary/sum", activityBody(windows.previousMonth)),
      },
      sameMonthLastYear: {
        rows: await client.paged("活动汇总-去年同月", "imActivityReward/summary/page", activityBody(windows.sameMonthLastYear)),
        sum: await client.post("活动汇总合计-去年同月", "imActivityReward/summary/sum", activityBody(windows.sameMonthLastYear)),
      },
      nearHalf: {
        rows: await client.paged("活动汇总-近半年", "imActivityReward/summary/page", activityBody(windows.nearHalf)),
        sum: await client.post("活动汇总合计-近半年", "imActivityReward/summary/sum", activityBody(windows.nearHalf)),
      },
      sameNearHalfLastYear: {
        rows: await client.paged("活动汇总-去年同期近半年", "imActivityReward/summary/page", activityBody(windows.sameNearHalfLastYear)),
        sum: await client.post("活动汇总合计-去年同期近半年", "imActivityReward/summary/sum", activityBody(windows.sameNearHalfLastYear)),
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

function averageCandidates(rows, candidates) {
  const values = [];
  for (const row of rows || []) {
    const key = candidates.find((candidate) => row && row[candidate] !== undefined && row[candidate] !== "");
    if (key) {
      const value = toNumber(row[key]);
      if (value) values.push(value);
    }
  }
  if (!values.length) return 0;
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 100) / 100;
}

function compareMetric(current, previous) {
  const currentValue = Math.round(toNumber(current) * 100) / 100;
  const previousValue = Math.round(toNumber(previous) * 100) / 100;
  const diff = Math.round((currentValue - previousValue) * 100) / 100;
  const changeRate = previousValue ? Math.round((diff / previousValue) * 10000) / 100 : 0;
  return { current: currentValue, previous: previousValue, diff, changeRate };
}

const productIdentityCandidates = ["commodityCode", "wareIspCode", "productCode", "goodsCode", "skuCode", "商品编码", "商品名称", "commodityName", "productName", "goodsName"];
const salesAmountCandidates = ["saleCommodityAmount", "rewardSaleAmount", "saleAmount", "salesAmount", "amount", "销售额", "销售金额"];

function productIdentity(row) {
  return String(pickField(row, productIdentityCandidates) || "").trim();
}

function rowsWithCommonSalesProducts(currentRows = [], previousRows = []) {
  const currentSalesIds = new Set((currentRows || []).filter((row) => sumCandidates([row], salesAmountCandidates) > 0).map(productIdentity).filter(Boolean));
  const previousSalesIds = new Set((previousRows || []).filter((row) => sumCandidates([row], salesAmountCandidates) > 0).map(productIdentity).filter(Boolean));
  const commonIds = new Set([...currentSalesIds].filter((id) => previousSalesIds.has(id)));
  return {
    currentRows: (currentRows || []).filter((row) => commonIds.has(productIdentity(row))),
    previousRows: (previousRows || []).filter((row) => commonIds.has(productIdentity(row))),
    commonProductCount: commonIds.size,
  };
}

function monthlySnapshot(rows = [], activityRows = []) {
  const salesAmount = sumCandidates(rows, salesAmountCandidates);
  const grossProfit = sumCandidates(rows, ["grossProfitAmount", "grossProfit", "profitAmount", "maoriAmount", "毛利额", "毛利"]);
  const grossMargin = salesAmount ? Math.round((grossProfit / salesAmount) * 10000) / 100 : averageCandidates(rows, ["grossProfitRate", "grossMargin", "maoriRate", "毛利率"]);
  const activitySalesAmount = sumCandidates(activityRows, ["rewardSaleAmount", "saleCommodityAmount", "saleAmount", "salesAmount", "销售额", "活动销售额"]);
  const rewardAmount = sumCandidates(activityRows, ["rewardCommodityAmount", "singleRewardMoney", "rewardAmount", "奖励金额"]);
  return {
    salesAmount,
    grossProfit,
    grossMargin,
    activityCount: uniqueCountCandidates(activityRows, ["activityId", "activityCode", "activityName", "marketActivityName", "活动ID", "活动编码", "活动名称"]) || (activityRows || []).length,
    activitySkuCount: uniqueCountCandidates(activityRows, ["commodityCode", "wareIspCode", "productCode", "goodsCode", "商品编码"]),
    activitySalesAmount,
    rewardAmount,
    roi: rewardAmount ? Math.round((activitySalesAmount / rewardAmount) * 100) / 100 : 0,
    feeEfficiencyRate: activitySalesAmount ? Math.round((rewardAmount / activitySalesAmount) * 10000) / 100 : 0,
    storeActivationRate: averageCandidates(activityRows, ["storeMovingRate", "storeSaleRate", "storeActivationRate", "门店动销率"]),
    employeeActivationRate: averageCandidates(activityRows, ["employeeMovingRate", "empMovingRate", "employeeActivationRate", "人员动销率"]),
    skuActivationRate: averageCandidates(activityRows, ["skuMovingRate", "commodityMovingRate", "productMovingRate", "品种动销率"]),
    jointMedicationRate: averageCandidates(rows, ["jointMedicationRate", "combineSaleRate", "关联销售率", "联合用药率"]),
    keyProductRatio: averageCandidates(rows, ["keyProductRatio", "importantProductRatio", "重点品占比"]),
    slowMovingClearanceRate: averageCandidates(rows, ["slowMovingClearanceRate", "滞销品消化率"]),
  };
}

function buildMonthlyComparison(raw) {
  const currentSalesRows = rowsFromPaged(raw.sales?.currentMonth?.products || raw.sales?.currentMonth_vs_previousMonthSamePeriod?.products);
  const lastSalesRows = rowsFromPaged(raw.sales?.previousMonthSamePeriod?.products || raw.sales?.lastMonth_vs_priorTwoMonths?.products);
  const currentActivityRows = rowsFromPaged(raw.activitySummary?.currentMonth?.rows);
  const lastActivityRows = rowsFromPaged(raw.activitySummary?.previousMonthSamePeriod?.rows);
  const current = monthlySnapshot(currentSalesRows, currentActivityRows);
  const previous = monthlySnapshot(lastSalesRows, lastActivityRows);
  return {
    label: "当月与上月同期经营对比",
    currentWindow: raw.meta?.windows?.currentMonth || {},
    previousWindow: raw.meta?.windows?.previousMonthSamePeriod || {},
    marketPerformance: {
      salesAmount: compareMetric(current.salesAmount, previous.salesAmount),
      grossProfit: compareMetric(current.grossProfit, previous.grossProfit),
      grossMargin: compareMetric(current.grossMargin, previous.grossMargin),
    },
    activityExecution: {
      activityCount: compareMetric(current.activityCount, previous.activityCount),
      activitySkuCount: compareMetric(current.activitySkuCount, previous.activitySkuCount),
      activitySalesAmount: compareMetric(current.activitySalesAmount, previous.activitySalesAmount),
      storeActivationRate: compareMetric(current.storeActivationRate, previous.storeActivationRate),
      employeeActivationRate: compareMetric(current.employeeActivationRate, previous.employeeActivationRate),
      skuActivationRate: compareMetric(current.skuActivationRate, previous.skuActivationRate),
    },
    productStructure: {
      jointMedicationRate: compareMetric(current.jointMedicationRate, previous.jointMedicationRate),
      keyProductRatio: compareMetric(current.keyProductRatio, previous.keyProductRatio),
      slowMovingClearanceRate: compareMetric(current.slowMovingClearanceRate, previous.slowMovingClearanceRate),
    },
    inputOutput: {
      rewardAmount: compareMetric(current.rewardAmount, previous.rewardAmount),
      roi: compareMetric(current.roi, previous.roi),
      feeEfficiencyRate: compareMetric(current.feeEfficiencyRate, previous.feeEfficiencyRate),
    },
  };
}

function buildComparableProductComparison(raw) {
  const nearHalfRows = rowsFromPaged(raw.sales?.nearHalf_vs_sameNearHalfLastYear?.products || raw.sales?.nearHalf_vs_previousHalf?.products);
  const sameNearHalfRows = rowsFromPaged(raw.sales?.sameNearHalfLastYear?.products);
  const lastMonthRows = rowsFromPaged(raw.sales?.lastMonth_vs_sameMonthLastYear?.products || raw.sales?.lastMonth_vs_priorTwoMonths?.products);
  const sameMonthRows = rowsFromPaged(raw.sales?.sameMonthLastYear?.products);
  const nearHalfCommon = rowsWithCommonSalesProducts(nearHalfRows, sameNearHalfRows);
  const monthCommon = rowsWithCommonSalesProducts(lastMonthRows, sameMonthRows);
  const nearHalfCurrent = monthlySnapshot(nearHalfCommon.currentRows, []);
  const nearHalfPrevious = monthlySnapshot(nearHalfCommon.previousRows, []);
  const monthCurrent = monthlySnapshot(monthCommon.currentRows, []);
  const monthPrevious = monthlySnapshot(monthCommon.previousRows, []);
  return {
    rule: "同比仅计算两期都有销售记录的品种；去年同期或对比期没有销售的新品不纳入同比增幅。",
    nearHalfSameProducts: {
      commonProductCount: nearHalfCommon.commonProductCount,
      salesAmount: compareMetric(nearHalfCurrent.salesAmount, nearHalfPrevious.salesAmount),
      grossProfit: compareMetric(nearHalfCurrent.grossProfit, nearHalfPrevious.grossProfit),
      grossMargin: compareMetric(nearHalfCurrent.grossMargin, nearHalfPrevious.grossMargin),
    },
    lastMonthSameProducts: {
      commonProductCount: monthCommon.commonProductCount,
      salesAmount: compareMetric(monthCurrent.salesAmount, monthPrevious.salesAmount),
      grossProfit: compareMetric(monthCurrent.grossProfit, monthPrevious.grossProfit),
      grossMargin: compareMetric(monthCurrent.grossMargin, monthPrevious.grossMargin),
    },
  };
}

function buildEmployeeParticipationComparison(raw) {
  const accountRows = [
    ...rowsFromPaged(raw.employeeAccount?.withdrawRows),
    ...rowsFromPaged(raw.employeeAccount?.writeOffRows),
    ...rowsFromPaged(raw.employeeAccount?.settleRows),
  ];
  const certifiedRows = rowsFromPaged(raw.training?.employeeLearning);
  const certifiedEmployeeCount = uniqueCountCandidates(certifiedRows.length ? certifiedRows : accountRows, ["empCode", "employeeCode", "userCode", "staffCode", "店员编码", "员工编码"]);
  const withdrawEmployeeCount = uniqueCountCandidates(rowsFromPaged(raw.employeeAccount?.withdrawRows), ["empCode", "employeeCode", "userCode", "staffCode", "店员编码", "员工编码"]);
  return {
    certifiedEmployeeCount,
    withdrawEmployeeCount,
    withdrawParticipationRate: certifiedEmployeeCount ? Math.round((withdrawEmployeeCount / certifiedEmployeeCount) * 10000) / 100 : 0,
    note: "店员认证总人数优先取培训/员工明细中的店员编码；若无培训明细，则用员工账户相关明细中的店员编码兜底。提现总人数取提现明细中的店员编码。",
  };
}

function summarizeSijichanRaw(raw) {
  const salesRows = [
    ...withDataMeta(rowsFromPaged(raw.sales.currentMonth_vs_lastMonth?.products), "sales.json", "currentMonth_vs_lastMonth.products"),
    ...withDataMeta(rowsFromPaged(raw.sales.currentMonth?.products), "sales.json", "currentMonth.products"),
    ...withDataMeta(rowsFromPaged(raw.sales.lastMonth_vs_priorTwoMonths.products), "sales.json", "lastMonth_vs_priorTwoMonths.products"),
    ...withDataMeta(rowsFromPaged(raw.sales.lastMonth_vs_sameMonthLastYear?.products), "sales.json", "lastMonth_vs_sameMonthLastYear.products"),
    ...withDataMeta(rowsFromPaged(raw.sales.previousMonth.products), "sales.json", "previousMonth.products"),
    ...withDataMeta(rowsFromPaged(raw.sales.sameMonthLastYear?.products), "sales.json", "sameMonthLastYear.products"),
    ...withDataMeta(rowsFromPaged(raw.sales.priorTwoMonths.products), "sales.json", "priorTwoMonths.products"),
    ...withDataMeta(rowsFromPaged(raw.sales.nearHalf_vs_previousHalf.products), "sales.json", "nearHalf_vs_previousHalf.products"),
    ...withDataMeta(rowsFromPaged(raw.sales.nearHalf_vs_sameNearHalfLastYear?.products), "sales.json", "nearHalf_vs_sameNearHalfLastYear.products"),
    ...withDataMeta(rowsFromPaged(raw.sales.previousHalf.products), "sales.json", "previousHalf.products"),
    ...withDataMeta(rowsFromPaged(raw.sales.sameNearHalfLastYear?.products), "sales.json", "sameNearHalfLastYear.products"),
  ];
  const activityRows = [
    ...withDataMeta(rowsFromPaged(raw.activitySummary.currentMonth?.rows), "activity_summary.json", "currentMonth.rows"),
    ...withDataMeta(rowsFromPaged(raw.activitySummary.lastMonth.rows), "activity_summary.json", "lastMonth.rows"),
    ...withDataMeta(rowsFromPaged(raw.activitySummary.previousMonth.rows), "activity_summary.json", "previousMonth.rows"),
    ...withDataMeta(rowsFromPaged(raw.activitySummary.sameMonthLastYear?.rows), "activity_summary.json", "sameMonthLastYear.rows"),
    ...withDataMeta(rowsFromPaged(raw.activitySummary.nearHalf.rows), "activity_summary.json", "nearHalf.rows"),
    ...withDataMeta(rowsFromPaged(raw.activitySummary.sameNearHalfLastYear?.rows), "activity_summary.json", "sameNearHalfLastYear.rows"),
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
    source: raw.meta.source || "登录获取",
    requestInfo: {
      asOf: raw.meta.asOf || currentSijichanAsOfDate(),
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
    monthlyComparison: buildMonthlyComparison(raw),
    comparableProductComparison: buildComparableProductComparison(raw),
    employeeParticipationComparison: buildEmployeeParticipationComparison(raw),
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

async function runSijichanTokenExport(body) {
  const raw = await collectSijichanDataWithToken({
    token: body.token || body.authorization,
    merCode: body.merCode,
    merName: body.merName,
    loginUserName: body.username || "企微扫码授权",
    loginSystem: "wecom-sso",
    source: "企微扫码授权",
    asOf: body.asOf,
  });
  return summarizeSijichanRaw(raw);
}

async function handleConfigStatus(req, res) {
  const user = await getCurrentUser(req);
  sendJson(res, 200, await publicConfigStatus(user));
}

async function handleSaveConfig(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  const body = await readJsonBody(req);
  const current = (await loadOwnAiConfig(user)) || {};

  const next = {
    apiKey: body.apiKey ? String(body.apiKey).trim() : current.apiKey,
    baseUrl: normalizeBaseUrl(body.baseUrl || current.baseUrl || "https://api.deepseek.com"),
    model: String(body.model || current.model || "deepseek-v4-flash").trim(),
    protocol: String(body.protocol || current.protocol || "chat_completions").trim(),
    updatedAt: new Date().toISOString(),
  };

  if (!next.apiKey) {
    sendJson(res, 400, { error: "请填写API Key。" });
    return;
  }

  await saveAiConfig(next, user.id);
  sendJson(res, 200, { ok: true, status: await publicConfigStatus(user) });
}

async function handleTestConfig(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  const body = await readJsonBody(req);
  const saved = await loadAiConfigForUser(user);

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

async function handleGetReviewPrompt(req, res) {
  const user = await requireAdmin(req, res);
  if (!user) return;
  const setting = await loadSystemSetting("review_prompt_instruction");
  sendJson(res, 200, {
    instruction: await loadReviewPromptInstruction(),
    defaultInstruction: defaultReviewPromptInstruction,
    updatedAt: setting?.updated_at || setting?.updatedAt || "",
  });
}

async function handleSaveReviewPrompt(req, res) {
  const user = await requireAdmin(req, res);
  if (!user) return;
  const body = await readJsonBody(req, 1024 * 1024);
  const instruction = body?.reset ? defaultReviewPromptInstruction : body?.instruction;
  const saved = await saveReviewPromptInstruction(instruction, user.id);
  sendJson(res, 200, {
    ok: true,
    instruction: await loadReviewPromptInstruction(),
    updatedAt: saved?.updated_at || saved?.updatedAt || new Date().toISOString(),
    message: body?.reset ? "复盘AI指令已恢复默认。" : "复盘AI指令已保存。",
  });
}

const reviewJobTtlMs = Number(process.env.REVIEW_JOB_TTL_MS || 30 * 60 * 1000);
const reviewMaintenanceIntervalMs = Number(process.env.REVIEW_MAINTENANCE_INTERVAL_MS || 10 * 60 * 1000);
const reviewJobEventRetentionDays = Number(process.env.REVIEW_JOB_EVENT_RETENTION_DAYS || 90);
const reviewJobEventMaxPerJob = Number(process.env.REVIEW_JOB_EVENT_MAX_PER_JOB || 80);
const reviewWorkbookTtlMs = Number(process.env.REVIEW_WORKBOOK_TTL_MS || Math.max(reviewWorkbookTimeoutMs + 2 * 60 * 1000, 12 * 60 * 1000));
const authLogSuccessRetentionDays = Number(process.env.AUTH_LOG_SUCCESS_RETENTION_DAYS || 90);
const authLogFailureRetentionDays = Number(process.env.AUTH_LOG_FAILURE_RETENTION_DAYS || 180);
const reviewJobTimeoutMessage = "任务超过30分钟未完成，系统已自动清理。请确认账号权限和网络后重试。";
const reviewWorkbookTimeoutMessage = "Excel汇总生成超过预计时间，系统已自动停止该下载文件生成。AI复盘报告不受影响，可在历史报告中重新生成。";
let reviewMaintenanceTimer = null;

async function cleanupExpiredReviewJobs() {
  const now = Date.now();
  if (await isDbAvailable()) {
    const result = await queryDb(
      `select job_key, report_db_id, source_table
       from expire_stale_review_jobs($1::bigint, $2::text)`,
      [reviewJobTtlMs, reviewJobTimeoutMessage],
    ).catch(() => ({ rows: [] }));
    for (const row of result.rows || []) {
      if (row?.job_key) activeReviewJobs.delete(row.job_key);
      console.warn(`[review] timeout ${row?.job_key || row?.report_db_id || ""}`.trim());
    }
  } else {
    const data = readLocalData();
    let changed = false;
    for (const job of data.reviewJobs || []) {
      if ((job.status || "running") !== "running" || job.cancelRequested) continue;
      const touchedAt = Date.parse(job.heartbeatAt || job.startedAt || job.createdAt || "");
      if (!Number.isFinite(touchedAt) || now - touchedAt <= reviewJobTtlMs) continue;
      job.status = "failed";
      job.cancelRequested = false;
      job.errorMessage = reviewJobTimeoutMessage;
      job.progressStage = "failed";
      job.progressText = reviewJobTimeoutMessage;
      job.finishedAt = new Date(now).toISOString();
      job.updatedAt = job.finishedAt;
      appendLocalReviewJobEvent(data, job, "status_changed", reviewJobTimeoutMessage, {
        previousStatus: "running",
        timeout: true,
      });
      if (job.jobKey) activeReviewJobs.delete(job.jobKey);
      const report = data.reviewReports.find((item) => item.id === job.reportDbId);
      if (report && report.status === "running") {
        report.status = "failed";
        report.reportTitle = "复盘报告生成失败";
        report.errorMessage = reviewJobTimeoutMessage;
        report.cancelRequested = false;
        report.progressStage = "failed";
        report.progressText = reviewJobTimeoutMessage;
        report.finishedAt = job.finishedAt;
        report.updatedAt = job.finishedAt;
      }
      changed = true;
      console.warn(`[review] timeout ${job.jobKey || job.reportDbId || ""}`.trim());
    }
    for (const report of data.reviewReports || []) {
      if ((report.status || "completed") !== "running" || report.cancelRequested) continue;
      const touchedAt = Date.parse(report.heartbeatAt || report.startedAt || report.createdAt || "");
      if (!Number.isFinite(touchedAt) || now - touchedAt <= reviewJobTtlMs) continue;
      report.status = "failed";
      report.reportTitle = "复盘报告生成失败";
      report.errorMessage = reviewJobTimeoutMessage;
      report.cancelRequested = false;
      report.progressStage = "failed";
      report.progressText = reviewJobTimeoutMessage;
      report.finishedAt = new Date(now).toISOString();
      report.updatedAt = report.finishedAt;
      appendLocalReviewJobEvent(data, {
        reportDbId: report.id,
        userId: report.userId,
        jobKey: report.jobKey,
        status: report.status,
        progressStage: report.progressStage,
        progressText: report.progressText,
        progressPercent: report.progressPercent,
      }, "status_changed", reviewJobTimeoutMessage, {
        previousStatus: "running",
        timeout: true,
      });
      if (report.jobKey) activeReviewJobs.delete(report.jobKey);
      changed = true;
      console.warn(`[review] timeout ${report.jobKey || report.id || ""}`.trim());
    }
    if (changed) writeLocalData(data);
  }
  for (const [key, job] of activeReviewJobs.entries()) {
    if (!job?.startedAt || now - job.startedAt <= reviewJobTtlMs) continue;
    activeReviewJobs.delete(key);
    await markReviewReportStatus(job.reportDbId, "failed", reviewJobTimeoutMessage).catch(() => null);
    console.warn(`[review] timeout ${key}`);
  }
}

async function cleanupExpiredReviewWorkbooks() {
  const now = Date.now();
  if (await isDbAvailable()) {
    const result = await queryDb(
      `select expired_report_db_id as report_db_id
       from expire_stale_review_workbooks($1::bigint, $2::text)`,
      [reviewWorkbookTtlMs, reviewWorkbookTimeoutMessage],
    ).catch(() => ({ rows: [] }));
    for (const row of result.rows || []) {
      console.warn(`[workbook] timeout ${row?.report_db_id || ""}`.trim());
    }
    return;
  }

  const data = readLocalData();
  let changed = false;
  for (const report of data.reviewReports || []) {
    if (String(report.excelStatus || report.excel_status || "") !== "generating") continue;
    const touchedAt = Date.parse(report.updatedAt || report.finishedAt || report.createdAt || "");
    if (!Number.isFinite(touchedAt) || now - touchedAt <= reviewWorkbookTtlMs) continue;
    report.excelStatus = "failed";
    report.excelUrl = "";
    report.excelError = reviewWorkbookTimeoutMessage;
    report.updatedAt = new Date(now).toISOString();
    appendLocalReviewJobEvent(data, {
      reportDbId: report.id,
      userId: report.userId,
      jobKey: report.jobKey,
      status: "completed",
      progressStage: "excel_failed",
      progressPercent: 100,
    }, "excel_status", reviewWorkbookTimeoutMessage, { timeout: true });
    changed = true;
    console.warn(`[workbook] timeout ${report.id || ""}`.trim());
  }
  if (changed) writeLocalData(data);
}

async function cleanupReviewJobEvents() {
  if (!(await isDbAvailable())) {
    const data = readLocalData();
    const events = Array.isArray(data.reviewJobEvents) ? data.reviewJobEvents : [];
    if (!events.length) return;
    let nextEvents = events;
    const retentionDays = Math.max(1, Math.round(reviewJobEventRetentionDays));
    if (reviewJobEventRetentionDays > 0) {
      const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
      nextEvents = nextEvents.filter((event) => {
        const createdAt = Date.parse(event.createdAt || "");
        return !Number.isFinite(createdAt) || createdAt >= cutoff;
      });
    }
    if (reviewJobEventMaxPerJob > 0) {
      const maxPerJob = Math.max(1, Math.round(reviewJobEventMaxPerJob));
      const grouped = new Map();
      for (const event of nextEvents) {
        const key = event.reviewJobId || event.reportDbId || event.jobKey || event.id;
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push(event);
      }
      const keepIds = new Set();
      for (const group of grouped.values()) {
        group
          .slice()
          .sort((a, b) => {
            const at = Date.parse(a.createdAt || "") || 0;
            const bt = Date.parse(b.createdAt || "") || 0;
            if (bt !== at) return bt - at;
            return String(b.id || "").localeCompare(String(a.id || ""));
          })
          .slice(0, maxPerJob)
          .forEach((event) => keepIds.add(event.id));
      }
      nextEvents = nextEvents.filter((event) => keepIds.has(event.id));
    }
    if (nextEvents.length !== events.length) {
      data.reviewJobEvents = nextEvents;
      writeLocalData(data);
      console.warn(`[review] cleaned ${events.length - nextEvents.length} local job events`);
    }
    return;
  }
  const result = await queryDb(
    `select cleanup_review_job_events($1::int, $2::int) as removed`,
    [
      Math.max(0, Math.round(reviewJobEventRetentionDays)),
      Math.max(0, Math.round(reviewJobEventMaxPerJob)),
    ],
  ).catch(() => ({ rows: [] }));
  const removed = Number(result.rows?.[0]?.removed || 0);
  if (removed) console.warn(`[review] cleaned ${removed} job events`);
}

async function cleanupAuthOperationLogs() {
  if (!(await isDbAvailable())) return;
  const result = await queryDb(
    `select cleanup_auth_operation_logs($1::int, $2::int) as removed`,
    [
      Math.max(1, Math.round(authLogSuccessRetentionDays)),
      Math.max(1, Math.round(authLogFailureRetentionDays)),
    ],
  ).catch(() => ({ rows: [] }));
  const removed = Number(result.rows?.[0]?.removed || 0);
  if (removed) console.warn(`[auth] cleaned ${removed} operation logs`);
}

async function runReviewMaintenance() {
  await cleanupExpiredReviewJobs().catch((error) => {
    console.warn(`[review] cleanup jobs skipped: ${error.message}`);
  });
  await cleanupExpiredReviewWorkbooks().catch((error) => {
    console.warn(`[workbook] cleanup skipped: ${error.message}`);
  });
  await cleanupReviewJobEvents().catch((error) => {
    console.warn(`[review] cleanup events skipped: ${error.message}`);
  });
  await cleanupAuthOperationLogs().catch((error) => {
    console.warn(`[auth] cleanup logs skipped: ${error.message}`);
  });
}

function startReviewMaintenanceLoop() {
  if (reviewMaintenanceTimer || reviewMaintenanceIntervalMs <= 0) return;
  runReviewMaintenance().catch((error) => {
    console.warn(`[review] maintenance skipped: ${error.message}`);
  });
  reviewMaintenanceTimer = setInterval(() => {
    runReviewMaintenance().catch((error) => {
      console.warn(`[review] maintenance skipped: ${error.message}`);
    });
  }, reviewMaintenanceIntervalMs);
  if (typeof reviewMaintenanceTimer.unref === "function") {
    reviewMaintenanceTimer.unref();
  }
}

function stopReviewMaintenanceLoop() {
  if (!reviewMaintenanceTimer) return;
  clearInterval(reviewMaintenanceTimer);
  reviewMaintenanceTimer = null;
}

async function findBlockingRunningReviewJob(key) {
  if (await isDbAvailable()) {
    const result = await queryDb(
      `select
         coalesce(report_db_id, id) as id,
         job_key
       from review_jobs
       where coalesce(job_key, '') = $1
         and status = 'running'
         and coalesce(cancel_requested, false) = false
       order by coalesce(heartbeat_at, started_at, created_at) desc, created_at desc
       limit 1`,
      [key],
    ).catch(() => ({ rows: [] }));
    if (result.rows[0]) return result.rows[0];
    const fallback = await queryDb(
      `select id, job_key
       from review_reports
       where coalesce(job_key, '') = $1
         and status = 'running'
         and coalesce(cancel_requested, false) = false
       order by coalesce(heartbeat_at, started_at, created_at) desc, created_at desc
       limit 1`,
      [key],
    ).catch(() => ({ rows: [] }));
    return fallback.rows[0] || null;
  }
  const active = activeReviewJobs.get(key);
  if (active) return { id: active.reportDbId, job_key: key };
  const data = readLocalData();
  const localJob = (data.reviewJobs || [])
    .filter((job) => job.jobKey === key && (job.status || "running") === "running" && !job.cancelRequested)
    .sort((a, b) => String(b.heartbeatAt || b.startedAt || b.createdAt || "").localeCompare(String(a.heartbeatAt || a.startedAt || a.createdAt || "")))[0];
  if (localJob) return { id: localJob.reportDbId || localJob.id, job_key: localJob.jobKey };
  const localReport = (data.reviewReports || [])
    .filter((report) => report.jobKey === key && (report.status || "completed") === "running" && !report.cancelRequested)
    .sort((a, b) => String(b.heartbeatAt || b.startedAt || b.createdAt || "").localeCompare(String(a.heartbeatAt || a.startedAt || a.createdAt || "")))[0];
  return localReport ? { id: localReport.id, job_key: localReport.jobKey } : null;
}

async function beginReviewJob(key, meta = {}) {
  await cleanupExpiredReviewJobs();
  const blockingJob = await findBlockingRunningReviewJob(key);
  if (blockingJob) {
    const error = new Error("已有复盘报告正在生成，请稍后刷新历史报告，或等待当前任务完成后再试。");
    error.statusCode = 429;
    throw error;
  }
  activeReviewJobs.delete(key);
  const startedAt = Date.now();
  const reportDbId = await createRunningReviewReportRecord(meta.userId, meta.sourceType, meta.sourceName, key, meta.retryPayload || {});
  const persistentJob = await createReviewJobRecord({
    ...meta,
    jobKey: key,
    reportDbId,
    progressStage: "queued",
    progressText: "任务已创建，等待开始处理。",
    progressPercent: 2,
  });
  activeReviewJobs.set(key, {
    key,
    startedAt,
    jobId: persistentJob.id,
    reportDbId,
    userId: meta.userId,
    sourceType: meta.sourceType,
    sourceName: meta.sourceName,
    cancelRequested: false,
  });
  return { key, startedAt, reportDbId };
}

function getActiveReviewJob(key) {
  return activeReviewJobs.get(key) || null;
}

async function failReviewJob(key, error, fallbackReportDbId = "") {
  const job = activeReviewJobs.get(key);
  activeReviewJobs.delete(key);
  const reportDbId = job?.reportDbId || fallbackReportDbId || "";
  const status = error?.isCancelled ? "cancelled" : "failed";
  await markReviewReportStatus(reportDbId, status, error?.message || String(error || "复盘报告生成失败。")).catch(() => null);
}

async function assertReviewJobStillActive(job) {
  if (!job) {
    const error = new Error("复盘报告任务已取消或已超时清理。");
    error.statusCode = 409;
    error.isCancelled = true;
    throw error;
  }
  if (await isDbAvailable()) {
    const reportResult = await queryDb(
      `update review_reports
       set heartbeat_at = now(),
           updated_at = now()
       where id = $1
         and status = 'running'
         and coalesce(cancel_requested, false) = false
       returning id`,
      [job.reportDbId],
    ).catch(() => ({ rows: [] }));
    const jobResult = await queryDb(
      `update review_jobs
       set heartbeat_at = now(),
           updated_at = now()
       where report_db_id = $1
         and status = 'running'
         and coalesce(cancel_requested, false) = false
       returning id`,
      [job.reportDbId],
    ).catch(() => ({ rows: [] }));
    const jobState = await queryDb(
      `select status, coalesce(cancel_requested, false) as cancel_requested, error_message
       from review_jobs
       where report_db_id = $1
       order by created_at desc
       limit 1`,
      [job.reportDbId],
    ).catch(() => ({ rows: [] }));
    if (reportResult.rows[0]?.id && (jobResult.rows[0]?.id || !jobState.rows[0])) return true;
    const state = await queryDb(
      `select status, coalesce(cancel_requested, false) as cancel_requested, error_message
       from review_reports
       where id = $1
       limit 1`,
      [job.reportDbId],
    ).catch(() => ({ rows: [] }));
    const row = jobState.rows[0] || state.rows[0] || {};
    const error = new Error(
      row.cancel_requested || row.status === "cancelled"
        ? "复盘报告任务已取消。"
        : row.error_message || "复盘报告任务已取消或已超时清理。",
    );
    error.statusCode = 409;
    error.isCancelled = Boolean(row.cancel_requested) || row.status === "cancelled";
    throw error;
  }
  const active = getActiveReviewJob(job.key || "");
  if (!active || active.cancelRequested) {
    const error = new Error("复盘报告任务已取消或已超时清理。");
    error.statusCode = 409;
    error.isCancelled = true;
    throw error;
  }
  return true;
}

function finishReviewJob(key, startedAt, detail = "") {
  const job = activeReviewJobs.get(key);
  if (job?.cancelRequested) {
    activeReviewJobs.delete(key);
    console.log(`[review] ignored-cancelled ${key} ${detail}`.trim());
    return false;
  }
  activeReviewJobs.delete(key);
  const startMs = typeof startedAt === "number" ? startedAt : startedAt?.startedAt;
  const elapsed = startMs ? `${Math.round((Date.now() - startMs) / 1000)}s` : "";
  console.log(`[review] finish ${key} ${elapsed} ${detail}`.trim());
  return true;
}

function buildGeneratedReviewResponse(id, summary, generated) {
  return {
    ok: true,
    id,
    summary: summaryForResponse(summary),
    report: generated.report || null,
    markdown: generated.markdown || "",
    reportId: generated.reportId,
    shareUrl: generated.shareUrl,
    svgUrl: generated.svgUrl,
    qrSvgUrl: generated.qrSvgUrl,
    excelUrl: generated.excelUrl,
    excelStatus: generated.excelStatus || "",
    excelError: generated.excelError || "",
    normalizedDataUrl: generated.normalizedDataUrl,
    diagnosticsUrl: generated.diagnosticsUrl,
  };
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
    sendJson(res, 422, { error: "缺少明细数据。请在标准模板的Sheet3之后粘贴客户明细数据后再上传。", summary: summaryForResponse(summary) });
    return;
  }

  const jobKey = `excel:${user.id}`;
  const job = await beginReviewJob(jobKey, { userId: user.id, sourceType: "excel", sourceName: filename, retryPayload: { sourceType: "excel", filename } });
  let datasetId = "";
  console.log(`[review] start ${jobKey} ${filename}`);
  try {
    await updateReviewReportProgress(job.reportDbId, "template_validated", "Excel模板校验完成，正在整理上传数据。", 12);
    datasetId = await saveDatasetRecord(user.id, "excel", summary, filename);
    await assertReviewJobStillActive(job);
    await updateReviewReportProgress(job.reportDbId, "ai_generating", "客户数据已整理完成，正在生成AI复盘报告。", 58);
    const { report, markdown, reportId, shareUrl, svgUrl, qrSvgUrl, excelUrl, excelStatus, excelError, excelFileName, normalizedDataUrl, diagnosticsUrl } = await generateReportFromSummary(summary, user);
    await assertReviewJobStillActive(job);
    await updateReviewReportProgress(job.reportDbId, "publishing", "AI分析已完成，正在写入历史记录并生成分享产物；Excel汇总将在后台生成。", 88);
    const generated = { report, markdown, reportId, shareUrl, svgUrl, qrSvgUrl, excelUrl, excelStatus, excelError, excelFileName, normalizedDataUrl, diagnosticsUrl };
    const dbReportId = await saveReviewReportRecord(user.id, "excel", filename, summary, generated, { reportDbId: job.reportDbId, jobKey });
    queueReviewWorkbookGeneration(dbReportId, summary, report, markdown, generated);
    await linkDatasetToReviewReport(datasetId, dbReportId, "completed");
    finishReviewJob(jobKey, job.startedAt, reportId);
    sendJson(res, 200, buildGeneratedReviewResponse(dbReportId, summary, generated));
  } catch (error) {
    await failReviewJob(jobKey, error, job.reportDbId);
    await linkDatasetToReviewReport(datasetId, null, "failed", error.message);
    console.error(`[review] failed ${jobKey}:`, error);
    throw error;
  }
}

async function handleSijichanReviewReport(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  const body = await readJsonBody(req, 1024 * 1024);
  const config = await loadAiConfigForUser(user);
  if (!config.apiKey || !config.model) {
    sendJson(res, 400, { error: "AI服务未配置，请在AI配置页面保存自己的API Key，或联系管理员hydee配置兜底API。" });
    return;
  }

  const jobKey = `login:${user.id}`;
  const job = await beginReviewJob(jobKey, { userId: user.id, sourceType: "login", sourceName: "登录获取", retryPayload: { sourceType: "login", username: body.username || "", merCode: body.merCode || "", merName: body.merName || "" } });
  let datasetId = "";
  console.log(`[review] start ${jobKey} ${body.username || ""}`);
  try {
    await updateReviewReportProgress(job.reportDbId, "collecting", "正在登录四季蝉并读取销售、活动、培训等业务数据。", 12);
    const summary = await runSijichanExport(body);
    await assertReviewJobStillActive(job);
    const files = summary.datasetFiles || [];
    if (!files.some((file) => file.rowCount > 0)) {
      sendJson(res, 422, { error: "接口成功返回，但该账号/客户在当前口径无可复盘明细数据。", summary: summaryForResponse(summary) });
      await markReviewReportStatus(job.reportDbId, "failed", "接口成功返回，但该账号/客户在当前口径无可复盘明细数据。");
      finishReviewJob(jobKey, job.startedAt, "empty");
      return;
    }
    await updateReviewReportProgress(job.reportDbId, "dataset_ready", "接口数据已返回，正在整理可复盘明细。", 42);
    datasetId = await saveDatasetRecord(user.id, "login", summary, summary.source || "登录获取");
    await assertReviewJobStillActive(job);
    await updateReviewReportProgress(job.reportDbId, "ai_generating", "明细数据已整理完成，正在生成AI复盘报告。", 62);
    const { report, markdown, reportId, shareUrl, svgUrl, qrSvgUrl, excelUrl, excelStatus, excelError, excelFileName, normalizedDataUrl, diagnosticsUrl } = await generateReportFromSummary(summary, user);
    await assertReviewJobStillActive(job);
    await updateReviewReportProgress(job.reportDbId, "publishing", "AI分析已完成，正在生成分享页、SVG和二维码；Excel汇总将在后台生成。", 88);
    const generated = { report, markdown, reportId, shareUrl, svgUrl, qrSvgUrl, excelUrl, excelStatus, excelError, excelFileName, normalizedDataUrl, diagnosticsUrl };
    const dbReportId = await saveReviewReportRecord(user.id, "login", "登录获取", summary, generated, { reportDbId: job.reportDbId, jobKey });
    queueReviewWorkbookGeneration(dbReportId, summary, report, markdown, generated);
    await upsertSijichanAuthorization(user.id, body, summary, dbReportId).catch((error) => {
      console.warn(`Sijichan authorization save skipped: ${error.message}`);
    });
    await linkDatasetToReviewReport(datasetId, dbReportId, "completed");
    finishReviewJob(jobKey, job.startedAt, reportId);
    sendJson(res, 200, buildGeneratedReviewResponse(dbReportId, summary, generated));
  } catch (error) {
    await failReviewJob(jobKey, error, job.reportDbId);
    await linkDatasetToReviewReport(datasetId, null, "failed", error.message);
    console.error(`[review] failed ${jobKey}:`, error);
    throw error;
  }
}

async function handleWeComTokenReviewReport(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  const body = await readJsonBody(req, 1024 * 1024);
  let token = "";
  try {
    token = assertSijichanTokenFormat(body.token || body.authorization || "");
  } catch (error) {
    sendJson(res, 400, { error: error.message || "请填写企微扫码登录后获得的新零售管理平台授权token。" });
    return;
  }
  return await generateWeComTokenReportForUser(user, res, { ...body, token });
}

async function buildWeComTokenReportForUser(user, body) {
  const token = assertSijichanTokenFormat(body.token || body.authorization || "");
  const config = await loadAiConfigForUser(user);
  if (!config.apiKey || !config.model) {
    const error = new Error("AI服务未配置，请在AI配置页面保存自己的API Key，或联系管理员hydee配置兜底API。");
    error.statusCode = 400;
    throw error;
  }
  const jobKey = `wecom:${user.id}`;
  const job = await beginReviewJob(jobKey, { userId: user.id, sourceType: "wecom_token", sourceName: "企微扫码授权", retryPayload: { sourceType: "wecom_token", merCode: body.merCode || "", merName: body.merName || "" } });
  let datasetId = "";
  console.log(`[review] start ${jobKey} ${String(body.merCode || "").trim()}`);
  try {
    await updateReviewReportProgress(job.reportDbId, "collecting", "正在通过企微授权读取销售、活动、培训与奖励数据。", 12);
    const summary = await runSijichanTokenExport({ ...body, token });
    await assertReviewJobStillActive(job);
    const files = summary.datasetFiles || [];
    if (!files.some((file) => file.rowCount > 0)) {
      await markReviewReportStatus(job.reportDbId, "failed", "授权token可访问接口，但当前账号/客户在当前口径无可复盘明细数据。");
      finishReviewJob(jobKey, job.startedAt, "empty");
      const error = new Error("授权token可访问接口，但当前账号/客户在当前口径无可复盘明细数据。");
      error.statusCode = 422;
      error.summary = summaryForResponse(summary);
      throw error;
    }
    await updateReviewReportProgress(job.reportDbId, "dataset_ready", "企微授权数据已返回，正在整理可复盘明细。", 42);
    datasetId = await saveDatasetRecord(user.id, "wecom_token", summary, summary.source || "企微扫码授权");
    await assertReviewJobStillActive(job);
    await updateReviewReportProgress(job.reportDbId, "ai_generating", "明细数据已整理完成，正在生成AI复盘报告。", 62);
    const { report, markdown, reportId, shareUrl, svgUrl, qrSvgUrl, excelUrl, excelStatus, excelError, excelFileName, normalizedDataUrl, diagnosticsUrl } = await generateReportFromSummary(summary, user);
    await assertReviewJobStillActive(job);
    await updateReviewReportProgress(job.reportDbId, "publishing", "AI分析已完成，正在生成分享页、SVG和二维码；Excel汇总将在后台生成。", 88);
    const generated = { report, markdown, reportId, shareUrl, svgUrl, qrSvgUrl, excelUrl, excelStatus, excelError, excelFileName, normalizedDataUrl, diagnosticsUrl };
    const dbReportId = await saveReviewReportRecord(user.id, "wecom_token", "企微扫码授权", summary, generated, { reportDbId: job.reportDbId, jobKey });
    queueReviewWorkbookGeneration(dbReportId, summary, report, markdown, generated);
    await upsertSijichanTokenAuthorization(user.id, { ...body, token }, summary, dbReportId).catch((error) => {
      console.warn(`Sijichan token authorization save skipped: ${error.message}`);
    });
    await linkDatasetToReviewReport(datasetId, dbReportId, "completed");
    finishReviewJob(jobKey, job.startedAt, reportId);
    return buildGeneratedReviewResponse(dbReportId, summary, generated);
  } catch (error) {
    await failReviewJob(jobKey, error, job.reportDbId);
    await linkDatasetToReviewReport(datasetId, null, "failed", error.message);
    console.error(`[review] failed ${jobKey}:`, error);
    throw error;
  }
}

async function generateWeComTokenReportForUser(user, res, body) {
  try {
    sendJson(res, 200, await buildWeComTokenReportForUser(user, body));
  } catch (error) {
    sendJson(res, error.statusCode || 500, { error: error.message || "企微授权数据导入失败。", summary: error.summary });
  }
}

async function triggerWeComTokenAutoReport(userId, handoff, token, reason = "") {
  console.log(`[wecom-token] auto-report disabled; waiting for manual generate ${handoff?.id || ""} ${reason}`.trim());
  return;
  if (!userId || !handoff?.id || !token) return;
  const autoKey = `token:${handoff.id}`;
  if (activeWeComAutoReports.has(autoKey)) return;
  activeWeComAutoReports.add(autoKey);
  setImmediate(async () => {
    try {
      const user = await getUserById(userId);
      if (!user) throw new Error("企微扫码用户不存在，无法自动生成token报告。");
      const result = await buildWeComTokenReportForUser(user, {
        token,
        merCode: handoff.merCode,
        merName: handoff.merName,
        username: `wecom_${handoff.merCode || handoff.id}`,
      });
      await queryDb("update sijichan_token_handoffs set used_at=now(), status='used', updated_at=now() where id=$1", [handoff.id]).catch(() => null);
      console.log(`[wecom-token] auto-report ${handoff.id} ${reason} ${result.reportId}`);
    } catch (error) {
      await queryDb("update sijichan_token_handoffs set last_error=$2, updated_at=now() where id=$1", [handoff.id, String(error.message || "企微token自动生成报告失败。").slice(0, 1000)]).catch(() => null);
      console.error(`[wecom-token] auto-report failed ${handoff.id}:`, error);
    } finally {
      activeWeComAutoReports.delete(autoKey);
    }
  });
}

async function handleCreateWeComHandoff(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  const body = await readJsonBody(req, 1024 * 64).catch(() => ({}));
  const handoff = await createSijichanTokenHandoff(user, body);
  const baseUrl = publicReportBaseUrl.replace(/\/+$/, "");
  const ssoRedirect = `${baseUrl}/api/wecom-sso/callback?handoffId=${encodeURIComponent(handoff.id)}`;
  const wecomSsoUrl = `https://login.work.weixin.qq.com/wwlogin/sso/login/?login_type=CorpApp&appid=ww408c023179829552&agentid=1000157&redirect_uri=${encodeURIComponent(ssoRedirect)}&state=${encodeURIComponent(handoff.handoffToken)}`;
  const merchantRedirect = `${sijichanApiOrigin}/app-jump/super-admin-login`;
  const merchantWecomSsoUrl = `https://login.work.weixin.qq.com/wwlogin/sso/login/?login_type=CorpApp&appid=ww408c023179829552&agentid=1000157&redirect_uri=${encodeURIComponent(merchantRedirect)}&state=WWLogin`;
  const helperScript = renderWeComHandoffHelperScript({ endpoint: `${baseUrl}/api/wecom-token-capture`, handoffToken: handoff.handoffToken, merCode: handoff.merCode });
  sendJson(res, 200, { ok: true, ...handoff, wecomSsoUrl, merchantWecomSsoUrl, helperScript });
}

async function handleCreateWeComBrowserSession(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  const body = await readJsonBody(req, 1024 * 64).catch(() => ({}));
  try {
    const session = await createWeComBrowserSession(user, body);
    sendJson(res, 200, { ok: true, session: getWeComBrowserSessionPublic(session) });
  } catch (error) {
    sendJson(res, 500, { error: error.message || "服务器扫码会话创建失败。" });
  }
}

async function handleCreateWeComBrowserProfileSession(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  const body = await readJsonBody(req, 1024 * 64).catch(() => ({}));
  try {
    const session = await createWeComBrowserProfileSession(user, body);
    sendJson(res, 200, { ok: true, session: getWeComBrowserSessionPublic(session) });
  } catch (error) {
    sendJson(res, 500, { error: error.message || "服务器登录态检测会话创建失败。" });
  }
}

async function handleGetWeComBrowserSessionDebug(req, res, id) {
  const user = await requireUser(req, res);
  if (!user) return;
  const session = activeWeComBrowserSessions.get(id);
  if (!session || (user.role !== "admin" && session.userId !== user.id)) {
    sendJson(res, 404, { error: "服务器扫码会话不存在或已过期。" });
    return;
  }
  sendJson(res, 200, { ok: true, debug: getWeComBrowserSessionDebug(session) });
}

async function handleGetWeComBrowserSession(req, res, id) {
  const user = await requireUser(req, res);
  if (!user) return;
  const session = activeWeComBrowserSessions.get(id);
  if (!session || (user.role !== "admin" && session.userId !== user.id)) {
    sendJson(res, 404, { error: "服务器扫码会话不存在或已过期。" });
    return;
  }
  const handoff = await getSijichanTokenHandoffForUser(user, session.handoff.id, false);
  if (handoff?.captured && session.status !== "captured") {
    session.status = "captured";
    session.updatedAt = new Date().toISOString();
    logWeComSessionState(session, "handoff-captured");
  }
  if (session.status === "captured") triggerWeComBrowserAutoReport(session, "handoff-captured");
  if (session.exportReady) triggerWeComBrowserAutoReport(session, "export-ready-poll");
  if (session.page && !session.page.isClosed() && canProbeMerchantBusiness(session.page.url())) {
    await session.prepareBrowserExport?.().catch(() => null);
    triggerWeComBrowserAutoReport(session, "merchant-ready-poll");
  }
  logWeComSessionState(session, "poll");
  sendJson(res, 200, { ok: true, session: getWeComBrowserSessionPublic(session), handoff });
}

async function handleFillWeComBrowserMerchantCode(req, res, id) {
  const user = await requireUser(req, res);
  if (!user) return;
  const session = activeWeComBrowserSessions.get(id);
  if (!session || (user.role !== "admin" && session.userId !== user.id)) {
    sendJson(res, 404, { error: "服务器扫码会话不存在或已过期。" });
    return;
  }
  if (!session.page || session.page.isClosed()) {
    sendJson(res, 409, { error: "服务器浏览器页面已关闭，请重新生成企微二维码。" });
    return;
  }
  const body = await readJsonBody(req, 1024 * 64).catch(() => ({}));
  const merCode = String(body.merCode || "").trim();
  const merName = String(body.merName || "").trim();
  if (!merCode) {
    sendJson(res, 400, { error: "请先填写客户编码。" });
    return;
  }
  if (!/^\d{6}$/.test(merCode)) {
    sendJson(res, 400, { error: "访问用户编码必须是6位数字，请检查后重新填写。" });
    return;
  }
  if (!canAttemptMerchantCodeFill(session.page.url())) {
    sendJson(res, 409, { error: "服务器浏览器尚未进入客户编码选择页，请先完成企微扫码确认。" });
    return;
  }
  const filled = await fillMerchantCodeInPage(session.page, merCode);
  if (!filled) {
    session.merchantCodeFillAvailable = await detectMerchantCodeInputInPage(session.page);
    session.updatedAt = new Date().toISOString();
    sendJson(res, 409, { error: "当前服务器页面没有识别到客户编码输入框，请查看服务器页面截图确认扫码状态。", session: getWeComBrowserSessionPublic(session) });
    return;
  }
  session.handoff.merCode = merCode;
  session.handoff.merName = merName || session.handoff.merName || "";
  session.merCodeFilled = true;
  session.merCodeSubmitTried = filled === "filled-clicked";
  session.merchantCodeFillAvailable = false;
  session.scanStage = "merchant_code_submitted";
  session.scanHint = "客户编码已提交，正在进入新零售管理平台";
  session.updatedAt = new Date().toISOString();
  await session.page.waitForTimeout(3000).catch(() => null);
  session.currentUrl = session.page.url();
  session.pageTitle = await session.page.title().catch(() => session.pageTitle || "");
  await session.page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => null);
  await session.focusBestMerchantPage?.().catch(() => null);
  session.currentUrl = session.page.url();
  session.pageTitle = await session.page.title().catch(() => session.pageTitle || "");
  await session.prepareBrowserExport?.().catch(() => null);
  logWeComSessionState(session, `manual-mer-code-${filled}`);
  sendJson(res, 200, { ok: true, filled, session: getWeComBrowserSessionPublic(session) });
}

async function handleGetWeComBrowserSessionScreenshot(req, res, id) {
  const user = await requireUser(req, res);
  if (!user) return;
  const session = activeWeComBrowserSessions.get(id);
  if (!session || (user.role !== "admin" && session.userId !== user.id)) {
    sendJson(res, 404, { error: "服务器扫码会话不存在或已过期。" });
    return;
  }
  if (!session.page || session.page.isClosed()) {
    sendJson(res, 409, { error: "服务器浏览器页面已关闭，无法截图。" });
    return;
  }
  try {
    const png = await session.page.screenshot({ fullPage: false });
    res.writeHead(200, {
      "Content-Type": "image/png",
      "Cache-Control": "no-store",
      "Content-Length": png.length,
    });
    res.end(png);
  } catch (error) {
    sendJson(res, 500, { error: error.message || "服务器浏览器截图失败。" });
  }
}

async function handleGetWeComHandoff(req, res, id) {
  const user = await requireUser(req, res);
  if (!user) return;
  const handoff = await getSijichanTokenHandoffForUser(user, id, false);
  if (!handoff) {
    sendJson(res, 404, { error: "企微授权交接会话不存在。" });
    return;
  }
  sendJson(res, 200, { ok: true, handoff });
}

async function handleCaptureWeComToken(req, res) {
  const body = await readJsonBody(req, 1024 * 256);
  try {
    const handoff = await captureSijichanTokenHandoff(body.handoffToken || body.state || "", body.token || body.authorization || "", body);
    sendJson(res, 200, { ok: true, handoff }, weComCaptureCorsHeaders(req));
  } catch (error) {
    await markSijichanHandoffError(body.handoffToken || body.state || "", error.message || "企微授权token交接失败。");
    sendJson(res, 400, { error: error.message || "企微授权token交接失败。" }, weComCaptureCorsHeaders(req));
  }
}

async function handleWeComSsoCallback(req, res) {
  const url = new URL(req.url, "http://localhost");
  const state = url.searchParams.get("state") || "";
  const handoffId = url.searchParams.get("handoffId") || "";
  const token = url.searchParams.get("token") || url.searchParams.get("authorization") || url.searchParams.get("access_token") || "";
  const code = url.searchParams.get("code") || "";
  let message = "企微扫码已返回本站。";
  let ok = true;
  if (token) {
    try {
      await captureSijichanTokenHandoff(state, token, {});
      message = "已自动捕获授权token，可以回到四季蝉门户生成报告。";
    } catch (error) {
      ok = false;
      message = error.message || "自动捕获授权token失败。";
    }
  } else if (code) {
    const exchanged = await exchangeWeComCodeForSijichanToken({ code, handoffId, state });
    if (exchanged.token) {
      try {
        await captureSijichanTokenHandoff(state, exchanged.token, {});
        message = "企微授权code已换取业务token，可以回到四季蝉门户生成报告。";
      } catch (error) {
        ok = false;
        message = error.message || "企微授权code换取token后保存失败。";
      }
    } else {
      ok = false;
      message = "企微已返回授权code，但新零售跳转未直接返回业务token。请在新零售页面运行授权助手交接token。";
      await markSijichanHandoffError(state, exchanged.diagnostics.join("；"));
    }
  } else {
    ok = false;
    message = "企微回调没有携带业务token。请在新零售页面使用授权助手交接token。";
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><meta charset="utf-8"><title>企微授权交接</title><body style="font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:32px;background:#f5f7ff;color:#14213d"><main style="max-width:720px;margin:auto;background:white;border:1px solid #d7e2ff;border-radius:12px;padding:28px;box-shadow:0 18px 60px rgba(36,76,160,.12)"><h1>${ok ? "授权交接处理中" : "需要手动交接token"}</h1><p>${escapeHtml(message)}</p><p>可以关闭本页，回到四季蝉门户的 AI复盘报告 页面继续。</p></main></body>`);
}

async function handleWeComHandoffReviewReport(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  const body = await readJsonBody(req, 1024 * 128);
  const handoff = await getSijichanTokenHandoffForUser(user, String(body.handoffId || ""), true);
  if (!handoff) {
    sendJson(res, 404, { error: "企微授权交接会话不存在。" });
    return;
  }
  if (!handoff.token) {
    sendJson(res, 409, { error: "企微授权token尚未捕获，请先完成扫码并运行授权助手。" });
    return;
  }
  await queryDb("update sijichan_token_handoffs set used_at=now(), status='used', updated_at=now() where id=$1", [handoff.id]).catch(() => null);
  await generateWeComTokenReportForUser(user, res, { token: handoff.token, merCode: body.merCode || handoff.merCode, merName: body.merName || handoff.merName });
}

async function buildWeComBrowserSessionReportForUser(user, session, body = {}) {
  const config = await loadAiConfigForUser(user);
  if (!config.apiKey || !config.model) {
    const error = new Error("AI服务未配置，请在AI配置页面保存自己的API Key，或联系管理员hydee配置兜底API。");
    error.statusCode = 400;
    throw error;
  }
  const jobKey = `wecom-browser:${user.id}`;
  const job = await beginReviewJob(jobKey, { userId: user.id, sourceType: "wecom_browser", sourceName: "企微扫码服务器登录", retryPayload: { sourceType: "wecom_browser", sessionId: session.id, merCode: body.merCode || session.handoff?.merCode || "", merName: body.merName || session.handoff?.merName || "" } });
  let datasetId = "";
  console.log(`[review] start ${jobKey} ${String(body.merCode || session.handoff?.merCode || "").trim()}`);
  try {
    await updateReviewReportProgress(job.reportDbId, "collecting", "服务器浏览器已接管登录，正在读取销售、活动与培训数据。", 12);
    const raw = await collectSijichanDataWithBrowserSession(session, {
      merCode: body.merCode || session.handoff?.merCode,
      merName: body.merName || session.handoff?.merName,
      source: "企微扫码服务器登录",
      asOf: body.asOf,
    });
    await assertReviewJobStillActive(job);
    const summary = summarizeSijichanRaw(raw);
    const files = summary.datasetFiles || [];
    if (!files.some((file) => file.rowCount > 0)) {
      await markReviewReportStatus(job.reportDbId, "failed", "服务器浏览器已登录新零售，但当前账号/客户在当前口径无可复盘明细数据。");
      finishReviewJob(jobKey, job.startedAt, "empty");
      const error = new Error("服务器浏览器已登录新零售，但当前账号/客户在当前口径无可复盘明细数据。");
      error.statusCode = 422;
      error.summary = summaryForResponse(summary);
      throw error;
    }
    await updateReviewReportProgress(job.reportDbId, "dataset_ready", "服务器浏览器数据已返回，正在整理可复盘明细。", 42);
    datasetId = await saveDatasetRecord(user.id, "wecom_browser", summary, summary.source || "企微扫码服务器登录");
    await assertReviewJobStillActive(job);
    await updateReviewReportProgress(job.reportDbId, "ai_generating", "明细数据已整理完成，正在生成AI复盘报告。", 62);
    const { report, markdown, reportId, shareUrl, svgUrl, qrSvgUrl, excelUrl, excelStatus, excelError, excelFileName, normalizedDataUrl, diagnosticsUrl } = await generateReportFromSummary(summary, user);
    await assertReviewJobStillActive(job);
    await updateReviewReportProgress(job.reportDbId, "publishing", "AI分析已完成，正在生成分享页、SVG和二维码；Excel汇总将在后台生成。", 88);
    const generated = { report, markdown, reportId, shareUrl, svgUrl, qrSvgUrl, excelUrl, excelStatus, excelError, excelFileName, normalizedDataUrl, diagnosticsUrl };
    const dbReportId = await saveReviewReportRecord(user.id, "wecom_browser", "企微扫码服务器登录", summary, generated, { reportDbId: job.reportDbId, jobKey });
    queueReviewWorkbookGeneration(dbReportId, summary, report, markdown, generated);
    await linkDatasetToReviewReport(datasetId, dbReportId, "completed");
    finishReviewJob(jobKey, job.startedAt, reportId);
    return buildGeneratedReviewResponse(dbReportId, summary, generated);
  } catch (error) {
    await failReviewJob(jobKey, error, job.reportDbId);
    await linkDatasetToReviewReport(datasetId, null, "failed", error.message);
    console.error(`[review] failed ${jobKey}:`, error);
    throw error;
  }
}

async function generateWeComBrowserSessionReportForUser(user, res, session, body = {}) {
  try {
    sendJson(res, 200, await buildWeComBrowserSessionReportForUser(user, session, body));
  } catch (error) {
    sendJson(res, error.statusCode || 500, { error: error.message || "企微授权数据导入失败。", summary: error.summary });
  }
}

async function triggerWeComBrowserAutoReport(session, reason = "") {
  if (session) {
    session.autoReport = { status: "manual_required", reason, updatedAt: new Date().toISOString() };
    session.updatedAt = session.autoReport.updatedAt;
  }
  console.log(`[wecom-browser] auto-report disabled; waiting for manual generate ${session?.id || ""} ${reason}`.trim());
  return;
  if (!session || !session.userId || !session.id) return;
  if (session.autoReport?.status === "running" || session.autoReport?.status === "completed") return;
  if (activeWeComAutoReports.has(session.id)) return;
  const canUseBrowserSession = Boolean(session.page && !session.page.isClosed() && canProbeMerchantBusiness(session.page.url()));
  if (!session.exportReady && !canUseBrowserSession) return;
  activeWeComAutoReports.add(session.id);
  session.autoReport = { status: "running", reason, startedAt: new Date().toISOString() };
  session.updatedAt = session.autoReport.startedAt;
  setImmediate(async () => {
    try {
      const user = await getUserById(session.userId);
      if (!user) throw new Error("企微扫码用户不存在，无法自动生成报告。");
      if (typeof session.prepareBrowserExport === "function") await session.prepareBrowserExport();
      const result = await buildWeComBrowserSessionReportForUser(user, session, {
        merCode: session.handoff?.merCode,
        merName: session.handoff?.merName,
      });
      session.autoReport = {
        status: "completed",
        reason,
        completedAt: new Date().toISOString(),
        id: result.id,
        reportId: result.reportId,
        shareUrl: result.shareUrl,
        svgUrl: result.svgUrl,
        qrSvgUrl: result.qrSvgUrl,
        excelUrl: result.excelUrl,
      };
      session.updatedAt = session.autoReport.completedAt;
      console.log(`[wecom-browser] auto-report ${session.id} ${result.reportId}`);
    } catch (error) {
      session.autoReport = {
        status: "failed",
        reason,
        failedAt: new Date().toISOString(),
        error: error.message || "企微扫码自动生成报告失败。",
      };
      session.updatedAt = session.autoReport.failedAt;
      console.error(`[wecom-browser] auto-report failed ${session.id}:`, error);
    } finally {
      activeWeComAutoReports.delete(session.id);
    }
  });
}

async function handleWeComBrowserSessionReviewReport(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  const body = await readJsonBody(req, 1024 * 128);
  const session = activeWeComBrowserSessions.get(String(body.sessionId || ""));
  if (!session || (user.role !== "admin" && session.userId !== user.id)) {
    sendJson(res, 404, { error: "服务器扫码会话不存在或已过期，请重新生成企微二维码。" });
    return;
  }
  const handoff = await getSijichanTokenHandoffForUser(user, session.handoff.id, true).catch(() => null);
  if (handoff?.token && session.status !== "captured") {
    session.status = "captured";
    session.updatedAt = new Date().toISOString();
    logWeComSessionState(session, "handoff-token-ready");
  }
  if (session.exportReady && session.page && !session.page.isClosed()) {
    await generateWeComBrowserSessionReportForUser(user, res, session, body);
    return;
  }
  if (handoff?.token) {
    await queryDb("update sijichan_token_handoffs set used_at=now(), status='used', updated_at=now() where id=$1", [handoff.id]).catch(() => null);
    await generateWeComTokenReportForUser(user, res, { token: handoff.token, merCode: body.merCode || handoff.merCode, merName: body.merName || handoff.merName });
    return;
  }
  if (session.status === "expired" || session.status === "error" || session.page?.isClosed?.()) {
    sendJson(res, 409, { error: session.lastError || "服务器扫码会话不可用，请重新生成二维码并扫码。" });
    return;
  }
  if (!canProbeMerchantBusiness(session.page.url())) {
    sendJson(res, 409, { error: "服务器浏览器尚未进入新零售管理平台，请扫码确认登录后再生成报告。" });
    return;
  }
  await generateWeComBrowserSessionReportForUser(user, res, session, body);
}

async function handleListMonthlyMarketing(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  const url = new URL(req.url, "http://localhost");
  const monthKey = url.searchParams.get("month") || monthKeyFromDate();
  const aggregate = await getMonthlyMarketingAggregate(user, monthKey);
  sendJson(res, 200, { ok: true, monthKey, aggregate });
}

async function handleGenerateMonthlyMarketing(req, res) {
  const user = await requireAdmin(req, res);
  if (!user) return;
  const body = await readJsonBody(req, 1024 * 1024).catch(() => ({}));
  const monthKey = String(body.monthKey || monthKeyFromDate()).trim();
  const results = await generateMonthlyMarketingBatch(user, monthKey);
  sendJson(res, 200, {
    ok: true,
    monthKey,
    total: results.length,
    success: results.filter((item) => item.ok).length,
    failed: results.filter((item) => !item.ok).length,
    results,
  });
}

async function handleRegister(req, res) {
  const body = await readJsonBody(req);
  const name = String(body.name || "").trim();
  const companyName = String(body.companyName || "").trim();
  const phone = String(body.phone || "").trim();
  const email = String(body.email || "").trim();
  const loginIdentifier = email || phone || name;
  const password = String(body.password || "");
  if (!name || !password || (!phone && !email)) {
    await recordAuthOperation(req, { loginIdentifier, operationType: "register", success: false, failureReason: "missing_required_fields" });
    sendJson(res, 400, { error: "请填写姓名、手机号或邮箱、密码。" });
    return;
  }
  if (password.length < 6) {
    await recordAuthOperation(req, { loginIdentifier, operationType: "register", success: false, failureReason: "weak_password" });
    sendJson(res, 400, { error: "密码至少需要6位。" });
    return;
  }
  if (await findUserByLogin(email || phone)) {
    await recordAuthOperation(req, { loginIdentifier, operationType: "register", success: false, failureReason: "duplicate_login" });
    sendJson(res, 409, { error: "该手机号或邮箱已注册。" });
    return;
  }
  const user = await createUser({ name, phone, email, password, companyName });
  await recordAuthOperation(req, { userId: user.id, loginIdentifier, operationType: "register", success: true, metadata: { role: user.role } });
  setSessionCookie(res, user);
  sendJson(res, 200, { ok: true, user: publicUser(user), profile: await getCustomerProfile(user.id) });
}

async function handleLogin(req, res) {
  const body = await readJsonBody(req);
  const login = String(body.login || "").trim();
  const password = String(body.password || "");
  const user = await findUserByLogin(login);
  if (!user || !verifyPassword(password, user.password_hash)) {
    await recordAuthOperation(req, { userId: user?.id || null, loginIdentifier: login, operationType: "login", success: false, failureReason: "invalid_credentials" });
    sendJson(res, 401, { error: "账号或密码不正确。" });
    return;
  }
  if (user.status !== "active") {
    await recordAuthOperation(req, { userId: user.id, loginIdentifier: login, operationType: "login", success: false, failureReason: "inactive_user" });
    sendJson(res, 403, { error: "账号当前不可用，请联系管理员。" });
    return;
  }
  await recordAuthOperation(req, { userId: user.id, loginIdentifier: login, operationType: "login", success: true, metadata: { role: user.role } });
  setSessionCookie(res, user);
  sendJson(res, 200, { ok: true, user: publicUser(user), profile: await getCustomerProfile(user.id) });
}

async function handleLogout(req, res) {
  const user = await getCurrentUser(req);
  await recordAuthOperation(req, { userId: user?.id || null, loginIdentifier: user?.email || user?.phone || user?.name || "", operationType: "logout", success: true });
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
  const url = new URL(req.url, "http://localhost");
  const options = parseReviewReportListOptions(url);
  const result = await listReviewReports(user, options);
  sendJson(res, 200, {
    reports: result.items,
    items: result.items,
    total: result.total,
    page: result.page,
    pageSize: result.pageSize,
  });
}

async function handleGetRunningReport(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  const url = new URL(req.url, "http://localhost");
  const sourceGroup = url.searchParams.get("sourceGroup") || "";
  const report = await getLatestRunningReviewReport(user, sourceGroup);
  sendJson(res, 200, { ok: true, report });
}

async function handleAdminListUsers(req, res) {
  const user = await requireAdmin(req, res);
  if (!user) return;
  const url = new URL(req.url, "http://localhost");
  const options = parseAdminUserListOptions(url);
  const result = await listAdminUsers(options);
  sendJson(res, 200, {
    users: result.items,
    items: result.items,
    total: result.total,
    page: result.page,
    pageSize: result.pageSize,
    stats: result.stats,
  });
}

async function handleAdminUpdateUser(req, res, id) {
  const user = await requireAdmin(req, res);
  if (!user) return;
  const body = await readJsonBody(req, 1024 * 256);
  try {
    const updated = await updateAdminUser(user, id, body);
    sendJson(res, 200, { ok: true, user: updated });
  } catch (error) {
    sendJson(res, error.statusCode || 500, { error: error.message || "用户信息更新失败。" });
  }
}

async function handleGetReport(req, res, id) {
  const user = await requireUser(req, res);
  if (!user) return;
  const report = await getReviewReport(user, id);
  if (!report) {
    sendJson(res, 404, { error: "报告不存在或无权查看。" });
    return;
  }
  sendJson(res, 200, {
    report: {
      ...report,
      summary: summaryForResponse(report.summary),
    },
  });
}

async function handleGetReportStatus(req, res, id) {
  const user = await requireUser(req, res);
  if (!user) return;
  const report = await getReviewReportMeta(user, id);
  if (!report) {
    sendJson(res, 404, { error: "报告不存在或无权查看。" });
    return;
  }
  sendJson(res, 200, {
    ok: true,
    report: {
      id: report.id,
      reportId: report.reportId,
      status: report.status,
      shareUrl: report.shareUrl,
      svgUrl: report.svgUrl,
      qrSvgUrl: report.qrSvgUrl,
      excelUrl: report.excelUrl,
      excelStatus: report.excelStatus,
      excelError: report.excelError,
      normalizedDataUrl: report.normalizedDataUrl,
      diagnosticsUrl: report.diagnosticsUrl,
      progressStage: report.progressStage,
      progressText: report.progressText,
      progressPercent: report.progressPercent,
      errorMessage: report.errorMessage,
      updatedAt: new Date().toISOString(),
    },
  });
}

async function handleListReportStatuses(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  const url = new URL(req.url, "http://localhost");
  const ids = (url.searchParams.get("ids") || "")
    .split(",")
    .map((id) => decodeURIComponent(id).trim())
    .filter(Boolean);
  const reports = await listReviewReportStatuses(user, ids);
  sendJson(res, 200, { ok: true, reports, items: reports });
}

async function handleGetReviewJobEvents(req, res, id) {
  const user = await requireUser(req, res);
  if (!user) return;
  const result = await listReviewJobEvents(user, id);
  if (!result) {
    sendJson(res, 404, { error: "报告不存在或无权查看任务流水。" });
    return;
  }
  sendJson(res, 200, {
    ok: true,
    report: result.report,
    events: result.events,
  });
}

async function handleCancelReviewJob(req, res, id) {
  const user = await requireUser(req, res);
  if (!user) return;
  const report = await getReviewReport(user, id);
  if (!report) {
    sendJson(res, 404, { error: "任务不存在或无权操作。" });
    return;
  }
  if (report.status === "completed") {
    sendJson(res, 409, { error: "报告已经生成完成，不能取消。" });
    return;
  }
  const activeEntry = Array.from(activeReviewJobs.entries()).find(([, job]) => job.reportDbId === id || job.key === report.jobKey);
  if (activeEntry) {
    activeEntry[1].cancelRequested = true;
    activeReviewJobs.delete(activeEntry[0]);
  }
  const updated = await updateReviewReportByUser(user, id, {
    status: "cancelled",
    cancelRequested: true,
    errorMessage: "用户已取消该复盘任务。",
    finishNow: true,
  });
  sendJson(res, 200, { ok: true, report: updated });
}

async function handleRetryReviewJob(req, res, id) {
  const user = await requireUser(req, res);
  if (!user) return;
  const report = await getReviewReport(user, id);
  if (!report) {
    sendJson(res, 404, { error: "任务不存在或无权操作。" });
    return;
  }
  if (report.status === "running") {
    sendJson(res, 409, { error: "该复盘任务仍在生成中，请先取消或等待完成。" });
    return;
  }
  if (report.status === "completed") {
    sendJson(res, 409, { error: "报告已经生成完成，无需重试。" });
    return;
  }
  const updated = await updateReviewReportByUser(user, id, {
    status: "cancelled",
    errorMessage: "已准备重试，请回到AI复盘报告页面重新发起生成。",
    finishNow: true,
  });
  sendJson(res, 200, {
    ok: true,
    report: updated,
    action: "open_ai_review",
    sourceType: report.sourceType,
    message: "请回到AI复盘报告页重新发起生成。为了数据安全，系统不会保存或回填四季蝉密码、企微token和上传Excel原文件。",
  });
}

async function handleSubmitCapabilityTest(req, res) {
  const body = await readJsonBody(req, 1024 * 1024 * 2);
  const submission = await saveCapabilitySubmission(body, req);
  sendJson(res, 200, { ok: true, submission });
}

async function handleListCapabilityTests(req, res) {
  const user = await requireAdmin(req, res);
  if (!user) return;
  const url = new URL(req.url, "http://localhost");
  const options = parseCapabilitySubmissionListOptions(url);
  const result = await listCapabilitySubmissions(options);
  sendJson(res, 200, {
    submissions: result.items,
    items: result.items,
    total: result.total,
    page: result.page,
    pageSize: result.pageSize,
  });
}

async function handleGetCapabilityTest(req, res, id) {
  const user = await requireAdmin(req, res);
  if (!user) return;
  const submission = await getCapabilitySubmission(id);
  if (!submission) {
    sendJson(res, 404, { error: "测评提交记录不存在。" });
    return;
  }
  sendJson(res, 200, { ok: true, submission });
}

function streamStaticFile(res, filePath, notFoundMessage = "Not found") {
  fs.stat(filePath, (statError, stats) => {
    if (statError || !stats.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(notFoundMessage);
      return;
    }
    const stream = fs.createReadStream(filePath);
    stream.on("error", (error) => {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("File stream error");
      } else {
        res.destroy(error);
      }
    });
    res.writeHead(200, {
      "Content-Type": mime[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      "Content-Length": stats.size,
    });
    stream.pipe(res);
  });
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
    streamStaticFile(res, reportPath, "Report not found");
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

  streamStaticFile(res, filePath, "Not found");
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
      if (url.pathname === "/api/review-prompt" && req.method === "GET") return await handleGetReviewPrompt(req, res);
      if (url.pathname === "/api/review-prompt" && req.method === "POST") return await handleSaveReviewPrompt(req, res);
      if (url.pathname === "/api/review-report" && req.method === "POST") return await handleReviewReport(req, res);
      if (url.pathname === "/api/sijichan-review-report" && req.method === "POST") return await handleSijichanReviewReport(req, res);
      if (url.pathname === "/api/wecom-token-review-report" && req.method === "POST") return await handleWeComTokenReviewReport(req, res);
      if (url.pathname === "/api/wecom-handoff" && req.method === "POST") return await handleCreateWeComHandoff(req, res);
      if (url.pathname === "/api/wecom-browser-session" && req.method === "POST") return await handleCreateWeComBrowserSession(req, res);
      if (url.pathname === "/api/wecom-browser-profile-session" && req.method === "POST") return await handleCreateWeComBrowserProfileSession(req, res);
      if (url.pathname === "/api/wecom-token-capture" && req.method === "OPTIONS") return sendNoContent(res, weComCaptureCorsHeaders(req));
      if (url.pathname === "/api/wecom-token-capture" && req.method === "POST") return await handleCaptureWeComToken(req, res);
      if (url.pathname === "/api/wecom-handoff-review-report" && req.method === "POST") return await handleWeComHandoffReviewReport(req, res);
      if (url.pathname === "/api/wecom-browser-session-review-report" && req.method === "POST") return await handleWeComBrowserSessionReviewReport(req, res);
      if (url.pathname === "/api/wecom-sso/callback" && req.method === "GET") return await handleWeComSsoCallback(req, res);
      if (url.pathname === "/api/monthly-marketing-recommendations" && req.method === "GET") return await handleListMonthlyMarketing(req, res);
      if (url.pathname === "/api/monthly-marketing-recommendations/generate" && req.method === "POST") return await handleGenerateMonthlyMarketing(req, res);
      if (url.pathname === "/api/review-reports" && req.method === "GET") return await handleListReports(req, res);
      if (url.pathname === "/api/review-reports/running" && req.method === "GET") return await handleGetRunningReport(req, res);
      if (url.pathname === "/api/admin/users" && req.method === "GET") return await handleAdminListUsers(req, res);
      if (url.pathname === "/api/capability-test-submissions" && req.method === "POST") return await handleSubmitCapabilityTest(req, res);
      if (url.pathname === "/api/capability-test-submissions" && req.method === "GET") return await handleListCapabilityTests(req, res);
      const capabilitySubmissionMatch = url.pathname.match(/^\/api\/capability-test-submissions\/([^/]+)$/);
      if (capabilitySubmissionMatch && req.method === "GET") return await handleGetCapabilityTest(req, res, decodeURIComponent(capabilitySubmissionMatch[1]));
      const adminUserMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
      if (adminUserMatch && req.method === "PATCH") return await handleAdminUpdateUser(req, res, decodeURIComponent(adminUserMatch[1]));
      const handoffMatch = url.pathname.match(/^\/api\/wecom-handoff\/([^/]+)$/);
      if (handoffMatch && req.method === "GET") return await handleGetWeComHandoff(req, res, decodeURIComponent(handoffMatch[1]));
      const browserSessionScreenshotMatch = url.pathname.match(/^\/api\/wecom-browser-session\/([^/]+)\/screenshot$/);
      if (browserSessionScreenshotMatch && req.method === "GET") return await handleGetWeComBrowserSessionScreenshot(req, res, decodeURIComponent(browserSessionScreenshotMatch[1]));
      const browserSessionDebugMatch = url.pathname.match(/^\/api\/wecom-browser-session\/([^/]+)\/debug$/);
      if (browserSessionDebugMatch && req.method === "GET") return await handleGetWeComBrowserSessionDebug(req, res, decodeURIComponent(browserSessionDebugMatch[1]));
      const browserSessionFillCodeMatch = url.pathname.match(/^\/api\/wecom-browser-session\/([^/]+)\/merchant-code$/);
      if (browserSessionFillCodeMatch && req.method === "POST") return await handleFillWeComBrowserMerchantCode(req, res, decodeURIComponent(browserSessionFillCodeMatch[1]));
      const browserSessionMatch = url.pathname.match(/^\/api\/wecom-browser-session\/([^/]+)$/);
      if (browserSessionMatch && req.method === "GET") return await handleGetWeComBrowserSession(req, res, decodeURIComponent(browserSessionMatch[1]));
      const reportEventsMatch = url.pathname.match(/^\/api\/review-reports\/([^/]+)\/events$/);
      if (reportEventsMatch && req.method === "GET") return await handleGetReviewJobEvents(req, res, decodeURIComponent(reportEventsMatch[1]));
      if (url.pathname === "/api/review-reports/status" && req.method === "GET") return await handleListReportStatuses(req, res);
      const reportStatusMatch = url.pathname.match(/^\/api\/review-reports\/([^/]+)\/status$/);
      if (reportStatusMatch && req.method === "GET") return await handleGetReportStatus(req, res, decodeURIComponent(reportStatusMatch[1]));
      const reportMatch = url.pathname.match(/^\/api\/review-reports\/([^/]+)$/);
      if (reportMatch && req.method === "GET") return await handleGetReport(req, res, decodeURIComponent(reportMatch[1]));
      const cancelReviewJobMatch = url.pathname.match(/^\/api\/review-reports\/([^/]+)\/cancel$/);
      if (cancelReviewJobMatch && req.method === "POST") return await handleCancelReviewJob(req, res, decodeURIComponent(cancelReviewJobMatch[1]));
      const retryReviewJobMatch = url.pathname.match(/^\/api\/review-reports\/([^/]+)\/retry$/);
      if (retryReviewJobMatch && req.method === "POST") return await handleRetryReviewJob(req, res, decodeURIComponent(retryReviewJobMatch[1]));
      return serveStatic(req, res);
    } catch (error) {
      const status = error.statusCode || (error.message && error.message.includes("超过10MB") ? 413 : 500);
      console.error(`[request] ${req.method} ${req.url} failed ${status}:`, error);
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
    startReviewMaintenanceLoop();
    console.log(`Preview: http://localhost:${port}/?v=preview-server`);
  });
}

async function closeActiveWeComBrowserSessions() {
  const sessions = Array.from(activeWeComBrowserSessions.values());
  await Promise.allSettled(sessions.map((session) => closeWeComBrowserSession(session, session.status === "captured" ? "" : "closed")));
}

let shutdownStarted = false;
function installShutdownHandlers() {
  const shutdown = async (signal) => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    try {
      stopReviewMaintenanceLoop();
      await closeActiveWeComBrowserSessions();
    } finally {
      process.exit(signal === "SIGTERM" ? 0 : 1);
    }
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

if (!isMainThread && workerData?.type === "review-workbook") {
  handleReviewWorkbookWorker()
    .then(() => parentPort?.postMessage({ ok: true }))
    .catch((error) => {
      parentPort?.postMessage({ ok: false, error: error?.message || "Excel汇总生成失败。" });
      process.exitCode = 1;
    });
} else {
  installShutdownHandlers();

  if (process.env.REFRESH_ONLY === "true") {
    refreshExistingReportArtifacts(process.env.REFRESH_REPORT_ID || "")
      .then(() => process.exit(0))
      .catch((error) => {
        console.error(`Refresh existing reports failed: ${error.message}`);
        process.exit(1);
      });
  } else if (process.env.MONTHLY_MARKETING_ONLY === "true") {
    generateMonthlyMarketingBatch({ id: "system", role: "admin" }, process.env.MONTHLY_MARKETING_MONTH || monthKeyFromDate())
      .then((results) => {
        console.log(JSON.stringify({ ok: true, total: results.length, success: results.filter((item) => item.ok).length, failed: results.filter((item) => !item.ok).length }, null, 2));
        process.exit(0);
      })
      .catch((error) => {
        console.error(`Monthly marketing generation failed: ${error.message}`);
        process.exit(1);
      });
  } else {
    if (process.env.REFRESH_EXISTING_REPORTS === "true" || process.env.REFRESH_REPORT_ID) {
      refreshExistingReportArtifacts(process.env.REFRESH_REPORT_ID || "").catch((error) => {
        console.warn(`Refresh existing reports failed: ${error.message}`);
      });
    }
    listenOn();
  }
}
