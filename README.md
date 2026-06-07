# SOP_4CHAN 海典四季蝉门户

海典四季蝉门户是面向医药连锁客户的重点品数字化动销与复盘平台。网站把四季蝉的产品介绍、客户对接 SOP、激励玩法、选品思路、6 月营销推荐、AI 复盘报告、历史分享材料和 AI 配置集中到一个可访问、可分享、可部署的前后端项目中。

当前线上入口建议使用：

```text
https://sijichan.top
```

## 网站内容

- **首页**：介绍四季蝉作为“医药连锁重点品种数字化动销平台”的定位，说明厂家资源、重点品培训、店员激励、销售数据和复盘看板如何形成闭环。
- **对接行事历**：沉淀客户上线前后的 SOP 工作目录，包括汇付账户开通、基础信息维护、工业信息收集、活动商品创建、培训、订单测试和店员上线，并提供材料下载。
- **激励玩法**：展示四季蝉活动激励类型、玩法规则、适用场景和运营作用，帮助连锁理解如何设计店员动销激励。
- **选品思路**：说明重点品、黄金单品、普通带金、AAA 主力赚钱品等品种分层逻辑，用于支撑活动选品。
- **6 月营销推荐**：结合月度营销节点、热卖品和赚钱品，提供品类与重点品种推荐。
- **AI 复盘报告**：登录后支持上传 Excel 模板或通过“四季蝉登录获取”读取客户数据，由 AI 生成复盘报告、独立分享网页、SVG 长图、二维码和 Excel 汇总。
- **续用风险洞察**：AI 复盘会额外计算客户续用健康度、活动覆盖、激励闭环、员工参与、培训承接、厂家协同等指标，用于证明四季蝉价值、识别流失风险，并指导客户多使用重点品运营能力。
- **历史报告**：保存用户生成过的复盘报告，支持打开分享页、二维码弹框、下载 SVG、下载 Excel、接口诊断、标准化数据和复制链接。
- **相关工具与资料**：首页底部提供 4 个友链资料页，包括华南连锁 6 月营销方案、医药连锁四季营销日历、四季蝉产品学习手册和五大金刚综合能力评估测试。
- **测评数据**：五大金刚测评页支持提交答题结果，管理员可在门户内查看提交人、部门、完成度和每题答案。
- **AI 配置**：管理员维护 AI API Key、Base URL、模型名称和调用协议，支持 DeepSeek / OpenAI-compatible Chat Completions。

## 技术架构

- **前端**：单文件 React 应用，使用 Ant Design 组件和 Ant Design/X 风格视觉语言，入口为 `index.html`。
- **样式**：桌面端保留表格和仪表盘信息密度；手机端使用 `<=640px` 和 `<=380px` 断点，将长表格转换为卡片列表，优化按钮、页签、头部和登录页布局。
- **后端**：Node.js HTTP 服务，入口为 `preview-server.js`，默认监听 `0.0.0.0:8765`。
- **数据解析**：后端解析四季蝉复盘标准 Excel，也可通过内置导出器登录 `merchants.hydee.cn` 临时取数。
- **AI 调用**：支持 OpenAI Responses 协议和 OpenAI-compatible Chat Completions 协议；DeepSeek 推荐配置为 `https://api.deepseek.com` + `deepseek-v4-flash`。
- **报告产物**：每次 AI 复盘会生成 `.server/reports/{reportId}/index.html`、`report.svg`、`qr.svg`、`review.xlsx`、接口诊断 JSON 和标准化数据 JSON。
- **运营洞察**：标准化摘要中包含 `operationInsights`，Excel 汇总增加“续用风险与运营提升”页，方便销售、实施和运营在老客户复盘会上直接使用。
- **测评收集**：公开友链页 `links/five-core-capability-test.html` 调用 `POST /api/capability-test-submissions` 保存开放题答案，管理员通过 `GET /api/capability-test-submissions` 查看。
- **数据存储**：优先使用 Supabase/Postgres；未配置数据库时回退到 `.server/portal-data.json` 本地存储。

## 本地运行

```bash
npm install
npm start
```

打开：

```text
http://localhost:8765/
```

常用检查：

```bash
node --check preview-server.js
```

## 环境变量

生产环境配置放在服务器 `.server/.env` 或进程管理工具环境变量中，不提交 GitHub。

```bash
PORT=8765
HOST=0.0.0.0
SESSION_SECRET=replace-with-random-secret
PUBLIC_REPORT_BASE_URL=https://sijichan.top

# Supabase/Postgres，可使用 DATABASE_URL 或拆分参数
DATABASE_URL=postgresql://sijichan.<project-ref>:********@aws-0-<region>.pooler.supabase.com:5432/postgres
DB_HOST=db.gqinewwwnfdxwqtnapjl.supabase.co
DB_PORT=5432
DB_NAME=postgres
DB_USER=sijichan
DB_PASSWORD=********
DB_SSL=true
```

