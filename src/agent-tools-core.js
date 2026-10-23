// 本地 Agent 工具的内核：路径围栏 / 命令黑名单 / 超时与输出上限。
//
// 这一层故意不依赖 MCP、不依赖 config —— 纯函数 + 少量 fs/spawn，方便单测。
// MCP 那一层（mcp-agent-tools.js）只负责把参数递进来、把结果拼成人话。
//
// 安全模型（写清楚，别高估）：
//   1. **路径**是真围栏：所有读写都 resolve 到 sandboxRoot 内，`..`、绝对路径、
//      Windows 设备路径、UNC、经 junction/symlink 绕出去的，全部拒绝。
//      写文件走「最近存在祖先的 realpath」检查，父目录还不存在也绕不出去。
//   2. **命令**不是沙箱：黑名单只挡「一句就能造成不可逆破坏」的写法（rm -rf / del /f /s /q /
//      format / diskpart / shutdown / 删账户 / 清事件日志 …）。命令本身仍以当前用户权限运行，
//      能 `copy` 到围栏外、能联网。要真隔离得用 Windows Sandbox / 容器 —— 这里不做，
//      也绝不假装做了。cwd 固定在沙箱根，超时 30s（默认），输出截断。
//   3. **身份**不在这里判：MCP 协议不带「谁在说话」。主人校验在两处：
//      QQ/微信侧只有 owner 私聊能进 closed-agent 模式（preset=qq-work）；壳侧是 Bearer key。
//      MCP 启动时仍要求配置里有主人 ID，没有就整体拒绝服务（fail-closed）。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const DEFAULT_LIMITS = {
  timeoutMs: 30_000,
  maxReadBytes: 1024 * 1024,
  maxWriteBytes: 1024 * 1024,
  maxOutputBytes: 128 * 1024,
  maxListEntries: 500,
  maxSearchFiles: 5000,
  maxSearchResults: 200
};

const MAX_TIMEOUT_MS = 120_000;
const MIN_TIMEOUT_MS = 1_000;

/** 跳过这些目录：搜索/列目录时递归进去只会把输出撑爆。 */
const SKIP_DIRS = new Set(['node_modules', '.git', '.oc', '.svn', '.hg', 'dist', 'dist-bad-0.4.5', 'dist-old-0.4.4']);

/* ── 路径围栏 ─────────────────────────────────────────────────────────── */

function real(p) {
  try { return fs.realpathSync.native(p); } catch { return path.resolve(p); }
}

function inside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * 把用户给的路径解析成沙箱内的绝对路径；越界直接抛错。
 *
 * @param {string} sandboxRoot 已存在、已 realpath 的沙箱根
 * @param {string} input 相对沙箱根，或沙箱内的绝对路径
 * @param {{ mustExist?: boolean }} [opts]
 */
export function resolveInside(sandboxRoot, input, opts = {}) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('路径不能为空');
  if (raw.includes('\0')) throw new Error('路径里不能有 NUL 字符');
  // Windows 设备命名空间（\\?\C:\、\\.\PhysicalDrive0）一律拒 —— 这类路径能绕过普通规范化。
  if (/^[\\/]{2}[?.][\\/]/.test(raw)) throw new Error('不允许设备路径（\\\\?\\ / \\\\.\\）');
  if (/^[\\/]{2}[^\\/]/.test(raw)) throw new Error('不允许 UNC 路径（\\\\server\\share）');
  if (/^[a-zA-Z]:[^\\/]/.test(raw)) throw new Error(`盘符路径要带斜杠：${raw}`);

  const root = path.resolve(sandboxRoot);
  const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, raw);
  if (!inside(root, abs)) throw new Error(`路径越界：${raw} 不在沙箱 ${root} 内`);

  // 符号链接 / junction：找最近的已存在祖先，realpath 之后必须还在沙箱里。
  // 不存在的部分（要新建的文件/目录）不可能是链接，交给上层 mkdir。
  let probe = abs;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const realRoot = real(root);
  const realProbe = real(probe);
  if (!inside(realRoot, realProbe)) {
    throw new Error(`路径越界（经符号链接指向沙箱外）：${raw}`);
  }
  if (opts.mustExist && !fs.existsSync(abs)) throw new Error(`路径不存在：${raw}`);
  return abs;
}

/* ── 列目录 ───────────────────────────────────────────────────────────── */

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/**
 * @returns {{ text: string, entries: number, truncated: boolean, path: string }}
 */
