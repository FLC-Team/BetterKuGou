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

; SetCtlColors requires literal RGB values. Roles select the same warm palette
; for native text, cards and edits; high contrast always uses Windows colors.
!macro BKSetColors HANDLE FG BG
  !if "${FG}" == "$BKText"
    !define BK_CTL_LIGHT_TEXT 28242C
    !define BK_CTL_DARK_TEXT F5F1F7
  !else if "${FG}" == "$BKMuted"
    !define BK_CTL_LIGHT_TEXT 756D7A
    !define BK_CTL_DARK_TEXT B5ACBD
  !else if "${FG}" == "$BKAccent"
    !define BK_CTL_LIGHT_TEXT 775F8F
    !define BK_CTL_DARK_TEXT C8B2DE
  !else
    !error "Unknown BetterKuGou foreground role: ${FG}"
  !endif
  !if "${BG}" == "$BKBg"
    !define BK_CTL_LIGHT_BG FCFAF7
    !define BK_CTL_DARK_BG 211F24
  !else if "${BG}" == "$BKBrandBg"
    !define BK_CTL_LIGHT_BG F1ECF4
    !define BK_CTL_DARK_BG 29252E
  !else if "${BG}" == "$BKSurface"
    !define BK_CTL_LIGHT_BG FFFFFF
    !define BK_CTL_DARK_BG 2C2832
  !else if "${BG}" == "$BKSelected"
    !define BK_CTL_LIGHT_BG F1EAF7
    !define BK_CTL_DARK_BG 393043
  !else if "${BG}" == "$BKBorder"
    !define BK_CTL_LIGHT_BG E6E0E9
    !define BK_CTL_DARK_BG 47404F
  !else if "${BG}" == "$BKAccent"
    !define BK_CTL_LIGHT_BG 775F8F
    !define BK_CTL_DARK_BG C8B2DE
  !else
    !error "Unknown BetterKuGou background role: ${BG}"
  !endif
  ${If} $BKHighContrast != 0
    SetCtlColors ${HANDLE} SYSCLR:8 SYSCLR:5
  ${ElseIf} $BKDark == 1
    SetCtlColors ${HANDLE} ${BK_CTL_DARK_TEXT} ${BK_CTL_DARK_BG}
  ${Else}
    SetCtlColors ${HANDLE} ${BK_CTL_LIGHT_TEXT} ${BK_CTL_LIGHT_BG}
  ${EndIf}
  !undef BK_CTL_LIGHT_TEXT
  !undef BK_CTL_DARK_TEXT
  !undef BK_CTL_LIGHT_BG
  !undef BK_CTL_DARK_BG
!macroend

; Keep the actual Win32 radio/checkbox for keyboard and accessible checked state.
!macro BKChoiceColors HANDLE BG
  ${If} $BKDark == 1
  ${AndIf} $BKHighContrast == 0
    System::Call 'uxtheme::SetWindowTheme(p ${HANDLE}, w "", w "")'
  ${EndIf}
  SendMessage ${HANDLE} ${WM_SETFONT} $BKFont 1
  !insertmacro BKSetColors ${HANDLE} $BKText ${BG}
!macroend

!macro BKLabel X Y W H TEXT FONT FG BG
  ; nsDialogs' stock label adds WS_EX_TRANSPARENT. Overlapping brand/card
  ; surfaces require opaque statics so native redraw and PrintWindow agree.
  nsDialogs::CreateControl STATIC ${DEFAULT_STYLES}|${SS_NOTIFY} 0 ${X} ${Y} ${W} ${H} "${TEXT}"
  Pop $0
  !insertmacro BKMove $0 ${X} ${Y} ${W} ${H}
  SendMessage $0 ${WM_SETFONT} ${FONT} 1
  !insertmacro BKSetColors $0 ${FG} ${BG}
!macroend

!macro BKRootLabel X Y W H TEXT FONT FG BG
  System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w "${TEXT}", i 0x54000000, i 0, i 0, i 0, i 0, p $HWNDPARENT, p 0, p 0, p 0)p.r0'
  StrCpy $BKProgressControls "$BKProgressControls$0."
  !insertmacro BKMove $0 ${X} ${Y} ${W} ${H}
  SendMessage $0 ${WM_SETFONT} ${FONT} 1
  !insertmacro BKSetColors $0 ${FG} ${BG}
!macroend

; Use explicit CJK sans-serif and ClearType at the current DPI. Relying on the
; stock dialog font or Segoe UI's Chinese fallback can select a serif font.
!macro BKCreateFont HANDLE SIZE WEIGHT
  IntOp $0 ${SIZE} * $BKScale
  IntOp $0 $0 / 96
  IntOp $0 0 - $0
  System::Call 'gdi32::CreateFontW(i r0, i 0, i 0, i 0, i ${WEIGHT}, i 0, i 0, i 0, i 1, i 0, i 0, i 5, i 0, w "Microsoft YaHei UI")p.s'
  Pop ${HANDLE}
!macroend

; Both nsDialogs pages and the extraction page share the same brand composition.
!macro BKBrand LABEL
  !insertmacro ${LABEL} 78 31 138 24 "BetterKuGou" $BKStrongFont $BKText $BKBrandBg
  !insertmacro ${LABEL} 78 53 134 18 "音乐 · 不止于此" $BKSmallFont $BKMuted $BKBrandBg
  !insertmacro ${LABEL} 26 136 178 88 "好音乐，$\r$\n慢慢听。" $BKBrandFont $BKText $BKBrandBg
  !insertmacro ${LABEL} 26 244 178 56 "找到喜欢的旋律，$\r$\n留住自己的节奏。" $BKFont $BKMuted $BKBrandBg
  !insertmacro ${LABEL} 26 334 172 1 "" $BKFont $BKText $BKBorder
  !insertmacro ${LABEL} 26 354 172 20 "$BKStepText" $BKSmallFont $BKAccent $BKBrandBg
  !if "${LABEL}" == "BKRootLabel"
    StrCpy $BKProgressBrandStep $0
  !endif
  !insertmacro ${LABEL} 26 384 172 20 "${VERSION}" $BKSmallFont $BKMuted $BKBrandBg
  ; Background last: native siblings clip it beneath every foreground control.
  !insertmacro ${LABEL} 0 0 224 500 "" $BKFont $BKText $BKBrandBg
!macroend

!macro BKButton HANDLE ROLE
  StrCpy $BKButtonHandle ${HANDLE}
  StrCpy $BKButtonRole "${ROLE}"
  Call BKPaintButton
!macroend

!macro BKMotionAssets DPI
  File /oname=$PLUGINSDIR\install-light-${DPI}.avi "${PROJECT_DIR}\installer\assets\install-light-${DPI}.avi"
  File /oname=$PLUGINSDIR\install-dark-${DPI}.avi "${PROJECT_DIR}\installer\assets\install-dark-${DPI}.avi"
  File /oname=$PLUGINSDIR\success-light-${DPI}.avi "${PROJECT_DIR}\installer\assets\success-light-${DPI}.avi"
  File /oname=$PLUGINSDIR\success-dark-${DPI}.avi "${PROJECT_DIR}\installer\assets\success-dark-${DPI}.avi"
