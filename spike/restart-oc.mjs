// 强制重启隔离实例（换配置 / 换 key 之后用）。
//
// 为什么单独一个小脚本：`ensureServer()` 默认**复用**已经在跑的实例，
// 而 MCP 服务列表这类东西是**启动时**读进内存的 —— 改了 opencode.json 不重启
// 就不会生效（表现成「配置明明对了，工具却不存在」）。
// 注意：`ensureServer` 在 oc-server.js，不在 oc-client.js 门面里。
import { ensureServer } from '../src/oc-server.js';

await ensureServer({ force: true, log: (m) => console.log(`  [oc] ${m}`) });
console.log('  ✅ 隔离实例已按新配置重启');
