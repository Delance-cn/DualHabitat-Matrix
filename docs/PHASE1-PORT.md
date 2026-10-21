# Phase 1 移植记录：把 DSH 侧换成 OpenCode

上游 `Derpyu520/qq-bridge`（已 clone 到 `upstream/`，commit `9df6a7e`）的 QQ 侧逻辑
（社交仿真、黑话学习、贴纸、语音、账本、控制台）**全部保留**，只把最底层的
"DSH API 客户端"换成"OpenCode API 客户端"。

Phase 0 的结论见 [`PHASE0-FINDINGS.md`](./PHASE0-FINDINGS.md)。

---

## 一、核心策略：同形状门面，而不是重写

`src/bridge.js` 有 62 万字节 / 1.1 万行，但它伸手到 DSH 客户端的地方**只有 4 个入口**：

```js
import { NodeApiClient, unwrap, createTurnCollector, discoverDshLaunchToken } from './dsh-client.js';
```

以及 12 个方法调用。所以 `src/oc-client.js` 的做法是：**对外提供一模一样的形状**
（方法名、返回值信封 `{result:{ok,value|error}}`、frame 类型都保持），
只在内部把 OpenCode 的 HTTP / 事件流翻译过去。

结果：`bridge.js` 的 import 行一个字都不用改，QQ 侧那 1.1 万行原样复用。
**改动面从"整个项目"缩到"事件生产层"** —— 这是整个移植里最关键的一个决定。

### 方法对照表

| DSH 方法（上游调用点） | OpenCode 实现 |
| ---------------------- | ------------- |
| `sessions.create({workspaceId, agentPreset})` | `session.create({location, agent})`，`agentPreset` 天然就是 agent id |
| `sessions.list({})` | `session.list({location})` |
| `sessions.prompt({sessionId, mode, content})` | `session.prompt({sessionID, text})`（ContentBlock → 纯文本） |
| `sessions.selectModel({sessionId, provider, model, reasoningEffort})` | `session.switchModel({sessionID, model})`，effort → `model.variant` |
| `workspace.create({path})` | **无此概念**：用目录模拟，`workspaceId` 就是目录路径 |
| `workspace.rename({workspaceId,title})` | 无对应，记账后 no-op |
| `workspace.archiveSession({sessionId})` | 退化成 `session.interrupt`（默认**不删**，怕丢历史账；`deleteArchived:true` 才真删） |
| `events.follow(sessionId)` | OpenCode 事件流是全局的，只登记 |
| `events.mux({})` | `event.subscribe()` + 翻译（见下表） |
| `agentPresets.list({})` | `agent.list({location})`（**必须带 location**，见 Phase 0 4.2） |
| `settings.describe/update({ns})` | **无命名空间**：用本项目的 `oc-settings.json` 兜底（QQ 侧只拿它存 `qq-mode` / `agent-presets`） |
| `respond({clientId,eventId,outcome})` | 审批 → `permission.reply`；提问 → `form.reply` |
| `stopSessionWork(sessionId)` | `session.interrupt({sessionID})` |
| `unwrap` / `createTurnCollector` / `blocksToText` | **逐字照抄上游**（契约不能漂） |

---

## 二、事件映射表（唯一"新写"的核心逻辑）

全部实测过形状（2.0.32，2026-10-17）。

| OpenCode 事件 | 产出的 DSH frame | 备注 |
| ------------- | ---------------- | ---- |
| `session.execution.started` | `session/event → turn/start` | 回合开始 |
| `session.text.delta` | `session/event → assistant/chunk` | 流式；上游 collector 故意忽略 |
| `session.text.ended` | `session/event → assistant/message` | 该消息的完整文本 |
| `session.step.ended` | `session/event → assistant/attempt` | **带 usage**（账本计价要用） |
| `session.tool.input.started` | （不产 frame） | 只登记 `callId → 工具名`（`called` 不带名字！） |
| `session.tool.called` | `session/event → tool/call` | `data{name, callId, arguments}` |
| `session.tool.success` / `.failed` | `session/event → tool/result` | `data.message{source.callId, content, isError}` |
| `session.retry.scheduled` | `session/event → llm/retry-started` | 账本靠它建"重试轴"，不建则重试的钱算错档 |
| `session.execution.succeeded/failed/interrupted` | `session/event → turn/end` | `reason.kind = completed/failed/interrupted`；**本机没有 `session.idle`** |
| `permission.asked` | `approval/requested` | 回复 `allowed-once/always/rejected` → `decision: once/always/reject` |
| `permission.replied` | （清理 pending） | |
| `form.created` | `question/requested` | 回复 `{answers:[{id,selected}]}` → `form.reply` 的 `{字段id:值}` |
| `session.error` / `stream.error` / `server.error` | `stream/error` | |

### token 用量口径

`session.step.ended.data.tokens` = `{input, output, reasoning, cache:{read, write}}`
→ 翻成账本认的 `{inputTokens, outputTokens, reasoningTokens, cacheReadTokens, cacheWriteTokens}`
（见 `model-prices.js` 的 `normalizeUsage`：DSH 的 `inputTokens` 语义是"未命中部分"，
OpenCode 的 `input` 同义）。**免费模型 provider 报价恒为 0，花费一律由本地价目表算。**

---

## 三、新增的语义发现（会咬人的）

### 3.1 `ask` 规则只覆盖它**自己匹配的资源**，其余照旧被基础策略放行

实测：配置里只写

```jsonc
"permissions": [ { "action": "shell", "resource": "echo *", "effect": "ask" } ]
```

则 `shell "echo phase1-marker"` 会弹审批，但 `shell "<任意别的命令>"` **直接放行** ——
因为官方基础策略的 `allow` 通配还在前面匹配着（最后匹配者胜出，ask 规则没匹配上就轮到它）。

**所以想要 fail-closed，`deny` 兜底必须写在同一个数组的第一条。** 只写白名单 = 全放行。

### 3.2 工具名要自己关联

`session.tool.called` **不带工具名**，名字在更早的 `session.tool.input.started` 的
`data.name` 里。必须在 `callId → name` 上做映射，否则桥接的工具日志会全是 `unknown`。

### 3.3 模型说的话不能当证据

Phase 0 已证：工具被藏掉时模型会**编造执行结果**。真机自测里也遇到过
模型用一个不匹配 ask 规则的危险命令、被基础策略静默放行的情况。
**桥接只认 `session.tool.*` 事件。**

---

## 四、文件对照

