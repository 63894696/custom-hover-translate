// popup.js — 核心:整页双语按钮 + 状态灯 + provider 切换 + 复制启动命令 + 清缓存
// 不使用 ES module(popup script 默认就是普通脚本)

const $ = (id) => document.getElementById(id);

const DEFAULT_ENDPOINT = 'http://127.0.0.1:12308';

// 向当前 tab 发消息;若 content script 未注入(页面先于扩展加载 / 注入失败),
// 自动用 chrome.scripting 注入 content.js + inject.css 后重试一次。
// 解决 "Could not establish connection. Receiving end does not exist."
async function sendToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (e) {
    const msg = String((e && e.message) || e);
    const noListener = /Receiving end does not exist|Could not establish connection/i.test(msg);
    if (!noListener) throw e;
    // 注入并重试
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['src/content.js'],
    });
    try {
      await chrome.scripting.insertCSS({ target: { tabId }, files: ['src/inject.css'] });
    } catch { /* CSS 注入失败不阻塞翻译 */ }
    // content.js init() 是同步执行的,但保险起见微延迟后重试
    await new Promise((r) => setTimeout(r, 50));
    return await chrome.tabs.sendMessage(tabId, message);
  }
}

function setLed(state, label, meta) {
  const led = $('led');
  led.classList.remove('ok', 'err');
  if (state === 'ok') led.classList.add('ok');
  else if (state === 'err') led.classList.add('err');
  $('status-line').textContent = label;
  $('status-meta').textContent = meta || '';
}

function setHeroStatus(text) {
  $('hero-status').textContent = text || '';
}

async function checkHealth() {
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'health' });
    if (resp && resp.ok && resp.data) {
      const d = resp.data;
      setLed('ok', '后端在线', `${d.provider} / ${d.model}${d.mock ? ' (mock)' : ''}`);
      return { ok: true, provider: d.provider, model: d.model };
    } else {
      setLed('err', '后端不可达', (resp && resp.error) || '请检查后端是否启动');
      return { ok: false };
    }
  } catch (e) {
    setLed('err', '健康检查失败', String((e && e.message) || e));
    return { ok: false };
  }
}

async function loadProvidersAndSettings() {
  // 优先从后端拉 provider 列表,失败则用本地默认
  let list = null;
  try {
    const r = await fetch(`${DEFAULT_ENDPOINT}/providers`);
    const data = await r.json();
    if (data && data.ok && Array.isArray(data.providers)) list = data.providers;
  } catch (e) { /* 后端可能没起,继续用本地 */ }

  const sel = $('provider');
  sel.innerHTML = '';
  if (list) {
    for (const p of list) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.label;
      sel.appendChild(opt);
    }
    // 把 altModels 放到 datalist,model 输入框可自动补全
    const dl = document.createElement('datalist');
    dl.id = 'altModelsList';
    for (const p of list) {
      for (const m of (p.altModels || [])) {
        const o = document.createElement('option');
        o.value = m;
        dl.appendChild(o);
      }
    }
    sel.parentNode.appendChild(dl);
    $('model').setAttribute('list', 'altModelsList');
  } else {
    sel.innerHTML = '<option value="bailian">bailian (qwen-turbo)</option><option value="doubao">doubao</option><option value="openrouter">openrouter</option>';
  }

  const s = await chrome.storage.local.get(['provider', 'model']);
  if (s.provider) sel.value = s.provider;
  if (s.model) $('model').value = s.model;
}

async function loadSettings() {
  await loadProvidersAndSettings();
}

// 通用:跑整页翻译并设置 activeMode(全局跟踪)
async function runTranslate(mode /* 'bilingual' | 'replace' */) {
  const btnId = mode === 'replace' ? 'replace-all' : 'translate-all';
  const btn = $(btnId);
  btn.disabled = true;
  btn.textContent = '翻译中…';
  setHeroStatus('扫描页面段落…');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || tab.id == null) {
      setHeroStatus('找不到当前标签页');
      return;
    }
    // 写 activeMode(让 observer/SPA 后续跟进这个模式)
    await chrome.storage.local.set({ activeMode: mode });
    const msgType = mode === 'replace' ? 'replace-all' : 'translate-all';
    const resp = await sendToTab(tab.id, { type: msgType });
    if (!resp) {
      setHeroStatus('content script 未响应(扩展是否在当前页面加载?)');
    } else if (!resp.ok) {
      setHeroStatus(`失败: ${resp.error || '?'}`);
    } else if (resp.total === 0) {
      setHeroStatus(resp.message || '页面没有需要翻译的段落');
    } else {
      const label = mode === 'replace' ? '已替换' : '已扫描';
      setHeroStatus(
        `${label} ${resp.total} 段 · 成功 ${resp.success} · 失败 ${resp.fail}` +
        (resp.provider ? ` · ${resp.provider}/${resp.model}` : '') +
        (resp.durationMs ? ` · ${resp.durationMs}ms · 当前模式已记为"${mode === 'replace' ? '仅译文' : '双语对照'}",新页面/FAQ/SPA 自动跟进` : '')
      );
    }
  } catch (e) {
    setHeroStatus(`通信失败: ${(e && e.message) || e}`);
  } finally {
    btn.disabled = false;
    btn.textContent = mode === 'replace' ? '整页仅译文' : '整页双语对照';
  }
}

