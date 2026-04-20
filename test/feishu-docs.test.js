const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildFeishuReviewDocumentTitle,
  convertMarkdownToFeishuDocBlocks,
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
