const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const test = require('node:test')
const vue = require('vue')
const { parse, compileTemplate } = require('@vue/compiler-sfc')

const pages = ['HomeView', 'PersonalFMView', 'FavoriteView', 'SearchView', 'ArtistView',
  'AlbumDetailView', 'RankDetailView', 'DailyRecommendView', 'PlaylistDrawer']
const song = {
  hash: 'example-hash', FileHash: 'example-hash', name: '示例歌手 - 示例歌曲 (Live)',
  songname: '示例歌曲 (Live)', filename: '示例歌手 - 示例歌曲 (Live)',
  SongName: '示例歌曲 (Live)', singername: '示例歌手', timelen: 180000, duration: 180
}
const logger = { trace() {}, info() {}, warn() {}, error() {} }
const leaf = { render: () => vue.h('span') }
const transitionGroup = { render() { return vue.h('div', this.$slots.default?.()) } }

/** Compile the real template, retain production event methods, and isolate unrelated loaders. */
function mountPage(t, name, overrides = {}) {
  const filename = path.join(__dirname, '..', 'src', name === 'PlaylistDrawer' ? 'components/player' : 'views', `${name}.vue`)
  const { descriptor, errors } = parse(fs.readFileSync(filename, 'utf8'), { filename })
  assert.deepEqual(errors, [])
  const script = descriptor.script.src
    ? fs.readFileSync(path.resolve(path.dirname(filename), descriptor.script.src), 'utf8')
    : descriptor.script.content
  const timers = []
  const sandbox = vm.createContext({
    logger, ArtworkCover: leaf, SongBadges: leaf, ContextMenu: leaf, nextplayIcon: '',
    TransitionGroup: transitionGroup,
    localStorage: { getItem: () => null },
    filterSongs: songs => songs,
    contextMenuManager: { registerMenu() {}, unregisterMenu() {}, closeActiveMenu() {} },
    setTimeout(callback) { timers.push(callback); return timers.length }, clearTimeout() {},
    module: { exports: {} }
  })
  vm.runInContext(script.replace(/^import\b[\s\S]*?from\s+['"][^'"]+['"]\s*;?\s*$/gm, '')
    .replace('export default', 'module.exports ='), sandbox, { filename })
  const source = sandbox.module.exports
  assert.ok(source.emits.includes('search'), `${name} declares its search event`)
  const template = compileTemplate({
    source: descriptor.template.content, filename, id: name,
    compilerOptions: { mode: 'function', hoistStatic: false }
  })
  assert.deepEqual(template.errors, [])
  const render = new Function('Vue', template.code)({ ...vue, TransitionGroup: transitionGroup, vModelText: {} })
  const node = (type, text = '') => ({ type, text, props: {}, children: [], parent: null })
  const renderer = vue.createRenderer({
    createElement: node, createText: text => node('text', text), createComment: text => node('comment', text),
    setText: (item, text) => { item.text = text },
    setElementText: (item, text) => { item.text = text; item.children = [] },
    patchProp: (item, key, _old, value) => { item.props[key] = value },
    insert(item, parent, anchor) {
      if (item.parent) item.parent.children.splice(item.parent.children.indexOf(item), 1)
      item.parent = parent
      const index = anchor ? parent.children.indexOf(anchor) : -1
      parent.children.splice(index < 0 ? parent.children.length : index, 0, item)
    },
    remove(item) {
      if (item.parent) item.parent.children.splice(item.parent.children.indexOf(item), 1)
      item.parent = null
    },
    parentNode: item => item.parent,
    nextSibling: item => item.parent?.children[item.parent.children.indexOf(item) + 1] || null
  })
  const emitted = []
  const app = renderer.createApp({
    name: source.name, components: source.components, methods: source.methods, computed: source.computed,
    emits: source.emits,
    data() {
      return {
        ...source.data.call({}), currentSong: null, playlistId: null, playlistName: '',
        albumName: '', searchKeyword: '示例歌曲', rankData: {}, rankInfo: {}, album: {},
        songs: [song], hotSongs: [song], favoriteList: [song], aiRecommendList: [song],
        searchResults: { lists: [song] }, artist: { author_name: '示例歌手' },
        playlist: [song], visible: true, isPlaying: false, settings: { playback: {} }, ...overrides
      }
    },
    render
  }, Object.fromEntries(source.emits.map(event => [
    `on${event[0].toUpperCase()}${event.slice(1).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())}`,
    (...args) => emitted.push([event, ...args])
  ])))
  const root = node('root')
  const instance = app.mount(root)
  t.after(() => app.unmount())
  return { root, emitted, instance, timers }
}

