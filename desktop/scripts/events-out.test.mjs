import assert from 'node:assert/strict';
import test from 'node:test';
import { emitEvent } from '../../src/events-out.js';

test('reports failed QQ delivery through the configured event webhook without message text', () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true };
  };
  try {
    emitEvent(
      { events: { enabled: true, url: 'https://example.invalid/events', secret: 'webhook-secret', onReply: false } },
      'delivery_failed',
      { platform: 'qq', chatId: 'group:123', failedParts: [{ part: 2 }], messageParts: 2 }
    );
    assert.equal(request.url, 'https://example.invalid/events');
    assert.equal(request.options.headers['x-dhm-secret'], 'webhook-secret');
    const payload = JSON.parse(request.options.body);
    assert.equal(payload.event, 'delivery_failed');
    assert.deepEqual(payload.data.failedParts, [{ part: 2 }]);
    assert.equal('text' in payload.data, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
