const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function read(filePath) {
  return fs.readFileSync(path.join(ROOT, filePath), 'utf8');
}

test('Anthropic defaults target Claude Opus 4.6 with configurable max output tokens', () => {
  const serverJs = read('server.js');
  assert.match(serverJs, /model:\s*'claude-opus-4-6'/);
  assert.match(serverJs, /assignIfDefined\(provider,\s*'max_tokens',\s*readEnvNumber\(`\$\{prefix\}_MAX_TOKENS`\)\)/);
  assert.match(serverJs, /model:\s*provider\.model\s*\|\|\s*'claude-opus-4-6'/);
  assert.match(serverJs, /max_tokens:\s*provider\.max_tokens\s*\|\|\s*128000/);
});

test('Checked-in AI config defaults to Claude Opus 4.6 with 128000 max output tokens', () => {
  const configText = read('config/ai.config.json');
  const config = JSON.parse(configText);
  assert.equal(config.providers.anthropic.model, 'claude-opus-4-6');
  assert.equal(config.providers.anthropic.max_tokens, 128000);
});
