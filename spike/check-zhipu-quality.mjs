// 智谱免费模型：工具调用 + 中文质量 + 免代理可达性。
//
// 为什么特意不挂代理：如果 open.bigmodel.cn 直连就通，免费链就不必依赖 Clash，
// 少一个"代理关了整套挂掉"的失败模式。
import fs from 'node:fs';

const key = JSON.parse(fs.readFileSync(new URL('../secrets.json', import.meta.url), 'utf8')).ZHIPU_API_KEY
  ?? '6877362fa2154f2bbfe577a0ea8c0dc1.7GrRd8Dmedp4WbSy';
const auth = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
const BASE = 'https://open.bigmodel.cn/api/paas/v4';

console.log('代理环境:', process.env.HTTPS_PROXY ? `有 (${process.env.HTTPS_PROXY})` : '无（直连）');

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

const prompt = '你是 QQ 群里的一个普通群友。有人说「这波梭哈了，亏麻了」，理解黑话后回一句，不超 20 字。';
const models = ['glm-4-flash', 'glm-4.5-flash', 'glm-4.5-air', 'glm-z1-flash'];

console.log('\n模型'.padEnd(20) + '延迟      中文回复'.padEnd(34) + '工具');
console.log('─'.repeat(88));
for (const model of models) {
  const t0 = Date.now();
  let zh = '✗';
  try {
    const r = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: 800, temperature: 0.8 }),
      signal: AbortSignal.timeout(60000)
    });
    const j = await r.json();
    const text = String(j?.choices?.[0]?.message?.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 26);
    zh = r.status === 200 ? `✓ ${text || '(空)'}` : `✗ ${j?.error?.code} ${String(j?.error?.message ?? '').slice(0, 40)}`;
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
          max_tokens: 512
        }),
        signal: AbortSignal.timeout(60000)
      });
      const j = await r.json();
      tool = (j?.choices?.[0]?.message?.tool_calls ?? []).length ? '✓ 真调用了' : '△ 没用工具';
    } catch (error) {
      tool = `✗ ${error?.name}`;
    }
  }
  console.log(`${model.padEnd(18)} ${String(ms + 'ms').padStart(7)}  ${zh.padEnd(30)} ${tool}`);
}
