import test from 'node:test';
import assert from 'node:assert/strict';
import { secretsFingerprint, secretsNeedReload } from '../../src/oc-server.js';

test('secret fingerprint is stable regardless of object key order', () => {
  assert.equal(
    secretsFingerprint({ ALPHA_API_KEY: 'first', BETA_API_KEY: 'second' }),
    secretsFingerprint({ BETA_API_KEY: 'second', ALPHA_API_KEY: 'first' })
  );
});

test('secret rotation and deletion require a service reload without storing raw values', () => {
  const oldKey = secretsFingerprint({ PROVIDER_API_KEY: 'old-secret' });
  const rotatedKey = secretsFingerprint({ PROVIDER_API_KEY: 'new-secret' });
  const deletedKey = secretsFingerprint({});

  assert.notEqual(oldKey, rotatedKey);
  assert.notEqual(rotatedKey, deletedKey);
  assert.equal(secretsNeedReload(oldKey, rotatedKey), true);
  assert.equal(secretsNeedReload(rotatedKey, deletedKey), true);
  assert.equal(secretsNeedReload(rotatedKey, rotatedKey), false);
  assert.ok(!oldKey.includes('old-secret'));
});

test('a missing launch fingerprint triggers one safe reload', () => {
  assert.equal(secretsNeedReload(null, secretsFingerprint({ PROVIDER_API_KEY: 'present' })), true);
});
