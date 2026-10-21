// 停掉桥接专用的隔离 OpenCode 实例（含由它拉起的 cf-shim）。
//
// 同样是 `src/oc-server.js` 的薄壳。只停**注册文件里记着的那个 pid**，
// 绝不按端口杀进程 —— 用户桌面端可能也在用一个随机端口，误杀代价很大。
//
// 用法：node spike/stop-server.mjs
import { serverStatus, stopServer } from '../src/oc-server.js';

const before = await serverStatus();
console.log(`停止前：${before.running ? `在运行（pid=${before.pid}）` : `未运行（${before.reason}）`}`);
const result = await stopServer({ log: (m) => console.log(m) });
const after = await serverStatus();
console.log(`停止后：${after.running ? '⚠️ 仍在运行' : '已停止'}（server=${result.server} shim=${result.shim}）`);
process.exit(after.running ? 1 : 0);
