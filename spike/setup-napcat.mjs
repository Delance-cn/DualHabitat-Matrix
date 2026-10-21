// 给 NapCat 预置 OneBot 配置，并把桥接的 config.json 接到 NapCat 上。
//
// 为什么可以直接写文件、不用点 WebUI：
//   NapCat 的 onebot11 配置是"每账号一份"，读取逻辑在 napcat.mjs 里是
//     config/onebot11_<QQ号>.json  存在 → 用它
//                                 不存在 → 回退 config/onebot11.json
//   所以**首次登录前**写好 config/onebot11.json，登录时就会被采用。
//
// 为什么 token 要显式写死、不靠空 token：
//   空 token 意味着本机任何进程都能通过 3000/3001 操纵这个 QQ 号。
//   这里生成一个随机 token，同时写进桥接的 config.json —— 显式优先，
//   自发现（snowluma-conn.js）留作兜底。
//
// 跑法：node spike/setup-napcat.mjs [napcatShellDir]
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const DEFAULT_SHELL = path.resolve(ROOT, '..', 'napcat', 'NapCat.52230.Shell');
const shellDir = path.resolve(process.argv[2] ?? DEFAULT_SHELL);

if (!fs.existsSync(shellDir)) {
  console.error(`找不到 NapCat 目录：${shellDir}`);
  console.error('用法：node spike/setup-napcat.mjs [NapCat.<版本>.Shell 目录]');
  process.exit(1);
}

// NapCat 运行目录带版本号（versions/<QQ版本>/resources/app/napcat），更新版本就会变，
// 所以这里**动态解析**，不把版本号写死。
const versionsDir = path.join(shellDir, 'versions');
const candidates = fs.existsSync(versionsDir)
  ? fs
      .readdirSync(versionsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(versionsDir, e.name, 'resources', 'app', 'napcat'))
      .filter((p) => fs.existsSync(path.join(p, 'napcat.mjs')))
  : [];

if (candidates.length === 0) {
  console.error(`在 ${versionsDir} 下找不到 NapCat 运行目录（应含 napcat.mjs）`);
  process.exit(1);
}
if (candidates.length > 1) {
  console.warn(`⚠️ 发现多个 NapCat 运行目录，用第一个：`);
  for (const c of candidates) console.warn(`   ${c}`);
}
const napcatDir = candidates[0];
const cfgDir = path.join(napcatDir, 'config');
fs.mkdirSync(cfgDir, { recursive: true });

// ── 1. token & 端口 ────────────────────────────────────────────────────────
const HTTP_PORT = 3000;
const WS_PORT = 3001;
const token = crypto.randomBytes(16).toString('hex');

// 字段名与默认值全部对照 napcat.mjs 里的 zod schema（Hse=http 服务端 / Kse=ws 服务端），
// 不是凭记忆写的。
const onebotConfig = {
  network: {
    httpServers: [
      {
        name: 'http-server',
        enable: true,
        port: HTTP_PORT,
        host: '127.0.0.1',
        enableCors: true,
        enableWebsocket: false,
        messagePostFormat: 'array', // 桥接按 array 段格式解析
        token,
        debug: false
      }
    ],
    httpSseServers: [],
    httpClients: [],
    websocketServers: [
      {
        name: 'websocket-server',
        enable: true,
        host: '127.0.0.1',
        port: WS_PORT,
        messagePostFormat: 'array',
        reportSelfMessage: false, // 不回显机器人自己发的消息，避免自问自答
        token,
        enableForcePushEvent: true,
        debug: false,
        heartInterval: 30000
      }
    ],
    websocketClients: [],
    plugins: []
  },
  musicSignUrl: '',
  enableLocalFile2Url: false,
  parseMultMsg: false,
  imageDownloadProxy: '',
  timeout: { baseTimeout: 10000, uploadSpeedKBps: 256, downloadSpeedKBps: 256, maxTimeout: 1800000 }
};

// 已经登录过的话，per-account 文件才是真正生效的那份；直接覆盖默认模板会被忽略。
const existingPerAccount = fs
  .readdirSync(cfgDir)
  .filter((n) => /^onebot11_\d+\.json$/.test(n));

const templatePath = path.join(cfgDir, 'onebot11.json');
if (existingPerAccount.length > 0) {
  console.warn(`\n⚠️ 已经存在账号配置：${existingPerAccount.join(', ')}`);
  console.warn('   NapCat 只在"没有账号配置"时才采用 onebot11.json 默认模板。');
  console.warn('   这些文件里如果 OneBot 是关的或端口/token 不同，模板不会生效 ——');
  console.warn('   要么改它们，要么（推荐）去 WebUI 里改，然后重跑本脚本只更新桥接 config.json。');
}
if (fs.existsSync(templatePath)) {
  const backup = `${templatePath}.bak-${Date.now()}`;
  fs.copyFileSync(templatePath, backup);
  console.log(`已备份旧默认模板 → ${path.basename(backup)}`);
}
fs.writeFileSync(templatePath, JSON.stringify(onebotConfig, null, 2));
console.log(`✅ 写入 OneBot 默认模板：${templatePath}`);
console.log(`   HTTP  http://127.0.0.1:${HTTP_PORT}  token=${token.slice(0, 8)}…`);
console.log(`   WS    ws://127.0.0.1:${WS_PORT}    token=同上`);

// ── 2. 把桥接 config.json 接过来 ──────────────────────────────────────────
const bridgeCfgPath = path.join(ROOT, 'config.json');
if (!fs.existsSync(bridgeCfgPath)) {
  console.log(`\n跳过程序配置：${bridgeCfgPath} 不存在（先用 config.example.json 复制一份）`);
} else {
  let text = fs.readFileSync(bridgeCfgPath, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const cfg = JSON.parse(text);
  cfg.snowluma = cfg.snowluma ?? {};
  cfg.snowluma.homeDir = napcatDir;
  cfg.snowluma.httpUrl = `http://127.0.0.1:${HTTP_PORT}`;
  cfg.snowluma.wsUrl = `ws://127.0.0.1:${WS_PORT}`;
  cfg.snowluma.accessToken = token;
  // 换了网关就不要再跟着别的端点跑
  cfg.snowluma.followDiscoveredEndpoint = false;
  cfg.snowluma.gateway = 'napcat';
  fs.writeFileSync(bridgeCfgPath, JSON.stringify(cfg, null, 2) + '\n');
  console.log(`\n✅ 更新 ${path.relative(ROOT, bridgeCfgPath)}`);
  console.log(`   snowluma.homeDir  = ${napcatDir}`);
  console.log(`   snowluma.wsUrl    = ${cfg.snowluma.wsUrl}`);
  console.log(`   snowluma.httpUrl  = ${cfg.snowluma.httpUrl}`);
}

console.log('\n下一步：');
console.log(`   1) 双击 ${path.join(shellDir, 'napcat.bat')}`);
console.log('   2) 用**小号**扫码登录（控制台会打印二维码）');
console.log('   3) 登录后我就能发消息了');
