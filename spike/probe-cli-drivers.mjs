/**
 * 新增的两个 CLI 驱动 —— 真机跑一遍引擎（不是直接调 CLI）。
 *
 * 验的是四件事：
 *   1. Kiro：能出文本、能拿到 sessionId、第二轮 --resume-id 真的记得上文
 *   2. Kiro：allowTools=false 时带的是 --trust-tools=（一个工具都不给）
 *   3. Cline：单 token 的中文 prompt（"你好"）不会被当成子命令 —— 这是最容易复发的一个坑
 *   4. Cline：不能 resume，靠 driver 回放历史，第二轮还记得第一轮说了什么
 *
 * 跑法（需要 OPENROUTER_API_KEY，Cline 那条用 free 模型，零成本）：
 *   node spike/probe-cli-drivers.mjs kiro
 *   node spike/probe-cli-drivers.mjs cline
 *   node spike/probe-cli-drivers.mjs all
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CliBackend } from '../src/backends/cli/engine.js';
import { getDriver } from '../src/backends/cli/drivers.js';

const which = process.argv[2] ?? 'all';
const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-driver-probe-'));

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? '  ✅' : '  ❌'} ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

/** 跑一轮，把事件流收成结果。 */
async function runTurn(backend, sessionId, text) {
  const iterator = backend.events.mux()[Symbol.asyncIterator]();
  const chunks = [];
  let finalText = '';
  let ended = null;

  const pump = (async () => {
    for (;;) {
      const { value, done } = await iterator.next();
      if (done) return;
      const ev = value?.payload?.event;
      if (!ev || value.payload.sessionId !== sessionId) continue;
      if (ev.type === 'assistant/chunk') chunks.push(ev.data?.delta ?? '');
      if (ev.type === 'assistant/message') finalText = ev.data?.message?.content?.[0]?.text ?? '';
      if (ev.type === 'turn/end') {
        ended = ev.data?.reason?.kind ?? 'unknown';
        return;
      }
    }
  })();

  const accepted = await backend.sessions.prompt({ sessionId, text });
  if (!accepted.result?.ok) {
    return { error: accepted.result?.error?.message ?? 'prompt 未被接受' };
  }
  await pump;
  return { chunks: chunks.join(''), finalText, ended };
}

async function newSession(backend) {
  const res = await backend.sessions.create({});
  return res.result.value.sessionId;
}

/* ══════════════════════════════════════════════════════════════════════════ */

async function testKiro() {
  console.log('\n══════ Kiro CLI');
  const driver = getDriver('kiro-cli');
  const backend = new CliBackend({
    driver,
    stateDir: path.join(stateRoot, 'kiro'),
    allowTools: false,
    timeoutMs: 180_000,
    log: (m) => console.log('    ·', m)
  });

  const args = driver.buildArgs({ allowTools: false, options: {} });
  check('群聊档带 --trust-tools=（不给工具）', args.includes('--trust-tools='), args.join(' '));
  check('走 stdin 喂 prompt', driver.promptVia === 'stdin');

  const sid = await newSession(backend);
  const r1 = await runTurn(backend, sid, 'Remember the secret word is BANANA. Reply only: ok');
  check('第一轮完成', r1.ended === 'completed', `ended=${r1.ended} text=${JSON.stringify(r1.finalText?.slice(0, 40))}`);
  check('第一轮有文本', !!r1.finalText.trim());
  check('流式片段非空', r1.chunks.length > 0, `${r1.chunks.length} 字`);

  const nativeId = backend._sessions.get(sid)?.nativeId;
  check('拿到 native sessionId（可 resume）', !!nativeId, String(nativeId));

  const r2 = await runTurn(backend, sid, 'What is the secret word? Reply with just the word.');
  check('第二轮完成', r2.ended === 'completed', `ended=${r2.ended}`);
  check('第二轮记得上文（BANANA）', /BANANA/i.test(r2.finalText), JSON.stringify(r2.finalText.slice(0, 60)));

  backend.bus.close();
}

async function testCline() {
  console.log('\n══════ Cline CLI');
  if (!process.env.OPENROUTER_API_KEY) {
    console.log('  ⏭  跳过：没有 OPENROUTER_API_KEY');
    return;
  }

  const driver = getDriver('cline-cli');
  const backend = new CliBackend({
    driver,
    stateDir: path.join(stateRoot, 'cline'),
    allowTools: false,
    timeoutMs: 180_000,
    options: { provider: 'openrouter', model: 'openrouter/free' },
    log: (m) => console.log('    ·', m)
  });

  const args = driver.buildArgs({ promptText: '你好', cwd: path.join(stateRoot, 'cline', 'x'), allowTools: false, sessionId: 's1', options: {} });
  check('promptVia=arg（这个版本不认 stdin）', driver.promptVia === 'arg');
  check('群聊档 --auto-approve false', args.includes('false') && args.includes('--auto-approve'));
  check('单 token prompt 补了尾随空格', args[args.length - 1] === '你好 ', JSON.stringify(args[args.length - 1]));

  const sid = await newSession(backend);
  const r1 = await runTurn(backend, sid, '你好');
  check('单 token 中文 prompt 不报错', !r1.error && r1.ended === 'completed', r1.error ?? `ended=${r1.ended}`);
  check('单 token prompt 有回复', !!r1.finalText.trim(), JSON.stringify(r1.finalText.slice(0, 40)));

  const r2 = await runTurn(backend, sid, '我刚才第一句说了什么？只回答那几个字，不要解释。');
  check('第二轮完成', r2.ended === 'completed', `ended=${r2.ended}`);
  check('回放历史生效（提到"你好"）', /你好/.test(r2.finalText), JSON.stringify(r2.finalText.slice(0, 60)));

  backend.bus.close();
}

if (which === 'kiro' || which === 'all') await testKiro();
if (which === 'cline' || which === 'all') await testCline();

console.log(`\n${failures ? `❌ ${failures} 项失败` : '✅ 全部通过'}`);
process.exit(failures ? 1 : 0);
