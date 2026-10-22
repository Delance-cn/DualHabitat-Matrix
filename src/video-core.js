// 视频工具核心：B 站 / 抖音 / YouTube 的元数据、下载、抽帧。
//
// 安全边界：
// - 用户给的链接只用于**识别平台**；真正请求的 API 都是固定域名。
// - 视频/封面下载统一走 safe-fetch（禁止内网、逐跳校验重定向、限制字节数）。
// - 抖音没有公开的匿名视频流接口，单条视频用本机 Edge/Chrome 的 headless CDP
//   打开播放页，从 <video>.currentSrc 拿到带签名的 CDN 地址；没有浏览器时降级成
//   封面 + 简介，不伪造“看过”。
// - 临时文件写到系统临时目录，抽完帧立即删除。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { safeFetch, safeFetchBinary, safeFetchBuffer } from './safe-fetch.js';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CONFIG_FILE = path.join(ROOT, 'config.json');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const GOOGLEBOT_UA = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const DEFAULT_MAX_BYTES = 80 * 1024 * 1024;
const MAX_DURATION_SECONDS = 15 * 60;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── 配置 ───────────────────────────────────────────────────────────────────

export function loadConfig() {
  try {
    let text = fs.readFileSync(CONFIG_FILE, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function videoCfg() {
  return loadConfig()?.socialV2?.video || {};
}

function maxDownloadBytes() {
  const n = Number(videoCfg().maxDownloadBytes);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_BYTES;
  return Math.min(n, 200 * 1024 * 1024);
}

export function resolveFfmpeg() {
  const cfg = loadConfig();
  return String(
    videoCfg().ffmpegPath
      || cfg?.socialV2?.voice?.ffmpegPath
      || process.env.FFMPEG_PATH
      || 'ffmpeg'
  ).trim() || 'ffmpeg';
}

/** 当前模型能不能吃图片内容块。跟 bridge.js 的 modelSeesImages 保持同一口径。 */
export function canSeeImages() {
  const cfg = loadConfig();
  if (cfg?.socialV2?.images?.enabled === false) return false;
  const raw = String(cfg?.dsh?.model || '').toLowerCase().split('#')[0].trim();
  if (!raw) return false;
  const list = cfg?.socialV2?.images?.visionModels;
  if (Array.isArray(list) && list.length) {
    return list.some((m) => {
      const name = String(m || '').toLowerCase().split('#')[0].trim();
      return name && (raw === name || raw.includes(name));
    });
  }
  return /(^|[-_.])(vl|vision|omni)/.test(raw);
}

// ── 文本工具 ───────────────────────────────────────────────────────────────

function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; }
    })
    .replace(/&#(\d+);/g, (_, n) => {
      try { return String.fromCodePoint(Number(n)); } catch { return ''; }
    })
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'");
}

