# SOP_4CHAN

海典四季蝉业务对接与AI复盘门户，使用 React + Ant Design 单页应用，并由 Node.js 服务提供静态资源、Excel解析和AI复盘接口。

## 功能

- 首页：四季蝉能力介绍。
- 对接行事历：客户对接事项和材料下载。
- 激励玩法：四季蝉激励类型说明。
- 选品思路：重点品分层和选品来源。
- 6月营销推荐：品种营销建议页。
- AI复盘报告：上传四季蝉复盘数据标准模板 `.xlsx`，生成AI复盘报告并支持复制。
- AI配置：管理员配置 OpenAI API Key、Base URL 和模型。

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
3. 保持默认 Base URL `https://api.openai.com/v1`，或填写兼容接口地址。
4. 填写账号可用模型，例如 `gpt-5.2`。
5. 点击“测试连接”，确认可用后保存。

配置会保存到服务器本地 `.server/ai-config.json`，该目录已加入 `.gitignore`，不会提交到 GitHub。

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
