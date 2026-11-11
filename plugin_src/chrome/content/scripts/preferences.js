// input: preferences.xhtml DOM in Zotero Preferences window
// output: Click handlers for test buttons, preset fill buttons, external links
// pos: Interactive controller for MinerU & AI preference pane in Zotero 7/10

(function () {
  "use strict";
  const modeKey = "extensions.zoteromineru.mineruMode";
  const modelKey = "extensions.zoteromineru.mineruModel";
  let initialized = false;
  let retryCount = 0;
  let retryScheduled = false;

  function retryInitialization() {
    if (initialized || retryScheduled || retryCount >= 30) return;
    retryScheduled = true;
    setTimeout(() => {
      retryScheduled = false;
      retryCount += 1;
      initPrefPane();
      if (!initialized) retryInitialization();
    }, 100);
  }

  function normalizeToken(value) {
    return String(value || "")
      .trim()
      .replace(/^["']|["']$/g, "")
      .replace(/^Bearer\s+/i, "")
      .replace(/^["']|["']$/g, "")
      .replace(/[\s\u200B-\u200D\uFEFF]/g, "");
  }

  function tokenExpiresAt(token) {
    try {
      const encoded = token.split(".")[1];
      if (!encoded) return null;
      const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
      const payload = JSON.parse(window.atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")));
      const expiresAt = Number(payload.exp) * 1000;
      return Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt : null;
    } catch (_error) {
      return null;
    }
  }

  function getMode() {
    return Zotero.Prefs.get(modeKey, true) === "precise" ? "precise" : "agent";
  }

  function setMode(mode) {
    Zotero.Prefs.set(modeKey, mode, true);
    const precise = mode === "precise";
    document.getElementById("mineru-mode-agent")?.classList.toggle("mineru-mode-active", !precise);
    document.getElementById("mineru-mode-precise")?.classList.toggle("mineru-mode-active", precise);
    const current = document.getElementById("mineru-mode-current");
    if (current) current.textContent = precise
      ? "当前：精准模式。填写 MinerU Token 后可处理较长或扫描版 PDF。"
      : "当前：Agent 模式。无需 Token，适用于短篇 PDF。";
  }

  async function fetchWithTimeout(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      return await window.fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  function initPrefPane() {
    if (initialized || !document.getElementById("zotero-prefpane-mineru") || !Zotero.MinerUAI) return;
    const required = ["llmSlot", "llmProfileName", "llmProvider", "llmApiBase", "llmApiKey", "llmModel", "si-usage-calendar", "si-usage-year"];
    if (required.some((id) => !document.getElementById(id))) return;
    initialized = true;
    const doc = document;

    // Persist HTML controls explicitly: Zotero's preference binding does not
    // reliably bind HTML elements inside a dynamically registered XUL pane.
    for (const [id, key, checkbox] of [
      ["mineruToken", "mineruToken", false],
      ["autoGenerateNote", "autoGenerateNote", true],
      ["autoTag", "autoTag", true]
    ]) {
      const field = doc.getElementById(id);
      if (!field) continue;
      const stored = Zotero.Prefs.get(`extensions.zoteromineru.${key}`, true);
      if (checkbox) field.checked = stored !== false;
      else field.value = stored || "";
      const persist = () => Zotero.Prefs.set(`extensions.zoteromineru.${key}`,
        checkbox ? field.checked : field.value, true);
      field.addEventListener(checkbox ? "change" : "input", persist);
      if (!checkbox) field.addEventListener("change", persist);
    }

    doc.getElementById("mineru-mode-agent")?.addEventListener("click", () => setMode("agent"));
    doc.getElementById("mineru-mode-precise")?.addEventListener("click", () => setMode("precise"));
    setMode(getMode());
    const modelField = doc.getElementById("mineruModel");
    if (modelField) {
      modelField.value = Zotero.Prefs.get(modelKey, true) === "pipeline" ? "pipeline" : "vlm";
      modelField.addEventListener("change", () => {
        Zotero.Prefs.set(modelKey, modelField.value === "pipeline" ? "pipeline" : "vlm", true);
      });
    }

    // Eight independent model profiles. Existing saved slots retain their values.
    const app = Zotero.MinerUAI;
    const slotField = doc.getElementById("llmSlot");
    const nameField = doc.getElementById("llmProfileName");
    const providerField = doc.getElementById("llmProvider");
    const baseField = doc.getElementById("llmApiBase");
    const keyField = doc.getElementById("llmApiKey");
    const llmModelField = doc.getElementById("llmModel");
    const presets = {
      deepseek: { base: "https://api.deepseek.com/v1", model: "deepseek-flash" },
      openai: { base: "https://api.openai.com/v1", model: "gpt-4o-mini" },
      qwen: { base: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus" },
      siliconflow: { base: "https://api.siliconflow.cn/v1", model: "deepseek-ai/DeepSeek-V4-Flash" },
      ollama: { base: "http://localhost:11434/v1", model: "qwen2.5:7b" }
    };
    let currentSlot = app.activeProfile();
    let loading = false;
    const html = (tag) => doc.createElementNS("http://www.w3.org/1999/xhtml", tag);
    const renderProfileList = () => {
      slotField.replaceChildren();
      app.getProfiles().forEach((profile, index) => {
        const option = html("option");
        option.value = String(index + 1);
        option.textContent = `${index + 1 < 10 ? `0${index + 1}` : index + 1}  ·  ${profile.name}  ·  ${profile.model || "未配置"}`;
        slotField.append(option);
      });
      slotField.value = String(currentSlot);
    };
    const saveProfile = () => {
      if (loading) return;
      app.saveProfile(currentSlot, {
        name: nameField.value,
        provider: providerField.value, apiBase: baseField.value,
        apiKey: keyField.value, model: llmModelField.value
      });
      renderProfileList();
    };
    const loadProfile = (slot) => {
      loading = true;
      currentSlot = slot;
      const profile = app.getProfiles()[slot - 1];
      nameField.value = profile.name;
      providerField.value = profile.provider;
      baseField.value = profile.apiBase;
      keyField.value = profile.apiKey;
      llmModelField.value = profile.model;
      loading = false;
      renderProfileList();
    };
    loadProfile(currentSlot);
    slotField.addEventListener("change", () => {
      const nextSlot = Number(slotField.value);
      saveProfile();
      app.setActiveProfile(nextSlot);
      loadProfile(app.activeProfile());
      showStatus(`已切换到 ${nameField.value}。`, "info");
    });
    for (const field of [nameField, baseField, keyField, llmModelField]) {
      field.addEventListener("input", saveProfile);
      field.addEventListener("change", saveProfile);
    }
    doc.getElementById("si-save-profile").addEventListener("click", () => {
      saveProfile();
      showStatus(`配置 ${currentSlot} 已保存。`, "success");
    });
    const applyPreset = (provider) => {
      const preset = presets[provider];
      if (!preset) { saveProfile(); return; }
      if (app.getProfiles()[currentSlot - 1].provider !== provider) keyField.value = "";
      providerField.value = provider;
      baseField.value = preset.base;
      llmModelField.value = preset.model;
      saveProfile();
      showStatus(`配置 ${currentSlot} 已选 ${provider}；请核对模型名称并填写对应的 API Key。`, "success");
    };
    providerField.addEventListener("change", () => applyPreset(providerField.value));
    for (const provider of Object.keys(presets)) {
      doc.getElementById(`mineru-preset-${provider}`)?.addEventListener("click", () => applyPreset(provider));
    }

    const usageYear = doc.getElementById("si-usage-year");
    const usageProfile = doc.getElementById("si-usage-profile");
    if (!usageProfile.value) usageProfile.value = "all";
    const empty = () => ({ prompt: 0, completion: 0, total: 0, cached: 0, cachePrompt: 0, requests: 0, unreported: 0 });
    const add = (sum, day) => {
      for (const key of ["prompt", "completion", "total", "cached", "cachePrompt", "requests", "unreported"]) sum[key] += Number(day?.[key]) || 0;
      return sum;
    };
    const dayFor = (entry) => usageProfile.value === "all" ? entry : entry?.profiles?.[usageProfile.value];
    const dateKey = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    const amount = (value) => Number(value || 0).toLocaleString("zh-CN");
    const tokens = (value) => Number(value || 0) > 1000 ? `${(Number(value) / 1000).toFixed(1).replace(/\.0$/, "")}k` : amount(value);
    let positionedUsageYear = null;
    let positionedUsageCell = null;
    const usageScroll = doc.getElementById("si-usage-scroll");
    let positioningFrame = null;
    const scheduleUsagePosition = () => {
      if (!usageScroll || positioningFrame !== null) return;
      positioningFrame = window.requestAnimationFrame(() => {
        positioningFrame = null;
        const calendar = doc.getElementById("si-usage-calendar");
        const year = Number(usageYear.value);
        if (!calendar?.isConnected || !usageScroll.clientWidth) {
          positionedUsageYear = null;
          return;
        }
        // Query the current render: focus events can replace cells before this frame.
        const todayCell = calendar.querySelector('[data-today="true"]');
        if (positionedUsageYear === year && positionedUsageCell === todayCell) return;
        if (todayCell) {
          const cell = todayCell.getBoundingClientRect();
          if (!cell.width || !cell.height) return;
          const viewport = usageScroll.getBoundingClientRect();
          const desired = usageScroll.scrollLeft + cell.left + cell.width / 2
            - viewport.left - usageScroll.clientLeft - usageScroll.clientWidth / 2;
          const target = Math.max(0, Math.min(desired, usageScroll.scrollWidth - usageScroll.clientWidth));
          usageScroll.scrollLeft = target;
          // A hidden pane may silently reject scrolling. Leave it pending until visible.
          if (Math.abs(usageScroll.scrollLeft - target) > 1) return;
        } else {
          usageScroll.scrollLeft = 0;
        }
        positionedUsageYear = year;
        positionedUsageCell = todayCell;
      });
    };
    // Zotero inserts preference panes before revealing them. Observe the actual
    // layout/visibility instead of assuming the first animation frame is visible.
    if (usageScroll) {
      const resizeObserver = new window.ResizeObserver(scheduleUsagePosition);
      resizeObserver.observe(usageScroll);
      resizeObserver.observe(doc.getElementById("si-usage-calendar"));
      const visibilityObserver = new window.IntersectionObserver(entries => {
        if (entries.some(entry => entry.isIntersecting)) scheduleUsagePosition();
      });
      visibilityObserver.observe(usageScroll);
      window.addEventListener("unload", () => {
        resizeObserver.disconnect();
        visibilityObserver.disconnect();
        if (positioningFrame !== null) window.cancelAnimationFrame(positioningFrame);
      }, { once: true });
    }
    const renderUsage = () => {
      const calendar = doc.getElementById("si-usage-calendar");
      if (!calendar) return;
      const data = app.getUsage();
      const selectedProfile = usageProfile.value || "all";
      usageProfile.replaceChildren();
      const allOption = html("option"); allOption.value = "all"; allOption.textContent = "全部配置"; usageProfile.append(allOption);
      app.getProfiles().forEach((profile, index) => {
        const option = html("option"); option.value = String(index + 1);
        option.textContent = profile.name || `配置 ${index + 1}`;
        usageProfile.append(option);
      });
      usageProfile.value = selectedProfile;
      const today = new Date();
      const years = [...new Set([today.getFullYear(), ...Object.keys(data).map((key) => Number(key.slice(0, 4))).filter(Number.isInteger)])].sort((a, b) => b - a);
      const selectedYear = Number(usageYear.value) || today.getFullYear();
      usageYear.replaceChildren();
      for (const year of years) {
        const option = html("option"); option.value = String(year); option.textContent = String(year);
        usageYear.append(option);
      }
      usageYear.value = String(years.includes(selectedYear) ? selectedYear : today.getFullYear());
      const year = Number(usageYear.value);
      const totals = Object.values(data).reduce((sum, day) => add(sum, dayFor(day)), empty());
      const current = dayFor(data[dateKey(today)]) || empty();
      const annual = Object.entries(data).filter(([key]) => key.startsWith(`${year}-`))
        .reduce((sum, [, day]) => add(sum, dayFor(day)), empty());
      doc.getElementById("si-usage-total").textContent = `${tokens(totals.total)} Token`;
      doc.getElementById("si-usage-today").textContent = `${tokens(current.total)} Token`;
      doc.getElementById("si-usage-year-total").textContent = `${tokens(annual.total)} Token`;
      doc.getElementById("si-usage-requests").textContent = amount(totals.requests);
      const rate = totals.cachePrompt > 0 ? Math.min(100, totals.cached / totals.cachePrompt * 100) : 0;
      doc.getElementById("si-usage-cache").textContent = totals.cachePrompt > 0 ? `${rate.toFixed(1)}%` : "—";
      doc.getElementById("si-usage-cache-fill").style.width = `${rate}%`;
      doc.getElementById("si-usage-breakdown").textContent =
        `输入 ${tokens(totals.prompt)} / 输出 ${tokens(totals.completion)} / 缓存命中 ${tokens(totals.cached)} Token；` +
        `${amount(totals.requests)} 次请求，${amount(totals.unreported)} 次未返回用量。`;
      const monthlyTotals = Array.from({ length: 12 }, () => 0);
      for (const [key, day] of Object.entries(data)) {
        if (!key.startsWith(`${year}-`)) continue;
        const month = Number(key.slice(5, 7)) - 1;
        if (month >= 0 && month < 12) monthlyTotals[month] += Number(dayFor(day)?.total) || 0;
      }
      const monthlyPeak = Math.max(1, ...monthlyTotals);
      const monthlyChart = doc.getElementById("si-usage-monthly");
      monthlyChart.replaceChildren();
      monthlyTotals.forEach((value, index) => {
        const bar = html("div"); bar.className = "si-usage-month-bar";
        bar.style.height = `${Math.max(3, value / monthlyPeak * 56)}px`;
        bar.title = `${index + 1}月：${tokens(value)} Token`;
        monthlyChart.append(bar);
      });
      calendar.replaceChildren();
      const months = doc.getElementById("si-usage-months");
      months.replaceChildren();
      const first = new Date(year, 0, 1);
      const offset = (first.getDay() + 6) % 7;
      const days = Math.round((new Date(year + 1, 0, 1) - first) / 86400000);
      const columns = Math.ceil((offset + days) / 7);
      calendar.style.setProperty("--usage-columns", columns);
      months.style.setProperty("--usage-columns", columns);
      for (let index = 0; index < offset; index++) {
        const blank = html("span"); calendar.append(blank);
      }
      const yearTotals = [];
      for (let index = 0; index < days; index++) {
        const date = new Date(year, 0, index + 1);
        yearTotals.push((dayFor(data[dateKey(date)]) || empty()).total || 0);
      }
      const peak = Math.max(1, ...yearTotals);
      for (let index = 0; index < days; index++) {
        const date = new Date(year, 0, index + 1);
        const key = dateKey(date);
        const usage = dayFor(data[key]) || empty();
        const button = html("button");
        button.type = "button";
        button.className = "si-usage-day";
        button.dataset.level = usage.total ? String(Math.max(1, Math.ceil(usage.total / peak * 4))) : "0";
        button.dataset.today = key === dateKey(today) ? "true" : "false";
        button.dataset.future = date > today ? "true" : "false";
        button.title = `${key}：${tokens(usage.total)} Token`;
        button.setAttribute("aria-label", button.title);
        button.setAttribute("aria-pressed", "false");
        button.addEventListener("click", () => {
          for (const cell of calendar.children) cell.setAttribute("aria-pressed", "false");
          button.setAttribute("aria-pressed", "true");
          doc.getElementById("si-usage-detail").textContent =
            `${key}：${tokens(usage.total)} Token（输入 ${tokens(usage.prompt)} / 输出 ${tokens(usage.completion)}）；` +
            `${amount(usage.requests)} 次请求，${amount(usage.unreported)} 次未返回用量。`;
        });
        calendar.append(button);
      }
      for (let month = 0; month < 12; month++) {
        const label = html("span"); label.textContent = `${month + 1}月`;
        const column = Math.floor((offset + Math.round((new Date(year, month, 1) - first) / 86400000)) / 7) + 1;
        label.style.gridColumn = `${column} / span ${Math.min(4, columns - column + 1)}`; months.append(label);
      }
      scheduleUsagePosition();
    };
    usageYear.addEventListener("change", renderUsage);
    usageProfile.addEventListener("change", renderUsage);
    window.addEventListener("focus", renderUsage);
    renderUsage();

    // 2. 测试 MinerU 连通性
    const btnTestMinerU = doc.getElementById("mineru-btn-test-mineru");
    if (btnTestMinerU) {
      btnTestMinerU.addEventListener("click", async () => {
        showStatus("正在检测 MinerU 服务器连接与通道状态...", "info");
        try {
          const mode = getMode();
          const tokenField = doc.getElementById("mineruToken");
          const token = normalizeToken(tokenField?.value);
          const model = modelField?.value === "pipeline" ? "pipeline" : "vlm";

          if (tokenField && tokenField.value !== token) {
            tokenField.value = token;
            tokenField.dispatchEvent(new Event("input", { bubbles: true }));
          }
          if (token) Zotero.Prefs.set("extensions.zoteromineru.mineruToken", token, true);
          Zotero.Prefs.set(modelKey, model, true);

          if (mode === "precise" && !token) {
            showStatus("⚠️ 精准模式需要填写 MinerU API Token，请先填入后再测试！", "error");
            return;
          }
          const expiresAt = tokenExpiresAt(token);
          if (mode === "precise" && expiresAt && expiresAt <= Date.now()) {
            showStatus(`❌ MinerU Token 已于 ${new Date(expiresAt).toLocaleString()} 过期。请在 MinerU「API 管理」创建新 Token。`, "error");
            return;
          }

          // Request only a signed upload URL; no file is uploaded and no parse task starts.
          const precise = mode === "precise";
          const url = precise
            ? "https://mineru.net/api/v4/file-urls/batch"
            : "https://mineru.net/api/v1/agent/parse/00000000-0000-0000-0000-000000000000";
          const res = await fetchWithTimeout(url, precise ? {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({
              files: [{ name: "mineru-token-check.pdf", data_id: `check_${Date.now()}` }],
              model_version: model
            })
          } : {});
          const result = await res.json().catch(() => null);
          if (res.status === 401 || res.status === 403) {
            const serverCode = result?.msgCode || result?.code;
            const code = serverCode ? `，错误码 ${serverCode}` : "";
            const detail = result?.msg ? `；${result.msg}` : "";
            const traceID = result?.trace_id || result?.traceId;
            const trace = traceID ? `；trace_id ${traceID}` : "";
            showStatus(`❌ MinerU 服务端鉴权失败（HTTP ${res.status}${code}${detail}${trace}）。插件已按官方文档发送 Bearer Token 和 ${model} 模型；若 Token 来自 MinerU API 管理页，请凭错误码和 trace_id 联系 MinerU 核查账号/API 授权。`, "error");
          } else if (precise && res.ok && result?.code === 0 && result?.data?.batch_id) {
            showStatus(`✅ MinerU 精准模式 Token 有效（${model}）；未上传文件，也未开始解析。`, "success");
          } else if (precise) {
            showStatus(`❌ MinerU 精准模式验证失败：${result?.msg || `HTTP ${res.status}`}`, "error");
          } else if (res.status === 404 || res.status === 400 || res.ok) {
            showStatus(`✅ MinerU Agent 接口可连接（HTTP ${res.status}）。`, "success");
          } else {
            showStatus(`⚠️ MinerU 接口已响应 HTTP ${res.status}。请检查服务状态。`, "warning");
          }
        } catch (e) {
          showStatus("❌ MinerU 测试失败: " + (e.name === "AbortError" ? "20 秒内没有响应" : e.message), "error");
        }
      });
    }

    // 3. 测试大模型连通性
    const btnTestLLM = doc.getElementById("mineru-btn-test-llm");
    if (btnTestLLM) {
      btnTestLLM.addEventListener("click", async () => {
        saveProfile();
        showStatus(`正在测试配置 ${currentSlot} [${llmModelField.value.trim()}]…`, "info");
        try {
          const reply = await app.testLLM();
          showStatus(`✅ 配置 ${currentSlot} 连接成功：${reply.trim().slice(0, 80)}`, "success");
          renderUsage();
        } catch (err) {
          showStatus("❌ 大模型测试失败：" + err.message, "error");
        }
      });
    }

    // 4. 外部文档链接打开
    const linkMinerU = doc.getElementById("mineru-link-mineru");
    if (linkMinerU) {
      linkMinerU.addEventListener("click", () => {
        if (typeof Zotero !== "undefined" && Zotero.launchURL) {
          Zotero.launchURL("https://mineru.net/apiManage/docs");
        }
      });
    }

    const linkDeepSeek = doc.getElementById("mineru-link-deepseek");
    if (linkDeepSeek) {
      linkDeepSeek.addEventListener("click", () => {
        if (typeof Zotero !== "undefined" && Zotero.launchURL) {
          Zotero.launchURL("https://platform.deepseek.com");
        }
      });
    }
  }

  function showStatus(msg, type) {
    const box = document.getElementById("mineru-status-box");
    if (!box) return;
    box.textContent = msg;
    box.style.display = "block";
    if (type === "success") {
      box.style.background = "#dcfce7";
      box.style.color = "#15803d";
      box.style.border = "1px solid #86efac";
    } else if (type === "error") {
      box.style.background = "#fee2e2";
      box.style.color = "#b91c1c";
      box.style.border = "1px solid #fca5a5";
    } else if (type === "warning") {
      box.style.background = "#fef9c3";
      box.style.color = "#854d0e";
      box.style.border = "1px solid #fde047";
    } else {
      box.style.background = "#e0f2fe";
      box.style.color = "#0369a1";
      box.style.border = "1px solid #7dd3fc";
    }
  }

  // Zotero loads pane scripts before its fragment and dispatches `load` on
  // the fragment after insertion. Capture that event instead of guessing timing.
  document.addEventListener("load", (event) => {
    if (event.target?.id === "zotero-prefpane-mineru") {
      initPrefPane();
      if (!initialized) retryInitialization();
    }
  }, true);
  initPrefPane();
  if (!initialized) retryInitialization();
})();
