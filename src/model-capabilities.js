// 模型能力分类：桥接的视觉路由和控制台的模型池共用这一份判断。
//
// 为什么不直接用模型目录的 `capabilities.input`：目录不可信。百炼把
// qwen3.7-max / qwen3.8-max 这类纯文本模型也标成 image，真塞图片块会 400。
// 目录只能当提示，不能当路由依据。这里以模型名为主，config 的
// `socialV2.images.visionModels` 作为显式覆盖。
//
// 分类只有三类：视觉 / 文本 / 生成。生成类（生图、视频、TTS、embedding、
// rerank）不是聊天模型，不应该放进模型池。

const VISION_NAME_PATTERNS = [
  /(^|[-_/])(vl|vision|omni)([-_/]|$)/i,
  /(^|[-_/])ocr([-_/]|$)/i,
  /qwen[\d.]*-?vl/i,
  /qwen-vl/i,
  /qwen[\d.]*-?ocr/i,
  /deepseek-v4\.1-flash/i,
  /deepseek-flash/i,
  /deepseek.*(?:vl|vision)/i,
  /nemotron.*vl/i,
  /llava/i,
  /pixtral/i,
  /internvl/i,
  /minicpm-v/i,
  /glm-\d+(?:\.\d+)?v/i,
  /gpt-4o/i,
  /gpt-4\.1/i,
  /gpt-5/i,
  /gemini/i,
  /claude-(?:3|4)/i,
  /step-1v/i,
  /yi-vl/i,
  /moondream/i,
  /florence/i
];

const GENERATION_NAME_PATTERNS = [
  /(^|[-_/])(dall-e|dalle|flux|stable-diffusion|sdxl|midjourney|imagen|seedream|wanx|veo|sora|kling|runway|pika|tts|whisper|embedding|embed|rerank)([-_/]|$)/i,
  /(^|[-_/])(image|video)[-_]?(gen|generation)([-_/]|$)/i,
  /text-to-(image|video|speech)/i
];

// 目录里明确标了 image、实测却会 400 的模型。即使 config 的 visionModels
// 里还留着旧条目（0.6.0 的默认配置就有 qwen3.8-max），也不能把它们翻案。
// 只做精确匹配，避免 qwen3.8-max-vision 这类真正的视觉模型被误伤。
const KNOWN_TEXT_EXACT = new Set([
  'qwen3.8-max',
  'qwen3.7-max',
  'qwen3.6-plus',
  'qwen3.8-27b',
  'glm-4.5-flash',
  'glm-5',
  'glm-5.2',
  'kimi-k3',
  'minimax-m2.5',
  'qwen-long',
  'qwen-mt-lite',
  'qwen-mt-flash',
  'qwen-mt-plus',
  'gui-plus',
  'tongyi-xiaomi-analysis-flash',
  'tongyi-xiaomi-analysis-pro',
  'tonavi-intent-detect-v3'
]);

export const MODEL_CATEGORY_LABELS = Object.freeze({
  vision: '视觉',
  text: '文本',
  generation: '生成',
  unknown: '未知'
});

export const MODEL_CATEGORY_HINTS = Object.freeze({
  vision: '能直接看图片/表情',
  text: '只处理文字；收到图片时会先让视觉模型转述',
  generation: '生图/视频/语音/向量等非聊天模型，不建议放进模型池',
  unknown: '无法判断'
});

function normalize(modelId) {
  const raw = String(modelId ?? '').trim().toLowerCase();
  if (!raw) return { full: '', base: '', name: '' };
  const base = raw.split('#')[0];
  const slash = base.lastIndexOf('/');
  return { full: raw, base, name: slash >= 0 ? base.slice(slash + 1) : base };
}

function globMatch(value, pattern) {
  const p = String(pattern ?? '').trim().toLowerCase().split('#')[0];
  if (!p) return false;
  if (!p.includes('*')) return value === p;
  const re = new RegExp(
    `^${p.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`,
    'i'
  );
  return re.test(value);
}

function explicitVision(modelId, visionModels) {
  if (!Array.isArray(visionModels) || !visionModels.length) return false;
  const { full, base, name } = normalize(modelId);
  return visionModels.some((pattern) => {
    const raw = String(pattern ?? '').trim();
    if (!raw) return false;
    const normalized = raw.toLowerCase().split('#')[0];
    if (normalized.includes('/')) {
      return globMatch(base, normalized) || globMatch(full.split('#')[0], normalized);
    }
    return globMatch(name, normalized);
  });
}

/**
 * @param {string} modelId 形如 `bailian/qwen3-vl-plus#low`、`qwen3-vl-plus` 或裸名
 * @param {{ visionModels?: string[] }} [options]
 * @returns {'vision'|'text'|'generation'|'unknown'}
 */
export function classifyModel(modelId, { visionModels = [] } = {}) {
  const { name } = normalize(modelId);
  if (!name) return 'unknown';
  if (KNOWN_TEXT_EXACT.has(name)) return 'text';
  if (explicitVision(modelId, visionModels)) return 'vision';
  if (VISION_NAME_PATTERNS.some((re) => re.test(name))) return 'vision';
  if (GENERATION_NAME_PATTERNS.some((re) => re.test(name))) return 'generation';
  return 'text';
}

export function modelSeesImages(modelId, options = {}) {
  return classifyModel(modelId, options) === 'vision';
}

export function describeModelCategory(modelId, options = {}) {
  const key = classifyModel(modelId, options);
  return {
    key,
    label: MODEL_CATEGORY_LABELS[key] ?? key,
    hint: MODEL_CATEGORY_HINTS[key] ?? ''
  };
}
