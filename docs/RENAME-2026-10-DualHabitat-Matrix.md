# 改名记录：`qq-bridge` → `DualHabitat Matrix`（2026-10-19）

> 一句话：**品牌名、目录名、包名、junction、env 前缀、打包产物名全部换成 `DualHabitat Matrix` 系**；
> 上游出处（`Derpyu520/qq-bridge`）和上游快照 `upstream/` 一个字没动 —— 那是别人的名字。
> 兼容别名只留在**不进打包名单**的开发脚本里；对外产物零旧名。

上一轮改名（`opencode` → `matrix`）见 [RENAME-2026-10-matrix.md](RENAME-2026-10-matrix.md)。

## 一、命名映射

| 类别 | 旧 | 新 |
|---|---|---|
| 品牌 / 显示名 | `qq-bridge` / `QQBridge` | **`DualHabitat Matrix`** |
| 仓库目录 | `默认项目\qq-bridge` | `默认项目\DualHabitat-Matrix` |
| dev clone 目录 | `WorkBuddy AI\2026-10-17-22-01-18\QQbridge-TEST` | `…\DualHabitat-Matrix` |
| junction | `C:\Users\<用户>\qqbridge` | `C:\Users\<用户>\DualHabitatMatrix` |
| 包名（桥接） | `qq-bridge` / `qq-bridge-opencode` | `dualhabitat-matrix` |
| 包名（桌面端） | `qqbridge-desktop` | `dualhabitat-matrix-desktop` |
| appId | `cn.delance.qqbridge` | `cn.delance.dualhabitat-matrix` |
| productName / exe | `QQBridge` / `QQBridge.exe` | `DualHabitat Matrix` / `DualHabitat Matrix.exe` |
| 绿色版产物目录 | `release\QQBridge-win32-x64` | `release\DualHabitat-Matrix-win32-x64` |
| env 前缀 | `QQBRIDGE_*` | `DHM_*` |
| localStorage 键 | `qqbridge-theme` / `-platform` / `-mode` | `dhm-theme` / `dhm-platform` / `dhm-mode` |
| Electron userData | `%APPDATA%\qqbridge-desktop` | `%APPDATA%\dualhabitat-matrix-desktop` |

## 二、改了哪几份

三份副本全改（业务内容逐一核对过）：

