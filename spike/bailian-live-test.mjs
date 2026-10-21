// 一次性验证：OpenCode 实例 → bailian provider → 百炼真调用。
// 建会话（qq-chat）→ 切到 bailian/qwen3.8-max → 发一句 → 收文本。跑完即退。
import { ensureServer } from '../src/oc-server.js';
import { NodeApiClient, unwrap, createTurnCollector } from '../src/oc-client.js';
import { PATHS, ROOT } from '../src/oc-env.js';

const log = (m) => console.log(`[bailian-test] ${m}`);
await ensureServer({ log });

const api = new NodeApiClient(undefined, undefined, { stateDir: PATHS.state, sessionDir: PATHS.state, log });
const created = unwrap(await api.sessions.create({ workspaceId: ROOT, agentPreset: 'qq-chat', title: 'bailian-test（可删）' }), 'sessions.create');
log(`会话 ${created.sessionId}`);

// 原始 client 上切模型（同桥接 failover 的用法）
const raw = api._client ?? api.client ?? api;
const client = raw.client ?? raw;
try {
  await client.session.switchModel({ sessionID: created.sessionId, model: { providerID: 'bailian', modelID: 'qwen3.8-max', id: 'qwen3.8-max' } });
  log('已切到 bailian/qwen3.8-max');
} catch (e) {
  log(`switchModel 失败：${e.message}`);
}

const collector = createTurnCollector();
const result = (async () => {
  for await (const frame of api.events.mux()) {
    const done = collector.push(frame.payload.event);
    if (done) return done;
  }
  return null;
})();

unwrap(await api.sessions.prompt({ sessionId: created.sessionId, content: [{ type: 'text', text: '用一句话回答：你是哪个模型？' }] }), 'sessions.prompt');
const ended = await Promise.race([result, new Promise((r) => setTimeout(() => r(null), 120_000))]);
log(ended ? `回合结束 reason=${JSON.stringify(ended.reason)}` : '回合超时');
log(`回复文本：${JSON.stringify(ended?.text ?? '')}`);
try { await api.workspace.archiveSession({ sessionId: created.sessionId }); } catch {}
process.exit(0);
