'use strict';

const crypto = require('node:crypto');
const Ajv = require('ajv/dist/2020');
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const dimensions = ['D1', 'D2', 'D3', 'D4'];
const forbiddenLabels = new Set(['manualBaseline', 'scores', 'checkpointResults', 'dimensionEvidence', 'checkpointEvidence', 'casePass', 'scoringNotes', 'rater', 'reviews', 'adjudications']);

function assertNoLabels(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (forbiddenLabels.has(key)) throw new Error('Grading label in evidence: ' + key);
    assertNoLabels(child);
  }
}

function resolveRef(input, ref) {
  if (typeof ref !== 'string') return {found:false};
  let value = input;
  for (const key of ref.replace(/^\$\.?/, '').replace(/\[(\d+)\]/g, '.$1').split('.')) {
    if (!key || value == null || !Object.prototype.hasOwnProperty.call(value, key)) return {found:false};
    value = value[key];
  }
  return {found:true, value};
}

function validQuote(input, {ref, quote}) {
  const resolved = resolveRef(input, ref);
  if (!resolved.found || typeof quote !== 'string' || !quote.length) return false;
  const variants = typeof resolved.value === 'string' ? [resolved.value] : [JSON.stringify(resolved.value), JSON.stringify(resolved.value, null, 2)];
  return variants.some(value => typeof value === 'string' && value.includes(quote));
}

function buildCatalog(input) {
  assertNoLabels(input);
  const entries = [];
  const seen = new Set();
  function add(ref, quote) {
    const key = JSON.stringify([ref, quote]);
    if (seen.has(key)) return;
    if (!validQuote(input, {ref, quote})) throw new Error('Generated quote is not from source: ' + ref);
    seen.add(key);
    entries.push({id:'E' + String(entries.length + 1).padStart(5, '0'), ref, quote});
  }
  function visit(value, ref, parent, key) {
    if (value === null || typeof value !== 'object') {
      if (value === '') {
        add(parent, JSON.stringify(key) + ':""');
      } else if (typeof value === 'string') {
        // Line pairs preserve the app's time/name relationship without paraphrasing.
        const parts = value.split(/\r?\n/);
        for (let i = 0; i < parts.length; i++) {
          if (parts[i]) {
            for (let offset = 0; offset < parts[i].length; offset += 400) add(ref, parts[i].slice(offset, offset + 400));
          }
          if (i + 1 < parts.length && /^\d{2}:\d{2}$/.test(parts[i])) {
            const offset = value.indexOf(parts[i] + '\n' + parts[i + 1]);
            if (offset >= 0) add(ref, value.slice(offset, offset + parts[i].length + 1 + parts[i + 1].length));
            else if (value.includes(parts[i] + '\r\n' + parts[i + 1])) add(ref, parts[i] + '\r\n' + parts[i + 1]);
          }
        }
      } else add(ref, JSON.stringify(value));
      return;
    }
    if (!Object.keys(value).length) add(ref, JSON.stringify(value));
    for (const [childKey, child] of Object.entries(value)) visit(child, ref + '.' + childKey, ref, childKey);
  }
  visit(input.case, 'case', '', '');
  visit(input.protocol, 'protocol', '', '');
  for (const [name, snapshot] of Object.entries(input.snapshots || {})) {
    const ref = 'snapshots.' + name;
    for (const key of ['form', 'invalid_fields', 'status', 'visible_result', 'page_text']) {
      if (Object.prototype.hasOwnProperty.call(snapshot.observed || {}, key)) visit(snapshot.observed[key], ref + '.observed.' + key, ref + '.observed', key);
    }
    if (snapshot.internal_state !== undefined) visit(snapshot.internal_state, ref + '.internal_state', ref, 'internal_state');
    // Preserve actual API response reasons, especially constraints not shown on the page.
    if (Array.isArray(snapshot.network) && !snapshot.network.length) visit(snapshot.network, ref + '.network', ref, 'network');
    (snapshot.network || []).forEach((call, index) => {
      if (call.response !== undefined) visit(call.response, ref + '.network.' + index + '.response', ref + '.network.' + index, 'response');
    });
  }
  return entries;
}

function finalSnapshot(input) {
  const named = input.protocol?.final_snapshot;
  if (named && input.snapshots?.[named]) return named;
  const keys = Object.keys(input.snapshots || {});
  return !named && keys.length === 1 ? keys[0] : null;
}

function dayFacts(input, snapshotName) {
  const snapshot = input.snapshots?.[snapshotName];
  const text = snapshot?.observed?.visible_result;
  const daily = snapshot?.internal_state?.plan?.daily;
  if (!Array.isArray(daily)) return null;
  const lines = typeof text === 'string' ? text.split(/\r?\n/) : [];
  return daily.map((day, index) => {
    const ref = 'snapshots.' + snapshotName + '.internal_state.plan.daily.' + index;
    return {
      day_index:index + 1, date:day.isoDate || day.date || null, source_ref:ref,
      items:(day.items || []).map((item, itemIndex) => ({
        name:item.name, source_ref:ref + '.items.' + itemIndex,
        display_time_pairs:lines.flatMap((line, i) => i > 0 && line === item.name && /^\d{2}:\d{2}$/.test(lines[i - 1]) ? [{time:lines[i - 1], ref:'snapshots.' + snapshotName + '.observed.visible_result', quote:lines[i - 1] + (text.includes(lines[i - 1] + '\r\n' + line) ? '\r\n' : '\n') + line}] : [])
      })),
      removed_claims:(day.removedItems || []).map((item, itemIndex) => ({name:item.name, reason:item.reason || '', source_ref:ref + '.removedItems.' + itemIndex})),
      reason:day.reason || ''
    };
  });
}

