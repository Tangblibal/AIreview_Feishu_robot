# Railway 控制台点击清单（预发）

## A. 创建项目
1. 打开 Railway 控制台首页。
2. 点击右上角 `New Project`。
3. 点击 `Deploy from GitHub repo`。
4. 选择你的仓库（本项目）。
5. 等待首次构建结束。
6. 回到项目主页，点击 `New` -> `Database` -> `Add Redis`。

## B. 填 Variables
1. 进入项目后，点击左侧服务卡片。
2. 点击顶部 `Variables`。
3. 打开本仓库文件 `deploy/railway/variables.min.example`。
4. 按键值逐条粘贴到 Railway Variables。
5. 确认：
   - `REVIEW_JOB_STORE_BACKEND=redis`
   - `REDIS_URL=${{Redis.REDIS_URL}}`

## C. 回填公网域名
1. 在服务页面点击 `Settings`。
2. 找到 `Networking` 区域。
3. 复制默认域名（格式一般是 `https://<service>.up.railway.app`）。
4. 回到 `Variables`，更新：
   - `STT_DOUBAO_ASR_2_PUBLIC_BASE_URL`
5. 保存后触发 redeploy。

## D. 验收
1. 打开 `Deployments`，确认最新部署 `Success`。
2. 在本地终端执行：
   `curl -i https://<service>.up.railway.app/api/health`
3. 上传音频跑通复盘：
   `BASE_URL=https://<service>.up.railway.app AUDIO_FILE=/path/demo.m4a ./deploy/volcengine/smoke-test.sh`
4. `Settings` 里确认 `Replicas=1`，避免异步任务在多副本间切换导致临时文件不可见。
