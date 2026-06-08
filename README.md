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
- **6 月营销推荐**：结合月度营销节点、热卖品和赚钱品，提供品类与重点品种推荐。
- **AI 复盘报告**：登录后可上传 Excel 模板，或通过“四季蝉登录获取”直接取客户后台数据，生成 AI 复盘报告。
- **历史报告**：保存用户生成过的复盘报告，支持分享页、二维码弹框、SVG、Excel、接口诊断、标准化数据和复制链接。
- **AI 配置**：管理员维护 AI API Key、Base URL、模型名称和调用协议，支持 DeepSeek / OpenAI-compatible Chat Completions。
- **测评数据**：管理员查看“五大金刚综合能力评估测试”的提交记录。
- **相关工具与资料**：首页底部提供 4 个友链资料页，适合客户学习、培训和分享。

## 已更新功能

最近一轮更新重点加强了“老客户复盘”和“防流失经营”：

- 登录获取新增“我的活动列表”，可看到客户已参加/已配置活动池、活动状态、费用和活动销售额。
- 登录获取新增“奖励发放明细”，能证明奖励是否从活动执行流向店员。
- 奖励发放明细已增加大客户分页保护：超大数据会保留前 20 页明细，并在接口诊断中记录总行数、总页数、已取页数和是否截断，避免老客户报告生成卡死。
- 登录获取新增“员工豆豆账户/提现”，能看到店员收益感知和提现闭环。
- AI 生成增加超时保护：保留完整数据摘要给 AI；如果 AI 接口长时间无响应，系统会基于结构化数据生成兜底报告，保证分享页、SVG、二维码和 Excel 能继续产出。
- AI 复盘新增“活动持续运营”评分，判断客户是不是只做了一次活动，还是已经形成月度活动资产。
- 续用风险洞察增强：现在会综合活动覆盖、激励闭环、员工参与、培训承接、厂家协同和活动持续运营。
- Excel 汇总新增“我的活动列表”“奖励发放明细”“员工豆豆账户与提现”“续用风险与运营提升”等页面。
- 历史报告和生成结果中的分享、下载、复制链接会自动按当前访问域名拼接，适配 `https://sijichan.top`。
- 二维码在当前页面弹框展示，不再跳转到单独二维码页面。
- 手机端适配已覆盖首页、页签、AI 复盘、历史报告、对接行事历、登录注册和 4 个友链资料页。
- 五大金刚测评页支持保存提交数据，管理员可在门户查看答题明细。

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

四季蝉账号、密码和业务 token 只用于本次取数，不写入 GitHub、前端代码、分享报告或历史记录。

## AI 报告会输出什么

每次 AI 复盘成功后，系统会生成一组可分享、可下载、可追溯的产物：

```text
.server/reports/{reportId}/
├─ index.html                         独立分享网页
├─ report.json                         结构化报告数据
├─ report.svg                          SVG 长图
├─ qr.svg                              二维码
├─ review.xlsx                         Excel 汇总
├─ 四季蝉接口诊断.json
└─ 四季蝉登录获取标准化数据.json
```

前端会展示：

- 打开分享页
- 下载 SVG
- 二维码弹框
- Excel 汇总
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
- **数据存储**：优先使用 Supabase/Postgres；未配置数据库时回退到 `.server/portal-data.json`。
- **手机端**：使用 `<=640px` 和 `<=380px` 断点，长表格在手机端转换为卡片列表。

## 数据库与后台能力

服务启动时会准备这些表：

- `users`：门户用户。
- `customer_profiles`：客户/连锁主体信息。
- `ai_configs`：管理员维护的 AI 配置。
- `customer_datasets`：客户数据来源记录。
- `review_reports`：AI 复盘历史报告。
- `capability_test_submissions`：五大金刚测评提交记录。

用户能力：

- 支持开放注册、登录、退出。
- 第一位注册用户自动成为管理员。
- 普通用户可生成和查看自己的 AI 复盘报告。
- 管理员可维护 AI 配置、查看测评数据。

## 友链资料

首页底部“相关工具与资料”包含 4 个独立 HTML 页面：

- `links/south-chain-june-marketing.html`：华南连锁 6 月四季蝉营销方案。
- `links/pharmacy-seasonal-marketing-calendar.html`：医药连锁四季营销日历。
- `links/sijichan-product-handbook-v2.html`：四季蝉产品学习手册。
- `links/five-core-capability-test.html`：五大金刚综合能力评估测试。

四个页面都做了手机端适配。五大金刚测评页额外支持：

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
```

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

当前线上通过 Cloudflare Tunnel 映射到：

```text
https://sijichan.top
```

## 安全说明

- `.server/` 不提交 GitHub。
- AI API Key、数据库密码、四季蝉账号密码、业务 token 不写入前端代码。
- 客户上传的原始 Excel 不长期保存；系统只保存解析摘要、AI 报告、历史报告记录和分享产物。
- 历史报告保存的是报告结果和下载链接，不保存四季蝉登录凭证。
- 五大金刚测评会保存用户主动填写的姓名、部门、日期和答题内容；仅管理员可在后台查看。

## 相关仓库

- 门户与 AI 报告系统：`oldxianyu/SOP_4CHAN`
- 四季蝉数据导出器：`oldxianyu/sijichan-shuju`

`SOP_4CHAN` 负责把数据变成客户能看懂、能分享、能行动的复盘材料。

`sijichan-shuju` 负责把四季蝉后台数据取出来、标准化、诊断化，并沉淀为稳定的数据包。
