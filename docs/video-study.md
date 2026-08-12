# 视频学习(双语字幕 + AI 帧笔记)

> 状态:功能已实现 + 实机 E2E 通过(2026-08-12)
> 模块:`extension/src/subtitles.js` + `video-notes.js` + `video-study.js`(统一入口)

---

## 0. 一句话定位

在任何能播的 HTML5 视频上,**一键同时开两件事**:双语字幕 overlay(纯翻译)+ AI 帧笔记(多模态,带时间戳)。不依赖任何平台的字幕接口,也不需要逐站适配。

这是相对 HoverNotes 的关键差异:**HoverNotes 开笔记模式就看不到字幕**;我们把两条管线并行,笔记和外语字幕同屏。

---

## 1. 双模架构

```
            <video>(任何 HTML5 视频)
                │
   ┌────────────┴────────────┐
   │                         │
字幕轨(CT_SUBTITLES)      帧笔记(CT_VNOTES)
纯翻译提示词               笔记提示词
   │                         │
通用 TextTrack             定时 canvas 抽帧
cuechange → 双语 overlay   → dataURL(jpeg)
   │                         │
   └──── 翻译引擎(背景)─────┴── 多模态引擎(背景 vision-note)
        translate-batch            image_url 消息
```

两条管线**互不干扰**,共享同一个 `<video>` 和同一套用户配置的端点。

---

## 2. 三模块职责

| 模块 | 全局 | 职责 |
|---|---|---|
| `subtitles.js` | `CT_SUBTITLES` | 字幕轨。YouTube(timedtext)+ 通用 TextTrack 兜底;`cuechange`/`timeupdate` 驱动双语 overlay;走 `translate-batch` 翻译 |
| `video-notes.js` | `CT_VNOTES` | 帧笔记。定时抽帧 → 多模态 → 笔记侧栏(带时间戳,可点击跳转);手动截图;导出 Markdown |
| `video-study.js` | `CT_VSTUDY` | **统一入口**。视频角落悬浮按钮 → 一键启动双模;增强笔记面板(字幕开关/截图/⬇MD) |

### 2.1 字幕轨(`CT_SUBTITLES`)
- **检测**:`isYouTubeWatch()` → YouTube 轨;否则 `findPrimaryVideo()` → 通用 HTML5。
- **YouTube**:解析 `ytInitialPlayerResponse.captions.captionTracks`,`pickCaptionTrack`(人工优先,回落 asr),`baseUrl + &fmt=json3` 拉 cues(`fetchCaptionCues` 优先 background 代取,兜底直 fetch),`optimizeSentences` 分句合并(终止标点 + gap<0.6s + ≤80字)。
- **通用**:`attachGenericTextTrack` 找 `<track>`,`mode='hidden'` 让浏览器解析但不出原生字幕,`cuechange` 取 `activeCues` 显示,未译句 `queueGenericTranslate` 批量回填。
- **渲染**:`ensureOverlay` 在 video 容器上叠 `.ct-sub-overlay`(原文上/译文下),`setLines` 按 `bilingual`/`replace` 显隐。

### 2.2 帧笔记(`CT_VNOTES`)
- **抽帧**:`captureFrame` 用离屏 canvas `drawImage(video)` → `toDataURL('image/jpeg', .72)`,最长边压到 `maxW`(默认 512)省 token。**跨域污染媒体(无 CORS 头)会抛 SecurityError → 返回 null 跳过**,字幕轨不受影响。
- **笔记提示词(结构化)**:`buildNotePrompt` 与纯翻译**分离**,对齐 HoverNotes 基线——系统提示要求「看懂画面+结合前面已记上下文,提炼要点」「新主题给 `### 标题`,延续主题不给」「外语术语中英对照」「bullet 要点+加粗关键词」。`_recent`(最近 4 条)作为上下文喂入,供 LLM 判断主题是否延续。这正是 HoverNotes 缺的另一半。
- **状态机(交通灯)**:`idle(灰) → starting(黄,接指令/请求在飞,脉动) → working(绿,成功出笔记) → error(红)`。`setStatusState` 驱动;`onStatus(fn)` 订阅让 video-study 悬浮按钮灯与面板头灯**双灯同步**。`statusFromResponse` 由 vision-note 返回推断(needConfig/error/empty→红,ok→绿),网络延迟期间停在黄灯,让用户一眼看懂卡在准备还是已在工作。
- **内容感知去重(省 token)**:真实视频大量时间画面静止。`frameSample` 把帧缩到 32×32,`meanAbsDiffRGB` 对 RGB 三通道与上一帧求均差,`contentChanged` 仅在均差 ≥ 8(实测:同帧微噪 0.1 / 换背景色 17.3 / 加内容 9.9)才发请求;静止帧跳过并 `_skipCount` 计数,状态栏显「画面未变,跳过(已省 N 次)」。比 dHash(对低纹理钝)、亮度直方图(对色相盲)更适配幻灯片/板书场景。模型被告知「只在画面实质变化时才给帧」,无新信息可回「跳过」不记入。
- **节奏**:`intervalMs`(默认 8s)定时 `tick`,播放中才抽,`busy` 单帧在飞防并发。
- **侧栏**:右上 `.ct-vnotes-panel`,头部含状态灯 + 已记条数;`addNote` 解析 LLM 输出的 `### 标题` → 渲染分段标题(`ct-vnotes-heading`),正文 bullet 渲染加粗;每条 `[时间戳] 笔记正文`,时间戳可点击 `video.currentTime = t` 跳回。

