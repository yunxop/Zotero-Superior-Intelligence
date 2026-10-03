const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const load = (ctx, file) => vm.runInContext(fs.readFileSync(path.join(__dirname, '../plugin_src/chrome/content/scripts', file), 'utf8'), ctx);
async function main() {
  const disk = new Map(), items = new Map(), collections = [{id:10,libraryID:1,parentID:null,name:'父分类'}, {id:11,libraryID:1,parentID:10,name:'子分类'}];
  let reads = 0, observer, serial = 200, llmCalls = 0, opened, selected, missing = false;
  const make = (id, type, fields = {}, parentID = null, libraryID = 1) => {
    const item = { id, key:'K'+id, libraryID, parentID, deleted:false, fields: { dateModified:'v1', ...fields }, tags:[], collections:[],
      getField(key) { return this.fields[key] || ''; }, getCreators:()=>[{lastName:'Author'}], getTags(){return this.tags.map(tag=>({tag}));}, getCollections(){return this.collections;},
      isRegularItem:()=>type==='regular', isAttachment:()=>type==='attachment', isNote:()=>type==='note', isAnnotation:()=>type==='annotation',
      getNoteTitle(){return this.fields.title || '';}, getNote(){reads++; return this.fields.note || '';}, async loadDataType(t){assert.ok(['note','annotationDeferred'].includes(t));},
      getFilePathAsync(){throw Error('PDF access forbidden');}, async fileExists(){return !missing;}
    }; items.set(id,item); return item;
  };
  const paper = make(1,'regular',{title:'碳循环 carbon mechanisms',date:'2024',abstractNote:'Carbon cycling depends on temperature.'}); paper.collections=[11];
  const att = make(2,'attachment',{},1); att.attachmentContentType='application/pdf';
  const ann = make(3,'annotation',{},2); Object.assign(ann,{annotationText:'Temperature increases carbon release.',annotationComment:'需要比较区域差异',annotationPageLabel:'7',annotationColor:'#ffd400'}); ann.tags=['SI 自动高亮'];
  make(4,'note',{title:'用户阅读笔记',note:'Carbon carbon carbon 手动记录'},1);
  make(5,'note',{title:'文献总结 · AI',note:'AI inferred text'},1);
  make(6,'regular',{title:'另一篇 carbon',date:'2020'});
  make(7,'regular',{title:'Group secret',abstractNote:'Never send this'},null,2);
  for (const c of collections) { c.getDescendents=()=>c.id===10 ? [{id:11}] : []; c.getChildItems=()=>[...items.values()].filter(i=>!i.deleted && i.collections.includes(c.id)).map(i=>i.id); }
  const libraries=[1,2].map(id=>({libraryID:id,libraryType:id===1?'user':'group',name:'Library '+id,editable:true,async waitForDataLoad(type){assert.ok(['item','collection'].includes(type));}}));
  const ctx=vm.createContext({console, Intl, AbortController, setTimeout, clearTimeout, PathUtils:{join:(...a)=>a.join('/')}, IOUtils:{async readJSON(p){if(!disk.has(p))throw Error('missing');return structuredClone(disk.get(p));},async writeJSON(p,v){disk.set(p,structuredClone(v));}},
    Zotero:{File:{pathToFile(p){return {path:p,append(name){this.path+='/'+name;}};},async getContentsAsync(p){if(!disk.has(p))throw Error('missing');return disk.get(p);},async putContentsAsync(p,v){disk.set(p,v);}},DataDirectory:{dir:'/data'},Libraries:{get:id=>libraries.find(l=>l.libraryID===id),getAll:()=>libraries,userLibraryID:1},
      Items:{get:id=>items.get(id),getAsync:async id=>items.get(id),getAll:async id=>[...items.values()].filter(i=>i.libraryID===id)},
      Collections:{get:id=>collections.find(c=>c.id===id),getByLibrary:()=>collections},
      Notifier:{registerObserver(value){observer=value;return 0;},unregisterObserver(){}},Promise:{delay:async()=>{}},
      getMainWindow:()=>({AbortController,ZoteroPane:{selectItem:async id=>{selected=id;}},focus(){}}),
      getActiveZoteroPane:()=>({getSelectedItems:()=>[paper]}),Reader:{open:async(...args)=>{opened=args;}},API:{getLibraryPrefix:()=> 'library'},
      MinerUAI:{getProfiles:()=>[{name:'Test',provider:'openai',apiBase:'https://test.invalid/v1',model:'mock',apiKey:'test'}],activeProfile:()=>1},
      Item: class {constructor(type){assert.equal(type,'note');}setNote(html){this.html=html;}addTag(t){this.tag=t;}addToCollection(id){this.collection=id;}async saveTx(){this.id=serial++;items.set(this.id,this);}}
    }});
  for(const file of ['error_utils.js','markdown_renderer.js','library_index.js','library_chat.js'])load(ctx,file);
  const index=ctx.SILibraryIndex, chat=ctx.SILibraryChat;
  index.plain=text=>text; // HTML parsing is separately exercised in browser UI tests.
  index.init();
  let cache=await index.sync(1);
  assert.equal(Object.keys(cache.records).length,2);
  assert.equal(cache.records.K1.sources.filter(s=>s.kind==='annotation').length,1);
  assert.equal(cache.records.K1.sources.find(s=>s.kind==='aiComment').category,'结论');
  assert.equal(cache.records.K1.sources.filter(s=>s.kind==='aiNote').length,1);
  const previousReads=reads;
  await index.sync(1);assert.equal(reads,previousReads,'unchanged notes should not be re-read');
  items.get(4).fields.note='Changed carbon note'; observer.notify('modify','item',[4]);
  cache=await index.sync(1);assert.ok(cache.records.K1.sources.some(s=>s.text==='Changed carbon note'));
  items.get(4).deleted=true; cache=await index.sync(1);assert.ok(!cache.records.K1.sources.some(s=>s.sourceID===4));
  const opts={libraryID:1,mode:'collection',collectionID:10,recursive:true,abstract:true,annotations:true,notes:true,aiNotes:false};
  let scope=index.scope(cache,opts);assert.equal(scope.stats.items,1);assert.ok(!scope.sources.some(s=>s.kind==='aiNote'));
  assert.equal(index.scope(cache,{...opts,recursive:false}).stats.items,0);
  assert.equal(scope.stats.collectionAudit.length,2);
  assert.equal(scope.stats.collectionAudit.find(c=>c.id===11).indexed,1);
  const deep={id:12,libraryID:1,parentID:11,name:'孙分类',getDescendents:()=>[],getChildItems:()=>[1]};
  collections.push(deep);collections[0].getDescendents=()=>[{id:11},{id:12}];
  paper.collections=[10,12];cache.records.K1.collections=[];
  const live=index.scope(cache,opts);
  assert.equal(live.stats.items,1,'live membership and nested scope must deduplicate');
  assert.equal(live.stats.collectionAudit.find(c=>c.id===12).afterFilters,1);
  collections.pop();collections[0].getDescendents=()=>[{id:11}];paper.collections=[11];

  assert.equal(index.scope(cache,{...opts,from:2025}).stats.items,0);
  assert.equal(index.scope(cache,{...opts,mode:'selected',itemIDs:[1,1,7]}).stats.items,1);
  assert.equal(index.scope(cache,{...opts,category:'结论'}).sources.length,2);
  assert.throws(()=>index.scope(cache,{...opts,from:2025,to:2020}),/年份/);
  let lastMessages;
  ctx.LLMClient={complete:async(messages,config,options)=>{
    lastMessages = messages;
    llmCalls++;assert.equal(config.llmSlot,1);assert.ok(options.signal);assert.ok(!JSON.stringify(messages).includes('Never send this'));
    options.onUsage({total_tokens:100});
    if(options.stream)options.onStream('delta','Carbon result [S1] [S99999]');
    return 'Carbon result [S1] [S99999]';
  }};
  const invoke=async(action,more={})=>JSON.parse(await chat.call(action,JSON.stringify({id:'job'+serial++,options:opts,profileSlot:1,question:'carbon',...more})));
  const answer=await invoke('ask');assert.equal(answer.ok,true,answer.error);assert.ok(answer.result.markdown.includes('[来源未核实]'));assert.equal(answer.result.usage.total,100);
  assert.ok(answer.result.sources.every(s=>s.libraryID===1));
  const history = [{ question: answer.result.question, scopeKey: JSON.stringify(opts), summary: 'Earlier carbon answer [S99999]', sources: answer.result.sources.map(s=>({sourceID:s.sourceID,itemID:s.itemID,uid:s.uid})) }];
  const followup=await invoke('ask',{question:'zzfollowuponly',history});
  assert.equal(followup.ok,true,followup.error);
  assert.ok(followup.result.sources.length>0,'a follow-up retains current evidence even without a new lexical hit');
  assert.ok(followup.result.sources.every(s=>s.itemID===1));
  assert.ok(JSON.stringify(lastMessages).includes('Earlier carbon answer'));
  assert.ok(!JSON.stringify(lastMessages).includes('S99999'),'old reference numbers must not reach the next prompt');
  assert.deepEqual(Array.from(followup.result.sources,s=>s.ref),followup.result.sources.map((_,i)=>'S'+(i+1)));
  const oldText=scope.sources.find(s=>s.kind==='annotation').text;
  scope.sources.find(s=>s.kind==='annotation').text='Refreshed carbon evidence from the current index.';
  const refreshed=await invoke('ask',{question:'zzfollowuponly',history});
  assert.equal(refreshed.ok,true,refreshed.error);
  assert.ok(refreshed.result.sources.some(s=>s.text==='Refreshed carbon evidence from the current index.'),'resolve old IDs to current indexed text');
  scope.sources.find(s=>s.kind==='annotation').text=oldText;
  const requestsBeforeInvalid=llmCalls;
  const otherScope=await invoke('ask',{question:'zzfollowuponly',history:[{...history[0],scopeKey:'another scope'}]});
  assert.equal(otherScope.result.sources.length,0,'scope changes cannot retain prior evidence');
  const forged=await invoke('ask',{question:'zzfollowuponly',history:[{...history[0],sources:[{sourceID:7,itemID:7,uid:'2/K7/K7/abstract/0'},{sourceID:3,itemID:1,uid:'forged'}]}]});
  assert.equal(forged.result.sources.length,0,'foreign or stale source references are ignored');
  assert.equal(llmCalls,requestsBeforeInvalid);
  const prior={itemID:1,title:'Carbon mechanisms',text:'Temperature drives release.'};
  const unrelated={itemID:6,title:'Other field',text:'An unrelated limitation.'};
  assert.equal(chat.select([unrelated,prior],'limitation',14000,[prior])[0].itemID,1,'follow-up evidence takes priority over unrelated keyword hits');
  const samePaperNew={itemID:1,title:'Carbon mechanisms',text:'Important limitation from the same study.'};
  assert.equal(chat.select([unrelated,prior,samePaperNew],'limitation',14000,[prior])[0].text,samePaperNew.text,'new matching evidence in prior papers is preferred');
  const before=llmCalls;
  const stats=await invoke('stats');assert.equal(stats.ok,true);assert.equal(llmCalls,before);assert.match(stats.result.markdown,/1 个条目/);
  const empty=await invoke('ask',{question:'xxxxnosuchterm'});assert.equal(llmCalls,before);assert.match(empty.result.markdown,/没有检索到/);
  const overview=await invoke('overview');assert.equal(overview.ok,true,overview.error);assert.equal(overview.result.sources.length,scope.sources.length);
  const repeat=await invoke('overview');assert.equal(repeat.ok,true,repeat.error);assert.equal(repeat.result.cachedBatches,1);
  const annSource=answer.result.sources.find(s=>s.kind==='annotation');
  await chat.openSource({resultID:answer.result.id,ref:annSource.ref});assert.equal(opened[0],2);assert.equal(opened[1].annotationID,'K3');
  missing=true;await chat.openSource({resultID:answer.result.id,ref:annSource.ref});assert.equal(selected,1);
  const saved=await chat.save({resultID:answer.result.id});assert.equal(items.get(saved.noteID).tag,'SI AI');assert.equal(items.get(saved.noteID).collection,10);
  assert.equal((await chat.save({resultID:answer.result.id})).noteID,saved.noteID);
  const oldScope=index.scope.bind(index);index.scope=()=>scope; index.sync=async()=>cache;
  const smallScope=scope;
  scope={records:[],stats:{items:26,papers:26,sources:26,evidenceItems:26},sources:Array.from({length:26},(_,i)=>({uid:'large'+i,itemID:1000+i,sourceID:1000+i,sourceKey:'L'+i,libraryID:1,title:'Large '+i,kind:'abstract',text:'UNIQUE_'+i+' '+ 'evidence '.repeat(160)}))};
  const seenBatches=[];
  ctx.LLMClient.complete=async(messages,config,options)=>{
    const content=messages[1].content; seenBatches.push(content);
    options.onUsage({total_tokens:30});return 'Evidence [S1]';
  };
  const overviewPayload={id:'large-first',options:opts,profileSlot:1,question:'all evidence'};
  const interrupted=JSON.parse(await chat.call('overview',JSON.stringify(overviewPayload),json=>{
    const event=JSON.parse(json);
    if(event.kind==='progress' && /正在处理 2 \/ /.test(event.text))chat.stop('large-first');
  }));
  assert.equal(interrupted.ok,false);assert.equal(seenBatches.length,1,'stop must prevent the next provider request');
  const resumed=JSON.parse(await chat.call('overview',JSON.stringify({...overviewPayload,id:'large-second'})));
  assert.equal(resumed.ok,true,resumed.error);assert.equal(resumed.result.cachedBatches,1);
  for(let i=0;i<26;i++)assert.ok(seenBatches.some(text=>text.includes('UNIQUE_'+i+' ')),'all scope sources must be covered');
  assert.equal(resumed.result.sources.length,26);
  let partialRequests=0;
  ctx.LLMClient.complete=async(_messages,config,options)=>{
    partialRequests++;assert.equal(config.llmThinking,true);assert.equal(config.llmMaxTokens,16384);
    options.onIncomplete();return '> **未完成**：partial evidence [S1]';
  };
  const partialOverview=await invoke('overview',{question:'partial test',thinking:true,maxTokens:16384});
  assert.equal(partialOverview.ok,true,partialOverview.error);assert.equal(partialOverview.result.incomplete,true);
  assert.equal(partialRequests,1);assert.ok(partialOverview.result.sources.length<26);
  assert.match(partialOverview.result.markdown,/未完成/);
  scope=smallScope;
  ctx.LLMClient.complete=async(_messages,_config,options)=>new Promise((resolve,reject)=>{options.signal.addEventListener('abort',()=>reject(Error('aborted')));});
  const cancelled=chat.call('ask',JSON.stringify({id:'cancel',options:opts,profileSlot:1,question:'carbon'}));
  await new Promise(resolve=>setImmediate(resolve)); chat.stop('cancel');
  assert.equal(JSON.parse(await cancelled).ok,false);assert.equal(chat.jobs.size,0);
  chat.destroy();assert.equal(index.observer,null);
  load(ctx,'llm_client.js');
  let passedSignal, recorded=0, reported;
  ctx.LLMUsage={record(){recorded++;}};
  ctx.fetch=async(_url,options)=>{passedSignal=options.signal;return {ok:true,headers:{get:()=> 'application/json'},json:async()=>({choices:[{message:{content:'ok'}}],usage:{total_tokens:12}})};};
  const abort=new AbortController();
  await ctx.LLMClient.complete([],{llmApiBase:'http://localhost:1234/v1',llmModel:'test'},{signal:abort.signal,onUsage:value=>reported=value});
  assert.ok(passedSignal);assert.equal(passedSignal.aborted,false);assert.equal(recorded,1);assert.equal(reported.total_tokens,12);
  ctx.fetch=async(_url,options)=>new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Error('abort'))));
  const stopRequest=ctx.LLMClient.complete([],{llmApiBase:'http://localhost:1234/v1',llmModel:'test'},{signal:abort.signal});
  abort.abort();await assert.rejects(stopRequest,error=>error.name==='AbortError');assert.equal(recorded,1);

  await persistentOverview();
  console.log('library tests passed: incremental index, scope isolation, retrieval, provenance, cached overview, local stats, source navigation, save and cancellation; PDF access forbidden');
}
async function persistentOverview() {
  const disk = new Map();
  const sources = Array.from({length:26},(_,i)=>({uid:'1/P'+i+'/abstract/0',itemID:1000+i,sourceID:1000+i,sourceKey:'P'+i,libraryID:1,title:'Paper '+i,kind:'abstract',text:'PRIVATE_SOURCE_'+i+' '+ 'evidence '.repeat(160)}));
  const opts={libraryID:1,mode:'all',abstract:true,annotations:true,notes:true,aiNotes:false};
  const profile={name:'Resume',provider:'openai',apiBase:'https://resume.test/v1',model:'mock',apiKey:'sk-PRIVATE-NOT-SAVED'};
  const create=(more={})=>{
    const selectedSources=more.sources || sources;
    const ctx=vm.createContext({console,Intl,AbortController,PathUtils:{join:(...p)=>p.join('/')},IOUtils:{
      async readJSON(file){if(!disk.has(file)){const error=Error('missing');error.name='NotFoundError';throw error;}return JSON.parse(disk.get(file));},
      async writeJSON(file,value,options){assert.equal(options.tmpPath,file+'.tmp');assert.equal(options.flush,true);disk.set(file,JSON.stringify(value));}
    },Zotero:{DataDirectory:{dir:'/library-resume'},logError(){},getMainWindow:()=>({AbortController}),MinerUAI:{getProfiles:()=>[{...profile,...more.profile}]}},
    SILibraryIndex:{init(){},destroy(){},sync:async()=>({}),scope:()=>({records:[],sources:selectedSources,stats:{items:26,papers:26,sources:26,evidenceItems:26}}),chunks(text,size){const out=[];for(let i=0;i<text.length;i+=size)out.push(text.slice(i,i+size));return out;}}});
    for(const file of ['error_utils.js','task_checkpoints.js','library_chat.js'])load(ctx,file);
    return ctx;
  };
  const invoke=async(ctx,id,more={},onEvent)=>JSON.parse(await ctx.SILibraryChat.call('overview',JSON.stringify({id,options:opts,profileSlot:1,question:'resume goal',...more}),onEvent));
  const install=(ctx,handler)=>{
    let requests=0;
    ctx.LLMClient={complete:async(messages,config,options)=>{requests++;options.onUsage({total_tokens:10});return handler ? handler(messages,config,options,requests) : 'Completed evidence [S1]';}};
    return ()=>requests;
  };
  let ctx=create(), count=install(ctx);
  const batchCount=ctx.SILibraryChat.batches(sources.map((s,i)=>({...s,ref:'S'+(i+1)}))).length;
  assert.ok(batchCount>1);
  const cancelled=await invoke(ctx,'persistent-stop',{},json=>{
    const event=JSON.parse(json);
    if(event.kind==='progress' && /正在处理 2 \/ /.test(event.text))ctx.SILibraryChat.stop('persistent-stop');
  });
  assert.equal(cancelled.ok,false);assert.match(cancelled.error,/任务已停止/);assert.equal(count(),1);
  let records=JSON.parse([...disk.values()][0]).entries;
  assert.equal(records.length,1,'all batches of one overview use one bounded checkpoint');
  assert.equal(records[0].record.notes.length,1);
  const storedText=[...disk.values()].join('');
  assert.ok(!storedText.includes(profile.apiKey));
  assert.ok(!storedText.includes('PRIVATE_SOURCE_'),'source documents are represented only by hashes');
  ctx=create();count=install(ctx);
  const restored=await invoke(ctx,'persistent-restored');
  assert.equal(restored.ok,true,restored.error);
  assert.equal(restored.result.cachedBatches,1);
  assert.equal(count(),batchCount,'only unfinished batches and the final synthesis request run after restart');
  assert.equal(restored.result.sources.length,26);
  ctx=create({profile:{apiKey:'sk-REPLACED-CREDENTIAL'}});count=install(ctx);
  const reused=await invoke(ctx,'persistent-repeated');
  assert.equal(reused.ok,true,reused.error);assert.equal(reused.result.cachedBatches,batchCount);assert.equal(count(),1);
  assert.equal(JSON.parse([...disk.values()][0]).entries.length,1);
  for(const [factory,payload,changePrompt] of [
    [{sources:sources.map((s,i)=>i ? s : {...s,text:s.text+' changed'})},{},false],
    [{},{question:'different goal'},false],
    [{},{options:{...opts,tag:'changed scope'}},false],
    [{profile:{provider:'custom',apiBase:'https://other.test/v1',model:'other'}},{},false],
    [{},{thinking:true,maxTokens:16384},false],
    [{},{},true]
  ]) {
    ctx=create(factory);if(changePrompt)ctx.SILibraryChat.system+=' New prompt revision.';
    count=install(ctx);
    const fresh=await invoke(ctx,'invalidation-'+disk.size+'-'+Math.random(),payload);
    assert.equal(fresh.ok,true,fresh.error);assert.equal(fresh.result.cachedBatches,0);
    assert.equal(count(),batchCount+1,'changed evidence, scope, goal, model or generation settings invalidate the checkpoint');
  }
  const entriesBeforePartial=JSON.parse([...disk.values()][0]).entries.length;
  ctx=create();count=install(ctx,(_messages,_config,options)=>{options.onIncomplete();return 'Partial evidence [S1]';});
  const partial=await invoke(ctx,'persistent-partial',{question:'partial goal'});
  assert.equal(partial.ok,true,partial.error);assert.equal(partial.result.incomplete,true);assert.equal(count(),1);
  assert.equal(JSON.parse([...disk.values()][0]).entries.length,entriesBeforePartial,'incomplete batch summaries never enter completed checkpoints');
  ctx=create();count=install(ctx);
  const afterPartial=await invoke(ctx,'persistent-after-partial',{question:'partial goal'});
  assert.equal(afterPartial.ok,true,afterPartial.error);assert.equal(afterPartial.result.cachedBatches,0);assert.equal(count(),batchCount+1);
  ctx=create();count=install(ctx,(_messages,_config,_options,n)=>{
    if(n<=batchCount)return ('Batch '+n+' [S1] ').repeat(600);
    if(n===batchCount+1)return 'Completed first merge [S1]';
    ctx.SILibraryChat.stop('persistent-merge-stop');throw Error('aborted merge');
  });
  const mergeStop=await invoke(ctx,'persistent-merge-stop',{question:'merge goal'});
  assert.equal(mergeStop.ok,false);assert.match(mergeStop.error,/任务已停止/);
  records=JSON.parse([...disk.values()][0]).entries;
  const mergeRecord=records.find(e=>Object.keys(e.record.merges || {}).length);
  assert.ok(mergeRecord,'completed merge summaries are checkpointed');
  assert.equal(mergeRecord.record.notes.length,batchCount);
  assert.equal(Object.keys(mergeRecord.record.merges).length,1);
  ctx=create();count=install(ctx);
  const mergeRestored=await invoke(ctx,'persistent-merge-restored',{question:'merge goal'});
  assert.equal(mergeRestored.ok,true,mergeRestored.error);assert.equal(mergeRestored.result.cachedBatches,batchCount);
  assert.equal(count(),2,'restart reuses completed batches and the first merge, completing only the remaining merge and final synthesis');
  console.log('library persistent overview passed: cross-VM batches/merges, cancellation, scope/model/source invalidation and incomplete/credential/source exclusion');
}

main().catch(error=>{console.error(error);process.exitCode=1;});
