const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const source = fs.readFileSync(path.join(__dirname, '../src/utils/songMetadata.js'), 'utf8')
const metadata = vm.createContext({})
vm.runInContext(source.replace(/^export /gm, ''), metadata)
const { getSongBadges, filterSongs } = metadata

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
