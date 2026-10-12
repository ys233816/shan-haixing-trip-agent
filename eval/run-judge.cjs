'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Ajv = require('ajv/dist/2020');

const root = path.resolve(__dirname, '..');
const ids = ['B07', 'B09', 'A01', 'A03', 'A08', 'A09'];
const dimensionKeys = ['D1', 'D2', 'D3', 'D4'];
const inputDir = path.join(__dirname, 'judge-inputs', '2026-10-11');
const args = new Set(process.argv.slice(2));
const version11 = args.has('--v1.1');
const runSettings = version11 ? JSON.parse(fs.readFileSync(path.join(__dirname, 'judge-v1.1-config.json'), 'utf8')) : null;
const promptVersion = runSettings?.prompt_version || 'judge-v1.0';
if (version11 && ['--retry-invalid', '--repair-invalid', '--repair-final'].some(flag => args.has(flag))) throw new Error('v1.1 runs six first judgments only; additional calls need a separate recorded phase.');
const repairMode = args.has('--repair-invalid') || args.has('--repair-final');
const initialDir = version11 ? path.join(root, runSettings.output_directory) : path.join(__dirname, 'judge-runs', '2026-10-12-judge-v1');
const outputDir = args.has('--repair-final') ? initialDir + '-repair2' : repairMode ? initialDir + '-repair1' : args.has('--retry-invalid') ? initialDir + '-retry1' : initialDir;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const read = file => fs.readFileSync(file, 'utf8');
const json = file => JSON.parse(read(file).replace(/^\uFEFF/, ''));
const relative = file => path.relative(root, file).replace(/\\/g, '/');
const save = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const pass = value => [...dimensionKeys.map(k => value.dimensions[k]), ...value.checkpoints].every(x => x.score === 1);

function loadConfig() {
  const values = {...process.env};
  for (const line of read(path.join(root, '.env')).split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && !values[match[1]]) values[match[1]] = match[2].replace(/^(["'])(.*)\1$/, '$2');
  }
  const apiKey = (values.LLM_API_KEY || '').trim();
  const model = (values.LLM_MODEL || '').trim();
  const base = (values.LLM_BASE_URL || '').trim().replace(/\/+$/, '');
  const endpoint = new URL(/\/chat\/completions$/i.test(base) ? base : base + '/chat/completions');
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !apiKey || !model) {
    throw new Error('Invalid model configuration; require HTTPS endpoint, model and API key.');
  }
  return {apiKey, model, endpoint:endpoint.toString()};
}

function assertNoLabels(value) {
  const blocked = new Set(['manualBaseline', 'scores', 'checkpointResults', 'dimensionEvidence', 'checkpointEvidence', 'casePass', 'scoringNotes', 'rater', 'reviews', 'adjudications']);
  if (Array.isArray(value)) return value.forEach(assertNoLabels);
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (blocked.has(key)) throw new Error('Input contains grading labels: ' + key);
    assertNoLabels(child);
  }
}

