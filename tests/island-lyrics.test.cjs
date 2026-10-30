const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')

const plain = value => JSON.parse(JSON.stringify(value))
async function settle() { for (let i = 0; i < 16; i++) await Promise.resolve() }

/** Run the actual main process and island service with isolated OS effects and committed settings. */
function islandFixture(t, platform = 'linux') {
  const ipc = new EventEmitter()
  const handlers = new Map()
  ipc.handle = (channel, handler) => handlers.set(channel, handler)
  let quitCalls = 0
  let backendStops = 0
  const app = Object.assign(new EventEmitter(), {
    isPackaged: true, whenReady: () => new Promise(() => {}), commandLine: { appendSwitch() {} },
    quit() { quitCalls++ }, getPath: () => '/controlled-user-data', getVersion: () => '0.1.9'
  })
  const windows = []
  const timers = new Map()
  let timerId = 0
  let loadFailure = false
  let loadPending = false
  let writeFailure = false
  let delayClose = false
  let writeGate = null
  let writeQueue = Promise.resolve()
  let settingsListener = null
  let fullscreenCallback = null
  let fullscreenActive = false
  let snapshot = { islandLyrics: { enabled: false }, playback: { showTranslation: true },
    desktopLyrics: {}, software: { updates: {}, minimizeToTray: false } }
  const writes = []
  const errors = []
  const dialogs = []
  const screen = Object.assign(new EventEmitter(), {
    area: { x: 0, y: 0, width: 1280, height: 800 },
    getPrimaryDisplay() { return { id: 1, workArea: this.area, bounds: this.area } },
    getDisplayMatching() { return this.getPrimaryDisplay() },
    getAllDisplays() { return [this.getPrimaryDisplay()] },
    getCursorScreenPoint: () => ({ x: 300, y: 12 })
  })
  class Window extends EventEmitter {
    constructor(options = {}) {
      super()
      this.options = options
      this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height }
      this.destroyed = false
      this.shows = 0
      this.focuses = 0
      this.messages = []
      this.webContents = Object.assign(new EventEmitter(), {
        mainFrame: {}, send: (...args) => this.messages.push(args),
        openDevTools() {}, session: { clearCache: async () => {} },
        isDestroyed: () => this.destroyed
      })
      windows.push(this)
    }
    loadURL() { return Promise.resolve() }
    loadFile(file) {
      this.file = file
      if (loadFailure) return Promise.reject(new Error('Controlled HTML failure'))
      return loadPending ? new Promise(() => {}) : Promise.resolve()
    }
    isDestroyed() { return this.destroyed }
    show() { this.hidden = false; this.shows++; this.emit('show') }
    showInactive() { this.hidden = false; this.shows++; this.emit('show') }
    hide() { this.hidden = true; this.emit('hide') }
    isVisible() { return !this.hidden }
    focus() { this.focuses++ }
    getBounds() { return { ...this.bounds } }
    setBounds(bounds) { this.bounds = { ...bounds }; this.emit('resize') }
    setPosition(x, y) { this.bounds.x = x; this.bounds.y = y }
    setSize(width, height) { this.bounds.width = width; this.bounds.height = height }
    setIgnoreMouseEvents(value, options) { this.ignoresMouse = value; this.mouseOptions = options }
    setFocusable(value) { this.focusable = value }
    setOpacity(value) { this.opacity = value }
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces() {}
    setThumbarButtons() { return true }
    close() {
      let prevented = false
      this.emit('close', { preventDefault() { prevented = true } })
      if (!prevented && !delayClose) this.destroy()
    }
    destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('closed') } }
    static getAllWindows() { return windows.filter(win => !win.destroyed) }
  }
  const logger = Object.fromEntries(['trace', 'info', 'warn', 'debug', 'error'].map(name => [name, (...args) => {
    if (name === 'error') errors.push(args)
  }]))
  const electron = { app, BrowserWindow: Window, ipcMain: ipc, screen,
    nativeImage: { createFromPath: () => ({ isEmpty: () => false }) },
    globalShortcut: { unregisterAll() {} }, dialog: { showMessageBox: async options => { dialogs.push(options); return { response: 0 } } } }
  const settings = {
    getSettings: () => snapshot,
    onSettingsChange(callback) { settingsListener = callback; return () => { settingsListener = null } },
    setSettings(patch) {
      const gate = writeGate
      writeGate = null
      const operation = writeQueue.then(async () => {
        if (gate) await gate
        if (writeFailure) throw new Error('Controlled settings failure')
        writes.push(plain(patch))
        for (const [group, value] of Object.entries(patch)) snapshot[group] = { ...snapshot[group], ...value }
        settingsListener?.(snapshot)
        return snapshot
      })
      writeQueue = operation.catch(() => {})
      return operation
    }
  }
  const timerAPI = {
    setTimeout(callback, delay) { timers.set(++timerId, { callback, delay }); return timerId },
    clearTimeout(id) { timers.delete(id) },
    setInterval(callback, delay) { timers.set(++timerId, { callback, delay }); return timerId },
    clearInterval(id) { timers.delete(id) }
  }
  const context = vm.createContext({
    __dirname: path.resolve(__dirname, '../electron'), process: { platform, env: {}, resourcesPath: '/resources', memoryUsage: process.memoryUsage },
    console: logger, global: {}, Buffer, ...timerAPI
  })
  const serviceCache = new Map()
  function loadService(filename) {
    if (serviceCache.has(filename)) return serviceCache.get(filename).exports
    const module = { exports: {} }
    serviceCache.set(filename, module)
    const execute = vm.runInContext(`(function(require, module, exports, __dirname) {\n${fs.readFileSync(filename, 'utf8')}\n})`, context, { filename })
    execute(name => name === 'electron' ? electron : name === '../logger' ? logger : require(name), module, module.exports, path.dirname(filename))
    return module.exports
  }
  context.require = name => {
    if (name === 'electron') return electron
    if (name === './logger') return logger
    if (name === './settingsStore') return settings
    if (name === './services/islandLyricService') return loadService(path.resolve(__dirname, '../electron/services/islandLyricService.js'))
    if (name === './services/fullscreenMonitor') return { createFullscreenMonitor({ onChange }) {
      fullscreenCallback = onChange
      return { start() { fullscreenActive = true }, async stop() { fullscreenActive = false; onChange({ fullscreen: false }) } }
    } }
    if (name === './services/backendService') return { createBackendService: () => ({ stop: async () => { backendStops++ } }) }
    if (name === './services/updateService') return { createUpdateService: () => ({ configure() {}, stop: async () => {} }) }
    if (name === './services/playlistCacheService') return { createPlaylistCacheService: () => ({ configure() {}, stop: async () => {} }) }
    if (name.startsWith('./services/')) return require(path.resolve(__dirname, '../electron', name))
    return require(name)
  }
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../electron/main.js'), 'utf8'), context, { filename: 'main.js' })
  const api = vm.runInContext('({createWindow, restoreMainWindowOnActivate, subscribeToSettingsUpdates, notifyInstallPreparation, performApplicationCleanup, runIslandTrayAction})', context)
  api.createWindow()
  const main = windows[0]
  const event = win => ({ sender: win.webContents, senderFrame: win.webContents.mainFrame })
  ipc.emit('renderer:ready', event(main))
  api.subscribeToSettingsUpdates()
  const invoke = (channel, win = main, value) => handlers.get(channel)(event(win), value)
  const latest = () => windows.filter(win => win !== main).at(-1)
  t.after(async () => { await api.performApplicationCleanup(); windows.forEach(win => win.destroy()) })
  return { ...api, ipc, handlers, main, event, invoke, latest, windows, timers, screen, writes, errors, dialogs,
    get settings() { return snapshot },
    get quitCalls() { return quitCalls },
    get backendStops() { return backendStops },
    get fullscreenActive() { return fullscreenActive },
    fullscreen(value) { fullscreenCallback?.(value) },
    publish(channel, ...args) { ipc.emit(`player:${channel}`, event(main), ...args) },
    last(win, channel) { return win.messages.filter(([name]) => name === `island-lyric:${channel}`).at(-1)?.slice(1) },
    async open() {
      const opening = invoke('island-lyric:show')
      await settle()
      const win = latest()
      assert.ok(win && !win.isDestroyed(), 'opening must create a live island window')
      win.emit('ready-to-show')
      assert.equal((await opening).success, true)
      return win
    },
    update(patch) { for (const [group, value] of Object.entries(patch)) snapshot[group] = { ...snapshot[group], ...value }; settingsListener?.(snapshot) },
    failLoad(value) { loadFailure = value }, holdLoads(value) { loadPending = value },
    failWrite(value) { writeFailure = value }, delayClose(value) { delayClose = value },
    holdNextWrite() { let release; writeGate = new Promise(resolve => { release = resolve }); return release }
  }
}