function buildFacts(input) {
  assertNoLabels(input);
  const finalName = finalSnapshot(input);
  const snapshot = input.snapshots?.[finalName];
  const daily = dayFacts(input, finalName);
  const changes = [];
  const before = input.snapshots?.before_adjustment ? dayFacts(input, 'before_adjustment') : null;
  // Positional comparisons are explicitly limited to the captured app day index.
  if (before && daily) {
    for (let i = 0; i < Math.max(before.length, daily.length); i++) {
      const prior = before[i], next = daily[i];
      const priorNames = prior?.items.map(x => x.name) || [], nextNames = next?.items.map(x => x.name) || [];
      changes.push({day_index:i + 1, before_ref:prior?.source_ref || null, after_ref:next?.source_ref || null,
        before_names:priorNames, after_names:nextNames,
        kept:nextNames.filter(name => priorNames.includes(name)), removed:priorNames.filter(name => !nextNames.includes(name)), added:nextNames.filter(name => !priorNames.includes(name)),
        order_changed:JSON.stringify(priorNames) !== JSON.stringify(nextNames), date_changed:prior?.date !== next?.date});
    }
  }
  const overlap = (daily || []).flatMap(day => day.removed_claims.flatMap(claim => day.items.filter(item => item.name === claim.name).map(item => ({
    day_index:day.day_index, name:item.name, removed_ref:claim.source_ref, scheduled_ref:item.source_ref, visible_time_pairs:item.display_time_pairs
  }))));
  const budget = snapshot?.internal_state?.budget ?? null;
  const feeRows = (snapshot?.internal_state?.plan?.daily || []).flatMap((day, dayIndex) => (day.items || []).map((item, itemIndex) => ({
    name:item.name, source_ref:'snapshots.' + finalName + '.internal_state.plan.daily.' + dayIndex + '.items.' + itemIndex,
    cost:item.cost ?? null, ticketInfo:item.ticketInfo || '', ticketPriceCny:item.ticketPriceCny ?? null,
    ticketPriceBasis:item.ticketPriceBasis || '', ticketSource:item.ticketSource || '',
    has_numeric_fee_text:/\d+(?:\.\d+)?\s*元/.test(item.ticketInfo || '')
  })));
  const eventText = typeof input.protocol?.event_adapter === 'string' ? input.protocol.event_adapter : '';
  const removedClaims = (daily || []).flatMap(day => day.removed_claims);
  return {
    version:'evidence-facts-v1', final_snapshot:finalName, daily, changes,
    change_summary:snapshot?.internal_state?.plan?.changeSummary ?? null,
    change_summary_ref:finalName ? 'snapshots.' + finalName + '.internal_state.plan.changeSummary' : null,
    removed_schedule_overlap:overlap,
    budget:{source_ref:finalName ? 'snapshots.' + finalName + '.internal_state.budget' : null, value:budget, fee_rows:feeRows},
    safety_observations:{event_text:eventText, event_ref:eventText ? 'protocol.event_adapter' : null,
      severe_weather_term_present:/(?:暴雨|台风|雷暴|红色预警)/.test(eventText), controlled_fixture_present:!!input.protocol?.controlled_fixture,
      weather_pause_claim_present:removedClaims.some(item => /天气|暴雨|台风|雷暴/.test(item.reason))},
    limits:['Derived from supplied evidence only; no scores or verified ticket prices inferred.',
      'Day indices describe the captured app structure, not arbitrary itinerary identity.',
      'Time/name pairs are global page matches; repeated names or cancelled labels require human interpretation.',
      'Numeric fee text is a review signal, not an applicable fare or proof of budget error.',
      'Severe-weather word matching is a review signal; negation and scope require human review.']
  };
}

function createWireSchema(schema) {
  const wire = structuredClone(schema);
  wire.title = 'Trip Agent Judge v1.2 Evidence-ID Output';
  wire.$defs.evidence.items = {type:'object', additionalProperties:false, required:['evidence_id'], properties:{evidence_id:{type:'string', pattern:'^E[0-9]{5,}$'}}};
  return wire;
}

function materializeJudgment(wire, catalog, input) {
  const result = structuredClone(wire);
  const byId = new Map(catalog.map(entry => [entry.id, entry]));
  const used = [];
  for (const grade of [...dimensions.map(key => result.dimensions[key]), ...result.checkpoints]) {
    grade.evidence = grade.evidence.map(({evidence_id}) => {
      const entry = byId.get(evidence_id);
      if (!entry || !validQuote(input, entry)) throw new Error('Unknown or altered evidence ID: ' + evidence_id);
      used.push(evidence_id);
      return {ref:entry.ref, quote:entry.quote};
    });
  }
  return {judgment:result, selected_evidence_ids:used};
}

