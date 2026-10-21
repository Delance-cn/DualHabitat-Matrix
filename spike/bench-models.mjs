// 模型延迟对比：同样的 QQ 聊天场景 prompt，量首字延迟和整段耗时。
// 用法：node spike/bench-models.mjs [model1 model2 ...]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const secrets = JSON.parse(fs.readFileSync(path.join(ROOT, 'secrets.json'), 'utf8'));
const KEY = secrets.BAILIAN_API_KEY;
const BASE = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';

const models = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['qwen-flash', 'qwen3.8-max'];

// 贴近真实的群聊上下文：一屏聊天记录 + 人设指令
const context = `你在 QQ 群里，是个普通群友，别暴露自己是 AI。
群名：随便聊聊
最近聊天记录：
[小明] 今天好热啊，三十五度
[阿杰] 我在外面跑了一下午，衣服湿透了
[小明] 你咋不打个车
[阿杰] 打车十五块，我一个月工资多少你算算
[小雨] 哈哈哈哈阿杰这个抠
[阿杰] 不是抠，是穷
[小明] 穷和抠还是有区别的
[小雨] 区别是啥
[小明] 穷是没钱，抠是有钱不给
[阿杰] 那你属于哪种
[小明] 我属于又穷又抠
[小雨] 破防了
[阿杰] 笑死
现在有人 @ 你：你怎么看？`;

async function once(model) {
  const body = {
    model,
    messages: [
      { role: 'system', content: '你在群里聊天，说人话，短句，别用书面语，一次回一到两句。' },
      { role: 'user', content: context }
    ],
    stream: true,
    stream_options: { include_usage: true },
    ...(process.env.EXTRA_JSON ? JSON.parse(process.env.EXTRA_JSON) : {})
  };
  const t0 = Date.now();
  let ttft = null;
  let text = '';
  let usage = null;
  const res = await fetch(BASE, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const t = await res.text();
    return { model, error: `${res.status} ${t.slice(0, 160)}` };
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const s = line.trim();
      if (!s.startsWith('data:')) continue;
      const payload = s.slice(5).trim();
      if (payload === '[DONE]') continue;
      let j;
      try { j = JSON.parse(payload); } catch { continue; }
      const d = j.choices?.[0]?.delta?.content;
      if (d) {
        if (ttft === null) ttft = Date.now() - t0;
        text += d;
      }
      if (j.usage) usage = j.usage;
    }
  }
  return {
    model,
    ttftMs: ttft,
    totalMs: Date.now() - t0,
    outChars: text.length,
    completionTokens: usage?.completion_tokens ?? null,
    preview: text.replace(/\s+/g, ' ').slice(0, 60)
  };
}

for (const m of models) {
  try {
    const r = await once(m);
    if (r.error) console.log(`${m.padEnd(16)} 失败: ${r.error}`);
    else
      console.log(
        `${m.padEnd(16)} 首字 ${String(r.ttftMs).padStart(5)}ms  全文 ${String(r.totalMs).padStart(5)}ms  输出 ${r.completionTokens ?? '?'} tok  「${r.preview}」`
      );
  } catch (e) {
    console.log(`${m.padEnd(16)} 异常: ${e.message}`);
  }
}
