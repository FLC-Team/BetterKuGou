const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const flush = () => new Promise(resolve => setImmediate(resolve))

/** Load the real artist lifecycle and tab loaders with only network and observer boundaries mocked. */
function createArtist(t, hotRequest = () => Promise.reject(new Error('temporary hot-song failure'))) {
  const requests = []
  const failures = []
  const sandbox = {
    ArtworkCover: {},
    process: { env: { NODE_ENV: 'test' } },
    logger: {
      trace() {},
      warn() {},
      error: (...args) => failures.push(args)
    },
    getArtistDetail: async id => ({ data: { author_name: 'Example artist', id } }),
    getArtistAudios: async (id, page, pagesize, sort) => {
      requests.push({ type: 'songs', id, page, pagesize, sort })
      if (sort === 'hot') return hotRequest()
      return { data: { lists: [{ hash: 'single', name: 'Single', cover: 'https://example.test/cover.jpg' }] } }
    },
    getArtistAlbums: async (id, page) => {
      requests.push({ type: 'albums', id, page })
      return { data: { lists: [{ album_id: 10, album_name: 'Album', cover: 'https://example.test/album.jpg' }] } }
    },
    IntersectionObserver: class {
      observe() {}
      disconnect() {}
    }
  }
  const source = fs.readFileSync(path.join(__dirname, '../src/views/logic/ArtistView.js'), 'utf8')
    .replace(/^import[^\n]*\n/gm, '')
    .replace('export default', 'globalThis.component =')
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)
  const { component } = sandbox
  const artist = {
    ...component.data.call({ artistId: 7 }),
    artistId: 7,
    artistName: '',
    $refs: { sentinel: {}, scrollArea: {} },
    $nextTick: callback => Promise.resolve().then(() => callback?.())
  }
  for (const [name, method] of Object.entries(component.methods)) artist[name] = method.bind(artist)
  t.after(() => component.beforeUnmount.call(artist))
  return { component, artist, requests, failures }
}

for (const tab of ['songs', 'albums']) {
  test(`a failed artist hot-song request does not prevent the cached ${tab} tab from loading`, async t => {
    const { component, artist, requests, failures } = createArtist(t)
    const uncaught = []
    await component.mounted.call(artist).catch(error => uncaught.push(error))
    assert.equal(artist.initialLoadComplete, true)
    assert.equal(uncaught.length, 0)
    assert.equal(failures.length, 1)
    assert.equal(artist.artist.author_name, 'Example artist')

    artist.activeTab = tab
    component.watch.activeTab.call(artist, tab)
    await flush()
    assert.equal(artist[tab].length, 1)
    assert.equal(requests.filter(request => request.type === tab && request.sort !== 'hot').length, 1)

    component.deactivated.call(artist)
    component.activated.call(artist)
    await flush()
    assert.equal(requests.filter(request => request.type === tab && request.sort !== 'hot').length, 1)
  })
}

test('artist initialization failures do not load a hidden tab until the page is activated', async t => {
  let rejectHot
  const hot = new Promise((_resolve, reject) => { rejectHot = reject })
  const { component, artist, requests } = createArtist(t, () => hot)
  const mounting = component.mounted.call(artist).catch(() => {})
  await flush()
  artist.activeTab = 'songs'
  component.deactivated.call(artist)
  rejectHot(new Error('temporary hot-song failure'))
  await mounting
  await flush()
  assert.equal(artist.initialLoadComplete, true)
  assert.equal(requests.filter(request => request.sort === 'new').length, 0)
  assert.equal(artist.infiniteScrollObserver, null)

  component.activated.call(artist)
  await flush()
  assert.equal(artist.songs.length, 1)
  assert.equal(requests.filter(request => request.sort === 'new').length, 1)
})

