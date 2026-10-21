# 后端门面契约（Backend Adapter Contract）

> 这份文件是 `src/backends/*` 所有适配器的实现依据。
> 改动任何适配器之前先读它；改契约之前先读 `src/bridge.js` 里对应的调用点。

## 为什么存在这层

`src/bridge.js` 有 11088 行，但伸手到 AI 后端的入口只有五处：

| 调用点 | 位置（行号为 2026-10 快照） | 语义 |
|---|---|---|
| `api.sessions.prompt({ sessionId, mode, content })` | 2042 / 2105 / 8484 / 10191 | 投递一轮用户输入 |
| `api.respond({ clientId, eventId, outcome })` | 10216 / 10223 / 10246 / 10274 / 10741 / 10747 | 回复权限审批或提问 |
| `api.stopSessionWork(sessionId)` | 2599 / 6706 / 6732 / 9994 | 打断正在跑的回合 |
| `api.callUnary('session.modelCatalog')` | 2264 / 2268 | 拉模型目录（控制台档位下拉框） |
| `api.invalidate()` | — | 丢弃缓存的连接 |

外加一条事件流 `api.events.mux({})`（10378 行的 `pumpMux`）。

**只要新后端产出同样形状的东西，QQ 侧、仿真引擎、黑话学习、账本、控制台全部原样复用。**
`oc-client.js` 已经证明过一次（DSH → 内置实例），这是第二次。

## 一、信封

所有方法返回（`events.mux` 除外，它返回 async iterable）：

```js
// 成功
{ result: { ok: true, value: <任意> } }
// 失败
{ result: { ok: false, error: { code: 'internal' | 'not-found' | <自定义>, message: '...' } } }
```

`bridge.js` 用 `unwrap(response, label)` 解包，失败即 throw。
**不要直接 throw**——异常必须收进信封，否则调用方拿到的形状会漂移。

## 二、事件帧

`events.mux({})` 是一个 **async iterable**，每项形状：

```js
{ rpcId: <string>, payload: { type: 'session/event', sessionId: <string>, event: { type, time, data } } }
```

`event.type` 必须落在下面这个集合里（`bridge.js` 的 collector 和账本按它分支）：

| type | data | 说明 |
|---|---|---|
| `turn/start` | `{ turn }` | 回合开始。`turn` 是该会话内唯一的字符串/数字 |
| `assistant/chunk` | `{ turn, delta }` | 流式增量文本 |
| `assistant/message` | `{ turn, step, message: { role:'assistant', content:[{type:'text', text}] } }` | 一条完整消息 |
| `turn/end` | `{ turn, reason: { kind: 'completed' \| 'failed' \| 'interrupted' } }` | 回合结束，**必须有**，否则该会话永久 busy |
| `session/tool.*` | 见下 | 工具调用，账本和审计靠它 |
| `session/usage` | `{ turn, usage }` | token 用量，可选 |

`usage` 口径（`tokensToUsage` 的产物）：

```js
{ inputTokens, outputTokens, reasoningTokens, cacheReadTokens, cacheWriteTokens }
```

**铁律：只信事件，不信模型文本。**
Phase 0 实测：工具被权限藏掉时，模型不会说"我没有工具"，而是**编造执行结果**。
所以"发生了什么"只能由 `session/tool.*` 帧决定，适配器不许做推断。

## 三、方法清单

### sessions

| 方法 | 入参 | 返回 value |
|---|---|---|
| `create` | `{ workspaceId, agentPreset, title, model }` | `{ sessionId, id, directory }` |
| `list` | `{ workspaceId? }` | `{ items: [{ sessionId, origin, parentSessionId, cwd, title, archived }] }` |
| `prompt` | `{ sessionId, mode: 'queue', content: ContentBlock[] }` | `{ accepted: true, sessionId, result }` |
| `selectModel` | `{ sessionId, provider, model, reasoningEffort }` | `{ selected: { provider, model, reasoningEffort } }` |
| `stats` | `{ sessionId }` | 任意（控制台展示） |
| `messages` | `{ sessionId }` | `{ messages: [...] }` |

