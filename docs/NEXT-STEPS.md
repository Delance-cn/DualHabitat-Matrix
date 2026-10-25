# DualHabitat Matrix · 下一步计划（2026-10-23 整理）

> 配套文档：[AGENT-EXTENSIONS.md](./AGENT-EXTENSIONS.md)（给 AI agent 读的扩展开发指南）。
> 现状基线：v0.5.6 已构建（2026-10-24，安装包与隔离数据根 Electron E2E 已过；`origin` / `test` 推送与
> GitHub release 见发布记录）。
> v0.5.6 = 0.5.5 回归修复（裸模型名不再崩桥接、切厂商立即刷新地址/模型、本地模型探测、
> 启动时幂等修复坏配置、模型池保存校验 + “模型与 API”面板重做）。
> v0.5.5 = QQ / 微信双模型实例（QQ 4599 + 根目录 `opencode.json`，微信 4601 + `.oc/wechat`，
> 共享 4600 CF shim）+ 按平台自定义中转站与有效模型池 + 运行中实例配置读回校验修复。
> v0.5.4 = 0.5.3 的本地服务商扩展（vLLM / llama.cpp / Jan + 自定义 baseUrl）+
> GitHub Copilot 缺陷修复批次（保存档位不互相覆盖、密钥按平台/档位隔离、模型链限制可恢复、
> 失败回合上报、`/api/raw` 不泄露 secrets、退出时收掉模型服务、日志轮转、入站去重与按会话串行）。
> 空 provider 的手填地址档不再被静默丢弃，provider 段与 agent 的 model 都能落盘；
> 另修 `prepare-vendor/prepare-bridge` 在 junction + 中文真实路径下静默中断（exit 127）的坑。
> v0.5.2：关软件时真正收掉 NapCat / 桥接 / 微信；本地 LM Studio / Ollama 会写 provider 定义 + 模型清单，4599 目录不再为空。
> v0.5.1：本地 Agent 工具 + TTS 慧慧兜底/字数上限/自定义引擎/自定义出图；v0.5.0：OpenAI 兼容壳 4610。
> 详细史志见工作区「DualHabitat-桌面端重做-交接记录-2026-10-19.md」（三十二节止）。

## 一、近期（下次开工就做）

1. **动态在线 E2E**：NapCat 上线后跑 `spike/test-mcp-create.mjs` 里的发→读→删链路
   （`qq_post_moment` 用 `ugc_right=64` 仅自己可见 → `qq_list_moments` 核对 tid → `qq_delete_moment` 删除，安全无痕）。
2. **0.5.1 真机回归**：装桌面包后核对——扩展页「本地 Agent 工具」能开/关、qq-work 未勾「允许本地工具」被拒、
   主人私聊能读写沙箱内文件、群聊调不到工具；TTS 试听超字数被拒、自定义引擎能加能删；
   画图自定义服务能加能删、provider 删掉后自动回 auto。
3. **打包清单巡检**：`prepare-bridge.mjs` 拷贝清单核对一次全目录（upstream 曾漏过，新目录必须显式加；
   0.5.0 已把 `src/openai-shell.js` 加进 `must` 自检，0.5.1 需确认 `src/agent-tools-core.js` / `src/mcp-agent-tools.js` 也在）。
4. **NapCat 双号真机回归**：两份独立 NapCat Shell 目录分别扫码 qq1/qq2，核对两端收发、会话键隔离、
   qq2 掉线时不会从 qq1 发出、桌面端按号启停与看护、以及升级后 qq1 历史会话/记忆仍能直接打开。

## 二、中期大件（已规划，按价值排序）

0. ~~**NapCat 多号**~~ ✅ **0.6.0 已交付**：`src/qq-accounts.js` 作为账号模型 / 会话键 / 白名单策略的唯一实现；bridge.js 改为每号一条 OneBot WS 客户端（qq1 键不变，其余 `qqN:` 前缀，账号 id 不复用空洞）；桌面端按号拉独立 NapCat 目录并错开 3001/3011/3021、3000/3010/3020、6099/6109/6119；状态页多号面板支持启停/扫码/删除/添加；导航收敛为 6 项。白名单/人设暂全号共用，`policy` 已按号预留；真机双号扫码登录与掉线不回落待补测。
1. ~~**OpenAI 兼容壳**~~ ✅ **0.5.0 已交付**（`src/openai-shell.js`，默认 4610，Bearer 鉴权，非流式 + 假流式）。
   二期：真增量 SSE（接 assistant/chunk 逐块 flush）、`tools` / function calling 转发、
   每会话复用（现在每条请求建一个新会话）、`/v1/embeddings`。
