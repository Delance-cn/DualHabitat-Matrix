# DualHabitat Matrix 0.6.0

> **状态：草稿（未发布）**。0.6.0 还在攒功能，下面哈希和大小等打包后回填。
> 已发布版本看 [Releases](https://github.com/Delance-cn/DualHabitat-Matrix/releases)，当前最新 0.5.9（[直链](https://github.com/Delance-cn/DualHabitat-Matrix/releases/download/v0.5.9/DualHabitat-Matrix-Setup-0.5.9.exe) · [镜像链](https://ghproxy.cn/https://github.com/Delance-cn/DualHabitat-Matrix/releases/download/v0.5.9/DualHabitat-Matrix-Setup-0.5.9.exe)）。

## 一、QQ 官方机器人（开放平台通道，重点更新）

在 NapCat（个人号协议）之外新增**官方机器人通道**：在 [q.qq.com](https://q.qq.com) 注册的机器人，带官方机器人标识、走腾讯官方接口，**没有个人号协议的封号风险**。私聊（C2C）和群聊都支持，与 NapCat 那条线同时开互不影响。详细配置指南见 [docs/QQ-OFFICIAL-BOT.md](QQ-OFFICIAL-BOT.md)。

- **接入方式**：桌面端「QQ 通道 → 当前状态 → QQ 官方机器人」面板，填开放平台的 AppID + AppSecret，勾选启用，点「保存并启动」即可。随软件自启，掉线看护自动重连。
- **架构**：独立进程（`src/qq-official-bot.js`），官方 WebSocket 网关收消息（自动刷新 access_token、断线恢复），HTTP 接口回消息（5 分钟被动回复窗口、msg_seq 自动管理、超限自动降级主动发送、长文自动分段）。
- **与 NapCat 共存**：人设（roles/）、模型池、模型实例（4599）与 NapCat 那只完全共用——改一处两边一起变；会话和记忆各自独立，互不串门。
- **注意**：官方接口有频控（被动回复需在收到消息 5 分钟内发出；主动消息有每分钟条数限制）；未上架的个人机器人需平台开通群聊权限后群聊才可用（私聊扫码即用），代码层面群聊已就绪。

## 二、模型页自动识别体验

- **一键切换提示框**：探测到本机有正在运行的模型服务（LM Studio / Ollama / vLLM / llama.cpp / Jan）而当前配置没指向它时，「API 与模型」页顶部出现横幅「检测到本机模型服务，一键就能用」——点一下自动填好厂商/地址/模型并保存生效；点「忽略」后该地址不再提示（记在本地，新服务或换地址会再提示）。
- **探测状态实时刷新**：模型页开着时，本机服务芯片、模型候选、提示横幅每 6 秒跟随状态轮询刷新——LM Studio 半路打开也能被看到，不再显示过期的「没在跑」。
- **模型池裸模型名**：本地服务的模型本来就没有厂商前缀（LM Studio 的模型名就是裸名），以前会被判「写法不对」直接丢弃。现在能对上本机探测结果的裸名自动补前缀（界面标注「保存时补 lmstudio/」），只有完全对不上的才拒绝。

## 三、废池永久化

- **额度用尽的模型永久坐废池**：以前 6 小时后自动复活，等于每轮都先撞一次墙再跳过。现在 quota 熔断不过期（重启也不丢），只能手动处理。
- **废池两个出口**：「拿回来」清掉熔断记录回队；新增「删掉」（带确认）把熔断记录和池子条目一起删并重新生成配置。
- **标签区分**：quota 显示「额度用完 · 已废，不会自动恢复」，其余（限流/连不上/认证）仍显示「暂停中 · 到期自动恢复」——后者该自愈的照旧自愈。
- 想改回限时冷却：`models.json` 的 `cooldownMs.quota` 覆盖仍然优先。

## 四、下载与安装

安装包（0.6.0 发布后）：

- 直链：`https://github.com/Delance-cn/DualHabitat-Matrix/releases/download/v0.6.0/DualHabitat-Matrix-Setup-0.6.0.exe`
- 镜像（国内直连不动时用，把前缀拼在完整 URL 前面）：
  - `https://ghproxy.cn/https://github.com/…`
  - `https://ghfast.top/https://github.com/…`
- 大小：待回填
- SHA256：待回填

全部历史版本：<https://github.com/Delance-cn/DualHabitat-Matrix/releases>（每个版本一个独立安装包，互不覆盖）。

0.5.9 及更早版本升级 0.6.0：直接装（配置和数据在 `%APPDATA%\dualhabitat-matrix-desktop\bridge-data`，不随升级丢失）。GitHub 直连不通时用上面的镜像前缀，或先装 0.5.9（自带下载线路自动测速），再从软件内升级。

## 验证

- `desktop/scripts` 18 个测试文件 42 用例全部通过；官方机器人新增纯函数单测（回复分段、msg_seq 递增/超限降级）。
- 官方通道实连验证：真实凭证换取 access_token（HTTP 200）、WebSocket 网关 READY（机器人 L.A.N）、心跳稳定、桌面面板实时显示连接状态与收发计数。
- 模型页一键切换：假 LM Studio 服务端到端实测（横幅 → 一键切换 → 保存生效 → 横幅消失）；池子裸名补前缀前后端实测。
- 废池：quota 熔断一年后 + 落盘恢复仍然跳过该模型、自动切下一条；限流 60 秒后正常回队。
