# Zotero Superior Intelligence · SI 2.0.0

<div align="center">

**免费开源的 Zotero AI 科研助手**

### 💬 与 PDF 对话 · 🖍️ 自动标记文献 · ✍️ 提取科研写作语料

**读懂论文 → 标记证据 → 积累表达 → 建立自己的科研写作知识库**

[![Free](https://img.shields.io/badge/插件-免费使用-brightgreen)](#free)
[![Open Source](https://img.shields.io/badge/开源-AGPL--3.0-green)](LICENSE)
[![Version](https://img.shields.io/badge/版本-2.0.0-blue)](#install)
[![Zotero](https://img.shields.io/badge/Zotero-10.0.x-red)](https://www.zotero.org/)

[核心功能](#features) · [2.0.0 新功能](#v2) · [安装使用](#install) · [常见问题](#faq) · [English](#english)

</div>

<a id="free"></a>

> [!IMPORTANT]
> **插件免费，功能全部开放。没有会员、订阅或 Pro 功能付费墙。**
>
> PDF 对话、自动高亮、批量分析、语料提取、主题管理和数据导出均可免费使用。
> **第三方服务费用单独计算**：你配置的 LLM、Voyage AI 或 MinerU 服务可能收费，取决于服务商政策。插件免费不等于 API 免费；也可连接本地 OpenAI 兼容模型服务，语料筛选可关闭 Voyage、仅使用关键词。

<a id="features"></a>

## 四个重点，覆盖从阅读到写作

| 你想做什么 | SI 帮你完成什么 |
| --- | --- |
| **💬 和论文对话** | 在 PDF 阅读器侧边栏提问、追问，解释方法、结果和公式，编辑回答并保存为 Zotero 笔记 |
| **🖍️ 自动标记文献** | 识别结论、机制、方法、研究空白与可引用内容，在 PDF 原文上生成不同颜色的高亮批注 |
| **✍️ 提取优秀英文表达** | 按研究主题提取原句、可复用句式、写作技巧与中文解释，支持复制和审核，积累自己的写作语料 |
| **🔬 积累科学证据** | 提取结论、方法、定量结果、支持证据与局限，保留 DOI、页码和原文定位，跨论文检索与导出 |

### 💬 PDF 对话：边读边问，回答可以留在文献里

打开 PDF，在 **SI 对话** 侧边栏直接提问：

- “这篇论文的核心贡献是什么？”
- “这个实验方法为什么这样设计？”
- “定量结果支持了什么结论？有哪些局限？”

支持连续追问、回答编辑与复制，以及保存为 Zotero 笔记。数学公式使用 KaTeX 渲染。还可以进入 **文献库对话**，基于多篇论文的摘要、笔记和注释进行检索、比较与综合问答。

### 🖍️ 文献自动标记：重点直接落到 PDF 原文上

AI 选择值得保留的原句，插件核验原文并利用文字坐标生成 Zotero 高亮批注：

| 颜色 | 标记内容 |
| --- | --- |
| 🟨 黄色 | 核心结论、重要结果 |
| 🟦 蓝色 | 机制、原因与过程 |
| 🟩 绿色 | 方法、数据与关键参数 |
| 🟥 红色 | 局限、争议、研究空白 |
| 🟪 紫色 | 可引用的概括性表达 |

在原文里查看和复核标记，减少反复翻找重点的时间。[查看自动高亮说明](docs/AUTO_HIGHLIGHT.md)

### ✍️ 科研语料提取：把读过的论文变成可复用的写作积累

输入研究主题，例如 **“城市植被降温”**，并填写提取指令：

> 提取不同植被类型的降温证据，保留季节、气候区和定量结果；同时提取值得借鉴的英文结果描述与讨论句式。

插件通过 **关键词 + 可选的 Voyage AI 语义筛选** 找到相关段落，再提取两类内容：

| 英文表达语料 | 科学证据 |
| --- | --- |
| 原文英文句子 | 研究结论与方法 |
| 可复用句式结构 | 定量结果与实验条件 |
| 写作技巧与中文解释 | 支持证据与研究局限 |
| IMRaD 分类与借鉴价值评分 | DOI、页码、来源段落与 PDF 定位 |

**不仅能提取，还能管理和使用：**

- 单篇、多篇、父分类及全部子分类、整个文献库均可批量读取，重复归类的论文去重处理。
- 按 Introduction、Methods、Results、Discussion 分类，支持人工修订、通过或拒绝审核。
- 复制单句、原句及来源，或勾选多条批量复制，直接粘贴到写作工具。
- 自动生成按主题命名的 Zotero 子笔记；知识库使用独立 **SQLite + Markdown** 保存。
- 导出 **Markdown、Agent JSONL、微调 JSONL**，用于个人资料整理、Agent 检索或准备训练数据。

> 微调导出只包含人工审核通过的记录。原句会核验是否存在于对应 PDF 段落中，模型解释和科学结论仍需人工复核；导出不会自动启动训练。

<a id="v2"></a>

## 2.0.0：语料越来越多，主题也能有序管理

**2.0.0 的重点是把“提取一次”变成“持续积累”。**

| 新功能 | 用途 |
| --- | --- |
| **独立主题管理页** | 搜索名称、别名、说明和标签，分页查看论文数、语料数和待审核数 |
| **置顶、归档、文件夹与标签** | 常用主题快速进入，长期项目按最多三级文件夹和多个标签整理 |
| **名称与提取指令分离** | 用简洁名称管理主题，用详细指令控制本次提取范围 |
| **重命名与主题合并** | 固定 ID 保持记录关联，合并去重，旧名称保留为别名 |
| **语料移动与跨主题关联** | 同一句子可供多个主题使用；从本主题移除不会删除其他主题的关联 |
| **主题与记录回收站** | 删除后可以恢复，原始 PDF、已有笔记与导出文件保留 |
| **提取批次历史** | 回看当时的指令、PDF 范围、模型和完成/失败状态 |
| **旧数据自动迁移** | 1.x 历史主题迁移为固定 ID，并保留原始记录备份 |

入口：**SI 文献助手 → 科研写作知识库 → 主题管理 / 回收站**。

[阅读 2.0.0 更新说明](docs/RELEASE_2.0.0.md) · [完整使用指南与 Agent 接口](docs/writing-knowledge.md)

## 其他实用功能

- **文献总结与结构化解析**：常规总结、不同总结角度、表格分析及可选 MinerU 解析。
- **多个模型配置**：保存和切换不同模型的 API 配置；连接兼容接口的云端或本地服务。
- **后台批处理**：关闭工作台后任务继续运行；退出 Zotero 或停用插件会中断任务。
- **用量查看与任务控制**：查看模型用量，设置思考模式、输出上限并管理运行任务。

[文献库对话](docs/LIBRARY_CHAT.md) · [任务设置与续跑](docs/TASK_CONTROLS.md) · [批处理说明](docs/BATCH_PROCESSING.md)

## 界面预览

| SI 科研工作台 | 跨文献检索与对话 |
| --- | --- |
| ![SI 科研工作台](docs/ui-preview/token-usage.png) | ![跨文献检索与对话](docs/ui-preview/library-chat.png) |

<a id="install"></a>

## 安装 2.0.0

**支持 Zotero 10.0.x。当前安装包不支持 Zotero 7/8/9。**

1. 从 [GitHub Releases](https://github.com/yunxop/Zotero-Superior-Intelligence/releases) 查看已发布安装包。**2.0.0 构建文件名：`zotero-superior-intelligence-2.0.0.xpi`**。若 Releases 尚未提供该版本，可从源码构建。
2. 打开 Zotero → **工具 → 插件**，通过齿轮菜单选择“从文件安装插件”，选择 `.xpi` 文件。
3. 重启 Zotero，在设置中打开 **Superior Intelligence (SI)**，配置模型接口并测试连接。
4. 在文献列表右键打开 **SI 文献助手**，或从工具菜单打开 **SI** 工作台。

### 开始使用

| 功能 | 操作 |
| --- | --- |
| PDF 对话 | 打开 PDF，在阅读器侧边栏进入 SI 对话 |
| 自动标记 / 总结 | 选择文献，在 SI 工作台选择对应任务 |
| 跨论文对话 | SI 工作台 → 文献库对话 |
| 语料与证据提取 | SI 工作台 → 科研写作知识库 → 读取范围 → 填写主题与指令 → 开始提取 |
| 跨子分类提取 | 在 Zotero 选中父分类，范围选择“当前分类及全部子分类”，读取范围后开始 |
| 主题管理 | 科研写作知识库 → 主题管理 / 回收站 |

语料提取使用 SI 当前 LLM 配置。启用语义筛选时，在知识库页面单独保存 **Voyage API Key 与 Embedding 模型**；关闭语义筛选则仅使用关键词。扫描 PDF 需先完成 OCR 才能进行带页码的语料提取。

<a id="faq"></a>

## 常见问题

**插件真的免费吗？**

是，插件代码按 AGPL-3.0 开源，上述功能没有会员或订阅门槛。你使用的第三方模型、Embedding、解析服务可能另行收费，费用按服务商规则计算。

**数据存放在哪里？**

知识库保存在 Zotero 数据目录中的 `si-writing.sqlite`，Markdown 镜像与导出文件位于 `si-writing/`。自动生成的子笔记保存在对应文献条目下。开启云端分析时，相关 PDF 段落会发送到所配置的服务。

**审核通过和拒绝有什么区别？**

已通过记录可以进入微调导出，待审核和已拒绝记录不会。普通 Markdown / Agent JSONL 按当前筛选条件导出；需要已核验内容时，请筛选“已通过”。拒绝不等于删除。

**会读取每篇论文的全部证据吗？**

所选范围内的论文会逐篇处理，但每篇分析段落受相关性阈值和段落上限控制，不保证穷尽所有证据。普通文献默认读取第一个可用 PDF；补充材料可直接选择相应附件处理。

**能否提供给 AI Agent 或微调模型？**

可以导出带来源的 Agent JSONL，以及仅含已通过记录的微调 JSONL。插件也提供进程内查询接口；当前不内置新增的 MCP HTTP 服务，不自动执行模型训练。

**关闭窗口后还能继续吗？**

可以，关闭工作台或知识库窗口后，已启动的后台任务继续处理。退出 Zotero 会中断。知识库重新提取会复用可用的 Embedding 并对记录去重，但仍可能重新调用 LLM；不等于精确分组断点续跑。

## 开发与构建

```bash
git clone https://github.com/yunxop/Zotero-Superior-Intelligence.git
cd Zotero-Superior-Intelligence
python build_xpi.py
# 输出：dist/zotero-superior-intelligence-2.0.0.xpi
```

开发测试使用 Node.js 22.13+ / 24，以及 Playwright：

```bash
npm install
npx playwright install chromium
npm run test:all
# 只验证科研写作知识库与主题管理
npm run test:writing
```

完整套件包含 **24 个测试脚本**，覆盖任务与恢复、原文核验、数据库迁移、主题整理、导出及浏览器交互。可用 `CHROME_PATH` 指定系统 Chrome；自动化测试不替代真实 Zotero 和真实 API 联调。

源码位于 `plugin_src/`，测试位于 `tests/`，构建输出位于 `dist/`。详见 [项目架构](PROJECT_ARCHITECTURE.md)。自动更新清单仅在对应 GitHub Release 附件可下载后更新。

<a id="english"></a>

## English

**Zotero Superior Intelligence (SI) 2.0.0 is a free, open-source research assistant for Zotero 10.0.x. No plugin subscription, membership, or paid feature tier. Third-party API services may charge separately.**

- **Chat with PDFs:** ask follow-up questions in the reader sidebar, edit answers, and save Zotero notes.
- **Highlight papers automatically:** create color-coded PDF annotations for findings, mechanisms, methods, research gaps, and reusable passages.
- **Extract writing examples and scientific evidence:** retain original English sentences, Chinese explanations, writing patterns, quantitative findings, DOI references, and page links.
- **Build a reusable knowledge base:** process selected papers, nested collections, or the current library; review records and export Markdown, Agent JSONL, or approved-only training JSONL.
- **Manage topics in 2.0.0:** search, pin, archive, organize with folders and tags, rename or merge topics, move or share records, restore deleted entries, and inspect extraction history.

The plugin stores the knowledge base locally in SQLite and Markdown. Cloud analysis sends relevant text to your configured providers. Local compatible LLM endpoints and keyword-only filtering are available. Scanned PDFs require OCR for source-linked extraction.

See [Releases](https://github.com/yunxop/Zotero-Superior-Intelligence/releases) for published builds. The 2.0.0 build artifact is `zotero-superior-intelligence-2.0.0.xpi`.

## 许可证与鸣谢

本项目基于 [GNU Affero General Public License v3.0](LICENSE) 开源。

感谢 [Zotero](https://www.zotero.org/)、[MinerU](https://github.com/opendatalab/MinerU) 和 [KaTeX](https://katex.org/)。科研写作工作流的参考项目与接口说明见 [知识库文档](docs/writing-knowledge.md#验证与参考)。
