const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const crypto = require("node:crypto");
const scripts = path.join(__dirname, "../plugin_src/chrome/content/scripts");
const context = vm.createContext({ console });
const vendorBytes = fs.readFileSync(path.join(scripts, "vendor/katex.min.js"));
assert.equal(crypto.createHash("sha384").update(vendorBytes).digest("base64"),
  "J+9dG2KMoiR9hqcFao0IBLwxt6zpcyN68IgwzsCSkbreXUjmNVRhPFTssqdSGjwQ");
vm.runInContext(vendorBytes.toString("utf8"), context);
vm.runInContext(fs.readFileSync(path.join(scripts, "markdown_renderer.js"), "utf8"), context);
assert.equal(context.katex.version, "0.16.25");
const renderer = context.MarkdownRenderer;
const tick = String.fromCharCode(96);
const html = renderer.toHTML("Inline $\\frac{a}{b}$ and \\(x^2\\).\n\n$$\n\\int_0^1 x^2\\,dx = \\frac{1}{3}\n$$\n\n\\[\\begin{pmatrix}a & b \\\\ c & d\\end{pmatrix}\\]");
assert.equal((html.match(/class="si-math-inline"/g) || []).length, 2);
assert.equal((html.match(/class="si-math-display"/g) || []).length, 2);
assert.match(html, /class="mfrac"/);
assert.match(html, /class="mtable"/);
assert.match(html, /<math xmlns="http:\/\/www.w3.org\/1998\/Math\/MathML"/);
assert.doesNotMatch(html, /si-math-error/);
const multilineInline = renderer.toHTML("Before \\(x +\n y\\) after");
assert.equal((multilineInline.match(/class="si-math-inline"/g) || []).length, 1);
const displayTable = renderer.toHTML("| formula | result |\n| --- | --- |\n| $$\\frac{a}{b}$$ | 1 |");
assert.match(displayTable, /<table>/);
assert.equal((displayTable.match(/<td>/g) || []).length, 2);
assert.match(displayTable, /class="si-math-display"/);
const decorated = renderer.toHTML("**$a_b$** and *$\\alpha$*");
assert.match(decorated, /<strong><span class="si-math-inline"/);
assert.match(decorated, /<em><span class="si-math-inline"/);
const code = renderer.toHTML(tick + "$x$ **literal**" + tick + "\n" +
  tick.repeat(3) + "tex\n$$\\frac{1}{2}$$\n\\(x\\)\n" + tick.repeat(3) +
  "\n~~~\n\\[y\\]\n~~~\n" + tick.repeat(2) + "$z$ " + tick + " literal" + tick.repeat(2));
assert.doesNotMatch(code, /katex|si-math-inline|si-math-display/);
assert.match(code, /<code>\$x\$ \*\*literal\*\*<\/code>/);
assert.match(code, /\$\$\\frac\{1\}\{2\}\$\$/);
assert.equal(renderer.toHTML("Cost $10 and $20. Escaped \\$x\\$. Unclosed $z."), "<p>Cost $10 and $20. Escaped \\$x\\$. Unclosed $z.</p>");
const table = renderer.toHTML("| formula | code |\n| --- | --- |\n| $\\lvert x|y\\rvert$ | " + tick + "a|b" + tick + " |");
assert.match(table, /<table>/);
assert.equal((table.match(/<td>/g) || []).length, 2);
assert.match(table, /<code>a\|b<\/code>/);
assert.match(table, /class="si-math-inline"/);
const failed = renderer.toHTML("$\\notARealCommand{<script>alert(1)</script>}$");
assert.match(failed, /si-math-error/);
assert.doesNotMatch(failed, /<script>/);
const attack = renderer.toHTML("$\\href{javascript:alert(1)}{click}$\n$\\includegraphics{https://example.org/a.png}$\n<img src=x onerror=alert(1)>");
assert.doesNotMatch(attack, /<(a|img|script)\b/);
assert.doesNotMatch(attack, /<[^>]*\s(?:href|onerror)\s*=/);
assert.match(attack, /&lt;img/);
const native = renderer.toNoteHTML("Inline \\(\\frac{a}{b}\\).\n\\[\n\\sum_{i=1}^n x_i\n\\]");
assert.match(native, /<span class="math">\$\\frac\{a\}\{b\}\$<\/span>/);
assert.match(native, /<pre class="math">\$\$\n\\sum_\{i=1\}\^n x_i\n\$\$<\/pre>/);
assert.doesNotMatch(native, /katex|<style|stylesheet/);
assert.equal(renderer.inline("\\(x<y\\)", { mathOutput: "zotero" }), '<span class="math">$x&lt;y$</span>');
// Zotero schema parseDOM reads only textContent and strips the dollar wrappers.
const nativeSources = [...native.matchAll(/<(span|pre) class="math">([\s\S]*?)<\/\1>/g)]
  .map(match => match[2].trim().replace(match[1] === "pre" ? /^\$\$|\$\$$/g : /^\$|\$$/g, ""));
assert.deepEqual(nativeSources, ["\\frac{a}{b}", "\n\\sum_{i=1}^n x_i\n"]);
const plainContainer = { innerHTML: "" };
renderer.render(plainContainer, "$\\sqrt{x}$");
assert.equal(plainContainer.innerHTML, renderer.toHTML("$\\sqrt{x}$"));
const ids = new Map(), appended = [], imported = [];
let parsedHTML = "";
class Parser {
  parseFromString(value, type) {
    assert.equal(type, "text/html"); parsedHTML = value;
    return { body: { childNodes: [{ namespaceURI: "http://www.w3.org/1999/xhtml", html: value }] } };
  }
}
const xmlDoc = {
  contentType: "application/xhtml+xml", defaultView: { DOMParser: Parser },
  head: { appendChild(node) { appended.push(node); ids.set(node.id, node); } },
  getElementById(id) { return ids.get(id); },
  createElementNS(namespaceURI, tagName) { return { namespaceURI, tagName, attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } }; },
  importNode(node, deep) { assert.equal(deep, true); imported.push(node); return node; }
};
const xmlContainer = { ownerDocument: xmlDoc, replaceChildren(...nodes) { this.nodes = nodes; } };
renderer.render(xmlContainer, "$\\sqrt{x}$");
assert.equal(parsedHTML, renderer.toHTML("$\\sqrt{x}$"));
assert.equal(imported.length, 1);
assert.equal(appended.length, 2);
assert.equal(ids.get("si-katex-styles").attributes.href, "chrome://zoteromineru/content/styles/katex.css");
renderer.render(xmlContainer, "$y$");
assert.equal(appended.length, 2, "local styles are inserted once per document");
const noVendor = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(scripts, "markdown_renderer.js"), "utf8"), noVendor);
assert.match(noVendor.MarkdownRenderer.toHTML("$x$"), /si-math-error/);
assert.equal(noVendor.MarkdownRenderer.toNoteHTML("$x$"), '<p><span class="math">$x$</span></p>');
assert.match(fs.readFileSync(path.join(scripts, "vendor/KaTeX-LICENSE.txt"), "utf8"), /MIT License/);
console.log("Math rendering tests passed (offline KaTeX, delimiters, real formulas, code isolation, native note math, XML rendering, and security).");
