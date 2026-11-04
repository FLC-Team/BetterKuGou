const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const addTracks = require('../KuGouMusicApi/module/playlist_tracks_add.js')

const root = path.join(__dirname, '..')
function load(file, globals = {}) {
  const raw = fs.readFileSync(path.join(root, file), 'utf8')
  const names = [...raw.matchAll(/^export (?:async )?(?:function|const) (\w+)/gm)].map(match => match[1])
  const source = raw.replace(/^import[^\n]*\n/gm, '').replace(/^export /gm, '')
  return vm.runInNewContext(`${source}\n;({ ${names.join(',')} })`, globals)
}
const metadata = load('src/utils/libraryMetadata.js', load('src/utils/songMetadata.js'))
const plain = value => JSON.parse(JSON.stringify(value))

function fixture(respond = () => ({ status: 1, data: { list: [] } })) {
  const storage = new Map([['kugou_token', 'placeholder-token'], ['kugou_userid', '123']])
  const requests = []
  const warnings = []
  const apiClient = {
    async get(route, config) {
      const request = { route, method: 'get', params: config.params, config }
      requests.push(request)
      return respond(request, requests.length)
    },
    async post(route, body, config) {
      const request = { route, method: 'post', params: body, config }
      requests.push(request)
      return respond(request, requests.length)
    },
  }
  const api = load('src/api/library.js', { apiClient, ...metadata, logger: { warn: (...args) => warnings.push(args) },
    localStorage: { getItem: key => storage.get(key) ?? null } })
  return { api, storage, requests, warnings }
}

test('history wrappers and followed singer extensions retain real identities and artwork fields', () => {
  const song = metadata.normalizeLibrarySong({ mxid: 81, song: { FileName: 'Artist - Track.mp3',
    FileHash: ' ABC ', album_img: 'https://imge.kugou.com/{size}/album.jpg', SingerName: 'Artist' }, time: 1700000000 })
  assert.equal(song.hash, 'abc')
  assert.equal(song.album_audio_id, 81)
  assert.equal(song.name, 'Artist - Track.mp3')
  assert.equal(song.cover, 'https://imge.kugou.com/{size}/album.jpg')
  assert.equal(song.singerinfo[0].name, 'Artist')
  for (const extra of [{ singerid: 42, k_pic: '//singerimg.kugou.com/{size}/artist.jpg' },
    JSON.stringify({ singerid: 42, k_pic: '//singerimg.kugou.com/{size}/artist.jpg' })]) {
    const artist = metadata.normalizeLibraryArtist({ userid: 999, nickname: 'Artist', ext_params: extra })
    assert.equal(artist.singerid, 42)
    assert.equal(artist.singername, 'Artist')
    assert.equal(artist.avatar, '//singerimg.kugou.com/{size}/artist.jpg')
  }
  const person = metadata.normalizeLibraryArtist({ userid: 999, nickname: 'Person', ext_params: '{broken' })
  assert.equal(person.singerid, undefined, 'a followed user ID cannot become a singer ID')
})

test('history metadata fills missing playable hashes and covers without changing source, permissions or file identity', async () => {
  const f = fixture(({ route, params }) => {
    assert.equal(route, '/krm/audio')
    assert.equal(params.album_audio_id, '81,82')
    assert.equal(params.fields, 'base,audio_info,album_info,authors.base')
    return { status: 1, data: [81, 82].map(id => ({ base: { album_audio_id: id, songname: `Track ${id}` },
      audio_info: { hash_128: `HASH${id}`, duration_128: 180000 },
      album_info: { sizable_cover: `https://imge.kugou.com/{size}/${id}.jpg` },
      authors: [{ base: { author_id: 9, author_name: 'Artist' } }], copyright: { privilege: 10 } })) }
  })
  const input = [{ mxid: 81, fileid: 12, privilege: 1 }, { album_audio_id: 82, hash: 'existing', name: 'Original.mp3',
    source: 'cloud', sourceUserId: '123', originalName: 'Original.mp3' }]
  const songs = await f.api.completeLibrarySongs(input)
  assert.equal(songs[0].hash, 'hash81')
  assert.equal(songs[0].cover, 'https://imge.kugou.com/{size}/81.jpg')
  assert.equal(songs[0].singerinfo[0].id, 9)
  assert.equal(songs[0].fileid, 12)
  assert.equal(songs[0].privilege, 1)
  assert.equal(songs[1].hash, 'existing')
  assert.equal(songs[1].source, 'cloud')
  assert.equal(songs[1].sourceUserId, '123')
  assert.equal(songs[1].originalName, 'Original.mp3')
  assert.equal(input[0].hash, undefined)
  assert.equal(f.requests.length, 1, 'metadata resolution never fetches an audio URL')
})

