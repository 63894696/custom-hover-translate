// subtitles.js — 视频双语字幕模块(content script 上下文,自包含 IIFE,挂 self.CT_SUBTITLES)
//
// 设计(2026-08-12,字幕 1 骨架):
//   1) 复用现有文本翻译内核:字幕轨走 chrome.runtime.sendMessage({type:'translate-batch'}),
//      与整页翻译同一条路径(引擎抽象 / %% 批量 / LRU 缓存 / auto 路由),不另起引擎。
//   2) 两层支持:
//        A) YouTube — 解析 ytInitialPlayerResponse 的 captionTracks,timedtext 拉原字幕轨(最稳)。
//        B) 通用 HTML5 — <video> + <track> TextTrack,cuechange 兜底其它站点。
//   3) 渲染:在 <video> 上叠一层绝对定位 .ct-sub-overlay,跟随播放进度显示当前句,
//      双语(原文上/译文下)或仅译文(按 storage.subtitleMode)。
//   4) 隐私红线:字幕文本仅经用户配置端点/内置引擎,不收集、不上传。
//
// 本骨架(字幕 1)只含:检测 + 通用 TextTrack overlay 挂载(不翻)。
// YouTube 抓取/解析/分句(字幕 2)、引擎接入回填(字幕 3)随后叠加。

