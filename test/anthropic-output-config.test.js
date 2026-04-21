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

test('Review pipeline now treats model output as markdown instead of strict JSON', () => {
  const serverJs = read('server.js');
  assert.match(serverJs, /function normalizeReportMarkdown\(markdown\)/);
  assert.match(serverJs, /report_markdown:\s*cleanMarkdown/);
  assert.match(serverJs, /status:\s*cleanMarkdown \? '完成' : '复盘结果为空，请检查模型输出。'/);
  assert.match(serverJs, /请直接输出完整 Markdown 复盘正文，不要 JSON/);
  assert.doesNotMatch(serverJs, /response_format = \{ type: 'json_object' \}/);
});

test('Feishu docs flow no longer depends on folder token gate in server handler', () => {
  const serverJs = read('server.js');
  assert.match(serverJs, /if \(docsConfig\.enabled\) \{/);
  assert.doesNotMatch(serverJs, /docsConfig\.enabled && docsConfig\.folderToken/);
});

test('Anthropic defaults include upstream retry controls for 524 and similar gateway failures', () => {
  const serverJs = read('server.js');
  const envExample = read('.env.example');

  assert.match(serverJs, /retry_attempts:\s*2/);
  assert.match(serverJs, /retry_backoff_ms:\s*3000/);
  assert.match(serverJs, /retry_reduced_max_tokens:\s*32768/);
  assert.match(serverJs, /assignIfDefined\(provider,\s*'retry_attempts',\s*readEnvNumber\(`\$\{prefix\}_RETRY_ATTEMPTS`\)\)/);
  assert.match(serverJs, /assignIfDefined\(provider,\s*'retry_backoff_ms',\s*readEnvNumber\(`\$\{prefix\}_RETRY_BACKOFF_MS`\)\)/);
  assert.match(
    serverJs,
    /assignIfDefined\(provider,\s*'retry_reduced_max_tokens',\s*readEnvNumber\(`\$\{prefix\}_RETRY_REDUCED_MAX_TOKENS`\)\)/,
  );
  assert.match(serverJs, /function shouldRetryForUpstreamError\(error\)/);
  assert.match(serverJs, /message\.includes\('524'\)/);
  assert.match(serverJs, /Math\.min\(provider\.max_tokens \|\| 128000,\s*provider\.retry_reduced_max_tokens \|\| 32768\)/);

  assert.match(envExample, /^ANTHROPIC_RETRY_ATTEMPTS=2$/m);
  assert.match(envExample, /^ANTHROPIC_RETRY_BACKOFF_MS=3000$/m);
  assert.match(envExample, /^ANTHROPIC_RETRY_REDUCED_MAX_TOKENS=32768$/m);
});

test('Anthropic requests use streaming responses to avoid gateway idle timeout', () => {
  const serverJs = read('server.js');
  assert.match(serverJs, /const \{ readAnthropicMessageStream \} = require\('\.\/anthropic-stream'\);/);
  assert.match(serverJs, /stream:\s*true/);
  assert.match(serverJs, /return readAnthropicMessageStream\(response\.body\);/);
  assert.match(serverJs, /if \(result\?\.stopReason !== 'max_tokens'\) \{/);
  assert.match(serverJs, /请从刚才中断的位置继续输出剩余 Markdown 正文/);
});

test('Checked-in AI config defaults to Claude Opus 4.6 with 128000 max output tokens', () => {
  const configText = read('config/ai.config.json');
  const config = JSON.parse(configText);
  assert.equal(config.providers.anthropic.model, 'claude-opus-4-6');
  assert.equal(config.providers.anthropic.max_tokens, 128000);
});
