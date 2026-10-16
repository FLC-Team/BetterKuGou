; Read UTF-8 documents through Win32 rather than relying on the active Windows
; ANSI code page. Limit them to NSIS's string capacity and preserve line breaks.
Function BKReadUtf8
  StrCpy $0 ""
  System::Call 'kernel32::CreateFileW(w "$BKFile", i 0x80000000, i 1, p 0, i 3, i 0, p 0)p.r1'
  ${If} $1 == -1
    Return
  ${EndIf}
  System::Alloc 65536
  Pop $2
  System::Call 'kernel32::ReadFile(p r1, p r2, i 65532, *i .r3, p 0)i.r4'
  System::Call 'kernel32::CloseHandle(p r1)'
  ${If} $4 != 0
    ; The destination length is in wide characters, so allocate twice as much.
    IntOp $6 ${NSIS_MAX_STRLEN} * 2
    System::Alloc $6
    Pop $5
    IntOp $6 ${NSIS_MAX_STRLEN} - 1
    System::Call 'kernel32::MultiByteToWideChar(i 65001, i 0, p r2, i r3, p r5, i r6)i.r4'
    ${If} $4 == 0
      ; A long release history is intentionally truncated for the embedded page.
      IntOp $3 ${NSIS_MAX_STRLEN} - 8
      System::Call 'kernel32::MultiByteToWideChar(i 65001, i 0, p r2, i r3, p r5, i r6)i.r4'
    ${EndIf}
    ${If} $4 != 0
      IntOp $6 $4 * 2
      IntOp $6 $5 + $6
      System::Call '*$6(&i2 0)'
      System::Call '*$5(&w${NSIS_MAX_STRLEN} .r0)'
      StrCpy $1 $0 1
      ${If} $1 == "﻿"
        StrCpy $0 $0 "" 1
      ${EndIf}
    ${EndIf}
    System::Free $5
  ${EndIf}
  System::Free $2
FunctionEnd

; Coordinates are expressed in 96-DPI pixels; nsDialogs dialog units follow the
; active font while the outer frame and original MUI controls use physical pixels.
!macro BKMove HANDLE X Y W H
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push ${HANDLE}
  Pop $4
  IntOp $0 ${X} * $BKScale
  IntOp $0 $0 / 96
  IntOp $1 ${Y} * $BKScale
  IntOp $1 $1 / 96
  IntOp $2 ${W} * $BKScale
  IntOp $2 $2 / 96
  IntOp $3 ${H} * $BKScale
  IntOp $3 $3 / 96
  System::Call 'user32::MoveWindow(p r4, i r0, i r1, i r2, i r3, i 1)'
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend

!macro BKRootLabel X Y W H TEXT FONT FG BG
  System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w "${TEXT}", i 0x50000000, i 0, i 0, i 0, i 0, p $HWNDPARENT, p 0, p 0, p 0)p.r0'
  StrCpy $BKProgressControls "$BKProgressControls$0."
  !insertmacro BKMove $0 ${X} ${Y} ${W} ${H}
  SendMessage $0 ${WM_SETFONT} ${FONT} 1
  SetCtlColors $0 ${FG} ${BG}
!macroend

Function BKGuiInit
  System::Call 'user32::GetDC(p $HWNDPARENT)p.r0'
  System::Call 'gdi32::GetDeviceCaps(p r0, i 88)i.s'
  Pop $BKScale
  System::Call 'user32::ReleaseDC(p $HWNDPARENT, p r0)'
  ${If} $BKScale < 96
    StrCpy $BKScale 96
  ${EndIf}
  CreateFont $BKFont "Segoe UI" 10
  CreateFont $BKTitleFont "Segoe UI" 24 700
  CreateFont $BKBrandFont "Segoe UI" 20 700
  CreateFont $BKSmallFont "Segoe UI" 9
  StrCpy $BKBg FFFFFF
  StrCpy $BKBrandBg F4F7FC
  StrCpy $BKText 111C30
  StrCpy $BKMuted 64748B
  StrCpy $BKAccent 2563EB
  StrCpy $BKDark 0
  ReadRegDWORD $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Themes\Personalize" AppsUseLightTheme
  ${If} $0 == 0
    StrCpy $BKDark 1
    StrCpy $BKBg 151A23
    StrCpy $BKBrandBg 142238
    StrCpy $BKText F3F5FA
    StrCpy $BKMuted AAB7CC
  ${EndIf}
  ; HIGHCONTRAST.cbSize + dwFlags + pointer (the installer engine is x86).
  System::Alloc 12
  Pop $0
  System::Call '*$0(i 12, i 0, p 0)'
  System::Call 'user32::SystemParametersInfoW(i 66, i 12, p r0, i 0)'
  System::Call '*$0(i, i .r1)'
  IntOp $BKHighContrast $1 & 1
  System::Free $0
  ${If} $BKHighContrast != 0
    ; Let Windows choose accessible system colors and keep the stock button
    ; theme. Native edits, radio buttons, links and focus outlines remain intact.
    System::Call 'user32::GetSysColor(i 5)i.r0'
    Call BKColorRefToRgb
    IntFmt $BKBg "%06X" $0
    StrCpy $BKBrandBg $BKBg
    System::Call 'user32::GetSysColor(i 8)i.r0'
    Call BKColorRefToRgb
    IntFmt $BKText "%06X" $0
    StrCpy $BKMuted $BKText
  ${EndIf}
  SetCtlColors $HWNDPARENT $BKText $BKBg
  System::Call 'user32::GetWindowLongW(p $HWNDPARENT, i -16)i.r0'
  IntOp $0 $0 & 0xFF3BFFFF
  System::Call 'user32::SetWindowLongW(p $HWNDPARENT, i -16, i r0)'
  System::Call 'user32::GetWindowLongW(p $HWNDPARENT, i -20)i.r0'
  IntOp $0 $0 & 0xFFFFFCFE
  System::Call 'user32::SetWindowLongW(p $HWNDPARENT, i -20, i r0)'
  IntOp $BKWidth 760 * $BKScale
  IntOp $BKWidth $BKWidth / 96
  IntOp $BKHeight 500 * $BKScale
  IntOp $BKHeight $BKHeight / 96
  System::Call 'user32::SetWindowPos(p $HWNDPARENT, p 0, i 0, i 0, i $BKWidth, i $BKHeight, i 0x36)'
  ; Hide the MUI header, separators and branding; the original buttons remain
  ; real accessible Win32 controls with their standard keyboard behavior.
  GetDlgItem $0 $HWNDPARENT 1034
  ShowWindow $0 0
  GetDlgItem $0 $HWNDPARENT 1037
  ShowWindow $0 0
  GetDlgItem $0 $HWNDPARENT 1038
  ShowWindow $0 0
  GetDlgItem $0 $HWNDPARENT 1039
  ShowWindow $0 0
  GetDlgItem $0 $HWNDPARENT 1028
  ShowWindow $0 0
  GetDlgItem $0 $HWNDPARENT 1256
  ShowWindow $0 0
  GetDlgItem $BKNext $HWNDPARENT 1
  GetDlgItem $BKBack $HWNDPARENT 3
  GetDlgItem $BKCancel $HWNDPARENT 2
  !insertmacro BKMove $BKNext 542 434 174 44
  !insertmacro BKMove $BKBack 292 440 82 32
  !insertmacro BKMove $BKCancel 408 440 106 32
  SendMessage $BKNext ${WM_SETFONT} $BKFont 1
  SendMessage $BKBack ${WM_SETFONT} $BKFont 1
  SendMessage $BKCancel ${WM_SETFONT} $BKFont 1
  System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w "", i 0x50000000, i 0, i 0, i 0, i 0, p $HWNDPARENT, p 0, p 0, p 0)p.r0'
  !insertmacro BKMove $0 0 424 250 76
  SetCtlColors $0 $BKText $BKBrandBg
