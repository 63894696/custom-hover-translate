// 翻译 prompt 模板 — system + user 两段。
// system 写规则,user 拼 customInstructions(源/目标语等)+ 段落 + 标签。
// 输出纯净中文,无 markdown 包裹,无解释。

function buildPrompt({ segmentText, customInstructions = '' }) {
  const system = `你是一名专业翻译。
- 用户会给你一段外语段落,你只输出对应的中文译文。
- 禁止任何解释、注释、前言、引号、markdown 包裹。
- 保留段落与换行结构。
- 专有名词首次出现按中文习惯处理,无需附原文。
- 如果原文本身已是中文,原样返回(不要"再翻译"成同语言)。`;

  const user = `${customInstructions}

# 待翻译段落
${segmentText}

# 译文`;

  return { system, user };
}

module.exports = buildPrompt;
