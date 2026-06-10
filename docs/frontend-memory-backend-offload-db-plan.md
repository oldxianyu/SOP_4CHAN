# 四季蝉门户性能与架构优化建议

这份文档聚焦三个目标：

1. 前端“随用随取”，不把大对象长期压在浏览器内存里。
2. 业务逻辑后移，把筛选、聚合、状态流转交给后端和数据库。
3. 数据库成为主存储和主计算层，列表轻、详情重、写入可追踪、恢复可落地。

## 1. 前端内存大瘦身

### 1.1 识别并清理内存泄漏

优先排查这几类对象：

- `setInterval` / `setTimeout` 没有清理
- `window` / `document` 事件监听未释放
- 弹框、二维码预览、报告详情里的闭包长期持有大字符串
- 历史报告列表把完整 `summary/report/markdown` 常驻在 React state
- 调试态对象持续轮询，例如扫码会话诊断、接口诊断 JSON

代码层建议：

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

针对本项目，重点守住这条原则：

- 列表页只保留轻量元数据
- 详情页打开时才取完整报告
- 调试详情按需读取，不进入默认轮询响应

### 1.2 大列表渲染策略

推荐顺序：

1. 服务端分页
2. 单页字段裁剪
3. 单页数量控制在 10 到 20 条
4. 只有在“单页也会超过 100 条”时再上虚拟滚动

适合虚拟滚动的页面：

- 后续如果历史报告、测评数据、用户管理有长时间滚动需求

不适合硬上虚拟滚动的页面：

- 目前手机端卡片列表
- 带操作按钮、动态高度描述较多的复盘卡片

### 1.3 精简前端状态

不要把这些对象放到全局状态或页面常驻 state：

- 完整复盘报告 `summary/report/markdown`
- 标准化原始 JSON
- 接口诊断 JSON
- 企微扫码调试详情
- 历史报告全量列表

更适合的状态拆分：

```js
const [tableState, setTableState] = React.useState({
  items: [],
  total: 0,
  page: 1,
  pageSize: 8,
  loading: false,
});

const [detailState, setDetailState] = React.useState({
  loading: false,
  report: null,
  summary: null,
  markdown: "",
});
```

## 2. 业务逻辑后移与状态解耦

### 2.1 哪些逻辑应该从前端剥离

以下逻辑建议全部放到后端或 SQL：

- 历史报告按状态、时间、来源筛选
- 用户管理统计：报告数、数据源数、AI 配置数
- 五大金刚测评的列表统计、按分数段汇总
- 当月营销推荐的跨客户合并分析
- 运行中任务的“最新状态”判定
- 卡住任务的超时清理、取消、重试

前端只负责：

- 传筛选条件
- 展示分页结果
- 打开单条详情

### 2.2 高频事件和长任务处理

对以下场景，不要让前端同步等待整条链路：

- AI 复盘生成
- 四季蝉登录取数
- 企微扫码辅助登录后的导出
- 月度营销推荐聚合

建议模式：

1. 写接口只创建任务记录
2. 立即返回 `jobId / reportDbId`
3. 前端轮询轻量状态接口
4. 完成后再按需请求详情

如果后续量继续增大，可以进一步引入：

- 独立 worker 队列消费 `review_jobs`
- 本地队列或 Redis 队列
- worker 进程独立执行 AI 任务

## 3. 数据库极致利用

### 3.1 表结构建议

核心表保持“主表轻、payload 重”：

- `review_reports`
  - 标题、来源、状态、时间、健康度、风险等级、分享链接
- `review_report_payloads`
  - 完整 `summary_json`
  - 完整 `report_json`
  - `markdown`
- `review_jobs`
  - 复盘生成任务的运行状态、进度、心跳、取消标记、失败原因和重试元数据
  - 进程内 `activeReviewJobs` 只保留当前 Node 进程的执行句柄，不再作为唯一状态源
- `review_job_events`
  - 复盘任务的创建、进度、取消请求、状态变化流水
  - 心跳类更新不写事件，避免日志表被轮询刷新撑大

同样的原则也可以复用到：

- `capability_test_submissions`
  - 列表页只看摘要列
  - 答案详情独立查询
- `monthly_marketing_recommendations`
  - 列表视图只暴露聚合所需字段

### 3.2 视图、触发器、过程化处理

建议长期保留并继续扩展：

- `review_report_list_view`
- `running_review_report_view`
- `admin_user_overview_view`
- `capability_submission_list_view`
- `monthly_marketing_list_view`

后续可继续数据库化的逻辑：

- 用户更新时自动刷 `updated_at`
- 周期性清理超时任务
- 月度推荐定时汇总

已经下沉到数据库层的逻辑：

