/**
 * qq-official-bot.js —— QQ 官方机器人（开放平台，不封号的那种）
 *
 * 和另外两条 QQ/微信链路的关系：
 *   · NapCat 那条是「个人号协议」，功能全但有风控风险（bridge.js）；
 *   · 这条走 QQ 开放平台官方接口（q.qq.com 注册的机器人，带官方标识），
 *     群聊 + 单聊（C2C）都支持，但受官方频控（被动回复 5 分钟窗口）。
 *   · 故意不复用 bridge.js（12267 行，OneBot 深度耦合），独立进程独立状态，
 *     坏了不影响 NapCat 那条线 —— 和 wechat-bot.js 同一个立场。
 *
 * 协议（全部官方公开文档，2026-10 核对）：
 *   1. POST https://api.bot.qq.com/app/getAppAccessToken {appId, clientSecret}
 *      → access_token（约 2 小时，过期前 60 秒内可换新）
 *   2. HTTP 一律 Authorization: `QQBot <access_token>`，base https://api.sgroup.qq.com
 *   3. WebSocket 网关：GET /gateway 拿 wss 地址（默认 wss://api.sgroup.qq.com/websocket）
 *      op: 0 DISPATCH / 1 心跳 / 2 IDENTIFY / 6 RESUME / 7 服务端要求重连
 *          9 INVALID_SESSION / 10 HELLO / 11 心跳 ACK
 *      intents 只订阅群聊+单聊：GROUP_AND_C2C_EVENT = 1 << 25（多订阅没权限的位会被断开）
 *   4. 事件：C2C_MESSAGE_CREATE（单聊）、GROUP_AT_MESSAGE_CREATE（群里 @机器人）
 *   5. 回复：POST /v2/users/{openid}/messages、/v2/groups/{group_openid}/messages
 *      被动回复带收到消息的 msg_id（5 分钟内有效，同一条最多回 4~5 次，
 *      每次递增 msg_seq），过期/超次后只能主动发（有频控，发不出去就放弃）
 *
 * 模型侧：QQ 实例（4599）和 NapCat 那条共用 —— 同一份人设/模型池/记忆，
 * 会话分开（key 是 official:c2c:<openid> / official:group:<gopenid>），互不串门。
 *
 * 状态都在 state/ 下：
 *   qq-official-token.json     access_token 缓存（重启少打一次 token 接口）
 *   qq-official-sessions.json  聊天 key → 模型会话 id
 *   qq-official-status.json    桌面端读它画状态（连接、机器人名、计数）
 *   qq-official.lock           单实例锁（桌面端也读它判断在不在跑）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  discoverMatrixEndpoint,
  NodeApiClient,
  unwrap,
  createTurnCollector
} from './oc-client.js';
import { ensureServer } from './oc-server.js';
import { effectiveModelPool, readSlotProfiles, sessionWorkdir } from './oc-config.js';
import { loadModelPool } from './model-pool.js';
import { resolveModelInstance } from './oc-env.js';
import { appendMemory } from './memory-daily.js';
import { resolveDataRoot } from './data-root.js';
import { emitEvent } from './events-out.js';
import { createInboundDeduper } from './inbound-dedupe.js';

const CODE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = resolveDataRoot(CODE_ROOT);
const MODEL_INSTANCE = resolveModelInstance('qq');
const STATE_DIR = path.join(ROOT, 'state');

/* 多号：每个官方机器人（一个 AppID = 一份凭证 = 一个独立进程）各带一套状态文件，
   文件名带 AppID 后缀，桌面端 externalQqOfficialPid(appId) 读的锁也是这套名字。
   单号时代（0.6.0 之前只有一个）没有这些后缀文件 —— 老状态不迁移，重登一次就都有了。 */
const APP_ID = (() => {
  const at = process.argv.indexOf('--app');
  const v = at > 0 ? String(process.argv[at + 1] ?? '').trim() : '';
  return /^\d{6,15}$/.test(v) ? v : '';
})();
const stateFile = (kind) => path.join(STATE_DIR, `qq-official-${APP_ID}-${kind}.json`);
const LOCK_FILE = path.join(STATE_DIR, `qq-official-${APP_ID}.lock`);