function prepare() {
  const config = loadConfig();
  if (version11 && (JSON.stringify(runSettings.calibration_case_ids) !== JSON.stringify(ids) || path.resolve(root, runSettings.input_directory) !== inputDir)) throw new Error('v1.1 must use the fixed six calibration inputs.');
  const prompt = read(version11 ? path.join(root, runSettings.prompt_file) : path.join(__dirname, 'judge-system-prompt.md'));
  const schemaText = read(version11 ? path.join(root, runSettings.schema_file) : path.join(__dirname, 'judge-output.schema.json'));
  const ruleFiles = version11 ? runSettings.rule_files : ['eval/rubric.md'];
  const rules = ruleFiles.map(file => read(path.join(root, file)));
  if (version11 && ids.some(id => new RegExp('\\b' + id + '\\b').test([prompt, ...rules].join('\n')))) throw new Error('Calibration identifier in judge instructions.');
  const schema = JSON.parse(schemaText);
  const validateSchema = new Ajv({allErrors:true, strict:false}).compile(schema);
  const manifest = json(path.join(inputDir, 'manifest.json'));
  const inputs = ids.map(id => {
    const file = path.join(inputDir, id + '.json');
    const bytes = fs.readFileSync(file);
    const input = JSON.parse(bytes.toString('utf8'));
    const expected = manifest.ready.find(x => x.id === id);
    if (!expected || hash(bytes) !== expected.sha256 || input.case.id !== id) throw new Error('Evidence hash or case mismatch: ' + id);
    assertNoLabels(input);
    return {id, input, sha256:hash(bytes), file:relative(file)};
  });
  const labelFiles = inputs.map(entry => ({case_id:entry.id, files:loadLabels(entry).files}));
  const system = prompt + (version11 ? '\n\nEFFECTIVE_RULES:\n' + rules.join('\n\n') : '') + '\n\nOUTPUT_JSON_SCHEMA:\n' + schemaText;
  return {
    config, prompt, schemaText, validateSchema, inputs,
    system, labelFiles,
    hashes:{prompt_sha256:hash(prompt), schema_sha256:hash(schemaText), rubric_sha256:hash(version11 ? rules.join('\n\n') : rules[0]), runner_sha256:hash(read(__filename)),
      ...(version11 ? {config_sha256:hash(read(path.join(__dirname, 'judge-v1.1-config.json'))), effective_system_sha256:hash(system), rule_files:ruleFiles.map((file, i) => ({file, sha256:hash(rules[i])}))} : {})}
  };
}

function resolveRef(input, ref) {
  const tokens = ref.replace(/^\$\.?/, '').replace(/\[(\d+)\]/g, '.$1').split('.');
  let value = input;
  for (const token of tokens) {
    if (!token || value == null || !Object.prototype.hasOwnProperty.call(value, token)) return {found:false};
    value = value[token];
  }
  return {found:true, value};
}

function validateResult(result, entry, validateSchema) {
  const schemaValid = validateSchema(result);
  const errors = schemaValid ? [] : validateSchema.errors.map(e => ({kind:'schema', path:e.instancePath, message:e.message}));
  if (!schemaValid) return {valid:false, schema_valid:false, quote_count:0, errors};
  if (result.case_id !== entry.id) errors.push({kind:'case_id', message:'Wrong case identifier'});
  if (!Array.isArray(result.checkpoints) || result.checkpoints.length !== entry.input.case.checkpoints.length) errors.push({kind:'checkpoints', message:'Wrong checkpoint count'});
  (result.checkpoints || []).forEach((x, i) => {
    if (x.index !== i + 1) errors.push({kind:'checkpoint_index', index:i + 1});
  });
  const grades = [...dimensionKeys.map(k => ({item:k, grade:result.dimensions?.[k]})), ...(result.checkpoints || []).map(x => ({item:'checkpoint_' + x.index, grade:x}))];
  let quoteCount = 0;
  for (const {item, grade} of grades) {
    for (const evidence of grade?.evidence || []) {
      quoteCount++;
      const resolved = typeof evidence.ref === 'string' ? resolveRef(entry.input, evidence.ref) : {found:false};
      if (!resolved.found) {
        errors.push({kind:'evidence_ref', item, ref:evidence.ref});
        continue;
      }
      const variants = typeof resolved.value === 'string' ? [resolved.value] : [JSON.stringify(resolved.value), JSON.stringify(resolved.value, null, 2)];
      if (typeof evidence.quote !== 'string' || !variants.some(v => v.includes(evidence.quote))) errors.push({kind:'evidence_quote', item, ref:evidence.ref, quote:evidence.quote});
    }
  }
  return {valid:errors.length === 0, schema_valid:schemaValid, quote_count:quoteCount, errors};
}

