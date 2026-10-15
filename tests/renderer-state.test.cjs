const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const vue = require('vue')

const root = path.join(__dirname, '..')
const quietLogger = Object.fromEntries(['trace', 'info', 'warn', 'error'].map(level => [level, () => {}]))
const quietConsole = Object.fromEntries(['log', 'info', 'warn', 'error'].map(level => [level, () => {}]))

function stripImports(source) {
  return source.replace(/^import\b[\s\S]*?from\s+['"][^'"]+['"]\s*;?\s*$/gm, '')
}

function loadModule(relativePath, globals, exports) {
  const source = stripImports(fs.readFileSync(path.join(root, relativePath), 'utf8'))
    .replace(/^export default .*$/gm, '')
    .replace(/^export \{.*\}\s*$/gm, '')
    .replace(/\bexport (?=(?:async )?function|const|class)/g, '')
  const sandbox = vm.createContext({ console: quietConsole, logger: quietLogger, ...globals })
  return vm.runInContext(`${source}\n;({ ${exports.join(', ')} })`, sandbox)
}

function loadUtils() {
  return loadModule('src/utils/objectUtils.js', { ...vue, structuredClone }, ['cloneDeep', 'mergeDeep', 'replaceReactive'])
}

function loadStore(settingsAPI) {
  const memory = new Map()
  const localStorage = {
    getItem: key => memory.get(key) ?? null,
    setItem: (key, value) => memory.set(key, value)
  }
  return loadModule('src/stores/settingsStore.js', {
    ...vue,
    ...loadUtils(),
    window: { settingsAPI },
    localStorage,
    applyTheme() {}
  }, ['initSettings', 'useSettingsStore'])
}

async function queuedSettingsFixture() {
  let initializing = true
  let current = null
  let listener
  let readHook = null
  const requests = []
  const bridge = {
    get: async () => readHook ? readHook() : current,
    set: payload => {
      if (initializing) {
        current = payload
        return Promise.resolve(payload)
      }
      const gate = deferred()
      requests.push({ payload, ...gate })
      return gate.promise
    },
    onUpdate: callback => { listener = callback; return () => {} }
  }
  const loaded = loadStore(bridge)
  await loaded.initSettings()
  initializing = false
  const clone = value => JSON.parse(JSON.stringify(value))
  return {
    store: loaded.useSettingsStore(),
    requests,
    current: () => clone(current),
    setReadHook: callback => { readHook = callback },
    commit(index, transform = snapshot => snapshot, broadcast = true) {
      current = transform(clone(requests[index].payload))
      if (broadcast) listener(clone(current))
      requests[index].resolve(clone(current))
    },
    publish(snapshot) {
      current = clone(snapshot)
      listener(clone(current))
    },
    flush: () => new Promise(resolve => setImmediate(resolve))
  }
}

