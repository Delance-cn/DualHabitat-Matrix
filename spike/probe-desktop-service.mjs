// 对照实验：**「不用 API key」到底能不能拿到** —— 桌面端能不能用官方免费档，独立实例为什么不能。
//
// 背景：日志里出现过
//   AI.Error: OpenCode's free tier can only be used from within OpenCode.
// 而桌面端（本对话所在的那个服务）用的正是官方免费档 `opencode/deepseek-v4.1-flash-free`。
// 这条串在 CLI 二进制里**搜不到**，说明门禁在**服务端**判 —— 所以不是改本地配置能解决的。
//
// 本脚本用 `generate.text` 做一次性生成：**不开会话、不污染桌面端的历史**。
//
// 只读 + 一次极短的生成。不改任何配置。
// 跑法：node spike/probe-desktop-service.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { OpenCode } from '@opencode/client';
import { Service } from '@opencode/client/service';
import { SERVICE_FILE } from '../src/oc-env.js';

const DESKTOP_SERVICE = path.join(os.homedir(), '.local', 'state', 'opencode', 'service.json');
const FREE_MODEL = { providerID: 'opencode', id: 'deepseek-v4.1-flash-free' };

async function probe(label, discoverOpts) {
  console.log(`\n=== ${label} ===`);
  let endpoint;
  try {
    endpoint = await Service.discover(discoverOpts);
  } catch (error) {
    console.log(`  discover 抛错：${error?.message ?? error}`);
    return;
  }
  if (!endpoint?.url) {
    console.log('  discover 没找到服务（可能没在跑）。');
    return;
  }
  console.log(`  端点：${endpoint.url}   auth=${endpoint.auth?.type ?? '无'}`);

  const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });

  // 1) 免费档在不在目录里、有没有被停用
  try {
    const list = await client.model.list({});
    const free = (list?.data ?? []).filter((m) => m.providerID === 'opencode');
    console.log(`  opencode 自有模型 ${free.length} 个，其中带 free 的：`);
    for (const m of free.filter((x) => /free/i.test(x.modelID))) {
      console.log(`    ${m.providerID}/${m.modelID}  enabled=${m.enabled}  status=${m.status}`);
    }
  } catch (error) {
    console.log(`  model.list 失败：${error?.message ?? error}`);
  }

  // 2) 真打一发，看免费档在这个端点能不能用
  try {
    const out = await client.generate.text({
      prompt: '只回复两个字：收到',
      model: FREE_MODEL
    });
    console.log(`  ✅ generate.text 成功：${JSON.stringify(out).slice(0, 200)}`);
  } catch (error) {
    const msg = String(error?.message ?? error);
    console.log(`  ❌ generate.text 失败：${msg.slice(0, 400)}`);
  }
}

console.log(`桌面端服务注册文件：${DESKTOP_SERVICE}  (${fs.existsSync(DESKTOP_SERVICE) ? '存在' : '不存在'})`);
console.log(`独立实例服务注册文件：${SERVICE_FILE}  (${fs.existsSync(SERVICE_FILE) ? '存在' : '不存在'})`);

await probe('A. 桌面端自己的服务', { file: DESKTOP_SERVICE });
await probe('B. 我们的独立实例（隔离实例）', { file: SERVICE_FILE });
process.exit(0);