FunctionEnd

Function BKColorRefToRgb
  IntOp $1 $0 & 0xFF
  IntOp $1 $1 << 16
  IntOp $2 $0 & 0xFF00
  IntOp $3 $0 >> 16
  IntOp $3 $3 & 0xFF
  IntOp $0 $1 | $2
  IntOp $0 $0 | $3
FunctionEnd

; A native bitmap button keeps keyboard navigation, its accessible text and the
; Windows focus outline while giving the primary action a real blue surface.
; No owner-draw callback or long-lived System subclass is installed.
Function BKPrimary
  ${If} $BKHighContrast != 0
    Return
  ${EndIf}
  System::Call 'user32::GetWindowTextW(p $BKNext, w .r0, i ${NSIS_MAX_STRLEN})'
  StrCpy $BKDrawText $0
  IntOp $BKDrawWidth 174 * $BKScale
  IntOp $BKDrawWidth $BKDrawWidth / 96
  IntOp $BKDrawWidth $BKDrawWidth - 6
  IntOp $BKDrawHeight 44 * $BKScale
  IntOp $BKDrawHeight $BKDrawHeight / 96
  IntOp $BKDrawHeight $BKDrawHeight - 6
  System::Call 'user32::GetDC(p $HWNDPARENT)p.r0'
  System::Call 'gdi32::CreateCompatibleDC(p r0)p.s'
  Pop $BKDrawDC
  System::Call 'gdi32::CreateCompatibleBitmap(p r0, i $BKDrawWidth, i $BKDrawHeight)p.s'
  Pop $BKDrawBitmap
  System::Call 'user32::ReleaseDC(p $HWNDPARENT, p r0)'
  System::Call 'gdi32::SelectObject(p $BKDrawDC, p $BKDrawBitmap)p.s'
  Pop $BKDrawOldBitmap
  System::Alloc 16
  Pop $BKDrawRect
  System::Call '*$BKDrawRect(i 0, i 0, i $BKDrawWidth, i $BKDrawHeight)'
  IntOp $0 "0x$BKAccent" | 0
  Call BKColorRefToRgb
  System::Call 'gdi32::CreateSolidBrush(i r0)p.r0'
  System::Call 'user32::FillRect(p $BKDrawDC, p $BKDrawRect, p r0)'
  System::Call 'gdi32::DeleteObject(p r0)'
  System::Call 'gdi32::SetBkMode(p $BKDrawDC, i 1)'
  System::Call 'gdi32::SetTextColor(p $BKDrawDC, i 0xFFFFFF)'
  System::Call 'gdi32::SelectObject(p $BKDrawDC, p $BKFont)p.s'
  Pop $BKDrawFont
  System::Call 'user32::DrawTextW(p $BKDrawDC, w "$BKDrawText", i -1, p $BKDrawRect, i 0x25)'
  System::Call 'gdi32::SelectObject(p $BKDrawDC, p $BKDrawFont)'
  System::Call 'gdi32::SelectObject(p $BKDrawDC, p $BKDrawOldBitmap)'
  System::Call 'gdi32::DeleteDC(p $BKDrawDC)'
  System::Free $BKDrawRect
  System::Call 'user32::GetWindowLongW(p $BKNext, i -16)i.r0'
  IntOp $0 $0 | ${BS_BITMAP}
  System::Call 'user32::SetWindowLongW(p $BKNext, i -16, i r0)'
  SendMessage $BKNext ${BM_SETIMAGE} 0 $BKDrawBitmap $0
  ${If} $0 != 0
    System::Call 'gdi32::DeleteObject(p r0)'
  ${EndIf}
  StrCpy $BKButtonBitmap $BKDrawBitmap
FunctionEnd

Function BKUserAbort
  ${If} $BKBusy == 1
    Abort
  ${EndIf}
FunctionEnd

Function BKCloseClick
  Pop $0
  ${If} $BKBusy != 1
    SendMessage $HWNDPARENT ${WM_COMMAND} 2 0
  ${EndIf}
FunctionEnd

Function BKDragClick
  Pop $0
  ${If} $BKBusy != 1
    System::Call 'user32::ReleaseCapture()'
    ; Native move loop avoids storing a callback/subclass pointer in System.dll.
    SendMessage $HWNDPARENT ${WM_SYSCOMMAND} 0xF012 0
  ${EndIf}
FunctionEnd

