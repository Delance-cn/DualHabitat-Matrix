// 一次性验证：图片端到端 —— 桥接形状的 content block（{type:'image', mediaType, data:base64}）
// 经 oc-client 的 blocksToFiles 翻成 OpenCode files 附件，再由视觉模型真看一眼。
// 生成一张确定的图（白底红圆），模型答对即整条链通。跑完即退。
import { ensureServer } from '../src/oc-server.js';
import { NodeApiClient, unwrap, createTurnCollector } from '../src/oc-client.js';
import { PATHS, ROOT } from '../src/oc-env.js';
import fs from 'node:fs';
import zlib from 'node:zlib';

const log = (m) => console.log(`[vision-test] ${m}`);

// ── 1. 生成白底红圆测试图（与 spike/vision-test.png 同款，内联生成免依赖外部文件） ──
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
      raw[o] = inside ? 224 : 255; raw[o + 1] = inside ? 32 : 255; raw[o + 2] = inside ? 32 : 255;
    }
  }
  const crcTable = [...Array(256)].map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const t = Buffer.from(type); const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const png = makeRedCirclePng();
log(`测试图就绪：${png.length} bytes（白底红圆）`);

// ── 2. 起实例、建会话、切视觉模型 ──
await ensureServer({ log });
const api = new NodeApiClient(undefined, undefined, { stateDir: PATHS.state, sessionDir: PATHS.state, log });
const created = unwrap(await api.sessions.create({ workspaceId: ROOT, agentPreset: 'qq-chat', title: 'vision-test（可删）' }), 'sessions.create');
log(`会话 ${created.sessionId}`);

const raw = api._client ?? api.client ?? api;
const client = raw.client ?? raw;
try {
  await client.session.switchModel({ sessionID: created.sessionId, model: { providerID: 'bailian', modelID: 'qwen3-vl-plus', id: 'qwen3-vl-plus' } });
  log('已切到 bailian/qwen3-vl-plus');
} catch (e) {
  log(`switchModel 失败：${e.message}`);
}

// ── 3. 带图 prompt（桥接一代自动内联用的就是这种块形状） ──
const collector = createTurnCollector();
const result = (async () => {
  for await (const frame of api.events.mux()) {
    const done = collector.push(frame.payload.event);
    if (done) return done;
  }
  return null;
})();

const content = [
  { type: 'image', mediaType: 'image/png', data: png.toString('base64'), name: 'vision-test.png' },
  { type: 'text', text: '看这张图，用一句话回答里面画了什么。' }
];
unwrap(await api.sessions.prompt({ sessionId: created.sessionId, content }), 'sessions.prompt');
const ended = await Promise.race([result, new Promise((r) => setTimeout(() => r(null), 120_000))]);
log(ended ? `回合结束 reason=${JSON.stringify(ended.reason)}` : '回合超时');
const text = ended?.text ?? '';
log(`回复文本：${JSON.stringify(text)}`);
const pass = /红(色|色实心|色圆)|圆/.test(text) && !/没(有|法|能)看|看不到|没有图/.test(text);
log(pass ? '✅ 通过：图片内容真实到达了模型' : '❌ 未通过：模型像没看到图（链路某处把图丢了）');
try { await api.workspace.archiveSession({ sessionId: created.sessionId }); } catch {}
process.exit(pass ? 0 : 1);
