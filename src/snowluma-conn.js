// OneBot 网关连接自发现（支持 SnowLuma 与 NapCat）：解决「换 QQ 账号后 token 变了，工具就 401」的问题。
//
// 背景（实测确认）：
//   各家网关的 OneBot 配置都是**按账号分文件**的，每个账号有各自的 HTTP token 与
//   WebSocket token（**两者不同、端口也不同**）。换账号登录后，旧的 token 直接 401
//   （retcode 1401），于是任何把它硬编码在 config.json 里的工具（独立工具、图形界面、
//   甚至 DualHabitat-Matrix）全部失效。
//
//   桥接只依赖 OneBot v11 协议，网关是可替换的，但**配置文件布局每家都不一样**：
//     SnowLuma: config/onebot_<QQ>.json    → networks.httpServers[0].accessToken
//     NapCat:   config/onebot11_<QQ>.json  → network.httpServers[0].token
//   见 GATEWAY_LAYOUTS。
//
// 本模块的做法：**不猜**，而是拿候选 token 真去问一次 get_login_info，谁通就用谁，
// 并把“当前是哪个账号”一并回报出来。候选来源：
//   1) 显式传入的 token / 环境变量
//   2) config.json 里已配置的 token（保持兼容）
//   3) 网关 config 目录下所有 onebot*_<QQ>.json 里的 HTTP token（真实来源）
//
// 这样换账号（或换网关）后无需手改任何配置，工具自动跟上。
import fs from 'node:fs';
import path from 'node:path';

/**
 * SnowLuma 主目录的常见位置。
 *
 * 同时接受两种 cfg 形状（踩过坑：图形界面传的是"窄对象"，没有 snowluma 这一层，
 * 于是 homeDir 被忽略、per-account token 一个都扫不到 → 换账号后界面显示未连接）：
 *   - 完整 config：{ snowluma: { homeDir, launcherPath, httpUrl, accessToken } }
 *   - 窄对象：    { homeDir, launcherPath, httpUrl, accessToken }
 */
export function snowLumaHomeCandidates({ cfg = null } = {}) {
  const out = [];
  const push = (p) => { if (p && !out.includes(p)) out.push(p); };
  const sl = cfg?.snowluma ?? cfg ?? {};
  if (sl.homeDir) push(String(sl.homeDir));
  if (sl.launcherPath) push(path.dirname(String(sl.launcherPath)));
  if (process.env.SNOWLUMA_HOME) push(process.env.SNOWLUMA_HOME);
  return out;
}

/**
 * 各网关的 OneBot 配置布局。
 *
 * 桥接只依赖 **OneBot v11 协议**，所以网关是可以换的（SnowLuma / NapCat / …）。
 * 但 token 自发现必须读**每个网关自己的配置文件**，而这几家的文件名、顶层键、
 * WS 服务端数组名、token 字段名**全都不一样**。实测（对照官方文档）：
 *
 *   SnowLuma: config/onebot_<QQ>.json    → d.networks.httpServers[0].accessToken
 *                                          d.networks.wsServers[0].accessToken
 *   NapCat:   config/onebot11_<QQ>.json  → d.network.httpServers[0].token
 *                                          d.network.websocketServers[0].token
 *
 * 这里最容易踩的坑：NapCat 的 WS 服务端数组叫 `websocketServers`（不是 SnowLuma 的
 * `wsServers`）。只认错一个名字，结果是「HTTP 通、WS 一直 1006 重连」，且不报任何错。
 */
export const GATEWAY_LAYOUTS = [
  {
    gateway: 'snowluma',
    fileRe: /^onebot_(\d+)\.json$/i,
    rootKey: 'networks',
    httpKey: 'httpServers',
    wsKey: 'wsServers',
    tokenField: 'accessToken',
    defaultHttpPort: 3000,
    defaultWsPort: 3001
  },
  {
    gateway: 'napcat',
    fileRe: /^onebot11_(\d+)\.json$/i,
    rootKey: 'network',
    httpKey: 'httpServers',
    wsKey: 'websocketServers',
    tokenField: 'token',
    defaultHttpPort: 3000,
    defaultWsPort: 3001
  }
];

/**
 * 把监听地址归一成**可连接**的地址。
 *
 * 网关的配置默认常写 `0.0.0.0`（表示"监听所有网卡"），但把它当成**客户端要连的目标**
 * 是错的：`http://0.0.0.0:3000` 在不同平台/栈上行为不一致（Windows 上有时碰巧能连，
 * Unix 上通常不行）。这里统一归一成回环地址。
 */