Function BKCommonPage
  nsDialogs::Create 1018
  Pop $BKPage
  ${If} $BKPage == error
    Abort
  ${EndIf}
  !insertmacro BKMove $BKPage 0 0 760 424
  SetCtlColors $BKPage $BKText $BKBg
  ${NSD_CreateLabel} 0 0 250 500 ""
  Pop $0
  !insertmacro BKMove $0 0 0 250 500
  SetCtlColors $0 $BKText $BKBrandBg
  ${NSD_CreateBitmap} 56 66 128 128 ""
  Pop $0
  !insertmacro BKMove $0 56 66 128 128
  Push $0
  ${If} $BKImage != ""
    System::Call 'gdi32::DeleteObject(p $BKImage)'
  ${EndIf}
  Call BKLoadLogo
  Pop $0
  SendMessage $0 ${STM_SETIMAGE} 0 $BKImage
  ${NSD_CreateLabel} 32 226 208 52 "BetterKuGou"
  Pop $0
  !insertmacro BKMove $0 32 226 208 52
  SendMessage $0 ${WM_SETFONT} $BKFont 1
  SetCtlColors $0 $BKText $BKBrandBg
  ${NSD_CreateLabel} 32 276 190 90 "让音乐，$\r$\n回到生活里。"
  Pop $0
  !insertmacro BKMove $0 32 276 190 90
  SendMessage $0 ${WM_SETFONT} $BKBrandFont 1
  SetCtlColors $0 $BKText $BKBrandBg
  ${NSD_CreateLabel} 32 380 192 20 "${VERSION} · Windows"
  Pop $0
  !insertmacro BKMove $0 32 380 192 20
  SendMessage $0 ${WM_SETFONT} $BKSmallFont 1
  SetCtlColors $0 $BKMuted $BKBrandBg
  ${NSD_CreateButton} 714 10 32 28 "×"
  Pop $BKClose
  !insertmacro BKMove $BKClose 714 10 32 28
  ${NSD_OnClick} $BKClose BKCloseClick
  ${NSD_CreateLink} 32 18 190 22 "BetterKuGou  ·  移动窗口"
  Pop $BKDrag
  !insertmacro BKMove $BKDrag 32 18 190 22
  SetCtlColors $BKDrag $BKMuted $BKBrandBg
  ${NSD_OnClick} $BKDrag BKDragClick
  ShowWindow $BKBack 0
  EnableWindow $BKCancel 1
  EnableWindow $BKNext 1
FunctionEnd

Function BKLoadLogo
  IntOp $0 128 * $BKScale
  IntOp $0 $0 / 96
  ${If} $BKDark == 1
    System::Call 'user32::LoadImageW(p 0, w "$PLUGINSDIR\bk-logo-dark.bmp", i 0, i r0, i r0, i 0x10)p.s'
  ${Else}
    System::Call 'user32::LoadImageW(p 0, w "$PLUGINSDIR\bk-logo-light.bmp", i 0, i r0, i r0, i 0x10)p.s'
  ${EndIf}
  Pop $BKImage
FunctionEnd

Function BKHeading
  ; $BKActionTitle and $BKSubtitle are set by the page before this call.
  ${NSD_CreateLabel} 292 66 420 46 "$BKActionTitle"
  Pop $BKTitle
  !insertmacro BKMove $BKTitle 292 66 420 46
  SendMessage $BKTitle ${WM_SETFONT} $BKTitleFont 1
  SetCtlColors $BKTitle $BKText $BKBg
  ${NSD_CreateLabel} 294 122 416 44 "$BKSubtitle"
  Pop $BKSubtitleControl
  !insertmacro BKMove $BKSubtitleControl 294 122 416 44
  SendMessage $BKSubtitleControl ${WM_SETFONT} $BKFont 1
  SetCtlColors $BKSubtitleControl $BKMuted $BKBg
FunctionEnd

Function BKScopePage
  ${If} $BKExisting == 1
    Abort
  ${EndIf}
  ${If} ${UAC_IsInnerInstance}
    Abort
  ${EndIf}
  Call BKCommonPage
  StrCpy $BKActionTitle "为谁安装？"
  StrCpy $BKSubtitle "选择安装范围，下一步设置安装位置。"
  Call BKHeading
  ${NSD_CreateRadioButton} 294 202 408 32 "仅为当前用户安装（推荐）"
  Pop $BKCurrentUser
  !insertmacro BKMove $BKCurrentUser 294 202 408 32
  SendMessage $BKCurrentUser ${WM_SETFONT} $BKFont 1
  SetCtlColors $BKCurrentUser $BKText $BKBg
  ${NSD_CreateLabel} 314 240 382 38 "无需管理员权限，其他用户不会受到影响。"
  Pop $0
  !insertmacro BKMove $0 314 240 382 38
  SetCtlColors $0 $BKMuted $BKBg
  ${NSD_CreateRadioButton} 294 294 408 32 "为这台电脑的所有用户安装"
  Pop $BKAllUsers
  !insertmacro BKMove $BKAllUsers 294 294 408 32
  SendMessage $BKAllUsers ${WM_SETFONT} $BKFont 1
  SetCtlColors $BKAllUsers $BKText $BKBg
  ${NSD_CreateLabel} 314 332 382 42 "需要 Windows 管理员授权。"
  Pop $0
  !insertmacro BKMove $0 314 332 382 42
  SetCtlColors $0 $BKMuted $BKBg
  ${If} $installMode == "all"
    ${NSD_Check} $BKAllUsers
  ${Else}
    ${NSD_Check} $BKCurrentUser
  ${EndIf}
  SendMessage $BKNext ${WM_SETTEXT} 0 "STR:继续"
  SendMessage $BKCancel ${WM_SETTEXT} 0 "STR:取消"
  Call BKPrimary
  nsDialogs::Show
FunctionEnd

Function BKScopeLeave
  ${NSD_GetState} $BKAllUsers $0
  ${If} $0 == ${BST_CHECKED}
    !insertmacro setInstallModePerAllUsers
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
      ; This is a LEAVE callback, so Abort correctly keeps the scope page open.
      Abort
    ${EndIf}
  ${Else}
    !insertmacro setInstallModePerUser
  ${EndIf}
FunctionEnd

Function BKBrowse
  Pop $0
  nsDialogs::SelectFolderDialog "选择 BetterKuGou 安装文件夹" $INSTDIR
  Pop $0
  ${If} $0 != error
    StrCpy $INSTDIR $0
    ${NSD_SetText} $BKPathInput $INSTDIR
  ${EndIf}
FunctionEnd

Function BKShowLicense
  Pop $0
  ExecShell open "$PLUGINSDIR\bk-license.txt"
FunctionEnd

Function BKLicenseChanged
  Pop $0
  ${NSD_GetState} $BKLicense $0
  EnableWindow $BKNext $0
FunctionEnd

