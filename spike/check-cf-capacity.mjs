// 精确取我们选中的 3 个 CF 模型的 Neuron 单价，并折算"每天能聊多少回合"。
// 注意：OpenCode 每回合都要带完整系统提示（实测 input≈6900 token），
// 所以真正决定容量的不是输出而是这个输入基数。
const url =
  'https://raw.githubusercontent.com/cloudflare/cloudflare-docs/production/src/content/docs/workers-ai/platform/pricing.mdx';
const res = await fetch(url);
const md = await res.text();
const lines = md.split('\n');

const targets = [
  '@cf/openai/gpt-oss-120b',
  '@cf/zai-org/glm-4.7-flash',
  '@cf/google/gemma-4-26b-a4b-it',
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  '@cf/meta/llama-3.1-8b-instruct-fp8-fast',
  '@cf/meta/llama-3.2-3b-instruct'
];

const parse = (row) => {
  // 从一行 markdown 表格里抠出 neurons 数值
  const nums = [...row.matchAll(/(\d{3,7})\s*neurons per M input tokens/gi)];
  const outNums = [...row.matchAll(/(\d{3,7})\s*neurons per M output tokens/gi)];
  if (!nums.length) return null;
  return { in: Number(nums[0][1]), out: outNums.length ? Number(outNums[0][1]) : null };
};

const INPUT_BASE = 6900; // 实测：一条普通回合的输入 token（系统提示占了绝大部分）
const OUTPUT = 120; // 假设一条群消息回 120 token

console.log('每天 10,000 Neurons 的免费额度能撑多少条群消息');
console.log('（按每回合输入 ' + INPUT_BASE + ' token + 输出 ' + OUTPUT + ' token 估）\n');
console.log('模型'.padEnd(40) + 'Neurons/M(in)   Neurons/M(out)   每回合 Neurons   每天约');
console.log('─'.repeat(100));

for (const t of targets) {
  const row = lines.find((l) => l.includes(t) && /neurons per M/i.test(l));
  if (!row) {
    console.log(`${t.replace('@cf/', '').padEnd(38)} (定价表里没有 → 可能已下架或需付费)`);
    continue;
  }
  const p = parse(row);
  if (!p) {
    console.log(`${t.replace('@cf/', '').padEnd(38)} (解析失败)`);
    continue;
  }
  const perTurn = (INPUT_BASE / 1e6) * p.in + (OUTPUT / 1e6) * (p.out ?? p.in);
  const perDay = Math.floor(10000 / perTurn);
  console.log(
    `${t.replace('@cf/', '').padEnd(38)} ${String(p.in).padStart(8)}      ${String(p.out ?? '?').padStart(8)}      ${perTurn.toFixed(0).padStart(6)} Neurons   ~${perDay} 条`
  );
}