| 上游 | 本项目 | 处理 |
| ---- | ------ | ---- |
| `src/dsh-client.js` | `src/oc-client.js` | **重写**（本次的核心产出） |
| 其余 `src/*.js` | 原样复制 | 未改动 |
| `src/bridge.js` | 原样复制 | **尚未改 import**（见下） |

新增（本项目脚手架）：

| 文件 | 作用 |
| ---- | ---- |
| `src/oc-client.js` | **门面**：对外与 `dsh-client.js` 同形状，内部翻译 OpenCode（本次的核心产出） |
| `src/model-chain.js` | **有序候选链 + 失败分类 + 健康熔断/持久化** |
| `src/model-pool.js` | **模型池配置**的读取/校验/回退（策略与凭据分离） |
| `src/oc-server.js` | **服务器生命周期**：幂等起/停、注册文件等待、cf-shim 归属（④） |
| `src/oc-env.js` | 隔离环境：路径 / XDG / 密钥注入 / 代理探活 / CLI 解析 |
| `src/cf-shim.js` + `src/cf-shim-main.js` | CF 兼容代理（`content` 数组拍平、`null` 补 `""`）+ CLI 入口 |
| `models.json` | 运维改的那个文件：顺序、付费开关、用完的提示语（不含密钥，入库） |
| `spike/*.mjs` | 脚手架与自测（`oc-env.mjs`、`start/stop-server.mjs`、`cf-shim.mjs` 现在只是转发/薄壳） |

---

## 五、验证结果

测试清单（离线跑得飞快，真机需要 `node spike/start-server.mjs`）：

| 套件 | 类型 | 覆盖 |
| ---- | ---- | ---- |
| `spike/test-oc-client.mjs` | 离线 26 项 | 事件翻译、用量桶、工具事件、审批/提问往返、边界容错 |
| `spike/test-model-chain.mjs` | 离线 42 项 | 失败分类（用真实错误原文）、顺序、冷却、付费闸门、持久化 |
| `spike/test-model-pool.mjs` | 离线 47 项 | 配置优先级、写错时的回退、目录剔除 |
| `spike/test-failover.mjs` | 离线 47 项 | 换模型仍在同一 turn 内、全用完时回话、限流不换 |
| `spike/test-oc-client-live.mjs` | 真机 | 整条链路（含真实审批往返与工具执行） |
| `spike/test-failover-live.mjs` | 真机 | 首选"余额不足"时的自动切换 |
| `spike/test-pool-live.mjs` | 真机 | 随包发布的 `models.json` 在真实目录下可用 |
| `spike/test-oc-server.mjs` | 真机 | 起/停/复用/force 重启 + cf-shim 归属 |

### 离线（`node spike/test-oc-client.mjs`）26 项全过

覆盖：正常回合文本/终态、用量桶映射、工具调用与结果形状、审批往返（once/always/reject）、
提问往返、重试轴、失败原因、边界容错。

### 离线（`node spike/test-model-chain.mjs`）42 项全过

分类规则全部用**本机跑出来的真实错误原文**做样本（智谱 1113/1305/1220、HF 额度、
CF 免费套餐、CF 流格式、OpenRouter 402/429、密钥无效、工具权限拒绝、代理挂了/DNS 投毒）。

### 离线（`node spike/test-model-pool.mjs`）47 项全过

重点在**配置写错时的行为**（键名拼错、候选写成数字、冷却写成字符串、文件本身坏掉）
以及解析优先级。

### 离线（`node spike/test-failover.mjs`）47 项全过

最关键的一条：**换模型重试仍发生在同一个 turn 内**。所以断言不是"内部状态对不对"，
而是把调整后的帧直接喂给上游的 `createTurnCollector`，验最终的 turn 号和文本 ——
因为桥接正是靠这个 collector 按 turn 分组累积文本的。

### 真机（`node spike/test-failover-live.mjs`）全过

链的首选故意放一个确定没钱的付费模型（`zhipuai/glm-4.6`），第二顺位放能用的免费模型：

```
[client] 模型链已启用：zhipuai/glm-4.6 → zhipuai/glm-4.5-flash#none
[client] 模型熔断 zhipuai/glm-4.6（quota）：余额不足或无可用资源包,请充值。 429 provider.rate-limit
[client] 换模型重试 … → zhipuai/glm-4.5-flash#none
[client] 丢弃旧执行的 session.execution.interrupted（换模型中）
[client] 回合重试开始（沿用 turn turn-1）

✓ 回合正常结束（completed，耗时 2.0s）
✓ 拿得到回复文本："1+1等于2。"
✓ 用户视角只看到一个回合开始（turn/start=1）
✓ 换模型没有另起 turn（结束时的 turn -1 与开始一致）
✓ 首选被熔断且归类为 quota（不是限流）
✓ 没有重复收尾（turn/end 次数=1）
```

两处值得记下来的实测细节：

1. 首选返回的原文本是 `余额不足或无可用资源包,请充值。 429 provider.rate-limit` ——
   **同时含"余额不足"和"429"**。分类器把 quota 规则排在 rate 前面，所以判成 quota（长冷却），
   而不是被那个 429 骗成"限流 60 秒后重试"。这个顺序不是随手排的。
2. 日志里 `丢弃旧执行的 session.execution.interrupted` 说明**真机上 interrupt 确实会吐出
   旧执行的事件**。如果没有这个守卫，那条事件会走一遍失败分类，把**刚换上去的新模型**
   也熔掉 —— 一个"换一次模型就自毁一个候选"的自杀循环。

### 真机（`node spike/test-oc-client-live.mjs`）全过

```
✓ 发现端点 http://127.0.0.1:4599   服务 version=2.0.32
✓ workspace.create / sessions.create / sessions.selectModel → openrouter/openrouter/free
✓ 普通回合：collector 拿到 "2+2 等于 4。"，用量桶 input=8217 output=12
✓ 审批往返：permission.asked → approval/requested → respond(allowed-once) → 工具真的跑了
    [工具调用] [{"name":"shell","args":{"command":"echo phase1-marker"}}]
    [工具结果] ["phase1-marker"]
✓ stats 可读
```

---

## 六、模型候选链与自动熔断

需求原话：**"上一个用光了，就自动切换到可以用的，直到全部都用完"**，
外加"默认只会调用免费，但是有个开关可以切换"。

### 为什么做在门面（`oc-client.js`）里，而不是 QQ 侧

桥接只有到"这个回合失败了"这一步才知道出事，而**失败的原因**（余额不足 / 限流 /
模型不可用 / 连不上）只有门面看得到 —— 它是唯一读事件流的人。做在门面里有两个好处：

