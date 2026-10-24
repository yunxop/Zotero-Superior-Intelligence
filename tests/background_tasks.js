const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = file => fs.readFileSync('plugin_src/chrome/content/scripts/' + file, 'utf8');
const until = async condition => {
  for (let i = 0; i < 100 && !condition(); i++) await Promise.resolve();
  assert.ok(condition(), 'expected asynchronous operation to start');
};

function fixture() {
  const prefs = new Map(), notes = [], operations = [], highlights = [], tags = [];
  let selection = [12];
  const items = new Map([12, 13, 14].map(id => [id, { id, isAttachment: () => true, attachmentFilename: `paper-${id}.pdf`, getField: () => `Paper ${id}` }]));
  const Zotero = { Prefs: { get: key => prefs.get(key), set: (key, value) => prefs.set(key, value) }, Items: { get: id => items.get(id) }, logError() {}, debug() {}, getMainWindows: () => [] };
  const config = { llmSlot: 1, llmThinking: false, llmMaxTokens: 8192, llmApiKey: 'test-secret', mineruToken: 'mineru-secret', autoGenerateNote: true, autoTag: true };
  const context = vm.createContext({ AbortController, Zotero, setTimeout, clearTimeout,
    Services: { wm: { getMostRecentWindow: () => null } }, ReaderChat: { unregister() {} } });
  for (const file of ['error_utils.js', 'batch.js', 'main.js']) vm.runInContext(source(file), context);
  const app = context.ZoteroMinerUAI;
  const hold = (kind, item, progress, capturedConfig, signal) => new Promise((resolve, reject) => {
    app.checkTaskSignal(signal);
    operations.push({ kind, item, progress, config: capturedConfig, signal, resolve, reject });
    signal.addEventListener('abort', () => { const error = Error('paused'); error.name = 'AbortError'; reject(error); }, { once: true });
    progress('模型处理中');
  });
  Object.assign(app, {
    getSelectedItemIDs: () => selection, getConfig: () => config,
    getSummaryPrompt: () => 'prompt', getHighlightRules: () => 'rules',
    summarizeItem: async (item, type, progress, capturedConfig, prompt, { signal }) => {
      const markdown = await hold(type, item, progress, capturedConfig, signal);
      return { markdown, targetItem: item, promptType: type };
    },
    highlightItem: async (item, progress, capturedConfig, { signal }) => {
      await hold('highlight', item, progress, capturedConfig, signal);
      app.checkTaskSignal(signal); highlights.push(item.id);
      return JSON.stringify({ ok: true, result: { count: 1, percent: 5, highlights: [{ category: '结论', pageLabel: '1', text: 'Important finding.', color: '#ffd400' }] } });
    },
    saveSummary: async (result, { signal }) => { app.checkTaskSignal(signal); notes.push(result); return { id: 100 + notes.length }; },
    renderMarkdown: (node, markdown) => { node.textContent = markdown; }
  });
  context.ZoteroAdapter = {
    getPdfAttachment: async item => ({ attachmentItem: item, parentItem: item, fileName: item.attachmentFilename, filePath: item.attachmentFilename }),
    readFileBinary: async () => new Uint8Array([1]),
    createProgressNotifier: () => ({ update() {}, done() {}, fail() {} }),
    createChildNote: async (item, title, markdown) => { notes.push({ targetItem: item, markdown }); },
    addTagsToItem: async item => tags.push(item.id)
  };
  context.MinerUClient = { parsePdf: async (name, bytes, options, progress) => {
    const markdown = await hold('extract', { name }, progress, options, options.signal);
    return { markdown };
  } };
  const start = (ids = [12], type = 'paper_summary', kind = 'summary') => JSON.parse(app.startDashboardJob(JSON.stringify({ ids, type, kind, config, prompt: 'prompt' })));
  return { app, context, Zotero, config, notes, operations, highlights, tags, start, select(ids) { selection = ids; } };
}