### 2.3 统一入口(`CT_VSTUDY`)
- **悬浮按钮**:`mousemove` 检测悬停视频 → 视频右上角浮出「✎ 视频学习」圆钮(HoverNotes 同款触发)。
- **一键双模**:`toggle()` → `CT_SUBTITLES.start({mode:'bilingual'})` + `CT_VNOTES.start()` 并行。
- **面板增强**:在笔记面板头部下加控制条 —— 字幕开关(单独启停字幕,不影响笔记)、📷 手动截图、⬇ MD 导出。

---

## 3. 多模态引擎接入(background `vision-note`)

帧笔记不调文本翻译路径,走独立的 `vision-note` 消息(见 `background.js`):

```js
// content → background
{ type: 'vision-note', base64: <dataURL>, system, user, maxTokens }
// background → OpenAI 兼容多模态端点
POST {baseURL}/chat/completions
{ model, messages: [
    { role:'system', content: system },
    { role:'user', content: [
        { type:'text', text: user },
        { type:'image_url', image_url:{ url: dataURL } } ] } ],
  max_tokens, stream:false }
```

- **模型选择**:`visionModel`(可单独配多模态模型)缺省复用主 `model`。
- **不设 `temperature`**:多模态推理模型(Agnes 2.5 / Kimi k3)对温度有限制,用各家默认避免 400。
- **max_tokens 给足**:推理模型会消耗 `reasoning_tokens`,默认 700,过小会返空。

### 实测可用的多模态端点(2026-08-12 同图对比)
| 端点 | 模型 | 结果 | 注意 |
|---|---|---|---|
| Agnes `apihub.agnes-ai.com/v1` | `agnes-2.5-flash` | ✅ 干净、5s | **推荐**;2.0-flash 官方免费 |
| MiniMax `api.minimax.chat/v1` | `MiniMax-M3` | ✅ 但夹 `<think>` | 需代码剥思维链 |
| Kimi `api.moonshot.cn/v1` | `kimi-k2.5` | ✅ 但 temp 强制 1 | 幻觉风险略高 |
| Kimi | `moonshot-v1-*-vision-preview` | ✅ | 老牌视觉 |

---

## 4. 使用流程(复用 HoverNotes 习惯)

1. 装好扩展,在设置里配好多模态端点(如 Agnes `agnes-2.5-flash`)。
2. 打开任意视频页(YouTube / Bilibili / TED / 任意 HTML5)。
3. **悬停视频** → 右上角浮出「✎ 视频学习」按钮。
4. **点击** → 右侧开笔记面板,双语字幕 + AI 笔记同时开始。
5. 看视频:字幕 overlay 显示外语原文 + 译文;AI 每 8s 记一条带时间戳的笔记。
6. 需要时:点 📷 手动截图(板书/图示),点时间戳跳回重看。
7. 看完:点 ⬇ MD 下载 Markdown 笔记(含来源链接 + 时间戳列表)。

> 与 HoverNotes 的对应:悬浮按钮触发(同)、视频旁笔记面板(同)、时间戳跳转(同)、截图(同)、AI 自动笔记(同)、Markdown 导出(同,HoverNotes 到 Obsidian,我们直接下 .md)。**差异:我们多了双语字幕 overlay,且全程本地、无需注册/连 Obsidian。**

---

## 5. 导出 Markdown 格式(HoverNotes 风格,带 YAML frontmatter)

```markdown
---
title: "视频标题"
source: https://...
created: "2026-08-12"
tags:
  - hover-notes
---

# 视频标题

- 来源: https://...
- 导出时间: 2026-08-12 11:00:00
- 笔记条数: 12

### Chapter 1: Vectors(向量)

- **[00:00](https://...?t=0s)** - **向量(Vector)**:同时具有**大小(Magnitude)**和**方向(Direction)**的物理量
- **[00:10](https://...?t=10s)** - 大小 = 长度(Length),即向量的数值量度

### Chapter 2: Matrices

- **[00:20](https://...?t=20s)** [截图]

> 由 Prisir 视频学习生成(双语字幕 + AI 帧笔记)
```

有分段标题(`n.heading`)先出 `### 标题`,再出带时间戳的要点;内联标题在导出时剥离只留正文。时间戳链接带 `?t=秒数`,在支持的平台(YouTube 等)可直接定位;本页内点击侧栏时间戳则直接 `video.currentTime` 跳转。

---

## 6. 隐私红线

