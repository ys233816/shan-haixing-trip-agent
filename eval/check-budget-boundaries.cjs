'use strict';

const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),out=path.join(__dirname,'agent-regressions','2026-10-12-budget');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8'),js=html.match(/<script>([\s\S]*?)<\/script>/)[1];
const node=()=>({addEventListener(){},classList:{add(){},remove(){}},querySelector:node,querySelectorAll:()=>[]}),store=()=>({getItem:()=>null,removeItem(){}});
const ctx=vm.createContext({document:{querySelector:node},sessionStorage:store(),localStorage:store(),console,URL,URLSearchParams,Blob});vm.runInContext(js.slice(0,js.indexOf("    form.addEventListener('submit'")),ctx);
const cases=[
 {id:'E01',avoid:'每人1500元/天',amount:1500,expected:1500},
 {id:'E02',avoid:'每人 总预算1500元',amount:1500,expected:6000},
 {id:'E03',avoid:'每人预算1.5万元',amount:15000,expected:60000},
 {id:'E04',avoid:'不住两晚，住一晚',amount:1500,question:true},
 {id:'E05',avoid:'房费350元/晚',amount:1500,nights:1},
 {id:'E06',avoid:'住宿0晚',amount:1500,nights:0},
 {id:'E07',avoid:'人均预算1500元，总预算6000元',amount:1500,expected:6000},
 {id:'E08',avoid:'每人1500元，总预算6000元',amount:6000,expected:6000},
 {id:'E09',avoid:'住二十晚',amount:10000,nights:20},
 {id:'E10',avoid:'每人500元，再改成每人800元',amount:800,question:true}
];
const records=cases.map(c=>{ctx.r={days:2,travelers:4,budget:{amount:c.amount,basisRequested:'auto',includes:'all'},avoid:c.avoid};const result=vm.runInContext('normalizeBudgetRequest(r)',ctx);try{if(c.expected!=null)assert.equal(result.request.budget.amount,c.expected);if(c.nights!=null)assert.equal(result.request.lodgingNights,c.nights);if(c.question)assert.ok(result.questions.length);if(!c.question&&c.id!=='E01')assert.equal(result.questions.length,0);return {...c,pass:true,result};}catch(e){return {...c,pass:false,error:e.message,result};}});
const output={method:'额外最终版边界检查，不计入22条改善指标',recordedAt:new Date().toISOString(),sha256:crypto.createHash('sha256').update(html).digest('hex'),passed:records.filter(r=>r.pass).length,total:records.length,records};fs.writeFileSync(path.join(out,'boundary-checks.json'),JSON.stringify(output,null,2));console.log(JSON.stringify({passed:output.passed,total:output.total,failures:records.filter(r=>!r.pass)},null,2));if(output.passed!==output.total)process.exitCode=1;
