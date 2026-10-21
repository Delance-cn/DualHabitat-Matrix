/**
 * 二分：桥接的 opencode.json 里，到底是哪个键让免费档从"能用"变成 403。
 *
 * 已确定的因果（不是猜的）：
 *   - 目录里没有 opencode.json（或只有 model） → 免费档正常出话，cost 0
 *   - 目录里放**桥接那份完整** opencode.json   → provider.auth 403 FreeTierError
 * 所以原因一定在这份配置的某个键里。逐个键单独放进干净目录跑一遍即可定位。
 *
 *   node spike/probe-json-bisect.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = 'C:\\Users\\<用户>\\Documents\\默认项目\\DualHabitat-Matrix';
const SOURCE = path.join(BRIDGE, 'opencode.json');
const DIR = path.join(BRIDGE, '.oc', 'work', 'freecheck');
const SERVICE = path.join(BRIDGE, '.oc', 'state', 'opencode', 'service.json');
const MODEL = 'deepseek-v4.1-flash-free';

const base = JSON.parse(fs.readFileSync(SOURCE, 'utf8'));
const target = path.join(DIR, 'opencode.json');
fs.mkdirSync(DIR, { recursive: true });

function run(label, config) {
  fs.writeFileSync(target, JSON.stringify(config, null, 2));
  let out = '';
  try {
    out = execFileSync(process.execPath, [path.join(HERE, 'probe-opencode-free.mjs'), MODEL, SERVICE, 'high'], {
      cwd: DIR,
      encoding: 'utf8',
      timeout: 120000
    });
  } catch (error) {
    out = `${error.stdout ?? ''}${error.stderr ?? ''}`;
  }
  const denied = /provider\.auth\/403/.test(out);
  const ok = /text="[^"]*"/.test(out) && !denied;
  console.log(`${ok ? '✓ 能用' : denied ? '✗ 403' : '? 未知'}  ${label}`);
  if (!ok && !denied) console.log(out.split('\n').slice(0, 8).join('\n'));
}

run('（对照）只有 model', { model: base.model });
for (const key of ['permissions', 'update', 'mcp', 'agents']) {
  if (base[key] === undefined) continue;
  run(`model + ${key}`, { model: base.model, [key]: base[key] });
}
run('（对照）完整配置', base);