!macroend

Function BKGuiInit
  System::Call 'user32::GetDC(p $HWNDPARENT)p.r0'
  System::Call 'gdi32::GetDeviceCaps(p r0, i 88)i.s'
  Pop $BKScale
  System::Call 'user32::ReleaseDC(p $HWNDPARENT, p r0)'
  ${If} $BKScale < 96
    StrCpy $BKScale 96
  ${EndIf}
  !insertmacro BKCreateFont $BKFont 14 400
  !insertmacro BKCreateFont $BKStrongFont 14 600
  !insertmacro BKCreateFont $BKTitleFont 28 600
  !insertmacro BKCreateFont $BKBrandFont 26 600
  !insertmacro BKCreateFont $BKSmallFont 12 400
  SendMessage $HWNDPARENT ${WM_SETFONT} $BKFont 0
  StrCpy $BKBg FCFAF7
  StrCpy $BKBrandBg F1ECF4
  StrCpy $BKSurface FFFFFF
  StrCpy $BKSelected F1EAF7
  StrCpy $BKBorder E6E0E9
  StrCpy $BKText 28242C
  StrCpy $BKMuted 756D7A
  StrCpy $BKAccent 775F8F
  StrCpy $BKDark 0
  ClearErrors
  ReadRegDWORD $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Themes\Personalize" AppsUseLightTheme
  ${IfNot} ${Errors}
  ${AndIf} $0 == 0
    StrCpy $BKDark 1
    StrCpy $BKBg 211F24
    StrCpy $BKBrandBg 29252E
    StrCpy $BKSurface 2C2832
    StrCpy $BKSelected 393043
    StrCpy $BKBorder 47404F
    StrCpy $BKText F5F1F7
    StrCpy $BKMuted B5ACBD
    StrCpy $BKAccent C8B2DE
  ${EndIf}
  System::Alloc 12
  Pop $0
  System::Call '*$0(i 12, i 0, p 0)'
  System::Call 'user32::SystemParametersInfoW(i 66, i 12, p r0, i 0)'
  System::Call '*$0(i, i .r1)'
  IntOp $BKHighContrast $1 & 1
  System::Free $0
  ${If} $BKHighContrast != 0
    System::Call 'user32::GetSysColor(i 5)i.r0'
    Call BKColorRefToRgb
    IntFmt $BKBg "%06X" $0
    StrCpy $BKBrandBg $BKBg
    StrCpy $BKSurface $BKBg
    StrCpy $BKSelected $BKBg
    StrCpy $BKBorder $BKBg
    System::Call 'user32::GetSysColor(i 8)i.r0'
    Call BKColorRefToRgb
    IntFmt $BKText "%06X" $0
    StrCpy $BKMuted $BKText
    StrCpy $BKAccent $BKText
  ${EndIf}
  !insertmacro BKSetColors $HWNDPARENT $BKText $BKBg
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
  ; Extraction, focus traversal and Enter/Escape continue to use MUI's buttons.
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
  GetDlgItem $0 $HWNDPARENT 1035
  ShowWindow $0 0
  GetDlgItem $0 $HWNDPARENT 1036
  ShowWindow $0 0
  GetDlgItem $0 $HWNDPARENT 1045
  ShowWindow $0 0
  GetDlgItem $BKNext $HWNDPARENT 1
  GetDlgItem $BKBack $HWNDPARENT 3
  GetDlgItem $BKCancel $HWNDPARENT 2
  !insertmacro BKMove $BKNext 542 440 174 40
  !insertmacro BKMove $BKBack 268 440 82 40
  !insertmacro BKMove $BKCancel 418 440 106 40
  SendMessage $BKNext ${WM_SETFONT} $BKStrongFont 1
  SendMessage $BKBack ${WM_SETFONT} $BKFont 1
  SendMessage $BKCancel ${WM_SETFONT} $BKFont 1
  System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w "", i 0x54000000, i 0, i 0, i 0, i 0, p $HWNDPARENT, p 0, p 0, p 0)p.r0'
  !insertmacro BKMove $0 0 424 224 76
  !insertmacro BKSetColors $0 $BKText $BKBrandBg
  System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w "", i 0x54000000, i 0, i 0, i 0, i 0, p $HWNDPARENT, p 0, p 0, p 0)p.r0'
  !insertmacro BKMove $0 268 423 448 1
  !insertmacro BKSetColors $0 $BKText $BKBorder
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

; Apply the same native bitmap-button treatment to every persistent action.
Function BKPrimary
  !insertmacro BKButton $BKNext primary
  !insertmacro BKButton $BKCancel quiet
  !insertmacro BKButton $BKBack quiet
FunctionEnd

