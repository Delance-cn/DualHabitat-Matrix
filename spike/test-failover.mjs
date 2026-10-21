// 门面熔断的离线测试。
//
// 最要紧的一条：**重试必须沿用原来的 turn 号**。
// 桥接的 collector 按 turn 分组累积文本、并一一对应地消耗"静默轮/唤醒轮"标记。
// 如果换模型后开了新 turn，回复会被整段丢掉（挂在不存在的 turn 上）。
// 所以这里直接用上游那个 createTurnCollector 来验收，而不是只断言内部状态。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NodeApiClient, createTurnCollector } from '../src/oc-client.js';

let pass = 0;
let fail = 0;
const ok = (name, condition, extra = '') => {
  if (condition) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${extra ? `  ← ${extra}` : ''}`);
  }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-failover-'));
const logs = [];
let clientSeq = 0;

// 每个 client 用独立的 state 目录：模型链会把健康状态落盘，共用目录会让
// 后面的测试读到前面熔断的结果（这本身说明持久化是生效的，但会污染断言）。
const makeClient = (models) =>
  new NodeApiClient('http://127.0.0.1:1', 1000, {
    models,
    sessionDir: path.join(tmp, `client-${++clientSeq}`),
    log: (...args) => logs.push(args.join(' '))
  });

const fakeClientOf = (calls) => ({
  session: {
    interrupt: async (params) => {
      calls.push({ op: 'interrupt', sessionID: params.sessionID });
      return {};
    },
    switchModel: async (params) => {
      calls.push({ op: 'switchModel', model: params.model });
      return {};
    },
    prompt: async (params) => {
      calls.push({ op: 'prompt', text: params.text });
      return {};
    }
  }
});

// 把 "事件 → 翻译 → 熔断处理" 串起来，再喂给上游 collector
const drive = async (client, fake, collector, event) => {
  const frames = client._translate(event);
  const out = await client._applyFailover(event, frames, fake);
  let ended = null;
  for (const frame of out ?? []) {
    const result = collector.push(frame.event);
    if (result) ended = result;
  }
  return { out, ended };
};

const SID = 'ses_failover_test';

// ── 1. 核心：额度耗尽 → 换模型 → 重试仍是一个 turn ────────────────────────
console.log('\n=== 1. 额度耗尽后换模型重试（同一个 turn）===');
{
  const client = makeClient({
    free: ['zhipuai/glm-4.5-flash#none', 'openrouter/openrouter/free'],
    paid: [],
    allowPaid: false
  });
  const calls = [];
  const fake = fakeClientOf(calls);
  const collector = createTurnCollector();
  client._lastPrompt.set(SID, '群里有人 @ 了你');

  const started = { type: 'session.execution.started', data: { sessionID: SID } };
  const first = await drive(client, fake, collector, started);
  const turn = first.out[0].event.data.turn;
  ok('开始回合：turn/start 正常转发', first.out.length === 1 && first.out[0].event.type === 'turn/start');

  const failed = {
    type: 'session.execution.failed',
    data: { sessionID: SID, error: { message: '{"error":{"code":"1113","message":"余额不足或无可用资源包,请充值。"}}' } }
  };
  const second = await drive(client, fake, collector, failed);
  ok('失败的回合被完全吞掉（桥接看不到 turn/end）', second.out.length === 0);
  ok('切到了下一个候选', calls.some((c) => c.op === 'switchModel' && c.model.providerID === 'openrouter'));
  ok('用同样的话重发', calls.some((c) => c.op === 'prompt' && c.text === '群里有人 @ 了你'));
  ok('首个候选被熔断', client.chainStatus()[0].usable === false);

  const retryStart = await drive(client, fake, collector, started);
  ok('重试不再发 turn/start（否则 collector 会当成新回合）', retryStart.out.length === 0);
  ok('重试仍沿用原 turn 号', client._cur(SID).turn === turn);

  const textEv = { type: 'session.text.ended', data: { sessionID: SID, text: '在的，怎么了？' } };
  await drive(client, fake, collector, textEv);
  const succeeded = { type: 'session.execution.succeeded', data: { sessionID: SID } };
  const done = await drive(client, fake, collector, succeeded);

  ok('回合最终正常结束', done.ended?.reason?.kind === 'completed');
  ok('collector 拿到的是重试后的文本', done.ended?.text === '在的，怎么了？', JSON.stringify(done.ended?.text));
  ok('turn 号与首次一致（回复不会被丢）', done.ended?.turn === turn);
}

// ── 2. 已经产出文本就不再重试（否则两段回复会拼在一起）────────────────────
console.log('\n=== 2. 已产出文本则不重试 ===');
{
  const client = makeClient({ free: ['zhipuai/glm-4.5-flash#none', 'openrouter/openrouter/free'], paid: [], allowPaid: false });
  const calls = [];
  const fake = fakeClientOf(calls);
  const collector = createTurnCollector();
  const sid = 'ses_text_then_fail';
  client._lastPrompt.set(sid, 'hi');

  const started = { type: 'session.execution.started', data: { sessionID: sid } };
  await drive(client, fake, collector, started);
  await drive(client, fake, collector, { type: 'session.text.ended', data: { sessionID: sid, text: '说到一半' } });
  const failed = { type: 'session.execution.failed', data: { sessionID: sid, error: { message: '1113 余额不足' } } };
  const done = await drive(client, fake, collector, failed);

  ok('不重试（没有 switchModel）', !calls.some((c) => c.op === 'switchModel'));
  ok('失败照常上报', done.ended?.reason?.kind === 'failed');
  ok('半截文本仍被保留', done.ended?.text === '说到一半');
}

// ── 3. 不该熔断的失败不换模型 ──────────────────────────────────────────────
console.log('\n=== 3. 工具权限被拒 / 网络抖动不换模型 ===');
{
  for (const [label, message] of [
    ['工具权限被拒', '{"type":"permission.rejected","message":"Permission denied: shell"}'],
    ['网络抖动', 'Error: read ECONNRESET']
  ]) {
    const client = makeClient({ free: ['zhipuai/glm-4.5-flash#none', 'openrouter/openrouter/free'], paid: [], allowPaid: false });
    const calls = [];
    const fake = fakeClientOf(calls);
    const collector = createTurnCollector();
    const sid = `ses_${label}`;
    await drive(client, fake, collector, { type: 'session.execution.started', data: { sessionID: sid } });
    const done = await drive(client, fake, collector, {
      type: 'session.execution.failed',
      data: { sessionID: sid, error: { message } }
    });
    ok(`${label}：不换模型`, !calls.some((c) => c.op === 'switchModel'));
    ok(`${label}：链上一个都没被熔断`, client.chainStatus().every((s) => s.usable));
    ok(`${label}：失败照常上报`, done.ended?.reason?.kind === 'failed');
  }
}

// ── 4. 全部用完 → 回 429ERROR ─────────────────────────────────────────────
console.log('\n=== 4. 全部用完时回 429ERROR ===');
{
  const client = makeClient({ free: ['zhipuai/glm-4.5-flash#none'], paid: [], allowPaid: false });
  const calls = [];
  const fake = fakeClientOf(calls);
  const collector = createTurnCollector();
  const sid = 'ses_all_gone';
  client._lastPrompt.set(sid, '在吗');

  await drive(client, fake, collector, { type: 'session.execution.started', data: { sessionID: sid } });
  const done = await drive(client, fake, collector, {
    type: 'session.execution.failed',
    data: { sessionID: sid, error: { message: '1113 余额不足' } }
  });

  ok('回的是 429ERROR', done.ended?.text === '429ERROR', JSON.stringify(done.ended?.text));
  ok('回合以正常结束收尾（桥接才会发出去）', done.ended?.reason?.kind === 'completed');
  ok('没有可用的候选了', client.chainStatus().every((s) => s.usable === false));
}

// ── 5. 已经全用完时，不再调用模型，直接回话 ────────────────────────────────
console.log('\n=== 5. 已全用完：直接回话，不再空跑 ===');
{
  const client = makeClient({ free: ['zhipuai/glm-4.5-flash#none'], paid: [], allowPaid: false });
  const injected = [];
  client._inject = (frame) => injected.push(frame);
  // 先把它用光
  client._chain.markFailure(client._chain.pick(), { kind: 'quota', fatal: true, detail: '1113' });

  const res = await client.sessions.prompt({ sessionId: 'ses_x', mode: 'queue', content: [{ type: 'text', text: '在吗' }] });

  ok('返回被接受（桥接不会以为出错）', res.result.ok === true);
  ok('注入了 turn/start + 回复 + turn/end', injected.length === 3, `实得 ${injected.length}`);
  ok('注入的回复是 429ERROR', injected[1]?.event?.data?.message?.content?.[0]?.text === '429ERROR');
  ok('注入的回合是正常结束', injected[2]?.event?.data?.reason?.kind === 'completed');

  // 而且这三帧喂给 collector 能正常出文本
  const c2 = createTurnCollector();
  let ended = null;
  for (const f of injected) {
    const r = c2.push(f.event);
    if (r) ended = r;
  }
  ok('合成回合能被上游 collector 正常消费', ended?.text === '429ERROR');
}

// ── 6. 成本闸门：付费关着时，免费全用完不会偷偷用付费 ─────────────────────
console.log('\n=== 6. 付费开关关着时绝不越界 ===');
{
  const client = makeClient({
    free: ['zhipuai/glm-4.5-flash#none'],
    paid: ['zhipuai/glm-4.6'],
    allowPaid: false
  });
  const calls = [];
  const fake = fakeClientOf(calls);
  const collector = createTurnCollector();
  const sid = 'ses_cost_guard';
  client._lastPrompt.set(sid, '在吗');
  await drive(client, fake, collector, { type: 'session.execution.started', data: { sessionID: sid } });
  const done = await drive(client, fake, collector, {
    type: 'session.execution.failed',
    data: { sessionID: sid, error: { message: '1113 余额不足' } }
  });
  ok('没有降级到付费模型', !calls.some((c) => c.op === 'switchModel'));
  ok('而是回了 429ERROR', done.ended?.text === '429ERROR');
}

// ── 7. CLI 准备原地重试时就换掉不可用的模型 ────────────────────────────────
console.log('\n=== 7. 一眼看出用不了就立刻换（不等 10 次重试）===');
{
  const client = makeClient({ free: ['zhipuai/glm-4.6', 'zhipuai/glm-4.5-flash#none'], paid: [], allowPaid: false });
  const calls = [];
  const fake = fakeClientOf(calls);
  const collector = createTurnCollector();
  const sid = 'ses_early';
  client._lastPrompt.set(sid, '在吗');

  const started = await drive(client, fake, collector, { type: 'session.execution.started', data: { sessionID: sid } });
  const turn = started.out[0].event.data.turn;

  const retrying = {
    type: 'session.retry.scheduled',
    data: {
      sessionID: sid,
      reason: '{"error":{"code":"1113","message":"余额不足或无可用资源包,请充值。"}}'
    }
  };
  const early = await drive(client, fake, collector, retrying);
  ok('重试帧被吞掉（不为一次没发生的重试记账）', early.out.length === 0);
  ok('先掐掉旧执行（否则新回合要排在它后面）', calls.some((c) => c.op === 'interrupt'));
  ok('切成下一个候选', calls.some((c) => c.op === 'switchModel' && c.model.id === 'glm-4.5-flash'));
  ok('用同样的话重发', calls.some((c) => c.op === 'prompt' && c.text === '在吗'));
  ok('glm-4.6 被熔断', client.chainStatus().find((s) => s.key.startsWith('zhipuai/glm-4.6'))?.usable === false);

  // interrupt 造成的旧执行结束事件：必须丢掉，绝不能熔掉刚换上去的新模型
  const oldFail = await drive(client, fake, collector, {
    type: 'session.execution.interrupted',
    data: { sessionID: sid }
  });
  ok('旧执行的结束事件被丢弃', oldFail.out.length === 0 && oldFail.ended === null);
  ok('新模型没被误熔断', client.chainStatus().find((s) => s.key.includes('glm-4.5-flash'))?.usable === true);

  const restart = await drive(client, fake, collector, { type: 'session.execution.started', data: { sessionID: sid } });
  ok('新回合不发 turn/start', restart.out.length === 0);
  ok('沿用原 turn 号', client._cur(sid).turn === turn);

  await drive(client, fake, collector, { type: 'session.text.ended', data: { sessionID: sid, text: '在的' } });
  const done = await drive(client, fake, collector, { type: 'session.execution.succeeded', data: { sessionID: sid } });
  ok('回合正常收尾', done.ended?.reason?.kind === 'completed');
  ok('文本挂在与首次相同的 turn 上', done.ended?.turn === turn && done.ended?.text === '在的');
}

// ── 8. 限流（429）先交给 CLI 自己重试，别急着换 ────────────────────────────
console.log('\n=== 8. 限流先让 CLI 自己重试（换得太勤反而更慢）===');
{
  const client = makeClient({ free: ['zhipuai/glm-4.5-flash#none', 'openrouter/openrouter/free'], paid: [], allowPaid: false });
  const calls = [];
  const fake = fakeClientOf(calls);
  const collector = createTurnCollector();
  const sid = 'ses_rate';
  client._lastPrompt.set(sid, '在吗');
  await drive(client, fake, collector, { type: 'session.execution.started', data: { sessionID: sid } });

  const out = await drive(client, fake, collector, {
    type: 'session.retry.scheduled',
    data: { sessionID: sid, reason: '{"error":{"code":"1305","message":"访问量过大"}}' }
  });
  ok('重试事件照常给桥接（账本要建重试轴）', out.out.some((f) => f.event?.type === 'llm/retry-started'));
  ok('不换模型', !calls.some((c) => c.op === 'switchModel'));

  await drive(client, fake, collector, {
    type: 'session.execution.failed',
    data: { sessionID: sid, error: { message: '{"error":{"code":"1305","message":"访问量过大"}}' } }
  });
  ok('重试不动了才换模型', calls.some((c) => c.op === 'switchModel'));
  const st = client.chainStatus().find((s) => s.key.startsWith('zhipuai/glm-4.5-flash'));
  ok(
    '限流只冷却 60 秒（不算"用光了"）',
    st?.usable === false && st.kind === 'rate' && st.cooldownMsLeft <= 61_000,
    JSON.stringify(st)
  );
}

// ── 9. 提前换模型时发现已经全用完 → 立刻回话，且不重复收尾 ─────────────────
console.log('\n=== 9. 提前换时已全用完：立刻回话且不重复收尾 ===');
{
  const client = makeClient({ free: ['zhipuai/glm-4.6'], paid: [], allowPaid: false });
  const calls = [];
  const fake = fakeClientOf(calls);
  const collector = createTurnCollector();
  const sid = 'ses_early_gone';
  client._lastPrompt.set(sid, '在吗');
  await drive(client, fake, collector, { type: 'session.execution.started', data: { sessionID: sid } });
  const early = await drive(client, fake, collector, {
    type: 'session.retry.scheduled',
    data: { sessionID: sid, reason: '1113 余额不足' }
  });
  ok('立刻回了 429ERROR', early.ended?.text === '429ERROR', JSON.stringify(early.ended?.text));
  ok('回合正常收尾（自己补的 turn/end）', early.ended?.reason?.kind === 'completed');

  // OpenCode 之后真正结束这个回合：不能再产生第二个 turn/end
  const later = await drive(client, fake, collector, {
    type: 'session.execution.failed',
    data: { sessionID: sid, error: { message: '1113 余额不足' } }
  });
  ok('后续真实结束事件被丢弃（不会重复收尾）', later.out.length === 0 && later.ended === null);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${'='.repeat(52)}`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
