const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')

/** Fixed, private Win32 bridge. The renderer never supplies a HWND or script. */
function createWindowsTaskbarBridge({ scriptPath, handle, ownerProcessId = process.pid, spawnProcess = spawn,
  readScript = file => fs.readFileSync(file, 'utf8'), onError = () => {}, timers = { setTimeout, clearTimeout } }) {
  let child = null
  let sequence = 0
  let pending = new Map()
  let output = ''
  let readyPromise = null
  let stopping = null
  let exited = false
  let exitCode = null
  let forced = false
  let shutdownRequested = false
  let ownerDestroyed = false
  let failed = false
  let readyDeadline
  let rejectReady

  function fail(error) {
    if (failed) return
    failed = true
    timers.clearTimeout(readyDeadline)
    rejectReady?.(error)
    for (const item of pending.values()) { timers.clearTimeout(item.deadline); item.reject(error) }
    pending.clear()
    onError(error)
    void stop().catch(onError)
  }

  /** Encoded bundled source works within app.asar, without temporary executable files. */
  function start() {
    if (readyPromise) return readyPromise
    readyPromise = new Promise((resolve, reject) => {
      rejectReady = reject
      try {
        const hwnd = Buffer.isBuffer(handle) ? (handle.length >= 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE())) : BigInt(handle)
        const source = `& {\n${readScript(scriptPath)}\n} -OwnerWindow ${hwnd} -OwnerProcessId ${Number(ownerProcessId) || 0}`
        const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
        child = spawnProcess(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')],
          { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
        child.stdin.on('error', error => { if (!stopping) fail(error) })
        child.on('error', error => { if (!child.pid) exited = true; fail(error) })
        child.on('exit', code => { exited = true; exitCode = code; if (!stopping) fail(new Error(`任务栏检测进程已退出 (${code ?? 'unknown'})`)) })
        child.stderr.on('data', () => { if (!stopping) fail(new Error('任务栏原生检测不可用')) })
        child.stdout.on('data', bytes => {
          if (failed || stopping) return
          output += String(bytes)
          if (output.length > 262144) { fail(new Error('任务栏检测返回过大的数据')); return }
          let newline
          while ((newline = output.indexOf('\n')) >= 0) {
            const line = output.slice(0, newline).trim()
            output = output.slice(newline + 1)
            if (!line) continue
            let value
            try { value = JSON.parse(line) } catch { fail(new Error('任务栏检测返回无效数据')); return }
            if (value?.ready === true) { timers.clearTimeout(readyDeadline); resolve(); continue }
            const item = pending.get(value?.id)
            if (!item) continue
            pending.delete(value.id)
            timers.clearTimeout(item.deadline)
            if (value.ok === true) item.resolve(value)
            else item.reject(new Error(typeof value.error === 'string' ? value.error : '任务栏操作失败'))
          }
        })
        readyDeadline = timers.setTimeout(() => fail(new Error('任务栏检测初始化超时')), 10000)
        readyDeadline.unref?.()
      } catch (error) { fail(error) }
    })
    return readyPromise
  }

  async function request(command, payload = {}) {
    await start()
    if (failed || stopping || exited) throw new Error('任务栏检测已关闭')
    const id = ++sequence
    return new Promise((resolve, reject) => {
      const deadline = timers.setTimeout(() => fail(new Error(`任务栏 ${command} 响应超时`)), 3000)
      deadline.unref?.()
      pending.set(id, { resolve, reject, deadline })
      try { child.stdin.write(`${JSON.stringify({ ...payload, command, id })}\n`) } catch (error) { fail(error) }
    })
  }

  /** Only an orderly, unforced EXIT proves that PowerShell ran the Detach finally block. */
  function stop(options = {}) {
    if (options.ownerDestroyed === true) ownerDestroyed = true
    if (stopping) return stopping
    timers.clearTimeout(readyDeadline)
    rejectReady?.(new Error('任务栏检测已关闭'))
    for (const item of pending.values()) { timers.clearTimeout(item.deadline); item.reject(new Error('任务栏检测已关闭')) }
    pending.clear()
    const detached = () => ownerDestroyed || (shutdownRequested && !forced && exitCode === 0)
    const unsafeExit = () => new Error('任务栏检测异常结束，无法确认已解除嵌入；必须销毁自有歌词窗口')
    if (!child || !child.pid) return Promise.resolve()
    if (exited) return detached() ? Promise.resolve() : Promise.reject(unsafeExit())
    const task = new Promise((resolve, reject) => {
      let forceTimer, deadline
      const done = () => {
        timers.clearTimeout(forceTimer); timers.clearTimeout(deadline)
        if (detached()) resolve(); else reject(unsafeExit())
      }
      child.once('exit', done)
      forceTimer = timers.setTimeout(() => { forced = true; try { child.kill() } catch (error) { onError(error) } }, 1500)
      deadline = timers.setTimeout(() => {
        child.removeListener('exit', done)
        reject(new Error('任务栏原生检测进程未在清理期限内退出'))
      }, 3000)
      forceTimer.unref?.(); deadline.unref?.()
      try { child.stdin.end('EXIT\n'); shutdownRequested = true } catch (error) { onError(error) }
    })
    stopping = task
    const release = () => { if (stopping === task) stopping = null }
    void task.then(release, release)
    return task
  }

  return { start, request, stop }
}

module.exports = { createWindowsTaskbarBridge }
