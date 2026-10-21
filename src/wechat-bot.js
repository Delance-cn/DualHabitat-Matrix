/**
 * wechat-bot.js —— 微信个人号 Bot（官方 iLink / ClawBot 协议）
 *
 * 协议是纯 HTTP/JSON，域名 ilinkai.weixin.qq.com，不用 WebSocket：
 *   1. GET  get_bot_qrcode     拿二维码（qrcode_img_content 是给微信扫的内容，qrcode 是轮询 key）
 *   2. GET  get_qrcode_status  轮询扫码 → 拿到 bot_token
 *   3. POST getupdates         长轮询收消息（35s hold + 游标）
 *   4. POST sendmessage        回复与主动推送——2026-10-19 实测 context_token 不带也能发，没有"不能主动推送"这回事
 *   主动推送入口：node src/wechat-bot.js push [--dry-run] <用户id> [文字…]（文字省略时读 stdin）
 *
 * 和 QQ 那条链路的关系：
 *   · QQ 走 NapCat(OneBot) → bridge.js → 模型 API 隔离实例；
 *   · 微信走这里 → 同一个 模型 API 实例，但用自己的会话映射和白名单。
 *   故意不复用 bridge.js：那边 key 必须是 `private:<数字>`、发送全靠 NapCat 的 bot 对象，
 *   硬塞进来会把 QQ 那条跑通的链路改出问题。这里独立进程，坏了也不影响 QQ。
 *
 * 状态都在 state/ 下：
 *   wechat-token.json    bot_token / baseurl / bot_id（扫码后写入，重启复用）
 *   wechat-sessions.json 微信用户 → 模型 API 会话 id
 *   wechat-qr.json       当前二维码（桌面端读它画图）
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import QRCode from 'qrcode';

import {
  discoverMatrixEndpoint,
  NodeApiClient,
  unwrap,
  createTurnCollector
} from './oc-client.js';
import { runLocalCommand, loadPlugins } from './chat-commands.js';
import { appendMemory } from './memory-daily.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_DIR = path.join(ROOT, 'state');
const TOKEN_FILE = path.join(STATE_DIR, 'wechat-token.json');
const SESS_FILE = path.join(STATE_DIR, 'wechat-sessions.json');
const QR_FILE = path.join(STATE_DIR, 'wechat-qr.json');
// 单实例锁。桌面端也用这个文件判断「微信这条线是不是已经跑着了」，
// 所以文件名不要随手改（server.mjs 里 externalWechatPid 读的就是它）。
const LOCK_FILE = path.join(STATE_DIR, 'wechat.lock');

const ILINK_BASE = 'https://ilinkai.weixin.qq.com';
const CHANNEL_VERSION = '1.0.2';
const POLL_TIMEOUT_MS = 40_000;
const API_TIMEOUT_MS = 15_000;
const TURN_TIMEOUT_MS = 180_000;
const MAX_REPLY_CHARS = 1200;

/* ── 小工具 ───────────────────────────────────────────── */