function clean(s, max = 1200) {
  return decodeEntities(
    String(s ?? '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function truncate(s, max = 600) {
  const t = String(s ?? '').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function firstUrl(text) {
  const m = String(text ?? '').match(/https?:\/\/[^\s<>"']+/i);
  if (!m) return '';
  return m[0].replace(/[)\]，。！？；、]+$/g, '');
}

function fmtDuration(seconds) {
  const n = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const s = n % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function parseDurationText(text) {
  const m = String(text ?? '').match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return 0;
  if (m[3]) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  return Number(m[1]) * 60 + Number(m[2]);
}

function appendNote(a, b) {
  return [a, b].filter(Boolean).join(' ');
}

async function fetchJson(url, headers = {}, timeoutMs = 15000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        'user-agent': UA,
        accept: 'application/json,text/plain,*/*',
        'accept-language': 'zh-CN,zh;q=0.9',
        ...headers,
      },
      signal: ac.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`接口返回的不是 JSON：${text.slice(0, 120).replace(/\s+/g, ' ')}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

// ── 平台识别 ───────────────────────────────────────────────────────────────

export function detectPlatform(input) {
  const s = String(input ?? '').trim();
  if (/(^|\/\/|\.)(douyin\.com|iesdouyin\.com|v\.douyin\.com)\//i.test(s) || /^\d{15,}$/.test(s)) return 'douyin';
  if (/(^|\/\/|\.)(bilibili\.com|b23\.tv|bili2233\.cn)\//i.test(s) || /^BV[0-9A-Za-z]{10}$/.test(s)) return 'bilibili';
  if (/(^|\/\/|\.)(youtube\.com|youtu\.be)\//i.test(s)) return 'youtube';
  return '';
}

// ── B 站 ───────────────────────────────────────────────────────────────────

function biliHeaders(referer = 'https://www.bilibili.com/') {
  return { 'user-agent': UA, referer };
}

function normalizeBiliCover(pic) {
  let s = String(pic ?? '').trim();
  if (!s) return '';
  if (s.startsWith('//')) s = `https:${s}`;
  else if (s.startsWith('http://')) s = `https://${s.slice(7)}`;
  return s;
}

async function resolveBiliRef(input) {
  let raw = firstUrl(input) || String(input ?? '').trim();
  if (!raw) throw new Error('没有找到链接');
  if (/^BV[0-9A-Za-z]{10}$/.test(raw)) {
    return { bvid: raw, pageUrl: `https://www.bilibili.com/video/${raw}` };
  }
  if (/b23\.tv|bili2233\.cn/i.test(raw)) {
    const r = await safeFetch(raw, 300000, { headers: { 'user-agent': UA } });
    const final = r.url || raw;
    const bv = final.match(/BV[0-9A-Za-z]{10}/)?.[0] || r.body.match(/BV[0-9A-Za-z]{10}/)?.[0];
    if (bv) return { bvid: bv, pageUrl: `https://www.bilibili.com/video/${bv}` };
    raw = final;
  }
  const bv = raw.match(/BV[0-9A-Za-z]{10}/)?.[0];
  if (bv) return { bvid: bv, pageUrl: `https://www.bilibili.com/video/${bv}` };
  const av = raw.match(/\/av(\d+)/i)?.[1] || raw.match(/^av(\d+)$/i)?.[1];
  if (av) return { aid: av, pageUrl: `https://www.bilibili.com/video/av${av}` };
  throw new Error('不是可识别的 B 站视频链接（需要 BV/av 号）');
}

async function biliView(ref) {
  const q = ref.bvid ? `bvid=${encodeURIComponent(ref.bvid)}` : `aid=${encodeURIComponent(ref.aid)}`;
  const j = await fetchJson(`https://api.bilibili.com/x/web-interface/view?${q}`, biliHeaders());
  if (j.code !== 0 || !j.data) throw new Error(`B 站接口返回 ${j.code}：${j.message || '未知错误'}`);
  return j.data;
}

async function biliPlayUrl(data, bvid) {
  const cid = data.cid || data.pages?.[0]?.cid;
  if (!cid) return null;
  const pageUrl = `https://www.bilibili.com/video/${bvid}`;
  for (const qn of [32, 16]) {
    try {
      const j = await fetchJson(
        `https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(bvid)}&cid=${encodeURIComponent(cid)}&qn=${qn}&fnval=1&fourk=0`,
        biliHeaders(pageUrl)
      );
      if (j.code !== 0 || !j.data) continue;
      const durl = j.data.durl?.[0]?.url;
      if (durl) {
        return { url: durl, quality: j.data.quality, headers: { 'user-agent': UA, referer: pageUrl } };
      }
      const dash = j.data.dash?.video?.[0];
      if (dash?.baseUrl) {
        return { url: dash.baseUrl, quality: dash.id, headers: { 'user-agent': UA, referer: pageUrl } };
      }
    } catch {
      // 换下一个清晰度
    }
  }
  return null;
}

export async function resolveBilibili(input) {
  const ref = await resolveBiliRef(input);
  const data = await biliView(ref);
  const bvid = data.bvid || ref.bvid;
  const play = await biliPlayUrl(data, bvid);
  // 多 P 视频只取第一 P，时长也按第一 P 算；否则抽帧会跑到后面几 P 的空画面。
  const duration = Number(data.pages?.[0]?.duration || data.duration) || 0;
  const tooLong = duration > MAX_DURATION_SECONDS;
  const pageUrl = `https://www.bilibili.com/video/${bvid}`;
  return {
    platform: 'bilibili',
    id: bvid,
    title: clean(data.title, 300) || `B 站视频 ${bvid}`,
    author: clean(data.owner?.name, 80),
    desc: truncate(clean(data.desc, 2000), 800),
    cover: normalizeBiliCover(data.pic),
    pageUrl,
    videoUrl: play && !tooLong ? play.url : '',
    downloadHeaders: play?.headers || { 'user-agent': UA, referer: pageUrl },
    coverHeaders: { 'user-agent': UA, referer: 'https://www.bilibili.com/' },
    duration,
    width: Number(data.dimension?.width) || 0,
    height: Number(data.dimension?.height) || 0,
    stats: data.stat || {},
    note: tooLong
      ? `视频时长 ${fmtDuration(duration)}，超过 ${Math.round(MAX_DURATION_SECONDS / 60)} 分钟，只取封面不下载。`
      : '',
  };
}

export async function hotBilibili(limit = 10, page = 1) {
  const ps = Math.max(1, Math.min(20, Number(limit) || 10));
  const pn = Math.max(1, Number(page) || 1);
  let list = [];
  try {
    const j = await fetchJson(`https://api.bilibili.com/x/web-interface/popular?ps=${ps}&pn=${pn}`, biliHeaders());
    if (j.code === 0 && Array.isArray(j.data?.list)) list = j.data.list;
  } catch {
    // 热门接口偶发 403，下面用排行榜兜底
  }
  if (!list.length) {
    const j = await fetchJson('https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all', biliHeaders());
    if (j.code === 0 && Array.isArray(j.data?.list)) list = j.data.list.slice(0, ps);
  }
  return list.map((v) => ({
    platform: 'bilibili',
    id: v.bvid,
    title: clean(v.title, 300),
    author: clean(v.owner?.name, 80),
    url: v.bvid ? `https://www.bilibili.com/video/${v.bvid}` : '',
    cover: normalizeBiliCover(v.pic),
    duration: Number(v.duration) || 0,
    durationText: fmtDuration(v.duration),
    desc: truncate(clean(v.desc, 1000), 300),
    stat: {
      view: v.stat?.view,
      like: v.stat?.like,
      danmaku: v.stat?.danmaku,
    },
  }));
}

export async function searchBilibili(keyword, limit = 10) {
  const q = clean(keyword, 80);
  if (!q) throw new Error('搜索词为空');
  const buvid3 = `${crypto.randomUUID().toUpperCase()}infoc`;
  const j = await fetchJson(
    `https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(q)}&page=1`,
    { ...biliHeaders('https://search.bilibili.com/'), cookie: `buvid3=${buvid3}` }
  );
  if (j.code !== 0) throw new Error(`B 站搜索失败 ${j.code}：${j.message || ''}`);
  const list = Array.isArray(j.data?.result) ? j.data.result : [];
  return list
    .filter((v) => v.bvid)
    .slice(0, Math.max(1, Math.min(20, Number(limit) || 10)))
    .map((v) => ({
      platform: 'bilibili',
      id: v.bvid,
      title: clean(v.title, 300),
      author: clean(v.author, 80),
      url: `https://www.bilibili.com/video/${v.bvid}`,
      cover: normalizeBiliCover(v.pic),
      duration: parseDurationText(v.duration),
      durationText: String(v.duration || ''),
      desc: truncate(clean(v.description, 1000), 300),
      play: v.play,
    }));
}

// ── 抖音 ───────────────────────────────────────────────────────────────────

function extractDouyinId(text) {
  const s = String(text ?? '');
  const m = s.match(/(?:video|share\/video|note)\/(\d{10,})/i)
    || s.match(/(?:modal_id|aweme_id|item_id|vid)=(\d{10,})/i)
    || s.match(/^\s*(\d{15,})\s*$/);
  return m?.[1] || '';
}

async function resolveDouyinRef(input) {
  const raw = firstUrl(input) || String(input ?? '').trim();
  if (!raw) throw new Error('没有找到链接或视频 ID');
  if (/^\d{15,}$/.test(raw)) {
    return { id: raw, url: `https://www.douyin.com/video/${raw}` };
  }
  let id = extractDouyinId(raw);
  if (id) return { id, url: `https://www.douyin.com/video/${id}` };
  if (/v\.douyin\.com/i.test(raw)) {
    try {
      const r = await safeFetch(raw, 300000, { headers: { 'user-agent': MOBILE_UA } });
      const final = r.url || raw;
      id = extractDouyinId(final) || extractDouyinId(r.body);
      if (id) return { id, url: `https://www.douyin.com/video/${id}` };
      return { id: '', url: final };
    } catch {
      return { id: '', url: raw };
    }
  }
  if (/douyin\.com|iesdouyin\.com/i.test(raw)) return { id: '', url: raw };
  throw new Error('不是可识别的抖音链接');
}

function findBrowser() {
  const candidates = [
    videoCfg().browserPath,
    process.env.DHM_BROWSER_PATH,
    process.env.EDGE_PATH,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return String(p);
    } catch {
      // ignore
    }
  }
  return '';
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForPageTarget(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page' && /douyin|bilibili|about:blank/i.test(t.url))
        || list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page;
    } catch {
      // 浏览器还没起来
    }
    await sleep(250);
  }
  throw new Error('浏览器启动超时（CDP 端口没有就绪）');
}

/**
 * 打开一个 headless 浏览器页面，跑完 fn 后关闭。
 * profileDir 传临时目录时会自动删除；传 state/video-profile 时会保留（用于登录态）。
 */
async function withCdpPage({ url, profileDir, timeoutMs = 60000, keepProfile = false }, fn) {
  const browserPath = findBrowser();
  if (!browserPath) throw new Error('系统里没找到 Edge/Chrome，无法解析抖音播放页');
  if (typeof WebSocket === 'undefined') throw new Error('当前 Node 不支持 WebSocket（需要 Node 22+）');
  const port = await getFreePort();
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
    '--mute-audio',
    '--disable-blink-features=AutomationControlled',
    '--lang=zh-CN',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--window-size=1280,900',
    url,
  ];
  const child = spawn(browserPath, args, { stdio: 'ignore', windowsHide: true });
  let ws;
  try {
    const page = await waitForPageTarget(port, Math.min(timeoutMs, 30000));
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP WebSocket 连接超时')), 10000);
      ws.onopen = () => { clearTimeout(timer); resolve(); };
      ws.onerror = (e) => { clearTimeout(timer); reject(e instanceof Error ? e : new Error('CDP WebSocket 连接失败')); };
    });
    let nextId = 1;
    const pending = new Map();
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    };
    const send = (method, params = {}) => {
      const id = nextId++;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP 命令超时：${method}`));
        }, 20000);
        pending.set(id, (msg) => {
          clearTimeout(timer);
          if (msg.error) reject(new Error(msg.error.message || `CDP 错误：${method}`));
          else resolve(msg);
        });
      });
    };
    const evalJs = async (expression) => {
      const r = await send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
      });
      if (r.result?.exceptionDetails) {
        throw new Error(r.result.exceptionDetails.text || '页面脚本执行失败');
      }
      return r.result?.result?.value;
    };
    await send('Page.enable');
    await send('Runtime.enable');
    return await fn({ send, evalJs, page });
  } finally {
    try { ws?.close(); } catch { /* ignore */ }
    try { child.kill(); } catch { /* ignore */ }
    await sleep(400);
    if (!keepProfile) {
      try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
}

function frameTimestamps(duration, count) {
  const n = Math.max(1, Math.min(6, Number(count) || 4));
  const d = Number(duration);
  if (!Number.isFinite(d) || d <= 0) return [1, 3, 5, 8, 12, 16].slice(0, n);
  if (d < 2) return [0.1, 0.3, 0.5, 0.7, 0.9].slice(0, n).map((x) => x * d);
  const start = d > 20 ? Math.min(5, d * 0.1) : d * 0.1;
  const end = d > 20 ? d * 0.9 : d * 0.85;
  if (n === 1) return [d * 0.5];
  return Array.from({ length: n }, (_, i) => start + ((end - start) * i) / (n - 1));
}

async function captureBlobFrames(send, evalJs, count) {
  // 页面上可能同时有隐藏的预加载 <video> 和可见播放器；取面积最大的那个。
  const rect = await evalJs(`(() => {
    const vids = [...document.querySelectorAll('video')];
    const v = vids.sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return (br.width * br.height) - (ar.width * ar.height);
    })[0];
    if (!v) return null;
    const r = v.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, d: Number(v.duration) || 0 };
  })()`);
  if (!rect || rect.w < 80 || rect.h < 60) return [];
  const out = [];
  for (const t of frameTimestamps(rect.d, count)) {
    try {
      await evalJs(`new Promise((resolve) => {
        const vids = [...document.querySelectorAll('video')];
        const v = vids.sort((a, b) => {
          const ar = a.getBoundingClientRect();
          const br = b.getBoundingClientRect();
          return (br.width * br.height) - (ar.width * ar.height);
        })[0];
        if (!v) return resolve(false);
        let done = false;
        const finish = () => { if (!done) { done = true; resolve(true); } };
        v.addEventListener('seeked', finish, { once: true });
        v.pause();
        v.currentTime = ${Number(t)};
        setTimeout(finish, 1500);
      })`);
      await sleep(500);
      const shot = await send('Page.captureScreenshot', {
        format: 'jpeg',
        quality: 62,
        clip: {
          x: Math.max(0, rect.x),
          y: Math.max(0, rect.y),
          width: Math.max(1, rect.w),
          height: Math.max(1, rect.h),
          scale: 1,
        },
      });
      if (shot.result?.data) out.push(Buffer.from(shot.result.data, 'base64'));
    } catch {
      // 单帧失败就跳过
    }
  }
  return out;
}

function douyinTitleFromPage(title, desc) {
  let t = clean(title, 300);
  t = t.replace(/\s*-\s*抖音\s*$/i, '').trim();
  if (!t || t === '抖音' || /验证码/.test(t)) {
    t = clean(String(desc || '').split(' - ')[0], 300);
  }
  return t || '抖音视频';
}

async function douyinBrowserResolve(url, { frames = 0 } = {}) {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dhm-video-douyin-'));
  return withCdpPage({ url, profileDir, timeoutMs: 60000 }, async ({ send, evalJs }) => {
    let status = null;
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      status = await evalJs(`(() => {
        const isBad = (s) => !s || /uuu_\\d+\\.mp4|douyin-pc-web\\/uuu_|^data:/i.test(s);
        const vids = [...document.querySelectorAll('video')].map((v) => ({
          src: v.currentSrc || v.src || '',
          ready: v.readyState || 0,
          duration: Number(v.duration) || 0,
          w: v.videoWidth || 0,
          h: v.videoHeight || 0,
          poster: v.poster || '',
          visible: !!(v.offsetWidth || v.offsetHeight),
        }));
        const usable = vids.filter((x) => !isBad(x.src));
        const primary = usable.find((x) => x.duration > 0 || x.w > 0 || x.ready > 0) || usable[0] || {};
        const visual = [...vids].sort((a, b) => (b.w * b.h) - (a.w * a.h))[0] || {};
        return {
          title: document.title || '',
          href: location.href || '',
          src: primary.src || '',
          ready: primary.ready || 0,
          duration: primary.duration || visual.duration || 0,
          w: primary.w || visual.w || 0,
          h: primary.h || visual.h || 0,
          poster: primary.poster || visual.poster || '',
          hasPlaceholder: vids.some((x) => /uuu_\\d+\\.mp4|douyin-pc-web\\/uuu_/i.test(x.src)),
          loading: /视频数据加载中/.test(document.body?.innerText || ''),
        };
      })()`);
      if (/验证码/.test(status?.title || '')) break;
      if (status?.src) break;
      // 不可用/被删的视频会一直停在“视频数据加载中”，15 秒后直接降级，不干等。
      if (i >= 30 && status?.loading && !status?.title) break;
    }
    if (/验证码/.test(status?.title || '')) {
      return { captcha: true, meta: null, frames: [] };
    }
    const id = extractDouyinId(status?.href || '') || extractDouyinId(url) || '';
    if (!status?.src) {
      return {
        captcha: false,
        meta: id ? await douyinShareMeta(id).catch(() => null) : null,
        frames: [],
        finalUrl: status?.href || url,
      };
    }
    const info = await evalJs(`(() => {
      const isBad = (s) => !s || /uuu_\\d+\\.mp4|douyin-pc-web\\/uuu_|^data:/i.test(s);
      const vids = [...document.querySelectorAll('video')].map((v) => ({
        src: v.currentSrc || v.src || '',
        duration: Number(v.duration) || 0,
        w: v.videoWidth || 0,
        h: v.videoHeight || 0,
        poster: v.poster || '',
      }));
      const usable = vids.filter((x) => !isBad(x.src));
      const primary = usable.find((x) => x.duration > 0 || x.w > 0) || usable[0] || {};
      const visual = [...vids].sort((a, b) => (b.w * b.h) - (a.w * a.h))[0] || {};
      const meta = (n) => document.querySelector('meta[name="' + n + '"],meta[property="' + n + '"]')?.content || '';
      const body = (document.body?.innerText || '').slice(0, 3000);
      const h1 = document.querySelector('h1')?.innerText || '';
      const user = [...document.querySelectorAll('a[href*="/user/"]')]
        .filter((a) => !/\\/user\\/self/.test(a.getAttribute('href') || ''))
        .map((a) => (a.innerText || '').trim())
        .find(Boolean) || '';
      return {
        title: h1 || document.title || '',
        pageTitle: document.title || '',
        desc: meta('description') || meta('og:description') || '',
        cover: primary.poster || visual.poster || meta('og:image') || meta('lark:url:video_cover_image_url') || '',
        author: user,
        src: primary.src || '',
        duration: primary.duration || visual.duration || 0,
        width: primary.w || visual.w || 0,
        height: primary.h || visual.h || 0,
        body,
      };
    })()`);
    const share = id ? await douyinShareMeta(id).catch(() => null) : null;
    const desc = clean(info?.desc || '', 2000) || String(share?.desc || '');
    let title = douyinTitleFromPage(info?.title || '', desc);
    if ((!title || title === '抖音视频' || title === '抖音') && share?.title) title = share.title;
    const browserAuthor = clean(info?.author || '', 80);
    const shareAuthor = clean(share?.author || '', 80);
    // 页面上的作者链接常带“认证徽章/官方账号”等后缀；分享页的 description 里是干净的昵称。
    // 能确认是同一人（页面作者包含分享页昵称）时优先用短的那个。
    const author = shareAuthor && (!browserAuthor || browserAuthor.includes(shareAuthor))
      ? shareAuthor
      : (browserAuthor || shareAuthor);
    const cover = info?.cover || String(share?.cover || '');
    const pageUrl = id ? `https://www.douyin.com/video/${id}` : (status.href || url);
    const isBlob = status.src.startsWith('blob:');
    const meta = {
      platform: 'douyin',
      id,
      title,
      author,
      desc: truncate(desc, 800),
      cover,
      pageUrl,
      videoUrl: isBlob ? '' : status.src,
      downloadHeaders: { 'user-agent': UA, referer: 'https://www.douyin.com/' },
      coverHeaders: { 'user-agent': UA, referer: 'https://www.douyin.com/' },
      duration: Number(info?.duration) || Number(status.duration) || 0,
      width: Number(info?.width) || Number(status.w) || 0,
      height: Number(info?.height) || Number(status.h) || 0,
      note: isBlob
        ? '抖音给的是 blob 播放流，已用浏览器截取画面。'
        : '',
    };
    let shotFrames = [];
    if (isBlob && frames > 0) {
      shotFrames = await captureBlobFrames(send, evalJs, frames);
      if (!shotFrames.length) meta.note = appendNote(meta.note, '浏览器截帧失败，只保留封面。');
    }
    return { captcha: false, meta, frames: shotFrames, finalUrl: status.href || url };
  });
}

