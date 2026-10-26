// 模型池：按什么顺序试、能不能花钱、全用完了回什么话。
//
// 为什么单独一个文件，而不是塞进桥接的 config.json：
// 这里的每一项都是**运维要改的东西**（换个免费模型、临时打开付费、改一句提示文案），
// 而 config.json 有 1000 多项。密钥继续留在 `secrets.json` —— 那是"凭据"，
// 这里是"策略"，两者分开：换 key 不用碰顺序，改顺序不用碰 key。
//
// 解析优先级（前者覆盖后者）：
//   1. 调用方显式传入的对象（桥接 config / 单测）
//   2. 环境变量 `QQ_BRIDGE_MODELS`：可以是**文件路径**，也可以是**内联 JSON**
//   3. 项目根目录的 `models.json`（运维自己改的那个）
//   4. 本文件的 DEFAULT_POOL（保底，没配置文件也能跑）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDataRoot } from './data-root.js';

/** 代码根：DualHabitat-Matrix/；ROOT = 数据根（模型池文件跟着数据走，不跟代码走）。 */
const CODE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = resolveDataRoot(CODE_ROOT);

/**
 * 默认池。
 *
 * 免费档的顺序是有讲究的（都是**实测**结论，不是拍脑袋）：
 *   1. `zhipuai/glm-4.5-flash#none` —— 目录 cost 就是 `0/0`（官方口径免费）、中文母语、
 *      支持工具、**国内直连就通**（不需要代理）。`#none` 关掉思维链：实测 8.4s → 3.1s。
 *      排第一还有一个原因：群聊场景中文语感最重要。
 *   2. `zhipuai/glm-4-flash` —— 同样免费，但**不在 模型 API 目录里**，
 *      要靠配置生成器写一条自定义模型条目才存在；没配好时会被启动校验自动剔掉。
 *   3. `cloudflare-workers-ai/@cf/zai-org/glm-4.7-flash` —— 免费套餐每天 10,000 Neurons
 *      （约 236 条消息/天）。**需要 cf-shim 兼容代理**（见 docs/PHASE1-PORT.md）。
 *   4. `openrouter/openrouter/free` —— 零成本且支持工具调用，兜底用；实测偏慢。
 *
 * 付费档默认**不启用**（`allowPaid: false`）。打开后免费档耗尽会自动降级到这里。
 * 注意 nvidia 是"注册送 1,000 credits"型，不是永久免费，所以放在付费档。
 */
export const DEFAULT_POOL = {
  enabled: true,
  allowPaid: false,
  // 全链熔断时直接发给对方的这句话。必须是**人话**：
  // 旧默认值 `429ERROR` 会原样发进 QQ/微信，对方只看到一串错误码，
  // 既不知道发生了什么，也不知道该不该等（实测被当成机器人抽风）。
  exhaustedNotice: '我这会儿 API 连不上了，等会儿再聊吧。',
  free: [
    'zhipuai/glm-4.5-flash#none',
    'zhipuai/glm-4-flash#none',
    'cloudflare-workers-ai/@cf/zai-org/glm-4.7-flash',
    'openrouter/openrouter/free'
  ],
  paid: ['zhipuai/glm-4.6', 'nvidia/z-ai/glm-5.3-flash'],
  // 冷却覆盖（毫秒）；不写就用 model-chain 的默认值。
  // 一般来说不用改，改这里是为了应对"某家额度不是按天重置"这类情况。
  cooldownMs: {}
};

/**
 * 提示语乱码兜底。
 *
 * 旧数据里出现过「GBK 文件被当 UTF-8 读」的 `exhaustedNotice`：
 * 存下来是 U+FFFD，界面上显示成一串问号，最后还会原样发进群里。
 * 这种值不能当用户文案用，直接回退默认人话。
 *
 * 空串是**有效配置**（用户明确关掉用尽提示），不能当成乱码。
 */
export function sanitizeExhaustedNotice(value) {
  if (typeof value !== 'string') return DEFAULT_POOL.exhaustedNotice;
  const text = value.trim();
  if (text.includes('\uFFFD') || /\?{2,}/.test(text)) return DEFAULT_POOL.exhaustedNotice;
  return text;
}

/**
 * 池里有意义的顶层键。
 *
 * 另外约定：**下划线开头的键一律当注释**（延续 `proxy.json` 里 `_comment` 的写法）。
 * JSON 没有注释语法，这样运维可以随手写 `_comment_xxx` 解释每一项，
 * 而不会被"未知键"警告刷屏。
 */
