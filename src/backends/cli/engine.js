/**
 * backends/cli/engine.js —— 通用 CLI agent 驱动引擎。
 *
 * 为什么不是 15 个适配器：那 15 个工具本质做同一件事 ——
 *   起子进程 → 喂 prompt → 逐行读流 → 解析 → 记会话 id。
 * 差异只有三处：参数怎么拼、输出什么格式、怎么降权。
 * 所以引擎管流程，driver 只管这三处。加一个新工具 = 写一份 driver，几十行。
 *
 * ## 与直连模型后端的取舍
 *
 * CLI 后端有工具、能读写文件、能跑命令 —— 所以**必须降权**（RULES.md 第一条）。
 * 而且冷启动 3~10 秒，群聊里接不上话。定位是"要干活时切过去"，不是默认。
 *
 * ## 安全
 *
 * - prompt 默认走 **stdin**，不走命令行参数（躲开 Windows 引号地狱和命令注入）。
 *   例外：少数 CLI 在 Windows 上根本不认 stdin（Cline 3.0.73 实测），
 *   由 driver 显式声明 `promptVia:'arg'` 才拼进参数位；此时 **绝不能** 用 shell。
 * - 子进程的 cwd 指向会话独立目录，不指向项目根。
 * - 降权参数由 driver 的 `buildArgs` 按 `allowTools` 生成，缺省即不给工具。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { EventBus, turnStart, assistantChunk, assistantMessage, turnEnd, TurnCounter } from '../base.js';

/** 允许 QQ 会话 agent 用的 MCP 命名空间（与 RULES.md 第 2 条一致）。 */
export const SAFE_MCP_NAMESPACES = ['mcp__snowluma__*', 'mcp__snowluma-host__*', 'mcp__web-search-safe__*'];

const KILL_GRACE_MS = 3000;

/* ══════════════════════════════════════════════════════════════════════════
 * 一、可执行文件定位（Windows 上 npm 全局包是 .cmd，不能直接 spawn）
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * 在 PATH 里找命令。返回可直接 spawn 的形态。
 *
 * Windows 的坑：`claude` 实际是 `claude.cmd`，Node 的 spawn 在 shell:false 下
 * 找不到它（ENOENT）。这里显式补扩展名，并且对 .cmd/.bat 用 cmd.exe 包裹。
 */
export function resolveBin(bin, env = process.env) {
  if (bin.includes('/') || bin.includes('\\')) {
    return fs.existsSync(bin) ? { command: bin, shell: false } : null;
  }

  const isWin = process.platform === 'win32';
  const exts = isWin ? ['.cmd', '.bat', '.exe', ''] : [''];
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);

  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, bin + ext);
      if (fs.existsSync(candidate)) {
        if (isWin && (ext === '.cmd' || ext === '.bat')) {
          return { command: process.env.ComSpec || 'cmd.exe', prefix: ['/d', '/s', '/c', candidate], shell: false };
        }
        return { command: candidate, shell: false };
      }
    }
  }
  return null;
}

/* ══════════════════════════════════════════════════════════════════════════
 * 二、引擎
 * ══════════════════════════════════════════════════════════════════════════ */

export class CliBackend {
  /**
   * @param {object} config
   * @param {object} config.driver   driver 描述（见 drivers/）
   * @param {string} [config.bin]    覆盖 driver.bin（绝对路径，或想用某个特定安装）
   * @param {object} [config.options] 透传给 buildArgs 的 driver 私有配置（provider/model 等）
   * @param {string} [config.stateDir]
   * @param {boolean} [config.allowTools]  是否允许工具（默认 false = 全禁）
   * @param {(msg:string)=>void} [config.log]
   */
  constructor(config = {}) {
    this.type = 'cli';
    this.driver = config.driver;
    if (!this.driver) throw new Error('CliBackend 缺少 driver');
    this.log = config.log ?? (() => {});
    this.allowTools = config.allowTools === true;
    this.timeoutMs = config.timeoutMs ?? 180_000;
    this.options = config.options ?? {};
    this.stateDir = config.stateDir ?? path.join(process.cwd(), '.oc', 'state', 'backends', 'cli');
    this.bus = new EventBus();
    this.turns = new TurnCounter();

    /** sessionId → { nativeId, cwd } */
    this._sessions = new Map();
    /** sessionId → { child, abort } */
    this._running = new Map();

    fs.mkdirSync(this.stateDir, { recursive: true });

    const found = this._resolveBin(config.bin);
    if (!found) {
      const extra = (this.driver.binFallbacks ?? []).join('、') || '（无）';
      throw new Error(
        `找不到可执行文件 "${config.bin || this.driver.bin}"。请先安装 ${this.driver.label}，` +
          `或把 ${this.driver.bin} 加进 PATH，或在本后端配置里写 bin 绝对路径。` +
          `已尝试的备用路径：${extra}`
      );
    }
    this._bin = found;
    this.log(`CLI 后端就绪：${this.driver.label}（${found.command}）`);
  }

