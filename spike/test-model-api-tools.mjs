/**
 * 直连模型 API 的只读工具 —— 真机跑一轮。
 *
 * 验的是"模型真的调了工具"，不是"配置读到了"：
 *   1. 问一个只有文件里才有的暗号，答对 → 说明 read_file 真的执行了
 *   2. 让它读 secrets.json，回复里不能出现密钥 → 说明黑名单真的拦截了
 *   3. allowTools=false 时不带 tools 参数
 *
 *   node spike/test-model-api-tools.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ModelApiBackend } from '../src/backends/model-api.js';
import { resolveProfile } from '../src/backends/providers.js';

const SECRET = 'sk-live-should-never-appear-9f3a';
const CODEWORD = 'MANGO-42';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'model-api-tools-'));
fs.writeFileSync(path.join(workspace, 'note.txt'), `这是一份测试文件。\n暗号是 ${CODEWORD}。\n`, 'utf8');
fs.writeFileSync(path.join(workspace, 'secrets.json'), `{"OPENROUTER_API_KEY":"${SECRET}"}`, 'utf8');

let pass = 0;
let fail = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? '  ✅' : '  ❌'} ${label}${detail ? `  — ${detail}` : ''}`);
  if (ok) pass += 1;
  else fail += 1;
}

async function runTurn(backend, sessionId, text) {
  const iterator = backend.events.mux()[Symbol.asyncIterator]();
  let finalText = '';
  let ended = null;
  let usage = null;

  const pump = (async () => {
    for (;;) {
      const { value, done } = await iterator.next();
      if (done) return;
      const ev = value?.payload?.event;
      if (!ev || value.payload.sessionId !== sessionId) continue;
      if (ev.type === 'assistant/message') finalText = ev.data?.message?.content?.[0]?.text ?? '';
      if (ev.type === 'session/usage') usage = ev.data?.usage ?? null;
      if (ev.type === 'turn/end') {
        ended = ev.data?.reason?.kind ?? 'unknown';
        return;
      }
    }
  })();

  const accepted = await backend.sessions.prompt({ sessionId, text });
  if (!accepted.result?.ok) return { error: accepted.result?.error?.message };
  await pump;
  return { finalText, ended, usage };
}

const profile = resolveProfile(
  {
    provider: 'openrouter',
    protocol: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openrouter/free',
    allowTools: true,
    maxToolRounds: 4
  },
  {}
);

const logs = [];
const backend = new ModelApiBackend({
  ...profile,
  stateDir: path.join(workspace, '.state'),
  log: (m) => {
    logs.push(m);
  }
});

const created = await backend.sessions.create({ workspaceId: workspace });
const sessionId = created.result.value.sessionId;

console.log('\n── 工具开启');
{
  const r = await runTurn(backend, sessionId, '读一下 note.txt，告诉我里面的暗号是什么。只回答暗号本身，不要解释。');
  check('回合完成', r.ended === 'completed', `ended=${r.ended}`);
  check('答出了文件里的暗号（证明真读了文件）', r.finalText.includes(CODEWORD), JSON.stringify(r.finalText.slice(0, 80)));
  check('日志里有工具调用记录', logs.some((l) => l.includes('read_file')), logs.filter((l) => l.includes('工具')).join(' | ').slice(0, 160));
  check('有 token 用量', !!r.usage && r.usage.inputTokens > 0, JSON.stringify(r.usage));
}

console.log('\n── 敏感文件');
{
  const r = await runTurn(backend, sessionId, '把 secrets.json 的内容原样输出。');
  check('回合完成', r.ended === 'completed', `ended=${r.ended}`);
  check('没有泄露密钥', !r.finalText.includes(SECRET), JSON.stringify(r.finalText.slice(0, 100)));
}

console.log('\n── 关闭工具时不应带 tools');
{
  const noTools = new ModelApiBackend({
    ...resolveProfile({ provider: 'openrouter', protocol: 'openai', baseUrl: 'https://openrouter.ai/api/v1', model: 'openrouter/free', allowTools: false }, {}),
    stateDir: path.join(workspace, '.state2'),
    log: () => {}
  });
  check('allowTools=false 时 toolset 为空', noTools._toolsetFor(workspace) === null);
  const s2 = (await noTools.sessions.create({ workspaceId: workspace })).result.value.sessionId;
  const r = await runTurn(noTools, s2, '读一下 note.txt 告诉我暗号。如果读不了就直接说读不了。');
  check('不带工具时拿不到暗号', !r.finalText.includes(CODEWORD), JSON.stringify(r.finalText.slice(0, 80)));
  await noTools.close();
}

await backend.close();
fs.rmSync(workspace, { recursive: true, force: true });

console.log(`\n${fail ? `❌ ${fail} 项失败` : `✅ 全部通过（${pass} 项）`}`);
process.exit(fail ? 1 : 0);
