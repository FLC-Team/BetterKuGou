const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const http = require('node:http')
const { Worker } = require('node:worker_threads')
const { createCacheEngine } = require('../electron/services/playlistCacheWorker.cjs')

const digest = value => crypto.createHash('sha256').update(value).digest('hex')
const exists = filename => fs.stat(filename).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error })

async function fixture(t, options = {}) {
  const toolsRoot = path.resolve(__dirname, '../.agent/tools')
  await fs.mkdir(toolsRoot, { recursive: true })
  const directory = await fs.mkdtemp(path.join(toolsRoot, 'cache-migration-'))
  const source = path.join(directory, 'original')
  const target = path.join(directory, 'offline-playlists')
  const audio = Buffer.from('migration-preserves-complete-audio-and-its-digest')
  const artwork = Buffer.from('migration-preserves-artwork')
  const url = 'https://imge.kugou.com/fixture.png'
  const accounts = ['account-a', 'account-b'].map(userId => ({ userId, account: digest(userId) }))
  for (const { account, userId } of accounts) {
    const file = `${digest(userId)}.wav`
    const image = `${digest(url)}.png`
    const index = {
      version: 1, account, paused: false, suppressed: false,
      playlists: [{ id: 'favorites', name: userId, isFavorite: true, songs: [{ hash: 'song-a', name: '保留曲目' }] }],
      songs: { 'song-a:128': { hash: 'song-a', quality: '128', kind: 'song', song: { hash: 'song-a' }, file, size: audio.length, sha256: digest(audio), status: 'complete', mime: 'audio/wav', extname: 'wav', bitrate: 128000 } },
      artworks: { [digest(url)]: { url, file: image, size: artwork.length, sha256: digest(artwork), status: 'complete', mime: 'image/png' } },
      lyrics: { 'song-a': { decodeContent: '[00:01]原文', trans: '[00:01]translation' } }
    }
    await fs.mkdir(path.join(source, account), { recursive: true })
    await fs.writeFile(path.join(source, account, file), audio)
    await fs.writeFile(path.join(source, account, image), artwork)
    await fs.writeFile(path.join(source, account, 'index.json'), JSON.stringify(index))
  }
  const states = []
  let engine = createCacheEngine({ ...options, cacheRoot: source, onState: state => states.push(state) })
  await engine.ready
  let generation = 1
  await engine.dispatch('setSession', { userId: 'account-a', token: 'placeholder-token' }, generation)
  const send = (action, payload) => engine.dispatch(action, payload, generation)
  t.after(async () => { await engine.stop(); await fs.rm(directory, { recursive: true, force: true }) })
  return {
    directory, source, target, audio, artwork, url, accounts, states, send,
    engine: () => engine,
    async login(userId) { return engine.dispatch('setSession', { userId, token: 'placeholder-token' }, ++generation) },
    async restart(root = target) {
      await engine.stop()
      engine = createCacheEngine({ ...options, cacheRoot: root, onState: state => states.push(state) })
      await engine.ready
      return engine.dispatch('setSession', { userId: 'account-a', token: 'placeholder-token' }, ++generation)
    }
  }
}

test('migration copies every account, lyrics and artwork, then switches leases and survives restart', async t => {
  const f = await fixture(t)
  const original = await f.send('getSource', { hash: 'song-a', quality: '128' })
  const prepared = await f.send('prepareMigration', { targetRoot: f.target })
  assert.equal(prepared.targetRoot, f.target)
  assert.equal(prepared.cacheDirectory, f.source)
  assert.equal(prepared.migration.phase, 'committing')
  assert.equal(prepared.migration.copiedBytes, prepared.migration.totalBytes)
  assert.equal(prepared.migration.verifiedBytes, prepared.migration.totalBytes)
  assert.ok(f.states.some(state => state.migration?.phase === 'copying'))
  assert.ok(f.states.some(state => state.migration?.phase === 'verifying'))
  assert.deepEqual((await fs.readdir(f.directory)).sort(), ['offline-playlists', 'original'])
  await assert.rejects(f.send('putLyrics', { hash: 'song-a', data: { decodeContent: 'late' } }), { code: 'CACHE_MIGRATION_BUSY' })
  const committed = await f.send('commitMigration')
  assert.equal(committed.cacheDirectory, f.target)
  assert.equal(committed.migration, null)
  assert.deepEqual(await fs.readFile(original.path), f.audio, 'old stream paths survive until finalization')
  const moved = await f.send('getSource', { hash: 'song-a', quality: '128' })
  assert.equal(moved.path, path.join(f.target, f.accounts[0].account, path.basename(original.path)))
  assert.deepEqual(await fs.readFile(moved.path), f.audio)
  const image = await f.send('getArtwork', { url: f.url })
  assert.deepEqual(await fs.readFile(image.path), f.artwork)
  assert.equal((await f.send('readLyrics', { hash: 'song-a' })).trans, '[00:01]translation')
  await f.login('account-b')
  assert.equal((await f.send('readPlaylist', { id: null })).name, 'account-b')
  assert.ok(await f.send('getSource', { hash: 'song-a', quality: '128' }))
  await f.send('releaseSource', { leaseId: original.leaseId })
  const finalized = await f.send('finalizeMigration')
  assert.equal(finalized.migrationWarning, null)
  assert.equal(await exists(f.source), false)
  await f.restart()
  assert.equal((await f.send('readPlaylist', { id: null })).songs[0].name, '保留曲目')
  assert.ok(await f.send('getSource', { hash: 'song-a', quality: '128' }))
})

