const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const scripts = 'plugin_src/chrome/content/scripts/';
const abort = error => error?.name === 'AbortError' && error.cancelled === true;
const config = { llmApiBase: 'https://example.test/v1', llmApiKey: 'sk-DO-NOT-PERSIST', llmModel: 'test-model', llmProvider: 'openai', llmSlot: 1, llmThinking: false, llmMaxTokens: 8192 };
const disk = new Map();
function context(persistent = true) {
  const ctx = vm.createContext({ console, AbortController, TextDecoder, TextEncoder, setTimeout, clearTimeout, fetch: () => { throw Error('unexpected fetch'); }, LLMUsage: { record() {} }, SIError: { describe: error => error.message }, Zotero: { DataDirectory: { dir: '/zotero-data' }, logError() {} }, PathUtils: { join: (...parts) => parts.join('/') }, IOUtils: {
    async readJSON(path) { if (!disk.has(path)) { const error = Error('missing'); error.name = 'NotFoundError'; throw error; } return JSON.parse(disk.get(path)); },
    async writeJSON(path, value, options) { assert.equal(options.tmpPath, path + '.tmp'); assert.equal(options.flush, true); disk.set(path, JSON.stringify(value)); }
  } });
  if (persistent) vm.runInContext(fs.readFileSync(scripts + 'task_checkpoints.js', 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(scripts + 'llm_client.js', 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(scripts + 'mineru_client.js', 'utf8'), ctx);
  return ctx;
}
const analyze = (ctx, source, options, cfg = config, prompt = '') => ctx.LLMClient.analyzePaper(source, 'paper_summary', cfg, () => {}, prompt, () => {}, () => {}, options);
const watchdog = setTimeout(() => { console.error('task resume tests did not finish'); process.exit(1); }, 10000);
(async () => {
  let ctx = context();
  for (const text of ['', 'abc', '中文📚', 'x\ud800']) assert.equal(ctx.TaskCheckpointCache.hashText(text), crypto.createHash('sha256').update(text).digest('hex'));
  assert.equal(ctx.TaskCheckpointCache.keyFor('x', { a:1, b:2 }), ctx.TaskCheckpointCache.keyFor('x', { b:2, a:1 }));
  const source = 'A'.repeat(90001), controller = new AbortController();
  let calls = 0, cacheKey;
  ctx.LLMClient.complete = async function(_messages, _config, options) {
    calls++; assert.equal(options.signal, controller.signal);
    if (calls === 2) { controller.abort(); this.throwIfAborted(options.signal); }
    return 'completed first chunk';
  };
  await assert.rejects(() => analyze(ctx, source, { signal: controller.signal, resumeKey:'summary:1:ABC', onCheckpoint: info => { cacheKey=info.cacheKey; } }), abort);
  assert.equal(calls, 2);
  const checkpoint = await ctx.TaskCheckpointCache.get(cacheKey);
  assert.equal(checkpoint.notes.length, 1); assert.equal(checkpoint.completed, 1); assert.equal(checkpoint.total, 3); assert.equal(checkpoint.final, undefined);
  const persisted = [...disk.values()].join('');
  assert(!persisted.includes(config.llmApiKey)); assert(!persisted.includes(source));
  assert.equal((await ctx.LLMClient.getResumeInfo('summary:1:ABC')).completed, 1);

  ctx = context(); calls = 0;
  ctx.LLMClient.complete = async () => { calls++; return 'continued result ' + calls; };
  const final = await analyze(ctx, source, { resumeKey:'summary:1:ABC' });
  assert.equal(calls, 3); assert(final.includes('continued result 3'));
  assert.equal((await ctx.LLMClient.getResumeInfo('summary:1:ABC')).hasFinal, true);
  let streamed, cachedFinal;
  const record = await ctx.TaskCheckpointCache.get(cacheKey);
  await ctx.TaskCheckpointCache.put(cacheKey, { ...record, noteID: 42 });
  ctx.LLMClient.complete = async () => { throw Error('completed final must not request the API again'); };
  assert.equal(await ctx.LLMClient.analyzePaper(source, 'paper_summary', config, (_delta, full) => { streamed=full; }, '', () => {}, () => {}, { resumeKey:'summary:1:ABC', onCheckpoint: info => { cachedFinal=info.finalCached; } }), final);
  assert.equal(streamed, final); assert.equal(cachedFinal, true); assert.equal((await ctx.TaskCheckpointCache.get(cacheKey)).noteID, 42);
  assert.equal(await analyze(ctx, source, { resumeKey:'summary:1:ABC' }, { ...config, llmApiKey:'another-private-key' }), final);
  for (const [text, cfg, prompt] of [
    [source+'B', config, ''], [source, config, 'new prompt'], [source,{...config,llmApiBase:'https://other.test'},''],
    [source,{...config,llmModel:'another'},''], [source,{...config,llmSlot:2},''], [source,{...config,llmThinking:true},''],
    [source,{...config,llmMaxTokens:512},''], [source,{...config,llmProvider:'other'},'']
  ]) {
    calls = 0; ctx.LLMClient.complete = async () => { calls++; return 'fresh result'; };
    await analyze(ctx, text, { resumeKey:'summary:1:ABC' }, cfg, prompt);
    assert.equal(calls, 4, 'changed source/prompt/API/model/profile/thinking/output limit must invalidate checkpoints');
  }
  await ctx.LLMClient.clearResume('summary:1:ABC');
  assert.equal(await ctx.LLMClient.getResumeInfo('summary:1:ABC'), null);

  ctx = context(); calls = 0;
  // Two windows can finish the same identity with different model outputs.
  // The first complete result remains canonical and both saves must return one note.
  ctx = context();
  vm.runInContext(fs.readFileSync(scripts + 'main.js', 'utf8'), ctx);
  const waits = [], notes = new Map(); let created = 0, sameKey;
  const parent = { id: 7, libraryID: 1, isAttachment: () => false };
  ctx.Zotero.Items = { get: id => notes.get(id) };
  ctx.ZoteroAdapter = { createChildNote: async (_item, _title, markdown) => {
    const note = { id: ++created + 100, libraryID: 1, parentID: 7, markdown, isNote: () => true };
    notes.set(note.id, note); return note;
  } };
  ctx.LLMClient.complete = () => new Promise(resolve => waits.push(resolve));
  const generate = () => analyze(ctx, 'concurrent short source', { resumeKey: 'concurrent', onCheckpoint: state => { sameKey = state.cacheKey; } });
  const first = generate(), second = generate();
  while (waits.length < 2) await new Promise(setImmediate);
  waits[0]('first final');
  const firstFinal = await first;
  const summary = markdown => ({ targetItem: parent, title: 'Paper', promptType: 'paper_summary', markdown, checkpointKey: sameKey });
  const firstNote = await ctx.ZoteroMinerUAI.saveSummary(summary(firstFinal));
  const olderAnalysis = await ctx.TaskCheckpointCache.get(sameKey);
  waits[1]('different concurrent final');
  const secondFinal = await second;
  assert.equal(secondFinal, firstFinal, 'the final returned to the caller must match the canonical cached result');
  const secondNote = await ctx.ZoteroMinerUAI.saveSummary(summary(secondFinal));
  assert.equal(created, 1); assert.equal(firstNote.id, secondNote.id);
  const canonical = await ctx.TaskCheckpointCache.get(sameKey);
  await ctx.TaskCheckpointCache.put(sameKey, { ...olderAnalysis, final: undefined, stage: 'chunks', notes: ['outdated chunk'], merges: { old: 'outdated merge' } });
  let accepted = await ctx.TaskCheckpointCache.get(sameKey);
  assert.equal(accepted.final, firstFinal); assert.equal(accepted.stage, 'final'); assert.equal(accepted.noteID, firstNote.id);
  assert.equal(JSON.stringify(accepted.notes), JSON.stringify(canonical.notes)); assert.equal(JSON.stringify(accepted.merges), JSON.stringify(canonical.merges));
  firstNote.deleted = true;
  const rebuilt = await ctx.ZoteroMinerUAI.saveSummary(summary(firstFinal));
  assert.equal(created, 2); assert.notEqual(rebuilt.id, firstNote.id);
  assert.equal((await ctx.TaskCheckpointCache.get(sameKey)).noteID, rebuilt.id, 'explicit save update must replace a deleted note link');
  await ctx.TaskCheckpointCache.put(sameKey, olderAnalysis);
  assert.equal((await ctx.TaskCheckpointCache.get(sameKey)).noteID, rebuilt.id, 'an old analysis snapshot must not restore the deleted note link');
  const reused = await ctx.ZoteroMinerUAI.saveSummary(summary(secondFinal));
  assert.equal(created, 2); assert.equal(reused.id, rebuilt.id);
  assert(firstNote.markdown.includes(firstFinal), 'existing note content must not be overwritten');
  await ctx.TaskCheckpointCache.put('other-kind', { resumeKey:'other-kind',kind:'library',final:'old',stage:'old',completed:4 });
  await ctx.TaskCheckpointCache.put('other-kind', { resumeKey:'other-kind',kind:'library',final:'new',stage:'new',completed:1 });
  assert.equal((await ctx.TaskCheckpointCache.get('other-kind')).final, 'new', 'other task kinds retain their existing update behavior');
  assert.equal((await ctx.TaskCheckpointCache.get('other-kind')).completed, 1);
  ctx = context(); calls = 0;
  ctx.LLMClient.complete = async (_messages, _cfg, options) => { calls++; options.onIncomplete(); return 'unfinished partial'; };
  assert((await analyze(ctx, source, { resumeKey:'partial' })).includes('未完成'));
  assert.equal(await ctx.LLMClient.getResumeInfo('partial'), null);
  await analyze(ctx, source, { resumeKey:'partial' }); assert.equal(calls, 2);

  ctx = context(); calls = 0;
  const mergeController = new AbortController();
  ctx.LLMClient.complete = async function(_messages, _cfg, options) {
    calls++;
    if (calls <= 3) return String(calls).repeat(24000);
    if (calls === 4) return 'completed first merge';
    mergeController.abort(); this.throwIfAborted(options.signal);
  };
  await assert.rejects(() => analyze(ctx, source, { resumeKey:'merge', signal:mergeController.signal }), abort);
  assert.equal(calls, 5);
  ctx = context(); calls = 0;
  ctx.LLMClient.complete = async () => { calls++; return calls === 1 ? 'completed remaining merge' : 'merged final'; };
  assert((await analyze(ctx, source, { resumeKey:'merge' })).includes('merged final')); assert.equal(calls, 2);

  ctx = context(false); calls=0;
  ctx.LLMClient.complete = async () => { calls++; return 'memory fallback'; };
  await analyze(ctx, source, { resumeKey:'memory' }); await analyze(ctx, source, { resumeKey:'memory' }); assert.equal(calls,4);
  assert.equal((await ctx.LLMClient.getResumeInfo('memory')).persistent,false);

  ctx = context();
  ctx.TaskCheckpointCache.maxEntries = 2;
  for (let i=0;i<4;i++) await ctx.TaskCheckpointCache.put('bounded-'+i, {resumeKey:'bounded-'+i, kind:'highlight',groups:[[i]],completed:1,total:2,apiKey:'secret',config:{llmApiKey:'secret'}});
  assert.equal(ctx.TaskCheckpointCache.entries.size,2);
  assert(![...disk.values()].join('').includes('"apiKey"'));
  assert.equal((await ctx.TaskCheckpointCache.resumeInfo('bounded-3')).completed,1);

  ctx = context(); calls=0;
  const fetchController = new AbortController();
  ctx.fetch = (_url, options) => { calls++; assert(options.signal); return new Promise(() => {}); };
  const pending = ctx.LLMClient.complete([{role:'user',content:'test'}], config, {signal:fetchController.signal});
  fetchController.abort(); await assert.rejects(pending,abort); assert.equal(calls,1);
  await assert.rejects(() => ctx.LLMClient.complete([],config,{signal:fetchController.signal}),abort); assert.equal(calls,1);

  ctx = context(); calls=0;
  const fallbackController = new AbortController();
  ctx.fetch = async () => { calls++; fallbackController.abort(); return {ok:false,status:400}; };
  await assert.rejects(() => ctx.LLMClient.complete([],config,{stream:true,signal:fallbackController.signal}),abort); assert.equal(calls,1);

  ctx = context();
  const streamController = new AbortController();
  let readerStarted, cancelled=0,released=0;
  const started = new Promise(resolve => { readerStarted=resolve; });
  ctx.fetch = async () => ({ok:true,headers:{get:()=> 'text/event-stream'},body:{getReader:()=>({read(){readerStarted();return new Promise(()=>{});},cancel(){cancelled++;},releaseLock(){released++;}})}});
  const streaming = ctx.LLMClient.complete([],config,{stream:true,signal:streamController.signal});
  await started; streamController.abort(); await assert.rejects(streaming,abort); assert.equal(cancelled,1); assert.equal(released,1);
  let passedSignal;
  ctx.LLMClient.complete=async (_messages,_cfg,opts)=>{passedSignal=opts.signal;return 'chat';};
  await ctx.LLMClient.chatWithPdf('text',[],config,()=>{},{signal:streamController.signal}); assert.equal(passedSignal,streamController.signal);

  for (const mode of ['agent','precise']) {
    ctx=context(); calls=0;
    const mineruController=new AbortController();
    ctx.fetch=async (_url,options)=>{
      calls++; assert.equal(options.signal,mineruController.signal);
      return {ok:true,json:async()=>({code:0,data:mode==='agent'?{task_id:'task',file_url:'https://upload.test'}:{batch_id:'batch',file_urls:['https://upload.test']}})};
    };
    await assert.rejects(() => ctx.MinerUClient.parsePdf('paper.pdf',new Uint8Array([1]),{mode,token:'test-token',signal:mineruController.signal},message=>{
      if (message.includes('上传完成')||message.includes('已上传')) setTimeout(()=>mineruController.abort(),0);
    }),abort);
    assert.equal(calls,2,'cancel polling sleep before any polling network request');
  }

  ctx=context();
  const zipController=new AbortController(); let removed=0,opened=0;
  ctx.fetch=async (_url,options)=>{assert.equal(options.signal,zipController.signal);return {ok:true,arrayBuffer:async()=>new Uint8Array([1]).buffer};};
  ctx.Zotero.getTempDirectory=()=>({clone:()=>({path:'/tmp/test.zip',append(){}})});
  ctx.Components={classes:{'@mozilla.org/libjar/zip-reader;1':{createInstance:()=>({open(){opened++;},close(){}})}},interfaces:{nsIZipReader:{}}};
  ctx.IOUtils.write=async()=>{zipController.abort();}; ctx.IOUtils.remove=async()=>{removed++;};
  await assert.rejects(()=>ctx.MinerUClient.downloadMarkdownFromZip('https://zip.test',{signal:zipController.signal}),abort);
  assert.equal(removed,1); assert.equal(opened,0);
  console.log('task resume passed: persistent chunks/merges/final, canonical concurrent saves, deleted-note recovery, invalidation, credentials, incomplete exclusion, bounds, cancellation and MinerU cleanup');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>clearTimeout(watchdog));