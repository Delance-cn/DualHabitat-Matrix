import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NodeApiClient } from '../../src/oc-client.js';

const makeClient = (t, { prompt = async () => ({}) } = {}) => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-failover-timeout-'));
  t.after(() => fs.rmSync(sessionDir, { recursive: true, force: true }));
  const api = new NodeApiClient('http://127.0.0.1:1', 1000, {
    models: { free: ['zhipuai/glm-4.5-flash#none', 'openrouter/openrouter/free'], paid: [], allowPaid: false },
    sessionDir,
    log: () => {}
  });
  api._failoverStartTimeoutMs = 20;
  const client = {
    session: {
      interrupt: async () => ({}),
      switchModel: async () => ({}),
      prompt
    }
  };
  return { api, client };
};

const beginFailover = async (api, client, sessionID) => {
  api._lastPrompt.set(sessionID, 'retry this');
  await api._applyFailover(
    { type: 'session.execution.started', data: { sessionID } },
    api._translate({ type: 'session.execution.started', data: { sessionID } }),
    client
  );
  const failed = { type: 'session.execution.failed', data: { sessionID, error: { message: '1113 quota exhausted' } } };
  await api._applyFailover(failed, api._translate(failed), client);
};

test('clears pending failover state if retry execution never starts', async (t) => {
  const { api, client } = makeClient(t);
  const sessionID = 'session-timeout';

  await beginFailover(api, client, sessionID);
  assert.equal(api._failoverPending.has(sessionID), true);
  assert.equal(api._retryTurns.has(sessionID), true);
  assert.equal(api._failoverTimers.has(sessionID), true);

  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.equal(api._failoverPending.has(sessionID), false);
  assert.equal(api._retryTurns.has(sessionID), false);
  assert.equal(api._failoverTimers.has(sessionID), false);
});

test('execution.started clears the deadline and preserves failover turn behavior', async (t) => {
  const { api, client } = makeClient(t);
  const sessionID = 'session-started';

  await beginFailover(api, client, sessionID);
  const retryTurn = api._retryTurns.get(sessionID);
  const started = { type: 'session.execution.started', data: { sessionID } };
  const frames = await api._applyFailover(started, api._translate(started), client);

  assert.deepEqual(frames, []);
  assert.equal(api._cur(sessionID).turn, retryTurn);
  assert.equal(api._failoverPending.has(sessionID), false);
  assert.equal(api._retryTurns.has(sessionID), false);
  assert.equal(api._failoverTimers.has(sessionID), false);

  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(api._failoverPending.has(sessionID), false);
});

test('starts the deadline only after the retry prompt is accepted', async (t) => {
  let resolvePrompt;
  let promptCalled;
  const promptStarted = new Promise((resolve) => {
    promptCalled = resolve;
  });
  const promptAccepted = new Promise((resolve) => {
    resolvePrompt = resolve;
  });
  const { api, client } = makeClient(t, {
    prompt: async () => {
      promptCalled();
      return promptAccepted;
    }
  });
  const sessionID = 'session-slow-prompt';
  api._lastPrompt.set(sessionID, 'retry this');
  const started = { type: 'session.execution.started', data: { sessionID } };
  await api._applyFailover(started, api._translate(started), client);
  const failed = { type: 'session.execution.failed', data: { sessionID, error: { message: '1113 quota exhausted' } } };
  const failover = api._applyFailover(failed, api._translate(failed), client);

  await promptStarted;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(api._failoverPending.has(sessionID), true);
  assert.equal(api._failoverTimers.has(sessionID), false);

  resolvePrompt({});
  await failover;
  assert.equal(api._failoverTimers.has(sessionID), true);

  const retryStarted = { type: 'session.execution.started', data: { sessionID } };
  await api._applyFailover(retryStarted, api._translate(retryStarted), client);
  assert.equal(api._failoverTimers.has(sessionID), false);
});

test('clears the deadline and pending state when retry prompt fails', async (t) => {
  const { api, client } = makeClient(t, {
    prompt: async () => {
      throw new Error('prompt rejected');
    }
  });
  const sessionID = 'session-prompt-error';

  await beginFailover(api, client, sessionID);

  assert.equal(api._failoverPending.has(sessionID), false);
  assert.equal(api._retryTurns.has(sessionID), false);
  assert.equal(api._failoverTimers.has(sessionID), false);
});
