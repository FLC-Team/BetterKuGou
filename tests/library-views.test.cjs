const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const vue = require('vue')

const root = path.join(__dirname, '..')
const plain = value => JSON.parse(JSON.stringify(value))
const flush = () => new Promise(resolve => setImmediate(resolve))
const strip = source => source.replace(/^import\b[\s\S]*?from\s+['"][^'"]+['"]\s*;?\s*$/gm, '')
const logger = { trace() {}, info() {}, warn() {}, error() {} }
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }

function fixture(file, globals = {}, props = {}) {
  const sandbox = vm.createContext({ logger, AbortController, setTimeout, clearTimeout, ArtworkCover: {}, ArtistLinks: {}, SongBadges: {},
    LibrarySongs: {}, LibraryActions: {}, DownloadsView: {}, WindowedList: {}, ContextMenu: {}, UserMenu: {},
    minimizeIcon: '', maximizeIcon: '', restoreIcon: '', closeIcon: '', nextplayIcon: '',
    contextMenuManager: { closeActiveMenu() {}, registerMenu() {}, unregisterMenu() {} },
    localStorage: { getItem: () => null },
    getUserHistory() {}, getUserListen() {}, getFollowedArtists() {}, getFollowedNewSongs() {}, getCloudSongs() {}, ...globals })
  for (const utility of ['src/utils/songMetadata.js', 'src/utils/libraryMetadata.js', 'src/views/logic/libraryPage.js']) {
    const source = strip(fs.readFileSync(path.join(root, utility), 'utf8'))
    const names = [...source.matchAll(/^export (?:function|const) (\w+)/gm)].map(match => match[1])
    Object.assign(sandbox, vm.runInContext(`(() => { ${source.replace(/^export /gm, '')}\nreturn { ${names.join(',')} } })()`, sandbox))
  }
  const source = fs.readFileSync(path.join(root, file), 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1]
  vm.runInContext(strip(source).replace('export default', 'globalThis.definition ='), sandbox)
  const definition = sandbox.definition
  const emitted = []
  const view = { ...definition.data.call(props), ...props, $options: definition, $emit: (...args) => emitted.push(args),
    $nextTick: fn => Promise.resolve().then(fn), $refs: {} }
  for (const [key, method] of Object.entries(definition.methods || {})) view[key] = method.bind(view)
  for (const [key, descriptor] of Object.entries(definition.computed || {})) {
    Object.defineProperty(view, key, typeof descriptor === 'function' ? { get: descriptor.bind(view) }
      : { get: descriptor.get.bind(view), set: descriptor.set.bind(view) })
  }
  return { view, definition, sandbox, emitted }
}

test('library paging retains a known total and rejects incomplete and repeated pages without replacing prior rows', () => {
  const { sandbox } = fixture('src/views/DiscoverView.vue')
  const state = sandbox.createLibraryPageState()
  sandbox.appendLibraryPage(state, [{ hash: 'a' }], { data: { total: 3 } })
  sandbox.appendLibraryPage(state, [{ hash: 'b' }], {}, { append: true })
  assert.equal(state.total, 3)
  assert.equal(state.more, true)
  assert.throws(() => sandbox.appendLibraryPage(state, [], {}, { append: true }), /未加载完整/)
  assert.throws(() => sandbox.appendLibraryPage(state, [{ hash: 'a' }], {}, { append: true }), /重复/)
  assert.deepEqual(plain(state.items), [{ hash: 'a' }, { hash: 'b' }])
  assert.equal(state.page, 2)
})

