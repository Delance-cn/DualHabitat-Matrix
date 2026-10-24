// 0.5.5：QQ / 微信双模型实例 + 按平台有效模型池的离线回归。
//
// 这个文件锁住四件事：
//   1. QQ 仍走 4599 / 根 opencode.json / `.oc/state`，老数据不用迁移；
//   2. 微信走 4601 / `.oc/wechat/opencode.json` / `.oc/wechat/state`；
//   3. 环境变量只影响它标明的平台，QQ 的旧 `QQ_BRIDGE_STATE_DIR` 不会串到微信；
//   4. 每个平台的自定义中转站会进自己的 provider 段，并被前置到该平台的有效模型池。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveModelInstance
} from '../src/oc-env.js';
import {
  assertConfig,
  buildConfig,
  effectiveModelPool,
  renderPersona
} from '../src/oc-config.js';

let pass = 0;
let fail = 0;
const ok = (name, condition, extra = '') => {
  if (condition) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${extra ? `  ← ${extra}` : ''}`);
  }
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dhm-dual-instance-'));
const config = {
  matrix: {
    stateDir: 'custom/qq-state',
    wechatStateDir: 'custom/wechat-state'
  }
};
const noEnv = {};
const persona = { 'qq-chat': 'p', 'qq-chat-v2': 'p2' };
const pool = { free: ['zhipuai/glm-4.5-flash#none'], paid: [] };

try {
  console.log('\n=== 1. 默认路径 / 端口按平台隔离 ===');
  const qq = resolveModelInstance('qq', { root, config, env: noEnv });
  const wx = resolveModelInstance('wechat', { root, config, env: noEnv });
  ok('QQ 端口仍是 4599', qq.port === 4599, String(qq.port));
  ok('微信端口是 4601', wx.port === 4601, String(wx.port));
  ok('QQ 配置在根目录 opencode.json', qq.configFile === path.join(root, 'opencode.json'), qq.configFile);
  ok('微信配置在 .oc/wechat/opencode.json', wx.configFile === path.join(root, '.oc', 'wechat', 'opencode.json'), wx.configFile);
  ok('QQ 状态目录读 matrix.stateDir', qq.stateDir === path.join(root, 'custom', 'qq-state'), qq.stateDir);
  ok('微信状态目录读 matrix.wechatStateDir', wx.stateDir === path.join(root, 'custom', 'wechat-state'), wx.stateDir);
  ok('QQ 数据目录仍是 .oc/data', qq.paths.data === path.join(root, '.oc', 'data'), qq.paths.data);
  ok('微信数据目录在 .oc/wechat/data', wx.paths.data === path.join(root, '.oc', 'wechat', 'data'), wx.paths.data);
  ok('注册文件跟着各自状态目录', qq.serviceFile === path.join(qq.stateDir, 'opencode', 'service.json') && wx.serviceFile === path.join(wx.stateDir, 'opencode', 'service.json'));
  ok('CF shim 仍是共享的 4600', qq.shim.port === 4600 && wx.shim.port === 4600);

  console.log('\n=== 2. 环境变量只影响它标明的平台 ===');
  const wechatEnv = {
    QQ_BRIDGE_MODEL_PLATFORM: 'wechat',
    QQ_BRIDGE_WECHAT_STATE_DIR: 'env/wechat-state'
  };
  const wxEnv = resolveModelInstance('wechat', { root, config, env: wechatEnv });
  const qqWithWxEnv = resolveModelInstance('qq', { root, config, env: wechatEnv });
  ok('微信吃 WECHAT_STATE_DIR', wxEnv.stateDir === path.join(root, 'env', 'wechat-state'), wxEnv.stateDir);
  ok('QQ 不会被微信环境变量带走', qqWithWxEnv.stateDir === path.join(root, 'custom', 'qq-state'), qqWithWxEnv.stateDir);

  const qqEnv = {
    QQ_BRIDGE_MODEL_PLATFORM: 'qq',
    QQ_BRIDGE_STATE_DIR: 'env/qq-state'
  };
  const qqWithQqEnv = resolveModelInstance('qq', { root, config, env: qqEnv });
  const wxWithQqEnv = resolveModelInstance('wechat', { root, config, env: qqEnv });
  ok('QQ 吃旧的 QQ_BRIDGE_STATE_DIR', qqWithQqEnv.stateDir === path.join(root, 'env', 'qq-state'), qqWithQqEnv.stateDir);
  ok('微信不会被 QQ 的旧变量带走', wxWithQqEnv.stateDir === path.join(root, 'custom', 'wechat-state'), wxWithQqEnv.stateDir);
  const wxWithOldQqEnv = resolveModelInstance('wechat', {
    root,
    config,
    env: { QQ_BRIDGE_MODEL_PLATFORM: 'wechat', QQ_BRIDGE_STATE_DIR: 'env/old-qq-state' }
  });
  ok('微信标了平台也不吃 QQ_BRIDGE_STATE_DIR', wxWithOldQqEnv.stateDir === path.join(root, 'custom', 'wechat-state'), wxWithOldQqEnv.stateDir);

  console.log('\n=== 3. 自定义中转站按平台写进自己的配置 ===');
  const qqRelay = 'https://qq-relay.example.com/v1';
  const wxRelay = 'https://wechat-relay.example.com/v1';
  const qqBuilt = buildConfig({
    base: {},
    pool,
    persona,
    workPersona: 'w',
    chatOnly: false,
    slots: { chat: { provider: '', model: 'gpt-4o-mini', baseUrl: qqRelay } },
    agentTools: { enabled: false },
    platform: 'qq',
    workdir: path.join(root, 'state', 'agents')
  }).config;
  const wxBuilt = buildConfig({
    base: {},
    pool,
    persona,
    workPersona: 'w',
    chatOnly: false,
    slots: { chat: { provider: '', model: 'gpt-4o-mini', baseUrl: wxRelay } },
    agentTools: { enabled: false },
    platform: 'wechat',
    workdir: path.join(root, '.oc', 'wechat')
  }).config;
  const relay = 'dhm-chat-relay';
  ok('QQ relay 用 QQ 的地址', qqBuilt.provider?.[relay]?.options?.baseURL === qqRelay, qqBuilt.provider?.[relay]?.options?.baseURL);
  ok('微信 relay 用微信的地址', wxBuilt.provider?.[relay]?.options?.baseURL === wxRelay, wxBuilt.provider?.[relay]?.options?.baseURL);
  ok('QQ 密钥环境变量按平台分档', qqBuilt.provider?.[relay]?.options?.apiKey === '{env:DHM_MODEL_QQ_CHAT_API_KEY}', qqBuilt.provider?.[relay]?.options?.apiKey);
  ok('微信密钥环境变量按平台分档', wxBuilt.provider?.[relay]?.options?.apiKey === '{env:DHM_MODEL_WECHAT_CHAT_API_KEY}', wxBuilt.provider?.[relay]?.options?.apiKey);
  ok('QQ agent 指到 relay', qqBuilt.agents?.['qq-chat']?.model === `${relay}/gpt-4o-mini`, qqBuilt.agents?.['qq-chat']?.model);
  ok('微信 agent 也指到 relay', wxBuilt.agents?.['qq-chat']?.model === `${relay}/gpt-4o-mini`, wxBuilt.agents?.['qq-chat']?.model);
  ok('QQ MCP 的 cwd 是 QQ 会话目录', qqBuilt.mcp?.servers?.['create-safe']?.cwd === path.join(root, 'state', 'agents'), qqBuilt.mcp?.servers?.['create-safe']?.cwd);
  ok('微信 MCP 的 cwd 是 .oc/wechat', wxBuilt.mcp?.servers?.['create-safe']?.cwd === path.join(root, '.oc', 'wechat'), wxBuilt.mcp?.servers?.['create-safe']?.cwd);

  console.log('\n=== 4. 有效模型池把中转站前置 ===');
  const slots = { chat: { provider: '', model: 'gpt-4o-mini', baseUrl: wxRelay } };
  const effective = effectiveModelPool(pool, slots, 'wechat');
  ok('中转站排在免费池最前面', effective.free[0] === `${relay}/gpt-4o-mini`, effective.free[0]);
  ok('原池子候选还在后面', effective.free.includes('zhipuai/glm-4.5-flash#none'));
  ok('池子关闭时不改（让 agent.model 生效）', effectiveModelPool({ ...pool, enabled: false }, slots, 'wechat').free[0] === 'zhipuai/glm-4.5-flash#none');
  ok('没有自定义档时原样返回', effectiveModelPool(pool, { chat: { provider: 'zhipuai', model: 'glm-4.5-flash' } }, 'qq') === pool);

  console.log('\n=== 5. 人设按平台换称呼 ===');
  const wxPersona = renderPersona(
    { prefix: 'You are a coding agent powered by the X model.', suffix: 'cwd={{cwd}}' },
    { model: 'm', cwd: '/tmp', platform: 'wechat' }
  );
  const qqPersona = renderPersona(
    { prefix: 'You are a coding agent powered by the X model.', suffix: 'cwd={{cwd}}' },
    { model: 'm', cwd: '/tmp', platform: 'qq' }
  );
  ok('微信人设说 WeChat', wxPersona.includes('chatting with people on WeChat'), wxPersona);
  ok('QQ 人设仍说 QQ', qqPersona.includes('chatting with people on QQ'), qqPersona);

  console.log('\n=== 6. 运行中实例的模型对象也能校验 ===');
  const liveProblems = assertConfig(
    { agents: { 'qq-chat': { model: 'dhm-chat-relay/qq-model' } }, permissions: [] },
    {
      agents: ['qq-chat'],
      agentConfigs: { 'qq-chat': { model: { providerID: 'dhm-chat-relay', model: 'qq-model' } } },
      permissions: [{ action: '*', resource: '*', effect: 'deny' }]
    }
  );
  ok('agent.model 对象与字符串等价比较', liveProblems.length === 0, liveProblems.join('；'));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
