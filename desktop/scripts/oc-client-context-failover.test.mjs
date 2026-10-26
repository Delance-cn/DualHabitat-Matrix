import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NodeApiClient } from '../../src/oc-client.js';

test('prompt length failure switches to the next model instead of surfacing an error', async (t) => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-context-failover-'));
  t.after(() => fs.rmSync(sessionDir, { recursive: true, force: true }));
  const api = new NodeApiClient('http://127.0.0.1:1', 1000, {
    models: { free: ['zhipuai/glm-4.5-flash#none', 'openrouter/openrouter/free'], paid: [], allowPaid: false },
    sessionDir,
    log: () => {}
  });
  api._failoverStartTimeoutMs = 20;

  let switched = 0;
  const client = {
    session: {
      interrupt: async () => ({}),
      switchModel: async () => {
        switched += 1;
        return {};
      },
      prompt: async () => ({})
    }
  };
  const sessionID = 'session-context';
  api._lastPrompt.set(sessionID, 'a very long prompt');

  const started = { type: 'session.execution.started', data: { sessionID } };
  await api._applyFailover(started, api._translate(started), client);

  const failed = {
    type: 'session.execution.failed',
    data: { sessionID, error: { message: 'Prompt exceeds max length' } }
  };
  await api._applyFailover(failed, api._translate(failed), client);

  assert.equal(switched, 1);
  assert.equal(api._failoverPending.has(sessionID), true);

  // 让重试执行开始，清掉待处理状态和定时器。
  const retryStarted = { type: 'session.execution.started', data: { sessionID } };
  await api._applyFailover(retryStarted, api._translate(retryStarted), client);
  assert.equal(api._failoverPending.has(sessionID), false);
});
