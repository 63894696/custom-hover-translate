// Service Worker:把 content script 的 translate / translate-batch 请求交给内置引擎(engines.js)。
// 2026-08-11 重构:不再强制本地 Node 后端;默认引擎扩展内直连(google_gtx 免 key / 用户自定义
// OpenAI 兼容端点),本地后端降级为可选高级项。单例 in-flight:同 key 并发只发一次请求。

// MV3 classic service worker:用 importScripts 引入内置引擎 + 语言清单。
try { importScripts('engines.js', 'langs.js'); } catch (e) { console.warn('[CT] import engines/langs failed', e); }

const TIMEOUT_MS = 30000;

const inflight = new Map(); // key -> Promise

// 批量翻译的简单并发限制(扩展内直连,无后端节流)
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let idx = 0;
  async function run() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await worker(items[i], i);
    }
  }
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, run);
  await Promise.all(runners);
  return results;
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

  if (msg.type === 'health') {
    handleHealth()
      .then((resp) => sendResponse(resp))
      .catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true;
  }

  if (msg.type === 'redetect-engine') {
    self.CT_ENGINES.detectEngine(true)
      .then((r) => sendResponse({ ok: true, detected: r }))
      .catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true;
  }

  if (msg.type === 'list-models') {
    handleListModels(msg)
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true;
  }

  return false;
});

// ============ 失败诊断日志(用户问"模型翻不了有没有日志可查") ============
// 只存本机 chrome.storage.local._ct_log(最多 100 条,环形),绝不上行。
// 记录:时间/引擎/模型/错误/耗时/文本长度(不记文本内容,避免泄露隐私)。
async function logCT(entry) {
  try {
    const { _ct_log } = await chrome.storage.local.get('_ct_log');
    const arr = Array.isArray(_ct_log) ? _ct_log : [];
    arr.push({ ts: Date.now(), ...entry });
    while (arr.length > 100) arr.shift();
    await chrome.storage.local.set({ _ct_log: arr });
  } catch {}
}
function logFailure(provider, model, r, textLen) {
  console.warn(`[CT] 翻译失败 provider=${provider} model=${model} err=${r && r.error} http=${r && r.httpStatus || ''} len=${textLen}`);
  logCT({ kind: 'fail', provider, model, error: (r && r.error) || 'unknown', httpStatus: r && r.httpStatus, durationMs: r && r.durationMs, textLen });
}

// 拉取自定义端点的模型列表。允许 popup/options 直接传 baseURL/apiKey
// (还没保存到 storage 时也能拉),否则回退读 storage 里的已存配置。
async function handleListModels(msg) {
  let { baseURL, apiKey } = msg;
  if (!baseURL) {
    const s = await chrome.storage.local.get(['baseURL', 'apiKey']);
    baseURL = baseURL || s.baseURL;
    apiKey = apiKey || s.apiKey;
  }
  const r = await self.CT_ENGINES.listModels({ baseURL, apiKey: apiKey || '' });
  return r;
}

async function handleTranslate({ key, text, srcLang = '', dstLang = '' }) {
  if (inflight.has(key)) {
    return inflight.get(key);
  }
  const p = (async () => {
    const { dstLang: stored } = await chrome.storage.local.get('dstLang');
    const finalDst = dstLang || stored || 'zh';
    const r = await self.CT_ENGINES.engineTranslate({ text, srcLang, dstLang: finalDst });
    if (r && !r.ok && !r.needConfig) logFailure(r.provider || 'engine', r.model || '', r, (text || '').length);
    return { ...r, key };
  })();
  inflight.set(key, p);
  try {
    return await p;
  } finally {
    inflight.delete(key);
  }
}

// 引擎就绪状态(不再是"后端健康")
async function handleHealth() {
  try {
    const s = await self.CT_ENGINES.engineStatus();
    return { ok: !!s.ok, data: s, needConfig: !!s.needConfig };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

async function handleTranslateBatch({ items = [], dstLang = '', concurrency = 6 }) {
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, error: 'items 必须是非空数组' };
  }
  const { dstLang: stored } = await chrome.storage.local.get('dstLang');
  const finalDst = dstLang || stored || 'zh';
  const conc = Math.max(1, Math.min(20, Number(concurrency) || 6));

  let success = 0, fail = 0;
  const usedByProvider = {};
  let lastResp = null;
  let needConfig = false;

  const results = await mapLimit(items, conc, async (it) => {
    const text = it && it.text != null ? it.text : (typeof it === 'string' ? it : '');
    // content.js 用 id 匹配结果(也可能是 key,做个兼容)
    const id = (it && (it.id != null ? it.id : it.key)) || '';
    const srcLang = (it && it.srcLang) || '';
    const r = await self.CT_ENGINES.engineTranslate({ text, srcLang, dstLang: finalDst });
    if (r.needConfig) needConfig = true;
    if (r && r.ok) {
      success++;
      const prov = r.provider || 'engine';
      usedByProvider[prov] = (usedByProvider[prov] || 0) + 1;
      lastResp = r;
    } else {
      fail++;
      if (r && !r.needConfig) logFailure(r.provider || 'engine', r.model || '', r, (text || '').length);
    }
    return { id, ok: !!(r && r.ok), text: (r && r.text) || '', error: (r && r.error) || null, provider: r && r.provider, model: r && r.model };
  });

  return {
    ok: !needConfig,
    needConfig,
    results,
    success, fail,
    total: items.length,
    usedByProvider,
    lastResp: lastResp ? { provider: lastResp.provider, model: lastResp.model, durationMs: lastResp.durationMs, fallbackUsed: !!lastResp.fallbackUsed } : null,
  };
}

// 安装/启动默认值
chrome.runtime.onInstalled.addListener(async () => {
  const cur = await chrome.storage.local.get(['enabled', 'dstLang', 'showOriginal', 'engine']);
  const patch = {};
  if (cur.enabled === undefined) patch.enabled = true;
  if (!cur.dstLang) patch.dstLang = self.CT_LANGS.guessTargetLang(); // 默认按系统语言
  if (cur.showOriginal === undefined) patch.showOriginal = false;
  if (!cur.engine) patch.engine = 'auto'; // 默认自动探测,不预设厂商
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
  // 安装后立即探测一次网络环境(能连 Google 与否),缓存结果供首次翻译用
  try { await self.CT_ENGINES.detectEngine(true); } catch {}
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
// 用户选好文本 → 右键 → "翻译为 XXX" → content.js 调内置引擎 + 弹通知
function buildContextMenu() {
  chrome.contextMenus.removeAll(() => {
    // 用 navigator.language 推断目标语言(用户在 options 页改的 dstLang 优先)
    chrome.storage.local.get(['dstLang'], (s) => {
      const dstLang = s.dstLang || self.CT_LANGS.guessTargetLang();
      const label = `翻译为 ${self.CT_LANGS.langDisplayName(dstLang)}`;
      chrome.contextMenus.create({
        id: 'translate-selection',
        title: label,
        contexts: ['selection'],
      });
    });
  });
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
