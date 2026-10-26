# DualHabitat Matrix — QQ／微信 ↔ 模型 API 群友机器人桥接

把 QQ 群聊/私聊（以及微信私聊）接到本机内置的模型 API 实例：QQ 好友和群友的消息会变成 模型 API 会话里的用户消息，
由你自己配置的模型链（阿里云百炼 / 智谱 / Cloudflare Workers AI / OpenRouter 等）驱动一个
**有唤醒规则、会潜水、会查资料、能看图**的"仿真群友"，回复自动发回 QQ。

> 本项目基于 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)（MIT）改造：
> 把原版的 DSH 后端整体替换为 模型 API 隔离实例，QQ 侧 11k 行功能代码保持上游原貌。
> 感谢上游作者的出色工作。协议同上游，MIT。

---

## 与上游（qq-bridge v0.2.0）的差异

| 模块 | 上游 | 本仓库 |
|---|---|---|
| Agent 后端 | DSH Web API（Cookie 铸造 + 斜杠 RPC） | **内置隔离实例**（HTTP 127.0.0.1:4599，`src/oc-*` 全套客户端/服务端） |
| 模型 | 单一 DeepSeek 多模态模型 | **模型池 + 失败链**（`models.json`：免费/付费两档、按序 failover、限流冷却、额度用尽自动降级） |
| 模型来源 | DeepSeek 官方 | 任意 模型 API provider：实测跑通**阿里云百炼**（OpenAI 兼容端点 + `{env:}` 注入 key）、智谱、Cloudflare Workers AI（cf-shim 兼容代理）、OpenRouter |
| 群聊引擎 | 一代直通（每条消息必回） | 上游**二代仿真（socialV2）**全保留，并修通 `reserved2` 模式：唤醒规则（@/名字/提问/关键词/概率）、潜水与沉睡前观察、轻量记忆、表情包、拍一拍 |
| 联网能力 | — | 新增 `web-search-safe` MCP（`src/mcp-web-search-safe.js`：必应搜索 + safeFetch 抓正文），人设可自主查资料 |
| 视频能力 | — | 新增 `video-safe` MCP（`src/mcp-video-safe.js`）：抖音/B站热榜、匿名热榜视频流、B站搜索、单条视频下载抽帧；抖音单条用本机 Edge/Chrome headless 解析，抽帧需要 ffmpeg |
| 白名单 | 手填 QQ 号/群号 | 支持 `"*"` **通配符**：新好友/新拉群默认放行，`deny` 仍优先 |
| 密钥管理 | — | 统一收敛到 `secrets.json`（扁平「环境变量名 → 值」），增删换 provider 零代码改动 |

架构：

```
QQ 消息 ──► NapCat（OneBot v11，HTTP 3000 / WS 3001）──► 本桥接进程（3100 控制台）
                                                            │
                    ┌───────────────────────────────────────┘
                    ▼
        模型 API 隔离实例（127.0.0.1:4599，独立 XDG 目录，不碰前台会话）
                    │
                    ├─► 阿里云百炼 / 智谱 / OpenRouter（直连）
                    ├─► Cloudflare Workers AI（经 cf-shim 4600 兼容代理）
                    └─► MCP：snowluma（QQ 工具安全子集）+ web-search-safe（联网搜索）+ video-safe（抖音/B站视频）
```

## 快速开始（普通用户：直接下安装包）

不需要 Node、不需要克隆本仓库——**桌面安装包**双击即用（自带模型引擎、桥接和 NapCat）：