const KNOWN_KEYS = new Set(['enabled', 'allowPaid', 'exhaustedNotice', 'free', 'paid', 'cooldownMs']);

/**
 * 一个候选是否合法：字符串 `provider/model[#variant]`，或等价的显式对象。
 *
 * 0.5.5 实机事故：`free: ["qwen3.5-4b-..."]` 这种**裸模型名**被当成合法候选，
 * 一路传到 `new ModelChain()` 才在 `parseCandidate()` 里抛错，桥接直接 exit 1。
 * 这里必须提前拦住 —— 配置写错只应该少一个候选，不应该让整个桥接起不来。
 */
function candidateError(value) {
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return '空字符串';
    const slash = text.indexOf('/');
    if (slash <= 0) return `「${text}」缺少 provider/ 前缀`;
    if (slash === text.length - 1) return `「${text}」缺少模型名`;
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '不是字符串或对象';
  if (!String(value.provider ?? '').trim()) return '对象缺少 provider';
  if (!String(value.model ?? '').trim()) return '对象缺少 model';
  return null;
}

function isCandidate(value) {
  return candidateError(value) === null;
}

/** 日志里展示一项坏配置，别把整份文件打出来。 */
function candidatePreview(value) {
  if (typeof value === 'string') return `「${value.trim().slice(0, 80)}」`;
  try {
    return `「${JSON.stringify(value).slice(0, 80)}」`;
  } catch {
    return '「<无法序列化>」';
  }
}

/**
 * 规整 / 校验一份池配置。
 *
 * @param {object} raw
 * @returns {{ pool: object, warnings: Array<string> }}
 */
export function normalizePool(raw) {
  const warnings = [];
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  if (source !== raw) warnings.push('顶层必须是对象，已忽略');

  for (const key of Object.keys(source)) {
    if (key.startsWith('_')) continue; // 注释键
    if (!KNOWN_KEYS.has(key)) warnings.push(`未知键「${key}」已忽略（是不是拼错了？）`);
  }

  // 裸模型名（`qwen3.5-...`）单独留下来：不能进 ModelChain，但可以等模型目录
  // 就绪后按真实模型 id 反查 provider。以前直接丢掉，用户就只剩一句「模型链是空的」。
  const unresolved = { free: [], paid: [] };
  const list = (value, label, fallback, key) => {
    if (value === undefined) return [...fallback];
    if (!Array.isArray(value)) {
      warnings.push(`${label} 必须是数组，已回退默认值`);
      return [...fallback];
    }
    const kept = value.filter(isCandidate);
    if (kept.length !== value.length) {
      const bad = value.filter((item) => !isCandidate(item));
      for (const item of bad) {
        if (typeof item === 'string' && item.trim() && !item.trim().includes('/')) {
          unresolved[key].push(item.trim());
        }
      }
      const reasons = bad.slice(0, 3).map((item) => `${candidatePreview(item)} ${candidateError(item)}`).join('；');
      warnings.push(
        `${label} 里有 ${bad.length} 项不是合法的模型写法，已跳过（${reasons}${bad.length > 3 ? '…' : ''}）。` +
          '裸模型名会等模型目录就绪后再按真实模型匹配；正确写法仍是 provider/model，例如 lmstudio/qwen2.5-7b-instruct'
      );
    }
    return kept;
  };

  const cooldownMs = {};
  if (source.cooldownMs !== undefined) {
    if (source.cooldownMs && typeof source.cooldownMs === 'object' && !Array.isArray(source.cooldownMs)) {
      for (const [kind, value] of Object.entries(source.cooldownMs)) {
        const num = Number(value);
        if (Number.isFinite(num) && num >= 0) cooldownMs[kind] = num;
        else warnings.push(`cooldownMs.${kind} 不是有效毫秒数，已忽略`);
      }
    } else {
      warnings.push('cooldownMs 必须是对象，已忽略');
    }
  }

  const notice = sanitizeExhaustedNotice(source.exhaustedNotice);
  if (typeof source.exhaustedNotice === 'string' && notice !== source.exhaustedNotice.trim()) {
    warnings.push('exhaustedNotice 含乱码（U+FFFD 或连续问号），已回退默认提示语');
  }

  const pool = {
    enabled: source.enabled !== false,
    allowPaid: source.allowPaid === true,
    exhaustedNotice: notice,
    free: list(source.free, 'free', DEFAULT_POOL.free, 'free'),
    paid: list(source.paid, 'paid', DEFAULT_POOL.paid, 'paid'),
    cooldownMs
  };
  if (unresolved.free.length || unresolved.paid.length) pool.unresolved = unresolved;

  if (pool.enabled && pool.free.length === 0 && pool.paid.length === 0) {
    warnings.push('免费档和付费档都是空的 —— 模型链等于没有，会直接回提示语');
  }
  if (!pool.free.length && pool.paid.length && !pool.allowPaid) {
    warnings.push('只有付费候选但 allowPaid=false：等同于没有可用模型');
  }
  return { pool, warnings };
}

