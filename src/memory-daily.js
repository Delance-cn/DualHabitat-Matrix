// 每日记忆日志：state/memory/<角色>/<通道>-<YYYY-MM-DD>.md
//
// 设计：
// - 每个角色一个目录（角色名做了文件名净化），每个通道每天一个 md 文件
// - 文件由桥接/微信进程**增量追加**（每条收发的消息一行），跨天自动换文件
// - 新的一天第一笔写入时会自动带上文件头（日期/角色/通道/说明）
// - 供 mcp-memory.js 的 memory_read / memory_list 工具读取：
//   新开对话时模型可以自主决定读哪天、读多少天、按关键词过滤
//
// 隐私：整个目录在 state/ 下（gitignore），绝不出本机。

import fs from 'node:fs';
import path from 'node:path';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 角色名 → 安全的目录名 */
export function sanitizeRoleName(role) {
  const raw = String(role ?? '').trim() || '默认';
  return raw.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').slice(0, 40) || '默认';
}

export function dateStr(now = new Date(), offsetDays = 0) {
  const d = new Date(now.getTime() + offsetDays * 86_400_000);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function clockStr(now = new Date()) {
  return [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
}

export function memoryRoot(root) {
  return path.join(root, 'state', 'memory');
}

export function memoryDirFor(root, role) {
  return path.join(memoryRoot(root), sanitizeRoleName(role));
}

/** 追加一条记忆。role 传当前角色名；channel 是 'qq' 或 'wechat'。 */
export function appendMemory({ root, channel, role, conv, who, self = false, text, now = new Date() }) {
  const dir = memoryDirFor(root, sanitizeRoleName(role));
  fs.mkdirSync(dir, { recursive: true });
  const date = dateStr(now);
  const file = path.join(dir, `${channel}-${date}.md`);
  if (!fs.existsSync(file)) {
    const head = [
      `# 记忆日志 ${date}`,
      '',
      `- 角色：${sanitizeRoleName(role)}`,
      `- 通道：${channel === 'wechat' ? '微信' : 'QQ'}`,
      '- 说明：由桥接自动记录的当日全部收发消息。新开的对话可以用 memory_read 工具读取任意一天。',
      '',
      '## 记录',
      ''
    ].join('\n');
    fs.writeFileSync(file, head, 'utf8');
  }
  const line = `- [${clockStr(now)}] ${self ? '机器人' : String(who ?? '未知')}（${conv}）：${String(text ?? '').replace(/\r?\n/g, ' ⏎ ').slice(0, 500)}\n`;
  fs.appendFileSync(file, line, 'utf8');
  return file;
}

/** 列出某个角色（或全部角色）有记忆日志的日期 */
export function listMemoryDates(root, role = '*') {
  const base = memoryRoot(root);
  const out = [];
  let roleDirs = [];
  try {
    roleDirs = fs.readdirSync(base).filter((d) => {
      try { return fs.statSync(path.join(base, d)).isDirectory(); } catch { return false; }
    });
  } catch { return out; }
  for (const dir of roleDirs) {
    if (role !== '*' && dir !== sanitizeRoleName(role)) continue;
    for (const f of fs.readdirSync(path.join(base, dir))) {
      const m = /^(qq|wechat)-(\d{4}-\d{2}-\d{2})\.md$/.exec(f);
      if (m) out.push({ role: dir, channel: m[1], date: m[2], file: path.join(base, dir, f) });
    }
  }
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.channel < b.channel ? -1 : 1));
  return out;
}

/**
 * 读取记忆日志。
 * @param {object} o
 * @param {string} [o.role]   角色名；不传 = 所有角色
 * @param {string} [o.date]   'yesterday'（默认）/ 'today' / 'YYYY-MM-DD'
 * @param {number} [o.days]   从 date 往前再读几天（1-30，默认 1）
 * @param {string} [o.keyword] 只保留含关键词的行
 */
export function readMemory(root, { role, date = 'yesterday', days = 1, keyword } = {}) {
  const all = listMemoryDates(root, role);
  if (!all.length) return { text: '还没有任何记忆日志。', dates: [] };

  const now = new Date();
  let anchor;
  if (date === 'today') anchor = dateStr(now);
  else if (date === 'yesterday' || !date) anchor = dateStr(now, -1);
  else if (DATE_RE.test(String(date))) anchor = String(date);
  else return { text: `日期格式不对：${date}（要 YYYY-MM-DD、today 或 yesterday）`, dates: [] };

  const n = Math.min(Math.max(Number(days) || 1, 1), 30);
  const wanted = new Set();
  for (let i = 0; i < n; i++) wanted.add(dateStr(new Date(anchor + 'T12:00:00'), -i));

  const files = all.filter((x) => wanted.has(x.date));
  if (!files.length) {
    const have = [...new Set(all.map((x) => x.date))].sort().reverse().slice(0, 8);
    return { text: `没有 ${anchor} 起往前 ${n} 天的记忆日志。已有的日期：${have.join('、') || '（无）'}`, dates: have };
  }

  const sections = [];
  for (const f of files) {
    let body = '';
    try { body = fs.readFileSync(f.file, 'utf8'); } catch { continue; }
    let content = body;
    if (keyword) {
      const kept = body.split('\n').filter((l) => l.includes(keyword));
      content = kept.length ? kept.join('\n') : '';
      if (!content) continue;
    }
    sections.push(`### ${f.role} · ${f.channel === 'wechat' ? '微信' : 'QQ'} · ${f.date}\n\n${content.trim()}`);
  }
  const text = sections.length ? sections.join('\n\n') : '选中的日期里没有匹配的内容。';
  return { text, dates: files.map((f) => f.date) };
}
