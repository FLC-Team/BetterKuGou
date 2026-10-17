const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const http = require('node:http')
const crypto = require('node:crypto')
const { createCacheEngine, allowedArtworkUrl, privateAddress, detectFormat, isPreview, normalizeHash } = require('../electron/services/playlistCacheWorker.cjs')

function wav(size = 4096) {
  const buffer = Buffer.alloc(size)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(size - 8, 4)
  buffer.write('WAVEfmt ', 8)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(8000, 24)
  buffer.writeUInt32LE(16000, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(size - 44, 40)
  return buffer
}

async function until(callback, message = 'cache condition', timeout = 4000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await callback()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 15))
  }
  assert.fail(`Timed out waiting for ${message}`)
}

async function fixture(t, options = {}) {
  const toolsRoot = path.join(__dirname, '../.agent/tools')
  await fs.mkdir(toolsRoot, { recursive: true })
  const directory = await fs.mkdtemp(path.join(toolsRoot, 'bk-playlist-cache-'))
  const calls = []
  const responses = new Map()
  const pending = new Set()
  const audio = wav(options.audioSize || 4096)
  let origin
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, origin)
    calls.push({ path: url.pathname, query: Object.fromEntries(url.searchParams) })
    const hash = url.searchParams.get('hash')
    const responseOverride = responses.get(`${url.pathname}:${hash}`) || responses.get(url.pathname)
    if (responseOverride) { responseOverride(request, response, url); return }
    if (url.pathname === '/audio') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ status: 1, data: [{ hash, album_id: 3, album_audio_id: 8, token: 'never-persist-detail-token' }] })); return }
    if (url.pathname === '/song/url') { response.end(JSON.stringify({ status: 1, url: [`${origin}/file?hash=${hash}`], extname: 'wav', bitrate: 128000, filesize: audio.length })); return }
    if (url.pathname === '/file') { response.setHeader('Content-Length', audio.length); response.end(audio); return }
    if (url.pathname === '/cover') { const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(100)]); response.setHeader('Content-Length', png.length); response.end(png); return }
    response.writeHead(404); response.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${server.address().port}`
  const states = []
  const auth = []
  let engine = createCacheEngine({ cacheRoot: directory, apiBase: origin, allowLocalTestUrls: true, limitBytesOverride: options.limitBytes, retryBaseDelayMs: options.retryBaseDelayMs, onState: value => states.push(value), onAuthExpired: value => auth.push(value) })
  await engine.ready
  let generation = 1
  await engine.dispatch('setSession', { userId: 'account-a', token: 'placeholder-private-token' }, generation)
  const send = (action, payload) => engine.dispatch(action, payload, generation)
  t.after(async () => {
    if (t.passed === false) t.diagnostic(JSON.stringify({ paths: calls.map(call => call.path), state: engine.snapshot() }))
    await engine.stop()
    for (const response of pending) response.destroy()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await fs.rm(directory, { recursive: true, force: true })
  })
  return {
    directory, calls, responses, audio, origin, states, auth, pending, send,
    engine: () => engine,
    async login(userId, token = 'placeholder-private-token') { generation++; return engine.dispatch('setSession', userId ? { userId, token } : null, generation) },
    async playlist(id = 'favorite-id', hashes = ['song-a'], isFavorite = true) { return send('putPlaylist', { id, name: isFavorite ? '我喜欢' : id, isFavorite, songs: hashes.map(hash => ({ hash, name: hash })) }) },
    async play(hash = 'song-a', quality = '128') { return send('cacheSong', { song: { hash, name: hash }, quality }) },
    async complete(hash = 'song-a', quality = '128') {
      return until(async () => {
        const source = await send('getSource', { hash, quality })
        if (source) { await send('releaseSource', { leaseId: source.leaseId }); return source }
      }, `completed ${hash}`)
    },
    async restart() {
      await engine.stop()
      engine = createCacheEngine({ cacheRoot: directory, apiBase: origin, allowLocalTestUrls: true, limitBytesOverride: options.limitBytes, retryBaseDelayMs: options.retryBaseDelayMs, onState: value => states.push(value), onAuthExpired: value => auth.push(value) })
      await engine.ready
      return engine.dispatch('setSession', { userId: 'account-a', token: 'placeholder-private-token' }, ++generation)
    }
  }
}

test('playlist snapshots persist all rows but only a first real playback queues audio, with favorites alias and cross-entry deduplication', async t => {
  const f = await fixture(t)
  await f.playlist('favorite-id', Array.from({ length: 925 }, (_, index) => `song-${index}`))
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(f.calls.length, 0, 'opening a large playlist never starts audio or lyric downloads')
  assert.equal((await f.send('readPlaylist', { id: null })).songs.length, 925)
  assert.equal((await f.send('readPlaylist', { id: null })).id, 'favorite-id')
  await f.playlist('favorite-id', ['song-a', 'song-b'], false)
  assert.equal(f.engine().snapshot().playlists.length, 1)
  assert.equal(f.engine().snapshot().playlists[0].isFavorite, true)
  await Promise.all([f.play(), f.play()])
  const source = await f.complete()
  assert.equal(source.sha256, undefined)
  assert.equal(source.requestedQuality, '128')
  assert.equal(source.bitrate, 128000)
  assert.equal(source.detail.album_audio_id, 8)
  assert.equal(f.calls.filter(call => call.path === '/song/url').length, 1)
  assert.equal(f.calls.find(call => call.path === '/song/url').query.free_part, undefined)
  assert.match(f.calls.find(call => call.path === '/song/url').query.cookie, /placeholder-private-token/)
  assert.equal(f.engine().snapshot().playlists[0].cached, 1)
  assert.deepEqual(f.engine().snapshot().playlists[0].hashes, ['song-a'])
  await f.restart()
  assert.equal((await f.send('readPlaylist', { id: null })).songs.length, 2)
  assert.ok(await f.send('getSource', { hash: 'song-a', quality: '128' }))
})

test('keeps favorites plus ten latest ordinary playlists and preserves whole local edits', async t => {
  const f = await fixture(t)
  await f.playlist()
  for (let i = 0; i < 12; i++) await f.playlist(`list-${i}`, [`hash-${i}`], false)
  assert.equal(f.engine().snapshot().playlists.length, 11)
  assert.equal(await f.send('readPlaylist', { id: 'list-0' }), null)
  assert.equal((await f.send('readPlaylist', { id: null })).id, 'favorite-id')
  await f.playlist('favorite-id', ['added-local-song'])
  await f.restart()
  assert.deepEqual((await f.send('readPlaylist', { id: null })).songs.map(song => song.hash), ['added-local-song'])
  assert.equal(f.calls.length, 0)
})

test('lyrics keep translations while removing credentials and never perform a background lyric lookup', async t => {
  const f = await fixture(t)
  await f.playlist()
  const lyric = { status: 200, decodeContent: '[0,1000]one', language: 'encoded-translation', token: 'secret-token', accesskey: 'private-accesskey', data: { content: 'original', translation: '译文', cookie: 'secret-cookie' } }
  await f.send('putLyrics', { hash: 'song-a', data: lyric })
  const result = await f.send('readLyrics', { hash: 'song-a' })
  assert.equal(result.language, 'encoded-translation')
  assert.equal(result.data.translation, '译文')
  const longContent = '[0,1000]'.repeat(20_000)
  await f.send('putLyrics', { hash: 'long-song', data: { status: 200, decodeContent: longContent } })
  assert.equal((await f.send('readLyrics', { hash: 'long-song' })).decodeContent, longContent)
  const account = crypto.createHash('sha256').update('account-a').digest('hex')
  const stored = await fs.readFile(path.join(f.directory, account, 'index.json'), 'utf8')
  assert.doesNotMatch(stored, /secret-token|private-accesskey|secret-cookie|placeholder-private-token/)
  assert.equal(f.calls.length, 0)
  await f.login('account-b')
  assert.equal(await f.send('readLyrics', { hash: 'song-a' }), null)
  assert.equal(await f.send('readPlaylist', { id: null }), null)
  await f.login('account-a')
  assert.equal((await f.send('readLyrics', { hash: 'song-a' })).decodeContent, lyric.decodeContent)
  for (const hash of ['__proto__', 'constructor', 'prototype']) {
    await assert.rejects(f.send('cacheSong', { song: { hash } }), error => error.code === 'INVALID_SONG')
    assert.equal(await f.send('putLyrics', { hash, data: { decodeContent: 'bad' } }), null)
  }
})

test('account changes cancel downloads, reject stale operations and prevent old auth errors affecting a later account', async t => {
  const f = await fixture(t)
  f.responses.set('/audio', (request, response) => { f.pending.add(response) })
  await f.playlist()
  await f.play()
  await until(() => f.calls.length > 0)
  await f.login('account-b')
  for (const response of f.pending) response.end(JSON.stringify({ error_code: 20017 }))
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(f.auth.length, 0)
  assert.equal(f.engine().snapshot().userId, 'account-b')
  assert.equal(await f.engine().dispatch('readPlaylist', { id: null }, 1), null)
  assert.equal(f.engine().snapshot().playlists.length, 0)
  await f.login(null)
  assert.equal(await f.send('getSource', { hash: 'song-a', quality: '128' }), null)
})

test('current auth errors are generation-bound and pause downloads without persisting the session', async t => {
  const f = await fixture(t)
  f.responses.set('/audio', (request, response) => response.end(JSON.stringify({ error_code: 20017 })))
  await f.playlist()
  await f.play()
  await until(() => f.auth.length === 1)
  assert.deepEqual(f.auth[0], { generation: 1, userId: 'account-a' })
  assert.equal(f.engine().snapshot().playlists[0].status, 'paused')
  assert.equal(f.calls.length, 1)
})

test('HTTP 502 business responses still expire the current account before HTTP failure classification', async t => {
  const f = await fixture(t)
  f.responses.set('/audio', (request, response) => { response.writeHead(502, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ status: 0, error_code: 20017 })) })
  await f.playlist()
  await f.play()
  await until(() => f.auth.length === 1)
  assert.deepEqual(f.auth[0], { generation: 1, userId: 'account-a' })
  assert.equal(f.calls.length, 1)
})

test('network errors retry only three times and online retry preserves explicit pause and permanent failures', async t => {
  const f = await fixture(t, { retryBaseDelayMs: 10 })
  f.responses.set('/audio', (request, response) => { response.writeHead(503); response.end('unavailable') })
  await f.playlist()
  await f.play()
  await until(() => f.engine().snapshot().playlists[0].status === 'failed')
  assert.equal(f.calls.length, 3)
  await new Promise(resolve => setTimeout(resolve, 80))
  assert.equal(f.calls.length, 3)
  await f.send('pause', { id: 'favorite-id' })
  await f.send('retryNetwork')
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(f.calls.length, 3)
  assert.equal(f.engine().snapshot().playlists[0].status, 'paused')
  f.responses.set('/audio', (request, response) => response.end(JSON.stringify({ status: 0, error_code: 20010 })))
  await f.send('resume', { id: 'favorite-id' })
  await until(() => f.engine().snapshot().playlists[0].status === 'failed')
  const requests = f.calls.length
  await f.send('retryNetwork')
  await new Promise(resolve => setTimeout(resolve, 80))
  assert.equal(f.calls.length, requests)
})

test('rejects explicit previews, permission failures and non-audio responses without marking them complete', async t => {
  const f = await fixture(t)
  await f.playlist()
  f.responses.set('/song/url', (request, response) => response.end(JSON.stringify({ status: 1, url: [`${f.origin}/file`], is_free_part: 1 })))
  await f.play()
  await until(() => f.engine().snapshot().playlists[0].status === 'failed')
  assert.equal(f.calls.filter(call => call.path === '/file').length, 0)
  assert.equal(await f.send('getSource', { hash: 'song-a', quality: '128' }), null)
  f.responses.delete('/song/url')
  f.responses.set('/file', (request, response) => { const html = Buffer.alloc(f.audio.length, 'x'); response.setHeader('Content-Length', html.length); response.end(html) })
  await f.send('retry', { id: 'favorite-id' })
  await until(() => f.engine().snapshot().playlists[0].status === 'failed')
  assert.equal(f.engine().snapshot().playlists[0].cached, 0)
})

test('detects on-disk corruption and supports preferred-quality misses with explicit fallback', async t => {
  const f = await fixture(t)
  await f.playlist()
  await f.play()
  const source = await f.complete()
  assert.equal(await f.send('getSource', { hash: 'song-a', quality: '320' }), null)
  const fallback = await f.send('getSource', { hash: 'song-a', quality: '320', allowFallback: true })
  assert.equal(fallback.requestedQuality, '128')
  await f.send('releaseSource', { leaseId: fallback.leaseId })
  const corrupted = Buffer.from(f.audio)
  corrupted[150] = 0xff
  await fs.writeFile(source.path, corrupted)
  assert.equal(await f.send('getSource', { hash: 'song-a', quality: '128' }), null)
  assert.equal(f.engine().snapshot().playlists[0].cached, 0)
})

test('clear retains complete playlist metadata, protects existing leases across logout and suppresses automatic re-download', async t => {
  const f = await fixture(t)
  await f.playlist()
  await f.play()
  await f.complete()
  const first = await f.send('getSource', { hash: 'song-a', quality: '128' })
  await f.send('clear')
  assert.ok(await fs.stat(first.path))
  assert.equal(await f.send('putLyrics', { hash: 'song-a', data: { status: 200, decodeContent: 'late lyrics' } }), null, 'a late lyric response cannot recreate cleared content before another play')
  assert.equal(await f.send('readLyrics', { hash: 'song-a' }), null)
  assert.equal((await f.send('readPlaylist', { id: null })).songs.length, 1)
  assert.equal(await f.send('getSource', { hash: 'song-a', quality: '128' }), null)
  const requests = f.calls.length
  await f.playlist()
  await f.send('configure', { download: { concurrentDownloads: 3 } })
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(f.calls.length, requests)
  await f.login(null)
  assert.equal((await fs.readFile(first.path)).length, f.audio.length)
  await f.login('account-a')
  await f.play()
  await f.send('putLyrics', { hash: 'song-a', data: { status: 200, decodeContent: 'played again', language: 'translation' } })
  assert.equal((await f.send('readLyrics', { hash: 'song-a' })).language, 'translation')
  const second = await f.complete()
  assert.notEqual(first.path, second.path, 'a new resource never overwrites a currently leased old file')
  await f.send('releaseSource', { leaseId: first.leaseId })
  await assert.rejects(fs.stat(first.path), { code: 'ENOENT' })
})

test('pausing is preserved when a complete snapshot is resubmitted, while global off cancels current network work', async t => {
  const f = await fixture(t)
  await f.playlist()
  await f.send('pause', { id: 'favorite-id' })
  await f.playlist()
  await f.play()
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(f.calls.length, 0)
  f.responses.set('/audio', (request, response) => { f.pending.add(response) })
  await f.send('resume', { id: 'favorite-id' })
  await until(() => f.calls.length === 1)
  await f.send('configure', { download: { offlinePlaylistCacheEnabled: false } })
  assert.equal(f.engine().snapshot().enabled, false)
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(f.calls.length, 1)
})

test('interrupted downloads publish no partial file, then restart resumes only previously played requests', async t => {
  const f = await fixture(t)
  await f.playlist('favorite-id', ['song-a', 'never-played'])
  f.responses.set('/file', (request, response) => {
    response.writeHead(200, { 'Content-Length': f.audio.length })
    response.write(f.audio.subarray(0, 300))
    f.pending.add(response)
  })
  await f.play()
  await until(() => f.calls.some(call => call.path === '/file'))
  await f.engine().stop()
  const before = f.calls.filter(call => call.path === '/song/url').length
  f.responses.delete('/file')
  await f.restart()
  await f.complete()
  assert.equal(f.calls.filter(call => call.path === '/song/url').length, before + 1)
  assert.equal(f.calls.some(call => call.query.hash === 'never-played'), false)
})

test('LRU eviction stays within quota, and evicted songs are not automatically queued again', async t => {
  const f = await fixture(t, { audioSize: 10_000, limitBytes: 30_000 })
  await f.playlist('favorite-id', ['song-a', 'song-b', 'song-c'])
  await f.play('song-a')
  await f.complete('song-a')
  await f.play('song-b')
  await f.complete('song-b')
  const pinned = await f.send('getSource', { hash: 'song-b', quality: '128' })
  await f.play('song-c')
  await f.complete('song-c')
  assert.equal(await f.send('getSource', { hash: 'song-a', quality: '128' }), null)
  assert.ok(await f.send('getSource', { hash: 'song-b', quality: '128' }))
  assert.ok(f.engine().snapshot().usedBytes <= 30_000)
  const before = f.calls.filter(call => call.query.hash === 'song-a').length
  await f.send('configure', { download: { concurrentDownloads: 3 } })
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(f.calls.filter(call => call.query.hash === 'song-a').length, before)
  await f.send('releaseSource', { leaseId: pinned.leaseId })
})

test('oversized metadata is rejected atomically and does not replace the last complete snapshot', async t => {
  const f = await fixture(t, { limitBytes: 12_000 })
  await f.playlist()
  await assert.rejects(f.send('putPlaylist', { id: 'favorite-id', isFavorite: true, name: 'new', songs: [{ hash: 'song-z', name: 'x'.repeat(12_000) }] }), error => error.code === 'SPACE')
  assert.equal((await f.send('readPlaylist', { id: null })).songs[0].hash, 'song-a')
  assert.equal(f.engine().snapshot().usedBytes <= 12_000, true)
  await f.restart()
  assert.equal((await f.send('readPlaylist', { id: null })).songs[0].hash, 'song-a')
})

test('malformed records inside otherwise valid JSON do not disable recovery or cache clearing', async t => {
  const f = await fixture(t)
  await f.playlist()
  await f.engine().stop()
  const account = crypto.createHash('sha256').update('account-a').digest('hex')
  await fs.writeFile(path.join(f.directory, account, 'index.json'), JSON.stringify({ version: 1, account, playlists: [{}], songs: { bad: null }, lyrics: { constructor: {} }, artworks: { bad: null } }))
  await f.restart()
  assert.equal(await f.send('readPlaylist', { id: null }), null)
  assert.equal(await f.send('getSource', { hash: 'song-a', quality: '128' }), null)
  await f.send('clear')
  await f.playlist('restored', ['recovered'])
  assert.equal((await f.send('readPlaylist', { id: null })).songs[0].hash, 'recovered')
})

test('read touches a recently visited playlist without resuming its paused audio queue', async t => {
  const f = await fixture(t)
  for (let i = 0; i < 10; i++) await f.playlist(`list-${i}`, [`song-${i}`], false)
  await f.send('pause', { id: 'list-0' })
  await f.send('readPlaylist', { id: 'list-0' })
  await f.playlist('list-10', ['song-10'], false)
  assert.ok(await f.send('readPlaylist', { id: 'list-0' }))
  assert.equal(await f.send('readPlaylist', { id: 'list-1' }), null)
  assert.equal(f.engine().snapshot().playlists.find(item => item.id === 'list-0').status, 'paused')
  assert.equal(f.calls.length, 0)
})

test('simultaneous downloads reserve remaining bytes before writing and expose partial usage', async t => {
  const f = await fixture(t, { audioSize: 15_000, limitBytes: 30_000 })
  const held = []
  f.responses.set('/file', (request, response) => {
    response.writeHead(200, { 'Content-Length': f.audio.length })
    response.write(f.audio.subarray(0, 100))
    held.push(response)
    f.pending.add(response)
  })
  await f.playlist('favorite-id', ['song-a', 'song-b'])
  await f.play('song-a')
  await until(() => held.length === 1)
  await f.play('song-b')
  await until(() => f.engine().snapshot().playlists[0].error?.code === 'SPACE')
  assert.ok(f.engine().snapshot().usedBytes > 100)
  held[0].end(f.audio.subarray(100))
  await f.complete('song-a')
  assert.ok(f.engine().snapshot().usedBytes <= 30_000)
  assert.equal(await f.send('getSource', { hash: 'song-b', quality: '128' }), null)
})

test('artwork is cached on demand, type-checked and isolated by account', async t => {
  const f = await fixture(t)
  assert.equal(await f.send('getArtwork', { url: `${f.origin}/cover` }), null)
  await f.send('cacheArtwork', { url: `${f.origin}/cover` })
  const image = await until(() => f.send('getArtwork', { url: `${f.origin}/cover` }))
  assert.equal(image.extname, 'png')
  await f.send('releaseSource', { leaseId: image.leaseId })
  await f.restart()
  assert.ok(await f.send('getArtwork', { url: `${f.origin}/cover` }))
  await f.login('account-b')
  assert.equal(await f.send('getArtwork', { url: `${f.origin}/cover` }), null)
  assert.equal(await f.send('cacheArtwork', { url: 'file:///private.png' }), null)
  await f.send('releaseSource', { leaseId: image.leaseId })
})

test('public artwork host and media guards reject private addresses, credentials, malformed hashes and preview indicators', () => {
  assert.equal(allowedArtworkUrl('https://imge.kugou.com/cover.jpg'), true)
  assert.equal(allowedArtworkUrl('https://imgessl.kugou.com/cover.jpg'), true)
  assert.equal(allowedArtworkUrl('https://singerimg.kugou.com/cover.jpg'), true)
  assert.equal(allowedArtworkUrl('https://imgessl.kugou.com.evil.test/cover.jpg'), false)
  assert.equal(allowedArtworkUrl('https://placeholder:secret@imge.kugou.com/cover.jpg'), false)
  assert.equal(allowedArtworkUrl('http://127.0.0.1/private'), false)
  for (const address of ['127.0.0.1', '10.0.0.2', '172.16.0.1', '192.168.0.1', '::1', 'fd00::1', '::ffff:127.0.0.1']) assert.equal(privateAddress(address), true)
  assert.equal(privateAddress('8.8.8.8'), false)
  assert.equal(detectFormat(Buffer.from('{"error":true}')), null)
  assert.equal(detectFormat(wav()), 'wav')
  assert.equal(isPreview({ is_free_part: 1 }), true)
  assert.equal(isPreview({ status: 1, try_begin: 10, try_end: 40 }), true)
  assert.equal(isPreview({ free_part: '0' }), false)
  assert.equal(isPreview({ free_part: false }), false)
  assert.equal(isPreview({ free_part: '1' }), true)
  assert.equal(isPreview({ free_part: { start: 0, end: 30 } }), true)
  assert.equal(normalizeHash('../file'), null)
  assert.equal(normalizeHash('__proto__'), null)
})
