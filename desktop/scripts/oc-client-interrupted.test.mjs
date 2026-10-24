import test from 'node:test';
import assert from 'node:assert/strict';
import { NodeApiClient } from '../../src/oc-client.js';

test('interrupted execution does not clear a model circuit breaker', () => {
  const api = new NodeApiClient('http://127.0.0.1:1', undefined, {
    models: { free: ['a/one'] },
    sessionDir: '.oc-client-test-state',
    log: () => {}
  });
  const candidate = api._chain.active[0];
  api._chain.markFailure(candidate, { kind: 'auth', fatal: true, detail: 'invalid key' });
  api._appliedModel.set('session-1', candidate);

  api._translate({
    type: 'session.execution.interrupted',
    data: { sessionID: 'session-1' }
  });

  assert.equal(api._chain.status()[0].usable, false);
});
