// 安全性诊断：实例**刚起来**时，用一个还没加载过配置的目录建会话，会怎样？
//
// 关心的不是"能不能建"，而是 **agent 解析失败时是报错还是静默降级**：
//   - 报错  → fail-closed，桥接建不上会话，群友聊不了。可接受。
//   - 静默降级到 OpenCode 默认 agent（build）→ 群友拿到一个**带 shell/读写**的 agent。
//     这是 RULES.md 明令要避免的那种事故（"无本地工具"是群聊的硬边界）。
//
// 同时验证：完全不存在的 agent 名传进去，OpenCode 是什么反应。
import { ensureServer } from '../src/oc-server.js';
import { NodeApiClient } from '../src/oc-client.js';
import { PATHS, ROOT } from '../src/oc-env.js';

await ensureServer({ log: (m) => console.log(`[server] ${m}`), force: true });

const api = new NodeApiClient(undefined, undefined, { stateDir: PATHS.state, sessionDir: PATHS.state, log: () => {} });
const client = await api._ensureClient();

const tryCreate = async (agentId) => {
  const input = { location: { directory: ROOT } };
  if (agentId !== null) input.agent = agentId;
  try {
    const res = await client.session.create(input);
    const s = res?.data ?? res;
    return { ok: true, id: s?.id ?? s?.sessionID, raw: s };
  } catch (error) {
    return { ok: false, message: error?.message ?? String(error) };
  }
};

// 立刻（冷缓存）跑
console.log('\n===== 冷缓存（实例刚就绪）=====');
const coldList = await client.agent.list({ location: { directory: ROOT } });
const coldAgents = (coldList?.data ?? coldList ?? []);
console.log(`  agent.list(ROOT) → ${coldAgents.length} 个`);

for (const [label, agentId] of [
  ['agent=qq-chat', 'qq-chat'],
  ['agent=zzz-不存在', 'zzz-this-agent-does-not-exist'],
  ['不传 agent', null]
]) {
  const r = await tryCreate(agentId);
  console.log(`  ${label.padEnd(18)} → ${r.ok ? '建成了 ' + r.id : '报错: ' + r.message}`);
}

// 看建出来的会话实际绑的哪个 agent（如果接口给了）
console.log('\n===== 会话详情（找 agent 字段）=====');
for (const [label, agentId] of [
  ['agent=qq-chat', 'qq-chat'],
  ['agent=zzz-不存在', 'zzz-this-agent-does-not-exist'],
  ['不传 agent', null]
]) {
  const r = await tryCreate(agentId);
  if (!r.ok) {
    console.log(`  ${label} 建会话就失败：${r.message}`);
    continue;
  }
  try {
    const get = await client.session.get({ sessionID: r.id });
    const s = get?.data ?? get;
    const slim = {
      id: s?.id,
      agent: s?.agent ?? s?.agentID ?? s?.agentId,
      mode: s?.mode,
      model: s?.model,
      directory: s?.location?.directory ?? s?.directory
    };
    console.log(`  ${label.padEnd(18)} → ${JSON.stringify(slim)}`);
  } catch (error) {
    console.log(`  ${label.padEnd(18)} → session.get 失败：${error?.message ?? error}`);
  }
}

console.log('\n===== 暖缓存（3 秒后）=====');
await new Promise((r) => setTimeout(r, 3000));
const warmList = await client.agent.list({ location: { directory: ROOT } });
console.log(`  agent.list(ROOT) → ${(warmList?.data ?? warmList ?? []).length} 个`);
const r2 = await tryCreate('qq-chat');
console.log(`  agent=qq-chat → ${r2.ok ? '建成了 ' + r2.id : '报错: ' + r2.message}`);
process.exit(0);
