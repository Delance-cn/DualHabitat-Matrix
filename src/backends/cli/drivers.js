/**
 * backends/cli/drivers.js —— 每个 CLI agent 一份"驱动描述"。
 *
 * 一个 driver 只回答三个问题：
 *   1. 怎么拼参数（buildArgs）
 *   2. 输出是什么格式（parseLine + mode）
 *   3. 怎么降权（buildArgs 里根据 allowTools 决定）
 *
 * ## 关于 verified 标记
 *
 * `verified: true`  = 参数按官方 headless 文档核对过。
 * `verified: false` = **没核实**，只是占位。别直接上线，先跑一次 `--help` 对参数。
 *
 * 这份表里只写核实过的。没核实的不编参数 —— 编出来的参数看着像真的，
 * 跑起来才发现不对，比空着更费时间。未核实的清单见文件末尾的 `UNVERIFIED`。
 */

import path from 'node:path';
import os from 'node:os';

/* ══════════════════════════════════════════════════════════════════════════
 * 一、Claude Code
 * ══════════════════════════════════════════════════════════════════════════ */

export const claudeCode = {
  id: 'claude-code',
  label: 'Claude Code',
  bin: 'claude',
  verified: true,
  /** assistant 帧携带完整文本，不是增量。 */
  mode: 'replace',
  promptVia: 'stdin',

  buildArgs({ nativeSessionId, allowTools, safeNamespaces }) {
    const args = ['-p', '--output-format', 'stream-json', '--verbose'];

    if (nativeSessionId) args.push('--resume', String(nativeSessionId));

    if (allowTools) {
      // 只放行 QQ 相关的 MCP 命名空间
      args.push('--allowedTools', safeNamespaces.join(','));
    } else {
      // 群聊模式：本地工具全砍，只留规划能力
      args.push('--disallowedTools', 'Bash,Write,Edit,Read,Glob,Grep,Task,WebFetch,WebSearch,NotebookEdit');
      args.push('--permission-mode', 'plan');
    }
    return args;
  },

  parseLine(line) {
    let json;
    try {
      json = JSON.parse(line);
    } catch {
      return null;
    }
    // 开场帧带 session_id，续会话靠它
    if (json.type === 'system' && json.subtype === 'init') {
      return { nativeSessionId: json.session_id };
    }
    // 最终结果帧：result 字段就是完整回复
    if (json.type === 'result') {
      const usage = json.usage
        ? {
            inputTokens: json.usage.input_tokens ?? 0,
            outputTokens: json.usage.output_tokens ?? 0,
            reasoningTokens: 0,
            cacheReadTokens: json.usage.cache_read_input_tokens ?? 0,
            cacheWriteTokens: json.usage.cache_creation_input_tokens ?? 0
          }
        : null;
      return {
        text: typeof json.result === 'string' ? json.result : '',
        nativeSessionId: json.session_id,
        usage
      };
    }
    // 中间帧（工具调用/思考）不产出文本，避免把过程当答案
    return null;
  }
};

/* ══════════════════════════════════════════════════════════════════════════
 * 二、Codex CLI
 * ══════════════════════════════════════════════════════════════════════════ */

export const codexCli = {
  id: 'codex-cli',
  label: 'Codex CLI',
  bin: 'codex',
  verified: true,
  mode: 'replace',
  promptVia: 'stdin',

  buildArgs({ nativeSessionId, allowTools, cwd }) {
    const args = ['exec', '--output-format', 'jsonl'];

    if (nativeSessionId) args.push('resume', String(nativeSessionId));
    if (cwd) args.push('--cd', cwd);

    // 只读沙箱 + 永不自动批准：agent 能想，但动不了本机
    if (!allowTools) {
      args.push('--sandbox', 'read-only');
      args.push('--ask-for-approval', 'never');
    }
    return args;
  },

  parseLine(line) {
    let json;
    try {
      json = JSON.parse(line);
    } catch {
      return null;
    }

    // session_meta 里有会话 id
    if (json.type === 'session_meta' || json.record_type === 'session_meta') {
      const id = json.payload?.id ?? json.session_id ?? json.id;
      return id ? { nativeSessionId: id } : null;
    }

    // agent 的完整消息
    const text =
      json.payload?.message ??
      json.item?.text ??
      json.msg?.content ??
      (typeof json.text === 'string' ? json.text : null);

    if (typeof text === 'string' && text) {
      // 只收 agent 角色的消息，避免把用户回声当回复
      const role = json.payload?.role ?? json.item?.role ?? json.role;
      if (role && role !== 'assistant' && role !== 'agent') return null;
      return { text };
    }
    return null;
  }
};

