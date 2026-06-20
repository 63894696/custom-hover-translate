// 渲染工具:在段落 block 元素后注入 <div class="ct-target">。

const SEL = '.ct-target';

export function findExisting(block, key) {
  // block 之后的紧邻 .ct-target 且 key 一致 → 命中
  let n = block.nextElementSibling;
  while (n && n.classList && n.classList.contains('ct-original-wrap')) {
    n = n.nextElementSibling;
  }
  if (n && n.classList && n.classList.contains('ct-target') && n.dataset.ctKey === key) {
    return n;
  }
  return null;
}

export function createPending(key) {
  const el = document.createElement('div');
  el.className = 'ct-target ct-pending';
  el.dataset.ctKey = key;
  el.setAttribute('role', 'status');
  el.textContent = '译文中…';
  return el;
}

export function createTranslated(key, text, { showOriginal = false, originalText = '' } = {}) {
  const el = document.createElement('div');
  el.className = 'ct-target ct-done';
  el.dataset.ctKey = key;
  if (showOriginal && originalText) {
    const o = document.createElement('div');
    o.className = 'ct-original';
    o.textContent = originalText.length > 120 ? originalText.slice(0, 120) + '…' : originalText;
    el.appendChild(o);
  }
  const t = document.createElement('div');
  t.className = 'ct-translation';
  t.textContent = text;
  el.appendChild(t);
  return el;
}

export function createError(key, message, onRetry) {
  const el = document.createElement('div');
  el.className = 'ct-target ct-error';
  el.dataset.ctKey = key;
  const msg = document.createElement('span');
  msg.textContent = message;
  el.appendChild(msg);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = '重试';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    onRetry && onRetry();
  });
  el.appendChild(btn);
  return el;
}

export function replaceNode(oldEl, newEl) {
  if (oldEl && oldEl.parentNode) {
    oldEl.parentNode.replaceChild(newEl, oldEl);
    return newEl;
  }
  return null;
}

// 清理孤儿译文框(block 已不在 DOM 里的)
export function cleanupOrphans(root = document) {
  const nodes = root.querySelectorAll(SEL);
  let removed = 0;
  for (const n of nodes) {
    const prev = n.previousElementSibling;
    // 译文框的上一兄弟应该是原文 block;若 block 已不在 DOM,移除
    if (!prev || (prev.classList && prev.classList.contains('ct-target'))) {
      // 上一兄弟也是 ct-target(连续多块译文),保留直到遍历结束统一回收
      continue;
    }
    if (!document.body.contains(prev) && prev.dataset.ctAnchor !== '1') {
      n.remove();
      removed++;
    }
  }
  return removed;
}
