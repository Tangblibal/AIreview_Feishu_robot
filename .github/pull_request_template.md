## 变更类型

- [ ] Feature（新功能）
- [ ] Fix（缺陷修复）
- [ ] Refactor（重构）
- [ ] Chore（非功能性改动）
- [ ] Hotfix（线上紧急修复）

## 变更说明

<!-- 说明本次改动做了什么，以及为什么要做 -->

## 影响范围

- [ ] 前端页面
- [ ] 后端 API
- [ ] 异步任务/队列
- [ ] 配置或环境变量
- [ ] 部署流程

## 风险与控制

- 风险等级：`低 / 中 / 高`
- 主要风险：
- 控制措施（如 feature flag、灰度开关、降级方案）：

## 测试与验收

- [ ] 本地测试通过（示例：`npm test`）
- [ ] 预发健康检查通过（`/api/health`）
- [ ] 预发 smoke-test 通过（`deploy/volcengine/smoke-test.sh`）

预发地址：

健康检查结果（关键输出）：

smoke-test 结果（关键输出）：

## 发布信息（必填）

- 计划发布分支：`develop -> main`
- 计划发布时间：
- 发布命令：
  - `APP_DIR=/opt/qjgroup-ai-review SERVICE_NAME=lumo-review BRANCH=main ./deploy/volcengine/deploy.sh`

## 回滚信息（必填）

- 稳定回滚点（tag 或 commit）：
- 回滚命令：
  - `git fetch --all --tags --prune`
  - `git checkout <stable-tag-or-commit>`
  - `npm ci --omit=dev`
  - `sudo systemctl restart lumo-review`

## Checklist

- [ ] 已阅读并遵循 `docs/process/RELEASE_WORKFLOW.md`
- [ ] 已评估是否需要新增/更新环境变量
- [ ] 若为 hotfix，已计划回合并到 `develop`
