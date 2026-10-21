// 直接问 opencode：百炼这些模型到底支持哪些 variant（档位）。
// 走原始客户端，不经过桥接的模型链，避免链的候选覆盖掉参数。
import { makeOpenCodeClient, discoverOpenCodeEndpoint } from '../src/oc-client.js';
import { PATHS } from '../src/oc-env.js';

const endpoint = await discoverOpenCodeEndpoint({ stateDir: PATHS.state });
console.log('实例:', endpoint.url);
const client = makeOpenCodeClient(endpoint);

try {
  const res = await client.model.list({ location: { directory: 'C:\\Users\\<用户>\\DualHabitatMatrix' } });
  const raw = res?.data ?? res?.models ?? res;
  const models = Array.isArray(raw) ? raw : (raw?.models ?? []);
  console.log('模型数:', models.length);
  for (const m of models) {
    const pid = m.providerID ?? m.provider;
    if (!/bailian|zhipu/.test(String(pid))) continue;
    const variants = m.variants && typeof m.variants === 'object' ? Object.keys(m.variants) : [];
    console.log(`  ${pid}/${m.modelID ?? m.id}  variants=[${variants.join(',')}]  reasoning=${m.reasoning ?? '-'}`);
  }
} catch (e) {
  console.log('model.list 失败:', e?.message ?? e);
}
process.exit(0);
