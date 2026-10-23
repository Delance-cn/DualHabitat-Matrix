// 本地 Agent 工具 MCP server（stdio）—— 让模型真的能读/写/跑命令。
//
// 工具面（名字就是给模型看的，别乱改，权限前缀是 `agent-tools_`）：
//   list_directory(path)            列目录
//   read_file(path)                 读文本（二进制拒绝）
//   write_file(path, content)       覆盖/新建（原子写）
//   execute_command(command)        沙箱根下跑命令，默认 30s 超时 + 黑名单
//   search_files(path?, pattern?, content?)  按路径/内容正则搜
//   workspace_info()                沙箱根、上限、主人是否已配置
//
// 谁在用：oc-config 只在 config.agentTools.enabled === true 时注册本服务，并且只把
// `agent-tools_*` 权限加给 **qq-work**（主人档）。qq-chat / qq-chat-v2 永远没有这组工具，
// 所以群友即使能聊天也调不到。
//
// 身份校验（重要）：MCP 协议层拿不到「这条消息是谁发的」。真正的闸门在路由侧：
//   - QQ/微信：closed-agent 模式只允许 `private:<ownerQQ>`（微信是 platforms.wechat.ownerId）；
//     qq-work 只在这个模式里用。
//   - OpenAI 壳：Bearer key 就是主人凭证。
// 本文件再做一层 fail-closed：配置里一个主人 ID 都没有时，所有工具直接拒绝。
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDataRoot } from './data-root.js';
import {
  DEFAULT_LIMITS,
  listDirectory,
  readTextFile,
  writeTextFile,
  searchFiles,
  runCommand,
  formatCommandResult
} from './agent-tools-core.js';

const CODE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = resolveDataRoot(CODE_ROOT);

function readJson(file, fallback) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/**
 * 每次调用都重读配置：开关/沙箱根改完，桥接重启后立刻生效；
 * 即使没有重启，enabled=false 也能立即拒绝，不用等实例重开。
 */
function loadSettings() {
  const cfg = readJson(path.join(ROOT, 'config.json'), {}) ?? {};
  const raw = cfg.agentTools && typeof cfg.agentTools === 'object' ? cfg.agentTools : {};
  const pick = (v, d) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  const owners = new Set(
    [
      ...(Array.isArray(raw.ownerIds) ? raw.ownerIds : []),
      cfg.ownerQQ,
      cfg.platforms?.wechat?.ownerId
    ]
      .map((x) => String(x ?? '').trim())
      .filter(Boolean)
  );
  const configuredRoot = String(raw.sandboxRoot ?? '').trim();
  const fallbackRoot = String(cfg.sessionCwd ?? '').trim();
  let sandboxRoot = configuredRoot || fallbackRoot || CODE_ROOT;
  try { sandboxRoot = fs.realpathSync.native(sandboxRoot); } catch { /* 交给工具报错 */ }
  return {
    enabled: raw.enabled === true,
    requireOwner: raw.requireOwner !== false,
    owners: [...owners],
    sandboxRoot,
    limits: {
      timeoutMs: pick(raw.timeoutMs, DEFAULT_LIMITS.timeoutMs),
      maxReadBytes: pick(raw.maxReadBytes, DEFAULT_LIMITS.maxReadBytes),
      maxWriteBytes: pick(raw.maxWriteBytes, DEFAULT_LIMITS.maxWriteBytes),
      maxOutputBytes: pick(raw.maxOutputBytes, DEFAULT_LIMITS.maxOutputBytes),
      maxListEntries: pick(raw.maxListEntries, DEFAULT_LIMITS.maxListEntries),
      maxSearchFiles: pick(raw.maxSearchFiles, DEFAULT_LIMITS.maxSearchFiles),
      maxSearchResults: pick(raw.maxSearchResults, DEFAULT_LIMITS.maxSearchResults)
    }
  };
}

/** 每次工具调用前的统一闸门。返回 null = 放行；字符串 = 拒绝原因。 */
function gate(settings) {
  if (!settings.enabled) {
    return '本地 Agent 工具未启用（config.json → agentTools.enabled）。请在桌面端「扩展 → 本地 Agent 工具」打开。';
  }
  if (settings.requireOwner && settings.owners.length === 0) {
    return '没有配置主人 ID（config.json → ownerQQ 或 platforms.wechat.ownerId），工具拒绝服务。';
  }
  if (!fs.existsSync(settings.sandboxRoot) || !fs.statSync(settings.sandboxRoot).isDirectory()) {
    return `沙箱目录不存在：${settings.sandboxRoot}（检查 agentTools.sandboxRoot）`;
  }
  return null;
}

const server = new McpServer({ name: 'agent-tools', version: '0.1.0' });

const fail = (text) => ({ content: [{ type: 'text', text }], isError: true });
const ok = (text) => ({ content: [{ type: 'text', text }] });