- QQ 侧 1.1 万行一行都不用动；
- 失败对用户是**无感**的：失败的回合不产出文本，桥接本来就不会发消息，
  换模型重试完全发生在同一个 turn 内。

### 硬约束：重试必须留在同一个 turn 内

桥接的 `createTurnCollector` **按 turn 号分组**累积文本，而且静默轮 / 唤醒轮标记是
按 turn 一一对应消耗的。所以"失败就结束 turn、再开一个新 turn 重试"是行不通的：

- 轻则回复被丢掉（文本挂在新 turn 上，collector 里根本没有这个 turn）；
- 重则把静默标记错位，**把本该静默的摘要回合当成正常回复发到群里**。

做法：失败的回合**所有帧全部吞掉**（不发 `turn/end`），换模型后用同样的话重发，
重试开始时不发 `turn/start` 并把 turn 号**恢复成原来那个**。桥接全程只看到
"一个 turn，最后成功了"。

### 失败分类（`classifyFailure`）

| 类型 | 样本 | 冷却 | 熔断？ |
| ---- | ---- | ---- | ------ |
| `quota` | `1113 余额不足`、`Insufficient credits`、`402`、HF 额度耗尽、Neurons 用尽 | 6 小时 | ✅ |
| `rate` | `1305 访问量过大`、`429`、`overloaded` | **60 秒** | ✅ |
| `unavailable` | `1220 无权访问`、CF 免费套餐不开放、`Invalid … stream event` | 24 小时 | ✅ |
| `auth` | `invalid api key`、`401` | 24 小时 | ✅ |
| `unreachable` | `ECONNREFUSED`、`getaddrinfo ENOTFOUND`（DNS 投毒）、代理挂掉 | 10 分钟 | ✅ |
| `other` | `ECONNRESET`（网络抖动）、**工具权限被我们自己拒掉** | — | ❌ |

两条"不熔断"的红线：

- **`permission.rejected` 绝不熔断**。它说明"模型好好的，是我们自己不让它用工具"，
  换模型毫无意义，反而会把免费额度白白烧在别的模型上。
- **`ECONNRESET` 这类抖动不熔断**。一次抖动就把最好的免费模型拉黑十分钟，
  这个功能会比没有更糟。但"连不上"（拒绝连接 / DNS 解析不了）是另一回事 ——
  本机实测 `huggingface.co` 就是被 DNS 投毒永久不可达，那种必须换。

### 时机：不等它把 10 次重试跑完

OpenCode 遇到 provider 报错会**原地重试（实测 10 次）**。余额不足这种错重试 10 次
纯属白等（真机实测：不优化的话要 **84 秒**才轮到我们换模型）。

所以除了 `session.execution.failed`，`session.retry.scheduled` 也接进熔断：
一眼能看出"用不了"的（quota/unavailable/auth/unreachable）**当场换**，
限流（`rate`）则让 CLI 自己重试 —— 限流本来就可能一次就过，换模型反而更慢。
实测效果：换模型在 **2.0 秒**内完成，重试帧 **0 次**。

### 换模型期间必须屏蔽旧执行的事件

`retry.scheduled` 阶段换模型时，旧执行还在跑（在退避里），必须先 `interrupt` 掐掉它，
否则新回合要排队，用户白等。而掐掉会吐出 `session.execution.interrupted`，
**这条事件会走一遍失败分类，把刚换上去的新模型熔掉**。

所以有一个 `_failoverPending` 守卫：换模型期间旧执行的
`retry.scheduled` / `failed` / `interrupted` 一律丢弃，直到重试的 `execution.started`
把守卫解除。真机上这条路径被真实触发过（见上一节的日志）。

### 全部用完：回一句话，而不是沉默

所有候选都熔断后：

- 正在进行的回合 → 合成一条 assistant 回复 + 把 `turn/end` 改成 **completed**
  （不改的话桥接看到 failed 就不发消息，用户什么也收不到），内容就是 `models.exhaustedNotice`；
- 后续新消息 → `sessions.prompt` **根本不调用模型**，直接合成
  `turn/start + 回复 + turn/end`，返回"已接受"。省掉一轮无谓的等待。

通知文案可配，默认是一句人话（`我这会儿 API 连不上了，等会儿再聊吧。`）。

> 早期默认值是 `429ERROR`，会原样发进聊天窗口，对方只看到一串错误码。
> 现在改成正常句子；老配置里的 `429ERROR` 仍然兼容，但建议改掉。

> 做成配置项 `models.exhaustedNotice`，
> 换文案不用改代码。

### 配置：`models.json`（运维只该改这个文件）

策略和凭据分开：`secrets.json` 是**凭据**（key），`models.json` 是**策略**（顺序 + 开关）。
换 key 不用碰顺序，改顺序不用碰 key。`models.json` 不含密钥，所以**入库**，是默认策略。

```json
{
  "enabled": true,
  "allowPaid": false,
  "exhaustedNotice": "我这会儿 API 连不上了，等会儿再聊吧。",
  "free": ["zhipuai/glm-4.5-flash#none", "..."],
  "paid": ["zhipuai/glm-4.6", "..."],
  "cooldownMs": {}
}
```

解析优先级：**显式传入 > `QQ_BRIDGE_MODELS`（路径或内联 JSON）> `models.json` > 内置默认**。
JSON 没有注释语法，所以约定**下划线开头的键一律当注释**（延续 `proxy.json` 的 `_comment` 写法）；
除此之外写错键名会**明确告警**，而不是让你以为自己配上了。

配置写错时的态度是"告警 + 回退到能跑的状态"，而不是静默变傻：

| 写错的样子 | 行为 |
| ---------- | ---- |
| `fre` 拼错 / `free` 写成字符串 | 告警 + 回退默认免费档 |
| 候选写成 `null` / `42` / `{}` | 丢掉那一项 + 告警 |
| `cooldownMs.rate` 写成字符串 | 忽略那一项 + 告警 |
| `exhaustedNotice` 写成空串 | 回退默认（群里不能发空消息） |
| 两档都空 / 只有付费却关着开关 | 告警（这是配置错误，但能启动） |
| **文件本身不是合法 JSON** | **直接抛错** —— 不能装作"没有配置文件" |

### 启动校验：目录里没有的候选自动剔掉

池子里写了目录里不存在的东西（最典型的是 `glm-4-flash`：它确实免费，但
**不在 OpenCode 目录里**，要靠配置生成器写一条自定义模型条目），
换到它头上时 `switchModel` 会失败，**链就卡在那儿，后面的候选永远轮不到**。

