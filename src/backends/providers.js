/**
 * backends/providers.js —— 预置厂商表 + 自定义接入。
 *
 * 两层：
 *   1. 内置厂商：选个名字，填 key 就能用（baseUrl 已经填好）。
 *   2. 自定义：baseUrl / protocol / model 全自己填 —— 中转站、自建网关、本地 Ollama 都走这条。
 *
 * ⚠️ `models` 只是**示例**，随时会过期。要真实列表就调 `listModels()`，
 *    它直接问服务端的 /models（OpenAI 兼容）或 Gemini 的模型接口。
 *    别把这里的示例当权威 —— 项目 README 里那条"额度表要对齐"的教训就是这么来的。
 */

export const PROVIDERS = {
  /* ── 国际三家 ─────────────────────────────────────────────────────── */
  openai: {
    label: 'OpenAI',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    keyEnv: 'OPENAI_API_KEY',
    models: ['gpt-4o-mini', 'gpt-4o'],
    note: '国内需代理'
  },
  anthropic: {
    label: 'Anthropic (Claude)',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    keyEnv: 'ANTHROPIC_API_KEY',
    models: ['claude-sonnet-4-5', 'claude-haiku-4-5'],
    note: '国内需代理'
  },
  gemini: {
    label: 'Google Gemini',
    protocol: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    keyEnv: 'GEMINI_API_KEY',
    models: ['gemini-2.5-flash', 'gemini-2.5-pro'],
    note: '国内需代理'
  },

  /* ── 国内主流（全部 OpenAI 兼容）───────────────────────────────────── */
  bailian: {
    label: '阿里云百炼',
    protocol: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    keyEnv: 'BAILIAN_API_KEY',
    models: ['qwen-plus', 'qwen-max', 'qwen-vl-plus'],
    note: '原项目主力后端'
  },
  deepseek: {
    label: 'DeepSeek',
    protocol: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    keyEnv: 'DEEPSEEK_API_KEY',
    models: ['deepseek-chat', 'deepseek-reasoner']
  },
  moonshot: {
    label: '月之暗面 Kimi',
    protocol: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1',
    keyEnv: 'MOONSHOT_API_KEY',
    models: ['moonshot-v1-8k', 'kimi-k2-turbo-preview']
  },
  zhipu: {
    label: '智谱 GLM',
    protocol: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    keyEnv: 'ZHIPU_API_KEY',
    models: ['glm-4.5-flash', 'glm-4-plus'],
    note: 'flash 系列有免费额度'
  },
  minimax: {
    label: 'MiniMax',
    protocol: 'openai',
    baseUrl: 'https://api.minimax.chat/v1',
    keyEnv: 'MINIMAX_API_KEY',
    models: ['abab6.5s-chat']
  },
  volcengine: {
    label: '火山方舟（豆包）',
    protocol: 'openai',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    keyEnv: 'ARK_API_KEY',
    models: ['doubao-pro-32k'],
    note: '模型名填接入点 ID'
  },
  siliconflow: {
    label: '硅基流动',
    protocol: 'openai',
    baseUrl: 'https://api.siliconflow.cn/v1',
    keyEnv: 'SILICONFLOW_API_KEY',
    models: ['Qwen/Qwen2.5-7B-Instruct']
  },
  openrouter: {
    label: 'OpenRouter',
    protocol: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyEnv: 'OPENROUTER_API_KEY',
    models: ['openrouter/free']
  },

  /* ── 本地 / 自建 ───────────────────────────────────────────────────── */
  ollama: {
    label: '本地 Ollama',
    protocol: 'openai',
    baseUrl: 'http://127.0.0.1:11434/v1',
    keyEnv: null,
    apiKey: 'ollama',
    models: ['qwen2.5:7b'],
    note: '不需要 key，填任意非空值即可'
  },
  lmstudio: {
    label: '本地 LM Studio',
    protocol: 'openai',
    baseUrl: 'http://127.0.0.1:1234/v1',
    keyEnv: null,
    apiKey: 'lm-studio',
    models: ['local-model']
  },
  // 下面三家是 0.5.3 补的：服务端早就在探测 8000 / 1337（LOCAL_MODEL_SERVERS），
  // 但厂商表里没有它们 —— 下拉框选不到，用户只能点「本地服务」按钮，而那个按钮
  // 以前会把 provider 清空，存下来的档被配置生成器当成"没配"。名单必须和探测项对齐。
  vllm: {
    label: '本地 vLLM',
    protocol: 'openai',
    baseUrl: 'http://127.0.0.1:8000/v1',
    keyEnv: null,
    apiKey: 'local',
    models: [],
    note: 'vLLM 默认 8000；llama.cpp 也常起在这个端口，换端口改地址即可'
  },
  llamacpp: {
    label: '本地 llama.cpp',
    protocol: 'openai',
    baseUrl: 'http://127.0.0.1:8080/v1',
    keyEnv: null,
    apiKey: 'local',
    models: [],
    note: 'llama-server 默认 8080'
  },
  jan: {
    label: '本地 Jan',
    protocol: 'openai',
    baseUrl: 'http://127.0.0.1:1337/v1',
    keyEnv: null,
    apiKey: 'local',
    models: [],
    note: 'Jan 的本地 API 默认 1337'
  },
  custom: {
    label: '自定义接入',
    protocol: 'openai',
    baseUrl: '',
    keyEnv: 'CUSTOM_API_KEY',
    models: [],
    note: '中转站 / 自建网关：填 baseUrl（到 /v1 为止）、protocol、模型名'
  }
};

