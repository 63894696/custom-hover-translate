// options.js — 保存设置到 chrome.storage.local(重构:去强制后端,引擎中立)

const $ = (id) => document.getElementById(id);

async function load() {
  const s = await chrome.storage.local.get([
    'engine', 'baseURL', 'model', 'apiKey', 'endpoint',
    'dstLang', 'minChars', 'maxChars', 'ttlHours', 'showOriginal',
  ]);
  const eng = s.engine || 'auto';
  const r = document.querySelector(`input[name="engine"][value="${eng}"]`);
  if (r) r.checked = true;
  $('baseURL').value = s.baseURL || '';
  $('model').value = s.model || '';
  $('apiKey').value = s.apiKey || '';
  $('endpoint').value = s.endpoint || '';
  $('dstLang').value = s.dstLang || 'zh';
  $('minChars').value = s.minChars || 12;
  $('maxChars').value = s.maxChars || 1500;
  $('ttlHours').value = s.ttlHours || 24;
  $('showOriginal').checked = !!s.showOriginal;
  toggleFieldsets();
}

function toggleFieldsets() {
  const eng = document.querySelector('input[name="engine"]:checked')?.value || 'auto';
  $('custom-fieldset').style.display = eng === 'openai_compat' ? '' : 'none';
  $('backend-fieldset').style.display = eng === 'local_backend' ? '' : 'none';
}
document.querySelectorAll('input[name="engine"]').forEach((r) => r.addEventListener('change', toggleFieldsets));

async function save() {
  const engine = document.querySelector('input[name="engine"]:checked')?.value || 'auto';
  const payload = {
    engine,
    dstLang: $('dstLang').value,
    minChars: parseInt($('minChars').value, 10) || 12,
    maxChars: parseInt($('maxChars').value, 10) || 1500,
    ttlHours: parseInt($('ttlHours').value, 10) || 24,
    showOriginal: $('showOriginal').checked,
  };
  // 端点/key 仅非空时存(避免空串覆盖)
  const baseURL = $('baseURL').value.trim();
  const model = $('model').value.trim();
  const apiKey = $('apiKey').value.trim();
  const endpoint = $('endpoint').value.trim();
  if (baseURL) payload.baseURL = baseURL;
  if (model) payload.model = model;
  if (apiKey) payload.apiKey = apiKey;
  if (endpoint) payload.endpoint = endpoint;

  await chrome.storage.local.set(payload);

  // 保存后重新检测引擎就绪状态(给一句人话反馈)
  let info = '已保存';
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'health' });
    const d = resp && resp.data;
    if (d && d.ok) info = `已保存 · ${d.engine || '引擎就绪'}`;
    else if (d && d.needConfig) info = '已保存 · 当前网络需配置自定义端点才能翻译';
  } catch {}

  $('msg').textContent = info;
  setTimeout(() => { $('msg').textContent = ''; }, 5000);
}

async function reset() {
  await chrome.storage.local.clear();
  // 恢复后默认 engine=auto
  await chrome.storage.local.set({ engine: 'auto', dstLang: 'zh', enabled: true });
  await load();
  $('msg').textContent = '已恢复默认(自动模式)';
  setTimeout(() => { $('msg').textContent = ''; }, 3000);
}

document.getElementById('save').addEventListener('click', save);
document.getElementById('reset').addEventListener('click', reset);

// 拉取模型列表(用用户填的 URL+Key 查其端点,免手输模型名)
document.getElementById('fetch-models').addEventListener('click', async () => {
  const btn = $('fetch-models');
  const hint = $('fetch-models-hint');
  const baseURL = $('baseURL').value.trim();
  const apiKey = $('apiKey').value.trim();
  if (!baseURL) {
    hint.textContent = '请先填 API Base URL,再拉取模型列表。';
    $('baseURL').focus();
    return;
  }
  btn.disabled = true;
  btn.textContent = '拉取中…';
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'list-models', baseURL, apiKey });
    if (resp && resp.ok && resp.models && resp.models.length) {
      const dl = $('model-list');
      dl.innerHTML = '';
      resp.models.forEach((m) => {
        const o = document.createElement('option');
        o.value = m;
        dl.appendChild(o);
      });
      hint.textContent = `已拉取 ${resp.models.length} 个模型,点模型输入框从下拉选择。`;
      if (!$('model').value.trim()) $('model').value = resp.models[0];
      $('model').focus();
    } else {
      const err = (resp && resp.error) || 'unknown';
      hint.textContent = err === 'empty'
        ? '端点返回了空列表——可能不支持 /models,请手输模型名。'
        : `拉取失败(${err})。可改用手输模型名。`;
    }
  } catch (e) {
    hint.textContent = `拉取失败:${(e && e.message) || e}`;
  } finally {
    btn.disabled = false;
    btn.textContent = '拉取模型列表';
  }
});

document.addEventListener('DOMContentLoaded', load);
