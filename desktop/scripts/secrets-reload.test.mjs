import test from 'node:test';
import assert from 'node:assert/strict';
import { reloadSecretsInRunningServer, saveSecretsAndApply } from '../secrets-reload.mjs';

test('saving secrets requests a model service reload without restarting the bridge', async () => {
  let persisted = { PROVIDER_API_KEY: 'old-key' };
  let stopCalled = false;
  const response = await saveSecretsAndApply({
    updates: { PROVIDER_API_KEY: 'rotated-key' },
    readSecrets: async () => persisted,
    writeSecrets: async (value) => { persisted = value; },
    reload: () => reloadSecretsInRunningServer({
      serverStatus: async () => ({ running: true }),
      stopServer: async () => {
        stopCalled = true;
        return { server: true, shim: false };
      }
    })
  });

  assert.deepEqual(persisted, { PROVIDER_API_KEY: 'rotated-key' });
  assert.equal(response.ok, true);
  assert.equal(response.applied, false);
  assert.equal(response.pending, true);
  assert.equal(response.reloadRequested, true);
  assert.equal(stopCalled, true);
  assert.ok(!JSON.stringify(response).includes('rotated-key'));
});

test('saved secrets remain pending when no model service is running', async () => {
  let stopCalled = false;
  const result = await reloadSecretsInRunningServer({
    serverStatus: async () => ({ running: false }),
    stopServer: async () => { stopCalled = true; return { server: true }; }
  });

  assert.deepEqual(result, { applied: false, pending: true });
  assert.equal(stopCalled, false);
});

test('failed service stop is surfaced if the service remains up', async () => {
  await assert.rejects(
    reloadSecretsInRunningServer({
      serverStatus: async () => ({ running: true }),
      stopServer: async () => ({ server: false })
    }),
    /模型 API 服务仍在运行/
  );
});

test('reload errors are explicit without exposing secret values', async () => {
  const result = await saveSecretsAndApply({
    updates: { PROVIDER_API_KEY: 'do-not-return-this' },
    readSecrets: async () => ({}),
    writeSecrets: async () => {},
    reload: async () => { throw new Error('service failed'); }
  });

  assert.equal(result.ok, true);
  assert.equal(result.applied, false);
  assert.equal(result.pending, false);
  assert.match(result.reloadError, /模型 API 重载失败/);
  assert.ok(!JSON.stringify(result).includes('do-not-return-this'));
});