test('opening commits the preference then replays the complete paused snapshot without focusing the island', async t => {
  const fixture = islandFixture(t)
  fixture.publish('track-update', { trackId: 'first', title: 'Same title', artist: 'Artist' })
  fixture.publish('lyric-update', [{ time: 1000, text: ' 你好 😀 ', translation: ' Hello ' }], 'first')
  fixture.publish('time-update', 12500, { trackId: 'first', duration: 60000 })
  fixture.publish('playback-state', 'paused')
  const release = fixture.holdNextWrite()
  const opening = fixture.invoke('island-lyric:show')
  await settle()
  assert.equal(fixture.windows.length, 1, 'uncommitted enablement cannot create a window')
  release()
  await settle()
  const win = fixture.latest()
  assert.equal(win.shows, 0, 'do not show before the renderer is ready')
  win.emit('ready-to-show')
  assert.equal((await opening).success, true)
  assert.equal(fixture.settings.islandLyrics.enabled, true)
  assert.equal(win.options.webPreferences.nodeIntegration, false)
  assert.equal(win.options.webPreferences.contextIsolation, true)
  assert.equal(win.options.skipTaskbar, true)
  assert.equal(win.options.transparent, true)
  assert.equal(win.focuses, 0)
  assert.equal(win.shows, 1, 'settings broadcast and caller must share the same opening')
  assert.equal(fixture.last(win, 'song-update')[0].trackId, 'first')
  assert.equal(fixture.last(win, 'lyric-update')[0][0].text, ' 你好 😀 ')
  assert.deepEqual(plain(fixture.last(win, 'time-update')), [12500, { duration: 60000 }])
  assert.deepEqual(plain(fixture.last(win, 'playback-update')[0]), { playing: false, time: 12500, duration: 60000, available: true })
  assert.equal(fixture.last(win, 'settings-update')[0].showTranslation, true)
})

