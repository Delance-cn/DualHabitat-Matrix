/**
 * 免费档是不是"只要有爹就行"？
 *
 * 已知：
 *   A 无父根会话            → 403
 *   B parentID = App 建的会话 → OK
 *
 * 如果 C「parentID = 我们自己建的根会话」也 OK，那触发条件就只是"存在父会话"，
 * 桥接只需要每次建两个会话（一个当壳、一个真用）；否则就需要一个 **App 建的种子会话**。
 *
 *   node spike/probe-parent-chain.mjs [serviceFile]
 */

import { Service } from '@opencode/client/service';
import { makeOpenCodeClient } from '../src/oc-client.js';

const FILE = process.argv[2] ?? `${process.env.USERPROFILE}\\.local\\state\\opencode\\service.json`;
const MODEL = { providerID: 'opencode', id: 'deepseek-v4.1-flash-free', variant: 'high' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ep = await Service.discover({ file: FILE });
const c = makeOpenCodeClient(ep);
console.log('endpoint', ep.url);

async function probe(label, sessionID) {
  const list = async () => (await c.message.list({ sessionID }))?.data ?? [];
  const seen = new Set((await list()).map((m) => m.id));
  await c.session.prompt({ sessionID, text: '只回四个字：能用免费' });
  let fresh = [];
  for (let i = 0; i < 45; i++) {
    await sleep(1000);
    fresh = (await list()).filter((m) => !seen.has(m.id));
    if (fresh.some((m) => m.type === 'idle')) break;
  }
  const idle = fresh.find((m) => m.type === 'idle');
  const asst = fresh.find((m) => m.type === 'assistant' && (m.content ?? []).some((p) => p?.type === 'text'));
  const text = (asst?.content ?? []).filter((p) => p?.type === 'text').map((p) => p.text).join('').trim();
  console.log(`\n── ${label} (${sessionID})\n   ${idle?.error ? 'BLOCKED ' + idle.error.status : asst ? 'OK' : 'no-answer'}`);
  if (text) console.log('   text:', JSON.stringify(text.slice(0, 80)));
  return !idle?.error && !!asst;
}

const loc = { directory: process.cwd() };
const root = await c.session.create({ agent: 'build', model: MODEL, location: loc });
console.log('root  =', root.id);
const child = await c.session.create({ agent: 'build', model: MODEL, parentID: root.id, location: loc });
console.log('child =', child.id);
const grand = await c.session.create({ agent: 'build', model: MODEL, parentID: child.id, location: loc });
console.log('grand =', grand.id);

await probe('C  self-root → child', child.id);
await probe('D  child → grandchild', grand.id);

for (const s of [grand, child, root]) await c.session.remove({ sessionID: s.id ?? s.id }).catch(() => {});
console.log('\n✓ done');
