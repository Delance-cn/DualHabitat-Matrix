/**
 * desktop/server.mjs —— 桌面端的本地服务。
 *
 * 为什么不是一个纯前端包：这个软件要干的事（起子进程、读配置文件、发真请求测连通）
 * 浏览器里做不了，必须有个本地后端。Electron 主进程直接 import 它起服务，
 * 窗口 loadURL 到本地端口 —— 同源，省掉 CORS 和 preload 通信。
 *
 * 没有 Electron 也能单独跑：`node server.mjs`，浏览器打开 http://127.0.0.1:3200
 */

import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { reloadSecretsInRunningServer, saveSecretsAndApply } from './secrets-reload.mjs';
import { validateDirectoryPath } from './path-validation.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * 桥接源码的默认位置。
 *
 * 开发态：`desktop/` 的上一级就是项目根（src/ 在那儿）。
 * 打包态：代码在 `resources/app/`，项目根不在包里 —— 桥接本体是 build-green.mjs
 * 另外拷到 `resources/bridge/` 的，所以先认那个。不认的话，别人拿到包点「启动」
 * 会得到 Cannot find module ...\src\bridge.js。
 */
const DEFAULT_ROOT = (() => {
  const bundled = path.resolve(here, '..', 'bridge');
  if (fs.existsSync(path.join(bundled, 'src', 'bridge.js'))) return bundled;
  return path.resolve(here, '..');
})();
const PUBLIC = path.join(here, 'public');

/**
 * 后端代码从哪加载。
 *
 * 开发态读 `../src/backends/`（跟主项目共用一份源码）；
 * 打包后 `../src` 在包外，读 `./vendor/backends/`（由 scripts/prepare-vendor.mjs 复制进来）。
 * 两份内容完全一样，只是路径不同。
 */
const vendorBackends = path.join(here, 'vendor', 'backends');
const backendsRoot = fs.existsSync(vendorBackends) ? vendorBackends : path.resolve(here, '..', 'src', 'backends');
const loadBackend = (file) => import(pathToFileURL(path.join(backendsRoot, file)).href);

const { listProviders, resolveProfile, listModels, modelProfileKeyEnv } = await loadBackend('providers.js');
const MODEL_PROVIDER_CATALOG = new Map(listProviders().map((provider) => [provider.id, provider]));
// 这些 provider 由配置生成器按自己的 id 写定义（本地端口可覆盖，MiniMax/方舟是兼容端点），
// 不需要再套 dhm-<slot>-relay，也不应该给它们写按档位独立的 keyEnv。
const NON_RELAY_PROVIDER_IDS = new Set(['lmstudio', 'ollama', 'vllm', 'llamacpp', 'jan', 'minimax', 'volcengine']);
const { streamChat } = await loadBackend('protocols.js');
const { DRIVERS, UNVERIFIED } = await loadBackend('cli/drivers.js');
const { resolveBin } = await loadBackend('cli/engine.js');

/**
 * QQ 多号的账号模型、端口分配、配置形状都跟桥接共用一份实现。
 *
 * 桌面端绝不能自己再算一套端口/账号 id：桥接读的是 config.json 里的
 * platforms.qq.accounts，桌面端写进去的每个字段都必须和它理解的一致。
 * 打包态桥接在 resources/bridge，开发态在仓库根，两处都认。
 */
const qqAccountsFile = fs.existsSync(path.join(DEFAULT_ROOT, 'src', 'qq-accounts.js'))
  ? path.join(DEFAULT_ROOT, 'src', 'qq-accounts.js')
  : path.resolve(here, '..', 'src', 'qq-accounts.js');
const {
  DEFAULT_ACCOUNT_ID,
  accountPorts,
  nextAccountId,
  normalizeQQAccounts,
  toConfigAccount,
  isValidAccountId
} = await import(pathToFileURL(qqAccountsFile).href);

/**
 * 模型能力分类和桥接共用一份实现：模型池页的分类栏、视觉兜底路由
 * 不能各判各的，否则控制台标「视觉」、桥接却当纯文本跳过。
 */
const modelCapabilitiesFile = fs.existsSync(path.join(DEFAULT_ROOT, 'src', 'model-capabilities.js'))
  ? path.join(DEFAULT_ROOT, 'src', 'model-capabilities.js')
  : path.resolve(here, '..', 'src', 'model-capabilities.js');
const { describeModelCategory } = await import(pathToFileURL(modelCapabilitiesFile).href);

/**
 * 桌面端自己的设置（不进版本库）。
 * 为什么不放 config.json：那是桥接的配置，混进 UI 状态会互相污染。
 *
 * 路径由主进程通过 DHM_SETTINGS 注入 —— 打包后应用目录在 asar 里是只读的，
 * 必须写到 userData。开发态没这个环境变量，就落在 desktop/ 下。
 */
const SETTINGS_FILE = process.env.DHM_SETTINGS || path.join(here, 'settings.json');

/**
 * 桥接的工作目录。
 *
 * 桌面端代码放在 A 目录，但真正在跑的那份可能在 B 目录（比如 C:\Users\<用户>\DualHabitatMatrix）。
 * 所以所有配置路径都要跟着这里走，不能写死成 DEFAULT_ROOT。
 */
function getRoot() {
  const settings = readJson(SETTINGS_FILE);
  const raw = typeof settings.bridgeRoot === 'string' ? settings.bridgeRoot.trim() : '';
  if (raw) {
    // 用户可能粘贴成 C:/xxx 或带重复斜杠，path.resolve 会规范化成 Windows 形式
    const resolved = path.resolve(raw);
    if (fs.existsSync(resolved)) return resolved;
  }
  return DEFAULT_ROOT;
}

/**
 * 数据根：config.json / secrets.json / models.local.json / state/ / audio/ / roles/ / plugins/ / .oc/
 * 这些运行时数据的落点。0.4.5 及之前数据和代码都挤在安装目录 resources\bridge 里，
 * 老版卸载器清安装目录时会把模型池、微信登录态一起带走（用户每升一次级就要重配一遍）。
 * 现在打包态把数据根挪到 userData\bridge-data（%APPDATA%，不随升级动），
 * 由 QQ_BRIDGE_DATA 注入给桥接侧（见 nodeRunner）；开发态数据根 = 代码根，行为不变。
 */
const DATA_HOME_OVERRIDE = (process.env.DHM_DATA_HOME ?? '').trim();
let cachedDataRoot = null;
function dataRoot() {
  if (DATA_HOME_OVERRIDE) {
    // 测试/特殊布局：DHM_DATA_HOME 指哪建哪（seedBridgeData / writeJson 不会自己建目录）
    const resolved = path.resolve(DATA_HOME_OVERRIDE);
    try { fs.mkdirSync(resolved, { recursive: true }); } catch { /* 建不出来交给写入时报人话 */ }
    return resolved;
  }
  if (electronApp?.isPackaged) {
    if (!cachedDataRoot) {
      cachedDataRoot = path.join(electronApp.getPath('userData'), 'bridge-data');
      // 数据根目录必须先建出来：seedBridgeData / writeJson 都是直接写文件，不会自己建目录
      try { fs.mkdirSync(cachedDataRoot, { recursive: true }); } catch { /* 建不出来交给写入时报人话 */ }
    }
    return cachedDataRoot;
  }
  // 开发态（含 node server.mjs 裸跑）：数据和代码同目录（仓库根），与 0.4.5 行为完全一致。
  return getRoot();
}

/**
 * 旧数据迁移（打包态兜底）：安装器 customInit 的抢救是第一道（旧卸载器清目录之前搬），
 * 这里是第二道 —— 万一数据还留在代码根（比如手动覆盖安装、绿色部署），启动时搬进数据根。
 * 只搬「新根没有、旧根有」的，绝不覆盖新数据。测试实例（DHM_DATA_HOME）绝不迁移。
 */
function migrateLegacyData() {
  const from = getRoot();
  const to = dataRoot();
  if (path.resolve(from) === path.resolve(to)) return;
  const files = ['config.json', 'secrets.json', 'models.local.json', 'models.json', 'opencode.json', 'proxy.json', 'notify-hub.json'];
  const dirs = ['state', 'audio', 'roles', 'plugins', '.oc'];
  let copied = 0;
  for (const f of files) {
    const src = path.join(from, f);
    const dst = path.join(to, f);
    if (fs.existsSync(src) && !fs.existsSync(dst)) {
      try {
        if (copyPathIfMissing(src, dst)) copied++;
      } catch (error) {
        console.warn(`[data-root] 复制 ${src} 失败：${error?.message ?? error}`);
      }
    }
  }
  for (const d of dirs) {
    const src = path.join(from, d);
    const dst = path.join(to, d);
    if (!fs.existsSync(src)) continue;
    if (!fs.existsSync(dst)) {
      try {
        if (copyPathIfMissing(src, dst)) copied++;
      } catch (error) {
        console.warn(`[data-root] 复制 ${src} 失败：${error?.message ?? error}`);
      }
    } else if (d === 'roles' || d === 'plugins') {
      // Bundled defaults may gain new files between releases. Add only missing
      // examples so updates reach existing installs without overwriting edits.
      try {
        fs.cpSync(src, dst, { recursive: true, force: false, errorOnExist: false });
        copied++;
      } catch (error) {
        console.warn(`[data-root] 合并默认目录 ${src} 失败：${error?.message ?? error}`);
      }
    }
  }
  if (copied) console.log(`[data-root] 已从代码根复制 ${copied} 项数据到 ${to}（原目录保留）`);
}

function copyPathIfMissing(src, dst) {
  if (!fs.existsSync(src) || fs.existsSync(dst)) return false;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const temp = path.join(
    path.dirname(dst),
    `.${path.basename(dst)}.migration-${process.pid}-${randomBytes(8).toString('hex')}`
  );
  try {
    if (fs.statSync(src).isDirectory()) fs.cpSync(src, temp, { recursive: true });
    else fs.copyFileSync(src, temp);
    if (fs.existsSync(dst)) {
      fs.rmSync(temp, { recursive: true, force: true });
      return false;
    }
    fs.renameSync(temp, dst);
    return true;
  } catch (error) {
    try {
      fs.rmSync(temp, { recursive: true, force: true });
    } catch {
      // Keep the copy/rename error as the actionable failure.
    }
    throw error;
  }
}

let electronApp = null;
try {
  if (process.versions.electron) electronApp = (await import('electron')).app;
} catch {
  electronApp = null;
}

// 打包态：进程级注入数据根 —— 本进程动态 import 的 oc-* 与 spawn 出去的桥接/微信/oc-config
// 全部对齐到同一个数据根；随后做一次旧数据迁移（安装器抢救的兜底）。
if (electronApp?.isPackaged && !DATA_HOME_OVERRIDE && !process.env.QQ_BRIDGE_DATA) {
  process.env.QQ_BRIDGE_DATA = dataRoot();
}
if (electronApp?.isPackaged && !DATA_HOME_OVERRIDE) migrateLegacyData();

/** 代码根：src / vendor / upstream / node_modules / config.example.json（随包分发）。 */
const codeRoot = () => getRoot();

const configFile = () => path.join(dataRoot(), 'config.json');
const secretsFile = () => path.join(dataRoot(), 'secrets.json');
const exampleFile = () => path.join(codeRoot(), 'config.example.json');

async function reloadRunningModelServiceForSecrets() {
  const previousDataRoot = process.env.QQ_BRIDGE_DATA;
  const previousStateDir = process.env.QQ_BRIDGE_STATE_DIR;
  const previousPlatform = process.env.QQ_BRIDGE_MODEL_PLATFORM;
  process.env.QQ_BRIDGE_DATA = dataRoot();
  delete process.env.QQ_BRIDGE_MODEL_PLATFORM;
  process.env.QQ_BRIDGE_STATE_DIR = matrixStateDir('qq');
  try {
    const bridgeRoot = codeRoot();
    const runtime = await import(pathToFileURL(path.join(bridgeRoot, 'src', 'oc-server.js')).href);
    const envModule = await import(pathToFileURL(path.join(bridgeRoot, 'src', 'oc-env.js')).href);
    const results = [];
    for (const platform of ['qq', 'wechat']) {
      const instance = envModule.resolveModelInstance(platform, { root: dataRoot(), useEnv: false });
      results.push(
        await reloadSecretsInRunningServer({
          serverStatus: (options = {}) => runtime.serverStatus({ ...options, instance }),
          stopServer: (options = {}) => runtime.stopServer({ ...options, instance, stopShim: false })
        })
      );
    }
    return {
      applied: false,
      pending: true,
      reloadRequested: results.some((result) => result.reloadRequested === true),
      instances: results
    };
  } finally {
    if (previousDataRoot === undefined) delete process.env.QQ_BRIDGE_DATA;
    else process.env.QQ_BRIDGE_DATA = previousDataRoot;
    if (previousStateDir === undefined) delete process.env.QQ_BRIDGE_STATE_DIR;
    else process.env.QQ_BRIDGE_STATE_DIR = previousStateDir;
    if (previousPlatform === undefined) delete process.env.QQ_BRIDGE_MODEL_PLATFORM;
    else process.env.QQ_BRIDGE_MODEL_PLATFORM = previousPlatform;
  }
}


const PORT = Number(process.env.DHM_DESKTOP_PORT ?? 3200);

/* ══════════════════════════════════════════════════════════════════════════
 * 一、配置读写
 * ══════════════════════════════════════════════════════════════════════════ */

function readJson(file, fallback = {}) {
  try {
    if (!fs.existsSync(file)) return fallback;
    // PowerShell 5.1 的 `Set-Content -Encoding utf8` / 记事本"UTF-8"都带 BOM，
    // 而 JSON.parse 见到 \uFEFF 直接抛 —— 不剥掉就会静默退回默认配置，
    // 表现为"我明明改了 settings.json，界面却当没改"。
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

/**
 * 整文件写 JSON —— 原子替换，不是直接覆盖。
 *
 * 直接 writeFileSync 一旦在写到一半时断电 / 被杀 / 磁盘满，留下的是**截断的
 * 半份配置**：下次启动 JSON.parse 直接抛，整份 settings / config 读不回来。
 * 所以先写同目录临时文件再 rename。Windows 上目标可能被 Defender / 编辑器 /
 * 云同步按住（EPERM/EBUSY），照 src/bridge.js 的 renameWithRetry 退避重试几轮；
 * 实在过不去才退回直接覆盖，并且清掉临时文件别留在目录里。
 */
function writeJson(file, data) {
  const text = `${JSON.stringify(data, null, 2)}\n`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  for (let i = 0; i < 4; i += 1) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (error) {
      const retryable = error?.code === 'EPERM' || error?.code === 'EBUSY' || error?.code === 'EACCES';
      if (!retryable) {
        try { fs.unlinkSync(tmp); } catch { /* 临时文件删不掉不掩盖原错误 */ }
        throw error;
      }
      // 同步忙等：这里都在请求/启动路径上，不值得为它改成异步
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40 * (i + 1)); } catch { /* 老 runtime 没有 Atomics.wait 就纯重试 */ }
    }
  }
  try {
    fs.writeFileSync(file, text, 'utf8');
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* 同上 */ }
  }
}

/**
 * 从旧版（改名之前）的 userData 搬设置。
 *
 * Electron 的 userData 目录是按 app 名取的，改名连目录都换了：
 *   旧：%APPDATA%\qqbridge-desktop
 *   新：%APPDATA%\dualhabitat-matrix-desktop
 * 不搬的话，装上新版会像「全新安装」—— 旧版的 NapCat 路径、QQ 号、开机自启这些全看不见。
 * 只在新的 settings.json 还不存在时搬一次，搬完写 migratedFrom 做标记。
 */
const LEGACY_USERDATA = ['qqbridge-desktop', 'DualHabitatMatrix-desktop', 'QQbridge-TEST', 'DualHabitat Matrix'];
const MIGRATE_FILES = ['settings.json', 'automation.json'];

function migrateLegacyUserData() {
  if (fs.existsSync(SETTINGS_FILE)) return null;

  const dir = path.dirname(SETTINGS_FILE);
  const appData = path.dirname(dir);

  for (const name of LEGACY_USERDATA) {
    const from = path.join(appData, name);
    if (!fs.existsSync(path.join(from, 'settings.json'))) continue;

    const copied = [];
    try {
      fs.mkdirSync(dir, { recursive: true });
      for (const f of MIGRATE_FILES) {
        const src = path.join(from, f);
        if (!fs.existsSync(src)) continue;
        fs.copyFileSync(src, path.join(dir, f));
        copied.push(f);
      }

      // 旧 bridgeRoot 指向改名前的目录（qqbridge），早没了。
      // 留着只会让「桥接根目录」显示成一个不存在的路径，删掉回落到默认根目录。
      const s = readJson(SETTINGS_FILE);
      const root = typeof s.bridgeRoot === 'string' ? path.resolve(s.bridgeRoot.replace(/\/+/g, '\\')) : '';
      if (s.bridgeRoot && !fs.existsSync(root)) delete s.bridgeRoot;
      s.migratedFrom = name;
      s.migratedAt = Date.now();
      writeJson(SETTINGS_FILE, s);
    } catch (err) {
      console.log(`[migrate] 从 ${name} 搬设置失败：${err.message}`);
      continue;
    }

    console.log(`[migrate] 从 ${name} 搬了 ${copied.join(', ') || '（没有可搬的文件）'}`);
    return name;
  }
  return null;
}

migrateLegacyUserData();

/**
 * 首次运行时把默认设置铺出来。
 *
 * 打包版的设置落在 userData（AppData\Roaming\DualHabitatMatrix-desktop），和开发时那份
 * desktop/settings.json 不是同一个文件 —— 不铺的话第一次打开 QQ 号、桥接目录全是空的。
 * 打包时会把 desktop/settings.json 复制成 default-settings.json 一起带进去。
 */
function seedSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) return;
    const seed = readJson(path.join(here, 'default-settings.json'), null);
    if (!seed) return;
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    writeJson(SETTINGS_FILE, seed);
  } catch {
    // 铺不出来也不影响启动，用户手填就是了
  }
}

seedSettings();

/* 桥接的 config.json 不随包发布（里面有 QQ 号、白名单、模型选择），首次运行
 * 必须从模板铺一份。少了这一步，「一键启动」会在 bridge.js 里直接 ENOENT 退出，
 * 界面上只看到「桥接已退出（code 1）」。
 *
 * 如果这台机器上还留着旧版的桥接目录，优先把它的 config.json / secrets.json
 * 搬过来 —— 升级不该让用户重新配一遍。 */
function legacyBridgeRoots() {
  const found = [];
  const seen = new Set();
  const add = (raw) => {
    if (!raw) return;
    try {
      const dir = path.resolve(String(raw).replace(/\/+/g, path.sep));
      if (seen.has(dir)) return;
      if (!fs.existsSync(path.join(dir, 'config.json'))) return;
      seen.add(dir);
      found.push(dir);
    } catch {
      /* 路径非法就当没看见 */
    }
  };

  // 1. 旧版 settings.json 里记的 bridgeRoot（迁移时只删了失效的那条，文件还在）
  const appData = path.dirname(path.dirname(SETTINGS_FILE));
  for (const name of LEGACY_USERDATA) {
    const legacy = readJson(path.join(appData, name, 'settings.json'), null);
    if (legacy && typeof legacy.bridgeRoot === 'string') add(legacy.bridgeRoot);
  }

  // 2. 以前手动放桥接的几个常见位置
  add(path.join(os.homedir(), 'qqbridge'));
  add(path.join(os.homedir(), 'DualHabitatMatrix'));

  // 3. Programs 下旧版安装包自带的 resources\bridge
  const programs = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs') : '';
  if (programs && fs.existsSync(programs)) {
    for (const name of fs.readdirSync(programs)) {
      add(path.join(programs, name, 'resources', 'bridge'));
    }
  }
  return found;
}

function seedBridgeData() {
  const root = dataRoot();
  const config = path.join(root, 'config.json');
  if (fs.existsSync(config)) return null;

  for (const legacy of legacyBridgeRoots()) {
    if (path.resolve(legacy) === path.resolve(root)) continue;
    try {
      fs.copyFileSync(path.join(legacy, 'config.json'), config);
      const secrets = path.join(legacy, 'secrets.json');
      if (fs.existsSync(secrets) && !fs.existsSync(path.join(root, 'secrets.json'))) {
        fs.copyFileSync(secrets, path.join(root, 'secrets.json'));
      }
      return { from: legacy };
    } catch {
      // 这个目录读不了就试下一个
    }
  }

  const example = path.join(codeRoot(), 'config.example.json');
  try {
    if (fs.existsSync(example)) {
      fs.copyFileSync(example, config);
      return { from: 'config.example.json' };
    }
  } catch {
    /* 安装目录不可写：交给 startBridge 报错，别在这里把整个服务带崩 */
  }
  return null;
}

const bridgeSeed = seedBridgeData();
if (bridgeSeed) console.log(`[bridge] 已从 ${bridgeSeed.from} 生成 config.json`);

function loadConfig() {
  const cfg = fs.existsSync(configFile()) ? readJson(configFile()) : readJson(exampleFile());
  return normalizeBackendKey(cfg ?? {});
}

/**
 * 2026-10 改名：内置实例那段配置以前叫 `opencode`（拿引擎的名字当了键），
 * 现在叫 `matrix`。老 config.json 里还是旧键 —— 读的时候认一次，
 * 让老配置不改也能跑；保存时只写新键，旧键顺手删掉（见 PUT /api/matrix）。
 */
function normalizeBackendKey(cfg) {
  if (cfg.matrix == null && cfg.opencode != null) cfg.matrix = cfg.opencode;
  delete cfg.opencode;
  return cfg;
}

/* ══════════════════════════════════════════════════════════════════════════
 * 模型配置分档（2026-10-20）
 *
 * 以前模型只有全局一份（backend.modelApi），QQ 和微信共用同一套厂商、密钥
 * 和参数。实际上两边的用法完全不同：群里闲聊要快而便宜的模型，用户发指令
 * 要能调工具、能读文件的模型。
 *
 * 现在按「平台 × 用途」拆成四档：
 *   qq.chat     QQ 聊天        —— 只说话，不给工具
 *   qq.work     QQ 聊天+指令   —— 能调工具、读文件
 *   wechat.chat 微信聊天
 *   wechat.work 微信聊天+指令
 *
 * 旧配置不迁移也能跑：没有 profiles 时，backend.modelApi 自动当成 qq.chat。
 * 保存时同时回写 modelApi，让只认旧字段的桥接侧不至于读不到配置。
 * ══════════════════════════════════════════════════════════════════════════ */

const MODEL_SLOTS = { qq: ['chat', 'work'], wechat: ['chat', 'work'] };

const MODEL_PROFILE_FIELDS = [
  'provider',
  'protocol',
  'baseUrl',
  'model',
  'apiKeyEnv',
  'temperature',
  'maxTokens',
  'maxHistory',
  'timeoutMs',
  'maxContextChars',
  'anthropicVersion',
  'allowTools',
  'maxToolRounds',
  'workspaceDir'
];

const MODEL_PROFILE_NUMBERS = new Set([
  'temperature',
  'maxTokens',
  'maxHistory',
  'timeoutMs',
  'maxContextChars',
  'maxToolRounds'
]);

/**
 * 单档模型配置的白名单清洗。只留认识的字段，其余一律丢掉 —— 这个对象
 * 来自 HTTP 请求体，不能原样落盘。
 * @returns {object|null} 清洗后的配置；没有有效字段时返回 null
 */
function sanitizeModelProfile(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const k of MODEL_PROFILE_FIELDS) {
    const v = raw[k];
    if (v === undefined || v === null || v === '') continue;
    if (k === 'allowTools') {
      out[k] = v === true;
      continue;
    }
    if (k === 'apiKeyEnv') {
      const env = String(v).trim();
      if (/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(env)) out[k] = env;
      continue;
    }
    if (MODEL_PROFILE_NUMBERS.has(k)) {
      const n = Number(v);
      if (Number.isFinite(n)) out[k] = n;
      continue;
    }
    out[k] = String(v).slice(0, 2000);
  }
  return Object.keys(out).length ? out : null;
}

/**
 * 读出四档配置。缺失的档位不补空对象，交给调用方判断「还没配」。
 * 旧字段 backend.modelApi 兜底到 qq.chat。
 */
function readModelProfiles() {
  const cfg = loadConfig();
  const stored = cfg.backend?.profiles ?? {};
  const out = {};
  for (const [pf, slots] of Object.entries(MODEL_SLOTS)) {
    out[pf] = {};
    for (const slot of slots) {
      const v = sanitizeModelProfile(stored?.[pf]?.[slot]);
      if (v) out[pf][slot] = v;
    }
  }
  if (!cfg.backend?.profiles) {
    const v = sanitizeModelProfile(cfg.backend?.modelApi);
    if (v) out.qq.chat = v;
  }
  return out;
}

/* ══════════════════════════════════════════════════════════════════════════
 * 一之二、人格卡文件（roles/<名字>.md）
 *
 * 「角色」下拉原来只能挑 roles/ 里**已经存在**的 .md：想添加新人格，得自己开
 * 文件管理器建文件，还得知道格式（roles/README.md 那套）。这里把「建 / 读 /
 * 改 / 删」搬进界面。
 *
 * 名字来自界面输入，一律按**不可信输入**处理 —— 少校验一个分隔符或 `..`，
 * `../../../config` 就能写到 roles/ 外面，把 config.json 覆盖掉。
 * 约束和 roles/README.md 里写的一致（README 与 Windows 保留名不能用）。
 * ══════════════════════════════════════════════════════════════════════════ */

const ROLE_NAME_MAX = 40;
const ROLE_CHARS_MAX = 200_000; // 文件体积护栏；注入上限是 config.role.maxInjectChars，另一回事

/**
 * 人格名 → 磁盘路径。名字非法就抛错（调用方把 message 直接回给前端）。
 * @returns {{ name: string, dir: string, file: string }}
 */
function rolePath(name) {
  const n = String(name ?? '').trim();
  if (!n) throw new Error('人格名不能为空');
  if (n.length > ROLE_NAME_MAX) throw new Error(`人格名太长（最多 ${ROLE_NAME_MAX} 字）`);
  // 分隔符 / 盘符 / 通配符 / 控制字符一律不许出现
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(n)) throw new Error('人格名里不能有 \\ / : * ? " < > | 这些符号');
  if (n.includes('..')) throw new Error('人格名里不能有 ..');
  if (/[.\s]$/.test(n)) throw new Error('人格名不能以点或空格结尾（Windows 上这类名字建了删不掉）');
  if (n.toUpperCase() === 'README') throw new Error('README 是说明文件，不能当人格名');
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(n)) throw new Error(`"${n}" 是 Windows 保留名，换一个`);

  const dir = path.join(dataRoot(), 'roles');
  const file = path.join(dir, `${n}.md`);
  // 双保险：拼出来必须还在 roles/ 里（前面哪条校验漏了，这里兜住）
  if (path.dirname(path.resolve(file)) !== path.resolve(dir)) throw new Error('非法的人格名');
  return { name: n, dir, file };
}

/** 覆盖/删除前把旧内容存一份，改坏了能捞回来（对齐 preset 备份的做法）。 */
function backupRole(file, name) {
  try {
    if (!fs.existsSync(file)) return null;
    const dir = path.join(dataRoot(), 'state', 'role-backups');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(dir, `${name}.${stamp}.md`);
    fs.copyFileSync(file, dest);
    return path.relative(dataRoot(), dest);
  } catch {
    return null; // 备份失败不该拦住保存本身
  }
}

/** 注入上限，和桥接读的是同一个数（config.json 的 role.maxInjectChars）。 */
function roleInjectLimit() {
  const n = Number(loadConfig().role?.maxInjectChars);
  return Number.isFinite(n) && n > 0 ? n : 6000;
}

/** 这张卡现在被哪个平台用着 —— 正在用的不许删。 */
function roleInUse(name) {
  const used = [];
  if (readJson(path.join(dataRoot(), 'state', 'current-role.json'), {})?.role === name) used.push('QQ');
  if (loadConfig().platforms?.wechat?.role === name) used.push('微信');
  return used;
}

/**
 * 角色卡自动整理：把用户随手粘贴的一段人设素材，调一次大模型整理成标准五段式卡。
 *
 * 前提是「模型来源」已经配好（backend.type === model-api）—— 整理本身就是一次模型调用。
 * 只整理不落盘：结果回给前端，用户过目改完再走 /api/role/file 保存，坏结果不会直接进 roles/。
 * 素材只发给用户自己配置的模型服务商，本服务不留存。
 */
const ROLE_ORGANIZE_MAX = 20_000;
const ROLE_ORGANIZE_PROMPT = [
  '你是人设卡整理员。把用户给的原始素材整理成一张「角色卡」，输出遵守以下格式（Markdown，五个二级标题，一字不差）：',
  '',
  '# 角色卡：<名字>',
  '## 一、你是谁',
  '## 二、说话风格',
  '## 三、性格与反应',
  '## 四、梗与背景（可选）',
  '## 五、回复示例',
  '',
  '规则：',
  '1. 只用素材里的信息，不编造设定；措辞可以顺，事实不能加。',
  '2. 「说话风格」里明确写出「不要什么」（比如：不要总结、不要客服腔），这比写「要什么」更管用。',
  '3. 「回复示例」给 3~5 条「对方说 → 你回」的示例，只示范语气和长度；素材里没有示例就按风格推断写短的。',
  '4. 全文用中文，总长控制在 1000~4000 字符，别写提纲式的空话，每一条都要具体可用。',
  '5. 只输出卡片本身，不要任何前言、解释或代码块围栏。'
].join('\n');

/**
 * 把上游返回的一大坨报错翻译成人话 —— 界面上贴原始 JSON 等于没报错。
 * 认不出来的原样带回，但截短，别把整页挤爆。
 */
function humanizeModelError(error) {
  const raw = String(error?.message ?? error ?? '');
  const low = raw.toLowerCase();
  if (low.includes('free quota') || low.includes('free tier') || low.includes('quota exhausted') || low.includes('insufficient')) {
    return '这个模型的免费额度用完了。换一个模型（或到「API 与模型」页把模型来源换成有额度的），再试一次。';
  }
  if (raw.includes('401') || low.includes('unauthorized') || low.includes('invalid api key') || low.includes('incorrect api key')) {
    return 'key 不对或已失效。去「API 与模型」页重新粘一次这个厂商的 key。';
  }
  if (raw.includes('429') || low.includes('rate limit')) {
    return '被限流了，等一分钟再试。';
  }
  if (raw.includes('403')) {
    return '服务商拒绝了这次请求（403）。常见原因是额度用完、key 没开通这个模型、或地区限制。';
  }
  if (low.includes('timeout') || low.includes('aborted') || low.includes('timed out')) {
    return '模型那边超时了。可能网络不稳，或者这个模型这会儿很慢，再试一次。';
  }
  if (raw.includes('404') || low.includes('model not found') || low.includes('no such model')) {
    return '这个模型名在服务商那边不存在。到「API 与模型」页点「拉取」看看真实列表。';
  }
  return raw.length > 300 ? `${raw.slice(0, 300)}…` : raw;
}

/**
 * 找一组能用来"整理文字"的模型 —— 按优先级排队，一个不行换下一个：
 *   1. 「模型来源」配好的直连模型 API（backend.modelApi）
 *   2. 模型池免费档前几个（`provider/model#tag`），用厂商预设补地址、用 secrets 里的 key
 * 只挑「配置齐全」的，不猜；一个都挑不出来才报人话错误。
 */
function organizeCandidates() {
  const secrets = readJson(secretsFile());
  const out = [];
  // 不看 backend.type：用户可能在用 API 实例当主后端，但「模型来源」照样填过一份。
  const ma = loadConfig().backend?.modelApi;
  if (ma?.baseUrl && ma?.model) {
    try {
      out.push({ profile: resolveProfile({ ...ma }, secrets), via: '模型来源' });
    } catch { /* 这个来源配不全，往下走 */ }
  }
  // 池子里的厂商名和「模型来源」的内置厂商表不完全一致（池子里写 zhipuai，
  // 预设表里叫 zhipu），不映射一下这些模型会被静默跳过、永远试不到。
  const ALIAS = { zhipuai: 'zhipu', moonshotai: 'moonshot' };
  // 池子里前面常常是同一家的几个型号，一起挂了就是一起挂 —— 所以取满 12 个，
  // 让后面那几家（不同厂商）也有机会被试到。
  for (const entry of (loadPool().free ?? []).map(String).slice(0, 12)) {
    const [rawProvider, ...rest] = entry.split('/');
    const provider = ALIAS[rawProvider] ?? rawProvider;
    const model = rest.join('/').replace(/#.*$/, '');
    if (!provider || !model) continue;
    try {
      out.push({ profile: resolveProfile({ provider, model }, secrets), via: '模型池' });
    } catch { /* key 没配，跳过 */ }
  }
  return out;
}

async function organizeRoleCard({ text } = {}) {
  const raw = String(text ?? '').trim();
  if (!raw) return { ok: false, error: '先粘贴要整理的内容' };
  if (raw.length > ROLE_ORGANIZE_MAX) {
    return { ok: false, error: `内容太长（${raw.length} 字符，上限 ${ROLE_ORGANIZE_MAX}）。先删减一点再整理。` };
  }
  const candidates = organizeCandidates();
  if (!candidates.length) {
    return {
      ok: false,
      error:
        '自动整理要调用一次大模型，但本机现在没有能用的模型。去「API 与模型」页选一个厂商、填 key（或把模型加进模型池），再回来整理。'
    };
  }

  const prompt = `${ROLE_ORGANIZE_PROMPT}\n\n=== 待整理素材 ===\n${raw}`;
  let lastError = '';

  // 一个模型额度用完/限流，就换下一个 —— 用户点的是「整理」，不是「用第一个模型整理」。
  for (const { profile, via } of candidates) {
    let out = '';
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 120_000);
    try {
      for await (const item of streamChat(profile, {
        messages: [{ role: 'user', text: prompt }],
        signal: abort.signal
      })) {
        if (item.delta) out += item.delta;
        if (out.length > 200_000) { abort.abort(); break; }
      }
      const card = out.trim();
      if (!card) {
        lastError = '模型没有返回内容';
        continue;
      }
      pushLog(`角色卡自动整理完成（${card.length} 字符，${via} · ${profile.model ?? ''}）`, 'sys', 'app');
      return { ok: true, card, model: profile.model ?? '', via };
    } catch (error) {
      lastError = humanizeModelError(error);
      pushLog(`角色卡整理换模型（${profile.model ?? '?'}）：${lastError}`, 'err', 'app');
    } finally {
      clearTimeout(timer);
    }
  }
  // 全试完还是不行：把「试了几个」和最后一次的原因一起说清楚 ——
  // 只说最后一个错误会让人以为只试了一次，看不出程序已经尽力换过模型。
  return {
    ok: false,
    error: `试了 ${candidates.length} 个模型都没成功。最后一次：${lastError || '未知原因'}`
  };
}

/** 配置里有没有 key 只返回布尔，绝不把 key 本身吐给前端。 */
function secretPresence() {
  const secrets = readJson(secretsFile());
  return Object.keys(secrets).map((k) => ({ env: k, set: Boolean(secrets[k]) }));
}

/** 点号路径读值：`socialV2.sticker.collect.maxPerMinute` → 数字。 */
function deepGet(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/**
 * 点号路径写值（value === null 表示删掉这个键，回落到桥接自己的默认值）。
 *
 * 为什么用「删掉」而不是写空值：这些配置在桥接里都有 `?? 默认值` 的兜底，
 * 但兜底只认 `undefined`。写个空串进去，`Number('')` 会变成 0，
 * 于是「留空」就变成了「设成 0」—— 概率 0 和不冒泡是一样的，很难查。
 */
function deepSet(obj, dotted, value) {
  const keys = dotted.split('.');
  let cur = obj;
  for (const k of keys.slice(0, -1)) {
    if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {};
    cur = cur[k];
  }
  const last = keys[keys.length - 1];
  if (value === null) delete cur[last];
  else cur[last] = value;
  return obj;
}

/* ══════════════════════════════════════════════════════════════════════════
 * 可调项清单
 *
 * 为什么把 schema 放服务端：可调项有几十个，前端一个个手写 HTML 加事件会写到吐，
 * 而且加一项要改三处（HTML / 事件 / 保存）。这里声明「路径 + 类型 + 含义」，
 * 前端照着画就行 —— 加设置项只改这一个数组。
 *
 * type：bool / number / text / select / list（逗号分隔）
 * default 只是占位提示和空值时的显示值，真正的兜底在桥接代码里。
 * ══════════════════════════════════════════════════════════════════════════ */

/* 内置价目表里的模型名（只抄名字，价格不抄 —— 价格在 bridge 的 model-prices.js 里，
 * 会随官方调价变；这里只用来给「加一条」时提供候选，免得手打错名字）。 */
const PRICE_BUILTIN_MODELS = [
  { name: 'deepseek-flash', label: 'DeepSeek-V4.1-Flash' },
  { name: 'deepseek-v4-flash', label: 'DeepSeek-V4.1-Flash（旧名）' },
  { name: 'deepseek-v4-flash-vision-exp', label: 'DeepSeek-V4.1-Flash（视觉实验）' },
  { name: 'deepseek-v4-pro', label: 'DeepSeek-V4-Pro-0813' },
  { name: 'deepseek-pro', label: 'DeepSeek-V4-Pro-0813（旧名）' }
];

const OPTION_GROUPS = [
  {
    id: 'model',
    title: '模型连接',
    hint: '桥接拿哪个地址、哪个模型、什么思考强度去出字。改错了整条链路不响 —— 改完用「一键自检」验一遍',
    items: [
      { path: 'dsh.baseUrl', label: '模型服务地址', hint: '留空 = 用桥接自己拉起的那份', type: 'text', default: 'http://127.0.0.1:3080' },
      { path: 'dsh.provider', label: '提供方', hint: '一般不用改', type: 'text', default: 'deepseek-official' },
      { path: 'dsh.model', label: '模型名', hint: '要和中转那边认的名字逐字一致', type: 'text', default: 'deepseek-flash' },
      { path: 'dsh.reasoningEffort', label: '思考强度', hint: '越高越慢越贵，但想得更透', type: 'select', default: 'max', options: [
        { value: 'low', label: 'low（快，想得浅）' },
        { value: 'high', label: 'high（默认偏上）' },
        { value: 'max', label: 'max（最慢最深）' }
      ] },
      { path: 'dsh.authToken', label: '鉴权口令', hint: '中转要 Bearer 就填在这', type: 'text', secret: true, default: '' },
      { path: 'dsh.authHeader', label: '鉴权头名字', hint: '一般就是 authorization', type: 'text', default: 'authorization' },
      { path: 'dsh.authPrefix', label: '鉴权前缀', hint: '和口令之间会拼一个空格', type: 'text', default: 'Bearer' },
      { path: 'dsh.allowRemote', label: '允许连非本机地址', hint: '关着的时候只让连 127.0.0.1，防止口令发到别人机器上', type: 'bool', default: false }
    ]
  },
  {
    id: 'rhythm',
    title: '消息节奏',
    hint: '发多快、等多久',
    items: [
      { path: 'sendDelayMs', label: '发送前的延迟', hint: '毫秒。给人类一点"打字"时间', type: 'number', step: 50, min: 0, default: 300 },
      { path: 'questionTimeoutMs', label: '提问等回复的超时', hint: '毫秒。超时就当没答上来', type: 'number', step: 1000, min: 1000, default: 300000 },
      { path: 'ackMessage', label: '先回一句', hint: '收到消息立刻先发这句（留空 = 不回）', type: 'text', default: '' },
      { path: 'consolePort', label: '本地控制台端口', hint: '桥接自己那个网页控制台', type: 'number', step: 1, min: 1, max: 65535, default: 3100 },
      { path: 'consoleToken', label: '控制台口令', hint: '留空 = 自动生成一个，存在 state/console-token', type: 'text', default: '' }
    ]
  },
  {
    id: 'session',
    title: '会话轮换',
    hint: '一条会话用得越久，每次请求要带的上下文越大。到线就自动换新会话（人格和近期消息每轮都会重新注入，不会全忘）',
    items: [
      { path: 'session.rotateIdleMs', label: '闲置多久换会话', hint: '毫秒。填 0 = 不按闲置换', type: 'number', step: 600000, min: 0, default: 7200000 },
      { path: 'session.rotateTurns', label: '聊多少轮换会话', hint: '填 0 = 不按轮次换', type: 'number', step: 5, min: 0, default: 40 },
      { path: 'session.rotateMaxAgeMs', label: '会话最长活多久', hint: '毫秒。填 0 = 不限年龄', type: 'number', step: 3600000, min: 0, default: 28800000 }
    ]
  },
  {
    id: 'social',
    title: '社交（一代）',
    hint: '收到消息后判断要不要插话的那套逻辑',
    items: [
      { path: 'social.enabled', label: '启用', type: 'bool', default: true },
      { path: 'social.maxReplyChars', label: '单条最多多少字', type: 'number', step: 50, min: 20, default: 500 },
      { path: 'social.contextWindow', label: '带几条上下文', hint: '判断要不要说话时看多少条历史', type: 'number', step: 1, min: 1, default: 20 },
      { path: 'social.triggerProbability', label: '插话概率', hint: '0~1。普通消息被搭话的几率', type: 'number', step: 0.05, min: 0, max: 1, default: 0.1 },
      { path: 'social.mustReplyKeywords', label: '必答关键词', hint: '命中一定回，逗号分隔', type: 'list', default: [] },
      { path: 'social.skipProbability', label: '已读不回概率', hint: '0~1。决定回了又反悔的几率', type: 'number', step: 0.01, min: 0, max: 1, default: 0.05 },
      { path: 'social.burstEnabled', label: '允许连发', hint: '关掉就永远一条一条发', type: 'bool', default: true },
      { path: 'social.activeDurationEnabled', label: '有"活跃时段"', hint: '开启后会有一段时间特别爱说话', type: 'bool', default: true },
      { path: 'social.proactiveEnabled', label: '允许主动找话说', type: 'bool', default: true },
      { path: 'social.proactiveIdleThresholdMs', label: '多久没人说话才主动', hint: '毫秒', type: 'number', step: 60000, min: 60000, default: 1800000 },
      { path: 'social.proactiveProbability', label: '主动开口概率', type: 'number', step: 0.05, min: 0, max: 1, default: 0.2 },
      { path: 'social.activeCheckMinMs', label: '多久看一次（最短）', hint: '毫秒。判断要不要插话的间隔下限', type: 'number', step: 1000, min: 1000, default: 8000 },
      { path: 'social.activeCheckMaxMs', label: '多久看一次（最长）', hint: '毫秒。实际间隔在这两个数之间随机', type: 'number', step: 1000, min: 1000, default: 30000 },
      { path: 'social.activeReplyDelayMinMs', label: '回之前等多久（最短）', hint: '毫秒。装作在打字', type: 'number', step: 500, min: 0, default: 1000 },
      { path: 'social.activeReplyDelayMaxMs', label: '回之前等多久（最长）', hint: '毫秒', type: 'number', step: 500, min: 0, default: 5000 },
      { path: 'social.idleWindowMs', label: '多久算"没人说话"', hint: '毫秒。超过这个时长进入闲置逻辑', type: 'number', step: 60000, min: 60000, default: 360000 },
      { path: 'social.idleRetryProbability', label: '闲置时再试的概率', hint: '0~1', type: 'number', step: 0.05, min: 0, max: 1, default: 0.4 },
      { path: 'social.idleRetryWaitMs', label: '再试之前等多久', hint: '毫秒', type: 'number', step: 10000, min: 1000, default: 120000 },
      { path: 'social.proactiveCheckMinMs', label: '主动找话的检查间隔（最短）', hint: '毫秒', type: 'number', step: 60000, min: 60000, default: 2700000 },
      { path: 'social.proactiveCheckMaxMs', label: '主动找话的检查间隔（最长）', hint: '毫秒', type: 'number', step: 60000, min: 60000, default: 5400000 },
      { path: 'social.activeDurationMinMs', label: '活跃时段多长（最短）', hint: '毫秒', type: 'number', step: 60000, min: 60000, default: 1200000 },
      { path: 'social.activeDurationMaxMs', label: '活跃时段多长（最长）', hint: '毫秒', type: 'number', step: 60000, min: 60000, default: 3000000 },
      { path: 'social.surrenderProbability', label: '直接放弃的概率', hint: '0~1。抽中就当这条没看见', type: 'number', step: 0.01, min: 0, max: 1, default: 0 },
      { path: 'social.burstIntervalMinMs', label: '连发间隔（最短）', hint: '毫秒', type: 'number', step: 100, min: 100, default: 1000 },
      { path: 'social.burstIntervalMaxMs', label: '连发间隔（最长）', hint: '毫秒', type: 'number', step: 100, min: 100, default: 3000 },
      { path: 'social.longGapProbability', label: '出现长停顿的概率', hint: '0~1。连发中间突然停一下', type: 'number', step: 0.05, min: 0, max: 1, default: 0.2 },
      { path: 'social.longGapMinMs', label: '长停顿多久（最短）', hint: '毫秒', type: 'number', step: 500, min: 0, default: 5000 },
      { path: 'social.longGapMaxMs', label: '长停顿多久（最长）', hint: '毫秒', type: 'number', step: 500, min: 0, default: 10000 }
    ]
  },
  {
    id: 'socialV2',
    title: '二代会话',
    hint: '模型自己管收发、能潜水的那套（reserved2 模式）',
    items: [
      { path: 'socialV2.enabled', label: '启用', type: 'bool', default: true },
      { path: 'socialV2.chatOnly', label: '纯聊天（不给工具）', hint: '打开后模型没有任何工具，只回话：一条消息只花一次调用，省 token；代价是引用回复、看图、联网搜索、表情语音全没了。改完会自动重新生成配置并重启桥接', type: 'bool', default: false },
      { path: 'socialV2.autoReplyCheckMs', label: '自动回复检查间隔', hint: '毫秒', type: 'number', step: 1000, min: 1000, default: 30000 },
      { path: 'socialV2.agentPreset', label: '用哪个 agent', type: 'select', default: 'qq-chat-v2', options: [
        { value: 'qq-chat-v2', label: 'qq-chat-v2（推荐）' },
        { value: 'qq-chat', label: 'qq-chat' }
      ] },
      { path: 'socialV2.provideRecommendations', label: '给模型行动建议', hint: '关掉更"野生"，但更容易不说话', type: 'bool', default: true },
      { path: 'socialV2.send.maxMessageChars', label: '单条最多多少字', type: 'number', step: 50, min: 20, default: 500 },
      { path: 'socialV2.send.maxSendPerMinute', label: '每分钟最多发几条', type: 'number', step: 1, min: 1, default: 8 },
      { path: 'socialV2.send.maxSendPerHour', label: '每小时最多发几条', type: 'number', step: 1, min: 1, default: 60 },
      { path: 'socialV2.send.burstEnabled', label: '允许连发', type: 'bool', default: true },
      { path: 'socialV2.send.burstMaxMessages', label: '一次最多连发几条', type: 'number', step: 1, min: 2, default: 8 },
      { path: 'socialV2.wait.defaultMs', label: '默认等待时长', hint: '毫秒。等新消息的默认值', type: 'number', step: 1000, min: 1000, default: 30000 },
      { path: 'socialV2.wait.maxMs', label: '最长等待', hint: '毫秒', type: 'number', step: 1000, min: 1000, default: 600000 },
      { path: 'socialV2.wake.defaultMode', label: '默认唤醒模式', type: 'select', default: 'diving', options: [
        { value: 'diving', label: 'diving（潜水，偶尔上来）' },
        { value: 'active', label: 'active（全程参与）' }
      ] },
      { path: 'socialV2.wake.preSleepWaitEnabled', label: '睡前先观察一轮', hint: '关掉会睡得很急', type: 'bool', default: true },
      { path: 'socialV2.wake.preSleepWaitMs', label: '睡前观察时长', hint: '毫秒', type: 'number', step: 30000, min: 30000, default: 300000 },
      { path: 'socialV2.wake.sleepMinMs', label: '最短睡多久', hint: '毫秒', type: 'number', step: 60000, min: 0, default: 60000 },
      { path: 'socialV2.wake.maxWakePerHour', label: '每小时最多醒几次', type: 'number', step: 1, min: 1, default: 12 },
      { path: 'socialV2.wake.recommendedProbability', label: '主动醒来的概率', type: 'number', step: 0.01, min: 0, max: 1, default: 0.05 },
      { path: 'socialV2.wake.batchWindowMs', label: '消息合并窗口', hint: '毫秒。这段时间内的消息攒一起看', type: 'number', step: 1000, min: 0, default: 8000 },
      { path: 'socialV2.context.recentLimit', label: '近期消息取多少条', type: 'number', step: 10, min: 1, default: 100 },
      { path: 'socialV2.context.unreadLimit', label: '未读取多少条', type: 'number', step: 5, min: 1, default: 30 },
      { path: 'socialV2.proactive.enabled', label: '允许主动找话说', type: 'bool', default: true },
      { path: 'socialV2.proactive.idleThresholdMs', label: '多久没人说话才主动', hint: '毫秒', type: 'number', step: 60000, min: 60000, default: 900000 },
      { path: 'socialV2.proactive.probability', label: '主动开口概率', type: 'number', step: 0.05, min: 0, max: 1, default: 0.3 },
      { path: 'socialV2.feedback.maxLength', label: '反馈最多多少字', type: 'number', step: 50, min: 10, default: 500 },
      { path: 'socialV2.feedback.notifyOwnerOnError', label: '出错时通知管理员', type: 'bool', default: false },
      { path: 'socialV2.send.gapBaseMs', label: '打字基础间隔', hint: '毫秒。两条之间的固定底数', type: 'number', step: 100, min: 0, default: 800 },
      { path: 'socialV2.send.gapPerCharMs', label: '每多一个字多等多久', hint: '毫秒。越长越像真在打字', type: 'number', step: 5, min: 0, default: 20 },
      { path: 'socialV2.send.maxGapMs', label: '间隔上限', hint: '毫秒。算出来超过这个就按这个', type: 'number', step: 500, min: 0, default: 10000 },
      { path: 'socialV2.send.burstIntervalMinMs', label: '连发间隔（最短）', hint: '毫秒', type: 'number', step: 100, min: 100, default: 1000 },
      { path: 'socialV2.send.burstIntervalMaxMs', label: '连发间隔（最长）', hint: '毫秒', type: 'number', step: 100, min: 100, default: 3000 },
      { path: 'socialV2.send.longGapProbability', label: '出现长停顿的概率', hint: '0~1', type: 'number', step: 0.05, min: 0, max: 1, default: 0.2 },
      { path: 'socialV2.send.longGapMinMs', label: '长停顿多久（最短）', hint: '毫秒', type: 'number', step: 500, min: 0, default: 5000 },
      { path: 'socialV2.send.longGapMaxMs', label: '长停顿多久（最长）', hint: '毫秒', type: 'number', step: 500, min: 0, default: 10000 },
      { path: 'socialV2.wait.minMs', label: '等待下限', hint: '毫秒。模型要等也至少等这么久', type: 'number', step: 1000, min: 1000, default: 5000 },
      { path: 'socialV2.wait.defaultQuietMs', label: '默认安静多久算说完', hint: '毫秒。等新消息时判断"这轮说完了"', type: 'number', step: 500, min: 0, default: 8000 },
      { path: 'socialV2.wait.minQuietAfterNewMs', label: '来新消息后至少再等', hint: '毫秒。防止刚来人就走', type: 'number', step: 1000, min: 0, default: 10000 },
      { path: 'socialV2.proactive.checkIntervalMinMs', label: '主动找话检查间隔（最短）', hint: '毫秒', type: 'number', step: 60000, min: 60000, default: 1800000 },
      { path: 'socialV2.proactive.checkIntervalMaxMs', label: '主动找话检查间隔（最长）', hint: '毫秒', type: 'number', step: 60000, min: 60000, default: 5400000 },
      { path: 'socialV2.context.contextWindow', label: '判断时带几条上下文', hint: '给模型看多少条历史来决定说不说', type: 'number', step: 1, min: 1, default: 20 },
      { path: 'socialV2.context.inlineWakeMessages', label: '唤醒时直接附上新消息', hint: '关掉模型得自己再调一次工具去取', type: 'bool', default: true },
      { path: 'socialV2.context.wakeMessageLimit', label: '唤醒最多附几条', type: 'number', step: 1, min: 1, default: 12 },
      { path: 'socialV2.context.wakeRecentLimit', label: '唤醒时带几条前情', type: 'number', step: 1, min: 0, default: 4 },
      { path: 'socialV2.context.wakeMaxChars', label: '唤醒附文最多多少字', hint: '超了截断。太大每次请求都贵', type: 'number', step: 500, min: 500, default: 6000 },
      { path: 'socialV2.wake.sleepMaxMs', label: '最长睡多久', hint: '毫秒。填 0 = 不封顶', type: 'number', step: 60000, min: 0, default: 0 },
      { path: 'socialV2.wake.maxWakePerMinute', label: '每分钟最多醒几次', type: 'number', step: 1, min: 1, default: 1 },
      { path: 'socialV2.wake.noActionLimit', label: '连着几次没动作就提醒', hint: '醒了却什么都不干，提醒它一下', type: 'number', step: 1, min: 1, default: 3 },
      { path: 'socialV2.wake.maxWakeConfigReminders', label: '唤醒设置最多提醒几次', hint: '提醒完就不念叨了', type: 'number', step: 1, min: 0, default: 2 }
    ]
  },
  {
    id: 'sticker',
    title: '表情包',
    hint: '同步、收藏、发图',
    items: [
      { path: 'socialV2.sticker.enabled', label: '启用', type: 'bool', default: true },
      { path: 'socialV2.sticker.syncTtlMs', label: '同步缓存多久', hint: '毫秒。过了就重新拉一遍收藏夹', type: 'number', step: 10000, min: 0, default: 60000 },
      { path: 'socialV2.sticker.maxListCount', label: '最多同步几个', type: 'number', step: 10, min: 1, default: 100 },
      { path: 'socialV2.sticker.includeInPrompt', label: '把表情清单塞进提示词', hint: '关掉模型就不知道自己有哪些图', type: 'bool', default: true },
      { path: 'socialV2.sticker.promptMaxStickers', label: '提示词里列几个', type: 'number', step: 1, min: 1, default: 8 },
      { path: 'socialV2.sticker.collect.enabled', label: '允许自己收藏表情', type: 'bool', default: true },
      { path: 'socialV2.sticker.collect.maxPerMinute', label: '每分钟最多收几个', type: 'number', step: 1, min: 1, default: 2 },
      { path: 'socialV2.sticker.collect.maxPerHour', label: '每小时最多收几个', type: 'number', step: 1, min: 1, default: 10 },
      { path: 'socialV2.sticker.collect.maxRemarkChars', label: '备注最多几个字', type: 'number', step: 1, min: 1, default: 20 }
    ]
  },
  {
    id: 'voice',
    title: '语音',
    hint: '发语音需要本机有 ffmpeg',
    items: [
      { path: 'socialV2.voice.enabled', label: '启用', type: 'bool', default: false },
      { path: 'socialV2.voice.dir', label: '音频目录', hint: '相对项目根，或填绝对路径（要开下面那个开关）', type: 'text', default: 'audio' },
      { path: 'socialV2.voice.allowAbsolutePath', label: '允许绝对路径', hint: '开了就等于允许模型读本机任意音频文件', type: 'bool', default: false },
      { path: 'socialV2.voice.maxSeconds', label: '最长多少秒', type: 'number', step: 10, min: 1, default: 300 },
      { path: 'socialV2.voice.maxBytes', label: '最大多少字节', type: 'number', step: 1048576, min: 1024, default: 20971520 },
      { path: 'socialV2.voice.maxPerMinute', label: '每分钟最多发几条', type: 'number', step: 1, min: 1, default: 2 },
      { path: 'socialV2.voice.maxPerHour', label: '每小时最多发几条', type: 'number', step: 1, min: 1, default: 10 },
      { path: 'socialV2.voice.defaultVolume', label: '默认音量', hint: '1 = 原声', type: 'number', step: 0.1, min: 0, default: 1 },
      { path: 'socialV2.voice.loudness', label: '响度处理', hint: '透传给 NapCat 的参数，一般不用改', type: 'text', default: 'normal' },
      { path: 'socialV2.voice.autoReadback', label: '发完自动读回一遍', type: 'bool', default: true },
      { path: 'socialV2.voice.ffmpegPath', label: 'ffmpeg 路径', hint: '留空 = 用 PATH 里的那个', type: 'text', default: '' }
    ]
  },
  {
    id: 'slang',
    title: '黑话学习',
    hint: '从群聊里学梗，然后自己用',
    items: [
      { path: 'slang.enabled', label: '启用', type: 'bool', default: true },
      { path: 'slang.extractMinMessages', label: '攒够多少条才提炼', type: 'number', step: 1, min: 1, default: 10 },
      { path: 'slang.extractCooldownMs', label: '提炼冷却', hint: '毫秒', type: 'number', step: 60000, min: 0, default: 300000 },
      { path: 'slang.inferenceThresholds', label: '几次能猜出来', hint: '逗号分隔的数字，例：2, 4, 8', type: 'list', itemType: 'number', default: [2, 4, 8] },
      { path: 'slang.injectMax', label: '最多注入几条', type: 'number', step: 1, min: 0, default: 8 },
      { path: 'slang.autoResearch', label: '自己去网上查', hint: '拿不准的梗走只读联网搜索', type: 'bool', default: true },
      { path: 'slang.learnerPreset', label: '用哪个 agent 学', hint: '学习任务单独跑一个会话，不占聊天的上下文', type: 'text', default: 'qq-chat' },
      { path: 'slang.workspaceTitle', label: '学习会话的标题', type: 'text', default: 'QQ 黑话学习' }
    ]
  },
  {
    id: 'gateway',
    title: '网关（OneBot）',
    hint: '桥接连的是哪个 OneBot 实现',
    items: [
      { path: 'snowluma.wsUrl', label: 'WebSocket 地址', hint: '事件推送上来的那条', type: 'text', default: 'ws://127.0.0.1:3001' },
      { path: 'snowluma.httpUrl', label: 'HTTP 地址', hint: '主动调接口用', type: 'text', default: 'http://127.0.0.1:3000' },
      { path: 'snowluma.accessToken', label: 'OneBot 口令', hint: '必须和 NapCat 里配的一致，否则连不上', type: 'text', default: '' },
      { path: 'snowluma.silenceWarnMs', label: '多久没消息就告警', hint: '毫秒', type: 'number', step: 60000, min: 0, default: 600000 },
      { path: 'snowluma.followDiscoveredEndpoint', label: '跟着发现的地址走', hint: 'NapCat 换了端口时自动跟过去。填了固定地址建议关掉', type: 'bool', default: true },
      { path: 'snowluma.homeDir', label: 'NapCat 的 app 目录', hint: '留空 = 自动探测。探测不到时才需要手填', type: 'text', default: '' },
      { path: 'snowluma.launcherPath', label: 'NapCat 启动器路径', hint: '留空 = 在目录里自己找', type: 'text', default: '' }
    ]
  },
  {
    id: 'security',
    title: '安全',
    hint: '改动前想清楚',
    items: [
      { path: 'security.interceptNotify', label: '管理员命令被拦时通知', hint: '关掉就静默忽略', type: 'bool', default: true }
    ]
  },
  {
    id: 'commands',
    title: '聊天指令',
    hint: '在 QQ / 微信里发 / 开头的指令（仅管理员）：截屏、锁屏、定时关机、搜文件、插件。发 /help 看全部',
    items: [
      { path: 'commands.enabled', label: '启用本地指令', hint: '关掉后 / 开头的消息全部照旧交给模型，什么都不执行', type: 'bool', default: true },
      { path: 'commands.shutdownDelaySec', label: '关机默认倒计时', hint: '/shutdown 不带参数时用这个值，单位秒，5~3600', type: 'number', default: 60 },
      { path: 'commands.roots', label: '/find 搜索目录', hint: '逗号分隔的绝对路径；留空用 桌面/文档/下载/视频/图片', type: 'list' }
    ]
  }
];

/** schema 里出现过的全部路径 —— POST 时只允许改这些，避免前端写坏整个配置。 */
const OPTION_PATHS = new Map(
  OPTION_GROUPS.flatMap((g) => g.items.map((i) => [i.path, i]))
);

/* ══════════════════════════════════════════════════════════════════════════
 * 模型能用哪些工具（config.json → socialV2.tools）
 *
 * 这些开关以前只在配置文件里躺着，界面上看不见 —— 想关掉「拍一拍」得自己去
 * 翻 JSON。这里把 bridge 里那张 toolMap 原样搬过来，分组 + 中文名，
 * 界面照着画开关就行。
 *
 * `flag` 必须和 bridge.js 里 `socialV2.tools` 的键名逐字一致；
 * `default` 跟 config.example.json 的出厂值一致（没有 default 字段 = 出厂开）。
 * ══════════════════════════════════════════════════════════════════════════ */

const TOOL_GROUPS = [
  {
    id: 'computer',
    title: '电脑操作 · 勾了才是「可以干活」模式',
    hint: '打开 = 机器人能在本机读写文件、跑命令；只聊天就全关',
    items: [
      { flag: 'computerRead', ns: 'computer', label: '读文件', default: false, hint: '看本机文件内容' },
      { flag: 'computerWrite', ns: 'computer', label: '写文件', default: false, hint: '新建 / 覆盖文件' },
      { flag: 'computerEdit', ns: 'computer', label: '改文件', default: false, hint: '精确修改现有文件' },
      { flag: 'computerGlob', ns: 'computer', label: '找文件', default: false, hint: '按名字模式找文件' },
      { flag: 'computerGrep', ns: 'computer', label: '搜内容', default: false, hint: '按内容搜文件' },
      { flag: 'computerShell', ns: 'computer', label: '运行命令', default: false, hint: '执行命令 —— 权力最大，想清楚再开' }
    ]
  },
  {
    id: 'create',
    title: '创作 · 画画与动态',
    hint: '画画出图、发 QQ 空间说说；默认全关，开了模型才会用',
    items: [
      { flag: 'draw', tool: 'qq_draw / qq_send_image', label: '画画（含发图）', default: false, hint: '文生图 + 把图库的图发进聊天；有每日张数上限' },
      { flag: 'momentPost', tool: 'qq_post_moment', label: '发空间动态', default: false, hint: '发说说（纯文字/图文），有每日条数上限' },
      { flag: 'momentList', tool: 'qq_list_moments', label: '看空间动态', default: true, hint: '只读自己空间的动态列表' },
      { flag: 'momentDelete', tool: 'qq_delete_moment', label: '删空间动态', default: false, hint: '按 tid 删自己发的说说，删除不可恢复' }
    ]
  },

  {
    id: 'read',
    title: '读消息',
    hint: '关掉这些，模型就看不见上下文，只会瞎回',
    items: [
      { flag: 'getPrompt', tool: 'qq_get_prompt', label: '取当前提示词', hint: '人设、群规、未读摘要一次拿全' },
      { flag: 'getUnread', tool: 'qq_get_unread_messages', label: '取未读消息' },
      { flag: 'getRecent', tool: 'qq_get_recent_messages', label: '取最近消息' },
      { flag: 'getMyRecent', tool: 'qq_get_my_recent_messages', label: '取自己发过的' },
      { flag: 'getMessageDetail', tool: 'qq_get_message_detail', label: '查单条详情' },
      { flag: 'getActiveMembers', tool: 'qq_get_active_members', label: '看谁在活跃' },
      { flag: 'socialState', tool: 'qq_social_state', label: '看社交状态', hint: '潜水/活跃、上次说话是什么时候' },
      { flag: 'getImages', tool: 'qq_get_message_images', label: '看图', hint: '关掉就只能看到「[图片]」两个字' },
      { flag: 'getForwardMsg', tool: 'qq_get_forward_msg', label: '读合并转发', default: false },
      { flag: 'getSelfImage', tool: 'qq_get_self_image', label: '看自己的头像', default: false }
    ]
  },
  {
    id: 'send',
    title: '发消息',
    hint: '全关就是纯观察模式：只看不说',
    items: [
      { flag: 'sendMessage', tool: 'qq_send_message', label: '发消息（通用）' },
      { flag: 'reply', tool: 'qq_reply', label: '引用回复' },
      { flag: 'sendGroup', tool: 'qq_send_group_message', label: '发到群里' },
      { flag: 'sendPrivate', tool: 'qq_send_private_message', label: '发私聊' },
      { flag: 'sendBurst', tool: 'qq_send_burst', label: '连发多条', hint: '像人一样一句一句往外蹦' },
      { flag: 'waitMessages', tool: 'qq_wait_for_messages', label: '等新消息', hint: '会占住一次调用，等到了再回' },
      { flag: 'markRead', tool: 'qq_mark_read', label: '标记已读' },
      { flag: 'sendPoke', tool: 'qq_send_poke', label: '拍一拍', default: false },
      { flag: 'feedback', tool: 'qq_report_feedback', label: '写反馈报告', default: false }
    ]
  },
  {
    id: 'memory',
    title: '记忆',
    hint: '长期记住群里的人和事',
    items: [
      { flag: 'memory', tool: 'qq_memory_append / query / remove / clear', label: '长期记忆（增删查清）', default: false }
    ]
  },
  {
    id: 'slang',
    title: '黑话',
    hint: '学群里的梗，然后在对话里用',
    items: [
      { flag: 'slangQuery', tool: 'qq_slang_query', label: '查黑话', default: false },
      { flag: 'slangSubmit', tool: 'qq_slang_submit', label: '提交新黑话', default: false }
    ]
  },
  {
    id: 'sticker',
    title: '表情包',
    hint: '收藏夹那套。主开关在「高级 → 表情包」',
    items: [
      { flag: 'listStickers', tool: 'qq_list_stickers', label: '看自己有哪些表情', default: false },
      { flag: 'getStickerImage', tool: 'qq_get_sticker_image', label: '取表情图', default: false },
      { flag: 'sendSticker', tool: 'qq_send_sticker', label: '发表情', default: false },
      { flag: 'setStickerRemark', tool: 'qq_set_sticker_remark', label: '给表情起名', default: false },
      { flag: 'stickerNote', tool: 'qq_sticker_note', label: '记表情备注', default: false },
      { flag: 'collectSticker', tool: 'qq_collect_sticker', label: '自己收藏表情', default: false }
    ]
  },
  {
    id: 'voice',
    title: '语音',
    hint: '要本机装了 ffmpeg 才能用',
    items: [
      { flag: 'sendVoice', tool: 'qq_send_voice / qq_list_voices', label: '发语音', default: false },
      { flag: 'tts', tool: 'qq_say', label: '开口说话（TTS）', default: true, hint: '把想说的话现场合成语音；引擎和嗓音在「语音库与 TTS」面板配' }
    ]
  },
  {
    id: 'video',
    title: '视频 · 刷抖音/B站',
    hint: '热榜/搜索/看单条。抖音要本机 Edge/Chrome，抽帧要 ffmpeg',
    items: [
      { flag: 'video', tool: 'video_hot / video_feed / video_search / video_watch', label: '视频工具', default: true, hint: '关掉后模型看不到视频 MCP' }
    ]
  },
  {
    id: 'wake',
    title: '自己的状态',
    hint: '让模型自己决定什么时候睡、什么时候醒',
    items: [
      { flag: 'setWakeConfig', tool: 'qq_set_wake_config', label: '调醒睡节奏' }
    ]
  }
];

/** 只读：看得见，但一个字也发不出去。 */
const TOOL_PRESET_READONLY = new Set([
  'sendMessage', 'reply', 'sendGroup', 'sendPrivate', 'sendBurst',
  'markRead', 'sendPoke', 'feedback', 'collectSticker', 'sendVoice', 'setWakeConfig', 'tts'
]);


/* ══════════════════════════════════════════════════════════════════════════
 * 模型 API 隔离实例 / 模型池
 * ══════════════════════════════════════════════════════════════════════════ */

const modelsFile = () => {
  // 生效池 = models.local.json（真实池，不入库）优先；不存在才落到 models.json（公开仓的空模板）。
  // 运行时（桥接 / oc-config）通过 QQ_BRIDGE_MODELS 读的也是 local 这份——
  // 这里必须指同一个文件，否则状态页 / 模型池页看到的是空模板，把用户谎报成「未配置」。
  const local = path.join(dataRoot(), 'models.local.json');
  if (fs.existsSync(local)) return local;
  return path.join(dataRoot(), 'models.json');
};

function matrixStateDir(platformOrConfig = 'qq', config = loadConfig()) {
  // 兼容旧调用 `matrixStateDir(cfg)`：对象参数按 QQ 处理。
  const isConfig = platformOrConfig && typeof platformOrConfig === 'object';
  const platform = isConfig ? 'qq' : platformOrConfig === 'wechat' ? 'wechat' : 'qq';
  const cfg = isConfig ? platformOrConfig : config;
  const key = platform === 'wechat' ? 'wechatStateDir' : 'stateDir';
  const configured = String(cfg.matrix?.[key] ?? '').trim();
  if (configured) return path.resolve(dataRoot(), configured);
  return platform === 'wechat'
    ? path.join(dataRoot(), '.oc', 'wechat', 'state')
    : path.join(dataRoot(), '.oc', 'state');
}

/**
 * 实例的注册文件：桥接把它起在哪、pid 多少，都写在这儿。只读，不碰它的生死。
 *
 * 字段是 { id, version, url, pid, password } —— 注意存的是 **url** 不是 port，
 * 一开始按 port 读，界面上端口永远是「—」。
 */
function ocInstance(platform = 'qq') {
  const cfg = loadConfig();
  const stateDir = matrixStateDir(platform, cfg);
  const file = path.join(stateDir, 'opencode', 'service.json');
  const info = readJson(file, null);
  if (!info) return { platform, alive: false, pid: null, url: null, port: null, version: null, file };

  let alive = false;
  try {
    // pid 活着不代表端口还是它的，但对"大概在不在"够用了；
    // 真要确定就 probePort，那是 /api/state 里 napcat 那套的活。
    process.kill(info.pid, 0);
    alive = true;
  } catch {
    alive = false;
  }

  let port = null;
  try {
    port = info.url ? Number(new URL(info.url).port) || null : null;
  } catch {
    port = null;
  }

  return { platform, alive, pid: info.pid ?? null, url: info.url ?? null, port, version: info.version ?? null, file };
}

/** 两个模型实例的聚合状态：首页/状态页只关心“至少有一个在跑”。 */
function ocInstances() {
  const qq = ocInstance('qq');
  const wechat = ocInstance('wechat');
  return {
    ...qq,
    alive: qq.alive === true || wechat.alive === true,
    url: qq.url ?? wechat.url ?? null,
    pid: qq.pid ?? wechat.pid ?? null,
    version: qq.version ?? wechat.version ?? null,
    file: qq.file,
    instances: { qq, wechat }
  };
}

const DEFAULT_EXHAUSTED_NOTICE = '我这会儿 API 连不上了，等会儿再聊吧。';

/** 旧数据里「GBK 文件被当 UTF-8 读」会留下 U+FFFD 或连续问号，不能原样显示/发出去。 */
function sanitizeExhaustedNotice(value) {
  if (typeof value !== 'string') return DEFAULT_EXHAUSTED_NOTICE;
  const text = value.trim();
  if (text.includes('\uFFFD') || /\?{2,}/.test(text)) return DEFAULT_EXHAUSTED_NOTICE;
  return text;
}

function loadPool() {
  const pool = readJson(modelsFile(), {
    enabled: true,
    allowPaid: false,
    // 全链熔断时直接发给对方的一句话，必须是**人话**（旧默认值 429ERROR 会原样发进聊天）。
    exhaustedNotice: DEFAULT_EXHAUSTED_NOTICE,
    free: [],
    paid: []
  });
  pool.exhaustedNotice = sanitizeExhaustedNotice(pool.exhaustedNotice);
  return pool;
}

/**
 * 桥接的熔断状态文件（运行时写在 .oc/state/model-chain.json）。
 * health: [{ key, kind, until, detail, count, firstAt, lastAt }]
 * key 形如 bailian/qwen3.8-max#low（也可能不带 #档位）。
 */
function chainStateFile(platform = 'qq') {
  const cfg = loadConfig();
  const stateDir = matrixStateDir(platform, cfg);
  return path.join(stateDir, 'model-chain.json');
}

/** 还在熔断期内（until 未到）的候选列表。 */
function loadFused(platform = 'qq') {
  const d = readJson(chainStateFile(platform), null);
  const now = Date.now();
  return (Array.isArray(d?.health) ? d.health : [])
    .filter((e) => Number(e?.until) > now)
    .map((e) => ({ key: String(e.key), until: Number(e.until), kind: e.kind ?? '', detail: e.detail ?? '' }));
}

/** 去掉 #档位后缀再比，兼容池子里带/不带档位两种写法。 */
const baseModelId = (s) => String(s).replace(/#.*$/, '');

/**
 * 按模型累计本机用量（token）。
 *
 * 为什么读 模型 API 的会话库而不是问厂商：百炼/智谱/NVIDIA/Cloudflare 都没有公开的
 * 余额或额度接口（实测过，见 2026-10-18 的调研），能查余额的只有 OpenRouter 一家。
 * 所以"这个模型还剩多少"只能给个本机口径：这台机器上用它花过多少 token。
 * 数据源是 模型 API 自己的 session_v2 表（每会话的 tokens_input/output + 模型名），
 * 按 provider/id 聚合，档位（#low 之类）合并成同一个模型。
 *
 * 拿不到就返回 {}：界面就不显示这一栏，绝不因为统计挂了影响模型池本身。
 */
let _sqliteCtor = null;
async function readModelUsage() {
  try {
    if (_sqliteCtor === null) {
      _sqliteCtor = await import('node:sqlite').then((m) => m.DatabaseSync).catch(() => false);
    }
    if (!_sqliteCtor) return {};
    const cfg = loadConfig();
    const candidates = [
      path.join(path.dirname(matrixStateDir('qq', cfg)), 'data', 'opencode', 'opencode.db'),
      path.join(dataRoot(), '.oc', 'data', 'opencode', 'opencode.db'),
      path.join(path.dirname(matrixStateDir('wechat', cfg)), 'data', 'opencode', 'opencode.db'),
      path.join(dataRoot(), '.oc', 'wechat', 'data', 'opencode', 'opencode.db')
    ];
    const files = [...new Set(candidates.filter((f) => fs.existsSync(f)))];
    if (!files.length) return {};
    const out = {};
    for (const file of files) {
      const db = new _sqliteCtor(file, { readOnly: true });
      let rows = [];
      try {
        rows = db
          .prepare('SELECT model, SUM(tokens_input + tokens_output) AS t, COUNT(*) AS n FROM session_v2 GROUP BY model')
          .all();
      } finally {
        db.close();
      }
      for (const r of rows) {
        let id = String(r.model ?? '');
        let provider = '';
        try {
          const j = JSON.parse(id);
          id = j.id || id;
          provider = j.providerID || '';
        } catch {
          /* 不是 JSON（老数据）就按原样用 */
        }
        const key = provider ? `${provider}/${id}` : id;
        const prev = out[key] ?? { tokens: 0, calls: 0 };
        prev.tokens += Number(r.t) || 0;
        prev.calls += Number(r.n) || 0;
        out[key] = prev;
      }
    }
    return out;
  } catch {
    return {};
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * 用量统计
 *
 * 数据源是 OpenCode 的本地会话库（opencode.db，只读打开）：每条助手消息里
 * 记了 cost、五类 token 和 created / streamed / completed 三个时间戳 ——
 * 首字延迟、出字速度都从时间差里算。只在本地读，不联网、不写库。
 * ══════════════════════════════════════════════════════════════════════════ */

function usageDbFiles() {
  const cfg = loadConfig();
  // 和 readModelUsage 同一套候选路径；带 wechat 的是微信实例的库
  const list = [
    ['QQ', path.join(path.dirname(matrixStateDir('qq', cfg)), 'data', 'opencode', 'opencode.db')],
    ['QQ', path.join(dataRoot(), '.oc', 'data', 'opencode', 'opencode.db')],
    ['微信', path.join(path.dirname(matrixStateDir('wechat', cfg)), 'data', 'opencode', 'opencode.db')],
    ['微信', path.join(dataRoot(), '.oc', 'wechat', 'data', 'opencode', 'opencode.db')]
  ];
  const seen = new Set();
  const out = [];
  for (const [app, file] of list) {
    if (!fs.existsSync(file)) continue;
    const key = path.resolve(file).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ app, file: path.resolve(file) });
  }
  return out;
}

/**
 * 会话 id → 会话键。用量库只记 session_id，私聊/群聊要靠桥接的
 * sessions.json（QQ）和 wechat-*-sessions.json（微信）反查。
 */
function usageSessionMaps() {
  const qq = new Map();
  const wx = new Map();
  const stateDir = path.join(dataRoot(), 'state');
  try {
    const saved = readJson(path.join(stateDir, 'sessions.json'), {});
    for (const [conv, sid] of Object.entries(saved?.sessions ?? {})) {
      if (sid) qq.set(String(sid), String(conv));
    }
  } catch {
    /* 没有映射就显示未知会话，不影响用量汇总 */
  }
  try {
    for (const name of fs.readdirSync(stateDir)) {
      if (!/^wechat(?:-[A-Za-z0-9_.-]+)?-sessions\.json$/.test(name)) continue;
      const saved = readJson(path.join(stateDir, name), {});
      for (const [user, rec] of Object.entries(saved ?? {})) {
        const sid = typeof rec === 'string' ? rec : rec?.sessionId;
        if (sid) wx.set(String(sid), String(user));
      }
    }
  } catch {
    /* 微信没登录/没会话时没有这个文件 */
  }
  return { qq, wx };
}

async function readUsageStats() {
  if (_sqliteCtor === null) {
    _sqliteCtor = await import('node:sqlite').then((m) => m.DatabaseSync).catch(() => false);
  }
  if (!_sqliteCtor) return { ok: false, error: '这个环境没有 node:sqlite，读不了会话库' };
  const files = usageDbFiles();
  if (!files.length) return { ok: true, empty: true, totals: null, days: [], models: [], recent: [], byChat: null };
  const rows = [];
  const sessionMaps = usageSessionMaps();
  for (const { app, file } of files) {
    let db;
    try {
      db = new _sqliteCtor(file, { readOnly: true });
    } catch {
      continue;
    }
    try {
      const rs = db
        .prepare(
          `SELECT
             json_extract(data, '$.time.created')   AS t0,
             json_extract(data, '$.time.streamed')  AS tts,
             json_extract(data, '$.time.completed') AS t1,
             json_extract(data, '$.cost')           AS cost,
             json_extract(data, '$.tokens.input')   AS tin,
             json_extract(data, '$.tokens.output')  AS tout,
             json_extract(data, '$.tokens.reasoning') AS treason,
             json_extract(data, '$.tokens.cache.read')  AS tcr,
             json_extract(data, '$.tokens.cache.write') AS tcw,
             json_extract(data, '$.model.id')        AS model,
             json_extract(data, '$.model.providerID') AS provider,
             json_extract(data, '$.finish')          AS finish,
             json_extract(data, '$.error.message')   AS err,
             session_id                               AS sid,
             (SELECT title FROM session_v2 WHERE id = session_message.session_id) AS title
           FROM session_message WHERE type = 'assistant' ORDER BY time_created ASC`
        )
        .all();
      for (const r of rs) rows.push({ app, ...r });
    } catch {
      /* 这个库读不了（老版本结构？）就跳过，另一个库可能还好着 */
    } finally {
      try { db.close(); } catch { /* 关不掉就算了 */ }
    }
  }
  const num = (v) => Number(v) || 0;
  const pad2 = (n) => String(n).padStart(2, '0');
  const totals = { cost: 0, requests: rows.length, ok: 0, errors: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
  const emptyChat = () => ({ requests: 0, ok: 0, errors: 0, cost: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, tokens: 0 });
  const byChat = { qqPrivate: emptyChat(), qqGroup: emptyChat(), wechat: emptyChat(), unknown: emptyChat() };
  const days = new Map();
  const models = new Map();
  const recent = [];
  for (const r of rows) {
    const failed = r.finish === 'error' || r.err != null;
    if (failed) totals.errors += 1;
    else totals.ok += 1;
    const inTok = num(r.tin);
    const outTok = num(r.tout);
    const cacheRead = num(r.tcr);
    const tokens = inTok + outTok + num(r.treason) + num(r.tcw);
    totals.cost += num(r.cost);
    totals.input += inTok;
    totals.output += outTok;
    totals.reasoning += num(r.treason);
    totals.cacheRead += cacheRead;
    totals.cacheWrite += num(r.tcw);

    // 会话库只记 session_id，用桥接的会话映射还原成 private:xxx / group:xxx。
    const sid = String(r.sid ?? '');
    const conv = (r.app === '微信' ? sessionMaps.wx.get(sid) : sessionMaps.qq.get(sid)) ?? '';
    // 会话映射只保留当前会话；历史会话已经换过 id 的，用标题兜底认群聊/私聊。
    const title = String(r.title ?? '');
    const titleKind = /(?:qq\s*group|群聊|群组)/i.test(title) ? 'group' : /(?:私聊|private)/i.test(title) ? 'private' : '';
    const kind = conv.startsWith('group:') ? 'group' : conv.startsWith('private:') ? 'private' : (r.app === '微信' ? 'private' : titleKind || 'unknown');
    const target = conv.includes(':') ? conv.slice(conv.indexOf(':') + 1) : conv;
    const chatLabel = kind === 'group'
      ? (target ? `群 ${target}` : '群聊（旧会话）')
      : kind === 'private'
        ? (target ? (r.app === '微信' ? `微信 ${target}` : `私聊 ${target}`) : '私聊（旧会话）')
        : '未知会话';
    const chatKey = r.app === '微信' ? 'wechat' : kind === 'group' ? 'qqGroup' : kind === 'private' ? 'qqPrivate' : 'unknown';
    const bucket = byChat[chatKey];
    bucket.requests += 1;
    if (failed) bucket.errors += 1;
    else bucket.ok += 1;
    bucket.cost += num(r.cost);
    bucket.input += inTok;
    bucket.output += outTok;
    bucket.reasoning += num(r.treason);
    bucket.cacheRead += cacheRead;
    bucket.cacheWrite += num(r.tcw);
    bucket.tokens += tokens;

    if (r.t0) {
      const d = new Date(r.t0);
      const key = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
      const day = days.get(key) ?? { date: key, cost: 0, requests: 0, tokens: 0 };
      day.cost += num(r.cost);
      day.requests += 1;
      day.tokens += tokens;
      days.set(key, day);
    }
    const modelId = String(r.model ?? '未知');
    const provider = String(r.provider ?? '');
    const mkey = provider ? `${provider}/${modelId}` : modelId;
    const m = models.get(mkey) ?? { model: mkey, requests: 0, cost: 0, input: 0, output: 0 };
    m.requests += 1;
    m.cost += num(r.cost);
    m.input += inTok;
    m.output += outTok;
    models.set(mkey, m);
    // 速度：出字段的 token / 流式传输秒数；首字：streamed - created
    const tps = r.t1 > r.tts && outTok > 0 ? outTok / ((r.t1 - r.tts) / 1000) : 0;
    const ttft = r.tts > r.t0 ? r.tts - r.t0 : 0;
    recent.push({
      t: r.t0,
      app: r.app,
      chat: chatLabel,
      conv,
      kind,
      model: modelId,
      provider,
      cost: num(r.cost),
      input: inTok,
      output: outTok,
      cacheRead,
      tps: Math.round(tps),
      ttftMs: ttft,
      status: failed ? 'error' : 'ok',
      error: failed ? String(r.err ?? '').slice(0, 120) : ''
    });
  }
  const denom = totals.input + totals.cacheRead;
  return {
    ok: true,
    totals: { ...totals, cacheHitRate: denom > 0 ? totals.cacheRead / denom : 0 },
    byChat,
    days: [...days.values()].sort((a, b) => (a.date < b.date ? -1 : 1)),
    models: [...models.values()].sort((a, b) => b.cost - a.cost || b.requests - a.requests).slice(0, 8),
    recent: recent.slice(-100).reverse()
  };
}

/** 池子里有哪些模型正在坐废池：熔断记录 ∩ 池内 id。 */
function spentInPool(pool) {
  const ids = [...(pool.free ?? []), ...(pool.paid ?? [])].map(String);
  const spent = [];
  for (const f of [...loadFused('qq'), ...loadFused('wechat')]) {
    const id = ids.find((x) => x === f.key || baseModelId(x) === baseModelId(f.key));
    if (id && !spent.some((s) => s.id === id)) {
      spent.push({ id, until: f.until, kind: f.kind, detail: f.detail });
    }
  }
  return spent;
}

/**
 * 重新生成 opencode.json。
 *
 * 模型链是写在 opencode.json 里的，改了 models.json 不重跑一次生成器，
 * 模型 API 那边看到的还是旧的模型表。
 */
function regenerateConfig() {
  return new Promise((resolve) => {
    const { command, env } = nodeRunner('qq');
    const child = spawn(command, [path.join(getRoot(), 'src', 'oc-config.js')], {
      cwd: dataRoot(),
      env: { ...process.env, ...env },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const lines = [];
    relayText(child.stdout, lines);
    relayText(child.stderr, lines);
    child.on('close', (code) => {
      pushLog(`重新生成配置文件结束（code ${code}）`, code === 0 ? 'sys' : 'err', 'bridge');
      resolve({ ok: code === 0, lines });
    });
    child.on('error', (error) => resolve({ ok: false, lines: [String(error?.message ?? error)] }));
  });
}

function relayText(stream, into) {
  let buffer = '';
  stream.on('data', (chunk) => {
    buffer += chunk.toString();
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, '');
      into.push(line);
      if (line.trim()) pushLog(line, 'out', 'bridge');
      buffer = buffer.slice(idx + 1);
    }
  });
}


/* ══════════════════════════════════════════════════════════════════════════
 * 二、NapCat
 *
 * 判断"NapCat 起没起来"看 3001 端口，不看子进程 ——
 * NapCatWinBootMain.exe 是个启动器，拉起真正的 NapCat 后自己就退了，
 * 拿子进程存活当判据会一直显示"没起来"。
 * ══════════════════════════════════════════════════════════════════════════ */

let napcatLaunch = { startedAt: null, pid: null, child: null };
/* NapCat 多号：账号 id（qq1/qq2…）→ 该号自己的启动器进程。
   `napcatLaunch` 保留为 qq1 的视图 —— 旧代码（看护/一键启动/状态）全指着它。 */
const napcatProcs = new Map();
// 上次真正拉起 NapCat 的目录。用户中途改了设置也要能收掉旧目录里的进程。
let lastNapcatDir = '';

function probePort(port, host = '127.0.0.1', timeoutMs = 800) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
  });
}

/** 轮询等端口就绪，比 bat 里硬等 30 秒靠谱 —— 快了立刻走，慢了自己等够。 */
async function waitForPort(port, maxMs) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (await probePort(port)) return true;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

/**
 * 本机已经装好的 NapCat 在哪。
 *
 * 精简安装包不带 NapCat，但用户机器上常常已经有一份（自己下的、或者旧版软件装的）。
 * 只在设置里没写、又没有自带时才找；找到就记进 settings.json，下次不用再扫。
 */
function detectNapcatDir(exe) {
  const bases = [
    path.join(os.homedir(), 'napcat-shell'), // 打包脚本的默认源目录
    path.join(os.homedir(), 'Documents', '默认项目', 'napcat'), // 以前手动装的
    path.join(path.dirname(SETTINGS_FILE), 'napcat') // 软件自己下到 userData 里的
  ];
  for (const base of bases) {
    if (!fs.existsSync(base)) continue;
    if (fs.existsSync(path.join(base, exe))) return base;
    let subs = [];
    try {
      subs = fs.readdirSync(base, { withFileTypes: true });
    } catch {
      continue;
    }
    // 先挑 NapCat* 这种完整目录，别选中 bootmain 之类只有启动器的半套
    const dirs = subs.filter((d) => d.isDirectory());
    dirs.sort((a, b) => Number(/^napcat/i.test(b.name)) - Number(/^napcat/i.test(a.name)));
    for (const d of dirs) {
      const p = path.join(base, d.name);
      if (fs.existsSync(path.join(p, exe))) return p;
    }
  }
  return '';
}

let napcatScanAt = 0;
let napcatScanHit = '';

function napcatSettings() {
  const s = readJson(SETTINGS_FILE);
  const n = s.napcat ?? {};
  const exe = n.exe ?? 'NapCatWinBootMain.exe';

  // 打包版自带 NapCat 时优先用它 —— 用户不用再去配路径。
  // 判断标准是启动器真的在，不看目录存在与否（空目录不算数）。
  const bundled = path.join(here, 'napcat');
  const hasBundled = fs.existsSync(path.join(bundled, exe));

  // 设置里没有、也没有自带 —— 先在本机常见位置找一遍，别一上来就让人重下
  let dir = hasBundled ? bundled : n.dir ? path.resolve(n.dir) : '';
  if (!dir) {
    const now = Date.now();
    if (now - napcatScanAt > 30_000) {
      napcatScanAt = now;
      napcatScanHit = detectNapcatDir(exe);
    }
    if (napcatScanHit && fs.existsSync(path.join(napcatScanHit, exe))) {
      dir = napcatScanHit;
      try {
        const next = readJson(SETTINGS_FILE);
        next.napcat = { ...(next.napcat ?? {}), dir };
        writeJson(SETTINGS_FILE, next);
        console.log(`[napcat] 找到本机已装的：${dir}`);
      } catch {
        /* 写不进去也不影响这次使用 */
      }
    }
  }

  return {
    dir,
    bundled: hasBundled,
    exe,
    qq: n.qq ?? '',
    wsPort: Number(n.wsPort) || 3001,
    httpPort: Number(n.httpPort) || 3000,
    waitMs: Number(n.waitMs) || 90_000,
    updateMode: n.updateMode === 'notify' ? 'notify' : 'off',
    updateRepo: String(n.updateRepo ?? 'NapNeko/NapCatQQ'),
    updateAsset: String(n.updateAsset ?? 'Shell.*\\.zip$'),
    updateMirror: String(n.updateMirror ?? ''),
    lastUpdateCheck: Number(n.lastUpdateCheck) || 0
  };
}

/** 账号序号：qq2 → 1（0 起）。 */
function napcatOrdinal(accountId) {
  const m = /^qq(\d+)$/.exec(String(accountId ?? ''));
  return m ? Math.max(0, Number(m[1]) - 1) : 0;
}

/**
 * NapCat 账号清单。
 *
 * 唯一数据源是 config.json 的 platforms.qq.accounts（桥接也读它）；
 * 没有这个字段时，用桌面端 settings.napcat 合成 qq1，等用户第一次
 * 添加/编辑账号时再整体写回 config.json。
 */
function napcatAccounts(cfg = loadConfig()) {
  const primary = napcatSettings();
  const { accounts } = normalizeQQAccounts({ ...cfg, snowluma: cfg.snowluma });
  return accounts.map((acc) => {
    const ports = accountPorts(napcatOrdinal(acc.id));
    const dir = acc.dir || (acc.id === DEFAULT_ACCOUNT_ID ? primary.dir : '');
    const configDir = dir ? findNapcatConfigDir(dir) : '';
    return {
      ...acc,
      // qq1 的 QQ 号以 settings.napcat.qq 为准：旧配置里 config.json 可能没有
      // platforms.qq.accounts / qq 字段，不能让账号卡片显示“未填”。
      qq: acc.qq || (acc.id === DEFAULT_ACCOUNT_ID ? primary.qq : ''),
      dir,
      configDir,
      exe: primary.exe,
      waitMs: primary.waitMs,
      bundled: primary.bundled,
      wsPort: Number(acc.wsPort) || ports.wsPort,
      httpPort: Number(acc.httpPort) || ports.httpPort,
      webuiPort: Number(acc.webuiPort) || ports.webuiPort,
      configured: Boolean(dir && fs.existsSync(path.join(dir, primary.exe)))
    };
  });
}

function napcatAccount(accountId = DEFAULT_ACCOUNT_ID, cfg = loadConfig()) {
  const id = isValidAccountId(String(accountId)) ? String(accountId) : DEFAULT_ACCOUNT_ID;
  return napcatAccounts(cfg).find((a) => a.id === id) ?? null;
}

function napcatAccountState(account) {
  const rec = napcatProcs.get(account.id);
  const configDir = account.configDir || (account.dir ? findNapcatConfigDir(account.dir) : '');
  const webui = configDir ? readJson(path.join(configDir, 'webui.json')) : {};
  return {
    id: account.id,
    qq: account.qq,
    label: account.label,
    dir: account.dir,
    configDir,
    enabled: account.enabled !== false,
    configured: account.configured,
    wsPort: account.wsPort,
    httpPort: account.httpPort,
    webuiPort: Number(webui.port) || account.webuiPort,
    // 启动器退出后 QQ 可能还在跑：managed 表示「这个号是我们拉起的、还没主动停」。
    running: Boolean(rec?.child || rec?.managed),
    pid: rec?.child?.pid ?? null,
    startedAt: rec?.startedAt ?? null,
    panel: configDir ? napcatPanel(account.id) : { ok: false, error: '找不到 webui.json（先启动一次 NapCat）' }
  };
}

function napcatAccountsState() {
  return napcatAccounts().map(napcatAccountState);
}

/**
 * 把账号清单写回 config.json。
 *
 * 桌面端 settings.json 只放「默认号」的路径/端口；多号必须落在桥接读的
 * platforms.qq.accounts 里，否则桥接根本不知道 qq2 的存在。
 */
function writeNapcatAccounts(accounts) {
  const cfg = loadConfig();
  const list = accounts.map((acc) => toConfigAccount({
    ...acc,
    homeDir: acc.homeDir || acc.configDir || ''
  }));
  cfg.platforms = cfg.platforms ?? {};
  cfg.platforms.qq = cfg.platforms.qq ?? {};
  cfg.platforms.qq.accounts = list;
  const primary = list.find((a) => a.id === DEFAULT_ACCOUNT_ID);
  if (primary) {
    cfg.platforms.qq.dir = primary.dir || cfg.platforms.qq.dir || '';
    cfg.snowluma = cfg.snowluma ?? {};
    if (primary.qq) cfg.qq = primary.qq;
    cfg.snowluma.homeDir = primary.homeDir || cfg.snowluma.homeDir || '';
    cfg.snowluma.wsUrl = `ws://127.0.0.1:${primary.wsPort}`;
    cfg.snowluma.httpUrl = `http://127.0.0.1:${primary.httpPort}`;
    if (primary.token) cfg.snowluma.accessToken = primary.token;
  }
  writeJson(configFile(), cfg);
  return list;
}

/**
 * 确保该号的 OneBot WebSocket/HTTP 端口与 token 落在它自己的
 * `onebot11_<QQ>.json` 里（NapCat 登录后读这个文件）。
 *
 * 只补齐缺失字段，不覆盖用户已经调好的其它设置；token 缺失时生成一次，
 * 并回写给调用方，让 config.json 里的账号 token 与 NapCat 保持一致。
 */
function ensureNapcatOneBotConfig(account) {
  const dir = account.configDir || findNapcatConfigDir(account.dir);
  if (!dir) return { ok: false, error: '找不到 NapCat 配置目录（先启动一次 NapCat 生成 config）' };
  // 同时写默认档和账号档：NapCat 登录前读 onebot11.json，登录后读 onebot11_<QQ>.json。
  // 每个号本来就是独立目录，两份写同一组端口不会互相影响，却能避免登录前的空窗期
  // 还用着 3001/3000 跟别的号撞端口。
  const files = [path.join(dir, 'onebot11.json')];
  if (account.qq) files.push(path.join(dir, `onebot11_${account.qq}.json`));
  const loaded = files.map((file) => ({ file, cfg: fs.existsSync(file) ? readJson(file) : {} }));
  const existing = loaded.flatMap(({ cfg }) => [
    ...(Array.isArray(cfg.network?.websocketServers) ? cfg.network.websocketServers.slice(0, 1) : []),
    ...(Array.isArray(cfg.network?.httpServers) ? cfg.network.httpServers.slice(0, 1) : [])
  ]);
  const token = account.token || existing.find((x) => x?.token)?.token || randomBytes(16).toString('hex');

  for (const { file, cfg } of loaded) {
    cfg.network = cfg.network ?? {};
    const ws = Array.isArray(cfg.network.websocketServers) ? cfg.network.websocketServers : [];
    const http = Array.isArray(cfg.network.httpServers) ? cfg.network.httpServers : [];
    cfg.network.websocketServers = [
      { ...(ws[0] ?? {}), enabled: true, host: '127.0.0.1', port: account.wsPort, token },
      ...ws.slice(1)
    ];
    cfg.network.httpServers = [
      { ...(http[0] ?? {}), enabled: true, host: '127.0.0.1', port: account.httpPort, token },
      ...http.slice(1)
    ];
    writeJson(file, cfg);
  }

  // WebUI 端口也按号错开；token 保留 NapCat 自己生成的那个。
  const webuiFile = path.join(dir, 'webui.json');
  if (fs.existsSync(webuiFile)) {
    const webui = readJson(webuiFile);
    if (Number(webui.port) !== Number(account.webuiPort)) {
      webui.port = account.webuiPort;
      writeJson(webuiFile, webui);
    }
  }
  return { ok: true, file: files[files.length - 1], token };
}

/** 新增一个 NapCat 号：必须指向一份独立的 NapCat 目录。 */
function addNapcatAccount(body = {}) {
  const exe = napcatSettings().exe;
  const rawDir = String(body.dir ?? '').trim();
  if (!rawDir) return { ok: false, error: '请选择这个号自己的 NapCat 目录' };
  const dir = path.resolve(rawDir);
  if (!fs.existsSync(path.join(dir, exe))) return { ok: false, error: `目录里没有 ${exe}：${dir}` };
  const accounts = napcatAccounts();
  if (accounts.some((a) => a.dir && path.resolve(a.dir) === dir)) {
    return { ok: false, error: '这个 NapCat 目录已被另一个号使用；多号必须每个号一份独立目录' };
  }
  const id = nextAccountId(accounts);
  const ports = accountPorts(napcatOrdinal(id));
  const account = {
    id,
    qq: String(body.qq ?? '').replace(/\D/g, ''),
    label: String(body.label ?? '').trim() || `QQ ${id}`,
    enabled: body.enabled !== false,
    dir,
    homeDir: '',
    wsPort: ports.wsPort,
    httpPort: ports.httpPort,
    webuiPort: ports.webuiPort,
    token: '',
    policy: {}
  };
  // 先把 token 写进这个号自己的 NapCat 配置，再回写 config.json：
  // 否则 bridge 读到空 token，qq2 会连不上（NapCat 已经生成了 token，但账号里没记）。
  const ensured = ensureNapcatOneBotConfig(account);
  if (ensured.ok && ensured.token) account.token = ensured.token;
  writeNapcatAccounts([...accounts, account]);
  pushLog(`已添加 NapCat 账号 ${id}（${dir}）`, 'sys', 'napcat');
  const fresh = napcatAccount(id);
  return { ok: true, account: fresh ? napcatAccountState(fresh) : null };
}

/** 改一个号：qq / 备注 / 目录 / 启用状态。 */
function updateNapcatAccount(accountId, body = {}) {
  const id = isValidAccountId(String(accountId)) ? String(accountId) : '';
  if (!id) return { ok: false, error: '账号 id 无效' };
  const accounts = napcatAccounts();
  const index = accounts.findIndex((a) => a.id === id);
  if (index < 0) return { ok: false, error: `账号 ${id} 不存在` };
  const next = { ...accounts[index] };
  if (body.qq !== undefined) next.qq = String(body.qq).replace(/\D/g, '');
  if (body.label !== undefined) next.label = String(body.label).trim();
  if (body.enabled !== undefined) next.enabled = body.enabled !== false;
  if (body.dir !== undefined) {
    const dir = path.resolve(String(body.dir).trim());
    if (!fs.existsSync(path.join(dir, napcatSettings().exe))) {
      return { ok: false, error: `目录里没有 ${napcatSettings().exe}：${dir}` };
    }
    if (accounts.some((a) => a.id !== id && a.dir && path.resolve(a.dir) === dir)) {
      return { ok: false, error: '这个 NapCat 目录已被另一个号使用' };
    }
    next.dir = dir;
    next.configDir = findNapcatConfigDir(dir);
  }
  // 与新增同理：ensure 可能生成/发现 token，先同步到账号再落盘。
  const ensured = ensureNapcatOneBotConfig(next);
  if (ensured.ok && ensured.token) next.token = ensured.token;
  accounts[index] = next;
  writeNapcatAccounts(accounts);
  const fresh = napcatAccount(id);
  return { ok: true, account: fresh ? napcatAccountState(fresh) : null };
}

/** 删一个号：qq1 是默认号，不删；运行中的先停。 */
function removeNapcatAccount(accountId) {
  const id = isValidAccountId(String(accountId)) ? String(accountId) : '';
  if (!id) return { ok: false, error: '账号 id 无效' };
  if (id === DEFAULT_ACCOUNT_ID) return { ok: false, error: '默认号 qq1 不能删除' };
  const runningRec = napcatProcs.get(id);
  if (runningRec?.child || runningRec?.managed) return { ok: false, error: `账号 ${id} 还在运行，先停止再删` };
  const accounts = napcatAccounts();
  if (!accounts.some((a) => a.id === id)) return { ok: false, error: `账号 ${id} 不存在` };
  writeNapcatAccounts(accounts.filter((a) => a.id !== id));
  stopNapcatTail(id);
  pushLog(`已删除 NapCat 账号 ${id}（会话数据保留，不复用编号）`, 'sys', 'napcat');
  return { ok: true, removed: id };
}

/**
 * 起 NapCat。
 *
 * 以前是 `windowsHide:false` + `stdio:'ignore'` —— **故意**留一个黑窗口，因为要扫码登录。
 * 代价是那个窗口收不进软件：用户得同时盯两个地方，窗口一关日志就没了，
 * 「集成」也就无从谈起。
 *
 * 现在改成窗口藏起来、把启动器的 stdout/stderr 接进「日志」页：
 *   - NapCat 的日志本来就是重定向出来的（启动时会自报
 *     `[StdOut] 已重定向到命名管道：\\.\pipe\NapCat_<pid>`），管道里有；
 *   - 扫码/登录走 WebUI 面板（`/api/napcat/panel` 会给出带 token 的地址，
 *     「运行」页有按钮直接打开）。
 *
 * ⚠️ 停它**不要**用同目录的 `napcat.kill.qq.bat`：那脚本里"输入 0"那条是
 * `taskkill /f /im QQ.exe`，会把用户自己日常在用的 QQ 一起杀掉。
 */
function startNapcat(accountId = DEFAULT_ACCOUNT_ID) {
  const id = isValidAccountId(String(accountId)) ? String(accountId) : DEFAULT_ACCOUNT_ID;
  const acc = napcatAccount(id);
  if (!acc) return { ok: false, error: `账号 ${id} 不在配置里` };
  if (acc.enabled === false) return { ok: false, error: `账号 ${id} 已禁用` };
  if (napcatProcs.get(id)?.child) return { ok: false, error: `账号 ${id} 已在运行` };
  if (!acc.dir) return { ok: false, error: `账号 ${id} 还没配 NapCat 目录` };
  if (!fs.existsSync(acc.dir)) return { ok: false, error: `NapCat 目录不存在：${acc.dir}` };

  const exe = path.join(acc.dir, acc.exe);
  if (!fs.existsSync(exe)) return { ok: false, error: `找不到启动器：${exe}` };

  // 多号必须各用各的目录：同一个 NapCat Shell 目录只能跑一个 QQ。
  const clash = [...napcatProcs.entries()].find(
    ([otherId, other]) => otherId !== id && (other.child || other.managed) && other.dir && path.resolve(other.dir) === path.resolve(acc.dir)
  );
  if (clash) return { ok: false, error: `NapCat 目录正被账号 ${clash[0]} 使用；多号必须每个号一份独立目录` };

  lastNapcatDir = acc.dir;
  // 没开文件日志的话，NapCat 的输出只会进命名管道，日志页永远是空的
  ensureNapcatFileLog(acc.dir);

  // 启动前把该号的 WS/HTTP 端口与 token 写进它自己的 onebot11_<QQ>.json。
  const onebot = ensureNapcatOneBotConfig(acc);
  if (onebot.token && onebot.token !== acc.token) {
    try {
      const list = napcatAccounts();
      const index = list.findIndex((a) => a.id === id);
      if (index >= 0) {
        list[index].token = onebot.token;
        writeNapcatAccounts(list);
      }
    } catch { /* 写不进去不影响启动，桥接会按旧 token 先试 */ }
  }

  const child = spawn(exe, acc.qq ? [String(acc.qq)] : [], {
    cwd: acc.dir,
    windowsHide: true,
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const state = { startedAt: Date.now(), pid: child.pid, child, dir: acc.dir, managed: true };
  napcatProcs.set(id, state);
  if (id === DEFAULT_ACCOUNT_ID) napcatLaunch = { startedAt: state.startedAt, pid: child.pid, child };
  pushLog(`[${id}] NapCat 启动中（QQ ${acc.qq || '未填'}，WS ${acc.wsPort}）`, 'sys', 'napcat');
  startNapcatTail(id);
  pushLog(`[${id}] NapCat 在后台跑；扫码登录用「打开 NapCat 面板」`, 'sys', 'napcat');

  relay(child.stdout, 'out', 'napcat');
  relay(child.stderr, 'err', 'napcat');
  child.on('close', (code) => {
    const prev = napcatProcs.get(id);
    // 启动器退出 ≠ QQ 退出：保留 managed，让看护按端口继续管这个号。
    if (prev?.child === child) {
      napcatProcs.set(id, {
        child: null,
        startedAt: prev.startedAt,
        exitCode: code,
        dir: acc.dir,
        managed: true
      });
    }
    if (id === DEFAULT_ACCOUNT_ID && napcatLaunch.child === child) napcatLaunch = { startedAt: null, pid: null, child: null };
    pushLog(`[${id}] NapCat 启动器已退出（code ${code}）`, code === 0 ? 'sys' : 'err', 'napcat');
  });

  return { ok: true, pid: child.pid, account: id };
}

/* ── 收进程树 ────────────────────────────────────────────────────────────
 * Windows 上 Electron / node 退出**不会**连带杀掉子进程：QQ 桥接、微信 bot、
 * NapCat 都会变成孤儿。以前 stopNapcat() 只按启动器镜像名杀，启动器自己先退了
 * 就什么也没杀到，NapCat 里那份 QQ.exe 继续占着端口 —— 表现就是「关了软件，
 * NapCat 还在」。
 * 所以退出时必须按 pid 树 + NapCat 目录里的可执行文件路径各收一遍。
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 给停止结果挂一个「收尾完成」Promise。
 *
 * 必须不可枚举：这些结果会直接 sendJson 给界面，Promise 序列化成 `{}` 很难看。
 * 快捷键 `result.done` 照常能拿到。
 */
function withDone(result, done) {
  Object.defineProperty(result, 'done', { value: done, enumerable: false, configurable: true });
  return result;
}

/** 杀一个进程和它的整棵子树；返回 Promise，等 taskkill 真跑完。 */
function killProcessTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return Promise.resolve(false);
  if (process.platform !== 'win32') {
    try {
      process.kill(pid, 'SIGTERM');
      return Promise.resolve(true);
    } catch {
      return Promise.resolve(false);
    }
  }
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } catch {
      resolve(false);
      return;
    }
    proc.once('error', () => resolve(false));
    proc.once('close', (code) => resolve(code === 0));
  });
}

/**
 * 找出某个 NapCat 目录下正在跑的进程。
 *
 * 为什么不能 `taskkill /IM QQ.exe`：用户日常用的 QQ 也叫这个名字，一起杀掉
 * 是事故。NapCat Shell 版是一份独立的 QQ 副本（`<目录>\QQ.exe`），按可执行
 * 文件路径过滤既收得干净又不会误伤。
 */
function listNapcatPids(dir) {
  if (process.platform !== 'win32' || !dir || dir.length < 4) return Promise.resolve([]);
  const script = [
    '$root = [System.IO.Path]::GetFullPath($env:DHM_NAPCAT_DIR).TrimEnd([char]92) + [char]92',
    '$list = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {',
    '  $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase) -and',
    '  ($_.Name -eq "QQ.exe" -or $_.Name -eq "NapCatWinBootMain.exe")',
    '} | ForEach-Object { $_.ProcessId }',
    'if ($list) { $list }'
  ].join('\n');

  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    let timer = null;
    const finish = (pids) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(pids);
    };
    let proc;
    try {
      proc = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true,
        env: { ...process.env, DHM_NAPCAT_DIR: dir },
        stdio: ['ignore', 'pipe', 'ignore']
      });
    } catch {
      resolve([]);
      return;
    }
    timer = setTimeout(() => {
      try { proc.kill(); } catch { /* 已经退了 */ }
      finish([]);
    }, 5000);
    timer.unref?.();
    proc.stdout.on('data', (chunk) => { out += chunk.toString(); });
    proc.once('error', () => finish([]));
    proc.once('close', () => {
      const pids = out
        .split(/\r?\n/)
        .map((line) => Number(line.trim()))
        .filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
      finish(pids);
    });
  });
}

/**
 * 停 NapCat。
 *
 * **只收它自己的进程**：先按启动器 pid 杀整棵树，再按 NapCat 目录里的
 * 可执行文件路径补一遍（启动器退出后 pid 就没了，真正干活的是那份 QQ.exe）。
 * 两种情况都不碰用户日常在用的 QQ。
 *
 * 返回里的 `done` 是个 Promise —— 退出流程要等它，不能 app 先没了、
 * taskkill 还在半路。
 */
function stopNapcat(accountId = DEFAULT_ACCOUNT_ID, { force = false } = {}) {
  const id = isValidAccountId(String(accountId)) ? String(accountId) : DEFAULT_ACCOUNT_ID;
  markManualStop(id === DEFAULT_ACCOUNT_ID ? 'napcat' : `napcat:${id}`);
  const rec = napcatProcs.get(id);
  const acc = napcatAccount(id);
  const launchedPid = rec?.child?.pid ?? null;
  const dirs = [...new Set([acc?.dir, rec?.dir].filter(Boolean))];
  // 配置被手改成同一个目录时，停一个号不能顺手把另一个号的进程收掉。
  const conflict = force ? null : [...napcatProcs.entries()].find(
    ([otherId, other]) => otherId !== id && (other.child || other.managed) && other.dir &&
      dirs.some((dir) => path.resolve(dir) === path.resolve(other.dir))
  );
  if (conflict) {
    const message = `NapCat 目录正被账号 ${conflict[0]} 使用；多号必须每个号一份独立目录`;
    pushLog(`[${id}] 停止被拒绝：${message}`, 'err', 'napcat');
    return withDone({ ok: false, error: message }, Promise.resolve());
  }
  napcatProcs.set(id, { child: null, startedAt: null, exitCode: null, dir: rec?.dir || acc?.dir || '', managed: false });
  if (id === DEFAULT_ACCOUNT_ID) napcatLaunch = { startedAt: null, pid: null, child: null };
  const targets = new Set();
  if (launchedPid) targets.add(launchedPid);

  const done = (async () => {
    try {
      for (const dir of dirs) {
        for (const pid of await listNapcatPids(dir)) targets.add(pid);
      }

      // 启动器 pid 已经死了、路径也认不出来时，退回只杀启动器镜像。
      // 多号时绝不能这么做：那会把别的号的启动器一起收掉。
      let fallbackRan = false;
      const otherRunning = [...napcatProcs.entries()].some(([otherId, other]) => otherId !== id && (other.child || other.managed));
      if (!targets.size && !dirs.length && !otherRunning && process.platform === 'win32') {
        fallbackRan = true;
        await new Promise((resolve) => {
          let proc;
          try {
            proc = spawn('taskkill', ['/IM', 'NapCatWinBootMain.exe', '/F'], { windowsHide: true, stdio: 'ignore' });
          } catch {
            resolve();
            return;
          }
          proc.once('error', resolve);
          proc.once('close', resolve);
        });
      }

      const killed = await Promise.all([...targets].map((pid) => killProcessTree(pid)));
      const killedCount = killed.filter(Boolean).length;

      // 本来就没在跑：别再来一轮「等它退出」的轮询，白等一秒。
      if (!targets.size && !fallbackRan) {
        pushLog(`[${id}] NapCat 没在运行，跳过`, 'sys', 'napcat');
        return { ok: true, killed: 0, remaining: [] };
      }

      // 等进程真的退干净（最多 4 秒）。不等的话桌面端先退出了，
      // 用户下一秒打开任务管理器还能看见 NapCat。
      for (let i = 0; i < 10; i += 1) {
        const left = (await Promise.all(dirs.map(listNapcatPids))).flat();
        if (!left.length) break;
        await sleep(400);
      }

      const remaining = [...new Set((await Promise.all(dirs.map(listNapcatPids))).flat())];
      if (remaining.length) {
        pushLog(`[${id}] NapCat 还有 ${remaining.length} 个进程没退（pid ${remaining.join(', ')}）`, 'err', 'napcat');
      } else if (targets.size) {
        pushLog(`[${id}] NapCat 已停止（收掉 ${killedCount} 个进程）`, 'sys', 'napcat');
      }
      return { ok: remaining.length === 0, killed: killedCount, remaining };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  })();

  pushLog(`已请求停止 NapCat 账号 ${id}`, 'sys', 'napcat');
  return withDone({ ok: true, pid: launchedPid, account: id }, done);
}

/** 停掉所有 NapCat 号（退出软件时用）。 */
function stopAllNapcat() {
  const ids = [...new Set([...napcatProcs.keys(), ...napcatAccounts().map((a) => a.id)])];
  const done = (async () => {
    const results = [];
    for (const id of ids) {
      const result = stopNapcat(id, { force: true });
      const detail = result?.done ? await result.done : null;
      results.push({
        account: id,
        ok: result?.ok !== false && detail?.ok !== false,
        killed: detail?.killed ?? 0,
        remaining: detail?.remaining ?? []
      });
    }
    return { ok: results.every((r) => r.ok), accounts: results };
  })();
  return withDone({ ok: true }, done);
}

/**
 * 找 NapCat 真正的运行时配置目录。
 *
 * Shell 版把 config 藏在 `versions/<版本>/resources/app/napcat/config/` 里，
 * 根目录那个 `config/` 是空的 —— 而版本号会变（`9.9.33-52230` → …），
 * 所以只能搜，不能写死。
 */
function findNapcatConfigDir(rootDir = napcatSettings().dir) {
  const n = napcatSettings();
  const root = rootDir || n.dir;
  if (!root) return '';
  const direct = path.join(root, 'config');
  if (fs.existsSync(path.join(direct, 'webui.json'))) return direct;

  const versions = path.join(root, 'versions');
  if (!fs.existsSync(versions)) return '';
  for (const v of fs.readdirSync(versions)) {
    const dir = path.join(versions, v, 'resources', 'app', 'napcat', 'config');
    if (fs.existsSync(path.join(dir, 'webui.json'))) return dir;
  }
  return '';
}

/**
 * NapCat 自己的日志目录。
 *
 * 为什么不再指望启动器的 stdout：NapCat Shell 版是把 NapCat 注入进 QQ 进程的，
 * 真正干活的日志不走启动器那根管道 —— 它重定向到命名管道 `\\.\pipe\NapCat_<pid>`，
 * 我们这边读不到。结果是「日志 → NapCat」那一栏只有两行系统提示，看着像没跑。
 * 所以改成读 NapCat 自己写的文件日志（napcat.json 里 fileLog: true）。
 */
function findNapcatLogDir(rootDir = napcatSettings().dir) {
  const n = napcatSettings();
  const root = rootDir || n.dir;
  if (!root) return '';
  const versions = path.join(root, 'versions');
  if (fs.existsSync(versions)) {
    for (const v of fs.readdirSync(versions)) {
      const dir = path.join(versions, v, 'resources', 'app', 'napcat', 'logs');
      if (fs.existsSync(dir)) return dir;
    }
  }
  const direct = path.join(root, 'logs');
  return fs.existsSync(direct) ? direct : '';
}

/**
 * 把 NapCat 的 fileLog 打开，否则 logs 目录永远是空的。
 *
 * 只改这一个字段，改之前留一份 .bak —— 那是他自己装的 NapCat，配置不该被无声改掉。
 */
function ensureNapcatFileLog(rootDir = napcatSettings().dir) {
  const dir = findNapcatConfigDir(rootDir);
  if (!dir) return { ok: false, error: '找不到 NapCat 配置目录' };
  const file = path.join(dir, 'napcat.json');
  if (!fs.existsSync(file)) return { ok: false, error: '没有 napcat.json' };

  const cfg = readJson(file);
  if (cfg.fileLog === true) return { ok: true, changed: false };

  try {
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    fs.copyFileSync(file, `${file}.bak-${stamp}`);
    cfg.fileLog = true;
    writeJson(file, cfg);
    pushLog('已打开 NapCat 的文件日志（原配置备份成 napcat.json.bak-…），NapCat 下次启动生效', 'sys', 'napcat');
    return { ok: true, changed: true };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/**
 * 追 NapCat 的日志文件（每个号一份）。
 *
 * 按字节增量读，只认到最后一个换行符为止 —— 一次写入可能停在半行，
 * 直接按字符串切会把一条日志切成两截。轮转（maxFiles 5）时文件变小，offset 归零重读。
 */
const napcatTails = new Map();

function startNapcatTail(accountId = DEFAULT_ACCOUNT_ID) {
  const id = isValidAccountId(String(accountId)) ? String(accountId) : DEFAULT_ACCOUNT_ID;
  const existing = napcatTails.get(id);
  if (existing?.timer) return;
  const acc = napcatAccount(id);
  const dir = findNapcatLogDir(acc?.dir);
  if (!dir) return;
  const state = { dir, file: '', offset: 0, timer: null, hinted: false };
  state.timer = setInterval(() => pumpNapcatLog(id), 1000);
  state.timer.unref?.();
  napcatTails.set(id, state);
  pumpNapcatLog(id);
}

function stopNapcatTail(accountId) {
  if (accountId === undefined) {
    for (const id of [...napcatTails.keys()]) stopNapcatTail(id);
    return;
  }
  const id = isValidAccountId(String(accountId)) ? String(accountId) : DEFAULT_ACCOUNT_ID;
  const state = napcatTails.get(id);
  if (state?.timer) clearInterval(state.timer);
  napcatTails.delete(id);
}

function pumpNapcatLog(accountId = DEFAULT_ACCOUNT_ID) {
  const id = isValidAccountId(String(accountId)) ? String(accountId) : DEFAULT_ACCOUNT_ID;
  const state = napcatTails.get(id);
  const dir = state?.dir;
  if (!dir) return;

  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.log'));
  } catch {
    return;
  }

  if (!files.length) {
    // 只提示一次，别每秒刷屏
    if (!state.hinted) {
      state.hinted = true;
      pushLog(`[${id}] NapCat 还没写出日志文件。开一次 NapCat（或点「一键启动」），文件日志就会开始记。`, 'sys', 'napcat');
    }
    return;
  }

  let newest = '';
  let newestAt = -1;
  for (const f of files) {
    try {
      const st = fs.statSync(path.join(dir, f));
      if (st.mtimeMs > newestAt) {
        newestAt = st.mtimeMs;
        newest = f;
      }
    } catch {
      /* 正在被轮转，跳过这一轮 */
    }
  }
  if (!newest) return;

  if (newest !== state.file) {
    state.file = newest;
    state.offset = 0;
  }

  const full = path.join(dir, newest);
  let size = 0;
  try {
    size = fs.statSync(full).size;
  } catch {
    return;
  }
  if (size < state.offset) state.offset = 0;
  if (size === state.offset) return;

  let buf;
  try {
    const fd = fs.openSync(full, 'r');
    const len = size - state.offset;
    buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, state.offset);
    fs.closeSync(fd);
  } catch {
    return;
  }

  // 只吃到最后一个换行：剩下的半行等下次写完再读
  const lastNl = buf.lastIndexOf(0x0a);
  if (lastNl < 0) return;

  state.offset += lastNl + 1;
  const text = buf.subarray(0, lastNl + 1).toString('utf8');
  for (const line of text.split('\n')) {
    const clean = line.replace(/\r$/, '').replace(ANSI, '').trimEnd();
    if (clean) pushLog(id === DEFAULT_ACCOUNT_ID ? clean : `[${id}] ${clean}`, 'out', 'napcat');
  }
}

/**
 * 返回 NapCat WebUI 面板地址（带 token，点了直接进，不用手抄）。
 *
 * 为什么把 token 也给前端：它本来就明文躺在 `webui.json` 里，而服务只监听
 * 127.0.0.1、页面同源 —— 本地自用，抄 token 只是折磨人。
 */
function napcatPanel(accountId = DEFAULT_ACCOUNT_ID) {
  const acc = napcatAccount(accountId);
  const dir = acc?.configDir || findNapcatConfigDir(acc?.dir);
  if (!dir) return { ok: false, error: '找不到 NapCat 的 webui.json（NapCat 目录配了吗？）' };
  const cfg = readJson(path.join(dir, 'webui.json'));
  const port = Number(cfg.port) || acc?.webuiPort || 6099;
  const token = typeof cfg.token === 'string' ? cfg.token : '';
  return {
    ok: true,
    account: acc?.id ?? DEFAULT_ACCOUNT_ID,
    port,
    token,
    configDir: dir,
    url: `http://127.0.0.1:${port}/webui${token ? `?token=${encodeURIComponent(token)}` : ''}`
  };
}

/* ══════════════════════════════════════════════════════════════════════════
 * NapCat 自动更新（GitHub Releases）
 *
 * 两档：off / notify（检查 + 记日志 + 界面提醒，装不装由人点）。
 * 不做「自动安装」：换掉正在跑的 NapCat 会断开登录态，必须人点头。
 * 流程：查 latest release → 按匹配规则挑 Shell 压缩包 → 下载 → tar 解压 →
 * 校验启动器在 → 装成旁边的 NapCat-<tag> 目录 → 把 settings 的 dir 指过去。
 * 原目录永远保留（更新不是覆盖，是换指针），跑不了一眼就能退回。
 * 国内直连 GitHub 不稳：updateMirror 可以填镜像前缀（如 https://ghproxy.cn/），
 * 下载 URL 会拼成 镜像/原始URL；API 查询不走镜像，连不上就提示手动检查。
 * ══════════════════════════════════════════════════════════════════════════ */

async function napcatUpdateInfo() {
  const n = napcatSettings();
  const repo = String(n.updateRepo || 'NapNeko/NapCatQQ').replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '');
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { 'user-agent': 'DualHabitat-Matrix', accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(15_000)
  });
  if (!res.ok) throw new Error(`GitHub API HTTP ${res.status}`);
  const rel = await res.json();
  const assets = (rel.assets ?? []).map((a) => ({ name: String(a.name), size: Number(a.size) || 0, url: String(a.browser_download_url) }));
  let picked = null;
  try {
    const re = new RegExp(n.updateAsset || 'Shell.*\\.zip$', 'i');
    picked = assets.find((a) => re.test(a.name)) ?? null;
  } catch {
    /* 匹配规则写坏了就当作没挑上，让用户自己从列表里选 */
  }
  const current = n.dir ? path.basename(n.dir) : '';
  return { repo, tag: String(rel.tag_name ?? ''), name: String(rel.name ?? ''), publishedAt: String(rel.published_at ?? ''), assets, picked, current, dir: n.dir };
}

async function applyNapcatUpdate(assetUrl) {
  const n = napcatSettings();
  const info = await napcatUpdateInfo();
  const asset = assetUrl ? (info.assets.find((a) => a.url === assetUrl) ?? null) : info.picked;
  if (!asset) return { ok: false, error: '发行版里没有匹配的 Shell 压缩包 —— 去「参数与日志」页调一下匹配规则，或从资产列表里手动指定' };
  const line = await pickDownloadLine(asset.url, n.updateMirror);
  const tmp = path.join(os.tmpdir(), `napcat-update-${Date.now()}`);
  fs.mkdirSync(tmp, { recursive: true });
  pushLog(`下载 NapCat 更新：${asset.name}（${(asset.size / 1048576).toFixed(1)} MB，线路 ${line.via}）`, 'sys', 'napcat');
  const zipPath = path.join(tmp, asset.name);
  const dl = await downloadToFile(line.url, zipPath);
  if (!dl.ok) {
    return { ok: false, error: `下载失败：${dl.error}${downloadHint(line.mode)}` };
  }
  const dest = path.join(tmp, 'unpacked');
  fs.mkdirSync(dest, { recursive: true });
  await new Promise((resolve) => {
    const child = spawn(tarExe(), ['-xf', zipPath, '-C', dest], { windowsHide: true });
    child.on('close', (code) => resolve(code));
    child.on('error', () => resolve(-1));
  });
  let root = dest;
  try {
    const entries = fs.readdirSync(dest);
    if (entries.length === 1 && fs.statSync(path.join(dest, entries[0])).isDirectory()) root = path.join(dest, entries[0]);
  } catch { /* 读不了就按根目录用 */ }
  if (!fs.existsSync(path.join(root, n.exe))) {
    return { ok: false, error: `解压出来没找到 ${n.exe} —— 挑的可能不是 Shell 包，换个资产再试` };
  }
  const safeTag = String(info.tag || 'update').replace(/[\\\/:*?"<>|]/g, '');
  const newDir = path.join(path.dirname(n.dir), `NapCat-${safeTag}`);
  try {
    if (fs.existsSync(newDir)) fs.rmSync(newDir, { recursive: true, force: true });
    fs.renameSync(root, newDir);
  } catch (error) {
    return { ok: false, error: `安装失败：${error?.message ?? error}` };
  }
  const s = readJson(SETTINGS_FILE);
  s.napcat = { ...(s.napcat ?? {}), dir: newDir, lastUpdateCheck: Date.now() };
  writeJson(SETTINGS_FILE, s);
  pushLog(`NapCat 已更新到 ${info.tag}：${newDir}（原目录保留：${n.dir}）`, 'sys', 'napcat');
  let restarted = false;
  if (napcatLaunch.startedAt || (await probePort(n.wsPort))) {
    stopNapcat();
    await new Promise((r) => setTimeout(r, 2500));
    startNapcat();
    restarted = true;
  }
  return { ok: true, tag: info.tag, newDir, restarted };
}

/**
 * 找 tar。
 *
 * 不能直接 spawn('tar')：打包后的 Electron 进程继承的是系统 PATH，
 * Git Bash 的 /usr/bin 不在里面，会直接 ENOENT。Windows 10 1803 起
 * System32 下自带 bsdtar，用绝对路径最稳。
 */
function tarExe() {
  const sys = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  return fs.existsSync(sys) ? sys : 'tar';
}

/* ── 下载线路：自动测速选快 ────────────────────────────
 *
 * GitHub 直连在国内不稳，镜像站又各有快慢和存亡。updateMirror 三档语义：
 *   空（默认）= 自动：下载前对直连 + 内置镜像并发发一个 1 字节的探测请求
 *               （Range: bytes=0-0），可用的里挑最快的，日志写明选了谁；
 *   'off'     = 直连，不碰镜像；
 *   填 URL    = 固定走这条镜像（老用法不变）。
 * 探测只花一个字节和最多 4 秒，下载是几百 MB 的大头，这点开销值得。
 * 镜像列表是内置的常用站，挂了会自动在测速里被淘汰，不阻塞下载。
 */
const DOWNLOAD_MIRRORS = ['https://ghproxy.cn', 'https://ghfast.top', 'https://gh.ddlc.top'];

async function probeLine(url) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(url, { headers: { range: 'bytes=0-0', 'user-agent': 'DualHabitat-Matrix' }, signal: ctrl.signal, redirect: 'follow' });
    await res.body?.cancel().catch(() => { /* 取消失败无所谓 */ });
    if (res.status === 200 || res.status === 206) return { ok: true, ms: Date.now() - t0 };
    return { ok: false, status: res.status };
  } catch (error) {
    return { ok: false, error: String(error?.cause?.code ?? error?.message ?? error).slice(0, 40) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 三档线路策略，返回 { url, via, mode, probed }：
 * via 是给日志看的人话（选了哪条线、多少毫秒），probed 只在 auto 档有值。
 */
async function pickDownloadLine(assetUrl, mirrorSetting) {
  const mirror = String(mirrorSetting ?? '').trim().replace(/\/$/, '');
  if (mirror === 'off') return { url: assetUrl, via: '直连', mode: 'direct' };
  if (mirror) return { url: `${mirror}/${assetUrl}`, via: `固定镜像 ${mirror}`, mode: 'fixed' };
  const candidates = [
    { via: '直连', url: assetUrl },
    ...DOWNLOAD_MIRRORS.map((m) => ({ via: m.replace('https://', ''), url: `${m}/${assetUrl}` }))
  ];
  const probed = await Promise.all(candidates.map(async (c) => ({ ...c, ...(await probeLine(c.url)) })));
  const alive = probed.filter((r) => r.ok).sort((a, b) => a.ms - b.ms);
  const detail = probed.map((r) => `${r.via} ${r.ok ? `${r.ms}ms` : `不通(${r.status ?? r.error ?? '?'})`}`).join(' · ');
  if (!alive.length) {
    pushLog(`线路测速全挂：${detail} → 还是回落直连试一下`, 'sys');
    return { url: assetUrl, via: '直连', mode: 'auto', probed };
  }
  const best = alive[0];
  pushLog(`线路测速：${detail} → 用 ${best.via}`, 'sys');
  return { url: best.url, via: best.via, mode: 'auto', probed };
}

/** 下载失败时按线路档位给的人话建议。 */
function downloadHint(mode) {
  if (mode === 'fixed') return '';
  if (mode === 'direct') return '（GitHub 直连不行可在「高级 → 更新」填镜像前缀，比如 https://ghproxy.cn/）';
  return '（线路是下载前自动测速挑的，重试会重新测速换线；也可以在「高级 → 更新」固定一条镜像，比如 https://ghproxy.cn/）';
}

/**
 * 带看门狗的下载：90 秒没有任何新数据就断开。
 *
 * 为什么不能只靠总超时：GitHub 的 release 会 302 到 objects.githubusercontent.com，
 * 国内常见「连上了但不给数据」。一个 900 秒的总超时会把界面挂十几分钟，
 * 看起来像卡死；看门狗能在 90 秒内给出「网络卡死」这种能看懂的错误。
 *
 * @returns {{ok:true,got:number,total:number}|{ok:false,error:string}}
 */
async function downloadToFile(url, dest, onProgress) {
  const ctrl = new AbortController();
  let abortReason = '';
  let lastByteAt = Date.now();
  let total = 0;
  let got = 0;

  const watchdog = setInterval(() => {
    if (Date.now() - lastByteAt > 90_000) {
      abortReason = '90 秒没有收到任何数据 —— 网络卡住了。去「高级 → 更新」填个下载镜像前缀再试';
      ctrl.abort();
    }
  }, 5000);

  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    total = Number(res.headers.get('content-length')) || 0;
    lastByteAt = Date.now();

    const file = fs.createWriteStream(dest);
    try {
      for await (const chunk of Readable.fromWeb(res.body)) {
        got += chunk.length;
        lastByteAt = Date.now();
        if (!file.write(chunk)) await new Promise((r) => file.once('drain', r));
        if (total) onProgress?.(Math.min(1, got / total), got, total);
      }
      await new Promise((r) => file.end(r));
    } catch (error) {
      file.destroy();
      throw error;
    }
    return { ok: true, got, total };
  } catch (error) {
    fs.rmSync(dest, { force: true });
    return { ok: false, error: abortReason || String(error?.message ?? error) };
  } finally {
    clearInterval(watchdog);
  }
}

/**
 * 下载并装一份 NapCat（给「精简安装包」用）。
 *
 * 为什么不把这一步塞进安装器：NSIS 里没有可靠的下载插件（要额外带 inetc），
 * 而且安装过程断网就整个装不上。放在软件里做，能重试、能换镜像、能显示进度，
 * 装完直接把路径写进设置 —— 对用户来说还是「点一下，等它自己下完」。
 *
 * 装到 userData/napcat/NapCat-<tag>，不动安装目录（Program Files 下写不进去）。
 */
async function installNapcat() {
  const info = await napcatUpdateInfo();
  const asset = info.picked;
  if (!asset) {
    return { ok: false, error: '发行版里没有匹配的 Shell 压缩包 —— 去「高级」页调一下资产匹配规则' };
  }
  const n = napcatSettings();
  const line = await pickDownloadLine(asset.url, n.updateMirror);
  const tmp = path.join(os.tmpdir(), `napcat-install-${Date.now()}`);
  fs.mkdirSync(tmp, { recursive: true });
  pushLog(`开始下载 NapCat ${info.tag}：${asset.name}（${(asset.size / 1048576).toFixed(1)} MB，线路 ${line.via}）`, 'sys', 'napcat');

  const zipPath = path.join(tmp, asset.name);
  const dl = await downloadToFile(line.url, zipPath, (ratio) => {
    componentJob = { ...(componentJob ?? {}), id: 'napcat', pct: Math.round(ratio * 70), note: '下载中' };
  });
  if (!dl.ok) {
    return { ok: false, error: `下载失败：${dl.error}${downloadHint(line.mode)}` };
  }
  return installNapcatFromZip(zipPath, info.tag, asset.size);
}

/**
 * 从一个已经下好的 zip 装 NapCat。
 *
 * 拆出来是为了让「从本地文件装」和「从网上下载装」走同一条路 ——
 * 国内 GitHub 基本下不动，用户自己下好的包得能直接用。
 */
async function installNapcatFromZip(zipPath, tag, size = 0) {
  const n = napcatSettings();
  const tmp = path.dirname(zipPath);
  const dest = path.join(tmp, 'unpacked');
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  const tarCode = await new Promise((resolve) => {
    const child = spawn(tarExe(), ['-xf', zipPath, '-C', dest], { windowsHide: true });
    child.on('close', (code) => resolve(code));
    child.on('error', () => resolve(-1));
  });
  if (tarCode !== 0) return { ok: false, error: '解压失败（本机 tar 不可用？）' };

  let root = dest;
  try {
    const entries = fs.readdirSync(dest);
    if (entries.length === 1 && fs.statSync(path.join(dest, entries[0])).isDirectory()) root = path.join(dest, entries[0]);
  } catch { /* 读不了就按根目录用 */ }
  if (!fs.existsSync(path.join(root, n.exe))) {
    return { ok: false, error: `解压出来没找到 ${n.exe} —— 这个可能不是 Shell 包` };
  }

  const safeTag = String(tag || 'latest').replace(/[\\/:*?"<>|]/g, '');
  const base = path.join(path.dirname(SETTINGS_FILE), 'napcat');
  const target = path.join(base, `NapCat-${safeTag}`);
  try {
    fs.mkdirSync(base, { recursive: true });
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(root, target);
  } catch (error) {
    return { ok: false, error: `安装失败：${error?.message ?? error}` };
  }

  const s = readJson(SETTINGS_FILE);
  s.napcat = { ...(s.napcat ?? {}), dir: target, lastUpdateCheck: Date.now(), lastUpdateFound: '' };
  writeJson(SETTINGS_FILE, s);
  pushLog(`NapCat ${safeTag} 装好了：${target}`, 'sys', 'napcat');
  return { ok: true, tag: safeTag, dir: target, size };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 组件：得下载才有、但不必塞进安装包的东西
 *
 * 为什么不做进安装包：NapCat 约 200 MB、ffmpeg 约 200 MB，全塞进去安装包直接
 * 1.6 GB，而大多数人只用得上其中一个。改成「点一下装进来」：
 *   - 装到 userData/components 下（Program Files 写不进去）
 *   - 装完把路径写进配置，桥接下次启动就用上
 *   - 进度挂在内存里，前端轮询显示 —— 一次请求挂十分钟容易被当成卡死
 * ══════════════════════════════════════════════════════════════════════════ */

/** 正在装的组件。null = 没在装。装完保留 done/error 供前端收尾。 */
let componentJob = null;

/* 官方静态包地址。DHM_FFMPEG_URL 可以覆盖 —— 内网自建镜像、或者离线测试用。 */
const FFMPEG_ZIP_URL =
  process.env.DHM_FFMPEG_URL ||
  'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip';

function componentsDir() {
  return path.join(path.dirname(SETTINGS_FILE), 'components');
}

/** 本机 ffmpeg 在哪：配置里指的 → 软件自己装的 → 系统 PATH 里的，按顺序认。 */
function findFfmpeg() {
  const cfg = loadConfig();
  const custom = String(cfg.socialV2?.voice?.ffmpegPath ?? '').trim();
  if (custom && fs.existsSync(custom)) return { path: custom, via: '配置里指的' };

  const local = path.join(componentsDir(), 'ffmpeg', 'ffmpeg.exe');
  if (fs.existsSync(local)) return { path: local, via: '软件装的' };

  try {
    const out = spawnSync('where.exe', ['ffmpeg'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    if (out.status === 0) {
      const first = String(out.stdout ?? '')
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)[0];
      if (first) return { path: first, via: '系统 PATH 里的' };
    }
  } catch {
    /* 没有 where.exe 就往下试 */
  }

  // where 查不到不代表没有：WinGet 装的是无扩展名符号链接，where 只按 PATHEXT 找。
  // 直接试跑一次最实在 —— 能吐出 `ffmpeg version` 就是能用。
  try {
    const out = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
    if (out.status === 0) return { path: 'ffmpeg（走 PATH）', via: '系统 PATH 里的' };
  } catch {
    /* 没装就是没装 */
  }

  return { path: '', via: '' };
}

function componentList() {
  const n = napcatSettings();
  const exePath = n.dir ? path.join(n.dir, n.exe) : '';
  const napcatOk = Boolean(exePath && fs.existsSync(exePath));
  const ff = findFfmpeg();

  return [
    {
      id: 'napcat',
      name: 'NapCat',
      need: 'QQ 那条链路',
      detail: 'QQ 的 OneBot 网关。走 QQ 就必须有它，走微信用不上。',
      installed: napcatOk,
      where: napcatOk ? n.dir : '',
      note: napcatOk ? (n.bundled ? '安装包自带' : '已装在这台机器上') : '还没装',
      size: '约 200 MB'
    },
    {
      id: 'ffmpeg',
      name: 'ffmpeg',
      need: '语音',
      detail: '模型发语音时用它调音量、转码。不发语音可以不装。',
      installed: Boolean(ff.path),
      where: ff.path,
      note: ff.path ? `已找到 · ${ff.via}` : '还没装',
      size: '约 200 MB'
    }
  ];
}

/** 下载 ffmpeg 的 Windows 静态包，只留 bin 下那三个 exe。 */
async function installFfmpeg() {
  const zipPath = path.join(os.tmpdir(), `ffmpeg-dl-${Date.now()}.zip`);
  // 线路和 NapCat 共用一个设置项：空=自动测速选最快，off=直连，URL=固定镜像
  const line = await pickDownloadLine(FFMPEG_ZIP_URL, napcatSettings().updateMirror);
  componentJob = { ...componentJob, pct: 1, note: `连接下载源（${line.via}）` };

  const dl = await downloadToFile(line.url, zipPath, (ratio) => {
    // 下载占 0-70%，解压 70-95%
    componentJob = { ...componentJob, pct: Math.round(ratio * 70), note: '下载中' };
  });
  if (!dl.ok) {
    return { ok: false, error: `下载失败：${dl.error}${downloadHint(line.mode)}` };
  }
  return installFfmpegFromZip(zipPath);
}

/** 从一个已经下好的 zip 装 ffmpeg（和 NapCat 一样，下载和安装分开，好支持本地文件装）。 */
async function installFfmpegFromZip(zipPath) {
  componentJob = { ...componentJob, pct: 72, note: '解压中' };
  const unpack = path.join(os.tmpdir(), `ffmpeg-unpack-${Date.now()}`);
  fs.mkdirSync(unpack, { recursive: true });
  const code = await new Promise((resolve) => {
    const child = spawn(tarExe(), ['-xf', zipPath, '-C', unpack], { windowsHide: true });
    child.on('close', resolve);
    child.on('error', () => resolve(-1));
  });
  if (code !== 0) {
    fs.rmSync(zipPath, { force: true });
    return { ok: false, error: '解压失败（本机 tar 不可用？）' };
  }

  // 包结构是 ffmpeg-master-*/bin/ffmpeg.exe，层数不固定，直接往下找
  const found = (() => {
    const stack = [unpack];
    while (stack.length) {
      const dir = stack.pop();
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) stack.push(full);
        else if (e.name.toLowerCase() === 'ffmpeg.exe') return full;
      }
    }
    return '';
  })();
  if (!found) {
    fs.rmSync(unpack, { recursive: true, force: true });
    fs.rmSync(zipPath, { force: true });
    return { ok: false, error: '解压出来没找到 ffmpeg.exe' };
  }

  componentJob = { ...componentJob, pct: 92, note: '安装中' };
  const target = path.join(componentsDir(), 'ffmpeg');
  fs.mkdirSync(target, { recursive: true });
  for (const name of fs.readdirSync(path.dirname(found))) {
    // ffprobe / ffplay 一起搬：以后要探时长、试听都不用再下一遍
    if (/^ff(mpeg|probe|play)\.exe$/i.test(name)) {
      fs.copyFileSync(path.join(path.dirname(found), name), path.join(target, name));
    }
  }
  fs.rmSync(unpack, { recursive: true, force: true });
  fs.rmSync(zipPath, { force: true });

  const exe = path.join(target, 'ffmpeg.exe');
  const cfg = loadConfig();
  cfg.socialV2 = {
    ...(cfg.socialV2 ?? {}),
    voice: { ...(cfg.socialV2?.voice ?? {}), ffmpegPath: exe }
  };
  writeJson(configFile(), cfg);
  pushLog(`ffmpeg 装好了：${exe}`, 'sys', 'voice');
  return { ok: true, path: exe };
}

/** 起一个安装任务，立刻返回；进度靠 /api/components 轮询。 */
function startComponentInstall(id) {
  componentJob = { id, pct: 0, note: '准备中', done: false, error: null, startedAt: Date.now() };
  const run = id === 'napcat' ? installNapcat() : installFfmpeg();
  run
    .then((r) => {
      componentJob = {
        ...componentJob,
        pct: 100,
        note: r.ok ? '装好了' : '失败',
        done: true,
        error: r.ok ? null : (r.error ?? '失败')
      };
      if (!r.ok) pushLog(`装 ${id} 失败：${r.error ?? ''}`, 'err', 'sys');
    })
    .catch((error) => {
      componentJob = { ...componentJob, note: '失败', done: true, error: String(error?.message ?? error) };
    });
  return { ok: true, started: true, id };
}

/** 静默查一次 NapCat 更新并记账。不写日志 —— 周期复查每 30 分钟调一次，
    在这里打日志就是刷屏；「有新版本」的提示由 runNapcatUpdateCheck 去重后发。 */
async function checkNapcatUpdateOnce() {
  try {
    const info = await napcatUpdateInfo();
    const upToDate = Boolean(info.tag && info.current && info.current.includes(info.tag));
    const s = readJson(SETTINGS_FILE);
    s.napcat = {
      ...(s.napcat ?? {}),
      lastUpdateCheck: Date.now(),
      // 只在真有新版时记 tag；已是最新就清空，免得下次启动还拿着旧 tag 弹提醒
      lastUpdateFound: upToDate ? '' : info.tag
    };
    writeJson(SETTINGS_FILE, s);
    return { ok: true, ...info, updateAvailable: !upToDate };
  } catch (error) {
    // 周期检查失败不吭声：网络/代理问题一会儿就过去了，下一轮自然重试
    return { ok: false, error: String(error?.message ?? error) };
  }
}

async function runNapcatUpdateCheck() {
  const r = await checkNapcatUpdateOnce().catch(() => null);
  if (!r?.updateAvailable) return;
  const s = readJson(SETTINGS_FILE);
  // 日志去重走 lastUpdateLogged；lastReminded 只由「忽略这个版本」写 ——
  // 之前在这里写 lastReminded，前端「found ≠ reminded 才亮横幅」的判断
  // 就永远不成立，自动查到的新版一条提示都不出。
  if (s.napcat?.lastUpdateLogged === r.tag) return;
  s.napcat = { ...(s.napcat ?? {}), lastUpdateLogged: r.tag };
  writeJson(SETTINGS_FILE, s);
  pushLog(`NapCat 有新版本 ${r.tag}（当前 ${r.current || '未知'}）—— 去「总览」页更新`, 'sys', 'napcat');
}

/** 启动必查（10 分钟内查过就免了，防快速重启连环打 GitHub），之后每 30 分钟复查。
    0.5.6 之前是「20 小时内不查」—— 发行版发得晚，用户重启也等不到提示。 */
function scheduleNapcatUpdateCheck() {
  const n = napcatSettings();
  if (n.updateMode === 'off') return;
  if (Date.now() - n.lastUpdateCheck >= 10 * 60_000) setTimeout(() => runNapcatUpdateCheck(), 15_000);
  setInterval(() => {
    if (napcatSettings().updateMode === 'off') return;
    runNapcatUpdateCheck();
  }, 30 * 60_000);
}

/* ══════════════════════════════════════════════════════════════════════════
 * 软件本体自更新
 *
 * 只提醒不自动装 —— 换掉正在跑的程序必须经过人点头。
 * 流程：查 releases/latest → 比较 tag 与当前版本 → 下载 Setup.exe →
 * 静默安装（/S，沿用原安装目录）→ 软件退出，安装完自动拉起新版。
 * 开发模式没有安装器，明确报告不支持。
 * ══════════════════════════════════════════════════════════════════════════ */

function appSettings() {
  const s = readJson(SETTINGS_FILE);
  const a = s.app ?? {};
  return {
    updateMode: a.updateMode === 'off' ? 'off' : 'notify',
    updateRepo: String(a.updateRepo ?? 'Delance-cn/DualHabitat-Matrix'),
    // 三档：空=自动测速选最快（默认）、off=直连、URL=固定镜像 —— 见 pickDownloadLine
    updateMirror: String(a.updateMirror ?? '').replace(/\/$/, ''),
    lastUpdateCheck: Number(a.lastUpdateCheck) || 0
  };
}

function cmpVersion(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(Number);
  const pb = String(b).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

async function appUpdateInfo() {
  const s = appSettings();
  const res = await fetch(`https://api.github.com/repos/${s.updateRepo}/releases/latest`, {
    headers: { 'user-agent': 'DualHabitat-Matrix', accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(15_000)
  });
  if (!res.ok) throw new Error(`GitHub API HTTP ${res.status}`);
  const rel = await res.json();
  const assets = (rel.assets ?? []).map((a) => ({ name: String(a.name), size: Number(a.size) || 0, url: String(a.browser_download_url) }));
  let picked = null;
  try {
    const re = new RegExp('Setup.*\\.exe$', 'i');
    picked = assets.find((a) => re.test(a.name)) ?? null;
  } catch { /* 同上，匹配规则坏了就当没挑上 */ }
  return {
    repo: s.updateRepo,
    tag: String(rel.tag_name ?? ''),
    publishedAt: String(rel.published_at ?? ''),
    notes: String(rel.body ?? '').slice(0, 2000),
    current: APP_VERSION,
    assets,
    picked,
    updateAvailable: rel.tag_name ? cmpVersion(rel.tag_name, APP_VERSION) > 0 : false
  };
}

/* 本体安装包下载的实时进度 —— /api/app/update/progress 轮询的就是它。
   下载动辄几百 MB、几分钟，前端必须能看到走到哪了。 */
let appUpdateJob = null;

async function applyAppUpdate(assetUrl) {
  if (!electronApp) return { ok: false, error: '开发模式不支持自更新（没有安装器），请手动下载新安装包' };
  const info = await appUpdateInfo();
  const asset = assetUrl ? (info.assets.find((a) => a.url === assetUrl) ?? null) : info.picked;
  if (!asset) return { ok: false, error: '发行版里没有找到 Setup 安装包（资产名要含 Setup 并以 .exe 结尾）' };
  // 线路三档：空=自动测速选最快（默认）、off=直连、URL=固定镜像
  const line = await pickDownloadLine(asset.url, appSettings().updateMirror);
  const tmp = path.join(os.tmpdir(), `dhm-update-${Date.now()}`);
  fs.mkdirSync(tmp, { recursive: true });
  const exePath = path.join(tmp, asset.name);
  pushLog(`下载新版本安装包：${asset.name}（${(asset.size / 1048576).toFixed(1)} MB，线路 ${line.via}）`, 'sys', 'app');
  appUpdateJob = { phase: 'download', pct: 0, got: 0, total: asset.size, note: `测速选线：${line.via}`, startedAt: Date.now(), error: '' };
  const dl = await downloadToFile(line.url, exePath, (ratio, got, total) => {
    if (appUpdateJob) {
      appUpdateJob.pct = Math.round(ratio * 100);
      appUpdateJob.got = got;
      appUpdateJob.total = total;
      appUpdateJob.note = `下载中 ${Math.round(ratio * 100)}%`;
    }
  });
  if (!dl.ok) {
    if (appUpdateJob) {
      appUpdateJob.phase = 'error';
      appUpdateJob.error = dl.error;
      appUpdateJob.note = '下载失败';
    }
    return { ok: false, error: `下载失败：${dl.error}${downloadHint(line.mode)}` };
  }
  if (appUpdateJob) {
    appUpdateJob.phase = 'install';
    appUpdateJob.pct = 100;
    appUpdateJob.note = '下载完成，正在启动安装程序…';
  }
  const child = spawn(exePath, ['/S'], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  pushLog('安装程序已启动，本软件即将退出并在安装完成后自动重开', 'sys', 'app');
  setTimeout(() => {
    try { electronApp.quit(); } catch { /* 退出失败也无能为力了 */ }
  }, 1500);
  return { ok: true, tag: info.tag, note: '安装程序已在后台运行' };
}

async function checkAppUpdateOnce() {
  try {
    const info = await appUpdateInfo();
    const s = readJson(SETTINGS_FILE);
    s.app = { ...(s.app ?? {}), lastUpdateCheck: Date.now(), lastUpdateFound: info.updateAvailable ? info.tag : '', lastUpdateError: '' };
    writeJson(SETTINGS_FILE, s);
    return { ok: true, ...info };
  } catch (error) {
    pushLog(`软件更新检查失败：${error?.message ?? error}`, 'err', 'app');
    // 失败不再静默：记进设置，总览横幅位显示「检查没连上」（网络/代理原因），下次开软件能看见
    try {
      const s = readJson(SETTINGS_FILE);
      s.app = { ...(s.app ?? {}), lastUpdateError: String(error?.message ?? error).slice(0, 200) };
      writeJson(SETTINGS_FILE, s);
    } catch { /* 写不进就算了 */ }
    return { ok: false, error: String(error?.message ?? error) };
  }
}

async function runAppUpdateCheck() {
  try {
    const info = await appUpdateInfo();
    const st = readJson(SETTINGS_FILE);
    const app = { ...(st.app ?? {}) };
    // 日志只对同一个 tag 提一次，别因为周期复查刷屏。横幅/角标的显隐走
    // 「lastUpdateFound ≠ lastReminded」，lastReminded 只由「忽略这个版本」
    // 写（/api/app/update/dismiss）—— 之前在这里顺手写 lastReminded，等于一查到
    // 就替用户点了忽略，横幅永远出不来。
    if (info.updateAvailable && app.lastUpdateLogged !== info.tag) {
      app.lastUpdateLogged = info.tag;
      pushLog(`有新版本 ${info.tag}（当前 ${APP_VERSION}），去「总览」页升级`, 'sys', 'app');
    }
    app.lastUpdateCheck = Date.now();
    app.lastUpdateFound = info.updateAvailable ? info.tag : '';
    app.lastUpdateError = '';
    st.app = app;
    writeJson(SETTINGS_FILE, st);
  } catch (error) {
    // 同上：失败也留痕，别让人以为「没提示 = 没更新」
    try {
      const st = readJson(SETTINGS_FILE);
      st.app = { ...(st.app ?? {}), lastUpdateError: String(error?.message ?? error).slice(0, 200) };
      writeJson(SETTINGS_FILE, st);
    } catch { /* 写不进就算了 */ }
  }
}

/** 启动必查（10 分钟内成功查过就免了，防快速重启连环打 GitHub；失败的
    check 不写 lastUpdateCheck，所以网络一通重开软件就会重查），之后每
    30 分钟复查一次 —— 软件开着不动也能等到新版本。 */
function scheduleAppUpdateCheck() {
  const s = appSettings();
  if (s.updateMode === 'off') return;
  if (Date.now() - s.lastUpdateCheck >= 10 * 60_000) setTimeout(runAppUpdateCheck, 20_000);
  setInterval(() => {
    if (appSettings().updateMode === 'off') return;
    runAppUpdateCheck();
  }, 30 * 60_000);
}


/**
 * Webhook 测试体的渲染 —— 与 wechat-bot.js 的 renderHookBody 保持同一套映射
 * （两个进程各自持有一份，改一边要改另一边；文件头注释里互相点名）。
 */
function renderHookSample(format, template) {
  const base = { event: 'message.received', at: new Date().toISOString(), bot: 'test@im.bot', from: 'wxid_demo', text: '测试消息： hook 通了', kinds: '文字' };
  if (format === 'onebot') {
    const unix = Math.floor(Date.now() / 1000);
    return JSON.stringify({ time: unix, self_id: base.bot, post_type: 'message', message_type: 'private', sub_type: 'friend', user_id: base.from, message: [{ type: 'text', data: { text: base.text } }], raw_message: base.text, font: 0, sender: { user_id: base.from, nickname: base.from, sex: 'unknown' } });
  }
  if (format === 'template') {
    const vals = {
      event: base.event, at: base.at, bot: base.bot, from: base.from, to: base.to ?? '',
      text: JSON.stringify(base.text), kinds: JSON.stringify(base.kinds), message: JSON.stringify(base.text), json: JSON.stringify(base)
    };
    return String(template || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (k in vals ? String(vals[k]) : m));
  }
  return JSON.stringify(base);
}


/**
 * 一键启动：NapCat（没在跑才起）→ 等 WS 就绪 → 起桥接。
 * 这就是桌面那个 bat 干的事，区别是不硬等 30 秒、失败能说清楚卡在哪一步。
 */
async function bringUp(scope = 'all') {
  // scope: qq = 只开 QQ 这条线；wechat = 只开微信；all = 都开
  const wantQq = scope !== 'wechat';
  const wantWx = scope !== 'qq';

  /* 三条线各自起，谁也不等谁 —— 这是「QQ 和微信同时跑」的前提。
   *
   * 以前的写法是 NapCat 起不来就直接 return，桥接根本不启动。那对纯 QQ 是合理的
   * （没有 NapCat 的桥接什么都干不了），但微信那条线要靠桥接里的模型 API，
   * 于是 QQ 这边扫码过期一次，微信也跟着哑掉 —— 两个平台互相拖累。
   * 现在改成尽力而为：NapCat 失败只记一笔，桥接和微信照常拉起。 */
  let napcatError = null;

  if (wantQq) {
    const accounts = napcatAccounts().filter((a) => a.enabled !== false);
    if (!accounts.length) napcatError = '没有启用的 QQ 账号（先在「QQ 多号」里添加）';
    for (const acc of accounts) {
      if (!acc.dir) {
        napcatError ??= `[${acc.id}] 还没配 NapCat 目录`;
        continue;
      }
      if (await probePort(acc.wsPort)) {
        pushLog(`[${acc.id}] NapCat 已在运行（${acc.wsPort} 端口通），跳过启动`, 'sys', 'napcat');
        ensureNapcatFileLog(acc.dir);
        startNapcatTail(acc.id);
        continue;
      }
      const started = startNapcat(acc.id);
      if (!started.ok) {
        napcatError ??= `[${acc.id}] ${started.error ?? 'NapCat 启动失败'}`;
        continue;
      }
      pushLog(`[${acc.id}] 等待 NapCat WebSocket（${acc.wsPort}）…`, 'sys', 'napcat');
      const ready = await waitForPort(acc.wsPort, acc.waitMs);
      if (!ready) {
        // 窗口藏起来了，所以"去它的窗口看看"已经不成立 —— 指到面板上，
        // 扫码和登录状态都在那儿。
        const panel = napcatPanel(acc.id);
        napcatError ??=
          `[${acc.id}] NapCat 在 ${Math.round(acc.waitMs / 1000)} 秒内没有打开 ${acc.wsPort} 端口。` +
          (panel.ok
            ? `多数是要扫码登录：打开 ${panel.url} 看一眼。`
            : '去「运行」页确认 NapCat 目录，或看日志页的 NapCat 输出。');
      } else {
        pushLog(`[${acc.id}] NapCat 就绪`, 'sys', 'napcat');
      }
    }
  }

  // 拉起任何一条线之前，先把 0.5.5 留下的「本地厂商没模型 / 模型池裸模型名」修好。
  // 这一步是幂等的；本机没有模型服务时什么也不写。
  try {
    await repairModelConfiguration();
  } catch (error) {
    pushLog(`模型配置自动修复失败（继续启动）：${error?.message ?? error}`, 'err', 'models');
  }

  // 0.5.5 起微信有自己的 4601 实例，不再借 QQ 桥接的 4599；只开微信时不拉桥接。
  const bridgeResult = wantQq
    ? bridge.child
      ? { ok: true, skipped: true }
      : startBridge()
    : { ok: true, skipped: true };
  // 微信那条不依赖 NapCat，也不依赖桥接；自己的模型实例由 wechat-bot 幂等拉起。
  // 多账号：wx1（默认号）照旧；其他号只在「已登录过」（有 token）时顺手拉起，
  // 没登录的不自动起 —— 免得一键全开炸出九张二维码。
  let wechatResult = { ok: true, skipped: true };
  if (wantWx && !wechat.child) wechatResult = startWechat();
  else if (wantWx && wechat.child) wechatResult = { ok: true, skipped: true };
  if (wantWx) {
    for (const acc of wechatAccountsList()) {
      if (acc === 'wx1') continue;
      const hasToken = fs.existsSync(wechatFiles(acc).token);
      if (hasToken && !wechatProcs.get(acc)?.child && !externalWechatPid(acc)) startWechat(acc);
    }
  }

  return {
    ok: Boolean(bridgeResult.ok) || bridgeResult.error === '桥接已在运行',
    napcatError,
    bridge: bridgeResult,
    wechat: wechatResult,
    error: napcatError ?? bridgeResult.error
  };
}

/**
 * 一键把「当前通道的机器人」整条链拉起来（/api/bots/start）。
 *
 * 和 bringUp 的区别：bringUp 面向「把服务开起来」，这里面向引导面板——
 * 每一步给人话结果（✓/✗ + 原因），先查密钥再动进程，失败不猜。
 * QQ：查密钥 → NapCat（没起就起并等端口，复用 bringUp 的等待逻辑）→ 桥接。
 * 微信：查密钥 → 微信接入（没登录它会自己出二维码到 state/wechat-qr.json）。
 */
async function startBotFlow(platform = 'qq') {
  const steps = [];
  const mark = (name, ok, detail = '') => { steps.push({ name, ok, detail }); return ok; };
  const hasKey = secretPresence().some((s) => s.set);

  if (platform === 'wechat') {
    mark('模型密钥', hasKey, hasKey ? '已配置' : '还没填 —— 在引导第 2 步粘一下就行');
    const w0 = wechatState();
    if (w0.running) {
      mark('微信接入', true, '已在运行');
    } else {
      const r = startWechat();
      if (!mark('微信接入', r.ok === true, r.ok ? '已启动' : (r.error ?? '启动失败'))) {
        return { ok: false, platform, steps };
      }
      // 给它两秒把二维码写进 state/wechat-qr.json，前端马上就有图可扫
      await new Promise((r2) => setTimeout(r2, 2000));
    }
    const w = wechatState();
    mark(
      '登录',
      true,
      w.loggedIn
        ? `已登录${w.botId ? `（${w.botId}）` : ''}`
        : w.qr
          ? '二维码已出，用手机微信扫'
          : '还没出二维码 —— 等几秒再刷一次，或到日志页看微信输出'
    );
    return {
      ok: true,
      platform,
      steps,
      wechat: { running: w.running, loggedIn: w.loggedIn, qr: w.qr }
    };
  }

  mark('模型密钥', hasKey, hasKey ? '已配置' : '还没填 —— 在引导第 2 步粘一下就行');
  const n = napcatSettings();
  if (!n.dir) {
    mark('NapCat', false, '还没装 NapCat —— 回总览页点横幅「下载并装好」，或到「高级」页手动配目录');
    return { ok: false, platform, steps };
  }
  const up = await bringUp('qq');
  mark('NapCat', !up.napcatError, up.napcatError ?? 'OneBot 端口已通');
  const bridgeOk = Boolean(up.bridge?.ok) || up.bridge?.error === '桥接已在运行';
  mark('QQ 桥接', bridgeOk, up.bridge?.error ?? (up.bridge?.external ? '复用已在运行的桥接' : '已启动'));
  return { ok: !up.napcatError && bridgeOk, platform, steps };
}

function bringDown(scope = 'all') {
  const wantQq = scope !== 'wechat';
  const wantWx = scope !== 'qq';
  // 停 QQ 就只停 QQ 这条线；微信留着，别让它当孤儿，也别互相牵连
  const bridgeResult = wantQq ? stopBridge() : { ok: true, skipped: true };
  const napcatResult = wantQq ? stopAllNapcat() : { ok: true, skipped: true };
  const wechatResult = wantWx
    ? wechat.child
      ? stopWechat()
      : { ok: true, skipped: true }
    : { ok: true, skipped: true };
  return { ok: true, bridge: bridgeResult, napcat: napcatResult, wechat: wechatResult };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 三、桥接进程管理
 * ══════════════════════════════════════════════════════════════════════════ */

let bridge = { child: null, startedAt: null, exitCode: null };

// 正在退出：所有「意外退出自动拉起」的看护都必须闭嘴，别在关软件时又把服务拉回来。
let shuttingDown = false;

/**
 * 日志环形缓冲，新连上的前端能立刻看到最近内容。
 *
 * `source` 标记这条是**哪个进程**吐的。桌面上其实有三条流（桌面服务自己、桥接、
 * NapCat），全都汇进同一个「日志」页，前端靠它分色 + 过滤：
 *   app    桌面服务自己的话（启动/停止/报错）
 *   bridge 桥接进程的 stdout / stderr
 *   napcat NapCat 启动器的 stdout / stderr（以前是个黑窗口，现在收进来了）
 */
const LOG_MAX = 500;
const logs = [];
const logClients = new Set();

function pushLog(line, level = 'out', source = 'app') {
  const entry = { t: Date.now(), level, source, line: String(line) };
  logs.push(entry);
  if (logs.length > LOG_MAX) logs.shift();
  for (const res of logClients) {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  }
}

/**
 * 把子进程的输出一行行灌进日志页。
 *
 * 必须自己攒缓冲：`data` 事件的 chunk 边界**不等于**行边界，一条日志很可能被切成
 * 两半，也可能一次来好几行。不攒缓冲的话日志会断成一截一截的。
 *
 * NapCat 的日志带 ANSI 颜色码（`\x1b[32minfo\x1b[39m`），在网页里会变成
 * 一坨乱码，所以在入队前剥掉。
 */
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

function relay(stream, level, source) {
  const emit = (text) => pushLog(text.replace(ANSI, ''), level, source);
  let buffer = '';
  stream.on('data', (chunk) => {
    buffer += chunk.toString();
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      emit(buffer.slice(0, idx).replace(/\r$/, ''));
      buffer = buffer.slice(idx + 1);
    }
  });
  // 进程退出时最后一行常常不带换行，别把它一起吞了
  stream.on('end', () => {
    if (buffer.trim()) emit(buffer.trim());
  });
}

/**
 * 找到能跑 Node 脚本的解释器。
 * Electron 里 `process.execPath` 是 electron.exe，直接跑脚本会开个新窗口 ——
 * 必须带 ELECTRON_RUN_AS_NODE=1，或者退回系统 node。
 */
function nodeRunner(platform = 'qq') {
  const isElectron = Boolean(process.versions.electron);
  const env = isElectron ? { ELECTRON_RUN_AS_NODE: '1' } : {};
  env.QQ_BRIDGE_MODEL_PLATFORM = platform === 'wechat' ? 'wechat' : 'qq';
  env.QQ_BRIDGE_STATE_DIR = matrixStateDir(platform);
  if (platform === 'wechat') env.QQ_BRIDGE_WECHAT_STATE_DIR = matrixStateDir('wechat');
  // 真实模型池在 models.local.json（公开仓只带空模板，个人池不进 git）。
  // 桥接、微信 bot、oc-config 重生成配置都从 QQ_BRIDGE_MODELS 拿池子——
  // 不注入的话，本机就一直在按空池跑，regen 还会报「模型池是空的」。
  const localPool = path.join(dataRoot(), 'models.local.json');
  if (fs.existsSync(localPool)) env.QQ_BRIDGE_MODELS = localPool;
  // 数据根：桥接侧（bridge.js / wechat-bot.js / oc-config）靠它把 config/state/audio
  // 落到数据根，绝不写进会被升级清掉的安装目录。
  env.QQ_BRIDGE_DATA = dataRoot();
  return { command: process.execPath, env };
}

/**
 * 读桥接的单实例锁，判断「是不是已经有一个不是本窗口启动的桥接在跑」。
 *
 * 为什么需要：桥接自己用 `state/bridge.lock` 做单实例保护。如果它是手动
 * `node src/bridge.js` 起的（或上一份桌面进程留下的），本窗口再 spawn 一个，
 * 新进程会被锁挡回去、以 code 2 退出 —— 界面上只会显示「桥接已退出（code 2）」，
 * 看起来像启动失败，其实服务是好的。这里提前识别并复用。
 *
 * 拿不准时一律返回 null（按「没有」处理）：宁可多 spawn 一次被锁挡回，
 * 也不要因为锁文件残留就误判成「已在运行」而不启动。
 */
function externalBridgePid() {
  return pidFromLockFile(path.join('state', 'bridge.lock'));
}

/**
 * 同理，读微信接入的单实例锁（`state/wechat.lock`，由 wechat-bot.js 写）。
 * 文件名是和 wechat-bot.js 约定死的，改一边就要改另一边。
 */
/** 读微信接入的单实例锁（state/wechat[-<account>].lock，由 wechat-bot.js 写）。 */
function externalWechatPid(account = 'wx1') {
  const suf = account === 'wx1' ? '' : `-${account}`;
  return pidFromLockFile(path.join('state', `wechat${suf}.lock`));
}

/** 官方 QQ 机器人的单实例锁（state/qq-official-<appId>.lock，由 qq-official-bot.js 写）。 */
function externalQqOfficialPid(appId) {
  return pidFromLockFile(path.join('state', `qq-official-${appId}.lock`));
}

/**
 * 读一个「存着 PID 的锁文件」，只认「PID 解析得出来、而且那个进程还活着」。
 * 拿不准（文件不在 / 内容坏 / 权限不足）一律返回 null —— 宁可多 spawn 一次被锁挡回，
 * 也不要因为残留文件就误判成「已在运行」而不启动。
 */
function pidFromLockFile(relativePath) {
  try {
    const lock = path.join(dataRoot(), relativePath);
    if (!fs.existsSync(lock)) return null;
    const pid = Number(fs.readFileSync(lock, 'utf8').trim());
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return null;
    process.kill(pid, 0); // PID 不存在会抛 ESRCH
    return pid;
  } catch {
    return null;
  }
}

function startBridge() {
  if (bridge.child) return { ok: false, error: '桥接已在运行' };
  const externalPid = externalBridgePid();
  if (externalPid) {
    pushLog(`桥接已在运行（pid ${externalPid}，不是本窗口启动的），直接复用`, 'sys', 'bridge');
    return { ok: true, pid: externalPid, external: true };
  }

  const seeded = seedBridgeData();
  if (seeded) pushLog(`桥接配置不存在，已从 ${seeded.from} 生成 config.json`, 'sys', 'bridge');
  if (!fs.existsSync(path.join(dataRoot(), 'config.json'))) {
    return { ok: false, error: `数据根里没有 config.json，也没有可用的模板：${dataRoot()}` };
  }

  const { command, env } = nodeRunner('qq');
  const child = spawn(command, [path.join(getRoot(), 'src', 'bridge.js')], {
    cwd: dataRoot(),
    env: { ...process.env, ...env },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  bridge = { child, startedAt: Date.now(), exitCode: null };
  pushLog(`桥接已启动（pid ${child.pid}）`, 'sys', 'bridge');

  relay(child.stdout, 'out', 'bridge');
  relay(child.stderr, 'err', 'bridge');

  child.on('close', (code) => {
    bridge = { child: null, startedAt: null, exitCode: code };
    onServiceExit('bridge');
    if (!recentlyStopped('bridge')) void stopManagedModelService('qq');
    pushLog(`桥接已退出（code ${code}）`, code === 0 ? 'sys' : 'err', 'bridge');
  });

  return { ok: true, pid: child.pid };
}

function stopBridge() {
  markManualStop('bridge');
  const child = bridge.child;
  if (!child) {
    // 外部启动的桥接：界面上是「运行中」，停止按钮就得真的能停，否则用户会以为按钮坏了。
    const externalPid = externalBridgePid();
    if (!externalPid) return { ok: false, error: '桥接没在运行' };
    pushLog(`正在停止外部启动的桥接（pid ${externalPid}）…`, 'sys', 'bridge');
    return withDone({ ok: true, pid: externalPid }, killProcessTree(externalPid));
  }
  pushLog('正在停止桥接…', 'sys', 'bridge');
  const done = (async () => {
    let onClose;
    const closed = new Promise((resolve) => {
      onClose = resolve;
      child.once('close', onClose);
    });
    const killed = await killProcessTree(child.pid);
    if (!killed && bridge.child === child && child.exitCode === null) {
      child.off('close', onClose);
      throw new Error('无法停止桥接进程');
    }
    let timeout;
    try {
      await Promise.race([
        closed,
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error('等待桥接退出超时')), 15_000);
        })
      ]);
    } finally {
      clearTimeout(timeout);
      child.off('close', onClose);
    }
    await stopManagedModelService('qq');
    return { stopped: true };
  })();
  return withDone({ ok: true, pid: child.pid }, done);
}

async function restartBridge() {
  const stopped = stopBridge();
  if (!stopped.ok) return stopped;
  if (stopped.done) await stopped.done;
  try {
    await repairModelConfiguration();
  } catch (error) {
    pushLog(`模型配置自动修复失败（继续重启）：${error?.message ?? error}`, 'err', 'models');
  }
  return startBridge();
}

function bridgeState() {
  return {
    running: Boolean(bridge.child),
    pid: bridge.child?.pid ?? null,
    startedAt: bridge.startedAt,
    exitCode: bridge.exitCode,
    // 桥接由本窗口之外启动（手动运行 / 上一份桌面进程留下的）时为它的 PID。
    // 界面据此显示「运行中」，但「停止」按钮不会去杀一个不属于本窗口的进程。
    externalPid: bridge.child ? null : externalBridgePid()
  };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 微信接入（官方 iLink / ClawBot 协议）
 *
 * 单独一个进程（src/wechat-bot.js），不走 NapCat、也不进 bridge.js：
 * 那边会话 key 必须是 `private:<数字>`、发消息全靠 NapCat 的 bot 对象，
 * 硬塞会动到已经跑通的 QQ 链路。这里只负责把它拉起来、收日志、报状态。
 *
 * 二维码不由这里生成：bot 扫码时会把图写进 state/wechat-qr.json，这里读出来给前端。
 * 好处是软件重启后二维码还在，不用重新点一次。
 * ══════════════════════════════════════════════════════════════════════════ */

let wechat = { child: null, startedAt: null, exitCode: null };
/* 微信多账号：账号 id（wx1..wx10）→ 子进程。`wechat` 变量保留为 wx1（默认号）
   的视图 —— 旧代码（看护/一键启动/状态）全指着它，别删。 */
const wechatProcs = new Map();
/* 官方机器人多号：AppID → 子进程。每个号一个独立 qq-official-bot.js 进程（--app 区分）。 */
const qqOfficialBots = new Map();

/** 微信账号清单：config.json platforms.wechat.accounts（上限 10；缺省 = 只有 wx1）。 */
function wechatAccountsList(cfg = loadConfig()) {
  const raw = cfg.platforms?.wechat?.accounts;
  const ids = (Array.isArray(raw) ? raw : [])
    .map((x) => (typeof x === 'string' ? x.trim() : String(x?.id ?? '').trim()))
    .filter((x) => /^wx([1-9]|10)$/.test(x));
  return [...new Set(ids)].slice(0, 10).length ? [...new Set(ids)].slice(0, 10) : ['wx1'];
}

function wechatFiles(account = 'wx1') {
  const base = path.join(dataRoot(), 'state');
  // wx1 沿用无后缀的老文件名（老登录态直接续用）；wx2 起带后缀
  const suf = account === 'wx1' ? '' : `-${account}`;
  return {
    qr: path.join(base, `wechat${suf}-qr.json`),
    token: path.join(base, `wechat${suf}-token.json`)
  };
}

function wechatAccountState(account) {
  const rec = wechatProcs.get(account);
  const f = wechatFiles(account);
  const qr = readJson(f.qr) ?? {};
  const token = readJson(f.token) ?? {};
  // 「运行中」不能只看自己的 child：可能是从别的终端起的，锁文件里有活 pid 也算。
  const externalPid = rec?.child ? null : externalWechatPid(account);
  const runningPid = rec?.child?.pid ?? externalPid ?? null;
  // 只在「进程在跑 + 码还新鲜」时把图给前端：尸体码扫了只会得到过期提示。
  const fresh = qr.dataUrl && Date.now() - Number(qr.at ?? 0) < 4 * 60 * 1000;
  const live = Boolean(runningPid) && fresh && (qr.status === 'waiting' || qr.status === 'scanned');
  return {
    id: account,
    running: Boolean(runningPid),
    pid: runningPid,
    startedAt: rec?.startedAt ?? null,
    loggedIn: Boolean(token.bot_token),
    botId: token.bot_id ?? null,
    qrStatus: qr.status ?? null,
    qr: live ? qr.dataUrl : null,
    qrUrl: live ? qr.qrUrl ?? null : null
  };
}

function wechatState() {
  // 顶层字段仍是 wx1（默认号）的视图：旧 UI（状态页/首页卡/向导）全都读它。
  const primary = wechatAccountState('wx1');
  const accounts = wechatAccountsList().map(wechatAccountState);
  return {
    ...primary,
    externalPid: primary.pid && !wechatProcs.get('wx1')?.child ? primary.pid : null,
    loginTime: readJson(wechatFiles('wx1').token)?.login_time ?? null,
    accounts
  };
}

function startWechat(account = 'wx1') {
  const acc = /^wx([1-9]|10)$/.test(String(account)) ? String(account) : 'wx1';
  const rec = wechatProcs.get(acc);
  if (rec?.child) return { ok: false, error: `微信账号 ${acc} 已在运行` };
  // 每个账号自己的单实例锁。同一账号只允许一个进程长轮询，再 spawn 一个只会
  // 立刻 exit(2) —— 界面上看着像"启动失败"，其实服务是好的。
  const externalPid = externalWechatPid(acc);
  if (externalPid) {
    pushLog(`微信账号 ${acc} 已在运行（pid ${externalPid}，不是本窗口启动的），直接复用`, 'sys', 'wechat');
    return { ok: true, pid: externalPid, external: true };
  }
  if (!wechatAccountsList().includes(acc)) return { ok: false, error: `微信账号 ${acc} 没在配置里（先在登录页添加）` };
  const { command, env } = nodeRunner('wechat');
  const script = path.join(getRoot(), 'src', 'wechat-bot.js');
  if (!fs.existsSync(script)) return { ok: false, error: '找不到 src/wechat-bot.js（桥接目录对吗）' };

  const child = spawn(command, [script, '--account', acc], {
    cwd: dataRoot(),
    env: { ...process.env, ...env },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  wechatProcs.set(acc, { child, startedAt: Date.now(), exitCode: null });
  if (acc === 'wx1') wechat = { child, startedAt: Date.now(), exitCode: null };
  pushLog(`微信账号 ${acc} 已启动（pid ${child.pid}）`, 'sys', 'wechat');
  relay(child.stdout, 'out', 'wechat');
  relay(child.stderr, 'err', 'wechat');

  child.on('close', (code) => {
    const prev = wechatProcs.get(acc);
    if (prev?.child === child) wechatProcs.set(acc, { child: null, startedAt: null, exitCode: code });
    if (acc === 'wx1' && wechat.child === child) wechat = { child: null, startedAt: null, exitCode: code };
    pushLog(`微信账号 ${acc} 已退出（code ${code}）`, code === 0 ? 'sys' : 'err', 'wechat');
    // 看护按账号走：手动停的不拉起，其余看总开关
    if (!shuttingDown && !recentlyStopped(`wechat:${acc}`) && loadAutomation().watch.wechat) {
      const attempts = (wechatProcs.get(acc).restarts = (wechatProcs.get(acc).restarts ?? 0) + 1);
      if (attempts <= RESTART_MAX) {
        pushLog(`看护：微信账号 ${acc} 意外退出，${RESTART_DELAY_MS / 1000} 秒后自动重启（第 ${attempts}/${RESTART_MAX} 次）`, 'sys', 'app');
        setTimeout(() => {
          if (shuttingDown) return;
          wechatProcs.get(acc).restarts = 0;
          startWechat(acc);
        }, RESTART_DELAY_MS);
      } else {
        pushLog(`微信账号 ${acc} 连续 ${RESTART_MAX} 次自动重启失败，看护放弃`, 'err', 'app');
      }
    }
  });

  return { ok: true, pid: child.pid, account: acc };
}

function stopWechat(account = 'wx1') {
  const acc = /^wx([1-9]|10)$/.test(String(account)) ? String(account) : 'wx1';
  markManualStop(`wechat:${acc}`);
  // 先看自己拉起来的；没有就试着停「外部启动的」那个（锁文件里记着 pid）。
  // 不这么写的话，界面显示「运行中」但点停止永远提示"没在运行"，只能去任务管理器杀。
  const child = wechatProcs.get(acc)?.child;
  const pid = child?.pid ?? externalWechatPid(acc);
  if (!pid) return { ok: false, error: `微信账号 ${acc} 没在运行` };
  pushLog(`正在停止微信账号 ${acc}…`, 'sys', 'wechat');
  const done = (async () => {
    const killed = await killProcessTree(pid);
    // 4601 模型实例是所有微信账号共用的：还有别的账号在跑就不能停。
    const stillRunning = wechatAccountsList().some((a) => a === acc ? false : (wechatProcs.get(a)?.child || externalWechatPid(a)));
    if (!stillRunning) await stopManagedModelService('wechat');
    return { stopped: true, killed };
  })();
  return withDone({ ok: true, pid }, done);
}

/* ── QQ 官方机器人（开放平台，不封号那条线）· 多号 ──── */

/** 配置里的官方机器人清单（bots 数组 + 旧单号字段兜底，和 bot 进程同一套规则）。 */
function qqOfficialBotList(cfg = loadConfig()) {
  const o = cfg.qqOfficial ?? {};
  const bots = Array.isArray(o.bots)
    ? o.bots.map((b, i) => ({
        appId: String(b?.appId ?? '').trim(),
        appSecret: String(b?.appSecret ?? '').trim(),
        enabled: b?.enabled !== false,
        name: String(b?.name ?? '').trim() || `机器人 ${i + 1}`
      })).filter((b) => b.appId)
    : [];
  if (!bots.length && String(o.appId ?? '').trim()) {
    bots.push({ appId: String(o.appId).trim(), appSecret: String(o.appSecret ?? '').trim(), enabled: o.enabled === true, name: '机器人 1' });
  }
  return bots;
}

function startQqOfficial(appId) {
  const id = String(appId ?? '').trim();
  if (!id) return { ok: false, error: '缺少 AppID' };
  if (qqOfficialBots.get(id)?.child) return { ok: false, error: '这个号已在运行' };
  const externalPid = externalQqOfficialPid(id);
  if (externalPid) {
    pushLog(`官方机器人 ${id.slice(0, 4)}… 已在运行（pid ${externalPid}，不是本窗口启动的），直接复用`, 'sys', 'qqofficial');
    return { ok: true, pid: externalPid, external: true };
  }
  const bot = qqOfficialBotList().find((b) => b.appId === id);
  if (!bot) return { ok: false, error: '配置里没有这个 AppID' };
  if (!bot.enabled) return { ok: false, error: '这个号在配置里是停用状态，先在面板里启用' };
  if (!bot.appSecret) return { ok: false, error: '这个号没填 AppSecret' };
  const { command, env } = nodeRunner('qq');
  const script = path.join(getRoot(), 'src', 'qq-official-bot.js');
  if (!fs.existsSync(script)) return { ok: false, error: '找不到 src/qq-official-bot.js（桥接目录对吗）' };

  // 脚本必须在 argv[1]：bot 进程的入口守卫靠它判断自己是主程序，放后面会静默退出
  const child = spawn(command, [script, '--app', id], {
    cwd: dataRoot(),
    env: { ...process.env, ...env },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  qqOfficialBots.set(id, { child, startedAt: Date.now(), exitCode: null });
  pushLog(`官方机器人「${bot.name} ${id.slice(0, 4)}…」已启动（pid ${child.pid}）`, 'sys', 'qqofficial');
  relay(child.stdout, 'out', 'qqofficial');
  relay(child.stderr, 'err', 'qqofficial');

  child.on('close', (code) => {
    const rec = qqOfficialBots.get(id);
    if (rec?.child === child) qqOfficialBots.set(id, { child: null, startedAt: null, exitCode: code });
    pushLog(`官方机器人「${bot.name}」已退出（code ${code}）`, code === 0 ? 'sys' : 'err', 'qqofficial');
    // 看护按号走：手动停的（markManualStop 记过）不拉起，其余看总开关
    if (!shuttingDown && !recentlyStopped(`qqofficial:${id}`) && loadAutomation().watch.qqofficial) {
      const attempts = (qqOfficialBots.get(id).restarts = (qqOfficialBots.get(id).restarts ?? 0) + 1);
      if (attempts <= RESTART_MAX) {
        pushLog(`看护：官方机器人「${bot.name}」意外退出，${RESTART_DELAY_MS / 1000} 秒后自动重启（第 ${attempts}/${RESTART_MAX} 次）`, 'sys', 'app');
        setTimeout(() => {
          if (shuttingDown) return;
          qqOfficialBots.get(id).restarts = 0;
          startQqOfficial(id);
        }, RESTART_DELAY_MS);
      } else {
        pushLog(`官方机器人「${bot.name}」连续 ${RESTART_MAX} 次自动重启失败，看护放弃`, 'err', 'app');
      }
    }
  });

  return { ok: true, pid: child.pid };
}

function stopQqOfficial(appId) {
  const id = String(appId ?? '').trim();
  if (!id) return { ok: false, error: '缺少 AppID' };
  markManualStop(`qqofficial:${id}`);
  const child = qqOfficialBots.get(id)?.child;
  const pid = child?.pid ?? externalQqOfficialPid(id);
  if (!pid) return { ok: false, error: '这个号没在运行' };
  pushLog(`正在停止官方机器人 ${id.slice(0, 4)}…`, 'sys', 'qqofficial');
  // 不停 4599 模型实例：QQ 桥接（NapCat 那条）还在用它。
  const done = (async () => ({ stopped: true, killed: await killProcessTree(pid) }))();
  return withDone({ ok: true, pid }, done);
}

/** 面板/状态页的数据：每个号一份（进程在不在 + Bot 写在 state 里的运行况）。 */
function qqOfficialState() {
  const bots = qqOfficialBotList().map((bot) => {
    const rec = qqOfficialBots.get(bot.appId);
    const st = readJson(path.join(dataRoot(), 'state', `qq-official-${bot.appId}-status.json`), null) ?? {};
    const externalPid = rec?.child ? null : externalQqOfficialPid(bot.appId);
    const runningPid = rec?.child?.pid ?? externalPid ?? null;
    const statusAt = Number(st.at ?? 0);
    return {
      appId: bot.appId,
      name: bot.name,
      enabled: bot.enabled,
      appSecretSet: Boolean(bot.appSecret),
      running: Boolean(runningPid),
      pid: runningPid,
      startedAt: rec?.startedAt ?? null,
      // 进程在但状态文件 2 分钟没心跳 = 网关那边多半出事了
      connected: Boolean(runningPid) && st.connected === true && Date.now() - statusAt < 2 * 60_000,
      botName: st.botName ?? '',
      lastEventAt: Number(st.lastEventAt ?? 0),
      received: Number(st.received ?? 0),
      replied: Number(st.replied ?? 0),
      errors: Number(st.errors ?? 0),
      lastError: st.lastError ?? ''
    };
  });
  return { bots };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 主动发送（不等来消息，直接把一条话发给指定的人）
 *
 * 微信：走 wechat-bot.js 的 push 子命令（2026-10-19 实测 sendmessage 不带
 * context_token 也能发，所以能主动推）。这里把它一次性拉起来、喂 stdin、收输出。
 * 白名单检查在 pushText 内部做，这里不做第二遍 —— 两处不一致时以那边为准。
 *
 * QQ：走 NapCat 的 OneBot v11 HTTP（/send_private_msg）。口令从桥接配置的
 * snowluma.accessToken 读（必须和 NapCat 配的一致）；NapCat 没起就说人话报错。
 * ══════════════════════════════════════════════════════════════════════════ */

function wechatPush({ to, text, dryRun = false } = {}) {
  const target = String(to ?? '').trim();
  const body = String(text ?? '');
  if (!target) return Promise.resolve({ ok: false, error: '缺少目标微信用户 id' });
  if (!dryRun && !body.trim()) return Promise.resolve({ ok: false, error: '没有要发的内容' });

  const script = path.join(getRoot(), 'src', 'wechat-bot.js');
  if (!fs.existsSync(script)) return Promise.resolve({ ok: false, error: '找不到 src/wechat-bot.js（桥接目录对吗）' });

  const args = [script, 'push'];
  if (dryRun) args.push('--dry-run');
  args.push(target); // 文字不放进命令行（长文本/多行不用和转义搏斗），走 stdin

  return new Promise((resolve) => {
    const { command, env } = nodeRunner('wechat');
    const child = spawn(command, args, {
      cwd: dataRoot(),
      env: { ...process.env, ...env },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const out = [];
    child.stdout.on('data', (chunk) => out.push(chunk.toString()));
    child.stderr.on('data', (chunk) => out.push(chunk.toString()));
    child.on('error', (error) => resolve({ ok: false, error: String(error?.message ?? error) }));
    child.on('close', (code) => {
      const output = out.join('').trim();
      for (const line of output.split('\n').slice(-8)) if (line.trim()) pushLog(line, code === 0 ? 'out' : 'err', 'wechat');
      pushLog(dryRun ? `微信 dry-run（${target}）完成` : `微信主动发送（${target}）${code === 0 ? '完成' : `失败 code ${code}`}`, code === 0 ? 'sys' : 'err', 'wechat');
      resolve({ ok: code === 0, code, output: output.slice(-2000) });
    });
    child.stdin.write(body.endsWith('\n') ? body : body + '\n');
    child.stdin.end();
  });
}

async function qqSend({ qq, text } = {}) {
  const target = String(qq ?? '').trim();
  const body = String(text ?? '');
  if (!/^\d{5,12}$/.test(target)) return { ok: false, error: 'QQ 号不对（5~12 位数字）' };
  if (!body.trim()) return { ok: false, error: '没有要发的内容' };

  const n = napcatSettings();
  if (!(await probePort(n.httpPort))) {
    return { ok: false, error: `NapCat 的 HTTP 接口（${n.httpPort} 端口）不通。先一键启动，等 NapCat 就绪再发。` };
  }
  const token = String(loadConfig().snowluma?.accessToken ?? '').trim();
  try {
    const res = await fetch(`http://127.0.0.1:${n.httpPort}/send_private_msg`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify({ user_id: Number(target), message: body }),
      signal: AbortSignal.timeout(10_000)
    });
    const data = await res.json().catch(() => ({}));
    const bad = !res.ok || (data.status != null && data.status !== 'ok' && data.retcode !== 0);
    if (bad) {
      return { ok: false, error: `NapCat 返回异常：HTTP ${res.status} ${JSON.stringify(data).slice(0, 200)}` };
    }
    pushLog(`QQ 主动发送 → ${target}：${body.slice(0, 40)}`, 'sys', 'napcat');
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/** 微信推送可选目标：state/wechat-sessions.json 里聊过天的用户 id。 */
function wechatTargets() {
  const saved = readJson(path.join(dataRoot(), 'state', 'wechat-sessions.json'), {});
  return Object.keys(saved ?? {}).map((id) => ({ id }));
}

/** QQ 好友 / 群列表（发送选择器用）。NapCat 没在跑就给空列表，不报错。 */
async function qqContacts() {
  const n = napcatSettings();
  if (!(await probePort(n.httpPort))) return { friends: [], groups: [] };
  const token = String(loadConfig().snowluma?.accessToken ?? '').trim();
  const headers = { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  const get = async (endpoint) => {
    try {
      const res = await fetch(`http://127.0.0.1:${n.httpPort}${endpoint}`, { headers, signal: AbortSignal.timeout(5000) });
      const data = await res.json();
      return Array.isArray(data?.data) ? data.data : [];
    } catch {
      return [];
    }
  };
  const [friends, groups] = await Promise.all([get('/get_friend_list'), get('/get_group_list')]);
  return {
    friends: friends.map((f) => ({ id: String(f.user_id ?? ''), remark: f.remark ?? f.nickname ?? '' })).filter((x) => x.id),
    groups: groups.map((g) => ({ id: String(g.group_id ?? ''), name: g.group_name ?? '' })).filter((x) => x.id)
  };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 消息历史（「消息」页：按联系人看最近聊过什么）
 *
 * 数据源就是桥接和微信各自写的活动日志，不另建数据库：
 *   QQ   → state/qq-activity.log     `[HH:MM:SS] private:123 管理员 某某：正文`
 *  微信 → state/wechat-activity.log  `[HH:MM:SS] wxid_xxx 对方：正文`
 * 两边同一套形状（会话键 + 角色 + 正文），所以一个解析器够用。
 * 日志本身有行数上限（桥接侧 createCappedLogger 500 行），所以这里是「最近」
 * 而不是「全部」—— 界面上要写清楚，别让人以为聊天记录丢了。
 * ══════════════════════════════════════════════════════════════════════════ */

const ACTIVITY_RE = /^\[(\d{2}:\d{2}:\d{2})\]\s+(\S+)\s+([^：:]{1,24})[：:]\s*([\s\S]*)$/;

function activityFile(platform) {
  const name =
    platform === 'wechat' ? 'wechat-activity.log' : platform === 'phone' ? 'phone-activity.log' : 'qq-activity.log';
  return path.join(dataRoot(), 'state', name);
}

function readMessages(platform, limit = 300) {
  const file = activityFile(platform);
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { entries: [], contacts: [], file, missing: true };
  }
  const lines = raw.split('\n').filter((l) => l.trim());
  const entries = [];
  for (const line of lines.slice(-Math.max(1, limit))) {
    const m = ACTIVITY_RE.exec(line.trim());
    if (!m) continue;
    const [, clock, conv, who, text] = m;
    // 活动日志里混着一堆系统记录（`[reserved2] 消息已入未读：…`、`[voice] 发送语音…`），
    // 那些不是聊天内容，混进消息流只会把真正的对话淹掉。只留真人说话和 agent 回复。
    if (!/^(管理员|群友|对方|agent 回复|主动发送)/.test(who)) continue;
    const self = /^(agent 回复|主动发送)/.test(who);
    entries.push({
      clock,
      conv,
      // private:123 / group:456 是桥接的会话键；微信那边就是一个 id
      kind: conv.startsWith('group:') ? 'group' : 'private',
      target: conv.includes(':') ? conv.split(':')[1] : conv,
      who: who.trim(),
      self,
      text
    });
  }
  const contacts = [];
  const seen = new Map();
  for (const e of entries) {
    let c = seen.get(e.conv);
    if (!c) {
      c = { conv: e.conv, kind: e.kind, target: e.target, label: e.target, count: 0, last: '' };
      seen.set(e.conv, c);
      contacts.push(c);
    }
    c.count += 1;
    c.last = e.clock;
    // 拿对方最近一次的名字当显示名（agent 回复那行的 who 是固定串，跳过）
    if (!e.self) c.label = e.who.replace(/^管理员\s*/, '') || e.target;
  }
  // 微信那边可能还没聊过天但有会话记录，一并列出来，好让人挑目标发消息
  if (platform === 'wechat') {
    for (const t of wechatTargets()) {
      if (!seen.has(t.id)) {
        contacts.push({ conv: t.id, kind: 'private', target: t.id, label: t.id, count: 0, last: '' });
      }
    }
  }
  return { entries, contacts, file, missing: false };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 省流总结 + Webhook 通知枢纽
 *
 * 省流总结：把活动日志里某联系人的最近消息拼成一段话，喂给已配置的模型，
 * 出一份「我离开的这段时间群里发生了什么」。模型走「API 与模型」页配的那份
 * （qq/微信各认各的，work 档没有就用 chat 档）。
 *
 * 通知枢纽：本机其他软件 POST /hook/notify/<口令> 就能把一条文字推到
 * QQ（好友或群）或微信。配置存在 settings.json 旁边的 notify-hub.json。
 * 主服务只绑 127.0.0.1 —— 本机软件直接调；局域网设备要用得自己穿透。
 * ══════════════════════════════════════════════════════════════════════════ */

const NOTIFY_FILE = path.join(path.dirname(SETTINGS_FILE), 'notify-hub.json');

function loadNotify() {
  const d = {
    enabled: true,
    token: randomBytes(9).toString('base64url'),
    default: { platform: 'qq', to: '' },
    push: { kind: 'ntfy', endpoint: '' },
    mirror: { enabled: false, from: '', keyword: '', platform: 'qq', to: '' }
  };
  const c = readJson(NOTIFY_FILE, null);
  if (!c) {
    // 第一次用：把生成的口令落盘，否则界面展示的和接收端比对的永远对不上
    writeJson(NOTIFY_FILE, d);
    return d;
  }
  return {
    enabled: c.enabled !== false,
    token: String(c.token ?? '') || d.token,
    default: {
      platform: c.default?.platform === 'wechat' ? 'wechat' : c.default?.platform === 'push' ? 'push' : 'qq',
      to: String(c.default?.to ?? '')
    },
    push: {
      kind: ['ntfy', 'serverchan', 'bark', 'pushplus'].includes(c.push?.kind) ? c.push.kind : 'ntfy',
      endpoint: String(c.push?.endpoint ?? '')
    },
    mirror: {
      enabled: c.mirror?.enabled === true,
      from: String(c.mirror?.from ?? ''),
      keyword: String(c.mirror?.keyword ?? ''),
      platform: c.mirror?.platform === 'wechat' ? 'wechat' : 'qq',
      to: String(c.mirror?.to ?? '')
    }
  };
}

function saveNotify(hub) {
  writeJson(NOTIFY_FILE, hub);
}

/** QQ 发送：目标支持「QQ号」（私聊）和「group:群号」（群聊） */
async function qqSendAny(target, text) {
  const spec = String(target ?? '').trim();
  if (spec.startsWith('group:')) {
    const group = spec.slice(6).trim();
    if (!/^\d{3,15}$/.test(group)) return { ok: false, error: '群号不对：group: 后面要是数字' };
    const n = napcatSettings();
    if (!(await probePort(n.httpPort))) {
      return { ok: false, error: `NapCat 的 HTTP 接口（${n.httpPort} 端口）不通，先一键启动` };
    }
    const token = String(loadConfig().snowluma?.accessToken ?? '').trim();
    try {
      const res = await fetch(`http://127.0.0.1:${n.httpPort}/send_group_msg`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {})
        },
        body: JSON.stringify({ group_id: Number(group), message: String(text ?? '') }),
        signal: AbortSignal.timeout(10_000)
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || (data.status != null && data.status !== 'ok' && data.retcode !== 0)) {
        return { ok: false, error: `NapCat 返回异常：HTTP ${res.status} ${JSON.stringify(data).slice(0, 200)}` };
      }
      pushLog(`QQ 群通知 → ${group}：${String(text ?? '').slice(0, 40)}`, 'sys', 'napcat');
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }
  return qqSend({ qq: spec, text });
}

/** 推送到手机/手表：ntfy / Server酱 / Bark / PushPlus。endpoint 在「消息与任务」页配。 */
async function sendPush(hub, text) {
  const kind = hub.push?.kind ?? 'ntfy';
  const endpoint = String(hub.push?.endpoint ?? '').trim();
  if (!endpoint) return { ok: false, error: '推送渠道没配：先在「消息与任务 → Webhook 通知枢纽」里选渠道并填密钥/主题' };
  const firstLine = String(text ?? '').split('\n')[0].slice(0, 30);
  try {
    if (kind === 'ntfy') {
      // endpoint = 完整主题地址，如 https://ntfy.sh/my-secret-topic
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { Title: firstLine, Tags: 'robot' },
        body: String(text ?? ''),
        signal: AbortSignal.timeout(15_000)
      });
      if (!res.ok) return { ok: false, error: `ntfy 返回 HTTP ${res.status}` };
      return { ok: true };
    }
    if (kind === 'serverchan') {
      // Server酱·Turbo：https://sctapi.ftqq.com/<SENDKEY>.send
      const form = new URLSearchParams({ title: firstLine, desp: String(text ?? '') });
      const res = await fetch(`https://sctapi.ftqq.com/${encodeURIComponent(endpoint)}.send`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
        signal: AbortSignal.timeout(15_000)
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.code !== 0) return { ok: false, error: `Server酱失败：${data.message ?? 'HTTP ' + res.status}` };
      return { ok: true };
    }
    if (kind === 'bark') {
      // Bark（iOS）：https://api.day.app/push
      const res = await fetch('https://api.day.app/push', {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ device_key: endpoint, title: firstLine, body: String(text ?? '') }),
        signal: AbortSignal.timeout(15_000)
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.code !== 200) return { ok: false, error: `Bark 失败：${data.message ?? 'HTTP ' + res.status}` };
      return { ok: true };
    }
    if (kind === 'pushplus') {
      // PushPlus：http://www.pushplus.plus/send（微信公众号通道）
      const res = await fetch('https://www.pushplus.plus/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ token: endpoint, title: firstLine, content: String(text ?? '') }),
        signal: AbortSignal.timeout(15_000)
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.code !== 200) return { ok: false, error: `PushPlus 失败：${data.msg ?? 'HTTP ' + res.status}` };
      return { ok: true };
    }
    return { ok: false, error: `不认识的推送渠道 ${kind}` };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/** 统一出口：platform + to + text → QQ / 微信 / 推送渠道 */
async function notifyDispatch({ platform, to, text }) {
  const body = String(text ?? '').trim();
  if (!body) return { ok: false, error: '没有要发的内容' };
  const target = String(to ?? '').trim();
  if (!target) return { ok: false, error: '没有目标' };
  if (platform === 'push') {
    const hub = loadNotify();
    return sendPush(hub, body);
  }
  if (platform === 'wechat') return wechatPush({ to: target, text: body });
  return qqSendAny(target, body);
}

const SUMMARIZE_SYSTEM =
  '你是聊天记录总结助手。用户离开了一段时间，现在要看「省流版」。请用中文总结给出的聊天记录，格式：\n' +
  '1. 【聊了什么】每条话题一行，最多 5 行，每行一句话\n' +
  '2. 【等我处理】列出需要用户本人回应或行动的事；没有就写「没有」\n' +
  '3. 【一句话】整体结论或氛围，一句话\n' +
  '只输出这三段，不要开场白、不要复述原文、不要客套。直接输出总结文本，不要调用任何工具。';

/** 走内置模型 API 实例（matrix 后端）出一轮回答。
 *  secrets 里的厂商 key 全失效时，实例自己的模型链路往往还活着
 *  （self-test 走的就是它），所以它是省流总结的最后一档候选。
 *  流程照抄 src/self-test.js：建一次性会话 → 订阅事件流 → prompt → 等回合结束 → 归档。 */
async function summarizeViaMatrix(prompt, platform = 'qq') {
  const { NodeApiClient, unwrap, createTurnCollector } = await import(
    pathToFileURL(path.join(getRoot(), 'src', 'oc-client.js')).href
  );
  const { ensureServer } = await import(pathToFileURL(path.join(getRoot(), 'src', 'oc-server.js')).href);
  const { resolveModelInstance } = await import(pathToFileURL(path.join(getRoot(), 'src', 'oc-env.js')).href);

  const instance = resolveModelInstance(platform, { root: dataRoot(), useEnv: false });
  await ensureServer({ log: () => {}, instance });

  const api = new NodeApiClient(undefined, undefined, {
    stateDir: instance.stateDir,
    sessionDir: instance.stateDir,
    log: () => {}
  });
  const ws = unwrap(await api.workspace.create({ path: instance.configDir }), 'workspace.create');
  const workspaceId = ws.workspace.workspaceId;
  const created = unwrap(
    await api.sessions.create({ workspaceId, agentPreset: 'qq-chat', title: '省流总结（一次性，用完即归档）' }),
    'sessions.create'
  );
  const sessionId = created.sessionId;
  try {
    const collector = createTurnCollector();
    const stream = api.events.mux({});
    const done = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等待模型回复超时（240s）')), 240_000);
      (async () => {
        for await (const envelope of stream) {
          const frame = envelope.payload;
          if (frame.type === 'session/event' && frame.sessionId === sessionId) {
            const ended = collector.push(frame.event);
            if (ended) {
              clearTimeout(timer);
              resolve(ended);
              return;
            }
          }
          if (frame.type === 'stream/error') {
            clearTimeout(timer);
            reject(new Error('事件流错误: ' + JSON.stringify(frame.error).slice(0, 300)));
            return;
          }
        }
      })().catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    api.events.follow(sessionId);
    await unwrap(
      await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: prompt }] }),
      'sessions.prompt'
    );
    const ended = await done;
    return String(ended.text ?? '').trim();
  } finally {
    try {
      await api.workspace.archiveSession({ sessionId });
    } catch {
      /* 归档失败不影响结果 */
    }
  }
}

async function summarizeChat({ platform, conv, count } = {}) {
  const pf = platform === 'wechat' ? 'wechat' : 'qq';
  const key = String(conv ?? '').trim();
  if (!key) return { ok: false, error: '没有指定联系人' };
  const data = readMessages(pf, 2000);
  const entries = (data.entries ?? []).filter((e) => e.conv === key);
  if (!entries.length) return { ok: false, error: '这个联系人还没有消息记录' };

  const n = Math.min(Math.max(Number(count) || 100, 20), 400);
  const lines = entries
    .slice(-n)
    .map((e) => `[${e.clock}] ${e.self ? '机器人' : e.who}：${e.text}`);

  // 模型来源：当前平台的四档配置优先（总结是「干活」，chat 档就够），
  // 没配就走 organizeCandidates() 的降级链（模型来源 → 模型池免费档）。
  const secrets = readJson(secretsFile()) ?? {};
  const profiles = readModelProfiles();
  const preferred = [];
  for (const raw of [profiles[pf]?.chat, profiles[pf]?.work, profiles.qq?.chat, profiles.qq?.work]) {
    if (!raw) continue;
    try {
      preferred.push({ profile: resolveProfile(raw, secrets), via: '四档配置' });
    } catch {
      /* 配不全，跳过 */
    }
  }
  const candidates = [...preferred, ...organizeCandidates()];
  if (!candidates.length) {
    return { ok: false, error: '还没配置模型 —— 先到「API 与模型」页配好，或把模型加进模型池' };
  }

  const prompt = `以下是「${key}」的最近聊天记录（${lines.length} 条，按时间排序）：\n\n${lines.join('\n')}\n\n请给一份省流版总结。`;
  let lastError = '';
  // 一个模型额度用完/限流，就换下一个 —— 和角色卡整理是同一套降级逻辑。
  for (const { profile, via } of candidates) {
    let out = '';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90_000);
    try {
      for await (const item of streamChat(profile, {
        messages: [
          { role: 'system', text: SUMMARIZE_SYSTEM },
          { role: 'user', text: prompt }
        ],
        signal: controller.signal
      })) {
        if (item.delta) out += item.delta;
        if (out.length > 4000) break;
      }
      out = out.trim();
      if (!out) {
        lastError = '模型没有返回内容';
        continue;
      }
      return { ok: true, summary: out, count: lines.length, via, model: profile.model ?? '' };
    } catch (error) {
      lastError = humanizeModelError(error);
      pushLog(`省流总结换模型（${profile.model ?? '?'}）：${lastError}`, 'err', 'app');
    } finally {
      clearTimeout(timer);
    }
  }
  // 直连厂商全挂（本机常见：secrets 里的 key 被轮换过）还有一条路：
  // 内置模型 API 实例 —— self-test 走的就是它，key 由实例自己管。
  try {
    const out = await summarizeViaMatrix(prompt, pf);
    if (out) return { ok: true, summary: out, count: lines.length, via: '模型 API 实例', model: 'matrix' };
    lastError = '实例没有返回内容';
  } catch (error) {
    lastError = String(error?.message ?? error).slice(0, 300);
    pushLog(`省流总结走模型 API 实例失败：${lastError}`, 'err', 'app');
  }
  return { ok: false, error: `试了 ${candidates.length} 个直连模型和实例都没成功。最后一次：${lastError || '未知原因'}` };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 手机推送（Android 通知转发）
 *
 * 手机端跑 SmsForwarder / message-mirror 这类工具，把通知 POST 过来。
 * 收进来的东西落到 state/phone-activity.log，和 QQ / 微信同一套格式，
 * 「消息」页的解析器直接能读。
 *
 * 为什么要单开一个端口：主服务只绑 127.0.0.1 —— 那上面有密钥、有控制台口令，
 * 绝不能给局域网开。这里另起一个监听，只认 /hook/<token> 和根路径的状态页，
 * 其它路径一律 404。万一 token 漏了，最坏结果也只是别人能往消息流里塞一行字。
 * ══════════════════════════════════════════════════════════════════════════ */

const PHONE_DEFAULT_PORT = 3210;
const PHONE_LOG_MAX = 400;
const PHONE_INBOX_MAX = 60;

function phoneSettings() {
  const st = readJson(SETTINGS_FILE);
  const ph = st.phone && typeof st.phone === 'object' ? st.phone : {};
  const token = typeof ph.token === 'string' ? ph.token.trim() : '';
  const port = Number(ph.port);
  return {
    enabled: ph.enabled === true,
    port: Number.isFinite(port) && port >= 1024 && port <= 65535 ? port : PHONE_DEFAULT_PORT,
    token: /^[a-z0-9]{6,64}$/i.test(token) ? token : '',
    count: Number(ph.count) || 0,
    lastAt: Number(ph.lastAt) || 0,
    // 让模型也看到：推给管理员私聊那一路会话
    notifyAi: ph.notifyAi === true,
    notifyKey: typeof ph.notifyKey === 'string' ? ph.notifyKey.trim() : ''
  };
}

function writePhoneSettings(patch) {
  const st = readJson(SETTINGS_FILE);
  st.phone = { ...(st.phone ?? {}), ...patch };
  writeJson(SETTINGS_FILE, st);
  return phoneSettings();
}

/** 18 位十六进制。够长到猜不出来，又短到能手输。 */
const newPhoneToken = () => randomBytes(9).toString('hex');

/**
 * 局域网地址列表，**按「手机能不能连上」排序**。
 *
 * 机器上往往挂着一堆虚拟网卡（Radmin VPN、VMware、Hyper-V…），它们的 IP 手机根本
 * 连不到。以前直接按网卡顺序返回，第一个经常是 26.x 的 VPN 地址 —— 用户照抄过去
 * 怎么试都不通，还以为是防火墙的事。
 */
const VIRTUAL_IF = /(radmin|vmware|virtualbox|hyper-?v|tailscale|zerotier|wsl|docker|loopback|tap|tun|npcap|vpn)/i;

function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family !== 'IPv4' || ni.internal) continue;
      if (/^(127\.|169\.254\.)/.test(ni.address)) continue;
      out.push({ name, address: ni.address });
    }
  }
  const score = (item) => {
    if (VIRTUAL_IF.test(item.name)) return 9;
    if (/^192\.168\./.test(item.address)) return 0;
    if (/^10\./.test(item.address)) return 1;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(item.address)) return 1;
    if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(item.address)) return 2;
    return 3;
  };
  return out.sort((a, b) => score(a) - score(b));
}

const phoneLogFile = () => path.join(dataRoot(), 'state', 'phone-activity.log');
const phoneInboxFile = () => path.join(dataRoot(), 'state', 'phone-inbox.json');

function readPhoneInbox() {
  const list = readJson(phoneInboxFile(), []);
  return Array.isArray(list) ? list : [];
}

/** 只留最后 max 行 —— 不重写的话这个文件会一直涨。 */
function trimLines(file, max) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    if (lines.length <= max + 40) return;
    fs.writeFileSync(file, lines.slice(-max).join('\n'), 'utf8');
  } catch {
    /* 截断失败不影响收消息 */
  }
}

/**
 * 包名 → 人话。
 * SmsForwarder 的 {{app_pkg}} 给的是 `com.tencent.mm`，直接显示在消息流里没法看；
 * 认不出来的包名就取最后一段（`com.xxx.something` → `something`）。
 */
const PHONE_APP_ALIAS = [
  [/com\.tencent\.mm/i, '微信'],
  [/com\.tencent\.mobileqq/i, 'QQ'],
  [/com\.tencent\.tim/i, 'TIM'],
  [/com\.tencent\.android\.qqmail/i, 'QQ邮箱'],
  [/com\.android\.mms|^mms$/i, '短信'],
  [/com\.alibaba\.android\.rimet/i, '钉钉'],
  [/com\.ss\.android\.ugc\.aweme/i, '抖音'],
  [/com\.xingin/i, '小红书'],
  [/com\.taobao|com\.tmall/i, '淘宝'],
  [/com\.jd\.jingdong/i, '京东'],
  [/com\.eg\.android\.AlipayGphone/i, '支付宝'],
  [/com\.netease\.mail/i, '网易邮箱'],
  [/android\.dialer|incallui|com\.android\.phone/i, '电话']
];

function normalizePhoneApp(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return '手机';
  const pkg = text.split('/')[0].trim();
  for (const [re, name] of PHONE_APP_ALIAS) if (re.test(pkg)) return name;
  if (/^[a-z][a-z0-9_]*(\.[a-z0-9_]+){2,}$/i.test(pkg)) {
    const parts = pkg.split('.');
    return (parts[parts.length - 1] || '手机').slice(0, 20);
  }
  return text.slice(0, 24);
}

/**
 * 三种来源的字段名都不一样，统一成 {app, from, text, kind}。
 *   SmsForwarder  → 自己拼的 JSON / 表单，常见 from + content
 *   message-mirror→ {app, message_body, type}
 *   随手 curl     → 纯文本、?text=xxx、{"text": "..."}
 */
function parsePhonePayload(raw, contentType, query) {
  const body = String(raw ?? '').trim();
  let data = {};
  if (body) {
    try {
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed;
    } catch {
      if (/x-www-form-urlencoded/i.test(contentType ?? '') || /^[^\s=&]+=[^\s&]*(&|$)/.test(body)) {
        data = Object.fromEntries(new URLSearchParams(body).entries());
      } else {
        data = { text: body };
      }
    }
  }
  // 有的工具把真正的内容包了一层
  for (const key of ['extra', 'data', 'payload', 'notification']) {
    const inner = data?.[key];
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
      data = { ...inner, ...data };
      break;
    }
  }

  const q = query ?? new URLSearchParams();
  const pick = (keys) => {
    for (const k of keys) {
      for (const src of [data, Object.fromEntries(q.entries())]) {
        const v = src?.[k];
        if (typeof v === 'string' && v.trim()) return v.trim();
        if (typeof v === 'number') return String(v);
      }
    }
    return '';
  };

  return {
    app: pick(['app', 'appName', 'app_name', 'packageName', 'package_name', 'package', 'pkg', 'source']),
    from: pick(['from', 'sender', 'title', 'contact', 'fromName', 'from_name', 'number']),
    text: pick(['text', 'content', 'message_body', 'body', 'msg', 'message', 'description', 'notify', 'summary']),
    kind: pick(['type', 'kind', 'event', 'category'])
  };
}

function recordPhonePush({ app, from, text, kind }) {
  const appName = normalizePhoneApp(app);
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return { ok: false, error: '内容为空，检查一下手机端的字段映射' };
  const sender = String(from ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const clock = new Date().toLocaleTimeString('zh-CN', { hour12: false });

  const file = phoneLogFile();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `[${clock}] phone:${appName} 对方：${sender ? `【${sender}】` : ''}${clean.slice(0, 4000)}\n`, 'utf8');
    trimLines(file, PHONE_LOG_MAX);
  } catch (error) {
    return { ok: false, error: `写日志失败：${error?.message ?? error}` };
  }

  const inbox = readPhoneInbox();
  inbox.unshift({
    at: Date.now(),
    app: appName,
    from: sender,
    text: clean.slice(0, 600),
    kind: String(kind ?? '').slice(0, 30)
  });
  try {
    writeJson(phoneInboxFile(), inbox.slice(0, PHONE_INBOX_MAX));
  } catch { /* 收件箱写不进去不影响日志 */ }

  writePhoneSettings({ count: phoneSettings().count + 1, lastAt: Date.now() });
  pushLog(`手机推送 · ${appName}${sender ? `（${sender}）` : ''}：${clean.slice(0, 60)}`, 'out', 'phone');

  // 让模型也看到：走桥接控制台的「后台提醒」通道，投进管理员私聊那一路会话。
  // 为什么走这条而不是自己拼 prompt：桥接已经处理好了会话令牌、静默投递、角色注入，
  // 从外面另起一套只会跟它打架。
  if (phoneSettings().notifyAi) {
    notifyAiAboutPhone({ app: appName, from: sender, text: clean }).catch((error) => {
      pushLog(`手机推送没送进模型：${error?.message ?? error}`, 'err', 'phone');
    });
  }

  return { ok: true, app: appName, from: sender, text: clean.slice(0, 200) };
}

/** 桥接控制台的端口和口令（口令没配就去读桥接自动生成的那个文件）。 */
function bridgeConsole() {
  const cfg = loadConfig();
  const port = Number(cfg.consolePort) || 3100;
  let token = String(cfg.consoleToken ?? '').trim();
  if (!token) {
    try {
      token = fs.readFileSync(path.join(dataRoot(), 'state', 'console-token'), 'utf8').trim();
    } catch {
      token = '';
    }
  }
  return { port, token };
}

/**
 * 把思考强度推给正在跑的桥接（热切换，下一条消息生效）。
 * 返回 false 不代表保存失败：配置已落盘，桥接没跑时下次启动会读新值。
 */
async function pushReasoningEffort(effort) {
  try {
    const { port, token } = bridgeConsole();
    const upstream = await fetch(`http://127.0.0.1:${port}/api/dsh/effort`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { 'x-console-token': token } : {}) },
      body: JSON.stringify({ reasoningEffort: effort }),
      signal: AbortSignal.timeout(5000)
    });
    const data = await upstream.json().catch(() => ({}));
    return upstream.ok && data.ok !== false;
  } catch {
    return false;
  }
}

/**
 * 把一条手机通知作为「后台提醒」投给模型。
 *
 * 目标会话默认是管理员私聊（private:ownerQQ）—— 手机通知本来就该让管理员知道，
 * 而且这条会话一定存在、权限最宽，不用额外给模型开新会话。
 */
async function notifyAiAboutPhone({ app, from, text }) {
  const cfg = loadConfig();
  const s = phoneSettings();
  const key = s.notifyKey || (cfg.ownerQQ ? `private:${cfg.ownerQQ}` : '');
  if (!key) throw new Error('没配管理员 QQ，不知道该投给哪一路会话');
  const { port, token } = bridgeConsole();
  if (!token) throw new Error('拿不到桥接控制台口令，先启动一次桥接');
  if (!(await probePort(port))) throw new Error(`桥接控制台 ${port} 没在跑`);

  const message =
    `【手机通知】${app}${from ? ` · ${from}` : ''}：${String(text).slice(0, 800)}\n` +
    '（这条是从手机通知转发过来的，不是 QQ 消息。需要的话可以用 qq_send_private_message 转告管理员，不需要就忽略。）';

  const res = await fetch(`http://127.0.0.1:${port}/api/console/notify-ai`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-console-token': token },
    body: JSON.stringify({ key, message }),
    signal: AbortSignal.timeout(30_000)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error ?? `HTTP ${res.status}`);
  pushLog(`手机推送已投给模型（${key}）`, 'sys', 'phone');
  return data;
}

/* ── 手机那个专用端口 ───────────────────────────────────────────────────── */

let phoneServer = null;
let phoneListening = 0;
let phoneHits = { at: 0, count: 0 };

function phoneStatusPage() {
  const { enabled, port } = phoneSettings();
  return `<!doctype html><meta charset="utf-8"><title>DualHabitat Matrix · 手机推送</title>
<style>body{font:14px/1.7 "Segoe UI",system-ui,sans-serif;background:#0e1114;color:#dbe3ec;padding:40px;max-width:640px;margin:auto}
h1{font-size:18px}code{background:#1b2128;padding:2px 6px;border-radius:4px;color:#58a6ff}
.ok{color:#4ec27f}</style>
<h1>手机推送端点<span class="${enabled ? 'ok' : ''}">${enabled ? ' · 已启用' : ' · 未启用'}</span></h1>
<p>这个端口只收通知转发，别的什么都干不了。</p>
<p>端口 <code>${port}</code>；推送地址形如 <code>http://本机局域网 IP:${port}/hook/&lt;口令&gt;</code>。</p>
<p>要改设置，回桌面端「手机」页。</p>`;
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      // 通知内容再长也到不了这个量级，超了直接掐，别让一个坏请求把内存吃满
      if (size > 256 * 1024) {
        reject(new Error('请求体太大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * 手机上打开的那一页：扫二维码进来，看到的就是要填的东西。
 *
 * 为什么地址用 req.headers.host 现拼：手机是用哪个 IP 找到我们的，
 * 它就该用哪个 IP 往回调 —— 电脑上有几块网卡时，写死某一个必然有一半是错的。
 */
function phoneSetupPage(host, token) {
  const safeHost = String(host ?? '').replace(/[^0-9a-zA-Z.:\-[\]]/g, '');
  const endpoint = `http://${safeHost}/hook/${token}`;
  const body = '{"app":"{{app名称}}","from":"{{通知标题}}","text":"{{通知内容}}"}';
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>手机推送配置</title>
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{margin:0;padding:18px 16px 40px;background:#0e1114;color:#dbe3ec;
       font:15px/1.65 -apple-system,"Segoe UI",system-ui,"PingFang SC","Microsoft YaHei",sans-serif}
  h1{font-size:19px;margin:6px 0 4px}
  p.sub{margin:0 0 18px;color:#9aa7b6;font-size:13px}
  .card{background:#161b20;border:1px solid #262e37;border-radius:10px;padding:14px;margin-bottom:14px}
  .k{font-size:12px;color:#6c7a89;margin-bottom:6px}
  .v{font-family:ui-monospace,Consolas,monospace;font-size:12.5px;word-break:break-all;
     background:#0e1114;border:1px solid #262e37;border-radius:7px;padding:9px 10px;user-select:all}
  button{margin-top:10px;width:100%;padding:11px;font-size:14px;border-radius:9px;
         border:1px solid #2f7fd6;background:#2f7fd6;color:#fff;font-weight:600}
  button.ghost{background:transparent;color:#58a6ff;border-color:#262e37}
  ol{padding-left:20px;margin:6px 0 0;color:#9aa7b6;font-size:13.5px}
  ol li{margin-bottom:8px}
  b{color:#dbe3ec}
  code{background:#1b2128;border-radius:4px;padding:1px 5px;font-size:12.5px}
</style>
<h1>手机推送 · 配置</h1>
<p class="sub">这一页就是给手机填的。填完回电脑上看「手机」页的「最近收到」。</p>

<div class="card">
  <div class="k">推送地址（POST）</div>
  <div class="v" id="ep">${esc(endpoint)}</div>
  <button onclick="cp('ep',this)">复制地址</button>
</div>

<div class="card">
  <div class="k">请求体（JSON）</div>
  <div class="v" id="bd">${esc(body)}</div>
  <button onclick="cp('bd',this)">复制请求体</button>
  <button class="ghost" onclick="tryPost()">从这台手机发一条试试</button>
  <div class="k" id="out" style="margin-top:10px"></div>
</div>

<div class="card">
  <div class="k">怎么填</div>
  <ol>
    <li>装 <b>SmsForwarder</b>（GitHub 上开源那个），允许<strong>通知使用权</strong>。</li>
    <li>「发送通道」→ 新增 → <b>Webhook</b>：地址粘上面的，方法 POST，内容类型
        <code>application/json</code>，请求体粘上面的。</li>
    <li>「通知转发」→ 新增 → 勾上要转的 App → 通道选刚建的那个。</li>
    <li>电脑那边「手机」页会立刻多一行。收不到先看两台设备是不是同一个 WiFi。</li>
  </ol>
</div>

<script>
function cp(id, btn){
  var text = document.getElementById(id).textContent;
  var done = function(){ btn.textContent = '已复制'; setTimeout(function(){ btn.textContent = btn.textContent.indexOf('请求体')>=0?'复制请求体':'复制地址'; }, 1500); };
  var fallback = function(){
    var ta = document.createElement('textarea');
    ta.value = text; ta.style.position='fixed'; ta.style.opacity='0';
    document.body.appendChild(ta); ta.focus(); ta.select();
    try { document.execCommand('copy'); done(); } catch (e) { alert('长按上面的文字手动复制'); }
    document.body.removeChild(ta);
  };
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(done).catch(fallback);
  } else { fallback(); }
}
function tryPost(){
  var out = document.getElementById('out');
  out.textContent = '发…';
  fetch(${JSON.stringify(endpoint).replace(/</g, '\\u003c')}, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ app: '手机浏览器', from: '自测', text: '从手机浏览器发的一条测试' })
  }).then(function(r){ return r.text(); })
    .then(function(t){ out.textContent = '结果：' + t; })
    .catch(function(e){ out.textContent = '失败：' + e.message; });
}
</script>
</html>`;
}

async function handlePhoneRequest(req, res) {
  const url = new URL(req.url ?? '/', 'http://0.0.0.0');
  const { token } = phoneSettings();

  if (url.pathname === '/' || url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(phoneStatusPage());
    return;
  }

  // 手机扫二维码落到这里：一页纸，把该复制的东西都摆出来
  const setup = /^\/setup\/([A-Za-z0-9_-]{4,64})\/?$/.exec(url.pathname);
  if (setup) {
    if (!token || setup[1] !== token) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('口令不对');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(phoneSetupPage(req.headers.host, token));
    return;
  }

  const hit = /^\/hook\/([A-Za-z0-9_-]{4,64})\/?$/.exec(url.pathname);
  const deny = (status, message) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: message }));
  };
  if (!hit) return deny(404, '没有这个地址');
  if (!token || hit[1] !== token) return deny(403, '口令不对');

  // 一分钟 120 条封顶：正常通知量远低于这个数，超了基本是有人在刷
  const now = Date.now();
  if (now - phoneHits.at > 60_000) phoneHits = { at: now, count: 0 };
  phoneHits.count += 1;
  if (phoneHits.count > 120) return deny(429, '太频繁了');

  let raw = '';
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    try {
      raw = await readRawBody(req);
    } catch (error) {
      return deny(413, String(error?.message ?? error));
    }
  }

  const parsed = parsePhonePayload(raw, req.headers['content-type'], url.searchParams);
  const result = recordPhonePush(parsed);
  res.writeHead(result.ok ? 200 : 400, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(result));
}

/** 起手机端口。已经在监听同一个端口就不动它。 */
function startPhoneListener() {
  const { enabled, port } = phoneSettings();
  if (!enabled) {
    stopPhoneListener();
    return { ok: false, running: false, reason: '没启用' };
  }
  if (phoneServer && phoneListening === port) return { ok: true, running: true, port };

  stopPhoneListener();
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      handlePhoneRequest(req, res).catch(() => {
        try {
          res.writeHead(500);
          res.end('error');
        } catch { /* 连接已经断了 */ }
      });
    });
    s.once('error', (error) => {
      phoneServer = null;
      phoneListening = 0;
      pushLog(`手机推送端口 ${port} 起不来：${error?.code ?? error}`, 'err', 'phone');
      resolve({ ok: false, running: false, error: String(error?.code ?? error) });
    });
    s.listen(port, '0.0.0.0', () => {
      phoneServer = s;
      phoneListening = port;
      pushLog(`手机推送已就绪：局域网端口 ${port}`, 'sys', 'phone');
      resolve({ ok: true, running: true, port });
    });
  });
}

function stopPhoneListener() {
  if (!phoneServer) return;
  try {
    phoneServer.close();
  } catch { /* 关不掉就算了 */ }
  phoneServer = null;
  phoneListening = 0;
}

/* ══════════════════════════════════════════════════════════════════════════
 * 三、测连通
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * 真发一条请求，测首字延迟。
 * 不测"能不能连上"，测"能不能出字" —— 端点通但 key 错、模型名错，都是常见坑。
 */
async function testBackend(input) {
  const started = Date.now();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 20_000);
  try {
    const secrets = readJson(secretsFile());
    const profile = resolveProfile(input, secrets);
    let firstCharAt = null;
    let text = '';
    let usage = null;

    for await (const item of streamChat(profile, {
      messages: [{ role: 'user', text: '用一句话打个招呼' }],
      signal: abort.signal
    })) {
      if (item.delta) {
        if (firstCharAt === null) firstCharAt = Date.now();
        text += item.delta;
        if (text.length > 200) abort.abort();
      }
      if (item.usage) usage = item.usage;
    }

    return {
      ok: true,
      model: profile.model,
      firstCharMs: firstCharAt ? firstCharAt - started : null,
      totalMs: Date.now() - started,
      reply: text.slice(0, 200),
      usage
    };
  } catch (error) {
    return { ok: false, error: humanizeModelError(error) };
  } finally {
    clearTimeout(timer);
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * 自动化：崩溃看护 / 开机自启 / 定时任务
 *
 * 配置存 automation.json（和 settings.json 同目录 —— 打包后在 userData）。
 * 看护挂在各进程的 close 事件上：用户主动停（stopBridge / stopWechat / stopNapcat /
 * bringDown）会先立 suppress 旗子，只有「没人让它停、它自己死了」才算意外，
 * 才按配置自动拉回来。连挂太多次就放弃（默认 5 次），免得变成死循环重启。
 * NapCat 特殊：启动器本来就会自己退出，看它要看端口，不能看子进程。
 * ══════════════════════════════════════════════════════════════════════════ */

const AUTOMATION_FILE = path.join(path.dirname(SETTINGS_FILE), 'automation.json');
const APP_VERSION = readJson(path.join(here, 'package.json'), {}).version ?? '0.0.0';

// 本进程启动时刻。前端拿它算「已经跑了多久」，比轮询计数器准。
const BOOT_AT = Date.now();

function automationDefaults() {
  return { watch: { napcat: false, bridge: false, wechat: false, qqofficial: false }, launchAtLogin: false, schedules: [] };
}

function loadAutomation() {
  const cfg = readJson(AUTOMATION_FILE, null);
  const base = automationDefaults();
  if (!cfg) return base;
  return {
    watch: { ...base.watch, ...(cfg.watch ?? {}) },
    launchAtLogin: cfg.launchAtLogin === true,
    schedules: Array.isArray(cfg.schedules) ? cfg.schedules : []
  };
}

function saveAutomation(cfg) {
  writeJson(AUTOMATION_FILE, cfg);
}

/** 用户主动停了某个服务 → 15 秒内压住 close 回调里的看护，别停完又被拉起来。 */
const suppressRestart = { napcat: 0, bridge: 0, wechat: 0 };
const restartAttempts = { napcat: 0, bridge: 0, wechat: 0 };
const RESTART_MAX = 5;
const RESTART_DELAY_MS = 5000;

function markManualStop(kind) {
  // 多号后 stopKey 是动态的（napcat:qq2 / wechat:wx3 / qqofficial:AppID），
  // 不能再只认 suppressRestart 里预置的三个键，否则手动停 qq2 会被看护 30 秒后拉起来。
  if (kind) suppressRestart[kind] = Date.now();
}

function recentlyStopped(kind) {
  const at = suppressRestart[kind];
  return Number.isFinite(at) && Date.now() - at < 15_000;
}

function onServiceExit(kind) {
  if (shuttingDown) return;
  if (recentlyStopped(kind)) {
    suppressRestart[kind] = 0;
    return;
  }
  const cfg = loadAutomation();
  if (!cfg.watch[kind]) return;
  if (restartAttempts[kind] >= RESTART_MAX) {
    pushLog(`「${kind}」连续 ${RESTART_MAX} 次自动重启失败，看护放弃，等手动处理`, 'err', 'app');
    return;
  }
  restartAttempts[kind] += 1;
  pushLog(`看护：「${kind}」意外退出，${RESTART_DELAY_MS / 1000} 秒后自动重启（第 ${restartAttempts[kind]}/${RESTART_MAX} 次）`, 'sys', 'app');
  setTimeout(() => {
    if (shuttingDown) return;
    try {
      if (kind === 'bridge') startBridge();
      else if (kind === 'wechat') startWechat();
      pushLog(`看护：「${kind}」已重新拉起`, 'sys', 'app');
    } catch (error) {
      pushLog(`看护重启「${kind}」失败：${error?.message ?? error}`, 'err', 'app');
    }
  }, RESTART_DELAY_MS);
}

/** 服务稳定跑过 5 分钟就清零计数 —— 偶尔崩一次和连环崩要区别对待。 */
setInterval(() => {
  for (const k of Object.keys(restartAttempts)) {
    // NapCat 的计数不按时间清：它可能是「启动了但端口一直没起来」，
    // 按时间清零会变成无限重试。NapCat 只在端口探测通过时清零（见下面的看护）。
    const startedAt = k === 'bridge'
      ? bridge.startedAt
      : k === 'wechat'
        ? wechat.startedAt
        : null;
    if (startedAt && Date.now() - startedAt > 5 * 60_000) restartAttempts[k] = 0;
  }
}, 60_000);

/** NapCat 看护：看端口不看子进程（启动器本来就会退）。只接管我们自己启动过的。 */
setInterval(async () => {
  try {
    if (shuttingDown) return;
    const cfg = loadAutomation();
    if (!cfg.watch.napcat) return;
    for (const acc of napcatAccounts()) {
      if (acc.enabled === false) continue;
      const rec = napcatProcs.get(acc.id);
      if (!rec?.managed) continue;
      const stopKey = acc.id === DEFAULT_ACCOUNT_ID ? 'napcat' : `napcat:${acc.id}`;
      if (recentlyStopped(stopKey)) continue;
      if (await probePort(acc.wsPort)) {
        // 端口通就是稳定了，把之前的失败计数清掉。
        restartAttempts[stopKey] = 0;
        continue;
      }
      const attempts = restartAttempts[stopKey] ?? 0;
      if (attempts >= RESTART_MAX) {
        pushLog(`[${acc.id}] NapCat 连续 ${RESTART_MAX} 次自动重启失败，看护放弃`, 'err', 'app');
        // 放弃后别再显示「运行中」，让用户能手动重新启动。
        const current = napcatProcs.get(acc.id);
        if (current) napcatProcs.set(acc.id, { ...current, managed: false });
        continue;
      }
      restartAttempts[stopKey] = attempts + 1;
      pushLog(`看护：[${acc.id}] NapCat 端口（${acc.wsPort}）掉了，自动重启（第 ${attempts + 1}/${RESTART_MAX} 次）`, 'sys', 'app');
      startNapcat(acc.id);
    }
  } catch {
    /* 看护自身不能带崩服务 */
  }
}, 30_000);

/* ── 开机自启（Electron 打包版才有；开发态和纯 node 调试都报告不支持） ── */

function autostartState() {
  if (!electronApp || !electronApp.isPackaged) return { supported: false, enabled: false };
  try {
    return { supported: true, enabled: electronApp.getLoginItemSettings().openAtLogin };
  } catch {
    return { supported: false, enabled: false };
  }
}

function applyAutostart(on) {
  if (!electronApp || !electronApp.isPackaged) return autostartState();
  try {
    electronApp.setLoginItemSettings({ openAtLogin: Boolean(on), openAsHidden: true });
    return autostartState();
  } catch (error) {
    pushLog(`设置开机自启失败：${error?.message ?? error}`, 'err', 'app');
    return autostartState();
  }
}

/* ── 定时任务 ──
 * kind: wechat-push（target=微信用户id）/ qq-send（target=QQ号）/ restart-all（整条链路重启）
 * every: { type: "daily", time: "HH:MM" } | { type: "interval", minutes: N }
 * lastRun 先落盘再执行 —— 防止「触发了还没跑完就退出」导致重复触发。 */

function scheduleDue(task, now) {
  if (!task?.enabled) return false;
  const every = task.every ?? {};
  if (every.type === 'interval') {
    const minutes = Number(every.minutes);
    if (!(Number.isFinite(minutes) && minutes >= 1)) return false;
    if (!task.lastRun) return true;
    return now - Number(task.lastRun) >= minutes * 60_000;
  }
  if (every.type === 'daily') {
    const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(every.time ?? ''));
    if (!m) return false;
    const d = new Date(now);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const want = m[1].padStart(2, '0') + ':' + m[2];
    if (want !== hh + ':' + mm) return false;
    const minuteStart = new Date(now);
    minuteStart.setSeconds(0, 0, 0);
    return !task.lastRun || Number(task.lastRun) < minuteStart.getTime();
  }
  return false;
}

function runScheduleTask(task) {
  const kind = String(task.kind ?? '');
  if (kind === 'wechat-push') return wechatPush({ to: task.target, text: task.text });
  if (kind === 'qq-send') return qqSend({ qq: task.target, text: task.text });
  if (kind === 'restart-all') {
    bringDown();
    return new Promise((resolve) => setTimeout(async () => resolve(await bringUp()), 2000));
  }
  return Promise.resolve({ ok: false, error: `不认识的任务类型「${kind}」` });
}

function tickSchedules() {
  if (shuttingDown) return;
  const now = Date.now();
  const cfg = loadAutomation();
  let dirty = false;
  for (const task of cfg.schedules) {
    if (!scheduleDue(task, now)) continue;
    task.lastRun = now;
    dirty = true;
    pushLog(`定时任务「${task.name || task.id}」触发`, 'sys', 'app');
    runScheduleTask(task)
      .then((result) => {
        task.lastResult = { at: now, ok: result?.ok === true, detail: result?.ok === true ? '' : String(result?.error ?? result?.output ?? '失败').slice(0, 200) };
        saveAutomation(cfg);
        pushLog(`定时任务「${task.name || task.id}」${task.lastResult.ok ? '完成' : `失败：${task.lastResult.detail}`}`, task.lastResult.ok ? 'sys' : 'err', 'app');
      })
      .catch((error) => {
        task.lastResult = { at: now, ok: false, detail: String(error?.message ?? error).slice(0, 200) };
        saveAutomation(cfg);
      });
  }
  if (dirty) saveAutomation(cfg);
}

function startScheduler() {
  if (startScheduler.timer) return;
  startScheduler.timer = setInterval(tickSchedules, 20_000);
}

function initAutomation() {
  startScheduler();
  const cfg = loadAutomation();
  if (cfg.launchAtLogin) applyAutostart(true);
  const watching = Object.entries(cfg.watch).filter(([, v]) => v).map(([k]) => k).join('、');
  pushLog(`自动化已加载：看护 ${watching || '关'} · 定时任务 ${cfg.schedules.filter((t) => t.enabled).length} 条`, 'sys');
}

/* ══════════════════════════════════════════════════════════════════════════
 * 批量导入 API key：粘贴一堆行 → 自动认出是哪家 → 分类入库
 *
 * 立场：自动识别是**建议**不是结论 —— 每一行的判定带着依据（前缀 / URL / 形状），
 * 前端把报告列出来让用户过目改判（provider/env 都能改），apply=true 才真写。
 * 拿不准的行标 low 置信度，绝不硬猜；完全相同的 key 标 dup 不重复入库。
 * ══════════════════════════════════════════════════════════════════════════ */

const maskKey = (k) => (k.length <= 10 ? `${k.slice(0, 2)}…${k.slice(-2)}` : `${k.slice(0, 6)}…${k.slice(-4)}`);

function classifyImportLine(raw, providers, knownEnvs) {
  const line = String(raw ?? '').trim();
  if (!line || line.startsWith('#') || line.startsWith('//')) return null;
  const item = { line: line.slice(0, 160), key: '', provider: '', env: '', baseUrl: '', confidence: 'low', reason: '', dup: false };

  // 行内 JSON：{"baseUrl": "...", "key": "..."} 之类，容忍一下
  if (line.startsWith('{')) {
    try {
      const j = JSON.parse(line);
      item.key = String(j.key ?? j.apiKey ?? j.token ?? '');
      item.baseUrl = String(j.baseUrl ?? j.base_url ?? j.url ?? '');
    } catch { /* 不是 JSON 就按普通行处理 */ }
  }

  // 显式分隔：provider|key / provider=key / provider: key（provider 也可以是 URL）
  const split = /^(.*?)\s*[|=:>]\s*(\S+)\s*$/.exec(line);
  let hint = '';
  if (split && !item.key) {
    const left = split[1].trim();
    const right = split[2].trim();
    if (/^sk-|^nvapi-|^hf_|^[0-9a-f]{32}\./i.test(right) || left.length <= 24) {
      hint = left;
      item.key = right;
    }
  }

  if (!item.key) {
    // URL + key 混排（顺序不管）：挑出 https 开头的当 URL，剩下长得最像 key 的那段
    const tokens = line.split(/\s+/).filter(Boolean);
    const urlTok = tokens.find((t) => /^https?:\/\//i.test(t));
    const keyTok = tokens.filter((t) => t !== urlTok).sort((a, b) => b.length - a.length)[0];
    if (urlTok) item.baseUrl = urlTok;
    if (keyTok) item.key = keyTok;
  }

  if (!item.key) {
    item.reason = '这行里没认出 key（也可能是注释或说明文字），先跳过';
    return item;
  }

  // provider 判定，从强到弱：URL host 匹配 → 显式 hint → key 形状
  const catalog = providers ?? [];
  if (item.baseUrl) {
    try {
      const host = new URL(item.baseUrl).host;
      const hit = catalog.find((p) => {
        try { return new URL(p.baseUrl).host === host; } catch { return false; }
      });
      if (hit) {
        item.provider = hit.id;
        item.env = hit.keyEnv ?? '';
        item.confidence = 'high';
        item.reason = `接口地址 ${host} 对上目录里的 ${hit.label}`;
      }
    } catch { /* URL 不合法就当没有 */ }
  }
  if (!item.provider && hint) {
    const h = hint.toLowerCase().replace(/^https?:\/\//, '');
    const hit = catalog.find((p) => p.id.toLowerCase() === h || p.label.toLowerCase() === h || h.includes(p.id.toLowerCase()));
    if (hit) {
      item.provider = hit.id;
      item.env = hit.keyEnv ?? '';
      item.confidence = item.baseUrl ? 'medium' : 'high';
      item.reason = `行首写明了 ${hit.label}`;
    } else if (knownEnvs.some((e) => e.env.toLowerCase() === h)) {
      item.env = knownEnvs.find((e) => e.env.toLowerCase() === h).env;
      item.confidence = 'high';
      item.reason = `行首写明了环境变量 ${item.env}`;
    }
  }
  if (!item.provider && !item.env) {
    const shape = [
      [/^sk-or-v1-/, 'openrouter', 'OPENROUTER_API_KEY', 'sk-or-v1- 是 OpenRouter 的前缀'],
      [/^sk-ant-/, 'anthropic', 'ANTHROPIC_API_KEY', 'sk-ant- 是 Anthropic 的前缀'],
      [/^nvapi-/, 'nvidia', 'NVIDIA_API_KEY', 'nvapi- 是 NVIDIA NIM 的前缀'],
      [/^hf_/, '', 'HF_TOKEN', 'hf_ 是 HuggingFace token（进 HF_TOKEN）'],
      [/^[0-9a-f]{32}\.[A-Za-z0-9]{16}$/, 'zhipu', 'ZHIPU_API_KEY', 'id.secret 两段式是智谱的 key 形状'],
      [/^sk-/, 'openai', 'OPENAI_API_KEY', 'sk- 开头是 OpenAI 兼容格式（DeepSeek / 月之暗面等也用这个形状，建议核对）']
    ];
    for (const [re, provider, envName, why] of shape) {
      if (re.test(item.key)) {
        item.reason = why;
        const hit = provider ? catalog.find((p) => p.id === provider) : null;
        if (hit) { item.provider = hit.id; item.env = hit.keyEnv || envName; }
        else { item.env = envName; if (provider) item.provider = provider; }
        item.confidence = provider === 'openai' && !item.baseUrl ? 'low' : 'high';
        break;
      }
    }
  }
  if (!item.provider && !item.env && !item.reason) item.reason = '认不出是哪家 —— 在下面手动指定服务商或环境变量再入库';
  return item;
}

function importProviders({ text, apply = false, items = [] } = {}) {
  const providers = listProviders();
  const secrets = readJson(secretsFile(), {});
  const existing = new Set(Object.entries(secrets ?? {}).filter(([, v]) => v).map(([, v]) => String(v)));
  const knownEnvs = [
    ...new Map(providers.filter((p) => p.keyEnv).map((p) => [p.keyEnv, { env: p.keyEnv, provider: p.id, label: p.label }])).values(),
    { env: 'HF_TOKEN', provider: '', label: 'HuggingFace' }
  ];

  const overrides = new Map(items.map((it) => [Number(it.index), it]));
  // 手动指定的环境变量只能是目录里已知的那些：以前 `items[].env` 原样收下，
  // 等于允许往 secrets.json 里塞任意键（AWS_SECRET_ACCESS_KEY、PATH…），
  // 前端下拉本来就只给这些选项，收紧不会影响正常用法。
  const envAllowed = new Set(knownEnvs.map((e) => e.env));
  const ENV_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
  const report = [];
  const lines = String(text ?? '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const item = classifyImportLine(lines[i], providers, knownEnvs);
    if (!item) continue;
    const over = overrides.get(i);
    if (over) {
      if (over.provider) item.provider = String(over.provider);
      if (over.env) {
        const wanted = String(over.env).trim();
        if (envAllowed.has(wanted)) item.env = wanted;
        else item.reason = `${item.reason ? `${item.reason}；` : ''}忽略未知环境变量 ${wanted.slice(0, 64)}`;
      }
      const hit = providers.find((p) => p.id === item.provider);
      if (hit && !over.env) item.env = hit.keyEnv ?? '';
      item.confidence = 'manual';
      // 手动指定会盖掉自动判定的理由，但「环境变量被拒」这条必须留住给用户看
      item.reason = item.reason.startsWith('忽略未知环境变量') ? item.reason : '手动指定';
    }
    if (item.key && existing.has(item.key)) {
      item.dup = true;
      item.reason = item.reason ? `${item.reason}；key 已存在，不重复入库` : 'key 已存在，不重复入库';
    }
    report.push({ index: i, ...item, key: undefined, keyMasked: item.key ? maskKey(item.key) : '', _raw: apply ? item.key : undefined });
  }

  let written = 0;
  if (apply) {
    for (const item of report) {
      if (!item._raw || item.dup || !item.env) continue;
      // 兜底：即使分类器将来新增了别的来源，也只写合法的环境变量名。
      if (!ENV_NAME_RE.test(String(item.env))) continue;
      secrets[item.env] = item._raw;
      existing.add(item._raw);
      written += 1;
      pushLog(`批量导入：${item.env} ← ${item.keyMasked}${item.provider ? `（${item.provider}）` : ''}`, 'sys', 'app');
    }
    if (written) writeJson(secretsFile(), secrets);
  }
  return {
    ok: true,
    applied: written,
    knownEnvs,
    report: report.map(({ _raw, ...rest }) => rest)
  };
}

/**
 * `/api/raw` 的结构校验：只拦「写进去必定坏掉」的形状，不做完整 schema。
 * 目的不是限制手改（多一个键、少一个键都允许），而是挡住 `null`、数组、
 * 以及把 `secrets` 写成对象数组这类会让读取方直接抛错的输入。
 * @returns {string} 空串 = 通过；非空 = 人话原因
 */
function rawFileShapeError(which, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return '顶层必须是 JSON 对象（不能是 null / 数组 / 字符串 / 数字）';
  }
  const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
  if (which === 'secrets') {
    for (const [k, v] of Object.entries(value)) {
      if (typeof v !== 'string') return `secrets 里的 ${k} 必须是字符串（现在是 ${Array.isArray(v) ? 'array' : typeof v}）`;
    }
  }
  if (which === 'models') {
    for (const k of ['free', 'paid']) {
      if (k in value && !Array.isArray(value[k])) return `models 里的 ${k} 必须是数组`;
    }
  }
  if (which === 'config') {
    for (const k of ['socialV2', 'platforms', 'commands', 'events', 'computerTools', 'snowluma']) {
      if (k in value && !isPlainObject(value[k])) return `config 里的 ${k} 必须是对象`;
    }
  }
  return '';
}

/* ══════════════════════════════════════════════════════════════════════════
 * 四、HTTP
 * ══════════════════════════════════════════════════════════════════════════ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function sendJson(res, data, status = 200) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(JSON.stringify(data));
}

/** 默认请求体上限。上传大文件走的是 saveRawBody（自己有 512 MB 上限），不经过这里。 */
const BODY_MAX_BYTES = 8 * 1024 * 1024;

async function readBody(req, maxBytes = BODY_MAX_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    // 没有上限时，一个超大 body 会整个拼进内存：本机任意进程（或浏览器里的网页）
    // 都能把应用撑爆。JSON 端点的正常报文远小于 8 MB。
    if (size > maxBytes) throw new Error(`请求体太大（上限 ${Math.round(maxBytes / 1024 / 1024)} MB）`);
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('请求体不是合法 JSON');
  }
}

/**
 * 同源闸门：只挡住「浏览器里的别的网页」，不挡本机程序。
 *
 * 为什么必须有：服务只绑 127.0.0.1，但这不等于安全 —— 浏览器里任意网页都能
 * 往 127.0.0.1 发 POST，而且 `content-type: text/plain` 属于「简单请求」，
 * 不触发 CORS 预检，响应读不到也无所谓（副作用已经发生了）。`/api/plugins/add`
 * 会把 body 里的 JS 写进 plugins/ 并立刻热重载进桥接进程 —— 网页点一下就等于
 * 在本机执行任意代码。`/api/raw`、`/api/bridge/*` 同理。
 *
 * 规则（只对非 GET/HEAD/OPTIONS 生效）：
 *  1. Host 必须是回环地址（顺带挡掉 DNS rebinding：evil.com 解析到 127.0.0.1 时
 *     Host 头仍是 evil.com）。
 *  2. 带了 Origin 就必须是本服务的源（协议 + 回环主机 + 同一端口）。
 *  3. Sec-Fetch-Site 明确是 cross-site / same-site 一律拒。
 * 不带 Origin 的请求照旧放行 —— curl、脚本、入站 webhook（/hook/notify/…）
 * 都属于这一类，它们本来就没有同源概念。
 *
 * @returns {string} 空串 = 放行；非空 = 拒绝原因
 */
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\]|::1)(?::(\d{1,5}))?$/i;

function sameOriginBlocked(req) {
  const method = String(req.method ?? 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return '';

  const host = String(req.headers.host ?? '');
  const hm = LOOPBACK_HOST.exec(host);
  if (!hm) return '只接受本机回环地址的请求（Host 不是 127.0.0.1 / localhost）';
  const hostPort = hm[2] ?? '';

  const origin = req.headers.origin;
  if (origin) {
    let o;
    try {
      o = new URL(String(origin));
    } catch {
      // Origin: null（file:// 页面、沙箱 iframe）也走这里
      return 'Origin 不合法，已拒绝';
    }
    const name = o.hostname.toLowerCase();
    const loop = name === '127.0.0.1' || name === 'localhost' || name === '::1' || name === '[::1]';
    if (!loop) return '跨站请求已拒绝（Origin 不是本机页面）';
    if (hostPort && o.port && o.port !== hostPort) return '跨站请求已拒绝（Origin 端口不匹配）';
  }

  const site = String(req.headers['sec-fetch-site'] ?? '').toLowerCase();
  if (site === 'cross-site' || site === 'same-site') return `跨站请求已拒绝（Sec-Fetch-Site: ${site}）`;
  return '';
}

/**
 * 把请求体原样落盘（收 zip 用）。
 *
 * 不用 readBody：那个是按 JSON 解析的，而且把整个 body 拼进内存 ——
 * 200 MB 的包会撑到 400 MB 峰值。这里边收边写。
 */
async function saveRawBody(req, dest, maxBytes = 512 * 1024 * 1024) {
  const out = fs.createWriteStream(dest);
  let size = 0;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxBytes) throw new Error('文件太大（上限 512 MB）');
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
    }
    await new Promise((r) => out.end(r));
  } catch (error) {
    out.destroy();
    fs.rmSync(dest, { force: true });
    throw error;
  }
  if (!size) {
    fs.rmSync(dest, { force: true });
    throw new Error('没收到文件内容');
  }
  return size;
}

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const file = path.join(PUBLIC, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!file.startsWith(PUBLIC)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  // 必须显式 no-store：这些文件就在本机、改完就该立刻看到。
  // 不带缓存头时 Chromium 会自己猜一份缓存，结果改完界面一点没变（踩过）。
  res.writeHead(200, {
    'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
    'cache-control': 'no-store, must-revalidate',
    pragma: 'no-cache',
    expires: '0'
  });
  fs.createReadStream(file).pipe(res);
}

/* ══════════════════════════════════════════════════════════════════════════
 * "本机能用什么" —— 两条非 模型 API 后端的本地探测
 *
 * 为什么要在服务端做：浏览器探测不了端口，也读不了 PATH。
 * 探测结果给前端渲染成"本机示例"，点一下就把地址/驱动填好。
 * ══════════════════════════════════════════════════════════════════════════ */

/** 常见本地推理服务的默认端口。顺序就是展示顺序。 */
const LOCAL_MODEL_SERVERS = [
  { id: 'ollama', label: 'Ollama', port: 11434 },
  { id: 'lmstudio', label: 'LM Studio', port: 1234 },
  { id: 'vllm', label: 'vLLM', port: 8000 },
  // llama-server 的默认端口是 8080，和 vLLM 的 8000 不是一回事。
  // 0.5.5 之前只有 8000 一项，装 llama.cpp 的用户永远探测不到自己的模型。
  { id: 'llamacpp', label: 'llama.cpp', port: 8080 },
  { id: 'jan', label: 'Jan', port: 1337 }
];

/** 本机装没装（不要求正在跑）。只查常见目录，不扫全盘。 */
function localServerInstalled(id) {
  const local = process.env.LOCALAPPDATA ?? '';
  const candidates = {
    ollama: [path.join(local, 'Programs', 'Ollama', 'ollama.exe'), path.join(local, 'Programs', 'Ollama', 'ollama app.exe')],
    lmstudio: [path.join(local, 'Programs', 'LM Studio', 'LM Studio.exe')],
    vllm: [],
    jan: [path.join(local, 'Programs', 'Jan', 'Jan.exe')]
  }[id] ?? [];
  return candidates.some((p) => fs.existsSync(p));
}

/** 200ms 内连上就算在跑 —— 本地端口，慢了就是没开。 */
function probeLocalPort(port, timeoutMs = 350) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const done = (ok) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

let localCache = { at: 0, value: null };

async function detectLocalModelServers() {
  // 2 秒内复用上次结果：/api/state 会被前端反复拉
  if (localCache.value && Date.now() - localCache.at < 2000) return localCache.value;

  const value = [];
  for (const s of LOCAL_MODEL_SERVERS) {
    const installed = localServerInstalled(s.id);
    const running = await probeLocalPort(s.port);
    let models = [];
    if (running) {
      try {
        const res = await fetch(`http://127.0.0.1:${s.port}/v1/models`, { signal: AbortSignal.timeout(1500) });
        if (res.ok) {
          const json = await res.json();
          models = (json.data ?? json.models ?? [])
            .map((m) => String(m.id ?? m.name ?? m.model ?? ''))
            .filter(Boolean)
            .slice(0, 60);
        }
      } catch {
        /* 有些服务不实现 /v1/models，能连上就算可用 */
      }
    }
    value.push({
      id: s.id,
      label: s.label,
      baseUrl: `http://127.0.0.1:${s.port}/v1`,
      port: s.port,
      installed,
      running,
      models
    });
  }
  localCache = { at: Date.now(), value };
  return value;
}

/** 本机模型列表里混着的 embedding 模型不能拿去聊天。 */
function looksLikeEmbeddingModel(id) {
  const text = String(id ?? '').toLowerCase();
  return text.includes('embed') || /(^|[-_/])(bge|gte|e5)([-_/]|$)/.test(text);
}

function pickChatModel(models) {
  const list = (Array.isArray(models) ? models : []).map(String).filter(Boolean);
  return list.find((m) => !looksLikeEmbeddingModel(m)) ?? list[0] ?? '';
}

let repairModelConfigInFlight = null;

/**
 * 0.5.6 迁移：把「选了本地厂商但没选模型」和「模型池里只有裸模型名」修好。
 *
 * 0.5.5 的真实事故：
 *   - config.json 里 chat 只写了 provider=lmstudio，没有 model；
 *   - models.json 的 free 只有 `qwen3.5-4b-...`，没有 `lmstudio/` 前缀；
 *   - 桥接在 ModelChain 构造时抛错，exit 1，桌面端每 5 秒重启一次。
 *
 * 这里在拉起桥接/微信之前做一次幂等修复：只补空值、只给裸模型名加前缀，
 * 不动用户已经写好的 provider/model，也不碰密钥。
 */
async function repairModelConfiguration() {
  if (repairModelConfigInFlight) return repairModelConfigInFlight;
  repairModelConfigInFlight = (async () => {
    const changes = [];
    const servers = await detectLocalModelServers();
    const running = servers.filter((s) => s.running && s.models?.length);
    if (!running.length) return { changed: false, changes };

    const cfg = loadConfig();
    const profiles = cfg?.backend?.profiles ?? {};
    let configChanged = false;

    for (const [platform, slots] of Object.entries(profiles)) {
      if (!slots || typeof slots !== 'object') continue;
      for (const slot of ['chat', 'work']) {
        const profile = slots[slot];
        if (!profile || typeof profile !== 'object') continue;
        const provider = String(profile.provider ?? '').trim();
        if (!provider) continue;
        const server = running.find((s) => s.id === provider);
        if (!server) continue;
        if (String(profile.model ?? '').trim()) continue;
        const baseUrl = String(profile.baseUrl ?? '').trim();
        // 用户把本地厂商指到了别的端口/地址时不猜，避免把模型填到错的实例上。
        if (baseUrl && !baseUrl.includes(`:${server.port}`)) continue;
        const model = pickChatModel(server.models);
        if (!model) continue;
        profile.model = model;
        if (!baseUrl) profile.baseUrl = server.baseUrl;
        configChanged = true;
        changes.push(`${platform}.${slot} 补上模型 ${provider}/${model}`);
      }
    }

    if (configChanged) {
      writeJson(configFile(), cfg);
      pushLog(`已自动补全本地模型：${changes.join('；')}`, 'sys', 'models');
    }

    // 模型池里的裸模型名：优先按 profile 里的同款模型补 provider，
    // 其次按本机实际模型列表反查。补不了的留给桥接跳过并告警，不再崩。
    const pool = loadPool();
    const providerByModel = new Map();
    for (const server of running) {
      for (const model of server.models) {
        if (!providerByModel.has(model)) providerByModel.set(model, server.id);
      }
    }
    let poolChanged = false;
    const fixList = (list) =>
      (Array.isArray(list) ? list : []).map((entry) => {
        if (typeof entry !== 'string') return entry;
        const id = entry.trim();
        if (!id || id.includes('/')) return entry;
        let provider = '';
        for (const slots of Object.values(profiles)) {
          for (const slot of ['chat', 'work']) {
            const profile = slots?.[slot];
            if (profile && String(profile.provider ?? '').trim() && String(profile.model ?? '').trim() === id) {
              provider = String(profile.provider).trim();
              break;
            }
          }
          if (provider) break;
        }
        provider = provider || providerByModel.get(id) || '';
        if (!provider) return entry;
        poolChanged = true;
        changes.push(`模型池 ${id} → ${provider}/${id}`);
        return `${provider}/${id}`;
      });

    pool.free = fixList(pool.free);
    pool.paid = fixList(pool.paid);
    if (poolChanged) {
      writeJson(modelsFile(), pool);
      pushLog(`已自动补全模型池：${changes.filter((x) => x.startsWith('模型池')).join('；')}`, 'sys', 'models');
    }

    if (configChanged || poolChanged) {
      const regen = await regenerateConfig();
      if (!regen.ok) {
        pushLog(`⚠️ 自动补全后重新生成 opencode.json 失败：${regen.lines.slice(-3).join(' / ') || '看日志'}`, 'err', 'models');
      }
    }
    return { changed: configChanged || poolChanged, changes };
  })();
  try {
    return await repairModelConfigInFlight;
  } finally {
    repairModelConfigInFlight = null;
  }
}

/** 这个 driver 现在能不能直接 spawn（PATH 或 driver 自带的常见路径）。 */
function cliAvailability(driver) {
  const found = resolveBin(driver.bin);
  if (found) return { installed: true, path: found.command };
  for (const candidate of driver.binFallbacks ?? []) {
    const hit = resolveBin(candidate);
    if (hit) return { installed: true, path: hit.command };
  }
  return { installed: false, path: null };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  const p = url.pathname;

  try {
    // 先过同源闸门：任何会改状态的请求都不能由「浏览器里的别的网页」发起。
    // 只绑 127.0.0.1 挡不住这种请求（简单请求不预检），详见 sameOriginBlocked。
    const crossSite = sameOriginBlocked(req);
    if (crossSite) return sendJson(res, { ok: false, error: crossSite }, 403);

    if (p === '/api/state') {
      const config = loadConfig();
      const n = napcatSettings();
      const napcatReachable = n.dir ? await probePort(n.wsPort) : false;
      return sendJson(res, {
        backend: config.backend ?? null,
        computerTools: config.computerTools ?? null,
        pool: (() => { const p = loadPool(); return { enabled: p.enabled !== false, free: (p.free ?? []).length, paid: (p.paid ?? []).length }; })(),
        bridge: bridgeState(),
        wechat: wechatState(),
        qqOfficial: qqOfficialState(),
        napcat: {
          reachable: napcatReachable,
          port: n.wsPort,
          dir: n.dir,
          qq: n.qq,
          exe: n.exe,
          bundled: n.bundled,
          // 有面板地址时前端才显示「打开 NapCat 面板」按钮
          panel: napcatPanel(),
          // 多号：每个号的运行状态、端口、面板地址
          accounts: napcatAccountsState()
        },
        secrets: secretPresence(),
        providers: listProviders(),
        cliDrivers: Object.values(DRIVERS).map((d) => ({
          id: d.id,
          label: d.label,
          bin: d.bin,
          verified: d.verified,
          promptVia: d.promptVia ?? 'stdin',
          optionsSchema: d.optionsSchema ?? [],
          ...cliAvailability(d)
        })),
        unverifiedClis: UNVERIFIED,
        // 本机在跑/装了的模型服务：前端拿它当"示例"，点一下把地址填好
        localModelServers: await detectLocalModelServers(),
        configPath: configFile(),
        secretsPath: secretsFile(),
        modelsPath: modelsFile(),
        projectRoot: dataRoot(),
        settingsPath: SETTINGS_FILE,
        // 后端这块前端要显示「实例在不在」，只读注册文件，不碰它。
        // 0.5.5 起 QQ / 微信各一个实例，instances 里分别给出。
        matrix: ocInstances(),
        updates: (() => {
          const s = readJson(SETTINGS_FILE);
          return {
            app: { found: s.app?.lastUpdateFound ?? '', reminded: s.app?.lastReminded ?? '', lastCheck: s.app?.lastUpdateCheck ?? 0, error: s.app?.lastUpdateError ?? '' },
            napcat: { found: s.napcat?.lastUpdateFound ?? '', reminded: s.napcat?.lastReminded ?? '' }
          };
        })(),
        automation: { ...loadAutomation(), autostart: autostartState() },
        bootAt: BOOT_AT,
        // 四档模型配置原样带出去，前端「当前状态」页据此判断哪档可用
        modelSlots: readModelProfiles(),
        // 真正在跑的是模型池（桥接走 oc-server，不读 modelSlots）。
        // 两档都没配时，状态页得能说清「靠池子顶着」，而不是干巴巴一句「未配置」。
        pool: (() => {
          const p = loadPool();
          return {
            enabled: p.enabled !== false,
            free: (p.free ?? []).length,
            paid: p.allowPaid ? (p.paid ?? []).length : 0
          };
        })(),
        chatOnly: config.socialV2?.chatOnly === true,
        version: APP_VERSION
      });
    }

    if (p === '/api/settings') {
      if (req.method === 'GET') {
        return sendJson(res, {
          bridgeRoot: getRoot(),
          defaultRoot: DEFAULT_ROOT,
          napcat: napcatSettings(),
          app: appSettings()
        });
      }
      const body = await readBody(req);
      const current = readJson(SETTINGS_FILE);
      if ('bridgeRoot' in body) {
        const bridgeRoot = String(body.bridgeRoot ?? '').trim();
        const pathError = validateDirectoryPath(bridgeRoot, '桥接目录');
        if (pathError) return sendJson(res, { ok: false, error: pathError });
        current.bridgeRoot = bridgeRoot;
      }
      if ('napcat' in body) {
        const napcat = { ...(current.napcat ?? {}), ...(body.napcat ?? {}) };
        if (body.napcat && typeof body.napcat === 'object' && 'dir' in body.napcat) {
          const pathError = validateDirectoryPath(napcat.dir, 'NapCat 目录');
          if (pathError) return sendJson(res, { ok: false, error: pathError });
        }
        for (const key of ['wsPort', 'httpPort']) {
          const raw = napcat[key];
          if (raw === '' || raw == null) continue;
          const port = Number(raw);
          if (!Number.isInteger(port) || port < 1024 || port > 65535) {
            return sendJson(res, { ok: false, error: `${key === 'wsPort' ? 'WebSocket' : 'HTTP'} 端口要是 1024-65535 之间的整数` });
          }
        }
        const wsPort = napcat.wsPort === '' || napcat.wsPort == null ? 3001 : Number(napcat.wsPort);
        const httpPort = napcat.httpPort === '' || napcat.httpPort == null ? 3000 : Number(napcat.httpPort);
        if (wsPort === httpPort) return sendJson(res, { ok: false, error: 'NapCat 的 WebSocket 与 HTTP 端口不能相同' });
        // 空串 = "用默认值"。删掉键而不是存空串 —— 否则 settings.json 里会留一堆
        // `"wsPort": ""` 这种键，看着像配了个空端口，实际又回落默认，很误导。
        for (const [k, v] of Object.entries(napcat)) {
          if (v === '' || v == null) delete napcat[k];
        }
        current.napcat = napcat;
      }
      if ('app' in body) {
        const app = { ...(current.app ?? {}), ...(body.app ?? {}) };
        for (const [k, v] of Object.entries(app)) {
          if (v === '' || v == null) delete app[k];
        }
        current.app = app;
      }
      writeJson(SETTINGS_FILE, current);
      return sendJson(res, { ok: true, bridgeRoot: getRoot(), napcat: napcatSettings(), app: appSettings() });
    }

    /* ── 模型 API 实例 / 会话设置 ─────────────────────── */

    if (p === '/api/bots/apply') {
      if (req.method !== 'POST') return sendJson(res, { ok: false, error: '只支持 POST' }, 405);
      const platform = url.searchParams.get('platform') === 'wechat' ? 'wechat' : 'qq';
      const applied = await restartBotsFor(platform);
      return sendJson(res, { ok: true, platform, applied });
    }

    if (p === '/api/matrix') {
      /* 「默认方案」和「会话标题」跟着平台走 —— 微信的会话不该叫「QQ 聊天」。
       * 0.5.5 起实例目录也按平台分开：QQ 继续用 matrix.stateDir，微信用
       * matrix.wechatStateDir；会话目录同理，微信写 platforms.wechat.sessionCwd。 */
      const platform = url.searchParams.get('platform') === 'wechat' ? 'wechat' : 'qq';
      const stateDirKey = platform === 'wechat' ? 'wechatStateDir' : 'stateDir';

      if (req.method === 'GET') {
        const cfg = loadConfig();
        const wx = cfg.platforms?.wechat ?? {};
        return sendJson(res, {
          platform,
          baseUrl: cfg.matrix?.baseUrl ?? '',
          stateDir: cfg.matrix?.[stateDirKey] ?? '',
          deleteArchived: cfg.matrix?.deleteArchived === true,
          sessionCwd: platform === 'wechat' ? wx.sessionCwd ?? '' : cfg.sessionCwd ?? '',
          // 微信没单独选过就跟着全局走，不会因为漏配而变成空值
          agentPreset: (platform === 'wechat' ? wx.agentPreset : null) ?? cfg.agentPreset ?? 'qq-chat',
          workspaceTitle:
            (platform === 'wechat' ? wx.workspaceTitle : cfg.workspaceTitle) ?? '',
          instance: ocInstance(platform),
          instances: ocInstances().instances
        });
      }
      const body = await readBody(req);
      const cfg = loadConfig();
      const stateDirInput = String(body.stateDir ?? '').trim();
      const stateDir = stateDirInput ? path.resolve(dataRoot(), stateDirInput) : '';
      const stateDirError = validateDirectoryPath(stateDir, '模型实例数据目录', { create: true });
      if (stateDirError) return sendJson(res, { ok: false, error: stateDirError });
      let sessionCwd = '';
      if ('sessionCwd' in body) {
        const sessionCwdInput = String(body.sessionCwd ?? '').trim();
        sessionCwd = sessionCwdInput ? path.resolve(dataRoot(), sessionCwdInput) : '';
        const sessionCwdError = validateDirectoryPath(sessionCwd, '会话工作目录');
        if (sessionCwdError) return sendJson(res, { ok: false, error: sessionCwdError });
        // 微信实例的 opencode.json 在 `.oc/wechat`，会话目录跑出这个根就会
        // 把根目录 QQ 的 opencode.json 也合并进来，模型/服务商串台。
        if (platform === 'wechat' && sessionCwd) {
          const base = path.join(dataRoot(), '.oc', 'wechat');
          const relative = path.relative(base, sessionCwd);
          if (relative.startsWith('..') || path.isAbsolute(relative)) {
            return sendJson(res, { ok: false, error: '微信会话目录必须在 .oc/wechat 内（否则会读到 QQ 的配置）' });
          }
        }
      }
      const oldPreset = platform === 'wechat' ? cfg.platforms?.wechat?.agentPreset : cfg.agentPreset;
      cfg.matrix = {
        ...(cfg.matrix ?? {}),
        baseUrl: String(body.baseUrl ?? '').trim(),
        [stateDirKey]: stateDir,
        deleteArchived: body.deleteArchived === true
      };

      const preset = 'agentPreset' in body ? body.agentPreset : undefined;
      const title = 'workspaceTitle' in body ? String(body.workspaceTitle ?? '').trim() : undefined;
      if (platform === 'wechat') {
        cfg.platforms = {
          ...(cfg.platforms ?? {}),
          wechat: {
            ...(cfg.platforms?.wechat ?? {}),
            ...('sessionCwd' in body ? { sessionCwd } : {}),
            ...(preset !== undefined ? { agentPreset: preset } : {}),
            ...(title !== undefined ? { workspaceTitle: title } : {})
          }
        };
      } else {
        if ('sessionCwd' in body) cfg.sessionCwd = sessionCwd;
        if (preset !== undefined) cfg.agentPreset = preset;
        if (title !== undefined) cfg.workspaceTitle = title;
      }
      writeJson(configFile(), cfg);
      const presetChanged = preset !== undefined && String(preset) !== String(oldPreset ?? '');
      let regenOk = true;
      if (presetChanged) regenOk = (await regenerateConfig()).ok;
      const applied = url.searchParams.get('deferRestart') === '1' ? false : await restartBotsFor(platform);
      return sendJson(res, { ok: true, platform, applied, configRegenerated: regenOk });
    }

    /* ── 模型池 ───────────────────────────────────────── */

    if (p === '/api/model-pool' || p === '/api/model-pool/restore' || p === '/api/model-pool/discard') {
      if (p === '/api/model-pool' && req.method === 'GET') {
        const pool = loadPool();
        // 只读接口不偷偷改文件：把坏条目原样带出去，前端标红提示；
        // 真正保存时再清理（见下面 POST）。
        const invalid = (list) =>
          (Array.isArray(list) ? list : [])
            .map(String)
            .map((x) => x.trim())
            .filter((x) => {
              if (!x) return false;
              const slash = x.indexOf('/');
              return slash <= 0 || slash === x.length - 1;
            });
        const spent = spentInPool(pool);
        const visionModels = loadConfig()?.socialV2?.images?.visionModels ?? [];
        const categoryIds = [...new Set([
          ...(pool.free ?? []).map(String),
          ...(pool.paid ?? []).map(String),
          ...spent.map((item) => String(item.id))
        ])];
        const categories = Object.fromEntries(
          categoryIds.map((id) => [id, describeModelCategory(id, { visionModels })])
        );
        return sendJson(res, {
          enabled: pool.enabled !== false,
          allowPaid: pool.allowPaid === true,
          exhaustedNotice: pool.exhaustedNotice ?? '',
          free: (pool.free ?? []).map(String),
          paid: (pool.paid ?? []).map(String),
          invalid: { free: invalid(pool.free), paid: invalid(pool.paid) },
          spent,
          categories,
          usage: await readModelUsage(),
          path: modelsFile(),
          configPath: configFile()
        });
      }

      // 「废池」手动解除：清掉这个模型的熔断记录。
      // 两个实例各有自己的 model-chain.json；桥接内存里的熔断表不会回读文件，
      // 所以和「保存模型池」一样：在跑就重启对应平台的 Bot。
      if (p === '/api/model-pool/restore' && req.method === 'POST') {
        const body = await readBody(req);
        const id = String(body.id ?? '').trim();
        if (!id) return sendJson(res, { ok: false, error: '缺少模型 id' });
        const requested = url.searchParams.get('platform');
        const platforms = requested === 'wechat' || requested === 'qq' ? [requested] : ['qq', 'wechat'];
        let removed = 0;
        for (const platform of platforms) {
          const file = chainStateFile(platform);
          const d = readJson(file, null);
          if (d && Array.isArray(d.health)) {
            const before = d.health.length;
            d.health = d.health.filter((e) => baseModelId(e.key) !== baseModelId(id));
            const count = before - d.health.length;
            if (count > 0) {
              removed += count;
              writeJson(file, d);
            }
          }
        }
        let bridgeRestarted = false;
        let wechatRestarted = false;
        if (removed > 0) {
          if (bridge.child && platforms.includes('qq')) {
            bridgeRestarted = (await restartBridge()).ok === true;
          }
          if (wechat.child && platforms.includes('wechat')) {
            wechatRestarted = await restartBotsFor('wechat');
          }
        }
        return sendJson(res, {
          ok: true,
          removed,
          platforms,
          bridgeRestarted,
          wechatRestarted,
          note: removed === 0
            ? '这个模型现在不在废池里（可能已经自己冷却完了）'
            : (bridgeRestarted || wechatRestarted)
              ? '已解除，正在运行的 Bot 已重启让模型回到队列'
              : '已解除，下次 Bot 启动时生效'
        });
      }

      if (p === '/api/model-pool/discard' && req.method === 'POST') {
        // 废池「删掉」：额度用尽的模型现在是永久坐废池（quota 熔断不过期），
        // 不要了的得能整个移走 —— 清熔断记录 + 从池里删条目 + 重新生成配置。
        const body = await readBody(req);
        const id = String(body.id ?? '').trim();
        if (!id) return sendJson(res, { ok: false, error: '缺少模型 id' });
        const requested = url.searchParams.get('platform');
        const platforms = requested === 'wechat' || requested === 'qq' ? [requested] : ['qq', 'wechat'];
        let removedFuses = 0;
        for (const platform of platforms) {
          const file = chainStateFile(platform);
          const d = readJson(file, null);
          if (d && Array.isArray(d.health)) {
            const before = d.health.length;
            d.health = d.health.filter((e) => baseModelId(e.key) !== baseModelId(id));
            const count = before - d.health.length;
            if (count > 0) {
              removedFuses += count;
              writeJson(file, d);
            }
          }
        }
        const pool = loadPool();
        const before = (pool.free ?? []).length + (pool.paid ?? []).length;
        pool.free = (pool.free ?? []).filter((e) => baseModelId(e) !== baseModelId(id));
        pool.paid = (pool.paid ?? []).filter((e) => baseModelId(e) !== baseModelId(id));
        const removedEntries = before - pool.free.length - pool.paid.length;
        if (removedEntries > 0) {
          writeJson(modelsFile(), pool);
        }
        const regen = removedEntries > 0 ? await regenerateConfig() : { ok: true };
        let bridgeRestarted = false;
        let wechatRestarted = false;
        if (bridge.child) bridgeRestarted = (await restartBridge()).ok === true;
        if (wechat.child) wechatRestarted = await restartBotsFor('wechat');
        return sendJson(res, {
          ok: true,
          removedFuses,
          removedEntries,
          regenerated: regen.ok !== false,
          bridgeRestarted,
          wechatRestarted,
          note: removedEntries > 0 ? '已从模型池删掉' : '池里没这条（只清了熔断记录）'
        });
      }

      const body = await readBody(req);
      const pool = loadPool();
      // 本机服务（LM Studio/Ollama/…）的模型没有厂商前缀，池子又只认 provider/model ——
      // 能对上探测结果的裸名就自动补上，补不上的才丢弃。
      const localServers = await detectLocalModelServers();
      const ownerOfBare = (bare) => {
        const text = String(bare ?? '').split('#')[0].trim();
        if (!text || text.includes('/')) return null;
        const running = localServers.filter((x) => x.running);
        for (const x of [...running, ...localServers]) {
          if ((x.models ?? []).some((m) => String(m).split('#')[0] === text)) return x.id;
        }
        return null;
      };
      const dropped = [];
      const clean = (v, label) => {
        const out = [];
        const seen = new Set();
        for (const raw of Array.isArray(v) ? v : []) {
          let id = String(raw ?? '').trim();
          if (!id) continue;
          // 模型池只认 provider/model。裸模型名传进 ModelChain 会抛错，
          // 0.5.5 的桥接就是被这一条带崩的 —— 所以要么补上厂商前缀，要么拒绝。
          const slash = id.indexOf('/');
          if (slash <= 0 || slash === id.length - 1) {
            const owner = ownerOfBare(id);
            if (!owner) {
              dropped.push(`${label}: ${id}`);
              continue;
            }
            const at = id.indexOf('#');
            id = at > 0 ? `${owner}/${id.slice(0, at)}${id.slice(at)}` : `${owner}/${id}`;
          }
          if (seen.has(id)) continue;
          seen.add(id);
          out.push(id);
        }
        return out;
      };

      pool.enabled = body.enabled !== false;
      pool.allowPaid = body.allowPaid === true;
      if (typeof body.exhaustedNotice === 'string') pool.exhaustedNotice = sanitizeExhaustedNotice(body.exhaustedNotice);
      pool.free = clean(body.free, '免费档');
      pool.paid = clean(body.paid, '付费档');

      const wrapped = {
        _comment: pool._comment ?? '模型池：QQ 机器人按什么顺序试模型、能不能花钱、全用完了回什么话。改这个文件不用改代码。密钥在 secrets.json（那是凭据，这是策略）。',
        _comment_free: pool._comment_free ?? '免费档，按优先级从上到下。上一个用光了（余额/无权/连不上）会自动换下一个；限流只冷却 60 秒后自动切回。',
        _comment_paid: pool._comment_paid ?? '付费档，默认不启用。allowPaid 打开后，免费档全部耗尽会自动降级到这里。',
        _comment_notice: pool._comment_notice ?? '所有候选都用完时，在群里回的这一句。',
        _comment_cooldown: pool._comment_cooldown ?? '冷却覆盖（毫秒），一般不用改。额度用完（quota）默认永久坐废池，只能手动拿回来或删掉；kind 取值：quota / rate / unavailable / auth / unreachable。',
        enabled: pool.enabled,
        allowPaid: pool.allowPaid,
        exhaustedNotice: pool.exhaustedNotice,
        free: pool.free,
        paid: pool.paid,
        cooldownMs: pool.cooldownMs ?? {}
      };
      writeJson(modelsFile(), wrapped);

      const regen = await regenerateConfig();

      // 模型链是**Bot 启动时**读进内存的，光改 opencode.json 不会换链 ——
      // 两个平台各有一份有效模型池（自定义中转站前置），所以都要重启。
      let bridgeRestarted = false;
      if (bridge.child) {
        const started = await restartBridge();
        bridgeRestarted = started.ok === true;
      }
      const wechatRestarted = wechat.child ? await restartBotsFor('wechat') : false;

      return sendJson(res, {
        ok: true,
        configRegenerated: regen.ok,
        bridgeRestarted,
        wechatRestarted,
        dropped,
        warnings: dropped.length
          ? [`已丢弃 ${dropped.length} 条不合法的模型池条目（要写成 厂商/模型）：${dropped.slice(0, 3).join('、')}${dropped.length > 3 ? '…' : ''}`]
          : [],
        lines: regen.lines.slice(-8)
      });
    }

    /* ── 设置页：schema + 批量写值 ─────────────────────── */

    /* ── 价目表 ───────────────────────────────────────── */

    /* config.json 的 pricing 是「覆盖表」：名字和内置表撞了就用这里的价，
     * 没撞就新增一条。花多少钱全靠它算 —— 换了中转模型不改这张表，
     * 花费统计会按兜底价（flash）算，静默算错。 */
    if (p === '/api/pricing') {
      const cfg = loadConfig();
      const price = cfg.pricing && typeof cfg.pricing === 'object' ? cfg.pricing : {};

      if (req.method === 'GET') {
        const models = {};
        for (const [name, entry] of Object.entries(price.models ?? {})) {
          if (!entry || typeof entry !== 'object') continue;
          const off = entry.off && typeof entry.off === 'object' ? entry.off : {};
          models[name] = {
            label: String(entry.label ?? name),
            cacheHit: Number.isFinite(Number(off.cacheHit)) ? Number(off.cacheHit) : null,
            cacheMiss: Number.isFinite(Number(off.cacheMiss)) ? Number(off.cacheMiss) : null,
            cacheWrite: Number.isFinite(Number(off.cacheWrite)) ? Number(off.cacheWrite) : null,
            output: Number.isFinite(Number(off.output)) ? Number(off.output) : null
          };
        }
        return sendJson(res, {
          ok: true,
          models,
          fallbackModel: String(price.fallbackModel ?? ''),
          peakMultiplier: Number.isFinite(Number(price.peakMultiplier)) ? Number(price.peakMultiplier) : null,
          builtin: PRICE_BUILTIN_MODELS,
          configPath: configFile()
        });
      }

      const body = await readBody(req);
      const incoming = body?.models && typeof body.models === 'object' ? body.models : {};
      const next = {};
      for (const [rawName, entry] of Object.entries(incoming)) {
        const name = String(rawName ?? '').trim();
        // 模型名就是配置里的键，空名字写进去等于一条坏数据
        if (!name || name.length > 120 || !entry || typeof entry !== 'object') continue;
        const num = (v) => {
          if (v === null || v === undefined || v === '') return null;
          const n = Number(v);
          return Number.isFinite(n) && n >= 0 ? n : null;
        };
        const off = {};
        for (const key of ['cacheHit', 'cacheMiss', 'cacheWrite', 'output']) {
          const v = num(entry[key]);
          if (v !== null) off[key] = v;
        }
        next[name] = { label: String(entry.label ?? '').trim() || name, off };
      }

      const merged = { ...(cfg.pricing ?? {}), models: next };
      const fallback = String(body?.fallbackModel ?? '').trim();
      if (fallback) merged.fallbackModel = fallback;
      else delete merged.fallbackModel;
      const peak = Number(body?.peakMultiplier);
      if (Number.isFinite(peak) && peak > 0) merged.peakMultiplier = peak;
      else delete merged.peakMultiplier;

      cfg.pricing = merged;
      writeJson(configFile(), cfg);
      // 价目表是桥接启动时读一次的，不重启的话花费还按旧价算
      return sendJson(res, { ok: true, count: Object.keys(next).length, needRestart: true });
    }

    /* ── 推理等级（全局）───────────────────────────────────────────────
     * 写 config.json 的 dsh.reasoningEffort；桥接在跑就顺手调它的
     * /api/dsh/effort 热切换（下一条消息生效），免得为了一个档位重启整条链路。
     * 取值必须和桥接的 normalizeReasoningEffort 保持一致：low / high / max。 */
    if (p === '/api/reasoning') {
      const REASONING_EFFORTS = [
        { value: 'low', label: 'low（快，想得浅）' },
        { value: 'high', label: 'high（想得深一点）' },
        { value: 'max', label: 'max（最慢最深）' }
      ];
      if (req.method === 'GET') {
        const cfg = loadConfig();
        const raw = String(cfg.dsh?.reasoningEffort ?? 'max').trim().toLowerCase();
        const effort = REASONING_EFFORTS.some((o) => o.value === raw) ? raw : 'max';
        return sendJson(res, { ok: true, effort, options: REASONING_EFFORTS });
      }

      const body = await readBody(req);
      const effort = String(body?.effort ?? '').trim().toLowerCase();
      if (!REASONING_EFFORTS.some((o) => o.value === effort)) {
        return sendJson(res, { ok: false, error: '推理等级只能是 low / high / max' }, 400);
      }
      const cfg = loadConfig();
      cfg.dsh = { ...(cfg.dsh ?? {}), reasoningEffort: effort };
      writeJson(configFile(), cfg);

      // 热切换：桥接没在跑、或版本太旧没有这个接口，都不算保存失败 ——
      // 配置已经落盘，下次启动会按新档位 selectModel。
      const applied = await pushReasoningEffort(effort);
      return sendJson(res, { ok: true, effort, applied });
    }

    if (p === '/api/options') {
      if (req.method === 'GET') {
        const cfg = loadConfig();
        const values = {};
        for (const [dotted] of OPTION_PATHS) {
          const v = deepGet(cfg, dotted);
          if (v !== undefined) values[dotted] = v;
        }
        return sendJson(res, { groups: OPTION_GROUPS, values });
      }

      const body = await readBody(req);
      const incoming = body?.values ?? {};
      const cfg = loadConfig();
      let changed = 0;
      const changedPaths = [];

      for (const [dotted, raw] of Object.entries(incoming)) {
        const item = OPTION_PATHS.get(dotted);
        // 只认 schema 里声明过的路径：前端传别的键一律忽略，
        // 免得一个 bug 或一次手改请求就把 config.json 写坏。
        if (!item) continue;

        const before = JSON.stringify(deepGet(cfg, dotted));
        let value = raw;

        if (raw === null || raw === '') {
          value = null; // 删键，回落默认
        } else if (item.type === 'bool') {
          value = raw === true;
        } else if (item.type === 'number') {
          const n = Number(raw);
          if (!Number.isFinite(n)) continue;
          value = n;
        } else if (item.type === 'list') {
          const arr = Array.isArray(raw) ? raw : String(raw).split(/[,，\s]+/);
          const items = arr.map((x) => String(x).trim()).filter(Boolean);
          value = item.itemType === 'number' ? items.map(Number).filter(Number.isFinite) : items;
        } else {
          value = String(raw);
        }

        if (JSON.stringify(value) === before) continue;
        deepSet(cfg, dotted, value);
        changed++;
        changedPaths.push(dotted);
      }

      if (changed) writeJson(configFile(), cfg);

      // 高级页也有一份「思考强度」。在那边改的时候同样热切换，
      // 否则两个入口一个立刻生效、一个要等重启，最难排查。
      let reasoningApplied = null;
      if (changedPaths.includes('dsh.reasoningEffort')) {
        reasoningApplied = await pushReasoningEffort(String(deepGet(cfg, 'dsh.reasoningEffort')));
      }

      // chatOnly 决定 opencode.json 里的工具面（权限表 + MCP 注册 + 人设正文）。
      // 只写 config.json 不重跑生成器的话，模型那边看到的还是旧工具表 ——
      // 界面上开关变了、实际行为没变，最难查。桥接也要重启：
      // 唤醒提示词（buildChatWakePromptV2）是在启动时按 cfg 决定走哪一套的。
      let configRegenerated = null;
      let bridgeRestarted = false;
      if (changedPaths.includes('socialV2.chatOnly')) {
        configRegenerated = await regenerateConfig();
        if (bridge.child) {
          bridgeRestarted = (await restartBridge()).ok === true;
        }
      }

      return sendJson(res, {
        ok: true,
        changed,
        configRegenerated: configRegenerated ? configRegenerated.ok : null,
        bridgeRestarted,
        reasoningApplied
      });
    }

    if (p === '/api/up') {
      const body = await readBody(req);
      return sendJson(res, await bringUp(body.scope));
    }
    if (p === '/api/down') {
      const body = await readBody(req);
      return sendJson(res, bringDown(body.scope));
    }
    if (p === '/api/wechat/start') {
      const body = await readBody(req).catch(() => ({}));
      try {
        await repairModelConfiguration();
      } catch (error) {
        pushLog(`模型配置自动修复失败（继续启动微信）：${error?.message ?? error}`, 'err', 'models');
      }
      return sendJson(res, startWechat(body.account));
    }
    if (p === '/api/bots/start') {
      const body = await readBody(req);
      return sendJson(res, await startBotFlow(body?.platform === 'wechat' ? 'wechat' : 'qq'));
    }
    if (p === '/api/wechat/stop') {
      const body = await readBody(req).catch(() => ({}));
      return sendJson(res, stopWechat(body.account));
    }

    if (p === '/api/wechat/accounts') {
      // 微信多账号清单：add 添下一个 wxN（上限 10），remove 收掉一个（wx1 是默认号不可删）
      if (req.method === 'GET') return sendJson(res, { ok: true, accounts: wechatAccountsList() });
      const body = await readBody(req);
      const cfg = loadConfig();
      const list = wechatAccountsList(cfg);
      if (body.action === 'add') {
        if (list.length >= 10) return sendJson(res, { ok: false, error: '最多 10 个微信账号' });
        const next = `wx${list.length + 1}`;
        const merged = [...list, next];
        cfg.platforms = { ...(cfg.platforms ?? {}), wechat: { ...(cfg.platforms?.wechat ?? {}), accounts: merged } };
        writeJson(configFile(), cfg);
        return sendJson(res, { ok: true, accounts: merged, added: next });
      }
      if (body.action === 'remove') {
        const id = String(body.id ?? '').trim();
        if (id === 'wx1') return sendJson(res, { ok: false, error: 'wx1 是默认账号，不能删（可以不启动它）' });
        if (!list.includes(id)) return sendJson(res, { ok: false, error: '没有这个账号' });
        const stopped = stopWechat(id);
        await Promise.resolve(stopped?.done ?? null);
        const idx = list.indexOf(id);
        const merged = list.filter((x) => x !== id).map((x, i) => `wx${i + 1}`);
        // 在跑的后位号先停：它们的状态文件马上要改名，进程挂在旧 id 上会读错文件
        const runningAfter = [];
        for (let i = idx + 1; i < list.length; i++) {
          if (wechatProcs.get(list[i])?.child || externalWechatPid(list[i])) runningAfter.push(list[i]);
        }
        for (const acc of runningAfter) {
          const st = stopWechat(acc);
          if (st?.done) await st.done;
        }
        // 先清被删号自己的状态文件（登录态/会话/二维码/锁）；id 不是 wx1，一定带后缀
        for (const name of [`wechat-${id}-token.json`, `wechat-${id}-sessions.json`, `wechat-${id}-qr.json`, `wechat-${id}.lock`]) {
          try { fs.rmSync(path.join(dataRoot(), 'state', name), { force: true }); } catch { /* 删不动就算了 */ }
        }
        // 剩下的号收敛回 wx1..wxN 连号：从后往前改（先改后面的，避免链式覆盖）
        for (let i = list.length - 1; i > idx; i--) {
          const from = list[i];
          const to = merged[i - 1];
          if (!to || from === to) continue;
          for (const kind of ['token', 'sessions', 'qr']) {
            const sufFrom = from === 'wx1' ? '' : `-${from}`;
            const sufTo = to === 'wx1' ? '' : `-${to}`;
            const src = path.join(dataRoot(), 'state', `wechat${sufFrom}-${kind}.json`);
            const dst = path.join(dataRoot(), 'state', `wechat${sufTo}-${kind}.json`);
            try {
              if (fs.existsSync(src)) {
                if (fs.existsSync(dst)) fs.rmSync(dst, { force: true }); // Windows 的 rename 不吃覆盖
                fs.renameSync(src, dst);
              }
            } catch { /* 改不动就算了 */ }
          }
        }
        cfg.platforms = { ...(cfg.platforms ?? {}), wechat: { ...(cfg.platforms?.wechat ?? {}), accounts: merged } };
        writeJson(configFile(), cfg);
        pushLog(`微信账号 ${id} 已移除，剩余 ${merged.length} 个`, 'sys', 'wechat');
        // 移位前在跑的号，按新 id 拉回来（登录态文件已改名，无缝继续）
        for (const old of runningAfter) startWechat(merged[list.indexOf(old) - 1]);
        return sendJson(res, { ok: true, accounts: merged });
      }
      return sendJson(res, { ok: false, error: 'action 要是 add 或 remove' });
    }

    if (p === '/api/qq-official') {
      if (req.method === 'GET') return sendJson(res, { ok: true, ...qqOfficialState() });
      const body = await readBody(req);
      if (body.action === 'start') return sendJson(res, startQqOfficial(body.appId));
      if (body.action === 'stop') return sendJson(res, stopQqOfficial(body.appId));

      const cfg = loadConfig();
      // 多号配置：bots 数组。第一次保存时把旧单号字段迁进去、旧字段删掉（单一事实源）。
      if (body.action === 'delete') {
        const appId = String(body.appId ?? '').trim();
        const bots = qqOfficialBotList(cfg).filter((b) => b.appId !== appId);
        if (bots.length === qqOfficialBotList(cfg).length) return sendJson(res, { ok: false, error: '配置里没有这个号' });
        const stopped = stopQqOfficial(appId);
        await Promise.resolve(stopped?.done ?? null);
        cfg.qqOfficial = { ...(cfg.qqOfficial ?? {}), bots };
        delete cfg.qqOfficial.appId;
        delete cfg.qqOfficial.appSecret;
        delete cfg.qqOfficial.enabled;
        writeJson(configFile(), cfg);
        pushLog(`官方机器人 ${appId.slice(0, 4)}… 已删除`, 'sys', 'qqofficial');
        return sendJson(res, { ok: true, ...qqOfficialState() });
      }

      // save / upsert：{appId, appSecret?, enabled, name?}
      const appId = String(body.appId ?? '').trim();
      if (!/^\d{6,15}$/.test(appId)) return sendJson(res, { ok: false, error: 'AppID 应该是一串数字（开放平台管理端的那份）' });
      const bots = qqOfficialBotList(cfg);
      const hit = bots.find((b) => b.appId === appId);
      const name = body.name !== undefined ? String(body.name).trim() : hit?.name;
      const enabled = body.enabled === undefined ? (hit?.enabled ?? true) : body.enabled === true;
      const appSecret = body.appSecret !== undefined ? String(body.appSecret).trim() : (hit?.appSecret ?? '');
      if (!appSecret) return sendJson(res, { ok: false, error: 'AppSecret 没填（新号要填一次，改密钥时填新的）' });
      if (hit) Object.assign(hit, { name: name || hit.name, enabled, appSecret });
      else bots.push({ appId, name: name || `机器人 ${bots.length + 1}`, enabled, appSecret });
      if (enabled !== true) {
        const stopped = stopQqOfficial(appId);
        await Promise.resolve(stopped?.done ?? null);
      }
      cfg.qqOfficial = { ...(cfg.qqOfficial ?? {}), bots };
      delete cfg.qqOfficial.appId;
      delete cfg.qqOfficial.appSecret;
      delete cfg.qqOfficial.enabled;
      writeJson(configFile(), cfg);
      pushLog(`官方机器人「${name || appId.slice(0, 4) + '…'}」配置已保存（${enabled ? '启用' : '停用'}）`, 'sys', 'qqofficial');
      const started = enabled ? startQqOfficial(appId) : null;
      return sendJson(res, { ok: true, ...qqOfficialState(), startedOk: started ? started.ok : null });
    }

    if (p === '/api/config') {
      if (req.method === 'GET') return sendJson(res, loadConfig());
      const body = await readBody(req);
      const config = loadConfig();
      Object.assign(config, body);
      writeJson(configFile(), config);
      return sendJson(res, { ok: true });
    }

    if (p === '/api/chat') {
      /* 平台分开存。
       *
       * QQ 仍然用 config.json 顶层那几个键 —— 桥接读的就是它们，一个字都不能动，
       * 否则老配置立刻失效。微信存进 config.platforms.wechat，明天接官方协议时
       * 直接读这一块，不用把老配置搬家，两边也不会互相覆盖。
       * 前端传 ?platform=wechat 就切到微信那一份，不传就是 QQ（默认）。 */
      const platform = url.searchParams.get('platform') === 'wechat' ? 'wechat' : 'qq';
      const sectionOf = (cfg) => (platform === 'wechat' ? (cfg.platforms?.wechat ?? {}) : cfg);

      if (req.method === 'GET') {
        const config = loadConfig();
        const scope = sectionOf(config);
        const list = (v) => [...new Set((Array.isArray(v) ? v : []).map((x) => String(x).trim()).filter(Boolean))];
        const allow = { private: list(scope.allow?.private), groups: list(scope.allow?.groups) };
        const deny = { private: list(scope.deny?.private), groups: list(scope.deny?.groups) };

        // 「模式」由两个地方共同决定：白名单里的 `*` 通配符，和 allowAllWhenEmpty。
        // 两套写法表达同一件事，判断散在前端就会出现"界面说只回白名单、其实谁都回"。
        // 在这里算一次，前端只认 mode。
        const wildcard = allow.private.includes('*') || allow.groups.includes('*');
        const mode = wildcard || scope.allowAllWhenEmpty === true ? 'all' : 'list';

        return sendJson(res, {
          platform,
          mode,
          // 微信那边没有 QQ 号这个概念，存的是 ownerId；前端只认 ownerQQ 一个字段
          ownerQQ: (platform === 'wechat' ? scope.ownerId : scope.ownerQQ) ?? null,
          allow,
          deny,
          allowAllWhenEmpty: scope.allowAllWhenEmpty === true,
          agentPreset: scope.agentPreset ?? config.agentPreset ?? 'qq-chat',
          maxInjectChars: scope.maxInjectChars ?? config.role?.maxInjectChars ?? 6000,
          // 角色卡注入频率：every / every3 / session（桥接读 config.role.injectMode）
          injectMode: config.role?.injectMode ?? 'session'
        });
      }

      const body = await readBody(req);
      const config = loadConfig();
      const clean = (v) => [...new Set((Array.isArray(v) ? v : []).map((x) => String(x).trim()).filter(Boolean))];
      const patch = {};

      if ('ownerQQ' in body) {
        const owner = body.ownerQQ ? String(body.ownerQQ).trim() : null;
        if (platform === 'wechat') patch.ownerId = owner;
        else patch.ownerQQ = owner;
      }

      // 存进去之前把 `*` 摘掉，统一用 allowAllWhenEmpty 表达"放行所有人"。
      // 两种写法并存时，`*` 会盖住 allowAllWhenEmpty —— 界面上把模式切到"只回白名单"
      // 却不生效，是最难查的那种 bug。
      if ('allow' in body) {
        patch.allow = {
          private: clean(body.allow?.private).filter((x) => x !== '*'),
          groups: clean(body.allow?.groups).filter((x) => x !== '*')
        };
      }
      if ('deny' in body) {
        patch.deny = {
          private: clean(body.deny?.private),
          groups: clean(body.deny?.groups)
        };
      }
      if ('allowAllWhenEmpty' in body) patch.allowAllWhenEmpty = body.allowAllWhenEmpty === true;
      if ('agentPreset' in body) patch.agentPreset = body.agentPreset;
      if ('maxInjectChars' in body || 'injectMode' in body) {
        const rolePatch = { ...(config.role ?? {}) };
        if ('maxInjectChars' in body) rolePatch.maxInjectChars = Number(body.maxInjectChars) || 6000;
        if ('injectMode' in body) {
          const mode = String(body.injectMode ?? '');
          if (['every', 'every3', 'session'].includes(mode)) rolePatch.injectMode = mode;
        }
        patch.role = rolePatch;
      }

      if (platform === 'wechat') {
        config.platforms = {
          ...(config.platforms ?? {}),
          wechat: { ...(config.platforms?.wechat ?? {}), ...patch }
        };
      } else {
        Object.assign(config, patch);
      }
      writeJson(configFile(), config);
      const applied = url.searchParams.get('deferRestart') === '1' ? false : await restartBotsFor(platform);
      return sendJson(res, { ok: true, platform, applied });
    }

    if (p === '/api/roles') {
      // 顺手把每张卡的字数带上：人格卡会随每条消息注入，超上限就被截断，
      // 界面上得能一眼看出哪张超了（roles/README.md 建议 3000~5000）。
      const dir = path.join(dataRoot(), 'roles');
      const names = fs.existsSync(dir)
        ? fs
            .readdirSync(dir)
            .filter((f) => f.endsWith('.md') && f !== 'README.md')
            .map((f) => f.replace(/\.md$/, ''))
        : [];
      const chars = {};
      for (const n of names) {
        try {
          chars[n] = fs.readFileSync(path.join(dir, `${n}.md`), 'utf8').replace(/^\uFEFF/, '').trim().length;
        } catch {
          chars[n] = 0;
        }
      }
      return sendJson(res, { ok: true, roles: names, chars, limit: roleInjectLimit() });
    }

    /* ── 人格卡内容：读一张 / 写一张 / 删一张 ───────────── */

    if (p === '/api/role/organize') {
      // 只整理、不落盘：结果回前端，用户改完再走 /api/role/file 保存
      const body = await readBody(req);
      return sendJson(res, await organizeRoleCard(body));
    }

    if (p === '/api/role/file') {
      if (req.method === 'GET') {
        try {
          const { name, file } = rolePath(url.searchParams.get('name'));
          if (!fs.existsSync(file)) return sendJson(res, { ok: false, error: `没有这张人格卡：${name}` });
          const content = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
          return sendJson(res, { ok: true, name, content, chars: content.trim().length, limit: roleInjectLimit() });
        } catch (error) {
          return sendJson(res, { ok: false, error: String(error?.message ?? error) });
        }
      }

      const body = await readBody(req);
      try {
        const { name, dir, file } = rolePath(body.name);
        const content = String(body.content ?? '');
        // 空卡等于"设了人格但什么都没说"，比不设还糟 —— 直接拒掉
        if (!content.trim()) return sendJson(res, { ok: false, error: '内容不能是空的' });
        if (content.length > ROLE_CHARS_MAX) {
          return sendJson(res, { ok: false, error: `内容太长（${content.length} 字符，上限 ${ROLE_CHARS_MAX}）` });
        }
        const existed = fs.existsSync(file);
        const backup = existed ? backupRole(file, name) : null; // 新建没什么可备份的
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, content.endsWith('\n') ? content : `${content}\n`, 'utf8');
        return sendJson(res, {
          ok: true,
          name,
          created: !existed,
          chars: content.trim().length,
          backup
        });
      } catch (error) {
        return sendJson(res, { ok: false, error: String(error?.message ?? error) });
      }
    }

    if (p === '/api/role/file/delete') {
      const body = await readBody(req);
      try {
        const { name, file } = rolePath(body.name);
        if (!fs.existsSync(file)) return sendJson(res, { ok: false, error: `没有这张人格卡：${name}` });
        // 正在启用中的卡不许删：删了桥接下一轮就找不到文件，人格静默消失，
        // 而界面上「角色」还显示着这个名字 —— 最难查的那种故障。
        const inUse = roleInUse(name);
        if (inUse.length) {
          return sendJson(res, {
            ok: false,
            error: `「${name}」正在启用中（${inUse.join(' / ')}），先在上面切到别的角色或清空，再删`
          });
        }
        const backup = backupRole(file, name);
        fs.rmSync(file, { force: true });
        return sendJson(res, { ok: true, name, backup });
      } catch (error) {
        return sendJson(res, { ok: false, error: String(error?.message ?? error) });
      }
    }

    if (p === '/api/role') {
      /* 角色**按平台分开存**：
       *   · QQ   → state/current-role.json（桥接每轮读它；桥接控制台写的是同一个文件）
       *   · 微信 → config.json 的 platforms.wechat.role（wechat-bot.js 建会话时读一次）
       *
       * 以前这里不分平台，在微信页选的角色其实写进了 QQ 那份 —— 微信那边还在用旧
       * 人格，切回 QQ 页看又确实是刚选的那个，两边都「看起来正常」，最难查。
       */
      const platform = url.searchParams.get('platform') === 'wechat' ? 'wechat' : 'qq';

      if (req.method === 'GET') {
        if (platform === 'wechat') {
          return sendJson(res, {
            platform,
            role: loadConfig().platforms?.wechat?.role ?? null,
            // 静默模式是 QQ 那份 state 里的字段（群消息不投递），微信这条链路还没有对应实现
            mode: 'active'
          });
        }
        const cur = readJson(path.join(dataRoot(), 'state', 'current-role.json'), { role: null, mode: 'active' });
        return sendJson(res, { ...cur, platform });
      }

      const body = await readBody(req);

      // 注入上限是 config.json 的 role.maxInjectChars（桥接每轮读它），两个平台共用；
      // 和 current-role.json 里那个 "role" 字段只是重名，作用完全不同。
      if ('maxInjectChars' in body) {
        const config = loadConfig();
        const n = Number(body.maxInjectChars);
        config.role = { ...(config.role ?? {}) };
        if (Number.isFinite(n) && n > 0) config.role.maxInjectChars = n;
        else delete config.role.maxInjectChars;
        writeJson(configFile(), config);
      }

      // 角色卡注入频率同样是全局项（两个平台共用同一套桥接逻辑）。
      if ('injectMode' in body) {
        const mode = String(body.injectMode ?? '');
        if (['every', 'every3', 'session'].includes(mode)) {
          const config = loadConfig();
          config.role = { ...(config.role ?? {}), injectMode: mode };
          writeJson(configFile(), config);
        }
      }

      if (platform === 'wechat') {
        const role = body.role ? String(body.role).trim() : null;
        const config = loadConfig();
        config.platforms = {
          ...(config.platforms ?? {}),
          wechat: { ...(config.platforms?.wechat ?? {}), role }
        };
        writeJson(configFile(), config);
        const applied = url.searchParams.get('deferRestart') === '1' ? false : await restartBotsFor('wechat');
        return sendJson(res, { ok: true, platform, role, applied });
      }

      const file = path.join(dataRoot(), 'state', 'current-role.json');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      writeJson(file, { role: body.role || null, mode: body.mode === 'silent' ? 'silent' : 'active' });
      const applied = url.searchParams.get('deferRestart') === '1' ? false : await restartBotsFor('qq');
      return sendJson(res, { ok: true, platform, applied });
    }

    if (p === '/api/backend') {
      const body = await readBody(req);
      const next = body.backend ?? null;
      const config = loadConfig();

      // 以前这里是无条件落盘的：手滑点一下卡片就能写进一个缺 driver 的 cli 段，
      // 下次重启桥接直接起不来。现在先验证，跑不起来的一律不写。
      if (next) {
        // 老值（2026-10 之前叫 opencode）先归一到新值，再校验 —— 否则老界面
        // 存过一次的配置在后端会变成"不认识的后端类型"。
        if (next.type === 'opencode') next.type = 'matrix';
        if (!['matrix', 'model-api', 'cli', 'ui'].includes(next.type)) {
          return sendJson(res, { ok: false, error: `不认识的后端类型 "${next.type}"` });
        }

        if (next.type === 'ui') {
          const uiCfg = next.ui ?? {};
          if (!String(uiCfg.process ?? '').trim() && !String(uiCfg.titleRegex ?? '').trim()) {
            return sendJson(res, { ok: false, error: '前台后端要配「进程名」或「窗口标题正则」至少一个' });
          }
        }

        if (next.type === 'cli') {
          const cli = next.cli ?? {};
          if (cli.customDriver) {
            if (!cli.customDriver.id || !cli.customDriver.bin) {
              return sendJson(res, { ok: false, error: '自定义驱动需要同时填「标识」和「可执行文件」' });
            }
            if (!resolveBin(cli.customDriver.bin)) {
              return sendJson(res, { ok: false, error: `找不到可执行文件：${cli.customDriver.bin}` });
            }
          } else {
            const driver = DRIVERS[cli.driver];
            if (!driver) {
              return sendJson(res, {
                ok: false,
                error: `不认识的驱动 "${cli.driver}"。可选：${Object.keys(DRIVERS).join(' / ')}`
              });
            }
            const avail = cli.bin ? (resolveBin(cli.bin) ? { installed: true } : { installed: false }) : cliAvailability(driver);
            if (!avail.installed) {
              return sendJson(res, {
                ok: false,
                error: `本机找不到 ${driver.label}（${driver.bin}）。先装它，或在「驱动参数」里指定 bin 绝对路径。`
              });
            }
          }
        }

        if (next.type === 'model-api') {
          const m = next.modelApi ?? {};
          if (!m.baseUrl || !m.model) {
            return sendJson(res, { ok: false, error: '直连模型 API 至少要填「接口地址」和「模型」' });
          }
        }
      }

      if (next) config.backend = { ...(config.backend ?? {}), ...next };
      else config.backend = null;
      writeJson(configFile(), config);
      return sendJson(res, { ok: true });
    }

    /* ── 模型配置分档：QQ / 微信 × 聊天 / 聊天+指令 ─────────────── */

    if (p === '/api/model-profiles') {
      if (req.method === 'GET') {
        return sendJson(res, { ok: true, profiles: readModelProfiles(), slots: MODEL_SLOTS });
      }

      const body = await readBody(req);
      const cfg = loadConfig();
      let incoming = body.profiles ?? {};
      if (Array.isArray(body.updates)) {
        incoming = readModelProfiles();
        for (const update of body.updates) {
          const pf = update?.platform;
          const slot = update?.slot;
          if (!MODEL_SLOTS[pf]?.includes(slot)) continue;
          if (!incoming[pf]) incoming[pf] = {};
          if (update.profile == null) delete incoming[pf][slot];
          else incoming[pf][slot] = update.profile;
        }
      }
      const profiles = {};
      const existingProfiles = cfg.backend?.profiles ?? {};
      const secrets = readJson(secretsFile(), {});
      let legacyKeyMigrated = false;

      for (const [pf, slots] of Object.entries(MODEL_SLOTS)) {
        profiles[pf] = {};
        for (const slot of slots) {
          const v = sanitizeModelProfile(incoming?.[pf]?.[slot]);
          if (v) {
            const preset = MODEL_PROVIDER_CATALOG.get(v.provider);
            const customEndpoint = !preset || preset.id === 'custom' ||
              (!NON_RELAY_PROVIDER_IDS.has(preset.id) &&
                Boolean(v.baseUrl && preset.baseUrl && v.baseUrl !== preset.baseUrl));
            if (customEndpoint) {
              v.apiKeyEnv = modelProfileKeyEnv(pf, slot);
              const old = existingProfiles?.[pf]?.[slot];
              const oldProvider = MODEL_PROVIDER_CATALOG.get(old?.provider);
              const legacyEnv = oldProvider?.keyEnv;
              if (!old?.apiKeyEnv && legacyEnv && secrets[legacyEnv] && !secrets[v.apiKeyEnv]) {
                secrets[v.apiKeyEnv] = secrets[legacyEnv];
                legacyKeyMigrated = true;
              }
            }
            else delete v.apiKeyEnv;
            profiles[pf][slot] = v;
          }
        }
      }
      if (legacyKeyMigrated) writeJson(secretsFile(), secrets);

      // 只写 profiles 就够；type 等其它字段原样保留，别把后端类型冲掉。
      const backend = { ...(cfg.backend ?? {}) };
      backend.profiles = profiles;
      // 回写旧字段：老版本桥接只认 modelApi，不同步过去会读不到配置。
      if (profiles.qq?.chat) backend.modelApi = profiles.qq.chat;
      else delete backend.modelApi;
      cfg.backend = backend;

      writeJson(configFile(), cfg);
      if (legacyKeyMigrated) {
        try {
          await reloadRunningModelServiceForSecrets();
        } catch (error) {
          pushLog(`自定义中转站旧密钥已迁移，但运行服务重载失败：${error?.message ?? error}`, 'err', 'app');
        }
      }

      // 用户预期：在「模型」面板填的模型直接进模型池首位（以后清掉档位也回落到它）。
      // 只在有 provider 名时做（自定义中转站构不成链路条目）；池里已有同款（含变体
      // 后缀）就原样挪到首位，保留 #none / #low 这类思考档位后缀。
      let poolUpdated = false;
      if (body.poolEntry) {
        const entry = String(body.poolEntry).trim();
        if (entry.includes('/')) {
          const pool = loadPool();
          const free = (pool.free ?? []).map(String);
          const same = free.find((e) => e === entry || e.split('#')[0] === entry);
          const top = same ?? entry;
          const at = free.indexOf(top);
          if (at !== 0) {
            if (at > 0) free.splice(at, 1);
            free.unshift(top);
            pool.free = free;
            if (pool.enabled === undefined) pool.enabled = true;
            writeJson(modelsFile(), pool);
            poolUpdated = true;
          }
        }
      }

      // 这份模型是 opencode.json 的输入：存完必须重新生成一次，否则界面上配好了、
      // 桥接读到的还是老配置。生成失败不回滚保存（配置已经在盘上了），
      // 但要把原因带回前端，别让人以为生效了。
      const regen = await regenerateConfig();

      // 存完即生效：正在跑的 BOT 就地重启拿新配置（不用再手动重启桥接）。
      let botsRestarted = false;
      if (regen.ok) {
        if (bridge.child) {
          botsRestarted = (await restartBridge()).ok === true;
        }
        if (wechat.child) {
          stopWechat();
          await new Promise((r) => setTimeout(r, 800));
          startWechat();
          botsRestarted = true;
        }
      }
      return sendJson(res, {
        ok: true,
        profiles,
        botsRestarted,
        poolUpdated,
        legacyKeyMigrated,
        regenerated: regen.ok,
        regenError: regen.ok ? undefined : (() => {
          const real = (regen.lines ?? []).filter((l) => l.trim() && !l.trim().startsWith('at ') && !l.includes('node:internal'));
          const msg = real.slice(0, 2).join(' ｜ ') || (regen.lines ?? []).slice(-1).join('') || '生成配置失败';
          return msg + '（修复后重试；模型相关先到「API 与模型」页检查模型池）';
        })()
      });
    }

    if (p === '/api/secrets') {
      if (req.method === 'GET') return sendJson(res, secretPresence());
      const body = await readBody(req);
      const result = await saveSecretsAndApply({
        updates: body,
        readSecrets: () => readJson(secretsFile()),
        writeSecrets: (secrets) => writeJson(secretsFile(), secrets),
        reload: reloadRunningModelServiceForSecrets
      });
      return sendJson(res, { ...result, secrets: secretPresence() });
    }

    if (p === '/api/usage') {
      // GET：从本地会话库汇总用量（成本 / token / 热力图 / 请求日志）
      return sendJson(res, await readUsageStats());
    }

    if (p === '/api/models') {
      const body = await readBody(req);
      try {
        const secrets = readJson(secretsFile());
        const profile = resolveProfile({ ...body, model: body.model || '__probe__' }, secrets);
        const models = await listModels(profile);
        return sendJson(res, { ok: true, models });
      } catch (error) {
        return sendJson(res, { ok: false, error: String(error?.message ?? error) });
      }
    }

    if (p === '/api/test') {
      const body = await readBody(req);
      return sendJson(res, await testBackend(body));
    }

    /* ── 自动化：看护 / 开机自启 / 定时任务 ───────────── */

    if (p === '/api/automation') {
      if (req.method === 'GET') return sendJson(res, { ...loadAutomation(), autostart: autostartState() });
      const body = await readBody(req);
      const cfg = loadAutomation();
      if (body.watch) {
        cfg.watch = { ...cfg.watch, ...Object.fromEntries(Object.entries(body.watch).map(([k, v]) => [k, v === true])) };
      }
      if ('schedules' in body) {
        cfg.schedules = (Array.isArray(body.schedules) ? body.schedules : []).map((t, i) => ({
          id: String(t.id ?? `task-${Date.now()}-${i}`),
          name: String(t.name ?? '').slice(0, 60),
          enabled: t.enabled === true,
          kind: String(t.kind ?? ''),
          target: String(t.target ?? '').trim(),
          text: String(t.text ?? ''),
          every: { type: t.every?.type === 'interval' ? 'interval' : 'daily', time: String(t.every?.time ?? '09:00'), minutes: Number(t.every?.minutes) || 30 },
          lastRun: t.lastRun ?? null,
          lastResult: t.lastResult ?? null
        }));
      }
      if ('launchAtLogin' in body) {
        cfg.launchAtLogin = body.launchAtLogin === true;
        if (autostartState().supported) applyAutostart(cfg.launchAtLogin);
      }
      saveAutomation(cfg);
      return sendJson(res, { ok: true, ...loadAutomation(), autostart: autostartState() });
    }

    if (p === '/api/wechat/hook') {
      if (req.method === 'GET') {
        const hook = loadConfig().platforms?.wechat?.hook ?? {};
        return sendJson(res, {
          enabled: hook.enabled === true,
          url: hook.url ?? '',
          secret: hook.secret ?? '',
          format: ['default', 'onebot', 'template'].includes(hook.format) ? hook.format : 'default',
          template: hook.template ?? '',
          events: Array.isArray(hook.events) ? hook.events : ['message.received', 'message.replied', 'error']
        });
      }
      const body = await readBody(req);
      const config = loadConfig();
      config.platforms = {
        ...(config.platforms ?? {}),
        wechat: {
          ...(config.platforms?.wechat ?? {}),
          hook: {
            enabled: body.enabled === true,
            url: String(body.url ?? '').trim(),
            secret: String(body.secret ?? ''),
            format: ['default', 'onebot', 'template'].includes(body.format) ? body.format : 'default',
            template: String(body.template ?? ''),
            events: ['message.received', 'message.replied', 'error'].filter((e) => (Array.isArray(body.events) ? body.events : []).includes(e))
          }
        }
      };
      writeJson(configFile(), config);
      return sendJson(res, { ok: true });
    }

    if (p === '/api/wechat/hook/test') {
      // 不经过微信，直接打用户配的 URL —— 验证地址、口令通不通
      const hook = loadConfig().platforms?.wechat?.hook ?? {};
      if (!hook.url) return sendJson(res, { ok: false, error: '先填 webhook 地址并保存' });
      try {
        const res = await fetch(hook.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(hook.secret ? { 'X-DHM-Secret': hook.secret } : {}) },
          body: renderHookSample(hook.format ?? 'default', hook.template ?? ''),
          signal: AbortSignal.timeout(10_000)
        });
        return sendJson(res, { ok: res.ok, status: res.status, error: res.ok ? '' : `HTTP ${res.status}` });
      } catch (error) {
        return sendJson(res, { ok: false, error: String(error?.message ?? error) });
      }
    }

    if (p === '/api/wechat/push') {
      const body = await readBody(req);
      return sendJson(res, await wechatPush(body));
    }

    if (p === '/api/qq/send') {
      const body = await readBody(req);
      return sendJson(res, await qqSend(body));
    }

    if (p === '/api/app/update') {
      // GET：查最新版；软件本体只提醒不自动装
      try {
        return sendJson(res, await checkAppUpdateOnce());
      } catch (error) {
        return sendJson(res, { ok: false, error: String(error?.message ?? error) });
      }
    }

    if (p === '/api/app/update/dismiss') {
      const s = readJson(SETTINGS_FILE);
      s.app = { ...(s.app ?? {}), lastReminded: s.app?.lastUpdateFound ?? '' };
      writeJson(SETTINGS_FILE, s);
      return sendJson(res, { ok: true });
    }

    if (p === '/api/app/update/progress') {
      // 下载进度轮询：没在下载时给 active:false，前端好收尾
      return sendJson(res, appUpdateJob ? { active: true, ...appUpdateJob } : { active: false });
    }

    if (p === '/api/app/update/apply') {
      const body = await readBody(req);
      return sendJson(res, await applyAppUpdate(body.assetUrl));
    }

    if (p === '/api/napcat/update') {
      // GET：查一次最新版并返回资产清单（不落盘安装包、不自动装）
      try {
        const info = await napcatUpdateInfo();
        const updateAvailable = !(info.tag && info.current && info.current.includes(info.tag));
        // 把「发现的新版本」记下来，前端靠它判断横幅该不该出现；
        // 和 lastReminded 一比对就知道这个版本提醒过没有。
        const s = readJson(SETTINGS_FILE);
        s.napcat = {
          ...(s.napcat ?? {}),
          lastUpdateCheck: Date.now(),
          lastUpdateFound: updateAvailable ? info.tag : ''
        };
        writeJson(SETTINGS_FILE, s);
        return sendJson(res, {
          ok: true,
          ...info,
          updateAvailable,
          reminded: s.napcat.lastReminded ?? ''
        });
      } catch (error) {
        return sendJson(res, { ok: false, error: String(error?.message ?? error) });
      }
    }

    if (p === '/api/napcat/update/dismiss') {
      const s = readJson(SETTINGS_FILE);
      s.napcat = { ...(s.napcat ?? {}), lastReminded: s.napcat?.lastUpdateFound ?? '' };
      writeJson(SETTINGS_FILE, s);
      return sendJson(res, { ok: true });
    }

    if (p === '/api/napcat/update/apply') {
      const body = await readBody(req);
      return sendJson(res, await applyNapcatUpdate(body.assetUrl));
    }

    /* 精简安装包用：本机没有 NapCat 时，从 GitHub 下最新 Shell 包装上 */
    /* 组件：得下载才有、软件本身可以不带的东西 */
    if (p === '/api/components') {
      if (req.method === 'GET') {
        // 装完一分钟就把结果清掉，免得下次进页面又提示一遍「装好了」
        if (componentJob?.done && Date.now() - (componentJob.startedAt ?? 0) > 60_000) componentJob = null;
        return sendJson(res, { ok: true, components: componentList(), job: componentJob });
      }
      const body = await readBody(req);
      const id = String(body?.id ?? '');
      if (!['napcat', 'ffmpeg'].includes(id)) return sendJson(res, { ok: false, error: '没有这个组件' });
      // 两个都往 userData 下写，同时跑会互相踩
      if (componentJob && !componentJob.done) return sendJson(res, { ok: false, error: '上一个还在装，等它完' });
      return sendJson(res, startComponentInstall(id));
    }

    /* 从本地 zip 装：国内 GitHub 下不动时，用户自己下好的包直接用 */
    if (p === '/api/components/upload') {
      const id = String(req.headers['x-component-id'] ?? '');
      if (!['napcat', 'ffmpeg'].includes(id)) return sendJson(res, { ok: false, error: '没有这个组件' });
      if (componentJob && !componentJob.done) return sendJson(res, { ok: false, error: '上一个还在装，等它完' });

      const tmp = path.join(os.tmpdir(), `comp-upload-${Date.now()}.zip`);
      try {
        const size = await saveRawBody(req, tmp);
        componentJob = { id, pct: 70, note: '解压中', done: false, error: null, startedAt: Date.now() };
        const r =
          id === 'napcat'
            ? await installNapcatFromZip(tmp, `local-${Date.now().toString(36)}`, size)
            : await installFfmpegFromZip(tmp);
        fs.rmSync(tmp, { force: true });
        componentJob = {
          ...componentJob,
          pct: 100,
          note: r.ok ? '装好了' : '失败',
          done: true,
          error: r.ok ? null : (r.error ?? '失败')
        };
        if (!r.ok) pushLog(`装 ${id} 失败：${r.error ?? ''}`, 'err', 'sys');
        return sendJson(res, { ok: r.ok === true, ...r });
      } catch (error) {
        fs.rmSync(tmp, { force: true });
        const msg = String(error?.message ?? error);
        componentJob = {
          id,
          pct: 100,
          note: '失败',
          done: true,
          error: msg,
          startedAt: Date.now()
        };
        return sendJson(res, { ok: false, error: msg });
      }
    }

    if (p === '/api/napcat/install') {
      if (req.method === 'GET') {
        try {
          const info = await napcatUpdateInfo();
          return sendJson(res, {
            ok: true,
            tag: info.tag,
            asset: info.picked,
            current: info.current,
            installed: Boolean(napcatSettings().dir),
            bundled: napcatSettings().bundled
          });
        } catch (error) {
          return sendJson(res, { ok: false, error: String(error?.message ?? error) });
        }
      }
      return sendJson(res, await installNapcat());
    }

    if (p === '/api/napcat/accounts') {
      if (req.method === 'GET') {
        return sendJson(res, { ok: true, primary: DEFAULT_ACCOUNT_ID, accounts: napcatAccountsState() });
      }
      const body = await readBody(req);
      if (req.method === 'POST') return sendJson(res, addNapcatAccount(body ?? {}));
      if (req.method === 'PUT' || req.method === 'PATCH') {
        return sendJson(res, updateNapcatAccount(body?.id ?? url.searchParams.get('id'), body ?? {}));
      }
      if (req.method === 'DELETE') {
        return sendJson(res, removeNapcatAccount(url.searchParams.get('id') ?? body?.id));
      }
      return sendJson(res, { ok: false, error: '不支持的请求方法' }, 405);
    }

    if (p === '/api/napcat/start') {
      return sendJson(res, startNapcat(url.searchParams.get('account') || DEFAULT_ACCOUNT_ID));
    }
    if (p === '/api/napcat/stop') {
      return sendJson(res, stopNapcat(url.searchParams.get('account') || DEFAULT_ACCOUNT_ID));
    }

    if (p === '/api/qq/contacts') return sendJson(res, await qqContacts());
    if (p === '/api/wechat/targets') return sendJson(res, { targets: wechatTargets() });

    if (p === '/api/messages') {
      const wanted = url.searchParams.get('platform');
      const platform = wanted === 'wechat' ? 'wechat' : wanted === 'phone' ? 'phone' : 'qq';
      const limit = Math.min(2000, Math.max(20, Number(url.searchParams.get('limit')) || 300));
      return sendJson(res, { ok: true, platform, ...readMessages(platform, limit) });
    }
    /* ── 省流总结：最近聊天 → 模型 → 省流版 ─────────────────────────── */
    if (p === '/api/summarize') {
      const body = await readBody(req);
      return sendJson(res, await summarizeChat(body ?? {}));
    }

    /* ── Webhook 通知枢纽：配置读写 ────────────────────────────────── */
    if (p === '/api/notify') {
      if (req.method === 'GET') return sendJson(res, { ok: true, ...loadNotify() });
      const body = await readBody(req);
      const hub = loadNotify();
      if (typeof body.enabled === 'boolean') hub.enabled = body.enabled;
      if (body.default) {
        hub.default = {
          platform: body.default.platform === 'wechat' ? 'wechat' : 'qq',
          to: String(body.default.to ?? '').trim()
        };
      }
      if (body.push) {
        hub.push = {
          kind: ['ntfy', 'serverchan', 'bark', 'pushplus'].includes(body.push.kind) ? body.push.kind : 'ntfy',
          endpoint: String(body.push.endpoint ?? '').trim()
        };
      }
      if (body.mirror) {
        hub.mirror = {
          enabled: body.mirror.enabled === true,
          from: String(body.mirror.from ?? '').trim(),
          keyword: String(body.mirror.keyword ?? '').trim(),
          platform: body.mirror.platform === 'wechat' ? 'wechat' : 'qq',
          to: String(body.mirror.to ?? '').trim()
        };
      }
      saveNotify(hub);
      return sendJson(res, { ok: true, ...hub });
    }

    if (p === '/api/notify/regenerate' && req.method === 'POST') {
      const hub = loadNotify();
      hub.token = randomBytes(9).toString('base64url');
      saveNotify(hub);
      return sendJson(res, { ok: true, token: hub.token });
    }

    if (p === '/api/notify/test' && req.method === 'POST') {
      const body = await readBody(req);
      const hub = loadNotify();
      if (!hub.enabled) return sendJson(res, { ok: false, error: '通知枢纽没启用' });
      const platform = body.platform === 'push' ? 'push' : body.platform === 'wechat' ? 'wechat' : 'qq';
      const to = String(body.to ?? hub.default?.to ?? '').trim();
      if (!to) return sendJson(res, { ok: false, error: '没有目标：填一个 QQ 号 / group:群号 / 微信 id' });
      const text = `[DualHabitat Matrix 通知测试] ${new Date().toLocaleString('zh-CN')}`;
      // dryRun：微信走 wechat-bot 的 --dry-run（不碰微信、不需要登录态）；QQ 没有预览模式，只回确认
      if (body.dryRun) {
        if (platform === 'wechat') return sendJson(res, await wechatPush({ to, text, dryRun: true }));
        return sendJson(res, { ok: true, dryRun: true, note: 'QQ 没有预览模式，真实发送要 NapCat 在跑' });
      }
      return sendJson(res, await notifyDispatch({ platform, to, text }));
    }

    /* ── 插件：列表（直接读 plugins/ 目录）+ 重载（转发给桥接控制台）───── */
    if (p === '/api/plugins') {
      if (req.method === 'GET') {
        const dir = path.join(dataRoot(), 'plugins');
        let files = [];
        try {
          files = fs
            .readdirSync(dir)
            .filter((f) => f.endsWith('.js') || f.endsWith('.mjs'))
            .map((f) => {
              const full = path.join(dir, f);
              let size = 0;
              let desc = '';
              try {
                size = fs.statSync(full).size;
              } catch {
                /* 文件可能正被写 */
              }
              try {
                const head = fs.readFileSync(full, 'utf8').slice(0, 2000);
                const first = head.split('\n').map((l) => l.trim()).find((l) => l.startsWith('//'));
                if (first) desc = first.replace(/^\/\/\s*/, '').slice(0, 120);
              } catch {
                /* 读不了就空着 */
              }
              return { file: f, size, desc };
            });
        } catch {
          /* 目录不存在 = 还没装插件 */
        }
        return sendJson(res, { ok: true, dir, files });
      }
      if (req.method === 'POST') {
        const cfg = loadConfig();
        const port = Number(cfg.consolePort ?? 3100);
        let token = '';
        try {
          token = fs.readFileSync(path.join(dataRoot(), 'state', 'console-token'), 'utf8').trim();
        } catch {
          /* 还没跑过桥接 */
        }
        try {
          const upstream = await fetch(`http://127.0.0.1:${port}/api/plugins/reload`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...(token ? { 'x-console-token': token } : {}) },
            body: '{}',
            signal: AbortSignal.timeout(10_000)
          });
          const data = await upstream.json().catch(() => ({}));
          return sendJson(res, {
            ok: upstream.ok && data.ok !== false,
            count: data.count ?? null,
            errors: data.errors ?? []
          });
        } catch (error) {
          return sendJson(res, {
            ok: false,
            error: `桥接控制台（127.0.0.1:${port}）连不上：${String(error?.message ?? error)}。桥接没在跑的话，下次启动时会自动装载插件。`
          });
        }
      }
    }

    /* ── Webhook 通知枢纽：接收端 ────────────────────────────────────
     * POST /hook/notify/<口令>  body: {text, platform?, to?}
     *   或微信 hook 事件 {event:'message.received', from, text}（把微信
     *   webhook 指到这里，就能按「转发规则」把微信消息转去 QQ / 微信）。
     * GET  /hook/notify/<口令>?text=...  方便脚本一行调用。
     * 口令错 / 没启用 → 404，不区分是哪种，免得帮人探测。 */
    if (p === '/api/plugins/add') {
      // 添加引导的落点：前端「+ 添加插件」把名字和代码交过来，这里写进 plugins/ 并就地热重载。
      // 插件 = 桥接同权限的本机代码，所以：名字白名单、代码限长、已存在必须显式 overwrite。
      if (req.method === 'POST') {
        const body = await readBody(req);
        const rawName = String(body?.name ?? '').trim();
        if (!/^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,48}$/.test(rawName)) {
          return sendJson(res, { ok: false, error: '插件名只能用字母 / 数字 / 下划线 / 连字符（1-49 位）' });
        }
        const code = String(body?.code ?? '');
        if (code.trim().length < 20) return sendJson(res, { ok: false, error: '代码太短：至少要把 default 导出写全（选个模板起步最快）' });
        if (code.length > 200_000) return sendJson(res, { ok: false, error: '代码超过 200KB 上限' });
        const dir = path.join(dataRoot(), 'plugins');
        const file = path.join(dir, `${rawName}.js`);
        if (fs.existsSync(file) && body?.overwrite !== true) {
          return sendJson(res, { ok: false, error: `plugins/${rawName}.js 已存在。要覆盖就勾上「覆盖同名文件」`, exists: true });
        }
        try {
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(file, code.endsWith('\n') ? code : `${code}\n`);
        } catch (error) {
          return sendJson(res, { ok: false, error: `写入失败：${error?.message ?? error}` });
        }
        // 就地热重载（与 /api/plugins POST 同一条链路）；桥接没跑就下次启动自动装载
        const cfg = loadConfig();
        const port = Number(cfg.consolePort ?? 3100);
        let token = '';
        try {
          token = fs.readFileSync(path.join(dataRoot(), 'state', 'console-token'), 'utf8').trim();
        } catch {
          /* 还没跑过桥接 */
        }
        let reload = { count: null, errors: [], bridge: false };
        try {
          const upstream = await fetch(`http://127.0.0.1:${port}/api/plugins/reload`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...(token ? { 'x-console-token': token } : {}) },
            body: '{}',
            signal: AbortSignal.timeout(10_000)
          });
          const data = await upstream.json().catch(() => ({}));
          reload = { count: data.count ?? null, errors: data.errors ?? [], bridge: upstream.ok && data.ok !== false };
        } catch {
          reload.bridge = false;
        }
        return sendJson(res, { ok: true, file: `${rawName}.js`, reload });
      }
    }
    if (p === '/api/plugins/template') {
      // 添加引导的模板：hello = 仓库自带的 example-hello.js 原文（最全）；keyword / blank 内置。
      if (req.method === 'GET') {
        const name = String(url.searchParams.get('name') ?? 'hello');
        let code = '';
        if (name === 'hello') {
          try {
            code = fs.readFileSync(path.join(codeRoot(), 'plugins', 'example-hello.js'), 'utf8');
          } catch {
            code = '';
          }
        } else if (name === 'keyword') {
          code = [
            '// 关键词自动回复插件：onMessage 钩子里匹配关键词就回一句。',
            '// 别做成复读机：同一个人短时间只回一次（这里用 60 秒冷却演示）。',
            "const lastReply = new Map(); // chatId:from -> 上次回复时间戳",
            '',
            'export default {',
            "  name: 'keyword-reply',",
            "  description: '关键词自动回复（示例：消息里提到\"天气\"就回一句）',",
            '  commands: [],',
            '  hooks: {',
            '    onMessage(ctx) {',
            "      const text = String(ctx.text ?? '');",
            "      if (!text || text.startsWith('/')) return; // 斜杠命令交给命令层",
            "      if (!/天气|weather/i.test(text)) return;",
            "      const key = ctx.chatId + ':' + ctx.from;",
            '      const now = Date.now();',
            '      if (now - (lastReply.get(key) ?? 0) < 60_000) return; // 60 秒冷却',
            '      lastReply.set(key, now);',
            "      ctx.reply('收到天气相关的话题啦（示例回复）。真正接天气 API 就写在这里。');",
            '    }',
            '  }',
            '};',
            ''
          ].join('\n');
        } else if (name === 'blank') {
          code = [
            '// 空白插件框架：改 name / description，往 commands 里加你的命令就能用。',
            '// ctx 里有什么（reply / sendVoice / platform / config / log …）见示例插件文件头注释。',
            'export default {',
            "  name: 'my-plugin',",
            "  description: '一句话说明这个插件是干嘛的',",
            '  commands: [',
            '    {',
            "      name: 'myping',",
            "      usage: '/myping',",
            "      description: '验证插件能跑',",
            '      run: async (ctx) => {',
            "        await ctx.reply('pong —— 插件链路通了！');",
            '      }',
            '    }',
            '  ],',
            '  hooks: {}',
            '};',
            ''
          ].join('\n');
        }
        return sendJson(res, { ok: true, name, code });
      }
    }
    if (p === '/api/events') {
      // 出站事件推送设置（扩展页「出站 · 事件推送」卡）。桥接启动时读一次 → 改完自动重启 QQ BOT；
      // 微信侧每条消息现读 config，下条消息起生效。
      const cfgE = loadConfig();
      if (req.method === 'GET') {
        const e = cfgE.events && typeof cfgE.events === 'object' ? cfgE.events : {};
        return sendJson(res, {
          ok: true,
          enabled: e.enabled === true,
          url: String(e.url ?? ''),
          secret: String(e.secret ?? ''),
          onMessage: e.onMessage !== false,
          onReply: e.onReply !== false
        });
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        if (body?.test === true) {
          const url = String(body.url ?? cfgE.events?.url ?? '').trim();
          if (!url) return sendJson(res, { ok: false, error: '先填推送地址' });
          const secret = String(body.secret ?? cfgE.events?.secret ?? '').trim();
          try {
            const r = await fetch(url, {
              method: 'POST',
              headers: { 'content-type': 'application/json', ...(secret ? { 'x-dhm-secret': secret } : {}) },
              body: JSON.stringify({ event: 'test', time: new Date().toISOString(), data: { note: 'DualHabitat 扩展中心测试事件' } }),
              signal: AbortSignal.timeout(8000)
            });
            return sendJson(res, { ok: r.ok, status: r.status, note: r.ok ? `对端收到了（HTTP ${r.status}）` : `对端返回 HTTP ${r.status}，检查一下接收端` });
          } catch (error) {
            return sendJson(res, { ok: false, error: `发不出去：${error?.message ?? error}` });
          }
        }
        if (!cfgE.events || typeof cfgE.events !== 'object') cfgE.events = {};
        let changed = false;
        if (body?.enabled !== undefined) { const v = body.enabled === true; if (cfgE.events.enabled !== v) { cfgE.events.enabled = v; changed = true; } }
        if (body?.url !== undefined) { const v = String(body.url).trim(); if (cfgE.events.url !== v) { cfgE.events.url = v; changed = true; } }
        if (body?.secret !== undefined && String(body.secret).trim() !== '') { const v = String(body.secret).trim(); if (cfgE.events.secret !== v) { cfgE.events.secret = v; changed = true; } }
        for (const k of ['onMessage', 'onReply']) {
          if (body?.[k] !== undefined) { const v = body[k] === true; if (cfgE.events[k] !== v) { cfgE.events[k] = v; changed = true; } }
        }
        if (changed) writeJson(configFile(), cfgE);
        let botsRestarted = false;
        if (changed) { try { botsRestarted = await restartBotsFor('qq'); } catch { botsRestarted = false; } }
        return sendJson(res, { ok: true, changed, botsRestarted });
      }
    }
    if (p === '/api/extensions') {
      // 扩展中心聚合状态：一页看清所有对外接口和插口。
      if (req.method === 'GET') {
        const cfgX = loadConfig();
        const hub = loadNotify();
        let pluginCount = 0;
        try {
          pluginCount = fs.readdirSync(path.join(dataRoot(), 'plugins')).filter((f) => f.endsWith('.js') || f.endsWith('.mjs')).length;
        } catch {
          /* 还没装插件 */
        }
        let mcp = [];
        try {
          const oc = JSON.parse(fs.readFileSync(path.join(dataRoot(), 'opencode.json'), 'utf8'));
          mcp = Object.keys(oc.mcp?.servers ?? oc.mcp ?? oc.mcpServers ?? {});
        } catch {
          /* 配置还没生成就空着 */
        }
        const e = cfgX.events && typeof cfgX.events === 'object' ? cfgX.events : {};
        const shRaw = cfgX.openaiShell && typeof cfgX.openaiShell === 'object' ? cfgX.openaiShell : {};
        const shPort = Number(shRaw.port);
        let shellKey = '';
        try { shellKey = fs.readFileSync(path.join(dataRoot(), 'state', 'openai-shell.key'), 'utf8').trim(); } catch { /* 还没生成 */ }
        return sendJson(res, {
          ok: true,
          hub: { enabled: hub.enabled !== false, path: `/hook/notify/${hub.token}`, default: hub.default ?? {} },
          phone: { running: phoneListening > 0, port: phoneSettings().port },
          plugins: { count: pluginCount },
          mcp,
          events: { enabled: e.enabled === true, url: String(e.url ?? ''), hasSecret: Boolean(e.secret), onMessage: e.onMessage !== false, onReply: e.onReply !== false },
          openaiShell: {
            enabled: shRaw.enabled === true,
            port: Number.isFinite(shPort) && shPort >= 1024 && shPort <= 65535 ? shPort : 4610,
            agentPreset: String(shRaw.agentPreset ?? 'qq-chat'),
            key: shellKey
          },
          llm: { url: 'http://127.0.0.1:4599', auth: 'Basic 鉴权（见 docs/LLM-INTEGRATION.md）' }
        });
      }
    }
    if (p === '/api/openai-shell') {
      /* OpenAI 兼容壳（0.5.0）。壳由**桥接进程**托管（它才连着模型实例），
       * 所以这里只负责读写配置 + 重启桥接；状态用探端口判断，不去猜桥接内部。 */
      const shellKeyFile = path.join(dataRoot(), 'state', 'openai-shell.key');
      const readShellKey = () => {
        try { return fs.readFileSync(shellKeyFile, 'utf8').trim(); } catch { return ''; }
      };
      const shellShape = (cfgIn) => {
        const sh = cfgIn?.openaiShell && typeof cfgIn.openaiShell === 'object' ? cfgIn.openaiShell : {};
        const port = Number(sh.port);
        return {
          enabled: sh.enabled === true,
          port: Number.isFinite(port) && port >= 1024 && port <= 65535 ? port : 4610,
          agentPreset: String(sh.agentPreset ?? 'qq-chat'),
          allowLocalTools: sh.allowLocalTools === true,
          timeoutMs: Number(sh.timeoutMs) || 180000
        };
      };

      if (req.method === 'GET') {
        const sh = shellShape(loadConfig());
        return sendJson(res, {
          ok: true,
          ...sh,
          key: readShellKey(),
          running: await probePort(sh.port),
          bridgeRunning: Boolean(bridge.child)
        });
      }

      if (req.method === 'POST') {
        const body = await readBody(req);
        const cfgS = loadConfig();
        if (!cfgS.openaiShell || typeof cfgS.openaiShell !== 'object') cfgS.openaiShell = {};
        let changed = false;

        if (body?.enabled !== undefined) {
          const v = body.enabled === true;
          if (cfgS.openaiShell.enabled !== v) { cfgS.openaiShell.enabled = v; changed = true; }
        }
        if (body?.port !== undefined) {
          const port = Math.floor(Number(body.port) || 0);
          if (port < 1024 || port > 65535) return sendJson(res, { ok: false, error: '端口要在 1024-65535 之间' });
          // 这几个是本程序自己在用的，占了会互相打架
          const reserved = new Set([3000, 3001, 3100, 3200, 3210, 4599, 4600]);
          if (reserved.has(port)) return sendJson(res, { ok: false, error: `端口 ${port} 已被本程序占用，换一个` });
          if (cfgS.openaiShell.port !== port) { cfgS.openaiShell.port = port; changed = true; }
        }
        if (body?.agentPreset !== undefined) {
          const ap = String(body.agentPreset).trim() || 'qq-chat';
          if (!/^[a-z0-9][a-z0-9-]{0,31}$/i.test(ap)) return sendJson(res, { ok: false, error: 'agent 名字不合法' });
          if (cfgS.openaiShell.agentPreset !== ap) { cfgS.openaiShell.agentPreset = ap; changed = true; }
        }
        if (body?.allowLocalTools !== undefined) {
          const v = body.allowLocalTools === true;
          if (cfgS.openaiShell.allowLocalTools !== v) { cfgS.openaiShell.allowLocalTools = v; changed = true; }
        }
        // qq-work = 带本地工具的主人档。必须显式 allowLocalTools，光选 preset 不算数。
        if (String(cfgS.openaiShell.agentPreset) === 'qq-work' && cfgS.openaiShell.allowLocalTools !== true) {
          return sendJson(res, { ok: false, error: '选 qq-work 会开放读写文件和执行命令，请同时勾选「允许本地工具（仅主人）」' });
        }
        if (body?.regenerateKey === true) {
          // 生成在**桌面端**做，桥接只读文件 —— 这样界面能立刻显示新 key，
          // 又不依赖桥接是否在跑（桥接那边 loadOrCreateKey 认这个文件）。
          cfgS.openaiShell.apiKey = '';
          fs.mkdirSync(path.dirname(shellKeyFile), { recursive: true });
          fs.writeFileSync(shellKeyFile, `dhm-${randomBytes(24).toString('hex')}\n`, { encoding: 'utf8', mode: 0o600 });
          changed = true;
        }

        if (changed) writeJson(configFile(), cfgS);
        let botsRestarted = false;
        if (changed) { try { botsRestarted = await restartBotsFor('qq'); } catch { botsRestarted = false; } }
        const sh = shellShape(loadConfig());
        return sendJson(res, {
          ok: true,
          changed,
          botsRestarted,
          ...sh,
          key: readShellKey(),
          running: await probePort(sh.port)
        });
      }
      return sendJson(res, { ok: false, error: '只支持 GET / POST' }, 405);
    }

    if (p === '/api/agent-tools') {
      /* 本地 Agent 工具（MCP agent-tools）：开关 / 沙箱根 / 超时。
       * 只写 config.agentTools，改完重新生成 opencode.json 并重启桥接。
       * 权限边界不在这里判 —— MCP 只注册给 qq-work，聊天档永远没有。 */
      const cfgA = loadConfig();
      const at = cfgA.agentTools && typeof cfgA.agentTools === 'object' ? cfgA.agentTools : {};
      const shape = () => {
        const c = loadConfig();
        const a = c.agentTools && typeof c.agentTools === 'object' ? c.agentTools : {};
        const sessionCwd = String(c.sessionCwd ?? '').trim();
        const configuredRoot = String(a.sandboxRoot ?? '').trim();
        return {
          enabled: a.enabled === true,
          sandboxRoot: configuredRoot,
          effectiveSandboxRoot: configuredRoot || sessionCwd || dataRoot(),
          usesSessionCwd: !configuredRoot,
          timeoutMs: Number(a.timeoutMs) || 30000,
          maxReadBytes: Number(a.maxReadBytes) || 1048576,
          maxWriteBytes: Number(a.maxWriteBytes) || 1048576,
          maxOutputBytes: Number(a.maxOutputBytes) || 131072,
          ownerQQ: c.ownerQQ ?? null,
          ownerWechat: c.platforms?.wechat?.ownerId ?? null,
          shellPreset: String(c.openaiShell?.agentPreset ?? 'qq-chat'),
          shellAllowLocalTools: c.openaiShell?.allowLocalTools === true,
          hasOwner: Boolean(c.ownerQQ || c.platforms?.wechat?.ownerId)
        };
      };

      if (req.method === 'GET') return sendJson(res, { ok: true, ...shape() });

      if (req.method === 'POST') {
        const body = await readBody(req);
        const next = { ...at };
        let changed = false;
        if (body?.enabled !== undefined) {
          const v = body.enabled === true;
          if (next.enabled !== v) { next.enabled = v; changed = true; }
        }
        if (body?.sandboxRoot !== undefined) {
          const raw = String(body.sandboxRoot ?? '').trim();
          if (raw) {
            const abs = path.resolve(raw);
            if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
              return sendJson(res, { ok: false, error: `沙箱目录不存在或不是目录：${abs}` });
            }
            if (next.sandboxRoot !== abs) { next.sandboxRoot = abs; changed = true; }
          } else if (next.sandboxRoot) {
            next.sandboxRoot = '';
            changed = true;
          }
        }
        if (body?.timeoutMs !== undefined) {
          const n = Math.floor(Number(body.timeoutMs) || 0);
          if (n < 1000 || n > 120000) return sendJson(res, { ok: false, error: '命令超时要在 1000-120000 毫秒之间' });
          if (next.timeoutMs !== n) { next.timeoutMs = n; changed = true; }
        }
        if (changed) {
          cfgA.agentTools = next;
          writeJson(configFile(), cfgA);
        }
        let regenerated = null;
        let botsRestarted = false;
        if (changed) {
          try { regenerated = await regenerateConfig(); } catch { regenerated = { ok: false }; }
          try { botsRestarted = await restartBotsFor('qq'); } catch { botsRestarted = false; }
        }
        const at2 = loadConfig().agentTools ?? {};
        return sendJson(res, {
          ok: true,
          changed,
          regenerated: regenerated ? regenerated.ok : null,
          botsRestarted,
          ...shape(),
          agentTools: at2
        });
      }
      return sendJson(res, { ok: false, error: '只支持 GET / POST' }, 405);
    }

    if (p === '/api/endpoints') {
      // 内置接口手册：常用对外端点 + 鉴权方式 + 请求体示例（前端渲染成一键复制 curl）。
      if (req.method === 'GET') {
        const docs = [
          { group: '入站', method: 'POST', path: '/hook/notify/<口令>', auth: '口令（路径里）', desc: '推送文字到 QQ / 微信 / 推送渠道（ntfy、Server酱、Bark、PushPlus）', body: '{"text":"你好","platform":"qq","to":"123456"}' },
          { group: '入站', method: 'GET', path: '/hook/notify/<口令>?text=你好', auth: '口令（路径里）', desc: '一行调用版，浏览器地址栏就能发' },
          { group: '入站', method: 'POST', path: 'http://<局域网IP>:3210/hook/<口令>', auth: '口令（路径里）', desc: '手机页入口：SmsForwarder / message-mirror 把手机通知转发进来' },
          { group: '出站', method: 'POST', path: '<你在扩展页配的推送地址>', auth: 'x-dhm-secret 头（选填）', desc: '机器人事件推送：收到消息 / 发出回复 / QQ 投递失败时主动 POST 给你；投递失败事件只带失败分段索引，不含正文', body: '{"event":"message","time":"…","data":{"platform":"qq","chatId":"group:123","text":"…"}}' },
          { group: '发送', method: 'POST', path: '/api/socialV2/sendMessage', auth: 'x-console-token 头', desc: '让机器人发一条文字到指定会话（走白名单/静默/限频闸门）', body: '{"key":"group:123456","text":"你好"}' },
          { group: '发送', method: 'POST', path: '/api/socialV2/send-image', auth: 'x-console-token 头', desc: '把图库里的图片发到指定会话', body: '{"key":"private:123456","file":"draw-xxx.jpg","caption":"看图"}' },
          { group: '发送', method: 'POST', path: '/api/socialV2/say', auth: 'agent token（reserved2 模式）', desc: '现场把一句话合成语音条发出（模型的 qq_say 通道）', body: '{"key":"group:123456","text":"这句话会变成语音","dryRun":true}' },
          { group: '查询', method: 'GET', path: '/api/state', auth: 'x-console-token 头', desc: '机器人全量运行状态（服务、模型、更新、统计）' },
          { group: '查询', method: 'GET', path: '/api/messages?platform=qq', auth: 'x-console-token 头', desc: '消息流（platform=qq / wechat / phone）' },
          { group: '查询', method: 'GET', path: '/api/plugins', auth: 'x-console-token 头', desc: '已装载插件列表' },
          { group: '模型', method: 'POST', path: 'http://127.0.0.1:4610/v1/chat/completions', auth: 'Authorization: Bearer <壳的 key>', desc: 'OpenAI 兼容壳：任何 OpenAI SDK / 工具改 baseURL 就能用（走机器人同款模型池）', body: '{"model":"dh-matrix","messages":[{"role":"user","content":"你好"}]}' },
          { group: '模型', method: 'GET', path: 'http://127.0.0.1:4610/v1/models', auth: 'Authorization: Bearer <壳的 key>', desc: '壳支持的模型清单（来自本机实例的模型目录）' },
          { group: '模型', method: 'POST', path: 'http://127.0.0.1:4599（协议见 docs/LLM-INTEGRATION.md）', auth: 'Basic 鉴权', desc: '模型 API 原生接口：会话制协议，非 OpenAI 格式（要 OpenAI 格式用上面的兼容壳）' }
        ];
        return sendJson(res, { ok: true, endpoints: docs });
      }
    }
    if (p.startsWith('/hook/notify/')) {
      const hub = loadNotify();
      const token = p.slice('/hook/notify/'.length);
      if (!hub.enabled || !hub.token || token !== hub.token) {
        return sendJson(res, { ok: false, error: 'not found' }, 404);
      }
      let payload = {};
      if (req.method === 'POST') {
        payload = await readBody(req);
      } else if (req.method === 'GET') {
        payload = {
          text: url.searchParams.get('text') ?? '',
          platform: url.searchParams.get('platform') ?? undefined,
          to: url.searchParams.get('to') ?? undefined
        };
      } else {
        return sendJson(res, { ok: false, error: 'method not allowed' }, 405);
      }
      const text = String(payload.text ?? '').trim();
      if (!text) return sendJson(res, { ok: false, error: '缺少 text' }, 400);

      // 微信消息转发规则
      if (payload.event === 'message.received' && hub.mirror?.enabled) {
        const m = hub.mirror;
        const fromOk = !m.from || String(payload.from ?? '') === m.from;
        const kwOk = !m.keyword || text.includes(m.keyword);
        if (fromOk && kwOk && m.to) {
          const r = await notifyDispatch({ platform: m.platform, to: m.to, text: `微信 ${payload.from ?? ''}：${text}` });
          return sendJson(res, { ok: r.ok, forwarded: 1, detail: r });
        }
        return sendJson(res, { ok: true, forwarded: 0 });
      }

      // 直接通知：请求里带了目标就用；否则用默认目标
      const reqPlatform = payload.platform === 'wechat' ? 'wechat'
        : payload.platform === 'qq' ? 'qq'
        : payload.platform === 'push' ? 'push'
        : null;
      const reqTo = String(payload.to ?? '').trim();
      const target = reqPlatform && reqTo
        ? { platform: reqPlatform, to: reqTo }
        : hub.default?.to
          ? { platform: hub.default.platform === 'push' ? 'push' : hub.default.platform === 'wechat' ? 'wechat' : 'qq', to: hub.default.to }
          : null;
      if (!target) {
        return sendJson(res, { ok: false, error: '请求里没带 platform/to，服务端也没配默认目标' }, 400);
      }
      const r = await notifyDispatch({ platform: target.platform, to: target.to, text });
      return sendJson(res, r, r.ok ? 200 : 502);
    }

    /* ── 手机推送（Android 通知转发）────────────────────────────────────
     * 手机端把通知 POST 到局域网端口，这里只管开关、地址和自测。
     * 真正的接收在 handlePhoneRequest() 里。 */
    if (p === '/api/phone') {
      if (req.method === 'GET') {
        const s = phoneSettings();
        const port = phoneListening || s.port;
        return sendJson(res, {
          ok: true,
          enabled: s.enabled,
          port: s.port,
          listening: phoneListening,
          token: s.token,
          notifyAi: s.notifyAi,
          notifyKey: s.notifyKey || (loadConfig().ownerQQ ? `private:${loadConfig().ownerQQ}` : ''),
          urls: lanAddresses().map((i) => ({
            name: i.name,
            address: i.address,
            url: `http://${i.address}:${port}/hook/${s.token}`,
            // 二维码扫这个：手机打开是一页配置说明，不是空的 POST 端点
            setup: `http://${i.address}:${port}/setup/${s.token}`
          })),
          count: s.count,
          lastAt: s.lastAt,
          recent: readPhoneInbox()
        });
      }

      const body = await readBody(req);
      const patch = {};
      if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
      if (typeof body.notifyAi === 'boolean') patch.notifyAi = body.notifyAi;
      if (typeof body.notifyKey === 'string') patch.notifyKey = body.notifyKey.trim();
      if (body.port != null) {
        const n = Number(body.port);
        if (!Number.isFinite(n) || n < 1024 || n > 65535) {
          return sendJson(res, { ok: false, error: '端口要在 1024~65535 之间' });
        }
        patch.port = n;
      }
      if (body.regenerate === true) patch.token = newPhoneToken();
      else if (!phoneSettings().token) patch.token = newPhoneToken();

      writePhoneSettings(patch);
      const started = await startPhoneListener();
      const s = phoneSettings();
      return sendJson(res, {
        // ok 放在 spread 后面：startPhoneListener 在"没启用"时返回 ok:false，
        // 那说的是"没在监听"，不是"保存失败"。保存失败另有 error 字段。
        ...started,
        ok: true,
        enabled: s.enabled,
        port: s.port,
        token: s.token,
        notifyAi: s.notifyAi,
        reason: started.reason ?? null
      });
    }

    if (p === '/api/phone/test') {
      const body = await readBody(req).catch(() => ({}));
      const result = recordPhonePush({
        app: body.app || '测试',
        from: '电脑',
        text: body.text || `这是一条测试推送，链路是通的（${new Date().toLocaleTimeString('zh-CN', { hour12: false })}）`
      });
      return sendJson(res, result);
    }

    /* 只测「投给模型」这一段：桥接在不在、管理员 QQ 配没配、控制台口令对不对 */
    if (p === '/api/phone/notify-test') {
      try {
        const data = await notifyAiAboutPhone({
          app: '自测',
          from: '电脑',
          text: '这条是「让模型看到」的测试，模型那边应该会收到一条后台提醒。'
        });
        return sendJson(res, { ok: true, ...data });
      } catch (error) {
        return sendJson(res, { ok: false, error: String(error?.message ?? error) });
      }
    }

    /* ── 模型能用哪些工具 ─────────────────────────────────────────────── */

    /* ── 语音库与 TTS（对话与人格页「语音库与 TTS」面板） ─────────────────── */
    const voiceLibraryDir = () => path.resolve(dataRoot(), String(loadConfig().socialV2?.voice?.dir ?? 'audio'));
    const VOICE_AUDIO_EXTS = ['.mp3', '.wav', '.ogg', '.oga', '.opus', '.m4a', '.aac', '.flac', '.amr', '.silk', '.slk', '.wma', '.spx'];
    if (p === '/api/voice-library') {
      const listFiles = (dir, base) => {
        const out = [];
        let entries = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
        for (const e of entries) {
          if (e.name.startsWith('.')) continue;
          const rel = base ? `${base}/${e.name}` : e.name;
          const full = path.join(dir, e.name);
          if (e.isDirectory()) out.push(...listFiles(full, rel));
          else if (VOICE_AUDIO_EXTS.includes(path.extname(e.name).toLowerCase())) {
            let size = 0;
            try { size = fs.statSync(full).size; } catch { /* 读不到就算 0 */ }
            out.push({ name: rel, size });
          }
        }
        return out;
      };
      if (req.method === 'GET') {
        const files = listFiles(voiceLibraryDir(), '').sort((a, b) => a.name.localeCompare(b.name, 'zh'));
        return sendJson(res, { ok: true, dir: voiceLibraryDir(), files });
      }
      if (req.method === 'POST') {
        // 上传：{ name, dataB64 }。名字只取 basename、限音频扩展名、限 30MB ——
        // 这个目录是模型的语音库，不能让它变成任意文件写入点。
        const body = await readBody(req);
        const base = path.basename(String(body?.name ?? '')).replace(/[\\/:*?"<>|]/g, '');
        if (!base || !VOICE_AUDIO_EXTS.includes(path.extname(base).toLowerCase())) {
          return sendJson(res, { ok: false, error: '文件名要带音频扩展名（mp3/wav/ogg/m4a/flac/amr…）' });
        }
        let buf;
        try {
          buf = Buffer.from(String(body?.dataB64 ?? ''), 'base64');
        } catch {
          return sendJson(res, { ok: false, error: '文件内容不是合法的 base64' });
        }
        if (buf.length < 200) return sendJson(res, { ok: false, error: '文件太小，不像有效音频' });
        if (buf.length > 30 * 1024 * 1024) return sendJson(res, { ok: false, error: '超过 30MB 上限' });
        try {
          fs.mkdirSync(voiceLibraryDir(), { recursive: true });
          fs.writeFileSync(path.join(voiceLibraryDir(), base), buf);
          return sendJson(res, { ok: true, name: base, bytes: buf.length });
        } catch (error) {
          return sendJson(res, { ok: false, error: String(error?.message ?? error) });
        }
      }
      if (req.method === 'DELETE') {
        const rel = String(url.searchParams.get('name') ?? '').trim();
        const libDir = path.resolve(voiceLibraryDir());
        const full = path.resolve(libDir, rel);
        if (!full.startsWith(libDir + path.sep) || !path.extname(full)) {
          return sendJson(res, { ok: false, error: '非法的文件名' });
        }
        try {
          fs.rmSync(full, { force: true });
          return sendJson(res, { ok: true });
        } catch (error) {
          return sendJson(res, { ok: false, error: String(error?.message ?? error) });
        }
      }
    }

    if (p === '/api/voice-library/file') {
      // 试听：把库里的音频给浏览器播（只允许库目录内的文件，防目录穿越）。
      const rel = String(url.searchParams.get('name') ?? '').trim();
      const libDir = path.resolve(voiceLibraryDir());
      const full = path.resolve(libDir, rel);
      let ok = false;
      try {
        ok = full.startsWith(libDir + path.sep) && fs.existsSync(full) && fs.statSync(full).isFile();
      } catch { ok = false; }
      if (!ok) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('not found');
        return;
      }
      const types = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac', '.amr': 'audio/amr' };
      res.writeHead(200, { 'content-type': types[path.extname(full).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(fs.readFileSync(full));
      return;
    }

    if (p === '/api/voice-tts') {
      // GET = 读设置；POST = 存设置（provider / voice / wechatFollow），带 text 就顺手合成一条试听。
      // 语音配置是桥接启动时读的：改了就自动把在跑的 QQ BOT 就地重启（没跑 = 下次启动生效）。
      const cfg = loadConfig();
      if (req.method === 'GET') {
        const { normalizeCustomEngine } = await import(pathToFileURL(path.join(codeRoot(), 'src', 'tts.js')).href);
        return sendJson(res, {
          ok: true,
          provider: cfg.socialV2?.voice?.tts?.provider || 'auto',
          voice: cfg.socialV2?.voice?.tts?.voice || '',
          maxChars: Number(cfg.socialV2?.voice?.tts?.maxChars) || 2000,
          wechatFollow: cfg.platforms?.wechat?.ttsFollow === true,
          custom: Array.isArray(cfg.socialV2?.voice?.tts?.custom) ? cfg.socialV2.voice.tts.custom.map(normalizeCustomEngine).filter(Boolean) : []
        });
      }
      if (req.method === 'POST') {
        const { normalizeCustomEngine } = await import(pathToFileURL(path.join(codeRoot(), 'src', 'tts.js')).href);
        const body = await readBody(req);
        const limit = Math.max(50, Math.min(2000, Math.floor(Number(body?.maxChars) || Number(cfg.socialV2?.voice?.tts?.maxChars) || 2000)));
        // 试听文字上限和 tts.js 的 maxChars 对齐。那边超长会按句子截断，
        // 用户贴 3000 字进来只听到一部分却显示「合成成功」—— 试听这里直接说清楚。
        const spoken = String(body?.text ?? '');
        if (spoken.trim() && spoken.length > limit) {
          return sendJson(res, { ok: false, error: `试听文字最多 ${limit} 字（现在是 ${spoken.length} 字），分句试听吧；上限可在下面改` });
        }
        if (!cfg.socialV2 || typeof cfg.socialV2 !== 'object') cfg.socialV2 = {};
        if (!cfg.socialV2.voice || typeof cfg.socialV2.voice !== 'object') cfg.socialV2.voice = {};
        if (!cfg.socialV2.voice.tts || typeof cfg.socialV2.voice.tts !== 'object') cfg.socialV2.voice.tts = {};
        let changed = false;
        if (body?.custom !== undefined) {
          if (!Array.isArray(body.custom)) return sendJson(res, { ok: false, error: 'custom 必须是数组' });
          const normalized = [];
          for (const raw of body.custom) {
            const n = normalizeCustomEngine(raw);
            if (!n) return sendJson(res, { ok: false, error: '自定义引擎要有合法 id（英文/数字/-_）、包含 {out} 的命令模板' });
            if (normalized.some((x) => x.id === n.id)) return sendJson(res, { ok: false, error: `自定义引擎 id 重复：${n.id}` });
            normalized.push(n);
          }
          const prev = Array.isArray(cfg.socialV2.voice.tts.custom) ? cfg.socialV2.voice.tts.custom.map(normalizeCustomEngine).filter(Boolean) : [];
          if (JSON.stringify(prev) !== JSON.stringify(normalized)) {
            cfg.socialV2.voice.tts.custom = normalized;
            changed = true;
          }
        }
        const customs = Array.isArray(cfg.socialV2.voice.tts.custom)
          ? cfg.socialV2.voice.tts.custom.map(normalizeCustomEngine).filter(Boolean)
          : [];
        const allowedProviders = ['auto', 'edge', 'sapi', ...customs.map((c) => `custom:${c.id}`)];
        // 引擎被删掉后，旧选择不能留成死指针 —— 自动回 auto。
        if (cfg.socialV2.voice.tts.provider && !allowedProviders.includes(String(cfg.socialV2.voice.tts.provider))) {
          cfg.socialV2.voice.tts.provider = 'auto';
          changed = true;
        }
        if (body?.provider !== undefined) {
          const prov = String(body.provider);
          if (!allowedProviders.includes(prov)) return sendJson(res, { ok: false, error: `未知 TTS 引擎：${prov}` });
          if (cfg.socialV2.voice.tts.provider !== prov) { cfg.socialV2.voice.tts.provider = prov; changed = true; }
        }
        if (body?.voice !== undefined) {
          const nv = String(body.voice).trim();
          if (cfg.socialV2.voice.tts.voice !== nv) { cfg.socialV2.voice.tts.voice = nv; changed = true; }
        }
        if (body?.maxChars !== undefined) {
          const n = Math.floor(Number(body.maxChars) || 0);
          if (n < 50 || n > 2000) return sendJson(res, { ok: false, error: '字数上限要在 50-2000 之间' });
          if (cfg.socialV2.voice.tts.maxChars !== n) { cfg.socialV2.voice.tts.maxChars = n; changed = true; }
        }
        if (body?.wechatFollow !== undefined) {
          const nw = body.wechatFollow === true;
          if (!cfg.platforms || typeof cfg.platforms !== 'object') cfg.platforms = {};
          if (!cfg.platforms.wechat || typeof cfg.platforms.wechat !== 'object') cfg.platforms.wechat = {};
          if (cfg.platforms.wechat.ttsFollow !== nw) { cfg.platforms.wechat.ttsFollow = nw; changed = true; }
        }
        if (changed) writeJson(configFile(), cfg);
        // 保存即生效：只重启受影响的平台，BOT 没在跑就是 false（下次启动生效）
        let botsRestarted = false;
        if (changed) { try { botsRestarted = await restartBotsFor('qq'); } catch { botsRestarted = false; } }
        let preview = null;
        if (String(body?.text ?? '').trim()) {
          try {
            const { synthesizeText } = await import(pathToFileURL(path.join(codeRoot(), 'src', 'tts.js')).href);
            const r = await synthesizeText(String(body.text), {
              outDir: path.join(voiceLibraryDir(), 'tts'),
              provider: cfg.socialV2.voice.tts.provider || 'auto',
              voice: cfg.socialV2.voice.tts.voice || '',
              maxChars: cfg.socialV2.voice.tts.maxChars
            });
            preview = {
              name: `tts/${path.basename(r.path)}`,
              provider: r.provider, voice: r.voice, bytes: r.bytes,
              chars: r.chars, usedChars: r.used, truncated: r.truncated, maxChars: r.maxChars
            };
          } catch (error) {
            return sendJson(res, { ok: false, error: `合成失败：${error?.message ?? error}`, botsRestarted });
          }
        }
        return sendJson(res, {
          ok: true,
          provider: cfg.socialV2.voice.tts.provider || 'auto',
          voice: cfg.socialV2.voice.tts.voice || '',
          maxChars: Number(cfg.socialV2.voice.tts.maxChars) || 2000,
          wechatFollow: cfg.platforms?.wechat?.ttsFollow === true,
          custom: Array.isArray(cfg.socialV2.voice.tts.custom) ? cfg.socialV2.voice.tts.custom.map(normalizeCustomEngine).filter(Boolean) : [],
          changed,
          botsRestarted,
          preview
        });
      }
    }


    /* ── 画画与动态（对话与人格页「画画与动态」面板） ─────────────────── */
    const imageLibraryDir = () => path.resolve(dataRoot(), String(loadConfig().socialV2?.draw?.dir ?? 'images'));
    const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
    if (p === '/api/draw') {
      // GET = 读设置；POST = 存设置（引擎/尺寸/每日上限），带 text 就顺手真画一张试画。
      // 出图配置是桥接侧 draw.js 启动时读的：改了自动把在跑的 QQ BOT 就地重启。
      const cfgd = loadConfig();
      if (req.method === 'GET') {
        const { normalizeCustomDraw } = await import(pathToFileURL(path.join(codeRoot(), 'src', 'draw.js')).href);
        const d = cfgd.socialV2?.draw && typeof cfgd.socialV2.draw === 'object' ? cfgd.socialV2.draw : {};
        const custom = Array.isArray(d.custom) ? d.custom.map(normalizeCustomDraw).filter(Boolean) : [];
        const allowed = ['auto', 'cloudflare', 'bailian', 'zhipu', ...custom.map((c) => `custom:${c.id}`)];
        return sendJson(res, {
          ok: true,
          provider: allowed.includes(d.provider) ? d.provider : 'auto',
          size: /^\d{3,4}x\d{3,4}$/.test(String(d.size ?? '')) ? d.size : '1024x1024',
          dailyLimit: Number.isFinite(+d.dailyLimit) && +d.dailyLimit > 0 ? +d.dailyLimit : 30,
          momentDailyLimit: Number.isFinite(+d.momentDailyLimit) && +d.momentDailyLimit > 0 ? +d.momentDailyLimit : 10,
          custom
        });
      }
      if (req.method === 'POST') {
        const { normalizeCustomDraw } = await import(pathToFileURL(path.join(codeRoot(), 'src', 'draw.js')).href);
        const body = await readBody(req);
        if (!cfgd.socialV2 || typeof cfgd.socialV2 !== 'object') cfgd.socialV2 = {};
        if (!cfgd.socialV2.draw || typeof cfgd.socialV2.draw !== 'object') cfgd.socialV2.draw = {};
        let changed = false;
        if (body?.custom !== undefined) {
          if (!Array.isArray(body.custom)) return sendJson(res, { ok: false, error: 'custom 必须是数组' });
          const normalized = [];
          for (const raw of body.custom) {
            const n = normalizeCustomDraw(raw);
            if (!n) return sendJson(res, { ok: false, error: '自定义出图要有合法 id、http(s) baseUrl、model、apiKeyEnv 和含 {w}{h} 的 sizeTemplate' });
            if (normalized.some((x) => x.id === n.id)) return sendJson(res, { ok: false, error: `自定义出图 id 重复：${n.id}` });
            normalized.push(n);
          }
          const prev = Array.isArray(cfgd.socialV2.draw.custom) ? cfgd.socialV2.draw.custom.map(normalizeCustomDraw).filter(Boolean) : [];
          if (JSON.stringify(prev) !== JSON.stringify(normalized)) {
            cfgd.socialV2.draw.custom = normalized;
            changed = true;
          }
        }
        const customs = Array.isArray(cfgd.socialV2.draw.custom)
          ? cfgd.socialV2.draw.custom.map(normalizeCustomDraw).filter(Boolean)
          : [];
        const allowedDraw = ['auto', 'cloudflare', 'bailian', 'zhipu', ...customs.map((c) => `custom:${c.id}`)];
        if (cfgd.socialV2.draw.provider && !allowedDraw.includes(String(cfgd.socialV2.draw.provider))) {
          cfgd.socialV2.draw.provider = 'auto';
          changed = true;
        }
        if (body?.provider !== undefined) {
          const prov = String(body.provider);
          if (!allowedDraw.includes(prov)) return sendJson(res, { ok: false, error: `未知出图引擎：${prov}` });
          if (cfgd.socialV2.draw.provider !== prov) { cfgd.socialV2.draw.provider = prov; changed = true; }
        }
        if (body?.size !== undefined) {
          const s = String(body.size).trim();
          if (!/^\d{3,4}x\d{3,4}$/.test(s)) return sendJson(res, { ok: false, error: 'size 格式应为 宽x高，如 1024x1024' });
          if (cfgd.socialV2.draw.size !== s) { cfgd.socialV2.draw.size = s; changed = true; }
        }
        for (const k of ['dailyLimit', 'momentDailyLimit']) {
          if (body?.[k] !== undefined) {
            const n = Math.max(1, Math.min(500, Math.floor(Number(body[k]) || 0)));
            if (cfgd.socialV2.draw[k] !== n) { cfgd.socialV2.draw[k] = n; changed = true; }
          }
        }
        if (changed) writeJson(configFile(), cfgd);
        let botsRestarted = false;
        if (changed) { try { botsRestarted = await restartBotsFor('qq'); } catch { botsRestarted = false; } }
        let preview = null;
        if (String(body?.text ?? '').trim()) {
          try {
            const { generateImage } = await import(pathToFileURL(path.join(codeRoot(), 'src', 'draw.js')).href);
            const r = await generateImage(String(body.text));
            preview = { name: path.basename(r.path), provider: r.provider, bytes: r.bytes };
          } catch (error) {
            return sendJson(res, { ok: false, error: `出图失败：${error?.message ?? error}`, botsRestarted });
          }
        }
        const outCustom = Array.isArray(cfgd.socialV2.draw.custom)
          ? cfgd.socialV2.draw.custom.map(normalizeCustomDraw).filter(Boolean)
          : [];
        return sendJson(res, {
          ok: true, changed, botsRestarted, preview,
          provider: cfgd.socialV2.draw.provider,
          custom: outCustom
        });
      }
    }
    if (p === '/api/image-library') {
      const listImages = (dir, base) => {
        const out = [];
        let entries = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
        for (const e of entries) {
          if (e.name.startsWith('.')) continue;
          const rel = base ? `${base}/${e.name}` : e.name;
          const full = path.join(dir, e.name);
          if (e.isDirectory()) out.push(...listImages(full, rel));
          else if (IMAGE_EXTS.includes(path.extname(e.name).toLowerCase())) {
            let size = 0;
            try { size = fs.statSync(full).size; } catch { /* 读不到就算 0 */ }
            out.push({ name: rel, size });
          }
        }
        return out;
      };
      if (req.method === 'GET') {
        const files = listImages(imageLibraryDir(), '').sort((a, b) => a.name.localeCompare(b.name, 'zh'));
        return sendJson(res, { ok: true, dir: imageLibraryDir(), files });
      }
      if (req.method === 'POST') {
        // 上传：{ name, dataB64 }。名字只取 basename、限图片扩展名、限 30MB ——
        // 这个目录是模型的图库，不能让它变成任意文件写入点。
        const body = await readBody(req);
        const base = path.basename(String(body?.name ?? '')).replace(/[\\/:*?"<>|]/g, '');
        if (!base || !IMAGE_EXTS.includes(path.extname(base).toLowerCase())) {
          return sendJson(res, { ok: false, error: '文件名要带图片扩展名（png/jpg/webp/gif）' });
        }
        let buf;
        try {
          buf = Buffer.from(String(body?.dataB64 ?? ''), 'base64');
        } catch {
          return sendJson(res, { ok: false, error: '文件内容不是合法的 base64' });
        }
        if (buf.length < 500) return sendJson(res, { ok: false, error: '文件太小，不像有效图片' });
        if (buf.length > 30 * 1024 * 1024) return sendJson(res, { ok: false, error: '超过 30MB 上限' });
        try {
          fs.mkdirSync(imageLibraryDir(), { recursive: true });
          fs.writeFileSync(path.join(imageLibraryDir(), base), buf);
          return sendJson(res, { ok: true, name: base, bytes: buf.length });
        } catch (error) {
          return sendJson(res, { ok: false, error: String(error?.message ?? error) });
        }
      }
      if (req.method === 'DELETE') {
        const rel = String(url.searchParams.get('name') ?? '').trim();
        const libDir = path.resolve(imageLibraryDir());
        const full = path.resolve(libDir, rel);
        if (!full.startsWith(libDir + path.sep) || !path.extname(full)) {
          return sendJson(res, { ok: false, error: '非法的文件名' });
        }
        try {
          fs.rmSync(full, { force: true });
          return sendJson(res, { ok: true });
        } catch (error) {
          return sendJson(res, { ok: false, error: String(error?.message ?? error) });
        }
      }
    }
    if (p === '/api/image-library/file') {
      // 看图：把库里的图片给浏览器展示（只允许库目录内的文件，防目录穿越）。
      const rel = String(url.searchParams.get('name') ?? '').trim();
      const libDir = path.resolve(imageLibraryDir());
      const full = path.resolve(libDir, rel);
      let ok = false;
      try {
        ok = full.startsWith(libDir + path.sep) && fs.existsSync(full) && fs.statSync(full).isFile();
      } catch { ok = false; }
      if (!ok) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('not found');
        return;
      }
      const types = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
      res.writeHead(200, { 'content-type': types[path.extname(full).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(fs.readFileSync(full));
      return;
    }

    if (p === '/api/tools') {

      if (req.method === 'GET') {
        const cfg = loadConfig();
        const values = {};
        const defaults = {};
        for (const g of TOOL_GROUPS) {
          for (const it of g.items) {
            if (it.ns === 'computer') {
              // 电脑操作用专属命名空间 config.computerTools，由 oc-config 生成权限时消费。
              // 不放 config.tools 下：config.json 里历史上还有一个扁平的 "tools" 键
              // （社交工具标志的旧副本），重复键会让「谁后写谁生效」变成玄学。
              values[it.flag] = cfg.computerTools?.[it.flag] === true;
              defaults[it.flag] = false;
              continue;
            }
            const v = cfg.socialV2?.tools?.[it.flag];
            values[it.flag] = typeof v === 'boolean' ? v : it.default !== false;
            defaults[it.flag] = it.default !== false;
          }
        }
        return sendJson(res, {
          ok: true,
          groups: TOOL_GROUPS,
          values,
          // 前端预设直接用这几份，不重复维护一份表
          presets: {
            standard: defaults,
            readonlyOff: [...TOOL_PRESET_READONLY],
            // 两个模式预设：只聊天 = 出厂默认且电脑操作全关；可以干活 = 出厂默认且电脑操作全开
            chat: { ...defaults, computerRead: false, computerWrite: false, computerEdit: false, computerGlob: false, computerGrep: false, computerShell: false },
            work: { ...defaults, computerRead: true, computerWrite: true, computerEdit: true, computerGlob: true, computerGrep: true, computerShell: true }
          },
          chatOnly: cfg.socialV2?.chatOnly === true
        });
      }

      const body = await readBody(req);
      const incoming = body?.values ?? {};
      const cfg = loadConfig();
      if (!cfg.socialV2 || typeof cfg.socialV2 !== 'object') cfg.socialV2 = {};
      if (!cfg.socialV2.tools || typeof cfg.socialV2.tools !== 'object') cfg.socialV2.tools = {};
      if (!cfg.computerTools || typeof cfg.computerTools !== 'object') cfg.computerTools = {};

      let changed = 0;
      for (const g of TOOL_GROUPS) {
        for (const it of g.items) {
          if (!(it.flag in incoming)) continue;
          const next = incoming[it.flag] === true;
          if (it.ns === 'computer') {
            if (cfg.computerTools[it.flag] === next) continue;
            cfg.computerTools[it.flag] = next;
            changed += 1;
            continue;
          }
          if (cfg.socialV2.tools[it.flag] === next) continue;
          cfg.socialV2.tools[it.flag] = next;
          changed += 1;
        }
      }
      let applied = false;
      let regenError;
      if (changed) {
        writeJson(configFile(), cfg);
        // 「电脑操作」直接决定 opencode.json 的 agent 权限，聊天工具表也是桥接启动时读的——
        // 索性保存即生效：重新生成配置，再把在跑的 BOT 就地重启（几秒空窗）。
        const regen = await regenerateConfig();
        if (regen.ok) {
          if (bridge.child) applied = await restartBotsFor('qq');
          if (wechat.child) applied = (await restartBotsFor('wechat')) || applied;
        } else {
          regenError = (regen.lines ?? []).filter((l) => l.trim()).slice(-2).join(' ｜ ');
        }
      }
      return sendJson(res, { ok: true, changed, applied, regenError, needRestart: changed > 0 && !applied });
    }

    /* 原始配置文件读写 —— 「高级」页最后一道口子。
     * 只认白名单里的三个文件：别的路径一律不认，免得这个接口变成任意文件读写。 */
    if (p === '/api/raw') {
      const RAW_FILES = {
        config: configFile(),
        models: modelsFile(),
        proxy: path.join(dataRoot(), 'proxy.json')
      };
      const which = String(url.searchParams.get('file') ?? 'config');
      if (which === 'secrets') {
        return sendJson(res, { ok: false, error: '密钥文件不能通过原始配置接口读取或写入' }, 403);
      }
      const file = RAW_FILES[which];
      if (!file) return sendJson(res, { ok: false, error: `不认识的配置文件：${which}` });
      if (req.method === 'GET') {
        let content = '';
        try {
          content = fs.readFileSync(file, 'utf8');
        } catch {
          content = '';
        }
        return sendJson(res, { ok: true, file: which, path: file, content, exists: Boolean(content) });
      }
      const body = await readBody(req);
      const text = String(body.content ?? '');
      if (text.length > 4 * 1024 * 1024) {
        return sendJson(res, { ok: false, error: '内容太大（上限 4 MB）' });
      }
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        return sendJson(res, { ok: false, error: `不是合法 JSON：${error?.message ?? error}` });
      }
      // 语法合法 ≠ 结构可用：`null` / `[]` / `{}` 都能通过 JSON.parse，
      // 但写进 config.json 后下次启动就是「整份配置读不回来」或者被当成空配置。
      // 只做最低限度、不会挡住正常手改的校验（顶层形状 + 关键段的类型）。
      const shapeError = rawFileShapeError(which, parsed);
      if (shapeError) return sendJson(res, { ok: false, error: shapeError });
      // 写之前留一份，改坏了能从 state/config-backups 捞回来
      try {
        if (fs.existsSync(file)) {
          const dir = path.join(dataRoot(), 'state', 'config-backups');
          fs.mkdirSync(dir, { recursive: true });
          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          fs.copyFileSync(file, path.join(dir, `${which}.${stamp}.json`));
        }
      } catch { /* 备份失败不拦保存 */ }
      fs.writeFileSync(file, text, 'utf8');
      pushLog(`手动编辑已保存：${path.basename(file)}`, 'sys', 'app');
      return sendJson(res, { ok: true, file: which });
    }

    if (p === '/api/providers/import') {
      // 这个端点会往 secrets.json 写东西，所以入口先把形状钉死：
      // 之前是 `importProviders(body)` 直接透传，body 是数组 / 字符串也会进到
      // 下游分类器里（那边按 `text` 拆行，`apply` 为真就写盘）。
      if (req.method !== 'POST') return sendJson(res, { ok: false, error: '只支持 POST' }, 405);
      const body = await readBody(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return sendJson(res, { ok: false, error: '请求体必须是 JSON 对象' });
      }
      if (body.text !== undefined && typeof body.text !== 'string') {
        return sendJson(res, { ok: false, error: 'text 必须是字符串' });
      }
      if (String(body.text ?? '').length > 200_000) {
        return sendJson(res, { ok: false, error: 'text 太大（上限 200 KB）' });
      }
      if (body.apply !== undefined && typeof body.apply !== 'boolean') {
        return sendJson(res, { ok: false, error: 'apply 必须是布尔值' });
      }
      if (body.items !== undefined && !Array.isArray(body.items)) {
        return sendJson(res, { ok: false, error: 'items 必须是数组' });
      }
      if (Array.isArray(body.items) && body.items.length > 500) {
        return sendJson(res, { ok: false, error: 'items 最多 500 条' });
      }
      return sendJson(res, importProviders(body));
    }

    if (p === '/api/bridge/start') {
      try {
        await repairModelConfiguration();
      } catch (error) {
        pushLog(`模型配置自动修复失败（继续启动桥接）：${error?.message ?? error}`, 'err', 'models');
      }
      return sendJson(res, startBridge());
    }
    if (p === '/api/bridge/stop') {
      const result = stopBridge();
      if (result.done) await result.done;
      return sendJson(res, result);
    }

    if (p === '/api/napcat/panel') {
      return sendJson(res, napcatPanel(url.searchParams.get('account') || DEFAULT_ACCOUNT_ID));
    }

    /* NapCat 面板开在应用内的子窗口里（Electron 主进程注入 opener）。
     * 面板地址是 NapCat WebUI——NapCat 没在跑时它就是死链，直接开窗必然白屏。
     * 所以先探活：没跑就顺手拉起并等端口通了再开；等不到就把人话带回前端。
     * 裸跑（node server.mjs）没有 Electron：返回 inApp:false，前端自己开新标签。 */
    if (p === '/api/napcat/window') {
      const accountId = url.searchParams.get('account') || DEFAULT_ACCOUNT_ID;
      let panel = napcatPanel(accountId);
      if (!panel.ok) return sendJson(res, panel);
      if (!(await probePort(panel.port))) {
        const started = startNapcat(accountId);
        if (!started.ok) return sendJson(res, { ok: false, error: `NapCat 没在跑，自动启动失败：${started.error ?? '未知原因'}` });
        pushLog(`[${accountId}] NapCat 没在跑，已自动拉起，等面板端口就绪…`, 'sys', 'napcat');
        const ready = await waitForPort(panel.port, 20_000);
        panel = napcatPanel(accountId);
        if (!ready || !(await probePort(panel.port))) {
          return sendJson(res, { ok: false, error: 'NapCat 拉起来了，但面板端口 20 秒内没通——看日志页的 NapCat 输出，稍等再点一次' });
        }
      }
      // NapCat 启动时会轮换 WebUI token，且落盘晚于端口就绪——立刻开窗可能带着旧
      // token，面板就会要求手动登录（0.4.2 实测踩到）。等 webui.json 里的 token
      // 连续两次一致（或满 5 秒）再开窗。
      for (let i = 0; i < 4; i++) {
        const prev = napcatPanel(accountId);
        await new Promise((r2) => setTimeout(r2, 1250));
        const next = napcatPanel(accountId);
        if (next.ok && prev.ok && next.token === prev.token) { panel = next; break; }
        panel = next;
      }
      const opener = globalThis.dhmOpenChildWindow;
      if (typeof opener === 'function') {
        try {
          opener(panel.url, `NapCat 面板 ${accountId} — 扫码 / 快登`);
          return sendJson(res, { ok: true, inApp: true, url: panel.url });
        } catch (error) {
          return sendJson(res, { ok: true, inApp: false, url: panel.url, warn: String(error?.message ?? error) });
        }
      }
      return sendJson(res, { ok: true, inApp: false, url: panel.url });
    }

    if (p === '/api/logs') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      });
      // 补发最近日志，新连上的窗口不会看到空白
      for (const entry of logs) res.write(`data: ${JSON.stringify(entry)}\n\n`);
      logClients.add(res);
      req.on('close', () => logClients.delete(res));
      return;
    }

    return serveStatic(req, res, p);
  } catch (error) {
    return sendJson(res, { ok: false, error: String(error?.message ?? error) }, 500);
  }
});

/** 监听一次。失败必须 reject —— 不挂 error 监听的话 EADDRINUSE 会变成未捕获异常，直接弹红框。 */
/** 配置保存后让 BOT 立刻生效：只重启受影响平台、且正在跑的那个。 */
async function restartBotsFor(platform) {
  let restarted = false;
  try {
    if (platform === 'wechat') {
      if (wechat.child) {
        const stopped = stopWechat();
        // stopWechat 现在会顺带停 4601 实例；等它真停完再拉新的，避免撞端口。
        if (stopped.done) await stopped.done;
        startWechat();
        restarted = true;
      }
    } else if (bridge.child) {
      restarted = (await restartBridge()).ok === true;
    }
  } catch { /* 重启失败不打断保存 */ }
  return restarted;
}

function listenOnce(port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      const actual = server.address().port;
      pushLog(`桌面服务已就绪：http://127.0.0.1:${actual}`, 'sys');
      resolve({ port: actual, url: `http://127.0.0.1:${actual}` });
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

/**
 * 起服务。端口被占就自动往后找，不跟用户报错。
 * 常见场景：上一次没退干净、或者同时开了开发模式。
 * 最后一个候选是 0 —— 让系统随便给一个，基本不可能失败。
 */
export async function startServer(preferred = PORT) {
  const candidates = [
    preferred,
    ...Array.from({ length: 9 }, (_, i) => preferred + i + 1),
    0
  ];

  let lastError;
  for (const port of candidates) {
    try {
      const result = await listenOnce(port);
      // NapCat 常常是开机自启或手动开的，等用户点「一键启动」才挂日志就太晚了
      for (const acc of napcatAccounts()) {
        if (acc.dir) {
          ensureNapcatFileLog(acc.dir);
          startNapcatTail(acc.id);
        }
      }
      initAutomation();
      // 手机推送是可选功能，没启用时这里什么都不做（也不会占端口）
      if (phoneSettings().enabled) startPhoneListener();
      scheduleNapcatUpdateCheck();
      scheduleAppUpdateCheck();
      // QQ 官方机器人（多号）：配置里启用的号随软件一起起来
      try {
        for (const bot of qqOfficialBotList()) {
          if (bot.enabled && bot.appSecret) setTimeout(() => startQqOfficial(bot.appId), 5000);
        }
      } catch { /* 配置读不了就当没配 */ }
      if (port !== preferred) {
        pushLog(`端口 ${preferred} 被占用，改用 ${result.port}`, 'sys');
      }
      return result;
    } catch (error) {
      lastError = error;
      if (error?.code !== 'EADDRINUSE') throw error;
    }
  }
  throw lastError;
}

/**
 * 关掉本窗口拉起来的全部后台服务，包括桥接管理的模型 API 服务。
 *
 * 这是「关软件」和「后台进程还在」之间的那道闸：Electron 自己退出**不会**带走
 * 子进程，必须显式收。顺序是先停服务、再关 HTTP —— 这样关停过程中的日志还能
 * 从日志页看到。返回的 Promise 会等 taskkill 和 NapCat 进程真正退出后才 resolve，
 * 主进程（desktop/shutdown.mjs）要 await 它，否则窗口先没了照样留孤儿进程。
 */
let shutdownPromise = null;

export function shutdownServer() {
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true;
  pushLog('正在关闭后台服务（QQ 桥接 / 微信 / NapCat / 模型 API）…', 'sys');

  shutdownPromise = (async () => {
    stopPhoneListener();
    stopNapcatTail();

    const bridgeResult = stopBridge();
    const wechatResult = stopWechat();
    const napcatResult = stopAllNapcat();

    // 等每一路真的收完，再把结果并进返回值 —— 界面和测试都按「ok/killed」看，
    // 不需要知道内部那个 done Promise。
    const settle = async (result) => {
      if (!result?.done) return result;
      try {
        return { ...result, ...(await result.done) };
      } catch (error) {
        return { ...result, ok: false, error: String(error?.message ?? error) };
      }
    };
    const [bridgeDone, wechatDone, napcatDone] = await Promise.all([
      settle(bridgeResult),
      settle(wechatResult),
      settle(napcatResult)
    ]);
    const modelApiDone = await stopManagedModelService();

    // HTTP 服务最后关。keep-alive 连接会卡住 close 的回调，所以主动断开 + 兜底超时。
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      try {
        server.close(finish);
      } catch {
        finish();
      }
      if (typeof server.closeAllConnections === 'function') {
        try { server.closeAllConnections(); } catch { /* 没连上就算了 */ }
      }
      setTimeout(finish, 1500).unref?.();
    });

    for (const res of logClients) {
      try { res.end(); } catch { /* 已经断了 */ }
    }
    logClients.clear();

    return { ok: true, bridge: bridgeDone, wechat: wechatDone, napcat: napcatDone, modelApi: modelApiDone };
  })();

  return shutdownPromise;
}

async function stopManagedModelService(platform = null, options = {}) {
  // 不传 platform = 两个实例都停；只有全停时才收共享的 cf-shim。
  const stopShim = options.stopShim ?? platform == null;
  const previousDataRoot = process.env.QQ_BRIDGE_DATA;
  const previousStateDir = process.env.QQ_BRIDGE_STATE_DIR;
  const previousPlatform = process.env.QQ_BRIDGE_MODEL_PLATFORM;
  process.env.QQ_BRIDGE_DATA = dataRoot();
  delete process.env.QQ_BRIDGE_MODEL_PLATFORM;
  process.env.QQ_BRIDGE_STATE_DIR = matrixStateDir('qq');
  try {
    const runtime = await import(pathToFileURL(path.join(codeRoot(), 'src', 'oc-server.js')).href);
    const envModule = await import(pathToFileURL(path.join(codeRoot(), 'src', 'oc-env.js')).href);
    const log = (message) => pushLog(message, 'sys', 'bridge');
    const platforms = platform ? [platform] : ['qq', 'wechat'];
    const results = [];
    for (const pf of platforms) {
      const instance = envModule.resolveModelInstance(pf, { root: dataRoot(), useEnv: false });
      results.push(await runtime.stopServer({ log, instance, stopShim: false }));
    }
    let shim = false;
    if (stopShim) {
      const instance = envModule.resolveModelInstance('qq', { root: dataRoot(), useEnv: false });
      shim = await runtime.stopShimService({ log, instance });
    }
    if (platform) return { ...results[0], shim };
    return {
      server: results.some((result) => result.server === true),
      shim,
      instances: Object.fromEntries(platforms.map((pf, index) => [pf, results[index]]))
    };
  } catch (error) {
    const message = `关闭模型 API 服务失败：${error?.message ?? error}`;
    pushLog(message, 'err', 'bridge');
    return { server: false, shim: false, error: message };
  } finally {
    if (previousDataRoot === undefined) delete process.env.QQ_BRIDGE_DATA;
    else process.env.QQ_BRIDGE_DATA = previousDataRoot;
    if (previousStateDir === undefined) delete process.env.QQ_BRIDGE_STATE_DIR;
    else process.env.QQ_BRIDGE_STATE_DIR = previousStateDir;
    if (previousPlatform === undefined) delete process.env.QQ_BRIDGE_MODEL_PLATFORM;
    else process.env.QQ_BRIDGE_MODEL_PLATFORM = previousPlatform;
  }
}

/* 直接 `node server.mjs` 时自己起服务。
 *
 * ⚠️ 比 realpath，不能比 `fileURLToPath(import.meta.url) === path.resolve(argv[1])`：
 * 本项目目录常被做成 junction 绕开中文路径（`C:\Users\<用户>\DualHabitatMatrix` →
 * `Documents\默认项目\DualHabitat-Matrix`），经 junction 调用时两边字符串不相等，
 * 服务就静默不起来了。同样的坑在 `src/oc-config.js` 也踩过一次。 */
const isDirectRun = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(entry);
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  const { url } = await startServer();
  console.log(`桌面端已启动：${url}`);

  // 裸跑（node server.mjs）时 Ctrl+C / 关闭终端也要把子进程收掉。
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, async () => {
      try {
        await shutdownServer();
      } finally {
        process.exit(0);
      }
    });
  }
}
