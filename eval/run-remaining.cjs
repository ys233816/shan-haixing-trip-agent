'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {chromium} = require('C:/Users/17330/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

const root = path.resolve(__dirname, '..');
const output = path.join(__dirname, 'runs', '2026-10-11-remaining');
const testCases = JSON.parse(fs.readFileSync(path.join(__dirname, 'test-cases.json'), 'utf8'));
const baseUrl = 'http://127.0.0.1:4173';
const definitions = {
  B07: [{destination:'北京',days:'2',travelers:'3',budget:'5000'}],
  B08: [{destination:'北京',days:'1',travelers:'2',budget:'1000'}],
  B09: [{destination:'成都',days:'3',travelers:'2',budget:'5000',startDate:'2027-02-11'}],
  B10: [{destination:'甘肃甘南一个小县城',days:'5',travelers:'2',budget:'3000'}],
  B11: [{destination:'上海',days:'3',travelers:'4',budget:'7000'}],
  B12: [
    {destination:'杭州',days:'2',travelers:'2',budget:'2500',preferences:['自然风光']},
    {days:'3'},
    {pace:'relaxed',avoid:'喜欢自然景观，改为慢节奏，并尽量安排室内备选。'}
  ],
  A01: [{}],
  A02: [{destination:'三亚',days:'3',travelers:'2',budget:'500'}],
  A03: [{destination:'北京',days:'4',travelers:'5',budget:'800'}],
  A04: [{}],
  A05: [{destination:'北京',startDate:'2026-10-12'}],
  A06: [{destination:'东京',days:'5',travelers:'2',budget:'5000'}],
  A07: [{destination:'香港',days:'2',travelers:'2',budget:'5000'}],
  A08: [{destination:'北京',days:'2',travelers:'2',budget:'5000'}],
  A09: [{destination:'厦门',days:'1',travelers:'2',budget:'5000',pace:'packed'}],
  A10: [{}],
  A11: [{destination:'杭州',days:'2',travelers:'2',budget:'2500'}],
  A12: [{destination:'北京',days:'1',travelers:'2',budget:'0'}]
};
const auxiliaries = {
  B09: '将4个月后固定为2027-02-11；未给定人数、预算，使用表单辅助值2人、5000元，不评价这两项。',
  B10: '未给定人数，使用表单默认2人。未臆造具体县名。',
  A06: '未给定人数、预算，使用辅助值2人、5000元以运行范围判断，不评价这两项。',
  A07: '未给定人数、预算，使用辅助值2人、5000元以运行范围判断，不评价这两项。',
  A08: '测试前置条件是已生成北京两日行程；先运行真实规划，再从该次真实候选中建立明确的第二天故宫场景。',
  A09: '测试前置条件是三处户外点且无可确认室内候选；先真实检索厦门候选，再建立对应受控场景。',
  A11: '未给定人数、预算，使用辅助值2人、2500元使日期缺失场景进入真实规划流程。'
};

async function capture(page, label, trace, extra = {}) {
  const data = await page.evaluate(() => {
    const form = document.querySelector('#trip-form');
    const fields = Object.fromEntries(new FormData(form).entries());
    fields.preferences = new FormData(form).getAll('preferences');
    return {
      form:fields,
      invalidFields:[...form.querySelectorAll('input,textarea,select')].filter(x => !x.validity.valid).map(x => ({name:x.name,value:x.value,message:x.validationMessage})),
      status:document.querySelector('#status').innerText,
      visibleResult:document.querySelector('#itinerary').innerText,
      pageText:document.body.innerText,
      request:JSON.parse(sessionStorage.getItem('tripRequest') || 'null'),
      plan:JSON.parse(sessionStorage.getItem('tripPlan') || 'null'),
      daySummaries:typeof estimatedDayUseHours === 'function' ? (JSON.parse(sessionStorage.getItem('tripPlan') || 'null')?.daily || []).map(day => ({date:day.date,names:day.items.map(x=>x.name),hours:estimatedDayUseHours(day),weatherNote:day.weatherNote,walk:day.walk})) : [],
      budget:sessionStorage.getItem('tripRequest') && sessionStorage.getItem('tripPlan') ? calculateBudget(JSON.parse(sessionStorage.getItem('tripRequest')),JSON.parse(sessionStorage.getItem('tripPlan'))) : null
    };
  });
  await page.screenshot({path:path.join(output, `${label}.png`),fullPage:true});
  const result = {...data, ...extra, capturedAt:new Date().toISOString(),network:JSON.parse(JSON.stringify(trace))};
  fs.writeFileSync(path.join(output, `${label}.json`), JSON.stringify(result,null,2));
  return result;
}