export function listDirectory(sandboxRoot, relPath = '.', limits = {}) {
  const max = Number(limits.maxListEntries) || DEFAULT_LIMITS.maxListEntries;
  const abs = resolveInside(sandboxRoot, relPath || '.', { mustExist: true });
  const st = fs.statSync(abs);
  if (!st.isDirectory()) throw new Error(`不是目录：${relPath}`);
  const names = fs.readdirSync(abs).sort((a, b) => a.localeCompare(b));
  const lines = [];
  let shown = 0;
  for (const name of names) {
    let s = null;
    try { s = fs.lstatSync(path.join(abs, name)); } catch { /* 列到一半被删 */ }
    const dir = s?.isDirectory() || s?.isSymbolicLink();
    lines.push(`${dir ? 'd' : '-'}  ${s ? fmtSize(s.size).padStart(9) : ' ' .padStart(9)}  ${name}${dir ? '/' : ''}`);
    shown += 1;
    if (shown >= max) break;
  }
  const truncated = names.length > shown;
  const head = `${path.relative(path.resolve(sandboxRoot), abs) || '.'}（${names.length} 项${truncated ? `，只列前 ${shown} 项` : ''}）`;
  return {
    path: abs,
    entries: names.length,
    truncated,
    text: [head, ...lines].join('\n')
  };
}

/* ── 读文件 ───────────────────────────────────────────────────────────── */

/**
 * 读文本文件。二进制（前 8KB 有 NUL）直接拒绝 —— 把图片当文本塞进上下文只会烧 token。
 * @returns {{ text: string, path: string, bytes: number, lines: number, truncated: boolean }}
 */
export function readTextFile(sandboxRoot, relPath, limits = {}) {
  const max = Math.min(Number(limits.maxReadBytes) || DEFAULT_LIMITS.maxReadBytes, 8 * 1024 * 1024);
  const abs = resolveInside(sandboxRoot, relPath, { mustExist: true });
  const st = fs.statSync(abs);
  if (st.isDirectory()) throw new Error(`是目录，不是文件：${relPath}`);
  if (!st.isFile()) throw new Error(`不是普通文件：${relPath}`);
  const fd = fs.openSync(abs, 'r');
  let buf;
  try {
    const len = Math.min(st.size, max);
    buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
  }
  const head = buf.subarray(0, Math.min(buf.length, 8192));
  if (head.includes(0)) throw new Error(`看起来是二进制文件（${fmtSize(st.size)}），read_file 只读文本`);
  let text = buf.toString('utf8');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const truncated = st.size > buf.length;
  return {
    path: abs,
    bytes: st.size,
    lines: text ? text.split(/\r?\n/).length : 0,
    truncated,
    text: truncated ? `${text}\n\n…（文件 ${fmtSize(st.size)}，只读了前 ${fmtSize(buf.length)}）` : text
  };
}

/* ── 写文件 ───────────────────────────────────────────────────────────── */

/**
 * 覆盖/新建。写之前再做一次围栏检查；原子写（tmp + rename）避免写一半断电。
 * @returns {{ path: string, bytes: number, created: boolean }}
 */
export function writeTextFile(sandboxRoot, relPath, content, limits = {}) {
  const max = Math.min(Number(limits.maxWriteBytes) || DEFAULT_LIMITS.maxWriteBytes, 8 * 1024 * 1024);
  const text = String(content ?? '');
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > max) throw new Error(`内容太长：${fmtSize(bytes)}，上限 ${fmtSize(max)}`);
  const abs = resolveInside(sandboxRoot, relPath);
  const existed = fs.existsSync(abs);
  if (existed && fs.statSync(abs).isDirectory()) throw new Error(`是目录，不能当文件写：${relPath}`);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  // mkdir 之后再确认一次：新目录本身也可能是别人预先放好的 junction。
  const realRoot = real(sandboxRoot);
  if (!inside(realRoot, real(path.dirname(abs)))) throw new Error(`路径越界（父目录是符号链接）：${relPath}`);
  const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, text, 'utf8');
  try {
    fs.renameSync(tmp, abs);
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw error;
  }
  return { path: abs, bytes, created: !existed };
}

/* ── 搜文件 ───────────────────────────────────────────────────────────── */

/**
 * 按相对路径正则搜，`content` 给了就再按文件内容正则过滤。
 * 只读、有文件数/结果数上限，跳过 node_modules / .git / dist。
 */