const TOKEN_API = 'https://api.bot.qq.com/app/getAppAccessToken';
const API_BASE = 'https://api.sgroup.qq.com';
const DEFAULT_GATEWAY = 'wss://api.sgroup.qq.com/websocket';
// 群聊+单聊事件位。别贪心多订阅（频道等）——没权限的 intent 会被网关直接断开。
const INTENTS_GROUP_C2C = 1 << 25;
const TURN_TIMEOUT_MS = 180_000;
const PASSIVE_WINDOW_MS = 4.5 * 60_000; // 官方 5 分钟，留 30 秒余量给模型跑
const REPLY_CHUNK = 900; // 拆段上限，官方对 content 长度有限制（超限报 40054007）

/* ── 小工具 ─────────────────────────────────────────── */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function log(...args) {
  const tag = APP_ID ? `官方QQ:${APP_ID.slice(0, 4)}…` : '官方QQ';
  console.log(`[${tag}] ${new Date().toLocaleTimeString('zh-CN')} ${args.map((x) => (typeof x === 'string' ? x : String(x?.message ?? x))).join(' ')}`);
}

/** 把长回复拆成官方接口吃得下的段：先按段落，段落本身太长再硬切。导出给测试用。 */
export function splitReply(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return [];
  const out = [];
  let buf = '';
  for (const para of raw.split(/\n{2,}/)) {
    const piece = para.trim();
    if (!piece) continue;
    if (piece.length > REPLY_CHUNK) {
      if (buf) { out.push(buf); buf = ''; }
      for (let i = 0; i < piece.length; i += REPLY_CHUNK) out.push(piece.slice(i, i + REPLY_CHUNK));
      continue;
    }
    if ((buf + '\n\n' + piece).trim().length > REPLY_CHUNK) { out.push(buf); buf = piece; }
    else buf = buf ? `${buf}\n\n${piece}` : piece;
  }
  if (buf) out.push(buf);
  return out.map((s) => s.trim()).filter(Boolean);
}

/**
 * 被动回复的序号管理：同一条来消息（msg_id）最多回 N 次，每次 msg_seq 递增；
 * 拿不到序号（超次/过期）就返回 null —— 调用方降级成主动发送。导出给测试用。
 */
export function createSeqCounter({ maxPerMsg = 4, now = Date.now } = {}) {
  const map = new Map(); // msgId -> { next, at }
  return {
    next(msgId) {
      const rec = map.get(msgId);
      const at = now();
      if (!rec) {
        map.set(msgId, { next: 2, at });
        if (map.size > 200) {
          // 顺手清掉最老的四分之一，别无限涨
          const keys = [...map.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 50).map(([k]) => k);
          for (const k of keys) map.delete(k);
        }
        return { seq: 1, passive: true };
      }
      rec.at = at;
      if (rec.next > maxPerMsg) return { seq: null, passive: false };
      return { seq: rec.next++, passive: true };
    },
    /** 来消息太老的（超被动窗口），别再挂着 msg_id 发 —— 会被官方拒。 */
    drop() {
      const at = now();
      for (const [k, v] of map) if (at - v.at > PASSIVE_WINDOW_MS) map.delete(k);
    }
  };
}

/* ── 配置 ───────────────────────────────────────────── */

function readConfig() {
  return readJson(path.join(ROOT, 'config.json'), {});
}

/** 全量账号清单（配置迁移/桌面端展示用）：bots 数组 + 旧单号字段兜底。 */
export function officialBotList(cfgJson) {
  const cfg = cfgJson ?? readConfig();
  const o = cfg.qqOfficial ?? {};
  const bots = Array.isArray(o.bots)
    ? o.bots.map((b, i) => ({
        appId: String(b?.appId ?? '').trim(),
        appSecret: String(b?.appSecret ?? '').trim(),
        enabled: b?.enabled !== false,
        name: String(b?.name ?? '').trim() || `机器人 ${i + 1}`
      })).filter((b) => b.appId)
    : [];
  // 旧单号（0.6.0 前）：顶层 appId/appSecret，没进过 bots 数组就临时当第 1 号
  if (!bots.length && String(o.appId ?? '').trim()) {
    bots.push({ appId: String(o.appId).trim(), appSecret: String(o.appSecret ?? '').trim(), enabled: o.enabled === true, name: '机器人 1' });
  }
  return bots;
}

