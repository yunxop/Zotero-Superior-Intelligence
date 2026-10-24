const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'si-writing-'));
  const prefs = new Map();
  class DB {
    constructor() { this.connection = new DatabaseSync(path.join(dir, 'si-writing.sqlite')); this.chain = Promise.resolve(); }
    async queryAsync(sql, args = []) {
      const statement = this.connection.prepare(sql);
      return /^SELECT/.test(sql) ? statement.all(...args) : statement.run(...args);
    }
    executeTransaction(callback) {
      this.chain = this.chain.catch(() => {}).then(async () => {
        this.connection.exec('BEGIN');
        try { await callback(); this.connection.exec('COMMIT'); } catch(e) { this.connection.exec('ROLLBACK'); throw e; }
      }); return this.chain;
    }
    async closeDatabase() { this.connection.close(); }
  }
  const context = vm.createContext({ console, setTimeout, clearTimeout, AbortController,
    PathUtils: path, IOUtils: { makeDirectory: p => fs.promises.mkdir(p, {recursive:true}), writeUTF8: (p,v) => fs.promises.writeFile(p,v) },
    Zotero: { DBConnection: DB, DataDirectory: { dir }, Prefs: { get: k => prefs.get(k), set: (k,v) => prefs.set(k,v) },
      MinerUAI: { getConfig: () => ({llmModel:'test-model'}) }, Items: { get: id => ({id}) }, Libraries: { get: () => ({libraryType:'user'}) } }
  });
  for (const name of ['task_checkpoints','writing_core','writing_store','writing_topics','writing_service']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../plugin_src/chrome/content/scripts/'+name+'.js'),'utf8'),context);
  const core = context.SIWritingCore, store = context.SIWritingStore, service = context.SIWriting;
  const meta = { libraryID:1,itemID:2,attachmentID:3,attachmentKey:'PDFKEY', title:'Heat paper',doi:'10.123/test',uri:'zotero://open-pdf/library/items/PDFKEY' };
  const chars = text => text.split('\n').map(c => ({c, paragraphBreakAfter:true}));
  const quote = 'Urban trees reduced temperature by 2 degrees in summer.';
  const pages = [{label:'iv',chars:chars('Introduction\nUrban heat is increasing.\nResults\n'+quote)}, {chars:chars('Discussion\nThe study was limited to one city.')}];
  const chunks = core.paragraphs(pages,meta);
  assert.equal(chunks.length,3); assert.equal(chunks[1].section,'Results'); assert.equal(chunks[2].page,2); assert.equal(chunks[1].pageLabel,'iv');
  assert.equal(core.cosine([1,0],[1,0]),1); assert.equal(core.cosine([1],[1,2]),0);
  const ranked = core.rank(chunks,'trees',null,'model'); assert.equal(ranked[0].text,quote);
  const candidate = {chunkID:ranked[0].id,kind:'evidence',quote,section:'Results',valueScore:90,explanation:'降温证据',quantitativeResult:'夏季降低 2 度'};
  const records = core.validate(JSON.stringify({records:[candidate,{...candidate,quote:'This quotation was invented by a model.'},{...candidate,chunkID:'fake'},{...candidate,valueScore:101},candidate]}),ranked,'trees','model');
  assert.equal(records.length,1); assert.equal(records[0].source.page,1); assert.equal(records[0].status,'pending');
  assert.equal(core.export(records,'training'),''); assert.throws(() => core.validate('invalid',ranked,'trees','m'));
  await store.saveChunks('1:PDFKEY',chunks); assert.equal((await store.chunks('1:PDFKEY')).length,3);
  await store.add(records); await store.add(records); assert.equal((await store.records()).length,1);
  await store.review(records[0].id,'approved','verified',{...records[0].details, explanation:'已核验'});
  await store.add(records); assert.equal((await store.records())[0].status,'approved');
  assert.match(fs.readFileSync(path.join(dir,'si-writing','knowledge.md'),'utf8'),/已核验/);
  const training = JSON.parse(core.export(await store.records(),'training')); assert.equal(training.messages.length,3);
  await assert.rejects(store.review(records[0].id,'invalid',''),/无效/);
  await store.close(); assert.equal((await store.records()).length,1); // persistence across connections
  assert.equal((await service.search({query:'降温'})).total,0);
  assert.equal((await service.search({query:'已核验',status:'approved'})).total,1);
  service.configure('test-key','voyage-4-lite');
  const requests = [];
  context.fetch = async (url, options) => {
    requests.push(JSON.parse(options.body));
    return {ok:true,json:async () => ({data: JSON.parse(options.body).input.map((_,i) => ({index:i,embedding:[1,0]})).reverse()})};
  };
  assert.equal((await service.embed(['a','b'],'document',service.config())).length,2);
  assert.equal(requests[0].input_type,'document'); assert.equal(requests[0].truncation,false);
  context.fetch = async () => ({ok:true,json:async () => ({data:[{index:0,embedding:[1,0]},{index:0,embedding:[1,0]}]})});
  await assert.rejects(service.embed(['a','b'],'query',service.config()),/无效/);
  const abort = new AbortController(); abort.abort(); await assert.rejects(service.embed(['a'],'query',service.config(),abort.signal),/停止/);
  context.ZoteroAdapter = {getPdfAttachment: async item => item.id === 999 ? null : ({filePath:'paper.pdf',attachmentItem:{id:3,libraryID:1,key:'PDFKEY'},parentItem:{id:2,getField:k => k === 'title' ? 'Heat paper' : '',getCreators:()=>[]}})};
  context.AutoHighlight = {readPDF:async () => pages};
  context.LLMClient = {complete:async messages => {
    const input = JSON.parse(messages[1].content), c = input.paragraphs.find(p => p.text === quote);
    return JSON.stringify({records:c ? [{...candidate,chunkID:c.chunkID}] : []});
  }};
  await service.start({topic:'trees',itemIDs:[999,2],semantic:false,notes:false}); await service.job.promise;
  assert.equal(service.snapshot().running,false); assert.equal(service.snapshot().failures.length,1);
  assert.equal((await store.records()).length,1); // rerun does not duplicate or erase review
  const batchTopic=(await service.topics()).find(t=>t.name==='trees');
  const firstHistory=await service.batchHistory(batchTopic.id);
  assert.equal(firstHistory.batches[0].status,'partial');
  assert.equal(firstHistory.batches[0].instruction,'trees');
  assert.equal(firstHistory.batches[0].completed,1);
  assert.ok(!JSON.stringify(firstHistory).includes('test-key'));
  const exported = await service.export('jsonl',{status:'approved'}); const data = JSON.parse(fs.readFileSync(exported,'utf8'));
  assert.equal(data.schemaVersion,1); assert.equal(data.status,'approved'); assert.ok(data.source.text); assert.ok(!fs.readFileSync(exported,'utf8').includes('test-key'));
  // Note reruns update the same note and escape model-provided markup.
  const notes = new Map(); let nextNote = 100;
  context.Zotero.Item = class {
    constructor() { this.id = nextNote++; }
    isNote() { return true; }
    setNote(html) { this.html = html; }
    async saveTx() { notes.set(this.id,this); }
  };
  context.Zotero.Items.get = id => notes.get(id) || {id};
  const parent = {id:2,libraryID:1,isRegularItem:()=>true};
  const noteRecords = await store.records(); noteRecords[0].details.explanation = '<script>unsafe</script>';
  const firstNote = await service.saveNote(parent,noteRecords,'paper-topic');
  assert.equal(await service.saveNote(parent,noteRecords,'paper-topic'),firstNote);
  assert.equal(notes.size,1); assert.ok(!notes.get(firstNote).html.includes('<script>'));
  assert.match(notes.get(firstNote).html,/&lt;script&gt;/);
  // Semantic run caches document vectors; a second run only embeds the query.
  requests.length = 0;
  context.fetch = async (url, options) => {
    const body = JSON.parse(options.body); requests.push(body);
    return {ok:true,json:async()=>({data:body.input.map((_,index)=>({index,embedding:[1,0]}))})};
  };
  await service.start({topic:'trees',itemIDs:[2],semantic:true,notes:false}); await service.job.promise;
  assert.ok(requests.some(r=>r.input_type==='document'));
  requests.length = 0;
  await service.start({topic:'trees',itemIDs:[2],semantic:true,notes:false}); await service.job.promise;
  assert.equal(requests.filter(r=>r.input_type==='document').length,0);
  const semantic = await service.search({query:'cooling',semantic:true}); assert.equal(semantic.total,1);
  let entered;
  const active = new Promise(resolve=>{entered=resolve;});
  context.LLMClient.complete = async (messages,config,{signal}) => {
    entered(); return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true}));
  };
  await service.start({topic:'trees',itemIDs:[2],semantic:false,notes:false}); await active;
  await assert.rejects(service.topicSave({id:batchTopic.id,name:'busy'}),/正在运行/);
  service.stop(); await service.job.promise;
  assert.equal((await service.batchHistory(batchTopic.id)).batches[0].status,'cancelled');
  assert.match(service.snapshot().message,/停止/); assert.equal(service.snapshot().running,false);
  await store.add([{...records[0], topic:'second topic'}]);
  assert.equal((await service.topics()).length,2);
  assert.equal((await service.search({topic:'second topic'})).total,1);
  assert.equal((await service.search({topic:'unknown'})).total,0);
  assert.equal((await store.records())[0].status,'approved');
  const scopedExport = await service.export('jsonl',{topic:'second topic'});
  assert.ok(JSON.parse(fs.readFileSync(scopedExport,'utf8')).topics.includes('second topic'));
  await assert.rejects(service.export('jsonl',{topic:'unknown'}),/没有/);
  const topicNote = await service.saveNote(parent,noteRecords,'paper-second','second <topic>');
  assert.match(notes.get(topicNote).html,/<h2>科研写作知识库 · second &lt;topic&gt;<\/h2>/);
  assert.notEqual(topicNote,firstNote);
  await service.remove([records[0].id]);
  assert.equal((await service.search()).total,0); assert.equal((await service.topics()).filter(t=>t.count>0).length,0);
  assert.ok(!fs.readFileSync(path.join(dir,'si-writing','knowledge.md'),'utf8').includes(quote));
  await assert.rejects(service.export('training'),/没有/);
  await store.add(records); assert.equal((await store.records()).length,0); // rerun does not resurrect deleted records
  await store.close(); assert.equal((await store.records()).length,0); // deletion survives reopening
  await service.restore([records[0].id]); assert.equal((await service.search({topic:'second topic'})).total,1);
  assert.equal((await store.records())[0].status,'approved');
  // Recursive scopes include grandchildren, deduplicate memberships and isolate libraries.
  const scopeItems = new Map([1,2,3,4,5].map(id => [id,{id,libraryID:id===5 ? 2 : 1,deleted:id===4,isRegularItem:()=>true}]));
  const collections = new Map([
    [10,{id:10,name:'Parent',libraryID:1,getDescendents:()=>[{id:11},{id:12},{id:13}],getChildItems:()=>[1]}],
    [11,{id:11,libraryID:1,getChildItems:()=>[1,2,3,4]}],
    [12,{id:12,libraryID:1,getChildItems:()=>[2]}],
    [13,{id:13,libraryID:2,getChildItems:()=>[5]}]
  ]);
  context.Zotero.getActiveZoteroPane = () => ({getSelectedCollection:()=>collections.get(10),getSelectedLibraryID:()=>1});
  context.Zotero.Collections = {get:id=>collections.get(id)};
  context.Zotero.Items.get = id => scopeItems.get(id);
  context.Zotero.Items.getAll = async () => [...scopeItems.values()];
  context.Zotero.Libraries.get = id => ({name:'Library '+id});
  context.ZoteroAdapter.getSelectedItems = () => [scopeItems.get(2)];
  context.ZoteroAdapter.getPdfAttachment = async item => item.id===3 ? null : ({filePath:'local.pdf',attachmentItem:{id:item.id+100,libraryID:item.libraryID}});
  const recursive = await service.collectScope('collection');
  assert.deepEqual(Array.from(recursive.itemIDs),[101,102]); assert.equal(recursive.collectionCount,3); assert.equal(recursive.skipped,1);
  assert.deepEqual(Array.from((await service.collectScope('library')).itemIDs),[101,102]);
  assert.deepEqual(Array.from((await service.collectScope('selected')).itemIDs),[102]);
  context.Zotero.getActiveZoteroPane = () => ({});
  await assert.rejects(service.collectScope('collection'),/父分类/);
  await assert.rejects(service.collectScope('library'),/文献库/);
  await service.destroy();
  console.log('Writing knowledge: provenance, SQLite persistence, dedup/review, retrieval, Voyage validation, batch isolation and exports passed.');
})().catch(error => {console.error(error);process.exitCode=1;});