test('hash-only covers use privilege metadata and optional artwork failure preserves playable rows', async () => {
  const f = fixture(({ route }) => {
    assert.equal(route, '/privilege/lite')
    return { status: 1, data: [{ hash: 'ABC', info: { album_img: 'https://imge.kugou.com/album.jpg' } }] }
  })
  const [song] = await f.api.completeLibrarySongs([{ hash: 'abc', name: 'Track', fileid: 42 }])
  assert.equal(song.cover, 'https://imge.kugou.com/album.jpg')
  assert.equal(song.fileid, 42)
  const unavailable = fixture(() => ({ status: 0, error_code: 503 }))
  const [availableSong] = await unavailable.api.completeLibrarySongs([{ hash: 'abc', name: 'Track' }])
  assert.equal(availableSong.hash, 'abc')
  assert.equal(unavailable.warnings.length, 1)
  await assert.rejects(unavailable.api.completeLibrarySongs([{ mxid: 42 }]), { code: 'LIBRARY_REQUEST_FAILED' })
})

test('metadata batches are bounded, skip complete records and reject account changes before further requests', async () => {
  const complete = fixture(() => { throw new Error('unexpected request') })
  await complete.api.completeLibrarySongs([{ hash: 'abc', name: 'Track', cover: 'https://imge.kugou.com/a.jpg', album_audio_id: 1 }])
  assert.equal(complete.requests.length, 0)
  const input = Array.from({ length: 51 }, (_, index) => ({ mxid: index + 1 }))
  const batched = fixture(({ params }) => ({ status: 1, data: params.album_audio_id.split(',').map(id => ({
    album_audio_id: Number(id), hash: `hash${id}`, name: `Track ${id}`, cover: `https://imge.kugou.com/${id}.jpg`
  })) }))
  assert.equal((await batched.api.completeLibrarySongs(input)).length, 51)
  assert.deepEqual(batched.requests.map(request => request.params.album_audio_id.split(',').length), [50, 1])

  let finish
  const changing = fixture(() => new Promise(resolve => { finish = resolve }))
  const pending = changing.api.completeLibrarySongs(input)
  changing.storage.set('kugou_userid', '456')
  finish({ status: 1, data: [] })
  await assert.rejects(pending, { code: 'ERR_CANCELED' })
  assert.equal(changing.requests.length, 1)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(complete.api.completeLibrarySongs([], { signal: controller.signal }), { code: 'ERR_CANCELED' })
})

test('playlist identities remain separate and fuzzy names never authorize favorite mutations', () => {
  const resource = metadata.normalizePlaylistResource({ id: 'legacy', global_collection_id: 'collection_1_123_9_0',
    listid: 9, list_create_userid: 123, name: '喜欢的民谣' }, { userId: '123' })
  assert.equal(resource.id, 'collection_1_123_9_0')
  assert.equal(resource.listId, 9)
  assert.equal(resource.isOwned, true)
  assert.equal(resource.isFavorite, false)
  assert.equal(resource.favoriteCandidate, false)
  assert.equal(metadata.normalizePlaylistResource({ id: 3, name: '我喜欢的音乐' }).listId, null)
  assert.equal(metadata.normalizePlaylistResource({ listid: 3, name: '我喜欢的音乐' }).isFavorite, false)
  assert.equal(metadata.normalizePlaylistResource({ listid: 3, is_favorite: 1 }).isFavorite, true)
})

