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
