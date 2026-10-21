/**
 * 关键一测：隔离实例上的会话，只要 parentID 指向**桌面 App 建的会话 id**，能不能用免费档？
 *
 * 如果行得通，桥接就完全不用改架构：继续用隔离实例，只在建会话时挂一个"种子父会话"。
 * 如果不行（隔离实例没这个种子的任何本地记录），那就只能连桌面服务，或放弃免费档。
 *
 * 前提：这个 id 是桌面 App 真的用过、并且服务端认账的会话。
 *
 *   node spike/probe-isolated-parent.mjs [seedSessionID]
 */

import { Service } from '@opencode/client/service';
import { makeOpenCodeClient } from '../src/oc-client.js';

const SEED = process.argv[2] ?? 'ses_eb7eca79affdU5CppJn2KhARBs';
const ISOLATED = '.oc/state/opencode/service.json';
const MODEL = { providerID: 'opencode', id: 'deepseek-v4.1-flash-free', variant: 'high' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ep = await Service.discover({ file: ISOLATED });
const c = makeOpenCodeClient(ep);
console.log('isolated endpoint', ep.url, '· seed (App 建的)', SEED);

const child = await c.session.create({
  agent: 'qq-chat',
  model: MODEL,
  parentID: SEED,
  location: { directory: process.cwd() }
});
console.log('child =', child.id, '· parentID =', SEED);

const list = async () => (await c.message.list({ sessionID: child.id }))?.data ?? [];
const seen = new Set((await list()).map((m) => m.id));
await c.session.prompt({ sessionID: child.id, text: '只回四个字：能用免费' });

let fresh = [];
for (let i = 0; i < 45; i++) {
  await sleep(1000);
  fresh = (await list()).filter((m) => !seen.has(m.id));
  if (fresh.some((m) => m.type === 'idle')) break;
}
const idle = fresh.find((m) => m.type === 'idle');
const asst = fresh.find((m) => m.type === 'assistant' && (m.content ?? []).some((p) => p?.type === 'text'));
const text = (asst?.content ?? []).filter((p) => p?.type === 'text').map((p) => p.text).join('').trim();
console.log(idle?.error ? `BLOCKED ${idle.error.status} ${idle.error.message}` : asst ? `OK → ${JSON.stringify(text.slice(0, 80))}` : 'no-answer');
console.log('tokens =', JSON.stringify((await c.session.get({ sessionID: child.id })).tokens));
await c.session.remove({ sessionID: child.id }).catch(() => {});
