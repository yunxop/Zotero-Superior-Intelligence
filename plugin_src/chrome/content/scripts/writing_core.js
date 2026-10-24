// Pure extraction, provenance validation and retrieval helpers.
var SIWritingCore = {
  normalize(value) { return String(value || "").replace(/\s+/gu, " ").trim(); },
  sections: ["Introduction", "Methods", "Results", "Discussion", "Other"],
  section(line, previous) {
    const s = line.replace(/^\s*[\d.]+\s*/, "").trim();
    if (/^(introduction|background)$/i.test(s)) return "Introduction";
    if (/^(materials and methods|methods|methodology|experimental( procedures)?)$/i.test(s)) return "Methods";
    if (/^results( and discussion)?$/i.test(s)) return "Results";
    if (/^(discussion|conclusions?|limitations)$/i.test(s)) return "Discussion";
    return previous;
  },
  paragraphs(pages, metadata) {
    const chunks = []; let section = "Other";
    pages.forEach((page, pageIndex) => {
      let raw = "";
      for (const c of page.chars) {
        if (c.ignorable) continue;
        raw += c.c || "";
        raw += c.paragraphBreakAfter ? "\n\n" : c.lineBreakAfter ? "\n" : c.spaceAfter ? " " : "";
      }
      let paragraph = 0;
      for (const block of raw.split(/\n\s*\n/)) {
        let body = [];
        const flush = () => {
          const text = this.normalize(body.join(" ")); body = [];
          if (!text) return;
          // Bound requests without discarding long paragraphs; keep physical page provenance.
          for (let offset = 0; offset < text.length;) {
            let end = Math.min(offset + 2800, text.length);
            if (end < text.length) { const space = text.lastIndexOf(" ", end); if (space > offset) end = space; }
            const value = text.slice(offset, end).trim(); offset = end;
            if (!value) continue;
            const chunk = { ...metadata, page: pageIndex + 1, pageLabel: page.label || String(pageIndex + 1), paragraph: ++paragraph, section, text: value };
            chunk.id = TaskCheckpointCache.hashText(JSON.stringify([metadata.libraryID, metadata.attachmentKey, chunk.page, chunk.paragraph, value]));
            chunks.push(chunk);
          }
        };
        for (const line of block.split("\n")) {
          const next = this.section(line, null);
          if (next) { flush(); section = next; } else body.push(line);
        }
        flush();
      }
    });
    return chunks;
  },
  keywords(query, text) {
    const tokens = [...new Set(this.normalize(query).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])];
    const haystack = text.toLowerCase();
    return tokens.length ? tokens.filter(t => haystack.includes(t)).length / tokens.length : 0;
  },
  cosine(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length) return 0;
    let dot = 0, aa = 0, bb = 0;
    for (let i = 0; i < a.length; i++) { if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) return 0; dot += a[i]*b[i]; aa += a[i]*a[i]; bb += b[i]*b[i]; }
    return aa && bb ? dot / Math.sqrt(aa*bb) : 0;
  },
  rank(chunks, topic, queryVector, model) {
    return chunks.map(chunk => {
      const keyword = this.keywords(topic, chunk.text);
      const semantic = queryVector && chunk.embeddingModel === model ? Math.max(0, this.cosine(queryVector, chunk.embedding)) : 0;
      return { ...chunk, relevance: queryVector ? 0.3 * keyword + 0.7 * semantic : keyword };
    }).sort((a,b) => b.relevance - a.relevance);
  },
  validate(response, chunks, topic, model) {
    const parsed = JSON.parse(String(response).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
    if (!Array.isArray(parsed.records) || parsed.records.length > 60) throw new Error("模型返回的 records 格式无效。");
    const source = new Map(chunks.map(c => [c.id, c])), records = [], seen = new Set();
    for (const item of parsed.records) {
      if (!item || typeof item !== "object") continue;
      const chunk = source.get(item.chunkID), quote = this.normalize(item.quote);
      if (!chunk || !["expression", "evidence"].includes(item.kind) || quote.length < 12 || quote.length > 2400 || !chunk.text.includes(quote)) continue;
      if (!this.sections.includes(item.section) || !Number.isFinite(item.valueScore) || item.valueScore < 0 || item.valueScore > 100) continue;
      const id = TaskCheckpointCache.hashText(JSON.stringify([chunk.libraryID, chunk.attachmentKey, item.kind, quote]));
      if (seen.has(id)) continue; seen.add(id);
      const details = {};
      for (const field of ["explanation", "pattern", "technique", "conclusion", "method", "quantitativeResult", "support", "limitations"]) details[field] = typeof item[field] === "string" ? item[field].slice(0, 5000) : "";
      records.push({ id, chunkID: chunk.id, kind: item.kind, quote, section: item.section, valueScore: item.valueScore,
        relevance: chunk.relevance, topic, model, details, originalDetails: { ...details }, status: "pending", reviewerNote: "", createdAt: new Date().toISOString(),
        source: { libraryID: chunk.libraryID, itemID: chunk.itemID, attachmentID: chunk.attachmentID, attachmentKey: chunk.attachmentKey,
          title: chunk.title, doi: chunk.doi, authors: chunk.authors, year: chunk.year, page: chunk.page, pageLabel: chunk.pageLabel, paragraph: chunk.paragraph, text: chunk.text, uri: chunk.uri + "?page=" + chunk.page } });
    }
    if (parsed.records.length && !records.length) throw new Error("模型返回的记录均未通过原文或字段核验，未保存；请重试或更换模型。");
    return records;
  },
  markdown(records) {
    const safe = value => String(value ?? "").replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
    return "# 科研写作知识库\n\n" + records.map(r => `## ${r.kind === "evidence" ? "科学证据" : "英文表达"} · ${r.section}\n\n` +
      `审核：${r.status} · 借鉴价值：${r.valueScore}/100 · 主题：${safe((r.topics || [r.topic]).join("；"))}\n\n` +
      `原文：${safe(r.quote)}\n\n` + Object.entries(r.details).filter(([,v]) => v).map(([k,v]) => `**${k}**：${safe(v)}\n\n`).join("") +
      `来源：${safe(r.source.title)} · DOI：${safe(r.source.doi)} · 页码：${safe(r.source.pageLabel)}（PDF ${r.source.page}） · 段落：${r.source.paragraph}\n\n` +
      `[打开原文](${r.source.uri})\n\n审核备注：${safe(r.reviewerNote)}\n\n记录 ID：${r.id}\n`).join("\n---\n\n");
  },
  export(records, format) {
    if (format === "markdown") return this.markdown(records);
    if (format === "training") return records.filter(r => r.status === "approved").map(r => JSON.stringify({ messages: [
      { role: "system", content: "基于所给原文分析科研证据或英文写作，不补充原文未报告的信息。" },
      { role: "user", content: `研究主题：${r.topic}\n原文：${r.quote}\n任务：${r.kind === "evidence" ? "提取科学证据" : "分析英文写作表达"}` },
      { role: "assistant", content: JSON.stringify({ section: r.section, ...r.details }) }
    ] })).join("\n");
    if (format !== "jsonl") throw new Error("不支持的导出格式。");
    return records.map(r => JSON.stringify({ schemaVersion: 1, ...r })).join("\n");
  }
};