function loadSettingsView(store, applyTheme = () => {}) {
  const component = fs.readFileSync(path.join(root, 'src/views/SettingsView.vue'), 'utf8')
  const script = stripImports(component.match(/<script setup>([\s\S]*?)<\/script>/)[1])
  const unmountCallbacks = []
  const sandbox = vm.createContext({
    ...vue,
    ...loadUtils(),
    console: quietConsole,
    logger: quietLogger,
    window: {},
    document: { removeEventListener() {} },
    setTimeout,
    clearTimeout,
    useSettingsStore: () => store,
    applyTheme,
    defineEmits: () => () => {},
    defineExpose() {},
    onMounted() {},
    onBeforeUnmount: callback => unmountCallbacks.push(callback)
  })
  const scope = vue.effectScope()
  const view = scope.run(() => vm.runInContext(`${script}\n;({ localSettings, syncFromStore, persistEditableSettings, flushEditableSettings, prepareThemeRecovery, handleExportSettings, handleImportSettings, settingsSaveError, actionMessage, saveState })`, sandbox))
  return {
    ...view,
    dispose() {
      scope.stop()
      unmountCallbacks.forEach(callback => callback())
    }
  }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function loadApp(electronAPI = {}, overrides = {}) {
  const settings = vue.reactive({ shortcuts: { enableGlobal: true, keys: {} }, software: {}, playback: {} })
  const mounted = []
  const unmounted = []
  const sandbox = vm.createContext({
    ...vue,
    ...loadUtils(),
    console: quietConsole,
    logger: quietLogger,
    process: { env: { NODE_ENV: 'production' } },
    window: { electronAPI, addEventListener() {}, removeEventListener() {} },
    document: { addEventListener() {}, removeEventListener() {}, querySelectorAll: () => [] },
    localStorage: overrides.localStorage || { getItem: () => null },
    getUserPlaylists: overrides.getUserPlaylists || (async () => ({ status: 1, data: { info: [] } })),
    setTimeout,
    clearTimeout,
    onMounted: callback => mounted.push(callback),
    onBeforeUnmount: callback => unmounted.push(callback),
    isLoggedIn: () => false,
    getLoginInfo: () => null,
    clearLoginInfo() {},
    KUGOU_AUTH_EXPIRED_EVENT: 'expired',
    useSettingsStore: () => ({
      settings,
      ready: vue.ref(false),
      defaults: () => ({ session: { playbackState: {} } }),
      getSessionSnapshot: () => ({}),
      saveSessionSnapshot: async () => {}
    })
  })
  const script = stripImports(fs.readFileSync(path.join(root, 'src/App.vue'), 'utf8')
    .match(/<script setup>([\s\S]*?)<\/script>/)[1])
  const scope = vue.effectScope()
  const app = scope.run(() => vm.runInContext(`${script}\n;({
    settings, registeredGlobalShortcuts, registerGlobalShortcuts, handleClearPlaylist,
    handlePlaylistUpdated, handleKeyDown, currentSong, playlist, playlistIndex, musicPlayerRef,
    fetchUserPlaylists, userPlaylists, userPlaylistsLoaded, userLoggedIn, userInfo,
    handleShowLogin, handleLoginSuccess, handleLogout, handleAuthExpired, handleNavigate,
    pageSessionKey, pageSessionVersion, selectedPlaylistId, showLogin, currentView,
    performMemoryCleanup, drain: () => shortcutUpdateQueue
  })`, sandbox))
  return {
    ...app,
    mount: () => mounted.forEach(callback => callback()),
    async dispose() {
      scope.stop()
      unmounted.forEach(callback => callback())
      await app.drain()
    }
  }
}

test('settings initialization writes once and leaves browser paths unset', async () => {
  let writes = 0
  const storeModule = loadStore({ get: async () => null, set: async () => { writes++ } })
  await storeModule.initSettings()
  const store = storeModule.useSettingsStore()
  assert.equal(writes, 1)
  assert.equal(store.settings.download.downloadPath, '')
  assert.equal(store.settings.download.cachePath, '')
})

test('settings initialization handles a rejected persistence operation', async () => {
  let writes = 0
  const storeModule = loadStore({
    get: async () => null,
    set: async () => { writes++; throw new Error('disk unavailable') }
  })
  await storeModule.initSettings()
  assert.equal(writes, 1)
  assert.equal(storeModule.useSettingsStore().ready.value, true)
  assert.ok(storeModule.useSettingsStore().error.value)
})

test('an earlier settings broadcast cannot erase a pending session when another edit is queued', async () => {
  const fixture = await queuedSettingsFixture()
  const { store, requests } = fixture
  const first = store.updateSettings({ custom: { theme: 'light' } })
  await fixture.flush()
  assert.equal(requests.length, 1)
  const session = store.saveSessionSnapshot({ playbackState: { currentTime: 99 } })
  assert.equal(requests.length, 1, 'only one snapshot can be in flight')
  fixture.commit(0)
  assert.equal(store.settings.session.playbackState.currentTime, 99, 'old broadcast preserves optimistic progress')
  const third = store.updateSettings({ software: { defaultPage: 'favorites' } })
  await first
  await fixture.flush()
  assert.equal(requests.length, 2)
  assert.equal(requests[1].payload.session.playbackState.currentTime, 99)
  assert.equal(requests[1].payload.software.defaultPage, 'favorites')
  fixture.commit(1)
  await Promise.all([session, third])
  assert.equal(requests.length, 2, 'later queued edits already included in the successful snapshot need no extra write')
  assert.equal(store.settings.session.playbackState.currentTime, 99)
  assert.equal(fixture.current().session.playbackState.currentTime, 99)
})

test('current-schema settings also fill missing sections without overwriting stored choices', async () => {
  const loaded = loadStore({
    get: async () => ({ schemaVersion: 1, custom: { theme: 'light' }, software: { minimizeToTray: true } })
  })
  await loaded.initSettings()
  const { settings } = loaded.useSettingsStore()
  assert.equal(settings.custom.theme, 'light')
  assert.equal(settings.software.minimizeToTray, true)
  assert.equal(settings.shortcuts.keys.playPause, 'Space')
  assert.equal(settings.session.playbackState.currentTime, 0)
})

test('artist pagination failures are diagnosed and release the loading guard', async () => {
  const script = stripImports(fs.readFileSync(path.join(root, 'src/views/logic/ArtistView.js'), 'utf8'))
    .replace('export default', 'module.exports =')
  const diagnostics = []
  const sandbox = vm.createContext({
    module: { exports: {} }, ContextMenu: {}, ArtworkCover: {}, SongBadges: {}, nextplayIcon: '',
    logger: { error: (...args) => diagnostics.push(args) },
    getArtistAudios: async () => { throw new Error('Network unavailable') }
  })
  vm.runInContext(script, sandbox)
  const view = {
    hasMore: true, loadingMore: false, id: 1, page: 2, pagesize: 30, songs: [],
    $nextTick: callback => callback(), patchMissingCovers() {}, patchSongCoversFromAlbum() {}
  }
  await assert.doesNotReject(sandbox.module.exports.methods.loadMore.call(view))
  assert.equal(view.loadingMore, false)
  assert.equal(view.page, 2)
  assert.equal(diagnostics[0][2].message, 'Network unavailable')
})

test('a failed commit rolls back its own changes while later edits still persist', async () => {
  const fixture = await queuedSettingsFixture()
  const { store, requests } = fixture
  const first = store.updateSettings({ custom: { theme: 'light' } })
  const failed = assert.rejects(first, /disk unavailable/)
  await fixture.flush()
  const session = store.saveSessionSnapshot({ playbackState: { currentTime: 99 } })
  const third = store.updateSettings({ software: { defaultPage: 'favorites' } })
  requests[0].reject(new Error('disk unavailable'))
  await failed
  await fixture.flush()
  assert.equal(requests.length, 2)
  assert.equal(requests[1].payload.custom.theme, 'dark')
  assert.equal(requests[1].payload.session.playbackState.currentTime, 99)
  assert.equal(requests[1].payload.software.defaultPage, 'favorites')
  fixture.commit(1)
  await Promise.all([session, third])
  assert.equal(store.settings.custom.theme, 'dark')
  assert.equal(store.settings.session.playbackState.currentTime, 99)
  assert.equal(store.settings.software.defaultPage, 'favorites')
  assert.equal(store.error.value, null)
})

test('edits made during an asynchronous rollback remain queued and are saved', async () => {
  const fixture = await queuedSettingsFixture()
  const { store, requests } = fixture
  const first = store.updateSettings({ custom: { theme: 'light' } })
  const failed = assert.rejects(first, /disk unavailable/)
  await fixture.flush()
  const rollback = deferred()
  fixture.setReadHook(() => rollback.promise)
  requests[0].reject(new Error('disk unavailable'))
  await fixture.flush()
  const later = store.saveSessionSnapshot({ playbackState: { currentTime: 75 } })
  rollback.resolve(fixture.current())
  await failed
  await fixture.flush()
  assert.equal(requests[1].payload.session.playbackState.currentTime, 75)
  fixture.setReadHook(null)
  fixture.commit(1)
  await later
  assert.equal(store.settings.session.playbackState.currentTime, 75)
})

test('normalized commit results and idle external updates are accepted without feedback writes', async () => {
  const fixture = await queuedSettingsFixture()
  const { store, requests } = fixture
  const update = store.updateSettings({ software: { autoLaunch: true } })
  await fixture.flush()
  fixture.commit(0, snapshot => {
    snapshot.software.autoLaunch = false
    return snapshot
  }, false)
  await update
  assert.equal(store.settings.software.autoLaunch, false)
  const external = fixture.current()
  external.custom.theme = 'light'
  external.session.playbackState.currentTime = 30
  fixture.publish(external)
  await fixture.flush()
  assert.equal(store.settings.custom.theme, 'light')
  assert.equal(store.settings.session.playbackState.currentTime, 30)
  assert.equal(requests.length, 1)
})

test('editing settings preserves live playback sessions and external fields', async () => {
  const storeModule = loadStore()
  await storeModule.initSettings()
  const store = storeModule.useSettingsStore()
  const view = loadSettingsView(store)
  try {
    view.localSettings.playback.fullscreenLyrics = false
    await store.saveSessionSnapshot({ currentSong: { hash: 'new-song' }, playbackState: { currentTime: 42 } })
    await store.updateSettings({ playback: { showTranslation: false } })
    await vue.nextTick()
    await view.persistEditableSettings()
    assert.equal(store.settings.session.currentSong.hash, 'new-song')
    assert.equal(store.settings.session.playbackState.currentTime, 42)
    assert.equal(store.settings.playback.fullscreenLyrics, false)
    assert.equal(store.settings.playback.showTranslation, false)
    assert.equal(view.localSettings.session, undefined)
  } finally {
    view.dispose()
  }
})

test('failed settings saves keep the draft and a retry commits it without overwriting playback', async () => {
  const fixture = await queuedSettingsFixture()
  const view = loadSettingsView(fixture.store)
  try {
    view.localSettings.playback.fullscreenLyrics = false
    const failed = view.flushEditableSettings()
    await fixture.flush()
    fixture.requests[0].reject(new Error('Disk full'))
    assert.equal(await failed, false)
    assert.equal(view.localSettings.playback.fullscreenLyrics, false)
    assert.equal(fixture.store.settings.playback.fullscreenLyrics, true)
    assert.equal(view.saveState.value, 'error')
    assert.match(view.settingsSaveError.value, /修改仍保留/)
    const external = fixture.current()
    external.session.playbackState.currentTime = 42
    fixture.publish(external)
    await vue.nextTick()
    const retry = view.flushEditableSettings()
    await fixture.flush()
    fixture.commit(1)
    assert.equal(await retry, true)
    assert.equal(fixture.store.settings.playback.fullscreenLyrics, false)
    assert.equal(fixture.store.settings.session.playbackState.currentTime, 42)
    assert.equal(view.saveState.value, 'saved')
  } finally { view.dispose() }
})

test('settings flush drains edits made during a slow save and accepts normalized server values', async () => {
  const fixture = await queuedSettingsFixture()
  const view = loadSettingsView(fixture.store)
  try {
    view.localSettings.playback.fullscreenLyrics = false
    const saving = view.flushEditableSettings()
    await fixture.flush()
    view.localSettings.desktopLyrics.fontSize = 'large'
    await new Promise(resolve => setTimeout(resolve, 540))
    fixture.commit(0, snapshot => {
      snapshot.software.defaultPage = 'favorites'
      snapshot.session.playbackState.currentTime = 64
      return snapshot
    })
    await fixture.flush()
    assert.equal(fixture.requests.length, 2)
    fixture.commit(1)
    assert.equal(await saving, true)
    assert.equal(fixture.store.settings.desktopLyrics.fontSize, 'large')
    assert.equal(view.localSettings.software.defaultPage, 'favorites')
    assert.equal(fixture.store.settings.session.playbackState.currentTime, 64)
    assert.equal(view.localSettings.session, undefined)
  } finally { view.dispose() }
})

test('settings export flushes pending drafts and import/export failures are visible', async () => {
  const loaded = loadStore()
  await loaded.initSettings()
  const store = loaded.useSettingsStore()
  let exported
  store.exportSettings = async () => { exported = store.settings.playback.showTranslation; return { path: '/placeholder/settings.json' } }
  store.importSettings = async () => ({ canceled: true, error: new Error('Invalid JSON') })
  const view = loadSettingsView(store)
  try {
    view.localSettings.playback.showTranslation = false
    await view.handleExportSettings()
    assert.equal(exported, false)
    assert.match(view.actionMessage.value, /已导出/)
    await view.handleImportSettings()
    assert.match(view.actionMessage.value, /导入失败/)
    assert.equal(store.settings.playback.showTranslation, false)
    view.localSettings.playback.showTranslation = true
    view.localSettings.playback.showTranslation = false
    await vue.nextTick()
    await view.flushEditableSettings()
    assert.equal(view.saveState.value, 'saved')
  } finally { view.dispose() }
  store.exportSettings = async () => ({ canceled: true, error: new Error('Permission denied') })
  const errorView = loadSettingsView(store)
  try {
    await errorView.handleExportSettings()
    assert.match(errorView.actionMessage.value, /导出失败/)
  } finally { errorView.dispose() }
})

test('unsaved theme preview survives playback session revisions without committing the theme', async () => {
  const storeModule = loadStore()
  await storeModule.initSettings()
  const store = storeModule.useSettingsStore()
  const previews = []
  const view = loadSettingsView(store, settings => previews.push(settings.custom.theme))
  try {
    assert.equal(store.settings.custom.theme, 'dark')
    view.localSettings.custom.theme = 'light'
    await vue.nextTick()
    assert.equal(previews.at(-1), 'light')
    assert.equal(store.settings.custom.theme, 'dark')

    const previewCount = previews.length
    const initialRevision = store.revision.value
    await store.saveSessionSnapshot({ playbackState: { currentTime: 42 } })
    await vue.nextTick()

    assert.ok(store.revision.value > initialRevision)
    assert.equal(store.settings.session.playbackState.currentTime, 42)
    assert.equal(store.settings.custom.theme, 'dark')
    assert.equal(view.localSettings.custom.theme, 'light')
    assert.ok(previews.length > previewCount, 'a session commit must restore the pending preview')
    assert.equal(previews.at(-1), 'light')
  } finally {
    view.dispose()
    await vue.nextTick()
  }
})

test('appearance recovery discards pending theme drafts while preserving unrelated settings edits', async () => {
  const fixture = await queuedSettingsFixture()
  const view = loadSettingsView(fixture.store)
  try {
    view.localSettings.custom.theme = 'light'
    view.localSettings.custom.themePackages = [{ id: 'unsaved-appearance' }]
    view.localSettings.custom.themeAdjustmentId = 'unsaved-appearance'
    view.localSettings.custom.customTheme.primary = '#123abc'
    view.localSettings.custom.playerStyle = 'netease'
    view.localSettings.playback.showTranslation = false
    await vue.nextTick()
    const release = await view.prepareThemeRecovery('dark')
    assert.equal(fixture.requests.length, 0, 'preparing recovery cancels the pending appearance debounce')
    const restoring = fixture.store.updateSettings({ custom: { theme: 'dark' } })
    await fixture.flush()
    fixture.commit(0)
    await restoring
    await release()
    assert.equal(view.localSettings.custom.theme, 'dark')
    assert.equal(view.localSettings.custom.themePackages.length, 0)
    assert.equal(view.localSettings.custom.themeAdjustmentId, fixture.store.settings.custom.themeAdjustmentId)
    assert.equal(view.localSettings.custom.customTheme.primary, fixture.store.settings.custom.customTheme.primary)
    assert.equal(view.localSettings.custom.playerStyle, 'netease')
    assert.equal(view.localSettings.playback.showTranslation, false)
    const savingOthers = view.flushEditableSettings()
    await fixture.flush()
    assert.equal(fixture.requests[1].payload.custom.theme, 'dark', 'the next autosave must not reselect the discarded appearance')
    assert.equal(fixture.requests[1].payload.custom.themePackages.length, 0)
    assert.equal(fixture.requests[1].payload.custom.playerStyle, 'netease')
    assert.equal(fixture.requests[1].payload.playback.showTranslation, false)
    fixture.commit(1)
    assert.equal(await savingOthers, true)
    assert.equal(fixture.store.settings.custom.theme, 'dark')
  } finally { view.dispose() }
})

test('appearance recovery waits for an in-flight save and supersedes theme edits made while it drains', async () => {
  const fixture = await queuedSettingsFixture()
  const view = loadSettingsView(fixture.store)
  try {
    view.localSettings.custom.theme = 'light'
    const earlierSave = view.flushEditableSettings()
    await fixture.flush()
    let prepared = false
    const preparing = view.prepareThemeRecovery('dark').then(release => { prepared = true; return release })
    view.localSettings.custom.theme = 'another-unsaved-appearance'
    view.localSettings.custom.playerStyle = 'netease'
    await fixture.flush()
    assert.equal(prepared, false)
    assert.equal(fixture.requests.length, 1, 'recovery must queue behind the captured settings transaction')
    fixture.commit(0)
    const release = await preparing
    await earlierSave
    assert.equal(view.localSettings.custom.theme, 'dark')
    assert.equal(view.localSettings.custom.playerStyle, 'netease')
    const restoring = fixture.store.updateSettings({ custom: { theme: 'dark' } })
    await fixture.flush()
    fixture.commit(1)
    await restoring
    await release()
    const savingOthers = view.flushEditableSettings()
    await fixture.flush()
    assert.equal(fixture.requests[2].payload.custom.theme, 'dark')
    assert.equal(fixture.requests[2].payload.custom.playerStyle, 'netease')
    fixture.commit(2)
    assert.equal(await savingOthers, true)
    assert.equal(fixture.store.settings.custom.theme, 'dark')
  } finally { view.dispose() }
})

test('failed appearance recovery releases the settings editor without replaying the discarded theme', async () => {
  const fixture = await queuedSettingsFixture()
  const view = loadSettingsView(fixture.store)
  try {
    view.localSettings.custom.theme = 'light'
    view.localSettings.custom.playerStyle = 'netease'
    await vue.nextTick()
    const release = await view.prepareThemeRecovery('dark')
    const restoring = fixture.store.updateSettings({ custom: { theme: 'dark' } })
    const rejection = assert.rejects(restoring, /Disk full/)
    await fixture.flush()
    fixture.requests[0].reject(new Error('Disk full'))
    await rejection
    await release()
    assert.equal(view.localSettings.custom.theme, 'dark')
    assert.equal(view.localSettings.custom.playerStyle, 'netease')
    const savingOthers = view.flushEditableSettings()
    await fixture.flush()
    assert.equal(fixture.requests[1].payload.custom.theme, 'dark', 'rollback cannot resurrect the old theme draft in a later save')
    assert.equal(fixture.requests[1].payload.custom.playerStyle, 'netease')
    fixture.commit(1)
    assert.equal(await savingOthers, true)
    assert.equal(fixture.store.settings.custom.theme, 'dark')
  } finally { view.dispose() }
})

test('leaving settings flushes pending edits', async () => {
  const storeModule = loadStore()
  await storeModule.initSettings()
  const store = storeModule.useSettingsStore()
  const view = loadSettingsView(store)
  view.localSettings.software.defaultPage = 'favorites'
  view.dispose()
  await vue.nextTick()
  assert.equal(store.settings.software.defaultPage, 'favorites')
})

test('focused controls retain native Space activation while page shortcuts still work', async () => {
  const app = loadApp()
  let toggles = 0
  let prevented = 0
  app.musicPlayerRef.value = { togglePlay: () => toggles++ }
  app.settings.shortcuts.keys = { playPause: 'Space' }
  const event = target => ({ key: ' ', target, preventDefault: () => prevented++, stopPropagation() {} })
  try {
    app.handleKeyDown(event({ tagName: 'BUTTON', closest: () => ({ tagName: 'BUTTON' }) }))
    assert.equal(toggles, 0)
    assert.equal(prevented, 0)
    app.handleKeyDown(event({ tagName: 'BODY', closest: () => null }))
    assert.equal(toggles, 1)
    assert.equal(prevented, 1)
  } finally {
    await app.dispose()
  }
})

test('corrupt and non-object authentication caches fall back safely', () => {
  const storage = new Map()
  const logs = []
  const auth = loadModule('src/api/auth.js', {
    axios: { create: () => ({ interceptors: { request: { use() {} }, response: { use() {} } } }) },
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: key => storage.delete(key)
    },
    logger: { ...quietLogger, warn: (...args) => logs.push(args) }
  }, ['getLoginInfo', 'isLoggedIn', 'saveLoginInfo'])
  for (const raw of ['broken-private-value', 'null', '[]', '123']) {
    storage.set('kugou_token', 'secret-token')
    storage.set('kugou_userinfo', raw)
    storage.set('kugou_vip_type', '1')
    assert.equal(auth.getLoginInfo(), null)
    assert.equal(auth.isLoggedIn(), false)
    assert.equal(storage.has('kugou_vip_type'), false)
  }
  auth.saveLoginInfo({ token: 'valid-token', userid: 123, username: 'example' })
  assert.equal(auth.isLoggedIn(), true)
  assert.equal(auth.getLoginInfo().userInfo.userid, 123)
  assert.equal(JSON.stringify(logs).includes('private-value'), false)
  assert.equal(JSON.stringify(logs).includes('secret-token'), false)
})

