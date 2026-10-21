// GLM-4.5 系列可以关掉思维链（thinking.type=disabled）。
// 群聊要的是"秒回一句人话"，不是深度推理 —— 关掉后延迟和工具调用是否还正常，直接决定免费链的首选。
import fs from 'node:fs';

const key = JSON.parse(fs.readFileSync(new URL('../secrets.json', import.meta.url), 'utf8')).ZHIPU_API_KEY
  ?? '6877362fa2154f2bbfe577a0ea8c0dc1.7GrRd8Dmedp4WbSy';
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

const ask = async (model, extra, withTools, prompt) => {
  const t0 = Date.now();
  try {
    const r = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 512,
        temperature: 0.8,
        ...(withTools ? { tools, tool_choice: 'auto' } : {}),
        ...extra
      }),
      signal: AbortSignal.timeout(60000)
    });
    const j = await r.json();
    const ms = Date.now() - t0;
    if (r.status !== 200) return { ms, note: `✗ ${j?.error?.code} ${String(j?.error?.message ?? '').slice(0, 40)}` };
    const msg = j.choices?.[0]?.message ?? {};
    return {
      ms,
      text: String(msg.content ?? '').replace(/\s+/g, ' ').trim(),
      called: (msg.tool_calls ?? []).length > 0
    };
  } catch (error) {
    return { ms: Date.now() - t0, note: `✗ ${error?.name}` };
  }
};

const zhPrompt = '你是 QQ 群里的一个普通群友。有人说「这波梭哈了，亏麻了」，理解黑话后回一句，不超 20 字。';
const toolPrompt = '请调用 give_answer 工具，把答案设成「好」。';

const cases = [
  ['glm-4.5-flash', {}, '默认（带思维链）'],
  ['glm-4.5-flash', { thinking: { type: 'disabled' } }, '关掉思维链'],
  ['glm-4.5-air', {}, '默认'],
  ['glm-4.5-air', { thinking: { type: 'disabled' } }, '关掉思维链'],
  ['glm-4-flash', {}, '默认（本来就无思维链）']
];

console.log('配置'.padEnd(26) + '中文（延迟/回复）'.padEnd(46) + '工具');
console.log('─'.repeat(96));
for (const [model, extra, label] of cases) {
  const zh = await ask(model, extra, false, zhPrompt);
  const tool = zh.note ? '─' : (await ask(model, extra, true, toolPrompt)).called ? '✓' : '△';
  const zhCell = zh.note ?? `✓ ${zh.ms}ms  ${zh.text.slice(0, 22)}`;
  console.log(`${(model + ' / ' + label).padEnd(24)} ${zhCell.padEnd(44)} ${tool}`);
}
