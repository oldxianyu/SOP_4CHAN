# SOP_4CHAN

海典四季蝉业务对接与AI复盘门户，使用 React + Ant Design 单页应用，并由 Node.js 服务提供用户登录注册、静态资源、Excel解析、AI复盘和 Supabase/Postgres 数据持久化能力。

## 功能

- 首页：四季蝉能力介绍。
- 对接行事历：客户对接事项和材料下载。
- 激励玩法：四季蝉激励类型说明。
- 选品思路：重点品分层和选品来源。
- 6月营销推荐：品种营销建议页。
- 用户体系：开放注册、登录、退出，第一位注册用户自动成为管理员。
- AI复盘报告：登录后上传四季蝉复盘数据标准模板 `.xlsx`，或通过登录获取数据，生成AI复盘报告并支持复制、分享、SVG导出和二维码查看。
- 历史报告：保存解析摘要、AI报告和分享产物链接，用户可查看自己的历史报告，管理员可查看全部。
- AI配置：仅管理员配置 AI API Key、Base URL、模型和调用协议。

## 本地运行

```bash
npm install
npm start
```

打开：

```text
http://localhost:8765/
```

## Supabase MCP

Codex 中可按以下方式接入 Supabase MCP：

```bash
codex mcp add supabase --url https://mcp.supabase.com/mcp?project_ref=gqinewwwnfdxwqtnapjl
codex mcp login supabase
```

然后在 Codex 中运行 `/mcp` 验证连接。

可选安装 Supabase Agent Skills：

```bash
npx skills add supabase/agent-skills
```

> 当前 Windows 环境里 `codex.exe` 可能被系统策略拦截，需要在可执行 Codex CLI 的终端完成 MCP 登录。

## 数据库配置

服务支持 Supabase/Postgres。数据库连接配置只放在服务器 `.server/.env` 或 PM2 环境变量，不提交 GitHub。

```bash
# 推荐：使用 Supabase Dashboard 提供的 Session pooler / Transaction pooler 连接串，
# 尤其是服务器没有 IPv6 出口时。
DATABASE_URL=postgresql://sijichan.<project-ref>:********@aws-0-<region>.pooler.supabase.com:5432/postgres

# 或者使用直连参数；注意 db.<project-ref>.supabase.co 可能只返回 IPv6。
DB_HOST=db.gqinewwwnfdxwqtnapjl.supabase.co
DB_PORT=5432
DB_NAME=postgres
DB_USER=sijichan
DB_PASSWORD=********
DB_SSL=true
SESSION_SECRET=replace-with-random-secret
PUBLIC_REPORT_BASE_URL=http://134.185.125.3:8765
```

如果本地没有配置数据库，服务会退回 `.server/portal-data.json` 本地兜底存储，便于开发调试。

服务启动时会自动创建这些表：

- `users`
- `customer_profiles`
- `ai_configs`
- `customer_datasets`
- `review_reports`

## 用户与AI配置

第一位注册用户自动成为管理员，后续注册用户默认为客户。

管理员登录后进入“AI配置”页：

1. 输入 AI API Key。
2. DeepSeek 推荐 Base URL `https://api.deepseek.com`。
3. DeepSeek 推荐模型 `deepseek-v4-flash`，调用协议选择 `Chat Completions`。
4. 点击“测试连接”，确认可用后保存。

AI API Key 会加密后保存到数据库；本地兜底模式下保存到 `.server/ai-config.json`。`.server/` 已加入 `.gitignore`，不会提交到 GitHub。

## 复盘数据来源

AI复盘报告需要登录后使用，支持两种来源：

1. Excel模板上传：上传“四季蝉复盘数据标准模板”的 `.xlsx` 文件。
2. 登录获取：使用登录信息临时拉取标准 `dataset/` 数据包后生成报告。

登录获取时，四季蝉账号、密码或Token只会传给服务器用于本次导出，不会写入GitHub。临时导出的数据包在报告生成后会删除。

每次成功生成报告后，数据库会保存：

- 数据来源和解析摘要。
- AI结构化报告和 Markdown。
- 分享网页、SVG长图和二维码链接。

不会保存客户上传的原始 Excel 文件。

## 分享报告

AI复盘成功后，系统会在 `.server/reports/{reportId}/` 生成：

- `index.html`：独立数据分析网页。
- `report.json`：结构化报告数据。
- `report.svg`：整份报告SVG长图。
- `qr.svg`：扫码查看二维码。

服务器部署时可设置：

```bash
PUBLIC_REPORT_BASE_URL=http://134.185.125.3:8765
```

二维码会指向：

```text
http://134.185.125.3:8765/reports/{reportId}/
```

## 服务器运行

默认监听：

```text
0.0.0.0:8765
```

可用环境变量调整：

```bash
PORT=8765 HOST=0.0.0.0 npm start
```

长期运行建议使用 `pm2`：

```bash
npm install -g pm2
pm2 start preview-server.js --name sop-4chan
pm2 save
```

正式给客户上传经营数据时，建议配置域名和 HTTPS。

## 四季蝉登录获取内置导出器

`AI复盘报告` 页面中的“登录获取”已改为项目内置导出器，不再依赖外部 `sijichan-shuju` 仓库。后端直接登录 `merchants.hydee.cn`，使用 `account + MD5(password).toUpperCase() + clientId + loginSourceType=1` 获取 token，并按自然月口径读取销售、奖励、活动、培训、厂家打赏和概览校验数据。

默认口径以 `2026-06-06` 为基准：上月为 2026-05，上上月为 2026-04，前两月对比期为 2026-03 至 2026-04，近半年为 2025-12 至 2026-05，上期半年为 2025-06 至 2025-11。客户编码为空时按登录账号默认权限取数；填写客户编码时才向四季蝉业务接口传递 `merCode`。

每次成功生成报告后，`.server/reports/{reportId}/` 会包含 `index.html`、`report.json`、`report.svg`、`qr.svg` 和 `review.xlsx`，其中 `review.xlsx` 是经营复盘数据汇总工作簿。
