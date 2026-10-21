# backends/ui/drive.ps1 —— 前台客户端后端的窗口驱动（v4）。
#
# 一轮 = 定位窗口 → 定位输入框/发送按钮 → 发送 → 等完成 → 提取答案 → JSON。
#
# 发送两条路（inputMode）：
#   uia  SetValue 直写输入框 + Invoke 点发送。不碰焦点/剪贴板；React 系客户端多半不认。
#   keys 激活窗口 → UIA SetFocus 输入框 → 全选覆盖粘贴 → 发送键。
#   auto 先 uia 后 keys。
#
# 发送确认（v4 改）：不等输入框清空（有的客户端清得慢），轮询 6 秒看三个信号：
#   ① 输入框值被清空  ② 会话里出现提示词回显（Text 元素含提示词头） ③ 2.5s 时补点一次发送按钮
# 全没有才判失败。
#
# 答案提取（v4 改）：配了 CopyButtonRegex 时优先点「复制回复」按钮读剪贴板（零噪音）；
# 没配或没读到，回落「prompt 尾锚起步 + before 尾锚收尾」的文本差分。
#
# stdout 只输出最后一行 JSON；过程日志走 stderr。

param(
  [string]$PromptFile = '',
  [string]$Process = '',
  [string]$TitleRegex = '',
  [string]$InputMode = 'auto',
  [string]$SendKeys = '{ENTER}',
  [string]$SendButtonRegex = '^发送$|^Send$',
  [string]$InputNameRegex = '提示词|输入|prompt|message|ask',
  [string]$CopyButtonRegex = '',
  [int]$MinWaitMs = 6000,
  [int]$MaxWaitMs = 240000,
  [int]$PollMs = 1500,
  [int]$IdleGuardMs = 5000,
  [int]$StableRounds = 3,
  [string]$StopRegex = '',
  [string]$ReadMode = 'auto',
  [string]$ClickInputPct = '50%,48%;50%,90%',
  [string]$ClickReadPct = '50%,40%',
  [switch]$DebugShots,
  [string]$Action = 'turn',
  [string]$NewChatButtonRegex = '新建会话|新对话|New [Cc]hat|新聊天',
  [switch]$KeepClipboard
)

$ErrorActionPreference = 'Stop'
# stdout/stderr 统一 UTF-8：Node 侧按 UTF-8 解码，桥接日志里的中文才不乱码
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$sw0 = [System.Diagnostics.Stopwatch]::StartNew()
try { [IO.File]::AppendAllText("$env:TEMP\dhm-ui-trace.log", "==== 脚本启动 ====$([char]10)", [System.Text.Encoding]::UTF8) } catch { }
try {
function Log([string]$msg) {
  [Console]::Error.WriteLine(("[ui] {0} {1}" -f ($sw0.ElapsedMilliseconds.ToString().PadLeft(6)), $msg))
  # 追加式追踪文件：进程被杀也不丢（排「UIA 挂住」这类问题靠它）
  try { [IO.File]::AppendAllText("$env:TEMP\dhm-ui-trace.log", ("[{0}] {1}$([char]10)" -f ($sw0.ElapsedMilliseconds), $msg), [System.Text.Encoding]::UTF8) } catch { }
}
function Out-Json($obj) { [Console]::Out.Write(($obj | ConvertTo-Json -Depth 4 -Compress)) }
function Fail($stage, $msg) { Out-Json @{ ok = $false; error = $msg; stage = $stage }; exit 1 }

Add-Type -AssemblyName System.Windows.Forms | Out-Null
Add-Type -AssemblyName UIAutomationClient | Out-Null
Add-Type -AssemblyName UIAutomationTypes | Out-Null

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class Win32U {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [StructLayout(LayoutKind.Sequential)]
  public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hWnd, ref POINT p);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtra);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x, y; }
}
"@

