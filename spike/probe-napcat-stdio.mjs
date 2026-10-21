// 诊断：把 NapCat 启动器的 stdout/stderr 接到管道里，到底能拿到多少日志？
//
// 疑点：启动器（NapCatWinBootMain.exe）把 QQ.exe 拉起来后**自己就退了**，
// 而 NapCat 的运行日志是重定向到命名管道 `\\.\pipe\NapCat_<主进程pid>` 的
// （启动时会自报这行）。如果真是这样，只接启动器的 stdout 只能拿到开机那几行，
// 之后群里的消息、报错、重连全看不到 —— 那就得去连那个命名管道。
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';

const DIR = 'C:\\Users\\<用户>\\napcat-shell';
const EXE = path.join(DIR, 'NapCatWinBootMain.exe');
const QQ = process.env.NAPCAT_QQ ?? '';  // 机器人 QQ 号从环境变量给

const listPipes = () => {
  try {
    return fs.readdirSync('\\\\.\\pipe\\').filter((n) => /^NapCat_/.test(n));
  } catch {
    return [];
  }
};

const portOpen = (port) =>
  new Promise((res) => {
    const s = net.connect(port, '127.0.0.1');
    const done = (v) => {
      try { s.destroy(); } catch {}
      res(v);
    };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    setTimeout(() => done(false), 700);
  });

console.log('启动前已有的 NapCat 管道：', listPipes().join(', ') || '(无)');

const t0 = Date.now();
const stamp = () => String(Date.now() - t0).padStart(6);

const child = spawn(EXE, [QQ], { cwd: DIR, windowsHide: true, detached: false, stdio: ['ignore', 'pipe', 'pipe'] });
const dump = (tag) => (chunk) => {
  for (const line of chunk.toString().split('\n')) {
    if (line.trim()) console.log(`[${stamp()}ms][launcher-${tag}] ${line.trim().slice(0, 160)}`);
  }
};
child.stdout.on('data', dump('out'));
child.stderr.on('data', dump('err'));
child.on('close', (code) => console.log(`[${stamp()}ms] ★ 启动器进程退出 code=${code}`));

for (let i = 0; i < 9; i++) {
  await new Promise((r) => setTimeout(r, 2500));
  console.log(`[${stamp()}ms] 管道=${listPipes().join(',') || '-'}  3001=${(await portOpen(3001)) ? '通' : '-'}`);
}

console.log('\n=== 试连命名管道（看能不能读到运行日志）===');
const pipes = listPipes();
if (!pipes.length) console.log('  没有管道可连');
for (const name of pipes) {
  const sock = net.connect(`\\\\.\\pipe\\${name}`);
  sock.on('connect', () => console.log(`  [${name}] ✓ 连上了`));
  sock.on('error', (e) => console.log(`  [${name}] ✗ ${e.code}`));
  sock.on('data', (d) => {
    const first = d.toString().split('\n')[0].trim();
    console.log(`  [${name}] ← ${first.slice(0, 160)}`);
  });
}
await new Promise((r) => setTimeout(r, 8000));

console.log('\n=== 收尾 ===');
child.kill();
process.exit(0);
