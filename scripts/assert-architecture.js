const fs = require("fs");
const path = require("path");

function read(file) {
  return fs.readFileSync(file, "utf8");
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function includesAll(text, needles) {
  return needles.every((needle) => text.includes(needle));
}

const server = read("preview-server.js");
const html = read("index.html");
const requiredContentFiles = [
  "content/home.json",
  "content/calendar.json",
  "content/incentive.json",
  "content/selection.json",
  "content/monthly-marketing.json",
];

const checks = [
  {
    name: "review payload table exists",
    ok: includesAll(server, ["create table if not exists review_report_payloads", "summary_json jsonb not null", "report_json jsonb not null"]),
  },
  {
    name: "history list uses lightweight view",
    ok: includesAll(server, ["create or replace view review_report_list_view", "from review_report_list_view", "normalizeReviewReportRow(row, { includePayload: false })"]),
  },
  {
    name: "history detail joins payload only on demand",
    ok: includesAll(server, ["async function getReviewReport", "left join review_report_payloads p on p.report_db_id = r.id", "p.report_json as payload_report_json"]),
  },
  {
    name: "report writes split metadata and payload",
    ok: includesAll(server, ["insert into review_reports", "insert into review_report_payloads", "jsonParam(digest, {})", "jsonParam(summary, {})"]),
  },
  {
    name: "static report json stays compact",
    ok: includesAll(server, ["function reportArtifactJsonPayload", "summary: summaryForResponse(summary)", "normalizedDataUrl", "diagnosticsUrl"]),
  },
  {
    name: "excel workbook generation runs in worker",
    ok: includesAll(server, ["new Worker(__filename", "type: \"review-workbook\"", "queueReviewWorkbookGeneration"]),
  },
  {
    name: "workbook input is clipped before worker",
    ok: includesAll(server, ["function prepareReviewWorkbookInput", "WORKBOOK_DETAIL_ROW_LIMIT", "workbook-input.json", "capWorkbookInputRows"]),
  },
  {
    name: "static files use streaming",
    ok: includesAll(server, ["function streamStaticFile", "fs.createReadStream", "stream.pipe(res)"]),
  },
  {
    name: "database owns aggregate/report list workloads",
    ok: includesAll(server, ["get_monthly_marketing_aggregate", "running_review_report_view", "admin_user_overview_view", "capability_submission_list_view"]),
  },
  {
    name: "database owns stale job cleanup",
    ok: includesAll(server, ["expire_stale_review_jobs", "expire_stale_review_workbooks", "cleanup_review_job_events", "cleanup_auth_operation_logs"]),
  },
  {
    name: "frontend destroys inactive tab trees",
    ok: includesAll(html, ["destroyInactiveTabPane: true", "destroyOnHidden: true"]),
  },
  {
    name: "frontend aborts in-flight review/history requests",
    ok: includesAll(html, ["new AbortController()", "reportRequestRef.current.abort()", "statusRequestRef.current.abort()", "abortWeComRequests"]),
  },
  {
    name: "history page paginates and polls statuses only",
    ok: includesAll(html, ["pageSize: 8", "/api/review-reports/status?ids=", "refreshVisibleReportStatuses"]),
  },
  {
    name: "content json cache dedupes requests",
    ok: includesAll(html, ["contentResourceCache", "contentResourceInflight", "useContentResource"]),
  },
  {
    name: "required content json assets exist",
    ok: requiredContentFiles.every((file) => fs.existsSync(path.join(process.cwd(), file))),
  },
];

for (const check of checks) {
  console.log(`${check.ok ? "ok" : "not ok"} ${check.name}`);
  assert(check.ok, check.name);
}

for (const file of requiredContentFiles) {
  const parsed = JSON.parse(read(file));
  const ok = parsed && typeof parsed === "object" && !Array.isArray(parsed);
  console.log(`${ok ? "ok" : "not ok"} ${file} parses as object`);
  assert(ok, `${file} must be a JSON object`);
}

const reportsDir = path.join(process.cwd(), ".server", "reports");
if (fs.existsSync(reportsDir)) {
  const heavyReportJson = [];
  for (const entry of fs.readdirSync(reportsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(reportsDir, entry.name, "report.json");
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    if (text.includes('"rawData"') || text.includes('"interfaceDiagnostics"')) {
      heavyReportJson.push(entry.name);
    }
  }
  console.log(`${heavyReportJson.length ? "not ok" : "ok"} report artifact json stays lightweight`);
  assert(!heavyReportJson.length, `report.json contains heavy payload fields: ${heavyReportJson.slice(0, 10).join(", ")}`);
}

console.log("ARCHITECTURE_ASSERTIONS_OK");
