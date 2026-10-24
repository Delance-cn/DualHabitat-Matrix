export async function reloadSecretsInRunningServer({ serverStatus, stopServer }) {
  const status = await serverStatus();
  if (!status.running) return { applied: false, pending: true };

  const stopped = await stopServer();
  if (!stopped.server && (await serverStatus()).running) {
    throw new Error('模型 API 服务仍在运行');
  }
  return { applied: false, pending: true, reloadRequested: stopped.server === true };
}

export async function saveSecretsAndApply({ updates, readSecrets, writeSecrets, reload }) {
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
    throw new Error('密钥更新必须是对象');
  }

  const secrets = { ...(await readSecrets()) };
  for (const [key, value] of Object.entries(updates)) {
    if (value === null || value === '') delete secrets[key];
    else secrets[key] = String(value);
  }
  await writeSecrets(secrets);

  try {
    const result = await reload();
    return {
      ok: true,
      applied: result?.applied === true,
      pending: result?.pending === true,
      reloadRequested: result?.reloadRequested === true
    };
  } catch {
    return {
      ok: true,
      applied: false,
      pending: false,
      reloadError: '密钥已保存，但运行中的模型 API 重载失败；当前实例可能仍在使用旧密钥'
    };
  }
}