function officialConfig() {
  const cfg = readConfig();
  const o = cfg.qqOfficial ?? {};
  // 多号：按 --app 传进来的 AppID 从 bots 里挑自己这份
  const mine = APP_ID ? officialBotList(cfg).find((b) => b.appId === APP_ID) : officialBotList(cfg)[0];
  const list = (v) => (Array.isArray(v) ? v.map(String).map((x) => x.trim()).filter(Boolean) : []);
  const allow = (mine ? (o.bots?.find((b) => String(b?.appId ?? '').trim() === mine.appId)?.allow ?? o.allow) : o.allow) ?? {};
  const allowPrivate = list(allow.private);
  const allowGroups = list(allow.groups);
  const configured = Boolean(cfg.qqOfficial) && (allowPrivate.length > 0 || allowGroups.length > 0 || o.allowAllWhenEmpty === false);
  return {
    enabled: mine ? mine.enabled === true : false,
    appId: mine?.appId ?? '',
    appSecret: mine?.appSecret ?? '',
    name: mine?.name ?? '',
    allowPrivate,
    allowGroups,
    allowAllWhenEmpty: configured ? o.allowAllWhenEmpty === true : true,
    // 人设/方案沿用 QQ 那条的（roles/ 目录、后端页的默认方案），改一处两边一起变
    role: String(cfg.role ?? '').trim(),
    agentPreset: String(cfg.agentPreset ?? '').trim(),
    workspaceTitle: String(o.workspaceTitle ?? cfg.workspaceTitle ?? `QQ 官方机器人${mine?.name ? ` · ${mine.name}` : ''}`).trim()
  };
}

/** 白名单：黑名单语义先不做（官方平台本身有拉黑），名单为空默认全放。 */
function allowed(kind, id, conf) {
  if (kind === 'group') {
    if (conf.allowGroups.includes('*')) return true;
    if (conf.allowGroups.length > 0) return conf.allowGroups.includes(id);
    return conf.allowAllWhenEmpty;
  }
  if (conf.allowPrivate.includes('*')) return true;
  if (conf.allowPrivate.length > 0) return conf.allowPrivate.includes(id);
  return conf.allowAllWhenEmpty;
}

/* ── 官方 API：token 与 HTTP ────────────────────────── */

let tokenCache = { token: '', expiresAt: 0 };

async function fetchAccessToken(appId, appSecret) {
  const res = await fetch(TOKEN_API, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ appId, clientSecret: appSecret }),
    signal: AbortSignal.timeout(15_000)
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) throw new Error(`换 access_token 失败：HTTP ${res.status} ${JSON.stringify(body).slice(0, 120)}`);
  return { token: String(body.access_token), expiresIn: Number(body.expires_in) || 7200 };
}

async function accessToken(force = false) {
  const conf = officialConfig();
  if (!conf.appId || !conf.appSecret) throw new Error('没配 AppID/AppSecret（桌面端「QQ 官方机器人」面板里填）');
  const margin = 120_000;
  if (!force && tokenCache.token && Date.now() < tokenCache.expiresAt - margin) return tokenCache.token;
  // 三个进程内并发要 token 只打一次接口：简单的在途共享
  if (!accessToken._inflight) {
    accessToken._inflight = (async () => {
      // 重启后先吃落盘缓存（还新鲜就不用打接口），过期才真换
      if (!force && (!tokenCache.token || Date.now() >= tokenCache.expiresAt)) {
        const saved = readJson(stateFile('token'), null);
        if (saved?.token && Date.now() < Number(saved.expiresAt ?? 0) - margin) tokenCache = saved;
      }
      if (!force && tokenCache.token && Date.now() < tokenCache.expiresAt - margin) return tokenCache.token;
      const got = await fetchAccessToken(conf.appId, conf.appSecret);
      tokenCache = { token: got.token, expiresAt: Date.now() + got.expiresIn * 1000 };
      writeJson(stateFile('token'), tokenCache);
      return tokenCache.token;
    })().finally(() => { accessToken._inflight = null; });
  }
  return accessToken._inflight;
}

