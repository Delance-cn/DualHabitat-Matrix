// TTS 文本转语音：把一句话合成本地音频文件，QQ / 微信都能当语音条发出去。
//
// 引擎与 auto 顺序（从前往后试，哪个成用哪个，失败原因打日志）：
//   edge      — Edge 在线神经网络嗓音（免费、自然、中文好）。走微软公共 WebSocket 端点，
//               部分网络下会被限流（实测 429），失败自动落下一个。
//               SSML：能透传完整 <speak> 文档，但免费端点只吃受限制子集 —— 实测
//               纯文本 / <prosody> / <voice> 能过；<break>/<emphasis>/<say-as>/
//               <mstts:express-as> 会被服务端直接掉线（不是限流：90 秒冷静期后
//               对照实验复现）。含这些标签的 auto 会自动落 sapi，SSML 语义由 sapi 承接。
//   sapi      — Windows 自带 System.Speech（离线必成，保底）。嗓音机械（中文一般是
//               Microsoft Huihui Desktop），但零依赖、断网也能说。
//               SSML：SpeakSsml 支持 SSML 1.0 子集（实测 <break>/<emphasis> 生效）
//               —— 要用停顿/重读这类富标记，直接选 sapi 最稳。
//   dashscope — 预留位：百炼兼容模式 /audio/speech 本机实测 404，先不启用；以后接
//               CosyVoice WebSocket 时在这里加。
//
// SSML 路由（两个引擎同一套规则）：
//   完整文档  — <?xml 开头或 <speak> 根元素 → 引擎透传（edge 注入默认 <voice>，若文档自己写了就尊重文档）。
//   内嵌片段  — 纯文本里带 <break> 等标签但不是完整文档 → edge 模板包裹（注意 Edge 免费端点
//               不认这些标签，会掉线，auto 会落 sapi）；SAPI 包一层 <speak> 根再 SpeakSsml。
//   纯文本    — 照旧 Speak / toStream，不做任何转义。
//
// 音频落点：调用方给 outDir（QQ 侧 = 语音库 audio/tts/ 下，发完留在库里可重发）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolveDataRoot } from './data-root.js';

const CODE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_ROOT = resolveDataRoot(CODE_ROOT);

export const TTS_PROVIDERS = ['auto', 'edge', 'sapi'];
export const TTS_DEFAULT_VOICES = {
  edge: 'zh-CN-XiaoxiaoNeural',
  sapi: '' // 空 = 合成时自己挑第一个 zh-* 嗓音
};
/** Edge 在线嗓音的兜底：晓晓失败（嗓音不可用/区域问题）时换慧慧再试一次。 */
export const EDGE_FALLBACK_VOICE = 'zh-CN-HuihuiNeural';

/* ── 自定义 TTS 引擎（命令模板） ───────────────────────────────────────── */
// 预设引擎只有 edge / sapi，想接 GPT-SoVITS、Bert-VITS2、火山、自建 HTTP 服务……
// 都在 config.socialV2.voice.tts.custom 里加一条，不用改代码。
//
// 模板只认两个占位符：
//   {textFile} — 待合成文本的 UTF-8 临时文件路径（推荐，避免把用户文本拼进命令行）
//   {out}      — 期望写出的音频文件路径
// 刻意**不提供** {text}：文本来自聊天内容，直接拼进 shell 等于把命令注入面开放给群友。
export const CUSTOM_ENGINE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/i;

/** 归一化一条自定义引擎配置；不合法返回 null（供 UI/接口复用同一套规则）。 */
export function normalizeCustomEngine(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id ?? '').trim();
  if (!CUSTOM_ENGINE_ID_RE.test(id)) return null;
  const command = String(raw.command ?? '').trim();
  if (!command || !command.includes('{out}')) return null;
  return {
    id,
    label: String(raw.label ?? '').trim().slice(0, 40) || id,
    command: command.slice(0, 2000),
    format: ['mp3', 'wav'].includes(String(raw.format ?? '').toLowerCase()) ? String(raw.format).toLowerCase() : 'mp3',
    timeoutMs: Math.max(1000, Math.min(120_000, Math.floor(Number(raw.timeoutMs) || 60_000)))
  };
}

