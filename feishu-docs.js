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

function summarizeFeishuDocBlocks(blocks) {
  const normalizedBlocks = Array.isArray(blocks) ? blocks : [];
  const children = normalizeFeishuBlockPayload(normalizedBlocks);
  return {
    blockCount: normalizedBlocks.length,
    childCount: children.length,
    batchCount: children.length ? splitIntoChunks(children, 50).length : 0,
  };
}

async function resolveFeishuChatName({ token, chatId, fetchImpl, timeoutMs }) {
  if (!token || !chatId) return '';
  try {
    const payload = await callFeishuJsonApi({
      url: `https://open.feishu.cn/open-apis/im/v1/chats/${encodeURIComponent(chatId)}`,
      token,
      fetchImpl,
      timeoutMs,
      errorLabel: 'Feishu chat lookup',
    });
    return `${payload?.data?.name || payload?.data?.chat?.name || ''}`.trim();
  } catch (error) {
    return '';
  }
}

async function resolveFeishuSenderDisplayName({ token, senderId, fetchImpl, timeoutMs }) {
  if (!token || !senderId) return '';
  const userIdTypes = ['open_id', 'user_id', 'union_id'];
  for (const userIdType of userIdTypes) {
    try {
      const url = new URL(`https://open.feishu.cn/open-apis/contact/v3/users/${encodeURIComponent(senderId)}`);
      url.searchParams.set('user_id_type', userIdType);
      const payload = await callFeishuJsonApi({
        url: url.toString(),
        token,
        fetchImpl,
        timeoutMs,
        errorLabel: 'Feishu user lookup',
      });
      const name = `${payload?.data?.user?.name || payload?.data?.user?.display_name || ''}`.trim();
      if (name) return name;
    } catch (error) {
      // Continue trying alternate user id types.
    }
  }
  return '';
}

async function createDocumentDirectly({ token, title, fetchImpl, timeoutMs }) {
  const payload = await callFeishuJsonApi({
    url: 'https://open.feishu.cn/open-apis/docx/v1/documents',
    token,
    fetchImpl,
    timeoutMs,
    method: 'POST',
    body: { title },
    errorLabel: 'Feishu document creation',
  });
  const documentToken = `${payload?.data?.document?.document_id || payload?.data?.document_id || ''}`.trim();
  if (!documentToken) {
    throw new Error('Feishu document creation succeeded but did not return a document token.');
  }
  return {
    documentToken,
    documentUrl:
      `${payload?.data?.url || payload?.data?.document?.url || payload?.data?.document_url || ''}`.trim() ||
      `https://feishu.cn/docx/${documentToken}`,
  };
}

async function appendBlocksToDocument({ token, documentToken, blocks, fetchImpl, timeoutMs, requestId }) {
  const children = normalizeFeishuBlockPayload(blocks);
  if (!children.length) return;
  const batches = splitIntoChunks(children, 50);
  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index];
    console.log(
      `[feishu_docs] request_id=${requestId || 'n/a'} document_token=${documentToken} batch_index=${index + 1}/${batches.length} batch_size=${batch.length}`,
    );
    await callFeishuJsonApi({
      url: `https://open.feishu.cn/open-apis/docx/v1/documents/${encodeURIComponent(documentToken)}/blocks/${encodeURIComponent(
        documentToken,
      )}/children`,
      token,
      fetchImpl,
      timeoutMs,
      method: 'POST',
      body: {
        index: index * 50,
        children: batch,
      },
      errorLabel: 'Feishu document append',
    });
  }
}

