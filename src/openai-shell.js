/**
 * openai-shell.js —— OpenAI 兼容壳。
 *
 * 把本机 4599 模型 API 实例（OpenCode REST：会话制 + SSE 事件流）包成
 * `POST /v1/chat/completions`，市面工具（OpenAI SDK / Chatbox / LobeChat /
 * Continue / Dify …）把 baseURL 改成本机地址、填上 key 就能用。
 *
 * 为什么不能"直接反代"：4599 不是 OpenAI 协议，`POST /v1/chat/completions`
 * 实测 405（docs/LLM-INTEGRATION.md §1.3）。所以这一层必须真做翻译：
 *
 *   messages[]  →  一段带角色前缀的单次提示词
 *   建会话       →  sessions.create({ agentPreset })
 *   订阅事件流   →  events.follow + 常驻 mux（**不是每个请求开一条**）
 *   注入提示词   →  sessions.prompt({ mode:'queue' })
 *   等到 turn/end → 拿 assistant 文本
 *   归档会话     →  workspace.archiveSession（只 interrupt，不真删）
 *
 * 一期范围（NEXT-STEPS 里写的"非流式先行"）：
 *  - 非流式响应完整支持；
 *  - `stream:true` 走"假流式"：把全文当成一个 delta 发完再 [DONE]。
 *    客户端不会崩、内容也对，只是没有逐字感。真增量二期做。
 *  - `tools` / function calling 一期不转发（带了也不报错，只是走不到）。
 *
 * 为什么常驻一条 mux：`events.mux()` 内部是一条 SSE 订阅，`for await` 里 break
 * 不会关掉底层 pump（见 oc-client.js 5.5 节）。每个请求开一条 = 每次泄漏一条
 * 订阅，几分钟后实例就被打满。所以这里全局只开一条，按 sessionId 分发给等待者。
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { NodeApiClient, unwrap, createTurnCollector } from './oc-client.js';
import { ensureServer, portInUse } from './oc-server.js';
import { PATHS } from './oc-env.js';

/** 默认端口：避开 3000/3001（NapCat）、3100（桥接）、3200（桌面端）、3210（手机页）、4599/4600（模型侧）。 */
export const DEFAULT_PORT = 4610;

const BODY_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 180_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── 小工具 ──────────────────────────────────────────────────────────────── */

function sendJson(res, status, data) {
  const text = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store'
  });
  res.end(text);
}

/** OpenAI 的错误形状。客户端（SDK）靠 `error.message` 给人看，别回纯文本。 */
function sendError(res, status, message, type = 'invalid_request_error', code = null) {
  sendJson(res, status, { error: { message: String(message), type, code } });
}

function readBody(req, maxBytes = BODY_MAX_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error(`请求体太大（上限 ${Math.round(maxBytes / 1024 / 1024)} MB）`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error(`请求体不是合法 JSON：${error?.message ?? error}`));
      }
    });
    req.on('error', reject);
  });
}

/**
 * 粗略 token 估算：CJK 一个字≈1 token，其余按 4 字符≈1 token。
 * 只是给客户端显示用量用的，不参与计费 —— 真正记账在 token-ledger 里。
 */
