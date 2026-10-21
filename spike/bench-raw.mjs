// 干净地测档位：原始客户端，显式指定 provider/model/variant，不经过桥接的模型链。
// 用法：node spike/bench-raw.mjs <provider/model> <variant>
import { makeOpenCodeClient, discoverOpenCodeEndpoint } from '../src/oc-client.js';
import { PATHS } from '../src/oc-env.js';

const ROOT = 'C:\\Users\\<用户>\\DualHabitatMatrix';
const [ref = 'bailian/qwen3.6-plus', variant = 'low'] = process.argv.slice(2);
const [providerID, ...rest] = ref.split('/');
const modelId = rest.join('/');

const endpoint = await discoverOpenCodeEndpoint({ stateDir: PATHS.state });
const client = makeOpenCodeClient(endpoint);

const created = await client.session.create({
  location: { directory: ROOT },
  title: `raw-${modelId}-${variant}`,
  model: { providerID, id: modelId, ...(variant ? { variant } : {}) }
});
const sessionId = created?.data?.id ?? created?.id ?? created?.sessionID;

const t0 = Date.now();
let res;
try {
  res = await client.session.prompt({ sessionID: sessionId, text: '只回复两个字：收到' });
} catch (e) {
  console.log('prompt 失败:', e?.message ?? e);
  process.exit(1);
}
// 等助手回复出现
let ms = 0, text = '';
const deadline = Date.now() + 200000;
for (;;) {
  const list = await client.message.list({ sessionID: sessionId });
  const arr = list?.data ?? list ?? [];
  const assistant = (Array.isArray(arr) ? arr : []).filter((m) => (m.role ?? m.type) !== 'user');
  const t = JSON.stringify(assistant);
  const hit = t.match(/"text":"((?:[^"\\]|\\.){0,80})"/);
  if (hit) { text = hit[1]; ms = Date.now() - t0; break; }
  if (Date.now() > deadline) { console.log('超时'); process.exit(1); }
  await new Promise((r) => setTimeout(r, 250));
}
console.log(`${providerID}/${modelId}#${variant}  ${ms}ms  「${text}」`);
try { await client.session.delete?.({ sessionID: sessionId }); } catch {}
process.exit(0);
