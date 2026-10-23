// 文生图：把一句描述合成本地图片文件，QQ 侧可发进聊天、可发 QQ 空间说说。
//
// 引擎与 auto 顺序（从前往后试，哪个成用哪个，失败原因打日志）：
//   cloudflare — Cloudflare Workers AI 的 flux-1-schnell（免费额度、速度快，本机实测可用）。
//                走官方 REST，返回 base64 JPEG。
//   bailian    — 阿里百炼 wanx2.1-t2i-turbo（异步任务：提交 → 轮询 → 拿临时 URL 下载）。
//                本机实测可用；免费额度按张计，限流时自动落下一家。
//   zhipu      — 智谱 CogView-3-Flash（免费模型）。槽位预留：本机 key 当前 401 失效，
//                换新 key 后 auto 会自动把它纳入降级链。
//
// key 来源：数据根 secrets.json（CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID /
// BAILIAN_API_KEY / ZHIPU_API_KEY）。配置：config.socialV2.draw = { provider, size, dailyLimit, dir }。
// 图片落点：调用方给 outDir（默认数据根的图库 images/ 下）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolveDataRoot } from './data-root.js';

export const DRAW_PROVIDERS = ['auto', 'cloudflare', 'bailian', 'zhipu'];
export const DRAW_DEFAULTS = {
  provider: 'auto',
  size: '1024x1024',
  dailyLimit: 30,
  dir: 'images'
};

const CODE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_ROOT = resolveDataRoot(CODE_ROOT);
const MAX_PROMPT_CHARS = 1000;
const BAILIAN_POLL_INTERVAL_MS = 5000;
const BAILIAN_POLL_MAX = 24; // 2 分钟

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

export function drawConfig() {
  const cfg = readJson(path.join(DATA_ROOT, 'config.json'));
  const d = cfg?.socialV2?.draw && typeof cfg.socialV2.draw === 'object' ? cfg.socialV2.draw : {};
  const provider = String(d.provider ?? '');
  return {
    provider: DRAW_PROVIDERS.includes(provider) || (provider.startsWith('custom:') && CUSTOM_DRAW_ID_RE.test(provider.slice(7)))
      ? provider
      : 'auto',
    size: /^\d{3,4}x\d{3,4}$/.test(String(d.size ?? '')) ? d.size : DRAW_DEFAULTS.size,
    dailyLimit: Number.isFinite(+d.dailyLimit) && +d.dailyLimit > 0 ? +d.dailyLimit : DRAW_DEFAULTS.dailyLimit,
    dir: typeof d.dir === 'string' && d.dir.trim() ? d.dir.trim() : DRAW_DEFAULTS.dir
  };
}

export function imageLibraryDir() {
  return path.resolve(DATA_ROOT, drawConfig().dir);
}

/** 解析图库内的文件名 → 绝对路径（防目录穿越；不存在返回 null）。 */
export function resolveLibraryFile(name) {
  const base = path.basename(String(name ?? '')).trim();
  if (!base || !/\.(png|jpe?g|webp|gif)$/i.test(base)) return null;
  const lib = imageLibraryDir();
  const full = path.resolve(lib, base);
  if (!full.startsWith(lib + path.sep) || !fs.existsSync(full)) return null;
  return full;
}