function connectableHost(host, fallback = '127.0.0.1') {
  const h = String(host ?? '').trim();
  if (!h || h === '0.0.0.0' || h === '::' || h === '[::]' || h === '*') return fallback;
  return h;
}

/** 按某个布局解析一个 onebot 配置文件。 */
function parseGatewayFile(file, layout) {
  const m = layout.fileRe.exec(path.basename(file));
  if (!m) return null;
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const root = j?.[layout.rootKey] ?? {};
  const pick = (key) => (Array.isArray(root[key]) ? root[key][0] : null);
  const http = pick(layout.httpKey);
  const ws = pick(layout.wsKey);
  const toks = (x) => (x ? String(x[layout.tokenField] ?? '') : '');
  return {
    uin: m[1],
    file,
    gateway: layout.gateway,
    http: http
      ? {
          token: toks(http),
          host: connectableHost(http.host),
          port: Number(http.port) || layout.defaultHttpPort,
          enabled: http.enable !== false
        }
      : null,
    ws: ws
      ? {
          token: toks(ws),
          host: connectableHost(ws.host),
          port: Number(ws.port) || layout.defaultWsPort,
          enabled: ws.enable !== false
        }
      : null
  };
}

/**
 * 从网关的 per-account 配置里读出候选 token（自动识别 SnowLuma / NapCat 布局）。
 *
 * 重要：**HTTP 与 WebSocket 是两个不同的 token**（各自的 server 配置里各有一份），
 * 桥接用 WS 连 3001、工具用 HTTP 连 3000，所以两边都要能取到。
 *
 * 返回 [{ uin, file, gateway, http: {token,host,port}, ws: {token,host,port} }]，按 uin 排序。
 */
export function readOneBotTokens(homeDir) {
  const dir = path.join(homeDir, 'config');
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const file = path.join(dir, e.name);
    for (const layout of GATEWAY_LAYOUTS) {
      try {
        const parsed = parseGatewayFile(file, layout);
        if (parsed) {
          // 同一个 QQ 同时存在两家配置时，以先命中的布局为准（表里 SnowLuma 在前）。
          if (!out.some((x) => x.uin === parsed.uin)) out.push(parsed);
          break;
        }
      } catch {
        // 单个文件坏了不影响其它账号
      }
    }
  }
  return out.sort((a, b) => a.uin.localeCompare(b.uin));
}

/** 兼容旧调用：只取 HTTP token 的扁平列表。 */
export function readOneBotHttpTokens(homeDir) {
  return readOneBotTokens(homeDir)
    .filter((a) => a.http)
    .map((a) => ({ token: a.http.token, uin: a.uin, host: a.http.host, port: a.http.port, file: a.file }));
}

/** 试一次 get_login_info；成功返回 data，失败返回 null。 */
async function probe(baseUrl, token, timeoutMs) {
  try {
    const res = await fetch(`${baseUrl}/get_login_info`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {})
      },
      body: '{}',
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) return { ok: false, status: res.status };
    const body = await res.json().catch(() => ({}));
    if (body.status !== 'ok' || body.retcode !== 0) return { ok: false, status: res.status, retcode: body.retcode, wording: body.wording };
    return { ok: true, data: body.data };
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  }
}

/**
 * 自动找出一条**能用**的连接（token + baseUrl + 账号信息）。
 *
 * @returns {Promise<{ok:boolean, token?:string, baseUrl?:string, self?:object,
 *                    tried?:Array, error?:string, source?:string}>}
 */
