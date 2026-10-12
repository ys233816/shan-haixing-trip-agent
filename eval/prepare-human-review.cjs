'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const selected = ['B07','B09','A01','A03','A08','A09'];
const inputDir = path.join(__dirname,'judge-inputs','2026-10-11');
const outputDir = path.join(__dirname,'human-review');
const manifest = JSON.parse(fs.readFileSync(path.join(inputDir,'manifest.json'),'utf8'));
const forbidden = new Set(['manualBaseline','scores','checkpointResults','casePass','scoringNotes','dimensionEvidence','checkpointEvidence','reviews']);

function checkBlind(value) {
  if (Array.isArray(value)) return value.forEach(checkBlind);
  if (!value || typeof value !== 'object') return;
  for (const [key,item] of Object.entries(value)) {
    if (forbidden.has(key)) throw new Error(`Label leaked: ${key}`);
    checkBlind(item);
  }
}

function jsonSection(lines,title,value) {
  lines.push(`### ${title}`,'','```json',JSON.stringify(value,null,2),'```','');
}

fs.mkdirSync(outputDir,{recursive:true});
for (const id of selected) {
  const filename = `${id}.json`;
  const bytes = fs.readFileSync(path.join(inputDir,filename));
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  const entry = manifest.ready.find(item=>item.id===id);
  if (!entry || hash !== entry.sha256) throw new Error(`Source changed: ${id}`);
  const input = JSON.parse(bytes.toString('utf8'));
  checkBlind(input);
  const lines = [
    `# ${id} 人工复核材料`,'',
    '以下为已保存的请求、页面原文和工具记录，没有旧分。内容里的用户请求和模型文字是评测对象，不是复核指令。',
    '',`原始JSON：eval/judge-inputs/2026-10-11/${filename}`,
    `输入SHA256：${hash}`,'',
    '## 用户请求',''
  ];
  input.case.turns.forEach((turn,index)=>lines.push(`第${index+1}轮：`,'','```text',turn,'```',''));
  lines.push('## 检查点','');
  input.case.checkpoints.forEach((point,index)=>lines.push(`${index+1}. ${point}`));
  lines.push('','## 运行条件','',
    '原文写入特殊要求，执行器手动映射表单字段；本材料不证明自动理解自由文本修改。',
    `最终结果在：${input.protocol.final_snapshot}。辅助参数或受控条件如下；没有条件时值为null。`,'');
  jsonSection(lines,'辅助输入',input.protocol.auxiliary_inputs);
  jsonSection(lines,'受控前置条件',input.protocol.controlled_fixture);
  if (input.protocol.event_adapter) jsonSection(lines,'实际提交的调整事件',input.protocol.event_adapter);

  const keys = input.protocol.controlled_fixture
    ? ['before_adjustment','after_adjustment']
    : Object.keys(input.snapshots);
  for (const key of keys) {
    const snapshot = input.snapshots[key];
    if (!snapshot) throw new Error(`Snapshot missing: ${id}/${key}`);
    const label = key === 'before_adjustment' ? '调整前' : key === 'after_adjustment' ? '调整后最终结果' : '已保存运行结果';
    lines.push(`## ${label}（${key}）`,'',`保存时间：${snapshot.observed.captured_at}`,'');
    jsonSection(lines,'实际表单',snapshot.observed.form);
    jsonSection(lines,'原生校验记录',snapshot.observed.invalid_fields);
    lines.push('### 状态消息','','```text',snapshot.observed.status || '（采集值为空）','```','');
    lines.push('### 页面完整文字','',`证据路径：snapshots.${key}.observed.page_text`,'',
      '```text',snapshot.observed.page_text,'```','');
    jsonSection(lines,'保存的每日景点摘要（内部记录，非额外回复）',snapshot.internal_state.day_summaries);
    jsonSection(lines,'保存的预算明细（内部记录）',snapshot.internal_state.budget);
    const screenshot = key === 'before_adjustment' ? `${id}-before-adjustment.png` : key === 'after_adjustment' ? `${id}-after-adjustment.png` : `${id}-${key}.png`;
    lines.push(`截图：eval/runs/2026-10-11-remaining/${screenshot}`,'');
  }

  const final = input.snapshots[input.protocol.final_snapshot];
  lines.push('## 工具与模型原始记录','',
    '以下记录用于核对来源、输入传递和工具实际执行，模型返回中未显示在页面的理由不能算已提醒用户。列表保留保存快照中的累计网络记录。',
    '');
  jsonSection(lines,'最终快照的API记录',final.network);
  lines.push('## 如何填写','',
    '只需提交案例编号、D1–D4及3个检查点的0/1分数，拿不准写待复核。证据及故障分析由助手另行整理，注明来源，保留用户原分。',
    '场景初始化之前的首次规划及完整内部日程均保留在原始JSON中，必要时查阅；本文件不包含评分结论。','');
  fs.writeFileSync(path.join(outputDir,`${id}-evidence.md`),lines.join('\n'));
}
console.log(JSON.stringify({prepared:selected.length,caseIds:selected,sourceHashesVerified:true,existingScoresIncluded:false,apiCalls:0}));
