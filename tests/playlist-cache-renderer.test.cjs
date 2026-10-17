const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const vue = require('vue')
const { parse, compileScript, compileTemplate } = require('@vue/compiler-sfc')

const root = path.join(__dirname, '..')
const logger = Object.fromEntries(['trace', 'warn', 'error'].map(name => [name, () => {}]))
const flush = () => new Promise(resolve => setImmediate(resolve))
const read = name => fs.readFileSync(path.join(root, name), 'utf8')
const stripImports = source => source.replace(/^import\b[\s\S]*?from\s+['"][^'"]+['"]\s*;?\s*$/gm, '')
const cloneDeep = vm.runInNewContext(`${stripImports(read('src/utils/objectUtils.js')).replace(/\bexport (?=(?:async )?function)/g, '')}\n;cloneDeep`, { structuredClone, isReactive: vue.isReactive, toRaw: vue.toRaw })
function deferred() {
  let resolve
  let reject
  const promise = new Promise((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function loadBridge(api) {
  const source = read('src/utils/playlistCache.js').replace(/\bexport (?=(?:async )?function)/g, '')
  return vm.runInNewContext(`${source}\n;({ initializePlaylistCacheSession, waitForPlaylistCacheSession, callPlaylistCache, getPlaylistCacheSessionVersion })`, {
    window: { electronAPI: api ? { playlistCache: api } : {} }
  })
}

test('cache helpers wait for the newest serialized account and ignore an earlier waiting operation', async () => {
  const first = deferred()
  const sessions = []
  const operations = []
  const bridge = loadBridge({
    setSession(identity) {
      sessions.push(identity?.userId)
      return identity?.userId === 'A' ? first.promise : Promise.resolve({ userId: identity?.userId })
    },
    readPlaylist: async id => { operations.push(id); return { id } }
  })
  const oldSession = bridge.initializePlaylistCacheSession({ userId: 'A', token: 'example-a' })
  const oldRead = bridge.callPlaylistCache('readPlaylist', 1)
  await flush()
  const newSession = bridge.initializePlaylistCacheSession({ userId: 'B', token: 'example-b' })
  const newRead = bridge.callPlaylistCache('readPlaylist', 2)
  assert.deepEqual(sessions, ['A'])
  first.resolve({ userId: 'A' })
  await Promise.all([oldSession, newSession])
  assert.equal(await oldRead, null)
  assert.equal((await newRead).id, 2)
  assert.deepEqual(sessions, ['A', 'B'])
  assert.deepEqual(operations, [2])
})

test('late media capabilities are released after an account change and browser preview stays optional', async () => {
  const source = deferred()
  const released = []
  const bridge = loadBridge({
    setSession: async identity => ({ userId: identity?.userId }),
    getArtwork: () => source.promise,
    releaseSource: async id => released.push(id)
  })
  await bridge.initializePlaylistCacheSession({ userId: 'A', token: 'example-a' })
  const pending = bridge.callPlaylistCache('getArtwork', 'https://imge.kugou.com/a.jpg')
  await flush()
  await bridge.initializePlaylistCacheSession(null)
  source.resolve({ url: 'bk-cache://artwork/a', leaseId: 'old-lease' })
  assert.equal(await pending, null)
  assert.deepEqual(released, ['old-lease'])
  assert.equal(await bridge.waitForPlaylistCacheSession(), null)
  const preview = loadBridge(null)
  await preview.initializePlaylistCacheSession({ userId: 'A', token: 'example-a' })
  assert.equal(await preview.callPlaylistCache('readPlaylist', 1), null)
})

function loadFavorite({ props = {}, cache = {}, tracks, legacy = {} } = {}) {
  const storage = new Map(Object.entries({ kugou_userid: 'A', kugou_token: 'example-token', ...legacy }))
  const calls = []
  const trackCalls = []
  const sandbox = vm.createContext({
    module: { exports: {} }, logger,
    cloneDeep,
    window: { electronAPI: { playlistCache: {} } },
    localStorage: {
      getItem: name => storage.get(name) ?? null,
      setItem: (name, value) => storage.set(name, String(value)),
      removeItem: name => storage.delete(name)
    },
    callPlaylistCache: async (method, ...args) => { calls.push([method, ...args]); return cache[method]?.(...args) ?? null },
    getUserPlaylists: async () => ({ status: 1, data: { info: [{ id: 10, name: '我喜欢的音乐' }] } }),
    getPlaylistTracks: (...args) => { trackCalls.push(args); return tracks?.(...args) ?? Promise.resolve({ status: 1, data: { songs: [], count: 0 } }) },
    ArtworkCover: {}, SongBadges: {}, ArtistLinks: {}, ContextMenu: {}, nextplayIcon: '',
    contextMenuManager: { unregisterMenu() {} }, filterSongs: songs => songs,
    clearTimeout, setTimeout
  })
  vm.runInContext(stripImports(read('src/views/logic/FavoriteView.js')).replace('export default', 'module.exports ='), sandbox)
  const options = sandbox.module.exports
  const view = { ...options.data(), playlistId: 10, playlistName: '晚间歌单', userPlaylists: null,
    playlistsLoaded: true, playlistCacheState: null, settings: { playback: {} }, ...props, $emit() {} }
  for (const [name, method] of Object.entries(options.methods)) view[name] = method.bind(view)
  for (const [name, getter] of Object.entries(options.computed)) Object.defineProperty(view, name, { get: () => getter.call(view) })
  return { view, calls, trackCalls, storage, activate: () => options.activated.call(view), unmount: () => options.beforeUnmount.call(view) }
}

test('an opened playlist shows its disk snapshot before online validation and only commits a complete list', async () => {
  const online = deferred()
  const fixture = loadFavorite({
    cache: { readPlaylist: () => ({ id: 10, songs: [{ hash: 'disk' }] }) },
    tracks: () => online.promise
  })
  const pending = fixture.view.loadFavorites()
  await flush()
  assert.equal(fixture.view.favoriteList[0].hash, 'disk')
  assert.equal(fixture.view.loading, true)
  assert.equal(fixture.calls.filter(([method]) => method === 'putPlaylist').length, 0)
  online.resolve({ status: 1, data: { songs: [{ hash: 'cloud' }], count: 1 } })
  await pending
  const write = fixture.calls.find(([method]) => method === 'putPlaylist')[1]
  assert.equal(write.id, 10)
  assert.equal(write.songs[0].hash, 'cloud')
  assert.equal(fixture.calls.some(([method]) => ['cacheSong', 'putLyrics'].includes(method)), false)
  await fixture.view.loadFavorites()
  assert.equal(fixture.trackCalls.length, 1)
})

test('the favorite alias restores its real ID without a directory and retains an authoritative empty snapshot', async () => {
  const fixture = loadFavorite({
    props: { playlistId: null, userPlaylists: [], playlistsLoaded: false },
    legacy: { favorite_songs_userid: 'A', favorite_songs: JSON.stringify([{ hash: 'outdated' }]) },
    cache: { readPlaylist: id => { assert.equal(id, null); return { id: 'real-favorite', isFavorite: true, songs: [] } } },
    tracks: async () => { throw new Error('offline') }
  })
  await fixture.view.loadFavorites()
  assert.equal(fixture.trackCalls[0][0], 'real-favorite')
  assert.equal(fixture.view.favoriteList.length, 0)
  assert.match(fixture.view.errorMessage, /offline/)
  await fixture.view.loadFavorites()
  assert.equal(fixture.trackCalls.length, 1, 'reactivating an existing disk-backed page waits for an explicit refresh')
})

test('failed pagination keeps the disk snapshot and never persists a partial replacement', async () => {
  const fixture = loadFavorite({
    cache: { readPlaylist: () => ({ id: 10, songs: [{ hash: 'complete-disk' }] }) },
    tracks: async (_id, page) => page === 1
      ? { status: 1, data: { songs: [{ hash: 'partial' }], count: 2 } }
      : { status: 0, error: 'next page failed' }
  })
  await fixture.view.loadFavorites()
  assert.equal(fixture.view.favoriteList[0].hash, 'complete-disk')
  assert.equal(fixture.calls.some(([method]) => method === 'putPlaylist'), false)
  assert.equal(fixture.trackCalls.length, 2)
})

test('local favorite edits update the same complete disk snapshot without triggering audio or lyric work', async () => {
  const response = deferred()
  let count = 0
  const fixture = loadFavorite({
    props: { playlistId: null },
    tracks: () => ++count === 1 ? Promise.resolve({ status: 1, data: { songs: [{ hash: 'a' }, { hash: 'b' }], count: 2 } }) : response.promise
  })
  await fixture.view.loadFavorites()
  const refresh = fixture.view.loadFavorites(true)
  fixture.view.removeFavorite(fixture.view.favoriteList[1])
  response.resolve({ status: 1, data: { songs: [{ hash: 'a' }, { hash: 'b' }], count: 2 } })
  await refresh
  const writes = fixture.calls.filter(([method]) => method === 'putPlaylist')
  assert.equal(writes.length, 2)
  assert.equal(writes.at(-1)[1].isFavorite, true)
  assert.equal(writes.at(-1)[1].songs.map(song => song.hash).join(','), 'a')
  assert.equal(fixture.calls.some(([method]) => ['cacheSong', 'putLyrics', 'resume'].includes(method)), false)
})

test('a failed snapshot write has a dedicated retry that does not enqueue media downloads', async () => {
  let failWrite = true
  const fixture = loadFavorite({ cache: { putPlaylist: async () => {
    if (failWrite) throw new Error('disk unavailable')
    return {}
  } } })
  await fixture.view.loadFavorites()
  await flush()
  assert.equal(fixture.view.cacheWriteFailed, true)
  assert.match(fixture.view.offlineCacheError, /无法保存离线歌单/)
  failWrite = false
  await fixture.view.retryPlaylistSnapshot()
  assert.equal(fixture.view.cacheWriteFailed, false)
  assert.equal(fixture.view.offlineCacheError, '')
  assert.equal(fixture.calls.filter(([method]) => method === 'putPlaylist').length, 2)
  assert.equal(fixture.calls.some(([method]) => ['retry', 'cacheSong', 'putLyrics'].includes(method)), false)
})

test('reactivating a loaded playlist touches recent access without replacing rows or refetching tracks', async () => {
  let evicted = false
  const fixture = loadFavorite({ cache: { readPlaylist: () => evicted ? null : ({ id: 10, songs: [{ hash: 'disk' }] }) } })
  await fixture.view.loadFavorites()
  const rows = fixture.view.favoriteList
  const originalRequests = fixture.trackCalls.length
  fixture.calls.length = 0
  fixture.view.searchQuery = 'retained search'
  fixture.activate()
  await flush()
  assert.equal(fixture.view.favoriteList, rows)
  assert.equal(fixture.view.searchQuery, 'retained search')
  assert.deepEqual(fixture.calls.map(([method]) => method), ['readPlaylist'])
  assert.equal(fixture.calls[0][1], 10)
  evicted = true
  fixture.calls.length = 0
  fixture.activate()
  await flush()
  assert.deepEqual(fixture.calls.map(([method]) => method), ['readPlaylist', 'putPlaylist'])
  assert.equal(fixture.view.favoriteList, rows)
  assert.equal(fixture.trackCalls.length, originalRequests)
  assert.equal(fixture.calls.some(([method]) => ['cacheSong', 'resume', 'retry'].includes(method)), false)
})

test('playlist snapshots remove nested Vue proxies before crossing the desktop IPC bridge', async () => {
  const fixture = loadFavorite()
  await fixture.view.loadFavorites()
  fixture.calls.length = 0
  fixture.view.favoriteList = vue.reactive([{ hash: 'nested', singerinfo: [{ id: 1, name: 'Artist' }], albuminfo: { name: 'Album' } }])
  await fixture.view.persistPlaylistSnapshot()
  const snapshot = fixture.calls.find(([method]) => method === 'putPlaylist')[1]
  const transferred = structuredClone(snapshot)
  assert.equal(transferred.songs[0].singerinfo[0].name, 'Artist')
  assert.equal(vue.isProxy(snapshot.songs[0].singerinfo), false)
  assert.equal(vue.isProxy(snapshot.songs[0].albuminfo), false)
  assert.equal(vue.isProxy(fixture.view.favoriteList[0].singerinfo), true)
})

function renderer() {
  const node = (type, text = '') => ({ type, text, props: {}, children: [], parent: null, style: {} })
  return { node, renderer: vue.createRenderer({
    createElement: node, createText: text => node('text', text), createComment: text => node('comment', text),
    setText: (item, text) => { item.text = text }, setElementText: (item, text) => { item.text = text; item.children = [] },
    patchProp: (item, key, _old, value) => { item.props[key] = value },
    insert(item, parent, anchor) {
      if (item.parent) item.parent.children.splice(item.parent.children.indexOf(item), 1)
      item.parent = parent
      const index = anchor ? parent.children.indexOf(anchor) : -1
      parent.children.splice(index < 0 ? parent.children.length : index, 0, item)
    },
    remove(item) { if (item.parent) item.parent.children.splice(item.parent.children.indexOf(item), 1); item.parent = null },
    parentNode: item => item.parent,
    nextSibling: item => item.parent?.children[item.parent.children.indexOf(item) + 1] || null
  }) }
}

function loadArtworkComponent(cache) {
  const filename = 'src/components/common/ArtworkCover.vue'
  const { descriptor } = parse(read(filename))
  const script = compileScript(descriptor, { id: 'cover-cache' })
  const calls = []
  const released = []
  const sandbox = vm.createContext({ ...vue, logger, module: { exports: {} },
    callPlaylistCache: async (method, ...args) => { calls.push([method, ...args]); return cache[method]?.(...args) ?? null },
    getPlaylistCacheAPI: () => ({ releaseSource: async id => released.push(id) })
  })
  vm.runInContext(stripImports(script.content).replace('export default', 'module.exports ='), sandbox)
  const template = compileTemplate({ source: descriptor.template.content, filename, id: 'cover-cache',
    compilerOptions: { mode: 'function', bindingMetadata: script.bindings } })
  assert.deepEqual(template.errors, [])
  const component = { ...sandbox.module.exports, render: new Function('Vue', template.code)(vue) }
  return { component, calls, released }
}

function mountArtwork(t, cache, props = {}) {
  const { component, calls, released } = loadArtworkComponent(cache)
  const host = renderer()
  const state = vue.reactive({ src: 'https://imge.kugou.com/a.jpg' })
  const app = host.renderer.createApp({ render: () => vue.h(component, { ...props, src: state.src }) })
  const rootNode = host.node('root')
  app.mount(rootNode)
  let mounted = true
  const unmount = () => { if (mounted) { mounted = false; app.unmount() } }
  t.after(unmount)
  const image = () => rootNode.children[0]?.type === 'img' ? rootNode.children[0] : rootNode.children[0]?.children.find(child => child.type === 'img')
  const event = item => ({ target: { dataset: { artworkGeneration: item.props['data-artwork-generation'], artworkSource: item.props['data-artwork-source'] } } })
  return { state, calls, released, image, event, unmount }
}

function mountMusicPage(t, name, data, props, cache) {
  const artwork = loadArtworkComponent(cache)
  const filename = name === 'HomeView' ? 'src/views/HomeView.vue' : 'src/components/player/LyricView.vue'
  const { descriptor } = parse(read(filename))
  const source = descriptor.script.src ? read(path.join(path.dirname(filename), descriptor.script.src)) : descriptor.script.content
  const leaf = { render: () => null }
  const sandbox = vm.createContext({ module: { exports: {} }, logger,
    window: { innerWidth: 1200, innerHeight: 800 }, localStorage: { getItem: () => null },
    SongBadges: leaf, ArtistLinks: leaf, ContextMenu: leaf, ArtworkCover: artwork.component,
    repeatAllIcon: '', repeatOneIcon: '', shuffleIcon: ''
  })
  vm.runInContext(stripImports(source).replace('export default', 'module.exports ='), sandbox)
  const options = sandbox.module.exports
  const template = compileTemplate({ source: descriptor.template.content, filename, id: name,
    compilerOptions: { mode: 'function', hoistStatic: false } })
  assert.deepEqual(template.errors, [])
  const transition = { setup(_props, { slots }) { return () => slots.default?.()[0] } }
  const component = { name, props: options.props, components: options.components, methods: options.methods,
    computed: options.computed, data() { return { ...options.data.call(this), ...data } },
    render: new Function('Vue', template.code)({ ...vue, Transition: transition }) }
  const host = renderer()
  const state = vue.reactive(props)
  let instance
  const app = host.renderer.createApp({ render: () => vue.h(component, { ...state, ref: value => { instance = value } }) })
  const rootNode = host.node('root')
  app.mount(rootNode)
  t.after(() => app.unmount())
  const images = () => {
    const found = []
    const visit = item => { if (item.type === 'img') found.push(item); item.children.forEach(visit) }
    visit(rootNode)
    return found
  }
  return { ...artwork, state, images, instance: () => instance }
}

test('the three production Home cover regions display cached images without downloading on mount', async t => {
  let count = 0
  const fixture = mountMusicPage(t, 'HomeView', {
    dailyCover: 'https://imge.kugou.com/daily.jpg',
    aiRecommendList: [{ hash: 'song-a', name: 'A', imgurl: 'https://imge.kugou.com/song.jpg' }],
    rankList: [{ rankid: 1, rankname: 'Rank', imgurl: 'https://imge.kugou.com/rank.jpg' }]
  }, {}, { getArtwork: () => ({ url: `bk-cache://cover/${++count}`, leaseId: `cover-${count}` }) })
  await flush()
  assert.equal(fixture.images().length, 3)
  assert.ok(fixture.images().every(image => image.props.src.startsWith('bk-cache://cover/')))
  assert.deepEqual(fixture.images().map(image => image.props.loading), ['eager', 'lazy', 'lazy'])
  assert.deepEqual(fixture.calls.map(([method]) => method), ['getArtwork', 'getArtwork', 'getArtwork'])
})

test('production lyric background and album images use cached covers and preserve track identity when changing songs', async t => {
  let count = 0
  const fixture = mountMusicPage(t, 'LyricView', {}, {
    visible: true, song: { hash: 'A', name: 'A', cover: 'https://imge.kugou.com/a.jpg' }
  }, { getArtwork: () => ({ url: `bk-cache://cover/${++count}`, leaseId: `cover-${count}` }) })
  await flush()
  assert.equal(fixture.images().length, 2)
  assert.equal(fixture.images()[0].props.class, 'background-image')
  assert.equal(fixture.images()[1].props.class, 'album-cover')
  assert.equal(fixture.images()[1].props['data-track-key'], 'A')
  assert.ok(fixture.images().every(image => image.props.src.startsWith('bk-cache://cover/')))
  const oldImage = fixture.images()[1]
  fixture.state.song = { hash: 'B', name: 'B', cover: 'https://imge.kugou.com/b.jpg' }
  await flush()
  assert.equal(fixture.images()[1].props['data-track-key'], 'B')
  assert.ok(fixture.images().every(image => image.props['data-artwork-original'].endsWith('/b.jpg')))
  assert.equal(fixture.released.length, 2)
  fixture.instance().handleCoverError({ target: { dataset: { trackKey: 'A' }, getAttribute: name => oldImage.props[name] } })
  assert.equal(fixture.instance().coverFailed, false)
  assert.equal(fixture.calls.some(([method]) => method === 'cacheArtwork'), false)
})

test('image-only artwork preserves the native image root, track attributes and existing cover classes', async t => {
  const errors = []
  const fixture = mountArtwork(t, { getArtwork: () => ({ url: 'bk-cache://cover/a', leaseId: 'cover-a' }) },
    { imageOnly: true, loading: 'eager', class: 'album-cover', 'data-track-key': 'A', label: '专辑封面', onError: event => errors.push(event) })
  const initialImage = fixture.image()
  await flush()
  const image = fixture.image()
  assert.equal(image, initialImage, 'the asynchronous lookup does not replace the image used by track transitions')
  assert.equal(image.props.class, 'album-cover')
  assert.equal(image.props['data-track-key'], 'A')
  assert.equal(image.props['data-artwork-original'], fixture.state.src)
  assert.equal(image.props.src, 'bk-cache://cover/a')
  assert.equal(image.props.loading, 'eager')
  image.props.onError(fixture.event(image))
  await flush()
  assert.equal(errors.length, 0, 'a cached-file failure falls back before reporting a final cover error')
  assert.equal(fixture.image(), initialImage)
  assert.equal(image.props.src, fixture.state.src)
  image.props.onError(fixture.event(image))
  await flush()
  assert.equal(errors.length, 1)
  assert.equal(image.style.display, 'none')
})

test('artwork lookup preserves lazy images and only a real current load queues a cover download', async t => {
  const fixture = mountArtwork(t, {})
  await flush()
  const image = fixture.image()
  assert.equal(image.props.loading, 'lazy')
  assert.equal(image.props.src, fixture.state.src)
  assert.deepEqual(fixture.calls.map(([method]) => method), ['getArtwork'])
  image.props.onLoad(fixture.event(image))
  await flush()
  assert.deepEqual(fixture.calls.map(([method]) => method), ['getArtwork', 'cacheArtwork'])
  fixture.state.src = 'https://imge.kugou.com/b.jpg'
  await flush()
  image.props.onLoad(fixture.event(image))
  await flush()
  assert.equal(fixture.calls.filter(([method]) => method === 'cacheArtwork').length, 1)
})

test('cached artwork failures fall back to its original URL and release leases on changes and unmount', async t => {
  const fixture = mountArtwork(t, { getArtwork: () => ({ url: 'bk-cache://cover/a', leaseId: 'cover-a' }) })
  await flush()
  const image = fixture.image()
  assert.equal(image.props.src, 'bk-cache://cover/a')
  image.props.onLoad(fixture.event(image))
  await flush()
  assert.equal(fixture.calls.some(([method]) => method === 'cacheArtwork'), false)
  image.props.onError(fixture.event(image))
  await flush()
  assert.equal(fixture.image().props.src, fixture.state.src)
  assert.deepEqual(fixture.released, ['cover-a'])
  image.props.onLoad(fixture.event(image))
  await flush()
  assert.equal(fixture.calls.some(([method]) => method === 'cacheArtwork'), false, 'a late cached-image load must not claim the remote fallback loaded')
  fixture.state.src = 'https://imge.kugou.com/b.jpg'
  await flush()
  fixture.unmount()
  await flush()
  assert.deepEqual(fixture.released, ['cover-a', 'cover-a'])
})

test('a cover lookup finishing after the source changes releases its late lease', async t => {
  const first = deferred()
  const fixture = mountArtwork(t, { getArtwork: url => url.endsWith('/a.jpg') ? first.promise : null })
  fixture.state.src = 'https://imge.kugou.com/b.jpg'
  await flush()
  first.resolve({ url: 'bk-cache://old-cover/a', leaseId: 'late-cover' })
  await flush()
  assert.equal(fixture.image().props.src, fixture.state.src)
  assert.deepEqual(fixture.released, ['late-cover'])
})
