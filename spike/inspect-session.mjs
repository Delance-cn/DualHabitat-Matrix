// 看某个会话最近几轮到底发生了什么：有没有工具调用、有没有报错、模型回了什么。
// 用法：node spike/inspect-session.mjs <sessionId> [条数]
import { makeOpenCodeClient, discoverOpenCodeEndpoint } from '../src/oc-client.js';
import { PATHS } from '../src/oc-env.js';

const sessionId = process.argv[2];
const limit = Number(process.argv[3] || 6);
const endpoint = await discoverOpenCodeEndpoint({ stateDir: PATHS.state });
const client = makeOpenCodeClient(endpoint);

const res = await client.message.list({ sessionID: sessionId });
const arr = res?.data ?? res ?? [];
const items = Array.isArray(arr) ? arr : (arr?.messages ?? []);
console.log('消息数:', items.length);
for (const m of items.slice(-limit)) {
  const role = m.role ?? m.type ?? '?';
  const t = m.time?.created ? new Date(m.time.created).toLocaleTimeString('zh-CN') : '';
  const blocks = m.content ?? m.payload?.content ?? [];
  const parts = [];
  for (const b of Array.isArray(blocks) ? blocks : []) {
    if (b.type === 'text') parts.push(`文本(${String(b.text ?? '').length}字): ${String(b.text ?? '').replace(/\s+/g, ' ').slice(0, 60)}`);
    else if (b.type === 'tool-call' || b.type === 'tool_call') parts.push(`调用工具 ${b.name ?? b.toolName}`);
    else if (b.type === 'tool-result' || b.type === 'tool_result') parts.push(`工具结果 ${String(JSON.stringify(b.output ?? b.result ?? '')).slice(0, 80)}`);
    else if (b.type === 'reasoning' || b.type === 'thinking') parts.push(`思考(${String(b.text ?? '').length}字)`);
    else parts.push(b.type);
  }
  const extra = m.error ? ` ERROR=${JSON.stringify(m.error).slice(0, 200)}` : '';
  const model = m.modelID ? ` [${m.providerID}/${m.modelID}]` : '';
  console.log(`${t} ${role}${model}${extra}`);
  for (const p of parts) console.log('   -', p);
}
process.exit(0);
