/* ══════════════════════════════════════════════════════════════════════════
 * DualHabitat Matrix · 桌面控制台前端
 *
 * 手写、无构建链。文件按「壳 → 页」排：
 *   1. 小工具（请求、转义、toast、弹窗）
 *   2. 壳（主题 / 模式 / 平台 / 导航 / 状态轮询）
 *   3. 总览
 *   4. API 与模型
 *   5. 后端
 *   6. 聊天
 *   7. 消息
 *   8. 高级（配置项 / 路径 / 原始文件 / 日志 / 自检）
 *
 * 一条纪律：任何会动到外部世界的动作（安装更新、发消息、停服务）都先过
 * confirmBox()，不许点一下就发生。只读操作不弹窗。
 * ══════════════════════════════════════════════════════════════════════════ */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/* ── 1. 小工具 ──────────────────────────────────────── */

async function api(path, options = {}) {
  try {
    const res = await fetch(path, { headers: { 'content-type': 'application/json' }, ...options });
    const text = await res.text();
    if (!text) return { ok: res.ok };
    try {
      return JSON.parse(text);
    } catch {
      return { ok: false, error: `返回的不是 JSON（HTTP ${res.status}）` };
    }
  } catch (error) {
    return { ok: false, error: `请求失败：${error?.message ?? error}` };
  }
}

const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body ?? {}) });

/** 拼 HTML 前统一转义。用户自己填的模型名、人格名都会进 DOM。 */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** "1, 2 ,3" / "1 2" / "1，2" → ['1','2','3'] */
const splitIds = (s) => String(s ?? '').split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean);

let toastTimer = null;
function toast(text) {
  let el = $('#toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-on'), 2600);
}

/**
 * 面板底下那行小字。成功顺手弹一下 toast —— 红字留原地，绿字容易看漏。
 *
 *   ok             测试 / 状态类：弹具体结果（“通了，1200ms”）
 *   saved          真的改了数据且立即生效：统一弹「修改成功」
 *   saved-pending  真的改了数据，但要重启桥接/服务才生效：弹「修改成功（重启后生效）」
 *   err            红字留原地，不弹（一闪而过反而看不到）
 */
function setResult(sel, text, kind) {
  const el = typeof sel === 'string' ? $(sel) : sel;
  if (!el) return;
  el.textContent = text ?? '';
  el.className = `result${kind ? ` ${kind}` : ''}`;
  if (kind === 'saved' && text) toast('修改成功');
  else if (kind === 'saved-pending' && text) toast('修改成功（重启后生效）');
  else if (kind === 'ok' && text) toast(text);
}

/**
 * 按钮忙碌态：防止连点两次发两条消息。
 *
 * 注意：**不要传 e.currentTarget** —— 事件派发结束后它会被置成 null，
 * 只要函数里有 await（比如先弹确认框），回来时就是 `null.textContent` 崩掉。
 * 统一用 `e.target.closest('button')`（target 不会失效），这里再兜一层 null。
 */
async function busy(btn, label, task) {
  if (!btn) return task();
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = label;
  try {
    return await task();
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

function fmtTime(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleTimeString('zh-CN', { hour12: false });
}

function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v > 1048576) return `${(v / 1048576).toFixed(1)} MB`;
  if (v > 1024) return `${(v / 1024).toFixed(0)} KB`;
  return `${v} B`;
}

/* ── 用量统计 ────────────────────────────────────────── */

