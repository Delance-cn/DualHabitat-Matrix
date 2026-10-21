/**
 * "目录决定论"是**服务状态**还是**目录本身**？
 *
 * 已知事实（都在真机上复现过）：
 *   隔离实例 4599，会话目录 = DualHabitat-Matrix        → provider.auth 403
 *   隔离实例 4599，会话目录 = 任意其它目录（含其子目录） → 正常出话，cost 0
 *   桌面服务 45278，同样是"桥接目录 403 / 别的目录 OK"
 *   把桥接那份 opencode.json 原样放进别的目录           → 正常（所以不是配置内容）
 *   git init / git init + remote                        → 正常（所以不是 .git）
 *
 * 剩下的可能：4599 这个**跑了很久的实例**把"桥接项目被拒"缓存下来了。
 * 本脚本起一个**全新的一次性实例**（独立端口+目录，不碰 4599），
 * 用同一个会话目录再问一次：
 *   全新实例也 403 → 目录/项目本身被服务端判定，缓存无关
 *   全新实例正常   → 是实例状态问题（重启隔离实例即可）
 *
 *   node spike/probe-fresh-instance.mjs "<目录>" [更多目录...]
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Service } from '@opencode/client/service';
import { makeOpenCodeClient } from '../src/oc-client.js';
import { ROOT, resolveCli } from '../src/oc-env.js';

const dirs = process.argv.slice(2);
if (dirs.length === 0) dirs.push(ROOT);

const PORT = 4697;
const ROOT_TMP = path.join(ROOT, '.oc', 'work', 'fresh-instance');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.rmSync(ROOT_TMP, { recursive: true, force: true });
fs.mkdirSync(path.join(ROOT_TMP, 'state'), { recursive: true });

const env = { ...process.env };
env.XDG_DATA_HOME = path.join(ROOT_TMP, 'data');
env.XDG_CONFIG_HOME = path.join(ROOT_TMP, 'config');
env.XDG_CACHE_HOME = path.join(ROOT_TMP, 'cache');
env.XDG_STATE_HOME = path.join(ROOT_TMP, 'state');
delete env.OPENCODE_CLIENT;

const child = spawn(resolveCli(), ['serve', '--service', '--hostname', '127.0.0.1', '--port', String(PORT)], {
  cwd: ROOT,
  env,
  detached: true,
  windowsHide: true,
  stdio: 'ignore'
});
child.unref();

const file = path.join(ROOT_TMP, 'state', 'opencode', 'service.json');
let record;
for (let i = 0; i < 100; i++) {
  await sleep(250);
  if (!fs.existsSync(file)) continue;
  try {
    record = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Number(record.pid) === child.pid) break;
  } catch {}
}
console.log(`fresh instance pid=${child.pid} url=${record?.url}`);

const c = makeOpenCodeClient(await Service.discover({ file }));

for (const dir of dirs) {
  const s = await c.session.create({
    model: { providerID: 'opencode', id: 'deepseek-v4.1-flash-free', variant: 'high' },
    location: { directory: dir }
  });
  await c.session.prompt({ sessionID: s.id, text: '只回四个字：能用免费' });
  let verdict = 'TIMEOUT';
  for (let i = 0; i < 120; i++) {
    await sleep(500);
    const res = await c.message.list({ sessionID: s.id });
    const list = res?.data ?? [];
    const done = list.find((m) => m.type === 'assistant' && m.finish) ?? list.find((m) => m.type === 'idle');
    if (!done) continue;
    const text = (done.content ?? []).filter((p) => p?.type === 'text').map((p) => p.text).join('').trim();
    verdict = `${done.finish ?? done.outcome}${done.error ? ` ${done.error.type}/${done.error.status}` : ''} text=${JSON.stringify(text.slice(0, 40))}`;
    break;
  }
  console.log(`  ${verdict.includes('403') ? '✗ 403' : verdict.includes('text=""') ? '? ' : '✓ 能用'}  ${dir}`);
  console.log(`      ${verdict}`);
  await c.session.remove({ sessionID: s.id }).catch(() => {});
}

try { process.kill(child.pid); } catch {}
