const test = require('node:test');
const assert = require('node:assert/strict');

const { claimInMemoryMessageDedup, buildFeishuMessageDedupKey } = require('../feishu-bot-dedup');

test('buildFeishuMessageDedupKey creates stable redis key', () => {
  const key = buildFeishuMessageDedupKey('feishu_bot_msg', 'om_dc13264520392913993dd051dba21dcf');
  assert.equal(key, 'feishu_bot_msg:message:om_dc13264520392913993dd051dba21dcf');
});

test('claimInMemoryMessageDedup only allows first claim within ttl window', () => {
  const dedupStore = new Map();
  const dedupKey = 'feishu_bot_msg:message:msg_001';
  const now = Date.UTC(2026, 2, 1, 4, 0, 0);

  const first = claimInMemoryMessageDedup(dedupStore, dedupKey, 60, now);
  const second = claimInMemoryMessageDedup(dedupStore, dedupKey, 60, now + 10 * 1000);

  assert.equal(first, true);
  assert.equal(second, false);
});

test('claimInMemoryMessageDedup allows claim again after ttl expires', () => {
  const dedupStore = new Map();
  const dedupKey = 'feishu_bot_msg:message:msg_002';
  const now = Date.UTC(2026, 2, 1, 4, 0, 0);

  const first = claimInMemoryMessageDedup(dedupStore, dedupKey, 30, now);
  const afterExpiry = claimInMemoryMessageDedup(dedupStore, dedupKey, 30, now + 31 * 1000);

  assert.equal(first, true);
  assert.equal(afterExpiry, true);
});
