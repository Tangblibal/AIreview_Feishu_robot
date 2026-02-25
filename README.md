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

> 说明：Railway 适合快速验证，不保证中国大陆长期稳定可达。面向大陆员工长期使用，建议迁移到中国大陆云厂商并完成备案。

## 飞书开放平台接入（员工登录）
当前版本已内置飞书 OAuth 登录入口，支持保护 `/api/analyze` 与 `/api/review`。

1. 在飞书开放平台创建企业自建应用（面向企业内部员工）。
2. 在应用中开启网页授权能力，回调地址配置为：
   - `https://你的域名/auth/feishu/callback`
3. 在后端环境变量配置：
   - `FEISHU_ENABLED=true`
   - `AUTH_REQUIRED=true`
   - `FEISHU_APP_ID=...`
   - `FEISHU_APP_SECRET=...`
   - `FEISHU_REDIRECT_URI=https://你的域名/auth/feishu/callback`
4. 可选员工白名单（建议）：
   - `FEISHU_ALLOWED_OPEN_IDS=open_id_1,open_id_2`
   - 或 `FEISHU_ALLOWED_EMAILS=a@company.com,b@company.com`
   - 如果按邮箱白名单，需在飞书开放平台给应用申请邮箱相关 scope，并将 `FEISHU_SCOPE` 扩展到包含邮箱读取权限。
5. 发布应用版本并在企业内可见范围中授权给员工。

接口说明：
- `GET /api/me`：返回登录态
- `GET /auth/feishu/login`：发起飞书登录
- `GET /auth/feishu/callback`：登录回调
- `POST /auth/logout`：退出登录

## 中国大陆长期稳定 + 合规部署建议
若目标是长期服务中国大陆员工，请按以下基线落地：

1. 计算与网络：
   - 部署到中国大陆地域（阿里云/腾讯云/华为云等）
   - 使用大陆可访问域名与国内 CDN/WAF
2. 备案与资质：
   - 完成 ICP 备案（网站/服务）
   - 按需完成公安联网备案
3. 数据与安全：
   - 生产密钥只放环境变量/密钥管理服务
   - 音频与复盘结果存储到对象存储 + 数据库，开启访问控制和日志审计
   - 传输强制 HTTPS，服务端保留最小必要日志
4. 稳定性：
   - 服务做主备与监控告警（CPU/内存/5xx/延迟）
   - 为 ASR/LLM 接口配置超时、重试、降级策略

## 功能一览
- 高级感 UI 设计 + 行业信息
- 上传录音（演示）
- 复盘评分、关键改进点
- 门店话术模板配置（本地保存）
- 导出 PDF（浏览器打印保存）
- 多模型适配（OpenAI / Claude / Deepseek / Doubao / Qwen）
- 飞书员工登录（可保护复盘接口）

## 注意
- 浏览器内不会直接调用第三方 API，以避免泄露 Key。
- 如果 Node 版本 < 18，请自行安装 `node-fetch` 或升级 Node。
