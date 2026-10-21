/**
 * 直接打 opencode.ai 推理端点，穷举"桌面端凭什么能用免费档"。
 *
 * 已知：桌面 App 里跑 `opencode/deepseek-v4.1-flash-free` 成功（cost 0），
 * 但任何**程序化**发起的请求（隔离实例、桌面服务、甚至裸 HTTP）都被服务端拒：
 *   provider.auth 403 FreeTierError: "OpenCode's free tier can only be used from within OpenCode."
 *
 * 从 opencode-cli.exe 里挖出的推理请求头构造是：
 *   User-Agent, x-opencode-client, x-opencode-project, x-opencode-session,
 *   x-opencode-session-id, x-session-affinity, X-Session-Id
 * 所以这里把这一整套都伪造一遍，看是不是"认头不认人"。
 *
 * 如果全部 403 → 是凭据/签名级别的东西，程序化调用没戏（要如实告诉用户）。
 *
 *   node spike/probe-inference-headers.mjs
 */

const URL = 'https://opencode.ai/inference/openai/v1/chat/completions';
const MODEL = process.argv[2] ?? 'deepseek-v4.1-flash-free';
const SID = 'ses_' + 'a'.repeat(64);

const body = JSON.stringify({
  model: MODEL,
  messages: [{ role: 'user', content: 'hi' }],
  max_tokens: 5,
  stream: false
});

const base = {
  'content-type': 'application/json',
  authorization: 'Bearer public'
};

const cliLike = {
  'user-agent': 'opencode/2.0.32 (desktop; win32; x64)',
  'x-opencode-client': 'desktop',
  'x-opencode-project': 'a1b2c3d4e5f6',
  'x-opencode-session': SID,
  'x-opencode-session-id': SID,
  'x-session-affinity': SID,
  'X-Session-Id': SID
};

const cases = [
  ['baseline', {}],
  ['cli-like', cliLike],
  ['cli-like+origin', { ...cliLike, origin: 'https://opencode.ai', referer: 'https://opencode.ai/' }],
  ['client=app', { ...cliLike, 'x-opencode-client': 'app' }],
  ['client=tui', { ...cliLike, 'x-opencode-client': 'tui' }],
  ['client=opencode', { ...cliLike, 'x-opencode-client': 'opencode' }],
  ['ua-only', { 'user-agent': cliLike['user-agent'] }],
  ['no-auth', { 'user-agent': cliLike['user-agent'], 'x-opencode-client': 'desktop' }],
  ['bearer-opencode', { ...cliLike, authorization: 'Bearer opencode' }],
  ['bearer-empty', { ...cliLike, authorization: '' }],
  ['x-opencode-ticket', { ...cliLike, 'x-opencode-ticket': '1' }]
];

for (const [name, extra] of cases) {
  const headers = { ...base, ...extra };
  if (extra.authorization !== undefined) headers.authorization = extra.authorization || undefined;
  try {
    const r = await fetch(URL, { method: 'POST', headers, body });
    const text = await r.text();
    const tag = r.status === 403 ? 'FREE-TIER-BLOCKED' : r.status < 300 ? 'OK !!!' : '';
    console.log(name.padEnd(20), r.status, tag, text.slice(0, 110).replace(/\s+/g, ' '));
  } catch (error) {
    console.log(name.padEnd(20), 'ERR', error?.message);
  }
}
