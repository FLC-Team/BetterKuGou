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
    setTimeout,
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

test('previous near-end restart defaults off and persists only explicit boolean preferences', async () => {
  const { store, app, files, settingsPath } = createStore()
  await store.initSettingsStore(app)
  assert.equal(store.getDefaultSettings().playback.restartOnPreviousNearEnd, false)
  assert.equal(store.getSettings().playback.restartOnPreviousNearEnd, false)
  for (const enabled of [true, false]) {
    await store.setSettings({ playback: { restartOnPreviousNearEnd: enabled } })
    await store.setSettings({ playback: { quality: '320' } })
    assert.equal(store.getSettings().playback.restartOnPreviousNearEnd, enabled)
    assert.equal(JSON.parse(files.get(settingsPath)).playback.restartOnPreviousNearEnd, enabled)
    const reopened = createStore()
    reopened.files.set(reopened.settingsPath, files.get(settingsPath))
    await reopened.store.initSettingsStore(reopened.app)
    assert.equal(reopened.store.getSettings().playback.restartOnPreviousNearEnd, enabled)
  }
  for (const invalid of ['true', 'false', 1, 0, null, {}, []]) {
    files.set('/previous-import.json', JSON.stringify({ playback: { restartOnPreviousNearEnd: invalid } }))
    await store.importSettings('/previous-import.json')
    assert.equal(store.getSettings().playback.restartOnPreviousNearEnd, false)
  }
})

test('desktop lyric preferences supplement old settings and reject invalid display values', async () => {
  const fixture = createStore()
  await fixture.store.initSettingsStore(fixture.app)
  assert.equal(fixture.store.getSettings().playback.showTranslation, true)
  const desktopDefaults = JSON.parse(JSON.stringify(fixture.store.getDefaultSettings().desktopLyrics))
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.store.getSettings().desktopLyrics)), desktopDefaults)
  await fixture.store.setSettings({ desktopLyrics: { fontSize: 'large', theme: 'minimal', locked: true } })
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.store.getSettings().desktopLyrics)), { ...desktopDefaults, fontSize: 'large', theme: 'minimal', locked: true })
  await fixture.store.setSettings({ desktopLyrics: { fontSize: 900, theme: 'arbitrary-css', locked: 'false' } })
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.store.getSettings().desktopLyrics)), desktopDefaults)
  assert.deepEqual(JSON.parse(fixture.files.get(fixture.settingsPath)).desktopLyrics, desktopDefaults)
  for (const playback of [null, 'invalid', false, [], 1]) {
    await fixture.store.setSettings({ playback })
    assert.equal(fixture.store.getSettings().playback.showTranslation, true)
  }
  await fixture.store.setSettings({ playback: { showTranslation: false } })
  assert.equal(fixture.store.getSettings().playback.showTranslation, false)
  await fixture.store.setSettings({ playback: { showTranslation: 'false' } })
  assert.equal(fixture.store.getSettings().playback.showTranslation, true)
})

test('desktop geometry persists negative monitor coordinates and rejects malformed imported bounds', async () => {
  const { store, app } = createStore()
  await store.initSettingsStore(app)
  const bounds = { x: -1500, y: 80, width: 900, height: 220 }
  await store.setSettings({ desktopLyrics: { bounds } })
  await store.setSettings({ desktopLyrics: { fontSize: 'large' } })
  assert.deepEqual(JSON.parse(JSON.stringify(store.getSettings().desktopLyrics.bounds)), bounds)
  await store.overwriteSettings({ desktopLyrics: { bounds: { x: 0, y: 0, width: 20, height: 10 } } })
  assert.deepEqual(JSON.parse(JSON.stringify(store.getSettings().desktopLyrics.bounds)), { x: 0, y: 0, width: 420, height: 180 })
  for (const invalid of [null, {}, { x: '1', y: 2, width: 800, height: 200 }, { x: 0, y: 0, width: NaN, height: 200 }]) {
    await store.overwriteSettings({ desktopLyrics: { bounds: invalid } })
    assert.equal(store.getSettings().desktopLyrics.bounds, null)
  }
})

test('desktop display controls persist together and partial edits preserve saved appearance and geometry', async () => {
  const { store, app, files, settingsPath } = createStore()
  await store.initSettingsStore(app)
  const preferences = {
    doubleLine: false, efficientMode: true, transitionEnabled: false, transitionBlur: false,
    hideTranslation: true, songInfoOnly: true, karaokeEnabled: false,
    autoHidePaused: true, hideOnFullscreen: true, hideOnLyricView: false,
    hoverFade: true, hoverOpacity: 0, opacity: 72, strokeWidth: 125,
    alignment: 'right', fontFamily: 'Microsoft YaHei', activeColor: '#aabbcc', textColor: '#ddeeff', translationColor: '#112233',
    shadowEnabled: true, shadowColorMode: 'custom', shadowColor: '#102030', shadowDepth: 8,
    shadowDirection: 180, shadowOpacity: 65, shadowRadius: 12, alwaysOnTop: false, hideUnlockButton: true,
    bounds: { x: -800, y: 50, width: 500, height: 200 }
  }
  await store.setSettings({ desktopLyrics: preferences })
  await store.setSettings({ desktopLyrics: { fontSize: 'large' } })
  const saved = JSON.parse(files.get(settingsPath)).desktopLyrics
  for (const [key, value] of Object.entries(preferences)) assert.deepEqual(saved[key], value, key)
  assert.equal(saved.fontSize, 'large')
  await store.setSettings({ desktopLyrics: { fontFamily: '', activeColor: '' } })
  assert.equal(store.getSettings().desktopLyrics.fontFamily, '')
  assert.equal(store.getSettings().desktopLyrics.activeColor, '')
  assert.equal(store.getSettings().desktopLyrics.textColor, '#ddeeff')
  assert.equal(store.getSettings().playback.showTranslation, true, 'desktop translation override never rewrites the global preference')
})