/* ══════════════════════════════════════════════════════════════════════════
 * 三、Gemini CLI 系（含 Qwen Code —— 同一个 fork 系谱，参数一致）
 * ══════════════════════════════════════════════════════════════════════════ */

function geminiFamily({ id, label, bin }) {
  return {
    id,
    label,
    bin,
    verified: true,
    /** stream-json 是逐事件增量，累加。 */
    mode: 'delta',
    promptVia: 'stdin',

    buildArgs({ nativeSessionId, allowTools }) {
      const args = ['-p', '--output-format', 'stream-json'];
      if (nativeSessionId) args.push('--resume', String(nativeSessionId));
      // 不传 --yolo：默认审批模式在 headless 下会拒绝工具，正好是我们想要的
      if (allowTools) args.push('--approval-mode', 'auto_edit');
      return args;
    },

    parseLine(line) {
      let json;
      try {
        json = JSON.parse(line);
      } catch {
        return null;
      }

      if (json.type === 'init' || json.subtype === 'init') {
        const id = json.session_id ?? json.sessionId;
        return id ? { nativeSessionId: id } : null;
      }

      // 增量文本
      const delta = json.delta?.text ?? json.text ?? json.content?.parts?.[0]?.text;
      if (typeof delta === 'string' && delta) {
        const role = json.role ?? json.author ?? 'assistant';
        if (role === 'user') return null;
        return { delta };
      }

      const usage = json.usage ?? json.stats;
      if (usage) {
        return {
          usage: {
            inputTokens: usage.input_tokens ?? usage.promptTokenCount ?? 0,
            outputTokens: usage.output_tokens ?? usage.candidatesTokenCount ?? 0,
            reasoningTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0
          }
        };
      }
      return null;
    }
  };
}

export const geminiCli = geminiFamily({ id: 'gemini-cli', label: 'Gemini CLI', bin: 'gemini' });
export const qwenCode = geminiFamily({ id: 'qwen-code', label: 'Qwen Code', bin: 'qwen' });

/* ══════════════════════════════════════════════════════════════════════════
 * 四、Kiro CLI（KiroCrew 自带，不在 PATH 里）
 *
 * 实测版本：kiro-cli（随 KiroCrew 3.x 安装）。
 *
 * 输出是 ACP 事件的 JSONL：
 *   {"type":"runStarted","data":{...}}
 *   {"type":"metadata","data":{"sessionId":"…",…}}              ← 会话 id
 *   {"type":"sessionUpdate","data":{"update":{
 *        "sessionUpdate":"agent_message_chunk",
 *        "content":{"type":"text","text":"片段"}}}}             ← **增量**片段
 *   {"type":"runFinished","data":{"status":"success",
 *        "finalText":"完整文本",…}}                              ← 权威全文
 *
 * 坑：
 *   1. 同一行流里会混进 `[INFO] …` / `[ERROR] …` 纯文本（v3 引擎尤其多），
 *      所以 parseLine 必须容忍非 JSON 行。
 *   2. `--resume-id` 指向不存在的会话时**不报错**，会静默开新会话并切到 v3 引擎。
 *      所以我们只写回真正从 metadata 里拿到的 id。
 *   3. `--trust-tools=xxx` 是白名单，`--trust-tools=`（空）= 一个都不给。
 *      `--trust-all-tools` 是另一个开关，等于全给 —— 只在明确要求时用。
 * ══════════════════════════════════════════════════════════════════════════ */

/** 按会话累加增量 —— 用来同时提供流式片段和"整段覆盖"的权威文本。 */
const kiroAcc = new Map();

