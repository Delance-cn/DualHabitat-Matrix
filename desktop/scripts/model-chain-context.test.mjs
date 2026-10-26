import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyFailure, DEFAULT_COOLDOWN_MS, FUSING_KINDS, KIND } from '../../src/model-chain.js';

test('prompt length failures are context failures, not quota', () => {
  for (const input of [
    'Prompt exceeds max length',
    { message: 'Prompt exceeds max length' },
    'context length exceeded',
    'maximum context window is 32768',
    'input is too long'
  ]) {
    const failure = classifyFailure(input);
    assert.equal(failure.kind, KIND.CONTEXT, JSON.stringify(input));
    assert.equal(failure.fatal, true, JSON.stringify(input));
  }
});

test('context failures fuse with a finite cooldown so the chain can move on', () => {
  assert.equal(FUSING_KINDS.has(KIND.CONTEXT), true);
  assert.equal(Number.isFinite(DEFAULT_COOLDOWN_MS[KIND.CONTEXT]), true);
  assert.ok(DEFAULT_COOLDOWN_MS[KIND.CONTEXT] > 0);
});

test('quota errors are still quota errors', () => {
  assert.equal(classifyFailure('1113 余额不足').kind, KIND.QUOTA);
});
