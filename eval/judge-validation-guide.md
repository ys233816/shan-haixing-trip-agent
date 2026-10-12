# 评委校验流程 v1

日期：2026-10-12。本阶段获准改进本地流程，不调用模型。原始输入、人工分、裁定、v1.0/v1.1机评及规则未修改。评分口径沿用rubric.md与v1.1补充；v1.2改变证据协议与辅助材料，不新增正确答案。

## 三道检查

|检查|实现|遇到问题|
|---|---|---|
|引用来源|程序从输入生成证据目录，模型只选ID；程序还原真实路径和原文|未知ID、改动原文或不合Schema：硬失败，不入正式一致率|
|数据核对|提取最终日程、移除名单、前后保留/新增/移除、收费原文与预算原值|辅助评委逐项核验；不推算票价，不提供分数|
|判定复核|对暂停后仍有时段、严重天气与安全标记矛盾、收费参考与零已知门票、通过理由承认缺失给出信号|进入人工队列，不自动改分、不自动判关键失败|

保留模型原始返回、原始review_required，以及本地effective_review_required。两者分开；不能把本地复核信号冒充模型主动发现问题。materialized判断只还原引用，其他字段不改变。

## 本地审计的结果

对旧v1.1六条做检查，B07、A01、A08、A09进入人工队列：

- B07、A08：已有数值票价描述，预算仍全未知且已知门票为0；需要核对是否有季节/票种或过期信息等合理解释。
- A01：6处引用错误；D2理由承认只满足部分条件，分数仍为1。
- A09：两个已声明移除的景点仍有可见时段，严重天气场景下关键失败却为否，需要安全复核。植物园实际已移除，没有把三处全部误记仍在行程。

B09、A03没有被本地规则拦截，但两条仍有已知机评分歧。这说明校验器覆盖有限：备选是否适用、隐含约束和细致取舍仍需要模型与人工判断。未拦截不等于评分正确。

队列详情见`judge-audits/2026-10-12-validation-v1/report.md`。这是离线审计，不是新一轮机器评分，没有新的四维/检查点一致率。软信号可能误报；严重天气词匹配、费用金额词匹配不理解全部否定、季节和资格条件，因此只送复核。

## 操作命令

使用本机Node：

```powershell
& 'C:/Users/17330/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' 'eval/prepare-judge-v1.2.cjs'
& 'C:/Users/17330/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' --test 'eval/judge-validation.test.cjs'
```

准备脚本无网络能力，不读取.env或人工标签。保存全量case_evidence、证据ID目录、derived_observations、wire-schema及有效系统消息。source_manifest验证原始输入，准备manifest记录输入及流程哈希。重复运行只允许内容完全相同，不覆写发生变化的记录。

未来收到模型的wire JSON后，本地校验命令为：

```powershell
& 'C:/Users/17330/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' 'eval/validate-judge-response.cjs' A09 '模型返回文件.json' 'eval/新的校验结果.json'
```

程序核对原始输入、准备文件和流程哈希，整段JSON解析、证据ID还原、原Schema及原文检查，再输出硬错误、软复核和effective_review_required。输出文件必须为工作区内新文件，不能覆盖旧结果。

## 下一阶段如何统计

下一次真实回归需要按分步流程再次授权，使用v1.2准备的system-message、输入和wire Schema，统一模型参数，保存原始返回及解码关联，不复用旧评分。API runner尚未接入v1.2，本阶段已经实现准备与本地响应校验入口。

应同时报告：请求总数、硬有效数、待复核数、自动接受数、模型原始分与人工一致率，以及完成复核后的结果。待复核不记为0或通过。已有效但待复核的机评可列入诊断比较，但不能当成已获认可的自动基准；若只对自动接受子集统计，必须显式给分母与覆盖率，避免筛掉困难样本后误称整体提升。

当前材料以六条已知失败归纳而来，可能对该组适配。后续必须检查其他样本的漏拦截和误拦截。只完成校验流程不代表评委正确率或旅行Agent任务完成率已提高。
