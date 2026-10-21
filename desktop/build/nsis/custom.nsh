; 安装向导第一页：风险与许可提示。
;
; 这个文件是模板。scripts/build-installer.mjs 会在开头补上
;   !macro DHM_FILL_AGREEMENT ...   （提示文本，逐行编进脚本）
;   !define DHM_NAPCAT_7Z "..."     （精简版没有这一行）
; 然后写成 build/custom.nsh，交给 electron-builder 的 nsis.include。
;
; 勾选“我已阅读并同意”后，“我已知晓并继续安装”按钮才可用；
; 标准“下一步”全程禁用，避免绕过勾选。
;
; 踩过的坑：早先版本把提示文本用 File 解到 $PLUGINSDIR，再 FileOpen 读。
; 在别的机器上（临时目录被拦 / 解压失败）会直接弹“提示文本读取失败”并中止安装。
; 现在文本在**编译期**就进了脚本，运行时不碰任何文件，也不存在读不到的情况。

!include "nsDialogs.nsh"
!include "LogicLib.nsh"
!include "WinMessages.nsh"

; 安装器初始化：先强杀残留的应用进程树。
; Electron 是多进程的（主进程/渲染/GPU 在任务管理器里同名），托盘退出后
; 仍可能有卡死的子进程占着名字——礼貌的 WM_CLOSE 对它无效，安装器会弹
; 「无法关闭」并卡住。taskkill /F /T 直接清掉整棵树（桥接/微信 Bot 等
; node 子进程一并清掉）。杀完等半秒让文件句柄释放。
; 卸载器同理（系统设置里的卸载也走这里）
!macro customUnInit
  nsExec::Exec 'taskkill /F /IM "DualHabitat Matrix.exe" /T'
  Pop $0
  Sleep 500
!macroend

!ifndef BUILD_UNINSTALLER
  Var DhmAgreeText
  Var DhmAgreeCheck
  Var DhmAgreeContinue
  Var DhmTitle
  Var DhmTitleFont
!endif

!macro customWelcomePage
  Page custom DhmAgreePageCreate DhmAgreePageLeave

  Function DhmAgreePageCreate
    ; MUI header 的文字由系统绘制，改不了字号和颜色，
    ; 所以 header 留空，标题在内容区自绘。
    !insertmacro MUI_HEADER_TEXT "" ""

    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      ; 界面都建不出来就别拦着装 —— 跳过这一页，装完再说
      Abort
    ${EndIf}

    ; 标题：加粗天蓝色大字
    CreateFont $DhmTitleFont "Microsoft YaHei" 16 700
    ${NSD_CreateLabel} 0 0 100% 16u "Delance_ 提示您"
    Pop $DhmTitle
    SendMessage $DhmTitle ${WM_SETFONT} $DhmTitleFont 1
    ; 天蓝色。**这里按 0xRRGGBB 传**，不是 NSIS 文档写的 0xBBGGRR ——
    ; 早先按 BGR 写成 0xE9A000，结果渲染成橙色（实测），所以别照文档改回来。
    SetCtlColors $DhmTitle 0x00A0E9 0xFFFFFF

    ${NSD_CreateLabel} 0 17u 100% 9u "安装前请阅读以下内容"
    Pop $1
    SetCtlColors $1 0x80726B 0xFFFFFF

    ; 多行只读文本框，带垂直滚动条
    nsDialogs::CreateControl "EDIT" \
      ${DEFAULT_STYLES}|${WS_TABSTOP}|${ES_MULTILINE}|${ES_READONLY}|${WS_VSCROLL}|${ES_AUTOVSCROLL} \
      ${WS_EX_CLIENTEDGE} 0 29u 100% 77u ""
    Pop $DhmAgreeText
    ${If} $DhmAgreeText == error
      Abort
    ${EndIf}
    SetCtlColors $DhmAgreeText 0x000000 0xFFFFFF

    ; 文本是编译期编进来的（见文件头的说明），这里只负责灌进控件
    !ifmacrodef DHM_FILL_AGREEMENT
      !insertmacro DHM_FILL_AGREEMENT $DhmAgreeText
    !endif
    SendMessage $DhmAgreeText ${EM_SETSEL} 0 0
    SendMessage $DhmAgreeText ${EM_SCROLLCARET} 0 0

    ; 必须勾选
    ${NSD_CreateCheckbox} 0 110u 100% 10u "我已阅读并同意"
    Pop $DhmAgreeCheck

    ${NSD_CreateButton} 0 124u 100% 14u "我已知晓并继续安装"
    Pop $DhmAgreeContinue
    EnableWindow $DhmAgreeContinue 0
    ${NSD_OnClick} $DhmAgreeCheck DhmAgreeCheckChanged
    ${NSD_OnClick} $DhmAgreeContinue DhmAgreeNext

    ; 标准“下一步”禁用
    GetDlgItem $0 $HWNDPARENT 1
    EnableWindow $0 0

    nsDialogs::Show
  FunctionEnd

  Function DhmAgreeCheckChanged
    ${NSD_GetState} $DhmAgreeCheck $0
    ${If} $0 == ${BST_CHECKED}
      EnableWindow $DhmAgreeContinue 1
    ${Else}
      EnableWindow $DhmAgreeContinue 0
    ${EndIf}
  FunctionEnd

  Function DhmAgreeNext
    ${NSD_GetState} $DhmAgreeCheck $0
    ${If} $0 != ${BST_CHECKED}
      Return
    ${EndIf}
    GetDlgItem $0 $HWNDPARENT 1
    EnableWindow $0 1
    SendMessage $HWNDPARENT ${WM_COMMAND} 1 0
  FunctionEnd

  Function DhmAgreePageLeave
    ; 下一页继续用标准按钮
    GetDlgItem $0 $HWNDPARENT 1
    EnableWindow $0 1
  FunctionEnd