; A real flat Win32 button retains its accessible caption, native pressed/focus
; feedback and disabled semantics. The bitmap owns only the visual surface.
Function BKPaintButton
  ${If} $BKHighContrast != 0
    Return
  ${EndIf}
  System::Call 'user32::GetWindowTextW(p $BKButtonHandle, w .r0, i ${NSIS_MAX_STRLEN})'
  StrCpy $BKDrawText $0
  System::Alloc 16
  Pop $BKDrawRect
  System::Call 'user32::GetClientRect(p $BKButtonHandle, p $BKDrawRect)'
  System::Call '*$BKDrawRect(i, i, i .r0, i .r1)'
  StrCpy $BKDrawWidth $0
  StrCpy $BKDrawHeight $1
  ${If} $BKDrawWidth < 1
  ${OrIf} $BKDrawHeight < 1
    System::Free $BKDrawRect
    Return
  ${EndIf}
  StrCpy $BKButtonOuter $BKBg
  StrCpy $BKButtonBackground $BKBg
  StrCpy $BKButtonForeground $BKMuted
  ${If} $BKButtonRole == primary
    StrCpy $BKButtonBackground $BKText
    StrCpy $BKButtonForeground $BKBg
    System::Call 'user32::IsWindowEnabled(p $BKButtonHandle)i.r0'
    ${If} $0 == 0
      StrCpy $BKButtonBackground $BKBorder
      StrCpy $BKButtonForeground $BKMuted
    ${EndIf}
  ${ElseIf} $BKButtonRole == secondary
    StrCpy $BKButtonBackground $BKBrandBg
    StrCpy $BKButtonForeground $BKText
  ${EndIf}
  System::Call 'user32::GetDC(p $HWNDPARENT)p.r0'
  System::Call 'gdi32::CreateCompatibleDC(p r0)p.s'
  Pop $BKDrawDC
  System::Call 'gdi32::CreateCompatibleBitmap(p r0, i $BKDrawWidth, i $BKDrawHeight)p.s'
  Pop $BKDrawBitmap
  System::Call 'user32::ReleaseDC(p $HWNDPARENT, p r0)'
  System::Call 'gdi32::SelectObject(p $BKDrawDC, p $BKDrawBitmap)p.s'
  Pop $BKDrawOldBitmap
  System::Call '*$BKDrawRect(i 0, i 0, i $BKDrawWidth, i $BKDrawHeight)'
  IntOp $0 "0x$BKButtonOuter" | 0
  Call BKColorRefToRgb
  System::Call 'gdi32::CreateSolidBrush(i r0)p.r0'
  System::Call 'user32::FillRect(p $BKDrawDC, p $BKDrawRect, p r0)'
  System::Call 'gdi32::DeleteObject(p r0)'
  IntOp $0 "0x$BKButtonBackground" | 0
  Call BKColorRefToRgb
  System::Call 'gdi32::CreateSolidBrush(i r0)p.s'
  Pop $BKButtonBrush
  System::Call 'gdi32::CreatePen(i 0, i 1, i r0)p.s'
  Pop $BKButtonPen
  System::Call 'gdi32::SelectObject(p $BKDrawDC, p $BKButtonBrush)p.s'
  Pop $BKButtonOldBrush
  System::Call 'gdi32::SelectObject(p $BKDrawDC, p $BKButtonPen)p.s'
  Pop $BKButtonOldPen
  IntOp $0 12 * $BKScale
  IntOp $0 $0 / 96
  System::Call 'gdi32::RoundRect(p $BKDrawDC, i 0, i 0, i $BKDrawWidth, i $BKDrawHeight, i r0, i r0)'
  System::Call 'gdi32::SelectObject(p $BKDrawDC, p $BKButtonOldBrush)'
  System::Call 'gdi32::SelectObject(p $BKDrawDC, p $BKButtonOldPen)'
  System::Call 'gdi32::DeleteObject(p $BKButtonBrush)'
  System::Call 'gdi32::DeleteObject(p $BKButtonPen)'
  IntOp $0 "0x$BKButtonForeground" | 0
  Call BKColorRefToRgb
  System::Call 'gdi32::SetTextColor(p $BKDrawDC, i r0)'
  System::Call 'gdi32::SetBkMode(p $BKDrawDC, i 1)'
  System::Call 'gdi32::SelectObject(p $BKDrawDC, p $BKStrongFont)p.s'
  Pop $BKDrawFont
  System::Call 'user32::DrawTextW(p $BKDrawDC, w "$BKDrawText", i -1, p $BKDrawRect, i 0x825)'
  System::Call 'gdi32::SelectObject(p $BKDrawDC, p $BKDrawFont)'
  System::Call 'gdi32::SelectObject(p $BKDrawDC, p $BKDrawOldBitmap)'
  System::Call 'gdi32::DeleteDC(p $BKDrawDC)'
  System::Free $BKDrawRect
  System::Call 'uxtheme::SetWindowTheme(p $BKButtonHandle, w "", w "")'
  !insertmacro BKSetColors $BKButtonHandle $BKText $BKBg
  System::Call 'user32::GetWindowLongW(p $BKButtonHandle, i -16)i.r0'
  IntOp $0 $0 | 0x8080
  System::Call 'user32::SetWindowLongW(p $BKButtonHandle, i -16, i r0)'
  SendMessage $BKButtonHandle ${BM_SETIMAGE} 0 $BKDrawBitmap $0
  ${If} $0 != 0
    System::Call 'gdi32::DeleteObject(p r0)'
  ${EndIf}
  ${If} $BKButtonHandle == $BKNext
    StrCpy $BKButtonBitmap $BKDrawBitmap
  ${ElseIf} $BKButtonHandle == $BKCancel
    StrCpy $BKCancelBitmap $BKDrawBitmap
  ${ElseIf} $BKButtonHandle == $BKBack
    StrCpy $BKBackBitmap $BKDrawBitmap
  ${ElseIf} $BKButtonHandle == $BKClose
    StrCpy $BKCloseBitmap $BKDrawBitmap
  ${Else}
    StrCpy $BKBrowseBitmap $BKDrawBitmap
  ${EndIf}
  ; Clip only the stock two-pixel outer frame. The real button, its accessible
  ; role and its inset keyboard focus rectangle remain native. Windows owns a
  ; successfully assigned region and releases the preceding region itself.
  IntOp $1 $BKDrawWidth - 2
  IntOp $2 $BKDrawHeight - 2
  IntOp $3 12 * $BKScale
  IntOp $3 $3 / 96
  System::Call 'gdi32::CreateRoundRectRgn(i 2, i 2, i r1, i r2, i r3, i r3)p.s'
  Pop $BKButtonBrush
  System::Call 'user32::SetWindowRgn(p $BKButtonHandle, p $BKButtonBrush, i 1)i.r0'
  ${If} $0 == 0
    System::Call 'gdi32::DeleteObject(p $BKButtonBrush)'
  ${EndIf}
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

; Native controls keep their checked/focus state; only their opaque palette is interpolated.
!macro BKScopePalette RADIO PANEL DESCRIPTION BORDER LIGHT_BG DARK_BG LIGHT_BORDER DARK_BORDER
  ${If} $BKHighContrast != 0
    SetCtlColors ${RADIO} SYSCLR:8 SYSCLR:5
    SetCtlColors ${PANEL} SYSCLR:8 SYSCLR:5
    SetCtlColors ${DESCRIPTION} SYSCLR:8 SYSCLR:5
    SetCtlColors ${BORDER} SYSCLR:8 SYSCLR:5
  ${ElseIf} $BKDark == 1
    SetCtlColors ${RADIO} F5F1F7 ${DARK_BG}
    SetCtlColors ${PANEL} F5F1F7 ${DARK_BG}
    SetCtlColors ${DESCRIPTION} B5ACBD ${DARK_BG}
    SetCtlColors ${BORDER} F5F1F7 ${DARK_BORDER}
  ${Else}
    SetCtlColors ${RADIO} 28242C ${LIGHT_BG}
    SetCtlColors ${PANEL} 28242C ${LIGHT_BG}
    SetCtlColors ${DESCRIPTION} 756D7A ${LIGHT_BG}
    SetCtlColors ${BORDER} 28242C ${LIGHT_BORDER}
  ${EndIf}
!macroend