const fmtTok = (n) => {
  const v = Number(n) || 0;
  if (v >= 1e8) return `${(v / 1e8).toFixed(2)} 亿`;
  if (v >= 1e4) return `${(v / 1e4).toFixed(1)} 万`;
  return String(v);
};
const fmtMoney = (n) => (Number(n) > 0 ? `$${Number(n).toFixed(4)}` : '—');
const fmtTps = (v) => (Number(v) > 0 ? `≈${v} tok/s` : '—');
const fmtTtft = (ms) => (Number(ms) > 0 ? (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`) : '—');

let usageCache = null;

async function loadUsage() {
  const u = await api('/api/usage');
  if (u.ok === false) {
    usageCache = null;
    $('#us-cost').textContent = '—';
    $('#us-req').textContent = '—';
    $('#us-tok').textContent = '—';
    $('#us-hit').textContent = '—';
    const split = $('#us-split');
    if (split) split.textContent = '';
    return setResult('#usage-result', u.error ?? '读不了会话库', 'err');
  }
  usageCache = u;
  renderUsage(u);
}

function hmLevel(tokens, max) {
  if (!tokens || !max) return 0;
  const r = tokens / max;
  if (r > 0.75) return 4;
  if (r > 0.5) return 3;
  if (r > 0.25) return 2;
  return 1;
}

function renderUsage(u) {
  if (!u || u.ok === false) return;
  const t = u.totals;
  if (u.empty || !t) {
    $('#us-cost').textContent = '—';
    $('#us-req').textContent = '—';
    $('#us-tok').textContent = '—';
    $('#us-hit').textContent = '—';
    $('#us-heatmap').innerHTML = '<span class="hint">还没有任何调用记录 —— 发一条消息就有了。</span>';
    $('#us-log').innerHTML = '';
    const split = $('#us-split');
    if (split) split.textContent = '';
    return;
  }
  $('#us-cost').textContent = fmtMoney(t.cost);
  $('#us-cost-sub').textContent = t.cost > 0 ? '按厂商定价估算' : '（免费额度 / 未计价模型）';
  $('#us-req').textContent = String(t.requests);
  $('#us-req-sub').textContent = t.errors ? `${t.ok} 成功 · ${t.errors} 失败` : '全部成功';
  const spent = t.input + t.output + t.reasoning + t.cacheWrite;
  $('#us-tok').textContent = fmtTok(spent);
  $('#us-tok-sub').textContent = `入 ${fmtTok(t.input)} · 出 ${fmtTok(t.output)}`;
  $('#us-hit').textContent = t.cacheHitRate > 0 ? `${Math.round(t.cacheHitRate * 100)}%` : '—';
  $('#us-hit-sub').textContent = t.cacheRead > 0 ? `命中 ${fmtTok(t.cacheRead)}` : '没有缓存统计';

  const byChat = u.byChat ?? {};
  const splitParts = [];
  if (byChat.qqPrivate?.requests) splitParts.push(`QQ 私聊 ${byChat.qqPrivate.requests} 次`);
  if (byChat.qqGroup?.requests) splitParts.push(`QQ 群聊 ${byChat.qqGroup.requests} 次`);
  if (byChat.wechat?.requests) splitParts.push(`微信 ${byChat.wechat.requests} 次`);
  if (byChat.unknown?.requests) splitParts.push(`未知会话 ${byChat.unknown.requests} 次`);
  const split = $('#us-split');
  if (split) split.textContent = splitParts.length ? `按会话：${splitParts.join(' · ')}` : '按会话：还没有可识别的私聊/群聊记录';

  /* 热力图：列对齐周一，最后一列是本周；从本周一回退 25 周共 26 列 */
  const byDay = new Map(u.days.map((d) => [d.date, d]));
  const maxTok = Math.max(1, ...u.days.map((d) => d.tokens));
  const today = new Date();
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const daysSinceMonday = (end.getDay() + 6) % 7;
  const start = new Date(end);
  start.setDate(end.getDate() - daysSinceMonday - 25 * 7);
  const cells = [];
  const pad2 = (n) => String(n).padStart(2, '0');
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const key = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    const row = byDay.get(key);
    cells.push(`<span class="hm-cell hm-${hmLevel(row?.tokens, maxTok)}" title="${key}：${row ? `${row.requests} 次请求 · ${fmtTok(row.tokens)} tokens · ${fmtMoney(row.cost)}` : '无调用'}"></span>`);
  }
  $('#us-heatmap').innerHTML = cells.join('');

  /* 请求日志：最新 100 条 */
  $('#us-log').innerHTML = (u.recent ?? [])
    .map((r) => {
      const d = new Date(r.t);
      const sameDay = new Date().toDateString() === d.toDateString();
      const when = sameDay
        ? `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
        : `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
      const model = r.provider ? `${esc(r.model)}<span class="usage-prov">${esc(r.provider)}</span>` : esc(r.model);
      const status = r.status === 'error' ? `<span class="usage-err" title="${esc(r.error)}">失败</span>` : '<span class="usage-ok">成功</span>';
      return `<tr><td class="mono">${when}</td><td>${esc(r.app)}</td><td class="usage-chat" title="${esc(r.conv ?? '')}">${esc(r.chat ?? '未知会话')}</td><td class="usage-model">${model}</td><td>${fmtMoney(r.cost)}</td><td>${fmtTok(r.input)}</td><td>${fmtTok(r.output)}</td><td>${fmtTok(r.cacheRead)}</td><td>${fmtTps(r.tps)}</td><td>${fmtTtft(r.ttftMs)}</td><td>${status}</td></tr>`;
    })
    .join('');
}

$('#btn-usage-refresh').addEventListener('click', async (e) => {
  await busy(e.target.closest('button'), '统计中…', loadUsage);
});

/* ── 通用确认弹窗 ───────────────────────────────────── */

let modalResolve = null;

function openModal({ title, text = '', list = [], okLabel = '确定', cancelLabel = '取消', danger = false, choices = null }) {
  const mask = $('#modal-mask');
  $('#modal-title').textContent = title;
  $('#modal-text').textContent = text;
  const ul = $('#modal-list');
  ul.innerHTML = list.map((x) => `<li>${esc(x)}</li>`).join('');
  ul.hidden = list.length === 0;

  const ok = $('#modal-ok');
  const cancel = $('#modal-cancel');
  ok.textContent = okLabel;
  ok.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;
  ok.hidden = Boolean(choices);
  cancel.textContent = choices ? '关闭' : cancelLabel;

  mask.classList.add('is-on');

  return new Promise((resolve) => {
    modalResolve = resolve;
    if (choices) {
      // 选择模式：把候选项塞进列表位置，点哪个就 resolve 哪个
      ul.hidden = false;
      ul.innerHTML = choices
        .map((c, i) => `<li><button class="btn btn-sm" style="width:100%;justify-content:flex-start" data-choice="${i}">${esc(c.label)}</button></li>`)
        .join('');
      ul.style.listStyle = 'none';
      ul.style.paddingLeft = '0';
      $$('#modal-list [data-choice]').forEach((b) => {
        b.addEventListener('click', () => {
          const pick = choices[Number(b.dataset.choice)];
          closeModal(pick?.value ?? null);
        });
      });
    } else {
      ul.style.listStyle = '';
      ul.style.paddingLeft = '';
    }
  });
}

function closeModal(value) {
  $('#modal-mask').classList.remove('is-on');
  const r = modalResolve;
  modalResolve = null;
  if (r) r(value);
}

$('#modal-cancel').addEventListener('click', () => closeModal(null));
$('#modal-ok').addEventListener('click', () => closeModal(true));
$('#modal-mask').addEventListener('click', (e) => {
  if (e.target.id === 'modal-mask') closeModal(null);
});

/** 是/否。返回 true 才继续。 */
async function confirmBox(opts) {
  const r = await openModal(opts);
  return r === true;
}

/* ── 2. 壳 ──────────────────────────────────────────── */

/* 主题 */
function applyTheme(theme) {
  // 2026-10-22 起默认浅色：没存过偏好的新机器直接进浅色；明确选过「深色」的照旧
  const next = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem('dhm-theme', next);
  } catch { /* 隐私模式下写不了，本次会话照样生效 */ }
}
/* ── 界面语言与字号 ─────────────────────────────────── */

/* 英文词典：键是界面上的中文原句。没收录的字符串保持中文 ——
   翻译逐块推进，宁可漏翻也不要硬翻出歧义。 */
const I18N_EN = {
  '选择通道': 'Choose a channel',
  '当前状态': 'Status',
  '对话与人格': 'Chat & Persona',
  '对话': 'Chat',
  '交流空间': 'Live Feed',
  '消息与任务': 'Messages & Tasks',
  '消息': 'Messages',
  'API 与模型': 'API & Models',
  '模型': 'Models',
  '连接': 'Connection',
  '更多': 'More',
  '链接手机': 'Phone Link',
  '后端': 'Backend',
  '高级': 'Advanced',
  '登录': 'Sign in',
  '不常用的设置收在这里，主界面只留每天要用的。': 'Less-used settings live here; the main sidebar keeps only daily essentials.',
  '把两个会话放在一起看，适合双人设对聊': 'View two conversations side by side — handy for two-persona chats.',
  '手机查看消息、收推送': 'Read messages and get push notifications on your phone.',
  '插件、工具与外部集成': 'Plugins, tools and external integrations.',
  '组件安装、底层开关与维护': 'Component install, low-level switches and maintenance.',
  '切换模型后端与 CLI 引擎': 'Switch model backend and CLI engine.',
  '微信消息钩子与转发': 'WeChat message hooks and forwarding.',
  '两条通道各跑各的进程，能同时开。点卡片进去配置；下面的状态灯是实时读数，不用进去看。': 'Each channel runs its own process; both can run at once. Click a card to configure it — the LEDs below are live readings.',
  '每收到或回复一条消息，都会按所选数据格式向指定地址推送一份 JSON。与 QQ 无关。': 'Every incoming or outgoing message is pushed as JSON to your URL in the selected format. Unrelated to QQ.',
  '运行状态、运行时长与当前使用的模型档位。': 'Run state, uptime and the active model tier.',
  '界面模式': 'UI mode',
  'QQ 与微信两个机器人的收发记录和后台日志都汇总在这一页。': 'Messages of both the QQ and WeChat bots, plus backend logs, on one page.',
  '这里管理模型供应商、密钥与切换顺序。批量粘贴多个 key，程序会自动识别厂商并分类，确认后即可保存。': 'Manage providers, keys and failover order. Paste several keys at once and the app detects vendors automatically.',
  '决定聊天里的回复由谁来生成。三种只能选一种，选完点「启用这条后端」才生效。': 'Decides what generates replies. Pick one of the three, then click "Enable this backend" to apply.',
  '谁能让机器人回话、用什么人格回。QQ 和微信各存一份配置，上面的平台按钮切的就是这一页。': 'Who can trigger a reply and with which persona. QQ and WeChat store separate configs — switch with the buttons above.',
  '查看最近消息、主动发送与定时发送。这里显示最近数百条活动记录，不是完整聊天存档。': 'Recent messages, proactive and scheduled sends. Shows the latest few hundred records, not a full archive.',
  '谁说了什么、机器人回了什么、后台在干什么，全在这一页。左边是收发的原文，右边是实时日志。': 'Who said what, what the bot replied, what runs in the background. Transcripts left, live logs right.',
  '把手机上的通知转给电脑：短信、微信、QQ、快递取件码都行。手机端装一个转发 App，把这里的地址填进去就通了。': 'Forward phone notifications to the PC: SMS, WeChat, QQ, parcel codes and more. Install a forwarding app and paste this address.',
  '细项、路径、原始配置、日志。看不懂的别改 —— 留空就是默认值，斜杠后面写的是默认值。': 'Fine-grained options, paths, raw configs, logs. Empty means default; the value after the slash is the default.',
  '群聊、私聊、人格与工具': 'Group & private chat, persona, tools',
  '登录、Hook 与机器人': 'Sign-in, hooks, bots',
  '简易': 'Simple',
  '深色': 'Dark',
  '浅色': 'Light',
  '设置': 'Settings',
  '联系': 'Contact',
  '有新版本': 'Update available',
  '有新版本，点这里回总览页升级': 'Update available — click to go back to Overview',
  '设置：语言、字体大小、开机自启': 'Settings: language, font size, launch at login',
  '联系方式与仓库地址': 'Contact info & repository',
  '语言': 'Language',
  '字体大小': 'Font size',
  '小': 'Small',
  '标准': 'Default',
  '大': 'Large',
  '特大': 'Extra large',
  '外观': 'Theme',
  '开机自启动': 'Launch at login',
  '完成': 'Done',
  '复制': 'Copy',
  '写邮件': 'Email',
  '打开': 'Open',
  '已复制': 'Copied',
  '联系与仓库': 'Contact & Repository',
  '邮箱': 'Email',
  'GitHub 仓库': 'GitHub repository',
  '遇到问题、想提需求或参与开发，欢迎通过下面任意方式联系：': 'Questions, feature requests or contributions — reach me any of these ways:',
  '常用界面文案支持英文，面板内的详细说明暂为中文，会逐步补齐。': 'Common UI strings are translated; detailed hints inside panels remain Chinese for now.',
  '开机自启已开启，开机后会自动打开控制台并按「看护」开关拉起服务。': 'On — the console opens at login and guarded services are started.',
  '开机自启已关闭。开启后安装版会在登录时自动打开控制台。': 'Off. Turn on to open the console automatically at login (installed builds).',
  '当前环境不支持开机自启（开发模式直接跑源码没有安装信息）。': 'Not available here: dev mode running from source has no install info.',
  '已开启开机自启': 'Launch at login enabled',
  '已关闭开机自启': 'Launch at login disabled',
  '保存失败': 'Save failed',
  '复制不了，已选中文字，请手动 Ctrl+C': 'Could not copy — text selected, press Ctrl+C'
};

const uiLang = () => (document.documentElement.dataset.lang === 'en' ? 'en' : 'zh');

/** 界面文案翻译：en 模式查词典，没收录就返回中文原句 */
function t(s) {
  if (uiLang() !== 'en') return s;
  return I18N_EN[s] ?? s;
}

/** 把 data-i18n 标记的静态文案整体换一遍；JS 动态文案（导航/底栏）单独刷 */
function applyI18n() {
  const en = uiLang() === 'en';
  $$('[data-i18n]').forEach((el) => {
    if (el.dataset.origText === undefined) el.dataset.origText = el.textContent;
    el.textContent = en ? (I18N_EN[el.dataset.i18n] ?? el.dataset.origText) : el.dataset.origText;
  });
  document.documentElement.lang = en ? 'en' : 'zh-CN';
  renderNav();
  applyModeLabel();
  applyFootLabels();
}

/** 底栏按钮的小字与悬停说明 */
function applyFootLabels() {
  $('#settings-label').textContent = t('设置');
  $('#contact-label').textContent = t('联系');
  $('#btn-settings').title = t('设置：界面模式、语言、字体大小、外观、开机自启');
  $('#btn-contact').title = t('联系方式与仓库地址');
  $('#update-indicator-label').textContent = t('有新版本');
  $('#btn-update-indicator').title = t('有新版本，点这里回总览页升级');
}

/* 字号：整体 zoom（布局大量用 px，改根字号无效）。1 = 标准，不写内联样式 */
function applyFont(scale) {
  const v = Number(scale) || 1;
  document.documentElement.style.zoom = v === 1 ? '' : String(v);
  try {
    localStorage.setItem('dhm-font', String(v));
  } catch { /* 写不了就本次会话内生效 */ }
}

/* ── 设置面板：改动即时生效，没有「保存」按钮 ────────── */

function autostartHintFor(supported, on) {
  if (!supported) return t('当前环境不支持开机自启（开发模式直接跑源码没有安装信息）。');
  return on
    ? t('开机自启已开启，开机后会自动打开控制台并按「看护」开关拉起服务。')
    : t('开机自启已关闭。开启后安装版会在登录时自动打开控制台。');
}

function openSettings() {
  $('#set-lang').value = uiLang();
  $('#set-mode').value = uiMode();
  $('#set-font').value = localStorage.getItem('dhm-font') || '1';
  $('#set-theme').value = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
  $('#settings-mask').classList.add('is-on');
  // 自启状态每次打开都现查：automation.json 可能被总览页改过
  api('/api/automation')
    .then((a) => {
      const supported = a.autostart?.supported !== false;
      const box = $('#set-autostart');
      box.checked = supported && a.launchAtLogin === true;
      box.disabled = !supported;
      $('#set-autostart-hint').textContent = autostartHintFor(supported, box.checked);
    })
    .catch(() => {});
  api('/api/state')
    .then((s) => {
      $('#set-about').textContent = `DualHabitat Matrix 桌面端 v${s.version ?? '?'}`;
    })
    .catch(() => {});
}

$('#btn-settings').addEventListener('click', openSettings);
/* 侧栏底部的更新指示：任何页面点了都回总览，横幅在那等着 */
$('#btn-update-indicator').addEventListener('click', () => showPage('overview'));
$('#settings-done').addEventListener('click', () => $('#settings-mask').classList.remove('is-on'));
$('#settings-mask').addEventListener('click', (e) => {
  if (e.target.id === 'settings-mask') $('#settings-mask').classList.remove('is-on');
});

$('#set-lang').addEventListener('change', (e) => {
  const lang = e.target.value === 'en' ? 'en' : 'zh';
  try {
    localStorage.setItem('dhm-lang', lang);
  } catch { /* 写不了就本次会话内生效 */ }
  document.documentElement.dataset.lang = lang;
  applyI18n();
  toast(lang === 'en' ? 'Switched to English' : '已切换到中文');
});

$('#set-font').addEventListener('change', (e) => applyFont(e.target.value));
$('#set-theme').addEventListener('change', (e) => applyTheme(e.target.value));

$('#set-autostart').addEventListener('change', async (e) => {
  const on = e.target.checked;
  const r = await post('/api/automation', { launchAtLogin: on });
  if (r.ok === false) {
    e.target.checked = !on;
    toast(r.error ?? t('保存失败'));
    return;
  }
  $('#set-autostart-hint').textContent = autostartHintFor(r.autostart?.supported !== false, on);
  toast(on ? t('已开启开机自启') : t('已关闭开机自启'));
});

/* ── 联系面板：邮箱 + 仓库地址 ───────────────────────── */

$('#btn-contact').addEventListener('click', () => $('#contact-mask').classList.add('is-on'));
$('#contact-done').addEventListener('click', () => $('#contact-mask').classList.remove('is-on'));
$('#contact-mask').addEventListener('click', (e) => {
  if (e.target.id === 'contact-mask') $('#contact-mask').classList.remove('is-on');
});

$$('.contact-copy').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const text = btn.dataset.copy ?? '';
    try {
      await navigator.clipboard.writeText(text);
      toast(t('已复制'));
    } catch {
      // 兜底：选中文本让人手动 Ctrl+C（正常桌面端是 http://127.0.0.1，clipboard 可用）
      const code = btn.parentElement.querySelector('.contact-value');
      if (code) {
        const range = document.createRange();
        range.selectNodeContents(code);
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
      toast(t('复制不了，已选中文字，请手动 Ctrl+C'));
    }
  });
});

/* 简易 / 高级 */
const uiMode = () => (document.documentElement.dataset.mode === 'advanced' ? 'advanced' : 'simple');

function applyModeLabel() {
  const sel = $('#set-mode');
  if (sel) sel.value = uiMode();
}
$('#set-mode').addEventListener('change', (e) => {
  const next = e.target.value === 'advanced' ? 'advanced' : 'simple';
  try {
    localStorage.setItem('dhm-mode', next);
  } catch { /* 写不了就本次会话内生效 */ }
  document.documentElement.dataset.mode = next;
  applyModeLabel();
  toast(next === 'advanced' ? '已切到高级：全部字段都露出来了' : '已切到简易：技术字段收起来了');
});
applyModeLabel();

/* 平台 */
const PLATFORM_KEY = 'dhm-platform';
const platform = () => (document.documentElement.dataset.platform === 'wechat' ? 'wechat' : 'qq');

/** 两套导航 —— 切平台连菜单都不一样，一眼能认出来。
 *  排序按常用度：不配模型跑不起来 → 调人格 → 看消息 → 远程 → 少用的沉底。
 *  总览不在导航里：它是外层首页，进去之前侧边栏根本不出现。 */
const NAV = {
  qq: [
    ['status', '当前状态'],
    ['chat', '对话'],
    ['messages', '消息'],
    ['models', '模型'],
    ['backend', '连接'],
    ['more', '更多']
  ],
  wechat: [
    ['status', '当前状态'],
    ['wx-overview', '登录'],
    ['chat', '对话'],
    ['messages', '消息'],
    ['models', '模型'],
    ['more', '更多']
  ]
};

/**
 * 「更多」里收的是不常用页面。主界面只留每天要用的 6 项，
 * 但页面本身一个都没删 —— 老入口、深链接、引导流程照常能用。
 */
const MORE = {
  qq: [
    ['exchange', '交流空间', '把两个会话放在一起看，适合双人设对聊'],
    ['phone', '链接手机', '手机查看消息、收推送'],
    ['extensions', '扩展', '插件、工具与外部集成'],
    ['advanced', '高级', '组件安装、底层开关与维护']
  ],
  wechat: [
    ['exchange', '交流空间', '把两个会话放在一起看，适合双人设对聊'],
    ['phone', '链接手机', '手机查看消息、收推送'],
    ['backend', '后端', '切换模型后端与 CLI 引擎'],
    ['hook', 'Hook', '微信消息钩子与转发'],
    ['extensions', '扩展', '插件、工具与外部集成'],
    ['advanced', '高级', '组件安装、底层开关与维护']
  ]
};

const pagesOf = (p) => NAV[p].map(([page]) => page);
/** 当前平台能进入的页面 = 导航 + 「更多」+ 更多页本身（防止 QQ 深链接到微信专属页）。 */
const pagesFor = (p) => new Set([...pagesOf(p), 'more', ...MORE[p].map(([page]) => page)]);

let currentPage = 'overview';

/* 开机器人在地面板（bot sheet）：null = 关着；0-3 = 当前展开的引导步骤。
 * 声明放在这里（而不是下面的面板代码段），因为 refreshState 和 applyPlatform
 * 在脚本求值期就会引用它，放后面会踩 let 的暂时性死区。 */
let botSheetStep = null;
let botSheetPoll = null;
let bsImpReport = null;

/* 模型两块配置的状态。声明放这里是因为 applyPlatform 会用到，
   放到函数定义旁边会踩 let 的暂时性死区。 */
let modelProfiles = { qq: {}, wechat: {} };
let modelProfilesLoaded = false;

function renderNav() {
  const items = NAV[platform()];
  const active = pagesOf(platform()).includes(currentPage) ? currentPage : 'more';
  $('#nav').innerHTML = items
    .map(
      ([page, label]) =>
        `<button class="nav-item${page === active ? ' is-active' : ''}" data-page="${page}"><span class="nav-dot"></span><span class="nav-label">${t(label)}</span>${
          page === 'overview' ? '<span class="nav-badge" id="nav-badge-update" hidden>新</span>' : ''
        }</button>`
    )
    .join('');
}

/** 「更多」页：把不常用页面收成一张张卡片，主界面只留 6 项。 */
function renderMore() {
  const box = $('#more-grid');
  if (!box) return;
  box.innerHTML = MORE[platform()]
    .map(
      ([page, title, desc]) =>
        `<button class="more-card" type="button" data-goto="${page}"><strong>${t(title)}</strong><span>${t(desc)}</span></button>`
    )
    .join('');
}

function applyPlatform(value, opts = {}) {
  const prev = platform();
  const next = value === 'wechat' ? 'wechat' : 'qq';
  // 切平台前先把正在编辑的模型配置收进草稿 —— 平台一换，草稿就该指向另一份
  if (modelProfilesLoaded && prev !== next) {
    try { stashAllSlots(); } catch { /* 模型页还没渲染，跳过 */ }
  }
  document.documentElement.dataset.platform = next;
  if (prev !== next) closeBotSheet();

  const wx = next === 'wechat';
  $('#pf-ribbon-text').textContent = wx ? '微信 · iLink 通道' : 'QQ · NapCat 通道';
  document.title = wx ? 'DualHabitat Matrix · 微信' : 'DualHabitat Matrix · QQ';

  // 当前页在新平台里没有（QQ 没有「登录」，微信没有独立总览）就回该平台第一页
  if (currentPage !== 'overview' && !pagesOf(next).includes(currentPage)) currentPage = NAV[next][0][0];
  renderNav();

  $$('#platform-switch .pf-btn').forEach((b) => {
    const on = b.dataset.platform === next;
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-pressed', String(on));
  });
  try {
    localStorage.setItem(PLATFORM_KEY, next);
  } catch { /* 同上 */ }
  // 微信那边没有 QQ 号，占位文字跟着变
  if ($('#ownerQQ')) $('#ownerQQ').placeholder = wx ? '微信号 / wxid' : '你的 QQ 号';
  if ($('#allowPrivate')) $('#allowPrivate').placeholder = wx ? '微信号，逗号分隔' : 'QQ 号，逗号分隔';
  if ($('#denyPrivate')) $('#denyPrivate').placeholder = wx ? '微信号，逗号分隔' : 'QQ 号，逗号分隔';
  if ($('#workspaceTitle')) $('#workspaceTitle').placeholder = wx ? '微信' : '聊天';
  if ($('#send-target')) $('#send-target').placeholder = wx ? '微信用户 id（wxid…）' : 'QQ 号';
  if ($('#send-target-hint')) {
    $('#send-target-hint').textContent = wx
      ? '从聊过的联系人或已保存的会话里挑，也可以直接填 id。'
      : '点右边能从好友/群列表里挑，也可以直接填号。';
  }
  if ($('#send-platform-hint')) {
    $('#send-platform-hint').textContent = wx ? '发给微信用户（要先扫码登录过）' : '发给 QQ 好友（NapCat 得在跑）';
  }
  if ($('#btn-send-dry')) $('#btn-send-dry').hidden = !wx;

  // 模型配置按平台分开存，切完要重新填一遍表单
  if (modelProfilesLoaded && prev !== next) {
    fillAllSlots();
    for (const def of SLOT_DEFS) refreshModelSuggestions(def.key);
    renderModelHero();
    for (const k of [...autoSavedSig.keys()]) if (k.startsWith('slot-') || k.startsWith('chat-')) autoSavedSig.delete(k);
  }

  // 同一个页面两套副标题（标题统一叫「对话与人格」）
  const chatP = $('#page-chat .page-head p');
  if (chatP) {
    chatP.textContent = wx
      ? '微信这条线的人格、注入频率、谁能对话。和 QQ 完全是两份配置。'
      : '谁能让机器人回话、用什么人格回。QQ 和微信各存一份配置，上面的平台按钮切的就是这一页。';
  }

  // 转场：微信从右边进来，QQ 从左边进来
  if (opts.animate && prev !== next) {
    const main = $('#main');
    main.classList.remove('pf-in-right', 'pf-in-left');
    void main.offsetWidth;
    main.classList.add(wx ? 'pf-in-right' : 'pf-in-left');
    setTimeout(() => main.classList.remove('pf-in-right', 'pf-in-left'), 360);
  }
}

$('#nav').addEventListener('click', (e) => {
  const b = e.target.closest('.nav-item');
  if (b?.dataset.page) showPage(b.dataset.page);
});

$('#more-grid')?.addEventListener('click', (e) => {
  const b = e.target.closest('[data-goto]');
  if (b?.dataset.goto) showPage(b.dataset.goto);
});

$$('#platform-switch .pf-btn').forEach((b) => {
  b.addEventListener('click', () => {
    const next = b.dataset.platform;
    if (platform() === next) return;
    applyPlatform(next, { animate: true });
    showPage(currentPage === 'overview' ? NAV[next][0][0] : currentPage);
    toast(next === 'wechat' ? '已切到微信 · iLink' : '已切到 QQ · NapCat');
  });
});

$('#nav-back')?.addEventListener('click', () => showPage('overview'));

// 首页两张通道卡：点进去直接落在该平台第一页（API 与模型）
$$('.home-card').forEach((card) => {
  card.addEventListener('click', () => {
    const target = card.dataset.enter === 'wechat' ? 'wechat' : 'qq';
    applyPlatform(target, { animate: true });
    showPage(NAV[target][0][0]);
  });
});

function showPage(name, anchor) {
  const home = name === 'overview';
  // 总览是外层首页，不在导航列表里；其它页只允许当前平台的导航 + 「更多」，
  // 避免 QQ 深链接到微信专属页（如 wx-overview / hook）时导航高亮错位。
  if (!home && !pagesFor(platform()).has(name)) name = NAV[platform()][0][0];
  currentPage = name;

  const target = home ? 'overview' : name;
  const navPage = pagesOf(platform()).includes(name) ? name : 'more';
  $$('#nav .nav-item').forEach((b) => b.classList.toggle('is-active', b.dataset.page === navPage));
  $$('.page').forEach((p) => {
    p.hidden = p.id !== `page-${target}`;
  });
  if (name === 'more') renderMore();
  // 没进通道之前侧边栏不出现 —— 总览是独立的一层
  document.documentElement.dataset.view = home ? 'home' : 'platform';
  $('#main').scrollTop = 0;
  try {
    localStorage.setItem(`${PLATFORM_KEY}-page-${platform()}`, name);
  } catch { /* 同上 */ }
  loadPage(name);
  // 可选锚点：状态页的「调工具」按钮要直接落到工具面板，不是停在页面顶部。
  // 不能只等一帧 —— 工具分组是异步拉 /api/tools 再渲染的，容器先空着，滚过去也是空的。
  // 所以轮询到容器真的有子节点再滚，最多等 ~1 秒。
  if (anchor) {
    let tries = 0;
    const scroll = () => {
      const el = document.getElementById(anchor);
      if (el && el.children.length > 0) {
        el.scrollIntoView({ block: 'start', behavior: 'smooth' });
        return;
      }
      if (tries++ < 12) setTimeout(scroll, 80);
    };
    requestAnimationFrame(() => requestAnimationFrame(scroll));
  }
}

function loadPage(name) {
  if (name === 'overview') return loadOverview();
  if (name === 'more') return renderMore();
  if (name === 'status') return renderStatus();
  if (name === 'wx-overview') return loadWxOverview();
  if (name === 'hook') return loadHook();
  if (name === 'models') {
    // 用量统计独立拉，不挡模型表加载 —— 哪个先回来哪个先画
    loadUsage();
    return loadModels();
  }
  if (name === 'backend') return loadBackend();
  if (name === 'chat') return loadChat();
  if (name === 'messages') return loadMessages();
  if (name === 'exchange') return loadExchange();
  if (name === 'phone') return loadPhone();
  if (name === 'advanced') return loadAdvanced();
  if (name === 'extensions') return loadExtensions();
  return null;
}

applyPlatform(document.documentElement.dataset.platform);

/* 状态轮询：侧栏那颗灯、总览的服务卡都靠它 */
let S = null;

async function refreshState() {
  const next = await api('/api/state');
  if (!next || next.ok === false) return;
  S = next;
  renderShell();
  renderWizard();
  if (botSheetStep !== null) updateBotSheetLive();
  if (currentPage === 'overview') {
    renderOverview();
    renderHomeCards();
  } else if (currentPage === 'wx-overview') {
    renderWxOverview();
  } else if (currentPage === 'status') {
    // 状态页跟着轮询重画，运行时长才会自己走
    renderStatus();
  } else if (currentPage === 'models') {
    // 探测结果跟着状态轮询走：chips / 模型候选 / 一键切换横幅保持新鲜，表单不动
    refreshModelsLive();
  }
}

/* 本次会话是否已经为「有新版本」弹过气泡 —— 只弹一次，之后靠指示按钮常亮 */
let updateToastShown = false;

function renderShell() {
  if (!S) return;
  const running = [S.napcat?.reachable, S.bridge?.running, S.wechat?.running].filter(Boolean).length;
  const led = $('#led');
  led.className = `led${running > 0 ? ' on' : ''}`;
  $('#led-text').textContent = running > 0 ? `${running} 个 BOT 进程运行中` : '无 BOT 进程';
  $('#build-tag').textContent = `v${S.version ?? '?'}`;

  // 有新版本时侧栏「总览」上挂个小角标 —— 只按「没提醒过的版本」算
  const appNew = S.updates?.app?.found && S.updates.app.found !== S.updates.app.reminded;
  const ncNew = S.updates?.napcat?.found && S.updates.napcat.found !== S.updates.napcat.reminded;
  // 通道式改版后导航里没有 overview 项了，角标挂不到那 —— 元素不存在就跳过，
  // 否则这里每 6 秒抛一次 TypeError，总览页的状态灯永远刷不动。
  const badge = $('#nav-badge-update');
  if (badge) badge.hidden = !(appNew || ncNew);

  // 全局更新入口：横幅只在总览页，待在通道页里的人什么提示都收不到 ——
  // 侧栏底部常驻一个按钮，任何页面都看得见，点了回总览升级。
  const updBtn = $('#btn-update-indicator');
  if (updBtn) updBtn.hidden = !(appNew || ncNew);
  // 每次开软件只弹一次气泡提醒；之后指示按钮常亮，不再打扰
  if ((appNew || ncNew) && !updateToastShown) {
    updateToastShown = true;
    const en = uiLang() === 'en';
    if (appNew) toast(en ? `New version ${S.updates.app.found} available — go to Overview to update` : `软件有新版本 ${S.updates.app.found}，回总览页可升级`);
    else toast(en ? `New NapCat ${S.updates.napcat.found} available — go to Overview to update` : `NapCat 有新版本 ${S.updates.napcat.found}，回总览页可升级`);
  }
}

setInterval(refreshState, 6000);

/* 日志流（高级页用，但一直连着：总览的「最近动态」也吃它） */
const SOURCE_LABEL = { napcat: 'NapCat', bridge: '桥接', wechat: '微信', phone: '手机', app: '软件', qqofficial: '官方QQ' };
const PANE_MAX = 1200;
const panes = {};

/** 简易模式下把日志里的行话翻一下。高级模式也翻 —— 引擎的牌子名不该出现在界面上。 */
const ALWAYS_RULES = [
  [/OpenCode 隔离实例/g, '模型 API 服务'],
  [/OpenCode 本地实例/g, '模型 API 服务'],
  [/OpenCode 实例/g, '模型 API 状态'],
  [/OpenCode 后端/g, '模型 API'],
  [/OpenCode/g, '模型 API'],
  [/opencode\.json/g, '模型配置文件'],
  [/opencode\.db/g, '会话库'],
  [/opencode-cli\.exe/g, '命令行程序'],
  [/@opencode\/client/g, '模型 API 客户端'],
  [/OPENCODE_?[A-Z_]*/g, '环境变量'],
  [/([\\/])opencode([\\/])/g, '$1运行数据$2'],
  [/DSH/g, '模型 API']
];
const SIMPLE_RULES = [
  [/模型链/g, '模型队列'],
  [/链头/g, '首选模型'],
  [/候选/g, '备用模型'],
  [/熔断中/g, '额度用完·已暂停'],
  [/熔断/g, '暂停使用'],
  [/换模型重试/g, '换备用模型重试'],
  [/会话繁忙，暂存唤醒原因/g, '上一条还没回完，这条先记下了'],
  [/暂存唤醒原因/g, '先记下消息'],
  [/cf-shim/g, '网络组件'],
  [/（pid=\d+ version=[\d.]+）/g, ''],
  [/bailian\//g, ''],
  [/#none/g, '（不思考）'],
  [/#low/g, '（快答）'],
  [/#medium/g, '（深思）'],
  [/#high/g, '（深思）']
];

function plainify(text) {
  let out = String(text ?? '');
  for (const [re, to] of ALWAYS_RULES) out = out.replace(re, to);
  if (uiMode() === 'simple') for (const [re, to] of SIMPLE_RULES) out = out.replace(re, to);
  return out;
}

/* 交流空间的「只看消息」：日志里跟收发有关的行才留下。
 * 留一份环形缓冲，勾选状态一变就能整块重画 —— 否则只对新来的行生效，
 * 用户会觉得这个勾没起作用。 */
const EX_MSG_RE = /(管理员|群友|对方|agent 回复|主动发送|收到消息|发送消息|消息已入未读|回复|私聊|群聊)/;
const EX_MSG_ONLY = () => $('#ex-only-msg')?.checked === true;
const EX_BUF_MAX = 400;
const exLogBuf = [];

/** 造一行日志。withTag 时在前面挂来源标签（交流空间那格要）。 */
function makeLogLine({ source, level, time, text }, withTag) {
  const line = document.createElement('div');
  line.className = `line${level === 'err' ? ' line-err' : level === 'sys' ? ' line-sys' : ''}`;
  if (withTag) {
    const tag = document.createElement('span');
    tag.className = `src src-${source}`;
    tag.textContent = SOURCE_LABEL[source];
    line.appendChild(tag);
  }
  line.appendChild(document.createTextNode(`[${time}] ${text}`));
  return line;
}

/** 按当前勾选状态整块重画交流空间的日志窗格 */
function renderExLog() {
  const box = panes.exchange;
  if (!box) return;
  const onlyMsg = EX_MSG_ONLY();
  box.replaceChildren();
  for (const row of exLogBuf) {
    if (onlyMsg && !EX_MSG_RE.test(row.text)) continue;
    box.appendChild(makeLogLine(row, true));
  }
  box.scrollTop = box.scrollHeight;
}

function appendLog(entry) {
  const source = SOURCE_LABEL[entry.source] ? entry.source : 'app';
  const time = new Date(entry.t).toLocaleTimeString('zh-CN', { hour12: false });
  const text = plainify(entry.line);
  const row = { source, level: entry.level, time, text };

  // 交流空间那格是「所有来源 + 来源标签」，跟总览一样按 all 处理
  const targets = ['all', source];
  if (panes.exchange && (!EX_MSG_ONLY() || EX_MSG_RE.test(text))) targets.push('exchange');

  exLogBuf.push(row);
  while (exLogBuf.length > EX_BUF_MAX) exLogBuf.shift();

  for (const pane of targets) {
    const box = panes[pane];
    if (!box) continue;
    box.appendChild(makeLogLine(row, pane !== source));
    while (box.childElementCount > PANE_MAX) box.removeChild(box.firstElementChild);
  }

  // 总览页的「最近动态」只留最后 8 行
  const ov = $('#ov-log');
  if (ov) {
    const line = document.createElement('div');
    line.className = `line${entry.level === 'err' ? ' line-err' : entry.level === 'sys' ? ' line-sys' : ''}`;
    line.textContent = `[${time}] ${SOURCE_LABEL[source]} · ${text}`;
    ov.appendChild(line);
    while (ov.childElementCount > 8) ov.removeChild(ov.firstElementChild);
    ov.scrollTop = ov.scrollHeight;
  }

  if ($('#autoScroll')?.checked) {
    for (const pane of ['all', source]) {
      const box = panes[pane];
      if (box && box.offsetParent !== null) box.scrollTop = box.scrollHeight;
    }
  }
}

function connectLogs() {
  const es = new EventSource('/api/logs');
  es.onmessage = (ev) => {
    try {
      appendLog(JSON.parse(ev.data));
    } catch { /* 忽略坏帧 */ }
  };
  es.onerror = () => {
    es.close();
    setTimeout(connectLogs, 2000);
  };
}

/* 日志窗格：DOM 就绪后建索引 */
function initLogPanes() {
  for (const el of $$('.term-body .log')) panes[el.dataset.pane] = el;
  panes.all = $('#log-all');
  panes.napcat = $('#log-napcat');
  panes.bridge = $('#log-bridge');
  panes.wechat = $('#log-wechat');
  panes.app = $('#log-app');
  // 交流空间那格不叫 log-*，单独挂一次
  if ($('#ex-log')) panes.exchange = $('#ex-log');

  $$('#term-tabs .term-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      const pane = btn.dataset.pane;
      $$('#term-tabs .term-tab').forEach((b) => b.classList.toggle('is-active', b === btn));
      $$('.term-body .log').forEach((el) => el.classList.toggle('is-active', el.dataset.pane === pane));
      if ($('#autoScroll').checked && panes[pane]) panes[pane].scrollTop = panes[pane].scrollHeight;
    });
  });

  $('#btn-clear-log').addEventListener('click', () => {
    const pane = $('#term-tabs .term-tab.is-active')?.dataset.pane ?? 'all';
    if (panes[pane]) panes[pane].textContent = '';
  });
}

/* ── 3. 总览 ────────────────────────────────────────── */

function setLed(sel, state) {
  const el = $(sel);
  if (!el) return;
  el.className = `led${state ? ` ${state}` : ''}`;
}

/* ── 当前状态 ──────────────────────────────────────── */

/** 毫秒 → 「3 小时 12 分」这种人话 */
function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d} 天 ${h} 小时`;
  if (h) return `${h} 小时 ${m} 分`;
  if (m) return `${m} 分`;
  return `${s} 秒`;
}

function renderStatus() {
  if (!S) return;
  const wx = platform() === 'wechat';

  const napcat = S.napcat?.reachable === true;
  const bridge = S.bridge?.running === true;
  const wechat = S.wechat?.running === true;

  // 这条通道算不算"正常启用"
  const ok = wx ? wechat : bridge;
  const partial = !ok && !wx && napcat;

  const dot = $('#status-dot');
  if (dot) dot.className = `status-dot${ok ? ' is-ok' : partial ? ' is-warn' : ''}`;

  const title = $('#status-title');
  if (title) title.textContent = ok ? '正常运行' : partial ? '部分就绪' : '未启动';

  const sub = $('#status-sub');
  if (sub) {
    sub.textContent = ok
      ? wx
        ? '微信通道在跑，消息能收发'
        : '桥接在跑，消息能收发'
      : partial
        ? '通道连上了，但桥接没起 —— 还不会回话'
        : '未启动。可在下方「服务」里启动，或回首页一键全开';
  }

  // 运行时长只看 BOT（桥接/微信）。控制台启动时间与 BOT 无关，不再拿来充数
  const startedAt = wx ? S.wechat?.startedAt : S.bridge?.startedAt;
  const chanMs = Number(startedAt);
  const upLabel = $('#status-uptime-label');
  const up = $('#status-uptime');
  if (Number.isFinite(chanMs) && chanMs > 0) {
    if (upLabel) upLabel.textContent = wx ? '微信已运行' : '桥接已运行';
    if (up) up.textContent = fmtDuration(Date.now() - chanMs);
  } else {
    if (upLabel) upLabel.textContent = 'BOT 未运行';
    if (up) up.textContent = '—';
  }

  // 两档模型各自能不能用
  const slots = S.modelSlots?.[platform()] ?? {};
  const ready = (x) => !!(x && x.baseUrl && x.model);
  const chatOk = ready(slots.chat);
  const comp = S?.computerTools ?? null;
  const compN = comp ? Object.values(comp).filter(Boolean).length : 0;

  // 没配时桥接其实还在用模型池顶着 —— 别谎报「未配置」
  const poolN = S.pool?.enabled ? (S.pool.free ?? 0) + (S.pool.paid ?? 0) : 0;

  const mode = $('#status-mode');
  if (mode) {
    // 档位或模型池任一可用就算「接了模型」；只聊天 / 可以干活看电脑操作勾了几项
    mode.textContent = (chatOk || poolN > 0) ? (compN > 0 ? '可以干活' : '只聊天') : '未配置';
  }

  const slotBox = $('#status-slots');
  if (slotBox) {
    // 点击委托只绑一次：slotBox 本体是静态容器，innerHTML 每次轮询重画
    if (!slotBox.dataset.bound) {
      slotBox.dataset.bound = '1';
      slotBox.addEventListener('click', (e) => {
        const b = e.target.closest('[data-goto]');
        if (b) showPage(b.dataset.goto, b.dataset.anchor);
      });
    }
    const has = chatOk || poolN > 0;
    const modelShow = chatOk ? esc(slots.chat.model) : poolN ? `模型池 · ${poolN} 个候选` : '—';
    const tag = chatOk ? '已配置' : poolN ? '模型池' : '未配置';
    const note = compN > 0
      ? `可以干活：电脑操作开了 ${compN} 项`
      : has
        ? '只聊天：没开电脑操作'
        : '还没接入模型';
    const btn = chatOk
      ? '<button class="btn btn-sm" data-goto="models">管理模型</button>'
      : `<button class="btn btn-sm btn-primary" data-goto="models">${poolN ? '管理模型池' : '去配置模型'}</button>`;
    // 工具开关在「对话与人格」页 —— 名字跟"工具"对不上，靠这按钮直达，别指望人自己找。
    const toolBtn = has
      ? '<button class="btn btn-sm" data-goto="chat" data-anchor="tool-groups">调工具</button>'
      : '';
    slotBox.innerHTML = `
      <div class="status-slot${has ? ' is-ok' : ''}">
        <div class="status-slot-head">
          <span class="status-slot-name">模型</span>
          <span class="status-slot-tag">${tag}</span>
        </div>
        <div class="status-slot-model">${modelShow}</div>
        <div class="status-slot-note">${note}</div>
        <div class="status-slot-actions">${btn}${toolBtn}</div>
      </div>`;
  }

  /* QQ 多号（NapCat）：每个号一行，启停 / 扫码 / 删除都在这里 */
  const napcatAccounts = S.napcat?.accounts ?? [];
  const napcatBox = $('#napcat-accounts-list');
  if (napcatBox) {
    if (!napcatBox.dataset.bound) {
      napcatBox.dataset.bound = '1';
      napcatBox.addEventListener('click', async (e) => {
        const b = e.target.closest('button[data-napcat]');
        if (!b) return;
        const id = b.dataset.id;
        const act = b.dataset.napcat;
        if (act === 'panel') {
          await openNapcatPanel(id);
          return;
        }
        if (act === 'delete') {
          const ok = await confirmBox({
            title: `删除 NapCat 账号 ${id}？`,
            text: '只删除这个号的配置，聊天记录和人格数据都会保留。编号不会复用。',
            okLabel: '删除',
            danger: true
          });
          if (!ok) return;
          const r = await api(`/api/napcat/accounts?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
          toast(r.ok === false ? (r.error ?? '删除失败') : '已删除');
          await refreshState();
          return;
        }
        if (act === 'start' || act === 'stop') {
          const r = await api(`/api/napcat/${act}?account=${encodeURIComponent(id)}`);
          toast(r.ok === false ? (r.error ?? '操作失败') : act === 'start' ? `[${id}] 已启动` : `[${id}] 已停止`);
          await refreshState();
        }
      });
    }
    napcatBox.innerHTML = napcatAccounts.length
      ? napcatAccounts.map((acc) => {
          const state = acc.running
            ? '<span class="badge ok">运行中</span>'
            : acc.configured
              ? '<span class="badge">未运行</span>'
              : '<span class="badge warn">目录未配</span>';
          const meta = `QQ ${acc.qq || '未填'} · WS ${acc.wsPort} · HTTP ${acc.httpPort} · 面板 ${acc.webuiPort}`;
          return `<div class="pool-item" style="align-items:center;gap:10px">
            <span class="led ${acc.running ? 'on' : ''}"></span>
            <span class="pool-name" style="flex:1;min-width:0">
              ${esc(acc.label || acc.id)}${acc.label ? ` <span class="hint">${esc(acc.id)}</span>` : ''}
              <span class="hint" style="display:block;margin-top:2px">${esc(meta)}</span>
              <span class="hint" style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(acc.dir || '')}">${esc(acc.dir || '还没配 NapCat 目录')}</span>
            </span>
            ${state}
            <button class="btn btn-sm" data-napcat="${acc.running ? 'stop' : 'start'}" data-id="${esc(acc.id)}" ${!acc.running && !acc.configured ? 'disabled' : ''}>${acc.running ? '停止' : '启动'}</button>
            <button class="btn btn-sm" data-napcat="panel" data-id="${esc(acc.id)}">扫码 / 登录</button>
            ${acc.id === 'qq1' ? '' : `<button class="btn btn-sm btn-ghost" data-napcat="delete" data-id="${esc(acc.id)}">删除</button>`}
          </div>`;
        }).join('')
      : '<div class="empty">还没有 QQ 号。先在「高级 → 组件」配好 NapCat，再回来添加第二个号。</div>';
  }

  /* QQ 官方机器人多号面板：列表 + 添加/编辑表单。QQ 通道才显示（data-pf 控制） */
  const qofBots = S.qqOfficial?.bots ?? [];
  const qofList = $('#qof-list');
  if (qofList) {
    if (!qofList.dataset.bound) {
      qofList.dataset.bound = '1';
      qofList.addEventListener('click', async (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        const appId = b.dataset.app;
        if (b.dataset.act === 'start') {
          const r = await post('/api/qq-official', { action: 'start', appId });
          toast(r.ok === false ? (r.error ?? '启动失败') : '已启动');
          await refreshState();
        } else if (b.dataset.act === 'stop') {
          const r = await post('/api/qq-official', { action: 'stop', appId });
          toast(r.ok === false ? (r.error ?? '停止失败') : '已停止');
          await refreshState();
        } else if (b.dataset.act === 'edit') {
          const bot = (S.qqOfficial?.bots ?? []).find((x) => x.appId === appId);
          if (!bot) return;
          $('#qof-name').value = bot.name ?? '';
          $('#qof-app-id').value = bot.appId;
          $('#qof-app-secret').value = '';
          $('#qof-app-secret').placeholder = '已保存（要换再填）';
          $('#qof-clear').hidden = false;
          setResult('#qof-result', `正在编辑「${bot.name}」，改完点保存`, 'busy');
          $('#qof-app-id').focus();
        } else if (b.dataset.act === 'delete') {
          const bot = (S.qqOfficial?.bots ?? []).find((x) => x.appId === appId);
          const ok = await confirmBox({
            title: `删除官方机器人「${bot?.name ?? appId}」？`,
            text: '配置和登录状态一起删。这个机器人本身在开放平台不受影响，以后想用再添加回来。',
            okLabel: '删除',
            danger: true
          });
          if (!ok) return;
          const r = await post('/api/qq-official', { action: 'delete', appId });
          toast(r.ok === false ? (r.error ?? '删除失败') : '已删除');
          await refreshState();
        }
      });
    }
    qofList.innerHTML = qofBots.length
      ? qofBots.map((bot) => {
          const state = !bot.running
            ? '<span class="badge">未运行</span>'
            : bot.connected
              ? `<span class="badge ok">已连接${bot.botName ? `「${esc(bot.botName)}」` : ''}</span>`
              : '<span class="badge warn">连接中…</span>';
          const stat = bot.running ? `收 ${bot.received} / 回 ${bot.replied}` : (bot.lastError ? esc(bot.lastError.slice(0, 60)) : '');
          return `<div class="pool-item" style="align-items:center;gap:10px">
            <span class="led ${bot.running ? (bot.connected ? 'on' : 'warn pulse') : ''}"></span>
            <span class="pool-name" style="flex:1">${esc(bot.name)} <span class="hint">${esc(bot.appId)}</span><span class="hint" style="margin-left:10px">${stat}</span></span>
            ${state}
            <button class="btn btn-sm" data-act="${bot.running ? 'stop' : 'start'}" data-app="${esc(bot.appId)}">${bot.running ? '停止' : '启动'}</button>
            <button class="btn btn-sm btn-ghost" data-act="edit" data-app="${esc(bot.appId)}">编辑</button>
            <button class="btn btn-sm btn-ghost" data-act="delete" data-app="${esc(bot.appId)}">删除</button>
          </div>`;
        }).join('')
      : '<div class="empty">还没有官方机器人 —— 在下面填 AppID/AppSecret 添加第一个。</div>';
  }

  const svcBox = $('#status-services');
  if (svcBox) {
    const row = (svc, act, name, on, note) => `
      <div class="status-svc">
        <span class="led${on ? ' on' : ''}"></span>
        <span class="status-svc-name">${name}</span>
        <span class="status-svc-state">${on ? '运行中' : '未运行'}</span>
        <span class="status-svc-note">${note}</span>
        <span class="status-svc-actions">
          <button class="btn btn-sm${on ? '' : ' btn-primary'}" data-svc="${svc}" data-act="${act}">${on ? '停止' : '启动'}</button>
        </span>
      </div>`;
    const chanBtn = (act, label) =>
      `<button class="btn btn-sm${act === 'start' && !ok ? ' btn-primary' : ''}" data-svc="${wx ? 'wechat' : 'bridge'}" data-act="${act}">${label}</button>`;
    svcBox.innerHTML = (wx
      ? row('wechat', wechat ? 'stop' : 'start', '微信通道', wechat, 'iLink 收发消息')
      : row('napcat', napcat ? 'stop' : 'start', 'NapCat', napcat, 'QQ 登录通道') +
        row('bridge', bridge ? 'stop' : 'start', 'QQ 桥接', bridge, '收发消息、调模型'))
      + `<div class="status-svc-chan">
          ${chanBtn('start', '启动本通道')}
          ${chanBtn('stop', '停止本通道')}
          <span class="hint">只影响当前通道；首页「一键全开」不受影响。</span>
        </div>`;
  }
}

/** 首页两张通道卡的状态灯。数据来自同一份 /api/state，不额外请求。 */
function renderHomeCards() {
  if (!S) return;

  const qqLed = $('#home-led-qq');
  if (qqLed) {
    const napcat = S.napcat?.reachable === true;
    const bridge = S.bridge?.running === true;
    qqLed.className = `led${bridge || napcat ? ' on' : ''}`;
    $('#home-state-qq').textContent = bridge ? '运行中' : napcat ? '通道就绪' : '未运行';
  }

  const wxLed = $('#home-led-wx');
  if (wxLed) {
    const running = S.wechat?.running === true;
    const logged = S.wechat?.loggedIn === true;
    wxLed.className = `led${running || logged ? ' on' : ''}`;
    $('#home-state-wx').textContent = logged ? '已登录' : running ? '等待扫码' : '未登录';
  }
}

function renderOverview() {
  if (!S) return;
  const n = S.napcat ?? {};
  const b = S.bridge ?? {};
  const m = S.matrix ?? {};

  /* NapCat */
  const napcatOn = n.reachable === true;
  setLed('#led-napcat', napcatOn ? 'on' : '');
  $('#svc-napcat').classList.toggle('is-on', napcatOn);
  $('#state-napcat').textContent = napcatOn ? '已连接' : n.dir ? '未连接' : '没配目录';
  $('#meta-napcat').textContent = n.dir ? `${n.port} 端口 · QQ ${n.qq || '未填'}${n.bundled ? ' · 自带版' : ''}` : '去「高级 → 路径与端口」填 NapCat 目录';

  /* QQ 桥接 */
  const bridgeOn = b.running === true || Boolean(b.externalPid);
  setLed('#led-bridge', bridgeOn ? 'on' : '');
  $('#svc-bridge').classList.toggle('is-on', bridgeOn);
  $('#state-bridge').textContent = b.running ? '运行中' : b.externalPid ? '运行中（别处启动）' : '未运行';
  $('#meta-bridge').textContent = bridgeOn
    ? `pid ${b.pid ?? b.externalPid} · 起于 ${fmtTime(b.startedAt)}${b.exitCode != null ? ` · 上次退出 code ${b.exitCode}` : ''}`
    : '桥接没跑，QQ 收不到也回不了';

  /* 模型 API：QQ / 微信各一个实例，首页分开显示 */
  const instances = m.instances ?? { qq: m, wechat: null };
  const qq = instances.qq ?? {};
  const wx = instances.wechat ?? {};
  const aliveCount = [qq, wx].filter((x) => x?.alive === true).length;
  setLed('#led-matrix', aliveCount > 0 ? 'on' : '');
  $('#svc-matrix').classList.toggle('is-on', aliveCount > 0);
  $('#state-matrix').textContent =
    aliveCount === 2 ? '两个实例都在运行' : aliveCount === 1 ? (qq.alive ? 'QQ 实例运行中' : '微信实例运行中') : '未运行';
  const instanceLine = (label, x) =>
    `<div>${label}：${x?.alive ? `${esc(x.url ?? '—')}${x.version ? ` · v${esc(x.version)}` : ''}` : '未运行'}</div>`;
  $('#meta-matrix').innerHTML = instanceLine('QQ', qq) + instanceLine('微信', wx);

  /* 看护开关 */
  const watch = S.automation?.watch ?? {};
  $$('[data-watch]').forEach((el) => {
    el.checked = watch[el.dataset.watch] === true;
  });


  /* 更新横幅 */
  const appNew = S.updates?.app?.found && S.updates.app.found !== S.updates.app.reminded;
  const appErr = !appNew && S.updates?.app?.error ? String(S.updates.app.error) : '';
  $('#banner-app').hidden = !appNew && !appErr;
  if (appNew) {
    $('#banner-app-title').textContent = `软件有新版本 ${S.updates.app.found}（当前 v${S.version}）`;
    $('#banner-app-sub').textContent = '下载完成后本程序会自动关闭并安装，装完自动重开。';
    $('#btn-app-update').hidden = false;
  } else if (appErr) {
    // 检查失败不再静默：横幅位告诉人「不是没更新，是没查到」
    $('#banner-app-title').textContent = '更新检查没连上';
    $('#banner-app-sub').textContent = `自动检查没连上 GitHub（${appErr.slice(0, 90)}）。网络/代理通了以后重开软件就会重查；也可以直接去 GitHub releases 页手动下载。`;
    $('#btn-app-update').hidden = true;
  }
  const ncNew = S.updates?.napcat?.found && S.updates.napcat.found !== S.updates.napcat.reminded;
  $('#banner-napcat').hidden = !ncNew;
  if (ncNew) {
    $('#banner-napcat-title').textContent = `NapCat 有新版本 ${S.updates.napcat.found}`;
    $('#banner-napcat-sub').textContent = '会下载到旁边一个新目录再切过去，旧目录保留，装完重启 NapCat。';
  }

  // 精简安装包：本机没有 NapCat，也没自带 —— 直接给一个下载入口，别让人自己去翻发布页
  const ncMissing = !S.napcat?.bundled && !S.napcat?.dir && !napcatInstallSkipped;
  $('#banner-napcat-install').hidden = !ncMissing;

  renderWizard();
}

/* ── 微信总览 ────────────────────────────────────────── */
let hookCache = null;

async function loadWxOverview() {
  await refreshState();
  hookCache = await api('/api/wechat/hook');
  renderWxOverview();
}

/* 微信多账号：当前在登录页操作哪个号（wx1..wx10），纯前端选中态 */
let wxAccount = 'wx1';

function wxAccountData() {
  const list = S?.wechat?.accounts;
  if (Array.isArray(list) && list.length) return list.find((a) => a.id === wxAccount) ?? list[0];
  return S?.wechat ?? {};
}

/** 登录页顶部的账号条：选中哪个号，下面的状态/二维码/启停就作用于哪个号。 */
function renderWxAccounts() {
  const box = $('#wx-accounts');
  if (!box) return;
  const list = S?.wechat?.accounts ?? [{ id: 'wx1' }];
  if (!list.some((a) => a.id === wxAccount)) wxAccount = list[0].id;
  box.innerHTML =
    list.map((a) => `
      <button class="btn btn-sm ${a.id === wxAccount ? 'btn-primary' : 'btn-ghost'}" data-wx-acc="${esc(a.id)}" title="${a.loggedIn ? '已登录' : a.running ? '等扫码' : '未启动'}">
        <span class="led ${a.running ? (a.loggedIn ? 'on' : 'warn pulse') : ''}" style="margin-right:4px"></span>${esc(a.id)}
      </button>`).join('') +
    (list.length < 10
      ? '<button class="btn btn-sm btn-ghost" data-wx-acc-add="1" title="最多 10 个微信账号，每个号独立扫码登录">＋ 添加账号</button>'
      : '') +
    (wxAccount !== 'wx1'
      ? `<button class="btn btn-sm btn-ghost" data-wx-acc-del="${esc(wxAccount)}" title="删掉这个号（登录态一起删）">删除 ${esc(wxAccount)}</button>`
      : '');
}

document.addEventListener('click', async (e) => {
  const chip = e.target.closest('[data-wx-acc]');
  if (chip) {
    wxAccount = chip.dataset.wxAcc;
    renderWxAccounts();
    renderWxOverview();
    return;
  }
  if (e.target.closest('[data-wx-acc-add]')) {
    const r = await post('/api/wechat/accounts', { action: 'add' });
    if (r.ok === false) return toast(r.error ?? '加不了');
    toast(`已添加 ${r.added}，扫码登录后它就是一台独立机器人`);
    await refreshState();
    return;
  }
  const del = e.target.closest('[data-wx-acc-del]');
  if (del) {
    const id = del.dataset.wxAccDel;
    const ok = await confirmBox({
      title: `删除微信账号 ${id}？`,
      text: '登录态和会话一起删，这个号立即停止收发。wx1 是默认号不能删。',
      okLabel: '删除',
      danger: true
    });
    if (!ok) return;
    const r = await post('/api/wechat/accounts', { action: 'remove', id });
    if (r.ok === false) return toast(r.error ?? '删除失败');
    wxAccount = 'wx1';
    toast('已删除');
    await refreshState();
  }
});

function renderWxOverview() {
  if (!S) return;
  renderWxAccounts();
  const w = wxAccountData();
  const on = w.running === true;

  setLed('#wxo-led', w.loggedIn ? 'on' : on ? 'warn pulse' : '');
  $('#wxo-state').textContent = w.loggedIn ? '已登录' : on ? '等待扫码' : '未启动';
  $('#wxo-meta').textContent = w.loggedIn
    ? `机器人 ${w.botId ?? '—'} · 登录于 ${w.loginTime ? new Date(w.loginTime).toLocaleString('zh-CN') : '—'}`
    : on
      ? '二维码在右侧，请使用微信扫码；完成后状态将变为「已登录」'
      : '启动后扫码登录；微信与 QQ 相互独立';

  // 二维码面板是从 QQ 总览挪过来的，id 没变
  const qrBox = $('#wx-qr-panel');
  if (w.qr) {
    qrBox.hidden = false;
    $('#wx-qr-img').src = w.qr;
    $('#wx-qr-status').textContent = w.qrStatus === 'scanned' ? '已扫码，请在手机上确认' : '等待扫码（二维码四分钟过期）';
  } else {
    qrBox.hidden = true;
  }

  const h = hookCache && hookCache.ok !== false ? hookCache : null;
  if (h) {
    const enabled = h.enabled === true;
    const badge = $('#wxo-hook-state');
    badge.textContent = enabled ? '已开启' : '未开启';
    badge.className = `badge${enabled ? ' accent' : ''}`;
    $('#wxo-hook-url').textContent = h.url || '未配置';
    $('#wxo-hook-secret').textContent = h.secret ? '已设置' : '未设置';
    $('#wxo-hook-events').textContent = (h.events ?? []).join(' / ') || '—';
  }
}

$('#wxo-refresh').addEventListener('click', () => loadWxOverview());
$('#wxo-goto-hook').addEventListener('click', () => showPage('hook'));
$('#wxo-hook-test').addEventListener('click', async (e) => {
  await busy(e.target.closest('button'), '发送中…', async () => {
    const r = await post('/api/wechat/hook/test');
    if (r.ok === false) return setResult('#wxo-hook-result', r.error ?? '发送失败', 'err');
    setResult('#wxo-hook-result', `对端返回 HTTP ${r.status}，连接正常`, 'ok');
  });
});

/* 新手引导：悬浮面板，当前通道 4 步，做完一步亮一个勾，全亮自动收起 */
const WIZARD_KEY = 'dhm-wizard-state'; // 'done' | 'dismissed' | 空
function wizardState() {
  try { return localStorage.getItem(WIZARD_KEY) ?? ''; } catch { return ''; }
}
function wizardMark(v) {
  try { localStorage.setItem(WIZARD_KEY, v); } catch { }
  applyWizardVisibility();
}

function wizardGo(p, page) {
  if (platform() !== p) applyPlatform(p);
  showPage(page);
}

function wizardSteps() {
  const wx = platform() === 'wechat';
  const hasKey = (S.secrets ?? []).some((x) => x.set);
  const prof = S.backend?.profiles?.[platform()]?.chat ?? null;
  const hasSource = Boolean((prof?.baseUrl && prof?.model) || (!wx && S.backend?.modelApi?.baseUrl && S.backend?.modelApi?.model));
  // 第 4 步是“开起来，发条消息试”：通道就绪（NapCat 连着）不等于机器人已经在回话，
  // 必须桥接/微信通道自己在跑，才算走完。
  const running = wx ? S.wechat?.running === true : S.bridge?.running === true;
  if (wx) {
    return [
      { title: '登录微信', desc: '点「去扫码」——这里直接启动微信接入并就地显示二维码，手机微信扫一下', done: S.wechat?.running === true, go: () => openBotSheet(0), btn: '去扫码' },
      { title: '填模型密钥', desc: '在弹出的面板里粘贴 key（厂商控制台复制，只显示一次）。填好自动保存', done: hasKey, go: () => openBotSheet(1), btn: '去填' },
      { title: '选模型和人格', desc: '在弹出的面板里选厂商和模型、挑个人格。选了自动保存', done: hasSource, go: () => openBotSheet(2), btn: '去选' },
      { title: '发条消息试', desc: '面板里确认已登录，然后用手机微信给机器人发一句话。第一次要等模型服务自启（约十几秒）', done: running, go: () => openBotSheet(3), btn: '去启动' }
    ];
  }
  return [
    { title: '登录 QQ', desc: '点「去扫码」——NapCat 没在跑会自动拉起，面板在应用内打开，用手机 QQ 扫一下', done: S.napcat?.reachable === true, go: () => openBotSheet(0), btn: '去扫码' },
    { title: '填模型密钥', desc: '在弹出的面板里粘贴 key，程序自动认厂商（密钥在厂商控制台生成，只显示一次）。填好自动保存', done: hasKey, go: () => openBotSheet(1), btn: '去填' },
    { title: '选模型和人格', desc: '在弹出的面板里选厂商和模型、挑个人格（比如塔菲）。选了自动保存', done: hasSource, go: () => openBotSheet(2), btn: '去选' },
    { title: '开起来，发条消息试', desc: '面板里点「启动这个机器人」，然后用手机 QQ 给它发一句话。没回话就看启动步骤里哪一步打了 ✗', done: running, go: () => openBotSheet(3), btn: '去启动' }
  ];
}

function renderWizard() {
  if (!S) return;
  const steps = wizardSteps();
  const allDone = steps.every((s) => s.done);
  const sub = $('#wizard-float-sub');
  if (sub) sub.textContent = `${platform() === 'wechat' ? '微信' : 'QQ'} 通道 · 填好自动保存，不用点按钮`;
  const firstOpen = steps.findIndex((s) => !s.done);
  $('#wizard').innerHTML = steps
    .map((s, i) => {
      const cls = s.done ? 'done' : i === firstOpen ? 'current' : '';
      return `<div class="wizard-step ${cls}">
        <span class="wizard-num">${s.done ? '✓' : i + 1}</span>
        <div class="wizard-body">
          <strong>${esc(s.title)}</strong>
          <span>${esc(s.desc)}</span>
        </div>
        ${s.done ? '' : `<button class="btn btn-sm btn-ghost" data-wizard="${i}">${esc(s.btn)}</button>`}
      </div>`;
    })
    .join('');
  $$('#wizard [data-wizard]').forEach((b) => {
    b.addEventListener('click', () => steps[Number(b.dataset.wizard)].go());
  });
  applyWizardVisibility(allDone);
}

function applyWizardVisibility(allDone) {
  const box = $('#wizard-float');
  if (!box) return;
  // 在地面板开着时，悬浮卡让位（关掉面板会按原逻辑回来）
  if (botSheetStep !== null) { box.hidden = true; return; }
  const st = wizardState();
  if (st === 'done' || st === 'dismissed') { box.hidden = true; return; }
  if (allDone) {
    // 4 个勾都亮了：让人看清一秒，然后自动收起，以后不再弹
    box.hidden = false;
    wizardMark('done');
    setTimeout(() => { box.hidden = true; }, 1600);
    return;
  }
  box.hidden = false;
}

$('#wizard-close')?.addEventListener('click', () => wizardMark('dismissed'));

/* ══════════════════════════════════════════════════════════════════════════
 * 开机器人在地面板（bot sheet）
 *
 * 引导的四步不再跳页：点哪一步，那一步的操作控件就地展开在这块面板里；
 * 状态（NapCat 连没连上 / 微信二维码 / 有没有 key）跟着轮询实时变，勾自动亮。
 * 后端编排走 /api/bots/start；NapCat 面板在应用内开子窗口（/api/napcat/window）。
 * ══════════════════════════════════════════════════════════════════════════ */

const BS_TITLES = ['登录', '填模型密钥', '选模型和人格', '启动并测试'];

function closeBotSheet() {
  botSheetStep = null;
  const box = $('#bot-sheet');
  if (box) box.hidden = true;
  if (botSheetPoll) {
    clearInterval(botSheetPoll);
    botSheetPoll = null;
  }
  applyWizardVisibility();
}

async function openBotSheet(step) {
  botSheetStep = Math.max(0, Math.min(3, Number(step) || 0));
  $('#bot-sheet').hidden = false;
  if (!S) await refreshState();
  await renderBotSheet();
  applyWizardVisibility(); // 悬浮引导立刻让位，不等下一轮轮询
  if (!botSheetPoll) botSheetPoll = setInterval(() => refreshState(), 3000);
}

$('#bot-sheet-close')?.addEventListener('click', closeBotSheet);

$('#home-setup-qq')?.addEventListener('click', async () => {
  applyPlatform('qq', { animate: true });
  showPage(NAV.qq[0][0]);
  await openBotSheet(0);
});

$('#home-setup-wechat')?.addEventListener('click', async () => {
  applyPlatform('wechat', { animate: true });
  showPage(NAV.wechat[0][0]);
  await openBotSheet(0);
});

async function renderBotSheet() {
  if (botSheetStep === null || !S) return;
  const wx = platform() === 'wechat';
  $('#bot-sheet-title').textContent = `开机器人 · ${wx ? '微信' : 'QQ'} · ${BS_TITLES[botSheetStep]}`;
  const body = $('#bot-sheet-body');
  if (botSheetStep === 0) body.innerHTML = wx ? bsLoginWxHtml() : bsLoginQqHtml();
  else if (botSheetStep === 1) body.innerHTML = bsSecretsHtml();
  else if (botSheetStep === 2) body.innerHTML = await bsModelRoleHtml();
  else body.innerHTML = bsStartHtml();
  bindBotSheet();
  updateBotSheetLive();
}

function bsLoginQqHtml() {
  return `
    <div class="bs-row"><span class="hint">NapCat 状态：</span><strong id="bs-napcat-state">—</strong></div>
    <div class="bs-actions"><button class="btn btn-primary" id="bs-napcat-open">打开 NapCat 面板（没在跑会自动启动）</button></div>
    <p class="hint">NapCat 没在跑会自动拉起（十几秒），扫码和快登都在面板里。这里变成「已连接」就自动打勾。</p>
    <p class="hint">面板若要求登录，粘贴这个 Token：<code class="mono" id="bs-napcat-token">读取中…</code> <button class="btn btn-sm btn-ghost" id="bs-token-copy">复制</button></p>
    <div class="result" id="bs-result-0"></div>`;
}

function bsLoginWxHtml() {
  return `
    <div class="bs-row"><span class="hint">微信接入：</span><strong id="bs-wx-state">—</strong></div>
    <div class="bs-actions"><button class="btn btn-primary" id="bs-wx-start">启动微信接入</button></div>
    <div class="bs-qr"><img id="bs-wx-qr" alt="微信登录二维码" hidden /><div class="hint" id="bs-wx-qr-status"></div></div>
    <p class="hint">二维码四分钟过期；过期了再点一次「启动微信接入」换一张（在跑就不会重复起进程）。</p>
    <div class="result" id="bs-result-0"></div>`;
}

function bsSecretsHtml() {
  const anyKey = (S?.secrets ?? []).some((s) => s.set);
  return `
    <div class="bs-row"><span class="hint">当前状态：</span><strong>${anyKey ? '已有密钥' : '还没有密钥'}</strong></div>
    <textarea class="bs-input" id="bs-imp-text" rows="3" placeholder="把 key 粘进来，一行一条；程序会自动认出是哪家的"></textarea>
    <div class="bs-actions">
      <button class="btn" id="bs-imp-scan">识别</button>
      <button class="btn btn-primary" id="bs-imp-apply" hidden>确认写入</button>
    </div>
    <div id="bs-imp-report"></div>
    <div class="result" id="bs-result-1"></div>`;
}

async function bsModelRoleHtml() {
  const pf = platform();
  const prof = S?.backend?.profiles?.[pf]?.chat ?? {};
  const provOpts = (S?.providers ?? [])
    .map((p) => `<option value="${esc(p.id)}" ${p.id === (prof.provider ?? '') ? 'selected' : ''}>${esc(p.label)}${p.needsKey ? '' : '（无需 key）'}</option>`)
    .join('');
  if (!roleNames.length) {
    const r = await api('/api/roles');
    if (r?.ok !== false) roleNames = r.roles ?? [];
  }
  const cur = await api(`/api/role?platform=${pf}`);
  const curRole = cur?.ok === false ? '' : (cur.role ?? '');
  const roleOpts = roleNames.map((n) => `<option value="${esc(n)}" ${n === curRole ? 'selected' : ''}>${esc(n)}</option>`).join('');
  return `
    <label class="bs-label">厂商</label>
    <select class="bs-input" id="bs-provider"><option value="">自定义 / 中转站</option>${provOpts}</select>
    <div class="hint" id="bs-provider-note"></div>
    <label class="bs-label">接口地址（要填到 /v1 为止）</label>
    <input class="bs-input" id="bs-baseUrl" value="${esc(prof.baseUrl ?? '')}" placeholder="https://open.bigmodel.cn/api/paas/v4" spellcheck="false" />
    <label class="bs-label">模型名</label>
    <div class="bs-inline">
      <input class="bs-input" id="bs-model" value="${esc(prof.model ?? '')}" placeholder="glm-4.5-flash" spellcheck="false" />
      <button class="btn btn-sm" id="bs-models">拉列表</button>
    </div>
    <label class="bs-label">密钥（存过就留空）</label>
    <input class="bs-input" id="bs-apiKey" type="password" placeholder="粘一次就行，之后留空" autocomplete="off" spellcheck="false" />
    <div class="hint" id="bs-key-hint"></div>
    <label class="bs-label">人格</label>
    <select class="bs-input" id="bs-role"><option value="">（不用人格卡）</option>${roleOpts}</select>
    <div class="hint">模型和人格都是改完自动保存（停手 1 秒），不用找保存按钮。</div>
    <div class="result" id="bs-result-2"></div>`;
}

function bsStartHtml() {
  const wx = platform() === 'wechat';
  return `
    <div class="bs-actions"><button class="btn btn-primary" id="bs-start-run">启动这个机器人</button></div>
    <div class="bs-actions"><button class="btn" id="bs-health">链路体检（收不到消息就点它）</button></div>
    <div id="bs-health-result"></div>
    <div id="bs-start-steps"></div>
    <p class="hint">启动完，用手机${wx ? '微信' : 'QQ'}给机器人发一句话试试。收发会出现在下面（几秒刷一次）。</p>
    <div class="bs-msgs" id="bs-msgs"></div>
    <div class="result" id="bs-result-3"></div>`;
}

function bindBotSheet() {
  const step = botSheetStep;
  if (step === 0) {
    $('#bs-napcat-open')?.addEventListener('click', () => openNapcatPanel());
    api('/api/napcat/panel').then((pp) => {
      const el = $('#bs-napcat-token');
      if (!el) return;
      el.textContent = pp?.ok && pp.token ? pp.token : '（NapCat 启动后自动带出）';
    });
    $('#bs-token-copy')?.addEventListener('click', async () => {
      const t = $('#bs-napcat-token')?.textContent ?? '';
      try {
        await navigator.clipboard.writeText(t);
        toast('Token 已复制');
      } catch {
        toast('复制失败，手动选中复制');
      }
    });
    $('#bs-wx-start')?.addEventListener('click', async (e) => {
      await busy(e.target.closest('button'), '启动中…', async () => {
        const r = await post('/api/bots/start', { platform: 'wechat' });
        renderBsSteps($('#bs-result-0'), r);
        await refreshState();
      });
    });
  } else if (step === 1) {
    $('#bs-imp-scan')?.addEventListener('click', async (e) => {
      const text = $('#bs-imp-text').value;
      if (!text.trim()) return setResult('#bs-result-1', '先粘点东西进来', 'err');
      await busy(e.target.closest('button'), '识别中…', async () => {
        const r = await post('/api/providers/import', { text, apply: false });
        if (r.ok === false) return setResult('#bs-result-1', r.error, 'err');
        bsImpReport = r.report ?? [];
        renderImportReport(bsImpReport, $('#bs-imp-report'));
        const good = bsImpReport.filter((x) => x.env && !x.dup).length;
        setResult('#bs-result-1', `识别 ${bsImpReport.length} 行，可导入 ${good} 行 —— 确认后点「确认写入」`, 'ok');
        $('#bs-imp-apply').hidden = false;
      });
    });
    $('#bs-imp-apply')?.addEventListener('click', async (e) => {
      const text = $('#bs-imp-text').value;
      if (!text.trim()) return setResult('#bs-result-1', '先粘点东西进来', 'err');
      const items = bsImpReport ? collectImportItems($('#bs-imp-report')) : [];
      const ok = await confirmBox({
        title: '写入这些 key？',
        text: '会把 key 存进 secrets.json（明文，和现有 key 放一起）。已经存在的 key 会跳过。',
        list: bsImpReport ? bsImpReport.filter((x) => !x.dup).slice(0, 6).map((x) => `${x.env || '（未指定）'} ← ${x.keyMasked}`) : [],
        okLabel: '写入'
      });
      if (!ok) return;
      await busy(e.target.closest('button'), '写入中…', async () => {
        const r = await post('/api/providers/import', { text, apply: true, items });
        if (r.ok === false) return setResult('#bs-result-1', r.error, 'err');
        setResult('#bs-result-1', `写入了 ${r.applied} 条 ✓`, 'saved');
        await refreshState();
      });
    });
  } else if (step === 2) {
    bindBsModelRole();
  } else if (step === 3) {
    $('#bs-start-run')?.addEventListener('click', async (e) => {
      await busy(e.target.closest('button'), '启动中…', async () => {
        const r = await post('/api/bots/start', { platform: platform() });
        renderBsSteps($('#bs-start-steps'), r);
        await refreshState();
      });
    });
    $('#bs-health')?.addEventListener('click', () => runHealthCheck());
  }
}

/* 链路体检：NapCat → 端口 → 桥接 → 白名单 → 模型，逐项人话报结果。
 * 为什么放这：远程支援（帮朋友装）最缺的是「他机器上到底哪断了」，
 * 一键把整条链查完，不用对着日志猜。 */
async function runHealthCheck() {
  const box = $('#bs-health-result');
  if (!box) return;
  box.innerHTML = '<div class="hint">体检中…</div>';
  const r = await api('/api/qq/health');
  if (r?.ok === false) {
    box.innerHTML = `<div class="result err">体检失败：${esc(r.error ?? '未知原因')}</div>`;
    return;
  }
  const mark = (ok) => (ok === true ? '✓' : ok === false ? '✗' : '•');
  box.innerHTML =
    `<div class="hint">${r.bad ? `有 ${r.bad} 项不过，按下面的提示处理` : '全部通过 —— 用另一个 QQ 给机器人发句话试试'}</div>` +
    r.checks
      .map((c) =>
        `<div class="bs-row"><strong>${mark(c.ok)} ${esc(c.title)}</strong>` +
        (c.detail ? `<div class="hint">${esc(c.detail)}</div>` : '') +
        (c.hint ? `<div class="hint">→ ${esc(c.hint)}</div>` : '') +
        `</div>`
      )
      .join('');
}

function renderBsSteps(box, r) {
  if (!box) return;
  const steps = Array.isArray(r?.steps) ? r.steps : [];
  if (steps.length) {
    box.innerHTML = steps
      .map((s) => `<div class="bs-step ${s.ok ? 'ok' : 'bad'}"><span>${s.ok ? '✓' : '✗'}</span><strong>${esc(s.name)}</strong><span class="bs-step-detail">${esc(s.detail ?? '')}</span></div>`)
      .join('');
  } else if (r?.ok === false) {
    box.innerHTML = `<div class="bs-step bad"><span>✗</span><strong>启动失败</strong><span class="bs-step-detail">${esc(r.error ?? '')}</span></div>`;
  }
}

/* 第二步：模型 + 人格（复用模型页的自动保存链与字段语义，聊天档不给工具） */
function bsCollect() {
  const pf = platform();
  const id = $('#bs-provider').value;
  const p = providerById(id);
  const out = {
    provider: id || undefined,
    protocol: p?.protocol ?? S?.backend?.profiles?.[pf]?.chat?.protocol ?? 'openai',
    baseUrl: $('#bs-baseUrl').value.trim(),
    model: $('#bs-model').value.trim()
  };
  if (usesCustomModelEndpoint(out, p)) out.apiKeyEnv = modelProfileKeyEnv(pf, 'chat');
  for (const k of Object.keys(out)) if (out[k] === undefined || out[k] === '') delete out[k];
  return out;
}

function updateBsKeyHint() {
  const el = $('#bs-key-hint');
  if (!el) return;
  const p = providerById($('#bs-provider')?.value);
  const env = usesCustomModelEndpoint({ provider: p?.id, baseUrl: $('#bs-baseUrl')?.value.trim() }, p)
    ? modelProfileKeyEnv(platform(), 'chat')
    : p?.keyEnv;
  if (!env) {
    el.textContent = '自定义接入：key 会存进 secrets.json，界面上只显示有没有，不回显内容。';
    return;
  }
  el.textContent = secretSet(env) ? `已保存 ${env}（留空 = 继续用已存的）` : `还没存 ${env}。粘进来保存一次就行，之后留空。`;
}

async function bsSaveModel() {
  const pf = platform();
  const data = bsCollect();
  if (!data.baseUrl && !data.model) return;
  const mark = sig(data) + '|' + $('#bs-apiKey').value;
  if (autoSavedSig.get(`bs-slot-${pf}`) === mark) return;
  const p = providerById($('#bs-provider').value);
  const key = $('#bs-apiKey').value.trim();
  const previousChat = modelProfiles[pf]?.chat;
  const previousWork = modelProfiles[pf]?.work;
  const workFollowsChat = !previousWork || sameModelRoute(previousChat, previousWork);
  const secretUpdates = {};
  if (key && data.apiKeyEnv) {
    secretUpdates[data.apiKeyEnv] = key;
    if (workFollowsChat) secretUpdates[modelProfileKeyEnv(pf, 'work')] = key;
  } else if (key && p?.keyEnv) {
    secretUpdates[p.keyEnv] = key;
  }
  if (Object.keys(secretUpdates).length) {
    const sr = await post('/api/secrets', secretUpdates);
    if (sr.ok === false) return setResult('#bs-result-2', sr.error ?? '保存密钥失败', 'err');
    if (sr.reloadError) return setResult('#bs-result-2', sr.reloadError, 'err');
  }
  data.allowTools = false; // 聊天档不给工具；工作档同款模型，能力差异在工具清单
  if (!modelProfiles[pf]) modelProfiles[pf] = {};
  modelProfiles[pf].chat = data;
  if (workFollowsChat) {
    modelProfiles[pf].work = {
      ...data,
      ...(data.apiKeyEnv ? { apiKeyEnv: modelProfileKeyEnv(pf, 'work') } : {}),
      allowTools: true
    };
  }
  const poolEntry = data.provider && data.model && !usesCustomModelEndpoint(data)
    ? `${data.provider}/${data.model}`
    : '';
  const r = await post('/api/model-profiles', { profiles: modelProfiles, poolEntry });
  if (r.ok === false) return setResult('#bs-result-2', r.error ?? '保存失败', 'err');
  $('#bs-apiKey').value = '';
  if (data.provider && !data.model) {
    setResult('#bs-result-2', '密钥已保存 ✓ 但模型名还没填 —— 模型池不会出现它，机器人也回不了话。点「拉列表」选一个，或手填（比如 deepseek-chat）。', 'err');
    return;
  }
  if (r.regenerated === false) return setResult('#bs-result-2', `已保存，但生成配置失败：${r.regenError ?? '看日志'}`, 'err');
  autoSavedSig.set(`bs-slot-${pf}`, mark);
  setResult('#bs-result-2', r.botsRestarted ? '已保存 ✓ 服务已重启生效' : '已保存 ✓ 下次服务启动生效', 'saved');
  await refreshState();
}

async function bsSaveRole() {
  const r = await post(`/api/role?platform=${platform()}`, { role: $('#bs-role').value || null });
  if (r.ok === false) setResult('#bs-result-2', r.error, 'err');
}

function bindBsModelRole() {
  const kick = () => scheduleAutoSave('bs-slot', () => bsSaveModel());
  for (const id of ['#bs-provider', '#bs-baseUrl', '#bs-model', '#bs-apiKey']) {
    $(id)?.addEventListener('change', kick);
    $(id)?.addEventListener('input', kick);
  }
  $('#bs-provider')?.addEventListener('change', () => {
    const id = $('#bs-provider').value;
    const p = providerById(id);
    const prev = providerById($('#bs-provider').dataset.prev || '');
    const current = $('#bs-baseUrl').value.trim();
    $('#bs-provider-note').textContent = p?.note ?? (p ? '' : '自己填地址：要填到 /v1 为止，例如 https://your-relay.com/v1');
    // 只在地址为空、或还是上一个厂商的默认地址时才填预设值；
    // 用户手填的中转地址不能被切换厂商这一步悄悄覆盖（缺陷 #3）。
    if (p?.baseUrl && (!current || current === prev?.baseUrl)) $('#bs-baseUrl').value = p.baseUrl;
    if (p?.models?.length && !$('#bs-model').value.trim()) $('#bs-model').value = p.models[0];
    $('#bs-provider').dataset.prev = id;
    updateBsKeyHint();
  });
  $('#bs-models')?.addEventListener('click', async (e) => {
    await busy(e.target.closest('button'), '…', async () => {
      const payload = bsCollect();
      const key = $('#bs-apiKey').value.trim();
      if (key) payload.apiKey = key;
      const r = await post('/api/models', payload);
      if (r.ok === false) return setResult('#bs-result-2', r.error, 'err');
      const models = r.models ?? [];
      if (!models.length) return setResult('#bs-result-2', '服务端没返回模型列表', 'err');
      const pick = await openModal({
        title: `这个地址下有 ${models.length} 个模型`,
        text: '点一个填进「模型名」。',
        choices: models.slice(0, 200).map((m) => ({ value: m, label: m }))
      });
      if (pick) {
        $('#bs-model').value = pick;
        toast(`已选 ${pick}`);
        scheduleAutoSave('bs-slot', () => bsSaveModel());
      }
    });
  });
  $('#bs-role')?.addEventListener('change', () => scheduleAutoSave('bs-role', () => bsSaveRole()));
  updateBsKeyHint();
}

/* 面板开着时的实时刷新：只动状态位，不重建表单（不然打字会被打断） */
function updateBotSheetLive() {
  if (botSheetStep === null) return;
  const wx = platform() === 'wechat';
  if (botSheetStep === 0) {
    if (wx) {
      const w = S?.wechat ?? {};
      const st = $('#bs-wx-state');
      if (st) st.textContent = w.loggedIn ? `已登录${w.botId ? `（${w.botId}）` : ''}` : w.running ? '在跑，等扫码' : '未启动';
      const img = $('#bs-wx-qr');
      if (img) {
        if (w.qr) {
          if (img.getAttribute('src') !== w.qr) img.src = w.qr;
          img.hidden = false;
        } else {
          img.hidden = true;
        }
      }
      const qs = $('#bs-wx-qr-status');
      if (qs) qs.textContent = w.qr ? (w.qrStatus === 'scanned' ? '已扫码，请在手机上确认' : '用手机微信扫一扫') : '';
      const btn = $('#bs-wx-start');
      if (btn) btn.hidden = w.loggedIn === true;
    } else {
      const st = $('#bs-napcat-state');
      if (st) st.textContent = S?.napcat?.reachable ? '已连接' : '未连接';
    }
  } else if (botSheetStep === 3) {
    refreshBsMessages();
  }
}

async function refreshBsMessages() {
  const box = $('#bs-msgs');
  if (!box) return;
  const r = await api(`/api/messages?platform=${platform()}&limit=8`);
  if (!r || r.ok === false) return;
  const entries = (r.entries ?? []).slice(-8);
  box.innerHTML = entries.length
    ? entries
        .map(
          (e) => `<div class="bs-msg ${e.self ? 'self' : ''}"><span class="bs-msg-clock">${esc(e.clock)}</span><span class="bs-msg-who">${esc(e.who)}</span><span class="bs-msg-text">${esc(String(e.text ?? '').slice(0, 90))}</span></div>`
        )
        .join('')
    : '<div class="hint">还没有消息往来 —— 发一条试试。</div>';
}

async function loadOverview() {
  await refreshState();
  renderOverview();
  // 微信在等扫码时刷得勤一点，扫完好立刻变成「已登录」
  if (S?.wechat?.running && !S?.wechat?.loggedIn) startWxPoll();
}

let wxPoll = null;
function startWxPoll() {
  if (wxPoll) return;
  wxPoll = setInterval(async () => {
    const st = await api('/api/state');
    if (!st || st.ok === false) return;
    S = st;
    renderShell();
    if (currentPage === 'overview') {
      renderOverview();
      renderHomeCards();
    } else if (currentPage === 'wx-overview') {
      renderWxOverview();
    }
    if (!st.wechat?.running || st.wechat?.loggedIn) {
      clearInterval(wxPoll);
      wxPoll = null;
    }
  }, 2500);
}

/* 服务启停 */
async function svcAction(kind, act) {
  const paths = {
    napcat: { start: '/api/napcat/start', stop: '/api/napcat/stop' },
    bridge: { start: '/api/bridge/start', stop: '/api/bridge/stop' },
    wechat: { start: '/api/wechat/start', stop: '/api/wechat/stop' }
  };
  const path = paths[kind]?.[act];
  if (!path) return;
  if (act === 'stop') {
    const ok = await confirmBox({
      title: `停止${kind === 'napcat' ? ' NapCat' : kind === 'bridge' ? ' QQ 桥接' : '微信 Bot'}？`,
      text: '停了之后这条线就不收发消息了，重新启动要再点一次。'
    });
    if (!ok) return;
  }
  const out = platform() === 'wechat' ? '#wxo-result' : '#up-result';
  setResult(out, act === 'start' ? '正在启动…' : '正在停止…', 'busy');
  // 微信多账号：登录页的启停按钮作用于当前选中的号
  const r = await post(path, kind === 'wechat' && platform() === 'wechat' ? { account: wxAccount } : {});
  setResult(out, r.ok === false ? r.error : '已执行', r.ok === false ? 'err' : 'ok');
  await new Promise((res) => setTimeout(res, 1200));
  await refreshState();
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-svc]');
  if (b) svcAction(b.dataset.svc, b.dataset.act);
  const g = e.target.closest('[data-goto]');
  if (g) showPage(g.dataset.goto);
});

$('#btn-up').addEventListener('click', async () => {
  // QQ 的总览只开 QQ 这条线，别顺手把微信也拉起来
  const wx = platform() === 'wechat';
  const ok = await confirmBox({
    title: '一键全开？',
    text: wx
      ? '将启动微信 Bot 和它自己的模型实例（4601）。QQ 侧不受影响。已在运行的会跳过。'
      : '将启动 NapCat 与 QQ 桥接（模型实例 4599）；微信侧不受影响，如需启动请前往「微信 → 总览」。',
    okLabel: '开'
  });
  if (!ok) return;
  setResult('#up-result', '正在启动…', 'busy');
  const r = await post('/api/up', { scope: wx ? 'wechat' : 'qq' });
  setResult('#up-result', r.ok === false ? r.error ?? '有服务没起来，看日志' : '已拉起', r.ok === false ? 'err' : 'ok');
  await new Promise((res) => setTimeout(res, 1500));
  await refreshState();
});

$('#btn-down').addEventListener('click', async () => {
  const wx = platform() === 'wechat';
  const ok = await confirmBox({
    title: wx ? '停止微信 Bot？' : '全部停止？',
    text: wx
      ? '仅停止微信 Bot 和它的 4601 模型实例，QQ 侧不受影响；若已开启看护，手动停止不会被立即重新拉起。'
      : '将停止 NapCat、QQ 桥接和 4599 模型实例；微信 Bot 和 4601 实例不受影响。',
    okLabel: wx ? '停' : '全停',
    danger: true
  });
  if (!ok) return;
  setResult('#up-result', '正在停止…', 'busy');
  const r = await post('/api/down', { scope: wx ? 'wechat' : 'qq' });
  setResult('#up-result', r.ok === false ? r.error : '已停止', r.ok === false ? 'err' : 'ok');
  await new Promise((res) => setTimeout(res, 1500));
  await refreshState();
});

$('#btn-refresh').addEventListener('click', () => loadOverview());
$('#btn-goto-backend').addEventListener('click', () => showPage('backend'));

async function openNapcatPanel(accountId = 'qq1') {
  const r = await api(`/api/napcat/window?account=${encodeURIComponent(accountId)}`);
  if (!r.ok) {
    toast(r.error ?? '拿不到 NapCat 面板地址 —— NapCat 可能还没装/没启动，先去「高级」页配好');
    // 只有默认号才引导去「高级」页改全局 NapCat 目录；qq2 的问题通常是还没启动过一次。
    if (accountId === 'qq1') wizardGo('qq', 'advanced');
    return false;
  }
  // inApp = Electron 主进程开了子窗口；裸跑（浏览器模式）回落到新标签
  if (r.inApp) toast('NapCat 面板已在应用内打开（扫码 / 快登都在里面）');
  else window.open(r.url, '_blank');
  return true;
}

$('#btn-napcat-panel').addEventListener('click', () => openNapcatPanel());

/* QQ 多号（NapCat）：添加账号 */
$('#napcat-acc-add')?.addEventListener('click', async () => {
  const qq = ($('#napcat-acc-qq').value || '').trim();
  const label = ($('#napcat-acc-label').value || '').trim();
  const dir = ($('#napcat-acc-dir').value || '').trim();
  if (!dir) return setResult('#napcat-acc-result', '先填这个号自己的 NapCat 目录', 'err');
  if (qq && !/^\d{5,12}$/.test(qq)) return setResult('#napcat-acc-result', 'QQ 号看起来不对', 'err');
  const r = await post('/api/napcat/accounts', { qq, label, dir });
  if (r.ok === false) return setResult('#napcat-acc-result', r.error ?? '添加失败', 'err');
  setResult('#napcat-acc-result', `已添加 ${r.account?.id ?? '新号'}，点列表里的「启动」`, 'saved');
  $('#napcat-acc-qq').value = '';
  $('#napcat-acc-label').value = '';
  $('#napcat-acc-dir').value = '';
  await refreshState();
});

/* QQ 官方机器人多号：添加/编辑保存（启用即启动）和取消编辑 */
function qofResetForm() {
  $('#qof-name').value = '';
  $('#qof-app-id').value = '';
  $('#qof-app-secret').value = '';
  $('#qof-app-secret').placeholder = '新号必填；已保存的留空沿用';
  $('#qof-clear').hidden = true;
}

$('#qof-clear')?.addEventListener('click', () => {
  qofResetForm();
  setResult('#qof-result', '', '');
});

$('#qof-save')?.addEventListener('click', async (e) => {
  await busy(e.target.closest('button'), '保存中…', async () => {
    const appId = $('#qof-app-id').value.trim();
    const secret = $('#qof-app-secret').value.trim();
    if (!/^\d{6,15}$/.test(appId)) return setResult('#qof-result', 'AppID 应该是一串数字', 'err');
    if (!secret) {
      const existing = (S.qqOfficial?.bots ?? []).some((b) => b.appId === appId);
      if (!existing) return setResult('#qof-result', '新号要把 AppSecret 填上', 'err');
    }
    const r = await post('/api/qq-official', {
      appId,
      name: $('#qof-name').value.trim() || undefined,
      ...(secret ? { appSecret: secret } : {}),
      enabled: true
    });
    if (r.ok === false) return setResult('#qof-result', r.error, 'err');
    qofResetForm();
    setResult('#qof-result', '已保存并启动 ✓（等网关连上，几秒内状态更新）', 'saved');
    await refreshState();
  });
});

$$('[data-watch]').forEach((el) => {
  el.addEventListener('change', async () => {
    const key = el.dataset.watch;
    await post('/api/automation', { watch: { [key]: el.checked } });
    toast(el.checked ? `看护已开启：${key} 断开后自动重启` : `看护已关：${key}`);
    await refreshState();
  });
});


/* 更新：只提醒，装不装由人点 */
$('#btn-app-dismiss').addEventListener('click', async () => {
  await post('/api/app/update/dismiss');
  toast('这个版本不再提醒');
  await refreshState();
});

$('#btn-napcat-dismiss').addEventListener('click', async () => {
  await post('/api/napcat/update/dismiss');
  toast('这个版本不再提醒');
  await refreshState();
});

/* 精简包：本机没有 NapCat 时横幅上的「下载并装好」 */
let napcatInstallSkipped = false;

$('#btn-napcat-install-later').addEventListener('click', () => {
  napcatInstallSkipped = true;
  $('#banner-napcat-install').hidden = true;
});

$('#btn-napcat-install').addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  const info = await api('/api/napcat/install');
  if (info.ok === false) return toast(info.error ?? '查不到最新版（网络？）');
  const asset = info.asset;
  if (!asset) return toast('发行版里没找到 Shell 包，去「高级」页调一下匹配规则');
  const ok = await confirmBox({
    title: `下载并安装 NapCat ${info.tag}？`,
    text: '会从 GitHub 下最新版 Shell 包，解压到用户目录（不动安装目录），装完把路径填好。',
    list: [`安装包：${asset.name}（${fmtBytes(asset.size)}）`, '下载前会自动测速，直连和几个镜像里挑最快的', '下载完成后需手动点击「启动」，再通过面板扫码登录'],
    okLabel: '下载并装好'
  });
  if (!ok) return;
  await busy(btn, '下载中…', async () => {
    const r = await post('/api/napcat/install', {});
    if (r.ok === false) {
      toast(r.error ?? '装不上');
      return;
    }
    toast(`NapCat ${r.tag} 装好了`);
    await refreshState();
  });
});

$('#btn-app-update').addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  const info = await api('/api/app/update');
  if (info.ok === false) return toast(info.error ?? '检查失败');
  if (!info.updateAvailable) return toast('已经是最新版');
  const asset = info.picked;
  if (!asset) return toast('发行版里没找到安装包（资产名要含 Setup 并以 .exe 结尾）');
  const ok = await confirmBox({
    title: `安装 ${info.tag}？`,
    text: '下载完成后本程序会自动关闭，安装程序静默装到原来的位置，装完自动重开。',
    list: [`安装包：${asset.name}（${fmtBytes(asset.size)}）`, '下载前自动测速，直连和镜像里挑最快的；「高级」页可固定线路', '当前版本会先退出，聊天服务会中断几秒', '配置和人格都在项目目录里，不受影响'],
    okLabel: '下载并安装'
  });
  if (!ok) return;
  // 下载进度条：apply 请求会一直挂到下载完，另起 1 秒轮询把进度画在横幅里
  const bar = $('#app-update-progress');
  const fill = $('#app-update-pct');
  const label = $('#app-update-progress-text');
  bar.hidden = false;
  fill.style.width = '0%';
  const poll = setInterval(async () => {
    const p = await api('/api/app/update/progress');
    if (!p.active) return;
    fill.style.width = `${p.pct}%`;
    label.textContent = p.total ? `${p.note}（${fmtBytes(p.got)} / ${fmtBytes(p.total)}）` : (p.note ?? '');
  }, 1000);
  try {
    await busy(btn, '下载中…', async () => {
      const r = await post('/api/app/update/apply', { assetUrl: asset.url });
      if (r.ok === false) toast(r.error ?? '安装失败');
      else toast('安装程序已启动，本程序马上退出');
    });
  } finally {
    clearInterval(poll);
    bar.hidden = true;
  }
});

$('#btn-napcat-update').addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  const info = await api('/api/napcat/update');
  if (info.ok === false) return toast(info.error ?? '检查失败');
  if (!info.updateAvailable) return toast('NapCat 已经是最新版');
  if (!info.assets?.length) return toast('这个发行版没有可下载的资产');
  // 让用户从资产列表里挑，默认选中按规则匹配到的那个 —— 规则可能挑错
  const choices = info.assets.map((a) => ({
    value: a.url,
    label: `${a.name}（${fmtBytes(a.size)}）${info.picked?.url === a.url ? ' · 推荐' : ''}`
  }));
  const pick = await openModal({
    title: `NapCat ${info.tag}：选要装的包`,
    text: `当前：${info.current || '未知'}。推荐项是按「Shell 压缩包」规则挑的，挑错了装不上会提示。`,
    choices
  });
  if (!pick) return;
  const asset = info.assets.find((a) => a.url === pick);
  const ok = await confirmBox({
    title: '开始安装 NapCat？',
    text: '会下载、解压到旁边一个新目录，然后把配置指过去并重启 NapCat。原目录保留，随时能退回去。',
    list: [`安装包：${asset.name}（${fmtBytes(asset.size)}）`, 'NapCat 会重启一次，可能要重新确认登录'],
    okLabel: '下载并安装'
  });
  if (!ok) return;
  await busy(btn, '下载中…', async () => {
    const r = await post('/api/napcat/update/apply', { assetUrl: asset.url });
    if (r.ok === false) toast(r.error ?? '安装失败');
    else toast(`已更新到 ${r.tag}${r.restarted ? '，NapCat 已重启' : ''}`);
    await refreshState();
  });
});

/* ── 4. API 与模型 ──────────────────────────────────── */

let poolDraft = null;
let sourceDraft = null;

function providerById(id) {
  return (S?.providers ?? []).find((p) => p.id === id) ?? null;
}

/** 本机探测到的某个本地服务（可能没在跑）。 */
function localServerFor(id) {
  return (S?.localModelServers ?? []).find((x) => x.id === id) ?? null;
}

/** 本机服务里能拿去聊天的模型：过滤掉 embedding。 */
function localChatModels(id) {
  const models = localServerFor(id)?.models ?? [];
  const chat = models.filter((m) => !/embed|bge|gte|(^|[-_/])e5([-_/]|$)/i.test(String(m)));
  return chat.length ? chat : models;
}

/** 切厂商时优先用真实探测到的模型，而不是厂商表里的示例占位。 */
function preferredModelFor(id) {
  const local = localChatModels(id);
  if (local.length) return local[0];
  const preset = providerById(id);
  return preset?.models?.[0] ?? '';
}

/** 模型输入框的候选：本机真实模型 + 厂商示例 + 当前已保存的值。 */
function refreshModelSuggestions(s) {
  const list = document.getElementById(`${s}-model-suggest`);
  if (!list) return;
  list.innerHTML = '';
  const seen = new Set();
  const add = (value) => {
    const v = String(value ?? '').trim();
    if (!v || seen.has(v)) return;
    seen.add(v);
    const opt = document.createElement('option');
    opt.value = v;
    list.appendChild(opt);
  };
  for (const server of S?.localModelServers ?? []) {
    // 聊天输入框只推荐能聊的模型；embedding 模型留在服务按钮的 title 里。
    for (const model of localChatModels(server.id)) add(model);
  }
  const provider = providerById(document.getElementById(`${s}-provider`)?.value);
  for (const model of provider?.models ?? []) add(model);
  add(document.getElementById(`${s}-model`)?.value);

  const hint = document.getElementById(`${s}-model-source-hint`);
  if (hint) {
    const running = (S?.localModelServers ?? []).filter((x) => x.running && x.models?.length);
    hint.textContent = running.length
      ? `本机已探测到：${running.map((x) => `${x.label} ${x.models.length} 个`).join(' · ')}。输入框里可以直接选。`
      : '没探测到正在运行的本机模型服务；也可以手填模型名。';
  }
}

function secretSet(env) {
  if (!env) return false;
  return (S?.secrets ?? []).some((s) => s.env === env && s.set);
}

function modelProfileKeyEnv(pf, slot) {
  return `DHM_MODEL_${String(pf).toUpperCase()}_${String(slot).toUpperCase()}_API_KEY`;
}

function usesCustomModelEndpoint(profile, preset = providerById(profile?.provider)) {
  if (!preset || preset.id === 'custom') return true;
  // 本地服务商 / MiniMax / 火山方舟由生成器按自己的 provider id 写定义，
  // 即使换了端口也不需要再套一层 dhm-<slot>-relay，仍然可以进模型池。
  if (['lmstudio', 'ollama', 'vllm', 'llamacpp', 'jan', 'minimax', 'volcengine'].includes(preset.id)) return false;
  return Boolean(profile?.baseUrl && preset.baseUrl && profile.baseUrl !== preset.baseUrl);
}

function sameModelRoute(left, right) {
  return Boolean(left && right) &&
    ['provider', 'protocol', 'baseUrl', 'model', 'apiKeyEnv']
      .every((key) => String(left[key] ?? '') === String(right[key] ?? ''));
}

function renderProviders(s) {
  const sel = $(`#${s}-provider`);
  // 厂商表里也有 custom（直连后端要用），这里首项已经手写了，过滤掉免得出现两个
  const list = (S?.providers ?? []).filter((p) => p.id !== 'custom');
  // 第一项用 custom 而不是空串：空 provider 在配置生成器那边等于"没配"（档位会被
  // 静默丢掉），只有显式 custom 才会把 baseUrl 写进 opencode.json 的 provider 段。
  sel.innerHTML =
    `<option value="custom">自定义 / 中转站</option>` +
    list.map((p) => `<option value="${esc(p.id)}">${esc(p.label)}${p.needsKey ? '' : '（无需 key）'}</option>`).join('');
}

/**
 * 厂商切换。
 *
 * force=true 是「用户真的换了一家」：地址、协议、模型都必须跟着换，
 * 不能因为输入框里还留着上一家的值就什么都不做（0.5.5 的回归）。
 * force=false 是「把已保存的配置填回表单」：用户手填的地址/模型要保留。
 */
function applyProvider(s, id, { force = false } = {}) {
  const p = providerById(id);
  const note = document.getElementById(`${s}-provider-note`);
  if (note) note.textContent = p?.note ?? (p ? '' : '自己填地址：要填到 /v1 为止，例如 https://your-relay.com/v1');
  const protocol = document.getElementById(`${s}-protocol`);
  const baseUrl = document.getElementById(`${s}-baseUrl`);
  const model = document.getElementById(`${s}-model`);
  if (!p) {
    updateKeyHint(s);
    return;
  }

  if (force) {
    if (id === 'custom') {
      // 切到自定义时清掉上一家的地址和模型，避免把 A 家的模型发到 B 家。
      if (protocol) protocol.value = 'openai';
      if (baseUrl) baseUrl.value = '';
      if (model) model.value = '';
    } else {
      if (protocol && p.protocol) protocol.value = p.protocol;
      if (baseUrl) baseUrl.value = p.baseUrl ?? '';
      if (model) model.value = preferredModelFor(id);
    }
  } else {
    if (protocol && p.protocol && !protocol.value) protocol.value = p.protocol;
    if (baseUrl && p.baseUrl && !baseUrl.value.trim()) baseUrl.value = p.baseUrl;
    if (model && !model.value.trim()) model.value = preferredModelFor(id);
  }
  updateKeyHint(s);
  refreshModelSuggestions(s);
}

function updateKeyHint(s) {
  const p = providerById($(`#${s}-provider`).value);
  const profile = { provider: p?.id, baseUrl: $(`#${s}-baseUrl`).value.trim() };
  const env = usesCustomModelEndpoint(profile, p) ? modelProfileKeyEnv(platform(), s) : p?.keyEnv;
  if (!env) {
    $(`#${s}-key-hint`).textContent = '自定义接入：key 会存进 secrets.json，界面上只显示有没有，不回显内容。';
    return;
  }
  const set = secretSet(env);
  $(`#${s}-key-hint`).textContent = set
    ? `已保存 ${env}（留空 = 继续用已存的）`
    : `还没存 ${env}。粘进来保存一次就行，之后留空。`;
}

function renderLocalServers(s) {
  const box = $(`#${s}-local-servers`);
  const list = S?.localModelServers ?? [];
  if (!list.length) {
    box.innerHTML = '<span class="hint">没探测到本机模型服务。</span>';
    return;
  }
  box.innerHTML = list
    .map((x) => {
      const models = x.models ?? [];
      const chatModels = localChatModels(x.id);
      const first = chatModels[0] ?? '';
      const title = models.length ? models.slice(0, 12).join('\n') + (models.length > 12 ? `\n…共 ${models.length} 个` : '') : '';
      return `<button class="btn btn-sm ${x.running ? '' : 'btn-ghost'}" data-local="${esc(x.id)}" ${x.running ? '' : 'disabled'} title="${esc(title)}">
        <span class="led ${x.running ? 'on' : ''}" style="margin-right:2px"></span>${esc(x.label)}${
          x.running
            ? ` · ${chatModels.length ? `${chatModels.length} 个模型${first ? `（${esc(first)}）` : ''}` : '已连上'}`
            : x.installed ? ' · 没在跑' : ' · 没装'
        }
      </button>`;
    })
    .join('');
  $$(`#${s}-local-servers [data-local]`).forEach((b) => {
    b.addEventListener('click', () => {
      const x = list.find((y) => y.id === b.dataset.local);
      if (!x) return;
      // 以前这里把 provider 清成空串。空 provider 在配置生成器那边等于"没配"，
      // 整档被静默丢掉 —— 界面显示填好了，opencode.json 里一个字都没有。
      // 本地探测项的 id 和厂商表是同一套（ollama / lmstudio / vllm / llamacpp / jan），直接选上。
      const sel = $(`#${s}-provider`);
      const has = Array.from(sel.options).some((o) => o.value === x.id);
      sel.value = has ? x.id : 'custom';
      applyProvider(s, sel.value, { force: true });
      $(`#${s}-baseUrl`).value = x.baseUrl;
      const picked = localChatModels(x.id)[0] ?? x.models?.[0] ?? '';
      if (picked) $(`#${s}-model`).value = picked;
      if (!$(`#${s}-apiKey`).value) $(`#${s}-apiKey`).value = 'local';
      refreshModelSuggestions(s);
      toast(picked ? `已填入 ${x.label} · ${picked}` : `已填入 ${x.label} 的地址，模型还没选`);
      // 程序化改值不会触发 change，手动发一次，让自动保存/重启链路跑起来。
      // 只发地址/模型：再发 provider 会走一遍 force 覆盖，反而把刚填的值洗掉。
      for (const name of ['baseUrl', 'model']) {
        document.getElementById(`${s}-${name}`)?.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
  });
}

/* ── 本机服务一键切换提示 ──────────────────────────────
 *
 * 探测到本机有在跑的模型服务、而当前平台的模型配置没有指向它时，横幅给一个
 * 「一键切换」：填表 + 点保存并应用，一气呵成。忽略过的地址记在 localStorage，
 * 同一个服务不再弹第二次；探测结果每 6 秒跟着状态刷新。
 */
const LOCAL_SUGGEST_KEY = 'dhm-local-suggest-dismissed';

function dismissedLocalSuggest() {
  try {
    return new Set(JSON.parse(localStorage.getItem(LOCAL_SUGGEST_KEY) ?? '[]'));
  } catch {
    return new Set();
  }
}

function localSuggestApply(x) {
  const sel = document.getElementById('chat-provider');
  const has = sel && Array.from(sel.options).some((o) => o.value === x.id);
  if (sel) sel.value = has ? x.id : 'custom';
  applyProvider('chat', sel.value, { force: true });
  const baseUrl = document.getElementById('chat-baseUrl');
  if (baseUrl) baseUrl.value = x.baseUrl;
  const picked = localChatModels(x.id)[0] ?? x.models?.[0] ?? '';
  const model = document.getElementById('chat-model');
  if (model && picked) model.value = picked;
  const key = document.getElementById('chat-apiKey');
  if (key && !key.value) key.value = 'local';
  refreshModelSuggestions('chat');
  // 程序化改值不触发 change，发事件让自动保存链路知道；再点「保存并应用」走完整保存
  for (const name of ['baseUrl', 'model']) {
    document.getElementById(`chat-${name}`)?.dispatchEvent(new Event('change', { bubbles: true }));
  }
  document.getElementById('chat-btn-save-model')?.click();
  toast(`正在切换到 ${x.label}${picked ? ` · ${picked}` : ''}…`);
}

function renderLocalModelBanner() {
  const banner = document.getElementById('banner-local-model');
  if (!banner) return;
  const running = (S?.localModelServers ?? []).filter((x) => x.running && localChatModels(x.id).length);
  const profile = modelProfilesLoaded ? modelProfiles?.[platform()]?.chat ?? null : null;
  const curBase = String(profile?.baseUrl ?? '').trim().replace(/\/$/, '');
  const current = profile
    ? running.find((x) => profile.provider === x.id && (!curBase || curBase === x.baseUrl.replace(/\/$/, '')))
    : null;
  const dismissed = dismissedLocalSuggest();
  const offered = running.filter((x) => (!current || x.id !== current.id) && !dismissed.has(`${x.id}|${x.baseUrl}`));
  const actions = document.getElementById('local-model-actions');
  const title = document.getElementById('local-model-title');
  const sub = document.getElementById('local-model-sub');
  if (!actions || !title || !sub) return;
  if (!offered.length) {
    banner.hidden = true;
    return;
  }
  banner.hidden = false;
  title.textContent = current ? '本机还有别的模型服务在跑' : '检测到本机模型服务，一键就能用';
  sub.textContent = offered
    .map((x) => `${x.label}（${localChatModels(x.id).length} 个模型 · ${localChatModels(x.id)[0]}）`)
    .join(' · ') + ' —— 点「一键切换」自动填好并保存生效，不用手动搬地址和模型名。';
  actions.innerHTML = '';
  for (const x of offered) {
    const btn = document.createElement('button');
    btn.className = 'btn btn-sm btn-primary';
    btn.textContent = `一键切换到 ${x.label}`;
    btn.addEventListener('click', () => localSuggestApply(x));
    actions.appendChild(btn);
  }
  const later = document.createElement('button');
  later.className = 'btn btn-sm btn-ghost';
  later.textContent = '忽略';
  later.title = '这些服务地址不再提醒（换了地址或新服务会再提示）';
  later.addEventListener('click', () => {
    dismissLocalSuggest(offered.map((x) => `${x.id}|${x.baseUrl}`));
    banner.hidden = true;
  });
  actions.appendChild(later);
}

/** models 页开着时的轻刷新：只重画探测 chips / 模型候选 / 提示横幅，不动表单。 */
function refreshModelsLive() {
  if (currentPage !== 'models') return;
  for (const def of SLOT_DEFS) {
    if (!document.getElementById(`${def.key}-local-servers`)) continue;
    renderLocalServers(def.key);
    refreshModelSuggestions(def.key);
  }
  renderLocalModelBanner();
}

function collectSource(s) {
  const el = (name) => document.getElementById(`${s}-${name}`);
  const num = (name) => {
    const input = el(name);
    const raw = (input?.value ?? '').trim();
    if (raw === '') {
      if (input?.validity?.badInput) {
        input.setCustomValidity('请输入有效数字，或清空此项');
        input.reportValidity();
        throw new Error(`${name} 必须是有效数字`);
      }
      input?.setCustomValidity('');
      return undefined;
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      input?.setCustomValidity('请输入有效数字，或清空此项');
      input?.reportValidity();
      throw new Error(`${name} 必须是有效数字`);
    }
    input?.setCustomValidity('');
    return n;
  };
  const out = {
    provider: el('provider').value || undefined,
    protocol: el('protocol').value,
    baseUrl: el('baseUrl').value.trim(),
    model: el('model').value.trim(),
    temperature: num('temperature'),
    maxTokens: num('maxTokens'),
    maxHistory: num('maxHistory'),
    timeoutMs: num('timeoutMs'),
    maxContextChars: num('maxContextChars'),
    anthropicVersion: el('anthropicVersion').value.trim() || undefined,
    allowTools: el('modelAllowTools')?.checked === true,
    maxToolRounds: num('maxToolRounds'),
    workspaceDir: el('workspaceDir')?.value.trim() || undefined
  };
  if (usesCustomModelEndpoint(out)) out.apiKeyEnv = modelProfileKeyEnv(platform(), s);
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

function fillSource(s, ma) {
  const m = ma ?? {};
  const el = (name) => document.getElementById(`${s}-${name}`);
  renderProviders(s);
  // 空 provider 显示成「自定义 / 中转站」（老配置就是这么存的）。
  // 另外：手写的 provider 名（deepseek-official 之类）不在下拉里，直接赋 value 会被
  // select 洗成空串，再保存一次这个档就废了 —— 补一个临时 option 接住它。
  const pv = m.provider || 'custom';
  el('provider').value = pv;
  if (el('provider').value !== pv && pv) {
    const opt = document.createElement('option');
    opt.value = pv;
    opt.textContent = `${pv}（手写）`;
    el('provider').appendChild(opt);
    el('provider').value = pv;
  }
  el('provider').dataset.prev = pv;
  el('protocol').value = m.protocol ?? 'openai';
  el('baseUrl').value = m.baseUrl ?? '';
  el('model').value = m.model ?? '';
  el('temperature').value = m.temperature ?? '';
  el('maxTokens').value = m.maxTokens ?? '';
  el('maxHistory').value = m.maxHistory ?? '';
  el('timeoutMs').value = m.timeoutMs ?? '';
  el('maxContextChars').value = m.maxContextChars ?? '';
  el('anthropicVersion').value = m.anthropicVersion ?? '';
  if (el('modelAllowTools')) el('modelAllowTools').checked = m.allowTools === true;
  if (el('maxToolRounds')) el('maxToolRounds').value = m.maxToolRounds ?? '';
  if (el('workspaceDir')) el('workspaceDir').value = m.workspaceDir ?? '';
  if (el('model-tools-warn')) el('model-tools-warn').hidden = m.allowTools !== true;
  applyProvider(s, el('provider').value);
  updateKeyHint(s);
  refreshModelSuggestions(s);
}

/* ── 模型配置（单一一份）──────────────────────────────────────────────
 * 两块同时显示，各有自己的表单和保存按钮 —— 不是切换模式，也不是开关。
 * 配置落在 config.json 的 backend.profiles 下，QQ 和微信各一套。
 */
const SLOT_DEFS = [
  // 0.4.1 起只有一份模型配置：机器人的大脑就一个。「只聊天 / 可以干活」的差异
  // 全在工具清单里配（对话与人格页），不再让人配两遍模型。
  { key: 'chat', title: '模型', hint: '机器人的大脑，一份就够。保存后自动加进下面模型池首位。只聊天/可以干活在「对话与人格」页勾。', tools: false }
];

async function loadModelProfiles() {
  const r = await api('/api/model-profiles');
  if (r?.ok) {
    modelProfiles = r.profiles ?? { qq: {}, wechat: {} };
    modelProfilesLoaded = true;
  }
}

/* 推理等级（全局）：config.json 的 dsh.reasoningEffort。
 * 桥接在跑时走它的热切换接口，下一条消息生效；没跑就只写配置，下次启动生效。 */
async function loadReasoning() {
  const sel = $('#reasoning-effort');
  const hint = $('#reasoning-hint');
  if (!sel) return;
  const r = await api('/api/reasoning');
  if (r?.ok === false) {
    if (hint) hint.textContent = r.error ?? '读取失败';
    return;
  }
  sel.value = r.effort ?? 'max';
  if (hint) hint.textContent = `当前 ${sel.value}。改完自动保存，下一条消息生效。`;
}

async function saveReasoning() {
  const sel = $('#reasoning-effort');
  const hint = $('#reasoning-hint');
  if (!sel) return;
  const effort = sel.value;
  if (hint) hint.textContent = '保存中…';
  const r = await post('/api/reasoning', { effort });
  if (r?.ok === false) {
    if (hint) hint.textContent = r.error ?? '保存失败';
    return;
  }
  if (hint) {
    hint.textContent = r.applied === false
      ? `已保存 ${effort}，桥接下次启动生效`
      : `已保存 ${effort}，下一条消息生效`;
  }
}

$('#reasoning-effort')?.addEventListener('change', saveReasoning);

function profileOf(slot) {
  return modelProfiles?.[platform()]?.[slot] ?? null;
}

/** 从模板克隆出两块面板，插进 #slot-panels。只跑一次。 */
function buildSlotPanels() {
  const tpl = document.getElementById('tpl-source-panel');
  const box = document.getElementById('slot-panels');
  if (!tpl || !box || box.childElementCount) return;

  for (const def of SLOT_DEFS) {
    const frag = tpl.content.cloneNode(true);
    const panel = frag.querySelector('.panel');
    panel.id = `panel-slot-${def.key}`;
    panel.dataset.slot = def.key;

    panel.querySelector('.panel-head h2').textContent = def.title;
    panel.querySelector('.panel-head .hint').textContent = def.hint;

    // id 与 for 统一加前缀，两块互不干扰
    panel.querySelectorAll('[id]').forEach((el) => { el.id = `${def.key}-${el.id}`; });
    panel.querySelectorAll('[for]').forEach((el) => {
      const f = el.getAttribute('for');
      if (f) el.setAttribute('for', `${def.key}-${f}`);
    });
    // datalist 的 list= 属性也要跟着加前缀，否则会指向模板里不存在的全局 id。
    panel.querySelectorAll('[list]').forEach((el) => {
      const l = el.getAttribute('list');
      if (l) el.setAttribute('list', `${def.key}-${l}`);
    });

    // 普通聊天不给工具：整块拿掉，不留一个配了也不生效的开关
    if (!def.tools) panel.querySelector(`#${def.key}-tools-block`)?.remove();
    // 说明已经写在板块标题上，模板里那条不需要
    panel.querySelector(`#${def.key}-chat-slot-note`)?.remove();

    const save = panel.querySelector(`#${def.key}-btn-save-model`);
    if (save) {
      save.hidden = false;
      save.textContent = '保存并应用';
    }

    // 默认选中第一块，让人一眼看出这是两块独立配置
    if (def.key === SLOT_DEFS[0].key) panel.classList.add('is-active');

    box.appendChild(frag);
  }
}

/** 把两块表单的内容收进草稿 */
function stashAllSlots() {
  if (!modelProfilesLoaded) return;
  const pf = platform();
  if (!modelProfiles[pf]) modelProfiles[pf] = {};
  for (const def of SLOT_DEFS) {
    const v = collectSource(def.key);
    if (v.baseUrl || v.model) modelProfiles[pf][def.key] = v;
    else delete modelProfiles[pf][def.key];
  }
}

/** 把草稿填回两块表单 */
function fillAllSlots() {
  for (const def of SLOT_DEFS) fillSource(def.key, profileOf(def.key));
}

/* ── 自动保存：改了就存，不再单独点保存 ─────────────── */
const autoSaveTimers = new Map();
const autoSavedSig = new Map();
let autoSaveChain = Promise.resolve();
const sig = (o) => JSON.stringify(o);
function scheduleAutoSave(key, run) {
  clearTimeout(autoSaveTimers.get(key));
  autoSaveTimers.set(key, setTimeout(() => {
    autoSaveChain = autoSaveChain.then(run).catch(() => { });
  }, 900));
}

/* 两块面板各自绑定：所有 id 都带前缀，互不干扰。只绑一次。 */
function bindSlotEvents() {
  if (bindSlotEvents.done) return;
  bindSlotEvents.done = true;
  for (const def of SLOT_DEFS) {
    const s = def.key;
    const el = (n) => document.getElementById(`${s}-${n}`);
    const res = `#${s}-test-result`;

    el('provider')?.addEventListener('change', (e) => {
      applyProvider(s, e.target.value, { force: true });
      refreshModelSuggestions(s);
      renderModelHero();
    });

    el('modelAllowTools')?.addEventListener('change', (e) => {
      const w = el('model-tools-warn');
      if (w) w.hidden = !e.target.checked;
    });

    el('btn-toggle-key')?.addEventListener('click', (e) => {
      const input = el('apiKey');
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      e.target.closest('button').textContent = show ? '隐藏' : '显示';
    });

    el('btn-models')?.addEventListener('click', async (e) => {
      const btn = e.target.closest('button');
      await busy(btn, '…', async () => {
        const payload = collectSource(s);
        const key = el('apiKey').value.trim();
        if (key) payload.apiKey = key;
        const r = await post('/api/models', payload);
        if (r.ok === false) return setResult(res, r.error, 'err');
        const models = r.models ?? [];
        if (!models.length) return setResult(res, '服务端没返回模型列表', 'err');
        const pick = await openModal({
          title: `这个地址下有 ${models.length} 个模型`,
          text: '点一个填进「模型」。',
          choices: models.slice(0, 200).map((m) => ({ value: m, label: m }))
        });
        if (pick) {
          el('model').value = pick;
          refreshModelSuggestions(s);
          renderModelHero();
          toast(`已选 ${pick}`);
        }
        setResult(res, `拉到 ${models.length} 个模型`, 'ok');
      });
    });

    el('btn-test')?.addEventListener('click', async (e) => {
      const btn = e.target.closest('button');
      await busy(btn, '测试中…', async () => {
        const payload = collectSource(s);
        const key = el('apiKey').value.trim();
        if (key) payload.apiKey = key;
        const r = await post('/api/test', payload);
        if (r.ok === false) return setResult(res, r.error, 'err');
        setResult(res, `通了：${r.model} · 首字 ${r.firstCharMs ?? '—'}ms · 共 ${r.totalMs}ms`, 'ok');
      });
    });

    // 自动保存：厂商/地址/模型/密钥改了就存，存完立刻生效（跑着的服务自动重启）。
    // 旧的「保存」按钮已隐藏 —— 不再需要单独点保存。
    const slotSig = () => sig(collectSource(s)) + '|' + el('apiKey').value;
    async function saveSlotAuto({ force = false } = {}) {
      const data = collectSource(s);
      const key = el('apiKey').value.trim();
      const mark = slotSig();
      if (!force && autoSavedSig.get(`slot-${platform()}-${s}`) === mark) return;
      const pf = platform();
      if (!data.baseUrl && !data.model) {
        const previousChat = modelProfiles[pf]?.chat;
        const previousWork = modelProfiles[pf]?.work;
        const workFollowsChat = !previousWork || sameModelRoute(previousChat, previousWork);
        if (!modelProfiles[pf]?.[s]) return;
        delete modelProfiles[pf][s];
        if (s === 'chat' && workFollowsChat) delete modelProfiles[pf].work;
        const updates = [{ platform: pf, slot: s, profile: null }];
        if (s === 'chat' && workFollowsChat) updates.push({ platform: pf, slot: 'work', profile: null });
        const cleared = await post('/api/model-profiles', { profiles: modelProfiles, updates });
        if (cleared.ok === false) return setResult(res, cleared.error ?? '清除失败', 'err');
        autoSavedSig.set(`slot-${pf}-${s}`, mark);
        if (cleared.regenerated === false) return setResult(res, `已清除，但生成配置失败：${cleared.regenError ?? '看日志'}`, 'err');
        setResult(res, cleared.botsRestarted ? '已清除 ✓ 服务已重启生效' : '已清除 ✓ 下次服务启动生效', 'saved');
        await refreshState();
        await loadModelProfiles();
        renderModelHero();
        return;
      }
      const p = providerById(el('provider').value);
      const previousChat = modelProfiles[pf]?.[s];
      const previousWork = modelProfiles[pf]?.work;
      const workFollowsChat = !previousWork || sameModelRoute(previousChat, previousWork);
      const secretUpdates = {};
      if (key && data.apiKeyEnv) {
        secretUpdates[data.apiKeyEnv] = key;
        if (s === 'chat' && workFollowsChat) {
          secretUpdates[modelProfileKeyEnv(pf, 'work')] = key;
        }
      } else if (key && p?.keyEnv) {
        secretUpdates[p.keyEnv] = key;
      }
      if (Object.keys(secretUpdates).length) {
        const sr = await post('/api/secrets', secretUpdates);
        if (sr.ok === false) return setResult(res, sr.error ?? '保存密钥失败', 'err');
        if (sr.reloadError) return setResult(res, sr.reloadError, 'err');
      }
      if (s === 'chat') {
        data.allowTools = false;
        delete data.maxToolRounds;
        delete data.workspaceDir;
      }
      if (!modelProfiles[pf]) modelProfiles[pf] = {};
      modelProfiles[pf][s] = data;
      // 新安装默认让工作档跟随聊天档；已有独立工作档（尤其不同中转地址/key）不覆盖。
      if (s === 'chat' && workFollowsChat) {
        modelProfiles[pf].work = {
          ...data,
          ...(data.apiKeyEnv ? { apiKeyEnv: modelProfileKeyEnv(pf, 'work') } : {}),
          allowTools: true
        };
      }
      const updates = [{ platform: pf, slot: s, profile: data }];
      if (s === 'chat' && workFollowsChat) {
        updates.push({ platform: pf, slot: 'work', profile: modelProfiles[pf].work });
      }
      // 用户预期：填的模型直接进模型池首位。自定义中转站（无 provider 名）不进池
      const poolEntry = data.provider && data.model && !usesCustomModelEndpoint(data)
        ? `${data.provider}/${data.model}`
        : '';
      const r = await post('/api/model-profiles', { profiles: modelProfiles, updates, poolEntry });
      el('apiKey').value = '';
      if (r.ok === false) return setResult(res, r.error ?? '保存失败', 'err');
      el('apiKey').value = '';
      if (r.regenerated === false) return setResult(res, `已自动保存，但生成配置失败：${r.regenError ?? '看日志'}`, 'err');
      autoSavedSig.set(`slot-${platform()}-${s}`, mark);
      setResult(res, r.botsRestarted ? '已保存 ✓ 服务已重启生效' : '已保存 ✓ 下次服务启动生效', 'saved');
      await refreshState();
      await loadModelProfiles();
      renderModelHero();
    }
    el('btn-save-model')?.addEventListener('click', async (e) => {
      const btn = e.target.closest('button');
      await busy(btn, '保存中…', async () => {
        await saveSlotAuto({ force: true });
      });
    });

    // 只在 change（失焦/选完）时保存。以前绑 input，用户每敲一个字符就
    // 触发一次自动保存 + 重启服务，模型名还没输完桥接已经被重启好几轮。
    for (const f of ['provider', 'baseUrl', 'model', 'apiKey']) {
      const node = el(f);
      if (!node) continue;
      node.addEventListener('change', () => scheduleAutoSave(`slot-${s}`, () => saveSlotAuto()));
      // 摘要跟着输入实时更新，不用等 900ms 的自动保存。
      node.addEventListener('input', renderModelHero);
      node.addEventListener('change', renderModelHero);
    }
  }

  // 点哪块哪块高亮，另一块退回灰色
  document.getElementById('slot-panels')?.addEventListener('click', (e) => {
    const p = e.target.closest('.panel[data-slot]');
    if (!p) return;
    document.querySelectorAll('#slot-panels > .panel').forEach((x) => {
      x.classList.toggle('is-active', x === p);
    });
  });
}

/* 模型池 */
function refreshPoolSuggestions() {
  const list = document.getElementById('pool-model-suggest');
  if (!list) return;
  list.innerHTML = '';
  const seen = new Set();
  const add = (value) => {
    const v = String(value ?? '').trim();
    if (!v || !v.includes('/') || seen.has(v)) return;
    seen.add(v);
    const opt = document.createElement('option');
    opt.value = v;
    list.appendChild(opt);
  };
  for (const server of S?.localModelServers ?? []) {
    for (const model of localChatModels(server.id)) add(`${server.id}/${model}`);
  }
  for (const provider of S?.providers ?? []) {
    for (const model of provider.models ?? []) add(`${provider.id}/${model}`);
  }
  for (const slots of Object.values(modelProfiles ?? {})) {
    for (const slot of ['chat', 'work']) {
      const p = slots?.[slot];
      if (p?.provider && p?.model) add(`${p.provider}/${p.model}`);
    }
  }
  for (const id of [...(poolDraft?.free ?? []), ...(poolDraft?.paid ?? [])]) add(id);
}

/** 裸模型名能不能对上本机在跑的本地服务（ollama/lmstudio/…）？对上返回服务 id。 */
function localModelForBare(id) {
  const bare = String(id ?? '').split('#')[0].trim();
  if (!bare || bare.includes('/')) return null;
  const servers = S?.localModelServers ?? [];
  const running = servers.filter((x) => x.running);
  for (const x of [...running, ...servers]) {
    if ((x.models ?? []).some((m) => String(m).split('#')[0] === bare)) return x.id;
  }
  return null;
}

/** 模型池条目必须是 `provider/model`。例外：本机服务里真实存在的裸模型名 ——
    LM Studio / Ollama 的模型本来就没有厂商前缀，保存时自动补上，不算写法不对。 */
function poolEntryBad(id) {
  const text = String(id ?? '').trim();
  const slash = text.indexOf('/');
  if (slash > 0 && slash !== text.length - 1) return false;
  return !localModelForBare(text);
}

/** 裸名条目保存时会被补成什么。 */
function poolEntryNormalized(id) {
  const text = String(id ?? '').trim();
  const owner = localModelForBare(text);
  if (!owner || text.includes('/')) return text;
  const at = text.indexOf('#');
  return at > 0 ? `${owner}/${text.slice(0, at)}${text.slice(at)}` : `${owner}/${text}`;
}

/**
 * 模型分类：优先用后端返回的 categories（和桥接同一份判断），
 * 老后端没这个字段时用同样的名称规则兜底，避免页面空白。
 */
function poolCategory(id) {
  const fromServer = poolDraft?.categories?.[id];
  if (fromServer?.key) return fromServer;
  const text = String(id ?? '').toLowerCase();
  if (
    /(^|[-_/])(vl|vision|omni|ocr)([-_/]|$)/.test(text)
    || /qwen[\d.]*-?vl/.test(text)
    || /deepseek-v4\.1-flash/.test(text)
    || /deepseek-flash/.test(text)
  ) {
    return { key: 'vision', label: '视觉', hint: '能直接看图片/表情' };
  }
  if (/(dall-e|dalle|flux|stable-diffusion|sdxl|midjourney|imagen|seedream|wanx|embedding|rerank|tts|whisper)/.test(text)) {
    return { key: 'generation', label: '生成', hint: '生图/视频/语音/向量等非聊天模型' };
  }
  return { key: 'text', label: '文本', hint: '只处理文字；收到图片时会先让视觉模型转述' };
}

function poolCategoryBadge(id) {
  const cat = poolCategory(id);
  return `<span class="pool-cat cat-${esc(cat.key)}" title="${esc(cat.hint ?? '')}">${esc(cat.label)}</span>`;
}

function renderPool() {
  if (!poolDraft) return;
  refreshPoolSuggestions();
  const row = (id, list) => {
    const bad = poolEntryBad(id);
    const bareLocal = !bad && !String(id).includes('/');
    const tag = bad ? '<span class="pool-tag">写法不对</span>' : bareLocal ? `<span class="pool-tag">保存时补 ${esc(localModelForBare(id))}/</span>` : '';
    return `
    <div class="pool-item ${bad ? 'is-invalid' : ''}" data-id="${esc(id)}" data-list="${list}" title="${bad ? '写法不对：要写成 厂商/模型' : bareLocal ? '本机服务里的模型，保存时自动补上厂商前缀' : ''}">
      <span class="pool-name">${esc(id)}</span>
      ${poolCategoryBadge(id)}
      ${tag}
      <button class="btn btn-sm btn-ghost" data-move="up" title="上移">↑</button>
      <button class="btn btn-sm btn-ghost" data-move="down" title="下移">↓</button>
      <button class="btn btn-sm btn-ghost" data-remove="1" title="移出">✕</button>
    </div>`;
  };

  const draw = (listName) => {
    const box = $(`#pool-${listName}`);
    const list = poolDraft[listName] ?? [];
    box.innerHTML = list.length ? list.map((id) => row(id, listName)).join('') : '<div class="empty">还没有</div>';
  };
  draw('free');
  draw('paid');

  const invalid = [
    ...(poolDraft.invalid?.free ?? []),
    ...(poolDraft.invalid?.paid ?? []),
    ...(poolDraft.free ?? []).filter(poolEntryBad),
    ...(poolDraft.paid ?? []).filter(poolEntryBad)
  ];
  const warning = document.getElementById('pool-warning');
  if (warning) {
    const unique = [...new Set(invalid)];
    warning.hidden = unique.length === 0;
    warning.textContent = unique.length
      ? `有 ${unique.length} 条写法不对：${unique.slice(0, 3).join('、')}${unique.length > 3 ? '…' : ''}。模型池只认「厂商/模型」，保存时会自动丢弃这些条目。`
      : '';
  }

  // 后端给的是 [{id, until, kind, detail}]，老版本可能直接给字符串
  const spent = (poolDraft.spent ?? []).map((s) => (typeof s === 'string' ? { id: s } : s));
  $('#pool-spent-group').hidden = spent.length === 0;
  $('#pool-spent').innerHTML = spent
    .map(
      (s) => {
        // quota 是「额度用完」：不会自己回来（永久坐废池），只能拿回来或删掉；
        // context 是「这条会话太长」：临时换大上下文模型，过一会儿自动回队；
        // 别的（限流/连不上/认证）是暂停，到期自动回队
        const tag = s.kind === 'quota'
          ? '额度用完 · 已废，不会自动恢复'
          : s.kind === 'context'
            ? '上下文超限 · 已临时换大模型'
            : '暂停中 · 到期自动恢复';
        return `<div class="pool-item is-spent" data-id="${esc(s.id)}" title="${esc(s.detail ?? '')}">
        <span class="pool-name">${esc(s.id)}</span>
        ${poolCategoryBadge(s.id)}
        <span class="pool-tag">${esc(tag)}</span>
        <button class="btn btn-sm" data-restore="${esc(s.id)}" title="清掉熔断记录，模型回到池里排队">拿回来</button>
        <button class="btn btn-sm btn-ghost" data-discard="${esc(s.id)}" title="从模型池里整个删掉">删掉</button>
      </div>`;
      }
    )
    .join('');

  $$('#pool-free [data-move], #pool-paid [data-move], #pool-free [data-remove], #pool-paid [data-remove]').forEach((b) => {
    b.addEventListener('click', () => {
      const item = b.closest('.pool-item');
      const listName = item.dataset.list;
      const id = item.dataset.id;
      const list = poolDraft[listName];
      const i = list.indexOf(id);
      if (b.dataset.remove) list.splice(i, 1);
      else if (b.dataset.move === 'up' && i > 0) [list[i - 1], list[i]] = [list[i], list[i - 1]];
      else if (b.dataset.move === 'down' && i < list.length - 1) [list[i + 1], list[i]] = [list[i], list[i + 1]];
      renderPool();
      scheduleAutoSave('pool', savePoolAuto);
    });
  });

  $$('#pool-spent [data-restore]').forEach((b) => {
    b.addEventListener('click', async () => {
      const r = await post('/api/model-pool/restore', { id: b.dataset.restore });
      toast(r.note ?? (r.ok ? '已解除' : r.error ?? '失败'));
      await loadModels();
    });
  });

  $$('#pool-spent [data-discard]').forEach((b) => {
    b.addEventListener('click', async () => {
      const ok = await confirmBox({
        title: `从模型池删掉 ${b.dataset.discard}？`,
        text: '熔断记录和池子条目一起删，重新生成配置。删错了得自己手动把条目加回来。',
        okLabel: '删掉',
        danger: true
      });
      if (!ok) return;
      const r = await post('/api/model-pool/discard', { id: b.dataset.discard });
      toast(r.note ?? (r.ok ? '已删掉' : r.error ?? '失败'));
      await loadModels();
    });
  });

  // 用量
  const usage = poolDraft.usage ?? {};
  const rows = Object.entries(usage);
  $('#pool-usage').innerHTML = rows.length
    ? rows
        .sort((a, b) => (b[1].calls ?? 0) - (a[1].calls ?? 0))
        .slice(0, 12)
        .map(([id, u]) => `${esc(id)} — 调用 ${u.calls ?? 0} 次，出 ${u.outputTokens ?? u.completionTokens ?? 0} / 入 ${u.inputTokens ?? u.promptTokens ?? 0} token`)
        .join('<br />')
    : '还没有调用记录。';
}

$('#poolEnabled').addEventListener('change', () => {
  if (poolDraft) poolDraft.enabled = $('#poolEnabled').checked;
  scheduleAutoSave('pool', savePoolAuto);
});
$('#poolAllowPaid').addEventListener('change', () => {
  if (poolDraft) poolDraft.allowPaid = $('#poolAllowPaid').checked;
  scheduleAutoSave('pool', savePoolAuto);
});
$('#poolNotice').addEventListener('input', () => scheduleAutoSave('pool', savePoolAuto));
async function savePoolAuto() {
  if (!poolDraft) return;
  const mark = sig({ e: poolDraft.enabled, a: poolDraft.allowPaid, n: $('#poolNotice').value, f: poolDraft.free, p: poolDraft.paid });
  if (autoSavedSig.get('pool') === mark) return;
  const r = await post('/api/model-pool', {
    enabled: poolDraft.enabled !== false,
    allowPaid: poolDraft.allowPaid === true,
    exhaustedNotice: $('#poolNotice').value,
    // 本机服务的裸模型名在出口统一补上厂商前缀，别让服务端当写法错误丢掉
    free: (poolDraft.free ?? []).map(poolEntryNormalized),
    paid: (poolDraft.paid ?? []).map(poolEntryNormalized)
  });
  if (r.ok === false) return setResult('#pool-result', r.error ?? '保存失败', 'err');
  autoSavedSig.set('pool', mark);
  if (r.warnings?.length) {
    setResult('#pool-result', r.warnings.join('；'), 'err');
    await loadModels();
    return;
  }
  setResult('#pool-result', r.bridgeRestarted ? '已保存 ✓ 桥接已重启生效' : '已保存 ✓ 下次桥接启动生效', 'saved');
  renderModelHero();
}

$$('[data-add]').forEach((b) => {
  b.addEventListener('click', () => {
    const listName = b.dataset.add;
    const input = $(`#pool-add-${listName}`);
    const id = input.value.trim();
    if (!id) return;
    // 裸模型名会让 ModelChain 解析失败（0.5.5 桥接崩溃的直接原因）。
    // 在入口就拦住，并给出正确写法，不要等保存后再丢。
    if (poolEntryBad(id)) {
      setResult('#pool-result', `「${id}」写法不对：要写成 厂商/模型，例如 lmstudio/qwen2.5-7b-instruct`, 'err');
      input.focus();
      return;
    }
    if (!poolDraft[listName].includes(id)) poolDraft[listName].push(id);
    input.value = '';
    renderPool();
    scheduleAutoSave('pool', savePoolAuto);
  });
});

document.getElementById('btn-pool-current')?.addEventListener('click', () => {
  const pf = platform();
  const chat = modelProfiles?.[pf]?.chat;
  const provider = document.getElementById('chat-provider')?.value || chat?.provider || '';
  const model = document.getElementById('chat-model')?.value.trim() || String(chat?.model ?? '').trim();
  if (!provider || !model) {
    setResult('#pool-result', '当前还没有选厂商和模型，先把上面的连接填好', 'err');
    return;
  }
  const id = `${provider}/${model}`;
  if (!poolDraft) poolDraft = { free: [], paid: [], invalid: {} };
  poolDraft.free = [id, ...(poolDraft.free ?? []).filter((x) => x !== id)];
  renderPool();
  scheduleAutoSave('pool', savePoolAuto);
  setResult('#pool-result', `已把 ${id} 放到免费档首位`, 'saved');
});

$('#btn-save-pool').addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  await busy(btn, '保存中…', async () => {
    const r = await post('/api/model-pool', {
      enabled: $('#poolEnabled').checked,
      allowPaid: $('#poolAllowPaid').checked,
      exhaustedNotice: $('#poolNotice').value,
      free: poolDraft.free,
      paid: poolDraft.paid
    });
    if (r.ok === false) return setResult('#pool-result', r.error ?? '保存失败', 'err');
    if (r.warnings?.length) {
      setResult('#pool-result', r.warnings.join('；'), 'err');
      await loadModels();
      return;
    }
    const extra = r.bridgeRestarted ? '，桥接已重启' : '，下次桥接启动生效';
    setResult('#pool-result', `已保存${extra}`, 'saved');
    renderModelHero();
  });
});

/* 批量导入 */
let impReport = null;

function renderImportReport(report, box = $('#imp-report')) {
  if (!report?.length) {
    box.innerHTML = '';
    return;
  }
  const provOpts = (cur) =>
    `<option value="">（不指定）</option>` +
    (S?.providers ?? []).map((p) => `<option value="${esc(p.id)}" ${p.id === cur ? 'selected' : ''}>${esc(p.label)}</option>`).join('');

  box.innerHTML = `<table class="table" style="margin-top:14px">
    <thead><tr><th>行</th><th>内容</th><th>识别为</th><th>存成</th><th>依据</th></tr></thead>
    <tbody>
      ${report
        .map(
          (r) => `<tr data-index="${r.index}">
            <td class="mono">${r.index + 1}</td>
            <td class="mono" title="${esc(r.line)}">${esc(r.line.slice(0, 46))}${r.line.length > 46 ? '…' : ''}</td>
            <td><select data-imp="provider">${provOpts(r.provider)}</select></td>
            <td><input data-imp="env" value="${esc(r.env ?? '')}" placeholder="环境变量名" spellcheck="false" /></td>
            <td style="font-size:11.5px;color:var(--text-3)">
              ${r.dup ? '<span class="badge err">已存在</span> ' : ''}
              ${r.confidence === 'low' ? '<span class="badge warn">存疑</span> ' : ''}
              ${esc(r.reason ?? '')}
            </td>
          </tr>`
        )
        .join('')}
    </tbody>
  </table>`;
}

function collectImportItems(scope = document) {
  const rootEl = typeof scope === 'string' ? $(scope) : scope;
  return $$('tr[data-index]', rootEl ?? document).map((tr) => ({
    index: Number(tr.dataset.index),
    provider: $('[data-imp="provider"]', tr).value,
    env: $('[data-imp="env"]', tr).value.trim()
  }));
}

$('#btn-imp-scan').addEventListener('click', async (e) => {
  const text = $('#imp-text').value;
  if (!text.trim()) return setResult('#imp-result', '先粘点东西进来', 'err');
  await busy(e.target.closest('button'), '识别中…', async () => {
    const r = await post('/api/providers/import', { text, apply: false });
    if (r.ok === false) return setResult('#imp-result', r.error, 'err');
    impReport = r.report ?? [];
    renderImportReport(impReport);
    const good = impReport.filter((x) => x.env && !x.dup).length;
    setResult('#imp-result', `识别 ${impReport.length} 行，可直接导入 ${good} 行 —— 确认无误后点击「确认写入」`, 'ok');
  });
});

$('#btn-imp-apply').addEventListener('click', async (e) => {
  const text = $('#imp-text').value;
  if (!text.trim()) return setResult('#imp-result', '先粘点东西进来', 'err');
  const items = impReport ? collectImportItems() : [];
  const ok = await confirmBox({
    title: '写入这些 key？',
    text: '会把 key 存进 secrets.json（明文，和现有 key 放一起）。已经存在的 key 会跳过。',
    list: impReport ? impReport.filter((x) => !x.dup).slice(0, 6).map((x) => `${x.env || '（未指定）'} ← ${x.keyMasked}`) : [],
    okLabel: '写入'
  });
  if (!ok) return;
  await busy(e.target.closest('button'), '写入中…', async () => {
    const r = await post('/api/providers/import', { text, apply: true, items });
    if (r.ok === false) return setResult('#imp-result', r.error, 'err');
    setResult('#imp-result', `写入了 ${r.applied} 条`, 'saved');
    await refreshState();
    await loadModels();
  });
});

async function loadModels() {
  if (!S) await refreshState();
  buildSlotPanels();
  bindSlotEvents();
  await loadModelProfiles();
  await loadReasoning();
  fillAllSlots();
  for (const def of SLOT_DEFS) renderLocalServers(def.key);

  const p = await api('/api/model-pool');
  if (p.ok !== false) {
    poolDraft = { ...p, spent: p.spent ?? [] };
    $('#poolEnabled').checked = p.enabled !== false;
    $('#poolAllowPaid').checked = p.allowPaid === true;
    $('#poolNotice').value = p.exhaustedNotice ?? '';
    renderPool();
  }

  await loadPrice();
  renderModelHero();
  renderLocalModelBanner();
}

/** 模型页顶部的一行“现在到底在用谁”，省得用户在长表单里自己拼。 */
function renderModelHero() {
  const box = document.getElementById('model-hero');
  if (!box) return;
  const pf = platform();
  const wx = pf === 'wechat';
  const chat = modelProfiles?.[pf]?.chat ?? null;
  const formProvider = document.getElementById('chat-provider')?.value || chat?.provider || '';
  const formModel = document.getElementById('chat-model')?.value.trim() || String(chat?.model ?? '').trim();
  const formBaseUrl = document.getElementById('chat-baseUrl')?.value.trim() || '';
  const preset = providerById(formProvider);
  const providerLabel = formProvider ? (preset?.label ?? formProvider) : '未选择厂商';
  const model = formModel;
  const baseUrl = formBaseUrl || preset?.baseUrl || '';
  const keyEnv = formProvider ? (usesCustomModelEndpoint({ provider: formProvider, baseUrl }, preset) ? modelProfileKeyEnv(pf, 'chat') : preset?.keyEnv) : null;
  const keyState = !keyEnv ? '无需 key' : secretSet(keyEnv) ? 'key 已保存' : 'key 未保存';
  const localServer = formProvider ? (S?.localModelServers ?? []).find((x) => x.id === formProvider) : null;

  const title = document.getElementById('mh-title');
  const sub = document.getElementById('mh-sub');
  const platformEl = document.getElementById('mh-platform');
  if (platformEl) platformEl.textContent = wx ? '微信' : 'QQ';
  if (title) title.textContent = model ? `${providerLabel} · ${model}` : '还没有选模型';
  if (sub) {
    const localNote = localServer && !localServer.running ? ` · ${localServer.label} 没在运行` : '';
    sub.textContent = model
      ? `${baseUrl || '地址未填'} · ${keyState}${localNote}`
      : '在下面选厂商，或点本机服务按钮；模型和地址会自动填好。';
  }

  const localEl = document.getElementById('mh-local');
  if (localEl) {
    if (localServer) {
      localEl.hidden = false;
      localEl.textContent = localServer.running ? `${localServer.label} 已连接` : `${localServer.label} 未运行`;
      localEl.className = `badge ${localServer.running ? 'ok' : 'warn'}`;
      localEl.title = localServer.running
        ? `本机 ${localServer.baseUrl} 已响应`
        : `本机 ${localServer.baseUrl} 没有响应；消息会先失败，再走模型池兜底`;
    } else {
      localEl.hidden = true;
    }
  }

  const categoryEl = document.getElementById('mh-cat');
  if (categoryEl) {
    if (model) {
      const cat = poolCategory(model);
      categoryEl.hidden = false;
      categoryEl.textContent = `分类 ${cat.label}`;
      categoryEl.className = `badge ${cat.key === 'vision' ? 'ok' : cat.key === 'generation' ? 'warn' : ''}`;
      categoryEl.title = cat.hint ?? '';
    } else {
      categoryEl.hidden = true;
    }
  }

  const pool = document.getElementById('mh-pool');
  if (pool) {
    const free = poolDraft?.free?.length ?? 0;
    const paid = poolDraft?.paid?.length ?? 0;
    const invalid = (poolDraft?.invalid?.free?.length ?? 0) + (poolDraft?.invalid?.paid?.length ?? 0);
    pool.textContent = poolDraft?.enabled === false ? '模型池已关闭' : `模型池 ${free} 免费 / ${paid} 付费${invalid ? ` · ${invalid} 条待修` : ''}`;
    pool.className = `badge ${poolDraft?.enabled === false ? 'warn' : invalid ? 'err' : free + paid ? 'ok' : 'warn'}`;
  }

  const bridge = document.getElementById('mh-bridge');
  if (bridge) {
    const running = wx ? Boolean(S?.wechat?.running || S?.wechat?.externalPid) : Boolean(S?.bridge?.running || S?.bridge?.externalPid);
    const exit = wx ? S?.wechat?.exitCode : S?.bridge?.exitCode;
    const serviceName = wx ? '微信 Bot' : 'QQ 桥接';
    bridge.textContent = running ? `${serviceName}运行中` : exit != null ? `${serviceName}已退出（${exit}）` : `${serviceName}未启动`;
    bridge.className = `badge ${running ? 'ok' : exit != null ? 'err' : 'warn'}`;
    bridge.title = wx ? '微信 Bot 进程状态，不是模型服务状态' : 'QQ 桥接进程状态，不是模型服务状态';
  }
}

/* ── 价目表 ─────────────────────────────────────────── */

/* 一份本地草稿，输入即改草稿；点保存才发请求。
 * 名字是配置里的键，所以那一格只读 —— 想改名就是删除一条再添加一条。 */
let priceDraft = { models: {}, fallbackModel: '', peakMultiplier: null };

async function loadPrice() {
  const r = await api('/api/pricing');
  if (r.ok === false) return;
  priceDraft = {
    models: { ...(r.models ?? {}) },
    fallbackModel: r.fallbackModel ?? '',
    peakMultiplier: r.peakMultiplier
  };
  $('#price-builtin').innerHTML = (r.builtin ?? [])
    .map((b) => `<option value="${esc(b.name)}">${esc(b.label)}</option>`)
    .join('');
  $('#price-fallback').value = r.fallbackModel ?? '';
  $('#price-peak').value = r.peakMultiplier ?? '';
  renderPrice();
}

function renderPrice() {
  const host = $('#price-rows');
  const head = `<div class="price-row head">
    <span>模型名</span><span>显示名</span><span>命中</span><span>未命中</span><span>写缓存</span><span>输出</span><span></span>
  </div>`;
  const names = Object.keys(priceDraft.models);
  if (!names.length) {
    host.innerHTML = `${head}<div class="price-empty">还没有自定义价格 —— 现在全按内置表算。</div>`;
    return;
  }

  const num = (name, k, m) =>
    `<input data-price="${esc(name)}" data-k="${k}" type="number" step="0.01" min="0"
      value="${m[k] ?? ''}" placeholder="—" />`;

  host.innerHTML =
    head +
    names
      .map((name) => {
        const m = priceDraft.models[name] ?? {};
        return `<div class="price-row">
          <input class="price-name" value="${esc(name)}" readonly />
          <input class="price-label-cell" data-price="${esc(name)}" data-k="label" value="${esc(m.label ?? name)}" spellcheck="false" />
          ${num(name, 'cacheHit', m)}${num(name, 'cacheMiss', m)}${num(name, 'cacheWrite', m)}${num(name, 'output', m)}
          <button class="btn-del" data-price-del="${esc(name)}" title="删掉这条">×</button>
        </div>`;
      })
      .join('');

  $$('#price-rows input[data-price]').forEach((el) => {
    el.addEventListener('input', () => {
      const name = el.dataset.price;
      const k = el.dataset.k;
      if (!priceDraft.models[name]) priceDraft.models[name] = {};
      if (k === 'label') priceDraft.models[name].label = el.value;
      else priceDraft.models[name][k] = el.value.trim() === '' ? null : Number(el.value);
    });
  });

  $$('#price-rows [data-price-del]').forEach((b) => {
    b.addEventListener('click', () => {
      delete priceDraft.models[b.dataset.priceDel];
      renderPrice();
    });
  });
}

$('#btn-price-add').addEventListener('click', () => {
  const input = $('#price-add-name');
  const name = input.value.trim();
  if (!name) return;
  if (!priceDraft.models[name]) {
    priceDraft.models[name] = { label: name, cacheHit: null, cacheMiss: null, cacheWrite: null, output: null };
  }
  input.value = '';
  renderPrice();
  $('#price-rows').lastElementChild?.scrollIntoView({ block: 'nearest' });
});

$('#btn-save-price').addEventListener('click', async (e) => {
  const models = {};
  for (const [name, m] of Object.entries(priceDraft.models)) {
    const off = {};
    for (const k of ['cacheHit', 'cacheMiss', 'cacheWrite', 'output']) {
      const v = Number(m[k]);
      // 空着就是不写这一项，让桥接按内置规则补（比如 cacheWrite 跟随 cacheMiss）
      if (m[k] !== null && m[k] !== undefined && m[k] !== '' && Number.isFinite(v)) off[k] = v;
    }
    models[name] = { label: String(m.label ?? '').trim() || name, off };
  }

  const peakRaw = $('#price-peak').value.trim();
  await busy(e.target.closest('button'), '保存中…', async () => {
    const r = await post('/api/pricing', {
      models,
      fallbackModel: $('#price-fallback').value.trim(),
      peakMultiplier: peakRaw === '' ? null : Number(peakRaw)
    });
    if (r.ok === false) return setResult('#price-result', r.error ?? '保存失败', 'err');
    setResult('#price-result', `存了 ${r.count} 条${r.needRestart ? ' · 重启桥接后生效' : ''}`, r.needRestart ? 'saved-pending' : 'saved');
    await loadPrice();
  });
});

/* ── 5. 后端 ────────────────────────────────────────── */

let currentType = 'matrix';

function selectType(type, { fromClick = false } = {}) {
  currentType = type;
  $$('#type-grid .type-card').forEach((c) => c.classList.toggle('is-active', c.dataset.type === type));
  $('#panel-matrix').hidden = type !== 'matrix';
  $('#panel-modelapi').hidden = type !== 'model-api';
  $('#panel-cli').hidden = type !== 'cli';
  $('#panel-ui').hidden = type !== 'ui';
  if (fromClick) setResult('#oc-result', '', '');
}

$$('#type-grid .type-card').forEach((c) => {
  c.addEventListener('click', () => selectType(c.dataset.type, { fromClick: true }));
});

function describeInstance(x) {
  if (!x?.alive) return '未运行';
  return `${x.url ?? '—'}${x.port ? ` · 端口 ${x.port}` : ''}${x.pid ? ` · pid ${x.pid}` : ''}${x.version ? ` · v${x.version}` : ''}`;
}

function renderMatrixInfo(m, instances = null) {
  const qq = instances?.qq ?? (m?.platform === 'qq' ? m : null);
  const wx = instances?.wechat ?? (m?.platform === 'wechat' ? m : null);
  const rows = instances
    ? [
        ['QQ 实例', describeInstance(qq)],
        ['微信实例', describeInstance(wx)],
        ['当前实例地址', m?.url ?? '—'],
        ['当前实例进程号', m?.pid ?? '—'],
        ['当前实例版本', m?.version ?? '—'],
        ['运行数据', m?.file ?? '—']
      ]
    : [
        ['实例状态', m?.alive ? '运行中' : '未运行'],
        ['地址', m?.url ?? '—'],
        ['进程号', m?.pid ?? '—'],
        ['版本', m?.version ?? '—'],
        ['运行数据', m?.file ?? '—']
      ];
  // 路径里带引擎自己的目录名，界面上不能露出来 —— 统一过一遍翻译层
  $('#oc-info').innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(plainify(v))}</dd>`).join('');
}

async function loadMatrix() {
  const r = await api(`/api/matrix?platform=${platform()}`);
  if (r.ok === false) return;
  $('#ocBaseUrl').value = r.baseUrl ?? '';
  $('#ocStateDir').value = r.stateDir ?? '';
  $('#sessionCwd').value = r.sessionCwd ?? '';
  $('#ocDeleteArchived').checked = r.deleteArchived === true;
  $('#agentPreset').value = r.agentPreset ?? 'qq-chat';
  $('#workspaceTitle').value = r.workspaceTitle ?? '';
  renderMatrixInfo(r.instance, r.instances);
}

$('#btn-save-oc').addEventListener('click', async (e) => {
  await busy(e.target.closest('button'), '保存中…', async () => {
    const r = await post(`/api/matrix?platform=${platform()}`, {
      baseUrl: $('#ocBaseUrl').value,
      stateDir: $('#ocStateDir').value,
      sessionCwd: $('#sessionCwd').value,
      deleteArchived: $('#ocDeleteArchived').checked,
      agentPreset: $('#agentPreset').value,
      workspaceTitle: $('#workspaceTitle').value
    });
    if (r.ok === false) return setResult('#oc-result', r.error, 'err');
    setResult('#oc-result', '已保存（改动方案要重启桥接才生效）', 'saved-pending');
    await loadMatrix();
  });
});

$('#btn-use-oc').addEventListener('click', async (e) => {
  await busy(e.target.closest('button'), '切换中…', async () => {
    const r = await post('/api/backend', { backend: { type: 'matrix' } });
    if (r.ok === false) return setResult('#oc-result', r.error, 'err');
    setResult('#oc-result', '已启用 API 实例，重启桥接后生效', 'saved-pending');
    await refreshState();
    await loadBackend();
  });
});

function renderModelApiSummary() {
  const ma = S?.backend?.modelApi ?? {};
  const rows = [
    ['厂商', providerById(ma.provider)?.label ?? ma.provider ?? '自定义'],
    ['接口地址', ma.baseUrl || '—'],
    ['模型', ma.model || '—'],
    ['协议', ma.protocol ?? 'openai'],
    ['只读工具', ma.allowTools ? '开' : '关']
  ];
  $('#ma-summary').innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
  $('#ma-warn').hidden = Boolean(ma.baseUrl && ma.model);
}

$('#btn-goto-models').addEventListener('click', () => showPage('models'));

$('#btn-use-ma').addEventListener('click', async (e) => {
  const ma = S?.backend?.modelApi ?? {};
  if (!ma.baseUrl || !ma.model) return setResult('#ma-result', '先去「API 与模型」把地址和模型填好', 'err');
  await busy(e.target.closest('button'), '切换中…', async () => {
    const r = await post('/api/backend', { backend: { type: 'model-api', modelApi: ma } });
    if (r.ok === false) return setResult('#ma-result', r.error, 'err');
    setResult('#ma-result', '已启用直连模型 API，重启桥接后生效', 'saved-pending');
    await refreshState();
    await loadBackend();
  });
});

/* CLI */
function currentDriver() {
  return (S?.cliDrivers ?? []).find((d) => d.id === $('#cliDriver').value) ?? null;
}

function renderCliDrivers() {
  const list = S?.cliDrivers ?? [];
  $('#cliDriver').innerHTML = list.map((d) => `<option value="${esc(d.id)}">${esc(d.label)}${d.verified ? '' : '（未核实）'}</option>`).join('');
  $('#cli-installed').innerHTML = list
    .map(
      (d) => `<button class="btn btn-sm ${d.installed ? '' : 'btn-ghost'}" data-driver="${esc(d.id)}" ${d.installed ? '' : 'disabled'}>
        <span class="led ${d.installed ? 'on' : ''}" style="margin-right:2px"></span>${esc(d.label)} · ${d.installed ? '已安装' : '没找到'}
      </button>`
    )
    .join('');
  $$('#cli-installed [data-driver]').forEach((b) => {
    b.addEventListener('click', () => {
      $('#cliDriver').value = b.dataset.driver;
      renderCliOptions({});
    });
  });
  $('#unverified-count').textContent = String((S?.unverifiedClis ?? []).length);
  $('#unverified-list').innerHTML = (S?.unverifiedClis ?? [])
    .map((u) => `<li>${esc(u.label ?? u.id ?? u)}${u.note ? ` —— ${esc(u.note)}` : ''}</li>`)
    .join('');
}

function renderCliOptions(saved = {}) {
  const schema = currentDriver()?.optionsSchema ?? [];
  const host = $('#cli-options');
  if (!schema.length) {
    host.innerHTML = '<span class="hint">这个驱动没有额外参数。</span>';
    return;
  }
  host.innerHTML = schema
    .map((f) => {
      const value = saved[f.key] ?? f.default ?? '';
      if (f.type === 'bool') {
        return `<label class="switch-row">
          <input type="checkbox" data-opt="${esc(f.key)}" ${value ? 'checked' : ''} />
          <span><strong>${esc(f.label)}</strong>${f.hint ? `<em>${esc(f.hint)}</em>` : ''}</span>
        </label>`;
      }
      if (f.type === 'select') {
        const opts = (f.options ?? [])
          .map((o) => `<option value="${esc(o)}" ${String(value) === String(o) ? 'selected' : ''}>${esc(o || '（默认）')}</option>`)
          .join('');
        return `<div class="field"><label>${esc(f.label)}</label><select data-opt="${esc(f.key)}">${opts}</select>${
          f.hint ? `<span class="hint">${esc(f.hint)}</span>` : ''
        }</div>`;
      }
      return `<div class="field">
        <label>${esc(f.label)}</label>
        <input data-opt="${esc(f.key)}" type="${f.type === 'number' ? 'number' : 'text'}" value="${esc(String(value))}"
          placeholder="${esc(String(f.default ?? ''))}" spellcheck="false" />
        ${f.hint ? `<span class="hint">${esc(f.hint)}</span>` : ''}
      </div>`;
    })
    .join('');
}

function collectCliOptions() {
  const out = {};
  $$('#cli-options [data-opt]').forEach((el) => {
    const key = el.dataset.opt;
    if (el.type === 'checkbox') {
      // 布尔值必须显式存：不写等于"用默认"，而有些默认是 true（比如自动批准）
      out[key] = el.checked;
      return;
    }
    const raw = el.value.trim();
    if (raw === '') return;
    const n = Number(raw);
    out[key] = el.type === 'number' && Number.isFinite(n) ? n : raw;
  });
  return out;
}

$('#cliDriver').addEventListener('change', () => renderCliOptions({}));
$('#allowTools').addEventListener('change', (e) => {
  $('#tools-warn').hidden = !e.target.checked;
});

$('#btn-save-cli').addEventListener('click', async (e) => {
  const id = $('#customId').value.trim();
  const bin = $('#customBin').value.trim();
  const cli = {
    driver: $('#cliDriver').value,
    allowTools: $('#allowTools').checked,
    timeoutMs: Number($('#cliTimeoutMs').value) || undefined,
    options: collectCliOptions()
  };
  if (id && bin) {
    cli.customDriver = {
      id,
      label: id,
      bin,
      promptFlag: $('#customPromptFlag').value.trim() || '-p',
      extraArgs: splitIds($('#customExtraArgs').value)
    };
  } else if (id || bin) {
    return setResult('#cli-result', '自定义驱动要「标识」和「可执行文件」都填', 'err');
  }
  await busy(e.target.closest('button'), '保存中…', async () => {
    const r = await post('/api/backend', { backend: { type: 'cli', cli } });
    if (r.ok === false) return setResult('#cli-result', r.error, 'err');
    setResult('#cli-result', '已保存，重启桥接后生效', 'saved-pending');
    await refreshState();
    await loadBackend();
  });
});

/* 前台客户端 */
function collectUi() {
  const num = (id) => {
    const raw = $(id).value.trim();
    if (raw === '') return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };
  return {
    process: $('#uiProcess').value.trim(),
    titleRegex: $('#uiTitle').value.trim(),
    inputMode: $('#uiInputMode').value,
    sendKeys: $('#uiSendKeys').value.trim() || '{ENTER}',
    sendButtonRegex: $('#uiSendButtonRegex').value.trim() || '^发送$|^Send$',
    copyButtonRegex: $('#uiCopyButtonRegex').value.trim(),
    readMode: $('#uiInputMode').value,
    clickInputPct: $('#uiClickInputPct').value.trim(),
    clickReadPct: $('#uiClickReadPct').value.trim(),
    minWaitMs: num('#uiMinWaitMs'),
    maxWaitMs: num('#uiMaxWaitMs'),
    idleGuardMs: num('#uiIdleGuardMs'),
    stopRegex: $('#uiStopRegex').value.trim()
  };
}

$('#btn-save-ui').addEventListener('click', async (e) => {
  const ui = collectUi();
  if (!ui.process && !ui.titleRegex) return setResult('#ui-result', '「进程名」和「窗口标题正则」至少填一个', 'err');
  await busy(e.target.closest('button'), '切换中…', async () => {
    const r = await post('/api/backend', { backend: { type: 'ui', ui } });
    if (r.ok === false) return setResult('#ui-result', r.error, 'err');
    setResult('#ui-result', '已启用前台客户端，重启桥接后生效', 'saved-pending');
    await refreshState();
    await loadBackend();
  });
});

async function loadBackend() {
  if (!S) await refreshState();
  const type = S?.backend?.type === 'model-api' ? 'model-api' : S?.backend?.type === 'cli' ? 'cli' : S?.backend?.type === 'ui' ? 'ui' : 'matrix';
  selectType(type);
  const matrixState = S?.matrix ?? {};
  renderMatrixInfo(matrixState.instances?.[platform()] ?? matrixState, matrixState.instances ?? null);
  renderModelApiSummary();
  renderCliDrivers();

  const cli = S?.backend?.cli ?? {};
  if (cli.driver) $('#cliDriver').value = cli.driver;
  $('#cliTimeoutMs').value = cli.timeoutMs ?? '';
  $('#allowTools').checked = cli.allowTools === true;

  const uiCfg = S?.backend?.ui ?? {};
  $('#uiProcess').value = uiCfg.process ?? '';
  $('#uiTitle').value = uiCfg.titleRegex ?? '';
  $('#uiInputMode').value = uiCfg.inputMode ?? 'auto';
  $('#uiSendKeys').value = uiCfg.sendKeys ?? '{ENTER}';
  $('#uiSendButtonRegex').value = uiCfg.sendButtonRegex ?? '^发送$|^Send$';
  $('#uiCopyButtonRegex').value = uiCfg.copyButtonRegex ?? '';
  $('#uiClickInputPct').value = uiCfg.clickInputPct ?? '';
  $('#uiClickReadPct').value = uiCfg.clickReadPct ?? '';
  $('#uiMinWaitMs').value = uiCfg.minWaitMs ?? '';
  $('#uiMaxWaitMs').value = uiCfg.maxWaitMs ?? '';
  $('#uiIdleGuardMs').value = uiCfg.idleGuardMs ?? '';
  $('#uiStopRegex').value = uiCfg.stopRegex ?? '';
  $('#tools-warn').hidden = !$('#allowTools').checked;
  if (cli.customDriver) {
    $('#customId').value = cli.customDriver.id ?? '';
    $('#customBin').value = cli.customDriver.bin ?? '';
    $('#customPromptFlag').value = cli.customDriver.promptFlag ?? '';
    $('#customExtraArgs').value = (cli.customDriver.extraArgs ?? []).join(',');
  }
  renderCliOptions(cli.options ?? {});
  await loadMatrix();
}

/* ── 6. 聊天 ────────────────────────────────────────── */

let roleNames = [];

function setAccessMode(mode) {
  $$('input[name="accessMode"]').forEach((r) => { r.checked = r.value === mode; });
}

function renderRoleOptions(selected) {
  const sel = $('#role');
  sel.innerHTML =
    `<option value="">（不用人格卡）</option>` +
    roleNames.map((n) => `<option value="${esc(n)}" ${n === selected ? 'selected' : ''}>${esc(n)}</option>`).join('');
}

function renderRoleList(active) {
  const box = $('#role-list');
  if (!roleNames.length) {
    box.innerHTML = '<div class="empty">还没有人格卡</div>';
    return;
  }
  box.innerHTML = roleNames
    .map(
      (n) => `<div class="list-row ${n === active ? 'is-active' : ''}" data-role="${esc(n)}">
        <div class="row-main"><div class="row-title">${esc(n)}</div></div>
      </div>`
    )
    .join('');
  $$('#role-list [data-role]').forEach((row) => {
    row.addEventListener('click', () => showRoleCard(row.dataset.role));
  });
}

const ROLE_TEMPLATE = (name) => `# 角色卡：${name || '名字'}

## 一、你是谁
（名字、身份、和对方是什么关系。两三句就够，不要写履历。）

## 二、说话风格
- 句子短，一条消息不超过两行。
- 常用词：（列举几个她会用的词）
- 不要：不要总结、不要客服腔、不要"作为 AI"、不要列 1234。

## 三、性格与反应
- 被夸的时候：
- 被怼的时候：
- 不知道的时候：
（写具体反应，不要写"温柔""开朗"这种形容词。）

## 四、梗与背景（可选）
（她经历过什么、有什么执念、什么话题会让她话变多。）

## 五、回复示例
对方：在干嘛
你：躺着。你呢

对方：今天好累
你：那就别干了，过来陪我说话
`;

async function showRoleCard(name, { force = false } = {}) {
  if (!name) return;
  if (!force && !/^[\w\u4e00-\u9fa5][\w\u4e00-\u9fa5 .\-]*$/.test(name)) {
    return setResult('#role-edit-result', '名字里有不能用的字符', 'err');
  }
  const r = await api(`/api/role/file?name=${encodeURIComponent(name)}`);
  if (r.ok === false) {
    // 不存在就起一张模板卡（还没落盘）
    $('#role-name').value = name;
    $('#role-content').value = ROLE_TEMPLATE(name);
    $('#role-content-hint').textContent = '这是新卡，还没保存。改完点「保存内容」。';
    renderRoleList(name);
    return;
  }
  $('#role-name').value = r.name;
  $('#role-content').value = r.content;
  $('#role-content-hint').textContent = `${r.chars} 字符 / 上限 ${r.limit}${r.chars > r.limit ? '（超了会被截断）' : ''}`;
  renderRoleList(r.name);
}

$('#btn-role-new').addEventListener('click', () => {
  const name = $('#role-name').value.trim();
  if (!name) return setResult('#role-edit-result', '先填个名字', 'err');
  showRoleCard(name, { force: true });
});

$('#btn-role-template').addEventListener('click', () => {
  const name = $('#role-name').value.trim();
  $('#role-content').value = ROLE_TEMPLATE(name);
  $('#role-content-hint').textContent = '模板已填入，照着自己的角色改，改完点「保存内容」。';
});

$('#btn-role-save').addEventListener('click', async (e) => {
  const name = $('#role-name').value.trim();
  const content = $('#role-content').value;
  if (!name) return setResult('#role-edit-result', '先填个名字', 'err');
  if (!content.trim()) return setResult('#role-edit-result', '内容不能是空的', 'err');
  await busy(e.target.closest('button'), '保存中…', async () => {
    const r = await post('/api/role/file', { name, content });
    if (r.ok === false) return setResult('#role-edit-result', r.error, 'err');
    setResult('#role-edit-result', r.created ? '已新建' : '已保存（旧内容已备份）', 'saved');
    await loadChat();
    await showRoleCard(name);
  });
});

$('#btn-role-del').addEventListener('click', async (e) => {
  const name = $('#role-name').value.trim();
  if (!name) return setResult('#role-edit-result', '先选一张卡', 'err');
  const ok = await confirmBox({
    title: `删除「${name}」？`,
    text: '旧内容会先备份到 state/role-backups，但界面上就找不回来了。正在被 QQ 或微信用着的卡删不掉。',
    okLabel: '删除',
    danger: true
  });
  if (!ok) return;
  await busy(e.target.closest('button'), '删除中…', async () => {
    const r = await post('/api/role/file/delete', { name });
    if (r.ok === false) return setResult('#role-edit-result', r.error, 'err');
    setResult('#role-edit-result', '已删除（备份留在 state/role-backups）', 'saved');
    $('#role-name').value = '';
    $('#role-content').value = '';
    await loadChat();
  });
});

/* 自动整理 */
$('#btn-organize').addEventListener('click', async (e) => {
  const text = $('#organize-text').value;
  if (!text.trim()) return setResult('#organize-result', '先粘点素材进来', 'err');
  const ok = await confirmBox({
    title: '整理成人格卡？',
    text: '会把这段素材发给你自己配置的模型服务商，调一次模型整理成标准卡片。结果只填进上面的内容框，不会自动保存。',
    list: ['素材只发给你自己的服务商，本程序不留存', '整理结果可继续修改，修改后点击「保存内容」'],
    okLabel: '开始整理'
  });
  if (!ok) return;
  await busy(e.target.closest('button'), '整理中…（约需十几秒）', async () => {
    const r = await post('/api/role/organize', { text });
    if (r.ok === false) return setResult('#organize-result', r.error, 'err');
    $('#role-content').value = r.card;
    $('#role-content-hint').textContent = `整理完成，${r.card.length} 字符。过目改完再点「保存内容」。`;
    setResult('#organize-result', '整理好了，看上面的内容框', 'saved');
    $('#role-content').scrollIntoView({ block: 'center', behavior: 'smooth' });
  });
});

async function loadChat() {
  if (!S) await refreshState();
  const p = platform();
  const [chat, role, roles, matrix] = await Promise.all([
    api(`/api/chat?platform=${p}`),
    api(`/api/role?platform=${p}`),
    api('/api/roles'),
    api(`/api/matrix?platform=${p}`)
  ]);

  if (chat.ok !== false) {
    setAccessMode(chat.mode === 'all' ? 'all' : 'list');
    $('#ownerQQ').value = chat.ownerQQ ?? '';
    $('#allowPrivate').value = (chat.allow?.private ?? []).join(', ');
    $('#allowGroups').value = (chat.allow?.groups ?? []).join(', ');
    $('#denyPrivate').value = (chat.deny?.private ?? []).join(', ');
    $('#denyGroups').value = (chat.deny?.groups ?? []).join(', ');
    $('#maxInjectChars').value = chat.maxInjectChars ?? '';
    $('#injectMode').value = chat.injectMode ?? 'session';
  }

  if (roles.ok !== false) {
    roleNames = roles.roles ?? [];
    renderRoleOptions(role?.role ?? '');
    renderRoleList(role?.role ?? '');
  }

  if (role.ok !== false) {
    $('#silentMode').checked = role.mode === 'silent';
  }

  if (matrix.ok !== false) {
    $('#agentPreset').value = matrix.agentPreset ?? 'qq-chat';
    $('#workspaceTitle').value = matrix.workspaceTitle ?? '';
  }

  // 工具表只有 QQ 这一套；微信那边由 Hook 决定，不显示这块
  if (p === 'qq') await loadTools();
  // 语音库与 TTS 同样只有 QQ 这一套
  if (p === 'qq') await loadVoicePanel();
  // 画画与动态同样只有 QQ 这一套
  if (p === 'qq') await loadDrawPanel();
}

/* 自动保存：对话与人格页所有字段改了就存（停手 1 秒自动落盘并生效，不用点保存） */
function collectChatPayload() {
  const mode = $('input[name="accessMode"]:checked')?.value ?? 'all';
  return {
    mode,
    ownerQQ: $('#ownerQQ').value.trim() || null,
    allow: { private: splitIds($('#allowPrivate').value), groups: splitIds($('#allowGroups').value) },
    deny: { private: splitIds($('#denyPrivate').value), groups: splitIds($('#denyGroups').value) },
    allowAllWhenEmpty: mode === 'all',
    maxInjectChars: $('#maxInjectChars').value.trim() || undefined,
    injectMode: $('#injectMode').value
  };
}
function collectRolePayload() {
  return {
    role: $('#role').value || null,
    mode: $('#silentMode').checked ? 'silent' : 'active',
    maxInjectChars: $('#maxInjectChars').value.trim() || undefined,
    injectMode: $('#injectMode').value
  };
}
async function saveChatAuto() {
  const mark = sig([collectChatPayload(), collectRolePayload(), $('#agentPreset').value, $('#workspaceTitle').value]);
  if (autoSavedSig.get(`chat-${platform()}`) === mark) return;
  const p = platform();
  const rc = await post(`/api/chat?platform=${p}&deferRestart=1`, collectChatPayload());
  if (rc.ok === false) return setResult('#chat-result', rc.error, 'err');
  const rr = await post(`/api/role?platform=${p}&deferRestart=1`, collectRolePayload());
  if (rr.ok === false) return setResult('#role-result', rr.error, 'err');
  const rm = await post(`/api/matrix?platform=${p}&deferRestart=1`, {
    agentPreset: $('#agentPreset').value,
    workspaceTitle: $('#workspaceTitle').value
  });
  if (rm.ok === false) return setResult('#role-result', rm.error, 'err');
  const apply = await post(`/api/bots/apply?platform=${p}`, {});
  if (apply.ok === false) return setResult('#chat-result', apply.error, 'err');
  autoSavedSig.set(`chat-${platform()}`, mark);
  setResult('#chat-result', apply.applied ? '已自动保存 ✓ 服务已重启生效' : '已自动保存 ✓ 下次服务启动生效', 'saved');
  setResult('#role-result', '已自动保存 ✓', 'saved');
  await loadChat();
}
for (const sel of ['#ownerQQ', '#allowPrivate', '#allowGroups', '#denyPrivate', '#denyGroups', '#role', '#maxInjectChars', '#workspaceTitle']) {
  $(sel)?.addEventListener('input', () => scheduleAutoSave('chat', saveChatAuto));
}
for (const sel of ['#injectMode', '#agentPreset', '#silentMode']) {
  $(sel)?.addEventListener('change', () => scheduleAutoSave('chat', saveChatAuto));
}
$$('input[name="accessMode"]').forEach((r) => r.addEventListener('change', () => scheduleAutoSave('chat', saveChatAuto)));

/* ── 7. 消息 ────────────────────────────────────────── */

let msgData = null;
let msgFilter = null;

function renderMessages() {
  if (!msgData) return;
  const p = platform();
  const list = msgData.contacts ?? [];
  const entries = (msgData.entries ?? []).filter((e) => !msgFilter || e.conv === msgFilter);

  $('#msg-note').textContent = msgData.missing
    ? p === 'wechat'
      ? '还没有微信活动记录 —— 微信 Bot 启动并收发消息后显示'
      : '还没有 QQ 活动记录 —— 桥接启动并收发消息后显示'
    : `最近 ${entries.length} 条${msgFilter ? '（只看这个联系人）' : ''}`;

  $('#msg-contacts').innerHTML = list.length
    ? `<div class="list-row ${msgFilter ? '' : 'is-active'}" data-conv=""><div class="row-main"><div class="row-title">全部</div><div class="row-sub">${(msgData.entries ?? []).length} 条</div></div></div>` +
      list
        .map(
          (c) => `<div class="list-row ${msgFilter === c.conv ? 'is-active' : ''}" data-conv="${esc(c.conv)}">
            <div class="row-main">
              <div class="row-title">${esc(c.label)}</div>
              <div class="row-sub">${c.kind === 'group' ? '群 ' : ''}${esc(c.target)} · ${c.count} 条${c.last ? ` · ${esc(c.last)}` : ''}</div>
            </div>
          </div>`
        )
        .join('')
    : '<div class="empty">还没有联系人</div>';

  $$('#msg-contacts [data-conv]').forEach((row) => {
    row.addEventListener('click', () => {
      msgFilter = row.dataset.conv || null;
      renderMessages();
    });
  });

  $('#msg-stream').innerHTML = entries.length
    ? entries
        .map(
          (e) => `<div class="msg ${e.self ? 'self' : ''}">
            <div class="msg-head"><span class="msg-who">${esc(e.self ? '机器人' : e.who)}</span><span>${esc(e.clock)}</span></div>
            <div class="msg-text">${esc(e.text)}</div>
          </div>`
        )
        .join('')
    : '<div class="empty">这段时间没有消息</div>';
  $('#msg-stream').scrollTop = $('#msg-stream').scrollHeight;
}

async function loadMessages() {
  if (!S) await refreshState();
  msgData = await api(`/api/messages?platform=${platform()}&limit=400`);
  if (msgData.ok === false) msgData = { entries: [], contacts: [], missing: true };
  renderMessages();
  renderSumContacts();
  await loadHub();
  await loadHook();
  await loadSchedules();
  // 发送目标跟着平台换
  if (platform() === 'wechat') $('#btn-send-dry').hidden = false;
}

$('#btn-msg-refresh').addEventListener('click', () => loadMessages());

/* ── 省流总结 ───────────────────────────────────────────────────────────
 * 数据源和消息流是同一份活动日志；联系人下拉直接用消息页拉好的 contacts。
 * 模型调用在服务端（/api/summarize），前端只管选联系人、点按钮、看结果。 */
function renderSumContacts() {
  const sel = $('#sum-contact');
  if (!sel) return;
  const list = (msgData?.contacts ?? []).filter((c) => c.count > 0);
  const prev = sel.value;
  sel.innerHTML = list.length
    ? list.map((c) => `<option value="${esc(c.conv)}">${esc(c.label)}（${c.count} 条）</option>`).join('')
    : '<option value="">（还没有聊天记录）</option>';
  if (prev && list.some((c) => c.conv === prev)) sel.value = prev;
}

$('#btn-summarize')?.addEventListener('click', async (e) => {
  const conv = $('#sum-contact').value;
  if (!conv) return setResult('#sum-result', '还没有可总结的聊天记录', 'err');
  await busy(e.target.closest('button'), '总结中…', async () => {
    const r = await post('/api/summarize', { platform: platform(), conv, count: Number($('#sum-count').value) });
    if (r.ok === false) {
      $('#sum-out').hidden = true;
      return setResult('#sum-result', r.error ?? '总结失败', 'err');
    }
    setResult('#sum-result', `总结好了（基于 ${r.count} 条）`, 'ok');
    const out = $('#sum-out');
    out.hidden = false;
    out.textContent = r.summary;
  });
});

/* ── Webhook 通知枢纽 ─────────────────────────────────────────────────── */
let hubToken = '';

function renderHubSample() {
  const el = $('#hub-sample');
  if (!el) return;
  el.textContent =
    `curl -X POST ${location.origin}/hook/notify/${hubToken}` +
    ' -H "content-type: application/json"' +
    ' -d "{\"text\":\"构建失败了，快回来看\"}"';
}

async function loadHub() {
  if (!$('#hub-enabled')) return;
  const r = await api('/api/notify');
  if (r.ok === false) return;
  hubToken = r.token ?? '';
  $('#hub-enabled').checked = r.enabled !== false;
  $('#hub-url').value = `${location.origin}/hook/notify/${hubToken}`;
  $('#hub-default-platform').value = r.default?.platform === 'wechat' ? 'wechat' : 'qq';
  $('#hub-default-to').value = r.default?.to ?? '';
  const m = r.mirror ?? {};
  $('#hub-mirror-enabled').checked = m.enabled === true;
  $('#hub-mirror-from').value = m.from ?? '';
  $('#hub-mirror-keyword').value = m.keyword ?? '';
  $('#hub-mirror-platform').value = m.platform === 'wechat' ? 'wechat' : 'qq';
  $('#hub-mirror-to').value = m.to ?? '';
  renderHubSample();
}

async function saveHub() {
  const r = await post('/api/notify', {
    enabled: $('#hub-enabled').checked,
    default: { platform: $('#hub-default-platform').value, to: $('#hub-default-to').value.trim() },
    mirror: {
      enabled: $('#hub-mirror-enabled').checked,
      from: $('#hub-mirror-from').value.trim(),
      keyword: $('#hub-mirror-keyword').value.trim(),
      platform: $('#hub-mirror-platform').value,
      to: $('#hub-mirror-to').value.trim()
    }
  });
  if (r.ok === false) return setResult('#hub-result', r.error ?? '保存失败', 'err');
  hubToken = r.token ?? hubToken;
  renderHubSample();
  setResult('#hub-result', '已保存', 'ok');
}

['hub-enabled', 'hub-default-platform', 'hub-default-to', 'hub-mirror-enabled', 'hub-mirror-from', 'hub-mirror-keyword', 'hub-mirror-platform', 'hub-mirror-to']
  .forEach((id) => $(`#${id}`)?.addEventListener('change', () => saveHub()));

$('#btn-hub-copy')?.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('#hub-url').value);
    toast(t('已复制'));
  } catch {
    $('#hub-url').select();
    toast(t('复制不了，已选中文字，请手动 Ctrl+C'));
  }
});

$('#btn-hub-regen')?.addEventListener('click', async (e) => {
  const ok = await confirmBox({
    title: '换通知口令？',
    text: '旧地址立刻失效，拿到旧地址的程序要换成新地址。',
    okLabel: '换'
  });
  if (!ok) return;
  await busy(e.target.closest('button'), '…', async () => {
    const r = await post('/api/notify/regenerate');
    if (r.ok === false) return setResult('#hub-result', r.error ?? '操作失败', 'err');
    hubToken = r.token;
    $('#hub-url').value = `${location.origin}/hook/notify/${hubToken}`;
    renderHubSample();
    setResult('#hub-result', '口令已换', 'ok');
  });
});

$('#btn-hub-test')?.addEventListener('click', async (e) => {
  await busy(e.target.closest('button'), '发送中…', async () => {
    const r = await post('/api/notify/test', {
      platform: $('#hub-default-platform').value,
      to: $('#hub-default-to').value.trim()
    });
    if (r.ok === false) return setResult('#hub-result', r.error ?? '发送失败', 'err');
    setResult('#hub-result', '发出去了，去 QQ / 微信里看一眼', 'ok');
  });
});

/* ── 插件（高级页） ───────────────────────────────────────────────────── */
async function loadPluginsUi() {
  const el = $('#plugins-list');
  if (!el) return;
  const r = await api('/api/plugins');
  if (r.ok === false) {
    el.innerHTML = '<div class="empty">读不到插件目录</div>';
    return;
  }
  $('#plugins-note').textContent = `${r.dir} · ${r.files.length} 个文件`;
  el.innerHTML = r.files.length
    ? r.files
        .map(
          (f) => `<div class="list-row"><div class="row-main"><div class="row-title">${esc(f.file)}</div><div class="row-sub">${esc(f.desc || '（文件第一行注释会显示在这里）')}</div></div></div>`
        )
        .join('')
    : '<div class="empty">还没有插件 —— 把 .js 放进 plugins\ 目录，重启桥接或点「重新装载」</div>';
}

$('#btn-plugins-reload')?.addEventListener('click', async (e) => {
  await busy(e.target.closest('button'), '装载中…', async () => {
    const r = await post('/api/plugins');
    if (r.ok === false) return setResult('#plugins-result', r.error ?? '装载失败', 'err');
    setResult('#plugins-result', `已重新装载 ${r.count ?? 0} 个插件${r.errors?.length ? `，${r.errors.length} 个失败` : ''}`, r.errors?.length ? 'err' : 'ok');
    await loadPluginsUi();
  });
});


/* ── 插件添加引导（高级页） ────────────────────────────────────────────── */

$('#btn-plugins-add')?.addEventListener('click', () => {
  const box = $('#plugins-add');
  if (!box) return;
  box.hidden = !box.hidden;
  // 第一次展开就装上模板，让人从「能跑的代码」开始改
  if (!box.hidden && !$('#plugin-add-code').value.trim()) fillPluginTemplate();
});

function fillPluginTemplate() {
  const name = $('#plugin-add-template')?.value ?? 'hello';
  api(`/api/plugins/template?name=${encodeURIComponent(name)}`)
    .then((r) => {
      if (r && r.ok !== false) $('#plugin-add-code').value = r.code ?? '';
    })
    .catch(() => { /* 服务没起好就留空 */ });
}

$('#plugin-add-template')?.addEventListener('change', fillPluginTemplate);

$('#btn-plugin-add-save')?.addEventListener('click', async (e) => {
  await busy(e.target.closest('button'), '保存中…', async () => {
    const name = $('#plugin-add-name').value.trim();
    const code = $('#plugin-add-code').value;
    const overwrite = $('#plugin-add-overwrite')?.checked === true;
    const r = await post('/api/plugins/add', { name, code, overwrite });
    if (r.ok === false) return setResult('#plugin-add-result', r.error ?? '保存失败', 'err');
    const reloadNote = r.reload?.bridge
      ? `已热重载（${r.reload.count ?? '?'} 个插件${r.reload.errors?.length ? `，${r.reload.errors.length} 个失败` : ''}）`
      : '已保存；桥接没在跑，下次启动自动装载';
    setResult('#plugin-add-result', `已保存 plugins/${r.file} —— ${reloadNote}`, 'ok');
    await loadPluginsUi();
  });
});

/* ── 扩展中心（扩展页） ────────────────────────────────────────────────── */

async function loadExtensions() {
  try {
    const x = await api('/api/extensions');
    if (x && x.ok !== false) {
      $('#ext-hub-state').textContent = x.hub?.enabled ? '已启用' : '已停用（通知枢纽设置里开）';
      $('#ext-hub-path').textContent = x.hub?.path ?? '';
      $('#ext-phone').textContent = x.phone?.running ? `运行中 · 端口 ${x.phone.port}` : `未运行 · 端口 ${x.phone.port}（状态页可启停）`;
      $('#ext-plugins').textContent = `${x.plugins?.count ?? 0} 个插件（去「高级」页添加 / 管理）`;
      $('#ext-mcp').textContent = (x.mcp ?? []).join('、') || '（还没生成 MCP 配置，启动一次桥接就有了）';
      const ev = x.events ?? {};
      $('#ext-ev-enabled').checked = ev.enabled === true;
      $('#ext-ev-url').value = ev.url ?? '';
      $('#ext-ev-secret').value = '';
      $('#ext-ev-secret').placeholder = ev.hasSecret ? '已设置（留空 = 不修改）' : '留空 = 不设置';
      $('#ext-ev-message').checked = ev.onMessage !== false;
      $('#ext-ev-reply').checked = ev.onReply !== false;
      const sh = x.openaiShell ?? {};
      const shPort = sh.port ?? 4610;
      $('#ext-shell-enabled').checked = sh.enabled === true;
      $('#ext-shell-port').value = shPort;
      $('#ext-shell-agent').value = sh.agentPreset ?? 'qq-chat';
      $('#ext-shell-localtools').checked = sh.allowLocalTools === true;
      $('#ext-shell-key').value = sh.key ?? '';
      $('#ext-shell-base').textContent = `http://127.0.0.1:${shPort}/v1`;
      $('#ext-shell-state').textContent = sh.enabled
        ? '已启用（桥接在跑时才真的监听）'
        : '未启用';
      await loadAgentTools();
    }
  } catch { /* 服务没起好就静默 */ }
  try {
    const eps = await api('/api/endpoints');
    if (eps && eps.ok !== false) renderEndpointDocs(eps.endpoints ?? []);
  } catch { /* 同上 */ }
}

function renderEndpointDocs(rows) {
  const box = $('#ext-endpoints');
  if (!box) return;
  window.__extRows = rows;
  box.innerHTML = rows
    .map(
      (r, i) => `<div class="list-row"><div class="row-main">
        <div class="row-title"><span class="ext-method ext-m-${esc(r.method.toLowerCase())}">${esc(r.method)}</span> <code>${esc(r.path)}</code></div>
        <div class="row-sub">${esc(r.desc)} · 鉴权：${esc(r.auth)}</div>
        ${r.body ? `<div class="row-sub">body 示例：<code>${esc(r.body)}</code></div>` : ''}
      </div><button class="btn btn-sm" data-ext-curl="${i}">复制 curl</button></div>`
    )
    .join('');
}

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-ext-curl]');
  if (!btn) return;
  const r = (window.__extRows ?? [])[Number(btn.dataset.extCurl)];
  if (!r) return;
  const path = r.path.startsWith('http') ? r.path : location.origin + r.path;
  const authHeaders = r.auth.includes('console') ? ' -H "x-console-token: <控制台令牌>"' : '';
  const curl = r.method === 'GET'
    ? `curl "${path}"`
    : `curl -X ${r.method} "${path}" -H "content-type: application/json"${authHeaders} -d '${r.body ?? '{}'}'`;
  const ok = await copyText(curl);
  setResult('#ext-result', ok ? 'curl 已复制' : '复制失败', ok ? 'ok' : 'err');
});

$('#ext-hub-copy')?.addEventListener('click', async (e) => {
  await busy(e.target.closest('button'), '复制中…', async () => {
    const ok = await copyText(`${location.origin}${$('#ext-hub-path').textContent}`);
    setResult('#ext-result', ok ? '地址已复制' : '复制失败', ok ? 'ok' : 'err');
  });
});

let extEvTimer = null;
function scheduleExtEvSave(extra = {}) {
  clearTimeout(extEvTimer);
  extEvTimer = setTimeout(async () => {
    const payload = {
      enabled: $('#ext-ev-enabled').checked,
      url: $('#ext-ev-url').value.trim(),
      onMessage: $('#ext-ev-message').checked,
      onReply: $('#ext-ev-reply').checked,
      ...extra
    };
    if ($('#ext-ev-secret').value.trim()) payload.secret = $('#ext-ev-secret').value.trim();
    const r = await post('/api/events', payload);
    if (r.ok === false) return setResult('#ext-ev-result', r.error ?? '保存失败', 'err');
    setResult('#ext-ev-result', r.botsRestarted ? '已保存 ✓ QQ BOT 已重启，立即生效' : '已保存 ✓（微信侧下条消息起生效）', 'saved');
  }, 700);
}

$('#ext-ev-enabled')?.addEventListener('change', () => scheduleExtEvSave());
$('#ext-ev-url')?.addEventListener('change', () => scheduleExtEvSave());
$('#ext-ev-secret')?.addEventListener('change', () => scheduleExtEvSave());
$('#ext-ev-message')?.addEventListener('change', () => scheduleExtEvSave());
$('#ext-ev-reply')?.addEventListener('change', () => scheduleExtEvSave());

$('#btn-ext-ev-save')?.addEventListener('click', (e) => {
  e.target.closest('button').blur();
  scheduleExtEvSave();
});

$('#btn-ext-ev-test')?.addEventListener('click', async (e) => {
  await busy(e.target.closest('button'), '发送中…', async () => {
    const r = await post('/api/events', { test: true, url: $('#ext-ev-url').value.trim(), secret: $('#ext-ev-secret').value.trim() });
    setResult('#ext-ev-result', r.ok === false ? (r.error ?? '测试失败') : (r.note ?? `对端 HTTP ${r.status}`), r.ok ? 'ok' : 'err');
  });
});

/* ── OpenAI 兼容壳 ─────────────────────────────────────────────────────── */

// 端口改了先把展示的 baseURL 跟着变，别让人复制到一个旧端口
$('#ext-shell-port')?.addEventListener('input', () => {
  const port = Number($('#ext-shell-port').value) || 4610;
  $('#ext-shell-base').textContent = `http://127.0.0.1:${port}/v1`;
});

$('#btn-ext-shell-copy-base')?.addEventListener('click', async (e) => {
  await busy(e.target.closest('button'), '复制中…', async () => {
    const ok = await copyText($('#ext-shell-base').textContent);
    setResult('#ext-shell-result', ok ? 'baseURL 已复制' : '复制失败', ok ? 'ok' : 'err');
  });
});

$('#btn-ext-shell-copy')?.addEventListener('click', async (e) => {
  await busy(e.target.closest('button'), '复制中…', async () => {
    const key = $('#ext-shell-key').value;
    if (!key) return setResult('#ext-shell-result', '还没有 key —— 先保存（开启后桥接会生成一个）', 'err');
    const ok = await copyText(key);
    setResult('#ext-shell-result', ok ? 'key 已复制' : '复制失败', ok ? 'ok' : 'err');
  });
});

/**
 * 保存后 key 可能在重启之后才生成：桥接启动时才调 loadOrCreateKey。
 * 所以这里多刷几次，别让界面停在空 key 上让人以为坏了。
 */
async function refreshShellUi(retries = 3) {
  for (let i = 0; i < retries; i += 1) {
    const r = await api('/api/openai-shell').catch(() => null);
    if (r && r.ok !== false) {
      $('#ext-shell-key').value = r.key ?? '';
      const running = r.running ? `运行中 · 端口 ${r.port}` : (r.enabled ? '已启用，等桥接起来' : '未启用');
      $('#ext-shell-state').textContent = running;
      if (!r.enabled || r.key) return r;
    }
    await new Promise((res) => setTimeout(res, 1200));
  }
  return null;
}

$('#btn-ext-shell-save')?.addEventListener('click', async (e) => {
  await busy(e.target.closest('button'), '保存中…', async () => {
    const r = await post('/api/openai-shell', {
      enabled: $('#ext-shell-enabled').checked,
      port: Number($('#ext-shell-port').value) || 4610,
      agentPreset: $('#ext-shell-agent').value,
      allowLocalTools: $('#ext-shell-localtools').checked
    });
    if (r.ok === false) return setResult('#ext-shell-result', r.error ?? '保存失败', 'err');
    setResult('#ext-shell-result', r.botsRestarted ? '已保存 ✓ QQ BOT 已重启' : '已保存 ✓（下次启动桥接生效）', 'saved');
    if (r.key) $('#ext-shell-key').value = r.key;
    setTimeout(() => refreshShellUi().catch(() => {}), 600);
  });
});

$('#btn-ext-shell-newkey')?.addEventListener('click', async (e) => {
  if (!window.confirm('换 key 后，所有已经填了旧 key 的工具都要重新填一遍。继续？')) return;
  await busy(e.target.closest('button'), '生成中…', async () => {
    const r = await post('/api/openai-shell', { regenerateKey: true });
    if (r.ok === false) return setResult('#ext-shell-result', r.error ?? '生成失败', 'err');
    $('#ext-shell-key').value = r.key ?? '';
    setResult('#ext-shell-result', '新 key 已生成 ✓', 'saved');
    setTimeout(() => refreshShellUi().catch(() => {}), 600);
  });
});

/* ── 本地 Agent 工具（MCP agent-tools） ───────────────────────────────── */

async function loadAgentTools() {
  try {
    const r = await api('/api/agent-tools');
    if (!r || r.ok === false) return;
    $('#at-enabled').checked = r.enabled === true;
    $('#at-sandbox').value = r.sandboxRoot ?? '';
    $('#at-sandbox').placeholder = r.usesSessionCwd
      ? `留空 = 会话工作目录：${r.effectiveSandboxRoot ?? ''}`
      : '留空 = 会话工作目录（sessionCwd）';
    $('#at-timeout').value = r.timeoutMs ?? 30000;
    const owners = [r.ownerQQ ? `QQ ${r.ownerQQ}` : '', r.ownerWechat ? `微信 ${r.ownerWechat}` : ''].filter(Boolean);
    $('#at-owner').textContent = owners.length
      ? `当前主人：${owners.join(' / ')} · 生效沙箱：${r.effectiveSandboxRoot}`
      : '⚠️ 还没配主人 ID（QQ ownerQQ / 微信 ownerId）—— 工具会整体拒绝服务';
    $('#at-state').textContent = r.enabled
      ? (r.shellPreset === 'qq-work' && r.shellAllowLocalTools ? '已启用 · 兼容壳已接 qq-work' : '已启用')
      : '未启用';
  } catch { /* 服务没起好就静默 */ }
}

$('#btn-at-save')?.addEventListener('click', async (e) => {
  await busy(e.target.closest('button'), '保存中…', async () => {
    const r = await post('/api/agent-tools', {
      enabled: $('#at-enabled').checked,
      sandboxRoot: $('#at-sandbox').value.trim(),
      timeoutMs: Number($('#at-timeout').value) || 30000
    });
    if (r.ok === false) return setResult('#at-result', r.error ?? '保存失败', 'err');
    const bits = [r.botsRestarted ? 'QQ BOT 已重启' : '下次启动生效'];
    if (r.regenerated === false) bits.push('opencode.json 重新生成失败，看日志');
    setResult('#at-result', `已保存 ✓ ${bits.join(' · ')}`, 'saved');
    setTimeout(() => loadAgentTools().catch(() => {}), 800);
  });
});

/* ── 交流空间 ────────────────────────────────────────────────────────────
 * 一屏两栏：左边是收发的原文（跟「消息与任务」同一个数据源，但只读、不分联系人），
 * 右边是后台日志的实时流。日志流全局只连一条（connectLogs），这里只是多挂一个窗格。
 * ──────────────────────────────────────────────────────────────────────── */

let exData = null;
let exBusy = false;

function renderExchange() {
  if (!exData) return;
  const p = platform();
  const entries = exData.entries ?? [];
  if (note) {
    note.textContent = exData.missing
      ? '还没有记录 —— QQ 或微信机器人收发过消息后才有'
      : `最近 ${entries.length} 条（QQ ${exData.qqN ?? 0} · 微信 ${exData.wxN ?? 0}）`;
  }

  const stream = $('#ex-stream');
  if (!stream) return;
  if (!entries.length) {
    stream.innerHTML = '<div class="empty">两个机器人都还没有消息</div>';
    return;
  }

  stream.innerHTML = entries
    .map(
      (e) => `<div class="ex-msg${e.self ? ' self' : ''}">
        <div class="ex-msg-head">
          <span class="ex-who">${esc(e.self ? '机器人' : e.who)}</span>
          <span class="ex-conv">${e.platform === 'wechat' ? '微信 · ' : 'QQ · '}${e.kind === 'group' ? '群 ' : ''}${esc(e.target)}</span>
          <span class="ex-clock">${esc(e.clock)}</span>
        </div>
        <div class="ex-msg-text">${esc(e.text)}</div>
      </div>`
    )
    .join('');
  stream.scrollTop = stream.scrollHeight;
}

async function loadExchange(silent = false) {
  if (exBusy) return;
  exBusy = true;
  try {
    // QQ 与微信两个机器人的收发都汇总在这一页，按时间交错排列
    const [qq, wx] = await Promise.all([
      api('/api/messages?platform=qq&limit=150'),
      api('/api/messages?platform=wechat&limit=150')
    ]);
    const pick = (r) => (r && r.ok !== false ? (r.entries ?? []) : []);
    const tag = (list, pf) => list.map((e) => ({ ...e, platform: pf }));
    const merged = [...tag(pick(qq), 'qq'), ...tag(pick(wx), 'wechat')]
      .sort((a, b) => (a.clock < b.clock ? -1 : a.clock > b.clock ? 1 : 0));
    const qqN = merged.filter((e) => e.platform === 'qq').length;
    exData = { entries: merged, missing: merged.length === 0, qqN, wxN: merged.length - qqN };
    renderExchange();

    const hint = $('#ex-send-hint');
    if (hint) hint.textContent = p === 'wechat' ? '发给微信会话（iLink 得在跑）' : '发给 QQ 好友（NapCat 得在跑）';
    const target = $('#ex-target');
    if (target) target.placeholder = p === 'wechat' ? '微信会话 id' : 'QQ 号';
  } finally {
    exBusy = false;
  }
  if (!silent) setResult('#ex-send-result', '', '');
}

$('#btn-ex-refresh')?.addEventListener('click', () => loadExchange());

// 勾选状态变了要整块重画，不然只影响之后新来的行
$('#ex-only-msg')?.addEventListener('change', renderExLog);

// 只在停在这一页、并且没关自动刷新时才轮询
setInterval(() => {
  if (currentPage !== 'exchange') return;
  if ($('#ex-live')?.checked === false) return;
  loadExchange(true);
}, 4000);

$('#btn-ex-send')?.addEventListener('click', async (e) => {
  const to = $('#ex-target').value.trim();
  const text = $('#ex-text').value;
  if (!to) return setResult('#ex-send-result', '先填发给谁', 'err');
  if (!text.trim()) return setResult('#ex-send-result', '没有内容', 'err');

  const p = platform();
  await busy(e.target.closest('button'), '发送中…', async () => {
    const r = p === 'wechat'
      ? await post('/api/wechat/push', { to, text })
      : await post('/api/qq/send', { qq: to, text });
    if (r.ok === false) return setResult('#ex-send-result', r.error ?? r.output ?? '发送失败', 'err');
    setResult('#ex-send-result', '已发出', 'ok');
    $('#ex-text').value = '';
    await loadExchange(true);
  });
});

/* 主动发送 */
$('#btn-send-pick').addEventListener('click', async () => {
  const p = platform();
  let choices = [];
  if (p === 'wechat') {
    choices = (msgData?.contacts ?? []).map((c) => ({ value: c.target, label: `${c.label}（${c.target}）` }));
  } else {
    const r = await api('/api/qq/contacts');
    if (r.ok === false) return toast(r.error ?? '拿不到联系人');
    const friends = (r.friends ?? []).map((f) => ({ value: f.id, label: `好友 ${f.remark || f.id}` }));
    const groups = (r.groups ?? []).map((g) => ({ value: g.id, label: `群 ${g.name || g.id}` }));
    choices = [...friends, ...groups];
    if (!choices.length) return toast('NapCat 没在跑，拿不到好友列表 —— 直接填号也行');
  }
  if (!choices.length) return toast('没有可选的联系人');
  const pick = await openModal({ title: '选一个发送目标', text: '好友和群都在这里。', choices: choices.slice(0, 300) });
  if (pick) $('#send-target').value = pick;
});

$('#btn-send').addEventListener('click', async (e) => {
  const p = platform();
  const to = $('#send-target').value.trim();
  const text = $('#send-text').value;
  if (!to) return setResult('#send-result', '先填发给谁', 'err');
  if (!text.trim()) return setResult('#send-result', '没有要发的内容', 'err');
  const ok = await confirmBox({
    title: '确认发送？',
    text: p === 'wechat' ? `将通过微信向 ${to} 发送一条消息。` : `将通过 QQ 向 ${to} 发送一条消息。`,
    list: [text.slice(0, 120) + (text.length > 120 ? '…' : '')],
    okLabel: '发送'
  });
  if (!ok) return;
  await busy(e.target.closest('button'), '发送中…', async () => {
    const r = p === 'wechat'
      ? await post('/api/wechat/push', { to, text })
      : await post('/api/qq/send', { qq: to, text });
    if (r.ok === false) return setResult('#send-result', r.error ?? r.output ?? '发送失败', 'err');
    setResult('#send-result', '已发出', 'ok');
    await loadMessages();
  });
});

$('#btn-send-dry').addEventListener('click', async (e) => {
  const to = $('#send-target').value.trim();
  const text = $('#send-text').value;
  if (!to) return setResult('#send-result', '先填发给谁', 'err');
  await busy(e.target.closest('button'), '预览中…', async () => {
    const r = await post('/api/wechat/push', { to, text, dryRun: true });
    setResult('#send-result', r.ok === false ? r.error ?? '预览失败' : `预览通过（不碰微信）。分条结果看日志。`, r.ok === false ? 'err' : 'ok');
  });
});

/* 定时任务 */
function renderSchedules() {
  const list = S?.automation?.schedules ?? [];
  const box = $('#sched-list');
  if (!list.length) {
    box.innerHTML = '<div class="empty">还没有定时任务</div>';
    return;
  }
  box.innerHTML = list
    .map(
      (t, i) => `<div class="panel tight" data-task="${i}" style="margin-bottom:8px">
        <div class="field-row three" style="gap:10px">
          <div class="field" style="margin:0">
            <label>名字</label>
            <input data-t="name" value="${esc(t.name ?? '')}" placeholder="早安推送" spellcheck="false" />
          </div>
          <div class="field" style="margin:0">
            <label>做什么</label>
            <select data-t="kind">
              <option value="wechat-push" ${t.kind === 'wechat-push' ? 'selected' : ''}>微信发送</option>
              <option value="qq-send" ${t.kind === 'qq-send' ? 'selected' : ''}>QQ 发送</option>
              <option value="restart-all" ${t.kind === 'restart-all' ? 'selected' : ''}>整条链路重启</option>
            </select>
          </div>
          <div class="field" style="margin:0">
            <label>发给谁</label>
            <input data-t="target" value="${esc(t.target ?? '')}" placeholder="id / QQ 号" spellcheck="false" />
          </div>
        </div>
        <div class="field-row three" style="gap:10px;margin-top:8px">
          <div class="field" style="margin:0">
            <label>频率</label>
            <select data-t="everyType">
              <option value="daily" ${t.every?.type !== 'interval' ? 'selected' : ''}>每天固定时间</option>
              <option value="interval" ${t.every?.type === 'interval' ? 'selected' : ''}>每隔一段时间</option>
            </select>
          </div>
          <div class="field" style="margin:0">
            <label>时间 / 间隔</label>
            <input data-t="everyValue" value="${esc(t.every?.type === 'interval' ? t.every?.minutes ?? 30 : t.every?.time ?? '09:00')}" spellcheck="false" />
            <span class="hint">每天写 09:00；间隔写分钟数</span>
          </div>
          <div class="field" style="margin:0;display:flex;align-items:flex-end;gap:8px">
            <label class="svc-watch" style="border:0;padding:0;flex:1"><input type="checkbox" data-t="enabled" ${t.enabled ? 'checked' : ''} /> 启用</label>
            <button class="btn btn-sm btn-danger" data-t="del">删除</button>
          </div>
        </div>
        <div class="field" style="margin-top:8px">
          <label>内容</label>
          <input data-t="text" value="${esc(t.text ?? '')}" placeholder="要发的话（重启任务不用填）" spellcheck="false" />
        </div>
        ${
          t.lastRun
            ? `<div class="hint">上次：${new Date(Number(t.lastRun)).toLocaleString('zh-CN')} · ${t.lastResult?.ok ? '成功' : `失败 ${esc(t.lastResult?.detail ?? '')}`}</div>`
            : ''
        }
      </div>`
    )
    .join('');

  $$('#sched-list [data-t="del"]').forEach((b) => {
    b.addEventListener('click', () => {
      const card = b.closest('[data-task]');
      card.remove();
      toast('已从列表移除，点「保存任务」才真的删掉');
    });
  });
}

function collectSchedules() {
  return $$('#sched-list [data-task]').map((card) => {
    const v = (k) => $(`[data-t="${k}"]`, card);
    const type = v('everyType').value;
    const raw = v('everyValue').value.trim();
    return {
      name: v('name').value.trim(),
      enabled: v('enabled').checked,
      kind: v('kind').value,
      target: v('target').value.trim(),
      text: v('text').value,
      every: type === 'interval' ? { type: 'interval', minutes: Number(raw) || 30 } : { type: 'daily', time: raw || '09:00' }
    };
  });
}

$('#btn-sched-add').addEventListener('click', () => {
  const list = S?.automation?.schedules ?? [];
  list.push({ name: '', enabled: false, kind: 'wechat-push', target: '', text: '', every: { type: 'daily', time: '09:00' } });
  S.automation.schedules = list;
  renderSchedules();
});

$('#btn-sched-save').addEventListener('click', async (e) => {
  const schedules = collectSchedules();
  await busy(e.target.closest('button'), '保存中…', async () => {
    const r = await post('/api/automation', { schedules });
    if (r.ok === false) return setResult('#sched-result', r.error, 'err');
    setResult('#sched-result', `已保存 ${schedules.length} 条`, 'saved');
    await refreshState();
    renderSchedules();
  });
});

async function loadSchedules() {
  if (!S) await refreshState();
  renderSchedules();
}

/* 微信 Webhook */
const HOOK_HINT = {
  default: '固定字段：event / at / bot / from / text / kinds。自己写个小服务收最省事。',
  onebot: '输出标准 OneBot v11 事件（post_type=message），NoneBot2、Koishi、AstrBot 这类框架直接能收。',
  template: '自己写 JSON 骨架，把占位符换成真实内容 —— 适配 wxhelper、WeChatFerry 这类自定义回调格式。'
};

async function loadHook() {
  const h = await api('/api/wechat/hook');
  if (h.ok === false) return;
  $('#hookEnabled').checked = h.enabled === true;
  $('#hookUrl').value = h.url ?? '';
  $('#hookSecret').value = h.secret ?? '';
  $('#hookFormat').value = h.format ?? 'default';
  $('#hookTemplate').value = h.template ?? '';
  $('#hook-template-field').hidden = (h.format ?? 'default') !== 'template';
  $('#hook-format-hint').textContent = HOOK_HINT[h.format ?? 'default'] ?? '';
  $$('input[name="hookEvent"]').forEach((c) => {
    c.checked = (h.events ?? []).includes(c.value);
  });
}

$('#hookFormat').addEventListener('change', (e) => {
  $('#hook-template-field').hidden = e.target.value !== 'template';
  $('#hook-format-hint').textContent = HOOK_HINT[e.target.value] ?? '';
});

$('#btn-hook-save').addEventListener('click', async (e) => {
  await busy(e.target.closest('button'), '保存中…', async () => {
    const r = await post('/api/wechat/hook', {
      enabled: $('#hookEnabled').checked,
      url: $('#hookUrl').value.trim(),
      secret: $('#hookSecret').value,
      format: $('#hookFormat').value,
      template: $('#hookTemplate').value,
      events: $$('input[name="hookEvent"]').filter((c) => c.checked).map((c) => c.value)
    });
    if (r.ok === false) return setResult('#hook-result', r.error, 'err');
    setResult('#hook-result', '已保存', 'saved');
  });
});

$('#btn-hook-test').addEventListener('click', async (e) => {
  await busy(e.target.closest('button'), '发送中…', async () => {
    const r = await post('/api/wechat/hook/test');
    if (r.ok === false) return setResult('#hook-result', r.error ?? '测试失败', 'err');
    setResult('#hook-result', `对端返回 HTTP ${r.status}，连接正常`, 'ok');
  });
});

/* ── 8. 高级 ────────────────────────────────────────── */

let optGroups = null;
let optBaseline = {};

function renderOptions() {
  const host = $('#options-groups');
  if (!optGroups) return;
  const q = $('#opt-filter').value.trim().toLowerCase();
  const groups = optGroups.filter((g) => {
    if (!q) return true;
    if (g.title.toLowerCase().includes(q)) return true;
    return g.items.some((i) => (i.label + i.path + (i.hint ?? '')).toLowerCase().includes(q));
  });

  host.innerHTML = groups
    .map(
      (g) => `<div class="panel tight" data-group="${esc(g.id)}">
        <div class="panel-head"><h2>${esc(g.title)}</h2><span class="hint">${esc(g.hint ?? '')}</span></div>
        ${g.items.map((i) => renderOption(i)).join('')}
      </div>`
    )
    .join('') || '<div class="empty">没有匹配的设置项</div>';
}

function renderOption(item) {
  const v = optBaseline[item.path];
  const val = v === undefined || v === null ? '' : v;
  const path = esc(item.path);
  if (item.type === 'bool') {
    return `<label class="switch-row">
      <input type="checkbox" data-path="${path}" data-type="bool" ${val === true ? 'checked' : ''} />
      <span><strong>${esc(item.label)}</strong>${item.hint ? `<em>${esc(item.hint)}</em>` : ''}</span>
    </label>`;
  }
  if (item.type === 'select') {
    return `<div class="field">
      <label>${esc(item.label)}</label>
      <select data-path="${path}" data-type="select">
        ${(item.options ?? [])
          .map((o) => `<option value="${esc(o.value)}" ${String(val) === String(o.value) ? 'selected' : ''}>${esc(o.label)}</option>`)
          .join('')}
      </select>
      ${item.hint ? `<span class="hint">${esc(item.hint)}</span>` : ''}
    </div>`;
  }
  if (item.type === 'list') {
    const text = Array.isArray(val) ? val.join(', ') : val;
    return `<div class="field">
      <label>${esc(item.label)}</label>
      <input data-path="${path}" data-type="list" value="${esc(text)}" placeholder="${esc((item.default ?? []).join(', '))}" spellcheck="false" />
      ${item.hint ? `<span class="hint">${esc(item.hint)}</span>` : ''}
    </div>`;
  }
  // 口令一类的字段用密码框：这些页面会被人从背后看到
  const inputType = item.type === 'number' ? 'number' : item.secret ? 'password' : 'text';
  return `<div class="field">
    <label>${esc(item.label)}</label>
    <input data-path="${path}" data-type="${item.type}" type="${inputType}"
      value="${esc(val)}" placeholder="${esc(item.default ?? '')}" spellcheck="false" autocomplete="off"
      ${item.step ? `step="${item.step}"` : ''} ${item.min != null ? `min="${item.min}"` : ''} ${item.max != null ? `max="${item.max}"` : ''} />
    ${item.hint ? `<span class="hint">${esc(item.hint)}</span>` : ''}
  </div>`;
}

$('#opt-filter').addEventListener('input', () => renderOptions());

$('#btn-save-options').addEventListener('click', async (e) => {
  const values = {};
  $$('#options-groups [data-path]').forEach((el) => {
    const path = el.dataset.path;
    const type = el.dataset.type;
    let value;
    if (type === 'bool') value = el.checked;
    else if (type === 'list') value = splitIds(el.value);
    else if (type === 'number') {
      const raw = el.value.trim();
      value = raw === '' ? null : Number(raw);
      if (value !== null && !Number.isFinite(value)) return;
    } else value = el.value.trim() === '' ? null : el.value;
    if (JSON.stringify(value) !== JSON.stringify(optBaseline[path] ?? null)) values[path] = value;
  });

  const count = Object.keys(values).length;
  if (!count) return setResult('#options-result', '没有改动', 'busy');
  await busy(e.target.closest('button'), '保存中…', async () => {
    const r = await post('/api/options', { values });
    if (r.ok === false) return setResult('#options-result', r.error, 'err');
    const extra = r.bridgeRestarted ? '，桥接已重启' : '';
    setResult('#options-result', `改了 ${r.changed ?? count} 项${extra}`, 'saved');
    await loadOptions();
  });
});

async function loadOptions() {
  const r = await api('/api/options');
  if (r.ok === false) return;
  optGroups = r.groups ?? [];
  optBaseline = r.values ?? {};
  renderOptions();
}

/* ── 组件（要下载的东西） ────────────────────────────── */

let componentPoll = null;
let componentDoneKey = '';

async function loadComponents() {
  const r = await api('/api/components');
  if (r.ok === false) return;
  renderComponents(r.components ?? [], r.job ?? null);

  clearTimeout(componentPoll);
  if (r.job && !r.job.done) componentPoll = setTimeout(loadComponents, 900);
}

function renderComponents(list, job) {
  const host = $('#component-list');
  if (!list.length) {
    host.innerHTML = '<div class="empty">没检测到组件清单</div>';
    return;
  }

  host.innerHTML = list
    .map((c) => {
      const running = Boolean(job && !job.done && job.id === c.id);
      const pct = Math.max(0, Math.min(100, Number(job?.pct) || 0));
      const state = running ? `${job.note ?? '下载中'} ${pct}%` : c.note;
      const btn = running
        ? '<button class="btn btn-sm" disabled>安装中</button>'
        : `<button class="btn btn-sm ${c.installed ? '' : 'btn-primary'}" data-comp-install="${esc(c.id)}">${c.installed ? '重新装' : '装载'}</button>`;
      return `<div class="comp-item">
        <div class="comp-main">
          <div class="comp-name">${esc(c.name)}<span class="comp-need">${esc(c.need)}</span></div>
          <div class="comp-detail">${esc(c.detail)}</div>
          ${c.where ? `<div class="comp-where">${esc(c.where)}</div>` : ''}
          ${running ? `<div class="comp-bar"><i style="width:${pct}%"></i></div>` : ''}
          ${running ? `<div class="comp-note">${esc(job.note ?? '')} — 别关这个窗口，下完会自动配好</div>` : ''}
        </div>
        <div class="comp-side">
          <span class="comp-state ${c.installed ? 'is-ok' : ''}">${esc(state)}</span>
          ${btn}
        </div>
      </div>`;
    })
    .join('');

  $$('#component-list [data-comp-install]').forEach((b) => {
    b.addEventListener('click', async () => {
      const id = b.dataset.compInstall;
      const c = list.find((x) => x.id === id);
      const ok = await confirmBox({
        title: `要装 ${c?.name ?? id} 吗？`,
        text: `从官方发布页下载${c?.size ? ` ${c.size}` : ''}，装到软件自己的目录里。下完自动配好路径，不用再手填。`,
        okLabel: '开始下载'
      });
      if (!ok) return;
      await busy(b, '启动中…', async () => {
        const r = await post('/api/components', { id });
        if (r.ok === false) return setResult('#component-result', r.error ?? '起不来', 'err');
        setResult('#component-result', `开始下载 ${c?.name ?? id}…`, 'busy');
        await loadComponents();
      });
    });
  });

  // 同一轮安装只提示一次：轮询会反复渲染，不记一下会刷屏
  if (job?.done) {
    const key = `${job.id}:${job.startedAt}`;
    if (key !== componentDoneKey) {
      componentDoneKey = key;
      if (job.error) setResult('#component-result', `装失败了：${job.error}`, 'err');
      else {
        setResult('#component-result', '装好了', 'ok');
        toast('装好了');
      }
    }
  }
}

$('#btn-components-refresh').addEventListener('click', async (e) => {
  await busy(e.target.closest('button'), '检测中…', async () => {
    await loadComponents();
    setResult('#component-result', '已重新检测', 'ok');
  });
});

/* 从本地 zip 装：国内直连下不动时的兜底，走的是和下载一样的安装逻辑。 */
$('#btn-components-local').addEventListener('click', () => $('#component-file').click());

$('#component-file').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = ''; // 选同一个文件也能再触发
  if (!file) return;

  const pick = await openModal({
    title: '这个包是哪个组件的？',
    text: `${file.name}（${(file.size / 1048576).toFixed(1)} MB）`,
    choices: [
      { value: 'ffmpeg', label: 'ffmpeg（包里有 bin/ffmpeg.exe）' },
      { value: 'napcat', label: 'NapCat（包里有 NapCatWinBootMain.exe）' }
    ]
  });
  if (!pick) return;

  setResult('#component-result', `上传中 0%`, 'busy');
  const r = await uploadComponent(pick, file, (pct) => setResult('#component-result', `上传中 ${pct}%`, 'busy'));
  if (r.ok === false) return setResult('#component-result', r.error ?? '装失败', 'err');
  setResult('#component-result', '装好了', 'ok');
  toast('装好了');
  await loadComponents();
});