$('translate-all').addEventListener('click', () => runTranslate('bilingual'));
$('replace-all').addEventListener('click', () => runTranslate('replace'));

// 切换:双语 ↔ 仅译文(沉浸式风格:一键转换,自动 removeAll + 跑新模式)
$('toggle-mode').addEventListener('click', async () => {
  const btn = $('toggle-mode');
  btn.disabled = true;
  setHeroStatus('切换模式中…');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || tab.id == null) {
      setHeroStatus('找不到当前标签页');
      return;
    }
    // 读当前 activeMode(默认 bilingual),切到另一档
    const cur = (await chrome.storage.local.get('activeMode')).activeMode || 'bilingual';
    const next = cur === 'bilingual' ? 'replace' : 'bilingual';
    // 先清旧译文,再写新模式 + 跑
    await sendToTab(tab.id, { type: 'remove-all' });
    await chrome.storage.local.set({ activeMode: next });
    const msgType = next === 'replace' ? 'replace-all' : 'translate-all';
    const resp = await sendToTab(tab.id, { type: msgType });
    if (!resp) {
      setHeroStatus('content script 未响应');
    } else if (!resp.ok) {
      setHeroStatus(`失败: ${resp.error || '?'}`);
    } else {
      const label = next === 'replace' ? '仅译文' : '双语对照';
      setHeroStatus(`已切换到「${label}」模式 · ${resp.success}/${resp.total} 段成功 · 后续自动跟进`);
    }
  } catch (e) {
    setHeroStatus(`切换失败: ${(e && e.message) || e}`);
  } finally {
    btn.disabled = false;
  }
});

$('remove-all').addEventListener('click', async () => {
  const btn = $('remove-all');
  btn.disabled = true;
  try {
    // 清全局跟踪(用户"我不要翻译"语义)
    await chrome.storage.local.set({ activeMode: null });
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id != null) {
      const resp = await sendToTab(tab.id, { type: 'remove-all' });
      setHeroStatus(resp && resp.removed ? `已移除 ${resp.removed} 个译文,已停用全局跟踪` : '已清除,已停用全局跟踪');
    }
  } catch (e) {
    setHeroStatus(`清除失败: ${(e && e.message) || e}`);
  } finally {
    btn.disabled = false;
  }
});

$('apply').addEventListener('click', async () => {
  const provider = $('provider').value;
  const model = $('model').value.trim();
  await chrome.storage.local.set({ provider, model });

  // provider 为空 = "不覆盖,走后端默认":只保存偏好,不调用 /select-provider
  // (后端要求 provider 必填或带 action;空 body 会被拒)。
  if (!provider) {
    setLed('ok', '已保存', '后端保持默认(provider 未指定)');
    setHeroStatus('偏好已保存,后端走默认。要切 provider 请在上方下拉选一个');
    return;
  }

  try {
    const r = await fetch(`${DEFAULT_ENDPOINT}/select-provider`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, model: model || undefined }),
    });
    const data = await r.json();
    if (data.ok) {
      setLed('ok', '已切换', `${data.provider} / ${data.model}${data.mock ? ' (mock)' : ''}`);
      setHeroStatus(`已切到 ${data.provider}/${data.model},可以点 "整页双语对照" 实测翻译质量`);
      // 刷新 fallback 链 UI
      await renderFallback(data);
    } else {
      setLed('err', '切换失败', data.error || '');
    }
  } catch (e) {
    setLed('err', '后端不可达', '请确认后端进程在跑');
  }
});

// ============ Fallback 链 UI ============

