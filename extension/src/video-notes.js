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
    notes: [],            // [{t, text}] 已生成笔记
    minIntervalBetweenNotes: 8000,
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

  // ---------- 笔记提示词(与纯翻译分离:这是 HoverNotes 缺的另一半) ----------
  function buildNotePrompt(dstLang) {
    const lang = dstLang || '中文';
    return {
      system: '你是视频笔记助手。看懂视频帧画面,提炼这一时刻的要点,用目标语言写一条简洁笔记。' +
              '只输出笔记正文,不要解释、不要前后缀、不要时间戳、不要复述"这是一帧"。' +
              '若画面有外语文字/板书/字幕,顺手译成目标语言并融入要点。',
      user: `请基于这一帧写一条笔记(目标语言:${lang})。要求:一句话到两句话,抓住此刻信息要点。`,
    };
  }

  // ---------- 调多模态(经 background 的 vision-note,走用户已配置的 OpenAI 兼容端点) ----------
  async function analyzeFrame(dataUrl, t) {
    const dstLang = (self.CT_LANGS && self.CT_LANGS.guessTargetLang && self.CT_LANGS.guessTargetLang()) || 'zh';
    const { system, user } = buildNotePrompt(dstLang === 'zh' ? '中文' : dstLang);
    try {
      const resp = await chrome.runtime.sendMessage({
        type: 'vision-note',
        base64: dataUrl,
        system, user,
        maxTokens: 700,
      });
      if (resp && resp.ok && resp.text) return resp.text.trim();
      return null;
    } catch (e) {
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
      '  <span class="ct-vnotes-title">视频笔记</span>' +
      '  <span class="ct-vnotes-status" data-role="status">抽帧中…</span>' +
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
    STATE.notes.push({ t, text });
    const item = document.createElement('div');
    item.className = 'ct-vnotes-item';
    const ts = document.createElement('button');
    ts.className = 'ct-vnotes-ts';
    ts.textContent = fmtTime(t);
    ts.title = '跳转到 ' + fmtTime(t);
    ts.addEventListener('click', () => {
      if (STATE.video) { STATE.video.currentTime = t; STATE.video.play && STATE.video.play().catch(()=>{}); }
    });
    const body = document.createElement('div');
    body.className = 'ct-vnotes-text';
    body.textContent = text;
    item.appendChild(ts);
    item.appendChild(body);
    STATE.list.appendChild(item);
    STATE.list.scrollTop = STATE.list.scrollHeight;
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
      const t = video.currentTime;
      const frame = captureFrame(video);
      if (!frame) { setStatus('帧不可读(可能跨域媒体)'); return; }
      setStatus('识别 ' + fmtTime(t) + ' …');
      const text = await analyzeFrame(frame, t);
      if (text) { addNote(t, text); setStatus('已记 ' + STATE.notes.length + ' 条'); }
      else setStatus('本条无结果(继续)');
    } finally {
      STATE.busy = false;
    }
  }

  // ---------- 启动/停止 ----------
  async function start({ intervalMs = 8000, maxW = 512 } = {}) {
    const video = findPrimaryVideo();
    if (!video) return { ok: false, reason: 'no_video' };
    STATE.video = video;
    STATE.intervalMs = Math.max(3000, intervalMs | 0);
    STATE.maxW = Math.max(256, maxW | 0);
    ensurePanel();
    if (STATE.running) return { ok: true, already: true };
    STATE.running = true;
    setStatus('抽帧中…(每 ' + Math.round(STATE.intervalMs / 1000) + 's)');
    // 立即记一条,再进入定时间隔
    tick();
    STATE.timer = setInterval(tick, STATE.intervalMs);
    return { ok: true };
  }

  function stop() {
    STATE.running = false;
    if (STATE.timer) { clearInterval(STATE.timer); STATE.timer = null; }
    if (STATE.panel && STATE.panel.parentNode) STATE.panel.parentNode.removeChild(STATE.panel);
    STATE.panel = null;
    STATE.list = null;
  }

  self.CT_VNOTES = {
    start,
    stop,
    captureFrame,
    _state: STATE, // 调试用
  };
})();
