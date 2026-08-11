# 翻译模块测试

## replace-p0(仅译文破框架,2026-08-11 P0 修复)
- `replace-p0-page.html` — 模拟"导航+导语多文本容器"(复现用户截图1 结构),stub chrome API,`<script src="/content.js">` 加载真实 content.js。
- `serve.py` — 本地 http 服务(8123),托管测试页 + 真实 content.js。

### 跑法(任一有 DevTools/CDP 的浏览器)
1. `python serve.py`(8123)
2. 浏览器开 `http://127.0.0.1:8123/`,确认 content.js 已注入(`window.__ctOnMessage` 是 function)。
3. 控制台依次跑:
   - replace-all: `new Promise(r=>__ctOnMessage({type:'replace-all'},null,r))`
   - 断言: `.hero` 自身不带 `.ct-replaced`、`:scope > .ct-repl-main` 为 0;4 个 hero `<p>` 各自 `.ct-replaced`;`.col` 仍为 2;无双重翻译。
   - remove-all 还原: `new Promise(r=>__ctOnMessage({type:'remove-all'},null,r))` → 原文 100% 还原。
   - bilingual 回归: `new Promise(r=>__ctOnMessage({type:'translate-all'},null,r))` → 原文+译文并存、结构保留。

> 本窗已用 puppeteer-mcp(Chromium)验证全绿,见会话记录。真机(secbrowser/SecureDM 壳)验证待确认扩展加载入口。
