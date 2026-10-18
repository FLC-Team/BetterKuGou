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
  const caches = [process.env.ELECTRON_BUILDER_CACHE, path.join(root, '.agent/tools/electron-builder-cache'),
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

/** Select the shipped lifecycle, including its callback dependencies and cleanup. */
function completionFunctions() {
  const source = fs.readFileSync(path.join(root, 'installer/windows-functions.nsh'), 'utf8').replace(/\r\n/g, '\n')
  const declarations = fs.readFileSync(path.join(root, 'installer/windows.nsh'), 'utf8')
  const available = new Map([...source.matchAll(/^Function ([\w.]+)\n[\s\S]*?^FunctionEnd\b/gm)].map(match => [match[1], match[0]]))
  const selected = new Map()
  function collect(name) {
    if (selected.has(name)) return
    let body = available.get(name)
    assert.ok(body, 'real installer defines ' + name)
    assert.doesNotMatch(body, /^\s*(?:WriteReg\w*|DeleteReg\w*|Exec(?:Wait|Shell)?|Delete|RMDir|Rename|CopyFiles|CreateDirectory|FileOpen|FileWrite)\b/mi,
      'completion fixture must not inherit real installation or application launch actions')
    if (name === 'BKFinishPage') {
      assert.equal([...body.matchAll(/^  nsDialogs::Show$/gm)].length, 1)
      body = body.replace(/^  nsDialogs::Show$/m,
        '  GetFunctionAddress $0 ProbeCompletionReady\n  nsDialogs::CreateTimer $0 100\n  nsDialogs::Show')
    }
    selected.set(name, body)
    for (const call of body.matchAll(/^\s*(?:Call|GetFunctionAddress\s+\$\w+) (BK\w+)\b/gm)) collect(call[1])
    for (const click of body.matchAll(/\$\{NSD_OnClick\}\s+\$\w+\s+(BK\w+)\b/g)) collect(click[1])
  }
  for (const name of ['BKGuiInit', 'BKProgressShow', 'BKProgressLeave', 'BKFinishPage', '.onGUIEnd']) collect(name)
  const macros = [...source.matchAll(/^!macro BK\w+\b[\s\S]*?^!macroend\b/gm)].map(match => match[0]).join('\n\n')
  for (const call of macros.matchAll(/^\s*Call (BK\w+)\b/gm)) collect(call[1])
  const variables = [...declarations.matchAll(/^Var BK\w+\s*$/gm)].map(match => match[0].trim()).join('\n')
  return variables + '\n' + macros + '\n' + [...selected.values()].join('\n\n')
}

const privateCallbacks = String.raw`
Function ProbeGuiInit
  Call BKGuiInit
  ; This fixture owns its window. Keep it offscreen and non-activating without
  ; changing any system setting or synthesizing desktop input.
  System::Call 'user32::GetWindowLongW(p $HWNDPARENT, i -20)i.r0'
  IntOp $0 $0 | 0x08000000
  System::Call 'user32::SetWindowLongW(p $HWNDPARENT, i -20, i r0)'
  System::Call 'user32::SetWindowPos(p $HWNDPARENT, p 0, i -32000, i -32000, i 0, i 0, i 0x15)'
FunctionEnd

Function ProbeProgressShow
  Call BKProgressShow
  StrCpy $ProbeProgressAnimation $BKInstallAnimation
  FileWriteUTF16LE $ProbeReport "progress=shown$\r$\n"
FunctionEnd

Function ProbeProgressLeave
  Call BKProgressLeave
  System::Call 'user32::IsWindow(p $ProbeProgressAnimation)i.r0'
  FileWriteUTF16LE $ProbeReport "progress.animationExists=$0$\r$\n"
  IfAbort 0 probeExtractionSucceeded
  System::Call 'user32::IsWindowEnabled(p $BKCancel)i.r0'
  FileWriteUTF16LE $ProbeReport "failure.closeEnabled=$0$\r$\n"
  System::Call 'user32::GetWindowLongW(p $BKCancel, i -16)i.r0'
  IntOp $0 $0 & 0x10000000
  FileWriteUTF16LE $ProbeReport "failure.closeVisible=$0$\r$\n"
  System::Call 'user32::GetWindowTextW(p $BKProgressTitle, w .r0, i @{NSIS_MAX_STRLEN})'
  FileWriteUTF16LE $ProbeReport "failure.title=$0$\r$\n"
  FileWriteUTF16LE $ProbeReport "failure.busy=$BKBusy$\r$\n"
  FileClose $ProbeReport
  SetErrorLevel 0
  Quit
  probeExtractionSucceeded:
  FileWriteUTF16LE $ProbeReport "progress=completed$\r$\n"
FunctionEnd

Function ProbeCompletionReady
  GetFunctionAddress $0 ProbeCompletionReady
  nsDialogs::KillTimer $0
  System::Call 'user32::GetWindowTextW(p $BKTitle, w .r0, i @{NSIS_MAX_STRLEN})'
  FileWriteUTF16LE $ProbeReport "finish.title=$0$\r$\n"
  System::Call 'user32::IsWindowEnabled(p $BKNext)i.r0'
  FileWriteUTF16LE $ProbeReport "finish.nextEnabled=$0$\r$\n"
  FileWriteUTF16LE $ProbeReport "finish.busy=$BKBusy$\r$\n"
  FileWriteUTF16LE $ProbeReport "finish.done=$BKDone$\r$\n"
  FileClose $ProbeReport
  SetErrorLevel 0
  ; This private last page has no leave/launch handler. Advancing only closes
  ; the fixture's own page loop and exercises the real GUI resource cleanup.
  SendMessage $HWNDPARENT @{WM_COMMAND} 1 0
FunctionEnd
`.replaceAll('@{', '${')

function fixtureSource(executable, report, payload, fail) {
  return [
    'Unicode true', 'RequestExecutionLevel user', 'XPStyle on',
    'Name "BetterKuGou extraction completion regression probe"', `OutFile "${nsisString(executable)}"`,
    '!include MUI2.nsh', '!include nsDialogs.nsh', '!include LogicLib.nsh', '!include WinMessages.nsh',
    '!define VERSION "0.0.0-completion-probe"',
    '!define MUI_CUSTOMFUNCTION_GUIINIT ProbeGuiInit',
    '!define MUI_PAGE_CUSTOMFUNCTION_SHOW ProbeProgressShow', '!define MUI_PAGE_CUSTOMFUNCTION_LEAVE ProbeProgressLeave',
    '!insertmacro MUI_PAGE_INSTFILES', 'Page custom BKFinishPage', '!insertmacro MUI_LANGUAGE "SimpChinese"',
    'Var ProbeReport', 'Var ProbeProgressAnimation', completionFunctions(), privateCallbacks,
    'Function .onInit', '  StrCpy $BKAction "安装"', '  StrCpy $BKDone 0', '  InitPluginsDir',
    ...['light', 'dark'].map(theme =>
      `  File /oname=$PLUGINSDIR\\bk-logo-${theme}.bmp "${nsisString(path.join(root, 'installer/assets/logo-' + theme + '.bmp'))}"`),
    ...['install', 'success'].flatMap(kind => ['light', 'dark'].flatMap(theme => [96, 120, 144, 192].map(dpi =>
      `  File /oname=$PLUGINSDIR\\${kind}-${theme}-${dpi}.avi "${nsisString(path.join(root, 'installer/assets/' + kind + '-' + theme + '-' + dpi + '.avi'))}"`))),
    `  FileOpen $ProbeReport "${nsisString(report)}" w`, 'FunctionEnd',
    'Section', '  SetOutPath $PLUGINSDIR', `  File /oname=completion-payload.bin "${nsisString(payload)}"`,
    '  FileWriteUTF16LE $ProbeReport "section=extracted$\\r$\\n"',
    fail ? '  Abort "Intentional own-fixture extraction failure"' : '  StrCpy $BKDone 1',
    'SectionEnd', ''
  ].join('\n')
}

test('the shipped progress lifecycle reaches its real finish page and preserves failure close controls', { timeout: 40000 }, async t => {
  if (process.platform !== 'win32') { t.skip('Native installer completion requires Windows'); return }
  const compiler = findCompiler()
  if (!compiler) {
    assert.notEqual(process.env.BK_REQUIRE_NSIS_TESTS, '1', 'Native installer completion is required but no compiler was found')
    t.skip('No cached NSIS compiler; package Windows first or set BK_NSIS_COMPILER')
    return
  }
  const tools = path.join(root, '.agent/tools')
  fs.mkdirSync(tools, { recursive: true })
  const directory = fs.mkdtempSync(path.join(tools, 'installer-completion-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const payload = path.join(directory, 'payload.bin')
  fs.writeFileSync(payload, 'Own temporary extraction payload\n'.repeat(4096))
  for (const fail of [false, true]) {
    await t.test(fail ? 'failed extraction keeps a usable close action' : 'successful extraction advances without a hidden Next click', () => {
      const name = fail ? 'failure' : 'success'
      const executable = path.join(directory, name + '.exe')
      const report = path.join(directory, name + '.txt')
      const source = path.join(directory, name + '.nsi')
      fs.writeFileSync(source, fixtureSource(executable, report, payload, fail), 'utf8')
      const compiled = spawnSync(compiler, ['/V2', '/INPUTCHARSET', 'UTF8', source], {
        cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000
      })
      assert.ifError(compiled.error)
      assert.equal(compiled.status, 0, 'Completion fixture compilation failed:\n' + compiled.stdout + '\n' + compiled.stderr)
      const executed = spawnSync(executable, [], {
        cwd: directory, encoding: 'utf8', windowsHide: true, timeout: 6000, killSignal: 'SIGKILL'
      })
      const output = fs.existsSync(report) ? fs.readFileSync(report, 'utf16le') : '(no report)'
      assert.ok(!executed.error, 'Actual progress/finish lifecycle failed: ' + executed.error?.message + '\n' + output)
      assert.equal(executed.status, 0, 'Completion fixture exited unsuccessfully:\n' + output)
      assert.match(output, /^section=extracted$/m)
      assert.match(output, /^progress\.animationExists=0$/m)
      if (fail) {
        assert.match(output, /^failure\.title=安装未完成$/m)
        assert.match(output, /^failure\.closeEnabled=1$/m)
        assert.match(output, /^failure\.closeVisible=268435456$/m)
        assert.match(output, /^failure\.busy=0$/m)
        assert.doesNotMatch(output, /^finish\./m)
      } else {
        assert.match(output, /^progress=completed$/m)
        assert.match(output, /^finish\.title=安装完成$/m)
        assert.match(output, /^finish\.nextEnabled=1$/m)
        assert.match(output, /^finish\.busy=0$/m)
        assert.match(output, /^finish\.done=1$/m)
      }
    })
  }
})
