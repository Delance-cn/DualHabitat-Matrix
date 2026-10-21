// 从 OpenCode 自带的 models.dev 目录里提取「provider -> 激活所需环境变量」。
//
// 背景：实测 DEEPSEEK_API_KEY=... 会让 deepseek provider 出现，说明 provider 是
// 靠环境变量激活的。多 key 设计需要先知道每个 provider 到底认哪个变量名。
//
// 用法：node --experimental-sqlite spike/dump-provider-catalog.mjs [关键字]
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dbFile = path.join(
  'C:', 'Users', 'Delan', 'Documents', '默认项目', 'DualHabitat-Matrix',
  '.oc', 'data', 'opencode', 'opencode.db',
);
if (!fs.existsSync(dbFile)) {
  console.error(`找不到 ${dbFile}（先启动过一次隔离实例）`);
  process.exit(1);
}

const db = new DatabaseSync(dbFile, { readOnly: true });
const row = db.prepare("select value from kv where key = 'models-dev:catalog'").get();
db.close();
if (!row) {
  console.error('kv 里没有 models-dev:catalog');
  process.exit(1);
}

const catalog = JSON.parse(JSON.parse(row.value).body);
const needle = (process.argv[2] ?? '').toLowerCase();

// 只关注「靠环境变量激活」的 provider，也就是我们要管 key 的那些。
const rows = [];
for (const [id, provider] of Object.entries(catalog)) {
  const env = provider.env ?? [];
  const npm = provider.npm ?? '';
  if (!env.length) continue;
  rows.push({ id, name: provider.name ?? '', env, npm, models: Object.keys(provider.models ?? {}).length });
}
rows.sort((a, b) => a.id.localeCompare(b.id));

const shown = needle ? rows.filter((r) => (r.id + r.name).toLowerCase().includes(needle)) : rows;
console.log(`共 ${rows.length} 个靠环境变量激活的 provider，显示 ${shown.length} 个\n`);
for (const r of shown) {
  console.log(`${r.id.padEnd(18)} ${r.name.padEnd(24).slice(0, 24)}  env=${r.env.join('|')}`);
  if (r.npm) console.log(`${''.padEnd(18)} npm=${r.npm}  models=${r.models}`);
}
