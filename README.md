# SOP_4CHAN

海典四季蝉业务对接与AI复盘门户，使用 React + Ant Design 单页应用，并由 Node.js 服务提供静态资源、Excel解析和AI复盘接口。

## 功能

- 首页：四季蝉能力介绍。
- 对接行事历：客户对接事项和材料下载。
- 激励玩法：四季蝉激励类型说明。
- 选品思路：重点品分层和选品来源。
- 6月营销推荐：品种营销建议页。
- AI复盘报告：上传四季蝉复盘数据标准模板 `.xlsx`，或通过登录获取数据，生成AI复盘报告并支持复制、分享、SVG导出和二维码查看。
- AI配置：管理员配置 AI API Key、Base URL、模型和调用协议。

## 本地运行

```bash
npm install
npm start
```

打开：

```text
http://localhost:8765/
```

## AI配置

首次进入“AI配置”页时：

1. 输入管理密码，首次保存会创建该管理密码。
2. 输入 OpenAI API Key。
3. DeepSeek 推荐 Base URL `https://api.deepseek.com`。
4. DeepSeek 推荐模型 `deepseek-v4-flash`，调用协议选择 `Chat Completions`。
5. 点击“测试连接”，确认可用后保存。

配置会保存到服务器本地 `.server/ai-config.json`，该目录已加入 `.gitignore`，不会提交到 GitHub。

## 复盘数据来源

AI复盘报告支持两种来源：

1. Excel模板上传：上传“四季蝉复盘数据标准模板”的 `.xlsx` 文件。
2. 登录获取：使用登录信息临时拉取标准 `dataset/` 数据包后生成报告。

登录获取时，四季蝉账号、密码或Token只会传给服务器用于本次导出，不会写入GitHub。临时导出的数据包在报告生成后会删除。

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
