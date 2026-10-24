import test from 'node:test';
import assert from 'node:assert/strict';
import { buildConfig } from '../../src/oc-config.js';
import { modelProfileKeyEnv, resolveProfile } from '../../src/backends/providers.js';

test('custom model key env names are unique across platform and slot', () => {
  const envs = [
    modelProfileKeyEnv('qq', 'chat'),
    modelProfileKeyEnv('qq', 'work'),
    modelProfileKeyEnv('wechat', 'chat'),
    modelProfileKeyEnv('wechat', 'work')
  ];

  assert.equal(new Set(envs).size, 4);
  assert.deepEqual(envs, [
    'DHM_MODEL_QQ_CHAT_API_KEY',
    'DHM_MODEL_QQ_WORK_API_KEY',
    'DHM_MODEL_WECHAT_CHAT_API_KEY',
    'DHM_MODEL_WECHAT_WORK_API_KEY'
  ]);
});

test('custom relay slots resolve independent keys and preserve distinct chat/work endpoints', () => {
  const chatEnv = modelProfileKeyEnv('qq', 'chat');
  const workEnv = modelProfileKeyEnv('qq', 'work');
  const secrets = { [chatEnv]: 'chat-relay-secret', [workEnv]: 'work-relay-secret' };

  assert.equal(
    resolveProfile({ baseUrl: 'https://chat.example/v1', model: 'chat-model', apiKeyEnv: chatEnv }, secrets).apiKey,
    'chat-relay-secret'
  );
  assert.equal(
    resolveProfile({ baseUrl: 'https://work.example/v1', model: 'work-model', apiKeyEnv: workEnv }, secrets).apiKey,
    'work-relay-secret'
  );

  const { config } = buildConfig({
    base: {},
    pool: { free: ['bailian/qwen-plus'], paid: [] },
    persona: { 'qq-chat': 'chat persona', 'qq-chat-v2': 'chat persona' },
    workPersona: 'work persona',
    slots: {
      chat: { provider: 'custom', protocol: 'openai', baseUrl: 'https://chat.example/v1', model: 'chat-model', apiKeyEnv: chatEnv },
      work: { protocol: 'openai', baseUrl: 'https://work.example/v1', model: 'work-model', apiKeyEnv: workEnv }
    },
    agentTools: { enabled: false }
  });

  assert.equal(config.agents['qq-chat'].model, 'dhm-chat-relay/chat-model');
  assert.equal(config.agents['qq-work'].model, 'dhm-work-relay/work-model');
  assert.equal(config.provider['dhm-chat-relay'].options.baseURL, 'https://chat.example/v1');
  assert.equal(config.provider['dhm-work-relay'].options.baseURL, 'https://work.example/v1');
  assert.equal(config.provider['dhm-chat-relay'].options.apiKey, `{env:${chatEnv}}`);
  assert.equal(config.provider['dhm-work-relay'].options.apiKey, `{env:${workEnv}}`);
  assert.equal(JSON.stringify(config).includes('chat-relay-secret'), false);
  assert.equal(JSON.stringify(config).includes('work-relay-secret'), false);
});

test('a preset provider with slot-specific relay URLs gets separate OpenCode routing', () => {
  const chatEnv = modelProfileKeyEnv('qq', 'chat');
  const workEnv = modelProfileKeyEnv('qq', 'work');
  const { config } = buildConfig({
    base: {},
    pool: { free: ['bailian/qwen-plus'], paid: [] },
    persona: { 'qq-chat': 'chat persona', 'qq-chat-v2': 'chat persona' },
    workPersona: 'work persona',
    slots: {
      chat: {
        provider: 'openai',
        protocol: 'openai',
        baseUrl: 'https://chat-relay.example/v1',
        model: 'chat-model',
        apiKeyEnv: chatEnv
      },
      work: {
        provider: 'openai',
        protocol: 'openai',
        baseUrl: 'https://work-relay.example/v1',
        model: 'work-model',
        apiKeyEnv: workEnv
      }
    },
    agentTools: { enabled: false }
  });

  assert.equal(config.agents['qq-chat'].model, 'dhm-chat-relay/chat-model');
  assert.equal(config.agents['qq-work'].model, 'dhm-work-relay/work-model');
  assert.equal(config.provider['dhm-chat-relay'].options.baseURL, 'https://chat-relay.example/v1');
  assert.equal(config.provider['dhm-work-relay'].options.baseURL, 'https://work-relay.example/v1');
  assert.equal(config.provider['dhm-chat-relay'].options.apiKey, `{env:${chatEnv}}`);
  assert.equal(config.provider['dhm-work-relay'].options.apiKey, `{env:${workEnv}}`);
});
