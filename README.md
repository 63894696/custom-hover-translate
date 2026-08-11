# Custom Hover Translate

沉浸式风格的网页翻译 Chrome/Edge 扩展。

## 特性

- **整页双语对照**:原文 + 译文并列,沉浸式风格
- **整页仅译文**:原文直接替换成中文
- **一键模式切换**:双语 ↔ 仅译文 沉浸式风格的快速 toggle
- **右键翻译**:选中文字 → 右键 → 鼠标位置弹气泡显示译文(immersive 风格)
- **全局跟踪翻译**:打开任意外文页面自动翻译,菜单展开 / FAQ / SPA 路由变化自动跟进
- **多 provider 支持**:Google Translate gtx(默认,无需 key)→ 阿里百炼 → 火山方舟 → OpenRouter ... fallback chain 自动切换
- **离线友好**:所有翻译走后端 API,扩展本身 153KB(沉浸式翻译 1.30.2 的 1/260)

## 安装

### 1. 启动翻译后端

需要本地 Node.js 18+。在 `backend/` 目录下:

```bash
cd backend
cp .env.example .env
# 编辑 .env,填入你的 LLM API key(可选 — Google Translate gtx 无需 key)
npm install
npm start
```

后端默认监听 `http://127.0.0.1:12308`,GET /health 应返回 `{"ok":true,"provider":"google_gtx"}`。

### 2. 加载扩展

1. 浏览器打开 `chrome://extensions`(或 `edge://extensions`)
2. 开启右上角"开发者模式"
3. 点"加载已解压的扩展" → 选 `extension/` 目录
4. 工具栏出现蓝色"译"字图标

## 配置

点扩展图标 → "打开设置",可配置:
- 后端 Endpoint URL(默认 `http://127.0.0.1:12308`)
- LLM Provider(google_gtx / bailian / doubao / openrouter / ollama ...)
- Model(留空用 provider 默认)
- API Key(Google Translate gtx / Ollama 无需 key)
- API Base URL(仅 custom 模式)
- 翻译行为(目标语言 / 段长阈值 / 缓存 TTL)

## 翻译模式对比

| 模式 | 行为 | 适合 |
|---|---|---|
| **整页双语对照** | 原文下方追加中文 | 学习外语 / 对照阅读 |
| **整页仅译文** | 原文直接换成中文 | 快速阅读 / 节省屏幕空间 |
| **右键翻译** | 选中文字 → 弹气泡 | 漏译 / 临时翻译短语 |

## 多 provider + 自动 fallback

默认 fallback chain:`google_gtx → bailian → doubao → openrouter`

- 任意一档失败(429/403/5xx/网络错/空文本)→ 自动切下一档
- 翻译进度气泡底部小字显示当前生效的 provider / 耗时 / fallback 链
- Google Translate gtx 是默认首选(2-3s/条,无需 key),断开 VPN 时会失败 → 自动跳到下一档

---

## ✨ AI 翻译增强(v2026.08,自定义端点专属)

当你选用 **自定义端点(OpenAI 兼容)** 时,解锁以下能力。这些只在 `engine = openai_compat` 时生效 —— Google gtx / 本地后端没有提示词概念。

### 🎭 12 种 AI 角色提示词(`promptRole`)

同一台模型,换个"角色"得到面向不同场景的译文。在 **popup → 高级设置** 或 **options → 翻译策略** 里切换:

| 角色 | 适用场景 | 支持 %% 批量 |
|---|---|---|
| 通用 general | 日常网页 | ✅ |
| 润色 polish | 提升行文质感(先直译再润) | ❌(逐条) |
| 意译大师 | 重表达轻字面对应 | ✅ |
| 学术 academic | 论文 / 研究报告 | ✅ |
| 技术 tech | 文档 / API / 代码注释 | ✅ |
| 新闻 news | 媒体报道 | ✅ |
| Reddit / Twitter / GitHub | 对应社区语气 | ✅ |
| 小说 fiction | 文学作品 | ✅ |
| 游戏 game | 游戏文本 | ✅ |
| 电商 ecommerce | 商品描述 | ✅ |
| 中英混排 zh-en-mix | 保留专有名词英文 | ✅ |

实现见 [extension/src/prompts.js](extension/src/prompts.js)。`buildPrompt()` 注入 `{{to}}` / `{{text}}` / `{{terms_prompt}}` 占位符。

### 📖 术语表(`termsText`)

options → 翻译策略 → 术语表,一行一条 `原文=译文`:

```
Babelspan=通天尺规
rubric=尺规
```

翻译时自动以"术语约束"注入提示词,保证专有名词一致。

### 🌡️ 温度 / 并发(`temperature` / `concurrency`)

