/**
 * 把 OpenCode 内置工具名枚举出来。
 *
 * 目的：桥接原来用 `permissions:[{action:"*",...deny}]` 一句"全禁"来藏掉本地工具，
 * 但实测这条会把 provider.use 也一起拒掉 → 免费档 403。改成"按工具名逐个禁"就必须
 * 知道**有哪些内置工具**（漏一个就等于给 QQ 群里的人留了后门）。
 *
 * 两条腿：先问 API 有没有现成的工具清单，再直接问模型列一遍，两边对照。
 *
 *   node spike/probe-list-tools.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { Service } from '@opencode/client/service';
import { makeOpenCodeClient } from '../src/oc-client.js';

const DIR = 'C:\\Users\\<用户>\\Documents\\默认项目\\zzz-free-probe\\tools';
const FILE = `${process.env.USERPROFILE}\\.local\\state\\opencode\\service.json`;
const MODEL = { providerID: 'opencode', id: 'deepseek-v4.1-flash-free', variant: 'high' };

fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });
fs.writeFileSync(path.join(DIR, 'opencode.json'), JSON.stringify({}, null, 2));

const ep = await Service.discover({ file: FILE });
const c = makeOpenCodeClient(ep);

// ── 1. API 侧：agent 定义里有没有 tools ────────────────────────────────
try {
  const agents = await c.agent.list({ location: { directory: DIR } });
  const arr = agents?.data ?? agents;
  console.log('agents:', JSON.stringify(arr).slice(0, 800));
} catch (error) {
  console.log('agent.list failed:', error?.message ?? error);
}

// ── 2. 让模型自己报工具名 ─────────────────────────────────────────────
const s = await c.session.create({ model: MODEL, agent: 'build', location: { directory: DIR } });
await c.session.prompt({
  sessionID: s.id,
  text: '列出你当前可用的所有工具名。每行一个，只要英文名字，不要解释、不要调用任何工具。'
});
let list = [];
for (let i = 0; i < 50; i++) {
  await new Promise((r) => setTimeout(r, 500));
  const res = await c.message.list({ sessionID: s.id });
  list = res?.data ?? [];
  if (list.some((m) => m.type === 'idle')) break;
  if (list.some((m) => m.type === 'assistant' && m.finish === 'stop')) break;
}
const text = list
  .filter((m) => m.type === 'assistant')
  .flatMap((m) => m.content ?? [])
  .filter((p) => p?.type === 'text')
  .map((p) => p.text)
  .join('\n');
console.log('\n=== 模型自报工具 ===');
console.log(text.slice(0, 2000));

await c.session.remove({ sessionID: s.id }).catch(() => {});