test('same-title tracks reject stale lyrics and time, preserve metadata updates, and clear on stop and reopen', async t => {
  const fixture = islandFixture(t)
  const win = await fixture.open()
  fixture.publish('track-update', { trackId: 'first', title: 'Same' })
  fixture.publish('lyric-update', [{ time: 0, text: 'first lyric' }], 'first')
  fixture.publish('time-update', 12000, { trackId: 'first', duration: 30000 })
  fixture.publish('track-update', { trackId: 'second', title: 'Same' })
  fixture.publish('lyric-update', [{ time: 0, text: 'stale lyric' }], 'first')
  fixture.publish('time-update', 15000, { trackId: 'first' })
  assert.equal(fixture.last(win, 'lyric-update')[0].length, 0)
  assert.equal(fixture.last(win, 'time-update')[0], 0)
  fixture.publish('lyric-update', [{ time: 0, text: 'second lyric' }], 'second')
  fixture.publish('track-update', { trackId: 'second', title: 'Corrected title' })
  assert.equal(fixture.last(win, 'lyric-update')[0][0].text, 'second lyric')
  fixture.publish('track-update', null)
  assert.equal(fixture.last(win, 'song-update')[0], null)
  assert.equal(fixture.last(win, 'playback-update')[0].playing, false)
  assert.equal((await fixture.invoke('island-lyric:close', win)).success, true)
  const reopened = await fixture.open()
  assert.equal(fixture.last(reopened, 'song-update')[0], null)
  assert.equal(fixture.last(reopened, 'lyric-update')[0].length, 0)
  assert.equal(fixture.last(reopened, 'time-update')[0], 0)
})

test('only the intended top frame can show, control, translate, close or change pointer interception', async t => {
  const fixture = islandFixture(t)
  const childMain = { sender: fixture.main.webContents, senderFrame: {} }
  assert.equal((await fixture.handlers.get('island-lyric:show')(childMain)).success, false)
  assert.equal(fixture.writes.length, 0)
  const win = await fixture.open()
  const childIsland = { sender: win.webContents, senderFrame: {} }
  for (const [channel, value] of [['control', 'next'], ['set-translation', false], ['close', undefined]]) {
    assert.equal((await fixture.handlers.get(`island-lyric:${channel}`)(childIsland, value)).success, false)
    assert.equal((await fixture.invoke(`island-lyric:${channel}`, fixture.main, value)).success, false)
  }
  assert.equal((await fixture.invoke('island-lyric:control', win, 'next')).success, false, 'empty playback is unavailable')
  fixture.publish('track-update', { trackId: 'song', title: 'Song' })
  fixture.publish('playback-state', 'playing')
  assert.equal((await fixture.invoke('island-lyric:control', win, 'delete')).success, false)
  assert.equal((await fixture.invoke('island-lyric:set-translation', win, 'false')).success, false)
  const shows = fixture.main.shows
  assert.equal((await fixture.invoke('island-lyric:control', win, 'toggle')).success, true)
  assert.equal(fixture.main.messages.filter(([channel]) => channel === 'player:control').at(-1)[1], 'pause')
  assert.equal(fixture.main.shows, shows)
  fixture.ipc.emit('island-lyric:set-interactive', fixture.event(win), true)
  assert.equal(win.ignoresMouse, false)
  fixture.ipc.emit('island-lyric:set-interactive', childIsland, false)
  fixture.ipc.emit('island-lyric:set-interactive', fixture.event(fixture.main), false)
  fixture.ipc.emit('island-lyric:set-interactive', fixture.event(win), 'false')
  assert.equal(win.ignoresMouse, false)
  fixture.ipc.emit('island-lyric:set-interactive', fixture.event(win), false)
  assert.equal(win.ignoresMouse, true)
  fixture.ipc.emit('player:track-update', fixture.event(win), null)
  assert.equal(fixture.last(win, 'song-update')[0].trackId, 'song')
})

