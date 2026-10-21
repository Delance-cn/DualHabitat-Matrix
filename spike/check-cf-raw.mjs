// 看这两个模型的原始返回：正文为空可能是"推理模型把内容放在别的字段"，
// 这直接决定 QQ 侧能不能拿到要发出去的文本。
import fs from 'node:fs';

const secrets = JSON.parse(fs.readFileSync(new URL('../secrets.json', import.meta.url), 'utf8'));
const token = secrets.CLOUDFLARE_API_KEY ?? secrets.CLOUDFLARE_API_TOKEN;
const url = `https://api.cloudflare.com/client/v4/accounts/${secrets.CLOUDFLARE_ACCOUNT_ID}/ai/v1/chat/completions`;

const models = process.env.CF_RAW_MODELS
  ? process.env.CF_RAW_MODELS.split(',')
  : ['@cf/zai-org/glm-4.7-flash', '@cf/openai/gpt-oss-120b'];

for (const model of models) {
  console.log(`\n══════ ${model} ══════`);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: '用中文回一句：这波梭哈了，亏麻了' }],
        max_tokens: 200
      }),
      signal: AbortSignal.timeout(90000)
    });
    const json = await res.json();
    console.log('status:', res.status);
    const choice = json?.choices?.[0];
    // 把 message 里的每个字段单独列出来，看正文藏在哪
    const msg = choice?.message ?? {};
    for (const [k, v] of Object.entries(msg)) {
      const shown = typeof v === 'string' ? v : JSON.stringify(v);
      if (shown && shown !== 'null') console.log(`  message.${k} = ${String(shown).slice(0, 300)}`);
    }
    if (!Object.keys(msg).length) console.log('  原始:', JSON.stringify(json).slice(0, 600));
  } catch (error) {
    console.log('  失败:', error?.message ?? error);
  }
}
