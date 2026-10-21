// 验证某个模型到底能不能吃图片：直接塞一张 1x1 的 PNG 进去看会不会 400。
// 用法：node spike/test-image.mjs <provider/model> <variant>
import { NodeApiClient, unwrap, createTurnCollector } from '../src/oc-client.js';
import { PATHS } from '../src/oc-env.js';

const ROOT = 'C:\\Users\\<用户>\\DualHabitatMatrix';
const [ref = 'bailian/qwen3.7-max', variant = 'low'] = process.argv.slice(2);
const [providerID, ...rest] = ref.split('/');
const modelId = rest.join('/');

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const api = new NodeApiClient(undefined, undefined, {
  stateDir: PATHS.state,
  sessionDir: PATHS.state,
  models: { enabled: false, allowPaid: false, exhaustedNotice: '', free: [], paid: [] },
  log: () => {}
});

const ws = unwrap(await api.workspace.create({ path: ROOT }), 'workspace.create');
const created = unwrap(await api.sessions.create({ workspaceId: ws.workspace.workspaceId, title: `img-${modelId}` }), 'create');
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

const t0 = Date.now();
unwrap(
  await api.sessions.prompt({
    sessionId,
    mode: 'queue',
    content: [
      { type: 'text', text: '这张图是什么颜色？只回答颜色。' },
      { type: 'image', mediaType: 'image/png', data: PNG, name: 'test.png' }
    ]
  }),
  'prompt'
);

const deadline = Date.now() + 120_000;
while (!queue.length) {
  if (Date.now() > deadline) { console.log('超时'); process.exit(1); }
  await new Promise((r) => { wake = r; setTimeout(r, 300); });
}
const ended = queue.shift();
console.log(`${providerID}/${modelId}#${variant} ${Date.now() - t0}ms 「${String(ended.text).replace(/\s+/g, ' ').slice(0, 40)}」 reason=${JSON.stringify(ended.reason).slice(0, 220)}`);
try { await api.sessions.delete?.({ sessionId }); } catch {}
process.exit(0);