Function BKPreparePage
  StrCpy $BKBusy 0
  ${If} $BKExisting == 1
    StrCpy $INSTDIR $BKExistingPath
  ${EndIf}
  Call BKCommonPage
  StrCpy $BKActionTitle "$BKAction BetterKuGou"
  ${If} $BKExisting == 1
    StrCpy $BKSubtitle "$BKOldVersion  →  ${VERSION}"
  ${Else}
    StrCpy $BKSubtitle "你的音乐空间，即将就绪。"
  ${EndIf}
  Call BKHeading
  ${If} $BKExisting == 1
    nsDialogs::CreateControl EDIT ${DEFAULT_STYLES}|${ES_MULTILINE}|${ES_AUTOVSCROLL}|${ES_READONLY}|${WS_VSCROLL} ${WS_EX_CLIENTEDGE} 294 180 416 170 "$BKNotes"
    Pop $0
    !insertmacro BKMove $0 294 180 416 170
    SendMessage $0 ${EM_SETREADONLY} 1 0
    SendMessage $0 ${WM_SETFONT} $BKSmallFont 1
    SetCtlColors $0 $BKText $BKBg
    ${NSD_CreateLabel} 294 360 416 40 "保留设置、主题及播放记录。$\r$\n安装位置：$INSTDIR"
    Pop $0
    !insertmacro BKMove $0 294 360 416 40
    SetCtlColors $0 $BKMuted $BKBg
    ${If} $BKAction == "重新安装"
      SendMessage $BKNext ${WM_SETTEXT} 0 "STR:重新安装"
    ${ElseIf} $BKAction == "降级"
      SendMessage $BKNext ${WM_SETTEXT} 0 "STR:继续降级…"
    ${Else}
      SendMessage $BKNext ${WM_SETTEXT} 0 "STR:立即更新"
    ${EndIf}
    SendMessage $BKCancel ${WM_SETTEXT} 0 "STR:暂不更新"
  ${Else}
    ${NSD_CreateLabel} 294 180 416 24 "安装位置"
    Pop $0
    !insertmacro BKMove $0 294 180 416 24
    SetCtlColors $0 $BKText $BKBg
    ${NSD_CreateDirRequest} 294 212 322 32 "$INSTDIR"
    Pop $BKPathInput
    !insertmacro BKMove $BKPathInput 294 212 322 32
    SendMessage $BKPathInput ${WM_SETFONT} $BKFont 1
    SetCtlColors $BKPathInput $BKText $BKBrandBg
    ${NSD_CreateBrowseButton} 628 212 82 32 "浏览…"
    Pop $0
    !insertmacro BKMove $0 628 212 82 32
    ${NSD_OnClick} $0 BKBrowse
    ; The private preflight section precedes builder's install section.
    SectionGetSize 1 $BKRequired
    IntOp $BKRequired $BKRequired / 1024
    ${NSD_CreateLabel} 294 260 416 26 "版本 ${VERSION}  ·  所需空间约 $BKRequired MB"
    Pop $0
    !insertmacro BKMove $0 294 260 416 26
    SetCtlColors $0 $BKMuted $BKBg
    ${NSD_CreateCheckbox} 294 318 416 28 "我已阅读并同意许可证与使用声明"
    Pop $BKLicense
    !insertmacro BKMove $BKLicense 294 318 416 28
    SendMessage $BKLicense ${WM_SETFONT} $BKFont 1
    SetCtlColors $BKLicense $BKText $BKBg
    ${NSD_OnClick} $BKLicense BKLicenseChanged
    ${NSD_CreateLink} 314 354 320 24 "查看许可证与使用声明"
    Pop $0
    !insertmacro BKMove $0 314 354 320 24
    ${NSD_OnClick} $0 BKShowLicense
    SendMessage $BKNext ${WM_SETTEXT} 0 "STR:开始安装"
    SendMessage $BKCancel ${WM_SETTEXT} 0 "STR:取消"
    EnableWindow $BKNext 0
    ${IfNot} ${UAC_IsInnerInstance}
      ShowWindow $BKBack 1
    ${EndIf}
  ${EndIf}
  Call BKPrimary
  nsDialogs::Show
FunctionEnd

Function BKPrepareLeave
  ${If} $BKExisting == 0
    ${NSD_GetState} $BKLicense $0
    ${If} $0 != ${BST_CHECKED}
      Abort
    ${EndIf}
    ${NSD_GetText} $BKPathInput $INSTDIR
    ${If} $INSTDIR == ""
      MessageBox MB_OK|MB_ICONEXCLAMATION "请选择安装文件夹。"
      Abort
    ${EndIf}
    System::Call 'shlwapi::PathIsRelativeW(w "$INSTDIR")i.r0'
    ${If} $0 != 0
      MessageBox MB_OK|MB_ICONEXCLAMATION "请选择完整的绝对路径。"
      Abort
    ${EndIf}
    ClearErrors
    GetFullPathName $INSTDIR "$INSTDIR"
    ${If} ${Errors}
      MessageBox MB_OK|MB_ICONEXCLAMATION "安装路径无效，请重新选择。"
      Abort
    ${EndIf}
    ; Reject a drive root or relative path; never let the old uninstaller or
    ; extractor treat an entire drive as the application's installation folder.
    ${GetRoot} "$INSTDIR" $0
    ${If} $0 == ""
    ${OrIf} $INSTDIR == $0
    ${OrIf} $INSTDIR == "$0\"
      MessageBox MB_OK|MB_ICONEXCLAMATION "请选择一个完整的应用文件夹，例如 C:\Apps\BetterKuGou。"
      Abort
    ${EndIf}
    System::Call 'kernel32::GetDiskFreeSpaceExW(w "$0\", *l .r1, p 0, p 0)i.r2'
    ${If} $2 != 0
      System::Int64Op $1 / 1024
      Pop $1
      SectionGetSize 1 $2
      System::Int64Op $1 < $2
      Pop $3
      ${If} $3 != 0
        MessageBox MB_OK|MB_ICONEXCLAMATION "安装位置的可用空间不足，请选择其他位置或释放磁盘空间。"
        Abort
      ${EndIf}
    ${EndIf}
  ${ElseIf} $BKAction == "降级"
    MessageBox MB_YESNO|MB_DEFBUTTON2|MB_ICONEXCLAMATION "即将从 $BKOldVersion 降级到 ${VERSION}。旧版本可能无法读取较新设置。用户数据会保留，但此操作不提供自动回滚。确定继续降级吗？" IDYES +2
    Abort
  ${EndIf}
  StrCpy $BKConfirmed 1
  EnableWindow $BKNext 0
  EnableWindow $BKCancel 0
  EnableWindow $BKClose 0
  SendMessage $BKSubtitleControl ${WM_SETTEXT} 0 "STR:正在保存设置与播放进度，并等待应用退出…"
  System::Call 'user32::UpdateWindow(p $BKSubtitleControl)'
  Call BKCheckRunning
  ${If} $BKQuitFailed != 0
    EnableWindow $BKNext 1
    EnableWindow $BKCancel 1
    EnableWindow $BKClose 1
    SendMessage $BKSubtitleControl ${WM_SETTEXT} 0 "STR:$BKSubtitle"
    Abort
  ${EndIf}
  StrCpy $BKBusy 1
  EnableWindow $BKCancel 0
  EnableWindow $BKClose 0