function Get-IdleMs {
  $info = New-Object Win32U+LASTINPUTINFO
  $info.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type][Win32U+LASTINPUTINFO])
  [void][Win32U]::GetLastInputInfo([ref]$info)
  $now = [int64]([Environment]::TickCount -band 0x7FFFFFFF)
  $diff = $now - [int64]($info.dwTime -band 0x7FFFFFFF)
  if ($diff -lt 0) { $diff += 4294967296 }
  return $diff
}

function Confirm-Foreground($wantPid) {
  $fg = [Win32U]::GetForegroundWindow()
  if ($fg -eq [IntPtr]::Zero) { return $false }
  $fgPid = [uint32]0
  [void][Win32U]::GetWindowThreadProcessId($fg, [ref]$fgPid)
  return ($fgPid -eq $wantPid)
}

# ── clipboard 路线的鼠标点击与全页复制 ──────────────────────────────────
function Click-At([double]$px, [double]$py) {
  $r = New-Object Win32U+RECT
  [void][Win32U]::GetClientRect($hwnd, [ref]$r)
  $pt = New-Object Win32U+POINT
  $pt.x = [int]($r.Right * $px)
  $pt.y = [int]($r.Bottom * $py)
  [void][Win32U]::ClientToScreen($hwnd, [ref]$pt)
  [void][Win32U]::SetCursorPos($pt.x, $pt.y)
  Start-Sleep -Milliseconds 100
  [Win32U]::mouse_event(0x02, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 60
  [Win32U]::mouse_event(0x04, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 300
}
function Read-Clip {
  try { $c = Get-Clipboard -Raw; if ($null -eq $c) { return '' }; return $c } catch { return '' }
}
function Clip-Snap {
  [System.Windows.Forms.SendKeys]::SendWait('^a')
  Start-Sleep -Milliseconds 200
  [System.Windows.Forms.SendKeys]::SendWait('^c')
  Start-Sleep -Milliseconds 450
  return (Read-Clip)
}
function Click-ReadPt {
  Click-At $readPt[0] $readPt[1]
}
# 解析「50%,48%」→ 0.5/0.48
function Shot-Dbg([string]$name) {
  if (-not $DebugShots) { return }
  try {
    Add-Type -AssemblyName System.Drawing | Out-Null
    $r = New-Object Win32U+RECT
    [void][Win32U]::GetWindowRect($hwnd, [ref]$r)
    $bmp = New-Object System.Drawing.Bitmap ($r.Right - $r.Left), ($r.Bottom - $r.Top)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size)
    $g.Dispose()
    $out = Join-Path $env:TEMP $name
    $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Log ("截图 {0}" -f $out)
  } catch { Log ("截图失败：{0}" -f $_.Exception.Message) }
}

function Convert-Pct([string]$s) {
  $parts = $s -replace '%', '' -split ','
  if ($parts.Count -ne 2) { throw "点击点位格式应为 '50%,48%'：$s" }
  $x = [double]$parts[0] / 100.0
  $y = [double]$parts[1] / 100.0
  return @($x, $y)
}

# 点击点位解析（clipboard 路线用）
Log '解析点击点位…'
try {
  $readPt = Convert-Pct $ClickReadPct
  $inputPts = @()
  foreach ($s in ($ClickInputPct -split ';')) {
    if ([string]::IsNullOrWhiteSpace($s)) { continue }
    $inputPts += ,(Convert-Pct $s.Trim())
  }
  if ($inputPts.Count -eq 0) { $inputPts = ,@(0.5, 0.9) }
} catch {
  Fail 'locate' ("点击点位格式不对：{0}（应为 '50%,48%'，多个用分号隔开）" -f $_.Exception.Message)
}

# ── 1. 定位窗口 ─────────────────────────────────────────────────────────
if (-not $Process -and -not $TitleRegex) { Fail 'locate' '没给定位条件：Process（进程名）和 TitleRegex（标题正则）至少要配一个。' }
$matches1 = @()
foreach ($p in (Get-Process | Where-Object { $_.MainWindowHandle -ne 0 })) {
  if ($Process -and $p.ProcessName -notmatch $Process) { continue }
  if ($TitleRegex -and ("$($p.MainWindowTitle)" -notmatch $TitleRegex)) { continue }
  $matches1 += $p
}
if ($matches1.Count -eq 0) { Fail 'locate' "找不到目标窗口（进程=$Process，标题正则=$TitleRegex）。客户端没开，或进程名不对（任务管理器「名称」列）。" }
$target = $matches1[0]
$hwnd = $target.MainWindowHandle
Log ("窗口：pid={0} name={1} [{2}]（候选 {3} 个）" -f $target.Id, $target.ProcessName, $target.MainWindowTitle, $matches1.Count)

# 最小化的窗口 Chromium 不渲染：任何 UIA 查询（FindFirst/FindAll）都会无限阻塞，
# PrintWindow 也只有黑帧。所以动 UIA 之前必须先还原；$wasMin 给 newchat 用完归位。
$wasMin = [Win32U]::IsIconic($hwnd)
if ($wasMin) { [void][Win32U]::ShowWindowAsync($hwnd, 9); Start-Sleep -Milliseconds 900; Log '窗口原本最小化，已还原' }
Log '开始 UIA 查询…'

# ── 2. UIA 元素与工具函数 ────────────────────────────────────────────────
$root = [System.Windows.Automation.AutomationElement]::RootElement
$winCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NativeWindowHandleProperty, [int]$hwnd)
$win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $winCond)
if (-not $win) { Fail 'uia' '窗口在但 UIA 拿不到它的树（客户端可能刚重启，重试一次）。' }

$editCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)
$edits = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $editCond)
if ($edits.Count -eq 0 -and $ReadMode -ne 'clipboard') { Fail 'uia' '窗口里没找到输入框（Edit 元素），且未配置 -ReadMode clipboard。' }
$input = $null
$useClip = $false
if ($edits.Count -gt 0) {
  foreach ($e in $edits) { try { if ($e.Current.Name -match $InputNameRegex) { $input = $e; break } } catch { } }
  if (-not $input) { $input = $edits[$edits.Count - 1] }
  Log ("输入框：name='{0}'（候选 {1} 个 Edit）" -f $input.Current.Name, $edits.Count)
} else {
  $useClip = $true
  Log '窗口没有 UIA 输入框（可访问性未激活）—— 走点击 + 全页复制路线'
}

function Get-InputValue($el) {
  try {
    $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    return $vp.Current.Value
  } catch { return $null }
}
function Get-Texts($w) {
  $tCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Text)
  $texts = $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, $tCond)
  $sb = New-Object System.Text.StringBuilder
  foreach ($t in $texts) { try { $n = $t.Current.Name; if ($n) { [void]$sb.AppendLine($n) } } catch { } }
  return $sb.ToString()
}
function Find-Buttons($w, $regex) {
  $btnCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
  $btns = $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, $btnCond)
  $out = @()
  foreach ($b in $btns) {
    try { if ($b.Current.Name -match $regex) { $out += $b } } catch { }
  }
  return $out
}
function Invoke-Button($el) {
  try {
    ($el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)).Invoke()
    return $true
  } catch { return $false }
}

# ── newchat 动作：只点「新建会话」按钮，不做收发（/reset 时由引擎调用）──
if ($Action -eq 'newchat') {
  $ncBtns = Find-Buttons $win $NewChatButtonRegex
  if ($ncBtns.Count -eq 0) { Fail 'newchat' "没找到匹配「$NewChatButtonRegex」的按钮 —— 当前界面可能没有新建入口，或客户端改版了。" }
  $nc = $ncBtns[$ncBtns.Count - 1]
  if (-not (Invoke-Button $nc)) { Fail 'newchat' "按钮「$($nc.Current.Name)」Invoke 失败。" }
  Start-Sleep -Milliseconds 800
  # 用完归位：之前是最小化就放回去（还原不等于抢焦点，全程都在别的窗口后面）
  if ($wasMin) { [void][Win32U]::ShowWindowAsync($hwnd, 6); Start-Sleep -Milliseconds 300 }
  Out-Json @{
    ok      = $true
    clicked = $nc.Current.Name
    client  = "$($target.ProcessName) [$($target.MainWindowTitle)]"
  }
  exit 0
}

