/**
 * backends/protocols.js —— 三种主流模型协议的流式客户端。
 *
 * 统一出口：`streamChat(profile, { messages, signal })` 是一个 async generator，
 * 逐项产出 `{ delta }` 或 `{ usage }`。
 *
 * 内部消息格式（和 OpenAI 的 messages 同构，但 content 永远是字符串 + 独立的图片数组）：
 *   { role: 'system' | 'user' | 'assistant', text: string, images?: [{ mediaType, data }] }
 *
 * 为什么不直接套 SDK：群聊场景要的是"几百毫秒出首字"和"零依赖"，
 * 一个协议一个 fetch 就够，装三个 SDK 反而拖慢启动、还多三份版本冲突风险。
 */

/* ══════════════════════════════════════════════════════════════════════════
 * 公共：SSE 行读取
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * 把 fetch 的响应体切成一行行 `data:` 负载。
 * 三种协议都是 SSE，差别只在 data 里的 JSON 结构，所以读流这段可以共用。
 */
async function* sseLines(response, signal) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      if (signal?.aborted) throw new Error('interrupted: 已取消');
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE 以空行分隔事件，但有些服务端只发 \n，所以按行切更稳
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        yield payload;
      }
    }
    const tail = buffer.trim();
    if (tail.startsWith('data:')) {
      const payload = tail.slice(5).trim();
      if (payload && payload !== '[DONE]') yield payload;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* 已经结束的流，取消失败无妨 */
    }
  }
}

