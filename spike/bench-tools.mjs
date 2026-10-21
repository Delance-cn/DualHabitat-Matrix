// 工具调用能力测试：这些 QQ 桥接的模型必须能可靠地发起 tool call，否则机器人不会回消息。
// 用法：node spike/bench-tools.mjs [model...]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const secrets = JSON.parse(fs.readFileSync(path.join(ROOT, 'secrets.json'), 'utf8'));
const KEY = secrets.BAILIAN_API_KEY;
const BASE = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';

const models = process.argv.slice(2).length ? process.argv.slice(2) : ['qwen-flash'];

const tools = [
  {
    type: 'function',
    function: {
      name: 'qq_get_unread_messages',
      description: '拉取某个会话的未读消息',
      parameters: {
        type: 'object',
        properties: { key: { type: 'string', description: '会话键，如 group:123' } },
        required: ['key']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'qq_send_message',
      description: '往会话里发一条消息',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          text: { type: 'string', description: '要发的文字' }
        },
        required: ['key', 'text']
      }
    }
  }
];

const messages = [
  { role: 'system', content: '你在 QQ 群里聊天。有人 @ 你，你要回一句。发消息必须调用 qq_send_message，不要只输出文字。' },
  { role: 'user', content: '群 group:1045557553 里 [阿杰] 说：你怎么看？ 请回复他。' }
];

for (const model of models) {
  const t0 = Date.now();
  try {
    const res = await fetch(BASE, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ model, messages, tools, stream: false })
    });
    const ms = Date.now() - t0;
    if (!res.ok) {
      console.log(`${model.padEnd(16)} 失败 ${res.status}: ${(await res.text()).slice(0, 120)}`);
      continue;
    }
    const j = await res.json();
    const msg = j.choices?.[0]?.message;
    const calls = msg?.tool_calls || [];
    const detail = calls.length
      ? calls.map((c) => `${c.function?.name}(${String(c.function?.arguments).slice(0, 60)})`).join(' ')
      : `无工具调用，纯文本：「${String(msg?.content ?? '').slice(0, 50)}」`;
    console.log(`${model.padEnd(16)} ${String(ms).padStart(5)}ms  ${detail}`);
  } catch (e) {
    console.log(`${model.padEnd(16)} 异常: ${e.message}`);
  }
}