export function searchFiles(sandboxRoot, relPath, { pattern = '', content = '' } = {}, limits = {}) {
  const maxFiles = Number(limits.maxSearchFiles) || DEFAULT_LIMITS.maxSearchFiles;
  const maxResults = Number(limits.maxSearchResults) || DEFAULT_LIMITS.maxSearchResults;
  const maxBytes = Math.min(Number(limits.maxReadBytes) || DEFAULT_LIMITS.maxReadBytes, 2 * 1024 * 1024);
  const start = resolveInside(sandboxRoot, relPath || '.', { mustExist: true });
  const pathRe = pattern ? new RegExp(pattern, 'i') : null;
  const contentRe = content ? new RegExp(content, 'i') : null;
  const results = [];
  let scanned = 0;
  let truncated = false;

  const walk = (dir) => {
    if (truncated) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (truncated) return;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue;
        walk(full);
        continue;
      }
      if (!ent.isFile()) continue;
      scanned += 1;
      if (scanned > maxFiles) { truncated = true; return; }
      const rel = path.relative(path.resolve(sandboxRoot), full).split(path.sep).join('/');
      if (pathRe && !pathRe.test(rel)) continue;
      if (contentRe) {
        let text = '';
        try {
          const st = fs.statSync(full);
          if (st.size > maxBytes) continue;
          text = fs.readFileSync(full, 'utf8');
          if (text.slice(0, 8192).includes('\0')) continue;
        } catch { continue; }
        const hit = text.split(/\r?\n/).findIndex((line) => contentRe.test(line));
        if (hit < 0) continue;
        results.push(`${rel}:${hit + 1}: ${text.split(/\r?\n/)[hit].trim().slice(0, 200)}`);
      } else {
        results.push(rel);
      }
      if (results.length >= maxResults) { truncated = true; return; }
    }
  };
  walk(start);
  const head = `在 ${path.relative(path.resolve(sandboxRoot), start) || '.'} 找到 ${results.length} 条${truncated ? `（已截断，扫描上限 ${maxFiles} 个文件 / ${maxResults} 条结果）` : ''}：`;
  return { results, truncated, scanned, text: [head, ...results].join('\n') };
}

/* ── 命令黑名单 ───────────────────────────────────────────────────────── */

/**
 * 每一条都是「一句话就能造成不可逆破坏」或「把远程代码直接跑起来」。
 * 刻意不做成白名单：`npm run build` / `git status` / `node x.js` 这些必须能用。
 * 黑名单是**减少误伤**，不是沙箱 —— 见文件头。
 */
export const DENY_RULES = [
  { re: /\brm\s+(-[a-z]*[rR][a-z]*[fF]|-[a-z]*[fF][a-z]*[rR])\b/, why: 'rm -rf（递归强删）' },
  { re: /\brm\s+(-[a-z]+\s+)*-r\b/, why: 'rm -r（递归删除）' },
  { re: /\bdel\s+.*\/[fsq]\b/i, why: 'del /f /s /q（强删）' },
  { re: /\berase\s+/i, why: 'erase（删除）' },
  { re: /\b(rmdir|rd)\s+.*\/s\b/i, why: 'rd /s（递归删目录）' },
  { re: /\bformat\s+[a-zA-Z]:/i, why: 'format（格式化磁盘）' },
  { re: /\bformat\.com\b/i, why: 'format.com' },
  { re: /\bdiskpart\b/i, why: 'diskpart（分区表）' },
  { re: /\bmkfs(\.\w+)?\b/i, why: 'mkfs（格式化）' },
  { re: /\bdd\s+if=/i, why: 'dd if=（裸写磁盘）' },
  { re: /\bshutdown\b/i, why: 'shutdown（关机）' },
  { re: /\b(restart|stop)-computer\b/i, why: '重启/关机' },
  { re: /\breboot\b/i, why: 'reboot' },
  { re: /\breg\s+delete\b/i, why: 'reg delete（删注册表）' },
  { re: /\bbcdedit\b/i, why: 'bcdedit（改启动项）' },
  { re: /\bvssadmin\b.*\bdelete\b/i, why: 'vssadmin delete（删卷影/备份）' },
  { re: /\bwmic\b.*\bdelete\b/i, why: 'wmic … delete' },
  { re: /\bcipher\s+\/w\b/i, why: 'cipher /w（擦除空闲空间）' },
  { re: /\bnet\s+(user|localgroup)\b/i, why: 'net user/localgroup（改账户/组）' },
  { re: /\bschtasks\b.*\/delete\b/i, why: 'schtasks /delete' },
  { re: /\btaskkill\b.*\/f\b.*\/im\b/i, why: 'taskkill /f /im（按镜像杀进程）' },
  { re: /\bremove-item\b.*-recurse/i, why: 'Remove-Item -Recurse（递归删）' },
  { re: /\bpowershell(\.exe)?\b.*(-enc|-encodedcommand)\b/i, why: 'PowerShell -EncodedCommand（隐藏载荷）' },
  { re: /\b(invoke-expression|iex)\b/i, why: 'Invoke-Expression / iex（当场执行字符串）' },
  { re: /\b(curl|wget)\b[^|]*\|\s*(ba|z|da)?sh\b/i, why: 'curl | sh（远程脚本直接执行）' },
  { re: /\bgit\s+clean\s+-[a-z]*[xXfFdD]/, why: 'git clean（删未跟踪文件）' },
  { re: /\bgit\s+reset\s+--hard\b/i, why: 'git reset --hard（丢未提交改动）' },
  { re: /\bgit\s+push\b.*\s--force\b|\bgit\s+push\b.*\s-f\b/, why: 'git push --force（覆盖远端历史）' },
  { re: /:\(\)\s*\{[^}]*\}\s*;?\s*:/, why: 'fork bomb' },
  { re: /\b(win|)mgmt\b.*\bdelete\b/i, why: 'WMI 删除' }
];