所以客户端一就绪就用 `model.list()` 过一遍，剔掉目录里没有的，并明确告警：

```
⚠️ 目录里没有这些候选，已从链里剔除：zhipuai/glm-4-flash#none
```

目录读不到时**什么都不做** —— 宁可保留候选，也别因为一次读失败就把链清空。

真机验证（`node spike/test-pool-live.mjs`，走的就是运维那条路，不传任何 inline 配置）：

```
链生效：zhipuai/glm-4.5-flash#none → cloudflare-workers-ai/@cf/zai-org/glm-4.7-flash → openrouter/openrouter/free
✓ 池子来自 models.json
✓ 目录里没有的 glm-4-flash 被剔掉，且有明确告警
✓ CF 候选在目录里、被保留
✓ 用池子首选真答一句话："3 乘 7 等于 21。"
✓ 没有候选被熔断（正常路径不踩坑）
```

### 付费闸门

`models.allowPaid` 默认 **false**。关着时链里只有免费候选，`pick()` 永远不会返回付费档 ——
"免费用完就真的没了（回一句人话），绝不偷偷花钱"。打开后免费候选耗尽会**自动降级**
到付费档；再关掉立刻回到"没有可用模型"。

### 状态落盘

健康状态写在 `<stateDir>/model-chain.json`，重启后不重复踩坑（真机验证：第二次起
直接就知道 `glm-4.6` 用不了，不用再失败一次）。过期记录会被丢弃，所以不是永久拉黑。

---

## 七、服务器生命周期（④）

`src/oc-server.js` 回答一个问题：**"要用的那个 OpenCode 到底在不在？不在就把它弄起来。"**

接口只有三个：`ensureServer()`（幂等）、`stopServer()`、`serverStatus()`。

### 为什么必须由桥接自己管

1. 这是**专用隔离实例**（独立 `XDG_*` 目录、独立 `opencode.db`、固定端口 4599），
   绝不能蹭桌面端后台那个 —— 蹭了 QQ 会话会混进桌面端的会话列表，密钥也归桌面端管。
2. 它比桥接**活得久**（`detached` 起）。所以"起来了吗"必须靠**注册文件 + 进程存活 +
   真答一次 API** 判断，不能靠"我这次 spawn 的 child 句柄"。
3. 桥接重连时希望它是幂等的：已经在跑就复用，不在才起。

### `--service` 不是可选项

只有 `serve --service` 才会把 `{ id, version, url, pid, password }` 写进
`$XDG_STATE_HOME/opencode/service.json`。裸 `serve` 只在 stdout 打印密码，
而桥接需要一份**可读、可重启后重建**的长期凭据（鉴权是 HTTP Basic）。

顺带一个容易搞混的点：`$XDG_CONFIG_HOME/opencode/service.json` 里**只有 password**，
没有 pid/url。要判活必须读 **state** 那份。

### "起好了"的定义：真答一次，而不是"进程还在"

`serverStatus()` 三层判断，缺一不可：

1. 注册文件在不在、有没有 `url`；
2. 里面的 `pid` 还活着（`process.kill(pid, 0)`）；
3. **真调一次 `server.info()`** —— 进程活着不等于服务能应答（可能正在启动，可能半死）。

启动时同理：等到"注册文件里是**这个** pid 写的 + `serverStatus()` 说 ok"才返回，
所以 `ensureServer()` 一旦返回成功，调用方可以直接开始用。

### 真机踩到的坑：环境是"启动那一刻"的

这一条值得单独记，因为它**第一次真机跑熔断时就被踩到了**：

`proxy.json` 指向 Clash 的 7897，服务是在 Clash 开着时起的；之后 Clash 关掉，
服务里仍留着 `HTTPS_PROXY=http://127.0.0.1:7897`，于是**所有** provider 请求
一起 `ConnectionRefused`，而当时"连不上"还被判成网络抖动，表现是**整轮静默失败**
（用户什么都收不到）——查起来极其费劲（重跑一次耗时 84.4 秒才报出来）。

所以代理必须**在起之前探活**，连不上就当没配：

```
[server] ⚠️ 代理 http://127.0.0.1:7897 连不上（Clash 没开？），本次**不启用**代理
```

这件事还带出两个后续改动：

- 分类器新增 `unreachable`（拒绝连接 / DNS 解析不了），**该熔断**：
  `huggingface.co` 被 DNS 投毒就是永久不可达，那种必须换；但 `ECONNRESET` 仍按抖动处理。
- `proxy.json` 里加了 `_comment`，写明"删掉这个文件即关闭"。

### cf-shim 的归属与生命周期

CF 的兼容代理（把 `content` 数组拍平、`null` 补 `""`）是**独立进程**，和 OpenCode
实例同生共死：

- 为什么不在桥接进程里跑一个 http server：OpenCode 比桥接活得久，桥接一崩 CF 就断，
  而 OpenCode 还以为 CF 可用 —— 变成"候选看着好好的、每次调用都失败"，最难查。
- 为什么默认只在"池子里真有 CF 模型"时才起：少一个进程就少一个故障点。
  这个判断和"要不要把 CF 写进链里"是**同一个判断**（`poolUsesProvider`），
  不会出现"起了没用"或"用了没起"。
- 健康检查是必需的：`GET /health`。没有它就没法区分"在跑"和"端口被别的进程占着"。

### 又一个真机踩到的坑：旧进程占着端口

第一次跑生命周期测试时，4600 上有个**早先手工起的旧版 shim**（没有 `/health` 路由）。
于是"健康检查不过 → 以为没起 → 再起一个 → `EADDRINUSE` 崩掉"，
表现是"shim 起了但没生效"，日志里只有一行 `EADDRINUSE`。

现在的处理是**先分清两种情况再决定**：

| 情况 | 处理 |
| ---- | ---- |
| `/health` 应答 | 复用它 |
| 端口被占、`/health` 不应答、**pid 是我们自己记的** | 收掉它再起新的 |
| 端口被占、`/health` 不应答、pid 不是我们的 | **明确报错**（含占端口这件事和处置建议），不再闷头起一个注定的失败品 |

### 只停"注册文件里那个 pid"

**绝不按端口杀进程**。用户桌面端可能也在用某个端口，误杀代价很大。
`stopServer()` 只停注册文件里的 pid（以及我们自己记的 shim pid），
停完删掉注册文件，避免"看着像在跑"的误判。

### 脚手架与生产代码的分家

