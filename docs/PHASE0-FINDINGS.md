# Phase 0 结论：OpenCode 侧集成可行性

> 时间：2026-10-17 · 环境：OpenCode **2.0.32**（desktop 自带 CLI）、Node v24.20.0、Windows
>
> 目标：在**完全不动 QQ 侧**的前提下，验证 DualHabitat-Matrix 改接 OpenCode 所需的 6 个关键能力。
> 结论：**架构全部可行；唯一的阻塞项是"模型来源"。**

---

## 一、结论速览

| # | 未知项 | 结论 | 证据 |
| - | ------ | ---- | ---- |
| 1 | 事件流能否给出**回合结束 + 最终文本** | ✅ 可以 | `session.text.ended` → `data.text`；结束信号是 `session.execution.succeeded\|failed\|interrupted`（**没有** `session.idle`） |
| 2 | **审批往返**（工具要授权） | ✅ 可以，且比 DSH 更好 | `permission.asked` → `permission.reply({decision})` → 工具继续 → `session.tool.success` |
| 3 | 独立实例 + 鉴权 | ✅ 可以 | 注册文件在 **XDG state** 目录，鉴权是 **HTTP Basic** |
| 4 | token / 成本统计 | ✅ 可以 | `session.stats({})`，区分 `cache.read/write`；`session.step.ended` → `data.tokens` |
| 5 | 长期无人值守 | ✅ 可以 | 无需交互登录；注册文件每次启动重写，桥接启动后读取即可 |
| 6 | **工具面锁死**（fail-closed） | ✅ 可以，但有 3 个反直觉的坑 | 见第四节 |
| 7 | **模型来源** | ⚠️ 免费额度不可用；**真实 provider key 已验证可用** | 见第三节 |

---

## 二、已验证的接口事实

### 2.1 发现与鉴权（官方 SDK）

用官方 `@opencode/client@2.0.32`，不要自己反推鉴权头：

```js
import { OpenCode } from '@opencode/client';
import { Service } from '@opencode/client/service';

const endpoint = await Service.discover({ file: '<XDG state>/opencode/service.json' });
const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });
```

要点：

- **注册文件在 XDG state 目录**：`$XDG_STATE_HOME/opencode/service.json`，内容是
  `{ id, version, url, pid, password }`。
  （`$XDG_CONFIG_HOME/opencode/service.json` 只有 `{ password }`，不是发现用的那个。）
- 鉴权是 **HTTP Basic**（`{ type: 'basic', username, password }`），**不是** Bearer。
  早期用 `Authorization: Bearer` / `x-opencode-password` / `?password=` 全部 401。
- 必须用 `--service` 启动：只有该模式会写注册文件。
- **不能用 `Service.ensure()` 代管进程**：它的 `env` 只能**追加**变量，无法**删除**
  继承来的 `OPENCODE*`（尤其 `OPENCODE_SESSION_ID`）。桥接必须自己 spawn 服务、
  用干净环境，然后用 `discover()` + `headers()` 连上去。

### 2.2 会话与模型

```js
await client.session.create({
  title, agent,                                  // agent 可选
  model: { providerID, id, variant },            // 建会话时钉死模型
  location: { directory },                       // 绑定工作目录
  permissions: [{ action, resource, effect }],   // 会话级权限覆盖（可选）
});
await client.session.prompt({ sessionID, text });
```

- 模型目录：`client.model.list()`；当前机器有 `opencode/deepseek-v4.1-flash-free`
  （`tools=true`，`text`+`image`，variants `low|high|max`）。
- 切模型/切 agent：`client.session.switchModel` / `client.session.switchAgent`。

### 2.3 事件流（`client.event.subscribe()`）

订阅是**实时、无回放**的，必须在 `prompt` **之前**订阅。实测关键事件：

| 事件 | 关键字段 | 用途 |
| ---- | -------- | ---- |
| `session.text.started/delta/ended` | `data.delta` 增量、`data.text` 最终全文 | 组装回复 |
| `session.reasoning.*` | 同上 | 思考过程（可选展示） |
| `session.tool.called` | `data.input`、`data.executed` | 工具调用开始 |
| `session.tool.progress` | `data.shellID` 等 | 长命令进度 |
| `session.tool.success` | `data.content[].text`、`data.metadata.exit` | 工具结果 |
| `session.tool.failed` | `data.error` | 工具失败 |
| `permission.asked` | `data.id`、`data.action`、`data.resources[]`、`data.save[]` | **转发给 QQ 用户审批** |
| `permission.replied` | — | 审批已回填 |
| `session.step.ended` | `data.tokens`、`data.finish` | 单步 token |
| `session.usage.updated` | `data.tokens`、`data.cost` | 累计用量 |
| `session.execution.succeeded/failed/interrupted` | `session.execution.failed` 带 `data.error` | **回合结束信号** |
| `session.retry.scheduled` | — | CLI 自己在重试（实测不可用模型会连试 10 次后放弃） |

