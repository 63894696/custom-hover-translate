// prompts.js — AI 角色提示词预设表(MV3 service worker / 扩展页可用)
//
// 设计原则(2026-08-12 新增,C 步):
//   1) 参考沉浸式翻译的「AI 角色」设计:同一台模型,换个角色提示词就能得到
//      面向不同场景(学术/小说/推文/中英夹杂…)的差异化译文。
//   2) 预设全部打包在扩展内,不联网拉取;只影响发给「用户自己配置的端点」的请求。
//   3) 隐私红线:不收集翻译内容、无遥测;提示词只是发给用户自选服务的请求文本。
//   4) 仅在引擎为 openai_compat(自定义 OpenAI 兼容端点)时生效;
//      google_gtx 是固定接口,无 prompt 概念。
//
// 占位符(渲染时替换):
//   {{to}}   — 目标语言(如 Chinese / English)
//   {{text}} — 待译正文(单段提示词用)
//   {{terms_prompt}} — 术语库注入位(暂默认空串;后续术语库功能接入)
//   {{summary_prompt}} / {{title_prompt}} / {{imt_style_guide}} — 兼容位,默认空串
//
// 多段批量(%% 协议):把多条文本用 \n%%\n 拼进一次请求,模型按同样分隔符回译,
//   我们再切回各条。省 token、降延迟。仅在角色支持且引擎为 openai_compat 时启用。

