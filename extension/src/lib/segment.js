// 段落定位:从 elementFromPoint 出发,向上找最近的 block-level 容器。

const BLOCK_TAGS = new Set([
  'P', 'LI', 'BLOCKQUOTE', 'PRE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'ARTICLE', 'SECTION', 'DD', 'DT', 'FIGCAPTION',
]);

const MAX_DEPTH = 8;

export function walkUpToBlock(el) {
  if (!el) return null;
  let cur = el;
  let depth = 0;
  while (cur && depth < MAX_DEPTH) {
    if (cur.nodeType === 1 && BLOCK_TAGS.has(cur.tagName)) {
      // PRE(代码块)明确跳过
      if (cur.tagName === 'PRE') return null;
      return cur;
    }
    // role=article
    if (cur.nodeType === 1 && cur.getAttribute && cur.getAttribute('role') === 'article') {
      return cur;
    }
    // 跳过我们自己注入的译文框(避免反复包嵌)
    if (cur.nodeType === 1 && cur.classList && cur.classList.contains('ct-target')) {
      return null;
    }
    cur = cur.parentElement;
    depth++;
  }
  return null;
}

export function normalizeText(s) {
  if (!s) return '';
  return s
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractText(el, { minChars = 12, maxChars = 1500 } = {}) {
  if (!el) return '';
  // 忽略纯链接(<a>)里的图标等情况
  let raw = '';
  try {
    raw = (el.innerText || el.textContent || '').toString();
  } catch {
    return '';
  }
  const t = normalizeText(raw);
  if (t.length < minChars) return '';
  if (t.length > maxChars) return t.slice(0, maxChars) + '…';
  return t;
}

// 拿坐标下的 block 容器 + 归一化文本 + 元素引用
export function pickParagraphAt(x, y, opts) {
  // elementFromPoint 会因为 fixed/sticky 元素遮蔽,先试一次
  let el = document.elementFromPoint(x, y);
  if (!el) return null;
  // 如果命中的是我们自己注入的译文框,跳过(意味着指针已在译文上,不应再翻原文)
  if (el.closest && el.closest('.ct-target')) return null;
  const block = walkUpToBlock(el);
  if (!block) return null;
  const text = extractText(block, opts);
  if (!text) return null;
  return { block, text };
}