test('song normalization preserves entry identity, rights, cloud ownership and exact original names', () => {
  const raw = { FileHash: 'ABC123', FileName: 'Example, Part 2 | Live.mp3', file_id: '9001', MixSongID: 300,
    audio_id: 25, privilege: 10, singerinfo: [{ id: 7, name: 'Artist' }] }
  const song = metadata.normalizeLibrarySong(raw, { source: 'cloud', sourceUserId: '123' })
  assert.equal(song.hash, 'abc123')
  assert.equal(song.fileid, '9001')
  assert.equal(song.album_audio_id, 300)
  assert.equal(song.originalName, raw.FileName)
  assert.equal(song.sourceUserId, '123')
  assert.equal(song.privilege, 10)
  assert.equal(raw.hash, undefined)
  assert.equal(metadata.normalizeLibrarySong({ audio_info: { hash_128: 'ABC', duration_128: 180125 } }).timelen, 180125)
  assert.equal(metadata.normalizeLibrarySong({ Duration: 180 }).timelen, 180000)
  assert.equal(metadata.normalizeLibrarySong({ time_length: 350 }).timelen, 350000)
  assert.equal(metadata.normalizeLibrarySong({ TimeLength: 324 }).timelen, 324000)
  assert.equal(metadata.normalizeLibrarySong({ timelength: 194923 }).timelen, 194923)
})

test('public related versions and searched playlists retain proven nested identities and rights', () => {
  const song = metadata.normalizeLibrarySong({ base: { album_audio_id: 23, songname: 'Version', album_name: 'Album' },
    audio_info: { hash: 'ABC', timelength: 324858 }, album_info: { cover: 'https://example.invalid/cover.jpg' },
    authors: [{ base: { author_id: 7, author_name: 'Artist' } }], copyright: { privilege: 10, pay_type: 3 } })
  assert.equal(song.hash, 'abc')
  assert.equal(song.name, 'Version')
  assert.equal(song.album_name, 'Album')
  assert.equal(song.timelen, 324858)
  assert.equal(song.cover, 'https://example.invalid/cover.jpg')
  assert.deepEqual(plain(song.singerinfo), [{ id: 7, name: 'Artist' }])
  assert.equal(song.privilege, 10)
  assert.equal(song.pay_type, 3)
  const playlist = metadata.normalizePlaylistResource({ gid: 'collection-public', suid: '42', specialid: 9, img: 'cover' })
  assert.equal(playlist.id, 'collection-public')
  assert.equal(playlist.ownerId, '42')
  assert.equal(playlist.listId, null)
  assert.equal(playlist.isOwned, false)
  assert.equal(playlist.cover, 'cover')
})

test('queue song identities require a hash and isolate cloud owners and catalogue sources', () => {
  assert.equal(metadata.librarySongKey({ source: 'cloud', sourceUserId: '123' }), '')
  assert.equal(metadata.librarySongKey({ hash: 'ABC' }), metadata.librarySongKey({ hash: 'abc', source: 'catalog' }))
  assert.notEqual(metadata.librarySongKey({ hash: 'abc' }), metadata.librarySongKey({ hash: 'abc', source: 'cloud', sourceUserId: '123' }))
  assert.notEqual(metadata.librarySongKey({ hash: 'abc', source: 'cloud', sourceUserId: '123' }), metadata.librarySongKey({ hash: 'abc', source: 'cloud', sourceUserId: '456' }))
})

test('comment business errors override a successful transport status and floor prefers its child partition', async () => {
  const failing = fixture(() => ({ status: 1, err_code: 60102 }))
  await assert.rejects(failing.api.getComments({ type: 'song', album_audio_id: 3 }), { code: 'LIBRARY_REQUEST_FAILED', businessCode: 60102 })
  const success = fixture(() => ({ status: 1, err_code: 0, list: [] }))
  await success.api.getCommentReplies({ type: 'song', album_audio_id: 3, special_id: 1 }, { id: 4, special_id: 1, special_child_id: 2 })
  assert.equal(String(success.requests[0].params.special_id), '2')
})

test('list extraction honors explicit dotted paths and recognizes a valid empty result', () => {
  const response = { data: { list: ['unrelated'], special_recommend: { special_list: [] } } }
  assert.deepEqual(plain(metadata.extractLibraryList(response, ['special_recommend.special_list'])), [])
  assert.equal(metadata.findLibraryList({ data: { unknown: [] } }), null)
})