export async function discoverSnowLumaConnection({
  cfg = null,
  baseUrl = null,
  token = null,
  homeDirs = null,
  timeoutMs = 6000
} = {}) {
  const sl = cfg?.snowluma ?? cfg ?? {};
  const base = String(baseUrl || process.env.SNOWLUMA_HTTP_URL || sl.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const homes = homeDirs ?? snowLumaHomeCandidates({ cfg });
  const explicit = token || process.env.SNOWLUMA_TOKEN || sl.accessToken || '';

  // 候选顺序：显式配置优先（尊重用户选择），然后才是 per-account 文件里的其它账号
  const candidates = [];
  const seen = new Set();
  const add = (tk, source, url, uin = null) => {
    const key = `${url}|${tk}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ token: tk, source, url, uin });
  };
  if (explicit) add(explicit, 'config/env', base);
  // per-account 文件：同时收 HTTP token（工具用）与 WS 信息（桥接用）。
  // 两个 token 不同、端口也各自记录，不能混用。
  const wsInfo = new Map();   // uin -> { token, url }
  for (const home of homes) {
    for (const entry of readOneBotTokens(home)) {
      // source 用**文件名**（能自证是读到的哪份配置），uin 另外显式带上 ——
      // 不要再用正则从 source 里反解 uin：NapCat 的文件名是 onebot11_<QQ>.json，
      // 反解会失败并退化成 get_login_info 的 user_id，若该账号与文件名不一致，
      // 就会静默匹配不到 WS 信息（HTTP 通、WS 一直 1006）。
      if (entry.http) add(entry.http.token, path.basename(entry.file), `http://${entry.http.host}:${entry.http.port}`, entry.uin);
      if (entry.ws?.token) wsInfo.set(entry.uin, { token: entry.ws.token, url: `ws://${entry.ws.host}:${entry.ws.port}` });
    }
  }
  if (!explicit && candidates.length === 0) add('', 'no-token', base);

  const tried = [];
  for (const c of candidates) {
    const r = await probe(c.url, c.token, timeoutMs);
    tried.push({ source: c.source, url: c.url, token: c.token ? c.token.slice(0, 4) + '…' : '(空)', ok: r.ok, status: r.status, wording: r.wording });
    if (r.ok) {
      // 找到有效 HTTP token 后，把**同一个账号**的 WS 信息也带回去：
      // 桥接走 WebSocket，用另一个 token、另一个端口 —— 只修 HTTP 的话桥接仍然 1006 重连。
      const uin = c.uin ?? String(r.data?.user_id ?? '');
      const w = wsInfo.get(uin) ?? null;
      return {
        ok: true,
        token: c.token,
        baseUrl: c.url,
        self: r.data,
        source: c.source,
        wsToken: w?.token ?? null,
        wsUrl: w?.url ?? null,
        tried
      };
    }
  }
  const last = tried[tried.length - 1];
  return {
    ok: false,
    tried,
    baseUrl: base,
    error: last?.status === 401
      ? `所有候选 token 都被拒绝（401）。当前账号的 token 可能还没写进网关的 config：请确认网关已登录目标 QQ，且 OneBot HTTP 服务已开启。`
      : `连不上 OneBot HTTP API（${base}）：${last?.wording ?? last?.status ?? '未知错误'}`
  };
}

/**
 * 把当前有效的 token 写回 config.json（可选动作，供 DualHabitat-Matrix 这类"必须持久化 token"的组件用）。
 * 只在真的换过账号时才写，避免无谓改动。
 * 返回 { updated, from, to }。
 */
/**
 * 只写 accessToken（兼容旧调用）。返回 { updated, from, to } —— 保留 from/to 是因为
 * 既有调用方与测试按这个形状断言（重构时改成 changed 曾把测试打红）。
 */
export function persistToken(cfgPath, newToken) {
  let text = fs.readFileSync(cfgPath, 'utf8');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const old = String(JSON.parse(text).snowluma?.accessToken ?? '');
  const r = persistSnowLumaEndpoint(cfgPath, { accessToken: newToken });
  return { updated: r.updated, from: old, to: newToken };
}

/**
 * 把**已确认可用**的 SnowLuma 端点写回 config.json。
 * 只写传进来的字段，其它配置一律不动；全部一致时不写文件（幂等）。
 * 返回 { updated, changed: {...} }。
 */
export function persistSnowLumaEndpoint(cfgPath, { accessToken, wsUrl, httpUrl } = {}) {
  let text = fs.readFileSync(cfgPath, 'utf8');
  // 读的时候必须吃掉 BOM，否则 JSON.parse 会抛「Unexpected token」。
  const hadBom = text.charCodeAt(0) === 0xFEFF;
  if (hadBom) text = text.slice(1);
  const cfg = JSON.parse(text);
  const cur = cfg.snowluma ?? {};
  const next = { ...cur };
  const changed = {};
  const consider = (key, value) => {
    if (value === undefined || value === null || value === '') return;
    if (String(cur[key] ?? '') === String(value)) return;
    changed[key] = { from: cur[key] ?? null, to: value };
    next[key] = value;
  };
  consider('accessToken', accessToken);
  consider('wsUrl', wsUrl);
  consider('httpUrl', httpUrl);
  if (Object.keys(changed).length === 0) return { updated: false, changed: {} };
  cfg.snowluma = next;
  // 原来 hadBom 只用于读、没用回写：用户文件带 UTF-8 BOM 时，我们改一个 token 就把 BOM 吞掉了
  // —— 那是对用户文件的**字节级**静默改动（Windows 编辑器/工具常写 BOM），会让文件在 git 里
  // 显示成整文件重写，也可能影响按字节读它的其它程序。只改该改的字段，编码原样保留。
  const serialized = JSON.stringify(cfg, null, 2) + '\n';
  fs.writeFileSync(cfgPath, hadBom ? `\uFEFF${serialized}` : serialized, 'utf8');
  return { updated: true, changed };
}
