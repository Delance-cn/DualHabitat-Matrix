/**
 * 二分：`permissions` 里到底哪一条会触发免费档 403？
 *
 * 已知：
 *   - `[{action:"*",...deny}]`                      → FAIL
 *   - `[{action:"*",...allow}]`                     → PASS
 *   - `[{action:"shell",...deny}]`                  → PASS
 *   - 12 条内置工具 deny + 2 条 MCP allow            → FAIL（意外）
 * 所以要一条条试。每个用例一个全新目录，避免配置重载延迟。
 *
 *   node spike/probe-deny-bisect.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { Service } from '@opencode/client/service';
import { makeOpenCodeClient } from '../src/oc-client.js';

const BASE = 'C:\\Users\\<用户>\\Documents\\默认项目\\zzz-free-probe\\bisect';
const FILE = `${process.env.USERPROFILE}\\.local\\state\\opencode\\service.json`;
const MODEL = { providerID: 'opencode', id: 'deepseek-v4.1-flash-free', variant: 'high' };

const BUILTINS = [
  'read',
  'write',
  'edit',
  'glob',
  'grep',
  'shell',
  'webfetch',
  'websearch',
  'question',
  'skill',
  'subagent',
  'execute'
];
const mcpAllows = [
  { action: 'snowluma_*', resource: '*', effect: 'allow' },
  { action: 'web-search-safe_*', resource: '*', effect: 'allow' }
];
const deny = (action) => ({ action, resource: '*', effect: 'deny' });

const cases = {};
for (const name of BUILTINS) cases[`single deny ${name}`] = { permissions: [deny(name)] };
for (const name of BUILTINS) {
  cases[`single deny ${name} + mcp allows`] = { permissions: [deny(name), ...mcpAllows] };
}
cases['mcp allows only'] = { permissions: [...mcpAllows] };

const ep = await Service.discover({ file: FILE });
const c = makeOpenCodeClient(ep);

let i = 0;
for (const [name, config] of Object.entries(cases)) {
  i += 1;
  const dir = path.join(BASE, `b-${i}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'opencode.json'), JSON.stringify(config, null, 2));

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
  console.log(`${err ? 'FAIL' : 'PASS'}  ${name}`);
  await c.session.remove({ sessionID: s.id }).catch(() => {});
  await new Promise((r) => setTimeout(r, 800));
}

console.log('\ndone');
