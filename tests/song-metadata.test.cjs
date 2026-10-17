const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const source = fs.readFileSync(path.join(__dirname, '../src/utils/songMetadata.js'), 'utf8')
const metadata = vm.createContext({})
vm.runInContext(source.replace(/^export /gm, ''), metadata)
const { getSongBadges, filterSongs, getSongSearchKeyword, getSongArtists } = metadata

const artistsFor = song => JSON.parse(JSON.stringify(getSongArtists(song)))

test('artist links keep every structured identity and search all usable arrays without mutating the song', () => {
  const song = {
    SingerId: 999, SingerName: 'One、Two、Three', singerinfo: [],
    singers: [{ singer_name: 'One', singer_id: 11 }, {}, null],
    authors: [{ author_name: 'Two', author_id: '22' }, { AuthorName: 'Three', AuthorId: 33 }]
  }
  const snapshot = JSON.stringify(song)
  assert.deepEqual(artistsFor(song), [{ id: 11, name: 'One' }, { id: '22', name: 'Two' }, { id: 33, name: 'Three' }])
  assert.equal(JSON.stringify(song), snapshot)
  assert.deepEqual(artistsFor({ singerinfo: [{ name: '' }], authors: [{ name: 'Valid', id: 7 }] }), [{ id: 7, name: 'Valid' }])
})

test('structured artist names remain intact and duplicate aliases merge without losing distinct IDs', () => {
  const song = {
    singerinfo: ['AC/DC', { name: 'Simon & Garfunkel', id: 2 }, { singer_name: 'Earth, Wind and Fire', id: 3 },
      { name: 'One、Two', id: 4 }, { name: 'Shared name', id: 5 }, { name: 'Shared name', id: 6 }],
    authors: [{ author_name: 'AC/DC', author_id: 1 }, { name: 'Another alias', id: '2' }, { name: 'Shared name' }]
  }
  assert.deepEqual(artistsFor(song), [
    { id: 1, name: 'AC/DC' }, { id: 2, name: 'Simon & Garfunkel' }, { id: 3, name: 'Earth, Wind and Fire' },
    { id: 4, name: 'One、Two' }, { id: 5, name: 'Shared name' }, { id: 6, name: 'Shared name' }
  ])
})

test('legacy combined names split only clear separators and never reuse one song-level artist ID', () => {
  for (const name of [' One、Two ', 'One / Two', 'One ／ Two']) {
    assert.deepEqual(artistsFor({ SingerName: name, SingerId: 123 }), [{ id: null, name: 'One' }, { id: null, name: 'Two' }])
  }
  for (const name of ['AC/DC', 'Simon & Garfunkel', 'Earth, Wind and Fire', 'A and B', 'A／B']) {
    assert.deepEqual(artistsFor({ singername: name, singerid: '7' }), [{ id: '7', name }])
  }
  assert.deepEqual(artistsFor({ name: 'One、Two - Song.mp3', id: 999 }), [{ id: null, name: 'One' }, { id: null, name: 'Two' }])
})

test('artist identity supports historical fields and rejects empty names, invalid IDs and song IDs', () => {
  for (const [nameField, idField] of [['SingerName', 'SingerId'], ['singername', 'singerid'], ['singer_name', 'singer_id'],
    ['AuthorName', 'AuthorId'], ['author_name', 'author_id']]) {
    assert.deepEqual(artistsFor({ [nameField]: ' Artist ', [idField]: 42 }), [{ id: 42, name: 'Artist' }])
    assert.deepEqual(artistsFor({ singerinfo: [{ [nameField]: 'Artist', [idField]: 42 }] }), [{ id: 42, name: 'Artist' }])
  }
  assert.deepEqual(artistsFor({ singerinfo: [{ name: 'Artist', id: 0, author_id: 42 }] }), [{ id: 42, name: 'Artist' }])
  assert.deepEqual(artistsFor({ singerinfo: [{ name: 'Artist' }], SingerName: 'Artist', SingerId: 42 }), [{ id: 42, name: 'Artist' }])
  assert.deepEqual(artistsFor({ singerinfo: [{ name: 'One', id: 42 }, { name: 'Two' }], SingerName: 'Two', SingerId: 42 }),
    [{ id: 42, name: 'One' }, { id: null, name: 'Two' }])
  assert.deepEqual(artistsFor({ singername: 'Artist', id: 999 }), [{ id: null, name: 'Artist' }])
  for (const id of [0, '0', -1, '-1', '', '  ', null, {}, true, NaN]) {
    assert.deepEqual(artistsFor({ singername: 'Artist', singerid: id }), [{ id: null, name: 'Artist' }])
  }
  for (const song of [null, undefined, '', [], {}, { singerinfo: [{ id: 5 }] }, { SingerName: {} },
    { singername: '未知歌手' }, { singerinfo: [{ name: '未知歌手' }] }, { author_name: '-' },
    { name: 'A song without an artist prefix' }]) {
    assert.deepEqual(artistsFor(song), [])
  }
})

