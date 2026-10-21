/**
 * backends/selftest.mjs —— 不依赖网络和真实 key 的契约自测。
 *
 * 验的是**唯一真正要紧的事**：我们造的帧，`bridge.js` 那套 collector 能不能正确吃下。
 * 造得再像，collector 认不出就是白干（表现是群里没消息、日志里没错误）。
 *
 * 跑：node src/backends/selftest.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

let pass = 0;
let fail = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * 0. 拿到 collector —— 优先用真实的那个
 * ══════════════════════════════════════════════════════════════════════════ */

let createTurnCollector = null;
let collectorSource = '';

try {
  const mod = await import('../oc-client.js');
  createTurnCollector = mod.createTurnCollector;
  collectorSource = 'oc-client.js（真实）';
} catch (error) {
  collectorSource = `内联副本（未装依赖：${String(error.message).slice(0, 60)}）`;
}

/**
 * 内联副本 —— 与 oc-client.js 的 createTurnCollector 逐字同逻辑。
 * 只在没装 node_modules 时兜底；下面第 5 项会校验真实源码没有漂移。
 */
if (!createTurnCollector) {
  createTurnCollector = function inlineCollector() {
    const turns = new Map();
    return {
      push(event) {
        if (event.type === 'turn/start') {
          turns.set(event.data.turn, { text: '' });
          return null;
        }
        if (event.type === 'assistant/chunk') return null;
        if (event.type === 'assistant/message') {
          const t = turns.get(event.data.turn);
          if (!t) return null;
          for (const block of event.data.message?.content ?? []) {
            if (block?.type === 'text' && typeof block.text === 'string') t.text += block.text;
          }
          return null;
        }
        if (event.type === 'turn/end') {
          const t = turns.get(event.data.turn);
          turns.delete(event.data.turn);
          if (!t) return null;
          return { turn: event.data.turn, reason: event.data.reason, text: t.text };
        }
        return null;
      },
      has(turn) {
        return turns.has(turn);
      }
    };
  };
}

console.log(`\ncollector 来源：${collectorSource}\n`);

