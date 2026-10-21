// Only the model-facing view is compacted. Stored messages and console/API data
// retain the original fields for display, media retrieval and troubleshooting.
const DEFAULT_FALSE_FIELDS = new Set([
  'quoteTargetIsSelf', 'isOwner', 'isSelf', 'hasMedia', 'hasForward'
]);
const OPTIONAL_FIELDS = new Set([
  'seq', 'messageId', 'sender', 'userId', 'text', 'plain', 'tail', 'kind',
  'ownerLabel', 'media', 'forwardIds', 'nestedForwardIds'
]);

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isEmpty(value) {
  return value == null || value === '' || (Array.isArray(value) && value.length === 0);
}

function compactMedia(media, canResolveByMessage) {
  return media.map((item, index) => {
    if (!isRecord(item)) return item;
    const result = { ...item };
    // A local seq is a bridge message handle accepted by qq_get_message_images.
    // Forwarded nodes only have messageSeq, and may not be locally resolvable:
    // keep their transport references, even when they happen to have messageId.
    if (canResolveByMessage) {
      delete result.file;
      delete result.url;
      // Match the image tool's one-based ordering; never filter/reorder items.
      if (result.index == null) result.index = index + 1;
    } else if (result.file === result.url) {
      delete result.file;
    }
    for (const key of ['file', 'url', 'faceId']) {
      if (isEmpty(result[key])) delete result[key];
    }
    return result;
  });
}

export function compactModelMessage(message) {
  if (!isRecord(message)) return message;
  const result = { ...message };
  // No trimming or truncation: differing plain text can contain resolved quote
  // context, and tail can carry the end of a long message absent from text.
  const seenText = new Set();
  for (const key of ['text', 'plain', 'tail']) {
    if (typeof result[key] !== 'string') continue;
    if (seenText.has(result[key])) delete result[key];
    else seenText.add(result[key]);
  }
  for (const key of OPTIONAL_FIELDS) {
    if (isEmpty(result[key])) delete result[key];
  }
  for (const key of DEFAULT_FALSE_FIELDS) {
    if (result[key] === false) delete result[key];
  }
  if (Array.isArray(result.media)) {
    const canResolveByMessage = Number.isSafeInteger(message.seq) && message.seq > 0;
    result.media = compactMedia(result.media, canResolveByMessage);
  }
  return result;
}

export function compactModelData(data) {
  if (Array.isArray(data)) return data.map(compactModelData);
  if (!isRecord(data)) return data;
  return Object.fromEntries(Object.entries(data).map(([key, value]) => [
    key,
    (key === 'messages' || key === 'newMessages') && Array.isArray(value)
      ? value.map(compactModelMessage)
      : compactModelData(value)
  ]));
}

// 单次工具返回的字符上限。
// 为什么要钳：一条 QQ 会话每轮都会把整段历史重发给模型，工具返回是历史增量里最大的一块。
// 一次 qq_get_recent_messages 就能灌进上百条消息，之后每一轮都要为这些旧消息重复付费。
// 实测（2026-10-19）单条工具返回最长把上下文推到 80k token —— 一半以上是这类回灌。
const MAX_RESULT_CHARS = 12000;
const KEEP_RECENT_MESSAGES = 12;

// 超预算时：只保留最近 N 条消息，并在旁边标注省掉了多少条（不塞假消息进数组）。
function trimMessages(data) {
  if (Array.isArray(data)) return data.map(trimMessages);
  if (!isRecord(data)) return data;
  const out = {};
  for (const [key, value] of Object.entries(data)) {
    if ((key === 'messages' || key === 'newMessages') && Array.isArray(value) && value.length > KEEP_RECENT_MESSAGES) {
      out[key] = value.slice(-KEEP_RECENT_MESSAGES);
      out[`${key}OmittedCount`] = value.length - KEEP_RECENT_MESSAGES;
      out[`${key}OmittedNote`] = `更早的 ${value.length - KEEP_RECENT_MESSAGES} 条已省略，只保留最近 ${KEEP_RECENT_MESSAGES} 条`;
    } else {
      out[key] = trimMessages(value);
    }
  }
  return out;
}

export function serializeModelData(data) {
  const compacted = compactModelData(data);
  let text = JSON.stringify(compacted);
  if (text.length <= MAX_RESULT_CHARS) return text;
  text = JSON.stringify(trimMessages(compacted));
  if (text.length <= MAX_RESULT_CHARS) return text;
  // 裁完还超：硬截断并留标记，绝不让单条工具返回把上下文顶爆。
  return `${text.slice(0, MAX_RESULT_CHARS)}\n…（工具返回过长已截断：完整长度 ${text.length} 字符；需要更多内容请分页读取）`;
}
