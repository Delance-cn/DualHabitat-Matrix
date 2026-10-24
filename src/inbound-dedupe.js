const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 5000;

export function createInboundDeduper({
  ttlMs = DEFAULT_TTL_MS,
  maxEntries = DEFAULT_MAX_ENTRIES,
  now = Date.now
} = {}) {
  const seen = new Map();

  return (scope, messageId) => {
    if (messageId === undefined || messageId === null || messageId === '') return false;

    const timestamp = now();
    for (const [key, at] of seen) {
      if (timestamp - at <= ttlMs) break;
      seen.delete(key);
    }

    const key = JSON.stringify([String(scope), String(messageId)]);
    const previous = seen.get(key);
    if (previous !== undefined && timestamp - previous <= ttlMs) {
      seen.delete(key);
      seen.set(key, timestamp);
      return true;
    }

    seen.delete(key);
    seen.set(key, timestamp);
    while (seen.size > maxEntries) {
      const oldest = seen.keys().next().value;
      if (oldest === undefined) break;
      seen.delete(oldest);
    }
    return false;
  };
}
