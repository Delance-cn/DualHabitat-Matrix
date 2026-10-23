# DualHabitat Matrix · LLM 接入指南（给其他 Agent / 程序）

> 更新：2026-10-21。本文回答一个问题：**别的 Agent / 脚本想用这套 LLM 能力，怎么接？**
> 标了「✅ 实测」的都是当天在本机验证过的；没标的写的是代码事实，用前先小流量试。

## 0. 一张表看全

| 接入点 | 地址 | 协议 | 鉴权 | 适合谁 |
|---|---|---|---|---|
| 内置模型 API 实例 | `http://127.0.0.1:4599` | OpenCode REST（会话制，SSE 事件流） | HTTP Basic，密码在 `.oc/state/opencode/service.json` | 想复用「带工具、带模型池故障转移」的完整 Agent 能力 |
| OpenAI 兼容壳 | `http://127.0.0.1:4610/v1` | **OpenAI 兼容** | `Authorization: Bearer <key>`（`state/openai-shell.key`，扩展页可看/可换） | Chatbox / LobeChat / Continue / 任何 OpenAI SDK，零改造 |
| cf-shim | `http://127.0.0.1:4600/v1` | **OpenAI 兼容** | 无 | 只要 Cloudflare Workers AI 模型、手头只有 OpenAI SDK |
| 桌面端服务 | `http://127.0.0.1:3200` | 自有 REST | 无（仅本机） | 本机脚本：发通知、做总结、读消息 |
| 桥接控制台 | `http://127.0.0.1:3100` | 自有 REST | `x-console-token`（`state/console-token`） | 本机运维脚本：状态、插件、白名单 |
| QQ 机器人协议 | `127.0.0.1:3000`（HTTP）/ `3001`（WS） | **OneBot v11** | NapCat 的 accessToken | NoneBot2 / Koishi 等机器人框架直连 |
| 微信出站 Hook | config 的 `platforms.wechat.hook.url` | Webhook 出站（default / OneBot / 模板） | 可选 `X-DHM-Secret` 头 | 自建服务接收微信消息事件 |

**安全边界：以上全部只绑 127.0.0.1**，外网直接够不到。要给局域网用，自己加反代并加鉴权，别裸端口。

---

## 1. 内置模型 API 实例（4599）—— 能力最全的一条路

这是桥接自己在用的那套「模型 API 隔离实例」（OpenCode serve，version 2.0.32），
模型池故障转移、工具调用、人格预设都在这一层。其他 Agent 接它 = 拿到一个
「已经在管 key、管降级」的 Agent 会话服务。

### 1.1 鉴权（✅ 实测）

- 协议：**HTTP Basic**，用户名留空，密码 = 注册文件里的 `password` 字段：
  `C:\Users\...\DualHabitat-Matrix\.oc\state\opencode\service.json`
  （JSON 里还有 `url` / `pid` / `version`，密码丢了就以这份文件为准。）
- 注意是 Basic 不是 Bearer。401 = 密码不对或没带。
- ⚠️ `GET /openapi.json` 在 2.0.32 上实测返回 401（即使带了 Basic），别依赖它做代码生成；
  以 SDK 或下面的示例为准。

### 1.2 最小可用示例（✅ 实测，等价于 `src/self-test.js`）

仓库里的 `src/self-test.js` 就是一份能跑的参考实现（`npm run self-test` 通过）。
其他 Agent 照抄这个流程即可：

```js
import { NodeApiClient, unwrap, createTurnCollector } from './src/oc-client.js';
import { ensureServer } from './src/oc-server.js';
import { PATHS } from './src/oc-env.js';

await ensureServer({ log: () => {} });          // 没起就拉起，起了就复用（幂等）

const api = new NodeApiClient(undefined, undefined, {
  stateDir: PATHS.state,                        // 必须是隔离实例的状态目录
  sessionDir: PATHS.state,
  log: () => {}
});

const ws = unwrap(await api.workspace.create({ path: '<项目根目录>' }), 'workspace.create');
const { sessionId } = unwrap(
  await api.sessions.create({ workspaceId: ws.workspace.workspaceId, agentPreset: 'qq-chat', title: '一次性任务' }),
  'sessions.create'
);

const collector = createTurnCollector();
const stream = api.events.mux({});
const done = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('等待回复超时')), 240_000);
  (async () => {
    for await (const envelope of stream) {
      const frame = envelope.payload;
      if (frame.type === 'session/event' && frame.sessionId === sessionId) {
        const ended = collector.push(frame.event);
        if (ended) { clearTimeout(timer); resolve(ended); return; }
      }
      if (frame.type === 'stream/error') { clearTimeout(timer); reject(new Error(JSON.stringify(frame.error))); return; }
    }
  })().catch((e) => { clearTimeout(timer); reject(e); });
});
api.events.follow(sessionId);                    // 先订阅、后 prompt，顺序不能反

await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: '你的提示词' }] });
const ended = await done;
console.log(ended.text);                         // 模型回复
await api.workspace.archiveSession({ sessionId }); // 一次性会话记得归档
```

