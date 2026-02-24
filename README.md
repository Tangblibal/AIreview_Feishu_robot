# 光影复盘 · 摄影写真销售复盘机器人（Web 原型）

## 技术栈（可接入主流大模型）
- 前端：原生 HTML/CSS/JS（便于快速落地与二次开发）
- 后端：Node.js 原生 `http` 服务（无需额外依赖，内置代理 API）
- AI 接入：OpenAI / Anthropic / Deepseek / Doubao / Qwen（均为可配置）

> 如需升级为生产级（权限、数据库、任务队列、文件存储），推荐迁移到 Next.js + PostgreSQL + Redis + 对象存储。

## 运行方式
1. 直接打开 `index.html`（仅前端演示，不调用 AI）。
2. 启动本地服务（可调用 AI + 录音转写）：

```bash
node server.js
```

然后访问：`http://localhost:3000`

> 真实复盘需要通过本地服务访问，直接打开 `index.html` 不会调用后端接口。

## 配置优先级（已支持环境变量）
服务端配置读取顺序如下（后者覆盖前者）：

1. `DEFAULT_CONFIG`（代码默认）
2. `config/ai.config.json`（本地开发文件，可不存在）
3. 环境变量（推荐生产环境使用）
4. `AI_CONFIG_JSON`（可选，最终 JSON 覆盖）

## 本地开发配置
本地开发仍可直接使用：`config/ai.config.json`。

> 该文件已在 `.gitignore`，不会被提交。生产环境建议只用环境变量。

## 环境变量配置
1. 复制示例文件：

```bash
cp .env.example .env
```

2. 按需填写 `.env`：
- LLM：`ACTIVE_PROVIDER` + 对应 `*_API_KEY`
- STT：`STT_ACTIVE_PROVIDER` + 对应 `STT_*`
- TOS（可选）：`TOS_*`

3. 启动服务：

```bash
npm start
```

常用变量示例（完整列表见 `.env.example`）：
- `ACTIVE_PROVIDER=deepseek`
- `DEEPSEEK_API_KEY=...`
- `STT_ACTIVE_PROVIDER=doubao_asr_2`
- `STT_DOUBAO_ASR_2_PUBLIC_BASE_URL=https://your-app.up.railway.app`
- `TOS_ENABLED=true`

## Railway 部署步骤
1. 把项目推送到 GitHub（私有仓库即可）。
2. 在 Railway 新建项目并连接仓库。
3. 部署配置：
- 已提供 `railway.json`（包含 `npm start` 与 `/api/health` 健康检查）
- 如需在 UI 手动设置：Build Command `npm ci`，Start Command `npm start`
4. 在 Railway Variables 中填写环境变量（参考 `.env.example`）。
5. 首次部署后拿到公网域名（如 `https://xxx.up.railway.app`），并把：
- `STT_DOUBAO_ASR_2_PUBLIC_BASE_URL`（或 `STT_QWEN_FUN_ASR_PUBLIC_BASE_URL`）设置为该公网地址。
6. 若保留本地上传目录，建议挂载 Volume 到 `uploads` 目录（避免重启丢文件）。
7. 验收：
- `GET /api/health` 返回 `{"ok":true}`
- 上传一段音频，确认 `/api/review` 可返回复盘结果

## 功能一览
- 高级感 UI 设计 + 行业信息
- 上传录音（演示）
- 复盘评分、关键改进点
- 门店话术模板配置（本地保存）
- 导出 PDF（浏览器打印保存）
- 多模型适配（OpenAI / Claude / Deepseek / Doubao / Qwen）

## 注意
- 浏览器内不会直接调用第三方 API，以避免泄露 Key。
- 如果 Node 版本 < 18，请自行安装 `node-fetch` 或升级 Node。
