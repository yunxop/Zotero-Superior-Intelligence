const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { chromium } = require('playwright');
const base = path.join(__dirname, '../plugin_src/chrome/content');
const read = name => fs.readFileSync(path.join(base, name), 'utf8');
const context = vm.createContext({ console, AutoHighlight: { rectOK: rect => rect?.length === 4 },
  LLMClient: { throwIfAborted() {} }, Zotero: { File: { getResourceAsync: async uri => read(uri.replace('chrome://zoteromineru/content/', '')) } } });
for (const file of ['vendor/katex.min.js', 'markdown_renderer.js', 'paper_content.js', 'paper_annotation.js']) vm.runInContext(read('scripts/' + file), context);
const content = context.SIPaperContent, core = context.SIPaperAnnotation;
const overview = Object.fromEntries(Object.keys(core.overviewFields).map(key => [key, '研究以观测数据支持结论，并保留适用条件。']));

(async () => {
  const source = String.raw`# Methods
We measured temperature using $\frac{a}{b}$ and retained scientific units.
The result includes 64 paired reports with uncertainty.

| Measure | Formula | Value |
| :--- | ---: | --- |
| Warming | $\frac{\Delta T}{\Delta t}$ | 0.33 °C |
| Control | $\lvert x|y\rvert$ | 12% | extra cell retained |
| Literal | ${'`'}a|b${'`'} | 2 |

$$
\int_0^1 x^2\,dx = \frac{1}{3}
$$

<table onclick="alert(1)"><caption>Observed data</caption><tr><th rowspan="2">Group</th><th colspan="2">Temperature</th></tr>
<tr><td>Mean</td><td>Units</td></tr><tr><td>Control</td><td>0.33</td><td>°C decade<sup>−1</sup></td></tr>
<tr><td>&lt;img src=x onerror=alert(1)&gt;</td><td>$x^2$</td><td><script>alert(1)</script></td></tr></table>

![Figure 1](https://example.invalid/figure.png)

## Results
The measured tem-
perature increased while evidence-
based estimates retained their conditions. Soft hyphen: micro­
climate.

## References
PRINT_REFERENCE_SENTINEL Smith 2026. This source must survive printing.

| Reference | Year |
| --- | --- |
| Jones | 2025 |
`;
  const sections = core.sections(source, true);
  assert.deepEqual(Array.from(sections[0].blocks), ['text', 'table', 'equation', 'html-table', 'figure']);
  assert.equal(sections[1].paragraphs[0], 'The measured temperature increased while evidence-based estimates retained their conditions. Soft hyphen: microclimate.');
  assert.match(sections[1].rawParagraphs[0], /tem-\nperature/);
  assert.match(sections[1].rawParagraphs[0], /evidence-\nbased/);
  assert.equal(content.joinLines(['A well-', 'known method'], new Set()), 'A well-known method');
  assert.equal(content.joinLines(['The co-', 'efficient'], content.vocabulary('coefficient')), 'The coefficient');
  assert.equal(content.joinLines(['Formula \\(foo-', 'bar\\) remains.'], content.vocabulary('foobar')), 'Formula \\(foo-\nbar\\) remains.', 'line cleanup must not alter TeX');
  assert.equal(content.joinLines(['The 5-', 'year period'], new Set()), 'The 5-year period', 'numeric compound hyphens are retained');

  const line = (c, flags = {}) => ({ c, ...flags });
  const cleaned = core.cleanPDF([
    { label: '1', chars: [line('Methods', { paragraphBreakAfter: true }), line('The tem'), line('-', { ignorable: true, lineBreakAfter: true }), line('perature changed.', { paragraphBreakAfter: true }), line('The micro'), line('-', { ignorable: true, lineBreakAfter: true })] },
    { label: '2', chars: [line('climate was measured.', { paragraphBreakAfter: true })] }
  ], true);
  const parsed = core.sections(cleaned.text, false, cleaned.ranges);
  assert.equal(parsed[0].paragraphs[0], 'The temperature changed.');
  assert.equal(parsed[0].paragraphs[1], 'The microclimate was measured.');
  assert.deepEqual(Array.from(parsed[0].sources[1], p => p.page), [1, 2]);
  assert.ok(parsed[0].rawParagraphs[1].includes('\u00ad'));

  const longFormula = 'Before ' + '$' + 'x + '.repeat(600) + 'y$' + ' after';
  const parts = core.parts(longFormula);
  assert.equal(parts.join(''), longFormula);
  assert.ok(parts.some(part => part.startsWith('$') && part.endsWith('$')), 'request splitting must keep TeX intact');
  const fenced = content.units('# Methods\n```tex\n$$x$$\n# Not a heading\n```\n## Results\nProse.', true);
  assert.equal(fenced[1].type, 'code');
  assert.ok(fenced[1].text.includes('# Not a heading'));
  const malformed = core.sections('# Methods\n$$unclosed\n\n# Results\nReported data.', true);
  assert.equal(malformed.at(-1).title, 'Results');
  assert.equal(core.sections('# Methods\n<table><tr><td>broken\n# Results\nReported data.', true).at(-1).title, 'Results');
  assert.match(content.inline('$\\notACommand{<img src=x>}$'), /si-math-error/);
  assert.doesNotMatch(content.inline('$\\href{javascript:alert(1)}{click}$ $\\includegraphics{https://example.invalid/a.png}$'), /<(a|img|script)\b/);
  const formulaText = 'Before $x^2$ after';
  assert.match(content.inline(formulaText, [{ start: 0, end: formulaText.length, category: 'evidence' }], core.categories), /katex/);
  assert.doesNotMatch(content.inline(formulaText, [{ start: 0, end: formulaText.length, category: 'evidence' }], core.categories), /<mark/);

  const modelInputs = [];
  core.annotate = async entries => {
    modelInputs.push(...entries);
    return entries.map(entry => ({ translation: '观测结果保留公式 $\\frac{a}{b}$ 和不确定性。', function: '介绍测量与论证依据。', role: '承接研究方法和结果。', observation: '结论需要结合数据范围。', spans: core.spans(entry.text, [{ quote: '64 paired reports', category: 'evidence' }]) }));
  };
  core.overview = async () => overview;
  const generated = await core.generate(sections, 'Structured reading preview', () => {}, { config: {}, prompt: '' });
  assert.equal(generated.coverage.structured, 4);
  assert.equal(generated.coverage.ancillary, 2);
  assert.ok(!modelInputs.some(entry => /<table|\| Measure|PRINT_REFERENCE_SENTINEL/.test(entry.text)), 'preserve source-only blocks without asking the model to rewrite their values');
  const assets = await core.assets();
  assert.doesNotMatch(assets.mathCSS, /url\((?!data:)/);
  const fontMatches = [...assets.mathCSS.matchAll(/url\(data:font\/woff2;base64,([A-Za-z0-9+/=]+)\)/g)];
  const fontNames = [...read('styles/katex.css').matchAll(/url\(fonts\/([^)]*)\)/g)].map(match => match[1]);
  assert.equal(fontMatches.length, fontNames.length);
  fontMatches.forEach((match, i) => assert.deepEqual(Buffer.from(match[1], 'base64'), fs.readFileSync(path.join(base, 'styles/fonts', fontNames[i]))));
  const html = core.render({ title: '结构化阅读样例 · 表格与公式', ...generated, generatedAt: '测试样例，译文与批注为模拟内容', modelName: 'Mock' }, assets);
  assert.doesNotMatch(html, /<script\b|<img\b|onclick=|onerror="/);
  assert.match(html, /class="katex/);
  const output = path.join(__dirname, '../scratch');
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'paper-content-preview.html'), html);
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || (fs.existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe') ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined) });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
    const requests = [], errors = [];
    page.on('request', request => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent(html);
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.locator('.source-table table').count(), 4, 'screen and print have separate reference table copies');
    assert.equal(await page.locator('.source-table').first().locator('tbody tr').count(), 3);
    assert.equal(await page.locator('.source-table').first().locator('thead th').count(), 4, 'extra data columns are retained');
    assert.match(await page.locator('.source-table').first().textContent(), /extra cell retained/);
    assert.match(await page.locator('.source-table').first().textContent(), /a\|b/);
    assert.equal(await page.locator('.source-table').first().locator('code').textContent(), 'a|b');
    assert.equal(await page.locator('th[rowspan="2"]').count(), 1);
    assert.equal(await page.locator('td sup').textContent(), '−1');
    assert.ok(await page.locator('.katex').count() >= 5);
    assert.equal(await page.locator('.si-math-error').count(), 0);
    assert.ok(await page.evaluate(() => [...document.fonts].filter(font => font.family.startsWith('KaTeX') && font.status === 'loaded').length > 0));
    assert.equal(await page.locator('.source-section').evaluate(node => node.open), false);
    assert.equal(await page.locator('.print-source').isVisible(), false);
    assert.equal(await page.locator('.source-section .source-excerpt').isVisible(), false);
    await page.locator('.source-table').first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, 'paper-content-desktop.png') });
    await page.setViewportSize({ width: 375, height: 812 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.equal(await page.locator('.source-table').first().evaluate(node => node.scrollWidth > node.clientWidth), true, 'wide tables scroll within their own region');
    await page.locator('.source-table').first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, 'paper-content-mobile.png') });
    await page.emulateMedia({ media: 'print' });
    assert.equal(await page.locator('.source-section').isVisible(), false);
    assert.equal(await page.locator('.print-source .source-excerpt').isVisible(), true);
    assert.equal(await page.locator('.print-source table').isVisible(), true);
    assert.equal(await page.locator('.row').first().evaluate(node => getComputedStyle(node).breakInside), 'auto');
    // Verify real print output can be inspected independently of screen visibility.
    await page.pdf({ path: path.join(output, 'paper-content-print.pdf'), format: 'A4', printBackground: true });
    const longTable = '| Print row | Value |\n| --- | --- |\n' + Array.from({ length: 80 }, (_, i) => `| PRINT_ROW_${String(i).padStart(3, '0')} | ${i} |`).join('\n');
    const printHTML = core.render({ title: 'Long table print regression', overview,
      sections: [{ title: 'References', paragraphs: [[{ text: longTable, block: 'table', reason: '附属内容' }]] }] }, assets);
    await page.setContent(printHTML);
    await page.evaluate(() => document.fonts.ready);
    await page.pdf({ path: path.join(output, 'paper-content-long-table.pdf'), format: 'A4', printBackground: true });
    assert.deepEqual(requests, []);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
  console.log('paper content passed: Markdown/HTML tables, safe offline math/fonts, preserved source blocks, conservative dehyphenation, provenance, mobile layout and complete print content');
})().catch(error => { console.error(error); process.exitCode = 1; });
