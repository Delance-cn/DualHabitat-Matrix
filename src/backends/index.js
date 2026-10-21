/**
 * backends/index.js —— 后端工厂：把「任意 agent」接成 QQ / 微信的对话大脑。
 *
 * `bridge.js` 原本在 2249 行直接 `new NodeApiClient(...)`。改成：
 *
 *     const api = createBackend(cfg.backend, { secrets, log });
 *
 * 不配 `backend` 段时返回 null，调用方退回内置的矩阵隔离实例 —— **完全向后兼容**。
 *
 * ── 想接自己的 agent（包括你现在正在用的这种对话界面）──────────────────
 * 契约写在同目录 `CONTRACT.md`：照它实现 sessions / workspace / events 那几个
 * 方法、产出同样的信封与事件帧，然后在下面 `createBackend` 加一个分支就行。
 * QQ 侧、仿真引擎、黑话学习、账本、控制台全都不用改 —— 它们只认契约，不认是谁。
 */

import { ModelApiBackend } from './model-api.js';
import { UiBackend } from './ui/engine.js';
import { CliBackend } from './cli/engine.js';
import { getDriver, DRIVERS, UNVERIFIED, makeGenericDriver } from './cli/drivers.js';
import { listProviders, resolveProfile, listModels, PROVIDERS } from './providers.js';

export const BACKEND_TYPES = ['matrix', 'model-api', 'cli', 'ui'];

/**
 * 后端类型改名的对照表。
 *
 * 2026-10 之前，内置那一档叫 `opencode`（那是引擎的名字）。现在叫 `matrix`：
 * 它同时是「谁都能接进来」这层接口的名字。老 config.json 里还写着旧值，
 * 这里认一次 —— 不然升级完直接打不着火，而且报错只会说"不认识的后端类型"。
 */
const LEGACY_TYPES = { opencode: 'matrix' };

/** 后端类型 → 界面上给人看的说法。日志、报错、控制台都用它，别在别处硬写。 */
export const TYPE_LABELS = {
  matrix: 'API 实例',
  'model-api': '直连模型 API',
  cli: 'CLI Agent',
  ui: '前台客户端'
};

/**
 * 按配置建后端。
 *
 * @param {object|null} config  config.json 的 backend 段
 * @param {object} [options]
 * @param {Record<string,string>} [options.secrets]  secrets.json 内容
 * @param {string} [options.stateDir]
 * @param {(msg:string)=>void} [options.log]
 * @returns {object|null} null 表示"不动适配器，用内置的矩阵隔离实例"
 */
export function createBackend(config, options = {}) {
  const type = LEGACY_TYPES[config?.type] ?? config?.type;
  if (!type || type === 'matrix') return null;

  const log = options.log ?? (() => {});
  const stateDir = options.stateDir ?? config.stateDir;

  if (type === 'model-api') {
    const profile = resolveProfile(config.modelApi ?? {}, options.secrets ?? {});
    return new ModelApiBackend({ ...profile, stateDir, log });
  }

  if (type === 'ui') {
    return new UiBackend({ ui: config.ui ?? {}, timeoutMs: config.timeoutMs, stateDir, log });
  }

  if (type === 'cli') {
    const cli = config.cli ?? {};
    const driver = cli.customDriver ? makeGenericDriver(cli.customDriver) : getDriver(cli.driver ?? 'claude-code');
    return new CliBackend({
      driver,
      bin: cli.bin,
      options: cli.options ?? {},
      allowTools: cli.allowTools === true,
      timeoutMs: cli.timeoutMs,
      stateDir,
      log
    });
  }

  throw new Error(
    `不认识的后端类型 "${config.type}"，可选：${BACKEND_TYPES.join(' / ')}` +
      `（老配置里的 "opencode" 仍然认，等同 "matrix"）`
  );
}

/** 给控制台渲染用：后端清单 + 厂商清单 + 已核实的 CLI 驱动。 */
export function describeBackends() {
  return {
    types: [
      // label / note 一律按 TYPE_LABELS 的口径 —— 界面上不许出现引擎的牌子
      { id: 'matrix', label: 'API 实例', note: '有工具、能记事，桥接自己拉起' },
      { id: 'model-api', label: '直连模型 API', note: '最快、最便宜，无工具' },
      { id: 'cli', label: 'CLI Agent', note: '有工具、能干活，但冷启动慢' },
      { id: 'ui', label: '前台客户端', note: '驱动本机已登录的 AI 客户端窗口；不耗 API，一次只跑一个窗口' }
    ],
    providers: listProviders(),
    cliDrivers: Object.values(DRIVERS).map((d) => ({
      id: d.id,
      label: d.label,
      bin: d.bin,
      verified: d.verified,
      promptVia: d.promptVia ?? 'stdin',
      optionsSchema: d.optionsSchema ?? []
    })),
    unverifiedClis: UNVERIFIED
  };
}

export {
  ModelApiBackend,
  CliBackend,
  UiBackend,
  getDriver,
  DRIVERS,
  UNVERIFIED,
  makeGenericDriver,
  listProviders,
  resolveProfile,
  listModels,
  PROVIDERS
};
