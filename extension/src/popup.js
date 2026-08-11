// popup.js — 三档简 UI:零配置默认 / 一个开关 / 高级折叠
// 重构 2026-08-11:去强制后端,状态人话化,引擎选择收进高级设置。

const $ = (id) => document.getElementById(id);

// 向当前 tab 发消息;若 content script 未注入,自动注入后重试一次。
async function sendToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (e) {
    const msg = String((e && e.message) || e);
    const noListener = /Receiving end does not exist|Could not establish connection/i.test(msg);
    if (!noListener) throw e;
    await chrome.scripting.executeScript({ target: { tabId }, files: ['src/content.js'] });
    try { await chrome.scripting.insertCSS({ target: { tabId }, files: ['src/inject.css'] }); } catch {}
    await new Promise((r) => setTimeout(r, 50));
    return await chrome.tabs.sendMessage(tabId, message);
  }
}

function setLed(state, label, meta) {
  const led = $('led');
  led.classList.remove('ok', 'err', 'warn');
  if (state) led.classList.add(state);
  $('status-line').textContent = label;
  $('status-meta').textContent = meta || '';
}

function setHeroStatus(text) {
  $('hero-status').textContent = text || '';
}

// 状态区右侧的可操作按钮(人话化引导)
function setStatusAction(btn) {
  const wrap = $('status-action');
  wrap.innerHTML = '';
  if (!btn) return;
  const b = document.createElement('button');
  b.className = 'action-btn';
  b.textContent = btn.label;
  b.addEventListener('click', btn.onClick);
  wrap.appendChild(b);
}

// ---------- 引擎就绪状态(人话化) ----------
async function checkStatus() {
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'health' });
    const d = resp && resp.data;
    if (resp && resp.ok && d && d.ok) {
      setLed('ok', `● 就绪`, d.engine || '');
      setStatusAction(null);
      return { ok: true };
    }
    if (d && d.needConfig) {
      setLed('warn', '● 需配置', d.hint || '当前网络连不上内置翻译');
      setStatusAction({
        label: '去配置',
        onClick: () => {
          $('advanced').open = true;
          const r = document.querySelector('input[name="engine"][value="openai_compat"]');
          if (r) r.checked = true;
          toggleAdvGroups();
          $('baseURL').focus();
        },
      });
      return { ok: false };
    }
    setLed('err', '● 未就绪', (d && d.hint) || (resp && resp.error) || '请检查网络');
    setStatusAction({ label: '重新检测', onClick: redetect });
    return { ok: false };
  } catch (e) {
    setLed('err', '● 检测失败', String((e && e.message) || e));
    setStatusAction({ label: '重新检测', onClick: redetect });
    return { ok: false };
  }
}

async function redetect() {
  setLed('', '检测中…', '');
  try {
    await chrome.runtime.sendMessage({ type: 'redetect-engine' });
  } catch {}
  await checkStatus();
}

// ---------- 一档:翻译此页 ----------
async function runTranslate() {
  const mode = document.querySelector('input[name="mode"]:checked')?.value || 'bilingual';
  const btn = $('translate-all');
  btn.disabled = true;
  btn.textContent = '翻译中…';
  setHeroStatus('扫描页面段落…');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || tab.id == null) { setHeroStatus('找不到当前标签页'); return; }
    await chrome.storage.local.set({ activeMode: mode });
    const msgType = mode === 'replace' ? 'replace-all' : 'translate-all';
    const resp = await sendToTab(tab.id, { type: msgType });
    if (!resp) {
      setHeroStatus('扩展未能在当前页面运行(某些页面如 chrome:// 不支持)');
    } else if (resp.needConfig) {
      setHeroStatus('需要先配置翻译服务。请展开「高级设置」填入端点和 Key。');
      $('advanced').open = true;
    } else if (!resp.ok) {
      setHeroStatus(`翻译失败:${resp.error || '未知原因'}`);
    } else if (resp.total === 0) {
      setHeroStatus(resp.message || '页面没有需要翻译的段落(可能已是中文)');
    } else {
      setHeroStatus(`已翻译 ${resp.success}/${resp.total} 段${resp.fail ? ` · ${resp.fail} 段失败` : ''} · 后续新内容自动跟进`);
    }
  } catch (e) {
    setHeroStatus(`通信失败:${(e && e.message) || e}`);
  } finally {
    btn.disabled = false;
    btn.textContent = '翻译此页';
  }
}

