const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = file => fs.readFileSync('plugin_src/chrome/content/scripts/' + file, 'utf8');
const prefix = 'extensions.zoteromineru.';
const until = async condition => {
  for (let i = 0; i < 100 && !condition(); i++) await Promise.resolve();
  assert.ok(condition(), 'expected the queued operation to start');
};

function load(prefs = new Map(), withLLM = true) {
  const calls = [], saves = [];
  const items = new Map([12, 13].map(id => [id, { id, getField: () => 'Paper ' + id, isAttachment: () => true, attachmentFilename: `paper-${id}.pdf` }]));
  const Zotero = {
    Prefs: { get: key => prefs.get(key), set: (key, value) => prefs.set(key, value) },
    Items: { get: id => items.get(id) }, logError() {}
  };
  const context = vm.createContext({ Zotero, AbortController, setTimeout, clearTimeout });
  for (const file of ['error_utils.js', ...(withLLM ? ['llm_client.js'] : []), 'batch.js', 'main.js']) {
    vm.runInContext(source(file), context);
  }
  const app = context.ZoteroMinerUAI;
  const originalSave = app.saveSummary.bind(app);
  const config = { llmSlot: 1, llmThinking: false, llmMaxTokens: 8192 };
  app.getConfig = () => config;
  app.summarizeItem = (item, type, report, capturedConfig, prompt, { signal }) => new Promise((resolve, reject) => {
    calls.push({ itemID: item.id, type, prompt, signal, resolve: () => resolve({ markdown: 'Summary', targetItem: item, title: 'Paper ' + item.id, promptType: type }), reject });
    signal.addEventListener('abort', () => { const error = Error('paused'); error.name = 'AbortError'; reject(error); }, { once: true });
    report('正在分析');
  });
  app.saveSummary = async (result, { signal }) => { app.checkTaskSignal(signal); saves.push(result); return { id: 100 + saves.length }; };
  context.ZoteroAdapter = { getPdfAttachment: async item => ({ attachmentItem: item, filePath: item.attachmentFilename }) };
  const start = options => JSON.parse(app.startDashboardJob(JSON.stringify({ kind: 'summary', ids: [12], type: 'paper_summary', config, ...options })));
  return { app, context, prefs, calls, saves, start, originalSave };
}