async function qqApi(method, urlPath, body) {
  const token = await accessToken();
  const res = await fetch(`${API_BASE}${urlPath}`, {
    method,
    headers: { authorization: `QQBot ${token}`, 'content-type': 'application/json', 'x-user-agent': 'DualHabitat-Matrix' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000)
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 错误体不是 JSON 就原样带出去 */ }
  if (!res.ok) {
    const err = new Error(`官方接口 HTTP ${res.status}：${(json?.message ?? text ?? '').slice(0, 160)}（code ${json?.code ?? '?'}）`);
    err.status = res.status;
    err.code = json?.code;
    throw err;
  }
  return json ?? {};
}

/* ── 发送（带被动窗口与分段） ───────────────────────── */

const seqCounter = createSeqCounter();
setInterval(() => seqCounter.drop(), 60_000).unref?.();

/**
 * 回复一条官方消息。kind: 'c2c' | 'group'；target 是 openid / group_openid；
 * replyTo 是来消息的 id（msg_id），5 分钟内算被动回复，过期/超次转主动发。
 */
async function sendReply(kind, target, text, replyTo) {
  const endpoint = kind === 'group'
    ? `/v2/groups/${encodeURIComponent(target)}/messages`
    : `/v2/users/${encodeURIComponent(target)}/messages`;
  const chunks = splitReply(text);
  if (!chunks.length) return;
  for (let i = 0; i < chunks.length; i++) {
    const payload = { msg_type: 0, content: chunks[i] };
    if (replyTo && i === 0) {
      const { seq, passive } = seqCounter.next(replyTo);
      if (passive) {
        payload.msg_id = replyTo;
        payload.msg_seq = seq;
      }
      // 过期/超次：不带 msg_id 主动发。频控发不出去会抛 40034100，调用方记日志。
    }
    try {
      await qqApi('POST', endpoint, payload);
    } catch (error) {
      // 被动回复被拒（过期/超次/去重）时，降级成主动发送再试这一段
      if (payload.msg_id && [40034128, 304103, 40034005, 40034026].includes(Number(error.code))) {
        log(`被动回复被拒（${error.code}），这段改主动发`);
        delete payload.msg_id;
        delete payload.msg_seq;
        await qqApi('POST', endpoint, payload);
      } else {
        throw error;
      }
    }
    if (chunks.length > 1) await sleep(400); // 分段之间歇口气，别顶到频控
  }
}

/* ── 模型侧（和 wechat-bot 同一套管线，QQ 实例） ────── */

let api = null;
let apiUrl = '';
let workspaceId = null;
let pumpStarted = false;
const collectors = new Map();
const sessions = new Map(); // 聊天 key → { sessionId, primed, roleName }

async function initAi() {
  const cfg = readConfig();
  const stateDir = MODEL_INSTANCE.stateDir;
  let endpoint = await discoverMatrixEndpoint({ stateDir });
  if (!endpoint) {
    log('QQ 模型 API 不在（NapCat 那条没跑时正常），官方 Bot 自己拉 4599 实例…');
    try {
      await ensureServer({ log, instance: MODEL_INSTANCE });
      endpoint = await discoverMatrixEndpoint({ stateDir });
    } catch (error) {
      log(`模型 API 自启失败：${error?.message ?? error}`);
    }
  }
  if (!endpoint) throw new Error('模型服务没起来。开一次 QQ 机器人（或重启软件）再试。');
  const models = effectiveModelPool(loadModelPool().pool, readSlotProfiles('qq'), 'qq');
  api = new NodeApiClient(cfg.matrix?.baseUrl || undefined, undefined, {
    stateDir,
    sessionDir: stateDir,
    deleteArchived: cfg.matrix?.deleteArchived === true,
    models,
    log
  });
  apiUrl = endpoint.url;
  log(`模型 API：${endpoint.url}`);

  // 会话目录用 QQ 实例里独立的子目录：和 NapCat 那条共实例但各用各的 workspace，
  // 人设/模型池共享（这就是「同一个机器人换个官方入口」），会话不互相污染。
  const dir = path.join(sessionWorkdir('qq', MODEL_INSTANCE), 'official-bot');
  fs.mkdirSync(dir, { recursive: true });
  const ws = unwrap(await api.workspace.create({ path: dir }), 'workspace.create');
  workspaceId = ws.workspace.workspaceId;
  try {
    const conf = officialConfig();
    await api.workspace.rename({ workspaceId, title: conf.workspaceTitle });
  } catch { /* 改标题失败不影响干活 */ }

  for (const [k, v] of Object.entries(readJson(stateFile('sessions'), {}) ?? {})) sessions.set(k, v);

  if (!pumpStarted) {
    pumpStarted = true;
    pumpEvents().catch((error) => log('事件泵挂了：', error));
  }
  return true;
}

async function pumpEvents() {
  for (;;) {
    if (!api) { await sleep(3000); continue; }
    try {
      for await (const envelope of api.events.mux({})) {
        const frame = envelope.payload;
        if (frame?.type !== 'session/event') continue;
        const waiter = collectors.get(frame.sessionId);
        if (!waiter) continue;
        const ended = waiter.collector.push(frame.event);
        if (!ended) continue;
        collectors.delete(frame.sessionId);
        clearTimeout(waiter.timer);
        if (ended.reason?.kind === 'completed') waiter.resolve(ended.text);
        else waiter.reject(new Error(`回合没正常结束：${ended.reason?.kind ?? '未知'}`));
      }
    } catch (error) {
      await sleep(3000);
    }
  }
}

function runTurn(sessionId, text) {
  return new Promise((resolve, reject) => {
    const collector = createTurnCollector();
    const timer = setTimeout(() => {
      collectors.delete(sessionId);
      reject(new Error('模型超时没回完'));
    }, TURN_TIMEOUT_MS);
    collectors.set(sessionId, { collector, resolve, reject, timer });
    (async () => {
      try {
        api.events.follow?.(sessionId);
        const accepted = await api.sessions.prompt({
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text }]
        });
        if (!accepted?.result?.ok) {
          const err = accepted?.result?.error;
          throw new Error(`${err?.code ?? 'prompt'}：${err?.message ?? '投递失败'}`);
        }
        const cmd = accepted.result.value?.command?.text;
        if (cmd) {
          clearTimeout(timer);
          collectors.delete(sessionId);
          resolve(cmd);
        }
      } catch (error) {
        clearTimeout(timer);
        collectors.delete(sessionId);
        reject(error);
      }
    })();
  });
}

