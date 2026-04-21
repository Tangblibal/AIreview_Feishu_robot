const test = require('node:test');
const assert = require('node:assert/strict');

const {
  summarizeVolcenginePollState,
  classifyVolcengineAsrFailure,
} = require('../volcengine-asr-debug');

test('summarizeVolcenginePollState extracts status and empty result counters', () => {
  const summary = summarizeVolcenginePollState({
    requestId: 'req_123',
    lastCode: '20000000',
    lastMessage: '',
    lastData: {
      result: {
        status: 'completed',
        text: '',
        utterances: [],
      },
    },
  });

  assert.equal(summary.requestId, 'req_123');
  assert.equal(summary.lastCode, '20000000');
  assert.equal(summary.lastStatus, 'completed');
  assert.equal(summary.textLength, 0);
  assert.equal(summary.utteranceCount, 0);
  assert.equal(summary.hasResult, true);
});

test('classifyVolcengineAsrFailure returns empty-result code for completed but empty payload', () => {
  const failure = classifyVolcengineAsrFailure({
    lastStatus: 'completed',
    textLength: 0,
    utteranceCount: 0,
  });

  assert.deepEqual(failure, {
    code: 'VOLCENGINE_EMPTY_RESULT',
    message: 'Volcengine ASR returned empty result.',
    status: 502,
  });
});

test('classifyVolcengineAsrFailure returns timeout code for still-processing payload', () => {
  const failure = classifyVolcengineAsrFailure({
    lastStatus: 'processing',
    textLength: 0,
    utteranceCount: 0,
  });

  assert.deepEqual(failure, {
    code: 'VOLCENGINE_ASR_TIMEOUT',
    message: 'Volcengine ASR timed out while processing audio.',
    status: 504,
  });
});
