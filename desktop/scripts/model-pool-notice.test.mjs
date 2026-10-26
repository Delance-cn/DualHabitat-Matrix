import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_POOL, normalizePool } from '../../src/model-pool.js';

test('exhaustedNotice 的乱码回退默认，不把问号串发进聊天', () => {
  const badValues = [
    '\uFFFD\uFFFD\uFFFD API \uFFFD\uFFFD',
    '?????? API ????????????'
  ];
  for (const bad of badValues) {
    const { pool, warnings } = normalizePool({ exhaustedNotice: bad });
    assert.equal(pool.exhaustedNotice, DEFAULT_POOL.exhaustedNotice);
    assert.ok(
      warnings.some((w) => w.includes('exhaustedNotice') && w.includes('乱码')),
      `应给出乱码警告：${JSON.stringify(warnings)}`
    );
  }
});

test('空串仍然是有效配置（允许关闭用尽提示）', () => {
  const { pool, warnings } = normalizePool({ exhaustedNotice: '' });
  assert.equal(pool.exhaustedNotice, '');
  assert.equal(warnings.some((w) => w.includes('乱码')), false);
});

test('正常提示语原样保留', () => {
  const { pool, warnings } = normalizePool({ exhaustedNotice: '稍等，模型这会儿不可用。' });
  assert.equal(pool.exhaustedNotice, '稍等，模型这会儿不可用。');
  assert.equal(warnings.some((w) => w.includes('乱码')), false);
});
