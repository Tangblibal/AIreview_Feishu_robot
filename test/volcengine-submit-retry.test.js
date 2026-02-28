const test = require('node:test');
const assert = require('node:assert/strict');

const { submitVolcengineRequestWithRetry } = require('../volcengine-submit-retry');

function createHeaders(map = {}) {
  const lower = Object.fromEntries(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    get(name) {
      return lower[String(name || '').toLowerCase()] || null;
    },
  };
}

function createResponse({ ok, status, headers = {}, body = '' }) {
  return {
    ok,
    status,
    headers: createHeaders(headers),
    async text() {
      return body;
    },
  };
}

test('submitVolcengineRequestWithRetry retries when first attempt is HTTP 429', async () => {
  const calls = [];
  const sleeps = [];
  const fetchImpl = async () => {
    calls.push(Date.now());
    if (calls.length === 1) {
      return createResponse({
        ok: false,
        status: 429,
        headers: { 'retry-after': '1', 'x-api-message': 'Too many requests' },
      });
    }
    return createResponse({
      ok: true,
      status: 200,
      headers: { 'x-api-status-code': '20000000' },
    });
  };

  await submitVolcengineRequestWithRetry({
    fetchImpl,
    sleepImpl: async (ms) => sleeps.push(ms),
    submitUrl: 'https://example.com/submit',
    headers: { Authorization: 'x' },
    payload: { foo: 'bar' },
    maxAttempts: 3,
    retryBaseMs: 500,
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(sleeps, [1000]);
});

test('submitVolcengineRequestWithRetry throws friendly rate-limit error after exhausting retries', async () => {
  const fetchImpl = async () =>
    createResponse({
      ok: false,
      status: 429,
      headers: { 'x-api-message': 'too many requests' },
      body: 'rate limited',
    });

  await assert.rejects(
    submitVolcengineRequestWithRetry({
      fetchImpl,
      sleepImpl: async () => {},
      submitUrl: 'https://example.com/submit',
      headers: {},
      payload: {},
      maxAttempts: 2,
      retryBaseMs: 10,
    }),
    (error) => {
      assert.equal(error.code, 'VOLCENGINE_RATE_LIMITED');
      assert.match(error.message, /rate limit/i);
      return true;
    },
  );
});

test('submitVolcengineRequestWithRetry does not retry when quota lifetime is exhausted', async () => {
  let count = 0;
  const fetchImpl = async () => {
    count += 1;
    return createResponse({
      ok: false,
      status: 429,
      headers: { 'x-api-message': 'quota exceeded for types: audio_duration_lifetime' },
      body: 'quota exceeded',
    });
  };

  await assert.rejects(
    submitVolcengineRequestWithRetry({
      fetchImpl,
      sleepImpl: async () => {},
      submitUrl: 'https://example.com/submit',
      headers: {},
      payload: {},
      maxAttempts: 4,
      retryBaseMs: 10,
    }),
    (error) => {
      assert.equal(error.code, 'VOLCENGINE_QUOTA_EXCEEDED');
      assert.match(error.message, /quota/i);
      return true;
    },
  );
  assert.equal(count, 1);
});
