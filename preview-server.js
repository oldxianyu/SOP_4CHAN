const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const { spawn } = require("child_process");
const Busboy = require("busboy");
const JSZip = require("jszip");
const QRCode = require("qrcode");

const root = __dirname;
const host = process.env.HOST || "0.0.0.0";
const configuredPort = Number(process.env.PORT || 8765);
const ports = [configuredPort, 8766, 8767, 8768].filter((value, index, list) => value && list.indexOf(value) === index);
const uploadLimitBytes = Number(process.env.UPLOAD_LIMIT_BYTES || 10 * 1024 * 1024);
const serverDir = path.join(root, ".server");
const configPath = path.join(serverDir, "ai-config.json");
const sijichanRepoDir = path.join(serverDir, "sijichan-shuju");
const sijichanRepoUrl = "https://github.com/oldxianyu/sijichan-shuju.git";
const reportsDir = path.join(serverDir, "reports");
const publicReportBaseUrl = (process.env.PUBLIC_REPORT_BASE_URL || `http://localhost:${configuredPort}`).replace(/\/+$/, "");

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

function publicConfigStatus(config = loadConfig()) {
  return {
    configured: Boolean(config.apiKey && config.model),
    adminReady: Boolean(config.adminHash),
    hasApiKey: Boolean(config.apiKey),
    baseUrl: config.baseUrl || "https://api.openai.com/v1",
    model: config.model || "gpt-5.2",
    protocol: config.protocol || (String(config.baseUrl || "").includes("deepseek") ? "chat_completions" : "responses"),
  };
}

function normalizeBaseUrl(value) {
  return String(value || "https://api.openai.com/v1").trim().replace(/\/+$/, "");
}

function assertAdmin(config, adminPassword) {
  if (!config.adminHash) return true;
  return verifyPassword(adminPassword, config.adminHash);
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
  const config = loadConfig();
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
  sendJson(res, 200, publicConfigStatus());
}

async function handleSaveConfig(req, res) {
  const body = await readJsonBody(req);
  const current = loadConfig();
  if (!assertAdmin(current, body.adminPassword)) {
    sendJson(res, 401, { error: "管理密码不正确。" });
    return;
  }

  const firstSetup = !current.adminHash;
  const nextAdminPassword = body.newAdminPassword || (firstSetup ? body.adminPassword : "");
  if (firstSetup && (!nextAdminPassword || String(nextAdminPassword).length < 6)) {
    sendJson(res, 400, { error: "首次配置时，管理密码至少需要6位。" });
    return;
  }

  const next = {
    adminHash: nextAdminPassword ? hashPassword(nextAdminPassword) : current.adminHash,
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

  saveConfig(next);
  sendJson(res, 200, { ok: true, status: publicConfigStatus(next) });
}

async function handleTestConfig(req, res) {
  const body = await readJsonBody(req);
  const saved = loadConfig();
  if (saved.adminHash && !assertAdmin(saved, body.adminPassword)) {
    sendJson(res, 401, { error: "管理密码不正确。" });
    return;
  }

  const config = {
    apiKey: body.apiKey ? String(body.apiKey).trim() : saved.apiKey,
    baseUrl: normalizeBaseUrl(body.baseUrl || saved.baseUrl),
    model: String(body.model || saved.model || "gpt-5.2").trim(),
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

  const { report, markdown, reportId, shareUrl, svgUrl, qrSvgUrl } = await generateReportFromSummary(summary);
  sendJson(res, 200, {
    ok: true,
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
  const body = await readJsonBody(req, 1024 * 1024);
  const config = loadConfig();
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
    const { report, markdown, reportId, shareUrl, svgUrl, qrSvgUrl } = await generateReportFromSummary(summary);
    sendJson(res, 200, { ok: true, summary, report, markdown, reportId, shareUrl, svgUrl, qrSvgUrl });
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
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
      if (url.pathname === "/api/ai-config/status" && req.method === "GET") return handleConfigStatus(req, res);
      if (url.pathname === "/api/ai-config" && req.method === "POST") return await handleSaveConfig(req, res);
      if (url.pathname === "/api/ai-config/test" && req.method === "POST") return await handleTestConfig(req, res);
      if (url.pathname === "/api/review-report" && req.method === "POST") return await handleReviewReport(req, res);
      if (url.pathname === "/api/sijichan-review-report" && req.method === "POST") return await handleSijichanReviewReport(req, res);
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
