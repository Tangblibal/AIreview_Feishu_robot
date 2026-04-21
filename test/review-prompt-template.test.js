const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { REVIEW_PROMPT_TEMPLATE_PATH, buildReviewPrompt } = require('../review-prompt');

test('review prompt template file exists and includes all dynamic placeholders', () => {
  assert.equal(fs.existsSync(REVIEW_PROMPT_TEMPLATE_PATH), true);
  const template = fs.readFileSync(REVIEW_PROMPT_TEMPLATE_PATH, 'utf8');
  assert.match(template, /\$\{salesContextBlock\}/);
  assert.match(template, /\$\{templateBlock\}/);
  assert.match(template, /\$\{transcriptText\}/);
});

test('buildReviewPrompt loads template file and replaces placeholders', () => {
  const prompt = buildReviewPrompt({
    salesContextBlock: '成交信息：已成交',
    templateBlock: '- 需求挖掘: 风格、预算',
    transcriptText: '销售：您好\\n客户：想拍写真',
  });

  assert.match(prompt, /成交信息：已成交/);
  assert.match(prompt, /- 需求挖掘: 风格、预算/);
  assert.match(prompt, /销售：您好\\n客户：想拍写真/);
  assert.doesNotMatch(prompt, /\$\{salesContextBlock\}/);
  assert.doesNotMatch(prompt, /\$\{templateBlock\}/);
  assert.doesNotMatch(prompt, /\$\{transcriptText\}/);
});

test('review prompt template no longer requires JSON output', () => {
  const template = fs.readFileSync(REVIEW_PROMPT_TEMPLATE_PATH, 'utf8');
  assert.match(template, /请直接输出完整 Markdown 复盘正文，不要 JSON/);
  assert.doesNotMatch(template, /必须输出 JSON/);
  assert.doesNotMatch(template, /"report_markdown": string/);
});
