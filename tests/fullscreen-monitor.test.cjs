const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
const { execFile } = require('node:child_process')
const { createWindowsForegroundMonitor } = require('../electron/services/windowsForeground')

const servicePath = path.resolve(__dirname, '../electron/services/fullscreenMonitor.js')
const probePath = path.resolve(__dirname, '../electron/services/windowsForeground.ps1')
const source = fs.readFileSync(servicePath, 'utf8')
const screenOne = { fullscreen: true, bounds: { x: 0, y: 0, width: 3840, height: 2160 } }
const flush = () => new Promise(resolve => setImmediate(resolve))

function adapterHarness(platform = 'win32', options = {}) {
  const calls = []
  const changes = []
  const errors = []
  let callbacks
  let nextStop
  const shared = {
    configure(value) { calls.push(['configure', value]); return Promise.resolve() },
    stop() { calls.push(['stop']); const pending = nextStop; nextStop = null; return pending || Promise.resolve() }
  }
  const module = { exports: {} }
  vm.runInNewContext(source, {
    module, __dirname: path.dirname(servicePath), process: { platform },
    require(name) {
      if (name === './windowsForeground') return { createWindowsForegroundMonitor(options) { callbacks = options; return shared } }
      return require(name)
    }
  }, { filename: servicePath })
  const monitor = module.exports.createFullscreenMonitor({
    platform, ...options, onChange: value => changes.push(JSON.parse(JSON.stringify(value))), logger: { warn: (...args) => errors.push(args) }
  })
  return { monitor, shared, calls, changes, errors, get callbacks() { return callbacks },
    delayStop() { let resolve; nextStop = new Promise(done => { resolve = done }); return resolve }
  }
}

test('adapter exposes unsupported platforms without creating the shared detector', async () => {
  for (const platform of ['darwin', 'linux']) {
    const h = adapterHarness(platform)
    assert.equal(h.monitor.supported, false)
    assert.equal(h.monitor.start(), false)
    assert.equal(h.monitor.isActive(), false)
    await h.monitor.stop()
    assert.equal(h.callbacks, undefined)
    assert.deepEqual(h.calls, [])
  }
})

test('adapter starts lazily in efficient mode, forwards changes once and clears on stop', async () => {
  const h = adapterHarness()
  assert.equal(h.monitor.supported, true)
  assert.equal(h.monitor.isActive(), false)
  assert.equal(h.callbacks.scriptPath, probePath)
  assert.deepEqual(h.calls, [])
  assert.equal(h.monitor.start(), true)
  assert.equal(h.monitor.start(), true)
  await flush()
  assert.equal(h.calls.filter(([name]) => name === 'configure').length, 1)
  const configured = h.calls.find(([name]) => name === 'configure')[1]
  assert.equal(configured.enabled, true)
  assert.equal(configured.efficientMode, true)
  h.callbacks.onChange(screenOne)
  h.callbacks.onChange(screenOne)
  const other = { fullscreen: true, bounds: { x: -2560, y: 0, width: 2560, height: 1440 } }
  h.callbacks.onChange(other)
  await h.monitor.stop()
  h.callbacks.onChange(screenOne)
  assert.deepEqual(h.changes, [screenOne, other, { fullscreen: false }])
  assert.equal(h.monitor.isActive(), false)
})

test('explicit bundled script path is forwarded unchanged to the shared ASAR reader', async () => {
  const bundled = path.join(path.parse(servicePath).root, 'resources', 'app.asar', 'electron', 'services', 'windowsForeground.ps1')
  const h = adapterHarness('win32', { scriptPath: bundled })
  h.monitor.start()
  await flush()
  assert.equal(h.callbacks.scriptPath, bundled)
  assert.equal(h.calls.filter(([name]) => name === 'configure').length, 1)
  await h.monitor.stop()
})

test('open-close-open races only configure the latest request after its cleanup finishes', async () => {
  const h = adapterHarness()
  const releaseOld = h.delayStop()
  h.monitor.start()
  await h.monitor.stop()
  const releaseNew = h.delayStop()
  h.monitor.start()
  await flush()
  assert.equal(h.calls.filter(([name]) => name === 'configure').length, 0)
  releaseOld()
  await flush()
  assert.equal(h.calls.filter(([name]) => name === 'configure').length, 0)
  releaseNew()
  await flush()
  assert.equal(h.calls.filter(([name]) => name === 'configure').length, 1)
  assert.equal(h.monitor.isActive(), true)
  await h.monitor.stop()
})

test('shared detector failure restores the island and the next explicit opening can retry', async () => {
  const h = adapterHarness()
  h.monitor.start()
  await flush()
  h.callbacks.onChange(screenOne)
  h.callbacks.onError(new Error('native unavailable'))
  assert.equal(h.monitor.isActive(), false)
  assert.deepEqual(h.changes, [screenOne, { fullscreen: false }])
  assert.match(h.errors[0][2].message, /native unavailable/)
  assert.equal(h.monitor.start(), true)
  await flush()
  assert.equal(h.calls.filter(([name]) => name === 'configure').length, 2)
  await h.monitor.stop()
})