function log(...args) {
  // 不打时间戳：桌面端把 stdout 转进日志页时会统一加 `[时:分:秒]`，
  // 这里再打一遍就成了 `[12:07:34] [12:07:34] …`。
  console.log('[微信]', ...args);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

/* ── 活动日志 ──
 * 桌面端「消息」页要按联系人看聊过什么，数据就从这儿来。
 * 格式和 QQ 那边（src/bridge.js 的 qq-activity.log）保持一致：
 *   `[时:分:秒] <会话键> <角色>：正文`
 * 只留最近 500 行 —— 这是"最近聊了什么"，不是聊天记录归档，
 * 无限长下去会把 state/ 撑爆。
 */
const ACTIVITY_FILE = path.join(STATE_DIR, 'wechat-activity.log');
const ACTIVITY_MAX_LINES = 500;

function localClock() {
  const d = new Date();
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}

function appendActivity(conv, who, text) {
  try {
    const line = `[${localClock()}] ${conv} ${who}：${String(text).replace(/[\r\n]+/g, ' ')}\n`;
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.appendFileSync(ACTIVITY_FILE, line, 'utf8');
    // 超上限就砍掉前面一半，比每行都重写整个文件省事
    const raw = fs.readFileSync(ACTIVITY_FILE, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    if (lines.length > ACTIVITY_MAX_LINES) {
      fs.writeFileSync(ACTIVITY_FILE, lines.slice(-ACTIVITY_MAX_LINES).join('\n') + '\n', 'utf8');
    }
  } catch {
    /* 写不了活动日志不该影响收发消息 */
  }
}

function readConfig() {
  const cfg = readJson(path.join(ROOT, 'config.json'), {}) ?? {};
  // 2026-10 改名：内置实例那段以前叫 `opencode`，老配置里还是旧键。
  // 这里统一成 `matrix`，下游只认新键 —— 否则升级完这段配置会被静默忽略。
  if (cfg.matrix == null && cfg.opencode != null) cfg.matrix = cfg.opencode;
  return cfg;
}

/** 微信这一份配置（桌面端「聊天」页在微信模式下存的就是这里）。 */
function wxConfig() {
  const cfg = readConfig();
  const section = cfg.platforms?.wechat;
  const w = section ?? {};
  const list = (v) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []);
  const allowPrivate = list(w.allow?.private);
  const denyPrivate = list(w.deny?.private);
  // 「配过」的判据：名单里有东西，或者明确把 allowAllWhenEmpty 存成了 false
  // （说明在「聊天」页选过"只回白名单"）。这两种之外都算没配过。
  const configured = Boolean(section) && (allowPrivate.length > 0 || denyPrivate.length > 0 || w.allowAllWhenEmpty === false);

  return {
    allowPrivate,
    allowGroups: list(w.allow?.groups),
    denyPrivate,
    denyGroups: list(w.deny?.groups),
    // 微信这一份压根没配过（第一次接进来就是这种状态）→ 先放行所有人，
    // 不然扫完码自己发一条过去毫无反应，会以为链路断了。
    // 一旦在「聊天」页存过一次微信配置，就按存的那份严格执行（空名单 = 谁都不理）。
    allowAllWhenEmpty: configured ? w.allowAllWhenEmpty === true : true,
    neverConfigured: !configured,
    ownerId: w.ownerId ? String(w.ownerId).trim() : '',
    agentPreset: w.agentPreset || cfg.agentPreset || 'qq-chat',
    // 会话列表里显示的名字。桌面端「后端」页在微信模式下改的就是这个，
    // 没填就用「微信」——总比跟 QQ 共用一个「QQ 聊天」强。
    workspaceTitle: String(w.workspaceTitle ?? '').trim() || '微信',
    sessionCwd: w.sessionCwd || cfg.sessionCwd || '',
    role: w.role || cfg.role?.name || ''
  };
}

/**
 * 放行判断。和 QQ 那边同一套语义：黑名单优先，`*` 通配，名单为空看 allowAllWhenEmpty。
 * 微信这里只有私聊（个人号 Bot 拿不到群），kind 固定 private。
 */
function allowed(from, wx) {
  const id = String(from);
  if (wx.denyPrivate.includes(id)) return false;
  if (wx.allowPrivate.includes('*')) return true;
  if (wx.allowPrivate.length > 0) return wx.allowPrivate.includes(id);
  return wx.allowAllWhenEmpty;
}

/** 微信不认 markdown，粗体/代码围栏/链接语法全部去掉，只留文字。 */
function mdToPlain(text) {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/^```[^\n]*\n?|```$/g, ''))
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .trim();
}

/** 长回复切成几条发，微信单条太长会被截断。 */
function splitText(text, limit = MAX_REPLY_CHARS) {
  const s = String(text ?? '').trim();
  if (!s) return [];
  if (s.length <= limit) return [s];
  const out = [];
  let rest = s;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit * 0.5) cut = limit;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/* ── iLink 协议 ───────────────────────────────────────── */

/** X-WECHAT-UIN：随机 uint32 的十进制字符串再 base64，防重放。 */
function randomUin() {
  return Buffer.from(String(crypto.randomBytes(4).readUInt32BE(0)), 'utf-8').toString('base64');
}

function headers(token, bodyStr) {
  const h = {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': randomUin()
  };
  if (bodyStr) h['Content-Length'] = String(Buffer.byteLength(bodyStr, 'utf-8'));
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function apiPost(baseUrl, endpoint, payload, token, timeoutMs = API_TIMEOUT_MS) {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const url = new URL(endpoint, base).toString();
  const bodyStr = JSON.stringify(payload);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: headers(token, bodyStr),
      body: bodyStr,
      signal: controller.signal
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${endpoint} HTTP ${res.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timer);
  }
}

