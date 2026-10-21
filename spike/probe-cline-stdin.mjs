/**
 * 用 Node 的 spawn 喂 stdin，和 engine.js 里的条件完全一致。
 *
 * 为什么要单独测：PowerShell / cmd 的管道在 Windows 上既不是 FIFO 也不是文件，
 * 如果 CLI 用 fstat(0).isFIFO() 判断「有没有管道」，在 PowerShell 里就会被判成没有。
 * 而 engine.js 是 Node spawn + stdio:pipe，行为和 PowerShell 管道并不等价。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const bin = path.join(process.env.LOCALAPPDATA, 'Cline', 'cline-cli.exe');
const tmp = path.join(os.tmpdir(), 'cline-probe');
const args = process.argv.slice(2);
const prompt = process.env.PROBE_PROMPT ?? 'Reply with exactly: NODE_PIPE_OK';

console.log('bin   =', bin);
console.log('args  =', JSON.stringify(args));
console.log('prompt=', JSON.stringify(prompt));
console.log('---');

const child = spawn(bin, args, {
  cwd: tmp,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY ?? '' }
});

let out = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (c) => { out += c; });
let err = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', (c) => { err += c; });

child.on('error', (e) => { console.log('SPAWN ERROR', e.message); });
child.on('close', (code) => {
  console.log('exit =', code);
  console.log('--- stdout ---');
  for (const line of out.split('\n').filter(Boolean).slice(0, 80)) {
    console.log(line.length > 300 ? line.slice(0, 300) + ' …' : line);
  }
  if (err.trim()) {
    console.log('--- stderr ---');
    console.log(err.slice(0, 2000));
  }
});

child.stdin.write(prompt);
child.stdin.end();
