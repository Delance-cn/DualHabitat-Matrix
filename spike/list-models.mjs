// 列出实例里的 provider / model，可按关键字过滤。
//
// 用法：
//   node spike/list-models.mjs            # 全部
//   node spike/list-models.mjs deepseek   # 只看 deepseek
import { OpenCode } from '@opencode/client';
import { Service } from '@opencode/client/service';
import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from './oc-env.mjs';

const needle = (process.argv[2] ?? '').toLowerCase();
const regFile = path.join(PATHS.state, 'opencode', 'service.json');
if (!fs.existsSync(regFile)) {
  console.error('注册文件不存在，先 node spike/start-server.mjs');
  process.exit(1);
}
const endpoint = await Service.discover({ file: regFile });
const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });

const models = await client.model.list();
const list = Array.isArray(models) ? models : (models?.data ?? models?.models ?? []);
console.log(`共 ${list.length} 个模型`);
for (const model of list) {
  const label = `${model.providerID}/${model.id}`;
  if (needle && !label.toLowerCase().includes(needle)) continue;
  const cost = model.cost ? `${model.cost.input}/${model.cost.output}` : '-';
  console.log(`  ${label.padEnd(48)} tools=${model.capabilities?.tools ? 'y' : 'n'} cost(in/out)=${cost}`);
}
process.exit(0);
