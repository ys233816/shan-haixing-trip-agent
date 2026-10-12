'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require('C:/Users/17330/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const dir = path.join(__dirname,'agent-regressions','2026-10-12-weather');
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname,'runs','2026-10-11-remaining','A09-before-adjustment.json')));
const baseUrl = 'http://127.0.0.1:4173/';

(async () => {
  const browser = await chromium.launch({channel:'msedge',headless:true});
  const results=[];
  try {
    for(const version of ['v1','v2','v3']) {
      for(const [label,viewport] of Object.entries({desktop:{width:1365,height:900},mobile:{width:390,height:844}})) {
        const context=await browser.newContext({viewport,locale:'zh-CN'});
        await context.addInitScript(({request,plan})=>{
          if (!sessionStorage.getItem('tripPlan')) {
            sessionStorage.setItem('tripRequest',JSON.stringify(request));
            sessionStorage.setItem('tripPlan',JSON.stringify(plan));
          }
        },{request:fixture.request,plan:fixture.plan});
        const page=await context.newPage();
        const errors=[];
        page.on('pageerror',e=>errors.push(e.message));
        await page.route('**/*',async route=>{
          const url=new URL(route.request().url());
          if (url.href===baseUrl) return route.fulfill({contentType:'text/html',body:fs.readFileSync(path.join(dir,version,'index.snapshot.html'),'utf8')});
          if (url.pathname==='/api/llm/status') return route.fulfill({contentType:'application/json',body:JSON.stringify({configured:false,model:null})});
          await route.abort();
        });
        await page.goto(baseUrl);
        await page.locator('#itinerary.show').waitFor();
        await page.locator('#adjust-form [name="event"]').fill('第1天厦门暴雨，原行程里三个户外点，附近没有可确认的室内景点。');
        await page.locator('#adjust-form button[type="submit"]').click();
        await page.waitForFunction(()=>document.querySelector('#adjust-result').textContent.includes('暂缓'));
        const after=await page.evaluate(()=>({plan:JSON.parse(sessionStorage.getItem('tripPlan')),text:document.querySelector('#itinerary').innerText,markdown:buildPlanMarkdown(JSON.parse(sessionStorage.getItem('tripRequest')),JSON.parse(sessionStorage.getItem('tripPlan'))),activeNames:[...document.querySelectorAll('.stop-name')].map(x=>x.innerText)}));
        await page.locator('#itinerary .day-card').first().screenshot({path:path.join(dir,version,`A09-${label}.png`)});
        await page.reload();
        await page.locator('#itinerary.show').waitFor();
        const restored=await page.evaluate(()=>({plan:JSON.parse(sessionStorage.getItem('tripPlan')),activeNames:[...document.querySelectorAll('.stop-name')].map(x=>x.innerText),horizontalOverflow:document.documentElement.scrollWidth>innerWidth}));
        assert.equal(errors.length,0);
        if(version==='v3') {
          assert.equal(after.activeNames.length,0);
          assert.equal(after.plan.daily[0].removedItems.length,3);
          assert.match(after.text,/预警/);
          assert.match(after.markdown,/自由活动 \/ 休息/);
          assert.match(after.markdown,/预警/);
          assert.equal(restored.activeNames.length,0);
          assert.equal(restored.horizontalOverflow,false);
        }
        const record={version,viewport:label,method:'浏览器重放固定A09会话并提交局部调整；关闭模型API，无付费调用；外部装饰资源未加载。',after,restored,errors};
        fs.writeFileSync(path.join(dir,version,`A09-${label}.json`),JSON.stringify(record,null,2));
        results.push({version,viewport:label,activeNames:after.activeNames,restoredNames:restored.activeNames,hasAlert:after.text.includes('预警'),horizontalOverflow:restored.horizontalOverflow,errors});
        await context.close();
      }
    }
    fs.writeFileSync(path.join(dir,'browser-verification.json'),JSON.stringify(results,null,2));
    console.log(JSON.stringify(results,null,2));
  } finally {await browser.close();}
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