/** 返回 null = 放行；返回字符串 = 拒绝原因。 */
export function checkCommand(command) {
  const cmd = String(command ?? '').trim();
  if (!cmd) return '命令不能为空';
  if (cmd.length > 4000) return '命令太长（上限 4000 字符）';
  if (cmd.includes('\0')) return '命令里不能有 NUL 字符';
  for (const rule of DENY_RULES) {
    if (rule.re.test(cmd)) return `命令被拒绝：${rule.why}`;
  }
  return null;
}

/* ── 执行命令 ─────────────────────────────────────────────────────────── */

function killTree(child) {
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }
  } catch { /* 已经退出 */ }
}

/**
 * 在沙箱根下跑一条命令。超时杀整棵进程树；输出超过上限就停止收集（但继续排空管道，
 * 不然子进程会卡在写满的管道上）。
 *
 * @returns {Promise<{ command: string, cwd: string, exitCode: number|null, timedOut: boolean,
 *                     truncated: boolean, ms: number, stdout: string, stderr: string }>}
 */
export function runCommand(sandboxRoot, command, limits = {}) {
  const deny = checkCommand(command);
  if (deny) return Promise.reject(new Error(deny));
  const t = Number(limits.timeoutMs) || DEFAULT_LIMITS.timeoutMs;
  const timeoutMs = Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, t));
  const maxOut = Math.min(Number(limits.maxOutputBytes) || DEFAULT_LIMITS.maxOutputBytes, 4 * 1024 * 1024);
  const cwd = path.resolve(sandboxRoot);
  if (!fs.existsSync(cwd)) return Promise.reject(new Error(`沙箱目录不存在：${cwd}`));

  return new Promise((resolve, reject) => {
    const started = Date.now();
    const isWin = process.platform === 'win32';
    // cmd 默认按本地代码页输出（中文 Windows 是 GBK），先切 UTF-8 再跑，否则中文全是乱码。
    const cmdLine = isWin ? `chcp 65001>nul & ${command}` : command;
    const child = isWin
      ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', cmdLine], { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn('/bin/bash', ['-lc', command], { cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let out = '';
    let err = '';
    let outBytes = 0;
    let truncated = false;
    let timedOut = false;

    const collect = (which) => (chunk) => {
      const room = maxOut - outBytes;
      if (room <= 0) { truncated = true; return; }
      const piece = chunk.length > room ? chunk.subarray(0, room) : chunk;
      if (piece.length < chunk.length) truncated = true;
      outBytes += piece.length;
      if (which === 'out') out += piece.toString('utf8');
      else err += piece.toString('utf8');
    };
    child.stdout.on('data', collect('out'));
    child.stderr.on('data', collect('err'));

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`启动命令失败：${error?.message ?? error}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        command: String(command),
        cwd,
        exitCode: code,
        timedOut,
        truncated,
        ms: Date.now() - started,
        stdout: out.trimEnd(),
        stderr: err.trimEnd()
      });
    });
  });
}

/** 把 execute_command 的结果拼成模型能直接读的文本。 */
export function formatCommandResult(r) {
  const lines = [];
  lines.push(`$ ${r.command}`);
  lines.push(`cwd: ${r.cwd}`);
  lines.push(`exit: ${r.exitCode ?? '(null)'} · ${r.ms} ms${r.timedOut ? ` · 超时（已被杀掉）` : ''}${r.truncated ? ' · 输出已截断' : ''}`);
  if (r.stdout) lines.push('', '--- stdout ---', r.stdout);
  if (r.stderr) lines.push('', '--- stderr ---', r.stderr);
  if (!r.stdout && !r.stderr) lines.push('', '(无输出)');
  return lines.join('\n');
}
