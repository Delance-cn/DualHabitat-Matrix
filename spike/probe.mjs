// Phase 0 探针：验证桥接需要的 OpenCode 能力是否齐备。
//
// 跑法：先 node spike/start-server.mjs，再 node spike/probe.mjs
//
// 本步验证：
//   1. 用官方 @opencode/client 发现隔离实例并完成鉴权（HTTP Basic）
//   2. 指定模型 opencode/deepseek-v4.1-flash-free（= 当前会话所跑的那个模型）
//   3. 建会话 -> 发消息 -> 从事件流拿到最终文本
//   4. 读 token 统计
// 所有原始事件落盘到 spike/logs/probe-events.jsonl，便于逐个核对形状。
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
const eventsFile = path.join(PATHS.logs, 'probe-events.jsonl');
const PROMPT =
  process.env.PROBE_PROMPT ??
  '只回答一个问题：1+1 等于几？直接用一句话回答，不要调用任何工具。';

fs.mkdirSync(PATHS.logs, { recursive: true });

// ── 1. 发现 + 鉴权 ──────────────────────────────────────────────────────────
const regFile = path.join(PATHS.state, 'opencode', 'service.json');
if (!fs.existsSync(regFile)) {
  console.error(`找不到注册文件 ${regFile}，先跑 node spike/start-server.mjs`);
  process.exit(1);
}
const endpoint = await Service.discover({ file: regFile });
if (!endpoint) {
  console.error('Service.discover 返回空：服务没在跑 / 版本不匹配');
  process.exit(1);
}
console.log(`[discover] ${endpoint.url}  auth=${endpoint.auth?.type ?? 'none'}`);

const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });

const info = await client.server.info();
console.log(`[info] version=${info.version} pid=${info.pid}`);

// ── 2. 模型目录：确认目标模型在且带工具能力 ─────────────────────────────────
const models = await client.model.list();
const list = models?.data ?? models?.models ?? models;
const target = (Array.isArray(list) ? list : []).find((m) => m.id === MODEL.id);
if (!target) {
  console.error(`模型目录里找不到 ${MODEL.id}`);
} else {
  console.log(`[model] ${target.id} provider=${target.providerID} tools=${target.capabilities?.tools} input=${JSON.stringify(target.capabilities?.input)} variants=${JSON.stringify((target.variants ?? []).map((v) => v.id))}`);
}

// ── 3. 事件流：必须在 prompt 之前订阅（订阅是 live-only，无回放）────────────
const seen = new Map();
let textAccum = '';
let lastStepTokens = null;
const idleWaiters = [];
const waitIdle = () => new Promise((resolve) => idleWaiters.push(resolve));

const stream = (async () => {
  for await (const event of client.event.subscribe()) {
    fs.appendFileSync(eventsFile, `${JSON.stringify(event)}\n`);
    seen.set(event.type, (seen.get(event.type) ?? 0) + 1);
    // 实测形状（2026-10-17, 2.0.32）：
    //   session.text.delta -> data.delta   增量
    //   session.text.ended -> data.text    该条消息的最终全文
    //   session.step.ended -> data.tokens  本步 token（含 cache.read/write）+ data.finish
    const d = event.data ?? {};
    if (event.type === 'session.text.delta' && typeof d.delta === 'string') textAccum += d.delta;
    if (event.type === 'session.text.ended' && typeof d.text === 'string') textAccum = d.text;
    if (event.type === 'session.step.ended' && d.tokens) lastStepTokens = d.tokens;
    console.log(`[evt] ${event.type}`);
    // 回合结束信号：实测本机只有 execution.* 会到，session.idle 不会。
    if (
      event.type === 'session.execution.succeeded' ||
      event.type === 'session.execution.failed' ||
      event.type === 'session.execution.interrupted'
    ) {
      for (const resolve of idleWaiters.splice(0)) resolve(event.type);
    }
  }
})().catch((error) => console.error('[event stream] 结束:', error?.message ?? error));

// ── 4. 建会话（会话创建时就钉死模型，等价于 DSH 的 selectModel）─────────────
const session = await client.session.create({
  title: 'phase0-probe',
  model: MODEL,
  location: { directory: ROOT },
});
console.log(`[session] ${session.id}`);

// ── 5. 发消息，等回合结束 ───────────────────────────────────────────────────
const idle = waitIdle();
await client.session.prompt({
  sessionID: session.id,
  text: PROMPT,
});
console.log('[prompt] 已发送，等待 idle…');

const finished = await Promise.race([
  idle.then((value) => value ?? 'idle'),
  new Promise((resolve) => setTimeout(() => resolve('timeout'), 90_000)),
]);
console.log(`[wait] ${finished}`);
console.log(`[step tokens] ${JSON.stringify(lastStepTokens)}`);

// ── 6. token 统计 ───────────────────────────────────────────────────────────
try {
  const stats = await client.session.stats({});
  console.log('[stats]', JSON.stringify(stats));
} catch (error) {
  console.error('[stats] 失败:', error?.message ?? error);
}

// ── 7. 汇总 ─────────────────────────────────────────────────────────────────
const HR = '=====';
console.log(`\n${HR} 收到的事件类型 ${HR}`);
for (const [type, count] of [...seen].sort()) console.log(`  ${count.toString().padStart(3)}  ${type}`);
console.log(`\n[assistant text] ${JSON.stringify(textAccum)}`);
console.log(`[events] 原始事件已落盘 ${eventsFile}`);

stream.catch(() => {});
process.exit(0);
