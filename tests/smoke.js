const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

function load(context, name) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../plugin_src/chrome/content/scripts", name), "utf8"), context);
}

async function main() {
  const context = vm.createContext({ console, atob });
  load(context, "error_utils.js");
  load(context, "markdown_renderer.js");
  const html = context.MarkdownRenderer.toHTML("# 标题\n- **重点**\n<script>alert(1)</script>");
  assert.match(html, /<h1>标题<\/h1>/);
  assert.match(html, /<li><strong>重点<\/strong><\/li>/);
  assert.doesNotMatch(html, /<script>/);
  const table = context.MarkdownRenderer.toHTML("| 项目 | 结果 |\n| --- | --- |\n| 方法 | <unsafe> |");
  assert.match(table, /<table>/);
  assert.match(table, /<td>&lt;unsafe&gt;<\/td>/);

  const saved = [];
  const attachment = { id: 8, libraryID: 1, parentItemID: 3, attachmentFilename: "paper.pdf" };
  const parent = { id: 3, getField: () => "Paper" };
  context.Zotero = {
    Items: { get: (id) => id === 3 ? parent : null },
    Item: class {
      constructor(type) { assert.equal(type, "note"); }
      setNote(value) { this.html = value; }
      async saveTx() { this.id = 91; saved.push(this); }
    }
  };
  load(context, "zotero_adapter.js");
  const note = await context.ZoteroAdapter.saveConversationNote(attachment, [
    { role: "user", content: "What is <unsafe>?" },
    { role: "assistant", content: "## Answer\n- **Safe**" }
  ]);
  assert.equal(note.parentID, 3);
  assert.match(note.html, /&lt;unsafe&gt;/);
  assert.match(note.html, /<strong>Safe<\/strong>/);
  assert.equal(saved.length, 1);

  const elements = new Map();
  const listeners = new Map();
  let dynamicID = 0;
  function element(id) {
    const handlers = new Map();
    const value = {
      id, value: "", textContent: "", style: { setProperty(name, value) { this[name] = value; } }, dataset: {}, children: [], classList: { toggle() {} },
      addEventListener(type, fn) { handlers.set(type, fn); },
      setAttribute() {},
      append(...nodes) { this.children.push(...nodes); },
      replaceChildren() { this.children = []; },
      dispatchEvent() {},
      fire(type) { return handlers.get(type)?.(); }
    };
    elements.set(id, value);
    return value;
  }
  ["mineru-mode-agent", "mineru-mode-precise", "mineru-mode-current", "mineru-status-box",
    "mineruToken", "mineruModel", "llmSlot", "llmProfileName", "llmApiBase", "llmApiKey", "llmModel", "llmProvider",
    "mineru-preset-deepseek", "mineru-preset-ollama", "mineru-preset-openai",
    "mineru-preset-qwen", "mineru-preset-siliconflow",
    "mineru-btn-test-mineru", "mineru-btn-test-llm", "mineru-link-mineru", "mineru-link-deepseek",
    "si-save-profile", "si-usage-total", "si-usage-today", "si-usage-year-total", "si-usage-requests", "si-usage-cache", "si-usage-cache-fill",
    "si-usage-breakdown", "si-usage-calendar", "si-usage-detail", "si-usage-months", "si-usage-monthly", "si-usage-profile", "si-usage-year",
    "autoGenerateNote", "autoTag"
  ].forEach(element);
  let paneInserted = false;
  const prefs = new Map([["extensions.zoteromineru.mineruMode", "agent"]]);
  context.document = {
    getElementById: (id) => id === "zotero-prefpane-mineru" ? (paneInserted ? { id } : null) : elements.get(id),
    createElementNS: (_namespace, tag) => element(`dynamic-${tag}-${++dynamicID}`),
    addEventListener(type, fn) { listeners.set(type, fn); }
  };
  let mineruAuthorization;
  let mineruModel;
  context.window = { atob, addEventListener() {}, fetch: async (url, options) => {
    if (url.includes("mineru.net")) {
      mineruAuthorization = options.headers.Authorization;
      mineruModel = JSON.parse(options.body).model_version;
    }
    return { ok: true, status: 200,
    json: async () => url.includes("mineru.net")
      ? { code: 0, data: { batch_id: "test" } }
      : { choices: [{ message: { content: "OK" } }] } };
  } };
  context.Zotero.Prefs = { get: (key) => prefs.get(key), set: (key, value) => prefs.set(key, value) };
  context.Zotero.debug = () => {};
  context.fetch = async () => ({ ok: true, status: 200, json: async () => ({
    choices: [{ message: { content: "OK" } }],
    usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 }
  }) });
  context.TextDecoder = TextDecoder;
  load(context, "usage_tracker.js");
  load(context, "llm_client.js");
  load(context, "summary_text_cache.js");
  load(context, "main.js");
  context.AbortController = AbortController;
  context.setTimeout = setTimeout;
  context.clearTimeout = clearTimeout;
  context.Event = Event;
  load(context, "preferences.js");
  paneInserted = true;
  listeners.get("load")({ target: { id: "zotero-prefpane-mineru" } });
  elements.get("mineru-mode-precise").fire("click");
  assert.equal(prefs.get("extensions.zoteromineru.mineruMode"), "precise");
  elements.get("mineruModel").value = "pipeline";
  elements.get("mineruModel").fire("change");
  assert.equal(prefs.get("extensions.zoteromineru.mineruModel"), "pipeline");
  elements.get("llmApiBase").value = "https://api.deepseek.com/v1";
  elements.get("llmApiKey").value = "test-key";
  elements.get("llmModel").value = "deepseek-flash";
  elements.get("si-save-profile").fire("click");
  assert.match(elements.get("mineru-status-box").textContent, /已保存/);
  await elements.get("mineru-btn-test-llm").fire("click");
  assert.match(elements.get("mineru-status-box").textContent, /连接成功/);
  assert.equal(Object.values(context.LLMUsage.read())[0].total, 6);
  assert.match(elements.get("si-usage-total").textContent, /6 Token/);
  assert.ok(elements.get("si-usage-calendar").children.length >= 365);
  assert.equal(elements.get("si-usage-months").children.length, 12);
  assert.equal(elements.get("si-usage-monthly").children.length, 12);
  assert.equal(context.Zotero.MinerUAI.getProfiles().length, 8);
  assert.equal(elements.get("llmSlot").children.length, 8);
  elements.get("llmSlot").value = "2";
  elements.get("llmSlot").fire("change");
  assert.equal(context.Zotero.MinerUAI.activeProfile(), 2);
  assert.equal(elements.get("llmModel").value, "gpt-4o-mini");
  elements.get("llmSlot").value = "1";
  elements.get("llmSlot").fire("change");
  assert.equal(elements.get("llmApiKey").value, "test-key");
  elements.get("llmSlot").value = "8";
  elements.get("llmSlot").fire("change");
  elements.get("llmProfileName").value = "本地模型";
  elements.get("llmProfileName").fire("input");
  assert.equal(context.Zotero.MinerUAI.getProfiles()[7].name, "本地模型");
  assert.equal(context.Zotero.MinerUAI.activeProfile(), 8);
  elements.get("llmSlot").value = "1";
  elements.get("llmSlot").fire("change");
  const sse = [
    'data: {"choices":[{"delta":{"content":"你好"}}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
    'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":3,"total_tokens":13}}',
    "data: [DONE]", ""
  ].join("\n\n");
  context.fetch = async () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode(sse));
    controller.close();
  } }), { headers: { "content-type": "text/event-stream" } });
  const streamed = await context.LLMClient.chatWithPdf("PDF text", [{ role: "user", content: "问题" }],
    context.Zotero.MinerUAI.getConfig());
  assert.equal(streamed, "你好");
  assert.equal(Object.values(context.LLMUsage.read())[0].total, 19);
  context.fetch = async () => ({ ok: true, headers: { get: () => "application/json" },
    json: async () => ({ choices: [{ message: { content: "无用量响应" } }] }) });
  await context.LLMClient.testConnection(context.Zotero.MinerUAI.getConfig());
  assert.equal(Object.values(context.LLMUsage.read())[0].unreported, 1);
  const usageDay = Object.values(context.LLMUsage.read())[0];
  assert.equal(usageDay.profiles["1"].total, 19);
  assert.equal(usageDay.profiles["1"].unreported, 1);
  context.LLMUsage.record({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }, 8);
  assert.equal(Object.values(context.LLMUsage.read())[0].profiles["8"].total, 5);
  context.LLMUsage.record({ prompt_tokens: 20, completion_tokens: 5, total_tokens: 25,
    prompt_tokens_details: { cached_tokens: 4 } }, 2);
  assert.equal(Object.values(context.LLMUsage.read())[0].profiles["2"].cached, 4);
  elements.get("si-usage-profile").value = "2";
  elements.get("si-usage-profile").fire("change");
  assert.match(elements.get("si-usage-total").textContent, /25 Token/);
  assert.equal(elements.get("si-usage-cache").textContent, "20.0%");
  elements.get("si-usage-profile").value = "all";
  elements.get("si-usage-profile").fire("change");
  const legacy = context.LLMUsage.read();
  legacy["2025-01-02"] = { prompt: 2, completion: 1, total: 3, requests: 1, unreported: 0 };
  prefs.set("extensions.zoteromineru.llmUsage", JSON.stringify(legacy));
  elements.get("si-usage-year").value = "2025";
  elements.get("si-usage-year").fire("change");
  assert.equal(elements.get("si-usage-year").value, "2025");
  elements.get("mineru-preset-qwen").fire("click");
  assert.equal(elements.get("llmApiKey").value, "");
  assert.equal(context.Zotero.MinerUAI.getConfig().llmApiBase,
    "https://dashscope.aliyuncs.com/compatible-mode/v1");
  context.Zotero.PDFWorker = { getFullText: async () => ({ text: "研究方法与结果正文" }) };
  context.ZoteroAdapter.getPdfAttachment = async () => ({
    attachmentItem: { id: 8 }, parentItem: parent, fileName: "paper.pdf", filePath: "paper.pdf"
  });
  const originalAnalyze = context.LLMClient.analyzePaper;
  context.Zotero.MinerUAI.saveSummaryPrompt("table_summary", "请用中文生成表格。");
  assert.equal(context.Zotero.MinerUAI.getSummaryPrompt("table_summary"), "请用中文生成表格。");
  context.LLMClient.analyzePaper = async (_text, promptType, _config, _stream, prompt) => {
    assert.equal(promptType, "table_summary");
    assert.equal(prompt, "请用中文生成表格。");
    return "| 项目 | 内容 |\n| --- | --- |\n| 方法 | 测试 |";
  };
  const summary = await context.Zotero.MinerUAI.summarizeItem(parent, "table_summary");
  assert.equal(summary.title, "Paper");
  await context.Zotero.MinerUAI.saveSummary(summary);
  assert.match(saved.at(-1).html, /<table>/);
  assert.match(saved.at(-1).html, /生成时间/);
  assert.match(context.Zotero.MinerUAI.resetSummaryPrompt("table_summary"), /研究概览/);
  const taskID = context.Zotero.MinerUAI.startSummaryTask({ title: "Paper", promptType: "table_summary", profileSlot: 8, itemID: 3 });
  context.Zotero.MinerUAI.updateSummaryTask(taskID, { stage: "正在调用 AI" });
  assert.equal(context.Zotero.MinerUAI.getSummaryTasks().items[0].stage, "正在调用 AI");
  context.Zotero.MinerUAI.updateSummaryTask(taskID, { status: "completed", stage: "已保存", noteID: 91 });
  assert.equal(context.Zotero.MinerUAI.getSummaryTasks().totals.completed, 1);
  assert.equal(context.Zotero.MinerUAI.getSummaryTasks().items[0].noteID, 91);
  const interruptedID = context.Zotero.MinerUAI.startSummaryTask({ title: "Other", promptType: "paper_summary", profileSlot: 1 });
  context.Zotero.MinerUAI.recoverSummaryTasks();
  assert.equal(context.Zotero.MinerUAI.getSummaryTasks().items.find((item) => item.id === interruptedID).status, "interrupted");
  context.LLMClient.analyzePaper = originalAnalyze;
  const originalComplete = context.LLMClient.complete;
  const segmentCalls = [];
  context.LLMClient.complete = async (messages) => {
    segmentCalls.push(messages);
    return "证据与结果";
  };
  const longSummary = await context.LLMClient.analyzePaper("A".repeat(45000) + "全文结尾独有结论", "table_summary");
  assert.equal(segmentCalls.length, 3);
  assert.ok(segmentCalls[1][1].content.includes("全文结尾独有结论"));
  assert.match(longSummary, /全文 2 段/);
  assert.doesNotMatch(longSummary, /仅基于前/);
  segmentCalls.length = 0;
  await context.LLMClient.analyzePaper("短文", "paper_summary");
  assert.equal(segmentCalls.length, 1);
  context.LLMClient.complete = originalComplete;
  assert.ok(context.Zotero.MinerUAI.getSummaryTasks().items.find((item) => item.id === taskID).durationMs >= 0);
  elements.get("mineruToken").value = ' "Bearer mineru-test-token" ';
  await elements.get("mineru-btn-test-mineru").fire("click");
  assert.match(elements.get("mineru-status-box").textContent, /Token 有效/);
  assert.equal(mineruAuthorization, "Bearer mineru-test-token");
  assert.equal(mineruModel, "pipeline");
  assert.equal(prefs.get("extensions.zoteromineru.mineruToken"), "mineru-test-token");
  load(context, "mineru_client.js");
  assert.equal(context.MinerUClient.normalizeToken(' "Bearer mineru-test-token" '), "mineru-test-token");
  context.window.fetch = async () => ({ ok: false, status: 401, json: async () => ({ msgCode: "A0202", msg: "user authenticate failed", trace_id: "trace-test" }) });
  await elements.get("mineru-btn-test-mineru").fire("click");
  assert.match(elements.get("mineru-status-box").textContent, /鉴权失败.*A0202/);
  assert.match(elements.get("mineru-status-box").textContent, /trace-test/);
  let parsedModel;
  context.fetch = async (_url, options) => {
    parsedModel = JSON.parse(options.body).model_version;
    return { ok: false, status: 401, json: async () => ({ msgCode: "A0202", trace_id: "trace-test" }) };
  };
  await assert.rejects(context.MinerUClient.parsePdf("paper.pdf", new Uint8Array(),
    { mode: "precise", token: "test", model: "pipeline" }), /A0202.*trace-test/);
  assert.equal(parsedModel, "pipeline");
  const expiredToken = `header.${Buffer.from(JSON.stringify({ exp: 1 })).toString("base64url")}.signature`;
  elements.get("mineruToken").value = expiredToken;
  context.window.fetch = async () => { throw new Error("expired token must not be sent"); };
  await elements.get("mineru-btn-test-mineru").fire("click");
  assert.match(elements.get("mineru-status-box").textContent, /Token 已于.*过期/);
  await assert.rejects(context.MinerUClient.parsePdf("paper.pdf", new Uint8Array(),
    { mode: "precise", token: expiredToken, model: "vlm" }), /Token 已于.*过期/);

  const menuNodes = new Map();
  const makeMenu = () => ({ children: [], appendChild(node) {
    this.children.push(node);
    menuNodes.set(node.id, node);
  } });
  const itemMenu = makeMenu();
  const toolsMenu = makeMenu();
  const menuDoc = {
    getElementById(id) {
      return id === "zotero-itemmenu" ? itemMenu :
        id === "menu_ToolsPopup" ? toolsMenu : menuNodes.get(id);
    },
    createXULElement() {
      return { attributes: {}, setAttribute(key, value) { this.attributes[key] = value; }, addEventListener() {}, remove() { menuNodes.delete(this.id); } };
    }
  };
  await context.ZoteroMinerUAI.onMainWindowLoad({ document: menuDoc });
  await context.ZoteroMinerUAI.onMainWindowLoad({ document: menuDoc });
  assert.equal(itemMenu.children.length, 1);
  assert.equal(toolsMenu.children.length, 1);
  assert.equal(itemMenu.children[0].attributes.class, "menuitem-iconic");
  assert.equal(itemMenu.children[0].attributes.image, "chrome://zoteromineru/content/icons/favicon@0.5x.png");
  let located = null;
  context.Zotero.getMainWindow = () => ({ ZoteroPane: { selectItem: async (id) => { located = id; } }, focus() {} });
  await context.Zotero.MinerUAI.locateSummaryTask({ itemID: 3 });
  assert.equal(located, 3);
  await assert.rejects(() => context.Zotero.MinerUAI.locateSummaryTask({}), /未保存文献关联/);
  const oldUsage = context.Zotero.MinerUAI.getUsage;
  const todayKey = new Date().toLocaleDateString("en-CA");
  elements.get("si-usage-profile").value = "all";
  for (const [count, expected] of [[999, "999 Token"], [1000, "1,000 Token"], [1500, "1.5k Token"], [1000000, "1000k Token"]]) {
    context.Zotero.MinerUAI.getUsage = () => ({ [todayKey]: { total: count } });
    elements.get("si-usage-year").fire("change");
    assert.equal(elements.get("si-usage-total").textContent, expected);
  }
  context.Zotero.MinerUAI.getUsage = oldUsage;
  console.log("smoke tests passed");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
