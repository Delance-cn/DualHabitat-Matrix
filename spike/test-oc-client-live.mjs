// oc-client 真机自测：走**门面**（而不是裸 @opencode/client）跑通整条链路。
//
// 这是 Phase 1 的第一道真机闸：
//   1. 发现 + 鉴权（注册文件 + HTTP Basic）
//   2. workspace.create → sessions.create → sessions.selectModel → sessions.prompt
//   3. events.mux → createTurnCollector 拿到最终文本
//   4. 审批往返：permission.asked → approval/requested → respond('allowed-once')
//   5. 用量：assistant/attempt 里的 usage 能被账本口径消费
//
// 前置：node spike/start-server.mjs
// 跑法：node spike/test-oc-client-live.mjs
import path from 'node:path';
import fs from 'node:fs';
import { NodeApiClient, createTurnCollector, unwrap } from '../src/oc-client.js';
import { PATHS, ROOT } from './oc-env.mjs';

const PROVIDER = process.env.PROBE_PROVIDER ?? 'openrouter';
const MODEL = process.env.PROBE_MODEL ?? 'openrouter/free';
const WORK_DIR = path.join(ROOT, '.oc', 'work', 'live-test');

fs.mkdirSync(WORK_DIR, { recursive: true });

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
  sessionDir: path.join(ROOT, '.oc', 'state'),
  // 本文件验的是"门面能不能把一条链路走通"，所以要钉死一个已知模型。
  // 关掉模型池，避免 selectModel 被链接管后断言失去意义。
  models: { enabled: false },
  log: (m, e) => console.log(`    [client] ${m}`, e ?? '')
});

console.log('== 1. 发现 + 鉴权 ==');
try {
  const client = await api._ensureClient();
  const info = await client.server.info();
  check(`发现端点 ${api.endpointUrl}`, Boolean(api.endpointUrl));
  check(`服务可用（version=${info.version} pid=${info.pid}）`, Boolean(info.version));
} catch (error) {
  check('发现端点', false, error?.message ?? String(error));
  process.exit(1);
}

console.log('== 2. workspace / session / model ==');
const ws = unwrap(await api.workspace.create({ path: WORK_DIR }), 'workspace.create');
check(`workspace.create 返回 workspaceId=${ws.workspace.workspaceId}`, Boolean(ws.workspace?.workspaceId));

const created = unwrap(await api.sessions.create({ workspaceId: ws.workspace.workspaceId }), 'sessions.create');
const sessionId = created.sessionId;
check(`sessions.create 返回 sessionId=${sessionId}`, typeof sessionId === 'string' && sessionId.length > 0);

const sel = unwrap(
  await api.sessions.selectModel({ sessionId, provider: PROVIDER, model: MODEL }),
  'sessions.selectModel'
);
check(`sessions.selectModel → ${sel.selected.provider}/${sel.selected.model}`, sel.selected.model === MODEL);

console.log('== 3. 事件订阅（必须在 prompt 之前）==');
const frames = [];
const eventTypes = [];
const toolCalls = [];
const toolResults = [];
const collector = createTurnCollector();
const usageEvents = [];
let turnEnded = null;
const approvals = [];
const muxDone = { value: false };
let resolveTurn = null;
const turnDone = new Promise((resolve) => {
  resolveTurn = resolve;
});

const mux = (async () => {
  for await (const envelope of api.events.mux()) {
    const frame = envelope.payload;
    frames.push(frame.type);
    if (frame.type === 'session/event') {
      eventTypes.push(frame.event.type);
      if (frame.event.type === 'assistant/attempt') usageEvents.push(frame.event);
      if (frame.event.type === 'tool/call') toolCalls.push(frame.event.data);
      if (frame.event.type === 'tool/result') toolResults.push(frame.event.data.message);
      const ended = collector.push(frame.event);
      if (ended) {
        turnEnded = ended;
        resolveTurn(ended);
      }
    } else if (frame.type === 'approval/requested') {
      approvals.push(frame);
      // 真机审批往返：这里自动批准一次，验证 respond 能落回 provider。
      console.log(`    [审批] ${frame.toolName}: ${frame.reason}`);
      await api.respond({
        clientId: frame.clientId,
        eventId: frame.eventId,
        outcome: { kind: 'result', value: 'allowed-once' }
      });
      console.log('    [审批] 已回 allowed-once');
    } else if (frame.type === 'stream/error') {
      console.log('    [错误帧]', JSON.stringify(frame.error));
    }
  }
})().catch((error) => {
  console.log('    [mux 结束]', error?.message ?? error);
});

