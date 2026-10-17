const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')

function loadMain({ uninitialized = false, platform = 'linux', packaged = false, toolbarResult = true, missingIcon = false } = {}) {
  const windows = []
  const timers = new Map()
  const iconPaths = []
  const warnings = []
  let timerId = 0
  let stopCalls = 0
  let startCalls = 0
  let releaseReady
  let releaseBackend
  const readyGate = new Promise(resolve => { releaseReady = resolve })
  const backendGate = new Promise(resolve => { releaseBackend = resolve })
  let releaseStop
  const stopGate = new Promise(resolve => { releaseStop = resolve })
  let signalBackendStop
  const backendStopStarted = new Promise(resolve => { signalBackendStop = resolve })
  const app = new EventEmitter()
  app.isPackaged = packaged
  app.commandLine = { appendSwitch() {} }
  app.whenReady = () => readyGate
  app.getPath = () => '/user-data'
  app.getAppPath = () => '/app'
  app.getVersion = () => '0.1.0'
  app.quitCalls = 0
  app.quit = () => { app.quitCalls += 1 }
  class Window extends EventEmitter {
    constructor(options) {
      super()
      this.options = options
      this.hidden = false
      this.destroyed = false
      this.showCalls = 0
      this.sent = []
      this.thumbarCalls = []
      this.thumbarButtons = null
      this.thumbarResult = toolbarResult
      this.webContents = Object.assign(new EventEmitter(), {
        send: (...args) => this.sent.push(args), mainFrame: {},
        openDevTools() {}, session: { clearCache: async () => {} }
      })
      windows.push(this)
    }
    isDestroyed() { return this.destroyed }
    loadURL() { return Promise.resolve() }
    loadFile() { return Promise.resolve() }
    hide() { this.hidden = true }
    show() { this.showCalls += 1; this.emit('show') }
    focus() {}
    getBounds() { return { x: this.options.x, y: this.options.y, width: this.options.width, height: this.options.height } }
    setBounds(bounds) { Object.assign(this.options, bounds) }
    close() { this.destroyed = true; this.emit('closed') }
    setThumbarButtons(buttons) {
      this.thumbarCalls.push(buttons)
      // Electron 32 accepts an empty flag list for enabled buttons; "enabled" rejects registration.
      const supportedFlags = new Set(['disabled', 'dismissonclick', 'nobackground', 'hidden', 'noninteractive'])
      if (buttons.some(button => (button.flags || []).some(flag => !supportedFlags.has(flag)))) return false
      if (this.thumbarResult instanceof Error) throw this.thumbarResult
      if (this.thumbarResult) this.thumbarButtons = buttons
      return this.thumbarResult
    }
  }
  Window.getAllWindows = () => windows.filter(window => !window.destroyed)
  const handlers = new Map()
  const ipcMain = Object.assign(new EventEmitter(), { handle: (channel, callback) => handlers.set(channel, callback) })
  const electron = {
    app, BrowserWindow: Window,
    ipcMain,
    globalShortcut: { unregisterAll() {} }, dialog: {}, shell: {},
    nativeImage: { createFromPath: filename => {
      iconPaths.push(filename)
      const image = { path: filename, isEmpty: () => missingIcon, resize: () => image }
      return image
    } },
    Tray: class extends EventEmitter { setContextMenu() {} setToolTip() {} destroy() {} },
    Menu: { buildFromTemplate: value => value }
  }
  const silent = Object.fromEntries(['log', 'debug', 'info', 'warn', 'error', 'trace'].map(method => [method, () => {}]))
  silent.warn = (...args) => warnings.push(args)
  const context = vm.createContext({
    require(name) {
      if (name === 'electron') return electron
      if (name === './logger') return silent
      if (name === './services/playlistCacheService') return { createPlaylistCacheService: () => ({ configure() {}, stop: async () => {} }) }
      if (name === './services/updateService') return { createUpdateService: () => ({ configure() {}, stop: async () => {} }) }
      if (name === './services/backendService') return { createBackendService: () => ({
        start() { startCalls += 1 }, waitUntilReady: () => backendGate,
        stop: () => { stopCalls += 1; signalBackendStop(); return stopGate }
      }) }
      if (name === './settingsStore') return {
        initSettingsStore: async () => {}, ensureCacheDirectory: async () => {},
        onSettingsChange: () => () => {}, getSettings: () => {
        if (uninitialized) throw new Error('Settings store not initialized')
        return { software: { minimizeToTray: true, updates: {} } }
      } }
      return require(name)
    },
    __dirname: path.join(__dirname, '../electron'),
    process: { platform, resourcesPath: '/resources', env: { BK_SKIP_CHCP: '1' }, memoryUsage: process.memoryUsage },
    console: silent, global: {},
    setTimeout(callback, delay) { timers.set(++timerId, { callback, delay }); return timerId },
    clearTimeout(id) { timers.delete(id) },
    setInterval(callback, delay) { timers.set(++timerId, { callback, delay }); return timerId },
    clearInterval(id) { timers.delete(id) }
  })
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../electron/main.js'), 'utf8'), context)
  const api = vm.runInContext('({ createWindow, createLoadingWindow, createDesktopLyricWindow, performApplicationCleanup, startMemoryCleanup, stopMemoryCleanup, broadcastPlayerControl, updateTaskbarButtons, notifyInstallPreparation })', context)
  return { api, app, windows, timers, releaseStop, releaseReady, releaseBackend, backendStopStarted, ipcMain, handlers, iconPaths, warnings,
    stopCalls: () => stopCalls, startCalls: () => startCalls }
}

