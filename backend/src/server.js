// 翻译后端 Express 服务 - 5 个 endpoint:
//   GET  /health             健康检查 + 当前 provider/model + fallback chain
//   GET  /providers          列出所有内置 provider
//   POST /translate          单段翻译(自动 fallback)
//   POST /translate/batch    批量翻译(自动 fallback)
//   POST /select-provider    运行时切换 provider / apiKey / baseURL / model / fallback 控制

const express = require('express');
const cors = require('cors');

const { active, activeResolved, applyOverride, fallbackControl, shouldUseMock } = require('./config');
const { listProviders } = require('./providers');
const { chatTranslate } = require('./llm');

const app = express();

app.use(
  cors({
    origin: true, // 浏览器扩展 / 同源 curl 都允许;真正发布时可收紧
  })
);
app.use(express.json({ limit: '4mb' })); // batch 端点需要更大

// ---------- /health ----------
app.get('/health', (_req, res) => {
  const cfg = activeResolved();
  res.json({
    ok: true,
    provider: cfg.llm.provider,
    model: cfg.llm.model,
    baseURL: cfg.llm.baseURL,
    mock: shouldUseMock(),
    uptimeSec: Math.round(process.uptime()),
    fallbackChain: cfg.fallbackChain,
    fallbackIndex: cfg.fallbackIndex,
    fallbackEnabled: cfg.fallbackEnabled,
  });
});

// ---------- /providers ----------
app.get('/providers', (_req, res) => {
  res.json({ ok: true, providers: listProviders() });
});

// ---------- /translate (单段) ----------
app.post('/translate', async (req, res) => {
  const t0 = Date.now();
  const { text = '', srcLang = '', dstLang = 'zh', customInstructions = '' } = req.body || {};

  if (typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ ok: false, error: 'text 不能为空' });
  }
  if (text.length > 4000) {
    return res.status(413).json({ ok: false, error: 'text 超过 4000 字符上限(本期不分段)' });
  }

  const result = await chatTranslate({
    text: text.trim(),
    srcLang,
    dstLang,
    customInstructions,
  });

  const durationMs = result.durationMs ?? Date.now() - t0;
  const payload = { ...result, durationMs };

  const inLen = text.length;
  const outLen = (result.text || '').length;
  const tag = result.ok ? 'OK ' : 'ERR';
  const usedProvider = result.usedProvider || result.provider || '-';
  const usedModel = result.usedModel || result.model || '-';
  const attemptsInfo = result.attempts
    ? ` attempts=${result.attempts.length}${result.fallbackUsed ? '(fallback)' : ''}`
    : '';
  console.log(
    `[${tag}] ${usedProvider}/${usedModel} mock=${!!result.mock} ${durationMs}ms in=${inLen} out=${outLen}${attemptsInfo}${
      result.error ? ` err=${result.error.slice(0, 120)}` : ''
    }`
  );

  res.status(result.ok ? 200 : 502).json(payload);
});

// ---------- /translate/batch (批量,并发限流) ----------
//
// 请求:
//   {
//     "items": [
//       { "id": "p0", "text": "...", "srcLang": "en" },
//       { "id": "p1", "text": "...", "srcLang": "ja" },
//       ...
//     ],
//     "dstLang": "zh",
//     "concurrency": 6          // 可选,默认 6
//   }
//
// 响应:
//   {
//     "ok": true,
//     "provider": "bailian",
//     "model": "qwen-turbo",
//     "results": [
//       { "id": "p0", "ok": true,  "text": "..." },
//       { "id": "p1", "ok": false, "error": "..." },
//       ...
//     ],
//     "durationMs": 4321,
//     "successCount": 7,
//     "failCount": 1
//   }
app.post('/translate/batch', async (req, res) => {
  const t0 = Date.now();
  const { items = [], dstLang = 'zh', concurrency = 6 } = req.body || {};

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ ok: false, error: 'items 必须是非空数组' });
  }
  if (items.length > 200) {
    return res.status(413).json({ ok: false, error: 'items 数量超过 200 上限(避免一次请求过重)' });
  }

  // 过滤 + 规范化
  const validItems = [];
  const invalidItems = [];
  items.forEach((it, i) => {
    const id = (it && it.id) || `item-${i}`;
    const text = (it && typeof it.text === 'string') ? it.text.trim() : '';
    if (!text) {
      invalidItems.push({ id, ok: false, error: 'text 为空' });
    } else if (text.length > 4000) {
      invalidItems.push({ id, ok: false, error: 'text 超过 4000 字符上限' });
    } else {
      validItems.push({
        id,
        text,
        srcLang: (it && it.srcLang) || '',
        customInstructions: (it && it.customInstructions) || '',
      });
    }
  });

  const results = new Array(items.length);
  // 写入 invalid 项(保持 id 在 results 里)
  const idIndex = new Map();
  items.forEach((it, i) => {
    idIndex.set((it && it.id) || `item-${i}`, i);
  });
  invalidItems.forEach((inv) => {
    if (idIndex.has(inv.id)) results[idIndex.get(inv.id)] = inv;
  });

  // 简易信号量式并发限流
  const limit = Math.max(1, Math.min(20, Number(concurrency) || 6));
  let cursor = 0;
  let successCount = 0;
  let failCount = invalidItems.length;
  const providerCfg = activeResolved().llm;

  async function worker() {
    while (cursor < validItems.length) {
      const idx = cursor++;
      const it = validItems[idx];
      try {
        const r = await chatTranslate({
          text: it.text,
          srcLang: it.srcLang,
          dstLang,
          customInstructions: it.customInstructions,
        });
        const entry = { id: it.id, ok: !!r.ok, text: r.text || '', error: r.error || null, durationMs: r.durationMs || 0 };
        if (idIndex.has(it.id)) results[idIndex.get(it.id)] = entry;
        if (entry.ok) successCount++;
        else failCount++;
      } catch (e) {
        const entry = { id: it.id, ok: false, error: String((e && e.message) || e), durationMs: 0 };
        if (idIndex.has(it.id)) results[idIndex.get(it.id)] = entry;
        failCount++;
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, validItems.length) }, () => worker());
  await Promise.all(workers);

  // 兜底:把没填到的位置补 null
  for (let i = 0; i < results.length; i++) {
    if (!results[i]) results[i] = { id: items[i].id || `item-${i}`, ok: false, error: 'no result' };
  }

  const durationMs = Date.now() - t0;
  const cfg = activeResolved();
  // 统计 batch 里各 provider 的成功次数
  const byProvider = {};
  results.forEach((r, i) => {
    if (!r) return;
    const k = (r.provider || '?') + '/' + (r.model || '?');
    if (!byProvider[k]) byProvider[k] = { ok: 0, fail: 0 };
    if (r.ok) byProvider[k].ok++;
    else byProvider[k].fail++;
  });
  const summary = Object.entries(byProvider)
    .map(([k, v]) => `${k}=${v.ok}/${v.ok + v.fail}`)
    .join(' ');
  console.log(
    `[BATCH] ${durationMs}ms items=${items.length} ok=${successCount} fail=${failCount} conc=${limit} | ${summary}`
  );

  res.json({
    ok: true,
    provider: cfg.llm.provider,
    model: cfg.llm.model,
    mock: shouldUseMock(),
    results,
    successCount,
    failCount,
    durationMs,
  });
});

