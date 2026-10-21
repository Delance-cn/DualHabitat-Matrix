// 单独验证探针 MCP fixture：走一遍 initialize + tools/list + tools/call，
// 排除"是 fixture 自己坏了"这种可能性。
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const child = spawn(process.execPath, [path.join(here, 'mcp-fixture.mjs')], {
  stdio: ['pipe', 'pipe', 'pipe']
});

let buf = '';
const seen = [];
child.stdout.on('data', (d) => {
  buf += d.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      seen.push(msg);
      console.log('<<<', JSON.stringify(msg).slice(0, 600));
    } catch {
      console.log('<<< (非 JSON)', line.slice(0, 200));
    }
  }
});
child.stderr.on('data', (d) => console.log('[stderr]', d.toString('utf8').trim().slice(0, 400)));

const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);

send({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'check', version: '0' } }
});
setTimeout(() => send({ jsonrpc: '2.0', method: 'notifications/initialized' }), 300);
setTimeout(() => send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }), 600);
setTimeout(
  () => send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ping', arguments: {} } }),
  900
);
setTimeout(() => {
  console.log(`\n共收到 ${seen.length} 条响应`);
  child.kill();
  process.exit(0);
}, 2500);
