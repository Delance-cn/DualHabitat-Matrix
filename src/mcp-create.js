// 画画与动态 MCP server（stdio）—— 模型的「会画画、会发动态」能力入口。
//
// 由 oc-config 注册为 mcpServers['create-safe']（模型 API spawn 本文件）。
// 工具开关在桌面端「对话与人格 → 工具开关 → 创作」组里配（config.socialV2.tools），
// 默认全关（momentList 只读默认开）——用户明确开启后模型才会拿到可用工具。
//
//   qq_draw          文生图（Cloudflare flux → 百炼 wanx → 智谱 CogView 自动降级，见 src/draw.js）
//   qq_send_image    把图库里的图片发到 QQ 聊天（走桥接 /api/socialV2/send-image，全套发送策略在桥接侧把关）
//   qq_post_moment   发 QQ 空间说说（纯文字 / 图文，可设可见权限）
//   qq_list_moments  看自己空间最近的动态列表
//   qq_delete_moment 按 tid 删一条说说（只应删自己发的）
//
// 动态三件套直连 NapCat 的 QQ 空间扩展 action（send_qzone_msg / get_qzone_msg_list /
// delete_qzone_msg），是「自己空间」的操作，不经过聊天白名单；发聊天图片必须走桥接端点
// （白名单 / 静默 / 限频都由桥接把关，MCP 侧绝不自己直发消息）。
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDataRoot } from './data-root.js';
import { generateImage, imageLibraryDir, resolveLibraryFile, drawConfig } from './draw.js';

/** 数据根：config / secrets / state / 图库都跟数据走。 */
const ROOT = resolveDataRoot(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));

const TOOL_DEFAULTS = { draw: false, momentPost: false, momentList: true, momentDelete: false };
const MOMENT_DAILY_DEFAULT = 10;

function getConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')) ?? {};
  } catch {
    return {};
  }
}

/** 工具开关：桌面端没配过时按 TOOL_DEFAULTS（与桥接 loadConfig 的默认保持一致）。 */
function toolEnabled(flag) {
  const tools = getConfig()?.socialV2?.tools;
  const v = tools && typeof tools === 'object' ? tools[flag] : undefined;
  return v === undefined ? TOOL_DEFAULTS[flag] !== false : v !== false;
}

/** 每日用量：state/create-usage.json，跨午夜自动归零。 */
function usagePath() {
  return path.join(ROOT, 'state', 'create-usage.json');
}

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function usageBump(kind, limit) {
  let u = { date: todayStr(), draw: 0, moment: 0 };
  try {
    const raw = JSON.parse(fs.readFileSync(usagePath(), 'utf8'));
    if (raw && raw.date === todayStr()) u = { ...u, ...raw };
  } catch { /* 没有就从头计 */ }
  const used = Number(u[kind] ?? 0);
  if (used >= limit) {
    const err = new Error(`今日${kind === 'draw' ? '出图' : '发动态'}次数已用完（${used}/${limit}），明天再来，或让管理员在设置里调每日上限`);
    err.code = 'DAILY_LIMIT';
    throw err;
  }
  u[kind] = used + 1;
  u.date = todayStr();
  try {
    fs.mkdirSync(path.dirname(usagePath()), { recursive: true });
    fs.writeFileSync(usagePath(), JSON.stringify(u, null, 2));
  } catch { /* 计数失败不挡主流程 */ }
  return { used: u[kind], limit };
}

/** NapCat OneBot HTTP：动作调用（QQ 空间扩展 action 走这里）。 */
async function onebotApi(action, payload) {
  const cfg = getConfig();
  const base = String(cfg?.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const token = String(cfg?.snowluma?.accessToken ?? '').trim();
  const res = await fetch(`${base}/${action}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(payload ?? {}),
    signal: AbortSignal.timeout(60_000)
  });
  const hint = res.status === 426 ? '；HTTP 426 通常表示 httpUrl 指向了 WebSocket 端口，请检查 config.json 的 snowluma.httpUrl 是否为 OneBot HTTP API 地址' : '';
  if (!res.ok) throw new Error(`HTTP ${res.status}${hint}`);
  const body = await res.json().catch(() => null);
  if (body?.status !== 'ok' || body?.retcode !== 0) {
    throw new Error(`OneBot ${action} 失败: retcode=${body?.retcode} ${body?.wording ?? body?.message ?? ''}`.trim());
  }
  return body.data;
}

/** 桥接控制台通道（管理端）：发图走桥接端点，白名单/静默/限频由桥接把关。 */
async function bridgeSendImage(key, file, caption) {
  const cfg = getConfig();
  const port = Number(cfg?.consolePort) || 3100;
  let consoleToken = '';
  try {
    if (cfg?.consoleToken) consoleToken = String(cfg.consoleToken);
  } catch {}
  if (!consoleToken) {
    try {
      consoleToken = fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim();
    } catch { /* 读不到就让桥接拒绝 */ }
  }
  const res = await fetch(`http://127.0.0.1:${port}/api/socialV2/send-image`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(consoleToken ? { 'x-console-token': consoleToken } : {})
    },
    body: JSON.stringify({ key, file, caption }),
    signal: AbortSignal.timeout(60_000)
  });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok || body?.ok === false) {
    const msg = body?.error ?? `HTTP ${res.status}`;
    throw new Error(String(msg));
  }
  return body;
}

