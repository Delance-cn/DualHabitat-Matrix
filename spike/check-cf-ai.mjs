// Workers AI 真机验证：先查这个账号能用哪些模型，再逐个真跑一次推理。
//
// 端点用 OpenAI 兼容的那条：
//   /client/v4/accounts/<account_id>/ai/v1/chat/completions
// 模型名（不是 OpenCode 目录里的名字）形如 `@cf/meta/llama-3.1-8b-instruct`。
import fs from 'node:fs';

const secrets = JSON.parse(fs.readFileSync(new URL('../secrets.json', import.meta.url), 'utf8'));
const token = secrets.CLOUDFLARE_API_KEY ?? secrets.CLOUDFLARE_API_TOKEN;
const accountId = process.env.CF_ACCOUNT_ID || secrets.CLOUDFLARE_ACCOUNT_ID;
if (!token || !accountId) {
  console.error('缺 token 或 account id（secrets.json）');
  process.exit(1);
}
console.log(`account=${accountId}  token=${String(token).slice(0, 10)}…`);

const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}`;
const auth = { Authorization: `Bearer ${token}` };

// ── 1. 这个账号能用哪些模型 ───────────────────────────────────────────────
let models = [];
try {
  const res = await fetch(`${base}/ai/models/search?per_page=100`, { headers: auth });
  const text = await res.text();
  console.log(`\n=== 模型搜索 === status=${res.status}`);
  const parsed = JSON.parse(text);
  if (Array.isArray(parsed?.result)) {
    models = parsed.result.map((m) => m.name ?? m.id).filter(Boolean);
    console.log(`  共 ${models.length} 个，文本生成相关：`);
    for (const m of models.filter((n) => /instruct|chat|llama|qwen|gemma|mistral|deepseek|glm|kimi/i.test(n)).slice(0, 25)) {
      console.log(`    ${m}`);
    }
  } else {
    console.log('  ', text.slice(0, 400));
  }
} catch (error) {
  console.log('  模型搜索失败:', error?.message ?? error);
}

// ── 2. 真跑推理 ───────────────────────────────────────────────────────────
const candidates = [
  ...models.filter((m) => /instruct|chat/i.test(m)).slice(0, 4),
  '@cf/meta/llama-3.1-8b-instruct',
  '@cf/qwen/qwen2.5-coder-32b-instruct'
];

console.log('\n=== 推理测试 ===');
let okCount = 0;
for (const model of [...new Set(candidates)].slice(0, 5)) {
  try {
    const res = await fetch(`${base}/ai/v1/chat/completions`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: '只回一个字：好' }],
        max_tokens: 8
      })
    });
    const text = await res.text();
    if (res.status === 200) okCount += 1;
    console.log(`  ${model}\n    status=${res.status}  ${text.slice(0, 220)}`);
  } catch (error) {
    console.log(`  ${model}\n    请求失败: ${error?.message ?? error}`);
  }
}
console.log(`\n结论：${okCount > 0 ? `✅ 有 ${okCount} 个模型可用` : '❌ 没有模型可用'}`);
