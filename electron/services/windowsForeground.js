const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')

/** Run one hidden, read-only Win32 helper while the external-fullscreen option is useful. */
function createWindowsForegroundMonitor({ scriptPath, platform = process.platform, ownerProcessId = process.pid,
  spawnProcess = spawn, readScript = file => fs.readFileSync(file, 'utf8'),
  onChange = () => {}, onError = () => {}, timers = { setTimeout, clearTimeout, setInterval, clearInterval } } = {}) {
  let childState = null
  let enabled = false
  let failed = false
  let interval = 100
  let snapshot = { fullscreen: false }
  const retiring = new Set()
  const publish = value => {
    if (JSON.stringify(value) !== JSON.stringify(snapshot)) { snapshot = value; onChange(value) }
  }
  const clearPolling = state => {
    timers.clearInterval(state.poll)
    timers.clearTimeout(state.deadline)
    state.poll = state.deadline = null
  }

  /** Stop only the child created here; stdin EOF also lets it exit if the application disappears. */
  function retire(state) {
    if (!state || state.stopping) return state?.stopping || Promise.resolve()
    clearPolling(state)
    if (childState === state) childState = null
    retiring.add(state)
    state.stopping = new Promise((resolve, reject) => {
      let forceTimer, deadline, settled = false
      const clean = () => {
        timers.clearTimeout(forceTimer)
        timers.clearTimeout(deadline)
        state.child.removeListener('exit', done)
      }
      const done = () => {
        if (settled) return
        settled = true
        state.exited = true
        clean()
        retiring.delete(state)
        resolve()
        start()
      }
      const failedStop = error => {
        if (settled) return
        settled = true
        clean()
        // Preserve the owned handle for a later stop retry instead of claiming that it exited.
        state.stopping = null
        reject(error)
      }
      state.child.once('exit', done)
      if (state.exited) { done(); return }
      forceTimer = timers.setTimeout(() => {
        // The handle belongs exclusively to this helper, never a foreground/user process.
        try {
          if (state.child.kill() === false && state.child.exitCode != null) done()
        } catch (error) { failedStop(error) }
      }, 1500)
      forceTimer?.unref?.()
      deadline = timers.setTimeout(() => failedStop(new Error('前台全屏检测进程未在清理期限内退出')), 3000)
      deadline?.unref?.()
      try { state.child.stdin.end('EXIT\n') } catch (error) { onError(error) }
    })
    return state.stopping
  }
  const fail = (state, error) => {
    if (childState !== state) return
    failed = true
    onError(error)
    publish({ fullscreen: false })
    void retire(state).catch(onError)
  }
  function requestSample(state) {
    if (childState !== state || !state.ready || state.pending) return
    state.pending = true
    state.deadline = timers.setTimeout(() => fail(state, new Error('前台全屏检测响应超时')), 2000)
    state.deadline?.unref?.()
    try { state.child.stdin.write('SAMPLE\n') } catch (error) { fail(state, error) }
  }
  function poll(state) {
    timers.clearInterval(state.poll)
    state.poll = timers.setInterval(() => requestSample(state), interval)
    state.poll?.unref?.()
    requestSample(state)
  }
  function start() {
    if (platform !== 'win32' || !enabled || failed || childState || retiring.size) return
    let child
    try {
      const script = readScript(scriptPath)
      // Node can read files inside app.asar; the OS receives the fixed bundled script, not an asar path.
      const source = `& {\n${script}\n} -OwnerProcessId ${Number(ownerProcessId) || 0}`
      const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      // windowsHide suppresses the console. PowerShell's additional -WindowStyle Hidden can
      // block console initialization when launched by Electron's GUI process.
      child = spawnProcess(executable, ['-NoLogo', '-NoProfile', '-NonInteractive',
        '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (error) { failed = true; onError(error); return }
    const state = { child, pending: false, ready: false, output: '', exited: false, stopping: null, poll: null, deadline: null }
    childState = state
    child.stdin.on('error', error => fail(state, error))
    child.on('error', error => {
      // A live child also emits error when signaling fails; only a failed spawn has no PID.
      if (child.pid == null) state.exited = true
      if (childState === state) fail(state, error)
      else onError(error)
    })
    child.on('exit', (code) => {
      state.exited = true
      if (childState === state) fail(state, new Error(`前台全屏检测已退出 (${code ?? 'unknown'})`))
    })
    child.stderr.on('data', () => fail(state, new Error('前台全屏检测不可用')))
    child.stdout.on('data', bytes => {
      if (childState !== state) return
      state.output += String(bytes)
      if (state.output.length > 4096) { fail(state, new Error('前台全屏检测返回无效数据')); return }
      let newline
      while ((newline = state.output.indexOf('\n')) >= 0) {
        const line = state.output.slice(0, newline).trim()
        state.output = state.output.slice(newline + 1)
        if (!line) continue
        let value
        try { value = JSON.parse(line) } catch { fail(state, new Error('前台全屏检测返回无效数据')); return }
        if (!value || typeof value !== 'object' || Array.isArray(value)) { fail(state, new Error('前台全屏检测返回无效状态')); return }
        timers.clearTimeout(state.deadline)
        state.deadline = null
        if (!state.ready && value.ready === true) { state.ready = true; poll(state); continue }
        if (!state.ready || !state.pending || typeof value.fullscreen !== 'boolean') { fail(state, new Error('前台全屏检测返回无效状态')); return }
        state.pending = false
        if (!value.fullscreen) publish({ fullscreen: false })
        else if (value.bounds && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(value.bounds[key])) &&
            value.bounds.width > 0 && value.bounds.height > 0) {
          publish({ fullscreen: true, bounds: Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, value.bounds[key]])) })
        } else { fail(state, new Error('前台全屏检测返回无效屏幕')); return }
      }
    })
    state.deadline = timers.setTimeout(() => fail(state, new Error('前台全屏检测初始化超时')), 10000)
    state.deadline?.unref?.()
  }
  function configure({ enabled: nextEnabled, efficientMode = false } = {}) {
    const nextInterval = efficientMode ? 300 : 100
    const wasEnabled = enabled
    enabled = nextEnabled === true && platform === 'win32'
    if (!enabled) {
      failed = false
      publish({ fullscreen: false })
      return wasEnabled || childState ? stop() : Promise.resolve()
    }
    if (!wasEnabled) failed = false
    const changed = interval !== nextInterval
    interval = nextInterval
    if (childState?.ready && changed) poll(childState)
    start()
    return Promise.resolve()
  }
  async function stop() {
    enabled = false
    failed = false
    publish({ fullscreen: false })
    const tasks = [...retiring].map(retire)
    tasks.push(retire(childState))
    const results = await Promise.allSettled(tasks)
    const failures = results.filter(result => result.status === 'rejected').map(result => result.reason)
    if (failures.length) throw new AggregateError(failures, '前台全屏检测清理失败')
  }
  return { configure, stop, getSnapshot: () => snapshot }
}

module.exports = { createWindowsForegroundMonitor }