FunctionEnd

; Retain MUI's extraction progress bar. Its value is controlled by the real
; install engine, never by a cosmetic timer or made-up percentage.
Function BKProgressShow
  StrCpy $BKBusy 1
  EnableWindow $BKCancel 0
  EnableWindow $BKBack 0
  FindWindow $BKPage "#32770" "" $HWNDPARENT
  !insertmacro BKMove $BKPage 292 180 424 224
  StrCpy $BKProgressControls ""
  !insertmacro BKRootLabel 0 0 250 500 "" $BKFont $BKText $BKBrandBg
  System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w "", i 0x5000000E, i 0, i 0, i 0, i 0, p $HWNDPARENT, p 0, p 0, p 0)p.r0'
  StrCpy $BKProgressControls "$BKProgressControls$0."
  !insertmacro BKMove $0 56 66 128 128
  Push $0
  ; Keep a separate bitmap for the persistent progress brand panel.
  Push $BKImage
  Call BKLoadLogo
  StrCpy $BKProgressImage $BKImage
  Pop $BKImage
  Pop $0
  SendMessage $0 ${STM_SETIMAGE} 0 $BKProgressImage
  !insertmacro BKRootLabel 32 226 208 52 "BetterKuGou" $BKFont $BKText $BKBrandBg
  !insertmacro BKRootLabel 32 276 190 90 "让音乐，$\r$\n回到生活里。" $BKBrandFont $BKText $BKBrandBg
  !insertmacro BKRootLabel 32 380 192 20 "${VERSION} · Windows" $BKSmallFont $BKMuted $BKBrandBg
  !insertmacro BKRootLabel 292 66 420 46 "正在$BKAction" $BKTitleFont $BKText $BKBg
  !insertmacro BKRootLabel 294 122 416 44 "正在写入应用文件，请保持此窗口打开。" $BKFont $BKMuted $BKBg
  SetCtlColors $BKPage $BKText $BKBg
  GetDlgItem $0 $BKPage 1006
  SendMessage $0 ${WM_SETTEXT} 0 "STR:正在$BKAction BetterKuGou，请稍候。"
  !insertmacro BKMove $0 0 0 416 54
  SetCtlColors $0 $BKText $BKBg
  GetDlgItem $0 $BKPage 1004
  !insertmacro BKMove $0 0 76 416 18
  GetDlgItem $0 $BKPage 1027
  ShowWindow $0 0
  GetDlgItem $0 $BKPage 1016
  ShowWindow $0 0
FunctionEnd

Function .onInstFailed
  StrCpy $BKBusy 0
  EnableWindow $BKCancel 1
  SetDetailsView show
  MessageBox MB_OK|MB_ICONEXCLAMATION "安装未完成。请查看安装详情，检查磁盘空间、目标文件夹权限及正在运行的 BetterKuGou，然后重新运行安装包。用户设置与播放记录会保留。"
FunctionEnd

Function .onGUIEnd
  Call BKDestroyProgress
  ${If} $BKImage != ""
    System::Call 'gdi32::DeleteObject(p $BKImage)'
  ${EndIf}
  ${If} $BKProgressImage != ""
    System::Call 'gdi32::DeleteObject(p $BKProgressImage)'
  ${EndIf}
  ${If} $BKButtonBitmap != ""
    System::Call 'gdi32::DeleteObject(p $BKButtonBitmap)'
  ${EndIf}
  System::Call 'gdi32::DeleteObject(p $BKFont)'
  System::Call 'gdi32::DeleteObject(p $BKTitleFont)'
  System::Call 'gdi32::DeleteObject(p $BKBrandFont)'
  System::Call 'gdi32::DeleteObject(p $BKSmallFont)'
FunctionEnd

Function BKFinishPage
  StrCpy $BKBusy 0
  Call BKDestroyProgress
  Call BKCommonPage
  ${If} $BKDone == 1
    StrCpy $BKActionTitle "$BKAction完成"
    StrCpy $BKSubtitle "音乐已经准备好，随时开始。"
  ${Else}
    StrCpy $BKActionTitle "安装未完成"
    StrCpy $BKSubtitle "请关闭程序后重新运行安装包。"
  ${EndIf}
  Call BKHeading
  ${NSD_CreateLabel} 294 200 416 100 "BetterKuGou ${VERSION}$\r$\n$\r$\n$INSTDIR"
  Pop $0
  !insertmacro BKMove $0 294 200 416 100
  SendMessage $0 ${WM_SETFONT} $BKFont 1
  SetCtlColors $0 $BKMuted $BKBg
  ${NSD_CreateLabel} 294 328 416 54 "你的设置、主题和播放记录会继续保留。"
  Pop $0
  !insertmacro BKMove $0 294 328 416 54
  SetCtlColors $0 $BKMuted $BKBg
  SendMessage $BKNext ${WM_SETTEXT} 0 "STR:启动 BetterKuGou"
  SendMessage $BKCancel ${WM_SETTEXT} 0 "STR:关闭"
  ${If} $BKDone != 1
    EnableWindow $BKNext 0
  ${EndIf}
  Call BKPrimary
  nsDialogs::Show
FunctionEnd

Function BKDestroyProgress
  StrCpy $BKTokenSource $BKProgressControls
  StrCpy $BKTokenNumber 1
  bkDestroyProgressLoop:
  Call BKReadIdentifier
  ${If} $BKToken == ""
    StrCpy $BKProgressControls ""
    Return
  ${EndIf}
  System::Call 'user32::DestroyWindow(p $BKToken)'
  IntOp $BKTokenNumber $BKTokenNumber + 1
  Goto bkDestroyProgressLoop
FunctionEnd

Function BKFinishLeave
  ${If} $BKDone == 1
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" ""
  ${EndIf}
FunctionEnd

