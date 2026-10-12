'use strict';

const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const assert=require('node:assert/strict');
const {chromium}=require('C:/Users/17330/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root=path.resolve(__dirname,'..');
const out=path.join(__dirname,'agent-regressions','2026-10-12-planning');
const clone=x=>JSON.parse(JSON.stringify(x));
const load=file=>JSON.parse(fs.readFileSync(path.join(__dirname,'runs','2026-10-11-remaining',file),'utf8'));
const sources=[
  {id:'A11',file:'A11-turn1.json',kind:'duration'},
  {id:'A08-draft',file:'A08-before-adjustment.json',kind:'duration',description:'北京闭馆事件前的两日草稿，只检查初稿约束，不代替完整闭馆用例'},
  {id:'B07',file:'B07-turn1.json',kind:'wheelchair'}
];
const example=load('A09-before-adjustment.json');
const night=clone(example);
night.request.destination='受控夜游场景';night.request.days=1;night.request.avoid='';
night.plan.city='受控夜游场景';night.plan.plannerMode='llm';
night.plan.daily[0].items=[{...night.plan.daily[0].items[0],name:'受控夜游街区',kind:'夜间游览',hours:120,walk:'低',indoor:'室外为主'},{...night.plan.daily[0].items[0],name:'受控白天场馆',kind:'博物馆',hours:120,walk:'低',indoor:'室内',rain:'高'}];
night.plan.candidates=clone(night.plan.daily[0].items);
const rain=clone(night);rain.request.avoid='第一天下雨，优先室内。';
sources.push({id:'night',fixture:night,kind:'night'},{id:'reported-rain',fixture:rain,kind:'reported-rain'});
const versions={before:fs.readFileSync(path.join(out,'before','index.snapshot.html'),'utf8'),after:fs.readFileSync(path.join(root,'index.html'),'utf8')};
(async()=>{
  const browser=await chromium.launch({channel:'msedge',headless:true});
  const records=[];
  try{
    for(const [version,html] of Object.entries(versions)) for(const label of ['desktop','mobile']) for(const source of sources){
      const evidence=source.fixture||load(source.file);
      const dir=path.join(out,version,'browser');fs.mkdirSync(dir,{recursive:true});
      const context=await browser.newContext({viewport:label==='desktop'?{width:1365,height:900}:{width:390,height:844},locale:'zh-CN'});
      await context.addInitScript(({request,plan})=>{if(!sessionStorage.getItem('tripPlan')){sessionStorage.setItem('tripRequest',JSON.stringify(request));sessionStorage.setItem('tripPlan',JSON.stringify(plan));}},{request:evidence.request,plan:evidence.plan});
      const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
      await page.route('**/*',route=>route.request().url()==='http://127.0.0.1:4173/'?route.fulfill({contentType:'text/html',body:html}):route.abort());
      await page.goto('http://127.0.0.1:4173/');await page.locator('#itinerary.show').waitFor();
      const result=await page.evaluate(()=>{
        const plan=JSON.parse(sessionStorage.getItem('tripPlan')),request=JSON.parse(sessionStorage.getItem('tripRequest'));
        return {request,plan,text:document.querySelector('#itinerary').innerText,markdown:buildPlanMarkdown(request,plan),hours:plan.daily.map(d=>estimatedDayUseHours(d)),times:plan.daily.map(d=>suggestedStopTimes(d)),overflow:document.documentElement.scrollWidth>innerWidth};
      });
      await page.locator('#itinerary .day-card').first().screenshot({path:path.join(dir,`${source.id}-${label}.png`)});
      await page.reload();await page.locator('#itinerary.show').waitFor();
      const restored=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('tripPlan')));
      const stable=JSON.stringify(result.plan)===JSON.stringify(restored);
      const checks={noPageErrors:errors.length===0,noHorizontalOverflow:!result.overflow,stableAfterReload:stable};
      if(source.kind==='duration')checks.withinEightHours=result.hours.every(h=>h<=8);
      if(source.kind==='wheelchair'){
        checks.singleStopBuffer=result.plan.daily.every(d=>d.items.length<=1);
        checks.accessibilityVisible=/无障碍.*核实|核实.*无障碍/.test(result.text);
        checks.accessibilityExported=/无障碍.*核实|核实.*无障碍/.test(result.markdown);
      }
      if(source.kind==='night') checks.nightStartsAfter18=result.plan.daily[0].items[0].name==='受控白天场馆'&&Number(result.times[0][1].slice(0,2))>=18;
      if(source.kind==='reported-rain'){
        checks.onlyIndoor=result.plan.daily[0].items.every(x=>x.indoor==='室内');
        checks.userReportVisible=result.text.includes('用户报告')&&result.text.includes('未独立核实');
      }
      const pass=Object.values(checks).every(Boolean);
      fs.writeFileSync(path.join(dir,`${source.id}-${label}.json`),JSON.stringify({version,id:source.id,viewport:label,source:source.file||'受控fixture',description:source.description||'',checks,pass,...result,errors},null,2));
      records.push({version,id:source.id,viewport:label,pass,checks});
      if(version==='after')assert.ok(pass,JSON.stringify(records.at(-1)));
      await context.close();
    }
    const summary={runAt:new Date().toISOString(),method:'历史结构化状态重放+两个受控场景；桌面/手机各一次，未重新调用真实规划模型或地图',versions:Object.entries(versions).map(([version,html])=>({version,sha256:crypto.createHash('sha256').update(html).digest('hex'),total:records.filter(r=>r.version===version).length,passed:records.filter(r=>r.version===version&&r.pass).length})),records};
    fs.writeFileSync(path.join(out,'browser-verification.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify(summary.versions,null,2));
  }finally{await browser.close();}
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
