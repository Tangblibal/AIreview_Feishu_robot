const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseFeishuMessageContent,
  extractFeishuTextFromContent,
  extractFeishuFileFromContent,
  resolveFeishuResourceType,
  mergeTranscriptWithTextInput,
  formatFeishuBotReply,
  formatFeishuDocReply,
  formatFeishuDocFailureFallback,
  buildFeishuReviewReply,
} = require('../feishu-bot');

test('parseFeishuMessageContent parses valid JSON string', () => {
  const parsed = parseFeishuMessageContent('{"text":"你好"}');
  assert.equal(parsed.text, '你好');
});

test('extractFeishuTextFromContent supports text and post messages', () => {
  const text = extractFeishuTextFromContent('text', '{"text":"门店备注"}');
  assert.equal(text, '门店备注');

  const post = extractFeishuTextFromContent(
    'post',
    JSON.stringify({
      post: {
        zh_cn: {
          content: [[{ tag: 'text', text: '客户预算' }, { tag: 'text', text: ' 8000' }]],
        },
      },
    }),
  );
  assert.equal(post, '客户预算 8000');
});

test('extractFeishuFileFromContent returns file key for audio/file messages', () => {
  const audio = extractFeishuFileFromContent('audio', '{"file_key":"audio_key_xxx","file_name":"试听.m4a"}');
  assert.equal(audio.fileKey, 'audio_key_xxx');
  assert.equal(audio.fileName, '试听.m4a');

  const file = extractFeishuFileFromContent('file', '{"file_key":"file_key_xxx","file_name":"咨询录音.mp3"}');
  assert.equal(file.fileKey, 'file_key_xxx');
  assert.equal(file.fileName, '咨询录音.mp3');
});

test('resolveFeishuResourceType maps message type to API type', () => {
  assert.equal(resolveFeishuResourceType('audio'), 'audio');
  assert.equal(resolveFeishuResourceType('file'), 'file');
  assert.equal(resolveFeishuResourceType('image'), 'file');
});

test('mergeTranscriptWithTextInput combines supplemental text and transcript', () => {
  const merged = mergeTranscriptWithTextInput('销售: 你好\n客户: 想看套餐', '客户是老客转介绍');
  assert.match(merged, /用户补充说明：客户是老客转介绍/);
  assert.match(merged, /语音转写：/);
});

test('formatFeishuBotReply formats scores and truncates safely', () => {
  const longMarkdown = 'A'.repeat(5000);
  const message = formatFeishuBotReply({
    report: {
      total: 88,
      status: '完成',
      report_markdown: longMarkdown,
    },
    textInput: '客户偏韩式清透风',
    maxLength: 400,
  });

  assert.match(message, /销售复盘已完成。/);
  assert.match(message, /综合评分：88 分/);
  assert.match(message, /补充文字：客户偏韩式清透风/);
  assert.ok(message.length <= 400);
});

test('formatFeishuDocReply includes title, score, and document url', () => {
  const text = formatFeishuDocReply({
    title: '苏州门店复盘群-20260420-张三',
    url: 'https://acnujre61sh3.feishu.cn/docx/abc',
    score: 88,
    status: '完成',
  });

  assert.match(text, /销售复盘已完成/);
  assert.match(text, /苏州门店复盘群-20260420-张三/);
  assert.match(text, /88/);
  assert.match(text, /https:\/\/acnujre61sh3\.feishu\.cn\/docx\/abc/);
});

test('formatFeishuDocFailureFallback keeps reply short and uses report summary first', () => {
  const text = formatFeishuDocFailureFallback({
    report: {
      total: 91,
      status: '完成',
      report_markdown: '## 综合评估\n整体跟进节奏稳定，客户对套餐价格敏感。',
    },
    transcript: '销售: 介绍套餐\n客户: 价格有点高',
    textInput: '客户是老客转介绍',
    maxLength: 120,
  });

  assert.match(text, /销售复盘已完成。/);
  assert.match(text, /综合评分：91 分/);
  assert.match(text, /状态：完成/);
  assert.match(text, /整体跟进节奏稳定/);
  assert.ok(text.length <= 120);
});

