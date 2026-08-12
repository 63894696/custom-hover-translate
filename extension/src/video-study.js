// video-study.js — 「视频学习」统一入口(content script,自包含 IIFE,挂 self.CT_VSTUDY)
//
// 设计(2026-08-12):把【字幕轨 CT_SUBTITLES】+【帧笔记 CT_VNOTES】合成一键双模。
// 交互逻辑复用 HoverNotes 的用户习惯(见其官网教程):
//   · 悬停视频 → 视频角落浮出「视频学习」按钮(HoverNotes 同款触发方式);
//   · 点击 → 视频旁开笔记面板,同时启动双模(字幕 overlay + 帧笔记);
//   · 面板内可单独开关 字幕/AI笔记、手动截图、导出 Markdown。
// 我们的差异点:HoverNotes 笔记模式看不到字幕;我们双模并行,笔记+双语字幕同屏。
// 隐私:帧图仅经用户配置端点,笔记仅存页面/本地下载,不上传。

(function () {
  const STATE = {
    btn: null,            // 视频角落悬浮按钮
    video: null,          // 目标 <video>
    active: false,        // 双模是否已启动
    _mo: null,            // MutationObserver
    _hoverBound: false,
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
  function hasSubs() { return typeof self.CT_SUBTITLES !== 'undefined'; }
  function hasNotes() { return typeof self.CT_VNOTES !== 'undefined'; }

  // ---------- 视频角落悬浮按钮(HoverNotes 触发逻辑) ----------
  function ensureButton(video) {
    if (STATE.btn && document.contains(STATE.btn)) { positionButton(video); return STATE.btn; }
    removeButton();
    const btn = document.createElement('button');
    btn.className = 'ct-vstudy-fab';
    btn.innerHTML = '<span class="ct-vstudy-lamp" data-role="lamp" data-s="idle"></span><span class="ct-vstudy-fab-ico">✎</span><span>视频学习</span>';
    btn.title = '双语字幕 + AI 视频笔记(一键开启)';
    btn.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
    document.documentElement.appendChild(btn);
    STATE.btn = btn;
    positionButton(video);
    btn.addEventListener('mouseenter', () => btn.classList.add('ct-vstudy-fab-show'));
    btn.addEventListener('mouseleave', () => { if (!STATE.active) btn.classList.remove('ct-vstudy-fab-show'); });
    // 订阅帧笔记状态 → 悬浮按钮交通灯(黄=启动/请求,绿=工作,红=出错)
    if (hasNotes() && typeof self.CT_VNOTES.onStatus === 'function' && !STATE._lampBound) {
      STATE._lampBound = true;
      self.CT_VNOTES.onStatus(setFabLamp);
    }
    injectStyle();
    return btn;
  }

  function setFabLamp(s) {
    const lamp = STATE.btn && STATE.btn.querySelector('[data-role="lamp"]');
    if (lamp) lamp.setAttribute('data-s', s);
  }

  function positionButton(video) {
    if (!STATE.btn || !video) return;
    const r = video.getBoundingClientRect();
    const top = Math.max(8, r.top + window.scrollY + 12);
    const left = Math.max(8, r.right + window.scrollX - 132);
    STATE.btn.style.top = top + 'px';
    STATE.btn.style.left = left + 'px';
  }

  function removeButton() {
    if (STATE.btn && STATE.btn.parentNode) STATE.btn.parentNode.removeChild(STATE.btn);
    STATE.btn = null;
  }

  // 悬停视频显示按钮(HoverNotes 的「hover 视频 → 出现按钮」习惯)
  function bindHover(video) {
    if (STATE._hoverBound) return;
    STATE._hoverBound = true;
    document.addEventListener('mousemove', (e) => {
      const v = STATE.video;
      if (!v || !document.contains(v)) { removeButton(); return; }
      const r = v.getBoundingClientRect();
      const over = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      if (over) {
        ensureButton(v);
        STATE.btn.classList.add('ct-vstudy-fab-show');
        positionButton(v);
      } else if (STATE.btn && !STATE.active) {
        // 移出视频且未激活 → 隐藏(按钮自身悬停除外)
        const br = STATE.btn.getBoundingClientRect();
        const overBtn = e.clientX >= br.left && e.clientX <= br.right && e.clientY >= br.top && e.clientY <= br.bottom;
        if (!overBtn) STATE.btn.classList.remove('ct-vstudy-fab-show');
      }
    }, { passive: true });
    window.addEventListener('scroll', () => { if (STATE.video) positionButton(STATE.video); }, { passive: true });
    window.addEventListener('resize', () => { if (STATE.video) positionButton(STATE.video); }, { passive: true });
  }

  // ---------- 一键双模启动/停止 ----------
  async function startDual() {
    const video = findPrimaryVideo();
    if (!video) return { ok: false, reason: 'no_video' };
    STATE.video = video;
    let subs = null, notes = null;
    if (hasSubs()) {
      try { subs = await self.CT_SUBTITLES.start({ mode: 'bilingual' }); } catch (e) { subs = { ok: false, error: String(e) }; }
    }
    if (hasNotes()) {
      try { notes = await self.CT_VNOTES.start({ intervalMs: 8000, maxW: 512 }); } catch (e) { notes = { ok: false, error: String(e) }; }
    }
    STATE.active = true;
    if (STATE.btn) STATE.btn.classList.add('ct-vstudy-fab-show', 'ct-vstudy-fab-on');
    enhanceNotesPanel();   // 在笔记面板里加 字幕开关/截图/导出 控制
    return { ok: true, subs: subs, notes: notes };
  }

  function stopDual() {
    if (hasSubs()) { try { self.CT_SUBTITLES.stop(); } catch (e) {} }
    if (hasNotes()) { try { self.CT_VNOTES.stop(); } catch (e) {} }
    STATE.active = false;
    if (STATE.btn) STATE.btn.classList.remove('ct-vstudy-fab-on');
  }

  async function toggle() {
    if (STATE.active) { stopDual(); return { ok: true, stopped: true }; }
    return await startDual();
  }

  // ---------- 增强笔记面板:加 字幕开关 / 截图 / 导出 Markdown ----------
  function enhanceNotesPanel() {
    // 等 CT_VNOTES 面板出现
    const tryAdd = () => {
      const panel = document.querySelector('.ct-vnotes-panel');
      if (!panel) return false;
      const head = panel.querySelector('.ct-vnotes-head');
      if (!head || head.querySelector('[data-role="vstudy-ctl"]')) return true;
      const bar = document.createElement('div');
      bar.setAttribute('data-role', 'vstudy-ctl');
      bar.className = 'ct-vstudy-ctlbar';
      bar.innerHTML =
        '<button class="ct-vstudy-btn" data-role="tg-subs" title="开/关双语字幕">字幕:开</button>' +
        '<button class="ct-vstudy-btn" data-role="shot" title="截取当前帧进笔记">📷 截图</button>' +
        '<button class="ct-vstudy-btn" data-role="md" title="下载 Markdown 笔记">⬇ MD</button>';
      head.parentNode.insertBefore(bar, head.nextSibling);

      bar.querySelector('[data-role="tg-subs"]').addEventListener('click', function () {
        if (!hasSubs()) return;
        const on = this.dataset.on !== '0';
        if (on) { try { self.CT_SUBTITLES.stop(); } catch (e) {} this.dataset.on = '0'; this.textContent = '字幕:关'; }
        else { try { self.CT_SUBTITLES.start({ mode: 'bilingual' }); } catch (e) {} this.dataset.on = '1'; this.textContent = '字幕:开'; }
      });
      bar.querySelector('[data-role="shot"]').addEventListener('click', () => manualShot());
      bar.querySelector('[data-role="md"]').addEventListener('click', () => downloadMarkdown());
      return true;
    };
    let tries = 0;
    const iv = setInterval(() => { if (tryAdd() || ++tries > 20) clearInterval(iv); }, 250);
  }

  // 手动截图:抽当前帧,加一条「截图」笔记(带时间戳 + 缩略图)
  function manualShot() {
    if (!hasNotes()) return;
    const S = self.CT_VNOTES._state;
    const v = S && S.video;
    if (!v) return;
    const dataUrl = self.CT_VNOTES.captureFrame(v);
    if (!dataUrl) { setCtlStatus('帧不可读(跨域?)'); return; }
    const t = v.currentTime;
    // 直接在面板加一条带缩略图的截图笔记
    const list = document.querySelector('.ct-vnotes-list');
    if (list) {
      const item = document.createElement('div');
      item.className = 'ct-vnotes-item ct-vnotes-shot';
      const ts = document.createElement('button');
      ts.className = 'ct-vnotes-ts';
      ts.textContent = fmt(t);
      ts.addEventListener('click', () => { v.currentTime = t; v.play && v.play().catch(()=>{}); });
      const img = document.createElement('img');
      img.src = dataUrl; img.className = 'ct-vnotes-thumb';
      item.appendChild(ts); item.appendChild(img);
      list.appendChild(item); list.scrollTop = list.scrollHeight;
      // 记入 notes 供导出
      S.notes.push({ t, text: '[截图]', shot: dataUrl });
    }
  }

  function fmt(sec) {
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    const mm = String(m).padStart(2, '0'), ss = String(s).padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }

  // ---------- 导出 Markdown 文件(下载) ----------
  function buildMarkdown() {
    const S = hasNotes() ? self.CT_VNOTES._state : null;
    const notes = (S && S.notes) || [];
    const title = document.title || '视频笔记';
    const url = location.href;
    const date = new Date().toISOString().slice(0, 19).replace('T', ' ');
    let md = `---\ntitle: "${title.replace(/"/g, '\\"')}"\nsource: ${url}\ncreated: "${date.slice(0, 10)}"\ntags:\n  - hover-notes\n---\n\n`;
    md += `# ${title}\n\n- 来源: ${url}\n- 导出时间: ${date}\n- 笔记条数: ${notes.length}\n\n`;
    for (const n of notes) {
      // 结构化:有分段标题先出标题,再出带时间戳的要点(HoverNotes 风格)
      if (n.heading) md += `\n### ${n.heading}\n\n`;
      const link = url + (url.includes('?') ? '&' : '?') + 't=' + Math.floor(n.t) + 's';
      const body = (n.text || '').replace(/^\s*#{1,4}\s*.+?\n+/, ''); // 去掉内联标题,只留正文
      md += `- **[${fmt(n.t)}](${link})** ${body}\n`;
    }
    md += '\n> 由 Prisir 视频学习生成(双语字幕 + AI 帧笔记)\n';
    return md;
  }

  function downloadMarkdown() {
    const md = buildMarkdown();
    const title = (document.title || '视频笔记').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = title + '.md';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 100);
    setCtlStatus('已下载 Markdown');
  }

  function setCtlStatus(txt) {
    const el = document.querySelector('.ct-vnotes-panel [data-role="status"]');
    if (el) el.textContent = txt;
  }

  // ---------- 样式 ----------
  function injectStyle() {
    if (document.getElementById('ct-vstudy-style')) return;
    const st = document.createElement('style');
    st.id = 'ct-vstudy-style';
    st.textContent = `
.ct-vstudy-fab{position:absolute;z-index:2147483646;display:flex;align-items:center;gap:6px;
  padding:6px 12px;border-radius:20px;border:1px solid rgba(224,168,102,.5);cursor:pointer;
  background:rgba(15,26,36,.92);color:#e0a866;font:13px/1 -apple-system,"Segoe UI",sans-serif;font-weight:600;
  box-shadow:0 4px 16px rgba(0,0,0,.4);opacity:0;pointer-events:none;transform:translateY(-4px);
  transition:opacity .18s,transform .18s}
.ct-vstudy-fab-show{opacity:1;pointer-events:auto;transform:translateY(0)}
.ct-vstudy-fab-on{background:rgba(47,143,131,.92);border-color:rgba(79,179,164,.6);color:#f2ede2}
.ct-vstudy-fab-ico{font-size:14px}
.ct-vstudy-lamp{flex:0 0 auto;width:8px;height:8px;border-radius:50%;background:#5a636f;transition:background .2s}
.ct-vstudy-lamp[data-s="starting"]{background:#e8b23c;animation:ct-lamp-pulse 1s ease-in-out infinite}
.ct-vstudy-lamp[data-s="working"]{background:#3fbf7f;box-shadow:0 0 5px rgba(63,191,127,.7)}
.ct-vstudy-lamp[data-s="error"]{background:#e05252}
.ct-vstudy-ctlbar{display:flex;gap:6px;padding:8px 12px;border-bottom:1px solid rgba(242,237,226,.12);
  background:rgba(255,255,255,.02)}
.ct-vstudy-btn{flex:1;background:rgba(201,138,75,.16);color:#e0a866;border:1px solid rgba(224,168,102,.35);
  border-radius:6px;padding:4px 6px;cursor:pointer;font-size:12px;white-space:nowrap}
.ct-vstudy-btn:hover{background:rgba(201,138,75,.36)}
.ct-vnotes-thumb{max-width:100%;border-radius:6px;border:1px solid rgba(242,237,226,.15);display:block}
`;
    document.documentElement.appendChild(st);
  }

  // ---------- 自动探测视频 ----------
  function init() {
    const v = findPrimaryVideo();
    if (!v) return false;
    STATE.video = v;
    ensureButton(v);
    bindHover(v);
    return true;
  }
  if (!init()) {
    // 等视频出现(SPA 异步加载)
    STATE._mo = new MutationObserver(() => { if (init() && STATE._mo) { STATE._mo.disconnect(); STATE._mo = null; } });
    STATE._mo.observe(document.documentElement, { childList: true, subtree: true });
  }

  self.CT_VSTUDY = {
    start: startDual,
    stop: stopDual,
    toggle,
    downloadMarkdown,
    _state: STATE,
  };
})();
