/**
 * 对比两个 OpenCode 服务的 `opencode` provider 定义。
 *
 * 关键问题：桥接隔离实例调 opencode.ai 免费档被 403，桌面端 App 却能跑。
 * provider 的 `env: ["OPENCODE_API_KEY"]` 说明这家 provider 是靠环境变量激活的 ——
 * 所以要看看桌面服务的 provider 定义里 apiKey 到底是 "public" 还是一个真 key。
 *
 *   node spike/probe-provider-key.mjs <service.json> [...more]
 */

import { Service } from '@opencode/client/service';
import { makeOpenCodeClient } from '../src/oc-client.js';

const files = process.argv.slice(2);
if (files.length === 0) files.push('.oc/state/opencode/service.json');

for (const file of files) {
  console.log('\n────────', file);
  let ep;
  try {
    ep = await Service.discover({ file });
  } catch (error) {
    console.log('  discover failed:', error?.message ?? error);
    continue;
  }
  if (!ep?.url) {
    console.log('  no service');
    continue;
  }
  console.log('  url', ep.url);
  const c = makeOpenCodeClient(ep);
  const res = await c.provider.list();
  const raw = res?.data ?? res;
  const arr = Array.isArray(raw) ? raw : Object.values(raw ?? {});
  console.log('  providers:', arr.length);
  const oc = arr.find((p) => p?.id === 'opencode');
  console.log('  opencode →', JSON.stringify(oc, null, 1));
}
