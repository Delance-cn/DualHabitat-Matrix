import test from 'node:test';
import assert from 'node:assert/strict';
import { createTurnCollector } from '../../src/oc-client.js';

const message = (turn, content) => ({
  type: 'assistant/message',
  data: { turn, message: { content } }
});

test('tool-call narration is not sent to QQ', () => {
  const collector = createTurnCollector();
  collector.push({ type: 'turn/start', data: { turn: 't1' } });
  collector.push(message('t1', [
    { type: 'text', text: '管理员发图片了，让我看看是什么内容。' }
  ]));
  collector.push({ type: 'tool/call', data: { name: 'qq_get_message_images', callId: 'c1' } });
  collector.push(message('t1', [
    { type: 'text', text: '管理员，我看到你发图片了！是什么有趣的图片呀？' }
  ]));

  const ended = collector.push({ type: 'turn/end', data: { turn: 't1', reason: { kind: 'completed' } } });
  assert.equal(ended.text, '管理员，我看到你发图片了！是什么有趣的图片呀？');
});

test('only text after the last tool call is kept', () => {
  const collector = createTurnCollector();
  collector.push({ type: 'turn/start', data: { turn: 't3' } });
  collector.push(message('t3', [{ type: 'text', text: '我先看看。' }]));
  collector.push({ type: 'tool/call', data: { name: 'qq_get_message_images', callId: 'c1' } });
  collector.push(message('t3', [{ type: 'text', text: '看完了，再查一下。' }]));
  collector.push({ type: 'tool/call', data: { name: 'qq_get_message_images', callId: 'c2' } });
  collector.push(message('t3', [{ type: 'text', text: '最终回复。' }]));

  const ended = collector.push({ type: 'turn/end', data: { turn: 't3', reason: { kind: 'completed' } } });
  assert.equal(ended.text, '最终回复。');
});

test('a tool block in the same assistant message also hides its text', () => {
  const collector = createTurnCollector();
  collector.push({ type: 'turn/start', data: { turn: 't4' } });
  collector.push(message('t4', [
    { type: 'text', text: '这句是旁白。' },
    { type: 'tool', name: 'qq_get_message_images' }
  ]));
  collector.push(message('t4', [{ type: 'text', text: '这句是最终回复。' }]));

  const ended = collector.push({ type: 'turn/end', data: { turn: 't4', reason: { kind: 'completed' } } });
  assert.equal(ended.text, '这句是最终回复。');
});

test('lookup-only turn drops narration when no final text follows', () => {
  const collector = createTurnCollector();
  collector.push({ type: 'turn/start', data: { turn: 't5' } });
  collector.push(message('t5', [{ type: 'text', text: '管理员发图片了，让我看看是什么内容。' }]));
  collector.push({ type: 'tool/call', data: { name: 'qq_get_message_images', callId: 'c1' } });

  const ended = collector.push({ type: 'turn/end', data: { turn: 't5', reason: { kind: 'completed' } } });
  assert.equal(ended.text, '');
});

test('text before a mark-read action is still a final reply', () => {
  const collector = createTurnCollector();
  collector.push({ type: 'turn/start', data: { turn: 't6' } });
  collector.push(message('t6', [{ type: 'text', text: '收到，我看完了。' }]));
  collector.push({ type: 'tool/call', data: { name: 'qq_mark_read', callId: 'c1' } });

  const ended = collector.push({ type: 'turn/end', data: { turn: 't6', reason: { kind: 'completed' } } });
  assert.equal(ended.text, '收到，我看完了。');
});

test('text before a send action is still a final reply', () => {
  const collector = createTurnCollector();
  collector.push({ type: 'turn/start', data: { turn: 't7' } });
  collector.push(message('t7', [{ type: 'text', text: '这是要发出去的话。' }]));
  collector.push({ type: 'tool/call', data: { name: 'mcp__snowluma__qq_send_message', callId: 'c1' } });

  const ended = collector.push({ type: 'turn/end', data: { turn: 't7', reason: { kind: 'completed' } } });
  assert.equal(ended.text, '这是要发出去的话。');
});

test('plain text messages still accumulate in one turn', () => {
  const collector = createTurnCollector();
  collector.push({ type: 'turn/start', data: { turn: 't2' } });
  collector.push(message('t2', [{ type: 'text', text: '第一句。' }]));
  collector.push(message('t2', [{ type: 'text', text: '第二句。' }]));

  const ended = collector.push({ type: 'turn/end', data: { turn: 't2', reason: { kind: 'completed' } } });
  assert.equal(ended.text, '第一句。第二句。');
});
