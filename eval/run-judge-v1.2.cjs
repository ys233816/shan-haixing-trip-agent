'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Ajv = require('ajv/dist/2020');
const checks = require('./judge-validation.cjs');
const root = path.resolve(__dirname, '..');
const args = new Set(process.argv.slice(2));
const configFile = path.join(__dirname, 'judge-v1.2-config.json');
const read = file => fs.readFileSync(file, 'utf8');
const json = file => JSON.parse(read(file).replace(/^\uFEFF/, ''));
const relative = file => path.relative(root, file).replace(/\\/g, '/');
const outputDir = path.join(__dirname, 'judge-runs', '2026-10-12-judge-v1.2');
const dimensionKeys = ['D1', 'D2', 'D3', 'D4'];
const hashFile = file => checks.sha256(fs.readFileSync(file));
const pass = judgment => [...dimensionKeys.map(key => judgment.dimensions[key]), ...judgment.checkpoints].every(grade => grade.score === 1);

function save(file, value, exclusive = false) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', exclusive ? {flag:'wx'} : undefined);
}

function loadModel() {
  const values = {...process.env};
  for (const line of read(path.join(root, '.env')).split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && !values[match[1]]) values[match[1]] = match[2].replace(/^(["'])(.*)\1$/, '$2');
  }
  const model = (values.LLM_MODEL || '').trim();
  const apiKey = (values.LLM_API_KEY || '').trim();
  const base = (values.LLM_BASE_URL || '').trim().replace(/\/+$/, '');
  const endpoint = new URL(/\/chat\/completions$/i.test(base) ? base : base + '/chat/completions');
  if (!model || !apiKey || endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('Invalid HTTPS model configuration.');
  return {model, apiKey, endpoint:endpoint.toString()};
}

function loadLabels(id, sha, checkpointCount) {
  const originalFile = path.join(__dirname, 'human-review', 'submissions', id + '-submission-' + (id === 'B07' ? '003' : '001') + '.json');
  const adjudicationFile = path.join(__dirname, 'human-review', 'adjudications', id + '-adjudication-001.json');
  const currentFile = fs.existsSync(adjudicationFile) ? adjudicationFile : originalFile;
  const original = json(originalFile), current = json(currentFile);
  for (const label of [original, current]) {
    if (label.judge_input_sha256 !== sha || label.checkpoints.length !== checkpointCount) throw new Error('Label/evidence mismatch: ' + id);
  }
  return {original, current, files:[originalFile, currentFile].map(file => ({file:relative(file), sha256:hashFile(file)}))};
}

function prepare() {
  for (const arg of args) if (!['--preflight', '--report'].includes(arg)) throw new Error('Unsupported argument: ' + arg);
  const config = json(configFile);
  const directory = path.join(root, config.prepared_directory);
  const manifestFile = path.join(directory, 'manifest.json');
  const manifest = json(manifestFile);
  for (const file of manifest.source_files) {
    if (hashFile(path.join(root, file.file)) !== file.sha256) throw new Error('Prepared workflow hash changed: ' + file.file);
  }
  const system = read(path.join(directory, 'system-message.txt'));
  const wireSchemaFile = path.join(directory, 'wire-schema.json');
  if (checks.sha256(system) !== manifest.system_message_sha256 || hashFile(wireSchemaFile) !== manifest.wire_schema_sha256) throw new Error('Prepared system or wire schema changed.');
  const canonicalSchema = json(path.join(root, config.canonical_schema_file));
  const wireSchema = json(wireSchemaFile);
  if (JSON.stringify(wireSchema) !== JSON.stringify(checks.createWireSchema(canonicalSchema))) throw new Error('Wire and canonical schemas differ unexpectedly.');
  const ajv = new Ajv({allErrors:true, strict:false});
  ajv.compile(wireSchema); ajv.compile(canonicalSchema);
  if (config.case_ids.some(id => new RegExp('\\b' + id + '\\b').test(system))) throw new Error('Case identifier in model instructions.');
  const entries = config.case_ids.map(id => {
    const entry = manifest.inputs.find(row => row.case_id === id);
    if (!entry || hashFile(path.join(root, entry.prepared_file)) !== entry.prepared_sha256 || hashFile(path.join(root, entry.source_file)) !== entry.source_sha256) throw new Error('Prepared/source evidence changed: ' + id);
    const prepared = json(path.join(root, entry.prepared_file));
    checks.assertNoLabels(prepared);
    const source = json(path.join(root, entry.source_file));
    if (source.case.id !== id || JSON.stringify(source) !== JSON.stringify(prepared.case_evidence)) throw new Error('Original/prepared input mismatch: ' + id);
    if (JSON.stringify(checks.buildCatalog(source)) !== JSON.stringify(prepared.evidence_catalog) || JSON.stringify(checks.buildFacts(source)) !== JSON.stringify(prepared.derived_observations)) throw new Error('Derived data changed: ' + id);
    return {...entry, prepared, labels:loadLabels(id, entry.source_sha256, source.case.checkpoints.length)};
  });
  return {config, system, canonicalSchema, entries, model:loadModel(), hashes:{
    runner_sha256:hashFile(__filename), config_sha256:hashFile(configFile), prepared_manifest_sha256:hashFile(manifestFile),
    effective_system_sha256:checks.sha256(system), wire_schema_sha256:hashFile(wireSchemaFile), canonical_schema_sha256:hashFile(path.join(root, config.canonical_schema_file))
  }};
}

async function request(entry, prepared) {
  const id = entry.case_id;
  const metaFile = path.join(outputDir, id + '-metadata.json');
  const responseFile = path.join(outputDir, id + '-api-response.json');
  const body = {model:prepared.model.model, ...prepared.config.parameters,
    messages:[{role:'system', content:prepared.system}, {role:'user', content:JSON.stringify(entry.prepared)}]};
  const requestHash = checks.sha256(JSON.stringify(body));
  if (fs.existsSync(metaFile)) {
    const previous = json(metaFile);
    if (previous.request_body_sha256 !== requestHash || previous.runner_sha256 !== prepared.hashes.runner_sha256) throw new Error('Cannot resume changed request: ' + id);
    if (previous.status !== 'response_saved' || !fs.existsSync(responseFile)) throw new Error('Prior request incomplete; no silent paid retry: ' + id);
    console.log('Reuse saved response ' + id);
    return;
  }
  const metadata = {case_id:id, prompt_version:prepared.config.prompt_version, ...prepared.hashes,
    input_file:entry.prepared_file, input_sha256:entry.prepared_sha256, original_input_sha256:entry.source_sha256,
    request_body_sha256:requestHash, requested_model:prepared.model.model, endpoint:prepared.model.endpoint,
    parameters:prepared.config.parameters, status:'requesting', started_at:new Date().toISOString(),
    human_labels_sent:false, prior_judgments_sent:false, assistant_analysis_sent:false,
    derived_observations_sent:true, evidence_catalog_sent:true, automatic_retries:0, mode:'grading'};
  save(metaFile, metadata, true);
  const start = Date.now();
  try {
    const response = await fetch(prepared.model.endpoint, {method:'POST', headers:{'content-type':'application/json', authorization:'Bearer ' + prepared.model.apiKey},
      body:JSON.stringify(body), signal:AbortSignal.timeout(180000)});
    const raw = await response.text();
    fs.writeFileSync(responseFile, raw, {flag:'wx'});
    metadata.response_sha256 = checks.sha256(raw);
    metadata.http_status = response.status;
    metadata.status = response.ok ? 'response_saved' : 'http_error';
    if (response.ok) {
      try {
        const api = JSON.parse(raw);
        metadata.response_model = api.model || null; metadata.response_id = api.id || null;
        metadata.usage = api.usage || null; metadata.finish_reason = api.choices?.[0]?.finish_reason || null;
      } catch { metadata.status = 'invalid_api_json'; }
    }
  } catch (error) {
    metadata.status = 'transport_error'; metadata.error_name = error.name;
    metadata.error_code = error.cause?.code || error.code || null;
  } finally {
    metadata.duration_ms = Date.now() - start; metadata.completed_at = new Date().toISOString();
    save(metaFile, metadata);
  }
}

function evaluate(entry, prepared) {
  const id = entry.case_id;
  const metaFile = path.join(outputDir, id + '-metadata.json');
  if (!fs.existsSync(metaFile)) return {id, valid:false, status:'not_requested', auto_accept:false, labels:entry.labels};
  const metadata = json(metaFile);
  for (const [key, value] of Object.entries(prepared.hashes)) if (metadata[key] !== value) throw new Error('Saved workflow mismatch: ' + id + ' ' + key);
  if (metadata.input_sha256 !== entry.prepared_sha256 || metadata.original_input_sha256 !== entry.source_sha256) throw new Error('Saved evidence mismatch: ' + id);
  const responseFile = path.join(outputDir, id + '-api-response.json');
  if (metadata.status !== 'response_saved') return {id, valid:false, status:metadata.status, auto_accept:false, metadata, labels:entry.labels};
  if (hashFile(responseFile) !== metadata.response_sha256) throw new Error('Saved response changed: ' + id);
  let audit;
  try {
    const api = json(responseFile), content = api.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new SyntaxError('Missing model text');
    fs.writeFileSync(path.join(outputDir, id + '-content.txt'), content);
    const wire = JSON.parse(content);
    save(path.join(outputDir, id + '-wire-judge.json'), wire);
    audit = checks.validateWireJudgment(wire, entry.prepared, prepared.canonicalSchema);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    audit = {judgment:null, hard_valid:false, auto_accept:false, effective_review_required:true,
      hard_errors:[{code:'JSON_PARSE', message:'Entire model text must be JSON; no extraction or repair.'}]};
  }
  if (audit.judgment) save(path.join(outputDir, id + '-judge.json'), audit.judgment);
  save(path.join(outputDir, id + '-validation.json'), audit);
  const valid = audit.hard_valid && audit.judgment?.evaluation_status === 'scored';
  return {id, valid, status:audit.hard_valid ? audit.judgment.evaluation_status : 'validation_failed',
    auto_accept:!!audit.auto_accept, audit, metadata, result:audit.judgment, labels:entry.labels};
}

function compare(rows, kind) {
  const metrics = {dimensions:{matches:0,total:0}, checkpoints:{matches:0,total:0}, case_pass:{matches:0,total:0},
    critical:{matches:0,total:0,positive_total:0,missed:0}, per_dimension:Object.fromEntries(dimensionKeys.map(key => [key,{matches:0,total:0}])),
    differences:[], excluded:[]};
  for (const row of rows) {
    if (!row.valid) {metrics.excluded.push({case_id:row.id,status:row.status}); continue;}
    const label = row.labels[kind], judge = row.result;
    for (const key of dimensionKeys) {
      const score = label.dimensions[key].score;
      if (![0,1].includes(score)) continue;
      const matched = score === judge.dimensions[key].score;
      for (const target of [metrics.dimensions, metrics.per_dimension[key]]) {target.total++; target.matches += Number(matched);}
      if (!matched) metrics.differences.push({case_id:row.id,item:key,human:score,judge:judge.dimensions[key].score,judge_reason:judge.dimensions[key].reason});
    }
    label.checkpoints.forEach((checkpoint, index) => {
      if (![0,1].includes(checkpoint.score)) return;
      const matched = checkpoint.score === judge.checkpoints[index].score;
      metrics.checkpoints.total++; metrics.checkpoints.matches += Number(matched);
      if (!matched) metrics.differences.push({case_id:row.id,item:'checkpoint_' + (index+1),human:checkpoint.score,judge:judge.checkpoints[index].score,judge_reason:judge.checkpoints[index].reason});
    });
    metrics.case_pass.total++; metrics.case_pass.matches += Number(pass(label) === pass(judge));
    const critical = label.critical_failure.value;
    if (typeof critical === 'boolean') {
      metrics.critical.total++; metrics.critical.matches += Number(critical === judge.critical_failure);
      if (critical) {metrics.critical.positive_total++; metrics.critical.missed += Number(!judge.critical_failure);}
      if (critical !== judge.critical_failure) metrics.differences.push({case_id:row.id,item:'critical_failure',human:critical,judge:judge.critical_failure,judge_reason:judge.critical_reason});
    }
  }
  for (const target of [metrics.dimensions,metrics.checkpoints,metrics.case_pass,metrics.critical,...Object.values(metrics.per_dimension)]) target.rate = target.total ? target.matches/target.total : null;
  return metrics;
}

function pairedComparison(rows, directory) {
  const previous = json(path.join(directory, 'comparison.json'));
  const commonIds = rows.filter(row => row.valid && previous.valid_cases.includes(row.id)).map(row => row.id);
  const current = rows.filter(row => commonIds.includes(row.id));
  const prior = current.map(row => {
    const entry = previous.cases.find(value => value.case_id === row.id);
    for (const file of entry.label_files) if (hashFile(path.join(root,file.file)) !== file.sha256) throw new Error('Historical comparison label changed: ' + row.id);
    return {...row, result:json(path.join(root,entry.result_directory,row.id + '-judge.json'))};
  });
  return {prior_prompt_version:previous.prompt_version, common_cases:commonIds, prior:compare(prior,'current'), current:compare(current,'current')};
}

function generateReport(prepared) {
  const rows = prepared.entries.map(entry => evaluate(entry,prepared));
  const autoRows = rows.filter(row => row.auto_accept);
  const original = compare(rows,'original'), adjudicated = compare(rows,'current');
  const calibrationGate = {complete_six_valid_cases:rows.filter(row => row.valid).length === prepared.entries.length,
    dimensions_at_least_85_percent:adjudicated.dimensions.rate >= .85, checkpoints_at_least_85_percent:adjudicated.checkpoints.rate >= .85,
    critical_positive_checked:adjudicated.critical.positive_total > 0, critical_misses:adjudicated.critical.missed};
  calibrationGate.passed = calibrationGate.complete_six_valid_cases && calibrationGate.dimensions_at_least_85_percent && calibrationGate.checkpoints_at_least_85_percent && calibrationGate.critical_positive_checked && !calibrationGate.critical_misses;
  const attempts = rows.filter(row => row.metadata).map(row => ({case_id:row.id,...row.metadata,
    metadata_sha256:hashFile(path.join(outputDir,row.id+'-metadata.json'))}));
  const report = {created_at:new Date().toISOString(), prompt_version:prepared.config.prompt_version, workflow_version:prepared.config.workflow_version,
    requested_model:prepared.model.model, ...prepared.hashes, requested_cases:prepared.config.case_ids,
    valid_cases:rows.filter(row => row.valid).map(row => row.id), original, adjudicated, calibration_gate:calibrationGate,
    review_gate:{auto_accepted_cases:autoRows.map(row=>row.id), auto_accept_coverage:autoRows.length/prepared.entries.length,
      human_review_queue:rows.filter(row=>!row.auto_accept).map(row=>row.id), human_reviews_completed_this_run:0,
      automatic_subset_original:compare(autoRows,'original'), automatic_subset_adjudicated:compare(autoRows,'current')},
    paired_prior_runs:['2026-10-12-judge-v1-repair2','2026-10-12-judge-v1.1'].map(dir=>pairedComparison(rows,path.join(__dirname,'judge-runs',dir))),
    attempts, attempt_summary:{requests:attempts.length,evidence_repairs:0,automatic_retries:0,
      usage:attempts.reduce((total,row)=>{for(const key of ['prompt_tokens','completion_tokens','total_tokens'])total[key]+=row.usage?.[key]||0;return total;},{prompt_tokens:0,completion_tokens:0,total_tokens:0})},
    cases:rows.map(row=>({case_id:row.id,valid:row.valid,status:row.status,result_directory:relative(outputDir),auto_accept:row.auto_accept,
      judge_dimensions:row.result?Object.fromEntries(dimensionKeys.map(key=>[key,row.result.dimensions[key].score])):null,
      judge_checkpoints:row.result?.checkpoints.map(grade=>grade.score)||null,judge_critical_failure:row.result?.critical_failure??null,
      judge_case_pass:row.valid?pass(row.result):null,model_review_required:row.audit?.model_review_required??null,
      effective_review_required:row.audit?.effective_review_required??true,review_signals:row.audit?.review_signals||[],
      hard_errors:row.audit?.hard_errors||[],selected_evidence_ids:row.audit?.selected_evidence_ids||[],label_files:row.labels.files})),
    limitations:['Six targeted calibration cases; not a full or fixed-version Agent benchmark.',
      'All hard-valid machine scores enter diagnostic agreement, including cases routed to human review; routing does not change scores.',
      'Automatic subset agreement has restricted coverage and cannot replace full-sample diagnostic agreement.',
      'Human adjudications followed assistant feedback; originals are compared separately. Only two human critical flags are known, with one positive.',
      'Evidence IDs guarantee source provenance, not semantic support. Soft checks may miss errors or create false alarms.',
      'The same configured model judges Agent outputs; no independent-model validation.',
      'v1.2 changes prompt, input structure and evidence protocol; prior v1.0 also mixed thinking parameters and repairs. No isolated causal claim.',
      'No travel Agent rerun or improvement measured; human review queue has not been adjudicated in this run.']};
  save(path.join(outputDir,'comparison.json'),report);
  const rate=value=>value.rate===null?'不可计算':`${value.matches}/${value.total}（${(100*value.rate).toFixed(1)}%）`;
  const clean=value=>String(value).replace(/\|/g,'/').replace(/\r?\n/g,' ');
  const lines=['# v1.2 六条评委回归','',`硬有效评分：${report.valid_cases.length}/6；自动接受：${autoRows.length}/6；人工队列：${report.review_gate.human_review_queue.join('、')||'无'}。`, '',
    '以下一致率使用所有硬有效评分，包括待复核项；复核标记不改分，也不从诊断比较中隐藏困难样本。','',
    '|指标|原始人工分|裁定分|','|---|---|---|',
    ...[['四维一致率','dimensions'],['检查点一致率','checkpoints'],['任务通过判断一致率','case_pass'],['关键失败标记一致率','critical']].map(([label,key])=>`|${label}|${rate(original[key])}|${rate(adjudicated[key])}|`),'',
    `六条校准门槛：${calibrationGate.passed?'达到':'未达到'}。要求六条有效、四维与检查点一致率分别≥85%、已确认关键失败无漏报。本轮人工复核尚未进行，不把通过校准等同于所有结果可自动接受。`,'',
    `已确认关键失败正例${adjudicated.critical.positive_total}条，漏报${adjudicated.critical.missed}条。未知标签不算否；本地送审不是模型主动检出。`,'',
    '## 每条原始机评与门控','', '|案例|状态|D1 D2 D3 D4|检查点|关键失败|门控|','|---|---|---|---|---|---|',
    ...report.cases.map(row=>`|${row.case_id}|${row.status}|${row.judge_dimensions?Object.values(row.judge_dimensions).join(' '):'-'}|${row.judge_checkpoints?.join(' ')||'-'}|${row.judge_critical_failure===null?'-':row.judge_critical_failure?'是':'否'}|${row.auto_accept?'自动接受':'人工复核'}|`),'',
    '## 与裁定分的分歧','', '|案例|项目|人工|机评|模型理由|','|---|---|---|---|---|',
    ...adjudicated.differences.map(row=>`|${row.case_id}|${row.item}|${row.human}|${row.judge}|${clean(row.judge_reason)}|`),
    ...(adjudicated.differences.length?[]:['无有效项分歧。']),'',
    '## 门控与覆盖率','',`自动接受覆盖率${autoRows.length}/6（${(100*report.review_gate.auto_accept_coverage).toFixed(1)}%）。自动子集与裁定分的四维一致率${rate(report.review_gate.automatic_subset_adjudicated.dimensions)}、检查点${rate(report.review_gate.automatic_subset_adjudicated.checkpoints)}；不能作为全六条整体指标。`,'',
    ...report.cases.filter(row=>!row.auto_accept).map(row=>`- ${row.case_id}：硬错误${row.hard_errors.length}；本地信号${row.review_signals.map(signal=>signal.code).join('、')||'无'}；模型要求复核${row.model_review_required?'是':'否/无有效输出'}。`),'',
    '## 同样本历史比较','',
    ...report.paired_prior_runs.flatMap(pair=>[`与${pair.prior_prompt_version}共同有效样本：${pair.common_cases.join('、')||'无'}。四维${rate(pair.prior.dimensions)} → ${rate(pair.current.dimensions)}；检查点${rate(pair.prior.checkpoints)} → ${rate(pair.current.checkpoints)}。`, '']),
    '## 请求与方法限制','',`请求模型：${prepared.model.model}；响应模型：${[...new Set(attempts.map(row=>row.response_model).filter(Boolean))].join('、')||'无'}。不从别名推断版本等价。`, '',
    `共${attempts.length}次API请求，0次自动重试/引用修复，${report.attempt_summary.usage.total_tokens}总token（输入${report.attempt_summary.usage.prompt_tokens}，输出${report.attempt_summary.usage.completion_tokens}）。费用以账单为准。`,'',
    '统一关闭思考，temperature=0、max_tokens=8192；只发送准备的原始证据、程序提取观察与证据目录，没有人工分、旧机评或助手复盘。ID解码只还原引用，分数/理由/安全标记保持模型原样。原始响应和wire判断单独保存。','',
    ...report.limitations.map(value=>'- '+value),''];
  fs.writeFileSync(path.join(outputDir,'report.md'),lines.join('\n'));
  console.log(JSON.stringify({valid:report.valid_cases.length,dimensions:rate(adjudicated.dimensions),checkpoints:rate(adjudicated.checkpoints),critical_misses:adjudicated.critical.missed,auto_accept:autoRows.length,human_review_queue:report.review_gate.human_review_queue,gate_passed:calibrationGate.passed,output:relative(outputDir)}));
  return report;
}

async function main() {
  const prepared = prepare();
  if (args.has('--preflight')) {
    console.log(JSON.stringify({prompt_version:prepared.config.prompt_version,model:prepared.model.model,endpoint_host:new URL(prepared.model.endpoint).host,
      schema_compiled:true,source_and_prepared_hashes_verified:true,labels_not_sent:true,parameters:prepared.config.parameters,
      cases:prepared.entries.map(entry=>({id:entry.case_id,catalog_entries:entry.prepared.evidence_catalog.length})),...prepared.hashes,api_calls:0}));
    return;
  }
  fs.mkdirSync(outputDir,{recursive:true});
  if (!args.has('--report')) {
    const manifestFile = path.join(outputDir,'run-manifest.json');
    if (!fs.existsSync(manifestFile)) save(manifestFile,{created_at:new Date().toISOString(),prompt_version:prepared.config.prompt_version,...prepared.hashes,
      requested_model:prepared.model.model,parameters:prepared.config.parameters,automatic_retries:0,human_labels_sent:false,prior_judgments_sent:false,
      assistant_analysis_sent:false,derived_observations_sent:true,inputs:prepared.entries.map(({prepared:input,labels,...entry})=>({...entry,label_files:labels.files})),
      purpose:'Six-case v1.2 judge regression; original Agent runs and labels unchanged.'},true);
    for (const entry of prepared.entries) {
      console.log('Judging '+entry.case_id);
      await request(entry,prepared);
      const row=evaluate(entry,prepared);
      console.log(JSON.stringify({case_id:row.id,status:row.status,hard_valid:row.valid,auto_accept:row.auto_accept,review_signals:row.audit?.review_signals?.map(signal=>signal.code)||[]}));
    }
  }
  generateReport(prepared);
}

if (require.main===module) main().catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={compare};