function cleanPrompt(text) {
  const clean = String(text ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim();
  if (!clean) throw new Error('没有要画的内容：写一句画面描述');
  return clean.length > MAX_PROMPT_CHARS ? clean.slice(0, MAX_PROMPT_CHARS) : clean;
}

function parseSize(size) {
  const m = /^(\d{3,4})x(\d{3,4})$/.exec(String(size ?? '').trim());
  if (!m) throw new Error(`size 格式应为 宽x高（如 1024x1024），收到：${size}`);
  const w = Math.min(1440, Math.max(256, +m[1]));
  const h = Math.min(1440, Math.max(256, +m[2]));
  return { w, h };
}

function saveImage(buf, outDir, ext) {
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const file = path.join(outDir, `draw-${stamp}-${crypto.randomBytes(3).toString('hex')}.${ext}`);
  fs.writeFileSync(file, buf);
  return file;
}

/** Cloudflare Workers AI flux-1-schnell：JSON 请求 → result.image (base64 JPEG)。 */
async function drawCloudflare(prompt, outPath, { w, h }) {
  const secrets = readJson(path.join(DATA_ROOT, 'secrets.json'));
  const account = String(secrets.CLOUDFLARE_ACCOUNT_ID ?? '').trim();
  const token = String(secrets.CLOUDFLARE_API_TOKEN ?? secrets.CLOUDFLARE_API_KEY ?? '').trim();
  if (!account || !token) throw new Error('secrets.json 缺 CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN');
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/@cf/black-forest-labs/flux-1-schnell`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    // flux-1-schnell 不收 width/height（传了直接 400），输出固定尺寸；size 只对 bailian/zhipu 生效
    body: JSON.stringify({ prompt, steps: 4 }),
    signal: AbortSignal.timeout(90_000)
  });
  const body = await res.json().catch(() => null);
  const b64 = body?.result?.image;
  if (!res.ok || !body?.success || !b64) {
    throw new Error(`HTTP ${res.status} ${body?.errors?.[0]?.message ?? ''}`.trim());
  }
  const buf = Buffer.from(b64, 'base64');
  if (buf.length < 5000) throw new Error('返回空图片（多半被限流）');
  fs.writeFileSync(outPath, buf);
}

/** 阿里百炼 wanx：异步任务（提交 → 轮询 → 下载临时 URL 的 PNG）。 */
async function drawBailian(prompt, outPath, { w, h }) {
  const secrets = readJson(path.join(DATA_ROOT, 'secrets.json'));
  const key = String(secrets.BAILIAN_API_KEY ?? '').trim();
  if (!key) throw new Error('secrets.json 缺 BAILIAN_API_KEY');
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${key}`, 'X-DashScope-Async': 'enable' };
  const res = await fetch('https://dashscope.aliyuncs.com/api/v1/services/aigc/text2image/image-synthesis', {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: 'wanx2.1-t2i-turbo', input: { prompt }, parameters: { size: `${w}*${h}`, n: 1 } }),
    signal: AbortSignal.timeout(30_000)
  });
  const created = await res.json().catch(() => null);
  const taskId = created?.output?.task_id;
  if (!res.ok || !taskId) {
    throw new Error(`HTTP ${res.status} ${created?.message ?? created?.code ?? ''}`.trim());
  }
  let url = null;
  let status = '';
  for (let i = 0; i < BAILIAN_POLL_MAX && !url; i++) {
    await new Promise((r) => setTimeout(r, BAILIAN_POLL_INTERVAL_MS));
    const poll = await fetch(`https://dashscope.aliyuncs.com/api/v1/tasks/${taskId}`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(20_000)
    });
    const pj = await poll.json().catch(() => null);
    status = pj?.output?.task_status ?? '?';
    if (status === 'FAILED' || status === 'CANCELED' || status === 'UNKNOWN') {
      throw new Error(`任务 ${status}：${pj?.output?.message ?? '无说明'}`);
    }
    url = pj?.output?.results?.[0]?.url ?? null;
  }
  if (!url) throw new Error(`任务超时未完成（最后状态 ${status}）`);
  const img = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  const buf = Buffer.from(await img.arrayBuffer());
  if (buf.length < 5000) throw new Error('任务完成但图片下载为空');
  fs.writeFileSync(outPath, buf);
}

/** 智谱 CogView-3-Flash（免费模型；本机 key 失效时 auto 自动跳过）。 */
async function drawZhipu(prompt, outPath, { w, h }) {
  const secrets = readJson(path.join(DATA_ROOT, 'secrets.json'));
  const key = String(secrets.ZHIPU_API_KEY ?? '').trim();
  if (!key) throw new Error('secrets.json 缺 ZHIPU_API_KEY');
  const res = await fetch('https://open.bigmodel.cn/api/paas/v4/images/generations', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: 'cogview-3-flash', prompt, size: `${w}x${h}` }),
    signal: AbortSignal.timeout(60_000)
  });
  const body = await res.json().catch(() => null);
  const url = body?.data?.[0]?.url;
  if (!res.ok || !url) {
    throw new Error(`HTTP ${res.status} ${body?.error?.message ?? ''}`.trim());
  }
  const img = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  const buf = Buffer.from(await img.arrayBuffer());
  if (buf.length < 5000) throw new Error('返回空图片');
  fs.writeFileSync(outPath, buf);
}

const ENGINES = {
  cloudflare: { ext: 'jpg', run: drawCloudflare },
  bailian: { ext: 'png', run: drawBailian },
  zhipu: { ext: 'jpeg', run: drawZhipu }
};

/* ── 自定义出图服务（OpenAI 兼容 /images/generations） ─────────────────── */
// 预设只有 cloudflare / bailian / zhipu，想接硅基流动、Together、自建网关……
// 在 config.socialV2.draw.custom 里加一条：{ id, label, baseUrl, model, apiKeyEnv, sizeTemplate }
// key 只从 secrets.json / 进程环境读，不写进 config.json。
export const CUSTOM_DRAW_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/i;

