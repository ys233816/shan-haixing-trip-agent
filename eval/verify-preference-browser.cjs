'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {chromium}=require('C:/Users/17330/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root=path.resolve(__dirname,'..'),out=path.join(__dirname,'agent-regressions','2026-10-12-preferences');
const versions={before:fs.readFileSync(path.join(out,'before/initial/index.snapshot.html'),'utf8'),after:fs.readFileSync(path.join(root,'index.html'),'utf8')};
const cases=[
 {id:'hangzhou-food',city:'杭州',preferences:['美食'],seed:['浙江省博物馆之江馆区'],fulfilled:['美食']},
 {id:'shanghai-architecture',city:'上海',preferences:['博物馆'],avoid:'想看城市建筑',seed:['上海博物馆（人民广场馆）'],fulfilled:['博物馆','建筑']},
 {id:'beijing-science-gap',city:'北京',avoid:'想看历史和科技类景点',preferences:['历史文化'],seed:['故宫博物院'],missing:['科技']},
 {id:'xiamen-indoor-family',city:'厦门',preferences:['亲子活动'],avoid:'想要室内亲子活动',seed:['厦门大学思明校区周边'],missing:['室内亲子活动']},
 {id:'rain-food-gap',city:'杭州',preferences:['美食'],seed:['浙江省博物馆之江馆区'],weather:{dayWeather:'暴雨'},missing:['美食']},
 {id:'closure-no-refill',city:'杭州',preferences:['美食'],seed:['浙江省博物馆之江馆区'],event:true,missing:['美食']},
 {id:'no-candidates',city:'三亚',preferences:['亲子活动'],seed:[],missing:['亲子活动']}
];
function mapHit(h){return {name:h.name,city:h.cityName||h.city,area:h.area,kind:h.type,indoor:h.indoorOutdoor,hours:(String(h.recommendedDuration).match(/\d+/g)||[120]).map(Number).reduce((a,b)=>a+b,0)/(String(h.recommendedDuration).match(/\d+/g)||[120]).length,walk:/高/.test(h.walkingIntensity)?'高':/低/.test(h.walkingIntensity)?'低':'中',rain:h.rainSuitability,tags:h.tags,suitability:h.suitability,openingHours:h.openingHours,reservationInfo:h.reservationInfo,ticketInfo:h.ticketInfo,ticketPriceCny:h.ticketPriceCny??'',cost:h.ticketPriceCny!==''&&h.ticketPriceCny!=null?Number(h.ticketPriceCny):null,openingSource:h.openingSource,ticketSource:h.ticketSource};}
(async()=>{
 const revision=process.argv[2]||'release';assert.match(revision,/^[a-z0-9-]+$/);
 const recorded=path.join(out,`browser-verification-${revision}.json`);assert.ok(!fs.existsSync(recorded),'Preserve previous browser evidence');
 const sources={};for(const c of cases)if(!(c.city in sources)){
   const response=await fetch(`http://127.0.0.1:4173/api/attractions?city=${encodeURIComponent(c.city)}&limit=20`);assert.equal(response.status,200);sources[c.city]=await response.json();
 }
 fs.writeFileSync(path.join(out,'browser-retrieval-sources.json'),JSON.stringify(sources,null,2));
 const browser=await chromium.launch({channel:'msedge',headless:true}),records=[];
 try{for(const [version,html] of Object.entries(versions))for(const viewport of ['desktop','mobile'])for(const c of cases){
   const dir=path.join(out,version,`browser-${revision}`);fs.mkdirSync(dir,{recursive:true});
   const candidates=sources[c.city].hits.map(mapHit);
   const request={destination:c.city,days:1,travelers:2,budget:{amount:10000,includes:'all'},assumptions:{hotelPerNight:350,foodPerDay:120,localTransitPerDay:60},preferences:c.preferences||[],avoid:c.avoid||'',pace:'balanced',walkingTolerance:'medium'};
   const items=c.seed.map(name=>{const item=candidates.find(x=>x.name===name);assert.ok(item,`Missing real seed ${name}`);return item;});
   const city=candidates[0]?.city||c.city;
   const plan={city,plannerMode:'llm',retrievalSource:'kb-hybrid-v4',candidates,daily:[{date:'第1天',city,items,weather:c.weather||null,walk:'适中'}]};
   if(c.event){plan.changeSummary='已按闭馆事件移除美食点';plan.daily[0].removedItems=[{name:'河坊街历史文化街区',reason:'受控闭馆事件'}];}
   const context=await browser.newContext({viewport:viewport==='desktop'?{width:1365,height:900}:{width:390,height:844},locale:'zh-CN',acceptDownloads:true}),page=await context.newPage(),errors=[];
   page.on('pageerror',error=>errors.push(error.message));
   await page.route('**/*',route=>route.request().url()==='http://127.0.0.1:4173/'?route.fulfill({contentType:'text/html',body:html}):route.abort());
   await page.addInitScript(({request,plan})=>{if(!sessionStorage.getItem('tripRequest')){sessionStorage.setItem('tripRequest',JSON.stringify(request));sessionStorage.setItem('tripPlan',JSON.stringify(plan));}},{request,plan});
   await page.goto('http://127.0.0.1:4173/');await page.waitForFunction(()=>document.querySelector('#itinerary').classList.contains('show'));
   const result=await page.evaluate(()=>{const request=JSON.parse(sessionStorage.getItem('tripRequest')),plan=JSON.parse(sessionStorage.getItem('tripPlan'));return {request,plan,text:document.querySelector('#itinerary').innerText,markdown:buildPlanMarkdown(request,plan),overflow:document.documentElement.scrollWidth>innerWidth};});
   const checks={noPageErrors:!errors.length,noHorizontalOverflow:!result.overflow};
   for(const label of c.fulfilled||[])checks[`fulfilled:${label}`]=Boolean(result.plan.preferenceCoverage?.fulfilled.some(x=>x.label===label));
   for(const label of c.missing||[])checks[`missing:${label}`]=Boolean(result.plan.preferenceCoverage?.missing.some(x=>x.label===label))&&result.text.includes(`未覆盖：${label}`)&&result.markdown.includes(`未覆盖：${label}`);
   if(c.weather)checks.rainSafety=result.plan.daily[0].items.every(x=>x.indoor.includes('室内')&&x.rain!=='低');
   if(c.event)checks.noRefill=result.plan.daily[0].items.map(x=>x.name).join('|')===c.seed.join('|');
   if(version==='after'&&c.id==='hangzhou-food'){
     const downloadPromise=page.waitForEvent('download');await page.locator('#download-plan').click();const download=await downloadPromise;const file=await download.path();const markdown=fs.readFileSync(file,'utf8');checks.downloadMatches=markdown.replace(/^\uFEFF/,'')===result.markdown;fs.writeFileSync(path.join(dir,`${c.id}-${viewport}.md`),markdown);
   }
   await page.locator('#itinerary').screenshot({path:path.join(dir,`${c.id}-${viewport}.png`)});
   await page.reload();await page.waitForFunction(()=>document.querySelector('#itinerary').classList.contains('show'));
   const restored=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('tripPlan')));checks.stableOnReload=JSON.stringify(restored)===JSON.stringify(result.plan);
   const record={version,id:c.id,viewport,checks,pass:Object.values(checks).every(Boolean),errors,...result};fs.writeFileSync(path.join(dir,`${c.id}-${viewport}.json`),JSON.stringify(record,null,2));records.push({version,id:c.id,viewport,checks,pass:record.pass});await context.close();
 }
 const summary={recordedAt:new Date().toISOString(),method:'7个固定场景×桌面/手机，重放本地API返回真实景点；受控模型遗漏草稿；会话恢复、渲染、实际下载。未调用外部模型。',versions:Object.entries(versions).map(([version,html])=>({version,sha256:crypto.createHash('sha256').update(html).digest('hex'),total:records.filter(x=>x.version===version).length,passed:records.filter(x=>x.version===version&&x.pass).length})),records};
 fs.writeFileSync(recorded,JSON.stringify(summary,null,2));console.log(JSON.stringify({versions:summary.versions,failures:records.filter(x=>x.version==='after'&&!x.pass)},null,2));assert.ok(records.filter(x=>x.version==='after').every(x=>x.pass));
 }finally{await browser.close();}
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