// 给订阅一点时间建立（订阅是 live-only，没有回放）
await new Promise((r) => setTimeout(r, 800));

console.log('== 4. 普通回合 ==');
await api.sessions.prompt({
  sessionId,
  mode: 'queue',
  content: [{ type: 'text', text: '只回答一句话：2+2 等于几？不要调用任何工具。' }]
});
const first = await Promise.race([
  turnDone,
  new Promise((resolve) => setTimeout(() => resolve({ text: '', reason: { kind: 'timeout' } }), 90_000))
]);
check(`回合结束（reason=${first?.reason?.kind}）`, first?.reason?.kind === 'completed', JSON.stringify(first));
check(`collector 拿到文本：${JSON.stringify(first?.text)}`, (first?.text ?? '').length > 0);
check('账本口径的用量已产生', usageEvents.length > 0, `usage 事件数=${usageEvents.length}`);
if (usageEvents.length) {
  const u = usageEvents[0].data.usage;
  check(
    `用量桶：input=${u.inputTokens} output=${u.outputTokens} cacheRead=${u.cacheReadTokens}`,
    Number.isFinite(u.inputTokens) && Number.isFinite(u.outputTokens)
  );
}

console.log('== 5. 审批回合（需要 opencode.json 里有 ask 规则）==');
turnEnded = null;
const turn2 = new Promise((resolve) => {
  resolveTurn = resolve;
});
await api.sessions.prompt({
  sessionId,
  mode: 'queue',
  content: [{ type: 'text', text: '请运行命令：echo phase1-marker' }]
});
const second = await Promise.race([
  turn2,
  new Promise((resolve) => setTimeout(() => resolve({ text: '', reason: { kind: 'timeout' } }), 90_000))
]);
check(`审批被触发并收到 approval/requested（${approvals.length} 次）`, approvals.length > 0);
if (approvals.length) {
  check(`审批工具名=${approvals[0].toolName}`, Boolean(approvals[0].toolName));
}
check(`审批回合结束（reason=${second?.reason?.kind}）`, second?.reason?.kind === 'completed', JSON.stringify(second));
console.log(
  '    [工具调用]',
  JSON.stringify(toolCalls.map((c) => ({ name: c.name, args: c.arguments })))
);
console.log(
  '    [工具结果]',
  JSON.stringify(toolResults.map((r) => String(r?.content?.[0]?.text ?? '').trim())).slice(0, 300)
);
check(
  '工具被真实调用并有结果（桥接工具日志的数据源）',
  toolCalls.length > 0 && toolResults.length > 0,
  `tool/call=${JSON.stringify(toolCalls)} tool/result(前100)="${JSON.stringify(toolResults[0]?.content?.[0]?.text ?? '').slice(0, 100)}"`
);
check(
  `审批往返本次${approvals.length ? `触发 ${approvals.length} 次（工具=${approvals[0]?.toolName}）` : '未触发（命令未匹配 ask 规则，被基础全放行接住 —— 这正是 4.3 的语义）'}`,
  approvals.length > 0 || toolCalls.length > 0,
  '注：审批映射本身已由离线自测覆盖，并已在 Phase 0/本轮真机跑通过完整往返'
);

console.log('== 6. 无重试/无错误帧 ==');
check('没有 stream/error 帧', !frames.includes('stream/error'));

console.log('== 7. 会话统计 ==');
try {
  const stats = await api.sessions.stats({ sessionId });
  unwrap(stats, 'session.stats');
  const s = stats.result.value;
  check(
    `stats 可读（tokens=${JSON.stringify(s?.tokens ?? s?.usage ?? {})}）`,
    Boolean(s)
  );
} catch (error) {
  check('stats 可读', false, error?.message ?? String(error));
}

mux.catch(() => {});
setTimeout(() => {
  console.log('');
  if (failed) {
    console.log(`✗ 有 ${failed} 项没过`);
    process.exit(1);
  }
  console.log('✓ 全部通过');
  process.exit(0);
}, 1200);
