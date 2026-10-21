/**
 * 看 cline 的 text 内容块在**长回答**下到底是增量还是整段。
 * 只打 contentType=text 的帧，外加 done/run_result。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const bin = path.join(process.env.LOCALAPPDATA, 'Cline', 'cline-cli.exe');
const tmp = path.join(os.tmpdir(), 'cline-probe');
const prompt = '写一首四行的中文小诗，主题是下雨的夜晚。只输出诗，不要解释。';

const child = spawn(
  bin,
  ['--json', '--data-dir', path.join(tmp, 'data'), '-P', 'openrouter', '-m', 'openrouter/free', '--auto-approve', 'false', prompt],
  { cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
);

let out = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (c) => (out += c));
child.stderr.setEncoding('utf8');
child.stderr.on('data', (c) => (out += c));

child.on('close', (code) => {
  console.log('exit =', code);
  const lines = out.split('\n').filter(Boolean);
  const rows = [];
  for (const line of lines) {
    let f;
    try {
      f = JSON.parse(line);
    } catch {
      continue;
    }
    if (f.type === 'agent_event') {
      const e = f.event ?? {};
      if (e.type === 'content_start' && e.contentType === 'text') {
        rows.push({ kind: 'chunk', text: e.text, accumulated: e.accumulated });
      }
      if (e.type === 'content_end' && e.contentType === 'text') {
        rows.push({ kind: 'end', text: e.text });
      }
      if (e.type === 'done') rows.push({ kind: 'done', text: e.text, reason: e.reason });
    }
    if (f.type === 'run_result') rows.push({ kind: 'run_result', text: f.text, finishReason: f.finishReason });
    if (f.type === 'error') rows.push({ kind: 'error', message: f.message });
  }
  for (const r of rows) {
    const s = JSON.stringify(r);
    console.log(s.length > 300 ? s.slice(0, 300) + ' …' : s);
  }
});