test('out-of-order search responses and errors cannot replace newer results', async () => {
  const pending = []
  const component = fs.readFileSync(path.join(root, 'src/views/SearchView.vue'), 'utf8')
  const script = stripImports(component.match(/<script>([\s\S]*?)<\/script>/)[1])
    .replace('export default', 'module.exports =')
  const sandbox = vm.createContext({
    module: { exports: {} },
    console: quietConsole,
    logger: quietLogger,
    ContextMenu: {},
    ArtworkCover: {},
    SongBadges: {},
    nextplayIcon: '',
    searchMusic: () => {
      const request = deferred()
      pending.push(request)
      return request.promise
    }
  })
  vm.runInContext(script, sandbox)
  const options = sandbox.module.exports
  const view = options.data()
  view.searchKeyword = 'new'
  const oldSearch = options.methods.performSearch.call(view, 'old')
  const newSearch = options.methods.performSearch.call(view, 'new')
  pending[1].resolve({ status: 1, data: { lists: [{ hash: 'new' }] } })
  await newSearch
  pending[0].resolve({ status: 1, data: { lists: [{ hash: 'old' }] } })
  await oldSearch
  assert.equal(view.searchResults.lists[0].hash, 'new')
  assert.equal(view.loading, false)

  const failingOldSearch = options.methods.performSearch.call(view, 'old-error')
  const newerSearch = options.methods.performSearch.call(view, 'newer')
  pending[2].reject(new Error('old request failed'))
  await failingOldSearch
  assert.equal(view.loading, true)
  assert.equal(view.searchResults.lists[0].hash, 'new')
  pending[3].resolve({ status: 1, data: { lists: [{ hash: 'newer' }] } })
  await newerSearch

  const afterUnmount = options.methods.performSearch.call(view, 'later')
  options.beforeUnmount.call(view)
  pending[4].resolve({ status: 1, data: { lists: [{ hash: 'later' }] } })
  await afterUnmount
  assert.equal(view.searchResults.lists[0].hash, 'newer')
})

