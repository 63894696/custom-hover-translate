// 配置加载 + 运行时覆盖。
// 设计:启动时读 .env 得到 initial;之后 /select-provider 可在内存里临时覆盖,
//      /translate 每次都从 activeResolved() 读最新值,实现"不重启切换 provider"。
//
// 多 key 调度:每个 provider 在 providers.js 里声明 envKey 字段,启动时按当前
// LLM_PROVIDER 自动从 .env 找对应 key;若用户运行时切换 provider 而没传 apiKey,
// 这里会按 provider 的 envKey 在 process.env 里重新查找。
//
// Fallback chain: PRO开VIDER_FALLBACK_CHAIN = "bailian,doubao,openrouter"
// 启动时按该链构造 fallback 数组;每次 /translate 失败时按链切换下一档;
// 手动切换通过 /select-provider 的 action=next / previous / set 实现。

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { getProviderMeta } = require('./providers');

function isPlaceholderKey(k) {
  if (!k) return true;
  const s = String(k).toLowerCase();
  return (
    s.startsWith('sk-your') ||
    s.startsWith('ark-your') ||
    s.startsWith('sk-or-your') ||
    s.includes('placeholder') ||
    s.includes('your-key') ||
    s === 'changeme'
  );
}

function parseBool(v, fallback) {
  if (v == null) return fallback;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return fallback;
}

function pickApiKeyForProvider(providerId, fallbackKey) {
  const meta = getProviderMeta(providerId);
  if (meta && meta.envKey && process.env[meta.envKey]) {
    return process.env[meta.envKey];
  }
  return fallbackKey || '';
}

// 把 fallback chain 配置解析为 provider id 数组
function parseFallbackChain(s, defaultChain) {
  if (!s) return defaultChain.slice();
  const arr = String(s)
    .split(/[,\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  // 过滤掉无效的 provider id
  const valid = arr.filter((id) => getProviderMeta(id));
  return valid.length ? valid : defaultChain.slice();
}

// 默认 fallback 顺序:bailian(百炼,额度最稳) → doubao → openrouter
// 2026-06-20:默认改 google_gtx — 公开端点 2-3s/条,无需 key,比 bailian(14s)快 5-7 倍
// google_gtx 限流时 fallback 到 bailian → doubao → openrouter
const DEFAULT_FALLBACK_CHAIN = ['google_gtx', 'bailian', 'doubao', 'openrouter'];

const initialProvider = process.env.LLM_PROVIDER || 'google_gtx';
const initial = {
  port: parseInt(process.env.PORT || '12308', 10),
  enableMock: parseBool(process.env.ENABLE_MOCK, false),
  llm: {
    provider: initialProvider,
    apiKey: pickApiKeyForProvider(initialProvider, process.env.LLM_API_KEY || ''),
    baseURL: process.env.LLM_BASE_URL || '',
    model: process.env.LLM_MODEL || '',
    maxTokens: parseInt(process.env.LLM_MAX_TOKENS || '800', 10),
    temperature: parseFloat(process.env.LLM_TEMPERATURE || '0.2'),
    timeoutMs: parseInt(process.env.LLM_TIMEOUT_MS || '30000', 10),
  },
  fallbackChain: parseFallbackChain(
    process.env.PROVIDER_FALLBACK_CHAIN,
    DEFAULT_FALLBACK_CHAIN
  ),
  // 当前 active 在 chain 中的下标(动态变)
  fallbackIndex: Math.max(
    0,
    parseFallbackChain(process.env.PROVIDER_FALLBACK_CHAIN, DEFAULT_FALLBACK_CHAIN).indexOf(initialProvider)
  ),
  fallbackEnabled: parseBool(process.env.PROVIDER_FALLBACK_ENABLED, true),
};

const active = JSON.parse(JSON.stringify(initial));

function activeResolved() {
  const meta = getProviderMeta(active.llm.provider);
  const baseURL = active.llm.baseURL || (meta && meta.baseURL) || '';
  const model = active.llm.model || (meta && meta.model) || '';
  return {
    ...active,
    llm: { ...active.llm, baseURL, model },
  };
}

function shouldUseMock() {
  return active.enableMock && isPlaceholderKey(active.llm.apiKey);
}

function applyOverride({ provider, apiKey, baseURL, model }) {
  if (provider) {
    active.llm.provider = provider;
    if (apiKey === undefined || apiKey === null || apiKey === '') {
      const envKey = pickApiKeyForProvider(provider, '');
      if (envKey) active.llm.apiKey = envKey;
    } else {
      active.llm.apiKey = apiKey;
    }
    if (baseURL === undefined) active.llm.baseURL = '';
    if (model === undefined) active.llm.model = '';

    // 同步 fallbackIndex 到该 provider 在 chain 中的位置
    const idx = active.fallbackChain.indexOf(provider);
    if (idx >= 0) active.fallbackIndex = idx;
  }
  if (apiKey !== undefined && apiKey !== null && apiKey !== '') {
    active.llm.apiKey = apiKey;
  }
  if (baseURL !== undefined) active.llm.baseURL = baseURL;
  if (model !== undefined) active.llm.model = model;
}

// Fallback 控制:
//   action = 'next'     → fallbackIndex 前进一档,刷新 active.llm
//   action = 'previous' → 后退一档
//   action = 'set'      → 手动指定(provider 参数),可透传 apiKey/baseURL/model
//   action = 'disable'  → 关闭 fallback(后续失败不再自动切换)
//   action = 'enable'   → 开启 fallback
function fallbackControl(action, payload = {}) {
  if (!active.fallbackChain.length) {
    return { ok: false, error: 'fallbackChain 为空' };
  }
  if (action === 'next') {
    active.fallbackIndex = (active.fallbackIndex + 1) % active.fallbackChain.length;
  } else if (action === 'previous') {
    active.fallbackIndex = (active.fallbackIndex - 1 + active.fallbackChain.length) % active.fallbackChain.length;
  } else if (action === 'set' && payload.provider) {
    const idx = active.fallbackChain.indexOf(payload.provider);
    if (idx < 0) return { ok: false, error: `provider ${payload.provider} 不在 chain 中` };
    active.fallbackIndex = idx;
  } else if (action === 'disable') {
    active.fallbackEnabled = false;
  } else if (action === 'enable') {
    active.fallbackEnabled = true;
  } else if (action === 'reorder' && Array.isArray(payload.chain)) {
    const valid = payload.chain.filter((id) => getProviderMeta(id));
    if (valid.length) {
      active.fallbackChain = valid;
      active.fallbackIndex = Math.min(active.fallbackIndex, valid.length - 1);
    }
  } else {
    return { ok: false, error: `unknown action: ${action}` };
  }
  // 把 active.llm 同步到当前 index 对应的 provider。
  // set 模式下透传 apiKey/baseURL/model(否则覆盖原值)。
  const newProvider = active.fallbackChain[active.fallbackIndex];
  if (newProvider && (newProvider !== active.llm.provider || action === 'set')) {
    applyOverride({
      provider: newProvider,
      apiKey: action === 'set' ? payload.apiKey : undefined,
      baseURL: action === 'set' ? payload.baseURL : undefined,
      model: action === 'set' ? payload.model : undefined,
    });
  }
  return { ok: true };
}

module.exports = {
  initial,
  active,
  activeResolved,
  applyOverride,
  fallbackControl,
  shouldUseMock,
  isPlaceholderKey,
  pickApiKeyForProvider,
  parseFallbackChain,
};