test('private requests capture cookie identity, reject business failures and never expose credentials in errors', async () => {
  const f = fixture(() => ({ status: 0, error_code: 500, error: 'placeholder-token' }))
  await assert.rejects(f.api.getUserHistory(), error => error.code === 'LIBRARY_REQUEST_FAILED' && !error.message.includes('placeholder-token'))
  assert.equal(f.requests[0].params.cookie, 'token=placeholder-token;userid=123')
  f.storage.delete('kugou_token')
  await assert.rejects(f.api.getUserHistory(), { code: 'LOGIN_REQUIRED' })
  assert.equal(f.requests.length, 1)
})

test('late private responses and aborted requests cannot enter a different account', async () => {
  let resolve
  const f = fixture(() => new Promise(done => { resolve = done }))
  const pending = f.api.getUserHistory()
  f.storage.set('kugou_userid', '456')
  resolve({ status: 1, data: { list: [] } })
  await assert.rejects(pending, { code: 'ERR_CANCELED' })
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(f.api.getCloudSongs({}, { signal: controller.signal }), { code: 'ERR_CANCELED' })
  assert.equal(f.requests.length, 1)
})

test('complete user directory adapts to capped pages and retains list IDs distinct from global IDs', async () => {
  const rows = Array.from({ length: 7 }, (_, n) => ({ listid: n + 1, global_collection_id: `collection_${n + 1}`, name: `List ${n + 1}` }))
  const f = fixture(({ params }) => ({ status: 1, data: { total: 7,
    info: rows.slice((params.page - 1) * Math.min(params.pagesize, 3), params.page * Math.min(params.pagesize, 3)) } }))
  const lists = await f.api.getAllUserPlaylists()
  assert.equal(lists.length, 7)
  assert.deepEqual(f.requests.map(request => request.params.pagesize), [30, 3, 3])
  assert.equal(lists[0].listId, 1)
  assert.equal(lists[0].globalCollectionId, 'collection_1')
  assert.equal(lists[0].source, 'owned')
  assert.equal(lists[0].isOwned, false)
})

test('directories without totals keep a stable default page size through full and empty pages', async () => {
  for (const count of [0, 30, 31, 60]) {
    const rows = Array.from({ length: count }, (_, i) => ({ listid: i + 1 }))
    const f = fixture(({ params }) => ({ status: 1, error_code: 0, data: {
      info: rows.slice((params.page - 1) * params.pagesize, params.page * params.pagesize),
      list_count: count, collect_count: 0, album_count: 0
    } }))
    const lists = await f.api.getAllUserPlaylists({ pagesize: 100 })
    assert.equal(lists.length, count)
    assert.deepEqual(plain(lists.map(item => item.listId)), rows.map(item => item.listid))
    assert.equal(f.requests.length, Math.floor(count / 30) + 1)
    assert.ok(f.requests.every(request => request.params.pagesize === 30))
  }
})

test('directory pagination rejects repeated full pages and changed explicit totals', async () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ listid: i + 1 }))
  const repeated = fixture(() => ({ status: 1, data: { info: rows } }))
  await assert.rejects(repeated.api.getAllUserPlaylists(), /分页未前进/)
  assert.equal(repeated.requests.length, 2)
  const changed = fixture(({ params }) => ({ status: 1, data: {
    total: params.page === 1 ? 40 : 41,
    info: params.page === 1 ? rows : [{ listid: 31 }]
  } }))
  await assert.rejects(changed.api.getAllUserPlaylists(), /列表内容已改变/)
})

test('own playlist pagination preserves duplicate songs with different fileids and rejects stalled pages', async () => {
  const f = fixture(({ params }) => ({ status: 1, data: { total: 3, songs: params.page === 1
    ? [{ hash: 'a', name: 'Same', fileid: 10 }, { hash: 'a', name: 'Same', fileid: 11 }]
    : [{ hash: 'b', name: 'Other', fileid: 12 }] } }))
  const songs = await f.api.getAllPlaylistTracks({ listId: 9, globalCollectionId: 'collection_9', source: 'owned' })
  assert.equal(songs.length, 3)
  assert.deepEqual(plain(songs.map(song => song.fileid)), [10, 11, 12])
  assert.ok(f.requests.every(request => request.route === '/playlist/track/all/new' && request.params.listid === '9'))
  const stalled = fixture(() => ({ status: 1, data: { songs: [{ hash: 'a', name: 'Same', fileid: 10 }] } }))
  await assert.rejects(stalled.api.getAllPlaylistTracks({ listId: 9, source: 'owned' }), /分页未前进/)
})

