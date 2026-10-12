'use strict';

const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
const out=path.join(__dirname,'agent-regressions',process.argv.includes('--clarification')?'2026-10-12-clarification/planning-nonregression':process.argv.includes('--preferences')?'2026-10-12-preferences/planning-nonregression':process.argv.includes('--budget')?'2026-10-12-budget/planning-nonregression':'2026-10-12-planning');
const version=process.argv[2];
if(!['before','after'].includes(version)) throw new Error('Use before or after');
const dir=path.join(out,version,process.argv.includes('--release')?'release':process.argv.includes('--verified')?'verified':process.argv.includes('--final')?'final':'.');
if(fs.existsSync(dir)) throw new Error('Run already exists; preserve previous evidence.');
fs.mkdirSync(dir,{recursive:true});
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
fs.writeFileSync(path.join(dir,'index.snapshot.html'),html);
const clone=x=>JSON.parse(JSON.stringify(x));
const original=JSON.parse(fs.readFileSync(path.join(__dirname,'runs/2026-10-11-remaining/A09-before-adjustment.json')));
const base={...clone(original.request),destination:'受控测试城市',pace:'balanced',days:1,avoid:''};
const outdoor={...clone(original.plan.daily[0].items[0]),name:'受控户外A',city:'受控测试城市',hours:120,walk:'中',indoor:'室外为主',rain:'低',cost:20,ticketPriceCny:20};
const item=(name,attrs={})=>({...outdoor,name,...attrs});
const indoor=item('受控室内B',{indoor:'室内',rain:'高',walk:'低',cost:30,ticketPriceCny:30});
const node=()=>({addEventListener(){},classList:{add(){},remove(){}},querySelector:node,querySelectorAll:()=>[],replaceChildren(){}});
const store=()=>({getItem:()=>null,setItem(){},removeItem(){}});
const context=vm.createContext({document:{querySelector:node},sessionStorage:store(),localStorage:store(),console,URL,URLSearchParams,Blob});
const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
vm.runInContext(script.slice(0,script.indexOf("    form.addEventListener('submit'")),context);
function call(fn,...args){context.args=args;return vm.runInContext(`${fn}(...args)`,context);}
function fixture(items,candidates=items,request={},mode='rules'){
  const req={...clone(base),...request};
  const daily=Array.from({length:req.days},(_,i)=>({date:`第 ${i+1} 天`,city:req.destination,items:clone(i===0?items:[]),weather:null,weatherNote:'未提供日期',walk:'适中',reason:''}));
  return {request:req,plan:{city:req.destination,candidates:clone(candidates),daily,plannerMode:mode,retrievalSource:'kb-hybrid-v4'}};
}
function guard(f){call('enforceUniqueDailyAttractions',f.request,f.plan);return f.plan;}
function finalEvidence(f){return {request:f.request,plan:f.plan,hours:f.plan.daily.map(d=>call('estimatedDayUseHours',d)),times:f.plan.daily.map(d=>call('suggestedStopTimes',d))};}
const tests=[];
async function test(id,caseIds,description,run){
  try{const evidence=await run();tests.push({id,caseIds,description,pass:true,evidence});}
  catch(e){tests.push({id,caseIds,description,pass:false,error:e.message,evidence:context.lastEvidence||null});}
  context.lastEvidence=null;
}
function check(f,assertions){guard(f);const e=finalEvidence(f);context.lastEvidence=e;assertions(f,e);return e;}

