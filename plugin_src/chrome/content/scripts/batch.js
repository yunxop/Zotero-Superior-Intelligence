// Serial queue: freeze item IDs/configuration; each document has independent history.
var SIBatch = {
  running: false,
  async run(app, ids, type, config, prompt, onEvent = () => {}, shouldStop = () => false, { signal } = {}) {
    if (this.running) throw new Error("已有批处理正在运行，请等待当前队列结束。");
    if (!["paper_summary", "table_summary", "auto_highlight"].includes(type)) throw new Error("不支持的批处理类型。");
    const queue = [...new Set(Array.from(ids).filter(Number.isInteger))];
    if (!queue.length) throw new Error("请至少勾选一篇文献。");
    this.running = true;
    const snapshot = { ...config };
    const totals = { total: queue.length, completed: 0, partial: 0, failed: 0, skipped: 0, stopped: 0 };
    const seenPDFs = new Set();
    const savedQueue = { pendingIDs: [...queue], type, profileSlot: snapshot.llmSlot,
      settings: { thinking: snapshot.llmThinking === true, maxTokens: snapshot.llmMaxTokens || (type === "table_summary" ? 16384 : 8192) },
      prompt: String(prompt || ""), status: "running", updatedAt: new Date().toISOString() };
    const persist = () => { savedQueue.updatedAt = new Date().toISOString(); app.saveBatchQueue?.(savedQueue); };
    const completed = itemID => { savedQueue.pendingIDs = savedQueue.pendingIDs.filter(id => id !== itemID); persist(); };
    const emit = event => { try { onEvent(JSON.stringify(event)); } catch (error) { try { Zotero.logError(error); } catch (_) {} } };
    const stop = () => { try { return signal?.aborted || shouldStop(); } catch (_) { return true; } };
    try {
      persist();
      if (type !== "auto_highlight") app.saveSummaryPrompt(type, prompt);
      for (let i = 0; i < queue.length; i++) {
        const itemID = queue[i];
        if (stop()) {
          totals.stopped = queue.length - i;
          for (const id of queue.slice(i)) emit({ kind: "item", itemID: id, status: "stopped", message: "未执行（队列已停止）" });
          break;
        }
        let taskID = null, stage = "检查 PDF 附件", title = `文献 ${itemID}`;
        const started = Date.now();
        try {
          const item = Zotero.Items.get(itemID);
          if (!item || item.deleted) throw new Error("文献不存在或已删除。");
          title = item.getField?.("title") || item.attachmentFilename || title;
          emit({ kind: "progress", itemID, index: i + 1, total: queue.length, title, message: stage });
          const info = await ZoteroAdapter.getPdfAttachment(item);
          if (!info?.attachmentItem || !info.filePath) throw new Error("没有可读取的本地 PDF 附件。");
          if (seenPDFs.has(info.attachmentItem.id)) {
            totals.skipped++; completed(itemID);
            emit({ kind: "item", itemID, title, status: "skipped", message: "同一 PDF 已在本队列中处理，跳过重复条目。" });
            continue;
          }
          seenPDFs.add(info.attachmentItem.id);
          taskID = app.startSummaryTask({ title, promptType: type, profileSlot: snapshot.llmSlot, itemID: item.parentID || item.id, settings: savedQueue.settings, prompt });
          const report = message => {
            stage = message;
            app.updateSummaryTask(taskID, { stage: message });
            emit({ kind: "progress", itemID, index: i + 1, total: queue.length, title, message });
          };
          let result, noteID = null, message, incomplete = false;
          if (type === "auto_highlight") {
            const response = JSON.parse(await app.highlightItem(info.attachmentItem, report, snapshot, { signal }));
            if (!response.ok) { const error = new Error(response.error || "高亮失败，未返回错误详情。"); error.cancelled = response.cancelled; throw error; }
            result = response.result;
            message = `新增 ${result.count} 条高亮，占原文 ${result.percent}%。` + (result.emptyPages ? ` ${result.emptyPages} 页无文字层。` : "");
          } else {
            const summary = await app.summarizeItem(info.attachmentItem, type, report, snapshot, prompt, { signal });
            app.checkTaskSignal?.(signal);
            report("正在保存文献笔记…");
            const note = await app.saveSummary(summary, { signal });
            noteID = note?.id || null;
            incomplete = !!summary.incomplete;
            result = { markdown: summary.markdown, incomplete };
            message = type === "table_summary" ? "表格总结已保存到该文献笔记。" : "文献总结已保存到该文献笔记。";
          }
          if (incomplete) message = "未完成：触及输出上限，部分结果已保存到笔记。";
          app.updateSummaryTask(taskID, { status: incomplete ? "interrupted" : "completed", stage: message, noteID });
          if (incomplete) totals.partial++; else { totals.completed++; completed(itemID); }
          emit({ kind: "item", itemID, title, status: incomplete ? "partial" : "completed", message, result, durationMs: Date.now() - started });
        } catch (error) {
          if (signal?.aborted || error?.name === "AbortError" || error?.cancelled) {
            const message = "任务已暂停；已完成分段保留，继续批处理时自动复用。";
            try { if (taskID !== null) app.updateSummaryTask(taskID, { status: "interrupted", stage: message }); } catch (_) {}
            totals.stopped = queue.length - i;
            emit({ kind: "item", itemID, title, status: "stopped", message, durationMs: Date.now() - started });
            for (const id of queue.slice(i + 1)) emit({ kind: "item", itemID: id, status: "stopped", message: "尚未执行，可继续批处理。" });
            break;
          }
          const detail = app.describeError(error);
          const message = detail.includes("失败阶段：") ? detail : `失败阶段：${stage}\n原因：${detail}`;
          if (taskID === null) {
            try { taskID = app.startSummaryTask({ title, promptType: type, profileSlot: snapshot.llmSlot, itemID }); } catch (_) {}
          }
          try { if (taskID !== null) app.updateSummaryTask(taskID, { status: "failed", stage: message }); } catch (_) {}
          totals.failed++;
          emit({ kind: "item", itemID, title, status: "failed", message, durationMs: Date.now() - started });
        }
      }
      savedQueue.status = savedQueue.pendingIDs.length ? totals.stopped ? "paused" : "unfinished" : "completed";
      persist();
      emit({ kind: "done", ...totals });
      return JSON.stringify(totals);
    } finally { this.running = false; if (savedQueue.status === "running") { savedQueue.status = "paused"; persist(); } }
  }
};