$before = Get-Texts $win
Log ("发送前 Text 快照 {0} 字符" -f $before.Length)

$prompt = [System.IO.File]::ReadAllText($PromptFile, [System.Text.Encoding]::UTF8)
if ([string]::IsNullOrWhiteSpace($prompt)) { Fail 'prompt' '提示词是空的。' }

$promptHead = $prompt -replace "`r`n", " "
$promptHead = $promptHead -replace "`n", " "
if ($promptHead.Length -gt 14) { $promptHead = $promptHead.Substring(0, 14) }

function Test-Echo($w, $head) {
  $tCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Text)
  $texts = $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, $tCond)
  foreach ($t in $texts) {
    try { $n = $t.Current.Name; if ($n -and $n.Length -ge $head.Length -and $n.IndexOf($head) -ge 0) { return $true } } catch { }
  }
  return $false
}

# ── 3a. UIA 原生发送（不碰焦点）─────────────────────────────────────────
$sentVia = ''
if (-not $useClip -and $InputMode -in @('auto', 'uia')) {
  $vp = $null
  try { $vp = $input.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern) } catch { }
  if ($vp) {
    try { $vp.SetValue($prompt) } catch { }
    Start-Sleep -Milliseconds 300
    $got = $vp.Current.Value
    if ($got -eq $prompt) {
      $sendBtns = Find-Buttons $win $SendButtonRegex
      if ($sendBtns.Count -gt 0) {
        if (Invoke-Button $sendBtns[$sendBtns.Count - 1]) {
          Start-Sleep -Milliseconds 1500
          $val = Get-InputValue $input
          if ($null -eq $val -or $val -eq '' -or (Test-Echo $win $promptHead)) {
            $sentVia = 'uia'
            Log 'UIA 原生发送成功'
          } else {
            Log 'UIA 原生点了发送但没看到回显/清空 —— 落 keys 路线'
          }
        } else { Log '发送按钮 Invoke 失败 —— 落 keys 路线' }
      } else { Log '没找到发送按钮 —— 落 keys 路线' }
    } else {
      Log ("SetValue 后值对不上（{0} 字符）—— React 系客户端多半不认，落 keys 路线" -f ($(if ($got) { $got.Length } else { 0 })))
    }
  } else { Log '输入框不支持 ValuePattern —— 落 keys 路线' }
}

