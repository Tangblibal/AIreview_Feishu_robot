function parseAnthropicStreamEvent(eventBlock) {
  const normalizedBlock = `${eventBlock || ''}`.replace(/\r\n/g, '\n').trim();
  if (!normalizedBlock) return { eventName: '', payload: null };

  let eventName = '';
  const dataLines = [];
  normalizedBlock.split('\n').forEach((line) => {
    if (line.startsWith('event:')) {
      eventName = line.slice('event:'.length).trim();
      return;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trim());
    }
  });

  if (!dataLines.length) return { eventName, payload: null };
  const dataText = dataLines.join('\n').trim();
  if (!dataText || dataText === '[DONE]') return { eventName, payload: null };

  try {
    return {
      eventName,
      payload: JSON.parse(dataText),
    };
  } catch (error) {
    return { eventName, payload: null };
  }
}

function extractAnthropicStreamEventText(eventBlock) {
  const { eventName, payload } = parseAnthropicStreamEvent(eventBlock);
  if (!payload) return '';

  if (eventName === 'error' || payload?.type === 'error') {
    const message = payload?.error?.message || payload?.message || 'Anthropic stream error';
    throw new Error(message);
  }

  if (eventName === 'content_block_start' || payload?.type === 'content_block_start') {
    return payload?.content_block?.text || '';
  }

  if (eventName === 'content_block_delta' || payload?.type === 'content_block_delta') {
    return payload?.delta?.text || '';
  }

  return '';
}

function extractAnthropicStreamEventMeta(eventBlock) {
  const { eventName, payload } = parseAnthropicStreamEvent(eventBlock);
  if (!payload) return {};

  if (eventName === 'error' || payload?.type === 'error') {
    const message = payload?.error?.message || payload?.message || 'Anthropic stream error';
    throw new Error(message);
  }

  if (eventName === 'message_delta' || payload?.type === 'message_delta') {
    return {
      stopReason: payload?.delta?.stop_reason || payload?.delta?.stopReason || null,
    };
  }

  if (eventName === 'message_stop' || payload?.type === 'message_stop') {
    return { stopReason: 'end_turn' };
  }

  return {};
}

async function readAnthropicMessageStream(stream) {
  if (!stream) {
    throw new Error('Anthropic API response missing body');
  }

  const reader = typeof stream.getReader === 'function' ? stream.getReader() : null;
  const decoder = new TextDecoder();
  let pending = '';
  let text = '';
  let stopReason = null;

  const consumeChunk = (chunkText) => {
    pending += chunkText.replace(/\r\n/g, '\n');
    let boundaryIndex = pending.indexOf('\n\n');
    while (boundaryIndex !== -1) {
      const eventBlock = pending.slice(0, boundaryIndex);
      pending = pending.slice(boundaryIndex + 2);
      text += extractAnthropicStreamEventText(eventBlock);
      const meta = extractAnthropicStreamEventMeta(eventBlock);
      if (meta.stopReason) stopReason = meta.stopReason;
      boundaryIndex = pending.indexOf('\n\n');
    }
  };

  if (reader) {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        consumeChunk(decoder.decode(value, { stream: true }));
      }
      consumeChunk(decoder.decode());
    } finally {
      reader.releaseLock();
    }
  } else {
    for await (const chunk of stream) {
      consumeChunk(decoder.decode(chunk, { stream: true }));
    }
    consumeChunk(decoder.decode());
  }

  if (pending.trim()) {
    text += extractAnthropicStreamEventText(pending);
    const meta = extractAnthropicStreamEventMeta(pending);
    if (meta.stopReason) stopReason = meta.stopReason;
  }

  return { text, stopReason };
}

module.exports = {
  extractAnthropicStreamEventText,
  extractAnthropicStreamEventMeta,
  readAnthropicMessageStream,
};
