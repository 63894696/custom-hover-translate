// video-notes.js — 视频转笔记模块(content script 上下文,自包含 IIFE,挂 self.CT_VNOTES)
//
// 设计(2026-08-12,视频笔记最小原型):
//   「字幕轨 + 帧笔记」双模并行 —— 这是相对 HoverNotes 的关键差异点:
//     · 字幕轨(CT_SUBTITLES)走【纯翻译提示词】渲染双语 overlay,用户始终看得到外语字幕;
//     · 帧笔记(本模块)走【笔记提示词】定时抽帧喂多模态 LLM,自动生成带时间戳的笔记。
//   两条互不干扰,绕开 YouTube 字幕接口 / 第三方字幕站,任何能播的 <video> 都可用。
//
//   本模块只负责帧笔记:抽帧 → 多模态识别/翻译 → 渲染笔记侧栏。
//   字幕轨另由 subtitles.js 负责,二者可同时 start。
//
//   隐私红线:帧图仅经用户配置端点( Agnes / Kimi / MiniMax 等 OpenAI 兼容多模态),
//   不收集、不上传、不在本地持久化图像;笔记文本仅存于页面内,刷新即失(后续可导出)。

(function () {
  const STATE = {
    video: null,          // 目标 <video>
    canvas: null,         // 离屏抽帧 canvas
    ctx: null,
    panel: null,          // 笔记侧栏 DOM
    list: null,           // 笔记条目容器
    running: false,
    timer: null,          // 抽帧定时器
    intervalMs: 8000,     // 抽帧间隔(原型的省 token 档;可调)
    maxW: 512,            // 抽帧最长边(压缩省 token)
    busy: false,          // 单帧在飞,跳过并防并发
    notes: [],            // [{t, text, heading?}] 已生成笔记
    minIntervalBetweenNotes: 8000,
    status: 'idle',       // 状态机:idle|starting|working|error(驱动交通灯)
    _listeners: [],       // 状态订阅(video-study 悬浮按钮灯)
    _buffer: [],          // 待合并成段的碎笔记(按主题聚合)
    _recent: [],          // 最近几条笔记文本(给 LLM 上下文,判同主题)
    _lastFrameData: null, // 上一帧 dataURL(判画面是否变化)
    _lastHash: null,      // 上一帧感知哈希(dHash,判内容是否实质变化)
    _skipCount: 0,        // 连续跳过的静止帧数(省 token 计数)
  };

  // ---------- 工具 ----------
  function findPrimaryVideo() {
    const vids = [...document.querySelectorAll('video')];
    if (!vids.length) return null;
    let best = null, bestArea = 0;
    for (const v of vids) {
      const r = v.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > bestArea) { bestArea = area; best = v; }
    }
    return best;
  }

  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    const mm = String(m).padStart(2, '0'), ss = String(s).padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }

  // 抽当前帧为 dataURL(jpeg)。CORS 污染的 video(跨域无 CORS 头)会抛错 → 跳过。
  function captureFrame(video) {
    if (!video || video.readyState < 2) return null; // 没有可用帧
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return null;
    if (!STATE.canvas) {
      STATE.canvas = document.createElement('canvas');
      STATE.ctx = STATE.canvas.getContext('2d');
    }
    const scale = Math.min(1, STATE.maxW / Math.max(vw, vh));
    STATE.canvas.width = Math.round(vw * scale);
    STATE.canvas.height = Math.round(vh * scale);
    try {
      STATE.ctx.drawImage(video, 0, 0, STATE.canvas.width, STATE.canvas.height);
      return STATE.canvas.toDataURL('image/jpeg', 0.72);
    } catch (e) {
      // SecurityError: 跨域媒体未带 CORS → 帧不可读,放弃帧笔记(字幕轨不受影响)
      return null;
    }
  }

  // ---------- 状态机(驱动交通灯) ----------
  // idle(灰) → starting(黄,接指令/请求在飞) → working(绿,成功出笔记) → error(红,出错/缺配置)
  function setStatusState(s, txt) {
    STATE.status = s;
    if (txt) setStatus(txt);
    for (const fn of STATE._listeners) { try { fn(s); } catch (e) {} }
    applyLamp();
  }
  function onStatus(fn) { STATE._listeners.push(fn); }
  function applyLamp() {
    const lamp = STATE.panel && STATE.panel.querySelector('[data-role="lamp"]');
    if (lamp) lamp.setAttribute('data-s', STATE.status);
  }
  // 由 vision-note 的返回推断状态(needConfig / error / empty → 红;ok → 绿)
  function statusFromResponse(resp) {
    if (resp && resp.ok && resp.text) return 'working';
    if (resp && resp.needConfig) return 'error';
    if (resp && resp.error) return 'error';
    return 'error';
  }

  // ---------- 笔记提示词(结构化,对齐 HoverNotes 基线:分段标题+要点+关键洞察) ----------
  // 与纯翻译分离:不是逐句翻译,而是看懂画面+上下文,提炼成 HoverNotes 那种结构化笔记。
  function buildNotePrompt(dstLang, recent) {
    const lang = dstLang || '中文';
    const ctx = recent && recent.length
      ? `\n\n【前面已记的笔记(判断是否在讲同一主题)】\n` + recent.map((r, i) => `${i + 1}. ${r}`).join('\n')
      : '';
    return {
      system:
        '你是视频学习笔记助手,产出 HoverNotes 风格的结构化笔记。' +
        '看懂视频这一帧的画面(板书/幻灯片/讲解/字幕),结合前面已记的内容,提炼此刻的信息要点。' +
        '注意:只在画面有实质变化时才会给你这一帧(静止帧已被自动跳过、不会重复给你),所以每条都应是新进展。' +
        '要求:' +
        '(1) 用目标语言写;' +
        '(2) 若画面有外语文字/术语,顺手译成目标语言,专业术语保留中英对照(如 能动性/Agency);' +
        '(3) 输出为简洁的要点(bullet),可加粗关键词;' +
        '(4) 若这一帧开启了新主题,先给一行小标题(形如「### 主题」);若延续前面主题则不要标题;' +
        '(5) 若这一帧与已记内容重复、没有新信息,只回复两个字:跳过;' +
        '(6) 只输出笔记正文,不要解释、不要时间戳、不要说"这是一帧"。',
      user:
        `请基于这一帧和前面的笔记上下文,写一条结构化笔记(目标语言:${lang})。` +
        `这一帧相对上一帧已有变化,请提炼新进展:若是新主题给「### 标题」,否则直接给要点。` +
        `若没有新信息可记,回复「跳过」。一两句到三四个要点皆可,抓住此刻真正值得记的内容。` + ctx,
    };
  }

  // ---------- 内容感知去重(RGB 像素均差):真实视频静止帧不发请求,省 token 让模型专注接续 ----------
  // 原理:把帧缩到 32x32,逐像素对 R/G/B 三通道与上一帧求平均绝对差(meanAbsDiff)。≥ 阈值才算「内容实质变化」。
  // 用三通道而非纯灰度:换背景色(深蓝→深绿)灰度可能同亮度判不出,但 RGB 通道差异立刻冲高,色相/明暗/结构全覆盖。
  // 静止帧:JPEG 重编码噪点、captureStream 抖动只扰动个别像素 ±1-2,均差纹丝不动 → 稳定判「未变」。
  // 只留一帧 3KB 采样缓冲,对幻灯片/板书这类「整片换色换内容」的场景最稳。
  function frameSample(video) {
    const W = 32, H = 32;
    if (!STATE._hc) {
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      STATE._hc = c; STATE._hcx = c.getContext('2d', { willReadFrequently: true });
    }
    try {
      STATE._hcx.drawImage(video, 0, 0, W, H);
      return STATE._hcx.getImageData(0, 0, W, H).data; // Uint8ClampedArray,RGBA 长度 W*H*4
    } catch (e) { return null; } // 跨域污染 → 交给 captureFrame 报错路径
  }
  function meanAbsDiffRGB(a, b) {
    if (!a || !b || a.length !== b.length) return 999;
    let s = 0, n = 0;
    for (let i = 0; i < a.length; i += 4) { s += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]); n += 3; }
    return s / n;
  }
  // 与上一帧内容是否实质不同(RGB 均差 ≥ PIXEL_DIFF_THRESHOLD 才算变化)。
  // 实测参考:同一张微噪 ≈ 0-2;换背景色(同亮度不同色)≈ 15-25;翻页/正文大变 ≈ 30+。取 8 为界,兼顾防抖与灵敏。
  const PIXEL_DIFF_THRESHOLD = 8;
  function contentChanged(video) {
    const g = frameSample(video);
    if (!g) return true; // 采样失败就放行(不阻塞)
    if (!STATE._lastHash) { STATE._lastHash = g; return true; }
    const dist = meanAbsDiffRGB(g, STATE._lastHash);
    if (dist >= PIXEL_DIFF_THRESHOLD) { STATE._lastHash = g; STATE._skipCount = 0; return true; }
    STATE._skipCount++;
    return false;
  }

  // ---------- 调多模态(经 background 的 vision-note,走用户已配置的 OpenAI 兼容端点) ----------
  async function analyzeFrame(dataUrl, t) {
    const dstLang = (self.CT_LANGS && self.CT_LANGS.guessTargetLang && self.CT_LANGS.guessTargetLang()) || 'zh';
    const { system, user } = buildNotePrompt(dstLang === 'zh' ? '中文' : dstLang, STATE._recent.slice(-4));
    setStatusState('starting', '识别 ' + fmtTime(t) + ' …');
    try {
      const resp = await chrome.runtime.sendMessage({
        type: 'vision-note',
        base64: dataUrl,
        system, user,
        maxTokens: 700,
      });
      setStatusState(statusFromResponse(resp),
        resp && resp.needConfig ? '未配置端点(设置里填)' :
        resp && resp.ok && resp.text ? '已记 ' + (STATE.notes.length + 1) + ' 条' :
        '识别失败(' + ((resp && (resp.error || resp.httpStatus)) || 'empty') + ')');
      if (resp && resp.ok && resp.text) {
        const txt = resp.text.trim();
        // 模型判断本帧无新信息 → 跳过,不记入笔记(省的是「写入噪音」,请求已发生)
        if (/^跳过[。.!]*$/.test(txt) || txt === '跳过') {
          STATE.status = 'working'; applyLamp();
          setStatus('本帧无新信息,跳过');
          return null;
        }
        return txt;
      }
      return null;
    } catch (e) {
      setStatusState('error', '请求异常(网络?)');
      return null;
    }
  }

  // ---------- 笔记侧栏 ----------
  function ensurePanel() {
    if (STATE.panel && document.contains(STATE.panel)) return STATE.panel;
    const panel = document.createElement('div');
    panel.className = 'ct-vnotes-panel';
    panel.innerHTML =
      '<div class="ct-vnotes-head">' +
      '  <span class="ct-vnotes-lamp" data-role="lamp" data-s="idle" title="状态"></span>' +
      '  <span class="ct-vnotes-title">视频笔记</span>' +
      '  <span class="ct-vnotes-status" data-role="status">待启动</span>' +
      '  <button class="ct-vnotes-btn" data-role="export" title="复制全部笔记">复制</button>' +
      '  <button class="ct-vnotes-btn" data-role="close" title="停止并关闭">×</button>' +
      '</div>' +
      '<div class="ct-vnotes-list" data-role="list"></div>';
    document.documentElement.appendChild(panel);
    STATE.panel = panel;
    STATE.list = panel.querySelector('[data-role="list"]');
    panel.querySelector('[data-role="close"]').addEventListener('click', () => stop());
    panel.querySelector('[data-role="export"]').addEventListener('click', exportNotes);
    injectStyle();
    return panel;
  }

  function setStatus(txt) {
    const el = STATE.panel && STATE.panel.querySelector('[data-role="status"]');
    if (el) el.textContent = txt;
  }

  function addNote(t, text) {
    // 解析 LLM 输出的「### 标题」分段(HoverNotes 风格)
    let heading = null, body = text;
    const m = text.match(/^\s*#{1,4}\s*(.+?)\s*\n+([\s\S]*)$/);
    if (m) { heading = m[1].trim(); body = (m[2] || '').trim(); }
    if (!body) body = text.replace(/^\s*#{1,4}\s*.+?\n*/, '').trim() || text;

    STATE.notes.push({ t, text, heading });
    STATE._recent.push(body);
    if (STATE._recent.length > 6) STATE._recent.shift();

    if (heading) {
      const h = document.createElement('div');
      h.className = 'ct-vnotes-heading';
      h.textContent = heading;
      STATE.list.appendChild(h);
    }
    const item = document.createElement('div');
    item.className = 'ct-vnotes-item';
    const ts = document.createElement('button');
    ts.className = 'ct-vnotes-ts';
    ts.textContent = fmtTime(t);
    ts.title = '跳转到 ' + fmtTime(t);
    ts.addEventListener('click', () => {
      if (STATE.video) { STATE.video.currentTime = t; STATE.video.play && STATE.video.play().catch(()=>{}); }
    });
    const bodyEl = document.createElement('div');
    bodyEl.className = 'ct-vnotes-text';
    // 简易渲染:**bold** → <b>,换行保留
    bodyEl.innerHTML = escapeHtml(body)
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/\n+/g, '<br>');
    item.appendChild(ts);
    item.appendChild(bodyEl);
    STATE.list.appendChild(item);
    STATE.list.scrollTop = STATE.list.scrollHeight;
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function exportNotes() {
    const md = STATE.notes.map((n) => `- [${fmtTime(n.t)}] ${n.text}`).join('\n');
    const out = '# 视频笔记\n\n' + md + '\n';
    try {
      navigator.clipboard.writeText(out).then(() => setStatus('已复制 ' + STATE.notes.length + ' 条'));
    } catch (e) {
      setStatus('复制失败');
    }
  }

  function injectStyle() {
    if (document.getElementById('ct-vnotes-style')) return;
    const st = document.createElement('style');
    st.id = 'ct-vnotes-style';
    st.textContent = `
.ct-vnotes-panel{position:fixed;top:12px;right:12px;width:320px;max-height:80vh;z-index:2147483646;
  background:rgba(15,26,36,.96);color:#f2ede2;border:1px solid rgba(242,237,226,.14);border-radius:12px;
  display:flex;flex-direction:column;font:13px/1.5 -apple-system,"Segoe UI",sans-serif;
  box-shadow:0 8px 30px rgba(0,0,0,.4);overflow:hidden}
.ct-vnotes-head{display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid rgba(242,237,226,.12)}
.ct-vnotes-title{font-weight:600;color:#e0a866;flex:0 0 auto}
.ct-vnotes-status{flex:1;font-size:11px;color:#9aa3b2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* 交通灯:idle灰 / starting黄(脉动) / working绿 / error红 */
.ct-vnotes-lamp{flex:0 0 auto;width:11px;height:11px;border-radius:50%;background:#5a636f;
  box-shadow:0 0 0 2px rgba(255,255,255,.06);transition:background .2s}
.ct-vnotes-lamp[data-s="starting"]{background:#e8b23c;animation:ct-lamp-pulse 1s ease-in-out infinite}
.ct-vnotes-lamp[data-s="working"]{background:#3fbf7f;box-shadow:0 0 6px rgba(63,191,127,.7)}
.ct-vnotes-lamp[data-s="error"]{background:#e05252;box-shadow:0 0 6px rgba(224,82,82,.6)}
@keyframes ct-lamp-pulse{0%,100%{opacity:1}50%{opacity:.35}}
.ct-vnotes-heading{padding:8px 12px 2px;color:#e0a866;font-weight:700;font-size:12.5px;
  border-top:1px solid rgba(224,168,102,.18);margin-top:4px}
.ct-vnotes-btn{background:rgba(47,143,131,.2);color:#4fb3a4;border:1px solid rgba(79,179,164,.35);
  border-radius:6px;padding:2px 8px;cursor:pointer;font-size:12px}
.ct-vnotes-btn:hover{background:rgba(47,143,131,.4)}
.ct-vnotes-list{flex:1;overflow-y:auto;padding:6px 0}
.ct-vnotes-item{display:flex;gap:8px;padding:6px 12px;border-bottom:1px solid rgba(242,237,226,.06)}
.ct-vnotes-ts{flex:0 0 auto;align-self:flex-start;background:rgba(201,138,75,.18);color:#e0a866;
  border:1px solid rgba(224,168,102,.35);border-radius:6px;padding:1px 6px;cursor:pointer;
  font:11px ui-monospace,monospace;margin-top:1px}
.ct-vnotes-ts:hover{background:rgba(201,138,75,.4)}
.ct-vnotes-text{flex:1;color:#f2ede2;word-break:break-word}
`;
    document.documentElement.appendChild(st);
  }

  // ---------- 抽帧主循环 ----------
  async function tick() {
    if (!STATE.running || STATE.busy) return;
    const video = STATE.video;
    if (!video || video.paused || video.ended) { setStatus('已暂停(播放视频继续记)'); return; }
    STATE.busy = true;
    try {
      // 内容感知去重:画面没实质变化(静止/同一主题延续)就跳过,不发请求省 token。
      // 真实视频里大量时间画面静止,这一步挡掉绝大多数重复请求;模型把时间花在真正的新内容上。
      if (!contentChanged(video)) {
        STATE.status = 'working'; applyLamp(); // 仍在工作,只是本帧无需记
        setStatus('画面未变,跳过(已省 ' + STATE._skipCount + ' 次)');
        return;
      }
      const t = video.currentTime;
      const frame = captureFrame(video);
      if (!frame) { setStatusState('error', '帧不可读(可能跨域媒体)'); return; }
      STATE._lastFrameData = frame;
      const text = await analyzeFrame(frame, t);
      if (text) { addNote(t, text); }
    } finally {
      STATE.busy = false;
    }
  }

  // ---------- 启动/停止 ----------
  async function start({ intervalMs = 8000, maxW = 512 } = {}) {
    const video = findPrimaryVideo();
    if (!video) { setStatusState('error', '没找到视频'); return { ok: false, reason: 'no_video' }; }
    STATE.video = video;
    STATE.intervalMs = Math.max(3000, intervalMs | 0);
    STATE.maxW = Math.max(256, maxW | 0);
    ensurePanel();
    if (STATE.running) return { ok: true, already: true };
    STATE.running = true;
    setStatusState('starting', '启动中…(每 ' + Math.round(STATE.intervalMs / 1000) + 's 抽一帧)');
    // 立即记一条,再进入定时间隔
    tick();
    STATE.timer = setInterval(tick, STATE.intervalMs);
    return { ok: true };
  }

  function stop() {
    STATE.running = false;
    if (STATE.timer) { clearInterval(STATE.timer); STATE.timer = null; }
    setStatusState('idle', '已停止');
    if (STATE.panel && STATE.panel.parentNode) STATE.panel.parentNode.removeChild(STATE.panel);
    STATE.panel = null;
    STATE.list = null;
  }

  self.CT_VNOTES = {
    start,
    stop,
    captureFrame,
    onStatus,
    buildNotePrompt,   // 导出供测试
    _state: STATE, // 调试用
  };
})();
