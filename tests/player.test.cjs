const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const test = require('node:test')
const { createRenderer, h, reactive, nextTick } = require('vue')

const playerDirectory = path.join(__dirname, '..', 'src', 'components', 'player')
const quietLogger = Object.fromEntries(['log', 'trace', 'debug', 'info', 'warn', 'error'].map(level => [level, () => {}]))
const flush = async () => {
  for (let count = 0; count < 4; count++) await new Promise(resolve => setImmediate(resolve))
}
const song = hash => ({ hash, name: hash, album_audio_id: 1 })

function deferred() {
  let resolve
  let reject
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}

/** Evaluate the production Options API methods with browser and API boundaries mocked. */
function loadComponent(filename, overrides = {}) {
  const actions = new Map()
  const listeners = new Map()
  const events = {
    addEventListener(name, callback) {
      if (!listeners.has(name)) listeners.set(name, new Set())
      listeners.get(name).add(callback)
    },
    removeEventListener(name, callback) { listeners.get(name)?.delete(callback) }
  }
  const menuManager = {
    activeMenuCloser: null,
    registerMenu(callback) { this.activeMenuCloser = callback },
    unregisterMenu(callback) { if (this.activeMenuCloser === callback) this.activeMenuCloser = null },
    closeActiveMenu() { this.activeMenuCloser?.(); this.activeMenuCloser = null }
  }
  const sandbox = {
    console: quietLogger, logger: quietLogger,
    process: { env: { NODE_ENV: 'test' } }, performance,
    setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: () => 1, cancelAnimationFrame: () => {},
    computed: () => null,
    navigator: { mediaSession: { setActionHandler: (name, callback) => actions.set(name, callback) } },
    window: { ...events, innerWidth: 1200, innerHeight: 800 },
    document: { ...events, body: { style: { overflow: 'auto' } } },
    localStorage: { getItem: () => null, setItem: () => {} },
    getSongDetail: async () => ({ status: 1, data: [] }),
    getSongUrl: async hash => ({ status: 1, url: `https://example.test/${hash}.mp3` }),
    getLyric: async hash => ({ status: 1, decodeContent: `[00:00.00]${hash}` }),
    PlaylistDrawer: {}, ContextMenu: {}, LyricView: {}, TransitionGroup: {},
    contextMenuManager: menuManager, useSettingsStore: () => ({}),
    ...Object.fromEntries(['playlistIcon', 'repeatAllIcon', 'repeatOneIcon', 'shuffleIcon',
      'sound0Icon', 'sound1Icon', 'sound2Icon', 'sound3Icon'].map(name => [name, ''])),
    ...overrides
  }
  let source = fs.readFileSync(path.join(playerDirectory, filename), 'utf8')
  if (filename.endsWith('.vue')) source = source.split('<script>')[1].split('</script>')[0]
  source = source.replace(/^import[^\n]*\n/gm, '').replace('export default {', 'globalThis.component = {')
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename })
  return { component: sandbox.component, sandbox, actions, listeners, menuManager }
}

function createPlayer(t, overrides = {}) {
  const loaded = loadComponent('MusicPlayer.js', overrides)
  const { component } = loaded
  const emitted = []
  const audio = {
    src: '', paused: true, ended: false, currentTime: 0, duration: 180,
    muted: false, volume: 0.8, playCount: 0, pauseCount: 0,
    getAttribute(name) { return name === 'src' ? this.src || null : null },
    removeAttribute(name) { if (name === 'src') this.src = '' },
    load() {},
    pause() { this.pauseCount++; this.paused = true; player.handlePause() },
    async play() { this.playCount++; this.paused = false; this.ended = false; player.handlePlay() }
  }
  const player = {
    ...component.data(), playlist: [], isComponentReady: true,
    $refs: { audioPlayer: audio },
    $nextTick: callback => Promise.resolve().then(() => callback?.()),
    $emit(name, value) {
      emitted.push({ name, value })
      if (name === 'playlist-updated') player.playlist = value
    }
  }
  for (const [name, method] of Object.entries(component.methods)) player[name] = method.bind(player)
  for (const [name, getter] of Object.entries(component.computed)) {
    Object.defineProperty(player, name, { get: () => getter.call(player) })
  }
  player.updateMediaSession = () => {}
  player.sendLyricsToDesktop = () => {}
  t.after(() => component.beforeUnmount.call(player))
  return { ...loaded, player, audio, emitted }
}

function createFrameClock() {
  let nextId = 0
  const callbacks = new Map()
  return {
    callbacks,
    request(callback) { const id = ++nextId; callbacks.set(id, callback); return id },
    cancel(id) { callbacks.delete(id) },
    step() {
      const frame = [...callbacks.values()]
      callbacks.clear()
      frame.forEach(callback => callback(performance.now()))
    }
  }
}

/** Exercise lyric state against controllable animation frames and measurable text nodes. */
function createLyric(t) {
  const frames = createFrameClock()
  const loaded = loadComponent('LyricView.js', {
    requestAnimationFrame: callback => frames.request(callback),
    cancelAnimationFrame: id => frames.cancel(id)
  })
  const { component } = loaded
  const emitted = []
  const charactersByLine = new Map()
  const lyric = {
    ...component.data(), visible: true, isPlaying: false, pauseUpdates: false,
    duration: 120, currentPlayTime: 0, previewTime: null, playMode: 'loop', song: song('A'),
    settingsStore: { settings: { playback: { showTranslation: true } } },
    $nextTick: callback => Promise.resolve().then(() => callback?.()),
    $emit: (name, value) => emitted.push({ name, value }),
    $refs: {
      lyricsContainer: {
        querySelectorAll(selector) {
          const index = Number(selector.match(/data-line-index="(\d+)"/)?.[1])
          return charactersByLine.get(index) || []
        }
      }
    }
  }
  for (const [name, method] of Object.entries(component.methods)) lyric[name] = method.bind(lyric)
  for (const [name, getter] of Object.entries(component.computed)) {
    Object.defineProperty(lyric, name, { get: () => getter.call(lyric) })
  }
  function setLine(index, text, textWidth = 100, viewportWidth = 300) {
    const characters = [...text].map((_, charIndex) => ({
      dataset: { charIndex: String(charIndex) },
      classList: { contains: () => false }, style: {}
    }))
    const innerText = { scrollWidth: textWidth, style: {} }
    const viewport = { clientWidth: viewportWidth }
    const element = {
      // An outer line fills its container even when the text itself is short.
      scrollWidth: viewportWidth,
      style: { transform: 'translate(-50%, -50%) translateY(0px)' },
      querySelector(selector) {
        return selector === '.lyric-text' ? innerText : selector === '.main-lyric' ? viewport : null
      }
    }
    charactersByLine.set(index, characters)
    lyric.lyricLineRefs[index] = element
    return { characters, innerText, viewport, element }
  }
  t.after(() => component.beforeUnmount.call(lyric))
  return { ...loaded, lyric, emitted, frames, setLine }
}