async function loadRoleText(name) {
  if (!name) return '';
  try {
    const file = path.join(ROOT, 'roles', `${name}.md`);
    if (!fs.existsSync(file)) return '';
    return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim().slice(0, 6000);
  } catch {
    return '';
  }
}

function saveSessions() {
  writeJson(stateFile('sessions'), Object.fromEntries(sessions));
}

async function ensureSession(chatKey) {
  const conf = officialConfig();
  const hit = sessions.get(chatKey);
  if (hit?.sessionId && hit.roleName !== undefined && hit.roleName !== conf.role) {
    log(`角色从「${hit.roleName || '无'}」换成「${conf.role || '无'}」，重开官方会话`);
    try { await api.workspace.archiveSession({ sessionId: hit.sessionId }); } catch { /* 已不在就算了 */ }
    sessions.delete(chatKey);
    saveSessions();
  } else if (hit?.sessionId) {
    return hit;
  }

  const params = { workspaceId };
  if (conf.agentPreset) params.agentPreset = conf.agentPreset;
  let created;
  try {
    created = unwrap(await api.sessions.create(params), 'session.create');
  } catch (error) {
    throw new Error(`建会话失败（preset "${conf.agentPreset}"）：${error?.message ?? error}。先把「后端」页的默认方案存一次。`);
  }
  const rec = { sessionId: created.sessionId, primed: false, createdAt: Date.now(), roleName: conf.role };
  sessions.set(chatKey, rec);
  saveSessions();
  api.events.follow?.(created.sessionId);
  log(`新会话 ${created.sessionId.slice(0, 12)}… ← ${chatKey}`);

  const role = await loadRoleText(conf.role);
  if (role) {
    try {
      await runTurn(created.sessionId, `【设定】下面是你的角色设定，之后一直按这个说话，不要复述这段设定。\n\n${role}`);
      rec.primed = true;
      saveSessions();
    } catch (error) {
      log('人设注入失败（继续用默认）：', error);
    }
  }
  return rec;
}