/** 上传 zip 并让服务端就地安装。fetch 没有上传进度，所以用 XHR。 */
function uploadComponent(id, file, onProgress) {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/components/upload');
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.setRequestHeader('x-component-id', id);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      try {
        resolve(JSON.parse(xhr.responseText));
      } catch {
        resolve({ ok: false, error: `服务端没回话（HTTP ${xhr.status}）` });
      }
    };
    xhr.onerror = () => resolve({ ok: false, error: '上传失败' });
    xhr.onabort = () => resolve({ ok: false, error: '上传被取消' });
    xhr.send(file);
  });
}

/* 路径与更新设置 */
async function loadSettings() {
  const r = await api('/api/settings');
  if (r.ok === false) return;
  $('#bridgeRoot').value = r.bridgeRoot ?? '';
  $('#root-hint').textContent = `默认：${r.defaultRoot ?? '—'}`;
  const n = r.napcat ?? {};
  $('#napcatDir').value = n.dir ?? '';
  $('#napcatQQ').value = n.qq ?? '';
  $('#napcatWsPort').value = n.wsPort ?? '';
  $('#napcatHttpPort').value = n.httpPort ?? '';
  $('#napcatExe').value = n.exe ?? '';
  $('#napcatWaitMs').value = n.waitMs ?? '';
  $('#upd-napcat-mode').value = n.updateMode ?? 'off';
  $('#upd-napcat-repo').value = n.updateRepo ?? '';
  $('#upd-napcat-asset').value = n.updateAsset ?? '';
  $('#upd-napcat-mirror').value = n.updateMirror ?? '';
  const a = r.app ?? {};
  $('#upd-app-mode').value = a.updateMode ?? 'notify';
  $('#upd-repo').value = a.updateRepo ?? '';
  $('#upd-app-mirror').value = a.updateMirror ?? '';
}

