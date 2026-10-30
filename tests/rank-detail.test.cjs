const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const axios = require('axios')

const root = path.join(__dirname, '..')
const flush = () => new Promise(resolve => setImmediate(resolve))
const plain = value => JSON.parse(JSON.stringify(value))
const quietLogger = { trace() {}, info() {}, warn() {}, error() {} }

function loadModule(file, globals, names) {
  const source = fs.readFileSync(path.join(root, file), 'utf8')
    .replace(/^import[^\n]*\n/gm, '').replace(/^export /gm, '')
  return vm.runInNewContext(`${source}\n;({ ${names.join(', ')} })`, globals)
}

/** Keep production Axios interceptors and the endpoint wrapper; only replace HTTP transport. */
function createApi(respond) {
  const requests = []
  const api = loadModule('src/api/music.js', {
    axios, logger: quietLogger, localStorage: { getItem: () => null }
  }, ['apiClient', 'getRankSongs'])
  api.apiClient.defaults.adapter = async config => {
    const request = { url: config.url, ...config.params }
    requests.push(request)
    const data = await respond(request, requests.length)
    return { data, status: 200, statusText: 'OK', headers: {}, config }
  }
  return { ...api, requests }
}

/** Use the nested public rank/audio shape with synthetic song and artist identities. */
function rankSong(index) {
  return {
    songname: `Song ${index}`, author_name: 'Artist A、Artist B',
    authors: [{ author_id: 10, author_name: 'Artist A' }, { author_id: 20, author_name: 'Artist B' }],
    album_audio_id: index + 1000, album_id: index + 2000,
    album_info: { album_name: `Album ${index}`, sizable_cover: `https://example.test/${index}/{size}.jpg` },
    business: { filename: `Artist A、Artist B - Song ${index}`, sort: index + 1 },
    audio_info: { hash_128: `hash-${index}`, hash_320: `high-${index}`, duration_128: 180125 + index },
    deprecated: { hash: `hash-${index}`, duration: 180125 + index, pay_type: 3 },
    privilege_download: { privilege: 10 }, trans_param: { cpy_grade: 5 }
  }
}

function response(songs, total = songs.length) {
  return { status: 1, data: { songlist: songs, total } }
}

/** Exercise real page loading, normalization and playback methods together with its real API. */
function createRank(t, respond) {
  const api = createApi(respond)
  const metadata = loadModule('src/utils/songMetadata.js', {}, ['getSongArtists', 'getSongBadges'])
  const failures = []
  const sandbox = {
    ArtworkCover: {}, SongBadges: {}, ArtistLinks: {}, ...metadata,
    getRankSongs: api.getRankSongs,
    logger: { ...quietLogger, error: (...args) => failures.push(args) }
  }
  const source = fs.readFileSync(path.join(root, 'src/views/RankDetailView.vue'), 'utf8')
    .match(/<script>([\s\S]*?)<\/script>/)[1]
    .replace(/^import[^\n]*\n/gm, '').replace('export default', 'globalThis.component =')
  vm.runInNewContext(source, sandbox)
  const component = sandbox.component
  const emitted = []
  const rank = {
    ...component.data(), rankData: { rankid: 8888, rankname: 'TOP500', intro: 'Chart description' },
    settings: { playback: { enqueueFullPlaylist: false } },
    $emit: (...args) => emitted.push(args)
  }
  for (const [name, method] of Object.entries(component.methods)) rank[name] = method.bind(rank)
  t.after(() => component.beforeUnmount.call(rank))
  return { rank, component, emitted, failures, ...api, ...metadata }
}

test('rank API uses the playable audio endpoint and forwards default and explicit pagination', async () => {
  const api = createApi(() => response([]))
  await api.getRankSongs(8888)
  await api.getRankSongs(42, 3, 30)
  assert.deepEqual(api.requests, [
    { url: '/rank/audio', rankid: 8888, page: 1, pagesize: 100 },
    { url: '/rank/audio', rankid: 42, page: 3, pagesize: 30 }
  ])
})