function errorText(error) {
  return error?.message ?? String(error);
}

const server = new McpServer({ name: 'create-safe', version: '0.1.0' });

server.tool(
  'qq_draw',
  '画一张图：按文字描述生成图片，存进图库。可选直接发到某个 QQ 聊天。每次作画消耗出图额度（有每日上限）。',
  {
    prompt: z.string().min(1).describe('画面描述，越具体越好（主体 / 场景 / 风格）'),
    send_to: z.string().optional().describe("可选，生成后立即发到这个聊天，格式 group:群号 或 private:QQ号"),
    size: z.string().optional().describe("可选，图的尺寸 宽x高，如 1024x1024（默认）、1280x720、720x1280"),
    provider: z.string().optional().describe("可选，指定出图引擎 cloudflare / bailian / zhipu（默认 auto 自动降级）")
  },
  async ({ prompt, send_to, size, provider }) => {
    try {
      if (!toolEnabled('draw')) {
        return { content: [{ type: 'text', text: '作画功能没开：管理员还没在「工具开关 → 创作」里启用画画。不要重试，正常打字回应即可。' }] };
      }
      const cfg = drawConfig();
      const usage = usageBump('draw', cfg.dailyLimit);
      const r = await generateImage(prompt, { provider, size });
      const libDir = imageLibraryDir();
      const name = path.relative(libDir, r.path).split(path.sep).join('/');
      let sentNote = '';
      if (send_to) {
        if (!/^(group|private):\d+$/.test(String(send_to).trim())) {
          return { content: [{ type: 'text', text: `图已生成（${name}），但 send_to 格式不对：应为 group:群号 或 private:QQ号，收到「${send_to}」。可以先只交图，或改对格式再发。` }] };
        }
        const sent = await bridgeSendImage(String(send_to).trim(), name, '');
        sentNote = `；已发到 ${send_to}（消息 id ${sent.messageId ?? '未知'}）`;
      }
      return { content: [{ type: 'text', text: `画好了：${name}（引擎 ${r.provider}，${Math.round(r.bytes / 1024)} KB）${sentNote}。今日出图 ${usage.used}/${usage.limit}。` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `作画失败：${errorText(error)}` }] };
    }
  }
);

