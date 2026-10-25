# 架构体检与重构方案 — 2026-10-25

> 针对 **0.6.0 草稿线**（`main` @ `e187b48`）的静态审查 + 实测。所有行数为 `\r\n` 拆分后的真实行数，
> 命令与脚本可复现（附录 A）。
> 结论先行：**可以重构，且不需要推倒重写**。现有模块化的底子（oc-client / oc-config / model-pool /
> 各 `-lib` 提取件）是好的；烂掉的是**编排层**——所有东西都长进了 `bridge.js` 的 `main()`
> 和 `desktop/server.mjs` 的 if 路由链里。重构＝沿作者自己画好的 51 条分节线把缝切回来。
>
> **2026-10-25 落地状态**：P0 测试网（`npm test` 50 例）与 P2 账号抽象（`src/qq-accounts.js` + bridge 多连接）已落地；
> P4 的导航收敛已先做（11→6，「更多」页收不常用页面），页面文件拆分为后续。`bridge.js` 仍是单文件，
> 控制台 110 路由与 `server.mjs` 路由链尚未拆。

---

## 一、现状地图（实测数字）

| 位置 | 规模 | 实际承担的事 |
|---|---|---|
| `src/bridge.js` | **12,268 行**，51 个 `// ──` 分节 | QQ/官方机器人/微信 接入、DSH 会话、人格、黑话、仿真、语音、贴纸、记忆、插件、令牌账本、**整套控制台 HTTP API** |
| ├ `main()` | **1,539–12,268（10,730 行）** | 全部编排；闭包内 **109 个** `let/const` 状态变量 |
| ├ 控制台 HTTP 分节 | 3,433–7,623（**4,191 行**）、**110 条路由 / 104 个路径** | 与 `desktop/server.mjs` 职责重叠的第二套管理 API |
| ├ 二代仿真 + 唤醒调度 | 8,541–11,131（**2,590 行**） | 社交状态机、唤醒、潜水、主动开话题 |
| ├ 语音 / 媒体 / 令牌 / 指令 | 891 / 663 / 607 / 908 行 | 各自独立的能力域 |
| `desktop/server.mjs` | **8,143 行** | 进程监管（bridge/微信/NapCat/官方机器人）+ 配置写入 + 安装器 + 手机端 + 更新器 + 打包之外的**全部业务** |
| ├ 路由块 | 5,220–7,952（**2,692 行**）、**81 个条件分支 / 105 处 `/api/`** | 一个 `if (p === …)` 长链，无路由表、无中间件 |
| `desktop/public/app.js` | **5,718 行** | 12 个页面的全部逻辑、轮询、自动保存、i18n |
| `desktop/public/index.html` | **2,382 行** | 12 个 `<section class="page">`，models 343 / chat 431 / advanced 357 / backend 250 |
| 前端渲染方式 | 75 处 `innerHTML`、197 处 `addEventListener` | 无组件、无状态层；每页 `load*()` 拉整块 HTML |
| 厂商/模型知识 | **4 份副本** | `backends/providers.js`（目录）、`oc-config.js`（生成白名单）、`desktop/server.mjs`（档案清洗/接口）、`public/app.js`（UI 下拉） |
| 测试 | **50 用例全绿**（`node --test desktop/scripts/*.test.mjs`） | 新增 QQ 多号账号模型 8 例；`bridge.js` / `server.mjs` / `app.js` 仍无端到端测试；根 `package.json` 已补 `test` 聚合脚本 |
| 死代码 | `:3100` 的页面 | `bridge.js:3681` 读 `CODE_ROOT/public/console.html`，但仓库根与 `bridge-dist` 都**没有** `public/` → 该页必现“缺失”，背后 110 条路由却仍在服务 |

### 1.1 两套控制台 API 并存

```
desktop UI (:3200)  ──►  desktop/server.mjs  ── 81 条路由 ──► 进程/配置/安装
        │
        └──────────────►  bridge :3100  ── 110 条路由 ──► 社交/发送/人格/黑话/MCP
```