export function normalizeCustomDraw(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id ?? '').trim();
  if (!CUSTOM_DRAW_ID_RE.test(id)) return null;
  const baseUrl = String(raw.baseUrl ?? '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s]+$/i.test(baseUrl)) return null;
  const model = String(raw.model ?? '').trim();
  if (!model || model.length > 120) return null;
  const apiKeyEnv = String(raw.apiKeyEnv ?? '').trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(apiKeyEnv)) return null;
  const sizeTemplate = String(raw.sizeTemplate ?? '{w}x{h}').trim();
  if (!sizeTemplate.includes('{w}') || !sizeTemplate.includes('{h}') || sizeTemplate.length > 40) return null;
  return {
    id,
    label: String(raw.label ?? '').trim().slice(0, 40) || id,
    baseUrl,
    model,
    apiKeyEnv,
    sizeTemplate,
    format: ['png', 'jpg', 'jpeg', 'webp'].includes(String(raw.format ?? '').toLowerCase())
      ? String(raw.format).toLowerCase()
      : 'png'
  };
}

export function readCustomDrawEngines() {
  const cfg = readJson(path.join(DATA_ROOT, 'config.json'));
  const list = cfg?.socialV2?.draw?.custom;
  return Array.isArray(list) ? list.map(normalizeCustomDraw).filter(Boolean) : [];
}

async function drawCustom(prompt, outPath, { w, h }, engine) {
  const secrets = readJson(path.join(DATA_ROOT, 'secrets.json'));
  const key = String(secrets[engine.apiKeyEnv] ?? process.env[engine.apiKeyEnv] ?? '').trim();
  if (!key) throw new Error(`secrets.json 缺 ${engine.apiKeyEnv}（自定义出图服务用这个环境变量名取 key）`);
  const size = engine.sizeTemplate.replaceAll('{w}', String(w)).replaceAll('{h}', String(h));
  const res = await fetch(`${engine.baseUrl}/images/generations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: engine.model,
      prompt,
      size,
      n: 1,
      response_format: 'b64_json'
    }),
    signal: AbortSignal.timeout(120_000)
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${body?.error?.message ?? body?.message ?? ''}`.trim());
  }
  const item = body?.data?.[0];
  let buf = null;
  if (item?.b64_json) {
    buf = Buffer.from(String(item.b64_json), 'base64');
  } else if (item?.url) {
    // 有些服务只回 URL：下载下来再存（QQ 发送要本地文件）。
    const img = await fetch(String(item.url), { signal: AbortSignal.timeout(120_000) });
    if (!img.ok) throw new Error(`图片下载失败：HTTP ${img.status}`);
    buf = Buffer.from(await img.arrayBuffer());
  }
  if (!buf || buf.length < 5000) throw new Error('返回空图片（检查模型名 / 额度）');
  fs.writeFileSync(outPath, buf);
}

/**
 * 生成一张图片。
 * @param {string} prompt 画面描述
 * @param {{ outDir?: string, provider?: string, size?: string }} opts
 * @returns {Promise<{path: string, provider: string, bytes: number}>}
 */
export async function generateImage(prompt, opts = {}) {
  const clean = cleanPrompt(prompt);
  const cfg = drawConfig();
  const want = String(opts.provider || cfg.provider || 'auto').toLowerCase();
  const engines = { ...ENGINES };
  for (const c of readCustomDrawEngines()) {
    engines[`custom:${c.id}`] = { ext: c.format, run: (p, o, size) => drawCustom(p, o, size, c) };
  }
  const order = want === 'auto' ? ['cloudflare', 'bailian', 'zhipu'] : [want];
  if (!order.every((p) => engines[p])) throw new Error(`未知出图引擎：${want}`);
  const outDir = opts.outDir || imageLibraryDir();
  fs.mkdirSync(outDir, { recursive: true });
  const { w, h } = parseSize(opts.size || cfg.size);

  const errors = [];
  for (const provider of order) {
    const spec = engines[provider];
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const outPath = path.join(outDir, `draw-${stamp}-${crypto.randomBytes(3).toString('hex')}.${spec.ext}`);
    try {
      await spec.run(clean, outPath, { w, h });
      const bytes = fs.statSync(outPath).size;
      if (bytes < 5000) throw new Error('合成结果为空图片');
      return { path: outPath, provider, bytes };
    } catch (err) {
      try { fs.rmSync(outPath, { force: true }); } catch {}
      errors.push(`${provider}: ${err?.message ?? err}`);
      if (want !== 'auto') throw new Error(`出图（${provider}）失败：${err?.message ?? err}`);
    }
  }
  throw new Error(`所有出图引擎都失败了 —— ${errors.join('；')}`);
}