$('#btn-save-settings').addEventListener('click', async (e) => {
  await busy(e.target.closest('button'), '保存中…', async () => {
    const r = await post('/api/settings', {
      bridgeRoot: $('#bridgeRoot').value.trim(),
      napcat: {
        dir: $('#napcatDir').value.trim(),
        qq: $('#napcatQQ').value.trim(),
        wsPort: $('#napcatWsPort').value.trim(),
        httpPort: $('#napcatHttpPort').value.trim(),
        exe: $('#napcatExe').value.trim(),
        waitMs: $('#napcatWaitMs').value.trim()
      }
    });
    if (r.ok === false) return setResult('#settings-result', r.error, 'err');
    setResult('#settings-result', '已保存（重开服务后生效）', 'saved-pending');
    await refreshState();
    await loadSettings();
  });
});

$('#btn-save-updates').addEventListener('click', async (e) => {
  await busy(e.target.closest('button'), '保存中…', async () => {
    const r = await post('/api/settings', {
      app: { updateMode: $('#upd-app-mode').value, updateRepo: $('#upd-repo').value.trim(), updateMirror: $('#upd-app-mirror').value.trim() },
      napcat: {
        updateMode: $('#upd-napcat-mode').value,
        updateRepo: $('#upd-napcat-repo').value.trim(),
        updateAsset: $('#upd-napcat-asset').value.trim(),
        updateMirror: $('#upd-napcat-mirror').value.trim()
      }
    });
    if (r.ok === false) return setResult('#upd-result', r.error, 'err');
    setResult('#upd-result', '已保存', 'saved');
  });
});

