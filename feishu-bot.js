function parseFeishuMessageContent(content) {
  if (!content) return {};
  if (typeof content === 'object' && !Array.isArray(content)) return content;
  if (typeof content !== 'string') return {};
  try {
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    return {};
  }
}

function extractFeishuTextFromContent(messageType, rawContent) {
  const content = parseFeishuMessageContent(rawContent);
  if (messageType === 'text') {
    return `${content.text || ''}`.trim();
  }
  if (messageType === 'post') {
    const zhCn = content?.post?.zh_cn?.content;
    if (!Array.isArray(zhCn)) return '';
    const text = zhCn
      .flat()
      .map((item) => (item?.tag === 'text' ? `${item.text || ''}` : ''))
      .filter(Boolean)
      .join('')
      .trim();
    return text;
  }
  return '';
}

function extractFeishuFileFromContent(messageType, rawContent) {
  const content = parseFeishuMessageContent(rawContent);
  if (messageType === 'audio') {
    return {
      fileKey: `${content.file_key || content.audio_key || ''}`.trim(),
      fileName: `${content.file_name || content.name || ''}`.trim(),
    };
  }
  if (messageType === 'file') {
    return {
      fileKey: `${content.file_key || ''}`.trim(),
      fileName: `${content.file_name || content.name || ''}`.trim(),
    };
  }
  return { fileKey: '', fileName: '' };
}

function resolveFeishuResourceType(messageType) {
  return messageType === 'audio' ? 'audio' : 'file';
}

function mergeTranscriptWithTextInput(transcript, textInput) {
  const cleanTextInput = `${textInput || ''}`.trim();
  const cleanTranscript = `${transcript || ''}`.trim();
  if (!cleanTextInput && !cleanTranscript) return '';
  if (!cleanTextInput) return cleanTranscript;
  if (!cleanTranscript) return `用户补充说明：${cleanTextInput}`;
  return `用户补充说明：${cleanTextInput}\n\n语音转写：\n${cleanTranscript}`;
}

function clampMessageLength(text, maxLength) {
  if (text.length <= maxLength) return text;
  if (maxLength <= 1) return text.slice(0, maxLength);
  return `${text.slice(0, maxLength - 1)}…`;
}

function formatFeishuBotReply({ report, transcript, textInput, maxLength = 3500 }) {
  const result = report && typeof report === 'object' ? report : {};
  const lines = [];
  lines.push('销售复盘已完成。');
  if (Number.isFinite(result.total)) {
    lines.push(`综合评分：${Math.round(result.total)} 分`);
  }
  if (typeof result.status === 'string' && result.status.trim()) {
    lines.push(`状态：${result.status.trim()}`);
  }
  if (textInput && `${textInput}`.trim()) {
    lines.push(`补充文字：${clampMessageLength(`${textInput}`.trim(), 120)}`);
  }
  if (typeof result.report_markdown === 'string' && result.report_markdown.trim()) {
    lines.push('');
    lines.push(clampMessageLength(result.report_markdown.trim(), Math.max(1200, maxLength - 300)));
  }
  if ((!result.report_markdown || !`${result.report_markdown}`.trim()) && transcript && `${transcript}`.trim()) {
    lines.push('');
    lines.push(`转写摘要：${clampMessageLength(`${transcript}`.trim(), 800)}`);
  }
  return clampMessageLength(lines.join('\n'), maxLength);
}

module.exports = {
  parseFeishuMessageContent,
  extractFeishuTextFromContent,
  extractFeishuFileFromContent,
  resolveFeishuResourceType,
  mergeTranscriptWithTextInput,
  formatFeishuBotReply,
};