; SetCtlColors requires compile-time RGB literals, so the short tween has eight palette steps.
!macro BKScopeCardColors RADIO PANEL DESCRIPTION BORDER LEVEL
  ${If} ${LEVEL} == 0
    !insertmacro BKScopePalette ${RADIO} ${PANEL} ${DESCRIPTION} ${BORDER} FFFFFF 2C2832 E6E0E9 47404F
  ${ElseIf} ${LEVEL} == 1
    !insertmacro BKScopePalette ${RADIO} ${PANEL} ${DESCRIPTION} ${BORDER} FDFCFE 2E2934 D8D0DE 574E61
  ${ElseIf} ${LEVEL} == 2
    !insertmacro BKScopePalette ${RADIO} ${PANEL} ${DESCRIPTION} ${BORDER} FCFAFD 2F2A36 CAC0D3 675D73
  ${ElseIf} ${LEVEL} == 3
    !insertmacro BKScopePalette ${RADIO} ${PANEL} ${DESCRIPTION} ${BORDER} FAF7FC 312B38 BCB0C7 776B85
  ${ElseIf} ${LEVEL} == 4
    !insertmacro BKScopePalette ${RADIO} ${PANEL} ${DESCRIPTION} ${BORDER} F8F5FB 332C3B AFA0BC 887997
  ${ElseIf} ${LEVEL} == 5
    !insertmacro BKScopePalette ${RADIO} ${PANEL} ${DESCRIPTION} ${BORDER} F6F2FA 342D3D A18FB1 9887A8
  ${ElseIf} ${LEVEL} == 6
    !insertmacro BKScopePalette ${RADIO} ${PANEL} ${DESCRIPTION} ${BORDER} F5EFF9 362E3F 937FA6 A896BA
  ${ElseIf} ${LEVEL} == 7
    !insertmacro BKScopePalette ${RADIO} ${PANEL} ${DESCRIPTION} ${BORDER} F3EDF8 372F41 856F9A B8A4CC
  ${ElseIf} ${LEVEL} == 8
    !insertmacro BKScopePalette ${RADIO} ${PANEL} ${DESCRIPTION} ${BORDER} F1EAF7 393043 775F8F C8B2DE
  ${EndIf}
!macroend

; Honor Windows' client-area animation preference and high contrast without changing installation state.
Function BKMotionAllowed
  Push $0
  StrCpy $BKMotionEnabled 0
  ${If} $BKHighContrast == 0
    System::Call 'user32::SystemParametersInfoW(i 0x1042, i 0, *i .r0, i 0)i.s'
    Pop $BKMotionEnabled
    ${If} $0 == 0
      StrCpy $BKMotionEnabled 0
    ${EndIf}
  ${EndIf}
  Pop $0
FunctionEnd

; Timers belong only to the currently displayed custom page; no sleeps or input blocking.
Function BKStopMotion
  Push $0
  Call BKStopAnimation
  GetFunctionAddress $0 BKPageMotionTick
  nsDialogs::KillTimer $0
  GetFunctionAddress $0 BKScopeMotionTick
  nsDialogs::KillTimer $0
  StrCpy $BKPageMotionPage ""
  Pop $0
FunctionEnd

; SysAnimate32 owns playback entirely in native code while NSIS extracts files
; on its worker. Never call NSIS bytecode from a UI timer during installation.
; The caller positions this input-transparent control after it has opened.
Function BKCreateAnimation
  Call BKStopAnimation
  ${If} $BKHighContrast != 0
    Return
  ${EndIf}
  StrCpy $BKAnimationTheme light
  ${If} $BKDark == 1
    StrCpy $BKAnimationTheme dark
  ${EndIf}
  StrCpy $BKAnimationDpi 96
  ${If} $BKScale >= 192
    StrCpy $BKAnimationDpi 192
  ${ElseIf} $BKScale >= 144
    StrCpy $BKAnimationDpi 144
  ${ElseIf} $BKScale >= 120
    StrCpy $BKAnimationDpi 120
  ${EndIf}
  System::Call 'comctl32::InitCommonControls()'
  ; ACS_CENTER, WS_CHILD, WS_VISIBLE and WS_CLIPSIBLINGS; no auto-play or focus.
  System::Call 'user32::CreateWindowExW(i 0, w "SysAnimate32", w "", i 0x54000001, i 0, i 0, i 0, i 0, p $BKAnimationParent, p 0, p 0, p 0)p.s'
  Pop $BKInstallAnimation
  ${If} $BKInstallAnimation == 0
    Return
  ${EndIf}
  ${If} $BKAnimationKind == success
    !insertmacro BKSetColors $BKInstallAnimation $BKAccent $BKSurface
  ${Else}
    !insertmacro BKSetColors $BKInstallAnimation $BKAccent $BKBg
  ${EndIf}
  ; ACM_OPENW accepts only our packaged, local, silent clip.
  SendMessage $BKInstallAnimation 0x467 0 "STR:$PLUGINSDIR\$BKAnimationKind-$BKAnimationTheme-$BKAnimationDpi.avi" $0
  ${If} $0 == 0
    Call BKStopAnimation
    Return
  ${EndIf}
  Call BKMotionAllowed
  ${If} $BKMotionEnabled == 0
    ${If} $BKAnimationKind == success
      ; Animate_Seek(last): retain a clear completed check without movement.
      SendMessage $BKInstallAnimation 0x465 1 0x000E000E
    ${Else}
      SendMessage $BKInstallAnimation 0x465 1 0
    ${EndIf}
  ${ElseIf} $BKAnimationKind == success
    ; A hidden nsDialogs parent can consume a short clip before its first
    ; visible message loop. Start once from that custom page, after Show.
    SendMessage $BKInstallAnimation 0x465 1 0
    StrCpy $BKSuccessMotionPage $BKAnimationParent
    GetFunctionAddress $0 BKStartSuccessAnimation
    nsDialogs::CreateTimer $0 16
  ${Else}
    SendMessage $BKInstallAnimation 0x465 -1 0x00310000
  ${EndIf}
FunctionEnd

; Close both the clip and HWND on page change, failure and early window exit.
; Closing the native control releases its decoder, internal timer and buffers.
Function BKStopAnimation
  Push $0
  GetFunctionAddress $0 BKStartSuccessAnimation
  nsDialogs::KillTimer $0
  StrCpy $BKSuccessMotionPage ""
  ${If} $BKInstallAnimation != ""
  ${AndIf} $BKInstallAnimation != 0
    SendMessage $BKInstallAnimation 0x466 0 0
    SendMessage $BKInstallAnimation 0x467 0 0
    System::Call 'user32::DestroyWindow(p $BKInstallAnimation)'
  ${EndIf}
  StrCpy $BKInstallAnimation ""
  Pop $0
FunctionEnd

