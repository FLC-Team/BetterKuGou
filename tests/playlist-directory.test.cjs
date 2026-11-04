const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const root = path.join(__dirname, '..')
function load(file, globals = {}) {
  const raw = fs.readFileSync(path.join(root, file), 'utf8')
  const names = [...raw.matchAll(/^export (?:async )?(?:function|const) (\w+)/gm)].map(match => match[1])
  const source = raw.replace(/^import[^\n]*\n/gm, '').replace(/^export /gm, '')
  return vm.runInNewContext(`${source}\n;({ ${names.join(',')} })`, globals)
}
const metadata = load('src/utils/libraryMetadata.js', load('src/utils/songMetadata.js'))
const { createMusicLibrary } = load('src/utils/musicLibrary.js', { AbortController })
const plain = value => JSON.parse(JSON.stringify(value))
const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

// Match the reported v7 container and flags without retaining account or playlist content.
const directoryRows = count => Array.from({ length: count }, (_, index) => ({
  listid: index + 1,
  global_collection_id: `fixture_collection_${index + 1}`,
  list_create_userid: 123,
  name: index === 1 ? '我喜欢' : `Fixture playlist ${index + 1}`,
  ...(index < 2 ? { is_def: index + 1 } : {}),
  count: index === 1 ? 988 : 0,
  is_del: 0,
}))
const directoryResponse = (info, directoryCount = info.length) => ({ status: 1, error_code: 0, data: {
  info, list_count: directoryCount, collect_count: 0, album_count: 0, total_ver: 1,
} })
const songRows = count => Array.from({ length: count }, (_, index) => ({
  hash: `fixture_hash_${index + 1}`, name: `Fixture song ${index + 1}`, fileid: 1000 + index,
}))

/** Only the HTTP boundary is substituted; directory and track pagination use the production API. */
function fixture(respond) {
  const storage = new Map([['kugou_userid', '123'], ['kugou_token', 'placeholder-token']])
  const requests = []
  const bindings = new Map()
  const publications = []
  const apiClient = {
    async get(route, config) {
      const request = { route, method: 'get', params: config.params, signal: config.signal }
      requests.push(request)
      return respond(request)
    },
    async post(route) {
      requests.push({ route, method: 'post' })
      throw new Error('Reading an account library must not write to the upstream service')
    },
  }
  const api = load('src/api/library.js', {
    ...metadata, apiClient, localStorage: { getItem: key => storage.get(key) ?? null },
  })
  const library = createMusicLibrary({
    api,
    getIdentity: () => ({ userId: storage.get('kugou_userid'), token: storage.get('kugou_token') }),
    getDirectory: options => api.getAllUserPlaylists(options),
    getFavoriteBinding: userId => bindings.get(userId),
    saveFavoriteBinding: (userId, listId) => bindings.set(userId, listId),
    onFavorites: (songs, resource) => publications.push({ songs: plain(songs), resource: plain(resource) }),
  })
  return { api, library, storage, requests, bindings, publications }
}

test('the reported seven-entry v7 directory finishes without requesting an out-of-range page', async () => {
  const f = fixture(({ route, params }) => {
    assert.equal(route, '/user/playlist')
    assert.equal(params.page, 1, 'a complete short directory must not request page two')
    return directoryResponse(directoryRows(7))
  })
  const playlists = await f.api.getAllUserPlaylists()
  assert.equal(playlists.length, 7)
  assert.deepEqual(f.requests.map(({ params }) => [params.page, params.pagesize]), [[1, 30]])
  assert.equal(playlists[1].id, 'fixture_collection_2')
  assert.equal(playlists[1].listId, 2)
  assert.equal(playlists[1].isFavorite, false)
  assert.equal(playlists[1].favoriteCandidate, true)
})

