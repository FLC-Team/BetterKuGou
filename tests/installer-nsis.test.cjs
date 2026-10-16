const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync, fork } = require('node:child_process')

const root = path.resolve(__dirname, '..')

/** Only inspect known NSIS locations; a normal test run never downloads a toolchain. */
function findCompiler() {
  const candidates = [process.env.BK_NSIS_COMPILER]
  if (process.env.NSISDIR) candidates.push(path.join(process.env.NSISDIR, 'Bin', 'makensis.exe'))
  const caches = [
    process.env.ELECTRON_BUILDER_CACHE,
    path.join(root, '.agent', 'tools', 'electron-builder-cache'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'electron-builder', 'Cache'),
    path.join(os.homedir(), 'AppData', 'Local', 'electron-builder', 'Cache')
  ].filter(Boolean)
  for (const cache of new Set(caches)) {
    const nsisRoot = path.join(cache, 'nsis')
    if (!fs.existsSync(nsisRoot)) continue
    for (const entry of fs.readdirSync(nsisRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && /^nsis-/.test(entry.name)) candidates.push(path.join(nsisRoot, entry.name, 'Bin', 'makensis.exe'))
    }
  }
  return candidates.find(candidate => candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile())
}

/** Extract the actual installer comparison and its helper calls, without copying their algorithms. */
function installerFunctionSource(entry = 'BKCompareVersions') {
  const installer = fs.readFileSync(path.join(root, 'installer/windows.nsh'), 'utf8')
  const functions = fs.readFileSync(path.join(root, 'installer/windows-functions.nsh'), 'utf8')
  const source = `${installer}\n${functions}`.replace(/\r\n/g, '\n')
  const available = new Map([...source.matchAll(/^Function (\w+)\n[\s\S]*?^FunctionEnd\b/gm)].map(match => [match[1], match[0]]))
  const selected = new Map()
  function collect(name) {
    if (selected.has(name)) return
    assert.ok(available.has(name), `installer defines ${name}`)
    const body = available.get(name)
    // This probe is limited to pure version functions, even if a future refactor adds a call.
    assert.doesNotMatch(body, /^\s*(?:ReadReg\w*|WriteReg\w*|DeleteReg\w*|Exec(?:Wait|Shell)?|Delete|RMDir|Rename|CopyFiles|CreateDirectory|FileOpen|FileWrite)\b/mi)
    selected.set(name, body)
    for (const call of body.matchAll(/^\s*Call (BK\w+)\b/gm)) collect(call[1])
  }
  collect(entry)
  const body = [...selected.values()].join('\n\n')
  const referenced = new Set([...body.matchAll(/\$(BK\w+)\b/g)].map(match => match[1]))
  const variables = [...source.matchAll(/^Var (BK\w+)\s*$/gm)].filter(match => referenced.has(match[1])).map(match => match[0].trim())
  assert.equal(variables.length, referenced.size, 'comparison variables are declared by the actual installer')
  return `${variables.join('\n')}\n\n${body}`
}

