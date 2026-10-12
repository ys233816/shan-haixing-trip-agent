'use strict';

const fs = require('node:fs');
const path = require('node:path');
const checks = require('./judge-validation.cjs');
const root = path.resolve(__dirname, '..');
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));

function main() {
  const [id, responseFile, outputFile] = process.argv.slice(2);
  if (!id || !responseFile || !outputFile) throw new Error('Usage: node eval/validate-judge-response.cjs CASE_ID wire-response.json validation.json');
  const config = json(path.join(__dirname, 'judge-v1.2-config.json'));
  if (!config.case_ids.includes(id)) throw new Error('Case is outside prepared calibration inputs');
  const preparedFile = path.join(root, config.prepared_directory, id + '.json');
  const prepared = json(preparedFile);
  const manifest = json(path.join(root, config.prepared_directory, 'manifest.json'));
  const entry = manifest.inputs.find(row => row.case_id === id);
  if (!entry || checks.sha256(fs.readFileSync(preparedFile)) !== entry.prepared_sha256) throw new Error('Prepared input changed');
  if (checks.sha256(fs.readFileSync(path.join(root, entry.source_file))) !== entry.source_sha256) throw new Error('Original input changed');
  for (const file of manifest.source_files) {
    if (checks.sha256(fs.readFileSync(path.join(root, file.file))) !== file.sha256) throw new Error('Prepared workflow changed: ' + file.file);
  }
  const responsePath = path.resolve(responseFile);
  const outputPath = path.resolve(outputFile);
  const within = path.relative(root, outputPath);
  if (within.startsWith('..') || path.isAbsolute(within) || fs.existsSync(outputPath)) throw new Error('Use a new output file inside this workspace');
  const raw = fs.readFileSync(responsePath, 'utf8');
  let result;
  try {
    result = checks.validateWireJudgment(JSON.parse(raw), prepared, json(path.join(root, config.canonical_schema_file)));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    result = {judgment:null, hard_valid:false, auto_accept:false, effective_review_required:true, hard_errors:[{code:'JSON_PARSE', message:'Entire response must be JSON; no extraction or repair.'}]};
  }
  const audit = {case_id:id, response_file:path.relative(root, responsePath).replace(/\\/g, '/'), response_sha256:checks.sha256(raw), prepared_input_sha256:entry.prepared_sha256, api_calls:0, ...result};
  fs.writeFileSync(outputPath, JSON.stringify(audit, null, 2) + '\n', {flag:'wx'});
  console.log(JSON.stringify({case_id:id, hard_valid:audit.hard_valid, auto_accept:audit.auto_accept, effective_review_required:audit.effective_review_required, output:path.relative(root, outputPath)}));
}

try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
