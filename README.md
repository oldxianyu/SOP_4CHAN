# SOP_4CHAN 海典四季蝉 SOP 门户

海典四季蝉 SOP 门户，是面向医药连锁客户的重点品动销、客户对接和 AI 复盘平台。

它不是一个简单的资料下载页，也不是一个单纯的 AI 报告页。它把四季蝉的产品介绍、对接行事历、激励玩法、选品思路、月度营销推荐、客户数据复盘、历史报告、友链资料和管理员配置放在同一个可访问、可分享、可部署的门户里。

线上入口：

```text
https://sijichan.top
```

## 这个网站解决什么问题

四季蝉要解决的核心问题是：重点品卖不动、店员记不住、不愿卖、厂家活动难落地、总部统计慢、提成发放慢。

门户把这些事情串成一条清楚的运营链路：

1. 客户先理解四季蝉是什么。
2. 实施和连锁按 SOP 完成上线对接。
3. 运营根据重点品、AAA 主力赚钱品和活动玩法配置动销方案。
4. 店员通过活动、培训、奖励和提现形成收益感知。
5. 总部用销售、奖励、提现、活动和培训数据做复盘。
6. AI 把复盘结果生成可分享网页、长图、二维码和 Excel 汇总。

一句话：这是一个帮助连锁把重点品动销做成“可配置、可执行、可提现、可复盘、可续用”的数字化运营门户。

## 网站内容

- **首页**：介绍海典四季蝉的定位、价值和动销闭环。
- **对接行事历**：沉淀客户上线前后的 SOP 工作目录，包含汇付账户、基础信息、工业信息、活动商品、培训、订单测试和店员上线等事项。
- **激励玩法**：展示单品突破、关联销售、黄金单品、任务品、培训奖励等玩法如何服务重点品动销。
- **选品思路**：解释重点品、黄金单品、普通带金、AAA 主力赚钱品的分层逻辑。
- **当月营销推荐**：结合当月活动列表、活动商品明细、月度营销节点、热卖品和赚钱品，提供品类与重点品种推荐。
- **AI 复盘报告**：登录后可上传 Excel 模板，或通过“四季蝉登录获取”直接取客户后台数据，生成 AI 复盘报告。
- **历史报告**：保存用户生成过的复盘报告，支持分享页、二维码弹框、SVG、Excel、接口诊断、标准化数据和复制链接。
- **系统维护**：登录用户可维护自己的 AI API；管理员还可管理门户用户、查看测评提交数据。
- **相关工具与资料**：首页底部提供 5 个友链资料页，适合客户学习、培训、FAQ 查询和分享。

## 已更新功能

最近一轮更新重点加强了“老客户复盘”和“防流失经营”：

