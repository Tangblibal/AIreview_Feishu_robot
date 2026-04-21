const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const serverJs = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('server distinguishes Volcengine timeout and empty-result failures for bot replies', () => {
  assert.match(serverJs, /VOLCENGINE_ASR_TIMEOUT/);
  assert.match(serverJs, /VOLCENGINE_EMPTY_RESULT/);
  assert.match(serverJs, /语音转写超时/);
  assert.match(serverJs, /语音转写未产出可用文本/);
});

test('server logs structured STT debug summary when Volcengine transcription fails', () => {
  assert.match(serverJs, /\[stt\] request_id=/);
  assert.match(serverJs, /last_status=/);
  assert.match(serverJs, /utterance_count=/);
});