$('#btn-check-updates').addEventListener('click', async (e) => {
  await busy(e.target.closest('button'), '检查中…', async () => {
    const [app, nc] = await Promise.all([api('/api/app/update'), api('/api/napcat/update')]);
    const parts = [];
    if (app.ok === false) parts.push(`软件：${app.error}`);
    else parts.push(app.updateAvailable ? `软件有新版本 ${app.tag}` : `软件已是最新（v${app.current}）`);
    if (nc.ok === false) parts.push(`NapCat：${nc.error}`);
    else parts.push(nc.updateAvailable ? `NapCat 有新版本 ${nc.tag}` : `NapCat 已是最新（${nc.current || '未知'}）`);
    const anyNew = app.updateAvailable || nc.updateAvailable;
    setResult('#upd-result', parts.join(' · '), anyNew ? 'ok' : 'busy');
    await refreshState();
  });
});

/* 原始配置 */
let rawFile = 'config';

async function loadRaw() {
  const r = await api(`/api/raw?file=${rawFile}`);
  if (r.ok === false) return setResult('#raw-result', r.error, 'err');
  $('#raw-editor').value = r.content ?? '';
  $('#raw-path').textContent = r.path ?? '—';
  setResult('#raw-result', r.exists ? '' : '这个文件还不存在，保存时会新建', r.exists ? '' : 'busy');
}

