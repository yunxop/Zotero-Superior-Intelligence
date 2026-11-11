const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const base = path.join(__dirname, '../plugin_src/chrome/content');
const read = file => fs.readFileSync(path.join(base, file), 'utf8');

async function verifyLayout(html, rowCount) {
  let chromium;
  try { ({ chromium } = require('playwright')); }
  catch (_) { console.log('Skipping paper annotation browser checks: Playwright not installed.'); return; }
  const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || (fs.existsSync(chrome) ? chrome : undefined)
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
    const external = [];
    page.on('request', request => { if (/^https?:/.test(request.url())) external.push(request.url()); });
    await page.setContent(html);
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.locator('.row').count(), rowCount);
    assert.equal(await page.locator('.legend li').count(), 5);
    assert.equal(await page.locator('.argument-steps li').count(), 5);
    const reference = page.locator('.source-section');
    assert.equal(await reference.evaluate(node => node.open), false);
    await reference.locator('summary').click();
    assert.equal(await reference.locator('.source-excerpt').isVisible(), true);
    assert.equal(await page.locator('.translation mark').count(), 0);
    assert.equal(await page.locator('.translation').first().evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(240, 236, 226)');
    assert.ok(await page.locator('.row').first().evaluate(row => {
      const [text, note] = row.children;
      return text.getBoundingClientRect().right < note.getBoundingClientRect().left;
    }));
    assert.deepEqual(await page.evaluate(() => Array.from(document.fonts, font => font.status)), ['loaded', 'loaded']);
    await page.locator('a[href="#argument"]').click();
    assert.equal(await page.evaluate(() => location.hash), '#argument');
    assert.ok((await page.locator('nav').boundingBox()).y < 1);
    await page.setViewportSize({ width: 375, height: 700 });
    assert.ok(await page.locator('.row').first().evaluate(row => {
      const [text, note] = row.children;
      return text.getBoundingClientRect().bottom < note.getBoundingClientRect().top;
    }));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth === window.innerWidth));
    assert.deepEqual(external, []);
  } finally { await browser.close(); }
}

