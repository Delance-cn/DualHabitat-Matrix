// 逐模型跑 probe.mjs，看哪些 CF 模型能穿过 OpenCode 的流解析。
// 只测"免费套餐可用 + 目录标 tool_call:true"的 —— 别的没意义。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LOG = path.join(ROOT, 'spike', 'logs', 'probe-events.jsonl');

const models = process.env.CF_MODELS
  ? process.env.CF_MODELS.split(',').map((s) => s.trim()).filter(Boolean)
  : [
      '@cf/openai/gpt-oss-120b',
      '@cf/zai-org/glm-4.7-flash',
      '@cf/mistralai/mistral-small-3.1-24b-instruct',
      '@cf/meta/llama-4-scout-17b-16e-instruct',
      '@cf/google/gemma-4-26b-a4b-it',
      '@cf/meta/llama-3.3-70b-instruct-fp8-fast'
    ];

const run = (model) =>
  new Promise((resolve) => {
    try {
      fs.rmSync(LOG, { force: true });
    } catch {}
    const child = spawn('node', ['spike/probe.mjs'], {
      cwd: ROOT,
      env: { ...process.env, PROBE_PROVIDER: 'cloudflare-workers-ai', PROBE_MODEL: model },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (out += d.toString()));
    child.on('error', (error) => resolve({ model, verdict: '✗ 启动失败', detail: error.message, text: '' }));
    child.on('close', () => {
      let verdict = '未知';
      let detail = '';
      let text = '';
      try {
        const lines = fs
          .readFileSync(LOG, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l));
        const fail = lines.find((e) => /execution\.failed/.test(e.type ?? ''));
        const ok = lines.find((e) => /execution\.succeeded/.test(e.type ?? ''));
        const errLine = lines.find((e) => e.data && e.data.error);
        const textLine = lines.find((e) => /assistant\.message/.test(e.type ?? '') && e.data?.text);
        text = String(textLine?.data?.text ?? '').replace(/\s+/g, ' ').slice(0, 50);
        if (ok) verdict = '✓ 成功';
        else if (fail) verdict = '✗ 失败';
        if (errLine) {
          const e = errLine.data.error;
          detail = String(e?.message ?? JSON.stringify(e)).slice(0, 90);
        }
      } catch (error) {
        detail = `解析日志失败: ${error.message}`;
      }
      if (verdict === '未知' && out) detail = out.replace(/\s+/g, ' ').slice(0, 90);
      // probe.mjs 自己会打印 [assistant text] "..."，直接用它看模型真答了什么
      const m = out.match(/\[assistant text\]\s*"([\s\S]*?)"\s*$/m) ?? out.match(/\[assistant text\]\s*"([\s\S]*?)"/);
      if (m) text = m[1].replace(/\s+/g, ' ').slice(0, 80);
      resolve({ model, verdict, detail, text });
    });
  });

console.log('模型'.padEnd(48) + '结果      说明');
console.log('─'.repeat(110));
for (const m of models) {
  const r = await run(m);
  const cell = `${r.verdict}`.padEnd(9);
  console.log(`${m.replace('@cf/', '').padEnd(46)} ${cell} ${(r.detail || r.text).slice(0, 70)}`);
}