三个容易踩的坑（都写在源码注释里）：

1. **会话目录必须是项目根**：实例只从会话目录向上找 `opencode.json`，换目录会话建不出来。
2. **先 `events.follow()` 再 `prompt`**：全局事件流不补发，反了就错过回合事件。
3. **`agentPreset` 直接映射 agent**：`qq-chat` 这类名字来自 `opencode.json`，用之前确认存在。

### 1.3 OpenAI 兼容壳（4610）—— 0.5.0 起可用

实例本身仍不是 OpenAI 协议（`POST /v1/chat/completions` 直连 4599 还是 405）。
0.5.0 起桥接会在旁边起一个小服务，把 OpenAI 请求**翻译成上面这套会话流程**
（`src/openai-shell.js`）。

- **开启**：桌面端「扩展 → 模型接入 · OpenAI 兼容壳」勾选启用；或 `config.json` 里
  `"openaiShell": { "enabled": true }`。默认关闭（升级不悄悄多监听端口）。
- **baseURL**：`http://127.0.0.1:4610/v1`（端口可改，避开 3000/3001/3100/3200/3210/4599/4600）。
- **鉴权**：`Authorization: Bearer <key>`。key 首次启动自动生成到
  `state/openai-shell.key`（扩展页可见、可一键换）；`config.json` 的
  `openaiShell.apiKey` 优先于这个文件。
- **模型**：`GET /v1/models` 返回实例的真实模型目录；请求里的 `model` 目前只回显，
  实际用哪个模型由模型池 + 故障转移决定（要固定模型请改模型池）。

```bash
curl http://127.0.0.1:4610/v1/chat/completions \
  -H "authorization: Bearer <key>" -H "content-type: application/json" \
  -d '{"model":"dh-matrix","messages":[{"role":"user","content":"你好"}]}'
```

Python / JS SDK 只改 `base_url` 和 `api_key` 两行即可。

一期已知边界（`NEXT-STEPS` 里写的「非流式先行」）：

| 项 | 现状 |
|---|---|
| 非流式 | ✅ 完整支持（`usage` 是按字数估的，不参与计费） |
| `stream: true` | ⚠️ **假流式**：全文一次性发完再 `[DONE]`，协议合规、内容正确，但没有逐字推送 |
| `tools` / function calling | ❌ 不转发（带了也不报错，模型看不到工具） |
| 多轮上下文 | 每条请求建一个新会话、结束即归档；历史靠客户端每次带全 `messages` |
| 后端依赖 | 只在内置实例模式（没配 `backend` 或 `matrix`）下启动；直连模型/CLI 后端时壳不启 |

> 之所以要「常驻一条事件流」而不是每请求开一条：`events.mux()` 的 `for await` 里
> `break` 不会关掉底层订阅，按请求开会持续泄漏 SSE 连接（`oc-client.js` 5.5 节）。
> 壳里全局只开一条，按 `sessionId` 分发给各个等待者。

`cf-shim`（4600）仍是另一条路，只服务 Cloudflare Workers AI 的模型，健康与否取决于
`CLOUDFLARE_API_TOKEN`。两者不冲突：要「同一个人格 + 模型池故障转移」用 4610，
只要 CF 模型用 4600。

---

## 2. 桌面端服务（3200）—— 本机脚本最省事的一条路

不需要懂 Agent 会话，直接调 REST（全部仅本机）：

> 0.5.0 起**所有会改状态的请求都过了同源闸门**：`Host` 必须是回环地址；
> 带了 `Origin` 就必须是本服务的源；`Sec-Fetch-Site: cross-site|same-site` 直接 403。
> curl / 脚本 / 入站 webhook 不带 `Origin`，照旧放行 —— 这条是为了挡住
> 「浏览器里的任意网页 POST 过来写插件」那条 RCE 链路。

