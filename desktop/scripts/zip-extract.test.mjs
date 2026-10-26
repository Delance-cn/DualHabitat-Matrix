import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { extractZip, findFileDown } from '../zip-extract.mjs';

/** 手写一个最小 zip（store + deflate + 目录条目），给解压器当输入。 */
function buildZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const data = e.data ?? Buffer.alloc(0);
    const crc = e.badCrc ? 0xdeadbeef : zlib.crc32(data);
    const raw = e.method === 8 ? zlib.deflateRawSync(data) : data;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(e.method ?? 0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(raw.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, raw);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(e.flag ?? 0, 8);
    cen.writeUInt16LE(e.method ?? 0, 10);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(raw.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(e.name.endsWith('/') ? 0x10 : 0x20, 38); // 目录位只给真目录（和真实 zip 一致）
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += 30 + nameBuf.length + raw.length;
  }
  const cdSize = central.reduce((s, b) => s + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, ...central, eocd]);
}

function tmpDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `zip-extract-${label}-`));
}

test('普通 zip：目录、中文名、store、deflate、空文件、大文件都能解出来', async () => {
  const dir = tmpDir('ok');
  const big = Buffer.alloc(3 * 1024 * 1024);
  for (let i = 0; i < big.length; i += 4096) big[i] = i & 0xff;
  const zip = path.join(dir, 'in.zip');
  fs.writeFileSync(zip, buildZip([
    { name: 'abc/' },
    { name: 'abc/中文 名字.txt', method: 8, data: Buffer.from('你好，世界！', 'utf8') },
    { name: 'stored.txt', data: Buffer.from('stored entry', 'utf8') },
    { name: 'empty.txt' },
    { name: 'deep/nest/big.bin', method: 8, data: big }
  ]));
  const out = path.join(dir, 'out');
  const r = await extractZip(zip, out);
  assert.equal(r.ok, true);
  assert.equal(r.files, 4);
  assert.equal(fs.readFileSync(path.join(out, 'abc', '中文 名字.txt'), 'utf8'), '你好，世界！');
  assert.equal(fs.readFileSync(path.join(out, 'stored.txt'), 'utf8'), 'stored entry');
  assert.ok(fs.existsSync(path.join(out, 'empty.txt')));
  assert.ok(fs.readFileSync(path.join(out, 'deep', 'nest', 'big.bin')).equals(big));
});

test('截断的 zip（下载中断）给出能看懂的报错', async () => {
  const dir = tmpDir('cut');
  const buf = buildZip([{ name: 'a.txt', data: Buffer.from('x'.repeat(1000)) }]);
  const zip = path.join(dir, 'cut.zip');
  fs.writeFileSync(zip, buf.subarray(0, buf.length - 12));
  const r = await extractZip(zip, path.join(dir, 'out'));
  assert.equal(r.ok, false);
  assert.match(r.error, /不完整|重新下载|重新传/);
});

test('CRC 不匹配报「包坏了」', async () => {
  const dir = tmpDir('crc');
  const zip = path.join(dir, 'bad.zip');
  fs.writeFileSync(zip, buildZip([{ name: 'a.txt', method: 8, data: Buffer.from('hello world'.repeat(100), 'utf8'), badCrc: true }]));
  const r = await extractZip(zip, path.join(dir, 'out'));
  assert.equal(r.ok, false);
  assert.match(r.error, /CRC32/);
});

test('zip64 明确报不支持', async () => {
  const dir = tmpDir('z64');
  const buf = buildZip([{ name: 'a.txt', data: Buffer.from('x') }]);
  buf.writeUInt16LE(0xffff, buf.length - 22 + 10); // EOCD 的条目数字段
  const zip = path.join(dir, 'z64.zip');
  fs.writeFileSync(zip, buf);
  const r = await extractZip(zip, path.join(dir, 'out'));
  assert.equal(r.ok, false);
  assert.match(r.error, /zip64/);
});

test('zip-slip：包里的路径不许跑出目标目录', async () => {
  const dir = tmpDir('slip');
  const zip = path.join(dir, 'evil.zip');
  fs.writeFileSync(zip, buildZip([{ name: '../evil.txt', data: Buffer.from('x') }]));
  const out = path.join(dir, 'out');
  const r = await extractZip(zip, out);
  assert.equal(r.ok, false);
  assert.match(r.error, /越界/);
  assert.ok(!fs.existsSync(path.join(dir, 'evil.txt')));
});

test('不支持的压缩方式、加密包都讲清楚原因', async () => {
  const dir = tmpDir('misc');
  const m12 = path.join(dir, 'm12.zip');
  fs.writeFileSync(m12, buildZip([{ name: 'a.bin', method: 12, data: Buffer.from('x') }]));
  const r1 = await extractZip(m12, path.join(dir, 'out1'));
  assert.equal(r1.ok, false);
  assert.match(r1.error, /压缩方式/);

  const enc = path.join(dir, 'enc.zip');
  fs.writeFileSync(enc, buildZip([{ name: 'a.txt', flag: 1, data: Buffer.from('x') }]));
  const r2 = await extractZip(enc, path.join(dir, 'out2'));
  assert.equal(r2.ok, false);
  assert.match(r2.error, /加密/);
});

test('findFileDown：限深搜索、找不到返回空串', () => {
  const dir = tmpDir('find');
  fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
  const target = path.join(dir, 'a', 'b', 'target.exe');
  fs.writeFileSync(target, 'x');
  assert.equal(findFileDown(dir, 'target.exe'), target);
  assert.equal(findFileDown(dir, 'nope.exe'), '');
  assert.equal(findFileDown(dir, 'target.exe', 1), ''); // 深度限制生效
});
