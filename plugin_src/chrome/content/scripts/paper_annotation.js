// Build a self-contained bilingual reading attachment from verified PDF text.
var SIPaperAnnotation = {
  defaultPrompt: `采用流畅的中文学术表达逐段意译，保留数据、限定语和引文。
批注应说明段落功能、它在全文论证链中的位置，以及具体的论证技巧或潜在漏洞。区分作者明确陈述的内容与可推断的解释。
挑出支撑论证的关键短语，优先标记核心论点、关键概念、实证证据、让步或反驳、方法论。
总览交代研究问题、论点、证据、反驳与结论的联系，用一句话概括作者主张，并分别指出有具体依据的最强与最弱之处。`,
  categories: {
    thesis: "核心论点 / Thesis",
    concept: "关键概念 / 术语",
    evidence: "实证证据 / 数据",
    rebuttal: "让步 / 反驳",
    method: "方法论"
  },
  overviewFields: {
    question: "问题", thesis: "论点", evidence: "证据", rebuttal: "反驳", conclusion: "结论",
    claim: "作者核心主张", strength: "论证最强处", weakness: "论证最弱处"
  },
  heading(content, markdown) {
    const markdownHeading = markdown && content.match(/^#{1,6}\s+(.+?)(?:\s+#+)?$/);
    const bare = content.replace(/^(?:(?:\d+(?:\.\d+)*\.?|[IVX]+\.)\s+)/i, "");
    const standard = /^(?:abstract|summary|keywords:?|introduction|background|related work|literature review|theoretical framework|methods?|methodology|materials and methods|experimental (?:setup|design|procedures)|results?(?: and discussion)?|discussion|limitations|conclusions?(?: and (?:future work|outlook))?|acknowledg(?:e)?ments?|references|bibliography|supplementary materials?|appendix(?: [A-Z0-9]+)?|data availability|author contributions|CRediT authorship contribution statement|declarations|funding|(?:declaration of )?(?:competing interests?|conflicts? of interest))$/i.test(bare);
    const numbered = bare !== content && bare.length <= 100 && /^[A-Z][\p{L}\p{N} '&(),/–-]*$/u.test(bare);
    return markdownHeading?.[1] || ((standard || numbered) ? content : "");
  },
  ancillary(title) {
    return /^(?:前置信息|keywords:?|references|bibliography|acknowledg(?:e)?ments?|author contributions|CRediT authorship contribution statement|declarations|funding|(?:declaration of )?(?:competing interests?|conflicts? of interest))$/i
      .test(title.replace(/^(?:(?:\d+(?:\.\d+)*\.?|[IVX]+\.)\s+)/i, ""));
  },
  pageLabel(text) {
    return /^(?:page|p\.)\s+\d{1,5}(?:\s*(?:of|\/)\s*\d{1,5})?$/i.test(text);
  },
  publisherLine(text) {
    return /^(?:contents lists available at|journal homepage:)\s+.{1,120}$/i.test(text) ||
      /^available online .{0,90}(?:all rights reserved|©).{0,80}$/i.test(text);
  },
  sections(raw, markdown = false) {
    const sections = [{ title: "前置信息", paragraphs: [] }];
    let lines = [];
    const flush = () => {
      if (!lines.length) return;
      sections.at(-1).paragraphs.push(lines.join(" "));
      lines = [];
    };
    for (const line of raw.split(/\r?\n/)) {
      let content = line.trim();
      if (markdown) {
        content = content.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
          .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").trim();
      }
      if (this.pageLabel(content) || this.publisherLine(content)) continue;
      const heading = this.heading(content, markdown);
      if (heading) {
        flush();
        sections.push({ title: heading, paragraphs: [] });
      } else if (!content) {
        flush();
      } else {
        lines.push(content);
      }
    }
    flush();
    // Keep headings with no immediate prose (for example, a parent section
    // followed immediately by a subsection) in both the document and its nav.
    return sections.filter((section, index) => index || section.paragraphs.length);
  },
  pageLines(page) {
    const lines = [];
    let text = "", first = null;
    for (const char of page.chars) {
      if (!char.ignorable) {
        text += char.c || "";
        if (!first && !char.rotation && char.c?.trim() && AutoHighlight.rectOK(char.rect)) first = char.rect;
      }
      if (char.paragraphBreakAfter || char.lineBreakAfter) {
        lines.push({ text, first, paragraphEnd: char.paragraphBreakAfter });
        text = "";
        first = null;
      } else if (char.spaceAfter) text += " ";
    }
    if (text) lines.push({ text, first });
    return lines;
  },
  textFromLines(lines) {
    return lines.map((line, index) => {
      const next = lines[index + 1];
      return line.text + (line.paragraphEnd || this.hasParagraphGap(line, next) ? "\n\n" : "\n");
    }).join("").trim();
  },
  marginSide(line, viewBox) {
    if (!line.first || !viewBox) return "";
    const height = viewBox[3] - viewBox[1];
    const margin = Math.min(56, height * .07);
    const center = (line.first[1] + line.first[3]) / 2;
    if (center >= viewBox[3] - margin) return "top";
    if (center <= viewBox[1] + margin) return "bottom";
    return "";
  },
  cleanPDF(pages) {
    const markedPages = pages.map((page, index) => this.pageLines(page).map(line => {
      const text = line.text.trim().replace(/\s+/gu, " ");
      const side = this.marginSide(line, page.viewBox);
      const pageNumber = side && (text === String(index + 1) || (page.label && text === String(page.label)));
      const fingerprint = side && text && text.length <= 140 && !this.heading(text, false)
        ? side + ":" + text.toLowerCase() : "";
      return { ...line, fingerprint, discard: pageNumber || this.pageLabel(text) || this.publisherLine(text) };
    }));
    const marginCounts = new Map();
    for (const page of markedPages) {
      for (const key of new Set(page.map(line => line.fingerprint).filter(Boolean))) {
        marginCounts.set(key, (marginCounts.get(key) || 0) + 1);
      }
    }
    let text = "";
    for (const page of markedPages) {
      const next = this.textFromLines(page.filter(line => !line.discard && !(marginCounts.get(line.fingerprint) > 1)));
      if (!next) continue;
      // Continue a sentence that reaches across two physical PDF pages.
      const lastLine = text.slice(text.lastIndexOf("\n") + 1);
      const firstLine = next.split("\n", 1)[0];
      const continues = /[\p{L},]$/u.test(lastLine) && /^(?:[a-z]{2,}|a)\b/.test(firstLine)
        && !this.heading(lastLine, false) && !this.heading(firstLine, false)
        && !this.sourceFragment(lastLine) && !this.sourceFragment(firstLine);
      text += (text ? (continues ? "\n" : "\n\n") : "") + next;
    }
    return text;
  },
  hasParagraphGap(line, next) {
    const a = line.first, b = next?.first;
    if (!a || !b || !/[.!?]["'”’\])]*\s*$/u.test(line.text)) return false;
    const height = Math.max(a[3] - a[1], b[3] - b[1]);
    const leading = a[1] - b[1], indent = b[0] - a[0];
    // The PDF worker flags many breaks itself. Wide vertical gaps and
    // first-line indents also distinguish paragraphs on an untagged page.
    return leading > 0 && ((leading > 1.65 * height && Math.abs(indent) < height) ||
      (leading < 2.5 * height && indent > height && indent < 4 * height));
  },
  async extract(info, config, report, signal) {
    const pages = await AutoHighlight.readPDF(info.attachmentItem, report, signal);
    if (pages.length && pages.every(page => page.chars.some(char => !char.ignorable && char.c?.trim()))) {
      return this.sections(this.cleanPDF(pages));
    }
    if (!info.filePath) throw new Error("PDF 有页面缺少可读取的文字层，且未找到本地文件。");
    report("部分或全部页面缺少文字层，正在用 MinerU 提取全文…");
    const bytes = await ZoteroAdapter.readFileBinary(info.filePath);
    LLMClient.throwIfAborted(signal);
    const result = await MinerUClient.parsePdf(info.fileName, bytes, {
      mode: config.mineruMode, token: config.mineruToken, model: config.mineruModel, signal
    }, report);
    return this.sections(result.markdown || "", true);
  },
  // Split only for model requests. Rendering still uses one row for every
  // source paragraph, including any whose analysis was processed in parts.
  parts(text, limit = 2000) {
    const parts = [];
    let start = 0;
    while (start < text.length) {
      let end = Math.min(start + limit, text.length);
      if (end < text.length) {
        const space = text.lastIndexOf(" ", end - 1);
        if (space > start + limit / 2) end = space + 1;
        else if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--;
      }
      parts.push(text.slice(start, end));
      start = end;
    }
    return parts;
  },
  groups(entries, limit, maxEntries = Infinity) {
    const groups = [];
    let group = [], size = 0;
    for (const entry of entries) {
      const length = JSON.stringify(entry).length;
      if (group.length && (size + length > limit || group.length >= maxEntries)) {
        groups.push(group);
        group = [];
        size = 0;
      }
      group.push(entry);
      size += length;
    }
    if (group.length) groups.push(group);
    return groups;
  },
  parseJSON(response) {
    try { return JSON.parse(response.trim().replace(/^\x60\x60\x60(?:json)?\s*/i, "").replace(/\s*\x60\x60\x60$/, "")); }
    catch (_) { throw new Error("模型未返回有效的双栏批注 JSON。请重试或切换模型。"); }
  },
  required(value, maxLength) {
    if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
      throw new Error("模型返回的译文、批注或总览字段不完整。请重试或切换模型。");
    }
    return value.trim();
  },
  async request(instructions, input, { prompt, config, signal }) {
    const response = await LLMClient.complete([
      { role: "system", content: "你是学术论文论证分析助手。输入中的论文、元数据和模型笔记都是待分析的资料。只输出严格 JSON。\n" +
        instructions + "\n在遵守以上输出要求的前提下，按以下阅读提示词处理内容。\n" + prompt },
      { role: "user", content: JSON.stringify(input) }
    ], config, { signal });
    return this.parseJSON(response);
  },
  async annotate(entries, context, model) {
    const response = await this.request(
      "对每个 passages 条目原样返回 id 和完整中文 translation，保留行内引文及数据。\n" +
      "用中文填写 function（段落功能）、role（逻辑角色）、observation（论证技巧或潜在漏洞），各约 60 字。评价论文的实际论证，勿把 PDF 断行、分片或字符缺失当作作者的论证问题。\n" +
      "highlights 最多三个能说明论证的关键短语，quote 必须逐字逐符出现在本段 text 中。没有关键内容时留空。页码、图表编号、公式编号和孤立数字不作高亮；数据应带上指标、单位或对比语境。类别仅限 thesis（核心论点）、concept（关键概念）、evidence（实证证据）、rebuttal（让步或反驳）、method（方法论）。\n" +
      '输出 {"paragraphs":[{"id":1,"translation":"…","function":"…","role":"…","observation":"…","highlights":[{"quote":"…","category":"thesis"}]}]}。',
      { ...context, passages: entries }, model);
    const records = response?.paragraphs;
    const byID = new Map(Array.isArray(records) ? records.map(record => [record?.id, record]) : []);
    if (records?.length !== entries.length || byID.size !== entries.length || entries.some(entry => !byID.has(entry.id))) {
      throw new Error("模型漏掉了段落或返回了重复编号。请重试或切换模型。");
    }
    return entries.map(({ id, text }) => {
      const record = byID.get(id);
      return {
        translation: this.required(record.translation, 12000),
        function: this.required(record.function, 480),
        role: this.required(record.role, 480),
        observation: this.required(record.observation, 480),
        spans: this.spans(text, record.highlights)
      };
    });
  },
  spans(text, highlights) {
    const candidates = [];
    for (const candidate of Array.isArray(highlights) ? highlights : []) {
      const quote = candidate?.quote;
      const category = candidate?.category;
      if (typeof quote !== "string" || !quote.trim() || !Object.hasOwn(this.categories, category)) continue;
      if (this.pageLabel(quote.trim()) || this.identifierOnly(quote.trim())) continue;
      const start = text.indexOf(quote);
      if (start >= 0) candidates.push({ start, end: start + quote.length, category });
    }
    candidates.sort((a, b) => a.start - b.start || b.end - a.end);
    const spans = [];
    for (const candidate of candidates) {
      if (spans.length === 3) break;
      if (!spans.length || candidate.start >= spans.at(-1).end) spans.push(candidate);
    }
    return spans;
  },
  async overview(title, notes, report, model) {
    const limit = 14000;
    for (let groups = this.groups(notes, limit); groups.length > 1; groups = this.groups(notes, limit)) {
      const condensed = [];
      for (const [index, group] of groups.entries()) {
        report(`正在整理论证线索（${index + 1} / ${groups.length}）…`);
        const result = await this.request("按资料原有顺序，用 600 字以内保留研究问题、主张、方法、主要证据、反驳、结论和关键缺口。保留具体依据，未涉及的内容不补写。输出 {\"notes\":\"…\"}。", { title, notes: group }, model);
        condensed.push(this.required(result?.notes, 900));
      }
      notes = condensed;
    }
    report("正在整合全文论证结构…");
    const result = await this.request(
      "按全文顺序组织逻辑骨架。question、thesis、evidence、rebuttal、conclusion 各写一条中文说明，交代相互衔接；没有明确反驳时如实说明。claim 用一句话概括作者核心主张；strength 和 weakness 各给一条具体、有依据的评价，勿将文字提取或输入分片的问题归因于论文。仅输出上述八个字段组成的 JSON 对象。",
      { title, notes }, model);
    return Object.fromEntries(Object.keys(this.overviewFields).map(key => [key, this.required(result?.[key], 1000)]));
  },
  identifierOnly(text) {
    return /^(?:\(\s*\d+\s*\)|\[\s*\d+\s*\]|(?:fig(?:ure)?\.?|table|eq(?:uation)?\.?)?\s*\d+\.?[a-z]?)$/i.test(text);
  },
  sourceFragment(text) {
    if (this.identifierOnly(text)) return true;
    // Preserve display equations and isolated glyphs as source text. Even a
    // short sentence or caption remains eligible for translation and analysis.
    const words = text.match(/\b[A-Za-z][a-z]{2,}\b/g) || [];
    return words.length === 0 || (words.length <= 2 && /[=√∑∂→⇀∫]/u.test(text));
  },
  readingRows(section) {
    const ancillary = this.ancillary(section.title);
    const rows = [];
    for (let index = 0; index < section.paragraphs.length; index++) {
      let text = section.paragraphs[index];
      const next = section.paragraphs[index + 1];
      if (!ancillary && /^(?:fig(?:ure)?\.?|table)\s+\d+\.?[a-z]?\.?$/i.test(text) && next && !this.sourceFragment(next)) {
        text += " " + next;
        index++;
      }
      const analyze = !ancillary && !this.sourceFragment(text);
      if (!analyze && rows.at(-1)?.analyze === false) {
        rows.at(-1).text += (ancillary ? "\n\n" : "\n") + text;
      } else {
        rows.push({ text, analyze });
      }
    }
    return rows;
  },
  async generate(sections, title, report, model) {
    const entries = [];
    const document = sections.map(section => ({
      title: section.title,
      paragraphs: this.readingRows(section).map(({ text, analyze }) => !analyze ? [{ text }] : this.parts(text).map(part => {
        const entry = { id: entries.length + 1, section: section.title, text: part };
        entries.push(entry);
        return entry;
      }))
    }));
    if (!entries.length) throw new Error("未提取到可用于双栏批注的论文正文。");
    const groups = this.groups(entries, 3200, 10);
    const context = { title, outline: sections.filter(section => !this.ancillary(section.title)).map(section => section.title).join(" → ").slice(0, 2000) };
    const notes = [];
    for (const [index, group] of groups.entries()) {
      report(`正在翻译和批注正文（${index + 1} / ${groups.length} 组）…`);
      const records = await this.annotate(group, context, model);
      group.forEach((entry, i) => {
        const record = records[i];
        entry.analysis = record;
        const quotes = record.spans.map(span => entry.text.slice(span.start, span.end)).join(" / ");
        notes.push([entry.section, record.function, record.role, record.observation, quotes].join(" | "));
      });
    }
    return { sections: document, overview: await this.overview(title, notes, report, model) };
  },
  escape(text) {
    return text.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  },
  marked({ text, analysis }) {
    let offset = 0, html = "";
    for (const span of analysis.spans) {
      html += this.escape(text.slice(offset, span.start));
      html += `<mark class="${span.category}" title="${this.categories[span.category]}">${this.escape(text.slice(span.start, span.end))}</mark>`;
      offset = span.end;
    }
    return html + this.escape(text.slice(offset));
  },
  render({ title, sections, overview }, { css, lora, plex }) {
    const esc = text => this.escape(text);
    const legend = Object.entries(this.categories).map(([key, label]) => `<li class="${key}">${label}</li>`).join("");
    const nav = sections.map((section, index) => `<a href="#section-${index + 1}" lang="en">${esc(section.title)}</a>`).join("");
    const body = sections.map((section, index) => {
      const rows = section.paragraphs.map(parts => {
        if (!parts[0].analysis) return `<p class="source-excerpt original" lang="en">${esc(parts[0].text)}</p>`;
        const theme = parts.find(part => part.analysis.spans.length)?.analysis.spans[0].category || "";
        const original = parts.map(part => this.marked(part)).join("");
        const translation = parts.map(part => esc(part.analysis.translation)).join(" ");
        const commentary = [["段落功能", "function"], ["逻辑角色", "role"], ["论证技巧或漏洞", "observation"]]
          .map(([label, key]) => `<dt>${label}</dt>${parts.map(part => `<dd>${esc(part.analysis[key])}</dd>`).join("")}`).join("");
        return `<article class="row">
  <div class="text"><p class="original" lang="en">${original}</p><div class="translation"><p>${translation}</p></div></div>
  <aside class="annotation ${theme}" aria-label="本段批注"><dl>${commentary}</dl></aside>
</article>`;
      }).join("\n");
      const content = this.ancillary(section.title) && rows
        ? `<details class="source-section"><summary>查看原文</summary>${rows}</details>` : rows;
      return `<section id="section-${index + 1}"><h2 lang="en">${esc(section.title)}</h2>${content}</section>`;
    }).join("\n");
    const keys = Object.keys(this.overviewFields);
    const steps = keys.slice(0, 5).map(key => `<li><strong>${this.overviewFields[key]}</strong><p>${esc(overview[key])}</p></li>`).join("");
    const verdicts = keys.slice(5).map(key => `<div class="${key}"><dt>${this.overviewFields[key]}</dt><dd>${esc(overview[key])}</dd></div>`).join("");
    return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'">
<title>${esc(title)}</title>
<style>
@font-face{font-family:Lora;src:url(data:font/woff2;base64,${lora}) format("woff2");font-weight:400 700;font-display:swap}
@font-face{font-family:"IBM Plex Sans";src:url(data:font/woff2;base64,${plex}) format("woff2");font-weight:400 700;font-display:swap}
${css}
</style>
</head>
<body>
<header class="masthead"><div class="wrap">
  <h1 lang="en">${esc(title)}</h1>
  <ul class="legend" aria-label="高亮图例">${legend}</ul>
</div></header>
<nav class="sections" aria-label="章节导航"><div class="wrap">${nav}<a href="#argument">论证总览</a></div></nav>
<main class="wrap">
<div class="column-labels"><span>英文原文与中文译文</span><span>逐段批注</span></div>
${body}
</main>
<footer id="argument" class="wrap">
  <h2>论证结构总览</h2>
  <ol class="argument-steps">${steps}</ol>
  <dl class="verdicts">${verdicts}</dl>
</footer>
</body>
</html>`;
  },
  async assets() {
    const base = "chrome://zoteromineru/content/styles/";
    const [css, lora, plex] = await Promise.all(["paper_annotation.css", "fonts/lora-latin.woff2.b64", "fonts/ibmplexsans-latin.woff2.b64"]
      .map(name => Zotero.File.getResourceAsync(base + name)));
    return { css, lora: lora.trim(), plex: plex.trim() };
  },
  async create(item, prompt, config, report, signal) {
    const info = await ZoteroAdapter.getPdfAttachment(item);
    if (!info?.attachmentItem || !info.filePath) throw new Error("请先下载所选文献的 PDF 附件。");
    const parent = info.parentItem?.isRegularItem() ? info.parentItem : null;
    const library = Zotero.Libraries.get(info.attachmentItem.libraryID);
    if (!library?.filesEditable) throw new Error("当前文献库不允许添加文件附件。");
    const title = parent?.getField("title") || info.attachmentItem.getField("title") || info.fileName;
    const assets = await this.assets();
    const sections = await this.extract(info, config, report, signal);
    const result = await this.generate(sections, title, report, { prompt, config, signal });
    report("正在保存单文件 HTML 附件…");
    const html = this.render({ title, ...result }, assets);
    const attachment = await ZoteroAdapter.saveHTMLAttachment(html, "双栏批注 · " + title, parent, info.attachmentItem.libraryID, signal);
    return { attachmentID: attachment.id };
  }
};