function estimateTokens(text) {
  const s = String(text ?? '');
  let cjk = 0;
  let other = 0;
  for (const ch of s) {
    if (/[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/.test(ch)) cjk += 1;
    else other += 1;
  }
  return Math.max(0, Math.ceil(cjk + other / 4));
}

/**
 * OpenAI messages → 单次提示词。
 *
 * 4599 的会话本身不接收 messages 数组，只能收一段文本；多轮上下文由调用方
 * 每次都带全（这正是 chat/completions 的约定），所以这里把它摊平成"谁说了什么"。
 * 只有一条 user 消息时不做任何包装 —— 最常见的单轮调用不该被前缀污染。
 */
function messagesToPrompt(messages) {
  const list = (Array.isArray(messages) ? messages : [])
    .map((m) => {
      const content = typeof m?.content === 'string'
        ? m.content
        : Array.isArray(m?.content)
          ? m.content.filter((p) => p?.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('')
          : '';
      return { role: String(m?.role ?? 'user'), content };
    })
    .filter((m) => m.content.trim());
  if (!list.length) return '';
  if (list.length === 1 && list[0].role === 'user') return list[0].content;
  const label = { system: '系统设定', developer: '系统设定', user: '用户', assistant: '助手', tool: '工具结果' };
  return list.map((m) => `【${label[m.role] ?? m.role}】\n${m.content}`).join('\n\n');
}

/* ── key 管理 ────────────────────────────────────────────────────────────── */

/**
 * 读取或生成访问 key。
 *
 * 优先级：config 里手填的 > state/openai-shell.key（自动生成后落盘）> 新生成。
 * 为什么不写回 config.json：桥接和桌面端都会整文件重写 config.json，
 * 并发下很容易把刚生成的那行冲掉（AGENT-EXTENSIONS 硬纪律第 4 条）。
 */
export function loadOrCreateKey(keyFile, configured = '') {
  const fixed = String(configured ?? '').trim();
  if (fixed.length >= 8) return { key: fixed, created: false, source: 'config' };
  try {
    const saved = fs.readFileSync(keyFile, 'utf8').trim();
    if (saved.length >= 16) return { key: saved, created: false, source: 'state' };
  } catch { /* 第一次启动，没有这个文件 */ }
  const key = `dhm-${crypto.randomBytes(24).toString('hex')}`;
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  fs.writeFileSync(keyFile, `${key}\n`, { encoding: 'utf8', mode: 0o600 });
  return { key, created: true, source: 'generated' };
}

function authorized(req, key) {
  const header = String(req.headers.authorization ?? '');
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m) return false;
  const got = Buffer.from(m[1].trim());
  const want = Buffer.from(key);
  // 定长比较，别用 === 泄漏长度前缀
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

/* ── 会话驱动器 ──────────────────────────────────────────────────────────── */

class MatrixRunner {
  constructor({ stateDir, workspaceRoot, agentPreset, timeoutMs, maxConcurrent, ensurePort, log }) {
    this.stateDir = stateDir;
    this.workspaceRoot = workspaceRoot;
    this.agentPreset = agentPreset;
    this.timeoutMs = timeoutMs;
    this.maxConcurrent = Math.max(1, maxConcurrent);
    this.ensurePort = Number(ensurePort) || 4599;
    this.log = log;
    this.api = null;
    this.workspaceId = null;
    this.waiters = new Map(); // sessionId -> waiter
    this.active = 0;
    this.queue = [];
    this.stopped = false;
    this.stats = { requests: 0, ok: 0, failed: 0, lastError: '', lastAt: 0 };
    this.startedAt = Date.now();
  }

  async start() {
    // 幂等：实例在跑就复用，没跑就拉起（桥接启动时已经调过一次，这里是兜底）
    try {
      await ensureServer({ log: this.log, port: this.ensurePort });
    } catch (error) {
      // 注册文件里的 pid 过期（实例被别人重启过 / 桌面端留了孤儿进程）时，
      // ensureServer 会尝试再拉一个、然后撞端口失败。只要端口上已经有人应答，
      // 就当作「实例在跑」，继续连 —— 这比直接把壳判死更有用。
      if (!(await portInUse(this.ensurePort))) throw error;
      this.log(`模型实例已在 ${this.ensurePort} 上应答（注册文件过期），复用现有实例`);
    }
    this.api = new NodeApiClient(undefined, undefined, {
      stateDir: this.stateDir,
      sessionDir: this.stateDir,
      log: this.log
    });
    // 会话目录必须是项目根：实例只从会话目录向上找 opencode.json，
    // 换目录就看不到 qq-chat 这些 agent，建会话会直接被拒（LLM-INTEGRATION §1.2 坑 1）。
    const ws = unwrap(await this.api.workspace.create({ path: this.workspaceRoot }), 'workspace.create');
    this.workspaceId = ws?.workspace?.workspaceId ?? ws?.workspaceId ?? ws?.id ?? null;
    if (!this.workspaceId) throw new Error('拿不到 workspaceId（workspace.create 返回形状变了？）');
    this._pump();
    return this;
  }

  /**
   * 常驻事件泵：一条 mux，按 sessionId 分发给各自的等待者。
   * 断线自动重连 —— 和桥接主循环同一套思路，别让一条流的抖动打死整个壳。
   */
  _pump() {
    const run = async () => {
      while (!this.stopped) {
        try {
          for await (const envelope of this.api.events.mux({})) {
            if (this.stopped) break;
            const frame = envelope?.payload;
            if (!frame) continue;
            if (frame.type !== 'session/event') continue;
            const waiter = this.waiters.get(frame.sessionId);
            if (!waiter) continue;
            const ended = waiter.collector.push(frame.event);
            if (ended) waiter.finish(ended);
          }
        } catch (error) {
          if (this.stopped) break;
          this.log(`事件流断开：${error?.message ?? error}；2 秒后重连`);
        }
        if (this.stopped) break;
        await sleep(2000);
      }
    };
    this.pump = run();
  }

  /** 并发闸门：模型实例扛不住几十个会话同时跑，超出的排队。 */
  async _acquire() {
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return;
    }
    await new Promise((resolve) => this.queue.push(resolve));
    // 释放方直接把名额转交过来（active 不变）
  }

  _release() {
    const next = this.queue.shift();
    if (next) next();
    else this.active = Math.max(0, this.active - 1);
  }

  /**
   * 跑一次完整回合。
   * @returns {Promise<{text:string, reason:string, sessionId:string}>}
   */
  async complete(promptText) {
    await this._acquire();
    this.stats.requests += 1;
    let sessionId = null;
    try {
      const created = unwrap(
        await this.api.sessions.create({
          workspaceId: this.workspaceId,
          agentPreset: this.agentPreset,
          title: 'OpenAI 壳'
        }),
        'sessions.create'
      );
      sessionId = created?.sessionId ?? created?.id;
      if (!sessionId) throw new Error('sessions.create 没返回 sessionId');

      const collector = createTurnCollector();
      const waiter = { collector, done: false, resolve: null, reject: null };
      const result = new Promise((resolve, reject) => {
        waiter.resolve = resolve;
        waiter.reject = reject;
      });
      waiter.finish = (ended) => {
        if (waiter.done) return;
        waiter.done = true;
        this.waiters.delete(sessionId);
        waiter.resolve(ended);
      };
      waiter.fail = (error) => {
        if (waiter.done) return;
        waiter.done = true;
        this.waiters.delete(sessionId);
        waiter.reject(error);
      };
      this.waiters.set(sessionId, waiter);

      // 先 follow 再 prompt —— 顺序反了会错过本轮事件（LLM-INTEGRATION §1.2 坑 2）
      this.api.events.follow(sessionId);

      const timer = setTimeout(
        () => waiter.fail(new Error(`等待模型回复超时（${Math.round(this.timeoutMs / 1000)} 秒）`)),
        this.timeoutMs
      );
      try {
        await this.api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: promptText }] });
        const ended = await result;
        this.stats.ok += 1;
        this.stats.lastAt = Date.now();
        return { text: String(ended?.text ?? ''), reason: String(ended?.reason ?? 'stop'), sessionId };
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      this.stats.failed += 1;
      this.stats.lastError = String(error?.message ?? error).slice(0, 300);
      this.stats.lastAt = Date.now();
      throw error;
    } finally {
      if (sessionId) {
        this.waiters.delete(sessionId);
        // 归档（默认只 interrupt，不真删）：一次性请求不该在实例里堆会话
        try { await this.api.workspace.archiveSession({ sessionId }); } catch { /* 归档失败不影响回复 */ }
      }
      this._release();
    }
  }

  /** 模型清单：拿实例的真实目录；拿不到就给一个占位 id（客户端只要求非空）。 */
  async listModels() {
    try {
      const env = await this.api.callUnary('session.modelCatalog', {});
      if (env?.result?.ok) {
        const out = [];
        for (const group of env.result.value?.groups ?? []) {
          for (const m of group.models ?? []) {
            if (m?.id) out.push({ id: String(m.id), owned_by: String(group.id ?? 'matrix') });
          }
        }
        if (out.length) return out;
      }
    } catch (error) {
      this.log(`模型清单读取失败：${error?.message ?? error}`);
    }
    return [{ id: 'dualhabitat-matrix', owned_by: 'matrix' }];
  }

  async close() {
    this.stopped = true;
    // 收掉进行中的等待者，免得调用方（测试 / 退出流程）一直挂着
    for (const waiter of this.waiters.values()) waiter.fail?.(new Error('壳已关闭'));
    this.waiters.clear();
    try { this.api?.invalidate?.(); } catch { /* 关不掉就交给进程退出 */ }
  }
}