async function fill(page, fields, rawTurn) {
  for (const [name,value] of Object.entries(fields)) {
    if (name === 'preferences') {
      for (const option of await page.locator('input[name="preferences"]').all()) {
        const checked = value.includes(await option.getAttribute('value'));
        if (await option.isChecked() !== checked) await option.locator('..').click();
      }
    } else if (['pace','walking','budgetIncludes'].includes(name)) await page.locator(`[name="${name}"]`).selectOption(value);
    else await page.locator(`#trip-form [name="${name}"]`).fill(value);
  }
  if (!Object.hasOwn(fields,'avoid')) await page.locator('#avoid').fill(rawTurn);
}

async function submit(page) {
  const valid = await page.locator('#trip-form').evaluate(form => form.checkValidity());
  await page.locator('#trip-form button[type="submit"]').click();
  if (valid) await page.waitForFunction(() => {
    const text = document.querySelector('#status').textContent;
    return text.includes('第一版行程框架已生成') || text.includes('生成行程失败') || text.includes('不在支持范围');
  },null,{timeout:100000});
}

async function controlledScenario(page, id) {
  return page.evaluate(id => {
    const request = JSON.parse(sessionStorage.getItem('tripRequest'));
    const plan = JSON.parse(sessionStorage.getItem('tripPlan'));
    if (id === 'A08') {
      const palace = plan.candidates.find(x => x.name === '故宫博物院');
      if (!palace) throw new Error('A08前置候选缺少故宫');
      const other = plan.candidates.filter(x=>x.name!==palace.name);
      plan.daily[0].items = other.slice(0,2);
      plan.daily[1].items = [palace,other[2]];
    } else {
      const outdoors = plan.candidates.filter(x => x.indoor.startsWith('室外'));
      if (outdoors.length < 3) throw new Error('A09前置条件缺少三处户外候选');
      plan.daily[0].items = outdoors.slice(0,3);
      plan.candidates = outdoors.filter(x => !x.indoor.includes('室内'));
    }
    for (const day of plan.daily) { day.routeCheck = null; delete day.removedItems; }
    delete plan.changeSummary;
    sessionStorage.setItem('tripPlan',JSON.stringify(plan));
    renderPlan(request,plan);
    return {description:id==='A08' ? '真实知识库候选建立两日场景，第二天包含故宫；未修改应用实现。' : '从本次真实检索中选三处室外为主的条目；受控可替换候选集仅保留不含室内标签的条目，以模拟没有可确认室内替代项。植物园含展馆标签，但本场景不将其视为已确认可避暴雨的替代点；此为受控前置条件，不代表厦门真实缺少室内景点。',candidateNames:plan.candidates.map(x=>x.name),daily:plan.daily.map(d=>d.items.map(x=>x.name))};
  },id);
}

