const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const root = path.join(__dirname, '..')
const logger = { trace() {}, info() {}, warn() {}, error() {} }

function loadModule(file, globals, exports) {
  const source = fs.readFileSync(path.join(root, file), 'utf8')
    .replace(/^import[^\n]*\n/gm, '')
    .replace(/^export /gm, '')
  return vm.runInNewContext(`${source}\n;({ ${exports.join(', ')} })`, globals)
}

/** Keep the real API function and replace only its HTTP boundary. */
function createLookup(respond) {
  const requests = []
  const client = {
    interceptors: { request: { use() {} }, response: { use() {} } },
    async get(url, config) {
      requests.push({ url, ...config.params })
      return respond(requests.length)
    }
  }
  const { findArtistByName } = loadModule('src/api/music.js', {
    axios: { create: () => client }, logger
  }, ['findArtistByName'])
  return { findArtistByName, requests }
}

test('artist lookup selects an exact named non-first result and preserves the returned identity', async () => {
  const selected = { AuthorId: 20, AuthorName: 'Ｇｕｅｓｔ   Singer', avatar: 'https://example.test/artist.png' }
  const lookup = createLookup(() => ({ status: 1, data: { lists: [
    { AuthorId: 10, AuthorName: 'Guest Singer & Friends' },
    { AuthorId: 0, AuthorName: 'Guest Singer' },
    selected
  ] } }))
  assert.equal(await lookup.findArtistByName(' guest singer '), selected)
  assert.deepEqual(lookup.requests, [{ url: '/search', keywords: 'guest singer', type: 'author', pagesize: 5 }])
})

test('artist lookup never falls back to a different name, missing identity, or an empty query', async () => {
  const lookup = createLookup(() => ({ status: 1, data: { lists: [
    { AuthorId: 1, AuthorName: 'Another Singer' },
    { AuthorId: '0', AuthorName: 'Guest Singer' },
    { AuthorName: 'Guest Singer' }
  ] } }))
  assert.equal(await lookup.findArtistByName('Guest Singer'), null)
  for (const name of ['', '  ', null, undefined, {}, 20]) assert.equal(await lookup.findArtistByName(name), null)
  assert.equal(lookup.requests.length, 1)
})

test('artist lookup propagates transport, business, and malformed-response failures for retry', async () => {
  const failure = new Error('temporary network failure')
  const network = createLookup(() => { throw failure })
  await assert.rejects(network.findArtistByName('Guest Singer'), error => error === failure)
  const business = createLookup(() => ({ status: 0, data: { lists: [] } }))
  await assert.rejects(business.findArtistByName('Guest Singer'), /查询歌手失败/)
  const malformed = createLookup(() => ({ status: 1, data: { lists: {} } }))
  await assert.rejects(malformed.findArtistByName('Guest Singer'), /搜索结果格式无效/)
})

/** Exercise the real page initializer and lookup together, with detail/audio boundaries controlled. */
function createArtist(t, respond, options = {}) {
  const lookup = createLookup(respond)
  const requests = []
  const { getSongArtists } = loadModule('src/utils/songMetadata.js', {}, ['getSongArtists'])
  const sandbox = {
    ArtworkCover: {}, SongBadges: {}, ArtistLinks: {}, logger, getSongArtists,
    findArtistByName: lookup.findArtistByName,
    async getArtistDetail(id) {
      requests.push(['detail', id])
      return options.detail ? options.detail(id) : { status: 1, data: { author_name: 'Guest Singer', id } }
    },
    async getArtistAudios(id, page, pagesize, sort) {
      requests.push(['audios', id, sort])
      return { status: 1, data: { lists: [] } }
    }
  }
  const source = fs.readFileSync(path.join(root, 'src/views/logic/ArtistView.js'), 'utf8')
    .replace(/^import[^\n]*\n/gm, '').replace('export default', 'globalThis.component =')
  vm.runInNewContext(source, sandbox)
  const component = sandbox.component
  const artist = {
    ...component.data.call({ artistId: options.id || null }),
    artistId: options.id || null, artistName: 'Guest Singer', $refs: {},
    $nextTick: callback => Promise.resolve().then(() => callback?.())
  }
  for (const [name, method] of Object.entries(component.methods)) artist[name] = method.bind(artist)
  t.after(() => component.beforeUnmount.call(artist))
  return { component, artist, requests, lookup }
}

