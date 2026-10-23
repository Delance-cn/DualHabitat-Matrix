// 打一个 Windows 安装包（NSIS）。
//
// 为什么不用 `npm run pack`：那条路是 electron-builder --dir，产出的是一个文件夹，
// 发给别人得整个目录拷过去，还带一个没用的 electron.exe 图标。
// 这个脚本走 nsis target，产出单个 Setup.exe：双击装、开始菜单/桌面有快捷方式、
// 控制面板里能卸载。
//
// NapCat 的位置是机器相关的（Delance 这里是 C:\Users\<用户>\napcat-shell，
// 一个指向 Documents\默认项目\napcat\NapCat.52230.Shell 的符号链接），
// 不能写进 package.json —— 所以配置在这里现生成，再交给 electron-builder。
//
// 用法：
//   node scripts/build-installer.mjs            # 带 NapCat（安装时按需解压）
//   DHM_NO_NAPCAT=1 node scripts/build-installer.mjs   # 不带，只有 ~120 MB
//
// 带 NapCat 的包不再直接把 1.2 GB 文件塞进 app 目录，而是先压成 build/napcat.7z，
// 安装时检测本机是否已经有 NapCat：有就跳过，没有才解压到 resources/app/napcat。
// 这样安装进度只有一次解压，不会因为几千个小文件来回跳。
// 加了 --rebuild-napcat 会强制重打压缩包（默认缓存复用）。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildAgreementMacro } from './lib/agreement-nsh.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

// 1. 前置检查 ---------------------------------------------------------------

if (!fs.existsSync(path.join(root, 'bridge-dist', 'src', 'bridge.js'))) {
  console.error('缺 bridge-dist，先跑：npm run prepare:bridge');
  process.exit(1);
}
if (!fs.existsSync(path.join(root, 'vendor', 'backends', 'providers.js'))) {
  console.error('缺 vendor/backends，先跑：npm run prepare:vendor');
  process.exit(1);
}
if (!fs.existsSync(path.join(root, 'build', 'icon.ico'))) {
  console.error('缺 build/icon.ico，先跑：node scripts/make-icon.mjs');
  process.exit(1);
}

// 2. NapCat（可选） ---------------------------------------------------------

// 两个版本：
//   标准版（带 NapCat，压缩后约 300 MB）—— 安装时本机没有 NapCat 才解压
//   精简版（不带 NapCat，约 120 MB）—— 装完第一次打开时，软件自己从 GitHub 下
// 用法：
//   node scripts/build-installer.mjs                 # 标准版
//   node scripts/build-installer.mjs --no-napcat      # 精简版
//   DHM_NO_NAPCAT=1 等价于 --no-napcat
const NO_NAPCAT = process.env.DHM_NO_NAPCAT === '1' || process.argv.includes('--no-napcat');
const REBUILD_NAPCAT = process.env.DHM_REBUILD_NAPCAT === '1' || process.argv.includes('--rebuild-napcat');
const napcatRaw = process.env.DHM_NAPCAT_SRC || `${process.env.USERPROFILE}\\napcat-shell`;

const buildDir = path.join(root, 'build');
let napcatSrc = '';
if (!NO_NAPCAT) {
  if (!fs.existsSync(napcatRaw)) {
    console.error('找不到 NapCat 源目录：' + napcatRaw);
    console.error('不想带就设 DHM_NO_NAPCAT=1');
    process.exit(1);
  }
  // 符号链接必须解到真实路径，否则会打出空目录
  napcatSrc = fs.realpathSync(napcatRaw);
  if (!fs.existsSync(path.join(napcatSrc, 'NapCatWinBootMain.exe'))) {
    console.error('这个目录里没有 NapCatWinBootMain.exe：' + napcatSrc);
    process.exit(1);
  }
}

/**
 * 找 7za.exe。
 *
 * electron-builder 自己会把它下到 %LOCALAPPDATA%\electron-builder\Cache\7zip*\...\bin，
 * 不同版本目录名带随机后缀，所以按目录扫；装了 7zip-bin 的话直接用项目里的。
 */
