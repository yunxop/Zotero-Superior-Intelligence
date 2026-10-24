const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const rows = new Map();
let selected = [], activePane = true;
const savedNotes = [];
function paper(id, attachments) {
  const item = { id, libraryID: 1, isAttachment: () => false, isRegularItem: () => true,
    getAttachments: () => attachments, getField: () => `Paper ${id}` };
  rows.set(id, item);
  return item;
}
function pdf(id, parentItemID, fileName) {
  const item = { id, parentItemID, libraryID: 1, attachmentFilename: fileName,
    attachmentContentType: 'application/pdf', isAttachment: () => true,
    isRegularItem: () => false, isTopLevelItem: () => !parentItemID,
    getFilePathAsync: async () => `C:/library/${fileName}` };
  rows.set(id, item);
  return item;
}
const parent = paper(1, [11, 12]), otherParent = paper(2, [21]);
const first = pdf(11, 1, 'main.pdf'), second = pdf(12, 1, 'supplement.pdf');
const otherPDF = pdf(21, 2, 'other.pdf'), standalone = pdf(31, null, 'standalone.pdf');
const deleted = { ...pdf(41, 1, 'deleted.pdf'), deleted: true };
const nonPDF = { ...pdf(42, 1, 'web.html'), attachmentContentType: 'text/html' };
const note = { id: 50, isAttachment: () => false, isRegularItem: () => false };
const context = vm.createContext({
  Zotero: {
    getActiveZoteroPane: () => activePane ? { getSelectedItems: () => selected } : null,
    Items: { get: id => rows.get(id) }, logError() {},
    Item: class {
      constructor(type) { assert.equal(type, 'note'); }
      setNote(html) { this.html = html; }
      async saveTx() { this.id = 100 + savedNotes.length; savedNotes.push(this); }
    }
  },
  MarkdownRenderer: { escape: value => value, toNoteHTML: value => `<p>${value}</p>` }
});
vm.runInContext(fs.readFileSync('plugin_src/chrome/content/scripts/zotero_adapter.js', 'utf8'), context);
vm.runInContext(fs.readFileSync('plugin_src/chrome/content/scripts/batch.js', 'utf8'), context);
const adapter = context.ZoteroAdapter;
const selectedIDs = () => Array.from(adapter.getSelectedItems(), item => item.id);

(async () => {
  selected = [second];
  assert.deepEqual(selectedIDs(), [12]);
  assert.equal(adapter.getSelectedItem(), second);
  const info = await adapter.getPdfAttachment(adapter.getSelectedItem());
  assert.equal(info.attachmentItem, second);
  assert.equal(info.fileName, 'supplement.pdf');
  assert.equal(info.filePath, 'C:/library/supplement.pdf');
  assert.equal(info.parentItem, parent);

  selected = [parent, second, second, otherParent, first];
  assert.deepEqual(selectedIDs(), [12, 2, 11]);
  selected = [first, second];
  assert.deepEqual(selectedIDs(), [11, 12]);
  selected = [parent];
  assert.equal((await adapter.getPdfAttachment(adapter.getSelectedItem())).attachmentItem, first);
  selected = [note, deleted, nonPDF, standalone];
  assert.deepEqual(selectedIDs(), [31]);
  assert.equal((await adapter.getPdfAttachment(adapter.getSelectedItem())).parentItem, standalone);
  selected = [];
  assert.equal(adapter.getSelectedItem(), null);
  activePane = false;
  assert.deepEqual(selectedIDs(), []);
  assert.equal(adapter.getSelectedItem(), null);
  activePane = true;

  const childNote = await adapter.createChildNote(info.parentItem, 'Summary', 'result');
  assert.equal(childNote.parentID, 1);
  const attachmentNote = await adapter.createChildNote(second, 'Summary', 'result');
  assert.equal(attachmentNote.parentID, 1);
  const topLevelNote = await adapter.createChildNote(standalone, 'Summary', 'result');
  assert.equal(topLevelNote.parentID, undefined);
  assert.equal(topLevelNote.libraryID, 1);

  // Resolve the exact selected attachments through the real batch queue, including
  // parent/child overlap, and save each result back to its bibliographic parent.
  selected = [parent, second, first, otherParent, standalone];
  const processed = [], parentIDs = [], tasks = [];
  const app = {
    saveSummaryPrompt() {}, describeError: error => error.message,
    startSummaryTask(task) { tasks.push({ ...task }); return tasks.length - 1; },
    updateSummaryTask(id, change) { Object.assign(tasks[id], change); },
    async summarizeItem(item) {
      processed.push(item.id);
      const attachmentInfo = await adapter.getPdfAttachment(item);
      return { markdown: 'result', parentItem: attachmentInfo.parentItem };
    },
    async saveSummary(result) {
      const saved = await adapter.createChildNote(result.parentItem, 'Summary', result.markdown);
      parentIDs.push(saved.parentID || null);
      return saved;
    }
  };
  const totals = JSON.parse(await context.SIBatch.run(app, selectedIDs(), 'paper_summary', {}, 'prompt'));
  assert.deepEqual(processed, [12, 11, 21, 31]);
  assert.deepEqual(parentIDs, [1, 1, 2, null]);
  assert.equal(totals.completed, 4);
  assert.equal(totals.failed, 0);

  // A missing explicitly chosen PDF must not silently switch to its sibling.
  second.getFilePathAsync = async () => false;
  selected = [parent, second];
  const missing = await adapter.getPdfAttachment(adapter.getSelectedItem());
  assert.equal(missing.attachmentItem, second);
  assert.equal(missing.filePath, false);
  console.log('attachment selection tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