; Only a completed custom page schedules this one-shot callback. The extraction
; worker has finished; installation itself never registers script callbacks.
Function BKStartSuccessAnimation
  Push $0
  System::Call 'user32::IsWindow(p $BKInstallAnimation)i.r0'
  ${If} $0 != 0
  ${AndIf} $BKSuccessMotionPage == $BKPage
  ${AndIf} $BKAnimationKind == success
    ; The custom page can already be shown while its outer owner is still
    ; hidden (for example immediately after elevation). Wait for visibility.
    System::Call 'user32::IsWindowVisible(p $BKInstallAnimation)i.r0'
    ${If} $0 == 0
      Pop $0
      Return
    ${EndIf}
    GetFunctionAddress $0 BKStartSuccessAnimation
    nsDialogs::KillTimer $0
    System::Call 'user32::RedrawWindow(p $BKInstallAnimation, p 0, p 0, i 0x105)'
    Call BKMotionAllowed
    ${If} $BKMotionEnabled == 0
      SendMessage $BKInstallAnimation 0x465 1 0x000E000E
    ${Else}
      SendMessage $BKInstallAnimation 0x465 1 0x000E0000
    ${EndIf}
  ${Else}
    GetFunctionAddress $0 BKStartSuccessAnimation
    nsDialogs::KillTimer $0
  ${EndIf}
  StrCpy $BKSuccessMotionPage ""
  Pop $0
FunctionEnd

Function BKStartPageMotion
  Call BKMotionAllowed
  ${If} $BKMotionEnabled == 0
    Return
  ${EndIf}
  StrCpy $BKPageMotionPage $BKPage
  System::Call 'kernel32::GetTickCount()i.s'
  Pop $BKPageMotionStart
  !insertmacro BKMove $BKPage 14 0 760 424
  GetFunctionAddress $0 BKPageMotionTick
  nsDialogs::CreateTimer $0 16
FunctionEnd

Function BKPageMotionTick
  Push $0
  Push $1
  Call BKMotionAllowed
  System::Call 'user32::IsWindow(p $BKPageMotionPage)i.r0'
  ${If} $0 == 0
  ${OrIf} $BKPageMotionPage != $BKPage
    GetFunctionAddress $0 BKPageMotionTick
    nsDialogs::KillTimer $0
  ${Else}
    System::Call 'kernel32::GetTickCount()i.r0'
    IntOp $0 $0 - $BKPageMotionStart
    ${If} $0 >= 180
    ${OrIf} $0 < 0
    ${OrIf} $BKMotionEnabled == 0
      StrCpy $BKPageMotionX 0
      GetFunctionAddress $0 BKPageMotionTick
      nsDialogs::KillTimer $0
    ${Else}
      IntOp $0 180 - $0
      IntOp $1 $0 * $0
      IntOp $1 $1 * 14
      IntOp $BKPageMotionX $1 / 32400
    ${EndIf}
    !insertmacro BKMove $BKPage $BKPageMotionX 0 760 424
  ${EndIf}
  Pop $1
  Pop $0
FunctionEnd

Function BKPaintScopeMotion
  !insertmacro BKScopeCardColors $BKAllUsers $BKScopeAllPanel $BKScopeAllDescription $BKScopeAllBorder $BKScopePosition
  IntOp $BKScopeLevel 8 - $BKScopePosition
  !insertmacro BKScopeCardColors $BKCurrentUser $BKScopeCurrentPanel $BKScopeCurrentDescription $BKScopeCurrentBorder $BKScopeLevel
  System::Call 'user32::InvalidateRect(p $BKPage, p 0, i 1)'
FunctionEnd

Function BKScopeMotionTick
  Push $0
  Call BKMotionAllowed
  System::Call 'user32::IsWindow(p $BKAllUsers)i.r0'
  ${If} $0 == 0
    GetFunctionAddress $0 BKScopeMotionTick
    nsDialogs::KillTimer $0
  ${Else}
    ${If} $BKMotionEnabled == 0
      StrCpy $BKScopePosition $BKScopeTarget
    ${ElseIf} $BKScopePosition < $BKScopeTarget
      IntOp $BKScopePosition $BKScopePosition + 1
    ${ElseIf} $BKScopePosition > $BKScopeTarget
      IntOp $BKScopePosition $BKScopePosition - 1
    ${EndIf}
    Call BKPaintScopeMotion
    ${If} $BKScopePosition == $BKScopeTarget
      GetFunctionAddress $0 BKScopeMotionTick
      nsDialogs::KillTimer $0
    ${EndIf}
  ${EndIf}
  Pop $0
FunctionEnd

Function BKCommonPage
  Call BKStopMotion
  StrCpy $BKScopeReady 0
  ; Child controls from the preceding page no longer own these bitmaps.
  ${If} $BKCloseBitmap != ""
    System::Call 'gdi32::DeleteObject(p $BKCloseBitmap)'
    StrCpy $BKCloseBitmap ""
  ${EndIf}
  ${If} $BKBrowseBitmap != ""
    System::Call 'gdi32::DeleteObject(p $BKBrowseBitmap)'
    StrCpy $BKBrowseBitmap ""
  ${EndIf}
  nsDialogs::Create 1018
  Pop $BKPage
  ${If} $BKPage == error
    Abort
  ${EndIf}
  !insertmacro BKMove $BKPage 0 0 760 424
  SendMessage $BKPage ${WM_SETFONT} $BKFont 0
  !insertmacro BKSetColors $BKPage $BKText $BKBg
  ${NSD_CreateBitmap} 0 0 40 40 ""
  Pop $0
  !insertmacro BKMove $0 26 28 40 40
  Push $0
  ${If} $BKImage != ""
    System::Call 'gdi32::DeleteObject(p $BKImage)'
  ${EndIf}
  Call BKLoadLogo
  Pop $0
  SendMessage $0 ${STM_SETIMAGE} 0 $BKImage
  !insertmacro BKBrand BKLabel
  ${NSD_CreateButton} 0 0 32 30 "×"
  Pop $BKClose
  !insertmacro BKMove $BKClose 714 12 32 30
  SendMessage $BKClose ${WM_SETFONT} $BKFont 1
  !insertmacro BKButton $BKClose quiet
  ${NSD_OnClick} $BKClose BKCloseClick
  ${NSD_CreateLink} 0 0 162 20 "移动窗口"
  Pop $BKDrag
  !insertmacro BKMove $BKDrag 268 20 100 20
  SendMessage $BKDrag ${WM_SETFONT} $BKSmallFont 1
  !insertmacro BKSetColors $BKDrag $BKMuted $BKBg
  ${NSD_OnClick} $BKDrag BKDragClick
  ShowWindow $BKBack 0
  ShowWindow $BKNext 1
  ShowWindow $BKCancel 1
  EnableWindow $BKCancel 1
  EnableWindow $BKNext 1
FunctionEnd

Function BKLoadLogo
  IntOp $0 40 * $BKScale
  IntOp $0 $0 / 96
  ${If} $BKDark == 1
    System::Call 'user32::LoadImageW(p 0, w "$PLUGINSDIR\bk-logo-dark.bmp", i 0, i r0, i r0, i 0x10)p.s'
  ${Else}
    System::Call 'user32::LoadImageW(p 0, w "$PLUGINSDIR\bk-logo-light.bmp", i 0, i r0, i r0, i 0x10)p.s'
  ${EndIf}
  Pop $BKImage
FunctionEnd

