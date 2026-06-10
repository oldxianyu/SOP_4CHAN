# 四季蝉门户性能与架构优化方案

本文档聚焦三个目标：

1. 前端内存瘦身，减少页面首次加载和长时间停留后的内存增长。
2. 业务逻辑后移，把筛选、聚合、状态流转尽量放到后端和数据库。
3. 让数据库成为主计算和主存储层，前端做到“随用随取，用完即毁”。

## 一、当前已经落地的优化

### 1. 历史报告、用户管理、测评数据改为服务端分页

当前页面不再一次性把整表数据全部拉到前端内存中，而是由后端分页返回：

- `GET /api/review-reports?page=&pageSize=`
- `GET /api/admin/users?page=&pageSize=`
- `GET /api/capability-test-submissions?page=&pageSize=`

对应改动：

- `preview-server.js`
  - `parsePagination()`
  - `listReviewReports(user, options)`
  - `listAdminUsers(options)`
  - `listCapabilitySubmissions(options)`
- `index.html`
  - `HistoryPage`
  - `UserManagementPage`
  - `CapabilitySubmissionsPage`

收益：

- 前端只保留当前页数据，不再缓存整张历史表。
- 历史报告列表不再把完整 `summary/report/markdown` 常驻到页面内存。
- 表格切页成本从“大对象重渲染”变成“轻量分页刷新”。

### 1.1 复盘任务状态开始后移到数据库

复盘生成链路虽然仍保留了进程内 `Map` 作为临时运行引用，但以下关键控制状态已经开始写入 `review_reports`：

- `status`
- `job_key`
- `cancel_requested`
- `heartbeat_at`
- `progress_stage`
- `progress_text`
- `progress_percent`
- `started_at`
- `finished_at`

对应改动：

- `preview-server.js`
  - `createRunningReviewReportRecord()`
  - `cleanupExpiredReviewJobs()`
  - `findBlockingRunningReviewJob()`
  - `assertReviewJobStillActive()`
  - `handleCancelReviewJob()`
  - `getLatestRunningReviewReport()`
  - `GET /api/review-reports/running`
  - `review_report_list_view`
  - `running_review_report_view`
- `index.html`
  - `AIReviewWorkspace`
  - `startReviewStatusPolling()`

收益：

- 服务重启后，运行中任务不再完全丢失控制信息。
- 并发占用判断不再只依赖进程内存。
- 用户取消、超时清理、运行心跳开始有数据库依据。
- 历史报告页可以直接读取数据库中的“当前阶段 / 当前文案 / 当前进度”，前端不需要长期握着完整任务过程状态。
- AI复盘当前页也可以按需轮询“当前运行中的轻量状态”，不用为了拿进度而重新拉整页历史列表。
- 轻量列表字段和运行中状态字段开始由数据库视图统一裁剪，后端接口不必每次手写完整字段拼装。

### 2. 静态说明型内容改为按需加载

以下页面的说明型大数组已经从 `index.html` 脚本中拆出，改为访问页面时按需加载：

- 首页：`/content/home.json`
- 激励玩法：`/content/incentive.json`
- 选品思路：`/content/selection.json`
- 当月营销推荐：`/content/monthly-marketing.json`
- 对接行事历：`/content/calendar.json`

对应改动：

- `index.html`
  - `useContentResource(url)`
  - `HomePage`
  - `IncentivePage`
  - `SelectionPage`
  - `JuneMarketingPage`
- `content/*.json`

收益：

- 首屏脚本体积下降。
- 页面切换时只加载该页需要的说明数据。
- 后续这些内容可以独立维护，不必每次改一行说明都改动主页面脚本。

### 2.1 测评数据改为“列表摘要 + 详情按需读取”

`五大金刚综合能力评估测试` 原本在列表接口中直接返回每条提交的完整答案数组，这会让后台页一次性把大量长文本常驻到前端内存。

现已调整为：

- `GET /api/capability-test-submissions?page=&pageSize=` 只返回摘要字段
- `GET /api/capability-test-submissions/:id` 按需返回单条完整答案

数据库层补充：

- `capability_submission_list_view`

前端层补充：

- `CapabilitySubmissionsPage` 点击“查看答案”时再请求详情

收益：

- 列表页不再为每一行预加载完整长文本答案。
- 测评数据页的初始请求体和 React 常驻状态明显更轻。
- 大对象只在管理员真正点击详情时才进入前端内存。

### 2.2 企微扫码会话改为“轻状态轮询 + 调试详情按需加载”

企微扫码流程原本会把会话调试信息和诊断数组随着会话状态一起频繁返回。现在继续收口为两层：

- `GET /api/wecom-browser-session/:id`
  - 只返回扫码页渲染必需的轻状态
- `GET /api/wecom-browser-session/:id/debug`
  - 仅在需要排查问题时才返回：
    - `exportProbeDetails`
    - `ssoDiagnostics`
    - `openPages`

