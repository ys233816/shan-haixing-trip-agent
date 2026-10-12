'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const project = path.resolve(__dirname, '..');
const runDir = path.join(__dirname, 'runs', '2026-10-11-remaining');
const destination = path.join(__dirname, 'judge-inputs', '2026-10-11');
const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'test-cases.json'), 'utf8').replace(/^\uFEFF/, ''));
const metadata = JSON.parse(fs.readFileSync(path.join(runDir, 'run-metadata.json'), 'utf8'));

const forbiddenKeys = new Set(['manualBaseline', 'scores', 'checkpointResults', 'dimensionEvidence', 'checkpointEvidence', 'casePass', 'scoringNotes', 'rater', 'reviews']);

function assertNoLabels(value) {
  if (Array.isArray(value)) { value.forEach(assertNoLabels); return; }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (forbiddenKeys.has(key)) throw new Error(`Scoring label leaked: ${key}`);
    assertNoLabels(item);
  }
}

function snapshot(value) {
  const network = (value.network || []).map(entry => ({
    path:entry.path, query:entry.query, method:entry.method || null, status:entry.status,
    request_body:entry.requestBody, response:entry.body, page_error:entry.pageError
  }));
  return {
    observed:{
      captured_at:value.capturedAt, form:value.form, status:value.status,
      invalid_fields:value.invalidFields, visible_result:value.visibleResult, page_text:value.pageText
    },
    internal_state:{request:value.request, plan:value.plan, day_summaries:value.daySummaries, budget:value.budget},
    network
  };
}

const manifest = {
  created_at:new Date().toISOString(), prompt_version:'judge-v1.0',
  purpose:'Blind evidence inputs only; no model evaluation performed.',
  original_run_hashes:metadata.hashes, ready:[], unavailable:[],
  note:'Historical 18 screenshot cases have no matching raw browser records in this run directory. Do not replace raw output with reviewer summaries.'
};
fs.mkdirSync(destination, {recursive:true});

for (const test of cases) {
  const sourcePath = path.join(runDir, `${test.id}-result.json`);
  if (!fs.existsSync(sourcePath)) {
    manifest.unavailable.push({id:test.id, reason:'No raw browser evidence in this run directory.'});
    continue;
  }
  const result = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
  if (result.status !== 'captured') throw new Error(`Uncaptured run: ${test.id}`);
  if (JSON.stringify(result.rawTurns) !== JSON.stringify(test.turns)) throw new Error(`Case/run mismatch: ${test.id}`);
  const snapshots = Object.fromEntries(result.turns.map((turn, index) => [`turn${index+1}`,snapshot(turn)]));
  if (result.beforeAdjustment) snapshots.before_adjustment = snapshot(result.beforeAdjustment);
  if (result.afterAdjustment) snapshots.after_adjustment = snapshot(result.afterAdjustment);
  const finalKey = result.afterAdjustment ? 'after_adjustment' : `turn${result.turns.length}`;
  const final = snapshots[finalKey];
  if (!final) throw new Error(`Missing final snapshot: ${test.id}`);
  const modelInvoked = final.network.some(entry => /^\/api\/llm\/(plan|react|adjust)$/.test(entry.path || ''));
  const payload = {
    schema_version:'judge-input-v1.0',
    case:{id:test.id, name:test.name, group:test.group, turns:test.turns, checkpoints:test.checkpoints},
    protocol:{
      execution:'Real browser submissions through the local form. Raw text copied to special requests; fields manually mapped by the harness.',
      auxiliary_inputs:result.auxiliaryInputs,
      final_snapshot:finalKey,
      scoring_scope:'Latest requirements and final result; earlier snapshots retained for continuity and limitations.',
      natural_language_field_updates_tested:false,
      form_blocked:final.observed.invalid_fields.length > 0,
      agent_model_invoked:modelInvoked,
      controlled_fixture:result.fixture || null,
      event_adapter:result.eventAdapter || null,
      source_record:path.relative(project,sourcePath).replace(/\\/g,'/'),
      snapshot_policy:'Full captured text retained. No reviewed summaries or pre-existing scores included.'
    },
    snapshots
  };
  assertNoLabels(payload);
  const data = JSON.stringify(payload,null,2) + '\n';
  const filename = `${test.id}.json`;
  fs.writeFileSync(path.join(destination,filename),data);
  manifest.ready.push({id:test.id, file:filename, bytes:Buffer.byteLength(data), sha256:crypto.createHash('sha256').update(data).digest('hex')});
}

fs.writeFileSync(path.join(destination,'manifest.json'),JSON.stringify(manifest,null,2) + '\n');
console.log(JSON.stringify({prepared:manifest.ready.length,unavailable:manifest.unavailable.length,output:path.relative(project,destination),labelLeakCheck:'passed',apiCalls:0}));
