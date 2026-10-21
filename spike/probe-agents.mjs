// 诊断：同一个 `opencode.json`，经 junction 路径和真实路径看到的 agent 列表居然不一样。
//
// 现象：`agentPresets.list({})`（兜底 `process.cwd()` = junction 路径）能看到 qq-chat，
// 而 `agentPresets.policy({ directory: ROOT })`（ROOT 是 oc-env 的 realpath）报
// 「找不到 agent qq-chat」。本脚本把三种目录都打一遍。
import { NodeApiClient, unwrap } from '../src/oc-client.js';
import { PATHS, ROOT } from '../src/oc-env.js';

const api = new NodeApiClient(undefined, undefined, { stateDir: PATHS.state, sessionDir: PATHS.state, log: () => {} });
const client = await api._ensureClient();

const JUNCTION = 'C:\\Users\\<用户>\\DualHabitatMatrix';

const cases = [
  ['不带 location', {}],
  ['location = junction', { location: { directory: JUNCTION } }],
  ['location = realpath', { location: { directory: ROOT } }]
];

for (const [label, params] of cases) {
  try {
    const res = await client.agent.list(params);
    const raw = res?.data ?? res?.agents ?? res;
    const agents = Array.isArray(raw) ? raw : [];
    const ids = agents.map((a) => String(a.id ?? a.name));
    console.log(`\n=== ${label} ===`);
    console.log(`  数量=${agents.length}`);
    console.log(`  ${ids.join(', ')}`);
    const qq = agents.find((a) => String(a.id ?? a.name) === 'qq-chat');
    if (qq) {
      console.log(`  qq-chat.permissions = ${JSON.stringify(qq.permissions)}`);
      console.log(`  qq-chat.mode = ${qq.mode}  keys = ${Object.keys(qq).join(',')}`);
    } else {
      console.log('  ★ 没有 qq-chat');
    }
  } catch (error) {
    console.log(`\n=== ${label} ===\n  ★ 抛错：${error?.message ?? error}`);
  }
}

console.log('\n--- ROOT(oc-env) ---');
console.log('  ' + ROOT);
console.log('--- process.cwd() ---');
console.log('  ' + process.cwd());
process.exit(0);
