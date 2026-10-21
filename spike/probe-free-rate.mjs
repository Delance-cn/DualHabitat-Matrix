/**
 * 免费档到底是"限流"还是"身份"？
 *
 * 观察到的矛盾：同样一份配置、同一个服务、同一个模型，
 * 有时出话（cost 0），有时 403 FreeTierError —— 而且**连对照都跟着变**。
 * 这不符合"配置决定论"，更像**时间窗口限流**。
 *
 * 本脚本直接打 opencode.ai 的推理端点，间隔重试，只看状态码和响应头：
 *   - 若状态在 200/403 之间来回跳 → 限流（等一会儿就好）
 *   - 若一直 403 → 是身份判定（那前面那些成功就另有原因）
 *
 *   node spike/probe-free-rate.mjs [次数] [间隔毫秒]
 */

const TIMES = Number(process.argv[2] ?? 6);
const GAP = Number(process.argv[3] ?? 15000);
const URL = 'https://opencode.ai/inference/openai/v1/chat/completions';
const body = JSON.stringify({
  model: 'deepseek-v4.1-flash-free',
  messages: [{ role: 'user', content: '只回两个字：在的' }],
  max_tokens: 8,
  stream: false
});

for (let i = 1; i <= TIMES; i++) {
  const t0 = Date.now();
  try {
    const res = await fetch(URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer public',
        'x-opencode-client': 'desktop'
      },
      body
    });
    const text = await res.text();
    const retry = res.headers.get('retry-after');
    let summary = '';
    if (res.ok) {
      try {
        const j = JSON.parse(text);
        summary = `content=${JSON.stringify(j.choices?.[0]?.message?.content ?? '').slice(0, 40)}`;
      } catch {
        summary = text.slice(0, 80);
      }
    } else {
      summary = text.slice(0, 140).replace(/\s+/g, ' ');
    }
    console.log(
      `#${i} ${res.status} ${Date.now() - t0}ms${retry ? ` retry-after=${retry}` : ''} ${summary}`
    );
  } catch (error) {
    console.log(`#${i} ERR ${Date.now() - t0}ms ${error?.message ?? error}`);
  }
  if (i < TIMES) await new Promise((r) => setTimeout(r, GAP));
}
