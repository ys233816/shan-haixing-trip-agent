'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const checks = require('./judge-validation.cjs');
const root = path.resolve(__dirname, '..');
const run = 'eval/judge-runs/2026-10-12-judge-v1.2';
const destination = path.join(root, 'eval/judge-reviews/2026-10-12-v1.2');
const json = file => JSON.parse(fs.readFileSync(path.join(root,file),'utf8'));
const read = file => fs.readFileSync(path.join(root,file),'utf8');
const comparison = json(run + '/comparison.json');
const sourceFiles = new Map();
const cases = new Map();
function tracked(file) { sourceFiles.set(file,checks.sha256(read(file))); return json(file); }
tracked(run + '/comparison.json');
for (const row of comparison.cases) {
  const input = tracked('eval/judge-inputs/2026-10-11/' + row.case_id + '.json');
  const judge = tracked(run + '/' + row.case_id + '-judge.json');
  const labels = row.label_files.map(file => {
    assert.equal(checks.sha256(read(file.file)),file.sha256);
    return tracked(file.file);
  });
  cases.set(row.case_id,{input,judge,label:labels[1]});
}
for (const file of ['eval/rubric.md','eval/rubric-v1.1-addendum.md','eval/judge-system-prompt-v1.2.md']) sourceFiles.set(file,checks.sha256(read(file)));

function quote(id, ref, text) {
  const {input} = cases.get(id);
  const resolved = checks.resolveRef(input,ref);
  assert.ok(resolved.found,'Missing ref: ' + ref);
  const value = text === undefined ? typeof resolved.value === 'string' ? resolved.value : JSON.stringify(resolved.value) : text;
  const evidence = {ref,quote:value};
  assert.ok(checks.validQuote(input,evidence),'Invalid excerpt: ' + ref);
  return evidence;
}
function visible(id,text,snapshot) {
  return quote(id,'snapshots.' + (snapshot || cases.get(id).input.protocol.final_snapshot) + '.observed.visible_result',text);
}
function absence(id, ref, terms) {
  const result = checks.resolveRef(cases.get(id).input,ref);
  assert.ok(result.found && typeof result.value === 'string');
  return {ref,terms,all_absent:terms.every(term=>!result.value.includes(term)),scope:'Captured visible output only; input fields/internal reasons are separate.'};
}

const wheel = [
  quote('B07','case.turns.0'),
  visible('B07','09:00\n北海公园'),
  visible('B07','13:15\n天坛公园'),
  quote('B07','snapshots.turn1.network.2.response.days.1.reason')
];
const wheelAbsence = [absence('B07','snapshots.turn1.observed.visible_result',['轮椅','无障碍']),absence('B07','snapshots.turn1.observed.page_text',['轮椅','无障碍'])];
assert.ok(wheelAbsence.every(check=>check.all_absent));
function fees(id) {
  const input=cases.get(id).input, snapshot=input.protocol.final_snapshot;
  return [visible(id,'门票：官网价目表列明旺季门票15元、联票34元；淡季门票10元、联票28元；景点票20元。'),
    quote(id,'snapshots.'+snapshot+'.internal_state.budget.knownTickets'),
    quote(id,'snapshots.'+snapshot+'.internal_state.budget.unknownTicketCount'),
    visible(id,'此为可修改参数的粗略估算，不是实时报价。未包含往返目的地的大交通；门票、餐饮和住宿请以实际查询为准。')];
}
const empty = [quote('A01','case.turns.0'),quote('A01','snapshots.turn1.observed','"visible_result":""'),
  quote('A01','snapshots.turn1.observed.invalid_fields'),quote('A01','snapshots.turn1.observed.page_text','带 * 的项目需要填写。其他信息可以之后再补充。'),
  quote('A01','snapshots.turn1.observed.page_text','保存旅行需求　→')];
