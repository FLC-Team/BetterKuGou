const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
const http = require('node:http')

function createService({ exitsOnKill = true, platform = 'win32', signalError = null, forkError = null, entryExists = true, httpAdapter = null } = {}) {
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
      if (name === 'fs') return { existsSync: () => entryExists }
      if (name === 'electron') return {
        utilityProcess: {
          fork() {
            if (forkError) throw forkError
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
      if (name === 'http') return httpAdapter || {
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
  assert.equal(await fixture.service.waitUntilReady(), false)
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

test('startup probes immediately and all callers share real HTTP readiness', async () => {
  const fixture = createService()
  assert.equal(await fixture.service.waitUntilReady(), false)
  fixture.service.start()
  const ready = fixture.service.waitUntilReady()
  assert.equal(ready, fixture.service.waitUntilReady())
  assert.equal(fixture.requests.length, 1)
  fixture.processes[0].stdout.emit('data', Buffer.from('server running @ http://localhost:6500'))
  let settled = false
  ready.then(() => { settled = true })
  await Promise.resolve()
  assert.equal(settled, false)
  fixture.requests[0].respond(200)
  assert.equal(await ready, true)
  assert.equal(fixture.statuses.at(-1).status, 'connected')
  assert.equal(fixture.requests[0].destroyed, true)
  assert.equal(fixture.timers.size, 0)
  await fixture.service.stop()
})

test('connection refusal and non-2xx responses retry until startup is actually ready', async () => {
  const fixture = createService()
  fixture.service.start()
  const ready = fixture.service.waitUntilReady()
  fixture.requests[0].emit('error', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))
  assert.equal(fixture.requests[0].destroyed, true)
  fixture.runTimer(100)
  fixture.requests[1].respond(503)
  assert.equal(fixture.statuses.some(status => status.status === 'connected'), false)
  assert.equal(fixture.requests[1].destroyed, true)
  fixture.runTimer(100)
  fixture.requests[2].respond(204)
  assert.equal(await ready, true)
  assert.equal(fixture.timers.size, 0)
  await fixture.service.stop()
})

test('explicit health checks immediately replace old requests and require successful HTTP responses', async () => {
  const fixture = createService()
  fixture.service.start()
  fixture.requests[0].respond(200)
  await fixture.service.waitUntilReady()
  fixture.service.checkHealth()
  fixture.service.checkHealth()
  assert.equal(fixture.requests[1].destroyed, true)
  fixture.requests[1].respond(200)
  fixture.requests[2].respond(503)
  assert.equal(fixture.statuses.at(-1).status, 'disconnected')
  assert.equal(await fixture.service.waitUntilReady(), false)
  fixture.service.checkHealth()
  fixture.requests[3].respond(200)
  assert.equal(fixture.statuses.at(-1).status, 'connected')
  assert.equal(await fixture.service.waitUntilReady(), true)
  await fixture.service.stop()
})

test('the overall startup deadline releases waiting callers and cancels requests or retries', async () => {
  for (const pendingRetry of [false, true]) {
    const fixture = createService()
    fixture.service.start()
    const ready = fixture.service.waitUntilReady()
    if (pendingRetry) fixture.requests[0].respond(503)
    fixture.runTimer(10_000)
    assert.equal(await ready, false)
    assert.equal(fixture.requests[0].destroyed, true)
    assert.equal(fixture.timers.size, 0)
    const statusCount = fixture.statuses.length
    fixture.requests[0].respond(200)
    assert.equal(fixture.statuses.length, statusCount)
    assert.equal(fixture.statuses.at(-1).status, 'error')
    await fixture.service.stop()
  }
})

test('launch failures, process errors, exits and stopping all release startup callers', async () => {
  for (const options of [{ entryExists: false }, { forkError: new Error('fork failed') }]) {
    const fixture = createService(options)
    assert.equal(fixture.service.start(), null)
    assert.equal(await fixture.service.waitUntilReady(), false)
    assert.equal(fixture.timers.size, 0)
    assert.equal(fixture.requests.length, 0)
  }
  for (const termination of ['error', 'exit', 'stop']) {
    const fixture = createService()
    const child = fixture.service.start()
    const ready = fixture.service.waitUntilReady()
    if (termination === 'stop') await fixture.service.stop()
    else child.emit(termination, termination === 'exit' ? 1 : new Error('process failed'))
    assert.equal(await ready, false)
    assert.equal(fixture.requests[0].destroyed, true)
    assert.equal(fixture.timers.size, 0)
    await fixture.service.stop()
  }
})

test('a request timeout during startup retries within the same deadline', async () => {
  const fixture = createService()
  fixture.service.start()
  const ready = fixture.service.waitUntilReady()
  fixture.requests[0].emit('timeout')
  assert.equal(fixture.requests[0].destroyed, true)
  fixture.runTimer(100)
  fixture.requests[1].respond(200)
  assert.equal(await ready, true)
  assert.equal(fixture.timers.size, 0)
  await fixture.service.stop()
})

test('a local HTTP server can become ready after an initial 503 without any fixed startup delay', async () => {
  let attempts = 0
  const server = http.createServer((_request, response) => {
    attempts += 1
    response.writeHead(attempts === 1 ? 503 : 200)
    response.end('ready')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  let finishFirstProbe
  const firstProbe = new Promise(resolve => { finishFirstProbe = resolve })
  let rejectProbe
  const failedProbe = new Promise((_resolve, reject) => { rejectProbe = reject })
  const fixture = createService({
    httpAdapter: {
      request(options, callback) {
        const request = http.request({ ...options, hostname: '127.0.0.1', port: server.address().port, timeout: 1000 }, response => {
          callback(response)
          finishFirstProbe()
        })
        request.on('error', rejectProbe)
        return request
      }
    }
  })
  try {
    fixture.service.start()
    const ready = fixture.service.waitUntilReady()
    await Promise.race([firstProbe, failedProbe])
    assert.equal(attempts, 1)
    fixture.runTimer(100)
    assert.equal(await Promise.race([ready, failedProbe]), true)
    assert.equal(attempts, 2)
    assert.equal(fixture.timers.size, 0)
  } finally {
    await fixture.service.stop()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
})

test('shutdown destroys pending health requests and suppresses stale callbacks', async () => {
  const fixture = createService()
  fixture.service.start()
  const ready = fixture.service.waitUntilReady()
  const request = fixture.requests[0]
  await fixture.service.stop()
  assert.equal(await ready, false)
  const statusCount = fixture.statuses.length
  assert.equal(request.destroyed, true)
  request.respond(200)
  request.emit('error', new Error('Late network failure'))
  assert.equal(fixture.statuses.length, statusCount)
  assert.equal(fixture.timers.size, 0)
})

test('health timeouts after startup report a disconnection and release the request', async () => {
  const fixture = createService()
  fixture.service.start()
  fixture.requests[0].respond(200)
  await fixture.service.waitUntilReady()
  fixture.service.checkHealth()
  fixture.requests[1].emit('timeout')
  assert.equal(fixture.statuses.at(-1).status, 'disconnected')
  assert.match(fixture.statuses.at(-1).error, /timed out/)
  assert.equal(fixture.requests[1].destroyed, true)
  await fixture.service.stop()
})

test('replacing a pending startup preserves the new readiness promise against old callbacks', async () => {
  const fixture = createService({ exitsOnKill: false })
  const previous = fixture.service.start()
  const oldReady = fixture.service.waitUntilReady()
  const oldRequest = fixture.requests[0]
  const pending = fixture.service.stop()
  assert.equal(await oldReady, false)
  fixture.runTimer(5000)
  fixture.killers[0].emit('close', 0)
  await pending
  const current = fixture.service.start()
  const ready = fixture.service.waitUntilReady()
  oldRequest.respond(200)
  previous.emit('exit', 1)
  assert.equal(fixture.service.waitUntilReady(), ready)
  assert.equal(fixture.statuses.some(status => status.status === 'connected'), false)
  fixture.requests[1].respond(200)
  assert.equal(await ready, true)
  const finalStop = fixture.service.stop()
  current.emit('exit', 0)
  await finalStop
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
