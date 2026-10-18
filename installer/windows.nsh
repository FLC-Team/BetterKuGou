; BetterKuGou's assisted installer. electron-builder still owns extraction,
; registration, shortcuts, elevation and the uninstaller.
!include nsDialogs.nsh
!include LogicLib.nsh
!include WinMessages.nsh
!include FileFunc.nsh
!include WordFunc.nsh
!include UAC.nsh

!macro customCheckAppRunning
  !ifdef BUILD_UNINSTALLER
    Call un.BKCheckRunning
  !else
    Call BKCheckRunning
  !endif
!macroend

!ifdef BUILD_UNINSTALLER
; An uninstaller must never fall back to electron-builder's taskkill branch.
!macro customHeader
  !include "${PROJECT_DIR}\installer\install-mode.nsh"
Function un.BKCheckRunning
  bkUnRetry:
  nsProcess::_FindProcess "${PRODUCT_FILENAME}.exe"
  Pop $0
  ${If} $0 == 0
    IfSilent bkUnCancel
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "请先退出所有 BetterKuGou 窗口，再重试卸载。设置与播放记录将保留。" IDRETRY bkUnRetry
    bkUnCancel:
    SetErrorLevel 2
    Quit
  ${EndIf}
FunctionEnd
!macroend

!macro customUnWelcomePage
  !include "${PROJECT_DIR}\installer\install-mode.nsh"
  !insertmacro MUI_UNPAGE_WELCOME
!macroend
!else

!define MUI_CUSTOMFUNCTION_GUIINIT BKGuiInit
!define MUI_CUSTOMFUNCTION_ABORT BKUserAbort

Var BKPage
Var BKMotionEnabled
Var BKPageMotionPage
Var BKPageMotionStart
Var BKPageMotionX
Var BKScopePosition
Var BKScopeTarget
Var BKScopeLevel
Var BKScopeReady
Var BKTitle
Var BKSubtitle
Var BKSubtitleControl
Var BKLicense
Var BKAllUsers
Var BKCurrentUser
Var BKClose
Var BKNext
Var BKBack
Var BKCancel
Var BKFont
Var BKTitleFont
Var BKBrandFont
Var BKSmallFont
Var BKStrongFont
Var BKStepText
Var BKSurface
Var BKSelected
Var BKBorder
Var BKScopeCurrentPanel
Var BKScopeAllPanel
Var BKScopeCurrentBorder
Var BKScopeAllBorder
Var BKScopeCurrentDescription
Var BKScopeAllDescription
Var BKButtonHandle
Var BKButtonRole
Var BKButtonBackground
Var BKButtonForeground
Var BKButtonOuter
Var BKButtonBrush
Var BKButtonPen
Var BKButtonOldBrush
Var BKButtonOldPen
Var BKCancelBitmap
Var BKBackBitmap
Var BKCloseBitmap
Var BKBrowseBitmap
Var BKBg
Var BKBrandBg
Var BKText
Var BKMuted
Var BKAccent
Var BKDark
Var BKHighContrast
Var BKScale
Var BKWidth
Var BKHeight
Var BKBusy
Var BKConfirmed
Var BKExisting
Var BKExistingPath
Var BKOldVersion
Var BKAction
Var BKActionTitle
Var BKConflict
Var BKRequired
Var BKNotes
Var BKLicenseText
Var BKImage
Var BKProgressImage
Var BKProgressControls
Var BKProgressTitle
Var BKProgressSubtitle
Var BKProgressStep
Var BKProgressBrandStep
Var BKInstallAnimation
Var BKAnimationParent
Var BKAnimationKind
Var BKAnimationTheme
Var BKAnimationDpi
Var BKSuccessMotionPage
Var BKDrag
Var BKPathInput
Var BKDone
Var BKProcessMemory
Var BKSnapshot
Var BKProcessPid
Var BKProcessPath
Var BKProcessHandle
Var BKTargetCount
Var BKOtherCount
Var BKQuitFailed
Var BKQuitStart
Var BKRequestedPids
Var BKSupportedCount
Var BKPipe
Var BKBuffer
Var BKReply
Var BKReadStart
Var BKReadLimit
Var BKProbeStart
Var BKFile
Var BKButtonBitmap
Var BKDrawDC
Var BKDrawBitmap
Var BKDrawOldBitmap
Var BKDrawFont
Var BKDrawRect
Var BKDrawText
Var BKDrawWidth
Var BKDrawHeight
Var BKCompareLeft
Var BKCompareRight
Var BKCompareResult
Var BKLeftCore
Var BKRightCore
Var BKLeftPre
Var BKRightPre
Var BKCompareIndex
Var BKLeftPart
Var BKRightPart
Var BKNumeric
Var BKTokenSource
Var BKTokenNumber
Var BKToken
Var BKTokenLast
Var BKParseInput
Var BKParseCore
Var BKParsePre
Var BKParseBuild
Var BKParseState
Var BKParseIndex
Var BKParseValid
Var BKParseHadPre

