// 走一遍真实回合：建会话（agent=qq-chat）→ 发一句 → 用 collector 收文本。
// 这一步会把 MCP（QQ 工具）也拉起来，所以能顺带验证它不会把回合拖死。
// 跑法：node spike/smoke-turn.mjs
import { ensureServer } from '../src/oc-server.js';
import { NodeApiClient, unwrap, createTurnCollector } from '../src/oc-client.js';
import { PATHS, ROOT } from '../src/oc-env.js';

const log = (m) => console.log(`[turn] ${m}`);
await ensureServer({ log });

const api = new NodeApiClient(undefined, undefined, { stateDir: PATHS.state, sessionDir: PATHS.state, log });

const created = unwrap(
  await api.sessions.create({ workspaceId: ROOT, agentPreset: 'qq-chat', title: 'smoke（可删）' }),
  'sessions.create'
);
log(`会话 ${created.sessionId}`);

const collector = createTurnCollector();
const result = (async () => {
  for await (const frame of api.events.mux()) {
    const done = collector.push(frame.payload.event);
    if (done) return done;
  }
  return null;
})();

unwrap(
  await api.sessions.prompt({ sessionId: created.sessionId, content: [{ type: 'text', text: '你好，用一句话介绍你自己。' }] }),
  'sessions.prompt'
);

const ended = await Promise.race([result, new Promise((r) => setTimeout(() => r(null), 120_000))]);
log(ended ? `回合结束 reason=${JSON.stringify(ended.reason)}` : '回合超时（没等到 turn/end）');
log(`回复文本：${JSON.stringify(ended?.text ?? '')}`);

try {
  await api.workspace.archiveSession({ sessionId: created.sessionId });
  log('测试会话已中断/清理');
} catch (error) {
  log(`清理失败（无妨）：${error?.message ?? error}`);
}
process.exit(0);
