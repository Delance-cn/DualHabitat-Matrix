import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveConfiguredStateDirectory, resolveStateDirectory } from '../../src/oc-env.js';

test('uses the configured matrix state directory relative to the data root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dhm-oc-state-'));
  try {
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ matrix: { stateDir: 'custom/state' } }));
    assert.equal(resolveConfiguredStateDirectory(root), path.join(root, 'custom', 'state'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('environment state directory takes precedence over the config file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dhm-oc-state-env-'));
  try {
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ matrix: { stateDir: 'configured' } }));
    assert.equal(resolveConfiguredStateDirectory(root, 'override/state'), path.join(root, 'override', 'state'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('falls back to the established state directory when no custom path is set', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dhm-oc-state-default-'));
  try {
    assert.equal(resolveConfiguredStateDirectory(root), path.join(root, '.oc', 'state'));
    assert.equal(resolveStateDirectory(root, ''), path.join(root, '.oc', 'state'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
