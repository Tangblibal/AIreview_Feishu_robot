# 光影复盘 · 摄影写真销售复盘机器人（Web 原型）

## 技术栈（可接入主流大模型）
- 前端：原生 HTML/CSS/JS（便于快速落地与二次开发）
- 后端：Node.js 原生 `http` 服务（无需额外依赖，内置代理 API）
- AI 接入：OpenAI / Anthropic / Deepseek / Doubao / Qwen（均为可配置）

> 当前版本已内置异步任务队列、限流与 Redis 持久化能力，可用于单机生产部署。

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
- TOS（必填）：`TOS_*`
- 飞书机器人（可选）：`FEISHU_BOT_*`
- 上传限制与调试：`MAX_AUDIO_FILE_SIZE_MB`、`STT_DEBUG_ENABLED`
- 异步与限流：`REVIEW_JOB_*`、`RATE_LIMIT_*`

3. 启动服务：

```bash
npm start
```

常用变量示例（完整列表见 `.env.example`）：
- `ACTIVE_PROVIDER=deepseek`
- `DEEPSEEK_API_KEY=...`
- `STT_ACTIVE_PROVIDER=doubao_asr_2`
- `STT_DOUBAO_ASR_2_PUBLIC_BASE_URL=https://app.qjgroup.top`
- `STT_DOUBAO_ASR_2_SUBMIT_MAX_ATTEMPTS=4`（遇到 429 自动重试）
- `TOS_ENABLED=true`

## Railway 预发（先跑通）
适合先做功能联调与验收，部署快、运维轻。

1. 准备 GitHub 仓库并推送代码。
2. Railway 新建项目并连接仓库。
3. 在 `Variables` 中按 `deploy/railway/variables.min.example` 填值。
4. 首次部署后，在 `Networking` 查看默认域名 `https://<service>.up.railway.app`。
5. 回填变量 `STT_DOUBAO_ASR_2_PUBLIC_BASE_URL` 为真实 Railway 域名并 redeploy。
6. 验收命令：

```bash
curl -i https://<service>.up.railway.app/api/health
BASE_URL=https://<service>.up.railway.app AUDIO_FILE=/path/demo.m4a ./deploy/volcengine/smoke-test.sh
```

说明：
- Railway 适合预发，不保证中国大陆长期稳定可达。
- 详细步骤见 `deploy/railway/STAGING.md`。
- 控制台逐点击路径见 `deploy/railway/RAILWAY_UI_CHECKLIST.md`。

## 生产部署（火山引擎，推荐）
完整步骤见下方“火山引擎上线执行清单”。你可以直接使用仓库内模板文件部署：
- `deploy/volcengine/deploy.sh`：拉取代码、安装依赖、重启服务
- `deploy/volcengine/smoke-test.sh`：健康检查 + 复盘任务提交流程
- `deploy/volcengine/lumo-review.service`：systemd 服务模板
- `deploy/volcengine/nginx.app.qjgroup.top.conf`：Nginx 站点模板
- `deploy/volcengine/lumo-review.env.example`：生产环境变量模板
- `deploy/volcengine/PROD_CN_RUNBOOK.md`：国内生产一键执行手册
- `deploy/railway/variables.min.example`：Railway 预发变量模板

## 双环境域名建议
- `staging.qjgroup.top` -> Railway（预发）
- `app.qjgroup.top` -> 火山引擎（生产）
- 不建议把生产主域直接指向 Railway；大陆访问稳定性不可控。

## 研发发布规范（建议团队统一执行）
- 规范文档：`docs/process/RELEASE_WORKFLOW.md`
- PR 模板：`.github/pull_request_template.md`

这套规范用于确保：
- 生产仅发布 `main`，减少误发风险；
- 新功能先走预发验收，再进入生产；
- 每次发布都具备可执行回滚点（tag/commit）。

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

## 飞书自建机器人接入（录音 + 文字 -> TOS -> ASR -> LLM -> 回消息）
当前版本支持两种订阅方式：
- `webhook`：HTTP 回调到 `POST /api/feishu/bot/events`
- `long_connection`：服务启动后主动与飞书建立长连接接收事件（你要用的方式）

