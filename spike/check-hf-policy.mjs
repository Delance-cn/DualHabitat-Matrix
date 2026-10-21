// 核实 HF 的免费额度政策 + 实测哪些模型还能跑。
//
// 起因：账号报 402 "You have no remaining credits"。要分清是
//   (a) 免费额度本来就极少、已经用完；
//   (b) 这个账号根本没拿到免费额度（比如没绑支付方式）；
//   (c) 只是某些贵模型不行、便宜模型照样能跑。
import fs from 'node:fs';

const token = JSON.parse(fs.readFileSync(new URL('../secrets.json', import.meta.url), 'utf8')).HF_TOKEN;

const strip = (html) =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();

// ── 1. 官方定价文档里怎么说免费额度 ──────────────────────────────────────
for (const url of [
  'https://huggingface.co/docs/inference-providers/pricing',
  'https://huggingface.co/pricing',
  'https://huggingface.co/docs/inference-providers/index'
]) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const text = strip(await res.text());
    console.log(`\n===== ${url}  (status=${res.status}) =====`);
    const lines = text.split('\n');
    const hits = lines.filter((l) =>
      /credit|\bfree\b|month|PRO\b|billing|payment|quota|included/i.test(l) && l.length < 400
    );
    for (const l of hits.slice(0, 25)) console.log('  ' + l.trim());
    if (!hits.length) console.log('  (没抓到相关段落)');
  } catch (error) {
    console.log(`\n===== ${url} → 失败: ${error?.message ?? error}`);
  }
}

// ── 2. 实测：便宜/小模型还能不能跑（区分"账户没钱"和"模型太贵"）──────────
console.log('\n\n===== 实测各家模型（含很便宜的小模型）=====');
const models = [
  'meta-llama/Llama-3.2-3B-Instruct',
  'Qwen/Qwen2.5-7B-Instruct',
  'mistralai/Mistral-7B-Instruct-v0.3',
  'HuggingFaceH4/zephyr-7b-beta',
  'deepseek-ai/DeepSeek-V4-Flash',
  'google/gemma-3-4b-it'
];
for (const model of models) {
  try {
    const res = await fetch('https://router.huggingface.co/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 4 })
    });
    const text = await res.text();
    console.log(`  ${model.padEnd(38)} status=${res.status}  ${text.slice(0, 160).replace(/\s+/g, ' ')}`);
  } catch (error) {
    console.log(`  ${model.padEnd(38)} 失败: ${error?.message ?? error}`);
  }
}

// ── 3. 有没有"免费"标记的模型 ────────────────────────────────────────────
console.log('\n===== router 模型目录里带 free 标记的 =====');
try {
  const res = await fetch('https://router.huggingface.co/v1/models', {
    headers: { Authorization: `Bearer ${token}` }
  });
  const json = await res.json();
  const list = Array.isArray(json?.data) ? json.data : [];
  console.log(`  共 ${list.length} 个模型`);
  const freeish = list.filter((m) => JSON.stringify(m).toLowerCase().includes('free'));
  for (const m of freeish.slice(0, 15)) console.log(`   ${m.id}`);
  if (!freeish.length) console.log('  (没有任何模型带 free 标记)');
  const sample = list[0];
  if (sample) console.log('\n  样例条目的结构：\n  ' + JSON.stringify(sample).slice(0, 500));
} catch (error) {
  console.log('  失败:', error?.message ?? error);
}
