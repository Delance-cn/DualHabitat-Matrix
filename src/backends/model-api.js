/**
 * backends/model-api.js —— 直连模型 API 的后端适配器。
 *
 * 为什么这是"群友模式"的主路：
 *   CLI 后端要起子进程（3~10 秒冷启动），群里的人早就聊过去了。
 *   直连 API 首字几百毫秒，接得上话；而且不装任何工具，天然满足
 *   RULES.md 第一条「QQ 会话 agent 无本地工具」。
 *
 * 代价：没有工具调用、没有联网（除非另配 MCP）。要干活时切到 CLI 后端。
 *
 * 契约见 CONTRACT.md。这里只实现"发一轮 → 产帧"这一件事。
 */

import path from 'node:path';
import {
  ok,
  fail,
  envelope,
  EventBus,
  turnStart,
  assistantChunk,
  assistantMessage,
  turnEnd,
  usageFrame,
  blocksToText,
  blocksToImages,
  SessionStore,
  newSessionId,
  TurnCounter
} from './base.js';
import { streamChat, SUPPORTED_PROTOCOLS } from './protocols.js';
import { createWorkspaceTools } from './tools.js';

const DEFAULTS = {
  protocol: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  temperature: 0.8,
  maxTokens: 1024,
  /** 保留最近多少条消息作为上下文（含 user + assistant）。 */
  maxHistory: 12,
  /** 上下文硬上限（字符数，粗略估算）。超了从最早的消息开始丢。 */
  maxContextChars: 24000,
  /** 单轮超时。群聊场景不该等太久，超时直接判失败。 */
  timeoutMs: 90_000,
  /**
   * 是否允许只读工具（read_file / list_dir / search_text）。
   * 默认 false：群聊就该是纯聊天。主人要查代码时再开。
   */
  allowTools: false,
  /** 工具轮次上限。最后一轮强制不带工具，让它必须给答案。 */
  maxToolRounds: 4,
  /** 工具能看的工作区。不填就用会话自己的目录，再不行用 cwd。 */
  workspaceDir: null
};

/**
 * 剔掉值为 undefined 的键。
 *
 * 为什么需要：`{ ...DEFAULTS, ...config }` 里，显式写出来的 `undefined` 也算
 * "自己的属性"，会把默认值**盖掉**（`{...{a:1}, ...{a:undefined}}` → `{a:undefined}`）。
 * 上游 resolveProfile 会把没配的项原样透传成 undefined（比如 timeoutMs），
 * 不剔掉的话"没配"就等于"配了个 undefined"，后面 `setTimeout(..., undefined)`
 * 会退化成 0 毫秒 —— 看起来像随机超时，其实一个都没配。
 */
function dropUndefined(obj) {
  return Object.fromEntries(Object.entries(obj ?? {}).filter(([, v]) => v !== undefined));
}

/** 多轮工具调用时把每轮的 token 用量累加，账本才准。 */
function mergeUsage(total, next) {
  if (!next) return total;
  if (!total) return { ...next };
  return {
    inputTokens: (total.inputTokens ?? 0) + (next.inputTokens ?? 0),
    outputTokens: (total.outputTokens ?? 0) + (next.outputTokens ?? 0),
    reasoningTokens: (total.reasoningTokens ?? 0) + (next.reasoningTokens ?? 0),
    cacheReadTokens: (total.cacheReadTokens ?? 0) + (next.cacheReadTokens ?? 0),
    cacheWriteTokens: (total.cacheWriteTokens ?? 0) + (next.cacheWriteTokens ?? 0)
  };
}

