// input: Zotero Item, Attachment PDF file, Note content
// output: Binary file stream, Zotero child note, Item tags, Progress notifications
// pos: Data and runtime adapter bridging Zotero 10 internals with external service layers

/**
 * Zotero 10 平台操作适配层 (Zotero 10 Platform Adapter)
 */
var ZoteroAdapter = {
  getSelectedItems() {
    const pane = Zotero.getActiveZoteroPane();
    const raw = Array.from(pane?.getSelectedItems?.() || []).filter(item => !item.deleted &&
      (item.isRegularItem?.() || (item.isAttachment?.() && item.attachmentContentType === "application/pdf")));
    const normalized = [];
    const seenIDs = new Set();
    for (const item of raw) {
      let target = item;
      if (item.isAttachment?.() && item.parentItemID) {
        const parent = Zotero.Items.get(item.parentItemID);
        if (parent && !parent.deleted) target = parent;
      }
      if (!seenIDs.has(target.id)) {
        seenIDs.add(target.id);
        normalized.push(target);
      }
    }
    return normalized;
  },
  /**
   * 获取当前选中的常规文献条目或 PDF 附件
   */
  getSelectedItem() {
    const pane = Zotero.getActiveZoteroPane();
    if (!pane) return null;
    const items = pane.getSelectedItems();
    if (!items || items.length === 0) return null;
    return items[0];
  },

  /**
   * 解析条目的核心主 PDF 文件路径与文件对象
   * @param {Zotero.Item} item
   * @returns {Promise<{filePath: string, fileName: string, parentItem: Zotero.Item}|null>}
   */
  async getPdfAttachment(item) {
    if (!item) return null;

    // 如果选中的本身就是 PDF 附件
    if (item.isAttachment() && item.attachmentContentType === "application/pdf") {
      const filePath = await item.getFilePathAsync();
      const parentItem = item.isTopLevelItem() ? item : Zotero.Items.get(item.parentItemID);
      return {
        filePath,
        fileName: item.attachmentFilename || "document.pdf",
        parentItem,
        attachmentItem: item
      };
    }

    // 如果选中的是常规文献条目，查找其子附件中的主 PDF
    if (item.isRegularItem()) {
      const attachmentIDs = item.getAttachments();
      for (const id of attachmentIDs) {
        const att = Zotero.Items.get(id);
        if (att && att.isAttachment() && att.attachmentContentType === "application/pdf") {
          const filePath = await att.getFilePathAsync();
          if (filePath) {
            return {
              filePath,
              fileName: att.attachmentFilename || `${item.getField("title") || "document"}.pdf`,
              parentItem: item,
              attachmentItem: att
            };
          }
        }
      }
    }

    return null;
  },

  /**
   * 读取本地 PDF 文件的二进制流数据
   * @param {string} filePath 绝对文件路径
   * @returns {Promise<Uint8Array>}
   */
  async readFileBinary(filePath) {
    if (typeof IOUtils !== "undefined" && IOUtils.read) {
      return await IOUtils.read(filePath);
    } else if (typeof OS !== "undefined" && OS.File) {
      return await OS.File.read(filePath);
    } else if (Zotero.File && Zotero.File.getBinaryContentsAsync) {
      return await Zotero.File.getBinaryContentsAsync(filePath);
    } else {
      throw new Error("当前环境缺少支持的文件读取 API (IOUtils / OS.File)");
    }
  },

  /**
   * 将 Markdown 转换为 HTML 并作为独立子笔记附加至文献条目
   * @param {Zotero.Item} targetItem 目标文献条目
   * @param {string} title 笔记标题
   * @param {string} markdownContent Markdown 内容
   */
  async createChildNote(targetItem, title, markdownContent) {
    if (!targetItem) return;

    const htmlContent = MarkdownRenderer.toNoteHTML ? MarkdownRenderer.toNoteHTML(markdownContent) : MarkdownRenderer.toHTML(markdownContent);

    const noteItem = new Zotero.Item("note");
    if (targetItem.isAttachment?.()) {
      if (targetItem.parentItemID) {
        noteItem.parentID = targetItem.parentItemID;
      } else if (!targetItem.isTopLevelItem?.() && targetItem.parentID) {
        noteItem.parentID = targetItem.parentID;
      }
    } else {
      noteItem.parentID = targetItem.id;
    }
    noteItem.libraryID = targetItem.libraryID;
    noteItem.setNote(`<h2>${MarkdownRenderer.escape(title)}</h2><hr/>${htmlContent}`);
    await noteItem.saveTx();

    return noteItem;
  },

  /** Save the current reader conversation as a readable Zotero note. */
  async saveConversationNote(attachment, history, existingNoteID = null) {
    if (!history?.length) throw new Error("当前还没有可以保存的对话。");
    const parent = attachment.parentItemID ? Zotero.Items.get(attachment.parentItemID) : null;
    let note = existingNoteID ? Zotero.Items.get(existingNoteID) : null;
    if (!note?.isNote?.() || note.deleted || note.libraryID !== attachment.libraryID || (note.parentID || null) !== (parent?.id || null)) {
      note = new Zotero.Item("note");
      note.libraryID = attachment.libraryID;
      if (parent) note.parentID = parent.id;
    }
    const source = parent?.getField?.("title") || attachment.attachmentFilename || "PDF";
    const title = `AI 阅读对话 · ${source}`;
    const sections = history.map((entry, index) => entry.role === "user"
      ? `<h3>问题 ${Math.floor(index / 2) + 1}</h3><p>${MarkdownRenderer.inline(entry.content, { mathOutput: "zotero" })}</p>`
      : `<h3>AI 回答</h3>${MarkdownRenderer.toNoteHTML ? MarkdownRenderer.toNoteHTML(entry.content) : MarkdownRenderer.toHTML(entry.content)}`);
    note.setNote(`<h2>${MarkdownRenderer.escape(title)}</h2>` +
      `<p>来源 PDF：${MarkdownRenderer.escape(attachment.attachmentFilename || source)}</p>` +
      sections.join("<hr/>"));
    await note.saveTx();
    return note;
  },

  /**
   * 为文献条目添加专属标签
   * @param {Zotero.Item} targetItem
   * @param {string[]} tags
   */
  async addTagsToItem(targetItem, tags = ["#MinerU-Extracted"]) {
    if (!targetItem) return;
    for (const tag of tags) {
      targetItem.addTag(tag, 1);
    }
    await targetItem.saveTx();
  },

  /**
   * 创建并显示 Zotero 进度提示弹窗
   * @param {string} headline 标题
   * @returns {{update: Function, done: Function, fail: Function}}
   */
  createProgressNotifier(headline = "MinerU 文档智能解析") {
    const pw = new Zotero.ProgressWindow({ closeOnClick: true });
    pw.changeHeadline(headline);
    pw.show();

    const itemProgress = new pw.ItemProgress(
      "chrome://zoteromineru/content/icons/favicon.png",
      "初始化准备中..."
    );

    return {
      update(text, percent = null) {
        itemProgress.setText(text);
        if (percent !== null) {
          itemProgress.setProgress(percent);
        }
      },
      done(finalText = "解析与处理完成！") {
        itemProgress.setIcon("chrome://zoteromineru/content/icons/tick.png");
        itemProgress.setText(finalText);
        itemProgress.setProgress(100);
        pw.startCloseTimer(4000);
      },
      fail(errText = "处理失败") {
        itemProgress.setIcon("chrome://zoteromineru/content/icons/cross.png");
        itemProgress.setText(errText);
        pw.startCloseTimer(6000);
      }
    };
  }
};