export const kiroCli = {
  id: 'kiro-cli',
  label: 'Kiro CLI',
  bin: 'kiro-cli',
  binFallbacks: [
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'KiroCrew', 'resources', 'backend-dist', 'kiro-cli', 'kiro-cli.exe')
  ],
  verified: true,
  /** 我们每帧都回整段（text），所以用 replace 语义；delta 只用于前端流式显示。 */
  mode: 'replace',
  promptVia: 'stdin',

  /** 给控制台渲染用（server.mjs 直接读这个，不另写一份）。 */
  optionsSchema: [
    { key: 'model', type: 'text', label: '模型', hint: '留空用 Kiro 默认；可先跑 kiro-cli chat --list-models 看可选项' },
    { key: 'agent', type: 'text', label: 'Agent', hint: '--agent，留空用默认' },
    { key: 'effort', type: 'select', label: '推理强度', options: ['', 'low', 'medium', 'high', 'xhigh', 'max'] },
    { key: 'trustTools', type: 'text', label: '允许的工具', hint: '逗号分隔，如 fs_read,fs_write；留空 = 一个都不给' },
    { key: 'trustAllTools', type: 'bool', label: '放开全部工具', hint: '等于 --trust-all-tools，能在本机读写执行，主人档专用' }
  ],

  buildArgs({ nativeSessionId, allowTools, options = {} }) {
    const args = ['chat', '--no-interactive', '--output-format', 'stream-json'];

    if (nativeSessionId) args.push('--resume-id', String(nativeSessionId));
    if (options.model) args.push('--model', String(options.model));
    if (options.agent) args.push('--agent', String(options.agent));
    if (options.effort) args.push('--effort', String(options.effort));

    if (allowTools && options.trustAllTools === true) {
      // 全权：能读写文件、能跑命令。只有主人在私聊里才该走到这里。
      args.push('--trust-all-tools');
    } else {
      // 默认只给只读文件权限；群聊（allowTools=false）一个都不给。
      const trust = options.trustTools ?? (allowTools ? 'fs_read' : '');
      args.push(`--trust-tools=${trust}`);
    }
    return args;
  },

  parseLine(line, { sessionId } = {}) {
    let json;
    try {
      json = JSON.parse(line);
    } catch {
      // [INFO]/[ERROR] 之类的日志行，跳过
      return null;
    }

    const data = json.data ?? {};

    if (json.type === 'sessionUpdate') {
      // 只认 agent 的**正文**片段；agent_thought_chunk / tool_call 一律丢掉，
      // 否则思考过程会被当成回复发到群里。
      const update = data.update ?? {};
      if (update.sessionUpdate !== 'agent_message_chunk') return null;
      const content = update.content ?? {};
      if (content.type !== 'text') return null;

      const fragment = typeof content.text === 'string' ? content.text : '';
      if (!fragment) return null;

      const key = sessionId ?? data.sessionId ?? '_';
      const next = (kiroAcc.get(key) ?? '') + fragment;
      kiroAcc.set(key, next);
      return { delta: fragment, text: next };
    }

    if (json.type === 'runFinished') {
      const key = sessionId ?? data.sessionId ?? '_';
      const accumulated = kiroAcc.get(key) ?? '';
      kiroAcc.delete(key);

      if (data.status && data.status !== 'success') {
        return { error: `Kiro 回合未成功（status=${data.status}${data.stopReason ? `, stopReason=${data.stopReason}` : ''}）` };
      }

      // finalText 是权威全文：万一某些片段没走 agent_message_chunk，靠它补齐
      const finalText = typeof data.finalText === 'string' ? data.finalText : '';
      if (finalText && finalText !== accumulated) return { text: finalText };
      return null;
    }

    if (json.type === 'metadata' && data.sessionId) {
      return { nativeSessionId: String(data.sessionId) };
    }

    return null;
  }
};

