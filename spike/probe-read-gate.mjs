/**
 * `read` 这条 deny 为什么会让免费档 403 —— 以及有没有办法既禁掉它又不踩雷。
 *
 * 二分结论：12 条内置工具里**只有 `read`** 单独 deny 会 403，其余（write/edit/glob/
 * grep/shell/webfetch/websearch/question/skill/subagent/execute）都安全。
 * 推测：CLI 在发请求前要用 `read` 权限去读自己的凭据/集成配置，被拒 → 请求没带上
 * "来自 OpenCode App" 的身份 → 服务端按免费档策略拒绝。
 *
 * 这轮试三条路：
 *   A. 把 deny 放到 **agent 级**（qq-chat 自己禁 read）而不是全局
 *   B. 全局先 deny `*` 再对 read 放行某些路径
 *   C. read 的 deny 与 allow 同时存在时的顺序语义
 *
 *   node spike/probe-read-gate.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { Service } from '@opencode/client/service';
import { makeOpenCodeClient } from '../src/oc-client.js';

const BASE = 'C:\\Users\\<用户>\\Documents\\默认项目\\zzz-free-probe\\readgate';
const FILE = `${process.env.USERPROFILE}\\.local\\state\\opencode\\service.json`;
const MODEL = { providerID: 'opencode', id: 'deepseek-v4.1-flash-free', variant: 'high' };
const PERSONA = '你是一个测试助手。回答尽量短。';

const denyRead = { action: 'read', resource: '*', effect: 'deny' };
const allowRead = { action: 'read', resource: '*', effect: 'allow' };
const denyShell = { action: 'shell', resource: '*', effect: 'deny' };

const cases = {
  'control global {} / agent build': { config: {}, agent: 'build' },
  'global deny read (known bad)': { config: { permissions: [denyRead] }, agent: 'build' },
  'global deny read+shell': { config: { permissions: [denyRead, denyShell] }, agent: 'build' },
  'global deny* + allow read': {
    config: { permissions: [{ action: '*', resource: '*', effect: 'deny' }, allowRead] },
    agent: 'build'
  },
  'agent-level deny read': {
    config: {
      agents: {
        probe: {
          mode: 'primary',
          description: 'probe',
          system: PERSONA,
          permissions: [denyRead, denyShell]
        }
      }
    },
    agent: 'probe'
  },
  'agent-level deny read (global read allowed)': {
    config: {
      permissions: [allowRead],
      agents: {
        probe: {
          mode: 'primary',
          description: 'probe',
          system: PERSONA,
          permissions: [denyRead, denyShell]
        }
      }
    },
    agent: 'probe'
  }
};

const ep = await Service.discover({ file: FILE });
const c = makeOpenCodeClient(ep);

let i = 0;
for (const [name, { config, agent }] of Object.entries(cases)) {
  i += 1;
  const dir = path.join(BASE, `g-${i}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'opencode.json'), JSON.stringify(config, null, 2));

  const s = await c.session.create({ model: MODEL, agent, location: { directory: dir } });
  await c.session.prompt({ sessionID: s.id, text: '只回四个字：能用免费' });
  let list = [];
  for (let k = 0; k < 30; k++) {
    await new Promise((r) => setTimeout(r, 400));
    const res = await c.message.list({ sessionID: s.id });
    list = res?.data ?? [];
    if (list.some((m) => m.type === 'idle')) break;
    if (list.some((m) => m.type === 'assistant' && m.finish === 'stop')) break;
  }
  const err = list.find((m) => m.error)?.error;
  const text = list
    .filter((m) => m.type === 'assistant')
    .flatMap((m) => m.content ?? [])
    .filter((p) => p?.type === 'text')
    .map((p) => p.text)
    .join('')
    .trim();
  console.log(`${err ? 'FAIL' : 'PASS'}  ${name.padEnd(42)} ${err ? err.type + '/' + err.status : JSON.stringify(text.slice(0, 40))}`);
  await c.session.remove({ sessionID: s.id }).catch(() => {});
  await new Promise((r) => setTimeout(r, 800));
}

console.log('\ndone');
