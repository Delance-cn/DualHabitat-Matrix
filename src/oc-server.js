// 桥接专用 模型 API 实例的**生命周期**（④）。
//
// 这个模块回答一个问题：**"要用的那个 模型 API 到底在不在？不在就把它弄起来。"**
//
// 为什么必须由桥接自己管，而不是"让用户先手动起一个"：
//  1. 这是**专用隔离实例**（独立 XDG 目录、独立 opencode.db、固定 4599 端口），
//     不能蹭桌面端后台那个 —— 蹭了会话会混进桌面端的列表，密钥也归桌面端管。
//  2. 它比桥接活得久（detached）。所以"起来了吗"必须靠**注册文件 + 进程存活**判断，
//     而不能靠"我这次自己 spawn 的 child 句柄"。
//  3. 桥接重连时希望它是**幂等**的：已经在跑就复用，不在才起。
//
// 一个必须记住的坑（本机真机踩过）：服务是"当时的环境"起的，之后环境变了它不会知道。
// 最典型的是代理 —— Clash 开着时起的实例，Clash 关掉后它仍在把**所有** provider
// 请求发往那个死端口，表现是"整轮静默失败"。所以代理要在**起之前**探活。
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 包名改不了（`@opencode/client`），本地别名统一叫 `Sdk`；导出名必须是 `OpenCode`。
import { OpenCode as Sdk } from '@opencode/client';
import { Service } from '@opencode/client/service';
import { appendRotatedLogFile, rotateLogFile } from './log-rotate.js';

import {
  isolatedEnv,
  loadSecrets,
  probeProxy,
  proxyUrl,
  resolveCli,
  resolveModelInstance
} from './oc-env.js';
import { shimAlive } from './cf-shim.js';
import { loadModelPool, poolUsesProvider } from './model-pool.js';

/** src/ 目录（用来定位 cf-shim 入口）。 */
const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));

