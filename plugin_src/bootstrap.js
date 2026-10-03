// input: Zotero runtime rootURI, addon metadata, reason flags
// output: Chrome registration handle, lifecycle hooks for Zotero 10
// pos: Root entry point for Zotero 10 Add-on runtime lifecycle

var chromeHandle;

function install(data, reason) {}

async function startup({ rootURI }, reason) {
  try {
    // 0. 刷新 JAR 缓存以保证重新安装热更新生效
    if (rootURI.startsWith("jar:")) {
      try {
        const xpiFile = Services.io.newURI(rootURI)
          .QueryInterface(Components.interfaces.nsIJARURI)
          .JARFile.QueryInterface(Components.interfaces.nsIFileURL).file;
        Services.obs.notifyObservers(xpiFile, "flush-cache-entry");
      } catch (e) {}
    }

    // 1. 注册 Chrome 协议包 (只注册 content，兼容所有 Gecko 版本)
    const aomStartup = Components.classes[
      "@mozilla.org/addons/addon-manager-startup;1"
    ].getService(Components.interfaces.amIAddonManagerStartup);
    const manifestURI = Services.io.newURI(rootURI + "manifest.json");
    chromeHandle = aomStartup.registerChrome(manifestURI, [
      ["content", "zoteromineru", rootURI + "chrome/content/"],
    ]);

    // 2. 依次加载客户端与业务逻辑脚本
    const ctx = this;
    Services.scriptloader.loadSubScriptWithOptions(
      `${rootURI}chrome/content/scripts/error_utils.js`,
      { target: ctx, ignoreCache: true }
    );
    Services.scriptloader.loadSubScriptWithOptions(
      `${rootURI}chrome/content/scripts/mineru_client.js`,
      { target: ctx, ignoreCache: true }
    );
    Services.scriptloader.loadSubScriptWithOptions(
      `${rootURI}chrome/content/scripts/vendor/katex.min.js`,
      { target: ctx, ignoreCache: true }
    );
    Services.scriptloader.loadSubScriptWithOptions(
      `${rootURI}chrome/content/scripts/markdown_renderer.js`,
      { target: ctx, ignoreCache: true }
    );
    Services.scriptloader.loadSubScriptWithOptions(
      `${rootURI}chrome/content/scripts/zotero_adapter.js`,
      { target: ctx, ignoreCache: true }
    );
    Services.scriptloader.loadSubScriptWithOptions(
      `${rootURI}chrome/content/scripts/usage_tracker.js`,
      { target: ctx, ignoreCache: true }
    );
    Services.scriptloader.loadSubScriptWithOptions(
      `${rootURI}chrome/content/scripts/task_checkpoints.js`,
      { target: ctx, ignoreCache: true }
    );
    Services.scriptloader.loadSubScriptWithOptions(
      `${rootURI}chrome/content/scripts/llm_client.js`,
      { target: ctx, ignoreCache: true }
    );
    Services.scriptloader.loadSubScriptWithOptions(
      `${rootURI}chrome/content/scripts/reader_chat.js`,
      { target: ctx, ignoreCache: true }
    );
    Services.scriptloader.loadSubScriptWithOptions(
      `${rootURI}chrome/content/scripts/auto_highlight.js`,
      { target: ctx, ignoreCache: true }
    );
    Services.scriptloader.loadSubScriptWithOptions(
      `${rootURI}chrome/content/scripts/batch.js`,
      { target: ctx, ignoreCache: true }
    );
    for (const script of ["library_index.js", "library_chat.js", "summary_text_cache.js"]) {
      Services.scriptloader.loadSubScriptWithOptions(`${rootURI}chrome/content/scripts/${script}`, { target: ctx, ignoreCache: true });
    }
    Services.scriptloader.loadSubScriptWithOptions(
      `${rootURI}chrome/content/scripts/main.js`,
      { target: ctx, ignoreCache: true }
    );

    // 3. 初始化全局主程序
    const app = ctx.ZoteroMinerUAI || (typeof Zotero !== "undefined" && Zotero.MinerUAI);
    if (app) {
      await app.init({ rootURI });
    }
  } catch (err) {
    if (typeof Zotero !== "undefined" && Zotero.logError) {
      Zotero.logError("[MinerU-AI] Startup error: " + err);
    }
    dump("[MinerU-AI] Startup error: " + err + "\n");
  }
}

async function onMainWindowLoad({ window }, reason) {
  try {
    const app = this.ZoteroMinerUAI || (typeof Zotero !== "undefined" && Zotero.MinerUAI);
    if (app) {
      await app.onMainWindowLoad(window);
    }
  } catch (e) {
    if (typeof Zotero !== "undefined") Zotero.logError(e);
  }
}

async function onMainWindowUnload({ window }, reason) {
  try {
    const app = this.ZoteroMinerUAI || (typeof Zotero !== "undefined" && Zotero.MinerUAI);
    if (app) {
      await app.onMainWindowUnload(window);
    }
  } catch (e) {
    if (typeof Zotero !== "undefined") Zotero.logError(e);
  }
}

async function shutdown({ id, version, rootURI }, reason) {
  try {
    const app = this.ZoteroMinerUAI || (typeof Zotero !== "undefined" && Zotero.MinerUAI);
    if (app) {
      await app.destroy();
    }
  } catch (e) {}

  if (chromeHandle) {
    chromeHandle.destruct();
    chromeHandle = null;
  }
}

function uninstall(data, reason) {}