test('startup creates the main window immediately and only its mounted top frame can reveal it', async () => {
  const fixture = loadMain()
  fixture.releaseReady()
  for (let i = 0; i < 8; i++) await Promise.resolve()
  assert.equal(fixture.startCalls(), 1)
  assert.equal(fixture.windows.length, 2)
  const [loading, main] = fixture.windows
  assert.equal(fixture.timers.size, 0, 'window creation must not use a fixed startup delay')
  main.webContents.emit('did-finish-load')
  assert.equal(main.showCalls, 0, 'document load does not imply Vue has mounted')
  const event = { sender: main.webContents, senderFrame: main.webContents.mainFrame }
  const wait = fixture.handlers.get('backend:ready')(event)
  assert.equal(await fixture.handlers.get('backend:ready')({ sender: loading.webContents }), false)
  fixture.releaseBackend(true)
  assert.equal(await wait, true)
  fixture.api.broadcastPlayerControl('pause')
  assert.equal(main.sent.some(args => args[0] === 'player:control'), false)
  fixture.ipcMain.emit('renderer:ready', { ...event, senderFrame: {} })
  assert.equal(main.showCalls, 0)
  fixture.ipcMain.emit('renderer:ready', event)
  assert.equal(main.showCalls, 1)
  assert.equal(loading.destroyed, true)
  assert.ok(main.sent.some(args => args[0] === 'player:control' && args[1] === 'pause'))
  fixture.ipcMain.emit('renderer:ready', event)
  assert.equal(main.showCalls, 1, 'repeated readiness cannot refocus the window')
  const cleanup = fixture.api.performApplicationCleanup()
  fixture.releaseStop()
  await cleanup
  assert.equal(fixture.timers.size, 0)
})

test('a readiness message during exit cannot reopen a hidden startup window', async () => {
  const fixture = loadMain()
  fixture.api.createWindow()
  const main = fixture.windows[0]
  const cleanup = fixture.api.performApplicationCleanup()
  fixture.ipcMain.emit('renderer:ready', { sender: main.webContents, senderFrame: main.webContents.mainFrame })
  fixture.api.createWindow()
  assert.equal(main.showCalls, 0)
  assert.equal(fixture.windows.length, 1)
  fixture.releaseStop()
  await cleanup
})