function nsisString(value) {
  return String(value).replace(/\$/g, () => '$$').replace(/"/g, () => '$\\"')
}

const comparisons = [
  ['same hyphenated prerelease terminates', '0.1.6-alpha-pre1', '0.1.6-alpha-pre1', '0'],
  ['numeric prerelease ordering', '1.0.0-alpha.2', '1.0.0-alpha.10', '-1'],
  ['numeric prerelease reverse ordering', '1.0.0-alpha.10', '1.0.0-alpha.2', '1'],
  ['hyphenated lexical ordering', '1.0.0-alpha-pre1', '1.0.0-alpha-pre2', '-1'],
  ['hyphenated identifier stays lexical', '1.0.0-alpha-pre10', '1.0.0-alpha-pre2', '-1'],
  ['stable follows prerelease', '1.0.0', '1.0.0-rc.1', '1'],
  ['prerelease precedes stable', '1.0.0-rc.1', '1.0.0', '-1'],
  ['build metadata has no precedence', '1.0.0+build.02', '1.0.0+other.1', '0'],
  ['prerelease build metadata is ignored', '1.0.0-alpha.2+first', '1.0.0-alpha.2+second', '0'],
  ['numeric identifier precedes letters', '1.0.0-2', '1.0.0-alpha', '-1'],
  ['extra prerelease identifier follows', '1.0.0-alpha.1', '1.0.0-alpha', '1'],
  ['shorter prerelease comes first', '1.0.0-alpha', '1.0.0-alpha.1', '-1'],
  ['prerelease identifiers are case sensitive', '1.0.0-Z', '1.0.0-a', '-1'],
  ['large core values avoid integer overflow', '9007199254740993.0.0', '9007199254740992.0.0', '1'],
  ['large prerelease values avoid integer overflow', '1.0.0-9007199254740993', '1.0.0-9007199254740992', '1'],
  ['numeric zero is valid', '0.0.0-0', '0.0.0', '-1'],
  ['unknown old version is never equal', '1.0.0', 'historical-version', 'unknown'],
  ['empty old version is unknown', '1.0.0', '', 'unknown'],
  ['four component historical version is unknown', '1.0.0', '1.0.0.0', 'unknown'],
  ['short historical version is unknown', '1.0.0', '1.0', 'unknown'],
  ['leading zero in core is invalid', '1.0.0', '01.0.0', 'unknown'],
  ['leading zero in numeric prerelease is invalid', '1.0.0', '1.0.0-alpha.01', 'unknown'],
  ['empty prerelease is invalid', '1.0.0', '1.0.0-', 'unknown'],
  ['empty prerelease before metadata is invalid', '1.0.0', '1.0.0-+build', 'unknown'],
  ['empty build metadata is invalid', '1.0.0', '1.0.0+', 'unknown'],
  ['empty prerelease identifier is invalid', '1.0.0', '1.0.0-alpha..1', 'unknown'],
  ['empty core identifier is invalid', '1.0.0', '1..0', 'unknown'],
  ['extra core after empty identifier is invalid', '1.0.0', '1.0.0..1', 'unknown'],
  ['multiple build delimiters are invalid', '1.0.0', '1.0.0+a+b', 'unknown']
]

test('real NSIS version functions terminate and follow full SemVer precedence', { timeout: 20000 }, t => {
  if (process.platform !== 'win32') {
    t.skip('NSIS Win32 algorithm probe requires Windows; platform packaging is verified separately')
    return
  }
  const compiler = findCompiler()
  if (!compiler) {
    assert.notEqual(process.env.BK_REQUIRE_NSIS_TESTS, '1', 'NSIS probe is required but no compiler was found after packaging')
    t.skip('No cached NSIS compiler; run Windows packaging first or set BK_NSIS_COMPILER')
    return
  }
  const tools = path.join(root, '.agent/tools')
  fs.mkdirSync(tools, { recursive: true })
  const directory = fs.mkdtempSync(path.join(tools, 'installer-nsis-probe-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const source = path.join(directory, 'versions.nsi')
  const executable = path.join(directory, 'versions.exe')
  const report = path.join(directory, 'versions.txt')
  const cases = comparisons.map(([label, left, right], index) => [
    `  FileWrite $ProbeReport "start ${index}$\\r$\\n"`,
    `  StrCpy $BKCompareLeft "${nsisString(left)}"`,
    `  StrCpy $BKCompareRight "${nsisString(right)}"`,
    '  Call BKCompareVersions',
    `  FileWrite $ProbeReport "${index}:$BKCompareResult$\\r$\\n"`
  ].join('\n')).join('\n')
  fs.writeFileSync(source, [
    'Unicode true', 'RequestExecutionLevel user', 'SilentInstall silent', 'AutoCloseWindow true',
    'Name "BetterKuGou version algorithm probe"', `OutFile "${nsisString(executable)}"`,
    '!include LogicLib.nsh', '!include WordFunc.nsh', 'Var ProbeReport', installerFunctionSource(),
    'Section', `  FileOpen $ProbeReport "${nsisString(report)}" w`,
    cases, '  FileClose $ProbeReport', '  SetErrorLevel 0', 'SectionEnd', ''
  ].join('\n'), 'utf8')
  const compiled = spawnSync(compiler, ['/V2', '/INPUTCHARSET', 'UTF8', source], {
    cwd: root, encoding: 'utf8', timeout: 10000, windowsHide: true
  })
  assert.ifError(compiled.error)
  assert.equal(compiled.status, 0, `NSIS probe compilation failed:\n${compiled.stdout}\n${compiled.stderr}`)
  const executed = spawnSync(executable, [], { cwd: directory, encoding: 'utf8', timeout: 3000, windowsHide: true, killSignal: 'SIGKILL' })
  const output = fs.existsSync(report) ? fs.readFileSync(report, 'utf8') : '(no report)'
  assert.equal(executed.error?.code === 'ETIMEDOUT', false, `NSIS comparison hung after 3 seconds:\n${output}`)
  assert.ifError(executed.error)
  assert.equal(executed.status, 0, `NSIS probe exited unsuccessfully:\n${output}\n${executed.stderr}`)
  const results = new Map([...output.matchAll(/^(\d+):([^\r\n]*)$/gm)].map(match => [Number(match[1]), match[2]]))
  assert.equal(results.size, comparisons.length, `NSIS probe did not report every comparison:\n${output}`)
  const mismatches = comparisons.flatMap(([label, left, right, expected], index) => results.get(index) === expected
    ? [] : [`${label}: ${left} vs ${right}; expected ${expected}, received ${results.get(index)}`])
  assert.deepEqual(mismatches, [], 'actual NSIS comparison disagrees with SemVer')
})

const pipeFixtureSource = String.raw`
const net = require('node:net')
const commands = []
const advertisedPid = process.argv[2] === 'wrong-server-pid' ? Number(process.argv[3]) : process.pid
const endpoint = '\\\\.\\pipe\\BetterKuGou.InstallQuit.v1.' + advertisedPid
let finished = false
const server = net.createServer(socket => {
  let buffer = ''
  socket.setEncoding('utf8')
  socket.on('error', error => process.send({ phase: 'failure', error: error.code }))
  socket.on('data', chunk => {
    buffer += chunk
    let newline
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      commands.push(line)
      if (line === 'HELLO/1' && commands.length === 1) socket.write('READY/1\n')
      else if (line === 'QUIT/1' && commands.length === 2) socket.write('SAVED/1\n')
      else {
        process.send({ phase: 'failure', error: 'unexpected-protocol', commands })
        socket.destroy()
      }
    }
  })
  // Keep the server alive until the NSIS peer has read SAVED and closed its handle.
  socket.on('end', () => {
    socket.end()
    if (finished) return
    finished = true
    server.close(() => process.send({ phase: 'done', commands, peerClosed: true }, () => process.disconnect()))
  })
})
server.on('error', error => process.send({ phase: 'failure', error: error.code }))
server.listen(endpoint, () => process.send({ phase: 'ready', pid: process.pid, advertisedPid }))
`

function pipeFixture(t, executable, script, scenario) {
  const child = fork(script, [scenario, String(process.pid)], {
    execPath: executable, execArgv: [], cwd: path.dirname(script),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true
  })
  const messages = []
  const waiters = new Set()
  let stderr = ''
  let exitResult = null
  child.stderr.on('data', chunk => { stderr += chunk })
  const notify = () => { for (const wake of waiters) wake() }
  child.on('message', value => { messages.push(value); notify() })
  child.once('error', error => { exitResult = { error }; notify() })
  child.once('exit', (code, signal) => { exitResult = { code, signal }; notify() })
  t.after(async () => {
    if (exitResult) return
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 1000)
      child.once('exit', () => { clearTimeout(timer); resolve() })
      child.kill('SIGKILL')
    })
  })
  async function waitUntil(select, label) {
    const deadline = Date.now() + 3000
    while (!select()) {
      const failure = messages.find(message => message.phase === 'failure')
      assert.ok(!failure, `pipe fixture failed: ${JSON.stringify(failure)} ${stderr}`)
      assert.ok(Date.now() < deadline, `${label} timed out: ${stderr}`)
      await new Promise(resolve => {
        const timer = setTimeout(wake, 25)
        function wake() { clearTimeout(timer); waiters.delete(wake); resolve() }
        waiters.add(wake)
      })
    }
    return select()
  }
  return {
    ready: () => waitUntil(() => messages.find(message => message.phase === 'ready'), 'fixture startup'),
    done: () => waitUntil(() => messages.find(message => message.phase === 'done'), 'client handle closure'),
    exit: () => waitUntil(() => exitResult, 'fixture exit')
  }
}

