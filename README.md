# 光影复盘 · 摄影写真销售复盘机器人（Web 原型）

## 技术栈（可接入主流大模型）
- 前端：原生 HTML/CSS/JS（便于快速落地与二次开发）
- 后端：Node.js 原生 `http` 服务（无需额外依赖，内置代理 API）
- AI 接入：OpenAI / Anthropic / Deepseek / Doubao / Qwen（均为可配置）

> 当前版本已内置轻量异步任务队列与限流；如需生产级多副本与持久化队列，推荐迁移到 Next.js + PostgreSQL + Redis + 对象存储。

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
- `deploy/railway/variables.min.example`：Railway 预发变量模板

## 双环境域名建议
- `staging.qjgroup.top` -> Railway（预发）
- `app.qjgroup.top` -> 火山引擎（生产）
- 不建议把生产主域直接指向 Railway；大陆访问稳定性不可控。

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
   - 模板已包含 `Host/X-Forwarded-*` 透传和 `client_max_body_size 60m`

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