- 帧图仅经**用户自己配置**的 OpenAI 兼容端点,不经过任何我们的服务器。
- 抽帧在页面内存完成,**不落盘**;笔记文本存于页面,刷新即失,导出由用户主动触发。
- 密钥存于浏览器 `chrome.storage.local`,不上传。
- `fetch-text` 代取仅白名单 `youtube.com/api/timedtext`,不作通用代理。

---

## 7. 已知边界

- **跨域媒体帧不可读**:无 CORS 头的跨域 `<video>` 抽帧抛 SecurityError → 帧笔记跳过(字幕轨仍可用)。YouTube/B站播放器一般可读;部分站点需 CORS。
- **YouTube pot 拦截**:timedtext 服务端要求 pot token,所有凭证模式均返 200 空体(换 VPN 无效)→ YouTube 字幕轨当前**环境受限**,但通用 TextTrack 与帧笔记不受影响。帧笔记正好绕开此限制。
- **推理模型成本**:多模态 + 推理模型(Agnes 2.5/Kimi k3)token 消耗较大,`intervalMs` 不宜过小(默认 8s 是省 token 档)。
- **HTTP 媒体在 CDP 新建 tab 挂起**(测试环境特性):E2E 用 `canvas.captureStream` 驱动 `timeupdate` 绕过,真实浏览器无此问题。

---

## 8. E2E 验证(2026-08-12 实机,SecBrowser CDP)

### 8.1 双模基础(`tests/_vstudy_e2e.py`)
| 项 | 结果 | 证据 |
|---|---|---|
| 三模块注入 | ✅ | `{vstudy,vnotes,subs: object}` |
| 悬浮按钮出现 | ✅ | `✎视频学习` 位于视频角落 |
| 一键双模启动 | ✅ | `subs:{ok,kind:html5} + notes:{ok}` |
| AI 笔记产出 | ✅ | `向量是既有大小又有方向的量` |
| 字幕 overlay 绑定 | ✅ | `subs_bound: true` |
| 时间戳跳转 | ✅ | `clicked_00:00` |
| 面板控制条 | ✅ | 字幕开关/截图/⬇MD |
| Markdown 导出 | ✅ | `downloadMarkdown` 可用 |

### 8.2 交通灯 + 结构化笔记(`tests/_vlight_e2e.py`,8/8 通过)
| 项 | 结果 | 证据 |
|---|---|---|
| 状态机 idle→starting(黄) | ✅ | `lamp_initial: {status:starting, lamp:starting}` |
| 状态机 →working(绿) | ✅ | `final: {status:working, lamp:working}` |
| 转换次序 starting→working | ✅ | `trace: [idle→starting→working→starting→working]`(每帧请求在飞回黄,出笔记回绿) |
| 面板灯 + FAB 灯双灯同步 | ✅ | `fab_lamp: working` |
| 结构化笔记(### 标题) | ✅ | `headings: ["Chapter 1: Vectors(向量)", ...]` |
| bullet 要点 + 加粗关键词 | ✅ | `- **向量(Vector)**:同时具有**大小(Magnitude)**…` |
| 术语中英对照 | ✅ | `向量(Vector)/大小(Magnitude)/方向(Direction)` |
| Markdown 导出(YAML+###) | ✅ | frontmatter `tags: hover-notes` + `### 分段` |

截图:`tests/_vstudy_dual.jpg`、`tests/_notes_panel.jpg`、`tests/_vlight_notes.jpg`(绿灯+分段标题+bullet 加粗)。

### 8.3 内容感知去重(`tests/_vdedup_e2e.py` / `_vdedup_e2e2.py`)
| 项 | 结果 | 证据 |
|---|---|---|
| 静止帧跳过(省 token) | ✅ | `skipped: 3+`,状态栏「画面未变,跳过(已省 N 次)」 |
| 主题切换仍出新笔记 | ✅ | 切主题B 出「第二章:矩阵(Matrices)」 |
| 笔记数远少于 tick 数 | ✅ | `notes=2` vs tick≈11,无每帧重复 |
| 逐帧均差分布 | ✅ | 静态期全 0,切换尖峰 16.08(阈值 8) |

### 8.4 防模型空转(`tests/_vstall_e2e.py`,6/6 通过)
分级处理「没在播」:真性播放(绿)/ 网络缓冲·时间不动(黄提示,**不发请求**)/ 用户暂停(灰,90s 宽限)。超宽限在面板内弹**非模态**询问条(不抢焦点),恢复播放自动消条。
| 场景 | 期望 | 结果 |
|---|---|---|
| 模块注入 + start | CT_VNOTES 就绪 | ✅ |
| 播中 | 无询问条,status working | ✅ |
| 暂停超宽限(2min) | 弹「要继续记笔记吗?」条 + 灰灯 idle | ✅ |
| 点「继续」 | 消条 + 回 working + 尝试 play | ✅ |
| 网络缓冲(时间不走) | 黄灯 starting + 「缓冲中/画面停滞」提示 + 不弹条 | ✅ |
| 点「停止」 | 走 stop() 彻底停 | ✅(按钮路径) |