/** Run Vue's real mount, prop watchers and parent event updates with a fake audio host. */
function mountPlayer(t, initialSongs, overrides = {}) {
  const loaded = loadComponent('MusicPlayer.js', overrides)
  const audioElements = []
  const makeNode = type => {
    const node = { type, children: [], parent: null }
    if (type === 'audio') {
      Object.assign(node, {
        src: '', paused: true, ended: false, currentTime: 0, duration: 180, volume: 1,
        getAttribute(name) { return name === 'src' ? this.src || null : null },
        removeAttribute(name) { if (name === 'src') this.src = '' },
        load() {},
        pause() { this.paused = true; this.onPause?.() },
        async play() { this.paused = false; this.ended = false; this.onPlay?.() }
      })
      audioElements.push(node)
    }
    return node
  }
  const renderer = createRenderer({
    createElement: makeNode, createText: () => makeNode('text'), createComment: () => makeNode('comment'),
    patchProp: (node, name, oldValue, value) => { node[name] = value },
    insert(node, parent) { node.parent = parent; parent.children.push(node) },
    remove(node) { if (node.parent) node.parent.children = node.parent.children.filter(child => child !== node) },
    setText() {}, setElementText() {}, parentNode: node => node.parent, nextSibling: () => null
  })
  loaded.component.render = function () {
    return h('audio', { ref: 'audioPlayer', onPlay: this.handlePlay, onPause: this.handlePause })
  }
  loaded.component.methods.updateMediaSession = () => {}
  loaded.component.methods.sendLyricsToDesktop = () => {}
  const state = reactive({ song: initialSongs[0], playlist: initialSongs })
  let player
  const app = renderer.createApp({
    render: () => h(loaded.component, {
      ref: value => { player = value }, song: state.song, playlist: state.playlist,
      onSongChanged: value => { state.song = value },
      onPlaylistUpdated: value => { state.playlist = value },
      onClearPlaylist: () => { state.playlist = []; state.song = null }
    })
  })
  app.mount(makeNode('root'))
  t.after(() => app.unmount())
  return { ...loaded, app, state, getPlayer: () => player, audioElements }
}

test('initial selection waits for mount and retains only the latest song without polling', async t => {
  const { component, player, audio } = createPlayer(t)
  player.isComponentReady = false
  player.playlist = [song('A'), song('B')]
  component.watch.song.handler.call(player, player.playlist[0])
  component.watch.song.handler.call(player, player.playlist[1])
  assert.equal(player.pendingSong.hash, 'B')
  assert.equal(player.pendingTimers.size, 0)
  assert.equal(audio.playCount, 0)
  player.isComponentReady = true
  await player.drainPendingSong()
  assert.equal(player.currentSong.hash, 'B')
})

test('selection during loading invalidates A and eventually plays B', async t => {
  const first = deferred()
  const { component, player, audio, emitted } = createPlayer(t, {
    getSongUrl: hash => hash === 'A' ? first.promise : Promise.resolve({ status: 1, url: 'https://example.test/B.mp3' })
  })
  player.playlist = [song('A'), song('B')]
  const pending = player.requestSong(player.playlist[0])
  component.watch.song.handler.call(player, player.playlist[1])
  first.resolve({ status: 1, url: 'https://example.test/A.mp3' })
  await pending
  await flush()
  assert.equal(player.currentSong.hash, 'B')
  assert.equal(audio.playCount, 1)
  assert.deepEqual(emitted.filter(event => event.name === 'song-changed').map(event => event.value.hash), ['B'])
})

test('Vue mount and real prop watchers keep the last parent selection during an outstanding load', async t => {
  const first = deferred()
  const { state, getPlayer } = mountPlayer(t, [song('A'), song('B')], {
    getSongUrl: hash => hash === 'A' ? first.promise : Promise.resolve({ status: 1, url: 'https://example.test/B.mp3' })
  })
  await nextTick()
  state.song = state.playlist[1]
  await nextTick()
  first.resolve({ status: 1, url: 'https://example.test/A.mp3' })
  await flush()
  assert.equal(getPlayer().currentSong.hash, 'B')
  assert.equal(state.song.hash, 'B')
  assert.equal(getPlayer().currentIndex, 1)
})

test('Vue event flow removes the current tail song and updates parent queue before loading the fallback', async t => {
  const { state, getPlayer } = mountPlayer(t, ['A', 'B', 'C'].map(song))
  await flush()
  state.song = state.playlist[2]
  await flush()
  await getPlayer().handleRemoveSong(2)
  await flush()
  assert.equal(state.playlist.length, 2)
  assert.equal(state.song.hash, 'A')
  assert.equal(getPlayer().currentIndex, 0)
})

test('returning to the current song cancels a different song still loading', async t => {
  const loading = deferred()
  const { component, player, audio } = createPlayer(t, { getSongUrl: () => loading.promise })
  player.playlist = [song('A'), song('B')]
  player.currentSong = player.playlist[0]
  player.loadedSongHash = 'A'
  audio.src = 'https://example.test/A.mp3'
  const pending = player.requestSong(player.playlist[1])
  component.watch.song.handler.call(player, player.playlist[0])
  loading.resolve({ status: 1, url: 'https://example.test/B.mp3' })
  await pending
  await flush()
  assert.equal(player.currentSong.hash, 'A')
  assert.equal(audio.src, 'https://example.test/A.mp3')
})

test('unmount prevents an outstanding song request from changing audio or emitting state', async t => {
  const loading = deferred()
  const { component, player, audio, emitted } = createPlayer(t, { getSongUrl: () => loading.promise })
  player.playlist = [song('A')]
  const pending = player.requestSong(player.playlist[0])
  component.beforeUnmount.call(player)
  loading.resolve({ status: 1, url: 'https://example.test/A.mp3' })
  await pending
  assert.equal(audio.playCount, 0)
  assert.equal(audio.src, '')
  assert.equal(emitted.length, 0)
})

