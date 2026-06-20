// 自定义翻译后端 - 内置 provider 注册表
// 每个 provider 只需提供 baseURL + 默认 model;apiKey 走 .env 或运行时覆盖。
// 新增 provider:在 REGISTER 里加一行即可,无需改 server.js / llm.js。

const REGISTER = {
  // ---- Google Translate gtx 公开端点(无需 key,2-3s/条)-----------------
  // 2026-06-20 实测:en→zh 单条 2.4s,长文本 3.4s,比 bailian(14s)快 5-7 倍
  // 注意:走公开端点有频率限制,批量翻译时后端会做并发节流
  google_gtx: {
    label: 'Google Translate (gtx 公开端点,无需 key)',
    baseURL: 'https://translate.googleapis.com/translate_a/single',
    model: 'gtx',
    envKey: null, // 无需 key
    altModels: ['gtx'],
  },
  // ---- 阿里云百炼(默认,本机已验证)-----------------------------------
  bailian: {
    label: '阿里云百炼 (qwen-turbo 默认)',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-turbo',
    envKey: 'LLM_API_KEY',
    // 百炼上其他可换的模型(qwen3.7-plus / qwen3.7-max / glm-5.2 / kimi-k2.7-code)
    altModels: ['qwen-turbo', 'qwen-plus', 'qwen3.7-plus', 'qwen3.7-plus-2026-05-26', 'qwen3.7-max-2026-06-08', 'glm-5.2', 'kimi-k2.7-code'],
  },
  // ---- 火山方舟(用 endpoint id 作为 model)---------------------------
  doubao: {
    label: '火山方舟 (Doubao-Seed-1.6-flash 默认)',
    baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
    model: 'ep-20260615183411-jdjmf',
    envKey: 'DOUBAO_API_KEY',
    altModels: ['ep-20260615183411-jdjmf'], // 已知 endpoint id;更多 EP id 需自己加
  },
  // ---- OpenRouter(几乎所有商用模型)---------------------------------
  openrouter: {
    label: 'OpenRouter (FREE 优先,实测过 11 个能用)',
    baseURL: 'https://openrouter.ai/api/v1',
    model: 'openai/gpt-oss-120b:free',
    envKey: 'OPENROUTER_API_KEY',
    altModels: [
      // ---- 实测 2026-06-18 可用(返回正常译文) ----
      'openai/gpt-oss-120b:free',           // OK · 早起的鸟儿有虫吃
      'openai/gpt-oss-20b:free',            // OK · 早起的鸟儿会抓到虫子
      'google/gemma-4-31b-it:free',         // OK · 早起的鸟儿有虫吃
      'google/gemma-4-26b-a4b-it:free',     // OK · 捷足先登 + 注释
      'nvidia/nemotron-nano-12b-v2-vl:free',// OK · 早起的鸟儿有虫吃
      'liquid/lfm-2.5-1.2b-instruct:free',  // OK · 早起的人捕到虫子
      'cohere/north-mini-code:free',        // OK · 早起的鸟儿能抓到虫子
      'deepseek/deepseek-chat-v3.1',        // OK · 量子计算将彻底改变密码学
      // ---- 实测会返回空文本(thinking-only),暂时不放默认 ----
      // 'nvidia/nemotron-nano-9b-v2:free',
      // 'liquid/lfm-2.5-1.2b-thinking:free',
      // 'poolside/laguna-xs.2:free',
      // ---- 实测 429(暂时额度满,过段时间可能恢复) ----
      // 'qwen/qwen3-next-80b-a3b-instruct:free',
      // 'meta-llama/llama-3.3-70b-instruct:free',
      // 'meta-llama/llama-3.2-3b-instruct:free',
      // 'cognitivecomputations/dolphin-mistral-24b-venice-edition:free',
      // 'nousresearch/hermes-3-llama-3.1-405b:free',
    ],
  },
  // ---- 原有 6 个保留 ----------------------------------------------
  minimax: {
    label: 'MiniMax (MiniMax-M3)',
    baseURL: 'https://api.minimaxi.com/v1',
    model: 'MiniMax-M3',
    envKey: 'LLM_API_KEY',
  },
  deepseek: {
    label: 'DeepSeek (deepseek-chat)',
    baseURL: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    envKey: 'LLM_API_KEY',
  },
  openai: {
    label: 'OpenAI (gpt-4o-mini)',
    baseURL: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    envKey: 'LLM_API_KEY',
  },
  'qwen-mt': {
    label: 'Qwen MT (qwen-mt, 阿里通义机器翻译专用)',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-mt',
    envKey: 'LLM_API_KEY',
  },
  ollama: {
    label: 'Ollama (本机 llm)',
    baseURL: 'http://127.0.0.1:11434/v1',
    model: 'llama3.1',
    envKey: 'LLM_API_KEY',
  },
  custom: {
    label: 'Custom (完全自定义)',
    baseURL: '',
    model: '',
    envKey: 'LLM_API_KEY',
  },
};

function getProviderMeta(name) {
  return REGISTER[name] || null;
}

function listProviders() {
  return Object.entries(REGISTER).map(([id, v]) => ({
    id,
    label: v.label,
    baseURL: v.baseURL,
    model: v.model,
    altModels: v.altModels || [v.model].filter(Boolean),
  }));
}

module.exports = { REGISTER, getProviderMeta, listProviders };
