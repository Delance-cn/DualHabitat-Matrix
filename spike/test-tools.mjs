/**
 * 只读工具集的安全边界测试。
 *
 * 这些断言不是"功能演示"，是**防止模型读到不该读的东西**：
 * 越界、密钥、状态目录、二进制，任何一条漏了都可能把 secrets.json 送进 QQ。
 *
 *   node spike/test-tools.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkspaceTools } from '../src/backends/tools.js';

let pass = 0;
let fail = 0;
function check(label, ok, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`  ✅ ${label}`);
  } else {
    fail += 1;
    console.log(`  ❌ ${label}${detail ? `  — ${detail}` : ''}`);
  }
}

/* ── 造一个假工作区 ─────────────────────────────────────────────────────── */

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-test-'));
fs.mkdirSync(path.join(root, 'src'), { recursive: true });
fs.mkdirSync(path.join(root, 'state'), { recursive: true });
fs.mkdirSync(path.join(root, 'node_modules', 'x'), { recursive: true });
fs.mkdirSync(path.join(root, '.oc'), { recursive: true });

fs.writeFileSync(path.join(root, 'note.txt'), 'line1\nline2\nThe secret word is MANGO\nline4\n', 'utf8');
fs.writeFileSync(path.join(root, 'src', 'app.js'), 'function hello() {\n  return "needle-in-code";\n}\n', 'utf8');
fs.writeFileSync(path.join(root, 'secrets.json'), '{"OPENROUTER_API_KEY":"sk-should-never-leak"}', 'utf8');
fs.writeFileSync(path.join(root, '.env'), 'TOKEN=should-never-leak', 'utf8');
fs.writeFileSync(path.join(root, 'state', 'tokens.json'), '{"token":"should-never-leak"}', 'utf8');
fs.writeFileSync(path.join(root, 'node_modules', 'x', 'index.js'), 'needle-in-code', 'utf8');
fs.writeFileSync(path.join(root, '.oc', 'state.json'), 'needle-in-code', 'utf8');
fs.writeFileSync(path.join(root, 'binary.bin'), Buffer.from([0x00, 0x01, 0x02, 0x41]), 'utf8');

const tools = createWorkspaceTools({ workspace: root });

console.log('\n── 正常读取');
{
  const out = tools.execute('read_file', { path: 'note.txt' });
  check('读到内容', out.includes('MANGO'));
  check('带行号', /^1\tline1/m.test(out), JSON.stringify(out.slice(0, 30)));
}
{
  const out = tools.execute('read_file', { path: 'note.txt', offset: 3, limit: 1 });
  check('offset/limit 生效', out.includes('MANGO') && !out.includes('line1'), JSON.stringify(out.slice(0, 60)));
}
{
  const out = tools.execute('list_dir', { path: 'src' });
  check('list_dir 能列目录', out.includes('app.js'), JSON.stringify(out.slice(0, 60)));
}
{
  const out = tools.execute('search_text', { query: 'needle-in-code' });
  const normalized = out.replace(/\\/g, '/');
  check('search_text 命中源码', normalized.includes('src/app.js'), JSON.stringify(out.slice(0, 80)));
  check('search_text 不扫 node_modules', !out.includes('node_modules'));
  check('search_text 不扫 .oc', !out.includes('.oc'));
}

console.log('\n── 敏感文件必须拒绝');
for (const rel of ['secrets.json', '.env', 'state/tokens.json', '.oc/state.json']) {
  const out = tools.execute('read_file', { path: rel });
  check(`拒绝读 ${rel}`, out.startsWith('错误：') && !out.includes('should-never-leak'), JSON.stringify(out.slice(0, 60)));
}
{
  const out = tools.execute('read_file', { path: 'binary.bin' });
  check('拒绝二进制', out.startsWith('错误：'), JSON.stringify(out.slice(0, 60)));
}

console.log('\n── 越界必须拒绝');
for (const rel of ['../outside.txt', '..', '../../Windows/win.ini', 'src/../../secrets.json']) {
  const out = tools.execute('read_file', { path: rel });
  check(`拒绝越界 ${rel}`, out.startsWith('错误：'), JSON.stringify(out.slice(0, 60)));
}
{
  // 绝对路径指到工作区外
  const outside = path.join(os.tmpdir(), 'outside-tools-test.txt');
  fs.writeFileSync(outside, 'outside', 'utf8');
  const out = tools.execute('read_file', { path: outside });
  check('拒绝工作区外的绝对路径', out.startsWith('错误：'), JSON.stringify(out.slice(0, 60)));
}

console.log('\n── 未知工具');
{
  const out = tools.execute('write_file', { path: 'x', content: 'y' });
  check('没有 write 工具', out.startsWith('错误：'), out);
}

fs.rmSync(root, { recursive: true, force: true });

console.log(`\n${fail ? `❌ ${fail} 项失败 / ${pass + fail}` : `✅ 全部通过（${pass} 项）`}`);
process.exit(fail ? 1 : 0);
