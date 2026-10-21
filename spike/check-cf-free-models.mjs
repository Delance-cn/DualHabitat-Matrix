// Workers AI 免费套餐到底能用哪些模型、工具调用到底行不行。
//
// 背景：`@cf/deepseek-ai/deepseek-v4-flash-0731` 报
//   "not available on the Workers Free plan"
// —— 是**模型限制**不是额度限制。所以候选链不能凭 models.dev 的目录盲选。
//
// 这个脚本对每个候选模型做两件事：
//   1. 普通对话：能不能用（免费套餐是否开放）
//   2. 带 tools 的参数：会不会真的吐出 tool_calls（桥接要靠工具，这条是硬指标）
import fs from 'node:fs';

const secrets = JSON.parse(fs.readFileSync(new URL('../secrets.json', import.meta.url), 'utf8'));
const token = secrets.CLOUDFLARE_API_KEY ?? secrets.CLOUDFLARE_API_TOKEN;
const accountId = secrets.CLOUDFLARE_ACCOUNT_ID;
const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`;

// 从 OpenCode 目录里挑 tools=y 的（目录说支持 ≠ 真能用，所以都要实测）
const models = [
  '@cf/zai-org/glm-5.3-flash',
  '@cf/zai-org/glm-5.3',
  '@cf/zai-org/glm-5.2',
  '@cf/zai-org/glm-4.7-flash',
  '@cf/deepseek-ai/deepseek-v4-pro-0813',
  '@cf/deepseek-ai/deepseek-v4-flash-0731',
  '@cf/moonshotai/kimi-k2.7-code',
  '@cf/moonshotai/kimi-k2.6',
  '@cf/google/gemma-4-26b-a4b-it',
  '@cf/nvidia/nemotron-3-120b-a12b',
  '@cf/openai/gpt-oss-120b',
  '@cf/openai/gpt-oss-20b',
  '@cf/qwen/qwen3.8-27b',
  '@cf/qwen/qwen3-30b-a3b-fp8',
  '@cf/meta/llama-4-scout-17b-16e-instruct',
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  '@cf/mistralai/mistral-small-3.1-24b-instruct',
  '@cf/ibm-granite/granite-4.0-h-micro',
  '@cf/meta/llama-3.1-8b-instruct-fp8',
  '@cf/meta/llama-3.2-3b-instruct'
];

const tools = [
  {
    type: 'function',
    function: {
      name: 'give_answer',
      description: '给出最终答案。必须调用这个工具来回答。',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: '答案文本' } },
        required: ['text']
      }
    }
  }
];

const ask = async (model, withTools) => {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'user',
            content: withTools ? '请调用 give_answer 工具，把答案设成「好」。' : '只回一个字：好'
          }
        ],
        ...(withTools ? { tools, tool_choice: 'auto' } : {}),
        max_tokens: withTools ? 128 : 8
      }),
      signal: AbortSignal.timeout(45000)
    });
    const text = await res.text();
    const ms = Date.now() - started;
    let toolCalled = false;
    let content = '';
    try {
      const json = JSON.parse(text);
      const msg = json?.choices?.[0]?.message;
      toolCalled = Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0;
      content = String(msg?.content ?? '');
      if (json?.errors) return { ok: false, ms, note: JSON.stringify(json.errors).slice(0, 130) };
    } catch {
      return { ok: false, ms, note: text.slice(0, 130) };
    }
    return { ok: res.status === 200, ms, toolCalled, content: content.slice(0, 40), status: res.status };
  } catch (error) {
    return { ok: false, ms: Date.now() - started, note: `${error?.name}: ${error?.message}`.slice(0, 130) };
  }
};

console.log('模型'.padEnd(48) + '对话          工具调用        延迟');
console.log('─'.repeat(88));
const usable = [];
for (const model of models) {
  const plain = await ask(model, false);
  const tool = plain.ok ? await ask(model, true) : { ok: false, note: '(跳过)' };
  const plainCell = plain.ok ? `✓ ${String(plain.ms).padStart(5)}ms` : `✗ ${(plain.note ?? '').slice(0, 30)}`;
  const toolCell = tool.ok ? (tool.toolCalled ? '✓ 真调用了' : '△ 没用工具') : '─';
  console.log(`${model.replace('@cf/', '').padEnd(46)} ${plainCell.padEnd(14)} ${toolCell.padEnd(14)}`);
  if (plain.ok && tool.ok && tool.toolCalled) usable.push(model);
}

console.log('\n' + '═'.repeat(88));
console.log(`免费套餐里【能用 + 工具调用正常】的 ${usable.length} 个：`);
for (const m of usable) console.log(`  ✓ ${m}`);
if (!usable.length) console.log('  （一个都没有）');