/** Exercise Home's real loaders and cache hooks with controlled responses and a local-day clock. */
function createHome(t, songs = []) {
  const requests = { fm: [], daily: [], rank: [], ai: [] }
  const memory = new Map([
    ['kugou_userid', 'example-user'],
    ['kugou_token', 'example-token'],
    ['favorite_songs_userid', 'example-user'],
    ['favorite_songs', JSON.stringify(songs)]
  ])
  let currentDay = 'Day 1'
  const request = type => (...args) => {
    let resolve
    let reject
    const promise = new Promise((done, fail) => { resolve = done; reject = fail })
    requests[type].push({ args, resolve, reject })
    return promise
  }
  const sandbox = {
    logger: { trace() {}, error() {} },
    Date: class { toDateString() { return currentDay } },
    localStorage: { getItem: key => memory.get(key) ?? null },
    getPersonalFM: request('fm'),
    getEverydayRecommend: request('daily'),
    getRankList: request('rank'),
    getAIRecommend: request('ai')
  }
  const source = fs.readFileSync(path.join(__dirname, '../src/views/HomeView.vue'), 'utf8')
    .match(/<script>([\s\S]*?)<\/script>/)[1]
    .replace(/^import\b[\s\S]*?from\s+['"][^'"]+['"]\s*;?\s*$/gm, '')
    .replace('export default', 'globalThis.component =')
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)
  const { component } = sandbox
  const home = { favoritesRevision: 0, ...component.data() }
  for (const [name, method] of Object.entries(component.methods)) home[name] = method.bind(home)
  t.after(() => component.beforeUnmount.call(home))
  return {
    component,
    home,
    requests,
    changeDay(day) { currentDay = day },
    changeFavorites(nextSongs) {
      memory.set('favorite_songs', JSON.stringify(nextSongs))
      home.favoritesRevision += 1
      component.watch.favoritesRevision.call(home)
    }
  }
}

test('cached home activation retries only failed modules and shares initial in-flight requests', async t => {
  const { component, home, requests } = createHome(t)
  component.mounted.call(home)
  component.activated.call(home)
  assert.deepEqual(Object.values(requests).map(items => items.length), [1, 1, 1, 0])
  assert.equal(home.dailyRefreshPending, false)

  requests.fm[0].resolve({ status: 1, data: { hotsong_num: 8 } })
  requests.daily[0].reject(new Error('temporary recommendation failure'))
  requests.rank[0].resolve({ status: 0 })
  await flush()
  assert.equal(home.fmLoaded, true)
  assert.equal(home.rankLoaded, false)
  assert.equal(home.dailyLoadedDate, '')
  assert.deepEqual(Object.values(requests).map(items => items.length), [1, 1, 1, 0], 'failure does not retry itself')

  component.activated.call(home)
  component.activated.call(home)
  assert.deepEqual(Object.values(requests).map(items => items.length), [1, 2, 2, 0])
  requests.daily[1].resolve({ status: 1, data: { song_list: [{ hash: 'daily-song' }] } })
  requests.rank[1].resolve({ status: 1, data: { info: [{ rankid: 1 }] } })
  await flush()
  component.activated.call(home)
  assert.deepEqual(Object.values(requests).map(items => items.length), [1, 2, 2, 0], 'successful resources remain cached')
  assert.equal(home.dailyLoadedDate, 'Day 1')
})

test('successful empty home resources are cached instead of reloaded on every activation', async t => {
  const { component, home, requests } = createHome(t)
  component.mounted.call(home)
  requests.fm[0].resolve({ status: 1, data: { hotsong_num: 0 } })
  requests.daily[0].resolve({ status: 1, data: { song_list: [] } })
  requests.rank[0].resolve({ status: 1, data: { info: [] } })
  await flush()
  component.activated.call(home)
  component.activated.call(home)
  assert.deepEqual(Object.values(requests).map(items => items.length), [1, 1, 1, 0])
  assert.equal(home.fmLoaded, true)
  assert.equal(home.rankLoaded, true)
  assert.equal(home.dailyLoadedDate, 'Day 1')
})

