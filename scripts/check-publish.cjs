'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const git = args => cp.execFileSync('git', args, {cwd: root});
const files = git(['ls-files', '-z']).toString('utf8').split('\0').filter(Boolean);
const envPath = path.join(root, '.env');
const env = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
const secrets = env.split(/\r?\n/)
  .map(line => line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/))
  .filter(match => match && /KEY|TOKEN|SECRET|PASSWORD/.test(match[1]) && match[2].length >= 8)
  .map(match => match[2].replace(/^['"]|['"]$/g, ''));
const findings = [];
let bytes = 0;

// Inspect the index so the audit covers exactly the content being committed.
for (const file of files) {
  const blob = git(['show', ':' + file]);
  bytes += blob.length;
  const text = blob.toString('utf8');
  if (secrets.some(secret => text.includes(secret)) || /(?:sk-[a-zA-Z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/.test(text)) {
    findings.push({file, reason: 'possible credential'});
  }
  if (/^(artifacts\/|\.env$)|(^|\/)node_modules\/|\.(?:docx|pdf|png|jpe?g)$/i.test(file)) {
    findings.push({file, reason: 'excluded file'});
  }
}

const html = git(['show', ':index.html']).toString('utf8');
for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
console.log(JSON.stringify({stagedFiles: files.length, stagedBytes: bytes,
  credentialValuesChecked: secrets.length, findings, frontendSyntax: 'passed'}, null, 2));
if (findings.length) process.exitCode = 1;
