const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function read(filePath) {
  return fs.readFileSync(path.join(ROOT, filePath), 'utf8');
}

test('server review fallback uses empty-safe status instead of sample report copy', () => {
  const serverJs = read('server.js');
  assert.match(serverJs, /status:\s*'复盘结果为空，请检查模型输出。'/);
  assert.doesNotMatch(serverJs, /销售急于成交，但价值锚点未建立/);
  assert.doesNotMatch(serverJs, /主动给出风格方向选择，缩短客户思考路径/);
});

test('frontend real review rendering does not fall back to mock report content', () => {
  const appJs = read('app.js');
  assert.match(appJs, /setRingScore\(totalScoreValue,\s*Number\.isFinite\(totalScoreValue\)\)/);
  assert.doesNotMatch(appJs, /data\.report\?\.need \|\| mockReport\.need/);
  assert.doesNotMatch(appJs, /data\.report\?\.insights \|\| mockReport\.insights/);
});
