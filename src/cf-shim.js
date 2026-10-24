// CF 兼容代理（cf-shim）：夹在 模型 API 和 Cloudflare Workers AI 之间的小代理。
//
// ## 为什么需要它
//
// CF 的 `/ai/v1/chat/completions` **只收 `content` 字符串**，而 模型 API 在
// 带工具结果的消息上发的是"段落数组"，于是：
//
//   400 AiError: Bad input: oneOf ... Type mismatch of '/messages/N/content',
//       'array' not in 'string'
//
// 还有一个更隐蔽的：工具调用之后 模型 API 会发一条 `content: null` 的 assistant
// 消息，CF 连 `null` 都不收。
//
// ## 为什么不是"改 模型 API"而是加一层代理
//
// 这是**一个字段的兼容断层**，不是架构问题。在代理层把数组拍平、`null` 补成 `""`，
// 就全通了（本机实测：带 shim 时完整的门面 + 工具调用 + 审批往返全过）。
//
// ## 为什么默认只在"池子里真有 CF 模型"时才起
//
// 少一个进程就少一个故障点。这个判断由 `src/oc-server.js` 用模型池做，
// 和"要不要把 CF 写进链里"是同一个判断，不会出现"起了没用"或"用了没起"。
//
// 用法：`node src/cf-shim-main.js`，或由 oc-server 自己拉起（推荐）。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { PATHS, SHIM_PORT } from './oc-env.js';
import { rotateLogFile } from './log-rotate.js';

/** CF 的 OpenAI 兼容端点。 */
export function cloudflareUpstream(accountId) {
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`;
}

/**
 * 把 OpenAI 的"段落数组"content 拍平成字符串；`null`/缺失 也补成空串。
 * CF 的 schema 明确要求 role + content 都在，且 content 是 string。
 *
 * @returns {Array<string>} 改动说明（用于日志和 jsonl 取证）
 */
export function normalizeMessages(body) {
  const notes = [];
  if (!Array.isArray(body?.messages)) return notes;
  body.messages.forEach((msg, i) => {
    if (Array.isArray(msg.content)) {
      const parts = msg.content.length;
      msg.content = msg.content
        .map((p) => (p && typeof p === 'object' && typeof p.text === 'string' ? p.text : ''))
        .join('');
      notes.push(`messages[${i}].content: 数组(${parts}段) → 字符串(${msg.content.length}字)`);
    } else if (msg.content === null || msg.content === undefined) {
      msg.content = '';
      notes.push(`messages[${i}].content: ${msg.content === '' ? 'null → ""' : '缺失 → ""'}`);
    }
  });
  return notes;
}

/**
 * 起一个 shim 实例。
 *
 * @param {object} [options]
 * @param {number} [options.port]      监听端口
 * @param {string} [options.logFile]   请求取证的 jsonl 路径
 * @param {object} [options.secrets]   `{ CLOUDFLARE_API_KEY, CLOUDFLARE_ACCOUNT_ID, ... }`
 * @param {boolean} [options.fix]     是否真的动手修（关掉只观测）
 * @param {Function} [options.log]
 * @returns {Promise<{ server: import('node:http').Server, port: number, url: string, upstream: string, close: () => Promise<void> }>}
 */
export function startShim(options = {}) {
  const port = Number(options.port ?? SHIM_PORT);
  const logFile = options.logFile ?? PATHS.shimLog;
  const fix = options.fix !== false;
  const log = options.log ?? ((m) => console.log(m));

  const secrets = options.secrets ?? {};
  const token = secrets.CLOUDFLARE_API_KEY ?? secrets.CLOUDFLARE_API_TOKEN;
  const account = secrets.CLOUDFLARE_ACCOUNT_ID;
  if (!token) throw new Error('cf-shim 需要 CLOUDFLARE_API_KEY（或 CLOUDFLARE_API_TOKEN）');
  if (!account) throw new Error('cf-shim 需要 CLOUDFLARE_ACCOUNT_ID');
  const upstream = cloudflareUpstream(account);

  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const record = (entry) => {
    try {
      rotateLogFile(logFile);
      fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
    } catch {
      /* 取证日志写不进去不该影响转发 */
    }
  };

  const server = http.createServer((req, res) => {
    // 健康检查：oc-server 靠它判断"要不要重新拉起"。
    // 必须显式路由，否则 GET 会被当成对话请求转发上去、报一个看不懂的 502。
    if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, upstream }));
      return;
    }

    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const entry = { at: new Date().toISOString(), url: req.url, method: req.method, rawLen: raw.length };
      try {
        const body = JSON.parse(raw);
        entry.model = body.model;
        entry.stream = body.stream;
        entry.messageRoles = (body.messages ?? []).map(
          (m) =>
            `${m.role}:${Array.isArray(m.content) ? 'array' : m.content === null ? 'null' : typeof m.content}`
        );
        const notes = fix ? normalizeMessages(body) : [];
        entry.notes = notes;
        entry.toolCount = (body.tools ?? []).length;
        entry.fixed = fix && notes.length > 0;

        const upstreamRes = await fetch(`${upstream}/chat/completions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: fix ? JSON.stringify(body) : raw
        });
        entry.status = upstreamRes.status;
        record(entry);
        log(
          `[shim] ${entry.model} → ${upstreamRes.status}` +
            (notes.length ? `  已修 ${notes.length} 处` : '')
        );

        res.writeHead(upstreamRes.status, {
          'Content-Type': upstreamRes.headers.get('content-type') ?? 'text/event-stream',
          'Cache-Control': 'no-cache'
        });
        if (!upstreamRes.body) {
          res.end();
          return;
        }
        const reader = upstreamRes.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
        }
        res.end();
      } catch (error) {
        entry.error = String(error?.message ?? error);
        record(entry);
        log(`[shim] 转发失败: ${entry.error}`);
        if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: entry.error }));
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      log(`[shim] 监听 http://127.0.0.1:${port}/v1  →  ${upstream}`);
      resolve({
        server,
        port,
        url: `http://127.0.0.1:${port}/v1`,
        upstream,
        close: () => new Promise((done) => server.close(() => done()))
      });
    });
  });
}

/** shim 是否已经在跑（健康检查）。 */
export async function shimAlive(port = SHIM_PORT, timeoutMs = 1200) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) return false;
    const body = await res.json();
    return body?.ok === true;
  } catch {
    return false;
  }
}
