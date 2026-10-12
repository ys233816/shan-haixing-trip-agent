'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),out=path.join(__dirname,'agent-regressions/2026-10-12-preferences/boundary-checks'+(process.argv.includes('--verified')?'-verified':'')+'.json');
assert.ok(!fs.existsSync(out),'Preserve earlier evidence');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8'),js=html.match(/<script>([\s\S]*?)<\/script>/)[1];
const node=()=>({addEventListener(){},querySelector:node,querySelectorAll:()=>[],classList:{add(){},remove(){}}}),storage={getItem(){return null;},setItem(){},removeItem(){}};
const ctx=vm.createContext({document:{querySelector:node},sessionStorage:storage,localStorage:storage,console,URL,URLSearchParams,Blob});vm.runInContext(js.slice(0,js.indexOf("    form.addEventListener('submit'")),ctx);
const call=(fn,...args)=>{ctx.args=args;return vm.runInContext(`${fn}(...args)`,ctx);};
const item=(name,kind,extra={})=>({name,kind,indoor:'室内',rain:'高',walk:'低',hours:90,cost:0,ticketPriceCny:0,...extra});
const fixture=(preferences,items,candidates,extra={})=>({request:{destination:'北京',days:1,travelers:2,budget:{amount:10000,includes:'all'},assumptions:{hotelPerNight:350,foodPerDay:120,localTransitPerDay:60},pace:'balanced',walkingTolerance:'medium',avoid:'',preferences,...extra},plan:{city:'北京市',plannerMode:'llm',daily:[{city:'北京市',items}],candidates}});
const tests=[];
function test(id,fn){try{const evidence=fn();tests.push({id,pass:true,evidence});}catch(error){tests.push({id,pass:false,error:error.message});}}
test('unknown-ticket-disclosure',()=>{const f=fixture(['美食'],[item('馆','博物馆')],[item('餐饮馆','美食',{cost:null,ticketPriceCny:''})]);call('enforceUniqueDailyAttractions',f.request,f.plan);assert.equal(f.plan.preferenceCoverage.missing.length,0);assert.equal(call('calculateBudget',f.request,f.plan).unknownTicketCount,1);assert.match(call('buildPlanMarkdown',f.request,f.plan),/待核实票价景点：1/);return f;});
test('photography',()=>{const f=fixture(['拍照打卡'],[item('馆','博物馆')],[item('摄影点','园林',{tags:'摄影'})]);call('enforceUniqueDailyAttractions',f.request,f.plan);assert.equal(f.plan.preferenceCoverage.fulfilled[0].label,'拍照打卡');return f;});
test('cross-city-no-refill',()=>{const f=fixture(['美食'],[item('馆','博物馆')],[item('异地美食','美食',{city:'上海市'})]);call('enforceUniqueDailyAttractions',f.request,f.plan);assert.equal(f.plan.daily[0].items.length,1);assert.equal(f.plan.preferenceCoverage.missing.length,1);return f;});
test('summary-not-evidence',()=>{const f=fixture(['美食'],[item('街','历史街区',{reason:'美食推荐',backup:'美食街'})],[]);call('enforceUniqueDailyAttractions',f.request,f.plan);assert.equal(f.plan.preferenceCoverage.missing.length,1);return f;});
test('negative-tags',()=>{const f=fixture(['亲子活动'],[item('馆','展馆',{suitability:'不适合亲子'})],[]);call('enforceUniqueDailyAttractions',f.request,f.plan);assert.equal(f.plan.preferenceCoverage.missing.length,1);return f;});
test('invalidate-route-after-repair',()=>{const f=fixture(['美食'],[item('馆','博物馆')],[item('餐饮','美食')]);f.plan.daily[0].routeCheck={legs:[],attractionNames:['馆'],complete:true};call('enforceUniqueDailyAttractions',f.request,f.plan);assert.equal(f.plan.daily[0].routeCheck,null);return f;});
const result={sha256:crypto.createHash('sha256').update(html).digest('hex'),total:tests.length,passed:tests.filter(x=>x.pass).length,tests};fs.writeFileSync(out,JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));assert.ok(tests.every(x=>x.pass));
