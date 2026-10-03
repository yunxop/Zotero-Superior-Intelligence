// Safe Markdown shared by reader chat, dashboards, and Zotero notes.
// KaTeX is bundled locally. Notes use Zotero native math nodes so TeX remains editable.
var MarkdownRenderer = {
  escape(value) {
    return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  },
  isEscaped(text, index) {
    let slashes = 0;
    while (index > 0 && text[--index] === "\\") slashes += 1;
    return slashes % 2 === 1;
  },
  // Protect math before Markdown parsing, including multiline displays and
  // table formulas containing pipes. Code is always left untouched.
  prepareMath(value, options = {}) {
    const text = String(value);
    let prefix = "\uE000si-math-";
    while (text.includes(prefix)) prefix += "-";
    const tokens = [];
    let output = "", fence = null;
    for (let index = 0; index < text.length;) {
      if (index === 0 || text[index - 1] === "\n") {
        const end = text.indexOf("\n", index);
        const lineEnd = end < 0 ? text.length : end;
        const line = text.slice(index, lineEnd);
        const marker = line.match(/^\s{0,3}(\x60{3,}|~{3,})(.*)$/);
        if (fence) {
          output += text.slice(index, lineEnd); index = lineEnd;
          if (marker && marker[1][0] === fence.char && marker[1].length >= fence.size && !marker[2].trim()) fence = null;
          if (index < text.length) { output += "\n"; index += 1; }
          continue;
        }
        if (marker) {
          fence = { char: marker[1][0], size: marker[1].length };
          output += text.slice(index, lineEnd); index = lineEnd;
          if (index < text.length) { output += "\n"; index += 1; }
          continue;
        }
      }
      if (text.charCodeAt(index) === 96) {
        let end = index;
        while (text.charCodeAt(end) === 96) end += 1;
        const marker = text.slice(index, end);
        let close = text.indexOf(marker, end);
        while (close >= 0 && (text.charCodeAt(close - 1) === 96 || text.charCodeAt(close + marker.length) === 96)) close = text.indexOf(marker, close + marker.length);
        if (close >= 0) {
          output += text.slice(index, close + marker.length); index = close + marker.length; continue;
        }
        output += marker; index = end; continue;
      }
      let left = null, right = null, display = false;
      if (!this.isEscaped(text, index)) {
        if (text.startsWith("$$", index)) { left = right = "$$"; display = true; }
        else if (text.startsWith("\\[", index)) { left = "\\["; right = "\\]"; display = true; }
        else if (text.startsWith("\\(", index)) { left = "\\("; right = "\\)"; }
        else if (text[index] === "$" && !/\s/.test(text[index + 1] || " ") && text[index - 1] !== "$") left = right = "$";
      }
      if (left) {
        let depth = 0, close = -1;
        for (let cursor = index + left.length; cursor < text.length; cursor += 1) {
          if (left === "$" && text[cursor] === "\n") break;
          if (depth === 0 && text.startsWith(right, cursor) && !this.isEscaped(text, cursor)) {
            if (right !== "$" || (!/\s/.test(text[cursor - 1]) && !/[0-9$]/.test(text[cursor + 1] || ""))) { close = cursor; break; }
          }
          if (text[cursor] === "\\") { cursor += 1; continue; }
          if (text[cursor] === "{") depth += 1;
          else if (text[cursor] === "}" && depth > 0) depth -= 1;
        }
        if (close >= 0) {
          const tex = text.slice(index + left.length, close);
          if (tex.trim()) {
            const token = prefix + tokens.length + "\uE001";
            tokens.push({ token, html: this.mathHTML(tex, display, text.slice(index, close + right.length), options), display });
            const inTable = /^\s*\|/.test(text.slice(text.lastIndexOf("\n", index - 1) + 1, index));
            output += display && options.block !== false && !inTable ? "\n" + token + "\n" : token;
            index = close + right.length; continue;
          }
        }
      }
      output += text[index++];
    }
    return { text: output, tokens };
  },
  mathHTML(tex, display, source, options = {}) {
    if (options.mathOutput === "zotero") {
      return display ? '<pre class="math">$$' + this.escape(tex) + '$$</pre>' : '<span class="math">$' + this.escape(tex) + '$</span>';
    }
    try {
      if (typeof katex === "undefined") throw new Error("KaTeX is unavailable");
      const rendered = katex.renderToString(tex, { displayMode: display, throwOnError: true, trust: false, strict: "ignore", output: "htmlAndMathml", maxExpand: 1000, maxSize: 20 });
      const tag = display ? "div" : "span";
      return "<" + tag + ' class="si-math-' + (display ? "display" : "inline") + '" data-tex="' + this.escape(tex) + '">' + rendered + "</" + tag + ">";
    } catch (_error) {
      const tag = display ? "pre" : "span";
      return "<" + tag + ' class="si-math-error">' + this.escape(source) + "</" + tag + ">";
    }
  },
  restoreTokens(html, tokens) {
    for (const entry of tokens) html = html.split(entry.token).join(entry.html);
    return html;
  },
  inline(value, options = {}, prepared = []) {
    const math = this.prepareMath(value, { ...options, block: false });
    let prefix = "\uE000si-code-";
    while (math.text.includes(prefix)) prefix += "-";
    const codes = [];
    const text = math.text.replace(/(\x60+)([\s\S]*?)\1(?!\x60)/g, (_match, marker, content) => {
      const token = prefix + codes.length + "\uE001";
      codes.push({ token, html: "<code>" + this.escape(content) + "</code>" }); return token;
    });
    let html = this.escape(text);
    html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>");
    html = this.restoreTokens(html, codes);
    html = this.restoreTokens(html, math.tokens);
    return this.restoreTokens(html, prepared);
  },
  tableCells(line) {
    const value = line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "");
    const cells = [];
    let start = 0, codeMarker = "";
    for (let index = 0; index < value.length; index += 1) {
      if (value.charCodeAt(index) === 96) {
        let end = index;
        while (value.charCodeAt(end) === 96) end += 1;
        const marker = value.slice(index, end);
        if (!codeMarker) codeMarker = marker;
        else if (codeMarker === marker) codeMarker = "";
        index = end - 1;
      } else if (value[index] === "|" && !codeMarker && !this.isEscaped(value, index)) {
        cells.push(value.slice(start, index).trim()); start = index + 1;
      }
    }
    cells.push(value.slice(start).trim()); return cells.map(cell => cell.replace(/\\\|/g, "|"));
  },
  toHTML(markdown, options = {}) {
    const math = this.prepareMath(String(markdown || "").replace(/\r\n?/g, "\n"), options);
    const lines = math.text.split("\n"), out = [];
    const inline = value => this.inline(value, options, math.tokens);
    let list = null, fence = null;
    const closeList = () => { if (list) out.push("</" + list + ">"); list = null; };
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index], marker = line.match(/^\s{0,3}(\x60{3,}|~{3,})(.*)$/);
      if (fence) {
        if (marker && marker[1][0] === fence.char && marker[1].length >= fence.size && !marker[2].trim()) { out.push("</code></pre>"); fence = null; }
        else out.push(this.escape(line) + "\n");
        continue;
      }
      if (marker) { closeList(); out.push("<pre><code>"); fence = { char: marker[1][0], size: marker[1].length }; continue; }
      if (!line.trim()) { closeList(); continue; }
      const display = math.tokens.find(entry => entry.display && entry.token === line.trim());
      if (display) { closeList(); out.push(display.html); continue; }
      const header = line.trim().startsWith("|") ? this.tableCells(line) : null;
      const separator = lines[index + 1] && lines[index + 1].trim().startsWith("|") ? this.tableCells(lines[index + 1]) : null;
      if (header && separator && header.length === separator.length && separator.every(cell => /^:?-{3,}:?$/.test(cell))) {
        closeList(); out.push("<table><thead><tr>" + header.map(cell => "<th>" + inline(cell) + "</th>").join("") + "</tr></thead><tbody>");
        index += 1;
        while (index + 1 < lines.length && lines[index + 1].trim().startsWith("|")) {
          const row = this.tableCells(lines[++index]);
          out.push("<tr>" + header.map((_cell, column) => "<td>" + inline(row[column] || "") + "</td>").join("") + "</tr>");
        }
        out.push("</tbody></table>"); continue;
      }
      const heading = line.match(/^(#{1,4})\s+(.+)$/);
      if (heading) { closeList(); const level = heading[1].length; out.push("<h" + level + ">" + inline(heading[2]) + "</h" + level + ">"); continue; }
      const bullet = line.match(/^\s*[-*]\s+(.+)$/), numbered = line.match(/^\s*\d+[.)]\s+(.+)$/);
      if (bullet || numbered) {
        const type = bullet ? "ul" : "ol";
        if (list !== type) { closeList(); out.push("<" + type + ">"); list = type; }
        out.push("<li>" + inline((bullet || numbered)[1]) + "</li>"); continue;
      }
      closeList(); const quote = line.match(/^>\s*(.*)$/);
      if (quote) out.push("<blockquote>" + inline(quote[1]) + "</blockquote>");
      else if (/^---+$/.test(line.trim())) out.push("<hr/>");
      else out.push("<p>" + inline(line) + "</p>");
    }
    closeList(); if (fence) out.push("</code></pre>"); return out.join("");
  },
  // Native note schema reads TeX from span.math / pre.math textContent.
  // Persisting the visual DOM would store duplicated, flattened math.
  toNoteHTML(markdown) { return this.toHTML(markdown, { mathOutput: "zotero" }); },
  ensureMathStyles(doc) {
    if (!doc?.createElementNS || (!doc.head && !doc.documentElement)) return;
    const target = doc.head || doc.documentElement;
    if (!doc.getElementById?.("si-katex-styles")) {
      const link = doc.createElementNS("http://www.w3.org/1999/xhtml", "link");
      link.id = "si-katex-styles"; link.setAttribute("rel", "stylesheet");
      link.setAttribute("href", "chrome://zoteromineru/content/styles/katex.css"); target.appendChild(link);
    }
    if (!doc.getElementById?.("si-math-layout")) {
      const style = doc.createElementNS("http://www.w3.org/1999/xhtml", "style");
      style.id = "si-math-layout";
      style.textContent = ".si-math-display{overflow-x:auto;overflow-y:hidden;max-width:100%;padding:2px 0}.si-math-error{white-space:pre-wrap;overflow-wrap:anywhere}.si-math-inline{white-space:normal}";
      target.appendChild(style);
    }
  },
  render(container, markdown) {
    const doc = container.ownerDocument;
    this.ensureMathStyles(doc);
    const html = this.toHTML(markdown);
    // Parse HTML before importing into Zotero XML documents, retaining HTML,
    // MathML and SVG namespaces without XML entity/parser restrictions.
    const Parser = doc?.defaultView?.DOMParser || (typeof DOMParser !== "undefined" ? DOMParser : null);
    if (Parser && doc?.importNode && container.replaceChildren && doc.contentType !== "text/html") {
      const parsed = new Parser().parseFromString(html, "text/html");
      container.replaceChildren(...Array.from(parsed.body.childNodes, node => doc.importNode(node, true)));
    } else container.innerHTML = html;
  }
};
