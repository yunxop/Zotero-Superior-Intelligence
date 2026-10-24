const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const scripts = 'plugin_src/chrome/content/scripts/';
const config = { llmApiBase: 'https://models.test/v1', llmApiKey: 'test', llmModel: 'test', llmProvider: 'openai' };
const turn = () => new Promise(setImmediate);
const aborted = error => error?.name === 'AbortError' && error.cancelled === true;

function context() {
  const timers = new Set();
  const ctx = vm.createContext({
    AbortController, TextDecoder, TextEncoder, console,
    setTimeout(fn, delay) { const timer = setTimeout(() => { timers.delete(timer); fn(); }, delay); timers.add(timer); return timer; },
    clearTimeout(timer) { timers.delete(timer); clearTimeout(timer); },
    SIError: { describe: error => error.message }, LLMUsage: { record() {} },
    fetch: () => { throw Error('Unexpected network request'); }
  });
  for (const name of ['task_checkpoints.js', 'llm_client.js', 'mineru_client.js']) vm.runInContext(fs.readFileSync(scripts + name, 'utf8'), ctx);
  return { ctx, timers };
}

function trackedController() {
  const controller = new AbortController(), listeners = new Set();
  const signal = controller.signal, add = signal.addEventListener.bind(signal), remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = (type, listener, options) => { if (type === 'abort') listeners.add(listener); add(type, listener, options); };
  signal.removeEventListener = (type, listener, options) => { if (type === 'abort') listeners.delete(listener); remove(type, listener, options); };
  return { controller, signal, listeners };
}

function sse(text, { splitBytes = false, hangAfter = false } = {}) {
  const bytes = new TextEncoder().encode(text), chunks = splitBytes ? [...bytes].map(byte => new Uint8Array([byte])) : [bytes];
  let index = 0;
  const state = { cancelled: 0, released: 0 };
  const response = { ok: true, headers: { get: () => 'text/event-stream' }, body: { getReader: () => ({
    async read() { return index < chunks.length ? { done: false, value: chunks[index++] } : hangAfter ? new Promise(() => {}) : { done: true }; },
    cancel() { state.cancelled++; }, releaseLock() { state.released++; }
  }) } };
  return { response, state };
}
const event = data => `data: ${JSON.stringify(data)}\n\n`;
const delta = content => ({ choices: [{ index: 0, delta: { content }, finish_reason: null }] });
const finish = reason => ({ choices: [{ index: 0, delta: {}, finish_reason: reason }] });
const analyze = (ctx, key) => ctx.LLMClient.analyzePaper('paper text', 'paper_summary', config, () => {}, '', () => {}, () => {}, { resumeKey: key });
const jsonResponse = data => ({ ok: true, status: 200, json: async () => data });
const never = () => new Promise(() => {});

