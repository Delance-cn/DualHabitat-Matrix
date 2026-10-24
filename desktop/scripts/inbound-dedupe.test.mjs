import test from 'node:test';
import assert from 'node:assert/strict';
import { createInboundDeduper } from '../../src/inbound-dedupe.js';

test('deduplicates message IDs per conversation and expires them after the replay window', () => {
  let time = 100;
  const isDuplicate = createInboundDeduper({ ttlMs: 10, now: () => time });

  assert.equal(isDuplicate('group:1', '42'), false);
  assert.equal(isDuplicate('group:1', '42'), true);
  assert.equal(isDuplicate('group:2', '42'), false);
  time = 105;
  assert.equal(isDuplicate('group:1', '42'), true);
  time = 116;
  assert.equal(isDuplicate('group:1', '42'), false);
  assert.equal(isDuplicate('group:1', undefined), false);
});

test('bounds the dedupe cache and evicts the oldest entry', () => {
  const isDuplicate = createInboundDeduper({ maxEntries: 2, now: () => 1 });

  assert.equal(isDuplicate('private:1', 'a'), false);
  assert.equal(isDuplicate('private:1', 'b'), false);
  assert.equal(isDuplicate('private:1', 'c'), false);
  assert.equal(isDuplicate('private:1', 'a'), false);
});
