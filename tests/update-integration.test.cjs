const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
const vue = require('vue')

const quiet = Object.fromEntries(['trace', 'log', 'debug', 'info', 'warn', 'error'].map(key => [key, () => {}]))

function loadMain({ packaged = false } = {}) {
  const windows = [], handlers = new Map(), timeline = []
  let options, listener, confirmation = 0, verifyHook, stopCalls = 0
  const file = { path: '/user-data/updates/1/setup.exe', assetId: 7, assetName: 'setup.exe', version: '1.0.0', format: 'exe' }
  const settings = { software: { minimizeToTray: true, updates: { autoCheck: true, autoDownload: false, channel: 'stable' } } }
  const service = {
    configure(policy) { timeline.push(['configure', policy]) },
    getState() { return { revision: 1, status: 'downloaded', currentVersion: '0.1.6-alpha-pre1' } },
    check() { timeline.push(['check']); return this.getState() },
    download(id) { timeline.push(['download', id]); return this.getState() },
    cancel() { timeline.push(['cancel']); return this.getState() },
    async getDownloadedFile() { timeline.push(['verify']); return verifyHook ? verifyHook() : { ...file } },
    async stop() { stopCalls += 1; timeline.push(['stop']) }
  }
  const app = Object.assign(new EventEmitter(), {
    isPackaged: packaged, commandLine: { appendSwitch() {} },
    whenReady: () => new Promise(() => {}), getPath: () => '/user-data',
    getAppPath: () => '/app', getVersion: () => '0.1.6-alpha-pre1',
    quit() { timeline.push(['quit']) }
  })
  class Window extends EventEmitter {
    constructor() {
      super()
      this.webContents = Object.assign(new EventEmitter(), {
        mainFrame: {}, send: (...args) => timeline.push(['send', ...args]),
        session: { clearCache: async () => {} }, openDevTools() {}
      })
      windows.push(this)
    }
    isDestroyed() { return false }
    loadURL() { return Promise.resolve() }
    loadFile() { return Promise.resolve() }
    close() { this.emit('closed') }
    hide() {}
    show() {}
    focus() {}
  }
  Window.getAllWindows = () => windows
  const context = vm.createContext({
    require(name) {
      if (name === 'electron') return {
        app, BrowserWindow: Window,
        ipcMain: Object.assign(new EventEmitter(), { handle: (name, handler) => handlers.set(name, handler) }),
        globalShortcut: { unregisterAll() {} },
        dialog: { async showMessageBox(_win, dialog) { timeline.push(['confirm', dialog]); return typeof confirmation === 'function' ? confirmation() : { response: confirmation } } },
        shell: { async openPath(target) { timeline.push(['open', target]); return '' }, showItemInFolder(target) { timeline.push(['reveal', target]) } },
        nativeImage: { createFromPath: () => ({}) }, Tray: class {}, Menu: {}
      }
      if (name === './logger') return quiet
      if (name === './services/backendService') return { createBackendService: () => ({ start() {}, stop: async () => {} }) }
      if (name === './services/updateService') return { createUpdateService: opts => { options = opts; return service } }
      if (name === './settingsStore') return { getSettings: () => settings, onSettingsChange: callback => { listener = callback; return () => {} } }
      return require(name)
    },
    __dirname: path.join(__dirname, '../electron'),
    process: { platform: 'linux', arch: 'x64', resourcesPath: '/resources', env: {} },
    console: quiet, global: {}, setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {}
  })
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../electron/main.js'), 'utf8'), context)
  const api = vm.runInContext('({initializeUpdateService, createWindow, subscribeToSettingsUpdates, performApplicationCleanup})', context)
  api.createWindow()
  api.initializeUpdateService()
  api.subscribeToSettingsUpdates()
  const event = { sender: windows[0].webContents, senderFrame: windows[0].webContents.mainFrame }
  return {
    api, options: () => options, service, timeline, file, event, settings,
    invoke: (name, eventOverride = event, ...args) => handlers.get('updates:' + name)(eventOverride, ...args),
    confirm: value => { confirmation = value }, verify: callback => { verifyHook = callback },
    publish: snapshot => listener(snapshot), stopCalls: () => stopCalls
  }
}

test('update resources resolve in development and packaged apps; startup and shutdown never install', async () => {
  for (const packaged of [false, true]) {
    const f = loadMain({ packaged })
    assert.equal(f.options().workerPath, path.join(packaged ? '/resources/updater' : '/app/electron/services', 'updateWorker.cjs'))
    assert.equal(f.options().downloadRoot, path.join('/user-data', 'updates'))
    assert.equal(f.options().currentVersion, '0.1.6-alpha-pre1')
    f.options().onState({ status: 'downloaded' })
    await Promise.all([f.api.performApplicationCleanup(), f.api.performApplicationCleanup()])
    assert.equal(f.stopCalls(), 1)
    assert.equal(f.timeline.some(([name]) => ['open', 'confirm', 'quit'].includes(name)), false)
  }
})

