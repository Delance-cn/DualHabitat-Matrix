/**
 * desktop/main.mjs —— Electron 主进程。
 *
 * 只做三件事：起本地服务、开窗口、窗口全关就退出。
 * 业务逻辑全在 server.mjs 和 public/ 里，所以没有 Electron 也能 `node server.mjs` 用浏览器跑。
 */

import { app, BrowserWindow, shell, dialog, session, Tray, Menu, nativeImage } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createShutdownController } from './shutdown.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

let win = null;
let tray = null;
let startServer = null;
let serverModule = null;
// 本地服务真的起来过才算「这台进程托管了后台服务」。第二实例、端口起不来都别去动别人的进程。
let serverStarted = false;
// 点叉只是收进托盘；只有从这里（托盘菜单 / 系统退出）走的才算真退出。
// 不区分的话 close 里没法判断「该藏还是该退」。
let quitting = false;
// 只提示一次，不然每次点叉都弹气泡很烦
let trayHintShown = false;

// 这是个配置界面，不需要 GPU。
// 不关的话，显卡进程起不来（虚拟机、远程桌面、驱动异常都会）时 Chromium 会
// 直接 FATAL: GPU process isn't usable. Goodbye. 把整个应用干掉。
// 注意：只调 disableHardwareAcceleration() 在 Electron 44 上不够，
// 还必须显式补这两个开关，否则照样起 GPU 进程然后崩。
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');

// Windows 任务栏分组 / 通知要靠这个 ID 认应用，不设的话任务栏图标会退回 Electron 的原子球，
// 通知也挂不到自己的图标上。必须和 package.json 的 build.appId 一致。
app.setAppUserModelId('cn.delance.dualhabitat-matrix');

// 关掉 Chromium 的进程沙箱。
//
// 为什么：部分机器上（虚拟机、远程桌面、被安全软件插手的系统）沙箱子进程起不来，
// 表现是双击后窗口闪一下就没了，日志里是 "GPU process isn't usable. Goodbye."。
// 本应用只加载 127.0.0.1 上自己的页面，不联网、不加载远程内容、不开外部窗口，
// 所以这层沙箱在这里基本没有防护价值 —— 关掉换"一定能打开"。
// 想保留：启动前设环境变量 DHM_KEEP_SANDBOX=1。
if (process.env.DHM_KEEP_SANDBOX !== '1') {
  app.commandLine.appendSwitch('no-sandbox');
}

// 兜底：任何没接住的异常都用人话弹出来，而不是 Electron 那个红框堆栈
process.on('uncaughtException', (error) => {
  console.error('未捕获异常：', error);
  try {
    dialog.showErrorBox('DualHabitat Matrix 出错了', String(error?.stack ?? error));
  } catch {
    // 对话框本身失败就算了，至少进程别静默挂掉
  }
  app.quit();
});

async function createWindow() {
  // 设置文件必须落在可写目录：打包后应用本体在 asar 里，是只读的
  process.env.DHM_SETTINGS = path.join(app.getPath('userData'), 'settings.json');

  // 动态 import：server.mjs 在模块顶层读这个环境变量，所以必须等它设好再加载
  if (!startServer) {
    serverModule = await import('./server.mjs');
    ({ startServer } = serverModule);
  }

  let url;
  try {
    ({ url } = await startServer());
    serverStarted = true;
  } catch (error) {
    console.error('本地服务起不来：', error?.message ?? error);
    dialog.showErrorBox(
      '本地服务起不来',
      `原因：${error?.message ?? error}\n\n多半是端口被别的程序占着。关掉后重试即可。`
    );
    app.quit();
    return;
  }

  win = new BrowserWindow({
    width: 1080,
    height: 740,
    minWidth: 940,
    minHeight: 620,
    backgroundColor: '#f4f6f9',
    title: 'DualHabitat Matrix',
    // 窗口/任务栏图标。不给的话标题栏和任务栏显示的是 Electron 默认的原子球。
    icon: path.join(here, 'public', 'icon.png'),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  /* 每次启动先清一次 HTTP 缓存。
   *
   * 踩过：改完 public/ 里的 js/css，重开软件界面一点没变 —— 文件是对的，Chromium
   * 用的是 userData 里那份旧缓存。静态响应以前不带 cache-control，没有校验器，
   * 浏览器就一直拿旧的。服务端已经补了 no-store，这里再兜一道：老机器上残留的
   * 缓存条目清掉，不然新加的 no-store 也管不到它。 */
  try {
    await session.defaultSession.clearCache();
  } catch {
    /* 清不掉就照常开，顶多这一次还看旧界面 */
  }

  win.once('ready-to-show', () => win.show());
  win.loadURL(url);

  // 外链一律交给系统浏览器，不在应用里开新窗口
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/.test(target)) shell.openExternal(target);
    return { action: 'deny' };
  });

  win.on('closed', () => {
    win = null;
  });

  // 点叉 = 收进托盘，不是退出。
  //
  // 以前是直接退：窗口一关，QQ 桥接、微信 bot、模型 API 实例全跟着停，
  // 用户以为它还在后台服务，其实早就没了 —— 群里的消息没人接，微信也不回。
  // 真要退出走托盘菜单的「退出」，或者系统关机（before-quit 会把 quitting 置上）。
  win.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    win.hide();
    if (!trayHintShown && tray) {
      trayHintShown = true;
      try {
        tray.displayBalloon({
          title: '还在后台跑',
          content: 'QQ 桥接和微信 bot 都没停。要彻底退出，右键托盘图标选「退出」。'
        });
      } catch {
        /* 系统不支持气泡就算了，托盘 tooltip 也够 */
      }
    }
  });

  // Windows 关机 / 注销时 Electron 不会发 before-quit（官方文档明确写了），
  // 只能在这里抢时间收一下子进程。系统不会等我们，所以不 await。
  win.on('session-end', () => {
    shutdown.begin();
  });
}

