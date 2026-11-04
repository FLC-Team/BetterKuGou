const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')

const plain = value => JSON.parse(JSON.stringify(value))
async function settle() { for (let index = 0; index < 24; index++) await Promise.resolve() }
function gate() { let release; const promise = new Promise(resolve => { release = resolve }); return { promise, release } }

/** Execute main.js with committed settings and an asynchronous taskbar OS adapter. */
function fixture(t, platform = 'win32') {
  const ipc = new EventEmitter(), handlers = new Map(), windows = [], errors = [], timers = new Map()
  ipc.handle = (channel, handler) => handlers.set(channel, handler)
  let timerId = 0, backendStops = 0, serviceCreates = 0, settingsListener = null
  let writeFailure = false, nextWriteGate = null, writeQueue = Promise.resolve(), nextShowGate = null, nextCloseGate = null
  let snapshot = { taskbarLyrics: { enabled: false, embed: true, autoHide: false }, islandLyrics: { enabled: false },
    desktopLyrics: {}, playback: { showTranslation: true }, software: { updates: {}, minimizeToTray: false } }
  const writes = [], metrics = { shows: 0, closes: 0, previews: 0, reset: 0, sizes: [], messages: [], configurations: [] }
  let current = null, serviceOptions = null, nativeDark
  const app = Object.assign(new EventEmitter(), { isPackaged: true, whenReady: () => new Promise(() => {}),
    commandLine: { appendSwitch() {} }, quit() {}, getPath: () => '/controlled-user-data', getVersion: () => '0.2.0', getAppPath: () => path.resolve(__dirname, '..') })
  const nativeTheme = Object.assign(new EventEmitter(), { shouldUseDarkColors: true })
  const screen = Object.assign(new EventEmitter(), {
    getPrimaryDisplay: () => ({ id: 1, workArea: { x: 0, y: 0, width: 1280, height: 760 }, bounds: { x: 0, y: 0, width: 1280, height: 800 } }),
    getAllDisplays() { return [this.getPrimaryDisplay()] }, getDisplayMatching() { return this.getPrimaryDisplay() }
  })
  class Window extends EventEmitter {
    constructor(options = {}) {
      super(); this.options = options; this.messages = []; this.destroyed = false; this.shows = 0; this.focuses = 0
      this.webContents = Object.assign(new EventEmitter(), { mainFrame: {}, send: (...args) => this.messages.push(args),
        session: { clearCache: async () => {} }, isDestroyed: () => this.destroyed, openDevTools() {} })
      windows.push(this)
    }
    loadURL() { return Promise.resolve() }
    isDestroyed() { return this.destroyed }
    isVisible() { return this.shows > 0 }
    isMinimized() { return false }
    getBounds() { return { x: 0, y: 0, width: 1280, height: 720 } }
    show() { this.shows++; this.emit('show') }
    showInactive() { this.shows++; this.emit('show') }
    focus() { this.focuses++ }
    hide() { this.emit('hide') }
    setThumbarButtons() { return true }
    destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('closed') } }
    close() { this.destroy() }
    static getAllWindows() { return windows.filter(win => !win.destroyed) }
  }
  const event = win => ({ sender: win.webContents, senderFrame: win.webContents.mainFrame })
  const service = {
    configure(settings) { metrics.configurations.push(plain(settings)) },
    show() {
      metrics.shows++
      if (current) return current.ready
      const showGate = nextShowGate
      nextShowGate = null
      const state = { window: new Window(), active: true }
      current = state
      state.ready = (async () => {
        if (showGate) await showGate.promise
        if (!state.active || serviceOptions.isQuitting()) return false
        serviceOptions.onReady()
        return true
      })()
      return state.ready
    },
    async close() {
      metrics.closes++
      const closeGate = nextCloseGate
      nextCloseGate = null
      const state = current
      if (state) { state.active = false; current = null; state.window.destroy() }
      if (closeGate) await closeGate.promise
    },
    send(channel, ...payload) { metrics.messages.push([channel, ...plain(payload)]) },
    isSender(input) { return Boolean(current?.active && input.sender === current.window.webContents && input.senderFrame === current.window.webContents.mainFrame) },
    preview() { metrics.previews++ },
    getState() { return { supported: true, visible: Boolean(current?.active), embedded: false, status: current?.active ? 'floating' : 'disabled', ...(typeof nativeDark === 'boolean' ? { dark: nativeDark } : {}) } },
    setContentSize(size) { metrics.sizes.push(plain(size)) },
    resetPosition() { metrics.reset++; return { success: true } }
  }
  const settings = {
    getSettings: () => snapshot,
    onSettingsChange(callback) { settingsListener = callback; return () => { settingsListener = null } },
    setSettings(patch) {
      const writeGate = nextWriteGate
      nextWriteGate = null
      const operation = writeQueue.then(async () => {
        if (writeGate) await writeGate.promise
        if (writeFailure) throw new Error('Controlled write failure')
        writes.push(plain(patch))
        for (const [key, value] of Object.entries(patch)) snapshot[key] = { ...snapshot[key], ...value }
        settingsListener?.(snapshot)
        return snapshot
      })
      writeQueue = operation.catch(() => {})
      return operation
    }
  }
  const logger = Object.fromEntries(['trace', 'info', 'warn', 'debug', 'error'].map(level => [level, (...args) => { if (level === 'error') errors.push(args) }]))
  const electron = { app, BrowserWindow: Window, ipcMain: ipc, screen, nativeTheme,
    nativeImage: { createFromPath: () => ({ isEmpty: () => false }) }, globalShortcut: { unregisterAll() {} },
    dialog: { showMessageBox: async () => ({ response: 0 }) } }
  const timerAPI = {
    setTimeout(callback, delay) { timers.set(++timerId, { callback, delay }); return timerId }, clearTimeout(id) { timers.delete(id) },
    setInterval(callback, delay) { timers.set(++timerId, { callback, delay }); return timerId }, clearInterval(id) { timers.delete(id) }
  }
  const context = vm.createContext({ __dirname: path.resolve(__dirname, '../electron'),
    process: { platform, env: {}, resourcesPath: '/resources', memoryUsage: process.memoryUsage }, console: logger, global: {}, Buffer, ...timerAPI,
    require(name) {
      if (name === 'electron') return electron
      if (name === './logger') return logger
      if (name === './settingsStore') return settings
      if (name === './services/taskbarLyricService') return { createTaskbarLyricService(options) { serviceCreates++; serviceOptions = options; return service } }
      if (name === './services/backendService') return { createBackendService: () => ({ stop: async () => { backendStops++ } }) }
      if (name === './services/updateService') return { createUpdateService: () => ({ configure() {}, stop: async () => {} }) }
      if (name === './services/playlistCacheService') return { createPlaylistCacheService: () => ({ configure() {}, stop: async () => {} }) }
      if (name === './services/musicDownloadService') return { createMusicDownloadService: () => ({ configure: async () => {}, setSession: async () => {}, stop: async () => {} }) }
      if (name.startsWith('./services/')) return require(path.resolve(__dirname, '../electron', name))
      return require(name)
    }
  })
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../electron/main.js'), 'utf8'), context, { filename: 'main.js' })
  const api = vm.runInContext('({ createWindow, subscribeToSettingsUpdates, performApplicationCleanup, notifyInstallPreparation })', context)
  api.createWindow()
  const main = windows[0]
  ipc.emit('renderer:ready', event(main))
  api.subscribeToSettingsUpdates()
  const invoke = (channel, win = main, value) => handlers.get('taskbar-lyric:' + channel)(event(win), value)
  t.after(async () => { await api.performApplicationCleanup(); windows.forEach(win => win.destroy()) })
  return { ...api, ipc, handlers, main, event, invoke, metrics, nativeTheme, screen, writes, errors,
    get settings() { return snapshot }, get taskbar() { return current?.window }, get serviceCreates() { return serviceCreates }, get backendStops() { return backendStops },
    publish(channel, ...payload) { ipc.emit('player:' + channel, event(main), ...payload) },
    last(channel) { return metrics.messages.filter(message => message[0] === 'taskbar-lyric:' + channel).at(-1)?.slice(1) },
    update(patch) { for (const [key, value] of Object.entries(patch)) snapshot[key] = { ...snapshot[key], ...value }; settingsListener?.(snapshot) },
    failWrite(value) { writeFailure = value },
    setNativeDark(value) { nativeDark = value },
    holdWrite() { nextWriteGate = gate(); return nextWriteGate.release },
    holdShow() { nextShowGate = gate(); return nextShowGate.release },
    holdClose() { nextCloseGate = gate(); return nextCloseGate.release }
  }
}

