'use strict';

const fs = require('node:fs');
const path = require('node:path');
const checks = require('./judge-validation.cjs');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const json = file => JSON.parse(read(file));
const configFile = 'eval/judge-v1.2-config.json';
const config = json(configFile);
const sourceManifest = json(config.input_manifest);
const schema = json(config.canonical_schema_file);
const preparedDir = path.join(root, config.prepared_directory);
const auditDir = path.join(root, config.audit_directory);

function save(dir, file, value) {
  const destination = path.join(dir, file);
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n';
  if (fs.existsSync(destination)) {
    if (fs.readFileSync(destination, 'utf8') !== text) throw new Error('Refusing to overwrite changed artifact: ' + destination);
    return;
  }
  fs.writeFileSync(destination, text);
}

function main() {
  fs.mkdirSync(preparedDir, {recursive:true});
  fs.mkdirSync(auditDir, {recursive:true});
  const wireSchema = checks.createWireSchema(schema);
  const system = read(config.prompt_file) + '\n\nEFFECTIVE_RULES:\n' + config.rule_files.map(read).join('\n\n') + '\n\nOUTPUT_WIRE_JSON_SCHEMA:\n' + JSON.stringify(wireSchema, null, 2);
  if (config.case_ids.some(id => new RegExp('\\b' + id + '\\b').test(system))) throw new Error('Case ID in system prompt');
  save(preparedDir, 'system-message.txt', system);
  save(preparedDir, 'wire-schema.json', wireSchema);
  const manifest = {workflow_version:config.workflow_version, api_calls:0, human_labels_sent:false, inputs:[],
    source_files:[configFile, config.prompt_file, ...config.rule_files, config.canonical_schema_file, 'eval/judge-validation.cjs', 'eval/prepare-judge-v1.2.cjs', 'eval/validate-judge-response.cjs'].map(file => ({file, sha256:checks.sha256(read(file))})),
    system_message_sha256:checks.sha256(system), wire_schema_sha256:checks.sha256(JSON.stringify(wireSchema, null, 2) + '\n')};
  const auditRows = [];
  for (const id of config.case_ids) {
    const file = config.input_directory + '/' + id + '.json';
    const input = json(file);
    const sha = checks.sha256(read(file));
    if (sourceManifest.ready.find(row => row.id === id)?.sha256 !== sha || input.case.id !== id) throw new Error('Source hash mismatch: ' + id);
    checks.assertNoLabels(input);
    const catalog = checks.buildCatalog(input);
    const facts = checks.buildFacts(input);
    const prepared = {case_evidence:input, evidence_catalog:catalog, derived_observations:facts};
    checks.assertNoLabels(prepared);
    save(preparedDir, id + '.json', prepared);
    manifest.inputs.push({case_id:id, source_file:file, source_sha256:sha, prepared_file:config.prepared_directory + '/' + id + '.json',
      prepared_sha256:checks.sha256(JSON.stringify(prepared, null, 2) + '\n'), catalog_entries:catalog.length});
    const judgeFile = config.source_judge_directory + '/' + id + '-judge.json';
    const judge = json(judgeFile);
    const audit = {case_id:id, source_judgment:judgeFile, source_judgment_sha256:checks.sha256(read(judgeFile)), source_input_sha256:sha,
      ...checks.validateJudgment(judge, input, schema, facts)};
    save(auditDir, id + '-audit.json', audit);
    auditRows.push(audit);
  }
  save(preparedDir, 'manifest.json', manifest);
  const summary = {workflow_version:config.workflow_version, api_calls:0, cases:config.case_ids.length,
    hard_valid:auditRows.filter(row => row.hard_valid).length, human_review_queue:auditRows.filter(row => row.effective_review_required).map(row => row.case_id),
    auto_accept:auditRows.filter(row => row.auto_accept).map(row => row.case_id),
    signals:auditRows.map(row => ({case_id:row.case_id, hard_errors:row.hard_errors.length, review_codes:row.review_signals.map(signal => signal.code)})),
    limitation:'Local review signals are not new model scores or proven semantic judgments; no agreement rate computed.'};
  save(auditDir, 'summary.json', summary);
  save(auditDir, 'manifest.json', {api_calls:0, source_files:manifest.source_files, judgments:auditRows.map(row => ({file:row.source_judgment, sha256:row.source_judgment_sha256}))});
  const report = ['# 本地评委校验流程审计', '', '日期：2026-10-12。未调用模型，未修改原始判断或人工分。', '',
    '|案例|硬校验|人工复核信号|自动接受|', '|---|---|---|---|',
    ...auditRows.map(row => `|${row.case_id}|${row.hard_valid ? '通过' : '失败'}|${row.review_signals.map(signal => signal.code).join('、') || '无新增信号'}|${row.auto_accept ? '可进入后续统计' : '进入人工队列'}|`), '',
    '硬校验检查Schema、编号、检查点顺序和原文引用。软信号只触发人工复核，不判定原分一定错，也不改分。自动接受只表示本地检查未拦截，不能证明语义判断正确。', '',
    '本次从旧v1.1判断运行本地审计，没有新的机评一致率。A01引用问题继续排除；其他有软信号的结果暂不自动接受。队列仍可能漏掉问题，例如备选适用性或摘要取舍，需要后续真实模型回归和人工复核。', '',
    '下一版准备文件在eval/judge-inputs/2026-10-12-v1.2/；模型只选证据ID，程序还原为原始路径/引文。使用judge-validation.cjs的validateWireJudgment完成ID校验、原Schema校验及软信号门控。准备脚本无网络能力、不读取.env或人工标签。', ''].join('\n');
  save(auditDir, 'report.md', report);
  console.log(JSON.stringify(summary));
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