`ContentBlock` 最小集合：

```js
{ type: 'text', text: '...' }
{ type: 'image', mediaType: 'image/jpeg', data: '<base64>' }  // 或 path / uri
{ type: 'file',  path: '/abs/path', name: 'x.jpg' }
```

`prompt` 必须是**非阻塞**的：立刻返回 `accepted`，真正的输出通过事件流推。

### workspace

| 方法 | 入参 | 返回 value |
|---|---|---|
| `create` | `{ path }` | `{ created, workspace: { workspaceId, path, title } }` |
| `rename` | `{ workspaceId, title }` | `{ renamed }` |
| `archiveSession` | `{ sessionId }` | `{ archived, deleted }` |

### events

| 方法 | 说明 |
|---|---|
| `follow(sessionId)` | 登记订阅，返回 `{ sessionId }` |
| `forget(sessionId)` | 取消登记。**必须实现**——缺了会在会话退役路径上 TypeError，表现是"会话换不掉、一直对着旧会话重试" |
| `mux({})` | 全局事件流，async iterable |

### 其余

| 方法 | 说明 |
|---|---|
| `respond({ clientId, eventId, outcome })` | 回审批/提问。找不到待响应项要 throw（桥接会 catch 并提示超时） |
| `stopSessionWork(sessionId, { signal, timeoutMs })` | 打断 |
| `callUnary('session.modelCatalog', {})` | 返回 `{ groups: [{ id, models: [{ id, name, inputModalities, reasoning? }] }] }` |
| `invalidate()` / `close()` | 丢弃缓存连接 |
| `currentModel()` / `chainStatus()` | 模型链（可选，没有就返回 null / []） |

## 四、会话语义

- **sessionId 由适配器生成**，桥接只负责存和传。
- 一个 sessionId 对应一份上下文。适配器自己管上下文存储（直连模型）或映射到原生会话（CLI 后端）。
- `turn` 在该会话内自增，从 `turn-1` 开始即可。
- 同一会话允许连续 `prompt`（`mode:'queue'`），但适配器内部要串行化，别让两个回合交错写同一份上下文。

## 五、安全硬约束（针对 Codex / Claude 这类 agent 后端）

`RULES.md` 第一条：**QQ 会话 agent 无本地工具**。群友无论如何诱导，agent 物理上无法操作本机。

Codex CLI 和 Claude Code 默认带 bash + 文件读写，**接进来必须降权**，否则这条地基就塌了：

1. 工具白名单只能含 QQ 相关的 MCP 命名空间（`mcp__snowluma__*` / `mcp__snowluma-host__*` / `mcp__web-search-safe__*`），其余一律不挂。
2. 关闭本地执行：Codex 用 `--sandbox read-only` + `--ask-for-approval never`；Claude 用 `--disallowedTools` 显式剔除 `Bash` / `Write` / `Edit` / `Read`。
3. 工作目录指向 `state/agents/<key>` 下的空目录，不指向项目根。
4. 若目标后端无法做到以上任一条，**不要把它接成 QQ 会话后端**，只能接成 owner 私聊的 `closed-agent` 模式。

## 六、适配器选择

`src/backends/index.js` 的 `createBackend(config)`：

```jsonc
// config.json
{
  "backend": {
    "type": "model-api",        // matrix（内置） | model-api | cli（codex-cli / claude-code …）
    "modelApi": {
      "protocol": "openai",     // openai | anthropic | gemini
      "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
      "model": "qwen-plus",
      "apiKeyEnv": "BAILIAN_API_KEY"
    }
  }
}
```

不写 `backend` 段 = 用内置的 API 实例（等同 `{"type":"matrix"}`），**向后兼容**。老配置里的 `"opencode"` 仍然认。
