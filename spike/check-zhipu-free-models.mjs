// 目录里 cost=0 的其它智谱模型（glm-4.7-flash / glm-4.6v-flash）在这把 key 上到底能不能白嫖。
// 能的话 glm-4.7-flash（200k 上下文）比 glm-4.5-flash（131k）更划算。
import fs from 'node:fs';

const key = JSON.parse(fs.readFileSync(new URL('../secrets.json', import.meta.url), 'utf8')).ZHIPU_API_KEY;
const auth = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
const BASE = 'https://open.bigmodel.cn/api/paas/v4';

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

const cases = [
  'glm-4.7-flash',
  'glm-4.6v-flash',
  'glm-4.5-flash',
  'glm-4-flash'
];

const zhPrompt = '你是 QQ 群里的一个普通群友。有人说「这波梭哈了，亏麻了」，理解黑话后回一句，不超 20 字。';

console.log('模型'.padEnd(18) + '延迟      中文回复'.padEnd(34) + '工具');
console.log('─'.repeat(84));
for (const model of cases) {
  const t0 = Date.now();
  let zh = '✗';
  try {
    const r = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: zhPrompt }],
        max_tokens: 512,
        temperature: 0.8,
        thinking: { type: 'disabled' }
      }),
      signal: AbortSignal.timeout(60000)
    });
    const j = await r.json();
    zh = r.status === 200
      ? `✓ ${String(j.choices?.[0]?.message?.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 22)}`
      : `✗ ${j?.error?.code} ${String(j?.error?.message ?? '').slice(0, 40)}`;
  } catch (error) {
    zh = `✗ ${error?.name}`;
  }
  const ms = Date.now() - t0;

  let tool = '─';
  if (zh.startsWith('✓')) {
    try {
      const r = await fetch(`${BASE}/chat/completions`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: '请调用 give_answer 工具，把答案设成「好」。' }],
          tools,
          tool_choice: 'auto',
          max_tokens: 256,
          thinking: { type: 'disabled' }
        }),
        signal: AbortSignal.timeout(60000)
      });
      const j = await r.json();
      tool = (j?.choices?.[0]?.message?.tool_calls ?? []).length ? '✓' : '△';
    } catch (error) {
      tool = `✗ ${error?.name}`;
    }
  }
  console.log(`${model.padEnd(16)} ${String(ms + 'ms').padStart(7)}  ${zh.padEnd(30)} ${tool}`);
}