# ── 3b. keys 路线 ───────────────────────────────────────────────────────
if (-not $sentVia -and -not $useClip) {
  if ($IdleGuardMs -gt 0) {
    $idle = Get-IdleMs
    if ($idle -lt $IdleGuardMs) {
      Fail 'idle-guard' "这台电脑刚有人动过（${idle}ms 前还有输入，保护阈值 ${IdleGuardMs}ms）。怕打扰真人，这一轮没执行。"
    }
    Log "空闲 ${idle}ms，可以接管窗口"
  }
  if ([Win32U]::IsIconic($hwnd)) { [void][Win32U]::ShowWindowAsync($hwnd, 9); Start-Sleep -Milliseconds 400 }
  $ws = New-Object -ComObject WScript.Shell
  try { [void]$ws.AppActivate($target.Id) } catch { }
  Start-Sleep -Milliseconds 300
  if (-not (Confirm-Foreground $target.Id)) {
    [void][Win32U]::SetForegroundWindow($hwnd)
    Start-Sleep -Milliseconds 300
  }
  if (-not (Confirm-Foreground $target.Id)) {
    Fail 'focus' '抢不到窗口焦点。有的客户端会拒绝后台程序抢焦点：手动点一下那个客户端再试，或把它设为置顶。'
  }
  try { $input.SetFocus() } catch { }
  Start-Sleep -Milliseconds 250
  if (-not (Confirm-Foreground $target.Id)) {
    Fail 'focus' '给输入框设焦点时窗口被抢走前台，没有发送。'
  }

  $oldClip = $null
  try { $oldClip = Get-Clipboard -Raw } catch { }
  Set-Clipboard -Value $prompt
  Start-Sleep -Milliseconds 150
  $bs = ('{BACKSPACE}' * 24)
  [System.Windows.Forms.SendKeys]::SendWait($bs)
  Start-Sleep -Milliseconds 200
  $dl = ('{DEL}' * 6)
  [System.Windows.Forms.SendKeys]::SendWait($dl)
  Start-Sleep -Milliseconds 200
  [System.Windows.Forms.SendKeys]::SendWait('^v')
  Start-Sleep -Milliseconds 600

  $pasted = Get-InputValue $input
  $want = $prompt -replace "`r`n", "`n"
  $gotP = ''
  if ($null -ne $pasted) { $gotP = $pasted -replace "`r`n", "`n" }
  if ($null -eq $pasted -or -not $gotP.EndsWith($want)) {
    if (-not $KeepClipboard -and $null -ne $oldClip) { try { Set-Clipboard -Value $oldClip } catch { } }
    Fail 'paste' '粘贴没进输入框（读回的值不含提示词）。客户端可能不接受粘贴，或焦点不在输入框。'
  }
  Log ("粘贴校验通过：输入框 {0} 字符" -f $pasted.Length)

  if (-not (Confirm-Foreground $target.Id)) {
    if (-not $KeepClipboard -and $null -ne $oldClip) { try { Set-Clipboard -Value $oldClip } catch { } }
    Fail 'focus-after-paste' '粘贴后焦点被抢走，没有按发送键。'
  }
  [System.Windows.Forms.SendKeys]::SendWait($SendKeys)

  # ── 发送确认：6 秒内看到「清空 / 回显 / 补点按钮」任一即算送达 ──
  $confirmed = $false
  $swC = [System.Diagnostics.Stopwatch]::StartNew()
  $clickedOnce = $false
  while ($swC.ElapsedMilliseconds -lt 6000) {
    Start-Sleep -Milliseconds 500
    $val2 = Get-InputValue $input
    if ($null -eq $val2 -or $val2 -eq '') { $confirmed = $true; break }
    if (Test-Echo $win $promptHead) { $confirmed = $true; break }
    if (-not $clickedOnce -and $swC.ElapsedMilliseconds -ge 2500) {
      $clickedOnce = $true
      $sendBtns2 = Find-Buttons $win $SendButtonRegex
      if ($sendBtns2.Count -gt 0) {
        if (Invoke-Button $sendBtns2[$sendBtns2.Count - 1]) { Log '输入框没清空，补点了一次发送按钮' }
      }
    }
  }
  if (-not $confirmed) {
    if (-not $KeepClipboard -and $null -ne $oldClip) { try { Set-Clipboard -Value $oldClip } catch { } }
    Fail 'send' '发送后 6 秒内既没看到输入框清空，也没看到消息回显 —— 消息可能没发出去。试试把 sendKeys 配成 ^(ENTER)，或把 sendButtonRegex 配准。'
  }
  if (-not $KeepClipboard -and $null -ne $oldClip) { try { Set-Clipboard -Value $oldClip } catch { } }
  $sentVia = 'keys'
  Log 'keys 路线发送完成（已确认送达）'
}

