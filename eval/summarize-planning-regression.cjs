'use strict';

const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),dir=path.join(__dirname,'agent-regressions','2026-10-12-planning');
const read=file=>JSON.parse(fs.readFileSync(path.join(dir,file),'utf8'));
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const before=read('before/results.json'),after=read('after/release/results.json'),browser=read('browser-verification.json'),boundaries=read('boundary-checks.json'),weather=read('weather-nonregression-final/v3/results.json');
assert.equal(after.sha256,hash(path.join(root,'index.html')));
assert.equal(after.sha256,browser.versions.find(v=>v.version==='after').sha256);
assert.equal(after.sha256,boundaries.sha256);assert.equal(after.sha256,weather.sha256);
assert.deepEqual(before.tests.map(t=>[t.id,t.description]),after.tests.map(t=>[t.id,t.description]));
assert.equal(before.sha256,hash(path.join(dir,'before/index.snapshot.html')));
assert.equal(after.sha256,hash(path.join(dir,'after/release/index.snapshot.html')));
const evidence=(version,id)=>read(`${version}/browser/${id}-desktop.json`);
const a11Before=evidence('before','A11'),a11After=evidence('after','A11'),wheelBefore=evidence('before','B07'),wheelAfter=evidence('after','B07');
const metrics={recordedAt:new Date().toISOString(),iteration:'initial-plan-constraints-2026-10-12',scope:'首次规划时长、步行、轮椅提示、天气候选和夜游时段专项；不覆盖全部36条任务',primaryFailureLayer:'L3',fixedRegression:{total:after.total,beforePassed:before.passed,afterPassed:after.passed,beforeRatePercent:before.passRatePercent,afterRatePercent:after.passRatePercent,gainPercentagePoints:Number(((after.passed-before.passed)*100/after.total).toFixed(2)),newlyPassingCaseIds:after.tests.filter(t=>t.pass&&!before.tests.find(b=>b.id===t.id).pass).map(t=>t.id),method:after.method},browserVerification:{method:browser.method,versions:browser.versions,gainPercentagePoints:80,note:'5个场景×2种视口，共10次验证/版本；不是10条独立用户需求'},examples:{A11:{source:'eval/runs/2026-10-11-remaining/A11-turn1.json',beforeDay1Hours:a11Before.hours[0],afterDay1Hours:a11After.hours[0],overEightHoursDaysBefore:a11Before.hours.filter(h=>h>8).length,overEightHoursDaysAfter:a11After.hours.filter(h=>h>8).length},B07:{beforeStopsPerDay:wheelBefore.plan.daily.map(d=>d.items.length),afterStopsPerDay:wheelAfter.plan.daily.map(d=>d.items.length),accessibilityNoticeVisible:true,accessibilityConfirmed:false},controlledNight:{before:evidence('before','night').times[0],after:evidence('after','night').times[0],realOfficialHoursVerified:false}},additionalBoundaries:{passed:boundaries.passed,total:boundaries.total,note:boundaries.method},previousWeatherRegression:{passed:weather.passed,total:weather.total,unchangedWeatherSafetyChecksPassed:11,legacyExpectationConflict:'R12旧断言要求大模型少排后仍补齐每日数量，本轮明确改为保留模型缓冲；原分保留，不改断言追求100%'},full36CaseTaskCompletionRate:null,limitations:['固定受控专项，未重新运行真实大模型、天气和路线网络调用。','5个浏览器场景为A11、B07、A08事件前草稿和2个受控场景；没有冒称T04等原样全链路重跑。','夜游18:00/22:00为保守建议，不是实时官方开放时间；少步行按知识库等级，不是精确里程；无障碍尚未官方确认。','偏好落实、跨城市、缺项澄清、人均预算、住宿晚数、实时票务以及评委一致率仍待后续迭代。'],sha256:{before:before.sha256,after:after.sha256,runner:hash(path.join(__dirname,'run-planning-regression.cjs'))}};
fs.writeFileSync(path.join(dir,'metrics.json'),JSON.stringify(metrics,null,2));
console.log(JSON.stringify({fixedRegression:metrics.fixedRegression,browser:metrics.browserVerification.versions,examples:metrics.examples,weather:metrics.previousWeatherRegression},null,2));
