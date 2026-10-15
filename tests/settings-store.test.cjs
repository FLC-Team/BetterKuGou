const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

function createStore() {
  const files = new Map()
  const settingsPath = path.join('/user-data', 'settings.json')
  files.set(settingsPath, '{}')
  let writeHook = async () => {}
  const fileSystem = {
    async readFile(file) {
      if (!files.has(file)) throw Object.assign(new Error('Missing file'), { code: 'ENOENT' })
      return files.get(file)
    },
    async writeFile(file, data) {
      await writeHook(file, data)
      files.set(file, data)
    },
    async rename(from, to) {
      files.set(to, files.get(from))
      files.delete(from)
    },
    async unlink(file) {
      files.delete(file)
    },
    async mkdir() {}
  }
  const context = {
    module: { exports: {} },
    process,
    structuredClone,
    require(name) {
      if (name === 'fs') return { promises: fileSystem }
      if (name === './logger') return { warn() {}, error() {} }
      if (name === './autoLaunch') return { isAutoLaunchSupported: () => false }
      return require(name)
    }
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../electron/settingsStore.js'), 'utf8'), context)
  return {
    store: context.module.exports,
    files,
    settingsPath,
    setWriteHook(hook) { writeHook = hook },
    app: { getPath: (key) => key === 'userData' ? '/user-data' : '/downloads' }
  }
}

test('failed settings writes preserve the committed cache and later transactions still work', async () => {
  const fixture = createStore()
  const { store } = fixture
  await store.initSettingsStore(fixture.app)
  const before = store.getSettings()
  const diskBefore = fixture.files.get(fixture.settingsPath)
  const notifications = []
  store.onSettingsChange((settings) => notifications.push(settings))
  fixture.setWriteHook(async () => { throw new Error('Disk full') })

  await assert.rejects(store.setSettings({ custom: { theme: 'light' } }), /Disk full/)
  assert.deepEqual(store.getSettings(), before)
  assert.equal(fixture.files.get(fixture.settingsPath), diskBefore)
  assert.equal(notifications.length, 0)
  assert.equal([...fixture.files.keys()].some((file) => file.endsWith('.tmp')), false)

  fixture.setWriteHook(async () => {})
  await store.setSettings({ playback: { enqueueFullPlaylist: false } })
  assert.equal(store.getSettings().custom.theme, 'dark')
  assert.equal(store.getSettings().playback.enqueueFullPlaylist, false)
  assert.equal(notifications.length, 1)
})

test('concurrent partial updates merge against the latest committed settings', async () => {
  const fixture = createStore()
  const { store } = fixture
  await store.initSettingsStore(fixture.app)
  let release
  let started
  const writeStarted = new Promise((resolve) => { started = resolve })
  const gate = new Promise((resolve) => { release = resolve })
  let writes = 0
  fixture.setWriteHook(async () => {
    writes += 1
    if (writes === 1) {
      started()
      await gate
    }
  })
  const notifications = []
  store.onSettingsChange((settings) => notifications.push(settings.custom.theme))
  const first = store.setSettings({ custom: { theme: 'light' } })
  await writeStarted
  const second = store.setSettings({ playback: { enqueueFullPlaylist: false } })
  assert.equal(store.getSettings().custom.theme, 'dark')
  assert.equal(writes, 1)
  release()
  const [firstResult, secondResult] = await Promise.all([first, second])
  assert.equal(firstResult.playback.enqueueFullPlaylist, true)
  assert.equal(secondResult.custom.theme, 'light')
  assert.equal(secondResult.playback.enqueueFullPlaylist, false)
  assert.deepEqual(notifications, ['light', 'light'])
  assert.deepEqual(JSON.parse(fixture.files.get(fixture.settingsPath)), store.getSettings())
})

test('unsafe configuration keys are rejected before writes or cache changes', async () => {
  const fixture = createStore()
  const { store } = fixture
  await store.initSettingsStore(fixture.app)
  const before = store.getSettings()
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const payload = JSON.parse(`{"session":{"playlist":[{"${key}":{"polluted":true}}]}}`)
    await assert.rejects(store.setSettings(payload), /Unsafe settings key/)
    await assert.rejects(store.overwriteSettings(payload), /Unsafe settings key/)
    assert.deepEqual(store.getSettings(), before)
  }
  assert.equal({}.polluted, undefined)
})

test('an unsupported auto-launch update commits the corrected state and does not block later updates', async () => {
  const fixture = createStore()
  const { store } = fixture
  await store.initSettingsStore(fixture.app)
  await assert.rejects(store.setSettings({ software: { autoLaunch: true } }), /AUTO_LAUNCH_UNSUPPORTED/)
  assert.equal(store.getSettings().software.autoLaunch, false)
  await store.setSettings({ custom: { theme: 'light' } })
  assert.equal(store.getSettings().custom.theme, 'light')
})