server.tool(
  'list_directory',
  '列出某个目录下的文件（名称、大小、类型）。path 省略 = 沙箱根。只能访问沙箱目录内部。',
  { path: z.string().optional().describe('相对沙箱根的路径或沙箱内的绝对路径，默认 "."') },
  async ({ path: rel }) => {
    const s = loadSettings();
    const denied = gate(s);
    if (denied) return fail(denied);
    try {
      const r = listDirectory(s.sandboxRoot, rel || '.', s.limits);
      return ok(r.text);
    } catch (error) {
      return fail(`列目录失败：${error?.message ?? error}`);
    }
  }
);

server.tool(
  'read_file',
  '读取一个文本文件的内容（上限 1MB，二进制文件会被拒绝）。只能读沙箱目录内部。',
  {
    path: z.string().describe('相对沙箱根的路径或沙箱内的绝对路径'),
    maxBytes: z.number().optional().describe('最多读多少字节（默认配置上限，最大 8MB）')
  },
  async ({ path: rel, maxBytes }) => {
    const s = loadSettings();
    const denied = gate(s);
    if (denied) return fail(denied);
    try {
      const r = readTextFile(s.sandboxRoot, rel, { ...s.limits, maxReadBytes: maxBytes || s.limits.maxReadBytes });
      return ok(`${r.path}（${r.bytes} B，${r.lines} 行${r.truncated ? '，已截断' : ''}）\n\n${r.text}`);
    } catch (error) {
      return fail(`读文件失败：${error?.message ?? error}`);
    }
  }
);

server.tool(
  'write_file',
  '把内容写入文件（覆盖已有内容；父目录不存在会自动创建）。写入是原子的。只能写沙箱目录内部。',
  {
    path: z.string().describe('相对沙箱根的路径或沙箱内的绝对路径'),
    content: z.string().describe('完整的新文件内容（UTF-8 文本）')
  },
  async ({ path: rel, content }) => {
    const s = loadSettings();
    const denied = gate(s);
    if (denied) return fail(denied);
    try {
      const r = writeTextFile(s.sandboxRoot, rel, content, s.limits);
      return ok(`${r.created ? '已创建' : '已覆盖'}：${r.path}（${r.bytes} B）`);
    } catch (error) {
      return fail(`写文件失败：${error?.message ?? error}`);
    }
  }
);

server.tool(
  'execute_command',
  '在沙箱根目录执行一条 shell 命令并返回 stdout/stderr（默认 30 秒超时）。危险命令（rm -rf、del /f /s /q、format、shutdown 等）会被黑名单拒绝。命令不是沙箱：只保证 cwd 在沙箱内。',
  {
    command: z.string().describe('要执行的命令，例如 "git status"、"npm run build"、"node -v"'),
    timeoutMs: z.number().optional().describe('超时毫秒数（1000-120000，默认 30000）')
  },
  async ({ command, timeoutMs }) => {
    const s = loadSettings();
    const denied = gate(s);
    if (denied) return fail(denied);
    try {
      const r = await runCommand(s.sandboxRoot, command, { ...s.limits, timeoutMs: timeoutMs || s.limits.timeoutMs });
      return ok(formatCommandResult(r));
    } catch (error) {
      return fail(`执行失败：${error?.message ?? error}`);
    }
  }
);

server.tool(
  'search_files',
  '在沙箱内按「相对路径正则」搜索文件；给了 content 就再按文件内容正则过滤，返回 路径:行号: 匹配行。自动跳过 node_modules/.git/dist。',
  {
    path: z.string().optional().describe('从哪个目录开始，默认沙箱根'),
    pattern: z.string().optional().describe('匹配相对路径的正则（不区分大小写）'),
    content: z.string().optional().describe('匹配文件内容的正则（不区分大小写）')
  },
  async ({ path: rel, pattern, content }) => {
    const s = loadSettings();
    const denied = gate(s);
    if (denied) return fail(denied);
    if (!pattern && !content) return fail('pattern 和 content 至少给一个，不然等于列全库');
    try {
      const r = searchFiles(s.sandboxRoot, rel || '.', { pattern, content }, s.limits);
      return ok(r.text);
    } catch (error) {
      return fail(`搜索失败：${error?.message ?? error}`);
    }
  }
);

server.tool(
  'workspace_info',
  '查看当前沙箱根、各项上限，以及主人 ID 是否已配置。不确定自己能碰哪里时先调它。',
  {},
  async () => {
    const s = loadSettings();
    const denied = gate(s);
    if (denied) return fail(denied);
    return ok([
      `沙箱根：${s.sandboxRoot}`,
      `主人 ID：${s.owners.length ? `${s.owners.length} 个（已配置）` : '未配置'}`,
      `命令超时：${s.limits.timeoutMs} ms`,
      `读/写上限：${s.limits.maxReadBytes} / ${s.limits.maxWriteBytes} B`,
      `输出上限：${s.limits.maxOutputBytes} B`,
      '命令执行不是文件沙箱：cwd 固定在沙箱根，但命令本身仍以当前用户权限运行。'
    ].join('\n'));
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