配套调整：

- 创建会话接口改为返回轻量 `session public view`
- 前端新增“加载调试详情”按钮
- 轮询过程中不再每次把调试数组重新灌入前端状态

收益：

- 企微扫码页的轮询响应体更小。
- 调试信息从“默认常驻”变成“按需读取”。
- 对长时间停留在扫码页的前端内存更友好。

### 2.3 当月营销推荐聚合改为轻量视图取数

`当月营销推荐` 前端本来就只消费汇总结果，但后端在聚合前会从 `monthly_marketing_recommendations` 读取整行数据。

现已补充：

- `monthly_marketing_list_view`

该视图只保留聚合真正需要的字段：

- `customer_name`
- `customer_code`
- `status`
- `activity_count`
- `product_count`
- `generated_at`
- `focus_products_json`
- `next_actions_json`

收益：

- 后端在生成“合并分析后的当月推荐”时，不再搬运整份 `summary_json / recommendation_json / markdown`。
- 数据库先做一层字段裁剪，Node 只拿聚合所需最小数据面。

### 2.4 报告生成接口改为“写轻响应 + 详情按需读取”

复盘生成成功后，原来各个 `POST` 接口会直接返回：

- `summary`
- `report`
- `markdown`
- 分享产物链接

这意味着：

- 写接口响应体很大
- 同一份完整报告会在“保存入库”和“POST响应返回”两条链路里重复搬运
- 前端写流程和读流程耦合得太紧

现已调整为：

- 生成类 `POST` 成功时只返回：
  - `id`
  - 轻量 `summary`
  - 分享产物链接
- 前端随后统一调用：
  - `GET /api/review-reports/:id`

收益：

- 写接口变轻，读接口统一。
- 完整报告详情只通过一个标准详情接口读取。
- 后续如果历史报告、分享页、当前页都需要详情，可以共用同一个读模型。

## 二、前端内存瘦身建议

### 1. 识别和清理内存泄漏

建议重点检查以下对象是否在页面卸载后仍被引用：

- `setInterval` / `setTimeout`
- `window.addEventListener`
- `document.addEventListener`
- Modal、Drawer、二维码预览等闭包回调
- 报告详情页中长文本、SVG 字符串、标准化 JSON 的组件级缓存

当前项目建议做法：

```js
React.useEffect(() => {
  const timer = window.setInterval(refresh, 8000);
  return () => window.clearInterval(timer);
}, [refresh]);
```

```js
React.useEffect(() => {
  function onResize() {
    setCompact(window.innerWidth < 640);
  }
  window.addEventListener("resize", onResize);
  return () => window.removeEventListener("resize", onResize);
}, []);
```

建议排查顺序：

1. 历史报告页长时间停留 10 分钟，检查轮询定时器是否重复注册。
2. AI复盘页多次生成报告，检查进度条、复制按钮、二维码弹窗是否残留闭包。
3. 登录页动画角色区，检查鼠标跟随事件是否在路由切换后释放。

### 2. 大列表渲染策略

当前后台型页面已经改为分页，但后续如果历史报告或测评数据继续增长，建议：

- 表格默认分页，单页 10 到 20 条。
- 移动端继续使用卡片列表，而不是把桌面表格硬压缩到手机。
- 如果单页也会超过 100 条，再引入虚拟滚动。

推荐顺序：

1. 先服务端分页。
2. 再限制单页返回字段。
3. 最后才引入虚拟滚动。

因为对本项目来说，最大问题不是 DOM 节点数量，而是“前端握着太多完整业务对象”。

### 3. 精简前端状态

不要在前端长期缓存以下对象：

- 完整复盘报告 `summary/report/markdown`
- 报告诊断 JSON
- 标准化大数据 JSON
- 历史报告全量列表

建议状态拆分：

- 列表页只保留轻量元数据：
  - `id`
  - `status`
  - `createdAt`
  - `sourceType`
  - `shareUrl`
  - `svgUrl`
  - `qrSvgUrl`
  - `excelUrl`
- 详情页打开时再请求完整载荷。

理想模式：

```js
const [tableState, setTableState] = React.useState({
  items: [],
  total: 0,
  page: 1,
  pageSize: 10,
  loading: false,
});
```

而不是：

```js
const [reports, setReports] = React.useState(fullReportsWithPayloads);
```

## 三、业务逻辑后移建议

### 1. 把筛选、排序、统计后移到 API / SQL

以下逻辑不应放在前端处理：

- 历史报告按状态、来源、日期区间筛选
- 用户列表按角色、状态统计
- 测评提交按时间、客户、分数段统计
- 当月营销推荐的跨客户合并分析

建议做法：

- 前端只传筛选条件。
- 后端用 SQL 直接分页、排序、聚合。
- 高频统计数据优先用视图或物化视图。

例如：

