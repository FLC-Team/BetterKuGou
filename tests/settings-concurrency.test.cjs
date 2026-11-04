const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const vue = require('vue')
const { EventEmitter } = require('node:events')

const root = path.join(__dirname, '..')
const clone = value => JSON.parse(JSON.stringify(value))
const silent = Object.fromEntries(['trace', 'warn', 'error', 'info'].map(level => [level, () => {}]))
const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

/** Run the real stores, fixed preload and patch handler; replace only disk and Electron delivery. */
async function fixture() {
  const files = new Map()
  const context = { module: { exports: {} }, structuredClone, process, setTimeout,
    require(name) {
      if (name === 'fs') return { promises: {
        async readFile(file) { if (!files.has(file)) throw Object.assign(new Error('Missing'), { code: 'ENOENT' }); return files.get(file) },
        async writeFile(file, data) { files.set(file, data) },
        async rename(from, to) { files.set(to, files.get(from)); files.delete(from) },
        async unlink(file) { files.delete(file) }, async mkdir() {}
      } }
      if (name === './logger') return silent
      if (name === './autoLaunch') return { isAutoLaunchSupported: () => false }
      if (name === './audioEffectsConfig.cjs') return require('../electron/audioEffectsConfig.cjs')
      return require(name)
    } }
  vm.runInNewContext(fs.readFileSync(path.join(root, 'electron/settingsStore.js'), 'utf8'), context)
  const main = context.module.exports
  await main.initSettingsStore({ getPath: name => name === 'userData' ? '/isolated-data' : '/isolated-downloads' })
  const handlers = new Map(), sender = {}, exposed = {}, calls = []
  const source = fs.readFileSync(path.join(root, 'electron/main.js'), 'utf8')
  const start = source.indexOf("ipcMain.handle('settings:patch'")
  vm.runInNewContext(source.slice(start, source.indexOf("ipcMain.handle('settings:export'", start)), {
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    isMainWindowSender: event => event?.sender === sender, isQuitting: false,
    setSettings: main.setSettings, ensureCacheDirectory: async () => {}
  })
  let hold = null, fail = null
  const ipc = new EventEmitter()
  ipc.invoke = async (channel, value, removedPaths) => {
    if (['settings:set', 'settings:patch'].includes(channel)) {
      calls.push({ channel, value: clone(value), ...(removedPaths?.length ? { removedPaths: clone(removedPaths) } : {}) })
      if (hold) { const gate = hold; hold = null; await gate.promise }
      if (fail) { const error = fail; fail = null; throw error }
    }
    if (channel === 'settings:get') return main.getSettings()
    if (channel === 'settings:get-defaults') return main.getDefaultSettings()
    if (channel === 'settings:get-default-paths') return main.getDefaultPaths()
    if (channel === 'settings:set') return main.setSettings(value, { merge: false })
    return handlers.get(channel)({ sender }, value, removedPaths)
  }
  vm.runInNewContext(fs.readFileSync(path.join(root, 'electron/preload.js'), 'utf8'), {
    require: () => ({ ipcRenderer: ipc, contextBridge: { exposeInMainWorld: (name, value) => { exposed[name] = value } } }),
    window: {}, console: silent
  })
  main.onSettingsChange(snapshot => ipc.emit('settings:updated', {}, snapshot))
  const strip = value => value.replace(/^import\b[\s\S]*?from\s+['"][^'"]+['"]\s*;?\s*$/gm, '')
    .replace(/^export \{.*\}\s*$/gm, '').replace(/\bexport (?=(?:async )?function|const|class)/g, '')
  const sandbox = vm.createContext({ ...vue, structuredClone, window: { settingsAPI: exposed.settingsAPI }, logger: silent,
    localStorage: { getItem: () => null }, applyTheme() {} })
  const objectSource = strip(fs.readFileSync(path.join(root, 'src/utils/objectUtils.js'), 'utf8'))
  const storeSource = strip(fs.readFileSync(path.join(root, 'src/stores/settingsStore.js'), 'utf8'))
  const renderer = vm.runInContext(objectSource + '\n' + storeSource + '\n;({initSettings, useSettingsStore})', sandbox)
  await renderer.initSettings()
  return { main, store: renderer.useSettingsStore(), calls, handlers, sender,
    holdNext() { hold = deferred(); return hold }, failNext(error) { fail = error } }
}