test('taskbar opens only after a successful preference write and replays the complete paused snapshot', async t => {
  const f = fixture(t)
  f.publish('track-update', { trackId: 'first', title: 'Song', artist: 'Artist', cover: 'https://example.test/cover.jpg' })
  f.publish('lyric-update', [{ time: 1000, text: '歌词 😀', translation: 'Translation' }], 'first')
  f.publish('time-update', 12500, { trackId: 'first', duration: 60000, playbackRate: 1.5 })
  f.publish('playback-state', 'paused')
  const release = f.holdWrite(), opening = f.invoke('show')
  await settle()
  assert.equal(f.serviceCreates, 0)
  release()
  assert.equal((await opening).success, true)
  assert.equal(f.serviceCreates, 1)
  assert.equal(f.metrics.shows, 1)
  assert.equal(f.metrics.previews, 1)
  assert.equal(f.settings.taskbarLyrics.enabled, true)
  assert.equal(f.last('song-update')[0].trackId, 'first')
  assert.equal(f.last('lyric-update')[0][0].translation, 'Translation')
  assert.deepEqual(f.last('time-update'), [12500, { duration: 60000, playbackRate: 1.5, advancing: false, discontinuity: true }])
  assert.deepEqual(f.last('playback-update'), [{ playing: false, time: 12500, duration: 60000, available: true }])
  assert.equal(f.last('settings-update')[0].showTranslation, true)
})

