const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const { Pool } = require("pg");

const root = path.resolve(__dirname, "..");
const serverDir = path.join(root, ".server");
dotenv.config({ path: path.join(serverDir, ".env") });

const sourcePath = process.argv[2] || path.join(serverDir, "portal-data.json");
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

function nullIfBlank(value) {
  const text = String(value || "").trim();
  return text ? text : null;
}

function json(value, fallback) {
  return JSON.stringify(value ?? fallback);
}

function requireDatabaseConfig() {
  if (!dbConfig.connectionString && !dbConfig.password) {
    throw new Error("数据库未配置。请先在 .server/.env 设置 DATABASE_URL，或 DB_HOST/DB_NAME/DB_USER/DB_PASSWORD。");
  }
}

async function ensureSchema(pool) {
  await pool.query("create extension if not exists pgcrypto");
  await pool.query(`
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
      excel_url text,
      normalized_data_url text,
      diagnostics_url text,
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
    alter table review_reports add column if not exists excel_url text;
    alter table review_reports add column if not exists normalized_data_url text;
    alter table review_reports add column if not exists diagnostics_url text;
    create index if not exists idx_review_reports_user_created on review_reports(user_id, created_at desc);
    create index if not exists idx_review_reports_created on review_reports(created_at desc);
    create index if not exists idx_customer_datasets_user_created on customer_datasets(user_id, created_at desc);
    create index if not exists idx_capability_test_submissions_created on capability_test_submissions(created_at desc);
  `);
}

