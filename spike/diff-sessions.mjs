/**
 * 逐列对比「App 建的会话」和「我们用 API 建的会话」，找免费档准入的标记位。
 *
 * 已确认的规则：
 *   无父根会话（我们建的）        → 403
 *   parentID 指向我们自己建的根   → 403
 *   parentID 指向 App 建的会话    → OK
 * 所以 App 建的会话身上一定多了点什么。把所有列（还有关联表）都比一遍。
 *
 *   node spike/diff-sessions.mjs <sessionA> <sessionB>
 */

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import os from 'node:os';

const A = process.argv[2] ?? 'ses_eb7eca79affdU5CppJn2KhARBs'; // App 建的，能用
const B = process.argv[3] ?? 'ses_eb2b51434ffexRomxMRJcmjcDH'; // 我们建的，403

const db = new DatabaseSync(
  path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db'),
  { readOnly: true }
);

const rows = {};
for (const id of [A, B]) {
  const row = db.prepare('select * from session_v2 where id = ?').get(id);
  if (!row) {
    console.log(`!! 找不到 ${id}`);
    continue;
  }
  rows[id] = row;
}

const [ra, rb] = [rows[A], rows[B]];
if (ra && rb) {
  console.log('列名'.padEnd(22), 'A(App建)'.padEnd(34), 'B(SDK建)');
  for (const key of Object.keys(ra)) {
    const va = JSON.stringify(ra[key]);
    const vb = JSON.stringify(rb[key]);
    const mark = va === vb ? '  ' : '≠ ';
    console.log(mark + key.padEnd(20), String(va).slice(0, 32).padEnd(34), String(vb).slice(0, 40));
  }
}

for (const [label, id] of [['A', A], ['B', B]]) {
  const tables = ['session_inbox', 'session_pending'];
  for (const t of tables) {
    try {
      const n = db.prepare(`select count(*) n from ${t} where session_id = ?`).get(id)?.n;
      console.log(`\n${label} ${t}: ${n}`);
      if (n) console.log(JSON.stringify(db.prepare(`select * from ${t} where session_id = ? limit 3`).all(id), null, 1));
    } catch (error) {
      console.log(`\n${label} ${t}: (${error?.message})`);
    }
  }
}