!macroend

!macro customInit
  ; 先强杀残留的应用进程树。Electron 是多进程的（主进程/渲染/GPU 同名），
  ; 托盘退出后仍可能有卡死的子进程占着名字——礼貌的 WM_CLOSE 对它无效，
  ; 安装器会弹「无法关闭」并卡住。taskkill /F /T 清整棵树（含桥接/微信
  ; Bot 等 node 子进程），杀完等半秒让文件句柄释放。
  nsExec::Exec 'taskkill /F /IM "DualHabitat Matrix.exe" /T'
  Pop $0
  Sleep 500
  ; nsDialogs 要 $PLUGINSDIR，先建好；提示文本不再落盘，所以没有 File 了
  InitPluginsDir
!macroend

!macro customInstall
  !ifdef DHM_NAPCAT_7Z
    ; 本机已有 NapCat 就不再装自带的那份
    IfFileExists "$PROFILE\napcat-shell\NapCatWinBootMain.exe" dhm_napcat_done
    IfFileExists "$APPDATA\dualhabitat-matrix-desktop\napcat\NapCatWinBootMain.exe" dhm_napcat_done
    IfFileExists "$APPDATA\DualHabitat Matrix\napcat\NapCatWinBootMain.exe" dhm_napcat_done
    IfFileExists "$INSTDIR\resources\app\napcat\NapCatWinBootMain.exe" dhm_napcat_done

    DetailPrint "正在安装 NapCat（约 1.2 GB，需要一点时间）…"
    SetCompress off
    File /oname=$PLUGINSDIR\napcat.7z "${DHM_NAPCAT_7Z}"
    SetCompress auto

    SetOutPath "$INSTDIR\resources\app\napcat"
    Nsis7z::Extract "$PLUGINSDIR\napcat.7z"
    SetOutPath "$INSTDIR"

    IfFileExists "$INSTDIR\resources\app\napcat\NapCatWinBootMain.exe" dhm_napcat_ok
      MessageBox MB_ICONEXCLAMATION "NapCat 解压失败。软件仍可安装，启动后可在界面里重新下载 NapCat。"
    dhm_napcat_ok:
    DetailPrint "NapCat 安装完成"

    dhm_napcat_done:
  !endif
!macroend

!macro customUnInstall
  ; 自带的 NapCat 是安装时解出来的，卸载器不知道这些文件，需要自己删
  RMDir /r "$INSTDIR\resources\app\napcat"
!macroend