test('real NSIS pipe client authenticates Node PID/path, sends ASCII commands, reads SAVED and closes', { timeout: 30000 }, async t => {
  if (process.platform !== 'win32') {
    t.skip('Native named-pipe client probe requires Windows')
    return
  }
  const compiler = findCompiler()
  if (!compiler) {
    assert.notEqual(process.env.BK_REQUIRE_NSIS_TESTS, '1', 'NSIS pipe probe is required but no compiler was found after packaging')
    t.skip('No cached NSIS compiler; run Windows packaging first or set BK_NSIS_COMPILER')
    return
  }
  const tools = path.join(root, '.agent/tools')
  fs.mkdirSync(tools, { recursive: true })
  const directory = fs.mkdtempSync(path.join(tools, 'installer-nsis-pipe-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const nodeCopy = path.join(directory, 'BKInstallerProbe.exe')
  fs.copyFileSync(process.execPath, nodeCopy)
  const fixtureScript = path.join(directory, 'pipe-fixture.cjs')
  fs.writeFileSync(fixtureScript, pipeFixtureSource, 'utf8')
  for (const scenario of ['success', 'wrong-server-pid', 'wrong-install-path']) {
    await t.test(scenario, async subtest => {
      const fixture = pipeFixture(subtest, nodeCopy, fixtureScript, scenario)
      const ready = await fixture.ready()
      const source = path.join(directory, `${scenario}.nsi`)
      const executable = path.join(directory, `${scenario}.exe`)
      const report = path.join(directory, `${scenario}.txt`)
      const installPath = scenario === 'wrong-install-path' ? path.join(directory, 'other-installation') : directory
      fs.writeFileSync(source, [
        'Unicode true', 'RequestExecutionLevel user', 'SilentInstall silent', 'AutoCloseWindow true',
        'Name "BetterKuGou native pipe algorithm probe"', `OutFile "${nsisString(executable)}"`,
        '!include LogicLib.nsh', '!define PRODUCT_FILENAME "BKInstallerProbe"', 'Var ProbeReport',
        installerFunctionSource('BKRequestQuit'), 'Section',
        `  StrCpy $INSTDIR "${nsisString(installPath)}"`, `  StrCpy $BKProcessPid ${ready.advertisedPid}`,
        '  StrCpy $BKRequestedPids "|"', '  StrCpy $BKSupportedCount 0', '  StrCpy $BKQuitFailed 0',
        "  System::Call 'kernel32::GetTickCount()i.s'", '  Pop $BKQuitStart',
        '  Call BKRequestQuit', `  FileOpen $ProbeReport "${nsisString(report)}" w`,
        '  FileWrite $ProbeReport "$BKQuitFailed,$BKSupportedCount,$BKRequestedPids"',
        '  FileClose $ProbeReport', '  SetErrorLevel 0', 'SectionEnd', ''
      ].join('\n'), 'utf8')
      const compiled = spawnSync(compiler, ['/V2', '/INPUTCHARSET', 'UTF8', source], {
        cwd: root, encoding: 'utf8', timeout: 10000, windowsHide: true
      })
      assert.ifError(compiled.error)
      assert.equal(compiled.status, 0, `NSIS pipe probe compilation failed:\n${compiled.stdout}\n${compiled.stderr}`)
      const executed = spawnSync(executable, [], {
        cwd: directory, encoding: 'utf8', timeout: 3000, windowsHide: true, killSignal: 'SIGKILL'
      })
      assert.ifError(executed.error)
      assert.equal(executed.status, 0, `NSIS pipe probe failed:\n${executed.stderr}`)
      const output = fs.readFileSync(report, 'utf8')
      assert.equal(output, scenario === 'success' ? `0,1,|${ready.pid}|` : '1,1,|', `native pipe result for ${scenario}`)
      const done = await fixture.done()
      assert.equal(done.peerClosed, true)
      assert.deepEqual(done.commands, scenario === 'success' ? ['HELLO/1', 'QUIT/1'] : [], 'identity failures must not send a quit command')
      assert.deepEqual(await fixture.exit(), { code: 0, signal: null }, 'target fixture exits normally after the client closes its handle')
    })
  }
})