async function douyinShareMeta(id) {
  const url = `https://www.iesdouyin.com/share/video/${id}/`;
  const r = await safeFetch(url, 300000, { headers: { 'user-agent': GOOGLEBOT_UA } });
  const html = r.body || '';
  const attr = (name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`<meta[^>]+(?:name|property)=["']${escaped}["'][^>]+content=["']([^"']*)["']`, 'i');
    return decodeEntities(html.match(re)?.[1] || '');
  };
  const desc = attr('description');
  const title = attr('lark:url:video_title') || desc.split(' - ')[0] || `抖音视频 ${id}`;
  const cover = attr('lark:url:video_cover_image_url') || attr('og:image');
  const author = desc.match(/ - (.+?)于[^\s]*发布在抖音/)?.[1] || '';
  return {
    platform: 'douyin',
    id,
    title: douyinTitleFromPage(title, desc),
    author: clean(author, 80),
    desc: truncate(clean(desc, 2000), 800),
    cover,
    pageUrl: `https://www.douyin.com/video/${id}`,
    videoUrl: '',
    downloadHeaders: { 'user-agent': UA, referer: 'https://www.douyin.com/' },
    coverHeaders: { 'user-agent': UA, referer: 'https://www.douyin.com/' },
    duration: 0,
    width: 0,
    height: 0,
    note: '抖音没有返回可匿名下载的视频流，只能看到封面/简介。',
  };
}