// 把 /health 返回的 fallbackChain / fallbackIndex / fallbackEnabled 渲染成 chips
function renderFallbackChainUI({ fallbackChain, fallbackIndex, fallbackEnabled }) {
  const wrap = $('fb-chain');
  wrap.innerHTML = '';
  if (!Array.isArray(fallbackChain) || !fallbackChain.length) {
    wrap.textContent = '(未配置 fallback chain)';
    return;
  }
  fallbackChain.forEach((id, i) => {
    const chip = document.createElement('span');
    chip.className = 'fb-chip' + (i === fallbackIndex ? ' active' : '');
    if (!fallbackEnabled) chip.classList.add('disabled');
    chip.textContent = `${i + 1}. ${id}`;
    if (i === fallbackIndex) chip.title = '当前生效档位';
    wrap.appendChild(chip);
  });
  $('fb-enabled').checked = !!fallbackEnabled;
}

async function fetchHealth() {
  try {
    const r = await fetch(`${DEFAULT_ENDPOINT}/health`);
    return await r.json();
  } catch (e) {
    return null;
  }
}

async function renderFallback(initialData) {
  const data = initialData || (await fetchHealth());
  if (!data) {
    $('fb-chain').textContent = '后端不可达,无法显示 fallback 链';
    $('fb-last').textContent = '';
    return;
  }
  renderFallbackChainUI({
    fallbackChain: data.fallbackChain,
    fallbackIndex: data.fallbackIndex,
    fallbackEnabled: data.fallbackEnabled,
  });
}

async function fallbackAction(action) {
  let body = { action };
  if (action === 'next') body.action = 'next';
  if (action === 'previous') body.action = 'previous';
  if (action === 'toggle') {
    // 先读当前 enabled,决定 enable 还是 disable
    const h = await fetchHealth();
    body.action = h && h.fallbackEnabled ? 'disable' : 'enable';
  }
  try {
    const r = await fetch(`${DEFAULT_ENDPOINT}/select-provider`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (data.ok) {
      await renderFallback(data);
      setHeroStatus(`已切到 ${data.provider}/${data.model}`);
      // 同步给 popup 的 provider/model 下拉
      $('provider').value = data.provider;
      $('model').value = data.model;
    } else {
      setHeroStatus(`切换失败: ${data.error || '?'}`);
    }
  } catch (e) {
    setHeroStatus(`切换失败: ${(e && e.message) || e}`);
  }
}

$('fb-next').addEventListener('click', () => fallbackAction('next'));
$('fb-prev').addEventListener('click', () => fallbackAction('previous'));
$('fb-enabled').addEventListener('change', (e) => fallbackAction('toggle'));

// 监听 content script 发来的"最近一次翻译"消息,更新 last 信息
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg) return;
  if (msg.type === 'last-used') {
    $('fb-last').textContent =
      `最近翻译: ${msg.summary || `${msg.provider}/${msg.model} ×1`}` +
      ` · 成功 ${msg.success} / 失败 ${msg.fail} / 共 ${msg.total}` +
      (msg.fallbackUsed ? ' (已自动 fallback)' : '') +
      (msg.durationMs ? ` · ${msg.durationMs}ms` : '');
  }
  if (msg.type === 'progress') {
    setHeroStatus(msg.msg || '翻译中…');
  }
});

$('copy-cmd').addEventListener('click', async () => {
  const cmd = `cd "%USERPROFILE%\\Documents\\Projects\\VideoNotesPro\\src\\translate-extension\\backend" && npm start`;
  try {
    await navigator.clipboard.writeText(cmd);
    $('last-info').textContent = '启动命令已复制到剪贴板,到终端粘贴执行';
  } catch (e) {
    $('last-info').textContent = cmd;
  }
});

$('open-options').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

// 翻译 PDF / 文档:在新标签打开 pdftranslator.org
// (该站只有网页版无 API,直接跳转让用户用其专业界面)
$('open-pdf-translator').addEventListener('click', async () => {
  try {
    await chrome.tabs.create({ url: 'https://pdftranslator.org/zh' });
    window.close(); // 关闭 popup,行为更原生
  } catch (e) {
    setHeroStatus('打开失败:' + (e && e.message || e));
  }
});

$('clear-cache').addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id != null) {
      await sendToTab(tab.id, { type: 'clear-cache' });
    }
    $('last-info').textContent = '已清空当前页缓存';
  } catch (e) {
    $('last-info').textContent = `清缓存失败: ${(e && e.message) || e}`;
  }
});

document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  const h = await checkHealth();
  if (h && h.ok) {
    // 把 health 的 fallback 信息直接灌给 UI
    await renderFallback(h.data);
  }
});
