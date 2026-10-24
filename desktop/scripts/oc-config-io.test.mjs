import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJsonSafe, writeJsonAtomically } from '../../src/oc-config.js';

test('missing optional JSON uses the fallback but malformed JSON is reported', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dhm-config-'));
  const file = path.join(dir, 'config.json');
  try {
    assert.deepEqual(readJsonSafe(file, { defaulted: true }), { defaulted: true });
    fs.writeFileSync(file, '{"provider":', 'utf8');
    assert.throws(() => readJsonSafe(file, {}), /JSON 文件无法解析/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('generated JSON atomically replaces the existing file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dhm-config-'));
  const file = path.join(dir, 'opencode.json');
  try {
    fs.writeFileSync(file, '{"old":true}\n', 'utf8');
    writeJsonAtomically(file, '{"new":true}\n');
    assert.equal(fs.readFileSync(file, 'utf8'), '{"new":true}\n');
    assert.deepEqual(fs.readdirSync(dir), ['opencode.json']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
