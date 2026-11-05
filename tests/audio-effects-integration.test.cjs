const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
const { Readable } = require('node:stream')
const { createAudioEffectsMedia } = require('../electron/services/audioEffectsMedia')

const root = path.join(__dirname, '..')
const operations = ['getStatus', 'listPlugins', 'scan', 'cancelScan', 'addPlugin', 'removePlugin', 'movePlugin',
  'setBypass', 'setEnabled', 'setBufferMs', 'openEditor', 'closeEditor', 'setTempoOverride', 'retry', 'retrySave']
const capabilities = [...operations, 'chooseDirectory', 'acquireMedia', 'releaseMedia', 'connectAudio']
const quiet = Object.fromEntries(['trace', 'debug', 'info', 'warn', 'error'].map(name => [name, () => {}]))
const flush = () => new Promise(resolve => setImmediate(resolve))
function deferred() {
  let resolve, reject
  const promise = new Promise((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

/** Load the actual main, integration and media modules; inject only OS/process/network/storage boundaries. */
function fixture({ platform = 'linux', packaged = false, controls = {} } = {}) {
  const calls = [], windows = [], ports = [], handlers = new Map(), protocols = new Map(), dialogs = []
  const settings = { audioEffects: { enabled: false, searchPaths: [], chain: [] }, software: { updates: {}, minimizeToTray: true } }
  const state = { revision: 1, supported: true, enabled: false, chain: [], running: false }
  let serviceOptions, settingsListener, privileged
  const service = {
    ...Object.fromEntries(operations.map(name => [name, async value => { calls.push([name, value]); return state }])),
    async initialize(value) { calls.push(['initialize', value]); return state },
    async configure(value) { calls.push(['configure', value]); return state },
    async addDirectory(value) { calls.push(['addDirectory', value]); return state },
    async connectAudio(port) { calls.push(['connectAudio', port]); return controls.connectAudio?.(port) },
    async releaseAudio() { calls.push(['releaseAudio']); return controls.releaseAudio?.() },
    async stop() { calls.push(['stop']); return controls.stop?.() }
  }
  class Port { constructor() { this.closed = 0 } close() { this.closed++ } }
  class Channel { constructor() { this.port1 = new Port(); this.port2 = new Port(); ports.push(this) } }
  class Window extends EventEmitter {
    constructor() {
      super(); this.destroyed = false; this.sent = []; this.transfers = []
      this.webContents = Object.assign(new EventEmitter(), { mainFrame: {}, openDevTools() {},
        send: (...args) => this.sent.push(args), postMessage: (...args) => this.transfers.push(args),
        setBackgroundThrottling() {}, session: { clearCache: async () => {} } })
      windows.push(this)
    }
    isDestroyed() { return this.destroyed }
    loadURL() { return Promise.resolve() }
    close() { this.destroyed = true; this.emit('closed') }
  }
  Window.getAllWindows = () => windows.filter(window => !window.destroyed)
  const app = Object.assign(new EventEmitter(), { isPackaged: packaged, commandLine: { appendSwitch() {} },
    whenReady: () => new Promise(() => {}), getPath: () => '/test-private', getAppPath: () => '/test-app',
    getVersion: () => '1.0.0', quit() {} })
  const protocol = { registerSchemesAsPrivileged(value) { privileged = value },
    handle: (scheme, callback) => protocols.set(scheme, callback), unhandle: scheme => protocols.delete(scheme) }
  const electron = { app, BrowserWindow: Window, MessageChannelMain: Channel, utilityProcess: {}, protocol,
    ipcMain: Object.assign(new EventEmitter(), { handle: (name, callback) => handlers.set(name, callback), removeHandler: name => handlers.delete(name) }),
    globalShortcut: { unregisterAll() {} }, shell: {},
    dialog: { async showOpenDialog(window, options) { dialogs.push({ window, options }); return controls.chooseDirectory?.() ?? { canceled: true, filePaths: [] } } } }
  const processInfo = { platform, arch: 'x64', resourcesPath: '/test-resources', env: { BK_SKIP_CHCP: '1' } }
  const exports = { exports: {} }
  vm.runInNewContext(fs.readFileSync(path.join(root, 'electron/services/audioEffectsIntegration.js'), 'utf8'), {
    module: exports, process: processInfo,
    require(name) {
      if (name === './audioEffectsService') return { createAudioEffectsService(options) { serviceOptions = options; return service } }
      if (name === './audioEffectsMedia') return { createAudioEffectsMedia: () => createAudioEffectsMedia({ request: async (url, options) => {
        calls.push(['request', url, options])
        const stream = Readable.from([Buffer.from('test audio')])
        stream.statusCode = 200; stream.headers = { 'content-type': 'audio/mpeg', 'content-length': '10' }
        return stream
      } }) }
      return require(name)
    }
  })
  const context = vm.createContext({ process: processInfo, __dirname: path.join(root, 'electron'), global: {}, console: quiet,
    setTimeout, clearTimeout, setInterval, clearInterval,
    require(name) {
      if (name === 'electron') return electron
      if (name === './logger') return quiet
      if (name === './services/audioEffectsIntegration') return exports.exports
      if (name === './services/backendService') return { createBackendService: () => ({ stop: async () => {} }) }
      if (name === './services/updateService') return { createUpdateService: () => ({}) }
      if (name === './services/playlistCacheService') return { createPlaylistCacheService: () => ({}) }
      if (name === './services/musicDownloadService') return { createMusicDownloadService: () => ({}) }
      if (name === './services/lyricLibraryService') return { createLyricLibraryService: () => ({}) }
      if (name === './services/desktopLyricPolicy') return require('../electron/services/desktopLyricPolicy')
      if (name === './services/windowsForeground') return require('../electron/services/windowsForeground')
      if (name === './settingsStore') return { getSettings: () => settings, normalizeDesktopLyrics: value => value || {},
        setSettings: async value => { calls.push(['persist', value]); Object.assign(settings, value); return settings },
        onSettingsChange(listener) { settingsListener = listener; return () => {} } }
      throw new Error(`Unexpected dependency: ${name}`)
    }
  })
  // Allow built-in path/URL and read-only icon lookup; no real service or settings store may run.
  const originalRequire = context.require
  context.require = name => ['path', 'url', 'fs'].includes(name) ? require(name) : originalRequire(name)
  vm.runInContext(fs.readFileSync(path.join(root, 'electron/main.js'), 'utf8'), context)
  const api = vm.runInContext('({createWindow,initializeAudioEffects,subscribeToSettingsUpdates,performApplicationCleanup})', context)
  api.createWindow(); api.initializeAudioEffects(); api.subscribeToSettingsUpdates()
  const event = () => { const window = windows.at(-1); return { sender: window.webContents, senderFrame: window.webContents.mainFrame } }
  return { api, calls, service, state, settings, windows, ports, handlers, protocols, dialogs, event,
    options: () => serviceOptions, privileged: () => privileged, publish: value => serviceOptions.onStatus(value),
    publishSettings: value => settingsListener(value),
    invoke: (name, value, sender = event()) => handlers.get(`audio-effects:${name}`)(sender, value),
    read: url => protocols.get('bk-audio')({ url, method: 'GET', headers: new Headers() }) }
}

test('main wires platform paths, persisted configuration and CORS protocol privileges without user data writes', async t => {
  for (const platform of ['win32', 'darwin', 'linux']) for (const packaged of [false, true]) {
    const f = fixture({ platform, packaged }); t.after(() => f.api.performApplicationCleanup())
    const directory = packaged ? path.join('/test-resources', 'audio-effects', `${platform}-x64`)
      : path.join('/test-app', 'native', 'audio-effects', 'bin', `${platform}-x64`)
    assert.equal(f.options().nativePath, path.join(directory, platform === 'win32' ? 'bk-audio-host.exe' : 'bk-audio-host'))
    assert.equal(f.options().workerPath, packaged ? path.join('/test-resources', 'audio-effects', 'audioEffectsWorker.cjs')
      : path.join('/test-app', 'electron', 'services', 'audioEffectsWorker.cjs'))
    assert.equal(f.options().root, path.join('/test-private', 'audio-effects'))
    assert.equal(f.calls[0][0], 'initialize'); assert.equal(f.calls[0][1], f.settings.audioEffects)
    const privileges = f.privileged().find(item => item.scheme === 'bk-audio').privileges
    for (const key of ['standard', 'secure', 'stream', 'corsEnabled', 'supportFetchAPI']) assert.equal(privileges[key], true)
    const config = { enabled: true, searchPaths: [], chain: [] }
    await f.options().persistConfig(config)
    assert.deepEqual(Object.keys(f.calls.at(-1)[1]), ['audioEffects'])
    f.publishSettings({ ...f.settings, audioEffects: config })
    assert.equal(f.calls.at(-1)[0], 'configure'); assert.equal(f.calls.at(-1)[1], config)
  }
})

test('only the current main top frame can invoke a fixed audio capability', async t => {
  const f = fixture(); t.after(() => f.api.performApplicationCleanup())
  assert.deepEqual([...f.handlers.keys()].filter(key => key.startsWith('audio-effects:')).sort(), capabilities.map(name => `audio-effects:${name}`).sort())
  const event = f.event()
  const invalid = [{ ...event, senderFrame: {} }, { ...event, sender: {} }, {}]
  for (const method of capabilities) for (const sender of invalid) await assert.rejects(f.invoke(method, {}, sender), /此窗口不能/)
  for (const method of operations) {
    const request = { operation: 'constructor', command: 'arbitrary executable', payload: 'opaque data' }
    assert.equal(await f.invoke(method, request), f.state)
    assert.deepEqual(f.calls.at(-1), [method, request], 'request content cannot select a service method')
  }
  assert.equal(f.handlers.has('audio-effects:constructor'), false)
  f.publish(f.state)
  assert.equal(f.windows[0].sent.at(-1)[0], 'audio-effects:status')
  f.windows[0].close(); f.api.createWindow()
  await assert.rejects(f.invoke('getStatus', undefined, event), /此窗口不能/)
  f.publish(f.state)
  assert.equal(f.windows[1].sent.at(-1)[0], 'audio-effects:status')
  const sent = f.windows[1].sent.length
  const cleanup = f.api.performApplicationCleanup()
  await assert.rejects(f.invoke('scan'), /此窗口不能/)
  f.publish(f.state)
  assert.equal(f.windows[1].sent.length, sent)
  await cleanup
})

test('audio connection transfers only the latest token and closes rejected, failed or stale port pairs', async t => {
  const requests = []
  const f = fixture({ controls: { connectAudio() { const gate = deferred(); requests.push(gate); return gate.promise } } })
  t.after(() => f.api.performApplicationCleanup())
  for (const id of ['', '../path', 'x'.repeat(101), null, {}, 'id\n']) await assert.rejects(f.invoke('connectAudio', id), /连接标识无效/)
  assert.equal(f.ports.length, 0)
  const first = assert.rejects(f.invoke('connectAudio', 'first'), /已过期/)
  const second = f.invoke('connectAudio', 'second')
  requests[1].resolve(); assert.equal((await second).connectionId, 'second')
  requests[0].resolve(); await first
  assert.equal(f.windows[0].transfers.length, 1)
  assert.equal(f.windows[0].transfers[0][1].connectionId, 'second')
  assert.equal(f.windows[0].transfers[0][2][0], f.ports[1].port2)
  assert.equal(f.ports[0].port1.closed, 1); assert.equal(f.ports[0].port2.closed, 1)
  const failed = assert.rejects(f.invoke('connectAudio', 'failure'), /host unavailable/)
  requests[2].reject(new Error('host unavailable')); await failed
  assert.equal(f.ports[2].port1.closed, 1); assert.equal(f.ports[2].port2.closed, 1)
  const reloaded = assert.rejects(f.invoke('connectAudio', 'reload'), /已过期/)
  f.windows[0].webContents.emit('did-start-navigation', {}, 'app://reload', false, true)
  requests[3].resolve(); await reloaded
  assert.equal(f.ports[3].port1.closed, 1); assert.equal(f.ports[3].port2.closed, 1)
})

test('native directory selection is single-flight, cancels without mutation and recovers after failure', async t => {
  let gate = deferred()
  const f = fixture({ controls: { chooseDirectory: () => gate.promise } }); t.after(() => f.api.performApplicationCleanup())
  const selecting = f.invoke('chooseDirectory')
  await assert.rejects(f.invoke('chooseDirectory'), /正在选择/)
  gate.resolve({ canceled: true, filePaths: ['/must-not-add'] })
  assert.equal(await selecting, null)
  assert.equal(f.calls.filter(call => call[0] === 'addDirectory').length, 0)
  gate = deferred(); const failure = assert.rejects(f.invoke('chooseDirectory'), /dialog unavailable/)
  gate.reject(new Error('dialog unavailable')); await failure
  gate = deferred(); const accepted = f.invoke('chooseDirectory')
  gate.resolve({ canceled: false, filePaths: ['/selected/plugins', '/ignored'] })
  assert.equal(await accepted, f.state)
  assert.deepEqual(f.calls.at(-1), ['addDirectory', '/selected/plugins'])
  assert.equal(f.dialogs[0].window, f.windows[0])
  assert.deepEqual(Array.from(f.dialogs[0].options.properties), ['openDirectory'])
})

test('a directory dialog cannot persist after the initiating window closes or the application quits', async t => {
  for (const reason of ['close', 'quit']) {
    const gate = deferred(); const f = fixture({ controls: { chooseDirectory: () => gate.promise } })
    t.after(() => f.api.performApplicationCleanup())
    const selection = assert.rejects(f.invoke('chooseDirectory'), /窗口已改变/)
    if (reason === 'close') { f.windows[0].close(); f.api.createWindow() }
    else void f.api.performApplicationCleanup()
    gate.resolve({ canceled: false, filePaths: ['/stale/plugins'] })
    await selection
    assert.equal(f.calls.filter(call => call[0] === 'addDirectory').length, 0)
  }
})

test('a directory dialog cannot persist after top-frame navigation invalidates its document', async t => {
  const gate = deferred(), f = fixture({ controls: { chooseDirectory: () => gate.promise } })
  t.after(() => f.api.performApplicationCleanup())
  const selection = assert.rejects(f.invoke('chooseDirectory'), /窗口已改变/)
  f.windows[0].webContents.emit('did-start-navigation', {}, 'app://new-document', false, true)
  gate.resolve({ canceled: false, filePaths: ['/stale/plugins'] })
  await selection
  assert.equal(f.calls.filter(call => call[0] === 'addDirectory').length, 0)
})

test('opaque media leases survive subframe navigation but expire on release, top-frame reload, crash and close', async t => {
  const f = fixture(); t.after(() => f.api.performApplicationCleanup())
  const acquire = () => f.invoke('acquireMedia', { url: 'https://cdn.example.test/song.mp3', identity: 'account:catalog:hash' })
  const lease = await acquire()
  assert.match(lease.url, /^bk-audio:\/\/media\/[a-z0-9-]+$/)
  const response = await f.read(lease.url)
  assert.equal(response.headers.get('access-control-allow-origin'), '*')
  assert.equal(await response.text(), 'test audio')
  f.windows[0].webContents.emit('did-start-navigation', {}, 'app://child', false, false)
  f.windows[0].webContents.emit('did-start-navigation', {}, 'app://same#hash', true, true)
  assert.equal(await (await f.read(lease.url)).text(), 'test audio')
  assert.equal(await f.invoke('releaseMedia', lease.leaseId), true)
  assert.equal(await f.invoke('releaseMedia', lease.leaseId), false)
  assert.equal((await f.read(lease.url)).status, 404)
  for (const reason of ['reload', 'crash', 'close']) {
    const active = await acquire()
    if (reason === 'reload') f.windows[0].webContents.emit('did-start-navigation', {}, 'app://new', false, true)
    if (reason === 'crash') f.windows[0].webContents.emit('render-process-gone')
    if (reason === 'close') f.windows[0].close()
    assert.equal((await f.read(active.url)).status, 404)
  }
  assert.equal(f.calls.filter(call => call[0] === 'releaseAudio').length, 3)
})

test('application cleanup invalidates pending connections and leases, waits for the host and unregisters capabilities', async () => {
  const connecting = deferred(), stopped = deferred()
  const f = fixture({ controls: { connectAudio: () => connecting.promise, stop: () => stopped.promise } })
  const lease = await f.invoke('acquireMedia', { url: 'https://cdn.example.test/song.mp3', identity: 'track' })
  const connection = assert.rejects(f.invoke('connectAudio', 'closing'), /已过期/)
  const cleanup = f.api.performApplicationCleanup()
  assert.equal(f.api.performApplicationCleanup(), cleanup)
  await flush()
  assert.equal((await f.read(lease.url)).status, 404)
  assert.equal(f.calls.filter(call => call[0] === 'stop').length, 1)
  connecting.resolve(); await connection
  assert.equal(f.ports[0].port1.closed, 1); assert.equal(f.ports[0].port2.closed, 1)
  stopped.resolve(); await cleanup
  assert.equal(f.protocols.has('bk-audio'), false)
  assert.equal([...f.handlers.keys()].some(key => key.startsWith('audio-effects:')), false)
})

test('host shutdown failure still removes every audio IPC handler and protocol', async () => {
  const f = fixture({ controls: { stop: async () => { throw new Error('host did not acknowledge shutdown') } } })
  await f.api.performApplicationCleanup()
  assert.equal(f.calls.filter(call => call[0] === 'stop').length, 1)
  assert.equal(f.protocols.has('bk-audio'), false)
  assert.equal([...f.handlers.keys()].some(key => key.startsWith('audio-effects:')), false)
})

test('preload exposes fixed commands, hides IPC events and forwards only the audio port capability', async () => {
  const exposed = {}, invoked = [], posted = []
  const ipc = Object.assign(new EventEmitter(), { invoke: async (...args) => { invoked.push(args); return 'reply' }, send() {} })
  const window = { postMessage: (...args) => posted.push(args) }
  vm.runInNewContext(fs.readFileSync(path.join(root, 'electron/preload.js'), 'utf8'), {
    require: name => { assert.equal(name, 'electron'); return { contextBridge: { exposeInMainWorld: (key, value) => { exposed[key] = value } }, ipcRenderer: ipc } },
    window, console: quiet
  })
  const api = exposed.electronAPI.audioEffects
  assert.deepEqual(Object.keys(api).sort(), [...capabilities, 'onStatus'].sort())
  for (const name of capabilities) {
    const value = { id: 'opaque', operation: 'constructor' }
    assert.equal(await api[name](value), 'reply')
    assert.equal(invoked.at(-1)[0], `audio-effects:${name}`)
  }
  const received = [], state = { revision: 4 }, event = { secret: 'must-not-cross' }
  const release = api.onStatus((...args) => received.push(args))
  ipc.emit('audio-effects:status', event, state)
  assert.deepEqual(received, [[state]])
  release(); ipc.emit('audio-effects:status', event, state)
  assert.equal(received.length, 1)
  assert.equal(ipc.listenerCount('audio-effects:status'), 0)
  api.onStatus(null)()
  const port = { closed: 0, close() { this.closed++ } }
  ipc.emit('audio-effects:port', { ports: [port] }, { connectionId: 'token-1' })
  assert.equal(posted[0][0].type, 'bk-audio-effects-port')
  assert.equal(posted[0][0].connectionId, 'token-1')
  assert.equal(posted[0][2][0], port)
  ipc.emit('audio-effects:port', { ports: [port] }, { connectionId: {} })
  assert.equal(port.closed, 1)
  assert.equal(posted.length, 1)
})

test('compiled settings and app templates bind the service-owned panel, save barrier and player shortcut', () => {
  const { parse, compileTemplate } = require('@vue/compiler-sfc')
  function template(relativePath) {
    const filename = path.join(root, relativePath)
    const { descriptor } = parse(fs.readFileSync(filename, 'utf8'), { filename })
    const compiled = compileTemplate({ source: descriptor.template.content, filename, id: 'audio-effects-integration' })
    assert.deepEqual(compiled.errors, [])
    const nodes = []
    const walk = node => { nodes.push(node); for (const child of node.children || []) walk(child) }
    walk(descriptor.template.ast)
    return nodes
  }
  const nodes = template('src/views/SettingsView.vue')
  const section = nodes.find(node => node.tag === 'section' && node.props?.some(prop => prop.name === 'id' && prop.value?.content === 'audioEffects-section'))
  assert.ok(section)
  const panel = section.children.find(node => node.tag === 'AudioEffectsSettings')
  assert.ok(panel)
  assert.ok(panel.props.some(prop => prop.name === 'bind' && prop.arg?.content === 'before-action' && prop.exp?.content === 'flushEditableSettings'))
  assert.equal(panel.props.some(prop => prop.name === 'model'), false, 'service state must not be overwritten by a settings draft')
  const player = template('src/App.vue').find(node => node.tag === 'MusicPlayer')
  assert.ok(player.props.some(prop => prop.name === 'on' && prop.arg?.content === 'open-audio-effects' && prop.exp?.content === 'handleOpenAudioEffects'))
})
