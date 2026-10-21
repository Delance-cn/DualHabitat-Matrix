// 起（或复用）桥接专用的隔离 OpenCode 实例。
//
// 这个脚本现在是 `src/oc-server.js` 的一层薄壳 —— 真正的实现在那边，
// 因为桥接启动时也要自己调它。**不能有两份**：两份必然漂移，
// 而这份代码管的是进程生命周期和代理探活，漂移的后果是"服务看着在跑其实连不上"。
//
// 用法：node spike/start-server.mjs [--force]
import { ensureServer, serverStatus } from '../src/oc-server.js';

const force = process.argv.includes('--force');
const result = await ensureServer({ force, log: (m) => console.log(m) });

console.log('');
console.log(`状态：${result.started ? '本次新起' : '复用了已有的'}`);
console.log(`地址：${result.url}`);
console.log(`pid ：${result.pid}   version：${result.version}`);
if (result.shim?.needed) {
  console.log(`shim：${result.shim.started ? '本次新起' : '已在运行'} 端口 ${result.shim.port}`);
} else {
  console.log('shim：未启用（模型池里没有 CF 模型）');
}
const status = await serverStatus();
console.log(`自检：${status.running ? 'ok' : `异常（${status.reason}）`}`);
process.exit(status.running ? 0 : 1);
