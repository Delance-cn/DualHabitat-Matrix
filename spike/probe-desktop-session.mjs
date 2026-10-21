// 最后一问：**桌面端服务上，外部客户端开的「会话」能不能用官方免费档。**
//
// `generate.text`（一次性生成）在桌面端和独立实例上都被拒了：
//   OpenCode's free tier can only be used from within OpenCode.
// 但本对话所在的会话用的就是免费档，它是活的 —— 所以「会话」这条路径要单独验。
//
// 每步都容错，顺便把接口形状探清楚。测完删掉会话。
// 跑法：node spike/probe-desktop-session.mjs
import os from 'node:os';
import path from 'node:path';

import { OpenCode } from '@opencode/client';
import { Service } from '@opencode/client/service';

const FILE = path.join(os.homedir(), '.local', 'state', 'opencode', 'service.json');
const WORKSPACE = 'C:\\Users\\<用户>\\Documents\\默认项目';
const MODEL = { providerID: 'opencode', id: 'deepseek-v4.1-flash-free' };

const ep = await Service.discover({ file: FILE });
console.log(`桌面端端点：${ep?.url}\n`);
const client = OpenCode.make({ baseUrl: ep.url, headers: Service.headers(ep) });

const step = async (label, fn) => {
  try {
    const v = await fn();
    console.log(`✅ ${label}`);
    return v;
  } catch (error) {
    console.log(`❌ ${label}：${String(error?.message ?? error).slice(0, 300)}`);
    return null;
  }
};

const created =
  (await step('session.create(带 model=免费档)', () =>
    client.session.create({ title: 'probe（桥接实验，可删）', model: MODEL, location: { directory: WORKSPACE } })
  )) ?? null;
console.log('   →', JSON.stringify(created)?.slice(0, 300));
const sessionID = created?.sessionID ?? created?.id;
if (!sessionID) {
  console.log('拿不到 sessionID，后面没法继续。');
  process.exit(0);
}

await step('session.prompt', () => client.session.prompt({ sessionID, text: '只回复两个字：收到' }));
await step('session.wait', () => client.session.wait({ sessionID }));

const msgs = await step('message.list', () => client.message.list({ sessionID }));
const arr = msgs?.data ?? msgs?.messages ?? msgs ?? [];
console.log(`   消息数 ${Array.isArray(arr) ? arr.length : '?'}`);
for (const m of Array.isArray(arr) ? arr : []) {
  const s = JSON.stringify(m);
  const isAssistant = /assistant/i.test(s);
  if (isAssistant) console.log(`   [assistant] ${s.slice(0, 600)}`);
  if (/error|Error/.test(s)) console.log(`   [可能有错] ${s.slice(0, 400)}`);
}

await step('session.remove(清理)', () => client.session.remove({ sessionID }));
process.exit(0);