server.tool(
  'qq_send_image',
  '把图库里已有的一张图片发到 QQ 聊天（私聊或群）。图库在桌面端「画画与动态」面板管理。',
  {
    key: z.string().describe('目标，格式 group:群号 或 private:QQ号'),
    file: z.string().describe('图库内的文件名（qq_draw 的返回里带）'),
    caption: z.string().optional().describe('可选，图片附带的一句话')
  },
  async ({ key, file, caption }) => {
    try {
      if (!toolEnabled('draw')) {
        return { content: [{ type: 'text', text: '发图功能没开：管理员还没在「工具开关 → 创作」里启用画画（发图归在画画里）。' }] };
      }
      if (!/^(group|private):\d+$/.test(String(key).trim())) {
        return { content: [{ type: 'text', text: 'key 格式应为 group:群号 或 private:QQ号' }] };
      }
      if (!resolveLibraryFile(file)) {
        return { content: [{ type: 'text', text: `图库里没有「${file}」。文件名要从图库列表里来，不要自己拼路径。` }] };
      }
      const sent = await bridgeSendImage(String(key).trim(), String(file).trim(), caption ? String(caption).slice(0, 500) : '');
      return { content: [{ type: 'text', text: `已把 ${file} 发到 ${key}（消息 id ${sent.messageId ?? '未知'}）。` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发图失败：${errorText(error)}` }] };
    }
  }
);

server.tool(
  'qq_post_moment',
  '发一条 QQ 空间说说（纯文字或图文）。可见权限默认所有人可见，发之前想清楚内容是否合适；有每日条数上限。',
  {
    content: z.string().min(1).describe('说说正文'),
    images: z.array(z.string()).optional().describe('可选，配图文件名数组（必须是图库里的文件，qq_draw 画出来的可以直接用）'),
    ugc_right: z.number().optional().describe('可选，可见权限：1 所有人可见（默认）/ 4 好友可见 / 16 部分好友可见 / 64 仅自己可见'),
    target_uins: z.array(z.union([z.number(), z.string()])).optional().describe('ugc_right 为 16 时，可见的 QQ 号列表')
  },
  async ({ content, images, ugc_right, target_uins }) => {
    try {
      if (!toolEnabled('momentPost')) {
        return { content: [{ type: 'text', text: '发动态功能没开：管理员还没在「工具开关 → 创作」里启用发说说。不要重试。' }] };
      }
      const cfg = getConfig();
      const limit = Number(cfg?.socialV2?.draw?.momentDailyLimit) || MOMENT_DAILY_DEFAULT;
      const usage = usageBump('moment', limit);
      const right = ugc_right === undefined ? 1 : Number(ugc_right);
      if (![1, 4, 16, 64, 128].includes(right)) {
        return { content: [{ type: 'text', text: 'ugc_right 只能是 1 / 4 / 16 / 64 / 128' }] };
      }
      const libs = (images ?? []).map((n) => resolveLibraryFile(n));
      if (libs.some((x) => !x)) {
        return { content: [{ type: 'text', text: '配图必须用图库里的文件名（qq_draw 返回的名字），不要自己拼路径' }] };
      }
      const payload = { content: String(content).slice(0, 2000), ugc_right: right };
      if (libs.length) payload.images = libs;
      if (right === 16) {
        if (!target_uins?.length) return { content: [{ type: 'text', text: 'ugc_right=16（部分好友可见）必须给 target_uins' }] };
        payload.target_uins = target_uins;
      }
      const data = await onebotApi('send_qzone_msg', payload);
      const tid = data?.tid ?? data?.tid_str ?? null;
      // 记一笔自己发过的动态（删错兜底用）
      try {
        const logFile = path.join(ROOT, 'state', 'create-posted.json');
        const arr = JSON.parse(fs.readFileSync(logFile, 'utf8'));
        arr.push({ tid: tid ? String(tid) : null, time: Date.now(), head: String(content).slice(0, 60) });
        fs.writeFileSync(logFile, JSON.stringify(arr.slice(-50), null, 2));
      } catch { /* 首次写入结构不同时重建 */ }
      return { content: [{ type: 'text', text: `说说已发出${tid ? `（tid ${tid}）` : ''}。今日发动态 ${usage.used}/${usage.limit}。` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发说说失败：${errorText(error)}` }] };
    }
  }
);

server.tool(
  'qq_list_moments',
  '看 BOT 自己 QQ 空间最近的动态列表（含 tid，配合删除用）。只读。',
  {},
  async () => {
    try {
      if (!toolEnabled('momentList')) {
        return { content: [{ type: 'text', text: '看动态功能没开：管理员还没在「工具开关 → 创作」里启用。' }] };
      }
      const data = await onebotApi('get_qzone_msg_list', {});
      const arr = Array.isArray(data) ? data : (data?.list ?? data?.msglist ?? []);
      if (!arr.length) return { content: [{ type: 'text', text: '空间里最近没有动态（或没读到）。' }] };
      const lines = arr.slice(0, 20).map((m, i) => {
        const tid = m?.tid ?? m?.tid_str ?? '?';
        const text = String(m?.content ?? m?.summary ?? m?.text ?? '').slice(0, 80).replace(/\s+/g, ' ');
        const pics = Array.isArray(m?.pics) ? `，配图 ${m.pics.length} 张` : '';
        return `${i + 1}. [${tid}] ${text}${pics}`;
      });
      return { content: [{ type: 'text', text: `最近动态：\n${lines.join('\n')}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `读动态失败：${errorText(error)}` }] };
    }
  }
);

server.tool(
  'qq_delete_moment',
  '删除一条自己 QQ 空间的说说（按 tid）。删除不可恢复，只删自己发的；拿不准时先用 qq_list_moments 核对。',
  {
    tid: z.string().describe('说说的 tid（来自 qq_post_moment 的返回或 qq_list_moments 列表）')
  },
  async ({ tid }) => {
    try {
      if (!toolEnabled('momentDelete')) {
        return { content: [{ type: 'text', text: '删动态功能没开：管理员还没在「工具开关 → 创作」里启用。' }] };
      }
      const id = String(tid ?? '').trim();
      if (!id) return { content: [{ type: 'text', text: '缺少 tid：先用 qq_list_moments 查到要删的那条' }] };
      await onebotApi('delete_qzone_msg', { tid: id });
      return { content: [{ type: 'text', text: `已删除说说 ${id}。` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `删除失败：${errorText(error)}` }] };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