test('Top500 loads every page in rank order and keeps playable metadata through all playback paths', async t => {
  const source = Array.from({ length: 500 }, (_, index) => rankSong(index))
  const page = createRank(t, ({ page, pagesize }) => response(source.slice((page - 1) * pagesize, page * pagesize), 500))
  page.component.mounted.call(page.rank)
  await flush()
  assert.equal(page.rank.loading, false)
  assert.equal(page.rank.error, null)
  assert.equal(page.rank.rankInfo, page.rank.rankData)
  assert.equal(page.rank.rankInfo.rankname, 'TOP500')
  assert.deepEqual(page.requests.map(request => request.page), [1, 2, 3, 4, 5])
  assert.ok(page.requests.every(request => request.url === '/rank/audio' && request.rankid === 8888 && request.pagesize === 100))
  assert.deepEqual(Array.from(page.rank.songs, song => song.hash), source.map(song => song.audio_info.hash_128))
  const first = page.rank.songs[0]
  assert.equal(first.name, 'Song 0')
  assert.equal(first.filename, 'Artist A、Artist B - Song 0')
  assert.equal(first.album_id, 2000)
  assert.equal(first.album_audio_id, 1000)
  assert.equal(first.album_name, 'Album 0')
  assert.equal(first.cover, 'https://example.test/0/{size}.jpg')
  assert.equal(first.imgurl, first.cover)
  assert.equal(first.timelen, 180125)
  assert.equal(first.duration, 180.125)
  assert.equal(page.rank.formatDuration(first.duration), '3:00')
  assert.deepEqual(plain(page.getSongArtists(first)), [{ id: 10, name: 'Artist A' }, { id: 20, name: 'Artist B' }])
  assert.equal(page.getSongBadges(first)[0].key, 'vip')
  assert.equal(first.pay_type, 3)
  assert.deepEqual(plain(first.trans_param), source[0].trans_param)

  page.rank.handlePlay(first)
  assert.equal(page.emitted.at(-1)[0], 'play')
  assert.equal(page.emitted.at(-1)[1].timelen, 180125, 'queue metadata stays in milliseconds after normalization repeats')
  page.rank.handlePlayAll()
  const all = page.emitted.at(-1)
  assert.equal(all[0], 'play-all')
  assert.equal(all[1].length, 500)
  assert.equal(all[1][499].hash, 'hash-499')
  assert.equal(all[1][499].timelen, 180624)
  page.rank.settings.playback.enqueueFullPlaylist = true
  page.rank.handlePlay(page.rank.songs[499])
  const reordered = page.emitted.at(-1)[1]
  assert.equal(reordered.length, 500)
  assert.equal(reordered[0].hash, 'hash-499')
  assert.equal(reordered[1].hash, 'hash-0')
  assert.equal(reordered[499].hash, 'hash-498')
  assert.equal(page.rank.songs[0].hash, 'hash-0', 'queue reordering cannot reorder the chart')
})

test('rank normalization supports deprecated audio fields and already-flat songs without changing units', t => {
  const { rank, getSongBadges } = createRank(t, () => response([]))
  const nested = rankSong(1)
  delete nested.audio_info
  const fallback = rank.normalizeRankSong(nested)
  assert.equal(fallback.hash, 'hash-1')
  assert.equal(fallback.timelen, 180126)
  assert.equal(fallback.duration, 180.126)
  const flat = rank.normalizeRankSong({ hash: 'flat', songname: 'Flat song', singername: 'Solo', duration: 61,
    imgurl: 'https://example.test/flat.jpg', album_name: 'Album', privilege: 0, privilege_download: { privilege: 10 } })
  assert.equal(flat.timelen, 61000)
  assert.equal(flat.duration, 61)
  assert.equal(rank.normalizeRankSong(flat).timelen, 61000)
  assert.deepEqual(plain(getSongBadges(flat)), [], 'an explicit song permission wins over nested download metadata')
})

test('an empty rank is a successful result and can replace a previously cached list', async t => {
  const { rank, requests } = createRank(t, () => response([], 0))
  rank.songs = [{ hash: 'cached' }]
  await rank.loadData()
  assert.equal(rank.songs.length, 0)
  assert.equal(rank.error, null)
  assert.equal(rank.loading, false)
  assert.equal(requests.length, 1)
})

test('rank pagination honors total even when the service caps each requested page', async t => {
  const songs = Array.from({ length: 75 }, (_, index) => rankSong(index))
  const { rank, requests } = createRank(t, ({ page }) => ({ status: '1', total: '75',
    data: { songlist: songs.slice((page - 1) * 30, page * 30) } }))
  await rank.loadData()
  assert.equal(rank.error, null)
  assert.equal(rank.songs.length, 75)
  assert.deepEqual(requests.map(request => request.page), [1, 2, 3])
  assert.equal(rank.songs[74].hash, 'hash-74')
})