test('a renderer edit cannot overwrite desktop changes committed while its IPC is pending', async () => {
  const f = await fixture(), gate = f.holdNext()
  const saving = f.store.updateSettings({ playback: { quality: '320' } })
  await new Promise(resolve => setImmediate(resolve))
  const bounds = { x: 120, y: 160, width: 600, height: 220 }
  await f.main.setSettings({ desktopLyrics: { locked: true, bounds }, islandLyrics: { position: { x: 20, y: 30 } } })
  gate.resolve()
  await saving
  const saved = f.main.getSettings()
  assert.equal(saved.desktopLyrics.locked, true)
  assert.deepEqual(clone(saved.desktopLyrics.bounds), bounds)
  assert.deepEqual(clone(saved.islandLyrics.position), { x: 20, y: 30 })
  assert.equal(saved.playback.quality, '320')
  assert.deepEqual(f.calls, [{ channel: 'settings:patch', value: { playback: { quality: '320' } } }])
  assert.equal(f.store.settings.desktopLyrics.locked, true)
})

test('batched partial writes preserve later edits and failed saves remain retryable', async () => {
  const f = await fixture(), gate = f.holdNext()
  const failed = assert.rejects(f.store.updateSettings({ playback: { quality: '320' } }), /controlled failure/)
  await new Promise(resolve => setImmediate(resolve))
  f.failNext(new Error('controlled failure'))
  const later = f.store.updateSettings({ software: { defaultPage: 'favorites' } })
  await f.main.setSettings({ desktopLyrics: { locked: true } })
  gate.resolve()
  await failed
  await later
  assert.equal(f.main.getSettings().desktopLyrics.locked, true)
  assert.equal(f.main.getSettings().playback.quality, '128')
  assert.equal(f.main.getSettings().software.defaultPage, 'favorites')
  await f.store.updateSettings({ playback: { quality: '320' } })
  assert.equal(f.main.getSettings().playback.quality, '320')
})

test('explicit replacement retains reset semantics and patch IPC rejects foreign senders', async () => {
  const f = await fixture()
  await f.main.setSettings({ desktopLyrics: { locked: true } })
  await f.store.overwriteSettings({ playback: { quality: 'flac' } })
  assert.equal(f.calls.at(-1).channel, 'settings:set')
  assert.equal(f.main.getSettings().desktopLyrics.locked, false)
  assert.equal(f.main.getSettings().playback.quality, 'flac')
  const patch = f.handlers.get('settings:patch')
  await assert.rejects(patch({ sender: {} }, { playback: { quality: '320' } }), /unavailable/)
  for (const value of [null, [], 4, 'invalid']) await assert.rejects(patch({ sender: f.sender }, value), /Invalid/)
  for (const removals of [null, {}, [[]], [['__proto__']], [['software', 'constructor']]]) {
    await assert.rejects(patch({ sender: f.sender }, {}, removals), /Invalid/)
  }
})

test('partial deletion restores defaults without losing concurrent fields and preserves delete-then-edit order', async () => {
  const f = await fixture()
  await f.store.updateSettings({ software: { defaultPage: 'favorite' } })
  const gate = f.holdNext()
  const saving = f.store.updateSettings({ software: { defaultPage: undefined } })
  await new Promise(resolve => setImmediate(resolve))
  await f.main.setSettings({ desktopLyrics: { locked: true } })
  gate.resolve()
  await saving
  assert.equal(f.main.getSettings().software.defaultPage, 'home')
  assert.equal(f.main.getSettings().desktopLyrics.locked, true)
  assert.deepEqual(f.calls.at(-1).removedPaths, [['software', 'defaultPage']])
  await f.store.updateSettings({ software: { restorePlaylist: false, defaultPage: 'favorite' } })
  await f.store.updateSettings({ software: undefined }, { persist: false })
  await f.store.updateSettings({ software: { defaultPage: 'my-music' } })
  assert.equal(f.main.getSettings().software.defaultPage, 'my-music')
  assert.equal(f.main.getSettings().software.restorePlaylist, true)
  assert.equal(f.main.getSettings().desktopLyrics.locked, true)
})
