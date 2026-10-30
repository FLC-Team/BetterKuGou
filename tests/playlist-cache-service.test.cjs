const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const http = require('node:http')
const { Worker } = require('node:worker_threads')
const { EventEmitter } = require('node:events')
const { createPlaylistCacheService } = require('../electron/services/playlistCacheService')
const { parseByteRange } = require('../electron/services/playlistCacheMedia')

async function until(callback, timeout = 5000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const result = await callback()
    if (result) return result
    await new Promise(resolve => setTimeout(resolve, 15))
  }
  assert.fail('Timed out waiting for a cache service operation')
}

async function fixture(t, options = {}) {
  const toolsRoot = path.resolve(__dirname, '../.agent/tools')
  await fs.mkdir(toolsRoot, { recursive: true })
  const directory = await fs.mkdtemp(path.join(toolsRoot, 'playlist-cache-service-'))
  const audio = Buffer.alloc(4096)
  audio.write('RIFF', 0)
  audio.writeUInt32LE(audio.length - 8, 4)
  audio.write('WAVE', 8)
  const calls = []
  let origin
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, origin)
    calls.push(url.pathname)
    if (url.pathname === '/audio') { response.end(JSON.stringify({ status: 1, data: [{ hash: 'song-a', album_audio_id: 7 }] })); return }
    if (url.pathname === '/song/url') { response.end(JSON.stringify({ status: 1, url: [`${origin}/file`], extname: 'wav', filesize: audio.length, bitrate: 128000 })); return }
    if (url.pathname === '/file') { response.setHeader('Content-Length', audio.length); response.end(audio); return }
    response.writeHead(404); response.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${server.address().port}`
  const workers = []
  class FixtureWorker extends Worker {
    constructor(workerPath, options) {
      super(workerPath, { ...options, workerData: { ...options.workerData, apiBase: origin, allowLocalTestUrls: true } })
      workers.push(this)
    }
    postMessage(message) {
      if (options.failCommit && message.action === 'commitMigration') {
        options.failCommit = false
        throw new Error('Simulated lost commit message')
      }
      return super.postMessage(message)
    }
  }
  const states = []
  const service = createPlaylistCacheService({ workerPath: path.resolve(__dirname, '../electron/services/playlistCacheWorker.cjs'), cacheRoot: directory, Worker: FixtureWorker, onState: state => states.push(state), logger: { warn() {}, error() {} } })
  t.after(async () => {
    await service.stop()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await fs.rm(directory, { recursive: true, force: true })
  })
  await service.configure({ download: { offlinePlaylistCacheEnabled: true } })
  await service.setSession({ userId: 'account-a', token: 'placeholder-token' })
  await service.putPlaylist({ id: 'favorite-id', isFavorite: true, name: '我喜欢', songs: [{ hash: 'song-a', name: 'Cached song' }] })
  return { service, calls, states, directory, audio, workers }
}

test('single byte ranges cover suffix, end clamping and malformed/unsatisfiable requests', () => {
  assert.equal(parseByteRange(null, 100), null)
  assert.deepEqual(parseByteRange('bytes=0-0', 100), { start: 0, end: 0 })
  assert.deepEqual(parseByteRange('bytes=95-', 100), { start: 95, end: 99 })
  assert.deepEqual(parseByteRange('bytes=-5', 100), { start: 95, end: 99 })
  assert.deepEqual(parseByteRange('bytes=-200', 100), { start: 0, end: 99 })
  assert.deepEqual(parseByteRange('bytes=0-999', 100), { start: 0, end: 99 })
  for (const range of ['bytes=100-', 'bytes=3-2', 'bytes=-0', 'bytes=1-2,3-4', 'bytes=-', 'bytes=1.5-3', 'items=0-1', 'bytes=9007199254740992-']) assert.equal(parseByteRange(range, 100), false)
})

test('real Worker returns private leases and protocol serves GET, HEAD, seek ranges and rejects path injection', async t => {
  const f = await fixture(t)
  assert.equal(f.calls.length, 0)
  await f.service.cacheSong({ song: { hash: 'song-a', name: 'Cached song' }, quality: '128' })
  const source = await until(() => f.service.getSource({ hash: 'song-a', quality: '128' }))
  assert.match(source.url, /^bk-cache:\/\/media\/[a-f\d]{48}$/)
  assert.equal(source.path, undefined)
  assert.equal(source.file, undefined)
  assert.equal(source.account, undefined)
  assert.equal(source.detail.album_audio_id, 7)
  const { cacheDirectory, ...publicState } = f.service.getState()
  assert.equal(cacheDirectory, f.directory)
  assert.doesNotMatch(JSON.stringify(publicState), /placeholder-token|playlist-cache-service-|\.wav|http:/)
  const full = await f.service.handleRequest(new Request(source.url))
  assert.equal(full.status, 200)
  assert.equal(full.headers.get('content-length'), '4096')
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), f.audio)
  for (const [range, expected, start, end] of [['bytes=0-0', 1, 0, 0], ['bytes=4090-', 6, 4090, 4095], ['bytes=-5', 5, 4091, 4095]]) {
    const response = await f.service.handleRequest(new Request(source.url, { headers: { Range: range } }))
    assert.equal(response.status, 206)
    assert.equal(response.headers.get('content-range'), `bytes ${start}-${end}/4096`)
    assert.equal((await response.arrayBuffer()).byteLength, expected)
  }
  const head = await f.service.handleRequest(new Request(source.url, { method: 'HEAD', headers: { Range: 'bytes=5-9' } }))
  assert.equal(head.status, 206)
  assert.equal(head.headers.get('content-length'), '5')
  assert.equal((await head.arrayBuffer()).byteLength, 0)
  const invalid = await f.service.handleRequest(new Request(source.url, { headers: { Range: 'bytes=5000-' } }))
  assert.equal(invalid.status, 416)
  assert.equal(invalid.headers.get('content-range'), 'bytes */4096')
  assert.equal((await f.service.handleRequest(new Request(source.url, { method: 'POST' }))).status, 405)
  for (const url of ['bk-cache://media/../../settings.json', `${source.url}?path=/settings.json`, 'bk-cache://other/123', 'bk-cache://media/123']) assert.equal((await f.service.handleRequest(new Request(url))).status, 404)
  await f.service.releaseSource(source.leaseId)
  assert.equal((await f.service.handleRequest(new Request(source.url))).status, 404)
})

test('logout hides private snapshots but a granted source remains usable until release, including after clearing', async t => {
  const f = await fixture(t)
  await f.service.cacheSong({ song: { hash: 'song-a' } })
  const source = await until(() => f.service.getSource({ hash: 'song-a', quality: '128' }))
  await f.service.clear()
  await f.service.setSession(null)
  assert.deepEqual(f.service.getState().playlists, [])
  assert.equal(await f.service.getSource({ hash: 'song-a', quality: '128' }), null)
  assert.equal(await f.service.readPlaylist(null), null)
  const current = await f.service.handleRequest(new Request(source.url))
  assert.equal((await current.arrayBuffer()).byteLength, 4096)
  await f.service.releaseSource(source.leaseId)
  assert.equal((await f.service.handleRequest(new Request(source.url))).status, 404)
  assert.ok(f.service.getState().usedBytes < 4096)
})

test('a replacement Worker preserves a cleared leased file until its last release and does not leak it afterward', async t => {
  const f = await fixture(t)
  await f.service.cacheSong({ song: { hash: 'song-a' } })
  const source = await until(() => f.service.getSource({ hash: 'song-a', quality: '128' }))
  await f.service.clear()
  await f.workers[0].terminate()
  await f.service.readPlaylist(null)
  assert.equal(f.workers.length, 2)
  const resumed = await f.service.handleRequest(new Request(source.url))
  assert.equal((await resumed.arrayBuffer()).byteLength, 4096)
  await f.service.releaseSource(source.leaseId)
  assert.ok(f.service.getState().usedBytes < 4096)
})

test('stop is shared and releases the real Worker without leaving a background thread', async t => {
  const f = await fixture(t)
  const stop = f.service.stop()
  assert.equal(stop, f.service.stop())
  await stop
  assert.equal(f.workers[0].threadId, -1)
})

async function migrationTarget(t) {
  const parent = await fs.mkdtemp(path.resolve(__dirname, '../.agent/tools/cache-destination-'))
  t.after(() => fs.rm(parent, { recursive: true, force: true }))
  return path.join(parent, 'offline-playlists')
}

test('migration keeps granted URLs playable, copies lyrics and lists, and cleans the original root', async t => {
  const f = await fixture(t)
  const target = await migrationTarget(t)
  await f.service.cacheSong({ song: { hash: 'song-a' } })
  const source = await until(() => f.service.getSource({ hash: 'song-a', quality: '128' }))
  await f.service.putLyrics({ hash: 'song-a', data: { decodeContent: '[00:00]cached lyrics' } })
  const oldResponse = await f.service.handleRequest(new Request(source.url))
  let saved = null
  const result = await f.service.changeDirectory(target, async directory => {
    assert.equal(f.service.getState().cacheDirectory, f.directory)
    assert.ok((await fs.readdir(directory)).length)
    saved = directory
  })
  assert.equal(saved, target)
  assert.equal(result.cacheDirectory, target)
  assert.deepEqual(Buffer.from(await oldResponse.arrayBuffer()), f.audio)
  const range = await f.service.handleRequest(new Request(source.url, { headers: { Range: 'bytes=1-10' } }))
  assert.equal(range.status, 206)
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), f.audio.subarray(1, 11))
  assert.equal((await f.service.readPlaylist(null)).songs[0].hash, 'song-a')
  assert.equal((await f.service.readLyrics('song-a')).decodeContent, '[00:00]cached lyrics')
  await until(() => !f.service.getState().migration)
  await assert.rejects(fs.access(f.directory), { code: 'ENOENT' })
  assert.ok(f.states.some(state => state.migration?.phase === 'verifying'))
  await f.service.releaseSource(source.leaseId)
})

test('failed migration setting commits roll back, preserve source media, and permit retry', async t => {
  const f = await fixture(t)
  const target = await migrationTarget(t)
  await f.service.cacheSong({ song: { hash: 'song-a' } })
  const source = await until(() => f.service.getSource({ hash: 'song-a', quality: '128' }))
  await assert.rejects(f.service.changeDirectory(target, async () => { throw Object.assign(new Error('Disk full'), { code: 'ENOSPC' }) }), { code: 'CACHE_MIGRATION_FAILED' })
  assert.equal(f.service.getState().cacheDirectory, f.directory)
  assert.match(f.service.getState().migrationError.message, /原缓存/)
  assert.deepEqual(Buffer.from(await (await f.service.handleRequest(new Request(source.url))).arrayBuffer()), f.audio)
  await assert.rejects(fs.access(target), { code: 'ENOENT' })
  await f.service.changeDirectory(target, async () => {})
  assert.equal(f.service.getState().cacheDirectory, target)
  assert.equal(f.service.getState().migrationError, null)
})

test('a lost Worker commit after settings were saved rebuilds from the new root without deleting either copy', async t => {
  const f = await fixture(t, { failCommit: true })
  const target = await migrationTarget(t)
  await f.service.cacheSong({ song: { hash: 'song-a' } })
  const source = await until(() => f.service.getSource({ hash: 'song-a', quality: '128' }))
  const state = await f.service.changeDirectory(target, async () => {})
  assert.equal(state.cacheDirectory, target)
  assert.equal(state.migrationWarning.code, 'CACHE_MIGRATION_RECOVERED')
  assert.equal(f.workers.length, 2)
  await fs.access(f.directory)
  await fs.access(target)
  assert.deepEqual(Buffer.from(await (await f.service.handleRequest(new Request(source.url))).arrayBuffer()), f.audio)
  const fresh = await f.service.getSource({ hash: 'song-a', quality: '128' })
  assert.ok(fresh)
  await f.service.releaseSource(source.leaseId)
  await f.service.releaseSource(fresh.leaseId)
})

test('migration queues account changes and cache writes while existing playback stays available', async t => {
  const f = await fixture(t)
  const target = await migrationTarget(t)
  await f.service.cacheSong({ song: { hash: 'song-a' } })
  const source = await until(() => f.service.getSource({ hash: 'song-a', quality: '128' }))
  let finishSave
  const save = new Promise(resolve => { finishSave = resolve })
  let saving = false
  const migration = f.service.changeDirectory(target, async () => { saving = true; await save })
  await until(() => saving)
  await assert.rejects(f.service.changeDirectory(target, async () => {}), { code: 'CACHE_MIGRATION_BUSY' })
  let loggedOut = false
  const logout = f.service.setSession(null).then(() => { loggedOut = true })
  assert.equal(f.service.getState().userId, null)
  assert.deepEqual(Buffer.from(await (await f.service.handleRequest(new Request(source.url))).arrayBuffer()), f.audio)
  assert.equal(loggedOut, false)
  finishSave()
  await migration
  await logout
  assert.equal(await f.service.getSource({ hash: 'song-a', quality: '128' }), null)
  assert.deepEqual(Buffer.from(await (await f.service.handleRequest(new Request(source.url))).arrayBuffer()), f.audio)
  await f.service.releaseSource(source.leaseId)
})

test('shutdown waits for an in-progress migration commit before releasing the Worker', async t => {
  const f = await fixture(t)
  const target = await migrationTarget(t)
  let finishSave, saving = false
  const save = new Promise(resolve => { finishSave = resolve })
  const migration = f.service.changeDirectory(target, async () => { saving = true; await save })
  await until(() => saving)
  const stop = f.service.stop()
  assert.equal(stop, f.service.stop())
  assert.notEqual(f.workers[0].threadId, -1)
  finishSave()
  await migration
  await stop
  assert.equal(f.service.getState().cacheDirectory, target)
  assert.equal(f.workers[0].threadId, -1)
  await fs.access(target)
})

test('late RPC sources and authentication events cannot cross an account generation', async () => {
  const instances = []
  class MockWorker extends EventEmitter {
    constructor() { super(); this.messages = []; instances.push(this) }
    postMessage(message) { this.messages.push(message) }
    terminate() { this.emit('exit', 0); return Promise.resolve() }
    result(command, result) { this.emit('message', { id: command.id, type: 'result', result }) }
  }
  const expired = []
  const service = createPlaylistCacheService({ workerPath: '/unused', cacheRoot: '/unused', Worker: MockWorker, onAuthExpired: value => expired.push(value) })
  const loggedIn = service.setSession({ userId: 'first', token: 'placeholder-first' })
  const worker = instances[0]
  worker.result(worker.messages.at(-1), { generation: 1, userId: 'first', playlists: [], revision: 0 })
  await loggedIn
  const pending = service.getSource({ hash: 'song-a', quality: '128' })
  const request = worker.messages.at(-1)
  const login = service.setSession({ userId: 'second', token: 'placeholder-second' })
  worker.result(worker.messages.at(-1), { generation: 2, userId: 'second', playlists: [], revision: 0 })
  await login
  worker.emit('message', { type: 'authExpired', generation: 1, userId: 'first' })
  assert.equal(expired.length, 0)
  worker.result(request, { leaseId: 'a'.repeat(48), path: '/private/file', account: 'a'.repeat(64), file: 'file' })
  assert.equal(await pending, null)
  assert.equal(worker.messages.at(-1).action, 'releaseSource')
  worker.result(worker.messages.at(-1), true)
  const stop = service.stop()
  worker.emit('exit', 0)
  await stop
})
