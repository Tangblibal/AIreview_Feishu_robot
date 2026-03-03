const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function read(filePath) {
  return fs.readFileSync(path.join(ROOT, filePath), 'utf8');
}

test('server default max audio upload size is 200MB', () => {
  const serverJs = read('server.js');
  assert.match(serverJs, /MAX_AUDIO_FILE_SIZE_MB\s*=\s*Number\(process\.env\.MAX_AUDIO_FILE_SIZE_MB\s*\|\|\s*200\)/);
  assert.match(serverJs, /:\s*200\s*\*\s*1024\s*\*\s*1024/);
});

test('env templates set max audio upload size to 200MB', () => {
  const envExample = read('.env.example');
  const deployEnvExample = read('deploy/volcengine/lumo-review.env.example');
  assert.match(envExample, /^MAX_AUDIO_FILE_SIZE_MB=200$/m);
  assert.match(deployEnvExample, /^MAX_AUDIO_FILE_SIZE_MB=200$/m);
});

test('nginx body size is above backend limit for multipart overhead', () => {
  const nginxConf = read('deploy/volcengine/nginx.app.qjgroup.top.conf');
  assert.match(nginxConf, /client_max_body_size\s+220m;/);
});
