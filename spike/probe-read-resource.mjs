/**
 * 免费档要的"read 权限"到底读的是什么资源？
 *
 * 已知：`[{action:"*",...deny}, {action:"read",resource:"*",effect:"allow"}]` → 免费档 PASS。
 * 但那样等于把 read 工具（任意读本机文件）交给了 qq-chat，是安全洞。
 * 如果 CLI 只是要读某个**特定文件/资源**，那就能只放行那一个资源。
 *
 * 本脚本固定 `deny *`，只改 read 的 allow 的 resource，看哪个资源能救回免费档。
 * 一次性把所有候选跑完，能过的那条就是答案。
 *
 *   node spike/probe-read-resource.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { Service } from '@opencode/client/service';
import { makeOpenCodeClient } from '../src/oc-client.js';

const BASE = 'C:\\Users\\<用户>\\Documents\\默认项目\\zzz-free-probe\\readres';
const FILE = `${process.env.USERPROFILE}\\.local\\state\\opencode\\service.json`;
const MODEL = { providerID: 'opencode', id: 'deepseek-v4.1-flash-free', variant: 'high' };

const DENY_ALL = { action: '*', resource: '*', effect: 'deny' };

const resources = [
  '*',
  'C:\\Users\\<用户>\\.local\\share\\opencode\\*',
  'C:\\Users\\<用户>\\.local\\share\\opencode\\opencode.db',
  'C:\\Users\\<用户>\\.config\\opencode\\*',
  'C:\\Users\\<用户>\\AppData\\Roaming\\ai.opencode.desktop\\*',
  'C:\\Users\\<用户>\\Documents\\默认项目\\**',
  'C:\\Users\\<用户>\\AGENTS.md',
  'opencode',
  'integration:opencode',
  'provider:opencode',
  'C:\\Users\\<用户>\\**',
  '**'
];

const ep = await Service.discover({ file: FILE });
const c = makeOpenCodeClient(ep);

let i = 0;
const passed = [];
for (const resource of resources) {
  i += 1;
  const dir = path.join(BASE, `r-${i}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'opencode.json'),
    JSON.stringify({ permissions: [DENY_ALL, { action: 'read', resource, effect: 'allow' }] }, null, 2)
  );

  const s = await c.session.create({ model: MODEL, agent: 'build', location: { directory: dir } });
  await c.session.prompt({ sessionID: s.id, text: '只回四个字：能用免费' });
  let list = [];
  for (let k = 0; k < 30; k++) {
    await new Promise((r) => setTimeout(r, 400));
    const res = await c.message.list({ sessionID: s.id });
    list = res?.data ?? [];
    if (list.some((m) => m.type === 'idle')) break;
    if (list.some((m) => m.type === 'assistant' && m.finish === 'stop')) break;
  }
  const err = list.find((m) => m.error)?.error;
  if (!err) passed.push(resource);
  console.log(`${err ? 'FAIL' : 'PASS'}  read allow resource = ${JSON.stringify(resource)}`);
  await c.session.remove({ sessionID: s.id }).catch(() => {});
  await new Promise((r) => setTimeout(r, 700));
}

console.log('\n可通过的资源：', JSON.stringify(passed));
