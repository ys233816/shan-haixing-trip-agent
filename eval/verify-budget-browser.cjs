'use strict';

const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {chromium}=require('C:/Users/17330/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root=path.resolve(__dirname,'..'),out=path.join(__dirname,'agent-regressions','2026-10-12-budget');
const source=JSON.parse(fs.readFileSync(path.join(__dirname,'runs/2026-10-11-remaining/A03-turn1.json'),'utf8'));
const hits=source.plan.candidates.map(x=>({name:x.name,city:x.city,cityName:x.city,area:x.area,type:x.kind,indoorOutdoor:x.indoor,recommendedDuration:String(x.hours),walkingIntensity:x.walk,rainSuitability:x.rain,tags:x.tags,suitability:x.suitability,openingHours:x.openingHours,reservationInfo:x.reservationInfo,ticketInfo:x.ticketInfo,ticketPriceCny:x.ticketPriceCny,ticketPriceBasis:x.ticketPriceBasis,openingSource:x.openingSource,ticketSource:x.ticketSource,content:''}));
const cases=[
 {id:'B01-person',fields:{destination:'北京',days:'2',travelers:'4',budget:'1500',avoid:'每人预算1500元'},expected:{total:6000}},
 {id:'person-explicit',fields:{destination:'北京',days:'2',travelers:'3',budget:'800',budgetBasis:'per_person'},expected:{total:2400}},
 {id:'T10-two-nights',fields:{destination:'北京',days:'2',travelers:'2',budget:'5000',avoid:'两天两晚'},expected:{nights:2,lodging:700}},
 {id:'zero-nights',fields:{destination:'北京',days:'3',travelers:'2',budget:'5000',lodgingNights:'0'},expected:{nights:0,lodging:0}},
 {id:'budget-conflict',fields:{destination:'北京',days:'2',travelers:'2',budget:'5000',avoid:'每人预算1500元'},expected:{blocked:true}},
 {id:'nights-conflict',fields:{destination:'北京',days:'2',travelers:'2',budget:'5000',lodgingNights:'1',avoid:'住两晚'},expected:{blocked:true}},
 {id:'A03-low-budget',fields:{destination:'北京',days:'4',travelers:'5',budget:'800'},expected:{negotiation:true}},
 {id:'A02-no-kb',fields:{destination:'三亚',days:'3',travelers:'2',budget:'500',avoid:'预算500元，必须五星酒店'},expected:{missingKb:true,star:true,negotiation:true}},
 {id:'A12-zero-budget',fields:{destination:'北京',days:'1',travelers:'1',budget:'0'},expected:{zero:true,negotiation:true}},
 {id:'zero-cost-memory',fields:{destination:'北京',days:'2',travelers:'2',budget:'5000',lodgingNights:'0',hotelPerNight:'0',foodPerDay:'0',localTransitPerDay:'0'},expected:{zeroCosts:true}}
];
const versions={before:fs.readFileSync(path.join(out,'before/initial/index.snapshot.html'),'utf8'),after:fs.readFileSync(path.join(root,'index.html'),'utf8')};
(async()=>{const browser=await chromium.launch({channel:'msedge',headless:true});const records=[];
try{
for(const [version,html] of Object.entries(versions))for(const label of ['desktop','mobile'])for(const c of cases){
 const dir=path.join(out,version,process.argv.includes('--release')?'browser-release':'browser');fs.mkdirSync(dir,{recursive:true});
 const context=await browser.newContext({viewport:label==='desktop'?{width:1365,height:900}:{width:390,height:844},locale:'zh-CN'}),page=await context.newPage(),calls=[],errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{const u=new URL(route.request().url());if(u.href==='http://127.0.0.1:4173/')return route.fulfill({contentType:'text/html',body:html});if(u.pathname.startsWith('/api/')){calls.push(u.pathname);return route.fulfill({contentType:'application/json',body:JSON.stringify(u.pathname==='/api/attractions'?{hits:c.expected.missingKb?[]:hits,method:'已存真实候选重放'}:{configured:false,model:null})});}return route.abort();});
 await page.goto('http://127.0.0.1:4173/');
 for(const [name,value] of Object.entries(c.fields)){const field=page.locator(`#trip-form [name="${name}"]`);if(await field.count()){if(name==='budgetBasis')await field.selectOption(value);else await field.fill(value);}}
 await page.locator('#trip-form button[type="submit"]').click();
 if(await page.locator('#trip-form').evaluate(f=>f.checkValidity()))await page.waitForFunction(()=>{const text=document.querySelector('#status').textContent;return text.includes('已生成')||text.includes('先确认')||text.includes('失败');});
 const result=await page.evaluate(()=>{const request=JSON.parse(sessionStorage.getItem('tripRequest')||'null'),plan=JSON.parse(sessionStorage.getItem('tripPlan')||'null');return {request,plan,status:document.querySelector('#status').innerText,text:document.querySelector('#itinerary').innerText,budget:request&&plan?calculateBudget(request,plan):null,markdown:request&&plan?buildPlanMarkdown(request,plan):null,invalid:[...document.querySelector('#trip-form').elements].filter(x=>x.validity&&!x.validity.valid).map(x=>x.name),overflow:document.documentElement.scrollWidth>innerWidth};});
 let stable=true,restored=null;
 if(result.request&&result.plan){await page.reload();await page.waitForFunction(()=>document.querySelector('#itinerary').classList.contains('show')||document.querySelector('#status').textContent.includes('确认'));restored=await page.evaluate(()=>({request:JSON.parse(sessionStorage.getItem('tripRequest')),plan:JSON.parse(sessionStorage.getItem('tripPlan')),text:document.querySelector('#itinerary').innerText}));stable=JSON.stringify(restored.request)===JSON.stringify(result.request);}
 const checks={noPageErrors:errors.length===0,noHorizontalOverflow:!result.overflow,stableAfterReload:stable};
 if(c.expected.total!=null){checks.total=result.request?.budget.amount===c.expected.total;checks.scopeVisible=result.text.includes('全团')&&result.markdown?.includes('全团');}
 if(c.expected.nights!=null){checks.nights=result.budget?.nights===c.expected.nights;checks.lodging=result.budget?.lodging===c.expected.lodging;}
 if(c.expected.blocked){checks.blocked=!result.request&&calls.length===0&&result.status.includes('确认');}
 if(c.expected.negotiation){checks.negotiation=/增加.*预算|提高.*预算/.test(result.text)&&/取舍|确认/.test(result.text);checks.noZeroAdvice=!/(住宿|餐饮).*降至.*¥0/.test(result.text);}
 if(c.expected.star)checks.star=result.text.includes('五星酒店价格尚未查询');
 if(c.expected.zero)checks.zeroAccepted=result.invalid.length===0&&result.request?.budget.amount===0&&result.text.includes('免费');
 if(c.expected.zeroCosts)checks.zeroCosts=result.request?.assumptions.hotelPerNight===0&&result.request?.assumptions.foodPerDay===0&&result.request?.assumptions.localTransitPerDay===0&&restored?.request.lodgingNights===0;
 const pass=Object.values(checks).every(Boolean),record={version,id:c.id,viewport:label,fields:c.fields,expected:c.expected,checks,pass,calls,errors,...result,restored};
 if(await page.locator('#status').isVisible())await page.locator('#status').screenshot({path:path.join(dir,`${c.id}-${label}-status.png`)});
 else await page.locator('#trip-form').screenshot({path:path.join(dir,`${c.id}-${label}-form.png`)});
 if(result.text)await page.locator('#itinerary').screenshot({path:path.join(dir,`${c.id}-${label}-result.png`)});
 fs.writeFileSync(path.join(dir,`${c.id}-${label}.json`),JSON.stringify(record,null,2));records.push({version,id:c.id,viewport:label,pass,checks});
 await context.close();
}
const summary={recordedAt:new Date().toISOString(),method:'真实表单提交+会话刷新+导出；知识检索重放已存北京候选，三亚无候选；模型禁用，无外部付费调用。10个场景×2视口。',versions:Object.entries(versions).map(([version,html])=>({version,sha256:crypto.createHash('sha256').update(html).digest('hex'),total:records.filter(r=>r.version===version).length,passed:records.filter(r=>r.version===version&&r.pass).length})),records};
fs.writeFileSync(path.join(out,process.argv.includes('--release')?'browser-verification-release.json':'browser-verification.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify({versions:summary.versions,failures:records.filter(r=>r.version==='after'&&!r.pass)},null,2));assert.ok(records.filter(r=>r.version==='after').every(r=>r.pass));
}finally{await browser.close();}})().catch(e=>{console.error(e.stack);process.exitCode=1;});