export async function resolveDouyin(input, { frames = 0 } = {}) {
  const ref = await resolveDouyinRef(input);
  let browser = null;
  try {
    browser = await douyinBrowserResolve(ref.url, { frames });
  } catch {
    browser = null;
  }
  if (browser?.meta) {
    return { meta: browser.meta, frames: browser.frames || [] };
  }
  const id = ref.id || extractDouyinId(browser?.finalUrl || '') || '';
  if (!id) {
    throw new Error('无法解析这条抖音链接（可能是热榜/用户页/验证码页），请直接发单条视频的分享链接。');
  }
  const meta = await douyinShareMeta(id);
  if (browser?.captcha) meta.note = appendNote(meta.note, '抖音返回了验证码页。');
  return { meta, frames: [] };
}

export async function hotDouyinTopics(limit = 10) {
  const j = await fetchJson(
    'https://www.douyin.com/aweme/v1/web/hot/search/list/?device_platform=webapp&aid=6383&channel=channel_pc_web&detail_list=1',
    { 'user-agent': UA, referer: 'https://www.douyin.com/' }
  );
  const list = Array.isArray(j.data?.word_list) ? j.data.word_list : [];
  return list.slice(0, Math.max(1, Math.min(30, Number(limit) || 10))).map((w) => ({
    platform: 'douyin',
    kind: 'topic',
    id: String(w.sentence_id || ''),
    title: clean(w.word, 200),
    hot: Number(w.hot_value) || 0,
    cover: w.word_cover?.url_list?.[0] || '',
    url: w.sentence_id ? `https://www.douyin.com/hot/${w.sentence_id}` : 'https://www.douyin.com/hot',
    sentenceId: w.sentence_id,
    groupId: w.group_id,
  }));
}