(async () => {
  fs.mkdirSync(output,{recursive:true});
  const metadata = {
    startedAt:new Date().toISOString(),baseUrl,
    execution:'Playwright使用独立浏览器上下文操作真实表单，调用正在运行的本地API。API响应、会话状态、可见文本和截图全部留档。',
    hashes:Object.fromEntries(['index.html','server.js','中国大陆景点知识库_初版.md','eval/rubric.md','eval/test-cases.json'].map(file=>[file,crypto.createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex')])),
    health:await (await fetch(`${baseUrl}/api/health`)).json(),
    llmStatus:await (await fetch(`${baseUrl}/api/llm/status`)).json()
  };
  const metadataPath = path.join(output,'run-metadata.json');
  if (fs.existsSync(metadataPath)) {
    const initial = JSON.parse(fs.readFileSync(metadataPath,'utf8'));
    initial.retries = [...(initial.retries || []),metadata];
    fs.writeFileSync(metadataPath,JSON.stringify(initial,null,2));
  } else fs.writeFileSync(metadataPath,JSON.stringify(metadata,null,2));
  const browser = await chromium.launch({channel:'msedge',headless:true});
  try {
    for (const [id, turns] of Object.entries(definitions)) {
      if (process.argv.includes('--only') && id !== process.argv[process.argv.indexOf('--only')+1]) continue;
      if (fs.existsSync(path.join(output,`${id}-result.json`))) {
        const previous = JSON.parse(fs.readFileSync(path.join(output,`${id}-result.json`),'utf8'));
        if (previous.status === 'captured') {console.log(`${id} already captured`); continue;}
        const archive = path.join(output,'attempts',`${id}-${Date.now()}`);
        fs.mkdirSync(archive,{recursive:true});
        for (const file of fs.readdirSync(output).filter(file=>file.startsWith(`${id}-`))) fs.copyFileSync(path.join(output,file),path.join(archive,file));
      }
      const test = testCases.find(x=>x.id===id);
      const context = await browser.newContext({viewport:{width:1365,height:1000},locale:'zh-CN',timezoneId:'Asia/Shanghai'});
      const page = await context.newPage();
      const trace=[];
      const pending=[];
      page.on('response',response => {
        if (!response.url().includes('/api/')) return;
        pending.push((async()=>{let body;try{body=await response.json();}catch{body=await response.text().catch(()=>null);}trace.push({path:new URL(response.url()).pathname,query:new URL(response.url()).search,method:response.request().method(),status:response.status(),requestBody:response.request().postDataJSON(),body});})());
      });
      page.on('pageerror',error=>trace.push({pageError:error.message}));
      const record={id,name:test.name,rawTurns:test.turns,checkpoints:test.checkpoints,auxiliaryInputs:auxiliaries[id]||null,turns:[]};
      try {
        await page.goto(baseUrl);
        for(let n=0;n<turns.length;n++) {
          await fill(page,turns[n],test.turns[Math.min(n,test.turns.length-1)]);
          await submit(page);
          await Promise.allSettled(pending);
          record.turns.push(await capture(page,`${id}-turn${n+1}`,trace));
        }
        if(['A08','A09'].includes(id)) {
          record.fixture=await controlledScenario(page,id);
          record.beforeAdjustment=await capture(page,`${id}-before-adjustment`,trace,{fixture:record.fixture});
          const event=id==='A08' ? '第2天故宫博物院临时闭馆，只调整受影响的第2天，其他景点和第1天不动。' : '第1天厦门暴雨，原行程里三个户外点，附近没有可确认的室内景点。';
          record.eventAdapter=event;
          await page.locator('#adjust-form [name="event"]').fill(event);
          await page.locator('#adjust-form button[type="submit"]').click();
          await page.waitForFunction(()=>document.querySelector('#adjust-form button[type="submit"]')?.disabled===false,null,{timeout:100000});
          await Promise.allSettled(pending);
          record.afterAdjustment=await capture(page,`${id}-after-adjustment`,trace);
        }
        record.status='captured';
      } catch(error) {record.status='execution_error';record.error=error.stack;}
      fs.writeFileSync(path.join(output,`${id}-result.json`),JSON.stringify(record,null,2));
      const last=record.afterAdjustment||record.turns.at(-1);
      console.log(JSON.stringify({id,status:record.status,error:record.error,planner:last?.plan?.plannerMode,modelNote:last?.plan?.modelNote,invalid:last?.invalidFields,days:last?.daySummaries,budget:last?.budget?.estimate,change:last?.plan?.changeSummary}));
      await context.close();
    }
  } finally {await browser.close();}
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
