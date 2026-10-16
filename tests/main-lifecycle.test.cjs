const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')

function loadMain({ uninitialized = false } = {}) {
  const windows = []
  const timers = new Map()
  let timerId = 0
  let stopCalls = 0
  let releaseStop
  const stopGate = new Promise(resolve => { releaseStop = resolve })
  const app = new EventEmitter()
  app.isPackaged = false
  app.commandLine = { appendSwitch() {} }
  app.whenReady = () => new Promise(() => {})
  app.getPath = () => '/user-data'
  app.quitCalls = 0
  app.quit = () => { app.quitCalls += 1 }
  class Window extends EventEmitter {
    constructor(options) {
      super()
      this.options = options
      this.hidden = false
      this.destroyed = false
      this.webContents = Object.assign(new EventEmitter(), {
        send() {}, openDevTools() {}, session: { clearCache: async () => {} }
      })
      windows.push(this)
    }
    isDestroyed() { return this.destroyed }
    loadURL() { return Promise.resolve() }
    loadFile() { return Promise.resolve() }
    hide() { this.hidden = true }
    show() {}
    focus() {}
    close() { this.destroyed = true; this.emit('closed') }
  }
  Window.getAllWindows = () => windows.filter(window => !window.destroyed)
  const electron = {
    app, BrowserWindow: Window,
    ipcMain: Object.assign(new EventEmitter(), { handle() {} }),
    globalShortcut: { unregisterAll() {} }, dialog: {}, shell: {},
    nativeImage: { createFromPath: () => ({}) }, Tray: class {}, Menu: {}
  }
  const silent = Object.fromEntries(['log', 'debug', 'info', 'warn', 'error', 'trace'].map(method => [method, () => {}]))
  const context = vm.createContext({
    require(name) {
      if (name === 'electron') return electron
      if (name === './logger') return silent
      if (name === './services/updateService') return { createUpdateService: () => ({ configure() {}, stop: async () => {} }) }
      if (name === './services/backendService') return { createBackendService: () => ({
        start() {}, stop: () => { stopCalls += 1; return stopGate }
      }) }
      if (name === './settingsStore') return { getSettings: () => {
        if (uninitialized) throw new Error('Settings store not initialized')
        return { software: { minimizeToTray: true } }
      } }
      return require(name)
    },
    __dirname: path.join(__dirname, '../electron'),
    process: { platform: 'linux', resourcesPath: '/resources', env: {}, memoryUsage: process.memoryUsage },
    console: silent, global: {},
    setTimeout(callback, delay) { timers.set(++timerId, { callback, delay }); return timerId },
    clearTimeout(id) { timers.delete(id) },
    setInterval(callback, delay) { timers.set(++timerId, { callback, delay }); return timerId },
    clearInterval(id) { timers.delete(id) }
  })
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../electron/main.js'), 'utf8'), context)
  const api = vm.runInContext('({ createWindow, createLoadingWindow, createDesktopLyricWindow, performApplicationCleanup, startMemoryCleanup, stopMemoryCleanup })', context)
  return { api, app, windows, timers, releaseStop, stopCalls: () => stopCalls }
}

test('explicit quit allows the main window to close despite minimize-to-tray', async () => {
  const fixture = loadMain()
  fixture.api.createWindow()
  const pending = fixture.api.performApplicationCleanup()
  await Promise.resolve()
  fixture.releaseStop()
  await pending
  let prevented = false
  fixture.windows[0].emit('close', { preventDefault: () => { prevented = true } })
  assert.equal(prevented, false)
  assert.equal(fixture.windows[0].hidden, false)
})

test('concurrent before-quit waits for one complete backend cleanup', async () => {
  const fixture = loadMain()
  const handler = fixture.app.listeners('before-quit')[0]
  let prevented = 0
  const event = { preventDefault: () => { prevented += 1 } }
  const first = handler(event)
  const second = handler(event)
  await Promise.resolve()
  assert.equal(prevented, 2)
  assert.equal(fixture.stopCalls(), 1)
  assert.equal(fixture.app.quitCalls, 0)
  fixture.releaseStop()
  await Promise.all([first, second])
  assert.equal(fixture.app.quitCalls, 1)
  await handler(event)
  assert.equal(prevented, 2)
})

test('every renderer window uses the isolated preload and memory cleanup timers are released', () => {
  const fixture = loadMain()
  fixture.api.createWindow()
  fixture.api.createLoadingWindow()
  fixture.api.createDesktopLyricWindow()
  for (const window of fixture.windows) {
    assert.equal(window.options.webPreferences.nodeIntegration, false)
    assert.equal(window.options.webPreferences.contextIsolation, true)
    assert.ok(window.options.webPreferences.preload.endsWith('preload.js'))
  }
  fixture.api.startMemoryCleanup()
  fixture.api.startMemoryCleanup()
  assert.equal(fixture.timers.size, 1)
  fixture.api.stopMemoryCleanup()
  assert.equal(fixture.timers.size, 0)
})

test('closing the last window during failed startup cleanup never reads uninitialized settings', async () => {
  const fixture = loadMain({ uninitialized: true })
  fixture.api.createLoadingWindow()
  const cleanup = fixture.api.performApplicationCleanup()
  await Promise.resolve()
  await assert.doesNotReject(fixture.app.listeners('window-all-closed')[0]())
  fixture.releaseStop()
  await cleanup
})