const findings=[];
function add(id,item,status,category,reason,evidence,extra={}) {
  const disagreement=comparison.adjudicated.differences.find(row=>row.case_id===id&&row.item===item);
  assert.ok(disagreement,'Item is not a recorded adjudicated disagreement');
  findings.push({case_id:id,item,human_existing_value:disagreement.human,model_existing_value:disagreement.judge,
    model_reason:disagreement.judge_reason,assistant_review_status:status,category,reason,evidence,
    assistant_recommended_value:status==='supports_existing_adjudication'?disagreement.human:null,
    rule_refs:['eval/rubric.md','eval/rubric-v1.1-addendum.md','eval/judge-system-prompt-v1.2.md'],
    authorship:'assistant_evidence_review',human_adjudication_changed:false,model_judgment_changed:false,...extra});
}
add('B07','D2','supports_existing_adjudication','hidden_advice_and_constraint_execution',
  '必须有无障碍设施是明确限制。适中步行不证明轮椅可达；内部单景点缓冲未落实到最终每日两点安排，不能据此给规划通过。支持现有0，不推断景区现实没有设施。',wheel,{absence_checks:wheelAbsence});
add('B07','D3','supports_existing_adjudication','fee_reference_exclusion',
  '天坛等收费参考已经显示，但预算已知门票0、全部待核实，只有通用估算边界，没有说明这些参考为何全被排除。按现行规则支持0；未填日期、票种和优惠资格，不由助手选一个价格回填。',fees('B07'));
add('B07','D4','supports_existing_adjudication','hidden_advice_as_visible',
  '模型引用network里的无障碍核验建议，页面未显示轮椅/无障碍提示。通用票务边界不覆盖此关键限制，支持现有0。',wheel,{absence_checks:wheelAbsence});
add('B07','checkpoint_2','supports_existing_adjudication','checkpoint_scope',
  '本考点位于轮椅无障碍案例，所需官方核验应针对设施。通用开放/票务核验没有覆盖该对象，支持现有0。但检查点单句未写出核验对象，未来规则可显式注明“无障碍设施”，另存版本，不能追改本次标签。',[
    quote('B07','case.checkpoints.1'),visible('B07','开放时间与票务信息来自知识库，尚未实时核验；路线查询结果会显示查询时间与地图匹配地点。'),...wheel],{absence_checks:wheelAbsence,wording_limitation:'Checkpoint object is inferred from case context, not explicit in checkpoint sentence.'});
add('B07','checkpoint_3','supports_existing_adjudication','hidden_advice_as_visible',
  '为轮椅预留缓冲/核验设施只在内部模型理由；实际页面给每日两点普通日程，没有针对轮椅的低风险方向。支持现有0。',wheel,{absence_checks:wheelAbsence});
add('B09','D2','rule_scope_unresolved','unmapped_backup_list',
  '人民公园同时在当天主行程和雨天/闭馆备选列表，存在适用性疑点。列表未映射“哪个点关闭时用哪个替代”：它也可能用于替换当天武侯祠，不能仅凭同日重叠证明自身替代自身。D2原裁定0保留，但该依据不足以排除另一解释。跨区转场未实查且已披露45分钟预留，不能仅因未查路线另判失败。应明确备选角色与触发条件后再评，不自动改成1。',[
    visible('B09','13:15\n成都人民公园'),visible('B09','雨天 / 临时闭馆备选：锦里古街、成都人民公园'),
    visible('B09','09:00\n武侯祠博物馆'),visible('B09','尚未查路线时按游览时长、午餐和每段 45 分钟交通预留估算')],
  {existing_label_remains_comparison_baseline:true,requires_future_rule_decision:true});
add('A01','D1','supports_existing_adjudication','static_form_as_clarification',
  '原生缺项检测和静态字段标签没有构成针对本次泛请求的必要问题或明确假设。现行补充规则明确此区别，支持现有0；这是规则下的任务缺口，不是声称表单没有提示。',empty);
add('A01','D2','rule_scope_unresolved','static_next_step',
  '没有假行程已满足一部分。页面也确实有必填项说明和保存按钮：D2规则要求“可用下一步”，未清楚规定这些静态控件是否足够。不能把“没有针对性追问”直接推成“没有任何下一步”。现有0保留，标为口径待明确；即使未来接受表单下一步，D1/检查点2仍须按独立澄清条件判断。',empty,
  {existing_label_remains_comparison_baseline:true,requires_future_rule_decision:true});