test('global shortcut registration uses resolved results and handles rejection', async () => {
  const app = loadApp({
    registerGlobalShortcut: async key => {
      if (key === 'B') throw new Error('unavailable')
      return key === 'C'
    },
    unregisterGlobalShortcut: async () => true
  })
  app.settings.shortcuts.keys = { playPause: 'A', nextTrack: 'B', prevTrack: 'C' }
  await app.registerGlobalShortcuts()
  assert.deepEqual([...app.registeredGlobalShortcuts.value], ['C'])
  await app.dispose()
  assert.equal(app.registeredGlobalShortcuts.value.size, 0)
})

test('disabling shortcuts during an in-flight registration removes the stale key', async () => {
  const registration = deferred()
  const unregistered = []
  const app = loadApp({
    registerGlobalShortcut: () => registration.promise,
    unregisterGlobalShortcut: async key => { unregistered.push(key); return true }
  })
  app.settings.shortcuts.keys = { playPause: 'A' }
  const first = app.registerGlobalShortcuts()
  await Promise.resolve()
  await Promise.resolve()
  app.settings.shortcuts.enableGlobal = false
  const second = app.registerGlobalShortcuts()
  registration.resolve(true)
  await first
  await second
  assert.deepEqual(unregistered, ['A'])
  assert.equal(app.registeredGlobalShortcuts.value.size, 0)
  await app.dispose()
})

