const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')

/** Run the production main-process boundaries without OS windows, accounts or downloads. */
function fixture(packaged = false, controls = {}) {
  const handlers = new Map(), calls = [], registrations = [], windows = [], dialogs = []
  let options, savedListener, protocolHandler
  const settings = { software: { updates: {} }, download: { offlinePlaylistCacheEnabled: true, offlineCachePath: controls.offlineCachePath || '' }, playback: { quality: '128' } }
  const state = { revision: 1, generation: 1, userId: 'placeholder-account', playlists: [], cacheDirectory: controls.offlineCachePath || path.join('/user-data', 'offline-playlists') }
  const methods = ['setSession', 'getState', 'readPlaylist', 'putPlaylist', 'cacheSong', 'getSource', 'releaseSource', 'readLyrics', 'putLyrics', 'getArtwork', 'cacheArtwork', 'pause', 'resume', 'retry', 'retryNetwork', 'clear']
  const service = {
    ...Object.fromEntries(methods.map(method => [method, arg => { calls.push([method, arg]); return state }])),
    configure(value) { calls.push(['configure', value]) },
    async changeDirectory(directory, persist) {
      calls.push(['changeDirectory', directory])
      if (controls.migrate) await controls.migrate(directory)
      await persist(directory)
      state.cacheDirectory = directory
      return state
    },
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
      if (name === './services/desktopLyricPolicy') return require('../electron/services/desktopLyricPolicy')
      if (name === './services/windowsForeground') return require('../electron/services/windowsForeground')
      if (name === 'electron') return {
        app, BrowserWindow: Window, ipcMain: Object.assign(new EventEmitter(), { handle: (channel, handler) => handlers.set(channel, handler) }),
        protocol: { registerSchemesAsPrivileged: value => registrations.push(value), handle: (scheme, handler) => { protocolHandler = handler; registrations.push(scheme) } },
        dialog: { async showOpenDialog(window, options) {
          dialogs.push({ window, options })
          return controls.selectDirectory ? controls.selectDirectory() : { canceled: true, filePaths: [] }
        } },
        globalShortcut: { unregisterAll() {} }
      }
      if (name === './logger') return quiet
      if (name === './services/lyricLibraryService') return { createLyricLibraryService: () => ({ configure() {}, stop: async () => {} }) }
      if (name === './services/playlistCacheService') return { createPlaylistCacheService(value) { options = value; return service } }
      if (name === './services/backendService') return { createBackendService: () => ({ stop: async () => {} }) }
      if (name === './services/updateService') return { createUpdateService: () => ({}) }
      if (name === './settingsStore') return {
        normalizeDesktopLyrics: require('../electron/settingsStore').normalizeDesktopLyrics,
        getSettings: () => settings,
        async setOfflineCacheDirectory(directory) { calls.push(['persistDirectory', directory]); settings.download.offlineCachePath = directory; savedListener?.(settings) },
        onSettingsChange: listener => { savedListener = listener; return () => {} }
      }
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
  return { api, registrations, service, calls, windows, event, settings, state, dialogs,
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
  assert.deepEqual(await cache.chooseDirectory('/caller-controlled-path'), ['playlist-cache:choose-directory'])
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

test('saved offline cache locations are used when initializing the service', () => {
  const savedPath = path.resolve('/selected-cache', 'offline-playlists')
  const f = fixture(false, { offlineCachePath: savedPath })
  assert.equal(f.options().cacheRoot, savedPath)
})

test('native directory choice migrates only the selected dedicated child then persists it', async () => {
  const selected = path.resolve('/selected-cache')
  const f = fixture(false, { selectDirectory: async () => ({ canceled: false, filePaths: [selected] }) })
  const result = await f.invoke('choose-directory', '/caller-controlled-path')
  const destination = path.join(selected, 'offline-playlists')
  assert.equal(f.dialogs.length, 1)
  assert.equal(f.dialogs[0].window, f.windows[0])
  assert.equal(f.dialogs[0].options.defaultPath, path.dirname(path.join('/user-data', 'offline-playlists')))
  assert.deepEqual([...f.dialogs[0].options.properties], ['openDirectory', 'createDirectory', 'promptToCreate'])
  assert.equal(result.state.cacheDirectory, destination)
  assert.equal(f.settings.download.offlineCachePath, destination)
  assert.deepEqual(f.calls.filter(([name]) => ['changeDirectory', 'persistDirectory'].includes(name)), [
    ['changeDirectory', destination], ['persistDirectory', destination]
  ])
})

test('canceling the native picker does not migrate or save and permits choosing again', async () => {
  const f = fixture()
  assert.equal((await f.invoke('choose-directory')).canceled, true)
  assert.equal((await f.invoke('choose-directory')).canceled, true)
  assert.equal(f.dialogs.length, 2)
  assert.equal(f.calls.some(([name]) => name === 'changeDirectory' || name === 'persistDirectory'), false)
})

test('cache directory choice rejects foreign frames and becomes invalid after the main window changes', async () => {
  let select
  const f = fixture(false, { selectDirectory: () => new Promise(resolve => { select = resolve }) })
  for (const source of [{ sender: {} }, { sender: f.event.sender, senderFrame: {} }]) {
    await assert.rejects(f.invoke('choose-directory', undefined, source), /主窗口/)
  }
  assert.equal(f.dialogs.length, 0)
  const pending = f.invoke('choose-directory')
  f.windows[0].webContents.mainFrame = {}
  select({ canceled: false, filePaths: [path.resolve('/selected-cache')] })
  assert.ok((await pending).error)
  assert.equal(f.calls.some(([name]) => name === 'changeDirectory'), false)
})

test('shutdown during directory choice prevents starting a migration', async () => {
  let select
  const f = fixture(false, { selectDirectory: () => new Promise(resolve => { select = resolve }) })
  const pending = f.invoke('choose-directory')
  await f.api.performApplicationCleanup()
  select({ canceled: false, filePaths: [path.resolve('/selected-cache')] })
  assert.ok((await pending).error)
  assert.equal(f.calls.some(([name]) => name === 'changeDirectory'), false)
})

test('repeated choices stay busy during native selection and copying and failures can be retried', async () => {
  let select, finish, started
  const copying = new Promise(resolve => { started = resolve })
  const f = fixture(false, {
    selectDirectory: () => new Promise(resolve => { select = resolve }),
    migrate: () => { started(); return new Promise((_resolve, reject) => { finish = reject }) }
  })
  const first = f.invoke('choose-directory')
  assert.equal((await f.invoke('choose-directory')).error.code, 'CACHE_MIGRATION_BUSY')
  assert.equal(f.dialogs.length, 1)
  select({ canceled: false, filePaths: [path.resolve('/selected-cache')] })
  await copying
  assert.equal((await f.invoke('choose-directory')).error.code, 'CACHE_MIGRATION_BUSY')
  finish(Object.assign(new Error('目标目录非空'), { code: 'CACHE_MIGRATION_NOT_EMPTY' }))
  assert.equal((await first).error.message, '目标目录非空')
  assert.equal(f.calls.some(([name]) => name === 'persistDirectory'), false)
  const retry = f.invoke('choose-directory')
  select({ canceled: true, filePaths: [] })
  assert.equal((await retry).canceled, true)
  assert.equal(f.dialogs.length, 2)
})