# ── 3c. clipboard 路线：无 UIA 树的客户端（点击定位 + 全页复制读屏）──────
if (-not $sentVia -and $useClip) {
  if ($IdleGuardMs -gt 0) {
    $idle = Get-IdleMs
    if ($idle -lt $IdleGuardMs) {
      Fail 'idle-guard' "这台电脑刚有人动过（${idle}ms 前还有输入，保护阈值 ${IdleGuardMs}ms）。怕打扰真人，这一轮没执行。"
    }
    Log "空闲 ${idle}ms，可以接管窗口"
  }
  if ([Win32U]::IsIconic($hwnd)) { [void][Win32U]::ShowWindowAsync($hwnd, 9); Start-Sleep -Milliseconds 400 }
  $ws = New-Object -ComObject WScript.Shell
  try { [void]$ws.AppActivate($target.Id) } catch { }
  Start-Sleep -Milliseconds 300
  if (-not (Confirm-Foreground $target.Id)) {
    [void][Win32U]::SetForegroundWindow($hwnd)
    Start-Sleep -Milliseconds 300
  }
  if (-not (Confirm-Foreground $target.Id)) {
    Fail 'focus' '抢不到窗口焦点。'
  }

  # 发送前页面快照（点击读屏点 → 全选复制）
  Click-ReadPt
  $before = Clip-Snap
  Log ("发送前页面快照 {0} 字符" -f $before.Length)

  # 提示词上剪贴板。这步之前漏了 —— ^v 粘的是读屏残留的页面文本，等于什么都没发
  $oldClip = $null
  try { $oldClip = Get-Clipboard -Raw } catch { }
  Set-Clipboard -Value $prompt
  Start-Sleep -Milliseconds 150

  # 依次尝试输入框点位：粘贴后回读剪贴板，含提示词才算落进输入框
  $pasted = $false
  foreach ($pt in $inputPts) {
    Click-At $pt[0] $pt[1]
    Start-Sleep -Milliseconds 150
    Click-At $pt[0] $pt[1]  # 网页类客户端：后台窗口的第一击只激活窗口，第二击才落到元素上
    Start-Sleep -Milliseconds 250
    # 注意：不要在这里用 ^a —— WorkBuddy 这类客户端的空编辑器会把 ^a 冒泡成
    # 「全选页面」，焦点跟着丢，^v 就粘进空气里了。用连续删除清理残留。
    $bs = ('{BACKSPACE}' * 24)
    [System.Windows.Forms.SendKeys]::SendWait($bs)
    Start-Sleep -Milliseconds 200
    $dl = ('{DEL}' * 6)
    [System.Windows.Forms.SendKeys]::SendWait($dl)
    Start-Sleep -Milliseconds 200
    [System.Windows.Forms.SendKeys]::SendWait('^v')
    Start-Sleep -Milliseconds 700
    Shot-Dbg 'dhm-ui-after-paste.png'
    Start-Sleep -Milliseconds 100
    $got = Clip-Snap
    $gotN = ($got -replace "`r`n", "`n").Trim()
    $lastGot = $gotN
    $wantN = ($prompt -replace "`r`n", "`n").Trim()
    if ($gotN.Contains($wantN)) {
      $pasted = $true
      Log ("粘贴校验通过（点位 {0}/{1}）：输入框 {2} 字符" -f $pt[0], $pt[1], $gotN.Length)
      break
    }
  }
  if (-not $pasted) {
    $diag = $lastGot -replace "`n", "⏎"
    if ($diag.Length -gt 120) { $diag = $diag.Substring(0, 120) }
    Log ("⚠️ 粘贴校验未确认（回读：「$diag」）—— 富编辑器上回读可能不可靠，继续走发送 + 回显确认。")
  }

  if (-not (Confirm-Foreground $target.Id)) {
    Fail 'focus-after-paste' '粘贴后焦点被抢走，没有按发送键。'
  }
  [System.Windows.Forms.SendKeys]::SendWait($SendKeys)

  # 确认送达：读屏点轮询，页面文本出现提示词头 = 消息进会话了
  $confirmed = $false
  $swC = [System.Diagnostics.Stopwatch]::StartNew()
  while ($swC.ElapsedMilliseconds -lt 8000) {
    Start-Sleep -Milliseconds 600
    Click-ReadPt
    $t = Clip-Snap
    if ($t -and $t.IndexOf($promptHead) -ge 0) { $confirmed = $true; break }
  }
  if (-not $confirmed) {
    Fail 'send' "发送后 8 秒内页面文本没出现提示词 —— 可能没发出去（发送键不对？或提示词太短撞上回显判断）。"
  }
  $sentVia = 'clipboard'
  if (-not $KeepClipboard) { try { if ($null -ne $oldClip) { Set-Clipboard -Value $oldClip } } catch { } }
  Shot-Dbg 'dhm-ui-after-send.png'
  Log 'clipboard 路线发送完成（已确认送达）'
}
# ── 4. 等完成：MinWait 后 + 文本快照连续 StableRounds 轮不变 + 停止按钮消失 ──
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$stable = 0
$last = $null
while ($sw.ElapsedMilliseconds -lt $MaxWaitMs) {
  Start-Sleep -Milliseconds $PollMs
  if ($useClip) { Click-ReadPt; $txt = Clip-Snap } else { $txt = Get-Texts $win }
  $busy = $false
  if ($StopRegex) {
    foreach ($b in (Find-Buttons $win $StopRegex)) { $busy = $true; break }
  }
  if ($txt -ne $last) { $stable = 0; $last = $txt } else { $stable++ }
  if ($sw.ElapsedMilliseconds -ge $MinWaitMs -and (-not $busy) -and $stable -ge $StableRounds) { break }
}
if ($useClip) { Click-ReadPt; $after = Clip-Snap } else { $after = Get-Texts $win }
Log ("等待结束：{0}ms，快照 {1} 字符" -f $sw.ElapsedMilliseconds, $after.Length)

