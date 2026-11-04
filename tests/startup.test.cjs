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
function startRenderer({ settings, backend, failure, browser = false } = {}) {
  const calls = []
  const frames = []
  const diagnostics = []
  const component = {}
  const NotificationRoot = {}
  const AppNotice = {}
  let shell
  const sandbox = {
    App: component,
    NotificationRoot,
    AppNotice,
    h: (type, props, slots) => ({ type, props, slots }),
    logger: Object.fromEntries(['error', 'warn'].map(level => [level, (...args) => diagnostics.push({ level, args })])),
    initSettings() { calls.push('settings'); return settings?.promise ?? Promise.resolve() },
    createApp(value) {
      calls.push('create')
      return {
        component(name, registered) { assert.equal(name, 'AppNotice'); assert.equal(registered, AppNotice); calls.push('register-notice') },
        mount(target) { calls.push(`mount:${target}`); shell = value.render(); assert.equal(shell.type, NotificationRoot) }
      }
    },
    requestAnimationFrame(callback) { calls.push('schedule-frame'); frames.push(callback); return frames.length },
    window: browser ? {} : {
      electronAPI: {
        getStartupFailure() { calls.push('startup-failure'); return failure?.promise ?? Promise.resolve(null) },
        waitForBackend() { calls.push('backend'); return backend?.promise ?? Promise.resolve(true) },
        notifyReady() { calls.push('ready') }
      }
    }
  }
  const source = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8')
    .replace(/^import\b[^\n]*$/gm, '')
    .replace('void bootstrap()', 'globalThis.startupTask = bootstrap()')
  vm.runInNewContext(source, sandbox)
  return { calls, frames, diagnostics, task: sandbox.startupTask, shell: () => shell, component }
}

const flush = () => new Promise(resolve => setImmediate(resolve))

for (const first of ['settings', 'backend']) {
  test(`renderer waits for both startup gates when ${first} finishes first`, async () => {
    const settings = deferred()
    const backend = deferred()
    const startup = startRenderer({ settings, backend })
    await flush()
    assert.deepEqual(startup.calls, ['startup-failure', 'settings', 'backend'], 'both independent reads start together after the startup-failure check')
    const gates = { settings, backend }
    gates[first].resolve(true)
    await flush()
    assert.deepEqual(startup.calls, ['startup-failure', 'settings', 'backend'])
    assert.equal(startup.frames.length, 0)
    gates[first === 'settings' ? 'backend' : 'settings'].resolve(true)
    await startup.task
    assert.deepEqual(startup.calls, ['startup-failure', 'settings', 'backend', 'create', 'register-notice', 'mount:#app'])
    assert.equal(startup.shell().props.startupFailure, null)
    assert.equal(startup.shell().slots.default().type, startup.component)
  })
}

test('a failed settings read still waits for backend readiness before mounting', async () => {
  const settings = deferred()
  const backend = deferred()
  const startup = startRenderer({ settings, backend })
  await flush()
  const failure = new Error('settings unavailable')
  settings.reject(failure)
  await flush()
  assert.deepEqual(startup.calls, ['startup-failure', 'settings', 'backend'])
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
    await flush()
    const reason = new Error('backend unavailable')
    if (failure === 'false') backend.resolve(false)
    else backend.reject(reason)
    await flush()
    assert.deepEqual(startup.calls, ['startup-failure', 'settings', 'backend'])
    settings.resolve()
    await startup.task
    assert.equal(startup.calls.includes('mount:#app'), true)
    assert.equal(startup.diagnostics.length, 1)
    assert.equal(startup.diagnostics[0].level, 'warn')
    if (failure === 'rejected') assert.equal(startup.diagnostics[0].args.at(-1), reason)
  })
}