async function migrate() {
  requireDatabaseConfig();
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`找不到本地数据文件：${sourcePath}`);
  }

  const pool = new Pool(
    dbConfig.connectionString
      ? { connectionString: dbConfig.connectionString, ssl: dbConfig.ssl, max: 4 }
      : { host: dbConfig.host, port: dbConfig.port, database: dbConfig.database, user: dbConfig.user, password: dbConfig.password, ssl: dbConfig.ssl, max: 4 },
  );

  await ensureSchema(pool);
  const data = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
  const counts = { users: 0, customerProfiles: 0, aiConfigs: 0, customerDatasets: 0, reviewReports: 0, capabilityTestSubmissions: 0 };

  for (const row of data.users || []) {
    await pool.query(
      `insert into users(id, name, phone, email, password_hash, role, status, created_at, updated_at)
       values($1,$2,$3,$4,$5,$6,$7,$8,$9)
       on conflict(id) do update set name=excluded.name, phone=excluded.phone, email=excluded.email, password_hash=excluded.password_hash, role=excluded.role, status=excluded.status, updated_at=excluded.updated_at`,
      [
        row.id,
        row.name || "未命名用户",
        nullIfBlank(row.phone),
        nullIfBlank(row.email),
        row.password_hash || row.passwordHash || "",
        row.role || "customer",
        row.status || "active",
        row.created_at || row.createdAt || new Date().toISOString(),
        row.updated_at || row.updatedAt || new Date().toISOString(),
      ],
    );
    counts.users += 1;
  }

  for (const row of data.customerProfiles || []) {
    await pool.query(
      `insert into customer_profiles(id, user_id, company_name, contact_name, contact_phone, notes, created_at, updated_at)
       values($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict(id) do update set company_name=excluded.company_name, contact_name=excluded.contact_name, contact_phone=excluded.contact_phone, notes=excluded.notes, updated_at=excluded.updated_at`,
      [
        row.id,
        row.user_id || row.userId,
        row.company_name || row.companyName || "",
        row.contact_name || row.contactName || "",
        row.contact_phone || row.contactPhone || "",
        row.notes || "",
        row.created_at || row.createdAt || new Date().toISOString(),
        row.updated_at || row.updatedAt || new Date().toISOString(),
      ],
    );
    counts.customerProfiles += 1;
  }

  for (const row of data.aiConfigs || []) {
    await pool.query(
      `insert into ai_configs(id, base_url, model, protocol, api_key_encrypted, updated_by, created_at, updated_at)
       values($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict(id) do update set base_url=excluded.base_url, model=excluded.model, protocol=excluded.protocol, api_key_encrypted=excluded.api_key_encrypted, updated_by=excluded.updated_by, updated_at=excluded.updated_at`,
      [
        row.id,
        row.base_url || row.baseUrl || "https://api.deepseek.com",
        row.model || "deepseek-v4-flash",
        row.protocol || "chat_completions",
        row.api_key_encrypted || row.apiKeyEncrypted || "",
        nullIfBlank(row.updated_by || row.updatedBy),
        row.created_at || row.createdAt || new Date().toISOString(),
        row.updated_at || row.updatedAt || new Date().toISOString(),
      ],
    );
    counts.aiConfigs += 1;
  }

  for (const row of data.customerDatasets || []) {
    await pool.query(
      `insert into customer_datasets(id, user_id, source_type, filename, row_counts_json, sheet_status_json, metadata_json, created_at, updated_at)
       values($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8,$9)
       on conflict(id) do update set source_type=excluded.source_type, filename=excluded.filename, row_counts_json=excluded.row_counts_json, sheet_status_json=excluded.sheet_status_json, metadata_json=excluded.metadata_json, updated_at=excluded.updated_at`,
      [
        row.id,
        nullIfBlank(row.user_id || row.userId),
        row.source_type || row.sourceType || "unknown",
        row.filename || "",
        json(row.row_counts_json || row.rowCountsJson, {}),
        json(row.sheet_status_json || row.sheetStatusJson, []),
        json(row.metadata_json || row.metadataJson, {}),
        row.created_at || row.createdAt || new Date().toISOString(),
        row.updated_at || row.updatedAt || new Date().toISOString(),
      ],
    );
    counts.customerDatasets += 1;
  }

  for (const row of data.reviewReports || []) {
    const shareUrl = row.share_url || row.shareUrl || "";
    const reportId = row.report_id || row.reportId || row.id;
    const baseUrl = shareUrl ? shareUrl.replace(/\/?$/, "/") : "";
    await pool.query(
      `insert into review_reports(id, user_id, customer_profile_id, source_type, source_name, summary_json, report_json, markdown, report_id, share_url, svg_url, qr_svg_url, excel_url, normalized_data_url, diagnostics_url, created_at, updated_at)
       values($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       on conflict(id) do update set source_type=excluded.source_type, source_name=excluded.source_name, summary_json=excluded.summary_json, report_json=excluded.report_json, markdown=excluded.markdown, report_id=excluded.report_id, share_url=excluded.share_url, svg_url=excluded.svg_url, qr_svg_url=excluded.qr_svg_url, excel_url=excluded.excel_url, normalized_data_url=excluded.normalized_data_url, diagnostics_url=excluded.diagnostics_url, updated_at=excluded.updated_at`,
      [
        row.id,
        nullIfBlank(row.user_id || row.userId),
        nullIfBlank(row.customer_profile_id || row.customerProfileId),
        row.source_type || row.sourceType || "login",
        row.source_name || row.sourceName || "",
        json(row.summary_json || row.summaryJson, {}),
        json(row.report_json || row.reportJson, {}),
        row.markdown || "",
        reportId,
        shareUrl,
        row.svg_url || row.svgUrl || (baseUrl ? `${baseUrl}report.svg` : ""),
        row.qr_svg_url || row.qrSvgUrl || (baseUrl ? `${baseUrl}qr.svg` : ""),
        row.excel_url || row.excelUrl || (baseUrl ? `${baseUrl}review.xlsx` : ""),
        row.normalized_data_url || row.normalizedDataUrl || (baseUrl ? `${baseUrl}${encodeURIComponent("四季蝉登录获取标准化数据.json")}` : ""),
        row.diagnostics_url || row.diagnosticsUrl || (baseUrl ? `${baseUrl}${encodeURIComponent("四季蝉接口诊断.json")}` : ""),
        row.created_at || row.createdAt || new Date().toISOString(),
        row.updated_at || row.updatedAt || new Date().toISOString(),
      ],
    );
    counts.reviewReports += 1;
  }

  for (const row of data.capabilityTestSubmissions || []) {
    await pool.query(
      `insert into capability_test_submissions(id, name, department, test_date, total_questions, answered_questions, completion_rate, answers_json, user_agent, created_at, updated_at)
       values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11)
       on conflict(id) do update set name=excluded.name, department=excluded.department, test_date=excluded.test_date, total_questions=excluded.total_questions, answered_questions=excluded.answered_questions, completion_rate=excluded.completion_rate, answers_json=excluded.answers_json, user_agent=excluded.user_agent, updated_at=excluded.updated_at`,
      [
        row.id,
        row.name || "未命名",
        row.department || "",
        row.test_date || row.testDate || "",
        Number(row.total_questions || row.totalQuestions || 0),
        Number(row.answered_questions || row.answeredQuestions || 0),
        Number(row.completion_rate || row.completionRate || 0),
        json(row.answers_json || row.answersJson, []),
        row.user_agent || row.userAgent || "",
        row.created_at || row.createdAt || new Date().toISOString(),
        row.updated_at || row.updatedAt || new Date().toISOString(),
      ],
    );
    counts.capabilityTestSubmissions += 1;
  }

  await pool.end();
  console.log(JSON.stringify({ ok: true, sourcePath, counts }, null, 2));
}

migrate().catch((error) => {
  console.error(error);
  process.exit(1);
});
