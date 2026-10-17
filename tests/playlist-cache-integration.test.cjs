const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')

/** Run the production main-process boundaries without OS windows, accounts or downloads. */
function fixture(packaged = false) {
  const handlers = new Map(), calls = [], registrations = [], windows = []
  let options, savedListener, protocolHandler
  const settings = { software: { updates: {} }, download: { offlinePlaylistCacheEnabled: true }, playback: { quality: '128' } }
  const state = { revision: 1, generation: 1, userId: 'placeholder-account', playlists: [] }
  const methods = ['setSession', 'getState', 'readPlaylist', 'putPlaylist', 'cacheSong', 'getSource', 'releaseSource', 'readLyrics', 'putLyrics', 'getArtwork', 'cacheArtwork', 'pause', 'resume', 'retry', 'retryNetwork', 'clear']
  const service = {
    ...Object.fromEntries(methods.map(method => [method, arg => { calls.push([method, arg]); return state }])),
    configure(value) { calls.push(['configure', value]) },
    handleRequest(request) { return { request } },
    async stop() { calls.push(['stop']) }
  }
  const app = Object.assign(new EventEmitter(), {
    isPackaged: packaged, commandLine: { appendSwitch() {} }, whenReady: () => new Promise(() => {}),
    getPath: () => '/user-data', getAppPath: () => '/app', getVersion: () => '1.0.0'
  })
  class Window extends EventEmitter {
    constructor() {
      super()
      this.sent = []
      this.webContents = Object.assign(new EventEmitter(), { mainFrame: {}, openDevTools() {}, send: (...args) => this.sent.push(args) })
      windows.push(this)
    }
    loadURL() { return Promise.resolve() }
    isDestroyed() { return false }
    close() { this.emit('closed') }
  }
  Window.getAllWindows = () => windows
  const quiet = Object.fromEntries(['trace', 'info', 'warn', 'error'].map(method => [method, () => {}]))
  const context = vm.createContext({
    require(name) {
      if (name === 'electron') return {
        app, BrowserWindow: Window, ipcMain: Object.assign(new EventEmitter(), { handle: (channel, handler) => handlers.set(channel, handler) }),
        protocol: { registerSchemesAsPrivileged: value => registrations.push(value), handle: (scheme, handler) => { protocolHandler = handler; registrations.push(scheme) } },
        globalShortcut: { unregisterAll() {} }
      }
      if (name === './logger') return quiet
      if (name === './services/playlistCacheService') return { createPlaylistCacheService(value) { options = value; return service } }
      if (name === './services/backendService') return { createBackendService: () => ({ stop: async () => {} }) }
      if (name === './services/updateService') return { createUpdateService: () => ({}) }
      if (name === './settingsStore') return { getSettings: () => settings, onSettingsChange: listener => { savedListener = listener; return () => {} } }
      return require(name)
    },
    __dirname: path.join(__dirname, '../electron'), process: { platform: 'linux', resourcesPath: '/resources', env: {} },
    setTimeout, clearTimeout, setInterval, clearInterval, global: {}
  })
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../electron/main.js'), 'utf8'), context)
  const api = vm.runInContext('({ createWindow, initializePlaylistCacheService, subscribeToSettingsUpdates, performApplicationCleanup })', context)
  api.createWindow()
  api.initializePlaylistCacheService()
  api.subscribeToSettingsUpdates()
  const event = { sender: windows[0].webContents, senderFrame: windows[0].webContents.mainFrame }
  return { api, registrations, service, calls, windows, event, settings, state,
    options: () => options, publishSettings: value => savedListener(value), protocolHandler: () => protocolHandler,
    invoke: (name, arg, source = event) => handlers.get(`playlist-cache:${name}`)(source, arg) }
}