`spike/oc-env.mjs` 和 `spike/{start,stop}-server.mjs` 现在是**转发/薄壳**：

| 生产代码 | 脚手架 | 说明 |
| -------- | ------ | ---- |
| `src/oc-env.js` | `spike/oc-env.mjs` | `export *` 转发。**不能有两份实现** —— 这份代码管密钥注入和代理探活，漂移的后果是"某个 provider 静默连不上" |
| `src/oc-server.js` | `spike/{start,stop}-server.mjs` | 薄壳，直接调 `ensureServer` / `stopServer` |
| `src/cf-shim.js` + `src/cf-shim-main.js` | `spike/cf-shim.mjs` | 转发 + 自动启动，方便手工排障 |

日志与 pid 文件统一收到 `.oc/`（整体可删可迁移）：`.oc/logs/`、`.oc/server.pid`、`.oc/cf-shim.pid`。

### 真机验证（`node spike/test-oc-server.mjs`）全过

这个测试会**真的停掉再拉起**实例（生命周期代码不真跑一遍没有意义）：

```
✓ 停止前在运行 → 停完之后确实不在运行
✓ 冷启动：新起、拿到真实 url、版本号、pid 是新的、注册文件 pid 与返回值一致
✓ 幂等：第二次 ensureServer 不再新起、复用同一 pid、地址一致
✓ cf-shim：池里有 CF 就起、真的在应答健康检查、没接线时吼出来
✓ force 重启：是新进程且仍能应答
✓ 停：服务进程和 shim 都停到，状态变成"不在运行"
✓ 停完能立刻重启（端口没被占住）
```

---

## 八、工具面与权限：Code Mode 的判决（② 的全部依据）

本节全部来自**真机探测**（`spike/probe-mcp.mjs`，阶段 a–h），不是读文档猜的。
之所以必须实测，是因为这里的失败模式**全是静默的**：工具会一个个从模型的 schema 里
消失，机器人照样聊天、一个错都不报。

### 8.1 2.0.32 的模型工具面不是"一堆函数"，而是 Code Mode

模型看到的主工具是 `execute`（在受限解释器里跑 JS），MCP 工具在沙箱里以
`tools.<服务名>.<工具名>` 出现（服务名 = MCP 注册名，工具名 = 原始名）。
实测 `Object.keys(tools)` = `["opencode","browser","qqtest"]`。

> 按"每个 MCP 工具 = 一个独立函数"去设计白名单，会一个工具都放不出来。
> 这是本次移植最容易踩空的一处。

### 8.2 动作名：`execute` 与 `<服务名>_<工具名>`，且支持前缀通配

- 沙箱本身的动作名是 `execute`；
- MCP 工具的动作名是 `<服务名>_<工具名>`（如 `qqtest_ping`）；
- **前缀通配有效**：`{"action":"qqtest_*","resource":"*","effect":"allow"}`
  同时放行了 `ping` 与 `echo_check`；
- 规则仍是**后匹配者赢**，所以 `deny */*` 必须写在同一个数组的**最前面**。

### 8.3 `deny */*` 会把 `execute` 一起藏掉

实测：只写 `deny */*` + 放行 `qqtest_*`、**不放行 `execute`** 时，模型手上零工具——
它把该执行的代码当普通文本吐了出来。**走 Code Mode 就必须放行 `execute`。**

### 8.4 沙箱的能力边界（阶段 G，真机实测）

| 能力 | 结果 |
| --- | --- |
| `fetch` | ✅ **可用，而且真的能出网**（探针打到本机 `127.0.0.1:4599` 拿到 200） |
| `console` / `tools` | ✅ 可用 |
| `process` / `require` / `module` / `Buffer` | ❌ `undefined` |
| `setTimeout` / `WebSocket` | ❌ `undefined` |
| 动态 `import()` | ❌ 语法层不支持（"restricted JavaScript-like language"） |
| 原型链逃逸 `({}).constructor.constructor` | ❌ 被拦 |

结论：`execute` **不给文件、不给进程，但给任意出网 HTTP**。而 DSH 的预设当初刻意
只给**受限的** `web-search-safe`、不给裸 `fetch`——所以只要放行 `execute`，
L7（模拟会话不得有本地执行/文件能力）在"本地"这半边成立，"出网不受限"这半边不成立。

### 8.5 判决：`codemode: false` 让 MCP 工具绕过沙箱，于是可以整条禁掉 `execute`

`codemode` 只存在于**新形状** `mcp.servers.<名字>` 下（旧的 `mcp.<名字>` 已废弃、无此字段）。

实测（阶段 H，同一份权限：`deny */*` + 放行 `qqtest_*`，**两者都不放行 `execute`**）：

| `codemode` | 模型看到什么 |
| --- | --- |
| `false` | **直接调用了 `qqtest_ping`**（工具事件名就是 `qqtest_ping`），拿到 `"pong"` |
| `true` | 零工具，只回 `NO_TOOLS` |

所以 ② 采用：**`mcp.servers.<名字>.codemode = false` + 整条不放行 `execute`**。

由此得到的性质正好是 DSH 的样子：

- 模型没有 `fetch`、没有沙箱、没有文件/进程；
- 每个 MCP 工具是**一等公民工具**，各自被 `<服务名>_<工具名>` 单独管；
- 放行的工具出现在 schema 里，没放行的**静默消失**（与 DSH 的
  `qq-tool-restrict.mjs` 语义一致）；
- 因为不放行的工具根本不在 schema 里，模型不会去调，也就**不会**产生
  `permission.rejected` 之类的噪声事件。

代价：没有 `execute` 就不能让模型自己写代码组合工具。对 QQ 聊天场景无影响。

### 8.6 顺带：权限被拒**不会**触发模型熔断

Code Mode 下调用未放行工具，沙箱回的是 `Unknown tool '<ns>.<tool>'.`——
一个 `execute` 内部的抛错，**不是** `session.tool.failed`，也不是
`permission.rejected`。配合第三节的失败分类，权限问题**不会**把模型判成"用光了"而熔断。

### 8.7 沙箱里那个 `opencode` 命名空间不是文件工具（阶段 I）

`tools` 的命名空间 = `["opencode","browser","<各 MCP 服务名>"]`。其中 `opencode`
里是**会话/工作区管理**类工具（`session_rename`/`session_move`/`worktree_create`/
`worktree_list`/`models`/`list_mcp_resources` …），**没有** `read`/`write`/`shell`。
所以文件与命令工具**不在沙箱里**，它们是直接工具 —— 由此进入 8.8。

