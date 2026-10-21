/**
 * 验证替代方案：把"一句 deny *"换成"按工具名逐个 deny"。
 *
 * 背景（已复现）：`permissions:[{action:"*",...deny}]` 会让免费档 403。
 * 而按名字精确 deny（如 `read`/`shell`）既能把工具从模型面前藏掉，又不影响免费档。
 *
 * 这轮要同时确认两件事：
 *   1. 免费档还能用（不是 403）
 *   2. 本地工具确实被藏掉了（模型会说"没有 shell 工具"，而不是调用后被拒）
 *
 *   node spike/probe-deny-list.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { Service } from '@opencode/client/service';
import { makeOpenCodeClient } from '../src/oc-client.js';

const BASE = 'C:\\Users\\<用户>\\Documents\\默认项目\\zzz-free-probe';
const FILE = `${process.env.USERPROFILE}\\.local\\state\\opencode\\service.json`;
const MODEL = { providerID: 'opencode', id: 'deepseek-v4.1-flash-free', variant: 'high' };
const ASK = '执行 shell 命令 echo DENY-LIST-OK，把真实输出原样贴回来。不要解释，不要写文件代替。';

// 模型自报的内置工具（spike/probe-list-tools.mjs 的输出）
const BUILTINS = [
  'read',
  'write',
  'edit',
  'glob',
  'grep',
  'shell',
  'webfetch',
  'websearch',
  'question',
  'skill',
  'subagent',
  'execute'
];

const denyList = BUILTINS.map((action) => ({ action, resource: '*', effect: 'deny' }));
const mcpAllows = [
  { action: 'snowluma_*', resource: '*', effect: 'allow' },
  { action: 'web-search-safe_*', resource: '*', effect: 'allow' }
];

const cases = {
  'deny-list only': { permissions: [...denyList, ...mcpAllows] },
  'deny-list + policies guard': {
    permissions: [...denyList, ...mcpAllows],
    policies: [
      { action: 'tool.use', resource: '*', effect: 'deny' },
      { action: 'tool.use', resource: 'snowluma_*', effect: 'allow' },
      { action: 'tool.use', resource: 'web-search-safe_*', effect: 'allow' }
    ]
  },
  'deny-list with unknown names': {
    permissions: [
      ...denyList,
      { action: 'patch', resource: '*', effect: 'deny' },
      { action: 'todowrite', resource: '*', effect: 'deny' },
      { action: 'fetch', resource: '*', effect: 'deny' },
      ...mcpAllows
    ]
  }
};

const ep = await Service.discover({ file: FILE });
const c = makeOpenCodeClient(ep);

let i = 0;
for (const [name, config] of Object.entries(cases)) {
  i += 1;
  const dir = path.join(BASE, `deny-${i}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'opencode.json'), JSON.stringify(config, null, 2));

  const s = await c.session.create({ model: MODEL, agent: 'build', location: { directory: dir } });
  await c.session.prompt({ sessionID: s.id, text: ASK });
  let list = [];
  for (let k = 0; k < 50; k++) {
    await new Promise((r) => setTimeout(r, 500));
    const res = await c.message.list({ sessionID: s.id });
    list = res?.data ?? [];
    if (list.some((m) => m.type === 'idle')) break;
    if (list.some((m) => m.type === 'assistant' && m.finish === 'stop')) break;
  }

  const err = list.find((m) => m.error)?.error;
  const tools = list
    .filter((m) => m.type === 'assistant')
    .flatMap((m) => m.content ?? [])
    .filter((p) => p?.type === 'tool')
    .map((p) => `${p.name}(${p.state?.status})`);
  const text = list
    .filter((m) => m.type === 'assistant')
    .flatMap((m) => m.content ?? [])
    .filter((p) => p?.type === 'text')
    .map((p) => p.text)
    .join('')
    .trim();

  console.log(`\n════ ${name} ════`);
  console.log('  free tier:', err ? `❌ ${err.type}/${err.status}` : '✅ ok');
  console.log('  tools used:', JSON.stringify(tools));
  console.log('  reply:', JSON.stringify(text.slice(0, 160)));

  await c.session.remove({ sessionID: s.id }).catch(() => {});
  await new Promise((r) => setTimeout(r, 1200));
}

console.log('\ndone');