test('buildFeishuReviewReply uses document link reply when docs are enabled and creation succeeds', async () => {
  const reply = await buildFeishuReviewReply(
    {
      docsConfig: {
        enabled: true,
        folderToken: 'folder_x',
        timezone: 'Asia/Shanghai',
        maxTitleLength: 100,
      },
      botConfig: {
        replyMaxLength: 400,
        requestTimeoutMs: 20000,
      },
      token: 'tenant_x',
      result: {
        report: {
          total: 88,
          status: '完成',
          report_markdown: '## 综合评估\n整体转化把控较稳。',
        },
        transcript: '销售: 介绍套餐',
      },
      textInput: '客户预算 8k',
      context: {
        chatId: 'oc_chat',
        senderId: 'ou_sender',
        audioFileName: '试听.m4a',
        now: new Date('2026-04-20T09:10:11+08:00'),
      },
    },
    {
      createFeishuReviewDocument: async () => ({
        title: '苏州门店复盘群-20260420-张三',
        documentToken: 'doc_x',
        documentUrl: 'https://feishu.cn/docx/doc_x',
      }),
    },
  );

  assert.equal(reply.mode, 'doc_link');
  assert.match(reply.replyText, /https:\/\/feishu\.cn\/docx\/doc_x/);
  assert.equal(reply.document.title, '苏州门店复盘群-20260420-张三');
});

test('buildFeishuReviewReply falls back to short text when document creation fails', async () => {
  const reply = await buildFeishuReviewReply(
    {
      docsConfig: {
        enabled: true,
        folderToken: 'folder_x',
        timezone: 'Asia/Shanghai',
        maxTitleLength: 100,
      },
      botConfig: {
        replyMaxLength: 200,
        requestTimeoutMs: 20000,
      },
      token: 'tenant_x',
      result: {
        report: {
          total: 92,
          status: '完成',
          report_markdown: '## 综合评估\n整体沟通比较顺畅，报价阶段需要更早收口。',
        },
        transcript: '销售: 介绍套餐',
      },
      textInput: '老客转介绍',
      context: {
        chatId: 'oc_chat',
        senderId: 'ou_sender',
        audioFileName: '试听.m4a',
        now: new Date('2026-04-20T09:10:11+08:00'),
      },
    },
    {
      createFeishuReviewDocument: async () => {
        throw new Error('folder not found');
      },
    },
  );

  assert.equal(reply.mode, 'text_fallback');
  assert.match(reply.replyText, /销售复盘已完成。/);
  assert.match(reply.replyText, /综合评分：92 分/);
  assert.match(reply.replyText, /整体沟通比较顺畅/);
  assert.match(reply.error.message, /folder not found/);
});

test('buildFeishuReviewReply keeps existing text reply when docs are disabled', async () => {
  const reply = await buildFeishuReviewReply({
    docsConfig: {
      enabled: false,
      folderToken: '',
    },
    botConfig: {
      replyMaxLength: 220,
      requestTimeoutMs: 20000,
    },
    token: 'tenant_x',
    result: {
      report: {
        total: 86,
        status: '完成',
        report_markdown: '## 综合评估\n原有文本回复路径。',
      },
      transcript: '销售: 介绍套餐',
    },
    textInput: '客户预算 6k',
    context: {
      chatId: 'oc_chat',
      senderId: 'ou_sender',
      audioFileName: '试听.m4a',
      now: new Date('2026-04-20T09:10:11+08:00'),
    },
  });

  assert.equal(reply.mode, 'text');
  assert.match(reply.replyText, /销售复盘已完成。/);
  assert.match(reply.replyText, /原有文本回复路径/);
});
