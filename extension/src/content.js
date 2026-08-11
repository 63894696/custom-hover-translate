// content.js — 页面端核心逻辑(自包含,无 ES module import,MV3 content script 不能 type=module)
//
// 触发模式:
//   A) 一键全页双语/仅译文(popup 大按钮触发 → 'translate-all'/'replace-all'):
//        扫描页面所有 block → 并发批量调 /translate/batch → 文本节点级注入译文
//   B) 全局自动跟踪:Observer 听 childList + attributes + characterData,
//      新内容(FAQ 展开/菜单弹出/SPA 路由)自动跟进翻译
//   C) 右键菜单兜底:用户选中文本 → contextMenu → content.js 翻译 → 通知
//
// 共享:LRU 缓存、appendBilingual/setMainText/restoreBlock、沉浸式 1.30.2 规则(已集成)

(() => {
  const DEFAULT_ENDPOINT = 'http://127.0.0.1:12308';
  // 自身注入译文时置 true,MutationObserver 据此忽略,防"注入→触发→重扫→再注入"雪崩。
  // 声明在 IIFE 顶部,供 appendBilingual/setMainText/ensureObserver 共用。
  let selfInjecting = false;
  // ============ LRU + cyrb32(内联自 lib/lru.js) ============
  class LRU {
    constructor({ max = 400, ttlMs = 24 * 3600 * 1000 } = {}) {
      this.max = max;
      this.ttlMs = ttlMs;
      this.m = new Map();
    }
    get(key) {
      const hit = this.m.get(key);
      if (!hit) return undefined;
      if (hit.exp < Date.now()) {
        this.m.delete(key);
        return undefined;
      }
      this.m.delete(key);
      this.m.set(key, hit);
      return hit.value;
    }
    set(key, value, ttlMs) {
      const t = typeof ttlMs === 'number' ? ttlMs : this.ttlMs;
      if (this.m.has(key)) this.m.delete(key);
      this.m.set(key, { value, exp: Date.now() + t });
      while (this.m.size > this.max) {
        const first = this.m.keys().next().value;
        this.m.delete(first);
      }
    }
    clear() {
      this.m.clear();
    }
    get size() {
      return this.m.size;
    }
  }
  function cyrb32(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
      h = (h * 33) ^ str.charCodeAt(i);
    }
    return (h >>> 0).toString(16);
  }

  // ============ langdetect ============
  const HINT_RANGES = [
    { re: /[぀-ヿㇰ-ㇿ]/, tag: 'ja' },
    { re: /[가-힯]/, tag: 'ko' },
    { re: /[Ѐ-ӿ]/, tag: 'ru' },
    { re: /[؀-ۿ]/, tag: 'ar' },
    { re: /[一-鿿]/, tag: 'zh' },
    { re: /[A-Za-z]/, tag: 'en' },
  ];
  function detectLang(text) {
    if (!text) return { tag: 'und' };
    for (const r of HINT_RANGES) {
      if (r.re.test(text)) return { tag: r.tag };
    }
    return { tag: 'und' };
  }
  function isChinese(text) {
    if (!text) return false;
    const sample = text.slice(0, 200);
    let cjk = 0;
    let other = 0;
    let total = 0;
    for (const ch of sample) {
      total++;
      if (/[一-鿿]/.test(ch)) cjk++;
      if (
        /[぀-ヿㇰ-ㇿ]/.test(ch) ||
        /[가-힯]/.test(ch) ||
        /[A-Za-z]/.test(ch) ||
        /[0-9]/.test(ch) ||
        /[Ѐ-ӿ]/.test(ch) ||
        /[؀-ۿ]/.test(ch)
      ) {
        other++;
      }
    }
    return total > 0 && other === 0 && cjk / total >= 0.9;
  }

  // ============ segment ============
  const BLOCK_TAGS = new Set([
    'P', 'LI', 'BLOCKQUOTE', 'PRE', 'CODE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'ARTICLE', 'SECTION', 'DD', 'DT', 'FIGCAPTION',
  ]);
  function walkUpToBlock(el) {
    if (!el) return null;
    let cur = el;
    let depth = 0;
    while (cur && depth < 8) {
      if (cur.nodeType === 1 && BLOCK_TAGS.has(cur.tagName)) {
        if (cur.tagName === 'PRE') return null;
        return cur;
      }
      if (cur.nodeType === 1 && cur.getAttribute && cur.getAttribute('role') === 'article') {
        return cur;
      }
      if (cur.nodeType === 1 && cur.classList && cur.classList.contains('ct-target')) {
        return null;
      }
      cur = cur.parentElement;
      depth++;
    }
    return null;
  }
  function normalizeText(s) {
    if (!s) return '';
    return s.replace(/\s+/g, ' ').trim();
  }
  // 扫描/选块时统计块文本,统一跳过这些"非正文"子标签(script/style/noscript/svg/code 等)。
  // 与 setMainTextBlock 写入端的 SKIP 同一套,根治"把 <script> 数据岛当正文翻译显示"的误伤。
  const SCAN_SKIP_TAGS = new Set(['SCRIPT','STYLE','NOSCRIPT','SVG','CODE','PRE','TEXTAREA','INPUT','SELECT','KBD','SAMP','VAR','TITLE','IFRAME','CANVAS','TEMPLATE','DEFS','METADATA','FOREIGNOBJECT']);
  // 元素是否属于"非正文"子树:自身或任一祖先标签命中 SKIP(统一转大写)。
  // 必须转大写 + 向上查祖先:SVG 命名空间里的 <style>/<script> tagName 是小写,
  // 且文本节点可能嵌在 <text>/<defs> 深层,直接父未必是 SKIP 标签(SVG @font-face 乱码根因)。
  function inSkipSubtree(el) {
    for (let cur = el; cur && cur.nodeType === 1; cur = cur.parentElement) {
      const tag = cur.tagName;
      if (tag && SCAN_SKIP_TAGS.has(tag.toUpperCase())) return true;
    }
    return false;
  }
  // 只收集 el 内"非 SKIP 子树"的可见文本节点内容,拼接返回(对齐沉浸式翻译的 TEXT_NODE 收集思路)。
  // 用 TreeWalker 而非 innerText/textContent:后者会把可见 <script> 的代码一并算入(误伤根因)。
  function collectVisibleText(el) {
    if (!el) return '';
    const parts = [];
    try {
      const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
        acceptNode(n) {
          const p = n.parentElement;
          if (!p || inSkipSubtree(p)) return NodeFilter.FILTER_REJECT;
          return ((n.nodeValue || '').trim().length > 0) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        },
      });
      let node;
      while ((node = tw.nextNode())) parts.push(node.nodeValue);
    } catch (e) {
      return (el.textContent || '').toString();
    }
    return parts.join(' ');
  }
  function extractText(el, { minChars = 4, maxChars = 1500 } = {}) {
    if (!el) return '';
    let raw = '';
    try {
      raw = collectVisibleText(el);
    } catch (e) {
      return '';
    }
    const t = normalizeText(raw);
    if (t.length < minChars) return '';
    if (t.length > maxChars) return t.slice(0, maxChars) + '…';
    return t;
  }

  // 扫描整个 document,挑出"叶子级文本块"——最小承载一段独立文本的元素。
  // 对齐沉浸式翻译:优先真正的段落标签(P/LI/H1-6/BLOCKQUOTE),
  // 只在段落标签不够时退到 div/span;永远不选已含更小子块的大容器(SECTION/ARTICLE)。
  //
  // 旧实现的 bug:querySelectorAll 返回文档序(祖先在前),SECTION 大容器先入 seen,
  // 内部真正的 <p> 被判"嵌套"跳过 → 译文塞进 SECTION 级容器(另一个区域),且只翻到标题。
  // 新策略:先收集所有候选 → 按优先级排序(叶子优先)→ 若某节点的子树已选了更小的块,则丢弃它。
  //
  // mode 说明(P0 修复,2026-08-11):
  //   'bilingual'(默认):priority 2 多文本容器在叶子块不足时可整块入选(译文只是附加在块尾,不破坏结构)。
  //   'replace':priority 2 多文本容器【永不入选】——仅译文模式会清空块内全部文本节点再顶替,
  //             若选容器会把导航/导语的分栏子结构抹平挤成一坨(用户截图1)。replace 只逐叶子块各替各的。
  function scanAllBlocks({ minChars = 4, maxChars = 1500, mode = 'bilingual' } = {}) {
    const out = [];
    // 优先级:真正的段落标签 = 1(最想要);通用容器 div/span/section = 2(退而求其次)
    const LEAF_TAGS = new Set(['P', 'LI', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'DD', 'DT', 'FIGCAPTION']);
    const sel = 'p, li, blockquote, pre, code, h1, h2, h3, h4, h5, h6, dd, dt, figcaption, article, section, [role="article"], div, span, a, button, label, summary';

    let nodes;
    try {
      // 深度收集(方案2,#17):先扫主文档,再递归进每个 open shadow root 补扫。
      // Reddit 社区卡片简介(shreddit-subreddit-header 的 shadow root)等 shadow 内容,
      // document.querySelectorAll 穿透不到 → 漏翻。open shadow root(el.shadowRoot 非空)
      // 可递归;closed 拿不到,跳过。译文注入(insertBefore/appendChild)对 shadow 内元素
      // 天然可用,无需特判。样式靠元素内联/继承,shadow 内 inject.css 不生效但仅译文无需额外样式。
      nodes = Array.from(document.querySelectorAll(sel));
      const seen = new Set(nodes);
      const stack = Array.from(document.querySelectorAll('*')).filter((el) => el.shadowRoot);
      const visitedRoots = new Set();
      while (stack.length) {
        const host = stack.pop();
        const root = host.shadowRoot;
        if (!root || visitedRoots.has(root)) continue;
        visitedRoots.add(root);
        let inner = [];
        try { inner = Array.from(root.querySelectorAll(sel)); } catch (e) { continue; }
        for (const el of inner) { if (!seen.has(el)) { seen.add(el); nodes.push(el); } }
        // 下钻嵌套 shadow root(shadow 里再套 shadow)
        try {
          for (const el of root.querySelectorAll('*')) { if (el.shadowRoot) stack.push(el); }
        } catch (e) {}
      }
    } catch (e) {
      return out;
    }

    // 1) 给每个候选打分:文本长度 + 是否段落标签
    // 叶子度判定:一个"真叶子"块应当只有 1 个可见文本节点(或经 INLINE_WRAP 降级)。
    // "容器"块(DIV/SECTION/MAIN 等)有多个文本节点,选它会"吃"子节点。
    const candidates = [];
    const BIG_CONTAINER = new Set(['MAIN', 'ARTICLE', 'SECTION', 'BODY', 'HTML']);
    function leafScore(n) {
      // 数 n 直接可见的非空文本节点数(不递归,只看直接子)
      let nText = 0;
      for (const child of n.childNodes) {
        if (child.nodeType === 3 && (child.nodeValue || '').trim().length >= 3) nText++;
        else if (child.nodeType === 1 && isSafeToDescend(child)) {
          for (const gc of child.childNodes) {
            if (gc.nodeType === 3 && (gc.nodeValue || '').trim().length >= 3) nText++;
          }
        }
      }
      return nText;
    }
    // 沉浸式翻译风格:节点级 skip
    // 整子树永不翻译的标签
    const NO_TRANSLATE_TAGS = new Set(['SCRIPT','STYLE','TEXTAREA','SVG','NOSCRIPT','TITLE','IFRAME']);
    // 沉浸式 1.30.2 默认:footer/nav 整块 default-translate="no"
    // → 整个 footer/nav 子树永不翻译(菜单、footer 链接全跳过,避免站点 chrome 噪音)
    // header 不在此列:很多站点把【正文标题 H1】包在 <header> 里,一刀切会误伤正文标题。
    // header 改在 isValidNode 里单独处理——放行 H1-H6 标题,跳过其余(按钮/菜单)。
    const NEVER_TRANSLATE_CONTAINERS = ['footer:last-of-type', 'nav:last-of-type', 'nav'];
    // 沉浸式 1.30.2 additionalStayOriginalSelectors:数学公式、code、编辑器
    const STAY_ORIGINAL_SELECTORS = [
      'span.katex', '.math-block', '.MathJax_Preview', '.MathJax_Display', '.math-container',
      '.MathJax', '.MathJax_SVG', 'math-renderer', '[aria-labelledby^="MathJax-SVG"]',
      '.mwe-math-element', 'em[translate=no]', 'code[translate=no]', 'a[translate=no]', 'b[translate=no]',
      'span.math.inline', 'span.math.display', '.ltx_Math', '.mathjax-block', '.MathJax_CHTML',
      'kbd', 'span.pretex-inline', 'span.math-inline', '.reference-citations', '.code',
      "[data-test='json-editor']", '.jp-CodeMirrorEditor', 'cds-code-snippet',
      '.interactive-markdown__code', 'span.variable[translate=no]', '#ace-editor', 'table.processedcode',
      // GitHub/Reddit/通用补充
      'pre', 'code',
    ];
    function matchesAnySelector(el, sels) {
      if (!el) return false;
      for (const sel of sels) {
        try { if (el.matches(sel)) return true; } catch {}
      }
      return false;
    }
    // class/id 子串黑名单(GitHub/社区共识)
    const META_CONTAINER_HINTS = [
      'comment', 'opened-by', 'js-navigation-open', 'js-issue-row', 'js-navigation-container',
      'Box-row', 'IssueItem-module', 'Title-module', 'IssuePullRequestTitle-module',
      'author', 'byline', 'timestamp', 'created-at', 'updated-at', 'relative-time',
      'meta-time', 'post-meta',
    ];
    // 短文本 metadata 黑名单(< 80 字符,且含时间/作者模式)
    function looksLikeMetadata(text) {
      if (!text || text.length > 80) return false;
      const t = text.trim();
      // "38 minutes ago" / "yesterday" / "5 days ago" / "20 hours ago"
      if (/^\d+\s+(minute|hour|day|week|month|year|second)s?\s+ago$/i.test(t)) return true;
      if (/^(just now|a moment ago|yesterday|today|now)$/i.test(t)) return true;
      if (/^\d+\s+(分钟|小时|天|周|月|年|秒)前$/.test(t)) return true;
      // "@username" 或纯 #number 标签
      if (/^@\w+$/.test(t)) return true;
      if (/^#\d+$/.test(t)) return true;
      // "opened 38 minutes ago by BradLewis" / "opened yesterday by UserName"
      // 必须含 "opened" 或 "by <UserName>" 模式,且总长 ≤ 80 字符
      if (/^opened\s+\d+\s+(minute|hour|day|week|month|year|second)s?\s+ago\s+by\s+\w+/i.test(t)) return true;
      if (/^opened\s+(just now|a moment ago|yesterday|today)\s+by\s+\w+/i.test(t)) return true;
      if (/^opened\s+\d+\s+(分钟|小时|天|周|月|年|秒)前\s+by\s+\w+/.test(t)) return true;
      // "last week by gingerBill"
      if (/^(last|this)\s+(week|month|year)\s+by\s+\w+/i.test(t)) return true;
      // 纯 PR/Issue 状态短语
      if (/^(draft|closed|merged|open)\s*$/i.test(t)) return true;
      return false;
    }
    function isValidNode(n) {
      if (!n || n.nodeType !== 1) return true; // 文本节点不算"节点"
      if (NO_TRANSLATE_TAGS.has(n.tagName)) return false;
      // 我们的译文/容器/已译块,整子树跳过(防译文被当新块)
      if (n.classList && (n.classList.contains('ct-target') || n.classList.contains('ct-replaced') || n.classList.contains('ct-bilingual') || n.classList.contains('ct-bi'))) return false;
      // 用户明示跳过:notranslate class 或 translate="no" 属性
      if (n.classList && n.classList.contains('notranslate')) return false;
      if (n.getAttribute && n.getAttribute('translate') === 'no') return false;
      // 已翻译标记(防止重复)
      if (n.dataset && (n.dataset.translationmark || n.dataset.ctOrig != null)) return false;
      if (n.isContentEditable) return false;
      // 元素自身 lang 已是目标语言 → 跳过(避免二次翻译)
      if (n.lang && n.lang.toLowerCase().startsWith(dstLang)) return false;
      // 沉浸式 1.30.2:STAY_ORIGINAL_SELECTORS(数学/code/编辑器等)整子树跳过
      // 用 closest 往上找:任一祖先命中 → 跳过
      if (n.closest) {
        try { if (n.closest(NEVER_TRANSLATE_CONTAINERS.join(','))) return false; } catch {}
        try { if (n.closest(STAY_ORIGINAL_SELECTORS.join(','))) return false; } catch {}
        // 祖先是我们注入的译文/容器 → 跳过(防译文区域被当候选)
        try { if (n.closest('.ct-bi, .ct-target, .ct-bilingual, .ct-replaced')) return false; } catch {}
        // header 单独处理(方向A,2026-08-11):放行 H1-H6(很多站点把正文标题包在 header 里),
        // 跳过 header 里的其余内容(站点 logo/菜单按钮等 chrome)。footer/nav 仍在上面整树跳过。
        try {
          const hdr = n.closest('header');
          if (hdr && !/^[H][1-6]$/.test(n.tagName)) return false;
        } catch {}
      }
      // class/id 黑名单(GitHub row / metadata 容器)
      const cls = (n.className && n.className.toString) ? n.className.toString() : '';
      const id = (n.id || '');
      for (const hint of META_CONTAINER_HINTS) {
        if (cls.includes(hint) || id.includes(hint)) return false;
      }
      // 隐形"屏幕阅读器点击层"(#16,Reddit 相关帖子卡片):
      //   卡片有一个 absolute inset-0 的 <a> 覆盖全卡片,文本藏在 faceplate-screen-reader-content
      //   里供无障碍朗读,视觉上透明。若翻它,replace holder 会把这段文字变成可见的绝对定位
      //   文本,叠在真可见标题上 → 标题"重复2次+叠在一起"。
      //   判据:①含屏幕阅读器专用后代;②本身是 absolute inset-0 全卡片覆盖层。两者命中即跳。
      try {
        if (n.querySelector && n.querySelector('faceplate-screen-reader-content, .sr-only, [class*="screen-reader"], [class*="visually-hidden"]')) return false;
        if (/absolute/.test(cls) && /inset-0/.test(cls)) return false;
      } catch {}
      return true;
    }
    for (const n of nodes) {
      if (!isValidNode(n)) continue;
      // 动态 minChars:标题类元素用 4(短标题允许),正文类用 12(过滤短 metadata)
      const TITLE_TAGS = new Set(['H1','H2','H3','H4','H5','H6','DT','DD','FIGCAPTION','SUMMARY','A','BUTTON','LABEL']);
      const effMinChars = TITLE_TAGS.has(n.tagName) ? 4 : 12;
      const text = extractText(n, { minChars: effMinChars, maxChars });
      if (!text) continue;
      // 短 metadata 模式(纯时间/@用户名/#编号)直接跳过
      if (looksLikeMetadata(text)) continue;
      const lang = detectLang(text);
      if (lang.tag === dstLang) continue;
      if (dstLang === 'zh' && isChinese(text)) continue;
      if (n.tagName === 'HTML' || n.tagName === 'BODY') continue;
      // 优先级:
      //   真叶子(P/H1-6/LI/PRE/CODE) = 0
      //   单文本叶子度(DIV/SPAN 只 1 个文本) = 1
      //   多文本容器度(DIV/SECTION/MAIN 有 >1 文本) = 2 → 大幅降权,几乎不入选
      let priority;
      if (LEAF_TAGS.has(n.tagName)) {
        priority = 0;
      } else {
        const ns = leafScore(n);
        priority = ns <= 1 ? 1 : 2;
      }
      candidates.push({ n, text, lang: lang.tag, priority, len: text.length });
    }

    // 2) 排序:段落标签优先(0 < 1);同级按文本短的优先(更可能是独立小段而非大容器)
    candidates.sort((a, b) => (a.priority - b.priority) || (a.len - b.len));

    // 3) 贪心选取:选一个块后,标记它的所有后代与祖先为"已占用",避免父子重复翻译
    const chosen = new Set(); // 已选中的元素
    const blocked = new Set(); // 被占用(祖先或后代已选)的元素
    function isInsideChosen(el) {
      // 任一祖先已被选中 → 这个块是选中块的子树,跳过
      let p = el.parentElement;
      while (p) {
        if (chosen.has(p)) return true;
        p = p.parentElement;
      }
      return false;
    }
    // 大容器选取策略(P1c 覆盖率修复,2026-08-11):
    //   旧策略"bilingual 下独立块<5 才补 priority 2"会让聊天留言板(.gb-message 这类
    //   含 inline 元数据 span 的多文本容器被判 priority 2)在内容多的页面永不入选 → 整片漏翻。
    //   新策略:bilingual 下 priority 2 的【叶子型容器】(无块级子元素,如一条留言/一条评论,
    //   只含 inline span)正常入选,译文附加在块尾(appendBilingual)不顶替不破结构;
    //   含块级子元素的大容器(SECTION/MAIN 等)仍排除(译文会塞错位置)。
    //   replace 模式下 priority 2 永不入选(整块顶替会抹平容器子结构)——不变。
    const BLOCK_LEVEL = new Set(['P','LI','DIV','SECTION','ARTICLE','UL','OL','TABLE','H1','H2','H3','H4','H5','H6','BLOCKQUOTE','PRE','HEADER','FOOTER','NAV','ASIDE','FIGURE','FORM','DL','DD','DT']);
    function hasBlockChild(el) {
      for (const ch of el.children) { if (BLOCK_LEVEL.has(ch.tagName)) return true; }
      return false;
    }
    for (const c of candidates) {
      if (chosen.has(c.n) || blocked.has(c.n)) continue;
      if (isInsideChosen(c.n)) { blocked.add(c.n); continue; }
      if (c.priority === 2) {
        // replace 永不选;bilingual 只选叶子型容器(无块级子),大容器排除
        if (mode === 'replace' || hasBlockChild(c.n)) { blocked.add(c.n); continue; }
      }
      // 选中它:占用它的整个子树(后代不再单独选),并阻断祖先链
      // (子块先选后,容器祖先若再被选会"吃掉"子块 → 子块双重翻译/被顶替)
      chosen.add(c.n);
      let anc = c.n.parentElement;
      while (anc) { blocked.add(anc); anc = anc.parentElement; }
      out.push({ block: c.n, text: c.text, lang: c.lang });
    }

    // 按文档序输出,保证译文注入顺序自然
    out.sort((a, b) => {
      if (a.block === b.block) return 0;
      const rel = a.block.compareDocumentPosition(b.block);
      if (rel & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (rel & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });
    return out;
  }

  // ============ P1a:属性文本采集(img alt / aria-label / placeholder / abbr title) ============
  // 与块文本互补:块扫描只碰 textContent,这里补齐"看不见但读得到"的属性文本。
  // 只改 attribute 值、不动 DOM 结构 → 天然无破框架风险。
  // bilingual: attr = "原 (译)";replace: attr = "译"。原文存 dataset.ctAttrOrig 供还原。
  // 属性值专用 metadata 过滤(顶层,scanAttrs 用;scanAllBlocks 里有同名嵌套版处理块文本)。
  // 属性文本短,只需挡"纯日期/@用户名/#编号/xx前"这类明显非正文。
  function attrLooksLikeMetadata(text) {
    if (!text || text.length > 80) return false;
    const t = text.trim();
    if (/^\d+\s+(minute|hour|day|week|month|year|second)s?\s+ago$/i.test(t)) return true;
    if (/^(just now|a moment ago|yesterday|today|now)$/i.test(t)) return true;
    if (/^\d+\s+(分钟|小时|天|周|月|年|秒)前$/.test(t)) return true;
    if (/^@\w+$/.test(t)) return true;
    if (/^#\d+$/.test(t)) return true;
    // 纯日期(2024-01-01 / 2024/01/01 / 01-01-2024 等)
    if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(t)) return true;
    if (/^\d{1,2}[-/]\d{1,2}[-/]\d{2,4}$/.test(t)) return true;
    return false;
  }

  const ATTR_TARGETS = [
    // [选择器, 属性名](abbr title 最常见;a title 多为链接冗余文本,不采)
    ['img[alt]', 'alt'],
    ['[aria-label]', 'aria-label'],
    ['input[placeholder]', 'placeholder'],
    ['textarea[placeholder]', 'placeholder'],
    ['abbr[title]', 'title'],
  ];
  function scanAttrs() {
    const seen = new Set(); // 元素去重(一个元素可能命中多个选择器,按 el+attr 唯一)
    const out = [];
    for (const [sel, attr] of ATTR_TARGETS) {
      let nodes;
      try { nodes = document.querySelectorAll(sel); } catch { continue; }
      for (const el of nodes) {
        const k = attr + '\0' + (el.dataset.ctAttrIdx || (el.dataset.ctAttrIdx = String(seen.size + out.length)));
        if (seen.has(k)) continue;
        seen.add(k);
        // 用户明示跳过
        if (el.closest && el.closest('.notranslate, [translate="no"]')) continue;
        // 已处理过的元素:用记录的原文(ctAttrOrig)继续判重/供模式切换重算,
        // 不能读 getAttribute(可能是双语"原 (译)",会污染 cache key / 二次翻译)
        const already = el.dataset.ctAttr === attr;
        const raw = (already ? (el.dataset.ctAttrOrig || '') : (el.getAttribute(attr) || '')).trim();
        // 太短(单图标/箭头/OK 这类无信息)或太长(塞了整段)都不像可译文本
        if (raw.length < 4 || raw.length > 300) continue;
        if (attrLooksLikeMetadata(raw)) continue;
        const lang = detectLang(raw);
        if (lang.tag === dstLang) continue;
        if (dstLang === 'zh' && isChinese(raw)) continue;
        out.push({ el, attr, text: raw, lang: lang.tag, already });
      }
    }
    return out;
  }

  // 回写译文(含缓存命中分支)。dataset.ctAttrOrig 只存"最初的原文",双语/仅译文据此重算:
  //   bilingual → "原 (译)";replace → 纯译。模式切换(先双语后仅译文)会从 ctAttrOrig 重算,
  //   不会把"原 (译)"当原文再套一层(防嵌套的关键)。
  function applyAttr(el, attr, translated, mode) {
    if (!el.dataset.ctAttrOrig) el.dataset.ctAttrOrig = el.getAttribute(attr) || '';
    const orig = el.dataset.ctAttrOrig;
    el.dataset.ctAttr = attr;
    el.dataset.ctAttrMode = mode;
    el.setAttribute(attr, mode === 'replace' ? translated : (orig ? `${orig} (${translated})` : translated));
  }
  function restoreAttr(el) {
    const attr = el.dataset.ctAttr;
    if (!attr) return;
    if (el.dataset.ctAttrOrig != null) el.setAttribute(attr, el.dataset.ctAttrOrig);
    delete el.dataset.ctAttr;
    delete el.dataset.ctAttrMode;
    delete el.dataset.ctAttrOrig;
    delete el.dataset.ctAttrIdx;
  }

  // ============ render ============
  function findExisting(block, key) {
    // 译文块现在追加在 block 内部(beforeend),从最后一个子节点往上找
    let n = block.lastElementChild;
    while (n && n.classList && n.classList.contains('ct-original-wrap')) {
      n = n.previousElementSibling;
    }
    if (n && n.classList && n.classList.contains('ct-target') && n.dataset.ctKey === key) {
      return n;
    }
    return null;
  }
  function createPending(key) {
    const el = document.createElement('div');
    el.className = 'ct-target ct-pending';
    el.dataset.ctKey = key;
    el.setAttribute('role', 'status');
    el.textContent = '译文中…';
    return el;
  }
  function createTranslated(key, text, { showOriginal = false, originalText = '' } = {}) {
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
  function createError(key, message, onRetry) {
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

  // ============ 文本节点级注入(对齐沉浸式翻译:零容器,继承页面配色) ============
  // 核心思想:译文直接写进 block 的"主文本节点"(node.nodeValue),
  // 不新建 div/span,不动其它子元素(表单控件/链接不会丢),字体颜色全继承页面。
  // 这根治了"另建容器看不见 / textContent 清空子元素导致布局崩"。

  // 取 block 的"主文本节点":尽量找直接子节点(最安全,不会破坏块内结构);
  // 若直接子节点没有合适文本(如 <h1><span>Title</span></h1>),则向下一层查找
  // 纯 inline 装饰元素(span/b/i/strong/em/mark 等)或"叶子级按钮"里的文本节点。
  // (拒绝深入 <div>/<a> 这种可能含其它链接/结构的元素,避免破坏子结构。)
  const INLINE_WRAP = new Set(['SPAN', 'B', 'I', 'STRONG', 'EM', 'SMALL', 'MARK', 'U', 'CITE', 'ABBR']);
  // "叶子级按钮/链接":不含破坏性子元素(图片/表单/iframe/嵌套链接/div)——
  // 安全深入(常见于菜单标题被 <button> 或 GitHub issue 标题被 <a> 包裹)
  function isSafeToDescend(el) {
    if (!el || el.nodeType !== 1) return false;
    if (INLINE_WRAP.has(el.tagName)) return true;
    if (el.tagName === 'BUTTON' || el.tagName === 'LABEL' || el.tagName === 'SUMMARY' || el.tagName === 'A') {
      // 必须没有破坏性子元素:图片/表单/iframe/嵌套链接/块级容器
      for (const c of el.querySelectorAll('*')) {
        if (['IMG', 'INPUT', 'SELECT', 'TEXTAREA', 'IFRAME', 'VIDEO', 'AUDIO', 'CANVAS', 'SVG'].includes(c.tagName)) return false;
        if (c.tagName === 'A' && c !== el) return false; // 嵌套链接
        if (['DIV', 'UL', 'OL', 'TABLE', 'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BUTTON'].includes(c.tagName)) return false;
      }
      return true;
    }
    return false;
  }
  function getMainTextNode(block) {
    // 1) 直接子文本节点
    let best = null;
    let bestLen = 0;
    for (const child of block.childNodes) {
      if (child.nodeType === 3) {
        const v = (child.nodeValue || '').trim();
        if (v.length > bestLen) { best = child; bestLen = v.length; }
      }
    }
    if (bestLen >= 3) return best;
    // 2) 降级:看 block 的元素子节点是否全是"安全可深入"(INLINE_WRAP 或叶子级 BUTTON/LABEL/SUMMARY/A)。
    //    全部安全才深入,递归找最深文本节点(GitHub H3>A>SPAN>text 这种深嵌套)。
    const elementChildren = [...block.childNodes].filter(n => n.nodeType === 1);
    if (elementChildren.length === 0) return null;
    if (elementChildren.some(n => !isSafeToDescend(n))) return null;
    // 用 TreeWalker 在安全子树里递归找文本节点
    for (const el of elementChildren) {
      const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          // 拒绝嵌套的破坏性子元素里的文本(图标 alt 等)
          let p = node.parentElement;
          while (p && p !== el) {
            if (['IMG', 'SCRIPT', 'STYLE', 'NOSCRIPT'].includes(p.tagName)) return NodeFilter.FILTER_REJECT;
            p = p.parentElement;
          }
          return (node.nodeValue || '').trim().length > 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        }
      });
      let node;
      while ((node = tw.nextNode())) {
        const v = (node.nodeValue || '').trim();
        if (v.length > bestLen) { best = node; bestLen = v.length; }
      }
    }
    return bestLen >= 3 ? best : null;
  }

  // 记录原文(直接保存到 block 的 dataset,不依赖后续查询)
  function rememberText(block, textNode) {
    if (!block.dataset.ctOrig) {
      block.dataset.ctOrig = textNode.nodeValue;
    }
  }

  // "仅译文"模式:把主文本节点换成译文(保留其它子元素,继承样式)
  function setMainText(block, textNode, translated) {
    selfInjecting = true;
    try {
      rememberText(block, textNode);
      block.classList.add('ct-replaced');
      textNode.nodeValue = translated;
    } finally {
      setTimeout(() => { selfInjecting = false; }, 0);
    }
  }

  // "双语对照"模式:在主文本节点后追加一个 <br> + <span class="ct-bi">译文</span>。
  // 用 <span> 包住译文,这样 restoreBlock 能精确 querySelectorAll('.ct-bi') 移除。
  // (裸 text node 没有类名,无法用选择器定位——这是之前的 bug。)
  function appendBilingual(block, textNode, translated) {
    selfInjecting = true;
    try {
      // 先清掉可能存在的旧译文标记(防重复点击)
      block.querySelectorAll('.ct-bi').forEach((el) => el.remove());
      rememberText(block, textNode);
      const br = document.createElement('br');
      br.className = 'ct-bi';
      const span = document.createElement('span');
      span.className = 'ct-bi';
      span.textContent = translated;
      if (textNode.nextSibling) {
        block.insertBefore(br, textNode.nextSibling);
        block.insertBefore(span, br.nextSibling);
      } else {
        block.appendChild(br);
        block.appendChild(span);
      }
      block.classList.add('ct-bilingual');
    } finally {
      // 让 MutationObserver 的 microtask 先排完再解除,确保这次注入被忽略
      setTimeout(() => { selfInjecting = false; }, 0);
    }
  }

  // ============ 块级注入(修复"中英穿插"的核心,对齐沉浸式翻译) ============
  // 旧方案拿块内"单条主文本节点"翻译+注入,一旦段里夹 <a>/<span> 就会把英文链接
  // 留在原地、译文插到段中 → 中英穿插。新方案:送译文本=整块 extractText(跨内联标签),
  // 译文作为独立 .ct-target 块附加到原文块末尾(复用其 display:block+左边线样式,字色继承)。
  function appendBilingualBlock(block, translated) {
    if (!block || !translated) return;
    selfInjecting = true;
    try {
      // 幂等:同一块不重复附加
      if (block.querySelector(':scope > .ct-target.ct-done')) { block.classList.add('ct-bilingual'); return; }
      const el = document.createElement('div');
      el.className = 'ct-target ct-done';
      const t = document.createElement('div');
      t.className = 'ct-translation';
      t.textContent = translated;
      el.appendChild(t);
      block.appendChild(el);
      block.classList.add('ct-bilingual');
    } finally {
      setTimeout(() => { selfInjecting = false; }, 0);
    }
  }

  // 仅译文(块级):记录块内全部可译文本节点(含内联 <a>/<span> 里的)到 dataset,
  // 全部置空后在块首注入译文。这样跨内联标签的整段一起被译文顶替,不再残留英文片段。
  // restoreBlock 逐个把保存的原文写回,结构上 100% 还原。
  //
  // 兜底(P0):块内若含块级子元素(P/LI/H1-6/DIV/SECTION/ARTICLE/UL/OL/TABLE 等),
  // 说明它是"容器"而非"叶子段"——整块顶替会抹平子结构。扫描器已在 replace 模式拦掉
  // priority-2 容器,这里是双保险:此类块直接跳过(不替)。
  const BLOCK_CHILD_TAGS = new Set(['P','LI','DIV','SECTION','ARTICLE','UL','OL','TABLE','H1','H2','H3','H4','H5','H6','BLOCKQUOTE','PRE','HEADER','FOOTER','NAV','ASIDE','FIGURE','FORM','DL']);
  function hasBlockLevelChild(block) {
    for (const el of block.children) {
      if (BLOCK_CHILD_TAGS.has(el.tagName)) return true;
    }
    return false;
  }
  function setMainTextBlock(block, translated) {
    if (!block) return;
    if (hasBlockLevelChild(block)) return; // 容器块:不整块顶替(防破框架)
    selfInjecting = true;
    try {
      if (!block.dataset.ctRepl) {
        const saved = [];
        const SKIP = new Set(['SCRIPT','STYLE','NOSCRIPT','CODE','PRE','TEXTAREA','INPUT','SELECT','KBD','SAMP','VAR']);
        const tw = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
          acceptNode(n) {
            const p = n.parentElement;
            if (!p || SKIP.has(p.tagName)) return NodeFilter.FILTER_REJECT;
            if (p.classList && (p.classList.contains('ct-bi') || p.classList.contains('ct-target'))) return NodeFilter.FILTER_REJECT;
            return ((n.nodeValue || '').trim().length > 0) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
          }
        });
        let node; let i = 0;
        const nodes = [];
        while ((node = tw.nextNode())) nodes.push(node);
        for (const n of nodes) { saved.push(n.nodeValue); n.nodeValue = ''; i++; }
        block.dataset.ctRepl = JSON.stringify(saved);
      }
      // 幂等:已有 .ct-repl-main 就更新文本,不再插第二个。
      // 否则"页面加载自动翻译 + activeMode 切换重跑"并发/重复触发时,同一块的
      // setMainTextBlock 被调两次 → 译文 holder 并排插两个(截图里标题/侧栏"XX XX"重复)。
      const existing = block.querySelector('.ct-repl-main');
      if (existing) {
        existing.textContent = translated;
        block.classList.add('ct-replaced');
        return;
      }
      const holder = document.createElement('span');
      holder.className = 'ct-bi ct-repl-main';
      holder.textContent = translated;
      block.insertBefore(holder, block.firstChild);
      block.classList.add('ct-replaced');
    } finally {
      setTimeout(() => { selfInjecting = false; }, 0);
    }
  }

  // 还原单个块(两种模式都覆盖)。原文在 dataset.ctOrig 里,直接写回:
  // 关键:用 setMainText 之后,块内最长的文本节点就是被改写为译文的那一个,
  // 不能再用 getMainTextNode 去找原文(会抓到译文)。
  // —— 所以原文在 rememberText 时就存到 dataset,这里直接取 textNode 引用
  // 是不可能的(原 textNode 已被改写)。改用策略:对 .ct-replaced 块,
  // 取块内"非 .ct-bi 内"的文本节点中最长的,就是被改写的那条,直接写回 ctOrig。
  function restoreBlock(block) {
    // 1) 移除双语追加的 <br>+<span>、块级 .ct-target 译文容器、仅译文占位 span
    block.querySelectorAll('.ct-bi').forEach((el) => el.remove());
    block.querySelectorAll('.ct-target').forEach((el) => el.remove());
    // 2) 块级仅译文还原:dataset.ctRepl 存了块内每条文本节点的原文,按序写回
    if (block.dataset.ctRepl != null) {
      let saved = [];
      try { saved = JSON.parse(block.dataset.ctRepl); } catch {}
      const SKIP = new Set(['SCRIPT','STYLE','NOSCRIPT','CODE','PRE','TEXTAREA','INPUT','SELECT','KBD','SAMP','VAR']);
      const tw = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
        acceptNode(n) {
          const p = n.parentElement;
          if (!p || SKIP.has(p.tagName)) return NodeFilter.FILTER_REJECT;
          if (p.classList && (p.classList.contains('ct-bi') || p.classList.contains('ct-target'))) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT; // 此时非译文文本节点已被置空,全部收进来按序还原
        }
      });
      let node; const nodes = [];
      while ((node = tw.nextNode())) nodes.push(node);
      for (let i = 0; i < nodes.length && i < saved.length; i++) nodes[i].nodeValue = saved[i];
      delete block.dataset.ctRepl;
    }
    // 3) 旧版单文本节点仅译文还原(.ct-replaced 且有 ctOrig):最长文本节点写回 ctOrig
    if (block.classList.contains('ct-replaced') && block.dataset.ctOrig != null) {
      let tn = null;
      let bestLen = 0;
      for (const child of block.childNodes) {
        if (child.nodeType === 3) {
          const v = (child.nodeValue || '').trim();
          if (v.length > bestLen) { tn = child; bestLen = v.length; }
        }
        if (child.nodeType === 1 && INLINE_WRAP.has(child.tagName)) {
          for (const grand of child.childNodes) {
            if (grand.nodeType === 3) {
              const v = (grand.nodeValue || '').trim();
              if (v.length > bestLen) { tn = grand; bestLen = v.length; }
            }
          }
        }
      }
      if (tn) tn.nodeValue = block.dataset.ctOrig;
    }
    delete block.dataset.ctOrig;
    block.classList.remove('ct-replaced', 'ct-bilingual');
  }

  function replaceNode(oldEl, newEl) {
    if (oldEl && oldEl.parentNode) {
      oldEl.parentNode.replaceChild(newEl, oldEl);
      return newEl;
    }
    return null;
  }
  function cleanupOrphans() {
    const nodes = document.querySelectorAll('.ct-target');
    let removed = 0;
    for (const n of nodes) {
      const prev = n.previousElementSibling;
      if (!prev) { n.remove(); removed++; continue; }
      if (prev.classList && prev.classList.contains('ct-target')) continue;
      if (!document.body.contains(prev) && prev.dataset.ctAnchor !== '1') {
        n.remove(); removed++;
      }
    }
    return removed;
  }

  // ============ 主流程 ============
  const cache = new LRU({ max: 400, ttlMs: 24 * 3600 * 1000 });
  let enabled = true; // 内容脚本开关(false = 完全停用翻译,默认 true)
  // hoverEnabled 已废弃(原 hover 功能,observer 现已自动覆盖菜单展开跟进)
  let debounceMs = 80; // 已废弃(原 hover debounce,保留兼容)
  let dstLang = self.CT_LANGS ? self.CT_LANGS.guessTargetLang() : 'zh'; // 未读到设置前的瞬时默认;loadSettings 会用存储值覆盖
  let showOriginal = false;
  let observer = null;
  // 鼠标最近位置(只为右键翻译气泡定位,不做任何 hover 触发)
  let lastMouseX = 0;
  let lastMouseY = 0;
  document.addEventListener('mousemove', (e) => {
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
  }, { passive: true });

  async function loadSettings() {
    const s = await chrome.storage.local.get(['enabled', 'debounceMs', 'dstLang', 'showOriginal', 'activeMode', 'autoMode']);
    enabled = s.enabled !== false;
    if (typeof s.debounceMs === 'number') debounceMs = Math.max(0, Math.min(500, s.debounceMs));
    if (typeof s.dstLang === 'string' && s.dstLang) dstLang = s.dstLang;
    if (typeof s.showOriginal === 'boolean') showOriginal = s.showOriginal;
    // activeMode: 用户在 popup 点过任一主按钮 → 后续所有页面/SPA/FAQ 自动跟踪这个模式
    // null/未设 = 关闭自动跟踪(不主动跑整页)
    // 默认 'replace'(仅译文):比双语清爽(用户偏好 2026-08-11)
    autoMode = s.activeMode || s.autoMode || 'replace';
    autoTranslate = !!s.activeMode;
  }

  let autoTranslate = false; // 全局自动翻译开关(用户持久化)
  let autoMode = 'replace'; // 'bilingual' | 'replace'(默认仅译文)

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.enabled) enabled = changes.enabled.newValue !== false;
    // hoverEnabled 已废弃:忽略 storage 中的旧值(避免报错)
    if (changes.debounceMs) {
      debounceMs = Math.max(0, Math.min(500, changes.debounceMs.newValue || 80));
    }
    if (changes.dstLang) dstLang = changes.dstLang.newValue || (self.CT_LANGS ? self.CT_LANGS.guessTargetLang() : 'zh');
    if (changes.showOriginal) showOriginal = !!changes.showOriginal.newValue;
    // activeMode 变化(popup 切换模式时):如果非 null,当前页立刻重跑
    if (changes.activeMode) {
      const v = changes.activeMode.newValue;
      autoMode = v || 'replace';
      autoTranslate = !!v;
      if (v && enabled) {
        // 先清掉旧译文(双语追加的 ct-bi / 仅译文的 ct-replaced),再按新模式重跑。
        // 否则双语→仅译文切换时,旧的双语 <span class=ct-bi> 还留在页面上,
        // 新的仅译文又顶替一遍 → 两种译文叠加,且 observer 跟进放大(#13 根因)。
        setTimeout(() => {
          try { removeAll(); } catch (e) {}
          setTimeout(() => {
            if (autoMode === 'replace') translateAllReplace();
            else translateAll();
          }, 150);
        }, 100);
      }
    }
    // 兼容老字段
    if (changes.autoTranslate) { /* 忽略,改由 activeMode 驱动 */ }
    if (changes.autoMode && !changes.activeMode) {
      autoMode = changes.autoMode.newValue === 'bilingual' ? 'bilingual' : 'replace';
    }
  });

  function makeKey(text, srcTag) {
    return cyrb32(`${srcTag || ''}\0${dstLang}\0${text}`);
  }

  // DOM 观察器:职责 3 个
  //   (a) 清理孤立译文
  //   (b) 跟进新增子树(原 childList 逻辑)
  //   (c) 跟进"已存在节点从隐藏变可见"(新增 attributes 监听,关键修复 FAQ 展开)
  //   实现策略:mutation 触发后,setTimeout 200ms,扫"可见 + 未翻译"的所有 block,
  //   对每个新可翻译的块走 translateOne。比逐 mutation 精细分析更鲁棒。
  // 标记:我们自身注入译文时置 true,observer 据此忽略,避免"注入→触发→重扫→再注入"雪崩
  // (selfInjecting 已在 IIFE 顶部声明)

  function ensureObserver() {
    if (observer) return observer;
    observer = new MutationObserver((mutations) => {
      // 自身注入译文 / 还原译文引起的 DOM 变化 → 不跟进(防雪崩)
      if (selfInjecting) return;
      // 若所有 mutation 都发生在我们的译文节点内,也跳过
      let onlyOurs = true;
      for (const m of mutations) {
        const t = m.target;
        const inOurs = t && t.nodeType === 1 && t.closest && t.closest('.ct-bi, .ct-target');
        const addedOurs = m.addedNodes && [...m.addedNodes].every((n) => n.nodeType === 1 && n.classList && (n.classList.contains('ct-bi') || n.classList.contains('ct-target')));
        if (!inOurs && !addedOurs) { onlyOurs = false; break; }
      }
      if (onlyOurs) return;
      clearTimeout(observer._t);
      observer._t = setTimeout(() => {
        cleanupOrphans();
        scanAndAutoTranslate();
      }, 250);
    });
    // childList:新增子树
    // attributes:hidden/aria-hidden/aria-expanded/open/style/class 变化(FAQ/SPA 关键)
    // characterData:文本节点直接被改(SPA 数据驱动)
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['hidden', 'aria-hidden', 'aria-expanded', 'open', 'style', 'class', 'collapse', 'expanded', 'data-state'],
      characterData: true,
    });
    return observer;
  }

  // 扫描全页,找出"目前可见 + 未翻译"的所有可译块,逐个 translateOne。
  // 复用 scanAllBlocks(含 div/span + 叶子优先防嵌套 + metadata 黑名单),
  // 不再用旧的简陋白名单——旧选择器漏了 div,导致 FAQ 手风琴答案(包在 <div> 里)
  // 点开后跟进不到(标题是 h3/summary 能翻,答案 div 漏翻)。
  // 这里额外补一道 isVisible 过滤:动态跟进特有的需求——FAQ 展开前答案 aria-hidden,
  // 展开后才该翻;整页翻译走 collectBlocks 不需要这道。
  function scanAndAutoTranslate() {
    if (!enabled) return;
    // 还原/关闭自动跟踪后(activeMode=null → autoTranslate=false),observer 不得再重扫。
    // 否则用户点「还原」清掉译文 → 块上的 ctOrig/ct-replaced 标记被清 → observer 一触发
    // 又把刚还原的块重译回去(#13 根因:还原被自动检测覆盖)。
    if (!autoTranslate) return;
    try {
      const blocks = scanAllBlocks({ minChars: 4, maxChars: 1500, mode: autoMode === 'replace' ? 'replace' : 'bilingual' });
      let n = 0;
      for (const it of blocks) {
        const el = it.block;
        // 跳过已翻译/已替换(自身 + 祖先链任一已译都算,防译文被当新块重译)
        if (el.dataset && (el.dataset.ctOrig != null || el.classList.contains('ct-bilingual'))) continue;
        if (el.classList && el.classList.contains('ct-replaced')) continue;
        // 在我们的译文节点内部,或祖先已是双语/替换块 → 跳过(保守跟进核心)
        if (el.closest && el.closest('.ct-bi, .ct-target, .ct-bilingual, .ct-replaced')) continue;
        // 可见性:不是 hidden/aria-hidden,不是 display:none(FAQ 未展开时跳过)
        if (!isVisible(el)) continue;
        translateOne(el, it.text, it.lang);
        n++;
      }
      return n;
    } catch (e) {
      return 0;
    }
  }

  // 元素可见性判定(快速版,不依赖 getBoundingClientRect 因为节点可能未在视口)
  function isVisible(el) {
    if (!el) return false;
    if (el.hidden) return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    // 父链上有 hidden/aria-hidden 也算隐藏
    let p = el.parentElement;
    let depth = 0;
    while (p && depth < 20) {
      if (p.hidden) return false;
      if (p.getAttribute && p.getAttribute('aria-hidden') === 'true') return false;
      // inline style display:none
      if (p.style && p.style.display === 'none') return false;
      p = p.parentElement;
      depth++;
    }
    return true;
  }

  // translateOne:observer 自动跟进 + 单独 hover 触发的单段翻译。
  // 统一走"块级注入"(对齐沉浸式):双语=附加 .ct-target 译文块到原文块末尾;
  // 仅译文=整块文本替换。不再找单条主文本节点——根治段内夹 <a> 导致的中英穿插。
  async function translateOne(block, text, srcTag) {
    const key = makeKey(text, srcTag);

    // 缓存命中 → 直接渲染
    const cached = cache.get(key);
    if (cached) {
      const mode = autoMode || 'bilingual';
      if (mode === 'replace') {
        if (!block.classList.contains('ct-replaced')) setMainTextBlock(block, cached);
      } else {
        if (!block.classList.contains('ct-bilingual')) appendBilingualBlock(block, cached);
      }
      return;
    }

    // 已翻译过(其它模式)→ 跳过
    if (block.classList.contains('ct-replaced') || block.classList.contains('ct-bilingual')) return;

    try {
      const resp = await chrome.runtime.sendMessage({
        type: 'translate',
        key,
        text,
        srcLang: srcTag || '',
        dstLang,
      });
      if (!resp) return; // 扩展未响应,静默
      if (!resp.ok) return; // 失败也静默(observer 路径不该骚扰用户)
      cache.set(key, resp.text);
      const mode = autoMode || 'bilingual';
      if (mode === 'replace') {
        setMainTextBlock(block, resp.text);
      } else {
        appendBilingualBlock(block, resp.text);
      }
    } catch (e) {
      // 静默
    }
  }

  // ============ 一键全页双语(文本节点注入 + 分批流式) ============
  // 设计:
  //   - 每个 block 找到其"主文本节点",译文作为第二个 TEXT 节点(<br>+text)直接插进去。
  //     不建 div/span 容器,完全继承页面配色/字体;不动 block 内部子元素(链接/图标/小图等都在)。
  //   - 跳过没有直接文本的 block(纯包装器,翻译它会伤到子内容)。
  //   - 按 text 去重后,分批(每批 ≤120 条,留余量给后端 200 上限)逐批发,
  //     每批返回就立刻渲染,边译边更新页面,大页面不会卡。
  const BATCH_SIZE = 100; // 单批 ≤ 后端上限 200,留点余量
  const MAX_INFLIGHT_CHUNKS = 4; // 同时飞的 chunk 数(4×100 = 400 items 同时被翻译)

  function collectBlocks(mode /* 'bilingual' | 'replace' */) {
    const blocks = scanAllBlocks({ minChars: 4, maxChars: 1500, mode });
    const todo = [];
    let cached = 0;
    for (const it of blocks) {
      const key = makeKey(it.text, it.lang);
      // 缓存命中 → 直接渲染(不占网络)
      const hit = cache.get(key);
      if (hit) {
        cached++;
        if (mode === 'replace') {
          if (!it.block.classList.contains('ct-replaced')) setMainTextBlock(it.block, hit);
        } else {
          if (!it.block.classList.contains('ct-bilingual')) appendBilingualBlock(it.block, hit);
        }
        continue;
      }
      // 已处理过该 key:跳过(避免重复请求/重复注入)
      if (mode === 'replace' && it.block.classList.contains('ct-replaced')) continue;
      if (mode === 'bilingual' && it.block.classList.contains('ct-bilingual')) continue;
      todo.push({ key, text: it.text, srcLang: it.lang, block: it.block });
    }
    return { blocks, todo, skippedNoTextNode: 0, cached };
  }

  // 属性版采集:与 collectBlocks 同构(key/cache/去重),注入走 applyAttr
  function collectAttrs(mode) {
    const items = scanAttrs();
    const todo = [];
    let cached = 0;
    for (const it of items) {
      const key = makeKey(it.text, it.lang);
      const hit = cache.get(key);
      if (hit) {
        cached++;
        // 无条件按当前模式重写:applyAttr 从 ctAttrOrig(原文)重算,模式切换也正确
        applyAttr(it.el, it.attr, hit, mode);
        continue;
      }
      // 无缓存时,若属性已是本模式译文(重跑),跳过避免重复请求
      if (it.el.dataset.ctAttr === it.attr && it.el.dataset.ctAttrMode === mode) continue;
      todo.push({ key, text: it.text, srcLang: it.lang, el: it.el, attr: it.attr });
    }
    return { items, todo, cached };
  }

  // 共享的分批流式翻译执行器
  async function streamTranslate(todo, applyToBlock) {
    // 按 text 去重
    const textToIdx = new Map();
    const uniqueTexts = [];
    todo.forEach((t) => {
      if (!textToIdx.has(t.text)) {
        textToIdx.set(t.text, uniqueTexts.length);
        uniqueTexts.push({ text: t.text, srcLang: t.srcLang });
      }
    });
    const todoByText = new Map();
    todo.forEach((t) => {
      if (!todoByText.has(t.text)) todoByText.set(t.text, []);
      todoByText.get(t.text).push(t);
    });

    let done = 0, success = 0, fail = 0;
    const usedByProvider = {};
    let lastResp = null;

    // 重叠并发:不等上一 chunk 全部完成才发下一 chunk。
    // 维护一个"在飞 chunk"队列,任意 chunk 完成就启动下一个待发 chunk。
    // 这样总在飞数 = MAX_INFLIGHT_CHUNKS × chunkConcurrency = 4×6 = 24 等效并发(后端 batch 上限 200/req)。
    const chunks = [];
    for (let i = 0; i < uniqueTexts.length; i += BATCH_SIZE) {
      const slice = uniqueTexts.slice(i, i + BATCH_SIZE);
      chunks.push(slice.map((u, k) => ({ id: String(k), text: u.text, srcLang: u.srcLang })));
    }
    let chunkIdx = 0;
    const inFlight = new Set();
    function launchNext() {
      while (inFlight.size < MAX_INFLIGHT_CHUNKS && chunkIdx < chunks.length) {
        const myIdx = chunkIdx++;
        const chunk = chunks[myIdx];
        const p = processChunk(chunk, myIdx).finally(() => inFlight.delete(p));
        inFlight.add(p);
      }
    }
    async function processChunk(chunk, idx) {
      let resp;
      try {
        resp = await chrome.runtime.sendMessage({ type: 'translate-batch', items: chunk, dstLang, concurrency: 6 });
      } catch (e) {
        for (const u of chunk) {
          for (const t of todoByText.get(u.text) || []) {
            applyToBlock(t, { ok: false, error: String((e && e.message) || e) });
            fail++;
            done++;
          }
        }
        reportProgress({ done, total: todo.length, success, fail, currentBatchFail: chunk.length, batchFailError: String((e && e.message) || e) });
        return;
      }
      if (!resp || !resp.ok) {
        const errMsg = (resp && resp.error) || '后端未响应';
        for (const u of chunk) {
          for (const t of todoByText.get(u.text) || []) {
            applyToBlock(t, { ok: false, error: errMsg });
            fail++;
            done++;
          }
        }
        reportProgress({ done, total: todo.length, success, fail, currentBatchFail: chunk.length, batchFailError: errMsg });
        return;
      }
      lastResp = resp;
      const byId = new Map();
      (resp.results || []).forEach((r) => { if (r && r.id != null) byId.set(String(r.id), r); });
      for (let k = 0; k < chunk.length; k++) {
        const r = byId.get(String(k));
        const u = chunk[k];
        for (const t of todoByText.get(u.text) || []) {
          if (r && r.ok && r.text) {
            cache.set(t.key, r.text);
            applyToBlock(t, r);
            success++;
            const kk = (r.provider || '?') + '/' + (r.model || '?');
            usedByProvider[kk] = (usedByProvider[kk] || 0) + 1;
          } else {
            applyToBlock(t, r || { ok: false, error: 'no result' });
            fail++;
          }
          done++;
        }
      }
      reportProgress({ done, total: todo.length, success, fail });
    }
    launchNext();
    // 等所有在飞 chunk 完成
    while (inFlight.size > 0) {
      await Promise.race(inFlight);
      launchNext();
    }

    return { success, fail, lastResp, usedByProvider };
  }

  // 流式进度:发给 popup(它有 hero-status 显示) + 控制台
  function reportProgress({ done, total, success, fail, currentBatchFail, batchFailError }) {
    const pct = total ? Math.round((done / total) * 100) : 100;
    const msg = currentBatchFail
      ? `流式翻译 ${done}/${total} (${pct}%) · 成功 ${success} · 失败 ${fail} · 当前批 ${currentBatchFail} 条失败: ${batchFailError || '?'}`
      : `流式翻译 ${done}/${total} (${pct}%) · 成功 ${success} · 失败 ${fail}`;
    try {
      chrome.runtime.sendMessage({ type: 'progress', phase: 'translate-all', msg }).catch(() => {});
    } catch {}
    // 也存到 storage,popup 重新打开时能读到
    try { chrome.storage.local.set({ _ct_progress: { done, total, success, fail, ts: Date.now() } }); } catch {}
  }

  // =============== 双语对照入口 ===============
  async function translateAll() {
    const { blocks, todo, skippedNoTextNode, cached } = collectBlocks('bilingual');
    const attrs = collectAttrs('bilingual');
    const allTodo = todo.concat(attrs.todo);
    const totalUnits = blocks.length + attrs.items.length;
    if (!totalUnits) {
      return { ok: true, total: 0, success: 0, fail: 0, message: '页面里没找到需要翻译的段落(可能已是中文,或段落都太短)' };
    }
    if (allTodo.length === 0) {
      return {
        ok: true, total: totalUnits, success: cached + attrs.cached, fail: 0,
        message: skippedNoTextNode > 0
          ? `全部 ${cached + attrs.cached} 项已用缓存,另有 ${skippedNoTextNode} 个包装器块已跳过`
          : `全部 ${cached + attrs.cached} 项已用缓存`,
      };
    }

    const r = await streamTranslate(allTodo, (t, result) => {
      if (result && result.ok && result.text) {
        if (t.attr) applyAttr(t.el, t.attr, result.text, 'bilingual');
        else appendBilingualBlock(t.block, result.text);
      }
      // 失败:不写,保留原文(避免覆盖);只让 popup 看到 fail 计数
    });

    // 通知 popup "last-used"
    if (r.lastResp) {
      try {
        const summary = Object.entries(r.usedByProvider).map(([k, n]) => `${k}×${n}`).join(' ');
        chrome.runtime.sendMessage({
          type: 'last-used',
          provider: r.lastResp.provider || '',
          model: r.lastResp.model || '',
          summary,
          success: r.success, fail: r.fail,
          total: todo.length,
          durationMs: r.lastResp.durationMs,
          fallbackUsed: !!r.lastResp.fallbackUsed,
        }).catch(() => {});
      } catch {}
    }

    return {
      ok: true,
      total: todo.length,
      success: r.success,
      fail: r.fail,
      cached,
      skippedNoTextNode,
      provider: r.lastResp && r.lastResp.provider,
      model: r.lastResp && r.lastResp.model,
      durationMs: r.lastResp && r.lastResp.durationMs,
      usedByProvider: r.usedByProvider,
      fallbackUsed: r.lastResp && !!r.lastResp.fallbackUsed,
    };
  }

  // =============== 仅译文入口(用主文本节点直接改 nodeValue) ===============
  async function translateAllReplace() {
    const { blocks, todo, skippedNoTextNode, cached } = collectBlocks('replace');
    const attrs = collectAttrs('replace');
    const allTodo = todo.concat(attrs.todo);
    const totalUnits = blocks.length + attrs.items.length;
    if (!totalUnits) {
      return { ok: true, total: 0, success: 0, fail: 0, message: '页面里没找到需要翻译的段落(可能已是中文,或段落都太短)' };
    }
    if (allTodo.length === 0) {
      return {
        ok: true, total: totalUnits, success: cached + attrs.cached, fail: 0,
        message: skippedNoTextNode > 0
          ? `全部 ${cached + attrs.cached} 项已用缓存,另有 ${skippedNoTextNode} 个包装器块已跳过`
          : `全部 ${cached + attrs.cached} 项已用缓存`,
      };
    }

    const r = await streamTranslate(allTodo, (t, result) => {
      if (result && result.ok && result.text) {
        if (t.attr) applyAttr(t.el, t.attr, result.text, 'replace');
        else setMainTextBlock(t.block, result.text);
      }
      // 失败:保留原文不动
    });

    if (r.lastResp) {
      try {
        const summary = Object.entries(r.usedByProvider).map(([k, n]) => `${k}×${n}`).join(' ');
        chrome.runtime.sendMessage({
          type: 'last-used',
          provider: r.lastResp.provider || '',
          model: r.lastResp.model || '',
          summary,
          success: r.success, fail: r.fail,
          total: todo.length,
          durationMs: r.lastResp.durationMs,
          fallbackUsed: !!r.lastResp.fallbackUsed,
        }).catch(() => {});
      } catch {}
    }

    return {
      ok: true,
      total: todo.length,
      success: r.success,
      fail: r.fail,
      cached,
      skippedNoTextNode,
      provider: r.lastResp && r.lastResp.provider,
      model: r.lastResp && r.lastResp.model,
      durationMs: r.lastResp && r.lastResp.durationMs,
      usedByProvider: r.usedByProvider,
      fallbackUsed: r.lastResp && !!r.lastResp.fallbackUsed,
    };
  }

  // 记录原文(用 dataset 存原始 innerHTML,便于精确还原含格式的块)
  function rememberOriginal(block, text, key) {
    if (!block.dataset.ctOriginal) {
      block.dataset.ctOriginal = block.innerHTML;
    }
    if (!block.dataset.ctKey) block.dataset.ctKey = key;
  }
  // 执行替换(缓存命中分支用)
  function applyReplace(block, translatedText, originalText, key) {
    rememberOriginal(block, originalText, key);
    block.classList.add('ct-replaced');
    block.textContent = translatedText;
  }
  // 还原单个块
  function restoreOriginal(block) {
    if (block.dataset.ctOriginal) {
      block.innerHTML = block.dataset.ctOriginal;
    }
    delete block.dataset.ctOriginal;
    delete block.dataset.ctKey;
    block.classList.remove('ct-replaced');
  }

  function removeAll() {
    let n = 0;
    // 1) 还原双语块(在主文本节点后追加的 <br> + 译文文本节点,以及 ct-bilingual 类)
    document.querySelectorAll('.ct-bilingual, .ct-replaced').forEach((el) => { restoreBlock(el); n++; });
    // 2) 兼容老式 .ct-target 容器(若有遗留)
    document.querySelectorAll('.ct-target').forEach((el) => { el.remove(); n++; });
    // 3) P1a:还原属性译文(alt/aria-label/placeholder/title)
    document.querySelectorAll('[data-ct-attr]').forEach((el) => { restoreAttr(el); n++; });
    try { chrome.storage.local.remove('_ct_progress'); } catch {}
    return { ok: true, removed: n };
  }

  // ============ 翻译选中文本(右键菜单触发) ============
  // 沉浸式风格:在鼠标位置弹一个浮层气泡(div,z-index 最高),显示 loading → 译文
  // 不再用 chrome.notifications(用户视线会离开页面),改用原位 popup
  async function translateSelection(text) {
    if (!text || typeof text !== 'string') return;
    const trimmed = text.trim();
    if (trimmed.length < 1) return;

    // 取鼠标位置(Chrome contextMenus 没传坐标,用最近一次的 mousemove)
    const x = lastMouseX || window.innerWidth / 2;
    const y = lastMouseY || window.innerHeight / 2;

    const toast = createSelectionToast(trimmed, x, y);
    document.body.appendChild(toast.el);

    // 通过 chrome.runtime.sendMessage 走 background.js fetch(绕过 MV3 content script
    // 对 localhost 的 Private Network Access 拦截 — chrome 112+ 强制策略,fetch('http://127.0.0.1')
    // 在 https 页面会被 CORS 拒绝)。background 不受 PNA 限制(扩展进程特权)。
    let result = null;
    try {
      result = await chrome.runtime.sendMessage({
        type: 'translate',
        text: trimmed,
        srcLang: 'auto',
        dstLang,
      });
    } catch (e) {
      console.warn('[CT] translateSelection sendMessage failed:', e?.message || e);
      toast.showError('翻译请求失败:无法连接到 background service worker');
      return;
    }
    if (result && result.ok && result.text) {
      const info = [];
      if (result.provider && result.model) info.push(`${result.provider} · ${result.model}`);
      if (result.durationMs) info.push(`${result.durationMs}ms`);
      const attempts = result.attempts || [];
      if (attempts.length > 1) {
        info.push(`fallback: ${attempts.map((a) => a.ok ? `✓ ${a.provider}` : `✗ ${a.provider}`).join(' → ')}`);
      }
      toast.showResult(result.text, info.length ? info.join(' · ') : null);
    } else {
      toast.showError('翻译失败:' + (result && result.error || '未知错误'));
    }
  }

  // 创建气泡对象(loading → result/error,可关闭)
  function createSelectionToast(originalText, mouseX, mouseY) {
    const el = document.createElement('div');
    el.className = 'ct-toast';
    // 边界检测:鼠标右下偏移 16px,不超出 viewport
    const offsetX = 16, offsetY = 16;
    let left = mouseX + offsetX;
    let top = mouseY + offsetY;
    // 先放默认位置,等 DOM 测量宽高后再调整
    el.style.left = '0px';
    el.style.top = '0px';
    el.style.visibility = 'hidden';

    const header = document.createElement('div');
    header.className = 'ct-toast-header';
    const title = document.createElement('span');
    title.className = 'ct-toast-title';
    title.textContent = '翻译结果 · ' + (dstLang === 'zh' ? '中' : (self.CT_LANGS ? self.CT_LANGS.langDisplayName(dstLang) : dstLang));
    const close = document.createElement('span');
    close.className = 'ct-toast-close';
    close.textContent = '✕';
    close.title = '关闭';
    header.appendChild(title);
    header.appendChild(close);

    const loading = document.createElement('div');
    loading.className = 'ct-toast-loading';
    loading.innerHTML = '<span class="ct-toast-spinner"></span><span>正在翻译...</span>';

    const originalEl = document.createElement('div');
    originalEl.className = 'ct-toast-original';
    originalEl.textContent = originalText.length > 120 ? originalText.slice(0, 120) + '…' : originalText;

    el.appendChild(header);
    el.appendChild(originalEl);
    el.appendChild(loading);

    let positionLocked = false;
    function lockPosition() {
      if (positionLocked) return;
      positionLocked = true;
      const r = el.getBoundingClientRect();
      const W = window.innerWidth, H = window.innerHeight;
      let finalLeft = mouseX + offsetX;
      let finalTop = mouseY + offsetY;
      // 右/下边界:贴齐 viewport
      if (finalLeft + r.width > W - 8) finalLeft = Math.max(8, W - r.width - 8);
      if (finalTop + r.height > H - 8) finalTop = Math.max(8, mouseY - r.height - 8); // 上方
      // 左/上边界
      if (finalLeft < 8) finalLeft = 8;
      if (finalTop < 8) finalTop = 8;
      el.style.left = finalLeft + 'px';
      el.style.top = finalTop + 'px';
      el.style.visibility = 'visible';
    }

    // 关闭函数(给用户手动关 + 自动超时关)
    let closeTimer = null;
    function dismissToast() {
      el.style.transition = 'opacity 0.15s';
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 160);
    }
    close.addEventListener('click', dismissToast);

    // 暴露给外层的结果填充函数
    return {
      el,
      showResult(text, info) {
        // 替换 loading 为结果
        const resultEl = document.createElement('div');
        resultEl.className = 'ct-toast-result';
        resultEl.textContent = text;
        loading.replaceWith(resultEl);
        if (info) {
          const infoEl = document.createElement('div');
          infoEl.style.cssText = 'margin-top:6px;font-size:10px;color:#9ca3af;text-align:right;';
          infoEl.textContent = info;
          el.appendChild(infoEl);
        }
        lockPosition();
        // 30s 后自动关闭(用户可手动关)
        if (closeTimer) clearTimeout(closeTimer);
        closeTimer = setTimeout(dismissToast, 30000);
      },
      showError(msg) {
        const errEl = document.createElement('div');
        errEl.className = 'ct-toast-error';
        errEl.textContent = msg;
        loading.replaceWith(errEl);
        lockPosition();
        if (closeTimer) clearTimeout(closeTimer);
        closeTimer = setTimeout(dismissToast, 15000);
      },
    };
  }

  // hover 模式已废弃:observer 已自动跟进菜单展开 / FAQ / SPA / 动态内容。
  // 用户不再需要手动 hover 单段翻译。右键选中文本翻译 作为兜底。

  // ============ init ============
  function init() {
    // observer 始终安装(用于跟进新增内容:FAQ 展开等),不只是 hover 模式
    ensureObserver();
    // 监听 popstate + hashchange:一些 SPA(GitHub 部分页面、Vue Router hash 模式)用
    // pushState/replaceState,但 GitHub 用 turbo-frame 替换不会触发 history API 变化,
    // 但 popstate(浏览器前进/后退)和 hashchange 还是会触发
    let lastUrl = location.href;
    window.addEventListener('popstate', () => triggerAutoOnUrlChange());
    window.addEventListener('hashchange', () => triggerAutoOnUrlChange());

    function triggerAutoOnUrlChange() {
      if (location.href === lastUrl) return;
      lastUrl = location.href;
      // 等页面渲染完再扫(框架可能异步挂内容)
      setTimeout(() => {
        if (autoTranslate && enabled) scanAndAutoTranslate();
      }, 300);
    }

    loadSettings().then(() => {
      // hover 模式已废弃 — observer 自动跟进菜单展开/FAQ/SPA,无需手动 hover
      // 全局自动翻译:页面加载完成 + 设置加载完,自动跑一次整页翻译
      if (autoTranslate && enabled) {
        // 延迟 200ms 让页面的 JS 框架先把内容挂上(React/Vue)
        setTimeout(() => {
          try {
            if (autoMode === 'replace') translateAllReplace();
            else translateAll();
          } catch (e) {
            console.warn('[CT] auto translate failed:', e);
          }
        }, 200);
      }
    });

    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!msg) return false;
      if (msg.type === 'translate-all') {
        translateAll().then((r) => sendResponse(r));
        return true;
      }
      if (msg.type === 'replace-all') {
        translateAllReplace().then((r) => sendResponse(r));
        return true;
      }
      if (msg.type === 'auto-translate-now') {
        // SPA 路由变化或后台触发:重跑一次整页翻译(但先移除旧译文,避免重复)
        if (enabled && autoTranslate) {
          removeAll(); // 先清旧的
          setTimeout(() => {
            if (autoMode === 'replace') translateAllReplace();
            else translateAll();
          }, 150);
        }
        sendResponse({ ok: true });
        return true;
      }
      if (msg.type === 'remove-all') {
        sendResponse(removeAll());
        return true;
      }
      if (msg.type === 'clear-cache') {
        cache.clear();
        document.querySelectorAll('.ct-bilingual, .ct-replaced').forEach((el) => restoreBlock(el));
        document.querySelectorAll('.ct-target').forEach((el) => el.remove());
        sendResponse({ ok: true });
        return true;
      }
      if (msg.type === 'get-cache-stats') {
        sendResponse({ ok: true, size: cache.size });
        return true;
      }
      if (msg.type === 'translate-selection') {
        // 右键菜单触发:翻译用户选中的文本(错误也要 UI 反馈,不能静默)
        translateSelection(msg.text).catch((e) => {
          console.warn('[CT] translateSelection failed:', e);
        });
        sendResponse({ ok: true });
        return true;
      }
      return false;
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