test('browser preview mounts the same notification shell without an Electron bridge', async () => {
  const startup = startRenderer({ browser: true })
  await startup.task
  assert.deepEqual(startup.calls, ['settings', 'create', 'register-notice', 'mount:#app'])
  assert.equal(startup.diagnostics.length, 0)
  assert.equal(startup.frames.length, 0, 'readiness belongs to the mounted notification shell')
})

test('a fatal startup failure mounts the notification shell without starting normal application work', async () => {
  const failure = deferred()
  const startup = startRenderer({ failure })
  assert.deepEqual(startup.calls, ['startup-failure'])
  const report = { title: '启动失败', message: '本地服务无法启动' }
  failure.resolve(report)
  await startup.task
  assert.deepEqual(startup.calls, ['startup-failure', 'create', 'register-notice', 'mount:#app'])
  assert.equal(startup.shell().props.startupFailure, report)
})

test('a failed startup-failure query still initializes settings and backend before showing the app', async () => {
  const failure = deferred()
  const startup = startRenderer({ failure })
  failure.reject(new Error('startup query unavailable'))
  await startup.task
  assert.ok(startup.calls.includes('settings'))
  assert.ok(startup.calls.includes('backend'))
  assert.equal(startup.shell().props.startupFailure, null)
  assert.equal(startup.diagnostics.length, 1)
})

/** Run the real shell lifecycle while controlling only browser mounting and frame scheduling. */
function notificationShell({ browser = false } = {}) {
  const vue = require('vue')
  const tick = deferred()
  const calls = [], frames = [], listeners = new Map()
  let mount, unmount
  const element = () => ({
    style: {}, isConnected: true, children: [],
    setAttribute() {}, append(...nodes) { this.children.push(...nodes) },
    attachShadow() { this.shadowRoot = element(); return this.shadowRoot },
    addEventListener: (name, handler) => listeners.set(name, handler),
    removeEventListener: name => listeners.delete(name),
    remove() { this.isConnected = false; calls.push('remove') }, querySelector() { return null }
  })
  const sandbox = {
    ...vue, defineProps() {}, fueStyles: '',
    onMounted: callback => { mount = callback }, onBeforeUnmount: callback => { unmount = callback },
    nextTick: () => tick.promise,
    document: { body: element(), createElement: element,
      addEventListener: (name, handler) => listeners.set(`document:${name}`, handler),
      removeEventListener: name => listeners.delete(`document:${name}`) },
    window: browser ? {} : { electronAPI: { notifyReady() { calls.push('ready') } } },
    requestAnimationFrame(callback) { calls.push('schedule-frame'); frames.push(callback); return frames.length },
    cancelAnimationFrame(id) { if (id) frames[id - 1] = null }
  }
  const source = fs.readFileSync(path.join(__dirname, '../src/components/common/NotificationRoot.vue'), 'utf8')
    .match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/^import\b[^\n]*$/gm, '')
  vm.runInNewContext(source, sandbox)
  return { tick, calls, frames, listeners, mount, unmount }
}

for (const browser of [false, true]) {
  test(`notification readiness waits for provider children and the first frame (browser: ${browser})`, async () => {
    const shell = notificationShell({ browser })
    const mounted = shell.mount()
    assert.equal(shell.frames.length, 0)
    shell.tick.resolve()
    await mounted
    assert.equal(shell.calls.includes('ready'), false)
    assert.equal(shell.frames.length, 1)
    assert.doesNotThrow(() => shell.frames[0]())
    assert.equal(shell.calls.includes('ready'), !browser)
    shell.unmount()
    assert.equal(shell.listeners.size, 0)
    assert.ok(shell.calls.includes('remove'))
  })
}

test('unmounting the notification shell before its next tick cannot announce readiness', async () => {
  const startup = notificationShell()
  const mounting = startup.mount()
  startup.unmount()
  startup.tick.resolve()
  await mounting
  assert.equal(startup.calls.includes('ready'), false)
  assert.equal(startup.frames.length, 0)
  assert.equal(startup.listeners.size, 0)
})
