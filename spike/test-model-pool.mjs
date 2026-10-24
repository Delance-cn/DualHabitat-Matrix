// 模型池配置的离线测试。
//
// 这个文件的重点是**配置写错时的行为**：运维手滑（键名拼错、候选写成数字、
// 冷却写成字符串）不应该让机器人静默变傻，而应该告警 + 回退到能跑的状态。
// 其次是解析优先级（显式 > 环境变量 > models.json > 内置默认）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ModelChain } from '../src/model-chain.js';
import {
  DEFAULT_POOL,
  describePool,
  loadModelPool,
  normalizePool,
  poolProviders,
  poolUsesProvider
} from '../src/model-pool.js';

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-pool-'));
const writePool = (name, value) => {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2), 'utf8');
  return file;
};

// ── 1. 保底：没有配置文件也能跑 ───────────────────────────────────────────
console.log('\n=== 1. 没有配置文件时用内置默认池 ===');
{
  const { pool, source, warnings } = loadModelPool({ file: path.join(tmp, '不存在.json'), env: {} });
  ok('来源标注是内置默认值', source.includes('内置默认值'), source);
  ok('默认启用且不花钱', pool.enabled === true && pool.allowPaid === false);
  ok(`用完回的是人话「${pool.exhaustedNotice}」`, pool.exhaustedNotice.length > 0 && !/^\d{3}[A-Z]+$/.test(pool.exhaustedNotice));
  ok(`免费档 4 个候选`, pool.free.length === 4, JSON.stringify(pool.free));
  ok('首选是智谱免费档（实测最划算的那个）', pool.free[0] === 'zhipuai/glm-4.5-flash#none');
  ok('付费档配了但默认关着', pool.paid.length > 0);
  ok('没有告警', warnings.length === 0, JSON.stringify(warnings));
}

// ── 2. models.json 正常覆盖 ───────────────────────────────────────────────
console.log('\n=== 2. models.json 覆盖生效 ===');
{
  const file = writePool('good.json', {
    enabled: true,
    allowPaid: true,
    exhaustedNotice: '没钱了',
    free: ['a/one', 'b/two#none'],
    paid: ['c/three'],
    cooldownMs: { rate: 5000 }
  });
  const { pool, source } = loadModelPool({ file, env: {} });
  ok('来源是那个文件', source === file);
  ok('付费开关被打开', pool.allowPaid === true);
  ok('提示语被改掉', pool.exhaustedNotice === '没钱了');
  ok('免费档按给定顺序', JSON.stringify(pool.free) === JSON.stringify(['a/one', 'b/two#none']));
  ok('付费档被读到', JSON.stringify(pool.paid) === JSON.stringify(['c/three']));
  ok('冷却覆盖生效', pool.cooldownMs.rate === 5000);
}

// ── 3. 写错时的行为：告警 + 回退，而不是静默变傻 ──────────────────────────
console.log('\n=== 3. 配置写错要告警且能跑 ===');
{
  {
    const { pool, warnings } = normalizePool({ fre: ['a/one'] });
    ok('键名拼错被指出来', warnings.some((w) => w.includes('fre')), JSON.stringify(warnings));
    ok('免费档回退到默认（不会变成空的）', pool.free.length > 0);
  }
  {
    const { warnings } = normalizePool({ _comment: '随便解释一下', _comment_free: 'x', free: ['a/one'] });
    ok('下划线开头当注释，不报警', warnings.length === 0, JSON.stringify(warnings));
  }
  {
    const { pool, warnings } = normalizePool({ free: 'a/one' });
    ok('free 写成字符串被拦下', warnings.some((w) => w.includes('free')), JSON.stringify(warnings));
    ok('回退默认免费档', pool.free.length > 0);
  }
  {
    const { pool, warnings } = normalizePool({ free: ['a/one', null, '', 42, {}, { provider: 'x', model: 'y' }] });
    ok('非法候选被丢弃且告警', warnings.some((w) => w.includes('不是合法的模型写法')), JSON.stringify(warnings));
    ok(
      '留下的是合法的那两个',
      JSON.stringify(pool.free) === JSON.stringify(['a/one', { provider: 'x', model: 'y' }]),
      JSON.stringify(pool.free)
    );
  }
  {
    const { pool, warnings } = normalizePool({ cooldownMs: { rate: 'abc', quota: 1000 } });
    ok('冷却非数字被忽略并告警', warnings.some((w) => w.includes('cooldownMs.rate')), JSON.stringify(warnings));
    ok('合法的那个留下', pool.cooldownMs.quota === 1000 && pool.cooldownMs.rate === undefined);
  }
  {
    const { pool, warnings } = normalizePool({ exhaustedNotice: '' });
    ok('空提示语保留为空（用户可关闭用尽提示）', pool.exhaustedNotice === '');
    ok('没为此报警（清空是有效配置）', !warnings.some((w) => w.includes('exhaustedNotice')));
  }
  {
    const { pool, warnings } = normalizePool({ free: [], paid: [] });
    ok('两档都空要告警', warnings.some((w) => w.includes('都是空的')), JSON.stringify(warnings));
    ok('且能构造出来（不是抛异常）', pool.free.length === 0);
  }
  {
    const { warnings } = normalizePool({ free: [], paid: ['x/y'], allowPaid: false });
    ok('只有付费候选却关着开关 → 明确告警', warnings.some((w) => w.includes('allowPaid=false')), JSON.stringify(warnings));
  }
  {
    const { pool } = normalizePool({ enabled: false });
    ok('enabled=false 被如实保留', pool.enabled === false);
  }
  {
    // 这一条是"文件本身坏了"的情形：必须抛错让运维看见，而不是当成没有配置
    const bad = writePool('bad.json', '{ 这不是 JSON');
    let threw = false;
    try {
      loadModelPool({ file: bad, env: {} });
    } catch (error) {
      threw = String(error.message).includes('读不动');
    }
    ok('坏 JSON 直接抛错（不能装作没有配置）', threw);
  }
}

