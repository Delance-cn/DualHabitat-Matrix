import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const bin = path.join(process.env.LOCALAPPDATA, 'Cline', 'cline-cli.exe');
const tmp = path.join(os.tmpdir(), 'cline-probe');

function run(label, extra, prompt) {
  return new Promise((resolve) => {
    const child = spawn(
      bin,
      ['--json', '--data-dir', path.join(tmp, 'data'), ...extra, prompt],
      { cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
    );
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => (out += c));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => (out += c));
    child.on('close', (code) => {
      console.log(`\n══════════ ${label}  exit=${code}`);
      const lines = out.split('\n').filter(Boolean);
      const want = lines.filter((l) => l.includes('"type":"run_result"') || l.includes('"type":"error"'));
      for (const l of want.slice(0, 3)) console.log(l.length > 1600 ? l.slice(0, 1600) + ' …' : l);
      if (!want.length) console.log('(no run_result/error) first line:', (lines[0] ?? '').slice(0, 300));
      resolve();
    });
  });
}

await run('成功', ['-P', 'openrouter', '-m', 'openrouter/free', '--auto-approve', 'false'], 'Reply with exactly: DONE');
await run('坏模型', ['-P', 'openrouter', '-m', 'definitely/not-a-model', '--auto-approve', 'false'], 'Reply with exactly: DONE');
await run('坏provider', ['-P', 'nope-provider', '-m', 'whatever', '--auto-approve', 'false'], 'Reply with exactly: DONE');
