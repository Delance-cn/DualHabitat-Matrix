/**
 * 干净的 fork 测试：只看 fork **之后新产生的**消息，判断免费档到底能不能出话。
 *
 * 上一版踩的坑：fork 会把父会话的历史整段复制过去，用 "有没有 assistant 消息"
 * 当成功判据会立刻命中历史里的旧消息，等于什么都没验证。
 * 所以这里先记下 fork 时的消息数/最大 seq，只认之后的新消息。
 *
 *   node spike/probe-fork-free2.mjs [sourceSessionID] [serviceFile]
 */

import { Service } from '@opencode/client/service';
import { makeOpenCodeClient } from '../src/oc-client.js';

const SOURCE = process.argv[2] ?? 'ses_eb7eca79affdU5CppJn2KhARBs';
const FILE = process.argv[3] ?? `${process.env.USERPROFILE}\\.local\\state\\opencode\\service.json`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ep = await Service.discover({ file: FILE });
const c = makeOpenCodeClient(ep);
console.log('endpoint', ep.url);

const before = (await c.message.list({ sessionID: SOURCE }))?.data ?? [];
console.log('source messages before fork:', before.length);

const child = await c.session.fork({ sessionID: SOURCE });
const childID = child?.id ?? child?.data?.id;
const listAll = async () => (await c.message.list({ sessionID: childID }))?.data ?? [];
const childBefore = await listAll();
const seen = new Set(childBefore.map((m) => m.id));
console.log('forked →', childID, '· inherited messages:', childBefore.length, '· order hint:', childBefore[0]?.time?.created ?? '?', '→', childBefore.at(-1)?.time?.created ?? '?');

await c.session.prompt({ sessionID: childID, text: '只回四个字：能用免费' });

let fresh = [];
for (let i = 0; i < 90; i++) {
  await sleep(1000);
  const all = await listAll();
  fresh = all.filter((m) => !seen.has(m.id));
  if (fresh.some((m) => m.type === 'idle')) break;
}

console.log('\nfresh messages:', fresh.length);
for (const m of fresh) {
  const text = (m.content ?? [])
    .filter((p) => p?.type === 'text')
    .map((p) => p.text)
    .join('')
    .trim();
  const kinds = (m.content ?? []).map((p) => p?.type).join(',');
  console.log(`  [${m.type}${m.finish ? '/' + m.finish : ''}] kinds=${kinds} ${JSON.stringify(text.slice(0, 160))}`);
  if (m.error?.message) console.log('      error:', m.error.type, m.error.status, m.error.message);
}

const st = await c.session.get({ sessionID: childID });
console.log('child cost =', st.cost, '· tokens =', JSON.stringify(st.tokens));
await c.session.remove({ sessionID: childID }).catch(() => {});
console.log('✓ done (child removed)');
