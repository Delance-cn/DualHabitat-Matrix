// 列出实例里的 agent 及其**生效的**权限规则集。
//
// 用途：配置写完不能"假设生效"，要能读回来做断言 —— 这是 fail-closed 的关键。
// AgentInfo 里有 permissions: PermissionRuleset，就是这个用途。
//
// 用法：node spike/dump-agents.mjs
import fs from 'node:fs';
import path from 'node:path';
import { OpenCode } from '@opencode/client';
import { Service } from '@opencode/client/service';
import { PATHS, ROOT } from './oc-env.mjs';

const regFile = path.join(PATHS.state, 'opencode', 'service.json');
if (!fs.existsSync(regFile)) {
  console.error('注册文件不存在，先 node spike/start-server.mjs');
  process.exit(1);
}
const endpoint = await Service.discover({ file: regFile });
const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });

// 注意：必须传 location.directory，否则拿到的是"默认目录"下解析出来的 agent，
// 不是本项目的配置（实测不传时 permissions 里看不到 opencode.json 里写的规则）。
const result = await client.agent.list({ location: { directory: ROOT } });
const agents = Array.isArray(result) ? result : (result?.data ?? []);
console.log(`共 ${agents.length} 个 agent\n`);
if (!agents.length) {
  console.log(`原始返回：${JSON.stringify(result).slice(0, 800)}`);
}

for (const agent of agents) {
  console.log(`===== ${agent.id}  (${agent.name}) =====`);
  console.log(`  mode=${agent.mode}  hidden=${agent.hidden}  steps=${agent.steps ?? '-'}`);
  console.log(`  model=${agent.model ? `${agent.model.providerID}/${agent.model.id}` : '(继承)'}`);
  console.log(`  description=${agent.description ?? '-'}`);
  console.log(`  system=${agent.system ? `已设置（${agent.system.length} 字符）` : '(继承默认)'}`);
  const rules = agent.permissions;
  const list = Array.isArray(rules) ? rules : (rules?.rules ?? []);
  console.log(`  permissions（${list.length} 条，最后匹配者生效）:`);
  for (const rule of list) {
    console.log(`    ${String(rule.effect).padEnd(5)}  action=${rule.action}  resource=${rule.resource}`);
  }
  console.log('');
}
process.exit(0);
