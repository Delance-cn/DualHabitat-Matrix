import test from 'node:test';
import assert from 'node:assert/strict';
import { assertConfig, buildConfig, extractLiveConfig } from '../../src/oc-config.js';
import { SHIM_BASE_URL } from '../../src/oc-env.js';

const personas = { 'qq-chat': 'chat persona', 'qq-chat-v2': 'chat persona' };

function buildWithProvider(provider, model) {
  return buildConfig({
    base: {},
    pool: { free: ['bailian/qwen-plus'], paid: [] },
    persona: personas,
    workPersona: '',
    slots: { chat: { provider, model } },
    agentTools: { enabled: false }
  });
}

test('maps UI provider IDs to OpenCode built-in provider IDs', () => {
  const zhipu = buildWithProvider('zhipu', 'glm-4.5-flash#none').config;
  const gemini = buildWithProvider('gemini', 'gemini-2.5-flash').config;

  assert.equal(zhipu.agents['qq-chat'].model, 'zhipuai/glm-4.5-flash');
  assert.equal(gemini.agents['qq-chat'].model, 'google/gemini-2.5-flash');
});

test('generates OpenAI-compatible provider definitions for MiniMax and Volcengine', () => {
  const minimax = buildWithProvider('minimax', 'abab6.5s-chat').config.provider.minimax;
  const volcengine = buildWithProvider('volcengine', 'doubao-pro-32k').config.provider.volcengine;

  assert.equal(minimax.options.baseURL, 'https://api.minimax.chat/v1');
  assert.equal(minimax.options.apiKey, '{env:MINIMAX_API_KEY}');
  assert.equal(minimax.models['abab6.5s-chat'].name, 'abab6.5s-chat');
  assert.equal(volcengine.options.baseURL, 'https://ark.cn-beijing.volces.com/api/v3');
  assert.equal(volcengine.options.apiKey, '{env:ARK_API_KEY}');
  assert.equal(volcengine.models['doubao-pro-32k'].name, 'doubao-pro-32k');
  assert.equal(volcengine.name, '火山方舟（豆包）');
});

test('supports object-form pool candidates for the default model and Cloudflare shim', () => {
  const { config } = buildConfig({
    base: {},
    pool: {
      free: [{ provider: 'cloudflare-workers-ai', model: '@cf/meta/llama-3.1#fast' }],
      paid: []
    },
    persona: personas,
    workPersona: '',
    agentTools: { enabled: false }
  });

  assert.equal(config.model, 'cloudflare-workers-ai/@cf/meta/llama-3.1');
  assert.equal(config.provider['cloudflare-workers-ai'].options.baseURL, SHIM_BASE_URL);
});

test('live config assertion detects stale agents and permission rules', () => {
  const { config } = buildConfig({
    base: {},
    pool: { free: ['bailian/qwen-plus'], paid: [] },
    persona: personas,
    workPersona: 'work persona',
    chatOnly: true
  });

  test('extracts the generated configuration document from config.get entries', () => {
    const config = { agents: { 'qq-chat': {} }, permissions: [] };
    const found = extractLiveConfig([
      { type: 'directory', path: 'C:\\state\\opencode' },
      { type: 'document', path: 'C:\\work\\opencode.json', info: config }
    ], 'c:\\work\\opencode.json');
    assert.equal(found, config);
    assert.equal(extractLiveConfig([{ type: 'document', path: 'C:\\other\\opencode.json', info: config }], 'C:\\work\\opencode.json'), null);
  });
  const agentConfigs = Object.fromEntries(Object.entries(config.agents).map(([id, agent]) => [id, agent]));
  const live = {
    agents: Object.keys(config.agents),
    agentConfigs,
    permissions: config.permissions
  };
  assert.deepEqual(assertConfig(config, live), []);
  assert.match(assertConfig(config, { ...live, agents: [] }).join('\n'), /qq-chat/);
  assert.match(assertConfig(config, { ...live, permissions: [{ action: '*', resource: '*', effect: 'allow' }] }).join('\n'), /不一致|兜底/);
});