$('translate-all').addEventListener('click', runTranslate);

// ---------- 还原 ----------
$('remove-all').addEventListener('click', async () => {
  const btn = $('remove-all');
  btn.disabled = true;
  try {
    await chrome.storage.local.set({ activeMode: null });
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id != null) {
      const resp = await sendToTab(tab.id, { type: 'remove-all' });
      setHeroStatus(resp && resp.removed ? `已还原 ${resp.removed} 段` : '已还原');
    }
  } catch (e) {
    setHeroStatus(`还原失败:${(e && e.message) || e}`);
  } finally {
    btn.disabled = false;
  }
});

// ---------- 目标语言 ----------
$('dstLang').addEventListener('change', async (e) => {
  await chrome.storage.local.set({ dstLang: e.target.value });
});

// ---------- 三档:高级设置 ----------
function toggleAdvGroups() {
  const eng = document.querySelector('input[name="engine"]:checked')?.value || 'auto';
  $('custom-config').style.display = eng === 'openai_compat' ? '' : 'none';
  $('backend-config').style.display = eng === 'local_backend' ? '' : 'none';
}
document.querySelectorAll('input[name="engine"]').forEach((r) => r.addEventListener('change', toggleAdvGroups));

$('save-adv').addEventListener('click', async () => {
  const engine = document.querySelector('input[name="engine"]:checked')?.value || 'auto';
  const mode = document.querySelector('input[name="mode"]:checked')?.value || 'bilingual';
  const payload = { engine, activeMode: mode };
  const baseURL = $('baseURL').value.trim();
  const model = $('model').value.trim();
  const apiKey = $('apiKey').value.trim();
  const endpoint = $('endpoint').value.trim();
  if (baseURL) payload.baseURL = baseURL;
  if (model) payload.model = model;
  if (apiKey) payload.apiKey = apiKey;
  if (endpoint) payload.endpoint = endpoint;
  await chrome.storage.local.set(payload);
  $('adv-msg').textContent = '已保存';
  setTimeout(() => { $('adv-msg').textContent = ''; }, 3000);
  await checkStatus();
});

$('redetect').addEventListener('click', redetect);

// ---------- 拉取模型列表(用用户填的 URL+Key 查其端点,免手输模型名) ----------
$('fetch-models').addEventListener('click', async () => {
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
  hint.textContent = '正在向你的端点查询模型列表…';
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
      // 若当前 model 为空,自动填第一个
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

// 评测科普页链接(占位 URL,落地后替换)
$('open-leaderboard').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: 'https://prisir.example.com/translate-models' }); // TODO: 替换为真实评测页
});

$('open-options').addEventListener('click', () => chrome.runtime.openOptionsPage());

// 监听 content script 的进度消息
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg) return;
  if (msg.type === 'progress') setHeroStatus(msg.msg || '翻译中…');
});

// ---------- 初始化 ----------
document.addEventListener('DOMContentLoaded', async () => {
  const s = await chrome.storage.local.get(['dstLang', 'engine', 'activeMode', 'baseURL', 'model', 'apiKey', 'endpoint']);
  if (s.dstLang) $('dstLang').value = s.dstLang;
  const eng = s.engine || 'auto';
  const er = document.querySelector(`input[name="engine"][value="${eng}"]`);
  if (er) er.checked = true;
  const mode = s.activeMode || 'bilingual';
  const mr = document.querySelector(`input[name="mode"][value="${mode}"]`);
  if (mr) mr.checked = true;
  $('baseURL').value = s.baseURL || '';
  $('model').value = s.model || '';
  $('apiKey').value = s.apiKey || '';
  $('endpoint').value = s.endpoint || '';
  toggleAdvGroups();
  await checkStatus();
});
