/**
 * 免费档 403 的真凶：`permissions` 里那条 `deny *`。
 *
 * 已复现（每个用例一个全新目录，排除配置重载延迟）：
 *   control {}                                              → PASS
 *   permissions:[{action:*,resource:*,effect:deny}]          → 403 FreeTierError
 *   permissions:[{action:*,resource:*,effect:allow}]         → PASS
 *   项目配置去掉 permissions                                  → PASS
 *
 * 官方 schema 里有两个不同的东西：
 *   - `permissions`：**工具权限**规则集（action 是工具名）
 *   - `policies`   ：访问控制（action 只能是 provider.use / tool.use / integration.use）
 * 猜测：`permissions` 里用 `*` 当 action 会被提升成"什么都拒"，连 provider.use 一起拒掉，
 * 于是模型请求走了另一条没有 App 凭据的路径 → 免费档被服务端拒。
 *
 * 本脚本验证"改用 policies 表达只禁工具"是否既保住免费档、又真的挡住工具。
 *
 *   node spike/probe-policy-gate.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { Service } from '@opencode/client/service';
import { makeOpenCodeClient } from '../src/oc-client.js';

const BASE = 'C:\\Users\\<用户>\\Documents\\默认项目\\zzz-free-probe';
const FILE = `${process.env.USERPROFILE}\\.local\\state\\opencode\\service.json`;
const MODEL = { providerID: 'opencode', id: 'deepseek-v4.1-flash-free', variant: 'high' };
const ASK_TOOL = '用 shell 工具执行 echo FREE-TIER-PROBE，然后把输出原样贴回来。';

const cases = {
  'A control {}': {},
  'B policies tool.use deny *': {
    policies: [{ action: 'tool.use', resource: '*', effect: 'deny' }]
  },
  'C permissions * deny (known bad)': {
    permissions: [{ action: '*', resource: '*', effect: 'deny' }]
  },
  'D policies tool.use deny + mcp allow': {
    policies: [
      { action: 'tool.use', resource: '*', effect: 'deny' },
      { action: 'tool.use', resource: 'snowluma_*', effect: 'allow' }
    ]
  },
  'E policies provider.use deny': {
    policies: [{ action: 'provider.use', resource: '*', effect: 'deny' }]
  },
  'F permissions narrow deny shell': {
    permissions: [{ action: 'shell', resource: '*', effect: 'deny' }]
  }
};

const ep = await Service.discover({ file: FILE });
const c = makeOpenCodeClient(ep);

async function probe(dir, prompt) {
  const s = await c.session.create({ model: MODEL, agent: 'build', location: { directory: dir } });
  await c.session.prompt({ sessionID: s.id, text: prompt });
  let list = [];
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const res = await c.message.list({ sessionID: s.id });
    list = res?.data ?? [];
    if (list.some((m) => m.type === 'idle')) break;
    if (list.some((m) => m.type === 'assistant' && (m.finish === 'stop' || m.finish === 'tool-calls'))) break;
  }
  const err = list.find((m) => m.error)?.error;
  const toolParts = list
    .filter((m) => m.type === 'assistant')
    .flatMap((m) => m.content ?? [])
    .filter((p) => p?.type === 'tool');
  await c.session.remove({ sessionID: s.id }).catch(() => {});
  return {
    err: err ? `${err.type}/${err.status}` : null,
    tools: toolParts.map((p) => ({
      name: p.name ?? p.tool ?? '?',
      executed: p.executed,
      status: p.state?.status,
      output: String(p.state?.output ?? '').slice(0, 60)
    }))
  };
}

let i = 0;
for (const [name, config] of Object.entries(cases)) {
  i += 1;
  const dir = path.join(BASE, `pol-${i}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'opencode.json'), JSON.stringify(config, null, 2));
  const r = await probe(dir, ASK_TOOL);
  console.log(
    `${r.err ? 'FAIL' : 'PASS'}  ${name.padEnd(34)} ${r.err ?? JSON.stringify(r.tools)}`
  );
  await new Promise((res) => setTimeout(res, 1200));
}

console.log('\ndone');
