// 自测脚本：不依赖 SnowLuma / QQ，只验证 **模型 API 侧链路**——
//   1. 拉起（或复用）桥接专用的 模型 API 隔离实例
//   2. 创建一个独立测试会话（不会碰桥接在用的会话）
//   3. 订阅事件流（mux）
//   4. sessions.prompt 注入一条消息
//   5. 等 agent 回复（turn/end）并打印，然后归档会话
//
// 用法：node src/self-test.js [prompt 文本]
//
// 与上游 DSH 版的差别：客户端从 `dsh-client.js` 换成 `oc-client.js`（同形状门面，
// 内部翻译 模型 API），并显式 `ensureServer()` 拉实例 —— DSH 是常驻服务，模型 API
// 是我们自己管的子进程，不自拉就没人监听 4599。
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { NodeApiClient, unwrap, createTurnCollector } from './oc-client.js';
import { ensureServer } from './oc-server.js';
import { PATHS } from './oc-env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// 自测会话的清理句柄（见 cleanupSelfTestSession）。
let selfTestApi = null;
let selfTestSessionId = null;

/**
 * 归档自测会话，别让它留在实例里累积。
 *
 * 注意：`workspace.archiveSession` 在 模型 API 上默认退化成 `interrupt`（保留历史），
 * 只有 `auth.deleteArchived` 打开时才是真删 —— 这是有意设计（真删不可逆）。
 */
async function cleanupSelfTestSession() {
  if (!selfTestApi || !selfTestSessionId) return;
  const sid = selfTestSessionId;
  selfTestSessionId = null;
  try {
    await selfTestApi.workspace.archiveSession({ sessionId: sid });
    console.log('🧹 已归档自测会话:', sid);
  } catch (error) {
    console.log('⚠️ 自测会话归档失败（可忽略）:', sid, error?.message ?? error);
  }
}

async function main() {
  const promptText = process.argv[2] ?? '只回复两个字：收到';

  await ensureServer({ log: (m) => console.log('🔌', m) });

  const api = new NodeApiClient(undefined, undefined, {
    // stateDir 必须是隔离实例的状态目录（`.oc/state`）—— 服务注册文件
    // `<stateDir>/opencode/service.json` 就躺在那儿，指错就找不到实例。
    stateDir: PATHS.state,
    sessionDir: PATHS.state,
    log: () => {}
  });
  selfTestApi = api;

  const desc = unwrap(await api.settings.describe({}), 'settings.describe');
  console.log('✅ 桥接设置可读:', JSON.stringify(desc).slice(0, 200));

  // 会话的目录必须是**项目根**：模型 API 只从会话目录向上找 `opencode.json`，
  // 换目录就看不到 `qq-chat` 这些 agent，桥接会拒绝建会话（config.json 的
  // `sessionCwd` 注释里记着这条坑）。自测走的就是桥接真实的路径。
  const ws = unwrap(await api.workspace.create({ path: ROOT }), 'workspace.create');
  const workspaceId = ws.workspace.workspaceId;
  const created = unwrap(
    await api.sessions.create({ workspaceId, agentPreset: 'qq-chat', title: 'self-test（可删）' }),
    'sessions.create'
  );
  const sessionId = created.sessionId;
  selfTestSessionId = sessionId;
  console.log('✅ 测试会话已创建:', sessionId);

  // 先订阅事件流、再注入消息。`mux()` 是全局流（不是按会话订阅），所以先
  // `events.follow()` 登记会话、再 prompt，免得回合事件在登记前就产生了。
  // 注意 `follow` 挂在 `events` 上，**不是** mux 返回的迭代器上（与上游 DSH 的
  // 「mux 返回带 follow 的流对象」不同——见 oc-client.js 5.5 节）。
  const collector = createTurnCollector();
  const stream = api.events.mux({});
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等待回复超时（120s）')), 120_000);
    (async () => {
      for await (const envelope of stream) {
        const frame = envelope.payload;
        if (frame.type === 'session/event' && frame.sessionId === sessionId) {
          const ended = collector.push(frame.event);
          if (ended) {
            clearTimeout(timer);
            resolve(ended);
            return;
          }
        }
        if (frame.type === 'stream/error') {
          clearTimeout(timer);
          reject(new Error('事件流错误: ' + JSON.stringify(frame.error)));
          return;
        }
      }
    })().catch((error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  api.events.follow(sessionId);

  const accepted = unwrap(
    await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: promptText }] }),
    'sessions.prompt'
  );
  console.log('✅ prompt 已接受:', JSON.stringify(accepted));

  const ended = await done;
  console.log('✅ 回合结束 reason =', ended.reason?.kind);
  if (ended.reason?.kind !== 'completed' || !ended.text.trim()) {
    throw new Error(`模型 API 自测回合未成功完成（reason=${ended.reason?.kind ?? 'unknown'}，有文本=${Boolean(ended.text.trim())}）`);
  }
  console.log('🤖 agent 回复:');
  console.log(ended.text);
  await cleanupSelfTestSession();
  console.log('🎉 自测通过 —— 模型 API 链路可用');
  process.exit(0);
}

main().catch(async (error) => {
  console.error('❌ 自测失败:', error?.message ?? error);
  await cleanupSelfTestSession();
  process.exit(1);
});