test('late lyrics and failures for A cannot overwrite current B', async t => {
  for (const failOldRequest of [false, true]) {
    const first = deferred()
    const { player } = createPlayer(t, {
      getLyric: hash => hash === 'A' ? first.promise : Promise.resolve({ status: 1, decodeContent: 'lyrics B' })
    })
    player.currentSong = song('A')
    const pending = player.loadLyric(player.currentSong)
    player.currentSong = song('B')
    await player.loadLyric(player.currentSong)
    if (failOldRequest) first.reject(new Error('old request failed'))
    else first.resolve({ status: 1, decodeContent: 'lyrics A' })
    await pending
    assert.equal(player.currentLyrics, 'lyrics B')
    assert.equal(player.pendingTimers.size, 0)
  }
})

test('external selection aligns queue index before next-track navigation', async t => {
  const { player } = createPlayer(t)
  player.playlist = ['A', 'B', 'C', 'D'].map(song)
  await player.loadSong(player.playlist[2])
  assert.equal(player.currentIndex, 2)
  await player.playNext()
  assert.equal(player.currentSong.hash, 'D')
  assert.equal(player.currentIndex, 3)
})

test('a one-song loop restarts ended audio without fetching the same URL', async t => {
  let requests = 0
  const { player, audio } = createPlayer(t, { getSongUrl: async () => { requests++; return { status: 1, url: 'https://example.test/A.mp3' } } })
  player.playlist = [song('A')]
  await player.loadSong(player.playlist[0])
  audio.ended = true
  audio.paused = true
  audio.currentTime = audio.duration
  await player.playNext()
  assert.equal(audio.currentTime, 0)
  assert.equal(audio.playCount, 2)
  assert.equal(requests, 1)
})

test('deleting a queued song replaces the parent queue and removes next-track state', async t => {
  const { player } = createPlayer(t)
  const original = ['A', 'B', 'C'].map(song)
  player.playlist = original
  player.currentSong = original[0]
  player.playNextQueue = [original[1]]
  await player.handleRemoveSong(1)
  assert.equal(original.length, 3)
  assert.deepEqual(Array.from(player.playlist, item => item.hash), ['A', 'C'])
  assert.equal(player.playNextQueue.length, 0)
  await player.playNext()
  assert.equal(player.currentSong.hash, 'C')
})

test('deleting the current last queue item falls back to index zero', async t => {
  const { player } = createPlayer(t)
  player.playlist = ['A', 'B', 'C'].map(song)
  await player.loadSong(player.playlist[2])
  await player.handleRemoveSong(2)
  assert.equal(player.currentSong.hash, 'A')
  assert.equal(player.currentIndex, 0)
})

test('deleting the only song stops playback and clears pending next-track state', async t => {
  const { player, audio } = createPlayer(t)
  player.playlist = [song('A')]
  await player.loadSong(player.playlist[0])
  player.playNextQueue = [song('B')]
  await player.handleRemoveSong(0)
  assert.equal(player.playlist.length, 0)
  assert.equal(player.currentSong, null)
  assert.equal(player.isPlaying, false)
  assert.equal(audio.src, '')
  assert.equal(player.playNextQueue.length, 0)
})

test('out-of-range queue deletion does not remove an unrelated song', async t => {
  const { player, emitted } = createPlayer(t)
  player.playlist = [song('A'), song('B')]
  for (const index of [-1, 2, 0.5, NaN]) await player.handleRemoveSong(index)
  assert.equal(player.playlist.length, 2)
  assert.equal(emitted.length, 0)
})

test('clear invalidates an outstanding load before it can restart playback', async t => {
  const pendingUrl = deferred()
  const { player, audio } = createPlayer(t, { getSongUrl: () => pendingUrl.promise })
  player.playlist = [song('A')]
  const loading = player.requestSong(player.playlist[0])
  player.handleClearPlaylist()
  pendingUrl.resolve({ status: 1, url: 'https://example.test/A.mp3' })
  await loading
  assert.equal(player.currentSong, null)
  assert.equal(audio.playCount, 0)
})

test('volume adjustment keeps mute UI and the audio element consistent', t => {
  const { player, audio } = createPlayer(t)
  player.toggleMute()
  player.volume = 50
  player.handleVolumeChange()
  assert.equal(player.isMuted, false)
  assert.equal(audio.muted, false)
  player.volume = 0
  player.handleVolumeChange()
  assert.equal(player.isMuted, true)
  assert.equal(audio.muted, true)
})

test('media actions are idempotent and all callbacks are released on unmount', async t => {
  const { component, player, audio, actions } = createPlayer(t)
  audio.src = 'https://example.test/A.mp3'
  player.initMediaSessionHandlers()
  actions.get('play')()
  actions.get('play')()
  assert.equal(audio.playCount, 1)
  actions.get('pause')()
  actions.get('pause')()
  assert.equal(audio.pauseCount, 1)
  component.beforeUnmount.call(player)
  assert.ok([...actions.values()].every(callback => callback === null))
})

test('unmount clears retry timers and releases the waiting operation', async t => {
  const { component, player } = createPlayer(t)
  const waiting = player.waitForDelay(10000)
  assert.equal(player.pendingTimers.size, 1)
  component.beforeUnmount.call(player)
  assert.equal(await waiting, false)
  assert.equal(player.pendingTimers.size, 0)
})

test('drawer watchers preserve both visibility and song-change scrolling', async () => {
  const { component } = loadComponent('PlaylistDrawer.vue')
  let scrolls = 0
  const drawer = { visible: true, currentSong: song('A'), $nextTick: callback => callback(), scrollToCurrentSong: () => scrolls++ }
  component.watch.visible.handler.call(drawer, true)
  component.watch.currentSong.handler.call(drawer, song('B'))
  assert.equal(scrolls, 2)
})

test('closing lyrics keeps the title bar in lyric mode until the slide finishes', async t => {
  const { player, emitted } = createPlayer(t)
  player.currentSong = song('A')
  player.currentLyrics = '[00:00.00]A'
  await player.showLyrics()
  emitted.length = 0
  player.closeLyrics()
  assert.equal(player.showLyricView, false)
  assert.equal(emitted.length, 0)
  player.handleLyricsHidden()
  assert.deepEqual(emitted, [{ name: 'lyric-view-changed', value: false }])
})