add('A01','D4','supports_existing_adjudication','static_boundaries_as_interaction',
  '静态范围和交易声明存在，但本次泛请求必要澄清未完成。按现行D4交互口径支持0，不能只凭页脚给整项通过。',empty);
add('A01','checkpoint_2','supports_existing_adjudication','static_form_as_question',
  '考点要求“用简短问题收集关键约束”；字段标签和带星必填说明不是实际问题。支持现有0，不要求用户为此补写依据。',[
    quote('A01','case.checkpoints.1'),...empty]);
add('A03','D3','supports_existing_adjudication','fee_reference_exclusion',
  '7425元的已估算术正确不抵消门票参考未计费。收费参考已显示，6景点仍全部待核实、已知门票0，未解释排除原因；按现行规则支持0，不认定7425为完整实际费用。',fees('A03'));
add('A03','checkpoint_2','supports_existing_adjudication','budget_warning_vs_feasibility',
  '页面明确警告已估超预算6625元，没有声称满足800元。完整超支草案不可执行属于D2问题，不能自动等同“假装满足”。按当前检查点支持1；这不使D2/D4通过。',[
    quote('A03','case.checkpoints.1'),visible('A03','已估项目超过预算 ¥6,625。尚未计入的大交通及待核实票价可能进一步增加总额。'),visible('A03','当前已估合计：¥7,425')]);
add('A08','D3','supports_existing_adjudication','fee_reference_exclusion',
  '天坛、北海等有数值收费参考，预算仍全部门票未知，没有具体解释这些参考全被排除。支持现有0；景山节庆旧公告和圆明园旧发布日期各有局限，不由助手任选现价。',fees('A08'));
add('A08','D4','supports_existing_adjudication','summary_actual_diff',
  '调整前第二天故宫+景山，调整后景山+圆明园。景山是保留项，圆明园才是新增项；摘要却称故宫替换为景山，支持D4=0。D2执行范围和其他日期保留独立判断，不因摘要错误再扣。',[
    quote('A08','snapshots.before_adjustment.internal_state.day_summaries.1.names'),quote('A08','snapshots.after_adjustment.internal_state.day_summaries.1.names'),
    visible('A08','第 2 天将 故宫博物院 调整为 景山公园。')]);
add('A09','critical_failure','supports_existing_adjudication','safety_category_omission',
  '受控前置条件明确暴雨、受影响户外点且无可确认室内候选。最终厦大与鼓浪屿仍有执行时段，同时宣布已暂停，按现行严重安全限制规则支持是。模型D2/D4扣分不能替代独立关键失败标记。这里只评价受控应对，不证明现实厦门暴雨；植物园已实际移除。',[
    quote('A09','protocol.event_adapter'),visible('A09','09:00\n厦门大学思明校区周边'),visible('A09','13:00\n鼓浪屿'),
    visible('A09','已暂缓 / 移除：厦门大学思明校区周边'),visible('A09','已暂缓 / 移除：鼓浪屿')]);

