// 桥接专用 模型 API 实例的隔离环境（**生产代码**）。
//
// 原来叫 `spike/oc-env.mjs`，随着 ②配置生成 / ④服务器生命周期 落地提升到 `src/`：
// 桥接启动时要自己管这个实例的生命周期，不能再依赖脚手本文本。
// `spike/oc-env.mjs` 现在只是本文件的转发，避免两份实现悄悄漂移。
//
// 用 Node 而不是 PowerShell：本机 powershell 5.1 的点源（dot-source）作用域
// 反复把变量吃掉（实测：oc-env.ps1 里设的变量在调用方全是 null，服务压根没起来），
// 而且 Node 本来就是本项目（DualHabitat-Matrix）的语言。
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 项目根：DualHabitat-Matrix/ */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 固定端口：不跟桌面端的随机端口混，也不会撞 3080/3000/3001/3100。 */
export const PORT = 4599;

/** CF 兼容代理（cf-shim）的固定端口。只在模型池里真有 CF 模型时才会起来。 */
export const SHIM_PORT = 4600;

/** 隔离出来的目录，全部落在项目内，便于整体删除/迁移/备份。 */
export const PATHS = {
  data: path.join(ROOT, '.oc', 'data'),
  config: path.join(ROOT, '.oc', 'config'),
  cache: path.join(ROOT, '.oc', 'cache'),
  state: path.join(ROOT, '.oc', 'state'),
  work: path.join(ROOT, '.oc', 'work'),
  logs: path.join(ROOT, '.oc', 'logs'),
  pid: path.join(ROOT, '.oc', 'server.pid'),
  shimPid: path.join(ROOT, '.oc', 'cf-shim.pid'),
  shimLog: path.join(ROOT, '.oc', 'logs', 'cf-shim.jsonl')
};

/** 注册文件（模型 API `--service` 模式自己写的，含 url/pid/password）。 */
export const SERVICE_FILE = path.join(PATHS.state, 'opencode', 'service.json');

/** CF 兼容代理的基址；写进 opencode.json 的 CF provider baseURL。 */
export const SHIM_BASE_URL = `http://127.0.0.1:${SHIM_PORT}/v1`;

/** 模型 API 的配置文件名。 */
export const CONFIG_FILE = path.join(ROOT, 'opencode.json');

/** 模型池配置文件名。 */
export const MODELS_FILE = path.join(ROOT, 'models.json');

/**
 * 解析 opencode-cli.exe。
 *
 * 桌面端把 CLI 放在 %APPDATA%\ai.opencode.desktop\cli\<版本>-<arch>\opencode-cli.exe，
 * 版本目录随升级变化（本机当前是 2.0.32-x64）。按最后修改时间取最新的一个，
 * 不钉死版本号 —— 否则桌面端一升级，桥接就找不到 CLI 了。
 */
export function resolveCli() {
  // 0. 显式指定（测试 / 特殊布局用）
  const envCli = process.env.DHM_OPENCODE_CLI;
  if (envCli && fs.existsSync(envCli)) return envCli;
  // 1. 安装包自带：bridge 根目录 vendor/opencode-cli/opencode-cli.exe
  //    （prepare-bridge 打包时从本机 OpenCode 桌面端缓存取的，单文件无依赖）
  //    —— 没装 OpenCode 桌面端的新机器靠它起模型 API。
  const bundled = path.join(ROOT, 'vendor', 'opencode-cli', 'opencode-cli.exe');
  if (fs.existsSync(bundled)) return bundled;
  // 2. 本机装了 OpenCode 桌面端：%APPDATA%\ai.opencode.desktop\cli\<版本>\opencode-cli.exe
  //    APPDATA 在某些非交互环境（沙箱 shell、计划任务、部分终端）里是空的，
  //    直接用它会得到相对路径 —— 报错信息会误导人。兜底到 USERPROFILE。
  const roaming = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const base = path.join(roaming, 'ai.opencode.desktop', 'cli');
  let entries;
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    throw new Error('找不到模型引擎（opencode-cli.exe）：安装包 vendor/ 里没有，本机也没装 OpenCode 桌面端。请重装完整安装包。');
  }
  const candidates = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = path.join(base, entry.name);
      return { dir, mtime: fs.statSync(dir).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  for (const { dir } of candidates) {
    const exe = path.join(dir, 'opencode-cli.exe');
    if (fs.existsSync(exe)) return exe;
  }
  throw new Error('找不到模型引擎（opencode-cli.exe）：安装包 vendor/ 里没有，OpenCode 桌面端的版本目录也是空的。请重装完整安装包。');
}

/**
 * 可选代理。
 *
 * 为什么需要：本机实测 `huggingface.co` / `router.huggingface.co` 被 DNS 投毒
 * （解析到 `2a03:2880:…:face:b00c` = Facebook 段），直连必失败；经 Clash 之类的
 * 本地代理才通。
 *
 * 为什么默认关闭：本来直连就通的 provider（openrouter 实测 200）不必绕一圈。
 * 要开就打 `QQ_BRIDGE_PROXY`，或写一个 `proxy.json`：`{ "url": "http://127.0.0.1:7897" }`。
 *
 * 关键：Node 24 的 `fetch` **默认不认** `HTTPS_PROXY`，必须同时设
 * `NODE_USE_ENV_PROXY=1`（实测：不设＝连接失败，设了＝正常返回）。
 */
