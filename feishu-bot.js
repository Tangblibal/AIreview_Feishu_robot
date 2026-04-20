const { createFeishuReviewDocument } = require('./feishu-docs');

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

function formatFeishuDocReply({ title, url, score, status, maxLength = 1200 }) {
  const lines = ['销售复盘已完成，已归档到飞书文档。'];
  if (`${title || ''}`.trim()) {
    lines.push(`文档标题：${`${title}`.trim()}`);
  }
  if (Number.isFinite(score)) {
    lines.push(`综合评分：${Math.round(score)} 分`);
  }
  if (`${status || ''}`.trim()) {
    lines.push(`状态：${`${status}`.trim()}`);
  }
  if (`${url || ''}`.trim()) {
    lines.push(`文档链接：${`${url}`.trim()}`);
  }
  return clampMessageLength(lines.join('\n'), maxLength);
}

function formatFeishuDocFailureFallback({ report, transcript, textInput, maxLength = 500 }) {
  const result = report && typeof report === 'object' ? report : {};
  const lines = ['销售复盘已完成。'];
  if (Number.isFinite(result.total)) {
    lines.push(`综合评分：${Math.round(result.total)} 分`);
  }
  if (`${result.status || ''}`.trim()) {
    lines.push(`状态：${`${result.status}`.trim()}`);
  }

  const summary =
    extractFeishuFallbackSentence(result.report_markdown) ||
    extractFeishuFallbackSentence(transcript) ||
    extractFeishuFallbackSentence(textInput);
  if (summary) {
    lines.push(`摘要：${summary}`);
  }

  return clampMessageLength(lines.join('\n'), maxLength);
}

function extractFeishuFallbackSentence(value) {
  const clean = `${value || ''}`
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.replace(/^#{1,6}\s+/, '').replace(/^[-*]\s+/, '').replace(/^>\s*/, '').trim())
    .filter(Boolean)
    .find((line) => !/^(综合评估|复盘总结|销售复盘)$/i.test(line));
  if (!clean) return '';
  return clean.slice(0, 80);
}

async function buildFeishuReviewReply(
  { docsConfig = {}, botConfig = {}, token = '', result = {}, textInput = '', context = {}, fetchImpl },
  injected = {},
) {
  const report = result?.report;
  const transcript = result?.transcript;
  const maxLength = botConfig.replyMaxLength || 3500;

  if (!(docsConfig.enabled && `${docsConfig.folderToken || ''}`.trim())) {
    return {
      mode: 'text',
      replyText: formatFeishuBotReply({
        report,
        transcript,
        textInput,
        maxLength,
      }),
    };
  }

  const createDoc = injected.createFeishuReviewDocument || createFeishuReviewDocument;
  try {
    const document = await createDoc({
      docsConfig,
      botConfig,
      token,
      context: {
        ...context,
        reportMarkdown: `${report?.report_markdown || ''}`.trim(),
      },
      fetchImpl,
    });
    return {
      mode: 'doc_link',
      replyText: formatFeishuDocReply({
        title: document.title,
        url: document.documentUrl,
        score: report?.total,
        status: report?.status,
        maxLength,
      }),
      document,
    };
  } catch (error) {
    return {
      mode: 'text_fallback',
      replyText: formatFeishuDocFailureFallback({
        report,
        transcript,
        textInput,
        maxLength,
      }),
      error,
    };
  }
}

module.exports = {
  parseFeishuMessageContent,
  extractFeishuTextFromContent,
  extractFeishuFileFromContent,
  resolveFeishuResourceType,
  mergeTranscriptWithTextInput,
  formatFeishuBotReply,
  formatFeishuDocReply,
  formatFeishuDocFailureFallback,
  buildFeishuReviewReply,
};
