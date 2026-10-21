// 诊断：`agent.list({location:{directory: <真实路径>}})` 在实例**刚重启**时看不到项目 agent，
// 过一会儿又能看到。这个脚本量一下这个窗口有多长 —— 如果桥接恰好在窗口里解析 preset，
// 就会以"preset 不在清单里"为由 fail-closed 拒绝建会话（一条消息都回不了）。
import { ensureServer } from '../src/oc-server.js';
import { NodeApiClient } from '../src/oc-client.js';
import { PATHS, ROOT } from '../src/oc-env.js';

const JUNCTION = 'C:\\Users\\<用户>\\DualHabitatMatrix';

await ensureServer({ log: (m) => console.log(`[server] ${m}`), force: true });

const api = new NodeApiClient(undefined, undefined, { stateDir: PATHS.state, sessionDir: PATHS.state, log: () => {} });
const client = await api._ensureClient();

const probe = async (directory) => {
  const res = await client.agent.list(directory ? { location: { directory } } : {});
  const raw = res?.data ?? res?.agents ?? res;
  const agents = Array.isArray(raw) ? raw : [];
  const ids = agents.map((a) => String(a.id ?? a.name));
  return { n: agents.length, qq: ids.includes('qq-chat'), ids };
};

const t0 = Date.now();
for (let i = 1; i <= 8; i++) {
  const [real, junc] = await Promise.all([probe(ROOT), probe(JUNCTION)]);
  const ms = Date.now() - t0;
  console.log(
    `  +${String(ms).padStart(6)}ms  realpath: n=${String(real.n).padEnd(2)} qq-chat=${real.qq ? '有' : '★无'}   |   junction: n=${String(junc.n).padEnd(2)} qq-chat=${junc.qq ? '有' : '★无'}`
  );
  if (real.qq && junc.qq && i >= 2) {
    console.log('  → 两者都有，稳定后正常');
    break;
  }
  await new Promise((r) => setTimeout(r, 3000));
}
process.exit(0);
