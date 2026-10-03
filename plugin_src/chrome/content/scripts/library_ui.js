(function () {
  'use strict';
  window.addEventListener('load', async () => {
    const app = Zotero.MinerUAI, $ = id => document.getElementById('library-' + id);
    const el = (tag, className, text) => { const n = document.createElementNS('http://www.w3.org/1999/xhtml', tag); if (className) n.className = className; if (text != null) n.textContent = text; return n; };
    const labels = { metadata:'元数据', abstract:'摘要', annotation:'高亮原文', comment:'用户批注', aiComment:'AI 高亮分类', note:'用户笔记', aiNote:'AI 笔记' };
    const settings = app.getTaskSettings?.('library') || { thinking: false, maxTokens: 8192 };
    let thinking = settings.thinking === true;
    const paintThinking = () => { $('thinking').textContent = thinking ? '思考：开启' : '思考：关闭'; $('thinking').setAttribute('aria-pressed', String(thinking)); };
    paintThinking();
    $('limit').value = String(settings.maxTokens || 8192);
    if (!$('limit').value) $('limit').value = '8192';
    const saveSettings = () => app.saveTaskSettings?.('library', { thinking, maxTokens: Number($('limit').value) });
    $('thinking').addEventListener('click', () => { thinking = !thinking; paintThinking(); saveSettings(); });
    $('limit').addEventListener('change', saveSettings);
    let busy = false, jobID = null, options = null, selected = [], history = [], contextKey = '';
    const api = async (action, payload = {}, onEvent) => {
      const response = JSON.parse(await app.libraryCall(action, JSON.stringify(payload), onEvent));
      if (!response.ok) throw new Error(response.error); return response.result;
    };
    const errorText = error => app.describeError(error);
    const fill = (select, items, value) => { select.replaceChildren(); for (const item of items) { const option = el('option', '', item.name); option.value = item.id; select.append(option); } if (value != null) select.value = String(value); };
    const refreshSelected = () => {
      const current = selected.filter(s => s.libraryID === Number($('library').value));
      $('selected').textContent = current.length ? `${current.length} 个条目：${current.map(s => s.title).join('、')}` : '当前图书馆没有选中条目。';
    };
    const changeLibrary = () => {
      const library = options.libraries.find(l => l.id === Number($('library').value));
      const names = new Map((library?.collections || []).map(c => [c.id, c]));
      fill($('collection'), (library?.collections || []).map(c => {
        let name = c.name, p = c.parentID, seen = new Set([c.id]);
        while (p && names.has(p) && !seen.has(p)) { seen.add(p); name = names.get(p).name + ' / ' + name; p = names.get(p).parentID; }
        return { id: c.id, name };
      })); refreshSelected();
    };
    const scope = () => ({ libraryID: Number($('library').value), mode: $('mode').value, collectionID: Number($('collection').value), recursive: $('recursive').checked,
      itemIDs: selected.filter(s => s.libraryID === Number($('library').value)).map(s => s.id), from: $('from').value, to: $('to').value, tag: $('tag').value.trim(),
      abstract: $('abstract').checked, annotations: $('annotations').checked, notes: $('notes').checked, aiNotes: $('aiNotes').checked, category: $('category').value });
    const setBusy = value => {
      busy = value;
      for (const control of document.querySelectorAll('#library-controls button, #library-controls input, #library-controls select, #library-thinking, #library-limit, #library-profile, #library-question, #library-ask, #library-overview, #library-stats, #library-clear')) control.disabled = value;
      $('stop').disabled = !value;
    };
    const coverage = stats => {
      const audit = stats.collectionAudit || [];
      $('audit').hidden = !audit.length; $('audit-list').replaceChildren();
      for (const row of audit) $('audit-list').append(el('p', 'muted', `${row.name}：分类内 ${row.total} / 已索引 ${row.indexed} / 筛选后 ${row.afterFilters} 个条目`));
      $('coverage').textContent = `当前范围 ${stats.papers} 篇文献 / ${stats.items} 个条目；${stats.abstracts} 个有摘要，${stats.annotated} 个有注释。所选资料中 ${stats.evidenceItems} 个条目含实质内容，共 ${stats.sources} 段。普通问答只返回关键词命中的部分资料，不代表未引用文献没有索引。`; };
    const locate = async (resultID, ref) => { try { const result = await api('source', { resultID, ref }); if (result.message) $('status').textContent = result.message; } catch (error) { $('status').textContent = errorText(error); } };
    const renderAnswer = (node, result) => {
      app.renderMarkdown(node, result.markdown);
      const refs = new Set(result.sources.map(s => s.ref));
      const walker = document.createTreeWalker(node, window.NodeFilter.SHOW_TEXT), nodes = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);
      for (const text of nodes) {
        const matches = [...text.data.matchAll(/\[(S\d+)\]/g)]; if (!matches.length) continue;
        const fragment = document.createDocumentFragment(); let offset = 0;
        for (const match of matches) {
          fragment.append(document.createTextNode(text.data.slice(offset, match.index)));
          if (refs.has(match[1])) { const button = el('button', 'citation', match[0]); button.title = '定位原始来源'; button.addEventListener('click', () => locate(result.id, match[1])); fragment.append(button); }
          else fragment.append(document.createTextNode('[来源未核实]'));
          offset = match.index + match[0].length;
        }
        fragment.append(document.createTextNode(text.data.slice(offset))); text.replaceWith(fragment);
      }
    };
    const addSources = (article, result) => {
      const details = el('details'), summary = el('summary', '', `资料来源 · ${result.referencedItems} 个条目 / ${result.sources.length} 段（点击定位）`), list = el('div', 'sources');
      details.append(summary, el('p', 'muted', '展开后自动扩大阅读区，可拖动阅读区右下角继续调整高度。点击文献标题定位原始来源。'), list); article.append(details);
      let offset = 0;
      const more = el('button', '', '显示更多来源');
      const append = () => {
        for (const source of result.sources.slice(offset, offset + 40)) {
          const row = el('div', 'source'), button = el('button', '', `[${source.ref}] ${source.title}`);
          button.addEventListener('click', () => locate(result.id, source.ref));
          row.append(button, el('p', 'muted', `${labels[source.kind]}${source.page ? ' · 第 ' + source.page + ' 页' : ''}${source.category ? ' · ' + source.category : ''}`), el('blockquote', '', source.text)); list.append(row);
        }
        offset += 40; more.hidden = offset >= result.sources.length;
      };
      more.addEventListener('click', append); details.append(more);
      details.addEventListener('toggle', () => { if (details.open && offset === 0) append(); });
    };
    const run = async action => {
      if (busy || !options) return;
      const opts = scope(), question = $('question').value.trim();
      if (action === 'ask' && !question) { $('status').textContent = '请输入研究问题。'; return; }
      if (opts.mode === 'selected' && !opts.itemIDs.length) { $('status').textContent = '请先在文献库选择条目，再重新读取选择。'; return; }
      if (opts.mode === 'collection' && !opts.collectionID) { $('status').textContent = '请先选择分类。'; return; }
      const nextKey = JSON.stringify(opts); if (nextKey !== contextKey) { history = []; contextKey = nextKey; }
      jobID = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      setBusy(true); $('status').textContent = '正在准备本地资料…';
      let article, answer;
      if (action !== 'index') {
        $('empty').hidden = true; article = el('article'); answer = el('div', 'answer', '正在整理资料…');
        article.append(el('div', 'question', question || (action === 'overview' ? '概括当前范围的研究方向、发现与空白' : '统计当前筛选范围')), answer); $('conversation').append(article);
        article.scrollIntoView({ block:'nearest' });
      }
      try {
        const result = await api(action, { id: jobID, options: opts, question, profileSlot: Number($('profile').value), thinking, maxTokens: Number($('limit').value), history }, json => {
          if (window.closed) return;
          const event = JSON.parse(json);
          if (event.kind === 'progress') $('status').textContent = event.text;
          if (event.kind === 'scope') coverage(event.stats);
          if (event.kind === 'answer' && answer) answer.textContent = event.text;
        });
        if (action === 'index') { coverage(result); $('status').textContent = '本地索引已更新，未调用模型。'; return; }
        renderAnswer(answer, result); addSources(article, result);
        if (result.matchedItems != null) article.append(el("p", "muted", `所选范围 ${result.stats.items} 个条目；关键词匹配 ${result.matchedItems} 个；本轮实际提供 ${result.referencedItems} 个条目的资料。`));
        const tokens = result.usage.total > 1000 ? (result.usage.total / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : result.usage.total;
        article.append(el('p', 'muted', `${action === 'overview' ? '范围综述' : action === 'stats' ? '本地统计' : '检索问答'} · ${(result.durationMs/1000).toFixed(1)} 秒 · ${tokens} Token${result.usage.unreported ? '（部分请求未返回用量）' : ''}${result.cachedBatches ? ' · 复用 ' + result.cachedBatches + ' 批' : ''}`));
        if (result.invalidCitations) article.append(el('p', 'muted', '模型返回了无效来源编号，已标注“来源未核实”。'));
        const save = el('button', '', result.incomplete ? '保存未完成结果' : '保存为笔记'); article.append(save);
        save.addEventListener('click', async () => { save.disabled = true; try { await api('save', { resultID: result.id }); save.textContent = '已保存到图书馆'; } catch (error) { save.disabled = false; $('status').textContent = errorText(error); } });
        if (action !== 'stats') {
          const cited = new Set([...result.markdown.matchAll(/\[(S\d+)\]/g)].map(m => m[1]));
          const priorSources = [...result.sources.filter(s => cited.has(s.ref)), ...result.sources.filter(s => !cited.has(s.ref))];
          history.push({ question, scopeKey: nextKey, summary: result.markdown.replace(/\[(?:S\d+|来源未核实)\]/g, '').slice(0, 1600), sources: priorSources.slice(0, 30).map(s => ({ sourceID: s.sourceID, itemID: s.itemID, uid: s.uid })) });
          history = history.slice(-2);
        }
        $('status').textContent = result.incomplete ? '未完成：输出触及上限，部分结果已保留，可保存为笔记。未自动续写。' : '已完成。来源编号和来源列表均可点击定位。';
      } catch (error) {
        const message = errorText(error);
        $('status').textContent = message;
        if (answer) { answer.textContent = '本次任务未完成：' + message; }
      } finally { jobID = null; setBusy(false); }
    };
    $('library').addEventListener('change', changeLibrary);
    $('mode').addEventListener('change', () => { $('collection-box').hidden = $('mode').value !== 'collection'; $('selection-box').hidden = $('mode').value !== 'selected'; });
    $('selection').addEventListener('click', async () => { try { const next = await api('options'); selected = next.selected; refreshSelected(); } catch (error) { $('status').textContent = errorText(error); } });
    for (const action of ['index','ask','overview','stats']) $(action).addEventListener('click', () => run(action));
    $('stop').addEventListener('click', () => { if (jobID) app.stopLibraryTask(jobID); $('stop').disabled = true; $('status').textContent = '正在停止…'; });
    $('settings').addEventListener('click', () => app.openPreferences());
    $('clear').addEventListener('click', () => { for (const article of $('conversation').querySelectorAll('article')) article.remove(); history = []; $('empty').hidden = false; });
    $('question').addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); run('ask'); } });
    window.addEventListener('unload', () => { if (jobID) app.stopLibraryTask(jobID); });
    setBusy(true);
    try {
      options = await api('options'); selected = options.selected;
      fill($('library'), options.libraries, options.defaultLibrary);
      fill($('profile'), options.profiles.map(p => ({ id:p.slot, name:`${p.name || '配置 ' + p.slot} · ${p.model || '未配置'}` })), options.activeProfile);
      changeLibrary();
    } catch (error) { $('status').textContent = errorText(error); }
    finally { setBusy(false); }
  });
})();