> 注意：本机从未出现 `session.idle`。等回合结束请等 `session.execution.*`。

### 2.4 审批往返（实测完整链路）

```
session.tool.called    input={"command":"echo phase0-marker"} executed=false
permission.asked       action=shell resources=["echo phase0-marker"] save=["echo *"]
  → client.permission.reply({ sessionID, requestID, decision: 'once' })
permission.replied
session.tool.success   content="phase0-marker\r\n"  metadata.exit=0
```

- `decision` 取值：`once` | `always` | `reject`。
- `resources[]` = **具体要批准什么**（直接进 QQ 消息）；
  `save[]` = **"总是允许"的模式**（直接做"以后都允许"按钮）。

### 2.5 统计

`client.session.stats({})` → 会话数、prompt 数、step 数、token（分
`input/output/reasoning/cache.read/cache.write`）、`cost`、工具调用数、按模型分组。

---

## 三、阻塞项：免费额度不可用于桥接

现象：用 HTTP API 驱动的会话，前几次成功，之后**稳定**被拒：

```json
{ "type": "provider.auth", "status": 403,
  "error": { "type": "FreeTierError",
    "message": "OpenCode's free tier can only be used from within OpenCode." } }
```

排查过程与结论：

| 猜测 | 测试 | 结果 |
| ---- | ---- | ---- |
| 是 `OPENCODE_CLIENT` 身份闸门 | 还回 `OPENCODE_CLIENT=desktop` 重启 | ❌ 仍被拒 |
| config / 凭据差异 | 对比两实例 `config.get` / `credential.list` / `provider.list` | 完全一致 |
| 本地身份/额度文件 | 对比 XDG 各目录 + DB 表结构 + `kv` 表 | 无差异（账号/凭据表两边都空） |
| 只是我们的实例被拒 | **直接通过桌面端自己的服务建会话并推理** | ❌ **桌面端同样 403** |
| 是短期限流 | 等 90 秒重试、换 `glm-5.3-flash-free` | ❌ 仍被拒 |

**结论**：免费额度对"通过 HTTP API 驱动的会话"不可靠（先用后拒，桌面端 API 同样被拒）。
QQ bot 需要长期连续请求 —— **必须换成真实 provider key**。

### 已验证的替代路径

隔离实例能驱动任何真实 provider，**只差一个 key**：

```powershell
$env:DEEPSEEK_API_KEY = '<真实 key>'
node spike/start-server.mjs
node spike/list-models.mjs deepseek      # → deepseek/deepseek-flash、deepseek-v4-pro 出现
```

用**假 key** 试连通性，得到的是**服务商真实的 401**（证明请求确实打到了 api.deepseek.com）：

```json
{ "type": "provider.auth", "status": 401,
  "message": "Authentication Fails, Your api key: ****test is invalid (request_id: 6101cf61-…)" }
```

同理适用于任何 OpenAI 兼容 provider（OpenRouter、各类中转等）。

### 零成本路径（已验证可用）

OpenRouter 有免费模型，官方免费路由是 `openrouter/openrouter/free`（自动落到当前可用的免费模型）。

| 项 | 实测结果 |
| -- | -------- |
| `openrouter/openrouter/free` 基础对话 | ✅ 正常返回，tokens 正常，cost 0 |
| 同上，**工具调用**（连续 2 次） | ✅ 两次都真实执行了 `echo`，拿到 `session.tool.success` |
| `openrouter/google/gemma-4-31b-it:free` | ❌ 不可用：CLI 连续 10 次 `session.retry.scheduled` 后放弃 |

结论：**隔离实例可以零成本跑，而且免费路由支持工具调用** —— 桥接的默认模型可以定它。

注意事项：

- 免费路由每次可能落到**不同**模型，行为一致性没有保证（工具调用实测两次都 OK，但不保证）。
- 免费额度有速率/日限（社区文章给的是 30 req/min、1M token/天，各模型独立，会变）。
- 官方免费模型要求带 `HTTP-Referer` / `X-Title` 头，否则 402 —— **实测 OpenCode 已经带上了**，无需额外配置。
- 免费模型可能被滥用限制/封 IP，**不能作为唯一来源**，必须配回退。

### 多 provider / 多 key 设计（已定）

OpenCode 的 provider **全部靠环境变量激活**（其自带目录里 232 家都是这个机制；
实测 `DEEPSEEK_API_KEY` → deepseek 出现、`OPENROUTER_API_KEY` → openrouter 出现）。
所以桥接的 key 管理就是一个扁平映射文件 `secrets.json`：