(async () => {
  let { ctx, timers } = context();
  const completeStream = (event(delta('中文📚')) + event(finish('stop')) + event({ choices: [], usage: { total_tokens: 42 } }) + 'data: [DONE]\n\n').replace(/\n/g, '\r\n');
  let mock = sse(completeStream, { splitBytes: true, hangAfter: true }), usage, full;
  ctx.fetch = async () => mock.response;
  assert.equal(await ctx.LLMClient.complete([], config, { stream: true, timeoutMs: 1000, onStream: (_delta, answer) => { full = answer; }, onUsage: value => { usage = value; } }), '中文📚');
  assert.equal(full, '中文📚'); assert.equal(usage.total_tokens, 42);
  assert.equal(mock.state.cancelled, 1, '[DONE] must finish without waiting for the socket to close');
  assert.equal(mock.state.released, 1); assert.equal(timers.size, 0);

  for (const text of [
    'event: message\rdata: {"choices":\rdata: [{"delta":{"content":"multiline"},"finish_reason":"stop"}]}\r\r',
    event(delta('multiline')) + 'data: ' + JSON.stringify(finish('stop'))
  ]) {
    mock = sse(text, { splitBytes: true }); ctx.fetch = async () => mock.response;
    assert.equal(await ctx.LLMClient.complete([], config, { stream: true }), 'multiline');
    assert.equal(mock.state.released, 1);
  }

  const failures = [
    [event(delta('partial')), /提前结束/],
    [event(delta('partial')) + 'data: [DONE]\n\n', /提前结束/],
    [event(delta('partial')) + event({ error: { message: 'quota exhausted' } }), /quota exhausted/],
    [event(delta('partial')) + 'event: error\ndata: backend failed\n\n', /backend failed/],
    [event(delta('partial')) + 'data: {invalid JSON}\n\n' + event(finish('stop')), /格式损坏/],
    [event(delta('partial')) + event(finish('content_filter')), /content_filter/],
    [event(delta('partial')) + event(finish('tool_calls')), /tool_calls/]
  ];
  for (const [index, [text, expected]] of failures.entries()) {
    let calls = 0;
    ctx.fetch = async () => { calls++; return sse(text).response; };
    await assert.rejects(() => analyze(ctx, `failed-${index}`), expected);
    await assert.rejects(() => analyze(ctx, `failed-${index}`), expected);
    assert.equal(calls, 2, 'an incomplete/error stream must never become a reusable checkpoint');
    assert.equal(await ctx.LLMClient.getResumeInfo(`failed-${index}`), null);
    assert.equal(timers.size, 0);
  }
  ctx.fetch = async () => sse(event(delta('bounded partial')) + event(finish('length')) + 'data: [DONE]\n\n').response;
  assert.match(await analyze(ctx, 'length'), /未完成.*\n[\s\S]*bounded partial/);
  assert.equal(await ctx.LLMClient.getResumeInfo('length'), null);
  await assert.rejects(() => ctx.LLMClient.complete([], config, { stream: true }), /结果不完整/);

  const identity = ctx.LLMClient.resumeIdentity('paper text', ctx.LLMClient.PROMPT_TEMPLATES.paper_summary, config);
  const oldKey = ctx.TaskCheckpointCache.keyFor('legacy', { ...identity, version: 1 });
  await ctx.TaskCheckpointCache.put(oldKey, { resumeKey: 'legacy', kind: 'paper-summary', total: 1, notes: [], merges: {}, final: 'unverified old answer' });
  let calls = 0;
  ctx.fetch = async () => { calls++; return sse(event(delta('verified answer')) + event(finish('stop'))).response; };
  assert.equal(await analyze(ctx, 'legacy'), 'verified answer');
  assert.equal(await analyze(ctx, 'legacy'), 'verified answer'); assert.equal(calls, 1);

  for (const data of [
    { error: { message: 'JSON backend failure' } },
    { choices: [{ message: { content: 'filtered partial' }, finish_reason: 'content_filter' }] },
    { choices: [{ message: { content: 'invalid finish' }, finish_reason: 0 }] }
  ]) {
    ctx.fetch = async () => ({ ...jsonResponse(data), headers: { get: () => 'application/json' } });
    await assert.rejects(() => ctx.LLMClient.complete([], config), /错误|未正常完成/);
  }

  // Request deadlines cover every network stage, including slow bodies and ignored AbortSignals.
  for (const mode of ['agent', 'precise']) {
    for (const phase of ['apply-fetch', 'apply-body', 'upload', 'poll-fetch', 'poll-body', 'download-fetch', 'download-body']) {
      ({ ctx, timers } = context());
      const tracked = trackedController(), signals = [];
      let request = 0;
      ctx.MinerUClient.wait = async (_ms, signal) => ctx.MinerUClient.throwIfAborted(signal);
      ctx.fetch = async (_url, options) => {
        request++; signals.push(options.signal);
        if ((request === 1 && phase === 'apply-fetch') || (request === 2 && phase === 'upload') || (request === 3 && phase === 'poll-fetch') || (request === 4 && phase === 'download-fetch')) return never();
        if (request === 1) return phase === 'apply-body' ? { ok: true, json: never } : jsonResponse({ code: 0, data: mode === 'agent' ? { task_id: 'task', file_url: 'https://upload.test' } : { batch_id: 'batch', file_urls: ['https://upload.test'] } });
        if (request === 2) return { ok: true, status: 200 };
        if (request === 3) return phase === 'poll-body' ? { ok: true, json: never } : jsonResponse({ code: 0, data: mode === 'agent' ? { state: 'done', markdown_url: 'https://markdown.test' } : { extract_result: [{ state: 'done', full_zip_url: 'https://zip.test' }] } });
        if (request === 4) return { ok: true, text: never, arrayBuffer: never };
        throw Error('must not retry');
      };
      await assert.rejects(() => ctx.MinerUClient.parsePdf('paper.pdf', new Uint8Array([1]), { mode, token: 'test-token', signal: tracked.signal, requestTimeoutMs: 15, parseTimeoutMs: 1000 }), error => error.name === 'TimeoutError' && /单次网络请求/.test(error.message));
      await turn();
      assert.equal(signals.at(-1).aborted, true, `${mode} ${phase}: transport must be aborted`);
      assert.equal(tracked.signal.aborted, false, 'timeouts must not abort the caller controller');
      assert.equal(timers.size, 0, `${mode} ${phase}: all deadlines cleaned up`);
      assert.equal(tracked.listeners.size, 0, `${mode} ${phase}: all caller listeners cleaned up`);
    }
  }

  for (const mode of ['agent', 'precise']) {
    ({ ctx, timers } = context());
    const tracked = trackedController(); let transportSignal;
    ctx.fetch = async (_url, options) => { transportSignal = options.signal; return never(); };
    await assert.rejects(() => ctx.MinerUClient.parsePdf('paper.pdf', new Uint8Array(), { mode, token: 'test-token', signal: tracked.signal, requestTimeoutMs: 1000, parseTimeoutMs: 15 }), error => error.name === 'TimeoutError' && /总等待时限/.test(error.message));
    await turn(); assert.equal(transportSignal.aborted, true); assert.equal(timers.size, 0); assert.equal(tracked.listeners.size, 0);

    ({ ctx, timers } = context());
    const cancelled = trackedController(); let reading;
    const started = new Promise(resolve => { reading = resolve; });
    ctx.fetch = async (_url, options) => { transportSignal = options.signal; return { ok: true, json() { reading(); return never(); } }; };
    const pending = ctx.MinerUClient.parsePdf('paper.pdf', new Uint8Array(), { mode, token: 'test-token', signal: cancelled.signal });
    await started; cancelled.controller.abort(); await assert.rejects(pending, aborted);
    await turn(); assert.equal(transportSignal.aborted, true); assert.equal(timers.size, 0); assert.equal(cancelled.listeners.size, 0);
  }

  ({ ctx, timers } = context());
  const completed = trackedController(); let request = 0, discarded = 0;
  ctx.MinerUClient.wait = async (_ms, signal) => ctx.MinerUClient.throwIfAborted(signal);
  ctx.fetch = async () => {
    request++;
    if (request === 1) return jsonResponse({ code: 0, data: { task_id: 'done', file_url: 'https://upload.test' } });
    if (request === 2) return { ok: true, body: { cancel() { discarded++; } } };
    if (request === 3) return jsonResponse({ code: 0, data: { state: 'done', markdown_url: 'https://markdown.test' } });
    return { ok: true, text: async () => '# complete markdown' };
  };
  assert.equal((await ctx.MinerUClient.parseAgent('paper.pdf', new Uint8Array(), () => {}, { signal: completed.signal })).markdown, '# complete markdown');
  assert.equal(request, 4); assert.equal(discarded, 1); assert.equal(timers.size, 0); assert.equal(completed.listeners.size, 0);
  console.log('network resilience passed: terminal SSE validation, UTF-8/event boundaries, incomplete cache exclusion, MinerU stage/body/total deadlines, cancellation and cleanup');
})().catch(error => { console.error(error); process.exitCode = 1; });
