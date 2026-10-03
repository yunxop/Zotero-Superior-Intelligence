const assert = require('node:assert/strict');
const fs = require('node:fs');
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (e) {
  console.log('Skipping library_ui.js: playwright not installed in environment.');
  process.exit(0);
}

(async()=>{
 let browser;
 try {
  const launchOptions = { headless: true };
  if (process.env.CHROME_PATH) launchOptions.executablePath = process.env.CHROME_PATH;
  else if (fs.existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe')) {
    launchOptions.executablePath = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
  }
  browser = await chromium.launch(launchOptions);
 } catch (err) {
  console.log('Skipping library_ui.js: browser launch failed (' + err.message + ')');
  process.exit(0);
 }
 try {
  const context=await browser.newContext({viewport:{width:1060,height:850},deviceScaleFactor:1.5});
  const page=await context.newPage();
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.setContent(fs.readFileSync('docs/ui-preview/library.html','utf8'));
  await page.addScriptTag({content:fs.readFileSync('plugin_src/chrome/content/scripts/markdown_renderer.js','utf8')});
  await page.addScriptTag({content:fs.readFileSync('plugin_src/chrome/content/scripts/library_index.js','utf8')});
  const setupMock=()=>{
   window.calls=[];window.stops=[];
   window.savedTaskSettings ||= {thinking:false,maxTokens:8192};
   window.Zotero={getMainWindow:()=>window,MinerUAI:{getTaskSettings:()=>({...window.savedTaskSettings}),saveTaskSettings:(_type,value)=>{window.savedTaskSettings={...value};},describeError:e=>e.message,renderMarkdown:(node,text)=>MarkdownRenderer.render(node,text),openPreferences(){},stopLibraryTask(id){window.stops.push(id);window.release?.();},
    async libraryCall(action,json,onEvent){
     const payload=JSON.parse(json);calls.push({action,payload});let result;
     if(action==='options')result={defaultLibrary:1,activeProfile:1,libraries:[{id:1,name:'我的图书馆',collections:[{id:10,name:'生态系统',parentID:null},{id:11,name:'碳循环',parentID:10}]}],profiles:[{slot:1,name:'科研助手',model:'test-model'}],selected:[{id:1,libraryID:1,title:'Carbon cycling and climate'}]};
     else if(action==='source')result={located:true};
     else if(action==='save')result={noteID:10};
     else if(action==='index')result={items:128,papers:128,abstracts:112,annotated:46,evidenceItems:115,sources:530};
     else {
      onEvent(JSON.stringify({kind:'progress',text:'正在检索资料…'}));
      onEvent(JSON.stringify({kind:'scope',stats:{items:128,papers:128,abstracts:112,annotated:46,evidenceItems:115,sources:530}}));
      if(payload.question==='停止测试') {await new Promise(resolve=>window.release=resolve);return JSON.stringify({ok:false,error:'任务已停止。'});}
      onEvent(JSON.stringify({kind:'answer',text:'正在生成科研回答'}));
      result={id:payload.id,action,question:payload.question,markdown:'## 主要发现\n温度变化可能影响碳释放。[S1]\n\n| 主题 | 证据 |\n| --- | --- |\n| 碳循环 | 高亮原文 [S1] |',sources:[{ref:'S1',kind:'annotation',sourceID:3,itemID:1,uid:'1/K1/K3/annotation/0',title:'Carbon cycling and climate',text:'Temperature increases carbon release.',page:'7',category:'结论'}],referencedItems:1,usage:{total:1500,unreported:0},durationMs:1200,cachedBatches:0};
     }
     return JSON.stringify({ok:true,result});
    }
   }};
  };
  await page.evaluate(setupMock);
  await page.addScriptTag({content:fs.readFileSync('plugin_src/chrome/content/scripts/library_ui.js','utf8')});
  await page.evaluate(()=>window.dispatchEvent(new Event('load')));
  await page.locator('#library-library').selectOption('1');
  await page.locator('#library-mode').selectOption('collection');
  assert.equal(await page.locator('#library-collection-box').isVisible(),true);
  await page.locator('#library-collection').selectOption('11');
  await page.locator('#library-question').fill('碳循环机制有哪些不同解释？');
  assert.equal(await page.locator('#library-thinking').getAttribute('aria-pressed'),'false');
  await page.locator('#library-thinking').click();
  assert.equal(await page.locator('#library-thinking').getAttribute('aria-pressed'),'true');
  await page.locator('#library-limit').selectOption('16384');
  await page.locator('#library-ask').click();
  await page.waitForFunction(()=>document.querySelector('#library-status').textContent.includes('已完成'));
  assert.equal(await page.locator('.citation').count(),2);
  await page.locator('.citation').first().click();
  await page.getByText('保存为笔记',{exact:true}).click();
  await page.getByText('已保存到图书馆',{exact:true}).waitFor();
  await page.locator('article summary').first().click();
  await page.locator('.source').waitFor(); assert.equal(await page.locator('.source').count(),1);
  const last=await page.evaluate(()=>calls.find(c=>c.action==='ask').payload);
  assert.equal(last.options.collectionID,11);assert.equal(last.options.aiNotes,false);
  assert.equal(last.thinking,true);assert.equal(last.maxTokens,16384);
  await page.locator('#library-question').fill('这些方法有哪些局限？');
  await page.locator('#library-ask').click();
  await page.waitForFunction(()=>document.querySelector('#library-status').textContent.includes('已完成'));
  const followupPayload=await page.evaluate(()=>calls.filter(c=>c.action==='ask').at(-1).payload);
  assert.equal(followupPayload.history.length,1);
  assert.ok(followupPayload.history[0].summary.includes('温度变化'));
  assert.ok(!followupPayload.history[0].summary.includes('[S1]'));
  assert.equal(followupPayload.history[0].sources[0].sourceID,3);
  assert.equal(followupPayload.history[0].sources[0].itemID,1);
  assert.equal(followupPayload.history[0].scopeKey,JSON.stringify(last.options));
  const persisted=await page.evaluate(()=>window.savedTaskSettings);
  const reopened=await page.context().newPage();
  await reopened.setContent(fs.readFileSync('docs/ui-preview/library.html','utf8'));
  await reopened.evaluate(value=>{window.savedTaskSettings=value;},persisted);
  await reopened.evaluate(setupMock);
  await reopened.addScriptTag({content:fs.readFileSync('plugin_src/chrome/content/scripts/library_ui.js','utf8')});
  await reopened.evaluate(()=>window.dispatchEvent(new Event('load')));
  await reopened.waitForFunction(()=>document.querySelector('#library-ask').disabled===false);
  assert.equal(await reopened.locator('#library-thinking').getAttribute('aria-pressed'),'true');
  assert.equal(await reopened.locator('#library-limit').inputValue(),'16384');
  await reopened.close();
  await page.locator('#library-from').fill('2020');
  await page.locator('#library-ask').click();
  await page.waitForFunction(()=>document.querySelector('#library-status').textContent.includes('已完成'));
  assert.equal(await page.evaluate(()=>calls.filter(c=>c.action==='ask').at(-1).payload.history.length),0,'changing the scope resets history');
  await page.locator('#library-from').fill('');
  assert.equal(await page.evaluate(()=>SILibraryIndex.plain('<p>hello &amp; world</p><script>bad</script><p>second</p>')),'hello & world\nsecond');
  const xmlRegression=await page.evaluate(()=>{
    const xml=new DOMParser().parseFromString('<window xmlns="http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul"/>','application/xml');
    const note='<p>A&nbsp;B<br>note<img src="https://example.invalid/must-not-load.png"></p><p>final<script>bad</script></p>';
    const old=xml.createElementNS('http://www.w3.org/1999/xhtml','template');
    let oldCode;
    try{old.innerHTML=note;}catch(error){oldCode=error.code;}
    const original=Zotero.getMainWindow;
    try{
      Zotero.getMainWindow=()=>({document:xml});
      return {oldCode,text:SILibraryIndex.plain(note)};
    }finally{Zotero.getMainWindow=original;}
  });
  assert.equal(xmlRegression.oldCode,12,'the former parser must reproduce XML SyntaxError');
  assert.equal(xmlRegression.text,'A\u00a0B\nnote\nfinal');
  await page.screenshot({path:process.env.SI_UI_SCREENSHOT || 'docs/ui-preview/library-chat.png',fullPage:true});
  await page.setViewportSize({width:690,height:850});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.locator('#library-question').fill('停止测试');
  await page.locator('#library-ask').click();
  await page.locator('#library-stop').click();
  await page.waitForFunction(()=>document.querySelector('#library-status').textContent.includes('任务已停止'));
  assert.equal(await page.locator('#library-ask').isEnabled(),true);
  await page.locator('#library-clear').click();assert.equal(await page.locator('article').count(),0);
  await page.locator('#library-question').fill('新的研究话题');
  await page.locator('#library-ask').click();
  await page.waitForFunction(()=>document.querySelector('#library-status').textContent.includes('已完成'));
  assert.equal(await page.evaluate(()=>calls.filter(c=>c.action==='ask').at(-1).payload.history.length),0,'clearing starts a new topic');
  assert.deepEqual(errors,[]);
  console.log('library browser UI tests passed: follow-up history, persisted settings after reopen, scope reset, new topics, rendering, citations, save, extraction, responsive layout and stop');
 } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});

