const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

function fixture(overrides = {}) {
  const { api: apiOverrides, ...options } = overrides
  const context = vm.createContext({ AbortController })
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/utils/musicLibrary.js'), 'utf8').replace('export function', 'function'), context)
  const account = { userId: 'test-account', token: 'test-token' }
  const resource = { id: 'collection-test', listId: 23, isFavorite: true, isOwned: true }
  let songs = [{ hash: 'a', fileid: 11 }]
  let online = true
  const writes = []
  const commits = []
  const changes = []
  const api = {
    getAllPlaylistTracks: async () => songs.map(song => ({ ...song })),
    addPlaylistSongs: async (id, added) => { writes.push(['add', id]); songs.push(...added.map((song, i) => ({ ...song, fileid: 100 + i }))) },
    removePlaylistSongs: async (id, ids) => { writes.push(['remove', id, [...ids]]); songs = songs.filter(song => !ids.includes(song.fileid)) },
    ...apiOverrides
  }
  const library = context.createMusicLibrary({ api, getDirectory: async () => [resource],
    getIdentity: () => account, isOnline: () => online, onFavorites: value => commits.push(value),
    onPlaylistChanged: value => changes.push(value), ...options })
  return { library, account, resource, writes, commits, changes, api, setSongs: value => { songs = value }, offline: () => { online = false } }
}
const deferred = () => {
  let resolve, reject
  const promise = new Promise((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

test('cloud favorites use listId/fileid and only publish server-confirmed changes', async () => {
  const f = fixture()
  await f.library.refreshFavorites()
  await f.library.toggleFavorite({ hash: 'a' })
  assert.deepEqual(f.writes, [['remove', 23, [11]]])
  assert.equal(f.library.isFavorite({ hash: 'a' }), false)
  await f.library.toggleFavorite({ hash: 'b', name: 'Part, 2 | Live' })
  assert.equal(f.library.state.favorites[0].fileid, 100)
  assert.equal(f.library.isFavorite({ hash: 'B' }), true)
})

test('only explicit favorite actions authorize retrying a failed directory read', async () => {
  const reads = []
  const resource = { id: 'collection-test', listId: 23, isFavorite: true, isOwned: true }
  const f = fixture({ getDirectory: async options => { reads.push(options.retryDirectory === true); return [resource] } })
  await f.library.refreshFavorites()
  assert.deepEqual(reads, [false])
  await f.library.refreshFavorites({ retryDirectory: true })
  assert.deepEqual(reads, [false, true])
  f.library.reset(); reads.length = 0
  await f.library.toggleFavorite({ hash: 'b', name: 'New' })
  assert.deepEqual(reads, [true, false], 'only the user-triggered preflight can retry, never its automatic readback')
  reads.length = 0
  await f.library.clearFavorites()
  assert.deepEqual(reads, [true, false])
  reads.length = 0
  await f.library.bindFavorites(resource)
  assert.deepEqual(reads, [true, false])
})

test('ambiguous names or first playlist never become a write target', async () => {
  const f = fixture({ getDirectory: async () => [{ listId: 4, name: '喜欢的民谣' }, { listId: 3, name: '我喜欢的音乐' }] })
  await assert.rejects(f.library.toggleFavorite({ hash: 'x' }), /确认账号/)
  assert.equal(f.writes.length, 0)
})

test('an explicit account-bound favorite candidate selection enables subsequent reads', async () => {
  let binding = null
  const f = fixture({ getDirectory: async () => [{ id: 'collection-test', listId: 4, name: '我喜欢', favoriteCandidate: true }],
    getFavoriteBinding: () => binding, saveFavoriteBinding: (_user, id) => { binding = id } })
  await f.library.bindFavorites({ listId: 4 })
  assert.equal(binding, 4)
  assert.equal(f.library.state.resource.listId, 4)
  assert.equal(f.writes.length, 0)
})

test('offline edits and missing fileids never change local or remote favorites', async () => {
  const f = fixture()
  f.setSongs([{ hash: 'a' }])
  await f.library.refreshFavorites()
  await assert.rejects(f.library.toggleFavorite({ hash: 'a' }), /条目标识/)
  f.offline()
  await assert.rejects(f.library.toggleFavorite({ hash: 'b' }), /离线/)
  assert.equal(f.writes.length, 0)
  assert.equal(f.library.state.favorites.length, 1)
})

test('double click sends one request and keeps the confirmed heart while pending', async () => {
  const waiting = deferred()
  const f = fixture()
  const original = f.api.removePlaylistSongs
  f.api.removePlaylistSongs = async (...args) => { await waiting.promise; return original(...args) }
  await f.library.refreshFavorites()
  const one = f.library.toggleFavorite({ hash: 'a' })
  const two = f.library.toggleFavorite({ hash: 'a' })
  assert.equal(one, two)
  assert.equal(f.library.isFavorite({ hash: 'a' }), true)
  assert.equal(f.library.isFavoritePending({ hash: 'a' }), true)
  waiting.resolve()
  await one
  assert.equal(f.writes.length, 1)
  assert.equal(f.library.isFavoritePending({ hash: 'a' }), false)
})

test('different favorites serialize without a stale refresh overwriting another edit', async () => {
  const f = fixture()
  await f.library.refreshFavorites()
  await Promise.all([f.library.toggleFavorite({ hash: 'b' }), f.library.toggleFavorite({ hash: 'c' })])
  assert.equal(f.library.state.favorites.length, 3)
  assert.equal(f.writes.length, 2)
})

test('a timeout after successful server write is reconciled before retry', async () => {
  const f = fixture()
  const original = f.api.addPlaylistSongs
  f.api.addPlaylistSongs = async (...args) => { await original(...args); throw new Error('timeout') }
  await f.library.refreshFavorites()
  await f.library.toggleFavorite({ hash: 'b' })
  assert.equal(f.writes.length, 1)
  assert.equal(f.library.isFavorite({ hash: 'b' }), true)
  assert.equal(f.changes.length, 1)
})

test('account reset rejects late reads and never publishes old account data', async () => {
  const waiting = deferred()
  const f = fixture({ api: { getAllPlaylistTracks: () => waiting.promise } })
  const reading = f.library.refreshFavorites()
  await Promise.resolve()
  f.account.userId = 'different-account'
  f.library.reset()
  waiting.resolve([{ hash: 'old-account', fileid: 9 }])
  await assert.rejects(reading, /账号状态已改变/)
  assert.equal(f.library.state.favorites.length, 0)
  assert.equal(f.commits.length, 0)
})

test('public playlist cannot be edited and clearing requires every fileid', async () => {
  const f = fixture()
  await assert.rejects(f.library.addSongs({ listId: 8 }, [{ hash: 'a' }]), /不可编辑/)
  f.setSongs([{ hash: 'a' }])
  await assert.rejects(f.library.clearFavorites(), /条目标识/)
  assert.equal(f.writes.length, 0)
})

test('an in-flight UI refresh finishes before a queued edit and cannot overwrite its readback', async () => {
  const f = fixture()
  await f.library.refreshFavorites()
  const readStarted = deferred()
  const waiting = deferred()
  const originalRead = f.api.getAllPlaylistTracks
  let reads = 0
  f.api.getAllPlaylistTracks = async (...args) => {
    if (++reads === 1) { readStarted.resolve(); return waiting.promise }
    return originalRead(...args)
  }
  const refresh = f.library.refreshFavorites()
  await readStarted.promise
  const editing = f.library.toggleFavorite({ hash: 'b' })
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(f.writes.length, 0)
  waiting.resolve([{ hash: 'a', fileid: 11 }])
  await Promise.all([refresh, editing])
  assert.equal(f.library.isFavorite({ hash: 'b' }), true)
  assert.equal(f.library.state.favorites.find(song => song.hash === 'b').fileid, 100)
})

test('refresh requested during a write waits until the mutation and its readback finish', async () => {
  const f = fixture()
  await f.library.refreshFavorites()
  const started = deferred()
  const waiting = deferred()
  const originalAdd = f.api.addPlaylistSongs
  const originalRead = f.api.getAllPlaylistTracks
  let reads = 0
  f.api.getAllPlaylistTracks = (...args) => { reads++; return originalRead(...args) }
  f.api.addPlaylistSongs = async (...args) => { started.resolve(); await waiting.promise; return originalAdd(...args) }
  const editing = f.library.toggleFavorite({ hash: 'b' })
  await started.promise
  const refresh = f.library.refreshFavorites()
  await Promise.resolve()
  assert.equal(reads, 0)
  waiting.resolve()
  await Promise.all([editing, refresh])
  assert.equal(reads, 2)
  assert.equal(f.library.isFavorite({ hash: 'b' }), true)
})

test('failed refresh preserves the confirmed snapshot but forces a fresh read before another write', async () => {
  const f = fixture()
  await f.library.refreshFavorites()
  f.api.getAllPlaylistTracks = async () => { throw new Error('read unavailable') }
  await assert.rejects(f.library.refreshFavorites(), /read unavailable/)
  assert.equal(f.library.state.loaded, false)
  assert.equal(f.library.isFavorite({ hash: 'a' }), true)
  await assert.rejects(f.library.toggleFavorite({ hash: 'b' }), /read unavailable/)
  assert.equal(f.writes.length, 0)
})

test('a failed batch readback from the previous account cannot invalidate the newly loaded account', async () => {
  const f = fixture()
  await f.library.refreshFavorites()
  const started = deferred()
  const waiting = deferred()
  const originalRead = f.api.getAllPlaylistTracks
  f.api.removePlaylistSongs = async () => { throw new Error('write timeout') }
  f.api.getAllPlaylistTracks = () => { started.resolve(); return waiting.promise }
  const removing = f.library.removeSongs(f.resource, [{ hash: 'a', fileid: 11 }])
  const rejected = assert.rejects(removing, { code: 'STALE_ACCOUNT' })
  await started.promise
  f.account.userId = 'different-account'
  f.library.reset()
  f.api.getAllPlaylistTracks = originalRead
  f.setSongs([{ hash: 'new-account', fileid: 91 }])
  await f.library.refreshFavorites()
  waiting.reject(new Error('old read unavailable'))
  await rejected
  assert.equal(f.library.state.loaded, true)
  assert.equal(f.library.state.error, '')
  assert.equal(f.library.state.favorites[0].hash, 'new-account')
})

test('successful batch edit with failed readback cannot leave stale fileids editable', async () => {
  const f = fixture()
  await f.library.refreshFavorites()
  f.api.getAllPlaylistTracks = async () => { throw new Error('read unavailable') }
  await assert.rejects(f.library.removeSongs(f.resource, [{ hash: 'a', fileid: 11 }]), /修改已成功/)
  assert.equal(f.library.state.loaded, false)
  assert.equal(f.writes.length, 1)
  await assert.rejects(f.library.toggleFavorite({ hash: 'a' }), /read unavailable/)
  assert.equal(f.writes.length, 1)
})

test('clear reconciles a timeout after server success and invalidates an unreadable result', async () => {
  const f = fixture()
  const originalRemove = f.api.removePlaylistSongs
  f.api.removePlaylistSongs = async (...args) => { await originalRemove(...args); throw new Error('write timeout') }
  await f.library.clearFavorites()
  assert.equal(f.library.state.favorites.length, 0)
  assert.equal(f.writes.length, 1)
  f.setSongs([{ hash: 'a', fileid: 11 }])
  const originalRead = f.api.getAllPlaylistTracks
  let reads = 0
  f.api.getAllPlaylistTracks = (...args) => ++reads === 1 ? originalRead(...args) : Promise.reject(new Error('read unavailable'))
  f.api.removePlaylistSongs = originalRemove
  await assert.rejects(f.library.clearFavorites(), /清空已成功/)
  assert.equal(f.library.state.loaded, false)
})

test('clear uses batches of at most 1000 and publishes confirmed partial results on failure', async () => {
  const f = fixture()
  f.setSongs(Array.from({ length: 1001 }, (_, i) => ({ hash: `song-${i}`, fileid: i + 1 })))
  const originalRemove = f.api.removePlaylistSongs
  let batches = 0
  f.api.removePlaylistSongs = async (...args) => {
    if (++batches === 2) throw new Error('second batch failed')
    return originalRemove(...args)
  }
  await assert.rejects(f.library.clearFavorites(), /second batch failed/)
  assert.equal(f.writes[0][2].length, 1000)
  assert.equal(f.library.state.loaded, true)
  assert.equal(f.library.state.favorites.length, 1)
  assert.equal(f.library.state.favorites[0].fileid, 1001)
})

test('binding changes share the read queue and cannot be overwritten by a pending old binding read', async () => {
  let binding = 1
  const waiting = deferred()
  const started = deferred()
  const f = fixture({ getDirectory: async () => [
    { listId: 1, favoriteCandidate: true }, { listId: 2, favoriteCandidate: true }
  ], getFavoriteBinding: () => binding, saveFavoriteBinding: (_user, value) => { binding = value },
  api: { getAllPlaylistTracks: resource => {
    if (resource.listId === 1) { started.resolve(); return waiting.promise }
    return Promise.resolve([{ hash: 'new-binding', fileid: 21 }])
  } } })
  const refresh = f.library.refreshFavorites()
  await started.promise
  const changing = f.library.bindFavorites({ listId: 2 })
  await Promise.resolve()
  assert.equal(binding, 1)
  waiting.resolve([{ hash: 'old-binding', fileid: 11 }])
  await Promise.all([refresh, changing])
  assert.equal(binding, 2)
  assert.equal(f.library.state.resource.listId, 2)
  assert.equal(f.library.state.favorites[0].hash, 'new-binding')
})

test('a resource explicitly belonging to a previous owner cannot target the new account listid', async () => {
  const f = fixture()
  await assert.rejects(f.library.addSongs({ listId: 23, isOwned: true, ownerId: 'old-account' }, [{ hash: 'a' }]), /不属于当前账号/)
  assert.equal(f.writes.length, 0)
})

test('editing the confirmed favorite through an ordinary directory entry still refreshes shared hearts', async () => {
  const f = fixture()
  await f.library.refreshFavorites()
  await f.library.addSongs({ id: f.resource.id, listId: 23, isOwned: true, isFavorite: false }, [{ hash: 'b' }])
  assert.equal(f.library.isFavorite({ hash: 'b' }), true)
  assert.equal(f.library.state.favorites.find(song => song.hash === 'b').fileid, 100)
})

test('account-owned offline snapshots hydrate shared hearts without authorizing or replaying writes', async () => {
  const f = fixture()
  let reads = 0
  const originalRead = f.api.getAllPlaylistTracks
  f.api.getAllPlaylistTracks = (...args) => { reads++; return originalRead(...args) }
  const cached = [{ hash: 'cached', fileid: 50 }]
  assert.equal(f.library.hydrateFavorites(cached, f.resource, { userId: 'other-account' }), false)
  assert.equal(f.library.hydrateFavorites(cached, f.resource), false)
  assert.equal(f.library.hydrateFavorites(cached, f.resource, { userId: f.account.userId }), true)
  assert.equal(f.library.isFavorite({ hash: 'cached' }), true)
  assert.equal(f.library.state.loaded, false)
  assert.equal(f.library.state.offlineSnapshot, true)
  assert.equal(f.library.state.resource, null)
  assert.equal(f.commits.length, 0)
  assert.equal(reads, 0)
  assert.equal(f.writes.length, 0)
  cached[0].hash = 'mutated-cache'
  assert.equal(f.library.isFavorite({ hash: 'cached' }), true)
  await f.library.toggleFavorite({ hash: 'a' })
  assert.equal(reads, 2)
  assert.deepEqual(f.writes, [['remove', 23, [11]]])
  assert.equal(f.library.state.offlineSnapshot, false)
  assert.equal(f.library.isFavorite({ hash: 'cached' }), false)
})

test('a late cache snapshot cannot overwrite confirmed empty cloud favorites, even after a later read failure', async () => {
  const f = fixture()
  f.setSongs([])
  await f.library.refreshFavorites()
  const cached = [{ hash: 'stale', fileid: 9 }]
  assert.equal(f.library.hydrateFavorites(cached, f.resource, { userId: f.account.userId }), false)
  f.api.getAllPlaylistTracks = async () => { throw new Error('network failed') }
  await assert.rejects(f.library.refreshFavorites(), /network failed/)
  assert.equal(f.library.hydrateFavorites(cached, f.resource, { userId: f.account.userId }), false)
  assert.equal(f.library.state.favorites.length, 0)
  f.library.reset()
  assert.equal(f.library.hydrateFavorites(cached, f.resource, { userId: f.account.userId }), true)
})

test('initial cloud reads may show a verified cache temporarily and replace it when the response arrives', async () => {
  const waiting = deferred()
  const f = fixture({ api: { getAllPlaylistTracks: () => waiting.promise } })
  const reading = f.library.refreshFavorites()
  assert.equal(f.library.hydrateFavorites([{ hash: 'cached' }], f.resource, { userId: f.account.userId }), true)
  waiting.resolve([{ hash: 'fresh', fileid: 5 }])
  await reading
  assert.equal(f.library.state.offlineSnapshot, false)
  assert.equal(f.library.isFavorite({ hash: 'fresh' }), true)
  assert.equal(f.library.isFavorite({ hash: 'cached' }), false)
})