/* ── 状态文件（桌面端读） ───────────────────────────── */

const status = { connected: false, gateway: '', botName: '', startedAt: 0, lastEventAt: 0, received: 0, replied: 0, errors: 0, lastError: '' };
function saveStatus() {
  try { writeJson(stateFile('status'), { ...status, appId: APP_ID, pid: process.pid, at: Date.now() }); } catch { /* 状态写不进不影响主流程 */ }
}

/* ── WebSocket 网关 ─────────────────────────────────── */

const dedupe = createInboundDeduper({ ttlMs: 5 * 60_000 });

async function handleEvent(t, d) {
  if (t === 'READY') {
    status.connected = true;
    status.botName = String(d?.user?.username ?? d?.user?.bot ?? '');
    log(`网关就绪（会话 ${String(d?.session_id ?? '').slice(0, 12)}…，机器人「${status.botName || '?'}」）`);
    saveStatus();
    return;
  }
  if (t === 'RESUMED') {
    status.connected = true;
    log('断线恢复（resume）成功');
    saveStatus();
    return;
  }
  if (t !== 'C2C_MESSAGE_CREATE' && t !== 'GROUP_AT_MESSAGE_CREATE') return;

  const isGroup = t === 'GROUP_AT_MESSAGE_CREATE';
  const chatKey = isGroup
    ? `official:group:${d.group_openid}`
    : `official:c2c:${d.author?.id ?? ''}`;
  const fromName = isGroup ? (d.author?.member_openid ?? '?') : (d.author?.id ?? '?');
  // 群消息 content 开头常带一个 "@机器人 " 残留空格，去掉
  const text = String(d.content ?? '').replace(/^@\S+\s?/, '').trim();

  if (!text) return;
  if (dedupe('qq-official', d.id)) return;
  status.lastEventAt = Date.now();
  status.received += 1;

  const conf = officialConfig();
  const target = isGroup ? d.group_openid : d.author?.id;
  if (!allowed(isGroup ? 'group' : 'private', target, conf)) {
    log(`拦下不在白名单里的${isGroup ? '群' : '私聊'}：${target}`);
    saveStatus();
    return;
  }

  emitEvent(readConfig(), 'message', { platform: 'qq-official', chatId: chatKey, from: fromName, text: text.slice(0, 500) });
  log(`收到 ${isGroup ? '群' : '私聊'}消息 ← ${fromName}：${text.slice(0, 60)}${text.length > 60 ? '…' : ''}`);
  saveStatus();

  try {
    if (!api) await initAi();
    const rec = await ensureSession(chatKey);
    const reply = await runTurn(rec.sessionId, text);
    if (!reply || !reply.trim()) {
      log('模型回了空内容，不发送');
      return;
    }
    await sendReply(isGroup ? 'group' : 'c2c', target, reply, d.id);
    status.replied += 1;
    saveStatus();
    try {
      appendMemory({ root: ROOT, channel: 'qq-official', role: conf.role || '官方QQ', conv: chatKey, who: fromName, text });
      appendMemory({ root: ROOT, channel: 'qq-official', role: conf.role || '官方QQ', conv: chatKey, who: 'bridge', self: true, text: reply.slice(0, 2000) });
    } catch { /* 记忆失败不影响回话 */ }
    emitEvent(readConfig(), 'reply', { platform: 'qq-official', chatId: chatKey, text: reply.slice(0, 500) });
  } catch (error) {
    status.errors += 1;
    status.lastError = String(error?.message ?? error).slice(0, 200);
    saveStatus();
    log('处理失败：', error);
    // 出错也要告诉用户一声（5 分钟窗口内这是被动回复，不占主动额度）
    try {
      await sendReply(isGroup ? 'group' : 'c2c', target, '我这边出错了，稍后再试一下。', d.id);
    } catch { /* 连错误提示都发不出去就算了 */ }
  }
}