(function () {
  const STATE = {
    overlay: null,        // .ct-sub-overlay DOM
    video: null,          // 当前挂载的 <video>
    srcLine: null,        // 原文行
    transLine: null,      // 译文行
    cues: [],             // [{start, end, text, trans?}]
    mode: 'bilingual',    // 'bilingual' | 'replace'
    enabled: false,
    bound: false,         // 是否已绑定 timeupdate/cuechange
    track: null,          // 通用 TextTrack 兜底
  };

  // ---------- 检测:当前页是否有可用视频字幕 ----------
  function detectVideoSupport() {
    if (isYouTubeWatch()) return { kind: 'youtube' };
    const v = findPrimaryVideo();
    if (v) return { kind: 'html5', video: v };
    return { kind: 'none' };
  }

  function isYouTubeWatch() {
    return /(^|\.)youtube\.com$/.test(location.hostname) && location.pathname.startsWith('/watch');
  }

  // 找页面主 <video>(取视口内最大可见的,否则第一个)
  function findPrimaryVideo() {
    const vids = [...document.querySelectorAll('video')].filter((v) => !v.paused || v.readyState > 0 || v.currentTime > 0);
    const all = vids.length ? vids : [...document.querySelectorAll('video')];
    if (!all.length) return null;
    let best = null, bestArea = 0;
    for (const v of all) {
      const r = v.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > bestArea) { bestArea = area; best = v; }
    }
    return best;
  }

  // ---------- overlay 挂载 ----------
  // 在 <video> 的容器上叠一层字幕。YouTube 用 .html5-video-container,通用用 video.parentElement。
  function ensureOverlay(video) {
    if (STATE.overlay && STATE.video === video && document.contains(STATE.overlay)) return STATE.overlay;
    destroyOverlay();

    const host = pickOverlayHost(video);
    if (!host) return null;
    const cs = getComputedStyle(host);
    if (cs.position === 'static') host.style.position = 'relative';

    const overlay = document.createElement('div');
    overlay.className = 'ct-sub-overlay';
    const src = document.createElement('div');
    src.className = 'ct-sub-line ct-sub-src';
    const trans = document.createElement('div');
    trans.className = 'ct-sub-line ct-sub-trans';
    overlay.appendChild(src);
    overlay.appendChild(trans);
    host.appendChild(overlay);

    STATE.overlay = overlay;
    STATE.video = video;
    STATE.srcLine = src;
    STATE.transLine = trans;
    return overlay;
  }

  function pickOverlayHost(video) {
    // YouTube:挂在 .html5-video-container(包含 video + 原生控制条之间)
    const ytc = video.closest && video.closest('.html5-video-container');
    if (ytc) return ytc;
    // 通用:挂 video 的父级
    return video.parentElement || null;
  }

  function destroyOverlay() {
    if (STATE.overlay && STATE.overlay.parentNode) STATE.overlay.parentNode.removeChild(STATE.overlay);
    STATE.overlay = null;
    STATE.video = null;
    STATE.srcLine = null;
    STATE.transLine = null;
    STATE.cues = [];
    STATE.bound = false;
    STATE.track = null;
  }

  // ---------- 通用 TextTrack 兜底(字幕 1 骨架:只显示原文,不翻) ----------
  // 找一个可用 <track>(subtitles/captions,有 src 且 mode 非 disabled);把 mode 设为 hidden
  // 让浏览器解析但不出原生字幕,改用我们的 overlay 显示 cuechange 当前句。
  function attachGenericTextTrack(video) {
    const tracks = video.textTracks || [];
    let track = null;
    for (const t of tracks) {
      if ((t.kind === 'subtitles' || t.kind === 'captions') && (t.language || t.label)) { track = t; break; }
    }
    if (!track && tracks.length) track = tracks[0];
    if (!track) return false;
    try { track.mode = 'hidden'; } catch (e) { return false; }
    STATE.track = track;

    const onCue = () => {
      const active = track.activeCues;
      if (!active || !active.length) { setLines('', ''); return; }
      const txt = [...active].map((c) => (c.text || '').replace(/<[^>]+>/g, '').trim()).join(' ');
      // 命中缓存译文则显示,否则先显原文(翻译在后台补)
      const hit = STATE._genericTrans && STATE._genericTrans.get(txt);
      setLines(txt, hit || '');
      // 未译句收集起来,统一走批量翻译回填
      if (txt && !(STATE._genericTrans && STATE._genericTrans.has(txt))) queueGenericTranslate(txt);
    };
    STATE._genericTrans = STATE._genericTrans || new Map();
    STATE._genericQueue = STATE._genericQueue || new Set();
    track.addEventListener('cuechange', onCue);
    STATE.bound = true;
    return true;
  }

  // 通用轨:把出现的新句攒一小批再翻译,回填 _genericTrans。
  let _genericTimer = null;
  function queueGenericTranslate(text) {
    STATE._genericQueue.add(text);
    if (_genericTimer) return;
    _genericTimer = setTimeout(async () => {
      _genericTimer = null;
      const batch = [...STATE._genericQueue];
      STATE._genericQueue.clear();
      if (!batch.length) return;
      try {
        const resp = await chrome.runtime.sendMessage({
          type: 'translate-batch',
          items: batch.map((t, k) => ({ id: String(k), text: t, srcLang: 'auto' })),
          dstLang: (self.CT_LANGS && self.CT_LANGS.guessTargetLang && self.CT_LANGS.guessTargetLang()) || 'zh',
          concurrency: 6,
        });
        if (resp && resp.ok && Array.isArray(resp.results)) {
          resp.results.forEach((r) => {
            if (r && r.ok && r.text) STATE._genericTrans.set(batch[Number(r.id)], r.text);
          });
        }
      } catch (e) {}
    }, 400);
  }

  function setLines(srcText, transText) {
    if (!STATE.overlay) return;
    if (STATE.srcLine) {
      STATE.srcLine.textContent = srcText || '';
      STATE.srcLine.style.display = srcText && STATE.mode === 'bilingual' ? '' : 'none';
    }
    if (STATE.transLine) {
      STATE.transLine.textContent = transText || '';
      STATE.transLine.style.display = transText ? '' : 'none';
    }
    STATE.overlay.style.display = (srcText || transText) ? '' : 'none';
  }

  // ---------- YouTube 字幕轨抓取 + 解析 + 分句(字幕 2) ----------
  // 取 ytInitialPlayerResponse.captions...captionTracks;选轨(优先人工、回落 asr 机翻),
  // baseUrl + &fmt=json3 拉字幕,解析 events/segs 为 cues,并做基础分句合并。
  function getPlayerResponse() {
    try {
      if (window.ytInitialPlayerResponse) return window.ytInitialPlayerResponse;
    } catch (e) {}
    // 兜底:从 <script> 文本里抠(部分页面不挂 window 全局)
    try {
      for (const s of document.scripts) {
        const t = s.textContent || '';
        const m = t.match(/ytInitialPlayerResponse\s*=\s*({.+?})\s*;/);
        if (m) return JSON.parse(m[1]);
      }
    } catch (e) {}
    return null;
  }

  function listCaptionTracks() {
    const pr = getPlayerResponse();
    const tracks = pr && pr.captions && pr.captions.playerCaptionsTracklistRenderer
      && pr.captions.playerCaptionsTracklistRenderer.captionTracks;
    return Array.isArray(tracks) ? tracks : [];
  }

  // 选轨:优先人工字幕(kind 非 asr),语言偏好 dstLang>en>任一;回落机翻 asr。
  function pickCaptionTrack(preferManual) {
    const tracks = listCaptionTracks();
    if (!tracks.length) return null;
    const manual = tracks.filter((t) => t.kind !== 'asr');
    const asr = tracks.filter((t) => t.kind === 'asr');
    const dst = (self.CT_LANGS && self.CT_LANGS.guessTargetLang && self.CT_LANGS.guessTargetLang()) || 'zh';
    const pref = (arr) =>
      arr.find((t) => t.languageCode === dst) ||
      arr.find((t) => t.languageCode && t.languageCode.startsWith('en')) ||
      arr[0];
    if (preferManual !== false && manual.length) return pref(manual);
    return pref(manual) || pref(asr) || null;
  }

  // 解析 json3:events[].segs[].utf8 拼成句,tStartMs/dDurationMs 计时。
  function parseJson3(json) {
    const cues = [];
    const events = json && json.events;
    if (!Array.isArray(events)) return cues;
    for (const ev of events) {
      if (!ev || !Array.isArray(ev.segs)) continue;
      const text = ev.segs.map((s) => (s && s.utf8) || '').join('').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const start = (ev.tStartMs || 0) / 1000;
      const dur = (ev.dDurationMs || 0) / 1000;
      cues.push({ start, end: start + (dur || 2), text });
    }
    return cues;
  }

  // 基础分句优化:把 asr 碎句按标点/时长合并成更自然的句子(对齐沉浸式「分句基础优化」)。
  // 规则:相邻 cue 若前句不以终止标点结尾、间隔 <0.6s、合并后总长 ≤80 字,则并入当前句;
  // 否则结束当前句起新句。终止标点(. ! ? 。 ! ? …)即自然句尾,到此为止不再往后并。
  function optimizeSentences(cues) {
    if (!cues.length) return cues;
    const out = [];
    let cur = null;
    const terminal = /[.!?。!?…]["')\]]?$/;
    for (const c of cues) {
      if (!cur) { cur = { ...c }; continue; }
      const gap = c.start - cur.end;
      const noTerminal = !terminal.test(cur.text);
      const merged = (cur.text + ' ' + c.text).replace(/\s+/g, ' ').trim();
      if (noTerminal && gap >= 0 && gap < 0.6 && merged.length <= 80) {
        cur.text = merged;
        cur.end = c.end;
      } else {
        out.push(cur);
        cur = { ...c };
      }
    }
    if (cur) out.push(cur);
    return out;
  }

  // 拉字幕轨。YouTube timedtext 需 pot/cookie 授权,内容脚本直 fetch 常返 200 但空体,
  // 故优先走 background 代取(扩展进程特权,带完整 cookie);失败再退直 fetch 兜底。
  async function fetchCaptionCues(track) {
    const url = (track.baseUrl || '').replace(/&fmt=[^&]+/, '') + '&fmt=json3';
    // 首选:background 代取
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'fetch-text', url });
      if (resp && resp.ok && resp.text) {
        const cues = parseJson3(JSON.parse(resp.text));
        if (cues.length) return cues;
      }
    } catch (e) {}
    // 兜底:直 fetch(部分网络/旧接口可能不需要 pot)
    try {
      const r = await fetch(url, { credentials: 'include' });
      if (r.ok) {
        const cues = parseJson3(await r.json());
        if (cues.length) return cues;
      }
    } catch (e) {}
    return [];
  }

  // 字幕 3:抓完立即请求整轨翻译(接引擎),逐条回填 trans,显示由 timeupdate 拾取。
  async function translateTrack(cues) {
    if (!Array.isArray(cues) || !cues.length) return;
    // 去重(字幕常有重复行),减少请求量
    const uniq = [...new Set(cues.map((c) => c.text))];
    const byText = new Map();
    cues.forEach((c) => {
      if (!byText.has(c.text)) byText.set(c.text, []);
      byText.get(c.text).push(c);
    });
    const CHUNK = 40; // 每批 40 条,平衡请求数与 %% 批量收益
    for (let i = 0; i < uniq.length; i += CHUNK) {
      const slice = uniq.slice(i, i + CHUNK);
      const items = slice.map((t, k) => ({ id: String(k), text: t, srcLang: STATE.srcLang || 'auto' }));
      let resp = null;
      try {
        resp = await chrome.runtime.sendMessage({
          type: 'translate-batch',
          items,
          dstLang: (self.CT_LANGS && self.CT_LANGS.guessTargetLang && self.CT_LANGS.guessTargetLang()) || 'zh',
          concurrency: 6,
        });
      } catch (e) { continue; }
      if (!resp || !resp.ok || !Array.isArray(resp.results)) continue;
      resp.results.forEach((r) => {
        const srcText = slice[Number(r.id)];
        if (r && r.ok && r.text) {
          for (const cue of byText.get(srcText) || []) cue.trans = r.text;
        }
      });
      // 每批完成即让正在显示的那句尽快有译文(无需整轨翻完)
    }
  }
  STATE.onTrackReady = (cues) => { translateTrack(cues).catch(() => {}); };

  // YouTube 主流程:选轨 → 拉 cues → 分句 → 存 STATE → 绑 timeupdate 显示。
  async function attachYouTube(video, { preferManual = true } = {}) {
    const track = pickCaptionTrack(preferManual);
    if (!track) return false;
    let cues = await fetchCaptionCues(track);
    if (!cues.length) return false;
    cues = optimizeSentences(cues);
    STATE.cues = cues;
    STATE.srcLang = track.languageCode || '';

    const onTime = () => {
      const t = video.currentTime;
      // 二分找当前 cue
      let lo = 0, hi = cues.length - 1, found = null;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const c = cues[mid];
        if (t < c.start) hi = mid - 1;
        else if (t > c.end) lo = mid + 1;
        else { found = c; break; }
      }
      if (found) setLines(found.text, found.trans || '');
      else setLines('', '');
    };
    video.addEventListener('timeupdate', onTime);
    STATE._ytTimeHandler = onTime;
    STATE.bound = true;
    if (typeof STATE.onTrackReady === 'function') STATE.onTrackReady(cues);
    return true;
  }

  // ---------- 启动/停止 ----------
  async function start({ mode = 'bilingual', preferManual = true } = {}) {
    const sup = detectVideoSupport();
    if (sup.kind === 'none') return { ok: false, reason: 'no_video' };
    STATE.mode = mode === 'replace' ? 'replace' : 'bilingual';
    STATE.preferManual = preferManual !== false;
    STATE.enabled = true;
    const video = sup.kind === 'youtube' ? findPrimaryVideo() : sup.video;
    if (!video) return { ok: false, reason: 'no_video' };
    ensureOverlay(video);
    if (sup.kind === 'youtube') {
      await attachYouTube(video, { preferManual: STATE.preferManual });
    } else {
      attachGenericTextTrack(video);
    }
    return { ok: true, kind: sup.kind };
  }

  function stop() {
    STATE.enabled = false;
    if (STATE.track) { try { STATE.track.mode = 'disabled'; } catch (e) {} }
    if (STATE.video && STATE._ytTimeHandler) {
      try { STATE.video.removeEventListener('timeupdate', STATE._ytTimeHandler); } catch (e) {}
      STATE._ytTimeHandler = null;
    }
    destroyOverlay();
  }

  function setMode(mode) {
    STATE.mode = mode === 'replace' ? 'replace' : 'bilingual';
    // 立即按新模式重排当前行(原文行显隐)
    if (STATE.srcLine) STATE.srcLine.style.display = STATE.srcLine.textContent && STATE.mode === 'bilingual' ? '' : 'none';
  }

  self.CT_SUBTITLES = {
    detectVideoSupport,
    isYouTubeWatch,
    start,
    stop,
    setMode,
    listCaptionTracks,
    pickCaptionTrack,
    parseJson3,
    optimizeSentences,
    fetchCaptionCues,
    _state: STATE, // 调试用
  };
})();
