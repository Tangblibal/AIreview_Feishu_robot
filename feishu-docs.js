function getFeishuDocsConfig(readEnvString, readEnvBoolean, readEnvNumber) {
  const enabled = readEnvBoolean('FEISHU_DOCS_ENABLED') ?? false;
  return {
    enabled,
    folderToken: (readEnvString('FEISHU_DOCS_FOLDER_TOKEN', { allowEmpty: true }) || '').trim(),
    timezone: readEnvString('FEISHU_DOCS_TITLE_TIMEZONE') || 'Asia/Shanghai',
    maxTitleLength: readEnvNumber('FEISHU_DOCS_MAX_TITLE_LENGTH') || 100,
    replyMode: readEnvString('FEISHU_DOCS_REPLY_MODE') || 'link_with_summary',
    requestTimeoutMs: readEnvNumber('FEISHU_DOCS_REQUEST_TIMEOUT_MS') || 30000,
  };
}

function buildFeishuReviewDocumentTitle({
  chatName,
  senderDisplayName,
  audioFileName,
  now,
  timezone,
  maxTitleLength,
}) {
  const date = formatDateYYYYMMDD(now || new Date(), timezone);
  const cleanChat = sanitizeFeishuTitlePart(chatName);
  const cleanSender = sanitizeFeishuTitlePart(senderDisplayName);
  const cleanFile = sanitizeFeishuTitlePart(audioFileName) || 'feishu-audio';
  if (cleanChat && cleanSender) {
    return trimFeishuTitle(`${cleanChat}-${date}-${cleanSender}`, maxTitleLength);
  }
  return trimFeishuTitle(`${cleanFile}-${date}`, maxTitleLength);
}

function convertMarkdownToFeishuDocBlocks(markdown) {
  return splitIntoSimpleBlocks(markdown).map(toFeishuBlock);
}

function formatDateYYYYMMDD(date, timezone = 'Asia/Shanghai') {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(date instanceof Date ? date : new Date(date));
  const year = parts.find((part) => part.type === 'year')?.value || '0000';
  const month = parts.find((part) => part.type === 'month')?.value || '00';
  const day = parts.find((part) => part.type === 'day')?.value || '00';
  return `${year}${month}${day}`;
}

function sanitizeFeishuTitlePart(value) {
  return `${value || ''}`
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function trimFeishuTitle(value, maxLength = 100) {
  const clean = `${value || ''}`.trim();
  if (clean.length <= maxLength) return clean;
  return clean.slice(0, maxLength).trim();
}

function splitIntoSimpleBlocks(markdown) {
  return `${markdown || ''}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
      if (headingMatch) {
        return {
          kind: `heading${Math.min(headingMatch[1].length, 6)}`,
          text: headingMatch[2].trim(),
        };
      }
      if (/^[-*]\s+/.test(line)) {
        return { kind: 'bullet', text: line.replace(/^[-*]\s+/, '').trim() };
      }
      if (/^>\s*/.test(line)) {
        return { kind: 'quote', text: line.replace(/^>\s*/, '').trim() };
      }
      return { kind: 'paragraph', text: line };
    });
}

function toFeishuBlock(block) {
  return {
    type: block.kind,
    text: block.text,
  };
}

module.exports = {
  getFeishuDocsConfig,
  buildFeishuReviewDocumentTitle,
  convertMarkdownToFeishuDocBlocks,
};
