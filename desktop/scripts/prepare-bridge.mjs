// 把桥接本体（src + 依赖 + 配置模板）收进 bridge-dist，供安装包带走。
//
// 为什么要有这一步：桌面端一直只打界面，桥接靠 settings.json 里的
// bridgeRoot 指向本机目录（C:\Users\<用户>\DualHabitatMatrix）。这东西发给别人，
// 对方点「启动」只会得到 Cannot find module ...\src\bridge.js。
//
// 产物：desktop/bridge-dist/
//   src/                 桥接源码
//   node_modules/        生产依赖（90M，effect 占一半，@opencode/client 要它）
//   config.example.json  首次运行时被复制成 config.json
//   models.json          模型池定义
//   roles/               人格设定
//   package.json         只需要 type:module，让 src/*.js 按 ESM 解析

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, '..');
const outDir = path.join(desktopRoot, 'bridge-dist');

// 兼容旧 env 名 QQBRIDGE_SRC：只在本文件这类「不进打包名单」的开发脚本里保留。
const srcRootRaw = process.env.DHM_SRC || process.env.QQBRIDGE_SRC || 'C:\\Users\\<用户>\\DualHabitatMatrix';
const srcRoot = fs.existsSync(srcRootRaw) ? fs.realpathSync(srcRootRaw) : srcRootRaw;

if (!fs.existsSync(path.join(srcRoot, 'src', 'bridge.js'))) {
  console.error(`找不到桥接源码：${path.join(srcRoot, 'src', 'bridge.js')}`);
  console.error('用 DHM_SRC=<桥接目录> 指定。');
  process.exit(1);
}

console.log(`源目录：${srcRoot}`);
console.log(`产物：${outDir}`);

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

/** 备份文件、日志、运行期状态一律不带 —— 它们要么是垃圾，要么是别人的隐私。 */
const junk = (name) =>
  /\.bak($|-|\.)/i.test(name) ||
  /\.(log|pid)$/i.test(name) ||
  name === 'state' ||
  name === '.oc';

// 1. src
fs.cpSync(path.join(srcRoot, 'src'), path.join(outDir, 'src'), {
  recursive: true,
  force: true,
  filter: (src) => !junk(path.basename(src))
});
console.log('  src/');

// 2. node_modules
const nmSrc = path.join(srcRoot, 'node_modules');
if (!fs.existsSync(nmSrc)) {
  console.error('缺少 node_modules：先在那个目录跑 npm install');
  process.exit(1);
}
fs.cpSync(nmSrc, path.join(outDir, 'node_modules'), {
  recursive: true,
  force: true,
  filter: (src) => path.basename(src) !== '.cache'
});
console.log('  node_modules/');

// 3. 配置文件与人格
for (const file of ['config.example.json', 'models.json']) {
  const from = path.join(srcRoot, file);
  if (!fs.existsSync(from)) continue;
  if (file === 'models.json') {
    // 模型池是个人配置：安装包只带空模板，不把任何人接的模型数据带出去
    fs.writeFileSync(path.join(outDir, file), JSON.stringify({ _comment: '模型池：在桌面端「API 与模型」页配置', enabled: true, free: [], paid: [] }, null, 2) + '\n');
    continue;
  }
  fs.copyFileSync(from, path.join(outDir, file));
}
for (const dir of ['roles', 'plugins']) { // plugins/ 本地指令插件（可选目录）
  const from = path.join(srcRoot, dir);
  if (fs.existsSync(from)) fs.cpSync(from, path.join(outDir, dir), { recursive: true, force: true });
}

// 4. package.json：只要 type:module
const pkgSrc = path.join(srcRoot, 'package.json');
if (!fs.existsSync(pkgSrc)) {
  console.error('找不到源 package.json：' + pkgSrc);
  process.exit(1);
}
// 剥 BOM：记事本/PS 5.1 存的 UTF-8 带 \uFEFF，JSON.parse 见到直接抛
const pkg = JSON.parse(fs.readFileSync(pkgSrc, 'utf8').replace(/^\uFEFF/, ''));
fs.writeFileSync(
  path.join(outDir, 'package.json'),
  JSON.stringify(
    { name: pkg.name, version: pkg.version, private: true, type: 'module' },
    null,
    2
  ),
  'utf8'
);
console.log('  package.json/');

/** 递归算体积，顺便当自检。 */
const size = (dir) => {
  let total = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else total += fs.statSync(p).size;
    }
  };
  walk(dir);
  return total;
};

const must = ['src/bridge.js', 'src/wechat-bot.js', 'src/oc-server.js', 'config.example.json', 'package.json'];
const missing = must.filter((f) => !fs.existsSync(path.join(outDir, f)));
if (missing.length) {
  console.error('自检失败，缺：' + missing.join(', '));
  process.exit(1);
}

console.log('');
console.log(`完成：${(size(outDir) / 1024 / 1024).toFixed(1)} MB`);
