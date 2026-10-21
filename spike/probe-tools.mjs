// Phase 0 安全探针：工具调用 + 审批往返 + 工具面锁死。
//
// 用法（config 由外部切换，见 README-phase0.md）：
//   node spike/probe-tools.mjs
//
// 验证三件事：
//   1. 模型能发起工具调用（shell），事件流里有 tool.* 事件
//   2. 规则为 ask 时收到 permission.asked，客户端 reply 后工具继续执行
//   3. 规则为 deny 时工具被拦下（不产生 permission.asked）
import fs from 'node:fs';
import path from 'node:path';
import { OpenCode } from '@opencode/client';
import { Service } from '@opencode/client/service';
import { PATHS, ROOT } from './oc-env.mjs';

const MODEL = {
  providerID: process.env.PROBE_PROVIDER ?? 'opencode',
  id: process.env.PROBE_MODEL ?? 'deepseek-v4.1-flash-free',
  ...(process.env.PROBE_VARIANT ? { variant: process.env.PROBE_VARIANT } : {}),
};
const eventsFile = path.join(PATHS.logs, 'probe-tools-events.jsonl');
const PROMPT =
  process.env.PROBE_PROMPT ??
  '请用 shell 工具执行这条命令，并把它的标准输出原样告诉我：echo phase0-marker';

const regFile = path.join(PATHS.state, 'opencode', 'service.json');
const endpoint = await Service.discover({ file: regFile });
if (!endpoint) {
  console.error('服务未运行，先跑 node spike/start-server.mjs');
  process.exit(1);
}
console.log(`[discover] ${endpoint.url}`);
const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });

let text = '';
const permQueue = [];
let permResolver = null;
const waitPermission = () =>
  new Promise((resolve) => {
    if (permQueue.length) return resolve(permQueue.shift());
    permResolver = resolve;
  });

let done;
const finished = new Promise((resolve) => { done = resolve; });

const stream = (async () => {
  for await (const event of client.event.subscribe()) {
    fs.appendFileSync(eventsFile, `${JSON.stringify(event)}\n`);
    const d = event.data ?? {};
    if (event.type === 'session.text.ended' && typeof d.text === 'string') text = d.text;
    if (event.type === 'session.text.delta' && typeof d.delta === 'string') text += d.delta;
    if (event.type?.startsWith('session.tool') || event.type === 'permission.asked' || event.type === 'permission.replied') {
      console.log(`[evt] ${event.type}  ${JSON.stringify(d).slice(0, 300)}`);
    }
    if (event.type === 'permission.asked') {
      if (permResolver) { const r = permResolver; permResolver = null; r(d); }
      else permQueue.push(d);
    }
    if (event.type === 'session.execution.succeeded' || event.type === 'session.execution.failed' || event.type === 'session.execution.interrupted') {
      done(event.type);
    }
  }
})().catch((error) => console.error('[event stream]', error?.message ?? error));

const session = await client.session.create({ title: 'phase0-tools', model: MODEL, location: { directory: ROOT } });
console.log(`[session] ${session.id}`);

await client.session.prompt({ sessionID: session.id, text: PROMPT });
console.log('[prompt] 已发送');

// 边等回合结束，边处理审批请求。
const result = await Promise.race([
  (async () => {
    while (true) {
      const winner = await Promise.race([
        finished.then((value) => ({ kind: 'done', value })),
        waitPermission().then((value) => ({ kind: 'perm', value })),
      ]);
      if (winner.kind === 'done') return winner.value;
      const request = winner.value;
      console.log(`[permission] action=${request.action} resources=${JSON.stringify(request.resources)} id=${request.id}`);
      // 桥接在这里做的事：把审批转发到 QQ，把用户的决定回填。
      await client.permission.reply({
        sessionID: request.sessionID,
        requestID: request.id,
        decision: 'once',
      });
      console.log('[permission] 已回复 once');
    }
  })(),
  new Promise((resolve) => setTimeout(() => resolve('timeout'), 120_000)),
]);

console.log(`[wait] ${result}`);
console.log(`[assistant text] ${JSON.stringify(text)}`);

const stats = await client.session.stats({});
console.log(`[tool totals] ${JSON.stringify(stats.tools)}`);

stream.catch(() => {});
process.exit(0);
