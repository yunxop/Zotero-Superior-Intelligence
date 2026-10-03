# 自动化测试套件架构设计（Automated Test Suite Catalog）

本目录负责承载 Zotero Superior Intelligence (SI) 核心逻辑模块的离线端到端与单元测试。
输入为 mock 的 Zotero 运行时沙箱环境、虚拟 PDF 文本流、以及大模型模拟响应。
输出为各模块逻辑断言结果、回归校验报告与安全脱敏合规性验证。

---

## 关键测试文件清单

| 测试文件名 | 地位 | 功能描述 | 输入数据 | 期望断言与输出 |
| :--- | :--- | :--- | :--- | :--- |
| `TESTS_CATALOG.md` | 目录架构文档 | 描述测试目录职责、运行方式与用例索引 | 测试目录树 | 架构全景索引 |
| `smoke.js` | 核心冒烟测试 | 校验 Markdown/KaTeX 安全转义、ZoteroAdapter 笔记落库、Token 统计与主链路 | 模拟富文本与 DOM 节点 | 确保无 XSS、笔记数据结构完整无误 |
| `auto_highlight.js` | 智能高亮测试 | 检验学术要点（结论、方法、机制）在 PDF 坐标中的定位与标引算法 | 模拟 PDF 页面与字符流 | 准确提取学术要点并规避原型污染 |
| `batch.js` | 批量处理测试 | 验证多篇文献串行队列调度、中断保护、单篇失败容错与进度汇总 | 选中文献 ID 数组 | 任务状态转换正确，失败不阻断队列 |
| `dashboard.js` | 科研工作台测试 | 验证工作台文献状态同步、任务卡片渲染与多模型配置联动 | 模拟条目集合与首选项 | 工作台 UI 状态与历史记录渲染正确 |
| `errors.js` | 异常与脱敏测试 | 校验 API 请求失败时的诊断信息提取及敏感凭据（API Key/Token）抹除 | 包含 Bearer Token 的错误栈 | 错误提示明确且绝不泄漏任何密钥 |
| `library.js` | 全库检索测试 | 验证文献库倒排索引生成、跨篇关键词语义混合检索与引文卡片装配 | 全库元数据与摘要集合 | 检索匹配度排序正确，引文溯源准确 |
| `library_ui.js` | 全库对话 UI 测试 | 校验全库问答窗口的 DOM 节点注入、流式问答追加与事件解绑 | 交互事件与提问文本 | 聊天面板正常挂载与卸载，无内存泄漏 |
| `llm_controls.js` | 模型配置测试 | 验证多模型配置（Profiles）轮换、参数序列化与激活状态切换 | 预设配置 JSON 字典 | 默认模型回退正确，多配置读写隔离 |
| `summary_text_cache.js` | 提取正文缓存测试 | 验证会话级文献提取结果的内存哈希指纹缓存与并发加锁机制 | PDF 路径与文献指纹 | 重复请求命中缓存，并发请求不重复提取 |
| `usage_layout.js` | Token 消耗统计测试 | 验证大模型消耗计量计算、多模型费用估算与持久化聚合 | Prompt/Completion Tokens | 计费计量准确且支持按模型维度统计 |

---

## 新增行为回归

- `math_rendering.js`：真实 KaTeX、四类公式分隔符、代码隔离、原生笔记和 XML 文档导入。
- `reader_protection.js`：清空后另建笔记、并发保存、迟到回答取消和阅读器设置重开。
- `task_settings.js`：全局思考、各任务 Token 上限及工作台任务类型保存。
- `task_resume.js`：跨运行时检查点恢复、参数变化失效和 LLM/MinerU 取消。
- `task_integration.js`：总结笔记去重、批处理重启恢复和高亮取消回滚。

浏览器测试使用 Playwright；安装依赖后运行 `npx playwright install chromium`，也可设置 `CHROME_PATH` 使用系统 Chrome。

## 运行方式

测试套件基于 Node.js 原生 `node:assert/strict` 与 `node:vm` 沙箱执行，无需额外安装重型依赖：

```bash
# 执行全部测试
npm run test:all

# 或单项运行冒烟测试
node tests/smoke.js
```
