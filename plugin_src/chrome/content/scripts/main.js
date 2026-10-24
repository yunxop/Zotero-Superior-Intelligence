// input: Zotero runtime window, DOM events, User actions, PreferencePanes API
// output: Registered preference pane, Injected menu items (Tools & context menus), Progress windows, Notes
// pos: Main application controller binding UI actions, Preference management, MinerU extraction, and LLM synthesis

/**
 * Zotero 10 MinerU & AI Assistant 主入口控制器
 */
var ZoteroMinerUAI = {
  initialized: false,
  rootURI: "",
  paneId: null,
  taskControllers: new Map(),
  summarySaveLocks: new Map(),
  dashboardJob: null,
  dashboardSubscribers: new Set(),
  shuttingDown: false,

  // Render the first update immediately, then only the latest value per interval.
  // Callers flush on completion and cancel before clearing or disposing their UI.
  createUIUpdater(callback, intervalMs = 200) {
    let latest = null, timer = null, last = null, cancelled = false;
    const clear = () => { if (timer !== null) clearTimeout(timer); timer = null; };
    const flush = () => {
      clear();
      if (cancelled || !latest) return;
      const args = latest; latest = null; last = Date.now();
      callback(...args);
    };
    return {
      push(...args) {
        if (cancelled) return;
        latest = args;
        const remaining = last === null ? 0 : intervalMs - (Date.now() - last);
        if (remaining <= 0) flush();
        else if (timer === null) timer = setTimeout(flush, remaining);
      },
      flush,
      cancel() { cancelled = true; latest = null; clear(); }
    };
  },

  /**
   * 初始化核心控制器并注册系统服务
   */
  async init({ rootURI }) {
    if (this.initialized) return;
    this.shuttingDown = false;
    this.rootURI = rootURI;
    this.initialized = true;

    // 等待 Zotero 核心完全就绪
    await Zotero.initializationPromise;
    this.recoverSummaryTasks();

    // The former DeepSeek default model name was retired in 2026.
    if (Zotero.Prefs.get("extensions.zoteromineru.llmProvider", true) === "deepseek" &&
        Zotero.Prefs.get("extensions.zoteromineru.llmModel", true) === "deepseek-chat") {
      Zotero.Prefs.set("extensions.zoteromineru.llmModel", "deepseek-flash", true);
    }

    // 1. 注册首选项面板 (Preferences Pane)
    await this.registerPreferencePane();

    // Add a right-side chat section and a top-toolbar entry to PDF reader tabs.
    try {
      ReaderChat.register();
    } catch (error) {
      Zotero.logError("[MinerU-AI] 阅读器侧边栏注册失败: " + error);
    }

    // 2. 为当前已经处于打开状态的所有主窗口注入菜单项
    try {
      if (typeof Zotero.getMainWindows === "function") {
        for (const win of Zotero.getMainWindows()) {
          if (win.document && win.document.readyState === "complete") {
            this.onMainWindowLoad(win);
          } else if (win.addEventListener) {
            win.addEventListener("load", () => this.onMainWindowLoad(win), { once: true });
          }
        }
      }
    } catch (e) {
      Zotero.logError(e);
    }

    Zotero.debug("[MinerU-AI] 插件核心模块与界面组件成功挂载");
  },

  /**
   * 注册 Zotero 7/10 规范的首选项面板
   */
  async registerPreferencePane() {
    if (!Zotero.PreferencePanes) return;
    const targetPaneId = "zotero-prefpane-mineru";

    try {
      // 避免重复注册
      // Zotero owns pane cleanup on plugin shutdown. Do not unregister another
      // instance while the preferences window is using it.

      this.paneId = await Zotero.PreferencePanes.register({
        pluginID: "zotero-mineru-ai@custom.org",
        id: targetPaneId,
        src: this.rootURI + "chrome/content/preferences.xhtml",
        label: "Superior Intelligence (SI)",
        image: "chrome://zoteromineru/content/icons/favicon.png",
        scripts: [this.rootURI + "chrome/content/scripts/preferences.js"],
        helpURL: "https://mineru.net/apiManage/docs",
        defaultXUL: true
      });
      Zotero.debug("[MinerU-AI] 首选项面板已成功注册: " + this.paneId);
    } catch (err) {
      Zotero.logError(err);
    }
  },

  /**
   * 创建符合 Gecko 140 / Zotero 10 的 XUL 节点
   */
  createXUL(doc, tagName) {
    if (typeof doc.createXULElement === "function") {
      return doc.createXULElement(tagName);
    }
    return doc.createElementNS("http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul", tagName);
  },

  /**
   * 打开插件首选项配置窗口
   */
  openPreferences() {
    try {
      if (Zotero.Utilities && Zotero.Utilities.Internal && typeof Zotero.Utilities.Internal.openPreferences === "function") {
        Zotero.Utilities.Internal.openPreferences(this.paneId || "zotero-prefpane-mineru");
        return;
      }
      const win = Services.wm.getMostRecentWindow("navigator:browser");
      if (win) {
        win.openDialog(
          "chrome://zotero/content/preferences/preferences.xhtml",
          "zotero-prefs",
          "chrome,titlebar,centerscreen,resizable=yes",
          { pane: "zotero-prefpane-mineru" }
        );
      }
    } catch (err) {
      Zotero.logError(err);
    }
  },

  openDashboard() {
    try {
      const win = Zotero.getMainWindow();
      if (!win) return;
      const selectedItemIDs = ZoteroAdapter.getSelectedItems().map(item => item.id);
      const selectedItemID = selectedItemIDs[0] || null;
      const existing = Services.wm.getMostRecentWindow("zoteromineru:dashboard");
      if (existing && !existing.closed) {
        existing.siSelectedItemID = selectedItemID;
        existing.siSelectedItemIDs = selectedItemIDs;
        existing.siLoadSelection?.(selectedItemIDs);
        existing.focus();
        return;
      }
      win.openDialog(
        "chrome://zoteromineru/content/dashboard.xhtml",
        "zoteromineru-dashboard",
        "chrome,titlebar,centerscreen,resizable=yes",
        { selectedItemID, selectedItemIDs }
      );
    } catch (err) {
      Zotero.logError(err);
    }
  },

  openLibraryChat() {
    const existing = Services.wm.getMostRecentWindow("zoteromineru:library");
    if (existing && !existing.closed) { existing.focus(); return; }
    Zotero.getMainWindow()?.openDialog("chrome://zoteromineru/content/library.xhtml", "zoteromineru-library", "chrome,titlebar,centerscreen,resizable=yes");
  },

  libraryCall(action, payload, onEvent) { return SILibraryChat.call(action, payload, onEvent); },
  stopLibraryTask(id) { SILibraryChat.stop(id); },

  /** 主窗口和条目菜单各保留一个入口，具体操作集中在助手页面。 */
  async onMainWindowLoad(window) {
    const doc = window.document;
    if (!doc) return;
    const itemMenu = doc.getElementById("zotero-itemmenu");
    if (itemMenu && !doc.getElementById("zotero-si-item-dashboard")) {
      const item = this.createXUL(doc, "menuitem");
      item.id = "zotero-si-item-dashboard";
      item.setAttribute("label", "SI 文献助手…");
      item.setAttribute("class", "menuitem-iconic");
      item.setAttribute("image", "chrome://zoteromineru/content/icons/favicon@0.5x.png");
      item.addEventListener("command", () => this.openDashboard());
      itemMenu.appendChild(item);
    }
    const toolsPopup = doc.getElementById("menu_ToolsPopup");
    if (toolsPopup && !doc.getElementById("zotero-si-tools-dashboard")) {
      const item = this.createXUL(doc, "menuitem");
      item.id = "zotero-si-tools-dashboard";
      item.setAttribute("label", "SI");
      item.setAttribute("class", "menuitem-iconic");
      item.setAttribute("image", "chrome://zoteromineru/content/icons/favicon@0.5x.png");
      item.addEventListener("command", () => this.openDashboard());
      toolsPopup.appendChild(item);
    }
  },

  /**
   * 窗口卸载时清理 DOM
   */
  async onMainWindowUnload(window) {
    const doc = window.document;
    if (!doc) return;
    const ids = [
      "zotero-si-item-dashboard",
      "zotero-si-tools-dashboard",
      "zotero-mineru-menu-separator",
      "zotero-mineru-menu-extract",
      "zotero-mineru-menu-ai-analyze",
      "zotero-mineru-menu-pref",
      "zotero-mineru-tools-separator",
      "zotero-mineru-tools-dashboard",
      "zotero-mineru-tools-pref",
      "zotero-mineru-tools-extract",
      "zotero-mineru-tools-ai-analyze"
    ];
    for (const id of ids) {
      const el = doc.getElementById(id);
      if (el) el.remove();
    }
  },

  /**
   * 获取用户当前偏好配置
   */
  getProfiles() {
    const old = {
      provider: Zotero.Prefs.get("extensions.zoteromineru.llmProvider", true) || "deepseek",
      apiBase: Zotero.Prefs.get("extensions.zoteromineru.llmApiBase", true) || "https://api.deepseek.com/v1",
      apiKey: Zotero.Prefs.get("extensions.zoteromineru.llmApiKey", true) || "",
      model: Zotero.Prefs.get("extensions.zoteromineru.llmModel", true) || "deepseek-flash"
    };
    const defaults = [old,
      { provider: "openai", apiBase: "https://api.openai.com/v1", apiKey: "", model: "gpt-4o-mini" },
      { provider: "qwen", apiBase: "https://dashscope.aliyuncs.com/compatible-mode/v1", apiKey: "", model: "qwen-plus" },
      ...Array.from({ length: 5 }, () => ({ provider: "custom", apiBase: "", apiKey: "", model: "" }))];
    let saved;
    try { saved = JSON.parse(Zotero.Prefs.get("extensions.zoteromineru.llmProfiles", true) || "null"); }
    catch (_error) { saved = null; }
    return defaults.map((item, index) => {
      const value = Array.isArray(saved) && saved[index] && typeof saved[index] === "object" ? saved[index] : item;
      return {
        name: String(value.name || `配置 ${index + 1}`),
        provider: String(value.provider || "custom"),
        apiBase: String(value.apiBase || ""),
        apiKey: String(value.apiKey || ""),
        model: String(value.model || "")
      };
    });
  },

  activeProfile() {
    const slot = Number(Zotero.Prefs.get("extensions.zoteromineru.llmActiveProfile", true));
    return Number.isInteger(slot) && slot >= 1 && slot <= 8 ? slot : 1;
  },

  setActiveProfile(slot) {
    if (!Number.isInteger(Number(slot)) || Number(slot) < 1 || Number(slot) > 8) throw new Error("模型配置编号必须为 1 至 8。");
    Zotero.Prefs.set("extensions.zoteromineru.llmActiveProfile", Number(slot), true);
  },

  saveProfile(slot, profile) {
    const index = Number(slot) - 1;
    if (index < 0 || index > 7) throw new Error("无效的模型配置编号。");
    const profiles = this.getProfiles();
    profiles[index] = {
      name: String(profile.name || `配置 ${slot}`).trim().slice(0, 40),
      provider: String(profile.provider || "custom"),
      apiBase: String(profile.apiBase || "").trim(),
      apiKey: String(profile.apiKey || "").trim(),
      model: String(profile.model || "").trim()
    };
    Zotero.Prefs.set("extensions.zoteromineru.llmProfiles", JSON.stringify(profiles), true);
  },

  getUsage() { return LLMUsage.read(); },

  getTaskSettings(type = "reader") {
    let stored;
    try { stored = JSON.parse(Zotero.Prefs.get("extensions.zoteromineru.taskSettings", true) || "{}"); }
    catch (_) { stored = {}; }
    const value = Number(stored?.limits?.[type]);
    return { thinking: stored?.thinking === true,
      maxTokens: [4096, 8192, 16384, 32768].includes(value) ? value : type === "table_summary" ? 16384 : 8192 };
  },

  saveTaskSettings(type, change) {
    if (!["reader", "library", "paper_summary", "table_summary", "auto_highlight"].includes(type)) throw new Error("未知任务类型。");
    let stored;
    try { stored = JSON.parse(Zotero.Prefs.get("extensions.zoteromineru.taskSettings", true) || "{}"); }
    catch (_) { stored = {}; }
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) stored = {};
    if (change.thinking !== undefined) stored.thinking = change.thinking === true;
    if (change.maxTokens !== undefined) {
      const value = Number(change.maxTokens);
      if (![4096, 8192, 16384, 32768].includes(value)) throw new Error("请选择有效的 Token 上限。");
      stored.limits = { ...(stored.limits || {}), [type]: value };
    }
    Zotero.Prefs.set("extensions.zoteromineru.taskSettings", JSON.stringify(stored), true);
    return this.getTaskSettings(type);
  },

  getLastSummaryType() {
    const type = Zotero.Prefs.get("extensions.zoteromineru.lastSummaryType", true);
    return ["paper_summary", "table_summary", "auto_highlight"].includes(type) ? type : "paper_summary";
  },
  saveLastSummaryType(type) {
    if (["paper_summary", "table_summary", "auto_highlight"].includes(type)) Zotero.Prefs.set("extensions.zoteromineru.lastSummaryType", type, true);
  },

  beginTask(id) {
    const Controller = typeof AbortController !== "undefined" ? AbortController : Zotero.getMainWindow().AbortController;
    const controller = new Controller();
    this.taskControllers.set(id, controller);
    return controller.signal;
  },
  cancelTask(id) { this.taskControllers.get(id)?.abort(); },
  finishTask(id) { this.taskControllers.delete(id); },
  isTaskCancelled(error, signal) { return signal?.aborted === true || error?.name === "AbortError" || error?.cancelled === true; },
  checkTaskSignal(signal) {
    if (signal?.aborted) { const error = new Error("任务已暂停；已完成的分段保留，继续时会复用。"); error.name = "AbortError"; throw error; }
  },

  // The bootstrap compartment owns execution. Windows exchange JSON snapshots
  // and subscribe only while open; no window promise or DOM is part of a job.
  getDashboardJob() { return JSON.stringify(this.dashboardJob?.snapshot || null); },
  getDashboardJobResults(id) {
    const job = this.dashboardJob;
    return JSON.stringify(job?.snapshot.id === id ? job.results : { result: null, items: [] });
  },
  subscribeDashboardJob(callback) {
    this.dashboardSubscribers.add(callback);
    try { callback(this.getDashboardJob()); }
    catch (_) { this.dashboardSubscribers.delete(callback); }
    return () => this.dashboardSubscribers.delete(callback);
  },
  publishDashboardJob(job, change = {}) {
    Object.assign(job.snapshot, change);
    job.snapshot.revision++;
    if (this.shuttingDown || this.dashboardJob !== job) return;
    const json = this.getDashboardJob();
    for (const callback of this.dashboardSubscribers) {
      try { callback(json); }
      catch (_) { this.dashboardSubscribers.delete(callback); }
    }
  },
  cancelDashboardJob(id) {
    const job = this.dashboardJob;
    if (!job || job.snapshot.id !== id || job.snapshot.status !== "running") return;
    this.cancelTask(id);
    this.publishDashboardJob(job, { cancelling: true, message: "正在暂停；已完成的分段会保留，稍后可继续任务。" });
  },
  startDashboardJob(inputJSON) {
    if (this.shuttingDown) throw new Error("插件正在关闭，无法启动任务。");
    if (this.dashboardJob?.snapshot.status === "running") throw new Error("已有任务正在后台运行，请等待完成或先暂停。");
    // Parsing here also prevents retention of objects from a closing window.
    const input = JSON.parse(inputJSON);
    const ids = [...new Set((input.ids || []).filter(id => Number.isInteger(id) && id > 0))];
    if (!ids.length) throw new Error("请先在文献列表中选择条目。");
    if (!["summary", "extract"].includes(input.kind)) throw new Error("不支持的任务类型。");
    if (input.kind !== "extract" && !["paper_summary", "table_summary", "auto_highlight"].includes(input.type)) throw new Error("不支持的任务类型。");
    if (input.kind === "extract") ids.splice(1);
    const kind = input.kind === "extract" ? "extract" : ids.length > 1 ? "batch" : "single";
    const id = `dashboard-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const job = { snapshot: { id, kind, ids, type: input.type, status: "running", cancelling: false,
      title: kind === "extract" ? "正在提取 PDF 正文" : kind === "batch" ? "正在批量处理文献" : input.type === "auto_highlight" ? "正在标记文献" : "正在生成总结",
      message: "任务已开始，正在读取文献。", hint: "关闭 SI 窗口后任务会继续运行；重新打开可查看进度，点击“暂停任务”可停止。",
      rows: ids.map(itemID => ({ itemID, status: "queued" })), revision: 0, resultRevision: 0 },
      results: { result: null, items: [] } };
    const signal = this.beginTask(id);
    this.dashboardJob = job;
    // Always start from this compartment's microtask, even if the caller closes
    // its window immediately after the synchronous launch returns.
    this.dashboardRun = Promise.resolve().then(() => this.executeDashboardJob(job, input, signal));
    this.publishDashboardJob(job);
    return this.getDashboardJob();
  },
  retainDashboardResult(job, result, itemEvent = null) {
    // Notes/annotations retain full results. Only the latest previews stay in
    // memory; large batches must not accumulate unbounded rendered content.
    if (itemEvent) {
      job.results.items.push(itemEvent);
      if (job.results.items.length > 50) job.results.items.shift();
    } else job.results.result = result;
    let size = JSON.stringify(job.results).length;
    for (const entry of job.results.items) {
      if (size <= 2 * 1024 * 1024) break;
      if (entry.result) { size -= JSON.stringify(entry.result).length; delete entry.result; entry.previewOmitted = true; }
    }
    job.snapshot.resultRevision++;
  },
  async executeDashboardJob(job, input, signal) {
    const { ids, kind, type, id } = job.snapshot;
    let taskID = null, lastStage = "准备任务";
    const row = (itemID, status) => {
      const entry = job.snapshot.rows.find(entry => entry.itemID === itemID);
      if (entry) entry.status = status;
    };
    const report = message => {
      this.checkTaskSignal(signal);
      lastStage = message;
      if (taskID) this.updateSummaryTask(taskID, { stage: message });
      this.publishDashboardJob(job, { message });
    };
    try {
      const config = input.config || this.getConfig(type), prompt = String(input.prompt || "");
      this.checkTaskSignal(signal);
      if (kind === "batch") {
        const totals = JSON.parse(await this.runBatch(ids, type, config, prompt, json => {
          const event = JSON.parse(json);
          if (event.kind === "progress") {
            row(event.itemID, "running");
            this.publishDashboardJob(job, { message: `[${event.index}/${event.total}] ${event.title}\n${event.message}` });
          } else if (event.kind === "item") {
            row(event.itemID, event.status);
            this.retainDashboardResult(job, null, event);
            this.publishDashboardJob(job);
          }
        }, () => signal.aborted, { id, signal }));
        this.publishDashboardJob(job, {
          status: totals.stopped ? "paused" : totals.failed ? "failed" : totals.partial ? "partial" : "completed",
          title: totals.stopped ? "批处理已停止" : "批处理已结束",
          message: `成功 ${totals.completed} 篇 · 未完成并保存 ${totals.partial || 0} 篇 · 失败 ${totals.failed} 篇 · 重复跳过 ${totals.skipped} 篇 · 未执行 ${totals.stopped} 篇`,
          hint: totals.stopped ? "已保留未完成队列，点击“继续批处理”即可续跑。" : "任务已结束；下方保留最近 50 篇结果预览，已保存的完整内容可在文献中查看。"
        });
        return;
      }
      const item = Zotero.Items.get(ids[0]);
      if (!item || item.deleted) throw new Error("文献不存在或已删除。");
      row(item.id, "running");
      if (kind === "extract") {
        const result = await this.handleExtractMarkdown(item, { id, signal, config, onProgress: report });
        row(item.id, result.ok ? "completed" : result.cancelled ? "stopped" : "failed");
        this.publishDashboardJob(job, { status: result.ok ? "completed" : result.cancelled ? "paused" : "failed",
          title: result.ok ? "正文提取已完成" : result.cancelled ? "提取已取消" : "正文提取失败",
          message: result.message, hint: "任务已结束；如需再次提取，可重新启动。" });
        return;
      }
      const highlight = type === "auto_highlight";
      if (!highlight) this.saveSummaryPrompt(type, prompt);
      taskID = this.startSummaryTask({ title: (item.isAttachment?.() ? item.attachmentFilename : "") || item.getField?.("title") || "未命名文献",
        promptType: type, profileSlot: config.llmSlot, itemID: item.id,
        settings: { thinking: config.llmThinking, maxTokens: config.llmMaxTokens }, prompt });
      report("正在读取文献…");
      let message, incomplete = false;
      if (highlight) {
        const response = JSON.parse(await this.highlightItem(item, report, config, { signal }));
        if (!response.ok) { const error = new Error(response.error || `失败阶段：${lastStage}；底层组件未提供错误详情`); error.cancelled = response.cancelled; throw error; }
        const result = response.result;
        message = result.count ? `已添加 ${result.count} 条高亮，本次标记约占可提取原文的 ${result.percent}%。` : "未新增高亮：没有通过原文、去重及比例检查的候选内容，或已达到标记上限。";
        if (result.emptyPages) message += ` ${result.emptyPages} 页无文字层，仅分析可提取的原文。`;
        this.retainDashboardResult(job, { ...result, message });
        this.updateSummaryTask(taskID, { status: "completed", stage: message });
      } else {
        const result = await this.summarizeItem(item, type, report, config, prompt, { signal });
        this.checkTaskSignal(signal);
        report("正在保存文献笔记…");
        const note = await this.saveSummary(result, { signal });
        incomplete = !!result.incomplete;
        this.updateSummaryTask(taskID, { status: incomplete ? "interrupted" : "completed", stage: incomplete ? "未完成：部分结果已保存" : "文献笔记已保存", noteID: note?.id || null });
        this.retainDashboardResult(job, { markdown: result.markdown, incomplete });
        message = (incomplete ? "未完成：已达到输出上限，部分结果已保存到笔记。" : "总结已生成并保存到当前文献笔记。") + (result.timings ? ` 正文准备 ${(result.timings.extractionMs / 1000).toFixed(1)} 秒${result.timings.cached ? "（复用）" : ""}，模型生成 ${(result.timings.modelMs / 1000).toFixed(1)} 秒。` : "");
      }
      row(item.id, incomplete ? "partial" : "completed");
      this.publishDashboardJob(job, { status: incomplete ? "partial" : "completed", title: incomplete ? "未完成 · 部分结果已保存" : `${highlight ? "文献高亮" : "总结"}已完成`, message, hint: "任务已结束，可以关闭提示查看结果。" });
    } catch (error) {
      const paused = this.isTaskCancelled(error, signal);
      const detail = paused ? "任务已暂停；已完成分段已保留，可在历史任务中点击“继续任务”。" : this.describeError(error);
      const message = paused || detail.includes("失败阶段：") ? detail : `失败阶段：${lastStage}\n原因：${detail}`;
      try { if (taskID) this.updateSummaryTask(taskID, { status: paused ? "interrupted" : "failed", stage: message }); }
      catch (historyError) { try { Zotero.logError(historyError); } catch (_) {} }
      for (const entry of job.snapshot.rows) if (["queued", "running"].includes(entry.status)) entry.status = paused ? "stopped" : "failed";
      this.publishDashboardJob(job, { status: paused ? "paused" : "failed", title: paused ? "任务已暂停" : `${kind === "batch" ? "批处理" : kind === "extract" ? "正文提取" : type === "auto_highlight" ? "文献高亮" : "总结"}失败`, message,
        hint: paused ? "可从历史任务继续；已完成分段会自动复用。" : "任务已停止。解决问题后可重新点击按钮重试。" });
      if (!paused) { try { Zotero.logError(error); } catch (_) {} }
    } finally {
      this.finishTask(id);
    }
  },

  getBatchQueue() {
    try {
      const queue = JSON.parse(Zotero.Prefs.get("extensions.zoteromineru.batchQueue", true) || "{}");
      return Array.isArray(queue?.pendingIDs) ? queue : null;
    } catch (_) { return null; }
  },
  saveBatchQueue(queue) { Zotero.Prefs.set("extensions.zoteromineru.batchQueue", JSON.stringify(queue), true); },

  getSummaryTasks() {
    let data;
    try { data = JSON.parse(Zotero.Prefs.get("extensions.zoteromineru.summaryTasks", true) || "{}"); }
    catch (_error) { data = {}; }
    return {
      items: Array.isArray(data?.items) ? data.items : [],
      totals: { created: 0, completed: 0, failed: 0, interrupted: 0, ...(data?.totals || {}) }
    };
  },

  persistSummaryTasks(data) {
    data.items = data.items.slice(0, 100);
    Zotero.Prefs.set("extensions.zoteromineru.summaryTasks", JSON.stringify(data), true);
  },

  recoverSummaryTasks() {
    const data = this.getSummaryTasks();
    let changed = false;
    for (const item of data.items) {
      if (item.status === "running") {
        item.status = "interrupted";
        item.stage = "Zotero 上次关闭时任务尚未完成";
        item.finishedAt = new Date().toISOString();
        data.totals.interrupted += 1;
        changed = true;
      }
    }
    if (changed) this.persistSummaryTasks(data);
  },

  startSummaryTask({ title, promptType, profileSlot, itemID = null, settings = null, prompt = "" }) {
    const data = this.getSummaryTasks();
    const task = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      title: String(title || "未命名文献").slice(0, 180),
      promptType, profileSlot, status: "running", stage: "等待处理",
      createdAt: new Date().toISOString(), finishedAt: null, noteID: null, itemID, durationMs: null,
      settings, prompt: String(prompt || "")
    };
    data.items.unshift(task);
    data.totals.created += 1;
    this.persistSummaryTasks(data);
    return task.id;
  },

  updateSummaryTask(id, change) {
    const data = this.getSummaryTasks();
    const task = data.items.find((item) => item.id === id);
    if (!task) return;
    if (task.status !== "running") return;
    if (change.status && task.status === "running" && change.status !== "running") {
      if (change.status === "completed") data.totals.completed += 1;
      else if (change.status === "failed") data.totals.failed += 1;
      else if (change.status === "interrupted") data.totals.interrupted += 1;
      task.finishedAt = new Date().toISOString();
      task.durationMs = Math.max(0, Date.parse(task.finishedAt) - Date.parse(task.createdAt));
    }
    for (const key of ["status", "stage", "noteID"]) {
      if (change[key] !== undefined) task[key] = change[key];
    }
    this.persistSummaryTasks(data);
  },

  getSummaryPrompt(type) {
    const key = type === "table_summary" ? "tableSummaryPrompt" : "paperSummaryPrompt";
    return Zotero.Prefs.get(`extensions.zoteromineru.${key}`, true) || LLMClient.PROMPT_TEMPLATES[type];
  },

  saveSummaryPrompt(type, prompt) {
    if (!["paper_summary", "table_summary"].includes(type)) throw new Error("不支持的提示词类型。");
    const value = String(prompt || "").trim();
    if (!value) throw new Error("提示词不能为空。");
    Zotero.Prefs.set(`extensions.zoteromineru.${type === "table_summary" ? "tableSummaryPrompt" : "paperSummaryPrompt"}`, value, true);
  },

  resetSummaryPrompt(type) {
    this.saveSummaryPrompt(type, LLMClient.PROMPT_TEMPLATES[type]);
    return this.getSummaryPrompt(type);
  },

  async testLLM() { return LLMClient.testConnection(this.getConfig()); },

  getHighlightRules() { return AutoHighlight.rules; },
  describeError(error) { return SIError.describe(error); },
  async highlightItem(item, onProgress, config = this.getConfig("auto_highlight"), options = {}) {
    // Transfer a string across the bootstrap/dashboard compartment boundary,
    // rather than relying on native exception properties surviving the boundary.
    try { return JSON.stringify({ ok: true, result: await AutoHighlight.run(item, config, onProgress, options) }); }
    catch (error) { return JSON.stringify({ ok: false, cancelled: this.isTaskCancelled(error, options.signal), error: SIError.describe(error) }); }
  },

  async locateSummaryTask(task) {
    let item = task.itemID && Zotero.Items.get(task.itemID);
    if (!item && task.noteID) item = Zotero.Items.get(task.noteID);
    if (item?.parentID) item = Zotero.Items.get(item.parentID);
    if (!item || item.deleted) throw new Error("对应文献已删除，或旧记录未保存文献关联。");
    const win = Zotero.getMainWindow();
    if (!win?.ZoteroPane) throw new Error("请先打开 Zotero 主窗口。");
    await win.ZoteroPane.selectItem(item.id);
    win.focus();
  },

  getSelectedItem() { return ZoteroAdapter.getSelectedItem(); },
  getSelectedItemIDs() { return ZoteroAdapter.getSelectedItems().map(item => item.id); },
  async runBatch(ids, type, config, prompt, onEvent, shouldStop, options = {}) {
    const id = options.id || `batch-${Date.now()}`;
    const signal = options.signal || this.beginTask(id);
    try { return await SIBatch.run(this, ids, type, config, prompt, onEvent, shouldStop, { signal }); }
    finally { if (!options.signal) this.finishTask(id); }
  },

  renderMarkdown(container, markdown) { MarkdownRenderer.render(container, markdown); },

  async saveSummary(result, { signal } = {}) {
    this.checkTaskSignal(signal);
    if (!result?.targetItem || !result?.markdown) throw new Error("没有可保存的总结。");
    const cacheKey = !result.incomplete && result.checkpointKey;
    const save = async () => {
      this.checkTaskSignal(signal);
      const checkpoint = cacheKey && typeof TaskCheckpointCache !== "undefined" ? await TaskCheckpointCache.get(cacheKey) : null;
      this.checkTaskSignal(signal);
      if (checkpoint?.noteID) {
        const note = Zotero.Items.get(checkpoint.noteID);
        const parentID = result.targetItem.isAttachment?.() ? result.targetItem.parentItemID || null : result.targetItem.id;
        if (note?.isNote?.() && !note.deleted && note.libraryID === result.targetItem.libraryID && (note.parentID || null) === parentID) return note;
      }
      const kind = result.promptType === "table_summary" ? "表格总结" : "文献总结";
      const timing = result.timings ? `**耗时：** 正文准备 ${(result.timings.extractionMs/1000).toFixed(1)} 秒${result.timings.cached ? "（复用缓存）" : ""}；模型生成 ${(result.timings.modelMs/1000).toFixed(1)} 秒\n\n` : "";
      const header = `**文献：** ${result.title}\n\n**生成时间：** ${new Date().toLocaleString("zh-CN")}\n\n${timing}---\n\n`;
      this.checkTaskSignal(signal);
      const note = await ZoteroAdapter.createChildNote(result.targetItem, `${result.incomplete ? "未完成 · " : ""}${kind} · ${result.title}`, header + result.markdown);
      if (checkpoint && note?.id) {
        try { await TaskCheckpointCache.put(cacheKey, { ...checkpoint, noteID: note.id }, { updateNoteID: true }); }
        catch (error) { try { Zotero.logError(error); } catch (_) {} }
      }
      return note;
    };
    if (!cacheKey) return save();
    const previous = this.summarySaveLocks.get(cacheKey) || Promise.resolve();
    const work = previous.catch(() => {}).then(save);
    this.summarySaveLocks.set(cacheKey, work);
    try { return await work; }
    finally { if (this.summarySaveLocks.get(cacheKey) === work) this.summarySaveLocks.delete(cacheKey); }
  },

  getConfig(type = "reader") {
    const slot = this.activeProfile();
    const profile = this.getProfiles()[slot - 1];
    return {
      mineruMode: Zotero.Prefs.get("extensions.zoteromineru.mineruMode", true) || "agent",
      mineruModel: Zotero.Prefs.get("extensions.zoteromineru.mineruModel", true) === "pipeline" ? "pipeline" : "vlm",
      mineruToken: Zotero.Prefs.get("extensions.zoteromineru.mineruToken", true) || "",
      llmSlot: slot,
      llmProvider: profile.provider,
      llmApiBase: profile.apiBase,
      llmApiKey: profile.apiKey,
      llmModel: profile.model,
      llmThinking: this.getTaskSettings(type).thinking,
      llmMaxTokens: this.getTaskSettings(type).maxTokens,
      autoGenerateNote: Zotero.Prefs.get("extensions.zoteromineru.autoGenerateNote", true) !== false,
      autoTag: Zotero.Prefs.get("extensions.zoteromineru.autoTag", true) !== false
    };
  },

  async summarizeItem(item, promptType, onProgress = () => {}, config = this.getConfig(promptType), prompt = this.getSummaryPrompt(promptType), options = {}) {
    this.checkTaskSignal(options.signal);
    if (!["paper_summary", "table_summary"].includes(promptType)) {
      throw new Error("不支持的总结类型。");
    }
    const info = await ZoteroAdapter.getPdfAttachment(item);
    if (!info?.attachmentItem) throw new Error("所选文献没有可读取的 PDF 附件。");
    const targetItem = info.parentItem || item;
    const title = targetItem.getField?.("title") || info.fileName;
    onProgress(`正在处理 PDF：${info.fileName || info.attachmentItem.attachmentFilename || info.attachmentItem.id}`);
    const extractionStarted = Date.now();
    const extracted = await SummaryTextCache.get(info, config, async () => {
      onProgress("正在读取 PDF 正文…");
      let text = "";
      try { text = (await Zotero.PDFWorker.getFullText(info.attachmentItem.id, null))?.text || ""; }
      catch (_error) { /* Fall back to OCR for scanned PDFs. */ }
      this.checkTaskSignal(options.signal);
      if (!text.trim()) {
        if (!info.filePath) throw new Error("此 PDF 没有可读取的本地文件。");
        onProgress("正在使用 MinerU 提取扫描版 PDF（含上传与服务端排队）…");
        const bytes = await ZoteroAdapter.readFileBinary(info.filePath);
        const parsed = await MinerUClient.parsePdf(info.fileName, bytes,
          { mode: config.mineruMode, token: config.mineruToken, model: config.mineruModel, signal: options.signal }, onProgress);
        text = parsed.markdown || "";
      }
      return text;
    }, onProgress, { signal: options.signal });
    this.checkTaskSignal(options.signal);
    const extractionMs = Date.now() - extractionStarted;
    const chunks = Math.ceil(extracted.text.length / 45000);
    onProgress(`正文准备完成（${(extractionMs/1000).toFixed(1)} 秒${extracted.cached ? '，复用缓存' : ''}）；${extracted.text.length.toLocaleString()} 字符${chunks > 1 ? `，需先分析 ${chunks} 段再整合` : ''}。正在等待模型生成…`);
    const modelStarted = Date.now();
    let incomplete = false, checkpointKey = null;
    const progress = this.createUIUpdater(message => { if (!options.signal?.aborted) onProgress(message); });
    let result;
    try {
      result = await LLMClient.analyzePaper(extracted.text, promptType, config, (_delta, full) => {
        progress.push(`AI 正在生成总结（已生成 ${full.length} 字符）…`);
      }, prompt, message => { progress.flush(); onProgress(message); }, () => { incomplete = true; }, {
        ...options, resumeKey: `summary:${info.attachmentItem.libraryID}:${info.attachmentItem.key || info.attachmentItem.id}:${promptType}`,
        onCheckpoint: state => { checkpointKey = state.cacheKey; options.onCheckpoint?.(state); }
      });
      progress.flush();
    } finally { progress.cancel(); }
    this.checkTaskSignal(options.signal);
    const timings = { extractionMs, modelMs: Date.now() - modelStarted, cached: extracted.cached, chunks };
    return { markdown: result, title, targetItem, promptType, timings, incomplete, checkpointKey };
  },

  /**
   * 处理动作 1：仅使用 MinerU 提取并保存 Markdown 笔记
   */
  async handleExtractMarkdown(selectedItem = null, options = {}) {
    const id = options.id || `extract-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const signal = options.signal || this.beginTask(id);
    let notifier;
    const report = message => { this.checkTaskSignal(signal); notifier?.update(message); options.onProgress?.(message); };
    try {
      this.checkTaskSignal(signal);
      notifier = ZoteroAdapter.createProgressNotifier("MinerU 高精文档提取");
      const item = selectedItem || ZoteroAdapter.getSelectedItem();
      if (!item) {
        throw new Error("请先在文献列表中选中需要解析的文献条目或 PDF 附件。");
      }

      report("正在定位目标文献 PDF 文件...");
      const pdfInfo = await ZoteroAdapter.getPdfAttachment(item);
      if (!pdfInfo || !pdfInfo.filePath) {
        throw new Error("选中的条目没有找到关联的 PDF 附件，请确保已下载文献全文。");
      }

      report(`正在读取本地文件: ${pdfInfo.fileName}`);
      const fileBuffer = await ZoteroAdapter.readFileBinary(pdfInfo.filePath);
      this.checkTaskSignal(signal);

      const config = options.config || this.getConfig();
      const parseResult = await MinerUClient.parsePdf(
        pdfInfo.fileName,
        fileBuffer,
        { mode: config.mineruMode, token: config.mineruToken, model: config.mineruModel, signal },
        report
      );

      report("解析成功，正在沉淀为 Zotero 笔记...");
      const targetItem = pdfInfo.parentItem || item;

      if (config.autoGenerateNote) {
        await ZoteroAdapter.createChildNote(
          targetItem,
          `MinerU 文档提取结果: ${pdfInfo.fileName}`,
          parseResult.markdown
        );
      }

      if (config.autoTag) {
        this.checkTaskSignal(signal);
        await ZoteroAdapter.addTagsToItem(targetItem, ["#MinerU-Extracted"]);
      }

      const message = config.autoGenerateNote ? "MinerU 文档提取已成功生成笔记！" : "MinerU 文档提取完成（自动生成笔记已关闭）。";
      notifier.done(message);
      return { ok: true, message };
    } catch (err) {
      const cancelled = this.isTaskCancelled(err, signal);
      const message = cancelled ? "提取已取消；再次提取会重新申请解析。" : `提取失败: ${this.describeError(err)}`;
      if (!cancelled) Zotero.logError(err);
      notifier?.fail(message);
      return { ok: false, cancelled, message };
    } finally { if (!options.signal) this.finishTask(id); }
  },

  /**
   * 处理动作 2：MinerU 提取 + 大模型学术精读
   */
  async handleAiAnalyze(selectedItem = null) {
    const notifier = ZoteroAdapter.createProgressNotifier("MinerU + AI 学术精读");
    try {
      const item = selectedItem || ZoteroAdapter.getSelectedItem();
      if (!item) {
        throw new Error("请先在文献列表中选中需要解析的文献条目或 PDF 附件。");
      }

      notifier.update("正在定位目标文献 PDF 文件...");
      const pdfInfo = await ZoteroAdapter.getPdfAttachment(item);
      if (!pdfInfo || !pdfInfo.filePath) {
        throw new Error("选中的条目没有找到关联的 PDF 附件。");
      }

      notifier.update(`正在读取本地文件: ${pdfInfo.fileName}`);
      const fileBuffer = await ZoteroAdapter.readFileBinary(pdfInfo.filePath);

      const config = this.getConfig();
      const parseResult = await MinerUClient.parsePdf(
        pdfInfo.fileName,
        fileBuffer,
        { mode: config.mineruMode, token: config.mineruToken, model: config.mineruModel },
        (statusMsg) => notifier.update(`[1/2] ${statusMsg}`)
      );

      notifier.update("[2/2] 正在调用学术大模型进行贡献与方法提炼...");
      const targetItem = pdfInfo.parentItem || item;
      const paperTitle = targetItem.getField ? targetItem.getField("title") : pdfInfo.fileName;

      const aiReport = await LLMClient.analyzePaper(
        parseResult.markdown,
        "core_insights",
        config,
        (_delta, full) => {
          notifier.update(`[2/2] AI 思考并生成报告中... (${full.length} 字符)`);
        }
      );

      notifier.update("正在创建学术精读笔记...");
      const combinedMarkdown = `## 【学术精读与贡献提炼报告】\n\n**文献标题**: ${paperTitle}\n\n---\n\n${aiReport}\n\n---\n### 【MinerU 原文高精结构化提取】\n\n${parseResult.markdown}`;

      if (config.autoGenerateNote) {
        await ZoteroAdapter.createChildNote(
          targetItem,
          `AI 学术精读报告: ${paperTitle}`,
          combinedMarkdown
        );
      }

      if (config.autoTag) {
        await ZoteroAdapter.addTagsToItem(targetItem, ["#MinerU-Extracted", "#AI-Analyzed"]);
      }

      notifier.done("AI 学术精读笔记已生成完成！");
    } catch (err) {
      Zotero.logError(err);
      notifier.fail(`学术分析失败: ${err.message}`);
    }
  },

  /**
   * 销毁生命周期
   */
  async destroy() {
    this.shuttingDown = true;
    this.dashboardSubscribers.clear();
    for (const controller of this.taskControllers.values()) controller.abort();
    this.taskControllers.clear();
    if (typeof SummaryTextCache !== "undefined") SummaryTextCache.clear();
    if (typeof SILibraryChat !== "undefined") SILibraryChat.destroy();
    for (const windowType of ["zoteromineru:library", "zoteromineru:dashboard"]) {
      const assistantWindow = Services.wm.getMostRecentWindow(windowType);
      if (assistantWindow && !assistantWindow.closed) assistantWindow.close();
    }
    ReaderChat.unregister();
    // 1. 移除所有打开窗口中的注入 DOM 节点
    try {
      if (typeof Zotero.getMainWindows === "function") {
        for (const win of Zotero.getMainWindows()) {
          this.onMainWindowUnload(win);
        }
      }
    } catch (e) {
      Zotero.logError(e);
    }

    // 2. 注销首选项面板
    if (this.paneId && Zotero.PreferencePanes) {
      try {
        Zotero.PreferencePanes.unregister(this.paneId);
      } catch (e) {
        Zotero.logError(e);
      }
      this.paneId = null;
    }

    this.initialized = false;
    if (Zotero.MinerUAI === this) delete Zotero.MinerUAI;
    Zotero.debug("[MinerU-AI] 插件核心模块已安全销毁");
  }
};

// 挂载至全局 Zotero 命名空间
if (typeof Zotero !== "undefined") {
  Zotero.MinerUAI = ZoteroMinerUAI;
}
