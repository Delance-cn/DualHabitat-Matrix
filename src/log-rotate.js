import fs from 'node:fs';

export function rotateLogFile(file, { maxBytes = 10 * 1024 * 1024, backups = 3 } = {}) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  if (!stat.isFile() || stat.size < maxBytes) return false;

  for (let index = backups; index >= 1; index -= 1) {
    const source = index === 1 ? file : `${file}.${index - 1}`;
    const destination = `${file}.${index}`;
    try {
      fs.rmSync(destination, { force: true });
      fs.renameSync(source, destination);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
  }
  return true;
}

export function appendRotatedLogFile(file, chunk, options = {}) {
  const maxBytes = options.maxBytes ?? 10 * 1024 * 1024;
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const chunkBytes = Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(String(chunk));
  if (size && size + chunkBytes > maxBytes) {
    rotateLogFile(file, { ...options, maxBytes: Math.min(maxBytes, size) });
  }
  fs.appendFileSync(file, chunk);
}