- 同一概念（角色、模型、消息发送、白名单）**两边都有端点**，语义还不完全一致。
- 鉴权也是两套：`consoleToken`（3100）+ `x-agent-token` 会话级令牌（3100），3200 仅靠 `sameOriginBlocked`。
- 结果是缺陷清单里那类“前端以为保存了、后端其实没收到”的问题有了结构性温床。

### 1.2 配置写入有 5 个入口

| 写入方 | 位置 | 写什么 |
|---|---|---|
| 配置生成器 | `src/oc-config.js` → `opencode.json` | provider / agent.model / mcp |
| 桌面服务 | `desktop/server.mjs` **56 处** `writeJson` | config.json / settings / automation / model profiles |
| 前端自动保存 | `app.js` `scheduleAutoSave` | 经 3200 写上面那些 |
| 桥接控制台 | `bridge.js` `atomicWrite*` **23 处** | 白名单 / 角色 / 模式 / 社交 / 黑话 |
| 模型链运行时 | `oc-client.js` / `model-chain.js` | 熔断、限制候选（内存 + 部分落盘） |

没有单一所有者 → `#1`（后端保存吞掉 profiles）、`#3`（打开页面覆盖 baseUrl）、`#5`（厂商 id 对不上）、
`#20`（自定义中转站共用一个 key）、`#33/#36`（档位清不掉 / 全量覆盖）全是同一根因的不同症状。

---

## 二、判定：哪些是“设计问题”，哪些只是“长大后的必然”

**不是设计问题（不要动）**

- `oc-client.js` / `oc-server.js` / `model-pool.js` / `model-chain.js` 的分层是对的；
- `-lib` 提取件（`md-to-plain` / `send-voice-lib` / `role-card` / `v2-wait` / `inbound-dedupe`）都在正确的位置；
- 51 个 `// ──` 分节说明作者一直知道边界在哪，只是没时间切。

**是设计问题（要动）**

1. **闭包式编排**：`main()` 里 109 个状态变量被 110 条路由、消息链路、定时器共享。任何改动都要读 1 万行才能确认影响面；单测无从下手（这也是 0 条 bridge 测试的原因，不是懒）。
2. **两套 HTTP 管理面**：桥接不该自带一套 UI 和鉴权；它应该是**被管理**的进程。
3. **单例身份假设**：`cfg` / `bot` / `self` / `ownerQQ` / `convKey('private:<qq>')` 全局唯一 —— NapCat 多号必须先破这个。
4. **配置多写者**：见 1.2。
5. **前端单文件 12 页**：`app.js` 5,718 行 + `index.html` 2,382 行，页面边界只在 `if` 和 `id` 上。

---

## 三、目标架构

```
┌─ desktop (Electron) ────────────────────────────────┐
│  public/  pages/*.js  core/{api,dom,i18n}.js        │  每页一个 ES module，index.html 只留骨架
│  server.mjs  < 200 行：bootstrap + listen            │
│  http/{router,guards}.mjs   routes/*.mjs            │  方法+路径表，鉴权/同源/限流做中间件
│  services/{bridge,wechat,napcat,official,updater}   │  进程生命周期（唯一 owner）
└───────────────┬─────────────────────────────────────┘
                │ 只有 3200 一个管理面（3100 退成内部 RPC，或直接并入 3200）
┌───────────────▼─────────────────────────────────────┐
│  bridge                                             │
│  transport/onebot/account.js   一账号一实例          │  ← NapCat 多号的落点
│  transport/wechat/…            一账号一实例          │
│  pipeline/inbound.js  (account, kind, id, event)    │  入参即账号，不读全局
│  pipeline/outbound.js (account, …)                  │  出站按来源账号路由
│  features/{social-v2,roles,slang,voice,stickers,    │
│            memory,commands,plugins,ledger}/         │  51 个分节 → 16 个目录
│  app/context.js  显式依赖容器（替代 109 个闭包变量）  │
│  app/config.js   schema + 唯一写入者 + 原子写        │
└─────────────────────────────────────────────────────┘
```

三条硬规矩（比目录结构更重要）：

