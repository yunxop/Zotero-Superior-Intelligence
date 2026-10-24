(function () {
  "use strict";
  window.addEventListener("load", async () => {
    const app = Zotero.MinerUAI, api = app.writingKnowledge, $ = id => document.getElementById("writing-" + id);
    const node = (tag, text) => { const n = document.createElementNS("http://www.w3.org/1999/xhtml", tag); if (text != null) n.textContent = text; return n; };
    let selection = [], disposed = false, searching = false, offset = 0;
    let visibleRecords = [], selected = new Set(), lastDeleted = [], extractionTopicID = "", scopeLabel = "";
    const status = text => { if (!disposed) $("status").textContent = text; };
    const safe = action => async () => { try { await action(); } catch (e) { status(e.message || String(e)); } };
    const config = api.config(); $("key").value = config.key; $("model").value = config.model;
    let collecting = false;
    const select = async () => {
      if (collecting) return;
      collecting = true; selection = []; $("select").disabled = true; $("scope").disabled = true; $("start").disabled = true;
      $("selection").textContent = "正在汇总分类并检查 PDF 附件…";
      try {
        const result = await api.collectScope($("scope").value);
        if (disposed) return;
        selection = Array.from(result.itemIDs); scopeLabel = result.label;
        $("selection").textContent = `${result.label}：${selection.length} 个 PDF（已去重），${result.skipped} 篇无可用 PDF 已跳过。此范围已固定；改变 Zotero 选择后请重新读取。`;
      } catch (error) {
        if (!disposed) $("selection").textContent = "未读取范围，请重新选择并读取。";
        throw error;
      } finally {
        collecting = false;
        if (!disposed) { $("select").disabled = false; $("scope").disabled = false; $("start").disabled = api.snapshot().running || !selection.length; }
      }
    };
    const filters = () => ({ status: $("status-filter").value, kind: $("kind").value, section: $("section").value, topicId: $("history").value });
    const copy = async text => {
      if (!text) throw new Error("请先选择需要复制的记录。");
      if (typeof Components !== "undefined") Components.classes["@mozilla.org/widget/clipboardhelper;1"].getService(Components.interfaces.nsIClipboardHelper).copyString(text);
      else await navigator.clipboard.writeText(text);
      status("已复制，可粘贴到 Word、笔记或其他编辑器。");
    };
    const remove = async ids => {
      if (!ids.length) throw new Error("请先选择需要删除的记录。");
      await api.remove(ids); lastDeleted = ids; $("undo").disabled = false;
      offset = 0; await search(); status(`已删除 ${ids.length} 条记录，可撤销。已有笔记快照保持不变。`);
    };
    const loadTopics = async () => {
      const current = $("history").value, topics = await api.topics({state:'active',query:$("topic-query").value,limit:20,sort:'recent'});
      if (current && !topics.some(t=>t.id===current)) {
        try { const t=await api.topicGet(current); if(!t.deletedAt && !t.mergedInto) topics.unshift({...t,topic:t.name,count:null}); } catch (_) {}
      }
      if (disposed) return;
      const all = node("option", "全部主题"); all.value = "";
      $("history").replaceChildren(all);
      for (const entry of topics) { const option = node("option", `${entry.pinned ? "★ " : ""}${entry.name || entry.topic}${entry.count == null ? "" : `（${entry.count} 条）`}`); option.value = entry.id; $("history").append(option); }
      if (topics.some(t => t.id === current)) $("history").value = current;
    };
    const labels = { explanation: "中文解释", pattern: "句式结构", technique: "写作技巧", conclusion: "研究结论", method: "研究方法", quantitativeResult: "定量结果", support: "支持证据", limitations: "研究局限" };
    const render = records => {
      visibleRecords = records; selected.clear(); $("select-all").checked = false;
      $("results").replaceChildren();
      for (const r of records) {
        const card = node("article"); card.className = "card";
        const choice = node("input"); choice.type = "checkbox"; choice.dataset.recordId = r.id; choice.setAttribute("aria-label", "选择记录");
        choice.addEventListener("change", () => {
          if (choice.checked) selected.add(r.id); else selected.delete(r.id);
          $("select-all").checked = records.length > 0 && selected.size === records.length;
        }); card.append(choice);
        const copyQuote = node("button", "复制原句"); copyQuote.addEventListener("click", safe(() => copy(r.quote))); card.append(copyQuote);
        const copySource = node("button", "复制原句及来源"); copySource.addEventListener("click", safe(() => copy(`${r.quote}\n${r.source.title} · DOI: ${r.source.doi || "未提供"} · PDF 第 ${r.source.page} 页`))); card.append(copySource);
        const deleteButton = node("button", "从知识库删除记录"); deleteButton.addEventListener("click", safe(() => remove([r.id]))); card.append(deleteButton);
        card.append(node("h2", `${r.kind === "evidence" ? "科学证据" : "英文表达"} · ${r.section} · ${{pending:"待审核",approved:"已通过",rejected:"已拒绝"}[r.status]}`), node("blockquote", r.quote));
        card.append(node("p", `${r.source.title} · DOI: ${r.source.doi || "未提供"} · 页 ${r.source.pageLabel}（PDF ${r.source.page}） · 段落 ${r.source.paragraph}`));
        card.append(node("p", `主题：${(r.topics || [r.topic]).join("；")} · 相关性：${Math.round(r.relevance*100)}% · 借鉴价值：${r.valueScore}/100`));
        const locate = node("button", "打开原文所在页"); locate.addEventListener("click", safe(async () => {
          const attachment = Zotero.Items.get(r.source.attachmentID);
          if (!attachment || attachment.deleted || attachment.key !== r.source.attachmentKey || attachment.libraryID !== r.source.libraryID) throw new Error("原始附件已删除或不在当前库中。");
          await Zotero.Reader.open(attachment.id, { pageIndex: r.source.page-1 });
        })); card.append(locate);
        const detail = node("details"), summary = node("summary", "查看 / 修订提取内容"); detail.append(summary);
        const editors = {};
        for (const [key, value] of Object.entries(r.details)) {
          const label = node("label", labels[key] || key), input = node("textarea"); input.value = value; input.maxLength = 5000;
          label.append(input); detail.append(label); editors[key] = input;
        }
        card.append(detail);
        const review = node("textarea"); review.placeholder = "人工审核备注"; review.value = r.reviewerNote; review.maxLength = 5000;
        review.setAttribute("aria-label", "人工审核备注"); card.append(review);
        for (const [value, label] of [["approved","保存并通过"],["rejected","保存并拒绝"],["pending","保存为待审核"]]) {
          const button = node("button", label); button.addEventListener("click", safe(async () => {
            button.disabled = true;
            try { await app.reviewWritingRecord(r.id, value, review.value, Object.fromEntries(Object.entries(editors).map(([k,v]) => [k,v.value]))); await search(); }
            finally { button.disabled = false; }
          })); card.append(button);
        }
        $("results").append(card);
      }
    };
    const search = async () => {
      if (searching) return; searching = true; $("search").disabled = true;
      try {
        await loadTopics();
        const result = await api.search({ ...filters(), query: $("query").value, semantic: $("search-semantic").checked, limit: 100, offset });
        if (disposed) return;
        $("prev").disabled = offset === 0; $("next").disabled = offset+100 >= result.total;
        render(result.records); $("count").textContent = `共 ${result.total} 条，当前第 ${Math.floor(offset/100)+1} 页，显示 ${result.records.length} 条。`;
      } finally { searching = false; if (!disposed) $("search").disabled = false; }
    };
    const chooseTopic = async topic => {
      extractionTopicID=topic.id; $("topic").value=topic.name; $("topic").readOnly=true; $("instruction").value=topic.instruction || topic.name;
      $("topic-active").textContent=`现有主题：${topic.name}（使用固定 ID，默认指令可在主题管理修改）`;
      const option=node('option',topic.name);option.value=topic.id;$("history").append(option);$("history").value=topic.id;
      offset=0; await search(); $("manager").hidden=true;$("workspace").hidden=false;
    };
    const manager = SIWritingTopicUI(window,api,chooseTopic,async()=>{
      if(extractionTopicID) {
        const t=await api.topicGet(extractionTopicID);
        if(t.deletedAt||t.mergedInto) {extractionTopicID='';$("topic").readOnly=false;$("topic").value='';$("topic-active").textContent='请选择或新建主题';}
        else { $("topic").value=t.name; $("instruction").value=t.instruction; }
      }
      await search();
    });
    $("manage").addEventListener('click',safe(()=>manager.open()));
    $("find-topic").addEventListener('click',safe(async()=>{$("history").value='';offset=0;await search();}));
    $("new-topic").addEventListener('click',()=>{extractionTopicID='';$("topic").readOnly=false;$("topic").value='';$("instruction").value='';$("topic-active").textContent='新主题：开始时自动创建';$("topic").focus();});
    $("target-find").addEventListener('click',safe(async()=>{
      const result=await api.topicList({state:'all',query:$("target-query").value,limit:30});$("target").replaceChildren();
      for(const t of result.topics){const option=node('option',t.name);option.value=t.id;$("target").append(option);}
    }));
    for(const [id,mode] of [['unlink-selected','unlink'],['link-selected','link'],['move-selected','move']]) $(id).addEventListener('click',safe(async()=>{
      if(!selected.size)throw Error('请先选择记录。');
      if(mode!=='link'&&!$("history").value)throw Error('请先选择当前主题。');
      if(mode!=='unlink'&&!$("target").value)throw Error('请先查找目标主题。');
      await api.recordTopics([...selected],$("history").value,$("target").value,mode);await search();status('记录的主题关联已更新，原文和审核状态保持不变。');
    }));
    let wasRunning = api.snapshot().running;
    const update = snapshot => {
      if (disposed) return;
      $("start").disabled = snapshot.running || collecting || !selection.length; $("stop").disabled = !snapshot.running;
      status(snapshot.message + (snapshot.failures.length ? "\n" + snapshot.failures.map(f => `条目 ${f.itemID}：${f.error}`).join("\n") : ""));
      if (wasRunning && !snapshot.running) safe(search)();
      wasRunning = snapshot.running;
    };
    api.listeners.add(update); update(api.snapshot());
    window.addEventListener("unload", () => { disposed = true; api.listeners.delete(update); }, { once: true });
    $("history").addEventListener("change", safe(async () => { offset = 0; if($("history").value) await chooseTopic(await api.topicGet($("history").value)); else await search(); }));
    $("select-all").addEventListener("change", () => {
      selected = new Set($("select-all").checked ? visibleRecords.map(r => r.id) : []);
      for (const box of $("results").querySelectorAll("input[data-record-id]")) box.checked = selected.has(box.dataset.recordId);
    });
    $("copy-selected").addEventListener("click", safe(() => copy(visibleRecords.filter(r => selected.has(r.id)).map(r => r.quote).join("\n\n"))));
    $("delete-selected").addEventListener("click", safe(() => remove([...selected])));
    $("undo").addEventListener("click", safe(async () => {
      if (!lastDeleted.length) return;
      await api.restore(lastDeleted); lastDeleted = []; $("undo").disabled = true; offset = 0; await search(); status("已恢复上次删除的记录。");
    }));
    $("scope").addEventListener("change", () => {
      selection = []; $("start").disabled = true; $("selection").textContent = "范围已改变，请点击“读取 Zotero 当前范围”。";
    });
    $("select").addEventListener("click", safe(select));
    $("save").addEventListener("click", safe(() => { api.configure($("key").value, $("model").value); status("Voyage 设置已保存。"); }));
    $("start").addEventListener("click", safe(async () => {
      await api.start({ itemIDs: selection, topic: $("topic").value, topicId:extractionTopicID, instruction:$("instruction").value, scopeLabel, semantic: $("semantic").checked, limit: Number($("limit").value), threshold: Number($("threshold").value), notes: $("notes").checked }); update(api.snapshot());
    }));
    $("stop").addEventListener("click", () => api.stop());
    $("search").addEventListener("click", safe(() => { offset = 0; return search(); }));
    $("prev").addEventListener("click", safe(() => { if (searching) return; offset = Math.max(0, offset-100); return search(); }));
    $("next").addEventListener("click", safe(() => { if (searching) return; offset += 100; return search(); }));
    for (const format of ["markdown", "jsonl", "training"]) $(format).addEventListener("click", safe(async () => {
      const path = await api.export(format, filters()); status("已导出：" + path); Zotero.File.reveal(path);
    }));
    await safe(select)(); await safe(search)();
  });
})();
