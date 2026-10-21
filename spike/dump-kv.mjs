// 只读 dump 两个实例 DB 的 kv 表 —— 找桌面端有、隔离端没有的键。
//
// 用法：node --experimental-sqlite spike/dump-kv.mjs
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const targets = {
  desktop: path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db'),
  isolated: path.join(
    'C:',
    'Users',
    'Delan',
    'Documents',
    '默认项目',
    'DualHabitat-Matrix',
    '.oc',
    'data',
    'opencode',
    'opencode.db',
  ),
};

for (const [name, file] of Object.entries(targets)) {
  const db = new DatabaseSync(file, { readOnly: true });
  console.log(`\n===== ${name} kv（${file}）=====`);
  for (const row of db.prepare('select key, value, time_created, time_updated from kv order by key').all()) {
    const value = typeof row.value === 'string' ? row.value : JSON.stringify(row.value);
    const shown = value.length > 400 ? `${value.slice(0, 400)} …(共 ${value.length} 字符)` : value;
    console.log(`\n  key: ${row.key}`);
    console.log(`  value: ${shown}`);
    console.log(`  created: ${new Date(row.time_created).toISOString()}`);
  }
  db.close();
}