/** 统一的 HTTP 失败处理：把服务端的错误正文带出来，别只说 "fetch failed"。 */
async function assertOk(response, label) {
  if (response.ok) return;
  let detail = '';
  try {
    detail = (await response.text()).slice(0, 500);
  } catch {
    /* 读不到正文就算了 */
  }
  throw new Error(`${label} HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
}

/* ══════════════════════════════════════════════════════════════════════════
 * 一、OpenAI 兼容（DeepSeek / 通义百炼 / Kimi / 智谱 / MiniMax / OpenRouter / 硅基流动…）
 * ══════════════════════════════════════════════════════════════════════════ */

function toOpenAIMessages(messages) {
  return messages.map((m) => {
    // 工具回执：OpenAI 协议要求 role:'tool' + tool_call_id，且**不能**带 tool_calls
    if (m.role === 'tool') {
      return { role: 'tool', tool_call_id: m.toolCallId, content: m.text ?? '' };
    }

    // assistant 的工具调用帧：content 可以是空，但 tool_calls 必须原样带回去，
    // 否则下一轮服务端会报 "tool_calls must be followed by tool messages"
    if (m.toolCalls?.length) {
      const frame = {
        role: 'assistant',
        content: m.text ?? '',
        tool_calls: m.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) }
        }))
      };
      return frame;
    }

    if (!m.images?.length) return { role: m.role, content: m.text ?? '' };
    const parts = [];
    if (m.text) parts.push({ type: 'text', text: m.text });
    for (const img of m.images) {
      parts.push({
        type: 'image_url',
        image_url: { url: `data:${img.mediaType};base64,${img.data}` }
      });
    }
    return { role: m.role, content: parts };
  });
}

export async function* streamOpenAI(profile, { messages, signal, tools }) {
  const url = `${profile.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const body = {
    model: profile.model,
    messages: toOpenAIMessages(messages),
    stream: true,
    // 有些兼容端点不认 stream_options，失败了会在下面重试时去掉
    stream_options: { include_usage: true }
  };
  if (profile.temperature != null) body.temperature = profile.temperature;
  if (profile.maxTokens != null) body.max_tokens = profile.maxTokens;
  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${profile.apiKey}`
  };

  let response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  if (response.status === 400 || response.status === 422) {
    // 兼容端点常见的两种不认账：不认 stream_options；不认 tools（没实现 function calling）。
    // 都能退：去掉重发，别让整个后端因为这个直接挂掉。
    const text = await response.text().catch(() => '');
    let retried = false;
    if (/stream_options/i.test(text)) {
      delete body.stream_options;
      retried = true;
    }
    if (body.tools && /tool/i.test(text)) {
      delete body.tools;
      delete body.tool_choice;
      retried = true;
    }
    if (retried) {
      response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
    } else {
      throw new Error(`openai HTTP ${response.status}: ${text.slice(0, 500)}`);
    }
  }
  await assertOk(response, 'openai');

  let usage = null;
  for await (const payload of sseLines(response, signal)) {
    let json;
    try {
      json = JSON.parse(payload);
    } catch {
      continue; // 心跳或非 JSON 行
    }
    const choice = json?.choices?.[0];
    const delta = choice?.delta?.content;
    if (typeof delta === 'string' && delta) yield { delta };
    // 工具调用是分片下发的：第一片带 id/name，后面只带 arguments 的碎片
    if (Array.isArray(choice?.delta?.tool_calls) && choice.delta.tool_calls.length) {
      yield { toolCallDelta: choice.delta.tool_calls };
    }
    if (json?.usage) {
      usage = {
        inputTokens: json.usage.prompt_tokens ?? 0,
        outputTokens: json.usage.completion_tokens ?? 0,
        reasoningTokens: json.usage.completion_tokens_details?.reasoning_tokens ?? 0,
        cacheReadTokens: json.usage.prompt_tokens_details?.cached_tokens ?? 0,
        cacheWriteTokens: 0
      };
    }
  }
  if (usage) yield { usage };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 二、Anthropic 原生
 * ══════════════════════════════════════════════════════════════════════════ */

function toAnthropicMessages(messages) {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.text)
    .join('\n\n');
  const rest = messages
    .filter((m) => m.role !== 'system')
    .map((m) => {
      if (!m.images?.length) return { role: m.role, content: m.text ?? '' };
      const parts = [];
      for (const img of m.images) {
        parts.push({
          type: 'image',
          source: { type: 'base64', media_type: img.mediaType, data: img.data }
        });
      }
      if (m.text) parts.push({ type: 'text', text: m.text });
      return { role: m.role, content: parts };
    });
  return { system: system || undefined, messages: rest };
}

export async function* streamAnthropic(profile, { messages, signal }) {
  const base = profile.baseUrl.replace(/\/+$/, '');
  const url = `${base}/messages`;
  const { system, messages: msgs } = toAnthropicMessages(messages);
  const body = {
    model: profile.model,
    max_tokens: profile.maxTokens ?? 2048,
    messages: msgs,
    stream: true
  };
  if (system) body.system = system;
  if (profile.temperature != null) body.temperature = profile.temperature;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': profile.apiKey,
      'anthropic-version': profile.anthropicVersion ?? '2023-06-01'
    },
    body: JSON.stringify(body),
    signal
  });
  await assertOk(response, 'anthropic');

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheRead = 0;
  let cacheWrite = 0;

  for await (const payload of sseLines(response, signal)) {
    let json;
    try {
      json = JSON.parse(payload);
    } catch {
      continue;
    }
    if (json.type === 'content_block_delta' && json.delta?.type === 'text_delta') {
      if (json.delta.text) yield { delta: json.delta.text };
    } else if (json.type === 'message_start' && json.message?.usage) {
      inputTokens = json.message.usage.input_tokens ?? 0;
      cacheRead = json.message.usage.cache_read_input_tokens ?? 0;
      cacheWrite = json.message.usage.cache_creation_input_tokens ?? 0;
    } else if (json.type === 'message_delta' && json.usage) {
      outputTokens = json.usage.output_tokens ?? outputTokens;
    }
  }
  yield {
    usage: {
      inputTokens,
      outputTokens,
      reasoningTokens: 0,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite
    }
  };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 三、Gemini 原生
 * ══════════════════════════════════════════════════════════════════════════ */

function toGeminiContents(messages) {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.text)
    .join('\n\n');
  const contents = messages
    .filter((m) => m.role !== 'system')
    .map((m) => {
      const parts = [];
      if (m.text) parts.push({ text: m.text });
      for (const img of m.images ?? []) {
        parts.push({ inline_data: { mime_type: img.mediaType, data: img.data } });
      }
      // Gemini 的 assistant 角色叫 model
      return { role: m.role === 'assistant' ? 'model' : 'user', parts };
    });
  return { systemInstruction: system ? { parts: [{ text: system }] } : undefined, contents };
}

export async function* streamGemini(profile, { messages, signal }) {
  const base = profile.baseUrl.replace(/\/+$/, '');
  const { systemInstruction, contents } = toGeminiContents(messages);
  const url = `${base}/models/${encodeURIComponent(profile.model)}:streamGenerateContent?alt=sse`;
  const body = { contents };
  if (systemInstruction) body.systemInstruction = systemInstruction;
  if (profile.temperature != null) body.generationConfig = { temperature: profile.temperature };
  if (profile.maxTokens != null) {
    body.generationConfig = { ...(body.generationConfig ?? {}), maxOutputTokens: profile.maxTokens };
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': profile.apiKey
    },
    body: JSON.stringify(body),
    signal
  });
  await assertOk(response, 'gemini');

  let lastUsage = null;
  for await (const payload of sseLines(response, signal)) {
    let json;
    try {
      json = JSON.parse(payload);
    } catch {
      continue;
    }
    for (const part of json?.candidates?.[0]?.content?.parts ?? []) {
      if (typeof part.text === 'string' && part.text) yield { delta: part.text };
    }
    if (json?.usageMetadata) {
      const u = json.usageMetadata;
      lastUsage = {
        inputTokens: u.promptTokenCount ?? 0,
        outputTokens: u.candidatesTokenCount ?? 0,
        reasoningTokens: u.thoughtsTokenCount ?? 0,
        cacheReadTokens: u.cachedContentTokenCount ?? 0,
        cacheWriteTokens: 0
      };
    }
  }
  if (lastUsage) yield { usage: lastUsage };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 四、按协议分发
 * ══════════════════════════════════════════════════════════════════════════ */

const PROTOCOLS = {
  openai: streamOpenAI,
  anthropic: streamAnthropic,
  gemini: streamGemini
};

export const SUPPORTED_PROTOCOLS = Object.keys(PROTOCOLS);

/**
 * 按 profile.protocol 选协议。
 * @param {{ protocol: 'openai'|'anthropic'|'gemini' }} profile
 */
export function streamChat(profile, options) {
  const impl = PROTOCOLS[profile.protocol];
  if (!impl) {
    throw new Error(
      `不认识的协议 "${profile.protocol}"，可选：${SUPPORTED_PROTOCOLS.join(' / ')}`
    );
  }
  return impl(profile, options);
}
