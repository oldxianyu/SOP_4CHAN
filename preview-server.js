const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Busboy = require("busboy");
const JSZip = require("jszip");

const root = __dirname;
const host = process.env.HOST || "0.0.0.0";
const configuredPort = Number(process.env.PORT || 8765);
const ports = [configuredPort, 8766, 8767, 8768].filter((value, index, list) => value && list.indexOf(value) === index);
const uploadLimitBytes = Number(process.env.UPLOAD_LIMIT_BYTES || 10 * 1024 * 1024);
const serverDir = path.join(root, ".server");
const configPath = path.join(serverDir, "ai-config.json");

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

  const output = await callOpenAI(config, "请只回复“连接成功”。", false);
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

  const config = loadConfig();
  if (!config.apiKey || !config.model) {
    sendJson(res, 400, { error: "AI服务未配置，请先进入AI配置页面。" });
    return;
  }

  const prompt = buildPrompt(summary);
  let reportText;
  try {
    reportText = await callOpenAI(config, prompt, true);
  } catch (error) {
    if (error.status === 400) {
      reportText = await callOpenAI(config, `${prompt}\n请按JSON对象返回，字段包含title、executiveSummary、highlights、risks、sections、nextActions。`, false);
    } else {
      throw error;
    }
  }

  const report = parseReportJson(reportText);
  sendJson(res, 200, {
    ok: true,
    summary,
    report,
    markdown: reportToMarkdown(report),
  });
}

function serveStatic(req, res) {
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
}

function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === "/api/ai-config/status" && req.method === "GET") return handleConfigStatus(req, res);
      if (url.pathname === "/api/ai-config" && req.method === "POST") return await handleSaveConfig(req, res);
      if (url.pathname === "/api/ai-config/test" && req.method === "POST") return await handleTestConfig(req, res);
      if (url.pathname === "/api/review-report" && req.method === "POST") return await handleReviewReport(req, res);
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
