/**
 * 桌面端新接口的离线探针。
 *
 * 为什么单独起一个实例：活着的那个桌面服务（3200）正带着用户的桥接和 NapCat，
 * 拿它试写接口风险太大。这里要求你在另一个端口上起一个临时实例，只碰读接口和
 * 不启停进程的写接口。
 *
 * 用法：
 *   $env:DHM_DESKTOP_PORT="3299"; node server.mjs   # 另开一个窗口
 *   node spike/probe-desktop-api.mjs 3299
 */

const PORT = process.argv[2] ?? '3299';
const base = `http://127.0.0.1:${PORT}`;

let pass = 0;
let fail = 0;

function check(name, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

async function get(path) {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function post(path, payload) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

console.log(`\n探针目标：${base}\n`);

/* ── 1. 读接口 ─────────────────────────────────────────────── */

console.log('【读接口】');

const state = await get('/api/state');
check('GET /api/state 200', state.status === 200, `status ${state.status}`);
check('state 带 opencode 实例信息', state.body?.opencode && 'alive' in state.body.opencode, JSON.stringify(state.body?.opencode));
check('state 带 modelsPath', typeof state.body?.modelsPath === 'string', String(state.body?.modelsPath));

const oc = await get('/api/opencode');
check('GET /api/opencode 200', oc.status === 200);
check('opencode 有 6 个字段', ['baseUrl', 'stateDir', 'deleteArchived', 'sessionCwd', 'agentPreset', 'workspaceTitle'].every((k) => k in (oc.body ?? {})), Object.keys(oc.body ?? {}).join(','));
check('会话目录非空（否则建会话会被拒）', Boolean(oc.body?.sessionCwd), String(oc.body?.sessionCwd));

const pool = await get('/api/model-pool');
check('GET /api/model-pool 200', pool.status === 200);
check('模型池有免费档', (pool.body?.free?.length ?? 0) > 0, `free=${pool.body?.free?.length}`);
check('池头是 bailian/qwen3.8-max', pool.body?.free?.[0] === 'bailian/qwen3.8-max', String(pool.body?.free?.[0]));
check('耗尽提示是人话（不是错误码）', typeof pool.body?.exhaustedNotice === 'string' && pool.body.exhaustedNotice.length > 0 && !/^\d{3}[A-Z]+$/.test(pool.body.exhaustedNotice), String(pool.body?.exhaustedNotice));

const options = await get('/api/options');
check('GET /api/options 200', options.status === 200);
const groupIds = (options.body?.groups ?? []).map((g) => g.id);
check('设置分组齐全', ['rhythm', 'social', 'socialV2', 'sticker', 'voice', 'slang', 'gateway', 'security'].every((g) => groupIds.includes(g)), groupIds.join(','));
const itemCount = (options.body?.groups ?? []).reduce((n, g) => n + g.items.length, 0);
check(`设置项够多（${itemCount} 项）`, itemCount >= 40, `只给了 ${itemCount} 项`);
const values = options.body?.values ?? {};
check('值也读出来了（不是空对象）', Object.keys(values).length > 20, `${Object.keys(values).length} 个有值`);
check('嵌套路径能读到', values['socialV2.wake.defaultMode'] !== undefined, JSON.stringify(values['socialV2.wake.defaultMode']));
check('数组能读到', Array.isArray(values['slang.inferenceThresholds']), JSON.stringify(values['slang.inferenceThresholds']));

const chat = await get('/api/chat');
check('GET /api/chat 200', chat.status === 200);
check('默认是放行所有人（mode=all）', chat.body?.mode === 'all', `mode=${chat.body?.mode}`);
check('白名单已清掉 * 通配符', !(chat.body?.allow?.private ?? []).includes('*'), JSON.stringify(chat.body?.allow));
check('黑名单字段存在', Array.isArray(chat.body?.deny?.private), JSON.stringify(chat.body?.deny));

const settings = await get('/api/settings');
check('GET /api/settings 200', settings.status === 200);
check('napcat 带 httpPort', 'httpPort' in (settings.body?.napcat ?? {}), JSON.stringify(settings.body?.napcat));

/* ── 2. 写接口（不改语义，写完读回来再还原） ───────────────── */

console.log('\n【写接口】');

// 2.1 allowAllWhenEmpty 往返：切到白名单模式再切回来
const before = chat.body;
await post('/api/chat', {
  allowAllWhenEmpty: false,
  allow: { private: ['12345', '12345', ' 6789 '], groups: ['*'] },
  deny: { private: ['999'], groups: [] }
});
const afterList = (await get('/api/chat')).body;
check('切到白名单模式生效', afterList.mode === 'list', `mode=${afterList.mode}`);
check('白名单去重 + 去空格', JSON.stringify(afterList.allow.private) === JSON.stringify(['12345', '6789']), JSON.stringify(afterList.allow.private));
check('写进去的 * 被摘掉了', !afterList.allow.groups.includes('*'), JSON.stringify(afterList.allow.groups));
check('黑名单存住了', JSON.stringify(afterList.deny.private) === JSON.stringify(['999']), JSON.stringify(afterList.deny.private));

// 还原
await post('/api/chat', {
  allowAllWhenEmpty: true,
  allow: { private: [], groups: [] },
  deny: { private: [], groups: [] }
});
const restored = (await get('/api/chat')).body;
check('还原成放行所有人', restored.mode === 'all' && restored.deny.private.length === 0, JSON.stringify(restored));

// 2.2 设置页：写一项、读回来、再写 null 删掉
const probePath = 'socialV2.sticker.promptMaxStickers';
const original = values[probePath];
const write = await post('/api/options', { values: { [probePath]: 42 } });
check('POST /api/options 报告改了 1 项', write.body?.changed === 1, JSON.stringify(write.body));
const reread = (await get('/api/options')).body.values[probePath];
check('设置值写进去了', reread === 42, String(reread));
await post('/api/options', { values: { [probePath]: original } });
check('设置值还原了', (await get('/api/options')).body.values[probePath] === original, String(original));

// 2.3 不认识的路径必须被拒（防手改请求写坏 config.json）
const bad = await post('/api/options', { values: { 'ownerQQ': 999, 'socialV2.__proto__.polluted': true } });
check('未知路径被忽略', bad.body?.changed === 0 && (await get('/api/chat')).body.ownerQQ !== 999, JSON.stringify(bad.body));

// 2.4 opencode 往返
await post('/api/opencode', {
  baseUrl: oc.body.baseUrl,
  stateDir: oc.body.stateDir,
  deleteArchived: oc.body.deleteArchived,
  sessionCwd: oc.body.sessionCwd,
  agentPreset: 'qq-chat-v2',
  workspaceTitle: '探针标题'
});
const oc2 = (await get('/api/opencode')).body;
check('agentPreset 往返', oc2.agentPreset === 'qq-chat-v2', oc2.agentPreset);
check('workspaceTitle 往返', oc2.workspaceTitle === '探针标题', oc2.workspaceTitle);
await post('/api/opencode', {
  baseUrl: oc.body.baseUrl,
  stateDir: oc.body.stateDir,
  deleteArchived: oc.body.deleteArchived,
  sessionCwd: oc.body.sessionCwd,
  agentPreset: oc.body.agentPreset,
  workspaceTitle: oc.body.workspaceTitle
});
const oc3 = (await get('/api/opencode')).body;
check('opencode 设置已还原', oc3.agentPreset === oc.body.agentPreset && oc3.workspaceTitle === oc.body.workspaceTitle, `${oc3.agentPreset} / ${oc3.workspaceTitle}`);

// 2.5 本机探测：CLI 装没装 + 本地模型服务
const drivers = state.body?.cliDrivers ?? [];
check('state 带 cliDrivers', Array.isArray(drivers) && drivers.length > 0, `${drivers.length} 个`);
check(
  '每个驱动都带「装没装」',
  drivers.every((d) => typeof d.installed === 'boolean' && 'optionsSchema' in d && 'promptVia' in d),
  JSON.stringify(drivers[0] ?? null)
);
check(
  'Kiro / Cline 在驱动表里',
  ['kiro-cli', 'cline-cli'].every((id) => drivers.some((d) => d.id === id)),
  drivers.map((d) => d.id).join(',')
);

const locals = state.body?.localModelServers ?? [];
check('state 带 localModelServers', Array.isArray(locals) && locals.length >= 4, `${locals.length} 个`);
check(
  '本地服务项带 running / baseUrl',
  locals.every((s) => typeof s.running === 'boolean' && String(s.baseUrl ?? '').startsWith('http://127.0.0.1:')),
  JSON.stringify(locals[0] ?? null)
);
check(
  '本地服务项带 installed（装了没启动也能看出来）',
  locals.every((s) => typeof s.installed === 'boolean'),
  JSON.stringify(locals.map((s) => `${s.label}:${s.installed ? '有' : '无'}`))
);

// 2.6 后端落盘校验：跑不起来的一律不写
const originalBackend = state.body?.backend ?? null;

const badDriver = await post('/api/backend', { backend: { type: 'cli', cli: { driver: 'does-not-exist' } } });
check('未知驱动被拒', badDriver.body?.ok === false, JSON.stringify(badDriver.body));

const badModel = await post('/api/backend', { backend: { type: 'model-api', modelApi: { model: 'x' } } });
check('缺 baseUrl 的直连后端被拒', badModel.body?.ok === false, JSON.stringify(badModel.body));

const badCustom = await post('/api/backend', {
  backend: { type: 'cli', cli: { customDriver: { id: 'x', bin: 'C:\\definitely\\not\\here.exe' } } }
});
check('不存在的自定义 bin 被拒', badCustom.body?.ok === false, JSON.stringify(badCustom.body));

const missing = drivers.find((d) => d.id !== 'custom' && d.installed === false && d.bin);
if (missing) {
  const r = await post('/api/backend', { backend: { type: 'cli', cli: { driver: missing.id } } });
  check(`没装的驱动被拒（${missing.id}）`, r.body?.ok === false, JSON.stringify(r.body));
} else {
  check('没装的驱动被拒（本机全装了，跳过）', true, '');
}

const badType = await post('/api/backend', { backend: { type: 'nonsense' } });
check('未知后端类型被拒', badType.body?.ok === false, JSON.stringify(badType.body));

const stillOriginal = (await get('/api/state')).body?.backend ?? null;
check(
  '被拒的写入没有污染 config',
  JSON.stringify(stillOriginal) === JSON.stringify(originalBackend),
  JSON.stringify(stillOriginal)
);

const goodModel = await post('/api/backend', {
  backend: { type: 'model-api', modelApi: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b' } }
});
check('完整的直连后端能保存', goodModel.body?.ok === true, JSON.stringify(goodModel.body));
const afterGood = (await get('/api/state')).body?.backend ?? null;
check('保存后读回来是这个后端', afterGood?.type === 'model-api' && afterGood?.modelApi?.model === 'qwen2.5:7b', JSON.stringify(afterGood));

await post('/api/backend', { backend: originalBackend });
const restoredBackend = (await get('/api/state')).body?.backend ?? null;
check('后端设置已还原', JSON.stringify(restoredBackend) === JSON.stringify(originalBackend), JSON.stringify(restoredBackend));

/* ── 3. 静态资源 ──────────────────────────────────────────── */

console.log('\n【静态资源】');

for (const file of ['/index.html', '/app.js', '/style.css']) {
  const res = await fetch(`${base}${file}`);
  const text = await res.text();
  check(`${file} 可访问且非空`, res.status === 200 && text.length > 500, `${res.status} / ${text.length} 字节`);
}

const html = await (await fetch(`${base}/index.html`)).text();
check('HTML 有设置页签', html.includes('data-tab="options"'), '');
check('HTML 有黑名单输入框', html.includes('id="denyPrivate"') && html.includes('id="denyGroups"'), '');
check('HTML 有模型池', html.includes('id="pool-free"') && html.includes('id="pool-paid"'), '');
check('HTML 有主题开关', html.includes('id="btn-theme"'), '');
check('HTML 默认不写 data-theme（浅色是默认）', !/<html[^>]*data-theme/.test(html), '');
check('HTML 有本机模型服务列表', html.includes('id="local-servers"'), '');
check('HTML 有只读工具开关', html.includes('id="modelAllowTools"'), '');
check('HTML 有驱动参数容器', html.includes('id="cli-options"'), '');
check('HTML 有「启用这条后端」入口', html.includes('id="btn-use-oc"'), '');
check('HTML 卡片不再声称直连后端「无工具」', !html.includes('最快 · 无工具'), '');

const css = await (await fetch(`${base}/style.css`)).text();
check('CSS 有浅色变量', css.includes('--bg: #ffffff'), '');
check('CSS 有深色覆盖', css.includes('[data-theme="dark"]'), '');
check('CSS 定义了模型池样式', css.includes('.pool-row') && css.includes('.pool-add'), '');
check('CSS 定义了设置页样式', css.includes('.opt-title') && css.includes('.opt-check'), '');

const js = await (await fetch(`${base}/app.js`)).text();
check('JS 认服务端给的 mode', js.includes("chat.mode === 'list'"), '');
check('JS 有 schema 渲染器', js.includes('renderOptions') && js.includes('renderOption'), '');
check('JS 有主题切换', js.includes('applyTheme'), '');
check('JS 有本机探测渲染', js.includes('renderLocalServers'), '');
check('JS 按 optionsSchema 收驱动参数', js.includes('collectCliOptions'), '');
check('JS 有「当前生效」标记', js.includes('markActiveType'), '');
check('JS 卡片点击不再写 backend', !js.includes("card.dataset.type === 'opencode' ? null :"), '');

/* ── 结果 ─────────────────────────────────────────────────── */

console.log(`\n${fail === 0 ? '🎉' : '❌'} ${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