/* ══════════════════════════════════════════════════════════════════════════
 * 五、Cline CLI（Cline 桌面版自带，不在 PATH 里）
 *
 * 实测版本：cline-cli 3.0.73。
 *
 * `--json` 输出 JSONL：
 *   {"type":"hook_event","hookEventName":"agent_start","taskId":"conv_…"}
 *   {"type":"agent_event","event":{"type":"content_start",
 *        "contentType":"text","text":"片段","accumulated":"目前全文"}}
 *   {"type":"agent_event","event":{"type":"content_start",
 *        "contentType":"reasoning","reasoning":"思考"}}          ← 必须丢掉
 *   {"type":"run_result","finishReason":"completed","text":"全文",
 *        "usage":{"inputTokens":…,"outputTokens":…,"totalCost":…}}
 *
 * 三个已实测的坑（都别"优化"掉）：
 *
 *   1. **不认 stdin**。help 里写着"或 piped stdin"，但 3.0.73 在 Windows 上
 *      PowerShell 管道 / cmd 重定向 / Node spawn 三种方式全部回
 *      "JSON output mode requires a prompt argument or piped stdin"。
 *      所以只能走 promptVia:'arg'。引擎是 shell:false + argv 数组，
 *      不经过 cmd，中文和引号由 Node 转义，是安全的。
 *
 *   2. **单 token 的 prompt 会被当成子命令**。它靠"原始命令行里有没有引号"
 *      判断，而 Node 只给含空白的参数加引号 —— 于是 `你好` / `hello` 直接报
 *      "Unknown command or unquoted prompt"。补一个尾随空格即可（实测有效）。
 *      中文单句在 QQ 里太常见了，这条不能少。
 *
 *   3. **`--id` 是坏的**。任何位置、任何写法（`--id X`、`--id=X`、放 positional
 *      前后）都会触发上面那个 "requires a prompt argument" 错误。所以 Cline
 *      这一版**没法续会话**，上下文靠 driver 自己回放（见 history）。
 *
 *   工具权限：`--auto-approve false` 实测能在无 TTY 下**拒绝所有工具调用**
 *   （报 "requires approval in a TTY session"），正好当群聊降权用。
 * ══════════════════════════════════════════════════════════════════════════ */

/** sessionId → 已完成的若干轮对话（Cline 不能 resume，只能自己喂回去）。 */
const clineTranscript = new Map();
/** sessionId → 本轮的用户输入（buildArgs 存，run_result 取）。 */
const clinePending = new Map();

const CLINE_MAX_TURNS = 6;
const CLINE_MAX_TURN_CHARS = 400;
const CLINE_MAX_TOTAL_CHARS = 3000;

function clineReplay(sessionId, promptText) {
  const turns = clineTranscript.get(sessionId);
  if (!sessionId || !turns?.length) return promptText;

  const lines = ['[之前的对话，仅作参考]'];
  let budget = CLINE_MAX_TOTAL_CHARS;
  for (let i = turns.length - 1; i >= 0 && budget > 0; i -= 1) {
    const t = turns[i];
    const user = String(t.user ?? '').slice(0, CLINE_MAX_TURN_CHARS);
    const bot = String(t.assistant ?? '').slice(0, CLINE_MAX_TURN_CHARS);
    const block = `用户：${user}\n你：${bot}`;
    if (block.length > budget) break;
    budget -= block.length;
    lines.splice(1, 0, block);
  }
  if (lines.length === 1) return promptText;
  lines.push('[当前消息]');
  return `${lines.join('\n')}\n${promptText}`;
}

