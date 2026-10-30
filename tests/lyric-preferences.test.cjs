const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const vue = require('vue')
const axios = require('axios')

const root = path.resolve(__dirname, '..')
const plain = value => JSON.parse(JSON.stringify(value))
const quiet = { trace() {}, info() {}, warn() {}, error() {} }
const defaults = {
  lyricLibrary: { enabled: true, autoSave: true, minMatch: 'high', autoUpdate: true },
  romanization: 'off', preferSimplifiedChinese: true, segmentLyrics: false, showProfanity: false
}
const preferences = settings => plain(Object.fromEntries(Object.keys(defaults).map(key => [key, settings.playback[key]])))

/** Load production modules while replacing only their platform boundaries. */
function loadModule(file, globals, exports) {
  const source = fs.readFileSync(path.join(root, file), 'utf8')
    .replace(/^import\b[\s\S]*?from\s+['"][^'"]+['"]\s*;?\s*$/gm, '')
    .replace(/^export default .*$/gm, '')
    .replace(/^export \{.*\}\s*$/gm, '')
    .replace(/\bexport (?=(?:async )?function|const|class)/g, '')
  return vm.runInNewContext(`${source}\n;({ ${exports.join(', ')} })`, { console, logger: quiet, ...globals })
}

async function loadMainStore(initial = {}) {
  const filename = path.join('/user-data', 'settings.json')
  const files = new Map([[filename, JSON.stringify(initial)]])
  const disk = {
    async readFile(file) { if (!files.has(file)) throw Object.assign(new Error('Missing file'), { code: 'ENOENT' }); return files.get(file) },
    async writeFile(file, data) { files.set(file, data) },
    async rename(from, to) { files.set(to, files.get(from)); files.delete(from) },
    async unlink(file) { files.delete(file) }, async mkdir() {}
  }
  const sandbox = {
    module: { exports: {} }, process, structuredClone,
    require(name) {
      if (name === 'fs') return { promises: disk }
      if (name === './logger') return quiet
      if (name === './autoLaunch') return { isAutoLaunchSupported: () => false }
      return require(name)
    }
  }
  vm.runInNewContext(fs.readFileSync(path.join(root, 'electron/settingsStore.js'), 'utf8'), sandbox)
  const store = sandbox.module.exports
  await store.initSettingsStore({ getPath: name => name === 'userData' ? '/user-data' : '/downloads' })
  return { store, files, filename }
}

function loadRendererStore(bridge) {
  const utilities = loadModule('src/utils/objectUtils.js', { ...vue, structuredClone }, ['cloneDeep', 'mergeDeep', 'replaceReactive'])
  const loaded = loadModule('src/stores/settingsStore.js', {
    ...vue, ...utilities, window: { settingsAPI: bridge }, localStorage: { getItem: () => null, setItem() {} }, applyTheme() {}
  }, ['initSettings', 'useSettingsStore', 'migrateSettings', 'baseDefaultSettings'])
  return { ...loaded, store: loaded.useSettingsStore() }
}

test('renderer and main lyric defaults match and supplement partial legacy settings without losing false preferences', async () => {
  const main = await loadMainStore()
  const renderer = loadRendererStore({ get: async () => ({ schemaVersion: 1 }) })
  await renderer.initSettings()
  assert.deepEqual(preferences(main.store.getDefaultSettings()), defaults)
  assert.deepEqual(preferences(renderer.store.defaults()), defaults)
  assert.deepEqual(preferences(main.store.getSettings()), defaults)
  assert.deepEqual(preferences(renderer.store.settings), defaults)
  const disabled = {
    lyricLibrary: { enabled: false, autoSave: false, autoUpdate: false, minMatch: 'any' },
    romanization: 'on', preferSimplifiedChinese: false, segmentLyrics: true, showProfanity: true
  }
  await main.store.overwriteSettings({ playback: disabled })
  const migrated = renderer.migrateSettings({ schemaVersion: 0, playback: disabled }, renderer.baseDefaultSettings)
  assert.deepEqual(preferences(main.store.getSettings()), disabled)
  assert.deepEqual(preferences(migrated), disabled)
  await main.store.setSettings({ playback: { lyricLibrary: { minMatch: 'medium' } } })
  assert.deepEqual(preferences(main.store.getSettings()), { ...disabled, lyricLibrary: { ...disabled.lyricLibrary, minMatch: 'medium' } })
  for (const minMatch of ['exact', 'high', 'medium', 'any']) {
    await main.store.overwriteSettings({ playback: { lyricLibrary: { minMatch } } })
    assert.equal(main.store.getSettings().playback.lyricLibrary.minMatch, minMatch)
    assert.equal(renderer.migrateSettings({ playback: { lyricLibrary: { minMatch } } }, renderer.baseDefaultSettings).playback.lyricLibrary.minMatch, minMatch)
  }
})

