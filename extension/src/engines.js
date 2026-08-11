// engines.js — 扩展内置翻译引擎(MV3 service worker / 扩展页可用,纯 fetch,无 axios)
//
// 设计原则(2026-08-11 重构):
//   1) 不强制本地后端:默认引擎在扩展内直连,开箱即用。
//   2) 不预设任何国内/海外厂商:只内置免 key 的 google_gtx 兜底;
//      其它一切走"自定义 OpenAI 兼容端点"(用户自填 baseURL/key/model)。
//   3) 本地 Node 后端(127.0.0.1:12308)降级为可选高级项,默认关。
//   4) 隐私:不收集翻译内容;key/端点只存 chrome.storage.local。

const GTX_URL = 'https://translate.googleapis.com/translate_a/single';
const DEFAULT_LOCAL_BACKEND = 'http://127.0.0.1:12308';
const PROBE_TIMEOUT_MS = 4000;
const TRANSLATE_TIMEOUT_MS = 30000;

// ---------- 读取用户配置 ----------
async function readCfg() {
  const s = await chrome.storage.local.get([
    'engine',          // 'auto' | 'google_gtx' | 'openai_compat' | 'local_backend'
    'baseURL', 'apiKey', 'model',   // openai_compat 用
    'endpoint',                     // local_backend 用
    'detectedEngine',  // 自动探测缓存结果
    'dstLang',
  ]);
  return s;
}

// ---------- 自动探测:能否连 Google ----------
// 结果缓存到 storage.detectedEngine,避免每次翻译都探测。
async function detectEngine(force = false) {
  const s = await chrome.storage.local.get(['detectedEngine']);
  if (!force && s.detectedEngine) return s.detectedEngine;
  let detected = 'need_config'; // 默认:连不上 Google,需用户配置
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
    // 用一个极小的 gtx 请求探测(比 HEAD 更可靠,某些网络 HEAD 被拦)
    const u = `${GTX_URL}?client=gtx&sl=en&tl=zh&dt=t&q=hi`;
    const r = await fetch(u, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
    clearTimeout(t);
    if (r.ok) detected = 'google_gtx';
  } catch (e) {
    detected = 'need_config';
  }
  try { await chrome.storage.local.set({ detectedEngine: detected }); } catch {}
  return detected;
}

// ---------- 决定本次用哪个引擎 ----------
// B 步(2026-08-12)多级自动降级路由(auto 模式):
//   1. google_gtx   — 海外能连 Google,免 key
//   2. openai_compat— 国内主通路(用户自配的 OpenAI 兼容端点)
//   3. need_config  — 都不通且没配端点 → 引导(链 babelspan 模型页)
// 显式指定引擎时(engine != auto)不做降级,直接按用户选择。
async function resolveEngine() {
  const cfg = await readCfg();
  const eng = cfg.engine || 'auto';
  if (eng === 'google_gtx') return { kind: 'google_gtx' };
  if (eng === 'openai_compat') {
    if (!cfg.baseURL || !cfg.model) return { kind: 'error', error: '自定义端点缺 baseURL 或 model,请到设置里补全' };
    return { kind: 'openai_compat', baseURL: cfg.baseURL, apiKey: cfg.apiKey || '', model: cfg.model };
  }
  if (eng === 'local_backend') {
    return { kind: 'local_backend', endpoint: cfg.endpoint || DEFAULT_LOCAL_BACKEND };
  }
  // auto:用探测结果
  const detected = await detectEngine();
  if (detected === 'google_gtx') return { kind: 'google_gtx' };
  // 探测不通 Google:若用户已配好自定义端点,自动用它;否则报"需配置"
  if (cfg.baseURL && cfg.model) {
    return { kind: 'openai_compat', baseURL: cfg.baseURL, apiKey: cfg.apiKey || '', model: cfg.model, autoFromDetect: true };
  }
  return { kind: 'need_config' };
}

