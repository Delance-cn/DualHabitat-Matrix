// 验证生成的配置真的被实例读到：agent 列表 + 生效权限规则集。
// 跑法：node spike/verify-config.mjs

import { ensureServer } from '../src/oc-server.js';
import { NodeApiClient, unwrap } from '../src/oc-client.js';
import { PATHS, ROOT } from '../src/oc-env.js';

const log = (m) => console.log(`[verify] ${m}`);
await ensureServer({ log, force: true });

const api = new NodeApiClient(undefined, undefined, { stateDir: PATHS.state, sessionDir: PATHS.state, log });

const bare = unwrap(await api.agentPresets.list({}), 'agentPresets.list');
log(`list({}) → agents: ${bare.presets.map((p) => `${p.id}${p.isDefault ? '*' : ''}`).join(', ') || '(无)'}`);

const policy = unwrap(await api.agentPresets.policy({ id: 'qq-chat', directory: ROOT }), 'agentPresets.policy');
log(`qq-chat 生效规则：${JSON.stringify(policy).slice(0, 500)}`);