export const clineCli = {
  id: 'cline-cli',
  label: 'Cline CLI',
  bin: 'cline-cli',
  binFallbacks: [path.join(os.homedir(), 'AppData', 'Local', 'Cline', 'cline-cli.exe')],
  verified: true,
  mode: 'replace',
  /** 3.0.73 在 Windows 上不读 stdin，只能拼参数位。 */
  promptVia: 'arg',

  optionsSchema: [
    { key: 'provider', type: 'text', label: 'Provider', default: 'openrouter', hint: 'Cline 的 -P；用 cline 自己的账号可填 cline' },
    { key: 'model', type: 'text', label: '模型', default: 'openrouter/free', hint: 'Cline 的 -m，必须非空' },
    { key: 'plan', type: 'bool', label: '计划模式', hint: '加 -p，只规划不改文件' },
    // 这两个默认值必须跟 buildArgs 里的判断一致（`!== false`），
    // 否则界面上没勾、运行时却生效，等于骗人。
    { key: 'autoApprove', type: 'bool', label: '自动批准工具', default: true, hint: '仅当 allowTools 为真时生效；关掉等于工具全拒' },
    { key: 'replayHistory', type: 'bool', label: '回放历史', default: true, hint: '3.0.73 的 --id 是坏的，只能把前几轮对话塞进 prompt' },
    { key: 'retries', type: 'number', label: '重试次数', hint: '--retries' }
  ],

  buildArgs({ promptText, cwd, allowTools, sessionId, options = {} }) {
    const provider = options.provider ?? 'openrouter';
    const model = options.model ?? 'openrouter/free';

    // 没配 key 时早失败，别让用户对着 "exit 1 + 空输出" 猜
    if (provider === 'openrouter' && !process.env.OPENROUTER_API_KEY) {
      throw new Error('Cline 用 openrouter 需要 OPENROUTER_API_KEY（写在 secrets.json 里），或在 backend.cli.options 换别的 provider');
    }

    const args = ['--json'];
    // 每个会话一个独立数据目录：不碰用户 Cline 桌面版的会话库，也顺带互相隔离
    args.push('--data-dir', options.dataDir ?? path.join(cwd, '.cline-data'));
    args.push('-P', String(provider));
    args.push('-m', String(model));
    if (options.plan === true) args.push('-p');
    if (options.retries) args.push('--retries', String(options.retries));

    // allowTools 为假 → 工具全拒（实测生效）；为真 → 自动批准（主人档）
    args.push('--auto-approve', allowTools && options.autoApprove !== false ? 'true' : 'false');

    if (sessionId) clinePending.set(sessionId, promptText);

    const body = options.replayHistory === false ? promptText : clineReplay(sessionId, promptText);
    // 坑 2：必须让命令行里出现空白，Node 才会给这个参数加引号
    args.push(/\s/.test(body) ? body : `${body} `);
    return args;
  },

  parseLine(line, { sessionId } = {}) {
    let json;
    try {
      json = JSON.parse(line);
    } catch {
      return null;
    }

    if (json.type === 'error' && typeof json.message === 'string') {
      return { error: json.message };
    }

    if (json.type !== 'agent_event') {
      if (json.type === 'run_result') {
        const usage = json.usage ?? {};
        const usageShape = {
          inputTokens: usage.inputTokens ?? 0,
          outputTokens: usage.outputTokens ?? 0,
          reasoningTokens: 0,
          cacheReadTokens: usage.cacheReadTokens ?? 0,
          cacheWriteTokens: usage.cacheWriteTokens ?? 0
        };

        if (json.finishReason && json.finishReason !== 'completed') {
          // 失败时 run_result.text 是**错误信息**，不能当回复发出去
          return { error: json.text || `Cline 回合失败（${json.finishReason}）`, usage: usageShape };
        }

        const text = typeof json.text === 'string' ? json.text : '';
        if (sessionId && text) {
          const user = clinePending.get(sessionId);
          clinePending.delete(sessionId);
          const turns = clineTranscript.get(sessionId) ?? [];
          turns.push({ user, assistant: text });
          if (turns.length > CLINE_MAX_TURNS) turns.splice(0, turns.length - CLINE_MAX_TURNS);
          clineTranscript.set(sessionId, turns);
        }
        return { text, usage: usageShape };
      }
      return null;
    }

    const event = json.event ?? {};
    // 只要正文；reasoning（思维链）和 tool 一律不碰
    if (event.type === 'content_start' && event.contentType === 'text') {
      const fragment = typeof event.text === 'string' ? event.text : '';
      if (!fragment) return null;
      const whole = typeof event.accumulated === 'string' && event.accumulated ? event.accumulated : fragment;
      return { delta: fragment, text: whole };
    }
    return null;
  }
};

/* ══════════════════════════════════════════════════════════════════════════
 * 六、通用兜底：任何"喂 prompt 吐纯文本"的 CLI
 *
 * 用于那些只输出人读文本、没有结构化事件的工具（Aider 之类）。
 * 代价：拿不到会话 id（除非工具自己支持），上下文靠每次重发历史。
 * ══════════════════════════════════════════════════════════════════════════ */