# ── 5. 提取答案 ─────────────────────────────────────────────────────────
$answer = ''
$via = ''

if ($CopyButtonRegex) {
  # 最干净的一条路：点最后一条回复旁的「复制回复」→ 读剪贴板
  $copyBtns = Find-Buttons $win $CopyButtonRegex
  if ($copyBtns.Count -gt 0) {
    $oldClip2 = $null
    try { $oldClip2 = Get-Clipboard -Raw } catch { }
    [System.Windows.Forms.Clipboard]::Clear()
    if (Invoke-Button $copyBtns[$copyBtns.Count - 1]) {
      Start-Sleep -Milliseconds 500
      $clip = $null
      try { $clip = Get-Clipboard -Raw } catch { }
      if ($clip) {
        $answer = $clip.Trim()
        $via = 'copy-button'
        Log ("复制按钮路线：答案 {0} 字符" -f $answer.Length)
      }
    }
    if (-not $KeepClipboard) { try { if ($null -ne $oldClip2) { Set-Clipboard -Value $oldClip2 } else { [System.Windows.Forms.Clipboard]::Clear() } } catch { } }
  } else {
    Log ("没找到匹配 {0} 的复制按钮，走文本差分" -f $CopyButtonRegex)
  }
}

if (-not $answer) {
  # 兜底：prompt 尾锚起步，before 尾锚收尾
  $tail = $prompt
  if ($tail.Length -gt 40) { $tail = $tail.Substring($tail.Length - 40) }
  $norm = $after -replace "`r`n", "`n"
  $tailN = $tail -replace "`r`n", "`n"
  $idx1 = $norm.LastIndexOf($tailN)
  if ($idx1 -ge 0) {
    $start = $idx1 + $tailN.Length
    $end = $norm.Length
    if (-not [string]::IsNullOrEmpty($before) -and $before.Length -gt 60) {
      $endAnchor = ($before.Substring($before.Length - 60)) -replace "`r`n", "`n"
      $idx2 = $norm.IndexOf($endAnchor, $start)
      if ($idx2 -gt $start) { $end = $idx2 }
    }
    $answer = $norm.Substring($start, $end - $start).Trim()
    $via = 'text-diff'
  } else {
    $answer = $after.Trim()
    $via = 'text-full'
  }
  Log ("文本差分路线：答案 {0} 字符" -f $answer.Length)
}

Out-Json @{
  ok       = $true
  answer   = $answer
  via      = $via
  sentVia  = $sentVia
  waitedMs = $sw.ElapsedMilliseconds
  beforeLen = $before.Length
  afterLen = $after.Length
  client   = "$($target.ProcessName) [$($target.MainWindowTitle)]"
}
} catch {
  # 兜底：任何没预料到的异常（非法正则、UIA 崩了……）也要给人话 JSON，别让引擎收到空结果
  Out-Json @{ ok = $false; error = "驱动异常：$($_.Exception.Message)"; stage = 'exception' }
  exit 1
}
