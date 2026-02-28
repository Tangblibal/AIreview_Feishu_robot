# Railway 预发步骤（staging）

## 1. 准备仓库
1. 把当前项目推到 GitHub 仓库（建议私有）。
2. 确保仓库根目录包含 `railway.json`。

## 2. 创建 Railway 项目
1. Railway 控制台 -> `New Project` -> `Deploy from GitHub repo`。
2. 选择本仓库。
3. 等待首次构建完成。
4. 在同一 Project 内再创建一个 `Redis` 服务（用于异步任务持久化）。

## 3. 填写变量
1. 进入 Railway 项目 -> `Variables`。
2. 以 `deploy/railway/variables.min.example` 为模板逐项填写。
3. 先临时填写 `STT_DOUBAO_ASR_2_PUBLIC_BASE_URL=https://your-service.up.railway.app`。
4. 确认 `REVIEW_JOB_STORE_BACKEND=redis` 且 `REDIS_URL=${{Redis.REDIS_URL}}`。

## 4. 回填公网域名并二次部署
1. 进入 Railway 项目 -> `Settings` -> `Networking`，查看默认域名（`*.up.railway.app`）。
2. 回到 `Variables`，把 `STT_DOUBAO_ASR_2_PUBLIC_BASE_URL` 改为真实域名（带 `https://`）。
3. 触发 redeploy。

## 5. 预发验收
1. 健康检查：
   `curl -i https://<your-service>.up.railway.app/api/health`
2. 提交复盘任务并轮询：
   `BASE_URL=https://<your-service>.up.railway.app AUDIO_FILE=/path/demo.m4a ./deploy/volcengine/smoke-test.sh`

## 6. 可选：绑定预发域名
1. 建议绑定 `staging.qjgroup.top` 到 Railway。
2. DNS 建议使用 CNAME 到 Railway 提供的目标。

## 7. 重要说明
- Railway 预发用于快速验证功能，不等同于中国大陆长期稳定可用。
- 若 `*.up.railway.app` 在大陆链路受限，换自定义域名通常不能从根本解决可达性。
- 生产环境建议继续使用火山引擎中国大陆源站。
- 异步任务要稳定可追踪，必须启用 Redis 持久化队列；建议 `Replicas=1`，避免多副本下本地临时文件不可见带来的转写失败。
