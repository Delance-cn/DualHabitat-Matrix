// 探测：**哪些模型有视力**（capabilities.input 含 "image"），以及图**到底有没有**进会话。
//
// 为什么要这个：L 阶段模型连回两次"我看不了图"，但这有两种可能，
// 表现完全一样：
//   (a) glm-4.5-flash 本来就是纯文本模型；
//   (b) 我这边 files 附件没送进去。
// 光看模型的回答分不清。所以：
//   1. model.list() 的 capabilities.input 是**服务端给的**能力清单 —— 权威；
//   2. 回读那条 user message，看附件是否真的落在了会话里 —— 证据。
//
// 只读。不改配置、不重启实例。
// 跑法：node spike/probe-vision.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { OpenCode } from '@opencode/client';
import { Service } from '@opencode/client/service';
import { PATHS, ROOT, SERVICE_FILE } from '../src/oc-env.js';

const endpoint = await Service.discover({ file: SERVICE_FILE });
if (!endpoint?.url) {
  console.log('❌ 没发现运行中的独立实例（.oc/state/opencode/service.json）。先起一个。');
  process.exit(2);
}
const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });
console.log(`实例：${endpoint.url}\n`);

/* ── 1. 模型能力清单 ─────────────────────────────────────────────── */

const list = await client.model.list({});
const models = list?.data ?? list?.models ?? [];
console.log(`模型总数：${models.length}\n`);

const sense = (m) => m?.capabilities?.input ?? m?.capabilities?.inputs ?? [];
const canImage = models.filter((m) => sense(m).some((s) => /image|vision|jpeg|png/i.test(String(s))));

console.log('=== 有视力的模型 ===');
if (!canImage.length) console.log('  （一个都没有）');
for (const m of canImage) {
  console.log(
    `  ${m.providerID}/${m.modelID}  [${m.status}${m.enabled === false ? ' 已停用' : ''}]  input=${JSON.stringify(sense(m))}`
  );
}

console.log('\n=== 我们模型池里的候选，各自的能力 ===');
const poolFile = path.join(ROOT, 'models.json');
let pool = [];
try {
  const raw = JSON.parse(fs.readFileSync(poolFile, 'utf8'));
  pool = raw?.chain ?? raw?.candidates ?? raw?.models ?? [];
  if (!Array.isArray(pool)) pool = [];
} catch {
  /* 没有就算了 */
}
const keys = pool.map((c) => `${c.provider}/${c.model ?? c.id}`);
console.log(`池子：${keys.join(', ') || '(读不到 models.json 的结构)'}`);
for (const k of keys) {
  const m = models.find((x) => `${x.providerID}/${x.modelID}` === k);
  if (!m) {
    console.log(`  ${k}  → 目录里没有`);
    continue;
  }
  console.log(`  ${k}  input=${JSON.stringify(sense(m))}  tools=${m.capabilities?.tools}`);
  }

/* ── 2. 图到底有没有进会话（回读 user message）──────────────────── */

console.log('\n=== 回读：L 阶段那条带附件的 user message ===');
const sessionsDir = path.join(PATHS.state, 'mcp-probe-L1(file://)');
console.log(`（会话状态目录：${fs.existsSync(sessionsDir) ? '存在' : '不存在'}）`);

let sessions = [];
try {
  const r = await client.session.list({});
  sessions = (r?.data ?? r?.sessions ?? []).filter((s) => /L1|L2|file:|data:/i.test(JSON.stringify(s)));
} catch (error) {
  console.log(`  session.list 失败：${error?.message ?? error}`);
}
console.log(`  匹配到的会话数：${sessions.length}`);

for (const s of sessions.slice(-2)) {
  const sid = s.sessionID ?? s.id;
  console.log(`\n  ── 会话 ${sid} ──`);
  try {
    const got = await client.session.message.get({ sessionID: sid });
    const dumped = JSON.stringify(got);
    console.log(`    message.get → ${dumped.slice(0, 900)}`);
    for (const pat of ['data:image', 'file://', 'image/jpeg', 'attachment', 'files']) {
      console.log(`    含 "${pat}"：${dumped.includes(pat) ? '✅' : '❌'}`);
    }
  } catch (error) {
    console.log(`    message.get 失败：${error?.message ?? error}`);
  }
}
process.exit(0);