- 登录获取新增“我的活动列表”，可看到客户已参加/已配置活动池、活动状态、费用和活动销售额。
- 登录获取新增“奖励发放明细”，能证明奖励是否从活动执行流向店员。
- 奖励发放明细已增加大客户分页保护：超大数据会保留前 20 页明细，并在接口诊断中记录总行数、总页数、已取页数和是否截断，避免老客户报告生成卡死。
- 登录获取新增“员工豆豆账户/提现”，能看到店员收益感知和提现闭环。
- AI 生成增加超时保护：保留完整数据摘要给 AI；如果 AI 接口长时间无响应，系统会基于结构化数据生成兜底报告，保证分享页、SVG、二维码和 Excel 能继续产出。
- AI 复盘新增“活动持续运营”评分，判断客户是不是只做了一次活动，还是已经形成月度活动资产。
- 续用风险洞察增强：现在会综合活动覆盖、激励闭环、员工参与、培训承接、厂家协同和活动持续运营。
- Excel 汇总优化为客户汇报版：下载文件名使用“客户名称_日期_四季蝉复盘报告.xlsx”，前两个页签固定为“续用风险”“复盘结论”，表头中文化并对重点风险、价值证据和下一步动作做醒目标注。
- 历史报告和生成结果中的分享、下载、复制链接会自动按当前访问域名拼接，适配 `https://sijichan.top`。
- 二维码在当前页面弹框展示，不再跳转到单独二维码页面。
- 手机端适配已覆盖首页、页签、AI 复盘、历史报告、对接行事历、登录注册和 5 个友链资料页。
- 五大金刚测评页支持保存提交数据，管理员可在门户查看答题明细。
- 服务器已切换为本地 PostgreSQL 存储：用户、AI配置、历史复盘、数据来源和测评提交统一入库。
- 历史报告列表改为轻量 SQL 查询，只返回标题、来源、时间和下载链接，不再加载大体量 `summary_json/report_json`，列表打开更快、更省内存。
- 历史复盘报告按登录用户隔离：普通账号只能看到自己上传或生成的报告，管理员账号可查看全部报告。
- AI API 已改为账号级配置：当前账号配置优先；没有账号级配置时，使用 `hydee` 管理员 API 兜底。
- 当月营销推荐新增月初取数能力：对已经授权保存的四季蝉账号，系统可读取活动列表和活动商品明细，合并分析后以脱敏小栏目轮播展示当月重点品营销建议。
- 管理员后台新增用户管理：支持查看用户角色、启用状态、AI配置数量、历史报告数量、数据来源数量和最近登录时间，并可维护用户基础资料。
- 前端内存进一步瘦身：历史报告改为分页加载，生成中任务只轮询轻量状态；静态内容 JSON 增加缓存与请求去重；切换页签时销毁非活跃页面树，避免大表格和表单长期驻留。
- 后端报告生成进一步拆线程：AI 报告和分享页优先返回，Excel 汇总改为 Worker 后台生成；Excel 只接收裁剪后的工作簿输入，避免大明细同时压在主线程内存里。
- 分享产物进一步瘦身：`report.json` 只保留报告、链接和轻量摘要，完整接口诊断与标准化数据拆到独立 JSON 文件，旧本地报告产物也已刷新为轻量结构。
- 新增自动检查脚本：`npm run check` 会同时执行语法检查、架构边界断言和 HTTP 烟测，防止历史报告列表、大对象载荷、分享产物和 Excel 生成链路回退。

## AI 复盘数据来源

AI 复盘报告支持两种来源。

### 1. Excel 模板上传

上传四季蝉复盘数据标准模板 `.xlsx`，后端解析标准页签并生成报告。

适合已经有人手工整理数据的场景。

### 2. 四季蝉登录获取

输入四季蝉账号、密码，客户名称和客户编码选填。后端临时登录 `merchants.hydee.cn`，按自然月口径取数。

当前会读取：

- 销售汇总
- 我的活动列表
- 活动汇总
- 奖励统计
- 奖励发放明细
- 员工豆豆账户/提现
- 培训情况
- 厂家打赏
- 概览校验

四季蝉业务 token 只用于本次取数，不写入 GitHub、前端代码、分享报告或历史记录。为支持“月初当月营销推荐”，登录获取成功后可在服务器数据库中保存加密后的四季蝉取数授权；密码不明文落库，使用服务器 `SESSION_SECRET` 派生密钥加密。

企微扫码入口提供受控的 token 交接方式：用户先通过企业微信扫码进入海典新零售管理平台，门户同时生成一次性授权交接码和授权助手。授权助手运行在新零售页面内，会监听浏览器存储、`fetch`、`XMLHttpRequest` 中出现的 Authorization/token，并通过 CORS 回传给本站服务器。服务器只用该 token 调用四季蝉业务接口导出复盘数据，不抓取第三方 Cookie，不把 token 写入报告产物或 GitHub；本站回调版企微链接仅用于诊断 code 交换能力，主流程以扫码后进入新零售页面为准。

服务器安装 Chromium 后，可启用“服务器扫码获取”：后端用 `playwright-core` 启动无头 Chromium 打开企微扫码页，前端展示服务器浏览器截图，扫码后由服务器浏览器监听新零售接口 token 并自动写入一次性交接会话。若服务器没有 Chromium，页面仍可使用“创建交接并打开扫码 + 授权助手”的兼容模式。

## 当月营销推荐

当月营销推荐分两层：

