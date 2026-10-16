const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')

function loadMain({ platform = 'win32', packaged = true, startFails = false } = {}) {
  const handlers = new Map(), windows = [], messages = [], completed = [], cancellations = [], failures = []
  let options, starts = 0, stops = 0
  const service = {
    start() { starts += 1; return startFails ? Promise.reject(new Error('pipe unavailable')) : Promise.resolve(true) },
    complete(...args) { completed.push(args); return true },
    cancel(errorCode, requestId) {
      cancellations.push({ errorCode, requestId })
      options.onPrepare({ phase: 'canceled', requestId, errorCode })
    },
    async stop() { stops += 1 }
  }
  const app = Object.assign(new EventEmitter(), {
    isPackaged: packaged, commandLine: { appendSwitch() {} },
    whenReady: () => new Promise(() => {}), getPath: () => '/user-data',
    getAppPath: () => '/app', getVersion: () => '1.0.0', quitCalls: 0,
    quit() { this.quitCalls += 1 }
  })
  const ipcMain = Object.assign(new EventEmitter(), { handle: (channel, callback) => handlers.set(channel, callback) })
  class Window extends EventEmitter {
    constructor() {
      super()
      this.destroyed = false
      this.webContents = Object.assign(new EventEmitter(), {
        mainFrame: {}, send: (...args) => messages.push(args), session: { clearCache: async () => {} },
        openDevTools() {}
      })
      windows.push(this)
    }
    isDestroyed() { return this.destroyed }
    loadURL() { return Promise.resolve() }
    show() {}
    focus() {}
    close() { this.destroyed = true; this.emit('closed') }
  }
  Window.getAllWindows = () => windows.filter(value => !value.destroyed)
  const logger = Object.fromEntries(['trace', 'info', 'error', 'warn'].map(name => [name,
    (...args) => { if (name === 'error') failures.push(args) }]))
  const context = vm.createContext({
    require(name) {
      if (name === 'electron') return {
        app, BrowserWindow: Window, ipcMain, globalShortcut: { unregisterAll() {} },
        dialog: {}, shell: {}, nativeImage: {}, Menu: {}, Tray: class {}
      }
      if (name === './logger') return logger
      if (name === './services/backendService') return { createBackendService: () => ({ stop: async () => {} }) }
      if (name === './services/updateService') return { createUpdateService() {} }
      if (name === './services/installQuitService') return { createInstallQuitService(value) { options = value; return service } }
      if (name === './settingsStore') return { getSettings: () => ({ software: { minimizeToTray: true } }) }
      return require(name)
    },
    __dirname: path.join(__dirname, '../electron'),
    process: { platform, env: { BK_SKIP_CHCP: '1' }, resourcesPath: '/resources' },
    console: logger, global: {}, setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {}
  })
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../electron/main.js'), 'utf8'), context)
  const api = vm.runInContext('({ createWindow, initializeInstallQuitService, performApplicationCleanup, broadcastPlayerControl })', context)
  api.createWindow()
  const main = windows[0]
  const event = { sender: main.webContents, senderFrame: main.webContents.mainFrame }
  function prepare(requestId) { return options.onPrepare({ requestId, phase: 'prepare' }) }
  function ready() { ipcMain.emit('renderer:ready', event) }
  function complete(requestId, result = { success: true }, source = event) {
    return handlers.get('updates:prepare-install-complete')(source, requestId, result)
  }
  return {
    api, app, main, event, messages, completed, cancellations, failures, prepare, ready, complete,
    options: () => options, starts: () => starts, stops: () => stops
  }
}

test('only Windows packaged clients create the pipe, and unavailable pipes do not prevent window readiness', async () => {
  for (const options of [{ platform: 'linux' }, { platform: 'darwin' }, { packaged: false }]) {
    const f = loadMain(options)
    f.api.initializeInstallQuitService()
    assert.equal(f.starts(), 0)
    await f.api.performApplicationCleanup()
  }
  const f = loadMain({ startFails: true })
  f.api.initializeInstallQuitService()
  f.api.initializeInstallQuitService()
  f.ready()
  await Promise.resolve()
  assert.equal(f.starts(), 1)
  assert.equal(f.failures.length, 1)
  await f.api.performApplicationCleanup()
  assert.equal(f.stops(), 1)
})

test('preparation waits for the ready main page and rejects wrong windows, subframes and request IDs', async () => {
  const f = loadMain()
  f.api.initializeInstallQuitService()
  assert.equal(f.prepare('not-ready'), false)
  f.ready()
  assert.equal(f.prepare('current'), true)
  assert.equal(f.messages.at(-1)[0], 'updates:prepare-install')
  assert.equal(f.messages.at(-1)[1].phase, 'prepare')
  const before = f.messages.length
  f.api.broadcastPlayerControl('next')
  assert.equal(f.messages.length, before, 'tray playback controls cannot race with the saved session snapshot')
  assert.equal(f.complete('current', { success: true }, { sender: {}, senderFrame: {} }).success, false)
  assert.equal(f.complete('current', { success: true }, { ...f.event, senderFrame: {} }).success, false)
  assert.equal(f.complete('old').success, false)
  assert.equal(f.completed.length, 0)
  assert.equal(f.complete('current').success, true)
  assert.equal(f.completed.length, 1)
  f.options().onQuit()
  assert.equal(f.app.quitCalls, 1)
  assert.equal(f.main.webContents.listenerCount('render-process-gone'), 0)
  let prevented = false
  f.main.emit('close', { preventDefault() { prevented = true } })
  assert.equal(prevented, false, 'normal installer quit bypasses tray hiding')
  await f.api.performApplicationCleanup()
})

test('main-frame reload, crash, destruction and closed windows cancel saving and release listeners', async () => {
  for (const kind of ['navigation', 'crash', 'destroyed', 'closed']) {
    const f = loadMain()
    f.api.initializeInstallQuitService()
    f.ready()
    f.prepare('current')
    f.main.webContents.emit('did-start-navigation', {}, 'subframe', false, false)
    f.main.webContents.emit('did-start-navigation', {}, 'hash', true, true)
    assert.equal(f.cancellations.length, 0)
    if (kind === 'navigation') f.main.webContents.emit('did-start-navigation', {}, 'reload', false, true)
    if (kind === 'crash') f.main.webContents.emit('render-process-gone', {}, {})
    if (kind === 'destroyed') f.main.webContents.emit('destroyed')
    if (kind === 'closed') f.main.emit('closed')
    assert.equal(f.cancellations.length, 1)
    assert.equal(f.complete('current').success, false)
    assert.equal(f.completed.length, 0)
    for (const event of ['did-start-navigation', 'render-process-gone', 'destroyed']) {
      assert.equal(f.main.webContents.listenerCount(event), 0)
    }
    await f.api.performApplicationCleanup()
  }
})

test('navigation changing the top frame rejects the old frame even before cancellation arrives', async () => {
  const f = loadMain()
  f.api.initializeInstallQuitService()
  f.ready()
  f.prepare('first')
  f.main.webContents.mainFrame = {}
  assert.equal(f.complete('first').success, false)
  assert.equal(f.complete('first', { success: true }, { sender: f.event.sender, senderFrame: f.main.webContents.mainFrame }).success, false)
  const cleanup = f.api.performApplicationCleanup()
  assert.equal(f.complete('first').success, false)
  await cleanup
  assert.equal(f.stops(), 1)
  assert.equal(f.main.webContents.listenerCount('did-start-navigation'), 0)
})