async function requestJudge(entry, prepared) {
  const rawFile = path.join(outputDir, entry.id + '-api-response.json');
  const metaFile = path.join(outputDir, entry.id + '-metadata.json');
  if (fs.existsSync(metaFile)) {
    const old = json(metaFile);
    if (old.input_sha256 !== entry.sha256 || old.prompt_sha256 !== prepared.hashes.prompt_sha256 || old.schema_sha256 !== prepared.hashes.schema_sha256 || old.rubric_sha256 !== prepared.hashes.rubric_sha256 || old.requested_model !== prepared.config.model) throw new Error('Cannot resume changed run: ' + entry.id);
    if (version11 && (old.config_sha256 !== prepared.hashes.config_sha256 || old.effective_system_sha256 !== prepared.hashes.effective_system_sha256 || old.runner_sha256 !== prepared.hashes.runner_sha256)) throw new Error('Cannot resume changed v1.1 settings: ' + entry.id);
    if (fs.existsSync(rawFile)) return;
    throw new Error('Previous request has no saved response; do not silently issue duplicate paid call: ' + entry.id);
  }
  const body = {
    model:prepared.config.model,
    temperature:0,
    max_tokens:8192,
    response_format:{type:'json_object'},
    messages:[{role:'system', content:prepared.system}, {role:'user', content:JSON.stringify(entry.input)}]
  };
  if (version11) Object.assign(body, runSettings.parameters);
  if (args.has('--retry-invalid') || repairMode) body.thinking = {type:'disabled'};
  if (repairMode) {
    const priorDirectory = sourceDirectory(entry.id);
    const previous = json(path.join(priorDirectory, entry.id + '-judge.json'));
    const errors = json(path.join(priorDirectory, entry.id + '-validation.json')).errors;
    const referenceExamples = errors.map(error => {
      const ref = (error.ref || '').replace('.observed.internal_state', '.internal_state');
      const resolved = resolveRef(entry.input, ref);
      return resolved.found ? {item:error.item, ref, exact_value:resolved.value} : null;
    }).filter(Boolean);
    body.messages = [
      {role:'system', content:prepared.system + '\n\nThis request is evidence-format repair only. Preserve EVERY field and value of previous_judgment unchanged except evidence arrays inside dimensions and checkpoints. Do not regrade or change reasons, scores, failure layers, critical flags, or limitations. Replace invalid ref/quote pairs with exact nonempty excerpts from case_evidence. A quotation must be contiguous text or an excerpt of compact/indented JSON serialization at the exact ref. Do not skip intervening fields. For empty strings, reference their parent object and quote a serialized property (for example ref snapshots.turn1.observed and quote "\\\"visible_result\\\": \\\"\\\""). Return the complete previous judgment with only evidence corrections, no extra keys.'},
      {role:'user', content:JSON.stringify({case_evidence:entry.input, previous_judgment:previous, validation_errors:errors, reference_examples_from_original_input:referenceExamples})}
    ];
  }
  const metadata = {
    case_id:entry.id, input_file:entry.file, input_sha256:entry.sha256, prompt_version:promptVersion,
    ...prepared.hashes, system_message_sha256:hash(body.messages[0].content), request_body_sha256:hash(JSON.stringify(body)),
    requested_model:prepared.config.model, endpoint:prepared.config.endpoint,
    parameters:{temperature:0, max_tokens:8192, response_format:body.response_format, thinking:body.thinking || 'provider_default'},
    started_at:new Date().toISOString(), status:'requesting', attempt:1,
    human_labels_sent:false, assistant_analysis_sent:false, automatic_retries:0,
    prior_attempt:repairMode ? relative(path.join(sourceDirectory(entry.id), entry.id + '-metadata.json')) : args.has('--retry-invalid') ? relative(path.join(initialDir, entry.id + '-metadata.json')) : null,
    mode:repairMode ? 'evidence_format_repair_only' : 'grading'
  };
  save(metaFile, metadata);
  const start = Date.now();
  try {
    const response = await fetch(prepared.config.endpoint, {
      method:'POST', headers:{'content-type':'application/json', authorization:'Bearer ' + prepared.config.apiKey},
      body:JSON.stringify(body), signal:AbortSignal.timeout(180000)
    });
    const raw = await response.text();
    fs.writeFileSync(rawFile, raw);
    metadata.http_status = response.status;
    metadata.status = response.ok ? 'response_saved' : 'http_error';
    if (response.ok) {
      try {
        const api = JSON.parse(raw);
        metadata.response_model = api.model || null;
        metadata.response_id = api.id || null;
        metadata.usage = api.usage || null;
        metadata.finish_reason = api.choices?.[0]?.finish_reason || null;
      } catch { metadata.status = 'invalid_api_json'; }
    }
  } catch (error) {
    metadata.status = 'transport_error';
    metadata.error_name = error.name;
    metadata.error_code = error.cause?.code || error.code || null;
    // Network errors are recorded without headers or secrets.
  } finally {
    metadata.completed_at = new Date().toISOString();
    metadata.duration_ms = Date.now() - start;
    save(metaFile, metadata);
  }
}

