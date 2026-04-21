const test = require('node:test');
const assert = require('node:assert/strict');
const { ReadableStream } = require('node:stream/web');

const {
  extractAnthropicStreamEventText,
  extractAnthropicStreamEventMeta,
  readAnthropicMessageStream,
} = require('../anthropic-stream');

test('extractAnthropicStreamEventText returns delta text from content_block_delta event', () => {
  const eventBlock = [
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}',
    '',
  ].join('\n');

  assert.equal(extractAnthropicStreamEventText(eventBlock), '你好');
});

test('extractAnthropicStreamEventText returns initial text from content_block_start event', () => {
  const eventBlock = [
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"{"}}',
    '',
  ].join('\n');

  assert.equal(extractAnthropicStreamEventText(eventBlock), '{');
});

test('extractAnthropicStreamEventMeta returns stop reason from message_delta event', () => {
  const eventBlock = [
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"}}',
    '',
  ].join('\n');

  assert.deepEqual(extractAnthropicStreamEventMeta(eventBlock), { stopReason: 'max_tokens' });
});

test('readAnthropicMessageStream concatenates Anthropic SSE text deltas across chunks', async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(
        Buffer.from(
          [
            'event: message_start\n',
            'data: {"type":"message_start"}\n\n',
            'event: content_block_start\n',
            'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"{"}}\n\n',
            'event: content_block_delta\n',
            'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"\\"ok\\":"}}\n\n',
          ].join(''),
        ),
      );
      controller.enqueue(
        Buffer.from(
          [
            'event: ping\r\n',
            'data: {"type":"ping"}\r\n\r\n',
            'event: content_block_delta\r\n',
            'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"true}"}}\r\n\r\n',
            'event: message_delta\r\n',
            'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\r\n\r\n',
            'event: message_stop\r\n',
            'data: {"type":"message_stop"}\r\n\r\n',
          ].join(''),
        ),
      );
      controller.close();
    },
  });

  const result = await readAnthropicMessageStream(stream);
  assert.equal(result.text, '{"ok":true}');
  assert.equal(result.stopReason, 'end_turn');
});

test('readAnthropicMessageStream throws upstream error payload from error event', async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(
        Buffer.from(
          [
            'event: error\n',
            'data: {"type":"error","error":{"type":"bad_response_status_code","message":"bad response status code 524"}}\n\n',
          ].join(''),
        ),
      );
      controller.close();
    },
  });

  await assert.rejects(
    () => readAnthropicMessageStream(stream),
    /bad response status code 524/,
  );
});
