const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const http = require('node:http')
const axios = require('axios')
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

test('song detail and URL pass optional abort signals through the Axios adapter and retain legacy arguments', async () => {
  const requests = []
  const { apiClient, getSongDetail, getSongUrl } = loadModule('src/api/music.js', {
    axios, logger: quietLogger, URLSearchParams, localStorage: { getItem: () => null }
  }, ['apiClient', 'getSongDetail', 'getSongUrl'])
  apiClient.defaults.adapter = async config => {
    requests.push(config)
    return { data: { status: 1 }, status: 200, statusText: 'OK', headers: {}, config }
  }
  await getSongDetail('legacy')
  assert.equal(requests.at(-1).url, '/audio')
  assert.equal(requests.at(-1).params.hash, 'legacy')
  assert.equal(requests.at(-1).signal, undefined)
  await getSongUrl('legacy')
  assert.equal(requests.at(-1).signal, undefined)
  const legacyUrl = new URL(requests.at(-1).url, 'http://localhost:6500')
  assert.equal(legacyUrl.pathname, '/song/url')
  assert.equal(legacyUrl.searchParams.get('quality'), '128')
  assert.equal(legacyUrl.searchParams.get('album_id'), '0')
  assert.equal(legacyUrl.searchParams.get('album_audio_id'), '0')

  const controller = new AbortController()
  await getSongDetail('selected', { signal: controller.signal })
  assert.equal(requests.at(-1).signal, controller.signal)
  assert.equal(requests.at(-1).params.hash, 'selected')
  await getSongUrl('selected', 12, 34, 'flac', { signal: controller.signal })
  assert.equal(requests.at(-1).signal, controller.signal)
  const selectedUrl = new URL(requests.at(-1).url, 'http://localhost:6500')
  assert.equal(selectedUrl.searchParams.get('hash'), 'selected')
  assert.equal(selectedUrl.searchParams.get('album_id'), '12')
  assert.equal(selectedUrl.searchParams.get('album_audio_id'), '34')
  assert.equal(selectedUrl.searchParams.get('quality'), 'flac')
  assert.equal(selectedUrl.searchParams.has('signal'), false)
})

test('cancelled song HTTP requests close promptly without error logs and later requests still succeed', { timeout: 5000 }, async t => {
  const errors = []
  let notifyRequest
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost')
    if (url.searchParams.get('hash') === 'waiting') {
      const closed = new Promise(resolve => response.once('close', resolve))
      notifyRequest({ closed, response })
      return
    }
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ status: 1 }))
  })
  t.after(async () => {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { apiClient, getSongDetail, getSongUrl } = loadModule('src/api/music.js', {
    axios, logger: { ...quietLogger, error: (...args) => errors.push(args) }, URLSearchParams,
    localStorage: { getItem: () => null }
  }, ['apiClient', 'getSongDetail', 'getSongUrl'])
  apiClient.defaults.baseURL = `http://127.0.0.1:${server.address().port}`
  apiClient.defaults.proxy = false
  for (const load of [
    signal => getSongDetail('waiting', { signal }),
    signal => getSongUrl('waiting', 0, 0, '128', { signal })
  ]) {
    const controller = new AbortController()
    const started = new Promise(resolve => { notifyRequest = resolve })
    const canceled = assert.rejects(load(controller.signal), { code: 'ERR_CANCELED' })
    const { closed, response } = await started
    controller.abort()
    await canceled
    await closed
    assert.equal(response.destroyed, true, 'cancellation must release the HTTP response connection')
    assert.equal(errors.length, 0)
  }
  assert.equal((await getSongDetail('next')).status, 1)
  assert.equal((await getSongUrl('next')).status, 1)

  const failure = new Error('ordinary request failure')
  apiClient.defaults.adapter = async () => { throw failure }
  await assert.rejects(getSongDetail('broken'), error => error === failure)
  assert.equal(errors.length, 1, 'ordinary failures still retain error diagnostics')
  assert.equal(errors[0].at(-1), failure)
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