// ---------- google_gtx(免 key,GET) ----------
async function callGoogleGtx({ text, srcLang, dstLang }) {
  const params = new URLSearchParams({
    client: 'gtx',
    sl: srcLang || 'auto',
    tl: dstLang || 'zh',
    dt: 't',
    q: text,
  });
  const url = `${GTX_URL}?${params.toString()}`;
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TRANSLATE_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
    clearTimeout(timer);
    const durationMs = Date.now() - t0;
    if (!resp.ok) {
      return { ok: false, error: `HTTP ${resp.status}`, provider: 'google_gtx', model: 'gtx', durationMs, retryable: resp.status === 429 || resp.status >= 500, httpStatus: resp.status };
    }
    const data = await resp.json();
    let translated = '';
    if (Array.isArray(data) && Array.isArray(data[0])) {
      for (const seg of data[0]) {
        if (Array.isArray(seg) && typeof seg[0] === 'string') translated += seg[0];
      }
    }
    if (!translated) {
      return { ok: false, error: 'empty', provider: 'google_gtx', model: 'gtx', durationMs, retryable: true };
    }
    return { ok: true, text: translated, provider: 'google_gtx', model: 'gtx', durationMs };
  } catch (e) {
    clearTimeout(timer);
    const durationMs = Date.now() - t0;
    const isTimeout = e && e.name === 'AbortError';
    return { ok: false, error: isTimeout ? 'timeout' : 'network', provider: 'google_gtx', model: 'gtx', durationMs, retryable: true };
  }
}

// ---------- 通用 OpenAI 兼容端点(用户自填) ----------
// C 步(2026-08-12):提示词改为「角色预设」(prompts.js)。按 storage.promptRole 选角色,
// 支持 {{to}}/{{text}} 占位与 %% 多段批量;google_gtx 不走这里。
async function readPromptCfg() {
  const s = await chrome.storage.local.get(['promptRole', 'termsText']);
  return { promptRole: s.promptRole || 'general', terms: s.termsText || '' };
}

function buildTranslatePrompt({ text, srcLang, dstLang, promptRole, terms }) {
  // 有 prompts.js 就用角色体系;没有(异常兜底)退回原通用 prompt。
  if (self.CT_PROMPTS && self.CT_PROMPTS.buildPrompt) {
    const p = self.CT_PROMPTS.buildPrompt({ roleId: promptRole || 'general', dstLang, singleText: text, terms });
    return { system: p.system, user: p.user };
  }
  const system = 'You are a professional translation engine. Translate the user text to the target language. Output ONLY the translated text, no explanation, no quotes, no extra whitespace.';
  const user = `Source language: ${srcLang || 'auto-detect'}. Target language: ${dstLang || 'Chinese'}.\n\n${text}`;
  return { system, user };
}

async function callOpenAICompat({ baseURL, apiKey, model, text, srcLang, dstLang, promptRole, terms, temperature, maxTokens }) {
  const url = `${(baseURL || '').replace(/\/+$/, '')}/chat/completions`;
  const { system, user } = buildTranslatePrompt({ text, srcLang, dstLang, promptRole, terms });
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  const body = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    max_tokens: Number(maxTokens) || 800,
    temperature: (temperature != null && !isNaN(Number(temperature))) ? Number(temperature) : 0.2,
    stream: false,
  };
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TRANSLATE_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
    clearTimeout(timer);
    const durationMs = Date.now() - t0;
    if (!resp.ok) {
      return { ok: false, error: `HTTP ${resp.status}`, provider: 'openai_compat', model, durationMs, retryable: resp.status === 429 || resp.status === 403 || resp.status >= 500, httpStatus: resp.status };
    }
    const data = await resp.json();
    const choice = data && data.choices && data.choices[0];
    const out = (choice && choice.message && (choice.message.content || '').trim()) || (data && data.text) || '';
    if (!out) {
      return { ok: false, error: 'empty', provider: 'openai_compat', model, durationMs, retryable: true };
    }
    return { ok: true, text: out, provider: 'openai_compat', model, durationMs };
  } catch (e) {
    clearTimeout(timer);
    const durationMs = Date.now() - t0;
    const isTimeout = e && e.name === 'AbortError';
    return { ok: false, error: isTimeout ? 'timeout' : 'network', provider: 'openai_compat', model, durationMs, retryable: true };
  }
}

