// 事件查看器：按类型过滤 probe 落盘的 jsonl。
//
// 用法：
//   node spike/inspect-events.mjs spike/logs/probe-tools-events.jsonl
//   node spike/inspect-events.mjs spike/logs/probe-tools-events.jsonl session.tool
//   node spike/inspect-events.mjs spike/logs/probe-tools-events.jsonl --types
//
// 用 Node 而不是 PowerShell：本机 powershell 5.1 默认按 ANSI 读文件，
// UTF-8 事件里的中文会被读坏，进而 JSON.parse 抛错（实测踩过）。
import fs from 'node:fs';

const [file, filter] = process.argv.slice(2);
if (!file) {
  console.error('用法: node spike/inspect-events.mjs <jsonl> [类型前缀 | --types]');
  process.exit(1);
}

const events = fs.readFileSync(file, 'utf8')
  .split('\n')
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line));

if (filter === '--types') {
  const counts = new Map();
  for (const event of events) counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
  for (const [type, count] of [...counts].sort()) console.log(`${String(count).padStart(4)}  ${type}`);
  process.exit(0);
}

const matched = filter ? events.filter((event) => String(event.type).includes(filter)) : events;
console.log(`匹配 ${matched.length} / ${events.length} 条`);
for (const event of matched) {
  console.log(`\n--- ${event.type}  (seq=${event.durable?.seq ?? '-'})`);
  console.log(JSON.stringify(event.data ?? event, null, 2));
}
