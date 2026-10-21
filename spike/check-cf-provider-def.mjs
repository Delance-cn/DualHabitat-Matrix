// 查 OpenCode 用的 cloudflare-workers-ai provider 定义：
// baseURL / npm 适配器 / 模型标记。目的是判断那个
// "Invalid cloudflare-workers-ai stream event" 有没有配置层的修法。
const res = await fetch('https://models.dev/api.json');
const all = await res.json();

const keys = Object.keys(all).filter((k) => k.includes('cloudflare'));
console.log('带 cloudflare 的 provider key:', keys.join(', '));

const cf = all['cloudflare-workers-ai'];
if (!cf) {
  console.log('没有 cloudflare-workers-ai');
} else {
  console.log('\n=== provider 定义 ===');
  console.log(
    JSON.stringify(
      { id: cf.id, name: cf.name, npm: cf.npm, api: cf.api, env: cf.env, doc: cf.doc },
      null,
      2
    )
  );
  const ids = Object.keys(cf.models ?? {});
  console.log(`\n=== 模型数 ${ids.length} ===`);

  const probe = [
    '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    '@cf/meta/llama-3.1-8b-instruct-fp8',
    '@cf/openai/gpt-oss-120b',
    '@cf/zai-org/glm-4.7-flash'
  ];
  for (const id of probe) {
    console.log(`\n--- ${id} ---`);
    console.log(JSON.stringify(cf.models?.[id] ?? '(目录里没有这个模型)', null, 2));
  }

  // 对比：另一个已知能跑的 provider（openrouter）的适配器
  console.log('\n=== 对比：openrouter / huggingface 的适配器 ===');
  for (const k of ['openrouter', 'huggingface', 'cloudflare-workers-ai']) {
    const p = all[k];
    if (p) console.log(`  ${k.padEnd(24)} npm=${p.npm ?? '(无)'}  api=${p.api ?? '(无)'}`);
  }
}
