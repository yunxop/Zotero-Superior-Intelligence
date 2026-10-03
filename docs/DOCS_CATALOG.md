# 技术规范与开发文档目录（Documentation & Specifications Catalog）

本目录负责存储 Zotero Superior Intelligence (SI) 系统的设计规范、算法协议、UI 预览与 Zotero 10 适配指南。
输入为 MinerU 官方接口规范、Zotero 7/10 现代扩展规范、学术文献高亮算法及 UI 原型。
输出为结构化技术白皮书、无数据预览页面、离线界面截图以及插件数据流设计方案。

---

## 关键文件清单

| 文件名 | 地位 | 功能描述 | 输入数据 | 输出数据 |
| :--- | :--- | :--- | :--- | :--- |
| `DOCS_CATALOG.md` | 目录架构文档 | 描述文档目录职责与文件全量索引 | 目录文档清单 | 架构全景说明 |
| `MINERU_API_SPEC.md` | 接口技术规范 | 详解 MinerU 两种解析模式（Agent 免登录 / 授权精准解析）、流程与错误码 | MinerU 官方技术规范 | 客户端数据契约与接口设计 |
| `ZOTERO_10_DEV_GUIDE.md` | 运行时适配规范 | 规范 Zotero 10（Gecko ESR 平台）生命周期、菜单注册、PreferencePanes 与安全沙箱 | Zotero 10 平台规范 | 插件生命周期与注入代码规范 |
| `AUTO_HIGHLIGHT.md` | 智能高亮算法设计 | 阐明学术文献重点（结论、方法、机制）在 PDF 坐标中的定位与标引算法 | PDF 文本坐标流 | 原文高亮与批注算法方案 |
| `BATCH_PROCESSING.md` | 批量处理协议 | 详细说明多文献串行队列调度、中断保护、单篇容错与进度汇总机制 | 选中文献队列 | 批量处理流程与异常控制规范 |
| `LIBRARY_CHAT.md` | 全库对话架构 | 阐述全库倒排索引构建、跨篇关键词语义混合检索与引文卡片溯源 | 全库文献元数据与笔记 | 跨文献检索与多文献问答架构 |
| `UI_REFRESH.md` | 界面现代化重构指南 | 记录工作台、阅读器侧边栏及首选项面板现代化样式规范与 Token 计量布局 | 设计系统与排版标准 | 现代学术风格 UI 规范 |
| `ICON_GENERATION.md` | 图标与视觉资产规范 | 说明插件各尺寸 Favicon、侧边栏 SVG 图标与高清视觉资产生成流程 | 原始矢量图与配色 | 多分辨率插件图标规范 |
| `preview_ui.py` | UI 预览生成工具 | 解析生产环境 XHTML/CSS 并输出可在普通浏览器中独立预览的 HTML 文件 | `plugin_src/` 界面模板 | `ui-preview/*.html` 预览页面 |
| `ui-preview/` | 界面预览与截图目录 | 包含科研工作台、首选项面板、阅读器侧边栏、全库检索的预览网页及渲染截图 | XHTML 转换产物与截图 | 离线界面展示与文档插图 |

## 新增使用说明

- [TASK_CONTROLS.md](TASK_CONTROLS.md)：思考与 Token 设置保存、对话笔记保护、原生公式、任务暂停和跨重启续跑。
