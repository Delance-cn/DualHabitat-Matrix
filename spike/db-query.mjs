/**
 * 只读翻 OpenCode 桌面端的 SQLite（`~/.local/share/opencode/opencode.db`）。
 *
 * 用途：查"桌面端凭什么能用免费档"这类服务端状态 ——
 * 比如 provider 的 apiKey 是不是被运行时替换成了登录 token。
 * 用 `node:sqlite`，不引入任何新依赖，也不会写库（readOnly）。
 *
 *   node spike/db-query.mjs "select name from sqlite_master where type='table'"
 */

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import os from 'node:os';

const isFile = /\.db$/i.test(process.argv[2] ?? '');
const file = isFile
  ? process.argv[2]
  : path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');
const sql = (isFile ? process.argv[3] : process.argv[2])
  ?? "select name from sqlite_master where type='table' order by name";

const db = new DatabaseSync(file, { readOnly: true });
try {
  const rows = db.prepare(sql).all();
  console.log(JSON.stringify(rows, null, 1).slice(0, 6000));
} catch (error) {
  console.log('SQL failed:', error?.message ?? error);
}
