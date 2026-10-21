// 给 electron-builder 打个 Windows 补丁。
//
// 背景：electron-builder 26 在 Windows 上收集依赖树时，会用
//   powershell.exe -EncodedCommand <base64>
// 去调 `npm list`。某些受限环境（本机沙箱、部分企业策略）会拦截
// powershell 调用，导致输出不是 JSON，打包直接报：
//   No JSON content found in output
//
// 这个脚本把它换成等价的 cmd.exe 调用。功能一样，只是不再依赖 powershell。
// 每次 npm install 之后需要重跑一次（pack 脚本里已经串上了）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.resolve(
  here, '..', 'node_modules', 'app-builder-lib', 'out',
  'node-module-collector', 'nodeModulesCollector.js'
);

if (!fs.existsSync(target)) {
  console.log('未装 app-builder-lib，跳过');
  process.exit(0);
}

let src = fs.readFileSync(target, 'utf8');

if (src.includes('"cmd.exe"')) {
  console.log('已打过补丁，跳过');
  process.exit(0);
}

// 目标行（electron-builder 26.x 原文）
const needle =
  'const [spawnCommand, spawnArgs] = process.platform === "win32" ? ["powershell.exe", buildPowerShellEncodedArgs(command, args)] : [command, args];';

if (!src.includes(needle)) {
  console.log('找不到目标行 —— electron-builder 版本可能变了，没打补丁');
  process.exit(0);
}

// 换成 cmd.exe。参数里有空格的加引号，其余原样。
const replacement =
  'const [spawnCommand, spawnArgs] = process.platform === "win32" ? ["cmd.exe", ["/d", "/s", "/c", [command, ...args].map(a => (/[\\s"]/.test(a) ? \'"\' + a.replace(/"/g, \'\\\\"\') + \'"\' : a)).join(" ")]] : [command, args];';

src = src.replace(needle, replacement);
fs.writeFileSync(target, src, 'utf8');
console.log('已打补丁：electron-builder 改用 cmd.exe 调包管理器');
