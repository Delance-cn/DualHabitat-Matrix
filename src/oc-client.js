/**
 * oc-client.js —— 模型 API 版客户端，用来替代上游的 `src/dsh-client.js`。
 *
 * ## 为什么是"门面"而不是重写
 *
 * `bridge.js` 有 1.1 万行，但真正伸手到 DSH 客户端的地方只有 4 个入口：
 *
 *     import { NodeApiClient, unwrap, createTurnCollector, discoverDshLaunchToken } from './dsh-client.js';
 *
 * 以及 12 个方法调用：sessions.{create,list,prompt,selectModel} /
 * workspace.{create,rename,archiveSession} / events.{follow,mux} /
 * agentPresets.list / settings.{describe,update}，外加 api.respond 与
 * api.stopSessionWork。
 *
 * 所以本文件的做法是：**对外提供一模一样的形状**（连方法名、返回值信封、
 * frame 类型都保持一致），只在内部把 模型 API 的 HTTP/事件 API 翻译过去。
 * 这样 QQ 侧、社交仿真、黑话学习、账本、控制台**全都原样复用**，
 * 改动面从"整个项目"缩到"事件生产层"。
 *
 * ## 两个必须记牢的翻译原则
 *
 * 1. **只信事件，不信模型文本**。Phase 0 实测：工具被权限藏掉时，模型不会说
 *    "我没有工具"，而是**编造执行结果**。所以业务侧判断"发生了什么"必须依据
 *    `session.tool.*` 事件，本文件只负责忠实翻译，不做任何推断。
 * 2. **信封保持 DSH 形状**。所有方法返回 `{ result: { ok, value | error } }`，
 *    好让 `unwrap()` 原样可用；`mux()` 产出的仍是 `{ rpcId, payload: frame }`。
 *
 * ## 已知的语义落差（见 docs/PHASE0-FINDINGS.md 第五节）
 *
 * - 没有 workspace 概念 → 用"目录"模拟，`workspaceId` 就是目录路径。
 * - 没有 archive → 退化成 interrupt（可在配置里改成真删除，默认不删，怕丢历史账）。
 * - 没有 settings 命名空间 → 用本项目的 JSON 文件兜底（QQ 侧只拿它存 mode / ownerQQ）。
 * - 免费模型 cost 恒为 0 → 花费由 `token-ledger` + 自建价目表算，不依赖 provider 报价。
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
// 引擎自带的 SDK 包名改不了（`@opencode/client`），但**本地别名**不带引擎牌子：
// 业务代码只认 `Sdk`。注意导出名就是 `OpenCode`（包内 `dist/promise/index.js`），
// 写成 `import { Sdk }` 会在模块加载阶段直接抛 "does not provide an export named 'Sdk'"，
// 桥接连启动都做不到 —— 改名时踩过一次，别再改回去。
import { OpenCode as Sdk } from '@opencode/client';
import { Service } from '@opencode/client/service';
import { KIND, ModelChain, candidateKey, classifyFailure } from './model-chain.js';
import { describePool, loadModelPool } from './model-pool.js';

const HR = '────';

/** 候选 → 模型 API 的模型引用形状（`switchModel` / `session.create` 都用它）。 */
function modelRefOf(candidate) {
  const ref = { providerID: candidate.providerID, id: candidate.id };
  if (candidate.variant) ref.variant = candidate.variant;
  return ref;
}

/* ══════════════════════════════════════════════════════════════════════════
 * 一、端点发现
 *
 * 隔离实例以 `opencode serve --service` 启动时会写一个注册文件（含 url 与
 * 随机密码）。**只有 --service 模式会写**，所以桥接必须按这个模式拉起服务。
 * 文件位置随 XDG state 目录走，故路径由调用方（config）决定。
 * ══════════════════════════════════════════════════════════════════════════ */

/** 注册文件的默认相对位置（相对 XDG state 根）。 */
export const SERVICE_FILE_RELATIVE = path.join('opencode', 'service.json');

/**
 * 解析注册文件路径。
 * @param {{ stateDir?: string, serviceFile?: string }} [options]
 */
export function resolveServiceFile({ stateDir, serviceFile } = {}) {
  if (serviceFile) return serviceFile;
  const root = stateDir || process.env.QQ_BRIDGE_STATE_DIR || path.join(process.cwd(), '.oc', 'state');
  return path.join(root, SERVICE_FILE_RELATIVE);
}

/**
 * 发现隔离实例端点（url + 鉴权）。
 * @returns {Promise<{url: string, auth?: object} | undefined>}
 */
export async function discoverMatrixEndpoint({ stateDir, serviceFile } = {}) {
  const file = resolveServiceFile({ stateDir, serviceFile });
  if (!fs.existsSync(file)) return undefined;
  const endpoint = await Service.discover({ file });
  if (!endpoint?.url) return undefined;
  // 顺手校验 pid 是否还活着：注册文件是"上次启动"留下的，进程可能已经死了。
  if (Number.isFinite(endpoint.pid)) {
    try {
      process.kill(endpoint.pid, 0);
    } catch {
      return undefined;
    }
  }
  return endpoint;
}

/**
 * 兼容上游名字。
 *
 * DSH 那套靠"从日志里猜 launch token"，模型 API 不需要它：鉴权走注册文件里的
 * 随机密码 + HTTP Basic（由 `Service.headers()` 生成）。保留这个导出是为了让
 * `bridge.js` 的 import 行不用动；返回值恒为 undefined，业务侧拿到 undefined
 * 会走"本地离线铸造"分支，在本实现里等于 no-op。
 */
export function discoverDshLaunchToken() {
  return undefined;
}

/**
 * 用发现到的端点建客户端。这是 `Service.headers()` 的唯一用途：
 * 它把 `{ password }` 翻成 HTTP Basic 头（**不是** Bearer）。
 */
export function makeMatrixClient(endpoint) {
  return Sdk.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });
}

/* ══════════════════════════════════════════════════════════════════════════
 * 二、与上游逐字一致的工具函数
 *
 * 这三个是"契约"，必须和 dsh-client.js 保持 bit 级一致，否则
 * bridge.js 的行为会悄悄漂移。改动前先对上游 diff。
 * ══════════════════════════════════════════════════════════════════════════ */

/** 把 RpcResponse 的结果槽解出来；业务错误直接抛出。 */
export function unwrap(response, label) {
  if (response.result.ok) return response.result.value;
  const { code, message } = response.result.error;
  throw new Error(`${label} failed: ${code}: ${message}`);
}

/** 在会话事件流里收集一次 turn 的 assistant 文本（按 turn 分组）。 */
export function createTurnCollector() {
  const turns = new Map(); // turn -> { text }
  return {
    /** 处理一条 session/event，返回该事件是否终结了一个 turn（此时可取最终文本）。 */
    push(event) {
      if (event.type === 'turn/start') {
        turns.set(event.data.turn, { text: '' });
        return null;
      }
      if (event.type === 'assistant/chunk') {
        // 忽略流式分块：assistant/message 携带同一内容的完整组装文本，
        // 两者都累加会导致回复文本翻倍（曾因此把「收到」发成「收到收到」）。
        return null;
      }
      if (event.type === 'assistant/message') {
        const t = turns.get(event.data.turn);
        if (!t) return null;
        for (const block of event.data.message?.content ?? []) {
          if (block?.type === 'text' && typeof block.text === 'string') t.text += block.text;
        }
        return null;
      }
      if (event.type === 'turn/end') {
        const t = turns.get(event.data.turn);
        turns.delete(event.data.turn);
        if (!t) return null;
        return { turn: event.data.turn, reason: event.data.reason, text: t.text };
      }
      return null;
    },
    has(turn) {
      return turns.has(turn);
    }
  };
}

/** 从 assistant 消息的 ContentBlock[] 中提取纯文本。 */
export function blocksToText(content) {
  return (content ?? [])
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
}

