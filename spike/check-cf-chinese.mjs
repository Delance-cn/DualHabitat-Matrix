// 免费套餐里那 11 个模型的中文能力实测 —— QQ 场景要处理中文与网络黑话，
// 这项比跑分重要。
import fs from 'node:fs';

const secrets = JSON.parse(fs.readFileSync(new URL('../secrets.json', import.meta.url), 'utf8'));
const token = secrets.CLOUDFLARE_API_KEY ?? secrets.CLOUDFLARE_API_TOKEN;
const url = `https://api.cloudflare.com/client/v4/accounts/${secrets.CLOUDFLARE_ACCOUNT_ID}/ai/v1/chat/completions`;

// 按"快且免费可用"筛出来的候选（掉队的 qwen3.8-27b 25 秒、nemotron 6.6 秒已排除）
const models = [
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  '@cf/zai-org/glm-4.7-flash',
  '@cf/openai/gpt-oss-120b',
  '@cf/meta/llama-4-scout-17b-16e-instruct',
  '@cf/mistralai/mistral-small-3.1-24b-instruct',
  '@cf/meta/llama-3.1-8b-instruct-fp8'
];

// 用真实群聊语境考它：黑话理解 + 简短口语化回复（QQ 上不能长篇大论）
const prompt = [
  '你是 QQ 群里的一个普通群友。群里有人发了一句：「这波梭哈了，亏麻了」。',
  '请理解「梭哈」「亏麻了」这两句黑话，然后用群友的口吻回一句，不超过 20 个字。'
].join('\n');

console.log('模型'.padEnd(46) + '延迟      回复');
console.log('─'.repeat(96));
for (const model of models) {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: 200 }),
      signal: AbortSignal.timeout(60000)
    });
    const json = await res.json();
    const ms = Date.now() - started;
    const msg = json?.choices?.[0]?.message?.content;
    const text = String(msg ?? JSON.stringify(json?.errors ?? json)).replace(/\s+/g, ' ').slice(0, 60);
    console.log(`${model.replace('@cf/', '').padEnd(44)} ${String(ms + 'ms').padStart(7)}  ${text}`);
  } catch (error) {
    console.log(`${model.replace('@cf/', '').padEnd(44)} ${'失败'.padStart(7)}  ${error?.message ?? error}`);
  }
}