- **页面基线模板**：保留月度节点、品类、AAA 主力品种和四季蝉玩法，用于没有自动取数结果时快速拆活动。
- **自动取数推荐**：管理员可触发当月推荐生成；系统登录已授权的四季蝉账号，读取“我的活动列表”和“活动商品明细”，合并汇总出当月重点商品、激励优先级、弱动销复盘项和下一步动作。
- **脱敏展示**：前端只展示合并后的营销建议、活动数、商品数和重点品，不展示客户名称、账号、客户编码等识别信息。

服务端也支持命令行月初任务：

```bash
npm run monthly:marketing
```

建议在生产服务器使用 systemd timer 或 cron 每月 1 日凌晨执行。生成结果保存到 `monthly_marketing_recommendations`，前端“当月营销推荐”页会读取展示。

## AI 报告会输出什么

每次 AI 复盘成功后，系统会生成一组可分享、可下载、可追溯的产物：

```text
.server/reports/{reportId}/
├─ index.html                         独立分享网页
├─ report.json                         结构化报告数据
├─ report.svg                          SVG 长图
├─ qr.svg                              二维码
├─ 客户名称_日期_四季蝉复盘报告.xlsx    Excel 汇总
├─ review.xlsx                         Excel 汇总兼容副本
├─ 四季蝉接口诊断.json
└─ 四季蝉登录获取标准化数据.json
```

前端会展示：

- 打开分享页
- 下载 SVG
- 二维码弹框
- Excel 汇总，文件名按“客户名称_日期”生成
- 接口诊断
- 标准化数据
- 复制链接

这些链接会按当前访问域名拼接。例如通过 `https://sijichan.top` 访问时，复制和下载链接都会使用 `https://sijichan.top/reports/...`。

## 技术架构

- **前端**：单文件 React 应用，入口为 `index.html`。
- **组件风格**：Ant Design 组件 + Ant Design/X 风格，整体偏蓝紫、清爽、适合经营看板和客户演示。
- **后端**：Node.js HTTP 服务，入口为 `preview-server.js`，默认监听 `0.0.0.0:8765`。
- **数据解析**：支持 Excel 模板解析，也支持内置四季蝉导出器临时登录取数。
- **AI 调用**：支持 OpenAI Responses 协议和 OpenAI-compatible Chat Completions 协议。
- **推荐模型配置**：DeepSeek 可使用 `https://api.deepseek.com` + `deepseek-v4-flash`。
- **报告产物**：HTML、JSON、SVG、二维码、Excel、接口诊断、标准化数据。
- **数据存储**：优先使用 Postgres。线上服务器使用本地 PostgreSQL；未配置数据库时才回退到 `.server/portal-data.json`。
- **手机端**：使用 `<=640px` 和 `<=380px` 断点，长表格在手机端转换为卡片列表。

## 数据库与后台能力

服务启动时会准备这些表：

- `users`：门户用户。
- `customer_profiles`：客户/连锁主体信息。
- `ai_configs`：账号级 AI 配置，包含 `owner_user_id`，按“当前账号优先、hydee管理员兜底”的口径读取。
- `system_settings`：系统级长期配置，当前用于保存“复盘AI指令”，由管理员在“系统维护”中维护，实际生成报告时由后端从数据库读取生效。
- `customer_datasets`：客户数据来源记录。
- `ai_review_uploads`：AI 复盘报告上传/登录取数记录，关联数据来源和历史报告。
- `review_reports`：AI 复盘历史报告。
- `review_report_payloads`：AI 复盘完整载荷，保存完整 `summary_json`、`report_json` 和 `markdown`。
- `auth_operation_logs`：注册、登录、退出、失败登录等操作审计记录。
- `sijichan_account_authorizations`：四季蝉月初取数授权，密码加密保存。
- `monthly_marketing_recommendations`：当月营销推荐结果，保存活动/商品摘要和推荐内容。
- `capability_test_submissions`：五大金刚测评提交记录。

生产环境采用“轻量主表 + 大对象载荷表”的设计：