; Enumerate every same-name process. Only the selected install path receives
; cooperative quit; other copies and inaccessible processes require manual exit,
; because even an older stock uninstaller must never get a chance to kill them.
Function BKFindRunning
  StrCpy $BKTargetCount 0
  StrCpy $BKOtherCount 0
  System::Call 'kernel32::CreateToolhelp32Snapshot(i 2, i 0)p.s'
  Pop $BKSnapshot
  ${If} $BKSnapshot == -1
    StrCpy $BKOtherCount 1
    Return
  ${EndIf}
  System::Alloc 556
  Pop $BKProcessMemory
  System::Call '*$BKProcessMemory(i 556)'
  System::Call 'kernel32::Process32FirstW(p $BKSnapshot, p $BKProcessMemory)i.r0'
  bkProcessLoop:
  ${If} $0 == 0
    Goto bkProcessDone
  ${EndIf}
  IntOp $1 $BKProcessMemory + 36
  System::Call '*$1(&w260 .r2)'
  ${If} $2 == "${PRODUCT_FILENAME}.exe"
    System::Call '*$BKProcessMemory(i, i, i .r0)'
    StrCpy $BKProcessPid $0
    System::Call 'kernel32::OpenProcess(i 0x1000, i 0, i $BKProcessPid)p.s'
    Pop $BKProcessHandle
    StrCpy $BKProcessPath ""
    ${If} $BKProcessHandle != 0
      System::Call 'kernel32::QueryFullProcessImageNameW(p $BKProcessHandle, i 0, w .r1, *i ${NSIS_MAX_STRLEN})i.r0'
      ${If} $0 != 0
        StrCpy $BKProcessPath $1
      ${EndIf}
      System::Call 'kernel32::CloseHandle(p $BKProcessHandle)'
    ${EndIf}
    ${If} $BKProcessPath == "$INSTDIR\${PRODUCT_FILENAME}.exe"
      IntOp $BKTargetCount $BKTargetCount + 1
      ${If} $BKConfirmed == 1
        Call BKRequestQuit
      ${EndIf}
    ${Else}
      IntOp $BKOtherCount $BKOtherCount + 1
    ${EndIf}
  ${EndIf}
  System::Call 'kernel32::Process32NextW(p $BKSnapshot, p $BKProcessMemory)i.r0'
  Goto bkProcessLoop
  bkProcessDone:
  System::Free $BKProcessMemory
  System::Call 'kernel32::CloseHandle(p $BKSnapshot)'
FunctionEnd

Function BKCheckRunning
  StrCpy $BKQuitFailed 0
  StrCpy $BKSupportedCount 0
  StrCpy $BKRequestedPids "|"
  System::Call 'kernel32::GetTickCount()i.s'
  Pop $BKQuitStart
  bkCheckRetry:
  Call BKFindRunning
  ${If} $BKTargetCount == 0
  ${AndIf} $BKOtherCount == 0
    StrCpy $BKQuitFailed 0
    Return
  ${EndIf}
  ; Never ask an existing program to quit until the preparation page's primary
  ; action and any downgrade confirmation have both been accepted.
  ${If} $BKConfirmed != 1
    StrCpy $BKQuitFailed 1
    Return
  ${EndIf}
  ${If} $BKSupportedCount == 0
    StrCpy $BKQuitFailed 1
  ${EndIf}
  System::Call 'kernel32::GetTickCount()i.r0'
  IntOp $0 $0 - $BKQuitStart
  ${If} $0 < 30000
  ${AndIf} $BKQuitFailed == 0
  ${AndIf} $BKOtherCount == 0
    Sleep 100
    Goto bkCheckRetry
  ${EndIf}
  ${If} $BKOtherCount > 0
    StrCpy $0 "检测到其他安装位置或无法确认来源的 BetterKuGou 进程。请手动退出所有 BetterKuGou，再重试。安装器不会强制结束进程。"
  ${Else}
    StrCpy $0 "BetterKuGou 尚未退出。旧版本可能不支持保存并退出，或保存设置失败。请切换到应用保存设置并手动退出，然后重试。安装器不会强制结束进程。"
  ${EndIf}
  MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$0" IDRETRY bkCheckRestart
  StrCpy $BKQuitFailed 1
  ; Called from a page leave: leave the prepared page available for another try.
  ${If} $BKBusy == 1
    SetErrorLevel 2
    Quit
  ${EndIf}
  Return
  bkCheckRestart:
  StrCpy $BKQuitFailed 0
  StrCpy $BKSupportedCount 0
  StrCpy $BKRequestedPids "|"
  System::Call 'kernel32::GetTickCount()i.s'
  Pop $BKQuitStart
  Goto bkCheckRetry
FunctionEnd

; A PID alone is not identity: authenticate the endpoint with the server PID and
; query that process's executable path before writing QUIT/1.
Function BKRequestQuit
  StrCpy $0 "|$BKProcessPid|"
  StrLen $1 $0
  StrLen $2 $BKRequestedPids
  StrCpy $3 0
  bkRequestedLoop:
  StrCpy $4 $BKRequestedPids $1 $3
  ${If} $4 == $0
    Return
  ${EndIf}
  IntOp $3 $3 + 1
  ${If} $3 < $2
    Goto bkRequestedLoop
  ${EndIf}
  System::Call 'kernel32::GetTickCount()i.r0'
  IntOp $0 $0 - $BKQuitStart
  ${If} $0 > 29000
    StrCpy $BKQuitFailed 1
    Return
  ${EndIf}
  StrCpy $BKPipe "\\.\pipe\BetterKuGou.InstallQuit.v1.$BKProcessPid"
  System::Call 'kernel32::GetTickCount()i.s'
  Pop $BKProbeStart
  System::Call 'kernel32::WaitNamedPipeW(w "$BKPipe", i 1000)i.r0'
  ${If} $0 == 0
    ; Electron's renderer and utility children share the executable filename,
    ; but only each application's main process owns a quit endpoint.
    Return
  ${EndIf}
  IntOp $BKSupportedCount $BKSupportedCount + 1
  System::Call 'kernel32::CreateFileW(w "$BKPipe", i 0xC0000000, i 0, p 0, i 3, i 0, p 0)p.s'
  Pop $BKPipe
  ${If} $BKPipe == -1
    StrCpy $BKQuitFailed 1
    Return
  ${EndIf}
  System::Call 'kernel32::GetNamedPipeServerProcessId(p $BKPipe, *i .r0)i.r1'
  ${If} $1 == 0
  ${OrIf} $0 != $BKProcessPid
    Goto bkPipeFailure
  ${EndIf}
  System::Call 'kernel32::OpenProcess(i 0x1000, i 0, i r0)p.r2'
  ${If} $2 == 0
    Goto bkPipeFailure
  ${EndIf}
  System::Call 'kernel32::QueryFullProcessImageNameW(p r2, i 0, w .r1, *i ${NSIS_MAX_STRLEN})i.r0'
  System::Call 'kernel32::CloseHandle(p r2)'
  ${If} $0 == 0
  ${OrIf} $1 != "$INSTDIR\${PRODUCT_FILENAME}.exe"
    Goto bkPipeFailure
  ${EndIf}
  System::Call 'kernel32::WriteFile(p $BKPipe, m "HELLO/1$\n", i 8, *i .r0, p 0)i.r1'
  ${If} $1 == 0
    Goto bkPipeFailure
  ${EndIf}
  System::Call 'kernel32::GetTickCount()i.r0'
  IntOp $0 $0 - $BKProbeStart
  IntOp $BKReadLimit 1000 - $0
  ${If} $BKReadLimit <= 0
    Goto bkPipeFailure
  ${EndIf}
  Call BKReadReply
  ${If} $BKReply != "READY/1$\n"
    Goto bkPipeFailure
  ${EndIf}
  System::Call 'kernel32::WriteFile(p $BKPipe, m "QUIT/1$\n", i 7, *i .r0, p 0)i.r1'
  ${If} $1 == 0
    Goto bkPipeFailure
  ${EndIf}
  StrCpy $BKReadLimit 10000
  Call BKReadReply
  ${If} $BKReply != "SAVED/1$\n"
    Goto bkPipeFailure
  ${EndIf}
  System::Call 'kernel32::CloseHandle(p $BKPipe)'
  ; Wait for the OS process itself to disappear; SAVED is never sufficient to
  ; let an old uninstaller touch an executable that is still running.
  StrCpy $BKRequestedPids "$BKRequestedPids$BKProcessPid|"
  Return
  bkPipeFailure:
  System::Call 'kernel32::CloseHandle(p $BKPipe)'
  StrCpy $BKQuitFailed 1
