/**
 * 免费档到底是"绑会话"还是"绑请求"？
 *
 * 事实：桌面服务（45278）里，**App 自己建的老会话**跑 `opencode/deepseek-v4.1-flash-free`
 * 一路成功（cost 0）；而我们用 HTTP API **新建**的会话，同一个服务、同一个模型，一律
 * 403 FreeTierError。所以差别只可能在"会话身上"或"请求路径上"。
 *
 * 这个脚本用 App 建的那个会话 fork 出一个子会话再问一句：
 *   - 子会话能出话  → 免费档与"由 App 创建的会话血统"绑定
 *   - 子会话也 403  → 与请求路径绑定（App 在请求上加了东西），fork 没用
 *
 * 用 fork 而不是直接问原会话，是为了不往用户正在看的对话里塞测试消息。
 *
 *   node spike/probe-fork-free.mjs
 */

import { Service } from '@opencode/client/service';
import { makeOpenCodeClient } from '../src/oc-client.js';

const SOURCE = process.argv[2] ?? 'ses_eb7eca79affdU5CppJn2KhARBs';
const FILE = process.argv[3] ?? `${process.env.USERPROFILE}\\.local\\state\\opencode\\service.json`;

const ep = await Service.discover({ file: FILE });
const c = makeOpenCodeClient(ep);
console.log('endpoint', ep.url, '· source session', SOURCE);

const src = await c.session.get({ sessionID: SOURCE });
console.log('source:', JSON.stringify({ agent: src.agent, model: src.model, cost: src.cost }));

const child = await c.session.fork({ sessionID: SOURCE });
const childID = child?.id ?? child?.data?.id;
console.log('forked →', childID, '· model', JSON.stringify(child?.model ?? child?.data?.model));

await c.session.prompt({ sessionID: childID, text: '只回四个字：能用免费' });

let list = [];
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 500));
  const res = await c.message.list({ sessionID: childID });
  list = res?.data ?? [];
  if (list.some((m) => m.type === 'assistant' && (m.content?.length ?? 0) > 0)) break;
  if (list.some((m) => m.type === 'idle')) break;
}

for (const m of list) {
  if (m.type !== 'assistant' && m.type !== 'idle') continue;
  const text = (m.content ?? []).filter((p) => p?.type === 'text').map((p) => p.text).join('').trim();
  console.log(`  [${m.type}${m.finish ? '/' + m.finish : ''}] ${JSON.stringify(text.slice(0, 160))}`);
  if (m.error?.message) console.log('      error:', m.error.type, m.error.status, m.error.message);
}

await c.session.remove({ sessionID: childID }).catch(() => {});
console.log('✓ done');
