# DualHabitat Matrix 0.5.5

发布日期：2026-10-24

0.5.5 把 QQ 和微信拆成两个独立的模型 API 实例。以前两边共用 4599 和同一份 `opencode.json`，只能有一套生效的 provider / 中转地址；现在 QQ 继续用 4599，微信用自己的 4601，两边可以同时接不同的中转站、不同的模型和不同的密钥。

## 主要变化

- **QQ / 微信双实例**：QQ 保持 4599、根目录 `opencode.json`、`.oc/state`；微信使用 4601、`.oc/wechat/opencode.json`、`.oc/wechat/state`。老 QQ 数据不用迁移。
- **配置、状态、数据、缓存、日志按实例隔离**：微信的 state / data / config / cache / work / logs 全部落在 `.oc/wechat` 下，不会覆盖 QQ 的模型会话和运行数据。
- **两边可以各用各的中转站**：每个平台的自定义 `baseUrl` 会生成自己的 `dhm-chat-relay` / `dhm-work-relay` provider；客户端再把该平台的中转候选前置到自己的有效模型池，避免“配置里写了 relay、模型链仍按池子换回别的模型”。
- **密钥按平台隔离**：QQ 和微信分别使用 `DHM_MODEL_QQ_*` / `DHM_MODEL_WECHAT_*` 环境变量；保存密钥后两个运行中的实例都会按需重启，不互相覆盖。
- **微信会话目录强制留在 `.oc/wechat`**：微信实例的配置在这个目录，会话目录跑出去会把根目录 QQ 的 `opencode.json` 合并进来。界面保存时也会拒绝越界路径。
- **共享 CF shim 仍然只有一个**：两个实例共用 4600 的 `cf-shim`；停单个实例默认不杀 shim，只有全部退出时才收掉。
- **桌面端按平台管理**：首页 / 状态页分别显示 QQ、微信实例；`/api/matrix` 按平台读写 `matrix.stateDir` / `matrix.wechatStateDir` 和会话目录；保存模型池会重启两个正在运行的 Bot；解除熔断会同时清理两边的 `model-chain.json`。
- **运行中配置读回更稳**：运行实例返回的 `agent.model` 是 `{ providerID, model }` 对象，读回校验现在会把对象和 `provider/model` 字符串等价比较；生成器也会先建好会话目录，避免新数据根误报“Location not found”。
- **微信登录态不受影响**：`wechat-token.json` / `wechat-sessions.json` 仍在数据根的 `state/` 下，和模型实例的 state 分离；拆实例不会丢扫码登录态和已有会话。

## 升级说明

- 直接从 0.5.4 覆盖安装即可；QQ 的 4599 实例、根目录配置和 `.oc/state` 保持原样。
- 第一次启动微信时会在 `.oc/wechat` 下生成独立配置和运行目录；如果微信之前和 QQ 共用模型配置，需要在「后端 → 微信」里确认一次自己的模型 / 中转站设置。
- 如果本机防火墙只放行了 4599，需要额外放行本机回环的 4601（仅监听 `127.0.0.1`）。

## 验证

- `node --check`：`src/oc-env.js`、`src/oc-server.js`、`src/oc-config.js`、`src/bridge.js`、`src/wechat-bot.js`、`desktop/server.mjs`、`desktop/public/app.js` 全部通过。
- provider 配置回归：73 / 73。
- 双实例新增回归：30 / 30（路径 / 端口、环境变量隔离、按平台 relay、有效模型池前置、人设、运行实例模型对象校验）。
- 既有离线回归：failover 47 / 47、model-chain 42 / 42、model-pool 48 / 48、oc-client、gateway-layout、工具安全边界 18 / 18，以及 `desktop/scripts` 下 18 项测试全部通过。
- 依赖真实 CF 模型池 / 真实密钥 / 运行中实例的 live 测试（`test-oc-server`、`test-image`、`test-model-api-tools` 等）未纳入本次离线验证链。
- 隔离数据根真机 E2E：
  - QQ / 微信两个实例同时启动，端口分别为 4799 / 4801（测试覆盖端口；正式端口仍是 4599 / 4601）。
  - 两个实例各自读回自己的 `opencode.json`，中转地址、agent 模型、MCP 工作目录、人设称呼均按平台区分。
  - 停 QQ 后微信仍在运行；再停微信后两边注册文件都清理。
  - 两个平台运行中分别执行 `oc-config --platform=qq|wechat`，运行实例配置读回校验通过。
- 隔离数据根 Electron E2E：
  - `/api/state` 返回 `matrix.instances.qq` / `matrix.instances.wechat`，注册文件不同。
  - 保存微信的实例目录和会话目录不会改 QQ；保存 QQ 也不会改微信。
  - 微信会话目录越界（`.oc/wechat` 外）被拒绝。
  - `/api/model-pool/restore` 路由可达，并同时覆盖两个平台。

## 安装包

- 文件：`desktop/dist/DualHabitat-Matrix-Setup-0.5.5.exe`
- 大小：586,428,660 字节
- SHA256：`E300608022B853EEA0FC1B9EB90F62F00FC8ADA1659D917275B6ECCE3A1B3614`

## 已知限制

- CF shim 仍是全局单实例（4600），两个平台共用同一份 CF 凭据和 shim 进程；这是为了不额外增加常驻进程。
- 微信聊天档仍复用 `qq-chat` / `qq-chat-v2` 预设；预设正文里的 QQ 场景措辞不会改变实例隔离，但如果要让微信聊天人格完全去掉 QQ 措辞，需要后续单独做微信预设。
