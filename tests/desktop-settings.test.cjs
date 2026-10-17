const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')

/** Load real IPC handlers with isolated windows and no OS registration or backend. */
function desktopFixture() {
  const ipc = new EventEmitter()
  const handlers = new Map()
  ipc.handle = (channel, handler) => handlers.set(channel, handler)
  const app = new EventEmitter()
  Object.assign(app, { isPackaged: true, whenReady: () => new Promise(() => {}), commandLine: { appendSwitch() {} } })
  const windows = []
  const dialogs = []
  const screen = Object.assign(new EventEmitter(), {
    area: { x: 0, y: 0, width: 1280, height: 800 }, point: { x: 0, y: 0 },
    getPrimaryDisplay() { return { workArea: this.area } },
    getDisplayMatching() { return { workArea: this.area } },
    getCursorScreenPoint() { return this.point }
  })
  let loadFailure = false
  let writeFailure = false
  let delayClose = false
  let writeGate = null
  class Window extends EventEmitter {
    constructor(options = {}) {
      super(); this.messages = []; this.options = options; this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height }
      this.destroyed = false; this.shows = 0
      this.webContents = Object.assign(new EventEmitter(), { mainFrame: {}, send: (...args) => this.messages.push(args) })
      windows.push(this)
    }
    loadFile() { return loadFailure ? Promise.reject(new Error('Missing HTML')) : Promise.resolve() }
    isDestroyed() { return this.destroyed }
    show() { this.shows++ }
    getBounds() { return { ...this.bounds } }
    setBounds(bounds) { this.bounds = { ...bounds }; this.emit('resize') }
    setIgnoreMouseEvents(value) { this.ignoresMouse = value }
    setMovable(value) { this.movable = value }
    setFocusable(value) { this.focusable = value }
    close() { this.emit('close'); if (!delayClose) this.destroy() }
    destroy() { this.destroyed = true; this.emit('closed') }
    static getAllWindows() { return windows }
  }
  let initialized = false
  let snapshot = { desktopLyrics: { fontSize: 'large', theme: 'minimal', locked: true } }
  let listener
  const writes = []
  const silent = Object.fromEntries(['trace', 'warn', 'error', 'info', 'debug'].map(name => [name, () => {}]))
  const sandbox = vm.createContext({
    require(name) {
      if (name === 'electron') return { app, BrowserWindow: Window, ipcMain: ipc, screen,
        dialog: { async showMessageBox(options) { dialogs.push(options) } } }
      if (name === './logger') return silent
      if (name === './services/playlistCacheService') return { createPlaylistCacheService: () => ({ configure() {}, stop: async () => {} }) }
      if (name === './services/backendService') return { createBackendService: () => ({}) }
      if (name === './settingsStore') return {
        getSettings() { if (!initialized) throw new Error('Settings store not initialized'); return snapshot },
        onSettingsChange(callback) { listener = callback; return () => {} },
        async setSettings(patch) {
          if (writeGate) { const gate = writeGate; writeGate = null; await gate }
          if (writeFailure) throw new Error('Disk full')
          writes.push(patch)
          for (const [group, value] of Object.entries(patch)) snapshot[group] = { ...snapshot[group], ...value }
          listener?.(snapshot); return snapshot
        }
      }
      if (name === './services/updateService') return { createUpdateService: () => ({ configure() {}, stop: async () => {} }) }
      return require(name)
    },
    __dirname: path.resolve(__dirname, '../electron'), process: { platform: 'linux', env: {} }, setTimeout, clearTimeout, setInterval, clearInterval
  })
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../electron/main.js'), 'utf8'), sandbox)
  const api = vm.runInContext('({createDesktopLyricWindow, subscribeToSettingsUpdates, closeDesktopLyricWindow, flushDesktopLyricBounds, getDesktopLyricBounds, runDesktopTrayAction, saveDesktopPreference})', sandbox)
  const main = new Window()
  sandbox.testMain = main
  vm.runInContext('mainWindow = testMain; mainWindowReady = true', sandbox)
  const event = win => ({ sender: win.webContents, senderFrame: win.webContents.mainFrame })
  return { ...api, ipc, writes, windows, screen, main, event, handlers, dialogs,
    mainEvent: event(main), ready() { initialized = true },
    open() { const win = api.createDesktopLyricWindow(); win.emit('ready-to-show'); return win },
    latest() { return windows.at(-1) }, invoke(channel, win = main, value) { return handlers.get(channel)(event(win), value) },
    failLoad(value) { loadFailure = value }, failWrite(value) { writeFailure = value }, delayClose(value) { delayClose = value },
    holdNextWrite() { let release; writeGate = new Promise(resolve => { release = resolve }); return release },
    quit() { vm.runInContext('isQuitting = true', sandbox) },
    update(settings) { snapshot = settings; listener?.(snapshot) } }
}