test('failed saves retain committed enablement and translation and allow the same action to retry', async t => {
  const fixture = islandFixture(t)
  fixture.failWrite(true)
  assert.equal((await fixture.invoke('island-lyric:show')).success, false)
  assert.equal(fixture.windows.length, 1)
  assert.equal(fixture.settings.islandLyrics.enabled, false)
  fixture.failWrite(false)
  const win = await fixture.open()
  fixture.failWrite(true)
  assert.equal((await fixture.invoke('island-lyric:set-translation', win, false)).success, false)
  assert.equal(fixture.settings.playback.showTranslation, true)
  assert.equal(fixture.last(win, 'settings-update')[0].showTranslation, true)
  assert.equal((await fixture.invoke('island-lyric:close', win)).success, false)
  assert.equal(fixture.settings.islandLyrics.enabled, true)
  assert.equal(win.isDestroyed(), false)
  fixture.failWrite(false)
  assert.equal((await fixture.invoke('island-lyric:set-translation', win, false)).success, true)
  assert.equal(fixture.last(win, 'settings-update')[0].showTranslation, false)
  assert.equal((await fixture.invoke('island-lyric:close', win)).success, true)
  assert.equal(fixture.settings.islandLyrics.enabled, false)
  assert.equal(win.isDestroyed(), true)
})

test('committed disablement during loading and late callbacks cannot revive or detach a replacement window', async t => {
  const fixture = islandFixture(t)
  fixture.delayClose(true)
  const firstOpening = fixture.invoke('island-lyric:show')
  await settle()
  const first = fixture.latest()
  fixture.update({ islandLyrics: { enabled: false } })
  await settle()
  const secondOpening = fixture.invoke('island-lyric:show')
  await settle()
  const second = fixture.latest()
  assert.notEqual(first, second)
  first.emit('ready-to-show')
  first.destroy()
  second.emit('ready-to-show')
  assert.equal((await firstOpening).success, false)
  assert.equal((await secondOpening).success, true)
  assert.equal(first.shows, 0)
  assert.ok(second.shows > 0)
  fixture.publish('track-update', { trackId: 'new', title: 'New' })
  assert.equal(fixture.last(second, 'song-update')[0].trackId, 'new')
  assert.equal((await fixture.invoke('island-lyric:control', first, 'next')).success, false)
  fixture.delayClose(false)
})

test('load failures and renderer crashes fail visibly and a repeated show can recover', async t => {
  const fixture = islandFixture(t)
  fixture.failLoad(true)
  let failed
  await fixture.runIslandTrayAction(async () => {
    failed = await fixture.invoke('island-lyric:show')
    return failed
  })
  assert.equal(failed.success, false)
  assert.ok(failed.error)
  assert.equal(fixture.windows.length, 2, 'one failed action creates exactly one island window')
  assert.equal(fixture.errors.length, 1, 'one failed load is reported once')
  assert.equal(fixture.dialogs.length, 1, 'the tray does not show a duplicate failure dialog')
  assert.equal(fixture.latest().isDestroyed(), true)
  fixture.update({ playback: { showTranslation: false } })
  await settle()
  assert.equal(fixture.windows.length, 2, 'ordinary settings broadcasts do not retry a failed window')
  fixture.failLoad(false)
  const win = await fixture.open()
  assert.equal(fixture.windows.length, 3, 'an explicit retry creates one replacement')
  win.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
  assert.equal(win.isDestroyed(), true)
  const recovered = await fixture.open()
  assert.notEqual(recovered, win)
  assert.ok(fixture.errors.length > 0)
})

test('concurrent opens share readiness and closing releases an unresolved file load', { timeout: 1500 }, async t => {
  const fixture = islandFixture(t)
  fixture.holdLoads(true)
  const first = fixture.invoke('island-lyric:show')
  const second = fixture.invoke('island-lyric:show')
  await settle()
  const pending = fixture.latest()
  assert.equal(fixture.windows.length, 2)
  fixture.update({ islandLyrics: { enabled: false } })
  assert.equal((await first).success, false)
  assert.equal((await second).success, false)
  assert.equal(pending.isDestroyed(), true)
  pending.emit('ready-to-show')
  assert.equal(pending.shows, 0)

  fixture.holdLoads(false)
  const third = fixture.invoke('island-lyric:show')
  const fourth = fixture.invoke('island-lyric:show')
  await settle()
  const ready = fixture.latest()
  ready.emit('ready-to-show')
  assert.equal((await third).success, true)
  assert.equal((await fourth).success, true)
  assert.equal(ready.shows, 1)
  assert.equal(ready.messages.filter(([name]) => name === 'island-lyric:lyric-update').length, 1)
})