test('desktop option imports reject invalid visual fields and renderer normalization matches the main process', () => {
  const { store } = createStore()
  const rendererSource = fs.readFileSync(path.join(__dirname, '../src/stores/settingsStore.js'), 'utf8')
  const start = rendererSource.indexOf('const desktopLyricDefaults =')
  const end = rendererSource.indexOf('const baseDefaultSettings =')
  const normalizeRenderer = vm.runInNewContext(rendererSource.slice(start, end) + '\nnormalizeDesktopLyrics')
  const plain = value => JSON.parse(JSON.stringify(value))
  const invalid = {
    doubleLine: 'false', karaokeEnabled: 0, alwaysOnTop: null, hideOnFullscreen: 1,
    opacity: -8, hoverOpacity: 999, shadowRadius: Infinity, shadowOpacity: '70', shadowDirection: -10, shadowDepth: 100,
    strokeWidth: 201, alignment: 'justify', fontFamily: 'bad\nfont', activeColor: 'red; display:none', textColor: '#ABCDEF',
    translationColor: 'url(https://example.test)', shadowColorMode: 'unsafe', shadowColor: '#fff', unknown: 'discarded'
  }
  const normalized = store.normalizeDesktopLyrics(invalid)
  assert.equal(normalized.doubleLine, true)
  assert.equal(normalized.karaokeEnabled, true)
  assert.equal(normalized.hideOnFullscreen, false)
  assert.equal(normalized.opacity, 0)
  assert.equal(normalized.hoverOpacity, 100)
  assert.equal(normalized.strokeWidth, 200)
  assert.equal(normalized.shadowDepth, 30)
  assert.equal(normalized.shadowDirection, 0)
  assert.equal(normalized.shadowRadius, 10)
  assert.equal(normalized.shadowOpacity, 50)
  assert.equal(normalized.fontFamily, '')
  assert.equal(normalized.activeColor, '')
  assert.equal(normalized.textColor, '#abcdef')
  assert.equal(normalized.translationColor, '')
  assert.equal(normalized.shadowColor, '#000000')
  assert.equal(normalized.unknown, undefined)
  for (const input of [undefined, null, false, [], {}, invalid, { fontFamily: '字体'.repeat(100), opacity: 32.4 },
    { doubleLine: false, shadowEnabled: true, alignment: 'left', hideUnlockButton: true, bounds: { x: -100, y: 10, width: 700, height: 200 } }]) {
    assert.deepEqual(plain(normalizeRenderer(input)), plain(store.normalizeDesktopLyrics(input)))
  }
})

test('offline cache defaults and imported controls are normalized without changing reserved paths', async () => {
  const { store, app } = createStore()
  await store.initSettingsStore(app)
  assert.equal(store.getSettings().download.offlinePlaylistCacheEnabled, true)
  assert.equal(store.getSettings().download.cacheSizeIndex, 0)
  assert.equal(store.getSettings().download.concurrentDownloads, 3)
  await store.setSettings({ download: { offlinePlaylistCacheEnabled: false, cacheSizeIndex: 5, concurrentDownloads: 10, cachePath: '/saved-reserved-cache' } })
  assert.equal(store.getSettings().download.offlinePlaylistCacheEnabled, false)
  assert.equal(store.getSettings().download.cacheSizeIndex, 5)
  assert.equal(store.getSettings().download.concurrentDownloads, 10)
  await store.setSettings({ download: { offlinePlaylistCacheEnabled: 'false', cacheSizeIndex: 100, concurrentDownloads: 20 } })
  assert.equal(store.getSettings().download.offlinePlaylistCacheEnabled, true)
  assert.equal(store.getSettings().download.cacheSizeIndex, 0)
  assert.equal(store.getSettings().download.concurrentDownloads, 10)
  assert.equal(store.getSettings().download.cachePath, '/saved-reserved-cache')
  await store.setSettings({ download: null })
  assert.equal(store.getSettings().download.concurrentDownloads, 3)
})

