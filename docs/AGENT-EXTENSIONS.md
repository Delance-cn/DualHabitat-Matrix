# DualHabitat Matrix · Agent 扩展开发指南

> 读者：接手本项目的 AI agent（或人类开发者）。目标：读完就能安全地**使用、修改、添加**本项目的一切扩展面。
> 配套：[NEXT-STEPS.md](./NEXT-STEPS.md)（下一步计划）、[LLM-INTEGRATION.md](./LLM-INTEGRATION.md)（模型 API 接入）。
> 硬纪律：**动手前先读要改的文件**；改完跑完验证链再交付；每版必发 release。

## 1. 项目地图

| 项 | 值 |
|---|---|
| 主仓库 | `C:\Users\Delan\Documents\默认项目\DualHabitat-Matrix`（junction 别名 `C:\Users\Delan\DualHabitatMatrix`） |
| 远端 | `origin` = github.com/Delance-cn/DualHabitat-Matrix（公开）；`test` = …-TEST（私有）。**双推**：`git push origin main && git push test main` |
| 代码根 | 仓库根（下称 `CODE_ROOT`）。`src/` 桥接、`desktop/` 桌面端、`plugins/` 插件、`upstream/dsh/agent-presets/` 模型侧工具说明、`docs/` 文档 |
| 数据根 | 开发态 = 代码根；打包态 = `%APPDATA%\dualhabitat-matrix-desktop\bridge-data`（`QQ_BRIDGE_DATA` 注入）。规则见 `src/data-root.js`：**config/secrets/models.local.json/state/audio/images/roles/plugins 跟数据根；src/vendor/upstream 跟代码根** |
| Node | ≥ 22.13（本机 v24）。PS 5.1 环境：路径反斜杠、UTF-8 文件读写注意 BOM |
| 测试隔离 | 桌面测试实例：`DHM_DATA_HOME=<临时目录> DHM_DESKTOP_PORT=3260 node desktop/server.mjs`——绝不碰运行中的真实例与真实 config.json |

### 端口表

| 端口 | 服务 | 归属 |
|---|---|---|
| 3200（可让位） | 桌面端服务 | `desktop/server.mjs`，全部 `/api/*` 桌面端点 |
| 3100 | 桥接控制台 | `src/bridge.js`，`/api/socialV2/*`、`/api/plugins/reload` 等，`x-console-token` 鉴权 |
| 3000 / 3001 | NapCat OneBot HTTP / WS | 外部进程（QQ 协议端） |
| 4599 | 模型 API | opencode-cli serve（协议非 OpenAI，见 docs/LLM-INTEGRATION.md） |
| 4600 | cf-shim | 模型网关 |
| 3210 | 手机页独立监听 | 只认 `/hook/<口令>`、`/setup/<口令>` |

## 2. 六类扩展面：怎么用 / 怎么加 / 怎么改

### A. 插件（`plugins/*.js`）——最常用，优先走这里

**格式**（完整可跑示例：`plugins/example-hello.js`，文件头有全量注释）：

```js
export default {
  name: 'my-plugin',
  description: '一句话说明',
  commands: [{ name: 'myping', usage: '/myping', description: '…', run: async (ctx, args) => { await ctx.reply('pong'); } }],
  hooks: { onMessage(ctx) {}, onBotReply(ctx) {}, onTick(ctx) {} }   // 每分钟一次的是 onTick
};
```

**ctx API**：`reply(text)`、`sendVoice(filePath)`（QQ 侧）、`platform`（'qq'|'wechat'）、`chatId`、`from`、`text`、`isOwner`、`config`（只读）、`log(...)`。

**三种添加方式**：
1. 人用：桌面端「高级 → 插件 → **+ 添加插件**」三步引导（起名 → 选模板 hello/keyword/blank → 改码保存即热重载）。
2. 编程：`POST /api/plugins/add {name, code, overwrite?}`（名字白名单、代码 ≤200KB；服务端写 `dataRoot/plugins/<name>.js` 并走桥接热重载链）。
3. 手动：把 .js 放进 `dataRoot/plugins/` → 重启桥接或 `POST /api/plugins`（reload）。

**模板来源**：`GET /api/plugins/template?name=hello|keyword|blank`（hello = example-hello.js 原文）。
**改插件格式本身**：加载器在 `src/chat-commands.js`（loadPlugins）+ 桥接 `firePluginHook` 挂点（QQ 收发各一处、微信收发各一处）。
**安全**：插件 = 桥接进程同权限；添加引导和文档都要保留这句警示。

### B. MCP 服务（模型侧工具）——给模型加"新能力"的正路