test('failed enable and disable writes preserve the last committed window preference and permit retry', async t => {
  const f = fixture(t)
  f.failWrite(true)
  assert.equal((await f.invoke('show')).success, false)
  assert.equal(f.serviceCreates, 0)
  assert.equal(f.settings.taskbarLyrics.enabled, false)
  f.failWrite(false)
  assert.equal((await f.invoke('show')).success, true)
  const current = f.taskbar
  f.failWrite(true)
  assert.equal((await f.invoke('hide')).success, false)
  assert.equal(f.settings.taskbarLyrics.enabled, true)
  assert.equal(f.taskbar, current)
  f.failWrite(false)
  assert.equal((await f.invoke('hide')).success, true)
  assert.equal(f.settings.taskbarLyrics.enabled, false)
  assert.equal(f.taskbar, undefined)
})

test('taskbar forwards only confirmed main-document audio updates and clears stale same-title lyrics', async t => {
  const f = fixture(t)
  await f.invoke('show')
  f.publish('track-update', { trackId: 'first', title: 'Same' })
  f.publish('lyric-update', [{ time: 0, text: 'first' }], 'first')
  f.publish('time-update', 12000, { trackId: 'first', duration: 30000, advancing: true })
  f.publish('track-update', { trackId: 'second', title: 'Same' })
  f.publish('lyric-update', [{ time: 0, text: 'stale' }], 'first')
  f.publish('time-update', 99999, { trackId: 'first' })
  const childFrame = { sender: f.main.webContents, senderFrame: {} }
  f.ipc.emit('player:track-update', childFrame, { trackId: 'forged', title: 'Forged' })
  f.ipc.emit('player:time-update', f.event(f.taskbar), 99999, { trackId: 'second' })
  assert.equal(f.last('song-update')[0].trackId, 'second')
  assert.deepEqual(f.last('lyric-update'), [[]])
  assert.equal(f.last('time-update')[0], 0)
  f.publish('time-update', 3200, { trackId: 'second', duration: 40000, advancing: true, discontinuity: true, playbackRate: 2 })
  assert.deepEqual(f.last('time-update'), [3200, { duration: 40000, playbackRate: 2, advancing: true, discontinuity: true }])
  f.publish('track-update', null)
  assert.deepEqual(f.last('song-update'), [null])
  await f.invoke('hide'); await f.invoke('show')
  assert.deepEqual(f.last('song-update'), [null])
  assert.deepEqual(f.last('lyric-update'), [[]])
  assert.equal(f.last('playback-update')[0].available, false)
})

test('window operations and playback controls reject other frames; valid controls never focus the main window', async t => {
  const f = fixture(t)
  const foreign = { sender: f.main.webContents, senderFrame: {} }
  for (const channel of ['show', 'hide', 'reset-position']) {
    assert.equal((await f.handlers.get('taskbar-lyric:' + channel)(foreign)).success, false)
  }
  assert.deepEqual(plain(await f.handlers.get('taskbar-lyric:get-displays')(foreign)), [])
  assert.equal((await f.handlers.get('taskbar-lyric:get-capabilities')(foreign)).supported, false)
  assert.equal(f.writes.length, 0)
  await f.invoke('show')
  assert.equal((await f.invoke('control', f.taskbar, 'toggle')).success, false, 'empty player is unavailable')
  f.publish('track-update', { trackId: 'song', title: 'Song' })
  assert.equal((await f.invoke('control', f.main, 'toggle')).success, false)
  assert.equal((await f.invoke('control', f.taskbar, 'arbitrary')).success, false)
  const focuses = f.main.focuses, shows = f.main.shows
  for (const action of ['prev', 'next', 'toggle']) assert.equal((await f.invoke('control', f.taskbar, action)).success, true)
  assert.deepEqual(f.main.messages.filter(([channel]) => channel === 'player:control').map(([, action]) => action), ['prev', 'next', 'play'])
  f.publish('playback-state', 'playing')
  assert.equal((await f.invoke('control', f.taskbar, 'toggle')).success, true)
  assert.equal(f.main.messages.at(-1)[1], 'pause')
  assert.equal(f.main.focuses, focuses)
  assert.equal(f.main.shows, shows)
  assert.equal(f.notifyInstallPreparation({ phase: 'prepare', requestId: 'installation' }), true)
  assert.equal((await f.invoke('control', f.taskbar, 'next')).success, false)
  assert.equal(f.last('playback-update')[0].available, false)
  f.notifyInstallPreparation({ phase: 'canceled', requestId: 'installation' })
  assert.equal((await f.invoke('control', f.taskbar, 'next')).success, true)
  f.main.webContents.emit('render-process-gone')
  assert.equal((await f.invoke('control', f.taskbar, 'next')).success, false)
})