test('root unmount releases IPC listeners and paused audio remains resumable', async () => {
  const released = []
  const app = loadApp({
    onGlobalShortcut: () => () => released.push('shortcut'),
    onMemoryCleanup: () => () => released.push('memory')
  })
  app.mount()
  const audio = { paused: true, src: 'song-url', currentTime: 42, load() { throw new Error('must retain audio') } }
  app.musicPlayerRef.value = { $refs: { audioPlayer: audio } }
  app.performMemoryCleanup()
  assert.equal(audio.src, 'song-url')
  assert.equal(audio.currentTime, 42)
  await app.dispose()
  assert.deepEqual(released, ['shortcut', 'memory'])
})

test('queue updates align current index and clearing cannot erase a newly selected song', async () => {
  const app = loadApp()
  app.currentSong.value = { hash: 'current' }
  app.handlePlaylistUpdated([{ hash: 'other' }, { hash: 'current' }])
  assert.equal(app.playlistIndex.value, 1)
  app.handlePlaylistUpdated([])
  assert.equal(app.currentSong.value, null)
  app.handleClearPlaylist()
  app.currentSong.value = { hash: 'new' }
  await vue.nextTick()
  assert.equal(app.currentSong.value.hash, 'new')
  await app.dispose()
})

test('playlist directory requests are shared and late account results cannot replace the new directory', async () => {
  const values = new Map([['kugou_token', 'token-a'], ['kugou_userid', 'A']])
  const requests = []
  const app = loadApp({}, {
    localStorage: { getItem: key => values.get(key) ?? null },
    getUserPlaylists: () => { const task = deferred(); requests.push(task); return task.promise }
  })
  app.userLoggedIn.value = true
  const first = app.fetchUserPlaylists()
  assert.equal(app.fetchUserPlaylists(), first)
  await vue.nextTick()
  assert.equal(requests.length, 1)
  values.set('kugou_token', 'token-b')
  values.set('kugou_userid', 'B')
  app.handleLoginSuccess({ userid: 'B' })
  const second = app.fetchUserPlaylists()
  await vue.nextTick()
  assert.equal(requests.length, 2)
  requests[1].resolve({ status: 1, data: { lists: [{ globalCollectionId: 'b-list', name: 'B' }] } })
  await second
  requests[0].resolve({ status: 1, data: { info: [{ global_collection_id: 'a-list', name: 'A' }] } })
  await first
  assert.equal(app.userPlaylists.value[0].id, 'b-list')
  assert.equal(app.userPlaylistsLoaded.value, true)
  await app.dispose()
})