test('an old lyric exit cannot reset the title bar after reopening or unmount', async t => {
  const { component, player, emitted } = createPlayer(t)
  player.currentSong = song('A')
  player.currentLyrics = '[00:00.00]A'
  await player.showLyrics()
  player.closeLyrics()
  await player.showLyrics()
  emitted.length = 0
  player.handleLyricsHidden()
  assert.equal(player.showLyricView, true)
  assert.equal(emitted.length, 0)
  player.closeLyrics()
  component.beforeUnmount.call(player)
  player.handleLyricsHidden()
  assert.equal(emitted.length, 0)
})

test('closing while lyrics load prevents a late response from reopening the view', async t => {
  const pending = deferred()
  const { player, emitted } = createPlayer(t)
  player.currentSong = song('A')
  player.loadLyric = () => pending.promise
  const opening = player.showLyrics()
  player.closeLyrics()
  pending.resolve()
  await opening
  assert.equal(player.showLyricView, false)
  assert.equal(emitted.length, 0)
})

test('drawer deletion uses object identity despite invalid and identically named items', () => {
  const { component } = loadComponent('PlaylistDrawer.vue')
  const first = { hash: 'A', name: 'same name' }
  const second = { hash: 'B', name: 'same name' }
  const emitted = []
  const drawer = { playlist: [null, first, second], validPlaylist: [first, second], $emit: (...args) => emitted.push(args) }
  drawer.removePlaylistSong = component.methods.removePlaylistSong.bind(drawer)
  component.methods.removeSong.call(drawer, 1)
  component.methods.removeSong.call(drawer, 99)
  assert.deepEqual(emitted, [['remove', 2]])
})

test('lyric mount starts animation updates and unmount releases frames, resize and body scroll', async t => {
  const { component, sandbox, listeners, lyric, frames } = createLyric(t)
  component.mounted.call(lyric)
  assert.equal(frames.callbacks.size, 1)
  assert.equal(sandbox.document.body.style.overflow, 'hidden')
  assert.equal(listeners.get('resize').size, 1)
  lyric.syncPlaybackTime(50, true)
  await flush()
  assert.equal(frames.callbacks.size, 1)
  lyric.handleWindowResize()
  component.beforeUnmount.call(lyric)
  assert.equal(frames.callbacks.size, 0)
  assert.equal(listeners.get('resize').size, 0)
  assert.equal(sandbox.document.body.style.overflow, 'auto')
  assert.equal(lyric.isDisposed, true)
})

test('range input moves lyrics with every preview and commits the audio seek only once on release', t => {
  const { lyric, emitted } = createLyric(t)
  lyric.parsedLyrics = [{ time: 0, text: 'first' }, { time: 20, text: 'second' }, { time: 40, text: 'third' }]
  lyric.currentPlayTime = 10
  lyric.syncPlaybackTime(10)
  for (const value of ['30', '80', '50']) {
    lyric.previewSeek({ target: { value } })
    assert.equal(lyric.internalPlayTime, Number(value))
    assert.equal(lyric.currentLyricIndex, Number(value) >= 40 ? 2 : 1)
  }
  assert.equal(lyric.displayPlayTime, 50)
  assert.equal(emitted.length, 0)
  lyric.commitSeek({ target: { value: '50' } })
  assert.deepEqual(emitted, [{ name: 'seek', value: 50 }])
  assert.equal(lyric.seekPreviewTime, null)
  assert.equal(lyric.internalPlayTime, 50)
  lyric.commitSeek({ target: { value: '80' } })
  assert.equal(emitted.length, 1)
})

test('cancelled range input restores actual progress and never emits a seek', t => {
  const { component, lyric, emitted } = createLyric(t)
  lyric.currentPlayTime = 15
  lyric.syncPlaybackTime(15)
  lyric.previewSeek({ target: { value: '75' } })
  lyric.currentPlayTime = 18
  component.watch.currentPlayTime.call(lyric, 18)
  assert.equal(lyric.internalPlayTime, 75)
  lyric.cancelSeek()
  assert.equal(lyric.displayPlayTime, 18)
  assert.equal(lyric.internalPlayTime, 18)
  lyric.commitSeek({ target: { value: '75' } })
  assert.equal(emitted.length, 0)
  lyric.previewSeek({ target: { value: '45' } })
  component.watch.visible.call(lyric, false)
  assert.equal(lyric.seekPreviewTime, null)
  assert.equal(emitted.length, 0)
})

test('switching songs cancels lyric previews and ignores input or change while updates are paused', t => {
  const { component, lyric, emitted } = createLyric(t)
  lyric.currentPlayTime = 15
  lyric.syncDisplayedTime()
  lyric.previewSeek({ target: { value: '75' } })
  lyric.pauseUpdates = true
  component.watch.pauseUpdates.call(lyric, true)
  assert.equal(lyric.seekPreviewTime, null)
  assert.equal(lyric.internalPlayTime, 15)
  lyric.previewSeek({ target: { value: '90' } })
  lyric.commitSeek({ target: { value: '90' } })
  lyric.seekTo(90)
  assert.equal(lyric.seekPreviewTime, null)
  assert.equal(emitted.length, 0)
})

test('the mounted lyric RAF and real audio time updates cannot overwrite a local drag preview', async t => {
  const { component, lyric, frames, emitted } = createLyric(t)
  lyric.parsedLyrics = [{ time: 0, text: 'first' }, { time: 20, text: 'second' }, { time: 40, text: 'third' }]
  lyric.currentPlayTime = 1
  component.mounted.call(lyric)
  frames.step()
  for (const target of [25, 45, 35]) {
    lyric.previewSeek({ target: { value: String(target) } })
    lyric.currentPlayTime += 1
    component.watch.currentPlayTime.call(lyric, lyric.currentPlayTime)
    await flush()
    frames.step()
    assert.equal(lyric.displayPlayTime, target)
    assert.equal(lyric.internalPlayTime, target)
    assert.equal(lyric.currentLyricIndex, target >= 40 ? 2 : 1)
    assert.equal(frames.callbacks.size, 1)
    assert.match(lyric.getLyricLineStyle(lyric.currentLyricIndex).transition, /transform 0\.24s/)
  }
  assert.equal(emitted.length, 0)
})

