const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function read(filePath) {
  return fs.readFileSync(path.join(ROOT, filePath), 'utf8');
}

test('server defaults and env overrides only keep Doubao STT provider', () => {
  const serverJs = read('server.js');
  assert.match(serverJs, /active_provider:\s*'doubao_asr_2'/);
  assert.match(serverJs, /doubao_asr_2:\s*\{/);
  assert.match(serverJs, /applySttProviderEnv\(config,\s*'doubao_asr_2',\s*'STT_DOUBAO_ASR_2'\)/);
  assert.doesNotMatch(serverJs, /qwen_fun_asr/);
  assert.doesNotMatch(serverJs, /dashscope-fun-asr/);
  assert.doesNotMatch(serverJs, /deepgram/);
});

test('checked-in env templates only expose Doubao STT settings', () => {
  const envExample = read('.env.example');
  const deployEnvExample = read('deploy/volcengine/lumo-review.env.example');
  assert.match(envExample, /^STT_ACTIVE_PROVIDER=doubao_asr_2$/m);
  assert.doesNotMatch(envExample, /STT_QWEN_FUN_ASR_/);
  assert.doesNotMatch(envExample, /qwen_fun_asr/);
  assert.doesNotMatch(deployEnvExample, /STT_QWEN_FUN_ASR_/);
  assert.doesNotMatch(deployEnvExample, /qwen_fun_asr/);
});
