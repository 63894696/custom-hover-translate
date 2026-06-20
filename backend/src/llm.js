// LLM 客户端 — 沿袭 video-note-backend 的"OpenAI 兼容 /chat/completions"思路,
// 这里独立实现,只搬设计模式,不改、不依赖原项目。
//
// Fallback chain: 本文件的 chatTranslate 接受 options.fallbackChain(数组,provider id 列表),
// 从 active.llm.provider 对应的位置开始逐档尝试,失败时(429/403/5xx/empty text)进到下一档。
// 每次成功会把 usedProvider/usedModel 带回,前端可知道当前生效档位。

const axios = require('axios');
const { activeResolved, shouldUseMock, pickApiKeyForProvider, getProviderMeta } = (() => {
  // 延迟 require 防止循环依赖
  // eslint-disable-next-line global-require
  const cfg = require('./config');
  // eslint-disable-next-line global-require
  const prov = require('./providers');
  return {
    activeResolved: cfg.activeResolved,
    shouldUseMock: cfg.shouldUseMock,
    pickApiKeyForProvider: cfg.pickApiKeyForProvider,
    getProviderMeta: prov.getProviderMeta,
  };
})();

function mockTranslate(text, provider, model) {
  const preview = text.length > 40 ? text.slice(0, 40) + '…' : text;
  return `[mock @ ${provider}/${model}] ${preview}`;
}

// 单次 provider 调用的核心(不处理 fallback,失败直接返回)
// priority: 优先用 active 里的 baseURL/apiKey/model(运行时覆盖);
            // 如果 active.llm.provider 不等于 providerId(即 fallback 切到的档),用该 provider 的 meta 默认值。
async function callOnce({ providerId, text, srcLang, dstLang, customInstructions }) {
  // Google Translate gtx 公开端点:无需 key,GET 请求,特殊 JSON 格式 [[译文,原文,...]]
  if (providerId === 'google_gtx') {
    return callGoogleGtx({ text, srcLang, dstLang });
  }
  const meta = getProviderMeta(providerId);
  if (!meta) {
    return { ok: false, error: `unknown provider: ${providerId}`, provider: providerId, model: '' };
  }

  const activeCfg = activeResolved();
  const isActive = activeCfg.llm.provider === providerId;
  const apiKey = isActive ? activeCfg.llm.apiKey : pickApiKeyForProvider(providerId, '');
  const baseURL = isActive ? activeCfg.llm.baseURL : meta.baseURL;
  const model = isActive ? activeCfg.llm.model : meta.model;

  if (!apiKey) {
    return { ok: false, error: `provider ${providerId} 缺 API key`, provider: providerId, model };
  }
  if (!baseURL || !model) {
    return { ok: false, error: `provider ${providerId} 缺 baseURL 或 model`, provider: providerId, model };
  }
  if (shouldUseMock() && isActive) {
    return {
      ok: true,
      text: mockTranslate(text, providerId, model),
      provider: providerId,
      model,
      mock: true,
      durationMs: 1,
    };
  }

  // eslint-disable-next-line global-require
  const buildPrompt = require('../prompts/translate');
  const { system, user } = buildPrompt({
    segmentText: text,
    customInstructions: [
      `Source language: ${srcLang || '(auto-detect)'}.`,
      `Target language: ${dstLang || 'zh'}.`,
      customInstructions || '',
    ]
      .filter(Boolean)
      .join(' '),
  });

  const url = `${(baseURL || '').replace(/\/+$/, '')}/chat/completions`;
  const headers = { 'Content-Type': 'application/json' };
  headers['Authorization'] = `Bearer ${apiKey}`;

  const body = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    max_tokens: 800,
    temperature: 0.2,
    stream: false,
  };

  const t0 = Date.now();
  try {
    const resp = await axios.post(url, body, { headers, timeout: 30000 });
    const durationMs = Date.now() - t0;
    const choice = resp.data && resp.data.choices && resp.data.choices[0];
    const out =
      (choice && choice.message && (choice.message.content || '').trim()) ||
      (resp.data && resp.data.text) ||
      '';
    if (!out) {
      return {
        ok: false,
        error: 'empty response (model 可能只输出 reasoning_tokens 而无可见 content)',
        provider: providerId,
        model: meta.model,
        durationMs,
        retryable: true,
      };
    }
    return {
      ok: true,
      text: out,
      provider: providerId,
      model: meta.model,
      durationMs,
      usage: resp.data && resp.data.usage,
    };
  } catch (e) {
    const durationMs = Date.now() - t0;
    const status = e.response && e.response.status;
    const detail =
      (e.response && e.response.data && JSON.stringify(e.response.data).slice(0, 200)) ||
      e.message ||
      'unknown error';
    return {
      ok: false,
      error: status ? `HTTP ${status}: ${detail}` : `network: ${detail}`,
      provider: providerId,
      model: meta.model,
      durationMs,
      retryable: !status || status === 429 || status === 403 || status >= 500,
      httpStatus: status,
    };
  }
}

