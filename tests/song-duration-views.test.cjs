const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { parse } = require('@vue/compiler-sfc')

const root = path.resolve(__dirname, '..')
const metadata = vm.createContext({})
vm.runInContext(fs.readFileSync(path.join(root, 'src/utils/songMetadata.js'), 'utf8').replace(/^export /gm, ''), metadata)

for (const file of ['src/views/logic/ArtistView.js', 'src/views/AlbumDetailView.vue']) {
  test(`${file}: mixed duration fields are normalized once before list display and playback`, () => {
    const raw = fs.readFileSync(path.join(root, file), 'utf8')
    const script = file.endsWith('.vue') ? parse(raw).descriptor.script.content : raw
    const sandbox = { module: { exports: {} }, logger: { trace() {} }, ArtworkCover: {}, ArtistLinks: {}, SongBadges: {}, SongTitle: {}, LibraryActions: {},
      getSongArtists: metadata.getSongArtists, getSongDurationMs: metadata.getSongDurationMs }
    vm.runInNewContext(script.replace(/^import[^\n]*\n/gm, '').replace('export default', 'module.exports ='), sandbox)
    const methods = sandbox.module.exports.methods
    for (const source of [{ hash: 'track', timelen: 180125, Duration: 180 }, { hash: 'track', timelen: 0, duration: 180 },
      { hash: 'track', timelen: 'invalid', audio_info: { duration_128: 180125 } }]) {
      const [song] = methods.normalizeAudioList.call({}, [source])
      assert.equal(Math.floor(song.timelen / 1000), 180)
      assert.equal(methods.formatDuration(song.timelen), '3:00')
    }
  })
}
