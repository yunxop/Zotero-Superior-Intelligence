const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

async function run(fail = false, highlight = false, batch = false, incomplete = false) {
  const nodes = new Map();
  function node() {
    return { value: '', children: [], listeners: {}, open: false,
      append(...children) { this.children.push(...children); },
      replaceChildren() { this.children = []; }, dataset: {}, style: {},
      addEventListener(name, fn) { this.listeners[name] = fn; }, setAttribute() {},
      showModal() { this.open = true; }, close() { this.open = false; }
    };
  }
  const doc = { getElementById(id) { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); }, createElementNS: node };
  let load, release, located, tracked, saved, lastUpdate;
  const app = {
    describeError: error => error?.message || error?.name || String(error || "底层组件未提供错误详情"),
    getSummaryTasks: () => ({ totals: { created: 1, completed: 1, failed: 0, interrupted: 0 }, items: [{ title: 'Paper', status: 'completed', itemID: 3, durationMs: 65000, createdAt: new Date().toISOString() }] }),
    getHighlightRules: () => '高亮规则',
    highlightItem: async (_item, progress) => { progress('正在核对原文'); await new Promise(resolve => { release = resolve; }); if (fail) return JSON.stringify({ ok: false, error: '失败阶段：正在核对原文\n原因：底层组件未提供错误详情' }); return JSON.stringify({ ok: true, result: { count: 1, percent: '8.0', highlights: [{ text: 'Original sentence.', category: '结论', pageLabel: '1', color: '#ffd400' }] } }); },
    getSummaryPrompt: () => '提示词', getSelectedItem: () => ({ id: 3, getField: () => 'Paper' }),
    getSelectedItemIDs: () => batch ? [3, 4] : [3],
    runBatch: async (ids, type, config, prompt, emit, stop) => {
      assert.deepEqual(Array.from(ids), [3, 4]);
      emit(JSON.stringify({ kind: 'progress', itemID: 3, index: 1, total: 2, title: 'Paper', message: '正在批处理' }));
      await new Promise(resolve => { release = resolve; });
      const stopped = stop();
      emit(JSON.stringify({ kind: 'item', itemID: 3, title: 'Paper', status: 'completed', message: '完成', result: { markdown: 'Summary' } }));
      emit(JSON.stringify({ kind: 'item', itemID: 4, title: 'Other', status: stopped ? 'stopped' : 'failed', message: stopped ? '未执行' : '失败' }));
      return JSON.stringify({ completed: 1, failed: stopped ? 0 : 1, skipped: 0, stopped: stopped ? 1 : 0 });
    },
    getConfig: () => ({ llmSlot: 1 }), getProfiles: () => [{ name: 'Model' }], activeProfile: () => 1,
    saveSummaryPrompt() {}, startSummaryTask(task) { tracked = task; return 'task'; }, updateSummaryTask(_id, change) { lastUpdate=change; },
    summarizeItem: async (_item, _type, progress) => { progress('正在分析全文第 1 / 2 段…'); await new Promise(resolve => { release = resolve; }); if (fail) throw new Error('测试失败'); return { markdown: '总结', incomplete }; },
    renderMarkdown() {}, saveSummary: async result => { saved=result;return { id: 9 }; }, locateSummaryTask: async (task) => { located = task.itemID; }
  };
  vm.runInNewContext(fs.readFileSync('plugin_src/chrome/content/scripts/dashboard.js', 'utf8'), {
    window: { addEventListener(name, fn) { if (name === 'load') load = fn; } }, document: doc, Zotero: { MinerUAI: app, Items: { get: id => id ? ({ id, getField: () => 'Paper' }) : null }, logError() {} }
  });
  load();
  if (highlight) {
    nodes.get('si-summary-type').value = 'auto_highlight';
    nodes.get('si-summary-type').listeners.change();
    assert.equal(nodes.get('si-summary-prompt').readOnly, true);
    assert.equal(nodes.get('si-highlight-legend').hidden, false);
    assert.equal(nodes.get('si-summary').textContent, '为所选文献添加高亮');
  }
  const row = nodes.get('si-task-history-list').children[0];
  assert.match(row.children[1].textContent, /1 分 5 秒/);
  await row.children[0].listeners.click();
  assert.equal(located, 3);
  if (batch) {
    nodes.get('si-selection-none').listeners.click();
    assert.equal(nodes.get('si-summary').disabled, true);
    nodes.get('si-selection-all').listeners.click();
    assert.match(nodes.get('si-summary').textContent, /2 篇/);
    const pending = nodes.get('si-summary').listeners.click();
    assert.equal(nodes.get('si-selection-refresh').disabled, true);
    assert.equal(nodes.get('si-batch-stop').hidden, false);
    if (fail) nodes.get('si-batch-stop').listeners.click();
    release(); await pending;
    assert.equal(nodes.get('si-summary-dialog-title').textContent, fail ? '批处理已停止' : '批处理已结束');
    assert.equal(nodes.get('mineru-dashboard-result').children.length, 2);
    assert.equal(nodes.get('si-batch-stop').hidden, true);
    assert.equal(nodes.get('si-selection-refresh').disabled, false);
    assert.equal(nodes.get('si-summary').disabled, false);
    return;
  }
  const pending = nodes.get('si-summary').listeners.click();
  assert.equal(nodes.get('si-summary-dialog').open, true);
  assert.match(nodes.get('si-summary-dialog-hint').textContent, /任务会继续运行/);
  assert.equal(nodes.get('si-summary').disabled, true);
  assert.equal(tracked.itemID, 3);
  assert.match(nodes.get('si-summary-progress').textContent, highlight ? /正在核对原文/ : /第 1 \/ 2 段/);
  nodes.get('si-summary-dialog-close').listeners.click();
  assert.equal(nodes.get('si-summary-dialog').open, false);
  release(); await pending;
  assert.equal(nodes.get('si-summary-dialog').open, true);
  assert.equal(nodes.get('si-summary').disabled, false);
  assert.equal(nodes.get('si-summary-dialog-title').textContent, incomplete ? '未完成 · 部分结果已保存' : (highlight ? '文献高亮' : '总结') + (fail ? '失败' : '已完成'));
  if(incomplete) { assert.equal(saved.incomplete,true);assert.equal(lastUpdate.status,'interrupted');assert.equal(lastUpdate.noteID,9); }
  assert.match(nodes.get('si-summary-dialog-hint').textContent, fail ? /任务已停止/ : /任务已结束/);
  assert.doesNotMatch(nodes.get('si-summary-dialog-hint').textContent, /继续运行/);
  if (highlight && fail) assert.match(nodes.get('si-summary-progress').textContent, /失败阶段：正在核对原文\n原因：底层组件未提供错误详情/);
  if (highlight && !fail) assert.match(nodes.get('mineru-dashboard-result').children[0].textContent, /已添加 1 条高亮/);
}
(async () => { await run(); await run(true); await run(false, true); await run(true, true); await run(false, false, true); await run(true, false, true); await run(false,false,false,true); console.log('dashboard interaction tests passed'); })().catch(error => { console.error(error); process.exitCode = 1; });