let ws = null;
let heartbeatTimer = null;
let lastSeq = 0;
let sessionId = '';
let identifyMode = 'QQBot'; // 先按新版 QQBot <access_token>，被拒再试旧版 Bot appid.secret
let backoffMs = 3000;

function stopHeartbeat() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}

async function gatewayUrl() {
  try {
    const token = await accessToken();
    const res = await fetch(`${API_BASE}/gateway`, { headers: { authorization: `QQBot ${token}` }, signal: AbortSignal.timeout(10_000) });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.url) return body.url;
  } catch { /* 拿不到就回落默认地址 */ }
  return DEFAULT_GATEWAY;
}

async function connectGateway() {
  const url = await gatewayUrl();
  status.gateway = url;
  log(`连接官方网关：${url}（${identifyMode === 'legacy' ? '旧鉴权' : 'QQBot 鉴权'}）`);
  const conf = officialConfig();
  const tokenStr = identifyMode === 'legacy'
    ? `Bot ${conf.appId}.${conf.appSecret}`
    : `QQBot ${await accessToken()}`;

  ws = new WebSocket(url);
  let opened = false;

  ws.addEventListener('open', () => { opened = true; });

  ws.addEventListener('message', (ev) => {
    let frame = null;
    try { frame = JSON.parse(String(ev.data)); } catch { return; }
    const { op, s, t, d } = frame ?? {};

    if (op === 10 && d?.heartbeat_interval) {
      // HELLO：开心跳。d 传最近一次 seq（还没有就 null）
      stopHeartbeat();
      const beat = () => {
        if (ws?.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({ op: 1, d: lastSeq || null }));
      };
      beat();
      heartbeatTimer = setInterval(beat, Math.max(5000, Number(d.heartbeat_interval) || 30000));
      // 心跳起好就鉴权（或恢复）
      if (sessionId) {
        ws.send(JSON.stringify({ op: 6, d: { token: tokenStr, session_id: sessionId, seq: lastSeq } }));
      } else {
        ws.send(JSON.stringify({
          op: 2,
          d: { token: tokenStr, intents: INTENTS_GROUP_C2C, shard: [0, 1], properties: { $os: 'windows', $browser: 'dhm', $device: 'dhm' } }
        }));
      }
      return;
    }
    if (op === 11) return; // 心跳 ACK
    if (op === 7) { log('网关要求重连'); scheduleReconnect(1500, true); return; }
    if (op === 9) {
      // 鉴权/恢复被拒：session 作废。QQBot 格式被拒时换旧格式再试一次。
      sessionId = '';
      if (identifyMode === 'QQBot') {
        log('QQBot 鉴权被拒（INVALID_SESSION），换旧版 Bot appid.secret 再试');
        identifyMode = 'legacy';
      } else {
        log('鉴权被拒（两种格式都不行）：检查 AppID/AppSecret，或 token 接口是否换了规则');
        status.connected = false;
        status.lastError = '网关鉴权被拒';
        saveStatus();
      }
      scheduleReconnect(3000, false);
      return;
    }
    if (op === 0) {
      if (s) lastSeq = s;
      if (t === 'READY') sessionId = String(d?.session_id ?? '');
      handleEvent(t, d).catch((error) => log('事件处理出错：', error));
    }
  });

  ws.addEventListener('close', (ev) => {
    stopHeartbeat();
    if (status.connected) log(`网关断开（code ${ev?.code ?? '?'}）`);
    status.connected = false;
    saveStatus();
    if (!opened) {
      // 连都没连上：多半是网络/网关地址问题，退避拉长
      scheduleReconnect(Math.min(backoffMs * 2, 60_000), false);
    } else {
      scheduleReconnect(1500, true);
    }
  });

  ws.addEventListener('error', () => { /* close 会跟着来，重连都在那边 */ });
}

