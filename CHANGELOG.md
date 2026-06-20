# Changelog

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
