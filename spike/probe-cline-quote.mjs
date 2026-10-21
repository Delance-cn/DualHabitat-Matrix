import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const bin = path.join(process.env.LOCALAPPDATA, 'Cline', 'cline-cli.exe');
const tmp = path.join(os.tmpdir(), 'cline-probe');

const cases = [
  ['单个英文单词 hello', 'hello'],
  ['中文 + 尾随空格', '你好 '],
  ['中文 + 前导空格', ' 你好'],
  ['中文 + 换行', '你好\n'],
  ['中文 + -- 分隔符', '--\u0000你好'],
  ['中文（原样，对照）', '你好']
];

function run(label, prompt) {
  return new Promise((resolve) => {
    const args = ['--json', '--data-dir', path.join(tmp, 'data'), '-P', 'openrouter', '-m', 'openrouter/free', '--auto-approve', 'false'];
    if (prompt === '--\u0000你好') args.push('--', '你好');
    else args.push(prompt);
    const child = spawn(bin, args, { cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => (out += c));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => (out += c));
    child.on('close', (code) => {
      const lines = out.split('\n').filter(Boolean);
      const text = lines.filter((l) => l.includes('"contentType":"text"'));
      const bad = lines.filter((l) => l.includes('"type":"error"') || l.includes('error:'));
      console.log(`\n═══ ${label}  exit=${code}`);
      if (text.length) console.log('  OK  ' + text[text.length - 1].slice(0, 150));
      else if (bad.length) console.log('  ERR ' + bad[0].replace(/\u001b\[[0-9;]*m/g, '').slice(0, 180));
      else console.log('  ?   ' + (lines[0] ?? '(no output)').slice(0, 180));
      resolve();
    });
  });
}

for (const [label, prompt] of cases) await run(label, prompt);