test('only the migration transaction can change the cache root; drafts and imports preserve it', async () => {
  const fixture = createStore()
  const { store } = fixture
  await store.initSettingsStore(fixture.app)
  assert.equal(store.getSettings().download.offlineCachePath, '')
  const target = path.resolve('cache-migration-fixture')
  await store.setSettings({ download: { offlineCachePath: target } })
  assert.equal(store.getSettings().download.offlineCachePath, '')
  const notified = []
  store.onSettingsChange(value => notified.push(value.download.offlineCachePath))
  await Promise.all([
    store.setOfflineCacheDirectory(target),
    store.setSettings({ download: { offlineCachePath: '', concurrentDownloads: 5 } })
  ])
  assert.equal(store.getSettings().download.offlineCachePath, target)
  assert.equal(store.getSettings().download.concurrentDownloads, 5)
  await store.overwriteSettings({ download: { offlineCachePath: path.resolve('untrusted-import') } })
  assert.equal(store.getSettings().download.offlineCachePath, target)
  assert.equal(JSON.parse(fixture.files.get(fixture.settingsPath)).download.offlineCachePath, target)
  assert.ok(notified.every(value => value === target))
  await assert.rejects(store.setOfflineCacheDirectory('relative-folder'))
})

test('migration path save failures preserve the old disk path and remain retryable', async () => {
  const fixture = createStore()
  const { store } = fixture
  await store.initSettingsStore(fixture.app)
  const before = fixture.files.get(fixture.settingsPath)
  const target = path.resolve('cache-migration-fixture')
  fixture.setWriteHook(async () => { throw Object.assign(new Error('Disk full'), { code: 'ENOSPC' }) })
  await assert.rejects(store.setOfflineCacheDirectory(target), /Disk full/)
  assert.equal(store.getSettings().download.offlineCachePath, '')
  assert.equal(fixture.files.get(fixture.settingsPath), before)
  fixture.setWriteHook(async () => {})
  await store.setOfflineCacheDirectory(target)
  assert.equal(store.getSettings().download.offlineCachePath, target)
})

test('migration path persistence retries transient Windows file locks without publishing early', { skip: process.platform !== 'win32' }, async () => {
  const fixture = createStore()
  const { store } = fixture
  await store.initSettingsStore(fixture.app)
  let attempts = 0
  const notifications = []
  store.onSettingsChange(value => notifications.push(value.download.offlineCachePath))
  fixture.setWriteHook(async () => {
    assert.equal(store.getSettings().download.offlineCachePath, '')
    if (++attempts < 3) throw Object.assign(new Error('File locked'), { code: 'EPERM' })
  })
  const target = path.resolve('cache-migration-fixture')
  await store.setOfflineCacheDirectory(target)
  assert.equal(attempts, 3)
  assert.deepEqual(notifications, [target])
  assert.equal(JSON.parse(fixture.files.get(fixture.settingsPath)).download.offlineCachePath, target)
})

test('permanent Windows file locks stop migration persistence after bounded retries', { skip: process.platform !== 'win32' }, async () => {
  const fixture = createStore()
  const { store } = fixture
  await store.initSettingsStore(fixture.app)
  const before = fixture.files.get(fixture.settingsPath)
  let attempts = 0
  fixture.setWriteHook(async () => { attempts++; throw Object.assign(new Error('File locked'), { code: 'EACCES' }) })
  await assert.rejects(store.setOfflineCacheDirectory(path.resolve('cache-migration-fixture')), { code: 'EACCES' })
  assert.equal(attempts, 5)
  assert.equal(store.getSettings().download.offlineCachePath, '')
  assert.equal(fixture.files.get(fixture.settingsPath), before)
})

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

test('update preferences fill old settings, preserve explicit choices and discard automatic-install fields', async () => {
  const fixture = createStore()
  const { store } = fixture
  await store.initSettingsStore(fixture.app)
  const read = () => JSON.parse(JSON.stringify(store.getSettings().software.updates))
  const defaults = { autoCheck: true, autoDownload: false, channel: 'stable' }
  assert.deepEqual(read(), defaults)
  await store.setSettings({ software: { updates: { autoCheck: false, autoDownload: true, channel: 'beta', autoInstall: true } } })
  assert.deepEqual(read(), { autoCheck: false, autoDownload: true, channel: 'beta' })
  for (const updates of [null, false, 5, 'invalid', [], { autoCheck: 'false', autoDownload: 1, channel: 'nightly' }]) {
    await store.overwriteSettings({ software: { updates } })
    assert.deepEqual(read(), defaults)
  }
  for (const software of [null, false, [], 'invalid']) {
    await store.overwriteSettings({ software })
    assert.deepEqual(read(), defaults)
  }
})

test('failed update preference saves do not publish a new automatic-download policy', async () => {
  const fixture = createStore()
  await fixture.store.initSettingsStore(fixture.app)
  let broadcasts = 0
  fixture.store.onSettingsChange(() => { broadcasts += 1 })
  fixture.setWriteHook(async () => { throw new Error('Disk full') })
  await assert.rejects(fixture.store.setSettings({ software: { updates: { autoDownload: true, channel: 'beta' } } }), /Disk full/)
  assert.equal(fixture.store.getSettings().software.updates.autoDownload, false)
  assert.equal(fixture.store.getSettings().software.updates.channel, 'stable')
  assert.equal(broadcasts, 0)
})
