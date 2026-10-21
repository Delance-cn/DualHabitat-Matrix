// 移植后的最小冒烟：隔离实例起得来、门面拿得到模型目录和 agent 列表。
// 只读，不建会话、不发消息。跑法：node spike/smoke-port.mjs
import { ensureServer } from '../src/oc-server.js';
import { NodeApiClient, unwrap } from '../src/oc-client.js';
import { PATHS } from '../src/oc-env.js';

const log = (m) => console.log(`[smoke] ${m}`);
const server = await ensureServer({ log });
log(`实例 ${server.url} pid=${server.pid} version=${server.version}`);

const api = new NodeApiClient(undefined, undefined, { stateDir: PATHS.state, sessionDir: PATHS.state, log });

const catalog = unwrap(await api.callUnary('session.modelCatalog', {}), 'session.modelCatalog');
for (const group of catalog.groups ?? []) {
  const ids = group.models.map((m) => `${m.id}${m.reasoning ? `(${m.reasoning.efforts.map((e) => e.id).join('|')})` : ''}`);
  log(`${group.id}: ${ids.join(', ')}`);
}

const presets = unwrap(await api.agentPresets.list({}), 'agentPresets.list');
log(`agents: ${presets.presets.map((p) => p.id).join(', ') || '(无)'}`);

const chain = api.chainStatus();
log(`链: ${chain.map((c) => `${c.key}${c.usable ? '' : '(熔断)'}`).join(' → ')}`);
