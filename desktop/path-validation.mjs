import fs from 'node:fs';
import path from 'node:path';

export function validateDirectoryPath(value, label, { create = false } = {}) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  try {
    const resolved = path.resolve(raw);
    if (create && !fs.existsSync(resolved)) fs.mkdirSync(resolved, { recursive: true });
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      return `${label}不是有效文件夹：${raw}`;
    }
  } catch (error) {
    return `${label}不可用：${error?.message ?? error}`;
  }
  return null;
}
