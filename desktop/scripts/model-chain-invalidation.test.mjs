import test from 'node:test';
import assert from 'node:assert/strict';
import { NodeApiClient } from '../../src/oc-client.js';

test('invalidate restores candidates hidden by the previous model catalog', () => {
  const api = new NodeApiClient('http://127.0.0.1:1', undefined, {
    models: { free: ['a/one', 'b/two'] },
    sessionDir: '.oc-client-test-state',
    log: () => {}
  });

  api._chain.restrictTo(new Set(['b/two']));
  assert.deepEqual(api._chain.active.map((candidate) => candidate.id), ['two']);

  api.invalidate();
  assert.deepEqual(api._chain.active.map((candidate) => candidate.id), ['one', 'two']);
});
