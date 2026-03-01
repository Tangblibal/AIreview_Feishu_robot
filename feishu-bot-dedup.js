function buildFeishuMessageDedupKey(prefix, messageId) {
  const safePrefix = `${prefix || 'feishu_bot_msg'}`.trim() || 'feishu_bot_msg';
  const safeMessageId = `${messageId || ''}`.trim();
  if (!safeMessageId) return '';
  return `${safePrefix}:message:${safeMessageId}`;
}

function claimInMemoryMessageDedup(store, key, ttlSec, nowMs = Date.now()) {
  if (!store || !(store instanceof Map) || !key) return true;
  const ttlSeconds = Number.isFinite(Number(ttlSec)) ? Math.max(30, Number(ttlSec)) : 600;
  const existing = store.get(key);
  if (existing && existing.expiresAt > nowMs) {
    return false;
  }
  store.set(key, {
    status: 'processing',
    updatedAt: nowMs,
    expiresAt: nowMs + ttlSeconds * 1000,
  });
  return true;
}

function updateInMemoryMessageDedupStatus(store, key, status, ttlSec, nowMs = Date.now(), extra = {}) {
  if (!store || !(store instanceof Map) || !key) return;
  const ttlSeconds = Number.isFinite(Number(ttlSec)) ? Math.max(30, Number(ttlSec)) : 600;
  const existing = store.get(key) || {};
  store.set(key, {
    ...existing,
    ...extra,
    status,
    updatedAt: nowMs,
    expiresAt: nowMs + ttlSeconds * 1000,
  });
}

module.exports = {
  buildFeishuMessageDedupKey,
  claimInMemoryMessageDedup,
  updateInMemoryMessageDedupStatus,
};