/** 解析模型给的 arguments（流式拼起来的 JSON 字符串）。坏 JSON 就当空参数。 */
function parseArgs(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export class ModelApiBackend {
  /**
   * @param {object} config
   * @param {'openai'|'anthropic'|'gemini'} config.protocol
   * @param {string} config.baseUrl
   * @param {string} config.model
   * @param {string} config.apiKey
   * @param {string} [config.stateDir]  会话落盘根目录
   * @param {(msg: string) => void} [config.log]
   */
  constructor(config = {}) {
    this.type = 'model-api';
    this.log = config.log ?? (() => {});

    const merged = { ...DEFAULTS, ...dropUndefined(config) };
    if (!SUPPORTED_PROTOCOLS.includes(merged.protocol)) {
      throw new Error(
        `model-api 的 protocol 必须是 ${SUPPORTED_PROTOCOLS.join(' / ')}，收到 "${merged.protocol}"`
      );
    }
    if (!merged.apiKey) {
      throw new Error(
        `model-api 缺少 API key。请在 secrets.json 里配置 ${config.apiKeyEnv ?? '对应的环境变量名'}`
      );
    }

    this.profile = {
      protocol: merged.protocol,
      baseUrl: merged.baseUrl,
      model: merged.model,
      apiKey: merged.apiKey,
      temperature: merged.temperature,
      maxTokens: merged.maxTokens,
      anthropicVersion: merged.anthropicVersion
    };
    this.maxHistory = merged.maxHistory;
    this.maxContextChars = merged.maxContextChars;
    this.timeoutMs = merged.timeoutMs;
    this.allowTools = merged.allowTools === true;
    this.maxToolRounds = Math.max(1, Number(merged.maxToolRounds) || 4);
    this.workspaceDir = merged.workspaceDir || null;
    /** 工作区目录 → 工具集（缓存，避免每轮重扫黑名单） */
    this._toolsets = new Map();
    this._toolWarned = false;

    this.stateDir = merged.stateDir ?? path.join(process.cwd(), '.oc', 'state', 'backends', 'model-api');
    this.store = new SessionStore(path.join(this.stateDir, 'sessions'), this.log);
    this.bus = new EventBus();
    this.turns = new TurnCounter();

    /** workspaceId → 目录（沿用 模型 API 门面的"目录即工作区"约定）。 */
    this._workspaces = new Map();
    /** sessionId → AbortController（打断用） */
    this._aborts = new Map();
    /** sessionId → Promise（同一会话的轮次串行化，避免上下文交错写坏） */
    this._chains = new Map();
    /** sessionId → 本次会话选定的模型（覆盖全局 profile） */
    this._models = new Map();

    this.log(`model-api 后端就绪：${merged.protocol} · ${merged.model} · ${merged.baseUrl}`);
  }

  /* ── 上下文拼装 ──────────────────────────────────────────────────────── */

  /**
   * 取最近若干条消息，并按字符预算裁剪。
   *
   * 为什么要裁：桥接每条消息都会注入人设（默认上限 6000 字符），
   * 历史累积十几轮就会顶爆模型上下文，表现是 400 或者被服务端静默截断。
   */
  _trimHistory(messages) {
    let list = messages.slice(-this.maxHistory);
    let chars = list.reduce((n, m) => n + (m.text?.length ?? 0), 0);
    while (chars > this.maxContextChars && list.length > 1) {
      chars -= list[0].text?.length ?? 0;
      list = list.slice(1);
    }
    return list;
  }

  /* ── 一轮的实际执行 ──────────────────────────────────────────────────── */

  /**
   * 跑一轮，全程通过事件总线推帧。
   *
   * 注意：**必须**在结束前推一条 `assistant/message` 和一条 `turn/end`。
   * 桥接的 collector 忽略 `assistant/chunk`（防重复），只认 message 里的完整文本；
   * 少了 turn/end 该会话会永久 busy，再也不会回话。
   */
  async _runTurn(sessionId, userMessage) {
    const record = this.store.get(sessionId) ?? {
      sessionId,
      messages: [],
      createdAt: Date.now()
    };

    const turn = this.turns.next(sessionId);
    const abort = new AbortController();
    this._aborts.set(sessionId, abort);

    let timer = null;
    if (this.timeoutMs > 0) {
      timer = setTimeout(() => abort.abort(), this.timeoutMs);
    }

    this.bus.push(turnStart(sessionId, turn));

    const history = [...record.messages, userMessage];
    const outgoing = this._trimHistory(history);
    const profile = { ...this.profile, model: this._models.get(sessionId) ?? this.profile.model };

    // 工具集按"会话目录 → workspaceDir → cwd"的顺序取，只读、锁在工作区内（见 tools.js）
    const toolset = this._toolsetFor(record.directory);
    // 工作副本：工具往返只活在**这一轮**里，不写进 record.messages
    // （否则文件内容会永久留在历史里，下一轮又要重新算 token）
    const working = outgoing.map((m) => ({ ...m }));

    let roundText = '';
    let allText = '';
    let usage = null;
    let failure = null;
    let toolCallsMade = 0;

    try {
      for (let round = 0; ; round += 1) {
        // 最后一轮强制不带工具：必须给答案，不能无限读文件
        const useTools = toolset && round < this.maxToolRounds - 1;
        roundText = '';
        const pending = new Map();

        for await (const item of streamChat(profile, {
          messages: working,
          tools: useTools ? toolset.definitions : undefined,
          signal: abort.signal
        })) {
          if (item.delta) {
            roundText += item.delta;
            allText += item.delta;
            this.bus.push(assistantChunk(sessionId, turn, item.delta));
          }
          if (item.usage) usage = mergeUsage(usage, item.usage);

          // 工具调用是分片下发的：第一片有 id/name，后续只带 arguments 碎片
          if (item.toolCallDelta) {
            for (const part of item.toolCallDelta) {
              const index = part.index ?? 0;
              const acc = pending.get(index) ?? { id: '', name: '', argsText: '' };
              if (part.id) acc.id = part.id;
              if (part.function?.name) acc.name += part.function.name;
              if (part.function?.arguments) acc.argsText += part.function.arguments;
              pending.set(index, acc);
            }
          }
        }

        const calls = [...pending.values()].filter((c) => c.name);
        if (!calls.length || !useTools) break;

        // 把 assistant 的调用帧放回上下文，再逐个塞工具回执 —— 缺一个就 400
        const normalized = calls.map((call, i) => ({
          id: call.id || `call_${turn}_${round}_${i}`,
          name: call.name,
          args: parseArgs(call.argsText)
        }));
        working.push({ role: 'assistant', text: roundText, toolCalls: normalized });

        for (const call of normalized) {
          const result = toolset.execute(call.name, call.args);
          toolCallsMade += 1;
          this.log(`工具 ${call.name} → ${result.length} 字（${sessionId}）`);
          working.push({ role: 'tool', toolCallId: call.id, name: call.name, text: result });
        }

        if (abort.signal.aborted) break;
      }
    } catch (error) {
      failure = error;
    } finally {
      if (timer) clearTimeout(timer);
      this._aborts.delete(sessionId);
    }

    // 只把**最后一轮**的文本当回复：前面几轮通常是"我来看一下"这种过程话。
    // 最后一轮空（比如被强制收尾但模型没说话）才退回全文。
    const text = roundText || allText;

    // 有文本就落盘，哪怕这一轮中途失败 —— 已经发出去的话不能从记忆里消失
    if (text) {
      this.bus.push(assistantMessage(sessionId, turn, text));
      if (usage) this.bus.push(usageFrame(sessionId, turn, usage));
      record.messages = [...history, { role: 'assistant', text, images: [] }];
      record.updatedAt = Date.now();
      this.store.set(sessionId, record);
    }

    if (failure) {
      const kind = abort.signal.aborted ? 'interrupted' : 'failed';
      this.log(`回合失败（${sessionId} / ${turn}）：${failure?.message ?? failure}`);
      this.bus.push(turnEnd(sessionId, turn, kind));
      return;
    }
    if (toolCallsMade) this.log(`本回合用了 ${toolCallsMade} 次只读工具（${sessionId}）`);
    this.bus.push(turnEnd(sessionId, turn, 'completed'));
  }

  /**
   * 按协议和配置决定这一轮带不带工具。
   *
   * 目前只实现 openai 兼容协议 —— Anthropic / Gemini 的函数调用是另一套
   * 事件结构（content_block_start / functionCall），没核对过就不硬编。
   */
  _toolsetFor(directory) {
    if (!this.allowTools) return null;
    if (this.profile.protocol !== 'openai') {
      if (!this._toolWarned) {
        this._toolWarned = true;
        this.log(`工具调用目前只支持 openai 兼容协议，当前是 ${this.profile.protocol}，本轮不带工具`);
      }
      return null;
    }
    const dir = path.resolve(this.workspaceDir || directory || process.cwd());
    const cached = this._toolsets.get(dir);
    if (cached) return cached;

    const toolset = createWorkspaceTools({ workspace: dir, log: this.log });
    this._toolsets.set(dir, toolset);
    this.log(`直连后端已开只读工具，工作区：${toolset.workspace}`);
    return toolset;
  }

  /** 同一会话的轮次排队执行，避免两条消息同时改同一份上下文。 */
  _enqueue(sessionId, task) {
    const prev = this._chains.get(sessionId) ?? Promise.resolve();
    const next = prev.then(task, task);
    // 链条本身永远不 reject，否则后续任务会被跳过
    this._chains.set(
      sessionId,
      next.catch(() => {})
    );
    return next;
  }

  /* ── 门面：sessions ──────────────────────────────────────────────────── */

  get sessions() {
    const self = this;
    return {
      async create(params = {}) {
        const sessionId = newSessionId();
        const directory = self._dirOfWorkspace(params.workspaceId);
        self.store.set(sessionId, {
          sessionId,
          directory,
          title: params.title ?? null,
          agentPreset: params.agentPreset ?? null,
          messages: [],
          createdAt: Date.now()
        });
        return ok({ sessionId, id: sessionId, directory });
      },

      async list(params = {}) {
        const directory = params.workspaceId ? self._dirOfWorkspace(params.workspaceId) : undefined;
        const items = self.store
          .list()
          .filter((r) => !directory || r.directory === directory)
          .map((r) => ({
            sessionId: r.sessionId,
            origin: 'user',
            parentSessionId: null,
            cwd: r.directory ?? null,
            title: r.title,
            archived: false
          }));
        return ok({ items });
      },

      /**
       * 投递一轮。**必须非阻塞**：立刻返回 accepted，输出走事件流。
       * 桥接拿到 accepted 之后就去等事件了，这里要是 await 完才返回，
       * 整条链会卡住（消息发不出去、也不报错）。
       */
      async prompt(params = {}) {
        const sessionId = params.sessionId ?? params.sessionID;
        if (!sessionId) return fail('invalid', 'session.prompt 缺少 sessionId');

        const blocks = Array.isArray(params.content) ? params.content : [];
        const text = params.text ?? blocksToText(blocks);
        const images = blocksToImages(blocks, self.log);

        if (!text && !images.length) {
          return fail('invalid', 'session.prompt 收到空内容');
        }

        const userMessage = { role: 'user', text, images };

        // 不 await：让它在后台跑，帧通过总线推出去
        self._enqueue(sessionId, () => self._runTurn(sessionId, userMessage));

        return ok({ accepted: true, sessionId });
      },

      async selectModel(params = {}) {
        const sessionId = params.sessionId ?? params.sessionID;
        const model = params.model ?? params.id;
        if (model) {
          self._models.set(sessionId, String(model));
          self.log(`会话 ${sessionId} 切换模型 → ${model}`);
        }
        return ok({
          selected: {
            provider: self.profile.protocol,
            model: self._models.get(sessionId) ?? self.profile.model,
            reasoningEffort: params.reasoningEffort ?? null
          }
        });
      },

      async stats(params = {}) {
        const sessionId = params.sessionId ?? params.sessionID;
        const record = self.store.get(sessionId);
        return ok({
          sessionId,
          messages: record?.messages?.length ?? 0,
          updatedAt: record?.updatedAt ?? null
        });
      },

      async messages(params = {}) {
        const sessionId = params.sessionId ?? params.sessionID;
        const record = self.store.get(sessionId);
        return ok({
          messages: (record?.messages ?? []).map((m) => ({
            role: m.role,
            content: [{ type: 'text', text: m.text ?? '' }]
          }))
        });
      }
    };
  }

  /* ── 门面：workspace ─────────────────────────────────────────────────── */

  get workspace() {
    const self = this;
    return {
      async create(params = {}) {
        const dir = params.path ? path.resolve(params.path) : process.cwd();
        const created = !self._workspaces.has(dir);
        self._workspaces.set(dir, dir);
        return ok({ created, workspace: { workspaceId: dir, path: dir, title: path.basename(dir) } });
      },
      async rename(params = {}) {
        self.log(`workspace.rename: 直连模型后端无工作区标题，忽略（${params.title ?? ''}）`);
        return ok({ renamed: false });
      },
      async archiveSession(params = {}) {
        const sessionId = params.sessionId ?? params.sessionID;
        self._aborts.get(sessionId)?.abort();
        self.store.delete(sessionId);
        self.turns.forget(sessionId);
        self._models.delete(sessionId);
        return ok({ archived: true, deleted: true });
      }
    };
  }

  /* ── 门面：events ────────────────────────────────────────────────────── */

  get events() {
    const self = this;
    return {
      follow(sessionId) {
        return { sessionId };
      },
      forget() {
        /* 全局总线，无需退订 */
      },
      mux() {
        return self.bus.iterate();
      }
    };
  }

  /* ── 门面：其余 ──────────────────────────────────────────────────────── */

  /**
   * 回审批/提问。直连模型后端没有审批机制 —— 桥接只会在收到 permission 帧时才调它，
   * 而这里永远不发 permission 帧，所以正常流程不会走到。
   */
  async respond() {
    throw new Error('respond: 直连模型后端没有待审批的请求');
  }

  /** 打断当前回合。 */
  async stopSessionWork(sessionId) {
    const abort = this._aborts.get(sessionId);
    if (!abort) return ok({ stopped: false });
    abort.abort();
    this._aborts.delete(sessionId);
    return ok({ stopped: true });
  }

  /**
   * 模型目录（控制台的"思考强度"下拉框靠它）。
   * 这里只报当前这一个模型，不报协议支持的所有模型 —— 报多了用户会选到没有 key 的。
   */
  async callUnary(method, params = {}) {
    if (method !== 'session.modelCatalog' && method !== 'session.models') {
      return fail('unsupported', `model-api 后端没有 RPC ${method}`);
    }
    return envelope('session.modelCatalog', async () => ({
      groups: [
        {
          id: this.profile.protocol,
          models: [
            {
              id: this.profile.model,
              name: this.profile.model,
              inputModalities: ['text', 'image']
            }
          ]
        }
      ]
    }));
  }

  currentModel() {
    return null; // 模型链在直连模式下由 profile 决定，不走候选链
  }

  chainStatus() {
    return [];
  }

  invalidate() {
    /* 没有需要丢弃的连接 */
  }

  async close() {
    for (const abort of this._aborts.values()) abort.abort();
    this._aborts.clear();
    this.bus.close();
  }

  _dirOfWorkspace(workspaceId) {
    return this._workspaces.get(workspaceId) ?? workspaceId ?? process.cwd();
  }
}
