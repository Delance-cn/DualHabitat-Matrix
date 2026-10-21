/**
 * desktop/scripts/prepare-vendor.mjs —— 打包前把后端代码复制进 desktop/。
 *
 * 为什么需要：`server.mjs` 引用的是「桥接本体的 `src/backends/`」，但 Electron
 * 打包时 app 的根目录是 `desktop/`，`desktop/../src` 在包外，打不进去。
 * 所以打包前复制一份到 `desktop/vendor/backends/`，server 运行时优先用这份。
 *
 * 开发态不会走到这里 —— 没有 vendor 目录时 server 会退回读 `../src/backends/`。
 *
 * 源目录以前写死成 `desktop/../src`（也就是这个仓库自己那份 src）。那份是**旧副本**
 * （连 wechat-bot.js 都没有），于是"包里 vendor 是旧的、真桥接是新的"这种事必然发生。
 * 现在改成跟 `prepare-bridge.mjs` 一样从**桥接根目录**取：DHM_SRC 优先，
 * 默认 `C:\Users\<用户>\DualHabitatMatrix`（junction → 真源码）。找不到才退回旧写法。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(here, '..');

// 兼容旧 env 名 QQBRIDGE_SRC：只在本文件这类「不进打包名单」的开发脚本里保留。
const bridgeRootRaw = process.env.DHM_SRC || process.env.QQBRIDGE_SRC || 'C:\\Users\\<用户>\\DualHabitatMatrix';
const bridgeRoot = fs.existsSync(bridgeRootRaw) ? fs.realpathSync(bridgeRootRaw) : bridgeRootRaw;
const fromBridge = path.join(bridgeRoot, 'src', 'backends');
const fromLocal = path.resolve(desktopDir, '..', 'src', 'backends');

const srcDir = fs.existsSync(path.join(fromBridge, 'index.js')) ? fromBridge : fromLocal;
const vendorDir = path.join(desktopDir, 'vendor', 'backends');

if (!fs.existsSync(srcDir)) {
  console.error(`找不到源码目录：${srcDir}`);
  process.exit(1);
}
console.log(`后端源码取自：${srcDir}`);

// 覆盖式复制，不先删目录，也不删任何东西。
// 原因：本环境的批量删除保护会在 rm 时直接抛错（阈值 50，自测脚本也会被算进去），
// 与其绕过不如干脆不删 —— selftest.mjs 留着只有几十 KB，无副作用。
fs.mkdirSync(vendorDir, { recursive: true });
fs.cpSync(srcDir, vendorDir, { recursive: true, force: true });

const count = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).reduce((n, e) => {
    const full = path.join(dir, e.name);
    return n + (e.isDirectory() ? count(full) : 1);
  }, 0);

console.log(`已复制后端代码 → ${path.relative(desktopDir, vendorDir)}（${count(vendorDir)} 个文件）`);