test('desktop lyrics tolerate early opening and replay the current lyrics, position and committed preferences', async () => {
  const fixture = desktopFixture()
  fixture.ipc.emit('player:track-update', fixture.mainEvent, { title: 'Controlled track', artist: 'Placeholder' })
  const lyrics = [{ time: 0, text: 'A controlled lyric' }, { time: 10000, text: 'Another line' }]
  fixture.ipc.emit('player:lyric-update', fixture.mainEvent, lyrics)
  fixture.ipc.emit('player:time-update', fixture.mainEvent, 12345)
  const win = fixture.createDesktopLyricWindow()
  assert.doesNotThrow(() => win.emit('ready-to-show'))
  assert.equal(win.messages.find(([channel]) => channel === 'desktop-lyric:lyric-update')[1], lyrics)
  assert.equal(win.messages.find(([channel]) => channel === 'desktop-lyric:time-update')[1], 12345)
  fixture.ready()
  fixture.subscribeToSettingsUpdates()
  fixture.update({ desktopLyrics: { fontSize: 'large', theme: 'gradient', locked: false } })
  const display = win.messages.filter(([channel]) => channel === 'desktop-lyric:settings-update').at(-1)[1]
  assert.deepEqual(JSON.parse(JSON.stringify(display)), { fontSize: 'large', theme: 'gradient', locked: false, showTranslation: true })
  await fixture.handlers.get('desktop-lyric:size-changed')({ sender: {} }, 'small')
  await fixture.invoke('desktop-lyric:size-changed', win, 'huge')
  await fixture.invoke('desktop-lyric:theme-changed', win, { theme: 'minimal' })
  assert.equal(fixture.writes.length, 0)
  await fixture.invoke('desktop-lyric:size-changed', win, 'small')
  await fixture.invoke('desktop-lyric:theme-changed', win, 'minimal')
  assert.equal(fixture.writes.length, 2)
  assert.equal(fixture.writes[0].desktopLyrics.fontSize, 'small')
  assert.equal(fixture.writes[1].desktopLyrics.theme, 'minimal')
  fixture.ipc.emit('player:track-update', fixture.mainEvent, { title: 'A new track' })
  assert.equal(win.messages.filter(([channel]) => channel === 'desktop-lyric:lyric-update').at(-1)[1].length, 0)
})

test('translation preferences immediately update an already mounted lyric view', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../src/components/player/LyricView.js'), 'utf8')
    .replace(/^import\b[\s\S]*?from\s+['"][^'"]+['"]\s*;?\s*$/gm, '')
    .replace('export default', 'module.exports =')
  const sandbox = { module: { exports: {} }, ContextMenu: {}, ArtistLinks: {}, ArtworkCover: {} }
  vm.runInNewContext(source, sandbox)
  let measured = 0
  const lyric = { showTranslation: true, styleCache: new Map([['line', 'cached']]), handleLongLyric() { measured++ } }
  const watch = sandbox.module.exports.watch['settingsStore.settings.playback.showTranslation']
  watch.call(lyric, false)
  assert.equal(lyric.showTranslation, false)
  assert.equal(lyric.styleCache.size, 0)
  assert.equal(measured, 1)
  watch.call(lyric, true)
  assert.equal(lyric.showTranslation, true)
})

test('imported geometry replaces pending movement and applies while open or closed', async () => {
  const fixture = desktopFixture()
  fixture.ready()
  fixture.subscribeToSettingsUpdates()
  const win = fixture.open()
  win.setBounds({ x: 50, y: 50, width: 500, height: 220 })
  const oldWrite = fixture.flushDesktopLyricBounds()
  const imported = { x: 120, y: 160, width: 700, height: 240 }
  fixture.update({ desktopLyrics: { bounds: imported }, software: { updates: {} } })
  await oldWrite
  assert.deepEqual(win.getBounds(), imported)
  assert.equal(fixture.writes.some(patch => patch.desktopLyrics.bounds.x === 50), false)
  await fixture.flushDesktopLyricBounds()
  fixture.closeDesktopLyricWindow()
  await fixture.flushDesktopLyricBounds()
  const closedImport = { x: 220, y: 200, width: 600, height: 200 }
  fixture.update({ desktopLyrics: { bounds: closedImport }, software: { updates: {} } })
  assert.deepEqual(fixture.open().getBounds(), closedImport)
  fixture.closeDesktopLyricWindow()
  await fixture.flushDesktopLyricBounds()
})