$$('#raw-tabs .tab').forEach((b) => {
  b.addEventListener('click', () => {
    $$('#raw-tabs .tab').forEach((x) => x.classList.toggle('is-active', x === b));
    rawFile = b.dataset.raw;
    loadRaw();
  });
});

$('#btn-raw-load').addEventListener('click', () => loadRaw());

$('#btn-raw-save').addEventListener('click', async (e) => {
  const content = $('#raw-editor').value;
  try {
    JSON.parse(content);
  } catch (error) {
    return setResult('#raw-result', `不是合法 JSON：${error.message}`, 'err');
  }
  const ok = await confirmBox({
    title: `覆盖 ${rawFile}.json？`,
    text: '旧内容会先备份到 state/config-backups。写坏了服务可能起不来，但能从备份恢复。',
    okLabel: '写入',
    danger: rawFile === 'secrets'
  });
  if (!ok) return;
  await busy(e.target.closest('button'), '写入中…', async () => {
    const r = await post(`/api/raw?file=${rawFile}`, { content });
    if (r.ok === false) return setResult('#raw-result', r.error, 'err');
    setResult('#raw-result', '已保存（部分设置要重启服务才生效）', 'saved-pending');
    await refreshState();
  });
});

$('#btn-selftest').addEventListener('click', async (e) => {
  const ma = S?.backend?.modelApi;
  const payload = ma ?? {};
  if (!payload.baseUrl || !payload.model) return setResult('#selftest-result', '先配好「模型来源」再自检', 'err');
  await busy(e.target.closest('button'), '自检中…', async () => {
    const r = await post('/api/test', payload);
    if (r.ok === false) return setResult('#selftest-result', r.error, 'err');
    setResult('#selftest-result', `通了：${r.model} · 首字 ${r.firstCharMs ?? '—'}ms · 回复「${String(r.reply ?? '').slice(0, 40)}」`, 'ok');
  });
});

