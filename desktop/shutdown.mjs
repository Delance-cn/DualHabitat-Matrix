/**
 * desktop/shutdown.mjs —— 退出闸门。
 *
 * Electron 退出**不会**自动带走子进程：QQ 桥接、微信 bot、NapCat 都会变成孤儿。
 * 0.5.1 及以前 `before-quit` 只把 `quitting` 置上就放行，结果窗口没了、NapCat
 * 还在后台占着端口 —— 下次开软件要么连不上，要么起第二份。
 *
 * `before-quit` 是同步事件，没法在里面 await，所以只能：
 *   preventDefault → 异步收后台服务 → 再 app.quit()
 * 这个文件只管「顺序和兜底」；具体收哪些进程在 server.mjs 的 shutdownServer()。
 */

export function createShutdownController({
  app,
  stopServices,
  log = console,
  timeoutMs = 10_000
} = {}) {
  let started = false;
  let finished = false;
  let task = null;

  /**
   * 开始收尾，返回一个在后台服务停完后 resolve 的 Promise。
   * 系统关机（session-end）只调这个，不要 app.quit() —— 系统已经在退了。
   */
  function begin() {
    if (task) return task;
    started = true;

    // 兜底：后台服务万一卡住（PowerShell 不响应、taskkill 半死），
    // 也不能让用户点了「退出」却关不掉。到点直接硬退。
    const timer = setTimeout(() => {
      try {
        log.error?.(`退出收尾超过 ${Math.round(timeoutMs / 1000)} 秒，强制结束`);
      } catch {
        /* 日志本身失败不影响退出 */
      }
      finished = true;
      try {
        app.exit(0);
      } catch {
        /* 已经退了 */
      }
    }, timeoutMs);
    timer.unref?.();

    task = Promise.resolve()
      .then(() => stopServices())
      .catch((error) => {
        try {
          log.error?.('退出时停止后台服务失败：', error?.message ?? error);
        } catch {
          /* 忽略 */
        }
      })
      .finally(() => clearTimeout(timer));
    return task;
  }

  function onBeforeQuit(event) {
    // 收尾完成后第二次进来：放行，这次真的退。
    if (finished) return;

    // 第一次进来：先拦下退出。
    event?.preventDefault?.();
    if (started) return;

    begin().finally(() => {
      if (finished) return; // 兜底已经硬退过了
      finished = true;
      try {
        app.quit();
      } catch {
        /* 已经退了 */
      }
    });
  }

  return {
    begin,
    onBeforeQuit,
    get started() {
      return started;
    },
    get finished() {
      return finished;
    }
  };
}