test('track pagination without totals still adapts to a capped first page', async () => {
  for (const resource of [{ listId: 9, source: 'owned' }, { globalCollectionId: 'fixture-public' }]) {
    const rows = Array.from({ length: 5 }, (_, i) => ({ hash: `fixture-${i}`, fileid: i + 1 }))
    const f = fixture(({ params }) => {
      const size = Math.min(params.pagesize, 2)
      return { status: 1, data: { songs: rows.slice((params.page - 1) * size, params.page * size) } }
    })
    const tracks = await f.api.getAllPlaylistTracks(resource)
    assert.deepEqual(plain(tracks.map(song => song.fileid)), [1, 2, 3, 4, 5])
    assert.deepEqual(f.requests.map(request => request.params.pagesize), [100, 2, 2])
  }
})

test('invalid directory pages expose safe pagination context without response contents', async () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ listid: i + 1 }))
  const f = fixture(({ params }) => ({ status: 1, data: params.page === 1 ? { info: rows } : {
    info: { token: 'private-response-token', name: 'private-playlist-name' }, userid: 'private-account'
  } }))
  await assert.rejects(f.api.getAllUserPlaylists(), error => {
    assert.equal(error.code, 'INVALID_LIBRARY_PAGE')
    assert.deepEqual(plain(error.cause), {
      endpoint: '/user/playlist', page: 2, pagesize: 30, received: 30, expectedTotal: null,
      dataType: 'object', listTypes: { info: 'object', list: 'undefined', lists: 'undefined', songs: 'undefined' }
    })
    assert.doesNotMatch(JSON.stringify(error), /private-|placeholder-token/)
    return true
  })
})

test('public discovery listid belongs to the creator and never selects the private account endpoint', async () => {
  const f = fixture(() => ({ status: 1, data: { songs: [], total: 0 } }))
  await f.api.getAllPlaylistTracks({ global_collection_id: 'collection_9', listid: 9, list_create_userid: 456 })
  assert.equal(f.requests[0].route, '/playlist/track/all')
  assert.equal(f.requests[0].params.id, 'collection_9')
})

test('partial pagination and unknown response structures cannot replace a complete snapshot', async () => {
  const f = fixture((request, attempt) => ({ status: 1, data: { total: 3, info: attempt === 1 ? [{ listid: 1 }] : [] } }))
  await assert.rejects(f.api.getAllUserPlaylists(), /未加载完整/)
  const malformed = fixture(() => ({ status: 1, data: {} }))
  await assert.rejects(malformed.api.getAllUserPlaylists(), /格式无效/)
  const missingLaterTotal = fixture((request, attempt) => ({ status: 1, data: attempt === 1
    ? { total: 3, info: [{ listid: 1 }, { listid: 2 }] } : { info: [] } }))
  await assert.rejects(missingLaterTotal.api.getAllUserPlaylists(), /未加载完整/)
})

test('the real music interceptor refuses a captured old account before any HTTP request can be sent', async () => {
  let intercept
  const client = { interceptors: { request: { use: callback => { intercept = callback } }, response: { use() {} } } }
  load('src/api/music.js', {
    axios: { create: () => client }, logger: {},
    localStorage: { getItem: key => key === 'kugou_token' ? 'new-placeholder' : '456' },
  })
  await assert.rejects(intercept({ libraryIdentity: { token: 'old-placeholder', userId: '123' }, params: {} }), { code: 'ERR_CANCELED' })
  const current = intercept({ libraryIdentity: { token: 'new-placeholder', userId: '456' }, params: {} })
  assert.equal(current.params.userid, '456')
})

test('playlist mutations use numeric operation flags and structured songs, never hash as deletion fileid', async () => {
  const f = fixture(() => ({ status: 1 }))
  await f.api.createPlaylist('Private', { isPrivate: true })
  assert.equal(f.requests[0].params.type, 0)
  assert.equal(f.requests[0].params.is_pri, 1)
  await f.api.addPlaylistSongs(9, [{ hash: 'abc', name: 'Part 1, Part 2 | Live', album_audio_id: 55 }])
  assert.equal(f.requests[1].params.songs[0].name, 'Part 1, Part 2 | Live')
  assert.equal(f.requests[1].params.data, undefined)
  assert.throws(() => f.api.removePlaylistSongs(9, ['abc']), /记录 ID 无效/)
  await f.api.removePlaylistSongs(9, [71, '72'])
  assert.equal(f.requests[2].params.fileids, '71,72')
  assert.ok(f.requests.every(request => request.method === 'post'))
})