### 8.8 内置工具是直接工具，且**以会话工作区为文件边界**（阶段 J，真机实测）

**动因**：用户要「所有者能干活（文件/命令），其他人只能聊天」。要定这一档的写法，
必须先知道文件/命令工具是不是也得经 `execute` 才拿得到。

四组实测（`deny *` 兜底，只放行一个动作名，**全程不放行 `execute`**）：

| 用例 | 放行 | 工作区 | 结果 |
|---|---|---|---|
| J2 | `shell` | 临时目录 | ✅ 直接调用 `shell {command:"echo probe-j2-ok"}` → 输出正确 |
| J3 | `read` | 临时目录 | 读**工作区内**文件 ✅ 成功；读**工作区外**文件 ❌ `isError=true` |
| J4 | `read` | 项目根 | ✅ 成功读到 `package.json` |

两条定论：

1. **`read` / `shell` 就是权限动作名，且是直接工具** —— 不需要 `execute`。
   于是「所有者档」可以**给文件+命令、同时整条禁掉 `execute`**（不给模型裸 `fetch`）。
   权限语义与 DSH 完全一致，L7 继续成立。
2. **文件工具的边界 = 会话工作区目录**（`workspace.create({path})` 的那个 path）。
   工作区外的一律读不到。**「工作区」就是文件权限的围墙**：
   - 这是安全特性：主人档的能力边界由工作区路径决定；
   - 但**绝不能把工作区设成 `C:\` 或用户主目录**，否则围墙形同虚设；
   - `shell` **不受**工作区约束（可 `cd` 任处），它才是真正的权力，主人档才放行。

> 坑：文件工具越界失败时，`session.tool.failed` 的正文是**坏掉的
> `"[object Object]"`**（`{"source":{"callId":…},"content":[{"type":"text","text":"[object Object]"}],"isError":true,"error":""}`）。
> 给 QQ 用户回错误时**不要**直接转发这个正文，要自己写人话。

---

## 九、下一步

**①②③④ 全部落地（2026-10-17 收尾）**，怎么跑见第十一节。

1. ~~**配置生成器（②）**~~ → 已落地 `src/oc-config.js`（见第十一节 11.2）。
2. ~~**① `bridge.js` 换 import**~~ → 已落地（见 11.1）。
3. `oc-settings.json` 的 `qq-mode` / `agent-presets` 与既有 `mode.json` 的关系要理顺（未做，不影响聊天）。
4. QQ 侧已通（NapCat + 私聊白名单），**群聊未验**（机器人号目前没有群）。
5. 多后端（codex / workbuddy）：`src/backends/` 注册表还没开始。

> **网关选择已变更**：QQ 入口就是**标准 OneBot v11**（`bridge.js` 只看
> `post_type`/`meta_event_type`/`message_type`/`status.good`），所以网关可替换。
> 现在改用 **NapCatQQ**（开源，避开 SnowLuma 那条 EULA 的部署限制）。
> `snowluma-conn.js` 已扩展成**按布局识别**：SnowLuma `config/onebot_<QQ>.json`
> （`networks`/`wsServers`/`accessToken`）与 NapCat `config/onebot11_<QQ>.json`
> （`network`/`websocketServers`/`token`）都认，并把 `0.0.0.0` 归一成 `127.0.0.1`。
> 离线回归见 `spike/test-gateway-layout.mjs`（21 项）。

> 免费链的定稿顺序：`zhipuai/glm-4.5-flash#none` → `zhipuai/glm-4-flash` →
> CF `glm-4.7-flash` → `openrouter/free`；付费档默认关闭。免费链里有 CF 模型时
> 需一并拉起 `cf-shim`（见第七节）。

---

### 当前待收尾的风险点

- ~~`opencode.json` 现在还是**开发态**~~ → 已由 `src/oc-config.js` 生成：
  `permissions` 第一条是 `* → deny`，只放行 `snowluma_*`（QQ 工具）。
  读回实测：`[* allow(官方基础) → env ask → * deny(我们) → snowluma_* allow → browser deny]`，
  后匹配者胜出 → 除 QQ 工具外**零工具**。
- 桌面端 OpenCode 2.0.32 全程未受影响（隔离实例用独立 XDG、独立端口）。

---

## 十一、收尾：①② 落地与三个新踩的坑

### 11.1 ① `bridge.js` 换 import（3 处改动）

```js
// 1. import
- import { NodeApiClient, unwrap, createTurnCollector, discoverDshLaunchToken } from './dsh-client.js';
+ import { NodeApiClient, unwrap, createTurnCollector, discoverDshLaunchToken } from './oc-client.js';
+ import { ensureServer } from './oc-server.js';
+ import { PATHS } from './oc-env.js';

// 2. 建客户端前先确保实例在跑（幂等）
+ const stateDir = cfg.opencode.stateDir || PATHS.state;
+ await ensureServer({ log });
+ const api = new NodeApiClient(cfg.opencode.baseUrl || undefined, undefined, { stateDir, sessionDir: stateDir, log });

// 3. loadConfig 增加 opencode 段（baseUrl 留空 = 自动发现）
```

`nominalModel()` 也改成从候选链取首选（账本按它计价），控制台 `/api/dsh/model`
一并跟着链走 —— 否则界面会显示 `deepseek-flash` 这种已经不存在的模型。

门面补齐了三个上游会调、之前没实现的方法：`callUnary`（把
`session.modelCatalog` 翻成按 provider 分组的模型目录，`variants` 的键就是思维链档位）、
`events.forget`、`sessions.modelCatalog`。**缺 `events.forget` 的后果很隐蔽**：
它发生在"会话退役"路径上，抛 TypeError 之后表现为"旧会话换不掉、一直对着它重试"。

### 11.2 ② `src/oc-config.js`（配置生成器）

- 人设正文**原文照搬**上游 `upstream/dsh/agent-presets/<id>/agent.cordis.yml` 的
  `persona.prefix`，只替换 `{{model}}` / `{{cwd}}` 两个模板变量（DSH 是每条消息渲染，
  OpenCode 的 `agents.<id>.system` 是静态串，只能生成时替换一次）。
  第一句 "You are a coding agent…" 在 QQ 聊天档改掉了 —— 零工具还自称 coding agent，
  模型会去尝试干本地活然后编结果。
- 生成三个 agent：`qq-chat`、`qq-chat-v2`（人设来自同名 preset）、`qq-work`（主人档，
  给 `read/write/edit/grep/glob/shell`，**不给 `execute`**）。