/** 读配置里的自定义引擎（每次都重读：桌面端改完立刻生效）。 */
export function readCustomTtsEngines() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(DATA_ROOT, 'config.json'), 'utf8'));
    const list = cfg?.socialV2?.voice?.tts?.custom;
    if (!Array.isArray(list)) return [];
    return list.map(normalizeCustomEngine).filter(Boolean);
  } catch {
    return [];
  }
}

function quoteArg(value) {
  const s = String(value);
  return process.platform === 'win32'
    ? `"${s.replace(/"/g, '""')}"`
    : `'${s.replace(/'/g, `'\\''`)}'`;
}

function killChildTree(child) {
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }
  } catch { /* 已退出 */ }
}

/** 跑一条自定义引擎命令。成功 = 退出码 0 且 {out} 有内容。 */
async function ttsCustom(text, outPath, engine) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dhm-tts-custom-'));
  const textFile = path.join(workDir, 'text.txt');
  fs.writeFileSync(textFile, text, 'utf8');
  try { fs.rmSync(outPath, { force: true }); } catch { /* ignore */ }
  const command = engine.command
    .replaceAll('{textFile}', quoteArg(textFile))
    .replaceAll('{out}', quoteArg(outPath));

  await new Promise((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      cwd: workDir,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    let err = '';
    let timedOut = false;
    const cap = (into) => (chunk) => {
      const s = chunk.toString('utf8');
      if (into === 'out') out = (out + s).slice(-4000);
      else err = (err + s).slice(-4000);
    };
    child.stdout.on('data', cap('out'));
    child.stderr.on('data', cap('err'));
    const timer = setTimeout(() => {
      timedOut = true;
      killChildTree(child);
    }, engine.timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(`启动自定义引擎失败：${e?.message ?? e}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`自定义引擎超时（${engine.timeoutMs} ms）`));
      if (code !== 0) {
        const tail = (err || out).trim().split(/\r?\n/).slice(-3).join(' / ');
        return reject(new Error(`自定义引擎退出码 ${code}${tail ? `：${tail}` : ''}`));
      }
      resolve();
    });
  }).finally(() => {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  if (!fs.existsSync(outPath)) throw new Error(`自定义引擎没有写出音频（检查命令里的 {out}）：${outPath}`);
  const bytes = fs.statSync(outPath).size;
  if (bytes < 200) throw new Error(`自定义引擎输出为空音频（${bytes} B）`);
}

/** 单次合成的字数上限（可被 config 的 voice.tts.maxChars 覆盖，范围 50-2000）。 */
export const TTS_MAX_CHARS = 2000;

export function clampMaxChars(value) {
  const n = Math.floor(Number(value) || 0);
  if (!Number.isFinite(n) || n <= 0) return TTS_MAX_CHARS;
  return Math.max(50, Math.min(TTS_MAX_CHARS, n));
}

/**
 * 清洗待合成文本：控制字符去掉、过长按句子边界截断（保留 \t \n \r —— SSML 多行文档需要）。
 *
 * 为什么不直接 slice：截在句子中间，语音会戛然而止。优先在 。！？；\n 处断，
 * 找不到合适的断点（< 上限的 60%）才硬截。返回 truncated/chars 让调用方如实告知。
 */
export function prepareText(text, maxChars = TTS_MAX_CHARS) {
  const limit = clampMaxChars(maxChars);
  const clean = String(text ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .trim();
  if (!clean) throw new Error('没有要合成的内容');
  if (clean.length <= limit) return { text: clean, truncated: false, chars: clean.length, used: clean.length, maxChars: limit };
  if (isSsmlDocument(clean)) {
    throw new Error(`SSML 文档太长（${clean.length} 字，上限 ${limit} 字），先拆成几句再合成`);
  }
  const head = clean.slice(0, limit);
  const marks = ['。', '！', '？', '；', '\n', '，'];
  let cut = -1;
  for (const mark of marks) cut = Math.max(cut, head.lastIndexOf(mark));
  const end = cut > limit * 0.6 ? cut + 1 : limit;
  return { text: clean.slice(0, end), truncated: true, chars: clean.length, used: end, maxChars: limit };
}

/** 是不是完整 SSML 文档（<?xml 声明开头，或 <speak> 根元素）。 */
export function isSsmlDocument(text) {
  return /^\s*(<\?xml|<\s*speak[\s>])/i.test(String(text ?? ''));
}

/** 是不是内嵌 SSML 片段（带 <break> 这类标签，但不是完整文档）。 */
function isSsmlFragment(text) {
  return /<\s*(\/)?\s*(break|say-as|phoneme|emphasis|prosody|voice|sub|mstts)\b/i.test(String(text ?? ''));
}

/** edge 原始 SSML 必须带 <voice name>：文档没写就注入配置的嗓音（写了就尊重文档）。 */
function ensureEdgeVoice(ssml, voiceName) {
  if (/<\s*voice\b[^>]*\bname\s*=/i.test(ssml)) return ssml;
  const open = /<\s*speak\b[^>]*>/i.exec(ssml);
  if (!open) return ssml; // 连 speak 根都没有就原样交出去，让引擎报人话
  const safe = String(voiceName).replace(/"/g, '&quot;');
  const at = open.index + open[0].length;
  let out = ssml.slice(0, at) + `<voice name="${safe}">` + ssml.slice(at);
  const close = /<\/\s*speak\s*>\s*$/i.exec(out);
  if (close) out = out.slice(0, close.index) + '</voice>' + out.slice(close.index);
  else out += '</voice>';
  return out;
}

/**
 * Edge 合成降级：按候选嗓音顺序试，每个遇到 429/掉线再短重试一次。
 * @param {string[]} voices 候选嗓音（去重由调用方保证）
 * @param {(voice: string) => Promise<void>} attempt 用指定嗓音合成；失败抛错
 * @returns {Promise<string>} 实际成功的嗓音
 */
export async function withEdgeFallback(voices, attempt, { retryDelayMs = 1500 } = {}) {
  let lastErr = null;
  for (const voice of voices) {
    for (let attemptNo = 1; attemptNo <= 2; attemptNo++) {
      try {
        await attempt(voice);
        return voice;
      } catch (err) {
        lastErr = err;
        const msg = String(err?.message ?? err);
        if (attemptNo === 1 && retryDelayMs > 0 && /429|Stream closed|before initialization/i.test(msg)) {
          await new Promise((r) => setTimeout(r, retryDelayMs));
          continue;
        }
        break;
      }
    }
  }
  throw lastErr ?? new Error('Edge TTS 失败');
}

/**
 * 合成一段语音。
 * @param {string} text 要说的话：纯文本、内嵌 SSML 片段（…<break time="300ms"/>…）、
 *                      或完整 SSML 文档（<speak version="1.0" …>…</speak>）。
 * @param {{ outDir?: string, provider?: string, voice?: string, maxChars?: number }} opts
 *   outDir：合成文件落哪个目录（默认系统临时目录）；文件名自动生成。
 *   provider：'auto' | 'edge' | 'sapi' | 'custom:<id>'（custom 见 config.socialV2.voice.tts.custom）。
 *   voice：引擎嗓音名，空 = 引擎默认（SSML 文档自带 <voice> 时以文档为准）。
 *   maxChars：单次合成最多多少字（50-2000，默认 2000）；超长按句子边界截断。
 * @returns {Promise<{path: string, provider: string, voice: string, bytes: number,
 *   chars: number, used: number, truncated: boolean, maxChars: number}>}
 */
export async function synthesizeText(text, opts = {}) {
  const prepared = prepareText(text, opts.maxChars);
  const clean = prepared.text;
  const want = String(opts.provider || 'auto').toLowerCase();
  const order = want === 'auto' ? ['edge', 'sapi'] : [want];
  const outDir = opts.outDir || os.tmpdir();
  fs.mkdirSync(outDir, { recursive: true });
  const isDoc = isSsmlDocument(clean);
  const isFragment = !isDoc && isSsmlFragment(clean);

  const errors = [];
  for (const provider of order) {
    const voice = opts.voice || TTS_DEFAULT_VOICES[provider] || '';
    const customEngine = provider.startsWith('custom:')
      ? readCustomTtsEngines().find((e) => e.id === provider.slice('custom:'.length))
      : null;
    if (provider.startsWith('custom:') && !customEngine) {
      const msg = `找不到自定义 TTS 引擎「${provider.slice('custom:'.length)}」`;
      if (want !== 'auto') throw new Error(`TTS（${provider}）失败：${msg}`);
      errors.push(`${provider}: ${msg}`);
      continue;
    }
    const ext = provider === 'sapi' ? 'wav' : customEngine ? customEngine.format : 'mp3';
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const file = path.join(outDir, `tts-${stamp}-${crypto.randomBytes(3).toString('hex')}.${ext}`);
    try {
      let usedVoice = voice;
      if (provider === 'edge') {
        // Edge 两次机会：配置的嗓音 → 慧慧兜底。每次遇到 429/掉线再短重试一次
        //（实测限流是窗口性的，1.5s 后常常就好了）。抽成 withEdgeFallback 是为了可测：
        // 真实网络里「嗓音名写错」不一定报错（服务端会拿默认嗓音凑合），注入式测试才稳。
        const candidates = [voice || TTS_DEFAULT_VOICES.edge];
        if (!candidates.includes(EDGE_FALLBACK_VOICE)) candidates.push(EDGE_FALLBACK_VOICE);
        usedVoice = await withEdgeFallback(candidates, async (candidate) => {
          try {
            await ttsEdge(clean, file, candidate, isDoc);
          } catch (err) {
            try { fs.rmSync(file, { force: true }); } catch {}
            throw err;
          }
        });
      } else if (provider.startsWith('custom:')) {
        await ttsCustom(clean, file, customEngine);
        usedVoice = customEngine.label;
      } else if (provider === 'sapi') await ttsSapi(clean, file, voice, isDoc, isFragment);
      else throw new Error(`未知 TTS 引擎：${provider}`);
      const bytes = fs.statSync(file).size;
      if (bytes < 200) throw new Error('合成结果为空音频');
      return {
        path: file,
        provider,
        voice: usedVoice || '(默认)',
        voiceFallback: provider === 'edge' && usedVoice === EDGE_FALLBACK_VOICE && voice !== EDGE_FALLBACK_VOICE,
        bytes,
        chars: prepared.chars,
        used: prepared.used,
        truncated: prepared.truncated,
        maxChars: prepared.maxChars
      };
    } catch (err) {
      try { fs.rmSync(file, { force: true }); } catch {}
      errors.push(`${provider}: ${err?.message ?? err}`);
      // auto 才继续降级；明确指定的引擎失败就直接报错（用户要知道为什么）
      if (want !== 'auto') throw new Error(`TTS（${provider}）失败：${err?.message ?? err}`);
    }
  }
  throw new Error(`所有 TTS 引擎都失败了 —— ${errors.join('；')}`);
}

/** Edge 在线嗓音：msedge-tts 动态加载，没装/被限流就抛错（调用方决定降级）。 */
async function ttsEdge(text, outPath, voice, isDoc) {
  let mod;
  try {
    mod = await import('msedge-tts');
  } catch (err) {
    throw new Error(`msedge-tts 没装上（${err?.message ?? err}）`);
  }
  const { MsEdgeTTS, OUTPUT_FORMAT } = mod;
  const tts = new MsEdgeTTS();
  try {
    await tts.setMetadata(voice || TTS_DEFAULT_VOICES.edge, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const chunks = [];
    if (isDoc) {
      // 完整 SSML 文档：原始透传。协议要求请求里带 <voice name>，文档没写就注入。
      const requestSSML = ensureEdgeVoice(text, voice || TTS_DEFAULT_VOICES.edge);
      const { audioStream } = await tts.rawToStream(requestSSML);
      for await (const chunk of audioStream) chunks.push(chunk);
    } else {
      // 纯文本 / 内嵌片段：库自己套 <speak><voice><prosody> 模板，片段原样进模板。
      const { audioStream } = tts.toStream(text);
      for await (const chunk of audioStream) chunks.push(chunk);
    }
    const buf = Buffer.concat(chunks);
    if (buf.length < 200) throw new Error('返回空音频（多半被限流）');
    fs.writeFileSync(outPath, buf);
  } finally {
    try { tts.close?.(); } catch {}
  }
}

/**
 * Windows 自带 SAPI：离线保底。PowerShell System.Speech → WAV（文本走临时文件，不跟引号搏斗）。
 * isDoc / isFragment 时用 SpeakSsml（SSML 1.0 子集）；纯文本用 Speak，任何字符都安全。
 */
async function ttsSapi(text, outPath, voice, isDoc, isFragment) {
  const tmp = os.tmpdir();
  const tag = crypto.randomBytes(4).toString('hex');
  const textFile = path.join(tmp, `dhm-tts-${tag}.txt`);
  const psFile = path.join(tmp, `dhm-tts-${tag}.ps1`);
  // 片段包一层 speak 根再交 SpeakSsml；完整文档原样。
  const payload = !isDoc && isFragment
    ? `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="zh-CN">${text}</speak>`
    : text;
  fs.writeFileSync(textFile, payload, 'utf8');
  // PS 5.1 注意事项：一律绝对路径；文本用 [IO.File]::ReadAllText(UTF8) 读；
  // 嗓音不指定就挑第一个 zh-* 的（中文 Windows 上是 Huihui；英文系统上也能说，音色一般）。
  fs.writeFileSync(
    psFile,
    [
      'param([string]$OutPath, [string]$Voice, [string]$TextPath, [switch]$UseSsml)',
      'Add-Type -AssemblyName System.Speech',
      '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
      'if ($Voice) { try { $s.SelectVoice($Voice) } catch {} }',
      'else {',
      '  $v = $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -like \'zh*\' } | Select-Object -First 1',
      '  if ($v) { $s.SelectVoice($v.VoiceInfo.Name) }',
      '}',
      '$s.SetOutputToWaveFile($OutPath)',
      '$spoken = [IO.File]::ReadAllText($TextPath, [System.Text.Encoding]::UTF8)',
      'if ($UseSsml) { $s.SpeakSsml($spoken) } else { $s.Speak($spoken) }',
      '$s.Dispose()'
    ].join('\r\n'),
    'utf8'
  );
  try {
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psFile, '-OutPath', outPath, '-Voice', voice || '', '-TextPath', textFile];
    if (isDoc || isFragment) args.push('-UseSsml');
    await new Promise((resolve, reject) => {
      const child = spawn('powershell.exe', args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      let errOut = '';
      child.stderr.on('data', (c) => { errOut += c.toString(); });
      child.on('error', reject);
      child.on('exit', (code) => {
        if (code === 0 && fs.existsSync(outPath) && fs.statSync(outPath).size > 200) resolve();
        else reject(new Error(`PowerShell 退出码 ${code}${errOut ? `：${errOut.trim().slice(0, 200)}` : ''}`));
      });
    });
  } finally {
    for (const f of [textFile, psFile]) {
      try { fs.rmSync(f, { force: true }); } catch {}
    }
  }
}
