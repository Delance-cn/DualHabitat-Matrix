// 一次性验证：NodeApiClient.visionPrompt() 能否用指定视觉模型看懂图片。
// 生成白底红圆 → 临时会话 → 切视觉模型 → 带图 prompt → 收集文本。
import { ensureServer } from '../src/oc-server.js';
import { NodeApiClient } from '../src/oc-client.js';
import { PATHS, ROOT } from '../src/oc-env.js';
import zlib from 'node:zlib';

const log = (m) => console.log(`[vision-fallback-test] ${m}`);

function makeRedCirclePng() {
  const W = 128, H = 128, R = 40;
  const raw = Buffer.alloc(H * (1 + W * 3));
  for (let y = 0; y < H; y++) {
    const row = y * (1 + W * 3);
    raw[row] = 0;
    for (let x = 0; x < W; x++) {
      const dx = x - 64, dy = y - 64;
      const inside = dx * dx + dy * dy <= R * R;
      const o = row + 1 + x * 3;
      raw[o] = inside ? 224 : 255;
      raw[o + 1] = inside ? 32 : 255;
      raw[o + 2] = inside ? 32 : 255;
    }
  }
  const crcTable = [...Array(256)].map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const t = Buffer.from(type);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

await ensureServer({ log });
const api = new NodeApiClient(undefined, undefined, {
  stateDir: PATHS.state,
  sessionDir: PATHS.state,
  modelDirectory: ROOT,
  log,
  models: { enabled: false }
});

const png = makeRedCirclePng();
const candidates = [
  { provider: 'bailian', model: 'qwen3.8-max-0902' },
  { provider: 'bailian', model: 'qwen-vl-ocr' },
  { provider: 'bailian', model: 'qwen3-vl-plus', variant: 'low' },
  { provider: 'bailian', model: 'qwen3.8-max', variant: 'low' }
];
let text = '';
for (const candidate of candidates) {
  try {
    text = await api.visionPrompt({
      ...candidate,
      content: [
        { type: 'image', mediaType: 'image/png', data: png.toString('base64'), name: 'vision-fallback-test.png' },
        { type: 'text', text: '看这张图，用一句话回答里面画了什么。' }
      ],
      workspaceId: ROOT,
      agentPreset: 'qq-chat',
      timeoutMs: 120_000
    });
    log(`${candidate.provider}/${candidate.model} 回复：${JSON.stringify(text)}`);
    if (text) break;
  } catch (error) {
    log(`${candidate.provider}/${candidate.model} 失败：${error?.message ?? error}`);
  }
}
const pass = /红|圆/.test(text) && !/没(有|法|能)看|看不到|没有图/.test(text);
log(pass ? '✅ 通过：visionPrompt 把图片送到了视觉模型' : '❌ 未通过');
process.exit(pass ? 0 : 1);
