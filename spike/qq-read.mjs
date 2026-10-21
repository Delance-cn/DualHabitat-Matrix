// 只读「收件箱」：把某个好友最近发来的消息拉出来看。
//
// 为什么要这个：桥没在跑的时候，WS 事件没人收就等于丢掉了；
// 但 NapCat 有 get_friend_msg_history，可以直接回读。
// 排查「用户发的消息为什么没被处理」时，第一件事就是确认消息**到底有没有到网关切**。
//
// 边界（L6 铁律）：**只读**。不安装、不启动、不停止网关/QQ。
// 只调 get_friend_list / get_friend_msg_history 这类只读 action。
//
// 跑法：
//   node spike/qq-read.mjs                      # 读 config.json 的 allow.private[0] 的历史
//   node spike/qq-read.mjs --to <QQ号> --count 20
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { discoverSnowLumaConnection } from '../src/snowluma-conn.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfgFile = path.join(ROOT, 'config.json');
const cfg = fs.existsSync(cfgFile) ? JSON.parse(fs.readFileSync(cfgFile, 'utf8')) : {};

const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};
const count = Number(arg('--count') ?? 15);

const disc = await discoverSnowLumaConnection({ cfg });
if (!disc.ok) {
  console.log('网关不可达，没法读历史。');
  console.log(JSON.stringify({ error: disc.error, tried: disc.tried }, null, 2));
  process.exit(2);
}
console.log(`端点：${disc.baseUrl}   本机账号：${disc.self?.user_id} ${disc.self?.nickname ?? ''}`);

const call = async (action, body) => {
  const res = await fetch(`${disc.baseUrl}/${action}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(disc.token ? { authorization: `Bearer ${disc.token}` } : {})
    },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(15000)
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

let to = arg('--to') ?? cfg?.allow?.private?.[0] ?? null;
if (!to) {
  const fr = await call('get_friend_list');
  const list = fr.body?.data ?? [];
  console.log('好友列表：', list.map((f) => `${f.user_id}/${f.nickname ?? ''}`).join(', ') || '(空)');
  if (list.length === 1) to = list[0].user_id;
}
if (!to) {
  console.log('没有 --to，且无法唯一确定对端。请显式指定 --to。');
  process.exit(3);
}

/**
 * 把 OneBot 的 message 段渲染成人能读的一行。
 *
 * NapCat 配了 messagePostFormat:"array"，所以 message 是段数组；
 * 但历史接口有时回的是 CQ 码字符串，两种都兜住。
 */
function renderSegments(message, raw) {
  const arr = Array.isArray(message)
    ? message
    : typeof message === 'string' && message
      ? [{ type: 'text', data: { text: message } }]
      : [];
  if (!arr.length) return raw ? `(原始) ${String(raw).slice(0, 200)}` : '(空)';
  return arr
    .map((s) => {
      if (s.type === 'text') return s.data?.text ?? '';
      if (s.type === 'image') {
        const d = s.data ?? {};
        return `[图片 url=${String(d.url ?? d.file ?? '').slice(0, 120)} ${d.sub_type ? `sub=${d.sub_type} ` : ''}]`;
      }
      if (s.type === 'face') return `[表情 id=${s.data?.id}]`;
      if (s.type === 'mface') return `[市场表情 ${String(s.data?.summary ?? s.data?.emoji_id ?? '')}]`;
      if (s.type === 'record') return `[语音 url=${String(s.data?.url ?? s.data?.file ?? '').slice(0, 80)}]`;
      if (s.type === 'video') return `[视频 url=${String(s.data?.url ?? s.data?.file ?? '').slice(0, 80)}]`;
      if (s.type === 'file') return `[文件 ${String(s.data?.name ?? '')} ${String(s.data?.file ?? '').slice(0, 60)}]`;
      if (s.type === 'at') return `@${s.data?.qq}`;
      if (s.type === 'reply') return `[回复 ${s.data?.id}]`;
      return `[${s.type} ${JSON.stringify(s.data ?? {}).slice(0, 100)}]`;
    })
    .join('');
}

const hist = await call('get_friend_msg_history', { user_id: Number(to), count, reverseOrder: false });
if (hist.body?.status !== 'ok') {
  console.log(`\nget_friend_msg_history 失败：${JSON.stringify(hist.body).slice(0, 400)}`);
  process.exit(4);
}

/**
 * 把图片段下载到本地。
 *
 * 为什么桥最终也要有这一步：QQ 的图片只是**一个带 rkey 的临时 URL**，
 * 模型没法直接「看」URL，必须先落到磁盘再作为图片内容喂进去。
 * rkey 有有效期，所以收到后要尽快下载，不能留到用的时候才拉。
 */
const saveImages = argv.includes('--save-images');
const outDir = path.join(ROOT, 'spike', 'out', 'inbox');
if (saveImages) fs.mkdirSync(outDir, { recursive: true });
async function saveImage(data, seq) {
  const url = data?.url || data?.file;
  if (!url || !/^https?:\/\//.test(url)) {
    console.log(`   ⚠️ 图片没有可用 http url（file=${String(data?.file).slice(0, 60)}）`);
    return null;
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) {
    console.log(`   ⚠️ 下载失败 HTTP ${res.status}`);
    return null;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const base = (String(data?.file || 'image').replace(/[^\w.-]/g, '_') || 'image').slice(-60);
  const file = path.join(outDir, `${seq}-${base.endsWith('.jpg') || base.endsWith('.png') ? base : `${base}.jpg`}`);
  fs.writeFileSync(file, buf);
  console.log(`   💾 已存 ${file}  (${buf.length} 字节)`);
  return file;
}

const msgs = hist.body?.data?.messages ?? hist.body?.data ?? [];
console.log(`\n最近 ${msgs.length} 条与 ${to} 的往返（旧 → 新）：\n`);
const selfId = String(disc.self?.user_id ?? '');
let seq = 0;
for (const m of msgs) {
  seq += 1;
  const who = String(m.sender?.user_id ?? m.user_id ?? '');
  const dir = who === selfId ? '我 →' : '他 →';
  const when = m.time ? new Date(Number(m.time) * 1000).toLocaleString('zh-CN', { hour12: false }) : '';
  console.log(`${dir} ${when}`);
  console.log(`   ${renderSegments(m.message, m.raw_message)}`);
  if (argv.includes('--raw')) console.log(`   ↳ 原始: ${JSON.stringify(m).slice(0, 1200)}`);
  if (Array.isArray(m.message)) {
    for (const s of m.message) {
      if (s.type === 'image') {
        console.log(`   ↳ 图片原始字段: ${JSON.stringify(s.data).slice(0, 300)}`);
        if (saveImages) await saveImage(s.data, seq);
      }
    }
  }
  console.log('');
}
process.exit(0);
