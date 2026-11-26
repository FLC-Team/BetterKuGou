const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const test = require('node:test')
const vue = require('vue')
const { parse, compileTemplate, compileScript } = require('@vue/compiler-sfc')
const { registerAppNotice } = require('./helpers/noticeHarness.cjs')
const { loadSongTitle } = require('./helpers/songTitleHarness.cjs')

const pages = ['HomeView', 'PersonalFMView', 'FavoriteView', 'SearchView', 'ArtistView',
  'AlbumDetailView', 'RankDetailView', 'DailyRecommendView', 'PlaylistDrawer', 'LibrarySongs']
const song = {
  hash: 'example-hash', FileHash: 'example-hash', name: '示例歌手 - 示例歌曲 (Live)',
  songname: '示例歌曲 (Live)', filename: '示例歌手 - 示例歌曲 (Live)',
  SongName: '示例歌曲 (Live)', singername: '示例歌手、合作歌手', timelen: 180000, duration: 180,
  singerinfo: [{ id: 101, name: '示例歌手' }, { id: 202, name: '合作歌手' }]
}
const logger = { trace() {}, info() {}, warn() {}, error() {} }
const leaf = { render: () => vue.h('span') }
const transitionGroup = { render() { return vue.h('div', this.$slots.default?.()) } }
// Layout is isolated here; windowing and keyboard boundaries are tested with the real component separately.
const windowedList = { props: ['items'], render() {
  return vue.h('div', [this.$slots.header?.(), ...(this.items || []).flatMap((item, index) => this.$slots.default?.({ item, index }) || [])])
} }
const metadata = vm.createContext({})
vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/utils/songMetadata.js'), 'utf8').replace(/^export /gm, ''), metadata)

const librarySource = fs.readFileSync(path.join(__dirname, '../src/utils/libraryMetadata.js'), 'utf8').replace(/^import[^\n]*\n/gm, '')
const libraryExports = [...librarySource.matchAll(/^export (?:function|const) (\w+)/gm)].map(match => match[1])
Object.assign(metadata, vm.runInContext(`(() => { ${librarySource.replace(/^export /gm, '')}\nreturn { ${libraryExports.join(',')} } })()`, metadata))

/** Use the actual child component so navigation tests exercise the buttons users click. */
function loadArtistLinks() {
  const filename = path.join(__dirname, '../src/components/common/ArtistLinks.vue')
  const { descriptor } = parse(fs.readFileSync(filename, 'utf8'), { filename })
  const sandbox = vm.createContext({ listMotion: {}, setListMotionActive() {}, contentSize: {}, freezeGridLeave() {}, clearGridLeave() {}, setContentSizeActive() {},  module: { exports: {} }, getSongArtists: metadata.getSongArtists })
  vm.runInContext(descriptor.script.content.replace(/^import[^\n]*\n/gm, '').replace('export default', 'module.exports ='), sandbox)
  const template = compileTemplate({ source: descriptor.template.content, filename, id: 'ArtistLinks',
    compilerOptions: { mode: 'function', hoistStatic: false } })
  assert.deepEqual(template.errors, [])
  return { ...sandbox.module.exports, render: new Function('Vue', template.code)(vue) }
}

