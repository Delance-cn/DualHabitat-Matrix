// 只读对比两个实例的 SQLite 库结构，找「桌面端有、隔离端没有」的东西。
//
// 动机：桌面端实例能用 opencode 免费额度，隔离实例被 403 FreeTierError 拒。
// 同二进制、同 config、同 provider 设置 —— 怀疑免费额度的凭据/权属记录在 DB 里。
//
// 用法：node --experimental-sqlite spike/diff-db.mjs
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

function describe(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  const tables = db
    .prepare("select name from sqlite_master where type='table' order by name")
    .all()
    .map((row) => row.name);
  const out = {};
  for (const table of tables) {
    let count = -1;
    try {
      count = db.prepare(`select count(*) as n from "${table}"`).get().n;
    } catch {
      // 视图/虚拟表可能查不了，忽略
    }
    let columns = [];
    try {
      columns = db.prepare(`select name from pragma_table_info(?)`).all(table).map((row) => row.name);
    } catch {}
    out[table] = { count, columns };
  }
  db.close();
  return out;
}

const a = describe(targets.desktop);
const b = describe(targets.isolated);

console.log('表名                    桌面端行数    隔离端行数');
console.log('------------------------  ----------  ----------');
for (const table of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
  const left = a[table] ? String(a[table].count) : '(无此表)';
  const right = b[table] ? String(b[table].count) : '(无此表)';
  const mark = a[table] && b[table] && a[table].count !== b[table].count ? '  <-- 行数不同' : '';
  console.log(`${table.padEnd(24)}  ${left.padStart(10)}  ${right.padStart(10)}${mark}`);
}

const onlyDesktop = Object.keys(a).filter((table) => !b[table]);
const onlyIsolated = Object.keys(b).filter((table) => !a[table]);
console.log(`\n仅桌面端有的表: ${onlyDesktop.join(', ') || '(无)'}`);
console.log(`仅隔离端有的表: ${onlyIsolated.join(', ') || '(无)'}`);

// 列出所有列的名单，方便肉眼找 auth/identity/install 之类的列
console.log('\n===== 两边都有的表的列名 =====');
for (const table of Object.keys(a).filter((name) => b[name])) {
  console.log(`${table}: ${a[table].columns.join(', ')}`);
}

console.log('\n===== 仅桌面端存在的表的列名 =====');
for (const table of onlyDesktop) console.log(`${table}: ${a[table].columns.join(', ')}`);
