// cf-shim 的 CLI 入口：由 `src/oc-server.js` 以**独立进程**拉起。
//
// 为什么必须是独立进程（而不是在桥接进程里跑一个 http server）：
// 模型 API 的隔离实例是 `detached` 起的，**它比桥接活得久**。如果 shim 跑在桥接
// 进程内，桥接一崩，CF 这条链就断了，而 模型 API 还以为 CF 可用 —— 变成
// "候选看着好好的、每次调用都失败"，正好是最难查的那种。
// 所以两者生命周期绑在一起：同一个 pid 文件目录、同一套 stop 逻辑。
//
// 环境变量：
//   QQ_BRIDGE_SHIM_PORT   监听端口（默认 4600）
//   QQ_BRIDGE_SHIM_LOG    取证 jsonl 路径
//   CF_SHIM_FIX=0         只观测不修（排障用）
import { PATHS, SHIM_PORT } from './oc-env.js';
import { loadSecrets } from './oc-env.js';
import { startShim } from './cf-shim.js';

const port = Number(process.env.QQ_BRIDGE_SHIM_PORT ?? SHIM_PORT);
const logFile = process.env.QQ_BRIDGE_SHIM_LOG ?? PATHS.shimLog;

const shim = await startShim({
  port,
  logFile,
  secrets: loadSecrets(),
  fix: process.env.CF_SHIM_FIX !== '0',
  log: (m) => console.log(m)
});

console.log(`[shim] content 拍平: ${process.env.CF_SHIM_FIX === '0' ? '关' : '开'}   取证日志: ${logFile}`);

const shutdown = async () => {
  await shim.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
