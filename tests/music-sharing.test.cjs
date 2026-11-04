const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const scope = vm.createContext({ URL })
for (const file of ['songMetadata.js', 'musicSharing.js']) {
  const source = fs.readFileSync(path.join(__dirname, '../src/utils', file), 'utf8').replace(/^import[^\n]*\n/gm, '').replace(/^export /gm, '')
  vm.runInContext(source, scope)
}
const share = scope.buildSongShareText
const song = { hash: 'example', name: '歌曲 (Live)', singerinfo: [{ id: 1, name: '歌手甲' }, { id: 2, name: '歌手乙' }], albuminfo: { name: '专辑' } }

test('sharing includes every artist and album with only an explicitly supplied official public link', () => {
  const result = share({ ...song, share_url: 'https://www.kugou.com/song/example.html' })
  assert.equal(result.text, '歌曲 (Live) — 歌手甲、歌手乙\n专辑：专辑\nhttps://www.kugou.com/song/example.html')
  assert.equal(result.hasLink, true)
})
test('sharing never infers a link from a playable URL or a hash', () => {
  const result = share({ ...song, url: 'https://audio.kugou.com/private.mp3?token=secret' })
  assert.equal(result.hasLink, false)
  assert.doesNotMatch(result.text, /https|secret|example/)
})
test('sharing rejects media, credentials, nonofficial hosts and nonweb schemes', () => {
  for (const share_url of ['https://audio.kugou.com/audio.flac', 'https://www.kugou.com/share?token=secret',
    'https://www.kugou.com/share?AUTH=secret', 'https://www.kugou.com/share?sign=secret',
    'https://www.kugou.com/share#token=secret', 'https://user:secret@www.kugou.com/share',
    'https://kugou.com.attacker.example/share', 'file:///C:/private.mp3', 'javascript:alert(1)']) {
    const result = share({ ...song, share_url })
    assert.equal(result.hasLink, false, share_url)
    assert.doesNotMatch(result.text, /secret|https|javascript|file:/)
  }
})
test('cloud files share their text without any URL even when public-looking fields exist', () => {
  const result = share({ ...song, source: 'cloud', share_url: 'https://www.kugou.com/share/example' })
  assert.equal(result.hasLink, false)
  assert.match(result.text, /歌曲/)
})