/**
 * 把 ContentBlock[] 里的**媒体块**翻成 模型 API 的 `files` 附件。
 *
 * 为什么必须有这一步（移植里最容易漏的一条）：
 *   - 上游 `bridge.js` 的 `resolveMediaList()` 会把 QQ 图片/表情拼成
 *     `{type:'image', mediaType, data:<base64>, name}`；
 *   - 而 模型 API 收图的口子是 `session.prompt({ files: [{uri, name}] })`
 *     （`SessionPromptInput.files`，见 @opencode/client 的 types.d.ts）。
 *
 * 不翻的话，`blocksToText()` 会把媒体块**整个丢掉** —— 图片静默变成空气，
 * 模型只会回"我没看到图"，而且全程不报错。
 *
 * uri 取用顺序（`uri` 显式给出时直接透传，方便测试不同形态）：
 *   1. `uri`   —— 原样透传（可以是 file:// 或 data:）
 *   2. `path`  —— 本地路径，转成 file:// URL
 *   3. `data`  —— base64，拼成 data: URL
 */
export function blocksToFiles(content) {
  const out = [];
  let i = 0;
  for (const b of content ?? []) {
    if (b?.type !== 'image' && b?.type !== 'file') continue;
    i += 1;
    const name = b.name ?? `media-${i}`;
    const uri =
      (typeof b.uri === 'string' && b.uri) ||
      (typeof b.path === 'string' && b.path ? pathToFileURL(b.path).href : null) ||
      (typeof b.data === 'string' && b.data
        ? `data:${b.mediaType ?? b.mime ?? 'application/octet-stream'};base64,${b.data}`
        : null);
    if (!uri) continue;
    out.push({ uri, name });
  }
  return out;
}

/* ══════════════════════════════════════════════════════════════════════════
 * 三、信封工具
 * ══════════════════════════════════════════════════════════════════════════ */

/** 成功信封。 */
export function ok(value) {
  return { result: { ok: true, value } };
}

/** 失败信封（`unwrap` 会把它翻成 throw）。 */
export function fail(code, message) {
  return { result: { ok: false, error: { code, message } } };
}