1. **canonical 桥接**：`默认项目\DualHabitat-Matrix`（junction 的目标，跑的是这份）；
2. **dev clone + 桌面端**：`…\DualHabitat-Matrix\desktop\`（`desktop/` 只在这份里）；
3. **打包版**：`…\desktop\release\DualHabitat-Matrix-win32-x64\resources\app\`。

canonical 与 dev 是同一个 GitHub 仓库（`Delance-cn/QQbridge-TEST.git`）的**两个独立 clone**，不是 worktree。
⚠️ **git remote 没改** —— 改远程仓库名要在 GitHub 上做，本地改不动。（"发给别人用的版本"如果要连仓库一起改名，这是唯一剩下的一步。）

## 三、兼容策略：谁保留旧名，谁必须干净

打包名单是 `desktop/package.json` 的 `build.files`：`main.mjs`、`server.mjs`、`public/**/*`、`vendor/**/*`、`package.json`。
**凡是不在这张名单里的文件，才允许出现旧名。**

| 位置 | 处理 | 理由 |
|---|---|---|
| `desktop/scripts/prepare-vendor.mjs` / `prepare-bridge.mjs` / `build-green.mjs` | **保留** `QQBRIDGE_SRC` / `QQBRIDGE_NO_NAPCAT` / `QQBRIDGE_NAPCAT_SRC` 兼容读（新名优先） | 这三个脚本不进打包名单，你现有的一键脚本/环境变量不用改 |
| `desktop/main.mjs` / `server.mjs` / `public/**` | **只留新名**，无任何旧名回退 | 在打包名单里：旧名一旦出现就等于发给别人了 |
| userData 目录、localStorage 键 | 靠 `desktop/scripts/migrate-legacy-state.mjs` **一次性本地迁移**，代码里不做运行时兼容 | 同上：运行时兼容必然把旧名写进产物 |

### 一次性本地迁移（只需跑一次）

```
cd <dev>\desktop
node_modules\electron\dist\electron.exe scripts\migrate-legacy-state.mjs
```

做两件事：① 旧 userData 目录整目录复制到新目录（已存在则跳过，不覆盖）；② 在与真实桌面端同一个
origin（`http://127.0.0.1:3200`）上，把 3 个旧 localStorage 键读出来写成新键再删旧键。幂等。

迁移了就不需要旧名兼容；不迁移的话界面上的主题 / 平台 / 模式三个偏好要重新点一下，别的都不受影响
（`settings.json` 里的 `bridgeRoot` 是搬目录时一起过去的）。

## 四、刻意**没**改的东西

| 位置 | 为什么 |
|---|---|
| `Derpyu520/qq-bridge`（README 里的出处链接、LICENSE 沿袭说明、git 历史） | **上游项目的名字**。改了就是把别人作品的出处一起改了 |
| `upstream/`（原项目快照） | 别人的代码，原样留存 |
| `README.en.md` | 经核对是**上游英文 README**（内容讲 DSH、引用 `docs/guides/*` 这些本仓库没有的路径）。本次按"上游文档"处理：保留原名 |
| `spike/logs/*.jsonl` | 历史日志快照，改了等于伪造记录 |
| `*.bak-*`（config / opencode / bridge.js 的备份） | 备份，动它就没意义了 |
| `.oc/`（引擎自己的会话库）、`oc-*.js`、`oc*` DOM id | 引擎的命名，不是我们的牌子 |
| `@opencode/client` npm 依赖、`opencode.json` 文件名 | 引擎自己的产物名，改了它找不到自己的文件 |

## 五、回滚

- 文本改动：`%TEMP%\opencode\rename-backup-<tag>-<目录名>\` 下有**改动前**的完整文件（按相对路径存放），
  整目录拷回去即可。三个 tag：`canonical` / `dev` / `packaged`。
- 目录 / junction：把目录名改回去、junction 重建、`config.json` 的 `sessionCwd` 与
  `settings.json` 的 `bridgeRoot` 改回去。
- 迁移过的 userData：旧目录还在（迁移是复制不是移动）。

## 六、验证

```powershell
# 桥接侧：应只剩「上游出处」和「改名记录文档」两类命中
rg -n 'qqbridge|qq-bridge|QQBRIDGE|QQBridge' "C:\Users\<用户>\Documents\默认项目\DualHabitat-Matrix" `
  -g '!upstream/**' -g '!spike/logs/**' -g '!*.bak*'

# 对外产物：必须零命中
rg -n 'qqbridge|qq-bridge|QQBRIDGE|QQBridge' `
  "…\desktop\release\DualHabitat-Matrix-win32-x64\resources\app" -g '!napcat/**'
```

第二条**必须为空** —— 那是「发给别人用的版本」的干净度判据。

## 七、装好之后的自动迁移（2026-10-20 补）

改名把 Electron 的 userData 目录也换了：旧 `%APPDATA%\qqbridge-desktop` → 新 `%APPDATA%\dualhabitat-matrix-desktop`。
`desktop/server.mjs` 的 `migrateLegacyUserData()` 会在新 `settings.json` 不存在时，从旧目录搬 `settings.json` / `automation.json`，
写完 `migratedFrom` 就不再搬第二次。旧 `bridgeRoot`（`C:\Users\<用户>\qqbridge`）已不存在，迁移时直接删掉，回落到默认根目录。

安装包本身仍是原地覆盖：appId 没变 → NSIS GUID 不变，且 `deleteAppDataOnUninstall: false`，不会和旧版并存。
