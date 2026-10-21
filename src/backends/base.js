/**
 * backends/base.js —— 所有后端适配器共用的底座。
 *
 * 这里只放"和具体后端无关"的东西：信封、事件总线、帧构造、回合管理、会话存储。
 * 具体协议（HTTP / CLI 子进程）留在各自的适配器里。
 *
 * 契约见同目录 CONTRACT.md。**改这里等于改所有后端的行为**，谨慎。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/* ══════════════════════════════════════════════════════════════════════════
 * 一、信封（与 oc-client.js 逐字一致，方便两个实现互换）
 * ══════════════════════════════════════════════════════════════════════════ */

/** 成功信封。 */
export function ok(value) {
  return { result: { ok: true, value } };
}

/** 失败信封（`unwrap` 会把它翻成 throw）。 */
export function fail(code, message) {
  return { result: { ok: false, error: { code, message } } };
}

/**
 * 把 Promise 的 reject 也收进信封。
 *
 * 和 oc-client 的 envelope 有一个区别：这里的 label 只用于错误文案，
 * code 判定额外识别限流/额度，好让模型链的熔断能正确分类。
 */
export async function envelope(label, run) {
  try {
    return ok(await run());
  } catch (error) {
    const message = String(error?.message ?? error ?? '未知错误');
    let code = 'internal';
    if (/not[-_ ]?found/i.test(message)) code = 'not-found';
    else if (/429|rate.?limit|too many requests/i.test(message)) code = 'rate-limited';
    else if (/quota|insufficient|balance|额度|余额/i.test(message)) code = 'quota-exhausted';
    else if (/abort|interrupt/i.test(message)) code = 'interrupted';
    return fail(code, `${label}: ${message}`);
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * 二、事件总线
 *
 * bridge.js 的 pumpMux 用 `for await` 消费 `events.mux({})`。
 * 断线重连时它会重新调一次 mux()，所以**多个迭代器要共享同一条队列**，
 * 不能做成一次性 generator —— 那样重连后事件就断了。
 * ══════════════════════════════════════════════════════════════════════════ */

export class EventBus {
  constructor({ maxBacklog = 1000 } = {}) {
    this._queue = [];
    this._waiters = [];
    this._maxBacklog = maxBacklog;
    this._closed = false;
  }

  /** 推一条帧。没有消费者时先堆着（有上限，防内存爆）。 */
  push(frame) {
    if (this._closed) return;
    if (this._waiters.length) {
      this._waiters.shift()(frame);
      return;
    }
    this._queue.push(frame);
    if (this._queue.length > this._maxBacklog) this._queue.shift();
  }

  /** 每个消费者拿到的是独立游标，都从"现在"开始读。 */
  async *iterate() {
    while (!this._closed) {
      if (this._queue.length) {
        yield this._queue.shift();
        continue;
      }
      const next = await new Promise((resolve) => this._waiters.push(resolve));
      if (next === null) return;
      yield next;
    }
  }

  /** 关闭所有迭代器（进程退出时用）。 */
  close() {
    this._closed = true;
    for (const wake of this._waiters.splice(0)) wake(null);
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * 三、帧构造
 * ══════════════════════════════════════════════════════════════════════════ */

let rpcSeq = 0;

/**
 * 造一帧 `{ rpcId, payload: { type:'session/event', sessionId, event } }`。
 * 形状必须与 oc-client 的 mux 输出一致，否则 bridge 的 collector 认不出。
 */
export function frame(sessionId, event) {
  return {
    rpcId: `frame-${++rpcSeq}`,
    payload: {
      type: 'session/event',
      sessionId,
      event: { time: Date.now(), ...event }
    }
  };
}

/** 回合开始。 */
export function turnStart(sessionId, turn) {
  return frame(sessionId, { type: 'turn/start', data: { turn } });
}

/** 流式增量。 */
export function assistantChunk(sessionId, turn, delta) {
  return frame(sessionId, { type: 'assistant/chunk', data: { turn, delta } });
}

/** 一条完整消息。 */
export function assistantMessage(sessionId, turn, text, step = 1) {
  return frame(sessionId, {
    type: 'assistant/message',
    data: {
      turn,
      step,
      message: { role: 'assistant', content: [{ type: 'text', text }] }
    }
  });
}

/** 回合结束。**必须有**，否则该会话在桥接侧永久 busy。 */
export function turnEnd(sessionId, turn, kind = 'completed') {
  return frame(sessionId, { type: 'turn/end', data: { turn, reason: { kind } } });
}

/** token 用量（账本靠它算钱）。 */
export function usageFrame(sessionId, turn, usage) {
  return frame(sessionId, { type: 'session/usage', data: { turn, usage } });
}

/* ══════════════════════════════════════════════════════════════════════════
 * 四、内容块工具
 * ══════════════════════════════════════════════════════════════════════════ */

/** ContentBlock[] → 纯文本（非文本块丢弃）。 */
export function blocksToText(blocks) {
  return (blocks ?? [])
    .filter((b) => b?.type === 'text')
    .map((b) => String(b.text ?? ''))
    .join('\n');
}

/**
 * ContentBlock[] → 图片数组 `{ mediaType, data(base64) }`。
 * 支持 data（base64）、path、uri 三种来源；读不到的直接跳过并记日志。
 */
export function blocksToImages(blocks, log = () => {}) {
  const out = [];
  for (const b of blocks ?? []) {
    if (b?.type !== 'image') continue;
    if (typeof b.data === 'string' && b.data) {
      out.push({ mediaType: b.mediaType ?? b.mime ?? 'image/jpeg', data: b.data });
      continue;
    }
    const file = typeof b.path === 'string' ? b.path : null;
    if (file && fs.existsSync(file)) {
      try {
        out.push({ mediaType: b.mediaType ?? guessMime(file), data: fs.readFileSync(file).toString('base64') });
      } catch (error) {
        log(`图片读不动，跳过：${file}（${error?.message ?? error}）`);
      }
      continue;
    }
    log(`图片块没有可用来源（缺 data/path），跳过`);
  }
  return out;
}

function guessMime(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  return 'image/jpeg';
}

/* ══════════════════════════════════════════════════════════════════════════
 * 五、会话存储
 *
 * 直连模型没有原生会话，上下文得自己存；CLI 后端也要记 sessionId → 原生 id 的映射。
 * 统一落在 `state/backends/<type>/sessions/<id>.json`，重启不丢。
 * ══════════════════════════════════════════════════════════════════════════ */

export class SessionStore {
  constructor(rootDir, log = () => {}) {
    this.dir = rootDir;
    this.log = log;
    this._cache = new Map();
    try {
      fs.mkdirSync(this.dir, { recursive: true });
    } catch (error) {
      this.log(`会话目录建不出来：${error?.message ?? error}`);
    }
  }

  _file(sessionId) {
    const safe = String(sessionId).replace(/[^A-Za-z0-9_.-]/g, '_');
    return path.join(this.dir, `${safe}.json`);
  }

  get(sessionId) {
    if (this._cache.has(sessionId)) return this._cache.get(sessionId);
    const file = this._file(sessionId);
    let record = null;
    try {
      if (fs.existsSync(file)) record = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      this.log(`会话文件损坏，按新会话处理：${file}（${error?.message ?? error}）`);
    }
    this._cache.set(sessionId, record);
    return record;
  }

  set(sessionId, record) {
    this._cache.set(sessionId, record);
    try {
      fs.writeFileSync(this._file(sessionId), JSON.stringify(record, null, 2), 'utf8');
    } catch (error) {
      this.log(`会话写盘失败：${error?.message ?? error}`);
    }
  }

  delete(sessionId) {
    this._cache.delete(sessionId);
    try {
      fs.rmSync(this._file(sessionId), { force: true });
    } catch {
      /* 删不掉就算了，下次按新会话处理 */
    }
  }

  list() {
    try {
      return fs
        .readdirSync(this.dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => {
          try {
            return JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8'));
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    } catch {
      return [];
    }
  }
}

/** 生成一个 sessionId（桥接只要求唯一，不解析内容）。 */
export function newSessionId(prefix = 'sess') {
  return `${prefix}-${crypto.randomBytes(6).toString('hex')}`;
}

/* ══════════════════════════════════════════════════════════════════════════
 * 六、回合号
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * 每个会话一个自增回合号。
 * 桥接的 collector 按 turn 分组，**同一轮的重试必须沿用原回合号**，
 * 否则文本会被整段丢掉（oc-client 里踩过这个坑，注释在 334 行）。
 */
export class TurnCounter {
  constructor() {
    this._seq = new Map();
  }

  next(sessionId, reuse) {
    if (reuse != null) return reuse;
    const n = (this._seq.get(sessionId) ?? 0) + 1;
    this._seq.set(sessionId, n);
    return `turn-${n}`;
  }

  forget(sessionId) {
    this._seq.delete(sessionId);
  }
}