test('discover A-B-A tab navigation cancels stale requests and keeps loaded resource pages', async () => {
  const requests = []
  const request = (params, options) => { const pending = deferred(); requests.push({ ...pending, params, options }); return pending.promise }
  const { view } = fixture('src/views/DiscoverView.vue', { getDiscoverPlaylists: request, getNewSongs: request })
  const first = view.loadPage()
  view.selectTab('songs')
  view.selectTab('playlists')
  assert.equal(requests.length, 3)
  assert.equal(requests[0].options.signal.aborted, true)
  requests[2].resolve({ data: { list: [{ global_collection_id: 'public-a', name: 'A' }], total: 1 } })
  await flush()
  requests[0].resolve({ data: { list: [{ id: 'stale' }] } })
  requests[1].reject(new Error('late network failure'))
  await first; await flush()
  assert.equal(view.page.items[0].id, 'public-a')
  assert.equal(view.page.loading, false)
  assert.equal(view.page.error, '')
  view.selectTab('songs')
  requests[3].resolve({ data: { list: [{ hash: 'new-song' }], total: 1 } })
  await flush()
  view.selectTab('playlists')
  assert.equal(requests.length, 4, 'loaded resource is reused on return')
  assert.equal(view.page.items[0].id, 'public-a')
})

test('private collections discard former-account responses and preserve cloud ownership and entry identifiers', async () => {
  const requests = []
  const request = (_params, options) => { const pending = deferred(); requests.push({ ...pending, options }); return pending.promise }
  const { view, definition } = fixture('src/views/MyMusicView.vue', { getCloudSongs: request }, { userLoggedIn: true, userId: 'first' })
  view.activeTab = 'cloud'
  const first = view.loadPage()
  view.userId = 'second'
  definition.watch.userId.call(view)
  assert.equal(requests[0].options.signal.aborted, true)
  requests[1].resolve({ data: { list: [{ hash: 'ABC', filename: 'Private song', fileid: 7, album_audio_id: 15 }], total: 1 } })
  await flush()
  requests[0].resolve({ data: { list: [{ hash: 'OLD' }] } })
  await first
  assert.equal(view.page.items[0].hash, 'abc')
  assert.equal(view.page.items[0].source, 'cloud')
  assert.equal(view.page.items[0].sourceUserId, 'second')
  assert.equal(view.page.items[0].fileid, 7)
  assert.equal(Object.keys(view.pages).length, 1)
  assert.equal(view.artistId({ userid: 900, id: 900, name: 'User' }), undefined)
  assert.equal(view.artistId({ userid: 900, ext_params: { singerid: 18 } }), 18)
})

test('history follows an explicit changed cursor and does not claim a complete numbered page', async () => {
  const params = []
  const { view } = fixture('src/views/MyMusicView.vue', { getUserHistory: async input => {
    params.push(input); return params.length === 1 ? { data: { list: [{ hash: 'a' }], bp: 'next' } } : { data: { list: [{ hash: 'b' }], bp: 'next' } }
  } }, { userLoggedIn: true, userId: 3 })
  await view.loadPage()
  assert.equal(view.page.more, true)
  await view.loadPage(true)
  assert.equal(params[1].bp, 'next')
  assert.equal(view.page.more, false)
  assert.deepEqual(Array.from(view.page.items, item => item.hash), ['a', 'b'])
})

test('multi-select keeps original song rights and isolates cloud entries from different accounts', () => {
  const songs = [{ hash: 'same', source: 'cloud', sourceUserId: 'a', fileid: 1, privilege: 8 },
    { hash: 'same', source: 'cloud', sourceUserId: 'b', fileid: 1, privilege: 9 }]
  const { view } = fixture('src/components/common/LibrarySongs.vue', {}, { songs })
  view.selectSong(songs[0], 0, true)
  assert.deepEqual(plain(view.selectedSongs), [songs[0]])
  view.selectAll(true)
  assert.equal(view.selectedSongs[1], songs[1])
  view.songs = [...songs, { hash: 'next-page' }]
  assert.equal(view.selectedSongs.length, 2, 'new page is not silently added to a selection')
  view.selectAll(false)
  assert.equal(view.selectedSongs.length, 0)
  assert.equal(view.sameSong(songs[0], { hash: 'same' }), false)
  assert.equal(view.sameSong({ hash: 'SAME' }, { hash: 'same' }), true)
})

