/**
 * 再深一层：找 GUI 套壳里真正能干活的入口。
 *
 * 上一轮（scan-cli-entrypoints.mjs）只扫了 4 层、跳过了 node_modules，
 * 结果 GitHub Copilot 和 DeepSeek Harness 一个候选都没找到。但这两个的目录里
 * 明明有 copilot-sdk / terminal-integration 这种一看就像 CLI 的东西 ——
 * 所以这轮进 node_modules，专门看 package.json 的 bin 字段。
 *
 * Microsoft Copilot 是商店应用（MSIX），装在 WindowsApps 下，走另一套路径。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const targets = [
  ['GitHub Copilot', path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'GitHub Copilot')],
  ['DeepSeek Harness', path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'DeepSeek Harness')]
];

/** 只在「看起来像入口」的目录里找 bin，不用全盘遍历。 */
const INTERESTING = /^(bin|cli|copilot-sdk|terminal-integration|plugins|resources|app|backend|resources\/app)$/i;

function findBins(root) {
  const hits = [];
  const stack = [[root, 0]];
  while (stack.length) {
    const [dir, depth] = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        // node_modules 里只看一层（@scope/pkg），再深就是依赖的依赖，没意义
        const inModules = /node_modules/.test(full);
        if (inModules && depth > 8) continue;
        if (depth < 6) stack.push([full, depth + 1]);
        continue;
      }
      if (e.name === 'package.json') {
        try {
          const pkg = JSON.parse(fs.readFileSync(full, 'utf8'));
          if (pkg.bin) hits.push({ pkg: pkg.name ?? '(unnamed)', bin: pkg.bin, at: path.relative(root, full) });
        } catch {}
      }
      if (/\.(exe|cmd|bat)$/i.test(e.name)) {
        let size = 0;
        try {
          size = fs.statSync(full).size;
        } catch {}
        if (size > 100 * 1024) hits.push({ exe: path.relative(root, full), size });
      }
    }
  }
  return hits;
}

for (const [label, dir] of targets) {
  console.log(`\n══════════ ${label}`);
  if (!fs.existsSync(dir)) {
    console.log('  (missing)');
    continue;
  }
  console.log('  顶层:');
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    console.log(`    ${e.isDirectory() ? '[D]' : '[F]'} ${e.name}`);
  }
  console.log('  候选入口:');
  const hits = findBins(dir);
  const seen = new Set();
  for (const h of hits) {
    const key = JSON.stringify(h);
    if (seen.has(key)) continue;
    seen.add(key);
    if (h.exe) console.log(`    exe  ${(h.size / 1048576).toFixed(1)}MB  ${h.exe}`);
    else console.log(`    bin  ${h.pkg}  ->  ${JSON.stringify(h.bin)}   [${h.at}]`);
  }
  if (!hits.length) console.log('    （没有）');
}

/* ── Microsoft Copilot（商店应用）──────────────────────────────────── */

console.log('\n══════════ Microsoft Copilot');
for (const base of [
  path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'Copilot'),
  'C:\\Program Files\\Microsoft Copilot',
  'C:\\Program Files (x86)\\Microsoft Copilot',
  path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Microsoft Copilot')
]) {
  console.log(`  ${base}  ->  ${fs.existsSync(base) ? '存在' : '无'}`);
  if (fs.existsSync(base)) {
    for (const e of fs.readdirSync(base, { withFileTypes: true }).slice(0, 20)) {
      console.log(`      ${e.isDirectory() ? '[D]' : '[F]'} ${e.name}`);
    }
  }
}
