/**
 * 把 opencode-cli.exe 里那段"生成请求构造"的 JS 挖出来存成文本，方便人肉读。
 *
 * 目的：搞清楚 `x-opencode-client: i.name` 里的 `i`（客户端身份）是从哪来的。
 * 如果它是"创建会话的那个客户端"，那桥接就有可能伪装；如果是编译期常量，就没戏。
 *
 *   node spike/dump-cli-source.mjs <anchor> <before> <after> <outFile>
 */

import fs from 'node:fs';
import path from 'node:path';

const anchor = process.argv[2] ?? 'x-opencode-client';
const before = Number(process.argv[3] ?? 6000);
const after = Number(process.argv[4] ?? 2000);
const out = process.argv[5] ?? path.join('.oc', 'logs', 'cli-source-dump.txt');

const cli = path.join(
  process.env.APPDATA || path.join(process.env.USERPROFILE, 'AppData', 'Roaming'),
  'ai.opencode.desktop',
  'cli',
  '2.0.32-x64',
  'opencode-cli.exe'
);
const s = fs.readFileSync(cli).toString('latin1');
let i = -1;
const parts = [];
let n = 0;
while ((i = s.indexOf(anchor, i + 1)) !== -1) {
  n += 1;
  // 只留看起来像 JS 源码的（含 `function`/`=>`/`{`），跳过字符串池
  const win = s.slice(Math.max(0, i - before), i + after);
  if (!/=>|function|const /.test(win)) continue;
  parts.push(`════════ anchor #${n} @${i} ════════\n${win}`);
}
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, parts.join('\n\n'), 'utf8');
console.log(`anchor=${anchor} hits=${n} kept=${parts.length} → ${out} (${fs.statSync(out).size} bytes)`);
