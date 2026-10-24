// oc-client 离线自测：喂一串假 OpenCode 事件，断言翻译出的 DSH frame
// 能被**未修改的** createTurnCollector 正确消费。
//
// 这是移植的第一道闸：事件形状错了，后面 QQ 侧全都白干。
//
// 跑法：node spike/test-oc-client.mjs
import assert from 'node:assert/strict';
import { NodeApiClient, createTurnCollector, formatPermissions, formFieldsToQuestions } from '../src/oc-client.js';

const SID = 'ses_test_0001';
let failed = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  ✗ ${name}\n      ${error?.message ?? error}`);
  }
};

// 用不上真服务器：这里从不 _ensureClient（翻译是纯函数）。
// 本文件只验"翻译层"，所以显式关掉模型池：让 selectModel 用传进来的模型，
// 行为可预期。模型链有它自己的离线/真机测试（test-model-chain / test-failover）。
const api = new NodeApiClient('http://127.0.0.1:1', undefined, { models: { enabled: false }, log: () => {} });

console.log('== 1. 一个正常回合：execution.started → 文本 → step.ended → succeeded ==');
{
  const scripted = [
    { type: 'session.execution.started', data: { sessionID: SID, assistantMessageID: 'msg_1' } },
    { type: 'session.text.delta', data: { sessionID: SID, delta: '1+1' } },
    { type: 'session.text.delta', data: { sessionID: SID, delta: ' 等于 2。' } },
    { type: 'session.text.ended', data: { sessionID: SID, text: '1+1 等于 2。' } },
    {
      type: 'session.step.ended',
      data: {
        sessionID: SID,
        tokens: { input: 740, output: 12, reasoning: 0, cache: { read: 128, write: 0 } },
        model: 'deepseek-v4.1-flash-free',
        provider: 'opencode'
      }
    },
    { type: 'session.execution.succeeded', data: { sessionID: SID } }
  ];

  const collector = createTurnCollector();
  const frames = scripted.flatMap((e) => api._translate(e));
  const usageEvents = [];
  let ended = null;
  for (const frame of frames) {
    assert.equal(frame.type, 'session/event', `frame.type 应为 session/event，实得 ${frame.type}`);
    assert.equal(frame.sessionId, SID);
    if (frame.event.type === 'assistant/attempt') usageEvents.push(frame.event);
    const r = collector.push(frame.event);
    if (r) ended = r;
  }

  check('产出 turn/start + assistant/message + assistant/attempt + turn/end（chunk 是额外的流式帧）', () => {
    const types = frames.map((f) => f.event.type).filter((t) => t !== 'assistant/chunk');
    assert.deepEqual(types, ['turn/start', 'assistant/message', 'assistant/attempt', 'turn/end']);
  });
  check('collector 拿到完整文本', () => assert.equal(ended?.text, '1+1 等于 2。'));
  check('collector 拿到 completed 终态', () => assert.equal(ended?.reason?.kind, 'completed'));
  check('token 用量按账本口径映射', () => {
    const u = usageEvents[0]?.data?.usage;
    assert.deepEqual(u, {
      inputTokens: 740,
      outputTokens: 12,
      reasoningTokens: 0,
      cacheReadTokens: 128,
      cacheWriteTokens: 0
    });
  });
  check('用量事件带 model/provider（账本计价要用）', () => {
    assert.equal(usageEvents[0].data.model, 'deepseek-v4.1-flash-free');
    assert.equal(usageEvents[0].data.provider, 'opencode');
  });
}

console.log('== 2. 工具调用回合：文本不该被当成"执行成功"的证据 ==');
{
  const scripted = [
    { type: 'session.execution.started', data: { sessionID: SID, assistantMessageID: 'msg_2' } },
    // 模型谎称执行了命令 —— 桥接必须只信 session.tool.*。这里文本照转，
    // 但绝不生成任何伪 tool 事件。
    { type: 'session.text.ended', data: { sessionID: SID, text: '命令的标准输出是：phase0-marker' } },
    { type: 'session.execution.succeeded', data: { sessionID: SID } }
  ];
  const frames = scripted.flatMap((e) => api._translate(e));
  check('只产出 session/event，没有伪造 tool 事件', () => {
    assert.ok(frames.every((f) => f.type === 'session/event'));
  });
  check('文本原样透传（由上游策略决定怎么处理）', () => {
    const msg = frames.find((f) => f.event.type === 'assistant/message');
    assert.equal(msg.event.data.message.content[0].text, '命令的标准输出是：phase0-marker');
  });
}

console.log('== 2b. 工具调用与结果（桥接的工具日志要用）==');
{
  const sid = 'ses_tool_1';
  const start = api._translate({
    type: 'session.tool.input.started',
    data: { sessionID: sid, id: 'call_1', name: 'shell' }
  });
  check('input.started 不产 frame，只登记工具名', () => assert.equal(start.length, 0));

  const call = api._translate({
    type: 'session.tool.called',
    data: { sessionID: sid, id: 'call_1', input: { command: 'echo hi' } }
  });
  check('called → tool/call，且关联出了工具名（OpenCode 这条事件本身不带名字）', () => {
    assert.equal(call[0].event.type, 'tool/call');
    assert.equal(call[0].event.data.name, 'shell');
    assert.equal(call[0].event.data.callId, 'call_1');
    assert.deepEqual(call[0].event.data.arguments, { command: 'echo hi' });
  });

  const res = api._translate({
    type: 'session.tool.success',
    data: { sessionID: sid, id: 'call_1', content: [{ type: 'text', text: 'hi\r\n' }] }
  });
  check('success → tool/result（source.callId + isError:false）', () => {
    assert.equal(res[0].event.type, 'tool/result');
    const m = res[0].event.data.message;
    assert.equal(m.source.callId, 'call_1');
    assert.equal(m.isError, false);
    assert.equal(m.content[0].text, 'hi\r\n');
  });

  const fail = api._translate({
    type: 'session.tool.failed',
    data: { sessionID: sid, id: 'call_2', message: 'Permission denied: shell' }
  });
  check('failed → tool/result isError:true 且带错误文本', () => {
    const m = fail[0].event.data.message;
    assert.equal(m.isError, true);
    assert.match(m.content[0].text, /Permission denied/);
  });
}

console.log('== 3. 审批往返：permission.asked → approval/requested → respond 映射 ==');
{
  const asked = {
    type: 'permission.asked',
    data: { sessionID: SID, id: 'per_1', action: 'shell', resources: ['echo phase0-marker'] }
  };
  const frames = api._translate(asked);
  const f = frames[0];
  check('frame 类型与关键字段齐全', () => {
    assert.equal(f.type, 'approval/requested');
    assert.equal(f.sessionId, SID);
    assert.equal(f.clientId, 'matrix');
    assert.equal(f.eventId, 'per_1');
    assert.equal(f.toolName, 'shell');
  });
  check('reason 可读', () => assert.match(f.reason, /shell/));
  check('pending 已登记（respond 才能找到）', () => {
    assert.ok(api._pending.has('matrix:per_1'));
    assert.equal(api._pending.get('matrix:per_1').requestID, 'per_1');
  });

  // respond 的映射在真正回 HTTP，这里把 _ensureClient 换成桩，直接 await 断言。
  let replied = null;
  api._ensureClient = async () => ({ permission: { reply: async (x) => { replied = x; } } });
  await api.respond({ clientId: 'matrix', eventId: 'per_1', outcome: { kind: 'result', value: 'rejected' } });
  check('rejected → decision:reject，并清理 pending', () => {
    assert.equal(replied.decision, 'reject');
    assert.ok(!api._pending.has('matrix:per_1'));
  });

  api._pending.set('matrix:per_2', { kind: 'approval', sessionID: SID, requestID: 'per_2' });
  await api.respond({ clientId: 'matrix', eventId: 'per_2', outcome: { kind: 'result', value: 'allowed-once' } });
  check('allowed-once → decision:once', () => assert.equal(replied.decision, 'once'));

  api._pending.set('matrix:form_1', { kind: 'question', sessionID: SID, formID: 'form_1' });
  api._ensureClient = async () => ({ form: { reply: async (x) => { replied = x; } } });
  await api.respond({
    clientId: 'matrix',
    eventId: 'form_1',
    outcome: { kind: 'result', value: { answers: [{ id: 'colors', selected: ['蓝'] }] } }
  });
  check('提问答案 → form.reply 的 { 字段id: 值 } 字典', () => {
    assert.equal(replied.sessionID, SID);
    assert.equal(replied.formID, 'form_1');
    assert.deepEqual(replied.answer, { colors: '蓝' });
  });
}

console.log('== 4. 提问往返：form.created → question/requested ==');
{
  const frames = api._translate({
    type: 'form.created',
    data: {
      sessionID: SID,
      form: {
        id: 'form_1',
        sessionID: SID,
        fields: [
          { id: 'colors', label: '喜欢哪个颜色？', options: ['红', '蓝'] },
          { id: 'note', question: '补充说明' }
        ]
      }
    }
  });
  const f = frames[0];
  check('frame 类型与问题数', () => {
    assert.equal(f.type, 'question/requested');
    assert.equal(f.questions.length, 2);
  });
  check('选项被规整成 {label,value}', () => {
    assert.deepEqual(f.questions[0].options, [
      { label: '红', value: '红' },
      { label: '蓝', value: '蓝' }
    ]);
  });
  check('无选项字段也容错', () => assert.equal(f.questions[1].question, '补充说明'));
}

console.log('== 5. 失败与重试 ==');
{
  const retryFrames = api._translate({ type: 'session.retry.scheduled', data: { sessionID: SID, reason: 'provider 繁忙' } });
  check('session.retry.scheduled → llm/retry-started（账本建重试轴）', () => {
    assert.equal(retryFrames[0].event.type, 'llm/retry-started');
    assert.equal(retryFrames[0].event.data.retry, 1);
  });
  const failFrames = api._translate({ type: 'session.execution.failed', data: { sessionID: SID, error: { message: '额度不足' } } });
  check('执行失败 → turn/end reason.kind=failed 且带原因', () => {
    assert.equal(failFrames[0].event.type, 'turn/end');
    assert.equal(failFrames[0].event.data.reason.kind, 'failed');
    assert.equal(failFrames[0].event.data.reason.error, '额度不足');
  });
  api._translate({ type: 'session.execution.started', data: { sessionID: SID } });
  const errFrames = api._translate({ type: 'session.error', data: { sessionID: SID, error: { message: '炸了' } } });
  check('会话错误 → stream/error', () => assert.equal(errFrames[0].type, 'stream/error'));
}

console.log('== 6. 纯函数边界 ==');
check('formatPermissions 无资源时不崩', () => assert.match(formatPermissions({ action: 'read' }), /read/));
check('formFieldsToQuestions 支持对象形态的 fields', () => {
  const q = formFieldsToQuestions({ fields: { a: { label: 'A 选项', options: ['x'] } } });
  assert.equal(q[0].id, 'a');
  assert.equal(q[0].question, 'A 选项');
});
check('tokensToUsage 对空值返回 undefined', () => assert.equal(api._translate({ type: 'session.step.ended', data: { sessionID: SID } }).length, 0));

console.log('');
if (failed) {
  console.log(`✗ 有 ${failed} 项没过`);
  process.exit(1);
}
console.log('✓ 全部通过');
