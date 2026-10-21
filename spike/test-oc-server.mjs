// 服务器生命周期的真机测试（④）。
//
// 这个测试会**真的停掉再拉起**隔离实例 —— 生命周期代码不真跑一遍没有意义。
// 验的是四件事：
//   1. 幂等：已经在跑时 ensureServer 必须复用，不能又起一个（端口会撞）。
//   2. 冷启动：不在时能起来，并且**等到真应答**才返回（不是"spawn 完就当成功"）。
//   3. 停：只停注册文件里那个 pid，且真停下来（能立刻重启）。
//   4. 按模型池决定起不起 cf-shim，并在 CF 没接线时吼出来。
//
// 前置：无（本测试自己起停）
// 跑法：node spike/test-oc-server.mjs
import fs from 'node:fs';
import { SERVICE_FILE, SHIM_PORT } from '../src/oc-env.js';
import { ensureServer, serverStatus, stopServer } from '../src/oc-server.js';
import { shimAlive } from '../src/cf-shim.js';

let failed = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
  }
};

const logs = [];
const log = (m) => {
  logs.push(String(m));
  console.log(`    [server] ${m}`);
};

console.log('== 1. 停止现存实例（确保从"没有"开始）==');
const before = await serverStatus();
console.log(`    停止前：${before.running ? `在运行 pid=${before.pid}` : `未运行（${before.reason}）`}`);
const oldPid = before.pid;
await stopServer({ log });
const afterStop = await serverStatus();
check('停完之后确实不在运行', afterStop.running === false, JSON.stringify(afterStop));

console.log('== 2. 冷启动 ==');
const first = await ensureServer({ log });
check('本次是"新起"', first.started === true, JSON.stringify(first));
check(`拿到真实 url（${first.url}）`, /^http:\/\/127\.0\.0\.1:\d+$/.test(first.url ?? ''), first.url);
check(`拿到版本号（${first.version}）`, typeof first.version === 'string' && first.version.length > 0);
check('pid 是新的（真的重启了）', Number(first.pid) !== Number(oldPid), `${oldPid} → ${first.pid}`);
check('返回的 pid 就是注册文件里的 pid', JSON.parse(fs.readFileSync(SERVICE_FILE, 'utf8')).pid === first.pid);

console.log('== 3. 幂等：已经在跑时必须复用 ==');
const second = await ensureServer({ log });
check('第二次不再新起', second.started === false, JSON.stringify(second));
check('复用同一个 pid', Number(second.pid) === Number(first.pid), `${first.pid} vs ${second.pid}`);
check('地址一致', second.url === first.url);

console.log('== 4. cf-shim 的生命周期（模型池里有 CF）==');
check('池里有 CF → shim 被判定为"需要"', first.shim?.needed === true, JSON.stringify(first.shim));
check('shim 真的在应答健康检查', (await shimAlive(SHIM_PORT)) === true);
check(
  'CF 没接线时要吼出来（opencode.json 里没有 CF 的 baseURL）',
  logs.some((m) => m.includes('CF 候选会一直失败')),
  logs.filter((m) => m.includes('CF')).join(' | ') || '(没有 CF 相关日志)'
);
check('复用路径也会检查 shim（第二次 ensure 也报了 shim 状态）', logs.filter((m) => m.includes('cf-shim')).length >= 2);

console.log('== 5. force 重启 ==');
const forced = await ensureServer({ force: true, log });
check('force 之后是新进程', forced.started === true && forced.pid !== first.pid, `${first.pid} → ${forced.pid}`);
check('force 之后仍能应答', (await serverStatus()).running === true);

console.log('== 6. 停：必须真停下来（否则紧接着重启会撞端口）==');
const stopped = await stopServer({ log });
check('停到了服务进程', stopped.server === true);
check('停到了 cf-shim', stopped.shim === true);
check('停完状态是"不在运行"', (await serverStatus()).running === false);
check('shim 也停了', (await shimAlive(SHIM_PORT)) === false);

console.log('== 7. 停完能立刻重启（端口没被占住）==');
const again = await ensureServer({ log, withShim: false });
check('立刻重启成功', again.started === true && again.url === forced.url, JSON.stringify(again));
check('重启后服务真的应答', (await serverStatus()).running === true);

console.log(`\n${'='.repeat(52)}`);
console.log(`通过 ${failed === 0 ? '全部' : '部分'}，失败 ${failed} 项`);
process.exit(failed ? 1 : 0);
