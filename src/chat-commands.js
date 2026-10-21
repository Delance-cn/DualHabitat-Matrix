// 本地聊天指令层：/ 开头、管理员专属、不经模型，由桥接进程直接执行。
//
// 覆盖范围（2026-10-21）：
//   /help /ping /screenshot /lock /shutdown /cancel-shutdown /find /plugins
//   + plugins/*.js 里的插件命令（ESM，default 导出 { name, description, commands }）
//
// 安全边界：
//   - 调用方（bridge.js / wechat-bot.js）负责「发送者是不是 owner」的判断，本模块不重复判断；
//   - config.commands.enabled === false 时整层关闭，/ 开头的消息按原逻辑继续走；
//   - 插件是本地代码，拥有与桥接进程相同的权限 —— 只装自己写得出来的东西。
//
// 微信侧说明：iLink 通道发不了图片，/screenshot 会落到临时目录并把路径发回来。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const HELP_HEADER = '本地指令（管理员专属，不经模型）：';

function fmtBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '?';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/* ── 截屏：PowerShell + System.Drawing，无第三方依赖 ─────────────── */

function captureScreenPng() {
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms,System.Drawing',
    '$b=[System.Windows.Forms.SystemInformation]::VirtualScreen',
    '$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height',
    '$g=[System.Drawing.Graphics]::FromImage($bmp)',
    '$g.CopyFromScreen($b.Left,$b.Top,0,0,$bmp.Size)',
    '$ms=New-Object System.IO.MemoryStream',
    '$bmp.Save($ms,[System.Drawing.Imaging.ImageFormat]::Png)',
    '$g.Dispose()',
    '$bmp.Dispose()',
    '[Convert]::ToBase64String($ms.ToArray())'
  ].join('; ');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    encoding: 'buffer',
    maxBuffer: 96 * 1024 * 1024,
    timeout: 30_000,
    windowsHide: true
  });
  if (r.status !== 0 || !r.stdout || !r.stdout.length) {
    const err = r.stderr ? r.stderr.toString('utf8').slice(0, 200) : '';
    throw new Error(`截屏失败（PowerShell exit ${r.status}）${err ? `：${err}` : ''}`);
  }
  const buf = Buffer.from(r.stdout.toString('utf8').trim(), 'base64');
  if (!buf.length) throw new Error('截屏失败：没有拿到图像数据');
  return buf;
}

/* ── /find：限定根目录的文件名搜索，BFS + 上限防爆 ───────────────── */

function defaultFindRoots() {
  const home = os.homedir();
  return ['Desktop', 'Documents', 'Downloads', 'Videos', 'Pictures']
    .map((d) => path.join(home, d))
    .filter((d) => {
      try {
        return fs.statSync(d).isDirectory();
      } catch {
        return false;
      }
    });
}

function findFiles(query, startDir, opts = {}) {
  const maxMatches = opts.maxMatches ?? 15;
  const maxScanned = opts.maxScanned ?? 20000;
  const maxDepth = opts.maxDepth ?? 8;
  const q = String(query).toLowerCase();
  const found = [];
  let scanned = 0;
  const walk = (dir, depth) => {
    if (found.length >= maxMatches || scanned >= maxScanned || depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (found.length >= maxMatches || scanned >= maxScanned) return;
      scanned += 1;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full, depth + 1);
      } else if (e.name.toLowerCase().includes(q)) {
        let size = 0;
        try {
          size = fs.statSync(full).size;
        } catch {
          /* 拿不到大小不影响搜索结果 */
        }
        found.push(`${full}（${fmtBytes(size)}）`);
      }
    }
  };
  walk(startDir, 0);
  return { found, scanned };
}

/* ── 插件装载 ─────────────────────────────────────────────────── */

/**
 * 读取 dir 下的 .js/.mjs，import 后收集命令。
 * 加载失败只记账不抛错：一个坏插件不能拖垮整条指令层。
 * @returns {{plugins: Array, errors: string[], dir: string}}
 */
export async function loadPlugins(dir, log = () => {}) {
  const out = { plugins: [], errors: [], dir };
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.js') || f.endsWith('.mjs'));
  } catch {
    return out; // 目录不存在 = 没装插件，不是错误
  }
  for (const f of files) {
    try {
      // 带时间戳查一下缓存：重载时改过的插件要真的重新执行
      const mod = await import(`${pathToFileURL(path.join(dir, f)).href}?v=${Date.now()}`);
      const p = mod.default ?? mod;
      if (!p || !Array.isArray(p.commands)) {
        throw new Error('必须 default 导出 { name, description, commands: [...] }');
      }
      const commands = p.commands
        .filter((c) => c && typeof c.name === 'string' && typeof c.run === 'function')
        .map((c) => ({
          name: c.name,
          usage: String(c.usage ?? `/${c.name}`),
          description: String(c.description ?? ''),
          run: c.run
        }));
      out.plugins.push({
        file: f,
        name: String(p.name ?? f),
        description: String(p.description ?? ''),
        commands
      });
    } catch (error) {
      const line = `${f}：${error?.message ?? error}`;
      out.errors.push(line);
      log(`⚠️ 插件加载失败 ${line}`);
    }
  }
  return out;
}

/* ── 指令表 ───────────────────────────────────────────────────── */

