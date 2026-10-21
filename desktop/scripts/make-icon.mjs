// 生成应用图标：build/icon.ico（安装包和 exe 用）+ public/icon.png（窗口用）。
//
// 不依赖 canvas / sharp —— 这两个在 Windows 上装起来都是几十兆的原生模块，
// 为了画两个圆角方块不值当。这里直接用 SDF 求覆盖率，抗锯齿是算出来的，
// 不是靠超采样堆出来的，16px 下也干净。
//
// 图形和 public/tray.png 是同一套：两个交叠的圆角方块（蓝 + 紫），
// 「两个栖息地叠在一起」就是 DualHabitat。

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

// ---------- 画 ----------

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** 圆角矩形有向距离场，单位是像素。内部为负。 */
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}

/** 距离 → 覆盖率。1 像素宽的过渡带就是抗锯齿。 */
const coverage = (d) => clamp01(0.5 - d);

function over(dst, src, a) {
  // src over dst，a 是覆盖率
  const sa = a;
  const da = dst[3];
  const oa = sa + da * (1 - sa);
  if (oa <= 0) return [0, 0, 0, 0];
  return [
    (src[0] * sa + dst[0] * da * (1 - sa)) / oa,
    (src[1] * sa + dst[1] * da * (1 - sa)) / oa,
    (src[2] * sa + dst[2] * da * (1 - sa)) / oa,
    oa
  ];
}

const C_BG_TOP = [30, 36, 56];
const C_BG_BOTTOM = [13, 16, 28];
const C_BLUE = [74, 158, 255];
const C_PURPLE = [124, 92, 255];

/**
 * 按 1024 的逻辑坐标画一张 size×size 的 RGBA 图。
 * 所有几何量乘 size/1024，这样任意尺寸都是同一张图缩出来的。
 */
function render(size) {
  const k = size / 1024;
  const px = new Uint8ClampedArray(size * size * 4);

  // 背景板：留 3% 边距，圆角 20%
  const pad = 40 * k;
  const bgHw = size / 2 - pad;
  const bgR = 200 * k;

  // 方块 A（蓝，左上）
  const aHw = 200 * k;
  const aCx = 400 * k;
  const aCy = 440 * k;
  const aR = 118 * k;

  // 方块 B（紫，右下）
  const bHw = 200 * k;
  const bCx = 624 * k;
  const bCy = 592 * k;
  const bR = 118 * k;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cx = x + 0.5;
      const cy = y + 0.5;

      let c = [0, 0, 0, 0];

      // 背景（竖向渐变）
      const bgA = coverage(sdRoundRect(cx, cy, size / 2, size / 2, bgHw, bgHw, bgR));
      if (bgA > 0) {
        const t = clamp01((cy - pad) / (size - pad * 2));
        const bg = [
          C_BG_TOP[0] + (C_BG_BOTTOM[0] - C_BG_TOP[0]) * t,
          C_BG_TOP[1] + (C_BG_BOTTOM[1] - C_BG_TOP[1]) * t,
          C_BG_TOP[2] + (C_BG_BOTTOM[2] - C_BG_TOP[2]) * t
        ];
        c = over(c, bg, bgA);
      }

      // 蓝方块
      const aA = coverage(sdRoundRect(cx, cy, aCx, aCy, aHw, aHw, aR));
      if (aA > 0) c = over(c, C_BLUE, aA);

      // 紫方块（半透明叠上去，交叠处自然混色）
      const bA = coverage(sdRoundRect(cx, cy, bCx, bCy, bHw, bHw, bR)) * 0.9;
      if (bA > 0) c = over(c, C_PURPLE, bA);

      const i = (y * size + x) * 4;
      px[i] = Math.round(c[0]);
      px[i + 1] = Math.round(c[1]);
      px[i + 2] = Math.round(c[2]);
      px[i + 3] = Math.round(c[3] * 255);
    }
  }
  return px;
}

// ---------- PNG ----------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // 每行前面加一个 filter 字节（0 = none）
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ---------- ICO ----------

/**
 * ICO 里每个尺寸都塞 PNG（Vista 起支持）。
 * 比 BMP 省事：不用管 32bpp 的行序和 AND 掩码。
 */
function ico(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type = icon
  header.writeUInt16LE(entries.length, 4);

  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + dir.length;
  entries.forEach((e, i) => {
    const o = i * 16;
    dir[o] = e.size >= 256 ? 0 : e.size;
    dir[o + 1] = e.size >= 256 ? 0 : e.size;
    dir[o + 2] = 0;
    dir[o + 3] = 0;
    dir.writeUInt16LE(1, o + 4); // planes
    dir.writeUInt16LE(32, o + 6); // bpp
    dir.writeUInt32LE(e.data.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += e.data.length;
  });

  return Buffer.concat([header, dir, ...entries.map((e) => e.data)]);
}

// ---------- 出 ----------

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const entries = [];
for (const s of SIZES) {
  entries.push({ size: s, data: png(s, render(s)) });
}

const buildDir = path.join(root, 'build');
fs.mkdirSync(buildDir, { recursive: true });
fs.writeFileSync(path.join(buildDir, 'icon.ico'), ico(entries));
console.log('build/icon.ico  ' + SIZES.join('/') + '  ' + fs.statSync(path.join(buildDir, 'icon.ico')).size + ' B');

// 窗口图标（BrowserWindow.icon 只认 png/ico 路径，用 256 的 png 最稳）
const png256 = entries.find((e) => e.size === 256).data;
fs.writeFileSync(path.join(root, 'public', 'icon.png'), png256);
console.log('public/icon.png  256×256  ' + png256.length + ' B');

// 托盘图标：同一个图形，32px。托盘只认小图，256 的塞进去会被系统缩得发糊。
const png32 = entries.find((e) => e.size === 32).data;
fs.writeFileSync(path.join(root, 'public', 'tray.png'), png32);
console.log('public/tray.png  32×32  ' + png32.length + ' B');
