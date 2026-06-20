// 粗判源语:按 unicode 块给段落打"主要 script"标签。
// 仅用于日志与自定义 prompt customInstructions,不需要 100% 准。

const HINT_RANGES = [
  { re: /[぀-ヿㇰ-ㇿ]/, tag: 'ja', name: 'Japanese' },
  { re: /[가-힯]/, tag: 'ko', name: 'Korean' },
  { re: /[Ѐ-ӿ]/, tag: 'ru', name: 'Russian / Cyrillic' },
  { re: /[؀-ۿ]/, tag: 'ar', name: 'Arabic' },
  { re: /[一-鿿]/, tag: 'zh', name: 'Chinese' },
  { re: /[A-Za-z]/, tag: 'en', name: 'Latin' },
];

export function detectLang(text) {
  if (!text) return { tag: 'und', name: 'Unknown' };
  for (const r of HINT_RANGES) {
    if (r.re.test(text)) return { tag: r.tag, name: r.name };
  }
  return { tag: 'und', name: 'Unknown' };
}

// 是否基本是中文(用于"已是中文则不送翻译"的优化)
// 判定:前 200 字里汉字占比高 + 没有日文假名 / 谚文 / 拉丁字母 / 阿拉伯字母等
// "明显不是中文"的字符。日文里汉字占比也能很高,所以单看 CJK 比例不够。
export function isChinese(text) {
  if (!text) return false;
  const sample = text.slice(0, 200);
  if (!sample) return false;
  let cjk = 0;
  let other = 0;
  let total = 0;
  for (const ch of sample) {
    total++;
    if (/[一-鿿]/.test(ch)) cjk++;
    // 任何明确"非中文"的字符都让 other++
    if (
      /[぀-ヿㇰ-ㇿ]/.test(ch) ||      // 日文假名/半角片假名
      /[가-힯]/.test(ch) ||           // 韩文谚文(纯韩文字符)
      /[A-Za-z]/.test(ch) ||
      /[0-9]/.test(ch) ||
      /[Ѐ-ӿ]/.test(ch) ||
      /[؀-ۿ]/.test(ch)
    ) {
      other++;
    }
  }
  // 汉字 ≥ 90% 且没有明显非中文字符 → 当作纯中文
  return total > 0 && other === 0 && cjk / total >= 0.9;
}