FunctionEnd

Function BKReadReply
  StrCpy $BKReply ""
  System::Call 'kernel32::GetTickCount()i.s'
  Pop $BKReadStart
  System::Alloc 256
  Pop $BKBuffer
  bkReadLoop:
  System::Call 'kernel32::PeekNamedPipe(p $BKPipe, p 0, i 0, p 0, *i .r0, p 0)i.r1'
  ${If} $1 == 0
    Goto bkReadDone
  ${EndIf}
  ${If} $0 > 0
    ${If} $0 > 128
      Goto bkReadDone
    ${EndIf}
    System::Call 'kernel32::ReadFile(p $BKPipe, p $BKBuffer, i r0, *i .r1, p 0)i.r2'
    ${If} $2 == 0
      Goto bkReadDone
    ${EndIf}
    IntOp $2 $BKBuffer + $1
    System::Call '*$2(&i1 0)'
    System::Call '*$BKBuffer(&m256 .r0)'
    StrCpy $BKReply "$BKReply$0"
    StrCpy $0 $BKReply 1 -1
    ${If} $0 == "$\n"
      Goto bkReadDone
    ${EndIf}
  ${EndIf}
  System::Call 'kernel32::GetTickCount()i.r0'
  IntOp $0 $0 - $BKReadStart
  ${If} $0 >= $BKReadLimit
    Goto bkReadDone
  ${EndIf}
  System::Call 'kernel32::GetTickCount()i.r0'
  IntOp $0 $0 - $BKQuitStart
  ${If} $0 >= 30000
    Goto bkReadDone
  ${EndIf}
  Sleep 20
  Goto bkReadLoop
  bkReadDone:
  System::Free $BKBuffer
FunctionEnd

; Compare SemVer core numbers and dot-separated prerelease identifiers. Build
; metadata has no precedence; numeric identifiers sort before non-numeric ones.
; Unknown historical version strings take the update path, never a false equality.
Function BKCompareVersions
  StrCpy $BKCompareResult unknown
  StrCpy $BKParseInput $BKCompareLeft
  Call BKParseVersion
  ${If} $BKParseValid != 1
    Return
  ${EndIf}
  StrCpy $BKLeftCore $BKParseCore
  StrCpy $BKLeftPre $BKParsePre
  StrCpy $BKParseInput $BKCompareRight
  Call BKParseVersion
  ${If} $BKParseValid != 1
    Return
  ${EndIf}
  StrCpy $BKRightCore $BKParseCore
  StrCpy $BKRightPre $BKParsePre
  StrCpy $BKCompareIndex 1
  bkCoreLoop:
  StrCpy $BKTokenSource $BKLeftCore
  StrCpy $BKTokenNumber $BKCompareIndex
  Call BKReadIdentifier
  StrCpy $BKLeftPart $BKToken
  StrCpy $BKTokenSource $BKRightCore
  Call BKReadIdentifier
  StrCpy $BKRightPart $BKToken
  Call BKCompareIdentifiers
  ${If} $BKCompareResult != 0
    Return
  ${EndIf}
  IntOp $BKCompareIndex $BKCompareIndex + 1
  ${If} $BKCompareIndex <= 3
    Goto bkCoreLoop
  ${EndIf}
  ${If} $BKLeftPre == ""
    ${If} $BKRightPre != ""
      StrCpy $BKCompareResult 1
    ${EndIf}
    Return
  ${EndIf}
  ${If} $BKRightPre == ""
    StrCpy $BKCompareResult -1
    Return
  ${EndIf}
  StrCpy $BKCompareIndex 1
  bkPreLoop:
  StrCpy $BKTokenSource $BKLeftPre
  StrCpy $BKTokenNumber $BKCompareIndex
  Call BKReadIdentifier
  StrCpy $BKLeftPart $BKToken
  StrCpy $BKTokenSource $BKRightPre
  Call BKReadIdentifier
  StrCpy $BKRightPart $BKToken
  ${If} $BKLeftPart == ""
    StrCpy $BKCompareResult -1
    ${If} $BKRightPart == ""
      StrCpy $BKCompareResult 0
    ${EndIf}
    Return
  ${ElseIf} $BKRightPart == ""
    StrCpy $BKCompareResult 1
    Return
  ${EndIf}
  Call BKCompareIdentifiers
  ${If} $BKCompareResult != 0
    Return
  ${EndIf}
  IntOp $BKCompareIndex $BKCompareIndex + 1
  Goto bkPreLoop
FunctionEnd

