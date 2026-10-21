// NapCat WebUI API 的最小客户端：读登录状态 / 读生效的 OneBot 配置 / 写配置。
//
// 为什么需要它（只用于**配置与诊断**，不属于运行时依赖）：
//   `config/onebot11.json` 只是"首次登录时采用的默认模板"，而
//   `/api/OB11Config/GetConfig` 返回的是**当前真正生效**的那份 —— 排查
//   "配置没生效"时，只有这个才是证据。运行时桥接走的是 OneBot HTTP/WS，
//   完全不碰这个 API。
//
// 认证（从 napcat.mjs 里读出来的，不是猜的）：
//   1) 换凭证：hash = sha256(<webui token> + ".napcat") 的 hex，
//      POST /api/auth/login {hash} → { Credential }（base64 的已签名 JSON）
//   2) 之后所有 /api/* 带  Authorization: Bearer <Credential>
//      凭证 1 小时过期、且绑定服务端随机密钥（重启即失效）。
//   注意：只带 webui token 是**不够**的 —— 会得到 {"code":-1,"message":"Unauthorized"}。
//
// 跑法：
//   node spike/napcat-webui.mjs status
//   node spike/napcat-webui.mjs getconfig
//   node spike/napcat-webui.mjs setconfig <json文件>
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/** 找 NapCat 运行目录（含 config/webui.json 的那个；版本号会变所以动态找）。 */
export function findNapCatDir(startDirs = []) {
  const roots = [
    ...startDirs,
    path.resolve(ROOT, '..', 'napcat'),
    path.join(ROOT, '.napcat'),
    path.join(os.homedir(), 'Documents', '默认项目', 'napcat')
  ];
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 6 || found.length > 8) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const p = path.join(dir, e.name);
      if (e.name === 'config' && fs.existsSync(path.join(p, 'webui.json'))) found.push(path.dirname(p));
      else if (e.name !== 'node_modules' && e.name !== '.git') walk(p, depth + 1);
    }
  };
  for (const r of roots) walk(r, 0);
  return found[0] ?? null;
}

export function readWebUiToken(napcatDir) {
  const f = path.join(napcatDir, 'config', 'webui.json');
  const j = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
  return { token: j.token, port: Number(j.port) || 6099, host: j.host || '127.0.0.1' };
}

const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** 用 webui token 换 1 小时有效的调用凭证。 */
async function login(base, token) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      // 有些版本只用 query 认 token，两处都给上
      'x-webui-token': token
    },
    body: JSON.stringify({ hash: sha256hex(`${token}.napcat`) }),
    signal: AbortSignal.timeout(8000)
  });
  const json = await res.json().catch(() => null);
  const cred = json?.Credential ?? json?.Data?.Credential ?? json?.data?.Credential ?? null;
  return { cred, raw: json, status: res.status };
}

async function call(base, cred, route, body) {
  const res = await fetch(`${base}/api${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cred}` },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(8000)
  });
  const text = await res.text();
  try {
    return { status: res.status, json: JSON.parse(text) };
  } catch {
    return { status: res.status, json: null, text: text.slice(0, 300) };
  }
}

