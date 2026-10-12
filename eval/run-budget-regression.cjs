'use strict';

const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),out=path.join(__dirname,'agent-regressions',process.argv.includes('--clarification')?'2026-10-12-clarification/budget-nonregression':process.argv.includes('--preferences')?'2026-10-12-preferences/budget-nonregression':'2026-10-12-budget');
const version=process.argv[2],revision=process.argv[3]||'initial';
if(!['before','after'].includes(version)||!/^[a-z0-9-]+$/.test(revision))throw new Error('Use before|after [revision]');
const dir=path.join(out,version,revision);if(fs.existsSync(dir))throw new Error('Run exists; preserve evidence.');fs.mkdirSync(dir,{recursive:true});
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');fs.writeFileSync(path.join(dir,'index.snapshot.html'),html);
const node=()=>({addEventListener(){},classList:{add(){},remove(){}},querySelector:node,querySelectorAll:()=>[],replaceChildren(){},insertAdjacentHTML(){}});
const storage=()=>({getItem:()=>null,setItem(){},removeItem(){}});
const ctx=vm.createContext({document:{querySelector:node},sessionStorage:storage(),localStorage:storage(),console,URL,URLSearchParams,Blob});
const js=html.match(/<script>([\s\S]*?)<\/script>/)[1];vm.runInContext(js.slice(0,js.indexOf("    form.addEventListener('submit'")),ctx);
function call(fn,...args){ctx.args=args;return vm.runInContext(`${fn}(...args)`,ctx);}
const clone=x=>JSON.parse(JSON.stringify(x));
function request(attrs={}){return {destination:'北京',days:2,travelers:2,budget:{amount:1000,currency:'CNY',includes:'all',basisRequested:'auto'},preferences:[],pace:'balanced',walkingTolerance:'medium',assumptions:{hotelPerNight:350,foodPerDay:120,localTransitPerDay:60},avoid:'',...attrs};}
const plan=items=>({city:'北京',candidates:items,daily:[{date:'第1天',city:'北京',items}],plannerMode:'llm'});
function normalize(raw){return vm.runInContext("typeof normalizeBudgetRequest==='function'",ctx)?call('normalizeBudgetRequest',raw):{request:clone(raw),questions:[],notes:[]};}
const tests=[];
function test(id,group,caseIds,description,run){try{tests.push({id,group,caseIds,description,pass:true,evidence:run()});}catch(e){tests.push({id,group,caseIds,description,pass:false,error:e.message});}}
test('Q01','scope',['B01'],'4人每人1500元转换成总预算6000元',()=>{const r=normalize(request({travelers:4,budget:{amount:1500,includes:'all',basisRequested:'auto'},avoid:'每人预算1500元'}));assert.equal(r.request.budget.amount,6000);return r;});
test('Q02','scope',['B01'],'显式人均口径不依赖特殊要求文本',()=>{const r=normalize(request({travelers:3,budget:{amount:800,includes:'all',basisRequested:'per_person'}}));assert.equal(r.request.budget.amount,2400);return r;});
test('Q03','scope',['B01'],'全团1500元保持1500，不乘人数',()=>{const r=normalize(request({travelers:4,budget:{amount:1500,includes:'all',basisRequested:'total'},avoid:'总预算1500元'}));assert.equal(r.request.budget.amount,1500);return r;});
test('Q04','scope',['B01'],'字段与文本金额冲突时提问，不生成确定需求',()=>{const r=normalize(request({budget:{amount:5000,includes:'all',basisRequested:'auto'},avoid:'每人预算1500元'}));assert.ok(r.questions.length);return r;});
test('Q05','scope',['B01'],'明确总额口径与人均文本冲突时提问',()=>{const r=normalize(request({budget:{amount:1500,includes:'all',basisRequested:'total'},avoid:'每人1500元'}));assert.ok(r.questions.length);return r;});
test('Q06','scope',['B01'],'不能把每人每日餐饮费用当作人均总预算',()=>{const r=normalize(request({avoid:'每人每天餐饮120元'}));assert.equal(r.request.budget.amount,1000);assert.equal(r.questions.length,0);return r;});
test('Q07','scope',['B01'],'重复规范化不重复乘人数',()=>{const a=normalize(request({travelers:4,budget:{amount:1500,includes:'all',basisRequested:'per_person'}}));const b=normalize(a.request);assert.equal(a.request.budget.amount,6000);assert.equal(b.request.budget.amount,6000);return b;});
test('Q08','nights',['T10'],'两天两晚按两晚计算住宿700元',()=>{const r=normalize(request({avoid:'两天两晚，预算包含住宿'}));const b=call('calculateBudget',r.request,plan([]));assert.equal(b.nights,2);assert.equal(b.lodging,700);return {r,b};});
test('Q09','nights',['T10'],'住宿晚数显式0时不推成天数减一',()=>{const r=normalize(request({days:3,lodgingNights:0}));const b=call('calculateBudget',r.request,plan([]));assert.equal(b.lodging,0);return {r,b};});
test('Q10','nights',['T10'],'没有指定住宿晚数时沿用默认天数减一并注明',()=>{const r=normalize(request({days:3}));const b=call('calculateBudget',r.request,plan([]));assert.equal(b.nights,2);assert.match(r.notes.join(' '),/默认|未指定/);return {r,b};});
test('Q11','nights',['T10'],'字段1晚与文本2晚冲突时要求确认',()=>{const r=normalize(request({lodgingNights:1,avoid:'住两晚'}));assert.ok(r.questions.length);return r;});
test('Q12','nights',['T10'],'不计住宿时保留晚数但排除住宿金额',()=>{const r=normalize(request({budget:{amount:1000,includes:'without_intercity'},lodgingNights:2}));const b=call('calculateBudget',r.request,plan([]));assert.equal(b.lodging,0);assert.equal(b.lodgingRaw,700);return {r,b};});
test('Q13','negotiation',['A03'],'极低预算建议增加预算或缩短行程，不建议必需费用降至0',()=>{const r=request({travelers:5,days:4,budget:{amount:800,includes:'all'}});const b=call('calculateBudget',r,plan([])),ideas=call('budgetAdjustmentIdeas',r,b);assert.match(ideas.join(' '),/增加.*预算|提高.*预算/);assert.match(ideas.join(' '),/缩短|减少.*天/);assert.doesNotMatch(ideas.join(' '),/(住宿|餐饮).*降至.*(?:¥0|0元)/);return {b,ideas};});
test('Q14','negotiation',['A02'],'五星酒店低预算即使没有景点资料也给出冲突取舍',()=>{const r=request({destination:'三亚',days:3,budget:{amount:500,includes:'all'},avoid:'预算500元玩遍三亚，必须五星酒店'}),b=call('calculateBudget',r,plan([])),ideas=call('budgetAdjustmentIdeas',r,b);assert.match(ideas.join(' '),/五星/);assert.match(ideas.join(' '),/取舍|选择|确认/);return {b,ideas};});
test('Q15','negotiation',['A12'],'0元预算通过表单，支持免费活动方向但不保证全程免费',()=>{assert.match(html,/id="budget"[^>]*min="0"/);const r=request({budget:{amount:0,includes:'all'}}),b=call('calculateBudget',r,plan([])),ideas=call('budgetAdjustmentIdeas',r,b);assert.match(ideas.join(' '),/免费/);assert.match(ideas.join(' '),/交通|餐饮/);return {b,ideas};});
test('Q16','tickets',['T10'],'结构化参考票价存在时不能沿用过期cost=null',()=>{const b=call('calculateBudget',request(),plan([{name:'参考收费票',cost:null,ticketPriceCny:20}]));assert.equal(b.knownTickets,40);assert.equal(b.unknownTicketCount,0);return b;});
test('Q17','tickets',['T10'],'免费0、收费20、未知票分别计费并列未知，不把空值当0',()=>{const b=call('calculateBudget',request(),plan([{name:'免费',cost:0,ticketPriceCny:0},{name:'收费',cost:null,ticketPriceCny:20},{name:'未知',cost:null,ticketPriceCny:''}]));assert.equal(b.knownTickets,40);assert.equal(b.unknownTicketCount,1);return b;});
test('Q18','tickets',['A03'],'同名门票跨日重复时只收一次',()=>{const p=plan([{name:'景点A',cost:20}]);p.daily.push({items:[{name:'景点A',cost:20}]});const b=call('calculateBudget',request(),p);assert.equal(b.knownTickets,40);return b;});
test('Q19','tickets',['T10'],'缺失cost和参考票价也必须列为待核实',()=>{const b=call('calculateBudget',request(),plan([{name:'未知字段'}]));assert.equal(b.unknownTicketCount,1);return b;});
test('Q20','memory',['T10'],'保存/恢复不丢失0晚及零费用参数',()=>{assert.doesNotMatch(js,/savedRequest\.assumptions\?\.hotelPerNight\s*\|\|/);const d={get:()=> '0'};assert.equal(call('estimateInput',d,'hotelPerNight'),0);return {zeroParameterPreserved:true};});
test('Q21','negotiation',['A03'],'没有超过预算时不提出超支协商',()=>{const r=request({budget:{amount:10000,includes:'all'}}),b=call('calculateBudget',r,plan([]));assert.equal(call('budgetAdjustmentIdeas',r,b).length,0);return b;});
test('Q22','negotiation',['A03'],'导出同步显示已估超支及取舍方向',()=>{const r=request({travelers:5,days:4,budget:{amount:800,includes:'all'}}),md=call('buildPlanMarkdown',r,plan([]));assert.match(md,/超过预算|超预算/);assert.match(md,/增加.*预算|提高.*预算/);return {markdown:md};});
const result={version,revision,recordedAt:new Date().toISOString(),scope:'22条预算专项，固定结构化输入与受控候选，执行真实前端函数，不是36条全量任务完成率',sha256:crypto.createHash('sha256').update(html).digest('hex'),total:tests.length,passed:tests.filter(t=>t.pass).length,tests};result.ratePercent=Number((100*result.passed/result.total).toFixed(2));
fs.writeFileSync(path.join(dir,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({version,revision,total:result.total,passed:result.passed,ratePercent:result.ratePercent,failures:tests.filter(t=>!t.pass).map(t=>({id:t.id,error:t.error}))},null,2));
