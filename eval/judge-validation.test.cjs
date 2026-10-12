'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const checks = require('./judge-validation.cjs');
const json = file => JSON.parse(fs.readFileSync(path.join(__dirname, file), 'utf8'));
const input = id => json('judge-inputs/2026-10-11/' + id + '.json');
const judgment = id => json('judge-runs/2026-10-12-judge-v1.1/' + id + '-judge.json');
const schema = json('judge-output.schema.json');

test('all six source catalogs contain exact original excerpts without grading labels', () => {
  for (const id of ['B07', 'B09', 'A01', 'A03', 'A08', 'A09']) {
    const source = input(id);
    const before = JSON.stringify(source);
    const catalog = checks.buildCatalog(source);
    assert.equal(new Set(catalog.map(row => row.id)).size, catalog.length);
    assert.ok(catalog.length > 0);
    assert.ok(catalog.every(row => checks.validQuote(source, row)));
    checks.assertNoLabels({case_evidence:source, evidence_catalog:catalog, derived_observations:checks.buildFacts(source)});
    assert.equal(JSON.stringify(source), before);
  }
});

test('empty string citations use their real parent; an observed internal-state path is invalid', () => {
  const source = input('A01');
  const row = checks.buildCatalog(source).find(item => item.ref === 'snapshots.turn1.observed' && item.quote === '"visible_result":""');
  assert.ok(row);
  assert.ok(checks.validQuote(source, row));
  assert.equal(checks.resolveRef(source, 'snapshots.turn1.observed.internal_state').found, false);
  assert.equal(checks.validQuote(source, {ref:'snapshots.turn1.observed.visible_result', quote:'"visible_result":""'}), false);
});

test('wire evidence IDs map to source without changing grading fields; invented IDs fail', () => {
  const source = input('B09'), catalog = checks.buildCatalog(source);
  const original = judgment('B09'), wire = structuredClone(original);
  const groups = value => [...Object.values(value.dimensions), ...value.checkpoints];
  for (const group of groups(wire)) group.evidence = [{evidence_id:catalog.find(row => row.ref === 'snapshots.turn1.observed.visible_result').id}];
  const prepared = {case_evidence:source, evidence_catalog:catalog, derived_observations:checks.buildFacts(source)};
  const output = checks.validateWireJudgment(wire, prepared, schema);
  assert.equal(output.hard_valid, true);
  const withoutEvidence = value => { const result = structuredClone(value); groups(result).forEach(group => delete group.evidence); return result; };
  assert.deepEqual(withoutEvidence(output.judgment), withoutEvidence(wire));
  wire.dimensions.D1.evidence[0].evidence_id = 'E99999';
  assert.equal(checks.validateWireJudgment(wire, prepared, schema).hard_valid, false);
  wire.dimensions.D1.evidence[0] = {ref:'snapshots.turn1', quote:'invented'};
  assert.equal(checks.validateWireJudgment(wire, prepared, schema).hard_valid, false);
});

test('actual day changes distinguish kept 景山 from newly added 圆明园', () => {
  const facts = checks.buildFacts(input('A08'));
  assert.deepEqual(facts.changes[0].added, []);
  assert.deepEqual(facts.changes[0].removed, []);
  assert.deepEqual(facts.changes[1].kept, ['景山公园']);
  assert.deepEqual(facts.changes[1].removed, ['故宫博物院']);
  assert.deepEqual(facts.changes[1].added, ['圆明园遗址公园']);
});

test('weather pause contradiction queues review without rewriting critical flag or score', () => {
  const source = input('A09'), result = judgment('A09');
  const before = JSON.stringify(result);
  const facts = checks.buildFacts(source);
  assert.deepEqual(facts.removed_schedule_overlap.map(row => row.name), ['厦门大学思明校区周边', '鼓浪屿']);
  assert.ok(!facts.removed_schedule_overlap.some(row => row.name === '厦门园林植物园'));
  const audit = checks.validateJudgment(result, source, schema, facts);
  assert.equal(audit.hard_valid, true);
  assert.equal(audit.auto_accept, false);
  assert.ok(audit.review_signals.some(row => row.code === 'SAFETY_FLAG_NEEDS_REVIEW'));
  assert.equal(result.critical_failure, false);
  assert.equal(JSON.stringify(result), before);
});

test('ordinary rain or actual removal does not trigger severe-weather flag review', () => {
  const source = input('A09'), result = judgment('A09');
  source.protocol.event_adapter = '第1天普通小雨。';
  assert.ok(!checks.validateJudgment(result, source, schema).review_signals.some(row => row.code === 'SAFETY_FLAG_NEEDS_REVIEW'));
  source.protocol.event_adapter = '第1天暴雨。';
  source.snapshots.after_adjustment.internal_state.plan.daily[0].items = [];
  assert.ok(!checks.validateJudgment(result, source, schema).review_signals.some(row => row.code === 'SAFETY_FLAG_NEEDS_REVIEW'));
});

test('fee references are review signals, never computed fares or automatic score changes', () => {
  const source = input('B07'), result = judgment('B07');
  const facts = checks.buildFacts(source);
  const audit = checks.validateJudgment(result, source, schema, facts);
  assert.ok(audit.review_signals.some(row => row.code === 'FEE_REFERENCE_NEEDS_REVIEW'));
  assert.equal(result.dimensions.D3.score, 1);
  for (const item of source.snapshots.turn1.internal_state.plan.daily.flatMap(day => day.items)) item.ticketInfo = '公共区域免费；收费项目待核实。';
  assert.ok(!checks.validateJudgment(result, source, schema).review_signals.some(row => row.code === 'FEE_REFERENCE_NEEDS_REVIEW'));
});

test('known malformed judgment is hard invalid and cannot become accepted by soft checks', () => {
  const source = input('A01'), result = judgment('A01');
  const audit = checks.validateJudgment(result, source, schema);
  assert.equal(audit.hard_errors.length, 6);
  assert.equal(audit.auto_accept, false);
  assert.ok(audit.review_signals.some(row => row.code === 'PASS_REASON_NEEDS_REVIEW'));
  const malformed = {...result, unexpected_key:true};
  assert.equal(checks.validateJudgment(malformed, source, schema).schema_valid, false);
});

test('label contamination and ambiguous final snapshot are never silently accepted', () => {
  assert.throws(() => checks.buildCatalog({...input('A01'), scores:{D1:1}}), /Grading label/);
  const source = input('A08');
  delete source.protocol.final_snapshot;
  assert.equal(checks.buildFacts(source).final_snapshot, null);
  source.protocol.final_snapshot = 'missing_capture';
  assert.equal(checks.buildFacts(source).final_snapshot, null);
  const audit = checks.validateJudgment(judgment('A08'), source, schema);
  assert.equal(audit.auto_accept, false);
  assert.ok(audit.review_signals.some(row => row.code === 'FINAL_SNAPSHOT_UNRESOLVED'));
});
