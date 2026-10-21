# 省 token 改造（2026-10-19）

> 起因：用户反馈“又用完一个 1M token 的模型，一句话都没发”“别人 1M 能聊很久”。
> 取证见 `RENAME-2026-10-matrix.md` 的「为什么 1M token 只够聊几句」一节。

## 取证结论（2026-10-19 当天，到 17:51）

| 会话 | 模型调用 | token |
|---|---|---|
| QQ 私聊 `ses_eb5e9f4e…` | 53 次 | 3.16M |
| 群 `ses_eb18d0fc…` | 19 次 | 572k |
| 微信私聊 | 14 次 | 217k |
| **合计** | **94 次** | **≈4.0M** |

按模型：`MiniMax-M2.5` 1.25M、`deepseek-v4-flash-0731` 1.11M、`glm-5` 1.01M、`qwen3.6-plus` 645k
—— 每个都刚好把 1M 打满。

四个叠加的出血口：

1. **一条消息 = 5～8 次模型调用。** 每次工具调用都是一整次“把整段上下文重发一遍”。
   实测 14:13:38 那一条消息 = 7 次调用 ≈ 43 万 token。
2. **每次调用的上下文 60～80k。** 固定部分 ≈17k（38 个 QQ 工具 ≈8.8k + system ≈5.3k +
   角色卡 ≈3.2k），其余是历史里越堆越多的工具返回。
3. **完全不跟用户消息相关的调用 24 次 ≈96 万（占 1/4）** —— 主动唤醒/自唤醒，
   醒来看一眼又决定不说话。
4. **工具失败要额外花一整轮。** 今天 61 次工具调用里 `qq_mark_read` 失败 73%、
   `qq_set_wake_config` 42%、`qq_wait_for_messages` 32%，全是 `[object Object]`
   或 400 校验拒绝；每次失败模型都得再想一轮（≈60k）。

## 已改（2026-10-19）

### 1. 不再“监听全量消息”

| 改动 | 位置 | 效果 |
|---|---|---|
| `slang.enabled: false` | `config.json` | 关掉黑话学习器。它按 `extractMinMessages` 持续吃**全量群消息**并单独开会话跑模型，是典型的“一句话没发也在烧” |
| `socialV2.wake.recommendedProbability: 0` | `config.json` | 群里不再按 15% 概率随机叫醒模型；只在 @ / 名字 / 关键词 / 提问 / 拍一拍 时醒 |
| `state/social-v2.json` 里 4 条会话 `triggers.probability → 0` | 运行时状态 | 立刻生效，不用等默认值刷新 |

### 2. 上下文瘦身（A）

| 改动 | 位置 | 效果 |
|---|---|---|
| 单次工具返回硬上限 12000 字符；超了只保留最近 12 条消息并标注省略了多少条 | `src/qq-model-view.js` | 一次 `qq_get_recent_messages` 就能灌进上百条消息，之后每轮都要为这些旧消息重复付费 |
| 关掉 14 个低频工具 | `config.json` `socialV2.tools` | MCP 侧按开关**不再注册**这些工具（`mcp-snowluma-safe.js` 用 `server.tool` 包了一层按 `v2Social.tools[flag]` 过滤），每次请求少几千 token 的工具定义，模型也不会被诱惑去调 |
| `sticker.enabled/includeInPrompt/collect.enabled → false` | `config.json` | 贴纸信息不再注入 prompt |

关掉的 14 个：`feedback` `memory` `slangQuery` `slangSubmit` `getForwardMsg` `sendPoke`
`listStickers` `getStickerImage` `sendSticker` `setStickerRemark` `stickerNote`
`collectSticker` `getSelfImage` `sendVoice`。

### 3. 砍来回轮次（B）

| 改动 | 位置 | 效果 |
|---|---|---|
| `wake.preSleepWaitEnabled: false` | `config.json` | 以前每条消息末尾都卡「沉睡前 5 分钟观察」：`mark_read`/`set_wake_config` 被 400 挡住 → 调 `qq_wait_for_messages(300000)` → 等 5 分钟 → 再 `mark_read`。**每条消息多 1～2 轮（≈60～120k）** |
| `requestedReadThroughSeqV2` 不再抛 400，改成夹到安全水位 | `src/bridge.js` | AI 传脏/越界 `throughSeq` 不再浪费一整轮 |
| `set_wake_config` 没有触发条件时自动补回 @/名字/拍一拍/提问，而不是回 400 | `src/bridge.js` | 同上；防永眠语义不变 |
| `session.rotateTurns: 40 → 16`、`rotateMaxAgeMs: 8h → 6h` | `config.json` | 40 轮实测正好把上下文顶到 80k；16 轮约 30k |