test('artist initialization resolves only the selected singer and keeps each request on that identity', async t => {
  const page = createArtist(t, () => ({ status: 1, data: { lists: [
    { AuthorId: 10, AuthorName: 'Lead Singer' },
    { AuthorId: '0', author_id: 20, AuthorName: 'Guest Singer' }
  ] } }))
  await page.component.mounted.call(page.artist)
  assert.equal(page.artist.id, 20)
  assert.deepEqual(page.requests, [['detail', 20], ['audios', 20, 'hot']])
  assert.equal(page.lookup.requests[0].keywords, 'Guest Singer')
  assert.equal(page.artist.initialLoadComplete, true)
  assert.equal(page.artist.initialLoading, false)
  assert.equal(page.artist.errorMessage, '')
})

test('a missing exact artist produces a retryable error without invalid detail or tab requests', async t => {
  let found = false
  const page = createArtist(t, () => ({ status: 1, data: { lists: found
    ? [{ AuthorId: 20, AuthorName: 'Guest Singer' }]
    : [{ AuthorId: 10, AuthorName: 'Different Singer' }]
  } }))
  await page.artist.loadInitial()
  assert.equal(page.artist.artist, null)
  assert.match(page.artist.errorMessage, /未找到/)
  assert.equal(page.artist.initialLoadComplete, true)
  page.artist.activeTab = 'songs'
  page.artist.resumeActiveTab()
  assert.deepEqual(page.requests, [])
  page.artist.activeTab = 'hot'
  found = true
  await page.artist.loadInitial()
  assert.equal(page.lookup.requests.length, 2)
  assert.equal(page.artist.id, 20)
  assert.equal(page.artist.artist.author_name, 'Guest Singer')
  assert.equal(page.artist.errorMessage, '')
})

test('detail failure remains visible and retry reuses the resolved identity', async t => {
  let attempt = 0
  const page = createArtist(t, () => ({ data: { lists: [{ author_id: 20, author_name: 'Guest Singer' }] } }), {
    detail(id) {
      if (++attempt === 1) throw new Error('temporary detail failure')
      return { data: { author_name: 'Guest Singer', id } }
    }
  })
  await page.artist.loadInitial()
  assert.match(page.artist.errorMessage, /temporary detail failure/)
  assert.deepEqual(page.requests, [['detail', 20]])
  await page.artist.loadInitial()
  assert.equal(page.lookup.requests.length, 1)
  assert.deepEqual(page.requests, [['detail', 20], ['detail', 20], ['audios', 20, 'hot']])
  assert.equal(page.artist.errorMessage, '')
})

test('repeated retry clicks share initialization and unmount discards a late name resolution', async t => {
  let resolve
  const response = new Promise(done => { resolve = done })
  const page = createArtist(t, () => response)
  const loading = page.artist.loadInitial()
  await page.artist.loadInitial()
  assert.equal(page.lookup.requests.length, 1)
  page.component.beforeUnmount.call(page.artist)
  resolve({ data: { lists: [{ AuthorId: 20, AuthorName: 'Guest Singer' }] } })
  await loading
  assert.equal(page.artist.id, null)
  assert.equal(page.artist.artist, null)
  assert.equal(page.artist.initialLoadComplete, false)
  assert.deepEqual(page.requests, [])
})

test('unmount during artist details cannot publish the page or start its hot-song request', async t => {
  let resolve
  const response = new Promise(done => { resolve = done })
  const page = createArtist(t, () => { throw new Error('known IDs never require lookup') }, {
    id: 20, detail: () => response
  })
  const loading = page.artist.loadInitial()
  page.component.beforeUnmount.call(page.artist)
  resolve({ data: { id: 20, author_name: 'Guest Singer' } })
  await loading
  assert.equal(page.lookup.requests.length, 0)
  assert.equal(page.artist.artist, null)
  assert.deepEqual(page.requests, [['detail', 20]])
})