function evaluateSaved(entry, prepared, directory = outputDir) {
  const metaFile = path.join(directory, entry.id + '-metadata.json');
  const rawFile = path.join(directory, entry.id + '-api-response.json');
  if (!fs.existsSync(metaFile)) return {id:entry.id, valid:false, status:'not_requested'};
  const metadata = json(metaFile);
  if (metadata.input_sha256 !== entry.sha256 || metadata.prompt_sha256 !== prepared.hashes.prompt_sha256 || metadata.schema_sha256 !== prepared.hashes.schema_sha256 || metadata.rubric_sha256 !== prepared.hashes.rubric_sha256) {
    throw new Error('Saved response/input/rule hash mismatch: ' + entry.id);
  }
  if (metadata.status !== 'response_saved' || !fs.existsSync(rawFile)) return {id:entry.id, valid:false, status:metadata.status};
  let result, content;
  try {
    const api = json(rawFile);
    content = api.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('Missing text content');
    fs.writeFileSync(path.join(directory, entry.id + '-content.txt'), content);
    result = JSON.parse(content);
  } catch {
    const validation = {valid:false, errors:[{kind:'json_parse', message:'Entire message is not a JSON object'}]};
    save(path.join(directory, entry.id + '-validation.json'), validation);
    return {id:entry.id, valid:false, status:'invalid_json'};
  }
  save(path.join(directory, entry.id + '-judge.json'), result);
  const validation = validateResult(result, entry, prepared.validateSchema);
  if (metadata.mode === 'evidence_format_repair_only') {
    const prior = json(path.join(root, metadata.prior_attempt.replace(/-metadata\.json$/, '-judge.json')));
    const withoutEvidence = value => {
      const copy = JSON.parse(JSON.stringify(value));
      for (const grade of [...Object.values(copy.dimensions), ...copy.checkpoints]) delete grade.evidence;
      return copy;
    };
    if (JSON.stringify(withoutEvidence(prior)) !== JSON.stringify(withoutEvidence(result))) {
      validation.valid = false;
      validation.errors.push({kind:'repair_changed_non_evidence', message:'Evidence repair changed grading fields; excluded.'});
    }
    validation.non_evidence_fields_preserved = !validation.errors.some(e => e.kind === 'repair_changed_non_evidence');
  }
  save(path.join(directory, entry.id + '-validation.json'), validation);
  return {
    id:entry.id, valid:validation.valid, status:validation.valid ? result.evaluation_status : 'validation_failed',
    validation, result, metadata,
    case_pass:validation.valid && result.evaluation_status === 'scored' ? pass(result) : null
  };
}

function loadLabels(entry) {
  const originalFile = path.join(__dirname, 'human-review', 'submissions', entry.id + '-submission-' + (entry.id === 'B07' ? '003' : '001') + '.json');
  const adjudicatedFile = path.join(__dirname, 'human-review', 'adjudications', entry.id + '-adjudication-001.json');
  const original = json(originalFile);
  const currentFile = fs.existsSync(adjudicatedFile) ? adjudicatedFile : originalFile;
  const current = json(currentFile);
  for (const value of [original, current]) {
    if (value.judge_input_sha256 !== entry.sha256) throw new Error('Label/evidence version mismatch: ' + entry.id);
    if (value.checkpoints.length !== entry.input.case.checkpoints.length) throw new Error('Label checkpoint mismatch: ' + entry.id);
  }
  return {original, current, files:[originalFile, currentFile].map(file => ({file:relative(file), sha256:hash(read(file))}))};
}

