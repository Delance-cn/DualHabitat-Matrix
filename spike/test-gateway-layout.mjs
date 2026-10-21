// 网关布局自发现的离线回归：SnowLuma 与 NapCat 两套配置布局都要能认出来。
//
// 为什么值得单独测：这里的失败模式**全是静默的** ——
//   · 文件名认错（onebot_ vs onebot11_）→ 一个 token 都扫不到，表现为 401；
//   · WS 数组名认错（wsServers vs websocketServers）→ HTTP 通但 WS 一直 1006 重连；
//   · host 是 0.0.0.0 没归一 → 连接行为随平台而异。
// 三者都不抛异常，只会"连不上"，所以必须有断言钉住。
//
// 跑法：node spike/test-gateway-layout.mjs
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { readOneBotTokens, discoverSnowLumaConnection } from '../src/snowluma-conn.js';

let pass = 0;
let fail = 0;
const ok = (cond, label) => {
  if (cond) {
    pass += 1;
    console.log(`  ✅ ${label}`);
  } else {
    fail += 1;
    console.log(`  ❌ ${label}`);
  }
};
const eq = (actual, expected, label) => ok(actual === expected, `${label}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-gateway-layout-'));
const cfgDir = path.join(tmp, 'config');
fs.mkdirSync(cfgDir, { recursive: true });

// ── 1. SnowLuma 布局（回归：不能被新代码改坏）──────────────────────────────
fs.writeFileSync(
  path.join(cfgDir, 'onebot_111.json'),
  JSON.stringify({
    networks: {
      httpServers: [{ host: '127.0.0.1', port: 3000, accessToken: 'sl-http' }],
      wsServers: [{ host: '127.0.0.1', port: 3001, accessToken: 'sl-ws' }]
    }
  })
);

// ── 2. NapCat 布局（新支持）+ 0.0.0.0 归一 ────────────────────────────────
fs.writeFileSync(
  path.join(cfgDir, 'onebot11_222.json'),
  JSON.stringify({
    network: {
      httpServers: [{ name: 'httpServer', enable: true, host: '0.0.0.0', port: 3100, token: 'nc-http' }],
      websocketServers: [{ name: 'WsServer', enable: true, host: '0.0.0.0', port: 3101, token: 'nc-ws' }],
      websocketClients: []
    }
  })
);

console.log('=== readOneBotTokens：布局识别 ===');
const entries = readOneBotTokens(tmp);
eq(entries.length, 2, '两个账号的配置都被读到');

const sl = entries.find((e) => e.uin === '111');
const nc = entries.find((e) => e.uin === '222');

ok(!!sl, 'SnowLuma 账号 111 被识别');
eq(sl?.gateway, 'snowluma', 'SnowLuma 账号 111 的 gateway');
eq(sl?.http?.token, 'sl-http', 'SnowLuma HTTP token');
eq(sl?.ws?.token, 'sl-ws', 'SnowLuma WS token（来自 wsServers）');
eq(sl?.http?.port, 3000, 'SnowLuma HTTP 端口');

ok(!!nc, 'NapCat 账号 222 被识别');
eq(nc?.gateway, 'napcat', 'NapCat 账号 222 的 gateway');
eq(nc?.http?.token, 'nc-http', 'NapCat HTTP token（字段名是 token，不是 accessToken）');
eq(nc?.ws?.token, 'nc-ws', 'NapCat WS token（来自 websocketServers，不是 wsServers）');
eq(nc?.http?.port, 3100, 'NapCat HTTP 端口');
eq(nc?.ws?.port, 3101, 'NapCat WS 端口');
eq(nc?.http?.host, '127.0.0.1', 'NapCat 的 0.0.0.0 被归一成 127.0.0.1（否则客户端连不上）');
eq(nc?.ws?.host, '127.0.0.1', 'NapCat 的 WS 0.0.0.0 同样被归一');
ok(nc?.http?.enabled === true, 'enable:true 被识别为启用');

// ── 3. 端到端：假 OneBot HTTP 服务 + NapCat 布局 → 自发现要能连上并把 WS 带上 ──
console.log('\n=== discover：用假网关验证 NapCat 账号能自发现（含 WS 配对）===');
const server = http.createServer((req, res) => {
  const auth = String(req.headers.authorization ?? '');
  const send = (code, body) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.url === '/get_login_info') {
    if (auth !== 'Bearer nc-http') return send(200, { status: 'failed', retcode: 1401, wording: 'token 不对' });
    return send(200, { status: 'ok', retcode: 0, data: { user_id: 222, nickname: '小号' } });
  }
  return send(404, { status: 'failed', retcode: 404 });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

// 把 NapCat 配置的 HTTP 端口改成假网关的真实端口（其余字段保持 NapCat 的真实形状）
fs.writeFileSync(
  path.join(cfgDir, 'onebot11_222.json'),
  JSON.stringify({
    network: {
      httpServers: [{ name: 'httpServer', enable: true, host: '0.0.0.0', port, token: 'nc-http' }],
      websocketServers: [{ name: 'WsServer', enable: true, host: '0.0.0.0', port: 3101, token: 'nc-ws' }],
      websocketClients: []
    }
  })
);

const disc = await discoverSnowLumaConnection({ cfg: {}, homeDirs: [tmp] });
ok(disc.ok, `自发现成功（error=${disc.error ?? '无'}）`);
eq(disc.token, 'nc-http', '用上了 NapCat 的 HTTP token');
eq(disc.baseUrl, `http://127.0.0.1:${port}`, 'baseUrl 指向 NapCat 的 HTTP 端口');
eq(disc.self?.user_id, 222, '拿到登录账号信息');
eq(disc.wsToken, 'nc-ws', '**WS token 配对成功**（这一步以前会静默失败 → 1006 重连）');
eq(disc.wsUrl, 'ws://127.0.0.1:3101', 'WS 地址正确');

server.close();
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