`PUBLIC_REPORT_BASE_URL` 会影响分享页、二维码、SVG、Excel、接口诊断和标准化数据链接。通过 Cloudflare Tunnel 暴露服务时应设置为：

```bash
PUBLIC_REPORT_BASE_URL=https://sijichan.top
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

服务启动时会自动准备这些表：

- `users`
- `customer_profiles`
- `ai_configs`
- `customer_datasets`
- `review_reports`
- `capability_test_submissions`

## 用户与权限

- 支持开放注册、登录、退出。
- 第一位注册用户自动成为管理员；后续注册用户默认是客户角色。
- 未登录用户可以浏览：首页、对接行事历、激励玩法、选品思路、6 月营销推荐。
- 登录用户可以使用 AI 复盘报告和历史报告。
- 只有管理员可以进入 AI 配置页并维护模型配置。
- 只有管理员可以进入测评数据页并查看五大金刚评估测试提交记录。

## 友链资料与测评

首页底部的“相关工具与资料”包含 4 个独立 HTML 资料页：

- `links/south-chain-june-marketing.html`
- `links/pharmacy-seasonal-marketing-calendar.html`
- `links/sijichan-product-handbook-v2.html`
- `links/five-core-capability-test.html`

四个友链页均增加了手机端适配，适合通过微信、手机浏览器和客户分享链接打开。五大金刚综合能力评估测试额外支持：

- 填写姓名、部门、日期。
- 提交 17 道开放题的答题内容。
- 后端保存提交记录、答题完成数量和完成率。
- 管理员登录主站后在“测评数据”页查看提交明细。

## AI 复盘数据来源

AI 复盘报告支持两种来源：

1. **Excel 模板上传**：上传四季蝉复盘数据标准模板 `.xlsx`，后端解析标准页签并生成报告。
2. **登录获取**：输入四季蝉账号、密码，客户名称和客户编码选填。后端临时登录 `merchants.hydee.cn`，按自然月口径读取销售、活动、奖励、培训、厂家打赏和概览校验数据。

四季蝉账号、密码和业务 token 只用于本次取数，不写入 GitHub、前端代码、分享报告或历史记录。

## 分享与下载

AI 复盘成功后会返回：

- 分享网页：`/reports/{reportId}/`
- SVG 长图：`/reports/{reportId}/report.svg`
- 二维码：`/reports/{reportId}/qr.svg`
- Excel 汇总：`/reports/{reportId}/review.xlsx`
- 接口诊断：`/reports/{reportId}/四季蝉接口诊断.json`
- 标准化数据：`/reports/{reportId}/四季蝉登录获取标准化数据.json`

历史报告页和生成报告后的操作区都会按当前访问域名拼接链接。例如通过 `https://sijichan.top` 访问时，复制链接和下载链接都会使用 `https://sijichan.top/reports/...`。

## 手机端适配

网站已针对手机浏览做专门适配：

- 顶部头部改为紧凑纵向排版。
- 主导航页签在手机端横向滑动并保持 sticky。
- 对接行事历在手机端由横向大表格改为项目卡片列表。
- 历史报告在手机端由表格改为报告卡片列表。
- AI 复盘按钮、下载入口和二维码入口在手机端使用两列或单列按钮。
- 二维码在当前页面弹框展示，不跳转到二维码网页。
- 长标签、品种名称、材料下载按钮和说明文字均允许自然换行。
- 首页底部 4 个友链资料页也做了手机端保护：头部压缩、网格改单列、表格横向滚动、长文本自动换行。

## 部署

默认监听：

```text
0.0.0.0:8765
```

可直接使用 Node.js：

```bash
PORT=8765 HOST=0.0.0.0 npm start
```

长期运行建议使用 systemd 或 pm2。例如 pm2：

```bash
npm install -g pm2
pm2 start preview-server.js --name sop-4chan
pm2 save
```

正式给客户上传经营数据和配置 AI Key 时，建议使用域名和 HTTPS。当前 Cloudflare Tunnel 映射域名为：

```text
https://sijichan.top
```

## 安全说明

- `.server/` 不提交 GitHub。
- AI API Key、数据库密码、四季蝉账号密码、业务 token 不写入前端代码。
- 客户上传的原始 Excel 不长期保存；系统只保存解析摘要、AI 报告、历史报告记录和分享产物。
- 历史报告保存的是报告结果和下载链接，不保存四季蝉登录凭证。
- 五大金刚测评会保存用户主动填写的姓名、部门、日期和答题内容；仅管理员可在后台查看。
