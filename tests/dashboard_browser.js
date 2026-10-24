const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
let chromium;
try { ({ chromium } = require('playwright')); }
catch (_) { console.log('Skipping dashboard_browser.js: playwright not installed in environment.'); process.exit(0); }

const source = name => fs.readFileSync(path.join(__dirname, '../plugin_src/chrome/content/scripts', name), 'utf8');
const dashboardHTML = '<!doctype html><meta charset="utf-8"><style>body{margin:0}</style>' +
  fs.readFileSync(path.join(__dirname, '../plugin_src/chrome/content/dashboard.xhtml'), 'utf8')
    .replace(/<\?[\s\S]*?\?>/g, '').replace(/<script[^>]*\/>/g, '').replace(/html:/g, '')
    .replace(/\s+xmlns(?::\w+)?="[^"]*"/g, '').replace(/<(\/?)(window|vbox|groupbox)\b/g, '<$1div');

(async () => {
  let browser;
  const launchOptions = { headless: true };
  if (process.env.CHROME_PATH) launchOptions.executablePath = process.env.CHROME_PATH;
  else if (fs.existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe')) launchOptions.executablePath = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
  try { browser = await chromium.launch(launchOptions); }
  catch (error) { console.log('Skipping dashboard_browser.js: browser launch failed (' + error.message + ')'); process.exit(0); }
  try {
    const page = await browser.newPage({ viewport: { width: 880, height: 1100 }, deviceScaleFactor: 1 });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent('<!doctype html><style>body{margin:0}iframe{display:block;width:100%;height:1100px;border:0}</style>');
    await page.evaluate(() => {
      window.prefs = new Map([['extensions.zoteromineru.paperSummaryPrompt', '原有综合自定义提示词']]);
      window.selected = [12]; window.operations = []; window.notes = [];
      window.Zotero = {
        Prefs: { get: key => prefs.get(key), set: (key, value) => prefs.set(key, value) },
        Items: { get: id => [12, 14].includes(id) ? { id, isAttachment: () => true,
          attachmentFilename: id === 12 ? 'Modelling accumulation of high altitude Himalayan glacier.pdf' : 'Newly selected paper.pdf',
          getField: () => `Paper ${id}` } : null }, logError() {}
      };
    });
    for (const name of ['error_utils.js', 'llm_client.js', 'main.js']) await page.addScriptTag({ content: source(name) });
    await page.evaluate(() => {
      const app = Zotero.MinerUAI;
      Object.assign(app, {
        getSelectedItemIDs: () => selected,
        getConfig: () => ({ llmSlot: 1, llmModel: 'test-model', llmThinking: false, llmMaxTokens: 8192 }),
        getProfiles: () => [{ name: '测试模型', model: 'test-model' }],
        getHighlightRules: () => '高亮原文规则',
        renderMarkdown: (node, text) => { node.textContent = text; },
        summarizeItem: (item, type, progress, config, prompt, { signal }) => new Promise((resolve, reject) => {
          operations.push({ itemID: item.id, type, prompt, signal, progress, resolve: markdown => resolve({ markdown, targetItem: item }), reject });
          progress('正在分析全文第 1 / 2 段…');
          signal.addEventListener('abort', () => { const error = Error('paused'); error.name = 'AbortError'; reject(error); }, { once: true });
        }),
        saveSummary: async result => { notes.push(result); return { id: 100 + notes.length }; }
      });
    });
    let sequence = 0;
    const open = async () => {
      const name = 'dashboard-' + (++sequence);
      await page.evaluate(({ name, html }) => {
        const iframe = document.createElement('iframe'); iframe.name = name; iframe.srcdoc = html; document.body.append(iframe);
      }, { name, html: dashboardHTML });
      const frame = await (async () => {
        for (let i = 0; i < 50; i++) {
          const candidate = page.frame({ name });
          if (candidate) { await candidate.waitForLoadState(); return candidate; }
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        throw Error('Dashboard iframe did not load');
      })();
      await frame.evaluate(() => {
        window.Zotero = parent.Zotero; window.modalOpens = 0;
        const show = HTMLDialogElement.prototype.showModal;
        HTMLDialogElement.prototype.showModal = function () { window.modalOpens++; return show.call(this); };
      });
      await frame.addScriptTag({ content: source('dashboard.js') });
      await frame.evaluate(() => window.dispatchEvent(new Event('load')));
      return frame;
    };
    const close = async frame => {
      await frame.evaluate(() => window.dispatchEvent(new Event('unload')));
      await page.evaluate(name => document.querySelector(`iframe[name="${name}"]`).remove(), frame.name());
      assert.equal(await page.evaluate(() => Zotero.MinerUAI.dashboardSubscribers.size), 0);
    };
    const finish = async (index, markdown) => page.evaluate(async ({ index, markdown }) => {
      operations[index].resolve(markdown); await Zotero.MinerUAI.dashboardRun;
    }, { index, markdown });

    let frame = await open();
    assert.equal(await frame.locator('#si-summary-dialog').evaluate(node => node.open), false);
    assert.deepEqual(await frame.locator('#si-prompt-preset option').evaluateAll(options => options.map(option => option.value)), ['general', 'mechanism', 'methods', 'critical']);
    assert.equal(await frame.locator('#si-summary-prompt').inputValue(), '原有综合自定义提示词');
    await frame.locator('#si-prompt-preset').selectOption('mechanism');
    assert.match(await frame.locator('#si-summary-prompt').inputValue(), /机制与证据链/);
    await frame.locator('#si-summary-prompt').fill('机制角度的自定义内容'); await frame.locator('#si-prompt-save').click();
    await frame.locator('#si-prompt-preset').selectOption('methods');
    await frame.locator('#si-summary-prompt').fill('方法角度的未保存草稿');
    await frame.locator('#si-prompt-preset').selectOption('critical');
    assert.match(await frame.locator('#si-summary-prompt').inputValue(), /有效性与偏倚检查/);
    await frame.locator('#si-prompt-preset').selectOption('methods');
    assert.equal(await frame.locator('#si-summary-prompt').inputValue(), '方法角度的未保存草稿');
    await frame.locator('#si-prompt-save').click();
    await frame.locator('#si-prompt-preset').selectOption('mechanism');
    assert.equal(await frame.locator('#si-summary-prompt').inputValue(), '机制角度的自定义内容');
    await frame.locator('#si-prompt-reset').click();
    assert.match(await frame.locator('#si-summary-prompt').inputValue(), /机制与证据链/);
    await frame.locator('#si-prompt-preset').selectOption('methods');
    assert.equal(await frame.locator('#si-summary-prompt').inputValue(), '方法角度的未保存草稿');
    await frame.locator('#si-summary-type').selectOption('table_summary');
    assert.equal(await frame.locator('#si-prompt-preset-box').isVisible(), false);
    await frame.locator('#si-summary-type').selectOption('auto_highlight');
    assert.equal(await frame.locator('#si-prompt-preset-box').isVisible(), false);
    assert.equal(await frame.locator('#si-summary-prompt').getAttribute('readonly'), '');
    await frame.locator('#si-summary-type').selectOption('paper_summary');
    await frame.locator('#si-summary-prompt').fill('本次方法分析的独立提示词');
    await frame.locator('#si-summary').click();
    await page.waitForFunction(() => operations.length === 1);
    assert.equal(await frame.locator('#si-prompt-preset').isDisabled(), true);
    assert.equal(await frame.evaluate(() => modalOpens), 1);
    await frame.locator('#si-summary-dialog-close').click();
    await finish(0, '第一次总结已保存');
    assert.equal(await frame.locator('#si-summary-dialog').evaluate(node => node.open), false);
    assert.equal(await frame.evaluate(() => modalOpens), 1, 'completion must not reopen a dismissed modal');
    assert.match(await frame.locator('#si-job-message').textContent(), /总结已完成/);
    await frame.locator('#si-job-details').click();
    assert.equal(await frame.evaluate(() => modalOpens), 2);
    await frame.locator('#si-summary-dialog-close').click();
    await close(frame);

    await page.evaluate(() => { selected = [14]; Zotero.MinerUAI.saveLastSummaryType('table_summary'); Zotero.MinerUAI.setSummaryPromptPreset('critical'); });
    frame = await open();
    assert.equal(await frame.evaluate(() => modalOpens), 0, 'replaying a completed job must never open a modal');
    assert.equal(await frame.locator('#mineru-selected-item').textContent(), 'Newly selected paper.pdf');
    assert.equal(await frame.locator('#si-summary-type').inputValue(), 'table_summary');
    assert.equal(await frame.locator('#si-prompt-preset').inputValue(), 'critical');
    assert.equal(await frame.locator('#mineru-dashboard-result').textContent(), '第一次总结已保存');
    await frame.locator('#si-summary-type').selectOption('paper_summary');
    assert.match(await frame.locator('#si-summary-prompt').inputValue(), /有效性与偏倚检查/);
    await frame.locator('#si-prompt-preset').selectOption('methods');
    assert.equal(await frame.locator('#si-summary-prompt').inputValue(), '方法角度的未保存草稿', 'saved per-preset prompt must survive a new window');
    await frame.locator('#si-summary-prompt').fill('暂停续跑必须保留的原始提示词');
    await frame.locator('#si-summary').click(); await page.waitForFunction(() => operations.length === 2);
    await frame.locator('#si-summary-dialog-close').click(); await close(frame);
    await page.evaluate(() => {
      selected = [12]; Zotero.MinerUAI.setSummaryPromptPreset('critical');
      Zotero.MinerUAI.saveSummaryPrompt('paper_summary', '稍后使用的另一套方法提示词', 'methods');
      operations[1].progress('关闭窗口后继续分析第 2 段');
    });
    frame = await open();
    assert.equal(await frame.evaluate(() => modalOpens), 0, 'replaying a running job must not block the dashboard');
    assert.equal(await frame.locator('#si-prompt-preset').isDisabled(), true);
    assert.equal(await frame.locator('#si-prompt-preset').inputValue(), 'methods');
    assert.equal(await frame.locator('#mineru-selected-item').textContent(), 'Newly selected paper.pdf');
    assert.equal(await frame.locator('#si-summary-prompt').inputValue(), '暂停续跑必须保留的原始提示词');
    assert.match(await frame.locator('#si-job-message').textContent(), /第 2 段/);
    await frame.locator('#si-batch-stop').click();
    await page.evaluate(() => Zotero.MinerUAI.dashboardRun);
    assert.equal(await frame.evaluate(() => modalOpens), 0);
    await frame.locator('.si-task-history > summary').click();
    await frame.locator('#si-task-history-list button').filter({ hasText: '继续任务' }).first().click();
    await page.waitForFunction(() => operations.length === 3);
    assert.equal(await page.evaluate(() => operations[2].prompt), '暂停续跑必须保留的原始提示词');
    assert.equal(await page.evaluate(() => Zotero.MinerUAI.getSummaryPrompt('paper_summary', 'methods')), '稍后使用的另一套方法提示词');
    await frame.locator('#si-summary-dialog-close').click();
    await finish(2, '续跑后完成的总结'); await close(frame);

    // A fresh completed view preserves the chosen angle, has no dark backdrop,
    // and remains within a typical 880px-wide Zotero dialog.
    await page.evaluate(() => { selected = [12]; Zotero.MinerUAI.setSummaryPromptPreset('critical'); });
    frame = await open();
    assert.equal(await frame.evaluate(() => modalOpens), 0);
    assert.equal(await frame.locator('#si-prompt-preset').inputValue(), 'critical');
    assert.equal(await frame.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    const screenshot = process.env.SI_DASHBOARD_SCREENSHOT || path.join(os.tmpdir(), 'si-dashboard-presets.png');
    fs.mkdirSync(path.dirname(screenshot), { recursive: true });
    await page.screenshot({ path: screenshot, fullPage: true });
    await close(frame);
    assert.deepEqual(errors, []);
    console.log('dashboard browser passed: quiet completed/running replay, selection preservation, explicit details, independent presets/drafts/reset, persisted editor settings, busy controls and exact resume prompt');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
