# 插件源码目录架构设计（Plugin Source Catalog）

本目录包含 Zotero 10 AI 与 MinerU 插件的完整核心源代码、资源配置文件与本地化语言包。
输入为研究者的科研配置参数、选中的 Zotero 文献条目/PDF 附件及大模型 API Key。
输出为向 Zotero 运行时环境注入的菜单、侧边栏、笔记生成与 MinerU 提取数据流。

---

## 关键文件与模块清单

| 文件路径 | 地位 | 功能描述 | 输入数据 | 输出数据 |
| :--- | :--- | :--- | :--- | :--- |
| `PLUGIN_SRC_CATALOG.md` | 目录架构文档 | 说明插件源码目录架构、职责及文件列表 | 源码目录树 | 模块全景说明 |
| `manifest.json` | 扩展清单定义 | 声明扩展元数据、包含强制 update_url，适配 Zotero 6.999 至 10.* | 平台版本规范 | 扩展识别配置 |
| `bootstrap.js` | 平台生命周期 | 注册 chrome 协议，实现 startup、shutdown 与窗口加载卸载 | Zotero 运行时事件 | 插件沙箱上下文 |
| `chrome.manifest` | 路由映射定义 | 注册 chrome://zoteromineru/content/ 资源与 locale 本地化 | 目录相对路径 | Gecko chrome 路由 |
| `prefs.js` | 默认参数首选项 | 预置 MinerU 解析模式、大模型服务商、默认 Prompt 与标签开关 | 初始配置值 | 用户偏好存储树 |
| `chrome/content/scripts/mineru_client.js` | MinerU API 客户端 | 实现免 Token Agent 轻量解析与高精度 Token 解析两种工作流 | PDF 本地文件流 | 解析完成的 Markdown 文本 |
| `chrome/content/scripts/zotero_adapter.js` | Zotero 适配器 | 读取文献条目 PDF 物理路径、创建子笔记、自动打标签、弹窗通知 | Zotero 内部 API | 笔记、标签与条目状态更新 |
| `chrome/content/scripts/llm_client.js` | 大模型通信客户端 | 针对提取的学术 Markdown 文献进行流式精读、长文证据提取合并与超时保护 | Markdown 文本 + 用户提问 | 实时流式学术洞见与结构化分析 |
| `chrome/content/scripts/main.js` | 插件核心调度主程序 | 统一调度各子模块，向主界面和 PDF 阅读器注入右键菜单与操作按钮 | 用户界面交互触发 | 触发解析、总结与高亮任务 |
| `chrome/content/scripts/dashboard.js` | 科研工作台交互控制器 | 文献选区自动同步、单篇/批量任务派发、Markdown 结果实时渲染展示 | 用户交互输入与文献选区 | 任务进度与总结结果展示 |
| `chrome/content/dashboard.xhtml` | 科研工作台界面 | 提供文献选择清单、提示词编辑、模型切换、任务历史与结果展示窗口 | 用户交互操作 | 独立工作台 UI 界面 |
| `chrome/content/scripts/batch.js` | 批量处理控制器 | 串行队列调度器，支持单篇容错、结果聚合、中途安全停止与状态反馈 | 选中文献 ID 列表 | 批量任务状态流与聚合结果 |
| `chrome/content/scripts/summary_text_cache.js` | 会话级正文提取缓存 | 提取文本在内存中按文献指纹缓存与并发保护，防止重复提取与挂起死锁 | PDF 文件与解析配置 | 提取正文文本与缓存命中元数据 |
| `chrome/content/scripts/auto_highlight.js` | 学术文献智能高亮 | 依据规则提取结论、机制、方法等学术要点并自动写入 Zotero PDF 批注 | PDF 原文与分类提示词 | 原文匹配的矢量颜色高亮批注 |
| `chrome/content/scripts/reader_chat.js` | PDF 阅读器侧边栏研读助手 | PDF 原文语义检索与深度对话、回答一键复制与在线二次编辑 | PDF 全文文字流与提问 | 深入上下文学术问答、可编辑回答与笔记保存 |
| `chrome/content/scripts/library_chat.js` | 文献库全库对话引擎 | 基于向量与关键词检索的全局知识库检索对话助手 | 全库摘要、笔记与问答历史 | 全局文献交叉回答与引用溯源 |
| `chrome/content/scripts/library_index.js` | 全库索引构建器 | 提取与持久化文献库摘要、元数据与笔记倒排索引 | Zotero 文献库条目 | 本地 JSON 结构化全局索引 |
| `chrome/content/library.xhtml` | 全库对话窗口 | 提供全局知识库对话交互面板与引文溯源卡片 | 用户检索提问 | 检索问答与引文溯源界面 |
| `chrome/content/preferences.xhtml` | 首选项面板结构 | 定义符合 Zotero 7/10 规范的 XUL/XHTML 偏好设置面板与自动数据绑定 | 用户首选项操作 | 界面渲染与配置同步 |
| `chrome/content/scripts/preferences.js` | 首选项交互逻辑 | 处理预设快捷填报、MinerU 与大模型接口实时连通性测试 | 按钮点击事件与输入数据 | 连通性测试报告与状态渲染 |
| `chrome/content/styles/` | 数学公式与视图样式 | 提供 KaTeX 渲染样式与 WOFF2 字体，支持学术公式实时展示 | LaTeX 数学符号 | 优美的数学公式排版 |
| `chrome/locale/` | 本地化语言包 | 包含中英文（zh-CN, en-US）多语言界面定义 | 语言包文本 | 本地化 UI 提示 |



## 科研写作知识库（1.2.0）

新增 `writing_core.js`、`writing_store.js`、`writing_service.js`、`writing_ui.js` 与 `writing.xhtml`。功能、存储与接口见 `docs/writing-knowledge.md`。

2.0.0：新增 `writing_topics.js` 与 `writing_topic_ui.js`，负责主题迁移、管理、记录关联和提取历史。
