// 探针 MCP server（stdio，**零依赖**原生 JSON-RPC 实现）。
//
// 为什么不用 @modelcontextprotocol/sdk：本仓库根本没装它（顶层与 upstream 都没有），
// 而 OpenCode 拉起 MCP server 时 `cwd` 是 workspace 目录 —— 依赖解析一失败进程就死，
// 表现出来是"配置写对了、但工具一个都不出现"，非常难查（本轮就踩了）。
//
// 用来实测：OpenCode 里 **MCP 工具的权限动作名**与三种可见性语义。
const TOOLS = [
  {
    name: 'ping',
    description: '探针工具：不接受参数，固定返回字符串 pong。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'echo_check',
    description: '探针工具：原样返回传入的 text。',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: '要原样返回的字符串' } },
      required: ['text'],
      additionalProperties: false
    }
  }
];

const write = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const reply = (id, result) => write({ jsonrpc: '2.0', id, result });
const replyErr = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } });

function handle(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = msg ?? {};
  if (method && String(method).startsWith('notifications/')) return;
  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'qqtest', version: '0.0.1' }
      });
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, { tools: TOOLS });
    case 'tools/call': {
      const name = params?.name;
      if (name === 'ping') return reply(id, { content: [{ type: 'text', text: 'pong' }] });
      if (name === 'echo_check') {
        return reply(id, { content: [{ type: 'text', text: String(params?.arguments?.text ?? '') }] });
      }
      return replyErr(id, -32602, `Unknown tool: ${name}`);
    }
    case 'resources/list':
      return reply(id, { resources: [] });
    case 'prompts/list':
      return reply(id, { prompts: [] });
    default:
      return replyErr(id, -32601, `Method not found: ${method}`);
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) handle(line);
  }
});
process.stdin.on('end', () => process.exit(0));
