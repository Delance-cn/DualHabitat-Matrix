import test from 'node:test';
import assert from 'node:assert/strict';
import { splitForQQ } from '../../src/md-to-plain.js';

test('caps long QQ replies by part count and marks truncated output', () => {
  const parts = splitForQQ('x'.repeat(100), 10, 3);

  assert.equal(parts.length, 3);
  assert.ok(parts.every((part) => part.length <= 10));
  assert.ok(parts.at(-1).includes('截断'));
});

test('keeps surrogate pairs intact when truncating a QQ reply', () => {
  const parts = splitForQQ('😀'.repeat(40), 32, 2);

  assert.equal(parts.length, 2);
  assert.ok(parts.every((part) => !/[\uD800-\uDBFF]$/.test(part) && !/^[\uDC00-\uDFFF]/.test(part)));
  assert.ok(parts.at(-1).includes('截断'));
});
