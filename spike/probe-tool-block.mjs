/**
 * `policies: [{action:"tool.use", resource:"*", effect:"deny"}]` 到底有没有挡住工具？
 *
 * 上一轮的测量不靠谱：工具 part 的 `state.output` 拿不到内容，控制组和实验组看起来一样。
 * 这轮把工具 part 的完整 JSON 打出来对比（控制组 vs 拒绝组）。
 *
 * 判断标准：
 *   - 控制组：shell 真的跑起来，state 里能看到结果（或至少不是 permission 类错误）
 *   - 拒绝组：state.status=error 且错误信息是权限相关，或模型根本拿不到工具定义
 *
 *   node spike/probe-tool-block.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { Service } from '@opencode/client/service';
import { makeOpenCodeClient } from '../src/oc-client.js';

const BASE = 'C:\\Users\\<用户>\\Documents\\默认项目\\zzz-free-probe';
const FILE = `${process.env.USERPROFILE}\\.local\\state\\opencode\\service.json`;
const MODEL = { providerID: 'opencode', id: 'deepseek-v4.1-flash-free', variant: 'high' };
const ASK = '执行 shell 命令 echo BLOCK-TEST-OK，然后把命令的真实输出原样贴回来。不要解释。';

const cases = {
  control: {},
  'policies-deny': { policies: [{ action: 'tool.use', resource: '*', effect: 'deny' }] },
  'permissions-deny-shell': {
    permissions: [{ action: 'shell', resource: '*', effect: 'deny' }]
  }
};

const ep = await Service.discover({ file: FILE });
const c = makeOpenCodeClient(ep);

let i = 0;
for (const [name, config] of Object.entries(cases)) {
  i += 1;
  const dir = path.join(BASE, `block-${i}`);
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

  console.log(`\n════════ ${name} ════════`);
  for (const m of list) {
    if (m.error) console.log('  MESSAGE ERROR:', m.error.type, m.error.status, m.error.message);
    for (const p of m.content ?? []) {
      if (p?.type !== 'tool') continue;
      console.log('  tool', p.name, '· executed =', p.executed);
      console.log('    state =', JSON.stringify(p.state).slice(0, 500));
    }
    const text = (m.content ?? []).filter((p) => p?.type === 'text').map((p) => p.text).join('');
    if (text.trim()) console.log('  text:', JSON.stringify(text.trim().slice(0, 200)));
  }

  await c.session.remove({ sessionID: s.id }).catch(() => {});
  await new Promise((r) => setTimeout(r, 1200));
}

console.log('\ndone');
