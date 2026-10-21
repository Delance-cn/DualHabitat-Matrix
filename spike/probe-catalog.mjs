/**
 * 看 models.dev 目录里 `opencode` 这家 provider 到底长什么样。
 *
 * 为什么要看：桥接进程调 opencode.ai 拿免费档被服务端拒（FreeTierError），
 * 但桌面端 App 自己跑同一个模型却成功。目录里的 provider 定义（baseURL / apiKey /
 * 需要的 header 或 env）就是唯一还没排除的差异来源。
 *
 *   node spike/probe-catalog.mjs
 */

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import os from 'node:os';

const db = new DatabaseSync(
  path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db'),
  { readOnly: true }
);
const row = db.prepare(`select value from kv where key = 'models-dev:catalog'`).get();
const outer = JSON.parse(row.value);
const body = JSON.parse(outer.body);

console.log('updatedAt', new Date(outer.updatedAt).toISOString(), 'digest', outer.digest?.slice(0, 12));
console.log('top-level keys:', Object.keys(body).slice(0, 20).join(', '));

const oc = body.opencode;
console.log('\n=== opencode provider entry ===');
console.log(JSON.stringify(oc, null, 1).slice(0, 4000));

if (oc?.models) {
  const ids = Object.keys(oc.models).filter((id) => /free/.test(id));
  console.log('\nfree model ids:', ids.join(', '));
  const first = oc.models[ids[0]];
  console.log('\nsample model entry:', JSON.stringify(first, null, 1).slice(0, 1500));
}
