// langs.js — 目标语言清单 + 系统语言推断(popup/options/background/content 共用)
// 服务三种加载方式:importScripts(background) / <script src>(popup/options) / content_scripts 注入(content)。
// 语言码用 Google gtx 兼容的短码(zh 而非 zh-CN);清单按常见度排,约 35 种。

(function (root) {
  const LANGS = [
    ['zh', '中文'],
    ['en', 'English'],
    ['ja', '日本語'],
    ['ko', '한국어'],
    ['fr', 'Français'],
    ['de', 'Deutsch'],
    ['es', 'Español'],
    ['ru', 'Русский'],
    ['pt', 'Português'],
    ['it', 'Italiano'],
    ['ar', 'العربية'],
    ['th', 'ไทย'],
    ['vi', 'Tiếng Việt'],
    ['id', 'Bahasa Indonesia'],
    ['ms', 'Bahasa Melayu'],
    ['hi', 'हिन्दी'],
    ['tr', 'Türkçe'],
    ['nl', 'Nederlands'],
    ['pl', 'Polski'],
    ['sv', 'Svenska'],
    ['uk', 'Українська'],
    ['zh-TW', '繁體中文'],
    ['cs', 'Čeština'],
    ['el', 'Ελληνικά'],
    ['he', 'עברית'],
    ['fi', 'Suomi'],
    ['no', 'Norsk'],
    ['da', 'Dansk'],
    ['hu', 'Magyar'],
    ['ro', 'Română'],
    ['bg', 'Български'],
    ['tl', 'Filipino'],
    ['sw', 'Kiswahili'],
    ['fa', 'فارسی'],
    ['bn', 'বাংলা'],
  ];

  const LANG_NAMES = Object.fromEntries(LANGS);

  // navigator.language → 清单内语言码;推断不出回落 zh(本扩展主要面向中文用户)。
  // navigator.languages(偏好列表)优先于 navigator.language,逐条尝试精确/前缀匹配。
  function guessTargetLang() {
    const prefs = (typeof navigator !== 'undefined' && (navigator.languages || [navigator.language])) || [];
    for (const raw of prefs) {
      if (!raw) continue;
      const l = String(raw).toLowerCase();
      if (l.startsWith('zh')) {
        // 繁体:TW/HK/MO 或显式 hant
        return (/(tw|hk|mo|hant)/.test(l)) ? 'zh-TW' : 'zh';
      }
      for (const [code] of LANGS) {
        const lc = code.toLowerCase();
        if (l === lc || l.startsWith(lc + '-')) return code;
      }
    }
    return 'zh';
  }

  function langDisplayName(code) {
    return LANG_NAMES[code] || code || '';
  }

  // 把语言清单填进一个 <select>(保留既有选中值的职责在调用方)
  function fillLangSelect(selectEl) {
    if (!selectEl) return;
    selectEl.innerHTML = '';
    for (const [code, name] of LANGS) {
      const o = document.createElement('option');
      o.value = code;
      o.textContent = `${name} (${code})`;
      selectEl.appendChild(o);
    }
  }

  root.CT_LANGS = { LANGS, LANG_NAMES, guessTargetLang, langDisplayName, fillLangSelect };
})(typeof self !== 'undefined' ? self : this);