2. **MCP 添加 UI**：扩展页加「+ 添加 MCP 服务」（name / command / args / 是否放行权限）→ 写 oc-config 注册逻辑 → regen → 重启桥接。
   注意 opencode.json 里键是 **`mcp.servers`**。
3. **插件权限沙箱**：现状插件=桥接同权限（文件头有警示）。方向：默认 deny 的 ctx 能力白名单 + 危险能力（fs/shell）单独授权开关；远期 worker 隔离。
4. **定时任务可视化**：定时推送 / 定时重启 / 定时摘要做成 UI（底层自动化 API 已有），持久化在数据根。
5. **群管官方插件包**：入群欢迎、关键词提醒、违禁词、每日签到——全部可用现有插件 API（commands + onMessage/onTick 钩子）实现，
   打成 `plugins/` 官方示例集，添加引导里直接选模板。

## 三、我的想法（想法池，未排期）

- **事件出站增强**：失败重试队列（现在 fire-and-forget 丢就丢了）、HMAC 签名防伪造、
  WebSocket 实时事件流（比轮询 /api/messages 优雅，手机端 PWA 会用到）。
- **语音闭环**：TTS 已有（edge/sapi），补 ASR（QQ 语音条 → 文字，ffmpeg 已随包）→ 机器人能「听」语音消息。
- **记忆升级**：每日记忆 v1 是原文记录；加模型生成摘要头 + 按关键词/语义检索（memory-safe MCP 扩展工具）。
- **备份/迁移向导**：数据根一键打包（config + models.local.json + state + 记忆 + 图库/语音库）→ 换机一键恢复。
- **多账号后续**：QQ 多号 / 微信多号 / 官方机器人多号已落地；下一步补人设与白名单的按号覆盖（`policy` 已预留），以及跨号会话总览。
- **手机端 PWA**：手机页（3210）升级成完整遥控端：状态、发消息、消息流、审批（更新安装等危险操作推到手机确认）。
- **自动更新加签名校验**：release 附 SHA256，安装前比对（现在靠 HTTPS + GitHub）。
- **性能债**：`/find` 同步扫描最多 2 万项会卡桥接主循环几秒（挪 worker_threads）；日志文件加轮转。
- **i18n 全覆盖**：目前只覆盖壳层（导航/页头/弹层），面板内详注仍是中文。
- **高级页剩余手动保存自动化**：路径端口/更新设置/价目表（模型池等已自动化）。
- **config.json 扁平 `tools` 旧键清理**：无人消费但容易误导（重复键「谁后写谁生效」是玄学），大版本时移除并写迁移注释。
- **仓库卫生**：`desktop/dist-bad-0.4.5/`、`desktop/dist-old-0.4.4/` 两个本地垃圾目录可删（已在 .gitignore 外，未跟踪）。

## 四、版本纪律（每版必守）

1. **每版必发 GitHub release**——旧版更新检查读 releases/latest，不发 = 旧版永远看不到新版（0.4.4~0.4.6 的教训）。
2. **验证链最低标准**：`node --check` 全部改动文件 → spike/单测 → 桌面冒烟（3260 + DHM_DATA_HOME 隔离数据根）→
   **桥接启动测试**（0.4.6 的教训：桥接没被启动过就发布 = 崩坏上线）→ 无头 Edge CDP → 真机。
3. 改动桥接/微信侧的收发链路时，必须在交接记录里写明挂点位置，方便下个 agent 复查。
4. 发布说明里明确「哪个版本坏、跳过装哪个」（如 0.4.6）。

## 五、已知技术债速查

| 债 | 位置 | 影响 | 备注 |
|---|---|---|---|
| 高级页部分表单手动保存 | server/public | 易漏保存 | 模型池/对话/语音已自动化，剩路径端口/更新/价目表 |
| i18n 只盖壳层 | public | 英文用户看不懂详注 | 模板：data-i18n 属性 |
| /find 卡主循环 | src/chat-commands.js | 极端情况几秒卡顿 | 挪 worker_threads |
| 微信无语音条 | 协议限制 | TTS 微信侧发不出 | ttsFollow 开关已预留 |
| 事件推送无重试 | src/events-out.js | 断网时事件丢失 | 想法池第一条 |
| OpenAI 壳是假流式 | src/openai-shell.js | 客户端没有逐字输出 | `stream:true` 一次性发完再 [DONE]，真增量二期 |
| `ensureServer` 只认 pid | src/oc-server.js | 注册文件过期时误判「没在跑」，会撞端口失败 | 壳里已用 `portInUse` 兜底；桥接启动路径未改 |
| dist-bad/dist-old 垃圾目录 | desktop/ | 仅占盘 | 未跟踪，可直接删 |
