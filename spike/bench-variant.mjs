// 测「思考档位」对真实回合耗时的影响：同一个模型，variant=none / low / 不设，
// 各跑一个短回合，比较耗时。走的是桥接真实用的 OpenCode 隔离实例。
// 用法：node spike/bench-variant.mjs <model> [variant1 variant2 ...]
import { NodeApiClient, unwrap, createTurnCollector } from '../src/oc-client.js';
import { PATHS } from '../src/oc-env.js';

const ROOT = 'C:\\Users\\<用户>\\DualHabitatMatrix';
const [modelArg, ...variantArgs] = process.argv.slice(2);
const model = modelArg || 'qwen3.6-plus';
const variants = variantArgs.length ? variantArgs : ['none', 'low', ''];

const api = new NodeApiClient(undefined, undefined, {
  stateDir: PATHS.state,
  sessionDir: PATHS.state,
  // 关掉模型链，否则链里的候选会覆盖掉下面指定的 variant
  models: { enabled: false, allowPaid: false, exhaustedNotice: '', free: [], paid: [] },
  log: () => {}
});

async function run(variant) {
  const ws = unwrap(await api.workspace.create({ path: ROOT }), 'workspace.create');
  const created = unwrap(
    await api.sessions.create({
      workspaceId: ws.workspace.workspaceId,
      ...(process.env.AGENT ? { agentPreset: process.env.AGENT } : {}),
      title: `bench-${model}-${variant || 'default'}`
    }),
    'sessions.create'
  );
  const sessionId = created.sessionId;
  let selected = null;
  try {
    const r = await api.sessions.selectModel({
      sessionId,
      provider: 'bailian',
      model,
      ...(variant ? { reasoningEffort: variant } : {})
    });
    selected = unwrap(r, 'selectModel');
  } catch (e) {
    return { variant: variant || 'default', error: `选模型失败: ${e?.message ?? e}` };
  }

  const collector = createTurnCollector();
  const stream = api.events.mux({});
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('超时 150s')), 150_000);
    (async () => {
      for await (const env of stream) {
        const frame = env.payload;
        if (frame.type === 'session/event' && frame.sessionId === sessionId) {
          const ended = collector.push(frame.event);
          if (ended) { clearTimeout(timer); resolve(ended); return; }
        }
        if (frame.type === 'stream/error') { clearTimeout(timer); reject(new Error('流错误')); return; }
      }
    })().catch((e) => { clearTimeout(timer); reject(e); });
  });
  api.events.follow(sessionId);

  const t0 = Date.now();
  unwrap(
    await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: process.env.PROMPT || '只回复两个字：收到' }] }),
    'sessions.prompt'
  );
  const ended = await done;
  const ms = Date.now() - t0;
  const usage = ended.usage || ended.tokens || null;
  try { await api.sessions.delete?.({ sessionId }); } catch {}
  return {
    variant: variant || 'default',
    applied: selected?.selected?.reasoningEffort ?? selected?.reasoningEffort ?? '?',
    ms,
    text: String(ended.text || '').replace(/\s+/g, ' ').slice(0, 30),
    usage: usage ? JSON.stringify(usage).slice(0, 120) : null
  };
}

for (const v of variants) {
  try {
    const r = await run(v);
    if (r.error) console.log(`${model} variant=${r.variant}: ${r.error}`);
    else console.log(`${model} variant=${String(r.variant).padEnd(7)} 实际=${String(r.applied).padEnd(7)} ${String(r.ms).padStart(6)}ms 「${r.text}」 ${r.usage || ''}`);
  } catch (e) {
    console.log(`${model} variant=${v}: 异常 ${e?.message ?? e}`);
  }
}
process.exit(0);
