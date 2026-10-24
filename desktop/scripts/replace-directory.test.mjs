import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { replaceDirectoryAtomically } from './replace-directory.mjs';

test('publishes a staged directory and removes stale destination files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dhm-publish-'));
  const destination = path.join(root, 'dist');
  const staging = path.join(root, 'staging');
  try {
    fs.mkdirSync(destination);
    fs.writeFileSync(path.join(destination, 'stale.js'), 'old');
    fs.mkdirSync(staging);
    fs.writeFileSync(path.join(staging, 'fresh.js'), 'new');

    replaceDirectoryAtomically(staging, destination);

    assert.deepEqual(fs.readdirSync(destination), ['fresh.js']);
    assert.equal(fs.readFileSync(path.join(destination, 'fresh.js'), 'utf8'), 'new');
    assert.deepEqual(fs.readdirSync(root), ['dist']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