(async () => {
  const legacy = '原有通用总结，自定义内容必须保留。';
  const prefs = new Map([[prefix + 'paperSummaryPrompt', legacy], [prefix + 'tableSummaryPrompt', 'Original table prompt']]);
  let fixture = load(prefs), app = fixture.app;
  const metadata = JSON.parse(JSON.stringify(app.getSummaryPromptPresets()));
  assert.deepEqual(metadata.map(preset => preset.id), ['general', 'mechanism', 'methods', 'critical']);
  assert.ok(metadata.every(preset => preset.label && preset.description && !('prompt' in preset)));
  assert.equal(app.getSummaryPromptPreset(), 'general');
  assert.equal(app.getSummaryPrompt('paper_summary'), legacy, 'existing custom prompt must remain the general preset');
  assert.equal(app.getSummaryPrompt('table_summary'), 'Original table prompt');
  const defaults = Object.fromEntries(metadata.map(({ id }) => [id, app.getSummaryPrompt('paper_summary', id)]));
  assert.equal(new Set(Object.values(defaults)).size, 4, 'each preset must offer a different angle');

  // Each editor stores independently. Reset affects only its own preset.
  for (const { id } of metadata) {
    app.setSummaryPromptPreset(id);
    app.saveSummaryPrompt('paper_summary', '  Custom ' + id + '  ');
    assert.equal(app.getSummaryPrompt('paper_summary'), 'Custom ' + id);
  }
  assert.equal(app.getSummaryPrompt('table_summary'), 'Original table prompt');
  app.setSummaryPromptPreset('methods');
  fixture = load(prefs); app = fixture.app;
  assert.equal(app.getSummaryPromptPreset(), 'methods', 'selected angle must survive a new runtime');
  for (const { id } of metadata) assert.equal(app.getSummaryPrompt('paper_summary', id), 'Custom ' + id);
  assert.equal(app.resetSummaryPrompt('paper_summary'), defaults.methods);
  assert.equal(app.getSummaryPrompt('paper_summary', 'general'), 'Custom general');
  assert.equal(app.getSummaryPrompt('paper_summary', 'mechanism'), 'Custom mechanism');
  assert.equal(app.getSummaryPrompt('paper_summary', 'critical'), 'Custom critical');
  app.saveSummaryPrompt('table_summary', 'Updated table prompt');
  assert.equal(app.getSummaryPrompt('paper_summary'), defaults.methods);
  assert.equal(app.resetSummaryPrompt('table_summary'), fixture.context.LLMClient.PROMPT_TEMPLATES.table_summary);
  assert.equal(app.getSummaryPromptPreset(), 'methods');
  assert.equal(app.resetSummaryPrompt('paper_summary', 'general'), fixture.context.LLMClient.PROMPT_TEMPLATES.paper_summary);
  assert.equal(app.getSummaryPromptPreset(), 'methods', 'resetting an explicit preset must not change selection');

  // Reject arbitrary preference paths and malformed types without writing.
  const beforeInvalid = [...prefs];
  for (const bad of ['__proto__', 'constructor', '../general', '', null, 12]) {
    assert.throws(() => app.setSummaryPromptPreset(bad), /总结角度/);
    assert.throws(() => app.getSummaryPrompt('paper_summary', bad), /总结角度/);
    assert.throws(() => app.saveSummaryPrompt('paper_summary', 'bad', bad), /总结角度/);
    assert.throws(() => app.resetSummaryPrompt('paper_summary', bad), /总结角度/);
  }
  assert.throws(() => app.saveSummaryPrompt('paper_summary', ' \n '), /不能为空/);
  assert.throws(() => app.getSummaryPrompt('auto_highlight'), /类型/);
  assert.throws(() => app.saveSummaryPrompt('__proto__', 'bad'), /类型/);
  assert.deepEqual([...prefs], beforeInvalid);
  prefs.set(prefix + 'paperSummaryPreset', '__proto__');
  assert.equal(load(prefs).app.getSummaryPromptPreset(), 'general');
  assert.equal(load(new Map(), false).app.getSummaryPromptPreset(), 'general', 'main-only fixtures remain usable');

  // Capture default prompt/preset before the background microtask runs. Changing
  // the editor or selected angle afterward must not change the executing task.
  fixture = load(); app = fixture.app;
  app.setSummaryPromptPreset('mechanism');
  app.saveSummaryPrompt('paper_summary', 'Mechanism captured at launch');
  const launched = fixture.start();
  assert.equal(launched.promptPreset, 'mechanism');
  app.saveSummaryPrompt('paper_summary', 'Mechanism edited after launch', 'mechanism');
  app.setSummaryPromptPreset('critical');
  app.saveSummaryPrompt('paper_summary', 'Critical editor content');
  await until(() => fixture.calls.length === 1);
  assert.equal(fixture.calls[0].prompt, 'Mechanism captured at launch');
  let history = app.getSummaryTasks().items[0];
  assert.equal(history.prompt, 'Mechanism captured at launch');
  assert.equal(history.promptPreset, 'mechanism');
  app.cancelDashboardJob(launched.id); await app.dashboardRun;
  assert.equal(app.getSummaryTasks().items[0].status, 'interrupted');
  assert.equal(fixture.saves.length, 0);
  assert.equal(app.getSummaryPrompt('paper_summary', 'mechanism'), 'Mechanism edited after launch');
  assert.equal(app.getSummaryPrompt('paper_summary'), 'Critical editor content');

  // Resume the stored prompt verbatim even if its preset has since been edited.
  fixture.start({ prompt: history.prompt, promptPreset: history.promptPreset });
  await until(() => fixture.calls.length === 2);
  assert.equal(fixture.calls[1].prompt, 'Mechanism captured at launch');
  fixture.calls[1].resolve(); await app.dashboardRun;
  assert.equal(fixture.saves.length, 1);
  assert.equal(app.getSummaryPromptPreset(), 'critical');
  assert.equal(app.getSummaryPrompt('paper_summary'), 'Critical editor content');
  assert.equal(app.getSummaryPrompt('paper_summary', 'mechanism'), 'Mechanism edited after launch');

  // The real batch adapter persists and forwards the chosen preset and exact
  // prompt to every task without saving it over the unrelated current editor.
  fixture.start({ ids: [12, 13], prompt: 'Batch original methods prompt', promptPreset: 'methods' });
  await until(() => fixture.calls.length === 3);
  assert.equal(app.getBatchQueue().promptPreset, 'methods');
  assert.equal(app.getBatchQueue().prompt, 'Batch original methods prompt');
  assert.equal(fixture.calls[2].prompt, 'Batch original methods prompt');
  fixture.calls[2].resolve();
  await until(() => fixture.calls.length === 4);
  assert.equal(fixture.calls[3].prompt, 'Batch original methods prompt');
  fixture.calls[3].resolve(); await app.dashboardRun;
  assert.ok(app.getSummaryTasks().items.slice(0, 2).every(task => task.promptPreset === 'methods' && task.prompt === 'Batch original methods prompt'));
  assert.equal(app.getSummaryPrompt('paper_summary'), 'Critical editor content');
  assert.equal(app.getSummaryPrompt('paper_summary', 'methods'), fixture.context.LLMClient.PAPER_SUMMARY_PRESETS.find(p => p.id === 'methods').prompt);
  assert.equal(app.taskControllers.size, 0);
  assert.throws(() => fixture.start({ promptPreset: '__proto__' }), /总结角度/);
  assert.throws(() => fixture.start({ prompt: '  ' }), /不能为空/);
  assert.equal(app.taskControllers.size, 0);
  // Note titles use the captured angle, never the editor's later selection.
  const naming = load(), written = [];
  naming.app.saveSummary = naming.originalSave;
  naming.context.ZoteroAdapter.createChildNote = async (item, title, body) => {
    written.push({ title, body }); return { id: 900 + written.length };
  };
  for (const preset of metadata) {
    await naming.app.saveSummary({ targetItem: { id: 12 }, title: 'Paper', promptType: 'paper_summary', markdown: 'Answer', promptPreset: preset.id });
    assert.equal(written.at(-1).title, `文献总结 · ${preset.label} · Paper`);
    assert.ok(written.at(-1).body.includes(`**总结角度：** ${preset.label}`));
  }
  await naming.app.saveSummary({ targetItem: { id: 12 }, title: 'Paper', promptType: 'table_summary', markdown: 'Answer', incomplete: true });
  assert.equal(written.at(-1).title, '未完成 · 表格总结 · Paper');
  naming.start({ promptPreset: 'methods', prompt: 'Original methods instructions' });
  naming.app.setSummaryPromptPreset('critical');
  await until(() => naming.calls.length === 1);
  naming.calls[0].resolve(); await naming.app.dashboardRun;
  assert.equal(written.at(-1).title, '文献总结 · 方法与复现 · Paper 12');
  naming.start({ ids: [12, 13], promptPreset: 'mechanism', prompt: 'Original mechanism instructions' });
  await until(() => naming.calls.length === 2);
  naming.calls[1].resolve();
  await until(() => naming.calls.length === 3);
  naming.calls[2].resolve(); await naming.app.dashboardRun;
  assert.ok(written.slice(-2).every(note => note.title.startsWith('文献总结 · 研究问题与机制 · ')));
  console.log('summary presets passed: independent prompts, frozen launch/resume/batch, and matching note titles');
})().catch(error => { console.error(error); process.exitCode = 1; });