```json
{
  "OPENROUTER_API_KEY": "sk-or-...",
  "DEEPSEEK_API_KEY": "sk-...",
  "SILICONFLOW_API_KEY": "sk-..."
}
```

- 启动隔离实例时由 `isolatedEnv()` 注入（见 `spike/oc-env.mjs`）—— **增删任意一家的 key 都不用改代码**。
- 已加入 `.gitignore`。
- 常用 provider 的变量名（从 models.dev 目录提取）：
  `deepseek`→`DEEPSEEK_API_KEY`、`openrouter`→`OPENROUTER_API_KEY`、
  `siliconflow`→`SILICONFLOW_API_KEY`、`zhipuai`→`ZHIPU_API_KEY`、
  `moonshotai`→`MOONSHOT_API_KEY`、`alibaba`→`DASHSCOPE_API_KEY`、`groq`→`GROQ_API_KEY`。
  查全部 232 家：`node --experimental-sqlite spike/dump-provider-catalog.mjs <关键字>`。
- 模型选择应做成**候选链**：默认 `openrouter/openrouter/free`（零成本），
  失败或需要更强能力时按序回退到付费模型。

---

## 四、工具面锁死（已端到端验证）

> **⚠️ 本节部分内容已被 Phase 1 推翻，以 `docs/PHASE1-PORT.md` 第八节为准。**
> 本节的"动作名 = 工具名、每个工具一个函数"的模型**不成立**：2.0.32 的模型工具面是
> **Code Mode**（主工具是 `execute`，MCP 工具经沙箱以 `tools.<服务名>.<工具名>` 暴露）。
> 实测结论：`codemode: false` 可让 MCP 工具绕过沙箱成为**直接工具**，从而整条禁掉
> `execute`、不给模型 `fetch`。本节关于"规则顺序/后匹配者赢""三种不给工具的语义"
> 的部分仍然有效。

### 4.1 先记住：OpenCode 权限默认全放行

> Every agent, including custom agents, starts with this ordered base policy:
> `[{ "action": "*", "resource": "*", "effect": "allow" }, …]`

DSH 那套"仿真会话绝不给 bash/文件工具"在 OpenCode 里**必须显式实现**。

### 4.2 实测：规则顺序与生效方式

本机实配（`opencode.json`）：

```jsonc
"permissions": [
  { "action": "*", "resource": "*", "effect": "deny" },
  { "action": "shell", "resource": "echo *", "effect": "allow" }
]
```

用 `agent.list({ location: { directory } })` 读回的 `build` agent **生效规则集**：

```
allow  */*                    <- 官方基础策略
ask    read  *.env
ask    read  *.env.*
allow  read  *.env.example
allow  question *
deny   */*                    <- 来自 opencode.json
allow  shell "echo *"         <- 来自 opencode.json（同数组内靠后 -> 胜出）
deny   browser *              <- 软件内置，追加在最后
```

三条必须记住的结论：

1. **顺序**：配置里的 `permissions` 追加在官方基础策略**之后**、软件内置规则**之前**；
   求值是**最后匹配者胜出**。所以"兜底全禁 + 白名单"必须写在**同一个数组内、deny 在前**。
2. **动作名**：`read` / `edit` / `glob` / `grep` / `shell` / `subagent` / `skill` /
   `question` / `webfetch` / `websearch` / `external_directory` /
   **`<server>_<tool>`（MCP 工具）**。支持整值通配 `*`。
3. **必须传 `location`**：`agent.list()` 不传 location 拿到的是"默认目录"的解析结果，
   看不到项目配置（实测：不传时规则集里没有我们写的规则）。桥接所有项目相关调用都要带
   `location.directory`。

### 4.3 实测：三种"不给工具"的语义完全不同

| 配置 | 工具是否出现在模型可用列表 | 拒绝时的表现 |
| ---- | ------------------------- | ------------ |
| 该动作**完全没有** allow 规则（纯 `deny */*`） | ❌ 不出现（从 schema 消失） | **静默**：无任何 tool 事件 |
| 有 allow 规则但本次资源不匹配 | ✅ 出现 | `session.tool.failed` → `{"type":"permission.rejected","message":"Permission denied: shell"}` |
| `effect: "ask"` | ✅ 出现 | `permission.asked` → 客户端 reply 决定 |

**最危险的坑（实测踩到）**：纯 `deny */*` 下，模型**不会**说"我没有工具"，
而是**编造执行过程和结果**。实测原话：

> 命令的标准输出是：`phase0-marker`

而该命令**根本没有执行**（隔离实例的 shell 输出目录里没有任何新文件，
只有更早那次 ask 测试留下的一个）。

