import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const bin = path.join(process.env.LOCALAPPDATA, 'Cline', 'cline-cli.exe');
const tmp = path.join(os.tmpdir(), 'cline-probe');

const cases = [
  ['中文无标点', '你好'],
  ['中文带空格', '你好 世界'],
  ['中文冒号', '只回复：收到'],
  ['ASCII 带冒号', 'Reply: OK'],
  ['英文长句', 'Reply with exactly the words HELLO WORLD and nothing else'],
  ['日文', 'こんにちは'],
  ['emoji', 'Reply with exactly: 😀 OK']
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
      const text = lines.filter((l) => l.includes('"contentType":"text"'));
      const bad = lines.filter((l) => l.includes('"type":"error"') || l.includes('error:'));
      console.log(`\n═══ ${label}  exit=${code}`);
      if (text.length) console.log('  OK  ' + text[text.length - 1].slice(0, 160));
      else if (bad.length) console.log('  ERR ' + bad[0].replace(/\u001b\[[0-9;]*m/g, '').slice(0, 200));
      else console.log('  ?   ' + (lines[0] ?? '(no output)').slice(0, 200));
      resolve();
    });
  });
}

for (const [label, prompt] of cases) await run(label, prompt);