Function BKHeading
  !insertmacro BKLabel 268 70 448 22 "$BKStepText" $BKSmallFont $BKAccent $BKBg
  !insertmacro BKLabel 266 98 452 42 "$BKActionTitle" $BKTitleFont $BKText $BKBg
  StrCpy $BKTitle $0
  !insertmacro BKLabel 268 145 448 44 "$BKSubtitle" $BKFont $BKMuted $BKBg
  StrCpy $BKSubtitleControl $0
FunctionEnd

Function BKScopePage
  StrCpy $BKScopeReady 0
  ${If} $BKExisting == 1
    Abort
  ${EndIf}
  ${If} ${UAC_IsInnerInstance}
    Abort
  ${EndIf}
  StrCpy $BKStepText "01 / 安装范围"
  Call BKCommonPage
  StrCpy $BKActionTitle "为谁安装？"
  StrCpy $BKSubtitle "选择适合你的使用方式。"
  Call BKHeading
  ${NSD_CreateRadioButton} 0 0 408 28 "仅为当前用户安装"
  Pop $BKCurrentUser
  !insertmacro BKMove $BKCurrentUser 286 211 408 28
  ${NSD_OnClick} $BKCurrentUser BKScopeChanged
  !insertmacro BKLabel 307 245 385 24 "推荐 · 无需管理员权限，不影响其他用户。" $BKSmallFont $BKMuted $BKSurface
  StrCpy $BKScopeCurrentDescription $0
  ${NSD_OnClick} $0 BKScopeCurrentClick
  !insertmacro BKLabel 269 197 446 86 "" $BKFont $BKText $BKSurface
  StrCpy $BKScopeCurrentPanel $0
  ${NSD_OnClick} $0 BKScopeCurrentClick
  !insertmacro BKLabel 268 196 448 88 "" $BKFont $BKText $BKBorder
  StrCpy $BKScopeCurrentBorder $0
  ${NSD_OnClick} $0 BKScopeCurrentClick
  ${NSD_CreateRadioButton} 0 0 408 28 "为这台电脑的所有用户安装"
  Pop $BKAllUsers
  !insertmacro BKMove $BKAllUsers 286 311 408 28
  ${NSD_OnClick} $BKAllUsers BKScopeChanged
  !insertmacro BKLabel 307 345 385 24 "需要 Windows 管理员授权。" $BKSmallFont $BKMuted $BKSurface
  StrCpy $BKScopeAllDescription $0
  ${NSD_OnClick} $0 BKScopeAllClick
  !insertmacro BKLabel 269 297 446 86 "" $BKFont $BKText $BKSurface
  StrCpy $BKScopeAllPanel $0
  ${NSD_OnClick} $0 BKScopeAllClick
  !insertmacro BKLabel 268 296 448 88 "" $BKFont $BKText $BKBorder
  StrCpy $BKScopeAllBorder $0
  ${NSD_OnClick} $0 BKScopeAllClick
  ${If} $installMode == "all"
    ${NSD_Check} $BKAllUsers
  ${Else}
    ${NSD_Check} $BKCurrentUser
  ${EndIf}
  Push 0
  Call BKScopeChanged
  SendMessage $BKNext ${WM_SETTEXT} 0 "STR:继续  →"
  SendMessage $BKCancel ${WM_SETTEXT} 0 "STR:取消"
  SendMessage $BKBack ${WM_SETTEXT} 0 "STR:上一步"
  Call BKPrimary
  Call BKStartPageMotion
  nsDialogs::Show
  Call BKStopMotion
FunctionEnd

; Card backgrounds and descriptions select the same native radios, including
; focus; arrow keys and screen readers still operate on the original controls.
Function BKScopeCurrentClick
  Pop $0
  ${NSD_Check} $BKCurrentUser
  ${NSD_Uncheck} $BKAllUsers
  System::Call 'user32::SetFocus(p $BKCurrentUser)'
  Push 0
  Call BKScopeChanged
FunctionEnd

Function BKScopeAllClick
  Pop $0
  ${NSD_Check} $BKAllUsers
  ${NSD_Uncheck} $BKCurrentUser
  System::Call 'user32::SetFocus(p $BKAllUsers)'
  Push 0
  Call BKScopeChanged
FunctionEnd

Function BKScopeChanged
  Pop $0
  ; Checked state changes immediately for native keyboard and accessibility clients.
  ${If} $BKScopeReady != 1
    !insertmacro BKChoiceColors $BKCurrentUser $BKSurface
    !insertmacro BKChoiceColors $BKAllUsers $BKSurface
  ${EndIf}
  ${NSD_GetState} $BKAllUsers $0
  StrCpy $BKScopeTarget 0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $BKScopeTarget 8
  ${EndIf}
  Call BKMotionAllowed
  ${If} $BKScopeReady != 1
  ${OrIf} $BKMotionEnabled == 0
    StrCpy $BKScopePosition $BKScopeTarget
    Call BKPaintScopeMotion
  ${Else}
    ; Reversal starts at the current color, so rapid clicks never replay stale frames.
    GetFunctionAddress $0 BKScopeMotionTick
    nsDialogs::CreateTimer $0 20
  ${EndIf}
  StrCpy $BKScopeReady 1
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
  Call BKPrimary
FunctionEnd