### 2.1 让模型帮你干活：`POST /api/summarize`（✅ 实测到降级链）

```bash
curl -X POST http://127.0.0.1:3200/api/summarize \
  -H "content-type: application/json" \
  -d "{\"platform\":\"qq\",\"conv\":\"group:1045557553\",\"count\":60}"
```

返回 `{ok:true, summary, count, via, model}` 或人话错误。模型来源按顺序：
四档配置 → 「模型来源」直连 → 模型池免费档（逐个换）→ 内置实例（matrix 流程）。

### 2.2 给 QQ / 微信发通知：`/hook/notify/<口令>`（✅ 实测）

```bash
# 口令在桌面端「消息与任务 → Webhook 通知枢纽」里，或 GET /api/notify
curl "http://127.0.0.1:3200/hook/notify/<口令>?text=构建失败了"
curl -X POST http://127.0.0.1:3200/hook/notify/<口令> \
  -H "content-type: application/json" \
  -d "{\"text\":\"下载完成\",\"platform\":\"qq\",\"to\":\"123456\"}"
```

- `to` 支持 QQ 号（私聊）、`group:群号`（群聊）、微信用户 id；不传就用界面配的默认目标。
- 口令错 / 未启用 → 404。配套还有 `POST /api/notify/test`（支持 `dryRun:true`）。
- 微信消息转发：把微信 Hook 的地址填成这个通知地址，`{event:'message.received',from,text}`
  会按「转发规则」转出去 —— 这就是「微信消息镜像到 QQ」。

### 2.3 读消息：`GET /api/messages?platform=qq|wechat|phone&limit=300`

返回 `entries[]`（clock/conv/who/self/text）与 `contacts[]`，数据源是活动日志（最近数百条）。

---

## 3. 桥接控制台（3100）—— 运维脚本用

带 `x-console-token: <state/console-token 的内容>`（或 `?token=`），常用：

- `GET /api/status` —— 桥接全景（会话、白名单、模式、活动尾部）
- `GET /api/plugins` / `POST /api/plugins/reload` —— 插件列表与热重载
- `GET /api/whitelist` / `POST /api/whitelist`、`/api/role`、`/api/social`、`/api/test-send`、`/api/restart`

Host 必须是 127.0.0.1（跨站防护），脚本从本机调没问题。

---

## 4. 机器人协议侧（NoneBot2 / Koishi 看这里）

- **QQ**：桥接的 QQ 消息来自 NapCat（OneBot v11，HTTP 3000 / WS 3001）。
  机器人框架的标准做法是**直连 NapCat**（正向 WS 或反向 WS 都行），
  与本桥接互不冲突——NapCat 允许多客户端。
- **微信**：本项目微信侧走官方 iLink，出站 Hook 支持
  `default`（自有 JSON）/ `onebot`（OneBot v11 事件形状，喂给框架的适配器最省事）/
  `template`（自定义模板）三种格式，见桌面端「Hook」页。

---

## 5. 插件（进程内扩展，不走 HTTP）

如果目标是「给 QQ / 微信机器人加命令」，最省事的是写插件而不是外部服务：
`<桥接根>/plugins/*.js`，default 导出 `{ name, description, commands }`，
命令在 QQ / 微信两侧同时生效。示例与格式见 `plugins/example-hello.js`
和桌面端「高级 → 插件」卡片。⚠️ 插件拥有桥接进程同权限，只装信得过的代码。

---

## 6. 本文档的验证口径

- 4599 鉴权方式、405/401 行为、`/v1` 缺失：2026-10-21 本机 curl 实测。
- 会话流程（示例代码）：与 `npm run self-test` 同流程，当日通过。
- 3200 的 `/api/summarize`（含 11 个直连模型降级 + 实例兜底的报错路径）、
  `/hook/notify`（404/直发/dryRun）：当日实测。
- cf-shim 502：当日实测（本机 CF token 失效所致，链路代码是既有代码）。
- **OpenAI 兼容壳（4610）**：2026-10-23 端到端实测 —— 隔离数据根 + 独立实例（4699），
  `GET /v1/models` 返回 658 个模型；非流式 / `stream:true` / 多轮 messages / 无 key 401 /
  空 messages 400 / 未实现端点 404 全部通过；同一次请求里真实走了
  `bailian` 免费额度耗尽 → `zhipu` 401 → `cloudflare-workers-ai` 的降级链。
