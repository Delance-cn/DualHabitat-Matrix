// 决定性诊断：直接通过**桌面端自己的服务**打一次推理。
//
// 目的：区分两种可能
//   A) 桌面端进程能用免费额度，独立实例被闸门拒（=> 独立实例永远拿不到免费额度）
//   B) 全局限流/额度耗尽（=> 桌面端此刻也会被拒）
//
// 副作用：会在桌面端实例里创建一个名为 phase0-desktop-feasibility 的会话，
//         脚本结束前会删除它。除此之外不做任何写操作。
//
// 用法：node spike/probe-desktop.mjs
import os from 'node:os';
import path from 'node:path';
import { OpenCode } from '@opencode/client';
import { Service } from '@opencode/client/service';
import { ROOT } from './oc-env.mjs';

const MODEL = { providerID: 'opencode', id: 'deepseek-v4.1-flash-free', variant: 'max' };
const file = path.join(os.homedir(), '.local', 'state', 'opencode', 'service.json');

const endpoint = await Service.discover({ file });
if (!endpoint) {
  console.error('桌面端服务未发现');
  process.exit(1);
}
console.log(`[desktop] ${endpoint.url}`);
const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });

let text = '';
let failure = null;
let done;
const finished = new Promise((resolve) => { done = resolve; });

const stream = (async () => {
  for await (const event of client.event.subscribe()) {
    const d = event.data ?? {};
    if (event.type === 'session.text.ended' && typeof d.text === 'string') text = d.text;
    if (event.type === 'session.execution.failed' && d.error) failure = d.error;
    if (
      event.type === 'session.execution.succeeded' ||
      event.type === 'session.execution.failed' ||
      event.type === 'session.execution.interrupted'
    ) {
      done(event.type);
    }
  }
})().catch((error) => console.error('[event stream]', error?.message ?? error));

const session = await client.session.create({
  title: 'phase0-desktop-feasibility',
  model: MODEL,
  location: { directory: ROOT },
});
console.log(`[desktop] session=${session.id}`);

await client.session.prompt({ sessionID: session.id, text: '只回答：1+1 等于几？一句话，不要调用工具。' });

const outcome = await Promise.race([
  finished,
  new Promise((resolve) => setTimeout(() => resolve('timeout'), 90_000)),
]);
console.log(`[desktop] outcome=${outcome}`);
console.log(`[desktop] text=${JSON.stringify(text)}`);
if (failure) console.log(`[desktop] error=${JSON.stringify(failure)}`);

// 清理：删掉刚建的会话
try {
  await client.session.remove({ sessionID: session.id });
  console.log('[desktop] 已删除测试会话');
} catch (error) {
  console.error('[desktop] 删除会话失败（请手动删掉 phase0-desktop-feasibility）:', error?.message ?? error);
}

stream.catch(() => {});
process.exit(0);