- `review_jobs` 通过触发器写入 `review_job_events`
- 插入任务时记录 `created`
- 进度文案、阶段或百分比变化时记录 `progress`
- 取消标记从未取消变为取消时记录 `cancel_requested`
- 状态变化时记录 `status_changed`

### 3.3 索引建议

优先保证这些查询路径：

- `review_reports(user_id, created_at desc)`
- `review_reports(status, heartbeat_at desc)`
- `review_reports(source_type, created_at desc)`
- `review_report_payloads(report_db_id)`
- `review_jobs(job_key, status, created_at desc)`
- `review_jobs(status, heartbeat_at desc)`
- `review_job_events(review_job_id, created_at desc)`
- `review_job_events(report_db_id, created_at desc)`
- `review_job_events(user_id, created_at desc)`
- `capability_test_submissions(created_at desc)`
- `monthly_marketing_recommendations(status, generated_at desc)`

### 3.4 本地兜底也做轻重分离

即使当前是 `local-fallback`，也不要让 `.server/portal-data.json` 持续堆完整复盘内容。

建议结构：

- `.server/portal-data.json`
  - 用户
  - 客户资料
  - 历史报告轻量主记录
- `.server/review-report-payloads.json`
  - 按 `reportId` 存完整 `summary/report/markdown`
- `.server/portal-data.json` 的 `reviewJobs`
  - 本地开发兜底模式下保存运行中、失败、取消、完成的任务状态

这样有三个直接收益：

1. 历史列表接口读主文件时更轻
2. 详情接口按需取 payload
3. 本地开发模式更接近生产数据库行为

## 4. 本轮已经落地的方向

- 历史报告、用户管理、测评数据切到服务端分页
- 复盘详情改为按需加载
- 企微扫码调试详情从默认轮询响应拆出
- 当月营销推荐改为轻量视图取数
- 复盘生成写接口改成“先返回轻量结果，再单独取详情”
- 复盘 AI 指令改为数据库持久化维护
- 本地兜底开始切分“历史主记录”和“报告 payload”
- 前端页签启用 `destroyInactiveTabPane`，隐藏页签卸载后主动释放轮询和大状态
- 内容资源请求增加 `AbortController`，页面切换时取消未完成请求
- 历史报告、用户管理、测评数据、当月营销推荐列表增加“新请求中止旧请求”模式，避免旧响应回写和状态堆积
- 当月营销推荐聚合结果优先由数据库完成计数、聚合与字段裁剪，前端只消费脱敏后的聚合结果
- AI 复盘、登录获取、企微扫码报告生成统一落 `review_jobs`，任务进度、心跳、取消、失败原因都持久化
- `review_jobs` 状态变化通过 `review_job_events` 自动留痕，可追踪任务创建、进度、取消和失败上下文
- 新增 `GET /api/review-reports/:id/events`，按报告轻量元数据做权限判断后返回任务流水，避免为排障读取完整 payload
- 历史报告页新增“任务流水”按钮，点击时才按需读取事件并以时间线弹窗展示，不把事件数组常驻在列表内存里
- 任务事件保留策略已接入服务维护循环，默认保留 90 天且单个任务最多保留 80 条事件，避免 `review_job_events` 长期膨胀
- 报告详情接口默认返回 `summaryForResponse()` 轻量摘要，不再把 `summary.rawData` 原始标准化数据送进前端 state；完整明细继续通过“标准化数据”静态文件按需下载
- 运行中任务的重复提交判断优先读取 `review_jobs`，避免只依赖 Node 进程内存
- 超时任务清理会同步 `review_jobs` 和 `review_reports`，历史报告能看到失败原因，前端不用缓存任务状态
- 本地 JSON 兜底也保留 `reviewJobs` 和 `reviewJobEvents`，开发环境和生产数据库的任务行为保持一致

生产环境可以通过环境变量调整维护策略：

- `REVIEW_MAINTENANCE_INTERVAL_MS`：维护循环间隔，默认 10 分钟
- `REVIEW_JOB_EVENT_RETENTION_DAYS`：任务流水按时间保留天数，默认 90 天
- `REVIEW_JOB_EVENT_MAX_PER_JOB`：单个任务最多保留事件条数，默认 80 条

## 5. 下一步建议

按收益排序，推荐继续做这几件事：

1. 让生产环境彻底切到本地 PostgreSQL，关闭 JSON 兜底读取
2. 把 AI 复盘执行从 HTTP 请求进程拆到独立 worker，接口只创建任务并立即返回
3. 为月度营销推荐做定时任务，不再请求时临时聚合
4. 继续把接口诊断、标准化数据等大对象改为按需读取和短期缓存
5. 为历史报告和测评数据增加归档/导出策略，便于长期生产环境做审计和迁移