/** 把 Promise 的 reject 也收进信封，让调用方的 unwrap 统一处理错误。 */
async function envelope(label, run) {
  try {
    return ok(await run());
  } catch (error) {
    const message = String(error?.message ?? error ?? '未知错误');
    // "not-found" 这类走 error 分支，让 selectModel 的终态判定逻辑能识别。
    const code = /not[-_ ]?found/i.test(message) ? 'not-found' : 'internal';
    return fail(code, `${label}: ${message}`);
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * 四、模型 API 事件 → DSH frame 的翻译
 *
 * 这是整个移植里唯一"新写"的核心逻辑。翻译完，下游（collector、账本、QQ 发送、
 * 审批转发）就能原样工作。
 *
 * 实测形状（2026-10-17 / 模型 API 2.0.32，见 docs/PHASE0-FINDINGS.md）：
 *   session.execution.started              → 一个回合开始
 *   session.text.delta   -> data.delta     流式增量
 *   session.text.ended   -> data.text      该条消息的完整文本
 *   session.step.ended   -> data.tokens    本步用量 {input,output,reasoning,cache:{read,write}}
 *   session.tool.called / .success / .failed
 *   permission.asked                       需要客户端回复
 *   session.execution.succeeded|failed|interrupted  → 回合结束（**本机没有 session.idle**）
 *   session.retry.scheduled                provider 重试（不可用模型会连试 10 次）
 * ══════════════════════════════════════════════════════════════════════════ */

/** 模型 API 的 tokens → 账本能认的口径（`model-prices.normalizeUsage`）。 */
export function tokensToUsage(tokens) {
  if (!tokens || typeof tokens !== 'object') return undefined;
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return {
    // DSH 的 inputTokens 语义是"未命中缓存的部分"，模型 API 的 input 同义，
    // cache.read / cache.write 分开给，正好对上账本的两个桶。
    inputTokens: num(tokens.input),
    outputTokens: num(tokens.output),
    reasoningTokens: num(tokens.reasoning),
    cacheReadTokens: num(tokens.cache?.read),
    cacheWriteTokens: num(tokens.cache?.write)
  };
}

/** 回合结束事件的映射。 */
const EXECUTION_END = {
  'session.execution.succeeded': 'completed',
  'session.execution.failed': 'failed',
  'session.execution.interrupted': 'interrupted'
};

/* ══════════════════════════════════════════════════════════════════════════
 * 五、NodeApiClient —— DSH 同形状门面
 * ══════════════════════════════════════════════════════════════════════════ */

export class NodeApiClient {
  /**
   * 签名与上游一致：`new NodeApiClient(baseUrl, timeoutMs, auth)`。
   *
   * @param {string} [baseUrl] 不传则从注册文件发现（推荐）。
   * @param {number} [timeoutMs]
   * @param {object} [auth]
   * @param {string} [auth.stateDir]       XDG state 根（找注册文件）
   * @param {string} [auth.serviceFile]    直接指定注册文件
   * @param {string} [auth.sessionDir]     会话数据的落盘目录（settings 兜底用）
   * @param {string} [auth.modelDirectory] 模型目录校验所用的工作目录
   * @param {boolean} [auth.deleteArchived] true=archiveSession 真的删会话（默认只中断）
   * @param {(msg: string, err?: unknown) => void} [auth.log]
   */
  constructor(baseUrl, timeoutMs, auth = {}) {
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs ?? 30_000;
    this.auth = auth;
    this.log = auth.log ?? (() => {});

    this._endpoint = null;
    this._client = null;
    this._clientPromise = null;

    // workspaceId(=目录) → 目录；用于 sessions.create 解析 location.directory
    this._workspaces = new Map();
    // 已 follow 的会话（mux 是全局的，这里只是记录，便于诊断）
    this._followed = new Set();
    // `${clientId}:${eventId}` → { kind, sessionID, requestID | formID, questions }
    this._pending = new Map();
    // sessionID → { turn, step, retry, lastUsage }
    this._cursor = new Map();

    // sessionID → Map(callId → 工具名)。模型 API 的 `session.tool.called` 不带工具名，
    // 名字在更早的 `session.tool.input.started` 里，必须自己关联。
    this._toolNames = new Map();

    this._settingsFile = path.join(
      auth.sessionDir || process.env.QQ_BRIDGE_STATE_DIR || path.join(process.cwd(), '.oc', 'state'),
      'oc-settings.json'
    );

    /* ── 模型候选链（"上一个用光了自动换下一个"）───────────────────────────
     *
     * 放在门面里的原因：桥接只有到"发消息"这一步才知道回合失败，而失败原因
     * （余额不足 / 限流 / 模型不可用）只有门面看得到（它是唯一读事件流的人）。
     * 把熔断做在这里，QQ 侧 1.1 万行一行都不用动，而且失败对用户是无感的：
     * 失败的回合不产出文本，桥接就不会发消息，换模型重试是在同一个 turn 内完成的。
     */
    this._chain = null;
    this._chainNotice = '我这会儿 API 连不上了，等会儿再聊吧。';
    this._chainStateFile = path.join(
      auth.sessionDir || process.env.QQ_BRIDGE_STATE_DIR || path.join(process.cwd(), '.oc', 'state'),
      'model-chain.json'
    );
    // sessionID → 本轮已经产出过 assistant 文本？（有文本就不再重试，避免把两次的回复拼在一起）
    this._turnHasText = new Map();
    // 正在重试的会话：下一个 execution.started 必须**沿用原来的 turn 号**，
    // 否则桥接的 collector 按 turn 分组，新 turn 的文本会被整段丢掉。
    this._retryTurns = new Map(); // sessionID → 原 turn
    this._failoverTimers = new Map();
    this._failoverStartTimeoutMs = 60_000;
    // 已经开始换模型、但新回合还没起来的会话。这期间旧执行的
    // retry.scheduled / execution.failed / interrupted 全部丢弃 ——
    // 否则旧执行失败一次，就会把我们刚换上去的新模型也熔掉。
    this._failoverPending = new Set();
    // 已经由我们合成过 turn/end 的回合（"全部用完"时）。模型 API 之后真正
    // 结束这个回合时会产生重复的结束帧，按这张表丢掉。
    this._closedTurns = new Map(); // sessionID → turn
    // sessionID → 最后一次投递的文本（换模型后要用同样的话重发）
    this._lastPrompt = new Map();
    // 这张表必须落盘：额度耗尽往往发生在**重启之后**（刚换完模型链、刚改完配置）。
    // 内存版一重启就空，于是失败回合找不到原文 → 只能"按失败上报"，回复直接丢掉。
    this._lastPromptFile = path.join(path.dirname(this._chainStateFile), 'last-prompt.json');
    this._loadLastPrompt();
    // sessionID → 当前实际生效的候选（熔断时要知道"熔的是谁"）
    this._appliedModel = new Map();
    // 供 sessions.prompt() 往 mux 里注入合成帧（"全部用光"时要直接回一句）
    this._inject = null;
    // 候选是否已经按真实模型目录校验过（只校验一次，invalidate 后重来）
    this._chainValidated = false;

    // 模型池：显式传入的优先，否则读 models.json，再否则用默认池。
    const { pool, source, warnings } = loadModelPool({ inline: auth.models });
    for (const warning of warnings) this.log(`⚠️ 模型池：${warning}`);
    if (pool.enabled) {
      this.log(`模型池来自 ${source}`);
      this.configureModelChain(pool);
    } else {
      this.log('模型池已停用（enabled=false），退回"钉死单个模型"的行为');
    }
  }

  /**
   * 配置模型候选链。传 null / 不传即关闭（退回"钉死单个模型"的老行为）。
   *
   * @param {object|null} models
   * @param {Array<string|object>} [models.free]   免费候选，按优先级
   * @param {Array<string|object>} [models.paid]   付费候选
   * @param {boolean} [models.allowPaid=false]     付费开关（默认关，只走免费）
   * @param {object}  [models.cooldownMs]          覆盖默认冷却
   * @param {string}  [models.exhaustedNotice]     全部用完时回给 QQ 的那句话
   */
  configureModelChain(models) {
    if (!models || (!models.free?.length && !models.paid?.length)) {
      this._chain = null;
      return;
    }
    this._chainNotice = String(models.exhaustedNotice ?? '我这会儿 API 连不上了，等会儿再聊吧。');
    let health = null;
    try {
      if (fs.existsSync(this._chainStateFile)) {
        health = JSON.parse(fs.readFileSync(this._chainStateFile, 'utf8'));
      }
    } catch (error) {
      this.log(`模型链状态文件读不动，忽略：${error?.message ?? error}`);
    }
    this._chain = new ModelChain({
      free: models.free ?? [],
      paid: models.paid ?? [],
      allowPaid: models.allowPaid === true,
      cooldownMs: models.cooldownMs ?? {},
      health
    });
    this._chainValidated = false;
    this.log(`模型链已启用：${this._chain.status().map((s) => `${s.key}${s.usable ? '' : '(熔断中)'}`).join(' → ')}`);
    this.log(`模型池策略：${describePool({ ...models, exhaustedNotice: this._chainNotice })}`);
  }

  /**
   * 按真实模型目录剔除候选。
   *
   * 为什么必须做：池里写了目录里不存在的东西（最典型的是 `glm-4-flash` ——
   * 它确实免费，但**不在 模型 API 目录里**，要靠配置生成器写一条自定义模型条目），
   * 换到它头上时 `switchModel` 会失败，链就卡在那儿，后面的候选永远轮不到。
   * 启动时按目录清一遍，比跑到一半才发现好得多。
   */
  async _validateChainCandidates(client) {
    if (!this._chain || this._chainValidated) return;
    this._chainValidated = true;
    try {
      const listed = await client.model.list({
        location: { directory: this.auth.modelDirectory || process.cwd() }
      });
      const known = new Set();
      for (const model of listed?.data ?? []) {
        if (model?.providerID && model?.modelID) known.add(`${model.providerID}/${model.modelID}`);
      }
      if (known.size === 0) {
        this.log('⚠️ 模型目录是空的，跳过候选校验（候选原样保留）');
        return;
      }
      const dropped = this._chain.restrictTo(known);
      if (dropped.length) {
        this.log(`⚠️ 目录里没有这些候选，已从链里剔除：${dropped.join('、')}`);
        this._persistChain();
      }
    } catch (error) {
      this.log(`候选校验失败（保留原候选）：${error?.message ?? error}`);
    }
  }

  /**
   * 记住"这个会话最后一次收到的话"，换模型重试时要用它原样重发。
   *
   * 落盘的理由见 `_lastPrompt` 的定义处：重启后内存表是空的，而额度耗尽
   * 恰恰最爱发生在重启之后，那时失败回合就重发不了，回复会凭空消失。
   */
  _rememberPrompt(sessionId, value) {
    if (!sessionId || !value) return;
    this._lastPrompt.set(sessionId, { ...value, at: Date.now() });
    // 只留最近 200 条，免得文件无限长
    while (this._lastPrompt.size > 200) {
      const oldest = this._lastPrompt.keys().next().value;
      this._lastPrompt.delete(oldest);
    }
    this._persistLastPrompt();
  }

  _persistLastPrompt() {
    try {
      fs.mkdirSync(path.dirname(this._lastPromptFile), { recursive: true });
      const obj = {};
      for (const [k, v] of this._lastPrompt) obj[k] = v;
      fs.writeFileSync(this._lastPromptFile, JSON.stringify(obj), 'utf8');
    } catch (error) {
      this.log(`最后一次投递内容写盘失败：${error?.message ?? error}`);
    }
  }

  _loadLastPrompt() {
    try {
      if (!fs.existsSync(this._lastPromptFile)) return;
      const obj = JSON.parse(fs.readFileSync(this._lastPromptFile, 'utf8'));
      const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
      for (const [k, v] of Object.entries(obj || {})) {
        if (!v || typeof v !== 'object') continue;
        if (Number(v.at) && Number(v.at) < cutoff) continue; // 一周前的别拿来重发了
        this._lastPrompt.set(k, v);
      }
    } catch (error) {
      this.log(`最后一次投递内容读盘失败（忽略）：${error?.message ?? error}`);
    }
  }

  /** 把健康状态落盘，重启后不用重新踩一遍坑。 */
  _persistChain() {
    if (!this._chain) return;
    try {
      fs.mkdirSync(path.dirname(this._chainStateFile), { recursive: true });
      fs.writeFileSync(this._chainStateFile, JSON.stringify(this._chain.snapshot(), null, 2), 'utf8');
    } catch (error) {
      this.log(`模型链状态写盘失败：${error?.message ?? error}`);
    }
  }

  /** 当前应该用的模型（没有链时返回 null，调用方按老逻辑走）。 */
  currentModel() {
    return this._chain ? this._chain.pick() : null;
  }

  /** 模型链现状（控制台/日志用）。 */
  chainStatus() {
    return this._chain ? this._chain.status() : [];
  }

  /* ── 5.1 连接 ──────────────────────────────────────────────────────────── */

  async _ensureClient() {
    if (this._client) return this._client;
    if (this._clientPromise) return this._clientPromise;
    this._clientPromise = (async () => {
      let endpoint = null;
      if (typeof this.baseUrl === 'string' && /^https?:\/\//.test(this.baseUrl)) {
        endpoint = { url: this.baseUrl, auth: this.auth.token ? { type: 'basic', password: this.auth.token } : undefined };
      } else {
        endpoint = await discoverMatrixEndpoint({
          stateDir: this.auth.stateDir,
          serviceFile: this.auth.serviceFile
        });
      }
      if (!endpoint) {
        throw new Error(
          '找不到运行中的模型 API 服务。先在「运行」页把桥接拉起来一次（它会自己起一个），' +
            '或者确认 state 目录里的注册文件还在（默认在 .oc/state 下）。'
        );
      }
      this._endpoint = endpoint;
      this._client = makeMatrixClient(endpoint);
      // 客户端一就绪就按真实模型目录校验一遍候选（只做一次）
      await this._validateChainCandidates(this._client);
      return this._client;
    })();
    try {
      return await this._clientPromise;
    } catch (error) {
      this._clientPromise = null;
      throw error;
    }
  }

  /** 丢弃缓存的客户端（Instant 重启后注册文件会换）。 */
  invalidate() {
    this._client = null;
    this._clientPromise = null;
    this._endpoint = null;
    // 重启后目录可能变了（新 key 上新 provider、自定义条目增删），重新校验
    this._chainValidated = false;
    this._chain?.clearRestrictions();
    for (const timer of this._failoverTimers.values()) clearTimeout(timer);
    this._failoverTimers.clear();
    this._retryTurns.clear();
    this._failoverPending.clear();
  }

  get endpointUrl() {
    return this._endpoint?.url ?? this.baseUrl ?? null;
  }

  /** 上游有此方法（会话工作清理）。 */
  async close() {
    this.invalidate();
  }

  /**
   * 裸 RPC 入口（上游桥接用 `api.callUnary('session.modelCatalog')` 读模型能力）。
   *
   * 为什么必须实现：桥接拿它给控制台的「思考强度」下拉框取真实档位。缺了就是
   * TypeError —— 而那个错误被 catch 掉之后只打一行日志，表现是"档位永远只有内置
   * 那几档"，不会有人发现是移植漏了。所以这里按 DSH 的目录形状翻一遍 模型 API 的
   * 模型列表：providerID 分组，`variants` 的键就是档位 id。
   */
  async callUnary(method, params = {}) {
    if (method === 'session.modelCatalog' || method === 'session.models') {
      return envelope('session.modelCatalog', async () => {
        const client = await this._ensureClient();
        const directory = params.directory || params.workspaceId || process.cwd();
        const res = await client.model.list({ location: { directory } });
        const raw = res?.data ?? res?.models ?? res;
        const models = Array.isArray(raw) ? raw : [];
        const groups = new Map();
        for (const model of models) {
          const providerID = String(model?.providerID ?? model?.provider ?? 'unknown');
          const id = String(model?.modelID ?? model?.id ?? '');
          if (!id) continue;
          if (!groups.has(providerID)) groups.set(providerID, []);
          // 模型 API 把思维链开关暴露成 variants（实测 glm-4.5-flash = ["none","thinking"]）。
          const variants = model?.variants && typeof model.variants === 'object' ? Object.keys(model.variants) : [];
          groups.get(providerID).push({
            id,
            name: model?.name ?? id,
            inputModalities: model?.inputModalities ?? model?.modalities ?? ['text'],
            reasoning: variants.length
              ? {
                  efforts: variants.map((v) => ({ id: v, name: v, description: '' })),
                  defaultEffort: variants[0]
                }
              : undefined
          });
        }
        return {
          groups: [...groups.entries()].map(([id, list]) => ({ id, models: list }))
        };
      });
    }
    return fail('unsupported', `这个接口没有对应的 RPC ${method}（旧版专有接口）`);
  }

  /* ── 5.2 内部小工具 ───────────────────────────────────────────────────── */

  _cur(sessionId) {
    let c = this._cursor.get(sessionId);
    if (!c) {
      c = { turn: null, step: 0, retry: 0, seq: 0, lastUsage: null };
      this._cursor.set(sessionId, c);
    }
    return c;
  }

  _nextTurn(sessionId, hint) {
    const c = this._cur(sessionId);
    c.turn = hint ?? `turn-${++c.seq}`;
    c.step = 0;
    c.retry = 0;
    c.lastUsage = null;
    return c.turn;
  }

  _dirOfWorkspace(workspaceId) {
    return this._workspaces.get(workspaceId) ?? workspaceId ?? process.cwd();
  }

  /* ── 5.3 sessions.* ────────────────────────────────────────────────────── */

  get sessions() {
    const self = this;
    return {
      /**
       * DSH: `sessions.create({ workspaceId, agentPreset })` → `{ sessionId }`
       *
       * 模型 API: 会话直接绑在目录上（`location.directory`），agent 通过 `agent` 字段。
       * `agentPreset` 在这里天然映射为 模型 API 的 agent id。
       */
      async create(params = {}) {
        const directory = self._dirOfWorkspace(params.workspaceId);
        return envelope('session.create', async () => {
          const client = await self._ensureClient();
          const input = { location: { directory } };
          if (params.agentPreset) input.agent = String(params.agentPreset);
          if (params.title) input.title = String(params.title);
          // 模型链启用时以链为准（桥接稍后还会 selectModel 一次，两边保持一致）
          const chained = self._chain?.pick() ?? null;
          if (chained) input.model = modelRefOf(chained);
          else if (params.model) input.model = params.model;
          const session = await client.session.create(input);
          const sessionId = session?.id ?? session?.sessionID;
          if (!sessionId) throw new Error('session.create 没有返回 id');
          self._cur(sessionId);
          if (chained) self._appliedModel.set(sessionId, chained);
          return { sessionId, id: sessionId, directory };
        });
      },

      /** DSH: `sessions.list({})` → `{ items: [...] }` */
      async list(params = {}) {
        const directory = params.workspaceId ? self._dirOfWorkspace(params.workspaceId) : undefined;
        return envelope('session.list', async () => {
          const client = await self._ensureClient();
          const res = await client.session.list(directory ? { location: { directory } } : {});
          const raw = res?.data ?? res?.sessions ?? res?.items ?? res;
          const items = (Array.isArray(raw) ? raw : []).map((s) => ({
            sessionId: s.id ?? s.sessionID,
            origin: s.origin ?? 'user',
            parentSessionId: s.parentID ?? s.parentSessionId ?? null,
            cwd: s.directory ?? s.location?.directory ?? directory ?? null,
            title: s.title,
            archived: s.archived === true || s.timeArchived != null
          }));
          return { items };
        });
      },

      /**
       * DSH: `sessions.prompt({ sessionId, mode, content })` → 信封
       *
       * content 是 ContentBlock[]（上游用 `[{type:'text', text}]`），这里拼成纯文本
       * 再交给 模型 API。`mode:'queue'` 对应 模型 API 的排队语义（同一会话可连续 prompt）。
       */
      async prompt(params = {}) {
        const sessionId = params.sessionId ?? params.sessionID;
        const blocks = Array.isArray(params.content) ? params.content : [];
        const text = params.text ?? blocksToText(blocks);
        // 图片/文件附件：不翻就会静默丢掉（详见 blocksToFiles 的注释）
        const files = blocksToFiles(blocks);
        // 记下最后一次投递的**完整**内容：换模型重试时要用同样的话+同样的图重发
        if (text || files.length) self._rememberPrompt(sessionId, { text, files });

        // 模型链已经全部用尽：没必要再让 模型 API 把"不可用的模型"重试 10 次，
        // 直接合成一个正常回合把通知发出去。
        if (self._chain && self._inject && self._chain.allExhausted()) {
          const turn = self._nextTurn(sessionId);
          const time = Date.now();
          self.log(`模型链已全部用尽，直接回「${self._chainNotice}」（不再调用模型）`);
          self._inject({ type: 'session/event', sessionId, event: { type: 'turn/start', data: { turn } } });
          self._inject({
            type: 'session/event',
            sessionId,
            event: {
              type: 'assistant/message',
              time,
              data: {
                turn,
                step: 1,
                message: { role: 'assistant', content: [{ type: 'text', text: self._chainNotice }] }
              }
            }
          });
          self._inject({
            type: 'session/event',
            sessionId,
            event: { type: 'turn/end', time, data: { turn, reason: { kind: 'completed' } } }
          });
          return ok({ accepted: true, sessionId, result: { ok: true, value: { notice: self._chainNotice } } });
        }

        return envelope('session.prompt', async () => {
          const client = await self._ensureClient();
          const res = await client.session.prompt({
            sessionID: sessionId,
            text,
            ...(files.length ? { files } : {})
          });
          return { accepted: true, sessionId, result: res ?? null };
        });
      },

      /**
       * DSH: `sessions.selectModel({ sessionId, provider, model, reasoningEffort })`
       *   → `{ selected: { provider, model, reasoningEffort } }`
       *
       * 模型 API 的 switchModel 吃 `{ providerID, id, variant }`；reasoningEffort
       * 映射到 variant（实测 2.0.32 的模型目录里 variants 就是这个用途）。
       *
       * **模型链启用时**：忽略桥接传进来的固定模型，改用链里"顺序最靠前且可用"的候选。
       * 这样"上一个用光了自动换下一个"就不需要动 QQ 侧任何一行代码；
       * 桥接调完这个方法的语义仍然是"这个会话现在用某个模型"，它并不关心里面是谁。
       */
      async selectModel(params = {}) {
        const sessionId = params.sessionId ?? params.sessionID;
        const providerID = params.provider ?? params.providerID;
        const id = params.model ?? params.id;
        const chained = self._chain?.pick() ?? null;
        return envelope('session.selectModel', async () => {
          const client = await self._ensureClient();
          const model = chained ? modelRefOf(chained) : { providerID, id };
          if (!chained && params.reasoningEffort) model.variant = String(params.reasoningEffort);
          await client.session.switchModel({ sessionID: sessionId, model });
          if (chained) {
            self._appliedModel.set(sessionId, chained);
            self.log(`会话 ${sessionId} 使用模型链候选 ${candidateKey(chained)}`);
          }
          return {
            selected: {
              provider: model.providerID,
              model: model.id,
              reasoningEffort: model.variant ?? params.reasoningEffort ?? null
            }
          };
        });
      },

      /** 上游没有的便利方法，供桥接内部用。 */
      async stats(params = {}) {
        return envelope('session.stats', async () => {
          const client = await self._ensureClient();
          return client.session.stats(params.sessionId ? { sessionID: params.sessionId } : {});
        });
      },

      /** 读一次会话的历史消息（账本回填 / 控制台展示用）。 */
      async messages(params = {}) {
        const sessionId = params.sessionId ?? params.sessionID;
        return envelope('session.messages', async () => {
          const client = await self._ensureClient();
          const res = await client.session.messages({ sessionID: sessionId });
          const raw = res?.data ?? res?.messages ?? res;
          return { messages: Array.isArray(raw) ? raw : [] };
        });
      }
    };
  }

  /* ── 5.4 workspace.* （模型 API 没有这个概念，用目录模拟） ─────────────── */

  get workspace() {
    const self = this;
    return {
      /** DSH: `workspace.create({ path })` → `{ created, workspace: { workspaceId } }` */
      async create(params = {}) {
        const dir = params.path ? path.resolve(params.path) : process.cwd();
        const created = !self._workspaces.has(dir);
        self._workspaces.set(dir, dir);
        return ok({ created, workspace: { workspaceId: dir, path: dir, title: path.basename(dir) } });
      },

      /** DSH: `workspace.rename({ workspaceId, title })` —— 模型 API 无对应，记账即可。 */
      async rename(params = {}) {
        self.log(`workspace.rename: 模型 API 没有工作区标题，忽略（${params.title ?? ''}）`);
        return ok({ renamed: false });
      },

      /**
       * DSH: `workspace.archiveSession({ sessionId })`
       *
       * 模型 API 没有 archive。默认退化成 **interrupt**（停掉在跑的活儿，保留历史，
       * 免得丢掉已经花掉的钱的账）。想真删就把 `auth.deleteArchived` 打开。
       * 注意：真删是不可逆的，桥接会在"会话被换掉"时调这个方法，删错就没得救。
       */
      async archiveSession(params = {}) {
        const sessionId = params.sessionId ?? params.sessionID;
        return envelope('workspace.archiveSession', async () => {
          const client = await self._ensureClient();
          try {
            await client.session.interrupt({ sessionID: sessionId });
          } catch {
            /* 会话没在跑时 interrupt 可能报错，无妨 */
          }
          if (self.auth.deleteArchived === true) {
            await client.session.remove({ sessionID: sessionId });
          }
          self._followed.delete(sessionId);
          self._cursor.delete(sessionId);
          return { archived: true, deleted: self.auth.deleteArchived === true };
        });
      }
    };
  }

  /* ── 5.5 events.* ──────────────────────────────────────────────────────── */

  get events() {
    const self = this;
    return {
      /** DSH 里是"订阅某会话的流"。模型 API 的事件流是全局的，这里只做登记。 */
      follow(sessionId) {
        self._followed.add(sessionId);
        return { sessionId };
      },

      /**
       * DSH: `events.forget(sessionId)` —— 取消订阅。
       *
       * 模型 API 的事件流是全局的，没有逐会话订阅可退，这里只是把登记表里的
       * 那条清掉。**必须实现**：桥接在会话退役时会调它，缺了就是 TypeError，
       * 而那个异常发生在退役路径上，表现是"会话换不掉、一直对着旧会话重试"。
       */
      forget(sessionId) {
        self._followed.delete(sessionId);
        return { sessionId, forgotten: true };
      },

      /**
       * DSH: `events.mux({})` → AsyncIterable<{ rpcId, payload: frame }>
       *
       * 这是桥接的主循环数据源。连接断掉就抛错，让桥接的重连逻辑接手
       * （bridge.js 对 mux 是 `for(;;)` + try/catch 的用法）。
       */
      async *mux() {
        const client = await self._ensureClient();
        // 用队列而不是直接 yield：熔断要能"吞掉"失败回合的帧、并在同一 turn 内
        // 用新模型重跑；另外"全部用完"时 sessions.prompt() 也要能直接注入合成回合。
        const queue = [];
        let wake = null;
        let pumpError = null;
        let pumpDone = false;
        let seq = 0;
        const emit = (frame) => {
          queue.push(frame);
          if (wake) {
            const resolve = wake;
            wake = null;
            resolve();
          }
        };
        self._inject = emit;

        const pump = (async () => {
          for await (const event of client.event.subscribe()) {
            let frames;
            try {
              frames = self._translate(event);
            } catch (error) {
              self.log('事件翻译失败', error?.message ?? error);
              continue;
            }
            let adjusted = frames;
            try {
              adjusted = await self._applyFailover(event, frames, client);
            } catch (error) {
              // 熔断本身出错绝不能吃掉事件 —— 按原样转发，让上层照常报错。
              self.log('模型熔断处理异常（按原样转发）', error?.message ?? error);
            }
            for (const frame of adjusted ?? []) emit(frame);
          }
        })();
        pump
          .then(() => {
            pumpDone = true;
          })
          .catch((error) => {
            pumpError = error;
          })
          .finally(() => {
            self._inject = null;
            if (wake) {
              const resolve = wake;
              wake = null;
              resolve();
            }
          });

        for (;;) {
          while (queue.length) yield { rpcId: `oc-${++seq}`, payload: queue.shift() };
          if (pumpError) throw pumpError;
          if (pumpDone) return;
          await new Promise((resolve) => {
            wake = resolve;
          });
        }
      }
    };
  }

  /**
   * 回合失败时的模型熔断/降级。
   *
   * 核心约束（改之前务必理解）：**重试必须发生在同一个 DSH turn 内**。
   * 桥接的 collector 按 turn 号分组累积文本（`createTurnCollector`），并且按 turn
   * 一一对应地消耗"静默轮 / 唤醒轮"标记。如果失败就结束 turn 再开新 turn，
   * 轻则回复被丢弃（文本挂在新 turn 上，collector 里没有它），重则把静默标记错位、
   * 把本该静默的摘要回合当成正常回复发到群里。
   *
   * 所以这里的做法是：吞掉失败回合的全部帧，换模型后用同样的话重发，
   * 并让重试沿用**原来的 turn 号**。桥接全程只看到"一个 turn，最后成功了"。
   *
   * @returns {Promise<Array>} 调整后的帧（空数组 = 这一回合的帧被完全吞掉）
   */
  async _applyFailover(event, frames, client) {
    const type = event?.type;
    const d = event?.data ?? {};
    const sessionId = d.sessionID ?? d.sessionId ?? event?.sessionID;
    if (!sessionId) return frames;
    const self = this;

    if (type === 'session.execution.started') {
      this._turnHasText.set(sessionId, false);
      // 重试：沿用原 turn 号，且**不再发 turn/start**（桥接那边 collector 还开着）
      if (this._retryTurns.has(sessionId)) {
        clearTimeout(this._failoverTimers.get(sessionId));
        this._failoverTimers.delete(sessionId);
        const turn = this._retryTurns.get(sessionId);
        this._retryTurns.delete(sessionId);
        this._failoverPending.delete(sessionId);
        const c = this._cur(sessionId);
        c.turn = turn;
        c.step = 0;
        c.retry = 0;
        this.log(`回合重试开始 ${sessionId}（沿用 turn ${turn}）`);
        return [];
      }
      return frames;
    }

    if (!this._chain) return frames;

    if (type === 'session.text.ended') {
      // 换模型期间旧执行残余的文本一律丢弃，免得把失败的半截话带进新回合。
      if (this._failoverPending.has(sessionId)) return [];
      if (typeof d.text === 'string' && d.text.trim()) this._turnHasText.set(sessionId, true);
      return frames;
    }

    // 换模型期间，旧执行的这些事件全部丢弃（帧也不发）。
    if (this._failoverPending.has(sessionId)) {
      if (
        type === 'session.retry.scheduled' ||
        type === 'session.execution.failed' ||
        type === 'session.execution.interrupted'
      ) {
        this.log(`丢弃旧执行的 ${type}（换模型中）`);
        return [];
      }
      return frames;
    }

    const endFrame = (frames ?? []).find((f) => f.event?.type === 'turn/end');
    const endTurn = endFrame?.event?.data?.turn ?? this._cur(sessionId).turn;

    // 我们自己已经给这个回合收过尾了（"全部用完"）。模型 API 之后真正结束时
    // 还会再吐一个 turn/end，重发会给桥接造成重复的回合结束。
    if (this._closedTurns.get(sessionId) === endTurn) {
      this._closedTurns.delete(sessionId);
      return [];
    }

    if (type === 'session.execution.succeeded') {
      const applied = this._appliedModel.get(sessionId);
      if (applied && this._chain.status().some((s) => s.key === candidateKey(applied) && !s.usable)) {
        this._chain.markSuccess(applied);
        this._persistChain();
      }
      return frames;
    }
    if (type === 'session.execution.interrupted') return frames;

    // 失败信号有两种：
    //  · session.retry.scheduled：CLI 打算**原地**重试。不可用的模型（余额/无权/
    //    密钥错）在这里就该换掉 —— 等它把 10 次重试慢慢跑完没有意义，白等几十秒。
    //  · session.execution.failed：回合彻底失败。
    // 限流（429）是暂时性的，原地重试更划算，所以只在 execution.failed 时才换来换去。
    let failure;
    if (type === 'session.retry.scheduled') {
      failure = classifyFailure(d.error ?? d);
      if (!(failure.fatal && failure.kind !== KIND.RATE)) return frames;
    } else if (type === 'session.execution.failed') {
      failure = classifyFailure(d.error);
    } else {
      return frames;
    }

    // 理论上桥接每建一个会话都会先 selectModel（或 create）把候选记下来；
    // 万一没记上（比如会话是别处建的），退回"链里当前该用的那个"也比放弃熔断强。
    const applied = this._appliedModel.get(sessionId) ?? this.currentModel();

    // (1) 不该熔断的（工具权限被我们自己拒掉、网络抖动等）：原样上报，换模型没有意义
    if (!failure.fatal) return frames;

    // (2) 这一回合已经产出过文本：不重试。否则两次回复会拼在一起发出去。
    if (this._turnHasText.get(sessionId) === true) {
      if (applied) {
        this._chain.markFailure(applied, failure);
        this._persistChain();
      }
      return frames;
    }

    // (3) 熔断当前候选
    if (applied) {
      const fuse = this._chain.markFailure(applied, failure);
      this._persistChain();
      this.log(
        `模型熔断 ${candidateKey(applied)}（${failure.kind}，冷却至 ${new Date(fuse.until).toISOString()}）：${failure.detail.slice(0, 140)}`
      );
    }

    // (4) 还有可用的就换过去，用同样的话重发
    const next = this._chain.pick();
    const last = this._lastPrompt.get(sessionId);
    const promptText = typeof last === 'string' ? last : (last?.text ?? '');
    const promptFiles = typeof last === 'string' ? [] : (last?.files ?? []);
    if (next && !promptText) {
      // 没有原文就没法重发（比如会话是别处建的）。这种情况下**不要**谎报"全用完了"，
      // 老老实实把这个失败交给上层。
      this.log(`还有可用候选但不知道要重发什么，按失败上报 ${sessionId}`);
      return frames;
    }
    if (next && promptText) {
      try {
        // 来自 retry.scheduled 时旧执行还在跑（在退避重试里）：必须先掐掉它，
        // 否则新回合要排在它后面，用户会白等。
        if (type === 'session.retry.scheduled') {
          try {
            await client.session.interrupt({ sessionID: sessionId });
          } catch {
            /* 没在跑时 interrupt 会报错，无妨 */
          }
        }
        this._failoverPending.add(sessionId);
        await client.session.switchModel({ sessionID: sessionId, model: modelRefOf(next) });
        this._appliedModel.set(sessionId, next);
        this._retryTurns.set(sessionId, endTurn);
        this.log(`换模型重试 ${sessionId} → ${candidateKey(next)}`);
        await client.session.prompt({
          sessionID: sessionId,
          text: promptText,
          ...(promptFiles.length ? { files: promptFiles } : {})
        });
        if (this._retryTurns.has(sessionId) && this._failoverPending.has(sessionId)) {
          const timer = setTimeout(() => {
            this._failoverTimers.delete(sessionId);
            this._retryTurns.delete(sessionId);
            this._failoverPending.delete(sessionId);
            this.log(`换模型重试启动超时，已清理待处理状态 ${sessionId}`);
          }, this._failoverStartTimeoutMs);
          timer.unref?.();
          this._failoverTimers.set(sessionId, timer);
        }
        return []; // 失败回合的帧全部吞掉
      } catch (error) {
        // 换模型这一步就没成功：**不要**谎报"全部用完了"，如实把这个失败交给上层。
        this.log(`换模型重试失败（按失败上报）：${error?.message ?? error}`);
        clearTimeout(this._failoverTimers.get(sessionId));
        this._failoverTimers.delete(sessionId);
        this._retryTurns.delete(sessionId);
        this._failoverPending.delete(sessionId);
        return frames;
      }
    }

    // (5) 全部用完：直接回一句话，让它像正常回复一样发到 QQ
    this.log(`模型链已全部用尽，改为回「${this._chainNotice}」`);
    const time = Date.now();
    const notice = {
      type: 'session/event',
      sessionId,
      event: {
        type: 'assistant/message',
        time,
        data: {
          turn: endTurn,
          step: 1,
          message: { role: 'assistant', content: [{ type: 'text', text: this._chainNotice }] }
        }
      }
    };
    // 有结束帧：失败要改成"正常结束"，否则桥接不会把这句话发出去。
    // 没有结束帧（来自 retry.scheduled）：自己补一个，并登记"这个回合已收尾"。
    let completed;
    if (endFrame) {
      completed = (frames ?? []).map((frame) => {
        if (frame.event?.type !== 'turn/end') return frame;
        return {
          ...frame,
          event: {
            ...frame.event,
            data: { ...frame.event.data, reason: { kind: 'completed', error: undefined } }
          }
        };
      });
    } else {
      this._closedTurns.set(sessionId, endTurn);
      completed = [
        {
          type: 'session/event',
          sessionId,
          event: { type: 'turn/end', time, data: { turn: endTurn, reason: { kind: 'completed' } } }
        }
      ];
    }
    return [notice, ...completed];
  }

  /**
   * 一条 模型 API 事件 → 0..N 个 DSH frame。
   * 抽成公开方法方便单测：喂一条假事件，断言产出的 frame。
   */
  _translate(event) {
    const type = event?.type;
    const d = event?.data ?? {};
    const sessionId = d.sessionID ?? d.sessionId ?? event?.sessionID;
    const frames = [];

    if (type === 'session.execution.started') {
      const turn = this._nextTurn(sessionId, d.assistantMessageID ?? d.messageID);
      frames.push({ type: 'session/event', sessionId, event: { type: 'turn/start', data: { turn } } });
      return frames;
    }

    if (type === 'session.step.started') {
      this._cur(sessionId).step += 1;
      return frames;
    }

    if (type === 'session.step.ended') {
      const c = this._cur(sessionId);
      const usage = tokensToUsage(d.tokens);
      if (!usage) return frames;
      c.lastUsage = usage;
      // 用量单独走 assistant/attempt：账本用它记账，且按 (turn, step) 幂等折叠，
      // 不会因为后面再发一条 assistant/message 而翻倍。
      frames.push({
        type: 'session/event',
        sessionId,
        event: {
          type: 'assistant/attempt',
          time: Date.now(),
          data: {
            turn: c.turn,
            step: d.step ?? c.step,
            retry: d.retry ?? c.retry,
            usage,
            model: d.model ?? d.modelID ?? c.model,
            provider: d.provider ?? d.providerID ?? c.provider,
            stream: Array.isArray(d.stream) ? d.stream : undefined
          }
        }
      });
      return frames;
    }

    if (type === 'session.text.ended') {
      const c = this._cur(sessionId);
      const text = typeof d.text === 'string' ? d.text : '';
      frames.push({
        type: 'session/event',
        sessionId,
        event: {
          type: 'assistant/message',
          time: Date.now(),
          data: {
            turn: c.turn,
            step: d.step ?? c.step,
            message: { role: 'assistant', content: [{ type: 'text', text }] },
            model: d.model ?? d.modelID ?? c.model,
            provider: d.provider ?? d.providerID ?? c.provider
          }
        }
      });
      return frames;
    }

    if (type === 'session.text.delta') {
      // 增量帧：给"边生成边发"的场景用。上游 collector 会忽略它，
      // 但控制台/流式展示可以消费。这里忠实转发。
      if (typeof d.delta === 'string' && d.delta) {
        frames.push({
          type: 'session/event',
          sessionId,
          event: { type: 'assistant/chunk', data: { turn: this._cur(sessionId).turn, text: d.delta } }
        });
      }
      return frames;
    }

    if (type === 'session.retry.scheduled') {
      const c = this._cur(sessionId);
      c.retry += 1;
      // 账本靠这个事件建立"重试轴"，不建的话重试花的钱会算到错的档位上。
      frames.push({
        type: 'session/event',
        sessionId,
        event: {
          type: 'llm/retry-started',
          data: { turn: c.turn, step: c.step, retry: c.retry, reason: d.reason ?? d.message ?? null }
        }
      });
      return frames;
    }

    if (EXECUTION_END[type]) {
      const kind = EXECUTION_END[type];
      const c = this._cursor.get(sessionId);
      const turn = c?.turn;
      if (c) {
        c.turn = null;
        c.step = 0;
        c.retry = 0;
      }
      frames.push({
        type: 'session/event',
        sessionId,
        event: {
          type: 'turn/end',
          time: Date.now(),
          data: {
            turn,
            reason: { kind, error: d.error ? String(d.error.message ?? d.error) : undefined }
          }
        }
      });
      return frames;
    }

    // ── 工具调用：桥接要把"真的调了什么、结果是什么"记进工具日志 ──────────
    // 模型 API 的 session.tool.called **不带工具名**，名字在前一步的
    // input.started 里，所以先登记再关联。
    if (type === 'session.tool.input.started') {
      let names = this._toolNames.get(sessionId);
      if (!names) {
        names = new Map();
        this._toolNames.set(sessionId, names);
      }
      if (d.id != null && d.name) names.set(String(d.id), String(d.name));
      return frames;
    }

    if (type === 'session.tool.called') {
      const callId = d.id;
      const name = this._toolNames.get(sessionId)?.get(String(callId)) ?? d.name ?? d.tool ?? 'unknown';
      frames.push({
        type: 'session/event',
        sessionId,
        event: {
          type: 'tool/call',
          data: { name, callId, arguments: d.input ?? d.arguments ?? {} }
        }
      });
      return frames;
    }

    // 工具结果：DSH 侧是从 assistant 消息的 source.callId 认领的，
    // 这里照抄那个形状，免得桥接的工具日志串错名。
    if (type === 'session.tool.success' || type === 'session.tool.failed') {
      const callId = d.id;
      const failed = type === 'session.tool.failed';
      const content = Array.isArray(d.content) && d.content.length
        ? d.content
        : [{ type: 'text', text: String(d.message ?? d.error ?? '') }];
      frames.push({
        type: 'session/event',
        sessionId,
        event: {
          type: 'tool/result',
          data: {
            message: {
              source: { callId },
              content,
              isError: failed,
              error: failed ? String(d.message ?? d.metadata?.exit ?? '') : undefined,
              metadata: d.metadata
            }
          }
        }
      });
      if (callId != null) this._toolNames.get(sessionId)?.delete(String(callId));
      return frames;
    }

    if (type === 'permission.asked') {
      const eventId = d.id ?? d.requestID ?? d.requestId;
      const clientId = 'matrix';
      this._pending.set(`${clientId}:${eventId}`, {
        kind: 'approval',
        sessionID: sessionId,
        requestID: eventId
      });
      frames.push({
        type: 'approval/requested',
        sessionId,
        clientId,
        eventId,
        rpcId: `${clientId}:${eventId}`,
        toolName: d.action ?? d.permission ?? d.tool ?? 'unknown',
        reason: formatPermissions(d)
      });
      return frames;
    }

    if (type === 'permission.replied') {
      // 桥接自己回的可能性也有（控制台代批），双向都清理，避免 pending 泄漏。
      const eventId = d.id ?? d.requestID ?? d.requestId;
      if (eventId) this._pending.delete(`matrix:${eventId}`);
      return frames;
    }

    if (type === 'form.created') {
      const form = d.form ?? {};
      const eventId = form.id;
      const clientId = 'matrix';
      this._pending.set(`${clientId}:${eventId}`, {
        kind: 'question',
        sessionID: form.sessionID ?? sessionId,
        formID: form.id,
        questions: formFieldsToQuestions(form)
      });
      frames.push({
        type: 'question/requested',
        sessionId: form.sessionID ?? sessionId,
        clientId,
        eventId,
        rpcId: `${clientId}:${eventId}`,
        questions: formFieldsToQuestions(form)
      });
      return frames;
    }

    if (type === 'form.replied' || type === 'form.cancelled') {
      const eventId = d.form?.id ?? d.id ?? d.formID;
      if (eventId) this._pending.delete(`matrix:${eventId}`);
      return frames;
    }

    // 会话级/全局错误 → 让桥接能提示用户（不做重试决策，重试交给 模型 API 自己）。
    if (type === 'session.error' || type === 'stream.error' || type === 'server.error') {
      frames.push({ type: 'stream/error', sessionId, error: d.error ?? d });
      return frames;
    }

    return frames;
  }

  /* ── 5.6 respond：审批 / 提问的统一回复入口 ───────────────────────────── */

  /**
   * DSH 的回复接口。桥接在两个地方调它：
   *
   *   审批：`outcome = { kind:'result', value: 'allowed-once' | 'allowed-always' | 'rejected' }`
   *   提问：`outcome = { kind:'result', value: { answers: [{ id, selected:[label], custom }] } }`
   *
   * 映射到 模型 API：
   *   allowed-once   → permission.reply decision:'once'
   *   allowed-always → decision:'always'
   *   rejected       → decision:'reject'
   *   提问           → form.reply，answer 是 { 字段id: 值 } 的字典
   */
  async respond(params = {}) {
    const { clientId, eventId, outcome } = params;
    const key = `${clientId}:${eventId}`;
    const pending = this._pending.get(key);
    if (!pending) throw new Error(`respond: 找不到待响应的请求 ${key}（可能已超时或在别处处理过）`);

    const client = await this._ensureClient();

    if (pending.kind === 'approval') {
      const value = outcome?.value;
      let decision = 'reject';
      if (value === 'allowed-once') decision = 'once';
      else if (value === 'allowed-always' || value === 'allowed') decision = 'always';
      else if (value === 'rejected') decision = 'reject';
      else decision = value === true ? 'once' : 'reject';
      await client.permission.reply({ sessionID: pending.sessionID, requestID: pending.requestID, decision });
      this._pending.delete(key);
      return ok({ kind: 'approval', decision });
    }

    // 提问
    const answers = Array.isArray(outcome?.value?.answers) ? outcome.value.answers : [];
    const answer = {};
    for (const a of answers) {
      const fieldId = String(a?.id ?? '');
      if (!fieldId) continue;
      const picked = Array.isArray(a?.selected) && a.selected.length ? a.selected[0] : undefined;
      answer[fieldId] = picked ?? a?.custom ?? '';
    }
    await client.form.reply({ sessionID: pending.sessionID, formID: pending.formID, answer });
    this._pending.delete(key);
    return ok({ kind: 'question', answer });
  }

  /* ── 5.7 stopSessionWork（上游的会话打断入口） ─────────────────────────── */

  async stopSessionWork(sessionId, { signal, timeoutMs = 8000 } = {}) {
    const client = await this._ensureClient();
    const work = client.session.interrupt({ sessionID: sessionId });
    if (signal) {
      await Promise.race([
        work,
        new Promise((_, reject) => {
          const timer = setTimeout(() => reject(new Error('停止会话工作超时')), timeoutMs);
          signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('停止会话工作被取消'));
          }, { once: true });
        })
      ]);
    } else {
      await work;
    }
  }

  /* ── 5.8 agentPresets.*（→ 模型 API 的 agent） ─────────────────────────── */

  get agentPresets() {
    const self = this;
    return {
      /**
       * DSH: `agentPresets.list({})` → `{ presets: [{ id, isDefault?, trust? }] }`
       *
       * 模型 API 里对应的是 agent（`agent.list`）。**必须带 location**，
       * 否则拿到的是"默认目录"的解析结果，看不到项目配置（Phase 0 实测踩过）。
       */
      async list(params = {}) {
        // **必须带 location**（Phase 0 实测）：不带的话拿到的是默认目录的解析结果，
        // 项目 `opencode.json` 里生成的 qq-chat / qq-chat-v2 一个都看不见，
        // 桥接就会以"预设不在清单里"为由拒绝建会话。桥接调用时不传目录，
        // 这里兜底到实例的工作目录（= 项目根）。
        const directory = params.workspaceId
          ? self._dirOfWorkspace(params.workspaceId)
          : (params.directory || process.cwd());
        return envelope('agentPresets.list', async () => {
          const client = await self._ensureClient();
          const res = await client.agent.list(directory ? { location: { directory } } : {});
          const raw = res?.data ?? res?.agents ?? res;
          const agents = Array.isArray(raw) ? raw : [];
          return {
            presets: agents.map((a) => ({
              id: String(a.id ?? a.name),
              name: a.name ?? a.id,
              // 上游只认 isDefault 与 trust 两个字段，其余原样带过不碍事。
              isDefault: a.default === true || a.isDefault === true || a.id === 'build',
              trust: a.mode === 'primary' ? 'system' : (a.mode ?? 'system'),
              description: a.description ?? null
            }))
          };
        });
      },

      /**
       * 读回某个 agent **生效的**权限规则集。
       *
       * Phase 0 结论：配置里的 `permissions` 会被追加在官方基础策略（全放行通配）
       * **之后**、软件内置规则（如 deny browser *）**之前**，**最后匹配者胜出**。
       * 所以"兜底全禁 + 白名单"必须写在同一个数组里、deny 在前。
       * 桥接启动时用这个读回并断言（见 docs/PHASE0-FINDINGS.md 4.4 第 4 条）。
       */
      async policy(params = {}) {
        const agentId = params.id ?? params.agent;
        const directory = params.directory ?? (params.workspaceId ? self._dirOfWorkspace(params.workspaceId) : undefined);
        return envelope('agentPresets.policy', async () => {
          const client = await self._ensureClient();
          const res = await client.agent.list(directory ? { location: { directory } } : {});
          const raw = res?.data ?? res?.agents ?? res;
          const agents = Array.isArray(raw) ? raw : [];
          const agent = agents.find((a) => String(a.id ?? a.name) === String(agentId));
          if (!agent) throw new Error(`找不到 agent ${agentId}`);
          return { id: agentId, permissions: agent.permissions ?? [] };
        });
      }
    };
  }

  /* ── 5.9 settings.*（→ 本地 JSON 兜底） ────────────────────────────────── */

  get settings() {
    const self = this;
    const read = () => {
      try {
        return JSON.parse(fs.readFileSync(self._settingsFile, 'utf8'));
      } catch {
        return {};
      }
    };
    const write = (value) => {
      fs.mkdirSync(path.dirname(self._settingsFile), { recursive: true });
      const tmp = `${self._settingsFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
      fs.renameSync(tmp, self._settingsFile);
    };

    return {
      /**
       * DSH: `settings.describe({})` → `{ namespaces: [{ ns, value }] }`
       *
       * 桥接只读两个命名空间：
       *   agent-presets → { default }        （closed-agent 模式的兜底 preset）
       *   qq-mode       → { mode, ownerQQ? } （设置页改的运行模式与管理员）
       */
      async describe() {
        const store = read();
        const namespaces = [];
        if (store['agent-presets'] !== undefined) {
          namespaces.push({ ns: 'agent-presets', value: store['agent-presets'] });
        }
        if (store['qq-mode'] !== undefined) {
          namespaces.push({ ns: 'qq-mode', value: store['qq-mode'] });
        }
        return ok({ namespaces, file: self._settingsFile });
      },

      /** DSH: `settings.update({ ns, patch })` → 信封 */
      async update(params = {}) {
        return envelope('settings.update', async () => {
          const ns = String(params.ns ?? '');
          if (!ns) throw new Error('settings.update 缺少 ns');
          const store = read();
          store[ns] = { ...(store[ns] ?? {}), ...(params.patch ?? {}) };
          write(store);
          return { ns, value: store[ns] };
        });
      }
    };
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * 六、纯函数工具（翻译用，导出便于单测）
 * ══════════════════════════════════════════════════════════════════════════ */

/** 把 permission.asked 的 data 拼成人能读的审批理由。 */
export function formatPermissions(data = {}) {
  const action = data.action ?? data.permission ?? data.tool ?? 'unknown';
  const resources = Array.isArray(data.resources) ? data.resources : [];
  if (resources.length === 0) return `请求使用 ${action}`;
  const shown = resources.slice(0, 5).map((r) => String(r));
  const more = resources.length > shown.length ? ` 等 ${resources.length} 项` : '';
  return `${action}: ${shown.join('、')}${more}`;
}

/**
 * 模型 API 的 form → DSH 的 questions 形状。
 *
 * DSH: `[{ id, question, options: [{ label }] }]`
 * 模型 API 的 form.fields 可能是数组也可能是对象，字段名可能是
 * id/name/key，所以这里全部容错读取——形状没在 Phase 0 实测过（没人调过 question
 * 工具），**Phase 1 首次真机验证时以实测为准修正这里**。
 */
export function formFieldsToQuestions(form = {}) {
  const fields = form.fields ?? form.questions ?? [];
  const list = Array.isArray(fields)
    ? fields
    : Object.entries(fields).map(([key, value]) => ({ key, ...(value ?? {}) }));
  return list.map((f, index) => {
    const id = String(f.id ?? f.key ?? f.name ?? `field_${index}`);
    const label = f.label ?? f.question ?? f.title ?? f.description ?? id;
    const rawOptions = f.options ?? f.choices ?? f.values ?? [];
    const options = (Array.isArray(rawOptions) ? rawOptions : []).map((o) =>
      typeof o === 'string' ? { label: o, value: o } : { label: String(o?.label ?? o?.title ?? o?.value ?? ''), value: o?.value }
    );
    return { id, question: String(label), options };
  });
}

/** 给 `bridge.js` 用的自检摘要（日志里一眼看出接线对不对）。 */
export function describeEndpoint(endpoint) {
  if (!endpoint) return `${HR} 模型 API 端点：未发现`;
  return `${HR} 模型 API 端点：${endpoint.url}（auth=${endpoint.auth?.type ?? 'none'}）`;
}