1. 写 server：照 `src/mcp-memory.js` 抄骨架（`McpServer` + `zod` schema + `StdioServerTransport`），
   存成 `src/mcp-xxx-safe.js`；**工具内部自读 `dataRoot/config.json` 判开关**（默认关，用户在工具开关里开）。
2. 注册：`src/oc-config.js` 两处 —— `mcpServers['xxx-safe'] = { type:'local', command:[process.execPath, serverPath], cwd: SESSION_WORKDIR, codemode:false, timeout:{…} }`
   和 `permissions.push({ action: 'xxx-safe_*', resource: '*', effect: 'allow' })`。
   **漏 permissions = MCP 连上了但工具全被 deny 隐藏**（web-search 老坑）。
3. 生效：`node src/oc-config.js` 重新生成 opencode.json → 重启桥接。
   **opencode.json 里键名是 `mcp.servers`**（不是 mcpServers）。
4. 已有六个：snowluma（网关）、web-search-safe、memory-safe、video-safe、create-safe（画画+动态）、
   agent-tools（0.5.1，本地读写/命令，**只注册给 qq-work**）。

**agent-tools 是特例**（`src/mcp-agent-tools.js` + `src/agent-tools-core.js`）：
- 默认关；`oc-config.js` 只在 `agentTools.enabled=true` 时注册，并且**只给 `qq-work`** 加
  `agent-tools_*` 权限 —— 聊天档永远没有。
- 路径围栏 / 命令黑名单 / 超时 / 输出上限都在 `agent-tools-core.js`（纯函数，单测友好）；
  MCP 层每次调用重读 config，`enabled=false` 立即拒绝。
- 想加第 7 个工具：在 `mcp-agent-tools.js` 用 `server.tool(...)` 注册，权限前缀自动是
  `agent-tools_<名字>`；破坏性操作必须先过 `gate()`，并尽量复用 core 里的围栏函数。

### C. 桥接 HTTP API（3100）——外部程序调机器人

**两套鉴权，别混**：
- 管理端：`x-console-token` 头（token 在 `dataRoot/state/console-token` 或 `config.consoleToken`）——全权。
- 智能体会话：`x-agent-token`（会话令牌）**且必须带 `x-agent-call: 1` 头**——缺令牌会被集中关卡拒绝（防 confused deputy）。
- 入站 webhook 用路径口令（`/hook/notify/<口令>`、手机页 `/hook/<口令>`）。

**加新端点的套路**（照 `bridge.js` 里 `/api/socialV2/send-image` 抄守卫链）：
key 格式正则 → `modeAllowed(key, kind, id, cfg, currentMode)` → `shouldBlockSilentReply(key)` → 限频（`st.sendTimes`）→ 业务 → 写 `st.recentMessages`（让模型知道自己发过）。
**改 loadConfig 必须**：bridge 的 loadConfig 是**白名单式归一化**——新增配置段（如 `events.*`）不加显式收编就会被静默剥掉（commands.*、events.* 两次踩过）。微信侧 `readConfig()` 读原文件不受影响。

**对外端点清单**：运行中的实例 `GET /api/endpoints`（内置 11 条手册，含 curl 示例）；源码真理在 `desktop/server.mjs` 的 `/api/endpoints` 分支 + `src/bridge.js` 的 socialV2 块。

### D. 桌面端服务 API（3200）——UI 的后端

- 文件：`desktop/server.mjs`（全部端点）+ `desktop/public/`（index.html / app.js / style.css）。
- 加"设置卡"套路：server 加 `GET/POST /api/xxx`（GET 读、POST 写 `configFile()` 后 `restartBotsFor('qq')`）→
  index.html 加 panel → app.js 加 `loadXxx()` + 挂进 `loadPage()` 的 switch + 改动即存（scheduleXxxSave 防抖 700ms 模式）。
- 导航加页：`app.js` 的 `NAV.qq` / `NAV.wechat` 两个数组各加一行 + `index.html` 加 `<section class="page" id="page-xxx">` + `loadPage()` 加分支。
  参考实现：`page-extensions`（0.4.9）。
- 数据端点：`/api/extensions`（扩展聚合）、`/api/endpoints`（手册）、`/api/agent-tools`（0.5.1 本地工具开关/沙箱）、`/api/draw`、`/api/voice-tts`、`/api/image-library`、`/api/plugins(/add|/template)`。

### E. 电脑操作工具（零开发，纯开关）

