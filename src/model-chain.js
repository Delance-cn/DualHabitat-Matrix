// 模型候选链 + 健康熔断。
//
// 要解决的问题（用户原话）："上一个用光了，就自动切换到可以用的，直到全部都用完"。
//
// 三个必须分清的失败类型，混在一起就会做错决策：
//
//   1. 额度耗尽（quota）    "1113 余额不足" / "no remaining credits"
//      → 真的用光了，**长冷却**（当天额度按天重置，等它自己恢复）
//   2. 限流/过载（rate）    "1305 访问量过大" / 429
//      → 只是暂时挤不进去，**短冷却**（默认 60s），到点自动切回来。
//        绝不能当成"用光"永久拉黑 —— 一次网络抖动就把最好的免费模型丢掉，
//        那这个功能反而比没有更糟。
//   3. 模型不可用（unavailable） "1220 无权访问" / "not available on the Workers Free plan"
//                              / "Invalid ... stream event"（某些 CF 模型的流格式天生不兼容）
//      → 这个模型这条路走不通，**长冷却**。
//   4. 连不上（unreachable） CONNREFUSED / ENOTFOUND / DNS 投毒 / 代理挂了
//      → **也是 provider 级的"这条路走不通"**，该换。本机实测过两种真实场景：
//        huggingface.co 被 DNS 投毒（永远连不上）、代理关掉后环境里留着死端口
//        （所有 provider 一起 ECONNREFUSED）。冷却取中等，好让它自己恢复。
//        注意：`ECONNRESET` / 超时**不算**这里，仍按网络抖动处理 —— 一次抖动就把
//        最好的免费模型拉黑十分钟，比不换更糟。
//
// 另外要明确**不熔断**的：工具权限被拒（`permission.rejected`）。
// 那说明"模型好好的，是我们自己不让它用工具"，换模型毫无意义。
//
// 链是有序的：`pick()` 永远返回**顺序最靠前且当前可用**的那个。所以当最优的免费模型
// 冷却到期后，会自动从付费档切回免费档 —— 不需要任何额外逻辑。

/** 失败类型。 */
export const KIND = {
  QUOTA: 'quota',
  RATE: 'rate',
  UNAVAILABLE: 'unavailable',
  AUTH: 'auth',
  UNREACHABLE: 'unreachable',
  OTHER: 'other'
};

/** 会被熔断的失败类型（OTHER 不熔断，交给上层报错）。 */
export const FUSING_KINDS = new Set([KIND.QUOTA, KIND.RATE, KIND.UNAVAILABLE, KIND.AUTH, KIND.UNREACHABLE]);

/**
 * 「永久」冷却的哨兵时间戳：JS 日期上限（275760-09-13），有限数、JSON 能原样存。
 * 不能用 Infinity —— JSON.stringify(Infinity) 会变成 null，状态文件一落盘就丢。
 */
export const PERMANENT_UNTIL = 8640000000000000;

/** 默认冷却时长（毫秒）。
 *
 * quota 是「用完了」不是「坏了」：免费额度烧干不会自己长回来，等它复活只会让链
 * 每轮都先撞一次墙再跳过。所以额度用尽永久坐废池，只能人在模型池里「拿回来」
 * 或「删掉」。models.json 的 cooldownMs 覆盖仍然优先（想改回限时也行）。 */
export const DEFAULT_COOLDOWN_MS = {
  [KIND.QUOTA]: PERMANENT_UNTIL - Date.now(), // 永久：until 落在哨兵时间戳上
  [KIND.RATE]: 60 * 1000, // 限流只躲 60 秒
  [KIND.UNAVAILABLE]: 24 * 60 * 60 * 1000,
  [KIND.AUTH]: 24 * 60 * 60 * 1000,
  [KIND.UNREACHABLE]: 10 * 60 * 1000 // 代理挂了/DNS 投毒可能恢复，别拉黑一整天
};

/**
 * 从任意错误载体里取出可读文本。
 * 上游来的错误可能是字符串、Error、信封对象，或者 模型 API 那种
 * `{message, response:{body:"{\"errors\":[...]}"}}` 的嵌套壳，一律摊平再匹配。
 */