async function loadAdvanced() {
  if (!S) await refreshState();
  await Promise.all([loadSettings(), loadOptions(), loadComponents(), loadPluginsUi()]);
  await loadRaw();
}

/* ── 8. 手机（Android 通知转发） ─────────────────────── */

let phoneData = null;

/** SmsForwarder 的变量名以它界面上那排按钮为准；这里给的是最常见的一套。 */
const PHONE_SNIPPET = '{"app":"{{app名称}}","from":"{{通知标题}}","text":"{{通知内容}}"}';

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 老内核 / 非安全上下文下 clipboard 不可用，退回临时 textarea
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

async function loadPhone() {
  phoneData = await api('/api/phone');
  if (phoneData.ok === false) {
    setResult('#phone-result', phoneData.error ?? '读不到手机推送设置', 'err');
    phoneData = null;
    return;
  }
  renderPhone();
}

function phoneFirstUrl() {
  return phoneData?.urls?.[0]?.url ?? '';
}

function renderPhone() {
  const d = phoneData;
  if (!d) return;

  $('#phoneEnabled').checked = d.enabled === true;
  $('#phoneNotifyAi').checked = d.notifyAi === true;
  $('#phonePort').value = d.port ?? '';
  $('#phoneToken').value = d.token ?? '';

  const listening = Number(d.listening) > 0;
  const state = $('#phone-state');
  if (!d.enabled) state.textContent = '没启用';
  else if (listening) state.textContent = `正在 ${d.listening} 端口等推送`;
  else state.textContent = '开了，但端口没起来 —— 换个端口再保存一次';

  // 地址
  const box = $('#phone-urls');
  if (!d.enabled) {
    box.innerHTML = '<div class="empty">还没启用</div>';
  } else if (!d.urls?.length) {
    box.innerHTML = '<div class="empty">没找到局域网地址 —— 电脑是不是没连 WiFi / 网线？</div>';
  } else {
    box.innerHTML = d.urls
      .map(
        (u) => `<div class="url-row">
          <span class="url-if" title="${esc(u.name)}">${esc(u.name)}</span>
          <span class="url-text" title="${esc(u.url)}">${esc(u.url)}</span>
          <button class="btn btn-sm" data-copy="${esc(u.url)}">复制</button>
        </div>`
      )
      .join('');
  }

  // 防火墙命令
  const fw = `netsh advfirewall firewall add rule name="DualHabitat 手机推送" dir=in action=allow protocol=TCP localport=${d.port}`;
  $('#phone-fw-cmd').textContent = fw;
  $('#phone-fw-note').hidden = d.enabled !== true;

  renderPhoneQr(d);

  // 配置片段
  $('#phone-snippet').textContent = PHONE_SNIPPET;
  const sample = phoneFirstUrl() || `http://电脑的局域网IP:${d.port}/hook/${d.token || '口令'}`;
  $('#phone-curl').textContent =
    `curl -X POST ${sample} -H "content-type: application/json" -d '{"app":"短信","from":"10086","text":"测试"}'`;

  renderPhoneRecent();
}