test('Linux forwards actual pointer coordinates while ignored and releases polling on close, crash and quit', async t => {
  const fixture = islandFixture(t)
  const pointerTimers = () => [...fixture.timers.values()].filter(timer => timer.delay === 80)
  const opening = fixture.invoke('island-lyric:show')
  await settle()
  const win = fixture.latest()
  assert.equal(pointerTimers().length, 0, 'do not poll before the renderer can consume coordinates')
  win.emit('ready-to-show')
  assert.equal((await opening).success, true)
  assert.equal(pointerTimers().length, 1)
  assert.equal(win.ignoresMouse, true)
  const firstPoll = pointerTimers()[0].callback
  let cursor = { x: win.bounds.x + 74, y: win.bounds.y + 23 }
  fixture.screen.getCursorScreenPoint = () => cursor
  firstPoll()
  assert.deepEqual(plain(fixture.last(win, 'pointer-update')[0]), { clientX: 74, clientY: 23 })
  fixture.ipc.emit('island-lyric:set-interactive', fixture.event(win), true)
  assert.equal(win.ignoresMouse, false)
  cursor = { x: win.bounds.x - 10, y: win.bounds.y + win.bounds.height + 20 }
  firstPoll()
  assert.deepEqual(plain(fixture.last(win, 'pointer-update')[0]), { clientX: -10, clientY: win.bounds.height + 20 })
  fixture.ipc.emit('island-lyric:set-interactive', fixture.event(win), false)
  assert.equal(win.ignoresMouse, true)
  assert.equal((await fixture.invoke('island-lyric:show')).success, true)
  assert.equal(pointerTimers().length, 1, 'showing an existing window does not multiply polling')
  assert.equal((await fixture.invoke('island-lyric:close', win)).success, true)
  assert.equal(pointerTimers().length, 0)
  const oldMessages = win.messages.length
  firstPoll()
  assert.equal(win.messages.length, oldMessages, 'a stale interval callback cannot send after close')

  const reopened = await fixture.open()
  assert.equal(pointerTimers().length, 1)
  const newMessages = reopened.messages.length
  firstPoll()
  assert.equal(reopened.messages.length, newMessages, 'an old callback cannot send to the replacement window')
  reopened.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
  assert.equal(pointerTimers().length, 0)
  await fixture.open()
  assert.equal(pointerTimers().length, 1)
  await fixture.performApplicationCleanup()
  assert.equal(pointerTimers().length, 0)
  assert.equal(fixture.timers.size, 0)
})

test('playback availability tracks main reload, install preparation and crash; shutdown preserves the enabled preference', async t => {
  const fixture = islandFixture(t)
  const win = await fixture.open()
  fixture.publish('track-update', { trackId: 'song', title: 'Song' })
  fixture.publish('playback-state', 'playing')
  const state = () => fixture.last(win, 'playback-update')[0]
  fixture.main.webContents.emit('did-start-navigation', {}, 'app://reload', false, true)
  assert.equal(state().available, false)
  assert.equal(state().playing, false)
  assert.equal((await fixture.invoke('island-lyric:control', win, 'next')).success, false)
  fixture.ipc.emit('renderer:ready', fixture.event(fixture.main))
  assert.equal(state().available, true)
  fixture.notifyInstallPreparation({ requestId: 'controlled', phase: 'prepare' })
  assert.equal(state().available, false)
  fixture.notifyInstallPreparation({ requestId: 'controlled', phase: 'canceled' })
  assert.equal(state().available, true)
  fixture.main.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
  assert.equal(state().available, false)
  const writesBefore = fixture.writes.length
  await fixture.performApplicationCleanup()
  assert.equal(win.isDestroyed(), true)
  assert.equal(fixture.settings.islandLyrics.enabled, true)
  assert.equal(fixture.writes.length, writesBefore)
  assert.equal(fixture.timers.size, 0)
  for (const name of ['display-added', 'display-removed', 'display-metrics-changed']) assert.equal(fixture.screen.listenerCount(name), 0)
  assert.equal((await fixture.invoke('island-lyric:show')).success, false)
})

for (const platform of ['win32', 'linux']) {
  test(`${platform}: closing the main window with an enabled island cleans up and quits while preserving the preference`, async t => {
    const fixture = islandFixture(t, platform)
    const island = await fixture.open()
    const writesBefore = fixture.writes.length
    fixture.main.close()
    await settle()
    assert.equal(fixture.main.isDestroyed(), true)
    assert.equal(island.isDestroyed(), true)
    assert.equal(fixture.backendStops, 1)
    assert.equal(fixture.quitCalls, 1)
    assert.equal(fixture.settings.islandLyrics.enabled, true)
    assert.equal(fixture.writes.length, writesBefore, 'closing the application does not disable startup restoration')
    assert.equal(fixture.timers.size, 0)
    for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) {
      assert.equal(fixture.screen.listenerCount(event), 0)
    }
  })

  test(`${platform}: minimize-to-tray keeps both the main window and island alive without quitting`, async t => {
    const fixture = islandFixture(t, platform)
    const island = await fixture.open()
    fixture.update({ software: { minimizeToTray: true } })
    fixture.main.close()
    await settle()
    assert.equal(fixture.main.hidden, true)
    assert.equal(fixture.main.isDestroyed(), false)
    assert.equal(island.isDestroyed(), false)
    assert.equal(fixture.backendStops, 0)
    assert.equal(fixture.quitCalls, 0)
    assert.equal(fixture.settings.islandLyrics.enabled, true)
    fixture.publish('track-update', { trackId: 'tray-track', title: 'Tray playback' })
    assert.equal(fixture.last(island, 'song-update')[0].trackId, 'tray-track')
  })
}

test('macOS retains its background lifecycle when the main window closes with an enabled island', async t => {
  const fixture = islandFixture(t, 'darwin')
  const island = await fixture.open()
  fixture.main.close()
  await settle()
  assert.equal(fixture.main.isDestroyed(), true)
  assert.equal(island.isDestroyed(), false)
  assert.equal(fixture.backendStops, 0)
  assert.equal(fixture.quitCalls, 0)
  assert.equal(fixture.settings.islandLyrics.enabled, true)
  assert.equal(fixture.last(island, 'playback-update')[0].available, false)
  assert.equal(fixture.last(island, 'playback-update')[0].playing, false)
})