test('failed settings persistence can roll back the complete copy and keep the original usable', async t => {
  const f = await fixture(t)
  await f.send('prepareMigration', { targetRoot: f.target })
  const state = await f.send('rollbackMigration')
  assert.equal(state.cacheDirectory, f.source)
  assert.equal(state.migration, null)
  assert.equal(await exists(f.target), false)
  const source = await f.send('getSource', { hash: 'song-a', quality: '128' })
  assert.deepEqual(await fs.readFile(source.path), f.audio)
  await f.send('prepareMigration', { targetRoot: f.target })
  await f.send('commitMigration')
  assert.equal(f.engine().snapshot().cacheDirectory, f.target)
})

test('migration rejects overlapping, relative, linked and occupied targets without changing files', async t => {
  const f = await fixture(t)
  for (const targetRoot of [f.source, path.join(f.source, 'nested'), f.directory, '../relative']) {
    await assert.rejects(f.send('prepareMigration', { targetRoot }), { code: 'CACHE_MIGRATION_PATH' })
  }
  await fs.mkdir(f.target)
  await fs.writeFile(path.join(f.target, 'keep.txt'), 'personal file')
  await assert.rejects(f.send('prepareMigration', { targetRoot: f.target }), { code: 'CACHE_MIGRATION_NOT_EMPTY' })
  assert.equal(await fs.readFile(path.join(f.target, 'keep.txt'), 'utf8'), 'personal file')
  const linked = path.join(f.directory, 'linked')
  await fs.symlink(f.target, linked, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(f.send('prepareMigration', { targetRoot: path.join(linked, 'new-cache') }), { code: 'CACHE_MIGRATION_PATH' })
  await fs.unlink(linked)
  assert.equal(f.engine().snapshot().cacheDirectory, f.source)
})

test('copy or digest failure removes only staging data and allows a clean retry', async t => {
  const f = await fixture(t)
  const originalOpen = fs.open
  let injected = false
  fs.open = async (filename, flags, ...args) => {
    if (!injected && flags === 'wx' && String(filename).includes('.offline-playlists.migration-')) {
      injected = true
      throw Object.assign(new Error('fixture write denied'), { code: 'EACCES' })
    }
    return originalOpen.call(fs, filename, flags, ...args)
  }
  try { await assert.rejects(f.send('prepareMigration', { targetRoot: f.target }), { code: 'CACHE_MIGRATION_FAILED' }) } finally { fs.open = originalOpen }
  assert.equal(injected, true)
  assert.deepEqual(await fs.readdir(f.directory), ['original'])
  assert.ok(await f.send('getSource', { hash: 'song-a', quality: '128' }))
  let corrupted = false
  fs.open = async (filename, flags, ...args) => {
    const handle = await originalOpen.call(fs, filename, flags, ...args)
    if (!corrupted && flags === 'wx' && String(filename).includes('.offline-playlists.migration-')) {
      corrupted = true
      const sync = handle.sync.bind(handle)
      handle.sync = async () => { await handle.write(Buffer.from('!'), 0, 1, 0); await sync() }
    }
    return handle
  }
  try { await assert.rejects(f.send('prepareMigration', { targetRoot: f.target }), { code: 'CACHE_MIGRATION_VERIFY' }) } finally { fs.open = originalOpen }
  assert.deepEqual(await fs.readdir(f.directory), ['original'])
  await f.send('prepareMigration', { targetRoot: f.target })
  await f.send('commitMigration')
  assert.ok(await f.send('getSource', { hash: 'song-a', quality: '128' }))
})

test('source cleanup preserves external changes and rollback preserves unrelated new files', async t => {
  const f = await fixture(t)
  await f.send('prepareMigration', { targetRoot: f.target })
  const note = path.join(f.target, 'keep.txt')
  await fs.writeFile(note, 'external')
  const rollback = await f.send('rollbackMigration')
  assert.match(rollback.migrationWarning.message, /未能清理/)
  assert.equal(await fs.readFile(note, 'utf8'), 'external')
  const secondTarget = path.join(f.directory, 'second')
  await f.send('prepareMigration', { targetRoot: secondTarget })
  const originalIndex = path.join(f.source, f.accounts[0].account, 'index.json')
  await fs.writeFile(originalIndex, 'externally modified')
  await f.send('commitMigration')
  const finalized = await f.send('finalizeMigration')
  assert.match(finalized.migrationWarning.message, /暂时保留/)
  assert.equal(await fs.readFile(originalIndex, 'utf8'), 'externally modified')
  assert.ok(await f.send('getSource', { hash: 'song-a', quality: '128' }))
})

test('publishing a verified directory retries a transient Windows file lock without recopying', async t => {
  const f = await fixture(t)
  const originalRename = fs.rename
  let attempts = 0
  fs.rename = async (source, target) => {
    if (target === f.target && String(source).includes('.offline-playlists.migration-') && ++attempts === 1) throw Object.assign(new Error('fixture scanner lock'), { code: 'EBUSY' })
    return originalRename.call(fs, source, target)
  }
  let prepared
  try { prepared = await f.send('prepareMigration', { targetRoot: f.target }) } finally { fs.rename = originalRename }
  assert.ok(attempts >= 2 && attempts <= 3)
  assert.equal(prepared.migration.copiedBytes, prepared.migration.totalBytes)
  await f.send('commitMigration')
  assert.ok(await f.send('getSource', { hash: 'song-a', quality: '128' }))
})

test('persistent Windows directory locks use verified file moves and roll back a partial publication', async t => {
  const f = await fixture(t)
  const originalRename = fs.rename
  let movedFiles = 0, failFile = true
  fs.rename = async (source, target) => {
    if (String(source).includes('.offline-playlists.migration-')) {
      if (target === f.target) throw Object.assign(new Error('fixture directory filter'), { code: 'EPERM' })
      if (String(target).startsWith(`${f.target}${path.sep}`) && ++movedFiles === 2 && failFile) throw Object.assign(new Error('fixture file write denied'), { code: 'EACCES' })
    }
    return originalRename.call(fs, source, target)
  }
  try {
    await assert.rejects(f.send('prepareMigration', { targetRoot: f.target }), { code: 'CACHE_MIGRATION_FAILED' })
    assert.deepEqual(await fs.readdir(f.directory), ['original'])
    assert.ok(await f.send('getSource', { hash: 'song-a', quality: '128' }))
    failFile = false
    movedFiles = 0
    await f.send('prepareMigration', { targetRoot: f.target })
    assert.equal(movedFiles, 6)
  } finally { fs.rename = originalRename }
  await f.send('commitMigration')
  await f.send('finalizeMigration')
  assert.equal(await exists(f.source), false)
  assert.deepEqual(await fs.readdir(f.directory), ['offline-playlists'])
  assert.ok(await f.send('getSource', { hash: 'song-a', quality: '128' }))
})

test('source cleanup keeps the last valid media when its committed destination is missing or changed', async t => {
  const f = await fixture(t)
  const source = await f.send('getSource', { hash: 'song-a', quality: '128' })
  await f.send('prepareMigration', { targetRoot: f.target })
  await f.send('commitMigration')
  const destination = path.join(f.target, source.account, source.file)
  await fs.writeFile(destination, 'changed externally')
  assert.match((await f.send('finalizeMigration')).migrationWarning.message, /暂时保留/)
  assert.deepEqual(await fs.readFile(source.path), f.audio)
  await fs.unlink(destination)
  assert.match((await f.send('finalizeMigration')).migrationWarning.message, /暂时保留/)
  assert.deepEqual(await fs.readFile(source.path), f.audio)
  await fs.writeFile(destination, f.audio)
  assert.equal((await f.send('finalizeMigration')).migrationWarning, null)
  assert.equal(await exists(f.source), false)
})

test('cleared but leased media migrates and is deleted only when its last lease is released', async t => {
  const f = await fixture(t)
  const leased = await f.send('getSource', { hash: 'song-a', quality: '128' })
  await f.send('clear')
  await f.send('prepareMigration', { targetRoot: f.target })
  await f.send('commitMigration')
  const newPath = path.join(f.target, leased.account, leased.file)
  assert.deepEqual(await fs.readFile(newPath), f.audio)
  await f.send('finalizeMigration')
  assert.equal(await exists(f.source), false)
  await f.send('releaseSource', { leaseId: leased.leaseId })
  assert.equal(await exists(newPath), false)
  assert.equal((await f.send('readPlaylist', { id: null })).id, 'favorites')
})

test('real Worker publishes migration phases and returns actionable path failures over RPC', async t => {
  const f = await fixture(t)
  await f.engine().stop()
  const worker = new Worker(path.resolve(__dirname, '../electron/services/playlistCacheWorker.cjs'), { workerData: { cacheRoot: f.source } })
  t.after(() => worker.terminate())
  let next = 0
  const pending = new Map(), states = []
  worker.on('message', message => {
    if (message.type === 'state') { states.push(message.state); return }
    const item = pending.get(message.id)
    if (!item) return
    pending.delete(message.id)
    if (message.type === 'error') item.reject(Object.assign(new Error(message.error.message), { code: message.error.code }))
    else item.resolve(message.result)
  })
  const send = (action, payload) => new Promise((resolve, reject) => { const id = ++next; pending.set(id, { resolve, reject }); worker.postMessage({ id, action, payload, generation: 1 }) })
  await send('setSession', { userId: 'account-a', token: 'placeholder-token' })
  await assert.rejects(send('prepareMigration', { targetRoot: f.source }), error => error.code === 'CACHE_MIGRATION_PATH' && /互相包含/.test(error.message))
  await send('prepareMigration', { targetRoot: f.target })
  await send('commitMigration')
  await send('finalizeMigration')
  assert.ok(states.some(state => state.migration?.phase === 'copying'))
  assert.equal((await send('getState')).cacheDirectory, f.target)
  assert.ok(await send('getSource', { hash: 'song-a', quality: '128' }))
  await send('stop')
})

test('migration cancels an active download, copies no partial media and resumes its queue in the new directory', async t => {
  const audio = Buffer.alloc(4096)
  audio.write('RIFF', 0)
  audio.writeUInt32LE(audio.length - 8, 4)
  audio.write('WAVEfmt ', 8)
  let origin, firstResponse, downloads = 0
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, origin)
    if (url.pathname === '/audio') { response.end(JSON.stringify({ status: 1, data: [{ hash: 'new-song', album_audio_id: 1 }] })); return }
    if (url.pathname === '/song/url') { response.end(JSON.stringify({ status: 1, url: [`${origin}/file`], extname: 'wav', filesize: audio.length })); return }
    if (url.pathname === '/file') {
      downloads++
      response.setHeader('Content-Length', audio.length)
      if (downloads === 1) { firstResponse = response; response.write(audio.subarray(0, 64)) }
      else response.end(audio)
      return
    }
    response.writeHead(404); response.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${server.address().port}`
  const f = await fixture(t, { apiBase: origin, allowLocalTestUrls: true })
  t.after(async () => { await f.engine().stop(); firstResponse?.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  const until = async callback => {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      const value = await callback()
      if (value) return value
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.fail('cache migration download timed out')
  }
  await f.send('cacheSong', { song: { hash: 'new-song' }, quality: '128' })
  await until(() => firstResponse)
  await f.send('prepareMigration', { targetRoot: f.target })
  assert.equal(downloads, 1)
  const files = await fs.readdir(path.join(f.target, f.accounts[0].account))
  assert.equal(files.some(name => /\.(?:part|tmp)$/.test(name)), false)
  await f.send('commitMigration')
  const source = await until(() => f.send('getSource', { hash: 'new-song', quality: '128' }))
  assert.equal(downloads, 2)
  assert.ok(source.path.startsWith(`${f.target}${path.sep}`))
  assert.deepEqual(await fs.readFile(source.path), audio)
  await f.send('finalizeMigration')
  assert.equal(await exists(f.source), false)
})
