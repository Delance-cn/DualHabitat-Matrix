// 真机：随包发布的 `models.json` 到底能不能用。
//
// 这个测试不传任何 inline 配置，走的就是运维会走的那条路：
//   读 models.json → 按真实模型目录校验候选 → 建会话 → 投递 → 拿回复。
//
// 重点验两件事：
//   1. 目录里没有的候选（`zhipuai/glm-4-flash` 要靠自定义模型条目）被**自动剔掉**，
//      而不是留在链里等着 switchModel 失败把链卡住。
//   2. 剔完之后，首选候选真的能把一句话答回来（配置不是纸上谈兵）。
//
// 前置：node spike/start-server.mjs
// 跑法：node spike/test-pool-live.mjs
import fs from 'node:fs';
import path from 'node:path';
import { NodeApiClient, createTurnCollector, unwrap } from '../src/oc-client.js';
import { PATHS, ROOT } from './oc-env.mjs';

const WORK_DIR = path.join(ROOT, '.oc', 'work', 'pool-live');
const STATE_DIR = path.join(ROOT, '.oc', 'state', 'pool-live');
fs.rmSync(STATE_DIR, { recursive: true, force: true });
fs.mkdirSync(WORK_DIR, { recursive: true });

let failed = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
  }
};

// 故意**不传** models：走 models.json
const logs = [];
const api = new NodeApiClient(undefined, undefined, {
  stateDir: PATHS.state,
  sessionDir: STATE_DIR,
  log: (m, e) => {
    logs.push(`${m} ${e ?? ''}`.trim());
    console.log(`    [client] ${m}`, e ?? '');
  }
});

console.log('== 1. 配置来源与候选校验 ==');
const client = await api._ensureClient();
const info = await client.server.info();
check(`发现端点（version=${info.version}）`, Boolean(info.version), api.endpointUrl);

check(
  '池子来自 models.json（不是内置默认）',
  logs.some((l) => l.includes('models.json')),
  logs.find((l) => l.includes('模型池来自')) ?? '(没有来源日志)'
);

const status = api.chainStatus();
const keys = status.map((s) => s.key);
console.log('    [校验后的链]', JSON.stringify(keys));
check('链里有候选（没被清空）', keys.length > 0, JSON.stringify(keys));
check(
  '目录里没有的 glm-4-flash 被剔掉',
  !keys.some((k) => k.includes('glm-4-flash') && !k.includes('4.5')),
  JSON.stringify(keys)
);
check(
  '剔掉时有明确告警（运维要看得见）',
  logs.some((l) => l.includes('已从链里剔除')),
  logs.find((l) => l.includes('已从链里剔除')) ?? '(没有剔除日志)'
);
check('首选仍是智谱 4.5-flash#none', keys[0] === 'zhipuai/glm-4.5-flash#none', keys[0]);
check('CF 候选在目录里、被保留', keys.some((k) => k.startsWith('cloudflare-workers-ai/')), JSON.stringify(keys));

console.log('== 2. 用池子里的首选真答一句话 ==');
const ws = unwrap(await api.workspace.create({ path: WORK_DIR }), 'workspace.create');
const created = unwrap(await api.sessions.create({ workspaceId: ws.workspace.workspaceId }), 'sessions.create');
const sessionId = created.sessionId;
const sel = unwrap(await api.sessions.selectModel({ sessionId }), 'sessions.selectModel');
check(`selectModel 落在链的首选（${sel.selected.provider}/${sel.selected.model}）`, sel.selected.model === 'glm-4.5-flash');

const collector = createTurnCollector();
let resolveTurn = null;
const turnDone = new Promise((r) => {
  resolveTurn = r;
});
const mux = (async () => {
  for await (const envelope of api.events.mux()) {
    if (envelope.payload.type !== 'session/event') continue;
    const ended = collector.push(envelope.payload.event);
    if (ended) resolveTurn(ended);
  }
})().catch((error) => console.log('    [mux 结束]', error?.message ?? error));

await new Promise((r) => setTimeout(r, 800));
await api.sessions.prompt({
  sessionId,
  mode: 'queue',
  content: [{ type: 'text', text: '只回答一句话，不要调用任何工具：3 乘 7 等于几？' }]
});
const done = await Promise.race([
  turnDone,
  new Promise((resolve) => setTimeout(() => resolve({ text: '', reason: { kind: 'timeout' } }), 90_000))
]);
check(`回合正常结束（reason=${done?.reason?.kind}）`, done?.reason?.kind === 'completed', JSON.stringify(done));
check(`拿到回复：${JSON.stringify(done?.text)}`, (done?.text ?? '').length > 0);
check('没有候选被熔断（这次不该踩任何坑）', api.chainStatus().every((s) => s.usable), JSON.stringify(api.chainStatus()));

mux.catch(() => {});
setTimeout(() => {
  console.log('');
  if (failed) {
    console.log(`✗ 有 ${failed} 项没过`);
    process.exit(1);
  }
  console.log('✓ 全部通过');
  process.exit(0);
}, 800);
