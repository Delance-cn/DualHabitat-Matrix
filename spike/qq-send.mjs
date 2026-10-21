// 发一条 QQ 私聊消息（走 SnowLuma 的 OneBot v11 HTTP API）。
//
// 边界：**只发消息**。不安装、不启动、不停止 SnowLuma / QQ（L6 铁律 + EULA §5.4）。
// 端点与 token 交给 src/snowluma-conn.js 自发现（换账号后 token 会变，硬编码必 401）。
//
// 跑法：
//   node spike/qq-send.mjs --to <QQ号> --text "你好"
//   node spike/qq-send.mjs --text "你好"      # 收件人：config.json 的 allow.private[0]，或好友列表里唯一的好友
//   node spike/qq-send.mjs --to <QQ号> --file essay.txt   # 正文从 UTF-8 文件读（长文本/带换行时用这个）
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

let to = arg('--to') ?? cfg?.allow?.private?.[0] ?? null;
// 长文本/带换行的正文走 --file，避免被 shell 的引号与换行处理吃掉。
const textFile = arg('--file');
const text =
  (textFile ? fs.readFileSync(path.resolve(ROOT, textFile), 'utf8') : null) ??
  arg('--text') ??
  `【桥接自测】小号 → 大号，OneBot 发送链路 OK。时间 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}` +
    '（收到即说明「发」这条路通了；「收 + 自动回复」还要等移植完成）';
const waitSec = Number(arg('--wait') ?? 0);

/**
 * 等网关上线（可选）。
 *
 * 早停判别很重要：只有"连不上"才值得继续等；如果探测拿到了明确的 HTTP 应答，
 * 说明网关**已经在跑**，只是配置不对（401 = token 不对 / 426 = 填成了 WS 端口），
 * 这时继续等永远等不到结果，应当立刻报错并指出怎么修。
 */
async function discoverWithWait() {
  if (!(waitSec > 0)) return discoverSnowLumaConnection({ cfg });
  const deadline = Date.now() + waitSec * 1000;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    const d = await discoverSnowLumaConnection({ cfg });
    if (d.ok) return d;
    const statuses = (d.tried ?? []).map((t) => t.status).filter(Boolean);
    if (statuses.includes(401)) {
      console.log('\n❌ 网关在跑，但所有候选 token 都被拒（401）。');
      console.log('   HTTP 的 accessToken 与 WebSocket 的不是同一个，且按账号存在');
      console.log('   <SnowLuma>/config/onebot_<QQ号>.json 里。请在 config.json 里填 snowluma.homeDir');
      console.log('   （例如 "C:\\\\SnowLuma"），让桥接自己去读。');
      process.exit(5);
    }
    if (statuses.includes(426)) {
      console.log('\n❌ 网关在跑，但 snowluma.httpUrl 指向了 WebSocket 端口（HTTP 426）。');
      console.log('   httpUrl 要填 OneBot **HTTP API** 端口（默认 3000），不是 WS 的 3001。');
      process.exit(6);
    }
    if (Date.now() > deadline) {
      console.log(`\n⏳ 等待 ${waitSec}s 后网关仍未上线，放弃。`);
      process.exit(2);
    }
    if (attempt === 1 || attempt % 20 === 0) {
      console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] 等待 SnowLuma OneBot API…（第 ${attempt} 次）`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

const disc = await discoverWithWait();
console.log(
  '端点发现：',
  JSON.stringify(
    {
      ok: disc.ok,
      baseUrl: disc.baseUrl,
      source: disc.source,
      self: disc.self,
      error: disc.error,
      tried: disc.tried
    },
    null,
    2
  )
);
if (!disc.ok) {
  console.log('\n网关不可达，未发送任何消息。');
  process.exit(2);
}

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

if (!to) {
  const fr = await call('get_friend_list');
  const list = fr.body?.data ?? [];
  console.log('好友列表：', list.map((f) => `${f.user_id}/${f.nickname ?? ''}`).join(', ') || '(空)');
  if (list.length === 1) to = list[0].user_id;
}
if (!to) {
  console.log('没有 --to，且无法从好友列表唯一确定收件人。请显式指定 --to。');
  process.exit(3);
}

console.log(`\n发送私聊 → ${to}：${text}`);
const out = await call('send_private_msg', { user_id: Number(to), message: text });
console.log('应答：', JSON.stringify(out, null, 2));
process.exit(out.status === 200 && out.body?.status === 'ok' ? 0 : 4);
