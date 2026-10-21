// 免费套餐每天 10,000 Neurons —— 折算成"能聊多少条"，否则"默认免费"没意义。
// CF 的模型搜索接口里带单价（price 字段，以 Neurons 计）。
import fs from 'node:fs';

const s = JSON.parse(fs.readFileSync(new URL('../secrets.json', import.meta.url), 'utf8'));
const token = s.CLOUDFLARE_API_KEY ?? s.CLOUDFLARE_API_TOKEN;
const account = s.CLOUDFLARE_ACCOUNT_ID;

const res = await fetch(
  `https://api.cloudflare.com/client/v4/accounts/${account}/ai/models/search?per_page=100`,
  { headers: { Authorization: `Bearer ${token}` } }
);
const json = await res.json();
if (!json.success) {
  console.log('搜索失败:', JSON.stringify(json.errors ?? json).slice(0, 300));
} else {
  const targets = [
    '@cf/openai/gpt-oss-120b',
    '@cf/zai-org/glm-4.7-flash',
    '@cf/google/gemma-4-26b-a4b-it'
  ];
  console.log('免费套餐可用且走 OpenCode 正常的 3 个：\n');
  console.log('模型'.padEnd(38) + '单价 (Neurons / 百万 token)     10000 Neurons 约等于');
  console.log('─'.repeat(100));
  for (const m of json.result ?? []) {
    if (!targets.includes(m.name)) continue;
    const p = m.properties?.price ?? [];
    const shown = p.map((x) => `${x.unit}=${x.price}`).join('  ') || '(接口没给价)';
    // 粗算：按输入价折算，10000 Neurons 能过多少 token
    const inPrice = p.find((x) => /input/i.test(x.unit))?.price;
    const approx = inPrice ? `约 ${Math.round(10000 / (inPrice / 1e6) / 1000)}k token 输入` : '—';
    console.log(`${m.name.replace('@cf/', '').padEnd(36)} ${shown.slice(0, 30).padEnd(32)} ${approx}`);
  }
  console.log('\n（免费套餐额度以 Cloudflare 后台为准；这里用官方搜索接口给的单价做量级估算）');
}