function openView(f) {
  const nodes = new Map(), listeners = new Map();
  const node = () => ({ value: '', textContent: '', children: [], listeners: {}, dataset: {}, style: {}, open: false,
    append(...children) { this.children.push(...children); }, replaceChildren() { this.children = []; this.textContent = ''; },
    addEventListener(name, callback) { this.listeners[name] = callback; }, setAttribute() {}, showModal() { this.open = true; }, close() { this.open = false; } });
  const window = { closed: false, addEventListener(name, callback) { listeners.set(name, callback); } };
  const document = { getElementById(id) {
    assert.equal(window.closed, false, 'background work must never access a closed document');
    if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id);
  }, createElementNS: node };
  vm.runInNewContext(source('dashboard.js'), { window, document, Zotero: f.Zotero });
  listeners.get('load')();
  return { nodes, click(id) { return nodes.get(id).listeners.click(); },
    close() { window.closed = true; listeners.get('unload')(); },
    type(value) { nodes.get('si-summary-type').value = value; nodes.get('si-summary-type').listeners.change(); } };
}

(async () => {
  // Close before execution's first microtask: the plugin still creates history,
  // completes generation, and saves exactly one note with no attached view.
  const f = fixture();
  let view = openView(f);
  view.click('si-summary'); view.close();
  assert.equal(f.app.dashboardSubscribers.size, 0);
  await until(() => f.operations.length === 1);
  assert.equal(f.operations[0].signal.aborted, false);
  assert.throws(() => f.start([13]), /后台运行/);
  f.config.llmApiKey = 'changed';
  assert.equal(f.operations[0].config.llmApiKey, 'test-secret', 'execution must use the launch snapshot');
  f.operations[0].resolve('Saved after closing'); await f.app.dashboardRun;
  assert.equal(f.notes.length, 1); assert.equal(f.notes[0].targetItem.id, 12);
  assert.equal(f.app.getSummaryTasks().items[0].status, 'completed');
  assert.equal(f.app.taskControllers.size, 0);
  view = openView(f);
  assert.equal(view.nodes.get('mineru-dashboard-result').textContent, 'Saved after closing');
  assert.equal(view.nodes.get('si-summary').disabled, false);
  assert.equal(f.notes.length, 1, 'reopening must not rerun or resave');

  // Close a running table summary; reopen with a different library selection.
  // The view must restore the active IDs and expose a working pause button.
  view.type('table_summary'); view.click('si-summary');
  await until(() => f.operations.length === 2);
  view.close(); f.select([14]);
  f.operations[1].progress('后台分析第 2 段');
  view = openView(f);
  assert.equal(view.nodes.get('mineru-selected-item').textContent, 'paper-12.pdf');
  assert.equal(view.nodes.get('si-summary-type').value, 'table_summary');
  assert.equal(view.nodes.get('si-summary-progress').textContent, '后台分析第 2 段');
  assert.equal(view.nodes.get('si-summary').disabled, true);
  view.click('si-dialog-pause'); await f.app.dashboardRun;
  assert.equal(f.operations[1].signal.aborted, true);
  assert.equal(JSON.parse(f.app.getDashboardJob()).status, 'paused');
  assert.equal(f.app.getSummaryTasks().items[0].status, 'interrupted');
  assert.equal(f.notes.length, 1); view.close();

  // Real SIBatch orchestration must advance to the next item with no window.
  f.start([12, 13]);
  let seen = 0;
  const unsubscribe = f.app.subscribeDashboardJob(() => seen++);
  await until(() => f.operations.length === 3); unsubscribe();
  const before = seen;
  f.operations[2].resolve('Batch first');
  await until(() => f.operations.length === 4);
  assert.equal(f.operations[3].item.id, 13);
  f.operations[3].resolve('Batch second'); await f.app.dashboardRun;
  assert.equal(seen, before); assert.equal(f.notes.length, 3);
  assert.equal(f.app.getBatchQueue().pendingIDs.length, 0);
  assert.equal(f.app.getSummaryTasks().totals.completed, 3);
  view = openView(f);
  assert.equal(view.nodes.get('mineru-dashboard-result').children.length, 2); view.close();

  // A completed batch preview is reused while later documents stream; the
  // results area must not repeatedly parse all earlier Markdown answers.
  const paint = fixture(); let markdownPaints = 0;
  paint.app.renderMarkdown = (node, markdown) => { markdownPaints++; node.textContent = markdown; };
  paint.select([12, 13]); const batchView = openView(paint); batchView.click('si-summary');
  await until(() => paint.operations.length === 1);
  paint.operations[0].resolve('First preview');
  await until(() => paint.operations.length === 2);
  const firstPreview = batchView.nodes.get('mineru-dashboard-result').children[0];
  for (let i = 0; i < 100; i++) paint.operations[1].progress(`Second document ${i}`);
  assert.equal(markdownPaints, 1);
  paint.operations[1].resolve('Second preview'); await paint.app.dashboardRun;
  assert.equal(markdownPaints, 2);
  assert.equal(batchView.nodes.get('mineru-dashboard-result').children[0], firstPreview);
  batchView.close();

  // Highlighter and real extraction entry point also complete without a view.
  f.start([13], 'auto_highlight');
  await until(() => f.operations.length === 5);
  f.operations[4].resolve(); await f.app.dashboardRun;
  assert.deepEqual(f.highlights, [13]);
  f.start([14], 'paper_summary', 'extract');
  await until(() => f.operations.length === 6);
  f.operations[5].resolve('Extracted in background'); await f.app.dashboardRun;
  assert.equal(f.notes.at(-1).markdown, 'Extracted in background'); assert.deepEqual(f.tags, [14]);
  assert.equal(JSON.parse(f.app.getDashboardJob()).status, 'completed');

  // A failed/dead subscriber cannot affect saving. Snapshots contain no keys.
  f.app.subscribeDashboardJob(() => { throw Error('dead compartment'); });
  assert.equal(f.app.dashboardSubscribers.size, 0);
  f.start(); await until(() => f.operations.length === 7);
  assert.doesNotMatch(f.app.getDashboardJob(), /test-secret|changed|mineru-secret|llmApiKey/);
  f.operations[6].reject(Error('model failed')); await f.app.dashboardRun;
  assert.equal(JSON.parse(f.app.getDashboardJob()).status, 'failed');
  assert.equal(f.app.taskControllers.size, 0);

  // Plugin shutdown remains a real cancellation boundary.
  f.start(); await until(() => f.operations.length === 8);
  const unsubscribeLast = f.app.subscribeDashboardJob(() => {});
  await f.app.destroy(); await f.app.dashboardRun;
  assert.equal(f.operations[7].signal.aborted, true);
  assert.equal(f.app.dashboardSubscribers.size, 0); unsubscribeLast();
  assert.equal(f.app.getSummaryTasks().items[0].status, 'interrupted');
  assert.throws(() => f.start(), /关闭/);

  // A configuration error before extraction/model work must settle the job,
  // release its controller, and allow retry instead of leaving it running.
  const broken = fixture();
  broken.app.getConfig = () => { throw Error('configuration unavailable'); };
  broken.app.startDashboardJob(JSON.stringify({ kind: 'summary', ids: [12], type: 'paper_summary', prompt: 'prompt' }));
  await broken.app.dashboardRun;
  assert.equal(JSON.parse(broken.app.getDashboardJob()).status, 'failed');
  assert.equal(broken.app.taskControllers.size, 0);
  console.log('background tasks passed: close before launch, save once, reopen progress/pause, batch continuation, highlight, extraction, subscriber isolation, errors and shutdown');
})().catch(error => { console.error(error); process.exitCode = 1; });