test('content dimensions and ready reports are accepted only from the current taskbar top frame', async t => {
  const f = fixture(t)
  await f.invoke('show')
  f.publish('track-update', { trackId: 'song', title: 'Song' })
  const current = f.taskbar
  f.metrics.messages.length = 0
  for (const source of [f.event(f.main), { sender: current.webContents, senderFrame: {} }]) {
    f.ipc.emit('taskbar-lyric:ready', source)
    f.ipc.emit('taskbar-lyric:resize', source, { width: 99999, height: 99999 })
  }
  assert.deepEqual(f.metrics.messages, [])
  assert.deepEqual(f.metrics.sizes, [])
  f.ipc.emit('taskbar-lyric:ready', f.event(current))
  assert.equal(f.last('song-update')[0].trackId, 'song')
  for (const width of [NaN, Infinity, -10, 0, '1000']) f.ipc.emit('taskbar-lyric:resize', f.event(current), { width, height: 48 })
  assert.deepEqual(f.metrics.sizes, [])
  f.ipc.emit('taskbar-lyric:resize', f.event(current), { width: 99999, height: -2 })
  assert.deepEqual(f.metrics.sizes, [{ width: 8192, height: 20 }])
})

test('disable wins against an in-flight open and later enable waits for native close completion', async t => {
  const f = fixture(t)
  const releaseShow = f.holdShow(), opening = f.invoke('show')
  await settle()
  const oldWindow = f.taskbar
  assert.ok(oldWindow)
  const releaseClose = f.holdClose(), closing = f.invoke('hide')
  await settle()
  assert.equal(f.settings.taskbarLyrics.enabled, false)
  const reopening = f.invoke('show')
  await settle()
  assert.equal(f.metrics.shows, 1, 'new native window waits for previous restore/detach')
  releaseShow()
  assert.equal((await opening).success, false)
  assert.equal(f.metrics.previews, 0, 'a closed opening cannot preview a replacement')
  releaseClose()
  await closing
  assert.equal((await reopening).success, true)
  assert.equal(f.settings.taskbarLyrics.enabled, true)
  assert.equal(f.metrics.shows, 2)
  assert.notEqual(f.taskbar, oldWindow)
  assert.equal((await f.invoke('control', oldWindow, 'next')).success, false)
})

test('theme and display listeners update live taskbar preferences and are released on awaited exit', async t => {
  const f = fixture(t)
  await f.invoke('show')
  await f.invoke('get-displays')
  assert.equal(f.nativeTheme.listenerCount('updated'), 1)
  f.nativeTheme.shouldUseDarkColors = false
  f.nativeTheme.emit('updated')
  assert.equal(f.last('settings-update')[0].dark, false)
  f.update({ playback: { showTranslation: false }, taskbarLyrics: { fontScale: 1.5 } })
  assert.equal(f.last('settings-update')[0].showTranslation, false)
  assert.equal(f.last('settings-update')[0].fontScale, 1.5)
  f.screen.emit('display-removed')
  assert.ok(f.main.messages.some(([channel]) => channel === 'taskbar-lyric:displays-changed'))
  const releaseClose = f.holdClose()
  const cleanup = f.performApplicationCleanup()
  assert.equal(cleanup, f.performApplicationCleanup())
  await settle()
  assert.equal(f.backendStops, 0)
  assert.equal(f.nativeTheme.listenerCount('updated'), 0)
  assert.equal(f.screen.listenerCount('display-removed'), 0)
  assert.equal((await f.invoke('show')).success, false)
  releaseClose()
  await cleanup
  assert.equal(f.backendStops, 1)
  assert.equal(f.settings.taskbarLyrics.enabled, true, 'exit retains the saved startup preference')
})

