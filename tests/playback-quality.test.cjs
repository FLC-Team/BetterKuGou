const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const vue = require('vue')

const root = path.join(__dirname, '..')
const quietLogger = { trace() {}, info() {}, warn() {}, error() {} }

function loadModule(file, globals, names) {
  const source = fs.readFileSync(path.join(root, file), 'utf8')
    .replace(/^import[^\n]*\n/gm, '')
    .replace(/^export \{.*\}\s*$/gm, '')
    .replace(/\bexport (?=(?:async )?function|const)/g, '')
  return vm.runInNewContext(`${source}\n;({ ${names.join(', ')} })`, globals)
}

test('normal quality choices match the local song URL protocol and exclude magic audio', async () => {
  const catalog = loadModule('src/utils/playbackQuality.js', {}, ['PLAYBACK_QUALITY_OPTIONS', 'normalizePlaybackQuality'])
  const supported = Array.from(catalog.PLAYBACK_QUALITY_OPTIONS, option => option.value)
  assert.deepEqual(supported, ['128', '320', 'flac', 'high'])
  const songUrl = require('../KuGouMusicApi/module/song_url.js')
  for (const quality of supported) {
    let upstream
    await songUrl({ hash: 'A', quality }, async config => { upstream = config })
    assert.equal(upstream.params.quality, quality)
    assert.equal(upstream.params.IsFreePart, 0)
    assert.equal(catalog.normalizePlaybackQuality(quality), quality)
  }
  for (const invalid of ['magic_piano', 'viper_clear', 'auto', '', null, 320, {}, []]) {
    assert.equal(catalog.normalizePlaybackQuality(invalid), '128')
  }
})

test('music API forwards each requested quality without changing the old endpoint or requesting previews', async () => {
  const requests = []
  const client = {
    interceptors: { request: { use() {} }, response: { use() {} } },
    get: async url => { requests.push(new URL(url, 'http://localhost:6500')); return { status: 1 } }
  }
  const { getSongUrl } = loadModule('src/api/music.js', {
    axios: { create: () => client }, logger: quietLogger, URLSearchParams,
    localStorage: { getItem: () => null }
  }, ['getSongUrl'])
  for (const quality of ['128', '320', 'flac', 'high']) {
    await getSongUrl('track', 12, 34, quality)
    assert.equal(requests.at(-1).pathname, '/song/url')
    assert.equal(requests.at(-1).searchParams.get('quality'), quality)
    assert.equal(requests.at(-1).searchParams.get('album_id'), '12')
    assert.equal(requests.at(-1).searchParams.get('album_audio_id'), '34')
    assert.equal(requests.at(-1).searchParams.has('free_part'), false)
  }
  await getSongUrl('track')
  assert.equal(requests.at(-1).searchParams.get('quality'), '128')
  await getSongUrl('track', 0, 0, 'viper_clear')
  assert.equal(requests.at(-1).searchParams.get('quality'), '128')
})

test('actual quality uses response metadata and never infers lossless from a requested preference', () => {
  const { readPlaybackQuality } = loadModule('src/utils/playbackQuality.js', {}, ['readPlaybackQuality'])
  assert.equal(readPlaybackQuality({ extname: 'flac', bitrate: 952000 }).label, '无损 FLAC')
  assert.equal(readPlaybackQuality({ extname: 'MP3', bitrate: '320000' }).label, '320 kbps')
  assert.equal(readPlaybackQuality({ extname: 'mp3', bitrate: 128 }).label, '128 kbps')
  assert.equal(readPlaybackQuality({ quality: 'flac', url: 'https://example.test/audio.flac' }).confirmed, false)
  assert.equal(readPlaybackQuality({ quality: 'flac', url: 'https://example.test/audio.flac' }).label, '待确认')
  assert.equal(readPlaybackQuality({ bitrate: 'unknown' }).label, '待确认')
})

test('renderer quality preferences default old settings and normalize imported unsupported values', async () => {
  const utils = loadModule('src/utils/objectUtils.js', { ...vue, structuredClone }, ['cloneDeep', 'mergeDeep', 'replaceReactive'])
  const { initSettings, useSettingsStore } = loadModule('src/stores/settingsStore.js', {
    ...vue, ...utils, logger: quietLogger, applyTheme() {},
    window: {}, localStorage: { getItem: () => JSON.stringify({ schemaVersion: 1 }), setItem() {} }
  }, ['initSettings', 'useSettingsStore'])
  await initSettings()
  const store = useSettingsStore()
  assert.equal(store.settings.playback.quality, '128')
  for (const quality of ['128', '320', 'flac', 'high']) {
    await store.overwriteSettings({ schemaVersion: 1, playback: { quality } })
    assert.equal(store.settings.playback.quality, quality)
  }
  for (const quality of [320, 'viper_tape', null, false, {}, []]) {
    await store.overwriteSettings({ schemaVersion: 1, playback: { quality } })
    assert.equal(store.settings.playback.quality, '128')
  }
})

test('Electron schema saves the same four ordinary qualities and rejects malformed imported values', async () => {
  const files = new Map()
  const settingsPath = path.join('/quality-test-data', 'settings.json')
  files.set(settingsPath, '{}')
  const fileSystem = {
    async readFile(file) { return files.get(file) },
    async writeFile(file, data) { files.set(file, data) },
    async rename(from, to) { files.set(to, files.get(from)); files.delete(from) },
    async unlink(file) { files.delete(file) }
  }
  const sandbox = {
    module: { exports: {} }, process, structuredClone,
    require(name) {
      if (name === 'fs') return { promises: fileSystem }
      if (name === './logger') return quietLogger
      if (name === './autoLaunch') return { isAutoLaunchSupported: () => false }
      return require(name)
    }
  }
  vm.runInNewContext(fs.readFileSync(path.join(root, 'electron/settingsStore.js'), 'utf8'), sandbox)
  const store = sandbox.module.exports
  await store.initSettingsStore({ getPath: key => key === 'userData' ? '/quality-test-data' : '/downloads' })
  assert.equal(store.getSettings().playback.quality, '128')
  for (const quality of ['128', '320', 'flac', 'high']) {
    await store.setSettings({ playback: { quality } })
    assert.equal(store.getSettings().playback.quality, quality)
    assert.equal(JSON.parse(files.get(settingsPath)).playback.quality, quality)
  }
  for (const quality of ['magic_piano', 320, null, false, {}, []]) {
    await store.overwriteSettings({ playback: { quality } })
    assert.equal(store.getSettings().playback.quality, '128')
  }
})