test('mutations require an explicit business acknowledgement instead of treating any HTTP payload as success', async () => {
  const f = fixture(() => ({ data: {} }))
  await assert.rejects(f.api.deletePlaylist(9), { code: 'LIBRARY_RESULT_UNKNOWN' })
})

test('history sends seconds through time and refuses a hash-only or millisecond request', async () => {
  const f = fixture(() => ({ status: 1 }))
  await f.api.uploadPlayHistory({ MixSongID: 42 }, { time: 1700000000, pc: 2 })
  assert.equal(f.requests[0].params.mxid, '42')
  assert.equal(f.requests[0].params.time, 1700000000)
  assert.equal(f.requests[0].params.ot, undefined)
  assert.throws(() => f.api.uploadPlayHistory({ hash: 'abc' }), /歌曲 ID 无效/)
  assert.throws(() => f.api.uploadPlayHistory({ MixSongID: 42 }, { time: 1700000000000 }), /参数无效/)
})

test('comments use explicit resource identity and song-only classification/floor routes', async () => {
  const f = fixture()
  await f.api.getComments({ type: 'song', id: 42 }, { type_id: 12 })
  await f.api.getComments({ type: 'playlist', id: 'collection_9' }, { page: 2 })
  await f.api.getCommentReplies({ type: 'song', id: 42 }, { tid: 81, special_child_id: 82 })
  assert.deepEqual(f.requests.map(request => request.route), ['/comment/music/classify', '/comment/playlist', '/comment/floor'])
  assert.throws(() => f.api.getCommentReplies({ type: 'album', id: 10 }, { tid: 81 }), /暂不受支持/)
})

test('cloud URLs preserve the original file identity and reject foreign owners or non-HTTP URLs', async () => {
  const f = fixture(() => ({ status: 1, data: { url: ['https://example.test/audio.mp3'], bitrate: 128 } }))
  const song = { source: 'cloud', sourceUserId: '123', hash: 'ABC', originalName: 'Private original.mp3', audio_id: 45 }
  const result = await f.api.getCloudSongUrl(song)
  assert.equal(result.status, 1)
  assert.equal(result.url[0], 'https://example.test/audio.mp3')
  assert.equal(f.requests[0].params.name, song.originalName)
  assert.equal(f.requests[0].params.audio_id, 45)
  assert.equal(f.requests[0].params.quality, undefined)
  await assert.rejects(f.api.getCloudSongUrl({ ...song, sourceUserId: '456' }), /不属于当前账号/)
  const unsafe = fixture(() => ({ status: 1, url: 'file:///private' }))
  await assert.rejects(unsafe.api.getCloudSongUrl(song), /无法取得播放地址/)
})

test('backend structured add preserves delimiters and rejects invalid entries before the upstream boundary', async () => {
  const requests = []
  const boundary = config => { requests.push(config); return Promise.resolve({ status: 200, body: { status: 1 } }) }
  await addTracks({ listid: 9, songs: [{ name: 'Part 1, Part 2 | Live', hash: 'abc', album_id: 2, album_audio_id: 3 }] }, boundary)
  assert.equal(requests[0].data.data.length, 1)
  assert.equal(requests[0].data.data[0].name, 'Part 1, Part 2 | Live')
  assert.equal(requests[0].data.data[0].mixsongid, 3)
  for (const songs of [[], [{ name: 'x', hash: 'bad hash' }], [{ name: '', hash: 'abc' }], [{ name: 'x', hash: 'abc', album_id: {} }]]) {
    const response = await addTracks({ listid: 9, songs }, boundary)
    assert.equal(response.status, 400)
  }
  assert.equal(requests.length, 1)
  await addTracks({ listid: 9, data: 'Legacy|abc|2|3' }, boundary)
  assert.equal(requests[1].data.data[0].name, 'Legacy')
})