function sharedHarness() {
  const children = []
  const errors = []
  const changes = []
  const timers = new Map()
  class Child extends EventEmitter {
    constructor() {
      super()
      this.pid = 100 + children.length
      this.stdout = new EventEmitter()
      this.stderr = new EventEmitter()
      this.stdin = new EventEmitter()
      this.requests = []
      this.stdin.write = value => this.requests.push(value)
      this.stdin.end = () => queueMicrotask(() => this.emit('exit', 0))
      this.kill = () => { queueMicrotask(() => this.emit('exit', 0)); return true }
    }
    sample(value) { this.stdout.emit('data', Buffer.from(JSON.stringify(value) + '\n')) }
  }
  const schedule = (fn, delay) => { const key = { unref() {} }; timers.set(key, { fn, delay }); return key }
  const monitor = createWindowsForegroundMonitor({
    platform: 'win32', scriptPath: probePath, readScript: () => '# fixed test script',
    spawnProcess: () => { const child = new Child(); children.push(child); return child },
    onChange: value => changes.push(value), onError: error => errors.push(error),
    timers: { setTimeout: schedule, setInterval: schedule, clearTimeout: key => timers.delete(key), clearInterval: key => timers.delete(key) }
  })
  return { monitor, children, errors, changes, timers, fire(delay) {
    const found = [...timers].find(([, value]) => value.delay === delay)
    assert.ok(found, `expected ${delay}ms timer`)
    timers.delete(found[0])
    found[1].fn()
  } }
}

test('shared process ignores retired output and a late exit after a replacement starts', async () => {
  const h = sharedHarness()
  await h.monitor.configure({ enabled: true, efficientMode: true })
  const old = h.children[0]
  old.sample({ ready: true })
  old.sample(screenOne)
  const stopped = h.monitor.configure({ enabled: false })
  await h.monitor.configure({ enabled: true })
  old.sample(screenOne)
  old.emit('exit', 0)
  h.children[1].sample({ ready: true })
  h.children[1].sample(screenOne)
  await stopped
  assert.deepEqual(h.changes, [screenOne, { fullscreen: false }, screenOne])
  assert.equal(h.errors.length, 0)
  await h.monitor.stop()
  assert.equal(h.timers.size, 0)
})

test('null JSON is rejected and final termination deadline cannot block app shutdown forever', async () => {
  const h = sharedHarness()
  await h.monitor.configure({ enabled: true })
  assert.doesNotThrow(() => h.children[0].sample(null))
  assert.equal(h.errors.length, 1)
  await h.monitor.stop()

  const stalled = sharedHarness()
  await stalled.monitor.configure({ enabled: true })
  stalled.children[0].stdin.end = () => {}
  let killed = 0
  stalled.children[0].kill = () => { killed += 1; return false }
  const stopped = stalled.monitor.stop()
  const rejected = assert.rejects(stopped, error => {
    assert.match(error.message, /清理失败/)
    assert.match(error.errors[0].message, /清理期限/)
    return true
  })
  stalled.fire(1500)
  stalled.fire(3000)
  await rejected
  assert.equal(killed, 1)
  assert.equal(stalled.timers.size, 0)
  await stalled.monitor.configure({ enabled: true })
  assert.equal(stalled.children.length, 1, 'the still-owned process prevents a duplicate probe')
  stalled.children[0].stdin.end = () => queueMicrotask(() => stalled.children[0].emit('exit', 0))
  await stalled.monitor.stop()
  assert.equal(stalled.timers.size, 0)
})

test('real Windows shared script completes its encoded stdin protocol without moving foreground windows',
  { skip: process.platform !== 'win32' }, async () => {
    const script = fs.readFileSync(probePath, 'utf8')
    const encoded = Buffer.from(`& {\n${script}\n} -OwnerProcessId ${process.pid}`, 'utf16le').toString('base64')
    const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const { stdout, stderr } = await new Promise((resolve, reject) => {
      const child = execFile(executable, ['-NoLogo', '-NoProfile', '-NonInteractive',
        '-EncodedCommand', encoded], { windowsHide: true, timeout: 15000, maxBuffer: 4096 }, (error, stdout, stderr) => {
        if (error) reject(error)
        else resolve({ stdout, stderr })
      })
      child.stdin.end('SAMPLE\nEXIT\n')
    })
    assert.equal(stderr.trim(), '')
    const messages = stdout.trim().split(/\r?\n/).map(line => JSON.parse(line.replace(/^\uFEFF/, '')))
    assert.deepEqual(messages[0], { ready: true })
    assert.equal(messages.length, 2)
    const sample = messages[1]
    assert.equal(typeof sample.fullscreen, 'boolean')
    assert.deepEqual(Object.keys(sample).sort(), sample.fullscreen ? ['bounds', 'fullscreen'] : ['fullscreen'])
    if (sample.fullscreen) {
      assert.deepEqual(Object.keys(sample.bounds).sort(), ['height', 'width', 'x', 'y'])
      for (const value of Object.values(sample.bounds)) assert.ok(Number.isInteger(value))
      assert.ok(sample.bounds.width > 0 && sample.bounds.height > 0)
    }
  })