(function () {
  // ---------- 角色预设 ----------
  // 字段:
  //   id     — 稳定标识(存 storage.promptRole)
  //   name   — 界面显示名
  //   desc   — 一句话说明(options/popup 用)
  //   system — 系统提示词(含 {{to}} 等占位)
  //   single — 单段用户提示词模板(含 {{to}} {{text}});缺省用通用模板
  //   batchOK— 是否参与 %% 多段批量(意译大师这类 YAML 协议不适配,置 false)
  const ROLES = [
    {
      id: 'general',
      name: '通用',
      desc: '默认。忠实流畅,适合绝大多数网页',
      system:
        'You are a professional {{to}} native translator who needs to fluently translate text into {{to}}.\n\n' +
        '## Translation Rules\n' +
        '1. Output only the translated content, without explanations or additional content.\n' +
        '2. The returned translation must maintain exactly the same number of paragraphs and format as the original text.\n' +
        '3. If the text contains HTML tags, keep them in the right place in the translation.\n' +
        '4. For content that should not be translated (proper nouns, code, etc.), keep the original text.\n' +
        '5. If input contains %%, use %% in your output as a paragraph separator; if input has no %%, do not use %% in your output.{{terms_prompt}}',
      single: 'Translate to {{to}} (output translation only):\n\n{{text}}',
      batchOK: true,
    },
    {
      id: 'polish',
      name: '意译大师',
      desc: '先直译再润色,更地道自然',
      // 双轮精炼:让模型一次输出 step1(直译) + step2(润色),我们取 step2。
      system:
        'You are a professional, authentic translation engine.{{terms_prompt}}\n\n' +
        'For the given text: first translate into {{to}} (step1), then refine it to be natural and idiomatic in {{to}} (step2). ' +
        'Output ONLY the final refined translation (step2), with no step labels, no explanations.',
      single: 'Translate to {{to}}, then refine for naturalness (output only the final refined text):\n\n{{text}}',
      batchOK: false, // 精炼流程按条处理,不走 %% 拼接
    },
    {
      id: 'academic',
      name: '学术论文',
      desc: '复杂概念与术语准确,保持学术语气',
      system:
        'You are a highly skilled translation engine with expertise in academic paper translation. ' +
        'Translate academic texts into {{to}}, ensuring accurate translation of complex concepts and specialized terminology ' +
        'without altering the original academic tone or adding explanations.{{terms_prompt}}',
      single: 'Translate to {{to}} (output translation only):\n\n{{text}}',
      batchOK: true,
    },
    {
      id: 'tech',
      name: '科技',
      desc: '技术术语与缩写保持准确',
      system:
        'You are a highly skilled translation engine with expertise in the technology sector. ' +
        'Translate texts accurately into {{to}}, maintaining the original format, technical terms, and abbreviations. ' +
        'Do not add explanations or annotations.{{terms_prompt}}',
      single: 'Translate to {{to}} (output translation only):\n\n{{text}}',
      batchOK: true,
    },
    {
      id: 'news',
      name: '新闻媒体',
      desc: '保留新闻写作的口吻与风格',
      system:
        'You are a highly skilled translation engine with expertise in the news media sector. ' +
        'Translate texts accurately into {{to}}, preserving the nuances, tone, and style of journalistic writing. ' +
        'Do not add explanations or annotations.{{terms_prompt}}',
      single: 'Translate to {{to}} (output translation only):\n\n{{text}}',
      batchOK: true,
    },
    {
      id: 'reddit',
      name: 'Reddit',
      desc: '社区俚语与版块术语',
      system:
        'You are a sophisticated translation engine with expertise in Reddit content. ' +
        'Translate texts accurately into {{to}}, preserving community slang, subreddit-specific terminology, internet jargon, ' +
        'and platform-specific language. Do not add explanations or annotations.{{terms_prompt}}',
      single: 'Translate to {{to}} (output translation only):\n\n{{text}}',
      batchOK: true,
    },
    {
      id: 'twitter',
      name: 'Twitter/X',
      desc: '推文俚语、话题标签',
      system:
        'You are a sophisticated translation engine with expertise in tweets. ' +
        'Translate texts accurately into {{to}}, preserving slang, idiomatic expressions, hashtags, and platform-specific language. ' +
        'Do not add explanations or annotations.{{terms_prompt}}',
      single: 'Translate to {{to}} (output translation only):\n\n{{text}}',
      batchOK: true,
    },
    {
      id: 'github',
      name: 'GitHub',
      desc: '技术术语、代码与 Markdown 格式',
      system:
        'You are a sophisticated translation engine with expertise in GitHub content. ' +
        'Translate texts accurately into {{to}}, preserving technical terms, code snippets, markdown formatting, ' +
        'and platform-specific language. Do not add explanations or annotations.{{terms_prompt}}',
      single: 'Translate to {{to}} (output translation only):\n\n{{text}}',
      batchOK: true,
    },
    {
      id: 'fiction',
      name: '小说',
      desc: '叙事深度与情感韵味',
      system:
        'You are a highly skilled translation engine with expertise in fiction literature. ' +
        'Translate texts into {{to}}, capturing the narrative depth and emotional nuances of the original work. ' +
        'Maintain the original storytelling elements and cultural references without adding explanations or annotations.{{terms_prompt}}',
      single: 'Translate to {{to}} (output translation only):\n\n{{text}}',
      batchOK: true,
    },
    {
      id: 'game',
      name: '游戏',
      desc: '游戏术语与文化梗',
      system:
        'You are a highly skilled translation engine with expertise in the gaming industry. ' +
        'Translate texts accurately into {{to}}, ensuring the original tone, gaming jargon, and cultural nuances are preserved. ' +
        'Avoid adding explanations or annotations.{{terms_prompt}}',
      single: 'Translate to {{to}} (output translation only):\n\n{{text}}',
      batchOK: true,
    },
    {
      id: 'ecommerce',
      name: '电商',
      desc: '商品描述与买家评价',
      system:
        'You are a highly skilled translation engine with expertise in the e-commerce sector. ' +
        'Translate texts accurately into {{to}}, ensuring product descriptions, customer reviews, and e-commerce articles ' +
        'resonate with online shoppers without altering the original tone or information.{{terms_prompt}}',
      single: 'Translate to {{to}} (output translation only):\n\n{{text}}',
      batchOK: true,
    },
    {
      id: 'zh-en-mix',
      name: '中英夹杂',
      desc: '中英混排,保留专业术语英文',
      system:
        'Convert texts into a highly mixed Chinese-English format while maintaining high readability. ' +
        'For Chinese texts: keep key professional terms in English, translating the rest, to form a natural mixed-language text. ' +
        'For English texts: keep about twenty percent of the domain-specific terminology in English, translate the rest into Chinese. ' +
        'Ensure the result is coherent and readable, preserving technical terms. Target language: {{to}}.{{terms_prompt}}',
      single: 'Produce the mixed-language version (output only the result):\n\n{{text}}',
      batchOK: true,
    },
  ];

  const BY_ID = {};
  ROLES.forEach((r) => { BY_ID[r.id] = r; });

  // ---------- 工具 ----------
  function getRole(id) {
    return BY_ID[id] || BY_ID.general;
  }

  // 目标语言码 → 英文名(供提示词用);与 langs.js 的展示名互补。
  const TO_NAME = {
    zh: 'Chinese', 'zh-CN': 'Simplified Chinese', 'zh-TW': 'Traditional Chinese',
    en: 'English', ja: 'Japanese', ko: 'Korean', fr: 'French', de: 'German',
    es: 'Spanish', pt: 'Portuguese', ru: 'Russian', it: 'Italian', ar: 'Arabic',
    hi: 'Hindi', th: 'Thai', vi: 'Vietnamese', id: 'Indonesian', nl: 'Dutch',
  };
  function toName(dstLang) {
    if (!dstLang) return 'Chinese';
    const k = String(dstLang).trim();
    return TO_NAME[k] || TO_NAME[k.split('-')[0]] || k;
  }

  // 渲染模板:替换 {{to}} {{text}} 及兼容占位(terms/summary/title/style 暂空)。
  function render(tpl, { to, text, terms }) {
    let s = String(tpl == null ? '' : tpl);
    s = s.split('{{to}}').join(to || 'Chinese');
    if (text != null) s = s.split('{{text}}').join(text);
    s = s.split('{{terms_prompt}}').join(terms || '');
    s = s.split('{{summary_prompt}}').join('');
    s = s.split('{{title_prompt}}').join('');
    s = s.split('{{imt_style_guide}}').join('');
    return s;
  }

  // 组装一次请求的 system + user。
  //  singleText: 单条正文 → 用 single 模板
  //  batchTexts: 多条数组 → 用 %% 拼接进一次 user(仅当 role.batchOK)
  function buildPrompt({ roleId, dstLang, singleText, batchTexts, terms }) {
    const role = getRole(roleId);
    const to = toName(dstLang);
    const system = render(role.system, { to, terms });
    let user;
    if (Array.isArray(batchTexts) && batchTexts.length > 1 && role.batchOK) {
      const joined = batchTexts.join('\n%%\n');
      user = render('Translate to {{to}}:\n\n{{text}}', { to, text: joined });
      return { system, user, batch: true, count: batchTexts.length, role: role.id };
    }
    const text = singleText != null ? singleText : (batchTexts && batchTexts[0]) || '';
    user = render(role.single || BY_ID.general.single, { to, text, terms });
    return { system, user, batch: false, count: 1, role: role.id };
  }

  // 把 %% 批量回译结果切回数组;数量不符时返回 null(由调用方回退逐条)。
  function splitBatch(text, expected) {
    if (text == null) return null;
    const parts = String(text).split(/\n?%%\n?/).map((s) => s.trim());
    if (expected && parts.length !== expected) return null;
    return parts;
  }

  self.CT_PROMPTS = {
    ROLES,
    getRole,
    toName,
    render,
    buildPrompt,
    splitBatch,
  };
})();
