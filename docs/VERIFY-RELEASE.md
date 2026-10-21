# 校验发布包（Sigstore）

Release 里的安装包除了 `.exe`，还会多两个文件：

- `DualHabitat-Matrix-Setup-x.y.z.exe.sigstore.json` —— Sigstore bundle：一次性签名证书、签名、Rekor 透明日志的收录证明
- `SHA256SUMS.txt` —— 所有 `.exe` 的 SHA-256

这页讲的是**文件有没有被换过**，不是 Windows 的「发布者签名」。

> 安装时仍然可能出现 SmartScreen 的「未知发布者」——项目没有购买 Authenticode 证书。
> Sigstore 不进入 Windows 的受信任发布者体系，消不掉那个提示。两者区别见文末。

## 1. 安装 cosign

Windows：

```powershell
winget install sigstore.cosign
```

如果 winget 源里没有，去 <https://github.com/sigstore/cosign/releases> 下载
`cosign-windows-amd64.exe`，改名为 `cosign.exe`，放进一个在 PATH 里的目录。

确认：

```powershell
cosign version
```

macOS / Linux 用各自的包管理器（`brew install cosign`、`apt install cosign` 等）。

## 2. 把两个文件放在同一个目录

```text
DualHabitat-Matrix-Setup-0.2.0.exe
DualHabitat-Matrix-Setup-0.2.0.exe.sigstore.json
```

## 3. 校验

PowerShell：

```powershell
cosign verify-blob .\DualHabitat-Matrix-Setup-0.2.0.exe `
  --bundle .\DualHabitat-Matrix-Setup-0.2.0.exe.sigstore.json `
  --certificate-identity-regexp "^https://github\.com/Delance-cn/DualHabitat-Matrix/\.github/workflows/sign-release\.yml@refs/(heads|tags)/.+$" `
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com"
```

bash：

```bash
cosign verify-blob DualHabitat-Matrix-Setup-0.2.0.exe \
  --bundle DualHabitat-Matrix-Setup-0.2.0.exe.sigstore.json \
  --certificate-identity-regexp '^https://github\.com/Delance-cn/DualHabitat-Matrix/\.github/workflows/sign-release\.yml@refs/(heads|tags)/.+$' \
  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com'
```

通过时会输出：

```text
Verified OK
```

## 这几个参数在确认什么

| 参数 | 含义 |
|---|---|
| `--certificate-identity-regexp` | 签名必须来自本仓库的 `sign-release.yml` 工作流（`main` 分支或某个 tag） |
| `--certificate-oidc-issuer` | 签名身份由 GitHub Actions 的 OIDC 签发 |
| bundle 里的 Rekor 条目 | 签名时间、证书、文件哈希都进了公开透明日志，可事后查 |

签名身份是**工作流**，不是某个人。也就是说：任何能在本仓库触发这个工作流的人，签出来的身份都相同。
所以仓库的写权限本身就是信任边界。

## SHA-256 对照

```powershell
Get-FileHash .\DualHabitat-Matrix-Setup-0.2.0.exe -Algorithm SHA256
```

和 `SHA256SUMS.txt` 里对应那一行比。

## 校验失败

| 输出 | 多半是 |
|---|---|
| `no matching signatures` | bundle 和 exe 不配套，或者 exe 被改过 |
| `certificate identity mismatch` | 不是本仓库的 `sign-release.yml` 签的 |
| `x509: certificate signed by unknown authority` | cosign 版本太旧，或系统时间不对 |

重新下载两个文件再试一次；仍然失败就不要运行。

## 它不能做什么

- 不能让 Windows 显示发布者名称，也不能消掉 SmartScreen 提示
- 不能证明 exe 是由某个 commit 构建的（当前是本地打包后上传；要证明构建来源，得把构建也搬进 CI，并附 SLSA provenance）
- 不能替代杀毒软件

它证明的是：**这个文件在某个时间被本仓库的发布工作流签名，且签名之后没有被修改。**

## 维护者

- 新建并发布 Release 后，`sign-release` 会自动跑一次
- 也可以在 Actions 里手动 `Run workflow`，填入 tag
- 如果签名后又重新上传了 exe，必须重跑一次，否则 bundle 对不上
- 首次启用前，确认 Settings → Actions → General → Workflow permissions 允许 **Read and write**
