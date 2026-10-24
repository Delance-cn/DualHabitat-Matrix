// 手工组装 Windows 绿色版。
//
// 不依赖 electron-builder 的解包流程（它在部分受限环境里会卡在文件创建上），
// 直接做它 --dir 模式下真正干的三件事：
//   1. 把 Electron 运行时拷一份
//   2. electron.exe 改名成 DualHabitat Matrix.exe
//   3. 把我们的代码放进 resources/app/
//
// 产物：release/DualHabitat-Matrix-win32-x64/DualHabitat Matrix.exe
// 整个目录拷走就能用，不需要装 Node、不需要 npm install、没有黑窗口。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const electronDist = path.join(root, 'node_modules', 'electron', 'dist');
const outDir = path.join(root, 'release', 'DualHabitat-Matrix-win32-x64');
const appDir = path.join(outDir, 'resources', 'app');

if (!fs.existsSync(electronDist)) {
  console.error('找不到 Electron 运行时：' + electronDist);
  console.error('先跑：ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js');
  process.exit(1);
}

// 1. 拷 Electron 运行时
console.log('1/5 拷贝 Electron 运行时…');
fs.mkdirSync(outDir, { recursive: true });
fs.cpSync(electronDist, outDir, { recursive: true, force: true });

// 2. electron.exe → DualHabitat Matrix.exe
const exe = path.join(outDir, 'electron.exe');
const renamed = path.join(outDir, 'DualHabitat Matrix.exe');
if (fs.existsSync(exe)) {
  fs.renameSync(exe, renamed);
  console.log('2/5 可执行文件 → DualHabitat Matrix.exe');
} else if (fs.existsSync(renamed)) {
  console.log('2/5 DualHabitat Matrix.exe 已存在，跳过');
} else {
  console.error('找不到 electron.exe，Electron 运行时可能不完整');
  process.exit(1);
}

// 3. 我们的代码
console.log('3/5 放代码进 resources/app …');
fs.mkdirSync(appDir, { recursive: true });

for (const item of ['main.mjs', 'shutdown.mjs', 'server.mjs', 'secrets-reload.mjs', 'path-validation.mjs']) {
  fs.copyFileSync(path.join(root, item), path.join(appDir, item));
}
for (const dir of ['public', 'vendor']) {
  const from = path.join(root, dir);
  if (fs.existsSync(from)) {
    fs.cpSync(from, path.join(appDir, dir), { recursive: true, force: true });
  }
}

// package.json 去掉 devDependencies / build / scripts，只留 Electron 认的字段
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));const appPkg = {
  name: pkg.name,
  version: pkg.version,
  description: pkg.description,
  author: pkg.author,
  type: pkg.type,
  main: pkg.main,
};
fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify(appPkg, null, 2), 'utf8');

// 把开发时用的设置当默认值带进包 —— 打包版首次运行会拿它铺一份到 userData。
//
// ⚠️ 这里**不能**直接拷 desktop/settings.json：那份里是开发机的绝对路径
// （bridgeRoot=C:\Users\<用户>\DualHabitatMatrix）、我的 napcat-shell 目录、我的 QQ 号。
// 共享空白模板，不把开发机路径或 QQ 号打进包里。
fs.copyFileSync(path.join(root, 'default-settings.json'), path.join(appDir, 'default-settings.json'));
console.log('    默认设置 → default-settings.json（空白模板，不含本机路径）');

// 旧构建可能在 app/ 里留过一份 settings.json（带开发机路径和 QQ 号）。
// 打包版读的是 userData 那份（main.mjs 用 DHM_SETTINGS 注入），这个文件不该存在。
fs.rmSync(path.join(appDir, 'settings.json'), { force: true });

