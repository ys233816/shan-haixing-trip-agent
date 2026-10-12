'use strict';

const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const dir=path.join(__dirname,'agent-regressions','2026-10-12-weather');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const versions=['v1','v2','v3'].map(version=>read(path.join(dir,version,'results.json')));
for(const v of versions) {
  assert.equal(v.sha256,hash(path.join(dir,v.version,'index.snapshot.html')));
  assert.deepEqual(v.tests.map(t=>({id:t.id,description:t.description})),versions[0].tests.map(t=>({id:t.id,description:t.description})));
}
assert.equal(versions[2].sha256,hash(path.join(root,'index.html')));
const baseline=read(path.join(__dirname,'baseline-metrics.json'));
const historical=baseline.overallCollection;
const browser=read(path.join(dir,'browser-verification.json'));
assert.equal(browser.length,6);
assert.ok(browser.filter(r=>r.version==='v3').every(r=>r.activeNames.length===0&&r.restoredNames.length===0&&r.hasAlert&&!r.horizontalOverflow&&!r.errors.length));
const metrics={recordedAt:new Date().toISOString(),historicalBaseline:{source:'eval/baseline-metrics.json',passed:historical.passed,total:historical.total,taskCompletionRatePercent:historical.taskCompletionRatePercent,mainFailureLayer:'L3',l3Failures:historical.primaryFailureLayers.L3,allFailures:historical.failed,l3ShareOfFailuresPercent:Number((100*historical.primaryFailureLayers.L3/historical.failed).toFixed(2)),limitation:'混合历史版本、助手证据评分，不是冻结的全量V1'},targetedRegression:{method:'固定12条离线专项回归，代码函数断言，无付费API；A09另有六次桌面/移动浏览器验证',versions:versions.map(v=>({version:v.version,passed:v.passed,total:v.total,passRatePercent:v.passRatePercent,sha256:v.sha256})),v3VsV1GainPercentagePoints:Number((100*(versions[2].passed-versions[0].passed)/versions[0].total).toFixed(2)),v3FullDatasetTaskCompletionRatePercent:null,scope:'不可替代36条全量任务完成率，未运行当前Agent的全量机评或独立盲评'},a09AssistantEvidenceReview:{rater:'assistant_evidence_review_of_fixed_browser_replay',version:'v3',scores:{D1:1,D2:1,D3:1,D4:1},checkpoints:[1,1,1],criticalFailure:false,casePass:true,evidence:['三个原户外点实际移除，活动列表为空','保留休息时间，用户报告未独立核实，显示官方预警提示','页面、导出与刷新后的状态一致，未编造室内候选'],limitations:'受控A09回放，禁用模型API；不是独立用户复核，不能代表实时天气接口或完整规划链路成功率'},verification:{versionHashesMatch:true,sameTestDefinitions:true,finalCodeMatchesV3:true,browserRuns:browser.length,finalBrowserRunsPassed:2},sourceHashes:Object.fromEntries(['index.html','server.js','eval/test-cases.json','eval/rubric.md','eval/baseline-metrics.json','eval/run-weather-regression.cjs','eval/verify-weather-browser.cjs','eval/runs/2026-10-11-remaining/A09-before-adjustment.json'].map(file=>[file,hash(path.join(root,file))]))};
fs.writeFileSync(path.join(dir,'metrics.json'),JSON.stringify(metrics,null,2));
console.log(JSON.stringify({historical:metrics.historicalBaseline,versions:metrics.targetedRegression.versions.map(({sha256,...v})=>v),gain:metrics.targetedRegression.v3VsV1GainPercentagePoints,verification:metrics.verification},null,2));
