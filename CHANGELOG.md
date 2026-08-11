# Changelog

## [2026-08-12] / AI 翻译增强(自定义端点)

### Features
- **12 种 AI 角色提示词**(`promptRole`):通用 / 润色 / 意译大师 / 学术 / 技术 / 新闻 / Reddit / Twitter / GitHub / 小说 / 游戏 / 电商 / 中英混排,同一模型切换角色得不同场景译文
- **术语表**(`termsText`):一行一条 `原文=译文`,翻译时作为术语约束注入提示词,保证专有名词一致
- **温度 / 并发开放**(`temperature` 0–2 默认 0.2,`concurrency` 1–20 默认 6)
- **`%%` 批量协议**(`engineTranslateBatch`):同语言同角色多条文本合并成一次 chat completion(`\n%%\n` 分隔),省 token 降延迟;切分条数不符自动回退逐条,不丢数据
- **测试服务按钮**:options/popup 填好端点后发 "Hello" 探活,即时显示连通性 / 模型 / 耗时 / HTTP 状态
- **多语言扩充 + 系统语言推断**:目标语言扩至几十种,默认按系统语言猜测
- **属性文本翻译**:alt / aria-label / title / placeholder 一并翻译
- **babelspan 模型选型页**:popup 需配置时引导至 [翻译模型怎么选](https://www.babelspan.com/models.html)

### Technical
- `extension/src/prompts.js`:`CT_PROMPTS` 12 角色 + `buildPrompt` / `splitBatch`,`{{to}}/{{text}}/{{terms_prompt}}` 占位符
- `extension/src/engines.js`:`engineTranslateBatch`(批量守卫:too_few / not_openai_compat / role_no_batch / no_prompts;estTokens 动态估算;split mismatch → retryable:false)
- `extension/src/background.js`:`importScripts('langs.js','prompts.js','engines.js')`(顺序敏感);handleTranslateBatch 先试批量、失败回退 per-item;新增 test-service handler
- AI 能力仅 `engine = openai_compat` 生效;Google gtx / 本地后端无提示词概念
- 隐私:Key / 角色 / 术语 / 温度 / 并发全部仅存 `chrome.storage.local`;`_ct_log` 诊断环(≤100 条)只记元数据不记文本

### 验证
- 引擎层 E2E(local mock endpoint):角色切换 / 默认温度 0.2 / 温度可调 / %% 批量一次请求多条 / polish 拒绝批量 / splitBatch mismatch → null,7/7 通过
- 真实提供商 E2E(SiliconFlow Qwen2.5-7B):test-service ✓、general/academic/fiction 角色译文分化 ✓、%% 批量 3 条一次请求 `batched:true` ✓

## [Unreleased] / 准备首次发布

### Features
- **整页双语对照**:沉浸式风格,原文下方追加中文译文
- **整页仅译文**:原文直接替换成中文
- **一键模式切换**:双语 ↔ 仅译文,沉浸式风格 toggle 按钮
- **右键翻译**:选中文字 → 右键 → 鼠标位置弹气泡显示译文(immersive 原位 popup)
- **全局跟踪翻译**:打开任意外文页面自动翻译,菜单展开 / FAQ / SPA 路由变化自动跟进
- **多 provider + fallback chain**:Google Translate gtx(默认,无需 key)→ 阿里百炼 → 火山方舟 → OpenRouter 自动 fallback
- **MutationObserver 全文跟进**:监听 childList + attributes + characterData,FAQ 展开 / Radix popover / React 状态变化自动翻译
- **沉浸式 1.30.2 规则集成**:
  - `<header>` / `<nav>` / `<footer>` 整块不翻译
  - 数学公式 / code / kbd / editor 等 31 个 selector 跳过
  - GitHub row 容器黑名单(Box-row / js-issue-row / IssueItem-module 等)
  - 短文本 metadata 模式跳过("38 minutes ago" 等)
- **PDF / 文档翻译跳转**:popup 加按钮,跳转到 pdftranslator.org 在线翻译

### Technical
- 后端基于 Node.js 18+ Express,3 个 endpoint + SSE 流式进度
- 前端基于 Chrome MV3,自包含 1180+ 行 content.js(零依赖)
- 体积:扩展 153 KB(沉浸式翻译 1.30.2 的 1/260)
- 隐私:零数据收集,翻译走用户自建后端

### Known Limitations
- 不支持浏览器内嵌 PDF 翻译(推荐用 pdftranslator.org 跳转)
- 不支持 SCORM / EPUB 等复杂格式(未来功能,见 RELEASE-GATES 待办 1)
- Google Translate gtx 断 VPN 时不可用(自动 fallback)