let reconnectTimer = null;
function scheduleReconnect(delay, tryResume) {
  if (reconnectTimer) return;
  // 只有网络断开才 resume；鉴权被拒/连接失败走全新会话
  if (!tryResume) sessionId = '';
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    try {
      await connectGateway();
      backoffMs = 3000;
    } catch (error) {
      log('重连失败：', error);
      scheduleReconnect(Math.min(backoffMs * 2, 60_000), false);
    }
  }, delay);
}

/* ── 主流程 ─────────────────────────────────────────── */

function acquireLock() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  try {
    fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx' });
    process.on('exit', () => { try { fs.rmSync(LOCK_FILE, { force: true }); } catch { /* 退出清理失败就算了 */ } });
    return true;
  } catch {
    // 锁被占：可能是上一个还在跑。读 pid 粗判一下是不是活进程，死的就抢锁。
    try {
      const pid = Number(fs.readFileSync(LOCK_FILE, 'utf8').trim());
      process.kill(pid, 0);
      return false; // 活着：让位退出
    } catch {
      try { fs.rmSync(LOCK_FILE, { force: true }); } catch { /* 删不掉下面 wx 还会失败 */ }
      try {
        fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx' });
        process.on('exit', () => { try { fs.rmSync(LOCK_FILE, { force: true }); } catch {} });
        return true;
      } catch {
        return false;
      }
    }
  }
}

async function main() {
  const cmd = process.argv[2] === 'status' ? 'status' : 'start';
  // 多号：必须 --app 指明自己是哪个机器人（单号时代不传也能跑，取列表第一个）
  const bots = officialBotList();
  if (!APP_ID && bots.length > 1) {
    console.error(`配了 ${bots.length} 个官方机器人，启动要用 --app <AppID> 指明：${bots.map((b) => b.appId).join('、')}`);
    process.exit(4);
  }
  const conf = officialConfig();
  if (cmd === 'status') {
    const st = readJson(stateFile('status'), {});
    console.log(JSON.stringify({ config: { enabled: conf.enabled, appId: conf.appId ? conf.appId.slice(0, 4) + '…' : '' }, status: st }, null, 2));
    return;
  }
  if (!conf.enabled) { log('未启用（这个 AppID 在配置里没开），退出'); process.exit(0); }
  if (!conf.appId || !conf.appSecret) { log('缺 AppID/AppSecret，退出'); process.exit(1); }
  if (!acquireLock()) { log('已有官方 Bot 在跑（锁被占），这个进程退出'); process.exit(2); }

  status.startedAt = Date.now();
  saveStatus();
  log(`官方机器人启动（AppID ${conf.appId.slice(0, 4)}…，白名单：${conf.allowAllWhenEmpty ? '不限制' : `${conf.allowPrivate.length} 私聊 / ${conf.allowGroups.length} 群`}）`);
  process.on('SIGTERM', () => { log('收到退出信号'); process.exit(0); });

  // token 先换一把（凭证错了在这里就报出来，别等网关转圈）
  try {
    await accessToken(true);
    log('access_token 就绪');
  } catch (error) {
    log(String(error?.message ?? error));
    status.lastError = String(error?.message ?? error);
    saveStatus();
    process.exit(3);
  }

  await connectGateway().catch((error) => {
    log('首次连接失败，进重连循环：', error);
    scheduleReconnect(3000, false);
  });

  // 主线程挂着等（WS 事件驱动）
  setInterval(() => saveStatus(), 30_000).unref?.();
}

// 入口守卫：被测试 import 时不自启（import.meta.url 指向本文件、argv[1] 指向启动脚本）
const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  main().catch((error) => {
    log('启动失败：', error);
    process.exit(1);
  });
}
