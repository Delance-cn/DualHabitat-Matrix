/**
 * 用 Node spawn 直接传 argv，绕开 cmd/PowerShell 的引号解析。
 * 目的：确认 cline-cli 的 --id 到底怎么放才不会被当成把 prompt 吃掉。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const bin = path.join(process.env.LOCALAPPDATA, 'Cline', 'cline-cli.exe');
const tmp = path.join(os.tmpdir(), 'cline-probe');
const sid = '1792294020374_ysfia';
const prompt = 'What is the secret word? Reply with just the word.';
const base = ['--json', '--data-dir', path.join(tmp, 'data'), '-P', 'openrouter', '-m', 'openrouter/free'];

const cases = {
  'A --id SID 然后 prompt': [...base, '--id', sid, prompt],
  'B prompt 然后 --id SID': [...base, prompt, '--id', sid],
  'C --id=SID 然后 prompt': [...base, `--id=${sid}`, prompt]
};

function run(label, args) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => (out += c));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => (err += c));
    child.on('close', (code) => {
      const lines = out.split('\n').filter(Boolean);
      const text = lines.filter((l) => l.includes('"contentType":"text"'));
      const errs = lines.filter((l) => l.includes('"type":"error"'));
      const rr = lines.filter((l) => l.includes('"type":"run_result"'));
      console.log(`\n═══ ${label}`);
      console.log('  exit =', code, ' lines =', lines.length);
      for (const l of [...errs.slice(0, 2), ...text.slice(-2), ...rr.slice(0, 1)]) {
        console.log('  ' + (l.length > 240 ? l.slice(0, 240) + ' …' : l));
      }
      if (err.trim()) console.log('  stderr:', err.slice(0, 300));
      resolve();
    });
  });
}

for (const [label, args] of Object.entries(cases)) await run(label, args);
