const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildReviewDebugArtifactPath, writeReviewDebugArtifact } = require('../review-debug-export');

test('buildReviewDebugArtifactPath sanitizes request id and uses json extension', () => {
  const filePath = buildReviewDebugArtifactPath('/tmp/review-debug', 'ws:abc/123');
  assert.equal(filePath, '/tmp/review-debug/ws_abc_123.json');
});

test('writeReviewDebugArtifact writes report markdown payload when export dir is enabled', async () => {
  const exportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-debug-'));

  const result = await writeReviewDebugArtifact({
    exportDir,
    requestId: 'ws_test_123',
    provider: { type: 'anthropic', model: 'claude-opus-4-6' },
    transcript: '销售：您好',
    enrichedTranscript: '销售：您好',
    prompt: 'prompt body',
    report: { status: '完成', report_markdown: '## 综合评估\n内容完整' },
  });

  assert.equal(result.written, true);
  assert.equal(result.filePath, path.join(exportDir, 'ws_test_123.json'));

  const payload = JSON.parse(fs.readFileSync(result.filePath, 'utf8'));
  assert.equal(payload.request_id, 'ws_test_123');
  assert.equal(payload.provider.type, 'anthropic');
  assert.equal(payload.provider.model, 'claude-opus-4-6');
  assert.equal(payload.lengths.transcript, 5);
  assert.equal(payload.lengths.prompt, 11);
  assert.equal(payload.report.report_markdown, '## 综合评估\n内容完整');
});

test('writeReviewDebugArtifact no-ops when export dir is disabled', async () => {
  const result = await writeReviewDebugArtifact({
    exportDir: '',
    requestId: 'ws_test_disabled',
    provider: { type: 'anthropic', model: 'claude-opus-4-6' },
    transcript: 'x',
    enrichedTranscript: 'x',
    prompt: 'x',
    report: { status: '完成', report_markdown: 'x' },
  });

  assert.deepEqual(result, { written: false, reason: 'disabled' });
});