- **温度** 0–2,默认 0.2。越小越稳定(直译场景),调大可增加多样性(意译 / 文学)。
- **并发** 1–20,默认 6。控制 `%%` 批量协议的并发请求数。

### ⚡ `%%` 批量协议(`engineTranslateBatch`)

整页翻译时,**同语言同角色的多条文本**合并成**一次** chat completion(用 `\n%%\n` 分隔),模型原样回分隔,再切回单条。省 token、降延迟。若切分条数对不上,自动回退逐条翻译,**不丢数据**。仅 `batchOK: true` 的角色启用。

### 🔌 测试服务按钮

options / popup 里填好 Base URL + Key + Model 后,点 **测试服务** 发一条 "Hello",即时显示 `✓ 通了 · 模型 · 耗时 · 回包` 或具体错误(HTTP 状态码)。**Key 不发往任何第三方,只在你本机 ↔ 你填的端点之间**。

### 🧭 模型怎么选

不确定接哪家?看 babelspan 内容站的 [翻译模型怎么选](https://www.babelspan.com/models.html) —— 中立对比国内免费/低价(智谱 GLM、阿里 Qwen、DeepSeek、Kimi、豆包)与海外(OpenAI / Anthropic / Google),不锁定任何厂商。popup 需配置时也会引导到这里。

---

## 文档翻译(外部工具)

点 popup 底部 **"📄 翻译 PDF / 文档"** 按钮,跳转到 [pdftranslator.org](https://pdftranslator.org/zh) 在线翻译 PDF / 文档(免费 1000 页/月,无需注册)。

## 项目结构

```
translate-extension-release/
├── extension/                # Chrome/Edge MV3 扩展源码
│   ├── manifest.json
│   ├── icons/
│   └── src/
│       ├── content.js       # 主翻译逻辑(1180+ 行,沉浸式 1.30.2 规则已集成)
│       ├── background.js    # Service worker(右键菜单 + 后端转发 + %% 批量 + 测试服务)
│       ├── langs.js         # 目标语言清单 + 系统语言推断
│       ├── prompts.js       # 12 种 AI 角色提示词 + %% 批量协议(buildPrompt/splitBatch)
│       ├── engines.js       # 引擎抽象(google_gtx / openai_compat / local_backend / auto 路由)
│       ├── popup.html/.js   # 弹出界面(角色下拉 / 温度 / 测试服务)
│       ├── options.html/.js # 设置页(术语表 / 并发 / 角色策略)
│       └── inject.css       # 翻译样式 + 气泡样式
└── backend/                  # Node.js 翻译后端
    ├── src/
    │   ├── server.js        # Express + 3 endpoints(/translate / /translate/batch / /select-provider / /health / /providers)
    │   ├── llm.js           # LLMClient(axios)+ chatTranslate(fallback chain)
    │   ├── providers.js     # 9 个 provider 注册(google_gtx / bailian / doubao / openrouter / ollama ...)
    │   └── config.js        # .env 解析 + 运行时 override
    ├── prompts/translate.js  # 翻译 prompt
    └── .env.example          # 配置模板
```

## 体积

- extension/:153 KB(未压缩)/ ~70 KB(Chrome .crx 压缩后)
- 对比沉浸式翻译 1.30.2(本地 39 MB):本扩展仅其 **1/260**

## 隐私

本扩展:
- **不收集任何用户数据**
- 所有翻译走用户自建后端(localhost:12308),翻译内容不发送到任何第三方
- API Key 仅存于 `chrome.storage.local`(用户本机),不上传
- 仅请求最小权限:`storage` / `activeTab` / `scripting` / `webNavigation` / `contextMenus`

详见 [PRIVACY.md](PRIVACY.md)。

## License

MIT

---

## ⚠️ 发布说明(发布版本)

本发布版的 **3 个 LLM 真实 key 已在发布前清空**(替换为占位符)。

**重要 — 如果你之前拿到过本项目的旧源码并配置过真实 key,请立即去对应平台 revoke 旧 key 并生成新 key(轮换)**:

| Provider | 平台 | 链接 |
|---|---|---|
| 阿里云百炼 (Bailian) | 阿里云控制台 → API-Key 管理 | https://dashscope.console.aliyun.com/apiKey |
| 火山方舟 (Doubao) | 火山引擎控制台 → API 密钥 | https://www.volcengine.com/product/doubao |
| OpenRouter | OpenRouter → Keys | https://openrouter.ai/keys |

轮换后,在本项目的 `backend/.env` 里填入新 key(或在扩展 options 页填)。

本发布版的 `backend/.env.example` 只含**占位符**(`your-bailian-key-here` 等),不会泄露任何真实 key。`.gitignore` 防止 `.env` 被 git 误提交。

