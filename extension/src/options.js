// options.js — 保存设置到 chrome.storage.local(重构:去强制后端,引擎中立)

const $ = (id) => document.getElementById(id);

async function load() {
  const s = await chrome.storage.local.get([
    'engine', 'baseURL', 'model', 'apiKey', 'endpoint',
    'dstLang', 'minChars', 'maxChars', 'ttlHours', 'showOriginal',
    'promptRole', 'termsText', 'temperature', 'concurrency',
  ]);
  const eng = s.engine || 'auto';
  const r = document.querySelector(`input[name="engine"][value="${eng}"]`);
  if (r) r.checked = true;
  $('baseURL').value = s.baseURL || '';
  $('model').value = s.model || '';
  $('apiKey').value = s.apiKey || '';
  $('endpoint').value = s.endpoint || '';
  CT_LANGS.fillLangSelect($('dstLang'));
  $('dstLang').value = s.dstLang || CT_LANGS.guessTargetLang();
  $('minChars').value = s.minChars || 12;
  $('maxChars').value = s.maxChars || 1500;
  $('ttlHours').value = s.ttlHours || 24;
  $('showOriginal').checked = !!s.showOriginal;
  // D 步:角色 / 术语 / 温度 / 并发
  fillRoleSelect($('promptRole'));
  $('promptRole').value = s.promptRole || 'general';
  updateRoleDesc();
  $('termsText').value = s.termsText || '';
  $('temperature').value = (s.temperature != null) ? s.temperature : 0.2;
  $('concurrency').value = s.concurrency || 6;
  toggleFieldsets();
}

// 填充角色下拉(来自 prompts.js 的预设表)
function fillRoleSelect(sel) {
  const roles = (self.CT_PROMPTS && self.CT_PROMPTS.ROLES) || [];
  sel.innerHTML = '';
  roles.forEach((ro) => {
    const o = document.createElement('option');
    o.value = ro.id;
    o.textContent = ro.name;
    sel.appendChild(o);
  });
}
function updateRoleDesc() {
  const role = self.CT_PROMPTS && self.CT_PROMPTS.getRole ? self.CT_PROMPTS.getRole($('promptRole').value) : null;
  $('role-desc').textContent = role
    ? `${role.desc}。同一台模型,换个角色得到面向不同场景的译文(google_gtx 内置翻译无此概念)。`
    : '同一台模型,换个角色得到面向不同场景的译文。';
}

function toggleFieldsets() {
  const eng = document.querySelector('input[name="engine"]:checked')?.value || 'auto';
  const isCustom = eng === 'openai_compat';
  $('custom-fieldset').style.display = isCustom ? '' : 'none';
  $('role-fieldset').style.display = isCustom ? '' : 'none';
  $('backend-fieldset').style.display = eng === 'local_backend' ? '' : 'none';
}
document.querySelectorAll('input[name="engine"]').forEach((r) => r.addEventListener('change', toggleFieldsets));
document.addEventListener('change', (e) => { if (e.target && e.target.id === 'promptRole') updateRoleDesc(); });

async function save() {
  const engine = document.querySelector('input[name="engine"]:checked')?.value || 'auto';
  const payload = {
    engine,
    dstLang: $('dstLang').value,
    minChars: parseInt($('minChars').value, 10) || 12,
    maxChars: parseInt($('maxChars').value, 10) || 1500,
    ttlHours: parseInt($('ttlHours').value, 10) || 24,
    showOriginal: $('showOriginal').checked,
    promptRole: $('promptRole').value || 'general',
    termsText: $('termsText').value,
    temperature: Math.max(0, Math.min(2, parseFloat($('temperature').value) || 0)),
    concurrency: Math.max(1, Math.min(20, parseInt($('concurrency').value, 10) || 6)),
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
  await chrome.storage.local.set({ engine: 'auto', dstLang: CT_LANGS.guessTargetLang(), enabled: true });
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

// D 步:测试服务 — 用当前表单里填的(未保存也行)端点+Key+模型发一条 "Hello",
// 显示"✓ 模型 · 耗时"或具体错误,帮用户确认配置配对。
document.getElementById('test-service').addEventListener('click', async () => {
  const btn = $('test-service');
  const out = $('test-service-result');
  const baseURL = $('baseURL').value.trim();
  const apiKey = $('apiKey').value.trim();
  const model = $('model').value.trim();
  if (!baseURL || !model) {
    out.textContent = '请先填 API Base URL 和模型名。';
    out.style.color = '#c0392b';
    return;
  }
  btn.disabled = true;
  btn.textContent = '测试中…';
  out.textContent = '';
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'test-service', baseURL, apiKey, model });
    if (resp && resp.ok) {
      out.textContent = `✓ 通了 · ${resp.model} · ${resp.durationMs}ms${resp.sample ? ` · 回包:${resp.sample}` : ''}`;
      out.style.color = '#1e8449';
    } else {
      out.textContent = `✗ ${(resp && resp.error) || '失败'}${resp && resp.httpStatus ? ` (HTTP ${resp.httpStatus})` : ''}`;
      out.style.color = '#c0392b';
    }
  } catch (e) {
    out.textContent = `✗ 通信失败:${(e && e.message) || e}`;
    out.style.color = '#c0392b';
  } finally {
    btn.disabled = false;
    btn.textContent = '测试服务';
    setTimeout(() => { out.textContent = ''; }, 8000);
  }
});