export function localCommandHelp(ctx = {}) {
  const lines = [
    HELP_HEADER,
    '/help —— 本列表',
    '/ping —— 活性检查（返回进程运行时长）',
    '/screenshot —— 截全屏发回来（微信侧返回文件路径）',
    '/lock —— 锁定这台电脑（等同 Win+L）',
    '/shutdown [秒] —— 定时关机，默认 60 秒，最少 5 秒',
    '/cancel-shutdown —— 取消定时关机（也可 /shutdown cancel）',
    '/find <关键词> [目录] —— 在常用目录按文件名搜索，最多 15 条',
    '/plugins —— 已装载的插件与它们的命令'
  ];
  for (const h of ctx.adminHelp ?? []) lines.push(h);
  const pluginLines = [];
  for (const p of ctx.plugins ?? []) {
    for (const c of p.commands ?? []) pluginLines.push(`${c.usage || `/${c.name}`} —— ${c.description || p.name}`);
  }
  if (pluginLines.length) lines.push('插件命令：', ...pluginLines);
  return lines.join('\n');
}

/**
 * 执行一条本地指令。
 * @returns {Promise<null | {handled: true, plugin?: string, error?: Error}>}
 *   null = 不是本地指令（例如 /model），调用方按原逻辑继续处理
 */
export async function runLocalCommand(text, ctx = {}) {
  if (ctx.config?.commands?.enabled === false) return null; // 总开关：关了就当没看见
  const trimmed = String(text ?? '').trim();
  if (!trimmed.startsWith('/')) return null;

  const parts = trimmed.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1);
  const reply = ctx.reply ?? (() => {});

  try {
    switch (cmd) {
      case '/help':
        reply(localCommandHelp(ctx));
        return { handled: true };

      case '/ping':
        reply(`pong（${ctx.platform ?? '?'} 通道，进程已运行 ${Math.floor(process.uptime())} 秒）`);
        return { handled: true };

      case '/screenshot': {
        const buf = captureScreenPng();
        if (typeof ctx.replyImage === 'function') {
          await ctx.replyImage(buf, `screenshot-${Date.now()}.png`);
        } else {
          const file = path.join(os.tmpdir(), `dhm-screenshot-${Date.now()}.png`);
          fs.writeFileSync(file, buf);
          reply(`截图已存到电脑：${file}（这个通道发不了图片，回到电脑上看）`);
        }
        return { handled: true };
      }

      case '/lock':
        spawn('rundll32.exe', ['user32.dll,LockWorkStation'], { stdio: 'ignore', windowsHide: true }).unref();
        reply('已锁定这台电脑。');
        return { handled: true };

      case '/shutdown': {
        if (args[0] === 'cancel' || args[0] === 'abort') {
          spawn('shutdown.exe', ['/a'], { stdio: 'ignore', windowsHide: true }).unref();
          reply('已取消定时关机（如果有的话）。');
          return { handled: true };
        }
        const raw = Number(args[0]);
        const configured = Number(ctx.config?.commands?.shutdownDelaySec ?? 60) || 60;
        const delay = Number.isFinite(raw) && raw > 0
          ? Math.min(Math.max(Math.floor(raw), 5), 3600)
          : Math.min(Math.max(Math.floor(configured), 5), 3600);
        spawn('shutdown.exe', ['/s', '/t', String(delay)], { stdio: 'ignore', windowsHide: true }).unref();
        reply(`电脑将在 ${delay} 秒后关机。反悔请马上发 /cancel-shutdown。`);
        return { handled: true };
      }

      case '/cancel-shutdown':
        spawn('shutdown.exe', ['/a'], { stdio: 'ignore', windowsHide: true }).unref();
        reply('已取消定时关机（如果有的话）。');
        return { handled: true };

      case '/find': {
        if (!args.length) {
          reply('用法：/find <关键词> [目录]');
          return { handled: true };
        }
        // 关键词之后的所有词都算目录（路径里可以有空格）
        const dirArg = args.slice(1).join(' ').trim();
        const roots = dirArg
          ? [path.resolve(dirArg)]
          : (Array.isArray(ctx.config?.commands?.roots) && ctx.config.commands.roots.length
            ? ctx.config.commands.roots.map((r) => String(r))
            : defaultFindRoots());
        const hits = [];
        let scanned = 0;
        for (const root of roots) {
          if (hits.length >= 15) break;
          const r = findFiles(args[0], root);
          hits.push(...r.found.slice(0, 15 - hits.length));
          scanned += r.scanned;
        }
        reply(
          hits.length
            ? `在 ${roots.join('、')} 找到 ${hits.length} 个（扫了 ${scanned} 项，最多显示 15 条）：\n${hits.join('\n')}`
            : `没找到名字带「${args[0]}」的文件（扫了 ${scanned} 项）。可以带第二个参数指定目录，比如 /find 报表 D:\\工作`
        );
        return { handled: true };
      }

      case '/plugins': {
        const ps = ctx.plugins ?? [];
        if (!ps.length) {
          reply(`插件目录是 ${ctx.pluginsDir ?? '<桥接根>/plugins'}，还没有装任何插件。把 .js 插件放进去，重启桥接生效。`);
          return { handled: true };
        }
        const lines = ps.map((p) => {
          const cmds = (p.commands ?? []).map((c) => `/${c.name}`).join('、');
          return `• ${p.name}${p.description ? `：${p.description}` : ''}（${p.file}）${cmds ? `\n  ${cmds}` : ''}`;
        });
        reply(lines.join('\n'));
        return { handled: true };
      }

      default:
        break;
    }

    // 插件命令
    for (const p of ctx.plugins ?? []) {
      for (const c of p.commands ?? []) {
        if (`/${String(c.name).toLowerCase()}` === cmd) {
          await c.run({ ...ctx, reply, args }, args);
          return { handled: true, plugin: p.name };
        }
      }
    }

    return null; // 不是本地指令（如 /model），交回调用方
  } catch (error) {
    reply(`⚠️ 指令执行失败：${String(error?.message ?? error).slice(0, 300)}`);
    return { handled: true, error };
  }
}
