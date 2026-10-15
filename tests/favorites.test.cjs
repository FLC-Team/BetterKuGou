const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

function deferred() {
  let resolve
  let reject
  const promise = new Promise((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function page(songs, count = songs.length) {
  return { status: 1, data: { songs, count } }
}

function loadFavorites({ props = {}, api = {}, cache = {} } = {}) {
  const storage = new Map(Object.entries({ kugou_userid: 'account-a', kugou_token: 'example-token-a', ...cache }))
  const writes = []
  const emitted = []
  const calls = { directory: [], tracks: [] }
  const timers = new Map()
  let timerId = 0
  const menuManager = {
    active: null,
    closeActiveMenu() { this.active?.(); this.active = null },
    registerMenu(callback) { this.active = callback },
    unregisterMenu(callback) { if (this.active === callback) this.active = null }
  }
  const logger = { trace() {}, info() {}, warn() {}, error() {} }
  const metadata = vm.createContext({})
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/utils/songMetadata.js'), 'utf8').replace(/^export /gm, ''), metadata)
  const source = fs.readFileSync(path.join(__dirname, '../src/views/logic/FavoriteView.js'), 'utf8')
    .replace(/^import\b[^\n]+$/gm, '')
    .replace('export default', 'module.exports =')
  const sandbox = vm.createContext({
    module: { exports: {} },
    ContextMenu: {},
    ArtworkCover: {},
    SongBadges: {},
    filterSongs: metadata.filterSongs,
    nextplayIcon: 'nextplay.svg',
    contextMenuManager: menuManager,
    logger,
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem(key, value) { storage.set(key, String(value)); writes.push(['set', key]) },
      removeItem(key) { storage.delete(key); writes.push(['remove', key]) }
    },
    getUserPlaylists(...args) {
      calls.directory.push(args)
      return api.getUserPlaylists?.(...args) ?? Promise.resolve({ status: 1, data: { info: [{ name: '我喜欢的音乐', global_collection_id: 10 }] } })
    },
    getPlaylistTracks(...args) {
      calls.tracks.push(args)
      return api.getPlaylistTracks?.(...args) ?? Promise.resolve(page([{ hash: 'song-a', name: '示例歌曲' }]))
    },
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id },
    clearTimeout(id) { timers.delete(id) },
    confirm: () => true,
    alert() {}
  })
  vm.runInContext(source, sandbox)
  const options = sandbox.module.exports
  const view = {
    ...options.data(),
    currentSong: null,
    playlistId: null,
    playlistName: '',
    userPlaylists: null,
    playlistsLoaded: true,
    settings: { playback: {} },
    ...props,
    $emit: (...args) => emitted.push(args),
    $nextTick: callback => Promise.resolve().then(callback)
  }
  for (const [name, method] of Object.entries(options.methods)) view[name] = method.bind(view)
  for (const [name, getter] of Object.entries(options.computed)) Object.defineProperty(view, name, { get: () => getter.call(view) })
  return {
    view, storage, writes, emitted, calls, timers, menuManager,
    activate() { options.activated.call(view); return view.loadPromise || Promise.resolve() },
    deactivate() { options.deactivated.call(view) },
    unmount() { options.beforeUnmount.call(view) },
    ready(playlists) {
      view.userPlaylists = playlists
      view.playlistsLoaded = true
      options.watch.playlistsLoaded.call(view, true)
      return view.loadPromise
    }
  }
}

test('favorites reuse the supplied directory, wait for readiness, and share an in-flight request', async () => {
  const response = deferred()
  const favorites = loadFavorites({
    props: { userPlaylists: [], playlistsLoaded: false },
    api: { getPlaylistTracks: () => response.promise }
  })
  await favorites.view.loadFavorites()
  assert.equal(favorites.calls.directory.length, 0)
  assert.equal(favorites.calls.tracks.length, 0)
  assert.equal(favorites.view.loading, true)
  const request = favorites.ready([{ id: 42, name: '我喜欢的音乐' }])
  assert.equal(favorites.view.loadFavorites(), request)
  assert.equal(favorites.activate(), request)
  assert.equal(favorites.calls.tracks.length, 1)
  assert.equal(favorites.calls.tracks[0][0], 42)
  response.resolve(page([{ hash: 'favorite-a' }]))
  await request
  assert.equal(favorites.view.loaded, true)
  assert.equal(favorites.storage.get('favorite_songs_userid'), 'account-a')
  await favorites.activate()
  assert.equal(favorites.calls.directory.length, 0)
  assert.equal(favorites.calls.tracks.length, 1)
})

test('ordinary playlists load only their own tracks and expose no local favorite operations', async () => {
  const favorites = loadFavorites({ props: { playlistId: 87, playlistName: '晚间歌单', playlistsLoaded: false } })
  await favorites.view.loadFavorites()
  assert.equal(favorites.view.pageTitle, '晚间歌单')
  assert.equal(favorites.calls.directory.length, 0)
  assert.equal(favorites.calls.tracks[0][0], 87)
  assert.equal(favorites.writes.length, 0)
  favorites.view.currentContextSong = favorites.view.favoriteList[0]
  assert.equal(favorites.view.contextMenuItems.some(item => item.favoriteAction), false)
  favorites.view.removeFavorite(favorites.view.favoriteList[0])
  favorites.view.addFavorite({ hash: 'extra-song' })
  assert.equal(favorites.view.favoriteList.length, 1)
  assert.equal(favorites.emitted.length, 0)
})

test('force refresh retains old rows while loading and skips the known directory', async () => {
  const refreshed = deferred()
  let requests = 0
  const favorites = loadFavorites({
    api: { getPlaylistTracks: () => ++requests === 1 ? Promise.resolve(page([{ hash: 'old-song' }])) : refreshed.promise }
  })
  await favorites.view.loadFavorites()
  const oldList = favorites.view.favoriteList
  const request = favorites.view.loadFavorites(true)
  assert.equal(favorites.view.favoriteList, oldList)
  assert.equal(favorites.view.loading, true)
  assert.equal(favorites.calls.directory.length, 1)
  assert.equal(favorites.view.loadFavorites(true), request)
  refreshed.resolve(page([{ hash: 'new-song' }]))
  await request
  assert.notEqual(favorites.view.favoriteList, oldList)
  assert.equal(favorites.view.favoriteList[0].hash, 'new-song')
  assert.equal(favorites.view.loading, false)
  assert.equal(favorites.calls.directory.length, 1)
})

test('any failed page preserves the previous complete list and cache, then allows retry', async () => {
  let refreshing = false
  const favorites = loadFavorites({
    api: {
      getPlaylistTracks(id, number) {
        if (!refreshing) return Promise.resolve(page([{ hash: 'complete-old-song' }]))
        if (number === 1) return Promise.resolve(page(Array.from({ length: 300 }, (_, index) => ({ hash: `partial-${index}` })), 301))
        return Promise.resolve({ status: 0, error: '第二页失败' })
      }
    }
  })
  await favorites.view.loadFavorites()
  const oldList = favorites.view.favoriteList
  const oldCache = favorites.storage.get('favorite_songs')
  refreshing = true
  await favorites.view.loadFavorites(true)
  assert.equal(favorites.calls.tracks.at(-1)[1], 2)
  assert.equal(favorites.view.favoriteList, oldList)
  assert.equal(favorites.storage.get('favorite_songs'), oldCache)
  assert.match(favorites.view.errorMessage, /第二页失败/)
  assert.equal(favorites.view.loading, false)
  refreshing = false
  await favorites.view.loadFavorites(true)
  assert.equal(favorites.view.errorMessage, '')
  assert.equal(favorites.calls.directory.length, 1)
})

test('an empty supplied directory reports a retryable error and manual refresh can resolve it', async () => {
  const favorites = loadFavorites({ props: { userPlaylists: [] } })
  await favorites.view.loadFavorites()
  assert.equal(favorites.view.loaded, false)
  assert.match(favorites.view.errorMessage, /收藏歌单/)
  assert.equal(favorites.calls.directory.length, 0)
  await favorites.view.loadFavorites(true)
  assert.equal(favorites.view.loaded, true)
  assert.equal(favorites.calls.directory.length, 1)
  assert.equal(favorites.calls.tracks.length, 1)
})

for (const credentials of [
  { kugou_userid: 'account-b', kugou_token: 'example-token-b' },
  { kugou_userid: 'account-a', kugou_token: 'example-refreshed-token' }
]) {
  test(`late responses cannot overwrite a new ${credentials.kugou_userid === 'account-a' ? 'token' : 'account'} request`, async () => {
    const oldResponse = deferred()
    const newResponse = deferred()
    let count = 0
    const favorites = loadFavorites({
      props: { userPlaylists: [{ name: '我喜欢', id: 10 }] },
      api: { getPlaylistTracks: () => ++count === 1 ? oldResponse.promise : newResponse.promise }
    })
    const oldRequest = favorites.view.loadFavorites()
    for (const [key, value] of Object.entries(credentials)) favorites.storage.set(key, value)
    const newRequest = favorites.view.loadFavorites()
    newResponse.resolve(page([{ hash: 'new-identity-song' }]))
    await newRequest
    const list = favorites.view.favoriteList
    const writes = favorites.writes.length
    oldResponse.resolve(page([{ hash: 'old-identity-song' }]))
    await oldRequest
    assert.equal(favorites.view.favoriteList, list)
    assert.equal(favorites.writes.length, writes)
    assert.equal(favorites.storage.get('favorite_songs_userid'), credentials.kugou_userid)
    assert.equal(JSON.parse(favorites.storage.get('favorite_songs'))[0].hash, 'new-identity-song')
  })
}

test('unmount ignores pending success and clears the play timer and menu registration', async () => {
  const response = deferred()
  const favorites = loadFavorites({
    props: { playlistId: 11 },
    api: { getPlaylistTracks: () => response.promise }
  })
  const request = favorites.view.loadFavorites()
  favorites.view.playSong({ hash: 'played-song' })
  favorites.view.showContextMenu({ clientX: 10, clientY: 20 }, { hash: 'menu-song' })
  await Promise.resolve()
  assert.equal(favorites.timers.size, 1)
  assert.ok(favorites.menuManager.active)
  favorites.unmount()
  assert.equal(favorites.timers.size, 0)
  assert.equal(favorites.menuManager.active, null)
  response.resolve(page([{ hash: 'late-song' }]))
  await request
  assert.equal(favorites.view.favoriteList.length, 0)
  assert.equal(favorites.writes.length, 0)
})

test('deactivation closes queued menus while retaining an in-flight load for reactivation', async () => {
  const response = deferred()
  const favorites = loadFavorites({ api: { getPlaylistTracks: () => response.promise } })
  const request = favorites.view.loadFavorites()
  await Promise.resolve()
  favorites.view.showContextMenu({ clientX: 10, clientY: 20 }, { hash: 'menu-song' })
  favorites.deactivate()
  await Promise.resolve()
  assert.equal(favorites.view.contextMenuVisible, false)
  assert.equal(favorites.menuManager.active, null)
  assert.equal(favorites.view.isDisposed, false)
  assert.equal(favorites.view.loadPromise, request)
  response.resolve(page([{ hash: 'loaded-while-away' }]))
  await request
  await favorites.activate()
  assert.equal(favorites.view.favoriteList[0].hash, 'loaded-while-away')
  assert.equal(favorites.calls.tracks.length, 1)
})

for (const owner of [null, 'another-account', 'account-a']) {
  test(`fallback accepts only the current cache owner (${owner || 'unknown owner'})`, async () => {
    const cache = { favorite_songs: JSON.stringify([{ hash: 'cached-song' }]) }
    if (owner) cache.favorite_songs_userid = owner
    const favorites = loadFavorites({
      props: { userPlaylists: [{ id: 10, name: '我喜欢' }] },
      cache,
      api: { getPlaylistTracks: async () => { throw new Error('请求失败') } }
    })
    await favorites.view.loadFavorites()
    assert.equal(favorites.view.favoriteList.length, owner === 'account-a' ? 1 : 0)
    assert.equal(favorites.view.loaded, false)
    assert.match(favorites.view.errorMessage, /请求失败/)
    assert.equal(favorites.writes.length, 0)
  })
}

test('local favorite edits preserve other row references, emit changes, and never reload tracks', async () => {
  const favorites = loadFavorites({ api: { getPlaylistTracks: async () => page([{ hash: 'first' }, { hash: 'second' }]) } })
  await favorites.view.loadFavorites()
  favorites.emitted.length = 0
  const list = favorites.view.favoriteList
  const retainedRow = list[1]
  favorites.view.removeFavorite(list[0])
  assert.equal(favorites.view.favoriteList, list)
  assert.equal(favorites.view.favoriteList[0], retainedRow)
  favorites.view.addFavorite({ hash: 'third' })
  favorites.view.addFavorite({ hash: 'third' })
  await favorites.activate()
  assert.equal(favorites.calls.tracks.length, 1)
  assert.equal(favorites.emitted.filter(([name]) => name === 'favorites-changed').length, 2)
  assert.equal(JSON.parse(favorites.storage.get('favorite_songs')).map(song => song.hash).join(','), 'second,third')
})

test('local edits during refresh survive its stale response, and stale identity cannot edit rows', async () => {
  const response = deferred()
  let count = 0
  const favorites = loadFavorites({
    api: { getPlaylistTracks: () => ++count === 1 ? Promise.resolve(page([{ hash: 'keep' }, { hash: 'remove' }])) : response.promise }
  })
  await favorites.view.loadFavorites()
  favorites.emitted.length = 0
  const request = favorites.view.loadFavorites(true)
  favorites.view.removeFavorite(favorites.view.favoriteList[1])
  response.resolve(page([{ hash: 'keep' }, { hash: 'remove' }]))
  await request
  assert.equal(favorites.view.favoriteList.length, 1)
  favorites.storage.set('kugou_token', 'example-new-token')
  favorites.view.removeFavorite(favorites.view.favoriteList[0])
  assert.equal(favorites.view.favoriteList.length, 1)
  assert.equal(favorites.emitted.filter(([name]) => name === 'favorites-changed').length, 1)
})

test('complete cloud loads notify linked pages only when favorite song seeds change', async () => {
  let songs = [{ hash: 'seed-a', name: 'original' }, { album_audio_id: 22 }]
  const favorites = loadFavorites({ api: { getPlaylistTracks: async () => page(songs) } })
  await favorites.view.loadFavorites()
  const changes = () => favorites.emitted.filter(([name]) => name === 'favorites-changed')
  assert.equal(changes().length, 1, 'the initial owned cache must notify an already cached Home page')
  assert.equal(favorites.storage.get('favorite_songs_userid'), 'account-a')
  songs = [{ hash: 'seed-a', name: 'metadata changed' }, { album_audio_id: 22 }]
  await favorites.view.loadFavorites(true)
  assert.equal(changes().length, 1, 'metadata-only refreshes retain the same seeds')
  songs = [{ hash: 'seed-b' }, { album_audio_id: 22 }]
  await favorites.view.loadFavorites(true)
  assert.equal(changes().length, 2)
  songs = [{ hash: 'seed-b' }, { album_audio_id: 23 }]
  await favorites.view.loadFavorites(true)
  assert.equal(changes().length, 3, 'legacy audio IDs participate when hashes are absent')
  assert.equal(favorites.calls.directory.length, 1)
})

test('matching owned cloud cache causes no redundant notification and foreign cache is ignored', async () => {
  for (const owner of ['account-a', 'another-account']) {
    const favorites = loadFavorites({
      cache: { favorite_songs: JSON.stringify([{ hash: 'same-song' }]), favorite_songs_userid: owner },
      api: { getPlaylistTracks: async () => page([{ hash: 'same-song' }]) }
    })
    await favorites.view.loadFavorites()
    assert.equal(favorites.emitted.filter(([name]) => name === 'favorites-changed').length, owner === 'account-a' ? 0 : 1)
    await favorites.view.loadFavorites(true)
    assert.equal(favorites.emitted.filter(([name]) => name === 'favorites-changed').length, owner === 'account-a' ? 0 : 1)
  }
})

test('a 925-song playlist loads every page and searches names, artists and albums beyond the first page', async () => {
  const tracks = Array.from({ length: 925 }, (_, index) => ({ hash: `song-${index}`, name: `Song ${index}` }))
  tracks[902] = { ...tracks[902], name: 'Late Night', singerinfo: [{ name: 'The Artist' }], albuminfo: { name: 'Night Album' } }
  const favorites = loadFavorites({
    props: { playlistId: 91 },
    api: { getPlaylistTracks: async (_id, number, size) => page(tracks.slice((number - 1) * size, number * size), tracks.length) }
  })
  await favorites.view.loadFavorites()
  assert.equal(favorites.view.favoriteList.length, 925)
  assert.deepEqual(favorites.calls.tracks.map(call => call[1]), [1, 2, 3, 4])
  const complete = favorites.view.favoriteList
  const row = complete[902]
  for (const keyword of ['late NIGHT', 'the ARTIST', 'night ALBUM']) {
    favorites.view.searchQuery = keyword
    assert.equal(favorites.view.filteredFavoriteList.length, 1)
    assert.equal(favorites.view.filteredFavoriteList[0], row)
    assert.equal(favorites.view.filteredFavoriteList[0].index, 903)
  }
  favorites.view.searchQuery = 'not-in-this-playlist'
  assert.equal(favorites.view.filteredFavoriteList.length, 0)
  assert.equal(favorites.view.favoriteList, complete)
  favorites.view.searchQuery = '  '
  assert.equal(favorites.view.filteredFavoriteList, complete)
  favorites.view.searchQuery = ''
  assert.equal(favorites.view.hasSearchQuery, false)
  assert.equal(favorites.calls.tracks.length, 4, 'local searches never refetch or trim the playlist')
})

test('search and sorting keep row identity, whole-playlist playback and right-click operations', async () => {
  const favorites = loadFavorites({
    props: { playlistId: 91 },
    api: { getPlaylistTracks: async () => page([{ hash: 'a', name: 'A' }, { hash: 'b', name: 'Matched B' }, { hash: 'c', name: 'Matched C' }]) }
  })
  await favorites.view.loadFavorites()
  const complete = favorites.view.favoriteList
  favorites.view.searchQuery = 'matched'
  favorites.view.sortOrder = 'desc'
  assert.equal(favorites.view.filteredFavoriteList.map(song => song.hash).join(','), 'c,b')
  assert.equal(complete.map(song => song.hash).join(','), 'a,b,c')
  favorites.view.playAll()
  assert.equal(favorites.emitted.at(-1)[1], complete)
  favorites.view.settings.playback.enqueueFullPlaylist = true
  const selected = favorites.view.filteredFavoriteList[0]
  favorites.view.playSong(selected)
  assert.equal(favorites.emitted.at(-1)[0], 'play-all')
  assert.equal(favorites.emitted.at(-1)[1].map(song => song.hash).join(','), 'c,a,b')
  assert.equal(favorites.emitted.at(-1)[1][0], complete[2])
  favorites.view.showContextMenu({ clientX: 12, clientY: 24 }, selected)
  await Promise.resolve()
  favorites.view.contextMenuItems.find(item => item.label === '下一首播放').action()
  assert.equal(favorites.emitted.at(-1)[1], selected)
  assert.equal(favorites.view.favoriteList, complete)
  favorites.unmount()
})

test('cached playlists retain separate search text on reactivation, refresh, and reset it on identity changes', async () => {
  const first = loadFavorites({ props: { playlistId: 1 } })
  const second = loadFavorites({ props: { playlistId: 2 } })
  await first.view.loadFavorites()
  await second.view.loadFavorites()
  first.view.searchQuery = 'first query'
  second.view.searchQuery = 'second query'
  first.deactivate()
  await first.activate()
  await first.view.loadFavorites(true)
  assert.equal(first.view.searchQuery, 'first query')
  assert.equal(second.view.searchQuery, 'second query')
  first.view.playlistId = 3
  await first.view.loadFavorites()
  assert.equal(first.view.searchQuery, '')
  first.view.searchQuery = 'private query'
  first.storage.set('kugou_userid', 'account-b')
  await first.view.loadFavorites()
  assert.equal(first.view.searchQuery, '')
})

test('server page-size caps do not skip playlist rows and incomplete pages preserve the old complete list', async () => {
  const tracks = Array.from({ length: 925 }, (_, index) => ({ hash: `song-${index}` }))
  let truncated = false
  const favorites = loadFavorites({
    props: { playlistId: 91 },
    api: { getPlaylistTracks: async (_id, number, size) => page(tracks.slice((number - 1) * size, (number - 1) * size + (truncated && number === 2 ? 0 : Math.min(size, 100))), tracks.length) }
  })
  await favorites.view.loadFavorites()
  assert.equal(favorites.view.favoriteList.length, 925)
  assert.equal(new Set(favorites.view.favoriteList.map(song => song.hash)).size, 925)
  assert.equal(favorites.calls.tracks[0][2], 300)
  assert.equal(favorites.calls.tracks[1][2], 100)
  const complete = favorites.view.favoriteList
  truncated = true
  await favorites.view.loadFavorites(true)
  assert.equal(favorites.view.favoriteList, complete)
  assert.match(favorites.view.errorMessage, /未加载完整/)
})

test('missing playlist totals keep loading full pages until the actual final page', async () => {
  for (const length of [925, 900]) {
    const tracks = Array.from({ length }, (_, index) => ({ hash: `song-${index}` }))
    const favorites = loadFavorites({
      props: { playlistId: 91 },
      api: { getPlaylistTracks: async (_id, number, size) => ({ status: 1, data: { songs: tracks.slice((number - 1) * size, number * size) } }) }
    })
    await favorites.view.loadFavorites()
    assert.equal(favorites.view.favoriteList.length, length)
    assert.equal(favorites.calls.tracks.length, 4, 'exact full-page totals need the empty next page to establish completion')
    assert.equal(favorites.view.loaded, true)
  }
})

test('missing totals combined with a server page-size cap still load the playlist tail', async () => {
  for (const length of [925, 900, 25]) {
    const tracks = Array.from({ length }, (_, index) => ({ hash: `song-${index}`, name: `Track ${index}` }))
    const favorites = loadFavorites({
      props: { playlistId: 91 },
      api: { getPlaylistTracks: async (_id, number, size) => ({ status: 1, data: {
        songs: tracks.slice((number - 1) * size, (number - 1) * size + Math.min(size, 100))
      } }) }
    })
    await favorites.view.loadFavorites()
    assert.equal(favorites.view.favoriteList.length, length)
    assert.equal(new Set(favorites.view.favoriteList.map(song => song.hash)).size, length)
    assert.equal(favorites.calls.tracks[0][2], 300)
    assert.equal(favorites.calls.tracks[1][2], Math.min(length, 100))
    assert.equal(favorites.calls.tracks.length, length === 25 ? 2 : 10)
    favorites.view.searchQuery = `Track ${length - 1}`
    assert.equal(favorites.view.filteredFavoriteList.at(-1).hash, `song-${length - 1}`)
    assert.equal(favorites.view.loaded, true)
    assert.equal(favorites.view.errorMessage, '')
  }
})

test('a repeated full page without totals stops the load and preserves the last complete playlist', async () => {
  const repeatedPage = Array.from({ length: 100 }, (_, index) => ({ hash: `repeated-${index}` }))
  let refreshing = false
  const favorites = loadFavorites({
    props: { playlistId: 91 },
    api: { getPlaylistTracks: async () => refreshing ? { status: 1, data: { songs: repeatedPage } } : page([{ hash: 'complete-old-song' }]) }
  })
  await favorites.view.loadFavorites()
  const complete = favorites.view.favoriteList
  refreshing = true
  await favorites.view.loadFavorites(true)
  assert.equal(favorites.calls.tracks.length, 3, 'a repeated full page must not trigger an unbounded third refresh request')
  assert.equal(favorites.view.favoriteList, complete)
  assert.equal(favorites.view.favoriteList[0].hash, 'complete-old-song')
  assert.match(favorites.view.errorMessage, /分页未前进/)
  assert.equal(favorites.view.loading, false)
})

test('repeated songs across distinct pages remain in the complete playlist', async () => {
  const tracks = [{ hash: 'repeat' }, { hash: 'a' }, { hash: 'repeat' }, { hash: 'b' }]
  const favorites = loadFavorites({
    props: { playlistId: 91 },
    api: { getPlaylistTracks: async (_id, number, size) => ({ status: 1, data: {
      songs: tracks.slice((number - 1) * size, (number - 1) * size + Math.min(size, 2))
    } }) }
  })
  await favorites.view.loadFavorites()
  assert.equal(favorites.view.favoriteList.map(song => song.hash).join(','), 'repeat,a,repeat,b')
  assert.equal(favorites.view.favoriteList.map(song => song.index).join(','), '1,2,3,4')
  assert.equal(favorites.calls.tracks.length, 3)
  assert.equal(favorites.view.errorMessage, '')
})
