function getFeishuDocsConfig(readEnvString, readEnvBoolean, readEnvNumber) {
  const enabled = readEnvBoolean('FEISHU_DOCS_ENABLED') ?? false;
  return {
    enabled,
    folderToken: (readEnvString('FEISHU_DOCS_FOLDER_TOKEN', { allowEmpty: true }) || '').trim(),
    timezone: readEnvString('FEISHU_DOCS_TITLE_TIMEZONE') || 'Asia/Shanghai',
    maxTitleLength: readEnvNumber('FEISHU_DOCS_MAX_TITLE_LENGTH') || 100,
    replyMode: readEnvString('FEISHU_DOCS_REPLY_MODE') || 'link_with_summary',
    requestTimeoutMs: readEnvNumber('FEISHU_DOCS_REQUEST_TIMEOUT_MS') || 30000,
    appendBatchSize: readEnvNumber('FEISHU_DOCS_APPEND_BATCH_SIZE') || 20,
    appendRetryMaxAttempts: readEnvNumber('FEISHU_DOCS_APPEND_RETRY_MAX_ATTEMPTS') || 5,
    appendRetryBaseMs: readEnvNumber('FEISHU_DOCS_APPEND_RETRY_BASE_MS') || 500,
    appendRetryMaxBackoffMs: readEnvNumber('FEISHU_DOCS_APPEND_RETRY_MAX_BACKOFF_MS') || 8000,
    appendInterBatchDelayMs: readEnvNumber('FEISHU_DOCS_APPEND_INTER_BATCH_DELAY_MS') || 200,
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

function summarizeFeishuDocBlocks(blocks, { batchSize = 20 } = {}) {
  const normalizedBlocks = Array.isArray(blocks) ? blocks : [];
  const children = normalizeFeishuBlockPayload(normalizedBlocks);
  const safeBatchSize = Math.max(1, Number(batchSize) || 20);
  return {
    blockCount: normalizedBlocks.length,
    childCount: children.length,
    batchCount: children.length ? splitIntoChunks(children, safeBatchSize).length : 0,
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(retryAfterValue) {
  const raw = `${retryAfterValue || ''}`.trim();
  if (!raw) return 0;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const dateMs = Date.parse(raw);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }
  return 0;
}

function buildBackoffMs(attempt, baseMs, maxBackoffMs) {
  const safeBase = Math.max(100, Number(baseMs) || 500);
  const safeMax = Math.max(safeBase, Number(maxBackoffMs) || 8000);
  const factor = 2 ** Math.max(0, attempt - 1);
  return Math.min(safeMax, safeBase * factor);
}

function shouldRetryFeishuDocAppend(error) {
  const status = Number(error?.status || 0);
  if ([429, 500, 502, 503, 504].includes(status)) return true;
  const message = `${error?.message || ''}`.toLowerCase();
  return (
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('aborted') ||
    message.includes('rate limit') ||
    message.includes('too many requests')
  );
}

async function appendBlocksToDocument({
  token,
  documentToken,
  blocks,
  fetchImpl,
  timeoutMs,
  requestId,
  batchSize = 20,
  maxAttempts = 5,
  retryBaseMs = 500,
  retryMaxBackoffMs = 8000,
  interBatchDelayMs = 200,
  sleepImpl,
}) {
  const sleepFn = sleepImpl || sleep;
  const children = normalizeFeishuBlockPayload(blocks);
  if (!children.length) return;
  const safeBatchSize = Math.max(1, Number(batchSize) || 20);
  const batches = splitIntoChunks(children, safeBatchSize);
  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index];
    const totalAttempts = Math.max(1, Number(maxAttempts) || 1);
    for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
      console.log(
        `[feishu_docs] request_id=${requestId || 'n/a'} document_token=${documentToken} batch_index=${index + 1}/${batches.length} batch_size=${batch.length} attempt=${attempt}/${totalAttempts}`,
      );
      try {
        await callFeishuJsonApi({
          url: `https://open.feishu.cn/open-apis/docx/v1/documents/${encodeURIComponent(documentToken)}/blocks/${encodeURIComponent(
            documentToken,
          )}/children`,
          token,
          fetchImpl,
          timeoutMs,
          method: 'POST',
          body: {
            index: index * safeBatchSize,
            children: batch,
          },
          errorLabel: 'Feishu document append',
        });
        break;
      } catch (error) {
        if (attempt >= totalAttempts || !shouldRetryFeishuDocAppend(error)) {
          console.error(
            `[feishu_docs] request_id=${requestId || 'n/a'} document_token=${documentToken} batch_index=${index + 1}/${batches.length} batch_size=${batch.length} attempt=${attempt}/${totalAttempts} append_failed_status=${error?.status || 'unknown'} message=${error.message}`,
          );
          throw error;
        }
        const retryAfterMs = Math.max(0, Number(error?.retryAfterMs) || 0);
        const delayMs = retryAfterMs > 0 ? retryAfterMs : buildBackoffMs(attempt, retryBaseMs, retryMaxBackoffMs);
        console.warn(
          `[feishu_docs] request_id=${requestId || 'n/a'} document_token=${documentToken} batch_index=${index + 1}/${batches.length} batch_size=${batch.length} attempt=${attempt}/${totalAttempts} append_retry_status=${error?.status || 'unknown'} retry_in_ms=${delayMs}`,
        );
        await sleepFn(delayMs);
      }
    }
    if (index < batches.length - 1 && interBatchDelayMs > 0) {
      await sleepFn(interBatchDelayMs);
    }
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
  const blockSummary = summarizeFeishuDocBlocks(blocksToAppend, {
    batchSize: docsConfig.appendBatchSize,
  });
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
    batchSize: docsConfig.appendBatchSize,
    maxAttempts: docsConfig.appendRetryMaxAttempts,
    retryBaseMs: docsConfig.appendRetryBaseMs,
    retryMaxBackoffMs: docsConfig.appendRetryMaxBackoffMs,
    interBatchDelayMs: docsConfig.appendInterBatchDelayMs,
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
    const error = new Error(`${errorLabel} failed: ${response?.status || 'unknown'} ${text}`.trim());
    error.status = response?.status || 0;
    error.retryAfterMs = parseRetryAfterMs(response?.headers?.get?.('retry-after'));
    throw error;
  }

  const payload = await response.json().catch(() => ({}));
  if (payload?.code && payload.code !== 0) {
    const error = new Error(`${errorLabel} failed: ${payload.msg || payload.code}`);
    error.code = payload.code;
    throw error;
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