test('committed settings open and close the island and display changes keep its bounds inside the work area', async t => {
  const fixture = islandFixture(t)
  fixture.update({ islandLyrics: { enabled: true } })
  await settle()
  const win = fixture.latest()
  assert.ok(win)
  win.emit('ready-to-show')
  fixture.screen.area = { x: -800, y: 20, width: 800, height: 600 }
  fixture.screen.emit('display-removed')
  const bounds = win.getBounds()
  assert.ok(bounds.x >= -800 && bounds.x + bounds.width <= 0)
  assert.ok(bounds.y >= 20 && bounds.y + bounds.height <= 620)
  fixture.update({ playback: { showTranslation: false } })
  assert.equal(fixture.last(win, 'settings-update')[0].showTranslation, false)
  fixture.update({ islandLyrics: { enabled: false } })
  await settle()
  assert.equal(win.isDestroyed(), true)
})

test('a loading timeout settles pending opens and releases all island display listeners', { timeout: 1500 }, async t => {
  const fixture = islandFixture(t)
  fixture.holdLoads(true)
  const opening = fixture.invoke('island-lyric:show')
  await settle()
  const win = fixture.latest()
  const timeout = [...fixture.timers.values()].find(timer => timer.delay === 10000)
  assert.ok(timeout, 'window loading has a bounded timeout')
  timeout.callback()
  assert.equal((await opening).success, false)
  assert.equal(win.isDestroyed(), true)
  for (const name of ['display-added', 'display-removed', 'display-metrics-changed']) assert.equal(fixture.screen.listenerCount(name), 0)
  win.emit('ready-to-show')
  assert.equal(win.shows, 0)
})

test('native close also waits for committed disablement and leaves the window usable after a save failure', async t => {
  const fixture = islandFixture(t)
  const win = await fixture.open()
  fixture.failWrite(true)
  win.close()
  await settle()
  assert.equal(win.isDestroyed(), false)
  assert.equal(fixture.settings.islandLyrics.enabled, true)
  fixture.failWrite(false)
  win.close()
  await settle()
  assert.equal(win.isDestroyed(), true)
  assert.equal(fixture.settings.islandLyrics.enabled, false)
})

test('island preload exposes fixed validated operations and independently disposable payload-only subscriptions', async () => {
  const exposed = {}
  const ipc = new EventEmitter()
  const invoked = []
  const sent = []
  ipc.invoke = async (...args) => { invoked.push(args); return { success: true } }
  ipc.send = (...args) => sent.push(args)
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../electron/preload.js'), 'utf8'), {
    require: () => ({ ipcRenderer: ipc, contextBridge: { exposeInMainWorld(name, value) { exposed[name] = value } } }),
    window: {}, console
  })
  const api = exposed.islandLyricAPI
  assert.equal(api.send, undefined)
  assert.equal(api.invoke, undefined)
  assert.equal((await api.control('unrestricted')).success, false)
  assert.equal((await api.setTranslation('false')).success, false)
  api.setInteractive(1)
  assert.equal(invoked.length, 0)
  assert.equal(sent.length, 0)
  await exposed.electronAPI.islandLyric.show()
  for (const action of ['prev', 'toggle', 'next']) await api.control(action)
  await api.setTranslation(false)
  await api.close()
  assert.deepEqual(plain(invoked), [
    ['island-lyric:show'], ['island-lyric:control', 'prev'], ['island-lyric:control', 'toggle'],
    ['island-lyric:control', 'next'], ['island-lyric:set-translation', false], ['island-lyric:close']
  ])
  api.setInteractive(true)
  api.setInteractive(false)
  assert.deepEqual(sent, [['island-lyric:set-interactive', true], ['island-lyric:set-interactive', false]])
  for (const [method, channel, payload] of [
    ['onSongUpdate', 'song-update', { trackId: 'song', title: 'Song' }],
    ['onLyricUpdate', 'lyric-update', [{ time: 0, text: 'Lyric' }]],
    ['onTimeUpdate', 'time-update', 2500],
    ['onPlaybackUpdate', 'playback-update', { playing: false, available: true }],
    ['onSettingsUpdate', 'settings-update', { showTranslation: false }],
    ['onPointerUpdate', 'pointer-update', { clientX: 24, clientY: -10 }],
    ['onError', 'error', 'Controlled error']
  ]) {
    const name = `island-lyric:${channel}`
    let received
    const other = () => {}
    ipc.on(name, other)
    const release = api[method]((...args) => { received = args })
    ipc.emit(name, { sender: 'privileged object' }, payload)
    assert.deepEqual(received, [payload])
    release(); release()
    assert.equal(ipc.listenerCount(name), 1)
    api[method](null)()
    ipc.removeListener(name, other)
  }
})

