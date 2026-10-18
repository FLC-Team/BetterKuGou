const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { createHash } = require('node:crypto')

const root = path.resolve(__dirname, '..')

function findCompiler() {
  const candidates = [process.env.BK_NSIS_COMPILER]
  if (process.env.NSISDIR) candidates.push(path.join(process.env.NSISDIR, 'Bin/makensis.exe'))
  const caches = [process.env.ELECTRON_BUILDER_CACHE,
    path.join(root, '.agent/tools/electron-builder-cache'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'electron-builder/Cache'),
    path.join(os.homedir(), 'AppData/Local/electron-builder/Cache')].filter(Boolean)
  for (const cache of new Set(caches)) {
    const directory = path.join(cache, 'nsis')
    if (!fs.existsSync(directory)) continue
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && /^nsis-/.test(entry.name)) candidates.push(path.join(directory, entry.name, 'Bin/makensis.exe'))
    }
  }
  return candidates.find(candidate => candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile())
}

function nsisString(value) {
  return String(value).replace(/\$/g, () => '$$').replace(/"/g, () => '$\\"')
}

/** Compile shipped UI functions, adding only a timer to the fixture's page loop. */
function uiSource() {
  const declarations = fs.readFileSync(path.join(root, 'installer/windows.nsh'), 'utf8').replace(/\r\n/g, '\n')
  const source = fs.readFileSync(path.join(root, 'installer/windows-functions.nsh'), 'utf8').replace(/\r\n/g, '\n')
  const available = new Map([...source.matchAll(/^Function (\w+)\n[\s\S]*?^FunctionEnd\b/gm)].map(match => [match[1], match[0]]))
  const names = ['BKGuiInit', 'BKColorRefToRgb', 'BKPrimary', 'BKPaintButton', 'BKCloseClick', 'BKDragClick',
    'BKCommonPage', 'BKLoadLogo', 'BKHeading', 'BKScopePage', 'BKScopeChanged',
    'BKScopeCurrentClick', 'BKScopeAllClick', 'BKLicenseChanged', 'BKProgressShow',
    'BKMotionAllowed', 'BKStopMotion', 'BKStartPageMotion', 'BKPageMotionTick', 'BKPaintScopeMotion', 'BKScopeMotionTick',
    'BKCreateAnimation', 'BKStopAnimation', 'BKStartSuccessAnimation', 'BKProgressLeave', 'BKDestroyProgress', 'BKReadIdentifier']
  const functions = names.map(name => {
    assert.ok(available.has(name), 'real installer defines ' + name)
    let body = available.get(name)
    assert.doesNotMatch(body, /^\s*(?:WriteReg\w*|DeleteReg\w*|Exec(?:Wait|Shell)?|Delete|RMDir|Rename|CopyFiles|CreateDirectory|FileOpen|FileWrite)\b/mi,
      'UI fixture must not inherit installation, registry mutation or launching code')
    if (name === 'BKScopePage') {
      assert.equal([...body.matchAll(/^  nsDialogs::Show$/gm)].length, 1)
      body = body.replace(/^  nsDialogs::Show$/m, '  HideWindow\n  GetFunctionAddress $0 ProbeScopeReady\n  nsDialogs::CreateTimer $0 20\n  nsDialogs::Show')
    }
    return body
  }).join('\n\n')
  const macros = [...source.matchAll(/^!macro (BK\w+)\b[\s\S]*?^!macroend\b/gm)].map(match => match[0]).join('\n\n')
  assert.match(macros, /^!macro BKSetColors\b/m, 'installer owns compile-time palette selection')
  const referenced = new Set([...(macros + functions).matchAll(/\$(BK\w+)\b/g)].map(match => match[1]))
  const variables = [...declarations.matchAll(/^Var (BK\w+)\s*$/gm)].filter(match => referenced.has(match[1])).map(match => match[0].trim())
  assert.equal(variables.length, referenced.size, 'UI variables come from actual installer')
  return variables.join('\n') + '\n' + macros + '\n' + functions
}

// Every HWND/HDC belongs to this fixture. No desktop capture, input simulation,
// installed application, registry write or real installation section is used.
const fixtureFunctions = String.raw`
Var ProbeReport
Var ProbeDC
Var ProbeSourceDC
Var ProbeContainer
Var ProbeName
Var ProbeControl
Var ProbeRect
Var ProbeClass
Var ProbeText
Var ProbeLeft
Var ProbeTop
Var ProbeRight
Var ProbeBottom
Var ProbeStyle
Var ProbeExtendedStyle
Var ProbeImage
Var ProbeForeground
Var ProbeBackground
Var ProbeIndex
Var ProbeBitmap
Var ProbeOldBitmap
Var ProbeX
Var ProbeY
Var ProbeBrightPixels
Var ProbeInvalidPixels
Var ProbeProgressBackdrop
Var installMode

Function ProbeDumpChildren
  System::Call 'user32::GetDC(p $HWNDPARENT)p.s'
  Pop $ProbeSourceDC
  System::Call 'gdi32::CreateCompatibleDC(p $ProbeSourceDC)p.s'
  Pop $ProbeDC
  System::Alloc 16
  Pop $ProbeRect
  StrCpy $ProbeIndex 0
  System::Call 'user32::GetWindow(p $ProbeContainer, i 5)p.s'
  Pop $ProbeControl
  probeChildLoop:
  @{If} $ProbeControl == 0
    Goto probeChildrenDone
  @{EndIf}
  System::Call 'user32::GetClassNameW(p $ProbeControl, w .r0, i @{NSIS_MAX_STRLEN})'
  StrCpy $ProbeClass $0
  System::Call 'user32::GetWindowTextW(p $ProbeControl, w .r0, i @{NSIS_MAX_STRLEN})'
  StrCpy $ProbeText $0
  System::Call 'user32::GetWindowRect(p $ProbeControl, p $ProbeRect)'
  System::Call 'user32::MapWindowPoints(p 0, p $ProbeContainer, p $ProbeRect, i 2)'
  System::Call '*$ProbeRect(i .r0, i .r1, i .r2, i .r3)'
  StrCpy $ProbeLeft $0
  StrCpy $ProbeTop $1
  StrCpy $ProbeRight $2
  StrCpy $ProbeBottom $3
  @{If} $ProbeName == progress
  @{AndIf} $ProbeClass == Static
  @{AndIf} $ProbeText == ""
  @{AndIf} $ProbeLeft == 224
  @{AndIf} $ProbeTop == 0
  @{AndIf} $ProbeRight == 760
  @{AndIf} $ProbeBottom == 500
    StrCpy $ProbeProgressBackdrop $ProbeControl
  @{EndIf}
  System::Call 'user32::GetWindowLongW(p $ProbeControl, i -16)i.s'
  Pop $ProbeStyle
  System::Call 'user32::GetWindowLongW(p $ProbeControl, i -20)i.s'
  Pop $ProbeExtendedStyle
  ; nsDialogs forwards these color messages to the actual NSIS engine.
  System::Call 'user32::SendMessageW(p $ProbeContainer, i 0x138, p $ProbeDC, p $ProbeControl)p.r0'
  System::Call 'gdi32::GetTextColor(p $ProbeDC)i.s'
  Pop $ProbeForeground
  System::Call 'gdi32::GetBkColor(p $ProbeDC)i.s'
  Pop $ProbeBackground
  StrCpy $ProbeImage 0
  @{If} $ProbeClass == STATIC
    IntOp $0 $ProbeStyle & 0x1F
    @{If} $0 == 14
      SendMessage $ProbeControl 0x173 0 0 $ProbeImage
    @{EndIf}
  @{EndIf}
  FileWriteUTF16LE $ProbeReport "$ProbeName.control=$ProbeIndex|$ProbeClass|$ProbeStyle|$ProbeLeft|$ProbeTop|$ProbeRight|$ProbeBottom|$ProbeImage|$ProbeForeground|$ProbeBackground|$ProbeExtendedStyle|$ProbeText$\r$\n"
  System::Call 'user32::GetWindow(p $ProbeControl, i 2)p.s'
  Pop $ProbeControl
  IntOp $ProbeIndex $ProbeIndex + 1
  Goto probeChildLoop
  probeChildrenDone:
  System::Free $ProbeRect
  System::Call 'gdi32::DeleteDC(p $ProbeDC)'
  System::Call 'user32::ReleaseDC(p $HWNDPARENT, p $ProbeSourceDC)'
FunctionEnd

; WM_PRINTCLIENT paints only our radio into a private offscreen bitmap. Sample
; beyond the selection circle to detect themed black text on dark backgrounds.
Function ProbeRadioContrast
  @{If} $BKDark != 1
  @{OrIf} $BKHighContrast != 0
    Return
  @{EndIf}
  System::Call 'user32::GetDC(p $HWNDPARENT)p.s'
  Pop $ProbeSourceDC
  System::Call 'gdi32::CreateCompatibleDC(p $ProbeSourceDC)p.s'
  Pop $ProbeDC
  System::Call 'gdi32::CreateCompatibleBitmap(p $ProbeSourceDC, i 408, i 32)p.s'
  Pop $ProbeBitmap
  System::Call 'gdi32::SelectObject(p $ProbeDC, p $ProbeBitmap)p.s'
  Pop $ProbeOldBitmap
  System::Alloc 16
  Pop $ProbeRect
  System::Call '*$ProbeRect(i 0, i 0, i 408, i 32)'
  System::Call 'gdi32::CreateSolidBrush(i 0x433039)p.r0'
  System::Call 'user32::FillRect(p $ProbeDC, p $ProbeRect, p r0)'
  System::Call 'gdi32::DeleteObject(p r0)'
  SendMessage $BKCurrentUser 0x318 $ProbeDC 0xC
  StrCpy $ProbeBrightPixels 0
  StrCpy $ProbeInvalidPixels 0
  StrCpy $ProbeY 6
  probePixelRow:
  StrCpy $ProbeX 28
  probePixelColumn:
  System::Call 'gdi32::GetPixel(p $ProbeDC, i $ProbeX, i $ProbeY)i.r0'
  @{If} $0 == -1
    IntOp $ProbeInvalidPixels $ProbeInvalidPixels + 1
  @{Else}
    IntOp $0 $0 & 0xFF
    @{If} $0 > 128
      IntOp $ProbeBrightPixels $ProbeBrightPixels + 1
    @{EndIf}
  @{EndIf}
  IntOp $ProbeX $ProbeX + 2
  @{If} $ProbeX < 380
    Goto probePixelColumn
  @{EndIf}
  IntOp $ProbeY $ProbeY + 2
  @{If} $ProbeY < 28
    Goto probePixelRow
  @{EndIf}
  FileWriteUTF16LE $ProbeReport "scope.radioBrightPixels=$ProbeBrightPixels$\r$\n"
  FileWriteUTF16LE $ProbeReport "scope.radioInvalidPixels=$ProbeInvalidPixels$\r$\n"
  System::Free $ProbeRect
  System::Call 'gdi32::SelectObject(p $ProbeDC, p $ProbeOldBitmap)'
  System::Call 'gdi32::DeleteObject(p $ProbeBitmap)'
  System::Call 'gdi32::DeleteDC(p $ProbeDC)'
  System::Call 'user32::ReleaseDC(p $HWNDPARENT, p $ProbeSourceDC)'
FunctionEnd

; Paint the real title into a private bitmap. A declared label/font alone would
; miss transparent-static regressions which erase all visible heading text.
Function ProbeTitleContrast
  System::Call 'user32::GetDC(p $HWNDPARENT)p.s'
  Pop $ProbeSourceDC
  System::Call 'gdi32::CreateCompatibleDC(p $ProbeSourceDC)p.s'
  Pop $ProbeDC
  System::Call 'gdi32::CreateCompatibleBitmap(p $ProbeSourceDC, i 452, i 42)p.s'
  Pop $ProbeBitmap
  System::Call 'gdi32::SelectObject(p $ProbeDC, p $ProbeBitmap)p.s'
  Pop $ProbeOldBitmap
  System::Alloc 16
  Pop $ProbeRect
  System::Call '*$ProbeRect(i 0, i 0, i 452, i 42)'
  @{If} $BKDark == 1
    System::Call 'gdi32::CreateSolidBrush(i 0)p.r0'
  @{Else}
    System::Call 'gdi32::CreateSolidBrush(i 0xFFFFFF)p.r0'
  @{EndIf}
  System::Call 'user32::FillRect(p $ProbeDC, p $ProbeRect, p r0)'
  System::Call 'gdi32::DeleteObject(p r0)'
  SendMessage $BKTitle 0x318 $ProbeDC 0xC
  StrCpy $ProbeBrightPixels 0
  StrCpy $ProbeY 4
  probeTitleRow:
  StrCpy $ProbeX 2
  probeTitleColumn:
  System::Call 'gdi32::GetPixel(p $ProbeDC, i $ProbeX, i $ProbeY)i.r0'
  IntOp $0 $0 & 0xFF
  @{If} $BKDark == 1
  @{AndIf} $0 > 128
    IntOp $ProbeBrightPixels $ProbeBrightPixels + 1
  @{ElseIf} $BKDark != 1
  @{AndIf} $0 < 128
    IntOp $ProbeBrightPixels $ProbeBrightPixels + 1
  @{EndIf}
  IntOp $ProbeX $ProbeX + 2
  @{If} $ProbeX < 400
    Goto probeTitleColumn
  @{EndIf}
  IntOp $ProbeY $ProbeY + 2
  @{If} $ProbeY < 40
    Goto probeTitleRow
  @{EndIf}
  FileWriteUTF16LE $ProbeReport "scope.titleTextPixels=$ProbeBrightPixels$\r$\n"
  System::Free $ProbeRect
  System::Call 'gdi32::SelectObject(p $ProbeDC, p $ProbeOldBitmap)'
  System::Call 'gdi32::DeleteObject(p $ProbeBitmap)'
  System::Call 'gdi32::DeleteDC(p $ProbeDC)'
  System::Call 'user32::ReleaseDC(p $HWNDPARENT, p $ProbeSourceDC)'
FunctionEnd

Function ProbeScopeReady
  GetFunctionAddress $0 ProbeScopeReady
  nsDialogs::KillTimer $0
  HideWindow
  StrCpy $ProbeContainer $BKPage
  StrCpy $ProbeName scope
  Call ProbeDumpChildren
  GetDlgItem $0 $HWNDPARENT 1036
  System::Call 'user32::GetWindowLongW(p r0, i -16)i.r1'
  IntOp $1 $1 & 0x10000000
  FileWriteUTF16LE $ProbeReport "scope.stockHeaderVisible=$1$\r$\n"
  Call ProbeRadioContrast
  @{If} $BKHighContrast == 0
    Call ProbeTitleContrast
  @{EndIf}
  ; Direct clicks target only this fixture's own native controls and callbacks.
  Push 0
  Call BKScopeAllClick
  SendMessage $BKAllUsers 0xF0 0 0 $0
  FileWriteUTF16LE $ProbeReport "scope.allChecked=$0$\r$\n"
  SendMessage $BKCurrentUser 0xF0 0 0 $0
  FileWriteUTF16LE $ProbeReport "scope.currentUnchecked=$0$\r$\n"
  Push 0
  Call BKScopeCurrentClick
  SendMessage $BKCurrentUser 0xF0 0 0 $0
  FileWriteUTF16LE $ProbeReport "scope.currentChecked=$0$\r$\n"
  SendMessage $BKAllUsers 0xF0 0 0 $0
  FileWriteUTF16LE $ProbeReport "scope.allUnchecked=$0$\r$\n"
  ; BM_CLICK follows the native radio's notification path, as keyboard and
  ; accessibility activation do, rather than calling the card wrapper.
  SendMessage $BKAllUsers 0xF5 0 0
  SendMessage $BKAllUsers 0xF0 0 0 $0
  FileWriteUTF16LE $ProbeReport "scope.nativeAllChecked=$0$\r$\n"
  SendMessage $BKCurrentUser 0xF0 0 0 $0
  FileWriteUTF16LE $ProbeReport "scope.nativeCurrentUnchecked=$0$\r$\n"
  SendMessage $BKCurrentUser 0x31 0 0 $0
  System::Alloc 92
  Pop $ProbeRect
  System::Call 'gdi32::GetObjectW(p r0, i 92, p $ProbeRect)'
  IntOp $0 $ProbeRect + 28
  System::Call '*$0(&w32 .r1)'
  FileWriteUTF16LE $ProbeReport "scope.fontFace=$1$\r$\n"
  System::Free $ProbeRect
  ; Drive real color ticks without sleeping or changing Windows preferences.
  Call BKMotionAllowed
  FileWriteUTF16LE $ProbeReport "motion.allowed=$BKMotionEnabled$\r$\n"
  StrCpy $BKScopePosition 0
  StrCpy $BKScopeTarget 8
  Call BKPaintScopeMotion
  Call BKScopeMotionTick
  FileWriteUTF16LE $ProbeReport "motion.firstPosition=$BKScopePosition$\r$\n"
  ; Inspect the actual interpolated native surface, not just the numeric step.
  StrCpy $ProbeLeft $BKScopePosition
  StrCpy $BKScopePosition 4
  Call BKPaintScopeMotion
  System::Call 'user32::GetDC(p $HWNDPARENT)p.s'
  Pop $ProbeDC
  SendMessage $BKPage 0x138 $ProbeDC $BKScopeAllPanel
  System::Call 'gdi32::GetBkColor(p $ProbeDC)i.r0'
  FileWriteUTF16LE $ProbeReport "motion.midSurface=$0$\r$\n"
  System::Call 'user32::ReleaseDC(p $HWNDPARENT, p $ProbeDC)'
  StrCpy $BKScopePosition $ProbeLeft
  Call BKPaintScopeMotion
  ; Reverse while in flight, then complete exactly at the latest target.
  StrCpy $BKScopeTarget 0
  Call BKScopeMotionTick
  FileWriteUTF16LE $ProbeReport "motion.reversedPosition=$BKScopePosition$\r$\n"
  StrCpy $ProbeStyle $BKHighContrast
  StrCpy $BKHighContrast 1
  StrCpy $BKScopeTarget 8
  Call BKScopeMotionTick
  FileWriteUTF16LE $ProbeReport "motion.highContrastPosition=$BKScopePosition$\r$\n"
  FileWriteUTF16LE $ProbeReport "motion.highContrastEnabled=$BKMotionEnabled$\r$\n"
  StrCpy $BKHighContrast $ProbeStyle
  Call BKStopMotion
  FileWriteUTF16LE $ProbeReport "motion.pageAfterStop=$BKPageMotionPage$\r$\n"
  ; Exercise the real consent handler without opening files or installing.
  @{NSD_CreateCheckbox} 0 0 1 1 "Fixture license consent"
  Pop $BKLicense
  @{NSD_Check} $BKLicense
  Push 0
  Call BKLicenseChanged
  System::Call 'user32::IsWindowEnabled(p $BKNext)i.r0'
  FileWriteUTF16LE $ProbeReport "license.acceptedEnabled=$0$\r$\n"
  SendMessage $BKNext 0xF6 0 0 $ProbeImage
  @{NSD_Uncheck} $BKLicense
  Push 0
  Call BKLicenseChanged
  System::Call 'user32::IsWindowEnabled(p $BKNext)i.r0'
  FileWriteUTF16LE $ProbeReport "license.uncheckedEnabled=$0$\r$\n"
  SendMessage $BKNext 0xF6 0 0 $0
  StrCpy $ProbeStyle 0
  @{If} $0 != $ProbeImage
    StrCpy $ProbeStyle 1
  @{EndIf}
  FileWriteUTF16LE $ProbeReport "license.bitmapChanged=$ProbeStyle$\r$\n"
  System::Call 'user32::GetWindowTextW(p $BKNext, w .r0, i @{NSIS_MAX_STRLEN})'
  FileWriteUTF16LE $ProbeReport "license.accessibleCaption=$0$\r$\n"
  @{NSD_Check} $BKLicense
  Push 0
  Call BKLicenseChanged
  ; Pump a separate timer after stop to expose any stale scope timer callback.
  StrCpy $BKScopePosition 0
  StrCpy $BKScopeTarget 8
  GetFunctionAddress $0 ProbeAfterMotionStop
  nsDialogs::CreateTimer $0 40
FunctionEnd

Function ProbeAfterMotionStop
  GetFunctionAddress $0 ProbeAfterMotionStop
  nsDialogs::KillTimer $0
  FileWriteUTF16LE $ProbeReport "motion.positionAfterStoppedLoop=$BKScopePosition$\r$\n"
  ; Advance only this test fixture's empty install page.
  SendMessage $HWNDPARENT @{WM_COMMAND} 1 0
FunctionEnd

Function ProbeProgressReady
  HideWindow
  Call BKProgressShow
  ; Model a host dialog repaint independently of its explicitly colored child
  ; controls. Only this fixture's own HWND receives the contrasting palette.
  SetCtlColors $HWNDPARENT FFFFFF 000000
  StrCpy $ProbeContainer $HWNDPARENT
  StrCpy $ProbeName progress
  Call ProbeDumpChildren
  GetDlgItem $0 $HWNDPARENT 1036
  System::Call 'user32::GetWindowLongW(p r0, i -16)i.r1'
  IntOp $1 $1 & 0x10000000
  FileWriteUTF16LE $ProbeReport "progress.stockHeaderVisible=$1$\r$\n"
  Call ProbeProgressSurface
  Call BKDestroyProgress
  System::Call 'user32::IsWindow(p $ProbeProgressBackdrop)i.r0'
  FileWriteUTF16LE $ProbeReport "progress.backdropExistsAfterCleanup=$0$\r$\n"
  FileWriteUTF16LE $ProbeReport "progress.controlsAfterCleanup=$BKProgressControls$\r$\n"
FunctionEnd

; Render the complete owned window, so a WM_CTLCOLOR declaration alone cannot
; conceal a host-colored gap behind the progress labels or footer.
Function ProbeProgressSurface
  ; Keep the owned dialog offscreen but logically visible: Windows otherwise
  ; omits its hidden child windows from PrintWindow's complete-window output.
  ShowWindow $HWNDPARENT 4
  System::Call 'user32::RedrawWindow(p $HWNDPARENT, p 0, p 0, i 0x185)'
  System::Call 'user32::GetDC(p $HWNDPARENT)p.s'
  Pop $ProbeSourceDC
  System::Call 'gdi32::CreateCompatibleDC(p $ProbeSourceDC)p.s'
  Pop $ProbeDC
  System::Call 'gdi32::CreateCompatibleBitmap(p $ProbeSourceDC, i 760, i 500)p.s'
  Pop $ProbeBitmap
  System::Call 'gdi32::SelectObject(p $ProbeDC, p $ProbeBitmap)p.s'
  Pop $ProbeOldBitmap
  System::Call 'user32::PrintWindow(p $HWNDPARENT, p $ProbeDC, i 0)i.r0'
  FileWriteUTF16LE $ProbeReport "progress.surfaceRendered=$0$\r$\n"
  System::Call 'gdi32::GetPixel(p $ProbeDC, i 744, i 200)i.r0'
  FileWriteUTF16LE $ProbeReport "progress.rightBackground=$0$\r$\n"
  System::Call 'gdi32::GetPixel(p $ProbeDC, i 744, i 470)i.r0'
  FileWriteUTF16LE $ProbeReport "progress.footerBackground=$0$\r$\n"
  System::Call 'gdi32::SelectObject(p $ProbeDC, p $ProbeOldBitmap)'
  System::Call 'gdi32::DeleteObject(p $ProbeBitmap)'
  System::Call 'gdi32::DeleteDC(p $ProbeDC)'
  System::Call 'user32::ReleaseDC(p $HWNDPARENT, p $ProbeSourceDC)'
  HideWindow
FunctionEnd
`.replaceAll('@{', '${')

// These probes use genuine InstFiles extraction and Abort. Pixel sampling runs
// serially on the install worker, never from a callback alongside NSIS bytecode.
const nativeMotionFunctions = String.raw`
Var BKDone
Var ProbeFrameHash
Var ProbePreviousHash
Var ProbeStart
Var ProbeAnimatedWindow
Var ProbeSuccessInitial
Var ProbeFrameSequence
Var ProbeFrameBytes
Var ProbePixels
Var ProbePixelFile
Var ProbeCaptureValid
Var ProbeOriginX
Var ProbeOriginY

Function ProbeAnimationFrame
  StrCpy $ProbeFrameHash 0
  @{If} $BKInstallAnimation == ""
    Return
  @{EndIf}
  IntOp $ProbeFrameSequence $ProbeFrameSequence + 1
  System::Call 'user32::GetDC(p $BKInstallAnimation)p.s'
  Pop $ProbeSourceDC
  System::Call 'gdi32::CreateCompatibleDC(p $ProbeSourceDC)p.s'
  Pop $ProbeDC
  System::Alloc 40
  Pop $ProbeRect
  System::Call 'user32::GetClientRect(p $BKInstallAnimation, p $ProbeRect)'
  System::Call '*$ProbeRect(i, i, i .r0, i .r1)'
  StrCpy $ProbeRight $0
  StrCpy $ProbeBottom $1
  IntOp $ProbeFrameBytes $ProbeRight * $ProbeBottom
  IntOp $ProbeFrameBytes $ProbeFrameBytes * 4
  System::Call '*$ProbeRect(i 40, i $ProbeRight, i $ProbeBottom, &i2 1, &i2 32, i 0, i $ProbeFrameBytes, i 0, i 0, i 0, i 0)'
  System::Call 'gdi32::CreateCompatibleBitmap(p $ProbeSourceDC, i $ProbeRight, i $ProbeBottom)p.s'
  Pop $ProbeBitmap
  System::Call 'gdi32::SelectObject(p $ProbeDC, p $ProbeBitmap)p.s'
  Pop $ProbeOldBitmap
  System::Call 'gdi32::PatBlt(p $ProbeDC, i 0, i 0, i $ProbeRight, i $ProbeBottom, i 0x42)'
  System::Call 'user32::PrintWindow(p $BKInstallAnimation, p $ProbeDC, i 1)i.r0'
  StrCpy $ProbeCaptureValid $0
  System::Call 'gdi32::SelectObject(p $ProbeDC, p $ProbeOldBitmap)'
  System::Alloc $ProbeFrameBytes
  Pop $ProbePixels
  System::Call 'gdi32::GetDIBits(p $ProbeDC, p $ProbeBitmap, i 0, i $ProbeBottom, p $ProbePixels, p $ProbeRect, i 0)i.r0'
  @{If} $0 != $ProbeBottom
    StrCpy $ProbeCaptureValid 0
  @{EndIf}
  @{If} $ProbeCaptureValid != 0
  StrCpy $ProbeFrameHash "$EXEFILE.frame-$ProbeFrameSequence.bin"
  System::Call 'kernel32::CreateFileW(w "$EXEDIR\$ProbeFrameHash", i 0x40000000, i 0, p 0, i 2, i 0, p 0)p.s'
  Pop $ProbePixelFile
  System::Call 'kernel32::WriteFile(p $ProbePixelFile, p $ProbePixels, i $ProbeFrameBytes, *i .r0, p 0)i.r1'
  @{If} $1 == 0
  @{OrIf} $0 != $ProbeFrameBytes
    StrCpy $ProbeFrameHash "capture-failed"
  @{EndIf}
  System::Call 'kernel32::CloseHandle(p $ProbePixelFile)'
  @{Else}
    StrCpy $ProbeFrameHash "capture-failed"
  @{EndIf}
  System::Free $ProbePixels
  System::Free $ProbeRect
  System::Call 'gdi32::DeleteObject(p $ProbeBitmap)'
  System::Call 'gdi32::DeleteDC(p $ProbeDC)'
  System::Call 'user32::ReleaseDC(p $BKInstallAnimation, p $ProbeSourceDC)'
FunctionEnd

Function ProbeMotionReady
  HideWindow
  ; Show only this non-activating fixture, so Windows does not suppress the
  ; native animation as it can for wholly clipped or hidden windows.
  ShowWindow $HWNDPARENT 4
  Call BKProgressShow
  FileWriteUTF16LE $ProbeReport "native.hwnd=$BKInstallAnimation$\r$\n"
  StrCpy $ProbeAnimatedWindow $BKInstallAnimation
  SendMessage $BKInstallAnimation 0x468 0 0 $0
  FileWriteUTF16LE $ProbeReport "native.installPlaying=$0$\r$\n"
  FileWriteUTF16LE $ProbeReport "native.dpi=$BKAnimationDpi$\r$\n"
FunctionEnd

Function ProbeMotionLeave
  Call BKProgressLeave
  FileWriteUTF16LE $ProbeReport "native.afterLeave=$BKInstallAnimation$\r$\n"
  System::Call 'user32::IsWindow(p $ProbeAnimatedWindow)i.r0'
  FileWriteUTF16LE $ProbeReport "native.destroyed=$0$\r$\n"
  IfAbort 0 probeMotionSucceeded
  System::Call 'user32::IsWindowEnabled(p $BKCancel)i.r0'
  FileWriteUTF16LE $ProbeReport "native.failureCloseEnabled=$0$\r$\n"
  System::Call 'user32::GetWindowLongW(p $BKCancel, i -16)i.r0'
  IntOp $0 $0 & 0x10000000
  FileWriteUTF16LE $ProbeReport "native.failureCloseVisible=$0$\r$\n"
  System::Call 'user32::GetWindowTextW(p $BKProgressTitle, w .r0, i @{NSIS_MAX_STRLEN})'
  FileWriteUTF16LE $ProbeReport "native.failureTitle=$0$\r$\n"
  System::Call 'user32::GetWindowTextW(p $BKProgressStep, w .r0, i @{NSIS_MAX_STRLEN})'
  FileWriteUTF16LE $ProbeReport "native.failureStep=$0$\r$\n"
  System::Call 'user32::GetWindowTextW(p $BKProgressBrandStep, w .r0, i @{NSIS_MAX_STRLEN})'
  FileWriteUTF16LE $ProbeReport "native.failureBrandStep=$0$\r$\n"
  FileWriteUTF16LE $ProbeReport "native.finished=1$\r$\n"
  FileClose $ProbeReport
  SetErrorLevel 0
  Quit
  probeMotionSucceeded:
FunctionEnd

Function ProbeSuccessPage
  StrCpy $BKBusy 0
  Call BKCommonPage
  StrCpy $BKAnimationParent $BKPage
  StrCpy $BKAnimationKind success
  Call BKCreateAnimation
  !insertmacro BKMove $BKInstallAnimation 620 214 80 80
  Call ProbeAnimationFrame
  StrCpy $ProbeSuccessInitial $ProbeFrameHash
  GetFunctionAddress $0 ProbeSuccessPlaying
  nsDialogs::CreateTimer $0 80
  GetFunctionAddress $0 ProbeSuccessDone
  nsDialogs::CreateTimer $0 1250
  nsDialogs::Show
FunctionEnd

Function ProbeSuccessPlaying
  GetFunctionAddress $0 ProbeSuccessPlaying
  nsDialogs::KillTimer $0
  SendMessage $BKInstallAnimation 0x468 0 0 $0
  FileWriteUTF16LE $ProbeReport "native.successPlaying=$0$\r$\n"
  FileWriteUTF16LE $ProbeReport "native.successPending=$BKSuccessMotionPage$\r$\n"
FunctionEnd

Function ProbeSuccessDone
  GetFunctionAddress $0 ProbeSuccessDone
  nsDialogs::KillTimer $0
  SendMessage $BKInstallAnimation 0x468 0 0 $0
  FileWriteUTF16LE $ProbeReport "native.successStopped=$0$\r$\n"
  Call ProbeAnimationFrame
  FileWriteUTF16LE $ProbeReport "native.successInitial=$ProbeSuccessInitial$\r$\n"
  FileWriteUTF16LE $ProbeReport "native.successFinal=$ProbeFrameHash$\r$\n"
  StrCpy $ProbeAnimatedWindow $BKInstallAnimation
  Call BKStopMotion
  System::Call 'user32::IsWindow(p $ProbeAnimatedWindow)i.r0'
  FileWriteUTF16LE $ProbeReport "native.successDestroyed=$0$\r$\n"
  ; An absent clip degrades to the native title/progress, without a dangling HWND.
  StrCpy $BKAnimationKind deliberately-missing-fixture
  Call BKCreateAnimation
  FileWriteUTF16LE $ProbeReport "native.missingClip=$BKInstallAnimation$\r$\n"
  FileWriteUTF16LE $ProbeReport "native.finished=1$\r$\n"
  FileClose $ProbeReport
  SetErrorLevel 0
  SendMessage $HWNDPARENT @{WM_COMMAND} 1 0
FunctionEnd
`.replaceAll('@{', '${')

function fixtureSource(theme, executable, report) {
  const dark = theme === 'dark' ? 1 : 0
  const highContrast = theme === 'high-contrast' ? 1 : 0
  return [
    'Unicode true', 'RequestExecutionLevel user', 'XPStyle on',
    'Name "BetterKuGou hidden native UI regression probe"', 'OutFile "' + nsisString(executable) + '"',
    '!include MUI2.nsh', '!include nsDialogs.nsh', '!include LogicLib.nsh', '!include WinMessages.nsh',
    '!define VERSION "0.0.0-ui-probe"', '!define UAC_IsInnerInstance \'"0" == "1"\'',
    '!define MUI_CUSTOMFUNCTION_GUIINIT ProbeInit',
    'Page custom BKScopePage', '!define MUI_PAGE_CUSTOMFUNCTION_SHOW ProbeProgressReady',
    '!insertmacro MUI_PAGE_INSTFILES', '!insertmacro MUI_LANGUAGE "SimpChinese"',
    uiSource(), fixtureFunctions,
    'Function ProbeInit', '  Call BKGuiInit', '  HideWindow',
    "  System::Call 'user32::GetWindowLongW(p $HWNDPARENT, i -20)i.r0'",
    '  IntOp $0 $0 | 0x08000000',
    "  System::Call 'user32::SetWindowLongW(p $HWNDPARENT, i -20, i r0)'",
    "  System::Call 'user32::SetWindowPos(p $HWNDPARENT, p 0, i -32000, i -32000, i 0, i 0, i 0x15)'",
    '  StrCpy $BKScale 96', '  StrCpy $BKDark ' + dark, '  StrCpy $BKHighContrast ' + highContrast,
    '  StrCpy $BKBg ' + (dark ? '211F24' : 'FCFAF7'), '  StrCpy $BKBrandBg ' + (dark ? '29252E' : 'F1ECF4'),
    '  StrCpy $BKSurface ' + (dark ? '2C2832' : 'FFFFFF'), '  StrCpy $BKSelected ' + (dark ? '393043' : 'F1EAF7'),
    '  StrCpy $BKBorder ' + (dark ? '47404F' : 'E6E0E9'), '  StrCpy $BKAccent ' + (dark ? 'C8B2DE' : '775F8F'),
    '  StrCpy $BKText ' + (dark ? 'F5F1F7' : '28242C'), '  StrCpy $BKMuted ' + (dark ? 'B5ACBD' : '756D7A'),
    '  !insertmacro BKSetColors $HWNDPARENT $BKText $BKBg',
    '  StrCpy $BKExisting 0', '  StrCpy $installMode current', '  StrCpy $BKAction "安装"',
    '  InitPluginsDir',
    '  File /oname=$PLUGINSDIR\\bk-logo-light.bmp "' + nsisString(path.join(root, 'installer/assets/logo-light.bmp')) + '"',
    '  File /oname=$PLUGINSDIR\\bk-logo-dark.bmp "' + nsisString(path.join(root, 'installer/assets/logo-dark.bmp')) + '"',
    ...['install', 'success'].flatMap(kind => ['light', 'dark'].map(color =>
      '  File /oname=$PLUGINSDIR\\' + kind + '-' + color + '-96.avi "' + nsisString(path.join(root, 'installer/assets/' + kind + '-' + color + '-96.avi')) + '"')),
    '  FileOpen $ProbeReport "' + nsisString(report) + '" w',
    "  System::Call 'user32::GetSysColor(i 8)i.r0'", '  FileWriteUTF16LE $ProbeReport "system.text=$0$\\r$\\n"',
    "  System::Call 'user32::GetSysColor(i 5)i.r0'", '  FileWriteUTF16LE $ProbeReport "system.background=$0$\\r$\\n"',
    'FunctionEnd', 'Section',
    '  FileWriteUTF16LE $ProbeReport "finished=1$\\r$\\n"', '  FileClose $ProbeReport',
    '  SetErrorLevel 0', '  Quit', 'SectionEnd', ''
  ].join('\n')
}

function motionFixtureSource({ theme, dpi, reduced, fail }, executable, report, payload) {
  const source = fixtureSource(theme, executable, report)
    .replace('Page custom BKScopePage\n', '')
    .replace('!define MUI_PAGE_CUSTOMFUNCTION_SHOW ProbeProgressReady',
      '!define MUI_PAGE_CUSTOMFUNCTION_SHOW ProbeMotionReady\n!define MUI_PAGE_CUSTOMFUNCTION_LEAVE ProbeMotionLeave')
    .replace('!insertmacro MUI_PAGE_INSTFILES\n', '!insertmacro MUI_PAGE_INSTFILES\nPage custom ProbeSuccessPage\n')
    .replace("i -32000, i -32000, i 0, i 0, i 0x15)", "i 64, i 64, i 0, i 0, i 0x15)")
    .replace(/^  StrCpy \$BKScale 96$/m, [
      '  StrCpy $BKScale ' + dpi,
      '  IntOp $BKWidth 760 * $BKScale', '  IntOp $BKWidth $BKWidth / 96',
      '  IntOp $BKHeight 500 * $BKScale', '  IntOp $BKHeight $BKHeight / 96',
      "  System::Call 'user32::SetWindowPos(p $HWNDPARENT, p 0, i 64, i 64, i $BKWidth, i $BKHeight, i 0x14)'"
    ].join('\n'))
    // Replace only the preference query; no machine setting is changed. All
    // creation, native playback, seek, stop and teardown code stays production.
    .replace("System::Call 'user32::SystemParametersInfoW(i 0x1042, i 0, *i .r0, i 0)i.s'",
      'StrCpy $0 ' + Number(!reduced) + '\n    Push 1')
    .replace('Function ProbeInit\n', nativeMotionFunctions + '\nFunction ProbeInit\n')
    .replace('  FileOpen $ProbeReport',
      ['install', 'success'].flatMap(kind => ['light', 'dark'].map(color =>
        '  File /oname=$PLUGINSDIR\\' + kind + '-' + color + '-' + dpi + '.avi "' + nsisString(path.join(root, 'installer/assets/' + kind + '-' + color + '-' + dpi + '.avi')) + '"')).join('\n') + '\n  FileOpen $ProbeReport')
    .replace(/FunctionEnd\nSection\n[\s\S]*$/, [
      'FunctionEnd', 'Section', '  SetOutPath $PLUGINSDIR',
      '  Call ProbeAnimationFrame', '  StrCpy $ProbePreviousHash $ProbeFrameHash',
      "  System::Call 'kernel32::GetTickCount()i.s'", '  Pop $ProbeStart',
      ...Array.from({ length: 4 }, () => '  File /oname=native-motion-payload.bin "' + nsisString(payload) + '"'),
      "  System::Call 'kernel32::GetTickCount()i.r0'", '  IntOp $0 $0 - $ProbeStart',
      '  FileWriteUTF16LE $ProbeReport "native.extractMs=$0$\\r$\\n"',
      '  Call ProbeAnimationFrame', '  FileWriteUTF16LE $ProbeReport "native.beforeExtract=$ProbePreviousHash$\\r$\\n"',
      '  FileWriteUTF16LE $ProbeReport "native.afterExtract=$ProbeFrameHash$\\r$\\n"',
      fail ? '  Abort "Intentional own-fixture extraction failure"' : '  StrCpy $BKDone 1',
      'SectionEnd', ''
    ].join('\n'))
  return source
}

function parseReport(output) {
  const values = new Map()
  const controls = { scope: [], progress: [] }
  for (const line of output.split(/\r?\n/)) {
    const separator = line.indexOf('=')
    if (separator === -1) continue
    const key = line.slice(0, separator)
    const value = line.slice(separator + 1)
    const page = /^(scope|progress)\.control$/.exec(key)?.[1]
    if (!page) { values.set(key, value); continue }
    const [index, className, style, left, top, right, bottom, image, foreground, background, extendedStyle, ...text] = value.split('|')
    controls[page].push({ index: Number(index), className, style: Number(style) >>> 0,
      left: Number(left), top: Number(top), width: Number(right) - Number(left), height: Number(bottom) - Number(top),
      image: Number(image), foreground: Number(foreground), background: Number(background), extendedStyle: Number(extendedStyle) >>> 0, text: text.join('|') })
  }
  return { values, controls }
}

function colorRef(rgb) {
  const value = Number.parseInt(rgb, 16)
  return ((value & 0xFF) << 16) | (value & 0xFF00) | ((value >> 16) & 0xFF)
}

function assertPage(controls, theme, values, page) {
  const palette = theme === 'high-contrast'
    ? { text: Number(values.get('system.text')), muted: Number(values.get('system.text')), background: Number(values.get('system.background')), brand: Number(values.get('system.background')) }
    : theme === 'dark'
      ? { text: colorRef('F5F1F7'), muted: colorRef('B5ACBD'), background: colorRef('211F24'), brand: colorRef('29252E') }
      : { text: colorRef('28242C'), muted: colorRef('756D7A'), background: colorRef('FCFAF7'), brand: colorRef('F1ECF4') }
  const backdrop = controls.find(control => control.className === 'Static' && !control.text && control.left === 0 && control.top === 0 && control.width === 224 && control.height === 500)
  const logo = controls.find(control => control.className === 'Static' && (control.style & 0x1F) === 14 && control.left === 26 && control.top === 28)
  const brand = controls.find(control => control.text === 'BetterKuGou')
  const heading = controls.find(control => control.left === 266 && control.top === 98 && control.width === 452)
  const subtitle = controls.find(control => control.left === 268 && control.top === 145)
  for (const [name, control] of Object.entries({ backdrop, logo, brand, heading, subtitle })) assert.ok(control, page + ': ' + name + ' exists')
  assert.ok(logo.image !== 0, page + ': real logo bitmap loaded')
  assert.ok(backdrop.index > logo.index && backdrop.index > brand.index, page + ': backdrop is below the logo and brand in native Z order')
  assert.ok(backdrop.style & 0x04000000, page + ': backdrop clips overlapping foreground siblings')
  assert.equal(backdrop.background, palette.brand, page + ': brand background')
  assert.equal(brand.foreground, palette.text, page + ': visible brand text')
  assert.equal(brand.background, palette.brand, page + ': brand text background')
  assert.equal(heading.foreground, palette.text, page + ': visible heading')
  assert.equal(heading.background, palette.background, page + ': main background')
  assert.equal(heading.extendedStyle & 0x20, 0, page + ': heading uses opaque native static rendering')
  assert.equal(backdrop.extendedStyle & 0x20, 0, page + ': brand backdrop uses opaque native static rendering')
  assert.equal(subtitle.foreground, palette.muted, page + ': visible muted text')
  assert.equal(subtitle.background, palette.background, page + ': subtitle background')
  assert.equal(heading.text, page === 'scope' ? '为谁安装？' : '正在安装')
  if (page === 'progress') {
    const surface = controls.find(control => control.className === 'Static' && !control.text && control.left === 224 && control.top === 0 && control.width === 536 && control.height === 500)
    assert.ok(surface, 'progress: a dedicated surface covers the full content and footer')
    assert.ok(surface.style & 0x04000000, 'progress: the surface clips foreground siblings')
    assert.ok(surface.index > heading.index && surface.index > subtitle.index, 'progress: text remains above the surface')
    assert.equal(surface.background, palette.background, 'progress: surface uses the selected palette')
    assert.equal(values.get('progress.surfaceRendered'), '1', 'progress: native full-window rendering succeeds')
    assert.equal(Number(values.get('progress.rightBackground')), palette.background, 'progress: content pixels keep their palette when the host background changes')
    assert.equal(Number(values.get('progress.footerBackground')), palette.background, 'progress: footer pixels keep their palette when the host background changes')
    assert.equal(values.get('progress.backdropExistsAfterCleanup'), '0', 'progress: cleanup destroys the content surface')
    assert.equal(values.get('progress.controlsAfterCleanup'), '', 'progress: cleanup releases tracked controls')
  }
}

test('real NSIS UI keeps readable palettes, loaded logos and uncovered branding', { timeout: 60000 }, async t => {
  if (process.platform !== 'win32') { t.skip('Native NSIS UI probe requires Windows'); return }
  const compiler = findCompiler()
  if (!compiler) {
    assert.notEqual(process.env.BK_REQUIRE_NSIS_TESTS, '1', 'NSIS UI probe is required but cached compiler is unavailable')
    t.skip('No cached NSIS compiler; package Windows first or set BK_NSIS_COMPILER')
    return
  }
  const tools = path.join(root, '.agent/tools')
  fs.mkdirSync(tools, { recursive: true })
  const directory = fs.mkdtempSync(path.join(tools, 'installer-ui-probe-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  for (const theme of ['light', 'dark', 'high-contrast']) {
    await t.test(theme, () => {
      const source = path.join(directory, theme + '.nsi')
      const executable = path.join(directory, theme + '.exe')
      const report = path.join(directory, theme + '.txt')
      fs.writeFileSync(source, fixtureSource(theme, executable, report), 'utf8')
      const compiled = spawnSync(compiler, ['/V2', '/INPUTCHARSET', 'UTF8', source], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 })
      assert.ifError(compiled.error)
      assert.equal(compiled.status, 0, 'UI probe compilation failed:\n' + compiled.stdout + '\n' + compiled.stderr)
      const executed = spawnSync(executable, [], { cwd: directory, encoding: 'utf8', windowsHide: true, timeout: 6000, killSignal: 'SIGKILL' })
      const output = fs.existsSync(report) ? fs.readFileSync(report, 'utf16le') : '(no report)'
      assert.ifError(executed.error)
      assert.equal(executed.status, 0, 'UI probe failed:\n' + output + '\n' + executed.stderr)
      const { values, controls } = parseReport(output)
      assert.equal(values.get('finished'), '1', 'both own test pages completed:\n' + output)
      assertPage(controls.scope, theme, values, 'scope')
      assertPage(controls.progress, theme, values, 'progress')
      assert.equal(values.get('scope.stockHeaderVisible'), '0', 'stock header separator cannot overlap the brand on custom pages')
      assert.equal(values.get('progress.stockHeaderVisible'), '0', 'extraction page also hides the stock header separator')
      assert.equal(values.get('motion.firstPosition'), values.get('motion.allowed') === '1' ? '1' : '8', 'real timer honors current system animation preference')
      assert.equal(values.get('motion.reversedPosition'), '0', 'a reversed selection ends at the latest target')
      assert.equal(values.get('motion.highContrastPosition'), '8', 'high contrast skips palette interpolation')
      assert.equal(values.get('motion.highContrastEnabled'), '0', 'high contrast disables client-area animation')
      assert.equal(values.get('motion.pageAfterStop'), '', 'stopping the page releases its animated HWND identity')
      assert.equal(values.get('motion.positionAfterStoppedLoop'), '0', 'no stale palette timer runs after stop while the dialog still pumps messages')
      assert.equal(Number(values.get('motion.midSurface')), theme === 'high-contrast' ? Number(values.get('system.background')) : colorRef(theme === 'dark' ? '332C3B' : 'F8F5FB'), 'native card receives the interpolated opaque background')
      assert.equal(values.get('scope.fontFace'), 'Microsoft YaHei UI', 'Chinese labels use an explicit CJK sans-serif font')
      assert.equal(values.get('scope.allChecked'), '1', 'clicking the all-users card selects its native radio')
      assert.equal(values.get('scope.currentUnchecked'), '0', 'cards remain mutually exclusive')
      assert.equal(values.get('scope.currentChecked'), '1', 'clicking the recommended card restores its native radio')
      assert.equal(values.get('scope.allUnchecked'), '0', 'restoring current-user scope clears the other radio')
      assert.equal(values.get('scope.nativeAllChecked'), '1', 'native radio activation selects the other option')
      assert.equal(values.get('scope.nativeCurrentUnchecked'), '0', 'native radio activation preserves mutual exclusion')
      assert.equal(values.get('license.acceptedEnabled'), '1', 'accepting the license enables the actual install button')
      assert.equal(values.get('license.uncheckedEnabled'), '0', 'withdrawing consent disables the actual install button')
      assert.equal(values.get('license.accessibleCaption'), '继续  →', 'bitmap repaint preserves its accessible caption')
      if (theme !== 'high-contrast') assert.equal(values.get('license.bitmapChanged'), '1', 'consent changes refresh the disabled button surface')
      if (theme !== 'high-contrast') assert.ok(Number(values.get('scope.titleTextPixels')) > 20, 'actual title paint contains readable text pixels')
      if (theme === 'dark') {
        assert.equal(values.get('scope.radioInvalidPixels'), '0', 'native text sampling has no failed GetPixel reads')
        assert.ok(Number(values.get('scope.radioBrightPixels')) > 5, 'native dark radio draws readable light text beyond its selection circle')
      }
    })
  }
})

/** Hash the complete private DIB; sparse point samples can miss the thin moving waveform. */
function capturedFrameHash(directory, name) {
  assert.match(name || '', /^[A-Za-z0-9_.-]+\.exe\.frame-\d+\.bin$/, 'native pixel capture must succeed')
  const bytes = fs.readFileSync(path.join(directory, name))
  assert.ok(bytes.length > 0 && bytes.length % 4 === 0, 'capture contains complete 32-bit pixels')
  return createHash('sha256').update(bytes).digest('hex')
}

test('native installer motion advances during real extraction and stops on completion or Abort', { timeout: 90000 }, async t => {
  if (process.platform !== 'win32') { t.skip('Native animation playback requires Windows'); return }
  const compiler = findCompiler()
  if (!compiler) {
    assert.notEqual(process.env.BK_REQUIRE_NSIS_TESTS, '1', 'Native animation probe requires a cached NSIS compiler')
    t.skip('No cached NSIS compiler; package Windows first or set BK_NSIS_COMPILER')
    return
  }
  const directory = fs.mkdtempSync(path.join(root, '.agent/tools/installer-motion-probe-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  // Repeated data keeps the probe executable tiny while genuinely extracting
  // enough bytes for a frame to advance, without an artificial install delay.
  const payload = path.join(directory, 'own-extraction-payload.bin')
  const bytes = Buffer.alloc(48 * 1024 * 1024)
  for (let index = 0; index < bytes.length; index++) bytes[index] = (index * 13 + (index >>> 8) * 17) & 255
  fs.writeFileSync(payload, bytes)
  const cases = [
    { theme: 'light', dpi: 96, reduced: false, fail: false },
    { theme: 'dark', dpi: 144, reduced: false, fail: false },
    { theme: 'dark', dpi: 192, reduced: false, fail: true },
    { theme: 'dark', dpi: 120, reduced: true, fail: false },
    { theme: 'high-contrast', dpi: 96, reduced: false, fail: true }
  ]
  for (const options of cases) await t.test(Object.values(options).join('/'), () => {
    const name = options.theme + '-' + options.dpi
    const executable = path.join(directory, name + '.exe')
    const report = path.join(directory, name + '.txt')
    const source = path.join(directory, name + '.nsi')
    fs.writeFileSync(source, motionFixtureSource(options, executable, report, payload), 'utf8')
    const compiled = spawnSync(compiler, ['/V2', '/INPUTCHARSET', 'UTF8', source], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 20000 })
    assert.ifError(compiled.error)
    assert.equal(compiled.status, 0, 'Native motion compilation failed:\n' + compiled.stdout + '\n' + compiled.stderr)
    const executed = spawnSync(executable, [], { cwd: directory, encoding: 'utf8', windowsHide: true, timeout: 10000, killSignal: 'SIGKILL' })
    const output = fs.existsSync(report) ? fs.readFileSync(report, 'utf16le') : '(no report)'
    assert.ok(!executed.error, 'Native motion executable failed: ' + executed.error?.message + '\n' + output)
    assert.equal(executed.status, 0, 'Native motion fixture failed:\n' + output)
    const { values } = parseReport(output)
    assert.equal(values.get('native.finished'), '1', 'fixture reached its native lifecycle callback:\n' + output)
    assert.equal(values.get('native.afterLeave'), '', 'InstFiles LEAVE closes the animation immediately')
    assert.equal(values.get('native.destroyed'), '0', 'InstFiles animation HWND is destroyed')
    if (options.theme === 'high-contrast') {
      assert.equal(values.get('native.hwnd'), '', 'high contrast retains system UI without decorative playback')
    } else {
      assert.ok(Number(values.get('native.hwnd')) > 0, 'the real native control opens the packaged silent clip')
      assert.equal(values.get('native.dpi'), String(options.dpi), 'the native pixel asset matches the requested system DPI')
      assert.equal(values.get('native.installPlaying'), options.reduced ? '0' : '1', 'reduced motion seeks a static frame; ordinary installation loops natively')
      if (options.reduced) assert.equal(capturedFrameHash(directory, values.get('native.beforeExtract')), capturedFrameHash(directory, values.get('native.afterExtract')), 'the static reduced-motion frame does not advance during extraction')
      else assert.notEqual(capturedFrameHash(directory, values.get('native.beforeExtract')), capturedFrameHash(directory, values.get('native.afterExtract')), 'actual AVI pixels change while NSIS extracts real bytes:\n' + output)
    }
    if (options.fail) {
      assert.equal(values.get('native.failureCloseEnabled'), '1', 'an actual Abort immediately enables close')
      assert.equal(values.get('native.failureCloseVisible'), String(0x10000000), 'an actual Abort reveals close without waiting for .onInstFailed')
      for (const label of ['Title', 'Step', 'BrandStep']) assert.equal(values.get('native.failure' + label), '安装未完成', 'all visible status text reflects failure')
    } else {
      assert.equal(values.get('native.successPlaying'), options.reduced ? '0' : '1', 'success reveals once or immediately seeks its completed state')
      assert.equal(values.get('native.successStopped'), '0', 'the success reveal ends instead of looping')
      assert.equal(values.get('native.successPending'), '', 'the one-shot start callback releases its page identity')
      if (!options.reduced) assert.notEqual(capturedFrameHash(directory, values.get('native.successInitial')), capturedFrameHash(directory, values.get('native.successFinal')), 'the success check visibly draws and settles')
      assert.equal(values.get('native.successDestroyed'), '0', 'page cleanup destroys the success control')
      assert.equal(values.get('native.missingClip'), '', 'a failed asset open leaves no native resources behind')
    }
  })
})
