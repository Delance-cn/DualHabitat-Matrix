// 只读诊断：dump 一个 OpenCode 实例的 config / credentials / providers，
// 用来对比「桌面端实例（免费额度可用）」和「隔离实例（被 403 FreeTierError 拒）」。
//
// 用法：
//   node spike/dump-instance.mjs desktop     # 读 ~/.local/state/opencode
//   node spike/dump-instance.mjs isolated    # 读本项目的 .oc/state
//
// 纯读操作：只调 GET 类接口（config.get / credential.list / provider.list），
// 不建会话、不发消息，不会打扰桌面端正在用的会话。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OpenCode } from '@opencode/client';
import { Service } from '@opencode/client/service';
import { PATHS } from './oc-env.mjs';

const which = process.argv[2] === 'desktop' ? 'desktop' : 'isolated';
const file =
  which === 'desktop'
    ? path.join(os.homedir(), '.local', 'state', 'opencode', 'service.json')
    : path.join(PATHS.state, 'opencode', 'service.json');

if (!fs.existsSync(file)) {
  console.error(`[${which}] 找不到注册文件: ${file}`);
  process.exit(1);
}

// 只打码长串，保留结构，便于看出「谁带了凭据/头」。
const SECRETISH = /(token|password|secret|apikey|api_key|authorization|bearer|cookie|credential)/i;
function redact(value, keyPath = '') {
  if (Array.isArray(value)) return value.map((item) => redact(item, keyPath));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, inner] of Object.entries(value)) out[key] = redact(inner, `${keyPath}.${key}`);
    return out;
  }
  if (typeof value === 'string' && SECRETISH.test(keyPath) && value.length > 8) {
    return `<REDACTED len=${value.length} prefix=${value.slice(0, 4)}>`;
  }
  return value;
}

const endpoint = await Service.discover({ file });
if (!endpoint) {
  console.error(`[${which}] Service.discover 返回空`);
  process.exit(1);
}
console.log(`[${which}] ${endpoint.url}`);

const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });

const info = await client.server.info();
console.log(`[${which}] version=${info.version} pid=${info.pid}`);
console.log(`[${which}] info=${JSON.stringify(info)}`);

// ── config ─────────────────────────────────────────────────────────────────
try {
  const config = await client.config.get();
  console.log(`\n[${which}] === config.get() ===`);
  console.log(JSON.stringify(redact(config), null, 2).slice(0, 4000));
} catch (error) {
  console.error(`[${which}] config.get 失败:`, error?.message ?? error);
}

// ── credentials ────────────────────────────────────────────────────────────
try {
  const credentials = await client.credential.list();
  console.log(`\n[${which}] === credential.list() ===`);
  console.log(JSON.stringify(redact(credentials), null, 2).slice(0, 3000));
} catch (error) {
  console.error(`[${which}] credential.list 失败:`, error?.message ?? error);
}

// ── providers：重点看 opencode provider 的 options（是否带额外 header/key）──
try {
  const providers = await client.provider.list();
  const list = Array.isArray(providers) ? providers : (providers?.data ?? providers?.providers ?? []);
  const target = list.find((entry) => (entry.id ?? entry.providerID) === 'opencode');
  console.log(`\n[${which}] === provider.list() -> opencode ===`);
  console.log(JSON.stringify(redact(target), null, 2).slice(0, 3000));
} catch (error) {
  console.error(`[${which}] provider.list 失败:`, error?.message ?? error);
}

process.exit(0);