export function failureText(input) {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  if (input instanceof Error) return `${input.message} ${input.stack ?? ''}`;
  const parts = [];
  const walk = (value, depth) => {
    if (value == null || depth > 4) return;
    if (typeof value === 'string' || typeof value === 'number') {
      parts.push(String(value));
      return;
    }
    if (value instanceof Error) {
      parts.push(value.message);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    if (typeof value === 'object') {
      for (const key of ['message', 'error', 'errors', 'body', 'detail', 'reason', 'code', 'status', 'type']) {
        if (key in value) walk(value[key], depth + 1);
      }
    }
  };
  walk(input, 0);
  return parts.join(' ');
}

// ── 分类规则 ──────────────────────────────────────────────────────────────
// 顺序有含义：先判"不算失败"的例外，再按 quota → rate → unavailable → auth 匹配。

/** 明确**不该**熔断的：工具权限被我们自己拒掉，跟 provider 健康无关。 */
const NOT_A_FAILURE = [
  /permission\.rejected/i,
  /Permission denied: (shell|edit|write|read|webfetch|glob|grep|task)/i
];

const RULES = [
  {
    kind: KIND.QUOTA,
    // 智谱 1113：余额不足或无可用资源包
    re: /(^|\D)1113(\D|$)|余额不足|无可用资源包|请充值|Insufficient balance|no resource package|no remaining credits|remaining credits|insufficient\s+credits?|provider\.quota|insufficient_quota|exceeded your current quota|out of credits|credit balance|quota exceeded|daily free allocation|neuron(s)? (quota|limit|exceeded)|\b402\b/i
  },
  {
    kind: KIND.RATE,
    // 智谱 1305：该模型当前访问量过大
    re: /(^|\D)1305(\D|$)|访问量过大|稍后再试|请稍后重试|rate ?limit|too many requests|\b429\b|overloaded|over capacity|server is busy|temporarily unavailable|try again later|节流|限流/i
  },
  {
    kind: KIND.UNAVAILABLE,
    // 智谱 1220 无权访问；CF 免费套餐不开放；部分 CF 模型流格式天生不兼容；
    // CF 的 OpenAI 兼容端拒收 content=null 时也会走到这里（那时是 cf-shim 没起来）
    re: /(^|\D)1220(\D|$)|无权访问|not available on the Workers Free plan|is not supported by any provider|invalid-output|Invalid [\w./-]* ?stream event|oneOf at '\/' not met|Type mismatch of '\/messages|model .*(not found|does not exist|unavailable|not available)|no such model|unsupported model|does not support/i
  },
  {
    kind: KIND.AUTH,
    re: /provider\.auth|invalid api key|invalid_api_key|unauthorized|\b401\b|authentication (failed|error)|api key is (invalid|missing)|incorrect api key/i
  },
  {
    kind: KIND.UNREACHABLE,
    // 本机实测原文：
    //   "ConnectionRefused: Unable to connect. Is the computer able to access the url?"
    //   （代理关掉后环境里留着死端口，所有 provider 一起连不上）
    //   "getaddrinfo ENOTFOUND huggingface.co"（DNS 投毒）
    // 故意**不收** ECONNRESET / ETIMEDOUT：那是抖动，按 OTHER 交给上层重试。
    re: /econnrefused|enotfound|eai_again|econnaborted|getaddrinfo|no such host|dns (lookup|resolution|error)|unable to connect|failed to connect|connection ?refused|network is unreachable/i
  }
];

/**
 * 把失败文本分类。
 *
 * @param {unknown} input 错误对象/字符串/事件 data
 * @returns {{ kind: string, fatal: boolean, detail: string }}
 *   `fatal=true` 表示该模型该熔断；false 表示不该（OTHER / 工具权限拒绝）。
 */
export function classifyFailure(input) {
  const text = failureText(input);
  if (!text) return { kind: KIND.OTHER, fatal: false, detail: '' };
  for (const pattern of NOT_A_FAILURE) {
    if (pattern.test(text)) return { kind: KIND.OTHER, fatal: false, detail: text.slice(0, 300) };
  }
  for (const rule of RULES) {
    if (rule.re.test(text)) {
      return { kind: rule.kind, fatal: true, detail: text.slice(0, 300) };
    }
  }
  return { kind: KIND.OTHER, fatal: false, detail: text.slice(0, 300) };
}

/**
 * 解析候选模型写法：
 *
 *   "zhipuai/glm-4.5-flash"                   → { providerID:'zhipuai', id:'glm-4.5-flash' }
 *   "zhipuai/glm-4.5-flash#none"              → 同上 + variant:'none'
 *   "cloudflare-workers-ai/@cf/meta/llama-…"  → providerID 只取第一段，
 *                                                剩下的整段都是模型 id（CF 的 id 自带斜杠）
 */
export function parseCandidate(spec) {
  if (typeof spec === 'object' && spec !== null) {
    return {
      providerID: spec.providerID ?? spec.provider,
      id: spec.id ?? spec.model,
      variant: spec.variant ?? null,
      tier: spec.tier ?? 'free',
      label: spec.label ?? null
    };
  }
  const text = String(spec ?? '').trim();
  const slash = text.indexOf('/');
  if (slash <= 0) throw new Error(`模型写法不对（应形如 provider/model）: ${text}`);
  const providerID = text.slice(0, slash);
  let rest = text.slice(slash + 1);
  let variant = null;
  const hash = rest.lastIndexOf('#');
  if (hash > 0) {
    variant = rest.slice(hash + 1) || null;
    rest = rest.slice(0, hash);
  }
  return { providerID, id: rest, variant, tier: 'free', label: null };
}

/** 唯一标识（用于健康表 / 去重）。 */
export function candidateKey(candidate) {
  const c = typeof candidate === 'string' ? parseCandidate(candidate) : candidate;
  return `${c.providerID}/${c.id}${c.variant ? `#${c.variant}` : ''}`;
}

export class ModelChain {
  /**
   * @param {object} options
   * @param {Array<string|object>} [options.free]  免费候选，按优先级排列
   * @param {Array<string|object>} [options.paid]  付费候选
   * @param {boolean} [options.allowPaid=false]    付费开关
   * @param {object}  [options.cooldownMs]         覆盖默认冷却时长
   * @param {() => number} [options.now]           注入时钟（测试用）
   * @param {object}  [options.health]             恢复持久化的健康表
   */
  constructor({
    free = [],
    paid = [],
    allowPaid = false,
    cooldownMs = {},
    now = () => Date.now(),
    health = null
  } = {}) {
    this.free = free.map((spec) => ({ tier: 'free', ...parseCandidate(spec) }));
    this.paid = paid.map((spec) => ({ tier: 'paid', ...parseCandidate(spec) }));
    this.allowPaid = allowPaid === true;
    this.cooldownMs = { ...DEFAULT_COOLDOWN_MS, ...cooldownMs };
    this.now = now;
    this._knownModels = null;
    /** key -> { kind, until, detail, count, firstAt, lastAt } */
    this.health = new Map();
    /** 上一次成功过的候选 key（粘性首选，见 pick()）。 */
    this._lastGoodKey = null;
    if (health) this.restore(health);
  }

  /** 当前生效的候选（付费开关关着时，付费档根本不在列表里）。 */
  get active() {
    const candidates = this.allowPaid ? [...this.free, ...this.paid] : [...this.free];
    return this._knownModels
      ? candidates.filter((candidate) => this._knownModels.has(`${candidate.providerID}/${candidate.id}`))
      : candidates;
  }

  /** 某候选此刻是否可用（冷却到期即恢复，无需外部干预）。 */
  isUsable(candidate) {
    const entry = this.health.get(candidateKey(candidate));
    if (!entry) return true;
    return this.now() >= entry.until;
  }

  /**
   * 取顺序最靠前的可用候选；全都没得用返回 null。
   * 每次调用都重新算，所以冷却一到期就会自动切回更优的档位。
   *
   * 粘性（2026-10-19 省 token 改动）：上一次成功用过的候选如果还在链里且可用，
   * 就直接继续用它，不再“冷却一到期就切回优先级更高的那个”。
   * 原因：换一次模型 prompt 缓存就失效一次，整段上下文（实测 60–80k token）
   * 从缓存价变全价重算 —— 一个会话里每切一次，就白花几十 k。
   */
  pick() {
    const lastKey = this._lastGoodKey;
    if (lastKey) {
      const found = this.active.find((candidate) => candidateKey(candidate) === lastKey);
      if (found && this.isUsable(found)) return found;
    }
    for (const candidate of this.active) {
      if (this.isUsable(candidate)) return candidate;
    }
    return null;
  }

  /** 可用的候选数（用于判断"是不是全用完了"）。 */
  usableCount() {
    return this.active.filter((candidate) => this.isUsable(candidate)).length;
  }

  allExhausted() {
    return this.active.length > 0 && this.pick() === null;
  }

  /**
   * 用真实模型目录临时隐藏"目录里根本没有"的项；不改写模型池本身。
   *
   * 为什么必须做：链里写了目录里不存在的东西（最典型的是 `glm-4-flash` ——
   * 它确实免费，但**不在 模型 API 目录里**，要靠配置生成器写一条自定义模型条目），
   * 换到它头上时 `switchModel` 会失败，链就卡在那儿，后面的候选永远轮不到。
   *
   * 传空集合时**什么都不做**（宁可保留候选，也别因为目录读不到就把链清空）。
   *
   * @param {Set<string>|Array<string>} knownKeys 形如 `provider/model` 的集合
   * @returns {Array<string>} 当前目录不可用的候选 key（调用方负责打日志）
   */
  restrictTo(knownKeys) {
    const known = knownKeys instanceof Set ? knownKeys : new Set(knownKeys ?? []);
    if (known.size === 0) return [];
    const dropped = [];
    this._knownModels = known;
    for (const candidate of [...this.free, ...this.paid]) {
      if (!known.has(`${candidate.providerID}/${candidate.id}`)) dropped.push(candidateKey(candidate));
    }
    return dropped;
  }

  /** 目录可能因实例重启而变化；清除临时限制并恢复完整模型池。 */
  clearRestrictions() {
    this._knownModels = null;
  }

  /** 标记健康（成功一次就清掉熔断记录），并记住它作为“粘性首选”。 */
  markSuccess(candidate) {
    if (!candidate) return;
    const key = candidateKey(candidate);
    this.health.delete(key);
    this._lastGoodKey = key;
  }

  /**
   * 记录一次失败。`fatal=false`（不熔断）时不改变健康表。
   *
   * @param {object} candidate
   * @param {{ kind: string, fatal: boolean, detail?: string }} failure
   * @param {{ retryAfterMs?: number }} [options] 上游给了 Retry-After 时优先采用
   * @returns {{ fused: boolean, until: number|null }}
   */
  markFailure(candidate, failure, { retryAfterMs } = {}) {
    if (!candidate || !failure?.fatal) return { fused: false, until: null };
    const key = candidateKey(candidate);
    const prev = this.health.get(key);
    const kind = failure.kind;
    const wait = Number.isFinite(retryAfterMs) && retryAfterMs > 0
      ? retryAfterMs
      : (this.cooldownMs[kind] ?? DEFAULT_COOLDOWN_MS[KIND.UNAVAILABLE]);
    const at = this.now();
    // 钳到 JS 日期上限（=PERMANENT_UNTIL）：冷却时长再大也不能溢出，
    // 否则 new Date(until).toISOString() 会抛 Invalid time value。
    const entry = {
      kind,
      until: Math.min(at + wait, PERMANENT_UNTIL),
      detail: failure.detail ?? prev?.detail ?? '',
      count: (prev?.count ?? 0) + 1,
      firstAt: prev?.firstAt ?? at,
      lastAt: at
    };
    this.health.set(key, entry);
    return { fused: true, until: entry.until };
  }

  /** 注意：付费开关可以被外部随时改（控制台切换），改完无需重建链。 */
  setAllowPaid(value) {
    this.allowPaid = value === true;
  }

  /** 可持久化的快照（只存健康表；候选/开关来自配置，不重复存）。 */
  snapshot() {
    return {
      version: 1,
      savedAt: this.now(),
      health: [...this.health.entries()].map(([key, entry]) => ({ key, ...entry }))
    };
  }

  restore(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.health)) return;
    const at = this.now();
    for (const entry of snapshot.health) {
      if (!entry?.key) continue;
      // 已过期的记录直接丢弃，避免状态文件越滚越大。
      if (typeof entry.until === 'number' && entry.until <= at) continue;
      this.health.set(entry.key, {
        kind: entry.kind,
        until: entry.until,
        detail: entry.detail ?? '',
        count: entry.count ?? 1,
        firstAt: entry.firstAt ?? at,
        lastAt: entry.lastAt ?? at
      });
    }
  }

  /** 给人看的现状（日志/控制台用）。 */
  status() {
    const at = this.now();
    return this.active.map((candidate) => {
      const entry = this.health.get(candidateKey(candidate));
      const usable = this.isUsable(candidate);
      return {
        key: candidateKey(candidate),
        tier: candidate.tier,
        usable,
        kind: entry?.kind ?? null,
        cooldownMsLeft: usable || !entry ? 0 : Math.max(0, entry.until - at),
        count: entry?.count ?? 0,
        detail: entry?.detail ?? null
      };
    });
  }
}