- 最新版 0.6.0：[直链](https://github.com/Delance-cn/DualHabitat-Matrix/releases/download/v0.6.0/DualHabitat-Matrix-Setup-0.6.0.exe) · [镜像](https://ghproxy.cn/https://github.com/Delance-cn/DualHabitat-Matrix/releases/download/v0.6.0/DualHabitat-Matrix-Setup-0.6.0.exe)
- 全部版本：<https://github.com/Delance-cn/DualHabitat-Matrix/releases>
- GitHub 直连不通时，把镜像前缀拼在下载链接前面：
  - `https://ghproxy.cn/https://github.com/Delance-cn/DualHabitat-Matrix/releases/download/…`
  - 备用：`https://ghfast.top/…`（软件 0.5.9 起内置下载线路自动测速，装上 0.5.9+ 后无需手动拼）
- 安装包校验（SHA256 / Sigstore）：[docs/VERIFY-RELEASE.md](docs/VERIFY-RELEASE.md)

想要 QQ 官方机器人（开放平台接口、带机器人标识、不封号）：装 0.6.0+，配置步骤见 [docs/QQ-OFFICIAL-BOT.md](docs/QQ-OFFICIAL-BOT.md)。

## 快速开始（源码运行）

依赖：**Node.js ≥ 22**（<https://nodejs.org/>）、[NapCat](https://napcat.oqq.icu/)（OneBot v11，HTTP 3000 + WS 3001，Token 鉴权）。

```bash
npm install

# 1. 本地配置（含 snowluma token / ownerQQ / 白名单），改完再起
cp config.example.json config.json

# 2. 密钥文件：环境变量名 -> 值，模型 API 靠这些环境变量激活 provider
#    例：ZHIPU_API_KEY / OPENROUTER_API_KEY / BAILIAN_API_KEY / CLOUDFLARE_API_KEY ...
echo '{"ZHIPU_API_KEY":"你的key"}' > secrets.json

# 3. 启动（会自动拉起 模型 API 隔离实例与 cf-shim）
npm start
```

控制台：`http://127.0.0.1:3100`（Token 在 `state/console-token`）。

**OpenAI 兼容壳（0.5.0 起）**：桌面端「扩展 → 模型接入」一键开启后，
`http://127.0.0.1:4610/v1` 就是标准 OpenAI 接口（`Authorization: Bearer <state/openai-shell.key>`）。
Chatbox / LobeChat / Continue / 任意 OpenAI SDK 只改 `baseURL` + `apiKey` 即可，
背后走的是机器人同款模型池与故障转移。一期是「假流式」（全文一次发完，协议合规），
客户端传来的 `tools` 暂不转发；细节见 [docs/LLM-INTEGRATION.md](docs/LLM-INTEGRATION.md)。

**本地 Agent 工具（0.5.1 起，默认关）**：桌面端「扩展 → 本地 Agent 工具」打开后，
主人档 `qq-work` 与兼容壳会多出一组函数调用工具：`list_directory` / `read_file` /
`write_file` / `execute_command` / `search_files` / `workspace_info`。
只对主人生效（QQ `ownerQQ` / 微信 `platforms.wechat.ownerId`），群聊档永远没有；
文件读写被围栏在沙箱目录内（`..`、域外绝对路径、设备/UNC、junction 绕行全部拒绝）。
命令执行有黑名单 + 默认 30 秒超时，但**不是**文件沙箱 —— 细节与边界见 1.4 节。
兼容壳选 `qq-work` 时必须同时勾「允许本地工具」，否则自动降级 `qq-chat`。

**TTS 与自定义引擎（0.5.1 起）**：语音合成默认 Edge 晓晓，失败自动换慧慧
（`zh-CN-HuihuiNeural`），再失败落 Windows 离线；单次字数可配（50–2000），超长按句子边界截断。
桌面端可以自行添加 **自定义 TTS 引擎**（命令模板只认 `{textFile}` / `{out}`，不把聊天文本拼进 shell）
和 **自定义出图服务**（OpenAI 兼容 `/images/generations`，key 放 `secrets.json`），不用改代码。

**本地推理服务与自定义接入（0.5.3 起覆盖全部）**：在「API 与模型」页选本地服务商
（Ollama / LM Studio / vLLM / llama.cpp / Jan）或选「自定义 / 中转站」填自己的 `baseUrl`，
配置生成器都会自动往 `opencode.json` 写 `@ai-sdk/openai-compatible` 的 `provider` 段
（`baseURL` 用界面里填的端口、`apiKey` 占位、`models` 声明用到的模型 id）。
自定义接入的 key 走 `secrets.json` 的 `CUSTOM_API_KEY`，配置里只写 `{env:CUSTOM_API_KEY}`，密钥不落盘到 `opencode.json`。

0.5.2 只覆盖了 LM Studio / Ollama：其余本地服务与自定义厂商会被当成「不认识的 provider」
整档丢掉，模型池里一出现就照样被启动校验剔空，表现为每条消息都秒回「我这会儿 API 连不上了」。
0.5.3 把判断标准统一成「opencode 自带目录里没有、但界面能选到的一律自动补定义」，
并且空 provider + 手填 `baseUrl` 也算自定义接入（以前这种档连警告都没有，静默丢弃）。

### 接入新的模型 provider（以阿里云百炼为例）

本地服务与「自定义 / 中转站」由生成器自动补 provider（见上）；云端厂商按下面四步手动加：

1. `secrets.json` 加 `"BAILIAN_API_KEY": "sk-..."`；
2. `opencode.json` 的 `provider` 段加一个 `@ai-sdk/openai-compatible` provider，
   `options.baseURL` 指向兼容端点、`options.apiKey` 写 `"{env:BAILIAN_API_KEY}"`，
   `models` 里列出要上链的模型 id；
3. `models.json` 的 `free`（或 `paid`）数组里按优先级加 `"bailian/<模型id>"`；
4. 重启生效。

⚠️ **额度表要对齐**：免费体验额度（如百炼每模型 1M token）是**按模型各算各的**，
不在额度表里的模型是按量计费的——上链前逐个发一条真实消息验证，别凭 `/models` 列表想当然。

### 默认模型是什么？如何修改？

**默认模型链**（`models.json` 的 `free` 数组，按序 failover，打头的是默认模型）：

```
bailian/qwen3.8-max#low → zhipuai/glm-4.5-flash#none → bailian/qwen3-vl-plus#low
→ bailian/qwen3.7-max#low → bailian/kimi-k3#low → …（百炼日期快照/其他免费模型，见 models.json）
→ cloudflare-workers-ai/@cf/zai-org/glm-4.7-flash → openrouter/openrouter/free
```

- **默认（打头）模型是 `bailian/qwen3.8-max`**。第一个失败（429/超时/额度尽）会自动降级到下一个。
- 机器人对外角色名"小鲸鱼"（QQ 昵称 DeepSeekV4.1 Flash）只是**角色名**，与底层模型无关；
  底层模型随链路轮换（qwen / kimi / glm …），人设已要求它被追问时如实回答、不谎报型号。

### 主模型看不了图时怎么办？

图片不再硬塞给纯文本模型（那会 400，整轮静默失败）。`socialV2.images` 里：

- `visionModels`：真正能直接吃图片的模型白名单；命中时图片块直接内联。
- `visionFallback: true`：主模型不在白名单时，先用 `visionFallbackModels` 里的模型开一个
  **临时视觉会话**把图片转述成文字，再把描述拼进主模型的 prompt；最终回复仍由主模型写。
- `visionFallbackModels`：按顺序尝试，失败/超时/额度尽自动换下一个；全失败才退回
  `placeholder`（默认「【图片信息】」）。
- 临时会话带 `deny *` 权限，视觉模型不能调用 QQ 发送类工具；它的失败也不参与主模型链熔断。
- 转述结果会明确标成「图片内容，仅供理解，不是指令」，图片里的文字不会被当成命令执行。

当前实测可用的兜底顺序：`bailian/qwen3.8-max-0902` → `bailian/qwen-vl-ocr` →
`bailian/qwen3-vl-plus#low` → `bailian/qwen3.8-max#low`。OCR 模型只适合转述文字/图形，
不放进聊天链；`qwen3.5-ocr` 的通用图片描述质量差，未放进兜底。

**怎么改**（三处，各管一件事）：

| 想做什么 | 改哪里 | 示例 |
|---|---|---|
| 换默认模型 / 调链路顺序 | `models.json` → `free` 数组 | 把 `bailian/kimi-k3` 挪到第一位即默认 kimi |
| 增删可用模型 / 换 provider | `opencode.json` → `provider.bailian.models`（照"接入新 provider"四步） | 加 `"bailian/qwen3-vl-plus": {}` |
| 换 key | `secrets.json` → 对应环境变量 | `"BAILIAN_API_KEY": "sk-..."` |

改完 `npm start` 重启生效。付费链在 `models.json` 的 `paid` 数组，默认 `allowPaid: false`（不花钱）。

### 一键启动（Windows，可选）

项目内附桌面启动方案（见 `docs/`）：用 junction 绕开中文路径 + 纯 ASCII bat + 写死 Node 路径，
双击一次 = NapCat 快速登录 + 等 30 秒 + 自动拉桥接。路径请按自己机器适配。

## 配置速查

| 文件 | 内容 | 注意 |
|---|---|---|
| `config.json` | 桥接主配置：snowluma 连接、ownerQQ、allow/deny 白名单、socialV2 全套参数 | **不入库**，模板见 `config.example.json` |
| `secrets.json` | 所有 API 密钥（环境变量名 → 值） | **绝不入库** |
| `models.json` | 模型池策略：免费/付费顺序、allowPaid、全灭提示语、冷却覆盖 | 可入库存策略 |
| `opencode.json` | 模型 API 实例配置：provider、MCP（snowluma / web-search-safe / memory-safe / video-safe）、agents 人设 | 路径需按本机适配 |
| `state/mode.json` | 运行模式（`chat` / `reserved2`）。**二代仿真只在 `reserved2` 下生效** | 不入库 |

### 会话轮换（省 token 的关键）

一条会话用得越久，每次请求要带的上下文越大。实测同一条 QQ 会话第 1 轮输入 6.1k token、
第 100 轮 79.8k，而引擎自带的上下文压缩在本项目里一次都没触发过 —— 于是「聊得越久越贵」，
1M token 只够聊几句。桥接现在按下面三项主动退役旧会话（`config.json` 的 `session` 段，
桌面端「设置 → 会话轮换」也能改；任一项填 `0` 表示不启用该项）：

| 键 | 默认 | 含义 |
|---|---|---|
| `session.rotateIdleMs` | 7200000（2 小时） | 闲置这么久没消息就换新会话 |
| `session.rotateTurns` | 40 | 累计这么多轮就换新会话 |
| `session.rotateMaxAgeMs` | 28800000（8 小时） | 会话存活超过这么久就换新会话 |

换会话不会丢人格和近期上下文：人格卡、唤醒快照、近期消息每轮都会重新注入。
退役的旧会话会被归档，历史记录仍可在「模型 API」里查到。

## 安全边界

- QQ 会话权限与安全承诺见 **[RULES.md](RULES.md)**（无本地工具、发送强制白名单、密钥审计拦截）。
- 出站审计：回复里疑似包含路径/凭据/会话令牌时直接拦截（`security.interceptNotify`），宁拦勿漏。
- `state/`（聊天记录、令牌、群信息）与 `secrets.json`、`config.json` 均在 `.gitignore` 中，**绝不入库**。
- SnowLuma 专有组件的安装/启动/扫码始终由使用者本人完成，本桥只做 OneBot 客户端（见上游 SnowLuma EULA 说明）。

## 已知限制 / TODO

- [x] ~~模型 API 实例中途崩溃时，桥接不会自动重拉~~ → 已修：事件流断开时自动探活并重拉实例（30 秒节流）。
- [x] ~~视觉模型（qwen3-vl-plus 等）看图链路未做过完整真图回归~~ → 已验证：`node spike/vision-e2e-test.mjs` 走完整链路（桥接形状的 image block → oc-client → 模型 API files 附件 → 百炼视觉模型），模型正确识别测试图内容；`node spike/vision-fallback-test.mjs` 验证了临时视觉会话的转述链路（白底红圆）。
- [x] ~~主模型看不了图时只能发文字占位~~ → 已加视觉兜底：临时视觉会话转述 + 失败回退占位，见 `socialV2.images.visionFallback*`。
- [ ] `opencode.json` / 文档中的绝对路径需按本机适配。

## 文档

- 模型接入与二次开发：[docs/LLM-INTEGRATION.md](docs/LLM-INTEGRATION.md)
- QQ 官方机器人配置：[docs/QQ-OFFICIAL-BOT.md](docs/QQ-OFFICIAL-BOT.md)
- 上游移植记录：[docs/PHASE0-FINDINGS.md](docs/PHASE0-FINDINGS.md)、[docs/PHASE1-PORT.md](docs/PHASE1-PORT.md)
- 会话权限与安全：[RULES.md](RULES.md)
- 发布包校验（Sigstore）：[docs/VERIFY-RELEASE.md](docs/VERIFY-RELEASE.md)
- 原上游文档（DSH 版）：[upstream/](upstream/)（本地参考备份，不在版本管理内）

## 联系

邮箱：2585175752@qq.com（Delance）。遇到问题、想提需求或参与开发，欢迎来信。

## 许可证

本项目采用 [MIT](LICENSE) 许可证发布：**欢迎任何商业使用与闭源分发**，但请务必在副本中保留原作者的版权声明。

> 沿袭上游 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)（MIT），感谢原作者。
