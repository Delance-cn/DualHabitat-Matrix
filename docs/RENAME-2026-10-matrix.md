# 改名记录：`opencode` → `matrix`（2026-10）

> **后续：** 本文件写完后又做了一次改名 —— 项目名 `qq-bridge` → `DualHabitat Matrix`（含目录、junction、包名、env 前缀）。见 [RENAME-2026-10-DualHabitat-Matrix.md](RENAME-2026-10-DualHabitat-Matrix.md)。本文里出现的 `qq-bridge` 指当时的目录名，属历史记录，未改写。

> 一句话：**我们自己起的名字里不再带引擎的牌子**；引擎自己的文件名一个没动（动了它就找不到自己的文件）。
> 老配置照样能跑 —— 旧键、旧类型值都认。

## 一、为什么改

1. 这东西是给所有人用的，不是"OpenCode 用户的插件"。名字里带别人的牌子，等于替别人做嫁衣，也让人以为必须先装那个东西。
2. 后端本来就设计成可替换的（`src/backends/CONTRACT.md`）。**内置那一档拿引擎名当类型值**，等于把"这一档"和"那个实现"焊死了 —— 以后接别的 agent，配置里全是旧名字。

## 二、改了什么

### 配置（含迁移）

| 位置 | 旧 | 新 | 老配置还能用吗 |
|---|---|---|---|
| `config.json` 顶层段 | `opencode: { baseUrl, stateDir, deleteArchived }` | `matrix: { … }` | 能。读取处 `file.matrix ?? file.opencode` |
| `backend.type` | `"opencode"` | `"matrix"` | 能。`LEGACY_TYPES = { opencode: 'matrix' }` |
| 桌面端接口 | `/api/opencode` | `/api/matrix` | 不用兼容（前后端同一版本一起换） |
| 桌面端 `state` 字段 | `state.opencode` | `state.matrix` | 前端不读旧字段 |

迁移时机：
- 桥接启动时把旧键的值读进新键（`src/bridge.js` 的配置默认值那一段）；
- 微信侧 `readConfig()` 同样归一；
- 桌面端 `loadConfig()` 读的时候归一、并删掉旧键，所以**任何一次在界面保存都会顺手完成迁移**。

### 代码

- `src/backends/index.js`：`BACKEND_TYPES = ['matrix','model-api','cli']`，新增 `TYPE_LABELS`（界面/日志统一口径）。
- `src/oc-client.js`：`makeOpenCodeClient` → `makeMatrixClient`，`discoverOpenCodeEndpoint` → `discoverMatrixEndpoint`；事件 `clientId` 与 pending 键前缀 `opencode:` → `matrix:`。
- `src/bridge.js`：`cfg.opencode` → `cfg.matrix`；后端日志改用 `TYPE_LABELS`。
- `package.json`：`name` → `DualHabitat-Matrix`，description 重写（写明后端可换）。
- 桌面端：`data-type="matrix"`、`#panel-matrix`、`loadMatrix/saveMatrix`、`/api/matrix`。

### 文案（给人看的）

- 日志/报错里"OpenCode 实例/D 分支"这类说法 → "模型 API 实例/服务"。
- 找不到 CLI 的报错不再打印 `%APPDATA%\ai.opencode.desktop\cli\…\opencode-cli.exe`（那条路径含引擎的目录名）；位置仍写在 `src/oc-env.js` 的注释里，要查代码即可。
- 桌面端「简易模式」词典（`public/app.js` 的 `PLAIN_RULES`）保留左侧的 `OpenCode` / `opencode.json` 等字样 —— **那层是翻译层，左边必须写原样字面**，用来兜老日志和引擎自己吐的路径。

## 三、没改、也不能改的（引擎自己的名字）

这些是**别人家程序读自己的文件**用的，改了它就不认：

```
@opencode/client          npm 包名（import 语句里的本地别名已经是 Sdk）
opencode.json             引擎的配置文件（项目根）
opencode.db               引擎的会话库（.oc/data/opencode/）
opencode-cli.exe          引擎的可执行文件
ai.opencode.desktop       %APPDATA% 下的数据目录
OPENCODE*                 引擎注入的环境变量（隔离时反而要删掉）
<XDG>/opencode/           引擎自己往 state/data 下建的子目录
.oc/                      本项目自己的缩写（里面装着引擎数据；改它会丢会话历史）
```

## 四、留给"接别的 agent"的接口

`src/backends/CONTRACT.md` 是契约本身：实现 `sessions.prompt / respond / stopSessionWork / workspace.* / events.mux`，产出同样的信封与事件帧，然后：

1. 在 `src/backends/` 下写一个适配器；
2. 在 `src/backends/index.js` 的 `createBackend()` 里添加一个 `if (type === '你的名字')`；
3. `BACKEND_TYPES` 与 `TYPE_LABELS` 各加一行（界面/日志自动跟上）。

QQ 侧、仿真引擎、黑话学习、账本、控制台都不需要改 —— 它们只认契约，不认后端是谁。

## 五、2026-10-19 补记：改名踩到的两个坑（都已修）

### 1. `import { Sdk }` 会把桥接直接打死

包名 `@opencode/client` 改不了，于是把本地导入别名统一成了 `Sdk`。但**导出名是
`OpenCode`**（见 `node_modules/@opencode/client/dist/promise/index.js`）。写成
`import { Sdk } from '@opencode/client'` 会在模块加载阶段就抛：

```
SyntaxError: The requested module '@opencode/client' does not provide an export named 'Sdk'
```

桥接连启动都做不到，桌面端只会显示「桥接已退出（code 1）」。正确写法是：

```js
import { OpenCode as Sdk } from '@opencode/client';
```

`oc-client.js` 与 `oc-server.js` 两处都要这样写。改完用 `node src/self-test.js` 验。

### 2. 只改别名，不改导出名

同一类问题的通用教训：**别名可以随便起，导入/导出的符号名必须跟包一致**。
改名时凡是 `import { X }` 里的 `X`，都只能改 `as` 后面那半边。

## 六、2026-10-19 补记：为什么 1M token 只够聊几句

诊断结论（用 `state/bridge.log` + `.oc/data/opencode/opencode.db` 复算）：

- **会话永不重置**：一条 QQ 会话连续用了两天、112 次模型调用，单轮输入从 6.1k 涨到 79.8k。
- **引擎自带的上下文压缩一次都没触发**（`session_v2` 里压缩记录为 0）。
- **每条用户消息触发约 5 次调用**（读消息 → 判断 → 发消息 → 等待 → 收尾），
  其中 75% 的 token 花在「没有文本输出的工具轮」上。
- **空转**：`qq_wait_for_messages` 失败或秒回时，模型会以为工具坏了并立刻重调；
  实测 20 秒内连调 6 次，每次都烧掉一整个回合。

对应的三处修复（2026-10-19）：

1. **会话自动轮换**：`config.json` 的 `session` 段 / 桌面「设置 → 会话轮换」，
   按闲置时长、轮次、会话年龄三个阈值退役旧会话（默认 2h / 40 轮 / 8h）。
   记账在 `state/sessions.json` 的 `sessionStats` 里，重启不丢。
2. **等待不再空转**：并发等待从 `429` 改成 `200 + stopPolling`；连续 3 次空等后
   响应带 `stopPolling: true` 和明确提示，MCP 层把提示顶到结果最前面。
3. **全链熔断不再回错误码**：`models.exhaustedNotice` 默认改成一句人话。
