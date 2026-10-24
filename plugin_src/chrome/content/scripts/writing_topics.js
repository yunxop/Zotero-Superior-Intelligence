// Topic IDs and record associations are persistent; legacy names remain in snapshots.
Object.assign(SIWritingStore, {
  async initTopics() {
    await this.db.queryAsync('CREATE TABLE IF NOT EXISTS writing_topics (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
    await this.db.queryAsync('CREATE TABLE IF NOT EXISTS writing_batches (id TEXT PRIMARY KEY, topicID TEXT NOT NULL, data TEXT NOT NULL)');
    await this.db.queryAsync('CREATE INDEX IF NOT EXISTS writing_batch_topic ON writing_batches(topicID)');
    await this.db.queryAsync('CREATE TABLE IF NOT EXISTS writing_meta (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
    await this.db.queryAsync('CREATE TABLE IF NOT EXISTS writing_legacy_records (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
    if (!(await this.db.queryAsync("SELECT value FROM writing_meta WHERE id='topics-v2'")).length) {
      await this.db.executeTransaction(async () => {
        const rows = await this.db.queryAsync('SELECT id, data FROM writing_records');
        const byName = new Map();
        for (const row of rows) {
          const r = JSON.parse(row.data);
          await this.db.queryAsync('INSERT OR IGNORE INTO writing_legacy_records VALUES (?, ?)', [row.id, row.data]);
          r.topicIds = [];
          for (const name of new Set(r.topics || [r.topic])) {
            if (!name) continue;
            if (!byName.has(name)) {
              const t = this.newTopic(name, { id: 'topic-' + TaskCheckpointCache.hashText(name), instruction: name });
              byName.set(name,t);
              await this.db.queryAsync('INSERT OR IGNORE INTO writing_topics VALUES (?, ?)', [t.id,JSON.stringify(t)]);
            }
            r.topicIds.push(byName.get(name).id);
          }
          await this.db.queryAsync('UPDATE writing_records SET data=? WHERE id=?', [JSON.stringify(r),r.id]);
        }
        // Reuse existing per-paper notes after migration without editing the note bodies.
        for (const row of await this.db.queryAsync('SELECT id, noteID FROM writing_notes')) {
          const split = row.id.indexOf(':', row.id.indexOf(':') + 1);
          if (split < 0) continue;
          const t = byName.get(row.id.slice(split+1));
          if (t) await this.db.queryAsync('INSERT OR IGNORE INTO writing_notes VALUES (?, ?)', [row.id.slice(0,split+1)+t.id,row.noteID]);
        }
        await this.db.queryAsync("INSERT INTO writing_meta VALUES ('topics-v2', '1')");
      });
    }
    for (const row of await this.db.queryAsync('SELECT data FROM writing_batches')) {
      const b = JSON.parse(row.data);
      if (b.status === 'running') { b.status='interrupted'; b.finishedAt=new Date().toISOString(); await this.db.queryAsync('UPDATE writing_batches SET data=? WHERE id=?',[JSON.stringify(b),b.id]); }
    }
  },
  newTopic(name, fields = {}) {
    const now = new Date().toISOString();
    return { id:'topic-'+TaskCheckpointCache.hashText(now+Math.random()), name, description:'', instruction:name,
      folder:'', tags:[], aliases:[], pinned:false, archived:false, deletedAt:null, createdAt:now, updatedAt:now, lastUsedAt:null, ...fields };
  },
  async rawTopics() { return (await this.db.queryAsync('SELECT data FROM writing_topics')).map(row=>JSON.parse(row.data)); },
  async topicByID(id) {
    const rows = await this.db.queryAsync('SELECT data FROM writing_topics WHERE id=?',[id]);
    if (!rows.length) throw new Error('主题不存在。');
    return JSON.parse(rows[0].data);
  },
  async ensureTopic(name, id, instruction) {
    if (id) { const t=await this.topicByID(id); if(t.deletedAt || t.mergedInto) throw new Error('主题已删除或合并，请选择有效主题。'); return t; }
    name=String(name||'').trim();
    if (!name || name.length>1000) throw new Error('主题名称需要 1–1000 字符。');
    const found=(await this.rawTopics()).find(t=>t.name===name && !t.mergedInto && !t.deletedAt);
    if (found) return found;
    const t=this.newTopic(name, instruction ? {instruction} : {}); await this.db.queryAsync('INSERT INTO writing_topics VALUES (?, ?)',[t.id,JSON.stringify(t)]); return t;
  },
  async saveTopic(input) {
    await this.open(); let saved;
    await this.db.executeTransaction(async()=>{
      const t=input.id ? await this.topicByID(input.id) : this.newTopic('');
      if (t.mergedInto) throw new Error('该主题已合并，请编辑目标主题。');
      const old=t.name;
      for (const key of ['name','description','instruction','folder']) if (input[key]!=null) t[key]=String(input[key]).trim();
      if (!t.name || t.name.length>1000 || t.description.length>5000 || t.instruction.length>10000) throw new Error('主题名称、说明或指令长度无效。');
      const folders=t.folder.split('/').map(x=>x.trim()).filter(Boolean);
      if (folders.length>3 || t.folder.length>300) throw new Error('文件夹最多三层，例如 城市气候/热岛/植被。');
      t.folder=folders.join('/');
      if (input.tags!=null) {
        if (!Array.isArray(input.tags) || input.tags.length>30 || input.tags.some(v=>typeof v!=='string'||v.length>100)) throw new Error('最多 30 个标签，每个不超过 100 字符。');
        t.tags=[...new Set(input.tags.map(v=>v.trim()).filter(Boolean))];
      }
      for (const key of ['pinned','archived']) if (typeof input[key]==='boolean') t[key]=input[key];
      if (input.deletedAt === null) t.deletedAt=null;
      if ((await this.rawTopics()).some(x=>x.id!==t.id && x.name===t.name && !x.deletedAt && !x.mergedInto)) throw new Error('同名主题已存在，请使用合并操作。');
      if (old && old!==t.name) t.aliases=[...new Set([...t.aliases,old])];
      t.updatedAt=new Date().toISOString();
      await this.db.queryAsync('INSERT OR REPLACE INTO writing_topics VALUES (?, ?)',[t.id,JSON.stringify(t)]); saved=t;
    });
    await this.mirror(); return saved;
  },
  async listTopics({query='',state='active',folder='',tag='',sort='recent',offset=0,limit=30}={}) {
    await this.open();
    const all=await this.rawTopics(), records=await this.records();
    const stats=new Map(all.map(t=>[t.id,{count:0,papers:new Set(),pending:0}]));
    for(const r of records) for(const id of r.topicIds||[]) {
      const v=stats.get(id); if (!v) continue; v.count++; if(r.status==='pending') v.pending++;
      v.papers.add(`${r.source.libraryID}:${r.source.attachmentKey}`);
    }
    const q=String(query).trim().toLowerCase();
    let rows=all.filter(t=>!t.mergedInto && (state==='trash' ? !!t.deletedAt : !t.deletedAt && (state==='all' || (state==='archived' ? t.archived : !t.archived))) &&
      (!folder || t.folder===folder || t.folder.startsWith(folder+'/')) && (!tag || t.tags.includes(tag)) &&
      (!q || [t.name,t.description,...t.tags,...t.aliases].join(' ').toLowerCase().includes(q)))
      .map(t=>({...t,topic:t.name,count:stats.get(t.id).count,papers:stats.get(t.id).papers.size,pending:stats.get(t.id).pending}));
    rows.sort((a,b)=>Number(b.pinned)-Number(a.pinned) || (sort==='name' ? a.name.localeCompare(b.name) : sort==='count' ? b.count-a.count : String(b[sort==='updated'?'updatedAt':'lastUsedAt']||b.updatedAt).localeCompare(String(a[sort==='updated'?'updatedAt':'lastUsedAt']||a.updatedAt))));
    offset=Math.max(0,Number(offset)||0); limit=Math.max(1,Math.min(1000,Number(limit)||30));
    return {total:rows.length,topics:rows.slice(offset,offset+limit),folders:[...new Set(all.filter(t=>!t.deletedAt&&!t.mergedInto).map(t=>t.folder).filter(Boolean))].sort(),tags:[...new Set(all.filter(t=>!t.deletedAt&&!t.mergedInto).flatMap(t=>t.tags))].sort()};
  },
  async deleteTopic(id) {
    await this.open();
    await this.db.executeTransaction(async()=>{
      const t=await this.topicByID(id); if(t.mergedInto) throw new Error('主题已合并。');
      t.deletedAt=new Date().toISOString(); t.updatedAt=t.deletedAt;
      await this.db.queryAsync('UPDATE writing_topics SET data=? WHERE id=?',[JSON.stringify(t),id]);
    }); await this.mirror();
  },
  async mergeTopics(fromID,toID) {
    if(fromID===toID) throw new Error('不能合并到自身。');
    await this.open();
    await this.db.executeTransaction(async()=>{
      const from=await this.topicByID(fromID),to=await this.topicByID(toID);
      if(from.deletedAt||to.deletedAt||from.mergedInto||to.mergedInto) throw new Error('只能合并未删除的主题。');
      for(const row of await this.db.queryAsync('SELECT data FROM writing_records')) {
        const r=JSON.parse(row.data); if(!(r.topicIds||[]).includes(fromID)) continue;
        r.topicIds=[...new Set(r.topicIds.map(id=>id===fromID?toID:id))];
        await this.db.queryAsync('UPDATE writing_records SET data=? WHERE id=?',[JSON.stringify(r),r.id]);
      }
      for(const row of await this.db.queryAsync('SELECT data FROM writing_batches WHERE topicID=?',[fromID])) {
        const b=JSON.parse(row.data); b.topicID=toID;
        await this.db.queryAsync('UPDATE writing_batches SET topicID=?, data=? WHERE id=?',[toID,JSON.stringify(b),b.id]);
      }
      to.aliases=[...new Set([...to.aliases,from.name,...from.aliases])]; to.tags=[...new Set([...to.tags,...from.tags])];
      to.updatedAt=new Date().toISOString(); from.mergedInto=toID; from.deletedAt=to.updatedAt;
      await this.db.queryAsync('UPDATE writing_topics SET data=? WHERE id=?',[JSON.stringify(to),toID]);
      await this.db.queryAsync('UPDATE writing_topics SET data=? WHERE id=?',[JSON.stringify(from),fromID]);
    }); await this.mirror();
  },
  async linkRecords(ids,fromID,toID,mode) {
    if(!['link','move','unlink'].includes(mode)||!Array.isArray(ids)||!ids.length||ids.length>1000) throw new Error('请选择记录和有效操作。');
    if(mode==='move'&&fromID===toID) throw new Error('目标主题不能与当前主题相同。');
    await this.open();
    await this.db.executeTransaction(async()=>{
      if(mode!=='link') { const t=await this.topicByID(fromID); if(t.deletedAt||t.mergedInto) throw new Error('请先选择有效的当前主题。'); }
      if(mode!=='unlink') { const t=await this.topicByID(toID); if(t.deletedAt||t.mergedInto) throw new Error('请选择有效目标主题。'); }
      for(const id of new Set(ids)) {
        const rows=await this.db.queryAsync('SELECT data FROM writing_records WHERE id=?',[id]); if(!rows.length) continue;
        const r=JSON.parse(rows[0].data); if(r.deletedAt) continue;
        if(mode!=='link' && !(r.topicIds||[]).includes(fromID)) continue;
        r.topicIds=(r.topicIds||[]).filter(id=>mode==='link'||id!==fromID);
        if(mode!=='unlink') r.topicIds=[...new Set([...r.topicIds,toID])];
        await this.db.queryAsync('UPDATE writing_records SET data=? WHERE id=?',[JSON.stringify(r),id]);
      }
    }); await this.mirror();
  },
  async saveBatch(batch) {
    await this.open();
    await this.db.queryAsync('INSERT OR REPLACE INTO writing_batches VALUES (?, ?, ?)',[batch.id,batch.topicID,JSON.stringify(batch)]);
  },
  async batches(topicID,offset=0) {
    await this.open();
    const rows=(await this.db.queryAsync('SELECT data FROM writing_batches WHERE topicID=? ORDER BY rowid DESC',[topicID])).map(r=>JSON.parse(r.data));
    return {total:rows.length,batches:rows.slice(Math.max(0,offset),Math.max(0,offset)+20)};
  }
});
