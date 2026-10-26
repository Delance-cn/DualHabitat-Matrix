import test from 'node:test';
import assert from 'node:assert/strict';
import { NodeApiClient } from '../../src/oc-client.js';

test('vision bypass session failures do not trip the main model chain', async () => {
  const api = new NodeApiClient('http://127.0.0.1:1', undefined, {
    models: { free: ['a/one'] },
    sessionDir: '.oc-client-test-state',
    log: () => {}
  });
  const candidate = api._chain.active[0];
  api._appliedModel.set('main-session', candidate);
  api._bypassSessions.add('vision-temp');

  const event = {
    type: 'session.execution.failed',
    data: { sessionID: 'vision-temp', error: { message: 'free quota exhausted' } }
  };
  const frames = api._translate(event);
  const adjusted = await api._applyFailover(event, frames, null);

  // 旁路会话的事件原样透传，但不记录失败、不换主模型、不排重试。
  assert.equal(adjusted, frames);
  assert.equal(api._chain.status()[0].usable, true);
  assert.equal(api._chain.status()[0].kind, null);
  assert.equal(api._retryTurns.has('vision-temp'), false);
});