function parseDouyinCard(card) {
  const text = String(card.text || '');
  const lines = text.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  let durationText = String(card.duration || '');
  let likes = '';
  if (lines[0] && /^\d{1,2}:\d{2}$/.test(lines[0])) durationText = lines.shift();
  if (lines[0] && /^[\d.]+万?$/.test(lines[0])) likes = lines.shift();
  const author = clean(card.author || text.match(/@([^\n·]+)/)?.[1] || '', 80);
  let title = lines.join(' ')
    .replace(/@[^\s·]+/g, ' ')
    .replace(/·\s*(?:\d+月\d+日|\d+周前|\d+天前|\d+小时前|\d+分钟前|昨天|前天).*$/, '')
    .replace(/^热点：/, ' ')
    .replace(/\d+(?:\.\d+)?万人在看/g, ' ')
    .replace(/\d+人在看/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  title = clean(title, 300);
  return {
    platform: 'douyin',
    id: String(card.id || ''),
    title: title || `抖音视频 ${card.id || ''}`,
    author,
    url: card.url || (card.id ? `https://www.douyin.com/video/${card.id}` : ''),
    cover: card.cover || '',
    duration: parseDurationText(durationText),
    durationText,
    likes,
    desc: '',
  };
}

/** 抖音热榜页（/hot）会给出带视频 ID 的卡片，这是匿名可用的“刷”入口。 */
export async function feedDouyin(limit = 10) {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dhm-video-hot-'));
  const cards = await withCdpPage({ url: 'https://www.douyin.com/hot', profileDir, timeoutMs: 60000 }, async ({ send, evalJs }) => {
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      const n = await evalJs(`document.querySelectorAll('a[href*="/video/"]').length`);
      if (n > 0) break;
    }
    for (let i = 0; i < 4; i++) {
      try {
        await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 640, y: 450, deltaX: 0, deltaY: 1200 });
      } catch { /* ignore */ }
      await sleep(1500);
    }
    return evalJs(`(() => {
      const seen = new Set();
      const out = [];
      for (const a of document.querySelectorAll('a[href*="/video/"]')) {
        const href = a.getAttribute('href') || '';
        const m = href.match(/\\/video\\/(\\d+)/);
        if (!m || seen.has(m[1])) continue;
        seen.add(m[1]);
        const card = a.closest('li') || a.parentElement?.parentElement || a.parentElement;
        const text = (a.innerText || card?.innerText || '').trim();
        const img = card?.querySelector('img');
        out.push({
          id: m[1],
          href,
          url: 'https://www.douyin.com/video/' + m[1],
          text,
          cover: img?.currentSrc || img?.src || '',
          duration: text.match(/^\\s*(\\d{1,2}:\\d{2})/)?.[1] || '',
          author: text.match(/@([^\\n·]+)/)?.[1]?.trim() || '',
        });
      }
      return out;
    })()`);
  });
  const items = (Array.isArray(cards) ? cards : []).map(parseDouyinCard);
  if (!items.length) {
    throw new Error('抖音热榜页没有解析到视频卡片（可能需要登录/验证码）。');
  }
  return items.slice(0, Math.max(1, Math.min(30, Number(limit) || 10)));
}

