// input: User selection of Zotero literature items, prompt options, LLM profile configuration
// output: Rendered markdown summary, auto-highlight preview, batch queue status, Zotero note persistence
// pos: UI controller and interaction layer for Zotero Superior Intelligence dashboard

(function () {
  "use strict";

  window.addEventListener("load", () => {
    const app = Zotero.MinerUAI;
    document.getElementById("si-library-chat")?.addEventListener("click", () => app.openLibraryChat());
    const args = window.arguments?.[0];
    window.siSelectedItemID = args?.wrappedJSObject?.selectedItemID || args?.selectedItemID || null;
    const status = document.getElementById("mineru-dashboard-status");
    const itemLabel = document.getElementById("mineru-selected-item");
    const resultView = document.getElementById("mineru-dashboard-result");
    const summaryButton = document.getElementById("si-summary");
    const typeField = document.getElementById("si-summary-type");
    const promptField = document.getElementById("si-summary-prompt");
    const profileField = document.getElementById("si-dashboard-profile");
    const thinkingButton = document.getElementById("si-thinking"), outputField = document.getElementById("si-output-limit");
    const limits = { paper_summary: 8192, table_summary: 16384, auto_highlight: 8192 };
    typeField.value = app.getLastSummaryType?.() || typeField.value || "paper_summary";
    let thinking = app.getTaskSettings?.(typeField.value)?.thinking === true;
    const paintThinking = () => { thinkingButton.textContent = thinking ? "思考：开启" : "思考：关闭"; thinkingButton.setAttribute("aria-pressed", String(thinking)); };
    paintThinking();
    thinkingButton.addEventListener("click", () => { thinking = !thinking; app.saveTaskSettings?.(typeField.value, { thinking }); paintThinking(); });
    outputField.addEventListener("change", () => { limits[typeField.value] = Number(outputField.value); app.saveTaskSettings?.(typeField.value, { maxTokens: limits[typeField.value] }); });
    const taskConfig = () => ({ ...app.getConfig(), llmThinking: thinking, llmMaxTokens: limits[typeField.value] || 8192 });
    let busy = false;
    let selection = [], currentJobID = null;
    const selectionRows = new Map();
    const itemTitle = item => (item?.isAttachment?.() ? item.attachmentFilename : "") || item?.getField?.("title");
    const pickedIDs = () => selection.filter(row => row.checked).map(row => row.id);
    const updateSelectionCount = () => {
      const count = pickedIDs().length;
      document.getElementById("si-selection-count").textContent = `已勾选 ${count} / ${selection.length} 篇`;
      if (count > 1) summaryButton.textContent = `批量${typeField.value === "auto_highlight" ? "高亮" : typeField.value === "table_summary" ? "生成表格总结" : "总结"}（${count} 篇）`;
      else summaryButton.textContent = typeField.value === "auto_highlight" ? "为所选文献添加高亮" : "生成并保存到文献笔记";
      summaryButton.disabled = busy || count === 0;
    };
    const html = (tag) => document.createElementNS("http://www.w3.org/1999/xhtml", tag);
    const setText = (node, text) => { if (node.textContent !== text) node.textContent = text; };
    const taskViews = new Map();
    const renderTasks = () => {
      if (window.closed) return;
      const data = app.getSummaryTasks();
      const running = data.items.filter((task) => task.status === "running");
      setText(document.getElementById("si-task-total"), String(data.totals.created));
      setText(document.getElementById("si-task-running"), String(running.length));
      setText(document.getElementById("si-task-completed"), String(data.totals.completed));
      setText(document.getElementById("si-task-failed"), String(data.totals.failed + data.totals.interrupted));
      for (const [containerID, tasks, emptyText] of [
        ["si-task-active-list", running, "当前没有进行中的文献任务。"],
        ["si-task-history-list", data.items.filter((task) => task.status !== "running"), "尚无历史任务。"]
      ]) {
        const container = document.getElementById(containerID);
        let view = taskViews.get(containerID);
        if (!view) { view = { rows: new Map(), order: null }; taskViews.set(containerID, view); }
        if (!tasks.length) {
          if (view.order !== "empty") {
            const label = html("span"); label.className = "si-task-empty"; label.textContent = emptyText;
            container.replaceChildren(); container.append(label); view.order = "empty"; view.rows.clear();
          }
          continue;
        }
        const keys = tasks.map((task, index) => task.id || `${task.createdAt}:${task.itemID}:${index}`);
        const keep = new Set(keys);
        for (const key of view.rows.keys()) if (!keep.has(key)) view.rows.delete(key);
        for (const [index, task] of tasks.entries()) {
          const key = keys[index];
          let entry = view.rows.get(key);
          if (!entry) {
            const row = html("div"), title = html("button"), detail = html("small");
            row.className = "si-task-row"; title.type = "button"; title.className = "si-task-link";
            title.title = "在文献库中定位此文献";
            entry = { row, title, detail, task, resume: null }; view.rows.set(key, entry);
            title.addEventListener("click", async () => {
              try { await app.locateSummaryTask(entry.task); }
              catch (error) { status.textContent = error.message; }
            });
            row.append(title, detail);
          }
          entry.task = task;
          const { row, title, detail } = entry;
          if (row.dataset.status !== task.status) row.dataset.status = task.status;
          if (title.textContent !== task.title) title.textContent = task.title;
          const state = { running: "进行中", completed: task.promptType === "auto_highlight" ? "高亮处理完成" : "已完成并保存笔记", failed: "失败", interrupted: task.noteID ? "未完成 · 部分已保存" : "中断" }[task.status] || task.status;
          const ms = task.durationMs ?? (task.status === "interrupted" ? null : task.finishedAt ? Date.parse(task.finishedAt) - Date.parse(task.createdAt) : Date.now() - Date.parse(task.createdAt));
          const seconds = Math.max(0, Math.round(ms / 1000));
          const elapsed = ms === null || !Number.isFinite(ms) ? "耗时未记录" : `总耗时 ${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
          entry.dateLabel ||= new Date(task.createdAt).toLocaleString("zh-CN");
          const description = `${state} · ${task.promptType === "auto_highlight" ? "文献高亮标记" : task.promptType === "table_summary" ? "表格总结" : "文献总结"} · ${elapsed} · 配置 ${task.profileSlot} · ${entry.dateLabel} · ${task.stage || ""}`;
          if (detail.textContent !== description) detail.textContent = description;
          const resumable = ["interrupted", "failed"].includes(task.status) && task.itemID && ["paper_summary", "table_summary", "auto_highlight"].includes(task.promptType);
          if (resumable && !entry.resume) {
            const resume = html("button"); resume.type = "button"; resume.textContent = "继续任务";
            resume.addEventListener("click", async () => {
              if (busy) return;
              const task = entry.task;
              typeField.value = task.promptType;
              app.saveLastSummaryType?.(task.promptType);
              if (task.profileSlot) app.setActiveProfile(task.profileSlot);
              if (task.settings) app.saveTaskSettings?.(task.promptType, task.settings);
              loadPrompt();
              if (task.prompt && task.promptType !== "auto_highlight") promptField.value = task.prompt;
              window.siLoadSelection([task.itemID]);
              await summarize();
            });
            row.append(resume); entry.resume = resume;
          }
          if (entry.resume) { entry.resume.disabled = busy; entry.resume.hidden = !resumable; }
        }
        const order = JSON.stringify(keys);
        if (view.order !== order) {
          container.replaceChildren(); container.append(...keys.map(key => view.rows.get(key).row));
          view.order = order;
        }
      }
    };
    renderTasks();

    const loadPrompt = () => {
      const saved = app.getTaskSettings?.(typeField.value);
      if (saved) { thinking = saved.thinking; limits[typeField.value] = saved.maxTokens; paintThinking(); }
      outputField.value = String(limits[typeField.value] || 8192);
      const highlight = typeField.value === "auto_highlight";
      promptField.value = highlight ? app.getHighlightRules() : app.getSummaryPrompt(typeField.value);
      promptField.readOnly = highlight;
      document.getElementById("si-prompt-save").hidden = highlight;
      document.getElementById("si-prompt-reset").hidden = highlight;
      document.getElementById("si-highlight-legend").hidden = !highlight;
      summaryButton.textContent = highlight ? "为所选文献添加高亮" : "生成并保存到文献笔记";
      document.getElementById("si-action-help").textContent = highlight
        ? "将按以上规则标记所选文献的 PDF 原句，目标约 5%–15%，宁少勿滥；重复内容会跳过。需要可定位文字层，长文将分组分析并使用当前模型的 Token。"
        : "预设提示词要求中文学术表达；专业术语首次出现可附英文。生成的结果会自动保存为当前文献的子笔记。";
      resultView.dataset.mode = highlight ? "highlight" : "summary";
      updateSelectionCount();
    };
    loadPrompt();
    typeField.addEventListener("change", () => { app.saveLastSummaryType?.(typeField.value); loadPrompt(); });
    document.getElementById("si-prompt-save").addEventListener("click", () => {
      try {
        app.saveSummaryPrompt(typeField.value, promptField.value);
        status.textContent = "提示词已保存。";
      } catch (error) { status.textContent = error.message; }
    });
    document.getElementById("si-prompt-reset").addEventListener("click", () => {
      promptField.value = app.resetSummaryPrompt(typeField.value);
      status.textContent = "已恢复并保存预设提示词。";
    });

    const refresh = () => {
      const firstID = pickedIDs()[0];
      const item = firstID ? Zotero.Items.get(firstID) : null;
      itemLabel.textContent = pickedIDs().length > 1 ? `本次处理 ${pickedIDs().length} 个文献 / PDF` : itemTitle(item) ||
        "未选择文献。请在 Zotero 文献列表中选择条目。";
      const config = app.getConfig();
      profileField.replaceChildren();
      app.getProfiles().forEach((profile, index) => {
        const option = html("option"); option.value = String(index + 1);
        option.textContent = `${profile.name || `配置 ${index + 1}`} · ${profile.model || "未填写模型"}`;
        profileField.append(option);
      });
      profileField.value = String(config.llmSlot);
      document.getElementById("mineru-current-config").textContent =
        `MinerU：${config.mineruMode === "precise" ? `精准模式（${config.mineruModel}）` : "Agent 模式"}；` +
        `模型配置 ${config.llmSlot}：${config.llmModel || "未填写"}；API Key：${config.llmApiKey ? "已填写" : "未填写"}`;
      return item;
    };
    window.siLoadSelection = ids => {
      if (busy) { status.textContent = "队列正在运行，结束后可重新读取文献库选择。"; return; }
      selection = [...new Set(Array.from(ids || []))].filter(Number.isInteger).map(id => ({ id, checked: true }));
      const list = document.getElementById("si-selection-list"); list.replaceChildren(); selectionRows.clear();
      for (const entry of selection) {
        const item = Zotero.Items.get(entry.id);
        const row = html("div"); row.className = "si-selection-row";
        const label = html("label"), checkbox = html("input"), name = html("span"), state = html("small");
        checkbox.type = "checkbox"; checkbox.checked = true;
        name.textContent = itemTitle(item) || `文献 ${entry.id}`;
        state.textContent = "待处理";
        checkbox.addEventListener("change", () => { if (!busy) { entry.checked = checkbox.checked; updateSelectionCount(); refresh(); } });
        label.append(checkbox, name); row.append(label, state); list.append(row);
        selectionRows.set(entry.id, { row, state, checkbox });
      }
      updateSelectionCount(); refresh();
    };
    const initialArgs = args?.wrappedJSObject || args;
    window.siLoadSelection(initialArgs?.selectedItemIDs || (window.siSelectedItemID ? [window.siSelectedItemID] : app.getSelectedItemIDs()));
    document.getElementById("si-selection-refresh").addEventListener("click", () => window.siLoadSelection(app.getSelectedItemIDs()));
    for (const [id, checked] of [["si-selection-all", true], ["si-selection-none", false]]) {
      document.getElementById(id).addEventListener("click", () => {
        if (busy) return;
        selection.forEach(entry => { entry.checked = checked; selectionRows.get(entry.id).checkbox.checked = checked; });
        updateSelectionCount(); refresh();
      });
    }
    profileField.addEventListener("change", () => {
      app.setActiveProfile(Number(profileField.value));
      refresh();
      status.textContent = `已切换到${app.getProfiles()[app.activeProfile() - 1].name}。`;
    });
    window.addEventListener("focus", () => {
      if (!busy) {
        const currentIDs = app.getSelectedItemIDs?.() || [];
        if (currentIDs.length && JSON.stringify(currentIDs) !== JSON.stringify(selection.map(s => s.id))) {
          window.siLoadSelection(currentIDs);
        } else {
          refresh();
        }
        renderTasks();
      }
    });

    const setQueueBusy = value => {
      busy = value;
      document.getElementById("si-dialog-pause").hidden = !value;
      document.getElementById("si-dialog-pause").disabled = !value;
      document.getElementById("si-batch-resume").disabled = value;
      for (const id of ["si-thinking", "si-output-limit", "si-selection-refresh", "si-selection-all", "si-selection-none", "si-summary-type", "si-dashboard-profile", "si-summary-prompt", "si-prompt-save", "si-prompt-reset", "mineru-dashboard-extract"]) document.getElementById(id).disabled = value;
      selectionRows.forEach(row => { row.checkbox.disabled = value; });
      updateSelectionCount();
    };
    const requestPause = () => {
      if (currentJobID) app.cancelDashboardJob(currentJobID);
    };
    document.getElementById("si-batch-stop").addEventListener("click", requestPause);
    document.getElementById("si-dialog-pause").addEventListener("click", requestPause);

    let displayedJobID = null, displayedResultRevision = -1, displayedStatus = null, launching = false;
    const batchResultViews = new Map();
    const stateLabels = { queued: "等待中", running: "处理中", partial: "未完成（已保存）", completed: "已完成", failed: "失败", skipped: "重复跳过", stopped: "已暂停 / 未执行" };
    const renderResults = job => {
      if (displayedResultRevision === job.resultRevision) return;
      displayedResultRevision = job.resultRevision;
      const data = JSON.parse(app.getDashboardJobResults(job.id));
      if (job.kind === "batch") {
        const keep = new Set(data.items.map(event => event.itemID));
        for (const id of batchResultViews.keys()) if (!keep.has(id)) batchResultViews.delete(id);
        for (const event of data.items) {
          const previous = batchResultViews.get(event.itemID);
          if (previous && previous.previewOmitted === !!event.previewOmitted) continue;
          const details = html("details"), heading = html("summary"), message = html("p");
          details.className = "si-batch-result"; details.open = true;
          heading.textContent = `${event.title || `文献 ${event.itemID}`} · ${stateLabels[event.status] || event.status}`;
          message.textContent = event.message + (event.previewOmitted ? " 完整结果请在文献中查看。" : "");
          details.append(heading, message);
          if (event.result?.markdown) { const content = html("div"); app.renderMarkdown(content, event.result.markdown); details.append(content); }
          for (const h of event.result?.highlights || []) {
            const quote = html("blockquote"); quote.textContent = `【${h.category}】第 ${h.pageLabel} 页：${h.text}`; details.append(quote);
          }
          batchResultViews.set(event.itemID, { details, previewOmitted: !!event.previewOmitted });
        }
        resultView.replaceChildren();
        resultView.append(...data.items.map(event => batchResultViews.get(event.itemID).details));
        return;
      }
      resultView.replaceChildren();
      if (data.result?.markdown) {
        app.renderMarkdown(resultView, data.result.markdown);
      } else if (data.result?.highlights) {
        const title = html("p"); title.textContent = data.result.message; resultView.append(title);
        for (const h of data.result.highlights) {
          const entry = html("div"), label = html("strong"), quote = html("blockquote");
          entry.className = "si-highlight-result"; entry.style.borderLeftColor = h.color;
          label.textContent = `【${h.category}】第 ${h.pageLabel} 页`; quote.textContent = h.text;
          entry.append(label, quote); resultView.append(entry);
        }
      }
    };
    const renderJob = json => {
      if (window.closed) return;
      const job = JSON.parse(json);
      if (!job) return;
      const isNew = displayedJobID !== job.id, running = job.status === "running";
      if (isNew) {
        displayedJobID = job.id; displayedResultRevision = -1;
        batchResultViews.clear();
        // Reconnect the view to the exact IDs captured at launch, even when the
        // library selection has changed while this window was closed.
        busy = false;
        if (job.kind !== "extract" && !launching) { typeField.value = job.type; loadPrompt(); }
        window.siLoadSelection(job.ids);
      }
      currentJobID = running ? job.id : null;
      if (isNew || busy !== running) setQueueBusy(running);
      const stop = document.getElementById("si-batch-stop");
      stop.hidden = !running; stop.disabled = !running || job.cancelling;
      document.getElementById("si-dialog-pause").disabled = !running || job.cancelling;
      setText(status, job.message);
      setText(document.getElementById("si-summary-progress"), job.message);
      setText(document.getElementById("si-summary-dialog-title"), job.title);
      setText(document.getElementById("si-summary-dialog-hint"), job.hint);
      for (const entry of job.rows) {
        const view = selectionRows.get(entry.itemID);
        if (!view) continue;
        setText(view.state, stateLabels[entry.status] || entry.status);
        if (view.row.dataset.status !== entry.status) view.row.dataset.status = entry.status;
      }
      renderResults(job); renderTasks(); renderBatchResume();
      const dialog = document.getElementById("si-summary-dialog");
      if ((isNew || displayedStatus === "running" && !running) && !dialog.open) dialog.showModal();
      displayedStatus = job.status;
    };
    const launch = kind => {
      if (busy) return;
      if (!pickedIDs().length) { status.textContent = "请先在文献列表中选择条目。"; return; }
      try {
        launching = true;
        app.startDashboardJob(JSON.stringify({ kind, ids: pickedIDs(), type: typeField.value, config: taskConfig(), prompt: promptField.value }));
      } catch (error) { status.textContent = app.describeError(error); }
      finally { launching = false; }
    };
    const runBatch = () => launch("summary");
    const summarize = () => launch("summary");

    const renderBatchResume = () => {
      const queue = app.getBatchQueue?.();
      const button = document.getElementById("si-batch-resume");
      button.hidden = !queue?.pendingIDs?.length;
      button.disabled = busy;
      if (queue?.pendingIDs?.length) button.textContent = `继续批处理（${queue.pendingIDs.length} 篇）`;
    };
    document.getElementById("si-batch-resume").addEventListener("click", async () => {
      const queue = app.getBatchQueue?.();
      if (busy || !queue?.pendingIDs?.length) return;
      typeField.value = queue.type;
      app.saveLastSummaryType?.(queue.type);
      if (queue.profileSlot) app.setActiveProfile(queue.profileSlot);
      if (queue.settings) app.saveTaskSettings?.(queue.type, queue.settings);
      loadPrompt();
      if (queue.prompt && queue.type !== "auto_highlight") promptField.value = queue.prompt;
      window.siLoadSelection(queue.pendingIDs);
      await runBatch();
    });
    renderBatchResume();
    const unsubscribe = app.subscribeDashboardJob(renderJob);
    window.addEventListener("unload", () => { unsubscribe(); }, { once: true });

    summaryButton.addEventListener("click", summarize);
    document.getElementById("si-summary-dialog-close").addEventListener("click", () => document.getElementById("si-summary-dialog").close());
    document.getElementById("mineru-dashboard-extract").addEventListener("click", () => launch("extract"));
    document.getElementById("mineru-dashboard-preferences").addEventListener("click", () => app.openPreferences());
  }, { once: true });
})();
