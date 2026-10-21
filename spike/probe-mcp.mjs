// 探针：实测 OpenCode 2.0.32 里 **MCP 工具的权限动作名**与三种可见性语义。
//
// 为什么必须实测（不能照文档猜）：配置生成器（②）要按动作名写白名单，
// 而猜错的失败模式特别隐蔽 —— 所有 QQ 工具一起从模型的 schema 里消失，
// 机器人照样能聊天、不报任何错，但一个群功能都用不了。
//
// 跑法：node spike/probe-mcp.mjs a|b|c|d|restore|all
//   a       挂 MCP、不写权限      → 探命名空间/工具名（顺带看 execute 是否默认可见）
//   b       兜底 deny + 放行 MCP  → 验证"白名单"写法有效（生成器将采用的形状）
//   c       只有兜底 deny         → 验证"工具彻底消失"这条（DSH 的 L7 铁律靠它）
//   d       定义自定义 agent      → 验证启动读回断言（agent.list/agent.get）可用
//   g       沙箱能力边界          → execute 里能不能 fetch / 碰文件 / 起进程
//   h       codemode:false       → MCP 工具能否绕过沙箱成为**直接工具**（决定要不要禁 execute）
//   restore 还原 opencode.json 并重启
// 会临时改写 opencode.json，结束时（含异常）还原。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { CONFIG_FILE, PATHS, ROOT, SERVICE_FILE } from '../src/oc-env.js';
import { ensureServer } from '../src/oc-server.js';
import { NodeApiClient, createTurnCollector, unwrap } from '../src/oc-client.js';

const BACKUP = `${CONFIG_FILE}.probe-backup`;
const FIXTURE = path.join(ROOT, 'spike', 'mcp-fixture.mjs');
const WORK_DIR = path.join(ROOT, '.oc', 'work', 'mcp-probe');
const MCP = { qqtest: { type: 'local', command: ['node', FIXTURE] } };

fs.mkdirSync(WORK_DIR, { recursive: true });
if (!fs.existsSync(BACKUP)) fs.copyFileSync(CONFIG_FILE, BACKUP);

function restore() {
  if (fs.existsSync(BACKUP)) {
    fs.copyFileSync(BACKUP, CONFIG_FILE);
    fs.rmSync(BACKUP, { force: true });
  }
}
process.on('exit', restore);
process.on('SIGINT', () => {
  restore();
  process.exit(130);
});