test('comment filter switching ignores stale replies and preserves the server floor partition', async () => {
  const requests = []
  const { view } = fixture('src/components/common/SongDetailsPanel.vue', { getComments: (resource, params, options) => {
    const pending = deferred(); requests.push({ ...pending, resource, params, options }); return pending.promise
  } }, { visible: true })
  view.resolvedResource = { type: 'song', mixsongid: 20 }
  const initial = view.loadComments()
  view.selectFilter({ type_id: 0 })
  requests[1].resolve({ data: { list: [{ tid: 'new', special_id: 'partition' }], total: 1 } })
  await flush()
  requests[0].resolve({ data: { list: [{ tid: 'old' }], special_id: 'old-partition' } })
  await initial
  assert.equal(view.comments.items[0].tid, 'new')
  assert.equal(view.comments.loading, false)
  assert.equal(view.canReadReplies(view.comments.items[0]), true)
  assert.equal(view.canReadReplies({ tid: 'without-partition' }), false)
  view.resolvedResource.type = 'album'
  assert.equal(view.canReadReplies(view.comments.items[0]), false)
})

test('daily history changes cannot be overwritten by an in-flight current recommendation', async () => {
  const today = deferred(), historical = deferred()
  const { view } = fixture('src/views/DailyRecommendView.vue', { getEverydayRecommend: () => today.promise, getEverydayHistory: () => historical.promise })
  const current = view.loadData()
  view.historyDates = [{ date: '2026-11-01', history_name: 'issued-name' }]
  view.selectedHistory = view.historyKey(view.historyDates[0])
  view.changeHistory()
  historical.resolve({ data: { lists: [{ date: '2026-11-01', history_name: 'issued-name', song_list: [{ hash: 'history', time_length: 350 }] }] } })
  await flush()
  today.resolve({ status: 1, data: { song_list: [{ hash: 'today' }] } })
  await current
  assert.equal(view.songs[0].hash, 'history')
  assert.equal(view.loading, false)
  assert.equal(view.historyCache[view.selectedHistory][0].hash, 'history')
})

test('titlebar suggestions ignore late requests, stop during IME, and preserve controlled draft events', async () => {
  const pending = []
  const { view, emitted } = fixture('src/components/layout/TitleBar.vue', { getSearchSuggestions: keyword => {
    const request = deferred(); pending.push({ ...request, keyword }); return request.promise
  } }, { modelValue: 'new' })
  view.showSearchHints = true
  const first = view.fetchSuggestions('old')
  view.cancelSearchHints()
  const second = view.fetchSuggestions('new')
  pending[1].resolve({ data: [{ RecordDatas: [{ HintInfo: 'New song' }] }] })
  await second
  pending[0].resolve({ data: { MusicTip: [{ Datas: [{ HintInfo: 'Old song' }] }] } })
  await first
  assert.deepEqual(plain(view.suggestions), ['New song'])
  view.startComposition()
  view.performSearch()
  assert.equal(emitted.length, 0)
  view.composing = false
  view.chooseSuggestion('A complete keyword')
  assert.deepEqual(plain(emitted), [['update:modelValue', 'A complete keyword'], ['search', 'A complete keyword']])
  assert.equal(view.showSearchHints, false)
})

