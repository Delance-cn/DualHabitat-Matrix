// 验证 NVIDIA NIM 这把 key：能否列模型、能否推理、能否工具调用。
// 参考实现走 OpenAI 兼容接口 https://integrate.api.nvidia.com/v1
import fs from 'node:fs';

const key = JSON.parse(fs.readFileSync(new URL('../secrets.json', import.meta.url), 'utf8')).NVIDIA_API_KEY;
const BASE = 'https://integrate.api.nvidia.com/v1';
const masked = `${key.slice(0, 10)}…${key.slice(-4)}`;
console.log('使用 key:', masked, '\n');

// ── 1. key 是否被接受 ────────────────────────────────────────────────────
let models = [];
try {
  const res = await fetch(`${BASE}/models`, { headers: { Authorization: `Bearer ${key}` } });
  console.log('GET /models →', res.status);
  if (res.status === 200) {
    const json = await res.json();
    models = (json.data ?? []).map((m) => m.id);
    console.log('  可见模型数:', models.length);
    console.log('  样例:', models.slice(0, 10).join(', '));
  } else {
    console.log('  响应:', (await res.text()).slice(0, 200));
  }
} catch (error) {
  console.log('  GET /models 失败:', error?.message ?? error);
}

// ── 2. 挑几个能带工具的候选试推理 ────────────────────────────────────────
// 优先中文友好 + 已知支持 function calling 的
const prefer = [
  'z-ai/glm-5.3-flash',
  'z-ai/glm-5.3',
  'z-ai/glm-5.2',
  'deepseek-ai/deepseek-v4-flash-0731',
  'moonshotai/kimi-k2-7-code',
  'qwen/qwen3-235b-a22b',
  'meta/llama-3.3-70b-instruct',
  'openai/gpt-oss-120b'
];
const candidates = prefer.filter((m) => models.includes(m));
console.log('\n候选（在目录里存在的）:', candidates.join(', ') || '(都不在，改用前几个模型)');
const toTest = candidates.length ? candidates.slice(0, 6) : models.slice(0, 3);

const tools = [
  {
    type: 'function',
    function: {
      name: 'give_answer',
      description: '给出最终答案。必须调用这个工具来回答。',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text']
      }
    }
  }
];

console.log('\n模型'.padEnd(38) + '对话            工具调用');
console.log('─'.repeat(80));
for (const model of toTest) {
  let plain = '✗';
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: '只回一个字：好' }], max_tokens: 16 }),
      signal: AbortSignal.timeout(60000)
    });
    const json = await res.json();
    if (res.status === 200) {
      plain = `✓ "${String(json.choices?.[0]?.message?.content ?? '').trim().slice(0, 12)}"`;
    } else {
      plain = `✗ ${res.status} ${JSON.stringify(json?.error ?? json).slice(0, 40)}`;
    }
  } catch (error) {
    plain = `✗ ${error?.name}`;
  }

  let tool = '─';
  if (plain.startsWith('✓')) {
    try {
      const res = await fetch(`${BASE}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: '请调用 give_answer 工具，把答案设成「好」。' }],
          tools,
          tool_choice: 'auto',
          max_tokens: 128
        }),
        signal: AbortSignal.timeout(60000)
      });
      const json = await res.json();
      const called = (json.choices?.[0]?.message?.tool_calls ?? []).length;
      tool = called ? '✓ 真调用了' : '△ 没用工具';
    } catch (error) {
      tool = `✗ ${error?.name}`;
    }
  }
  console.log(`${model.padEnd(36)} ${plain.padEnd(15)} ${tool}`);
}
