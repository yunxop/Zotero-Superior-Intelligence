const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const prefs = new Map();
const load = () => {
 const ctx = vm.createContext({ AbortController, Zotero: { Prefs: { get: key => prefs.get(key), set: (key,value) => prefs.set(key,value) } } });
 vm.runInContext(fs.readFileSync('plugin_src/chrome/content/scripts/main.js','utf8'),ctx);
 return ctx.ZoteroMinerUAI;
};
let app = load();
assert.equal(app.getTaskSettings('paper_summary').thinking,false);
assert.equal(app.getTaskSettings('table_summary').maxTokens,16384);
app.saveTaskSettings('paper_summary',{thinking:true,maxTokens:32768});
app.saveTaskSettings('table_summary',{maxTokens:4096});
app.saveTaskSettings('library',{maxTokens:16384});
app = load();
assert.equal(app.getTaskSettings('reader').thinking,true,'thinking must persist and be shared between interfaces');
assert.equal(app.getTaskSettings('paper_summary').maxTokens,32768);
assert.equal(app.getTaskSettings('table_summary').maxTokens,4096);
assert.equal(app.getTaskSettings('library').maxTokens,16384);
assert.equal(app.getTaskSettings('reader').maxTokens,8192);
assert.throws(()=>app.saveTaskSettings('library',{maxTokens:0}),/Token/);
assert.throws(()=>app.saveTaskSettings('__proto__',{maxTokens:8192}),/类型/);
function dashboard() {
 const nodes = new Map(); let onLoad;
 const node = () => ({value:'',children:[],listeners:{},attributes:{},dataset:{},style:{},
  append(...items){this.children.push(...items);},replaceChildren(){this.children=[];},
  addEventListener(name,fn){this.listeners[name]=fn;},setAttribute(name,value){this.attributes[name]=value;},showModal(){},close(){}});
 const doc = {getElementById(id){if(!nodes.has(id))nodes.set(id,node());return nodes.get(id);},createElementNS:node};
 const facade = Object.create(app);
 Object.assign(facade,{getSummaryTasks:()=>({totals:{created:0,completed:0,failed:0,interrupted:0},items:[]}),getSelectedItemIDs:()=>[],getSummaryPrompt:()=> 'prompt',getHighlightRules:()=> 'rules',getProfiles:()=>[{name:'Test',model:'model'}],getConfig:()=>({llmSlot:1}),getBatchQueue:()=>null});
 vm.runInNewContext(fs.readFileSync('plugin_src/chrome/content/scripts/dashboard.js','utf8'),{window:{addEventListener(name,fn){if(name==='load')onLoad=fn;}},document:doc,Zotero:{MinerUAI:facade,Items:{get:()=>null}}});
 onLoad();return nodes;
}
let nodes=dashboard();
assert.equal(nodes.get('si-thinking').attributes['aria-pressed'],'true');
assert.equal(nodes.get('si-output-limit').value,'32768');
nodes.get('si-summary-type').value='table_summary';nodes.get('si-summary-type').listeners.change();
assert.equal(nodes.get('si-output-limit').value,'4096');
nodes.get('si-output-limit').value='16384';nodes.get('si-output-limit').listeners.change();
nodes.get('si-thinking').listeners.click();
nodes=dashboard();
assert.equal(nodes.get('si-summary-type').value,'table_summary');
assert.equal(nodes.get('si-output-limit').value,'16384');
assert.equal(nodes.get('si-thinking').attributes['aria-pressed'],'false');
assert.equal(app.getTaskSettings('library').thinking,false);
const signal=app.beginTask('task');app.cancelTask('task');assert.equal(signal.aborted,true);app.finishTask('task');assert.equal(app.taskControllers.size,0);
prefs.set('extensions.zoteromineru.taskSettings','broken JSON');assert.equal(load().getTaskSettings('reader').maxTokens,8192);
(async()=>{
 const closed=[],hooks=[];
 const ctx=vm.createContext({AbortController,Services:{wm:{getMostRecentWindow:type=>({closed:false,close(){closed.push(type);}})}},
  ReaderChat:{unregister(){hooks.push('reader');}},SummaryTextCache:{clear(){hooks.push('text');}},SILibraryChat:{destroy(){hooks.push('library');}},
  Zotero:{Prefs:{get:()=>null,set(){}},getMainWindows:()=>[],debug(){},logError(){}}});
 vm.runInContext(fs.readFileSync('plugin_src/chrome/content/scripts/main.js','utf8'),ctx);
 const app=ctx.ZoteroMinerUAI;const signal=app.beginTask('shutdown');app.initialized=true;
 await app.destroy();
 assert.equal(signal.aborted,true);assert.equal(app.taskControllers.size,0);
 assert.deepEqual(closed,['zoteromineru:library','zoteromineru:dashboard']);assert.equal(ctx.Zotero.MinerUAI,undefined);
 assert.deepEqual(hooks,['text','library','reader']);
 console.log('task settings passed: persistent global thinking, per-task limits, reopen, task type, cancellation and shutdown cleanup');
})().catch(error=>{console.error(error);process.exitCode=1;});