test('hot search and default words are independent, keyboard selection uses visible results, and dismissing invalidates responses', async () => {
  const { view, emitted } = fixture('src/components/layout/TitleBar.vue', {
    getSearchHot: async () => ({ data: { list: [{ keywords: [{ keyword: 'First' }, { keyword: 'Last' }] }] } }),
    getSearchDefault: async () => ({ data: { default_search: [{ show_word: 'Default' }] } })
  }, { modelValue: '' })
  view.showSearchHints = true
  await view.loadSearchDiscovery()
  assert.equal(view.defaultKeyword, 'Default')
  const key = name => ({ key: name, target: {}, preventDefault() {} })
  view.handleSearchKey(key('ArrowUp'))
  assert.equal(view.activeSuggestion, 1)
  view.handleSearchKey(key('Enter'))
  assert.deepEqual(plain(emitted), [['update:modelValue', 'Last'], ['search', 'Last']])
  const late = deferred()
  const other = fixture('src/components/layout/TitleBar.vue', { getSearchSuggestions: () => late.promise }, { modelValue: 'late' }).view
  other.showSearchHints = true
  const request = other.fetchSuggestions('late')
  other.closeSearchHints()
  late.resolve({ data: { list: [{ keyword: 'Late' }] } })
  await request
  assert.equal(other.suggestions.length, 0)
})

test('real public discovery shapes support child categories, server continuation and region-specific albums', async () => {
  const { view, sandbox } = fixture('src/views/DiscoverView.vue', { getNewAlbums: async () => ({ status: 1, data: {
    chn: [{ albumid: 1, albumname: 'Chinese album' }], eur: [{ albumid: 2, albumname: 'European album' }]
  } }) })
  assert.deepEqual(plain(sandbox.flattenLibraryOptions({ data: [{ tag_id: 1, tag_name: 'Parent', son: [{ tag_id: 2, tag_name: 'Child' }] }] })), [{ id: 1, name: 'Parent' }, { id: 2, name: 'Child' }])
  assert.equal(sandbox.readLibraryPagination({ data: { has_next: 1 } }, 8, 8, 30).more, true)
  view.activeTab = 'albums'
  await view.loadPage()
  assert.equal(view.page.items[0].albumid, 1)
  view.albumRegion = 'eur'; view.selectCategory()
  await flush()
  assert.equal(view.page.items[0].albumid, 2)
  view.albumRegion = 'chn'; view.selectCategory()
  assert.equal(view.page.items[0].albumid, 1)
})

test('real public rank periods flatten years and send the selected server volume without changing the ranking', async () => {
  const requests = []
  const { view } = fixture('src/views/RankDetailView.vue', {
    getRankPeriods: async () => ({ data: { info: [{ year: 2026, vols: [{ volid: 15, voltitle: 'November 3' }] }] } }),
    getRankSongs: async (rankid, page, pagesize, options) => { requests.push({ rankid, page, pagesize, options }); return { status: 1, data: { songlist: [], total: 0 } } }
  }, { rankData: { rankid: 8888 } })
  await view.loadPeriods()
  assert.equal(view.periodId(view.periods[0]), 15)
  assert.equal(view.periodName(view.periods[0]), 'November 3')
  view.selectedRankCid = '15'; view.changePeriod()
  await flush()
  assert.equal(requests[0].rankid, 8888)
  assert.equal(requests[0].options.rankCid, '15')
  assert.deepEqual(plain(view.periodCache['15']), [])
})

test('real public comments expose category labels, hot-word content, floor totals and raw text safely', async () => {
  const { view } = fixture('src/components/common/SongDetailsPanel.vue', { getComments: async () => ({ status: 1, err_code: 0,
    count: 100, list: [{ id: 'c', special_child_id: 'child', content: '<b>plain text</b>' }],
    classify_list: [{ id: 13, label: '故事', cnt: 10 }], hot_word_list: [{ content: '现场', count: 20 }]
  }) }, { visible: true })
  view.resolvedResource = { type: 'song', mixsongid: 20 }
  await view.loadComments()
  assert.deepEqual(plain(view.categories), [{ id: 13, name: '故事' }])
  assert.deepEqual(plain(view.hotWords), ['现场'])
  assert.equal(view.commentCount, 100)
  assert.equal(view.content(view.comments.items[0]), '<b>plain text</b>')
})