test('a confirmed favorite binding loads all 988 tracks through the real directory and track paginators', async () => {
  const songs = songRows(988)
  const f = fixture(({ route, params }) => {
    if (route === '/user/playlist') {
      assert.equal(params.page, 1)
      return directoryResponse(directoryRows(7))
    }
    assert.equal(route, '/playlist/track/all/new')
    assert.equal(params.listid, '2')
    const pageSize = Math.min(params.pagesize, 37)
    const start = (params.page - 1) * pageSize
    return { status: 1, data: { count: songs.length, songs: songs.slice(start, start + pageSize) } }
  })
  f.bindings.set('123', 2)
  await f.library.refreshFavorites()
  assert.equal(f.library.state.loaded, true)
  assert.equal(f.library.state.error, '')
  assert.equal(f.library.state.favorites.length, 988)
  assert.equal(f.library.state.favorites.at(-1).fileid, 1987)
  assert.equal(f.library.state.favorites.at(-1).hash, 'fixture_hash_988')
  assert.deepEqual(plain(f.library.state.favorites.map(({ hash, fileid }) => ({ hash, fileid }))),
    songs.map(({ hash, fileid }) => ({ hash, fileid })))
  assert.equal(f.library.state.resource.listId, 2)
  assert.equal(f.publications.length, 1, 'only a fully collected snapshot is published')
  assert.equal(f.requests.filter(({ route }) => route === '/user/playlist').length, 1)
  const trackRequests = f.requests.filter(({ route }) => route === '/playlist/track/all/new')
  assert.equal(trackRequests.length, Math.ceil(988 / 37))
  assert.equal(trackRequests[0].params.pagesize, 100, 'directory page-size policy must not affect tracks')
  assert.ok(trackRequests.slice(1).every(({ params }) => params.pagesize === 37))
  assert.ok(f.requests.every(({ method }) => method === 'get'))
})

test('an unbound v7 system flag remains a candidate until the user confirms the favorite binding', async () => {
  const f = fixture(({ route, params }) => {
    if (route === '/user/playlist') {
      assert.equal(params.page, 1)
      return directoryResponse(directoryRows(7))
    }
    assert.equal(route, '/playlist/track/all/new')
    return { status: 1, data: { songs: songRows(1), count: 1 } }
  })
  await assert.rejects(f.library.refreshFavorites(), /确认账号的收藏歌单/)
  assert.equal(f.library.state.favoriteCandidates.length, 1)
  assert.equal(f.library.state.favoriteCandidates[0].listId, 2)
  assert.equal(f.bindings.size, 0)
  assert.equal(f.publications.length, 0)
  assert.ok(f.requests.every(({ route }) => route === '/user/playlist'))

  await f.library.bindFavorites(f.library.state.favoriteCandidates[0])
  assert.equal(f.bindings.get('123'), 2)
  assert.equal(f.library.state.loaded, true)
  assert.equal(f.library.state.favorites.length, 1)
  assert.ok(f.requests.every(({ method }) => method === 'get'))
})

test('a malformed directory preserves confirmed favorites and an explicit refresh can recover', async () => {
  let available = true
  let songs = songRows(1)
  const f = fixture(({ route, params }) => {
    if (route === '/user/playlist') {
      assert.equal(params.page, 1)
      return available ? directoryResponse(directoryRows(7)) : { status: 1, data: {} }
    }
    assert.equal(route, '/playlist/track/all/new')
    return { status: 1, data: { songs, count: songs.length } }
  })
  f.bindings.set('123', 2)
  await f.library.refreshFavorites()
  const original = plain(f.library.state.favorites)
  available = false
  await assert.rejects(f.library.refreshFavorites({ retryDirectory: true }), /列表响应格式无效/)
  assert.deepEqual(plain(f.library.state.favorites), original)
  assert.equal(f.library.state.loaded, false)
  assert.equal(f.publications.length, 1)

  available = true
  songs = songRows(2)
  await f.library.refreshFavorites({ retryDirectory: true })
  assert.equal(f.library.state.loaded, true)
  assert.equal(f.library.state.error, '')
  assert.equal(f.library.state.favorites.length, 2)
  assert.equal(f.publications.length, 2)
})

test('an old account directory page cannot publish into the new account library', async () => {
  const secondPage = deferred()
  const secondStarted = deferred()
  const rows = directoryRows(37)
  const f = fixture(({ route, params }) => {
    assert.equal(route, '/user/playlist', 'stale directory results must never reach track loading')
    if (params.page === 1) return directoryResponse(rows.slice(0, 30), rows.length)
    assert.equal(params.page, 2)
    secondStarted.resolve()
    return secondPage.promise
  })
  f.bindings.set('123', 2)
  const pending = f.library.refreshFavorites()
  const rejected = assert.rejects(pending, { code: 'ERR_CANCELED' })
  await secondStarted.promise
  f.storage.set('kugou_userid', '456')
  f.storage.set('kugou_token', 'second-placeholder-token')
  f.library.reset()
  assert.equal(f.library.hydrateFavorites([{ hash: 'new_account_snapshot', name: 'Fixture cached song' }], null,
    { userId: '456' }), true)
  secondPage.resolve(directoryResponse(rows.slice(30), rows.length))
  await rejected
  assert.equal(f.library.state.favorites[0].hash, 'new_account_snapshot')
  assert.equal(f.library.state.offlineSnapshot, true)
  assert.equal(f.library.state.error, '')
  assert.equal(f.publications.length, 0)
})
