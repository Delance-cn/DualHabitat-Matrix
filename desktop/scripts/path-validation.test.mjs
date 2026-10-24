import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { validateDirectoryPath } from '../path-validation.mjs';

test('validates configured directories and reports missing paths', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dhm-path-check-'));
  try {
    assert.equal(validateDirectoryPath(dir, '目录'), null);
    assert.match(validateDirectoryPath(path.join(dir, 'missing'), '目录'), /不是有效文件夹/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rejects files and creates a requested state directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dhm-path-create-'));
  try {
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, '{}');
    assert.match(validateDirectoryPath(file, '目录'), /不是有效文件夹/);
    const stateDir = path.join(dir, 'nested', 'state');
    assert.equal(validateDirectoryPath(stateDir, '目录', { create: true }), null);
    assert.equal(fs.statSync(stateDir).isDirectory(), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
