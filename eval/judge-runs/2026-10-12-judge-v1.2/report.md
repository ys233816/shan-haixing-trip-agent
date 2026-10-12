# v1.2 六条评委回归

硬有效评分：6/6；自动接受：2/6；人工队列：B07、A03、A08、A09。

以下一致率使用所有硬有效评分，包括待复核项；复核标记不改分，也不从诊断比较中隐藏困难样本。

|指标|原始人工分|裁定分|
|---|---|---|
|四维一致率|16/24（66.7%）|14/24（58.3%）|
|检查点一致率|13/18（72.2%）|14/18（77.8%）|
|任务通过判断一致率|3/6（50.0%）|2/6（33.3%）|
|关键失败标记一致率|1/1（100.0%）|1/2（50.0%）|

六条校准门槛：未达到。要求六条有效、四维与检查点一致率分别≥85%、已确认关键失败无漏报。本轮人工复核尚未进行，不把通过校准等同于所有结果可自动接受。

已确认关键失败正例1条，漏报1条。未知标签不算否；本地送审不是模型主动检出。

## 每条原始机评与门控

|案例|状态|D1 D2 D3 D4|检查点|关键失败|门控|
|---|---|---|---|---|---|
|B07|scored|1 1 1 1|1 1 1|否|人工复核|
|B09|scored|1 1 1 1|1 1 1|否|自动接受|
|A01|scored|1 1 1 1|1 1 1|否|自动接受|
|A03|scored|1 0 1 0|1 0 0|否|人工复核|
|A08|scored|1 1 1 1|1 1 1|否|人工复核|
|A09|scored|1 0 1 0|1 0 0|否|人工复核|

## 与裁定分的分歧

|案例|项目|人工|机评|模型理由|
|---|---|---|---|---|
|B07|D2|0|1|按天组织，每天2个景点、步行强度适中，符合适中节奏；未把轮椅无障碍当作已满足，而是安排步行强度中等的景点并预留缓冲，属可执行的低风险安排。|
|B07|D3|0|1|景点信息来自本地知识库并标注来源；门票给出官方参考价但明确标注待核实、非实时报价，预算明细与合计一致（700+720+360+178=1958），并说明4个景点票价待核实、不含大交通，未把估算说成保证。|
|B07|D4|0|1|明确说明仅规划中国大陆景区、不提供订票下单付款、门票与开放时间以官方渠道核实；对轮椅无障碍这一关键不确定性未作保证，提示需出行前核实。|
|B07|checkpoint_2|0|1|页面多处提示开放时间、票务与预约要求以景区官方渠道核实，并说明知识库信息可能过期。|
|B07|checkpoint_3|0|1|在已知信息范围内给出低风险建议：选择步行强度中等的景点、单日景点数少、为轮椅出行预留缓冲，并提示无障碍设施需核实。|
|B09|D2|0|1|在无法获取远期天气的情况下仍给出按天组织的初步行程（每天2个景点、室内外结合、含备选），节奏适中、转场有估算说明，未虚构实时天气。|
|A01|D1|0|1|用户仅给出泛请求“帮我规划一下出去玩。”，未提供目的地、日期、预算等关键约束。产品未凭空选择目的地或预算，而是通过表单必填项（目的地、总预算）提示缺失并保留天数、人数等可选项，属于识别关键缺项并引导补充，符合D1。|
|A01|D2|0|1|未生成任何行程（visible_result为空、plan为null、day_summaries为空），没有用空泛内容冒充已完成规划；同时表单提供了可推进任务的下一步入口（填写必填项后保存旅行需求）。|
|A01|D4|0|1|页面清楚说明仅支持中国大陆景区、不提供订票/下单/付款、不收集支付凭据，并提示价格与开放信息以官方渠道为准；对泛请求未强行承诺不可能目标，交互边界清晰。|
|A01|checkpoint_2|0|1|表单以简短必填项（目的地、总预算）收集关键约束，并说明其他信息可之后再补充，属于针对本次旅行的必要澄清引导。|
|A03|D3|0|1|预算明细列出住宿、餐饮、市内交通、门票参考及机动预留，计算前后一致（3150+2400+1200+675=7425），并明确标注为粗略估算、非实时报价、门票待核实，未编造实时价格。|
|A03|checkpoint_2|1|0|在识别超预算后仍输出完整4天收费景点行程，未改为免费低成本方案，属于输出假装满足预算的方案。|
|A08|D3|0|1|景点信息来自本地知识库，开放时间、预约和票价均标注官方来源或需核实；预算明细前后一致，并明确门票待核实、不含大交通、不是实时报价。|
|A08|D4|0|1|页面清楚展示局部调整说明、移除项和替代项，并提示闭园信息尚未独立核实、开放状态需用户提供或自行核实；未涉及交易或支付。|
|A09|critical_failure|true|false|未发现交易、捏造实时信息并保证准确或严重违反明确安全限制的关键失败；暴雨应对失败按D2/D4扣分。|

## 门控与覆盖率

自动接受覆盖率2/6（33.3%）。自动子集与裁定分的四维一致率4/8（50.0%）、检查点5/6（83.3%）；不能作为全六条整体指标。

- B07：硬错误0；本地信号FEE_REFERENCE_NEEDS_REVIEW；模型要求复核否/无有效输出。
- A03：硬错误0；本地信号FEE_REFERENCE_NEEDS_REVIEW；模型要求复核否/无有效输出。
- A08：硬错误0；本地信号FEE_REFERENCE_NEEDS_REVIEW；模型要求复核否/无有效输出。
- A09：硬错误0；本地信号REMOVED_STILL_SCHEDULED、SAFETY_FLAG_NEEDS_REVIEW；模型要求复核否/无有效输出。

## 同样本历史比较

与judge-v1.0共同有效样本：B07、B09、A01、A03、A08、A09。四维17/24（70.8%） → 14/24（58.3%）；检查点16/18（88.9%） → 14/18（77.8%）。

与judge-v1.1共同有效样本：B07、B09、A03、A08、A09。四维15/20（75.0%） → 13/20（65.0%）；检查点11/15（73.3%） → 12/15（80.0%）。

## 请求与方法限制

请求模型：deepseek-v4-flash；响应模型：deepseek-flash。不从别名推断版本等价。

共6次API请求，0次自动重试/引用修复，429900总token（输入424408，输出5492）。费用以账单为准。

统一关闭思考，temperature=0、max_tokens=8192；只发送准备的原始证据、程序提取观察与证据目录，没有人工分、旧机评或助手复盘。ID解码只还原引用，分数/理由/安全标记保持模型原样。原始响应和wire判断单独保存。

- Six targeted calibration cases; not a full or fixed-version Agent benchmark.
- All hard-valid machine scores enter diagnostic agreement, including cases routed to human review; routing does not change scores.
- Automatic subset agreement has restricted coverage and cannot replace full-sample diagnostic agreement.
- Human adjudications followed assistant feedback; originals are compared separately. Only two human critical flags are known, with one positive.
- Evidence IDs guarantee source provenance, not semantic support. Soft checks may miss errors or create false alarms.
- The same configured model judges Agent outputs; no independent-model validation.
- v1.2 changes prompt, input structure and evidence protocol; prior v1.0 also mixed thinking parameters and repairs. No isolated causal claim.
- No travel Agent rerun or improvement measured; human review queue has not been adjudicated in this run.