test('desktop playback availability follows main reload, readiness, crash and install preparation', () => {
  const fixture = loadMain()
  fixture.api.createWindow()
  const main = fixture.windows[0]
  const desktop = fixture.api.createDesktopLyricWindow()
  desktop.emit('ready-to-show')
  const event = mainEvent(main)
  const latest = () => desktop.sent.filter(([channel]) => channel === 'desktop-lyric:playback-update').at(-1)[1]
  fixture.ipcMain.emit('player:track-update', event, { trackId: 'song', title: 'Song' })
  assert.equal(latest().available, false)
  fixture.ipcMain.emit('renderer:ready', event)
  assert.equal(latest().available, true)
  fixture.ipcMain.emit('player:playback-state', event, 'playing')
  main.webContents.emit('did-start-navigation', {}, 'app://reload', false, true)
  assert.equal(latest().available, false)
  assert.equal(latest().playing, false)
  fixture.ipcMain.emit('renderer:ready', event)
  assert.equal(latest().available, true)
  fixture.api.notifyInstallPreparation({ requestId: 'one', phase: 'prepare' })
  assert.equal(latest().available, false)
  fixture.api.notifyInstallPreparation({ requestId: 'one', phase: 'canceled' })
  assert.equal(latest().available, true)
  main.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
  assert.equal(latest().available, false)
  fixture.ipcMain.emit('renderer:ready', event)
  assert.equal(latest().available, true)
  main.close()
  assert.equal(latest().available, false)
  assert.equal(latest().playing, false)
  desktop.close()
  fixture.api.stopMemoryCleanup()
  assert.equal(fixture.timers.size, 0)
})

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
  await fixture.backendStopStarted
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
  const windowTimers = new Map(fixture.timers)
  fixture.api.startMemoryCleanup()
  fixture.api.startMemoryCleanup()
  assert.equal(fixture.timers.size, windowTimers.size + 1)
  const memoryTimer = [...fixture.timers].find(([id]) => !windowTimers.has(id))
  assert.equal(memoryTimer[1].delay, 30 * 60 * 1000)
  fixture.api.stopMemoryCleanup()
  assert.deepEqual(fixture.timers, windowTimers, 'stopping memory cleanup preserves unrelated window readiness timers')
  fixture.windows.at(-1).close()
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

function mainEvent(window) {
  return { sender: window.webContents, senderFrame: window.webContents.mainFrame }
}

function latestTaskbar(window) {
  const buttons = window.thumbarButtons
  assert.equal(buttons?.length, 3, 'Windows preview must expose exactly three transport buttons')
  return buttons
}

function assertTaskbarEnabled(window, enabled) {
  for (const button of latestTaskbar(window)) {
    assert.equal(button.flags?.includes('disabled') === true, !enabled)
  }
}

function playerActions(window) {
  return window.sent.filter(([channel]) => channel === 'player:control').map(([, action]) => action)
}

test('Windows thumbnail controls wait for renderer readiness and reuse the existing player channel', () => {
  const fixture = loadMain({ platform: 'win32' })
  fixture.api.createWindow()
  const main = fixture.windows[0]
  main.emit('ready-to-show')
  assertTaskbarEnabled(main, false)
  const initial = latestTaskbar(main)
  assert.deepEqual(Array.from(initial, button => button.tooltip), ['上一首', '播放', '下一首'])
  initial.forEach(button => button.click())
  assert.deepEqual(playerActions(main), [])

  fixture.ipcMain.emit('renderer:ready', mainEvent(main))
  assertTaskbarEnabled(main, true)
  assert.deepEqual(playerActions(main), [], 'disabled startup clicks must not be replayed after mount')
  latestTaskbar(main).forEach(button => button.click())
  assert.deepEqual(playerActions(main), ['prev', 'play', 'next'])
})