```sql
create view review_report_list_view as
select
  r.id,
  r.user_id,
  r.source_type,
  r.status,
  r.created_at,
  r.share_url,
  r.svg_url,
  r.qr_svg_url,
  r.excel_url,
  p.health_score,
  p.risk_level
from review_reports r
left join review_report_payloads p on p.review_report_id = r.id;
```

### 2. 报告生成走任务化，不要让前端背着过程状态

AI复盘生成、企微扫码取数、当月营销推荐生成，都适合改成任务流：

- 前端发起 `POST /api/review-report`
- 后端只返回 `jobId`
- 前端轮询 `GET /api/jobs/:id`
- 任务完成后再刷新历史报告

建议任务表：

```sql
create table report_jobs (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  source_type text not null,
  status text not null,
  progress_stage text,
  progress_percent integer not null default 0,
  error_message text,
  result_report_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

这样前端不需要在内存里长期维持复杂过程状态，也能支持：

- 取消任务
- 重试任务
- 失败原因展示
- 历史任务查询

### 3. Webhook、日志、审计异步化

如果后续增加更多外部接口接入或企业微信登录流程，建议不要同步写日志。

建议：

- 请求主流程只写最小状态。
- 日志、审计、通知进入异步队列。
- 队列消费者再写详细日志表。

可选实现：

- 轻量版：数据库任务表 + 后台 worker 轮询
- 稍重版：Redis + BullMQ

对当前项目，更推荐先用数据库任务表，不额外引入 Redis。

## 四、数据库极致利用建议

### 1. 让数据库承接状态流转

当前适合下沉到数据库层的逻辑：

- 报告状态从 `running -> completed / failed / cancelled`
- 用户停用后禁止继续生成报告
- 生成报告时自动更新用户最近活跃时间
- 测评提交后自动刷新客户统计

建议：

- 用触发器维护 `updated_at`
- 用数据库约束限制非法状态
- 用存储过程集中处理报告入库事务

示例：

```sql
create or replace function touch_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;
```

```sql
create trigger touch_review_reports_updated_at
before update on review_reports
for each row execute function touch_updated_at();
```

### 2. 报告主表和大对象载荷分离

建议长期保持：

- `review_reports` 只保存轻量元数据
- `review_report_payloads` 保存大对象内容

推荐字段边界：

`review_reports`

- `id`
- `user_id`
- `customer_profile_id`
- `source_type`
- `status`
- `row_count_summary`
- `health_score`
- `risk_level`
- `share_url`
- `svg_url`
- `qr_svg_url`
- `excel_url`
- `created_at`

`review_report_payloads`

- `review_report_id`
- `summary_json`
- `report_json`
- `markdown`
- `normalized_dataset_json`
- `diagnostics_json`

这样列表查询不会把大字段带出来，数据库缓存命中率也更高。

### 3. 索引建议

建议优先补以下索引：

```sql
create index if not exists idx_review_reports_user_created
on review_reports(user_id, created_at desc);

create index if not exists idx_review_reports_status_created
on review_reports(status, created_at desc);

create index if not exists idx_capability_test_submissions_created
on capability_test_submissions(created_at desc);

create index if not exists idx_users_role_status
on users(role, status);

create index if not exists idx_report_jobs_user_status_created
on report_jobs(user_id, status, created_at desc);
```

如果后续报告很多，建议再给 `source_type`、`customer_profile_id` 增加组合索引。

### 4. 用数据库视图承接后台统计

适合做视图的数据：

- 用户总数 / 管理员数 / 停用数
- 客户累计报告数
- 测评提交趋势
- 当月营销推荐来源客户数
- 近 7 天复盘成功率

这样后台页面不必每次在前端用数组 `filter/map/reduce` 算一遍。

## 五、下一阶段建议的实施顺序

### 第一阶段

1. 完成剩余静态内容下沉
2. 继续把仍在 `index.html` 内的说明型内容迁移到 JSON 或后端接口
3. 清理所有页面中的长数组、长字符串常驻脚本

### 第二阶段

1. 新增 `report_jobs` 任务表
2. AI复盘和企微扫码生成改成任务化
3. 历史报告中展示运行中、失败、取消、重试

### 第三阶段

1. 把统计类逻辑迁移到 SQL 视图
2. 后端 API 只返回列表需要的轻量字段
3. 报告详情按需读取 payload 表

### 第四阶段

1. 为本地 PostgreSQL 增加备份、清理、归档
2. 对大表执行 `vacuum analyze`
3. 为历史报告和测评数据增加归档策略

## 六、对本项目最重要的一条原则

前端不应该保存“完整客户业务世界”。

前端只保留：

- 当前页面需要显示的最小字段
- 当前交互需要的短期状态
- 当前详情页临时读取的大对象

其余一切都应尽量由后端和数据库负责：

- 聚合
- 过滤
- 排序
- 状态流转
- 长期存储
- 备份恢复

这样四季蝉门户才能在客户数据、历史报告、测评数据越来越多时，依然保持轻、稳、快。
