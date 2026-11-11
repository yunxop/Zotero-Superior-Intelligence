// Source-only block parsing and safe offline formatting for reading attachments.
// Never accept model/source HTML as executable markup.
var SIPaperContent = {
  vocabulary(text) {
    return new Set((text.match(/\b[a-z]{4,}\b/gi) || []).map(word => word.toLowerCase()));
  },
  joinLines(lines, vocabulary) {
    const original = lines.join("\n"), math = this.math(original);
    let joined = (math.text ?? original).replace(/([a-z]{2,})([-\u00ad])[ \t]*\n[ \t]*([a-z]{2,})/gi,
      (_match, left, hyphen, right) => left + (hyphen === "\u00ad" || vocabulary.has((left + right).toLowerCase()) ? "" : "-") + right)
      .replace(/([0-9])-[ \t]*\n[ \t]*([a-z]{2,})/gi, "$1-$2")
      .replace(/([a-z])\u00ad(?=[a-z])/gi, "$1").replace(/\n/g, " ");
    for (const token of math.tokens) joined = joined.split(token.token).join(original.slice(token.start, token.end));
    return joined;
  },
  // Offsets refer to the untouched input. Provenance survives block parsing and
  // later whitespace/soft-hyphen cleanup.
  units(raw, markdown) {
    let offset = 0;
    const lines = raw.split("\n").map(text => {
      const line = { text, type: "text", start: offset, end: offset + text.length };
      offset += text.length + 1;
      return line;
    });
    if (!markdown) return lines;
    const units = [];
    const separator = text => /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(text);
    for (let i = 0; i < lines.length; i++) {
      const first = lines[i], text = first.text.trim();
      let end = i, type = "text";
      const fence = text.match(/^(\x60{3,}|~{3,})/);
      if (fence) {
        type = "code";
        while (end + 1 < lines.length) {
          end++;
          const close = lines[end].text.trim();
          if (close.startsWith(fence[1]) && new RegExp(`^${fence[1][0]}{${fence[1].length},}$`).test(close)) break;
        }
      } else if (/^<table\b/i.test(text)) {
        let candidate = i;
        while (candidate < lines.length) {
          if (/<\/table\s*>/i.test(lines[candidate].text)) { end = candidate; type = "html-table"; break; }
          if (candidate > i && /^\s*#{1,6}\s/.test(lines[candidate].text)) break;
          candidate++;
        }
      } else if (text.includes("|") && separator(lines[i + 1]?.text || "")) {
        type = "table"; end++;
        while (end + 1 < lines.length && lines[end + 1].text.trim() && lines[end + 1].text.includes("|")) end++;
      } else if (/^(?:\$\$|\\\[)/.test(text)) {
        const opening = text.startsWith("$$") ? "$$" : "\\[", closing = opening === "$$" ? "$$" : "\\]";
        // Leave malformed displays readable; do not swallow the rest of a paper.
        let candidate = i;
        while (candidate < lines.length) {
          const line = lines[candidate].text;
          if (line.indexOf(closing, candidate === i ? line.indexOf(opening) + opening.length : 0) >= 0) {
            end = candidate; type = "equation"; break;
          }
          if (candidate > i && /^\s*#{1,6}\s/.test(line)) break;
          candidate++;
        }
      } else if (/^!\[[^\]]*\]\([\s\S]+\)$/.test(text)) type = "figure";
      units.push({ type, start: first.start, end: lines[end].end, text: raw.slice(first.start, lines[end].end) });
      i = end;
    }
    return units;
  },
  math(text) {
    return typeof MarkdownRenderer === "undefined" ? { tokens: [] } : MarkdownRenderer.prepareMath(text, { block: false });
  },
  inline(text, spans = [], categories = {}) {
    const escape = value => this.escape(value);
    const math = this.math(text).tokens;
    const pieces = math.map(token => ({ start: token.start, end: token.end, html: token.html }));
    for (const span of spans) {
      // A highlight crossing a formula must not break its TeX syntax or DOM.
      if (math.some(token => span.start < token.end && span.end > token.start)) continue;
      pieces.push({ ...span, html: `<mark class="${escape(span.category)}" title="${escape(categories[span.category] || "")}">${escape(text.slice(span.start, span.end))}</mark>` });
    }
    let offset = 0, html = "";
    for (const piece of pieces.sort((a, b) => a.start - b.start)) {
      if (piece.start < offset) continue;
      html += escape(text.slice(offset, piece.start)) + piece.html;
      offset = piece.end;
    }
    return html + escape(text.slice(offset));
  },
  escape(value) {
    return String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  },
  entities(text) {
    return text.replace(/&(?:#(x[0-9a-f]+|[0-9]+)|(amp|lt|gt|quot|apos|nbsp));/gi, (match, numeric, named) => {
      if (named) return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" }[named.toLowerCase()];
      const code = numeric[0].toLowerCase() === "x" ? parseInt(numeric.slice(1), 16) : Number(numeric);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : match;
    });
  },
  cellHTML(text) {
    // Keep scientific superscripts/subscripts, discard all supplied attributes.
    return text.split(/(<[^>]*>)/g).map(part => {
      const tag = part.match(/^<(\/?)(sup|sub|em|strong|br)\s*\/?\s*>$/i);
      if (tag) return `<${tag[1]}${tag[2].toLowerCase()}>`;
      return this.inline(this.entities(part));
    }).join("");
  },
  table(text, htmlTable = false) {
    if (typeof MarkdownRenderer === "undefined") return `<pre>${this.escape(text)}</pre>`;
    if (htmlTable) {
      const rows = [...text.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)];
      if (!rows.length) return `<pre>${this.escape(text)}</pre>`;
      const caption = text.match(/<caption\b[^>]*>([\s\S]*?)<\/caption\s*>/i);
      return '<table>' + (caption ? `<caption>${this.cellHTML(caption[1])}</caption>` : "") + '<tbody>' + rows.map(row =>
        '<tr>' + [...row[1].matchAll(/<(td|th)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi)].map(cell => {
          const tag = cell[1].toLowerCase();
          const attrs = ["rowspan", "colspan"].map(name => {
            const match = cell[2].match(new RegExp(`\\b${name}\\s*=\\s*["']?(\\d+)(?:["'\\s]|$)`, "i"));
            return match && Number(match[1]) > 0 && Number(match[1]) <= 100 ? ` ${name}="${Number(match[1])}"` : "";
          }).join("");
          return `<${tag}${attrs}>${this.cellHTML(cell[3])}</${tag}>`;
        }).join("") + '</tr>').join("") + '</tbody></table>';
    }
    const math = MarkdownRenderer.prepareMath(text, { block: false });
    const lines = math.text.split(/\r?\n/);
    const cells = lines.map(line => MarkdownRenderer.tableCells(line));
    const header = cells[0], rows = cells.slice(2);
    const width = Math.max(header.length, ...rows.map(row => row.length));
    const render = value => MarkdownRenderer.restoreTokens(MarkdownRenderer.inline(value || ""), math.tokens);
    const rowHTML = (row, tag) => '<tr>' + Array.from({ length: width }, (_, i) => `<${tag}>${render(row[i])}</${tag}>`).join("") + '</tr>';
    return `<table><thead>${rowHTML(header, "th")}</thead><tbody>${rows.map(row => rowHTML(row, "td")).join("")}</tbody></table>`;
  },
  block(type, text) {
    if (type === "table" || type === "html-table") return `<div class="source-table" tabindex="0" role="region" aria-label="原文表格">${this.table(text, type === "html-table")}</div>`;
    if (type === "equation") return `<div class="source-equation">${this.inline(text)}</div>`;
    if (type === "figure") return `<figure class="source-figure"><figcaption>图片原文标记（图像未嵌入，请在来源 PDF 中查看）</figcaption><pre>${this.escape(text)}</pre></figure>`;
    return `<pre class="source-code">${this.escape(text)}</pre>`;
  }
};
