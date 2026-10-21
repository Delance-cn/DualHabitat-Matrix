/**
 * 免费档被 403 的真正触发条件（逐项、**每个用例一个全新目录**）。
 *
 * 之前的教训：同一个 scratch 目录里反复改写 opencode.json 会踩到"配置重载延迟"，
 * 看起来像随机失败。所以这里每个用例开一个新目录 —— 项目配置按目录隔离，
 * 新目录不可能读到上一个用例的缓存配置。
 *
 *   node spike/probe-config-gate.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { Service } from '@opencode/client/service';
import { makeOpenCodeClient } from '../src/oc-client.js';

const BASE = 'C:\\Users\\<用户>\\Documents\\默认项目\\zzz-free-probe';
const FILE = `${process.env.USERPROFILE}\\.local\\state\\opencode\\service.json`;
const MODEL = { providerID: 'opencode', id: 'deepseek-v4.1-flash-free', variant: 'high' };

const PROJECT_CONFIG = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'opencode.json'), 'utf8')
);
const withoutMcp = { ...PROJECT_CONFIG };
delete withoutMcp.mcp;
const withoutPermissions = { ...PROJECT_CONFIG };
delete withoutPermissions.permissions;

const cases = {
  'control {}': {},
  'permissions deny *': { permissions: [{ action: '*', resource: '*', effect: 'deny' }] },
  'permissions allow *': { permissions: [{ action: '*', resource: '*', effect: 'allow' }] },
  'project config minus mcp': withoutMcp,
  'project config minus permissions': withoutPermissions,
  'project config as-is': PROJECT_CONFIG
};

const ep = await Service.discover({ file: FILE });
const c = makeOpenCodeClient(ep);

async function probe(dir) {
  const s = await c.session.create({ model: MODEL, agent: 'build', location: { directory: dir } });
  await c.session.prompt({ sessionID: s.id, text: '只回四个字：能用免费' });
  let list = [];
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const res = await c.message.list({ sessionID: s.id });
    list = res?.data ?? [];
    if (list.some((m) => m.type === 'idle')) break;
    if (list.some((m) => m.type === 'assistant' && m.finish === 'stop')) break;
  }
  const err = list.find((m) => m.error)?.error;
  const text = (list.find((m) => m.type === 'assistant')?.content ?? [])
    .filter((p) => p?.type === 'text')
    .map((p) => p.text)
    .join('')
    .trim();
  await c.session.remove({ sessionID: s.id }).catch(() => {});
  return err ? { ok: false, why: `${err.type}/${err.status}` } : { ok: true, text };
}

let i = 0;
for (const [name, config] of Object.entries(cases)) {
  i += 1;
  const dir = path.join(BASE, `case-${i}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'opencode.json'), JSON.stringify(config, null, 2));
  const r = await probe(dir);
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${name.padEnd(30)} ${r.ok ? JSON.stringify(r.text) : r.why}`);
  await new Promise((res) => setTimeout(res, 1500));
}

console.log('\ndone');