test('a rank response without a total continues until an empty page instead of trusting requested page size', async t => {
  const { rank, requests } = createRank(t, ({ page }) => ({ status: 1,
    data: { songlist: page < 3 ? [rankSong(page - 1)] : [] } }))
  await rank.loadData()
  assert.equal(rank.error, null)
  assert.equal(rank.songs.length, 2)
  assert.deepEqual(requests.map(request => request.page), [1, 2, 3])
})

for (const [name, fail] of [
  ['network', () => { throw new Error('temporary request failure') }],
  ['business', () => ({ status: 0, data: { songlist: [] } })],
  ['malformed', () => ({ status: 1, data: { songlist: {} } })],
  ['metadata-only', () => ({ status: 1, data: { rankname: 'TOP500', songinfo: [{ name: 'Preview' }] } })]
]) {
  test(`${name} rank failure keeps the previous list and a subsequent retry can recover`, async t => {
    let failing = true
    const { rank, failures } = createRank(t, () => failing ? fail() : response([rankSong(0)]))
    const cached = [{ hash: 'cached', songname: 'Previous chart song' }]
    rank.songs = cached
    await rank.loadData()
    assert.equal(rank.songs, cached)
    assert.ok(rank.error)
    assert.equal(rank.loading, false)
    assert.equal(failures.length, 1)
    failing = false
    await rank.loadData()
    assert.equal(rank.error, null)
    assert.equal(rank.songs[0].hash, 'hash-0')
  })
}

for (const mode of ['failure', 'early-empty', 'repeated-page']) {
  test(`rank ${mode} on a later page cannot publish a partial chart and retry starts at page one`, async t => {
    let failing = true
    const { rank, requests } = createRank(t, ({ page }) => {
      if (page === 1) return response([rankSong(0)], 2)
      if (failing) {
        if (mode === 'failure') throw new Error('second page unavailable')
        return response(mode === 'early-empty' ? [] : [rankSong(0)], 2)
      }
      return response([rankSong(1)], 2)
    })
    const cached = [{ hash: 'cached' }]
    rank.songs = cached
    await rank.loadData()
    assert.equal(rank.songs, cached)
    assert.ok(rank.error)
    assert.deepEqual(requests.map(request => request.page), [1, 2])
    failing = false
    await rank.loadData()
    assert.equal(rank.error, null)
    assert.deepEqual(Array.from(rank.songs, song => song.hash), ['hash-0', 'hash-1'])
    assert.deepEqual(requests.map(request => request.page), [1, 2, 1, 2])
  })
}

test('repeated load clicks share the in-flight request and retain visible songs until every page succeeds', async t => {
  let resolve
  const pending = new Promise(done => { resolve = done })
  const { rank, requests } = createRank(t, ({ page }) => page === 1 ? response([rankSong(0)], 2) : pending)
  const cached = [{ hash: 'cached' }]
  rank.songs = cached
  const loading = rank.loadData()
  await flush()
  await rank.loadData()
  assert.equal(rank.loading, true)
  assert.equal(rank.songs, cached)
  assert.deepEqual(requests.map(request => request.page), [1, 2])
  resolve(response([rankSong(1)], 2))
  await loading
  assert.equal(rank.loading, false)
  assert.deepEqual(Array.from(rank.songs, song => song.hash), ['hash-0', 'hash-1'])
})

for (const reject of [false, true]) {
  test(`rank unmount discards late ${reject ? 'failure' : 'success'} and prevents further pagination`, async t => {
    let finish
    const pending = new Promise((resolve, rejectPromise) => { finish = reject ? rejectPromise : resolve })
    const { rank, component, requests, failures } = createRank(t, () => pending)
    const loading = rank.loadData()
    await flush()
    component.beforeUnmount.call(rank)
    finish(reject ? new Error('late network failure') : response([rankSong(0)], 500))
    await loading
    await rank.loadData()
    assert.equal(rank.songs.length, 0)
    assert.equal(rank.error, null)
    assert.equal(failures.length, 0)
    assert.equal(requests.length, 1)
  })
}
