import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyModel, describeModelCategory, modelSeesImages } from '../../src/model-capabilities.js';

test('known vision models are classified as vision', () => {
  for (const id of [
    'bailian/qwen3-vl-plus#low',
    'bailian/qwen-vl-ocr',
    'bailian/qwen3.5-ocr',
    'bailian/deepseek-v4.1-flash-1017',
    'zhipuai/glm-4.5v',
    'openai/gpt-4o'
  ]) {
    assert.equal(classifyModel(id), 'vision', id);
    assert.equal(modelSeesImages(id), true, id);
  }
});

test('known text models stay text even when old config lists them', () => {
  const oldConfig = ['qwen3.8-max', 'qwen3.7-max'];
  for (const id of [
    'zhipuai/glm-4.5-flash#none',
    'bailian/qwen3.8-max#low',
    'bailian/qwen3.8-max-0902',
    'bailian/qwen3.7-max#low',
    'bailian/qwen3.7-max-2026-06-08',
    'bailian/kimi-k3#low'
  ]) {
    assert.equal(classifyModel(id, { visionModels: oldConfig }), 'text', id);
  }
});

test('explicit overrides are exact, not prefix matches', () => {
  assert.equal(classifyModel('custom/vision-model', { visionModels: ['vision-model'] }), 'vision');
  assert.equal(classifyModel('bailian/qwen3.8-max-0902', { visionModels: ['qwen3.8-max'] }), 'text');
  assert.equal(classifyModel('bailian/qwen3-vl-plus#low', { visionModels: ['qwen3-vl-*'] }), 'vision');
});

test('generation models are kept out of the chat pool', () => {
  for (const id of [
    'bailian/wanx-v1',
    'openai/dall-e-3',
    'black-forest-labs/flux-1.1-pro',
    'openai/text-embedding-3-large'
  ]) {
    assert.equal(classifyModel(id), 'generation', id);
  }
});

test('unknown and empty ids are explicit', () => {
  assert.equal(classifyModel(''), 'unknown');
  assert.equal(classifyModel('custom/mystery-model'), 'text');
  assert.deepEqual(describeModelCategory('bailian/qwen3-vl-plus#low'), {
    key: 'vision',
    label: '视觉',
    hint: '能直接看图片/表情'
  });
});
