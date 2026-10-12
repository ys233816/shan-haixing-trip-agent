# 评测记录

本目录保存项目开发期间的测试定义、评分口径、人工复核、评委 Prompt 和受控回归结果。运行应用只需要根目录的 Node.js 服务；评测工具有独立依赖。

## 文件导航

- `test-cases.json`：36 条典型、边界、对抗场景及历史证据、评分。
- `rubric.md`：四个评分维度、四层链路和各样本检查点的 0/1 判定。
- `baseline-report.md`、`baseline-metrics.json`：混合历史版本基准，不能称为冻结的 V1。
- `human-review/`：人工复核材料与裁定记录。
- `judge-system-prompt*.md`：历次评委 Prompt。
- `judge-validation.cjs`、`judge-output.schema.json`：输出结构与证据校验。
- `judge-runs/`、`judge-reviews/`：机评结果及分歧复核。
- `agent-regressions/`：天气、规划、预算、偏好、澄清等专项的前后证据、指标与报告。

## 结果口径

各专项报告记录固定样本、前后通过数、版本文件哈希和限制。受控函数或浏览器回放会关闭模型调用，不能证明真实大模型、天气和路线服务的端到端成功率。部分测试使用合成景点，部分回放使用历史检索结果。

六条机评样本与人工评分的校准结果仍未达标；天气旧套件保留 11/12 的结果及 R12 预期冲突。未测量 pass^5，也没有独立的新样本验收。请勿将不同专项直接拼成全量任务完成率。

## 运行与留存

安装评委校验依赖并运行结构测试：

```powershell
cd eval
npm ci
node --test judge-validation.test.cjs
```

历史回归脚本保存的是开发时的运行方式：部分浏览器脚本依赖本机 Codex 的 Playwright 路径和 Microsoft Edge，需要按运行环境调整。`before/after` 脚本会保护已有证据，目标目录已存在时拒绝覆盖；重跑应在独立副本中使用新的输出目录。不要直接将保留的历史快照覆盖成新版本。

机评运行需要根目录 `.env` 中的模型配置，会消耗模型 API 额度。先阅读 `judge-guide.md` 和 `judge-validation-guide.md` 再运行；历史材料中的绝对路径仅代表当时环境。

仓库保留 JSON、Markdown 和 HTML 快照证据；PNG 截图、个人文档、依赖目录和日志仅在本机留存。若报告引用了未随仓库发布的截图，公开核查应优先依据 JSON 记录及版本快照。