test('rapid drag previews update bridges, word highlighting and long-line movement before release', t => {
  const { lyric, emitted, setLine } = createLyric(t)
  lyric.parsedLyrics = [
    { time: 0, text: 'first' },
    { time: 10, text: 'EFGH', words: [...'EFGH'].map((word, index) => ({ word, startTime: index, endTime: index + 1 })) },
    { time: 40, text: 'last' }
  ]
  const line = setLine(1, 'EFGH', 500, 300)
  line.characters.forEach((character, index) => {
    Object.assign(character.dataset, { lineStart: '10', start: String(index), end: String(index + 1) })
  })
  lyric.currentPlayTime = 2
  lyric.syncPlaybackTime(2)
  for (const target of [12.5, 20, 42, 1, 12.5]) {
    lyric.previewSeek({ target: { value: String(target) } })
    assert.equal(lyric.internalPlayTime, target)
    assert.equal(lyric.isBridgeActive, target === 20)
    assert.equal(lyric.currentLyricIndex, target >= 40 ? 2 : target >= 10 ? 1 : 0)
    if (target === 12.5) {
      assert.equal(line.innerText.style.transform, 'translateX(-125px)')
      assert.equal(line.characters[0].style.color, 'var(--lyric-accent)')
      assert.equal(line.characters[3].style.color, 'var(--lyric-pending)')
    } else if (target === 20) {
      assert.equal(line.innerText.style.transform, 'translateX(-200px)')
      assert.ok(lyric.getLyricLineStyle(1).opacity >= 0.8)
    } else {
      assert.equal(line.innerText.style.transform, '')
    }
  }
  assert.equal(emitted.length, 0)
})

test('external progress previews survive audio and RAF updates while local dragging keeps priority', t => {
  const { component, lyric, frames, emitted } = createLyric(t)
  lyric.parsedLyrics = [{ time: 0, text: 'first' }, { time: 20, text: 'second' }, { time: 40, text: 'third' }]
  lyric.currentPlayTime = 5
  component.mounted.call(lyric)
  frames.step()
  lyric.previewTime = 25
  component.watch.previewTime.call(lyric, 25)
  assert.equal(lyric.internalPlayTime, 25)
  lyric.currentPlayTime = 8
  component.watch.currentPlayTime.call(lyric, 8)
  frames.step()
  assert.equal(lyric.displayPlayTime, 25)
  assert.equal(lyric.internalPlayTime, 25)
  lyric.previewSeek({ target: { value: '45' } })
  assert.equal(lyric.internalPlayTime, 45)
  lyric.previewTime = 30
  component.watch.previewTime.call(lyric, 30)
  assert.equal(lyric.internalPlayTime, 45)
  lyric.cancelSeek()
  assert.equal(lyric.internalPlayTime, 30)
  lyric.previewTime = null
  component.watch.previewTime.call(lyric, null)
  frames.step()
  assert.equal(lyric.displayPlayTime, 8)
  assert.equal(lyric.internalPlayTime, 8)
  lyric.commitSeek({ target: { value: '45' } })
  assert.equal(emitted.length, 0)
})

test('committing a lyric preview never rolls back through the actual time before its single seek', t => {
  const { lyric, emitted } = createLyric(t)
  lyric.currentPlayTime = 5
  lyric.syncPlaybackTime(5)
  lyric.previewSeek({ target: { value: '50' } })
  const synchronized = []
  const sync = lyric.syncPlaybackTime
  lyric.syncPlaybackTime = (time, isSeek) => { synchronized.push(time); return sync(time, isSeek) }
  lyric.commitSeek({ target: { value: '50' } })
  assert.deepEqual(emitted, [{ name: 'seek', value: 50 }])
  assert.equal(lyric.seekPreviewTime, null)
  assert.equal(lyric.internalPlayTime, 50)
  assert.ok(synchronized.every(time => time === 50), 'commit must not restore the old actual position before seeking')
  lyric.commitSeek({ target: { value: '50' } })
  assert.equal(emitted.length, 1)
})

test('Escape, switching songs and suspended lyric updates cancel pending drag commits', t => {
  const { component, lyric, emitted } = createLyric(t)
  lyric.currentPlayTime = 10
  lyric.previewSeek({ target: { value: '80' } })
  lyric.handleProgressEscape()
  assert.equal(lyric.internalPlayTime, 10)
  lyric.commitSeek({ target: { value: '80' } })
  assert.equal(emitted.length, 0)
  lyric.previewSeek({ target: { value: '60' } })
  component.watch.song.call(lyric, song('B'))
  lyric.commitSeek({ target: { value: '60' } })
  assert.equal(lyric.seekPreviewTime, null)
  assert.equal(emitted.length, 0)
  lyric.previewSeek({ target: { value: '40' } })
  component.watch.pauseUpdates.call(lyric, true)
  lyric.commitSeek({ target: { value: '40' } })
  assert.equal(lyric.seekPreviewTime, null)
  assert.equal(emitted.length, 0)
})

test('lyric seek rejects invalid positions and unknown duration, and clamps valid boundaries', t => {
  const { lyric, emitted } = createLyric(t)
  for (const value of [NaN, Infinity, -Infinity, undefined, null, '20']) lyric.seekTo(value)
  assert.equal(emitted.length, 0)
  lyric.seekTo(-10)
  lyric.seekTo(999)
  assert.deepEqual(emitted.map(event => event.value), [0, 120])
  assert.equal(lyric.internalPlayTime, 120)
  for (const duration of [0, NaN, Infinity]) {
    lyric.duration = duration
    lyric.previewSeek({ target: { value: '50' } })
    lyric.seekTo(50)
  }
  assert.equal(emitted.length, 2)
  assert.equal(lyric.seekPreviewTime, null)
})

test('forward and backward seeks enter or leave instrumental bridges in the same update', t => {
  const { lyric } = createLyric(t)
  lyric.parsedLyrics = [
    { time: 0, text: 'first' }, { time: 10, text: 'second' }, { time: 40, text: 'third' }
  ]
  lyric.syncPlaybackTime(20, true)
  assert.equal(lyric.currentLyricIndex, 1)
  assert.equal(lyric.isBridgeActive, true)
  assert.equal(lyric.bridgeInfo.startLyricIndex, 1)
  assert.ok(lyric.bridgeProgress > 0 && lyric.bridgeProgress < 100)
  lyric.syncPlaybackTime(42, true)
  assert.equal(lyric.currentLyricIndex, 2)
  assert.equal(lyric.isBridgeActive, false)
  lyric.syncPlaybackTime(1, true)
  assert.equal(lyric.currentLyricIndex, 0)
  assert.equal(lyric.isBridgeActive, false)
  assert.equal(lyric.bridgeProgress, 0)
})