// 是否应该自动 fallback
function shouldFallback(errResult) {
  if (!errResult) return true;
  if (errResult.retryable) return true;
  if (errResult.httpStatus === 429 || errResult.httpStatus === 403) return true;
  return false;
}

// chatTranslate — 主入口,支持 fallback chain
// options.fallbackChain: 可选,数组,如 ['bailian','doubao','openrouter']
// options.fallbackEnabled: 可选,布尔
async function chatTranslate({ text, srcLang = '', dstLang = 'zh', customInstructions = '', fallbackChain = null, fallbackEnabled = null }) {
  const cfg = activeResolved();
  const chain =
    Array.isArray(fallbackChain) && fallbackChain.length
      ? fallbackChain
      : cfg.fallbackChain;
  const enabled = fallbackEnabled === null ? cfg.fallbackEnabled : !!fallbackEnabled;

  if (!chain || chain.length === 0) {
    return callOnce({ providerId: cfg.llm.provider, text, srcLang, dstLang, customInstructions });
  }

  // 从当前 provider 在 chain 中的位置开始(若无则 0)
  let startIdx = chain.indexOf(cfg.llm.provider);
  if (startIdx < 0) startIdx = 0;

  const attempts = [];
  const total0 = Date.now();
  let lastErr = null;

  for (let i = 0; i < chain.length; i++) {
    const idx = (startIdx + i) % chain.length;
    const providerId = chain[idx];
    const r = await callOnce({ providerId, text, srcLang, dstLang, customInstructions });
    attempts.push({
      provider: r.provider,
      model: r.model,
      ok: r.ok,
      error: r.error || null,
      durationMs: r.durationMs || 0,
    });
    if (r.ok) {
      return {
        ...r,
        attempts,
        fallbackUsed: attempts.length > 1,
        totalDurationMs: Date.now() - total0,
        fallbackEnabled: enabled,
        fallbackChain: chain,
        usedProvider: r.provider,
        usedModel: r.model,
      };
    }
    lastErr = r;
    // 失败且不可重试 → 不再继续(例如 400 bad request)
    if (!shouldFallback(r)) {
      break;
    }
    // fallbackEnabled=false:不再继续
    if (!enabled) {
      break;
    }
    // 最后一档:不再继续
    if (i === chain.length - 1) break;
  }

  // 全失败
  return {
    ok: false,
    error: lastErr && lastErr.error ? lastErr.error : 'all fallback providers failed',
    provider: lastErr && lastErr.provider,
    model: lastErr && lastErr.model,
    attempts,
    fallbackUsed: attempts.length > 1,
    totalDurationMs: Date.now() - total0,
    fallbackEnabled: enabled,
    fallbackChain: chain,
  };
}

// Google Translate gtx 公开端点(无需 API key,2026-06-20 实测 2-3s/条)
// 端点:GET https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh&dt=t&q=...
// 返回格式:[[[译文,原文,null,null,3,null,null,[[]],[[["hash"]]]], ...], null, "en", ...]
//  - 外层数组里嵌套 [译文, 原文, ...] 子数组,按句拆分
//  - 跨多个句子需拼接所有 "译文" 字段
async function callGoogleGtx({ text, srcLang, dstLang }) {
  const params = new URLSearchParams({
    client: 'gtx',
    sl: srcLang || 'auto',
    tl: dstLang || 'zh',
    dt: 't',
    q: text,
  });
  const url = `https://translate.googleapis.com/translate_a/single?${params.toString()}`;
  const t0 = Date.now();
  try {
    const resp = await axios.get(url, { timeout: 30000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    const durationMs = Date.now() - t0;
    const data = resp.data;
    // 解析嵌套数组:data 是 [[[译文1,原文1,...], [译文2,原文2,...]], null, "en", ...]
    let translated = '';
    if (Array.isArray(data) && Array.isArray(data[0])) {
      for (const segment of data[0]) {
        if (Array.isArray(segment) && typeof segment[0] === 'string') {
          translated += segment[0];
        }
      }
    }
    if (!translated) {
      return {
        ok: false,
        error: 'empty response from google gtx (Google 可能限流或返回了非预期格式)',
        provider: 'google_gtx',
        model: 'gtx',
        durationMs,
        retryable: true,
      };
    }
    return {
      ok: true,
      text: translated,
      provider: 'google_gtx',
      model: 'gtx',
      durationMs,
    };
  } catch (e) {
    const durationMs = Date.now() - t0;
    const status = e.response && e.response.status;
    return {
      ok: false,
      error: status ? `HTTP ${status} from google gtx` : `network: ${e.message || e}`,
      provider: 'google_gtx',
      model: 'gtx',
      durationMs,
      retryable: !status || status === 429 || status >= 500,
      httpStatus: status,
    };
  }
}

module.exports = { chatTranslate, mockTranslate, callOnce };
