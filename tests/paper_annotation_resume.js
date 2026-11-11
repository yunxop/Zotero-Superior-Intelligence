const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const base = path.join(__dirname, '../plugin_src/chrome/content');
const read = name => fs.readFileSync(path.join(base, name), 'utf8');
const config = { llmApiBase: 'https://example.test/v1', llmApiKey: 'NEVER-SAVE-THIS-KEY', mineruToken: 'NEVER-SAVE-OCR-TOKEN',
  llmModel: 'model-a', llmProvider: 'custom', llmSlot: 1, llmThinking: false, llmMaxTokens: 16384 };
const prompt = 'Analyze the evidence.';
const overview = Object.fromEntries(['question', 'thesis', 'evidence', 'rebuttal', 'conclusion', 'claim', 'strength', 'weakness'].map(key => [key, '有依据的论证说明。']));
const prose = 'We measured temperature at 118 stations and found significant warming. ';
const sections = [{ title: 'Results', paragraphs: Array.from({ length: 18 }, (_, i) => `${i + 1}: ` + prose.repeat(24)) }];
const disk = new Map();
const attachments = new Map();
const pdf = { id: 7, key: 'ABC12345', libraryID: 1, getField: () => 'Test paper' };
const parent = { id: 3, isRegularItem: () => true, getField: () => 'Test paper' };
let nextAttachment = 50;

function fixture() {
  const calls = [], progress = [];
  const ctx = vm.createContext({ console, AbortController, setTimeout, clearTimeout, Zotero: {
    DataDirectory: { dir: '/data' }, logError() {},
    Libraries: { get: () => ({ libraryType: 'user', filesEditable: true }) },
    Groups: { getGroupIDFromLibraryID: () => 87 },
    Items: { get: id => attachments.get(id) },
    File: { getResourceAsync: async uri => read(uri.replace('chrome://zoteromineru/content/', '')) }
  }, PathUtils: { join: (...parts) => parts.join('/') }, IOUtils: {
    async exists(file) { return [...attachments.values()].some(item => file === `saved-${item.id}.html` && !item.missing); },
    async readJSON(file) { if (!disk.has(file)) { const error = Error('missing'); error.name = 'NotFoundError'; throw error; } return JSON.parse(disk.get(file)); },
    async writeJSON(file, value) { disk.set(file, JSON.stringify(value)); }
  }, AutoHighlight: {
    rectOK: rect => rect?.length === 4,
    readPDF: async () => [{ label: 'iv', chars: [{ c: prose, paragraphBreakAfter: true },
      { c: 'References', paragraphBreakAfter: true }, { c: 'Smith 2026. Source citation.' }] }]
  }, ZoteroAdapter: {
    getPdfAttachment: async () => ({ attachmentItem: pdf, parentItem: parent, filePath: 'paper.pdf', fileName: 'paper.pdf' }),
    saveHTMLAttachment: async (html, _title, item, libraryID, signal) => {
      ctx.LLMClient.throwIfAborted(signal);
      const attachment = { id: nextAttachment++, libraryID, parentItemID: item.id, attachmentContentType: 'text/html',
        isAttachment: () => true, getFilePathAsync: async () => `saved-${attachment.id}.html`, html };
      attachments.set(attachment.id, attachment);
      return attachment;
    }
  } });
  for (const file of ['task_checkpoints.js', 'llm_client.js', 'vendor/katex.min.js', 'markdown_renderer.js', 'paper_content.js', 'paper_annotation.js']) vm.runInContext(read('scripts/' + file), ctx);
  ctx.LLMClient.complete = async (messages, _config, { signal }) => {
    ctx.LLMClient.throwIfAborted(signal);
    const input = JSON.parse(messages[1].content);
    const call = { kind: input.passages ? 'group' : messages[0].content.includes('"notes"') ? 'merge' : 'overview', ids: input.passages?.map(p => p.id) };
    calls.push(call);
    await f.intercept?.(call, input, signal);
    if (input.passages) return JSON.stringify({ paragraphs: input.passages.map(entry => ({ id: entry.id,
      translation: '在 118 个站点进行测量。', function: '研究依据。'.repeat(85), role: '支持论证。'.repeat(85), observation: '边界条件。'.repeat(85),
      highlights: [{ quote: '118 stations', category: 'evidence' }]
    })) });
    return JSON.stringify(call.kind === 'merge' ? { notes: '保留研究问题、118 个站点的数据及限定条件。' } : overview);
  };
  const f = { ctx, core: ctx.SIPaperAnnotation, calls, progress, intercept: null,
    generate: (source = sections, options = {}, cfg = config) => ctx.SIPaperAnnotation.generate(source, 'Test paper', text => progress.push(text),
      { prompt, config: cfg, resumeKey: 'annotation:1:ABC12345', ...options }),
    create: (signal, options) => ctx.SIPaperAnnotation.create(pdf, prompt, config, text => progress.push(text), signal, options) };
  return f;
}

