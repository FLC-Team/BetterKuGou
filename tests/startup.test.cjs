const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

function deferred() {
  let resolve
  let reject
  const promise = new Promise((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

/** Execute the real renderer entry with only Vue mounting, IPC and frame scheduling controlled. */
function startRenderer({ settings, backend, browser = false } = {}) {
  const calls = []
  const frames = []
  const diagnostics = []
  const component = {}
  const sandbox = {
    App: component,
    logger: Object.fromEntries(['error', 'warn'].map(level => [level, (...args) => diagnostics.push({ level, args })])),
    initSettings() { calls.push('settings'); return settings?.promise ?? Promise.resolve() },
    createApp(value) {
      assert.equal(value, component)
      calls.push('create')
      return { mount(target) { calls.push(`mount:${target}`) } }
    },
    requestAnimationFrame(callback) { calls.push('schedule-frame'); frames.push(callback); return frames.length },
    window: browser ? {} : {
      electronAPI: {
        waitForBackend() { calls.push('backend'); return backend?.promise ?? Promise.resolve(true) },
        notifyReady() { calls.push('ready') }
      }
    }
  }
  const source = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8')
    .replace(/^import\b[^\n]*$/gm, '')
    .replace('void bootstrap()', 'globalThis.startupTask = bootstrap()')
  vm.runInNewContext(source, sandbox)
  return { calls, frames, diagnostics, task: sandbox.startupTask }
}

const flush = () => new Promise(resolve => setImmediate(resolve))

for (const first of ['settings', 'backend']) {
  test(`renderer waits for both startup gates when ${first} finishes first`, async () => {
    const settings = deferred()
    const backend = deferred()
    const startup = startRenderer({ settings, backend })
    assert.deepEqual(startup.calls, ['settings', 'backend'], 'both independent reads start immediately')
    const gates = { settings, backend }
    gates[first].resolve(true)
    await flush()
    assert.deepEqual(startup.calls, ['settings', 'backend'])
    assert.equal(startup.frames.length, 0)
    gates[first === 'settings' ? 'backend' : 'settings'].resolve(true)
    await startup.task
    assert.deepEqual(startup.calls, ['settings', 'backend', 'create', 'mount:#app', 'schedule-frame'])
  })
}

test('a failed settings read still waits for backend readiness before mounting', async () => {
  const settings = deferred()
  const backend = deferred()
  const startup = startRenderer({ settings, backend })
  const failure = new Error('settings unavailable')
  settings.reject(failure)
  await flush()
  assert.deepEqual(startup.calls, ['settings', 'backend'])
  backend.resolve(true)
  await startup.task
  assert.equal(startup.calls.includes('mount:#app'), true)
  assert.equal(startup.diagnostics.length, 1)
  assert.equal(startup.diagnostics[0].level, 'error')
  assert.equal(startup.diagnostics[0].args.at(-1), failure)
})

for (const failure of ['false', 'rejected']) {
  test(`backend ${failure} result permits mounting after settings finish`, async () => {
    const settings = deferred()
    const backend = deferred()
    const startup = startRenderer({ settings, backend })
    const reason = new Error('backend unavailable')
    if (failure === 'false') backend.resolve(false)
    else backend.reject(reason)
    await flush()
    assert.deepEqual(startup.calls, ['settings', 'backend'])
    settings.resolve()
    await startup.task
    assert.equal(startup.calls.includes('mount:#app'), true)
    assert.equal(startup.diagnostics.length, 1)
    assert.equal(startup.diagnostics[0].level, 'warn')
    if (failure === 'rejected') assert.equal(startup.diagnostics[0].args.at(-1), reason)
  })
}

test('browser preview mounts without an Electron bridge and its frame callback remains safe', async () => {
  const startup = startRenderer({ browser: true })
  await startup.task
  assert.deepEqual(startup.calls, ['settings', 'create', 'mount:#app', 'schedule-frame'])
  assert.equal(startup.diagnostics.length, 0)
  assert.equal(startup.frames.length, 1)
  assert.doesNotThrow(() => startup.frames[0]())
})

test('renderer readiness is sent only after mounting and the first scheduled frame', async () => {
  const startup = startRenderer()
  assert.deepEqual(startup.calls, ['settings', 'backend'])
  await startup.task
  assert.equal(startup.calls.includes('ready'), false)
  assert.equal(startup.frames.length, 1)
  assert.ok(startup.calls.indexOf('mount:#app') < startup.calls.indexOf('schedule-frame'))
  startup.frames[0]()
  assert.deepEqual(startup.calls, ['settings', 'backend', 'create', 'mount:#app', 'schedule-frame', 'ready'])
})