test('exit during the first enable write cannot create a late service or theme listener', async t => {
  const f = fixture(t)
  const release = f.holdWrite(), opening = f.invoke('show')
  await settle()
  await f.performApplicationCleanup()
  release()
  assert.equal((await opening).success, false)
  assert.equal(f.serviceCreates, 0)
  assert.equal(f.nativeTheme.listenerCount('updated'), 0)
  assert.equal(f.metrics.shows, 0)
})

test('settings broadcasts retain the sampled taskbar color when Windows app and taskbar themes differ', async t => {
  const f = fixture(t)
  await f.invoke('show')
  f.setNativeDark(true)
  f.nativeTheme.shouldUseDarkColors = false
  f.nativeTheme.emit('updated')
  assert.equal(f.last('settings-update')[0].dark, true, 'SystemUsesLightTheme outranks the app theme')
  f.update({ taskbarLyrics: { fontScale: 1.2 } })
  assert.equal(f.last('settings-update')[0].dark, true)
  f.setNativeDark(false)
  f.nativeTheme.shouldUseDarkColors = true
  f.update({ playback: { showTranslation: false } })
  assert.equal(f.last('settings-update')[0].dark, false)
})

test('unsupported platforms advertise no taskbar capability and do not change saved enablement', async t => {
  const f = fixture(t, 'linux')
  assert.equal((await f.invoke('get-capabilities')).supported, false)
  assert.equal((await f.invoke('show')).success, false)
  assert.equal((await f.invoke('reset-position')).success, false)
  f.update({ taskbarLyrics: { enabled: true } })
  assert.equal(f.serviceCreates, 0)
  assert.equal(f.writes.length, 0)
})

test('taskbar preload exposes fixed operations and removable payload-only subscriptions', async () => {
  const exposed = {}, ipc = new EventEmitter(), invoked = [], sent = []
  ipc.invoke = async (...args) => { invoked.push(args); return { success: true } }
  ipc.send = (...args) => sent.push(args)
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../electron/preload.js'), 'utf8'), {
    require: () => ({ ipcRenderer: ipc, contextBridge: { exposeInMainWorld(name, value) { exposed[name] = value } } }), window: {}, console
  })
  const api = exposed.taskbarLyricAPI, management = exposed.electronAPI.taskbarLyric
  assert.equal(api.invoke, undefined); assert.equal(api.send, undefined)
  assert.equal((await api.control('arbitrary')).success, false)
  api.resize({ width: NaN }); api.resize({ width: -2 })
  assert.deepEqual(invoked, []); assert.deepEqual(sent, [])
  for (const method of ['show', 'hide', 'resetPosition', 'getDisplays', 'getCapabilities', 'getState']) await management[method]()
  for (const action of ['prev', 'toggle', 'next']) await api.control(action)
  await api.close(); api.ready(); api.resize({ width: 400, height: 48, ignored: true })
  assert.deepEqual(plain(invoked), [['taskbar-lyric:show'], ['taskbar-lyric:hide'], ['taskbar-lyric:reset-position'], ['taskbar-lyric:get-displays'], ['taskbar-lyric:get-capabilities'], ['taskbar-lyric:get-state'], ['taskbar-lyric:control', 'prev'], ['taskbar-lyric:control', 'toggle'], ['taskbar-lyric:control', 'next'], ['taskbar-lyric:close']])
  assert.deepEqual(plain(sent), [['taskbar-lyric:ready'], ['taskbar-lyric:resize', { width: 400, height: 48 }]])
  for (const [bridge, method, channel] of [[api, 'onSongUpdate', 'song-update'], [api, 'onLyricUpdate', 'lyric-update'],
    [api, 'onTimeUpdate', 'time-update'], [api, 'onPlaybackUpdate', 'playback-update'], [api, 'onSettingsUpdate', 'settings-update'],
    [api, 'onRuntimeState', 'runtime-state'], [api, 'onState', 'state'], [api, 'onError', 'error'],
    [management, 'onState', 'state'], [management, 'onDisplaysChanged', 'displays-changed']]) {
    const name = 'taskbar-lyric:' + channel, payload = { value: 1 }
    let received
    const other = () => {}
    ipc.on(name, other)
    const release = bridge[method]((...args) => { received = args })
    ipc.emit(name, { sender: 'privileged object' }, payload)
    assert.deepEqual(received, [payload])
    release(); release(); bridge[method](null)()
    assert.equal(ipc.listenerCount(name), 1)
    ipc.removeListener(name, other)
  }
})
