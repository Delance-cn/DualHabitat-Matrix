/**
 * 已经定位到：免费档不是"身份"问题，是**项目配置**问题。
 *
 *   location.directory = 任意干净目录        → 能用免费（cost 0）
 *   location.directory = DualHabitat-Matrix  → 403 FreeTierError
 *   把该项目 opencode.json 原样拷到干净目录  → 403
 *   只留 {"model": "opencode/deepseek-v4.1-flash-free"} → 能用
 *
 * 所以是那份 28KB 配置里的某个字段触发了服务端拒绝。这里做二分：
 * 逐个删掉顶层字段，看哪一个删掉之后就恢复。
 *
 *   node spike/bisect-free.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Service } from '@opencode/client/service';
import { makeOpenCodeClient } from '../src/oc-client.js';

const FULL = JSON.parse(fs.readFileSync(new URL('../opencode.json', import.meta.url), 'utf8'));
const FILE = path.join(os.homedir(), '.local', 'state', 'opencode', 'service.json');
const MODEL = { providerID: 'opencode', id: 'deepseek-v4.1-flash-free', variant: 'high' };
const ROOT = path.join(os.tmpdir(), 'opencode-free-bisect');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ep = await Service.discover({ file: FILE });
const c = makeOpenCodeClient(ep);
console.log('endpoint', ep.url);
console.log('full config top-level keys:', Object.keys(FULL).join(', '));

const base = { $schema: FULL.$schema, model: FULL.model };
const variants = [
  ['FULL（对照，应 403）', FULL],
  ['去掉 permissions', omit('permissions')],
  ['去掉 agents', omit('agents')],
  ['去掉 mcp', omit('mcp')],
  ['去掉 update', omit('update')],
  ['只留 model', base],
  ['只留 model+permissions', { ...base, permissions: FULL.permissions }],
  ['只留 model+agents', { ...base, agents: FULL.agents }],
  ['只留 model+mcp', { ...base, mcp: FULL.mcp }]
];

function omit(key) {
  const copy = { ...FULL };
  delete copy[key];
  return copy;
}

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });

async function probeDir(dir) {
  const s = await c.session.create({ model: MODEL, location: { directory: dir } });
  try {
    const list = async () => (await c.message.list({ sessionID: s.id }))?.data ?? [];
    const seen = new Set((await list()).map((m) => m.id));
    await c.session.prompt({ sessionID: s.id, text: '只回四个字：能用免费' });
    let fresh = [];
    for (let i = 0; i < 40; i++) {
      await sleep(1000);
      fresh = (await list()).filter((m) => !seen.has(m.id));
      if (fresh.some((m) => m.type === 'idle')) break;
    }
    const idle = fresh.find((m) => m.type === 'idle');
    const bad =
      idle?.error ??
      fresh.find((m) => m.type === 'assistant' && m.finish === 'error')?.error ??
      fresh.find((m) => m.type === 'assistant' && m.error)?.error;
    return bad ? `BLOCKED ${bad.status ?? ''} ${bad.type ?? ''}` : 'OK';
  } finally {
    await c.session.remove({ sessionID: s.id }).catch(() => {});
  }
}

for (const [label, cfg] of variants) {
  const dir = path.join(ROOT, label.replace(/[^\w\u4e00-\u9fa5]+/g, '_').slice(0, 40));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'opencode.json'), JSON.stringify(cfg, null, 2));
  const verdict = await probeDir(dir);
  console.log('  ' + label.padEnd(28), verdict);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('✓ done');
