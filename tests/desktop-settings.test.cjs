const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')

/** Load real IPC handlers with isolated windows and no OS registration or backend. */
function desktopFixture() {
  const ipc = new EventEmitter()
  ipc.handle = () => {}
  const app = new EventEmitter()
  Object.assign(app, { isPackaged: true, whenReady: () => new Promise(() => {}), commandLine: { appendSwitch() {} } })
  const windows = []
  class Window extends EventEmitter {
    constructor() { super(); this.messages = []; this.webContents = { send: (...args) => this.messages.push(args) }; windows.push(this) }
    loadFile() { return Promise.resolve() }
    isDestroyed() { return false }
    show() {}
    static getAllWindows() { return windows }
  }
  let initialized = false
  let snapshot = { desktopLyrics: { fontSize: 'large', theme: 'minimal', locked: true } }
  let listener
  const writes = []
  const silent = Object.fromEntries(['trace', 'warn', 'error', 'info', 'debug'].map(name => [name, () => {}]))
  const sandbox = vm.createContext({
    require(name) {
      if (name === 'electron') return { app, BrowserWindow: Window, ipcMain: ipc }
      if (name === './logger') return silent
      if (name === './services/backendService') return { createBackendService: () => ({}) }
      if (name === './settingsStore') return {
        getSettings() { if (!initialized) throw new Error('Settings store not initialized'); return snapshot },
        onSettingsChange(callback) { listener = callback; return () => {} },
        async setSettings(patch) { writes.push(patch); snapshot = { desktopLyrics: { ...snapshot.desktopLyrics, ...patch.desktopLyrics } }; listener?.(snapshot); return snapshot }
      }
      if (name === './services/updateService') return { createUpdateService: () => ({ configure() {}, stop: async () => {} }) }
      return require(name)
    },
    __dirname: path.resolve(__dirname, '../electron'), process: { platform: 'linux', env: {} }, setTimeout, clearTimeout, setInterval, clearInterval
  })
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../electron/main.js'), 'utf8'), sandbox)
  const api = vm.runInContext('({createDesktopLyricWindow, subscribeToSettingsUpdates})', sandbox)
  return { ...api, ipc, writes, ready() { initialized = true }, update(settings) { snapshot = settings; listener?.(snapshot) } }
}

test('desktop lyrics tolerate early opening and replay the current lyrics, position and committed preferences', async () => {
  const fixture = desktopFixture()
  fixture.ipc.emit('player:track-update', {}, { title: 'Controlled track', artist: 'Placeholder' })
  const lyrics = [{ time: 0, text: 'A controlled lyric' }, { time: 10000, text: 'Another line' }]
  fixture.ipc.emit('player:lyric-update', {}, lyrics)
  fixture.ipc.emit('player:time-update', {}, 12345)
  const win = fixture.createDesktopLyricWindow()
  assert.doesNotThrow(() => win.emit('ready-to-show'))
  assert.equal(win.messages.find(([channel]) => channel === 'desktop-lyric:lyric-update')[1], lyrics)
  assert.equal(win.messages.find(([channel]) => channel === 'desktop-lyric:time-update')[1], 12345)
  fixture.ready()
  fixture.subscribeToSettingsUpdates()
  fixture.update({ desktopLyrics: { fontSize: 'large', theme: 'gradient', locked: false } })
  const display = win.messages.filter(([channel]) => channel === 'desktop-lyric:settings-update').at(-1)[1]
  assert.deepEqual(JSON.parse(JSON.stringify(display)), { fontSize: 'large', theme: 'gradient', locked: false })
  fixture.ipc.emit('desktop-lyric:size-changed', { sender: {} }, 'small')
  fixture.ipc.emit('desktop-lyric:size-changed', { sender: win.webContents }, 'huge')
  fixture.ipc.emit('desktop-lyric:theme-changed', { sender: win.webContents }, { theme: 'minimal' })
  assert.equal(fixture.writes.length, 0)
  fixture.ipc.emit('desktop-lyric:size-changed', { sender: win.webContents }, 'small')
  fixture.ipc.emit('desktop-lyric:theme-changed', { sender: win.webContents }, 'minimal')
  await Promise.resolve()
  assert.equal(fixture.writes.length, 2)
  assert.equal(fixture.writes[0].desktopLyrics.fontSize, 'small')
  assert.equal(fixture.writes[1].desktopLyrics.theme, 'minimal')
  fixture.ipc.emit('player:track-update', {}, { title: 'A new track' })
  assert.equal(win.messages.filter(([channel]) => channel === 'desktop-lyric:lyric-update').at(-1)[1].length, 0)
})

test('translation preferences immediately update an already mounted lyric view', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../src/components/player/LyricView.js'), 'utf8')
    .replace(/^import\b[\s\S]*?from\s+['"][^'"]+['"]\s*;?\s*$/gm, '')
    .replace('export default', 'module.exports =')
  const sandbox = { module: { exports: {} } }
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
