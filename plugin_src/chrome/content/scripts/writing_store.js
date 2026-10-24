// Dedicated plugin database; never changes Zotero's own schema.
var SIWritingStore = {
  async open() {
    if (!this.ready) this.ready = this.initialize().catch(error => { this.ready = null; throw error; });
    return this.ready;
  },
  async initialize() {
    this.db = this.db || new Zotero.DBConnection("si-writing");
    await this.db.queryAsync("CREATE TABLE IF NOT EXISTS writing_chunks (id TEXT PRIMARY KEY, attachment TEXT NOT NULL, data TEXT NOT NULL)");
    await this.db.queryAsync("CREATE INDEX IF NOT EXISTS writing_attachment ON writing_chunks(attachment)");
    await this.db.queryAsync("CREATE TABLE IF NOT EXISTS writing_records (id TEXT PRIMARY KEY, status TEXT NOT NULL, data TEXT NOT NULL)");
    await this.db.queryAsync("CREATE TABLE IF NOT EXISTS writing_notes (id TEXT PRIMARY KEY, noteID INTEGER NOT NULL)");
    await this.initTopics();
    this.directory = PathUtils.join(Zotero.DataDirectory.dir, "si-writing");
    await IOUtils.makeDirectory(this.directory, { ignoreExisting: true });
  },
  async chunks(attachment) {
    await this.open();
    return (await this.db.queryAsync("SELECT data FROM writing_chunks WHERE attachment=?", [attachment])).map(row => JSON.parse(row.data));
  },
  async saveChunks(attachment, chunks) {
    await this.open();
    await this.db.executeTransaction(async () => {
      await this.db.queryAsync("DELETE FROM writing_chunks WHERE attachment=?", [attachment]);
      for (const c of chunks) await this.db.queryAsync("INSERT INTO writing_chunks VALUES (?, ?, ?)", [c.id, attachment, JSON.stringify(c)]);
    });
  },
  async records(includeDeleted = false) {
    await this.open();
    const topics = new Map((await this.rawTopics()).filter(t => !t.deletedAt && !t.mergedInto).map(t => [t.id,t.name]));
    return (await this.db.queryAsync("SELECT data FROM writing_records ORDER BY rowid DESC")).map(row => {
      const r=JSON.parse(row.data);
      return {...r, topics:(r.topicIds||[]).map(id=>topics.get(id)).filter(Boolean)};
    }).filter(r => includeDeleted || !r.deletedAt);
  },
  async noteID(id, value) {
    await this.open();
    if (value != null) await this.db.queryAsync("INSERT OR REPLACE INTO writing_notes VALUES (?, ?)", [id, value]);
    const rows = await this.db.queryAsync("SELECT noteID FROM writing_notes WHERE id=?", [id]);
    return rows[0]?.noteID || null;
  },
  async add(records) {
    await this.open();
    await this.db.executeTransaction(async () => {
      for (const r of records) {
        const topic = await this.ensureTopic(r.topic, r.topicId);
        const rows = await this.db.queryAsync("SELECT data FROM writing_records WHERE id=?", [r.id]);
        if (rows.length) {
          const saved = JSON.parse(rows[0].data);
          saved.topicIds = [...new Set([...(saved.topicIds || []), topic.id])];
          await this.db.queryAsync("UPDATE writing_records SET data=? WHERE id=?", [JSON.stringify(saved), r.id]);
        } else {
          const saved = { ...r, topicIds: [topic.id] };
          await this.db.queryAsync("INSERT INTO writing_records VALUES (?, ?, ?)", [r.id, r.status, JSON.stringify(saved)]);
        }
      }
    });
    await this.mirror();
  },
  async remove(ids, restore = false) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 1000 || ids.some(id => typeof id !== "string")) throw new Error("请选择 1–1000 条记录。");
    await this.open();
    await this.db.executeTransaction(async () => {
      for (const id of new Set(ids)) {
        const rows = await this.db.queryAsync("SELECT data FROM writing_records WHERE id=?", [id]);
        if (!rows.length) continue;
        const r = JSON.parse(rows[0].data);
        if (restore) delete r.deletedAt; else r.deletedAt = new Date().toISOString();
        await this.db.queryAsync("UPDATE writing_records SET data=? WHERE id=?", [JSON.stringify(r), id]);
      }
    });
    await this.mirror();
  },
  async review(id, status, reviewerNote, details) {
    if (!["pending", "approved", "rejected"].includes(status)) throw new Error("无效审核状态。");
    await this.open();
    await this.db.executeTransaction(async () => {
      const rows = await this.db.queryAsync("SELECT data FROM writing_records WHERE id=?", [id]);
      if (!rows.length) throw new Error("记录不存在。");
      const r = JSON.parse(rows[0].data);
      if (details) for (const key of Object.keys(r.details)) {
        if (typeof details[key] !== "string" || details[key].length > 5000) throw new Error("审核内容格式无效或超过 5000 字符。");
        r.details[key] = details[key];
      }
      r.status = status; r.reviewerNote = String(reviewerNote || "").slice(0, 5000); r.reviewedAt = new Date().toISOString();
      await this.db.queryAsync("UPDATE writing_records SET status=?, data=? WHERE id=?", [status, JSON.stringify(r), id]);
    });
    await this.mirror();
  },
  async mirror() {
    // Serialize snapshots so an older write cannot overwrite a newer review.
    this.writes = (this.writes || Promise.resolve()).catch(() => {}).then(async () => {
      const path = PathUtils.join(this.directory, "knowledge.md");
      await IOUtils.writeUTF8(path, SIWritingCore.markdown(await this.records()), { tmpPath: path + ".tmp" });
    });
    return this.writes;
  },
  async close() { await this.ready?.catch(() => {}); await this.writes?.catch(() => {}); await this.db?.closeDatabase(); this.ready = null; this.db = null; }
};
