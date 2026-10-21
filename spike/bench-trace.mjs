// 拆解一个真实回合的时间都花在哪：把事件流逐条打时间戳，
// 看清是「首字预填充慢」还是「工具来回太多」。
// 用法：AGENT=qq-chat-v2 node spike/bench-trace.mjs <model> [variant]
import { NodeApiClient, unwrap, createTurnCollector } from '../src/oc-client.js';
import { PATHS } from '../src/oc-env.js';

const ROOT = 'C:\\Users\\<用户>\\DualHabitatMatrix';
const model = process.argv[2] || 'qwen3.8-max';
const variant = process.argv[3] || 'none';

const api = new NodeApiClient(undefined, undefined, { stateDir: PATHS.state, sessionDir: PATHS.state, log: () => {} });

const ws = unwrap(await api.workspace.create({ path: ROOT }), 'workspace.create');
const created = unwrap(
  await api.sessions.create({
    workspaceId: ws.workspace.workspaceId,
    ...(process.env.AGENT ? { agentPreset: process.env.AGENT } : {}),
    title: `trace-${model}`
  }),
  'sessions.create'
);
const sessionId = created.sessionId;
unwrap(await api.sessions.selectModel({ sessionId, provider: 'bailian', model, reasoningEffort: variant }), 'selectModel');

const collector = createTurnCollector();
const stream = api.events.mux({});
const t0 = Date.now();
const seen = [];
const done = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('超时 180s')), 180_000);
  (async () => {
    for await (const env of stream) {
      const f = env.payload;
      if (f.type !== 'session/event' || f.sessionId !== sessionId) continue;
      const e = f.event;
      const dt = Date.now() - t0;
      if (e.type === 'assistant/message') {
        for (const b of e.data?.message?.content ?? []) {
          if (b?.type === 'tool-call' || b?.type === 'tool_call') {
            seen.push(`  +${String(dt).padStart(6)}ms  调工具 ${b.name ?? b.toolName ?? '?'}`);
          }
          if (b?.type === 'reasoning' || b?.type === 'thinking') {
            seen.push(`  +${String(dt).padStart(6)}ms  思考块 ${String(b.text ?? b.reasoning ?? '').length} 字`);
          }
          if (b?.type === 'text') seen.push(`  +${String(dt).padStart(6)}ms  文本 ${String(b.text ?? '').length} 字`);
        }
      }
      if (e.type === 'tool/start' || e.type === 'tool/result' || e.type === 'tool/end') {
        seen.push(`  +${String(dt).padStart(6)}ms  ${e.type} ${e.data?.name ?? e.data?.toolName ?? ''}`);
      }
      if (e.type === 'turn/start' || e.type === 'turn/end') seen.push(`  +${String(dt).padStart(6)}ms  ${e.type} step=${e.data?.turn ?? ''}`);
      const ended = collector.push(e);
      if (ended) { clearTimeout(timer); resolve({ ended, ms: Date.now() - t0 }); return; }
    }
  })().catch((e) => { clearTimeout(timer); reject(e); });
});
api.events.follow(sessionId);

unwrap(
  await api.sessions.prompt({
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text: process.env.PROMPT || '这是延迟测试。不要调用任何工具，只回复两个字：收到' }]
  }),
  'sessions.prompt'
);

const { ended, ms } = await done;
console.log(seen.join('\n'));
console.log(`总耗时 ${ms}ms  回复：「${String(ended.text).replace(/\s+/g, ' ').slice(0, 60)}」`);
try { await api.sessions.delete?.({ sessionId }); } catch {}
process.exit(0);
