// 模型链的离线测试：分类规则 + 顺序选择 + 熔断/冷却 + 付费闸门 + 持久化。
//
// 分类规则全部用**本机真实抓到的错误原文**，不用编造的样例 —— 这些字符串
// 是这套熔断逻辑唯一的事实来源，写错了就会"该换的不换、不该换的乱换"。
import {
  KIND,
  ModelChain,
  candidateKey,
  classifyFailure,
  failureText,
  parseCandidate
} from '../src/model-chain.js';

let pass = 0;
let fail = 0;
const ok = (name, condition, extra = '') => {
  if (condition) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${extra ? `  ← ${extra}` : ''}`);
  }
};

// ── 1. 分类规则（原文来自本机实测）────────────────────────────────────────
console.log('\n=== 1. 失败分类（真实错误原文）===');
const cases = [
  // [描述, 错误, 期望 kind, 期望 fatal]
  ['智谱 余额不足', '{"error":{"code":"1113","message":"余额不足或无可用资源包,请充值。"}}', KIND.QUOTA, true],
  ['智谱 访问量过大', '{"error":{"code":"1305","message":"该模型当前访问量过大，请您稍后再试"}}', KIND.RATE, true],
  ['智谱 无权访问', '{"error":{"code":"1220","message":"您无权访问glm-4.6-flash。"}}', KIND.UNAVAILABLE, true],
  ['HF 额度耗尽', '{"type":"provider.quota","message":"You have no remaining credits. Purchase pre-paid credits to continue using Inference Providers."}', KIND.QUOTA, true],
  ['CF 免费套餐不开放', 'AiError: Model @cf/deepseek-ai/deepseek-v4-flash-0731 is not available on the Workers Free plan.', KIND.UNAVAILABLE, true],
  ['CF 流格式不兼容', 'AiError: Invalid cloudflare-workers-ai/cloudflare-workers-ai stream event', KIND.UNAVAILABLE, true],
  ['CF 拒收 content=null', "AiError: Bad input: Error: oneOf at '/' not met, 0 matches: Type mismatch of '/messages/4/content', 'string' not in 'null'", KIND.UNAVAILABLE, true],
  ['OpenRouter 402', '{"error":{"code":402,"message":"Insufficient credits"}}', KIND.QUOTA, true],
  ['OpenRouter 429', '{"error":{"code":429,"message":"Rate limit exceeded, too many requests"}}', KIND.RATE, true],
  ['密钥无效', 'AiError: provider.auth Unauthorized: invalid api key', KIND.AUTH, true],
  // 不该熔断的
  ['工具权限被我们自己拒掉', '{"type":"permission.rejected","message":"Permission denied: shell"}', KIND.OTHER, false],
  ['网络抖动', 'Error: read ECONNRESET', KIND.OTHER, false],
  // 连不上 ≠ 抖动：代理挂了 / DNS 投毒是 provider 级的"这条路走不通"，该换。
  // （本机实测原文，代理关掉后所有 provider 一起连不上就是这个长相）
  ['代理挂了/端口拒绝', 'ConnectionRefused: Unable to connect. Is the computer able to access the url?', KIND.UNREACHABLE, true],
  ['DNS 投毒', 'TypeError: fetch failed\n  cause: Error: getaddrinfo ENOTFOUND huggingface.co', KIND.UNREACHABLE, true],
  // provider 返回的东西 OpenCode 解析不了 —— 这正是 CF 那批模型的症状，
  // 换掉比留着每轮都失败强，所以按"模型不可用"熔断。
  ['provider 输出无法解析', '{"type":"provider.invalid-output","message":"model returned malformed JSON content"}', KIND.UNAVAILABLE, true]
];
for (const [label, input, wantKind, wantFatal] of cases) {
  const got = classifyFailure(input);
  ok(
    `${label} → ${wantKind}${wantFatal ? '(熔断)' : '(不熔断)'}`,
    got.kind === wantKind && got.fatal === wantFatal,
    `实得 ${got.kind} fatal=${got.fatal}`
  );
}

// 嵌套壳（OpenCode 那种 {message, response:{body:"..."}}）也要能挖出来
const nested = {
  message: 'Invalid cloudflare-workers-ai stream event',
  response: { status: 200, body: '{"errors":[{"message":"Model @cf/x is not available on the Workers Free plan."}]}' }
};
ok('嵌套错误体也能挖出关键字', classifyFailure(nested).kind === KIND.UNAVAILABLE, failureText(nested).slice(0, 80));

// ── 2. 候选写法解析 ──────────────────────────────────────────────────────
console.log('\n=== 2. 候选写法解析 ===');
const p1 = parseCandidate('zhipuai/glm-4.5-flash');
ok('普通写法', p1.providerID === 'zhipuai' && p1.id === 'glm-4.5-flash' && p1.variant === null);
const p2 = parseCandidate('zhipuai/glm-4.5-flash#none');
ok('带变体', p2.providerID === 'zhipuai' && p2.id === 'glm-4.5-flash' && p2.variant === 'none');
const p3 = parseCandidate('cloudflare-workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast');
ok('模型 id 自带斜杠（CF）', p3.providerID === 'cloudflare-workers-ai' && p3.id === '@cf/meta/llama-3.3-70b-instruct-fp8-fast');
ok('key 含变体', candidateKey(p2) === 'zhipuai/glm-4.5-flash#none');

// ── 3. 顺序选择 + 熔断切换 ────────────────────────────────────────────────
console.log('\n=== 3. 顺序选择与熔断 ===');
let clock = 1_000_000;
const chain = new ModelChain({
  free: ['zhipuai/glm-4.5-flash#none', 'cloudflare-workers-ai/@cf/zai-org/glm-4.7-flash', 'openrouter/openrouter/free'],
  paid: ['zhipuai/glm-4.6', 'openrouter/anthropic/claude-sonnet-4'],
  allowPaid: false,
  now: () => clock
});

ok('首选是第一个免费模型', candidateKey(chain.pick()) === 'zhipuai/glm-4.5-flash#none');
ok('付费关着时付费档不在列表里', chain.active.length === 3 && chain.active.every((c) => c.tier === 'free'));

// 首选额度耗尽 → 换下一个
chain.markFailure(chain.pick(), classifyFailure('1113 余额不足'));
ok('额度耗尽后换到第二个', candidateKey(chain.pick()) === 'cloudflare-workers-ai/@cf/zai-org/glm-4.7-flash');
ok('被熔断的不再被选中', chain.status()[0].usable === false);

// 第二个限流 → 只冷却 60 秒
chain.markFailure(chain.pick(), classifyFailure('1305 访问量过大'));
ok('限流后换到第三个', candidateKey(chain.pick()) === 'openrouter/openrouter/free');
const rateLeft = chain.status()[1].cooldownMsLeft;
ok('限流只冷却 60 秒', rateLeft === 60_000, `实得 ${rateLeft}`);

// 第三个也耗尽 → 全用完
chain.markFailure(chain.pick(), classifyFailure('{"type":"provider.quota","message":"no remaining credits"}'));
ok('全部用完时 pick() 返回 null', chain.pick() === null);
ok('allExhausted()=true', chain.allExhausted() === true);
ok('usableCount()=0', chain.usableCount() === 0);

// 好模型不熔断：工具权限被拒不该影响链
const chain2 = new ModelChain({ free: ['zhipuai/glm-4.5-flash#none', 'openrouter/openrouter/free'], now: () => clock });
chain2.markFailure(chain2.pick(), classifyFailure('{"type":"permission.rejected","message":"Permission denied: shell"}'));
ok('工具权限被拒不熔断', candidateKey(chain2.pick()) === 'zhipuai/glm-4.5-flash#none');

// ── 4. 冷却到期自动切回 ──────────────────────────────────────────────────
console.log('\n=== 4. 冷却到期自动切回 ===');
const chain3 = new ModelChain({
  free: ['zhipuai/glm-4.5-flash#none', 'openrouter/openrouter/free'],
  now: () => clock
});
chain3.markFailure(chain3.pick(), classifyFailure('1305 访问量过大'));
ok('限流期间用备用', candidateKey(chain3.pick()) === 'openrouter/openrouter/free');
clock += 60_001;
ok('60 秒后自动切回首选', candidateKey(chain3.pick()) === 'zhipuai/glm-4.5-flash#none', candidateKey(chain3.pick()));

// 额度耗尽要等很久
const chain4 = new ModelChain({ free: ['zhipuai/glm-4.5-flash#none', 'openrouter/openrouter/free'], now: () => clock });
chain4.markFailure(chain4.pick(), classifyFailure('1113 余额不足'));
clock += 60_000;
ok('额度耗尽 60 秒后仍不恢复', candidateKey(chain4.pick()) === 'openrouter/openrouter/free');
clock += 6 * 60 * 60 * 1000;
ok('6 小时后恢复（次日额度）', candidateKey(chain4.pick()) === 'zhipuai/glm-4.5-flash#none');

// ── 5. 付费闸门 ──────────────────────────────────────────────────────────
console.log('\n=== 5. 付费闸门 ===');
const chain5 = new ModelChain({
  free: ['zhipuai/glm-4.5-flash#none'],
  paid: ['zhipuai/glm-4.6'],
  allowPaid: false,
  now: () => clock
});
chain5.markFailure(chain5.pick(), classifyFailure('1113 余额不足'));
ok('付费关着时，免费用完就真的没了（不会偷偷花钱）', chain5.pick() === null);
chain5.setAllowPaid(true);
ok('打开开关后自动降级到付费', candidateKey(chain5.pick()) === 'zhipuai/glm-4.6');
chain5.setAllowPaid(false);
ok('再关掉开关立刻回到"没有可用模型"', chain5.pick() === null);

// 付费模型也可能自己失效：付费候选全挂 → null
chain5.setAllowPaid(true);
chain5.markFailure(chain5.pick(), classifyFailure('{"error":{"code":402,"message":"Insufficient credits"}}'));
ok('付费也耗尽 → 真的没了', chain5.pick() === null && chain5.allExhausted() === true);

// ── 6. 持久化 ────────────────────────────────────────────────────────────
console.log('\n=== 6. 持久化（重启后不重复踩坑）===');
const snap = chain5.snapshot();
ok('快照含健康记录', snap.health.length === 2);
const revived = new ModelChain({
  free: ['zhipuai/glm-4.5-flash#none'],
  paid: ['zhipuai/glm-4.6'],
  allowPaid: true,
  now: () => clock,
  health: snap
});
ok('恢复后仍然全不可用', revived.pick() === null);
// 过期的记录应被丢弃，避免状态文件无限膨胀
const farFuture = () => clock + 48 * 60 * 60 * 1000;
const pruned = new ModelChain({
  free: ['zhipuai/glm-4.5-flash#none'],
  paid: ['zhipuai/glm-4.6'],
  allowPaid: true,
  now: farFuture,
  health: snap
});
ok('过期记录被丢弃', pruned.health.size === 0 && candidateKey(pruned.pick()) === 'zhipuai/glm-4.5-flash#none');

// ── 7. retryAfterMs 优先 ─────────────────────────────────────────────────
console.log('\n=== 7. 上游给了 Retry-After 就用它 ===');
const chain6 = new ModelChain({ free: ['zhipuai/glm-4.5-flash#none', 'openrouter/openrouter/free'], now: () => clock });
chain6.markFailure(chain6.pick(), classifyFailure('429 too many requests'), { retryAfterMs: 5_000 });
ok('按上游给的 5 秒冷却', chain6.status()[0].cooldownMsLeft === 5_000, `实得 ${chain6.status()[0].cooldownMsLeft}`);

console.log(`\n${'='.repeat(52)}`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
