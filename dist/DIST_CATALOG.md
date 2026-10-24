# 发布分发产物目录（Distribution & Artifacts Catalog）

本目录负责存放由 `build_xpi.py` 自动化打包构建生成的 Zotero 扩展安装包（`.xpi`）。
输入为经过测试与验证的 `plugin_src/` 核心源码及静态资产。
输出为可直接拖拽至 Zotero 10.0.x 安装的经过 ZIP 压缩的扩展安装包。

---

## 安装包命名与发布规范

1. **命名规范**：`zotero-superior-intelligence-MAJOR.MINOR.PATCH.xpi`
2. **Git 归档策略**：
   - 遵循开源最佳实践，历史构建安装包已通过 `.gitignore` 排除，避免二进制文件导致 Git 仓库历史体积持续膨胀。
   - 本地开发可随时通过 `python build_xpi.py`（或 `npm run build`）重新生成对应版本的安装包。
   - 当前构建目标为 `zotero-superior-intelligence-1.1.3.xpi`；保留已发布 `1.1.2`、本地修订版 `1.1.1`、上一发布版本 `1.1.0` 与原始 `1.0.0` 安装包供回退。
   - 正式版本发布建议通过 GitHub Releases 进行二进制附件分发。
   - 发布以 [GitHub Releases](https://github.com/yunxop/Zotero-Superior-Intelligence/releases) 中实际可下载的附件为准；构建目录中的文件不表示已经发布。

---

| 文件 / 目录名 | 地位 | 功能描述 | 适用平台 |
| :--- | :--- | :--- | :--- |
| `DIST_CATALOG.md` | 目录架构文档 | 说明分发目录职责与安装包命名规则 | - |
| `zotero-superior-intelligence-1.1.3.xpi` | 当前构建目标 | 修复重开重复弹窗，新增三套总结角度与独立提示词保存；详见 `docs/RELEASE_1.1.3.md` | Zotero 10.0.x |
| `zotero-superior-intelligence-1.1.2.xpi` | 上一发布版本 | 汇总本地 1.1.1 修复与后台任务功能，并同步新仓库更新地址；详见 `docs/RELEASE_1.1.2.md` | Zotero 10.0.x |
| `zotero-superior-intelligence-1.1.1.xpi` | 本地修订回退包 | 保留本地构建结果，包含响应完整性、附件选择、检索、网络超时、界面性能与工作台后台任务修复 | Zotero 10.0.x |
| `zotero-superior-intelligence-1.1.0.xpi` | 上一版本安装包 | 增加设置保存、对话保护、完整公式、连贯追问与任务续跑 | Zotero 10 |
| `zotero-superior-intelligence-1.0.0.xpi` | 原始旧版安装包 | 保留发布时原包，供版本回退 | Zotero 10 |
| `archive/` | 历史安装包归档子目录 | 统一收拢存储历史版本安装包（共 30 个包），保持分发根目录整洁 | 本地归档与历史回退 |

---

## 安装说明

1. 下载最新的 `zotero-superior-intelligence-*.xpi` 文件。
2. 打开 Zotero 客户端，点击顶部菜单栏 **工具 (Tools)** -> **插件 (Add-ons / Plugins)**。
3. 将下载的 `.xpi` 文件直接拖拽入插件管理窗口，或点击齿轮图标选择 **Install Add-on From File...**。
4. 重启 Zotero 即可完成安装。