export function makeGenericDriver({ id, label, bin, extraArgs = [], promptFlag = '-p' }) {
  return {
    id,
    label,
    bin,
    verified: false,
    mode: 'replace',
    promptVia: 'stdin',
    buildArgs() {
      return [promptFlag, ...extraArgs];
    },
    /** 纯文本：整行拼起来就是答案。 */
    parseLine(line) {
      return line.trim() ? { text: line } : null;
    }
  };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 七、注册表
 * ══════════════════════════════════════════════════════════════════════════ */

export const DRIVERS = {
  'claude-code': claudeCode,
  'codex-cli': codexCli,
  'gemini-cli': geminiCli,
  'qwen-code': qwenCode,
  'kiro-cli': kiroCli,
  'cline-cli': clineCli
};

export function getDriver(id) {
  const driver = DRIVERS[id];
  if (!driver) {
    throw new Error(
      `不认识 CLI 后端 "${id}"。已核实可用的：${Object.keys(DRIVERS).join(' / ')}。` +
        `其他工具请先用 makeGenericDriver() 接，或补一份 driver（见本文件末尾 UNVERIFIED）。`
    );
  }
  return driver;
}

/**
 * 未接的工具清单 —— 只记元信息，**不写参数**。
 *
 * 用法：装好之后跑一次 `--help`，确认三件事再补 driver：
 *   1. 无头模式怎么触发（`-p`？`exec`？`--print`？）
 *   2. 有没有结构化输出（`--output-format json/stream-json`？）
 *   3. 工具权限怎么收（沙箱？白名单？审批模式？）
 *
 * 第 3 条查不到的，一律不要接成群聊后端。
 *
 * `verdict` 三种：
 *   unverified   装了，但还没核对参数
 *   not-installed 当前机器上没有可用的可执行文件
 *   not-a-cli    这个产品根本没有 agent 式的命令行入口（GUI/IM 客户端/HTTP 服务）
 */
export const UNVERIFIED = [
  { id: 'aider', label: 'Aider', bin: 'aider', verdict: 'not-installed', hint: '--message + --yes，无结构化输出，适合走 generic' },
  { id: 'hermes-agent', label: 'Hermes Agent', bin: 'hermes', verdict: 'not-installed', hint: '查无头模式与输出格式' },
  { id: 'deepseek-tui', label: 'DeepSeek-TUI', bin: 'deepseek', verdict: 'not-installed', hint: 'TUI 优先，无头能力待查' },
  { id: 'mimocode', label: 'MiMoCode', bin: 'mimo', verdict: 'not-installed', hint: '查无头与权限参数' },
  { id: 'minimax-code-cli', label: 'MiniMax Code CLI', bin: 'minimax', verdict: 'not-installed', hint: '查无头与输出格式' },
  { id: 'pi', label: 'Pi', bin: 'pi', verdict: 'not-installed', hint: '查 -p / --print 语义' },

  /* ── 2026-10-18 逐个扫过安装目录后的结论 ───────────────────────────── */

  {
    id: 'copilot-cli',
    label: 'GitHub Copilot',
    bin: 'copilot',
    verdict: 'not-installed',
    hint:
      '桌面版（github.exe）不带命令行 agent：目录里只有 computer-use MCP、excel/word/ppt 插件和 copilot-sdk 的 .d.ts，' +
      '没有任何 bin 入口。要用得单独装官方 @github/copilot CLI，装好后再补 driver。'
  },
  {
    id: 'kimi-cli',
    label: 'Kimi',
    bin: 'kimi',
    verdict: 'not-a-cli',
    hint:
      'Kimi 桌面版里的 kimiim-cli.exe 是**群聊 IM 客户端**（send-message / list-members / notify-owner），不是 AI agent；' +
      '同目录的 kimi-slides / kimi-webbridge 是幻灯片和网页桥。没有可当对话后端的无头入口。'
  },
  {
    id: 'deepseek-harness',
    label: 'DeepSeek Harness',
    bin: 'dsh',
    verdict: 'not-a-cli',
    hint:
      '是 Electron 应用 + 本地 HTTP 服务（默认 3080），不是 CLI。' +
      '真要用它得写一个 HTTP 后端（类似 model-api 那层），不属于 driver 体系。'
  },
  {
    id: 'microsoft-copilot',
    label: 'Microsoft Copilot',
    bin: 'copilot',
    verdict: 'not-a-cli',
    hint:
      '没有可执行入口：既没有 MSIX 包（Get-AppxPackage 查不到），也没有开始菜单快捷方式，' +
      '只剩 %LOCALAPPDATA%\\Microsoft\\Copilot\\User Data 这种 WebView 残留。本质是网页/PWA，没有 CLI。'
  }
];