/* ══════════════════════════════════════════════════════════════════════════
 * 1. 信封形状
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('[1] 信封形状');
const base = await import('./base.js');
const okEnv = base.ok({ a: 1 });
check('ok() 产出 {result:{ok:true,value}}', okEnv.result.ok === true && okEnv.result.value.a === 1);
const failEnv = base.fail('internal', 'boom');
check('fail() 产出 {result:{ok:false,error}}', failEnv.result.ok === false && failEnv.result.error.code === 'internal');
const rateEnv = await base.envelope('x', async () => {
  throw new Error('HTTP 429 rate limit');
});
check('限流被分类为 rate-limited', rateEnv.result.error.code === 'rate-limited', rateEnv.result.error?.code);

/* ══════════════════════════════════════════════════════════════════════════
 * 2. 帧形状能被 collector 正确消费
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n[2] 帧 → collector');
{
  const collector = createTurnCollector();
  collector.push(base.turnStart('s1', 'turn-1').payload.event);
  collector.push(base.assistantChunk('s1', 'turn-1', '你').payload.event);
  collector.push(base.assistantChunk('s1', 'turn-1', '好').payload.event);
  const done = collector.push(base.assistantMessage('s1', 'turn-1', '你好').payload.event);
  const end = collector.push(base.turnEnd('s1', 'turn-1', 'completed').payload.event);

  check('chunk 不被累加（防「收到收到」）', done === null && end.text === '你好', `实际="${end?.text}"`);
  check('turn/end 返回 reason', end?.reason?.kind === 'completed');
  check('turn 号原样带回', end?.turn === 'turn-1');
}

{
  // 没有 turn/start 的孤立 message 必须被丢掉，否则会重复回复
  const collector = createTurnCollector();
  const orphan = collector.push(base.assistantMessage('s2', 'turn-9', '幽灵').payload.event);
  const end = collector.push(base.turnEnd('s2', 'turn-9', 'completed').payload.event);
  check('无 turn/start 的孤立消息被丢弃', orphan === null && end === null);
}

/* ══════════════════════════════════════════════════════════════════════════
 * 3. 完整一轮（mock SSE）
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n[3] 完整一轮（mock OpenAI SSE）');

const originalFetch = globalThis.fetch;
let lastRequestBody = null;

function sseResponse(chunks) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(`data: ${JSON.stringify(c)}\n\n`));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    }
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

globalThis.fetch = async (url, init) => {
  lastRequestBody = JSON.parse(init.body);
  return sseResponse([
    { choices: [{ delta: { content: '今天' } }] },
    { choices: [{ delta: { content: '下雨' } }] },
    { choices: [{ delta: { content: '了' } }] },
    { choices: [{ delta: {} }], usage: { prompt_tokens: 12, completion_tokens: 3 } }
  ]);
};

const { ModelApiBackend } = await import('./model-api.js');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dualhabitat-matrix-selftest-'));

const backend = new ModelApiBackend({
  protocol: 'openai',
  baseUrl: 'https://mock.local/v1',
  model: 'mock-model',
  apiKey: 'test-key',
  stateDir: tmpDir,
  log: () => {}
});

const created = await backend.sessions.create({ title: '自测' });
const sessionId = created.result.value.sessionId;
check('sessions.create 返回 sessionId', typeof sessionId === 'string' && sessionId.length > 0);

// 起一个消费者，模拟 bridge 的 pumpMux
const collector = createTurnCollector();
let finished = null;
const pump = (async () => {
  for await (const frame of backend.events.mux()) {
    const result = collector.push(frame.payload.event);
    if (result) {
      finished = result;
      return;
    }
  }
})();

const accepted = await backend.sessions.prompt({
  sessionId,
  mode: 'queue',
  content: [{ type: 'text', text: '今天天气怎么样' }]
});
check('prompt 立即返回 accepted（非阻塞）', accepted.result.ok === true && accepted.result.value.accepted === true);

await Promise.race([pump, new Promise((r) => setTimeout(r, 3000))]);

check('一轮产出完整文本', finished?.text === '今天下雨了', `实际="${finished?.text}"`);
check('turn 正常结束', finished?.reason?.kind === 'completed');
check('请求带上了模型名', lastRequestBody?.model === 'mock-model');
check('请求带上了用户消息', JSON.stringify(lastRequestBody?.messages).includes('今天天气'));

/* ══════════════════════════════════════════════════════════════════════════
 * 4. 第二轮带上历史
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n[4] 多轮上下文');
{
  const collector2 = createTurnCollector();
  let done2 = null;
  const pump2 = (async () => {
    for await (const frame of backend.events.mux()) {
      const r = collector2.push(frame.payload.event);
      if (r) {
        done2 = r;
        return;
      }
    }
  })();

  await backend.sessions.prompt({ sessionId, content: [{ type: 'text', text: '那明天呢' }] });
  await Promise.race([pump2, new Promise((r) => setTimeout(r, 3000))]);

  const msgs = lastRequestBody?.messages ?? [];
  check('第二轮请求包含上一轮的用户话', JSON.stringify(msgs).includes('今天天气'));
  check('第二轮请求包含上一轮的回答', JSON.stringify(msgs).includes('今天下雨了'));
  check('第二轮正常结束', done2?.reason?.kind === 'completed');
}

/* ══════════════════════════════════════════════════════════════════════════
 * 5. 契约哨兵：oc-client 的 collector 没有偷偷改掉语义
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n[5] 契约哨兵');
try {
  const ocSource = fs.readFileSync(path.join(repoRoot, 'src', 'oc-client.js'), 'utf8');
  check('collector 仍然忽略 assistant/chunk', /忽略流式分块/.test(ocSource));
  check('门面仍然导出 createTurnCollector', /export function createTurnCollector/.test(ocSource));
  check('事件流仍然叫 events.mux', /mux\(/.test(ocSource));
} catch (error) {
  check('能读到 oc-client.js', false, error.message);
}

/* ══════════════════════════════════════════════════════════════════════════
 * 6. 厂商解析
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n[6] 厂商解析');
const { resolveProfile, PROVIDERS } = await import('./providers.js');
{
  const p = resolveProfile({ provider: 'deepseek' }, { DEEPSEEK_API_KEY: 'sk-x' });
  check('内置厂商自动补 baseUrl', p.baseUrl.includes('deepseek.com'), p.baseUrl);
  check('内置厂商自动选协议', p.protocol === 'openai');
  check('从 secrets 取 key', p.apiKey === 'sk-x');
}
{
  const p = resolveProfile(
    { provider: 'custom', baseUrl: 'https://my-relay.com/v1', model: 'gpt-4o', apiKey: 'sk-y' },
    {}
  );
  check('自定义接入可用', p.baseUrl === 'https://my-relay.com/v1' && p.model === 'gpt-4o');
}
{
  let threw = false;
  try {
    resolveProfile({ provider: 'openai' }, {});
  } catch {
    threw = true;
  }
  check('缺 key 时报错而不是静默', threw);
}
check('内置厂商数量 ≥ 10', Object.keys(PROVIDERS).length >= 10, String(Object.keys(PROVIDERS).length));

/* ══════════════════════════════════════════════════════════════════════════
 * 7. CLI 降权
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n[7] CLI 降权（RULES.md 第一条）');
const { getDriver, DRIVERS, UNVERIFIED } = await import('./cli/drivers.js');
{
  const args = getDriver('claude-code').buildArgs({ allowTools: false, safeNamespaces: ['mcp__snowluma__*'] });
  const joined = args.join(' ');
  check('Claude Code 群聊模式禁用 Bash', /--disallowedTools/.test(joined) && /Bash/.test(joined));
  check('Claude Code 群聊模式进 plan 模式', /--permission-mode plan/.test(joined));
  check('Claude Code 带 stream-json', /--output-format stream-json/.test(joined));
}
{
  const args = getDriver('codex-cli').buildArgs({ allowTools: false });
  const joined = args.join(' ');
  check('Codex 用只读沙箱', /--sandbox read-only/.test(joined));
  check('Codex 永不自动批准', /--ask-for-approval never/.test(joined));
}
{
  const args = getDriver('gemini-cli').buildArgs({ allowTools: false });
  check('Gemini 不传 --yolo', !args.includes('--yolo'));
}
check('已核实驱动 ≥ 4 个', Object.keys(DRIVERS).length >= 4);
check('未核实清单有记录（不编参数）', Array.isArray(UNVERIFIED) && UNVERIFIED.length >= 8);

/* ══════════════════════════════════════════════════════════════════════════
 * 8. 收尾
 * ══════════════════════════════════════════════════════════════════════════ */

globalThis.fetch = originalFetch;
await backend.close();
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n${'─'.repeat(50)}`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exitCode = 1;
} else {
  console.log('契约对得上。');
}
