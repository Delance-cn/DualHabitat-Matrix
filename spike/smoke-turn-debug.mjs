// 调试版：把收到的每一帧类型打出来，看回合到底走到哪一步。
import { ensureServer } from '../src/oc-server.js';
import { NodeApiClient, unwrap } from '../src/oc-client.js';
import { PATHS, ROOT } from '../src/oc-env.js';

const log = (m) => console.log(`[dbg] ${m}`);
await ensureServer({ log });
const api = new NodeApiClient(undefined, undefined, { stateDir: PATHS.state, sessionDir: PATHS.state, log });

const created = unwrap(await api.sessions.create({ workspaceId: ROOT, agentPreset: 'qq-chat', title: 'dbg（可删）' }), 'create');
log(`会话 ${created.sessionId}`);

const seen = [];
const done = (async () => {
  for await (const frame of api.events.mux()) {
    const t = frame?.payload?.type ?? '?';
    seen.push(t);
    console.log(`  ← ${t} ${JSON.stringify(frame?.payload?.data ?? {}).slice(0, 160)}`);
    if (t === 'turn/end') return frame.payload;
  }
})();

const res = await api.sessions.prompt({ sessionId: created.sessionId, content: [{ type: 'text', text: '你好，一句话介绍你自己。' }] });
log(`prompt 返回 ${JSON.stringify(res).slice(0, 200)}`);

const ended = await Promise.race([done, new Promise((r) => setTimeout(() => r(null), 90_000))]);
log(`结束帧 ${ended ? '有' : '无（超时）'}；帧序 ${seen.join(',')}`);
process.exit(0);