function compare(rows, labelKind) {
  const metrics = {dimensions:{matches:0, total:0}, checkpoints:{matches:0, total:0}, case_pass:{matches:0, total:0}, per_dimension:Object.fromEntries(dimensionKeys.map(k => [k, {matches:0, total:0}])), critical:{matches:0, total:0, positive_total:0, missed:0}, attribution:{matches:0, total:0}, differences:[], excluded:[]};
  for (const row of rows) {
    if (!row.valid || row.status !== 'scored') { metrics.excluded.push({case_id:row.id, reason:row.status}); continue; }
    const label = row.labels[labelKind];
    const judge = row.result;
    for (const key of dimensionKeys) {
      const humanScore = label.dimensions[key].score;
      if (![0, 1].includes(humanScore)) continue;
      const matched = humanScore === judge.dimensions[key].score;
      metrics.dimensions.total++; metrics.dimensions.matches += Number(matched);
      metrics.per_dimension[key].total++; metrics.per_dimension[key].matches += Number(matched);
      if (!matched) metrics.differences.push({case_id:row.id, item:key, human:humanScore, judge:judge.dimensions[key].score, judge_reason:judge.dimensions[key].reason});
    }
    label.checkpoints.forEach((checkpoint, i) => {
      if (![0, 1].includes(checkpoint.score)) return;
      const judged = judge.checkpoints[i];
      const matched = checkpoint.score === judged.score;
      metrics.checkpoints.total++; metrics.checkpoints.matches += Number(matched);
      if (!matched) metrics.differences.push({case_id:row.id, item:'checkpoint_' + checkpoint.index, human:checkpoint.score, judge:judged.score, judge_reason:judged.reason});
    });
    metrics.case_pass.total++; metrics.case_pass.matches += Number(pass(label) === row.case_pass);
    const critical = label.critical_failure.value;
    if (typeof critical === 'boolean') {
      metrics.critical.total++; metrics.critical.matches += Number(critical === judge.critical_failure);
      if (critical) { metrics.critical.positive_total++; metrics.critical.missed += Number(!judge.critical_failure); }
      if (critical !== judge.critical_failure) metrics.differences.push({case_id:row.id, item:'critical_failure', human:critical, judge:judge.critical_failure, judge_reason:judge.critical_reason});
    }
    if (!pass(label) && !row.case_pass && label.primary_failure_layer && judge.primary_failure_layer) {
      metrics.attribution.total++; metrics.attribution.matches += Number(label.primary_failure_layer === judge.primary_failure_layer);
    }
  }
  for (const value of [metrics.dimensions, metrics.checkpoints, metrics.case_pass, ...Object.values(metrics.per_dimension), metrics.critical, metrics.attribution]) value.rate = value.total ? value.matches / value.total : null;
  metrics.calibration_gate = {
    complete_six_valid_cases:metrics.case_pass.total === ids.length,
    dimensions_at_least_85_percent:metrics.dimensions.rate !== null && metrics.dimensions.rate >= .85,
    checkpoints_at_least_85_percent:metrics.checkpoints.rate !== null && metrics.checkpoints.rate >= .85,
    critical_positive_checked:metrics.critical.positive_total > 0,
    critical_misses:metrics.critical.missed
  };
  metrics.calibration_gate.passed = metrics.calibration_gate.complete_six_valid_cases && metrics.calibration_gate.dimensions_at_least_85_percent && metrics.calibration_gate.checkpoints_at_least_85_percent && metrics.calibration_gate.critical_positive_checked && !metrics.critical.missed;
  return metrics;
}

function sourceDirectory(id) {
  const repaired = initialDir + '-repair1';
  if (args.has('--repair-final') && fs.existsSync(path.join(repaired, id + '-metadata.json'))) return repaired;
  const retry = initialDir + '-retry1';
  return fs.existsSync(path.join(retry, id + '-metadata.json')) ? retry : initialDir;
}

