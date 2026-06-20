// Service Worker:转发 content script 的 translate / health 请求到本机后端。
// 端点从 chrome.storage.local 读(用户在 options 里改过的话),默认 127.0.0.1:12308。
// 单例 in-flight:同 key 并发只发一次后端请求。

const DEFAULT_ENDPOINT = 'http://127.0.0.1:12308';
const TIMEOUT_MS = 15000;

const inflight = new Map(); // key -> Promise

async function getEndpoint() {
  const { endpoint } = await chrome.storage.local.get('endpoint');
  return endpoint || DEFAULT_ENDPOINT;
}

async function readOptions() {
  return await chrome.storage.local.get([
    'endpoint',
    'dstLang',
    'provider',
    'model',
    'showOriginal',
  ]);
}

async function postJSON(url, body, signal) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  let data = null;
  try {
    data = await r.json();
  } catch {
    /* ignore */
  }
  return { ok: r.ok, status: r.status, data };
}

async function getJSON(url, signal) {
  const r = await fetch(url, { signal });
  let data = null;
  try {
    data = await r.json();
  } catch {
    /* ignore */
  }
  return { ok: r.ok, status: r.status, data };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return false;

  if (msg.type === 'translate') {
    handleTranslate(msg)
      .then((resp) => sendResponse(resp))
      .catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true;
  }

  if (msg.type === 'translate-batch') {
    handleTranslateBatch(msg)
      .then((resp) => sendResponse(resp))
      .catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true;
  }

  if (msg.type === 'fallback-next' || msg.type === 'fallback-previous' || msg.type === 'fallback-toggle' || msg.type === 'fallback-set') {
    handleFallbackControl(msg)
      .then((resp) => sendResponse(resp))
      .catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true;
  }

  if (msg.type === 'health') {
    handleHealth()
      .then((resp) => sendResponse(resp))
      .catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true;
  }

  return false;
});

async function handleTranslate({ key, text, srcLang = '', dstLang = '' }) {
  if (inflight.has(key)) {
    return inflight.get(key);
  }

  const p = (async () => {
    const opt = await readOptions();
    const endpoint = opt.endpoint || DEFAULT_ENDPOINT;
    const finalDst = dstLang || opt.dstLang || 'zh';
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

    try {
      const body = {
        text,
        srcLang,
        dstLang: finalDst,
        provider: opt.provider || '',
        model: opt.model || '',
      };
      const r = await postJSON(`${endpoint}/translate`, body, ctrl.signal);
      clearTimeout(timer);
      if (!r.ok || !r.data) {
        return {
          ok: false,
          key,
          error: (r.data && r.data.error) || `HTTP ${r.status}`,
          durationMs: 0,
        };
      }
      return {
        ok: !!r.data.ok,
        key,
        text: r.data.text || '',
        error: r.data.error || null,
        provider: r.data.provider,
        model: r.data.model,
        durationMs: r.data.durationMs || 0,
        mock: !!r.data.mock,
      };
    } catch (e) {
      clearTimeout(timer);
      const err =
        e && e.name === 'AbortError'
          ? 'timeout'
          : e && /Failed to fetch|NetworkError|fetch failed/i.test(String(e.message))
          ? 'network'
          : String((e && e.message) || e);
      return { ok: false, key, error: err, durationMs: 0 };
    }
  })();

  inflight.set(key, p);
  try {
    return await p;
  } finally {
    inflight.delete(key);
  }
}