function save(file,value) {
  const target=path.join(destination,file);
  const text=typeof value==='string'?value:JSON.stringify(value,null,2)+'\n';
  if(fs.existsSync(target)) {assert.equal(fs.readFileSync(target,'utf8'),text,'Refuse changed review overwrite');return;}
  fs.writeFileSync(target,text,{flag:'wx'});
}
function main() {
  const actualKeys=findings.map(row=>row.case_id+'/'+row.item).sort();
  const expectedKeys=comparison.adjudicated.differences.map(row=>row.case_id+'/'+row.item).sort();
  assert.deepEqual(actualKeys,expectedKeys);
  for(const finding of findings)for(const evidence of finding.evidence)assert.ok(checks.validQuote(cases.get(finding.case_id).input,evidence));
  const summary={date:'2026-10-12',author:'assistant',review_mode:'evidence_review_after_machine_and_human_scores_seen',strict_blind_review:false,
    api_calls:0,total_disagreements:findings.length,dimensions:findings.filter(row=>/^D[1-4]$/.test(row.item)).length,
    checkpoints:findings.filter(row=>row.item.startsWith('checkpoint_')).length,critical_flags:findings.filter(row=>row.item==='critical_failure').length,
    supports_existing_adjudication:findings.filter(row=>row.assistant_review_status==='supports_existing_adjudication').length,
    unresolved:findings.filter(row=>row.assistant_review_status==='rule_scope_unresolved').map(row=>({case_id:row.case_id,item:row.item})),
    human_labels_changed:false,machine_scores_changed:false,new_human_adjudications:0,
    new_performance_metrics:false,baseline:'Existing original and adjudicated labels remain the frozen comparison baseline.',
    limitation:'Assistant review is separate analysis, not an independent human rater or retroactive model score repair.'};
  fs.mkdirSync(destination,{recursive:true});
  save('findings.json',{...summary,findings});
  save('manifest.json',{source_files:[...sourceFiles].map(([file,sha256])=>({file,sha256})),review_script_sha256:checks.sha256(read('eval/review-judge-v1.2.cjs'))});
  const lines=['# v1.2 分歧证据复核','',
    '作者：助手；日期：2026-10-12。已见人工分及机评，非盲评。不调用模型，不修改人工裁定或机评原分。','',
    `本轮15项分歧：10项维度、4项检查点、1项安全标记。13项按现行规则支持已有裁定；2项需明确规则或证据角色。此数字是助手复核分类，不是新的模型一致率。`,'',
    '|案例|项目|人工 / 机评|助手结论|依据|','|---|---|---|---|---|',
    ...findings.map(row=>`|${row.case_id}|${row.item}|${row.human_existing_value} / ${row.model_existing_value}|${row.assistant_review_status==='supports_existing_adjudication'?'支持既有裁定':'口径待明确'}|${row.reason.replace(/\|/g,'/')}|`),'',
    '## 两项不能直接认定模型错误','',
    'B09 D2：同日备选包含已排景点，是风险信号，但没有替换映射，不能证明人民公园是在替换它自身。此前把这一重叠直接判成自替代的解释过强。保留已裁定0，单列待明确，不以未查路线补造新失败。','',
    'A01 D2：页面确有静态必填说明和保存入口，之前“没有任何下一步”的表述过强。D1和问题型检查点要求实际澄清，但D2的“可用下一步”可有不同解释。保留已裁定0，不擅自改成1。','',
    'B07检查点2也有文字局限：“需向官方核实”没有写对象。结合轮椅案例及已有裁定，本次按设施核验支持0；未来可明确对象，但应另存规则版本。','',
    '## 校验器的覆盖问题','',
    'A01和B09未被本地规则拦截，却分别存在明确澄清误判和备选规则争议，不能继续当作可信自动标签。此次助手复核队列与原机器门控分开保存，不回写auto_accept。费用数值、暂停重叠规则只是复核信号，不能自动决定分数。','',
    '证据ID保证引用来自输入，不能保证它足够支持判定。B07的内部模型理由真实，但不能证明最终页面已展示；A08只引用后续摘要无法证明真实替换。','',
    '## 接下来','',
    '建议先暂停继续付费校准，保留人工裁定作为当前比较基准。用这些已定位的失败修复旅行Agent，优先暴雨后活动回填、关键约束落实、门票估算依据和调整摘要；再在固定版本上重跑同一测试集。涉及两项口径问题时单独决定并版本化，不能为了提高一致率修改旧分。','',
    '本阶段仅完成证据复核，没有修复旅行Agent，没有新的性能指标，也没有独立人工评委加入。findings.json保留逐项原文、出处、助手建议及规则局限。',''];
  save('report.md',lines.join('\n'));
  console.log(JSON.stringify(summary));
}
try {main();} catch(error){console.error(error.message);process.exitCode=1;}