async function apiGet(baseUrl, endpoint, token, timeoutMs = API_TIMEOUT_MS) {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const url = new URL(endpoint, base).toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: headers(token), signal: controller.signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`${endpoint} HTTP ${res.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timer);
  }
}

/* ── 登录 ─────────────────────────────────────────────── */

let tokenData = null;

function loadToken() {
  const t = readJson(TOKEN_FILE);
  return t?.bot_token ? t : null;
}

async function login() {
  const saved = loadToken();
  if (saved) {
    tokenData = saved;
    log(`复用已保存的登录（bot ${saved.bot_id || '未知'}）`);
    return saved;
  }

  log('开始扫码登录…');
  const qr = await apiGet(ILINK_BASE, `ilink/bot/get_bot_qrcode?bot_type=3`);
  const qrUrl = qr.qrcode_img_content;
  const qrKey = qr.qrcode;
  if (!qrUrl || !qrKey) throw new Error(`拿二维码失败：${JSON.stringify(qr).slice(0, 200)}`);

  // 桌面端从这里读图。二维码本身是"内容"，要画成图才能扫。
  let dataUrl = '';
  try {
    dataUrl = await QRCode.toDataURL(qrUrl, { margin: 1, width: 320 });
  } catch (error) {
    log('二维码渲染失败，只留链接：', error?.message ?? error);
  }
  writeJson(QR_FILE, { qrKey, qrUrl, dataUrl, at: Date.now(), status: 'waiting' });
  log('二维码已生成，等扫码');

  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(2000);
    let st;
    try {
      // 这个接口是长轮询：没有状态变化时它会把连接挂着（实测 15 秒都不断），
      // 所以超时给到 35 秒，别用小请求的 15 秒——否则每轮都 abort，
      // 扫了码也拿不到结果。
      st = await apiGet(
        ILINK_BASE,
        `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrKey)}`,
        undefined,
        35_000
      );
    } catch (error) {
      if (error?.name !== 'AbortError') log('查询扫码状态失败：', error?.message ?? error);
      continue;
    }
    if (st.bot_token) {
      tokenData = {
        bot_token: st.bot_token,
        baseurl: st.baseurl || ILINK_BASE,
        bot_id: st.bot_id || st.ilink_bot_id || '',
        login_time: new Date().toISOString()
      };
      writeJson(TOKEN_FILE, tokenData);
      writeJson(QR_FILE, { status: 'done', at: Date.now() });
      log(`登录成功（bot ${tokenData.bot_id || '未知'}）`);
      return tokenData;
    }
    if (st.status === 'scanned') writeJson(QR_FILE, { qrKey, qrUrl, dataUrl, at: Date.now(), status: 'scanned' });
    if (st.status === 'expired') {
      writeJson(QR_FILE, { status: 'expired', at: Date.now() });
      throw new Error('二维码过期，请重启微信接入重新生成');
    }
  }
  writeJson(QR_FILE, { status: 'timeout', at: Date.now() });
  throw new Error('等扫码超时（5 分钟），请重启微信接入');
}

/* ── AI 侧（复用 QQ 那条链路的 模型 API 实例） ────────── */

let api = null;
let apiUrl = '';
let workspaceId = null;
let aiReady = false;
let pumpStarted = false;
const sessions = new Map();       // 微信用户 id → { sessionId, primed }
const collectors = new Map();     // sessionId → { collector, resolve, reject, timer }
const userQueues = new Map();     // 微信用户 id → Promise（同一用户串行）

/**
 * 模型 API 可能还没起来（用户先点了「启动微信」、桥接还没起）。
 * 这种情况下不能直接退出 —— 扫码登录本身不需要模型，先让人把码扫了，
 * 等真有消息进来再连一次。连不上就只影响回复，不影响登录状态。
 *
 * 另外每次都要对一下注册文件里的地址：QQ 那边重启桥接会把模型 API 重拉一遍
 * （pid 换、端口可能也换），我们手里这个 client 就指向了一个死地址。
 * 这是「两个平台同时跑」最容易互相拖累的地方 —— 他重启 QQ，微信这边就哑了，
 * 而且报错看起来像是模型的问题，很难查。
 */
async function ensureAi() {
  if (aiReady && api) {
    const cfg = readConfig();
    const endpoint = await discoverMatrixEndpoint({ stateDir: cfg.matrix?.stateDir || '' });
    if (endpoint?.url === apiUrl) return;
    log(endpoint ? '模型 API 地址变了，重新连' : '模型 API 不在了，等它回来');
    aiReady = false;
    api = null;
  }
  await initAi();
  aiReady = true;
}

async function initAi() {
  const cfg = readConfig();
  const stateDir = cfg.matrix?.stateDir || '';
  const endpoint = await discoverMatrixEndpoint({ stateDir });
  if (!endpoint) throw new Error('找不到模型 API 服务。回电脑软件首页看三张状态卡：哪张显示「未运行」就点它的「启动」；都亮着还报这个错，就把桥接停止再启动一次。');
  // 必须用 NodeApiClient（DSH 同形状门面），不能用裸 SDK：
  // 裸 SDK 只有 session/event/provider，没有 workspace.* / sessions.* /
  // events.mux —— 微信这条线一上来就调 workspace.create，直接 TypeError。
  // 不传 baseUrl 是刻意的：让门面自己按注册文件发现（那里才有鉴权密码）。
  api = new NodeApiClient(cfg.matrix?.baseUrl || undefined, undefined, {
    stateDir,
    sessionDir: stateDir,
    deleteArchived: cfg.matrix?.deleteArchived === true,
    log
  });
  apiUrl = endpoint.url;
  log(`模型 API：${endpoint.url}`);

  const dir = wxConfig().sessionCwd || path.join(STATE_DIR, 'wechat', 'agents');
  fs.mkdirSync(dir, { recursive: true });
  const ws = unwrap(await api.workspace.create({ path: dir }), 'workspace.create');
  workspaceId = ws.workspace.workspaceId;
  // 每次启动都改一遍标题（不只是新建时）：他在「后端」页改了会话标题，
  // 下次启动就该跟着变，而不是永远停在第一次建的那个名字上。
  try {
    await api.workspace.rename({ workspaceId, title: wxConfig().workspaceTitle });
  } catch {
    /* 改标题失败不影响干活 */
  }

  // 事件流跟着 api 走：api 没连上就开不了 mux，所以放在这里启动，
  // 而不是在 main 里（那边可能连不上模型 API）。
  if (!pumpStarted) {
    pumpStarted = true;
    pumpEvents().catch((error) => log('事件流挂了：', error?.message ?? error));
  }
}

function loadSessions() {
  const saved = readJson(SESS_FILE, {});
  for (const [k, v] of Object.entries(saved ?? {})) sessions.set(k, v);
}

function saveSessions() {
  writeJson(SESS_FILE, Object.fromEntries(sessions));
}

async function ensureSession(userId) {
  const hit = sessions.get(userId);
  const wx = wxConfig();

  // 换角色：人设只在建会话时注入一次，旧会话会一直演旧角色 —— 直接重开。
  // 只认「角色名变了」；改同一份角色卡的内容不重开（保留上下文）。
  if (hit?.sessionId && hit.roleName !== undefined && hit.roleName !== wx.role) {
    log(`角色从「${hit.roleName || '无'}」换成「${wx.role || '无'}」，重开微信会话`);
    try { await api.workspace.archiveSession({ sessionId: hit.sessionId }); } catch {}
    sessions.delete(userId);
    saveSessions();
  } else if (hit?.sessionId) {
    return hit;
  }

  const params = { workspaceId };
  if (wx.agentPreset) params.agentPreset = wx.agentPreset;

  let created;
  try {
    created = unwrap(await api.sessions.create(params), 'session.create');
  } catch (error) {
    // 和 QQ 那边同一个安全立场：拿不到指定 preset 就不建会话。
    // 无 preset 的会话会拿到默认工具面（读写文件、跑命令），微信上不能这么开。
    throw new Error(
      `建会话失败（preset "${wx.agentPreset}"）：${error?.message ?? error}。` +
        '先把「后端」页的默认方案存一次，确认这个 preset 还在。'
    );
  }

  const rec = { sessionId: created.sessionId, primed: false, createdAt: Date.now(), roleName: wx.role };
  sessions.set(userId, rec);
  saveSessions();
  api.events.follow?.(created.sessionId);
  log(`新会话 ${created.sessionId.slice(0, 12)}… ← ${userId}`);

  // 人设只灌一次：灌完把这一轮的回复丢掉，不发给用户
  const role = await loadRoleText(wx.role);
  if (role) {
    try {
      await runTurn(created.sessionId, `【设定】下面是你的角色设定，之后一直按这个说话，不要复述这段设定。\n\n${role}`);
      rec.primed = true;
      saveSessions();
      log('人设已注入');
    } catch (error) {
      log('人设注入失败（继续用默认）：', error?.message ?? error);
    }
  }
  return rec;
}

/** 读 roles/<名称>.md。和桥接用的是同一个目录，改人格两边一起变。 */
async function loadRoleText(name) {
  if (!name) return '';
  try {
    const file = path.join(ROOT, 'roles', `${name}.md`);
    if (!fs.existsSync(file)) return '';
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim();
    // 太长会挤掉对话上下文，和 QQ 那边一样有个上限
    return text.slice(0, 6000);
  } catch {
    return '';
  }
}

/** 发一轮 prompt 并等 turn 结束，返回纯文本。 */
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
          // 斜杠命令直接有结果，不走模型
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

/** 事件流：把 session/event 分发给对应的等待者。 */
async function pumpEvents() {
  for (;;) {
    // api 可能被 ensureAi 丢掉（模型 API 重启中），这时候连不上是正常的，
    // 静静等它回来就行，别刷一屏 "Cannot read properties of null"。
    if (!api) {
      await sleep(3000);
      continue;
    }
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
      log('事件流断开，3 秒后重连：', error?.message ?? error);
      await sleep(3000);
    }
  }
}

/* ── Webhook 推送（可选） ─────────────────────────────── */

/**
 * 把微信这条线的事件 POST 给用户自己的地址：收到消息 / 回复了消息 / 出错。
 * 只推白名单内用户的消息，不往外泄露陌生人的私聊；失败绝不影响收发，
 * 连续失败会限流报错（第 1 次和之后每 20 次报一次），恢复时说一声。
 * 配置在 config.json 的 platforms.wechat.hook（桌面端「聊天」页可改），
 * 推送体格式三选一：default（原生 JSON）/ onebot（OneBot v11 事件格式，可直喂 NoneBot、Koishi 等）/ template（自定义模板，{{text}} {{from}} 这类占位符 —— 适配 wxhelper、WeChatFerry 等第三方项目）。
 * 每次触发都现读 —— 改完立即生效，不用重启微信接入。
 */
function hookConfig() {
  const w = readConfig().platforms?.wechat?.hook ?? {};
  return {
    enabled: w.enabled === true,
    url: String(w.url ?? '').trim(),
    secret: String(w.secret ?? ''),
    format: ['default', 'onebot', 'template'].includes(w.format) ? w.format : 'default',
    template: String(w.template ?? ''),
    events: Array.isArray(w.events) && w.events.length ? w.events : ['message.received', 'message.replied', 'error']
  };
}

let hookFailStreak = 0;

/**
 * 按配置把事件渲染成推送体。
 *   default  原生 JSON：{event, at, bot, ...字段}
 *   onebot   OneBot v11 事件格式：收到 → private message 事件，回复 → message_sent，
 *            其余事件包成 dhm_* 元事件 —— 让 NoneBot / Koishi 这类现成框架直接当 QQ 事件吃
 *   template 自定义模板：{{event}} {{at}} {{bot}} {{from}} {{to}} {{text}} {{kinds}} {{message}} {{json}}
 *            （文本类占位符自带 JSON 引号，模板里不要再手写引号）
 * 与 desktop/server.mjs 的 renderHookSample 保持同一套映射，改一边要改另一边。
 */
function renderHookBody(event, data) {
  const h = hookConfig();
  const base = { event, at: new Date().toISOString(), bot: tokenData?.bot_id ?? '', ...data };
  if (h.format === 'onebot') {
    const unix = Math.floor(Date.now() / 1000);
    if (event === 'message.received') {
      return JSON.stringify({ time: unix, self_id: base.bot, post_type: 'message', message_type: 'private', sub_type: 'friend', user_id: base.from, message: [{ type: 'text', data: { text: base.text ?? '' } }], raw_message: base.text ?? '', font: 0, sender: { user_id: base.from, nickname: base.from, sex: 'unknown' } });
    }
    if (event === 'message.replied') {
      return JSON.stringify({ time: unix, self_id: base.bot, post_type: 'message_sent', user_id: base.to, raw_message: base.text ?? '' });
    }
    return JSON.stringify({ time: unix, self_id: base.bot, post_type: 'dhm_' + String(event).replace('.', '_'), detail: base });
  }
  if (h.format === 'template') {
    const vals = {
      event: base.event, at: base.at, bot: base.bot, from: base.from ?? '', to: base.to ?? '',
      text: JSON.stringify(base.text ?? ''), kinds: JSON.stringify(base.kinds ?? ''), message: JSON.stringify(base.text ?? ''), json: JSON.stringify(base)
    };
    return String(h.template || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (k in vals ? String(vals[k]) : m));
  }
  return JSON.stringify(base);
}

async function fireHook(event, data) {
  const h = hookConfig();
  if (!h.enabled || !h.url || !h.events.includes(event)) return;
  const body = renderHookBody(event, data);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(h.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(h.secret ? { 'X-DHM-Secret': h.secret } : {}) },
      body,
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (hookFailStreak >= 3) log('webhook 恢复正常');
    hookFailStreak = 0;
  } catch (error) {
    hookFailStreak += 1;
    if (hookFailStreak === 1 || hookFailStreak % 20 === 0) {
      log(`webhook 推送失败（${error?.message ?? error}），连续失败 ${hookFailStreak} 次`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/* ── 收发消息 ─────────────────────────────────────────── */

let typingTickets = {};

async function startTyping(userId, contextToken) {
  try {
    if (!typingTickets[userId]) {
      const cfg = await apiPost(tokenData.baseurl || ILINK_BASE, 'ilink/bot/getconfig', {
        ilink_user_id: userId,
        context_token: contextToken,
        base_info: { channel_version: CHANNEL_VERSION }
      }, tokenData.bot_token, 10_000);
      if (cfg.typing_ticket) typingTickets[userId] = cfg.typing_ticket;
    }
    const ticket = typingTickets[userId];
    if (!ticket) return;
    await apiPost(tokenData.baseurl || ILINK_BASE, 'ilink/bot/sendtyping', {
      ilink_user_id: userId,
      typing_ticket: ticket,
      status: 1,
      base_info: { channel_version: CHANNEL_VERSION }
    }, tokenData.bot_token, 10_000);
  } catch {
    /* typing 失败不影响正事 */
  }
}

async function stopTyping(userId) {
  const ticket = typingTickets[userId];
  if (!ticket) return;
  try {
    await apiPost(tokenData.baseurl || ILINK_BASE, 'ilink/bot/sendtyping', {
      ilink_user_id: userId,
      typing_ticket: ticket,
      status: 2,
      base_info: { channel_version: CHANNEL_VERSION }
    }, tokenData.bot_token, 10_000);
  } catch {
    /* 同上 */
  }
}

/**
 * 发文本消息。context_token 现在是可选参数：
 *   - 回复场景照旧带上（谁的来消息就用谁的）；
 *   - 主动推送场景没有这东西——2026-10-19 实测不带也能发出去，
 *     所以只在有 token 时才把字段放进 payload，不发空值。
 */
async function sendText(to, contextToken, text) {
  const msg = {
    from_user_id: '',
    to_user_id: to,
    client_id: `wxbridge-${crypto.randomUUID()}`,
    message_type: 2,
    message_state: 2,
    item_list: [{ type: 1, text_item: { text } }]
  };
  if (contextToken) msg.context_token = contextToken;
  await apiPost(tokenData.baseurl || ILINK_BASE, 'ilink/bot/sendmessage', {
    msg,
    base_info: { channel_version: CHANNEL_VERSION }
  }, tokenData.bot_token);
}

const MSG_TYPES = { 1: '文字', 2: '图片', 3: '语音', 4: '文件', 5: '视频' };

function extractText(msg) {
  return (msg.item_list || [])
    .filter((i) => i.type === 1 && i.text_item)
    .map((i) => i.text_item.text)
    .join('');
}

/** 插件懒加载：第一次遇到 / 指令时才读盘，import 本模块不会产生副作用。 */
let pluginState = null;
async function getPluginState() {
  if (!pluginState) pluginState = await loadPlugins(path.join(ROOT, 'plugins'), log);
  return pluginState;
}

/** 插件事件分发：微信侧与 QQ 侧同一套钩子；异常互相隔离。 */
async function firePluginHook(hook, payload) {
  try {
    const ps = await getPluginState();
    for (const p of ps.plugins) {
      const fn = p.hooks?.[hook];
      if (typeof fn !== 'function') continue;
      const pluginName = p.name;
      try {
        Promise.resolve(fn({ ...payload, plugin: pluginName })).catch((error) => {
          log(`⚠️ 插件 ${pluginName}.${hook} 异步异常：${error?.message ?? error}`);
        });
      } catch (error) {
        log(`⚠️ 插件 ${pluginName}.${hook} 异常：${error?.message ?? error}`);
      }
    }
  } catch (error) {
    log(`⚠️ 插件事件 ${hook} 分发失败：${error?.message ?? error}`);
  }
}

// 插件心跳：每分钟一次 onTick
setInterval(() => {
  try { firePluginHook('onTick', { platform: 'wechat' }).catch(() => { }); } catch { }
}, 60_000).unref?.();

async function handleMessage(msg) {
  if (msg.message_type === 2) return;                      // bot 自己发的
  if (String(msg.from_user_id ?? '').endsWith('@im.bot')) return;

  const from = String(msg.from_user_id ?? '');
  const ctx = msg.context_token;
  const text = extractText(msg).trim();
  const kinds = (msg.item_list || []).map((i) => MSG_TYPES[i.type] ?? `类型${i.type}`).join('+') || '空';

  if (!from || !ctx) return;
  const wx = wxConfig();
  if (!allowed(from, wx)) {
    log(`不在白名单，忽略 ${from}：${text.slice(0, 40)}`);
    return;
  }

  log(`收到 ${from}（${kinds}）：${text.slice(0, 60)}`);
  appendActivity(from, '对方', text || `[${kinds}]`);
  fireHook('message.received', { from, text, kinds });
  firePluginHook('onMessage', {
    platform: 'wechat',
    kind: 'private',
    chatId: from,
    from,
    fromName: from,
    text,
    isOwner: Boolean(wx.ownerId) && from === String(wx.ownerId),
    reply: (t) => sendText(from, ctx, String(t)).catch((e) => log('插件回复失败：', e?.message ?? e))
  });
  // 每日记忆日志：微信侧收到的消息落盘（角色目录固定为「微信」）
  try {
    appendMemory({ root: ROOT, channel: 'wechat', role: '微信', conv: from, who: from, text });
  } catch (error) { log(`记忆日志写入失败：${error?.message ?? error}`); }

  if (!text) {
    await sendText(from, ctx, `收到你的${kinds}消息，我现在只能看文字。`).catch(() => {});
    return;
  }

  // ── 本地指令层（src/chat-commands.js）──
  // 只认 ownerId（config.platforms.wechat.ownerId）：没配就等于微信侧没有指令层，
  // 谁都能 /shutdown 是绝对不能发生的。放在入队之前，命中就不进模型。
  if (text.startsWith('/') && wx.ownerId && from === String(wx.ownerId)) {
    const fullCfg = readConfig();
    const plugins = await getPluginState();
    const handled = await runLocalCommand(text, {
      platform: 'wechat',
      from,
      config: fullCfg,
      log,
      plugins: plugins.plugins,
      pluginsDir: plugins.dir,
      reply: (msg) => sendText(from, ctx, msg).catch((e) => log('指令回复失败：', e?.message ?? e))
    });
    if (handled) {
      appendActivity(from, '本地指令', text);
      return;
    }
  }

  // 同一个用户串行：上一条没回完，这条排队
  const prev = userQueues.get(from) ?? Promise.resolve();
  const job = prev
    .catch(() => {})
    .then(async () => {
      await startTyping(from, ctx);
      try {
        await ensureAi();
        const rec = await ensureSession(from);
        const reply = mdToPlain(await runTurn(rec.sessionId, text));
        const parts = splitText(reply);
        if (!parts.length) await sendText(from, ctx, '（它这次没说话）');
        for (const part of parts) await sendText(from, ctx, part);
        log(`回复 ${from}：${reply.slice(0, 60)}`);
        appendActivity(from, 'agent 回复', reply);
        firePluginHook('onBotReply', { platform: 'wechat', chatId: from, text: reply });
        try {
          appendMemory({ root: ROOT, channel: 'wechat', role: '微信', conv: from, who: 'bridge', self: true, text: reply });
        } catch (error) { log(`记忆日志写入失败：${error?.message ?? error}`); }
        fireHook('message.replied', { to: from, text: reply.slice(0, 2000) });
      } catch (error) {
        log('处理失败：', error?.message ?? error);
        fireHook('error', { where: 'handle', from, message: String(error?.message ?? error).slice(0, 300) });
        // 这一轮失败可能只是模型 API 刚被 QQ 那边重启了。标记成未就绪，
        // 下一条消息会重新发现地址，而不是一直对着死端点发。
        aiReady = false;
        await sendText(from, ctx, `⚠️ 出错了：${String(error?.message ?? error).slice(0, 200)}`).catch(() => {});
      } finally {
        await stopTyping(from);
      }
    });
  userQueues.set(from, job);
}

async function pollLoop() {
  let cursor = '';
  log('开始收消息');
  for (;;) {
    try {
      const data = await apiPost(tokenData.baseurl || ILINK_BASE, 'ilink/bot/getupdates', {
        get_updates_buf: cursor || '',
        base_info: { channel_version: CHANNEL_VERSION }
      }, tokenData.bot_token, POLL_TIMEOUT_MS);

      if (data.ret && data.ret !== 0) {
        log(`getupdates 报错 ret=${data.ret} ${data.errmsg ?? ''}`);
        if (data.errcode === -14) {
          // 会话过期。以前是直接退出、让人手动删 token 文件重扫，太难受了：
          // 这里把失效的 token 丢掉、抛出去让 main 重新走一遍扫码流程，
          // 桌面端会自己刷出新二维码。
          log('登录已过期，重新生成二维码');
          try {
            fs.rmSync(TOKEN_FILE, { force: true });
          } catch {
            /* 删不掉也没关系，下面会把内存里的丢掉 */
          }
          tokenData = null;
          throw new Error('RELOGIN');
        }
        await sleep(3000);
        continue;
      }

      if (data.get_updates_buf) cursor = data.get_updates_buf;

      for (const msg of data.msgs ?? []) {
        handleMessage(msg).catch((error) => log('消息处理异常：', error?.message ?? error));
      }
    } catch (error) {
      if (String(error?.message) === 'RELOGIN') throw error; // 交给 main 重新扫码
      if (error?.name === 'AbortError') continue;   // 长轮询正常超时
      log('轮询出错，3 秒后重试：', error?.message ?? error);
      await sleep(3000);
    }
  }
}

/* ── 主动推送 ─────────────────────────────────────────── */

/**
 * 主动发一条文本给指定微信用户：不等来消息、不需要 context_token。
 * 和回复共用 sendText（token 可选）与分条逻辑；白名单和回复同一套——
 * 名单没配过就放行，配过就只许名单里的人，不许把桥接当群发器用。
 *
 * @param {string} to 目标用户 id（state/wechat-sessions.json 的 key 就是它）
 * @param {string} text 要发的文字（超长自动分条）
 * @returns {Promise<number>} 实际发出的条数
 */
async function pushText(to, text) {
  if (!tokenData) {
    const saved = loadToken();
    if (!saved) throw new Error('还没有登录态：state/wechat-token.json 不存在，先扫码登录一次');
    tokenData = saved;
  }
  const id = String(to ?? '').trim();
  if (!id) throw new Error('缺少目标用户 id（去 state/wechat-sessions.json 里找 key）');
  const wx = wxConfig();
  if (!allowed(id, wx)) throw new Error(`目标 ${id} 不在微信白名单里，按当前配置不主动打扰`);
  const parts = splitText(String(text ?? '').trim());
  if (!parts.length) throw new Error('没有要发的内容');
  for (const part of parts) await sendText(id, '', part);
  appendActivity(id, '主动发送', String(text ?? '').trim());
  return parts.length;
}

/**
 * CLI：node src/wechat-bot.js push [--dry-run] <用户id> [文字…]
 * 文字省略时从 stdin 读（方便多行/管道喂）。--dry-run 只打印计划，不碰微信、不需要登录态。
 */
async function cliPush(argv) {
  const flags = argv.filter((a) => a.startsWith('--'));
  const rest = argv.filter((a) => !a.startsWith('--'));
  const dryRun = flags.includes('--dry-run');
  const to = rest[0] ?? '';
  let text = rest.slice(1).join(' ').trim();
  if (!text) {
    if (process.stdin.isTTY) throw new Error('没有要发的内容：把文字写在命令行里，或者用管道喂 stdin');
    text = fs.readFileSync(0, 'utf8').trim();
  }
  if (dryRun) {
    const pass = allowed(to, wxConfig());
    const parts = splitText(text);
    log(`[dry-run] to=${to || '(空)'} 白名单=${pass ? '放行' : '拦截'} 条数=${parts.length}`);
    for (const p of parts) console.log('---\n' + p);
    return;
  }
  const sent = await pushText(to, text);
  log(`已主动发送 ${sent} 条 → ${to}`);
}

// 给桌面端/其他模块用的复用出口：import 本文件不会启动轮询（见文件尾的入口守卫），
// 拿到 pushText 就能主动发消息；发之前的白名单检查在 pushText 内部做。
export { pushText };

/* ── 入口 ─────────────────────────────────────────────── */

/**
 * 单实例锁。
 *
 * 为什么必须有：两个进程同时长轮询**同一个 bot**，微信会把消息劈成两半投递，
 * 于是回复对不上上下文、`wechat-sessions.json` 互相覆盖 —— 表现是"微信一会儿灵
 * 一会儿不灵"，很难查。锁文件存 PID，持有者已经死了就接管。
 *
 * @returns {boolean} true = 拿到了锁，可以继续；false = 已经有一个在跑。
 */
function acquireInstanceLock() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tryCreate = () => {
    try {
      fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx', mode: 0o600 });
      return true;
    } catch (error) {
      if (error?.code === 'EEXIST') return false;
      throw error;
    }
  };
  if (tryCreate()) return true;

  let heldByLiveProcess = false;
  try {
    const pid = Number(fs.readFileSync(LOCK_FILE, 'utf8').trim());
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
      try {
        process.kill(pid, 0);
        heldByLiveProcess = true;
      } catch (error) {
        // ESRCH = 进程真的不在了，锁是尸体；其它错误（EPERM 等）拿不准，按"还活着"处理。
        heldByLiveProcess = error?.code !== 'ESRCH';
      }
    }
  } catch {
    heldByLiveProcess = false; // 读不动 / 内容坏，当过期锁
  }
  if (heldByLiveProcess) return false;

  try { fs.unlinkSync(LOCK_FILE); } catch {}
  return tryCreate();
}

function releaseInstanceLock() {
  try {
    if (fs.existsSync(LOCK_FILE) && Number(fs.readFileSync(LOCK_FILE, 'utf8').trim()) === process.pid) {
      fs.unlinkSync(LOCK_FILE);
    }
  } catch {
    /* 释放失败不影响退出 */
  }
}

async function main() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  if (!acquireInstanceLock()) {
    log('已经有一个微信接入在跑（微信同账号只能一个进程长轮询），这次不重复启动。');
    process.exit(2);
  }
  process.on('exit', releaseInstanceLock);
  loadSessions();

  const wx = wxConfig();
  if (wx.neverConfigured) {
    log('微信白名单还没配，先放行所有人（方便你自己先试一条）。');
    log('去「聊天」页把管理员微信填上，配好之后就只理名单里的人。');
  } else if (wx.allowPrivate.length === 0) {
    log('白名单是空的 —— 现在谁发消息都不会回。去「聊天」页把允许的微信号填上。');
  }

  // 外层循环只为了一件事：登录过期（-14）后能自己回到扫码那一步。
  // 正常跑起来就不会回到这里。
  let loginFailures = 0;
  let qrRounds = 0;
  for (;;) {
    try {
      await login();
      loginFailures = 0;
      qrRounds = 0;
    } catch (error) {
      const msg = String(error?.message ?? error);
      // 二维码过期、等扫码超时都不是故障 —— 重新取一张就行。
      // 要是让进程退出去，用户得回来再点一次「启动微信」，纯属折腾。
      const retryable = /二维码过期|超时/.test(msg);
      loginFailures += 1;
      if (retryable) qrRounds += 1;
      // 没人扫的时候不能无限刷码：连续三轮都没人扫就退出，
      // 否则这进程会一直挂着、每 5 分钟向微信要一张新码。
      if (qrRounds >= 3) {
        log('连续三张二维码都没人扫，先停下。要用的时候再点「启动微信」。');
        process.exit(0);
      }
      if (!retryable && loginFailures > 5) throw error;
      log(`登录没成（${msg.slice(0, 80)}），${retryable ? '重新生成二维码' : '5 秒后重试'}`);
      if (!retryable) await sleep(5000);
      continue;
    }
    try {
      await ensureAi();
    } catch (error) {
      log('模型 API 还没起来，先只做登录；有消息进来时会再连一次：', error?.message ?? error);
    }
    try {
      await pollLoop();
    } catch (error) {
      if (String(error?.message) === 'RELOGIN') continue;
      throw error;
    }
  }
}

process.on('SIGTERM', () => {
  log('收到停止信号，退出');
  releaseInstanceLock();
  process.exit(0);
});

// 只有直接运行本文件才进主流程；被 import 时什么都不动，
// 桌面端/别的模块可以复用 pushText，不会把轮询顺便拉起来。
// `push` 子命令是主动推送的一次性用法：不发 getupdates，不碰实例锁。
// 注意：比较必须用 realpath。这台机器上项目根是个 junction
// （C:\Users\<用户>\DualHabitatMatrix → Documents\默认项目\DualHabitat-Matrix），
// argv[1] 用哪个入口路径进来都有可能，而 import.meta.url 永远是真实路径，
// 直接严格相等会静默失配 —— 进程什么都不做地退出 0，比崩了还难查。
const invokedAsMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();
if (invokedAsMain) {
  if (process.argv[2] === 'push') {
    cliPush(process.argv.slice(3)).catch((error) => {
      log('主动发送失败：', error?.message ?? error);
      process.exit(1);
    });
  } else {
    main().catch((error) => {
      log('启动失败：', error?.message ?? error);
      process.exit(1);
    });
  }
}