`config.computerTools`（专属命名空间，**绝不能用扁平 `tools` 键**）：
`computerRead / computerWrite / computerEdit / computerGlob / computerGrep / computerShell`。
映射在 `src/oc-config.js` 的 `COMPUTER_FLAG_TO_ACTION` → agent 级 permissions。UI 在「工具开关 → 电脑操作」。
这就是"远程编程+文件读写"的能力面：QQ/微信发消息 → 模型用这些工具在本机干活。

### F. 出站事件 Webhook（`src/events-out.js`）

- 用：`config.events = { enabled, url, secret, onMessage, onReply }` → 机器人把收/发事件 POST 到 url（`x-dhm-secret` 头）；QQ 发送最终失败时也推送 `delivery_failed`（只含平台、会话和失败分段，不含正文）。
- 配置 UI：扩展页「出站 · 事件推送」；`POST /api/events {test:true}` 可发测试事件。
- 加新事件类型：在 `events-out.js` 加类型守卫 → 在 bridge/wechat-bot 的对应挂点旁加 `emitEvent(cfg, type, data)`（现有挂点：QQ 收发、微信收发，紧跟 appendMemory）。
- 纪律：fire-and-forget，3s 超时，**绝不 await 进收发主链路**。

### G. 自定义 TTS / 出图引擎（0.5.1，纯配置）

> 预设不够用时不用改代码：桌面端「对话与人格」页的 TTS / 画画面板里都能直接添加。

- **TTS**：`config.socialV2.voice.tts.custom = [{ id, label, command, format, timeoutMs }]`。
  `command` 只认 `{textFile}`（待合成文本的 UTF-8 临时文件）和 `{out}`（输出音频路径）；
  **刻意不支持 `{text}`** —— 文本来自聊天内容，拼进 shell 就是命令注入面。
  provider 填 `custom:<id>`。示例：
  `edge-tts --file {textFile} --write-media {out} --voice zh-CN-YunxiNeural`。
- **出图**：`config.socialV2.draw.custom = [{ id, label, baseUrl, model, apiKeyEnv, sizeTemplate, format }]`。
  走 OpenAI 兼容 `POST {baseUrl}/images/generations`
  （`{model, prompt, size, n:1, response_format:'b64_json'}`，返回 `url` 也会下载）。
  key 从 `secrets.json` 的同名键 / 进程环境读，**不写进 config.json**。
  provider 填 `custom:<id>`；`auto` 链仍只走内置三家，不会擅自产生未知费用。
- 两个 `id` 都限 `[a-z0-9][a-z0-9_-]{0,31}`；删掉引擎时服务端会把失效的 provider 自动复位成 `auto`。

## 3. 改代码的硬纪律（每条都是踩过的坑）

1. **先读后写**：改任何文件前实际读它；推断出来的改动会改错地方且看起来像对的。
2. **loadConfig 白名单**：bridge 新增配置段必须显式收编，否则静默失效（commands.*、events.* 两次同坑）。
3. **ESM 无 `__dirname`**：用 `path.dirname(fileURLToPath(import.meta.url))`。0.4.6 曾因此桥接全崩。
4. **config.json 并发重写**：运行中的应用/桥接会整文件重写 config.json / opencode.json——外部脚本改前让用户关应用，或改完立刻读回验证。
5. **重复键玄学**：config.json 里别用扁平 `tools` 键（历史遗留副本共存）；电脑工具用 `computerTools`，事件用 `events`。
6. **模型池**：真池 = `dataRoot/models.local.json`（不入库）；`models.json` 是公开仓空模板。桥接/oc-config 靠 `QQ_BRIDGE_MODELS` 环境变量拿池（桌面端 nodeRunner 注入），删了它 regen 报「模型池是空的」。
7. **数据根 vs 代码根**：会随升级丢的（config/state/图库）进数据根；随包分发的（src/upstream/示例插件）进代码根。打包态桌面端注入 `QQ_BRIDGE_DATA`。
8. **打包清单**：`desktop/scripts/prepare-bridge.mjs` 的拷贝列表——新目录必须显式加（upstream/ 曾漏导致用户侧 ENOENT）。
9. **PS 5.1 文件**：`custom.nsh`、`drive.ps1` 必须 **UTF-8 带 BOM**；PowerShell 5.1 无 `Start-Process -Environment`，子进程环境变量先 `$env:` 再启动。
10. **不碰运行中的东西**：测试一律 `DHM_DATA_HOME` 隔离数据根 + 3260 端口；真实 config.json 哈希前后比对。
11. **桥接必须真启动过**：0.4.6 的教训——node --check 过 + 桌面冒烟过 ≠ 桥接能跑。改 bridge.js 后必跑启动测试。
12. **桌面端写请求过同源闸门**：`desktop/server.mjs` 的 `sameOriginBlocked()` 对非 GET 请求要求
    `Host` 回环 + `Origin` 同源 + `Sec-Fetch-Site` 不是 cross-site/same-site；不带 `Origin` 的本机脚本、
    curl、入站 webhook 照旧放行。新端点不用自己再判一遍；**别在前端用 `mode:'no-cors'` 发 POST**（会 403）。
    这条挡的是「任意网页用 text/plain 简单请求打 `POST /api/plugins/add` → 写 JS → 热重载 = RCE」。

