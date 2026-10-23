// mcp-create.js 端到端（spike）：spawn MCP → 列工具 → 真实出图 → 限额 → 离线错误路径。
// 数据根用 spike/data（自播种：首次运行自动准备 config / secrets；绝不碰仓库根的真数据）。
// 跑法：node spike/test-mcp-create.mjs
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(REPO, 'spike', 'data');

// ── 播种 ──
fs.mkdirSync(DATA, { recursive: true });
const cfgFile = path.join(DATA, 'config.json');
if (!fs.existsSync(cfgFile)) {
  fs.writeFileSync(cfgFile, JSON.stringify({
    socialV2: { tools: { draw: true, momentPost: true, momentList: true, momentDelete: true }, draw: { provider: 'auto', size: '1024x1024', dailyLimit: 2 } }
  }, null, 2));
}
const secFile = path.join(DATA, 'secrets.json');
if (!fs.existsSync(secFile)) {
  try { fs.copyFileSync(path.join(REPO, 'secrets.json'), secFile); } catch { fs.writeFileSync(secFile, '{}'); }
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(REPO, 'src', 'mcp-create.js')],
  env: { ...process.env, DHM_DATA_HOME: DATA }
});
const client = new Client({ name: 'spike-create', version: '0' });
await client.connect(transport);
const results = [];
const record = (name, pass, detail = '') => { results.push(pass); console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`); };
const text = (r) => (r?.content ?? []).map((c) => c.text ?? '').join('\n');

// 1. 工具清单
const tools = await client.listTools();
const names = tools.tools.map((t) => t.name).sort();
record('注册 5 个工具', JSON.stringify(names) === JSON.stringify(['qq_delete_moment', 'qq_draw', 'qq_list_moments', 'qq_post_moment', 'qq_send_image']), names.join(', '));

// 2. qq_draw 真实出图（不 send_to，不依赖 NapCat）
const r1 = await client.callTool({ name: 'qq_draw', arguments: { prompt: '一座极简风格的小山和太阳，扁平插画，MCP 测试图' } });
const t1 = text(r1);
record('qq_draw 真实出图', /画好了/.test(t1) && /引擎 (cloudflare|bailian|zhipu)/.test(t1), t1.slice(0, 140));

// 3. 每日限额路径：播种上限 2（已用 1）→ 再改 1 → 第二次应被拒
{
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  cfg.socialV2.draw.dailyLimit = 1;
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
  const r2 = await client.callTool({ name: 'qq_draw', arguments: { prompt: '第二张测试图' } });
  record('每日限额拒绝', /次数已用完/.test(text(r2)), text(r2).slice(0, 100));
}

// 4. moment 工具的错误路径（NapCat 没跑 → 报人话而不是崩溃）
const r3 = await client.callTool({ name: 'qq_list_moments', arguments: {} });
record('qq_list_moments NapCat 离线报人话', /失败/.test(text(r3)), text(r3).slice(0, 120));

const r4 = await client.callTool({ name: 'qq_post_moment', arguments: { content: '不应发出去的测试' } });
record('qq_post_moment NapCat 离线报人话', /失败/.test(text(r4)), text(r4).slice(0, 120));

// 5. 开关关闭路径：关掉 draw，发图应报未启用
{
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  cfg.socialV2.tools.draw = false;
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
  const r5 = await client.callTool({ name: 'qq_send_image', arguments: { key: 'private:123', file: 'x.png' } });
  record('开关关闭报未启用', /没开/.test(text(r5)), text(r5).slice(0, 100));
}

client.close();
console.log(`\nRESULT: ${results.filter(Boolean).length}/${results.length} passed`);
process.exit(0);
