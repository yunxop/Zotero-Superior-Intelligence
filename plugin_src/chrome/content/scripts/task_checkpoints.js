// Persistent, bounded checkpoints contain only completed task results, never API credentials or source documents.
var TaskCheckpointCache = {
  version: 1,
  maxEntries: 40,
  maxBytes: 8 * 1024 * 1024,
  maxAgeMs: 30 * 24 * 60 * 60 * 1000,
  entries: new Map(),
  _loadPromise: null,
  _writeChain: Promise.resolve(),
  lastError: null,

  hashText(value) {
    // SHA-256 works in bootstrap scopes and test VMs without a DOM crypto object.
    const bytes = [];
    for (const character of String(value ?? "")) {
      let n = character.codePointAt(0);
      if (n >= 0xD800 && n <= 0xDFFF) n = 0xFFFD;
      if (n < 0x80) bytes.push(n);
      else if (n < 0x800) bytes.push(0xC0 | (n >> 6), 0x80 | (n & 63));
      else if (n < 0x10000) bytes.push(0xE0 | (n >> 12), 0x80 | ((n >> 6) & 63), 0x80 | (n & 63));
      else bytes.push(0xF0 | (n >> 18), 0x80 | ((n >> 12) & 63), 0x80 | ((n >> 6) & 63), 0x80 | (n & 63));
    }
    const length = bytes.length;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    const high = Math.floor(length / 0x20000000), low = (length * 8) >>> 0;
    for (let shift = 24; shift >= 0; shift -= 8) bytes.push((high >>> shift) & 255);
    for (let shift = 24; shift >= 0; shift -= 8) bytes.push((low >>> shift) & 255);
    const constants = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
    const state = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
    const rotate = (x, n) => (x >>> n) | (x << (32 - n));
    for (let offset = 0; offset < bytes.length; offset += 64) {
      const words = new Array(64);
      for (let i = 0; i < 16; i++) words[i] = ((bytes[offset+i*4] << 24) | (bytes[offset+i*4+1] << 16) | (bytes[offset+i*4+2] << 8) | bytes[offset+i*4+3]) >>> 0;
      for (let i = 16; i < 64; i++) {
        const a = words[i-15], b = words[i-2];
        words[i] = (words[i-16] + (rotate(a,7) ^ rotate(a,18) ^ (a >>> 3)) + words[i-7] + (rotate(b,17) ^ rotate(b,19) ^ (b >>> 10))) >>> 0;
      }
      let [a,b,c,d,e,f,g,h] = state;
      for (let i = 0; i < 64; i++) {
        const t1 = (h + (rotate(e,6) ^ rotate(e,11) ^ rotate(e,25)) + ((e & f) ^ (~e & g)) + constants[i] + words[i]) >>> 0;
        const t2 = ((rotate(a,2) ^ rotate(a,13) ^ rotate(a,22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
        h=g; g=f; f=e; e=(d+t1)>>>0; d=c; c=b; b=a; a=(t1+t2)>>>0;
      }
      for (const [i, n] of [a,b,c,d,e,f,g,h].entries()) state[i] = (state[i] + n) >>> 0;
    }
    return state.map(n => n.toString(16).padStart(8,"0")).join("");
  },

  _stable(value) {
    if (Array.isArray(value)) return value.map(item => this._stable(item));
    if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, this._stable(value[key])]));
    return value;
  },
  keyFor(resumeKey, identity) { return this.hashText(JSON.stringify(this._stable({ resumeKey: String(resumeKey || ""), identity }))); },
  _copy(value) { return JSON.parse(JSON.stringify(value)); },
  _sanitize(value) {
    if (Array.isArray(value)) return value.map(item => this._sanitize(item));
    if (!value || typeof value !== "object") return value;
    const clean = {};
    for (const [key, item] of Object.entries(value)) {
      if (/^(?:.*api.?key|token|authorization|credentials|config|source|markdownText|fileBuffer)$/i.test(key)) continue;
      clean[key] = this._sanitize(item);
    }
    return clean;
  },
  _path() {
    try {
      if (typeof IOUtils === "undefined" || typeof Zotero === "undefined") return null;
      const directory = Zotero.DataDirectory?.dir;
      if (!directory) return null;
      if (typeof PathUtils !== "undefined") return PathUtils.join(directory, "si-task-checkpoints-v1.json");
      return String(directory).replace(/[\\/]$/, "") + (String(directory).includes("\\") ? "\\" : "/") + "si-task-checkpoints-v1.json";
    } catch (_error) { return null; }
  },
  _report(error) {
    this.lastError = error;
    try { Zotero.logError?.("[SI] Task checkpoint storage unavailable: " + String(error?.message || error)); } catch (_error) {}
  },
  async _load() {
    if (!this._loadPromise) this._loadPromise = (async () => {
      const path = this._path();
      if (!path) return;
      try {
        const data = await IOUtils.readJSON(path);
        if (data?.version === this.version && Array.isArray(data.entries)) {
          for (const entry of data.entries) if (typeof entry?.key === "string" && entry.record && typeof entry.record.resumeKey === "string") this.entries.set(entry.key, this._sanitize(entry.record));
        }
      } catch (error) { if (error?.name !== "NotFoundError") this._report(error); }
      this._prune();
    })();
    await this._loadPromise;
  },
  _prune() {
    const now = Date.now();
    for (const [key, record] of this.entries) if (!Number.isFinite(record.updatedAt) || now - record.updatedAt > this.maxAgeMs) this.entries.delete(key);
    const newest = [...this.entries].reverse().sort((a,b) => b[1].updatedAt - a[1].updatedAt);
    this.entries = new Map();
    let bytes = 0;
    for (const [key, record] of newest) {
      // Three bytes per UTF-16 unit is a conservative UTF-8 storage bound.
      const size = JSON.stringify({ key, record }).length * 3;
      if (this.entries.size >= this.maxEntries || bytes + size > this.maxBytes) continue;
      this.entries.set(key, record); bytes += size;
    }
  },
  async _persist() {
    const path = this._path();
    if (!path) return false;
    const snapshot = { version: this.version, entries: [...this.entries].map(([key,record]) => ({key,record:this._copy(record)})) };
    this._writeChain = this._writeChain.catch(() => {}).then(async () => {
      try {
        await IOUtils.writeJSON(path, snapshot, { tmpPath: path + ".tmp", flush: true });
        this.lastError = null;
        return true;
      } catch (error) { this._report(error); return false; }
    });
    return this._writeChain;
  },
  async get(key) {
    await this._load(); this._prune();
    const record = this.entries.get(key);
    return record ? this._copy(record) : null;
  },
  async put(key, record, options = {}) {
    await this._load();
    const incoming = this._sanitize(this._copy(record));
    const existing = this.entries.get(key);
    let accepted = incoming;
    // A complete summary is canonical for its identity. Concurrent analysis snapshots
    // must not replace its final, completed stages, or the link to the saved note.
    if (existing?.kind === "paper-summary" && typeof existing.final === "string" && existing.final) {
      accepted = this._copy(existing);
      if (Object.prototype.hasOwnProperty.call(incoming, "noteID") && (options.updateNoteID === true || existing.noteID == null)) {
        accepted.noteID = incoming.noteID;
      }
    }
    this.entries.set(key, { ...accepted, updatedAt: Date.now() });
    this._prune();
    return this._persist();
  },
  async clear(resumeKey) {
    await this._load();
    for (const [key, record] of this.entries) if (resumeKey == null || record.resumeKey === String(resumeKey)) this.entries.delete(key);
    return this._persist();
  },
  async resumeInfo(resumeKey) {
    await this._load(); this._prune();
    const records = [...this.entries.values()].filter(record => record.resumeKey === String(resumeKey)).sort((a,b) => b.updatedAt-a.updatedAt);
    if (!records.length) return null;
    const record = records[0];
    return { entries: records.length, completed: record.completed || 0, total: record.total || 0, stage: record.stage || "", updatedAt: record.updatedAt, hasFinal: typeof record.final === "string" && !!record.final, persistent: !!this._path() && !this.lastError };
  }
};