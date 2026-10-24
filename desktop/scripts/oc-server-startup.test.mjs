import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { assertPortAvailable, waitForSpawn } from '../../src/oc-server.js';

test('reports an occupied model API port before trying to launch', async () => {
  await assert.rejects(
    assertPortAvailable(4599, async () => true),
    /模型 API 端口 4599 已被占用/
  );
  await assert.doesNotReject(assertPortAvailable(4599, async () => false));
});

test('waits for a child spawn and surfaces launch errors immediately', async () => {
  const started = new EventEmitter();
  const runtimeErrors = [];
  const startPromise = waitForSpawn(started, (error) => runtimeErrors.push(error));
  started.emit('spawn');
  assert.equal(await startPromise, started);
  assert.equal(started.listenerCount('error'), 1);
  const lateError = new Error('process failed');
  started.emit('error', lateError);
  assert.deepEqual(runtimeErrors, [lateError]);

  const failed = new EventEmitter();
  const failure = new Error('spawn ENOENT');
  const failurePromise = waitForSpawn(failed);
  failed.emit('error', failure);
  await assert.rejects(failurePromise, (error) => error === failure);
  assert.equal(failed.listenerCount('spawn'), 0);
});
