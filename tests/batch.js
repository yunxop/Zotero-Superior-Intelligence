const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const context = vm.createContext({ Zotero: { logError() {}, Items: { get: id => ({ id, getField: () => `Paper ${id}` }) } } });
vm.runInContext(fs.readFileSync('plugin_src/chrome/content/scripts/batch.js', 'utf8'), context);
const batch = context.SIBatch;
async function run(type, stopEarly = false) {
  const processed = [], saved = [], tasks = [], events = [];
  let stopped = false, inFlight = false;
  const config = { llmSlot: 2, llmModel: 'original' };
  context.ZoteroAdapter = { getPdfAttachment: async item => item.id === 5 ? null : ({ filePath: 'paper.pdf', attachmentItem: { id: item.id === 4 ? 10 : item.id * 10 } }) };
  const work = async (item, report, cfg) => {
    assert.equal(inFlight, false); inFlight = true;
    assert.equal(cfg.llmModel, 'original');
    report('processing');
    await Promise.resolve();
    inFlight = false; processed.push(item.id);
    if (item.id === 20) throw new Error('provider failed');
  };
  const app = {
    saveSummaryPrompt() { throw new Error('Background batches must not overwrite saved prompts'); }, describeError: e => e.message,
    startSummaryTask(task) { tasks.push({ ...task }); return tasks.length - 1; },
    updateSummaryTask(id, change) { Object.assign(tasks[id], change); },
    async summarizeItem(item, receivedType, report, cfg, prompt) { assert.equal(receivedType, type); assert.equal(prompt, 'prompt'); await work(item, report, cfg); return { markdown: 'result', itemID: item.id }; },
    async saveSummary(result) { saved.push(result.itemID); return { id: 100 + result.itemID }; },
    async highlightItem(item, report, cfg) { try { await work(item, report, cfg); return JSON.stringify({ ok: true, result: { count: 2, percent: '6.0', highlights: [] } }); } catch (e) { return JSON.stringify({ ok: false, error: e.message }); } }
  };
  const totals = JSON.parse(await batch.run(app, [1, 2, 3, 4, 5, 1], type, config, 'prompt', json => {
    const event = JSON.parse(json); events.push(event);
    config.llmModel = 'changed during execution';
    if (event.kind === 'progress' && event.message === 'processing' && stopEarly) stopped = true;
  }, () => stopped));
  assert.equal(batch.running, false);
  assert.equal(totals.total, 5);
  if (stopEarly) {
    assert.deepEqual(processed, [10]);
    assert.equal(totals.completed, 1); assert.equal(totals.stopped, 4);
    assert.equal(events.filter(e => e.status === 'stopped').length, 4);
  } else {
    assert.deepEqual(processed, [10, 20, 30]);
    assert.equal(totals.completed, 2); assert.equal(totals.failed, 2); assert.equal(totals.skipped, 1);
    assert.equal(tasks.filter(t => t.status === 'completed').length, 2);
    assert.equal(tasks.filter(t => t.status === 'failed').length, 2);
    if (type !== 'auto_highlight') assert.deepEqual(saved, [10, 30]);
  }
}
(async () => {
  for (const type of ['paper_summary', 'table_summary', 'auto_highlight']) { await run(type); await run(type, true); }
  await assert.rejects(() => batch.run({}, [], 'paper_summary', {}, ''), /至少勾选/);
  batch.running = true;
  await assert.rejects(() => batch.run({}, [1], 'paper_summary', {}, ''), /已有批处理/);
  batch.running = false;
  await assert.rejects(() => batch.run({}, [1], 'paper_summary', {}, ''), /提示词不能为空/);
  assert.equal(batch.running, false);
  console.log('batch queue tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
