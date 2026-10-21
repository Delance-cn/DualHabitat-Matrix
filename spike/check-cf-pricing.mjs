// 找 Workers AI 的 Neuron 单价 —— 决定免费额度每天实际能撑多少条群消息。
const strip = (html) =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();

const urls = [
  'https://raw.githubusercontent.com/cloudflare/cloudflare-docs/production/src/content/docs/workers-ai/platform/pricing.mdx',
  'https://developers.cloudflare.com/workers-ai/platform/pricing/'
];

for (const url of urls) {
  console.log(`\n═══════ ${url} ═══════`);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    console.log('status:', res.status);
    if (res.status !== 200) continue;
    const body = await res.text();
    const text = url.endsWith('.mdx') ? body : strip(body);
    const lines = text.split('\n');
    const keep = new Set();
    lines.forEach((l, i) => {
      if (/neuron|free allocation|10,000|10000|per million|price|allocation/i.test(l)) {
        for (let j = Math.max(0, i - 1); j <= Math.min(lines.length - 1, i + 2); j++) keep.add(j);
      }
    });
    const picked = [...keep].sort((a, b) => a - b).slice(0, 45);
    for (const i of picked) {
      const l = lines[i].trim();
      if (l) console.log('  ' + l.slice(0, 190));
    }
  } catch (error) {
    console.log('  失败:', error?.message ?? error);
  }
}
