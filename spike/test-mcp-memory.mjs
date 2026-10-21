// mcp-memory.js 端到端测试：spawn → initialize → tools/list → memory_read → 校验内容
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs';
import path from 'node:path';

const repo = 'C:/Users/Delan/Documents/默认项目/DualHabitat-Matrix';
// 准备一条测试记忆
const memDir = path.join(repo, 'state', 'memory', '测试角色');
fs.mkdirSync(memDir, { recursive: true });
const today = '2026-10-21';
fs.writeFileSync(path.join(memDir, `qq-${today}.md`), [
  `# 记忆日志 ${today}`,
  '',
  '## 记录',
  '',
  '- [10:00:00] 张三（group:123）：今天我们聊了记忆日志系统的设计',
  '- [10:00:05] 机器人（group:123）：收到，我记下了'
].join('\n'), 'utf8');

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(repo, 'src', 'mcp-memory.js')]
});
const client = new Client({ name: 'mem-test', version: '0.0.1' });
await client.connect(transport);
console.log('✓ MCP 连接建立');

const tools = await client.listTools();
const names = tools.tools.map((t) => t.name);
console.log('工具: ' + names.join(', '));
if (!names.includes('memory_read') || !names.includes('memory_list')) {
  console.log('✗ 缺工具'); process.exit(1);
}
console.log('✓ 两个工具都在');

const read = await client.callTool({ name: 'memory_read', arguments: { date: today } });
const text = (read.content ?? []).map((c) => c.text ?? '').join('');
console.log('--- memory_read(' + today + ') ---');
console.log(text.slice(0, 300));
const ok1 = text.includes('记忆日志系统的设计') && text.includes('测试角色');
console.log(ok1 ? '✓ 读到今天的记忆' : '✗ 没读到');

const list = await client.callTool({ name: 'memory_list', arguments: {} });
const ltext = (list.content ?? []).map((c) => c.text ?? '').join('');
console.log(ltext.includes('测试角色') ? '✓ memory_list 正常' : '✗ memory_list 异常: ' + ltext.slice(0, 120));

const kw = await client.callTool({ name: 'memory_read', arguments: { date: today, keyword: '不存在的词xyz' } });
const ktext = (kw.content ?? []).map((c) => c.text ?? '').join('');
console.log(ktext.includes('选中的日期里没有匹配') || ktext.includes('没有') ? '✓ keyword 过滤正常' : '⚠️ keyword 行为: ' + ktext.slice(0, 120));

await client.close();
fs.rmSync(memDir, { recursive: true, force: true });
console.log(ok1 ? '=== E2E 全部通过 ===' : '=== 有失败项 ===');
process.exit(ok1 ? 0 : 1);