### 4.4 由此定下的桥接硬规则

1. **绝不相信模型文本里的"我做了 X"**。只认 `session.tool.called/success/failed` 事件。
2. 仿真会话用**纯 deny**（把工具彻底藏掉），避免 `permission.rejected` 之类的噪音；
   同时在 system prompt 里**明确告诉模型它没有任何工具**，压掉幻觉。
3. 主 agent 用 `ask`，让 QQ 用户审批；`permission.asked` 的 `resources[]` 就是给用户看的内容。
4. **启动时读回 agent 的生效规则集做断言**（见 4.2），不通过就拒绝启动。
   这是"绝不让桥接带着错配置碰真实群"的最后一道闸。

权限文档：<https://opencode.ai/v2/docs/permissions>

---

## 五、与 DSH 的语义落差（Phase 1 待处理）

| DSH | OpenCode | 处理方式 |
| --- | -------- | -------- |
| preset（人设 + 工具白名单） | agent（`mode`/`system`）+ 权限规则 | 人设做成 agent 的 system；工具白名单做成 `deny */*` + 放行 |
| 每会话 `agentToken` 脱敏 | 无对应概念 | 桥接侧自己做脱敏 |
| `createTurnCollector` 事件形状 | 完全不同 | 重写（见 2.3 表格） |
| 成本面板（免费模型 cost=0） | `session.stats` 有 cost 但免费模型为 0 | 自建价格表 |
| 交互式审批 | `permission.asked` + `permission.reply` | 转发到 QQ |

---

## 六、本项目脚手架

| 文件 | 作用 |
| ---- | ---- |
| `spike/oc-env.mjs` | 路径 / 端口(4599) / CLI 解析 / `isolatedEnv()`（清理继承环境） |
| `spike/start-server.mjs` | 拉起隔离实例（`serve --service --hostname 127.0.0.1 --port 4599`） |
| `spike/stop-server.mjs` | 停掉隔离实例 |
| `spike/probe.mjs` | 基础链路：发现→建会话→指定模型→发消息→事件→统计 |
| `spike/probe-tools.mjs` | 工具调用 + 审批往返 |
| `spike/probe-desktop.mjs` | （诊断用）通过桌面端服务打推理，验证额度问题 |
| `spike/inspect-events.mjs` | 查看探针落盘的 `*.jsonl` 事件（**用 Node 读**，PowerShell 5.1 会读坏 UTF-8） |
| `spike/list-models.mjs` | 列出实例里的 provider/model |
| `spike/dump-agents.mjs` | 读回各 agent **生效的**权限规则集（`agent.list({location})`） |
| `spike/dump-provider-catalog.mjs` | 从 models.dev 目录提取「provider → 激活用环境变量」 |
| `spike/diff-db.mjs` / `dump-kv.mjs` / `dump-instance.mjs` | （诊断用，只读）对比实例 config/DB |

隔离数据全部落在项目内 `.oc/`（config/state/data/cache），不碰桌面端的
`~/.config` `~/.local` —— 已验证 `auth list` 为 "No authenticated integrations"。

密钥放 `secrets.json`（已 `.gitignore`），由 `isolatedEnv()` 注入。

上游仓库已 clone 到 `upstream/`（`9df6a7e`）作为移植参考。

---

## 七、下一步（Phase 1）

Phase 0 的 7 项未知全部关闭，Phase 1 可以开始了：

1. ~~拿到真实 provider key~~ ✅ 已完成（`secrets.json` + `isolatedEnv()` 注入）。
2. ~~复测 `deny */*` 的 fail-closed 行为~~ ✅ 已完成（第四节）。
3. **搬模块**：把 `upstream/src` 里与 DSH 无关的模块原样搬进来
   （`mcp-snowluma-safe` / `mcp-web-search-safe` / `snowluma-conn` / `token-ledger` /
   `model-prices` / `md-to-plain` / `sensitive` / `safe-fetch` / `sticker-lib` /
   `slang-learner` / `voice-core` / `role-card` / `forward` / `state-acl`）。
4. **写 `src/oc-client.js` 替代 `src/dsh-client.js`**，并封装：
   发现/鉴权、会话、模型候选链、事件、审批、统计，
   以及**启动时读回 agent 规则集做断言**（4.4 第 4 条）。
5. **重写 `createTurnCollector`**（按 2.3 的事件表 + `session.retry.scheduled`）。
6. **配置生成器**：DSH preset（人设 + 工具白名单）→ OpenCode agent + permissions；
   模型候选链（默认 `openrouter/openrouter/free`，回退付费）。
7. 最后才碰 QQ 侧（SnowLuma + 真实群）。