(async () => {
  const overview = Object.fromEntries(['question', 'thesis', 'evidence', 'rebuttal', 'conclusion', 'claim', 'strength', 'weakness']
    .map(key => [key, '说明论证中的数据、适用范围与证据缺口。']));
  let requests = 0;
  const prompt = '重点分析因果推断、样本选择和结论的适用边界。';
  const complete = async (messages, _config, options) => {
    requests++;
    assert.equal(options.signal, signal);
    assert.ok(messages[0].content.endsWith(prompt), 'apply the editable prompt to each analysis and overview request');
    const input = JSON.parse(messages[1].content);
    if (!input.passages) return JSON.stringify(messages[0].content.includes('"notes"') ? { notes: overview.claim } : overview);
    assert.ok(input.passages.every(entry => !/Retain this citation|T = ax/.test(entry.text)));
    return JSON.stringify({ paragraphs: input.passages.map(entry => ({
      id: entry.id,
      translation: '论文检验了一个核心主张。<img src="https://example.com/test">',
      function: '提供实证依据',
      role: '支持前面的解释',
      observation: '需明确样本的代表性',
      highlights: [
        { quote: '64 paired reports', category: 'evidence' },
        { quote: 'paired reports', category: 'concept' },
        { quote: 'made up finding', category: 'thesis' },
        { quote: 'We', category: '__proto__' }
      ]
    })).reverse() });
  };
  const signal = new AbortController().signal;
  const pdf = { id: 7, libraryID: 2, getField: () => 'Paper <&>' };
  const parent = { id: 4, isRegularItem: () => true, getField: () => 'Paper <&>' };
  const text = 'We examined 64 paired reports to evaluate the claim in Fig. 1.';
  const long = Array(400).fill('The limitation applies.').join(' ');
  let hasText = true, ocrCalls = 0, saved = null;
  const context = vm.createContext({
    LLMClient: { complete, throwIfAborted() {} },
    AutoHighlight: { rectOK: rect => rect?.length === 4, readPDF: async () => [{ chars: hasText ? [
      { c: 'Abstract', paragraphBreakAfter: true }, { c: text, paragraphBreakAfter: true },
      { c: '1. Introduction', paragraphBreakAfter: true }, { c: long, paragraphBreakAfter: true },
      { c: 'T = ax + by', paragraphBreakAfter: true }, { c: '(5)', paragraphBreakAfter: true },
      { c: 'References', paragraphBreakAfter: true }, { c: 'Retain this citation verbatim.' }
    ] : [] }] },
    ZoteroAdapter: {
      getPdfAttachment: async () => ({ attachmentItem: pdf, parentItem: parent, filePath: 'paper.pdf' }),
      readFileBinary: async () => new Uint8Array([1]),
      saveHTMLAttachment: async (html, title, item, libraryID, receivedSignal) => {
        assert.equal(item, parent);
        assert.equal(libraryID, 2);
        assert.equal(receivedSignal, signal);
        saved = { html, title };
        return { id: 50 };
      }
    },
    MinerUClient: { parsePdf: async () => {
      ocrCalls++;
      return { markdown: '# Abstract\n' + text + '\n\n## Study design\nThe study compares samples.' };
    } },
    Zotero: {
      Libraries: { get: () => ({ filesEditable: true }) },
      File: { getResourceAsync: async url => read(url.replace('chrome://zoteromineru/content/', '')) }
    }
  });
  vm.runInContext(read('scripts/paper_annotation.js'), context);
  const core = context.SIPaperAnnotation;
  const geometry = core.textFromLines(core.pageLines({ chars: [
    { c: 'A wrapped line', rect: [40, 680, 56, 692], lineBreakAfter: true },
    { c: 'ends here.', rect: [40, 665, 56, 677], lineBreakAfter: true },
    { c: 'This line starts a new paragraph.', rect: [40, 636, 56, 648] }
  ] }));
  assert.equal(core.sections(geometry)[0].paragraphs.length, 2);
  const line = (c, y) => ({ c, rect: [40, y, 56, y + 12], paragraphBreakAfter: true });
  const page = (number, text) => ({
    label: String(number),
    viewBox: [0, 0, 600, 800],
    chars: [line('Journal of Audit Studies 31 (2026)', 766), ...text, line(String(number), 14)]
  });
  const cleaned = core.cleanPDF([
    page(1, [line('1. Introduction', 720), line('The analysis establishes', 680)]),
    page(2, [line('a more precise estimate.', 720), line('2', 480), line('Rates were 64 reports per period.', 442)])
  ]);
  assert.ok(!cleaned.includes('Journal of Audit Studies'));
  assert.ok(!cleaned.includes('\n\n1'));
  assert.ok(cleaned.includes('establishes\na more precise'));
  assert.ok(cleaned.includes('\n2\n'), 'body numbers must survive margin cleanup');
  assert.equal(core.spans(text, ['64', '1', 'Fig. 1', '64 paired reports'].map(quote => ({ quote, category: 'evidence' }))).length, 1);
  const result = await core.create(pdf, prompt, {}, () => {}, signal);
  assert.equal(result.attachmentID, 50);
  assert.equal(ocrCalls, 0);
  assert.ok(requests > 2);
  assert.equal(saved.title, '双栏批注 · Paper <&>');
  assert.ok(saved.html.includes('<title>Paper &lt;&amp;&gt;</title>'));
  assert.ok(!saved.html.includes(prompt));
  assert.ok(saved.html.includes('>64 paired reports</mark>'));
  assert.equal(saved.html.match(/<mark /g).length, 1);
  assert.ok(saved.html.includes(long), 'long paragraphs must be reconstructed without truncation');
  assert.ok(saved.html.includes('T = ax + by\n(5)'));
  assert.match(saved.html, /<details class="source-section">.*Retain this citation verbatim\./s);
  assert.ok(saved.html.includes('&lt;img src='));
  assert.ok(!saved.html.includes('<img src='));
  assert.equal(saved.html.match(/class="row"/g).length, 2);
  await verifyLayout(saved.html, 2);
  hasText = false;
  await core.create(pdf, prompt, {}, () => {}, signal);
  assert.equal(ocrCalls, 1);
  assert.ok(saved.html.includes('>Study design</h2>'));
  context.LLMClient.complete = async () => '{"paragraphs":[]}';
  saved = null;
  await assert.rejects(core.create(pdf, prompt, {}, () => {}, signal), /漏掉了段落/);
  assert.equal(saved, null);
  console.log('paper annotation passed: original text and validated highlights, paired rows, embedded fonts, responsive layout, OCR and incomplete response protection');
})().catch(error => { console.error(error); process.exitCode = 1; });