(async () => {
  let f = fixture();
  const unheaded = f.core.sections(prose);
  assert.equal(unheaded[0].title, '正文');
  assert.equal(f.core.readingRows(unheaded[0])[0].analyze, true);
  assert.equal(f.core.sourceFragment('CO2 AND CH4 EMISSIONS INCREASED BY 20%.'), false);
  assert.equal(f.core.sourceFragment('T = ax + by'), true);
  const opening = f.core.sections('Study area and data\n\n' + prose + '\n\n2. Results\n\n' + prose);
  assert.ok(f.core.readingRows(opening[0]).every(row => row.analyze));
  const completed = await f.generate(unheaded, { resumeKey: 'unheaded' });
  assert.equal(completed.coverage.analyzed, 1);

  const line = c => ({ c, paragraphBreakAfter: true });
  const cleaned = f.core.cleanPDF([
    { label: 'iv', chars: [line('Introduction'), line('We measured temperature across')] },
    { label: 'v', chars: [line('a wide range of stations.'), line('Results'), line(prose)] }
  ], true);
  const located = f.core.sections(cleaned.text, false, cleaned.ranges);
  assert.deepEqual(JSON.parse(JSON.stringify(located[0].sources[0])), [{ page: 1, label: 'iv' }, { page: 2, label: 'v' }]);
  assert.deepEqual(JSON.parse(JSON.stringify(located[1].sources[0])), [{ page: 2, label: 'v' }]);
  const fragmentRows = f.core.readingRows({ title: 'Methods', paragraphs: ['T = ax', '(2)'], sources: [[{ page: 1 }], [{ page: 2 }]] });
  assert.equal(fragmentRows.length, 1);
  assert.deepEqual(Array.from(fragmentRows[0].sources, p => p.page), [1, 2]);
  const labelHTML = f.core.sourceHTML([{ sources: [{ page: 2, label: '<img onerror=1>' }] }], 'javascript:alert(1)');
  assert.ok(!labelHTML.includes('<a') && !labelHTML.includes('<img') && labelHTML.includes('&lt;img'));
  assert.match(f.core.sourceHTML([{}], ''), /页码未定位/);
  assert.equal(f.core.sourceURI(pdf), 'zotero://open-pdf/library/items/ABC12345');
  f.ctx.Zotero.Libraries.get = () => ({ libraryType: 'group' });
  assert.equal(f.core.sourceURI(pdf), 'zotero://open-pdf/groups/87/items/ABC12345');

  // A second process must reuse completed groups and retry only the failed group.
  f = fixture();
  f.intercept = call => { if (call.kind === 'group' && call.ids[0] === 2) throw Error('group two failed'); };
  await assert.rejects(f.generate(), /group two failed/);
  assert.deepEqual(f.calls.map(c => c.ids), [[1], [2]]);
  f = fixture();
  let merges = 0;
  f.intercept = call => { if (call.kind === 'merge' && ++merges === 2) throw Error('second merge failed'); };
  await assert.rejects(f.generate(), /second merge failed/);
  assert.equal(f.calls.filter(c => c.kind === 'group').length, 17);
  assert.equal(f.calls.find(c => c.kind === 'group').ids[0], 2);
  f = fixture();
  f.intercept = call => { if (call.kind === 'overview') throw Error('overview failed'); };
  await assert.rejects(f.generate(), /overview failed/);
  assert.deepEqual(f.calls.map(c => c.kind), ['merge', 'overview']);
  f = fixture();
  const resumed = await f.generate();
  assert.deepEqual(f.calls.map(c => c.kind), ['overview']);
  assert.equal(resumed.coverage.analyzed, 18);
  assert.ok(resumed.sections[0].paragraphs.every(parts => parts.every(part => part.analysis)));
  f = fixture();
  await f.generate();
  assert.equal(f.calls.length, 0);
  assert.match(f.progress.join('\n'), /已恢复/);
  const persisted = [...disk.values()].join('');
  assert.ok(!persisted.includes(config.llmApiKey) && !persisted.includes(config.mineruToken));
  assert.ok(!persisted.includes(prose.repeat(24)), 'do not persist complete source documents');

  // Every input affecting the analysis invalidates the cache; credentials do not.
  const small = [{ title: 'Results', paragraphs: [prose] }];
  f = fixture();
  await f.generate(small, { resumeKey: 'identity' });
  f.calls.length = 0;
  await f.generate(small, { resumeKey: 'identity' }, { ...config, llmApiKey: 'rotated', mineruToken: 'rotated' });
  assert.equal(f.calls.length, 0);
  for (const [source, opts, cfg] of [
    [[{ title: 'Results', paragraphs: [prose + 'New data.'] }], {}, config],
    [[{ ...small[0], sources: [[{ page: 2 }]] }], {}, config],
    [small, { prompt: 'New instructions' }, config],
    ...Object.entries({ llmModel: 'model-b', llmApiBase: 'https://different.test', llmSlot: 2,
      llmProvider: 'openai', llmThinking: true, llmMaxTokens: 4096 }).map(([key, value]) => [small, {}, { ...config, [key]: value }])
  ]) {
    f.calls.length = 0;
    await f.generate(source, { resumeKey: 'identity', ...opts }, cfg);
    assert.deepEqual(f.calls.map(c => c.kind), ['group', 'overview']);
  }
  const cached = await f.generate(small, { resumeKey: 'identity' });
  cached.checkpoint.record.groups[0][0].spans = [{ start: 0, end: 999999, category: 'evidence' }];
  await cached.checkpoint.cache.put(cached.checkpoint.key, cached.checkpoint.record);
  f.calls.length = 0;
  await f.generate(small, { resumeKey: 'identity' });
  assert.deepEqual(f.calls.map(c => c.kind), ['group', 'overview'], 'corrupt cached spans must be regenerated');

  f = fixture();
  const controller = new AbortController();
  f.intercept = call => { if (call.kind === 'group' && call.ids[0] === 2) controller.abort(); };
  await assert.rejects(f.generate(sections, { resumeKey: 'cancelled', signal: controller.signal }), error => error.name === 'AbortError');
  f = fixture();
  await f.generate(sections, { resumeKey: 'cancelled' });
  assert.equal(f.calls[0].ids[0], 2, 'late result after cancellation must not be cached');

  f = fixture();
  f.ctx.IOUtils.writeJSON = async () => { throw Error('disk full'); };
  await f.generate(small, { resumeKey: 'memory-only' });
  assert.match(f.progress.join('\n'), /暂未写入磁盘/);
  f.calls.length = 0;
  await f.generate(small, { resumeKey: 'memory-only' });
  assert.equal(f.calls.length, 0, 'memory cache still works when persistent storage is unavailable');

  // Attachment saves are reusable, while missing files and wrong parents are rebuilt.
  f = fixture();
  let resolved;
  const first = await f.create(undefined, { onAttachment: id => { resolved = id; } });
  assert.equal(resolved, pdf.id);
  const html = attachments.get(first.attachmentID).html;
  assert.match(html, /zotero:\/\/open-pdf\/library\/items\/ABC12345\?page=1/);
  assert.match(html, /页标 iv/);
  assert.match(html, /翻译与批注 1 段/);
  fs.mkdirSync(path.join(__dirname, '../scratch'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, '../scratch/paper-annotation-improved.html'), html);
  f = fixture();
  assert.equal((await f.create()).attachmentID, first.attachmentID);
  assert.equal(f.calls.length, 0);
  attachments.get(first.attachmentID).missing = true;
  const recreated = await f.create();
  assert.notEqual(recreated.attachmentID, first.attachmentID);
  assert.equal(f.calls.length, 0);
  attachments.get(recreated.attachmentID).parentItemID = 999;
  assert.notEqual((await f.create()).attachmentID, recreated.attachmentID);

  // Lock a running PDF and release it on failure; no duplicate imports.
  f = fixture();
  let release;
  f.core.extract = () => new Promise(resolve => { release = resolve; });
  const pending = f.create();
  while (!release) await new Promise(setImmediate);
  await assert.rejects(f.create(), /正在运行/);
  release([]);
  await assert.rejects(pending, /未提取到/);
  assert.equal(f.core.running.size, 0);
  console.log('paper annotation resume passed: unheaded/uppercase prose, page provenance, persistent group/merge/final recovery, identity invalidation, cancellation, storage failure and attachment reuse');
})().catch(error => { console.error(error); process.exitCode = 1; });