test('instrumental bridges preserve the completed lyric above the progress indicator', t => {
  const { lyric, setLine } = createLyric(t)
  lyric.parsedLyrics = [
    { time: 0, text: 'first' }, { time: 10, text: 'completed' }, { time: 40, text: 'next' }
  ]
  setLine(1, 'completed')
  lyric.syncPlaybackTime(12)
  lyric.syncPlaybackTime(20)
  assert.equal(lyric.isBridgeActive, true)
  const previous = lyric.getLyricLineStyle(1)
  const upcoming = lyric.getLyricLineStyle(2)
  assert.ok(previous.opacity >= 0.8, 'the completed lyric must remain readable during the bridge')
  assert.ok(Number(previous.transform.match(/translateY\(([-\d.]+)px\)/)[1]) < 0)
  assert.ok(Number(upcoming.transform.match(/translateY\(([-\d.]+)px\)/)[1]) > 0)
  lyric.syncPlaybackTime(40)
  assert.equal(lyric.isBridgeActive, false)
  assert.match(lyric.getLyricLineStyle(2).transform, /translateY\(0px\)/)
})

test('an opening instrumental leaves the first lyric visible below the bridge indicator', t => {
  const { lyric } = createLyric(t)
  lyric.parsedLyrics = [{ time: 25, text: 'first' }, { time: 30, text: 'second' }]
  lyric.syncPlaybackTime(0)
  assert.equal(lyric.isBridgeActive, true)
  const upcoming = lyric.getLyricLineStyle(0)
  assert.ok(upcoming.opacity > 0)
  assert.ok(Number(upcoming.transform.match(/translateY\(([-\d.]+)px\)/)[1]) > 0)
})

test('committing lyric progress scrolls smoothly to the newest target without delaying timing', t => {
  const { lyric, emitted, setLine } = createLyric(t)
  lyric.parsedLyrics = [{ time: 0, text: 'first' }, { time: 10, text: 'ABCD' }, { time: 20, text: 'next' }]
  const { characters } = setLine(1, 'ABCD')
  lyric.currentPlayTime = 1
  lyric.syncPlaybackTime(1)
  lyric.previewSeek({ target: { value: '15' } })
  lyric.commitSeek({ target: { value: '15' } })
  assert.deepEqual(emitted, [{ name: 'seek', value: 15 }])
  assert.equal(lyric.internalPlayTime, 15)
  assert.equal(lyric.currentLyricIndex, 1)
  assert.match(lyric.getLyricLineStyle(1).transition, /transform [\d.]+s/)
  assert.equal(characters[0].style.color, 'var(--lyric-accent)')
  assert.equal(characters[3].style.color, 'var(--lyric-pending)')
})

test('ordinary playback and seek transitions retain their distinct timing without reset frames', async t => {
  const { lyric, frames } = createLyric(t)
  lyric.parsedLyrics = [
    { time: 0, text: 'first' }, { time: 1, text: 'second' },
    { time: 10, text: 'third' }, { time: 20, text: 'fourth' }
  ]
  lyric.syncPlaybackTime(0)
  assert.equal(lyric.getLyricLineStyle(0).transition, 'none')
  lyric.syncPlaybackTime(0.5)
  assert.equal(lyric.getLyricLineStyle(0).transition, 'none')
  lyric.syncPlaybackTime(1)
  assert.match(lyric.getLyricLineStyle(1).transition, /transform 0\.45s/)
  lyric.syncPlaybackTime(12, true)
  assert.match(lyric.getLyricLineStyle(2).transition, /transform 0\.24s/)
  assert.equal(lyric.currentLyricIndex, 2)
  await flush()
  assert.equal(frames.callbacks.size, 0)
  frames.step()
  assert.match(lyric.getLyricLineStyle(2).transition, /transform 0\.24s/)
  lyric.syncPlaybackTime(12.2)
  assert.match(lyric.getLyricLineStyle(2).transition, /transform 0\.24s/)
  for (let time = 13; time <= 20; time += 1) lyric.syncPlaybackTime(time)
  assert.match(lyric.getLyricLineStyle(3).transition, /transform 0\.45s/)
})

test('seek transitions survive parent time echoes and the mounted animation loop until a new layout target', async t => {
  const { component, lyric, frames, emitted } = createLyric(t)
  lyric.parsedLyrics = [{ time: 0, text: 'first' }, { time: 10, text: 'second' }, { time: 20, text: 'third' }]
  lyric.currentPlayTime = 1
  component.mounted.call(lyric)
  frames.step()
  assert.equal(frames.callbacks.size, 1, 'the production RAF loop must be running')
  assert.equal(lyric.getLyricLineStyle(0).transition, 'none')
  lyric.$emit = (name, value) => {
    emitted.push({ name, value })
    if (name === 'seek') {
      lyric.$nextTick(() => {
        lyric.currentPlayTime = value
        component.watch.currentPlayTime.call(lyric, value)
      })
    }
  }
  lyric.previewSeek({ target: { value: '15' } })
  lyric.commitSeek({ target: { value: '15' } })
  assert.equal(lyric.currentLyricIndex, 1)
  assert.match(lyric.getLyricLineStyle(1).transition, /transform 0\.24s/)
  await flush()
  assert.equal(lyric.currentPlayTime, 15)
  assert.match(lyric.getLyricLineStyle(1).transition, /transform 0\.24s/, 'the echoed prop must not replace the seek timing')
  for (let count = 0; count < 4; count += 1) {
    frames.step()
    assert.equal(frames.callbacks.size, 1)
    assert.match(lyric.getLyricLineStyle(1).transition, /transform 0\.24s/)
  }
  for (let time = 16; time <= 20; time += 1) {
    lyric.currentPlayTime = time
    component.watch.currentPlayTime.call(lyric, time)
    frames.step()
  }
  assert.equal(lyric.currentLyricIndex, 2)
  assert.match(lyric.getLyricLineStyle(2).transition, /transform 0\.45s/)
})

