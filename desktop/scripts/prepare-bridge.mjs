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
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { replaceDirectoryAtomically } from './replace-directory.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, '..');
const finalOutDir = path.join(desktopRoot, 'bridge-dist');
const outDir = path.join(desktopRoot, `.bridge-dist-${process.pid}-${randomUUID()}.tmp`);

// 兼容旧 env 名 QQBRIDGE_SRC：只在本文件这类「不进打包名单」的开发脚本里保留。
const srcRootRaw = process.env.DHM_SRC || process.env.QQBRIDGE_SRC || `${process.env.USERPROFILE}\\DualHabitatMatrix`;
// ⚠️ 不要 realpath（同 prepare-vendor.mjs 的坑）：junction 的真实路径带中文，
// fs.cpSync 从那条路径复制会静默中断、node 以 127 退出。
const srcRoot = srcRootRaw;

if (!fs.existsSync(path.join(srcRoot, 'src', 'bridge.js'))) {
  console.error(`找不到桥接源码：${path.join(srcRoot, 'src', 'bridge.js')}`);
  console.error('用 DHM_SRC=<桥接目录> 指定。');
  process.exit(1);
}

console.log(`源目录：${srcRoot}`);
console.log(`产物：${finalOutDir}`);

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
    // 不携带 models.json：升级时不覆盖用户自己的模型池；首次运行没有这个
    // 文件时，桥接按内置默认（空池）跑，用户在「API 与模型」页配置
    continue;
  }
  fs.copyFileSync(from, path.join(outDir, file));
}
for (const dir of ['roles', 'plugins', 'upstream']) { // upstream/ agent 预置文件（配置生成必读）
  const from = path.join(srcRoot, dir);
  if (fs.existsSync(from)) fs.cpSync(from, path.join(outDir, dir), { recursive: true, force: true });
}

// 模型引擎：opencode-cli 单文件。没有它，模型 API 在没装 OpenCode 桌面端的
// 机器上永远起不来（2026-10-21 朋友的机器就是死在这）。打包时从本机
// OpenCode 桌面端的缓存里取最新一份塞进 vendor/，装完即有。
{
  const roaming = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const cliBase = path.join(roaming, 'ai.opencode.desktop', 'cli');
  let picked = null;
  try {
    picked = fs.readdirSync(cliBase, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(cliBase, e.name))
      .filter((d) => fs.existsSync(path.join(d, 'opencode-cli.exe')))
      .map((d) => ({ d, t: fs.statSync(path.join(d, 'opencode-cli.exe')).mtimeMs }))
      .sort((a, b) => b.t - a.t)[0]?.d ?? null;
  } catch { }
  if (picked) {
    fs.mkdirSync(path.join(outDir, 'vendor', 'opencode-cli'), { recursive: true });
    fs.copyFileSync(path.join(picked, 'opencode-cli.exe'), path.join(outDir, 'vendor', 'opencode-cli', 'opencode-cli.exe'));
    console.log('  vendor/opencode-cli/（模型引擎，取自 ' + picked + '）');
  } else {
    console.warn('  ⚠️ 没找到 opencode-cli.exe（%APPDATA%\\ai.opencode.desktop\\cli）——这包在没装 OpenCode 桌面端的机器上起不了模型 API');
  }
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

const must = [
  'src/bridge.js',
  'src/qq-accounts.js',
  'src/wechat-bot.js',
  'src/oc-server.js',
  'src/openai-shell.js',
  'src/agent-tools-core.js',
  'src/mcp-agent-tools.js',
  'upstream/dsh/agent-presets/qq-chat/agent.cordis.yml',
  'upstream/dsh/agent-presets/qq-chat-v2/agent.cordis.yml',
  'config.example.json',
  'package.json'
];
for (const dependency of Object.keys(pkg.dependencies ?? {})) {
  must.push(path.join('node_modules', dependency, 'package.json'));
}
const missing = must.filter((f) => !fs.existsSync(path.join(outDir, f)));
if (missing.length) {
  console.error('自检失败，缺：' + missing.join(', '));
  fs.rmSync(outDir, { recursive: true, force: true });
  process.exit(1);
}

replaceDirectoryAtomically(outDir, finalOutDir);
console.log('');
console.log(`完成：${(size(finalOutDir) / 1024 / 1024).toFixed(1)} MB`);
