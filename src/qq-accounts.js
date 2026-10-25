// QQ 多号：账号模型与「账号作用域会话键」的**唯一**实现。
//
// 为什么要有这个模块：
//   多号不是「多开一个进程」那么简单 —— 桥接里几乎所有东西都挂在会话键上
//   （state/sessions.json、social-v2.json、记忆、黑名单、agent token、投递队列），
//   而旧键的格式是 `group:<gid>` / `private:<qq>`，**没有账号维度**。
//   如果直接改成 `qq2:group:<gid>`，老用户的会话、记忆、白名单会全部认不出来。
//
// 所以这里定死一条兼容规则：
//   · 默认号（qq1）的键**保持原样** `group:<gid>` / `private:<qq>`；
//   · 其余账号的键加前缀 `qq2:group:<gid>` / `qq2:private:<qq>`。
// 这样升级后 qq1 的所有历史数据原封不动，新号也不会和 qq1 撞键。
//
// 账号 id（qq1 / qq2 …）一旦分配就**不重排**：会话键里嵌着 id，
// 重排等于把老号的历史送给新号。删号只留空洞，不复用编号。

export const DEFAULT_ACCOUNT_ID = 'qq1';

/** 默认端口：每个号错开 10，避免 WS/HTTP/WebUI 三类端口互相撞。 */
export const PORT_STRIDE = 10;
export const BASE_WS_PORT = 3001;
export const BASE_HTTP_PORT = 3000;
export const BASE_WEBUI_PORT = 6099;

/** 第 index 个号（0 起）的端口。 */
export function accountPorts(index = 0) {
  const i = Number.isInteger(index) && index >= 0 ? index : 0;
  return {
    wsPort: BASE_WS_PORT + i * PORT_STRIDE,
    httpPort: BASE_HTTP_PORT + i * PORT_STRIDE,
    webuiPort: BASE_WEBUI_PORT + i * PORT_STRIDE
  };
}

/** 从 URL 里取端口；取不到返回 0（调用方再用默认值兜底）。 */
function portFromUrl(url) {
  const m = /:(\d{1,5})\/?$/.exec(String(url ?? '').trim());
  return m ? Number(m[1]) : 0;
}

/** 端口数字规范化：非整数或越界 → 0。 */
function portOf(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : 0;
}

/** 账号 id 只允许 [a-z0-9_-]，避免被当成路径/键的一部分时出怪事。 */
export function isValidAccountId(id) {
  return typeof id === 'string' && /^[a-z][a-z0-9_-]{0,23}$/.test(id);
}

/**
 * 下一个可用账号 id。
 *
 * **不复用空洞**：删掉 qq2 后，下一个新号仍然是 qq3。
 * 会话键里嵌着账号 id，复用会把 qq2 留下的历史直接送给新号。
 */
export function nextAccountId(accounts = []) {
  let max = 0;
  for (const acc of accounts) {
    const m = /^qq(\d+)$/.exec(String(acc?.id ?? ''));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `qq${max + 1}`;
}

/**
 * 白名单/黑名单：兼容单数（group/private）与复数（groups/privates）两种历史写法。
 * 只读**同一层**的键，不会把 allow 和 deny 混在一起。
 */
function idList(bucket, kind) {
  const raw = bucket?.[kind] ?? bucket?.[`${kind}s`];
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map((x) => String(x).trim()).filter(Boolean))];
}

/** 一个策略对象里的 allow 三元组；没写 allow 返回 null（用于区分「没配」和「配成空」）。 */
function allowOf(policy) {
  if (!policy || typeof policy !== 'object') return null;
  const inner = policy.allow;
  if (inner && typeof inner === 'object') {
    // idList 的 kind 用单数，内部同时认 group / groups、private / privates。
    return { private: idList(inner, 'private'), groups: idList(inner, 'group') };
  }
  // 简写：{ "groups": [...], "private": [...] }
  if (Array.isArray(policy.groups) || Array.isArray(policy.group) || Array.isArray(policy.private)) {
    return { private: idList(policy, 'private'), groups: idList(policy, 'group') };
  }
  return null;
}

