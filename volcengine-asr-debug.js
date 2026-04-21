function getPrimaryResult(data) {
  if (Array.isArray(data?.result)) return data.result[0] || null;
  return data?.result || null;
}

function summarizeVolcenginePollState({ requestId, lastCode, lastMessage, lastData } = {}) {
  const result = getPrimaryResult(lastData);
  const text = typeof result?.text === 'string' ? result.text : '';
  const utterances = Array.isArray(result?.utterances) ? result.utterances : [];
  const rawStatus = `${result?.status || lastData?.status || ''}`.trim();
  const lastStatus = rawStatus.toLowerCase();

  return {
    requestId: `${requestId || ''}`.trim(),
    lastCode: `${lastCode || ''}`.trim(),
    lastMessage: `${lastMessage || ''}`.trim(),
    lastStatus,
    textLength: text.trim().length,
    utteranceCount: utterances.length,
    hasResult: Boolean(result),
    raw: lastData || null,
  };
}

function isCompletedStatus(status = '') {
  return /success|succeed|complete|completed|done|finish|finished/.test(`${status || ''}`);
}

function classifyVolcengineAsrFailure(summary = {}) {
  const status = `${summary?.lastStatus || ''}`;
  const hasContent = Number(summary?.textLength || 0) > 0 || Number(summary?.utteranceCount || 0) > 0;

  if (hasContent) {
    return {
      code: 'VOLCENGINE_ASR_FAILED',
      message: 'Volcengine ASR failed with unexpected state.',
      status: 502,
    };
  }

  if (isCompletedStatus(status)) {
    return {
      code: 'VOLCENGINE_EMPTY_RESULT',
      message: 'Volcengine ASR returned empty result.',
      status: 502,
    };
  }

  return {
    code: 'VOLCENGINE_ASR_TIMEOUT',
    message: 'Volcengine ASR timed out while processing audio.',
    status: 504,
  };
}

module.exports = {
  summarizeVolcenginePollState,
  classifyVolcengineAsrFailure,
};