test('taskbar pause icons follow playback and retained callbacks read the latest state', () => {
  const fixture = loadMain({ platform: 'win32' })
  fixture.api.createWindow()
  const main = fixture.windows[0]
  fixture.ipcMain.emit('renderer:ready', mainEvent(main))
  const playButton = latestTaskbar(main)[1]
  assert.ok(playButton.icon.path.endsWith(path.join('taskbar', 'play.png')))

  fixture.ipcMain.emit('player:playback-state', mainEvent(main), 'playing')
  const pauseButton = latestTaskbar(main)[1]
  assert.equal(pauseButton.tooltip, '暂停')
  assert.ok(pauseButton.icon.path.endsWith(path.join('taskbar', 'pause.png')))
  playButton.click()
  assert.deepEqual(playerActions(main), ['pause'])

  fixture.ipcMain.emit('player:playback-state', mainEvent(main), 'paused')
  assert.equal(latestTaskbar(main)[1].tooltip, '播放')
  pauseButton.click()
  assert.deepEqual(playerActions(main), ['pause', 'play'])
})

test('reloads and renderer crashes disable old taskbar callbacks until the new renderer is ready', () => {
  for (const [eventName, eventArgs] of [
    ['did-start-navigation', [{}, 'app://index.html', false, true]],
    ['render-process-gone', [{}, { reason: 'crashed' }]]
  ]) {
    const fixture = loadMain({ platform: 'win32' })
    fixture.api.createWindow()
    const main = fixture.windows[0]
    fixture.ipcMain.emit('renderer:ready', mainEvent(main))
    fixture.ipcMain.emit('player:playback-state', mainEvent(main), 'playing')
    const oldButtons = latestTaskbar(main)
    main.webContents.emit(eventName, ...eventArgs)
    assertTaskbarEnabled(main, false)
    assert.equal(latestTaskbar(main)[1].tooltip, '播放')
    oldButtons.forEach(button => button.click())
    assert.deepEqual(playerActions(main), [])

    fixture.ipcMain.emit('renderer:ready', mainEvent(main))
    assertTaskbarEnabled(main, true)
    assert.deepEqual(playerActions(main), [])
    latestTaskbar(main)[2].click()
    assert.deepEqual(playerActions(main), ['next'])
  }
})

test('subframe and same-document navigation preserve taskbar readiness and playback state', () => {
  for (const [isInPlace, isMainFrame] of [[false, false], [true, true]]) {
    const fixture = loadMain({ platform: 'win32' })
    fixture.api.createWindow()
    const main = fixture.windows[0]
    fixture.ipcMain.emit('renderer:ready', mainEvent(main))
    fixture.ipcMain.emit('player:playback-state', mainEvent(main), 'playing')
    const callsBeforeNavigation = main.thumbarCalls.length
    main.webContents.emit('did-start-navigation', {}, 'app://index.html#section', isInPlace, isMainFrame)
    assert.equal(main.thumbarCalls.length, callsBeforeNavigation)
    assertTaskbarEnabled(main, true)
    assert.equal(latestTaskbar(main)[1].tooltip, '暂停')
    latestTaskbar(main)[1].click()
    assert.deepEqual(playerActions(main), ['pause'])
  }
})

test('closed window taskbar callbacks cannot control a replacement main window', () => {
  const fixture = loadMain({ platform: 'win32' })
  fixture.api.createWindow()
  const previous = fixture.windows[0]
  fixture.ipcMain.emit('renderer:ready', mainEvent(previous))
  fixture.ipcMain.emit('player:playback-state', mainEvent(previous), 'playing')
  const oldButtons = latestTaskbar(previous)
  previous.close()
  fixture.api.createWindow()
  const replacement = fixture.windows[1]
  replacement.emit('ready-to-show')
  assertTaskbarEnabled(replacement, false)
  assert.equal(latestTaskbar(replacement)[1].tooltip, '播放')
  fixture.ipcMain.emit('renderer:ready', mainEvent(replacement))
  oldButtons.forEach(button => button.click())
  assert.deepEqual(playerActions(replacement), [])
  latestTaskbar(replacement)[0].click()
  assert.deepEqual(playerActions(replacement), ['prev'])
})