export async function searchDouyin(keyword, limit = 10) {
  const q = clean(keyword, 80).toLowerCase();
  if (!q) throw new Error('搜索词为空');
  // 抖音网页搜索匿名访问会撞验证码；这里从热榜视频里按标题/作者过滤。
  const all = await feedDouyin(30);
  const hits = all.filter((v) => `${v.title} ${v.author}`.toLowerCase().includes(q));
  if (hits.length) return hits.slice(0, limit);
  const topics = await hotDouyinTopics(20);
  const topicHits = topics.filter((t) => t.title.toLowerCase().includes(q));
  if (topicHits.length) {
    return topicHits.slice(0, limit).map((t) => ({
      platform: 'douyin',
      kind: 'topic',
      id: t.id,
      title: t.title,
      author: '',
      url: t.url,
      cover: t.cover,
      duration: 0,
      durationText: '',
      likes: t.hot ? String(t.hot) : '',
      desc: '这是热榜话题，点进去是话题页；抖音匿名搜索会撞验证码，建议直接发单条分享链接。',
    }));
  }
  throw new Error('抖音匿名搜索被验证码拦住了，热榜里也没有匹配项。可以直接发抖音分享链接。');
}

// ── YouTube ────────────────────────────────────────────────────────────────

export async function resolveYouTube(input) {
  const raw = firstUrl(input) || String(input ?? '').trim();
  const j = await fetchJson(`https://www.youtube.com/oembed?url=${encodeURIComponent(raw)}&format=json`, {
    'user-agent': UA,
    referer: 'https://www.youtube.com/',
  });
  return {
    platform: 'youtube',
    id: raw,
    title: clean(j.title, 300) || 'YouTube 视频',
    author: clean(j.author_name, 80),
    desc: '',
    cover: j.thumbnail_url || '',
    pageUrl: raw,
    videoUrl: '',
    downloadHeaders: { 'user-agent': UA },
    coverHeaders: { 'user-agent': UA },
    duration: 0,
    width: 0,
    height: 0,
    note: 'YouTube 只取了标题/封面；要抽帧需要另装 yt-dlp。',
  };
}