function generateReport(prepared) {
  const rows = prepared.inputs.map(entry => {
    const directory = !fs.existsSync(path.join(outputDir, entry.id + '-metadata.json')) ? repairMode ? sourceDirectory(entry.id) : initialDir : outputDir;
    return {...evaluateSaved(entry, prepared, directory), result_directory:relative(directory), labels:loadLabels(entry)};
  });
  const attempts = [];
  for (const directory of version11 ? [initialDir] : [initialDir, initialDir + '-retry1', initialDir + '-repair1', initialDir + '-repair2']) {
    if (!fs.existsSync(directory)) continue;
    for (const entry of prepared.inputs) {
      const file = path.join(directory, entry.id + '-metadata.json');
      if (!fs.existsSync(file)) continue;
      const meta = json(file);
      const validationFile = path.join(directory, entry.id + '-validation.json');
      const validation = fs.existsSync(validationFile) ? json(validationFile) : null;
      attempts.push({case_id:entry.id, directory:relative(directory), mode:meta.mode || 'grading', parameters:meta.parameters,
        response_model:meta.response_model, status:meta.status, finish_reason:meta.finish_reason, duration_ms:meta.duration_ms,
        usage:meta.usage || null, validation_valid:validation?.valid ?? null, validation_errors:validation?.errors || [],
        metadata_file:relative(file), metadata_sha256:hash(read(file)),
        response_sha256:fs.existsSync(path.join(directory, entry.id + '-api-response.json')) ? hash(read(path.join(directory, entry.id + '-api-response.json'))) : null});
    }
  }
  const report = {
    created_at:new Date().toISOString(), prompt_version:promptVersion, requested_model:prepared.config.model,
    ...prepared.hashes, requested_cases:ids, valid_cases:rows.filter(x => x.valid && x.status === 'scored').map(x => x.id),
    original:compare(rows, 'original'), adjudicated:compare(rows, 'current'),
    attempts,
    attempt_summary:{requests:attempts.length, grading_requests:attempts.filter(x => x.mode === 'grading').length,
      evidence_repairs:attempts.filter(x => x.mode === 'evidence_format_repair_only').length,
      usage:attempts.reduce((total, x) => {
        for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens']) total[key] += x.usage?.[key] || 0;
        return total;
      }, {prompt_tokens:0, completion_tokens:0, total_tokens:0})},
    cases:rows.map(x => ({case_id:x.id, valid:x.valid, status:x.status, result_directory:x.result_directory, parameters:x.metadata?.parameters || null, response_model:x.metadata?.response_model || null, judge_dimensions:x.result ? Object.fromEntries(dimensionKeys.map(k => [k, x.result.dimensions?.[k]?.score])) : null, judge_checkpoints:x.result?.checkpoints?.map(p => p.score) || null, judge_case_pass:x.case_pass, judge_critical_failure:x.result?.critical_failure ?? null, primary_failure_layer:x.result?.primary_failure_layer ?? null, review_required:x.result?.review_required ?? null, review_reasons:x.result?.review_reasons || [], quote_count:x.validation?.quote_count || 0, validation_errors:x.validation?.errors || [], label_files:x.labels.files})),
    limitations:[
      'Six selected calibration cases, not the full 36-case set or a fixed-version benchmark.',
      'Judge uses the same configured model as the travel agent; not independent model validation.',
      'Human adjudications followed assistant feedback; not strict blind labels. Original and adjudicated comparisons are separate.',
      'Only B07 and A09 have current human critical labels; unknown flags are excluded, not treated as false.',
      'A09 is only one confirmed critical positive; no claim of general safety detection reliability.',
      'Most failure-layer labels are assistant analyses, not human labels. Human layer agreement has a small denominator.',
      'Manual form mapping and controlled events do not prove arbitrary natural-language input parsing.',
      'Exact quote validation checks provenance, not semantic grading correctness.',
      ...(version11 ? ['All six v1.1 first judgments use thinking disabled; no automatic retry or evidence repair.',
        'v1.1 includes rule clarifications and different thinking parameters from v1.0; observed changes cannot be attributed solely to the prompt.'] : [
        'Invalid first attempts are preserved. Retry1 only repeats invalid cases with thinking disabled; valid first results are reused and actual parameters remain per-case.',
        'Repair1 corrects invalid evidence refs/quotes only. All non-evidence judgment fields must remain unchanged; repaired outputs are marked and require semantic review.'])
    ]
  };
  save(path.join(outputDir, 'comparison.json'), report);
  const rate = value => value.rate === null ? '不可计算' : `${value.matches}/${value.total} (${(value.rate * 100).toFixed(1)}%)`;
  const lines = [
    '# 六条机评与人工标签比较', '',
    `模型：${prepared.config.model}；提示版本：${promptVersion}；有效评分：${report.valid_cases.length}/6。`, '',
    '这是同一份保存输出的评委校准，不是Agent重新运行或性能迭代。原分及讨论后的裁定分分别比较；人工裁定经过助手反馈，不是严格盲评。', '',
    '|指标|与原始人工分比较|与裁定分比较|', '|---|---|---|',
    ...[['四维一致率', 'dimensions'], ['检查点一致率', 'checkpoints'], ['任务通过判断一致率', 'case_pass'], ['关键失败标记一致率', 'critical'], ['人工主要层一致率', 'attribution']].map(([name, key]) => `|${name}|${rate(report.original[key])}|${rate(report.adjudicated[key])}|`), '',
    `讨论后人工关键失败正例核验：${report.adjudicated.critical.positive_total}条；漏报${report.adjudicated.critical.missed}条。未知标签不记为否。`, '',
    `校准门槛（裁定分）：${report.adjudicated.calibration_gate.passed ? '达到' : '未达到'}。要求六条有效、四维及检查点一致率各至少85%，且已确认关键失败不漏报。`, '',
    `请求模型名：${prepared.config.model}；服务端返回模型名：${[...new Set(attempts.map(x => x.response_model).filter(Boolean))].join('、')}。服务端别名仅如实记录，不推断实际版本。`, '',
    `本次共${report.attempt_summary.requests}次API请求：${report.attempt_summary.grading_requests}次评分请求，${report.attempt_summary.evidence_repairs}次仅修复证据引用。总token用量${report.attempt_summary.usage.total_tokens}，实际费用以服务商账单为准。`, '',
    '## 每条结果', '', '|案例|状态|D1 D2 D3 D4|检查点1 2 3|关键失败|主要层|', '|---|---|---|---|---|---|',
    ...report.cases.map(x => `|${x.case_id}|${x.status}|${x.judge_dimensions ? Object.values(x.judge_dimensions).join(' ') : '-'}|${x.judge_checkpoints?.join(' ') || '-'}|${x.judge_critical_failure === null ? '-' : x.judge_critical_failure ? '是' : '否'}|${x.primary_failure_layer || '-'}|`), '',
    '## 与裁定分的分歧', '',
    '|案例|项目|人工|机评|评委理由|', '|---|---|---|---|---|',
    ...report.adjudicated.differences.map(x => `|${x.case_id}|${x.item}|${x.human}|${x.judge}|${x.judge_reason.replace(/\|/g, '/').replace(/\r?\n/g, ' ')}|`), '',
    ...(report.adjudicated.differences.length ? [] : ['无有效评分格子的分歧。', '']),
    '## 排除及需复核', '',
    ...report.cases.filter(x => !x.valid || x.status !== 'scored').map(x => `- ${x.case_id}：${x.status}；原因见该条validation或metadata文件。`),
    ...report.cases.filter(x => x.review_required).map(x => `- ${x.case_id}评委要求复核：${x.review_reasons.join('；')}`), '',
    '## 方法限制', '',
    '只有六条定向校准样本。任务通过一致率在失败较多时可能很高，不能替代逐维和检查点比较。相同DeepSeek模型评审可能有共同偏差。原始运行来自不同版本及受控条件，不能用本报告冒充固定版本全量完成率。', '',
    '返回的整段文本严格解析为JSON，按原Schema校验，再检查引用路径和原文。不合格结果不进入一致率；不通过人工改写引用或评分来让结果合格。原始API响应、请求元数据、解析结果及校验记录分开保存。', '',
    ...(version11 ? ['本轮六条首评统一关闭思考，不自动重试或修复引用。无效结果单列排除，不进入一致率分母。', '',
      'v1.1同时包含规则澄清和思考参数变化，版本间差异不能全部归因于Prompt。未重跑旅行Agent，不能称Agent完成率提升。', ''] : [
      '首轮使用服务商默认思考模式。若使用retry1，只有无效结果重试，并关闭思考；首轮有效结果复用。因此各条参数可能不同，须按metadata核对，不能称为统一参数下的一次性六条成功。', '',
      '若使用repair1/repair2，只允许修改证据数组，分数、理由、故障层等全部字段逐项核对不变；修复失败的结果仍排除。修复请求只含原始运行证据、先前机评输出及校验错误，不含人工标签。', '']),
    '下一步先复核本次分歧；需要修改规则或Prompt时另存新版本，再复跑。不能为提高一致率把标签改成评委分数。'
  ];
  fs.writeFileSync(path.join(outputDir, 'report.md'), lines.join('\n') + '\n');
  console.log(JSON.stringify({output:relative(outputDir), valid:report.valid_cases.length, original_dimensions:rate(report.original.dimensions), adjudicated_dimensions:rate(report.adjudicated.dimensions), adjudicated_checkpoints:rate(report.adjudicated.checkpoints), critical_misses:report.adjudicated.critical.missed, gate_passed:report.adjudicated.calibration_gate.passed}));
}