if (process.argv[1]?.endsWith('napcat-webui.mjs')) {
  const cmd = (process.argv[2] ?? 'status').toLowerCase();
  const napcatDir = findNapCatDir();
  if (!napcatDir) {
    console.error('找不到 NapCat 运行目录（需含 config/webui.json）');
    process.exit(1);
  }
  const { token, port, host } = readWebUiToken(napcatDir);
  const base = `http://${host === '::' || host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`;
  console.log(`NapCat: ${napcatDir}\nWebUI : ${base}\n`);

  const { cred, raw, status } = await login(base, token);
  if (!cred) {
    console.error(`登录失败（HTTP ${status}）：${JSON.stringify(raw).slice(0, 300)}`);
    process.exit(1);
  }
  console.log(`已取得调用凭证（${String(cred).length} 字节）\n`);

  if (cmd === 'status') {
    for (const route of ['/QQLogin/CheckLoginStatus', '/QQLogin/GetQQLoginInfo']) {
      const r = await call(base, cred, route);
      console.log(`${route} → HTTP ${r.status}`);
      console.log('  ' + JSON.stringify(r.json ?? r.text).slice(0, 900) + '\n');
    }
  } else if (cmd === 'getconfig') {
    const r = await call(base, cred, '/OB11Config/GetConfig');
    console.log(`/OB11Config/GetConfig → HTTP ${r.status}`);
    console.log(JSON.stringify(r.json ?? r.text, null, 2).slice(0, 4000));
  } else if (cmd === 'setconfig') {
    const file = process.argv[3];
    if (!file) {
      console.error('用法：node spike/napcat-webui.mjs setconfig <json文件>');
      process.exit(1);
    }
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    const r = await call(base, cred, '/OB11Config/SetConfig', cfg);
    console.log(`/OB11Config/SetConfig → HTTP ${r.status}`);
    console.log(JSON.stringify(r.json ?? r.text).slice(0, 900));
  } else if (cmd === 'qr') {
    // 拉一张**新鲜**的登录二维码存成 PNG，方便渲染出来扫。
    // NapCat 的二维码约 2 分钟过期，所以这里先 Refresh 再取。
    const st = await call(base, cred, '/QQLogin/CheckLoginStatus');
    console.log('/QQLogin/CheckLoginStatus →');
    console.log('  ' + JSON.stringify(st.json?.data ?? st.json).slice(0, 600) + '\n');

    await call(base, cred, '/QQLogin/RefreshQRcode').catch(() => {});
    const r = await call(base, cred, '/QQLogin/GetQQLoginQrcode');
    const j = r.json ?? {};

    // 只打印形状（base64 太长，打出来没法看）
    const shape = {};
    const walk = (o, p = '') => {
      if (typeof o === 'string') {
        shape[p] = `string(${o.length}) ${o.slice(0, 48).replace(/[^\x20-\x7e]/g, '·')}`;
        return;
      }
      if (o && typeof o === 'object') {
        for (const [k, v] of Object.entries(o)) walk(v, p ? `${p}.${k}` : k);
        return;
      }
      shape[p] = typeof o;
    };
    walk(j);
    console.log('响应形状:');
    console.log(JSON.stringify(shape, null, 2));

    // 深挖 PNG（base64）与二维码内容 URL
    let png = null;
    let url = null;
    const find = (o) => {
      if (typeof o === 'string') {
        if (/^iVBORw0KGgo/.test(o)) png = png ?? o;
        else if (/^data:image\/png;base64,/.test(o)) png = png ?? o.split(',')[1];
        else if (/^https?:\/\//.test(o) && !url) url = o;
        return;
      }
      if (o && typeof o === 'object') for (const v of Object.values(o)) find(v);
    };
    find(j);
    if (url) console.log(`\n二维码内容 URL：${url}`);
    console.log(`PNG: ${png ? `${png.length} 字节 base64` : '没找到'}`);

    if (png) {
      const outDir = path.join(ROOT, 'spike', 'out');
      fs.mkdirSync(outDir, { recursive: true });
      const outFile = path.join(outDir, 'napcat-qr.png');
      fs.writeFileSync(outFile, Buffer.from(png, 'base64'));
      console.log(`已写入: ${outFile}  (${fs.statSync(outFile).size} 字节)`);
    }
  } else if (cmd === 'call') {
    // 通用逃生门：任意路由都能量一下，省得为每个查询都改脚本
    const route = process.argv[3];
    if (!route) {
      console.error('用法：node spike/napcat-webui.mjs call /QQLogin/GetQuickLoginList \'{"a":1}\'');
      process.exit(1);
    }
    const body = process.argv[4] ? JSON.parse(process.argv[4]) : {};
    const r = await call(base, cred, route, body);
    console.log(`${route} → HTTP ${r.status}`);
    console.log(JSON.stringify(r.json ?? r.text, null, 2).slice(0, 3000));
  } else {
    console.error(`未知子命令：${cmd}（status | getconfig | setconfig <file> | call <路由> [json]）`);
    process.exit(1);
  }
}
