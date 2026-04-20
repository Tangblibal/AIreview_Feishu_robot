const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildFeishuReviewDocumentTitle,
  convertMarkdownToFeishuDocBlocks,
  createFeishuReviewDocument,
} = require('../feishu-docs');

test('buildFeishuReviewDocumentTitle uses chat-date-sender when metadata exists', () => {
  const title = buildFeishuReviewDocumentTitle({
    chatName: '苏州门店复盘群',
    senderDisplayName: '张三',
    audioFileName: '试听.m4a',
    now: new Date('2026-04-20T09:10:11+08:00'),
  });
  assert.equal(title, '苏州门店复盘群-20260420-张三');
});

test('buildFeishuReviewDocumentTitle falls back to audioFileName-date', () => {
  const title = buildFeishuReviewDocumentTitle({
    chatName: '',
    senderDisplayName: '',
    audioFileName: '客户初诊录音.m4a',
    now: new Date('2026-04-20T09:10:11+08:00'),
  });
  assert.equal(title, '客户初诊录音.m4a-20260420');
});

test('convertMarkdownToFeishuDocBlocks maps heading, paragraph, list, and quote', () => {
  const blocks = convertMarkdownToFeishuDocBlocks(
    '## 综合评估\n普通段落\n- 亮点一\n> 重点提醒',
  );
  assert.equal(blocks[0].type, 'heading2');
  assert.equal(blocks[1].type, 'paragraph');
  assert.equal(blocks[2].type, 'bullet');
  assert.equal(blocks[3].type, 'quote');
});

test('createFeishuReviewDocument uses chat and sender metadata when available', async () => {
  let appendedBlocks = null;
  const result = await createFeishuReviewDocument(
    {
      docsConfig: { enabled: true, folderToken: 'folder_x', timezone: 'Asia/Shanghai', maxTitleLength: 100 },
      botConfig: { requestTimeoutMs: 20000 },
      context: {
        chatId: 'oc_chat',
        senderId: 'ou_sender',
        audioFileName: '试听.m4a',
        now: new Date('2026-04-20T09:10:11+08:00'),
        reportMarkdown: '## 综合评估\n正常',
      },
    },
    {
      resolveChatName: async () => '苏州门店复盘群',
      resolveSenderDisplayName: async () => '张三',
      createDocumentInFolder: async ({ title }) => ({
        documentToken: 'doc_x',
        documentUrl: `https://example.com/doc/${encodeURIComponent(title)}`,
      }),
      appendBlocksToDocument: async ({ blocks }) => {
        appendedBlocks = blocks;
      },
    },
  );

  assert.equal(result.title, '苏州门店复盘群-20260420-张三');
  assert.equal(result.documentToken, 'doc_x');
  assert.equal(result.documentUrl, 'https://example.com/doc/%E8%8B%8F%E5%B7%9E%E9%97%A8%E5%BA%97%E5%A4%8D%E7%9B%98%E7%BE%A4-20260420-%E5%BC%A0%E4%B8%89');
  assert.equal(result.fallbackUsed, false);
  assert.equal(appendedBlocks[0].type, 'heading2');
});

test('createFeishuReviewDocument falls back to audio filename when chat metadata is unavailable', async () => {
  const result = await createFeishuReviewDocument(
    {
      docsConfig: { enabled: true, folderToken: 'folder_x', timezone: 'Asia/Shanghai', maxTitleLength: 100 },
      botConfig: { requestTimeoutMs: 20000 },
      context: {
        chatId: 'oc_chat',
        senderId: 'ou_sender',
        audioFileName: '客户首咨.m4a',
        now: new Date('2026-04-20T09:10:11+08:00'),
        reportMarkdown: '## 综合评估\n正常',
      },
    },
    {
      resolveChatName: async () => '',
      resolveSenderDisplayName: async () => '',
      createDocumentInFolder: async ({ title }) => ({
        documentToken: 'doc_y',
        documentUrl: `https://example.com/doc/${encodeURIComponent(title)}`,
      }),
      appendBlocksToDocument: async () => undefined,
    },
  );

  assert.equal(result.title, '客户首咨.m4a-20260420');
  assert.equal(result.documentToken, 'doc_y');
  assert.equal(result.fallbackUsed, true);
});
