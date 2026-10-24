# Zotero 10 插件架构与生命周期开发指南（Zotero 10 Architecture Guide）

本指南阐述了针对 Zotero 10（底层基于 Mozilla Gecko 现代化运行时环境）开发插件的核心规范与最佳实践。

---

## 1. 核心架构演进与版本适配规则

Zotero 10 彻底移除了 Firefox 早期的传统遗留组件（如 `install.rdf`、`options.xul` 等旧版 XUL 机制），全面拥抱现代 Web 标准与 Gecko 模块化设计。

### 1.1 `manifest.json` 配置规范与强制字段
在 Zotero 10（Gecko 140 运行时）底层 `Extension.sys.mjs` 中，对 `applications.zotero` 的定义具有 3 项**绝对强制字段**（缺少任一字段均会被 Add-on Manager 判定为 `Extension is invalid`，并在前台报错“此附加组件无法安装，因为它与您的 Zotero 版本不兼容”）：
1. `id`：插件唯一标识符；
2. `update_url`：插件更新元数据 URL（**不可省略**）；
3. `strict_max_version`：最高版本适配（如 `"10.*"`）。

标准推荐配置如下：
```json
{
  "manifest_version": 2,
  "name": "Zotero Superior Intelligence",
  "version": "1.1.2",
  "description": "Zotero 10 深度集成 AI 助手与 MinerU 高精度文献结构化解析插件",
  "icons": {
    "48": "chrome/content/icons/favicon.png",
    "96": "chrome/content/icons/favicon.png"
  },
  "applications": {
    "zotero": {
      "id": "zotero-mineru-ai@custom.org",
      "update_url": "https://raw.githubusercontent.com/yunxop/Zotero-Superior-Intelligence/main/update.json",
      "strict_min_version": "10.0",
      "strict_max_version": "10.0.*"
    }
  }
}
```
> [!TIP]
> 当前安装包声明支持 Zotero 10.0.x。修改版本限制仅影响安装检查，不能证明旧版本 API 兼容；未经过真机验证前，不应降低最低版本或宣称兼容 Zotero 7/8/9。


---

## 2. 插件生命周期与钩子函数（`bootstrap.js`）

在 Zotero 10 中，`bootstrap.js` 是插件运行的核心入口，需实现以下标准生命周期钩子：

```javascript
var chromeHandle;

function install(data, reason) {}

async function startup({ rootURI }, reason) {
  // 1. 注册 chrome 协议包路径 (chrome://zoteromineru/content/...)
  const aomStartup = Components.classes[
    "@mozilla.org/addons/addon-manager-startup;1"
  ].getService(Components.interfaces.amIAddonManagerStartup);
  const manifestURI = Services.io.newURI(rootURI + "manifest.json");
  chromeHandle = aomStartup.registerChrome(manifestURI, [
    ["content", "zoteromineru", rootURI + "chrome/content/"],
  ]);

  // 2. 加载核心模块并挂载至 Zotero 命名空间
  Services.scriptloader.loadSubScriptWithOptions(
    `${rootURI}chrome/content/scripts/main.js`,
    { target: this, ignoreCache: true }
  );

  await Zotero.MinerUAI.init({ rootURI });
}

async function onMainWindowLoad({ window }, reason) {
  // 当主窗口初始化就绪后，注入菜单项、阅读器按钮和侧边栏
  await Zotero.MinerUAI.onMainWindowLoad(window);
}

async function onMainWindowUnload({ window }, reason) {
  // 窗口关闭或插件重载时，清理 DOM 监听器与注入的视图
  await Zotero.MinerUAI.onMainWindowUnload(window);
}

async function shutdown({ id, version, rootURI }, reason) {
  // 清理全局事件监听、销毁 chrome 句柄
  await Zotero.MinerUAI.destroy();
  if (chromeHandle) {
    chromeHandle.destruct();
    chromeHandle = null;
  }
}

function uninstall(data, reason) {}
```

---

## 3. 界面交互与右键菜单规范

1. **菜单注册**：
   - 优先通过 `Zotero.MenuManager` 或在 `item-tree` 上监听右键上下文菜单事件 `contextmenu`。
   - 动态判断当前选中的条目类型（是否为文献条目、是否有关联的 PDF 附件文件）。
2. **通知与进度展示**：
   - 使用 Zotero 原生通知组件 `new Zotero.ProgressWindow()`，在解析 PDF 与调用大模型时向研究者实时反馈任务进度与错误提示。
3. **侧边栏集成**：
   - 在 Zotero 7/10 的阅读器右侧抽屉区域注入自定义 Web Components / XHTML 容器，提供媲美原生体验的聊天与文献提取工作台。
