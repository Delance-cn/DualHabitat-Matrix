/**
 * desktop/scripts/migrate-legacy-state.mjs —— 一次性本地迁移（qqbridge → DualHabitat Matrix）。
 *
 * 为什么需要它：
 *   改名后 Electron 的 userData 目录从 `%APPDATA%\qqbridge-desktop` 变成
 *   `%APPDATA%\dualhabitat-matrix-desktop`，浏览器存储键从 `qqbridge-theme` 等变成 `dhm-theme` 等。
 *   这两样都在 userData 里，**没法靠运行时兼容**：打包名单（files）包含
 *   main.mjs / server.mjs / public/**，任何读写旧名的代码都会进对外产物，
 *   所以旧名兼容只能放在这个「不进打包名单」的一次性脚本里。
 *
 * 它做两件事：
 *   1. 目录：旧的 userData 整目录复制到新目录（新目录已存在就跳过，不覆盖）。
 *   2. 键名：起一个临时页面，在**和真实桌面端同一个 origin**（http://127.0.0.1:3200）
 *      上把 3 个旧 localStorage 键读出来写成新键，再删掉旧键。
 *
 * 跑法（在 desktop/ 下）：
 *   node_modules\electron\dist\electron.exe scripts\migrate-legacy-state.mjs
 *
 * 幂等：跑第二遍会因为「没有旧键」而什么都不做。
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { app, BrowserWindow } from 'electron';

const OLD_DIR_NAME = 'qqbridge-desktop';
const NEW_DIR_NAME = 'dualhabitat-matrix-desktop';
const PORT = Number(process.env.DHM_DESKTOP_PORT ?? process.env.QQBRIDGE_DESKTOP_PORT ?? 3200);

const KEY_MAP = {
  'qqbridge-theme': 'dhm-theme',
  'qqbridge-platform': 'dhm-platform',
  'qqbridge-mode': 'dhm-mode'
};

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('no-sandbox');

const appData = app.getPath('appData');
const oldDir = path.join(appData, OLD_DIR_NAME);
const newDir = path.join(appData, NEW_DIR_NAME);

// ── 1. 搬目录 ────────────────────────────────────────────────────────
if (fs.existsSync(newDir)) {
  console.log(`[1/2] 目录：${NEW_DIR_NAME} 已存在，跳过（不覆盖）`);
} else if (!fs.existsSync(oldDir)) {
  console.log(`[1/2] 目录：旧的 ${OLD_DIR_NAME} 不存在，没什么可搬`);
} else {
  fs.cpSync(oldDir, newDir, { recursive: true, force: true, errorOnExist: false });
  console.log(`[1/2] 目录：${OLD_DIR_NAME} → ${NEW_DIR_NAME} 已复制`);
}

// 主进程和渲染进程必须看同一个 userData
app.setPath('userData', newDir);

// ── 2. 迁移 localStorage 键 ──────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><meta charset="utf-8"><title>migrate</title>ok');
});

async function main() {
  await app.whenReady();

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, '127.0.0.1', resolve);
  });

  const win = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });

  await win.loadURL(`http://127.0.0.1:${PORT}/`);

  const report = await win.webContents.executeJavaScript(`(() => {
    const map = ${JSON.stringify(KEY_MAP)};
    const moved = [];
    for (const [from, to] of Object.entries(map)) {
      const v = window.localStorage.getItem(from);
      if (v === null) continue;
      window.localStorage.setItem(to, v);
      window.localStorage.removeItem(from);
      moved.push(from + ' → ' + to + ' = ' + JSON.stringify(v));
    }
    const left = Object.keys(map).filter((k) => window.localStorage.getItem(k) !== null);
    return { moved, left };
  })()`);

  win.destroy();
  return report;
}

main()
  .then((report) => {
    if (report.moved.length === 0) {
      console.log('[2/2] 键名：没有旧键要迁移');
    } else {
      console.log('[2/2] 键名：');
      for (const line of report.moved) console.log(`      ${line}`);
    }
    if (report.left.length) console.log(`      注意：还有旧键没删掉 ${report.left.join(', ')}`);
    console.log('完成。');
  })
  .catch((error) => {
    console.error('迁移失败：', error?.message ?? error);
    console.error('（不影响使用，只是主题/平台/模式三个界面偏好要重新点一下）');
    process.exitCode = 1;
  })
  .finally(() => {
    server.close(() => app.quit());
    setTimeout(() => app.quit(), 1500).unref();
  });