function writeConfig(extra = {}) {
  const config = {
    $schema: 'https://opencode.ai/config.json',
    model: 'zhipuai/glm-4.5-flash',
    update: 'disable',
    mcp: MCP,
    ...extra
  };
  fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

const api = (tag) =>
  new NodeApiClient(undefined, undefined, {
    stateDir: PATHS.state,
    sessionDir: path.join(ROOT, '.oc', 'state', `mcp-probe-${tag}`),
    models: { enabled: false },
    log: (m) => console.log(`    [client] ${m}`)
  });

async function runTurn(tag, prompt, { timeoutMs = 45_000, agent, workspace, content, model } = {}) {
  const client = api(tag);
  const ws = unwrap(await client.workspace.create({ path: workspace ?? WORK_DIR }), 'workspace.create');
  const created = unwrap(
    await client.sessions.create({ workspaceId: ws.workspace.workspaceId, mode: agent }),
    'sessions.create'
  );
  const sessionId = created.sessionId;
  const pick = model ?? { provider: 'zhipuai', model: 'glm-4.5-flash', reasoningEffort: 'none' };
  unwrap(await client.sessions.selectModel({ sessionId, ...pick }), 'selectModel');

  const collector = createTurnCollector();
  const calls = [];
  const results = [];
  const errors = [];
  let resolveTurn = null;
  const done = new Promise((r) => {
    resolveTurn = r;
  });

  const mux = (async () => {
    for await (const envelope of client.events.mux()) {
      if (envelope.payload.type !== 'session/event') continue;
      const e = envelope.payload.event;
      if (e.type === 'tool/call') calls.push(e.data);
      if (e.type === 'tool/result') results.push(e.data);
      if (e.type === 'stream/error') errors.push(e.data);
      const ended = collector.push(e);
      if (ended) resolveTurn(ended);
    }
  })().catch(() => {});

  await new Promise((r) => setTimeout(r, 600));
  await client.sessions.prompt({
    sessionId,
    mode: 'queue',
    content: content ?? [{ type: 'text', text: prompt }]
  });
  const ended = await Promise.race([
    done,
    new Promise((r) => setTimeout(() => r({ text: '', reason: { kind: 'timeout' } }), timeoutMs))
  ]);
  mux.catch(() => {});
  return { ended, calls, results, errors };
}

function report(label, turn) {
  console.log(`    ${label} 结束=${turn.ended?.reason?.kind}  文本=${JSON.stringify((turn.ended?.text ?? '').slice(0, 400))}`);
  for (const c of turn.calls) {
    console.log(`    ${label} [call] ${c.name} ${JSON.stringify(c.arguments).slice(0, 700)}`);
  }
  for (const r of turn.results) {
    const txt = (r.message?.content ?? [])
      .map((x) => (typeof x.text === 'string' ? x.text : x.text ? JSON.stringify(x.text) : ''))
      .join(' ')
      .slice(0, 500);
    console.log(`    ${label} [result] isError=${r.message?.isError} ${JSON.stringify(txt)}`);
    if (r.message?.isError) console.log(`    ${label} [result-raw] ${JSON.stringify(r.message).slice(0, 700)}`);
  }
  for (const e of turn.errors) console.log(`    ${label} [error] ${JSON.stringify(e).slice(0, 300)}`);
}

const PROBE_CODE =
  "用 execute 工具原样运行下面这段代码（不要改写、不要探索、不要调用别的工具），" +
  "把 console 输出原样贴回来，然后立刻结束这一回合：\n" +
  "```js\n" +
  "console.log('NAMESPACES=' + JSON.stringify(Object.keys(tools)));\n" +
  "const out = {};\n" +
  "if (tools.qqtest) {\n" +
  "  for (const n of Object.keys(tools.qqtest)) {\n" +
  "    try { out[n] = await tools.qqtest[n](n === 'echo_check' ? { text: 'hi' } : {}); }\n" +
  "    catch (e) { out[n] = 'ERR:' + (e && e.message || e); }\n" +
  "  }\n" +
  "}\n" +
  "console.log('QQTEST_CALLS=' + JSON.stringify(out));\n" +
  "```";

async function phaseA() {
  console.log('=== A. 挂 MCP、**不写任何权限**（官方基础全放行）===');
  writeConfig({});
  await ensureServer({ force: true, withShim: false, log: (m) => console.log(`    [server] ${m}`) });
  report('A', await runTurn('a', PROBE_CODE));
}

async function phaseB() {
  console.log('\n=== B. deny 兜底 + 放行 execute 与 qqtest_ping / qqtest_echo_check ===');
  writeConfig({
    permissions: [
      { action: '*', resource: '*', effect: 'deny' },
      { action: 'execute', resource: '*', effect: 'allow' },
      { action: 'qqtest_ping', resource: '*', effect: 'allow' },
      { action: 'qqtest_echo_check', resource: '*', effect: 'allow' }
    ]
  });
  await ensureServer({ force: true, withShim: false, log: (m) => console.log(`    [server] ${m}`) });
  report('B', await runTurn('b', PROBE_CODE));
}

async function phaseC() {
  console.log('\n=== C. deny 兜底 + 只放行 execute（MCP 工具应不可见）===');
  writeConfig({
    permissions: [
      { action: '*', resource: '*', effect: 'deny' },
      { action: 'execute', resource: '*', effect: 'allow' }
    ]
  });
  await ensureServer({ force: true, withShim: false, log: (m) => console.log(`    [server] ${m}`) });
  report('C', await runTurn('c', PROBE_CODE));
}

async function phaseD() {
  console.log('\n=== D. 定义自定义 agent，验证启动读回断言 ===');
  writeConfig({
    agents: {
      probechat: {
        mode: 'primary',
        description: '探针用自定义 agent',
        system: '你是一个探针 agent。',
        permissions: [
          { action: '*', resource: '*', effect: 'deny' },
          { action: 'qqtest_ping', resource: '*', effect: 'allow' }
        ]
      }
    }
  });
  await ensureServer({ force: true, withShim: false, log: (m) => console.log(`    [server] ${m}`) });
  const client = await (async () => {
    const { OpenCode } = await import('@opencode/client');
    const { Service } = await import('@opencode/client/service');
    const ep = await Service.discover({ file: SERVICE_FILE });
    return OpenCode.make({ baseUrl: ep.url, headers: Service.headers(ep) });
  })();
  const list = await client.agent.list({ location: { directory: ROOT } });
  console.log('    agent.list:', JSON.stringify(list?.data ?? list).slice(0, 1500));
  for (const id of ['probechat', 'build', 'general']) {
    try {
      const got = await client.agent.get({ id, location: { directory: ROOT } });
      console.log(`    agent.get(${id}):`, JSON.stringify(got?.data ?? got).slice(0, 1500));
    } catch (e) {
      console.log(`    agent.get(${id}) 失败: ${e.message}`);
    }
  }
}

async function phaseE() {
  console.log('\n=== E. deny 兜底 + 只放行 qqtest：试探 browser/opencode 命名空间是否真被拦 ===');
  writeConfig({
    permissions: [
      { action: '*', resource: '*', effect: 'deny' },
      { action: 'execute', resource: '*', effect: 'allow' },
      { action: 'qqtest_ping', resource: '*', effect: 'allow' },
      { action: 'qqtest_echo_check', resource: '*', effect: 'allow' }
    ]
  });
  await ensureServer({ force: true, withShim: false, log: (m) => console.log(`    [server] ${m}`) });
  const code = [
    "const OUT = {};",
    "console.log('NAMESPACES=' + JSON.stringify(Object.keys(tools)));",
    "const clip = (v) => String(v).slice(0, 220);",
    "try { OUT.browser_tabs_list = clip(JSON.stringify(await tools.browser.tabs.list())); } catch (e) { OUT.browser_tabs_list = 'ERR:' + (e && e.message || e); }",
    "try { OUT.opencode_models = clip(JSON.stringify(await tools.opencode.models({ query: 'zzz' }))); } catch (e) { OUT.opencode_models = 'ERR:' + (e && e.message || e); }",
    "try { OUT.qqtest_ping = clip(JSON.stringify(await tools.qqtest.ping({}))); } catch (e) { OUT.qqtest_ping = 'ERR:' + (e && e.message || e); }",
    "console.log('OUT=' + JSON.stringify(OUT));"
  ].join('\n');
  const prompt =
    '用 execute 工具原样运行下面这段代码（不要改写、不要探索），把 console 输出原样贴回来，然后立刻结束：\n```js\n' +
    code +
    '\n```';
  report('E', await runTurn('e', prompt, { timeoutMs: 60_000 }));
}

async function phaseF() {
  console.log('\n=== F. deny 兜底 + 放行 execute + **前缀通配** qqtest_* ===');
  writeConfig({
    permissions: [
      { action: '*', resource: '*', effect: 'deny' },
      { action: 'execute', resource: '*', effect: 'allow' },
      { action: 'qqtest_*', resource: '*', effect: 'allow' }
    ]
  });
  await ensureServer({ force: true, withShim: false, log: (m) => console.log(`    [server] ${m}`) });
  report('F', await runTurn('f', PROBE_CODE, { timeoutMs: 60_000 }));
}

async function phaseG() {
  console.log('\n=== G. 沙箱能力边界：execute 里有没有 fetch / process / 文件访问 ===');
  writeConfig({
    permissions: [
      { action: '*', resource: '*', effect: 'deny' },
      { action: 'execute', resource: '*', effect: 'allow' },
      { action: 'qqtest_*', resource: '*', effect: 'allow' }
    ]
  });
  await ensureServer({ force: true, withShim: false, log: (m) => console.log(`    [server] ${m}`) });
  const code = [
    "const G = {};",
    "const E = (e) => 'ERR:' + (e && e.message || String(e));",
    "try { G.fetch = typeof fetch; } catch (e) { G.fetch = E(e); }",
    "try { G.process = typeof process; } catch (e) { G.process = E(e); }",
    "try { G.require = typeof require; } catch (e) { G.require = E(e); }",
    "try { G.module = typeof module; } catch (e) { G.module = E(e); }",
    "try { G.Buffer = typeof Buffer; } catch (e) { G.Buffer = E(e); }",
    "try { G.setTimeout = typeof setTimeout; } catch (e) { G.setTimeout = E(e); }",
    "try { G.WebSocket = typeof WebSocket; } catch (e) { G.WebSocket = E(e); }",
    "try { G.console = typeof console; } catch (e) { G.console = E(e); }",
    "try { G.tools = typeof tools; } catch (e) { G.tools = E(e); }",
    "try { G.fetchCall = String((await fetch('http://127.0.0.1:4599/config')).status); } catch (e) { G.fetchCall = E(e); }",
    "try { const m = await import('node:fs'); G.importFs = typeof m.readFileSync; } catch (e) { G.importFs = E(e); }",
    "try { G.bufferHex = Buffer.from('hi').toString('hex'); } catch (e) { G.bufferHex = E(e); }",
    "try { G.procCwd = process.cwd(); } catch (e) { G.procCwd = E(e); }",
    "try { G.ctor = ({}).constructor.constructor('return 1')(); } catch (e) { G.ctor = E(e); }",
    "console.log('G=' + JSON.stringify(G));"
  ].join('\n');
  const prompt =
    '用 execute 工具原样运行下面这段代码（不要改写、不要探索），把 console 输出原样贴回来，然后立刻结束：\n```js\n' +
    code +
    '\n```';
  report('G', await runTurn('g', prompt, { timeoutMs: 60_000 }));
}

async function phaseH() {
  console.log('\n=== H. codemode:false 能否把 MCP 工具变成**直接工具**（从而整条禁掉 execute）===');
  console.log('    动因：阶段 G 证明 execute 沙箱虽无文件/进程，但**有 fetch（任意出网）**。');
  console.log('    若 codemode:false 能让 MCP 工具不经沙箱直接暴露，就能 deny 掉 execute，');
  console.log('    权限语义与 DSH 完全一致，且不给模型裸 fetch。');
  const PROMPT =
    '请直接调用 qqtest 的 ping 工具（参数为空对象），把返回值原样贴回来。\n' +
    '如果你**看不到任何可用工具**，请只回复：NO_TOOLS\n' +
    '不要使用 execute，不要写代码，不要解释。';
  for (const codemode of [false, true]) {
    console.log(`\n  ── codemode=${codemode}，且**不放行 execute** ──`);
    writeConfig({
      // 新形状才认 codemode：mcp.servers.<名字>（旧的 mcp.<名字> 已废弃）
      mcp: { servers: { qqtest: { type: 'local', command: ['node', FIXTURE], codemode } } },
      permissions: [
        { action: '*', resource: '*', effect: 'deny' },
        { action: 'qqtest_*', resource: '*', effect: 'allow' }
      ]
    });
    await ensureServer({ force: true, withShim: false, log: (m) => console.log(`    [server] ${m}`) });
    report(`H(codemode=${codemode})`, await runTurn(`h-${codemode}`, PROMPT, { timeoutMs: 60_000 }));
  }
}

async function phaseI() {
  console.log('\n=== I. 内置工具面：tools.opencode / tools.browser 里到底有什么 ===');
  console.log('    动因：要给"所有者"档文件/命令权限，必须先知道 read/write/shell 这些');
  console.log('    是直接工具、还是只能经 execute 沙箱的 opencode.* 命名空间拿到。');
  writeConfig({
    permissions: [
      { action: '*', resource: '*', effect: 'deny' },
      { action: 'execute', resource: '*', effect: 'allow' },
      { action: 'opencode_*', resource: '*', effect: 'allow' }
    ]
  });
  await ensureServer({ force: true, withShim: false, log: (m) => console.log(`    [server] ${m}`) });
  const code = [
    'const R = { namespaces: Object.keys(tools) };',
    'const dump = (ns) => {',
    '  const t = tools[ns];',
    '  if (!t) return null;',
    '  const out = {};',
    '  for (const k of Object.keys(t)) {',
    '    const f = t[k];',
    '    const meta = { type: typeof f };',
    '    try { if (f && f.description) meta.desc = String(f.description).slice(0, 140); } catch (e) {}',
    '    try { if (f && f.parameters) meta.params = JSON.stringify(f.parameters).slice(0, 500); } catch (e) {}',
    '    try { if (f && f.inputSchema) meta.input = JSON.stringify(f.inputSchema).slice(0, 500); } catch (e) {}',
    '    try { meta.props = Object.keys(f).slice(0, 14); } catch (e) {}',
    '    out[k] = meta;',
    '  }',
    '  return out;',
    '};',
    "R.opencode = dump('opencode');",
    "R.browser = dump('browser');",
    "console.log('DUMP=' + JSON.stringify(R).slice(0, 9000));"
  ].join('\n');
  const prompt =
    '用 execute 工具原样运行下面这段代码（不要改写、不要探索），把 console 输出原样贴回来，然后立刻结束：\n```js\n' +
    code +
    '\n```';
  report('I', await runTurn('i', prompt, { timeoutMs: 90_000 }));
}

async function phaseJ() {
  console.log('\n=== J. 所有者档：内置 read/shell 是不是**直接工具**（不靠 execute）===');
  console.log('    动因：用户要"我能干活、别人只能聊天"。若 read/write/shell 是直接工具，');
  console.log('    所有者档就能 deny 掉 execute（不给模型裸 fetch），只放行文件与命令。');
  const TARGET = path.join(ROOT, 'package.json');
  const MARKER = path.join(WORK_DIR, 'marker.txt');
  fs.writeFileSync(MARKER, 'marker-j3-value\n', 'utf8');
  const READ_ONLY = [
    { action: '*', resource: '*', effect: 'deny' },
    { action: 'read', resource: '*', effect: 'allow' }
  ];
  const NO_TOOLS_TAIL =
    '如果你**看不到任何可用的文件读取工具**，请只回复：NO_TOOLS\n' +
    '不要使用 execute，不要写代码，不要解释。';

  const cases = [
    {
      label: 'J1(read-工作区外)',
      perm: READ_ONLY,
      workspace: WORK_DIR,
      prompt: `请用你的工具读取文件 ${TARGET}，把里面 "name" 字段的值原样贴回来。\n` + NO_TOOLS_TAIL
    },
    {
      label: 'J2(shell)',
      perm: [
        { action: '*', resource: '*', effect: 'deny' },
        { action: 'shell', resource: '*', effect: 'allow' }
      ],
      workspace: WORK_DIR,
      prompt:
        '请用你的命令执行工具运行 `echo probe-j2-ok`，把输出原样贴回来。\n' +
        '如果你**看不到任何可用的命令工具**，请只回复：NO_TOOLS\n' +
        '不要使用 execute，不要写代码，不要解释。'
    },
    {
      label: 'J3(read-工作区内)',
      perm: READ_ONLY,
      workspace: WORK_DIR,
      prompt: `请用你的工具读取文件 ${MARKER}，把里面的内容原样贴回来。\n` + NO_TOOLS_TAIL
    },
    {
      label: 'J4(read-工作区=项目根)',
      perm: READ_ONLY,
      workspace: ROOT,
      prompt: `请用你的工具读取文件 ${TARGET}，把里面 "name" 字段的值原样贴回来。\n` + NO_TOOLS_TAIL
    }
  ];

  for (const c of cases) {
    console.log(`\n  ── ${c.label} ──`);
    writeConfig({ permissions: c.perm });
    await ensureServer({ force: true, withShim: false, log: (m) => console.log(`    [server] ${m}`) });
    report(c.label, await runTurn(c.label, c.prompt, { timeoutMs: 60_000, workspace: c.workspace }));
  }
}

async function phaseK() {
  console.log('\n=== K. 内置工具全名清点（② 的白名单照这个写）===');
  console.log('    动因：② 要写两份规则 —— 主人档放行文件/命令，客人档只放行只读网络搜索。');
  console.log('    动作名猜错 = 工具静默消失，所以必须实测出**全部**内置动作名。');
  const W = path.join(ROOT, '.oc', 'work', 'mcp-probe');
  const prompt = [
    '请依次完成下面几件事，每件都用你自己的原生工具（不要写代码、不要用 execute、也不要用命令代替）：',
    `1. 读取文件 ${path.join(ROOT, 'package.json')}，只报告第 1 行`,
    `2. 列出目录 ${ROOT} 下所有 .json 文件的名字`,
    `3. 在目录 ${ROOT}\\src 里搜索包含 "NodeApiClient" 的文件名与行号`,
    `4. 在 ${W} 下创建文件 probe-k.txt，内容写 k-write-ok`,
    '5. 把该文件内容改成 k-edit-ok',
    '6. 搜索「OpenCode 是什么」，用一句话总结',
    '7. 抓取 https://example.com 并报告页面标题',
    '最后用几行列出：你实际用了哪些工具名、各自成功还是失败。'
  ].join('\n');
  writeConfig({ mcp: {} });
  await ensureServer({ force: true, withShim: false, log: (m) => console.log(`    [server] ${m}`) });
  report('K', await runTurn('k', prompt, { timeoutMs: 180_000, workspace: ROOT }));
}

async function phaseL() {
  console.log('\n=== L. 收图：files 附件通没通 + 模型识不识图 ===');
  console.log('    测例用真实 QQ 收到的那张截图（内容已知：战地1 选小队界面）。');
  console.log('    模型描述对了，才说明图**真的**进了模型，而不是它在凭空猜。');
  const dir = path.join(ROOT, 'spike', 'out', 'inbox');
  const img = (fs.existsSync(dir) ? fs.readdirSync(dir) : [])
    .map((f) => path.join(dir, f))
    .find((f) => /\.(jpe?g|png)$/i.test(f));
  if (!img) {
    console.log(`    没找到测例图片（${dir}），跳过。先跑：node spike/qq-read.mjs --save-images`);
    return;
  }
  const b64 = fs.readFileSync(img).toString('base64');
  console.log(`    测例：${path.basename(img)}  (${b64.length} 字节 base64)`);
  const PROMPT =
    '附件里有一张游戏截图。请只用两句话回答：\n' +
    '1) 这是哪个游戏的什么界面？\n' +
    '2) 画面里出现了哪些玩家名？\n' +
    '不要使用任何工具，直接看附件回答。';

  const forms = [
    { label: 'L1(file://)', uri: pathToFileURL(img).href },
    { label: 'L2(data:)', uri: `data:image/jpeg;base64,${b64}` },
    // L3 用**有视力**的模型重跑同一条：只有它认出了战地1，
    // 才能排除"图根本没进去、模型只是老实说自己没视力"这种可能。
    {
      label: 'L3(glm-4.6v-flash + file://)',
      uri: pathToFileURL(img).href,
      model: { provider: 'zhipuai', model: 'glm-4.6v-flash', reasoningEffort: 'none' }
    }
  ];
  for (const f of forms) {
    console.log(`\n  ── ${f.label} ──`);
    writeConfig({ mcp: {} });
    await ensureServer({ force: true, withShim: false, log: (m) => console.log(`    [server] ${m}`) });
    report(
      f.label,
      await runTurn(f.label, PROMPT, {
        timeoutMs: 90_000,
        workspace: ROOT,
        model: f.model,
        content: [
          { type: 'text', text: PROMPT },
          { type: 'image', mediaType: 'image/jpeg', data: b64, name: path.basename(img), uri: f.uri }
        ]
      })
    );
  }
}

async function doRestore() {
  console.log('\n=== 还原 opencode.json 并重启 ===');
  restore();
  await ensureServer({ force: true, log: (m) => console.log(`    [server] ${m}`) });
  console.log('完成。');
}

const which = (process.argv[2] ?? 'all').toLowerCase();
try {
  if (which === 'a' || which === 'all') await phaseA();
  if (which === 'b' || which === 'all') await phaseB();
  if (which === 'c' || which === 'all') await phaseC();
  if (which === 'd' || which === 'all') await phaseD();
  if (which === 'e' || which === 'all') await phaseE();
  if (which === 'f' || which === 'all') await phaseF();
  if (which === 'g' || which === 'all') await phaseG();
  if (which === 'h' || which === 'all') await phaseH();
  if (which === 'i' || which === 'all') await phaseI();
  if (which === 'j' || which === 'all') await phaseJ();
  if (which === 'k' || which === 'all') await phaseK();
  if (which === 'l' || which === 'all') await phaseL();
  await doRestore();
} finally {
  restore();
}