function find(root, predicate) {
  if (predicate(root)) return root
  for (const child of root.children) {
    const result = find(child, predicate)
    if (result) return result
  }
  return null
}

const hasClass = (node, value) => String(node.props.class || '').split(' ').includes(value)

/** Model DOM bubbling so the compiled .stop handlers must prevent the row's playback handler. */
function dispatch(target, eventName, detail = 1) {
  let stopped = false
  const event = { detail, target, stopPropagation() { stopped = true }, preventDefault() {} }
  for (let current = target; current && !stopped; current = current.parent) {
    event.currentTarget = current
    const handlers = current.props[eventName]
    for (const handler of [].concat(handlers || [])) handler(event)
  }
  return stopped
}

for (const name of pages) {
  test(`${name}: song title searches the original song and isolates row playback`, t => {
    const { root, emitted, timers } = mountPage(t, name)
    const title = find(root, item => hasClass(item, name === 'PersonalFMView' ? 'fm-song-title' : 'song-name'))
    assert.ok(title, 'the loaded song has a title entry')
    assert.equal(title.type, 'button', 'native button retains keyboard activation')
    assert.equal(title.props.type, 'button')
    assert.equal(dispatch(title, 'onClick', 0), true, 'keyboard-generated click is isolated')
    assert.equal(dispatch(title, 'onDblclick', 2), true, 'double click cannot reach the playback row')
    for (const callback of timers) callback()
    assert.deepEqual(emitted.map(([event]) => event), ['search'])
    assert.equal(vue.toRaw(emitted[0][1]), song, 'normalization belongs to App')
    assert.equal(find(title, item => item !== title && item.type === 'button'), null, 'buttons are never nested')
    for (let parent = title.parent; parent; parent = parent.parent) assert.notEqual(parent.type, 'button')
  })
}

test('ArtistView: the complete songs tab has the same isolated search action', t => {
  const { root, emitted } = mountPage(t, 'ArtistView', { activeTab: 'songs' })
  dispatch(find(root, item => hasClass(item, 'song-name')), 'onClick')
  assert.deepEqual(emitted.map(([event]) => event), ['search'])
  assert.equal(vue.toRaw(emitted[0][1]), song)
})

for (const name of pages) {
  test(`${name}: separate play control remains available after title becomes search`, t => {
    const { root, emitted, timers } = mountPage(t, name)
    const control = find(root, item => ['song-play', 'fm-play', 'play-btn-inline', 'index-play', 'play-indicator']
      .some(value => hasClass(item, value)))
    assert.ok(control, 'a song retains an independent play control')
    assert.equal(control.type, 'button')
    if (name === 'AlbumDetailView' || name === 'PlaylistDrawer') assert.ok(control.props['aria-label'].startsWith('播放 '))
    dispatch(control, 'onClick', 0)
    for (const callback of timers) callback()
    assert.deepEqual(emitted.map(([event]) => event), ['play'])
  })
}

for (const name of pages.filter(name => !['HomeView', 'PersonalFMView'].includes(name))) {
  test(`${name}: double clicking the remaining row still plays`, t => {
    const { root, emitted, timers } = mountPage(t, name)
    const row = find(root, item => hasClass(item, name === 'PlaylistDrawer' ? 'playlist-item' : 'song-item'))
    dispatch(row, 'onDblclick', 2)
    for (const callback of timers) callback()
    assert.deepEqual(emitted.map(([event]) => event), ['play'])
  })
}

test('FavoriteView: its existing context-menu search emits the same original song', t => {
  const { emitted, instance } = mountPage(t, 'FavoriteView')
  instance.currentContextSong = song
  instance.contextMenuItems.find(item => item.label === '搜索').action()
  assert.deepEqual(emitted.map(([event]) => event), ['search'])
  assert.equal(vue.toRaw(emitted[0][1]), song)
})