test('both schemas reject invalid lyric option types and discard unknown library capabilities on real import', async () => {
  const main = await loadMainStore()
  const renderer = loadRendererStore({
    get: async () => main.store.getSettings(), getDefaults: async () => main.store.getDefaultSettings(),
    set: patch => main.store.setSettings(patch), import: async () => ({ settings: await main.store.importSettings('/import.json') })
  })
  await renderer.initSettings()
  const malformed = {
    lyricLibrary: { enabled: 'false', autoSave: 0, autoUpdate: null, minMatch: 'maximum', directory: '/untrusted', deleteAll: true },
    romanization: true, preferSimplifiedChinese: 0, segmentLyrics: 'false', showProfanity: 1
  }
  for (const playback of [undefined, null, [], false, 'invalid', { lyricLibrary: null }, { lyricLibrary: [] }, malformed]) {
    const raw = playback === undefined ? {} : { playback }
    await main.store.overwriteSettings(raw)
    assert.deepEqual(preferences(main.store.getSettings()), defaults)
    assert.deepEqual(preferences(renderer.migrateSettings(raw, renderer.baseDefaultSettings)), defaults)
  }
  main.files.set('/import.json', JSON.stringify({ playback: malformed }))
  const result = await renderer.store.importSettings()
  assert.equal(result.canceled, undefined)
  assert.deepEqual(preferences(renderer.store.settings), defaults)
  assert.deepEqual(preferences(main.store.getSettings()), defaults)
  assert.deepEqual(Object.keys(JSON.parse(main.files.get(main.filename)).playback.lyricLibrary).sort(), ['autoSave', 'autoUpdate', 'enabled', 'minMatch'])
})

function loadMusic() {
  const metadata = loadModule('src/utils/songMetadata.js', {}, ['getSongArtists', 'getSongSearchKeyword'])
  const errors = []
  const api = loadModule('src/api/music.js', {
    ...metadata, axios, URLSearchParams, localStorage: { getItem: () => null },
    logger: { ...quiet, error: (...args) => errors.push(args) }
  }, ['apiClient', 'getLyricMatchLevel', 'getLyric', 'searchLyric', 'getLyricDetail'])
  return { ...api, errors }
}

test('lyric matching uses actual song metadata aliases, Unicode normalization and explicit identity evidence', () => {
  const { getLyricMatchLevel: match } = loadMusic()
  assert.equal(match({ hash: 'ABC123', song: 'Wrong title' }, { hash: 'abc123' }), 'exact')
  assert.equal(match({ album_audio_id: '123', song: 'Title' }, { album_audio_id: 123 }), 'exact')
  assert.equal(match({ album_audio_id: 0 }, { album_audio_id: 0 }), 'any')
  const candidate = { song: 'My Song (Live)', singer: 'Artist' }
  for (const song of [
    { audio_name: 'My Song (Live)', singerinfo: [{ name: 'Artist', id: 1 }] },
    { songname: 'My Song (Live)', singername: 'Artist' },
    { FileName: 'Artist - My Song (Live).flac', SingerName: 'Artist' },
    { title: 'Ｍｙ　Ｓｏｎｇ (Live)', author_name: 'Ａｒｔｉｓｔ' }
  ]) assert.equal(match(candidate, song), 'high')
  assert.equal(match({ song: 'My Song (Live)', singer: 'Unknown artist' }, { name: 'My Song (Live)', singername: 'Artist' }), 'medium')
  assert.equal(match({ song: 'My Song', singer: 'Artist' }, { songname: 'My Song (Live)', singername: 'Artist' }), 'any')
  assert.equal(match({ song: 'Duet', singer: 'Alice、Bob' }, { songname: 'Duet', singerinfo: [{ name: 'Alice' }, { name: 'Bob' }] }), 'high')
  assert.equal(match({ score: 100, song: 'Other', singer: 'Other' }, { songname: 'Song', singername: 'Artist' }), 'any')
})

