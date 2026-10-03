// input: PDF binary data, MinerU API credentials, parsing mode ('agent' | 'precise')
// output: Structured Markdown document (full.md) and parsing metadata
// pos: Cloud communication layer for OpenDataLab MinerU document parsing service

/**
 * MinerU 文档解析客户端 (MinerU Document Parsing Client)
 * 适配 OpenDataLab MinerU 最新 API (Agent 免登录模式与精准模式)
 */
var MinerUClient = {
  AGENT_BASE_URL: "https://mineru.net/api/v1/agent",
  PRECISE_BASE_URL: "https://mineru.net/api/v4",


  abortError() {
    const error = new Error("任务已取消。");
    error.name = "AbortError"; error.cancelled = true;
    return error;
  },
  throwIfAborted(signal) { if (signal?.aborted) throw this.abortError(); },
  awaitWithSignal(operation, signal) {
    if (!signal) return Promise.resolve(operation);
    return new Promise((resolve, reject) => {
      const cleanup = () => signal.removeEventListener("abort", abort);
      const abort = () => { cleanup(); reject(this.abortError()); };
      signal.addEventListener("abort", abort, { once: true });
      Promise.resolve(operation).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
      if (signal.aborted) abort();
    });
  },
  async _fetch(url, options = {}) {
    const signal = options.signal;
    this.throwIfAborted(signal);
    try {
      const result = await this.awaitWithSignal(fetch(url, options), signal);
      this.throwIfAborted(signal);
      return result;
    } catch (error) {
      if (signal?.aborted || error?.name === "AbortError" || error?.cancelled === true) throw this.abortError();
      throw error;
    }
  },
  wait(ms, signal) {
    this.throwIfAborted(signal);
    return new Promise((resolve, reject) => {
      const cleanup = () => signal?.removeEventListener("abort", abort);
      const abort = () => { clearTimeout(timer); cleanup(); reject(this.abortError()); };
      const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  },
  normalizeToken(value) {
    return String(value || "")
      .trim()
      .replace(/^["']|["']$/g, "")
      .replace(/^Bearer\s+/i, "")
      .replace(/^["']|["']$/g, "")
      .replace(/[\s\u200B-\u200D\uFEFF]/g, "");
  },

  tokenExpiresAt(token) {
    try {
      const encoded = token.split(".")[1];
      if (!encoded) return null;
      const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
      const payload = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")));
      const expiresAt = Number(payload.exp) * 1000;
      return Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt : null;
    } catch (_error) {
      return null;
    }
  },

  /**
   * 模式一：Agent 轻量解析（免 Token、单文件、支持公式与表格）
   * @param {string} fileName 文件名 (如 paper.pdf)
   * @param {ArrayBuffer|Uint8Array} fileBuffer 本地 PDF 二进制数据
   * @param {Function} onProgress 进度回调函数
   * @returns {Promise<{markdown: string, taskId: string}>}
   */
  async parseAgent(fileName, fileBuffer, onProgress = () => {}, options = {}) {
    const signal = options.signal;
    this.throwIfAborted(signal);
    onProgress("正在向 MinerU 申请上传签名链接 (Agent 模式)...");

    // 1. 申请上传签名
    const applyUrl = `${this.AGENT_BASE_URL}/parse/file`;
    const applyPayload = {
      file_name: fileName,
      language: "ch",
      enable_table: true,
      enable_formula: true,
      is_ocr: false
    };

    const applyRes = await this._fetch(applyUrl, {
      method: "POST", signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(applyPayload)
    });

    if (!applyRes.ok) {
      throw new Error(`申请 MinerU 链接失败，HTTP 状态码: ${applyRes.status}`);
    }

    const applyJson = await this.awaitWithSignal(applyRes.json(), signal);
    if (applyJson.code !== 0 || !applyJson.data) {
      throw new Error(`MinerU 签名申请失败: ${applyJson.msg || "未知错误"}`);
    }

    const taskId = applyJson.data.task_id;
    const uploadUrl = applyJson.data.file_url;

    // 2. PUT 上传本地 PDF 二进制流
    onProgress("正在上传文献至 MinerU 高性能解析通道...");
    const uploadRes = await this._fetch(uploadUrl, {
      method: "PUT", signal,
      body: fileBuffer
    });

    if (!uploadRes.ok) {
      throw new Error(`上传文献至 MinerU OSS 失败，HTTP 状态码: ${uploadRes.status}`);
    }

    // 3. 轮询解析任务进度
    onProgress("上传完成，MinerU 正在解析文献版面、表格与公式 (通常耗时 5-25 秒)...");
    const maxPollTimes = 120; // 5 分钟超时
    const pollInterval = 2500; // 每 2.5 秒查询一次

    for (let i = 0; i < maxPollTimes; i++) {
      await this.wait(pollInterval, signal);

      const pollUrl = `${this.AGENT_BASE_URL}/parse/${taskId}`;
      const pollRes = await this._fetch(pollUrl, { signal });
      if (!pollRes.ok) continue;

      const pollJson = await this.awaitWithSignal(pollRes.json(), signal);
      if (pollJson.code !== 0) continue;

      const taskState = pollJson.data?.state;
      if (taskState === "done") {
        const mdUrl = pollJson.data.markdown_url;
        onProgress("MinerU 解析完成，正在下载结构化 Markdown 文本...");
        const mdRes = await this._fetch(mdUrl, { signal });
        if (!mdRes.ok) throw new Error(`下载 MinerU 正文失败 (HTTP ${mdRes.status})`);
        const markdown = await this.awaitWithSignal(mdRes.text(), signal);
        return { markdown, taskId, mode: "agent" };
      } else if (taskState === "failed") {
        throw new Error(`MinerU 解析失败: ${pollJson.data?.err_msg || "未知错误"}`);
      } else {
        onProgress(`MinerU 解析中 [${taskState}] (${(i + 1) * 2.5}s)...`);
      }
    }

    throw new Error("MinerU 解析超时，请稍后重试或检查文件是否超过 20 页限制。");
  },

  /**
   * 模式二：精准解析模式（支持 Token 授权、高精度 vlm 模型、大文件）
   * @param {string} fileName 文件名
   * @param {ArrayBuffer|Uint8Array} fileBuffer 本地 PDF 二进制数据
   * @param {string} token 用户 MinerU Token
   * @param {Function} onProgress 进度回调
   */
  async parsePrecise(fileName, fileBuffer, token, model = "vlm", onProgress = () => {}, options = {}) {
    const signal = options.signal;
    this.throwIfAborted(signal);
    token = this.normalizeToken(token);
    model = model === "pipeline" ? "pipeline" : "vlm";
    if (!token) {
      throw new Error("请先在插件配置中填写 MinerU Token，或切换为免登录 Agent 模式。");
    }
    const expiresAt = this.tokenExpiresAt(token);
    if (expiresAt && expiresAt <= Date.now()) {
      throw new Error(`MinerU Token 已于 ${new Date(expiresAt).toLocaleString()} 过期。请在 MinerU「API 管理」创建新 Token。`);
    }

    onProgress(`正在向 MinerU 申请批量上传链接 (精准模式：${model})...`);
    const applyUrl = `${this.PRECISE_BASE_URL}/file-urls/batch`;
    const applyPayload = {
      files: [{ name: fileName, data_id: `doc_${Date.now()}` }],
      model_version: model
    };

    const applyRes = await this._fetch(applyUrl, {
      method: "POST", signal,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`
      },
      body: JSON.stringify(applyPayload)
    });

    if (!applyRes.ok) {
      if (applyRes.status === 401 || applyRes.status === 403) {
        const detail = await this.awaitWithSignal(applyRes.json(), signal).catch(() => null);
        this.throwIfAborted(signal);
        const serverCode = detail?.msgCode || detail?.code;
        const code = serverCode ? `，错误码 ${serverCode}` : "";
        const traceID = detail?.trace_id || detail?.traceId;
        const trace = traceID ? `，trace_id ${traceID}` : "";
        throw new Error(`MinerU 服务端鉴权失败（HTTP ${applyRes.status}${code}${trace}）。插件已发送 Bearer Token 和 ${model} 模型参数；请凭错误码联系 MinerU 核查账号/API 授权。`);
      }
      throw new Error(`MinerU 精准模式请求失败 (HTTP ${applyRes.status})`);
    }

    const applyJson = await this.awaitWithSignal(applyRes.json(), signal);
    if (applyJson.code !== 0 || !applyJson.data?.batch_id) {
      throw new Error(`MinerU 精准模式申请失败: ${applyJson.msg || "Token 无效或权限不足"}`);
    }

    const batchId = applyJson.data.batch_id;
    const uploadUrl = applyJson.data.file_urls[0];

    // 上传文件
    onProgress("正在上传文献至精准模式解析通道...");
    const uploadRes = await this._fetch(uploadUrl, { method: "PUT", body: fileBuffer, signal });
    if (!uploadRes.ok) {
      throw new Error(`上传失败，HTTP 状态: ${uploadRes.status}`);
    }

    // 轮询结果
    onProgress(`已上传，精准模型 (${model}) 正在进行版面与深度要素识别...`);
    const pollInterval = 3000;
    for (let i = 0; i < 150; i++) {
      await this.wait(pollInterval, signal);
      const pollUrl = `${this.PRECISE_BASE_URL}/extract-results/batch/${batchId}`;
      const pollRes = await this._fetch(pollUrl, {
        signal,
        headers: { "Authorization": `Bearer ${token}` }
      });
      if (!pollRes.ok) continue;

      const pollJson = await this.awaitWithSignal(pollRes.json(), signal);
      const task = pollJson.data?.extract_result?.[0];
      if (!task) continue;

      if (task.state === "done") {
        if (!task.full_zip_url) throw new Error("MinerU 未返回解析结果下载地址。");
        onProgress("精准模式解析完成，正在读取 Markdown 正文…");
        const markdown = await this.downloadMarkdownFromZip(task.full_zip_url, { signal });
        return {
          markdown,
          zipUrl: task.full_zip_url,
          batchId,
          mode: "precise"
        };
      } else if (task.state === "failed") {
        throw new Error(`解析失败: ${task.err_msg || "未知原因"}`);
      } else {
        const pages = task.extract_progress?.extracted_pages || 0;
        const total = task.extract_progress?.total_pages || 0;
        onProgress(`精准解析进行中... 已解析 ${pages}/${total || '?'} 页`);
      }
    }

    throw new Error("精准模式解析超时。");
  },

  async downloadMarkdownFromZip(url, options = {}) {
    const signal = options.signal;
    this.throwIfAborted(signal);
    const response = await this._fetch(url, { signal });
    if (!response.ok) throw new Error(`下载 MinerU 解析包失败 (HTTP ${response.status})`);
    const tempFile = Zotero.getTempDirectory().clone();
    tempFile.append(`mineru-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`);
    const zipPath = tempFile.path;
    const zipReader = Components.classes["@mozilla.org/libjar/zip-reader;1"]
      .createInstance(Components.interfaces.nsIZipReader);
    try {
      const bytes = new Uint8Array(await this.awaitWithSignal(response.arrayBuffer(), signal));
      this.throwIfAborted(signal);
      await IOUtils.write(zipPath, bytes);
      this.throwIfAborted(signal);
      zipReader.open(tempFile);
      const entries = zipReader.findEntries("*");
      let markdownName = null;
      while (entries.hasMore()) {
        const name = entries.getNext();
        if (name === "full.md" || name.endsWith("/full.md")) {
          markdownName = name;
          break;
        }
      }
      if (!markdownName) throw new Error("MinerU 解析包中没有 full.md 文件。");
      const { NetUtil } = ChromeUtils.importESModule("resource://gre/modules/NetUtil.sys.mjs");
      const stream = zipReader.getInputStream(markdownName);
      try {
        this.throwIfAborted(signal);
        return NetUtil.readInputStreamToString(stream, zipReader.getEntry(markdownName).realSize,
          { charset: "UTF-8" });
      } finally {
        stream.close();
      }
    } finally {
      try { zipReader.close(); } catch (_error) {}
      try { await IOUtils.remove(zipPath); } catch (_error) {}
    }
  },

  /**
   * 统一解析入口
   */
  async parsePdf(fileName, fileBuffer, options = {}, onProgress = () => {}) {
    const mode = options.mode || "agent";
    if (mode === "precise") {
      return await this.parsePrecise(fileName, fileBuffer, options.token, options.model, onProgress, options);
    } else {
      return await this.parseAgent(fileName, fileBuffer, onProgress, options);
    }
  }
};
