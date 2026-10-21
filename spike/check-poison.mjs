// 验证「同一会话里第二轮会不会因为历史里的 reasoning 块被 400」。
// 用法：node spike/check-poison.mjs <provider/model> <variant>
import { NodeApiClient, unwrap, createTurnCollector } from '../src/oc-client.js';
import { PATHS } from '../src/oc-env.js';

const ROOT = 'C:\\Users\\<用户>\\DualHabitatMatrix';
const [ref = 'bailian/qwen3.7-max', variant = 'low'] = process.argv.slice(2);
const [providerID, ...rest] = ref.split('/');
const modelId = rest.join('/');

const api = new NodeApiClient(undefined, undefined, {
  stateDir: PATHS.state,
  sessionDir: PATHS.state,
  models: { enabled: false, allowPaid: false, exhaustedNotice: '', free: [], paid: [] },
  log: () => {}
});

const ws = unwrap(await api.workspace.create({ path: ROOT }), 'workspace.create');
const created = unwrap(await api.sessions.create({ workspaceId: ws.workspace.workspaceId, title: `poison-${modelId}` }), 'create');
const sessionId = created.sessionId;
unwrap(await api.sessions.selectModel({ sessionId, provider: providerID, model: modelId, reasoningEffort: variant }), 'selectModel');

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

async function turn(text) {
  const t0 = Date.now();
  unwrap(await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text }] }), 'prompt');
  const deadline = Date.now() + 120_000;
  while (!queue.length) {
    if (Date.now() > deadline) return { ms: Date.now() - t0, text: '(超时)', reason: null };
    await new Promise((r) => { wake = r; setTimeout(r, 300); });
  }
  const ended = queue.shift();
  return { ms: Date.now() - t0, text: String(ended.text).replace(/\s+/g, ' ').slice(0, 50), reason: ended.reason };
}

for (let i = 1; i <= 3; i++) {
  const r = await turn(`第${i}轮：只回复两个字，收到`);
  console.log(`第${i}轮 ${r.ms}ms 「${r.text}」 ${JSON.stringify(r.reason ?? {}).slice(0, 160)}`);
}
try { await api.sessions.delete?.({ sessionId }); } catch {}
process.exit(0);
