const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')

function createService({ exitsOnKill = true, platform = 'win32', signalError = null } = {}) {
  const timers = new Map()
  const statuses = []
  const processes = []
  const requests = []
  const killers = []
  const signals = []
  const context = {
    module: { exports: {} },
    process: {
      platform,
      env: {},
      kill(pid, signal) {
        signals.push({ pid, signal })
        if (signalError) throw signalError
      }
    },
    console: { log() {}, warn() {}, error() {} },
    setTimeout(callback, delay) {
      const timer = { callback, delay }
      timers.set(timer, timer)
      return timer
    },
    clearTimeout(timer) { timers.delete(timer) },
    require(name) {
      if (name === '../logger') return Object.fromEntries(['trace', 'debug', 'info', 'warn', 'error'].map(level => [level, () => {}]))
      if (name === 'fs') return { existsSync: () => true }
      if (name === 'electron') return {
        utilityProcess: {
          fork() {
            const child = new EventEmitter()
            child.stdout = new EventEmitter()
            child.stderr = new EventEmitter()
            child.pid = 100 + processes.length
            child.killCount = 0
            child.kill = () => {
              child.killCount += 1
              if (exitsOnKill) child.emit('exit', 0)
            }
            processes.push(child)
            return child
          }
        }
      }
      if (name === 'child_process') return {
        spawn() {
          const killer = new EventEmitter()
          killers.push(killer)
          return killer
        }
      }
      if (name === 'http') return {
        request(_options, callback) {
          const request = new EventEmitter()
          request.end = () => {}
          request.destroy = (error) => {
            request.destroyed = true
            if (error) request.emit('error', error)
            request.emit('close')
          }
          request.respond = (statusCode) => callback({ statusCode, resume() {} })
          requests.push(request)
          return request
        }
      }
      return require(name)
    }
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../electron/services/backendService.js'), 'utf8'), context)
  const service = context.module.exports.createBackendService({
    isDev: true,
    developmentRoot: '/project',
    onStatus: (status) => statuses.push(status)
  })
  return {
    service, timers, statuses, processes, requests, killers, signals,
    runTimer(delay) {
      const timer = [...timers.values()].find((entry) => entry.delay === delay)
      assert.ok(timer, `Expected timer with delay ${delay}`)
      timers.delete(timer)
      timer.callback()
    }
  }
}

test('normal shutdown clears its timeout and temporary exit listener', async () => {
  const fixture = createService()
  fixture.service.start()
  const child = fixture.processes[0]
  await fixture.service.stop()
  assert.equal(child.killCount, 1)
  assert.equal(child.listenerCount('exit'), 0)
  assert.equal(fixture.timers.size, 0)
  assert.equal(fixture.service.isRunning(), false)
})

test('concurrent stop calls share one task and prevent startup during shutdown', async () => {
  const fixture = createService({ exitsOnKill: false })
  const child = fixture.service.start()
  const first = fixture.service.stop()
  const second = fixture.service.stop()
  assert.equal(first, second)
  assert.equal(fixture.service.start(), child)
  assert.equal(fixture.processes.length, 1)
  assert.equal(child.killCount, 1)
  child.emit('exit', 0)
  await first
  assert.equal(fixture.timers.size, 0)
  assert.equal(child.listenerCount('exit'), 0)
})

test('only successful HTTP responses report backend connectivity', async () => {
  const fixture = createService()
  fixture.service.start()
  fixture.runTimer(2000)
  fixture.runTimer(1000)
  fixture.requests[0].respond(503)
  assert.equal(fixture.statuses.at(-1).status, 'disconnected')
  fixture.service.checkHealth()
  assert.equal(fixture.requests[0].destroyed, true)
  fixture.runTimer(1000)
  fixture.requests[1].respond(200)
  assert.equal(fixture.statuses.at(-1).status, 'connected')
  await fixture.service.stop()
})

test('shutdown destroys pending health requests and suppresses stale callbacks', async () => {
  const fixture = createService()
  fixture.service.start()
  fixture.runTimer(2000)
  fixture.runTimer(1000)
  const request = fixture.requests[0]
  await fixture.service.stop()
  const statusCount = fixture.statuses.length
  assert.equal(request.destroyed, true)
  request.respond(200)
  request.emit('error', new Error('Late network failure'))
  assert.equal(fixture.statuses.length, statusCount)
  assert.equal(fixture.timers.size, 0)
})

test('health timeouts report a disconnection and release the request', async () => {
  const fixture = createService()
  fixture.service.start()
  fixture.runTimer(2000)
  fixture.runTimer(1000)
  fixture.requests[0].emit('timeout')
  assert.equal(fixture.statuses.at(-1).status, 'disconnected')
  assert.match(fixture.statuses.at(-1).error, /timed out/)
  assert.equal(fixture.requests[0].destroyed, true)
  await fixture.service.stop()
})

test('a delayed old process exit cannot clear a new backend after forced cleanup', async () => {
  const fixture = createService({ exitsOnKill: false })
  const previous = fixture.service.start()
  const pending = fixture.service.stop()
  fixture.runTimer(5000)
  fixture.killers[0].emit('close', 0)
  await pending
  assert.equal(previous.listenerCount('exit'), 1)
  const current = fixture.service.start()
  previous.emit('exit', 1)
  assert.equal(fixture.service.isRunning(), true)
  assert.equal(fixture.service.start(), current)
  assert.equal(fixture.timers.size, 1)
  const finalStop = fixture.service.stop()
  current.emit('exit', 0)
  await finalStop
})

test('failed forced cleanup releases its task and allows shutdown to be retried', async () => {
  const fixture = createService({ exitsOnKill: false })
  const child = fixture.service.start()
  const failedStop = fixture.service.stop()
  const rejected = assert.rejects(failedStop, /taskkill exited with code 1/)
  fixture.runTimer(5000)
  fixture.killers[0].emit('close', 1)
  await rejected
  assert.equal(child.listenerCount('exit'), 1)
  assert.equal(fixture.timers.size, 0)
  assert.equal(fixture.service.isRunning(), true)
  const retry = fixture.service.stop()
  assert.notEqual(retry, failedStop)
  child.emit('exit', 0)
  await retry
  assert.equal(child.listenerCount('exit'), 0)
  assert.equal(fixture.timers.size, 0)
})

test('non-Windows shutdown escalates to SIGKILL after the timeout', async () => {
  const fixture = createService({ exitsOnKill: false, platform: 'linux' })
  const child = fixture.service.start()
  const pending = fixture.service.stop()
  fixture.runTimer(5000)
  await pending
  assert.deepEqual(fixture.signals, [{ pid: child.pid, signal: 'SIGKILL' }])
  assert.equal(child.killCount, 1)
  assert.equal(fixture.service.isRunning(), false)
  assert.equal(fixture.timers.size, 0)
})

test('forced shutdown accepts an already exited PID and reports genuine signal errors', async () => {
  for (const code of ['ESRCH', 'EPERM']) {
    const fixture = createService({
      exitsOnKill: false,
      platform: 'darwin',
      signalError: Object.assign(new Error(code), { code })
    })
    const child = fixture.service.start()
    const pending = fixture.service.stop()
    const result = code === 'EPERM' ? assert.rejects(pending, /EPERM/) : pending
    fixture.runTimer(5000)
    await result
    assert.equal(fixture.service.isRunning(), code === 'EPERM')
    assert.equal(child.listenerCount('exit'), 1)
    assert.equal(fixture.timers.size, 0)
  }
})