test('failed geometry persistence stays retryable and tray unlock failure is visible outside the locked window', async () => {
  const fixture = desktopFixture()
  fixture.ready()
  fixture.subscribeToSettingsUpdates()
  const win = fixture.open()
  win.setBounds({ x: 30, y: 40, width: 600, height: 200 })
  fixture.failWrite(true)
  assert.equal(await fixture.flushDesktopLyricBounds(), false)
  assert.ok(win.messages.some(([channel]) => channel === 'desktop-lyric:error'))
  await fixture.runDesktopTrayAction(() => fixture.saveDesktopPreference({ desktopLyrics: { locked: false } }), '解锁失败')
  assert.equal(fixture.dialogs.length, 1)
  assert.equal(fixture.dialogs[0].type, 'error')
  assert.equal(win.ignoresMouse, true)
  fixture.failWrite(false)
  assert.equal(await fixture.flushDesktopLyricBounds(), true)
  assert.equal(fixture.writes.at(-1).desktopLyrics.bounds.x, 30)
  fixture.closeDesktopLyricWindow()
  await fixture.flushDesktopLyricBounds()
})

test('a position write already awaiting the settings queue cannot persist over a later import with the window closed', async () => {
  const fixture = desktopFixture()
  fixture.ready()
  fixture.subscribeToSettingsUpdates()
  const win = fixture.open()
  win.setBounds({ x: 50, y: 50, width: 500, height: 220 })
  const release = fixture.holdNextWrite()
  const saving = fixture.flushDesktopLyricBounds()
  await Promise.resolve()
  fixture.closeDesktopLyricWindow()
  const imported = { x: 220, y: 200, width: 600, height: 200 }
  fixture.update({ desktopLyrics: { bounds: imported }, software: { updates: {} } })
  release()
  await saving
  await fixture.flushDesktopLyricBounds()
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.writes.at(-1).desktopLyrics.bounds)), imported)
  assert.deepEqual(fixture.open().getBounds(), imported)
  fixture.closeDesktopLyricWindow()
  await fixture.flushDesktopLyricBounds()
})

test('same-title tracks use identity and reject stale lyric/time reports; stopping clears reopened snapshots', () => {
  const fixture = desktopFixture()
  const win = fixture.open()
  const publish = (id) => fixture.ipc.emit('player:track-update', fixture.mainEvent, { trackId: id, title: 'Same', artist: 'Artist' })
  publish('first')
  fixture.ipc.emit('player:lyric-update', fixture.mainEvent, [{ time: 0, text: 'first lyric' }], 'first')
  fixture.ipc.emit('player:time-update', fixture.mainEvent, 12500, { trackId: 'first', duration: 30000 })
  publish('second')
  fixture.ipc.emit('player:lyric-update', fixture.mainEvent, [{ time: 0, text: 'stale lyric' }], 'first')
  fixture.ipc.emit('player:time-update', fixture.mainEvent, 15000, { trackId: 'first' })
  assert.equal(win.messages.filter(([channel]) => channel === 'desktop-lyric:lyric-update').at(-1)[1].length, 0)
  assert.equal(win.messages.filter(([channel]) => channel === 'desktop-lyric:time-update').at(-1)[1], 0)
  fixture.ipc.emit('player:lyric-update', fixture.mainEvent, [{ time: 0, text: 'second lyric' }], 'second')
  fixture.ipc.emit('player:track-update', fixture.mainEvent, { trackId: 'second', title: 'Corrected title' })
  assert.equal(win.messages.filter(([channel]) => channel === 'desktop-lyric:lyric-update').at(-1)[1][0].text, 'second lyric')
  fixture.ipc.emit('player:track-update', fixture.mainEvent, null)
  fixture.closeDesktopLyricWindow()
  const reopened = fixture.open()
  assert.equal(reopened.messages.find(([channel]) => channel === 'desktop-lyric:song-update')[1], null)
  assert.equal(reopened.messages.find(([channel]) => channel === 'desktop-lyric:lyric-update')[1].length, 0)
  assert.equal(reopened.messages.find(([channel]) => channel === 'desktop-lyric:time-update')[1], 0)
  assert.equal(reopened.messages.find(([channel]) => channel === 'desktop-lyric:playback-update')[1].playing, false)
})

test('close during loading and old close callbacks cannot revive or detach a new desktop window', async () => {
  const fixture = desktopFixture()
  fixture.delayClose(true)
  const firstOpening = fixture.invoke('desktop-lyric:toggle')
  const first = fixture.latest()
  assert.equal(await fixture.invoke('desktop-lyric:toggle'), false)
  const secondOpening = fixture.invoke('desktop-lyric:toggle')
  const second = fixture.latest()
  assert.notEqual(first, second)
  first.emit('ready-to-show')
  first.destroy()
  second.emit('ready-to-show')
  assert.equal(await firstOpening, false)
  assert.equal(await secondOpening, true)
  assert.equal(first.shows, 0)
  assert.ok(second.shows > 0)
  assert.equal(fixture.createDesktopLyricWindow(), second)
  fixture.quit()
  assert.equal(await fixture.invoke('desktop-lyric:show'), false)
  assert.equal(fixture.createDesktopLyricWindow(), null)
})