## 4. 验证链（交付前最低标准）

```text
node --check <全部改动文件>
  → 单测/spike（例：spike/test-mcp-create.mjs；TTS/出图类用临时数据根真跑一次）
  → 桌面冒烟：DHM_DATA_HOME=<tmp> DHM_DESKTOP_PORT=3260 node desktop/server.mjs + curl 新端点
  → 桥接启动测试：DHM_DATA_HOME=<tmp> node src/bridge.js，等 3100 就绪 + 打两枪守卫端点
  → 无头 Edge CDP 走查（msedge --headless=new --remote-debugging-port=9223 + evaluate 断言 + __errs 零报错）
  → 真机（用户点启动/真发消息）
```

现成脚本（AutoClaw 工作区）：`cdp-check.mjs`（CDP 骨架）、`.tmp-046/bridge-guard.mjs`（桥接启动+守卫四枪）、
`.tmp-046/smoke2-test.mjs`（图库冒烟范式）、`.tmp-048/smoke3-test.mjs`（插件添加冒烟范式）、`.tmp-049/smoke4-test.mjs`（事件推送冒烟范式）。

## 5. 发布 checklist

1. 版本号：`desktop/package.json` → 新版本（应用内关于/检查更新都读它）。
2. `git add <改动文件> && git commit`（提交信息一行式：`0.4.x：做了什么——怎么做的`）→ **双推** origin + test。
3. `cd desktop && npm run installer:full`（~559MB，含 NapCat + 内置引擎；不需要网络）。
4. 包内抽查：`dist/win-unpacked/resources/app/package.json` 版本号；`resources/bridge/src/` 有新文件；`resources/app/public/index.html` 含新 UI 标记。
5. 桌面交付：`Copy-Item dist\*.exe C:\Users\Delan\Desktop\`；上一版挪进 `Desktop\DualHabitat旧安装包\`；记 SHA256。
6. release：`$env:GH_TOKEN = (git credential fill 取)` → `node gh-release.mjs Delance-cn/DualHabitat-Matrix v0.4.x <exe> <名> <notes 文件>`（幂等：同 tag 复用、同名资产先删再传）。**notes 里写清跳过的坏版本**。
7. 更新工作区交接记录 + 记忆。

## 6. 坑速查表

| 症状 | 根因 | 解法 |
|---|---|---|
| regen 报「模型池是空的」 | QQ_BRIDGE_MODELS 没注入 / 池文件不在数据根 | 桌面端启动会注入；手工跑 oc-config 时设 `QQ_BRIDGE_MODELS=<数据根>\models.local.json` |
| 界面配了但桥接读不到 | loadConfig 白名单没收编新配置段 | oc-config/bridge loadConfig 显式加段 |
| MCP 连上了但模型说没工具 | permissions 没放行 `xxx-safe_*` | oc-config permissions 补 allow |
| 读 MCP 服务列表为空 | opencode.json 键是 `mcp.servers` | `oc.mcp?.servers ?? oc.mcp ?? oc.mcpServers` |
| 打包后某目录 ENOENT | prepare-bridge 清单没带 | scripts/prepare-bridge.mjs 显式加 |
| 桥接启动即崩 `__dirname` | ESM 无该变量 | fileURLToPath 形式；全仓扫 |
| 改配置「没生效」 | 运行中应用并发整文件重写 | 关应用再改，或改完立刻读回 |
| PS 引号转义崩 | 内联 -e 嵌套引号 | 写 .mjs/.ps1 文件再执行 |
| 旧版不弹更新 | 该版没发 release / 检查时代理不通 | 每版必发 release；失败横幅已可见 |
| 前端 POST 全 403 | 被同源闸门挡了（Origin 跨站或 Sec-Fetch-Site 异常） | 从本服务页面发；本机脚本不带 Origin 直接调 |
| 兼容壳 401 | key 与 `state/openai-shell.key` 不一致（换过 key） | 扩展页重新复制 key；工具里同步换 |
