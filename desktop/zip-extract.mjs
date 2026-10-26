/**
 * zip-extract.mjs —— 纯 JS 的 zip 解压器（只依赖 Node 自带模块）。
 *
 * 为什么要有它：组件安装（NapCat / ffmpeg）原来靠 Windows 自带的 tar.exe 解 zip。
 * 开发机上有 tar 不代表用户机器上也有——精简版/LTSC/被安全软件动过的系统都可能
 * 没有，界面只会甩一句「本机 tar 不可用？」，用户什么也做不了（0.6.1 实测踩到）。
 * 纯 JS 解压跟着 Node 走：有 Node 就能解，还能把「包不完整」「CRC 不对」
 * 「路径越界」这些真实原因讲清楚，而不是让用户猜。
 *
 * 覆盖场景：NapCat.Shell.*.zip、ffmpeg 的 win64 zip——都是普通 zip
 * （stored / deflate、单一 central directory）。zip64、加密包明确报不支持，
 * 由调用方的 tar 兜底接手。
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/** CRC32 查表。zip 的 central directory 给每个条目都记了 CRC32，解完校验用。 */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

const u16 = (buf, off) => buf.readUInt16LE(off);
const u32 = (buf, off) => buf.readUInt32LE(off);

/**
 * 从 dir 往下按名字精确找文件（限层数），找不到返回 ''。
 *
 * 为什么要有：zip 根部不一定正好一层目录——有的打包方式会多套一层、
 * 或夹带杂项文件，只看根目录会把好好的 Shell 包误判成「不是 Shell 包」。
 */
export function findFileDown(dir, name, maxDepth = 5) {
  const stack = [[dir, 0]];
  while (stack.length) {
    const [d, depth] = stack.pop();
    if (depth > maxDepth) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) stack.push([full, depth + 1]);
      else if (e.name === name) return full;
    }
  }
  return '';
}

/**
 * 解 zip 到 dest。
 *
 * async 只是为了每批文件让出一次事件循环——118 MB 的包解压要几秒，
 * 一路同步会把界面和日志轮询全卡住。
 *
 * @returns {{ok:true, files:number}|{ok:false, error:string}}
 */
export async function extractZip(zipPath, dest, { onProgress } = {}) {
  let buf;
  try {
    buf = fs.readFileSync(zipPath);
  } catch (error) {
    return { ok: false, error: `读不到压缩包 ${zipPath}（${error?.code ?? error?.message ?? error}）` };
  }

  // End Of Central Directory：从尾部往回找签名（允许最多 64KB 的 zip 注释）。
  let eocd = -1;
  const floor = Math.max(0, buf.length - 66_000);
  for (let i = buf.length - 22; i >= floor; i -= 1) {
    if (u32(buf, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    return {
      ok: false,
      error: '这不是完整的 zip（找不到末尾的目录索引）——大概率下载或传输中断，重新下载/重新传一次就好'
    };
  }
  const entryCount = u16(buf, eocd + 10);
  const cdSize = u32(buf, eocd + 12);
  const cdOffset = u32(buf, eocd + 16);
  // zip64 的 EOCD locator 紧贴在 EOCD 前面（20 字节），字段全 0xFFFFFFFF
  if ((eocd >= 20 && u32(buf, eocd - 20) === 0x07064b50) ||
      entryCount === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    return { ok: false, error: '这是 zip64 格式的超大压缩包，当前不支持' };
  }

  // 走一遍 central directory：条目是变长的（46 字节头 + 名字 + 扩展字段 + 注释）。
  const entries = [];
  let p = cdOffset;
  const cdEnd = Math.min(buf.length, cdOffset + cdSize);
  while (p + 46 <= cdEnd && u32(buf, p) === 0x02014b50) {
    const flag = u16(buf, p + 8);
    const method = u16(buf, p + 10);
    const crc = u32(buf, p + 16);
    const compSize = u32(buf, p + 20);
    const uncompSize = u32(buf, p + 24);
    const nameLen = u16(buf, p + 28);
    const extraLen = u16(buf, p + 30);
    const commentLen = u16(buf, p + 32);
    const attrs = u32(buf, p + 38);
    const localOffset = u32(buf, p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.push({ name, flag, method, crc, compSize, uncompSize, attrs, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (entries.length !== entryCount) {
    return { ok: false, error: '压缩包的目录索引读不全（可能损坏）——重新下载/重新传一次' };
  }

  fs.mkdirSync(dest, { recursive: true });
  const destAbs = path.resolve(dest);
  let done = 0;

  for (const entry of entries) {
    const name = entry.name.replace(/\\/g, '/');
    const segments = name.split('/').filter((s) => s.length && s !== '.');
    const isDir =
      name.endsWith('/') ||
      (entry.compSize === 0 && entry.uncompSize === 0 && (entry.attrs & 0x10) !== 0 && !path.extname(name));

    // zip-slip：包里的路径不许跑出 dest。用户从别处拿来的 zip 也得防。
    if (segments.some((s) => s === '..') || /^[a-zA-Z]:/.test(segments[0] ?? '')) {
      return { ok: false, error: `压缩包里有越界路径（${entry.name}），为安全起见拒绝解压` };
    }
    if (entry.flag & 0x1) {
      return { ok: false, error: '这是加密的压缩包，当前不支持，换个没有密码的包' };
    }

    if (isDir) {
      if (segments.length) fs.mkdirSync(path.join(destAbs, ...segments), { recursive: true });
      continue;
    }

    // 数据区从本地头后面开始；本地头自己的名字/扩展长度可能和 central 不一样，按它算
    const lh = entry.localOffset;
    if (lh + 30 > buf.length || u32(buf, lh) !== 0x04034b50) {
      return { ok: false, error: `压缩包损坏（条目 ${entry.name} 的数据头读不到）——重新下载/重新传一次` };
    }
    const dataStart = lh + 30 + u16(buf, lh + 26) + u16(buf, lh + 28);
    const raw = buf.subarray(dataStart, dataStart + entry.compSize);

    let data;
    if (entry.method === 0) data = raw;
    else if (entry.method === 8) {
      try {
        data = zlib.inflateRawSync(raw);
      } catch {
        return { ok: false, error: `解压到条目 ${entry.name} 失败（数据流坏了）——压缩包不完整，重新下载/重新传一次` };
      }
    } else {
      return { ok: false, error: `条目 ${entry.name} 用了不支持的压缩方式（method ${entry.method}）` };
    }

    if (entry.crc !== 0 && crc32(data) !== entry.crc) {
      return { ok: false, error: `条目 ${entry.name} 校验不过（CRC32 不匹配）——压缩包坏了，重新下载/重新传一次` };
    }

    const target = path.join(destAbs, ...segments);
    if (segments.length > 1) fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);

    done += 1;
    if (done % 32 === 0) {
      onProgress?.(done / entries.length);
      // 让出事件循环：界面轮询、日志 SSE 都靠这个活
      await new Promise((r) => setImmediate(r));
    }
  }

  onProgress?.(1);
  return { ok: true, files: done };
}