/**
 * 解析一个账号的生效白/黑名单策略。
 *
 * 合并规则（宁可少放行，不可多放行）：
 *   · allow：账号自己配了就**只**用账号的（不做并集 —— 并集会让「我只想让这个号进这几个群」失效）；
 *   · deny：账号与全局**取并集**（任何一处拉黑都生效）；
 *   · allowAllWhenEmpty：账号可覆盖；没配就继承全局。
 */
export function resolveAccountPolicy(globalPolicy = {}, account = {}) {
  const own = account?.policy && typeof account.policy === 'object' ? account.policy : {};
  const ownAllow = allowOf(own);
  const allow = ownAllow ?? {
    private: idList(globalPolicy.allow, 'private'),
    groups: idList(globalPolicy.allow, 'group')
  };
  const deny = {
    private: [...new Set([...idList(globalPolicy.deny, 'private'), ...idList(own.deny, 'private')])],
    groups: [...new Set([...idList(globalPolicy.deny, 'group'), ...idList(own.deny, 'group')])]
  };
  const allowAllWhenEmpty = typeof own.allowAllWhenEmpty === 'boolean'
    ? own.allowAllWhenEmpty
    : globalPolicy.allowAllWhenEmpty === true;
  return { allow, deny, allowAllWhenEmpty };
}

/**
 * 判断某个会话是否放行（与 bridge.js 里 allowed() 同语义，但吃解析后的策略）。
 * kind: 'group' | 'private'
 */
export function policyAllows(policy, kind, id) {
  const s = String(id);
  // 键名兼容单数/复数（与 bridge.js 的 cfg.allow[kind] ?? cfg.allow[kind+'s'] 同语义）
  const denyList = idList(policy?.deny, kind);
  if (denyList.includes(s)) return false;
  const allowList = idList(policy?.allow, kind);
  if (allowList.includes('*')) return true;
  if (allowList.length > 0) return allowList.includes(s);
  return policy?.allowAllWhenEmpty === true;
}

/** 默认号（qq1）的键不带前缀。 */
export function isDefaultAccount(accountId) {
  return !accountId || accountId === DEFAULT_ACCOUNT_ID;
}

/**
 * 会话键：`<账号前缀><kind>:<id>`。
 * qq1 → `group:123`（与历史数据完全一致）；qq2 → `qq2:group:123`。
 */
export function scopedConvKey(accountId, kind, id) {
  const base = `${kind}:${id}`;
  return isDefaultAccount(accountId) ? base : `${accountId}:${base}`;
}

/**
 * 拆一个会话键。
 * 返回 { accountId, kind, id }；不合法返回 null。
 * 兼容两种写法，且 id 归一成十进制整数（去掉前导零，与旧 canonicalV2Key 一致）。
 */
export function splitConvKey(key) {
  const text = String(key ?? '').trim();
  const m = /^(?:([a-z][a-z0-9_-]{0,23}):)?(group|private):(\d+)$/.exec(text);
  if (!m) return null;
  const id = Number(m[3]);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return { accountId: m[1] ?? DEFAULT_ACCOUNT_ID, kind: m[2], id: String(id) };
}

/** 规范化会话键；不合法返回 null（替代旧的 canonicalV2Key）。 */
export function canonicalConvKey(key) {
  const parsed = splitConvKey(key);
  return parsed ? scopedConvKey(parsed.accountId, parsed.kind, parsed.id) : null;
}

/**
 * 从配置里读账号列表。
 *
 * 两种配置形状都接受：
 *   A. 新：platforms.qq.accounts = [{ id, qq, dir, homeDir, wsPort, httpPort, webuiPort, ... }]
 *   B. 旧：只有 snowluma.{wsUrl,httpUrl,accessToken,homeDir}
 * B 会合成一个 qq1（enabled=true），**不写回配置** —— 读的时候兼容，写的时候才迁移。
 *
 * 返回 { accounts, legacy }；legacy=true 表示当前是旧配置形状。
 */
