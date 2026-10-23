// 配置生成器的 provider 覆盖测试（离线，纯函数）。
//
// 背景：0.5.1 的事故是「模型池里有 lmstudio/xxx，生成的 opencode.json 却没有
// provider 段 → 4599 目录里没有这个模型 → 启动校验把唯一候选剔掉 → 每条消息
// 秒回 API 连不上」。0.5.2 只补了 lmstudio / ollama 两家，vLLM（含 llama.cpp）、
// Jan、以及「自定义 / 中转站」（provider 空 + 手填 baseUrl）仍然会被整档丢掉。
//
// 这个文件锁住四件事：
//   1. 本地服务商一家不漏：lmstudio / ollama / vllm / llamacpp / jan
//   2. 自定义接入（空 provider + baseUrl，或显式 custom）也能写出 provider 段
//   3. 界面填的 baseUrl 优先于预设端口（LM Studio 换端口 / llama.cpp 用 8080 都能跑）
//   4. 手写的 provider 定义不被生成器吃掉，未知 provider 仍然明确告警
import { buildConfig } from '../src/oc-config.js';

let pass = 0;
let fail = 0;
const ok = (name, condition, extra = '') => {
  if (condition) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${extra ? `  ← ${extra}` : ''}`);
  }
};

const persona = { 'qq-chat': 'p', 'qq-chat-v2': 'p2' };
const agentTools = { enabled: false };
const POOL = { free: ['zhipuai/glm-4.5-flash#none'], paid: [] };

function build(slots, { pool = POOL, base = {} } = {}) {
  return buildConfig({ base, pool, persona, workPersona: 'w', chatOnly: false, slots, agentTools });
}

/** agent 上落的 model（没写就是 undefined）。 */
function agentModel(config, id = 'qq-chat') {
  return config.agents?.[id]?.model;
}

// ── 1. 本地服务商：档位 → agent + provider 段 ──────────────────────────────
console.log('\n=== 1. 五家本地服务商都能落到 agent 和 provider 段 ===');
const locals = [
  ['lmstudio', 'local-model', 'http://127.0.0.1:1234/v1'],
  ['ollama', 'qwen2.5:7b', 'http://127.0.0.1:11434/v1'],
  ['vllm', 'Qwen2.5-7B-Instruct', 'http://127.0.0.1:8000/v1'],
  ['llamacpp', 'qwen2.5-7b-q4', 'http://127.0.0.1:8080/v1'],
  ['jan', 'llama-3.1-8b', 'http://127.0.0.1:1337/v1']
];

for (const [id, model, expectBase] of locals) {
  const { config, notes } = build({ chat: { provider: id, model, baseUrl: '' } });
  ok(`${id}：qq-chat 的 model 是 ${id}/${model}`, agentModel(config) === `${id}/${model}`, agentModel(config));
  ok(`${id}：qq-chat-v2 也落了`, agentModel(config, 'qq-chat-v2') === `${id}/${model}`, agentModel(config, 'qq-chat-v2'));
  ok(`${id}：provider 段写出来了`, Boolean(config.provider?.[id]), Object.keys(config.provider ?? {}).join(','));
  ok(`${id}：baseURL = ${expectBase}`, config.provider?.[id]?.options?.baseURL === expectBase, config.provider?.[id]?.options?.baseURL);
  ok(`${id}：模型清单里有 ${model}`, Boolean(config.provider?.[id]?.models?.[model]), JSON.stringify(Object.keys(config.provider?.[id]?.models ?? {})));
  ok(`${id}：apiKey 非空`, Boolean(config.provider?.[id]?.options?.apiKey), config.provider?.[id]?.options?.apiKey);
  ok(`${id}：没有"暂不接到 agent"的告警`, !notes.some((n) => n.includes('暂不接到 agent')), notes.filter((n) => n.includes('暂不接到 agent')).join('|'));
}

// ── 2. 界面填的地址优先 ───────────────────────────────────────────────────
console.log('\n=== 2. 界面填的 baseUrl 优先于预设端口 ===');
{
  const { config } = build({ chat: { provider: 'vllm', model: 'm', baseUrl: 'http://127.0.0.1:8001/v1' } });
  ok('vLLM 换到 8001 也照填的来', config.provider?.vllm?.options?.baseURL === 'http://127.0.0.1:8001/v1', config.provider?.vllm?.options?.baseURL);
  ok('agent 的 model 不受端口影响', agentModel(config) === 'vllm/m');
}

// ── 3. 自定义接入 ────────────────────────────────────────────────────────
console.log('\n=== 3. 自定义接入（provider 空 + baseUrl，或显式 custom）===');
{
  const relay = 'dhm-chat-relay';
  const { config, notes } = build({ chat: { provider: '', model: 'gpt-4o-mini', baseUrl: 'https://relay.example.com/v1' } });
  ok('空 provider 也认（以前整档被丢）', agentModel(config) === `${relay}/gpt-4o-mini`, agentModel(config));
  ok(`${relay} 写出来了`, Boolean(config.provider?.[relay]));
  ok('baseURL 用的是界面填的', config.provider?.[relay]?.options?.baseURL === 'https://relay.example.com/v1', config.provider?.[relay]?.options?.baseURL);
  ok('key 走按档位独立的 env，不摊在配置里', config.provider?.[relay]?.options?.apiKey === '{env:DHM_MODEL_QQ_CHAT_API_KEY}', config.provider?.[relay]?.options?.apiKey);
  ok('模型清单里有 gpt-4o-mini', Boolean(config.provider?.[relay]?.models?.['gpt-4o-mini']));
  ok('npm 是 openai-compatible', config.provider?.[relay]?.npm === '@ai-sdk/openai-compatible', config.provider?.[relay]?.npm);
  ok('没有"暂不接到 agent"的告警', !notes.some((n) => n.includes('暂不接到 agent')));
}
{
  const { config } = build({ chat: { provider: 'custom', model: 'qwen-plus', baseUrl: 'https://relay2.example.com/v1' } });
  ok('显式选 custom 同样生效', agentModel(config) === 'dhm-chat-relay/qwen-plus', agentModel(config));
}
{
  const { config, notes } = build({ chat: { provider: 'custom', model: 'qwen-plus', baseUrl: '' } });
  ok('custom 缺 baseUrl 时不生成 relay（避免空 baseURL 让 4599 起不来）', !config.provider?.['dhm-chat-relay']);
  ok('custom 缺 baseUrl 时明确告警', notes.some((n) => n.includes('没填 baseUrl')), notes.join('|'));
  ok('custom 缺 baseUrl 时不落 agent', agentModel(config) === undefined, agentModel(config));
}

// ── 4. 池里的本地模型：档没配也得补 provider ─────────────────────────────
console.log('\n=== 4. 池里有本地模型（档没配）→ 自动补 provider ===');
for (const [id, entry] of [
  ['vllm', 'vllm/Qwen2.5-7B-Instruct'],
  ['jan', 'jan/llama-3.1-8b'],
  ['llamacpp', 'llamacpp/qwen2.5-7b-q4']
]) {
  const { config, notes } = build({}, { pool: { free: [entry], paid: [] } });
  ok(`${id}：顶层 model 指向池里那条`, config.model === entry, config.model);
  ok(`${id}：provider 段自动补上`, Boolean(config.provider?.[id]));
  ok(`${id}：模型条目在（否则目录里仍然没有）`, Boolean(config.provider?.[id]?.models?.[entry.split('/')[1]]));
  ok(`${id}：不再报"没有对应 provider 定义"`, !notes.some((n) => n.includes('没有对应 provider 定义')), notes.join('|'));
}

// ── 5. 手写 provider 保留 + 未知 provider 告警 ───────────────────────────
console.log('\n=== 5. 手写定义保留、未知 provider 仍然告警 ===');
{
  const base = { provider: { 'deepseek-official': { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'https://api.deepseek.com/v1' } } } };
  const { config } = build({ chat: { provider: 'lmstudio', model: 'local-model', baseUrl: '' } }, { base });
  ok('手写的 deepseek-official 没被吃掉', Boolean(config.provider?.['deepseek-official']));
  ok('手写定义的内容原样保留', config.provider?.['deepseek-official']?.options?.baseURL === 'https://api.deepseek.com/v1');
  ok('同一次生成里本地 provider 也在', Boolean(config.provider?.lmstudio));
}
{
  const { config, notes } = build({ chat: { provider: 'some-relay', model: 'x', baseUrl: 'https://relay.example.com/v1' } });
  ok('未知 provider 有 baseUrl 时按自定义中转站接入', agentModel(config) === 'dhm-chat-relay/x', agentModel(config));
  ok('未知 provider 的中转站告警明确', notes.some((n) => n.includes('使用独立中转站')), notes.join('|'));
}
{
  const { config, notes } = build({ chat: { provider: 'some-relay', model: 'x', baseUrl: '' } });
  ok('未知 provider 没地址时不硬接', agentModel(config) === undefined, agentModel(config));
  ok('未知 provider 没地址时有明确告警', notes.some((n) => n.includes('需提供')), notes.join('|'));
}
{
  const { config, notes } = build({}, { pool: { free: ['custom/relay-model'], paid: [] } });
  ok('池里有 custom 但没配地址 → 告警', notes.some((n) => n.includes('没有对应 provider 定义')), notes.join('|'));
  ok('告警里指明去「API 与模型」页填地址', notes.some((n) => n.includes('API 与模型')), notes.join('|'));
  ok('不会写出空的 custom provider', !config.provider?.custom);
}

// ── 6. 两档同源 / 变体后缀 ───────────────────────────────────────────────
console.log('\n=== 6. 两档与变体后缀 ===');
{
  const { config } = build({
    chat: { provider: 'vllm', model: 'm#low', baseUrl: 'http://127.0.0.1:8000/v1' },
    work: { provider: 'vllm', model: 'm#low', baseUrl: 'http://127.0.0.1:8000/v1' }
  });
  ok('work 档也落 vllm', agentModel(config, 'qq-work') === 'vllm/m#low', agentModel(config, 'qq-work'));
  ok('provider 的模型名去掉了 #variant', Boolean(config.provider?.vllm?.models?.m), JSON.stringify(Object.keys(config.provider?.vllm?.models ?? {})));
  ok('没有把 #low 写进模型名', !Object.keys(config.provider?.vllm?.models ?? {}).some((k) => k.includes('#')), JSON.stringify(Object.keys(config.provider?.vllm?.models ?? {})));
}

console.log(`\n${'='.repeat(52)}`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