test('ordinary bridge layout changes use normal timing while seeks retain their shorter timing', t => {
  const { lyric } = createLyric(t)
  lyric.parsedLyrics = [{ time: 0, text: 'first' }, { time: 10, text: 'completed' }, { time: 40, text: 'next' }]
  lyric.syncPlaybackTime(12)
  lyric.syncPlaybackTime(12.5)
  assert.equal(lyric.lineTransitionDuration, 0)
  lyric.syncPlaybackTime(13)
  assert.equal(lyric.isBridgeActive, true)
  assert.equal(lyric.currentLyricIndex, 1)
  assert.equal(lyric.lineTransitionDuration, 0.45, 'entering a bridge moves the previous line even if its index is unchanged')
  lyric.seekTo(20)
  lyric.syncPlaybackTime(20)
  assert.equal(lyric.lineTransitionDuration, 0.24)
  lyric.syncPlaybackTime(39.5)
  lyric.syncPlaybackTime(40)
  assert.equal(lyric.isBridgeActive, false)
  assert.equal(lyric.lineTransitionDuration, 0.45)
})

test('rapid consecutive seeks retarget the newest line and cannot schedule stale resets after unmount', async t => {
  const { component, lyric, frames, emitted } = createLyric(t)
  lyric.parsedLyrics = [
    { time: 0, text: 'first' }, { time: 10, text: 'second' }, { time: 40, text: 'third' }
  ]
  lyric.syncPlaybackTime(0)
  lyric.seekTo(50)
  lyric.seekTo(5)
  await flush()
  assert.equal(frames.callbacks.size, 0)
  frames.step()
  assert.equal(lyric.currentLyricIndex, 0)
  assert.match(lyric.getLyricLineStyle(0).transition, /transform 0\.24s/)
  assert.match(lyric.getLyricLineStyle(0).transform, /translateY\(0px\)/)

  lyric.seekTo(42)
  await flush()
  assert.equal(frames.callbacks.size, 0)
  frames.step()
  assert.match(lyric.getLyricLineStyle(2).transition, /transform 0\.24s/)
  assert.equal(lyric.currentLyricIndex, 2)
  assert.match(lyric.getLyricLineStyle(2).transform, /translateY\(0px\)/)

  lyric.seekTo(10)
  const emittedBeforeUnmount = emitted.length
  component.beforeUnmount.call(lyric)
  await flush()
  frames.step()
  lyric.seekTo(20)
  lyric.onWindowResize()
  assert.equal(frames.callbacks.size, 0)
  assert.equal(emitted.length, emittedBeforeUnmount)
  assert.equal(lyric.internalPlayTime, 10)
})

test('distant lyrics retain a bounded offscreen position so seeking into them can animate', t => {
  const { lyric } = createLyric(t)
  lyric.parsedLyrics = Array.from({ length: 20 }, (_, index) => ({ time: index * 5, text: `line ${index}` }))
  lyric.syncPlaybackTime(0)
  const hidden = lyric.getLyricLineStyle(15)
  assert.equal(hidden.visibility, 'hidden')
  assert.notEqual(hidden.display, 'none')
  const offset = Number(hidden.transform.match(/translateY\(([-\d.]+)px\)/)[1])
  assert.equal(offset, 9 * lyric.lyricLineHeight)
  lyric.seekTo(76)
  const current = lyric.getLyricLineStyle(15)
  assert.equal(current.visibility, 'visible')
  assert.match(current.transform, /translateY\(0px\)/)
  assert.match(current.transition, /transform 0\.24s/)
})

test('main player drag previews drive lyrics while actual time and RAF advance, then seek only once', t => {
  const playerFrames = createFrameClock()
  const { player, audio } = createPlayer(t, {
    requestAnimationFrame: callback => playerFrames.request(callback),
    cancelAnimationFrame: id => playerFrames.cancel(id)
  })
  const { component, lyric, frames } = createLyric(t)
  let actualTime = 1
  let audioSeeks = 0
  Object.defineProperty(audio, 'currentTime', {
    get: () => actualTime,
    set: value => { actualTime = value; audioSeeks++ }
  })
  audio.src = 'https://example.test/A.mp3'
  player.$el = {}
  player.duration = audio.duration = 120
  player.currentTime = 1
  lyric.parsedLyrics = [{ time: 0, text: 'first' }, { time: 10, text: 'second' }, { time: 20, text: 'third' }]
  lyric.currentPlayTime = 1
  component.mounted.call(lyric)
  frames.step()
  const passPlayerTimesToLyrics = () => {
    const previousPreview = lyric.previewTime
    const previousTime = lyric.currentPlayTime
    lyric.previewTime = player.seekPreviewTime
    lyric.currentPlayTime = player.currentTime
    if (lyric.previewTime !== previousPreview) component.watch.previewTime.call(lyric, lyric.previewTime)
    if (lyric.currentPlayTime !== previousTime) component.watch.currentPlayTime.call(lyric, lyric.currentPlayTime)
  }
  for (const target of [15, 25, 5, 15]) {
    player.handleProgressDrag({ target: { value: String(target) } })
    passPlayerTimesToLyrics()
    assert.equal(player.displayPlayTime, target)
    assert.equal(lyric.internalPlayTime, target)
    assert.equal(lyric.currentLyricIndex, target >= 20 ? 2 : target >= 10 ? 1 : 0)
  }
  actualTime = 2
  player.handleTimeUpdate()
  passPlayerTimesToLyrics()
  assert.equal(player.currentTime, 2)
  assert.equal(player.displayPlayTime, 15)
  assert.equal(lyric.internalPlayTime, 15)
  player.startTimeUpdate()
  actualTime = 3
  playerFrames.step()
  passPlayerTimesToLyrics()
  frames.step()
  assert.equal(player.currentTime, 3)
  assert.equal(player.seekPreviewTime, 15)
  assert.equal(player.displayPlayTime, 15)
  assert.equal(lyric.internalPlayTime, 15)
  assert.equal(audioSeeks, 0)
  player.handleProgressChange({ target: { value: '15' } })
  passPlayerTimesToLyrics()
  assert.equal(player.isDragging, false)
  assert.equal(player.seekPreviewTime, null)
  assert.equal(audio.currentTime, 15)
  assert.equal(lyric.internalPlayTime, 15)
  assert.equal(lyric.currentLyricIndex, 1)
  assert.match(lyric.getLyricLineStyle(1).transition, /transform 0\.24s/)
  player.handleProgressChange({ target: { value: '100' } })
  assert.equal(audioSeeks, 1)
  assert.equal(audio.currentTime, 15)
})

