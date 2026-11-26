const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')

function loadMain({ uninitialized = false, failInitialization = false, platform = 'linux', packaged = false, toolbarResult = true, missingIcon = false, minimizeToTray = true, promptBeforeClose = false, legacyCloseSettings = false, ownsAppInstance = true, loginStart = false } = {}) {
  const globalBindings = new Map()
  const windows = []
  const timers = new Map()
  const iconPaths = []
  const warnings = []
  const dialogs = []
  const dialogTransport = { fail: false }
  const errors = []
  const settingsWrites = []
  const telemetryCalls = []
  const settingsWrite = { beforeCommit: null }
  const settings = { software: { minimizeToTray, updates: { autoCheck: true }, defaultPage: 'home' }, islandLyrics: { enabled: false } }
  if (!legacyCloseSettings) settings.software.promptBeforeClose = promptBeforeClose
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
  app.requestSingleInstanceLock = () => ownsAppInstance
  app.exit = code => { app.exitCode = code }
  app.whenReady = () => readyGate
  app.setAppUserModelId = id => {
    assert.equal(windows.length, 0, 'Windows identity is assigned before any window is created')
    app.userModelId = id
  }
  app.getPath = () => '/user-data'
  app.getAppPath = () => '/app'
  app.getVersion = () => '0.1.0'
  app.quitCalls = 0
  app.completedQuitCalls = 0
  app.quit = () => {
    app.quitCalls += 1
    let prevented = false
    app.emit('before-quit', { preventDefault: () => { prevented = true } })
    if (!prevented) {
      app.completedQuitCalls += 1
      Window.getAllWindows().forEach(window => window.close())
    }
  }
  class Window extends EventEmitter {
    constructor(options) {
      super()
      this.options = options
      this.hidden = false
      this.destroyed = false
      this.minimized = false
      this.showCalls = 0
      this.focusCalls = 0
      this.reloadCalls = 0
      this.sent = []
      this.thumbarCalls = []
      this.thumbarButtons = null
      this.thumbarResult = toolbarResult
      this.backgroundThrottling = true
      this.webContents = Object.assign(new EventEmitter(), {
        send: (...args) => {
          if (args[0] === 'app-dialog:request') {
            if (dialogTransport.fail) throw new Error('test dialog transport failure')
            dialogs.push({ window: this, options: args[1] })
          }
          this.sent.push(args)
        },
        mainFrame: {},
        isCrashed: () => Boolean(this.crashed),
        isLoadingMainFrame: () => Boolean(this.reloading),
        reload: () => { this.reloadCalls += 1; this.reloading = true },
        openDevTools() {}, session: { clearCache: async () => {} },
        setBackgroundThrottling: value => { this.backgroundThrottling = value }
      })
      windows.push(this)
    }
    isDestroyed() { return this.destroyed }
    isFocused() { return Boolean(this.focused) }
    isFullScreen() { return Boolean(this.fullScreen) }
    setFullScreen(value) { this.fullScreen = value }
    isMinimized() { return this.minimized }
    restore() { this.minimized = false }
    loadURL() { return Promise.resolve() }
    loadFile() { return Promise.resolve() }
    hide() { this.hidden = true }
    show() { this.hidden = false; this.showCalls += 1; this.emit('show') }
    focus() { this.focusCalls += 1 }
    getBounds() { return { x: this.options.x, y: this.options.y, width: this.options.width, height: this.options.height } }
    setBounds(bounds) { Object.assign(this.options, bounds) }
    destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('closed') } }
    close() {
      if (this.destroyed) return false
      let prevented = false
      this.emit('close', { preventDefault: () => { prevented = true } })
      if (!prevented) this.destroy()
      return !prevented
    }
    requestClose() { return this.close() }
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
    globalShortcut: {
      register(key, callback) { if (globalBindings.has(key)) return false; globalBindings.set(key, callback); return true },
      isRegistered: key => globalBindings.has(key),
      unregister: key => globalBindings.delete(key),
      unregisterAll: () => globalBindings.clear()
    }, dialog: {
      showMessageBox(...args) { errors.push(args); throw new Error('unexpected native message box') },
      showErrorBox(title, message) { errors.push({ title, message }) }
    }, shell: {},
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
      if (name === './services/desktopLyricPolicy') return require('../electron/services/desktopLyricPolicy')
      if (name === './services/windowsForeground') return require('../electron/services/windowsForeground')
      if (name === 'electron') return electron
      if (name === './logger') return silent
      if (name === './autoLaunch') return { wasOpenedAtLogin: () => loginStart, isLoginLaunchCommand: argv => argv.includes('--bk-login-start') }
      if (name === './services/telemetryEnvironment') return { getTelemetryEnvironment: () => ({}) }
      if (name === './services/telemetryService') return { createTelemetryService: () => ({
        async configure(enabled) { telemetryCalls.push(enabled) }, async markActive() { telemetryCalls.push('active') },
        async getPreview() { return [] }, async clearPending() { telemetryCalls.push('clear') },
        async dispose() { telemetryCalls.push('dispose') }
      }) }
      if (name === './services/lyricLibraryService') return { createLyricLibraryService: () => ({ configure() {}, stop: async () => {} }) }
      if (name === './services/playlistCacheService') return { createPlaylistCacheService: () => ({ configure() {}, stop: async () => {} }) }
      if (name === './services/musicDownloadService') return { createMusicDownloadService: () => ({ configure: async () => {}, setSession: async () => {}, stop: async () => {} }) }
      if (name === './services/updateService') return { createUpdateService: () => ({ configure() {}, stop: async () => {} }) }
      if (name === './services/backendService') return { createBackendService: () => ({
        start() { startCalls += 1 }, waitUntilReady: () => backendGate,
        stop: () => { stopCalls += 1; signalBackendStop(); return stopGate }
      }) }
      if (name === './settingsStore') return {
        normalizeDesktopLyrics: require('../electron/settingsStore').normalizeDesktopLyrics,
        initSettingsStore: async () => { if (failInitialization) throw new Error('controlled initialization failure') }, ensureCacheDirectory: async () => {},
        setSettings: async patch => {
          settingsWrites.push(JSON.parse(JSON.stringify(patch)))
          await settingsWrite.beforeCommit?.(patch)
          Object.assign(settings.software, patch.software)
          return JSON.parse(JSON.stringify(settings))
        },
        onSettingsChange: () => () => {}, getSettings: () => {
        if (uninitialized) throw new Error('Settings store not initialized')
        return JSON.parse(JSON.stringify(settings))
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
  const api = vm.runInContext('({ createWindow, createLoadingWindow, createDesktopLyricWindow, performApplicationCleanup, startMemoryCleanup, stopMemoryCleanup, broadcastPlayerControl, updateTaskbarButtons, notifyInstallPreparation, restoreMainWindowOnActivate, getCleanupTask: () => cleanupPromise })', context)
  return { api, app, windows, timers, releaseStop, releaseReady, releaseBackend, backendStopStarted, ipcMain, handlers, iconPaths, warnings, telemetryCalls,
    dialogs, dialogTransport, errors, settings, settingsWrites, settingsWrite, globalBindings,
    respond: (prompt, action, checked = false, event = mainEvent(prompt.window)) =>
      ipcMain.emit('app-dialog:response', event, prompt.options.requestId, { action, checked }),
    stopCalls: () => stopCalls, startCalls: () => startCalls }
}

async function settleCloseRequest() {
  for (let index = 0; index < 16; index++) await Promise.resolve()
}

function openMain(fixture) {
  fixture.api.createWindow()
  const window = fixture.windows.at(-1)
  fixture.ipcMain.emit('renderer:ready', mainEvent(window))
  return window
}

test('fullscreen toggles the main window through its top-frame IPC only', () => {
  const fixture = loadMain()
  const window = openMain(fixture)
  fixture.ipcMain.emit('window-toggle-fullscreen', { ...mainEvent(window), senderFrame: {} })
  assert.equal(window.isFullScreen(), false)
  fixture.ipcMain.emit('window-toggle-fullscreen', mainEvent(window))
  assert.equal(window.isFullScreen(), true)
  fixture.ipcMain.emit('window-toggle-fullscreen', mainEvent(window))
  assert.equal(window.isFullScreen(), false)
})

test('focused keyboard events stay native and background shortcuts dispatch once to the main window', async () => {
  const fixture = loadMain()
  const window = openMain(fixture)
  const event = mainEvent(window)
  window.focused = true
  const register = fixture.handlers.get('shortcut:register')
  assert.equal((await register(event, 'L', 'toggleLyrics')).success, true)
  assert.equal(fixture.globalBindings.has('L'), false)
  window.focused = false
  window.emit('blur')
  window.emit('blur')
  const nativeCallback = fixture.globalBindings.get('L')
  nativeCallback()
  assert.equal(window.sent.filter(([name]) => name === 'shortcut:triggered').length, 1)
  window.focused = true
  window.emit('focus')
  assert.equal(fixture.globalBindings.has('L'), false)
  nativeCallback()
  assert.equal(window.sent.filter(([name]) => name === 'shortcut:triggered').length, 1)
  await fixture.handlers.get('shortcut:unregister')(event, 'L')
  window.focused = false
  window.emit('blur')
  assert.equal(fixture.globalBindings.size, 0)
})

test('a secondary instance exits without creating windows or starting the backend', async () => {
  const fixture = loadMain({ ownsAppInstance: false })
  fixture.releaseReady()
  await settleCloseRequest()
  assert.equal(fixture.app.exitCode, 0)
  assert.equal(fixture.app.listenerCount('second-instance'), 0)
  assert.equal(fixture.startCalls(), 0)
  assert.equal(fixture.windows.length, 0)
})

test('relaunch restores the existing hidden and minimized main window', () => {
  const fixture = loadMain()
  fixture.app.emit('second-instance')
  assert.equal(fixture.windows.length, 0, 'startup owns first window creation')
  const main = openMain(fixture)
  main.hide()
  main.minimized = true
  fixture.app.emit('second-instance')
  assert.equal(fixture.windows.length, 1)
  assert.equal(main.minimized, false)
  assert.equal(main.hidden, false)
  assert.equal(main.focusCalls, 2)
})

test('relaunch reloads a crashed main renderer once and keeps the original window', () => {
  const fixture = loadMain()
  const main = openMain(fixture)
  main.crashed = true
  main.minimized = true
  main.webContents.emit('render-process-gone')
  fixture.app.emit('second-instance')
  fixture.app.emit('second-instance')
  assert.equal(fixture.windows.length, 1)
  assert.equal(main.minimized, false)
  assert.equal(main.reloadCalls, 1)
})

for (const platform of ['win32', 'linux', 'darwin']) {
  for (const packaged of [false, true]) {
    test(`${platform} ${packaged ? 'packaged' : 'development'} startup uses the application icon and Windows shortcut identity`, async () => {
      const fixture = loadMain({ platform, packaged, failInitialization: true })
      fixture.releaseReady()
      await settleCloseRequest()
      const config = require('../package.json')
      assert.equal(fixture.app.userModelId, platform === 'win32' ? config.build.appId : undefined)
      assert.equal(fixture.windows.length, 2, 'startup creates both the loading window and the error window')
      const loading = fixture.windows[0]
      const main = fixture.windows[1]
      const expectedIcon = path.join(__dirname, packaged ? '../dist/logo.png' : '../public/logo.png')
      assert.equal(loading.options.icon, expectedIcon)
      assert.equal(main.options.icon, expectedIcon)
    })
  }
}

for (const legacyCloseSettings of [false, true]) {
  test(`${legacyCloseSettings ? 'legacy' : 'new'} settings ask before closing and cancellation never remembers a choice`, async () => {
    const fixture = loadMain({ promptBeforeClose: true, legacyCloseSettings, minimizeToTray: false })
    const main = openMain(fixture)
    assert.equal(main.requestClose(), false)
    assert.equal(fixture.dialogs.length, 1)
    const prompt = fixture.dialogs[0]
    assert.equal(prompt.window, main)
    assert.deepEqual(Array.from(prompt.options.actions, action => action.label), ['取消', '最小化到托盘', '退出程序'])
    assert.equal(prompt.options.defaultAction, 'exit')
    assert.equal(prompt.options.checkboxLabel, '不再提示')
    fixture.respond(prompt, null, true)
    await settleCloseRequest()
    assert.equal(main.hidden, false)
    assert.equal(main.destroyed, false)
    assert.equal(fixture.app.quitCalls, 0)
    assert.equal(fixture.settingsWrites.length, 0)
    main.requestClose()
    assert.equal(fixture.dialogs.length, 2)
    fixture.respond(fixture.dialogs[1], 'cancel')
    await settleCloseRequest()
  })
}

test('unchecked tray choice applies only once and repeated close requests share one prompt', async () => {
  const fixture = loadMain({ promptBeforeClose: true, minimizeToTray: false })
  const main = openMain(fixture)
  main.requestClose()
  main.requestClose()
  fixture.ipcMain.emit('window-close', mainEvent(main))
  assert.equal(fixture.dialogs.length, 1)
  fixture.respond(fixture.dialogs[0], 'tray')
  await settleCloseRequest()
  assert.equal(main.hidden, true)
  assert.equal(fixture.settingsWrites.length, 0)
  assert.equal(fixture.settings.software.minimizeToTray, false)
  assert.equal(fixture.settings.software.promptBeforeClose, true)
  main.show()
  main.requestClose()
  assert.equal(fixture.dialogs.length, 2)
  fixture.respond(fixture.dialogs[1], 'cancel')
  await settleCloseRequest()
})

for (const action of ['tray', 'exit']) {
  test(`remembered ${action} choice waits for persistence, preserves other settings and survives a new process`, async () => {
    const minimizeToTray = action === 'tray'
    const fixture = loadMain({ platform: 'darwin', promptBeforeClose: true, minimizeToTray: !minimizeToTray })
    const main = openMain(fixture)
    let releaseSave
    fixture.settingsWrite.beforeCommit = () => new Promise(resolve => { releaseSave = resolve })
    main.requestClose()
    fixture.respond(fixture.dialogs[0], action, true)
    await settleCloseRequest()
    assert.deepEqual(fixture.settingsWrites, [{ software: { minimizeToTray, promptBeforeClose: false } }])
    assert.equal(main.hidden, false)
    assert.equal(main.destroyed, false)
    assert.equal(fixture.app.quitCalls, 0)
    main.requestClose()
    assert.equal(fixture.dialogs.length, 1, 'pending persistence must also suppress duplicate prompts')
    releaseSave()
    await settleCloseRequest()
    assert.equal(fixture.settings.software.promptBeforeClose, false)
    assert.equal(fixture.settings.software.minimizeToTray, minimizeToTray)
    assert.equal(fixture.settings.software.defaultPage, 'home')
    assert.deepEqual(fixture.settings.software.updates, { autoCheck: true })
    if (minimizeToTray) {
      assert.equal(main.hidden, true)
      assert.equal(fixture.app.quitCalls, 0)
      main.show()
      main.requestClose()
      await settleCloseRequest()
      assert.equal(main.hidden, true)
      assert.equal(fixture.dialogs.length, 1)
    } else {
      assert.equal(fixture.app.quitCalls, 1)
      assert.equal(main.destroyed, false, 'explicit exit waits for background cleanup even on macOS')
      fixture.releaseStop()
      await fixture.api.getCleanupTask()
      await settleCloseRequest()
      assert.equal(fixture.app.completedQuitCalls, 1)
      assert.equal(main.destroyed, true)
    }

    const restarted = loadMain({ ...fixture.settings.software })
    restarted.api.createWindow()
    restarted.windows[0].requestClose()
    await settleCloseRequest()
    assert.equal(restarted.dialogs.length, 0)
    if (minimizeToTray) assert.equal(restarted.windows[0].hidden, true)
    else {
      assert.equal(restarted.app.quitCalls, 1)
      restarted.releaseStop()
      await restarted.api.getCleanupTask()
    }
  })
}

test('unchecked exit overrides the saved tray preference without changing it', async () => {
  const fixture = loadMain({ promptBeforeClose: true, minimizeToTray: true })
  const main = openMain(fixture)
  main.requestClose()
  assert.equal(fixture.dialogs[0].options.defaultAction, 'tray')
  fixture.respond(fixture.dialogs[0], 'exit')
  await settleCloseRequest()
  assert.equal(main.hidden, false)
  assert.equal(fixture.app.quitCalls, 1)
  assert.equal(fixture.settingsWrites.length, 0)
  assert.equal(fixture.settings.software.minimizeToTray, true)
  assert.equal(fixture.settings.software.promptBeforeClose, true)
  fixture.releaseStop()
  await fixture.api.getCleanupTask()
  await settleCloseRequest()
  assert.equal(main.destroyed, true)
})

for (const failure of ['dialog', 'save']) {
  test(`${failure} failure keeps the window open and allows another close attempt`, async () => {
    const fixture = loadMain({ promptBeforeClose: true, minimizeToTray: false })
    const main = openMain(fixture)
    fixture.dialogTransport.fail = failure === 'dialog'
    if (failure === 'save') fixture.settingsWrite.beforeCommit = async () => { throw new Error('test write failure') }
    main.requestClose()
    if (failure === 'save') fixture.respond(fixture.dialogs[0], 'exit', true)
    await settleCloseRequest()
    assert.equal(fixture.errors.length, 0)
    assert.match(main.sent.find(([channel]) => channel === 'app:notice')?.[1]?.message || '', /未能完成关闭操作/)
    assert.equal(main.hidden, false)
    assert.equal(main.destroyed, false)
    assert.equal(fixture.app.quitCalls, 0)
    assert.equal(fixture.settings.software.promptBeforeClose, true)
    fixture.dialogTransport.fail = false
    fixture.settingsWrite.beforeCommit = null
    main.requestClose()
    assert.equal(fixture.dialogs.length, failure === 'dialog' ? 1 : 2)
    fixture.respond(fixture.dialogs.at(-1), 'tray', true)
    await settleCloseRequest()
    assert.equal(main.hidden, true)
    assert.equal(fixture.settings.software.promptBeforeClose, false)
  })
}

test('close IPC accepts only the current main top frame and uses the same prompt as native close', async () => {
  const fixture = loadMain({ promptBeforeClose: true })
  const main = openMain(fixture)
  const desktop = fixture.api.createDesktopLyricWindow()
  fixture.ipcMain.emit('window-close', mainEvent(desktop))
  fixture.ipcMain.emit('window-close', { ...mainEvent(main), senderFrame: {} })
  assert.equal(fixture.dialogs.length, 0)
  assert.equal(desktop.hidden, false)
  assert.equal(desktop.destroyed, false)
  fixture.ipcMain.emit('window-close', mainEvent(main))
  assert.equal(fixture.dialogs.length, 1)
  main.requestClose()
  assert.equal(fixture.dialogs.length, 1)
  fixture.respond(fixture.dialogs[0], 'cancel')
  await settleCloseRequest()
  desktop.destroy()
})

test('close requests before renderer readiness cannot execute an unconfirmed close or block a later prompt', async () => {
  const fixture = loadMain({ promptBeforeClose: true })
  fixture.api.createWindow()
  const main = fixture.windows[0]
  assert.equal(main.requestClose(), false)
  await settleCloseRequest()
  assert.equal(fixture.dialogs.length, 0)
  assert.equal(fixture.app.quitCalls, 0)
  assert.equal(main.hidden, false)
  fixture.ipcMain.emit('renderer:ready', mainEvent(main))
  main.requestClose()
  assert.equal(fixture.dialogs.length, 1)
  fixture.respond(fixture.dialogs[0], 'tray')
  await settleCloseRequest()
  assert.equal(main.hidden, true)
})

test('modal replies require the originating top frame, request ID and an allowed result', async () => {
  const fixture = loadMain({ promptBeforeClose: true })
  const main = openMain(fixture)
  main.requestClose()
  const prompt = fixture.dialogs[0]
  fixture.respond(prompt, 'tray', true, { ...mainEvent(main), senderFrame: {} })
  fixture.respond(prompt, 'unknown', true)
  fixture.respond(prompt, 'tray', 'true')
  fixture.ipcMain.emit('app-dialog:response', mainEvent(main), 'unknown-request', { action: 'tray', checked: true })
  fixture.ipcMain.emit('app-dialog:response', mainEvent(main), prompt.options.requestId, { action: 'tray', checked: true, extra: true })
  await settleCloseRequest()
  assert.equal(fixture.settingsWrites.length, 0)
  assert.equal(main.hidden, false)
  fixture.respond(prompt, 'tray')
  fixture.respond(prompt, 'exit', true)
  await settleCloseRequest()
  assert.equal(main.hidden, true)
  assert.equal(fixture.settingsWrites.length, 0)
  assert.equal(fixture.app.quitCalls, 0)
})

for (const eventName of ['did-start-navigation', 'render-process-gone']) {
  test(`${eventName} retires the old confirmation and permits a fresh one`, async () => {
    const fixture = loadMain({ promptBeforeClose: true })
    const main = openMain(fixture)
    main.requestClose()
    const firstPrompt = fixture.dialogs[0]
    main.webContents.emit(eventName, {}, 'file:///app/dist/index.html', false, true)
    await settleCloseRequest()
    fixture.ipcMain.emit('renderer:ready', mainEvent(main))
    main.requestClose()
    assert.equal(fixture.dialogs.length, 2)
    const nextPrompt = fixture.dialogs[1]
    assert.notEqual(nextPrompt.options.requestId, firstPrompt.options.requestId)
    fixture.respond(firstPrompt, 'tray', true)
    await settleCloseRequest()
    assert.equal(main.hidden, false)
    assert.equal(fixture.settingsWrites.length, 0)
    fixture.respond(nextPrompt, 'tray')
    await settleCloseRequest()
    assert.equal(main.hidden, true)
  })
}

test('a pending prompt cannot change preferences or hide a replacement window', async () => {
  const fixture = loadMain({ promptBeforeClose: true, minimizeToTray: true })
  const previous = openMain(fixture)
  previous.requestClose()
  previous.destroy()
  const replacement = openMain(fixture)
  replacement.requestClose()
  assert.equal(fixture.dialogs.length, 2, 'a replacement window has its own pending-close guard')
  fixture.respond(fixture.dialogs[0], 'tray', true, mainEvent(replacement))
  await settleCloseRequest()
  assert.equal(fixture.settingsWrites.length, 0)
  assert.equal(replacement.hidden, false)
  assert.equal(fixture.app.quitCalls, 0)
  fixture.respond(fixture.dialogs[1], 'cancel')
  await settleCloseRequest()
})

test('application exit invalidates an outstanding close prompt', async () => {
  const fixture = loadMain({ promptBeforeClose: true })
  const main = openMain(fixture)
  main.requestClose()
  fixture.app.quit()
  assert.deepEqual(main.sent.find(([channel]) => channel === 'app-dialog:cancel'), ['app-dialog:cancel', fixture.dialogs[0].options.requestId])
  fixture.respond(fixture.dialogs[0], 'tray', true)
  await settleCloseRequest()
  assert.equal(fixture.settingsWrites.length, 0)
  assert.equal(main.hidden, false)
  assert.equal(fixture.app.quitCalls, 1)
  fixture.releaseStop()
  await fixture.api.getCleanupTask()
  await settleCloseRequest()
  assert.equal(fixture.app.completedQuitCalls, 1)
})

test('installation preparation blocks new close requests and invalidates pending prompt results', async () => {
  const fixture = loadMain({ promptBeforeClose: true })
  fixture.api.createWindow()
  const main = fixture.windows[0]
  fixture.ipcMain.emit('renderer:ready', mainEvent(main))
  assert.equal(fixture.api.notifyInstallPreparation({ requestId: 'close-test', phase: 'prepare' }), true)
  main.requestClose()
  fixture.ipcMain.emit('window-close', mainEvent(main))
  await settleCloseRequest()
  assert.equal(fixture.dialogs.length, 0)
  assert.equal(main.hidden, false)
  assert.equal(main.destroyed, false)
  fixture.api.notifyInstallPreparation({ requestId: 'close-test', phase: 'canceled' })
  main.requestClose()
  assert.equal(fixture.dialogs.length, 1)
  fixture.api.notifyInstallPreparation({ requestId: 'close-test-2', phase: 'prepare' })
  assert.deepEqual(main.sent.find(([channel]) => channel === 'app-dialog:cancel'), ['app-dialog:cancel', fixture.dialogs[0].options.requestId])
  fixture.respond(fixture.dialogs[0], 'exit', true)
  await settleCloseRequest()
  assert.equal(fixture.settingsWrites.length, 0)
  assert.equal(fixture.app.quitCalls, 0)
  fixture.api.notifyInstallPreparation({ requestId: 'close-test-2', phase: 'canceled' })
  fixture.api.stopMemoryCleanup()
})

test('a close preference save completed after application exit cannot execute a second close action', async () => {
  const fixture = loadMain({ promptBeforeClose: true })
  const main = openMain(fixture)
  let releaseSave
  fixture.settingsWrite.beforeCommit = () => new Promise(resolve => { releaseSave = resolve })
  main.requestClose()
  fixture.respond(fixture.dialogs[0], 'tray', true)
  await settleCloseRequest()
  fixture.app.quit()
  releaseSave()
  await settleCloseRequest()
  assert.equal(main.hidden, false)
  assert.equal(fixture.app.quitCalls, 1)
  fixture.releaseStop()
  await fixture.api.getCleanupTask()
  await settleCloseRequest()
  assert.equal(fixture.app.completedQuitCalls, 1)
})

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
  main.destroy()
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

for (const platform of ['win32', 'linux', 'darwin']) {
  for (const withDesktopLyrics of [false, true]) {
    test(`${platform} main close with island disabled cleans up ${withDesktopLyrics ? 'desktop lyrics and' : 'all'} background services before quitting`, async () => {
      const fixture = loadMain({ platform, minimizeToTray: false })
      fixture.api.createWindow()
      const main = fixture.windows[0]
      const desktop = withDesktopLyrics ? fixture.api.createDesktopLyricWindow() : null
      fixture.api.startMemoryCleanup()

      assert.equal(main.requestClose(), false)
      await settleCloseRequest()
      const cleanup = fixture.api.getCleanupTask()
      assert.equal(typeof cleanup?.then, 'function', 'main close must start cleanup even with the island disabled')
      await fixture.app.listeners('window-all-closed')[0]()
      await fixture.backendStopStarted
      assert.equal(fixture.stopCalls(), 1, 'a later window-all-closed must reuse the same cleanup')
      assert.equal(fixture.app.completedQuitCalls, 0, 'quit must wait for the backend to finish stopping')
      assert.equal(main.destroyed, false, 'the main renderer remains alive until cleanup finishes')
      if (desktop) assert.equal(desktop.destroyed, true)
      assert.equal(fixture.timers.size, 0)

      fixture.releaseStop()
      await cleanup
      await Promise.resolve()
      assert.equal(fixture.app.completedQuitCalls, 1)
      assert.equal(main.destroyed, true)
    })
  }
}

test('minimize-to-tray keeps the main window, desktop lyrics and background services on ordinary close', async () => {
  const fixture = loadMain({ platform: 'win32', minimizeToTray: true })
  fixture.api.createWindow()
  const main = fixture.windows[0]
  const desktop = fixture.api.createDesktopLyricWindow()

  assert.equal(main.requestClose(), false)
  assert.equal(main.hidden, true)
  assert.equal(main.destroyed, false)
  assert.equal(desktop.destroyed, false)
  assert.equal(fixture.api.getCleanupTask(), null)
  assert.equal(fixture.stopCalls(), 0)
  assert.equal(fixture.app.quitCalls, 0)

  const cleanup = fixture.api.performApplicationCleanup()
  fixture.releaseStop()
  await cleanup
  assert.equal(desktop.destroyed, true)
  assert.equal(fixture.timers.size, 0)
})

test('macOS unexpected main destruction keeps auxiliary services and Dock activation rebuilds the main window', async () => {
  const fixture = loadMain({ platform: 'darwin', minimizeToTray: false })
  fixture.api.createWindow()
  const main = fixture.windows[0]
  const desktop = fixture.api.createDesktopLyricWindow()

  main.destroy()
  assert.equal(main.destroyed, true)
  assert.equal(desktop.destroyed, false)
  assert.equal(fixture.api.getCleanupTask(), null)
  assert.equal(fixture.stopCalls(), 0)
  assert.equal(fixture.app.quitCalls, 0)
  fixture.api.restoreMainWindowOnActivate()
  assert.equal(fixture.windows.length, 3)
  assert.equal(fixture.windows[2].destroyed, false)

  const cleanup = fixture.api.performApplicationCleanup()
  fixture.releaseStop()
  await cleanup
  assert.equal(desktop.destroyed, true)
  assert.equal(fixture.stopCalls(), 1)
  assert.equal(fixture.timers.size, 0)
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

test('consenting manual launch counts the first mounted window and restricts queue management to its top frame', async () => {
  const fixture = loadMain()
  fixture.settings.software.telemetryEnabled = true
  fixture.releaseReady()
  await settleCloseRequest()
  const event = mainEvent(fixture.windows.at(-1))
  assert.deepEqual(fixture.telemetryCalls, [true])
  fixture.ipcMain.emit('renderer:ready', event)
  assert.deepEqual(fixture.telemetryCalls, [true, 'active'])
  assert.deepEqual(await fixture.handlers.get('telemetry:get-pending')(event), [])
  assert.throws(() => fixture.handlers.get('telemetry:clear-pending')({ ...event, senderFrame: {} }))
  await fixture.handlers.get('telemetry:clear-pending')(event)
  assert.deepEqual(fixture.telemetryCalls, [true, 'active', 'clear'])
})

test('a login launch waits for foreground interaction or a progressing, confirmed playback clock', async () => {
  const fixture = loadMain({ loginStart: true })
  fixture.settings.software.telemetryEnabled = true
  fixture.releaseReady()
  await settleCloseRequest()
  const window = fixture.windows.at(-1)
  const event = mainEvent(window)
  const tick = (time, meta) => fixture.ipcMain.emit('player:time-update', event, time, { trackId: 'fixture-song', ...meta })
  fixture.ipcMain.emit('renderer:ready', event)
  fixture.app.emit('second-instance', {}, ['BetterKuGou.exe', '--bk-login-start'])
  window.emit('blur')
  window.webContents.emit('did-start-navigation', {}, 'file:///fixture', false, true)
  fixture.ipcMain.emit('renderer:ready', event)
  window.emit('focus')
  fixture.ipcMain.emit('telemetry:foreground-activity', event)
  fixture.ipcMain.emit('player:track-update', event, { trackId: 'fixture-song' })
  fixture.ipcMain.emit('player:playback-state', event, 'playing')
  tick(200, { advancing: false })
  tick(6000, { advancing: true, discontinuity: true })
  tick(6000, { advancing: true })
  tick(6200, { advancing: true, trackId: 'stale' })
  assert.deepEqual(fixture.telemetryCalls, [true])
  tick(6200, { advancing: true })
  window.focused = true
  fixture.ipcMain.emit('telemetry:foreground-activity', { ...event, senderFrame: {} })
  fixture.ipcMain.emit('telemetry:foreground-activity', event)
  assert.deepEqual(fixture.telemetryCalls, [true, 'active', 'active'])
})

test('Dock activation after a login-started window closes counts the recreated foreground window', async () => {
  const fixture = loadMain({ platform: 'darwin', loginStart: true })
  fixture.settings.software.telemetryEnabled = true
  fixture.releaseReady()
  await settleCloseRequest()
  const previous = fixture.windows.at(-1)
  fixture.ipcMain.emit('renderer:ready', mainEvent(previous))
  previous.destroy()
  fixture.app.emit('activate')
  const reopened = fixture.windows.at(-1)
  assert.notEqual(reopened, previous)
  fixture.ipcMain.emit('renderer:ready', mainEvent(reopened))
  assert.deepEqual(fixture.telemetryCalls, [true, 'active'])
})

test('Windows login registration and its readback use the same marker; macOS reads the launch reason', () => {
  const source = fs.readFileSync(path.join(__dirname, '../electron/autoLaunch.js'), 'utf8')
  function load(platform) {
    const process = { platform, execPath: '/fixture/app', argv: ['/fixture/app'] }
    const context = { process, module: { exports: {} }, require: () => ({ warn() {} }) }
    vm.runInNewContext(source, context)
    return { process, api: context.module.exports }
  }
  const win = load('win32')
  let written
  const app = {
    setLoginItemSettings(options) { written = options },
    getLoginItemSettings(options) {
      assert.equal(options.path, written.path)
      assert.deepEqual(options.args, written.args)
      return { openAtLogin: true }
    }
  }
  assert.equal(win.api.setAutoLaunchEnabled(app, true), true)
  assert.equal(win.api.wasOpenedAtLogin(app), false)
  win.process.argv.push(...written.args)
  assert.equal(win.api.wasOpenedAtLogin(app), true)
  const mac = load('darwin')
  assert.equal(mac.api.wasOpenedAtLogin({ getLoginItemSettings: () => ({ openAtLogin: true, wasOpenedAtLogin: false }) }), false)
  assert.equal(mac.api.wasOpenedAtLogin({ getLoginItemSettings: () => ({ wasOpenedAtLogin: true }) }), true)
})

test('failed initialization shows only the unified-notice shell and exits through the existing cleanup', async () => {
  const fixture = loadMain({ failInitialization: true, uninitialized: true })
  fixture.releaseReady()
  await settleCloseRequest()
  assert.equal(fixture.windows.length, 2, 'loading window and fatal-notice shell only')
  const main = fixture.windows[1]
  assert.equal(fixture.startCalls(), 0, 'the backend must not start against failed settings')
  assert.equal(fixture.app.quitCalls, 0, 'keep the failure readable until acknowledged')
  assert.equal(fixture.errors.length, 0, 'no independent native error dialog')
  const getFailure = fixture.handlers.get('app:get-startup-failure')
  assert.equal(getFailure({ sender: {}, senderFrame: {} }), null)
  assert.match(getFailure(mainEvent(main)).message, /无法读取或保存设置/)
  assert.equal(fixture.handlers.get('app:quit-after-startup-failure')({ sender: main.webContents, senderFrame: {} }), false)
  fixture.ipcMain.emit('renderer:ready', mainEvent(main))
  assert.equal(main.hidden, false)
  assert.equal(fixture.windows[0].destroyed, true)
  assert.equal([...fixture.timers.values()].some(timer => timer.delay === 15000), false)
  assert.equal(fixture.handlers.get('app:quit-after-startup-failure')(mainEvent(main)), true)
  await fixture.backendStopStarted
  fixture.releaseStop()
  await fixture.api.getCleanupTask()
  await settleCloseRequest()
  assert.equal(fixture.app.completedQuitCalls, 1)
  assert.equal(main.destroyed, true)
})

test('fatal-notice shell that never mounts times out and releases its startup timer', async () => {
  const fixture = loadMain({ failInitialization: true, uninitialized: true })
  fixture.releaseReady()
  await settleCloseRequest()
  const timer = [...fixture.timers.entries()].find(([, value]) => value.delay === 15000)
  assert.ok(timer)
  fixture.timers.delete(timer[0])
  timer[1].callback()
  await fixture.backendStopStarted
  fixture.releaseStop()
  await fixture.api.getCleanupTask()
  await settleCloseRequest()
  assert.equal(fixture.app.completedQuitCalls, 1)
  assert.equal(fixture.timers.size, 0)
})

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

test('audio scheduling remains responsive in the background and restores throttling on pause, clear and reload', () => {
  const fixture = loadMain()
  fixture.api.createWindow()
  const main = fixture.windows[0]
  const event = mainEvent(main)
  assert.equal(main.backgroundThrottling, true)
  fixture.ipcMain.emit('player:playback-state', event, 'playing')
  assert.equal(main.backgroundThrottling, false)
  main.hide()
  assert.equal(main.backgroundThrottling, false, 'hiding a playing window must not slow fades')
  fixture.ipcMain.emit('player:playback-state', event, 'paused')
  assert.equal(main.backgroundThrottling, true)
  fixture.ipcMain.emit('player:playback-state', { sender: {}, senderFrame: {} }, 'playing')
  assert.equal(main.backgroundThrottling, true, 'another renderer cannot disable throttling')
  fixture.ipcMain.emit('player:playback-state', event, 'playing')
  fixture.ipcMain.emit('player:track-update', event, null)
  assert.equal(main.backgroundThrottling, true)
  fixture.ipcMain.emit('player:playback-state', event, 'playing')
  main.webContents.emit('did-start-navigation', {}, 'app://reload', false, true)
  assert.equal(main.backgroundThrottling, true)
  fixture.api.stopMemoryCleanup()
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
  previous.destroy()
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
