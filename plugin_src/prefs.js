// input: default configuration schema
// output: default user preferences tree
// pos: initializes default preferences for MinerU extraction and LLM connection

pref("extensions.zoteromineru.mineruMode", "agent");
pref("extensions.zoteromineru.mineruModel", "vlm");
pref("extensions.zoteromineru.mineruToken", "");
pref("extensions.zoteromineru.customPrompt", "");
pref("extensions.zoteromineru.llmProvider", "deepseek");
pref("extensions.zoteromineru.llmApiBase", "https://api.deepseek.com/v1");
pref("extensions.zoteromineru.llmApiKey", "");
pref("extensions.zoteromineru.llmModel", "deepseek-flash");
pref("extensions.zoteromineru.llmProfiles", "");
pref("extensions.zoteromineru.llmActiveProfile", 1);
pref("extensions.zoteromineru.llmUsage", "{}");
pref("extensions.zoteromineru.summaryTasks", "{}");
pref("extensions.zoteromineru.taskSettings", "{}");
pref("extensions.zoteromineru.lastSummaryType", "paper_summary");
pref("extensions.zoteromineru.batchQueue", "{}");
pref("extensions.zoteromineru.paperSummaryPrompt", "");
pref("extensions.zoteromineru.tableSummaryPrompt", "");
pref("extensions.zoteromineru.autoGenerateNote", true);
pref("extensions.zoteromineru.autoTag", true);