!macro customInit
  StrCpy $BKBusy 0
  StrCpy $BKConfirmed 0
  StrCpy $BKDone 0
  StrCpy $BKConflict 0
  StrCpy $BKExisting 0
  ; Read the actual records again: command-line scope flags must not mask a
  ; simultaneous HKCU/HKLM installation.
  ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ReadRegStr $1 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $0 != ""
  ${AndIf} $1 != ""
    StrCpy $BKConflict 1
  ${EndIf}
  ${If} $BKConflict == 1
    MessageBox MB_OK|MB_ICONSTOP "检测到当前用户版和所有用户版同时存在。为避免覆盖错误的安装，请先从 Windows 设置中卸载不需要的一份，再重新运行安装包。用户设置与播放记录无需删除。" /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
  ${If} $0 != ""
    StrCpy $BKExisting 1
    StrCpy $BKExistingPath $0
    !insertmacro setInstallModePerUser
  ${ElseIf} $1 != ""
    StrCpy $BKExisting 1
    StrCpy $BKExistingPath $1
    !insertmacro setInstallModePerAllUsers
  ${EndIf}
  ${If} $BKExisting == 1
    StrCpy $INSTDIR $BKExistingPath
  ${EndIf}
  StrCpy $BKAction "安装"
  ${If} $BKExisting == 1
    ReadRegStr $BKOldVersion SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" BetterKuGouVersion
    ${If} $BKOldVersion == ""
      ReadRegStr $BKOldVersion SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" DisplayVersion
    ${EndIf}
    StrCpy $BKCompareLeft "${VERSION}"
    StrCpy $BKCompareRight $BKOldVersion
    Call BKCompareVersions
    StrCpy $BKAction "更新"
    ${If} $BKCompareResult == 0
      StrCpy $BKAction "重新安装"
    ${ElseIf} $BKCompareResult == -1
      StrCpy $BKAction "降级"
    ${EndIf}
  ${EndIf}
  InitPluginsDir
  File /oname=$PLUGINSDIR\bk-license.txt "${PROJECT_DIR}\LICENSE"
  File /oname=$PLUGINSDIR\bk-notes.txt "${PROJECT_DIR}\updata_log.md"
  File /oname=$PLUGINSDIR\bk-logo-light.bmp "${PROJECT_DIR}\installer\assets\logo-light.bmp"
  File /oname=$PLUGINSDIR\bk-logo-dark.bmp "${PROJECT_DIR}\installer\assets\logo-dark.bmp"
  ; Silent RLE8 clips are decoded by Windows, without codecs or NSIS callbacks.
  !insertmacro BKMotionAssets 96
  !insertmacro BKMotionAssets 120
  !insertmacro BKMotionAssets 144
  !insertmacro BKMotionAssets 192
  StrCpy $BKFile "$PLUGINSDIR\bk-license.txt"
  Call BKReadUtf8
  StrCpy $BKLicenseText $0
  StrCpy $BKFile "$PLUGINSDIR\bk-notes.txt"
  Call BKReadUtf8
  StrCpy $BKNotes $0
  ; Silent installs cannot supply license/downgrade consent or request that an
  ; application save and quit. Refuse them instead of bypassing these pages.
  ${If} ${Silent}
    SetErrorLevel 2
    Quit
  ${EndIf}
!macroend

!macro customWelcomePage
  !include "${PROJECT_DIR}\installer\install-mode.nsh"
  Page custom BKScopePage BKScopeLeave
!macroend

!macro customInstallMode
  ; The custom scope page already chose the mode. Keep builder's own elevation
  ; and mode bookkeeping, while skipping its duplicate stock radio page.
  ${If} $installMode == "all"
    ${IfNot} ${UAC_IsAdmin}
      ShowWindow $HWNDPARENT ${SW_HIDE}
      !insertmacro UAC_RunElevated
      ${If} $0 == 0
      ${AndIf} $1 == 1
        Quit
      ${EndIf}
      ShowWindow $HWNDPARENT ${SW_SHOW}
      BringToFront
      ${If} $0 != 1223
        MessageBox MB_OK|MB_ICONEXCLAMATION "无法获得管理员权限（错误 $0）。请重试，或选择仅为当前用户安装。"
      ${EndIf}
      ; This macro runs in a page PRE callback: Abort would skip the page and
      ; accidentally proceed unelevated. Existing machine installs must stop.
      SetErrorLevel 1223
      Quit
    ${EndIf}
    StrCpy $isForceMachineInstall 1
  ${Else}
    StrCpy $isForceCurrentInstall 1
  ${EndIf}
!macroend

!macro customPageAfterChangeDir
  Page custom BKPreparePage BKPrepareLeave
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW BKProgressShow
  !define MUI_PAGE_CUSTOMFUNCTION_LEAVE BKProgressLeave
!macroend

!macro customFinishPage
  Page custom BKFinishPage BKFinishLeave
!macroend

!macro customInstall
  WriteRegStr SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" BetterKuGouVersion "${VERSION}"
  StrCpy $BKDone 1
!macroend

; This section runs even inside the elevated child, where builder skips its
; stock CHECK_APP_RUNNING. Recheck immediately before any old uninstaller runs.
!macro customHeader
  !include "${PROJECT_DIR}\installer\install-mode.nsh"
  !include "${PROJECT_DIR}\installer\windows-functions.nsh"
  Section "-BetterKuGou preflight"
    StrCpy $BKBusy 1
    Call BKCheckRunning
    ${If} $BKQuitFailed != 0
      SetErrorLevel 2
      Quit
    ${EndIf}
  SectionEnd
!macroend


!endif
