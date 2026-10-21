/**
 * backends/tools.js —— 直连模型 API 的**只读**工具集。
 *
 * 为什么需要：`model-api` 以前只发一次 chat completion，模型看不到任何本地文件，
 * 所以卡片上写的是"无工具"。但很多 provider 都支持 function calling，
 * 加一层循环就能让它读文件 —— 代价是每轮多几次请求。
 *
 * ## 边界（这是安全代码，改之前先读完）
 *
 * 1. **只读**：没有 write / delete / shell。要改文件请切 模型 API 或 CLI 后端。
 * 2. **锁在工作区内**：所有路径都解析成 realpath 再比对，junction / symlink 逃不出去。
 * 3. **敏感文件直接拒**：secrets.json、.env*、私钥、state/、.oc/、node_modules/。
 * 4. **有配额**：文件数、单文件大小、输出字符数都封顶，避免一次把上下文撑爆。
 *
 * 这些工具的输出会进模型上下文 —— 也就是说**进了模型上下文就等于可能被发到 QQ 上**，
 * 所以第 3 条不是可选项。
 */

import fs from 'node:fs';
import path from 'node:path';

/** 文件名黑名单（不区分大小写）。 */
const DENY_NAMES = [/^secrets\.json$/i, /^\.env(\..*)?$/i, /\.(pem|key|pfx|p12)$/i, /^id_(rsa|ed25519|ecdsa)(\.pub)?$/i];

/** 目录黑名单：桥接状态里存着令牌和聊天记录，绝不能给模型看。 */
const DENY_DIRS = new Set(['node_modules', '.git', '.oc', 'state', '.cline-data']);

const MAX_FILE_BYTES = 400 * 1024;
const MAX_OUTPUT_CHARS = 8000;
const MAX_WALK_FILES = 3000;
const MAX_SEARCH_HITS = 40;

