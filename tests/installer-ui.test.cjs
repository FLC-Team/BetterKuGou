const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

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
    'BKScopeCurrentClick', 'BKScopeAllClick', 'BKLicenseChanged', 'BKProgressShow']
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
  ; Advance only this test fixture's empty install page.
  SendMessage $HWNDPARENT @{WM_COMMAND} 1 0
FunctionEnd

Function ProbeProgressReady
  HideWindow
  Call BKProgressShow
  StrCpy $ProbeContainer $HWNDPARENT
  StrCpy $ProbeName progress
  Call ProbeDumpChildren
  GetDlgItem $0 $HWNDPARENT 1036
  System::Call 'user32::GetWindowLongW(p r0, i -16)i.r1'
  IntOp $1 $1 & 0x10000000
  FileWriteUTF16LE $ProbeReport "progress.stockHeaderVisible=$1$\r$\n"
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
    '  FileOpen $ProbeReport "' + nsisString(report) + '" w',
    "  System::Call 'user32::GetSysColor(i 8)i.r0'", '  FileWriteUTF16LE $ProbeReport "system.text=$0$\\r$\\n"',
    "  System::Call 'user32::GetSysColor(i 5)i.r0'", '  FileWriteUTF16LE $ProbeReport "system.background=$0$\\r$\\n"',
    'FunctionEnd', 'Section',
    '  FileWriteUTF16LE $ProbeReport "finished=1$\\r$\\n"', '  FileClose $ProbeReport',
    '  SetErrorLevel 0', '  Quit', 'SectionEnd', ''
  ].join('\n')
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