- `mcp.servers.snowluma`（`codemode: false`）+ 只放行 `snowluma_*`。
- 模型池里有 CF 时把 `provider.cloudflare-workers-ai.options.baseURL` 指到 `cf-shim`。
- 跑法：`npm run gen:config`。改 `models.json` 或上游预设之后要重跑。

### 11.3 三个新坑

**坑一：`@snowluma/sdk` 的 ESM 断链（1.14.20 ~ 1.14.22 都有）。**
发布的 dist 里相对导入不带扩展名（`export … from './client/api-client'`），
Node 22 的 ESM 解析器不补 `.js` → `import '@snowluma/sdk'` 直接
`ERR_MODULE_NOT_FOUND`，桥接起不来。`--experimental-specifier-resolution=node`
在 Node 22 已经没了。修法：`scripts/patch-snowluma-sdk.mjs` 在安装后把 45 处导入
补齐（幂等），已挂到 `postinstall`。

**坑二：OpenCode 只从"会话目录"读 `opencode.json`，不向上找。**
`agent.list({location:{directory: state/agents}})` 返回**空**，
只有 `location = 项目根` 才看得到 `qq-chat`。而桥接默认把会话建在
`state/agents` 下 —— 于是 `dshPresetIds` 为空、`resolvePresetName` 走 strict
返回空、`ensureSession` 抛"拒绝为 xxx 创建会话"。
修法：`config.json` 的 `sessionCwd` 必须填项目根。

**坑三：`agentPresets.list({})` 不带 location 会返回空。**
Phase 0 记过这条，但门面里还是漏了兜底。已在 `oc-client.agentPresets.list`
里默认 `directory = process.cwd()`（= 实例工作目录 = 项目根）。

### 11.4 验证

```
node spike/smoke-port.mjs    # 实例起得来、模型目录、agent 列表、链状态
node spike/verify-config.mjs # 生成的 agents 生效 + 读回生效权限规则集
node spike/smoke-turn.mjs    # 真跑一个回合：qq-chat 会话 → prompt → 拿到文本
```

`smoke-turn` 实测输出：

```
[turn] 会话 ses_eb65611deffe94y0v1Y2WG5KTm
[turn] 回合结束 reason={"kind":"completed"}
[turn] 回复文本："你好！我是QQ群聊助手，可以帮你回答问题和进行日常交流。"
```

即：**人设生效了**（它自称群聊助手而不是编程助手），链路是通的。

### 11.5 怎么跑

```bash
cd "C:\Users\<用户>\Documents\默认项目\DualHabitat-Matrix"
npm start          # 桥接；会自己把隔离实例（4599）和 cf-shim（4600）拉起来
```

前提：NapCat 已登录机器人号（你登录机器人用的 QQ 号），OneBot HTTP 3000 / WS 3001 在监听。
控制台：<http://127.0.0.1:3100>（token 在 `state/console-token`）。

---

## 十、provider / key 现状（多 key）

`secrets.json`（已 gitignore）以「环境变量 → 值」扁平映射注入，**增删任意 provider 都不用改代码**。

| provider | 环境变量 | 状态 | 说明 |
| -------- | -------- | ---- | ---- |
| `zhipuai` | `ZHIPU_API_KEY` | ✅ **可用，且有免费模型** | **不依赖代理（国内直连就通）**。`glm-4.5-flash` 在 models.dev 目录里 **cost 就是 `0/0`**（官方口径免费），中文母语、支持工具、131k 上下文。加 `#none` 变体关掉思维链后 **798ms**（直连）/ 3.1s（经 OpenCode） |
| `cloudflare-workers-ai` | `CLOUDFLARE_API_KEY` + `CLOUDFLARE_ACCOUNT_ID` | ✅ 可用（**需兼容代理，见下**） | 免费套餐每天 10,000 Neurons；27 个模型里 **3 个**同时满足"免费套餐开放 + 走 OpenCode 流正常 + 支持工具"。**注意 OpenCode 要的是 `CLOUDFLARE_API_KEY`，不是官方文档的 `CLOUDFLARE_API_TOKEN`** —— 不查 models.dev 目录发现不了 |
| `nvidia` | `NVIDIA_API_KEY` | ✅ 可用（**每次调用扣 credits**） | 81 个可见模型、66 个支持工具；`z-ai/glm-5.3-flash` 这类旗舰也能调（智谱免费档调不动的它这里能调）。注册送的 1,000 credits 用完即止，**不算"永久免费"**，适合当付费档或应急 |
| `openrouter` | `OPENROUTER_API_KEY` | ✅ 可用 | 398 个模型；`openrouter/openrouter/free` 零成本且支持工具调用 |
| `huggingface` | `HF_TOKEN` | ❌ **免费用户零额度** | 官方定价文档（`hub-docs` 的 `pricing.md` 原文）：`Free Users → Monthly Credits: None`，**免费用户没有任何月度额度，必须先买 credits 或升 PRO**。PRO 是 $9/月只给 $2 额度，做推理不划算。token 有效（whoami 200，账号 `DelanceCN`）但所有付费推理一律 402 |

### 智谱（GLM）：免费额度确实存在，但只在 flash 档

实测这把 key（`<32hex>.<16chars>` 格式），国内 `open.bigmodel.cn` 与国际 `api.z.ai`
**两个入口行为完全一致**：

| 模型 | 结果 | 说明 |
| ---- | ---- | ---- |
| `glm-4.5-flash` | ✅ **免费** | 目录 cost `0/0`，工具 ✓，中文最好 |
| `glm-4-flash` | ✅ **免费** | 工具 ✓，**不在 OpenCode 目录里**，要自定义模型条目 |
| `glm-4.5-air` | ✅ 通（但目录 cost `0.2/1.1`） | 不能确定长期免费，不列入默认 |
| `glm-4.6v-flash` | ⚠️ `1305 访问量过大` | 免费但被限流到不可用 |
| `glm-4.7-flash` | ⚠️ `1305 访问量过大` | 同上 |
| `glm-4.6` / `glm-5.3-flash` | ❌ `1113 余额不足` | 要充值 |

**思维链必须关**（`glm-4.5-flash` 是 `reasoning_options:[{type:"toggle"}]`）。
OpenCode 已经把它暴露成变体，**不需要改配置文件**：

```
[model] glm-4.5-flash  variants=["none","thinking"]
```

同一句群聊提示词实测：`#thinking` 30.1s → 默认 8.4s → **`#none` 3.1s**（直连 API 只有 0.8s，
多出来的是 OpenCode 自己的开销）。**群聊场景一律用 `#none`。**