async function main() {
  const prepared = prepare();
  if (args.has('--preflight')) {
    console.log(JSON.stringify({prompt_version:promptVersion, model:prepared.config.model, endpoint_host:new URL(prepared.config.endpoint).host, cases:prepared.inputs.map(x => x.id), input_hashes_verified:true, labels_not_sent:true, schema_compiled:true, parameters:runSettings?.parameters || null, ...prepared.hashes, api_calls:0}));
    return;
  }
  fs.mkdirSync(outputDir, {recursive:true});
  if (!args.has('--report')) {
    const manifestFile = path.join(outputDir, 'run-manifest.json');
    if (!fs.existsSync(manifestFile)) save(manifestFile, {
      created_at:new Date().toISOString(), prompt_version:promptVersion, model:prepared.config.model,
      ...prepared.hashes, inputs:prepared.inputs.map(({id, file, sha256}) => ({id, file, sha256})),
      automatic_retries:0, human_labels_sent:false,
      thinking:version11 || args.has('--retry-invalid') || repairMode ? 'disabled' : 'provider_default',
      ...(version11 ? {parameters:runSettings.parameters, human_label_files:prepared.labelFiles, assistant_analysis_sent:false} : {}),
      prior_run:args.has('--repair-final') ? relative(initialDir + '-repair1') : repairMode ? relative(initialDir + '-retry1') : args.has('--retry-invalid') ? relative(initialDir) : null,
      purpose:'Six-case judge calibration; original travel runs unchanged.'
    });
    for (const entry of prepared.inputs) {
      if (repairMode) {
        const prior = evaluateSaved(entry, prepared, sourceDirectory(entry.id));
        if (prior.valid && prior.status === 'scored') {
          console.log('Reuse valid result ' + entry.id);
          continue;
        }
        if (!prior.result) throw new Error('Cannot evidence-repair missing judgment: ' + entry.id);
      }
      if (args.has('--retry-invalid')) {
        const prior = evaluateSaved(entry, prepared, initialDir);
        if (prior.valid && prior.status === 'scored') {
          console.log('Reuse valid first result ' + entry.id);
          continue;
        }
      }
      console.log('Judging ' + entry.id);
      await requestJudge(entry, prepared);
      const saved = evaluateSaved(entry, prepared);
      console.log(JSON.stringify({case_id:entry.id, status:saved.status, valid:saved.valid, validation_errors:saved.validation?.errors?.length || 0}));
    }
  }
  generateReport(prepared);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