test('home retains the current AI response when favorite metadata or hashes after the first ten change', async t => {
  const songs = Array.from({ length: 11 }, (_, index) => ({ hash: `hash-${index}`, name: `Song ${index}` }))
  const { home, requests, changeFavorites } = createHome(t, songs)
  const loading = home.loadAIRecommend()
  changeFavorites(songs.map((song, index) => index === 10 ? { ...song, hash: 'different-tail' } : { ...song, name: 'Updated metadata' }))
  assert.equal(requests.ai.length, 1)
  assert.equal(home.aiRefreshPending, false)
  requests.ai[0].resolve({ status: 1, data: { song_list: [{ hash: 'valid-recommendation' }] } })
  await loading
  assert.equal(home.aiRecommendList[0].hash, 'valid-recommendation', 'an unrelated revision cannot discard a valid response')

  changeFavorites(songs.map((song, index) => index === 10 ? { ...song, hash: 'another-tail' } : song))
  assert.equal(requests.ai.length, 1, 'the same committed first-ten seed does not request AI again')
})

test('home merges actual AI seed changes, ignores stale responses and permits an explicit same-seed click refresh', async t => {
  const { home, requests, changeFavorites } = createHome(t, [{ hash: 'seed-a' }])
  const initial = home.loadAIRecommend()
  changeFavorites([{ hash: 'seed-b' }])
  changeFavorites([{ hash: 'seed-c' }])
  assert.equal(requests.ai.length, 1)
  requests.ai[0].resolve({ status: 1, data: { song_list: [{ hash: 'stale-a' }] } })
  await initial
  assert.equal(home.aiRecommendList.length, 0)
  assert.equal(requests.ai.length, 2)
  assert.equal(requests.ai[1].args[0], 'seed-c')
  requests.ai[1].resolve({ status: 1, data: { song_list: [{ hash: 'current-c' }] } })
  await flush()
  assert.equal(home.aiRecommendList[0].hash, 'current-c')

  const manual = home.loadAIRecommend({ type: 'click', force: false })
  assert.equal(requests.ai.length, 3)
  assert.equal(requests.ai[2].args[0], 'seed-c')
  changeFavorites([{ hash: 'temporary-seed' }])
  changeFavorites([{ hash: 'seed-c' }])
  requests.ai[2].resolve({ status: 1, data: { song_list: [{ hash: 'manually-refreshed' }] } })
  await manual
  assert.equal(home.aiRecommendList[0].hash, 'manually-refreshed')
  assert.equal(requests.ai.length, 3, 'returning to the active seed cancels an unnecessary queued refresh')
})

test('home merges a local-day change behind an old daily request without spinning after failures', async t => {
  const { component, home, requests, changeDay } = createHome(t)
  component.mounted.call(home)
  requests.fm[0].resolve({ status: 1, data: { hotsong_num: 0 } })
  requests.rank[0].resolve({ status: 1, data: { info: [] } })
  changeDay('Day 2')
  component.activated.call(home)
  component.activated.call(home)
  assert.equal(requests.daily.length, 1)
  assert.equal(home.dailyLoadedDate, '')
  assert.equal(home.dailyRequestedDate, 'Day 1')
  requests.daily[0].reject(new Error('old-day request failed'))
  await flush()
  assert.equal(requests.daily.length, 2)
  assert.equal(home.dailyRequestedDate, 'Day 2')
  requests.daily[1].reject(new Error('current-day request failed'))
  await flush()
  assert.equal(requests.daily.length, 2, 'a failed current-day refresh waits for another activation')

  component.activated.call(home)
  assert.equal(requests.daily.length, 3)
  requests.daily[2].resolve({ status: 1, data: { song_list: [] } })
  await flush()
  component.activated.call(home)
  assert.equal(requests.daily.length, 3)
  assert.equal(home.dailyLoadedDate, 'Day 2')
  assert.equal(requests.fm.length, 1)
  assert.equal(requests.rank.length, 1)
})
