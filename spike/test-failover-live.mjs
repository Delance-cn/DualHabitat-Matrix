// 真机熔断自测：链的**首选故意放一个确定"余额不足"的付费模型**，
// 看门面会不会自动换到第二个（能用的免费模型）并且**用户视角什么都没发生**。
//
// 这是"上一个用光了，就自动切换到可以用的"这条需求的第一道真机闸。要验四件事：
//   1. 换模型发生在**同一个 turn 内** —— 消费者只看到 1 个 turn/start、1 个 turn/end。
//   2. 回复文本拿得到（不会因为换模型把回复弄丢）。
//   3. 用不了的候选被熔断，且原因归类正确（quota，不是"限流"）。
//   4. 换模型是**快**的：`session.retry.scheduled` 阶段就换掉了，
//      不用等 CLI 把 10 次原地重试慢慢跑完。
//
// 前置：node spike/start-server.mjs
// 跑法：node spike/test-failover-live.mjs
import fs from 'node:fs';
import path from 'node:path';
import { NodeApiClient, createTurnCollector, unwrap } from '../src/oc-client.js';
import { PATHS, ROOT } from './oc-env.mjs';

const WORK_DIR = path.join(ROOT, '.oc', 'work', 'failover-live');
const STATE_DIR = path.join(ROOT, '.oc', 'state', 'failover-live');

// 清掉上次的熔断记录，保证这次是"从零开始踩坑"
fs.rmSync(STATE_DIR, { recursive: true, force: true });
fs.mkdirSync(WORK_DIR, { recursive: true });

// 首选 = 付费但没钱的 glm-4.6（真机确认返回 1113 余额不足）
// 备选 = 免费且直连可用的 glm-4.5-flash（关掉思考变体，实测快得多）
const CHAIN = {
  free: ['zhipuai/glm-4.6', 'zhipuai/glm-4.5-flash#none'],
  paid: [],
  allowPaid: false,
  exhaustedNotice: '429ERROR'
};

let failed = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
  }
};

const api = new NodeApiClient(undefined, undefined, {
  stateDir: PATHS.state,
  sessionDir: STATE_DIR,
  models: CHAIN,
  log: (m, e) => console.log(`    [client] ${m}`, e ?? '')
});

console.log('== 1. 发现 + 建会话（链接管模型选择）==');
const client = await api._ensureClient();
const info = await client.server.info();
check(`发现端点（version=${info.version}）`, Boolean(info.version), api.endpointUrl);

const ws = unwrap(await api.workspace.create({ path: WORK_DIR }), 'workspace.create');
const created = unwrap(await api.sessions.create({ workspaceId: ws.workspace.workspaceId }), 'sessions.create');
const sessionId = created.sessionId;

// 故意传一个"错的" provider/model：链启用时应被忽略，以链为准
const sel = unwrap(
  await api.sessions.selectModel({ sessionId, provider: 'openrouter', model: 'openrouter/free' }),
  'sessions.selectModel'
);
check(
  `selectModel 被模型链接管（实得 ${sel.selected.provider}/${sel.selected.model}）`,
  sel.selected.provider === 'zhipuai' && sel.selected.model === 'glm-4.6',
  JSON.stringify(sel.selected)
);

console.log('== 2. 订阅 + 投递（首选模型是没钱的 glm-4.6）==');
const turnStarts = [];
const turnEnds = [];
const retryFrames = [];
const textEvents = [];
const collector = createTurnCollector();
let firstEnd = null;
const turnDone = new Promise((resolve) => {
  firstEnd = resolve;
});

const mux = (async () => {
  for await (const envelope of api.events.mux()) {
    const frame = envelope.payload;
    if (frame.type !== 'session/event') continue;
    const e = frame.event;
    if (e.type === 'turn/start') turnStarts.push(e.data.turn);
    if (e.type === 'llm/retry-started') retryFrames.push(e.data);
    if (e.type === 'assistant/message') textEvents.push(e.data.message?.content?.[0]?.text ?? '');
    const ended = collector.push(e);
    if (ended) {
      turnEnds.push(ended.turn);
      // 只 resolve 第一次；继续消费是为了能发现"重复收尾"
      if (turnEnds.length === 1) firstEnd(ended);
    }
  }
})().catch((error) => console.log('    [mux 结束]', error?.message ?? error));

await new Promise((r) => setTimeout(r, 800));

const t0 = Date.now();
await api.sessions.prompt({
  sessionId,
  mode: 'queue',
  content: [{ type: 'text', text: '只回答一句话，不要调用任何工具：1+1 等于几？' }]
});
const done = await Promise.race([
  turnDone,
  new Promise((resolve) => setTimeout(() => resolve({ text: '', reason: { kind: 'timeout' } }), 180_000))
]);
const elapsed = Date.now() - t0;

console.log('== 3. 断言 ==');
check(`回合正常结束（reason=${done?.reason?.kind}，耗时 ${(elapsed / 1000).toFixed(1)}s）`, done?.reason?.kind === 'completed', JSON.stringify(done));
check(`拿得到回复文本：${JSON.stringify(done?.text)}`, (done?.text ?? '').length > 0);
check(`用户视角只看到一个回合开始（turn/start=${turnStarts.length}）`, turnStarts.length === 1, JSON.stringify(turnStarts));
check(
  `换模型没有另起 turn（结束时的 turn=${done?.turn} 与开始一致）`,
  done?.turn === turnStarts[0],
  `start=${JSON.stringify(turnStarts)} end=${done?.turn}`
);
check(
  `首选被熔断且归类为 quota（不是限流）`,
  (() => {
    const s = api.chainStatus().find((x) => x.key.startsWith('zhipuai/glm-4.6'));
    return s?.usable === false && s.kind === 'quota';
  })(),
  JSON.stringify(api.chainStatus())
);
check(
  `备选（免费）可用且没被误熔断`,
  (() => {
    const s = api.chainStatus().find((x) => x.key.startsWith('zhipuai/glm-4.5-flash'));
    return s?.usable === true;
  })(),
  JSON.stringify(api.chainStatus())
);
console.log('    [模型链]', JSON.stringify(api.chainStatus(), null, 2).replace(/\n/g, '\n    '));
console.log(`    [重试帧] ${retryFrames.length} 次（在 retry.scheduled 阶段就换掉的话应该很少或为 0）`);

// 真实回复用的到底是哪个模型？看 assistant/message 上挂的 model 字段
const models = [...new Set(textEvents.filter(Boolean).map((t) => t))];
console.log(`    [文本事件] ${JSON.stringify(models).slice(0, 200)}`);

// 熔断状态要落盘（重启后不重复踩坑）
check(
  '熔断状态已落盘',
  fs.existsSync(path.join(STATE_DIR, 'model-chain.json')),
  path.join(STATE_DIR, 'model-chain.json')
);

// 再等一会，确认没有第二个 turn/end（重复收尾会害桥接重复发消息）
await new Promise((r) => setTimeout(r, 2500));
check(`没有重复收尾（turn/end 次数=${turnEnds.length}）`, turnEnds.length === 1, JSON.stringify(turnEnds));

mux.catch(() => {});
setTimeout(() => {
  console.log('');
  if (failed) {
    console.log(`✗ 有 ${failed} 项没过`);
    process.exit(1);
  }
  console.log('✓ 全部通过');
  process.exit(0);
}, 800);
