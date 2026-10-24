import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendRotatedLogFile, rotateLogFile } from '../../src/log-rotate.js';

test('rotates oversized logs while retaining a bounded number of backups', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dhm-log-rotate-'));
  try {
    const file = path.join(dir, 'service.log');
    fs.writeFileSync(file, 'current');
    fs.writeFileSync(`${file}.1`, 'previous');
    fs.writeFileSync(`${file}.2`, 'older');

    assert.equal(rotateLogFile(file, { maxBytes: 4, backups: 2 }), true);
    assert.equal(fs.existsSync(file), false);
    assert.equal(fs.readFileSync(`${file}.1`, 'utf8'), 'current');
    assert.equal(fs.readFileSync(`${file}.2`, 'utf8'), 'previous');
    assert.equal(fs.existsSync(`${file}.3`), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ignores missing or under-limit logs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dhm-log-rotate-'));
  try {
    const file = path.join(dir, 'service.log');
    assert.equal(rotateLogFile(file), false);
    fs.writeFileSync(file, 'small');
    assert.equal(rotateLogFile(file, { maxBytes: 100 }), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('appends process output through bounded log rotation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dhm-log-append-'));
  try {
    const file = path.join(dir, 'server.out.log');
    fs.writeFileSync(file, '12345');
    appendRotatedLogFile(file, '6789', { maxBytes: 8, backups: 2 });
    assert.equal(fs.readFileSync(file, 'utf8'), '6789');
    assert.equal(fs.readFileSync(`${file}.1`, 'utf8'), '12345');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