- `review_reports` 只保存列表和检索需要的轻字段：用户、来源、状态、报告标题、行数摘要、健康评分、风险等级、分享链接、SVG、二维码、Excel、诊断和标准化数据链接。
- `review_report_payloads` 保存完整历史分析数据，只在查看报告详情或后续深度复盘时读取。
- 历史报告列表接口不读取完整 `summary_json/report_json`，避免大 JSON 占用 Node 内存。
- `.server/reports/{reportId}/` 继续保存可直接分享和下载的静态产物；数据库保存结构化内容和产物索引。
- 分享目录中的 `report.json` 是轻量索引文件；完整标准化数据和接口诊断分别保存为独立 JSON 文件，浏览器和历史列表不再默认加载大对象。
- Excel 汇总由后台 Worker 读取临时 `workbook-input.json` 生成，完成或失败后更新 `status.json` 和历史报告状态，临时输入会在任务结束后清理。
- 生产环境设置 `DISABLE_LOCAL_DATA_FALLBACK=true`，数据库启用后不再回退读取 `.server/portal-data.json`。
- 所有业务表使用主键和核心查询索引；`updated_at` 由统一触发器自动维护。
- 生产库包含 `get_review_report_list`、`record_auth_operation`、`review_report_payload_count` 等数据库函数，分别用于历史报告轻量列表、登录审计写入和载荷完整性检查。

当前 `192.168.1.200` 使用本地 PostgreSQL 作为生产库，历史报告主表已压缩为轻量元数据表；完整分析载荷存放在 `review_report_payloads`。

用户能力：

- 支持开放注册、登录、退出。
- 第一位注册用户自动成为管理员。
- 普通用户可生成和查看自己的 AI 复盘报告。
- 每个登录账号可在“系统维护 / AI配置”维护自己的 AI 配置；管理员可查看全部复盘报告、测评数据和用户列表。
- 管理员可在“系统维护 / 用户管理”编辑用户姓名、手机号、邮箱、角色和启停状态；系统会阻止当前管理员把自己停用或降级。

## 友链资料

首页底部“相关工具与资料”包含 5 个独立 HTML 页面：

- `links/south-chain-june-marketing.html`：华南连锁 6 月四季蝉营销方案。
- `links/pharmacy-seasonal-marketing-calendar.html`：医药连锁四季营销日历。
- `links/sijichan-product-handbook-v2.html`：四季蝉产品学习手册。
- `links/five-core-capability-test.html`：五大金刚综合能力评估测试。
- `/oms`：O2O 新零售 FAQ 速查表。

五个页面都做了手机端适配。五大金刚测评页额外支持：

- 填写姓名、部门、日期。
- 提交 17 道开放题答案。
- 后端保存完成度和答题内容。
- 管理员登录门户后查看提交数据。

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
node scripts/assert-architecture.js
node scripts/smoke-test.js
```

也可以在支持 npm 脚本的终端中执行：

```bash
npm run check
```

其中：

- `assert-architecture` 用于守住架构边界：历史报告列表必须走轻量视图，完整复盘载荷必须存到 `review_report_payloads`，Excel 必须后台 Worker 生成，分享产物 `report.json` 不能再塞入 `rawData/interfaceDiagnostics` 大对象。
- `smoke-test` 会临时启动服务，检查首页、登录/注册、友链、内容 JSON、AI 配置状态和未登录权限边界。设置 `SMOKE_BASE_URL=https://sijichan.top` 时可直接检查线上站点；设置 `SMOKE_LOGIN/SMOKE_PASSWORD` 时会额外验证登录后的历史报告列表是否保持轻量返回。

## 环境变量

生产环境配置放在服务器 `.server/.env` 或进程管理工具环境变量中，不提交 GitHub。

```bash
PORT=8765
HOST=0.0.0.0
SESSION_SECRET=replace-with-random-secret
PUBLIC_REPORT_BASE_URL=https://sijichan.top

# Supabase/Postgres，可使用 DATABASE_URL 或拆分参数
DATABASE_URL=postgresql://...
DB_HOST=db.gqinewwwnfdxwqtnapjl.supabase.co
DB_PORT=5432
DB_NAME=postgres
DB_USER=sijichan
DB_PASSWORD=********
DB_SSL=true

# 本地 PostgreSQL 部署示例
DB_HOST=127.0.0.1
DB_PORT=5432
DB_NAME=sop_4chan
DB_USER=sop_4chan_app
DB_PASSWORD=********
DB_SSL=false

# 数据库启用后可关闭本地 JSON 兜底，避免异常时读取大文件
DISABLE_LOCAL_DATA_FALLBACK=true
```