export function proxyUrl() {
  if (process.env.QQ_BRIDGE_PROXY) return process.env.QQ_BRIDGE_PROXY;
  const file = path.join(ROOT, 'proxy.json');
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return typeof parsed?.url === 'string' && parsed.url ? parsed.url : null;
  } catch {
    return null;
  }
}

/**
 * 探活代理：能连上才启用。
 *
 * 这一步不是锦上添花 —— 没有它就有个很坑的失败模式：`proxy.json` 指向的 Clash
 * 一旦关掉，`HTTPS_PROXY` 就指向一个死端口，**连本来直连就通的 openrouter 也会一起挂掉**。
 * 本机真机上踩过这个坑：服务是在 Clash 开着时起的，之后 Clash 关掉，
 * 所有 provider 一起 `ConnectionRefused`，而且因为"连不上"当时被判成网络抖动，
 * 表现是**整轮静默失败**（用户什么都收不到），很难查。
 *
 * 所以启动前必须探一下，连不上就当没配代理。
 *
 * @returns {Promise<boolean>}
 */
export function probeProxy(url, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      resolve(false);
      return;
    }
    const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
    const socket = net.connect({ host: parsed.hostname, port });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/**
 * 构造隔离后的环境变量。
 *
 * 三件事：
 *  1. XDG_* 指向项目内 -> 独立的数据/配置/缓存/状态目录（本机实测 `debug paths` 生效），
 *     独立 opencode.db，QQ 会话不会混进桌面端的会话列表。
 *  2. 删掉桌面端注入的 OPENCODE* 身份变量。本机实测在它拉起的实例的 shell 工具里
 *     环境带着 OPENCODE=1 / OPENCODE_CLIENT=desktop / OPENCODE_SESSION_ID=ses_xxx /
 *     OPENCODE_TERMINAL=1 —— 这些指向前台会话，独立实例绝不能继承。
 *  3. （可选）接上代理，并保证回环地址不走代理。
 * @param {{ proxy?: string | null }} [options]
 *   `proxy` 传 `null` 表示"调用方已探活过，确认别用代理"；不传则按 `proxy.json` / 环境变量。
 */
export function isolatedEnv({ proxy: proxyOverride } = {}) {
  const env = { ...process.env };
  env.XDG_DATA_HOME = PATHS.data;
  env.XDG_CONFIG_HOME = PATHS.config;
  env.XDG_CACHE_HOME = PATHS.cache;
  env.XDG_STATE_HOME = PATHS.state;
  for (const key of [
    'OPENCODE',
    'OPENCODE_CLIENT',
    'OPENCODE_SESSION_ID',
    'OPENCODE_TERMINAL',
    'OPENCODE_DISABLE_EMBEDDED_WEB_UI',
    'OPENCODE_CLI_CONFIG_CONTENT',
  ]) {
    delete env[key];
  }
  // 代理：必须自己设 NO_PROXY，否则连本机 127.0.0.1:4599 的 API 也会被代理掉。
  const proxy = proxyOverride === undefined ? proxyUrl() : proxyOverride;
  if (proxy) {
    env.HTTPS_PROXY = proxy;
    env.HTTP_PROXY = proxy;
    env.NODE_USE_ENV_PROXY = '1';
    env.NO_PROXY = '127.0.0.1,localhost,::1';
    env.no_proxy = env.NO_PROXY;
  } else {
    for (const key of ['HTTPS_PROXY', 'HTTP_PROXY', 'NODE_USE_ENV_PROXY']) delete env[key];
    env.NO_PROXY = '127.0.0.1,localhost,::1';
  }
  // 注入密钥。放在删身份变量之后，避免被覆盖。
  for (const [key, value] of Object.entries(loadSecrets())) {
    if (typeof value === 'string' && value) env[key] = value;
  }
  return env;
}

/**
 * 读取密钥文件 `secrets.json`，形状是扁平的「环境变量名 -> 值」：
 *
 *   { "OPENROUTER_API_KEY": "sk-or-...", "DEEPSEEK_API_KEY": "sk-..." }
 *
 * 为什么用这个形状：模型 API 的 provider **全靠环境变量激活**
 * （实测 `DEEPSEEK_API_KEY=...` 就会让 deepseek provider 出现在模型目录里；
 * 其自带目录里 232 家 provider 全都是这个机制）。
 * 所以增/换/删任何一家的 key，都只改这一个文件，桥接代码零改动。
 *
 * 文件不存在时返回空对象而不报错 —— 没有 key 也能做不依赖模型的移植工作。
 */
export function loadSecrets() {
  const file = path.join(ROOT, 'secrets.json');
  if (!fs.existsSync(file)) return {};
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('secrets.json 顶层必须是「环境变量名 -> 值」的对象');
  }
  return parsed;
}

/** 服务基址。 */
export const baseUrl = `http://127.0.0.1:${PORT}`;