Function BKPreparePage
  StrCpy $BKBusy 0
  StrCpy $BKStepText "02 / 安装设置"
  ${If} $BKExisting == 1
    StrCpy $INSTDIR $BKExistingPath
    StrCpy $BKStepText "01 / $BKAction准备"
  ${EndIf}
  Call BKCommonPage
  StrCpy $BKActionTitle "$BKAction BetterKuGou"
  ${If} $BKExisting == 1
    StrCpy $BKSubtitle "$BKOldVersion  →  ${VERSION}"
  ${Else}
    StrCpy $BKSubtitle "为喜欢的音乐，留一个位置。"
  ${EndIf}
  Call BKHeading
  ${If} $BKExisting == 1
    !insertmacro BKLabel 268 194 448 22 "此版本的新变化" $BKStrongFont $BKText $BKBg
    ; Borderless read-only text remains selectable and scrollable by keyboard.
    nsDialogs::CreateControl EDIT ${DEFAULT_STYLES}|${WS_TABSTOP}|${ES_MULTILINE}|${ES_AUTOVSCROLL}|${ES_READONLY}|${WS_VSCROLL} 0 0 0 1 1 "$BKNotes"
    Pop $0
    !insertmacro BKMove $0 282 230 420 94
    SendMessage $0 ${WM_SETFONT} $BKSmallFont 1
    !insertmacro BKSetColors $0 $BKText $BKSurface
    !insertmacro BKLabel 268 220 448 116 "" $BKFont $BKText $BKSurface
    !insertmacro BKLabel 268 346 448 20 "保留你的设置、主题与播放记录。" $BKSmallFont $BKAccent $BKBg
    !insertmacro BKLabel 268 374 448 38 "安装位置：$INSTDIR" $BKSmallFont $BKMuted $BKBg
    ${If} $BKAction == "重新安装"
      SendMessage $BKNext ${WM_SETTEXT} 0 "STR:重新安装"
    ${ElseIf} $BKAction == "降级"
      SendMessage $BKNext ${WM_SETTEXT} 0 "STR:继续降级…"
    ${Else}
      SendMessage $BKNext ${WM_SETTEXT} 0 "STR:立即更新  →"
    ${EndIf}
    SendMessage $BKCancel ${WM_SETTEXT} 0 "STR:暂不$BKAction"
  ${Else}
    !insertmacro BKLabel 268 194 448 22 "安装位置" $BKStrongFont $BKText $BKBg
    ; Keep a native editable path, with a deliberate padded surface around it.
    nsDialogs::CreateControl EDIT ${DEFAULT_STYLES}|${WS_TABSTOP}|${ES_AUTOHSCROLL} 0 0 0 1 1 "$INSTDIR"
    Pop $BKPathInput
    !insertmacro BKMove $BKPathInput 280 231 322 22
    SendMessage $BKPathInput ${WM_SETFONT} $BKFont 1
    !insertmacro BKSetColors $BKPathInput $BKText $BKSurface
    !insertmacro BKLabel 268 220 348 44 "" $BKFont $BKText $BKSurface
    ${NSD_CreateBrowseButton} 0 0 88 40 "浏览…"
    Pop $0
    !insertmacro BKMove $0 628 222 88 40
    StrCpy $BKButtonHandle $0
    ${NSD_OnClick} $0 BKBrowse
    StrCpy $BKButtonRole secondary
    Call BKPaintButton
    SectionGetSize 1 $BKRequired
    IntOp $BKRequired $BKRequired / 1024
    !insertmacro BKLabel 268 278 448 22 "版本 ${VERSION}  ·  约需 $BKRequired MB 空间" $BKSmallFont $BKMuted $BKBg
    ${NSD_CreateCheckbox} 0 0 448 28 "我已阅读并同意许可证与使用声明"
    Pop $BKLicense
    !insertmacro BKMove $BKLicense 268 330 448 28
    !insertmacro BKChoiceColors $BKLicense $BKBg
    ${NSD_OnClick} $BKLicense BKLicenseChanged
    ${NSD_CreateLink} 0 0 320 24 "查看许可证与使用声明  ↗"
    Pop $0
    !insertmacro BKMove $0 290 366 320 24
    SendMessage $0 ${WM_SETFONT} $BKSmallFont 1
    !insertmacro BKSetColors $0 $BKAccent $BKBg
    ${NSD_OnClick} $0 BKShowLicense
    SendMessage $BKNext ${WM_SETTEXT} 0 "STR:开始安装  →"
    SendMessage $BKCancel ${WM_SETTEXT} 0 "STR:取消"
    SendMessage $BKBack ${WM_SETTEXT} 0 "STR:← 上一步"
    EnableWindow $BKNext 0
    ${IfNot} ${UAC_IsInnerInstance}
      ShowWindow $BKBack 1
    ${EndIf}
  ${EndIf}
  Call BKPrimary
  Call BKStartPageMotion
  nsDialogs::Show
  Call BKStopMotion
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
  Call BKPrimary
  SendMessage $BKSubtitleControl ${WM_SETTEXT} 0 "STR:正在保存设置与播放进度，并等待应用退出…"
  System::Call 'user32::UpdateWindow(p $BKSubtitleControl)'
  Call BKCheckRunning
  ${If} $BKQuitFailed != 0
    EnableWindow $BKNext 1
    EnableWindow $BKCancel 1
    EnableWindow $BKClose 1
    Call BKPrimary
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
  Call BKStopMotion
  StrCpy $BKBusy 1
  StrCpy $BKStepText "03 / 正在安装"
  ${If} $BKExisting == 1
    StrCpy $BKStepText "02 / 正在$BKAction"
  ${EndIf}
  EnableWindow $BKCancel 0
  EnableWindow $BKBack 0
  ShowWindow $BKNext 0
  ShowWindow $BKCancel 0
  ShowWindow $BKBack 0
  ; MUI re-shows its stock separators for the extraction page.
  GetDlgItem $0 $HWNDPARENT 1035
  ShowWindow $0 0
  GetDlgItem $0 $HWNDPARENT 1036
  ShowWindow $0 0
  GetDlgItem $0 $HWNDPARENT 1045
  ShowWindow $0 0
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
  FindWindow $BKPage "#32770" "" $HWNDPARENT
  !insertmacro BKMove $BKPage 268 286 448 128
  SendMessage $BKPage ${WM_SETFONT} $BKFont 0
  StrCpy $BKProgressControls ""
  System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w "", i 0x5400000E, i 0, i 0, i 0, i 0, p $HWNDPARENT, p 0, p 0, p 0)p.r0'
  StrCpy $BKProgressControls "$BKProgressControls$0."
  !insertmacro BKMove $0 26 28 40 40
  Push $0
  Push $BKImage
  Call BKLoadLogo
  StrCpy $BKProgressImage $BKImage
  Pop $BKImage
  Pop $0
  SendMessage $0 ${STM_SETIMAGE} 0 $BKProgressImage
  !insertmacro BKBrand BKRootLabel
  !insertmacro BKRootLabel 268 70 448 22 "$BKStepText" $BKSmallFont $BKAccent $BKBg
  StrCpy $BKProgressStep $0
  !insertmacro BKRootLabel 266 98 452 42 "正在$BKAction" $BKTitleFont $BKText $BKBg
  StrCpy $BKProgressTitle $0
  !insertmacro BKRootLabel 268 145 448 44 "音乐即将就绪，请稍候。" $BKFont $BKMuted $BKBg
  StrCpy $BKProgressSubtitle $0
  StrCpy $BKAnimationParent $HWNDPARENT
  StrCpy $BKAnimationKind install
  Call BKCreateAnimation
  !insertmacro BKMove $BKInstallAnimation 268 194 448 76
  !insertmacro BKSetColors $BKPage $BKText $BKBg
  GetDlgItem $0 $BKPage 1006
  SendMessage $0 ${WM_SETTEXT} 0 "STR:正在写入 BetterKuGou 应用文件…"
  SendMessage $0 ${WM_SETFONT} $BKFont 1
  !insertmacro BKMove $0 0 0 448 32
  !insertmacro BKSetColors $0 $BKText $BKBg
  GetDlgItem $0 $BKPage 1004
  !insertmacro BKMove $0 0 44 448 8
  ${If} $BKHighContrast == 0
    System::Call 'uxtheme::SetWindowTheme(p r0, w "", w "")'
    Push $0
    IntOp $0 "0x$BKAccent" | 0
    Call BKColorRefToRgb
    Pop $4
    SendMessage $4 0x409 0 $0
    IntOp $0 "0x$BKBorder" | 0
    Call BKColorRefToRgb
    SendMessage $4 0x2001 0 $0
  ${EndIf}
  ; Keep failure details inside the available area even after SetDetailsView.
  GetDlgItem $0 $BKPage 1016
  !insertmacro BKMove $0 0 64 448 64
  SendMessage $0 ${WM_SETFONT} $BKSmallFont 1
  !insertmacro BKSetColors $0 $BKText $BKBg
  Push $0
  IntOp $0 "0x$BKBg" | 0
  Call BKColorRefToRgb
  Pop $4
  ; The detail control is a native ListView, which consumes LVM colors rather
  ; than relying solely on WM_CTLCOLOR for the failure-details background.
  SendMessage $4 0x1001 0 $0
  SendMessage $4 0x1026 0 $0
  IntOp $0 "0x$BKText" | 0
  Call BKColorRefToRgb
  SendMessage $4 0x1024 0 $0
  StrCpy $0 $4
  ShowWindow $0 0
  GetDlgItem $0 $BKPage 1027
  !insertmacro BKMove $0 0 64 124 28
  ShowWindow $0 0
