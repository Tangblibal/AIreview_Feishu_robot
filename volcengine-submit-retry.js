function parseRetryAfterMs(retryAfterValue) {
  const raw = `${retryAfterValue || ''}`.trim();
  if (!raw) return 0;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const dateMs = Date.parse(raw);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }
  return 0;
}

function isRateLimitedResponse({ status, apiCode, apiMessage, bodyText }) {
  if (Number(status) === 429) return true;
  const text = `${apiMessage || ''} ${bodyText || ''}`.toLowerCase();
  if (
    text.includes('too many') ||
    text.includes('rate limit') ||
    text.includes('throttle') ||
    text.includes('频率') ||
    text.includes('限流')
  ) {
    return true;
  }
  if (apiCode && ['20000029', '20000030', '429'].includes(`${apiCode}`)) return true;
  return false;
}

function isQuotaExhausted({ apiMessage, bodyText }) {
  const text = `${apiMessage || ''} ${bodyText || ''}`.toLowerCase();
  return text.includes('quota exceeded') || text.includes('audio_duration_lifetime');
}

function buildBackoffMs(attempt, baseMs, maxBackoffMs) {
  const safeBase = Math.max(100, Number(baseMs) || 1000);
  const safeMax = Math.max(safeBase, Number(maxBackoffMs) || 15000);
  const factor = 2 ** Math.max(0, attempt - 1);
  return Math.min(safeMax, safeBase * factor);
}

async function submitVolcengineRequestWithRetry({
  fetchImpl,
  sleepImpl,
  submitUrl,
  headers,
  payload,
  maxAttempts = 4,
  retryBaseMs = 1200,
  retryMaxBackoffMs = 15000,
}) {
  const fetchFn = fetchImpl || fetch;
  const sleepFn = sleepImpl || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const attempts = Math.max(1, Number(maxAttempts) || 1);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await fetchFn(submitUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    const apiCode = response.headers?.get?.('x-api-status-code') || '';
    const apiMessage = response.headers?.get?.('x-api-message') || '';
    const bodyText = response.ok ? '' : await response.text().catch(() => '');
    const rateLimited = isRateLimitedResponse({
      status: response.status,
      apiCode,
      apiMessage,
      bodyText,
    });
    const quotaExhausted = isQuotaExhausted({ apiMessage, bodyText });

    if (response.ok && (!apiCode || apiCode === '20000000')) {
      return;
    }

    if (quotaExhausted) {
      const error = new Error(`Volcengine quota exhausted: ${apiMessage || bodyText || 'quota exceeded'}`);
      error.code = 'VOLCENGINE_QUOTA_EXCEEDED';
      error.status = response.status || 429;
      throw error;
    }

    if (rateLimited && attempt < attempts) {
      const retryAfterMs = parseRetryAfterMs(response.headers?.get?.('retry-after'));
      const delayMs = retryAfterMs > 0 ? retryAfterMs : buildBackoffMs(attempt, retryBaseMs, retryMaxBackoffMs);
      await sleepFn(delayMs);
      continue;
    }

    const details = apiMessage || bodyText || `${response.status}`;
    if (rateLimited) {
      const error = new Error(`Volcengine submit rate limited: ${details}`);
      error.code = 'VOLCENGINE_RATE_LIMITED';
      error.status = response.status || 429;
      throw error;
    }

    if (!response.ok) {
      const error = new Error(`Volcengine submit error: ${response.status}`);
      error.status = response.status;
      throw error;
    }

    const error = new Error(`${apiMessage || 'Volcengine submit failed'} (${apiCode || 'unknown'})`);
    error.code = apiCode || 'VOLCENGINE_SUBMIT_FAILED';
    throw error;
  }

  const error = new Error('Volcengine submit failed');
  error.code = 'VOLCENGINE_SUBMIT_FAILED';
  throw error;
}

module.exports = {
  parseRetryAfterMs,
  submitVolcengineRequestWithRetry,
};