// ---------- /select-provider ----------
// 支持两种调用:
//   A) 旧式: { provider, apiKey?, baseURL?, model? }  → 直接切到指定 provider
//   B) 新式 fallback 控制: { action: 'next' | 'previous' | 'set' | 'disable' | 'enable' | 'reorder', provider?, chain? }
app.post('/select-provider', (req, res) => {
  const body = req.body || {};

  if (body.action) {
    // 透传所有可能的覆盖字段(让 action=set 能同时切 provider+key+model)
    const r = fallbackControl(body.action, {
      provider: body.provider,
      chain: body.chain,
      apiKey: body.apiKey,
      baseURL: body.baseURL,
      model: body.model,
    });
    if (!r.ok) return res.status(400).json(r);
    const cfg = activeResolved();
    console.log(`[CFG ] action=${body.action} → provider=${cfg.llm.provider}  model=${cfg.llm.model}  baseURL=${cfg.llm.baseURL}  fallbackIndex=${cfg.fallbackIndex}`);
    return res.json({
      ok: true,
      action: body.action,
      provider: cfg.llm.provider,
      model: cfg.llm.model,
      baseURL: cfg.llm.baseURL,
      mock: shouldUseMock(),
      fallbackChain: cfg.fallbackChain,
      fallbackIndex: cfg.fallbackIndex,
      fallbackEnabled: cfg.fallbackEnabled,
    });
  }

  const { provider, apiKey, baseURL, model } = body;
  if (!provider) {
    return res.status(400).json({ ok: false, error: 'provider 必填(或提供 action)' });
  }
  applyOverride({ provider, apiKey, baseURL, model });
  const cfg = activeResolved();
  console.log(`[CFG ] provider -> ${cfg.llm.provider}  model=${cfg.llm.model}  baseURL=${cfg.llm.baseURL}`);
  res.json({
    ok: true,
    provider: cfg.llm.provider,
    model: cfg.llm.model,
    baseURL: cfg.llm.baseURL,
    mock: shouldUseMock(),
    fallbackChain: cfg.fallbackChain,
    fallbackIndex: cfg.fallbackIndex,
    fallbackEnabled: cfg.fallbackEnabled,
  });
});

// ---------- 404 ----------
app.use((req, res) => {
  res.status(404).json({ ok: false, error: `not found: ${req.method} ${req.path}` });
});

const PORT = active.port;
const HOST = '0.0.0.0';
app.listen(PORT, HOST, () => {
  const cfg = activeResolved();
  console.log('============================================================');
  console.log(` Custom Hover Translate — backend`);
  console.log(` Listening on http://${HOST}:${PORT}`);
  console.log(` Default provider: ${cfg.llm.provider}  model=${cfg.llm.model}`);
  console.log(` baseURL: ${cfg.llm.baseURL || '(empty)'}`);
  console.log(` mock mode: ${shouldUseMock() ? 'ON (没配 key,会用 mock 占位)' : 'OFF'}`);
  console.log('============================================================');
});
