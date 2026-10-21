/**
 * 关键问题：把中文 prompt 放进 argv，cline 能不能收？
 *
 * engine.js 用 spawn(argv 数组)，Windows 上走 CreateProcessW，不经过 ANSI 代码页，
 * 所以理论上中文是安全的。这里用 Node 直接对比 ASCII / 中文两种 prompt。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const bin = path.join(process.env.LOCALAPPDATA, 'Cline', 'cline-cli.exe');
const tmp = path.join(os.tmpdir(), 'cline-probe');

const cases = [
  ['ASCII', 'Reply with exactly: ARGV_ASCII_OK'],
  ['中文', '只回复两个字：收到']
];

function run(label, prompt) {
  return new Promise((resolve) => {
    const child = spawn(
      bin,
      ['--json', '--data-dir', path.join(tmp, 'data'), '-P', 'openrouter', '-m', 'openrouter/free', '--auto-approve', 'false', prompt],
      { cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
    );
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => (out += c));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => (out += c));
    child.on('close', (code) => {
      const lines = out.split('\n').filter(Boolean);
      console.log(`\n═══ ${label}  exit=${code}  lines=${lines.length}`);
      const text = lines.filter((l) => l.includes('"contentType":"text"'));
      const errs = lines.filter((l) => l.includes('"type":"error"') || l.includes('error:'));
      for (const l of [...errs.slice(0, 2), ...text.slice(-2)]) {
        console.log('  ' + (l.length > 260 ? l.slice(0, 260) + ' …' : l));
      }
      if (!lines.length) console.log('  (no output)');
      resolve();
    });
  });
}

for (const [label, prompt] of cases) await run(label, prompt);
