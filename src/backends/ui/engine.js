/**
 * backends/ui/engine.js —— 前台客户端后端。
 *
 * 把「本机已经登录好的 AI 客户端窗口」接成 QQ / 微信的对话大脑：
 * 桥接发来的提示词 → 驱动窗口发送 → 读回回答 → 走事件帧回桥接。
 *
 * ## 为什么要有这个后端
 *
 * API key 会过期、会烧完；桌面客户端里的订阅不会。对「人在手机上、电脑空着」
 * 的用法，让桥接去驱动客户端窗口是最省钱的模型来源。代价：
 *   - 一次只能驱动一个窗口（全局串行，窗口被占用就排队）；
 *   - 靠 UIA 读屏提取回答，客户端改版可能要调参数；
 *   - 没有工具、没有文件读写 —— 它只是一个会聊天的窗口。
 *
 * ## 发送的两条路（src/backends/ui/drive.ps1）
 *
 *   uia  SetValue 直写输入框 + Invoke 点发送。不碰焦点、不碰剪贴板，
 *        最优雅 —— 但 React 系客户端不认 UIA 写值（发送按钮不会变亮），多数会失败。
 *   keys 激活窗口 → UIA SetFocus 到输入框 → 全选覆盖粘贴 → 发送键。
 *        需要抢焦点；空闲保护（idleGuardMs）挡住「真人正在用电脑」的情况。
 *
 *   默认 auto：先试 uia，落空自动 keys。发送成功以「输入框值被客户端清空」为准。
 *
 * ## 安全
 *
 *   - 粘贴前必须确认前台就是目标窗口，否则绝不发送（防止粘进别的程序）；
 *   - 空闲保护：keys 模式下，检测到用户几秒内有过输入就整轮放弃；
 *   - prompt 走临时文件（UTF-8 BOM），不进命令行，躲开引号地狱。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventBus, turnStart, assistantMessage, turnEnd, TurnCounter } from '../base.js';

const clamp = (v, lo, hi, dflt) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(Math.max(Math.floor(n), lo), hi);
};

export class UiBackend {
  /**
   * @param {object} config
   * @param {object} config.ui    config.json 的 backend.ui 段
   * @param {number} [config.timeoutMs]  单轮总超时（毫秒），默认 maxWaitMs + 45s
   * @param {string} [config.stateDir]
   * @param {(msg:string)=>void} [config.log]
   */
  constructor(config = {}) {
    this.type = 'ui';
    this.log = config.log ?? (() => {});
    const ui = config.ui ?? {};
    this.cfg = {
      process: String(ui.process ?? '').trim(),
      titleRegex: String(ui.titleRegex ?? '').trim(),
      inputMode: ['auto', 'uia', 'keys'].includes(ui.inputMode) ? ui.inputMode : 'auto',
      sendKeys: (String(ui.sendKeys ?? '').trim() || '{ENTER}'),
      sendButtonRegex: (String(ui.sendButtonRegex ?? '').trim() || '^发送$|^Send$'),
      inputNameRegex: (String(ui.inputNameRegex ?? '').trim() || '提示词|输入|prompt|message|ask'),
      minWaitMs: clamp(ui.minWaitMs, 0, 600000, 6000),
      maxWaitMs: clamp(ui.maxWaitMs, 10000, 1800000, 240000),
      pollMs: clamp(ui.pollMs, 300, 10000, 1500),
      stableRounds: clamp(ui.stableRounds, 1, 20, 3),
      idleGuardMs: clamp(ui.idleGuardMs, 0, 3600000, 5000),
      stopRegex: String(ui.stopRegex ?? '').trim(),
      copyButtonRegex: String(ui.copyButtonRegex ?? '').trim(),
      readMode: ['auto', 'uia', 'keys', 'clipboard'].includes(ui.readMode) ? ui.readMode : 'auto',
      clickInputPct: (String(ui.clickInputPct ?? '').trim() || '42%,48%;50%,48%;50%,90%'),
      clickReadPct: (String(ui.clickReadPct ?? '').trim() || '50%,80%'),
      newChatButtonRegex: (String(ui.newChatButtonRegex ?? '').trim() || '新建会话|新对话|New [Cc]hat|新聊天')
    };
    this.timeoutMs = clamp(config.timeoutMs, 10000, 3600000, this.cfg.maxWaitMs + 45_000);

    if (!this.cfg.process && !this.cfg.titleRegex) {
      throw new Error('前台后端要配「进程名」（ui.process）或「窗口标题正则」（ui.titleRegex）至少一个。');
    }
    this.stateDir = config.stateDir ?? path.join(process.cwd(), '.oc', 'state', 'backends', 'ui');
    fs.mkdirSync(this.stateDir, { recursive: true });

    this.bus = new EventBus();
    this.turns = new TurnCounter();
    /** sessionId → { cwd }（目录只是占位，契约需要它） */
    this._sessions = new Map();
    /** 当前正在跑的 { sessionId, turn, child } */
    this._running = null;
    /** 全局串行：一次只能驱动一个窗口 */
    this._chain = Promise.resolve();
  }

  _script() {
    return path.join(path.dirname(fileURLToPath(import.meta.url)), 'drive.ps1');
  }

  async _runTurn(sessionId, promptText) {
    const turn = this.turns.next(sessionId);
    this.bus.push(turnStart(sessionId, turn));
    this._running = { sessionId, turn, child: null };

    const promptFile = path.join(os.tmpdir(), `dhm-ui-prompt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.txt`);
    // BOM：PowerShell 5.1 的 ReadAllText 配 UTF8 编码参数无所谓 BOM，但带上最稳
    fs.writeFileSync(promptFile, '\ufeff' + promptText, 'utf8');

    const args = [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', this._script(),
      '-PromptFile', promptFile,
      '-Process', this.cfg.process,
      '-TitleRegex', this.cfg.titleRegex,
      '-InputMode', this.cfg.inputMode,
      '-SendKeys', this.cfg.sendKeys,
      '-SendButtonRegex', this.cfg.sendButtonRegex,
      '-InputNameRegex', this.cfg.inputNameRegex,
      '-MinWaitMs', String(this.cfg.minWaitMs),
      '-MaxWaitMs', String(this.cfg.maxWaitMs),
      '-PollMs', String(this.cfg.pollMs),
      '-IdleGuardMs', String(this.cfg.idleGuardMs),
      '-StableRounds', String(this.cfg.stableRounds),
      '-StopRegex', this.cfg.stopRegex,
      '-CopyButtonRegex', this.cfg.copyButtonRegex,
      '-ReadMode', this.cfg.readMode,
      '-ClickInputPct', this.cfg.clickInputPct,
      '-ClickReadPct', this.cfg.clickReadPct
    ];

    let failure = null;
    let answer = '';
    let stdoutBuf = '';
    let stderrTail = '';

    try {
      const child = spawn('powershell.exe', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      this._running.child = child;

      const timer =
        this.timeoutMs > 0
          ? setTimeout(() => {
              this.log(`前台后端超时（${this.timeoutMs}ms），终止驱动进程`);
              killTree(child);
            }, this.timeoutMs)
          : null;

      child.stderr.on('data', (chunk) => {
        const lines = String(chunk).split(/\r?\n/).filter(Boolean);
        for (const line of lines) {
          stderrTail = (stderrTail + line + '\n').slice(-2000);
          this.log(line);
        }
      });
      child.stdout.on('data', (chunk) => { stdoutBuf += String(chunk); });

      const exitCode = await new Promise((resolve) => child.once('close', resolve));
      if (timer) clearTimeout(timer);

      // stdout 的最后一行 JSON 是结果；前面可能混进别的东西，倒着找
      const lines = stdoutBuf.split(/\r?\n/).filter((l) => l.trim().startsWith('{'));
      const lastJson = lines[lines.length - 1];
      if (!lastJson) {
        failure = new Error(
          `驱动脚本没有返回结果（exit ${exitCode}）。${stderrTail ? `最后输出：${stderrTail.slice(-400)}` : ''}`
        );
      } else {
        let parsed;
        try {
          parsed = JSON.parse(lastJson);
        } catch (error) {
          failure = new Error(`驱动结果不是 JSON：${error?.message ?? error}`);
        }
        if (!failure) {
          if (parsed.ok !== true) {
            failure = new Error(String(parsed.error ?? '前台驱动失败（没给原因）'));
          } else {
            answer = String(parsed.answer ?? '').trim();
            this.log(`前台客户端回了 ${answer.length} 字符（${parsed.sentVia ?? '?'} 路线，等了 ${Math.round((parsed.waitedMs ?? 0) / 1000)}s，客户端：${parsed.client ?? '?'}）`);
            if (!answer) {
              failure = new Error(
                '消息发出去了，但没读回答案 —— 客户端的回答区域 UIA 没暴露出来。' +
                  '试试在配置里加 StopRegex，或把答案区域的行为报告给开发者。'
              );
            }
          }
        }
      }
    } catch (error) {
      failure = error;
    } finally {
      try { fs.unlinkSync(promptFile); } catch { }
      this._running = null;
    }

    if (answer && !failure) {
      this.bus.push(assistantMessage(sessionId, turn, answer));
      this.bus.push(turnEnd(sessionId, turn, 'completed'));
      return;
    }
    if (failure) {
      this.log(`回合失败（${sessionId} / ${turn}）：${failure?.message ?? failure}`);
    } else {
      this.log(`回合失败（${sessionId} / ${turn}）：没有产出文本`);
    }
    this.bus.push(turnEnd(sessionId, turn, 'failed'));
  }

  /** 全局串行（不分会话）：一个窗口同时只能进一条。 */
  _enqueue(task) {
    const next = this._chain.then(task, task);
    this._chain = next.catch(() => { });
    return next;
  }

  get sessions() {
    const self = this;
    return {
      async create(params = {}) {
        const sessionId = `ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        self._sessions.set(sessionId, { cwd: self.stateDir });
        return { result: { ok: true, value: { sessionId, id: sessionId, directory: self.stateDir } } };
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
      async prompt(params = {}) {
        const sessionId = params.sessionId ?? params.sessionID;
        if (!sessionId) return { result: { ok: false, error: { code: 'invalid', message: '缺少 sessionId' } } };
        const blocks = Array.isArray(params.content) ? params.content : [];
        const textBlocks = blocks.filter((b) => b?.type === 'text').map((b) => String(b.text ?? ''));
        const other = blocks.filter((b) => b && b.type !== 'text');
        if (other.length) {
          self.log(`提示词里有 ${other.length} 个非文本块（图片/文件），前台后端这轮只能带文字。`);
        }
        const promptText = (params.text ?? textBlocks.join('\n')).trim();
        if (!promptText) return { result: { ok: false, error: { code: 'invalid', message: '空内容' } } };
        if (self._running) {
          return { result: { ok: false, error: { code: 'busy', message: '前台客户端正在跑上一条（一个窗口一次只能跑一条）' } } };
        }
        self._enqueue(() => self._runTurn(sessionId, promptText));
        return { result: { ok: true, value: { accepted: true, sessionId } } };
      },
      async selectModel(params = {}) {
        return { result: { ok: true, value: { selected: { provider: 'ui', model: params.model ?? null, reasoningEffort: null } } } };
      },
      async stats() {
        return { result: { ok: true, value: { sessions: self._sessions.size, busy: Boolean(self._running) } } };
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
      forget() { },
      mux() {
        return self.bus.iterate();
      }
    };
  }

  async respond() {
    throw new Error('respond: 前台后端没有审批通道');
  }

  async stopSessionWork(sessionId) {
    const running = this._running;
    if (!running || running.sessionId !== sessionId) return { result: { ok: true, value: { stopped: false } } };
    if (running.child) killTree(running.child);
    return { result: { ok: true, value: { stopped: true } } };
  }

  /** 让客户端窗口开一个新对话（点「新建会话」按钮）。桥接的 /reset 会调用它。
   *  全局串行：正在跑的回合结束后才执行；UIA Invoke 不需要抢焦点。 */
  async newThread() {
    return this._enqueue(() => this._newThreadOnce());
  }

  async _newThreadOnce() {
    const args = [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', this._script(),
      '-Action', 'newchat',
      '-Process', this.cfg.process,
      '-TitleRegex', this.cfg.titleRegex,
      '-NewChatButtonRegex', this.cfg.newChatButtonRegex
    ];
    try {
      const child = spawn('powershell.exe', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdoutBuf = '';
      let stderrTail = '';
      const timer = setTimeout(() => { try { child.kill(); } catch { } }, 20_000);
      child.stderr.on('data', (chunk) => { stderrTail = (stderrTail + String(chunk)).slice(-800); });
      child.stdout.on('data', (chunk) => { stdoutBuf += String(chunk); });
      const exitCode = await new Promise((resolve) => child.once('close', resolve));
      clearTimeout(timer);
      const lines = stdoutBuf.split(/\r?\n/).filter((l) => l.trim().startsWith('{'));
      const lastJson = lines[lines.length - 1];
      if (!lastJson) throw new Error(`驱动没有返回结果（exit ${exitCode}）${stderrTail ? '：' + stderrTail.slice(-200) : ''}`);
      const parsed = JSON.parse(lastJson);
      if (parsed.ok !== true) throw new Error(String(parsed.error ?? '新建会话失败'));
      this.log(`前台客户端已开新对话（${parsed.clicked ?? '?'}，客户端：${parsed.client ?? '?'}）`);
      return { result: { ok: true, value: { clicked: parsed.clicked ?? null } } };
    } catch (error) {
      return { result: { ok: false, error: { code: 'internal', message: String(error?.message ?? error) } } };
    }
  }

  async callUnary(method) {
    if (method !== 'session.modelCatalog' && method !== 'session.models') {
      return { result: { ok: false, error: { code: 'unsupported', message: `前台后端没有 RPC ${method}` } } };
    }
    const name = this.cfg.process || this.cfg.titleRegex || '前台客户端';
    return {
      result: {
        ok: true,
        value: {
          groups: [
            { id: 'ui', models: [{ id: name, name, inputModalities: ['text'] }] }
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

  invalidate() { }

  async close() {
    if (this._running?.child) killTree(this._running.child);
    this.bus.close();
  }
}

function killTree(child) {
  if (!child || child.killed) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    } else {
      child.kill('SIGTERM');
    }
  } catch {
    /* 进程可能已经没了 */
  }
}