  /**
   * 定位可执行文件：显式 bin → PATH → driver.binFallbacks。
   *
   * 为什么要 fallbacks：Cline / Kiro 这种桌面应用自带的 CLI 不会进 PATH，
   * 绝对路径又因机器而异。driver 用 `os.homedir()` 拼出常见位置，装了就自动认。
   */
  _resolveBin(override) {
    const wanted = override || this.driver.bin;
    const direct = resolveBin(wanted);
    if (direct) return direct;

    // 用户显式指定过就不猜了，猜错更糟
    if (override) return null;

    for (const candidate of this.driver.binFallbacks ?? []) {
      const found = resolveBin(candidate);
      if (found) {
        this.log(`${this.driver.label} 未在 PATH 里，改用 ${candidate}`);
        return found;
      }
    }
    return null;
  }

  /* ── 会话目录 ────────────────────────────────────────────────────────── */

  _cwdOf(sessionId) {
    const dir = path.join(this.stateDir, 'agents', String(sessionId).replace(/[^A-Za-z0-9_.-]/g, '_'));
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /* ── 跑一轮 ──────────────────────────────────────────────────────────── */

  async _runTurn(sessionId, promptText) {
    const state = this._sessions.get(sessionId) ?? { nativeId: null, cwd: this._cwdOf(sessionId) };
    const turn = this.turns.next(sessionId);

    this.bus.push(turnStart(sessionId, turn));

    const args = this.driver.buildArgs({
      promptText,
      nativeSessionId: state.nativeId,
      cwd: state.cwd,
      allowTools: this.allowTools,
      safeNamespaces: SAFE_MCP_NAMESPACES,
      // 有些 CLI 没有 resume，只能靠 driver 自己按会话回放历史 —— 它需要会话 id
      sessionId,
      // driver 私有配置（provider / model / bin 等），来自 config.json 的 backend.cli.options
      options: this.options
    });

    if (!Array.isArray(args)) {
      this.bus.push(turnEnd(sessionId, turn, 'failed'));
      throw new Error(`${this.driver.id}: buildArgs 没有返回数组`);
    }

    const argv = [...(this._bin.prefix ?? []), ...args];
    const child = spawn(this._bin.command, argv, {
      cwd: state.cwd,
      env: { ...process.env, ...(this.driver.env ?? {}) },
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    this._running.set(sessionId, { child });

    // 喂 prompt。默认走 stdin —— 躲开 Windows `cmd /c` 对引号和中文的解析问题；
    // 少数只认参数位的 CLI 由 driver 声明 promptVia:'arg'。
    try {
      if (this.driver.promptVia !== 'arg') child.stdin.write(promptText);
      child.stdin.end();
    } catch (error) {
      this.log(`写 stdin 失败（${this.driver.id}）：${error?.message ?? error}`);
    }

    let text = '';
    let failure = null;
    let stderrTail = '';

    const timer =
      this.timeoutMs > 0
        ? setTimeout(() => {
            this.log(`${this.driver.label} 超时（${this.timeoutMs}ms），终止进程`);
            killTree(child);
          }, this.timeoutMs)
        : null;

    // stderr 单独收：CLI 的报错几乎都走 stderr，丢掉就只能看到 "exit 1"
    child.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2000);
    });

    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });

    try {
      for await (const line of rl) {
        if (!line.trim()) continue;
        let parsed;
        try {
          parsed = this.driver.parseLine(line, { sessionId });
        } catch (error) {
          this.log(`${this.driver.id} 解析失败，跳过该行：${error?.message ?? error}`);
          continue;
        }
        if (!parsed) continue;

        if (parsed.nativeSessionId) state.nativeId = parsed.nativeSessionId;
        if (parsed.delta) {
          text += parsed.delta;
          this.bus.push(assistantChunk(sessionId, turn, parsed.delta));
        }
        if (parsed.text) {
          // 语义差异必须由 driver 声明：Claude Code 的 assistant 帧是**完整文本**，
          // Gemini 的 stream-json 是**增量**。都按累加处理会把回复拼重复。
          if (this.driver.mode === 'replace') text = parsed.text;
          else text += parsed.text;
        }
        if (parsed.error) failure = new Error(parsed.error);
      }

      const exitCode = await new Promise((resolve) => child.once('close', resolve));
      if (exitCode !== 0 && !text) {
        failure = failure ?? new Error(`${this.driver.label} 退出码 ${exitCode}${stderrTail ? `：${stderrTail.slice(-500)}` : ''}`);
      }
    } catch (error) {
      failure = error;
      killTree(child);
    } finally {
      if (timer) clearTimeout(timer);
      this._running.delete(sessionId);
      this._sessions.set(sessionId, state);
    }

    if (text) {
      this.bus.push(assistantMessage(sessionId, turn, text));
    }
    if (failure) {
      this.log(`回合失败（${sessionId} / ${turn}）：${failure?.message ?? failure}`);
      this.bus.push(turnEnd(sessionId, turn, 'failed'));
      return;
    }
    this.bus.push(turnEnd(sessionId, turn, 'completed'));
  }

  _enqueue(sessionId, task) {
    const prev = this._chains?.get(sessionId) ?? Promise.resolve();
    if (!this._chains) this._chains = new Map();
    const next = prev.then(task, task);
    this._chains.set(sessionId, next.catch(() => {}));
    return next;
  }

  /* ── 门面 ────────────────────────────────────────────────────────────── */

  get sessions() {
    const self = this;
    return {
      async create(params = {}) {
        const sessionId = `${self.driver.id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        self._sessions.set(sessionId, { nativeId: null, cwd: self._cwdOf(sessionId) });
        return { result: { ok: true, value: { sessionId, id: sessionId, directory: self._cwdOf(sessionId) } } };
      },

      async list() {
        return {
          result: {
            ok: true,
            value: {
              items: [...self._sessions.entries()].map(([sessionId, s]) => ({
                sessionId,
                origin: 'user',
                parentSessionId: null,
                cwd: s.cwd,
                title: null,
                archived: false
              }))
            }
          }
        };
      },

      /** 非阻塞：立刻返回 accepted，输出走事件流。 */
      async prompt(params = {}) {
        const sessionId = params.sessionId ?? params.sessionID;
        if (!sessionId) return { result: { ok: false, error: { code: 'invalid', message: '缺少 sessionId' } } };
        const blocks = Array.isArray(params.content) ? params.content : [];
        const promptText = params.text ?? blocks.filter((b) => b?.type === 'text').map((b) => b.text).join('\n');
        if (!promptText) return { result: { ok: false, error: { code: 'invalid', message: '空内容' } } };

        self._enqueue(sessionId, () => self._runTurn(sessionId, promptText));
        return { result: { ok: true, value: { accepted: true, sessionId } } };
      },

      async selectModel(params = {}) {
        // 大多数 CLI 的模型靠参数或环境变量定，这里只记账，driver 自己取
        self._model = params.model ?? params.id ?? null;
        return { result: { ok: true, value: { selected: { provider: self.driver.id, model: self._model, reasoningEffort: null } } } };
      },

      async stats() {
        return { result: { ok: true, value: { sessions: self._sessions.size } } };
      },

      async messages() {
        return { result: { ok: true, value: { messages: [] } } };
      }
    };
  }

  get workspace() {
    const self = this;
    return {
      async create(params = {}) {
        const dir = params.path ? path.resolve(params.path) : process.cwd();
        return { result: { ok: true, value: { created: true, workspace: { workspaceId: dir, path: dir, title: path.basename(dir) } } } };
      },
      async rename() {
        return { result: { ok: true, value: { renamed: false } } };
      },
      async archiveSession(params = {}) {
        const sessionId = params.sessionId ?? params.sessionID;
        self.stopSessionWork(sessionId);
        self._sessions.delete(sessionId);
        self.turns.forget(sessionId);
        return { result: { ok: true, value: { archived: true, deleted: true } } };
      }
    };
  }

  get events() {
    const self = this;
    return {
      follow(sessionId) {
        return { sessionId };
      },
      forget() {},
      mux() {
        return self.bus.iterate();
      }
    };
  }

  async respond() {
    throw new Error('respond: CLI 后端没有审批通道（已在启动参数里定死权限）');
  }

  async stopSessionWork(sessionId) {
    const running = this._running.get(sessionId);
    if (!running) return { result: { ok: true, value: { stopped: false } } };
    killTree(running.child);
    this._running.delete(sessionId);
    return { result: { ok: true, value: { stopped: true } } };
  }

  async callUnary(method) {
    if (method !== 'session.modelCatalog' && method !== 'session.models') {
      return { result: { ok: false, error: { code: 'unsupported', message: `CLI 后端没有 RPC ${method}` } } };
    }
    return {
      result: {
        ok: true,
        value: {
          groups: [
            {
              id: this.driver.id,
              models: [{ id: this._model ?? 'default', name: this._model ?? 'default', inputModalities: ['text'] }]
            }
          ]
        }
      }
    };
  }

  currentModel() {
    return null;
  }

  chainStatus() {
    return [];
  }

  invalidate() {}

  async close() {
    for (const { child } of this._running.values()) killTree(child);
    this._running.clear();
    this.bus.close();
  }
}

/**
 * 杀掉子进程及其子进程。
 * Windows 上 CLI 往往会再拉一层子进程（node → shell），只 kill 父进程会留孤儿。
 */
function killTree(child) {
  if (!child || child.killed) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    } else {
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, KILL_GRACE_MS).unref?.();
    }
  } catch {
    /* 进程可能已经没了 */
  }
}