function readPoolFile(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`模型池配置 ${file} 读不动：${error?.message ?? error}`);
  }
}

/**
 * 解析出最终生效的模型池。
 *
 * @param {{ inline?: object, file?: string, env?: object, log?: Function }} [options]
 * @returns {{ pool: object, source: string, warnings: Array<string> }}
 */
export function loadModelPool(options = {}) {
  const env = options.env ?? process.env;
  const log = options.log ?? (() => {});

  if (options.inline && typeof options.inline === 'object') {
    const { pool, warnings } = normalizePool(options.inline);
    return { pool, source: 'inline（调用方传入）', warnings };
  }

  const envSpec = typeof env.QQ_BRIDGE_MODELS === 'string' ? env.QQ_BRIDGE_MODELS.trim() : '';
  if (envSpec) {
    if (envSpec.startsWith('{')) {
      try {
        const { pool, warnings } = normalizePool(JSON.parse(envSpec));
        return { pool, source: 'QQ_BRIDGE_MODELS（内联 JSON）', warnings };
      } catch (error) {
        log(`⚠️ QQ_BRIDGE_MODELS 不是合法 JSON，改用 models.json：${error?.message ?? error}`);
      }
    } else {
      const raw = readPoolFile(envSpec);
      if (raw) {
        const { pool, warnings } = normalizePool(raw);
        return { pool, source: envSpec, warnings };
      }
      log(`⚠️ QQ_BRIDGE_MODELS 指向的 ${envSpec} 不存在，改用 models.json`);
    }
  }

  const file = options.file ?? path.join(ROOT, 'models.json');
  const raw = readPoolFile(file);
  if (raw) {
    const { pool, warnings } = normalizePool(raw);
    return { pool, source: file, warnings };
  }

  const { pool, warnings } = normalizePool(DEFAULT_POOL);
  return { pool, source: '内置默认值（没有 models.json）', warnings };
}

/**
 * 池里是否用到某家 provider。
 *
 * 目前唯一的用途：CF 的模型必须经 `cf-shim` 兼容代理才跑得通，
 * 所以要据此决定**起不起**那个 shim（池里没有 CF 模型就不起，少一个故障点）。
 */
export function poolUsesProvider(pool, providerID) {
  const wanted = String(providerID);
  return [...pool.free, ...pool.paid].some((entry) => {
    const provider = typeof entry === 'string' ? entry.split('/')[0] : entry.provider;
    return provider === wanted;
  });
}

/** 池里用到的所有 provider（日志用）。 */
export function poolProviders(pool) {
  const set = new Set();
  for (const entry of [...pool.free, ...pool.paid]) {
    set.add(typeof entry === 'string' ? entry.split('/')[0] : entry.provider);
  }
  return [...set];
}

/** 一行日志说清"现在到底会按什么顺序试"。 */
export function describePool(pool) {
  const free = pool.free.length ? pool.free.map((e) => candidateLabel(e)).join(' → ') : '(空)';
  const paid = pool.paid.length ? pool.paid.map((e) => candidateLabel(e)).join(' → ') : '(未配置)';
  return [
    `启用=${pool.enabled}`,
    `付费=${pool.allowPaid ? '开' : '关'}`,
    `用完回「${pool.exhaustedNotice}」`,
    `免费: ${free}`,
    `付费: ${paid}`
  ].join('　|　');
}

function candidateLabel(entry) {
  return typeof entry === 'string' ? entry : `${entry.provider}/${entry.model}${entry.variant ? `#${entry.variant}` : ''}`;
}

export { ROOT as POOL_ROOT };
