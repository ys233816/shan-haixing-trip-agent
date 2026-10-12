# 机评运行记录

## v1.1 六条回归

2026-10-12已运行。报告：`2026-10-12-judge-v1.1/report.md`；结构化比较：同目录`comparison.json`；助手复盘与同五条对照：`review-notes.md`。6次首评、5条有效、A01引用失败排除；校准未通过，A09安全漏报。无自动重试或引用修复。

v1.1入口为`run-judge.cjs --v1.1`，配置`judge-v1.1-config.json`。旧runner原样保存为`run-judge-v1.0.cjs`，旧结果未改。预检加`--preflight`无网络、无写入；本地重算加`--report`不调用模型，但会重写v1.1派生报告。不要用新Prompt复写旧结果。

## v1.0 历史运行

v1.0最终入口：`2026-10-12-judge-v1-repair2/report.md`。结构化比较是同目录 `comparison.json`；助手复盘是 `review-notes.md`。实际每条结果的目录见comparison.json中的`cases[].result_directory`，不要只查看最后一次请求目录。

首次六条机评和每次重试分别保存：

- `2026-10-12-judge-v1`：六条首轮及不完整的首轮比较。
- `2026-10-12-judge-v1-retry1`：五条无效结果重试，关闭思考。
- `2026-10-12-judge-v1-repair1`：四条仅引用修复。
- `2026-10-12-judge-v1-repair2`：A01仅引用修复及最终合并报告。

报告本地重算，不调用模型：

```powershell
& 'C:/Users/17330/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' 'D:/tripplan agent/eval/run-judge.cjs' --repair-final --report
```

只检查配置、输入哈希和Schema，不调用模型：

```powershell
& 'C:/Users/17330/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' 'D:/tripplan agent/eval/run-judge.cjs' --preflight
```

校验依赖在 `eval/package.json` 中，通过 `npm install --prefix eval --ignore-scripts --no-audit --no-fund` 安装。评委使用现有.env中的模型配置；程序只输出模型名和配置状态，不输出API Key。

新Prompt回归应创建新的运行目录并记录规则版本。run-judge.cjs默认仍为v1.0，显式--v1.1选择独立配置和目录；不能让新Prompt结果混入旧报告。涉及新的模型调用时先按当前分步流程确认下一阶段。
