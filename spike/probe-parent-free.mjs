/**
 * 免费档准入的**最小触发条件**是什么？
 *
 * 已确认：
 *   - 新建会话（无父）→ 403 FreeTierError
 *   - fork 自 App 建的会话 → 能出话（cost 0）
 *
 * 现在要区分是「必须有 parentID」还是「必须走 fork 那条路（复制历史）」，
 * 因为两者的工程代价差很远：只要有 parentID，桥接就能建一个干净的子会话；
 * 只能靠 fork 的话，每个 QQ 会话都会背上种子的历史。
 *
 *   node spike/probe-parent-free.mjs [seedSessionID] [serviceFile]
 */

import { Service } from '@opencode/client/service';
import { makeOpenCodeClient } from '../src/oc-client.js';

const SEED = process.argv[2] ?? 'ses_eb7eca79affdU5CppJn2KhARBs';
const FILE = process.argv[3] ?? `${process.env.USERPROFILE}\\.local\\state\\opencode\\service.json`;
const MODEL = { providerID: 'opencode', id: 'deepseek-v4.1-flash-free', variant: 'high' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ep = await Service.discover({ file: FILE });
const c = makeOpenCodeClient(ep);
console.log('endpoint', ep.url, '· seed', SEED);

async function run(label, sessionID) {
  const list = async () => (await c.message.list({ sessionID }))?.data ?? [];
  const seen = new Set((await list()).map((m) => m.id));
  await c.session.prompt({ sessionID, text: '只回四个字：能用免费' });

  let fresh = [];
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    const all = await list();
    fresh = all.filter((m) => !seen.has(m.id));
    if (fresh.some((m) => m.type === 'idle')) break;
  }
  const idle = fresh.find((m) => m.type === 'idle');
  const asst = fresh.find((m) => m.type === 'assistant' && (m.content ?? []).some((p) => p?.type === 'text'));
  const text = (asst?.content ?? []).filter((p) => p?.type === 'text').map((p) => p.text).join('').trim();
  const verdict = idle?.error ? `BLOCKED ${idle.error.status} ${idle.error.type}` : asst ? 'OK' : 'no-answer';
  console.log(`\n── ${label} (${sessionID})\n   fresh=${fresh.length} → ${verdict}`);
  if (text) console.log('   text:', JSON.stringify(text.slice(0, 120)));
  if (idle?.error?.message) console.log('   error:', idle.error.message);
  const st = await c.session.get({ sessionID });
  console.log('   tokens =', JSON.stringify(st.tokens));
}

// A：新建根会话（预期 403，作为对照）
const root = await c.session.create({ agent: 'build', model: MODEL, location: { directory: process.cwd() } });
await run('A root (no parent)', root.id);

// B：只要 parentID，不复制历史
let child;
try {
  child = await c.session.create({ agent: 'build', model: MODEL, parentID: SEED, location: { directory: process.cwd() } });
  await run('B create with parentID', child.id);
} catch (error) {
  console.log('\n── B create with parentID FAILED:', error?.message ?? error);
}

for (const id of [root?.id, child?.id]) {
  if (id) await c.session.remove({ sessionID: id }).catch(() => {});
}
console.log('\n✓ done');
