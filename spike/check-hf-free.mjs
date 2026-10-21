// 正确回答"HF 有没有免费额度"：
//   1. router 目录里 `is_free: true` 的 provider —— 这些才是真有免费推理的
//   2. 官方定价文档原文（从 GitHub 上的 md 源文件抓，网页是客户端渲染的，抓不到正文）
//   3. 拿 is_free 的模型真跑一次
import fs from 'node:fs';

const token = JSON.parse(fs.readFileSync(new URL('../secrets.json', import.meta.url), 'utf8')).HF_TOKEN;

// ── 1. 定价文档原文 ───────────────────────────────────────────────────────
console.log('===== 官方定价文档原文（GitHub 上的 md 源文件）=====');
const docUrls = [
  'https://raw.githubusercontent.com/huggingface/hub-docs/main/docs/inference-providers/pricing.md',
  'https://raw.githubusercontent.com/huggingface/hub-docs/main/docs/inference-providers/index.md'
];
for (const url of docUrls) {
  try {
    const res = await fetch(url);
    if (res.status !== 200) {
      console.log(`  ${url} → status=${res.status}`);
      continue;
    }
    const md = await res.text();
    console.log(`\n--- ${url.split('/').pop()} (${md.length} 字符) ---`);
    const lines = md.split('\n');
    // 抓和"免费/额度/月"有关的段落，连带前后各一行
    const keep = new Set();
    lines.forEach((l, i) => {
      if (/free|credit|\$|month|PRO|quota|billing/i.test(l)) {
        for (let j = Math.max(0, i - 1); j <= Math.min(lines.length - 1, i + 2); j += 1) keep.add(j);
      }
    });
    [...keep]
      .sort((a, b) => a - b)
      .slice(0, 60)
      .forEach((i) => console.log('  ' + lines[i].slice(0, 200)));
  } catch (error) {
    console.log(`  ${url} → 失败: ${error?.message ?? error}`);
  }
}

// ── 2. 真正免费的模型（is_free === true）────────────────────────────────
console.log('\n\n===== router 目录里 is_free=true 的 provider =====');
let freeModels = [];
try {
  const res = await fetch('https://router.huggingface.co/v1/models', { headers: { Authorization: `Bearer ${token}` } });
  const json = await res.json();
  const list = Array.isArray(json?.data) ? json.data : [];
  console.log(`  router 目录共 ${list.length} 个模型`);
  for (const m of list) {
    const freeProviders = (m.providers ?? []).filter((p) => p.is_free === true);
    if (freeProviders.length) {
      freeModels.push(m.id);
      const names = freeProviders.map((p) => `${p.provider}${p.supports_tools ? '(tools)' : ''}`).join(', ');
      console.log(`  ✓ ${m.id.padEnd(46)} 免费 provider: ${names}`);
    }
  }
  if (!freeModels.length) console.log('  (没有任何 provider 是 is_free)');
} catch (error) {
  console.log('  失败:', error?.message ?? error);
}

// ── 3. 拿免费模型真跑一次 ────────────────────────────────────────────────
if (freeModels.length) {
  console.log('\n===== 实测这些免费模型 =====');
  for (const model of freeModels.slice(0, 5)) {
    try {
      const res = await fetch('https://router.huggingface.co/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: '只回一个字：好' }], max_tokens: 8 })
      });
      const text = await res.text();
      console.log(`  ${model.padEnd(46)} status=${res.status}  ${text.slice(0, 200).replace(/\s+/g, ' ')}`);
    } catch (error) {
      console.log(`  ${model.padEnd(46)} 失败: ${error?.message ?? error}`);
    }
  }
}
