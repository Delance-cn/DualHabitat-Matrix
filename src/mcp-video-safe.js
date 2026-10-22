// 安全版视频 MCP server（stdio）。由 DSH 的 MCP 客户端 spawn。
//
// 只暴露只读能力：
// - video_hot     热榜（抖音话题 / B 站热门视频）
// - video_feed    匿名可看的“刷”流（抖音热榜视频 / B 站热门翻页）
// - video_search  搜索（B 站公开搜索；抖音只能从热榜里过滤，匿名搜索会撞验证码）
// - video_watch   看单条视频：标题/作者/简介/封面 + 下载短视频抽关键帧
//
// 安全边界：
// - 不读写本地文件、不执行 shell、不做任何写操作。
// - 视频/封面下载走 safe-fetch（SSRF 防护、重定向逐跳校验、字节上限）。
// - 抖音单条视频依赖本机 Edge/Chrome 的 headless CDP；没有浏览器就只返回封面/简介。
// - 图片内容块只在当前模型命中 visionModels 白名单时返回，避免不支持图片的模型 400。
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  canSeeImages,
  feedDouyin,
  fmtDuration,
  hotBilibili,
  hotDouyinTopics,
  loadConfig,
  searchBilibili,
  searchDouyin,
  watchVideo,
} from './video-core.js';

const server = new McpServer({ name: 'video-safe', version: '0.1.0' });

const text = (t) => ({ type: 'text', text: String(t ?? '') });
const image = (buf) => ({ type: 'image', mimeType: 'image/jpeg', data: buf.toString('base64') });

function videoDisabled() {
  return loadConfig()?.socialV2?.tools?.video === false;
}

function disabledResult() {
  return { content: [text('视频工具已在控制台关闭（socialV2.tools.video=false）。')], isError: true };
}

function jsonResult(obj) {
  return { content: [text(JSON.stringify(obj, null, 2))] };
}

function formatWatch(meta, cover, frames) {
  const lines = [
    `平台：${meta.platform}`,
    `标题：${meta.title || '（无标题）'}`,
    meta.author ? `作者：${meta.author}` : '',
    meta.duration ? `时长：${fmtDuration(meta.duration)}` : '',
    meta.stats?.view != null ? `播放：${meta.stats.view}` : '',
    meta.stats?.like != null ? `点赞：${meta.stats.like}` : '',
    meta.desc ? `简介：${meta.desc}` : '',
    `页面：${meta.pageUrl || ''}`,
    meta.note ? `注意：${meta.note}` : '',
  ].filter(Boolean);

  const canSee = canSeeImages();
  const showCover = canSee && !frames.length && Boolean(cover);
  if (!canSee) {
    lines.push('当前模型不在 socialV2.images.visionModels 白名单里，这次没有附图片内容块。');
    if (meta.cover) lines.push(`封面地址：${meta.cover}`);
    if (frames.length) lines.push(`已抽到 ${frames.length} 帧，但未发送。`);
  } else if (frames.length) {
    lines.push(`下面附 ${frames.length} 张抽帧（JPEG，视频关键画面，不是完整视频）。`);
  } else if (showCover) {
    lines.push('没抽到视频帧，下面附封面。');
  } else {
    lines.push('没有拿到可用的封面或视频画面。');
  }

  const content = [text(lines.join('\n'))];
  if (canSee) {
    if (frames.length) {
      for (const f of frames) content.push(image(f));
    } else if (showCover) {
      content.push(image(cover));
    }
  }
  return { content };
}

server.tool(
  'video_hot',
  '看热榜：抖音返回热榜话题（文字+热度），B站返回热门视频（可点进 video_watch 看）。只读，不会自动刷屏。',
  {
    platform: z.enum(['douyin', 'bilibili']).describe('douyin=抖音热榜话题；bilibili=B站热门视频'),
    limit: z.number().int().min(1).max(30).optional().describe('数量，默认 10'),
  },
  async ({ platform, limit }) => {
    if (videoDisabled()) return disabledResult();
    try {
      const n = limit ?? 10;
      if (platform === 'douyin') {
        const items = await hotDouyinTopics(n);
        return jsonResult({
          platform,
          kind: 'hot-topics',
          note: '抖音热榜是话题，不是单条视频；想看视频用 video_feed（热榜视频流）或直接发分享链接。',
          items,
        });
      }
      const items = await hotBilibili(n, 1);
      return jsonResult({ platform, kind: 'hot-videos', items });
    } catch (error) {
      return { content: [text(`看热榜失败：${error?.message ?? error}`)], isError: true };
    }
  }
);