; Preserve hyphens inside prerelease identifiers and ignore build metadata.
; Invalid historical records must not compare equal to the incoming version.
Function BKParseVersion
  StrCpy $BKParseValid 0
  StrCpy $BKParseCore ""
  StrCpy $BKParsePre ""
  StrCpy $BKParseBuild ""
  StrCpy $BKParseState 0
  StrCpy $BKParseHadPre 0
  StrCpy $BKParseIndex 0
  bkParseLoop:
  StrCpy $0 $BKParseInput 1 $BKParseIndex
  ${If} $0 == ""
    Goto bkParseValidate
  ${EndIf}
  ${If} $0 == "+"
    ${If} $BKParseState == 2
      Return
    ${EndIf}
    StrCpy $BKParseState 2
  ${ElseIf} $0 == "-"
  ${AndIf} $BKParseState == 0
    StrCpy $BKParseState 1
    StrCpy $BKParseHadPre 1
  ${ElseIf} $BKParseState == 0
    StrCpy $BKParseCore "$BKParseCore$0"
  ${ElseIf} $BKParseState == 1
    StrCpy $BKParsePre "$BKParsePre$0"
  ${Else}
    StrCpy $BKParseBuild "$BKParseBuild$0"
  ${EndIf}
  IntOp $BKParseIndex $BKParseIndex + 1
  Goto bkParseLoop
  bkParseValidate:
  ${If} $BKParseCore == ""
    Return
  ${EndIf}
  ${If} $BKParseHadPre == 1
  ${AndIf} $BKParsePre == ""
    Return
  ${EndIf}
  ${If} $BKParseState == 2
  ${AndIf} $BKParseBuild == ""
    Return
  ${EndIf}
  StrCpy $0 0
  StrCpy $1 0
  bkCountCoreDots:
  StrCpy $2 $BKParseCore 1 $1
  ${If} $2 == ""
    ${If} $0 != 2
      Return
    ${EndIf}
    Goto bkCoreDotsCounted
  ${EndIf}
  ${If} $2 == "."
    IntOp $0 $0 + 1
  ${EndIf}
  IntOp $1 $1 + 1
  Goto bkCountCoreDots
  bkCoreDotsCounted:
  StrCpy $BKTokenSource $BKParseCore
  StrCpy $BKTokenNumber 1
  bkValidateCore:
  Call BKReadIdentifier
  StrCpy $0 $BKToken
  Call BKIsNumeric
  ${If} $BKNumeric != 1
    Return
  ${EndIf}
  StrLen $0 $BKToken
  StrCpy $1 $BKToken 1
  ${If} $0 > 1
  ${AndIf} $1 == "0"
    Return
  ${EndIf}
  IntOp $BKTokenNumber $BKTokenNumber + 1
  ${If} $BKTokenNumber <= 3
    Goto bkValidateCore
  ${EndIf}
  Call BKReadIdentifier
  ${If} $BKToken != ""
    Return
  ${EndIf}
  StrCpy $0 $BKParseCore 1 -1
  ${If} $0 == "."
    Return
  ${EndIf}
  StrCpy $BKParseIndex 0
  bkValidateSuffix:
  ${If} $BKParseIndex == 0
    StrCpy $BKTokenSource $BKParsePre
  ${Else}
    StrCpy $BKTokenSource $BKParseBuild
  ${EndIf}
  ${If} $BKTokenSource != ""
    StrCpy $0 $BKTokenSource 1
    StrCpy $1 $BKTokenSource 1 -1
    ${If} $0 == "."
    ${OrIf} $1 == "."
      Return
    ${EndIf}
    StrLen $0 $BKTokenSource
    System::Call 'shlwapi::StrSpnW(w "$BKTokenSource", w "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-.")i.r1'
    ${If} $0 != $1
      Return
    ${EndIf}
    StrCpy $BKTokenNumber 1
    bkValidateToken:
    Call BKReadIdentifier
    ${If} $BKToken == ""
      Return
    ${EndIf}
    ${If} $BKParseIndex == 0
      StrCpy $0 $BKToken
      Call BKIsNumeric
      ${If} $BKNumeric == 1
        StrLen $0 $BKToken
        StrCpy $1 $BKToken 1
        ${If} $0 > 1
        ${AndIf} $1 == "0"
          Return
        ${EndIf}
      ${EndIf}
    ${EndIf}
    ${If} $BKTokenLast == 0
      IntOp $BKTokenNumber $BKTokenNumber + 1
      Goto bkValidateToken
    ${EndIf}
  ${EndIf}
  IntOp $BKParseIndex $BKParseIndex + 1
  ${If} $BKParseIndex <= 1
    Goto bkValidateSuffix
  ${EndIf}
  StrCpy $BKParseValid 1
FunctionEnd

; A missing dot-separated word is always empty, including a single-word source.
Function BKReadIdentifier
  StrCpy $BKToken ""
  StrCpy $BKTokenLast 0
  StrCpy $0 0
  StrCpy $1 1
  bkTokenLoop:
  StrCpy $2 $BKTokenSource 1 $0
  ${If} $2 == ""
    StrCpy $BKTokenLast 1
    Return
  ${EndIf}
  ${If} $2 == "."
    ${If} $1 == $BKTokenNumber
      Return
    ${EndIf}
    IntOp $1 $1 + 1
  ${ElseIf} $1 == $BKTokenNumber
    StrCpy $BKToken "$BKToken$2"
  ${EndIf}
  IntOp $0 $0 + 1
  Goto bkTokenLoop
FunctionEnd

Function BKCompareIdentifiers
  StrCpy $BKCompareResult 0
  StrCpy $BKNumeric 0
  StrCpy $0 $BKLeftPart
  Call BKIsNumeric
  StrCpy $4 $BKNumeric
  StrCpy $0 $BKRightPart
  Call BKIsNumeric
  ${If} $4 == 1
  ${AndIf} $BKNumeric == 1
    StrLen $0 $BKLeftPart
    StrLen $1 $BKRightPart
    ${If} $0 < $1
      StrCpy $BKCompareResult -1
      Return
    ${ElseIf} $0 > $1
      StrCpy $BKCompareResult 1
      Return
    ${EndIf}
  ${ElseIf} $4 == 1
    StrCpy $BKCompareResult -1
    Return
  ${ElseIf} $BKNumeric == 1
    StrCpy $BKCompareResult 1
    Return
  ${EndIf}
  System::Call 'kernel32::CompareStringOrdinal(w "$BKLeftPart", i -1, w "$BKRightPart", i -1, i 0)i.r0'
  IntOp $BKCompareResult $0 - 2
FunctionEnd

Function BKIsNumeric
  StrCpy $BKNumeric 0
  StrLen $1 $0
  ${If} $1 == 0
    Return
  ${EndIf}
  System::Call 'shlwapi::StrSpnW(w r0, w "0123456789")i.r2'
  ${If} $2 == $1
    StrCpy $BKNumeric 1
  ${EndIf}
FunctionEnd