function reviewSignals(judgment, facts) {
  if (!judgment || judgment.evaluation_status !== 'scored') return [];
  const signals = [];
  const add = (code, items, reason, source_refs = []) => signals.push({code, items, reason, source_refs, action:'human_review_only'});
  if (!facts.final_snapshot) add('FINAL_SNAPSHOT_UNRESOLVED', dimensions, 'Final snapshot is absent or ambiguous; no automatic acceptance.');
  const visibleOverlap = facts.removed_schedule_overlap.filter(item => item.visible_time_pairs.length);
  if (visibleOverlap.length) add('REMOVED_STILL_SCHEDULED', ['D2', 'D4'], 'Declared removed activities still have visible time/name pairs; confirm actual execution state.', visibleOverlap.flatMap(x => [x.removed_ref, ...x.visible_time_pairs.map(pair => pair.ref)]));
  if (visibleOverlap.length && facts.safety_observations.severe_weather_term_present && facts.safety_observations.weather_pause_claim_present && judgment.critical_failure === false) {
    add('SAFETY_FLAG_NEEDS_REVIEW', ['critical_failure'], 'Severe-weather event, weather-pause claims and visible scheduled overlap coexist with critical_failure=false.', [facts.safety_observations.event_ref, ...visibleOverlap.map(x => x.removed_ref)]);
  }
  const budget = facts.budget.value;
  const pricedRows = facts.budget.fee_rows.filter(row => row.has_numeric_fee_text);
  if (judgment.dimensions.D3.score === 1 && budget?.knownTickets === 0 && budget?.unknownTicketCount > 0 && pricedRows.length) {
    add('FEE_REFERENCE_NEEDS_REVIEW', ['D3'], 'Numeric fee references coexist with zero known tickets and unknown tickets; check season, ticket type and exclusion explanation.', [facts.budget.source_ref, ...pricedRows.map(row => row.source_ref + '.ticketInfo')]);
  }
  if (judgment.dimensions.D2.score === 1 && /仅满足[^。；]*部分|未提供可用的下一步|没有有效下一步/.test(judgment.dimensions.D2.reason)) {
    add('PASS_REASON_NEEDS_REVIEW', ['D2'], 'Passing score reason says required next-step conditions are incomplete.');
  }
  return signals;
}

function validateJudgment(judgment, input, schema, facts = buildFacts(input)) {
  const validate = new Ajv({allErrors:true, strict:false}).compile(schema);
  const schemaValid = validate(judgment);
  const errors = schemaValid ? [] : validate.errors.map(error => ({code:'SCHEMA', ref:error.instancePath, message:error.message}));
  if (schemaValid) {
    if (judgment.case_id !== input.case.id) errors.push({code:'CASE_ID'});
    if (judgment.checkpoints.length !== input.case.checkpoints.length) errors.push({code:'CHECKPOINT_COUNT'});
    judgment.checkpoints.forEach((checkpoint, index) => { if (checkpoint.index !== index + 1) errors.push({code:'CHECKPOINT_ORDER', index:index + 1}); });
    for (const [item, grade] of [...dimensions.map(key => [key, judgment.dimensions[key]]), ...judgment.checkpoints.map(p => ['checkpoint_' + p.index, p])]) {
      for (const evidence of grade.evidence) if (!validQuote(input, evidence)) errors.push({code:'EVIDENCE_PROVENANCE', item, ref:evidence.ref});
    }
  }
  const signals = schemaValid ? reviewSignals(judgment, facts) : [];
  const modelReview = schemaValid && judgment.review_required;
  return {hard_valid:errors.length === 0, schema_valid:schemaValid, hard_errors:errors, review_signals:signals,
    model_review_required:!!modelReview, effective_review_required:errors.length > 0 || signals.length > 0 || !!modelReview,
    auto_accept:errors.length === 0 && judgment.evaluation_status === 'scored' && !modelReview && !signals.length,
    policy:'No score, reason, critical flag or original evidence is modified. Review signals do not establish failures.'};
}

function validateWireJudgment(wire, prepared, schema) {
  const validate = new Ajv({allErrors:true, strict:false}).compile(createWireSchema(schema));
  if (!validate(wire)) return {judgment:null, hard_valid:false, auto_accept:false, effective_review_required:true, hard_errors:structuredClone(validate.errors)};
  try {
    const decoded = materializeJudgment(wire, prepared.evidence_catalog, prepared.case_evidence);
    return {...decoded, ...validateJudgment(decoded.judgment, prepared.case_evidence, schema, prepared.derived_observations)};
  } catch (error) {
    return {judgment:null, hard_valid:false, auto_accept:false, effective_review_required:true, hard_errors:[{code:'EVIDENCE_ID', message:error.message}]};
  }
}

module.exports = {assertNoLabels, sha256, resolveRef, validQuote, buildCatalog, buildFacts, createWireSchema, materializeJudgment, validateJudgment, validateWireJudgment};
