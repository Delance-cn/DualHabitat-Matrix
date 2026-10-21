// 诊断 Cloudflare Workers AI token：验证有效性、列出账号、真跑一次推理。
//
// Workers AI 比别家多一个要求：除了 token 还要 **account id**
// （端点长这样 /client/v4/accounts/<account_id>/ai/v1/chat/completions）。
// 所以这里顺带把 account id 也查出来，好写进 secrets.json。
//
// token 从环境变量 CF_TOKEN_CHECK 取（避免写进命令行历史），
// 没有则回落到 secrets.json 的 CLOUDFLARE_API_TOKEN。
import fs from 'node:fs';

const secrets = JSON.parse(fs.readFileSync(new URL('../secrets.json', import.meta.url), 'utf8'));
const token = process.env.CF_TOKEN_CHECK || secrets.CLOUDFLARE_API_TOKEN;
if (!token) {
  console.error('没有 token：设 CF_TOKEN_CHECK 或写进 secrets.json 的 CLOUDFLARE_API_TOKEN');
  process.exit(1);
}
console.log(`token 前缀: ${token.slice(0, 10)}…  长度=${token.length}`);

const call = async (label, url, init = {}) => {
  try {
    const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
    const text = await res.text();
    return { label, status: res.status, text };
  } catch (error) {
    return { label, status: 0, text: `请求失败: ${error?.message ?? error}` };
  }
};

// 1. token 本身是否有效
const verify = await call('token/verify', 'https://api.cloudflare.com/client/v4/user/tokens/verify');
console.log(`\n=== 1. token 验证 === status=${verify.status}`);
console.log(verify.text.slice(0, 700));

// 2. 这个 token 能看到哪些账号（拿 account id）
const accounts = await call('accounts', 'https://api.cloudflare.com/client/v4/accounts');
console.log(`\n=== 2. 账号列表 === status=${accounts.status}`);
let accountId = secrets.CLOUDFLARE_ACCOUNT_ID ?? null;
try {
  const parsed = JSON.parse(accounts.text);
  if (parsed?.result?.length) {
    for (const a of parsed.result) console.log(`  id=${a.id}  name=${a.name}`);
    accountId = parsed.result[0].id;
  } else {
    console.log('  没有可见账号：', accounts.text.slice(0, 300));
  }
} catch {
  console.log('  ', accounts.text.slice(0, 300));
}

// 3. 真跑一次 Workers AI（OpenAI 兼容端点）
if (accountId) {
  console.log(`\n=== 3. Workers AI 推理（account=${accountId}）===`);
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`;
  for (const model of ['@cf/meta/llama-3.1-8b-instruct', '@cf/qwen/qwen2.5-coder-32b-instruct']) {
    const res = await call(`chat/${model}`, url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: '只回一个字：好' }], max_tokens: 8 })
    });
    console.log(`  ${model} → status=${res.status}`);
    console.log(`    ${res.text.slice(0, 300)}`);
  }
  console.log(`\n记得把 accountId 写进 secrets.json：CLOUDFLARE_ACCOUNT_ID=${accountId}`);
} else {
  console.log('\n（拿不到 account id，无法测推理）');
}
