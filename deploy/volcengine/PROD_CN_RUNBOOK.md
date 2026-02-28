# 国内生产上线手册（火山引擎 ECS）

适用目标：
- 中国大陆长期稳定访问
- 域名：`app.qjgroup.top`
- 单机先上线，后续可再做高可用

## 0. 前置准备

你需要准备好：
- ECS 公网 IP（Linux，建议 Ubuntu 22.04）
- 域名 `qjgroup.top` 的 DNS 管理权限
- 真实环境变量：DeepSeek、ASR、TOS

说明：
- `/api/review` 现已采用 TOS-only 上传策略：音频先上传到 TOS，再进入复盘流程。
- 服务器本地仅会有上传过程的临时文件，并在请求处理后自动删除。

## 1. DNS 解析

在火山引擎 DNS 控制台新增：
- 记录类型：`A`
- 主机记录：`app`
- 记录值：`<ECS公网IP>`

等待生效后执行：

```bash
dig +short app.qjgroup.top
```

应返回你的 ECS 公网 IP。

## 2. 服务器初始化

在 ECS 执行：

```bash
sudo apt update
sudo apt install -y nginx redis-server git curl
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

node -v
npm -v
sudo systemctl enable --now redis-server
sudo systemctl status redis-server --no-pager
```

## 3. 拉代码并安装依赖

```bash
sudo mkdir -p /opt/qjgroup-ai-review
sudo chown -R $USER:$USER /opt/qjgroup-ai-review
cd /opt/qjgroup-ai-review
git clone <你的Git仓库URL> .
npm ci --omit=dev
```

## 4. 配置环境变量

```bash
sudo cp /opt/qjgroup-ai-review/deploy/volcengine/lumo-review.env.example /etc/lumo-review.env
sudo nano /etc/lumo-review.env
```

至少确认这些字段：
- `REVIEW_JOB_STORE_BACKEND=redis`
- `REDIS_URL=redis://127.0.0.1:6379/0`
- `ACTIVE_PROVIDER=deepseek`
- `DEEPSEEK_API_KEY=...`
- `STT_DOUBAO_ASR_2_APP_ID=...`
- `STT_DOUBAO_ASR_2_ACCESS_TOKEN=...`
- `STT_DOUBAO_ASR_2_PUBLIC_BASE_URL=https://app.qjgroup.top`
- `TOS_ENABLED=true`

## 5. 配置 systemd 服务

```bash
sudo cp /opt/qjgroup-ai-review/deploy/volcengine/lumo-review.service /etc/systemd/system/lumo-review.service
sudo systemctl daemon-reload
sudo systemctl enable --now lumo-review
sudo systemctl status lumo-review --no-pager
```

看日志：

```bash
journalctl -u lumo-review -f
```

应看到：
- `Server running at http://localhost:3000`
- `[review_job_queue] mode=async store=redis`

## 6. 配置 Nginx

```bash
sudo cp /opt/qjgroup-ai-review/deploy/volcengine/nginx.app.qjgroup.top.conf /etc/nginx/conf.d/app.qjgroup.top.conf
sudo nginx -t
sudo systemctl reload nginx
```

本机验证：

```bash
curl -i http://127.0.0.1:3000/api/health
curl -i http://app.qjgroup.top/api/health
```

## 7. 配置 HTTPS

推荐 `certbot`：

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d app.qjgroup.top
```

验证：

```bash
curl -i https://app.qjgroup.top/api/health
```

## 8. 异步任务验收（生产口径）

在本地终端执行：

```bash
BASE_URL="https://app.qjgroup.top"
AUDIO_FILE="/path/demo.m4a"

submit=$(curl -s -X POST "$BASE_URL/api/review?mode=async" -F "audio=@$AUDIO_FILE" -F "templates=[]")
echo "$submit"
job_id=$(echo "$submit" | sed -n 's/.*"job_id":"\([^"]*\)".*/\1/p')
echo "job_id=$job_id"

for i in {1..120}; do
  out=$(curl -s "$BASE_URL/api/review/jobs/$job_id")
  echo "$out"
  state=$(echo "$out" | sed -n 's/.*"status":"\([^"]*\)".*/\1/p')
  if [ "$state" = "succeeded" ] || [ "$state" = "failed" ]; then break; fi
  sleep 3
done
```

## 9. 发布/更新命令

```bash
cd /opt/qjgroup-ai-review
APP_DIR=/opt/qjgroup-ai-review SERVICE_NAME=lumo-review BRANCH=main ./deploy/volcengine/deploy.sh
```

## 10. 常见问题

- `store=memory`：
  - 检查 `/etc/lumo-review.env` 的 `REVIEW_JOB_STORE_BACKEND` 和 `REDIS_URL`
  - 重启：`sudo systemctl restart lumo-review`

- 异步一直 `processing`：
  - 查应用日志：`journalctl -u lumo-review -f`
  - 搜 `review_job_finish` 看是否已完成但前端轮询失败

- 502/503：
  - 检查 Nginx 与应用状态：
    - `sudo systemctl status nginx --no-pager`
    - `sudo systemctl status lumo-review --no-pager`