`PUBLIC_REPORT_BASE_URL` 会影响分享页、二维码、SVG、Excel、接口诊断和标准化数据链接。通过 Cloudflare Tunnel 暴露服务时，应设置为：

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

## 本地数据库迁移

服务器从 `.server/portal-data.json` 迁移到本地 PostgreSQL 时，可执行：

```bash
npm run migrate:local-data
```

该脚本会迁移：

- `users`
- `customer_profiles`
- `ai_configs`
- `customer_datasets`
- `review_reports`
- `capability_test_submissions`

迁移完成后，历史分析数据保存在数据库中；分享网页、SVG、二维码、Excel、接口诊断和标准化数据仍保存在 `.server/reports/{reportId}/`，数据库保存可访问链接和结构化报告内容。

## 数据库备份

仓库提供生产备份脚本：

```bash
npm run backup:db
```

线上服务器已安装 `sop-4chan-db-backup.timer`，每天 `03:30` 自动执行 `pg_dump`，备份文件保存到：

```text
.server/backups/sop_4chan_YYYYMMDD-HHMMSS.dump
```

默认保留最近 14 天备份。`.server/backups/` 不提交 GitHub。

## 部署

默认监听：

```text
0.0.0.0:8765
```

可直接使用 Node.js：

```bash
PORT=8765 HOST=0.0.0.0 npm start
```

长期运行建议使用 systemd 或 pm2。

部署或同步服务器时，除了 `index.html`、`preview-server.js`、`package.json`，还必须同步这些静态资产目录：

- `content/`：首页、对接行事历、激励玩法、选品思路、当月营销推荐的外置 JSON 内容。缺失时页面会出现内容加载失败或空白模块。
- `links/`、`oms/`、`assets/`、`vendor/`：友链资料、FAQ、站点图标和前端依赖资源。
- `scripts/`：迁移、备份、烟测和架构断言脚本。

可以先在本地生成白名单发布包：

```bash
npm run release:prepare
```

发布包会生成在 `.server/releases/sop-4chan-YYYYMMDD-HHMMSS/`，只包含代码、静态内容、友链资料、脚本和文档；不会包含 `.server` 运行数据、数据库备份、企微调试截图、录屏帧或 `node_modules`。

部署后建议先跑：

```bash
npm run check
SMOKE_BASE_URL=https://sijichan.top node scripts/smoke-test.js
```

如果线上 `content/*.json` 返回 404，说明静态内容目录没有同步完整，需要重新部署 `content/`。

当前线上通过 Cloudflare Tunnel 映射到：

```text
https://sijichan.top
```

## 安全说明

- `.server/` 不提交 GitHub。
- AI API Key、数据库密码、四季蝉账号密码、业务 token 不写入前端代码。
- AI API Key 按账号加密保存：当前账号自己的 Key 优先；未配置时使用 `hydee` 管理员配置兜底；Key 不会在页面回显。
- 客户上传的原始 Excel 不长期保存；系统只保存解析摘要、AI 报告、历史报告记录和分享产物。
- 历史报告保存的是报告结果和下载链接，不保存四季蝉登录凭证。
- 普通账号只能通过历史报告接口查看自己生成的复盘记录；管理员可查看全部记录。
- 五大金刚测评会保存用户主动填写的姓名、部门、日期和答题内容；仅管理员可在后台查看。

## 相关仓库

- 门户与 AI 报告系统：`oldxianyu/SOP_4CHAN`
- 四季蝉数据导出器：`oldxianyu/sijichan-shuju`

`SOP_4CHAN` 负责把数据变成客户能看懂、能分享、能行动的复盘材料。

`sijichan-shuju` 负责把四季蝉后台数据取出来、标准化、诊断化，并沉淀为稳定的数据包。

- 历史复盘报告新增任务状态追踪：生成中、失败、已取消会直接显示在历史报告列表；失败会展示错误原因，用户可取消卡住任务或回到 AI 复盘页重试。
