// 验证智谱/GLM 这把 key：走哪个域名、有没有免费模型。
//
// 智谱有两套入口：
//   国内  open.bigmodel.cn
//   国际  api.z.ai
// key 格式 <32hex>.<16chars>，两边不一定通用，所以要分别试。
//
// 重点验证"免费额度"：GLM 的 flash 系列一向是免费的（glm-4-flash / glm-4.5-flash ...），
// 对 QQ 群聊场景（中文 + 高频短回复）是最合适的免费落点。
import fs from 'node:fs';

const key = JSON.parse(fs.readFileSync(new URL('../secrets.json', import.meta.url), 'utf8')).ZHIPU_API_KEY
  ?? '6877362fa2154f2bbfe577a0ea8c0dc1.7GrRd8Dmedp4WbSy';
const auth = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };

// ── 1. models.dev 里的 provider 定义 ─────────────────────────────────────
console.log('═══ models.dev 里的智谱相关 provider ═══');
try {
  const all = await (await fetch('https://models.dev/api.json')).json();
  for (const [id, v] of Object.entries(all)) {
    if (/zhipu|z-?ai\b|glm/i.test(id) || /zhipu|z\.ai|bigmodel/i.test(v?.name ?? '')) {
      console.log(`  ${id.padEnd(20)} npm=${v.npm}  api=${v.api}`);
      console.log(`  ${''.padEnd(20)} env=${JSON.stringify(v.env)}  模型数=${Object.keys(v.models ?? {}).length}`);
      const freeish = Object.entries(v.models ?? {})
        .filter(([mid]) => /flash/i.test(mid))
        .map(([mid]) => mid);
      if (freeish.length) console.log(`  ${''.padEnd(20)} flash 系列: ${freeish.join(', ')}`);
    }
  }
} catch (error) {
  console.log('  失败:', error?.message ?? error);
}

// ── 2. 两个入口各试一次 ─────────────────────────────────────────────────
const endpoints = [
  { name: '国内 open.bigmodel.cn', base: 'https://open.bigmodel.cn/api/paas/v4' },
  { name: '国际 api.z.ai', base: 'https://api.z.ai/api/paas/v4' }
];

const testModels = [
  'glm-4-flash',
  'glm-4.5-flash',
  'glm-4.6-flash',
  'glm-z1-flash',
  'glm-4v-flash',
  'glm-4.5-air',
  'glm-4.6',
  'glm-5.3-flash'
];

for (const ep of endpoints) {
  console.log(`\n═══ ${ep.name}  (${ep.base}) ═══`);
  for (const model of testModels) {
    try {
      const res = await fetch(`${ep.base}/chat/completions`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ model, messages: [{ role: 'user', content: '只回一个字：好' }], max_tokens: 32 }),
        signal: AbortSignal.timeout(30000)
      });
      const text = await res.text();
      let note = text.slice(0, 120).replace(/\s+/g, ' ');
      try {
        const j = JSON.parse(text);
        if (res.status === 200) note = `✓ "${String(j.choices?.[0]?.message?.content ?? '').trim().slice(0, 14)}"`;
        else note = `✗ ${j?.error?.code ?? res.status} ${String(j?.error?.message ?? '').slice(0, 60)}`;
      } catch {}
      console.log(`  ${model.padEnd(16)} ${note}`);
    } catch (error) {
      console.log(`  ${model.padEnd(16)} ✗ ${error?.name}`);
    }
  }
}