// ── 4. 解析优先级 ─────────────────────────────────────────────────────────
console.log('\n=== 4. 优先级：显式 > 环境变量 > models.json > 默认 ===');
{
  const file = writePool('prio.json', { exhaustedNotice: '来自文件' });

  const inline = loadModelPool({ inline: { exhaustedNotice: '来自显式' }, file, env: {} });
  ok('显式传入的最优先', inline.pool.exhaustedNotice === '来自显式');

  const viaEnvJson = loadModelPool({ file, env: { QQ_BRIDGE_MODELS: '{"exhaustedNotice":"来自环境变量"}' } });
  ok('环境变量（内联 JSON）压过文件', viaEnvJson.pool.exhaustedNotice === '来自环境变量');

  const envFile = writePool('env.json', { exhaustedNotice: '来自环境变量指向的文件' });
  const viaEnvFile = loadModelPool({ file, env: { QQ_BRIDGE_MODELS: envFile } });
  ok('环境变量指向的路径被读取', viaEnvFile.pool.exhaustedNotice === '来自环境变量指向的文件');

  const viaFile = loadModelPool({ file, env: {} });
  ok('没有环境变量时读 models.json', viaFile.pool.exhaustedNotice === '来自文件');

  const badEnv = loadModelPool({ file, env: { QQ_BRIDGE_MODELS: '{坏 JSON' } });
  ok('环境变量是坏 JSON 时回落到文件（不让机器人起不来）', badEnv.pool.exhaustedNotice === '来自文件');

  const missingEnv = loadModelPool({ file, env: { QQ_BRIDGE_MODELS: path.join(tmp, '没有这个文件.json') } });
  ok('环境变量指向不存在的路径时回落到文件', missingEnv.pool.exhaustedNotice === '来自文件');
}

// ── 5. provider 查询（决定起不起 cf-shim）────────────────────────────────
console.log('\n=== 5. provider 查询 ===');
{
  const pool = normalizePool(DEFAULT_POOL).pool;
  ok('默认池用到了 CF', poolUsesProvider(pool, 'cloudflare-workers-ai') === true);
  ok('默认池用到了智谱', poolUsesProvider(pool, 'zhipuai') === true);
  ok('默认池没用 anthropic', poolUsesProvider(pool, 'anthropic') === false);
  ok(
    '能列出全部 provider',
    JSON.stringify(poolProviders(pool)) === JSON.stringify(['zhipuai', 'cloudflare-workers-ai', 'openrouter', 'nvidia']),
    JSON.stringify(poolProviders(pool))
  );
  const noCf = normalizePool({ free: ['zhipuai/glm-4.5-flash#none'] }).pool;
  ok('池里没有 CF 时就不会去起 cf-shim', poolUsesProvider(noCf, 'cloudflare-workers-ai') === false);

  const line = describePool(pool);
  ok('一行日志说清了顺序和开关', line.includes('付费=关') && line.includes('zhipuai/glm-4.5-flash#none'), line);
}

// ── 6. 按真实模型目录剔除候选 ─────────────────────────────────────────────
console.log('\n=== 6. 目录里没有的候选要剔掉（否则链会卡住）===');
{
  const chain = new ModelChain({
    free: ['zhipuai/glm-4.5-flash#none', 'zhipuai/glm-4-flash#none', 'openrouter/openrouter/free'],
    paid: ['zhipuai/glm-4.6'],
    allowPaid: true
  });
  // 模拟真实目录：glm-4-flash 不在里面（它要靠自定义模型条目）
  const known = new Set([
    'zhipuai/glm-4.5-flash',
    'zhipuai/glm-4.6',
    'openrouter/openrouter/free'
  ]);
  const dropped = chain.restrictTo(known);
  ok('丢弃了目录里没有的那个', JSON.stringify(dropped) === JSON.stringify(['zhipuai/glm-4-flash#none']), JSON.stringify(dropped));
  ok('剩下的顺序不变', candidateKeys(chain).join(',') === 'zhipuai/glm-4.5-flash#none,openrouter/openrouter/free,zhipuai/glm-4.6');
  ok('pick() 不再可能选中被剔掉的', chain.pick().id === 'glm-4.5-flash');

  // 目录读不到时不能把链清空
  const chain2 = new ModelChain({ free: ['a/one', 'b/two'] });
  ok('空目录 = 什么都不做', chain2.restrictTo(new Set()).length === 0 && chain2.active.length === 2);

  // 目录校验只临时隐藏候选，不应改写模型池或丢失熔断状态；重置后可恢复。
  const chain3 = new ModelChain({ free: ['a/one', 'b/two'] });
  chain3.markFailure(chain3.active[0], { kind: 'quota', fatal: true, detail: '1113' });
  ok('熔断记录进了快照', chain3.snapshot().health.length === 1);
  chain3.restrictTo(new Set(['b/two']));
  ok('目录限制不删池配置或熔断记录', chain3.free.length === 2 && chain3.snapshot().health.length === 1);
  chain3.clearRestrictions();
  ok('清除目录限制后恢复完整候选', chain3.active.length === 2);
}

function candidateKeys(chain) {
  return chain.active.map((c) => `${c.providerID}/${c.id}${c.variant ? `#${c.variant}` : ''}`);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${'='.repeat(52)}`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
