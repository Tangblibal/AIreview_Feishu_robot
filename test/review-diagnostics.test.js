const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const serverJs = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const feishuDocsJs = fs.readFileSync(path.join(__dirname, '..', 'feishu-docs.js'), 'utf8');

test('review pipeline logs transcript and report lengths for diagnostics', () => {
  assert.match(serverJs, /\[review_pipeline\].*transcript_length=/);
  assert.match(serverJs, /\[review_pipeline\].*report_length=/);
});

test('feishu docs logs block diagnostics before append', () => {
  assert.match(feishuDocsJs, /\[feishu_docs\].*block_count=/);
  assert.match(feishuDocsJs, /\[feishu_docs\].*batch_index=/);
});