test('cancelling a main player preview restores the latest audio time and ignores late or old-song changes', async t => {
  const { player, audio } = createPlayer(t)
  let actualTime = 1
  let audioSeeks = 0
  Object.defineProperty(audio, 'currentTime', {
    get: () => actualTime,
    set: value => { actualTime = value; audioSeeks++ }
  })
  audio.src = 'https://example.test/A.mp3'
  player.duration = audio.duration = 120
  player.currentSong = song('A')
  player.currentTime = 1
  player.handleProgressDrag({ target: { value: '80' } })
  actualTime = 9
  player.cancelProgressDrag()
  assert.equal(player.currentTime, 9)
  assert.equal(player.displayPlayTime, 9)
  assert.equal(player.seekPreviewTime, null)
  assert.equal(player.isDragging, false)
  player.handleProgressChange({ target: { value: '80' } })
  assert.equal(audio.currentTime, 9)
  assert.equal(audioSeeks, 0)

  player.handleProgressDrag({ target: { value: '60' } })
  player.isComponentReady = false
  await player.requestSong(song('B'))
  assert.equal(player.seekPreviewTime, null)
  assert.equal(player.isDragging, false)
  player.handleProgressChange({ target: { value: '60' } })
  assert.equal(audio.currentTime, 9)
  assert.equal(audioSeeks, 0)
})

test('main progress previews clamp valid boundaries, reject invalid durations and clear when playback stops', t => {
  const { player, audio } = createPlayer(t)
  audio.src = 'https://example.test/A.mp3'
  player.duration = 120
  player.handleProgressDrag({ target: { value: '999' } })
  assert.equal(player.displayPlayTime, 120)
  player.handleProgressDrag({ target: { value: '-5' } })
  assert.equal(player.displayPlayTime, 0)
  player.cancelProgressDrag()
  for (const duration of [0, NaN, Infinity]) {
    player.duration = duration
    player.handleProgressDrag({ target: { value: '50' } })
    assert.equal(player.seekPreviewTime, null)
    assert.equal(player.isDragging, false)
  }
  player.duration = 120
  player.handleProgressDrag({ target: { value: '50' } })
  player.closeLyrics()
  assert.equal(player.seekPreviewTime, null)
  assert.equal(player.isDragging, false)
  player.handleProgressDrag({ target: { value: '50' } })
  player.stopPlayback()
  assert.equal(player.seekPreviewTime, null)
  assert.equal(player.isDragging, false)
  player.handleProgressChange({ target: { value: '50' } })
  assert.equal(audio.src, '')
  assert.equal(audio.currentTime, 0)
})

test('the final LRC line highlights progressively through the remaining song duration', t => {
  const { lyric, setLine } = createLyric(t)
  lyric.duration = 30
  lyric.parsedLyrics = [{ time: 0, text: 'first' }, { time: 10, text: 'ABCD' }]
  const { characters } = setLine(1, 'ABCD')
  lyric.syncPlaybackTime(20)
  assert.equal(lyric.currentLyricIndex, 1)
  assert.equal(characters[0].style.color, 'var(--lyric-accent)')
  assert.equal(characters[3].style.color, 'var(--lyric-pending)')
  lyric.syncPlaybackTime(30)
  assert.ok(characters.every(character => character.style.color === 'var(--lyric-accent)'))
})

test('long lyrics move only inner text and remain synchronized when paused, seeking and resizing', async t => {
  const { lyric, sandbox, setLine } = createLyric(t)
  lyric.parsedLyrics = [{ time: 0, text: 'long text' }, { time: 10, text: 'next' }]
  const { innerText, viewport, element } = setLine(0, 'long text', 500, 300)
  const outerTransform = element.style.transform
  lyric.syncPlaybackTime(5)
  assert.equal(innerText.style.transform, 'translateX(-100px)')
  assert.equal(element.style.transform, outerTransform)
  lyric.isPlaying = false
  lyric.syncPlaybackTime(5)
  assert.equal(innerText.style.transform, 'translateX(-100px)')
  lyric.seekTo(2)
  assert.equal(innerText.style.transform, 'translateX(-40px)')
  viewport.clientWidth = 100
  sandbox.window.innerWidth = 640
  sandbox.window.innerHeight = 480
  lyric.onWindowResize()
  await flush()
  assert.equal(innerText.style.transform, 'translateX(-80px)')
  assert.equal(lyric.viewportWidth, 640)
  assert.equal(lyric.viewportHeight, 480)
  assert.equal(element.style.transform, outerTransform)
})

test('short text does not drift and changing lines clears the previous inner translation', t => {
  const { lyric, setLine } = createLyric(t)
  lyric.parsedLyrics = [{ time: 0, text: 'long text' }, { time: 10, text: 'short' }]
  const previous = setLine(0, 'long text', 500, 300)
  const current = setLine(1, 'short', 80, 300)
  lyric.syncPlaybackTime(5)
  assert.equal(previous.innerText.style.transform, 'translateX(-100px)')
  lyric.syncPlaybackTime(15)
  assert.equal(previous.innerText.style.transform, '')
  assert.equal(current.innerText.style.transform, 'translateX(0px)')
})

test('KRC long-line movement completes at its final word rather than the following line', t => {
  const { lyric, setLine } = createLyric(t)
  lyric.parsedLyrics = [
    { time: 0, text: 'long text', words: [{ word: 'long text', startTime: 0, endTime: 5 }] },
    { time: 10, text: 'next' }
  ]
  const { innerText } = setLine(0, 'long text', 500, 300)
  lyric.syncPlaybackTime(8)
  assert.equal(innerText.style.transform, 'translateX(-200px)')
})

test('the main progress bar releases dragging even if its audio source has disappeared', t => {
  const { player, audio } = createPlayer(t)
  player.isDragging = true
  player.currentTime = 13
  audio.currentTime = 13
  audio.src = ''
  player.handleProgressChange({ target: { value: '42' } })
  assert.equal(player.isDragging, false)
  assert.equal(player.currentTime, 13)
  assert.equal(audio.currentTime, 13)
})

test('player seeks immediately synchronize the displayed position and clamp finite values', t => {
  const { player, audio } = createPlayer(t)
  audio.src = 'https://example.test/A.mp3'
  player.duration = 180
  player.currentTime = 13
  audio.currentTime = 13
  for (const value of [NaN, Infinity, -Infinity, '42']) player.handleSeek(value)
  assert.equal(audio.currentTime, 13)
  player.handleSeek(42)
  assert.equal(audio.currentTime, 42)
  assert.equal(player.currentTime, 42)
  player.handleSeek(-10)
  assert.equal(player.currentTime, 0)
  player.handleSeek(999)
  assert.equal(player.currentTime, 180)
  assert.equal(audio.currentTime, 180)
})
