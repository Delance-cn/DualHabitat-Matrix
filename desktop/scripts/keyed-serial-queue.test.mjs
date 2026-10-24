import test from 'node:test';
import assert from 'node:assert/strict';
import { createKeyedSerialQueue } from '../../src/keyed-serial-queue.js';

test('serializes work for one key while allowing independent keys to proceed', async () => {
  const enqueue = createKeyedSerialQueue();
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const order = [];
  const first = enqueue('group:1', async () => {
    order.push('first-start');
    await firstGate;
    order.push('first-end');
  });
  const second = enqueue('group:1', async () => { order.push('second'); });
  const independent = enqueue('group:2', async () => { order.push('independent'); });

  await independent;
  assert.deepEqual(order, ['first-start', 'independent']);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first-start', 'independent', 'first-end', 'second']);
});

test('a failed task does not poison later work for that key', async () => {
  const enqueue = createKeyedSerialQueue();
  await assert.rejects(enqueue('private:1', async () => { throw new Error('send failed'); }), /send failed/);
  assert.equal(await enqueue('private:1', async () => 'recovered'), 'recovered');
});