1. **一个状态只有一个所有者**：配置只有 `app/config.js` 能写；桌面端通过它写，桥接通过它写，前端只发意图。
2. **依赖显式化**：`createContext({ config, store, dsh, transports, logger })`，模块拿 `ctx`，不拿模块级单例。
3. **路由是数据**：`[{ method, path, guard, handler }]`，这样文档、鉴权、测试可以从同一张表生成。

**明确不引入**：框架、TypeScript、打包器、ORM。原生 ESM + 静态文件在 Electron 下够用，迁移成本大于收益。

---

## 四、分阶段重构（每阶段独立可发布）

| 阶段 | 内容 | 删/移行数 | 风险 | 验收 |
|---|---|---|---|---|
| **P0 安全网** | 根 `npm test` 聚合；关键路径 characterization 测试（入站→出站用假 OneBot/DSH）；指标脚本入库；确认/删除死页面 | +测试 ~300 | 无 | `npm test` 全绿；测试能在改坏时变红 |
| **P1 bridge 控制台出桥** | 110 条路由 → `src/http/routes/*.js` + 路由表；鉴权链 → 中间件；`bridge.js` 只 `mountConsole(ctx)` | **−4,100** | 低（纯搬迁，不改逻辑） | 路由清单 diff 为空；3100 冒烟：mode/role/slang/send 各 1 条 |
| **P2 账号抽象（= NapCat 多号 a/b）** | `transport/onebot/account.js`；`pipeline/inbound(account,…)`；`convKey` 带账号；`allowed()` → `ctx.policy`；出站按账号 | 移 ~2,000 | **中高**（消息主链路） | 单号行为逐字节一致（日志/会话键不变）；双号并行收发、白名单、人设互不串 |
| **P3 桌面服务拆解** | `server.mjs` → `http/router` + `routes/*` + `services/*`；进程监管集中 | **−6,000** | 中 | 81 条端点契约测试（status/JSON shape）；启停/重启/安装冒烟 |
| **P4 前端模块化 + 导航整合** | `app.js` → `pages/*.js`；`index.html` 拆骨架 + 模板；导航 11 → 6 | 移 ~5,000 | 中 | 每页独立加载、无全局函数；首屏 DOM 节点 −40% |
| **P5 模型目录单一化** | `backends/providers.js` 成为唯一目录，3200/3100/UI 都从 `/api/providers` 取 | −3 份副本 | 低 | 厂商 id 别名表回归测试；`#5/#20` 类缺陷不再复发 |

顺序理由：**P2 才是你真正要的功能（NapCat 多号），也正好是风险最高的一刀**，所以先要 P0 的测试网；
P1 行数收益最大但纯机械，可以随时插入；P3/P4 是体验债，放功能之后。

---

## 五、NapCat 多号：落点与迁移（已按此落地）

现状假设（逐一核对过）：

| 单例假设 | 位置 | 多号后 |
|---|---|---|
| `const bot = new SnowLumaWebSocketClient(...)` | `bridge.js:12021` | `accounts: Map<id, transport>` |
| `bot.onGroupMessage` / `onPrivateMessage` | `:12027` / `:12031` | 注册时闭包 account |
| `handleIncoming(kind, id, event, cfg)` | `:12033` | 增加 `account` 参数（或 `ctx.account`） |
| `convKey = kind:id` | `:1336`，3 处调用 | `qq1` 不加前缀（兼容旧 state），其余 `qq2:private:<id>` |
| `allowed(kind, id, cfg)` 67 处调用 | `:1509` | `account.policy.allowed()`（per-account 覆盖，缺省继承全局） |
| `onebotSend(...)` 5 处 | 发送链路 | 按 `account.id` 选客户端 |
| `socialV2` 状态键 | `social-v2.json` | `(account, gid)` 复合键，qq1 旧键原样读取 |
| `ownerQQ` / `self` | 37 / 1 处 | `account.selfId` / `account.ownerQQ` |
| NapCat 进程 | `server.mjs:1677 startNapcat()` 单份 | 每号一份：端口 3001/3011/3021…、目录 `napcat/qq2/` |
| 配置 | `snowluma.wsUrl` 单条 | `platforms.qq.accounts[]`，缺省时用旧字段合成 `qq1` |