// ---------- 可选:本地 Node 后端 ----------
async function callLocalBackend({ endpoint, text, srcLang, dstLang }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TRANSLATE_TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const r = await fetch(`${endpoint}/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, srcLang, dstLang }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const durationMs = Date.now() - t0;
    const data = await r.json().catch(() => null);
    if (!r.ok || !data) {
      return { ok: false, error: (data && data.error) || `HTTP ${r.status}`, provider: 'local_backend', durationMs, retryable: true };
    }
    return { ok: !!data.ok, text: data.text || '', error: data.error || null, provider: data.provider || 'local_backend', model: data.model || '', durationMs };
  } catch (e) {
    clearTimeout(timer);
    const isTimeout = e && e.name === 'AbortError';
    return { ok: false, error: isTimeout ? 'timeout' : 'network', provider: 'local_backend', durationMs: Date.now() - t0, retryable: true };
  }
}

// ---------- 统一入口:单条翻译(带回退) ----------
// 回退策略:auto 模式下 gtx 失败 → 若配了自定义端点则尝试;否则返回需配置。
async function engineTranslate({ text, srcLang, dstLang }) {
  const eng = await resolveEngine();
  if (eng.kind === 'need_config') {
    return { ok: false, needConfig: true, error: 'need_config' };
  }
  if (eng.kind === 'error') {
    return { ok: false, error: eng.error, needConfig: true };
  }
  const args = { text, srcLang, dstLang };
  // C 步:角色提示词 + 温度/最大 token 配置(仅 openai_compat 用)。
  const pc = await readPromptCfg();
  const adv = await chrome.storage.local.get(['temperature', 'maxTokens']);
  const llmOpts = { promptRole: pc.promptRole, terms: pc.terms, temperature: adv.temperature, maxTokens: adv.maxTokens };
  let r;
  if (eng.kind === 'google_gtx') {
    r = await callGoogleGtx(args);
    // auto 模式下 gtx 失败 → 尝试自定义端点兜底
    if (!r.ok && r.retryable) {
      const cfg = await readCfg();
      if ((cfg.engine || 'auto') === 'auto' && cfg.baseURL && cfg.model) {
        const r2 = await callOpenAICompat({ baseURL: cfg.baseURL, apiKey: cfg.apiKey || '', model: cfg.model, ...args, ...llmOpts });
        if (r2.ok) return { ...r2, fallbackUsed: true };
      }
    }
    return r;
  }
  if (eng.kind === 'openai_compat') {
    return await callOpenAICompat({ ...eng, ...args, ...llmOpts });
  }
  if (eng.kind === 'local_backend') {
    return await callLocalBackend({ ...eng, ...args });
  }
  return { ok: false, error: 'unknown engine' };
}

// ---------- 拉取模型列表(OpenAI 兼容 GET {baseURL}/models) ----------
// 用用户的 key 请求其端点的模型清单,免去手填模型名。key/端点只存本机。
async function listModels({ baseURL, apiKey }) {
  if (!baseURL) return { ok: false, error: 'no_baseURL', models: [] };
  const url = `${(baseURL || '').replace(/\/+$/, '')}/models`;
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS + 4000);
  try {
    const resp = await fetch(url, { headers, signal: ctrl.signal });
    clearTimeout(timer);
    if (!resp.ok) {
      return { ok: false, error: `HTTP ${resp.status}`, models: [], httpStatus: resp.status };
    }
    const data = await resp.json();
    const arr = (data && Array.isArray(data.data) && data.data) || (Array.isArray(data) ? data : []);
    const models = arr
      .map((m) => (m && (m.id || m.name || m.model)) || (typeof m === 'string' ? m : null))
      .filter(Boolean);
    return { ok: models.length > 0, models, error: models.length ? null : 'empty' };
  } catch (e) {
    clearTimeout(timer);
    const isTimeout = e && e.name === 'AbortError';
    return { ok: false, error: isTimeout ? 'timeout' : 'network', models: [] };
  }
}

// ---------- 健康/状态 ----------
// 返回给 popup 展示:不是"后端是否在线",而是"当前翻译引擎是否就绪"。
// B 步:need_config 引导做实——告诉国内用户去哪选模型/拿 key(babelspan 模型页)。
const MODELS_GUIDE_URL = 'https://www.babelspan.com/models.html';
async function engineStatus() {
  const eng = await resolveEngine();
  if (eng.kind === 'need_config') {
    return {
      ok: false, needConfig: true, label: '需配置',
      hint: '当前网络连不上内置翻译。请填入一个翻译服务的端点和 Key(国内推荐智谱/通义/DeepSeek,免费或极低价)。',
      guideUrl: MODELS_GUIDE_URL,
      guideText: '不知道选哪个?看模型怎么选 →',
    };
  }
  if (eng.kind === 'error') {
    return { ok: false, needConfig: true, label: '需配置', hint: eng.error, guideUrl: MODELS_GUIDE_URL, guideText: '模型选型帮助 →' };
  }
  if (eng.kind === 'google_gtx') return { ok: true, label: '就绪', engine: '内置翻译(Google)' };
  if (eng.kind === 'openai_compat') {
    const via = eng.autoFromDetect ? ' · 已自动切换' : '';
    return { ok: true, label: '就绪', engine: `自定义端点(${eng.model})${via}` };
  }
  if (eng.kind === 'local_backend') return { ok: true, label: '就绪', engine: '本地后端(进阶)' };
  return { ok: false, needConfig: true, label: '需配置', guideUrl: MODELS_GUIDE_URL, guideText: '模型选型帮助 →' };
}

// 暴露给 background.js(MV3 service worker 用 importScripts 或同文件;这里挂到 self)
// ---------- %% 多段批量(C 步) ----------
// 把多条文本用 \n%%\n 拼进一次 LLM 请求,模型按同分隔符回译,再切回各条。
// 省 token、降延迟(一次请求代替 N 次)。仅 openai_compat 且角色 batchOK 时用;
// 切回条数不符 / 出错 → 返回 ok:false,由调用方回退逐条翻译,绝不丢数据。
async function engineTranslateBatch({ texts, srcLang, dstLang }) {
  if (!Array.isArray(texts) || texts.length < 2) return { ok: false, error: 'too_few' };
  const eng = await resolveEngine();
  if (eng.kind !== 'openai_compat') return { ok: false, error: 'not_openai_compat' };
  const pc = await readPromptCfg();
  const role = self.CT_PROMPTS && self.CT_PROMPTS.getRole ? self.CT_PROMPTS.getRole(pc.promptRole) : null;
  if (!role || !role.batchOK) return { ok: false, error: 'role_no_batch' };
  if (!self.CT_PROMPTS || !self.CT_PROMPTS.buildPrompt) return { ok: false, error: 'no_prompts' };

  const to = self.CT_PROMPTS.toName(dstLang);
  const adv = await chrome.storage.local.get(['temperature', 'maxTokens']);
  const p = self.CT_PROMPTS.buildPrompt({ roleId: pc.promptRole, dstLang, batchTexts: texts, terms: pc.terms });
  const url = `${(eng.baseURL || '').replace(/\/+$/, '')}/chat/completions`;
  const headers = { 'Content-Type': 'application/json' };
  if (eng.apiKey) headers['Authorization'] = `Bearer ${eng.apiKey}`;
  // 批量时 max_tokens 要随条数放大,避免长批被截断。
  const estTokens = Math.min(4000, Math.max(800, Math.ceil(texts.join('').length * 1.2)));
  const body = {
    model: eng.model,
    messages: [ { role: 'system', content: p.system }, { role: 'user', content: p.user } ],
    max_tokens: Number(adv.maxTokens) || estTokens,
    temperature: (adv.temperature != null && !isNaN(Number(adv.temperature))) ? Number(adv.temperature) : 0.2,
    stream: false,
  };
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TRANSLATE_TIMEOUT_MS + texts.length * 2000);
  try {
    const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
    clearTimeout(timer);
    const durationMs = Date.now() - t0;
    if (!resp.ok) {
      return { ok: false, error: `HTTP ${resp.status}`, provider: 'openai_compat', model: eng.model, durationMs, retryable: true, httpStatus: resp.status };
    }
    const data = await resp.json();
    const choice = data && data.choices && data.choices[0];
    const out = (choice && choice.message && (choice.message.content || '')) || '';
    const parts = self.CT_PROMPTS.splitBatch(out, texts.length);
    if (!parts) {
      // 切回条数不符 → 让调用方回退逐条,不丢数据
      return { ok: false, error: 'batch_split_mismatch', provider: 'openai_compat', model: eng.model, durationMs, retryable: false };
    }
    return { ok: true, parts, provider: 'openai_compat', model: eng.model, durationMs, batched: true, count: texts.length };
  } catch (e) {
    clearTimeout(timer);
    const isTimeout = e && e.name === 'AbortError';
    return { ok: false, error: isTimeout ? 'timeout' : 'network', provider: 'openai_compat', model: eng.model, durationMs: Date.now() - t0, retryable: true };
  }
}

self.CT_ENGINES = {
  detectEngine,
  resolveEngine,
  engineTranslate,
  engineTranslateBatch,
  engineStatus,
  callGoogleGtx,
  callOpenAICompat,
  callLocalBackend,
  listModels,
};
