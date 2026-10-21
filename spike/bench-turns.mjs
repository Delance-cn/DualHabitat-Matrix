// 同一个会话里连发多条，看每轮耗时怎么变（区分「冷启动一次」和「每轮都慢」）。
// 用法：AGENT=qq-chat-v2 node spike/bench-turns.mjs <model> <variant> <轮数>
import { NodeApiClient, unwrap, createTurnCollector } from '../src/oc-client.js';
import { PATHS } from '../src/oc-env.js';

const ROOT = 'C:\\Users\\<用户>\\DualHabitatMatrix';
const model = process.argv[2] || 'qwen3.8-max';
const variant = process.argv[3] || 'none';
const rounds = Number(process.argv[4] || 3);

const api = new NodeApiClient(undefined, undefined, { stateDir: PATHS.state, sessionDir: PATHS.state, log: () => {} });

// 模拟桥接注入的真实体量：6000 字的群聊上下文
const filler = Array.from({ length: 90 }, (_, i) =>
  `[群友${i % 7}] 第${i}条闲聊，今天天气不错，有人在吗，我准备出门买点东西顺便吃饭`
).join('\n');
const bigPrompt = `群聊上下文（最近消息）：\n${filler}\n\n现在 [阿杰] @ 你：你怎么看？回一句。不要调用任何工具。`;

const ws = unwrap(await api.workspace.create({ path: ROOT }), 'workspace.create');
const created = unwrap(
  await api.sessions.create({
    workspaceId: ws.workspace.workspaceId,
    ...(process.env.AGENT ? { agentPreset: process.env.AGENT } : {}),
    title: `turns-${model}`
  }),
  'sessions.create'
);
const sessionId = created.sessionId;
unwrap(await api.sessions.selectModel({ sessionId, provider: 'bailian', model, reasoningEffort: variant }), 'selectModel');
console.log(`会话 ${sessionId}  模型 ${model}#${variant}  上下文 ${bigPrompt.length} 字`);

const collector = createTurnCollector();
const stream = api.events.mux({});
const queue = [];
let wake = null;
(async () => {
  for await (const env of stream) {
    const f = env.payload;
    if (f.type !== 'session/event' || f.sessionId !== sessionId) continue;
    const ended = collector.push(f.event);
    if (ended) queue.push(ended);
    if (wake) { const w = wake; wake = null; w(); }
  }
})();
api.events.follow(sessionId);

async function waitTurn(timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (!queue.length) {
    if (Date.now() > deadline) throw new Error('超时');
    await new Promise((r) => { wake = r; setTimeout(r, 300); });
  }
  return queue.shift();
}

for (let i = 1; i <= rounds; i++) {
  const text = i === 1 ? '只回复两个字：收到' : bigPrompt;
  const t0 = Date.now();
  unwrap(await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text }] }), 'prompt');
  const ended = await waitTurn();
  console.log(`第${i}轮 输入${text.length}字 → ${Date.now() - t0}ms 「${String(ended.text).replace(/\s+/g, ' ').slice(0, 40)}」 reason=${JSON.stringify(ended.reason)}`);
}
try { await api.sessions.delete?.({ sessionId }); } catch {}
process.exit(0);