/** 供控制台渲染下拉框：按分组返回，不含 key。 */
export function listProviders() {
  return Object.entries(PROVIDERS).map(([id, p]) => ({
    id,
    label: p.label,
    protocol: p.protocol,
    baseUrl: p.baseUrl,
    keyEnv: p.keyEnv,
    models: p.models,
    note: p.note ?? null,
    needsKey: p.keyEnv != null
  }));
}

/** Stable, non-secret environment-variable name for one custom model profile slot. */
export function modelProfileKeyEnv(platform, slot) {
  const pf = String(platform ?? '').toLowerCase();
  const key = String(slot ?? '').toLowerCase();
  if (!['qq', 'wechat'].includes(pf) || !['chat', 'work'].includes(key)) {
    throw new Error('模型档位必须是 qq/wechat × chat/work');
  }
  return `DHM_MODEL_${pf.toUpperCase()}_${key.toUpperCase()}_API_KEY`;
}

/**
 * 把用户配置（可能只写了 provider 名）补全成完整的 profile。
 *
 * 优先级：显式字段 > 厂商预设 > 内置默认。
 * 这样"只填 provider + key"能跑，"全都自定义"也能跑。
 *
 * @param {object} input  config.backend.modelApi
 * @param {Record<string,string>} [secrets]  secrets.json 的内容
 */
export function resolveProfile(input = {}, secrets = {}) {
  const preset = PROVIDERS[input.provider ?? ''] ?? null;
  const protocol = input.protocol ?? preset?.protocol ?? 'openai';
  const baseUrl = input.baseUrl ?? preset?.baseUrl ?? '';
  const model = input.model ?? preset?.models?.[0] ?? '';
  const keyEnv = input.apiKeyEnv ?? preset?.keyEnv ?? null;

  let apiKey = input.apiKey ?? null;
  if (!apiKey && keyEnv) apiKey = secrets[keyEnv] ?? process.env[keyEnv] ?? null;
  if (!apiKey && preset?.apiKey) apiKey = preset.apiKey;

  if (!baseUrl) {
    throw new Error(
      `后端 baseUrl 为空。${preset ? `厂商 ${preset.label} 没配地址？` : '请在 config.json 的 backend.modelApi.baseUrl 填上'}` +
        `（自定义接入要填到 /v1 为止，例如 https://your-relay.com/v1）`
    );
  }
  if (!apiKey) {
    throw new Error(
      `后端缺少 API key：${keyEnv ? `secrets.json 里没有 ${keyEnv}` : '请在 backend.modelApi.apiKey 直接填'}` +
        `。本地 Ollama / LM Studio 可以随便填一个非空值。`
    );
  }
  if (!model) {
    throw new Error('后端缺少 model。可以调 listModels() 看服务端有哪些。');
  }

  return {
    protocol,
    baseUrl,
    model,
    apiKey,
    provider: input.provider ?? null,
    temperature: input.temperature,
    maxTokens: input.maxTokens,
    anthropicVersion: input.anthropicVersion,
    // 这三个在 ModelApiBackend 的 DEFAULTS 里写着，但以前没被透传 ——
    // index.js 是 `new ModelApiBackend({ ...profile, stateDir, log })`，
    // profile 里没有的键就永远拿不到，于是 config.json 里填了也不生效。
    // 传 undefined 是安全的，前提是 model-api.js 合并默认值时会把 undefined 剔掉
    // （见那边的 dropUndefined：`{...DEFAULTS, ...{x:undefined}}` 会把 x 盖成 undefined）。
    maxHistory: input.maxHistory,
    maxContextChars: input.maxContextChars,
    timeoutMs: input.timeoutMs,
    // 只读工具（read_file / list_dir / search_text）—— 默认关，开了也只是只读
    allowTools: input.allowTools,
    maxToolRounds: input.maxToolRounds,
    workspaceDir: input.workspaceDir
  };
}

/**
 * 问服务端要真实模型列表。
 *
 * 为什么需要：README 里踩过"额度表要对齐"的坑 —— 凭 /models 列表想当然地
 * 认为某模型免费，实际是按量计费。所以这里只负责"有哪些"，不负责"贵不贵"。
 *
 * @returns {Promise<string[]>}
 */
export async function listModels(profile, { signal } = {}) {
  const base = profile.baseUrl.replace(/\/+$/, '');
  try {
    if (profile.protocol === 'gemini') {
      const res = await fetch(`${base}/models?key=${encodeURIComponent(profile.apiKey)}`, { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      return (json.models ?? [])
        .map((m) => String(m.name ?? '').replace(/^models\//, ''))
        .filter(Boolean);
    }

    // OpenAI 兼容（含 Anthropic 的兼容端点）：统一试 /models
    const headers = { authorization: `Bearer ${profile.apiKey}` };
    if (profile.protocol === 'anthropic') {
      headers['x-api-key'] = profile.apiKey;
      headers['anthropic-version'] = profile.anthropicVersion ?? '2023-06-01';
    }
    const res = await fetch(`${base}/models`, { headers, signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const raw = json.data ?? json.models ?? json;
    return (Array.isArray(raw) ? raw : [])
      .map((m) => String(m.id ?? m.name ?? m.model ?? ''))
      .filter(Boolean);
  } catch (error) {
    throw new Error(`拉模型列表失败（${profile.baseUrl}）：${error?.message ?? error}`);
  }
}