/**
 * 二维码：扫的是 /setup/<token>（一页配置说明），不是空的 POST 端点。
 * 用 qrcode.js（MIT，56KB）自己画到 canvas —— 不联网、不依赖外部服务。
 */
function renderPhoneQr(d) {
  const box = $('#phone-qr');
  if (!box) return;
  const target = d?.urls?.[0]?.setup;
  if (!d?.enabled || !target || typeof window.qrcode !== 'function') {
    box.innerHTML = `<div class="empty">${d?.enabled ? '拿不到局域网地址' : '启用后出现二维码'}</div>`;
    return;
  }
  try {
    const qr = window.qrcode(0, 'M');
    qr.addData(target);
    qr.make();
    const count = qr.getModuleCount();
    const quiet = 4;
    // 每个模块至少 4px：再小手机相机就吃力了。164 是卡片的显示宽度，正好 1:1 不缩放。
    const scale = Math.max(4, Math.floor(164 / (count + quiet * 2)));
    const size = (count + quiet * 2) * scale;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#000';
    for (let r = 0; r < count; r += 1) {
      for (let c = 0; c < count; c += 1) {
        if (qr.isDark(r, c)) ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
      }
    }
    canvas.className = 'qr-canvas';
    canvas.id = 'phone-qr-canvas';
    box.innerHTML = '';
    box.appendChild(canvas);
    const cap = document.createElement('div');
    cap.className = 'qr-cap';
    cap.textContent = '扫码打开配置页';
    box.appendChild(cap);
  } catch {
    box.innerHTML = '<div class="empty">二维码生成失败，用上面的地址手动填</div>';
  }
}

function renderPhoneRecent() {
  const list = phoneData?.recent ?? [];
  const box = $('#phone-recent');
  if (!list.length) {
    box.innerHTML = '<div class="empty">还没收到过</div>';
    return;
  }
  box.innerHTML = list
    .map(
      (r) => `<div class="recent-item">
        <span class="ri-time">${fmtTime(r.at)}</span>
        <span class="ri-app" title="${esc(r.app)}">${esc(r.app)}</span>
        <span class="ri-text">${r.from ? `<b>${esc(r.from)}</b> · ` : ''}${esc(r.text)}</span>
      </div>`
    )
    .join('');
}

$('#btn-phone-save').addEventListener('click', async (e) => {
  const port = Number($('#phonePort').value);
  if ($('#phoneEnabled').checked && (!Number.isFinite(port) || port < 1024 || port > 65535)) {
    return setResult('#phone-result', '端口填 1024~65535 之间的数字', 'err');
  }
  await busy(e.target.closest('button'), '保存中…', async () => {
    const r = await post('/api/phone', {
      enabled: $('#phoneEnabled').checked,
      notifyAi: $('#phoneNotifyAi').checked,
      port: Number.isFinite(port) ? port : undefined
    });
    if (r.ok === false) return setResult('#phone-result', r.error ?? '保存失败', 'err');
    if (r.enabled && r.running === false) {
      setResult('#phone-result', `已保存，但端口 ${r.port} 起不来：${r.error ?? '被占用'} —— 换一个再存`, 'err');
    } else if (r.enabled) {
      setResult('#phone-result', `已启用，正在 ${r.port} 端口等推送`, 'saved');
    } else {
      setResult('#phone-result', '已关掉，端口不再监听', 'saved');
    }
    await loadPhone();
  });
});

$('#btn-phone-token').addEventListener('click', async (e) => {
  const ok = await confirmBox({
    title: '换一个新口令？',
    text: '换完手机上填的地址也要跟着改，旧地址立刻失效。',
    okLabel: '换'
  });
  if (!ok) return;
  await busy(e.target.closest('button'), '换…', async () => {
    const r = await post('/api/phone', { regenerate: true, enabled: $('#phoneEnabled').checked });
    if (r.ok === false) return setResult('#phone-result', r.error ?? '换不了', 'err');
    setResult('#phone-result', '新口令已生成，记得更新手机上的地址', 'saved');
    await loadPhone();
  });
});

$('#btn-phone-test').addEventListener('click', async (e) => {
  await busy(e.target.closest('button'), '模拟中…', async () => {
    const r = await post('/api/phone/test', {});
    if (r.ok === false) return setResult('#phone-test-result', r.error ?? '模拟失败', 'err');
    setResult('#phone-test-result', '收到了一条（看上面列表）', 'ok');
    await loadPhone();
  });
});

$('#btn-phone-notify-test').addEventListener('click', async (e) => {
  if (!phoneData?.notifyAi) return setResult('#phone-test-result', '先把「让模型也看到」打开并保存', 'err');
  await busy(e.target.closest('button'), '投递中…', async () => {
    const r = await post('/api/phone/notify-test', {});
    if (r.ok === false) return setResult('#phone-test-result', r.error ?? '投不进去', 'err');
    setResult('#phone-test-result', `投进去了（${r.key}）—— 模型那边应该收到一条后台提醒`, 'ok');
  });
});

$('#btn-phone-refresh').addEventListener('click', () => loadPhone());

$('#btn-phone-copy').addEventListener('click', async (e) => {
  const ok = await copyText($('#phone-snippet').textContent);
  setResult('#phone-copy-result', ok ? '请求体已复制' : '复制失败，请手动选中复制', ok ? 'ok' : 'err');
});

$('#btn-phone-copy-url').addEventListener('click', async () => {
  const url = phoneFirstUrl();
  if (!url) return setResult('#phone-copy-result', '先启用，拿到地址再复制', 'err');
  const ok = await copyText(url);
  setResult('#phone-copy-result', ok ? '地址已复制' : '复制失败，请手动选中复制', ok ? 'ok' : 'err');
});

$('#btn-phone-fw-copy').addEventListener('click', async () => {
  const ok = await copyText($('#phone-fw-cmd').textContent);
  setResult('#phone-copy-result', ok ? '命令已复制，管理员 PowerShell 里粘贴运行' : '复制失败，请手动选中复制', ok ? 'ok' : 'err');
});

// 地址行里的「复制」是动态生成的，用事件委托
$('#phone-urls').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-copy]');
  if (!btn) return;
  const ok = await copyText(btn.dataset.copy);
  btn.textContent = ok ? '已复制' : '复制失败';
  setTimeout(() => { btn.textContent = '复制'; }, 1600);
});

/* ── 9. 工具开关（聊天页 QQ） ────────────────────────── */

let toolData = null;

async function loadTools() {
  toolData = await api('/api/tools');
  if (!toolData || toolData.ok === false) {
    setResult('#tools-result', toolData?.error ?? '读不到工具表', 'err');
    return;
  }
  renderTools();
}

function toolBoxes() {
  return $$('#tool-groups input[data-flag]');
}

function updateToolCounts() {
  const boxes = toolBoxes();
  const on = boxes.filter((el) => el.checked).length;
  $('#tools-count').textContent = `开着 ${on} / ${boxes.length}`;
  for (const g of toolData?.groups ?? []) {
    const items = g.items.map((it) => $(`#tool-groups input[data-flag="${it.flag}"]`)).filter(Boolean);
    const n = items.filter((el) => el.checked).length;
    const countEl = $(`[data-count-for="${g.id}"]`);
    if (countEl) countEl.textContent = `${n}/${items.length}`;
    // 组头的批量按钮：全开着就写「全关」，否则写「全开」
    const tog = $(`[data-group-toggle="${g.id}"]`);
    if (tog) tog.textContent = n === items.length ? '全关' : '全开';
  }
}

function renderTools() {
  const { groups, values } = toolData;
  $('#tool-groups').innerHTML = groups
    .map((g) => {
      const n = g.items.filter((it) => values[it.flag]).length;
      const items = g.items
        .map(
          (it) => `<label class="tool-item">
            <input type="checkbox" data-flag="${esc(it.flag)}" ${values[it.flag] ? 'checked' : ''} />
            <span>
              <span class="tool-label">${esc(it.label)}</span>
              ${it.hint ? `<span class="tool-hint">${esc(it.hint)}</span>` : ''}
              <span class="tool-tool" data-adv>${esc(it.tool ?? '')}</span>
            </span>
          </label>`
        )
        .join('');
      return `<details class="tool-group" open>
        <summary class="tool-group-head">
          <b>${esc(g.title)}</b>
          <span class="tool-group-hint">${esc(g.hint ?? '')}</span>
          <span class="tool-group-count" data-count-for="${esc(g.id)}">${n}/${g.items.length}</span>
          <span class="tool-group-toggle" data-group-toggle="${esc(g.id)}" title="这一组全开 / 全关">全开</span>
        </summary>
        <div class="tool-items">${items}</div>
      </details>`;
    })
    .join('');

  if (toolData.chatOnly) {
    setResult('#tools-result', '现在是「纯聊天」模式，模型一个工具都拿不到 —— 要开工具先把聊天页那个开关关掉', 'err');
  }
  updateToolCounts();
}

$('#tool-groups').addEventListener('change', () => updateToolCounts());

// 组头那个「全开 / 全关」：点它只改这一组，别顺手把整块折叠了
$('#tool-groups').addEventListener('click', (e) => {
  const tog = e.target.closest('[data-group-toggle]');
  if (!tog) return;
  e.preventDefault();
  e.stopPropagation();
  const g = (toolData?.groups ?? []).find((x) => x.id === tog.dataset.groupToggle);
  if (!g) return;
  const boxes = g.items.map((it) => $(`#tool-groups input[data-flag="${it.flag}"]`)).filter(Boolean);
  const allOn = boxes.length > 0 && boxes.every((el) => el.checked);
  for (const el of boxes) el.checked = !allOn;
  updateToolCounts();
});

$$('[data-tool-preset]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const kind = btn.dataset.toolPreset;
    const presets = toolData?.presets ?? {};
    const std = presets.standard ?? {};
    const readonlyOff = new Set(presets.readonlyOff ?? []);
    for (const el of toolBoxes()) {
      const flag = el.dataset.flag;
      if (kind === 'all') el.checked = true;
      else if (kind === 'readonly') el.checked = !readonlyOff.has(flag);
      else if (kind === 'chat') el.checked = presets.chat?.[flag] !== false;
      else if (kind === 'work') el.checked = presets.work?.[flag] !== false;
      else el.checked = std[flag] !== false;
    }
    updateToolCounts();
    setResult(
      '#tools-result',
      kind === 'work'
        ? '已切到「可以干活」—— 电脑操作全开，点「保存工具开关」生效'
        : kind === 'chat'
          ? '已切到「只聊天」—— 电脑操作全关，点「保存工具开关」生效'
          : '已按预设改好，点「保存工具开关」才写进去',
      ''
    );
  });
});

$('#btn-tools-save').addEventListener('click', async (e) => {
  const values = {};
  for (const el of toolBoxes()) values[el.dataset.flag] = el.checked;
  await busy(e.target.closest('button'), '保存中…', async () => {
    const r = await post('/api/tools', { values });
    if (r.ok === false) return setResult('#tools-result', r.error ?? '保存失败', 'err');
    if (!r.changed) return setResult('#tools-result', '和原来一样，没改', '');
    if (r.regenError) {
      setResult('#tools-result', `已保存，但生成配置失败：${r.regenError}`, 'err');
      $('#btn-tools-restart').hidden = false;
    } else if (r.applied) {
      setResult('#tools-result', `已保存 ${r.changed} 项 ✓ 在跑的 BOT 已重启，立即生效`, 'saved');
    } else {
      setResult('#tools-result', `已保存 ${r.changed} 项 ✓ 下次 BOT 启动生效`, 'saved-pending');
      $('#btn-tools-restart').hidden = false;
    }
    await loadTools();
  });
});

$('#btn-tools-restart').addEventListener('click', async (e) => {
  const ok = await confirmBox({
    title: '重启桥接？',
    text: 'QQ 会断开几秒，正在回的那条消息会中断。重启后新的工具表才生效。',
    okLabel: '重启'
  });
  if (!ok) return;
  await busy(e.target.closest('button'), '重启中…', async () => {
    await post('/api/bridge/stop');
    await new Promise((r) => setTimeout(r, 1200));
    const r = await post('/api/bridge/start');
    if (r.ok === false) return setResult('#tools-result', r.error ?? '起不来，看日志页', 'err');
    setResult('#tools-result', '桥接已重启，新工具表生效', 'ok');
    $('#btn-tools-restart').hidden = true;
    await refreshState();
  });
});


/* ── 9.5 语音库与 TTS（聊天页 QQ） ────────────────────── */

let voiceLibFiles = [];
let ttsCustomEngines = [];

function renderTtsProviderOptions() {
  const sel = $('#tts-provider');
  if (!sel) return;
  const current = sel.value;
  for (const opt of [...sel.querySelectorAll('option[data-custom="1"]')]) opt.remove();
  for (const e of ttsCustomEngines) {
    const opt = document.createElement('option');
    opt.value = `custom:${e.id}`;
    opt.textContent = `自定义 · ${e.label}（${e.format}）`;
    opt.dataset.custom = '1';
    sel.appendChild(opt);
  }
  if ([...sel.options].some((o) => o.value === current)) sel.value = current;
}

function renderTtsCustomList() {
  const box = $('#tts-custom-list');
  if (!box) return;
  if (!ttsCustomEngines.length) {
    box.innerHTML = '<p class="hint" style="margin:6px 0 0">还没加自定义引擎 —— 填好上面一行点「添加」，就会出现在引擎下拉框里。</p>';
    return;
  }
  box.innerHTML = ttsCustomEngines.map((e) => `<div style="display:flex;gap:8px;align-items:baseline;padding:5px 0;border-top:1px dashed rgba(127,127,127,.25)">
    <code>custom:${esc(e.id)}</code>
    <strong>${esc(e.label)}</strong>
    <span class="hint" style="flex:1;word-break:break-all">${esc(e.format)} · ${esc(e.command)}</span>
    <button class="btn btn-sm" data-tts-custom-del="${esc(e.id)}">删除</button>
  </div>`).join('');
}

async function loadVoicePanel() {
  try {
    const s = await api('/api/voice-tts');
    if (s && s.ok !== false) {
      ttsCustomEngines = Array.isArray(s.custom) ? s.custom : [];
      renderTtsProviderOptions();
      renderTtsCustomList();
      $('#tts-provider').value = s.provider ?? 'auto';
      $('#tts-voice').value = s.voice ?? '';
      $('#tts-maxchars').value = s.maxChars ?? 2000;
      $('#tts-wechat-follow').checked = s.wechatFollow === true;
    }
    const lib = await api('/api/voice-library');
    if (lib && lib.ok !== false) {
      $('#voice-lib-dir').textContent = lib.dir ?? '';
      voiceLibFiles = lib.files ?? [];
      renderVoiceLib();
    }
  } catch { /* 服务没起好就静默，下次切平台再试 */ }
}

function renderVoiceLib() {
  const box = $('#voice-lib-list');
  if (!voiceLibFiles.length) {
    box.innerHTML = '<p class="voice-lib-empty">语音库还是空的 —— 上传几段音频，或直接用上面的 TTS 合成（合成结果也会留在库里可重发）。</p>';
    return;
  }
  box.innerHTML = voiceLibFiles
    .map((f) => `<div class="voice-lib-row">
      <span class="voice-lib-name" title="${esc(f.name)}">${esc(f.name)}</span>
      <span class="voice-lib-size">${f.size ? `${Math.max(1, Math.round(f.size / 1024))} KB` : ''}</span>
      <button class="btn btn-sm" data-voice-play="${esc(f.name)}">试听</button>
      <button class="btn btn-sm" data-voice-del="${esc(f.name)}">删除</button>
    </div>`)
    .join('');
}

function playVoiceFile(name) {
  const audio = $('#tts-preview-audio');
  audio.src = `/api/voice-library/file?name=${encodeURIComponent(name)}`;
  audio.hidden = false;
  audio.play().catch(() => { /* 自动播放被拦就等用户手点 */ });
}

// 设置改动即存（服务端保存后会自动重启在跑的 QQ BOT）
let voiceSaveTimer = null;
function scheduleVoiceSave(extra = {}) {
  clearTimeout(voiceSaveTimer);
  voiceSaveTimer = setTimeout(async () => {
    const payload = {
      provider: $('#tts-provider').value,
      voice: $('#tts-voice').value.trim(),
      maxChars: Number($('#tts-maxchars').value) || 2000,
      wechatFollow: $('#tts-wechat-follow').checked,
      ...extra
    };
    const r = await post('/api/voice-tts', payload);
    if (r.ok === false) return setResult('#tts-result', r.error ?? '保存失败', 'err');
    setResult('#tts-result', r.botsRestarted ? '已保存 ✓ 在跑的 QQ BOT 已重启，立即生效' : '已保存 ✓ BOT 没在跑，下次启动生效', 'saved');
    if (r.preview?.name) playVoiceFile(r.preview.name);
  }, 700);
}

$('#tts-provider').addEventListener('change', () => scheduleVoiceSave());
$('#tts-voice').addEventListener('change', () => scheduleVoiceSave());
$('#tts-maxchars').addEventListener('change', () => scheduleVoiceSave());
$('#tts-wechat-follow').addEventListener('change', () => scheduleVoiceSave());

$('#btn-tts-custom-add')?.addEventListener('click', async (e) => {
  const id = $('#tts-custom-id').value.trim();
  const label = $('#tts-custom-label').value.trim();
  const command = $('#tts-custom-command').value.trim();
  const format = $('#tts-custom-format').value;
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(id)) return setResult('#tts-custom-result', 'id 只能是英文/数字/-_，且以字母数字开头', 'err');
  if (!command || !command.includes('{out}')) return setResult('#tts-custom-result', '命令模板必须包含 {out}', 'err');
  await busy(e.target.closest('button'), '保存中…', async () => {
    const next = ttsCustomEngines.filter((x) => x.id !== id);
    next.push({ id, label, command, format });
    const r = await post('/api/voice-tts', { custom: next, provider: `custom:${id}` });
    if (r.ok === false) return setResult('#tts-custom-result', r.error ?? '保存失败', 'err');
    $('#tts-custom-id').value = '';
    $('#tts-custom-label').value = '';
    $('#tts-custom-command').value = '';
    setResult('#tts-custom-result', '已保存 ✓ 并切到这个引擎', 'saved');
    await loadVoicePanel();
  });
});

$('#tts-custom-list')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-tts-custom-del]');
  if (!btn) return;
  const id = btn.getAttribute('data-tts-custom-del');
  if (!window.confirm(`删除自定义 TTS 引擎「${id}」？`)) return;
  await busy(btn, '删除中…', async () => {
    const r = await post('/api/voice-tts', { custom: ttsCustomEngines.filter((x) => x.id !== id) });
    if (r.ok === false) return setResult('#tts-custom-result', r.error ?? '删除失败', 'err');
    setResult('#tts-custom-result', '已删除 ✓', 'saved');
    await loadVoicePanel();
  });
});

$('#btn-tts-preview').addEventListener('click', async (e) => {
  const text = $('#tts-preview-text').value.trim();
  if (!text) return setResult('#tts-result', '先写一句要合成的话', 'err');
  await busy(e.target.closest('button'), '合成中…', async () => {
    const r = await post('/api/voice-tts', { text });
    if (r.ok === false) return setResult('#tts-result', r.error ?? '合成失败', 'err');
    if (r.preview) {
      const p = r.preview;
      const cut = p.truncated ? ` · 已按句子截断（${p.chars} → ${p.usedChars} 字）` : '';
      const fb = p.voiceFallback ? ' · 默认嗓音失败，已用慧慧兜底' : '';
      setResult('#tts-result', `合成成功：${p.provider} / ${p.voice}${fb}${cut}`, 'ok');
    } else setResult('#tts-result', '已保存', 'ok');
    if (r.preview?.name) playVoiceFile(r.preview.name);
  });
});

$('#btn-voice-refresh').addEventListener('click', () => loadVoicePanel());

$('#btn-voice-upload').addEventListener('click', () => $('#voice-file-input').click());

$('#voice-file-input').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  if (file.size > 30 * 1024 * 1024) return setResult('#tts-result', '超过 30MB 上限', 'err');
  const dataB64 = await new Promise((resolve) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1] ?? '');
    fr.onerror = () => resolve('');
    fr.readAsDataURL(file);
  });
  if (!dataB64) return setResult('#tts-result', '读文件失败', 'err');
  const r = await post('/api/voice-library', { name: file.name, dataB64 });
  if (r.ok === false) return setResult('#tts-result', r.error ?? '上传失败', 'err');
  setResult('#tts-result', `已上传 ${r.name}`, 'ok');
  await loadVoicePanel();
});

$('#voice-lib-list').addEventListener('click', async (e) => {
  const play = e.target.closest('[data-voice-play]');
  if (play) return playVoiceFile(play.dataset.voicePlay);
  const del = e.target.closest('[data-voice-del]');
  if (!del) return;
  const ok = await confirmBox({ title: '删除这段音频？', text: del.dataset.voiceDel, okLabel: '删除' });
  if (!ok) return;
  const r = await api(`/api/voice-library?name=${encodeURIComponent(del.dataset.voiceDel)}`, { method: 'DELETE' });
  if (r.ok === false) return setResult('#tts-result', r.error ?? '删除失败', 'err');
  setResult('#tts-result', '已删除', 'ok');
  await loadVoicePanel();
});

/* ── 9.6 画画与动态（聊天页 QQ） ────────────────────── */

let imageLibFiles = [];
let drawCustomEngines = [];

function renderDrawProviderOptions() {
  const sel = $('#draw-provider');
  if (!sel) return;
  const current = sel.value;
  for (const opt of [...sel.querySelectorAll('option[data-custom="1"]')]) opt.remove();
  for (const e of drawCustomEngines) {
    const opt = document.createElement('option');
    opt.value = `custom:${e.id}`;
    opt.textContent = `自定义 · ${e.label}（${e.model}）`;
    opt.dataset.custom = '1';
    sel.appendChild(opt);
  }
  if ([...sel.options].some((o) => o.value === current)) sel.value = current;
}

function renderDrawCustomList() {
  const box = $('#draw-custom-list');
  if (!box) return;
  if (!drawCustomEngines.length) {
    box.innerHTML = '<p class="hint" style="margin:6px 0 0">还没加自定义出图服务 —— 填好上面一行点「添加」，就会出现在引擎下拉框里。</p>';
    return;
  }
  box.innerHTML = drawCustomEngines.map((e) => `<div style="display:flex;gap:8px;align-items:baseline;padding:5px 0;border-top:1px dashed rgba(127,127,127,.25)">
    <code>custom:${esc(e.id)}</code>
    <strong>${esc(e.label)}</strong>
    <span class="hint" style="flex:1;word-break:break-all">${esc(e.model)} · ${esc(e.baseUrl)} · ${esc(e.apiKeyEnv)} · ${esc(e.sizeTemplate)}</span>
    <button class="btn btn-sm" data-draw-custom-del="${esc(e.id)}">删除</button>
  </div>`).join('');
}

async function loadDrawPanel() {
  try {
    const s = await api('/api/draw');
    if (s && s.ok !== false) {
      drawCustomEngines = Array.isArray(s.custom) ? s.custom : [];
      renderDrawProviderOptions();
      renderDrawCustomList();
      $('#draw-provider').value = s.provider ?? 'auto';
      $('#draw-size').value = s.size ?? '1024x1024';
      $('#draw-daily-limit').value = s.dailyLimit ?? 30;
      $('#draw-moment-limit').value = s.momentDailyLimit ?? 10;
    }
    const lib = await api('/api/image-library');
    if (lib && lib.ok !== false) {
      $('#image-lib-dir').textContent = lib.dir ?? '';
      imageLibFiles = lib.files ?? [];
      renderImageLib();
    }
  } catch { /* 服务没起好就静默，下次切平台再试 */ }
}

function renderImageLib() {
  const box = $('#image-lib-list');
  if (!imageLibFiles.length) {
    box.innerHTML = '<p class="voice-lib-empty">图库还是空的 —— 上面试画一张，或直接上传图片，模型就能发图 / 发带图说说了。</p>';
    return;
  }
  box.innerHTML = imageLibFiles
    .map((f) => `<div class="image-lib-row">
      <img class="image-lib-thumb" loading="lazy" src="/api/image-library/file?name=${encodeURIComponent(f.name)}" alt="" />
      <span class="voice-lib-name" title="${esc(f.name)}">${esc(f.name)}</span>
      <span class="image-lib-size">${f.size ? `${Math.max(1, Math.round(f.size / 1024))} KB` : ''}</span>
      <button class="btn btn-sm" data-image-del="${esc(f.name)}">删除</button>
    </div>`)
    .join('');
}

// 设置改动即存（服务端保存后会自动重启在跑的 QQ BOT）
let drawSaveTimer = null;
function scheduleDrawSave() {
  clearTimeout(drawSaveTimer);
  drawSaveTimer = setTimeout(async () => {
    const payload = {
      provider: $('#draw-provider').value,
      size: $('#draw-size').value.trim(),
      dailyLimit: Number($('#draw-daily-limit').value) || 30,
      momentDailyLimit: Number($('#draw-moment-limit').value) || 10
    };
    const r = await post('/api/draw', payload);
    if (r.ok === false) return setResult('#draw-result', r.error ?? '保存失败', 'err');
    setResult('#draw-result', r.botsRestarted ? '已保存 ✓ 在跑的 QQ BOT 已重启，立即生效' : '已保存 ✓ BOT 没在跑，下次启动生效', 'saved');
  }, 700);
}

$('#draw-provider').addEventListener('change', () => scheduleDrawSave());
$('#draw-size').addEventListener('change', () => scheduleDrawSave());
$('#draw-daily-limit').addEventListener('change', () => scheduleDrawSave());
$('#draw-moment-limit').addEventListener('change', () => scheduleDrawSave());

$('#btn-draw-custom-add')?.addEventListener('click', async (e) => {
  const id = $('#draw-custom-id').value.trim();
  const label = $('#draw-custom-label').value.trim();
  const baseUrl = $('#draw-custom-baseurl').value.trim();
  const model = $('#draw-custom-model').value.trim();
  const apiKeyEnv = $('#draw-custom-keyenv').value.trim();
  const sizeTemplate = $('#draw-custom-size').value.trim() || '{w}x{h}';
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(id)) return setResult('#draw-custom-result', 'id 只能是英文/数字/-_，且以字母数字开头', 'err');
  if (!/^https?:\/\//i.test(baseUrl)) return setResult('#draw-custom-result', 'baseUrl 要以 http:// 或 https:// 开头', 'err');
  if (!model) return setResult('#draw-custom-result', '模型名不能为空', 'err');
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(apiKeyEnv)) return setResult('#draw-custom-result', 'Key 环境变量只能是字母/数字/下划线', 'err');
  if (!sizeTemplate.includes('{w}') || !sizeTemplate.includes('{h}')) return setResult('#draw-custom-result', 'sizeTemplate 必须包含 {w} 和 {h}', 'err');
  await busy(e.target.closest('button'), '保存中…', async () => {
    const next = drawCustomEngines.filter((x) => x.id !== id);
    next.push({ id, label, baseUrl, model, apiKeyEnv, sizeTemplate });
    const r = await post('/api/draw', { custom: next, provider: `custom:${id}` });
    if (r.ok === false) return setResult('#draw-custom-result', r.error ?? '保存失败', 'err');
    for (const key of ['#draw-custom-id', '#draw-custom-label', '#draw-custom-baseurl', '#draw-custom-model', '#draw-custom-keyenv', '#draw-custom-size']) $(key).value = '';
    setResult('#draw-custom-result', '已保存 ✓ 并切到这个引擎', 'saved');
    await loadDrawPanel();
  });
});

$('#draw-custom-list')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-draw-custom-del]');
  if (!btn) return;
  const id = btn.getAttribute('data-draw-custom-del');
  if (!window.confirm(`删除自定义出图服务「${id}」？`)) return;
  await busy(btn, '删除中…', async () => {
    const r = await post('/api/draw', { custom: drawCustomEngines.filter((x) => x.id !== id) });
    if (r.ok === false) return setResult('#draw-custom-result', r.error ?? '删除失败', 'err');
    setResult('#draw-custom-result', '已删除 ✓', 'saved');
    await loadDrawPanel();
  });
});

$('#btn-draw-preview').addEventListener('click', async (e) => {
  const text = $('#draw-preview-text').value.trim();
  if (!text) return setResult('#draw-result', '先写一句画面描述', 'err');
  await busy(e.target.closest('button'), '作画中…', async () => {
    const r = await post('/api/draw', { text });
    if (r.ok === false) return setResult('#draw-result', r.error ?? '出图失败', 'err');
    if (r.preview) {
      const img = $('#draw-preview-img');
      img.src = `/api/image-library/file?name=${encodeURIComponent(r.preview.name)}`;
      img.hidden = false;
      setResult('#draw-result', `生成成功：${r.preview.provider}，已存进图库 ${r.preview.name}`, 'ok');
      await loadDrawPanel();
    } else {
      setResult('#draw-result', '已保存', 'ok');
    }
  });
});

$('#btn-image-refresh').addEventListener('click', () => loadDrawPanel());

$('#btn-image-upload').addEventListener('click', () => $('#image-file-input').click());

$('#image-file-input').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  if (file.size > 30 * 1024 * 1024) return setResult('#draw-result', '超过 30MB 上限', 'err');
  const dataB64 = await new Promise((resolve) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1] ?? '');
    fr.onerror = () => resolve('');
    fr.readAsDataURL(file);
  });
  if (!dataB64) return setResult('#draw-result', '读文件失败', 'err');
  const r = await post('/api/image-library', { name: file.name, dataB64 });
  if (r.ok === false) return setResult('#draw-result', r.error ?? '上传失败', 'err');
  setResult('#draw-result', `已上传 ${r.name}`, 'ok');
  await loadDrawPanel();
});

$('#image-lib-list').addEventListener('click', async (e) => {
  const del = e.target.closest('[data-image-del]');
  if (!del) return;
  const ok = await confirmBox({ title: '删除这张图片？', text: del.dataset.imageDel, okLabel: '删除' });
  if (!ok) return;
  const r = await api(`/api/image-library?name=${encodeURIComponent(del.dataset.imageDel)}`, { method: 'DELETE' });
  if (r.ok === false) return setResult('#draw-result', r.error ?? '删除失败', 'err');
  setResult('#draw-result', '已删除', 'ok');
  await loadDrawPanel();
});

/* ── 启动 ───────────────────────────────────────────── */


(async function boot() {
  applyI18n();
  initLogPanes();
  connectLogs();
  await refreshState();

  // 一打开就是总览：不恢复上次停留的页面，否则会直接掉进某条通道里，
  // 让人以为软件只剩那一半。
  showPage('overview');
})();