test('update IPC rejects auxiliary windows and subframes before operating', async () => {
  const f = loadMain()
  for (const event of [{ sender: {}, senderFrame: {} }, { sender: f.event.sender, senderFrame: {} }]) {
    for (const action of ['get-state', 'check', 'download', 'cancel']) {
      assert.throws(() => f.invoke(action, event), /主窗口/)
    }
    for (const action of ['install', 'reveal']) {
      const result = await f.invoke(action, event)
      assert.equal(result.success, false)
    }
  }
  assert.equal(f.timeline.some(([name]) => ['open', 'confirm', 'verify', 'check', 'download', 'cancel'].includes(name)), false)
})

test('saved policies are passed to the update service and main-window checks return state', () => {
  const f = loadMain()
  const policy = { autoCheck: false, autoDownload: true, channel: 'beta' }
  f.publish({ software: { updates: policy } })
  assert.equal(f.timeline.at(-1)[0], 'configure')
  assert.equal(f.timeline.at(-1)[1], policy)
  assert.equal(f.invoke('get-state').currentVersion, '0.1.6-alpha-pre1')
  assert.equal(f.invoke('check').status, 'downloaded')
})

test('manual installation requires explicit native confirmation, verifies again, and leaves the app running', async () => {
  const f = loadMain()
  const cancelled = await f.invoke('install')
  assert.equal(cancelled.canceled, true)
  assert.equal(f.timeline.some(([name]) => name === 'open'), false)
  const dialog = f.timeline.find(([name]) => name === 'confirm')[1]
  assert.equal(dialog.defaultId, 0)
  assert.equal(dialog.cancelId, 0)
  f.timeline.length = 0
  f.confirm(1)
  const result = await f.invoke('install')
  assert.equal(result.success, true)
  assert.deepEqual(f.timeline.map(([name]) => name), ['verify', 'confirm', 'verify', 'open'])
  assert.equal(f.timeline.at(-1)[1], f.file.path)
})

test('a changed or damaged package cannot open after confirmation; AppImage is never executed', async () => {
  const f = loadMain()
  f.confirm(1)
  let verifies = 0
  f.verify(() => ({ ...f.file, assetId: ++verifies === 1 ? 7 : 9 }))
  assert.equal((await f.invoke('install')).success, false)
  assert.equal(f.timeline.some(([name]) => name === 'open'), false)
  f.verify(() => { throw new Error('SHA256 校验失败') })
  assert.equal((await f.invoke('install')).success, false)
  assert.equal((await f.invoke('reveal')).success, false)
  assert.equal(f.timeline.some(([name]) => name === 'reveal'), false)
  f.timeline.length = 0
  f.verify(() => ({ ...f.file, format: 'AppImage' }))
  assert.equal((await f.invoke('install')).success, false)
  assert.deepEqual(f.timeline.map(([name]) => name), ['verify'])
})

test('repeated installation clicks share no second dialog and shutdown invalidates a pending confirmation', async () => {
  const f = loadMain()
  let release
  f.confirm(() => new Promise(resolve => { release = resolve }))
  const pending = f.invoke('install')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal((await f.invoke('install')).canceled, true)
  await f.api.performApplicationCleanup()
  release({ response: 1 })
  assert.equal((await pending).success, false)
  assert.equal(f.timeline.filter(([name]) => name === 'confirm').length, 1)
  assert.equal(f.timeline.some(([name]) => name === 'open'), false)
})

test('renderer update preferences migrate identically and never retain an automatic-install switch', async () => {
  function load(file, globals, exported) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
      .replace(/^import[^\n]*\n/gm, '').replace(/^export \{.*\}\s*$/gm, '').replace(/\bexport (?=(?:async )?function|const)/g, '')
    return vm.runInNewContext(`${source}\n;({${exported}})`, globals)
  }
  const utils = load('src/utils/objectUtils.js', { ...vue, structuredClone }, 'cloneDeep, mergeDeep, replaceReactive')
  const loaded = load('src/stores/settingsStore.js', {
    ...vue, ...utils, logger: quiet, applyTheme() {}, window: {},
    localStorage: { getItem: () => '{}', setItem() {} }
  }, 'initSettings, useSettingsStore')
  await loaded.initSettings()
  const store = loaded.useSettingsStore()
  const defaults = { autoCheck: true, autoDownload: false, channel: 'stable' }
  assert.deepEqual(JSON.parse(JSON.stringify(store.settings.software.updates)), defaults)
  for (const updates of [null, false, 'invalid', [], { autoCheck: 'false', autoDownload: 1, channel: 'unknown', autoInstall: true }]) {
    await store.overwriteSettings({ software: { updates } })
    assert.deepEqual(JSON.parse(JSON.stringify(store.settings.software.updates)), defaults)
  }
  await store.overwriteSettings({ software: { updates: { autoCheck: false, autoDownload: true, channel: 'beta' } } })
  assert.deepEqual(JSON.parse(JSON.stringify(store.settings.software.updates)), { autoCheck: false, autoDownload: true, channel: 'beta' })
})
