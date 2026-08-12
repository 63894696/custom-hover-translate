// Service Worker:把 content script 的 translate / translate-batch 请求交给内置引擎(engines.js)。
// 2026-08-11 重构:不再强制本地 Node 后端;默认引擎扩展内直连(google_gtx 免 key / 用户自定义
// OpenAI 兼容端点),本地后端降级为可选高级项。单例 in-flight:同 key 并发只发一次请求。

// MV3 classic service worker:用 importScripts 引入内置引擎 + 语言清单 + 角色提示词。
// 顺序:prompts 必须在 engines 前(engines 的 buildTranslatePrompt 依赖 CT_PROMPTS)。
try { importScripts('langs.js', 'prompts.js', 'engines.js'); } catch (e) { console.warn('[CT] import langs/prompts/engines failed', e); }

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

  // D 步:测试服务 — 用当前配置(或消息里临时传入的配置)发一条极短翻译,
  // 返回耗时/模型/错误或 needConfig,帮用户确认"端点+Key+模型"配对了没有。
  if (msg.type === 'test-service') {
    handleTestService(msg)
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true;
  }

  // 字幕轨代取(字幕 2):YouTube timedtext 需 pot/cookie 授权,内容脚本直 fetch 返 200 但空体。
  // 扩展 background 进程带扩展 UA + 完整 cookie,可拿到。仅用于 youtube.com timedtext,不收集内容。
  if (msg.type === 'fetch-text') {
    handleFetchText(msg)
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true;
  }

  // 视频笔记:多模态帧理解(视频笔记原型)。帧图(base64 dataURL)+ 笔记提示词,
  // 走用户已配置的 OpenAI 兼容多模态端点(Agnes / Kimi / MiniMax 等)。仅识别当前帧,不收集。
  if (msg.type === 'vision-note') {
    handleVisionNote(msg)
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true;
  }

  return false;
});

