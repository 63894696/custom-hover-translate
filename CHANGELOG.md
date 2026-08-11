# Changelog

## [2026-08-12] / 视频双语字幕 + 图片右键翻译(3f949f8)

### Features
- **视频双语字幕**:在视频上叠加双语字幕,复用现有翻译引擎(不另起服务)
  - YouTube 优先:解析 `ytInitialPlayerResponse` 字幕轨(timedtext),优先人工字幕、回落机翻 asr
  - 基础分句优化:asr 碎句按终止标点 / 间隔 <0.6s / 合并 ≤80 字合并成自然句
  - 通用 HTML5 兜底:`<video>+<track>` 站点经 TextTrack cuechange 跟随
  - 整轨批量翻译:走 `%%` 批量 + LRU 缓存,按文本去重(重复句只译一次),逐句回填,边播边译
  - 双语 / 仅译文两种模式;options fieldset + popup 快捷开关
- **图片右键·图相关文本翻译**(不含 OCR):图片右键 → 收集 `alt`/`title`/`aria-label`/`figcaption`/相邻说明(≤300 字)→ 经引擎翻译在图旁弹气泡;options 可关;无文字信息友好提示

### Technical
- `extension/src/subtitles.js`(新):自包含 IIFE 挂 `self.CT_SUBTITLES`;detectVideoSupport / listCaptionTracks / pickCaptionTrack / parseJson3 / optimizeSentences / fetchCaptionCues / translateTrack / attachYouTube / attachGenericTextTrack
- **YouTube pot 令牌绕行**:timedtext 直 fetch 返 200 但空体(2025 pot 反爬),改经 background `fetch-text` 代取(仅 `youtube.com/api/timedtext`,带 cookie,不代理其它请求)
- `background.js`:`fetch-text` handler + `translate-image` 右键菜单 + 统一 `forwardToContent`(注入重试)
- `content.js`:`translateImageAtCursor` / `gatherImageText`(alt→title→aria-label→figcaption→sibling 兜底链)+ 字幕启停/模式监听
- `manifest.json`:content_scripts 加 `src/subtitles.js`;host_permissions 加 `https://www.youtube.com/*`
- 隐私:字幕/图文本仅经用户引擎;图片**不做像素级 OCR**;`_ct_log` 只记元数据

### 验证
- Node 单元:parseJson3 / optimizeSentences 3 边界 / translateTrack 去重回填 / gatherImageText 兜底链,全通过
- 真实页:subtitles.js 注入 ✓、isYouTubeWatch ✓、captionTracks 检测(6 轨)✓、pickCaptionTrack 选 en 人工轨 ✓、pot 空体诊断 → background 代取已实现

### 未测(标原因,下轮联调)
- pot 代取端到端返回真实 cues(CDP isolated-world 每次 reload 后 world id 失效,阻塞最终确认)
- 双语 overlay 实播渲染 / 通用 TextTrack overlay 非 YouTube 页 / 图片右键实页 —— 同上,world 抖动 + 测试视频回退

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
