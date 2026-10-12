'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {chromium}=require('C:/Users/17330/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root=path.resolve(__dirname,'..'),out=path.join(__dirname,'agent-regressions/2026-10-12-clarification');
const version=process.argv[2],revision=process.argv[3]||'initial';assert.ok(['before','after'].includes(version));assert.match(revision,/^[a-z0-9-]+$/);
const dir=path.join(out,version,revision);assert.ok(!fs.existsSync(dir),'Preserve earlier evidence');fs.mkdirSync(dir,{recursive:true});
const html=fs.readFileSync(version==='before'&&revision!=='initial'?path.join(out,'before/initial/index.snapshot.html'):path.join(root,'index.html'),'utf8');fs.writeFileSync(path.join(dir,'index.snapshot.html'),html);
const cases=[
 {id:'C01',group:'missing',description:'信息全缺时最多3问，不规划',fields:{destination:'帮我规划一下出去玩',days:'',budget:''},need:['目的地','天数','预算']},
 {id:'C02',group:'missing',description:'预算未填不能当作0元',fields:{budget:''},need:['预算']},
 {id:'C03',group:'conflict',description:'表单2天与文字3天冲突',fields:{days:'2',avoid:'想玩三天'},need:['天数']},
 {id:'C04',group:'conflict',description:'多人预算不同需要确认口径',fields:{travelers:'2',avoid:'每人预算1000元，另一人每人预算2000元'},need:['预算']},
 {id:'C05',group:'crosscity',description:'多城市目的地先确认分配和交通，不混排',fields:{destination:'苏州、杭州',days:'3'},need:['城市','天数','城际']},
 {id:'C06',group:'crosscity',description:'补充要求提跨城市也要确认',fields:{destination:'苏州',avoid:'先去苏州再去杭州',days:'3'},need:['城市','天数','城际']},
 {id:'C07',group:'conflict',description:'已估基础支出超预算时给差额与取舍',fields:{days:'3',budget:'500'},need:['已估','1458','取舍']},
 {id:'C08',group:'conflict',description:'五星酒店价格未查不能保证低预算可行',fields:{destination:'三亚',days:'1',budget:'500',avoid:'必须住五星酒店，预算500元'},need:['五星','价格','确认']},
 {id:'C09',group:'state',description:'修改成冲突请求后清旧计划且刷新不恢复',kind:'blocked-revision'},
 {id:'C10',group:'state',description:'新城市检索失败后不恢复旧城市计划',kind:'failed-revision'},
 {id:'C11',group:'state',description:'连续提交时较早响应不能覆盖最新要求',kind:'race'},
 {id:'C12',group:'state',description:'成功修改城市天数预算后全部替换',kind:'valid-revision'}
];
(async()=>{
 const sourcePath=path.join(out,'retrieval-sources.json');let sources;
 if(fs.existsSync(sourcePath))sources=JSON.parse(fs.readFileSync(sourcePath,'utf8'));else{
  sources={};for(const city of ['北京','杭州','苏州']){const response=await fetch(`http://127.0.0.1:4173/api/attractions?city=${encodeURIComponent(city)}&limit=20`);assert.equal(response.status,200);sources[city]=await response.json();}fs.writeFileSync(sourcePath,JSON.stringify(sources,null,2));
 }
 const browser=await chromium.launch({channel:'msedge',headless:true}),records=[];
 try{for(const c of cases){
  const context=await browser.newContext({viewport:process.argv.includes('--mobile')?{width:390,height:844}:{width:1365,height:900},locale:'zh-CN'}),page=await context.newPage(),errors=[],calls=[];let failHangzhou=false,race=false;
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',async route=>{const url=new URL(route.request().url());if(url.href==='http://127.0.0.1:4173/')return route.fulfill({contentType:'text/html',body:html});if(url.pathname==='/api/attractions'){
   const city=url.searchParams.get('city');calls.push(city);if(failHangzhou&&city==='杭州')return route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:'受控检索失败'})});
   if(race&&city==='北京')await new Promise(resolve=>setTimeout(resolve,600));
   return route.fulfill({contentType:'application/json',body:JSON.stringify(sources[city]||{hits:[],method:'受控无资料'})});
  }if(url.pathname==='/api/llm/status')return route.fulfill({contentType:'application/json',body:'{"configured":false}'});return route.abort();});
  await page.goto('http://127.0.0.1:4173/');
  async function fill(fields){for(const [name,value] of Object.entries(fields))await page.locator(`#trip-form [name="${name}"]`).fill(value);}
  async function submit(){await page.locator('#trip-form button[type="submit"]').click();await page.waitForTimeout(150);}
  await fill({destination:'北京',days:'2',travelers:'2',budget:'10000',avoid:'',...c.fields});
  if(c.kind){await submit();await page.waitForFunction(()=>document.querySelector('#itinerary').classList.contains('show'));
   if(c.kind==='blocked-revision')await fill({budget:'10000',avoid:'每人预算1500元'});
   if(c.kind==='failed-revision'){failHangzhou=true;await fill({destination:'杭州'});}
   if(c.kind==='valid-revision')await fill({destination:'杭州',days:'1',budget:'8000'});
   if(c.kind==='race'){race=true;await fill({destination:'北京',days:'2'});await submit();await fill({destination:'杭州',days:'1',budget:'8000'});}
  }
  await submit();if(c.kind==='race')await page.waitForTimeout(800);
  const capture=()=>page.evaluate(()=>({status:document.querySelector('#status').innerText,shown:document.querySelector('#itinerary').classList.contains('show'),text:document.querySelector('#itinerary').innerText,request:JSON.parse(sessionStorage.getItem('tripRequest')||'null'),plan:JSON.parse(sessionStorage.getItem('tripPlan')||'null'),questions:document.querySelectorAll('#status [data-question]').length,overflow:document.documentElement.scrollWidth>innerWidth}));
  const result=await capture(),checks={noPageErrors:!errors.length,noOverflow:!result.overflow};
  if(c.need){checks.blocked=!result.shown&&!result.plan&&!calls.length;checks.clarification=c.need.every(word=>result.status.replace(/,/g,'').includes(word));checks.maxThree=result.questions>0&&result.questions<=3;}
  if(c.kind==='blocked-revision'||c.kind==='failed-revision'){checks.oldPlanCleared=!result.shown&&!result.plan;await page.reload();await page.waitForTimeout(150);const restored=await capture();checks.noOldPlanAfterReload=!restored.shown&&!restored.plan;result.restored=restored;}
  if(c.kind==='race'||c.kind==='valid-revision'){checks.latestRequest=result.request?.destination==='杭州'&&result.request?.days===1&&result.request?.budget.amount===8000;checks.latestPlan=result.plan?.daily.length===1&&result.plan?.daily.flatMap(d=>d.items).every(x=>x.city?.includes('杭州'))&&result.shown;}
  const record={...c,checks,pass:Object.values(checks).every(Boolean),calls,errors,...result};records.push(record);fs.writeFileSync(path.join(dir,`${c.id}.json`),JSON.stringify(record,null,2));if(c.id==='C01'||c.id==='C05'||c.id==='C07')await page.screenshot({path:path.join(dir,`${c.id}.png`),fullPage:true});await context.close();
 }
 const result={version,revision,recordedAt:new Date().toISOString(),method:'12条固定需求澄清/冲突/跨城/修改状态专项；真实浏览器表单提交，本地API知识候选重放；模型禁用，失败和延迟受控，不是全量任务完成率。',sha256:crypto.createHash('sha256').update(html).digest('hex'),total:records.length,passed:records.filter(x=>x.pass).length,tests:records};result.ratePercent=Number((result.passed/result.total*100).toFixed(2));fs.writeFileSync(path.join(dir,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({version,total:result.total,passed:result.passed,ratePercent:result.ratePercent,failures:records.filter(x=>!x.pass).map(x=>({id:x.id,checks:x.checks,status:x.status}))},null,2));
 }finally{await browser.close();}
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
