const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function read(filePath) {
  return fs.readFileSync(path.join(ROOT, filePath), 'utf8');
}

test('Anthropic error handling includes upstream response body for debugging', () => {
  const serverJs = read('server.js');
  assert.match(serverJs, /const errorText = await response\.text\(\)\.catch\(\(\) => ''\);/);
  assert.match(serverJs, /throw new Error\(`Anthropic API error: \$\{response\.status\} \$\{errorText\}`\.trim\(\)\);/);
});