// 4. 桥接本体（src + 生产依赖 + config 模板 + roles）
//
// 桌面端只带界面，真正干活的是桥接。不把它放进包，别人点「启动」就是
// Cannot find module ...\src\bridge.js。产物由 scripts/prepare-bridge.mjs 生成，
// 这里只负责搬到 resources/bridge —— server.mjs 的 DEFAULT_ROOT 会先认这个目录。
const bridgeSrc = path.join(root, 'bridge-dist');
const bridgeDst = path.join(outDir, 'resources', 'bridge');
if (!fs.existsSync(path.join(bridgeSrc, 'src', 'bridge.js'))) {
  console.error('4/5 找不到 bridge-dist：先跑 npm run prepare:bridge');
  process.exit(1);
}
for (const dependency of [
  'node_modules/@opencode/client/package.json',
  'node_modules/effect/package.json',
  'node_modules/@snowluma/sdk/package.json'
]) {
  if (!fs.existsSync(path.join(bridgeSrc, dependency))) {
    console.error(`4/5 桥接产物缺少 ${dependency}：请重新运行 npm run prepare:bridge`);
    process.exit(1);
  }
}
console.log('4/5 拷贝桥接本体…');
fs.rmSync(bridgeDst, { recursive: true, force: true });
fs.cpSync(bridgeSrc, bridgeDst, { recursive: true, force: true });
console.log('    桥接 → ' + path.relative(outDir, bridgeDst));

// 5. NapCat（可选）
//
// NapCat Shell 是自包含的：versions/ 里带着完整 QQ NT，QQ.exe 只是引导壳。
// 整个目录搬进来，程序启动时会优先用它（server.mjs 的 napcatSettings 里判断）。
// 不想带就设 DHM_NO_NAPCAT=1，或者源目录不存在 —— 那就退回用户自己配路径。
// 兼容旧 env 名（QQBRIDGE_NAPCAT_SRC / QQBRIDGE_NO_NAPCAT）：只在本文件这类
// 「不进打包名单」的开发脚本里保留；打包进 resources/app 的 main.mjs / server.mjs 不带旧名。
const napcatRaw = process.env.DHM_NAPCAT_SRC || process.env.QQBRIDGE_NAPCAT_SRC || `${process.env.USERPROFILE}\\napcat-shell`;
// napcat-shell 可能是个符号链接（Delance 机器上就是），必须先解到真实路径，
// 否则 cpSync 默认不跟随链接，会拷出一个空目录。
const napcatSrc = fs.existsSync(napcatRaw) ? fs.realpathSync(napcatRaw) : napcatRaw;
// 放 resources/app/napcat：server.mjs 里按"和自己同目录"找，开发态/打包态都对得上
const napcatDst = path.join(appDir, 'napcat');

if ((process.env.DHM_NO_NAPCAT ?? process.env.QQBRIDGE_NO_NAPCAT) === '1') {
  console.log('5/5 跳过 NapCat（DHM_NO_NAPCAT=1）');
} else if (!fs.existsSync(path.join(napcatSrc, 'NapCatWinBootMain.exe'))) {
  console.log('5/5 跳过 NapCat：' + napcatSrc + ' 里没有启动器');
} else {
  console.log('5/5 拷贝 NapCat（约 1.2 GB，慢一点）…');
  fs.cpSync(napcatSrc, napcatDst, {
    recursive: true,
    force: true,
    dereference: true,
    // 日志和遥测文件不带
    filter: (src) => !/\.(log)$/i.test(src)
  });
  console.log('    源目录：' + napcatSrc);
  console.log('    NapCat → ' + path.relative(outDir, napcatDst));
}

// 自检
const must = [
  path.join(appDir, 'package.json'),
  path.join(appDir, 'main.mjs'),
  path.join(appDir, 'server.mjs'),
  path.join(appDir, 'path-validation.mjs'),
  path.join(appDir, 'public', 'index.html'),
  path.join(appDir, 'public', 'tray.png'),
  path.join(appDir, 'vendor', 'backends', 'providers.js'),
  path.join(outDir, 'resources', 'bridge', 'src', 'bridge.js'),
  path.join(outDir, 'resources', 'bridge', 'config.example.json'),
  renamed,
];
const missing = must.filter(f => !fs.existsSync(f));
if (missing.length) {
  console.error('自检失败，缺文件：');
  for (const m of missing) console.error('  ' + m);
  process.exit(1);
}

const size = (() => {
  let total = 0;
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else total += fs.statSync(p).size;
    }
  };
  walk(outDir);
  return (total / 1024 / 1024).toFixed(1);
})();

console.log('');
console.log('完成：' + outDir);
console.log('体积：' + size + ' MB');
console.log('双击 DualHabitat Matrix.exe 启动。');