function find7za() {
  const fromEnv = process.env.DHM_7ZA;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const local = path.join(root, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe');
  if (fs.existsSync(local)) return local;

  const cache = path.join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache');
  if (!fs.existsSync(cache)) return '';
  for (const name of fs.readdirSync(cache)) {
    if (!/^7zip/i.test(name)) continue;
    const base = path.join(cache, name);
    for (const sub of fs.readdirSync(base)) {
      for (const rel of [path.join('bin', '7za.exe'), '7za.exe']) {
        const candidate = path.join(base, sub, rel);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }
  return '';
}

// 打包 NapCat 时要排除的用户数据。
// 这些文件里有 QQ 号、OneBot / WebUI token、登录二维码、数据库和日志，
// 打进安装包就等于把本机账号泄露给所有下载的人。
const NAPCAT_EXCLUDES = [
  '-xr!*.db',
  '-xr!*.db-shm',
  '-xr!*.db-wal',
  '-xr!*.log',
  '-xr!webui.json',
  '-xr!onebot11_*.json', // 账号级 OneBot 配置（带 token）
  '-xr!onebot11.json', // 原文件带 token，后面换成清空 token 的默认配置
  '-xr!napcat_*.json', // napcat_<QQ>.json / napcat_protocol_<QQ>.json
  '-xr!napcat.json.bak-*',
  '-xr!napcat-bot.bat', // 里面有本机 QQ 号和绝对路径
  '-xr!cache',
  '-xr!logs'
];

/** 压缩包里绝对不能出现的东西。 */
const NAPCAT_FORBIDDEN = [
  [/onebot11_\d+\.json/i, '账号级 OneBot 配置'],
  [/napcat_\d+\.json/i, '账号级 NapCat 配置'],
  [/webui\.json/i, 'WebUI 配置'],
  [/guild1\.db/i, 'NapCat 数据库'],
  [/napcat-bot\.bat/i, '含 QQ 号的启动脚本'],
  [/\.log$/im, '日志文件']
];

/** 找 NapCat 的默认 OneBot 配置（onebot11.json）。 */
function findDefaultOnebot(src) {
  const versions = path.join(src, 'versions');
  if (!fs.existsSync(versions)) return '';
  for (const name of fs.readdirSync(versions)) {
    const file = path.join(
      versions,
      name,
      'resources',
      'app',
      'napcat',
      'config',
      'onebot11.json'
    );
    if (fs.existsSync(file)) return file;
  }
  return '';
}

/** 名单里有没有不该带出去的文件。 */
function findLeakedFiles(list) {
  const hits = [];
  for (const [pattern, label] of NAPCAT_FORBIDDEN) {
    if (pattern.test(list)) hits.push(label);
  }
  return hits;
}

let napcatArchive = '';
if (napcatSrc) {
  const seven = find7za();
  if (!seven) {
    console.error('找不到 7za.exe（打包 NapCat 用）。');
    console.error('装一个 7zip-bin，或设 DHM_7ZA=<7za.exe 路径>');
    process.exit(1);
  }

  /** 列压缩包内容。 */
  const listArchive = (file) =>
    String(
      spawnSync(seven, ['l', '-ba', file], {
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024
      }).stdout || ''
    );

  // 默认 OneBot 配置：清空所有 token 后再放进包里。
  // 新机器第一次登录时 NapCat 会用它生成 onebot11_<QQ>.json，
  // 这样 3001 端口默认就是开的，又不会带上本机的 token。
  let stagedOnebot = '';
  const defaultOnebot = findDefaultOnebot(napcatSrc);
  if (defaultOnebot) {
    const config = JSON.parse(fs.readFileSync(defaultOnebot, 'utf8'));
    const network = config.network ?? {};
    for (const key of [
      'httpServers',
      'httpSseServers',
      'websocketServers',
      'httpClients',
      'websocketClients'
    ]) {
      for (const item of network[key] ?? []) {
        if (!item || typeof item !== 'object') continue;
        for (const field of ['token', 'accessToken', 'secret']) {
          if (field in item) item[field] = '';
        }
      }
    }
    stagedOnebot = path.relative(napcatSrc, defaultOnebot);
    const stagingRoot = path.join(buildDir, 'napcat-default');
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    const stagingFile = path.join(stagingRoot, stagedOnebot);
    fs.mkdirSync(path.dirname(stagingFile), { recursive: true });
    fs.writeFileSync(stagingFile, JSON.stringify(config, null, 2) + '\n', 'utf8');
  }

  napcatArchive = path.join(buildDir, 'napcat.7z');
  // 这几次文件变了就重打；单独改别的文件用 --rebuild-napcat
  const markers = ['NapCatWinBootMain.exe', 'package.json', 'resources/app.asar'];
  let newest = 0;
  for (const rel of markers) {
    const file = path.join(napcatSrc, rel);
    if (fs.existsSync(file)) newest = Math.max(newest, fs.statSync(file).mtimeMs);
  }

  const exists = fs.existsSync(napcatArchive);
  let existingList = '';
  if (exists) existingList = listArchive(napcatArchive);
  const existingHasSecrets = exists && findLeakedFiles(existingList).length > 0;
  const stale =
    REBUILD_NAPCAT ||
    !exists ||
    fs.statSync(napcatArchive).size < 50 * 1024 * 1024 ||
    existingHasSecrets ||
    (stagedOnebot && !existingList.includes('onebot11.json')) ||
    (newest > 0 && newest > fs.statSync(napcatArchive).mtimeMs);

  if (stale) {
    console.log('压缩 NapCat（1.2 GB → build/napcat.7z，第一次要几分钟）…');
    if (existingHasSecrets) {
      console.log('  旧压缩包里有账号数据，重打：' + findLeakedFiles(existingList).join('、'));
    }
    try {
      fs.unlinkSync(napcatArchive);
    } catch {
      /* 不存在就算了 */
    }
    // 在源目录里用 * 打包，压缩包根部就是 NapCat 的内容，
    // 解压到 resources/app/napcat 后正好是 NapCatWinBootMain.exe 所在层。
    const packed = spawnSync(
      seven,
      ['a', '-t7z', '-mx=5', '-mmt=on', '-bsp0', ...NAPCAT_EXCLUDES, napcatArchive, '*'],
      { cwd: napcatSrc, stdio: 'inherit' }
    );
    if (packed.status !== 0) {
      console.error('NapCat 压缩失败，退出码 ' + packed.status);
      process.exit(packed.status ?? 1);
    }

    // 补回清空 token 的默认配置
    if (stagedOnebot) {
      const added = spawnSync(
        seven,
        ['a', '-t7z', '-mx=5', '-mmt=on', '-bsp0', napcatArchive, stagedOnebot],
        { cwd: path.join(buildDir, 'napcat-default'), stdio: 'inherit' }
      );
      if (added.status !== 0) {
        console.error('写入默认 OneBot 配置失败，退出码 ' + added.status);
        process.exit(added.status ?? 1);
      }
    }
  } else {
    console.log('复用 build/napcat.7z（要重打加 --rebuild-napcat）');
  }

  // 校验：启动器在、默认配置在、没有账号数据
  const finalList = listArchive(napcatArchive);
  if (!finalList.includes('NapCatWinBootMain.exe')) {
    console.error('NapCat 压缩包不完整，里面没有 NapCatWinBootMain.exe');
    process.exit(1);
  }
  if (stagedOnebot && !finalList.includes('onebot11.json')) {
    console.error('NapCat 压缩包里没有默认 OneBot 配置');
    process.exit(1);
  }
  const leaked = findLeakedFiles(finalList);
  if (leaked.length > 0) {
    console.error('NapCat 压缩包里还有账号数据：' + leaked.join('、'));
    console.error('删掉 build/napcat.7z 后加 --rebuild-napcat 重打');
    process.exit(1);
  }

  console.log(
    '  NapCat 压缩包：' +
      (fs.statSync(napcatArchive).size / 1024 / 1024).toFixed(1) +
      ' MB（已排除账号配置、数据库、日志、二维码）'
  );
}

// 3. 生成 electron-builder 配置 --------------------------------------------

/**
 * 上一次打包的残骸先清掉。
 *
 * 踩过（2026-10-20）：打包中途失败会留下 dist/win-unpacked，下次 electron-builder
 * 复制 Electron 时要先删它，删除撞上杀毒软件/索引器的短暂占用就报
 *   EPERM: operation not permitted, rmdir '...\dist\win-unpacked\locales'
 * 而这一步在收集依赖之前，看起来像"打包器坏了"，其实只是残留目录删不掉。
 * 自己先删、带重试，比让 electron-builder 在中间删稳。
 */
function cleanDist() {
  const dir = path.join(root, 'dist');
  if (!fs.existsSync(dir)) return;
  for (let i = 0; i < 3; i += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
      return;
    } catch (error) {
      console.log(`  清 dist 失败（第 ${i + 1} 次）：${error?.code ?? error}，等一下再试`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800);
    }
  }
  console.log('  dist 清不掉，继续交给 electron-builder（大概率会 EPERM）');
}
cleanDist();

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const extraResources = [
  // 注意：electron-builder 的复制过滤器会把**源目录根部的 node_modules 整个丢掉**
  // （util/filter.js: `if (relative === "node_modules") return false`），
  // 所以 bridge-dist/node_modules 得单独当一条 from 来拷 —— 那条的源目录是
  // node_modules 本身，相对路径里就不会再出现根级 node_modules。
  // 踩过：只写上面这一条，装出来的包 resources/bridge 只有 1.4MB，桥接一启动就
  // Cannot find module 'effect'。
  { from: 'bridge-dist', to: 'bridge' },
  { from: 'bridge-dist/node_modules', to: 'bridge/node_modules' }
];

// 安装向导第一页的提示文本：**编译期**直接编进 NSIS 脚本。
//
// 早先的做法是 File 解到 $PLUGINSDIR 再用 FileReadUTF16LE 读，结果在别人的机器上
// 弹「提示文本读取失败」并中止安装 —— 临时目录被拦 / 解压没落地都会踩到。
// 现在改成生成一个 !macro，一行一次 EM_REPLACESEL 灌进编辑框，运行时不碰文件。
const agreementTxt = path.join(buildDir, 'agreement.txt');
if (!fs.existsSync(agreementTxt)) {
  console.error('缺 build/agreement.txt');
  process.exit(1);
}
const { macro: fillMacro, lines: agreementLineCount } = buildAgreementMacro(agreementTxt);

// 生成 build/custom.nsh：开头补上宏和绝对路径，再把模板原样接上。
// NSIS 由 electron-builder 用 -INPUTCHARSET UTF8 编译，源文件直接写 UTF-8 即可。
const nshTemplate = fs.readFileSync(path.join(buildDir, 'nsis', 'custom.nsh'), 'utf8');
const defines = [
  ...(napcatArchive ? [`!define DHM_NAPCAT_7Z "${napcatArchive}"`] : [])
].join('\n');
const customNsh = path.join(buildDir, 'custom.nsh');
// 加 BOM：-INPUTCHARSET UTF8 只管主脚本，!include 进来的文件要靠 BOM 标明 UTF-8，
// 否则中文路径会被按 ANSI 读，行尾引号被吞掉，报 "unterminated string"。
fs.writeFileSync(customNsh, '\uFEFF' + defines + '\n\n' + fillMacro + '\n\n' + nshTemplate, 'utf8');
console.log(`提示文本：${agreementLineCount} 行，已编进脚本（运行时不落地临时文件）`);

const config = {
  appId: 'cn.delance.dualhabitat-matrix',
  productName: 'DualHabitat Matrix',
  copyright: 'DualHabitat Matrix',
  directories: { output: 'dist', buildResources: 'build' },
  // 直接用 node_modules 里已经解好的 Electron。让它自己去下载的话，
  // 在受限网络下会卡在半路不动（实测：卡在 electron zip 下载 12MB 处 10 分钟没反应）。
  electronDist: 'node_modules/electron/dist',
  // asar 关掉：napcat 里是可执行的 .exe/.dll，塞进 asar 里跑不起来；
  // 而且本项目的界面本来就是明文 js，压成 asar 只是碍事。
  asar: false,
  files: ['main.mjs', 'shutdown.mjs', 'server.mjs', 'public/**/*', 'vendor/**/*', 'package.json'],
  extraResources,
  compression: 'normal',
  win: {
    target: ['nsis'],
    icon: 'build/icon.ico',
    // 标准版给普通用户；精简版单独带 -lite 后缀，避免覆盖
    artifactName: napcatSrc
      ? 'DualHabitat-Matrix-Setup-${version}.${ext}'
      : 'DualHabitat-Matrix-Setup-${version}-lite.${ext}'
  },
  nsis: {
    // 安装向导第一页（提示 + 勾选）和 NapCat 按需解压都在这个脚本里
    include: 'custom.nsh',
    // 不强制装到 Program Files，装完不需要管理员权限 —— 发给别人少一道坎
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'DualHabitat Matrix',
    uninstallDisplayName: 'DualHabitat Matrix',
    // 卸载时别顺手删掉用户填的 QQ 号 / 微信登录态
    deleteAppDataOnUninstall: false,
    runAfterFinish: true
  }
};

const configPath = path.join(root, 'build', 'installer.generated.json');
fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
console.log('配置 → build/installer.generated.json');
console.log('  NapCat：' + (napcatSrc ? `${napcatSrc}（安装时按需解压）` : '不带（精简版，装完由软件自己下载）'));
console.log(
  '  产物名：' +
    (napcatSrc
      ? `DualHabitat-Matrix-Setup-${pkg.version}.exe`
      : `DualHabitat-Matrix-Setup-${pkg.version}-lite.exe`)
);

// 4. 跑 electron-builder ---------------------------------------------------

const env = { ...process.env };
// WorkBuddy 会注入 --require node-language-shim.cjs，electron-builder 的子进程读到会跑偏
delete env.NODE_OPTIONS;
delete env.ELECTRON_RUN_AS_NODE;

/**
 * PATH 必须是 Windows 形式。
 *
 * 踩过（2026-10-20）：从 Git Bash 里跑这个脚本，PATH 是 `/c/Users/...` 这种 POSIX 写法。
 * electron-builder 在 Windows 上会用 `powershell.exe -EncodedCommand` 包一层去跑
 * `npm list --json`，而 powershell 读不懂 POSIX 路径 —— 于是 `node`/`npm` 全"找不到"，
 * 输出空字符串，最后抛 `No JSON content found in output`。
 * 看着像 electron-builder 的 bug，其实是 PATH 形式不对。
 */
function toWindowsPath(value) {
  return String(value ?? '')
    .split(path.delimiter)
    .map((p) => p.replace(/^\/([a-zA-Z])\//, (_, d) => `${d.toUpperCase()}:\\`).replace(/\//g, '\\'))
    .filter((p) => /^[a-zA-Z]:\\/.test(p));
}

const systemRoot = env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows';
const winPath = [
  ...new Set([
    path.dirname(process.execPath),
    path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0'),
    path.join(systemRoot, 'System32', 'Wbem'),
    path.join(systemRoot, 'System32'),
    systemRoot,
    ...toWindowsPath(env.PATH ?? env.Path)
  ])
].join(';');
env.PATH = winPath;
env.Path = winPath;

// NSIS 的 makensis 是 electron-builder 第一次打安装包时才去下的（GitHub Releases）。
// 国内直连 GitHub 的 release 资源经常挂，走 npmmirror 的镜像：
//   https://registry.npmmirror.com/-/binary/electron-builder-binaries/<包名>/<文件>
// 已经下过的会落在 %LOCALAPPDATA%\electron-builder\Cache，第二次不用再下。
env.ELECTRON_BUILDER_BINARIES_MIRROR =
  env.ELECTRON_BUILDER_BINARIES_MIRROR ||
  'https://registry.npmmirror.com/-/binary/electron-builder-binaries';

// 直接跑 electron-builder 的 js 入口，不经过 .cmd。
// 踩过：spawn 一个带空格的 .cmd 路径 + shell:true，cmd 会把它按空格截断成
// 'C:\Users\<用户>\WorkBuddy' is not recognized —— 这条路在本机（用户目录带空格）根本走不通。
const cli = path.join(root, 'node_modules', 'electron-builder', 'cli.js');
if (!fs.existsSync(cli)) {
  console.error('找不到 electron-builder，先 npm install');
  process.exit(1);
}

console.log('');
console.log('开始打包（带 NapCat 时安装包约 400 MB，压缩会跑几分钟）…');
const r = spawnSync(process.execPath, [cli, '--win', 'nsis', '--config', configPath], {
  cwd: root,
  env,
  stdio: 'inherit'
});

if (r.status !== 0) {
  console.error('打包失败，退出码 ' + r.status);
  process.exit(r.status ?? 1);
}

// 5. 报产物 ----------------------------------------------------------------

const distDir = path.join(root, 'dist');
const setup = fs
  .readdirSync(distDir)
  .filter((f) => /Setup.*\.exe$/i.test(f))
  .map((f) => ({ f, m: fs.statSync(path.join(distDir, f)).mtimeMs }))
  .sort((a, b) => b.m - a.m)[0];

if (!setup) {
  console.error('没找到 Setup exe，检查 dist/');
  process.exit(1);
}
const sizeMb = (fs.statSync(path.join(distDir, setup.f)).size / 1024 / 1024).toFixed(1);
console.log('');
console.log('完成：dist/' + setup.f + '  ' + sizeMb + ' MB');