// ── 抽帧 ───────────────────────────────────────────────────────────────────

export async function extractFrames(videoBuffer, duration, count, ffmpegPath = resolveFfmpeg()) {
  if (!Buffer.isBuffer(videoBuffer) || videoBuffer.length < 1024) {
    throw new Error('视频下载为空');
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dhm-video-frames-'));
  const file = path.join(dir, 'video.mp4');
  try {
    fs.writeFileSync(file, videoBuffer);
    const out = [];
    for (const [i, t] of frameTimestamps(duration, count).entries()) {
      const framePath = path.join(dir, `frame-${i}.jpg`);
      try {
        await execFileAsync(ffmpegPath, [
          '-hide_banner',
          '-loglevel', 'error',
          '-nostdin',
          '-y',
          '-ss', String(Math.max(0, Number(t) || 0)),
          '-i', file,
          '-frames:v', '1',
          '-vf', 'scale=640:-2',
          '-q:v', '4',
          '-f', 'image2',
          framePath,
        ], { timeout: 25000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
        if (fs.existsSync(framePath)) {
          const buf = fs.readFileSync(framePath);
          if (buf.length > 512) out.push(buf);
        }
      } catch {
        // 单帧失败就跳过
      }
    }
    return out;
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ── 对外的“看一条” ─────────────────────────────────────────────────────────

export async function watchVideo(input, { frames = 4, wantFrames = true } = {}) {
  const platform = detectPlatform(input);
  // 非视觉模型不需要下载视频/抽帧；只取标题、简介和封面地址，省带宽也省时间。
  const n = wantFrames ? Math.max(1, Math.min(6, Number(frames) || 4)) : 0;
  let meta;
  let browserFrames = [];
  if (platform === 'bilibili') {
    meta = await resolveBilibili(input);
  } else if (platform === 'douyin') {
    const r = await resolveDouyin(input, { frames: n });
    meta = r.meta;
    browserFrames = r.frames || [];
  } else if (platform === 'youtube') {
    meta = await resolveYouTube(input);
  } else {
    throw new Error('只支持抖音 / B站 / YouTube 链接（直接发单条视频的分享链接）');
  }

  let videoBuffer = null;
  if (n > 0 && meta.videoUrl && !meta.videoUrl.startsWith('blob:')) {
    try {
      const r = await safeFetchBinary(meta.videoUrl, maxDownloadBytes(), { headers: meta.downloadHeaders });
      videoBuffer = r.buffer;
    } catch (e) {
      meta.note = appendNote(meta.note, `视频下载失败：${e.message}`);
    }
  }
  let frameBuffers = browserFrames;
  if (n > 0 && !frameBuffers.length && videoBuffer) {
    try {
      frameBuffers = await extractFrames(videoBuffer, meta.duration, n, resolveFfmpeg());
    } catch (e) {
      meta.note = appendNote(meta.note, `抽帧失败：${e.message}`);
    }
  }
  // 只有「要发图、且没抽到帧」时才需要封面；抽到帧时封面不发送，不必再下载。
  let coverBuffer = null;
  if (wantFrames && !frameBuffers.length && meta.cover) {
    try {
      coverBuffer = (await safeFetchBuffer(meta.cover, 5 * 1024 * 1024, { headers: meta.coverHeaders })).buffer;
    } catch {
      // 封面拿不到不影响文字信息
    }
  }
  return { meta, cover: coverBuffer, frames: frameBuffers };
}

export { fmtDuration, clean };