(async()=>{
await test('P01',['T03','T06','A11'],'适中日程不超8小时，保留一个较长主景点',()=>check(fixture([item('长景点A',{hours:300}),item('长景点B',{hours:240})]),(f,e)=>{assert.ok(e.hours[0]<=8);assert.ok(f.plan.daily[0].items.length>=1);}));
await test('P02',['T07','B04'],'两个长场馆加转场和午餐超限时减少安排',()=>check(fixture([item('场馆A',{hours:240}),item('场馆B',{hours:180})]),(f,e)=>assert.ok(e.hours[0]<=8)));
await test('P03',['T02','T04'],'少走路不安排中到高/高步行强度',()=>check(fixture([item('高步行A',{walk:'中到高'}),item('高步行B',{walk:'高'})],[outdoor,indoor,item('高步行A',{walk:'中到高'}),item('高步行B',{walk:'高'})],{walkingTolerance:'low'}),(f,e)=>assert.ok(f.plan.daily[0].items.every(x=>['低','低到中','中'].includes(x.walk)))));
await test('P04',['B06'],'没有低步行候选时留白，展示约束无法满足',()=>check(fixture([item('高步行A',{walk:'高'})],undefined,{walkingTolerance:'low'}),(f,e)=>{assert.equal(f.plan.daily[0].items.length,0);assert.ok(f.plan.daily[0].constraintNotes?.length);}));
await test('P05',['B07'],'轮椅需求保留单景点缓冲并提示核实无障碍',()=>check(fixture([outdoor,indoor],undefined,{avoid:'有轮椅使用者，必须有无障碍设施。'}),(f,e)=>{assert.ok(f.plan.daily[0].items.length<=1);assert.match((f.plan.daily[0].constraintNotes||[]).join(' '),/无障碍.*核实|核实.*无障碍/);}));
await test('P06',['B07'],'大模型主动少排时不强制补成每日数量',()=>check(fixture([indoor],[indoor,outdoor],{},'llm'),(f,e)=>assert.equal(f.plan.daily[0].items.length,1)));
await test('P07',['T08'],'预报有雨时拒绝室外为主含室内展馆候选',()=>{const f=fixture([item('混合展馆',{indoor:'室外为主，含室内展馆',rain:'中'})],[item('混合展馆',{indoor:'室外为主，含室内展馆',rain:'中'}),indoor]);f.plan.daily[0].weather={dayWeather:'大雨'};return check(f,(f,e)=>assert.ok(f.plan.daily[0].items.every(x=>x.indoor==='室内')));});
await test('P08',['T08'],'预报有雨且无安全候选时留白并提示',()=>{const f=fixture([outdoor]);f.plan.daily[0].weather={dayWeather:'暴雨'};return check(f,(f,e)=>{assert.equal(f.plan.daily[0].items.length,0);assert.ok(f.plan.daily[0].constraintNotes?.length||f.plan.daily[0].eventAlert);});});
await test('P09',['T08'],'没有出发日期时处理用户明确报告首日下雨',()=>check(fixture([outdoor],[outdoor,indoor],{avoid:'第一天下雨，优先室内。'}),(f,e)=>{assert.ok(f.plan.daily[0].items.every(x=>x.indoor==='室内'));assert.match(f.plan.daily[0].userWeatherEvent||'',/雨/);}));
await test('P10',['T04'],'夜游专属景点建议时段不早于18点',()=>check(fixture([item('夜游街区',{kind:'夜游街区',openingHours:'夜间游览',hours:120})]),(f,e)=>assert.ok(Number(e.times[0][0].slice(0,2))>=18)));
await test('P11',['T04'],'白天场馆排在夜游前，避免夜游后补白天点',()=>check(fixture([item('夜游街区',{kind:'夜游街区',openingHours:'夜间游览'}),indoor]),(f,e)=>{assert.equal(f.plan.daily[0].items[0].name,indoor.name);assert.ok(Number(e.times[0][1].slice(0,2))>=18);}));
await test('P12',['T03','B05'],'重复渲染结果稳定且跨日不重复',()=>{const f=fixture([outdoor,indoor],[outdoor,indoor,item('候选C'),item('候选D')],{days:2});guard(f);const before=JSON.stringify(f.plan);guard(f);assert.equal(JSON.stringify(f.plan),before);const names=f.plan.daily.flatMap(d=>d.items.map(x=>x.name));assert.equal(new Set(names).size,names.length);return finalEvidence(f);});
await test('P13',['T10'],'删减的收费景点不再计门票，保留收费项目正确计费',()=>check(fixture([item('长收费A',{hours:300,cost:20}),item('长收费B',{hours:240,cost:100})]),(f,e)=>{const budget=call('calculateBudget',f.request,f.plan);assert.equal(budget.knownTickets,40);}));
await test('P14',['T05','T09'],'普通短景点仍保持两个主要景点，不机械减成单点',()=>check(fixture([outdoor,indoor]),(f,e)=>assert.equal(f.plan.daily[0].items.length,2)));
await test('P15',['A09'],'既有暴雨暂停记录不会被本轮约束迭代恢复',()=>{const f=fixture([outdoor]);const adjusted=call('adjustPlanForEvent',f.request,f.plan,'第1天暴雨');f.plan=adjusted.plan;return check(f,(f,e)=>{assert.equal(f.plan.daily[0].items.length,0);assert.match(f.plan.daily[0].eventAlert,/预警/);});});
await test('P16',['T03'],'超长单景点无法在日上限内完成时不冒充可行',()=>check(fixture([item('超长景点',{hours:600})]),(f,e)=>{assert.equal(f.plan.daily[0].items.length,0);assert.ok(f.plan.daily[0].constraintNotes?.length);}));
await test('P17',['B07'],'makePlan的模型少排在生成阶段及渲染阶段都保留',async()=>{
  context.mockHits=[outdoor,indoor].map(x=>({name:x.name,city:x.city,cityName:x.city,area:x.area,type:x.kind,indoorOutdoor:x.indoor,recommendedDuration:String(x.hours),walkingIntensity:x.walk,rainSuitability:x.rain,tags:'博物馆',ticketPriceCny:x.cost,content:'',ticketInfo:'参考成人票',openingHours:'以官方为准'}));
  vm.runInContext("getApi=async path=>path.startsWith('/api/attractions')?{hits:mockHits,method:'受控候选重放'}:{configured:true,model:'受控模型'}; postApi=async()=>({days:[{attractionIds:[1],reason:'轮椅缓冲'}]});",context);
  const f={request:{...clone(base),avoid:'轮椅使用者'},plan:await call('makePlan',{...clone(base),avoid:'轮椅使用者'})};
  return check(f,(f,e)=>assert.equal(f.plan.daily[0].items.length,1));
});
const result={version,recordedAt:new Date().toISOString(),method:'17条固定专项回归；受控候选和模型响应；运行真实前端函数，无付费API。不是36条全量或真实大模型成功率。',total:tests.length,passed:tests.filter(t=>t.pass).length,tests,sha256:crypto.createHash('sha256').update(html).digest('hex')};
result.passRatePercent=Number((100*result.passed/result.total).toFixed(2));
fs.writeFileSync(path.join(dir,'results.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify({version,total:result.total,passed:result.passed,rate:result.passRatePercent,failures:tests.filter(t=>!t.pass).map(t=>({id:t.id,error:t.error}))},null,2));
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
