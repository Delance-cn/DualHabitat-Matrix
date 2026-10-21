/**
 * 免费档到底认什么？
 *
 * 现象：桥接的隔离实例用 `opencode/deepseek-v4.1-flash-free` 直接被拒：
 *   provider.auth 403 "OpenCode's free tier can only be used from within OpenCode."
 * 桌面端自己的服务（45278）**同样的模型**能跑 —— 所以差别在"服务进程的环境/身份"。
 *
 * 已知线索：桌面端拉起服务时显式设了 `OPENCODE_CLIENT=desktop`
 * （从 app.asar 里挖出来的 spawn 代码），而 `isolatedEnv()` 专门把它删掉了。
 *
 * 本脚本起一个**一次性**实例（独立端口/目录，不碰正在跑的桥接实例），
 * 分别用「带 OPENCODE_CLIENT=desktop」和「不带」各跑一轮，看 403 是否消失。
 *
 *   node spike/probe-client-env.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Service } from '@opencode/client/service';
import { makeOpenCodeClient } from '../src/oc-client.js';
import { ROOT, resolveCli } from '../src/oc-env.js';

const PORT = 4699;
const MODEL = { providerID: 'opencode', id: 'deepseek-v4.1-flash-free' };
const WORK = path.join(ROOT, '.oc', 'work', 'client-env');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function round(label, extraEnv) {
  const root = path.join(WORK, label);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(root, 'state'), { recursive: true });

  const env = { ...process.env, ...extraEnv };
  env.XDG_DATA_HOME = path.join(root, 'data');
  env.XDG_CONFIG_HOME = path.join(root, 'config');
  env.XDG_CACHE_HOME = path.join(root, 'cache');
  env.XDG_STATE_HOME = path.join(root, 'state');
  if (!('OPENCODE_CLIENT' in extraEnv)) delete env.OPENCODE_CLIENT;

  const child = spawn(
    resolveCli(),
    ['serve', '--service', '--hostname', '127.0.0.1', '--port', String(PORT)],
    { cwd: ROOT, env, detached: true, windowsHide: true, stdio: 'ignore' }
  );
  child.unref();

  const file = path.join(root, 'state', 'opencode', 'service.json');
  let record;
  for (let i = 0; i < 80; i++) {
    await sleep(250);
    if (fs.existsSync(file)) {
      try {
        record = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (Number(record.pid) === child.pid) break;
      } catch {}
    }
  }

  console.log(`\n── ${label} (OPENCODE_CLIENT=${extraEnv.OPENCODE_CLIENT ?? '(unset)'}) pid=${child.pid}`);
  if (!record?.url) {
    console.log('   实例没起来，注册文件缺失', file);
    try { process.kill(child.pid); } catch {}
    return;
  }

  const c = makeOpenCodeClient(await Service.discover({ file }));
  const s = await c.session.create({ model: MODEL, location: { directory: ROOT } });
  await c.session.prompt({ sessionID: s.id, text: '只回四个字：能用免费' });

  let list = [];
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    const res = await c.message.list({ sessionID: s.id });
    list = res?.data ?? [];
    if (list.some((m) => m.type === 'assistant' && (m.content?.length ?? 0) > 0)) break;
    if (list.some((m) => m.type === 'idle')) break;
  }

  const idle = list.find((m) => m.type === 'idle');
  const assistant = list.find((m) => m.type === 'assistant');
  const text = (assistant?.content ?? []).filter((p) => p?.type === 'text').map((p) => p.text).join('').trim();
  console.log('   idle.outcome =', idle?.outcome ?? '(none)');
  if (idle?.error) console.log('   error =', idle.error.type, idle.error.status, idle.error.message);
  console.log('   assistant text =', JSON.stringify(text.slice(0, 120)));
  const st = await c.session.get({ sessionID: s.id });
  console.log('   cost =', st.cost, 'tokens =', JSON.stringify(st.tokens));

  await c.session.remove({ sessionID: s.id }).catch(() => {});
  try { process.kill(child.pid); } catch {}
}

await round('with-desktop-client', { OPENCODE_CLIENT: 'desktop' });
await round('without-client', {});
console.log('\n✓ done');
