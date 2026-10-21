// NVIDIA NIM：列全部可见模型，并按 QQ 场景选测（中文 + 工具）。
// 上次"空回复"是 max_tokens=16 被推理过程吃掉了，这次给足。
import fs from 'node:fs';

const key = JSON.parse(fs.readFileSync(new URL('../secrets.json', import.meta.url), 'utf8')).NVIDIA_API_KEY;
const BASE = 'https://integrate.api.nvidia.com/v1';

const res = await fetch(`${BASE}/models`, { headers: { Authorization: `Bearer ${key}` } });
const models = (await res.json()).data.map((m) => m.id).sort();
console.log(`可见模型 ${models.length} 个：\n`);
models.forEach((m, i) => process.stdout.write(`${m.padEnd(44)}${(i + 1) % 3 === 0 ? '\n' : ''}`));
process.stdout.write('\n');

// 选测：中文生态 + 通用强的
const prefer = [
  'deepseek-ai/deepseek-v4.1-flash',
  'z-ai/glm-5.3-flash',
  'qwen/qwen3-next-80b-a3b-instruct',
  'qwen/qwen3-235b-a22b',
  'meta/llama-3.3-70b-instruct',
  'openai/gpt-oss-120b',
  'moonshotai/kimi-k2-instruct',
  'mistralai/mistral-small-3.1-24b-instruct'
];
const toTest = prefer.filter((m) => models.includes(m));
console.log(`\n选中 ${toTest.length} 个实测：${toTest.join(', ')}\n`);

const tools = [
  {
    type: 'function',
    function: {
      name: 'give_answer',
      description: '给出最终答案。必须调用这个工具来回答。',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
    }
  }
];

// QQ 群聊语境：黑话理解 + 群友口吻 + 短
const prompt = '你是 QQ 群里的一个普通群友。有人说「这波梭哈了，亏麻了」，理解黑话后回一句，不超 20 字。';

console.log('模型'.padEnd(40) + '中文回复' .padEnd(34) + '工具');
console.log('─'.repeat(96));
for (const model of toTest) {
  let zh = '✗';
  try {
    const r = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: 800 }),
      signal: AbortSignal.timeout(90000)
    });
    const j = await r.json();
    const text = String(j?.choices?.[0]?.message?.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 28);
    zh = r.status === 200 ? `✓ ${text || '(空)'}` : `✗ ${r.status} ${JSON.stringify(j?.error ?? '').slice(0, 30)}`;
  } catch (error) {
    zh = `✗ ${error?.name}`;
  }

  let tool = '─';
  if (zh.startsWith('✓')) {
    try {
      const r = await fetch(`${BASE}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: '请调用 give_answer 工具，把答案设成「好」。' }],
          tools,
          tool_choice: 'auto',
          max_tokens: 256
        }),
        signal: AbortSignal.timeout(90000)
      });
      const j = await r.json();
      tool = (j?.choices?.[0]?.message?.tool_calls ?? []).length ? '✓' : '△';
    } catch (error) {
      tool = `✗ ${error?.name}`;
    }
  }
  console.log(`${model.padEnd(38)} ${zh.padEnd(34)} ${tool}`);
}