test('top docking uses display bounds, selected screens and scaled native opacity without moving to the taskbar work area', async t => {
  const fixture = islandFixture(t, 'win32')
  const secondary = { id: 2, bounds: { x: -1920, y: -120, width: 1920, height: 1080 }, workArea: { x: -1920, y: -80, width: 1920, height: 1040 } }
  fixture.screen.getAllDisplays = () => [fixture.screen.getPrimaryDisplay(), secondary]
  fixture.update({ islandLyrics: { mode: 'mainland', displayId: '2', scale: 1.5, opacity: 0.6, showLogo: false } })
  const win = await fixture.open()
  assert.deepEqual(win.getBounds(), { x: -1380, y: -120, width: 840, height: 240 })
  assert.equal(win.opacity, 0.6)
  assert.equal(win.options.focusable, false)
  const prefs = fixture.last(win, 'settings-update')[0]
  assert.equal(prefs.showLogo, false)
  assert.equal(prefs.scale, 1.5)
  assert.match(prefs.logoUrl, /^file:/)
  fixture.screen.getAllDisplays = () => [fixture.screen.getPrimaryDisplay()]
  fixture.screen.emit('display-removed')
  assert.equal(win.bounds.y, 0)
  assert.ok(win.bounds.x >= 0)
})

test('auto-hide preserves enablement, manual preview expires, playback restores visibility and unavailable playback hides', async t => {
  const fixture = islandFixture(t)
  fixture.update({ islandLyrics: { autoHide: true, enabled: true } })
  await settle()
  const win = fixture.latest()
  win.emit('ready-to-show')
  assert.equal(win.shows, 0, 'startup does not flash a paused island')
  assert.equal((await fixture.invoke('island-lyric:show')).success, true)
  assert.equal(win.hidden, false)
  const preview = [...fixture.timers.values()].find(timer => timer.delay === 3000)
  assert.ok(preview)
  preview.callback()
  assert.equal(win.hidden, true)
  assert.deepEqual(plain(fixture.last(win, 'pointer-update')[0]), { clientX: -1, clientY: -1, resetInteractive: true })
  assert.equal(fixture.settings.islandLyrics.enabled, true)
  fixture.screen.getCursorScreenPoint = () => ({ x: win.bounds.x + 100, y: win.bounds.y + 20 })
  fixture.publish('track-update', { trackId: 'playing', title: 'Track' })
  fixture.publish('playback-state', 'playing')
  assert.equal(win.hidden, false)
  assert.deepEqual(plain(fixture.last(win, 'pointer-update')[0]), { clientX: 100, clientY: 20, resetInteractive: true })
  fixture.publish('playback-state', 'paused')
  assert.equal(win.hidden, true)
  fixture.update({ islandLyrics: { autoHide: false } })
  assert.equal(win.hidden, false)
  fixture.update({ islandLyrics: { autoHide: true } })
  fixture.publish('playback-state', 'playing')
  fixture.main.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
  assert.equal(win.hidden, true)
})

test('external fullscreen is gated, converted to DIP, restricted to the island screen, and cleaned up on disable', async t => {
  const fixture = islandFixture(t, 'win32')
  const win = await fixture.open()
  assert.equal(fixture.fullscreenActive, false)
  fixture.update({ islandLyrics: { hideOnFullscreen: true } })
  assert.equal(fixture.fullscreenActive, true)
  fixture.screen.screenToDipRect = (_window, bounds) => Object.fromEntries(Object.entries(bounds).map(([key, value]) => [key, value / 2]))
  fixture.fullscreen({ fullscreen: true, bounds: { x: 2560, y: 0, width: 1920, height: 1600 } })
  assert.equal(win.hidden, false, 'fullscreen on another display does not hide the island')
  fixture.fullscreen({ fullscreen: true, bounds: { x: 0, y: 0, width: 2560, height: 1600 } })
  assert.equal(win.hidden, true)
  await fixture.invoke('island-lyric:show')
  assert.equal(win.hidden, true, 'preview does not cover a full-screen application')
  fixture.fullscreen({ fullscreen: false })
  assert.equal(win.hidden, false)
  fixture.update({ islandLyrics: { enabled: false } })
  assert.equal(fixture.fullscreenActive, false)
})

test('main lyric view hides the island only on the same visible display and rejects child-frame visibility requests', async t => {
  const fixture = islandFixture(t)
  fixture.update({ islandLyrics: { hideOnLyricView: true } })
  const win = await fixture.open()
  const event = fixture.event(fixture.main)
  fixture.ipc.emit('island-lyric:main-lyrics', { ...event, senderFrame: {} }, true)
  assert.equal(win.hidden, false)
  fixture.ipc.emit('island-lyric:main-lyrics', event, true)
  assert.equal(win.hidden, true)
  fixture.main.hide()
  assert.equal(win.hidden, false)
  fixture.main.show()
  assert.equal(win.hidden, true)
  fixture.ipc.emit('island-lyric:main-lyrics', event, false)
  assert.equal(win.hidden, false)
  fixture.screen.getDisplayMatching = rect => rect.x === 2000
    ? { bounds: { x: 1920, y: 0, width: 1280, height: 800 } } : fixture.screen.getPrimaryDisplay()
  fixture.main.setBounds({ x: 2000, y: 0, width: 900, height: 600 })
  fixture.ipc.emit('island-lyric:main-lyrics', event, true)
  assert.equal(win.hidden, false)
  fixture.main.setBounds({ x: 0, y: 0, width: 900, height: 600 })
  assert.equal(win.hidden, true)
  fixture.main.webContents.emit('did-start-navigation', {}, 'app://reload', false, true)
  assert.equal(win.hidden, false)
})