1. 飞书开放平台配置（企业自建应用）
   - 开启机器人能力与事件订阅。
   - 订阅事件：`im.message.receive_v1`
   - 如果用 `webhook`：请求地址填 `https://你的域名/api/feishu/bot/events`，挑战校验 Token 与 `FEISHU_BOT_VERIFICATION_TOKEN` 一致。
   - 如果用 `long_connection`：飞书控制台订阅方式选择“长连接接收事件”，不需要填写回调 URL。
   - 建议先关闭“事件加密”或自行扩展解密逻辑（当前版本只支持明文事件）。
2. 申请并开通相关权限（以飞书平台实际命名为准）
   - 读取消息与资源下载相关权限
   - 发送消息权限
3. 服务端环境变量
   - `FEISHU_BOT_ENABLED=true`
   - `FEISHU_BOT_EVENT_MODE=long_connection`（长连接）或 `webhook`（回调）
   - `FEISHU_BOT_APP_ID=...`、`FEISHU_BOT_APP_SECRET=...`
   - `FEISHU_BOT_VERIFICATION_TOKEN=...`（仅 webhook 模式需要）
   - `FEISHU_BOT_RECEIVE_ID_TYPE=chat_id`（推荐）
   - `TOS_ENABLED=true` 且完整配置 `TOS_*`
4. 机器人行为说明
   - 收到文字消息：缓存用户补充说明并提示发送录音。
   - 收到音频/文件消息：下载音频并上传 TOS，调用 ASR 转写，再把“补充文字 + 转写文本”送入 LLM。
   - 复盘完成后：通过飞书机器人主动回发结果文本给用户。
5. 可选策略
   - `FEISHU_BOT_REQUIRE_TEXT_WITH_AUDIO=true`：强制先发文字再发录音。
   - `FEISHU_BOT_REPLY_MAX_LENGTH`：控制回复长度，避免超长消息。

## 飞书文档归档（复盘完成后自动创建云文档）
开启后，机器人会在复盘完成后额外创建一份飞书云文档，并把文档链接回复到原会话里。现有 ASR 和 LLM 处理链路不变，文档创建失败时仍会发送短文本复盘，不会静默失败。

1. 飞书开放平台权限
   - 群聊信息读取权限：用于读取 `chat_id` 对应群名，生成 `群名-年月日-录音发送人名称` 标题。
   - 用户信息读取权限：用于根据发送人 ID 解析展示名称。
   - 云文档创建权限：用于创建新版文档。
   - 云空间/文件夹写入权限：用于把文档直接创建到指定 folder token 下。
2. 服务端环境变量
   - `FEISHU_DOCS_ENABLED=true`
   - `FEISHU_DOCS_FOLDER_TOKEN=VsF6flLpqlHbUjdlelJcCwMFnEb`
   - `FEISHU_DOCS_TITLE_TIMEZONE=Asia/Shanghai`
   - `FEISHU_DOCS_MAX_TITLE_LENGTH=100`
   - `FEISHU_DOCS_REPLY_MODE=link_with_summary`
   - `FEISHU_DOCS_REQUEST_TIMEOUT_MS=30000`
3. folder token 获取与配置
   - 在飞书云空间中打开目标文件夹，复制链接中的 folder token。
   - 将该 token 配到 `FEISHU_DOCS_FOLDER_TOKEN`，机器人会把每次复盘的新文档直接建在这个文件夹下。
4. 文档标题规则
   - 默认规则：`群名-年月日-录音发送人名称`
   - 元数据缺失时回退：`录音原文件名-年月日`
   - 例如：`苏州门店复盘群-20260420-张三`
   - 例如：`客户首咨录音.m4a-20260420`
5. 回复行为
   - 文档创建成功：机器人回复“销售复盘已完成，已归档到飞书文档”，同时附带标题、评分、状态和文档链接。
   - 文档创建失败：机器人退回短文本复盘，不发送整段 markdown dump；内容只保留完成提示、评分、状态和一句摘要。
   - 文档功能关闭：继续沿用原有文本回复路径。

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