/** realpath，但允许路径还不存在（取最近的存在祖先再拼回去）。 */
function realpathLoose(target) {
  let current = target;
  const tail = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...tail.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return target;
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

function isBinary(buffer) {
  const n = Math.min(buffer.length, 8000);
  for (let i = 0; i < n; i += 1) if (buffer[i] === 0) return true;
  return false;
}

function clip(text, max = MAX_OUTPUT_CHARS) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…（已截断，原文 ${text.length} 字符）`;
}

export function createWorkspaceTools({ workspace, log = () => {} }) {
  const root = realpathLoose(path.resolve(workspace));

  function assertAllowed(relPath) {
    const target = realpathLoose(path.resolve(root, String(relPath ?? '.')));
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw new Error(`路径越界：${relPath} 不在工作区内`);
    }
    const rel = path.relative(root, target);
    for (const segment of rel.split(path.sep)) {
      if (!segment) continue;
      if (DENY_DIRS.has(segment)) throw new Error(`这个目录不允许读：${segment}/`);
      if (DENY_NAMES.some((re) => re.test(segment))) throw new Error(`这个文件不允许读：${segment}`);
    }
    return target;
  }

  /** 递归收集文件（跳过黑名单目录），用于 search_text。 */
  function walk(dir, out) {
    if (out.length >= MAX_WALK_FILES) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= MAX_WALK_FILES) return;
      if (DENY_DIRS.has(entry.name)) continue;
      if (DENY_NAMES.some((re) => re.test(entry.name))) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, out);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  }

  const definitions = [
    {
      type: 'function',
      function: {
        name: 'read_file',
        description:
          '读取工作区内的文本文件。返回带行号的内容。大文件用 offset/limit 分段读。只读，不能写。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '相对工作区的路径，例如 src/bridge.js' },
            offset: { type: 'number', description: '从第几行开始（1 起），默认 1' },
            limit: { type: 'number', description: '读多少行，默认 200，最多 400' }
          },
          required: ['path']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'list_dir',
        description: '列出工作区内某个目录的条目（目录带 / 后缀，文件带字节数）。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '相对路径，默认工作区根目录' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'search_text',
        description: '在工作区里按纯文本（不区分大小写）搜索，返回 文件:行号:内容。适合先定位再 read_file。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '要找的文本片段' },
            path: { type: 'string', description: '从哪个子目录开始搜，默认整个工作区' }
          },
          required: ['query']
        }
      }
    }
  ];

  function readFile(args) {
    const target = assertAllowed(args.path);
    const stat = fs.statSync(target);
    if (!stat.isFile()) throw new Error(`${args.path} 不是文件`);
    if (stat.size > MAX_FILE_BYTES) {
      throw new Error(`文件太大（${stat.size} 字节，上限 ${MAX_FILE_BYTES}），请用 offset/limit 读片段`);
    }
    const buffer = fs.readFileSync(target);
    if (isBinary(buffer)) throw new Error(`${args.path} 看起来是二进制文件`);

    const lines = buffer.toString('utf8').split(/\r?\n/);
    const offset = Math.max(1, Number(args.offset) || 1);
    const limit = Math.min(400, Math.max(1, Number(args.limit) || 200));
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const body = slice.map((line, i) => `${offset + i}\t${line}`).join('\n');
    const tail = offset - 1 + slice.length < lines.length ? `\n…（还有 ${lines.length - (offset - 1 + slice.length)} 行）` : '';
    return clip(`${args.path}（共 ${lines.length} 行）\n${body}${tail}`);
  }

  function listDir(args) {
    const target = assertAllowed(args.path ?? '.');
    const entries = fs.readdirSync(target, { withFileTypes: true });
    if (!entries.length) return '（空目录）';
    const rows = entries
      .filter((e) => !DENY_DIRS.has(e.name) && !DENY_NAMES.some((re) => re.test(e.name)))
      .slice(0, 200)
      .map((e) => {
        if (e.isDirectory()) return `${e.name}/`;
        try {
          return `${e.name} (${fs.statSync(path.join(target, e.name)).size} 字节)`;
        } catch {
          return e.name;
        }
      });
    const more = entries.length > rows.length ? `\n…（共 ${entries.length} 项，只列前 ${rows.length} 项）` : '';
    return clip(rows.join('\n') + more);
  }

  function searchText(args) {
    const query = String(args.query ?? '');
    if (!query) throw new Error('query 不能为空');
    const start = assertAllowed(args.path ?? '.');
    const needle = query.toLowerCase();

    const files = [];
    walk(start, files);

    const hits = [];
    for (const file of files) {
      if (hits.length >= MAX_SEARCH_HITS) break;
      let buffer;
      try {
        if (fs.statSync(file).size > MAX_FILE_BYTES) continue;
        buffer = fs.readFileSync(file);
      } catch {
        continue;
      }
      if (isBinary(buffer)) continue;
      const lines = buffer.toString('utf8').split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        if (!lines[i].toLowerCase().includes(needle)) continue;
        hits.push(`${path.relative(root, file)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
        if (hits.length >= MAX_SEARCH_HITS) break;
      }
    }

    if (!hits.length) return `没有找到 "${query}"（扫了 ${files.length} 个文件）`;
    const tail = hits.length >= MAX_SEARCH_HITS ? `\n…（已达到 ${MAX_SEARCH_HITS} 条上限，缩小范围再搜）` : '';
    return clip(`${hits.join('\n')}${tail}`);
  }

  return {
    workspace: root,
    definitions,
    /** 执行一次工具调用。**永远返回字符串**：出错也返回错误文本，让模型自己决定怎么办。 */
    execute(name, args) {
      try {
        if (name === 'read_file') return readFile(args ?? {});
        if (name === 'list_dir') return listDir(args ?? {});
        if (name === 'search_text') return searchText(args ?? {});
        return `错误：没有名为 ${name} 的工具`;
      } catch (error) {
        return `错误：${error?.message ?? error}`;
      }
    }
  };
}
