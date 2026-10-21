// 查 NVIDIA 在 OpenCode 里的 provider id 与环境变量名。
// NVIDIA 的 key 是 `nvapi-` 前缀，走 build.nvidia.com 的 NIM 接口。
const res = await fetch('https://models.dev/api.json');
const all = await res.json();

const hits = Object.entries(all).filter(
  ([k, v]) => /nvidia|nim/i.test(k) || /nvidia/i.test(v?.name ?? '')
);
console.log('匹配到的 provider：');
for (const [k, v] of hits) {
  console.log(`\n  id      : ${k}`);
  console.log(`  name    : ${v.name}`);
  console.log(`  npm     : ${v.npm}`);
  console.log(`  api     : ${v.api}`);
  console.log(`  需要的环境变量: ${JSON.stringify(v.env)}`);
  console.log(`  模型数  : ${Object.keys(v.models ?? {}).length}`);
  const sample = Object.keys(v.models ?? {}).slice(0, 8);
  if (sample.length) console.log(`  模型样例: ${sample.join(', ')}`);
  // 列几个免费/常用的
  const toolModels = Object.entries(v.models ?? {}).filter(([, m]) => m.tool_call);
  console.log(`  支持工具的模型数: ${toolModels.length}`);
}
if (!hits.length) console.log('  (没有 nvidia 相关 provider)');