test('VIP badge accepts existing song privilege codes and numeric strings without changing the song', () => {
  for (const fields of [{ privilege: 8 }, { privilege: '10' }, { Privilege: '8' }, { base: { privilege: 10 } }, { trans_param: { privilege: '8' } }]) {
    const song = { hash: 'example', ...fields }
    const original = JSON.stringify(song)
    assert.equal(getSongBadges(song).map(badge => badge.label).join(','), 'VIP')
    assert.equal(JSON.stringify(song), original)
  }
  for (const fields of [{ vip: 1 }, { is_vip: '1' }, { isVip: true }, { IsVip: 1 }]) {
    assert.equal(getSongBadges(fields)[0].key, 'vip')
  }
})

test('unknown or missing rights, quality and account VIP never imply a VIP song or playback access', () => {
  for (const song of [null, {}, { privilege: 0 }, { privilege: 1 }, { privilege: 6 }, { privilege: 999 }, { privilege: true },
    { privilege: {} }, { vip: 0 }, { vip: '0' }, { vip: 'false' }, { vip: 'unknown' }, { vip_type: 6 },
    { relate_goods: [{ level: 5 }], FileSize: 80000000 }, { pay_type: 2 }, { copyright: 0 }]) {
    assert.equal(getSongBadges(song).length, 0)
  }
  assert.equal(getSongBadges({ privilege: 8, relate_goods: [{ level: 8 }] }).length, 1)
})

test('song search covers historical metadata aliases and does not search object coercion or IDs', () => {
  const first = { hash: 'secret-id', FileName: 'Singer - TRACK', SingerName: 'Another Artist', AlbumName: 'OLD ALBUM' }
  const second = { hash: 'second', authors: [{ author_name: 'Guest Artist' }], album_info: { album_name: 'New Album' } }
  const songs = [first, second, { name: 'Third', singerinfo: ['Duet One', 'Duet Two'] }]
  for (const keyword of ['track', 'another artist', 'old album']) assert.equal(filterSongs(songs, keyword)[0], first)
  for (const keyword of ['guest artist', 'new album']) assert.equal(filterSongs(songs, keyword)[0], second)
  assert.equal(filterSongs(songs, 'duet two')[0], songs[2])
  assert.equal(filterSongs(songs, 'secret-id').length, 0)
  assert.equal(filterSongs(songs, '[object Object]').length, 0)
  assert.equal(filterSongs(songs, ''), songs)
})

test('song-title search prefers real title aliases and preserves version suffixes', () => {
  const cases = [
    [{ OriSongName: '晴天 (Live)', FileName: '周杰伦 - other.mp3' }, '晴天 (Live)'],
    [{ songname: 'Song - Part Two', singername: 'Another Singer' }, 'Song - Part Two'],
    [{ songname: 'A - Part Two', singername: 'Another Singer' }, 'A - Part Two'],
    [{ name: 'Hello - Live', singername: 'Adele' }, 'Hello - Live'],
    [{ name: 'Love - Part Two', singerinfo: [{ name: 'Artist' }] }, 'Love - Part Two'],
    [{ filename: 'Hello - Live.flac', singername: 'Adele' }, 'Hello - Live'],
    [{ songname: '周杰伦、费玉清 - 千里之外 (Live)', singerinfo: [{ name: '周杰伦' }, { name: '费玉清' }] }, '千里之外 (Live)'],
    [{ title: 'One & Two - Duet', singername: 'One、Two' }, 'Duet'],
    [{ song_name: ' 歌名 ', name: 'other' }, '歌名'],
    [{ audio_name: '歌手 — 歌名 (重制版)', author_name: '歌手' }, '歌名 (重制版)'],
    [{ title: 'Singer – Song', singerinfo: [{ name: 'Singer' }] }, 'Song'],
    [{ name: '歌手 - 歌名 - Live.flac' }, '歌名 - Live'],
    [{ filename: 'Singer - Track.opus' }, 'Track'],
    [{ FileName: 'Singer - Track.MP3' }, 'Track'],
    [{ songname: ' ', filename: ' Track.mp3 ' }, 'Track'],
    [{ title: 'An actual .mp3' }, 'An actual .mp3']
  ]
  for (const [song, expected] of cases) {
    const original = JSON.stringify(song)
    assert.equal(getSongSearchKeyword(song), expected, original)
    assert.equal(JSON.stringify(song), original)
  }
})

test('song-title search rejects missing or non-text titles without searching IDs or artists', () => {
  for (const song of [null, undefined, '', {}, { hash: 'hash', singername: 'Artist' }, { name: {} },
    { songname: 1 }, { title: '   ' }, { filename: '.mp3' }, { name: 'Singer - ' }]) {
    assert.equal(getSongSearchKeyword(song), '', JSON.stringify(song))
  }
})