/* ── HTTP 层 ─────────────────────────────────────────────────────────────── */

function chunkOf(id, created, model, delta, finishReason = null) {
  return {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }]
  };
}

/**
 * 起壳。返回 `{ok:true, port, url, key, runner, close}` 或 `{ok:false, error}`。
 * 端口占用绝不抛到调用方（桥接启动不能因为一个可选功能挂掉）。
 */
export async function startOpenAIShell({
  port = DEFAULT_PORT,
  keyFile,
  apiKey = '',
  stateDir,
  workspaceRoot,
  agentPreset = 'qq-chat',
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxConcurrent = 4,
  ensurePort = 4599,
  log = () => {}
} = {}) {
  const numPort = Number(port);
  if (!Number.isInteger(numPort) || numPort < 1024 || numPort > 65535) {
    return { ok: false, error: `端口不合法：${port}` };
  }
  if (!stateDir) return { ok: false, error: '缺少 stateDir（要指向模型实例的 state 目录）' };

  const { key, created, source } = loadOrCreateKey(keyFile, apiKey);
  const runner = new MatrixRunner({ stateDir, workspaceRoot, agentPreset, timeoutMs, maxConcurrent, ensurePort, log });

  try {
    await runner.start();
  } catch (error) {
    return { ok: false, error: `连不上模型实例：${error?.message ?? error}` };
  }

  const server = http.createServer(async (req, res) => {
    // 本机小工具经常在浏览器里跑（CORS 预检会先来一发 OPTIONS）
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'authorization, content-type');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');

    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const p = url.pathname.replace(/\/+$/, '') || '/';

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    // 只认回环：这个壳能花用户的钱，绝不能给局域网裸开
    const host = String(req.headers.host ?? '');
    if (!/^(127\.0\.0\.1|localhost|\[::1\]|::1)(:\d+)?$/i.test(host)) {
      return sendError(res, 403, '只接受本机回环地址的请求');
    }

    if (req.method === 'GET' && (p === '/health' || p === '/')) {
      return sendJson(res, 200, {
        ok: true,
        service: 'dualhabitat-matrix-openai-shell',
        startedAt: runner.startedAt,
        agentPreset,
        stats: runner.stats
      });
    }

    if (!authorized(req, key)) {
      return sendError(res, 401, '缺少或错误的 API key（Authorization: Bearer <key>）', 'authentication_error', 'invalid_api_key');
    }

    if (req.method === 'GET' && p === '/v1/models') {
      const models = await runner.listModels();
      return sendJson(res, 200, {
        object: 'list',
        data: models.map((m) => ({ id: m.id, object: 'model', created: 0, owned_by: m.owned_by }))
      });
    }

    if (req.method === 'POST' && p === '/v1/chat/completions') {
      let body;
      try {
        body = await readBody(req);
      } catch (error) {
        return sendError(res, 400, error?.message ?? error);
      }
      const messages = body?.messages;
      if (!Array.isArray(messages) || !messages.length) {
        return sendError(res, 400, 'messages 必须是非空数组');
      }
      const promptText = messagesToPrompt(messages);
      if (!promptText.trim()) {
        return sendError(res, 400, 'messages 里没有可用的文本内容（图片/工具结果暂不支持）');
      }

      const model = String(body?.model ?? 'dualhabitat-matrix');
      const id = `chatcmpl-${crypto.randomUUID().replace(/-/g, '')}`;
      const created = Math.floor(Date.now() / 1000);

      let result;
      try {
        result = await runner.complete(promptText);
      } catch (error) {
        const message = String(error?.message ?? error);
        const timeout = /超时/.test(message);
        return sendError(res, timeout ? 504 : 502, message, timeout ? 'timeout_error' : 'upstream_error');
      }

      const text = result.text;
      const promptTokens = estimateTokens(promptText);
      const completionTokens = estimateTokens(text);
      const usage = {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens
      };
      const finishReason = /length|max.?token/i.test(result.reason) ? 'length' : 'stop';

      if (body?.stream === true) {
        /* 假流式：协议完全合规（role → content → finish → [DONE]），只是内容一次性到。
         * 真增量要接 assistant/chunk + 逐块 flush，二期再做 —— 先让客户端能用。 */
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          'access-control-allow-origin': '*'
        });
        const write = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
        write(chunkOf(id, created, model, { role: 'assistant' }));
        write(chunkOf(id, created, model, { content: text }));
        write({ ...chunkOf(id, created, model, {}, finishReason), usage });
        res.write('data: [DONE]\n\n');
        return res.end();
      }

      return sendJson(res, 200, {
        id,
        object: 'chat.completion',
        created,
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: finishReason }],
        usage
      });
    }

    if (p === '/v1/chat/completions' && req.method !== 'POST') {
      return sendError(res, 405, '只支持 POST');
    }
    return sendError(res, 404, `没有这个端点：${p}`);
  });

  return await new Promise((resolve) => {
    server.once('error', (error) => {
      const hint = error?.code === 'EADDRINUSE' ? `端口 ${numPort} 已被占用` : String(error?.message ?? error);
      resolve({ ok: false, error: `OpenAI 壳启动失败：${hint}` });
    });
    server.listen(numPort, '127.0.0.1', () => {
      const actual = server.address()?.port ?? numPort;
      log(
        `OpenAI 兼容壳已就绪：http://127.0.0.1:${actual}/v1（Bearer key ${created ? '已生成' : source === 'config' ? '来自 config' : '读自 state'}；agent=${agentPreset}）`
      );
      resolve({
        ok: true,
        port: actual,
        url: `http://127.0.0.1:${actual}/v1`,
        key,
        keyCreated: created,
        runner,
        close: () => new Promise((r) => {
          try { runner.close(); } catch { /* ignore */ }
          server.close(() => r());
        })
      });
    });
  });
}

/** 命令行单独跑：`node src/openai-shell.js`（调试用，正常由桥接拉起）。 */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(here, '..');
  const started = await startOpenAIShell({
    stateDir: PATHS.state,
    workspaceRoot: root,
    keyFile: path.join(root, 'state', 'openai-shell.key'),
    log: (m) => console.log(`[openai-shell] ${m}`)
  });
  if (!started.ok) {
    console.error(started.error);
    process.exit(1);
  }
  console.log(`key: ${started.key}`);
}
