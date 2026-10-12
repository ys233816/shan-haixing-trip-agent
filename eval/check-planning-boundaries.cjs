'use strict';

const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),dir=path.join(__dirname,'agent-regressions','2026-10-12-planning');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const node=()=>({addEventListener(){},classList:{add(){},remove(){}},querySelector:node,querySelectorAll:()=>[],replaceChildren(){}});
const store=()=>({getItem:()=>null,setItem(){},removeItem(){}});
const ctx=vm.createContext({document:{querySelector:node},sessionStorage:store(),localStorage:store(),console,URL,URLSearchParams,Blob});
const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];vm.runInContext(script.slice(0,script.indexOf("    form.addEventListener('submit'")),ctx);
const call=(fn,...args)=>{ctx.args=args;return vm.runInContext(`${fn}(...args)`,ctx);};
const item=(name,attrs={})=>({name,kind:'街区',walk:'低',indoor:'室外',rain:'低',hours:120,cost:0,...attrs});
const base={pace:'balanced',walkingTolerance:'medium',avoid:'',days:1};
function fixture(items,request={}){return {request:{...base,...request},plan:{plannerMode:'llm',candidates:items,daily:[{items,routeCheck:null}]}};}
const records=[];
function test(id,description,run){try{records.push({id,description,pass:true,evidence:run()});}catch(e){records.push({id,description,pass:false,error:e.message});}}
test('E01','两个夜游不导致跨午夜安排',()=>{const f=fixture([item('夜游A',{kind:'夜游',hours:180}),item('夜游B',{kind:'夜游',hours:120})]);call('enforceUniqueDailyAttractions',f.request,f.plan);assert.equal(f.plan.daily[0].items.length,1);return f.plan;});
test('E02','明确“不下雨”不触发雨天暂停',()=>{const f=fixture([item('户外A')],{avoid:'第一天不下雨'});call('enforceUniqueDailyAttractions',f.request,f.plan);assert.equal(f.plan.daily[0].items.length,1);assert.ok(!f.plan.daily[0].userWeatherEvent);return f.plan;});
test('E03','用户报告雨天重渲染保持完全一致',()=>{const f=fixture([item('户外A'),item('室内B',{indoor:'室内',rain:'高'})],{avoid:'第一天下雨'});call('enforceUniqueDailyAttractions',f.request,f.plan);const before=JSON.stringify(f.plan);call('enforceUniqueDailyAttractions',f.request,f.plan);assert.equal(JSON.stringify(f.plan),before);return f.plan;});
test('E04','已知路线很长时不继续按45分钟估算冒充可行',()=>{const f=fixture([item('场馆A',{hours:210}),item('场馆B',{hours:180})]);f.plan.daily[0].routeCheck={complete:true,attractionNames:['场馆a','场馆b'],legs:[{origin:'场馆A',destination:'场馆B',route:{durationSeconds:7200}}]};call('enforceUniqueDailyAttractions',f.request,f.plan);assert.equal(f.plan.daily[0].items.length,1);assert.equal(f.plan.daily[0].routeCheck,null);return f.plan;});
test('E05','模型规划跨日重复会去重且不会强制补满',()=>{const a=item('候选A'),b=item('候选B');const f=fixture([a]);f.request.days=2;f.plan.daily.push({items:[a,b]});f.plan.candidates=[a,b];call('enforceUniqueDailyAttractions',f.request,f.plan);assert.equal(f.plan.daily[0].items.length,1);assert.equal(f.plan.daily[1].items.length,1);return f.plan;});
const result={method:'最终版额外边界检查，未建立修改前基准，不纳入17条改善指标',sha256:crypto.createHash('sha256').update(html).digest('hex'),total:records.length,passed:records.filter(r=>r.pass).length,records};
fs.writeFileSync(path.join(dir,'boundary-checks.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({passed:result.passed,total:result.total,failures:records.filter(r=>!r.pass)},null,2));if(result.passed!==result.total)process.exitCode=1;