/** Compile the real template, retain production event methods, and isolate unrelated loaders. */
function mountPage(t, name, overrides = {}, components = {}) {
  const filename = path.join(__dirname, '..', 'src', name === 'PlaylistDrawer' ? 'components/player' : name === 'LibrarySongs' ? 'components/common' : 'views', `${name}.vue`)
  const { descriptor, errors } = parse(fs.readFileSync(filename, 'utf8'), { filename })
  assert.deepEqual(errors, [])
  const script = descriptor.script.src
    ? fs.readFileSync(path.resolve(path.dirname(filename), descriptor.script.src), 'utf8')
    : descriptor.script.content
  const timers = []
  const sandbox = vm.createContext({ listMotion: {}, setListMotionActive() {}, contentSize: {}, freezeGridLeave() {}, clearGridLeave() {}, setContentSizeActive() {},
    logger, librarySongKey: metadata.librarySongKey, findQueueSongIndex: metadata.findQueueSongIndex, ArtworkCover: leaf, SongBadges: leaf,
    SongTitle: loadSongTitle({ setTimeout(callback) { timers.push(callback); return timers.length }, clearTimeout() {} }),
    ContextMenu: leaf, ArtistLinks: loadArtistLinks(), LibraryActions: leaf, PlaylistOverview: leaf, WindowedList: windowedList,
    getSongArtists: metadata.getSongArtists, getSongSearchKeyword: metadata.getSongSearchKeyword, nextplayIcon: '',
    getSongDurationMs: metadata.getSongDurationMs, formatSongDuration: metadata.formatSongDuration,
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
  const render = new Function('Vue', template.code)({ ...vue, Transition: { setup(_props, { slots }) { return () => slots.default?.()[0] } }, TransitionGroup: transitionGroup, vModelText: {} })
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
  const Page = {
    name: source.name, components: { ...source.components, ...components }, directives: source.directives, methods: source.methods, computed: source.computed,
    emits: source.emits,
    data() {
      return {
        ...source.data.call({}), currentSong: null, playlistId: null, playlistName: '',
        albumName: '', searchKeyword: '示例歌曲', rankData: {}, rankInfo: {}, album: {}, musicLibrary: null,
        songs: [song], hotSongs: [song], favoriteList: [song], aiRecommendList: [song],
        label: '歌曲列表', showToolbar: false, library: null,
        searchResults: { lists: [song] }, artist: { author_name: '示例歌手' },
        playlist: [song], currentIndex: -1, upcoming: [], singleRepeat: false, visible: true, isPlaying: false, settings: { playback: {} }, ...overrides
      }
    },
    render
  }
  const listeners = Object.fromEntries(source.emits.map(event => [
    `on${event[0].toUpperCase()}${event.slice(1).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())}`,
    (...args) => emitted.push([event, ...args])
  ]))
  const root = node('root')
  const instanceRef = vue.ref(null)
  const active = vue.ref(true)
  const app = renderer.createApp({ render: () => vue.h(vue.KeepAlive, null, {
    default: () => active.value ? vue.h(Page, { ...listeners, ref: instanceRef }) : vue.h('div')
  }) })
  const notices = registerAppNotice(app)
  app.mount(root)
  const instance = instanceRef.value
  let mounted = true
  const unmount = () => { if (mounted) { mounted = false; app.unmount() } }
  t.after(unmount)
  return { root, emitted, instance, timers, notices, active, unmount }
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
const nodeText = node => node.text + node.children.map(nodeText).join('')

test('the drawer highlights only the confirmed occurrence of a duplicate song', async t => {
  const first = { hash: 'A', name: 'First appearance' }
  const last = { hash: 'A', name: 'Last appearance' }
  const { root, instance } = mountPage(t, 'PlaylistDrawer', {
    playlist: [null, first, { hash: 'B', name: 'Between' }, last], currentSong: last, currentIndex: 3
  })
  const rows = find(root, node => hasClass(node, 'playlist-list')).children.filter(node => hasClass(node, 'playlist-item'))
  const currentRows = () => rows.flatMap((node, index) => node.props['aria-current'] === 'true' ? [index] : [])
  assert.deepEqual(currentRows(), [2])
  instance.currentSong = { ...last }
  await vue.nextTick()
  assert.deepEqual(currentRows(), [2], 'restored copy uses the confirmed index')
  instance.currentSong = first
  await vue.nextTick()
  assert.deepEqual(currentRows(), [0], 'exact row wins over an old index')
})

test('the drawer lists priority entries in insertion order and cancels the selected source', async t => {
  const c = { hash: 'C', name: 'Third' }
  const d = { hash: 'D', name: 'Fourth' }
  const { root, instance, emitted } = mountPage(t, 'PlaylistDrawer', { upcoming: [c, d], singleRepeat: true })
  const section = find(root, item => hasClass(item, 'upcoming'))
  assert.match(nodeText(section), /接下来播放.*手动切歌优先.*下一首Third.*2Fourth/)
  dispatch(find(section, item => item.props['aria-label'] === '取消插播 Third'), 'onClick')
  assert.equal(emitted[0][0], 'cancel-next')
  assert.equal(vue.toRaw(emitted[0][1]), c)
  instance.upcoming = [d]
  instance.singleRepeat = false
  await vue.nextTick()
  assert.match(nodeText(section), /下一首Fourth/)
  assert.doesNotMatch(nodeText(section), /Third|手动切歌/)
  instance.upcoming = []
  await vue.nextTick()
  assert.equal(find(root, item => hasClass(item, 'upcoming')), null)
})

/** Render the real more button and its menu items, isolating the menu's viewport positioning. */
function loadLibraryActions() {
  const filename = path.join(__dirname, '../src/components/common/LibraryActions.vue')
  const { descriptor } = parse(fs.readFileSync(filename, 'utf8'), { filename })
  const code = compileScript(descriptor, { id: 'library-actions', inlineTemplate: true,
    templateOptions: { compilerOptions: { hoistStatic: false } } }).content
    .replace(/^import\s*\{([^}]+)\}\s*from\s*['"]vue['"]\s*;?\s*$/gm, (_, names) => 'const { ' + names.replace(/\bas\b/g, ':') + ' } = Vue')
    .replace(/^import\b[^\n]*$/gm, '').replace('export default', 'return')
  const menu = { props: ['visible', 'items'], render() {
    return this.visible ? vue.h('div', this.items.map(item => vue.h('button', { onClick: item.action }, item.label))) : null
  } }
  return new Function('Vue', 'ContextMenu', 'contextMenuManager', code)(vue, menu,
    { closeActiveMenu() {}, registerMenu() {}, unregisterMenu() {} })
}

for (const name of ['SearchView', 'FavoriteView']) {
  test(`${name}: more menu and right-click queue the same playable track once`, async t => {
    const raw = name === 'SearchView' ? { ...song, hash: undefined, FileHash: 'result-hash' } : song
    const { root, emitted, instance } = mountPage(t, name, { searchResults: { lists: [raw] }, favoriteList: [raw] },
      { LibraryActions: loadLibraryActions() })
    const more = find(root, item => item.props['aria-label'] === '歌曲更多操作')
    more.getBoundingClientRect = () => ({ left: 4, bottom: 10 })
    dispatch(more, 'onClick')
    await vue.nextTick()
    dispatch(find(root, item => item.type === 'button' && nodeText(item) === '下一首播放'), 'onClick')
    instance.currentContextSong = raw
    instance.contextMenuItems.find(item => item.label === '下一首播放').action()
    assert.deepEqual(emitted.map(([event]) => event), ['play-next', 'play-next'])
    assert.equal(emitted[0][1].hash, raw.FileHash)
    assert.deepEqual(emitted[0][1], emitted[1][1])
  })
}

test('queue duration renders normalized milliseconds and legacy seconds without NaN', t => {
  const songs = [
    { ...song, hash: 'ms', timelen: 181900 },
    { ...song, hash: 's', timelen: undefined, duration: '182.9' },
    { ...song, hash: 'unknown', timelen: undefined, duration: undefined },
    { ...song, hash: 'bad', timelen: Infinity }
  ]
  const { root } = mountPage(t, 'PlaylistDrawer', { playlist: songs })
  const rows = []
  const collect = item => { if (hasClass(item, 'song-duration')) rows.push(nodeText(item)); item.children.forEach(collect) }
  collect(root)
  assert.deepEqual(rows, ['3:01', '3:02', '0:00', '0:00'])
})

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

for (const [name, field, retry, expectedArgs] of [
  ['FavoriteView', 'errorMessage', 'loadFavorites', [true]],
  ['SearchView', 'errorMessage', 'performSearch', ['示例歌曲', false]],
  ['ArtistView', 'errorMessage', 'loadInitial', []],
  ['AlbumDetailView', 'error', 'load', []],
  ['PersonalFMView', 'error', 'loadData', []],
  ['RankDetailView', 'error', 'loadData', []],
  ['DailyRecommendView', 'error', 'loadData', []]
]) {
  test(`${name}: loading errors use the shared notification and retain the real retry binding`, async t => {
    const { root, instance, notices } = mountPage(t, name, { searchRequestAppend: false })
    const calls = []
    instance[retry] = (...args) => { calls.push(args); instance[field] = '' }
    instance[field] = '模拟网络中断，请重试'
    await vue.nextTick()
    assert.equal(notices.entries.length, 1, 'one error is sent through AppNotice')
    assert.equal(notices.entries[0].type, 'error')
    assert.equal(notices.entries[0].duration, 0, 'retry remains available until handled')
    assert.equal(find(root, item => hasClass(item, 'refresh-error')), null, 'no page-owned alert bar remains')
    const outlet = find(root, item => item.type === 'notification-outlet')
    const retryButton = find(outlet, item => item.type === 'button' && nodeText(item) === '重试')
    assert.ok(retryButton, 'the actual notification action is rendered')
    await retryButton.props.onClick()
    await vue.nextTick()
    assert.deepEqual(calls, [expectedArgs])
    assert.equal(notices.entries.length, 0, 'successful retry clears the owned notification')
  })
}

for (const name of pages) {
  test(`${name}: song title searches the original song and isolates row playback`, t => {
    const { root, emitted, timers } = mountPage(t, name)
    const title = find(root, item => hasClass(item, name === 'PersonalFMView' ? 'fm-song-title' : 'song-name'))
    assert.ok(title, 'the loaded song has a title entry')
    assert.equal(title.type, 'button', 'native button retains keyboard activation')
    assert.equal(title.props.type, 'button')
    assert.equal(dispatch(title, 'onClick', 0), true, 'keyboard-generated click is isolated')
    for (const callback of timers) callback()
    assert.deepEqual(emitted.map(([event]) => event), ['search'])
    assert.equal(vue.toRaw(emitted[0][1]), song, 'normalization belongs to App')
    assert.equal(find(title, item => item !== title && item.type === 'button'), null, 'buttons are never nested')
    for (let parent = title.parent; parent; parent = parent.parent) assert.notEqual(parent.type, 'button')
  })
}

for (const name of pages.filter(name => !['HomeView', 'PersonalFMView'].includes(name))) {
  test(`${name}: a pointer single click searches only after the double-click interval`, t => {
    const { root, emitted, timers } = mountPage(t, name)
    const title = find(root, item => hasClass(item, 'song-name'))
    assert.equal(dispatch(title, 'onClick', 1), true)
    assert.deepEqual(emitted, [])
    for (const callback of timers) callback()
    assert.deepEqual(emitted.map(([event]) => event), ['search'])
    assert.equal(vue.toRaw(emitted[0][1]), song)
  })

  test(`${name}: the native click/click/double-click sequence plays once and cancels search`, t => {
    const { root, emitted, timers } = mountPage(t, name)
    const title = find(root, item => hasClass(item, 'song-name'))
    assert.equal(dispatch(title, 'onClick', 1), true)
    assert.equal(dispatch(title, 'onClick', 2), true)
    assert.equal(dispatch(title, 'onDblclick', 2), true)
    for (const callback of timers) callback()
    assert.deepEqual(emitted.map(([event]) => event), ['play'])
  })
}

test('ArtistView: the complete songs tab has the same isolated search action', t => {
  const { root, emitted } = mountPage(t, 'ArtistView', { activeTab: 'songs' })
  dispatch(find(root, item => hasClass(item, 'song-name')), 'onClick', 0)
  assert.deepEqual(emitted.map(([event]) => event), ['search'])
  assert.equal(vue.toRaw(emitted[0][1]), song)
})

test('song title pending search is cancelled when a reused list row changes songs', async t => {
  const { root, instance, emitted, timers } = mountPage(t, 'LibrarySongs')
  dispatch(find(root, item => hasClass(item, 'song-name')), 'onClick', 1)
  const replacement = { ...song, name: '另一首歌曲', songname: '另一首歌曲' }
  instance.songs = [replacement]
  await vue.nextTick()
  for (const callback of timers) callback()
  assert.deepEqual(emitted, [])
  dispatch(find(root, item => hasClass(item, 'song-name')), 'onClick', 1)
  for (const callback of timers) callback()
  assert.deepEqual(emitted.map(([event]) => event), ['search'])
  assert.equal(vue.toRaw(emitted[0][1]), replacement)
})

test('song title pending search is cancelled on KeepAlive deactivation and works after activation', async t => {
  const { root, emitted, timers, active } = mountPage(t, 'LibrarySongs')
  dispatch(find(root, item => hasClass(item, 'song-name')), 'onClick', 1)
  active.value = false
  await vue.nextTick()
  for (const callback of timers) callback()
  assert.deepEqual(emitted, [])
  active.value = true
  await vue.nextTick()
  dispatch(find(root, item => hasClass(item, 'song-name')), 'onClick', 1)
  for (const callback of timers) callback()
  assert.deepEqual(emitted.map(([event]) => event), ['search'])
})

test('song title pending search is cancelled on unmount and when the queue closes', async t => {
  const list = mountPage(t, 'LibrarySongs')
  dispatch(find(list.root, item => hasClass(item, 'song-name')), 'onClick', 1)
  list.unmount()
  for (const callback of list.timers) callback()
  assert.deepEqual(list.emitted, [])
  const queue = mountPage(t, 'PlaylistDrawer')
  dispatch(find(queue.root, item => hasClass(item, 'song-name')), 'onClick', 1)
  queue.instance.visible = false
  await vue.nextTick()
  for (const callback of queue.timers) callback()
  assert.deepEqual(queue.emitted, [])
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

for (const name of pages) {
  test(`${name}: every artist opens its own page without triggering the row`, t => {
    const { root, emitted, timers } = mountPage(t, name)
    for (const artist of song.singerinfo) {
      const button = find(root, item => item.props['aria-label'] === '查看歌手 ' + artist.name)
      assert.ok(button, `entry exists for ${artist.name}`)
      assert.equal(button.type, 'button')
      assert.equal(dispatch(button, 'onClick', 0), true)
      assert.equal(dispatch(button, 'onDblclick', 2), true)
      for (let parent = button.parent; parent; parent = parent.parent) assert.notEqual(parent.type, 'button')
    }
    for (const callback of timers) callback()
    const expected = song.singerinfo.map(artist => name === 'PlaylistDrawer'
      ? ['artist', artist] : ['navigate', 'artist', artist])
    assert.deepEqual(JSON.parse(JSON.stringify(emitted)), expected)
  })
}

test('ArtistView: all-song tab preserves each collaborator entry', t => {
  const { root, emitted } = mountPage(t, 'ArtistView', { activeTab: 'songs' })
  dispatch(find(root, item => item.props['aria-label'] === '查看歌手 合作歌手'), 'onClick', 0)
  assert.deepEqual(JSON.parse(JSON.stringify(emitted)), [['navigate', 'artist', song.singerinfo[1]]])
})

test('SearchView: clicking the cover twice requests playback exactly once', t => {
  const { root, emitted } = mountPage(t, 'SearchView')
  const cover = find(root, item => hasClass(item, 'cover-play'))
  assert.ok(cover.props['aria-label'].startsWith('播放 '))
  dispatch(cover, 'onClick', 1)
  dispatch(cover, 'onClick', 2)
  dispatch(cover, 'onDblclick', 2)
  assert.deepEqual(emitted.map(([event]) => event), ['play'])
})

test('AlbumDetailView: the page back button requests the previous history entry', t => {
  const { root, emitted } = mountPage(t, 'AlbumDetailView', { canGoBack: true })
  const back = find(root, item => hasClass(item, 'back-btn'))
  assert.equal(back.props.disabled, false)
  dispatch(back, 'onClick', 0)
  assert.deepEqual(emitted, [['back']])
})

test('AlbumDetailView: album header exposes individual artists', t => {
  const { root, emitted } = mountPage(t, 'AlbumDetailView', { album: { authors: song.singerinfo } })
  const header = find(root, item => hasClass(item, 'collection-hero'))
  dispatch(find(header, item => item.props['aria-label'] === '查看歌手 合作歌手'), 'onClick', 0)
  assert.deepEqual(JSON.parse(JSON.stringify(emitted)), [['navigate', 'artist', song.singerinfo[1]]])
})

for (const method of ['playSong', 'playNext']) {
  test(`SearchView: ${method} keeps each artist identity in the emitted song`, t => {
    const { instance, emitted } = mountPage(t, 'SearchView')
    instance[method](song)
    const result = emitted.find(item => item[0] === (method === 'playSong' ? 'play' : 'play-next'))
    assert.ok(result)
    assert.deepEqual(JSON.parse(JSON.stringify(metadata.getSongArtists(result[1]))), song.singerinfo)
  })
}