test('opening login preserves cached page identity while actual login and logout invalidate it', async () => {
  const app = loadApp()
  const guestKey = app.pageSessionKey.value
  app.handleShowLogin()
  assert.equal(app.pageSessionKey.value, guestKey)
  app.handleLoginSuccess({ userid: 'A' })
  const accountKey = app.pageSessionKey.value
  assert.notEqual(accountKey, guestKey)
  app.handleNavigate('playlist', { id: 'one', name: 'One' })
  assert.equal(app.selectedPlaylistId.value, 'one')
  app.handleNavigate('playlist', { id: 'two', name: 'Two' })
  assert.equal(app.selectedPlaylistId.value, 'two')
  app.handleLogout()
  assert.notEqual(app.pageSessionKey.value, accountKey)
  assert.equal(app.selectedPlaylistId.value, null)
  assert.equal(app.userPlaylists.value.length, 0)
  await app.dispose()
})

test('an expired response from a previous account does not log out the current account', async () => {
  const values = new Map([['kugou_token', 'token-a'], ['kugou_userid', 'A']])
  let requestHandler
  let successHandler
  let failureHandler
  let expirations = 0
  loadModule('src/api/music.js', {
    axios: { create: () => ({ interceptors: {
      request: { use: handler => { requestHandler = handler } },
      response: { use: (success, failure) => { successHandler = success; failureHandler = failure } }
    } }) },
    localStorage: { getItem: key => values.get(key) ?? null },
    window: { dispatchEvent: () => expirations++ },
    CustomEvent: class { constructor(type) { this.type = type } }
  }, [])
  const oldConfig = requestHandler({ params: {} })
  values.set('kugou_token', 'token-b')
  values.set('kugou_userid', 'B')
  await assert.rejects(successHandler({ data: { error_code: 20017 }, config: oldConfig }), { code: 'KUGOU_AUTH_EXPIRED' })
  await assert.rejects(failureHandler({ response: { data: { error_code: 20017 } }, config: oldConfig }), { code: 'KUGOU_AUTH_EXPIRED' })
  assert.equal(expirations, 0)
  const currentConfig = requestHandler({ params: {} })
  await assert.rejects(successHandler({ data: { error_code: 20017 }, config: currentConfig }), { code: 'KUGOU_AUTH_EXPIRED' })
  assert.equal(expirations, 1)
})
