// 启动 DualHabitat Matrix 桌面版（脱离当前进程树，关掉这个脚本也不影响它）
import { spawn } from 'node:child_process';
import path from 'node:path';

const exe = 'C:\\Users\\<用户>\\WorkBuddy AI\\2026-10-17-22-01-18\\DualHabitat-Matrix\\desktop\\release\\DualHabitat-Matrix-win32-x64\\DualHabitat Matrix.exe';
const child = spawn(exe, [], {
  detached: true,
  stdio: 'ignore',
  cwd: path.dirname(exe)
});
child.unref();
console.log('已启动 pid', child.pid);
