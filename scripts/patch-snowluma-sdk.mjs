// 修 @snowluma/sdk 的 ESM 断链。
//
// 问题：npm 上发布的 1.14.20 ~ 1.14.22 的 dist 里，相对导入**不带扩展名**
// （`export { SnowLumaApiClient } from './client/api-client'`）。Node 的 ESM
// 解析器不会自动补 `.js`，所以 `import '@snowluma/sdk'` 直接
// ERR_MODULE_NOT_FOUND —— 包本身在 Node 里是跑不起来的。
//
// 上游项目能跑，是因为它跑在支持 `--experimental-specifier-resolution=node`
// 的 Node 上；那个开关在 Node 22 已经没了，所以这里只能在安装后把导入补齐。
//
// 做法：遍历 dist 下所有 .js，把「相对路径且没扩展名」的说明符补成 `.js`，
// 目录形式补成 `/index.js`。幂等，可以反复跑。
//
// 由 package.json 的 postinstall 自动调用，也可以手动：
//   node scripts/patch-snowluma-sdk.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SDK_DIST = path.join(ROOT, 'node_modules', '@snowluma', 'sdk', 'dist');

/** 只匹配 `from '...'` 与 `import '...'`，不碰注释里的说明符。 */
const SPEC_RE = /(\bfrom\s*|\bimport\s*)(['"])(\.[^'"]*)\2/g;

function resolveSpecifier(fromFile, spec) {
  if (/\.(js|mjs|cjs|json)$/.test(spec)) return spec;
  const target = path.resolve(path.dirname(fromFile), spec);
  if (fs.existsSync(`${target}.js`)) return `${spec}.js`;
  if (fs.existsSync(path.join(target, 'index.js'))) return `${spec}/index.js`;
  return spec;
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

function main() {
  if (!fs.existsSync(SDK_DIST)) {
    console.log('[patch-sdk] 没装 @snowluma/sdk，跳过');
    return;
  }
  let files = 0;
  let edits = 0;
  for (const file of walk(SDK_DIST)) {
    const before = fs.readFileSync(file, 'utf8');
    const after = before.replace(SPEC_RE, (match, keyword, quote, spec) => {
      const fixed = resolveSpecifier(file, spec);
      if (fixed === spec) return match;
      edits += 1;
      return `${keyword}${quote}${fixed}${quote}`;
    });
    if (after !== before) {
      fs.writeFileSync(file, after, 'utf8');
      files += 1;
    }
  }
  console.log(`[patch-sdk] 修好 ${edits} 处导入（${files} 个文件）`);
}

main();
