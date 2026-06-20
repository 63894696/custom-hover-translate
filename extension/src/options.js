// options.js — 保存设置到 chrome.storage.local + 调 /select-provider 热切

const $ = (id) => document.getElementById(id);
const DEFAULT_ENDPOINT = 'http://127.0.0.1:12308';

async function load() {
  const s = await chrome.storage.local.get([
    'endpoint', 'provider', 'model', 'apiKey', 'baseURL',
    'dstLang', 'minChars', 'maxChars', 'ttlHours',
    'showOriginal',
  ]);
  $('endpoint').value = s.endpoint || DEFAULT_ENDPOINT;
  $('provider').value = s.provider || '';
  $('model').value = s.model || '';
  $('apiKey').value = s.apiKey || '';
  $('baseURL').value = s.baseURL || '';
  $('dstLang').value = s.dstLang || 'zh';
  $('minChars').value = s.minChars || 12;
  $('maxChars').value = s.maxChars || 1500;
  $('ttlHours').value = s.ttlHours || 24;
  $('showOriginal').checked = !!s.showOriginal;
  // 全局自动翻译 + 模式已迁到 popup 主按钮(沉浸式风格),不再有独立设置
}

async function save() {
  const apiKey = $('apiKey').value.trim();
  const baseURL = $('baseURL').value.trim();
  const payload = {
    endpoint: $('endpoint').value.trim() || DEFAULT_ENDPOINT,
    provider: $('provider').value,
    model: $('model').value.trim(),
    dstLang: $('dstLang').value,
    minChars: parseInt($('minChars').value, 10) || 12,
    maxChars: parseInt($('maxChars').value, 10) || 1500,
    ttlHours: parseInt($('ttlHours').value, 10) || 24,
    showOriginal: $('showOriginal').checked,
  };
  // apiKey / baseURL 仅在非空时存 storage(避免空字符串覆盖 .env 默认)
  if (apiKey) payload.apiKey = apiKey;
  if (baseURL) payload.baseURL = baseURL;
  await chrome.storage.local.set(payload);

  // 通知后端热切:仅当显式选了 provider 才切;provider 为空 = "不覆盖,走后端默认",
  // 此时只保存偏好,不调用 /select-provider(后端要求 provider 必填或带 action)。
  let backendInfo = '后端保持默认(未指定 provider)';
  if (payload.provider) {
    try {
      const r = await fetch(`${payload.endpoint}/select-provider`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: payload.provider,
          model: payload.model || undefined,
          apiKey: apiKey || undefined,   // 用户填了就传,后端会覆盖 .env
          baseURL: baseURL || undefined, // custom 模式才需要
        }),
      });
      const data = await r.json();
      if (data && data.ok) {
        backendInfo = `后端已切到 ${data.provider}/${data.model}${data.mock ? ' (mock)' : ''}`;
      } else {
        backendInfo = `后端未响应: ${(data && data.error) || '?'}`;
      }
    } catch (e) {
      backendInfo = `后端不可达: ${(e && e.message) || e}`;
    }
  }

  $('msg').textContent = `已保存 · ${backendInfo}`;
  setTimeout(() => { $('msg').textContent = ''; }, 5000);
}

async function reset() {
  await chrome.storage.local.clear();
  await load();
  $('msg').textContent = '已恢复默认';
  setTimeout(() => { $('msg').textContent = ''; }, 3000);
}

document.getElementById('save').addEventListener('click', save);
document.getElementById('reset').addEventListener('click', reset);
document.addEventListener('DOMContentLoaded', load);
