/**
 * 读 Cline CLI 的本地配置，但把密钥遮掉。
 *
 * 为什么单独一个文件：这些 JSON 里有 API key，用 `node -e` 内联脚本会被 PowerShell
 * 的引号规则撕碎（还会把密钥打进终端回滚区）。写成文件既能正确解析，也方便统一遮挡。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const dir = path.join(os.homedir(), '.cline', 'data', 'settings');

/** 长的不透明串一律遮掉，只留前 6 位；URL 和普通短值不动。 */
function mask(value) {
  if (typeof value === 'string' && value.length >= 24 && !/^https?:\/\//.test(value)) {
    return `${value.slice(0, 6)}…(masked, ${value.length} chars)`;
  }
  return value;
}

function maskDeep(node, keyHint = '') {
  if (Array.isArray(node)) return node.map((v) => maskDeep(v, keyHint));
  if (node && typeof node === 'object') {
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, maskDeep(v, k)]));
  }
  // apiKey / keys 这类字段无论长短都遮
  if (/key|token|secret|password/i.test(keyHint)) {
    return typeof node === 'string' && node ? `${node.slice(0, 4)}…(masked)` : node;
  }
  return mask(node);
}

for (const file of ['global-settings.json', 'providers.json']) {
  const full = path.join(dir, file);
  console.log(`===== ${file}`);
  if (!fs.existsSync(full)) {
    console.log('(missing)');
    continue;
  }
  try {
    const json = JSON.parse(fs.readFileSync(full, 'utf8'));
    console.log(JSON.stringify(maskDeep(json), null, 2));
  } catch (error) {
    console.log(`读不动：${error?.message ?? error}`);
  }
}

/* providers.json 里如果只有 provider 名，顺手把「哪个 provider 有 key」列一下，
 * 但**不打印** key 的内容 —— 只需要知道能不能拿来试跑。 */
const provFile = path.join(dir, 'providers.json');
if (fs.existsSync(provFile)) {
  try {
    const json = JSON.parse(fs.readFileSync(provFile, 'utf8'));
    console.log('\n===== 有凭据的 provider（只看有没有，不看值）');
    const walk = (node, trail = []) => {
      if (!node || typeof node !== 'object') return;
      for (const [k, v] of Object.entries(node)) {
        if (typeof v === 'string' && v.length > 0 && /key|token|secret|password/i.test(k)) {
          console.log(`  ${[...trail, k].join('.')} = 已设置（${v.length} 字符）`);
        } else if (v && typeof v === 'object') {
          walk(v, [...trail, k]);
        }
      }
    };
    walk(json);
  } catch {
    /* 上面已经报过 */
  }
}