/** 等注册文件出现的最长时间。CLI 冷启动实测几秒，30 秒足够宽裕。 */
const REGISTER_TIMEOUT_MS = 30_000;
/** 等 shim 起来的最长时间。 */
const SHIM_TIMEOUT_MS = 8_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Stable digest of the actual secrets injected into the detached service; never persist raw keys. */
export function secretsFingerprint(secrets = loadSecrets()) {
  const entries = Object.entries(secrets)
    .filter(([, value]) => typeof value === 'string' && value)
    .sort(([left], [right]) => left.localeCompare(right));
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

export function secretsNeedReload(launchedFingerprint, currentFingerprint) {
  return launchedFingerprint !== currentFingerprint;
}

function readSecretsFingerprint(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

function writeSecretsFingerprint(fingerprint, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${fingerprint}\n`, 'utf8');
  fs.renameSync(temporary, file);
}

/** 进程还活着吗（0 号信号只做权限/存在性检查，不打扰进程）。 */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 读注册文件（不存在/坏了都返回 null，不抛）。 */
export function readServiceFile(file = resolveModelInstance().serviceFile) {
  try {
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 当前实例状态（不做任何副作用）。
 *
 * @returns {Promise<{ running: boolean, url?: string, pid?: number, version?: string, endpoint?: object, reason: string }>}
 */
export async function serverStatus({ serviceFile, instance } = {}) {
  const file = serviceFile ?? instance?.serviceFile ?? resolveModelInstance().serviceFile;
  const record = readServiceFile(file);
  if (!record) return { running: false, reason: '还没有注册文件（实例从没起来过）' };
  if (!record.url) return { running: false, reason: '注册文件里没有 url' };
  if (!pidAlive(Number(record.pid))) {
    return { running: false, pid: Number(record.pid), reason: `注册文件里的 pid ${record.pid} 已经不在了` };
  }
  // 进程活着不代表服务能应答（可能正在启动/半死）。真答一次才算数。
  try {
    const endpoint = await Service.discover({ file });
    if (!endpoint?.url) return { running: false, reason: 'Service.discover 没给出 url' };
    const client = Sdk.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });
    const info = await client.server.info();
    return {
      running: true,
      url: endpoint.url,
      pid: Number(record.pid),
      version: info?.version,
      endpoint,
      reason: 'ok'
    };
  } catch (error) {
    return {
      running: false,
      pid: Number(record.pid),
      reason: `进程在但服务不应答：${error?.message ?? error}`
    };
  }
}

/** 探活代理；连不上就当没配（见文件头那个坑）。 */
async function resolveProxy(log) {
  const proxy = proxyUrl();
  if (!proxy) return null;
  if (await probeProxy(proxy)) {
    log(`代理 ${proxy} 已探活，启用`);
    return proxy;
  }
  log(`⚠️ 代理 ${proxy} 连不上（Clash 没开？），本次**不启用**代理，直连的 provider 照常`);
  return null;
}

/** 端口上有没有东西在监听（不判断是不是我们的）。 */
export function portInUse(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (inUse) => {
      socket.destroy();
      resolve(inUse);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

export async function assertPortAvailable(port, checkPort = portInUse) {
  if (await checkPort(port)) {
    throw new Error(`模型 API 端口 ${port} 已被占用。请结束占用该端口的进程后重试。`);
  }
}

export function waitForSpawn(child, onRuntimeError) {
  return new Promise((resolve, reject) => {
    const onSpawn = () => {
      child.removeListener('error', onError);
      child.on('error', onRuntimeError);
      resolve(child);
    };
    const onError = (error) => {
      child.removeListener('spawn', onSpawn);
      reject(error);
    };
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
}

/** 读我们自己记的 pid 文件（读不到返回 NaN）。 */
function readPidFile(file) {
  try {
    return Number(fs.readFileSync(file, 'utf8').trim());
  } catch {
    return NaN;
  }
}

/**
 * 按需拉起 CF 兼容代理。
 *
 * 只在**模型池里真有 CF 模型**时才起 —— 少一个进程就少一个故障点，
 * 而且这个判断和"要不要把 CF 写进链里"是同一个判断，不会出现"起了没用"。
 */
async function ensureShim({ pool, log, instance }) {
  const active = instance ?? resolveModelInstance();
  const shim = active.shim;
  if (!poolUsesProvider(pool, 'cloudflare-workers-ai')) {
    return { needed: false, started: false, port: shim.port };
  }

  // 池子里有 CF，但 opencode.json 的 CF baseURL 没指到 shim 上的话，
  // CF 那条链注定每次失败。这不是致命错误（链会自动熔断跳过去），
  // 但一定要吼出来，否则会变成"CF 明明配了却从来没用上"。
  checkCfWiring(log, active);

  if (await shimAlive(shim.port)) {
    log(`cf-shim 已在运行（${shim.baseUrl}）`);
    return { needed: true, started: false, port: shim.port, ready: true };
  }

  // 端口被占着、但健康检查不过 —— 真机踩过：那是**旧版本**的 shim
  // （没有 /health 路由）。这时闷头再起一个只会 `EADDRINUSE` 崩掉，
  // 而且崩得很快，看起来像"shim 起了但没生效"，很难查。
  if (await portInUse(shim.port)) {
    const stalePid = readPidFile(shim.pidFile);
    if (pidAlive(stalePid)) {
      log(`端口 ${shim.port} 被旧 shim 占着（pid=${stalePid}，健康检查不过），先收掉它`);
      try {
        process.kill(stalePid);
        const deadline = Date.now() + 5000;
        while ((await portInUse(shim.port, 300)) && Date.now() < deadline) await sleep(200);
      } catch (error) {
        log(`收掉旧 shim 失败：${error?.message ?? error}`);
      }
    }
    if (await portInUse(shim.port)) {
      log(
        `⚠️ 端口 ${shim.port} 被别的进程占着，而且不是我们认识的 cf-shim（健康检查不过）。` +
          `CF 候选这轮会失败（链会自动跳到下一个）。请先结束占用该端口的进程，或改 SHIM_PORT。`
      );
      return { needed: true, started: false, port: shim.port, ready: false, blocked: true };
    }
  }

  fs.mkdirSync(active.paths.logs, { recursive: true });
  const out = fs.openSync(path.join(active.paths.logs, 'cf-shim.out.log'), 'a');
  const err = fs.openSync(path.join(active.paths.logs, 'cf-shim.err.log'), 'a');
  const child = spawn(process.execPath, [path.join(SRC_DIR, 'cf-shim-main.js')], {
    cwd: active.configDir,
    env: { ...process.env, QQ_BRIDGE_SHIM_PORT: String(shim.port), QQ_BRIDGE_SHIM_LOG: shim.logFile },
    detached: true,
    windowsHide: true,
    stdio: ['ignore', out, err]
  });
  child.unref();
  fs.mkdirSync(path.dirname(shim.pidFile), { recursive: true });
  fs.writeFileSync(shim.pidFile, String(child.pid));
  log(`cf-shim 已启动 pid=${child.pid}（模型池里有 CF 模型才起）`);

  const deadline = Date.now() + SHIM_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await shimAlive(shim.port)) return { needed: true, started: true, port: shim.port, pid: child.pid, ready: true };
    await sleep(200);
  }
  log(
    `⚠️ cf-shim ${SHIM_TIMEOUT_MS}ms 内没应答（pid=${child.pid}）。看日志：` +
      `${path.join(active.paths.logs, 'cf-shim.err.log')}`
  );
  return { needed: true, started: true, port: shim.port, pid: child.pid, ready: false };
}

/**
 * 读模型 API 的配置文件，确认 CF 的 baseURL 指到了 shim。
 * 只告警，不拦。
 */
function checkCfWiring(log, instance) {
  const active = instance ?? resolveModelInstance();
  try {
    if (!fs.existsSync(active.configFile)) return;
    const config = JSON.parse(fs.readFileSync(active.configFile, 'utf8'));
    const base = config?.provider?.['cloudflare-workers-ai']?.options?.baseURL;
    if (base !== active.shim.baseUrl) {
      log(
        `⚠️ 模型池里有 CF 模型，但配置文件里 cloudflare-workers-ai 的 baseURL ` +
          `不是 ${active.shim.baseUrl}（当前：${base ?? '未设置'}）—— CF 候选会一直失败。` +
          `这一步由配置生成器（②）负责写入。`
      );
    }
  } catch (error) {
    log(`⚠️ 读模型 API 配置文件失败：${error?.message ?? error}`);
  }
}

/**
 * 确保实例在跑。**幂等**：已经在跑就复用，不在才起。
 *
 * @param {object} [options]
 * @param {boolean} [options.force]     即使已在跑也重启（换配置/换 key 后用）
 * @param {boolean} [options.withShim]  是否按模型池拉起 cf-shim（默认是）
 * @param {object}  [options.pool]      直接给模型池（不给则读 models.json）
 * @param {Function} [options.log]
 * @returns {Promise<{ started: boolean, url: string, pid?: number, version?: string, endpoint?: object, shim: object }>}
 */
export async function ensureServer(options = {}) {
  const log = options.log ?? ((m) => console.log(m));
  const instance = options.instance ?? resolveModelInstance();
  const port = options.port ?? instance.port;
  let currentSecretsFingerprint = null;
  let secretsLoadError = null;
  try {
    currentSecretsFingerprint = secretsFingerprint();
  } catch (error) {
    secretsLoadError = error;
  }

  if (options.force) {
    log('force=true，先停掉现有实例');
    await stopServer({ log, instance, stopShim: false });
  } else {
    const status = await serverStatus({ instance });
    if (status.running) {
      if (secretsLoadError) {
        log(`⚠️ 无法读取密钥配置，保留当前运行实例：${secretsLoadError?.message ?? secretsLoadError}`);
        const pool = options.pool ?? loadModelPool().pool;
        const shim = options.withShim === false
          ? { needed: false, started: false }
          : await ensureShim({ pool, log, instance });
        return { started: false, url: status.url, pid: status.pid, version: status.version, endpoint: status.endpoint, shim };
      } else if (secretsNeedReload(readSecretsFingerprint(instance.secretsFingerprintFile), currentSecretsFingerprint)) {
        log('检测到已保存的 API 密钥与运行实例环境不一致，重启模型 API 服务以应用密钥');
        await stopServer({ log, instance, stopShim: false });
      } else {
        log(`模型 API 服务已在运行（pid=${status.pid} version=${status.version}）`);
        const pool = options.pool ?? loadModelPool().pool;
        const shim = options.withShim === false
          ? { needed: false, started: false }
          : await ensureShim({ pool, log, instance });
        return { started: false, url: status.url, pid: status.pid, version: status.version, endpoint: status.endpoint, shim };
      }
    }
    if (!status.running) {
      if (secretsLoadError) throw secretsLoadError;
      log(`实例不在运行（${status.reason}），开始拉起`);
    }
  }

  const launchedSecretsFingerprint = currentSecretsFingerprint;
  await assertPortAvailable(port);
  const proxy = await resolveProxy(log);
  const pool = options.pool ?? loadModelPool().pool;
  const shim =
    options.withShim === false ? { needed: false, started: false } : await ensureShim({ pool, log, instance });

  const cli = resolveCli();
  fs.mkdirSync(instance.paths.logs, { recursive: true });
  const outFile = path.join(instance.paths.logs, 'server.out.log');
  const errFile = path.join(instance.paths.logs, 'server.err.log');
  rotateLogFile(outFile);
  rotateLogFile(errFile);
  // --service 是必须的：只有这个模式才会把 { url, pid, password } 写进
  // $XDG_STATE_HOME/opencode/service.json。裸 serve 只在 stdout 打印密码，
  // 而桥接需要一份可读、可重启后重建的长期凭据。
  let child;
  try {
    child = spawn(
      cli,
      ['serve', '--service', '--hostname', '127.0.0.1', '--port', String(port)],
      {
        cwd: instance.configDir,
        env: isolatedEnv({ proxy, instance }),
        detached: true,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      }
    );
    for (const [stream, file] of [[child.stdout, outFile], [child.stderr, errFile]]) {
      stream.on('data', (chunk) => {
        try {
          appendRotatedLogFile(file, chunk);
        } catch (error) {
          log(`写模型 API 日志失败（${path.basename(file)}）：${error?.message ?? error}`);
        }
      });
      stream.on('error', (error) => log(`读取模型 API 日志失败（${path.basename(file)}）：${error?.message ?? error}`));
    }
    await waitForSpawn(child, (error) => log(`模型 API CLI 子进程错误：${error?.message ?? error}`));
  } catch (error) {
    throw new Error(
      `无法启动模型 API CLI（${cli}）：${error?.message ?? error}`,
      { cause: error }
    );
  }
  child.unref();
  log(`模型 API 服务启动中 pid=${child.pid} port=${port}`);

  const deadline = Date.now() + REGISTER_TIMEOUT_MS;
  let lastReason = '没等到注册文件';
  while (Date.now() < deadline) {
    const record = readServiceFile(instance.serviceFile);
    // 必须是**这个** pid 写的，不然会读到上一次残留的注册文件
    if (record && Number(record.pid) === child.pid && record.url) {
      const status = await serverStatus({ instance });
      if (status.running) {
        writeSecretsFingerprint(launchedSecretsFingerprint, instance.secretsFingerprintFile);
        log(`实例就绪：${status.url} version=${status.version} pid=${status.pid}`);
        return { started: true, url: status.url, pid: status.pid, version: status.version, endpoint: status.endpoint, shim };
      }
      lastReason = status.reason;
    } else if (record?.pid && Number(record.pid) !== child.pid) {
      lastReason = `注册文件还是旧实例的（pid=${record.pid}）`;
    }
    if (!pidAlive(child.pid)) {
      throw new Error(
        `模型 API 服务启动后立刻退出（pid=${child.pid}）。看日志：${path.join(instance.paths.logs, 'server.err.log')}`
      );
    }
    await sleep(250);
  }
  throw new Error(
    `等 模型 API 实例就绪超时（${REGISTER_TIMEOUT_MS}ms，最后状态：${lastReason}）。` +
      `日志：${path.join(instance.paths.logs, 'server.out.log')}`
  );
}

/**
 * 停掉实例（默认连同由我们拉起的 cf-shim）。
 *
 * 只停**注册文件里记着的那个 pid** —— 不按端口杀进程，避免误杀用户桌面端的实例。
 * 两个平台共用同一个 cf-shim，所以单独停 QQ/微信时传 `stopShim: false`，
 * 只在最后一个实例退出时再收 shim。
 */
export async function stopServer({ log = (m) => console.log(m), instance, stopShim = true } = {}) {
  const active = instance ?? resolveModelInstance();
  const result = { server: false, shim: false };

  const record = readServiceFile(active.serviceFile);
  const pid = Number(record?.pid);
  if (pidAlive(pid)) {
    try {
      process.kill(pid);
      result.server = true;
      log(`已停模型 API 服务 pid=${pid}（${active.label}）`);
      // 等它真的退出，否则紧接着重启会撞端口
      const deadline = Date.now() + 10_000;
      while (pidAlive(pid) && Date.now() < deadline) await sleep(200);
      if (pidAlive(pid)) log(`⚠️ pid=${pid} 10 秒内没退出，可能还占着 ${active.port}`);
    } catch (error) {
      log(`停 pid=${pid} 失败：${error?.message ?? error}`);
    }
  } else {
    log(`没有在跑的模型 API 服务（${active.label}，运行数据缺失或进程已不在）`);
  }

  if (stopShim) result.shim = await stopShimService({ log, instance: active });
  // 注册文件留着没意义，删掉能避免"看着像在跑"的误判
  try {
    fs.rmSync(active.serviceFile, { force: true });
  } catch {
    /* 删不掉也无妨，pidAlive 会拦住 */
  }
  return result;
}

/** 单独停 cf-shim（两个实例共用；只在全部实例都停了以后调用）。 */
export async function stopShimService({ log = (m) => console.log(m), instance } = {}) {
  const active = instance ?? resolveModelInstance();
  const shim = active.shim;
  const shimPid = readPidFile(shim.pidFile);
  if (pidAlive(shimPid)) {
    try {
      process.kill(shimPid);
      log(`已停 cf-shim pid=${shimPid}`);
      const deadline = Date.now() + 5000;
      while ((await portInUse(shim.port, 300)) && Date.now() < deadline) await sleep(200);
      return true;
    } catch (error) {
      log(`停 cf-shim pid=${shimPid} 失败：${error?.message ?? error}`);
      return false;
    }
  }
  if (await shimAlive(shim.port)) {
    // 在跑但不是我们记的 pid（比如是从上一版手工起的）。至少要说清楚，
    // 不然会出现"shim 还在转发、但我们以为已经停了"这种鬼状态。
    log(`⚠️ cf-shim 还在 ${shim.port} 上应答，但 ${shim.pidFile} 里的 pid 无效，无法安全地停它`);
  }
  return false;
}