**迁移策略**：读配置时若没有 `accounts`，用现有 `snowluma.*` 生成 `[{ id:'qq1', ... }]` 并要求 `id='qq1'` 的会话键保持
`private:<qq>` / `group:<gid>` 不变 —— 这样升级后**会话、记忆、白名单、登录态全部不丢**。
桌面端多号面板复用官方机器人那套列表交互（0.6.0 已验证可用）。

---

## 六、页面臃肿的具体处方（导航收敛已落地）

改造前 12 页 / 11 个导航项，每页 5–7 个互不相干的小节：

| 页 | 现有小节 | 问题 |
|---|---|---|
| 模型 | 用量统计、推理等级、批量导入 Key、模型来源、只读工具、模型池、模型价格 | 4 个受众混在一起：新手配置 / 运维账单 / 高级导入 |
| 对话 | 工具权限、语音库 TTS、画画动态、谁能对话、人格、人格卡、素材导入 | 配置项 + 创作工具 + 权限，全是“对话” |
| 高级 | 更新、组件、路径端口、配置项、原始配置、插件、自检 | 5 类无关操作挤一页 |

**导航 11 → 6（已落地）**：

| 新页 | 合并自 | 首屏只放 |
|---|---|---|
| 状态 | overview + status + wx-overview | 4 张服务卡 + 一键体检 + 最近 3 条异常 |
| 对话 | chat + messages | 人设卡 + 白名单 + 消息流（`tabs`） |
| 模型 | models + backend | 当前生效模型（来源/档位/Key）+ 池子；用量/价格/导入进「更多」 |
| 渠道 | phone + hook + 官方机器人 | 每个渠道一张卡 |
| 扩展 | extensions | 工具 / MCP / 插件 / 事件 |
| 高级 | advanced | 折叠分组：端口路径 / 原始配置 / 更新 / 自检 |

量化验收：单页 HTML ≤ 250 行、单页 JS ≤ 600 行、首屏可见区块 ≤ 6、导航项 ≤ 6。

> 实际落地采用更保守的一刀：**保留原页面，只收敛导航**（QQ：状态/对话/消息/模型/连接/更多；微信：状态/登录/对话/消息/模型/更多），
> 交流空间/手机/扩展/高级（微信另有后端/Hook）收进「更多」卡片。overview 仍是外层首页，没有和 status 强行合并；
> 页面文件拆分与首屏区块压缩留待 P4 后续。

---

## 七、防复发规则

1. **行数闸门**：单文件 > 1,500 行时 CI 打警告（不阻断），新代码不再往 `bridge.js` / `server.mjs` 里加。
2. **新增端点必须进路由表**，否则 `/api/endpoints` 不显示 → 自我暴露。
3. **配置写入只允许 `app/config.js`**，其他文件出现 `writeJson(config)` 视为缺陷。
4. **每个从 `main()` 切出来的模块必须带一条不依赖网络的测试**（假 DSH / 假 OneBot）。
5. **发布纪律不变**：`node --check` → `npm test` → 桥接启动冒烟 → 桌面 CDP 冒烟 → 真机。

---

## 附录 A：复现命令

```powershell
# 行数
node -e "const fs=require('fs');console.log(fs.readFileSync('src/bridge.js','utf8').split(/\r?\n/).length)"
# 测试基线（当前 50/50 通过）
node --test "desktop/scripts/*.test.mjs"
```

## 附录 B：与缺陷清单的对应

| 缺陷 | 根因层 | 由哪个阶段消除 |
|---|---|---|
| #1 #3 #5 #20 #33 #36 | 配置多写者 / 厂商目录多副本 | P5（+ P3 收敛 3200） |
| #2 #12 #13 #15 #16 | 回合链路无统一失败出口 | P2（入站/出站显式化） |
| #8 #11 #21 #39 | 桌面进程监管与打包 | P3 |
| #22 #23 #25 #34 #35 | 配置校验/路径校验散落 | P5 |
| 页面臃肿 / 导航迷宫 | 前端单文件 12 页 | P4 |