/** 从托盘/第二实例回到窗口。窗口被销毁过就重新建一个。 */
function showWindow() {
  if (!win) {
    createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/**
 * 托盘图标。
 *
 * 为什么必须有：窗口关掉后进程要活着，用户得有个地方能把它叫回来、也能真正退出。
 * 没有托盘的话「最小化到后台」就是个黑洞 —— 只能去任务管理器杀进程。
 */
function createTray() {
  if (tray) return;
  const iconPath = path.join(here, 'public', 'tray.png');
  const image = nativeImage.createFromPath(iconPath);
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
  tray.setToolTip('DualHabitat Matrix');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开主窗口', click: showWindow },
      { type: 'separator' },
      {
        label: '退出（QQ 和微信都会停）',
        click: () => {
          quitting = true;
          app.quit();
        }
      }
    ])
  );
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
}

/**
 * 应用内子窗口（NapCat 面板等本地页面）。
 *
 * 以前「扫码 / 登录」是 window.open → 被 setWindowOpenHandler 交给系统浏览器，
 * 人直接离开了应用。现在 server.mjs 通过 globalThis.dhmOpenChildWindow 调这里，
 * 在应用里开一个独立小窗口。裸跑（node server.mjs）没有这段，server 会自己降级。
 */
function openChildWindow(url, title) {
  if (!app.isReady()) return null;
  const child = new BrowserWindow({
    width: 1020,
    height: 720,
    title: title ?? '子窗口',
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  child.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/.test(target)) shell.openExternal(target);
    return { action: 'deny' };
  });
  // 加载失败（NapCat 半死、端口竞态）就换一张人话兜底页，绝不让人对着白屏猜
  child.webContents.on('did-fail-load', (_e, code, desc, url, isMain) => {
    if (isMain === false) return;
    const html = encodeURIComponent(
      `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui,'Segoe UI',sans-serif;background:#f4f6f9;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center;color:#5b6675"><h2 style="color:#1a2230">面板没加载出来</h2><p>地址：${url ?? ''}</p><p>原因：${desc ?? ''}（代码 ${code ?? ''}）</p><p>关掉这个窗口，回软件里再点一次「打开面板」就能重试。</p></div></body>`
    );
    child.loadURL('data:text/html;charset=utf-8,' + html).catch(() => {});
  });
  child.loadURL(url);
  return child.id;
}

globalThis.dhmOpenChildWindow = openChildWindow;

// 同一时间只允许一个实例，否则两个窗口抢同一个端口和同一个桥接进程
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    createWindow();
    createTray();

    // 仅开发态：自动化退出测试用（打包版里 app.isPackaged 为 true，永不生效）。
    // 走的就是托盘「退出」同一条路：quitting = true → app.quit() → before-quit 收进程。
    const testQuitMs = Number(process.env.DHM_TEST_QUIT_AFTER_MS);
    if (!app.isPackaged && Number.isFinite(testQuitMs) && testQuitMs > 0) {
      setTimeout(() => {
        quitting = true;
        app.quit();
      }, testQuitMs);
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/**
 * 退出前真正把后台服务收掉。
 *
 * 必须等 shutdownServer() resolve：里面会按进程树杀桥接、微信，再按 NapCat
 * 目录里的可执行文件路径把那份 QQ.exe 也收掉。只是发个信号就退，窗口先没了，
 * 用户看到的还是「NapCat 没关」。
 */
async function stopBackgroundServices() {
  // 服务没起过（第二实例被单实例锁挡回去 / 端口起不来）就什么都别动：
  // 这时 NapCat 属于正在跑的那个实例，杀了就是把人家的 QQ 断了。
  if (!serverStarted) return;
  try {
    if (!serverModule) serverModule = await import('./server.mjs');
    if (typeof serverModule.shutdownServer === 'function') {
      await serverModule.shutdownServer();
    }
  } catch (error) {
    console.error('退出时停止后台服务失败：', error?.message ?? error);
  }
}

const shutdown = createShutdownController({ app, stopServices: stopBackgroundServices });

// 系统关机 / 任务栏退出 / 托盘菜单退出都会走这里。
// quitting 先置上：窗口的 close 拦截靠它判断「这次是真退出，别再藏进托盘」。
app.on('before-quit', (event) => {
  quitting = true;
  shutdown.onBeforeQuit(event);
});