// 多模态帧理解:把 {base64, system, user, maxTokens} 转 {baseURL}/chat/completions 的 image_url 消息。
async function handleVisionNote(msg) {
  const s = await chrome.storage.local.get(['baseURL', 'apiKey', 'model', 'visionModel']);
  const baseURL = (s.baseURL || '').replace(/\/+$/, '');
  const model = s.visionModel || s.model; // 允许单独配多模态模型,缺省复用主模型
  if (!baseURL || !model) return { ok: false, needConfig: true, error: '请先在设置里配置端点与模型' };
  const dataUrl = msg && msg.base64;
  if (!dataUrl || typeof dataUrl !== 'string' || !/^data:image\//.test(dataUrl)) {
    return { ok: false, error: 'no_image' };
  }
  const body = {
    model,
    messages: [
      { role: 'system', content: msg.system || '你是视频笔记助手。' },
      { role: 'user', content: [
        { type: 'text', text: msg.user || '描述这一帧。' },
        { type: 'image_url', image_url: { url: dataUrl } },
      ] },
    ],
    max_tokens: Number(msg.maxTokens) || 700,
    stream: false,
  };
  // 多模态推理模型(Agnes 2.5 / Kimi k3 等)可能强制 temperature 或需更大 max_tokens,
  // 不设 temperature(用各家默认),避免 400。
  const headers = { 'Content-Type': 'application/json' };
  if (s.apiKey) headers['Authorization'] = `Bearer ${s.apiKey}`;
  const t0 = Date.now();
  try {
    const r = await fetch(`${baseURL}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) });
    const durationMs = Date.now() - t0;
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      return { ok: false, error: `HTTP ${r.status}`, httpStatus: r.status, detail: txt.slice(0, 200), durationMs };
    }
    const data = await r.json();
    const ch = data && data.choices && data.choices[0];
    let content = ch && ch.message && ch.message.content;
    if (Array.isArray(content)) content = content.map((c) => (c && c.text) || '').join('');
    const text = (content || '').trim();
    if (!text) return { ok: false, error: 'empty', httpStatus: r.status, durationMs };
    return { ok: true, text, model, durationMs };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), durationMs: Date.now() - t0 };
  }
}

// 测试服务:优先用消息里临时填的 baseURL/apiKey/model(用户还没点保存),
// 否则回退 storage 里已存配置。只发一条 "Hello",不记录内容。
async function handleTestService(msg) {
  let { baseURL, apiKey, model } = msg || {};
  if (!baseURL || !model) {
    const s = await chrome.storage.local.get(['baseURL', 'apiKey', 'model']);
    baseURL = baseURL || s.baseURL;
    apiKey = apiKey !== undefined ? apiKey : s.apiKey;
    model = model || s.model;
  }
  if (!baseURL || !model) {
    return { ok: false, needConfig: true, error: '请先填 API Base URL 和模型名' };
  }
  const t0 = Date.now();
  const r = await self.CT_ENGINES.callOpenAICompat({
    baseURL, apiKey: apiKey || '', model,
    text: 'Hello', srcLang: 'en', dstLang: 'zh',
    promptRole: 'general', terms: '',
  });
  const durationMs = Date.now() - t0;
  if (r && r.ok) {
    return { ok: true, model: r.model || model, durationMs, sample: (r.text || '').slice(0, 40) };
  }
  return { ok: false, error: (r && r.error) || 'unknown', httpStatus: r && r.httpStatus, durationMs };
}

// 字幕轨代取:仅允许 youtube.com timedtext(防滥用为通用代理)。
async function handleFetchText(msg) {
  const url = msg && msg.url;
  if (!url || typeof url !== 'string') return { ok: false, error: 'no_url' };
  if (!/^https:\/\/(www\.)?youtube\.com\/api\/timedtext/.test(url)) {
    return { ok: false, error: 'url_not_allowed' };
  }
  try {
    const r = await fetch(url, { credentials: 'include', headers: { 'User-Agent': 'Mozilla/5.0' } });
    const text = await r.text();
    return { ok: r.ok && text.length > 0, status: r.status, text };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

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

  // 规范化每条
  const norm = items.map((it) => {
    const text = it && it.text != null ? it.text : (typeof it === 'string' ? it : '');
    const id = (it && (it.id != null ? it.id : it.key)) || '';
    const srcLang = (it && it.srcLang) || '';
    return { id, text, srcLang };
  });

  // C 步:先试 %% 多段批量(openai_compat 且角色 batchOK),一次请求拿全部;
  // 失败(切回条数不符/网络/非批量角色)→ 回退逐条并发,结果契约完全一致。
  if (norm.length >= 2) {
    try {
      const br = await self.CT_ENGINES.engineTranslateBatch({
        texts: norm.map((x) => x.text),
        srcLang: norm[0].srcLang || '',
        dstLang: finalDst,
      });
      if (br && br.ok && Array.isArray(br.parts) && br.parts.length === norm.length) {
        const results = norm.map((x, i) => ({
          id: x.id, ok: true, text: br.parts[i] || '', error: null, provider: br.provider, model: br.model,
        }));
        const usedByProvider = {}; usedByProvider[(br.provider || 'engine') + '/' + (br.model || '?')] = norm.length;
        return {
          ok: true, needConfig: false, results,
          success: norm.length, fail: 0, total: norm.length,
          usedByProvider,
          lastResp: { provider: br.provider, model: br.model, durationMs: br.durationMs, batched: true, count: br.count },
        };
      }
      if (br && !br.ok && !br.retryable && br.error !== 'batch_split_mismatch' && br.error !== 'too_few'
          && br.error !== 'not_openai_compat' && br.error !== 'role_no_batch' && br.error !== 'no_prompts') {
        // 明确的服务端错误(如 4xx 配置问题)→ 记日志,仍回退逐条由逐条再报错
        logFailure(br.provider || 'engine', br.model || '', br, norm.join('').length);
      }
    } catch (e) {
      console.warn('[CT] %% batch 异常,回退逐条', e);
    }
  }

  // 回退:逐条并发(原逻辑)
  let success = 0, fail = 0;
  const usedByProvider = {};
  let lastResp = null;
  let needConfig = false;

  const results = await mapLimit(norm, conc, async (it) => {
    const r = await self.CT_ENGINES.engineTranslate({ text: it.text, srcLang: it.srcLang, dstLang: finalDst });
    if (r.needConfig) needConfig = true;
    if (r && r.ok) {
      success++;
      const prov = r.provider || 'engine';
      usedByProvider[prov] = (usedByProvider[prov] || 0) + 1;
      lastResp = r;
    } else {
      fail++;
      if (r && !r.needConfig) logFailure(r.provider || 'engine', r.model || '', r, (it.text || '').length);
    }
    return { id: it.id, ok: !!(r && r.ok), text: (r && r.text) || '', error: (r && r.error) || null, provider: r && r.provider, model: r && r.model };
  });

  return {
    ok: !needConfig,
    needConfig,
    results,
    success, fail,
    total: norm.length,
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
    chrome.storage.local.get(['dstLang', 'imageTranslateEnabled'], (s) => {
      const dstLang = s.dstLang || self.CT_LANGS.guessTargetLang();
      const label = `翻译为 ${self.CT_LANGS.langDisplayName(dstLang)}`;
      chrome.contextMenus.create({
        id: 'translate-selection',
        title: label,
        contexts: ['selection'],
      });
      // 图片右键:翻译图相关文本(alt/title/figcaption 等,不含 OCR);可在 options 关
      if (s.imageTranslateEnabled !== false) {
        chrome.contextMenus.create({
          id: 'translate-image',
          title: '翻译图片文字信息',
          contexts: ['image'],
        });
      }
    });
  });
}

chrome.runtime.onInstalled.addListener(() => buildContextMenu());
chrome.runtime.onStartup.addListener(() => buildContextMenu());
// options 页改 dstLang 后也要重建菜单(label 会变)
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.dstLang || changes.imageTranslateEnabled)) buildContextMenu();
});

// 右键菜单点击 → 让 content.js 取选中文本 + 调后端翻译 + 弹通知
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab || tab.id == null) return;
  // 跳过受限页面(chrome:// / Edge / web store 等 content script 不能注入)
  if (!tab.url || /^(chrome|edge|about|chrome-extension|moz-extension):\/\//.test(tab.url)) return;

  if (info.menuItemId === 'translate-selection') {
    if (!info.selectionText) return;
    await forwardToContent(tab.id, { type: 'translate-selection', text: info.selectionText });
    return;
  }
  if (info.menuItemId === 'translate-image') {
    // 让 content.js 用鼠标最近位置定位图片并收集图相关文本
    await forwardToContent(tab.id, { type: 'translate-image', srcUrl: info.srcUrl || '' });
    return;
  }
});

// 统一转发:失败时注入 content.js 再试一次(右键菜单两条共用)
async function forwardToContent(tabId, payload) {
  async function forward() {
    try { await chrome.tabs.sendMessage(tabId, payload); return true; }
    catch { return false; }
  }
  let ok = await forward();
  if (!ok) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['src/content.js'] });
      try { await chrome.scripting.insertCSS({ target: { tabId }, files: ['src/inject.css'] }); } catch {}
      await new Promise((r) => setTimeout(r, 60));
      ok = await forward();
    } catch (e) {
      console.warn('[CT] inject+forward failed:', e);
    }
  }
  if (!ok) console.warn('[CT] forward finally failed for tab', tabId, payload.type);
}