### 4. 会话内锁定模型（C）

`src/model-chain.js`：`pick()` 改成**粘性** —— 上一次成功用过的候选只要还在链里且可用，
就继续用它，不再“优先级更高的那个冷却一到期就切回去”。

原因：换一次模型 prompt 缓存就失效一次，整段上下文从缓存价变全价重算。实测切到 MiniMax
那次 `input 57.6k / cacheRead 0`、切到 glm-5 那次 `input 79.8k / cacheRead 0`，都是全价。
`qwen3.6-plus` 干脆不支持缓存，20 次调用 642k 全是全价，直接吃满它自己的 1M。

### 5. 自唤醒限流（D）

`src/bridge.js` `scheduleProactiveCheckV2`：主动唤醒从“按概率随机叫醒”改成
**必须有 `pendingThoughts`（确实攒着想说的话）才唤醒**。没有就不叫，一次调用都不花。
这直接砍掉那 24 次 / 96 万的沉默花销。

## 没改的

- 私聊 `anyMessage` 保持开启：私聊消息本来就是冲着机器人来的，不该当作“监听全量”。
  群里已经改成只在被叫时醒。
- 引擎自己的上下文压缩（`session.compact`）没接：改用它等于再引入一条“每条会话多一次
  模型调用”的路径；先用轮换 + 工具返回上限把量压住，需要时再说。

## 回归