## 火山引擎上线执行清单（当前目标：先不上飞书）
以下步骤默认你先把网页应用功能跑稳，不启用飞书登录。

1. 服务器准备（火山引擎 ECS）
   - 创建 ECS（建议中国大陆地域）
   - 安装 Node.js 18+ 与 Nginx
   - 拉取项目代码到服务器目录（建议 `/opt/qjgroup-ai-review`）
   - 创建运行用户：`sudo useradd -r -s /sbin/nologin www-data || true`

2. 应用环境变量（生产）
   - 复制模板：`sudo cp deploy/volcengine/lumo-review.env.example /etc/lumo-review.env`
   - 编辑 `/etc/lumo-review.env` 填入真实密钥（DeepSeek、ASR、TOS）
   - 核对 `STT_DOUBAO_ASR_2_PUBLIC_BASE_URL=https://app.qjgroup.top`

3. systemd 服务（建议）
   - 复制模板：`sudo cp deploy/volcengine/lumo-review.service /etc/systemd/system/lumo-review.service`
   - 安装依赖并启动：`npm ci --omit=dev && sudo systemctl daemon-reload && sudo systemctl enable --now lumo-review`
   - 查看状态：`sudo systemctl status lumo-review --no-pager`

4. Nginx 反向代理
   - 复制模板：`sudo cp deploy/volcengine/nginx.app.qjgroup.top.conf /etc/nginx/conf.d/app.qjgroup.top.conf`
   - 生效配置：`sudo nginx -t && sudo systemctl reload nginx`
   - 模板已包含 `Host/X-Forwarded-*` 透传和 `client_max_body_size 220m`（后端仍按 `MAX_AUDIO_FILE_SIZE_MB` 校验）

5. 域名与证书
   - 在火山引擎云解析添加 `app.qjgroup.top` 记录
   - 申请并绑定 TLS 证书（HTTPS）
   - 验证 `https://app.qjgroup.top/api/health`

6. 合规（大陆必做）
   - 完成 ICP 备案（按政策要求）
   - 视业务场景完成公安联网备案

7. 上线验收命令
```bash
curl -i https://app.qjgroup.top/api/health
curl -i -X POST https://app.qjgroup.top/api/analyze -H 'Content-Type: application/json' -d '{"transcript":"test","templates":[]}'
curl -i -X POST https://app.qjgroup.top/api/review -F 'audio=@/path/demo.m4a' -F 'templates=[]'
# 假设上一步返回 job_id，再查询：
curl -i https://app.qjgroup.top/api/review/jobs/<job_id>
# 或直接执行仓库脚本（建议）
BASE_URL=https://app.qjgroup.top AUDIO_FILE=/path/demo.m4a ./deploy/volcengine/smoke-test.sh
```

说明：
- 所有错误返回均带 `request_id`，可直接去服务日志按 `request_id` 检索定位问题。
- `/api/review` 已增加音频类型/大小校验、异步队列与限流，异常会返回明确错误码与信息。

8. 中国大陆可用性测试（建议最少做 3 组）
   - 用中国移动/联通/电信各 1 条网络，访问 `https://app.qjgroup.top`
   - 在北京、上海、广州各找 1 位同事做页面打开与上传复盘测试
   - 记录首屏时间、任务完成时间、失败率（超时/5xx），连续观察 3-7 天

## 功能一览
- 高级感 UI 设计
- 上传录音（演示）
- 复盘评分、关键改进点
- 门店话术模板配置（本地保存）
- 导出 PDF（浏览器打印保存）
- 多模型适配（OpenAI / Claude / Deepseek / Doubao / Qwen）
- 飞书员工登录（可保护复盘接口）

## 注意
- 浏览器内不会直接调用第三方 API，以避免泄露 Key。
- 如果 Node 版本 < 18，请自行安装 `node-fetch` 或升级 Node。