test('floating drag uses native cursor coordinates, persists positions, snaps at the top, and restores after write failure', async t => {
  const fixture = islandFixture(t)
  fixture.update({ islandLyrics: { mode: 'floating', position: { x: 100, y: 120 }, displayId: 'primary' } })
  const win = await fixture.open()
  assert.equal(win.options.focusable, true)
  assert.equal((await fixture.invoke('island-lyric:begin-drag', fixture.main)).success, false)
  let cursor = { x: 300, y: 150 }
  fixture.screen.getCursorScreenPoint = () => cursor
  assert.equal((await fixture.invoke('island-lyric:begin-drag', win)).success, true)
  cursor = { x: 500, y: 250 }
  fixture.ipc.emit('island-lyric:drag', fixture.event(win), { x: -9999, y: -9999 })
  assert.deepEqual(win.getBounds(), { x: 300, y: 220, width: 560, height: 160 })
  assert.equal((await fixture.invoke('island-lyric:end-drag', win)).success, true)
  assert.deepEqual(plain(fixture.settings.islandLyrics.position), { x: 300, y: 220 })
  assert.equal(fixture.settings.islandLyrics.displayId, '1')
  fixture.failWrite(true)
  await fixture.invoke('island-lyric:begin-drag', win)
  cursor = { x: 510, y: 300 }
  assert.equal((await fixture.invoke('island-lyric:end-drag', win)).success, false)
  assert.equal(win.bounds.y, 220)
  fixture.failWrite(false)
  await fixture.invoke('island-lyric:begin-drag', win)
  cursor = { x: 520, y: 70 }
  assert.equal((await fixture.invoke('island-lyric:end-drag', win)).success, true)
  assert.equal(fixture.settings.islandLyrics.mode, 'mainland')
  assert.equal(win.bounds.y, 0)
  assert.equal((await fixture.invoke('island-lyric:begin-drag', win)).success, false)
})

test('screen enumeration is main-frame-only, updates on hotplug and releases notifications at quit', async t => {
  const fixture = islandFixture(t, 'win32')
  const invalid = { ...fixture.event(fixture.main), senderFrame: {} }
  assert.deepEqual(plain(await fixture.handlers.get('island-lyric:get-displays')(invalid)), [])
  assert.equal((await fixture.handlers.get('island-lyric:get-capabilities')(invalid)).fullscreenDetection, false)
  assert.equal((await fixture.invoke('island-lyric:get-capabilities')).fullscreenDetection, true)
  assert.deepEqual(plain(await fixture.invoke('island-lyric:get-displays')), [{ id: '1', label: '屏幕 1', primary: true }])
  await fixture.invoke('island-lyric:get-displays')
  assert.equal(fixture.screen.listenerCount('display-added'), 1)
  fixture.screen.emit('display-added')
  assert.ok(fixture.main.messages.some(([channel]) => channel === 'island-lyric:displays-changed'))
  await fixture.performApplicationCleanup()
  assert.equal(fixture.screen.listenerCount('display-added'), 0)
})

test('macOS Dock activation recreates the main window while an auxiliary island still exists', async t => {
  const fixture = islandFixture(t, 'darwin')
  const island = await fixture.open()
  fixture.main.close()
  assert.equal(fixture.main.isDestroyed(), true)
  assert.equal(island.isDestroyed(), false)
  fixture.restoreMainWindowOnActivate()
  assert.equal(fixture.windows.length, 3)
  assert.equal(fixture.windows.at(-1).options.minWidth, 1024)
})

test('quit waits for the final dragged position and declines another drag until that save completes', async t => {
  const fixture = islandFixture(t)
  fixture.update({ islandLyrics: { mode: 'floating', position: { x: 100, y: 120 } } })
  const island = await fixture.open()
  let cursor = { x: 300, y: 150 }
  fixture.screen.getCursorScreenPoint = () => cursor
  await fixture.invoke('island-lyric:begin-drag', island)
  cursor = { x: 340, y: 180 }
  const release = fixture.holdNextWrite()
  const saving = fixture.invoke('island-lyric:end-drag', island)
  await settle()
  assert.equal((await fixture.invoke('island-lyric:begin-drag', island)).success, false)
  let completed = false
  const cleanup = fixture.performApplicationCleanup().then(() => { completed = true })
  await settle()
  assert.equal(completed, false)
  release()
  assert.equal((await saving).success, true)
  await cleanup
  assert.deepEqual(plain(fixture.settings.islandLyrics.position), { x: 140, y: 150 })
  assert.equal(island.isDestroyed(), true)
})