async function handleHealth() {
  try {
    const endpoint = await getEndpoint();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const r = await getJSON(`${endpoint}/health`, ctrl.signal);
    clearTimeout(timer);
    return { ok: r.ok && r.data && r.data.ok === true, data: r.data };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// 处理 popup 发来的 fallback 控制消息
async function handleFallbackControl(msg) {
  const endpoint = await getEndpoint();
  const action = msg.type === 'fallback-next' ? 'next'
                : msg.type === 'fallback-previous' ? 'previous'
                : msg.type === 'fallback-toggle' ? 'toggle'
                : 'set';
  const body = { action };
  if (action === 'set') {
    body.provider = msg.provider;
  }
  // fallback-toggle:根据当前 enabled 状态翻转
  if (action === 'toggle') {
    try {
      const h = await getJSON(`${endpoint}/health`);
      body.action = h.data && h.data.fallbackEnabled ? 'disable' : 'enable';
    } catch {
      body.action = 'enable';
    }
  }
  try {
    const r = await postJSON(`${endpoint}/select-provider`, body, null);
    return r.data || r;
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

async function handleTranslateBatch({ items = [], dstLang = '', concurrency = 6 }) {
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, error: 'items 必须是非空数组' };
  }
  try {
    const endpoint = await getEndpoint();
    const opt = await readOptions();
    const ctrl = new AbortController();
    // 批量允许更长超时:基础 30s + 每项 1.5s,封顶 180s
    const totalTimeoutMs = Math.min(180000, 30000 + items.length * 1500);
    const timer = setTimeout(() => ctrl.abort(), totalTimeoutMs);
    const body = {
      items,
      dstLang: dstLang || opt.dstLang || 'zh',
      concurrency: Math.max(1, Math.min(20, Number(concurrency) || 6)),
    };
    const r = await postJSON(`${endpoint}/translate/batch`, body, ctrl.signal);
    clearTimeout(timer);
    if (!r.ok || !r.data) {
      return {
        ok: false,
        error: (r.data && r.data.error) || `HTTP ${r.status}`,
        status: r.status,
      };
    }
    return r.data;
  } catch (e) {
    const err =
      e && e.name === 'AbortError'
        ? 'timeout'
        : e && /Failed to fetch|NetworkError|fetch failed/i.test(String(e.message))
        ? 'network'
        : String((e && e.message) || e);
    return { ok: false, error: err };
  }
}

// 安装/启动默认值
chrome.runtime.onInstalled.addListener(async () => {
  const cur = await chrome.storage.local.get(['enabled', 'dstLang', 'showOriginal', 'endpoint']);
  const patch = {};
  if (cur.enabled === undefined) patch.enabled = true;
  if (!cur.dstLang) patch.dstLang = 'zh';
  if (cur.showOriginal === undefined) patch.showOriginal = false;
  if (!cur.endpoint) patch.endpoint = DEFAULT_ENDPOINT;
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
});

// SPA 路由变化:pushState/replaceState/hashchange → 重跑当前 activeMode
// webNavigation 权限要加到 manifest
chrome.webNavigation.onHistoryStateUpdated.addListener(async (details) => {
  if (details.frameId !== 0) return; // 只看主 frame
  const { activeMode, enabled } = await chrome.storage.local.get(['activeMode', 'enabled']);
  if (!activeMode || enabled === false) return; // 用户没在 popup 点过任何主按钮 → 不触发
  try {
    await chrome.tabs.sendMessage(details.tabId, { type: 'auto-translate-now' });
  } catch {
    // content script 可能还没初始化(快速 SPA 切换);忽略
  }
});

// 监听 content script 的"立即自动翻译"消息(用于 SPA 路由触发)
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'auto-translate-now-from-bg') {
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

// 右键菜单:把选中文本翻译成目标语言(默认按用户系统语言选)
// 用户选好文本 → 右键 → "Custom Hover Translate → 翻译为 XXX" → content.js 调后端 + 弹通知
function buildContextMenu() {
  chrome.contextMenus.removeAll(() => {
    // 用 navigator.language 推断目标语言(用户在 options 页改的 dstLang 优先)
    chrome.storage.local.get(['dstLang'], (s) => {
      const dstLang = s.dstLang || guessTargetLang();
      const label = `翻译为 ${langDisplayName(dstLang)}`;
      chrome.contextMenus.create({
        id: 'translate-selection',
        title: label,
        contexts: ['selection'],
      });
    });
  });
}

function guessTargetLang() {
  const lang = (navigator.language || 'en').toLowerCase();
  if (lang.startsWith('zh')) return 'zh';
  if (lang.startsWith('ja')) return 'ja';
  if (lang.startsWith('ko')) return 'ko';
  if (lang.startsWith('fr')) return 'fr';
  if (lang.startsWith('de')) return 'de';
  return 'zh'; // 默认中文(本扩展主要面向中文用户)
}

function langDisplayName(code) {
  return {
    zh: '中文', en: 'English', ja: '日文', ko: '韩文',
    fr: '法文', de: '德文', es: '西班牙文',
  }[code] || code;
}

chrome.runtime.onInstalled.addListener(() => buildContextMenu());
chrome.runtime.onStartup.addListener(() => buildContextMenu());
// options 页改 dstLang 后也要重建菜单(label 会变)
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.dstLang) buildContextMenu();
});

// 右键菜单点击 → 让 content.js 取选中文本 + 调后端翻译 + 弹通知
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'translate-selection') return;
  if (!info.selectionText || !tab || tab.id == null) return;
  // 跳过受限页面(chrome:// / Edge / web store 等 content script 不能注入)
  if (!tab.url || /^(chrome|edge|about|chrome-extension|moz-extension):\/\//.test(tab.url)) return;
  async function forward() {
    try {
      await chrome.tabs.sendMessage(tab.id, {
        type: 'translate-selection',
        text: info.selectionText,
      });
      return true;
    } catch {
      return false;
    }
  }
  // 第一次尝试:content script 可能未注入(MV3 document_idle 注入慢),
  // 失败时主动 inject content.js + inject.css,然后再试一次
  let ok = await forward();
  if (!ok) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['src/content.js'],
      });
      try {
        await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['src/inject.css'] });
      } catch { /* CSS 注入失败不阻塞翻译 */ }
      await new Promise((r) => setTimeout(r, 60));
      ok = await forward();
    } catch (e) {
      console.warn('[CT] inject+forward failed:', e);
    }
  }
  if (!ok) console.warn('[CT] translate-selection finally failed for tab', tab.id);
});