FunctionEnd

; MUI calls InstFiles LEAVE as soon as its worker finishes, including Abort.
; .onInstFailed alone runs only after Cancel and cannot stop a failure loop.
Function BKProgressLeave
  Call BKStopAnimation
  IfAbort 0 bkProgressComplete
  StrCpy $BKBusy 0
  SendMessage $BKProgressStep ${WM_SETTEXT} 0 "STR:安装未完成"
  SendMessage $BKProgressBrandStep ${WM_SETTEXT} 0 "STR:安装未完成"
  SendMessage $BKProgressTitle ${WM_SETTEXT} 0 "STR:安装未完成"
  SendMessage $BKProgressSubtitle ${WM_SETTEXT} 0 "STR:请查看下方详情，关闭后可重新运行安装包。"
  EnableWindow $BKCancel 1
  ShowWindow $BKCancel 1
  SendMessage $BKCancel ${WM_SETTEXT} 0 "STR:关闭"
  !insertmacro BKButton $BKCancel quiet
  ; Failure details reclaim the decoration's space and remain scrollable.
  !insertmacro BKMove $BKPage 268 208 448 198
  GetDlgItem $0 $BKPage 1006
  !insertmacro BKMove $0 0 0 448 44
  GetDlgItem $0 $BKPage 1004
  !insertmacro BKMove $0 0 58 448 8
  GetDlgItem $0 $BKPage 1016
  !insertmacro BKMove $0 0 80 448 112
  SetDetailsView show
  bkProgressComplete:
FunctionEnd

Function .onInstFailed
  Call BKStopAnimation
  StrCpy $BKBusy 0
  EnableWindow $BKCancel 1
  ShowWindow $BKCancel 1
  SendMessage $BKCancel ${WM_SETTEXT} 0 "STR:关闭"
  !insertmacro BKButton $BKCancel quiet
  SetDetailsView show
  MessageBox MB_OK|MB_ICONEXCLAMATION "安装未完成。请查看安装详情，检查磁盘空间、目标文件夹权限及正在运行的 BetterKuGou，然后重新运行安装包。用户设置与播放记录会保留。"
FunctionEnd

Function .onGUIEnd
  Call BKStopMotion
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
  ${If} $BKCancelBitmap != ""
    System::Call 'gdi32::DeleteObject(p $BKCancelBitmap)'
  ${EndIf}
  ${If} $BKBackBitmap != ""
    System::Call 'gdi32::DeleteObject(p $BKBackBitmap)'
  ${EndIf}
  ${If} $BKCloseBitmap != ""
    System::Call 'gdi32::DeleteObject(p $BKCloseBitmap)'
  ${EndIf}
  ${If} $BKBrowseBitmap != ""
    System::Call 'gdi32::DeleteObject(p $BKBrowseBitmap)'
  ${EndIf}
  System::Call 'gdi32::DeleteObject(p $BKStrongFont)'
  System::Call 'gdi32::DeleteObject(p $BKFont)'
  System::Call 'gdi32::DeleteObject(p $BKTitleFont)'
  System::Call 'gdi32::DeleteObject(p $BKBrandFont)'
  System::Call 'gdi32::DeleteObject(p $BKSmallFont)'
FunctionEnd

Function BKFinishPage
  StrCpy $BKBusy 0
  StrCpy $BKStepText "04 / 安装完成"
  ${If} $BKExisting == 1
    StrCpy $BKStepText "03 / $BKAction完成"
  ${EndIf}
  ${If} $BKDone != 1
    StrCpy $BKStepText "安装未完成"
  ${EndIf}
  Call BKDestroyProgress
  Call BKCommonPage
  ${If} $BKDone == 1
    StrCpy $BKActionTitle "$BKAction完成"
    StrCpy $BKSubtitle "下一首喜欢的歌，在等你。"
  ${Else}
    StrCpy $BKActionTitle "安装未完成"
    StrCpy $BKSubtitle "请关闭程序后重新运行安装包。"
  ${EndIf}
  Call BKHeading
  ${If} $BKDone == 1
    StrCpy $BKAnimationParent $BKPage
    StrCpy $BKAnimationKind success
    Call BKCreateAnimation
    !insertmacro BKMove $BKInstallAnimation 620 214 80 80
  ${EndIf}
  !insertmacro BKLabel 286 217 320 26 "BetterKuGou" $BKStrongFont $BKText $BKSurface
  !insertmacro BKLabel 286 253 320 22 "${VERSION}  ·  Windows" $BKSmallFont $BKMuted $BKSurface
  !insertmacro BKLabel 286 289 412 50 "$INSTDIR" $BKSmallFont $BKMuted $BKSurface
  !insertmacro BKLabel 268 198 448 156 "" $BKFont $BKText $BKSurface
  !insertmacro BKLabel 268 374 448 22 "设置、主题和播放记录，继续陪伴你。" $BKSmallFont $BKMuted $BKBg
  SendMessage $BKNext ${WM_SETTEXT} 0 "STR:开始聆听  →"
  SendMessage $BKCancel ${WM_SETTEXT} 0 "STR:稍后再说"
  ${If} $BKDone != 1
    EnableWindow $BKNext 0
    SendMessage $BKCancel ${WM_SETTEXT} 0 "STR:关闭"
  ${EndIf}
  Call BKPrimary
  Call BKStartPageMotion
  nsDialogs::Show
  Call BKStopMotion
FunctionEnd

Function BKDestroyProgress
  Call BKStopAnimation
  StrCpy $BKTokenSource $BKProgressControls
  StrCpy $BKTokenNumber 1
  bkDestroyProgressLoop:
  Call BKReadIdentifier
  ${If} $BKToken == ""
    StrCpy $BKProgressControls ""
    ${If} $BKProgressImage != ""
      System::Call 'gdi32::DeleteObject(p $BKProgressImage)'
      StrCpy $BKProgressImage ""
    ${EndIf}
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
