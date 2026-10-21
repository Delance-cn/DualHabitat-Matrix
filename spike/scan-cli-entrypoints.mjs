/**
 * 在几个 Electron 应用里找「能用命令行跑」的入口。
 *
 * 为什么要扫而不是看名字：这些下载页都写「CLI」，装完其实是 Electron 套壳 GUI。
 * 真正的无头入口藏在 resources/ 或者随包里带的另一份二进制里，名字也不一样
 * （Cline 那个就叫 cline-cli.exe，跟 GUI 的 cline-app.exe 并排放在一起）。
 *
 * 输出：每个应用一份候选清单 —— 可执行文件 + package.json 里的 bin 字段。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const APPS = [
  ['Kimi', path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Kimi')],
  ['GitHub Copilot', path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'GitHub Copilot')],
  ['KiroCrew', path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'KiroCrew')],
  ['DeepSeek Harness', path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'DeepSeek Harness')],
  ['Cline', path.join(os.homedir(), 'AppData', 'Local', 'Cline')]
];

/** GUI 的壳：知道是壳就不再当候选报出来。 */
const SHELL_NAMES = /^(chrome|crashpad|notification_helper|elevation_service|.*-installer|uninstall|Uninstall|setup)/i;

const EXEC_EXT = new Set(['.exe', '.cmd', '.bat', '.ps1', '.sh']);
/** 跳过明显不是入口的巨目录，否则 node_modules 里几万个文件会把输出冲爆。 */
const SKIP_DIR = /^(node_modules|\.git|locales|swiftshader)$/i;
const MAX_DEPTH = 4;

function walk(dir, depth = 0, out = { exes: [], bins: [] }) {
  if (depth > MAX_DEPTH) return out;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIR.test(e.name)) continue;
      walk(full, depth + 1, out);
      continue;
    }
    const ext = path.extname(e.name).toLowerCase();
    if (EXEC_EXT.has(ext)) {
      let size = 0;
      try {
        size = fs.statSync(full).size;
      } catch {}
      out.exes.push({ full, size, name: e.name });
    }
    if (e.name === 'package.json') {
      try {
        const pkg = JSON.parse(fs.readFileSync(full, 'utf8'));
        if (pkg.bin) out.bins.push({ full, name: pkg.name ?? '(unnamed)', bin: pkg.bin });
      } catch {}
    }
  }
  return out;
}

const mb = (n) => (n / 1024 / 1024).toFixed(1) + 'MB';

for (const [label, dir] of APPS) {
  console.log(`\n══════════ ${label}`);
  console.log(`  dir: ${dir}`);
  if (!fs.existsSync(dir)) {
    console.log('  (missing)');
    continue;
  }
  const { exes, bins } = walk(dir);

  const real = exes.filter((e) => !SHELL_NAMES.test(e.name) && e.size > 200 * 1024);
  real.sort((a, b) => b.size - a.size);

  console.log(`  可执行文件（${real.length} 个，>200KB）:`);
  for (const e of real.slice(0, 25)) {
    console.log(`    ${mb(e.size).padStart(8)}  ${path.relative(dir, e.full)}`);
  }

  if (bins.length) {
    console.log(`  package.json 里的 bin:`);
    for (const b of bins.slice(0, 12)) {
      const spec = typeof b.bin === 'string' ? { [b.name]: b.bin } : b.bin;
      console.log(`    ${b.name}  ->  ${JSON.stringify(spec)}   [${path.relative(dir, b.full)}]`);
    }
  }
}
