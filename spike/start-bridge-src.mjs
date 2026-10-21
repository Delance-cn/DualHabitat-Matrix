// 从源码启动桥接（等价于「启动QQ桥接.bat」里的 npm start），脱离当前进程树。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'C:\\Users\\<用户>\\DualHabitatMatrix';
const NODE = 'C:\\Users\\<用户>\\.workbuddy-ai\\binaries\\node\\versions\\22.22.2-2\\node.exe';
const out = fs.openSync(path.join(ROOT, '.oc', 'bridge.out.log'), 'a');
const err = fs.openSync(path.join(ROOT, '.oc', 'bridge.err.log'), 'a');

const child = spawn(NODE, ['src/bridge.js'], {
  cwd: ROOT,
  detached: true,
  windowsHide: true,
  stdio: ['ignore', out, err],
  env: { ...process.env, NODE_USE_ENV_PROXY: '0' }
});
child.unref();
console.log('已启动桥接 pid', child.pid);
