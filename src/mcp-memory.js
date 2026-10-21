// 记忆日志 MCP server（stdio）—— 让模型**自主决定**读取哪天、哪些角色、
// 按什么关键词的记忆日志。只读，范围锁在 <桥接根>/state/memory/。
//
// 由 oc-config 注册为 mcpServers['memory-safe']（模型 API spawn 本文件）。
// 日志文件由 src/memory-daily.js 在桥接/微信进程里增量写入：
//   state/memory/<角色>/<qq|wechat>-<YYYY-MM-DD>.md
//
// 使用时机（写给模型看的）：新开对话、/reset 之后、或需要回忆之前发生过的
// 事情时，先 memory_list 看有哪些日期，再 memory_read 读对应的日子。
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listMemoryDates, readMemory } from './memory-daily.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const server = new McpServer({ name: 'memory-safe', version: '0.1.0' });

server.tool(
  'memory_read',
  '读取 BOT 的每日记忆日志（按角色和通道记录的当日全部收发消息）。新开对话、/reset 之后、或需要回忆之前发生的事情时用这个。',
  {
    date: z.string().optional().describe("'yesterday'（默认）/ 'today' / 'YYYY-MM-DD'，从这一天开始读"),
    days: z.number().optional().describe('往前再读几天（1-30，默认 1）。比如 days=7 读最近一周'),
    keyword: z.string().optional().describe('只返回包含这个关键词的行'),
    role: z.string().optional().describe('只读某个角色的日志（不填=所有角色）')
  },
  async ({ date, days, keyword, role }) => {
    try {
      const r = readMemory(ROOT, { date, days, keyword, role });
      return { content: [{ type: 'text', text: r.text }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `读取失败：${error?.message ?? error}` }] };
    }
  }
);

server.tool(
  'memory_list',
  '列出有哪些日期的记忆日志（按角色和通道分组）。',
  {},
  async () => {
    try {
      const all = listMemoryDates(ROOT, '*');
      if (!all.length) return { content: [{ type: 'text', text: '还没有任何记忆日志。' }] };
      const byKey = new Map();
      for (const x of all) {
        const k = `${x.role}｜${x.channel}`;
        if (!byKey.has(k)) byKey.set(k, []);
        byKey.get(k).push(x.date);
      }
      const lines = [...byKey.entries()].map(([k, dates]) => `${k}：${dates.join('、')}`);
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `列出失败：${error?.message ?? error}` }] };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