server.tool(
  'video_feed',
  '“刷”一批视频：抖音返回热榜里的视频卡片（含视频ID/标题/作者/封面），B站返回热门视频（支持 page 翻页）。不是个性化推荐；抖音匿名推荐流会撞验证码，热榜流是稳定入口。',
  {
    platform: z.enum(['douyin', 'bilibili']).describe('douyin=抖音热榜视频流；bilibili=B站热门视频流'),
    limit: z.number().int().min(1).max(30).optional().describe('数量，默认 10'),
    page: z.number().int().min(1).max(20).optional().describe('B站热门页码，默认 1；抖音忽略'),
  },
  async ({ platform, limit, page }) => {
    if (videoDisabled()) return disabledResult();
    try {
      const n = limit ?? 10;
      if (platform === 'douyin') {
        try {
          const items = await feedDouyin(n);
          return jsonResult({
            platform,
            kind: 'hot-videos',
            note: '这是抖音热榜视频流，不是个性化推荐；每次打开会变。点 video_watch 可以看其中一条。',
            items,
          });
        } catch (error) {
          const topics = await hotDouyinTopics(n);
          return jsonResult({
            platform,
            kind: 'hot-topics',
            note: `抖音热榜视频流没打开（${error?.message ?? error}），先给你热榜话题。`,
            items: topics,
          });
        }
      }
      const items = await hotBilibili(n, page ?? 1);
      return jsonResult({ platform, kind: 'hot-videos', page: page ?? 1, items });
    } catch (error) {
      return { content: [text(`刷视频失败：${error?.message ?? error}`)], isError: true };
    }
  }
);

server.tool(
  'video_search',
  '搜索视频：B站用公开搜索接口；抖音匿名搜索会撞验证码，只能在热榜视频/话题里按关键词过滤，建议直接发抖音分享链接。',
  {
    platform: z.enum(['douyin', 'bilibili']).describe('douyin 或 bilibili'),
    keyword: z.string().min(1).max(80).describe('搜索关键词'),
    limit: z.number().int().min(1).max(20).optional().describe('数量，默认 10'),
  },
  async ({ platform, keyword, limit }) => {
    if (videoDisabled()) return disabledResult();
    try {
      const n = limit ?? 10;
      if (platform === 'douyin') {
        const items = await searchDouyin(keyword, n);
        return jsonResult({
          platform,
          kind: 'search',
          keyword,
          note: '抖音匿名搜索被验证码限制，这里只从热榜视频/话题里过滤；最稳的是直接发单条分享链接。',
          items,
        });
      }
      const items = await searchBilibili(keyword, n);
      return jsonResult({ platform, kind: 'search', keyword, items });
    } catch (error) {
      return { content: [text(`搜索视频失败：${error?.message ?? error}`)], isError: true };
    }
  }
);

server.tool(
  'video_watch',
  '看一条抖音/B站视频：解析标题/作者/简介/封面，下载短视频并抽关键帧。传入分享文本或链接；抖音单条视频会用本机 Edge/Chrome 解析播放地址。只读。',
  {
    url: z.string().min(1).max(2000).describe('抖音/B站/YouTube 链接或分享文本'),
    frames: z.number().int().min(1).max(6).optional().describe('抽帧数量，默认 4；不想要画面可以设 1'),
  },
  async ({ url, frames }) => {
    if (videoDisabled()) return disabledResult();
    try {
      const wantFrames = canSeeImages();
      const r = await watchVideo(url, { frames: frames ?? 4, wantFrames });
      return formatWatch(r.meta, r.cover, r.frames);
    } catch (error) {
      return { content: [text(`看视频失败：${error?.message ?? error}`)], isError: true };
    }
  }
);

await server.connect(new StdioServerTransport());
