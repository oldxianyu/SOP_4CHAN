const http = require("http");
const dns = require("dns");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const net = require("net");
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
const activeReviewJobs = new Set();
const activeWeComBrowserSessions = new Map();
const workbookDetailRowLimit = Number(process.env.WORKBOOK_DETAIL_ROW_LIMIT || 5000);
const disableLocalDataFallback = process.env.DISABLE_LOCAL_DATA_FALLBACK === "true";

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
  return { users: [], customerProfiles: [], aiConfigs: [], customerDatasets: [], reviewReports: [], capabilityTestSubmissions: [] };
}

function readLocalData() {
  if (disableLocalDataFallback) return emptyLocalData();
  if (!fs.existsSync(localDataPath)) {
    return emptyLocalData();
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
    return emptyLocalData();
  }
}

function writeLocalData(data) {
  if (disableLocalDataFallback) {
    throw new Error("本地JSON兜底存储已关闭，请检查数据库连接。");
  }
  ensureServerDir();
  fs.writeFileSync(localDataPath, JSON.stringify(data, null, 2), "utf8");
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
      owner_user_id text references users(id) on delete cascade,
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
      status text not null default 'completed',
      report_title text,
      row_counts_json jsonb not null default '{}'::jsonb,
      health_score numeric,
      risk_level text,
      summary_json jsonb not null default '{}'::jsonb,
      report_json jsonb not null default '{}'::jsonb,
      markdown text,
      report_id text unique not null,
      share_url text,
      svg_url text,
      qr_svg_url text,
      excel_url text,
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
        normalized_data_url text,
        diagnostics_url text,
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
          r.normalized_data_url,
          r.diagnostics_url,
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
      do $$
      declare
        t text;
        trigger_name text;
      begin
        foreach t in array array[
          'users',
          'customer_profiles',
          'ai_configs',
          'customer_datasets',
          'ai_review_uploads',
          'review_reports',
          'review_report_payloads',
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
      alter table review_reports add column if not exists status text not null default 'completed';
      alter table review_reports add column if not exists report_title text;
      alter table review_reports add column if not exists row_counts_json jsonb not null default '{}'::jsonb;
      alter table review_reports add column if not exists health_score numeric;
      alter table review_reports add column if not exists risk_level text;
      alter table review_reports add column if not exists excel_url text;
      alter table review_reports add column if not exists normalized_data_url text;
      alter table review_reports add column if not exists diagnostics_url text;
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
      create index if not exists idx_review_reports_user_created on review_reports(user_id, created_at desc);
      create index if not exists idx_review_reports_created on review_reports(created_at desc);
      create index if not exists idx_review_reports_status_created on review_reports(status, created_at desc);
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

async function listAdminUsers() {
  if (await isDbAvailable()) {
    const result = await queryDb(
      `select
         u.id, u.name, u.phone, u.email, u.password_hash, u.role, u.status, u.created_at, u.updated_at,
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
       ) al on al.user_id = u.id
       order by u.created_at desc`,
    );
    return result.rows.map(normalizeAdminUserRow);
  }

  const data = readLocalData();
  return data.users
    .map((user) => {
      const userId = user.id;
      const profile = data.customerProfiles.find((item) => item.userId === userId || item.user_id === userId) || {};
      return normalizeAdminUserRow({
        ...user,
        companyName: profile.companyName || profile.company_name || "",
        reportCount: data.reviewReports.filter((item) => item.userId === userId || item.user_id === userId).length,
        datasetCount: data.customerDatasets.filter((item) => item.userId === userId || item.user_id === userId).length,
        aiConfigCount: data.aiConfigs.filter((item) => item.ownerUserId === userId || item.updatedBy === userId || item.owner_user_id === userId || item.updated_by === userId).length,
      });
    })
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
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
    datasetFiles: (summary.datasetFiles || []).map((file) => ({
      name: file.name,
      label: file.label,
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

async function saveReviewReportRecord(userId, sourceType, sourceName, summary, generated) {
  const profile = await getCustomerProfile(userId);
  if (await isDbAvailable()) {
    const activePool = await getPool();
    await ensureDatabase();
    const client = await activePool.connect();
    const digest = reviewReportDigest(summary, generated.report);
    const reportTitle = generated.report?.title || digest.reportTitle || "四季蝉AI复盘报告";
    try {
      await client.query("begin");
      const result = await client.query(
        `insert into review_reports(
          user_id, customer_profile_id, source_type, source_name, status, report_title, row_counts_json, health_score, risk_level,
          summary_json, report_json, markdown, report_id, share_url, svg_url, qr_svg_url, excel_url, normalized_data_url, diagnostics_url
        )
         values($1,$2,$3,$4,'completed',$5,$6::jsonb,$7,$8,$9::jsonb,$10::jsonb,'',$11,$12,$13,$14,$15,$16,$17)
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
          generated.normalizedDataUrl || "",
          generated.diagnosticsUrl || "",
        ],
      );
      const id = result.rows[0].id;
      await client.query(
        `insert into review_report_payloads(report_db_id, summary_json, report_json, markdown)
         values($1,$2::jsonb,$3::jsonb,$4)
         on conflict(report_db_id) do update set summary_json=excluded.summary_json, report_json=excluded.report_json, markdown=excluded.markdown, updated_at=now()`,
        [id, jsonParam(summary, {}), jsonParam(generated.report, {}), generated.markdown || ""],
      );
      await client.query("commit");
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
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
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

async function captureSijichanTokenHandoff(handoffToken, token, details = {}) {
  const payload = verifyHandoffToken(handoffToken);
  if (!payload?.id || !payload?.userId) throw new Error("企微授权交接码无效或已过期。");
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
    [payload.id, payload.userId, encryptSecret(normalizedToken), tokenExpiresAt && !Number.isNaN(tokenExpiresAt.getTime()) ? tokenExpiresAt.toISOString() : null],
  );
  if (!result.rows[0]) throw new Error("企微授权交接会话不存在或已过期。");
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
  diagnostics.push(token ? "token_extracted" : "token_not_found");
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

function uniqText(values, limit = 12) {
  return (values || [])
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .filter((value, index, arr) => arr.indexOf(value) === index)
    .slice(0, limit);
}

function anonymizedMarketingCard(index, sourceItems, monthKey) {
  const monthLabel = monthKey ? `${Number(monthKey.slice(5, 7))}月` : "当月";
  const allFocus = uniqText(sourceItems.flatMap((item) => item.recommendation?.focusProducts || []), 14);
  const allActions = uniqText(sourceItems.flatMap((item) => item.recommendation?.nextActions || []), 8);
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
    if (uniqText(completed.flatMap((item) => item.recommendation?.nextActions || []), 6).length > 1) {
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

async function listMonthlyMarketingRecommendations(user, monthKey = monthKeyFromDate()) {
  if (!(await isDbAvailable())) return [];
  const params = [monthKey];
  let where = "where m.month_key = $1";
  if (user.role !== "admin") {
    params.push(user.id);
    where += ` and m.user_id = $${params.length}`;
  }
  const result = await queryDb(
    `select m.* from monthly_marketing_recommendations m ${where} order by m.generated_at desc limit 100`,
    params,
  );
  return result.rows.map(normalizeMonthlyMarketingRow);
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
  const report = row.payload_report_json || row.payloadReportJson || row.report_json || row.reportJson || null;
  const summary = row.payload_summary_json || row.payloadSummaryJson || row.summary_json || row.summaryJson || null;
  return {
    id: row.id,
    userId: row.user_id || row.userId,
    sourceType: row.source_type || row.sourceType,
    sourceName: row.source_name || row.sourceName || "",
    status: row.status || "completed",
    reportTitle: row.report_title || row.reportTitle || report?.title || "四季蝉AI复盘报告",
    rowCounts: row.row_counts_json || row.rowCountsJson || null,
    healthScore: row.health_score ?? row.healthScore ?? null,
    riskLevel: row.risk_level || row.riskLevel || "",
    report,
    summary,
    markdown: row.payload_markdown || row.payloadMarkdown || row.markdown || "",
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
    const result = await queryDb("select * from get_review_report_list($1,$2,$3)", [user.id, user.role === "admin", 100]);
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
    const columns = `
      r.*,
      p.summary_json as payload_summary_json,
      p.report_json as payload_report_json,
      p.markdown as payload_markdown
    `;
    const result =
      user.role === "admin"
        ? await queryDb(`select ${columns} from review_reports r left join review_report_payloads p on p.report_db_id = r.id where r.id = $1 limit 1`, [id])
        : await queryDb(`select ${columns} from review_reports r left join review_report_payloads p on p.report_db_id = r.id where r.id = $1 and r.user_id = $2 limit 1`, [id, user.id]);
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

function summaryForResponse(summary) {
  if (!summary || typeof summary !== "object") return summary;
  const responseKeys = [
    "source",
    "requestInfo",
    "windows",
    "generatedAt",
    "sheetStatus",
    "datasetFiles",
    "rowCounts",
    "operationInsights",
    "salesChange",
    "activity",
    "cashout",
    "incentive",
    "shareReward",
  ];
  const next = {};
  for (const key of responseKeys) {
    if (summary[key] !== undefined) next[key] = summary[key];
  }
  if (Array.isArray(summary.interfaceDiagnostics)) {
    next.interfaceDiagnostics = summary.interfaceDiagnostics.slice(0, 80).map((item) => ({
      module: item.module || item.label || item.name || "",
      endpoint: item.endpoint || item.url || "",
      status: item.status || item.statusText || "",
      statusCode: item.statusCode || item.code || "",
      rowCount: item.rowCount ?? item.rows ?? "",
      error: item.error || item.message || "",
    }));
  }
  return next;
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
    "报告面向中国医药连锁客户阅读，所有可见文字必须使用中文。不要在报告正文中出现 role、actions、bullets、headquarters、stores、factories 等英文键名；下一步动作请写成“总部：……”“门店：……”“厂家：……”这类中文句子。",
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
    nextActions: normalizeNextActions(safe.nextActions || safe.actions || safe.recommendations),
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
  const excelUrl = reportArtifactEncodedUrl(shareUrl, reviewWorkbookFileName(summary));
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
  if (/续用风险|复盘结论/.test(sheetName)) return 4;
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
  const insightRows = [
    { 重点标注: "重点：续用判断", 模块: "客户续用健康度", 指标: "健康度评分", 数值: insights.healthScore ?? "", 结论: insights.retentionRisk ? `续用风险：${insights.retentionRisk}` : "", 建议动作: "用于判断客户是否已经把四季蝉用成持续运营工具，而不是一次性红包活动。" },
    ...((insights.scoreItems || []).map((item) => ({
      重点标注: item.level === "risk" ? "重点风险" : item.level === "watch" ? "重点关注" : "持续保持",
      模块: "健康度拆解",
      指标: item.label || item.key || "",
      数值: item.value ?? "",
      结论: item.level === "healthy" ? "表现较好" : item.level === "watch" ? "需要关注" : "流失风险",
      建议动作: item.explanation || "",
    }))),
    ...((insights.valueProofPoints || []).map((item) => ({ 重点标注: "重点价值证据", 模块: "价值证明点", 指标: "客户继续使用证据", 数值: "", 结论: item, 建议动作: "复盘会上优先展示，用数据证明四季蝉带来的动销、激励和协同价值。" }))),
    ...((insights.riskItems || []).map((item) => ({ 重点标注: "重点风险", 模块: "流失风险信号", 指标: item.label || "", 数值: item.value ?? "", 结论: item.explanation || "", 建议动作: "形成下月跟进清单，避免客户只看到成本，看不到持续运营收益。" }))),
    ...((insights.recommendedActions || []).map((item, index) => ({ 重点标注: "重点动作", 模块: "下月推动动作", 指标: `动作${index + 1}`, 数值: "", 结论: item, 建议动作: item }))),
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
    ...((report?.risks || []).map((item) => ({ 重点标注: "重点风险", 类型: "风险问题", 内容: item }))),
    ...((report?.nextActions || []).map((item) => ({ 重点标注: "重点动作", 类型: "下一步动作", 内容: item }))),
  ];
  return [
    { name: "续用风险", rows: insightRows.length ? insightRows : [{ 重点标注: "重点关注", 模块: "运营洞察", 指标: "暂无可计算洞察", 数值: "", 结论: "当前数据不足", 建议动作: "补齐销售、活动、奖励、培训、提现或厂家协同数据后再复盘。" }] },
    { name: "复盘结论", rows: conclusionRows },
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
    { name: "我的活动列表", rows: capWorkbookRows(raw.activityCatalog?.joined || [], "我的活动列表") },
    { name: "奖励统计-半年", rows: capWorkbookRows(raw.rewardStatistics?.nearHalf?.rows || [], "奖励统计-半年") },
    { name: "奖励发放明细", rows: rewardDistributionRows.length ? capWorkbookRows(rewardDistributionRows, "奖励发放明细") : [{ 类型: "奖励发放", 说明: "当前口径未识别到奖励发放明细或指标，请查看接口诊断。" }] },
    { name: "员工豆豆账户与提现", rows: employeeAccountRows.length ? capWorkbookRows(employeeAccountRows, "员工豆豆账户与提现") : [{ 类型: "员工收益闭环", 说明: "当前口径未识别到员工账户、提现、核销或结算数据，请查看接口诊断。" }] },
    { name: "销售汇总-上月_vs_前两月", rows: capWorkbookRows(raw.sales?.lastMonth_vs_priorTwoMonths?.rows || [], "销售汇总-上月_vs_前两月") },
    { name: "销售汇总-近半年_vs_上期", rows: capWorkbookRows(raw.sales?.nearHalf_vs_previousHalf?.rows || [], "销售汇总-近半年_vs_上期") },
    { name: "活动汇总-5月_vs_4月", rows: capWorkbookRows([...(raw.activitySummary?.lastMonth?.rows || []), ...(raw.activitySummary?.previousMonth?.rows || [])], "活动汇总-5月_vs_4月") },
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
  const excelUrl = reportArtifactEncodedUrl(shareUrl, excelFileName);
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
  await writeReviewWorkbook(path.join(reportDir, excelFileName), summary, report);
  if (excelFileName !== "review.xlsx") {
    fs.copyFileSync(path.join(reportDir, excelFileName), path.join(reportDir, "review.xlsx"));
  }

  return { reportId, shareUrl, svgUrl, qrSvgUrl, excelUrl, normalizedDataUrl, diagnosticsUrl };
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
      const report = normalizeReport(saved.report);
      const markdown = reportToMarkdown(report);
      const qrSvg = await QRCode.toString(saved.shareUrl, {
        type: "svg",
        errorCorrectionLevel: "M",
        margin: 1,
        color: { dark: "#1f3f95", light: "#ffffff" },
      });
      const svgUrl = saved.svgUrl || `${saved.shareUrl.replace(/\/+$/, "")}/report.svg`;
      const qrSvgUrl = saved.qrSvgUrl || `${saved.shareUrl.replace(/\/+$/, "")}/qr.svg`;
      const excelFileName = reviewWorkbookFileName(saved.summary || {});
      const excelUrl = reportArtifactEncodedUrl(saved.shareUrl, excelFileName);
      const reportSvg = renderReportSvg({ report, summary: saved.summary, shareUrl: saved.shareUrl, qrSvg });
      const html = renderReportHtml({
        report,
        markdown,
        summary: saved.summary,
        shareUrl: saved.shareUrl,
        svgUrl,
        qrSvgUrl,
      });
      fs.writeFileSync(path.join(reportDir, "report.json"), JSON.stringify({ ...saved, report, markdown, svgUrl, qrSvgUrl, excelUrl }, null, 2), "utf8");
      fs.writeFileSync(path.join(reportDir, "index.html"), html, "utf8");
      fs.writeFileSync(path.join(reportDir, "report.svg"), reportSvg, "utf8");
      fs.writeFileSync(path.join(reportDir, "qr.svg"), qrSvg, "utf8");
      fs.writeFileSync(path.join(reportDir, "四季蝉登录获取标准化数据.json"), JSON.stringify(saved.summary?.rawData || {}, null, 2), "utf8");
      fs.writeFileSync(path.join(reportDir, "四季蝉接口诊断.json"), JSON.stringify(saved.summary?.interfaceDiagnostics || [], null, 2), "utf8");
      await writeReviewWorkbook(path.join(reportDir, excelFileName), saved.summary || {}, report);
      if (excelFileName !== "review.xlsx") {
        fs.copyFileSync(path.join(reportDir, excelFileName), path.join(reportDir, "review.xlsx"));
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
    const prompt = buildPrompt(summary);
    const reportText = await callConfiguredAI(config, prompt);
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
  const tokenPattern = /(?:Authorization|authorization)\s*[:=]\s*["']?(?:Bearer\s+)?([A-Za-z0-9._\-]{20,})|(?:token|access_token|merchant_token|accessToken)\s*["']?\s*[:=]\s*["']([A-Za-z0-9._\-]{20,})["']/i;
  const pick = (value) => String(value || "").replace(/^authorization\s*:\s*/i, "").replace(/^Bearer\s+/i, "").trim();
  const looksLikeToken = (value) => {
    const token = pick(value);
    return token.length >= 20 && /^[A-Za-z0-9._\-]+$/.test(token);
  };
  const tokenFromText = (text) => {
    const match = String(text || "").match(tokenPattern);
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
          if (/json|text|javascript/i.test(contentType || "")) {
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
          scanText(this.responseText, "xhr-response-body");
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

function getWeComBrowserSessionPublic(session) {
  return {
    id: session.id,
    handoffId: session.handoff?.id || "",
    status: session.status,
    captured: session.status === "captured",
    qrImage: session.qrImage || "",
    currentUrl: session.currentUrl || "",
    lastError: session.lastError || "",
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    expiresAt: session.handoff?.expiresAt || session.expiresAt || "",
  };
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
    if (session.browser) await session.browser.close();
  } catch (error) {
    console.warn(`WeCom browser close skipped: ${error.message}`);
  }
  session.browser = null;
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
    return /businesses-gateway|app-jump|super-admin|merchant|mer-manager|report|activity|industryOrder|imActivityReward|orderShareMoment/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

async function createWeComBrowserSession(user, body = {}) {
  let chromium;
  try {
    ({ chromium } = require("playwright-core"));
  } catch (error) {
    throw new Error("服务器未安装 playwright-core，暂不能使用服务器扫码模式。");
  }
  const handoff = await createSijichanTokenHandoff(user, body);
  const baseUrl = publicReportBaseUrl.replace(/\/+$/, "");
  const merchantRedirect = `${sijichanApiOrigin}/app-jump/super-admin-login`;
  const merchantWecomSsoUrl = `https://login.work.weixin.qq.com/wwlogin/sso/login/?login_type=CorpApp&appid=ww408c023179829552&agentid=1000157&redirect_uri=${encodeURIComponent(merchantRedirect)}&state=${encodeURIComponent(handoff.handoffToken)}`;
  const session = {
    id: createId("wbs"),
    userId: user.id,
    handoff,
    status: "opening",
    qrImage: "",
    currentUrl: "",
    lastError: "",
    browser: null,
    page: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    expiresAt: handoff.expiresAt,
  };
  activeWeComBrowserSessions.set(session.id, session);
  const tokenPattern = /(?:Authorization|authorization)\s*[:=]\s*["']?(?:Bearer\s+)?([A-Za-z0-9._\-]{20,})|(?:token|access_token|merchant_token|accessToken)\s*["']?\s*[:=]\s*["']([A-Za-z0-9._\-]{20,})["']/i;
  const maybeCapture = async (raw, from, sourceUrl = "") => {
    if (session.status === "captured") return;
    const runtimeUrl = sourceUrl || session.currentUrl || "";
    if (!isMerchantRuntimeUrl(runtimeUrl)) return;
    const token = normalizeSijichanToken((String(raw || "").match(tokenPattern) || [])[1] || (String(raw || "").match(tokenPattern) || [])[2] || raw);
    if (!token || token.length < 20 || !/^[A-Za-z0-9._\-]+$/.test(token)) return;
    try {
      await markSijichanHandoffCapturedById(handoff.id, user.id, token, { from, href: session.currentUrl });
      session.status = "captured";
      session.lastError = "";
      session.updatedAt = new Date().toISOString();
      await closeWeComBrowserSession(session);
    } catch (error) {
      session.lastError = error.message || "服务器扫码 token 保存失败。";
      session.updatedAt = new Date().toISOString();
    }
  };
  const scanMerchantPageStorage = async () => {
    if (!session.page || session.page.isClosed() || !isMerchantRuntimeUrl(session.page.url())) return;
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
      await maybeCapture(item.value, `server-browser-${item.storeName}:${item.key}`, session.page.url());
    }
  };
  const scanMerchantCookies = async () => {
    if (!session.page || session.page.isClosed() || !isMerchantRuntimeUrl(session.page.url())) return;
    const cookies = await session.page.context().cookies(sijichanApiOrigin).catch(() => []);
    for (const cookie of cookies) {
      const key = cookie?.name || "";
      const value = cookie?.value || "";
      if (/token|authorization|access|session|sso|jwt/i.test(key) || /Bearer\s+|^[A-Za-z0-9._\-]{20,}$/i.test(value)) {
        await maybeCapture(value, `server-browser-cookie:${key}`, session.page.url());
      }
    }
  };
  const tryFillMerchantCode = async () => {
    if (!handoff.merCode || !session.page || session.page.isClosed() || !isMerchantRuntimeUrl(session.page.url()) || session.merCodeFilled) return;
    const filled = await session.page.evaluate((merCode) => {
      const candidates = Array.from(document.querySelectorAll("input, textarea"));
      const target = candidates.find((input) => {
        const text = [
          input.name,
          input.id,
          input.placeholder,
          input.getAttribute("aria-label"),
          input.closest("label")?.textContent,
          input.parentElement?.textContent,
        ].filter(Boolean).join(" ");
        return /客户编码|客户代码|商户编码|门店编码|merCode|merchantCode|customerCode/i.test(text);
      });
      if (!target) return false;
      target.focus();
      target.value = merCode;
      target.dispatchEvent(new Event("input", { bubbles: true }));
      target.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }, handoff.merCode).catch(() => false);
    if (filled) {
      session.merCodeFilled = true;
      session.updatedAt = new Date().toISOString();
    }
  };
  const triggerMerchantProbe = async () => {
    if (!session.page || session.page.isClosed() || !isMerchantRuntimeUrl(session.page.url())) return;
    const now = Date.now();
    if (session.lastProbeAt && now - session.lastProbeAt < 8000) return;
    session.lastProbeAt = now;
    const probeUrls = [
      `${sijichanMerchantBase}report/activityReward/queryTopStatisticData`,
      `${sijichanMerchantBase}report/account/emp/overview/queryRewardStat`,
      `${sijichanMerchantBase}report/order_share/orderShareMomentSummary`,
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
  try {
    const browser = await chromium.launch(playwrightLaunchOptions());
    session.browser = browser;
    browser.on("disconnected", () => {
      if (session.status !== "captured" && session.status !== "expired" && session.status !== "error") {
        session.status = "error";
        session.lastError = "服务器浏览器进程已退出，请重新创建扫码会话。";
        session.updatedAt = new Date().toISOString();
      }
    });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.exposeBinding("sop4chanCaptureToken", async (source, payload = {}) => {
      const from = payload.from || `server-browser-binding:${source.frame?.url?.() || ""}`;
      const href = payload.href || source.frame?.url?.() || session.currentUrl;
      await maybeCapture(payload.token || payload.authorization || payload.text || "", from, href);
    });
    await context.addInitScript(() => {
      if (window.__sop4chanServerHookInstalled) return;
      window.__sop4chanServerHookInstalled = true;
      const tokenPattern = /(?:Authorization|authorization)\s*[:=]\s*["']?(?:Bearer\s+)?([A-Za-z0-9._\-]{20,})|(?:token|access_token|merchant_token|accessToken)\s*["']?\s*[:=]\s*["']([A-Za-z0-9._\-]{20,})["']/i;
      const pushToken = (value, from) => {
        const text = typeof value === "string" ? value : JSON.stringify(value || "");
        const match = text.match(tokenPattern);
        const token = match ? (match[1] || match[2] || "") : text;
        if (!token || token.length < 20 || !window.sop4chanCaptureToken) return;
        window.sop4chanCaptureToken({ token, from, href: location.href }).catch(() => null);
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
            if (/json|text|javascript/i.test(contentType)) {
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
            pushToken(this.responseText || "", "xhr-response-body");
          } catch {}
        });
        return originalSend.apply(this, arguments);
      };
    });
    const page = await context.newPage();
    session.page = page;
    page.on("close", () => {
      if (session.status !== "captured" && session.status !== "expired" && session.status !== "error") {
        session.status = "error";
        session.lastError = "服务器浏览器页面已关闭，请重新创建扫码会话。";
        session.updatedAt = new Date().toISOString();
      }
    });
    page.on("request", (request) => {
      session.currentUrl = request.url();
      const headers = request.headers();
      maybeCapture(headers.authorization || headers.Authorization, "server-browser-request-header", request.url());
      maybeCapture(request.url(), "server-browser-request-url", request.url());
      const postData = request.postData();
      if (postData) maybeCapture(postData, "server-browser-request-body", request.url());
    });
    page.on("response", async (response) => {
      session.currentUrl = response.url();
      const headers = response.headers();
      maybeCapture(headers.authorization || headers.Authorization, "server-browser-response-header", response.url());
      const contentType = headers["content-type"] || "";
      if (/json|text|javascript/i.test(contentType)) {
        response.text().then((text) => maybeCapture(text, "server-browser-response-body", response.url())).catch(() => null);
      }
    });
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) {
        session.currentUrl = frame.url();
        session.updatedAt = new Date().toISOString();
        scanMerchantPageStorage().catch(() => null);
        scanMerchantCookies().catch(() => null);
        tryFillMerchantCode().catch(() => null);
        triggerMerchantProbe().catch(() => null);
      }
    });
    await page.goto(merchantWecomSsoUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    session.currentUrl = page.url();
    if (page.isClosed()) throw new Error("服务器浏览器页面已关闭，无法生成企微二维码。");
    const qrImageUrl = await page.evaluate(() => {
      const image = document.querySelector(".wwLogin_qrcode_img") || [...document.images].find((img) => /qrcode/i.test(img.src || ""));
      return image ? image.src : "";
    }).catch(() => "");
    session.qrImage = qrImageUrl
      ? await dataUrlFromRemoteImage(qrImageUrl)
      : `data:image/png;base64,${(await page.screenshot({ fullPage: false })).toString("base64")}`;
    page.waitForTimeout(1000)
      .then(async () => {
        if (!page.isClosed() && session.status === "waiting_scan") {
          const nextQrImageUrl = await page.evaluate(() => {
            const image = document.querySelector(".wwLogin_qrcode_img") || [...document.images].find((img) => /qrcode/i.test(img.src || ""));
            return image ? image.src : "";
          }).catch(() => "");
          if (nextQrImageUrl) session.qrImage = await dataUrlFromRemoteImage(nextQrImageUrl);
          session.currentUrl = page.url();
          session.updatedAt = new Date().toISOString();
        }
      })
      .catch(() => null);
    session.status = "waiting_scan";
    session.updatedAt = new Date().toISOString();
    session.pollTimer = setInterval(async () => {
      try {
        if (session.page && session.status !== "captured") {
          session.currentUrl = session.page.url();
          session.updatedAt = new Date().toISOString();
          await scanMerchantPageStorage();
          await scanMerchantCookies();
          await tryFillMerchantCode();
          await triggerMerchantProbe();
        }
      } catch {
        // keep session alive until expiry
      }
    }, 3000);
    session.expireTimer = setTimeout(async () => {
      if (session.status !== "captured") {
        session.status = "expired";
        session.lastError = "服务器扫码会话已过期，请重新创建。";
        session.updatedAt = new Date().toISOString();
        await closeWeComBrowserSession(session, "expired");
      }
    }, 10 * 60 * 1000);
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

function createSijichanBrowserClient(page, merCode, diagnostics) {
  const browserPost = async (endpoint, body) => {
    if (!page || page.isClosed()) throw new Error("服务器浏览器会话已关闭，无法继续取数。");
    const url = `${sijichanManagerBase}${endpoint}`;
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
  if (!session?.page || session.page.isClosed()) throw new Error("服务器扫码浏览器会话已关闭，请重新扫码。");
  if (!isMerchantRuntimeUrl(session.page.url())) throw new Error("服务器浏览器尚未进入新零售管理平台，请扫码确认登录后再生成报告。");
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
  const windows = buildSijichanWindows(asOf || "2026-06-06");
  const withMerCode = (payload = {}) => (merCode ? { merCode, ...payload } : payload);

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
      source,
      merCode,
      merName,
      generatedAt: new Date().toISOString(),
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
    source: raw.meta.source || "登录获取",
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

function beginReviewJob(key) {
  if (activeReviewJobs.has(key)) {
    const error = new Error("已有复盘报告正在生成，请稍后刷新历史报告，或等待当前任务完成后再试。");
    error.statusCode = 429;
    throw error;
  }
  activeReviewJobs.add(key);
  return Date.now();
}

function finishReviewJob(key, startedAt, detail = "") {
  activeReviewJobs.delete(key);
  const elapsed = startedAt ? `${Math.round((Date.now() - startedAt) / 1000)}s` : "";
  console.log(`[review] finish ${key} ${elapsed} ${detail}`.trim());
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
  const startedAt = beginReviewJob(jobKey);
  let datasetId = "";
  console.log(`[review] start ${jobKey} ${filename}`);
  try {
    datasetId = await saveDatasetRecord(user.id, "excel", summary, filename);
    const { report, markdown, reportId, shareUrl, svgUrl, qrSvgUrl, excelUrl, normalizedDataUrl, diagnosticsUrl } = await generateReportFromSummary(summary, user);
    const dbReportId = await saveReviewReportRecord(user.id, "excel", filename, summary, { report, markdown, reportId, shareUrl, svgUrl, qrSvgUrl, excelUrl, normalizedDataUrl, diagnosticsUrl });
    await linkDatasetToReviewReport(datasetId, dbReportId, "completed");
    finishReviewJob(jobKey, startedAt, reportId);
    sendJson(res, 200, {
      ok: true,
      id: dbReportId,
      summary: summaryForResponse(summary),
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
  } catch (error) {
    activeReviewJobs.delete(jobKey);
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
  const startedAt = beginReviewJob(jobKey);
  let datasetId = "";
  console.log(`[review] start ${jobKey} ${body.username || ""}`);
  try {
    const summary = await runSijichanExport(body);
    const files = summary.datasetFiles || [];
    if (!files.some((file) => file.rowCount > 0)) {
      sendJson(res, 422, { error: "接口成功返回，但该账号/客户在当前口径无可复盘明细数据。", summary: summaryForResponse(summary) });
      finishReviewJob(jobKey, startedAt, "empty");
      return;
    }
    datasetId = await saveDatasetRecord(user.id, "login", summary, summary.source || "登录获取");
    const { report, markdown, reportId, shareUrl, svgUrl, qrSvgUrl, excelUrl, normalizedDataUrl, diagnosticsUrl } = await generateReportFromSummary(summary, user);
    const dbReportId = await saveReviewReportRecord(user.id, "login", "登录获取", summary, { report, markdown, reportId, shareUrl, svgUrl, qrSvgUrl, excelUrl, normalizedDataUrl, diagnosticsUrl });
    await upsertSijichanAuthorization(user.id, body, summary, dbReportId).catch((error) => {
      console.warn(`Sijichan authorization save skipped: ${error.message}`);
    });
    await linkDatasetToReviewReport(datasetId, dbReportId, "completed");
    finishReviewJob(jobKey, startedAt, reportId);
    sendJson(res, 200, { ok: true, id: dbReportId, summary: summaryForResponse(summary), report, markdown, reportId, shareUrl, svgUrl, qrSvgUrl, excelUrl, normalizedDataUrl, diagnosticsUrl });
  } catch (error) {
    activeReviewJobs.delete(jobKey);
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

async function generateWeComTokenReportForUser(user, res, body) {
  const token = assertSijichanTokenFormat(body.token || body.authorization || "");
  const config = await loadAiConfigForUser(user);
  if (!config.apiKey || !config.model) {
    sendJson(res, 400, { error: "AI服务未配置，请在AI配置页面保存自己的API Key，或联系管理员hydee配置兜底API。" });
    return;
  }
  const jobKey = `wecom:${user.id}`;
  const startedAt = beginReviewJob(jobKey);
  let datasetId = "";
  console.log(`[review] start ${jobKey} ${String(body.merCode || "").trim()}`);
  try {
    const summary = await runSijichanTokenExport({ ...body, token });
    const files = summary.datasetFiles || [];
    if (!files.some((file) => file.rowCount > 0)) {
      sendJson(res, 422, { error: "授权token可访问接口，但当前账号/客户在当前口径无可复盘明细数据。", summary: summaryForResponse(summary) });
      finishReviewJob(jobKey, startedAt, "empty");
      return;
    }
    datasetId = await saveDatasetRecord(user.id, "wecom_token", summary, summary.source || "企微扫码授权");
    const { report, markdown, reportId, shareUrl, svgUrl, qrSvgUrl, excelUrl, normalizedDataUrl, diagnosticsUrl } = await generateReportFromSummary(summary, user);
    const dbReportId = await saveReviewReportRecord(user.id, "wecom_token", "企微扫码授权", summary, { report, markdown, reportId, shareUrl, svgUrl, qrSvgUrl, excelUrl, normalizedDataUrl, diagnosticsUrl });
    await upsertSijichanTokenAuthorization(user.id, { ...body, token }, summary, dbReportId).catch((error) => {
      console.warn(`Sijichan token authorization save skipped: ${error.message}`);
    });
    await linkDatasetToReviewReport(datasetId, dbReportId, "completed");
    finishReviewJob(jobKey, startedAt, reportId);
    sendJson(res, 200, { ok: true, id: dbReportId, summary: summaryForResponse(summary), report, markdown, reportId, shareUrl, svgUrl, qrSvgUrl, excelUrl, normalizedDataUrl, diagnosticsUrl });
  } catch (error) {
    activeReviewJobs.delete(jobKey);
    await linkDatasetToReviewReport(datasetId, null, "failed", error.message);
    console.error(`[review] failed ${jobKey}:`, error);
    throw error;
  }
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
  const merchantWecomSsoUrl = `https://login.work.weixin.qq.com/wwlogin/sso/login/?login_type=CorpApp&appid=ww408c023179829552&agentid=1000157&redirect_uri=${encodeURIComponent(merchantRedirect)}&state=${encodeURIComponent(handoff.handoffToken)}`;
  const helperScript = renderWeComHandoffHelperScript({ endpoint: `${baseUrl}/api/wecom-token-capture`, handoffToken: handoff.handoffToken, merCode: handoff.merCode });
  sendJson(res, 200, { ok: true, ...handoff, wecomSsoUrl, merchantWecomSsoUrl, helperScript });
}

async function handleCreateWeComBrowserSession(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  const body = await readJsonBody(req, 1024 * 64).catch(() => ({}));
  try {
    const session = await createWeComBrowserSession(user, body);
    sendJson(res, 200, { ok: true, session });
  } catch (error) {
    sendJson(res, 500, { error: error.message || "服务器扫码会话创建失败。" });
  }
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
    await closeWeComBrowserSession(session);
  }
  sendJson(res, 200, { ok: true, session: getWeComBrowserSessionPublic(session), handoff });
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

async function generateWeComBrowserSessionReportForUser(user, res, session, body = {}) {
  const config = await loadAiConfigForUser(user);
  if (!config.apiKey || !config.model) {
    sendJson(res, 400, { error: "AI服务未配置，请在AI配置页面保存自己的API Key，或联系管理员hydee配置兜底API。" });
    return;
  }
  const jobKey = `wecom-browser:${user.id}`;
  const startedAt = beginReviewJob(jobKey);
  let datasetId = "";
  console.log(`[review] start ${jobKey} ${String(body.merCode || session.handoff?.merCode || "").trim()}`);
  try {
    const raw = await collectSijichanDataWithBrowserSession(session, {
      merCode: body.merCode || session.handoff?.merCode,
      merName: body.merName || session.handoff?.merName,
      source: "企微扫码服务器登录",
      asOf: body.asOf,
    });
    const summary = summarizeSijichanRaw(raw);
    const files = summary.datasetFiles || [];
    if (!files.some((file) => file.rowCount > 0)) {
      sendJson(res, 422, { error: "服务器浏览器已登录新零售，但当前账号/客户在当前口径无可复盘明细数据。", summary: summaryForResponse(summary) });
      finishReviewJob(jobKey, startedAt, "empty");
      return;
    }
    datasetId = await saveDatasetRecord(user.id, "wecom_browser", summary, summary.source || "企微扫码服务器登录");
    const { report, markdown, reportId, shareUrl, svgUrl, qrSvgUrl, excelUrl, normalizedDataUrl, diagnosticsUrl } = await generateReportFromSummary(summary, user);
    const dbReportId = await saveReviewReportRecord(user.id, "wecom_browser", "企微扫码服务器登录", summary, { report, markdown, reportId, shareUrl, svgUrl, qrSvgUrl, excelUrl, normalizedDataUrl, diagnosticsUrl });
    await linkDatasetToReviewReport(datasetId, dbReportId, "completed");
    finishReviewJob(jobKey, startedAt, reportId);
    sendJson(res, 200, { ok: true, id: dbReportId, summary: summaryForResponse(summary), report, markdown, reportId, shareUrl, svgUrl, qrSvgUrl, excelUrl, normalizedDataUrl, diagnosticsUrl });
  } catch (error) {
    activeReviewJobs.delete(jobKey);
    await linkDatasetToReviewReport(datasetId, null, "failed", error.message);
    console.error(`[review] failed ${jobKey}:`, error);
    throw error;
  }
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
  if (handoff?.token) {
    await queryDb("update sijichan_token_handoffs set used_at=now(), status='used', updated_at=now() where id=$1", [handoff.id]).catch(() => null);
    await generateWeComTokenReportForUser(user, res, { token: handoff.token, merCode: body.merCode || handoff.merCode, merName: body.merName || handoff.merName });
    return;
  }
  if (session.status === "expired" || session.status === "error" || session.page?.isClosed?.()) {
    sendJson(res, 409, { error: session.lastError || "服务器扫码会话不可用，请重新生成二维码并扫码。" });
    return;
  }
  await generateWeComBrowserSessionReportForUser(user, res, session, body);
}

async function handleListMonthlyMarketing(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  const url = new URL(req.url, "http://localhost");
  const monthKey = url.searchParams.get("month") || monthKeyFromDate();
  const recommendations = await listMonthlyMarketingRecommendations(user, monthKey);
  sendJson(res, 200, { ok: true, monthKey, aggregate: aggregateMonthlyMarketingRecommendations(recommendations, monthKey) });
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
  const reports = await listReviewReports(user);
  sendJson(res, 200, { reports });
}

async function handleAdminListUsers(req, res) {
  const user = await requireAdmin(req, res);
  if (!user) return;
  sendJson(res, 200, { users: await listAdminUsers() });
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
      if (url.pathname === "/api/wecom-token-review-report" && req.method === "POST") return await handleWeComTokenReviewReport(req, res);
      if (url.pathname === "/api/wecom-handoff" && req.method === "POST") return await handleCreateWeComHandoff(req, res);
      if (url.pathname === "/api/wecom-browser-session" && req.method === "POST") return await handleCreateWeComBrowserSession(req, res);
      if (url.pathname === "/api/wecom-token-capture" && req.method === "OPTIONS") return sendNoContent(res, weComCaptureCorsHeaders(req));
      if (url.pathname === "/api/wecom-token-capture" && req.method === "POST") return await handleCaptureWeComToken(req, res);
      if (url.pathname === "/api/wecom-handoff-review-report" && req.method === "POST") return await handleWeComHandoffReviewReport(req, res);
      if (url.pathname === "/api/wecom-browser-session-review-report" && req.method === "POST") return await handleWeComBrowserSessionReviewReport(req, res);
      if (url.pathname === "/api/wecom-sso/callback" && req.method === "GET") return await handleWeComSsoCallback(req, res);
      if (url.pathname === "/api/monthly-marketing-recommendations" && req.method === "GET") return await handleListMonthlyMarketing(req, res);
      if (url.pathname === "/api/monthly-marketing-recommendations/generate" && req.method === "POST") return await handleGenerateMonthlyMarketing(req, res);
      if (url.pathname === "/api/review-reports" && req.method === "GET") return await handleListReports(req, res);
      if (url.pathname === "/api/admin/users" && req.method === "GET") return await handleAdminListUsers(req, res);
      if (url.pathname === "/api/capability-test-submissions" && req.method === "POST") return await handleSubmitCapabilityTest(req, res);
      if (url.pathname === "/api/capability-test-submissions" && req.method === "GET") return await handleListCapabilityTests(req, res);
      const adminUserMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
      if (adminUserMatch && req.method === "PATCH") return await handleAdminUpdateUser(req, res, decodeURIComponent(adminUserMatch[1]));
      const handoffMatch = url.pathname.match(/^\/api\/wecom-handoff\/([^/]+)$/);
      if (handoffMatch && req.method === "GET") return await handleGetWeComHandoff(req, res, decodeURIComponent(handoffMatch[1]));
      const browserSessionMatch = url.pathname.match(/^\/api\/wecom-browser-session\/([^/]+)$/);
      if (browserSessionMatch && req.method === "GET") return await handleGetWeComBrowserSession(req, res, decodeURIComponent(browserSessionMatch[1]));
      const reportMatch = url.pathname.match(/^\/api\/review-reports\/([^/]+)$/);
      if (reportMatch && req.method === "GET") return await handleGetReport(req, res, decodeURIComponent(reportMatch[1]));
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
      await closeActiveWeComBrowserSessions();
    } finally {
      process.exit(signal === "SIGTERM" ? 0 : 1);
    }
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

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

