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

function nativeCompiler(t) {
  if (process.platform !== 'win32') {
    t.skip('Native per-user installation path probe requires Windows')
    return null
  }
  const compiler = findCompiler()
  if (!compiler) {
    assert.notEqual(process.env.BK_REQUIRE_NSIS_TESTS, '1', 'NSIS installation path probe is required but no compiler was found')
    t.skip('No cached NSIS compiler; package Windows first or set BK_NSIS_COMPILER')
  }
  return compiler
}

function fixtureDirectory(t) {
  const tools = path.join(root, '.agent/tools')
  fs.mkdirSync(tools, { recursive: true })
  const directory = fs.mkdtempSync(path.join(tools, 'installer-install-mode-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

/** Each fixture has no pages, installation actions, registry writes or shell execution. */
function runFixture(compiler, directory, name, declarations, instructions) {
  const source = path.join(directory, name + '.nsi')
  const executable = path.join(directory, name + '.exe')
  const report = path.join(directory, name + '.txt')
  fs.writeFileSync(source, [
    'Unicode true', 'RequestExecutionLevel user', 'SilentInstall silent', 'AutoCloseWindow true',
    'Name "BetterKuGou per-user path safety probe"', `OutFile "${nsisString(executable)}"`,
    '!include LogicLib.nsh', 'Var ProbeReport', 'Var ProbeMemory', declarations,
    'Section', `  FileOpen $ProbeReport "${nsisString(report)}" w`, instructions,
    '  FileClose $ProbeReport', '  SetErrorLevel 0', 'SectionEnd', ''
  ].join('\n'), 'utf8')
  const compiled = spawnSync(compiler, ['/V2', '/INPUTCHARSET', 'UTF8', source], {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000
  })
  assert.ifError(compiled.error)
  assert.equal(compiled.status, 0, `NSIS ${name} compilation failed:\n${compiled.stdout}\n${compiled.stderr}`)
  const executed = spawnSync(executable, [], {
    cwd: directory, encoding: 'utf8', windowsHide: true, timeout: 3000, killSignal: 'SIGKILL'
  })
  assert.ifError(executed.error)
  return { status: executed.status, output: fs.existsSync(report) ? fs.readFileSync(report, 'utf8') : '(no report)' }
}

// A valid eight-character allocation ends exactly at the page boundary. Reading
// NSIS_MAX_STRLEN characters from it must fail even when the terminator is early.
const guardedPath = String.raw`
  System::Call 'kernel32::VirtualAlloc(p 0, i 8192, i 0x3000, i 4)p.s'
  Pop $ProbeMemory
  @{If} $ProbeMemory == 0
    SetErrorLevel 90
    Quit
  @{EndIf}
  IntOp $0 $ProbeMemory + 4096
  System::Call 'kernel32::VirtualProtect(p r0, i 4096, i 1, *i .r1)i.r2'
  @{If} $2 == 0
    SetErrorLevel 91
    Quit
  @{EndIf}
  IntOp $0 $ProbeMemory + 4080
  System::Call '*$0(&w8 "Z:\Test")'
`.replaceAll('@{', '${')

test('a short known-folder allocation is copied through its terminator rather than a full NSIS string', { timeout: 20000 }, t => {
  const compiler = nativeCompiler(t)
  if (!compiler) return
  const directory = fixtureDirectory(t)
  const original = runFixture(compiler, directory, 'fixed-width-read', '', [guardedPath,
    '  FileWrite $ProbeReport "before$\\r$\\n"',
    "  System::Call '*$0(&w${NSIS_MAX_STRLEN} .r1)'",
    '  FileWrite $ProbeReport "unexpected-success$\\r$\\n"'
  ].join('\n'))
  assert.equal(original.status >>> 0, 0xC0000005, 'the guard page must expose the original native access violation')
  assert.equal(original.output, 'before\r\n')
  const bounded = runFixture(compiler, directory, 'bounded-read', '', [guardedPath,
    "  System::Call 'kernel32::lstrcpynW(w .r1, p r0, i ${NSIS_MAX_STRLEN})'",
    '  FileWrite $ProbeReport "$1"',
    "  System::Call 'kernel32::VirtualFree(p $ProbeMemory, i 0, i 0x8000)'"
  ].join('\n'))
  assert.equal(bounded.status, 0)
  assert.equal(bounded.output, 'Z:\\Test')
})

/** Keep the real path selection/copy while replacing only its external inputs. */
function installModeFixtureInclude(directory) {
  const source = fs.readFileSync(path.join(root, 'installer/install-mode.nsh'), 'utf8').replace(/\r\n/g, '\n')
  const match = source.match(/^\s*!macro setInstallModePerUser\s*\n[\s\S]*?^\s*!macroend\b/m)
  assert.ok(match, 'the installer owns the per-user mode replacement')
  let macro = source
  const registry = /^\s*ReadRegStr\s+(\$\w+)\s+HKCU\s+"[^"\n]+"\s+InstallLocation\s*$/gm
  assert.equal([...macro.matchAll(registry)].length, 1, 'only the installed path lookup is stubbed')
  macro = macro.replace(registry, (_, destination) => `  StrCpy ${destination} $ProbeRegistryPath`)
  const knownFolder = /^\s*System::Call '[^'\n]*::SHGetKnownFolderPath\([^'\n]*'\s*$/gmi
  assert.equal([...macro.matchAll(knownFolder)].length, 1, 'the actual macro queries one known-folder allocation')
  macro = macro.replace(knownFolder, [
    '  IntOp $ProbeKnownCalls $ProbeKnownCalls + 1',
    '  StrCpy $1 $ProbeKnownResult', '  StrCpy $2 0',
    '  ${If} $ProbeKnownPointer == 1', '    IntOp $2 $ProbeMemory + 4080',
    '  ${ElseIf} $ProbeKnownPointer == 2', '    IntOp $2 $ProbeMemory + 4094', '  ${EndIf}'
  ].join('\n'))
  const free = /^\s*System::Call '[^'\n]*::CoTaskMemFree\([^'\n]*'\s*$/gmi
  assert.equal([...macro.matchAll(free)].length, 1, 'the external allocation has one release site')
  macro = macro.replace(free, '  IntOp $ProbeFreeCalls $ProbeFreeCalls + 1')
  assert.doesNotMatch(macro, /^\s*(?:ReadReg\w*|WriteReg\w*|DeleteReg\w*|Exec(?:Wait|Shell)?|Delete|RMDir|Rename|CopyFiles)\b/mi)
  const patchedInclude = path.join(directory, 'install-mode-inputs.nsh')
  fs.writeFileSync(patchedInclude, macro, 'utf8')
  return ['!macro setInstallModePerUser', '  !error "The unsafe builder macro must be replaced"', '!macroend',
    `!include "${nsisString(patchedInclude)}"`, `!include "${nsisString(patchedInclude)}"`].join('\n')
}

test('the real per-user macro preserves installation precedence, fallback and caller registers at a guard boundary', { timeout: 20000 }, t => {
  const compiler = nativeCompiler(t)
  if (!compiler) return
  const directory = fixtureDirectory(t)
  const declarations = [
    'Var installMode', 'Var perUserInstallationFolder', 'Var ProbeRegistryPath',
    'Var ProbeKnownResult', 'Var ProbeKnownPointer', 'Var ProbeKnownCalls', 'Var ProbeFreeCalls', 'Var ProbeOverride', 'Var ProbeStack',
    '!define APP_FILENAME "BetterKuGou"', '!define INSTALL_REGISTRY_KEY "Software\\BetterKuGouProbe"',
    '!define FOLDERID_UserProgramFiles "{5CD7AEE2-2219-4A67-B85D-6C9CE15660CB}"', '!define KF_FLAG_CREATE 0x8000',
    '!define StdUtils.GetParameter "!insertmacro ProbeGetParameter"',
    '!macro ProbeGetParameter OUT NAME DEFAULT', '  StrCpy ${OUT} $ProbeOverride', '!macroend',
    installModeFixtureInclude(directory)
  ].join('\n')
  const cases = [
    { name: 'fresh', knownResult: 0, pointer: 1, registry: '', override: '', calls: 1, frees: 1, expected: 'Z:\\Test\\BetterKuGou' },
    { name: 'registry', knownResult: 0, pointer: 1, registry: 'C:\\Existing', override: '', calls: 0, frees: 0, expected: 'C:\\Existing' },
    { name: 'override', knownResult: 0, pointer: 1, registry: '', override: 'D:\\Chosen', calls: 1, frees: 1, expected: 'D:\\Chosen' },
    { name: 'registry-override', knownResult: 0, pointer: 1, registry: 'C:\\Existing', override: 'D:\\Chosen', calls: 0, frees: 0, expected: 'D:\\Chosen' },
    { name: 'failed-query', knownResult: -1, pointer: 0, registry: '', override: '', calls: 1, frees: 0, fallback: true },
    { name: 'empty-pointer', knownResult: 0, pointer: 0, registry: '', override: '', calls: 1, frees: 0, fallback: true },
    { name: 'empty-string', knownResult: 0, pointer: 2, registry: '', override: '', calls: 1, frees: 1, fallback: true }
  ]
  const instructions = [guardedPath, '  FileWrite $ProbeReport "fallback=$LOCALAPPDATA\\Programs\\BetterKuGou$\\r$\\n"',
    ...cases.map(entry => [
      `  StrCpy $ProbeRegistryPath "${nsisString(entry.registry)}"`,
      `  StrCpy $ProbeOverride "${nsisString(entry.override)}"`,
      `  StrCpy $ProbeKnownResult ${entry.knownResult}`, `  StrCpy $ProbeKnownPointer ${entry.pointer}`,
      '  StrCpy $ProbeKnownCalls 0', '  StrCpy $ProbeFreeCalls 0',
      '  StrCpy $0 caller-zero', '  StrCpy $1 caller-one', '  StrCpy $2 caller-two',
      '  Push stack-sentinel', '  !insertmacro setInstallModePerUser', '  Pop $ProbeStack',
      `  FileWrite $ProbeReport "${entry.name}|$INSTDIR|$installMode|$0|$1|$2|$ProbeStack|$ProbeKnownCalls|$ProbeFreeCalls$\\r$\\n"`
    ].join('\n')),
    "  System::Call 'kernel32::VirtualFree(p $ProbeMemory, i 0, i 0x8000)'"
  ].join('\n')
  const result = runFixture(compiler, directory, 'install-mode', declarations, instructions)
  assert.equal(result.status, 0, 'the real macro must finish without a native read past its external path allocation:\n' + result.output)
  const lines = result.output.trim().split(/\r?\n/)
  const fallback = lines.shift().replace(/^fallback=/, '')
  assert.equal(lines.length, cases.length)
  for (const [index, entry] of cases.entries()) {
    assert.deepEqual(lines[index].split('|'), [entry.name, entry.fallback ? fallback : entry.expected, 'CurrentUser',
      'caller-zero', 'caller-one', 'caller-two', 'stack-sentinel', String(entry.calls), String(entry.frees)], entry.name)
  }
})