### Hugging Face：不是网络问题，是"免费用户没有额度"

网上流传的"HF 每月送免费额度"是**旧政策**。现行官方表格（取自 GitHub 上的文档源文件，网页是前端渲染抓不到正文）：

| 账户类型 | 每月额度 | 备注 |
| -------- | -------- | ---- |
| **Free Users** | **None** | 必须先买 credits |
| PRO Users | $2.00 | 订阅 $9/月 |
| Team/Enterprise | $2.00 / 席位 | |

且 router 目录里 **133 个模型没有任何一个 provider 的 `is_free` 为 true**。
→ **HF 不放进候选链**，与网络无关（代理已修好网络，卡的是余额）。

### Cloudflare Workers AI：一个字段的兼容断层（已定位+已修）

免费套餐**按模型开放**：旗舰模型（`glm-5.3*`、`glm-5.2`、`kimi-k2.6/k2.7-code`、`deepseek-v4-pro/flash`）
一律 `not available on the Workers Free plan`。官方定价页明确列出这批"需要绑付费方式"的模型。

27 个目录模型逐个体测后，**只有 3 个同时满足全部条件**：

| 模型 | 工具调用 | 每回合 Neurons | 每天约 | 中文 |
| ---- | -------- | -------------- | ------ | ---- |
| `@cf/zai-org/glm-4.7-flash` | ✓ | 42 | **~236 条** | 母语级（智谱） |
| `@cf/google/gemma-4-26b-a4b-it` | ✓ | 66 | ~151 条 | 良好 |
| `@cf/openai/gpt-oss-120b` | ✓ | 228 | ~43 条 | 良好（推理模型） |

（按每回合输入 6,900 token + 输出 120 token 估；输入基数大是因为每回合都带完整系统提示。）

**排除的**：
- `llama-3.3-70b-instruct-fp8-fast`、`llama-4-scout-17b`、`mistral-small-3.1-24b` —— 走 OpenCode 报
  `Invalid cloudflare-workers-ai stream event`（流分片形状不被接受，与请求无关）；
- `llama-3.1-8b-instruct-fp8` —— models.dev 目录标 `tool_call: false`，OpenCode **不给它发工具**，
  它于是自己编了个工具调用当文本吐出来（正是 3.3 记过的幻觉陷阱），看着"成功"其实不可用。

#### 断层的确切位置（只有一个字段）

用本地日志代理抓住 OpenCode 真实请求体后，一目了然：

| 请求 | `messages[].content` 形态 | CF 结果 |
| ---- | ------------------------- | ------- |
| #0–#2 普通轮 | 全是 `string` | 200 OK |
| **#3 工具调用后** | 助手消息（只有 `tool_calls`）**`content: null`** | **400** |

```
AiError: Bad input: oneOf at '/' not met ...
Type mismatch of '/messages/4/content', 'string' not in 'null',
required properties at '/messages/4' are 'role,content'
```

即：**CF 的 schema 要求每条消息都必须有字符串 `content`，而 OpenCode 在"纯工具调用"的助手消息上发 `null`。**
不是"CF 不兼容 OpenCode"，是一个字段。`spike/cf-shim.mjs` 在代理层把数组拍平、`null` 补成 `""`，
补完之后**工具调用 + 审批往返端到端全过**。

#### 免费/付费模型链（定稿）

**默认（免费）**，按顺序降级：

1. **`zhipuai/glm-4.5-flash#none`** —— 免费（目录 cost `0/0`）+ 中文母语 + 工具 ✓ +
   **直连不需要代理** + 3.1s。这是首选。
2. `zhipuai/glm-4-flash` —— 同样免费；**不在 OpenCode 目录里**，需在 `opencode.json`
   的 `provider.zhipuai.models` 里自定义一条。
3. `zhipuai/glm-4.5-air` —— 通但目录标价非零，作为不确定项备用。
4. `cloudflare-workers-ai/@cf/zai-org/glm-4.7-flash` —— 每天 10k Neurons 额度内（~236 条/天），
   **需要兼容代理 + Clash**，作为第三梯队。
5. `openrouter/openrouter/free` —— 跨厂商兜底，零成本。

**开关打开（付费）**：`zhipuai/glm-4.6`、`glm-5.3-flash`（需充值）+ OpenRouter 付费模型
（`OPENROUTER_API_KEY` 已就绪）+ NVIDIA（`NVIDIA_API_KEY`，81 模型，扣 credits）。

> HF 不列入；NVIDIA 不是永久免费（credits 用完即止），默认档不启用。

### 代理（已做进隔离环境）

本机 `huggingface.co` 被 DNS 投毒（解析到 `2a03:2880:…:face:b00c` = Facebook 段），
必须走本地代理。已实现：

- `proxy.json`（或 `QQ_BRIDGE_PROXY`）配置代理地址，本机是 Clash Verge 的 `127.0.0.1:7897`；
- Node 24 的 `fetch` **默认不认** `HTTPS_PROXY`，必须同时设 `NODE_USE_ENV_PROXY=1`（实测对比过）；
- **启动前探活**（`probeProxy`）：代理连不上就退回直连并告警。
  没有这一步就有个很坑的失败模式：Clash 一关，`HTTPS_PROXY` 指向死端口，
  **连本来直连就通的 openrouter 也会一起挂**。实测两种情况都验过。

### Cloudflare token 的一个限制

Workers AI 的 token 通常只授单账号的 Workers AI 权限，于是
`/accounts`、`/memberships`、`/user/tokens/{id}` **全部 403 或空** ——
**account id 没法从 token 反查，只能人工提供**。


### HF 不可达的真因（不是 token 的问题）

```
huggingface.co        → 31.13.67.33 / 2a03:2880:…:face:b00c:0:25de   ← Facebook 段
router.huggingface.co →                2a03:2880:…:face:b00c:0:25de   ← 同一特征
curl -4 https://router.huggingface.co/v1/models → HTTP 000
curl    https://openrouter.ai/api/v1/models     → HTTP 200   ← 对照组正常
```

`face:b00c` 是 Facebook AS 的特征串，**典型的 DNS 投毒**；连查 `1.1.1.1` 都返回同样的
投毒结果（DNS 查询本身被劫持）。

接上代理后已能到达 HF，结论随之更新：**token 有效（whoami 200），真正卡住的是账户零额度**
（`402 provider.quota`，见上表）。也就是说网络这条路已经修好了，剩下的是付费问题。

**在解决之前不要把 `huggingface/*` 放进模型候选链** —— 会连重试 10 次后超时，
白白让用户等 90 秒。

