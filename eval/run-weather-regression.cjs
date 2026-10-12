'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.join(__dirname, 'agent-regressions', process.argv.includes('--preferences') ? '2026-10-12-preferences/weather-nonregression' : process.argv.includes('--budget') ? '2026-10-12-budget/weather-nonregression' : process.argv.includes('--planning-final') ? '2026-10-12-planning/weather-nonregression-final' : process.argv.includes('--planning') ? '2026-10-12-planning/weather-nonregression' : '2026-10-12-weather');
const version = process.argv[2];
if (!['v1', 'v2', 'v3'].includes(version)) throw new Error('Usage: node eval/run-weather-regression.cjs v1|v2|v3');
const dir = path.join(output, version, process.argv.includes('--verified') ? 'verified' : process.argv.includes('--release') ? 'release' : '.');
if (fs.existsSync(dir)) throw new Error('Version already frozen; use a new run directory to preserve evidence.');
fs.mkdirSync(dir, {recursive:true});
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
fs.writeFileSync(path.join(dir, 'index.snapshot.html'), html);
const original = JSON.parse(fs.readFileSync(path.join(__dirname, 'runs/2026-10-11-remaining/A09-before-adjustment.json')));
const node = () => ({addEventListener(){}, classList:{add(){},remove(){}}, querySelector:node, querySelectorAll:()=>[], replaceChildren(){}});
const storage = () => ({getItem:()=>null,setItem(){},removeItem(){}});
const context = vm.createContext({document:{querySelector:node},localStorage:storage(),sessionStorage:storage(),console,URL,URLSearchParams,Blob});
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
vm.runInContext(script.slice(0, script.indexOf("    form.addEventListener('submit'")), context);
function call(name, ...args) { context.args = args; return vm.runInContext(`${name}(...args)`, context); }
const clone = value => JSON.parse(JSON.stringify(value));
const outdoor = clone(original.plan.daily[0].items[0]);
const indoor = {...outdoor,name:'受控测试室内候选',indoor:'室内',rain:'高',backup:''};
const mixed = {...outdoor,name:'受控测试室外含展馆候选',indoor:'室外为主，含室内展馆',rain:'中'};
const unconfirmed = {...outdoor,name:'受控测试未知环境候选',indoor:'未注明',rain:'中'};
function fixture(items=[outdoor], candidates=[outdoor], days=1) {
  const request = {...clone(original.request),days};
  const plan = {...clone(original.plan),candidates:clone(candidates),daily:clone(original.plan.daily.slice(0,1))};
  plan.daily[0].items = clone(items);
  delete plan.changeSummary;
  delete plan.daily[0].removedItems;
  delete plan.daily[0].eventAlert;
  if (days > 1) plan.daily.push({...clone(plan.daily[0]),date:'第 2 天',items:[{...indoor,name:'受控测试第二天已排景点'}]});
  return {request,plan};
}
function adjust(f, observation='第1天暴雨', mode='local', replacementId=null) {
  const result = mode === 'local' ? call('adjustPlanForEvent',f.request,f.plan,observation)
    : call('applyLlmAdjustment',f.plan,call('findAdjustmentContext',f.plan,observation),replacementId,observation,'受控测试模型');
  call('enforceUniqueDailyAttractions',f.request,result.plan);
  return result.plan;
}
const tests = [];
function test(id,description,run) {
  let evidence;
  try { evidence = run(); tests.push({id,description,pass:true,evidence}); }
  catch (error) {tests.push({id,description,pass:false,error:error.message});}
}
test('R01','A09原失败场景：三处户外、无室内候选，真正暂停且提示预警',()=>{
  const p = adjust({request:clone(original.request),plan:clone(original.plan)},'第1天厦门暴雨，原行程里三个户外点，附近没有可确认的室内景点。');
  assert.equal(p.daily[0].items.length,0);
  assert.equal(p.daily[0].removedItems.length,3);
  assert.match(p.daily[0].eventAlert || '',/预警/);
  return {items:p.daily[0].items,removed:p.daily[0].removedItems,alert:p.daily[0].eventAlert};
});
test('R02','没有日期/预报时，暴雨后不新增其他户外候选',()=>{
  const extra={...outdoor,name:'受控测试另一个户外候选'};
  const p=adjust(fixture([outdoor],[outdoor,extra]));
  assert.equal(p.daily[0].items.length,0);
  return p.daily[0];
});
test('R03','室外为主但含展馆的条目不作为可避暴雨替代',()=>{
  const p=adjust(fixture([outdoor],[outdoor,mixed]));
  assert.equal(p.daily[0].items.length,0);
  return p.daily[0];
});
test('R04','真实室内候选可替换，但不得靠补齐重新排户外',()=>{
  const p=adjust(fixture([outdoor],[outdoor,indoor]));
  assert.deepEqual(clone(p.daily[0].items.map(x=>x.name)),[indoor.name]);
  return p.daily[0];
});
test('R05','调整第1天时，未满景点数的第2天也保持原样',()=>{
  const f=fixture([outdoor],[outdoor,{...outdoor,name:'受控测试剩余户外候选'}],2);
  const before=JSON.stringify(f.plan.daily[1]);
  const p=adjust(f);
  assert.equal(JSON.stringify(p.daily[1]),before);
  return p.daily[1];
});
test('R06','重新渲染不再次补回已暂停的景点',()=>{
  const f={request:clone(original.request),plan:clone(original.plan)};
  const p=adjust(f);
  const before=JSON.stringify(p);
  for(let i=0;i<3;i++) call('enforceUniqueDailyAttractions',f.request,p);
  assert.equal(p.daily[0].items.length,0);
  assert.equal(JSON.stringify(p),before);
  return p.daily[0];
});
test('R07','旧会话中“已暂缓”与活动重复时移除活动，保留暂停',()=>{
  const f=fixture();
  f.plan.daily[0].removedItems=[{name:outdoor.name,reason:'按暴雨反馈暂缓'}];
  f.plan.changeSummary='户外景点已暂缓';
  call('enforceUniqueDailyAttractions',f.request,f.plan);
  assert.equal(f.plan.daily[0].items.length,0);
  return f.plan.daily[0];
});
test('R08','闭馆且无候选时，不补回闭馆景点',()=>{
  const p=adjust(fixture(),`第1天${outdoor.name}闭馆`);
  assert.equal(p.daily[0].items.length,0);
  return p.daily[0];
});
test('R09','已因闭馆移除的室内候选不会被后续暴雨重新选中',()=>{
  const f=fixture([outdoor],[outdoor,indoor]);
  f.plan.daily[0].removedItems=[{name:indoor.name,reason:'用户报告闭馆'}];
  const p=adjust(f);
  assert.equal(p.daily[0].items.length,0);
  return p.daily[0];
});
test('R10','大模型选择留白时，页面保留留白并提示天气预警',()=>{
  const p=adjust(fixture([outdoor],[outdoor,indoor]),'第1天暴雨','llm',null);
  assert.equal(p.daily[0].items.length,0);
  assert.match(p.daily[0].eventAlert || '',/预警/);
  return p.daily[0];
});
test('R11','天气调整与暂停信息在导出中可见',()=>{
  const f={request:clone(original.request),plan:clone(original.plan)};
  const p=adjust(f);
  const md=call('buildPlanMarkdown',f.request,p);
  assert.match(md,/自由活动 \/ 休息/);
  assert.match(md,/预警/);
  assert.match(md,/三个户外点|全部受天气影响/);
  assert.doesNotMatch(md,/\*\*鼓浪屿\*\*/);
  return {markdown:md};
});
test('R12','正常初次规划仍按节奏补齐并跨日去重',()=>{
  const f=fixture([indoor],[indoor,outdoor,mixed,unconfirmed],2);
  f.request.pace='balanced';
  call('enforceUniqueDailyAttractions',f.request,f.plan);
  assert.deepEqual(clone(f.plan.daily.map(x=>x.items.length)),[2,2]);
  const names=f.plan.daily.flatMap(x=>x.items.map(y=>y.name));
  assert.equal(new Set(names).size,names.length);
  return {names};
});
const result={version,scope:'12条固定天气/闭馆/渲染专项回归，不是36条全量任务完成率',runAt:new Date().toISOString(),method:'离线重放已存A09真实候选和受控邻近场景，执行应用原函数，无API付费调用。虚构名称仅为受控测试fixture。',sha256:crypto.createHash('sha256').update(html).digest('hex'),total:tests.length,passed:tests.filter(x=>x.pass).length,tests};
result.passRatePercent=Number((100*result.passed/result.total).toFixed(2));
fs.writeFileSync(path.join(dir,'results.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify({version,total:result.total,passed:result.passed,passRatePercent:result.passRatePercent,failures:tests.filter(x=>!x.pass).map(x=>({id:x.id,error:x.error}))},null,2));