async function createFeishuReviewDocument(options, injectedHelpers = {}) {
  const { docsConfig = {}, botConfig = {}, token = '', context = {}, fetchImpl } = options || {};
  const timeoutMs = docsConfig.requestTimeoutMs || botConfig.requestTimeoutMs || 30000;
  const helpers = {
    resolveChatName: injectedHelpers.resolveChatName || resolveFeishuChatName,
    resolveSenderDisplayName: injectedHelpers.resolveSenderDisplayName || resolveFeishuSenderDisplayName,
    createDocumentDirectly:
      injectedHelpers.createDocumentDirectly ||
      injectedHelpers.createDocumentInFolder ||
      createDocumentDirectly,
    appendBlocksToDocument: injectedHelpers.appendBlocksToDocument || appendBlocksToDocument,
  };

  const [chatName, senderDisplayName] = await Promise.all([
    helpers
      .resolveChatName({ token, chatId: context.chatId, fetchImpl, timeoutMs })
      .catch(() => ''),
    helpers
      .resolveSenderDisplayName({ token, senderId: context.senderId, fetchImpl, timeoutMs })
      .catch(() => ''),
  ]);

  const title = buildFeishuReviewDocumentTitle({
    chatName,
    senderDisplayName,
    audioFileName: context.audioFileName,
    now: context.now,
    timezone: docsConfig.timezone,
    maxTitleLength: docsConfig.maxTitleLength,
  });
  const blocks = convertMarkdownToFeishuDocBlocks(context.reportMarkdown || '');
  const blocksToAppend = blocks.length ? blocks : [{ type: 'paragraph', text: '销售复盘已完成。' }];
  const blockSummary = summarizeFeishuDocBlocks(blocksToAppend);
  console.log(
    `[feishu_docs] request_id=${context.requestId || 'n/a'} block_count=${blockSummary.blockCount} child_count=${blockSummary.childCount} batch_count=${blockSummary.batchCount}`,
  );
  const document = await helpers.createDocumentDirectly({
    token,
    title,
    fetchImpl,
    timeoutMs,
  });
  await helpers.appendBlocksToDocument({
    token,
    documentToken: document.documentToken,
    blocks: blocksToAppend,
    fetchImpl,
    timeoutMs,
    requestId: context.requestId,
  });

  return {
    title,
    documentToken: document.documentToken,
    documentUrl: document.documentUrl,
    fallbackUsed: !(chatName && senderDisplayName),
  };
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

function normalizeFeishuBlockPayload(blocks) {
  return (Array.isArray(blocks) ? blocks : [])
    .map((block) => toFeishuApiBlock(block))
    .filter(Boolean);
}

function splitIntoChunks(items, chunkSize) {
  const chunks = [];
  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize));
  }
  return chunks;
}

function toFeishuApiBlock(block) {
  const type = `${block?.type || ''}`.trim() || 'paragraph';
  const text = `${block?.text || ''}`.trim();
  const blockTypeByName = {
    paragraph: 2,
    text: 2,
    heading1: 3,
    heading2: 4,
    heading3: 5,
    heading4: 6,
    heading5: 7,
    heading6: 8,
    bullet: 12,
    quote: 15,
  };
  const propertyByName = {
    paragraph: 'text',
    text: 'text',
    heading1: 'heading1',
    heading2: 'heading2',
    heading3: 'heading3',
    heading4: 'heading4',
    heading5: 'heading5',
    heading6: 'heading6',
    bullet: 'bullet',
    quote: 'quote',
  };
  const blockType = blockTypeByName[type];
  const property = propertyByName[type];
  if (!blockType || !property || !text) return null;
  return {
    block_type: blockType,
    [property]: {
      elements: [
        {
          text_run: {
            content: text,
          },
        },
      ],
    },
  };
}

async function callFeishuJsonApi({ url, token, fetchImpl, timeoutMs, method = 'GET', body, errorLabel }) {
  const response = await fetchImpl(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, timeoutMs);

  if (!response?.ok) {
    const text = await response?.text?.().catch(() => '');
    throw new Error(`${errorLabel} failed: ${response?.status || 'unknown'} ${text}`.trim());
  }

  const payload = await response.json().catch(() => ({}));
  if (payload?.code && payload.code !== 0) {
    throw new Error(`${errorLabel} failed: ${payload.msg || payload.code}`);
  }
  return payload;
}

module.exports = {
  getFeishuDocsConfig,
  buildFeishuReviewDocumentTitle,
  convertMarkdownToFeishuDocBlocks,
  summarizeFeishuDocBlocks,
  resolveFeishuChatName,
  resolveFeishuSenderDisplayName,
  createDocumentDirectly,
  appendBlocksToDocument,
  createFeishuReviewDocument,
};
