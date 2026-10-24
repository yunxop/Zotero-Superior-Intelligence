const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const source = name => fs.readFileSync('plugin_src/chrome/content/scripts/' + name, 'utf8');
(async () => {
  let now = 1000, nextTimer = 1, writes = 0;
  const timers = new Map(), prefs = new Map();
  const clock = {
    Date: class extends Date { static now() { return now; } },
    setTimeout(fn, delay) { const id = nextTimer++; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); }
  };
  const tick = ms => {
    now += ms;
    for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); }
  };
  const parent = { id: 3, libraryID: 1, isAttachment: () => false, getField: () => 'Paper', get attachmentFilename() { throw Error('Only attachments have filenames'); } };
  const pdf = { id: 12, parentID: 3, parentItemID: 3, libraryID: 1, isAttachment: () => true, attachmentFilename: 'supplement.pdf', getField: () => 'Attachment title' };
  const Zotero = { Prefs: { get: key => prefs.get(key), set: (key, value) => { writes++; prefs.set(key, value); } }, Items: { get: id => id === 12 ? pdf : parent }, logError() {} };
  const ctx = vm.createContext({ ...clock, AbortController, Zotero, console });
  vm.runInContext(source('main.js'), ctx);
  const app = ctx.ZoteroMinerUAI;
  const values = [], updater = app.createUIUpdater(value => values.push(value));
  for (let i = 0; i < 1000; i++) updater.push(i);
  assert.deepEqual(values, [0], 'a burst must paint only its first value immediately');
  tick(199); assert.deepEqual(values, [0]);
  tick(1); assert.deepEqual(values, [0, 999]);
  updater.push('last'); updater.flush(); assert.equal(values.at(-1), 'last');
  updater.push('stale'); updater.cancel(); tick(500);
  assert.equal(values.at(-1), 'last'); assert.equal(timers.size, 0);

  const tasks = Array.from({ length: 100 }, (_, i) => ({ id: 'old-' + i, title: 'Paper ' + i, status: 'completed', promptType: 'paper_summary', profileSlot: 1, itemID: 3, durationMs: 1000, createdAt: '2026-10-24T00:00:00.000Z', stage: 'Saved' }));
  app.persistSummaryTasks({ items: tasks, totals: { created: 100, completed: 100, failed: 0, interrupted: 0 } });
  app.getSelectedItemIDs = () => [12];
  app.getSummaryPrompt = () => 'prompt'; app.saveSummaryPrompt = () => {};
  let emit, release, savedResult;
  ctx.SummaryTextCache = { get: async () => ({ text: 'paper text', cached: false }) };
  ctx.ZoteroAdapter = { getPdfAttachment: async () => ({ attachmentItem: pdf, parentItem: parent, filePath: 'paper.pdf', fileName: 'supplement.pdf' }) };
  ctx.LLMClient = { analyzePaper: async (_text, _type, _config, stream) => { emit = stream; return new Promise(resolve => { release = resolve; }); } };
  app.saveSummary = async result => { savedResult = result; return { id: 30 }; };
  app.renderMarkdown = (node, markdown) => { node.textContent = markdown; };
  const nodes = new Map(), handlers = new Map();
  const node = () => ({ value: '', children: [], listeners: {}, dataset: {}, style: {}, open: false, replacements: 0,
    append(...children) { this.children.push(...children); }, replaceChildren() { this.replacements++; this.children = []; },
    addEventListener(name, callback) { this.listeners[name] = callback; }, setAttribute() {}, showModal() { this.open = true; }, close() { this.open = false; } });
  const doc = { getElementById(id) { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); }, createElementNS: node };
  const win = { closed: false, addEventListener(name, callback) { handlers.set(name, callback); } };
  vm.runInNewContext(source('dashboard.js'), { ...clock, window: win, document: doc, Zotero });
  handlers.get('load')();
  assert.equal(nodes.get('mineru-selected-item').textContent, 'supplement.pdf');
  win.siLoadSelection([3]); assert.equal(nodes.get('mineru-selected-item').textContent, 'Paper');
  win.siLoadSelection([12]);
  nodes.get('si-summary').listeners.click();
  for (let i = 0; !emit && i < 30; i++) await Promise.resolve();
  assert.ok(emit);
  const history = nodes.get('si-task-history-list'), active = nodes.get('si-task-active-list');
  const historyRows = [...history.children], activeRow = active.children[0], beforeReplace = history.replacements, beforeWrites = writes;
  for (let i = 1; i <= 1000; i++) emit('x', 'x'.repeat(i));
  tick(200);
  assert.ok(writes - beforeWrites <= 2, '1,000 deltas should cause at most two progress preference writes');
  assert.equal(history.replacements, beforeReplace, 'unchanged history must not be rebuilt during streaming');
  assert.equal(active.children[0], activeRow, 'active task row must be reused');
  assert.ok(history.children.every((row, i) => row === historyRows[i]));
  assert.match(nodes.get('si-summary-progress').textContent, /1000/);
  const running = app.getSummaryTasks().items[0];
  assert.equal(running.itemID, 12, 'resuming must retain the exact attachment');
  release('FINAL answer'); await app.dashboardRun;
  assert.equal(savedResult.markdown, 'FINAL answer'); assert.equal(savedResult.targetItem.id, 3);
  assert.equal(app.getSummaryTasks().items[0].status, 'completed');
  assert.equal(nodes.get('mineru-dashboard-result').textContent, 'FINAL answer');
  assert.equal(timers.size, 0, 'completion must remove trailing stream work');

  // Exercise the real extraction entry point: its dashboard ID must cancel the
  // network operation and prevent late notes when explicitly paused. Closing
  // the window only detaches its view; parsing and saving continue.
  let parsingSignal, finishParsing, noteWrites = 0;
  ctx.SIError = { describe: error => error.message };
  ctx.ZoteroAdapter.readFileBinary = async () => new Uint8Array([1]);
  ctx.ZoteroAdapter.createProgressNotifier = () => ({ update() {}, done() {}, fail() {} });
  ctx.ZoteroAdapter.createChildNote = async () => { noteWrites++; };
  ctx.ZoteroAdapter.addTagsToItem = async () => {};
  ctx.MinerUClient = { parsePdf: async (_file, _bytes, options) => {
    parsingSignal = options.signal;
    return new Promise((resolve, reject) => { finishParsing = resolve; options.signal.addEventListener('abort', () => { const error = Error('cancel'); error.name = 'AbortError'; reject(error); }, { once: true }); });
  } };
  nodes.get('mineru-dashboard-extract').listeners.click();
  for (let i = 0; !parsingSignal && i < 30; i++) await Promise.resolve();
  assert.ok(parsingSignal); assert.equal(nodes.get('mineru-dashboard-extract').disabled, true);
  nodes.get('si-batch-stop').listeners.click(); await app.dashboardRun;
  assert.equal(parsingSignal.aborted, true); assert.equal(noteWrites, 0); assert.equal(app.taskControllers.size, 0);
  assert.equal(nodes.get('mineru-dashboard-extract').disabled, false);
  assert.match(nodes.get('mineru-dashboard-status').textContent, /取消/);
  parsingSignal = null;
  nodes.get('mineru-dashboard-extract').listeners.click();
  for (let i = 0; !parsingSignal && i < 30; i++) await Promise.resolve();
  win.closed = true; handlers.get('unload')();
  assert.equal(parsingSignal.aborted, false); assert.equal(app.dashboardSubscribers.size, 0);
  finishParsing({ markdown: 'Extracted after close' }); await app.dashboardRun;
  assert.equal(app.taskControllers.size, 0); assert.equal(noteWrites, 1);
  assert.equal(JSON.parse(app.getDashboardJob()).status, 'completed');
  console.log('UI performance passed: 1,000 stream deltas -> 2 progress writes, stable task rows, final flush, exact attachment resume, cancellable extraction and saving after window close');
})().catch(error => { console.error(error); process.exitCode = 1; });