test('failed HTML load reports failure and a subsequent opening creates a recoverable window', async () => {
  const fixture = desktopFixture()
  fixture.failLoad(true)
  assert.equal(await fixture.invoke('desktop-lyric:show'), false)
  assert.equal(fixture.latest().destroyed, true)
  fixture.failLoad(false)
  const retry = fixture.invoke('desktop-lyric:show')
  const win = fixture.latest()
  win.emit('ready-to-show')
  assert.equal(await retry, true)
  win.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
  assert.equal(win.destroyed, true)
  assert.notEqual(fixture.createDesktopLyricWindow(), win)
})

test('native locking and controls accept only the desktop top frame and only committed preferences', async () => {
  const fixture = desktopFixture()
  fixture.ready()
  fixture.subscribeToSettingsUpdates()
  const win = fixture.open()
  assert.equal(win.ignoresMouse, true)
  assert.equal(win.movable, false)
  assert.equal(win.focusable, false)
  const initial = win.getBounds()
  assert.equal((await fixture.invoke('desktop-lyric:resize-by', win, { width: 40, height: 20 })).success, false)
  assert.deepEqual(win.getBounds(), initial)
  const childEvent = { sender: win.webContents, senderFrame: {} }
  assert.equal((await fixture.handlers.get('desktop-lyric:set-locked')(childEvent, false)).success, false)
  fixture.failWrite(true)
  assert.equal((await fixture.invoke('desktop-lyric:set-locked', win, false)).success, false)
  assert.equal(win.ignoresMouse, true)
  fixture.failWrite(false)
  assert.equal((await fixture.invoke('desktop-lyric:set-locked', win, false)).success, true)
  assert.equal(win.ignoresMouse, false)
  assert.equal(win.movable, true)
  assert.equal(win.focusable, true)
  assert.equal((await fixture.invoke('desktop-lyric:set-translation', win, false)).success, true)
  assert.equal(win.messages.filter(([channel]) => channel === 'desktop-lyric:settings-update').at(-1)[1].showTranslation, false)
  assert.equal((await fixture.invoke('desktop-lyric:control', win, 'toggle')).success, false)
  fixture.ipc.emit('player:track-update', fixture.mainEvent, { trackId: 'song', title: 'Song' })
  fixture.ipc.emit('player:playback-state', fixture.mainEvent, 'playing')
  assert.equal((await fixture.invoke('desktop-lyric:control', win, 'toggle')).success, true)
  assert.equal(fixture.main.messages.filter(([channel]) => channel === 'player:control').at(-1)[1], 'pause')
  assert.equal((await fixture.invoke('desktop-lyric:control', win, 'arbitrary')).success, false)
  fixture.ipc.emit('player:track-update', fixture.event(win), null)
  assert.equal(win.messages.filter(([channel]) => channel === 'desktop-lyric:song-update').at(-1)[1].trackId, 'song')
})

test('custom resizing uses screen coordinates, stores geometry, and recovers disconnected displays', async () => {
  const fixture = desktopFixture()
  fixture.ready()
  fixture.subscribeToSettingsUpdates()
  fixture.update({ desktopLyrics: { locked: false }, software: { updates: {} } })
  const win = fixture.open()
  assert.equal(win.options.resizable, false)
  const original = win.getBounds()
  await fixture.invoke('desktop-lyric:resize-by', win, { width: -40, height: 20 })
  assert.equal(win.bounds.width, original.width - 40)
  fixture.screen.point = { x: 500, y: 500 }
  await fixture.invoke('desktop-lyric:begin-resize', win)
  fixture.screen.point = { x: 540, y: 480 }
  fixture.ipc.emit('desktop-lyric:resize', fixture.event(win))
  fixture.ipc.emit('desktop-lyric:end-resize', fixture.event(win))
  assert.equal(win.bounds.width, original.width)
  await fixture.flushDesktopLyricBounds()
  const saved = fixture.writes.at(-1).desktopLyrics.bounds
  assert.deepEqual(JSON.parse(JSON.stringify(saved)), win.getBounds())
  fixture.closeDesktopLyricWindow()
  const reopened = fixture.open()
  assert.deepEqual(reopened.getBounds(), win.getBounds())
  fixture.screen.area = { x: -1024, y: 0, width: 1024, height: 768 }
  fixture.screen.emit('display-removed')
  assert.ok(reopened.bounds.x >= -1024)
  assert.ok(reopened.bounds.x + reopened.bounds.width <= 0)
  assert.ok(reopened.bounds.y + reopened.bounds.height <= 768)
  fixture.closeDesktopLyricWindow()
  assert.equal(fixture.screen.listenerCount('display-removed'), 0)
  await fixture.flushDesktopLyricBounds()
})