test('real public search resources use albumid, Avatar and gid while lyric playback retains duration and catalog ID', () => {
  const { view, emitted } = fixture('src/views/SearchView.vue')
  view.searchType = 'album'
  view.openResult({ albumid: 7, albumname: 'Album', img: 'https://example.test/cover.jpg' })
  assert.deepEqual(plain(emitted[0]), ['navigate', 'album', { id: 7, name: 'Album' }])
  assert.equal(view.resultCover({ Avatar: 'https://example.test/author.jpg' }), 'https://example.test/author.jpg')
  view.searchType = 'special'
  view.openResult({ gid: 'collection-public', specialid: 10, specialname: 'Playlist' })
  assert.equal(emitted[1][2].globalCollectionId, 'collection-public')
  assert.equal(emitted[1][2].listId, null)
  view.playSong({ FileHash: 'lyric', FileName: 'Artist - Song', TimeLength: 324, MixSongID: 42 })
  assert.equal(emitted[2][1].timelen, 324000)
  assert.equal(emitted[2][1].album_audio_id, 42)
})

test('default search ignores advertising payloads and honors a returned fallback keyword', () => {
  const { view } = fixture('src/components/layout/TitleBar.vue')
  assert.deepEqual(plain(view.readSearchWords({ data: { ads: [{ jumpType: 'EmbededPage', main_title: 'Advertisement' }], fallback: null } })), [])
  assert.deepEqual(plain(view.readSearchWords({ data: { ads: [{ title: 'Advertisement' }], fallback: { keyword: 'Fallback song' } } })), ['Fallback song'])
})

test('first asynchronous page publishes through the Vue proxy instead of mutating an untracked raw object', async () => {
  for (const kind of ['discover', 'library', 'comments', 'replies']) {
    const pending = deferred()
    const file = kind === 'discover' ? 'src/views/DiscoverView.vue' : kind === 'library' ? 'src/views/MyMusicView.vue' : 'src/components/common/SongDetailsPanel.vue'
    const { view } = fixture(file, { getDiscoverPlaylists: () => pending.promise, getUserHistory: () => pending.promise,
      getComments: () => pending.promise, getCommentReplies: () => pending.promise }, { userLoggedIn: true, userId: 1, visible: true })
    view.pages = vue.reactive({}); view.commentPages = vue.reactive({}); view.replyPages = vue.reactive({})
    view.resolvedResource = { type: 'song', mixsongid: 1 }; view.expandedReply = 'c'
    let renderedCount = -1
    const observer = vue.effect(() => { renderedCount = (kind === 'comments' ? view.comments : kind === 'replies' ? view.replyState : view.page).items.length })
    const loading = kind === 'comments' ? view.loadComments() : kind === 'replies' ? view.loadReplies({ tid: 'c', special_child_id: 'child' }, 0) : view.loadPage()
    pending.resolve({ data: { list: [{ id: 1, hash: 'a' }], total: 1 } })
    await loading
    assert.equal(renderedCount, 1, `${kind} must notify an actual Vue effect when loading completes`)
    vue.stop(observer)
  }
})

test('refresh failure retries page one while a failed append retries the next page', async () => {
  for (const name of ['DiscoverView', 'MyMusicView']) {
    const requests = []; let fail = false
    const fetch = async params => { requests.push(params.page); if (fail) throw new Error('temporary'); return { data: { list: [{ id: params.page, hash: String(params.page) }], total: 3 } } }
    const { view } = fixture(`src/views/${name}.vue`, { getDiscoverPlaylists: fetch, getCloudSongs: fetch }, { userLoggedIn: true, userId: 1 })
    if (name === 'MyMusicView') view.activeTab = 'cloud'
    await view.loadPage()
    fail = true; await view.loadPage(false, true)
    assert.equal(view.page.items.length, 1)
    fail = false; await view.loadPage(view.page.requestAppend, true)
    assert.deepEqual(requests, [1, 1, 1])
    fail = true; await view.loadPage(true)
    fail = false; await view.loadPage(view.page.requestAppend, true)
    assert.deepEqual(requests, [1, 1, 1, 2, 2])
    assert.equal(view.page.items.length, 2)
  }
})