export function normalizeQQAccounts(config = {}) {
  const list = config?.platforms?.qq?.accounts;
  if (Array.isArray(list) && list.length > 0) {
    const seen = new Set();
    const accounts = [];
    list.forEach((raw, index) => {
      if (!raw || typeof raw !== 'object') return;
      const id = isValidAccountId(raw.id) ? raw.id : `qq${index + 1}`;
      if (seen.has(id)) return;
      seen.add(id);
      // 端口按 id 序号定（qq2 → 第 2 套），不按数组下标：
      // 删掉中间一个号后，剩下的号端口不会集体漂移，已配好的 NapCat 不用改。
      const ordinal = /^qq(\d+)$/.exec(id);
      const ports = accountPorts(ordinal ? Number(ordinal[1]) - 1 : index);
      const wsUrl = String(raw.wsUrl ?? '').trim() || `ws://127.0.0.1:${portOf(raw.wsPort) || ports.wsPort}`;
      const httpUrl = String(raw.httpUrl ?? '').trim() || `http://127.0.0.1:${portOf(raw.httpPort) || ports.httpPort}`;
      accounts.push({
        id,
        qq: String(raw.qq ?? '').replace(/\D/g, ''),
        enabled: raw.enabled !== false,
        dir: String(raw.dir ?? '').trim(),
        homeDir: String(raw.homeDir ?? '').trim(),
        wsUrl,
        httpUrl,
        wsPort: portOf(raw.wsPort) || portFromUrl(wsUrl) || ports.wsPort,
        httpPort: portOf(raw.httpPort) || portFromUrl(httpUrl) || ports.httpPort,
        webuiPort: portOf(raw.webuiPort) || ports.webuiPort,
        token: String(raw.token ?? ''),
        label: String(raw.label ?? '').trim(),
        policy: raw.policy && typeof raw.policy === 'object' ? raw.policy : {}
      });
    });
    // 至少保证有一个默认号：配置里把 qq1 删了也能跑起来。
    // 注意这里不是「至少一个账号」—— qq1 是兼容键的基准（group:/private: 不带前缀），
    // 少了它，qq2 会被当成主号，健康探测和 token 自愈都会落错地方。
    if (!accounts.some((a) => a.id === DEFAULT_ACCOUNT_ID)) {
      accounts.unshift(legacyAccount(config));
    }
    return { accounts, legacy: false };
  }
  return { accounts: [legacyAccount(config)], legacy: true };
}

/** 旧配置（只有 snowluma）合成的 qq1。 */
function legacyAccount(config = {}) {
  const sl = config?.snowluma ?? {};
  const wsUrl = String(sl.wsUrl ?? '').trim() || `ws://127.0.0.1:${BASE_WS_PORT}`;
  const httpUrl = String(sl.httpUrl ?? '').trim() || `http://127.0.0.1:${BASE_HTTP_PORT}`;
  return {
    id: DEFAULT_ACCOUNT_ID,
    qq: String(config?.qq ?? '').replace(/\D/g, ''),
    enabled: true,
    dir: String(config?.platforms?.qq?.dir ?? '').trim(),
    homeDir: String(sl.homeDir ?? '').trim(),
    wsUrl,
    httpUrl,
    wsPort: portFromUrl(wsUrl) || BASE_WS_PORT,
    httpPort: portFromUrl(httpUrl) || BASE_HTTP_PORT,
    webuiPort: BASE_WEBUI_PORT,
    token: String(sl.accessToken ?? ''),
    label: String(config?.platforms?.qq?.label ?? '').trim(),
    policy: {}
  };
}

/**
 * 写回用的账号形状（去掉运行时字段，保持配置文件干净）。
 * `null` 字段会被剔除，避免把 undefined 落盘。
 */
export function toConfigAccount(account) {
  const out = {
    id: account.id,
    qq: account.qq || '',
    enabled: account.enabled !== false,
    dir: account.dir || '',
    homeDir: account.homeDir || '',
    wsPort: account.wsPort,
    httpPort: account.httpPort,
    webuiPort: account.webuiPort,
    label: account.label || ''
  };
  if (account.token) out.token = account.token;
  const policy = account.policy && Object.keys(account.policy).length ? account.policy : null;
  if (policy) out.policy = policy;
  return out;
}