- `spike/test-model-pool.mjs`：47 项通过（含 `pick()` 行为）。
- 临时单测：`test-session-rotate.mjs`、`test-error-to-text.mjs`、`test-wait-guard.mjs` 全部通过
  （在 `%TEMP%\opencode\`，需先把里面的旧目录名 `DualHabitat-Matrix-opencode` 换成 `DualHabitat-Matrix`）。
- `node --check`：`bridge.js` / `qq-model-view.js` / `model-chain.js` / `mcp-snowluma-safe.js` / `oc-client.js` 全通过。

---

# 纯聊天模式（2026-10-19 晚补）

> 用户原话：「为什么别人 1M 可以聊好久？我们的聊天模式禁止工具调用，保留最近 10 到 15 轮。」
> 追加确认：「可以回复，其他禁用。」

## 别人为什么扛聊

| | 一条用户消息 | prompt 大小 |
|---|---|---|
| 别人 | **1 次** API 请求 | 2～5k（system + 最近几轮） |
| 我们（二代仿真） | **5～8 次** API 请求 | 每次 60～80k（整段历史重发） |

差 60 倍全在**调用次数 × 上下文体积**。`1M` 别人能聊约 200 条，我们约 3 条。

## 开关

`config.json` → `socialV2.chatOnly: true`（本轮已打开）。

**现在也可以在桌面控制台点**：设置页 → 「二代会话」→ **纯聊天（不给工具）**。
勾上/取消后保存，控制台会自动跑一次 `node src/oc-config.js` 并重启桥接
（只写 `config.json` 不重生成的话，界面变了、模型那边的工具表还是旧的）。

手改也行，改完必须重新生成配置：

```
node src/oc-config.js
```

关掉就是把这一行删掉（或设 false）再跑一次生成器，工具面立刻回来。

## 生成器做了什么（`src/oc-config.js`）

| 改动 | 效果 |
|---|---|
| 不注册任何 MCP | QQ 工具（`mcp__snowluma__*`）与联网搜索都不再出现在模型的工具面里 |
| 权限表只剩 `* → deny` | 模型 API 是**拿这份规则算可用工具列表**的，只留兜底 = 零工具 |
| 人设换成内置精简版 | 原 `qq-chat-v2` 正文 22KB（≈8～10k token）通篇是“怎么调 qq_* 工具”，工具一撤就全是**指向不存在工具的错误指令**；精简版 624 字符（≈250 token），只留【安全规则】【怎么说话】【输出格式】 |

`agents.qq-work`（主人档，仅 owner 私聊的 closed-agent 模式）不受影响：它的工具是靠
**agent 级 permissions** 放行的，全局那条 `deny *` 只是兜底。

## 桥接做了什么（`src/bridge.js`）

工具一撤，桥接原本依赖模型调工具的两条链就断了，所以纯聊天模式下由桥接自己收尾：

| 改动 | 为什么 |
|---|---|
| `buildChatWakePromptV2()`：唤醒提示词**一个字不提工具** | 原提示词里的【首回复节奏】【沉睡前强制等待】【收尾】全是工具协议（`qq_wait_for_messages` / `qq_mark_read` / `qq_set_wake_config`），留着只会让模型去调不存在的工具，白烧一整轮 |
| 角色卡**给全文** | 原提示词只给角色名 + 让模型用 `qq_get_prompt` 自己取，而那个工具不存在了 |
| `{本次消息}` 快照后附“直接回话即可，没有工具可调” | 替换原来的 `qq_get_unread_messages` / `qq_mark_read` 收尾说明 |
| 投递成功后桥接**自动标已读**（`acknowledgeMessagesV2`） | 不标 → 同一批消息被反复灌进后面每一轮的 prompt |
| 投递成功后桥接**自己标记唤醒条件已确认**（`wakeConfigUpdatedKeys.add`） | 不标 → 回合结束时桥接发现“没设置唤醒条件”，会补发一条提醒（`buildWakeReminderPromptV2`），又一整轮 60～80k |
| `buildWakeReminderPromptV2` 加纯聊天兜底文案 | 防御：万一被别的路径触发，也不会发出“请调用 qq_set_wake_config” |

回复本身不需要任何工具：桥接会把 agent 回合的**文本**自动转发到 QQ
（`session.text.ended` → `planSocialTimeline` → `sendToQQ`），这条路一直就存在。

## 这一档放弃了什么

- 引用回复（`qq_reply`）、看图片（`qq_get_message_images`）、联网搜索、贴纸/语音全部没有。
- 消息里的 `[图片]` 只是占位符，模型看不到图片内容（人设里已写明“不要编造”）。
- 群里的“主动插话”退化成“只在被 @ / 叫名字 / 提问 / 拍一拍时回一句”。
  主动唤醒（`proactiveCheck`）仍然保留，但必须真的攒着话才叫（见上文 D）。

## 预期

一条消息 = **1 次**调用、上下文 ≈ 5k（system ≈250 + 角色卡 + 最近 12 轮 + 本次快照）。
`1M` 大约能聊 200 条，和“别人”同一个量级。

## 回归（本轮新增）

- `test-chat-only.mjs`（在 `%TEMP%\opencode\`）：13 项通过。包含两条**不许回归**的断言——
  `chatOnly=false` 时仍然注册两个 MCP、权限仍为 `deny * + 2 条白名单`、人设仍来自 preset。
- 另外三项旧单测 + `spike/test-model-pool.mjs` 重跑仍全过。

---

# 角色卡注入频率（2026-10-20）

## 实测：5k 里九成是角色卡

| 项 | 字符 | 说明 |
|---|---|---|
| `roles/小鲸鱼.md` | **5,174** | QQ 当前角色卡，占固定开销 **92%** |
| `agents.qq-chat-v2.system` | 624 | 含「你是小鲸鱼」+ 安全规则 + 输出格式 |
| 合计 | **5,620** | 每轮唤醒付一次，而且插在**消息尾部** → 后端缓存命不中，全价重算 |

微信侧一直只在**建会话时**注入一次（`wechat-bot.js` 的 `primed` 标记）；
QQ 侧 `buildChatWakePromptV2` 却是每轮都塞全文 —— 这是同一条链上唯一没对齐的地方。

## 三档（`config.json` → `role.injectMode`，桌面端「聊天 → 人格」页可选）

| 值 | 行为 | 每轮固定开销（按 12 轮轮换摊销） |
|---|---|---|
| `every` | 每轮都注入全文（历史行为，最稳） | 5,620 字符 |
| `every3` | 每 3 轮注入一次全文 | ≈2,350 字符 |
| **`session`（默认）** | **每个会话只在第 1 轮注入一次** | **≈1,055 字符** |

非注入轮次只发一句（约 60 字符）：

```
【人设】当前角色「小鲸鱼」。以本会话开头给的角色卡为准；若别处出现别的角色名，仍按角色卡说话。
```

最后半句是必需的：`opencode.json` 里 agent 的 `system` 是**生成时写死**的（当前三份都写着「小鲸鱼」）。
换角色后如果不加这句，模型会被 system 拉回旧人设 —— 以前靠每轮重发全文压住，现在靠这句锚点压住。
（根治办法是把角色名写进生成器的 system 模板，那是另一件事。）

## 为什么这样能省

角色卡注入一次后**留在会话历史里**，后面每轮模型仍然看得到；桥接只是不再把它当**新内容**重发。

- 新内容 = 本次快照 + 这一句提醒；
- 历史 = 稳定前缀 → 后端上下文缓存能命中（DeepSeek / DashScope 都支持），命中价通常约为全价 1/10；
- 轮换（`session.rotateTurns`，当前 12）后重新注入一次。

## 改了哪几处（`src/bridge.js`）

| 位置 | 改动 |
|---|---|
| 三个注入点 | `buildChatWakePromptV2` / `buildActiveExitPrompt` / `buildProactivePrompt` 全部改走 `roleHintForTurn(key)` |
| `roleStamp()` | 名字 + 两个文件的 mtime/size；和 `roleRawContent()` 的 cacheKey 同构 |
| `shouldInjectFullRole()` | 版本戳对不上就无条件注入一次；否则按 `injectMode` 的轮次决定 |
| `/api/roles` GET / `/api/roles/limit` POST | 带上并可修改 `injectMode` |
| `refreshRoleConfig()` | 桌面端直接改 `config.json`，桥接只在启动时读一次；按 mtime 懒加载 `role` 段，让「下一条消息生效」成立 |

## 行为契约

- **改人格 / 换角色 → 下一轮立刻重新注入全文**，不用等会话轮换（靠版本戳）。
- 老 `sessions.json` 没有 `roleStamp` 字段 → 视为「没注入过」，第一轮补一次全文，属预期。
- 只有 `chatOnly=true` 走 `buildChatWakePromptV2`；非纯聊天模式本来就只给角色名（靠 `qq_get_prompt` 取），不受影响。
- 如果模型说话开始不像人设：把 `role.injectMode` 调回 `every`，或把 `session.rotateTurns` 调小。

---

# 换角色时会发生什么（2026-10-20）

「只注入一次」把换角色的老问题暴露了出来：角色卡换了，但**会话历史**里还是旧人设的对话，
**agent 的 system** 里还写着旧名字 —— 模型会在两套身份之间来回跳。

## 现在的规则

| 用户动作 | 检测方式 | 结果 |
|---|---|---|
| **改角色卡内容**（同名） | `roleStamp()` 的 mtime/size 变了 | 不重开会话，下一轮立刻重注入一次全文，上下文保留 |
| **换角色**（小鲸鱼 → 小塔菲） | `sessionStats[key].roleName` 对不上 | **自动退役会话**，下一条消息就是新会话 + 新角色卡 |
| 换角色后没发消息 | — | 什么都不会发生，直到下一条消息进来才判 |

- QQ：判在 `ensureSession()` 入口，退役后走正常建会话流程。
- 微信：判在 `wechat-bot.js` 的 `ensureSession()`，归档旧会话、重新建会话、重新注入人设
  （微信没有 `/new` 命令，所以只能自动）。

## system 不再写角色名

`src/oc-config.js` 的 `CHAT_ONLY_PERSONA` 以前第一句是「你是「小鲸鱼」…」，是**生成时写死**的。
QQ 和微信共用同一个 agent（`qq-chat-v2`），但两边角色不同，写死哪一个都会和另一边打架。

现在改成：

```
你是一个在和网友闲聊的普通人。

【身份】
- 你的名字、性格、说话习惯，全部以角色设定为准。
- 没有角色设定时，就用一个普通网友的口吻，不要自称助手、客服或机器人。
```

身份**只有一个来源**：角色卡。系统提示只管安全边界和输出格式。

主人档 `qq-work` 是 QQ 专用（只有 owner 私聊能进），所以它的自称仍然读
`state/current-role.json`，换角色时重新生成 `opencode.json` 就会跟着变。

## 生效条件

- 改了 `oc-config.js` → 必须重新生成 `opencode.json`（`npm run gen:config`），已执行。
- QQ 侧改了 `bridge.js` → 重启桥接。
- 微信侧改了 `wechat-bot.js` → 重启微信接入。

