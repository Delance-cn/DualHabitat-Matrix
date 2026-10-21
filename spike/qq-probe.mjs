// QQ / SnowLuma（OneBot 11）只读探针：**只探测、不发消息、不启停任何进程**。
//
// 设计不变量 L6（见项目文档）：QSH 只探测、不部署 —— 永不安装/复制/打包/自动部署
// SnowLuma 及其原生组件，也不程序化启停其进程。网关不可达时给出可操作提示即可。
//
// 跑法：node spike/qq-probe.mjs [httpUrl]
// 默认按 config.json 的 snowluma.httpUrl，其次 http://127.0.0.1:3000。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadConfig() {
  const file = path.join(ROOT, 'config.json');
  if (!fs.existsSync(file)) {
    console.log('[config] 没有 config.json，按 config.example.json 的默认值走（snowluma.httpUrl=http://127.0.0.1:3000）');
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.log(`[config] config.json 解析失败：${e.message}`);
    return {};
  }
}

const cfg = loadConfig();
const token = String(cfg?.snowluma?.accessToken ?? '');
const candidates = [
  process.argv[2],
  cfg?.snowluma?.httpUrl,
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3001'
].filter(Boolean);

const call = async (base, action, body) => {
  const url = `${String(base).replace(/\/+$/, '')}/${action}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(url, {
      method: body ? 'POST' : 'GET',
      signal: ctrl.signal,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* 非 JSON（例如 426 WebSocket 端点） */
    }
    return { status: res.status, json, text: text.slice(0, 200) };
  } catch (e) {
    return { error: e?.message ?? String(e) };
  } finally {
    clearTimeout(timer);
  }
};

let hit = null;
for (const base of candidates) {
  const r = await call(base, 'get_login_info');
  const tag = r.error ? `连不上（${r.error}）` : `HTTP ${r.status} ${JSON.stringify(r.json ?? r.text).slice(0, 160)}`;
  console.log(`[探测] ${base}/get_login_info → ${tag}`);
  if (!r.error && r.status === 200 && r.json?.status !== 'failed') {
    hit = base;
    break;
  }
}

if (!hit) {
  console.log('\n结论：没有可达的 OneBot HTTP 网关。');
  console.log('提示：SnowLuma 需要你自己启动（本程序不代装、不代启）。');
  console.log('     启动后确认它暴露了 OneBot HTTP API（默认 http://127.0.0.1:3000，注意别填成 WebSocket 的 3001 —— 会得到 HTTP 426）。');
  process.exit(2);
}

console.log(`\n结论：网关可达 → ${hit}`);
const info = await call(hit, 'get_login_info');
console.log('登录账号：', JSON.stringify(info.json?.data ?? info.json));

const friends = await call(hit, 'get_friend_list');
const list = friends.json?.data;
console.log('好友数：', Array.isArray(list) ? list.length : '(取不到)');
if (Array.isArray(list)) {
  for (const f of list) console.log(`  - ${f.user_id}  ${f.nickname ?? ''}  ${f.remark ?? ''}`);
}

const groups = await call(hit, 'get_group_list');
const glist = groups.json?.data;
console.log('群数：', Array.isArray(glist) ? glist.length : '(取不到)');
if (Array.isArray(glist)) {
  for (const g of glist) console.log(`  - ${g.group_id}  ${g.group_name ?? ''}`);
}