test('offline worker paths and media registration cover development and packaged applications', async () => {
  for (const packaged of [false, true]) {
    const f = fixture(packaged)
    assert.equal(f.options().workerPath, path.join(packaged ? '/resources/playlist-cache' : '/app/electron/services', 'playlistCacheWorker.cjs'))
    assert.equal(f.options().cacheRoot, path.join('/user-data', 'offline-playlists'))
    assert.equal(f.registrations[0][0].scheme, 'bk-cache')
    assert.equal(f.registrations[0][0].privileges.stream, true)
    assert.equal(f.registrations[0][0].privileges.bypassCSP, undefined)
    assert.equal(f.registrations[1], 'bk-cache')
    const request = { url: 'bk-cache://media/opaque' }
    assert.equal(f.protocolHandler()(request).request, request)
    await Promise.all([f.api.performApplicationCleanup(), f.api.performApplicationCleanup()])
    assert.equal(f.calls.filter(([name]) => name === 'stop').length, 1)
  }
})

test('every offline operation rejects auxiliary windows, frames and calls during shutdown', async () => {
  const f = fixture()
  const names = ['set-session', 'get-state', 'read-playlist', 'put-playlist', 'cache-song', 'get-source', 'release-source', 'read-lyrics', 'put-lyrics', 'get-artwork', 'cache-artwork', 'pause', 'resume', 'retry', 'retry-network', 'clear']
  for (const name of names) {
    for (const source of [{ sender: {} }, { sender: f.event.sender, senderFrame: {} }]) {
      assert.throws(() => f.invoke(name, null, source), /主窗口/)
    }
  }
  assert.equal(f.calls.length, 1, 'only initial committed settings configure the service')
  f.invoke('cache-song', { song: { hash: 'placeholder' }, quality: '320' })
  assert.equal(f.calls.at(-1)[0], 'cacheSong')
  await f.api.performApplicationCleanup()
  assert.throws(() => f.invoke('get-state'), /主窗口/)
})

test('only committed preferences configure caching and state/auth events reach the main window', () => {
  const f = fixture()
  const settings = { software: { updates: {} }, download: { offlinePlaylistCacheEnabled: false } }
  f.publishSettings(settings)
  assert.equal(f.calls.at(-1)[1], settings)
  f.options().onState(f.state)
  f.options().onAuthExpired({ generation: 1, userId: 'placeholder-account' })
  assert.equal(f.windows[0].sent.at(-2)[0], 'playlist-cache:state')
  assert.equal(f.windows[0].sent.at(-1)[0], 'playlist-cache:auth-expired')
})

test('preload provides fixed cache capabilities and detachable state/auth subscriptions', async () => {
  let exposed
  const ipc = Object.assign(new EventEmitter(), { invoke: async (...args) => args })
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../electron/preload.js'), 'utf8'), {
    require: () => ({ ipcRenderer: ipc, contextBridge: { exposeInMainWorld(name, value) { if (name === 'electronAPI') exposed = value } } }),
    window: {}, console
  })
  const cache = exposed.playlistCache
  const result = await cache.cacheSong({ song: { hash: 'placeholder' }, quality: '128' })
  assert.equal(result[0], 'playlist-cache:cache-song')
  assert.equal((await cache.getSource({ hash: 'placeholder' }))[0], 'playlist-cache:get-source')
  assert.equal((await cache.clear())[0], 'playlist-cache:clear')
  const received = []
  const disposeState = cache.onState(value => received.push(value))
  const disposeAuth = cache.onAuthExpired(value => received.push(value))
  ipc.emit('playlist-cache:state', { privateElectronEvent: true }, 'state')
  ipc.emit('playlist-cache:auth-expired', {}, 'auth')
  assert.deepEqual(received, ['state', 'auth'])
  disposeState(); disposeAuth()
  assert.equal(ipc.listenerCount('playlist-cache:state'), 0)
  assert.equal(cache.invoke, undefined)
  assert.equal(cache.download, undefined)
})

test('packaging includes the standalone offline worker', () => {
  const config = require('../package.json').build.extraResources
  assert.ok(config.some(item => item.from === 'electron/services/playlistCacheWorker.cjs' && item.to === 'playlist-cache/playlistCacheWorker.cjs'))
})
