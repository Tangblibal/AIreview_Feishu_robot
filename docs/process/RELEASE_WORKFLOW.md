# 研发与发布规范（稳定运行 + 新功能迭代）

## 1. 目标

- 保证生产环境 `app.qjgroup.top` 稳定可用。
- 支持新功能在预发环境充分验证后再进入生产。
- 发生问题时可在分钟级回滚。

## 2. 环境职责

- 生产环境：火山引擎 ECS，域名 `app.qjgroup.top`，仅发布 `main`。
- 预发环境：Railway，域名建议 `staging.qjgroup.top`，用于联调与验收。

## 3. 分支策略

- `main`：生产稳定分支，禁止直接提交。
- `develop`：预发集成分支，所有功能先合入该分支。
- `feature/<name>`：单个功能开发分支。
- `hotfix/<name>`：生产紧急修复分支。

## 4. 日常功能迭代流程

1. 从 `develop` 拉取并创建功能分支。
2. 本地开发并通过测试。
3. 提交 PR 到 `develop`，在预发完成验收。
4. 预发验收通过后，提交 PR：`develop -> main`。
5. 合并 `main` 后执行生产发布。
6. 发布后执行健康检查与冒烟测试。

### 4.1 功能开发命令

```bash
git checkout develop
git pull --ff-only origin develop
git checkout -b feature/<feature-name>

# 开发完成后
npm test
git add -A
git commit -m "feat: <short description>"
git push -u origin feature/<feature-name>
```

### 4.2 预发验收命令

```bash
curl -i https://staging.qjgroup.top/api/health
BASE_URL=https://staging.qjgroup.top AUDIO_FILE=/path/demo.m4a ./deploy/volcengine/smoke-test.sh
```

> 如果你的 Railway 预发域名还不是 `staging.qjgroup.top`，替换为实际可访问域名。

### 4.3 生产发布命令（ECS）

```bash
cd /opt/qjgroup-ai-review
APP_DIR=/opt/qjgroup-ai-review SERVICE_NAME=lumo-review BRANCH=main ./deploy/volcengine/deploy.sh
```

发布后立即验证：

```bash
curl -i https://app.qjgroup.top/api/health
BASE_URL=https://app.qjgroup.top AUDIO_FILE=/path/demo.m4a ./deploy/volcengine/smoke-test.sh
```

## 5. 标签与版本约定

- 每次生产发布前在 `main` 打标签：`vYYYY.MM.DD.N`，例如 `v2026.03.01.1`。
- 标签必须对应“已通过预发验收”的提交。

打标签示例：

```bash
git checkout main
git pull --ff-only origin main
git tag v2026.03.01.1
git push origin v2026.03.01.1
```

## 6. 回滚流程（生产故障）

### 6.1 回滚原则

- 优先回滚到“最近一个稳定 tag”。
- 回滚后先恢复服务可用，再做问题复盘。

### 6.2 回滚命令（ECS）

```bash
cd /opt/qjgroup-ai-review
git fetch --all --tags --prune
git checkout <stable-tag-or-commit>
npm ci --omit=dev
sudo systemctl daemon-reload
sudo systemctl restart lumo-review
sudo systemctl --no-pager --full status lumo-review | sed -n '1,40p'
```

回滚后立即验证：

```bash
curl -i https://app.qjgroup.top/api/health
BASE_URL=https://app.qjgroup.top AUDIO_FILE=/path/demo.m4a ./deploy/volcengine/smoke-test.sh
```

## 7. 风险控制要求

- 新功能默认通过开关控制（feature flag），生产默认关闭。
- 大改动拆分为多次小发布，避免一次性高风险上线。
- 涉及数据结构变更时采用向后兼容迁移策略。
- 每个 PR 必须提供回滚点（tag 或 commit）。

## 8. Hotfix（线上紧急修复）

1. 从 `main` 切 `hotfix/<name>`。
2. 最小改动修复并验证。
3. 合并到 `main` 后立即发布生产。
4. 将相同修复回合并到 `develop`，避免分支漂移。

## 9. 发布负责人检查清单

- [ ] 本次发布对应 PR 已在预发验收通过。
- [ ] 生产发布前已创建回滚标签。
- [ ] 发布后 `/api/health` 正常。
- [ ] 发布后 smoke-test 通过。
- [ ] 记录发布时间、发布人、版本号、回滚点。
