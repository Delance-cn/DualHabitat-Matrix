# DualHabitat Matrix 0.5.4

发布日期：2026-10-24

0.5.4 合并了两条线：

1. 0.5.3 的本地服务商扩展：vLLM、llama.cpp、Jan，以及「自定义 / 中转站」手填 `baseUrl` 接入；
2. GitHub Copilot 的缺陷修复批次：保存档位、密钥隔离、模型链、失败回合、日志轮转、入站去重、按会话串行等。

## 主要修复

- **模型档位保存不再互相覆盖**：QQ / 微信、chat / work 分开更新；保存一档不会把另一档或别的平台的配置抹掉。
- **自定义 / 中转站真正落盘**：空 provider + 手填 `baseUrl` 不再被静默丢弃；生成 `dhm-chat-relay` / `dhm-work-relay` 独立 provider，聊天档和工作档可以各用各的地址与密钥。
- **密钥按平台 / 档位隔离**：`DHM_MODEL_QQ_CHAT_API_KEY`、`DHM_MODEL_WECHAT_WORK_API_KEY` 等，不再共用一个 `CUSTOM_API_KEY`；旧密钥会在保存时迁移。
- **切换厂商不再覆盖手填地址**：只有地址为空或仍是上一个厂商默认地址时才填预设值。
- **模型目录校验可恢复**：`restrictTo` 改为临时隐藏 + `clearRestrictions()`，失败后不会把候选永久删光。
- **失败 / 中断回合有明确反馈**：`failed`、`interrupted` 会按回合结束原因上报，不再静默；`interrupted` 不会误清熔断。
- **运行中改密钥可生效**：保存 secrets 后停止模型服务，下一次启动注入新环境变量；不需要手动重启整个桥接。
- **`/api/raw?file=secrets` 不再返回密钥原文**；同源 / Host 校验对 GET 也生效。
- **退出时收掉模型服务**：关闭桌面端会停止 bridge / 微信 / NapCat / 模型 API，避免孤儿子进程。
- **配置写入原子化**：`opencode.json` 先写临时文件再 rename；损坏的 JSON 不再被当成 `{}` 静默覆盖。
- **日志轮转、入站去重、按会话串行发送**：避免日志无限增长、QQ 重放导致双回复、同一会话消息并发挤进同一回合。

## 本地服务商

- LM Studio、Ollama、vLLM、llama.cpp、Jan 会按界面填的地址生成 provider 定义和模型清单，4599 的模型目录不再为空。
- MiniMax、火山方舟继续按 OpenAI 兼容端点生成 provider。
- 内置厂商（DeepSeek、智谱、Gemini 等）的 UI id 会映射到 OpenCode 内置 id（`zhipu → zhipuai`、`gemini → google`）。

## 验证

- `node --check`：所有改动文件通过。
- provider 配置测试：73 / 73。
- Copilot 新增测试：42 / 42。
- 既有离线回归：failover 47 / 47、model-chain 42 / 42、model-pool 48 / 48、oc-client、gateway-layout、工具安全边界测试全部通过。
- 隔离数据根 Electron E2E（0.5.4 打包版）：
  - 启动后 `version = 0.5.4`，数据根指向临时目录；
  - provider 目录包含 `vllm`、`llamacpp`、`jan`、`custom`；
  - 保存 QQ chat / work 两套不同中转地址后，`opencode.json` 生成 `dhm-chat-relay`、`dhm-work-relay` 两个 provider，分别使用 `DHM_MODEL_QQ_CHAT_API_KEY`、`DHM_MODEL_QQ_WORK_API_KEY`；
  - 微信档单独保存为 `DHM_MODEL_WECHAT_CHAT_API_KEY`；
  - `vllm/local-model` 的 provider 定义和模型清单正常生成，`qq-chat` / `qq-work` 分别指向对应 relay。

## 安装包

- 文件：`desktop/dist/DualHabitat-Matrix-Setup-0.5.4.exe`
- 大小：586,424,049 字节
- SHA256：`6D38215F87630138C796478E93EEDD1A6C1DDFECD2E74850715AB9592330EFFF`

## 已知限制

- QQ 和微信共用同一个 4599 实例、同一份 `opencode.json`。如果两边配置了**不同**的自定义中转地址，实际生效的是 QQ 档（QQ 没配才回退微信档）；但两边的密钥会分别保存，不会互相覆盖。要彻底支持双平台不同中转站，需要拆成两个模型实例，留待后续版本。
- 本地服务商如果 QQ / 微信配置了不同端口，同样受「共用一份 provider 定义」限制；常用场景（一边配置）不受影响。