test('complete lyric lookup selects the strongest valid candidate, preserves source identity and excludes its access key', async () => {
  const api = loadMusic(), calls = []
  const candidates = [
    { id: 'unknown', accesskey: 'placeholder-unknown', song: 'Unrelated', singer: 'Other' },
    { id: 'high', accesskey: 'placeholder-high', song: 'Song', singer: 'Artist' },
    { id: 'invalid-exact', hash: 'ABC' },
    { id: 7, accesskey: 'placeholder-exact', hash: 'abc' },
    { id: 'later-exact', accesskey: 'placeholder-later', hash: 'ABC' }
  ]
  api.apiClient.defaults.adapter = async config => {
    calls.push(config)
    const data = config.url === '/search/lyric' ? { candidates } : { status: 200, decodeContent: '[00:01]Raw words', language: 'raw-language' }
    return { data, status: 200, statusText: 'OK', headers: {}, config }
  }
  const controller = new AbortController()
  const result = await api.getLyric('ABC', 99, 'keyword', { song: { audio_name: 'Song', singerinfo: [{ name: 'Artist' }] }, signal: controller.signal })
  assert.equal(calls.length, 2)
  assert.equal(calls[0].params.hash, 'ABC')
  assert.equal(calls[0].params.album_audio_id, 99)
  assert.equal(calls[0].params.keywords, 'keyword')
  assert.equal(calls[1].params.id, 7)
  assert.equal(calls[1].params.accesskey, 'placeholder-exact')
  assert.equal(calls[1].params.fmt, 'krc')
  assert.equal(calls[1].params.decode, true)
  assert.ok(calls.every(call => call.signal === controller.signal))
  assert.deepEqual(plain(result.lyricSource), { id: '7', matchLevel: 'exact' })
  assert.equal(result.decodeContent, '[00:01]Raw words')
  assert.equal(result.language, 'raw-language')
  assert.doesNotMatch(JSON.stringify(result.lyricSource), /accesskey|placeholder-/)
  assert.equal(candidates[0].id, 'unknown', 'ranking must not mutate the original provider result')
})

test('lyric cancellation stops search or detail through the actual Axios signal without logging an ordinary failure', async () => {
  for (const stage of ['/search/lyric', '/lyric']) {
    const api = loadMusic(), calls = [], controller = new AbortController()
    let started
    const ready = new Promise(resolve => { started = resolve })
    api.apiClient.defaults.adapter = config => {
      calls.push(config)
      if (config.url !== stage) return Promise.resolve({ data: { candidates: [{ id: 1, accesskey: 'placeholder-key', hash: 'track' }] }, status: 200, statusText: 'OK', headers: {}, config })
      started()
      return new Promise((resolve, reject) => {
        config.signal.addEventListener('abort', () => reject(new axios.CanceledError('cancelled')), { once: true })
      })
    }
    const canceled = assert.rejects(api.getLyric('track', 0, '', { signal: controller.signal }), { code: 'ERR_CANCELED' })
    await ready
    controller.abort()
    await canceled
    assert.equal(calls.at(-1).url, stage)
    assert.equal(api.errors.length, 0)
    assert.ok(calls.every(call => call.signal === controller.signal))
  }
})

test('lookup rejects empty and unusable candidates without requesting a detail and preserves ordinary failure diagnostics', async () => {
  for (const candidates of [[], [{ id: 'missing-key' }]]) {
    const api = loadMusic(), calls = []
    api.apiClient.defaults.adapter = async config => { calls.push(config); return { data: { candidates }, status: 200, statusText: 'OK', headers: {}, config } }
    await assert.rejects(api.getLyric('track'), /未找到歌词|访问密钥无效/)
    assert.equal(calls.length, 1)
    assert.equal(api.errors.length, 1)
  }
})
