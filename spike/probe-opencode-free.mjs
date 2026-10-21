/**
 * 真机探针：某个 OpenCode 服务能不能用 `opencode/*-free` 出话，且 cost = 0。
 *
 * 为什么单独写：这是"用对话窗口那个模型"的唯一证据 ——
 * 必须看到 assistant 的文本真的回来了，而不是 session 建成功就算数。
 * 免费档是服务端判定的，隔离实例和桌面服务结果**不一样**，所以要能分别探。
 *
 *   node spike/probe-opencode-free.mjs                                  # 隔离实例
 *   node spike/probe-opencode-free.mjs deepseek-v4.1-flash-free <file>  # 指定模型 + 注册文件
 *
 * 注册文件里就有 url 和密码，别写死在脚本里。
 */

import { Service } from '@opencode/client/service';
import { makeOpenCodeClient } from '../src/oc-client.js';

const MODEL = process.argv[2] ?? 'deepseek-v4.1-flash-free';
const FILE = process.argv[3] ?? '.oc/state/opencode/service.json';
const VARIANT = process.argv[4] ?? '';
const AGENT = process.argv[5] ?? '';
const DIR = process.argv[6] ?? process.cwd();
const PROMPT = '只回四个字：能用免费';

const ep = await Service.discover({ file: FILE });
if (!ep?.url) {
  console.log(`no service at ${FILE}`);
  process.exit(1);
}
const c = makeOpenCodeClient(ep);
console.log('endpoint', ep.url, '· model opencode/' + MODEL);

const s = await c.session.create({
  model: { providerID: 'opencode', id: MODEL, ...(VARIANT ? { variant: VARIANT } : {}) },
  ...(AGENT ? { agent: AGENT } : {}),
  location: { directory: DIR }
});
console.log('session', s.id, '· cost', s.cost, '· model', JSON.stringify(s.model), '· dir', DIR);

try {
  const accepted = await c.session.prompt({ sessionID: s.id, text: PROMPT });
  console.log('prompt accepted', accepted?.id ?? '(no id)');
} catch (error) {
  console.log('prompt FAILED:', error?.message ?? error);
}

let list = [];
let done = null;
for (let i = 0; i < 120; i++) {
  await new Promise((r) => setTimeout(r, 500));
  const res = await c.message.list({ sessionID: s.id });
  list = res?.data ?? [];
  done = list.find((m) => m.type === 'assistant' && m.finish) ?? list.find((m) => m.type === 'idle');
  if (done) break;
}

const textOf = (m) =>
  (m?.content ?? [])
    .filter((p) => p?.type === 'text')
    .map((p) => p.text)
    .join('')
    .trim();
console.log(
  `\nverdict: ${done ? `${done.type}${done.finish ? '/' + done.finish : ''}` : 'TIMEOUT'}` +
    ` · text=${JSON.stringify(textOf(done).slice(0, 120))}` +
    (done?.error ? ` · error=${done.error.type}/${done.error.status} ${done.error.message}` : '')
);

console.log('\nmessages:', list.length);
for (const m of list) {
  const text = (m.content ?? [])
    .filter((p) => p?.type === 'text')
    .map((p) => p.text)
    .join('')
    .trim();
  const meta = [m.finish, m.error?.type, m.error?.status].filter(Boolean).join('/');
  const kinds = (m.content ?? []).map((p) => p?.type).join(',');
  console.log(`  [${m.type}${meta ? ' ' + meta : ''}] kinds=${kinds || '-'} text=${JSON.stringify(text.slice(0, 200))}`);
  if (m.error?.message) console.log(`      error: ${m.error.message}`);
}

const st = await c.session.get({ sessionID: s.id });
console.log('\nsession cost =', st.cost, '· tokens =', JSON.stringify(st.tokens));
await c.session.remove({ sessionID: s.id }).catch(() => {});
