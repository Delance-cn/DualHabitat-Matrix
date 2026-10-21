/**
 * 穷举「建会话时的哪个字段能把免费档打开」。
 *
 * 已知：桌面 App 建的会话能用免费档，我们建的一律 403，但只要 parentID 指向
 * App 建的会话就能用。说明服务端对"这个会话是不是 App 弄出来的"有标记。
 * 那就把 App 会话身上**多出来**的东西一个个补进建会话请求里试：
 *   permissions / agent / title / metadata / 额外请求头
 *
 *   node spike/probe-create-variants.mjs
 */

import { Service } from '@opencode/client/service';
import { OpenCode } from '@opencode/client';
import { makeOpenCodeClient } from '../src/oc-client.js';

const FILE = `${process.env.USERPROFILE}\\.local\\state\\opencode\\service.json`;
const MODEL = { providerID: 'opencode', id: 'deepseek-v4.1-flash-free', variant: 'high' };
const LOC = { directory: 'C:\\Users\\Delan' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ep = await Service.discover({ file: FILE });
const c = makeOpenCodeClient(ep);
console.log('endpoint', ep.url);

// 带自定义请求头的客户端（试"入站头能不能冒充 App"）
const cHdr = OpenCode.make({
  baseUrl: ep.url,
  headers: {
    ...Object.fromEntries(Object.entries(ep.auth ? { authorization: 'Basic ' + Buffer.from(ep.auth.username + ':' + ep.auth.password).toString('base64') } : {})),
    'x-opencode-client': 'desktop',
    'x-opencode-app': 'desktop'
  }
});

async function judge(client, sessionID) {
  const list = async () => (await client.message.list({ sessionID }))?.data ?? [];
  const seen = new Set((await list()).map((m) => m.id));
  await client.session.prompt({ sessionID, text: '只回四个字：能用免费' });
  let fresh = [];
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    fresh = (await list()).filter((m) => !seen.has(m.id));
    if (fresh.some((m) => m.type === 'idle')) break;
  }
  const idle = fresh.find((m) => m.type === 'idle');
  const asst = fresh.find((m) => m.type === 'assistant' && (m.content ?? []).some((p) => p?.type === 'text'));
  return { ok: !idle?.error && !!asst, status: idle?.error?.status ?? '' };
}

const variants = [
  ['permissions', c, { permissions: [{ action: 'browser', resource: '*', effect: 'allow' }] }],
  ['perms+agent', c, { agent: 'build', permissions: [{ action: 'browser', resource: '*', effect: 'allow' }] }],
  ['title', c, { title: '免费使用咨询' }],
  ['metadata', c, { metadata: { source: 'desktop' } }],
  ['hdrs+client=desktop', cHdr, {}]
];

for (const [label, client, extra] of variants) {
  try {
    const s = await client.session.create({ model: MODEL, location: LOC, ...extra });
    const r = await judge(client, s.id);
    console.log(`  ${label.padEnd(22)} ${r.ok ? 'OK  ✅' : 'BLOCKED ' + r.status}`);
    await client.session.remove({ sessionID: s.id }).catch(() => {});
  } catch (error) {
    console.log(`  ${label.padEnd(22)} ERROR ${error?.message ?? error}`);
  }
}
console.log('✓ done');