test('installation preparation and application shutdown disable taskbar actions including retained callbacks', async () => {
  const fixture = loadMain({ platform: 'win32' })
  fixture.api.createWindow()
  const main = fixture.windows[0]
  fixture.ipcMain.emit('renderer:ready', mainEvent(main))
  const oldButtons = latestTaskbar(main)
  assert.equal(fixture.api.notifyInstallPreparation({ requestId: 'taskbar-test', phase: 'prepare' }), true)
  assertTaskbarEnabled(main, false)
  oldButtons.forEach(button => button.click())
  assert.deepEqual(playerActions(main), [])
  fixture.api.notifyInstallPreparation({ requestId: 'taskbar-test', phase: 'canceled' })
  assertTaskbarEnabled(main, true)
  latestTaskbar(main)[2].click()
  assert.deepEqual(playerActions(main), ['next'])

  const cleanup = fixture.api.performApplicationCleanup()
  assertTaskbarEnabled(main, false)
  oldButtons.forEach(button => button.click())
  assert.deepEqual(playerActions(main), ['next'])
  fixture.releaseStop()
  await cleanup
})

test('non-Windows platforms do not create native taskbar controls or load their icons', () => {
  for (const platform of ['linux', 'darwin']) {
    const fixture = loadMain({ platform })
    fixture.api.createWindow()
    const main = fixture.windows[0]
    main.emit('ready-to-show')
    fixture.ipcMain.emit('renderer:ready', mainEvent(main))
    fixture.ipcMain.emit('player:playback-state', mainEvent(main), 'playing')
    main.emit('show')
    assert.equal(main.thumbarCalls.length, 0)
    assert.equal(fixture.iconPaths.length, 0)
  }
})

test('native taskbar failures are recoverable and a later window show retries registration', () => {
  for (const toolbarResult of [false, new Error('Explorer taskbar temporarily unavailable')]) {
    const fixture = loadMain({ platform: 'win32', toolbarResult })
    assert.doesNotThrow(() => fixture.api.createWindow())
    const main = fixture.windows[0]
    assert.doesNotThrow(() => {
      main.emit('ready-to-show')
      fixture.ipcMain.emit('renderer:ready', mainEvent(main))
    })
    assert.ok(fixture.warnings.length > 0)
    const failedAttempts = main.thumbarCalls.length
    main.thumbarResult = true
    main.emit('show')
    assert.ok(main.thumbarCalls.length > failedAttempts)
    assertTaskbarEnabled(main, true)
    latestTaskbar(main)[2].click()
    assert.deepEqual(playerActions(main), ['next'])
  }
})

test('missing taskbar resources do not interrupt window readiness or ordinary playback controls', () => {
  const fixture = loadMain({ platform: 'win32', missingIcon: true })
  assert.doesNotThrow(() => fixture.api.createWindow())
  const main = fixture.windows[0]
  assert.doesNotThrow(() => {
    main.emit('ready-to-show')
    fixture.ipcMain.emit('renderer:ready', mainEvent(main))
    fixture.api.broadcastPlayerControl('next')
  })
  assert.equal(main.showCalls, 1)
  assert.ok(fixture.warnings.length > 0)
  assert.deepEqual(playerActions(main), ['next'])
})

test('taskbar icons use packaged public resources and are cached across playback changes', () => {
  for (const packaged of [false, true]) {
    const fixture = loadMain({ platform: 'win32', packaged })
    fixture.api.createWindow()
    const main = fixture.windows[0]
    main.emit('ready-to-show')
    fixture.ipcMain.emit('renderer:ready', mainEvent(main))
    fixture.ipcMain.emit('player:playback-state', mainEvent(main), 'playing')
    const directory = path.join(__dirname, '..', packaged ? 'dist' : 'public', 'taskbar')
    const expected = ['previous', 'play', 'pause', 'next'].map(name => path.join(directory, `${name}.png`)).sort()
    assert.deepEqual([...fixture.iconPaths].sort(), expected)
    fixture.ipcMain.emit('player:playback-state', mainEvent(main), 'paused')
    fixture.ipcMain.emit('player:playback-state', mainEvent(main), 'playing')
    main.emit('show')
    assert.deepEqual([...fixture.iconPaths].sort(), expected, 'transport state changes reuse native images')
  }
})
