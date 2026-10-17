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
    setTimeout, clearTimeout, setInterval, clearInterval, structuredClone, AbortController, atob, TextDecoder,
    requestAnimationFrame: () => 1, cancelAnimationFrame: () => {},
    computed: () => null,
    navigator: { mediaSession: { setActionHandler: (name, callback) => actions.set(name, callback) } },
    window: { ...events, innerWidth: 1200, innerHeight: 800 },
    document: { ...events, body: { style: { overflow: 'auto' } } },
    localStorage: { getItem: () => null, setItem: () => {} },
    getSongDetail: async () => ({ status: 1, data: [] }),
    getSongUrl: async hash => ({ status: 1, url: `https://example.test/${hash}.mp3` }),
    getLyric: async hash => ({ status: 1, decodeContent: `[00:00.00]${hash}` }),
    getPlaylistCacheAPI: () => sandbox.window.electronAPI?.playlistCache || null,
    waitForPlaylistCacheSession: async () => sandbox.window.electronAPI?.playlistCache || null,
    getPlaylistCacheSessionVersion: () => 0,
    PlaylistDrawer: {}, ContextMenu: {}, LyricView: {}, ArtworkCover: {}, TransitionGroup: {}, SongBadges: {}, ArtistLinks: {},
    contextMenuManager: menuManager,
    useSettingsStore: () => ({ settings: { playback: { quality: '128' }, custom: {} }, async updateSettings() {} }),
    ...Object.fromEntries(['playlistIcon', 'repeatAllIcon', 'repeatOneIcon', 'shuffleIcon',
      'sound0Icon', 'sound1Icon', 'sound2Icon', 'sound3Icon'].map(name => [name, ''])),
    ...overrides
  }
  let source = fs.readFileSync(path.join(playerDirectory, filename), 'utf8')
  if (filename.endsWith('.vue')) source = source.split('<script>')[1].split('</script>')[0]
  source = source.replace(/^import[^\n]*\n/gm, '').replace('export default {', 'globalThis.component = {')
  vm.createContext(sandbox)
  const objectSource = fs.readFileSync(path.join(playerDirectory, '..', '..', 'utils', 'objectUtils.js'), 'utf8')
    .replace(/^import[^\n]*\n/gm, '').replace(/\bexport (?=(?:function|const))/g, '')
  vm.runInContext(objectSource, sandbox)
  const qualitySource = fs.readFileSync(path.join(playerDirectory, '..', '..', 'utils', 'playbackQuality.js'), 'utf8')
    .replace(/\bexport (?=(?:function|const))/g, '')
  vm.runInContext(qualitySource, sandbox)
  for (const filename of ['songMetadata.js', 'desktopLyrics.js']) {
    const utility = fs.readFileSync(path.join(playerDirectory, '..', '..', 'utils', filename), 'utf8')
      .replace(/\bexport (?=(?:function|const))/g, '')
    vm.runInContext(utility, sandbox)
  }
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
    ...component.data(), playlist: [], isComponentReady: true, settingsStore: loaded.sandbox.useSettingsStore(),
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

function qualityStore() {
  return {
    settings: { playback: { quality: '128' }, custom: {} },
    async updateSettings(patch) { Object.assign(this.settings.playback, patch.playback) }
  }
}

/** Model the media load reset and readiness events used when replacing a paused source. */
function qualityAudio(audio, player, { manualReady = false } = {}) {
  const listeners = new Map()
  let source = audio.src
  Object.defineProperty(audio, 'src', {
    get: () => source,
    set(value) { source = value; audio.currentTime = 0; audio.readyState = 0; audio.paused = true; player.handlePause() }
  })
  audio.addEventListener = (event, callback) => {
    if (!listeners.has(event)) listeners.set(event, new Set())
    listeners.get(event).add(callback)
  }
  audio.removeEventListener = (event, callback) => listeners.get(event)?.delete(callback)
  audio.emit = event => [...(listeners.get(event) || [])].forEach(callback => callback())
  audio.load = () => {
    if (!manualReady) queueMicrotask(() => { audio.readyState = 4; audio.emit('canplay') })
  }
  return listeners
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

test('startup restores a paused track only after readiness without briefly playing or publishing zero', async t => {
  const { component, player, audio, emitted } = createPlayer(t)
  const listeners = qualityAudio(audio, player, { manualReady: true })
  player.playlist = [song('A'), song('B')]
  player.initialPlaybackState = { songHash: 'B', currentTime: 42, volume: 35, playMode: 'shuffle', isPlaying: false }
  component.watch.song.handler.call(player, player.playlist[1])
  await flush()
  assert.equal(player.getPlaybackSnapshot(), null)
  assert.equal(audio.playCount, 0)
  assert.equal(emitted.filter(event => event.name === 'song-changed').length, 0)
  audio.readyState = 4
  audio.emit('canplay')
  await flush()
  assert.equal(player.currentSong.hash, 'B')
  assert.equal(player.loadedSongHash, 'B')
  assert.equal(player.currentIndex, 1)
  assert.equal(audio.currentTime, 42)
  assert.equal(audio.paused, true)
  assert.equal(audio.playCount, 0)
  assert.equal(audio.volume, .35)
  assert.equal(player.getPlaybackSnapshot().playbackState.currentTime, 42)
  assert.equal(player.getPlaybackSnapshot().playbackState.isPlaying, false)
  assert.equal(player.playMode, 'shuffle')
  assert.equal(listeners.get('canplay').size, 0)
})

test('startup seeks before the first play and consumes its state only for the initial matching song', async t => {
  const { component, player, audio } = createPlayer(t)
  qualityAudio(audio, player)
  const playedAt = []
  const play = audio.play.bind(audio)
  audio.play = async () => { playedAt.push(audio.currentTime); await play() }
  player.playlist = [song('A'), song('B')]
  player.initialPlaybackState = { songHash: 'A', currentTime: 27, isPlaying: true }
  component.watch.song.handler.call(player, player.playlist[0])
  await flush()
  assert.deepEqual(playedAt, [27])
  assert.equal(player.getPlaybackSnapshot().playbackState.isPlaying, true)
  component.watch.song.handler.call(player, player.playlist[1])
  await flush()
  component.watch.song.handler.call(player, player.playlist[0])
  await flush()
  assert.deepEqual(playedAt, [27, 0, 0])
})

test('a new selection, stop or unmount cancels startup readiness without leaking the old resume position', async t => {
  for (const action of ['selection', 'stop', 'unmount']) {
    const { component, player, audio, emitted } = createPlayer(t)
    const listeners = qualityAudio(audio, player, { manualReady: true })
    player.playlist = [song('A'), song('B')]
    player.initialPlaybackState = { songHash: 'A', currentTime: 72, isPlaying: true }
    component.watch.song.handler.call(player, player.playlist[0])
    await flush()
    if (action === 'selection') component.watch.song.handler.call(player, player.playlist[1])
    else if (action === 'stop') player.stopPlayback()
    else component.beforeUnmount.call(player)
    await flush()
    audio.readyState = 4
    audio.emit('canplay')
    await flush()
    assert.equal(listeners.get('canplay').size, 0, action)
    assert.equal(player.pendingTimers.size, 0, action)
    assert.equal(emitted.some(event => event.name === 'song-changed' && event.value.hash === 'A'), false, action)
    if (action === 'selection') {
      assert.equal(player.currentSong.hash, 'B')
      assert.equal(audio.currentTime, 0)
    } else assert.equal(audio.src, '')
  }
})

test('checkpoints retain the confirmed song and position through pending selection and temporary sources', async t => {
  const nextUrl = deferred()
  const nextPlay = deferred()
  const { player, audio } = createPlayer(t, {
    getSongUrl: hash => hash === 'B' ? nextUrl.promise : Promise.resolve({ status: 1, url: 'https://example.test/A.wav' })
  })
  qualityAudio(audio, player)
  player.playlist = [song('A'), song('B')]
  await player.requestSong(player.playlist[0])
  audio.currentTime = 31
  const pending = player.requestSong(player.playlist[1])
  audio.currentTime = 34
  assert.equal(player.getPlaybackSnapshot().currentSong.hash, 'A')
  assert.equal(player.getPlaybackSnapshot().playbackState.currentTime, 34)
  const play = audio.play.bind(audio)
  audio.play = () => nextPlay.promise.then(play)
  nextUrl.resolve({ status: 1, url: 'https://example.test/B.wav' })
  await flush()
  assert.equal(audio.currentTime, 0)
  assert.equal(player.getPlaybackSnapshot().currentSong.hash, 'A')
  assert.equal(player.getPlaybackSnapshot().playbackState.currentTime, 34)
  assert.equal(player.getPlaybackSnapshot().playbackState.isPlaying, true)
  nextPlay.resolve()
  await pending
  assert.equal(player.getPlaybackSnapshot().currentSong.hash, 'B')
  assert.equal(player.getPlaybackSnapshot().playbackState.currentTime, 0)
})

test('native seek completion publishes a checkpoint for media controls and ignores source replacement', async t => {
  const { player, audio, emitted } = createPlayer(t)
  await player.requestSong(song('A'))
  audio.currentTime = 57
  player.handleSeeked()
  assert.equal(player.currentTime, 57)
  assert.equal(emitted.filter(event => event.name === 'playback-state-changed').length, 1)
  player.isLoadingSong = true
  audio.currentTime = 0
  player.handleSeeked()
  assert.equal(emitted.filter(event => event.name === 'playback-state-changed').length, 1)
})

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

test('shuffle skips a failed candidate instead of retrying it on next, previous and natural end', async t => {
  for (const direction of ['next', 'previous', 'ended']) {
    for (const failure of ['url', 'play']) {
      const urls = []
      const failedHash = direction === 'previous' ? 'D' : 'B'
      const { player, audio } = createPlayer(t, {
        getSongUrl: async hash => {
          urls.push(hash)
          return failure === 'url' && hash === failedHash ? { status: 0 }
            : { status: 1, url: `https://example.test/${hash}.mp3` }
        }
      })
      player.playlist = ['A', 'B', 'C', 'D'].map(song)
      await player.requestSong(player.playlist[0])
      player.playMode = 'shuffle'
      player.shuffledPlaylist = [...player.playlist]
      player.waitForDelay = async () => true
      const play = audio.play.bind(audio)
      audio.play = () => failure === 'play' && audio.src.endsWith(`/${failedHash}.mp3`)
        ? Promise.reject(new Error('Unavailable audio')) : play()
      if (direction === 'ended') {
        audio.ended = true
        audio.paused = true
        player.handleEnded()
        await flush()
      } else if (direction === 'previous') await player.playPrevious()
      else await player.playNext()
      assert.equal(player.currentSong.hash, 'C', `${direction}/${failure}`)
      assert.deepEqual(urls, ['A', failedHash, 'C'])
      assert.equal(player.isSwitchingSong, false)
    }
  }
})

test('a new selection cancels outstanding detail and URL waits without waiting for their response', async t => {
  for (const stage of ['detail', 'url']) {
    const stale = deferred()
    const { player, audio } = createPlayer(t, {
      getSongDetail: () => stale.promise,
      getSongUrl: hash => stage === 'url' && hash === 'A' ? stale.promise
        : Promise.resolve({ status: 1, url: `https://example.test/${hash}.mp3` })
    })
    player.playlist = [stage === 'detail' ? { hash: 'A', name: 'A' } : song('A'), song('B')]
    const loading = player.requestSong(player.playlist[0])
    player.requestSong(player.playlist[1])
    await loading
    await flush()
    assert.equal(player.currentSong.hash, 'B', stage)
    assert.equal(audio.src, 'https://example.test/B.mp3', stage)
    assert.equal(player.isLoadingSong, false)
    assert.equal(player.pendingTimers.size, 0)
    stale.reject(new Error('Late failed response'))
    await flush()
    assert.equal(player.currentSong.hash, 'B')
  }
})

test('navigation during a stalled load follows the latest target and releases the old lock', async t => {
  for (const stage of ['url', 'play']) {
    for (const direction of ['next', 'previous']) {
      const stale = deferred()
      const { player, audio } = createPlayer(t, {
        getSongUrl: hash => stage === 'url' && hash === 'B' ? stale.promise
          : Promise.resolve({ status: 1, url: `https://example.test/${hash}.mp3` })
      })
      player.playlist = ['A', 'B', 'C'].map(song)
      await player.requestSong(player.playlist[0])
      const play = audio.play.bind(audio)
      audio.play = () => stage === 'play' && audio.src.endsWith('/B.mp3') ? stale.promise.then(play) : play()
      const loading = player.requestSong(player.playlist[1])
      await flush()
      if (direction === 'next') await player.playNext()
      else await player.playPrevious()
      await loading
      await flush()
      const expected = direction === 'next' ? 'C' : 'A'
      assert.equal(player.currentSong.hash, expected, `${stage}/${direction}`)
      assert.equal(player.trackTransition, direction === 'next' ? 'next' : 'select', 'returning to the committed song keeps its transition')
      assert.equal(player.isLoadingSong, false)
      assert.equal(player.isSwitchingSong, false)
      assert.equal(player.pendingTimers.size, 0)
      stale.resolve({ status: 1, url: 'https://example.test/B.mp3' })
      await flush()
      assert.equal(audio.src, `https://example.test/${expected}.mp3`)
    }
  }
})

test('rapid navigation supersedes an unfinished next-track play and preserves priority queue intent', async t => {
  const stale = deferred()
  const { state, getPlayer, audioElements } = mountPlayer(t, ['A', 'B', 'C', 'D'].map(song))
  await flush()
  const player = getPlayer()
  const audio = audioElements[0]
  const play = audio.play.bind(audio)
  audio.play = () => audio.src.endsWith('/B.mp3') ? stale.promise.then(play) : play()
  const loading = player.playNext()
  await flush()
  player.playNextQueue = [state.playlist[3]]
  await player.playNext()
  await loading
  await flush()
  assert.equal(state.song.hash, 'D')
  assert.equal(player.currentIndex, 3)
  assert.equal(player.trackTransition, 'next')
  assert.equal(player.isSwitchingSong, false)
  assert.equal(player.isLoadingSong, false)
  stale.resolve()
  await flush()
  assert.equal(audio.src, 'https://example.test/D.mp3')
})

test('busy external priority navigation cannot override a later stop, selection or priority request', async t => {
  for (const action of ['stop', 'select', 'next']) {
    const stale = deferred()
    const { state, getPlayer, audioElements } = mountPlayer(t, ['A', 'B', 'C'].map(song), {
      getSongUrl: hash => hash === 'B' ? stale.promise
        : Promise.resolve({ status: 1, url: `https://example.test/${hash}.mp3` })
    })
    await flush()
    const player = getPlayer()
    const loading = player.requestSong(state.playlist[1])
    await flush()
    player.playNextQueue = [song('D'), song('E')]
    const next = player.playNext()
    if (action === 'stop') player.stopPlayback()
    else if (action === 'select') state.song = state.playlist[2]
    else player.playNext()
    await next
    await loading
    await flush()
    const expected = action === 'stop' ? null : action === 'select' ? 'C' : 'E'
    assert.equal(player.currentSong?.hash ?? null, expected, action)
    assert.equal(audioElements[0].src, expected ? `https://example.test/${expected}.mp3` : '')
    assert.equal(player.isLoadingSong, false)
    assert.equal(player.isSwitchingSong, false)
    stale.resolve({ status: 1, url: 'https://example.test/B.mp3' })
    await flush()
    assert.equal(player.currentSong?.hash ?? null, expected)
  }
})

test('queued navigation skips unavailable successors and keeps the index aligned with the retained song', async t => {
  for (const mode of ['loop', 'shuffle']) {
    for (const direction of ['next', 'previous']) {
      for (const playable of [true, false]) {
        const stale = deferred()
        const requests = []
        const songs = (direction === 'next' ? ['A', 'B', 'C', 'D', 'E'] : ['A', 'E', 'C', 'B', 'D']).map(song)
        const { state, getPlayer } = mountPlayer(t, songs, {
          getSongUrl: hash => {
            requests.push(hash)
            if (hash === 'B') return stale.promise
            return Promise.resolve(hash === 'A' || (playable && hash === 'E')
              ? { status: 1, url: `https://example.test/${hash}.mp3` } : { status: 0 })
          }
        })
        await flush()
        const player = getPlayer()
        player.playMode = mode
        player.shuffledPlaylist = [...songs]
        state.song = songs.find(item => item.hash === 'B')
        await flush()
        if (direction === 'next') await player.playNext()
        else await player.playPrevious()
        await flush()
        assert.equal(player.currentSong.hash, playable ? 'E' : 'A', `${mode}/${direction}/${playable}`)
        assert.equal(state.song.hash, player.currentSong.hash, 'the parent session follows the song that actually survived')
        assert.equal(player.currentIndex, player.playlist.findIndex(item => item.hash === player.currentSong.hash))
        assert.equal(requests.filter(hash => hash === 'C').length, 1)
        assert.equal(requests.filter(hash => hash === 'D').length <= 1, true)
        stale.resolve({ status: 1, url: 'https://example.test/B.mp3' })
      }
    }
  }
})

test('the old source ending cannot skip a different song already selected or loading next', async t => {
  for (const source of ['selection', 'next']) {
    const stale = deferred()
    const requests = []
    const { state, getPlayer, audioElements } = mountPlayer(t, ['A', 'B', 'C'].map(song), {
      getSongUrl: hash => {
        requests.push(hash)
        return hash === 'B' ? stale.promise : Promise.resolve({ status: 1, url: `https://example.test/${hash}.mp3` })
      }
    })
    await flush()
    const player = getPlayer()
    if (source === 'selection') state.song = state.playlist[1]
    else player.playNext()
    await flush()
    audioElements[0].ended = true
    player.handleEnded()
    await flush()
    assert.deepEqual(requests, ['A', 'B'], source)
    stale.resolve({ status: 1, url: 'https://example.test/B.mp3' })
    await flush()
    assert.equal(player.currentSong.hash, 'B')
    assert.equal(state.song.hash, 'B')
  }
})

test('playback timeout restores the committed source and releases pending operations', async t => {
  const timers = new Map()
  let nextTimer = 0
  const stale = deferred()
  const { player, audio } = createPlayer(t, {
    setTimeout: (callback, milliseconds) => {
      const id = ++nextTimer
      timers.set(id, { callback, milliseconds })
      return id
    },
    clearTimeout: id => timers.delete(id)
  })
  player.playlist = ['A', 'B', 'C'].map(song)
  await player.requestSong(player.playlist[0])
  await flush()
  audio.currentTime = player.currentTime = 42
  const play = audio.play.bind(audio)
  audio.play = () => audio.src.endsWith('/B.mp3') ? stale.promise.then(play) : play()
  const loading = player.requestSong(player.playlist[1])
  await flush()
  const timeout = [...timers.values()].find(timer => timer.milliseconds === 15000)
  assert.ok(timeout, 'playback has a bounded wait')
  timeout.callback()
  assert.equal(await loading, false)
  assert.equal(player.currentSong.hash, 'A')
  assert.equal(audio.currentTime, 42)
  assert.equal(player.isLoadingSong, false)
  assert.equal(player.pendingTimers.size, 0)
  await player.requestSong(player.playlist[2])
  stale.resolve()
  await flush()
  assert.equal(player.currentSong.hash, 'C')
  assert.equal(audio.src, 'https://example.test/C.mp3')
})

test('stop and unmount release a stalled play immediately and ignore its late completion', async t => {
  for (const action of ['stop', 'unmount']) {
    const stale = deferred()
    const { player, audio, component } = createPlayer(t)
    player.playlist = ['A', 'B', 'C'].map(song)
    await player.requestSong(player.playlist[0])
    const play = audio.play.bind(audio)
    audio.play = () => audio.src.endsWith('/B.mp3') ? stale.promise.then(play) : play()
    const loading = player.playNext()
    await flush()
    if (action === 'stop') player.stopPlayback()
    else component.beforeUnmount.call(player)
    await loading
    assert.equal(player.isLoadingSong, false, action)
    assert.equal(player.isSwitchingSong, false, action)
    assert.equal(player.pendingTimers.size, 0)
    stale.resolve()
    await flush()
    assert.equal(audio.paused, true)
    assert.equal(audio.src, '')
    if (action === 'stop') {
      await player.requestSong(player.playlist[2])
      assert.equal(player.currentSong.hash, 'C')
    }
  }
})

test('direct selection and navigation commit the transition belonging to the successful operation', async t => {
  const { player } = createPlayer(t)
  player.playlist = ['A', 'B', 'C'].map(song)
  await player.requestSong(player.playlist[1])
  assert.equal(player.currentSong.hash, 'B')
  assert.equal(player.trackTransition, 'select')

  await player.playNext({ type: 'click' })
  assert.equal(player.currentSong.hash, 'C')
  assert.equal(player.trackTransition, 'next')

  await player.playPrevious()
  assert.equal(player.currentSong.hash, 'B')
  assert.equal(player.trackTransition, 'previous')

  await player.handlePlaylistPlay(player.playlist[0])
  assert.equal(player.currentSong.hash, 'A')
  assert.equal(player.trackTransition, 'select')

  await player.handleRemoveSong(0)
  assert.equal(player.currentSong.hash, 'B')
  assert.equal(player.trackTransition, 'next')
})

test('shuffle, automatic advance and priority queue playback retain their distinct transition intent', async t => {
  const { player, audio } = createPlayer(t)
  player.playlist = ['A', 'B', 'C'].map(song)
  await player.requestSong(player.playlist[0])
  player.playMode = 'shuffle'
  player.shuffledPlaylist = [player.playlist[0], player.playlist[2], player.playlist[1]]

  await player.playNext({ type: 'click' })
  assert.equal(player.currentSong.hash, 'C')
  assert.equal(player.trackTransition, 'shuffle')

  await player.playPrevious()
  assert.equal(player.currentSong.hash, 'A')
  assert.equal(player.trackTransition, 'previous')

  audio.currentTime = audio.duration
  audio.ended = true
  audio.paused = true
  player.handleEnded()
  await flush()
  assert.equal(player.currentSong.hash, 'C')
  assert.equal(player.trackTransition, 'auto')

  player.playNextQueue = [player.playlist[1]]
  await player.playNext()
  assert.equal(player.currentSong.hash, 'B')
  assert.equal(player.trackTransition, 'next')

  player.playNextQueue = [player.playlist[0]]
  audio.currentTime = audio.duration
  audio.ended = true
  audio.paused = true
  player.handleEnded()
  await flush()
  assert.equal(player.currentSong.hash, 'A')
  assert.equal(player.trackTransition, 'auto')
})

test('a parent selection supersedes loading navigation together with its transition intent', async t => {
  const pendingNext = deferred()
  const { state, getPlayer } = mountPlayer(t, ['A', 'B', 'C'].map(song), {
    getSongUrl: hash => hash === 'B' ? pendingNext.promise : Promise.resolve({ status: 1, url: `https://example.test/${hash}.mp3` })
  })
  await flush()
  const player = getPlayer()
  const navigation = player.playNext()
  assert.equal(player.isSwitchingSong, true)
  assert.equal(player.currentSong.hash, 'A')
  state.song = state.playlist[2]
  await nextTick()
  pendingNext.resolve({ status: 1, url: 'https://example.test/B.mp3' })
  await navigation
  await flush()
  assert.equal(player.currentSong.hash, 'C')
  assert.equal(state.song.hash, 'C')
  assert.equal(player.$refs.audioPlayer.src, 'https://example.test/C.mp3')
  assert.equal(player.trackTransition, 'select')
})

test('a pending selection keeps its transition when a later request replaces the queued song', async t => {
  const { player } = createPlayer(t)
  player.playlist = ['A', 'B'].map(song)
  player.isComponentReady = false
  await player.requestSong(player.playlist[0], 'previous')
  await player.requestSong(player.playlist[1], 'next')
  player.isComponentReady = true
  await player.drainPendingSong()
  assert.equal(player.currentSong.hash, 'B')
  assert.equal(player.trackTransition, 'next')
})

test('failed URL and audio playback leave the visible song and its transition unchanged', async t => {
  for (const failure of ['url', 'play']) {
    const { player, audio, emitted } = createPlayer(t, {
      getSongUrl: async hash => failure === 'url' && hash === 'C'
        ? { status: 0, error_msg: 'Unavailable test song' }
        : { status: 1, url: `https://example.test/${hash}.mp3` }
    })
    player.playlist = ['A', 'B', 'C'].map(song)
    await player.requestSong(player.playlist[0])
    await player.playNext()
    const play = audio.play
    audio.play = async function () {
      if (failure === 'play' && this.src.endsWith('/C.mp3')) throw new Error('Test audio playback failure')
      return play.call(this)
    }

    assert.equal(await player.requestSong(player.playlist[2]), false)
    assert.equal(player.currentSong.hash, 'B', failure)
    assert.equal(audio.src, 'https://example.test/B.mp3', failure)
    assert.equal(player.trackTransition, 'next', failure)
    assert.deepEqual(emitted.filter(event => event.name === 'song-changed').map(event => event.value.hash), ['A', 'B'])
  }
})

test('a superseded playback restores the committed source when the latest parent selection fails', async t => {
  for (const outcome of ['resolve', 'reject']) {
    const playback = deferred()
    const { state, getPlayer, audioElements } = mountPlayer(t,
      ['A', 'B', 'C'].map(hash => ({ ...song(hash), cover: `${hash}.png` })), {
        getSongUrl: async hash => hash === 'C'
          ? { status: 0, error_code: 'TEST_UNAVAILABLE' }
          : { status: 1, url: `https://example.test/${hash}.mp3` }
      })
    await flush()
    const player = getPlayer()
    const audio = audioElements[0]
    audio.currentTime = player.currentTime = 31
    player.duration = 180
    player.trackTransition = 'previous'
    const play = audio.play.bind(audio)
    audio.play = () => audio.src.endsWith('/B.mp3') ? playback.promise.then(play) : play()
    state.song = state.playlist[1]
    await flush()
    assert.equal(audio.src, 'https://example.test/B.mp3')
    assert.equal(player.currentSong.hash, 'A')
    audio.currentTime = 0
    audio.duration = 222
    player.handleTimeUpdate()
    state.song = state.playlist[2]
    await nextTick()
    if (outcome === 'resolve') playback.resolve()
    else playback.reject(new Error('Superseded playback failed'))
    await flush()

    assert.equal(audio.src, 'https://example.test/A.mp3', outcome)
    assert.equal(player.loadedSongHash, 'A', outcome)
    assert.equal(player.currentSong.name, 'A', outcome)
    assert.equal(player.currentSong.cover, 'A.png', outcome)
    assert.equal(player.currentLyrics, '[00:00.00]A', outcome)
    assert.equal(player.trackTransition, 'previous', outcome)
    assert.equal(audio.currentTime, 31, outcome)
    assert.equal(player.currentTime, 31, outcome)
    assert.equal(player.duration, 180, outcome)
    assert.equal(state.song.hash, 'A', 'the parent session must retain the song that actually survived')
    assert.equal(audio.paused, false, outcome)
  }
})

test('a failed successor cannot use a superseded uncommitted source as its rollback song', async t => {
  const playback = deferred()
  const { player, audio, emitted } = createPlayer(t)
  player.playlist = ['A', 'B', 'C'].map(song)
  await player.requestSong(player.playlist[0])
  await flush()
  const play = audio.play.bind(audio)
  audio.play = () => {
    if (audio.src.endsWith('/B.mp3')) return playback.promise.then(play)
    if (audio.src.endsWith('/C.mp3')) return Promise.reject(new Error('Successor playback failed'))
    return play()
  }
  const loading = player.requestSong(player.playlist[1])
  await flush()
  await player.requestSong(player.playlist[2])
  playback.resolve()
  await loading
  await flush()
  assert.equal(audio.src, 'https://example.test/A.mp3')
  assert.equal(player.loadedSongHash, 'A')
  assert.equal(player.currentSong.hash, 'A')
  assert.equal(player.currentLyrics, '[00:00.00]A')
  assert.deepEqual(emitted.filter(event => event.name === 'song-changed').map(event => event.value.hash), ['A'])
})

test('selection during source restoration keeps the latest request and its transition', async t => {
  const restoration = deferred()
  const urls = []
  const { state, getPlayer, audioElements } = mountPlayer(t, ['A', 'B', 'C', 'D'].map(song), {
    getSongUrl: async hash => { urls.push(hash); return { status: 1, url: `https://example.test/${hash}.mp3` } }
  })
  await flush()
  const player = getPlayer()
  const audio = audioElements[0]
  const play = audio.play.bind(audio)
  audio.play = () => {
    if (audio.src.endsWith('/B.mp3')) return Promise.reject(new Error('Playback failed'))
    return audio.src.endsWith('/A.mp3') ? restoration.promise.then(play) : play()
  }
  state.song = state.playlist[1]
  await flush()
  assert.equal(audio.src, 'https://example.test/A.mp3')
  state.song = state.playlist[2]
  await nextTick()
  player.requestSong(state.playlist[3], 'next')
  restoration.resolve()
  await flush()
  assert.deepEqual(urls, ['A', 'B', 'D'])
  assert.equal(player.currentSong.hash, 'D')
  assert.equal(state.song.hash, 'D')
  assert.equal(audio.src, 'https://example.test/D.mp3')
  assert.equal(player.trackTransition, 'next')
})

test('rollback preserves the position and paused state immediately before source replacement', async t => {
  const url = deferred()
  const { player, audio } = createPlayer(t, {
    getSongUrl: hash => hash === 'B' ? url.promise : Promise.resolve({ status: 1, url: `https://example.test/${hash}.mp3` })
  })
  player.playlist = ['A', 'B'].map(song)
  await player.requestSong(player.playlist[0])
  audio.currentTime = player.currentTime = 10
  const loading = player.requestSong(player.playlist[1])
  audio.currentTime = player.currentTime = 37
  audio.pause()
  const play = audio.play.bind(audio)
  audio.play = () => audio.src.endsWith('/B.mp3') ? Promise.reject(new Error('Playback failed')) : play()
  url.resolve({ status: 1, url: 'https://example.test/B.mp3' })
  assert.equal(await loading, false)
  assert.equal(audio.src, 'https://example.test/A.mp3')
  assert.equal(audio.currentTime, 37)
  assert.equal(player.currentTime, 37)
  assert.equal(audio.paused, true)
  assert.equal(player.isPlaying, false)
})

test('rapid next presses reach the latest song without waiting for candidate or rollback playback', async t => {
  const stale = deferred()
  const restoration = deferred()
  const urls = []
  const { state, getPlayer, audioElements } = mountPlayer(t, ['A', 'B', 'C', 'D'].map(song), {
    getSongUrl: async hash => { urls.push(hash); return { status: 1, url: `https://example.test/${hash}.mp3` } }
  })
  await flush()
  const player = getPlayer()
  const audio = audioElements[0]
  audio.currentTime = player.currentTime = 42
  const play = audio.play.bind(audio)
  audio.play = () => {
    if (audio.src.endsWith('/B.mp3')) return stale.promise.then(play)
    if (audio.src.endsWith('/A.mp3')) return restoration.promise.then(play)
    return play()
  }
  const first = player.playNext()
  await flush()
  player.playNext()
  player.playNext()
  await flush()
  assert.deepEqual(urls, ['A', 'B', 'D'])
  assert.equal(player.currentSong.hash, 'D')
  assert.equal(state.song.hash, 'D')
  assert.equal(audio.currentTime, 0, 'a new track cannot inherit an unfinished rollback seek')
  assert.equal(player.isLoadingSong, false)
  assert.equal(player.isSwitchingSong, false)
  assert.equal(player.pendingTimers.size, 0)
  await first
  restoration.resolve()
  stale.reject(new Error('Obsolete candidate failed'))
  await flush()
  assert.equal(audio.src, 'https://example.test/D.mp3')
  assert.equal(player.currentSong.hash, 'D')
})

test('a selection interrupts an already waiting rollback without reporting a restoration failure', async t => {
  const restoration = deferred()
  const errors = []
  const { player, audio } = createPlayer(t, { logger: { ...quietLogger, error: (...args) => errors.push(args) } })
  player.playlist = ['A', 'B', 'C', 'D'].map(song)
  await player.requestSong(player.playlist[0])
  const play = audio.play.bind(audio)
  audio.play = () => {
    if (audio.src.endsWith('/B.mp3')) return Promise.reject(new Error('Candidate failed'))
    if (audio.src.endsWith('/A.mp3')) return restoration.promise.then(play)
    return play()
  }
  const first = player.requestSong(player.playlist[1])
  await flush()
  assert.equal(player.isLoadingSong, true)
  assert.equal(audio.src, 'https://example.test/A.mp3')
  player.requestSong(player.playlist[2])
  player.requestSong(player.playlist[3], 'next')
  await flush()
  assert.equal(player.currentSong.hash, 'D')
  assert.equal(player.trackTransition, 'next')
  assert.equal(player.pendingTimers.size, 0)
  assert.equal(errors.some(args => args.includes('恢复上一首歌曲失败:')), false)
  await first
  restoration.reject(new Error('Obsolete restoration failed'))
  await flush()
  assert.equal(audio.src, 'https://example.test/D.mp3')
  assert.equal(audio.paused, false)
})

test('an interrupted rollback retains confirmed time and play intent when the latest URL or media fails', async t => {
  for (const failure of ['url', 'media']) {
    for (const wasPlaying of [true, false]) {
      const stale = deferred()
      const restoration = deferred()
      const { player, audio } = createPlayer(t, {
        getSongUrl: async hash => hash === 'D' && failure === 'url' ? { status: 0 }
          : { status: 1, url: `https://example.test/${hash}.mp3` }
      })
      qualityAudio(audio, player)
      player.playlist = ['A', 'B', 'D'].map(song)
      await player.requestSong(player.playlist[0])
      await flush()
      audio.currentTime = player.currentTime = 42
      if (!wasPlaying) audio.pause()
      const play = audio.play.bind(audio)
      let restores = 0
      audio.play = () => {
        if (audio.src.endsWith('/B.mp3')) return stale.promise
        if (audio.src.endsWith('/D.mp3')) return Promise.reject(new Error('Latest candidate failed'))
        if (++restores === 1) return restoration.promise
        return play()
      }
      player.requestSong(player.playlist[1])
      await flush()
      player.requestSong(player.playlist[2])
      await flush()
      assert.equal(player.isLoadingSong, false, `${failure}/${wasPlaying}`)
      assert.equal(audio.src, 'https://example.test/A.mp3')
      assert.equal(player.currentSong.hash, 'A')
      assert.equal(audio.currentTime, 42)
      assert.equal(audio.paused, !wasPlaying)
      assert.equal(player.getPlaybackSnapshot().playbackState.isPlaying, wasPlaying)
      assert.equal(player.replacingPlaybackSnapshot, null)
      assert.equal(player.pendingTimers.size, 0)
      stale.reject(new Error('Obsolete candidate failed'))
      restoration.resolve()
      await flush()
      assert.equal(audio.src, 'https://example.test/A.mp3')
    }
  }
})

test('a restored source uses its latest position and user pause while a successor URL is pending', async t => {
  for (const failure of ['url', 'media']) {
    const stale = deferred()
    const restoration = deferred()
    const successor = deferred()
    const { player, audio } = createPlayer(t, {
      getSongUrl: hash => hash === 'C' ? successor.promise
        : Promise.resolve({ status: 1, url: `https://example.test/${hash}.mp3` })
    })
    qualityAudio(audio, player)
    player.playlist = ['A', 'B', 'C'].map(song)
    await player.requestSong(player.playlist[0])
    audio.currentTime = player.currentTime = 42
    const play = audio.play.bind(audio)
    audio.play = () => {
      if (audio.src.endsWith('/B.mp3')) return stale.promise
      if (audio.src.endsWith('/A.mp3')) return restoration.promise.then(play)
      return Promise.reject(new Error('Successor playback failed'))
    }
    player.requestSong(player.playlist[1])
    await flush()
    player.requestSong(player.playlist[2])
    await flush()
    assert.equal(player.getPlaybackSnapshot().playbackState.currentTime, 42)
    restoration.resolve()
    await flush()
    assert.equal(player.replacingPlaybackSnapshot, null)
    audio.currentTime = player.currentTime = 50
    player.togglePlay()
    assert.equal(audio.paused, true)
    assert.equal(player.getPlaybackSnapshot().playbackState.currentTime, 50)
    assert.equal(player.getPlaybackSnapshot().playbackState.isPlaying, false)
    successor.resolve(failure === 'url' ? { status: 0 } : { status: 1, url: 'https://example.test/C.mp3' })
    await flush()
    assert.equal(player.currentSong.hash, 'A')
    assert.equal(audio.currentTime, 50)
    assert.equal(audio.paused, true)
    assert.equal(player.pendingTimers.size, 0)
    stale.reject(new Error('Obsolete candidate failed'))
    await flush()
  }
})

test('stopping between rollback and draining the next song discards the inherited source snapshot', async t => {
  const stale = deferred()
  const { player, audio } = createPlayer(t, {
    getSongUrl: async hash => hash === 'C' ? { status: 0 } : { status: 1, url: `https://example.test/${hash}.mp3` }
  })
  player.playlist = ['A', 'B', 'C'].map(song)
  await player.requestSong(player.playlist[0])
  await flush()
  audio.play = () => stale.promise
  player.requestSong(player.playlist[1])
  await flush()
  const callbacks = []
  player.$nextTick = callback => { callbacks.push(callback); return Promise.resolve() }
  player.requestSong(player.playlist[2])
  await flush()
  assert.equal(player.replacingPlaybackSnapshot.hash, 'A')
  player.stopPlayback()
  assert.equal(player.replacingPlaybackSnapshot, null)
  await player.requestSong(player.playlist[2])
  assert.equal(audio.src, '')
  assert.equal(player.currentSong, null)
  assert.equal(player.loadedSongHash, null)
  assert.equal(player.pendingTimers.size, 0)
  callbacks.forEach(callback => callback?.())
  stale.reject(new Error('Stopped candidate failed'))
  await flush()
  assert.equal(audio.src, '')
})

test('Vue rollback snapshots release after playback resumes or a paused source is restored', async t => {
  for (const wasPlaying of [true, false]) {
    const stale = deferred()
    const successor = deferred()
    const { state, getPlayer, audioElements } = mountPlayer(t, ['A', 'B', 'C'].map(song), {
      getSongUrl: hash => hash === 'C' ? successor.promise
        : Promise.resolve({ status: 1, url: `https://example.test/${hash}.mp3` })
    })
    await flush()
    const player = getPlayer()
    const audio = audioElements[0]
    audio.currentTime = player.currentTime = 42
    if (!wasPlaying) audio.pause()
    const play = audio.play.bind(audio)
    audio.play = () => audio.src.endsWith('/B.mp3') ? stale.promise : play()
    state.song = state.playlist[1]
    await flush()
    state.song = state.playlist[2]
    await flush()
    assert.equal(player.replacingPlaybackSnapshot, null, String(wasPlaying))
    audio.currentTime = player.currentTime = 70
    if (wasPlaying) player.togglePlay()
    assert.equal(player.getPlaybackSnapshot().playbackState.currentTime, 70)
    assert.equal(player.getPlaybackSnapshot().playbackState.isPlaying, false)
    successor.resolve({ status: 0 })
    await flush()
    assert.equal(audio.currentTime, 70)
    assert.equal(audio.paused, true)
    assert.equal(state.song.hash, 'A')
    stale.reject(new Error('Obsolete playback failed'))
    await flush()
  }
})

test('selection, stop and unmount abort outstanding song HTTP work at both request stages', async t => {
  for (const stage of ['detail', 'url']) {
    for (const action of ['select', 'stop', 'unmount']) {
      const stale = deferred()
      let signal
      const { component, player } = createPlayer(t, {
        getSongDetail: (hash, options) => { signal = options.signal; return stale.promise },
        getSongUrl: (hash, albumId, audioId, quality, options) => {
          if (hash === 'A') { signal = options.signal; return stale.promise }
          return Promise.resolve({ status: 1, url: `https://example.test/${hash}.mp3` })
        }
      })
      player.playlist = [stage === 'detail' ? { hash: 'A' } : song('A'), song('B')]
      const first = player.requestSong(player.playlist[0])
      assert.equal(signal.aborted, false)
      if (action === 'select') player.requestSong(player.playlist[1])
      else if (action === 'stop') player.stopPlayback()
      else component.beforeUnmount.call(player)
      assert.equal(signal.aborted, true, `${stage}/${action}`)
      await first
      await flush()
      assert.equal(player.songAbortController, null)
      assert.equal(player.pendingTimers.size, 0)
      if (action === 'select') assert.equal(player.currentSong.hash, 'B')
      stale.reject(new Error('Obsolete response failed'))
      await flush()
    }
  }
})

test('navigation skips unavailable songs without a fixed retry delay', async t => {
  for (const direction of ['next', 'previous']) {
    const delays = []
    const { player } = createPlayer(t, {
      setTimeout: (callback, delay) => { delays.push(delay); return setTimeout(callback, delay) },
      getSongUrl: async hash => ['B', 'D'].includes(hash) ? { status: 0 }
        : { status: 1, url: `https://example.test/${hash}.mp3` }
    })
    player.playlist = ['A', 'B', 'C', 'D'].map(song)
    await player.requestSong(player.playlist[0])
    if (direction === 'next') await player.playNext()
    else await player.playPrevious()
    assert.equal(player.currentSong.hash, 'C', direction)
    assert.equal(delays.some(delay => delay === 300 || delay === 500), false)
  }
})

test('a superseded first playback clears its source if the next selection also fails', async t => {
  const playback = deferred()
  const { player, audio } = createPlayer(t, {
    getSongUrl: async hash => hash === 'B' ? { status: 0 } : { status: 1, url: `https://example.test/${hash}.mp3` }
  })
  player.playlist = ['A', 'B'].map(song)
  const play = audio.play.bind(audio)
  audio.play = () => playback.promise.then(play)
  const loading = player.requestSong(player.playlist[0])
  await flush()
  await player.requestSong(player.playlist[1])
  playback.resolve()
  await loading
  await flush()
  assert.equal(player.currentSong, null)
  assert.equal(player.loadedSongHash, null)
  assert.equal(audio.src, '')
  assert.equal(audio.paused, true)
  assert.equal(player.isPlaying, false)
})

test('retaining a song after failure or replay reloads lyrics invalidated by the selection', async t => {
  for (const selection of ['A', 'B']) {
    const lyrics = deferred()
    const lyricRequests = []
    const { player } = createPlayer(t, {
      getSongUrl: async hash => hash === 'B' ? { status: 0 } : { status: 1, url: `https://example.test/${hash}.mp3` },
      getLyric: hash => {
        lyricRequests.push(hash)
        return lyricRequests.length === 1 ? lyrics.promise : Promise.resolve({ status: 1, decodeContent: `lyrics ${hash}` })
      }
    })
    player.playlist = ['A', 'B'].map(song)
    await player.requestSong(player.playlist[0])
    assert.equal(player.currentLyrics, '')
    await player.requestSong(player.playlist.find(item => item.hash === selection))
    await flush()
    lyrics.resolve({ status: 1, decodeContent: 'discarded old lyrics' })
    await flush()
    assert.equal(player.currentSong.hash, 'A', selection)
    assert.equal(player.currentLyrics, 'lyrics A', selection)
    assert.deepEqual(lyricRequests, ['A', 'A'])
    assert.equal(player.pendingTimers.size, 0, selection)
  }
})

test('stop and unmount cannot resurrect audio after pending playback or restoration settles', async t => {
  for (const stage of ['playback', 'restoration', 'replay']) {
    for (const action of ['stop', 'unmount']) {
      const playback = deferred()
      const { component, player, audio, emitted } = createPlayer(t)
      player.playlist = ['A', 'B'].map(song)
      await player.requestSong(player.playlist[0])
      await flush()
      if (stage === 'replay') audio.pause()
      const play = audio.play.bind(audio)
      audio.play = () => {
        if (stage === 'restoration' && audio.src.endsWith('/B.mp3')) return Promise.reject(new Error('Playback failed'))
        return playback.promise.then(play)
      }
      const loading = player.requestSong(player.playlist[stage === 'replay' ? 0 : 1])
      await flush()
      const eventCount = emitted.length
      if (action === 'stop') player.stopPlayback()
      else component.beforeUnmount.call(player)
      playback.resolve()
      await loading
      await flush()
      assert.equal(audio.src, '', `${stage}/${action}`)
      assert.equal(audio.paused, true, `${stage}/${action}`)
      assert.equal(player.isPlaying, false, `${stage}/${action}`)
      assert.equal(emitted.length, eventCount, `${stage}/${action}`)
    }
  }
})

test('stopping pending playback still allows a new selection after the old operation settles', async t => {
  for (const stage of ['playback', 'restoration', 'replay']) {
    const playback = deferred()
    const { player, audio, emitted } = createPlayer(t)
    player.playlist = ['A', 'B', 'C'].map(song)
    await player.requestSong(player.playlist[0])
    if (stage === 'replay') audio.pause()
    const play = audio.play.bind(audio)
    audio.play = () => {
      if (audio.src.endsWith('/C.mp3')) return play()
      if (stage === 'restoration' && audio.src.endsWith('/B.mp3')) return Promise.reject(new Error('Playback failed'))
      return playback.promise.then(play)
    }
    const loading = player.requestSong(player.playlist[stage === 'replay' ? 0 : 1])
    await flush()
    player.stopPlayback()
    await player.requestSong(player.playlist[2])
    playback.resolve()
    await loading
    await flush()
    assert.equal(player.currentSong.hash, 'C', stage)
    assert.equal(player.loadedSongHash, 'C', stage)
    assert.equal(audio.src, 'https://example.test/C.mp3', stage)
    assert.equal(audio.paused, false, stage)
    assert.deepEqual(emitted.filter(event => event.name === 'song-changed').map(event => event.value.hash), ['A', 'C'])
  }
})

test('a pending same-song replay cannot pause or overwrite a later successful selection', async t => {
  const replay = deferred()
  const { player, audio } = createPlayer(t)
  player.playlist = ['A', 'B'].map(song)
  await player.requestSong(player.playlist[0])
  audio.pause()
  const play = audio.play.bind(audio)
  audio.play = () => audio.src.endsWith('/A.mp3') ? replay.promise.then(play) : play()
  const loading = player.requestSong(player.playlist[0])
  await flush()
  await player.requestSong(player.playlist[1])
  replay.resolve()
  assert.equal(await loading, false)
  await flush()
  assert.equal(player.currentSong.hash, 'B')
  assert.equal(player.loadedSongHash, 'B')
  assert.equal(audio.src, 'https://example.test/B.mp3')
  assert.equal(audio.paused, false)
})

test('reselecting and repeating the active song do not restart its metadata transition', async t => {
  let requests = 0
  const { player, audio } = createPlayer(t, {
    getSongUrl: async hash => { requests++; return { status: 1, url: `https://example.test/${hash}.mp3` } }
  })
  player.playlist = ['A', 'B'].map(song)
  await player.requestSong(player.playlist[0])
  await player.playNext()
  audio.ended = true
  audio.paused = true
  audio.currentTime = audio.duration
  await player.handlePlaylistPlay(player.playlist[1])
  assert.equal(player.currentSong.hash, 'B')
  assert.equal(player.trackTransition, 'next')
  assert.equal(audio.currentTime, 0)
  assert.equal(requests, 2)

  player.playMode = 'single'
  audio.currentTime = audio.duration
  audio.ended = true
  audio.paused = true
  player.handleEnded()
  await flush()
  assert.equal(player.trackTransition, 'next')
  assert.equal(audio.currentTime, 0)
  assert.equal(requests, 2)
})

test('track transitions commit with the new song only after its URL and playback succeed', async t => {
  const url = deferred()
  const playback = deferred()
  const { player, audio, emitted } = createPlayer(t, { getSongUrl: () => url.promise })
  player.playlist = ['A', 'B'].map(song)
  player.currentSong = player.playlist[0]
  player.loadedSongHash = 'A'
  player.trackTransition = 'previous'
  audio.src = 'https://example.test/A.mp3'
  audio.play = () => playback.promise

  const loading = player.loadSong(player.playlist[1], 'next')
  assert.equal(player.trackTransition, 'previous')
  assert.equal(player.currentSong.hash, 'A')
  url.resolve({ status: 1, url: 'https://example.test/B.mp3' })
  await flush()
  assert.equal(player.trackTransition, 'previous')
  assert.equal(player.currentSong.hash, 'A')
  playback.resolve()
  assert.equal(await loading, true)
  assert.equal(player.trackTransition, 'next')
  assert.equal(player.currentSong.hash, 'B')
  assert.deepEqual(emitted.filter(event => event.name === 'song-changed').map(event => event.value.hash), ['B'])
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

test('previous restarts the confirmed source in the final ten seconds across modes and pause states', async t => {
  for (const mode of ['loop', 'single', 'shuffle']) {
    for (const paused of [false, true]) {
      for (const time of [170, 179.999, 180]) {
        let requests = 0
        const { player, audio, emitted } = createPlayer(t, {
          getSongUrl: async hash => { requests++; return { status: 1, url: `https://example.test/${hash}.mp3` } }
        })
        player.playlist = ['A', 'B', 'C'].map(song)
        await player.requestSong(player.playlist[1])
        await flush()
        player.playMode = mode
        player.shuffledPlaylist = [...player.playlist]
        player.playNextQueue = [player.playlist[2]]
        const lyrics = player.currentLyrics
        const source = audio.src
        const transition = player.trackTransition
        player.duration = 900
        player.currentTime = 0
        player.seekPreviewTime = 1
        audio.currentTime = time
        if (paused) audio.pause()
        const plays = audio.playCount
        const changes = emitted.filter(event => event.name === 'song-changed').length

        assert.equal(await player.playPrevious(), true)

        assert.equal(player.currentSong.hash, 'B', `${mode}/${paused}/${time}`)
        assert.equal(player.currentIndex, 1)
        assert.equal(audio.src, source)
        assert.equal(audio.currentTime, 0)
        assert.equal(player.currentTime, 0)
        assert.equal(audio.paused, false)
        assert.equal(audio.playCount, plays + (paused ? 1 : 0))
        assert.equal(requests, 1)
        assert.equal(player.currentLyrics, lyrics)
        assert.equal(player.isLyricPlaceholder, false)
        assert.equal(player.trackTransition, transition)
        assert.equal(player.playNextQueue[0].hash, 'C')
        assert.equal(emitted.filter(event => event.name === 'song-changed').length, changes)
        assert.ok(emitted.some(event => event.name === 'playback-state-changed'))
      }
    }
  }
})

test('previous keeps normal navigation outside the real final ten seconds or with unknown duration', async t => {
  for (const [duration, time] of [[180, 169.999], [0, 0], [NaN, 175], [Infinity, 175], [180, NaN], [180, 181]]) {
    const { player, audio } = createPlayer(t)
    player.playlist = ['A', 'B', 'C'].map(song)
    await player.requestSong(player.playlist[1])
    player.duration = 180
    player.seekPreviewTime = 175
    audio.duration = duration
    audio.currentTime = time
    await player.playPrevious()
    assert.equal(player.currentSong.hash, 'A', `${duration}/${time}`)
  }
})

test('previous on a short track follows the same remaining-time rule and a second press navigates after a normal restart', async t => {
  const { player, audio } = createPlayer(t)
  player.playlist = ['A', 'B'].map(song)
  await player.requestSong(player.playlist[1])
  audio.duration = 8
  audio.currentTime = 2
  await player.playPrevious()
  assert.equal(player.currentSong.hash, 'B')
  assert.equal(audio.currentTime, 0)
  audio.duration = 180
  audio.currentTime = 175
  await player.playPrevious()
  assert.equal(player.currentSong.hash, 'B')
  await player.playPrevious()
  assert.equal(player.currentSong.hash, 'A')
})

test('restart playback failure and cancellation retain the confirmed track and cannot revive a stopped source', async t => {
  for (const action of ['failure', 'stop', 'selection', 'previous']) {
    const gate = deferred()
    const { player, audio } = createPlayer(t)
    player.playlist = ['A', 'B', 'C'].map(song)
    await player.requestSong(player.playlist[1])
    audio.currentTime = 175
    audio.pause()
    const play = audio.play.bind(audio)
    audio.play = () => audio.src.endsWith('/B.mp3') ? gate.promise.then(play) : play()
    const restart = player.playPrevious()
    assert.equal(audio.currentTime, 0)
    if (action === 'failure') gate.reject(new Error('Audio device unavailable'))
    else if (action === 'stop') player.stopPlayback()
    else if (action === 'selection') player.requestSong(player.playlist[2])
    else player.playPrevious()
    await restart
    await flush()
    if (action === 'failure') {
      assert.equal(player.currentSong.hash, 'B')
      assert.equal(audio.paused, true)
    } else {
      gate.resolve()
      await flush()
      if (action === 'stop') {
        assert.equal(player.currentSong, null)
        assert.equal(audio.src, '')
        assert.equal(audio.paused, true)
      } else {
        assert.equal(player.currentSong.hash, action === 'selection' ? 'C' : 'A')
      }
    }
    assert.equal(player.isLoadingSong, false)
    assert.equal(player.pendingTimers.size, 0)
  }
})

test('a previous request during another song load navigates from that target without restarting the old final seconds', async t => {
  const waiting = deferred()
  const { player, audio } = createPlayer(t, {
    getSongUrl: hash => hash === 'B' ? waiting.promise : Promise.resolve({ status: 1, url: `https://example.test/${hash}.mp3` })
  })
  player.playlist = ['A', 'B', 'C'].map(song)
  await player.requestSong(player.playlist[0])
  audio.currentTime = 175
  const loading = player.requestSong(player.playlist[1])
  await player.playPrevious()
  await loading
  await flush()
  assert.equal(player.currentSong.hash, 'A')
  assert.equal(audio.currentTime, 175)
  assert.equal(player.isLoadingSong, false)
  waiting.resolve({ status: 1, url: 'https://example.test/B.mp3' })
  await flush()
  assert.equal(audio.currentTime, 175)
})

test('an old ended event cannot advance a restarted source while its asynchronous seek completes or afterward', async t => {
  for (const mode of ['loop', 'single', 'shuffle']) {
    let requests = 0
    const { player, audio } = createPlayer(t, {
      getSongUrl: async hash => { requests++; return { status: 1, url: `https://example.test/${hash}.mp3` } }
    })
    player.playlist = ['A', 'B', 'C'].map(song)
    await player.requestSong(player.playlist[0])
    player.playMode = mode
    player.shuffledPlaylist = [...player.playlist]
    let position = 180
    Object.defineProperty(audio, 'currentTime', {
      get: () => position,
      set(value) { position = value; audio.ended = false; audio.seeking = true }
    })
    audio.ended = true
    audio.paused = true
    const restart = player.playPrevious()
    assert.equal(audio.currentTime, 0)
    assert.equal(audio.seeking, true)
    player.handleEnded()
    await restart
    audio.seeking = false
    player.handleSeeked()
    player.handleEnded()
    await flush()
    assert.equal(player.currentSong.hash, 'A', mode)
    assert.equal(audio.currentTime, 0)
    assert.equal(requests, 1)
    assert.equal(audio.playCount, 2)
  }
})

test('only genuinely ended audio outside a seek continues through normal automatic playback', async t => {
  for (const mode of ['loop', 'single', 'shuffle']) {
    const { player, audio } = createPlayer(t)
    player.playlist = ['A', 'B', 'C'].map(song)
    await player.requestSong(player.playlist[0])
    player.playMode = mode
    player.shuffledPlaylist = [player.playlist[0], player.playlist[2], player.playlist[1]]
    audio.currentTime = audio.duration
    audio.paused = true
    audio.ended = true
    audio.seeking = true
    player.handleEnded()
    await flush()
    assert.equal(player.currentSong.hash, 'A', mode)
    audio.seeking = false
    player.handleEnded()
    await flush()
    assert.equal(player.currentSong.hash, mode === 'single' ? 'A' : mode === 'shuffle' ? 'C' : 'B', mode)
    if (mode === 'single') assert.equal(audio.currentTime, 0)
    else assert.equal(player.trackTransition, 'auto')
  }
})

test('player song search closes overlays and emits the original song without changing playback', async t => {
  const { player, audio, emitted } = createPlayer(t)
  player.playlist = ['A', 'B'].map(song)
  await player.requestSong(player.playlist[0])
  player.showLyricView = true
  player.showPlaylist = true
  audio.currentTime = 45
  const source = audio.src
  player.searchSong(player.playlist[1])
  assert.equal(player.showLyricView, false)
  assert.equal(player.showPlaylist, false)
  assert.equal(player.currentSong.hash, 'A')
  assert.equal(audio.src, source)
  assert.equal(audio.currentTime, 45)
  assert.equal(audio.paused, false)
  assert.equal(emitted.find(event => event.name === 'search').value, player.playlist[1])
})

for (const paused of [false, true]) {
  test(`artist navigation closes overlays and preserves ${paused ? 'paused' : 'playing'} audio and queue`, async t => {
    const { player, audio } = createPlayer(t)
    player.playlist = ['A', 'B'].map(song)
    await player.requestSong(player.playlist[0])
    if (paused) audio.pause()
    player.showLyricView = true
    player.pendingLyricView = true
    player.showPlaylist = true
    audio.currentTime = 45
    const queue = player.playlist
    const source = audio.src
    const count = audio.playCount
    const target = { id: 22, name: 'Second artist' }
    const navigations = []
    player.$emit = (...args) => navigations.push(args)
    const requestId = player.lyricViewRequestId
    player.openArtist(target)
    assert.equal(player.showLyricView, false)
    assert.equal(player.pendingLyricView, false)
    assert.equal(player.showPlaylist, false)
    assert.ok(player.lyricViewRequestId > requestId)
    assert.equal(player.currentSong.hash, 'A')
    assert.equal(player.playlist, queue)
    assert.equal(audio.src, source)
    assert.equal(audio.currentTime, 45)
    assert.equal(audio.paused, paused)
    assert.equal(audio.playCount, count)
    assert.deepEqual(navigations, [['navigate', 'artist', target]])
  })
}

test('only a successful real lyric response makes lyrics interactive and stale responses cannot replace defaults', async t => {
  const waiting = deferred()
  const { player } = createPlayer(t, { getLyric: hash => hash === 'A' ? waiting.promise : Promise.resolve({ status: 0 }) })
  assert.equal(player.isLyricPlaceholder, true)
  player.playlist = ['A', 'B'].map(song)
  await player.requestSong(player.playlist[0])
  assert.equal(player.isLyricPlaceholder, true)
  await player.requestSong(player.playlist[1])
  await flush()
  assert.equal(player.isLyricPlaceholder, true)
  waiting.resolve({ status: 1, decodeContent: '[00:01.00]Old real lyric' })
  await flush()
  assert.equal(player.isLyricPlaceholder, true)
  assert.match(player.currentLyrics, /无法获取歌词/)
  player.stopPlayback()
  assert.equal(player.isLyricPlaceholder, true)
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

test('lyric transition keys distinguish song changes and asynchronous lyric arrival', t => {
  const { lyric } = createLyric(t)
  lyric.lyrics = ''
  assert.equal(lyric.lyricContentKey, 'A:loading')
  lyric.lyrics = '[00:00.00]first'
  assert.equal(lyric.lyricContentKey, 'A:ready')
  lyric.lyrics = '[00:00.00]updated metadata'
  assert.equal(lyric.lyricContentKey, 'A:ready', 'parsing updated lyric data must retain the current layer')
  lyric.song = song('B')
  assert.equal(lyric.lyricContentKey, 'B:ready')
  lyric.lyrics = ''
  assert.equal(lyric.lyricContentKey, 'B:loading')
  lyric.song = null
  assert.equal(lyric.lyricContentKey, 'empty:loading')

  for (const type of ['select', 'previous', 'next', 'auto', 'shuffle']) {
    lyric.trackTransition = type
    assert.equal(lyric.trackTransitionName, `track-${type}`)
  }
  for (const type of [null, undefined, 'unknown', { type: 'click' }]) {
    lyric.trackTransition = type
    assert.equal(lyric.trackTransitionName, 'track-select')
  }
})

test('changing a lyric layer clears the previous track state and positions arriving lyrics at the latest time', async t => {
  const { component, lyric, setLine } = createLyric(t)
  lyric.lyrics = '[00:00.00]old\n[00:10.00]completed\n[00:40.00]next'
  component.watch.lyrics.handler.call(lyric, lyric.lyrics)
  const oldLine = setLine(1, 'completed', 500, 300)
  lyric.syncPlaybackTime(20)
  lyric.currentCharIndex = 4
  lyric.styleCache.set('old', { color: 'red' })
  lyric.lastProgressValues.set('old', 100)
  lyric.scrollingLyricElement = oldLine.innerText
  assert.equal(lyric.isBridgeActive, true)
  assert.equal(lyric.currentLyricIndex, 1)

  lyric.song = song('B')
  lyric.lyrics = ''
  lyric.currentPlayTime = 0
  component.watch.lyrics.handler.call(lyric, lyric.lyrics)
  component.watch.lyricContentKey.call(lyric)
  assert.equal(Object.keys(lyric.lyricLineRefs).length, 0)
  assert.equal(lyric.scrollingLyricElement, null)
  assert.equal(lyric.currentLyricIndex, 0)
  assert.equal(lyric.currentCharIndex, 0)
  assert.equal(lyric.lastPlaybackTime, null)
  assert.equal(lyric.lineTransitionDuration, 0)
  assert.equal(lyric.bridgeInfo, null)
  assert.equal(lyric.isBridgeActive, false)
  assert.equal(lyric.bridgeProgress, 0)
  assert.equal(lyric.styleCache.size, 0)
  assert.equal(lyric.lastProgressValues.size, 0)
  await flush()

  lyric.currentPlayTime = 15
  lyric.lyrics = '[00:00.00]first\n[00:10.00]ABCD\n[00:20.00]next'
  component.watch.lyrics.handler.call(lyric, lyric.lyrics)
  component.watch.lyricContentKey.call(lyric)
  const { characters } = setLine(1, 'ABCD')
  await flush()
  assert.equal(lyric.internalPlayTime, 15)
  assert.equal(lyric.currentLyricIndex, 1)
  assert.equal(lyric.lineTransitionDuration, 0, 'asynchronous lyrics start at their current position')
  assert.equal(lyric.isBridgeActive, false)
  assert.equal(characters[0].style.color, 'var(--lyric-accent)')
  assert.equal(characters[3].style.color, 'var(--lyric-pending)')
})

test('departing lyric refs cannot remove or replace the next song or its ready lyric layer', t => {
  const { component, lyric } = createLyric(t)
  lyric.lyrics = '[00:00.00]old'
  const oldRef = lyric.createLyricLineRef(0, lyric.lyricContentKey)
  const oldElement = { track: 'A' }
  oldRef(oldElement)
  assert.equal(lyric.lyricLineRefs[0], oldElement)

  lyric.song = song('B')
  lyric.lyrics = ''
  component.watch.lyricContentKey.call(lyric)
  const loadingRef = lyric.createLyricLineRef(0, lyric.lyricContentKey)
  const loadingElement = { track: 'B', phase: 'loading' }
  loadingRef(loadingElement)
  oldRef(null)
  oldRef(oldElement)
  assert.equal(lyric.lyricLineRefs[0], loadingElement)

  lyric.lyrics = '[00:00.00]new'
  component.watch.lyricContentKey.call(lyric)
  const readyRef = lyric.createLyricLineRef(0, lyric.lyricContentKey)
  const readyElement = { track: 'B', phase: 'ready' }
  readyRef(readyElement)
  loadingRef(null)
  loadingRef(loadingElement)
  oldRef(null)
  assert.equal(lyric.lyricLineRefs[0], readyElement)
  readyRef(null)
  assert.equal(lyric.lyricLineRefs[0], undefined, 'the active layer can still release its own refs')
  readyRef(readyElement)
  component.beforeUnmount.call(lyric)
  readyRef(readyElement)
  assert.equal(Object.keys(lyric.lyricLineRefs).length, 0, 'late callbacks cannot retain nodes after disposal')
})

test('rapid A to B to A transitions keep the newest A ref when the first A layer finishes leaving', t => {
  const { component, lyric } = createLyric(t)
  lyric.lyrics = '[00:00.00]A'
  const firstARef = lyric.createLyricLineRef(0, lyric.lyricContentKey)
  const firstAElement = { track: 'A', visit: 1 }
  firstARef(firstAElement)
  lyric.song = song('B')
  component.watch.lyricContentKey.call(lyric)
  const bRef = lyric.createLyricLineRef(0, lyric.lyricContentKey)
  bRef({ track: 'B' })

  lyric.song = song('A')
  component.watch.lyricContentKey.call(lyric)
  const newestARef = lyric.createLyricLineRef(0, lyric.lyricContentKey)
  const newestAElement = { track: 'A', visit: 2 }
  newestARef(newestAElement)
  firstARef(null)
  bRef(null)
  assert.equal(lyric.lyricLineRefs[0], newestAElement)
  newestARef(null)
  assert.equal(lyric.lyricLineRefs[0], undefined)
})

test('late cover failures affect only the current track and the image URL still being shown', t => {
  const { lyric } = createLyric(t)
  lyric.song = { ...song('B'), cover: 'https://example.test/{size}/B.jpg' }
  const currentUrl = lyric.coverUrl
  const coverError = (key, source) => ({
    target: { dataset: { trackKey: key }, getAttribute: name => name === 'src' ? source : null }
  })
  lyric.handleCoverError(coverError('A', currentUrl))
  assert.equal(lyric.coverFailed, false, 'departing covers cannot replace the current cover with a fallback')
  lyric.handleCoverError(coverError('B', 'https://example.test/400/old-B.jpg'))
  assert.equal(lyric.coverFailed, false, 'an earlier URL for the same track must be ignored')
  const retired = coverError('B', currentUrl)
  retired.target.closest = () => ({ inert: true })
  lyric.handleCoverError(retired)
  assert.equal(lyric.coverFailed, false, 'returning to the same hash and URL ignores the retired image')
  const disconnected = coverError('B', currentUrl)
  disconnected.target.isConnected = false
  lyric.handleCoverError(disconnected)
  assert.equal(lyric.coverFailed, false, 'a removed image cannot hide the fresh cover')
  lyric.handleCoverError(coverError('B', currentUrl))
  assert.equal(lyric.coverFailed, true)
  assert.equal(lyric.coverUrl, '')
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

/** Minimal bridge DOM records frame writes without tying the animation to Vue renders. */
function attachBridgeAnimationElements(lyric) {
  const particles = Array.from({ length: 21 }, () => ({ style: {} }))
  const aura = { style: {} }
  let queries = 0
  const element = {
    style: { setProperty(name, value) { this[name] = value } },
    querySelectorAll() { queries++; return particles },
    querySelector() { queries++; return aura }
  }
  lyric.$refs.bridgeIndicator = element
  return { element, particles, aura, get queries() { return queries } }
}

test('bridge animation reads live audio between public progress updates without publishing temporary sources', t => {
  const { player, audio } = createPlayer(t)
  player.currentTime = 20
  audio.currentTime = 20.035
  assert.equal(player.getAnimationPlaybackTime(), 20.035)
  assert.equal(player.currentTime, 20)
  audio.paused = true
  assert.equal(player.getAnimationPlaybackTime(), 20.035)
  for (const key of ['isLoadingSong', 'isReplacingQualitySource', 'replacingPlaybackSnapshot', 'isDisposed']) {
    player[key] = key === 'replacingPlaybackSnapshot' ? { time: 20 } : true
    audio.currentTime = 0
    assert.equal(player.getAnimationPlaybackTime(), 20, key)
    player[key] = false
  }
  audio.currentTime = NaN
  assert.equal(player.getAnimationPlaybackTime(), 20)
})

test('bridge particles advance on every existing RAF while lyric render time stays throttled', t => {
  const { component, lyric, frames } = createLyric(t)
  const nodes = attachBridgeAnimationElements(lyric)
  lyric.parsedLyrics = [{ time: 0, text: 'completed' }, { time: 40, text: 'next' }]
  lyric.currentPlayTime = 20
  let audioTime = 20
  lyric.readPlaybackTime = () => audioTime
  component.mounted.call(lyric)
  frames.step()
  const progress = lyric.bridgeProgress
  let previous = nodes.particles[10].style.transform
  for (let frame = 0; frame < 8; frame++) {
    audioTime += 1 / 60
    frames.step()
    assert.notEqual(nodes.particles[10].style.transform, previous)
    previous = nodes.particles[10].style.transform
    assert.equal(lyric.internalPlayTime, 20, 'the full lyric render must retain its public sampled time')
    assert.equal(lyric.bridgeProgress, progress)
  }
  assert.equal(nodes.queries, 2, 'bridge nodes must be reused instead of queried every frame')
  assert.equal(frames.callbacks.size, 1, 'the existing RAF must be the only animation loop')
  frames.step()
  assert.equal(nodes.particles[10].style.transform, previous, 'a stationary audio clock must freeze the choreography')
})

test('direct bridge frames retain local preview priority, cancellation and retired-layer isolation', t => {
  const { component, lyric, frames } = createLyric(t)
  const oldNodes = attachBridgeAnimationElements(lyric)
  lyric.parsedLyrics = [{ time: 0, text: 'completed' }, { time: 40, text: 'next' }]
  lyric.currentPlayTime = 20
  let audioTime = 20.1
  lyric.readPlaybackTime = () => audioTime
  component.mounted.call(lyric)
  frames.step()
  lyric.previewTime = 30
  frames.step()
  const external = oldNodes.particles[10].style.transform
  lyric.previewSeek({ target: { value: '35' } })
  const local = oldNodes.particles[10].style.transform
  assert.notEqual(local, external)
  audioTime = 21
  frames.step()
  assert.equal(oldNodes.particles[10].style.transform, local)
  lyric.cancelSeek()
  assert.equal(oldNodes.particles[10].style.transform, external)
  lyric.previewTime = null
  frames.step()
  assert.notEqual(oldNodes.particles[10].style.transform, external)
  const frozen = oldNodes.particles[10].style.transform
  lyric.pauseUpdates = true
  audioTime = 0
  frames.step()
  assert.equal(oldNodes.particles[10].style.transform, frozen)
  assert.equal(frames.callbacks.size, 0)
  const nextNodes = attachBridgeAnimationElements(lyric)
  lyric.pauseUpdates = false
  audioTime = 22
  lyric.startUpdateLoop()
  frames.step()
  assert.ok(nextNodes.particles[10].style.transform)
  assert.equal(oldNodes.particles[10].style.transform, frozen, 'a replaced bridge layer must never receive new writes')
})

test('reduced motion skips hidden bridge choreography and responds to preference changes', t => {
  const { component, lyric, frames, sandbox } = createLyric(t)
  const media = { matches: true }
  sandbox.window.matchMedia = () => media
  const nodes = attachBridgeAnimationElements(lyric)
  lyric.parsedLyrics = [{ time: 0, text: 'completed' }, { time: 40, text: 'next' }]
  lyric.currentPlayTime = 20
  lyric.readPlaybackTime = () => 20.05
  let calculations = 0
  const original = lyric.getBridgeParticles
  lyric.getBridgeParticles = motion => { calculations++; return original(motion) }
  component.mounted.call(lyric)
  frames.step()
  frames.step()
  assert.equal(calculations, 0)
  assert.equal(nodes.particles[0].style.transform, undefined)
  assert.equal(lyric.bridgeRemainingSeconds, 20)
  media.matches = false
  frames.step()
  assert.equal(calculations, 1)
  assert.ok(nodes.particles[0].style.transform)
  media.matches = true
  frames.step()
  assert.equal(calculations, 1)
})

test('bridge choreography stays frozen across paused animation frames and resumes from the playback position', t => {
  const { component, lyric, frames } = createLyric(t)
  lyric.parsedLyrics = [{ time: 0, text: 'completed' }, { time: 40, text: 'next' }]
  lyric.isPlaying = true
  lyric.currentPlayTime = 20
  component.mounted.call(lyric)
  frames.step()
  const motion = lyric.bridgeMotion
  const particles = lyric.bridgeParticles
  const remaining = lyric.bridgeRemainingSeconds
  lyric.isPlaying = false
  for (let count = 0; count < 4; count++) frames.step()
  assert.deepEqual(lyric.bridgeMotion, motion)
  assert.deepEqual(lyric.bridgeParticles, particles)
  assert.equal(lyric.bridgeRemainingSeconds, remaining)
  lyric.isPlaying = true
  lyric.currentPlayTime = 21
  frames.step()
  assert.notDeepEqual(lyric.bridgeParticles, particles)
  assert.equal(lyric.bridgeMotion.elapsed, motion.elapsed + 1)
  assert.equal(lyric.bridgeRemainingSeconds, remaining - 1)
  assert.equal(frames.callbacks.size, 1, 'choreography must share the existing lyric animation loop')
})

test('bridge choreography follows preview priority and cancellation restores the latest real position without seeking', t => {
  const { component, lyric, frames, emitted } = createLyric(t)
  lyric.parsedLyrics = [{ time: 0, text: 'completed' }, { time: 40, text: 'next' }]
  lyric.currentPlayTime = 12
  component.mounted.call(lyric)
  frames.step()
  lyric.previewTime = 30
  component.watch.previewTime.call(lyric, 30)
  const externalParticles = lyric.bridgeParticles
  assert.equal(lyric.bridgeRemainingSeconds, 10)
  lyric.previewSeek({ target: { value: '39.5' } })
  const localParticles = lyric.bridgeParticles
  assert.notDeepEqual(localParticles, externalParticles)
  assert.equal(lyric.bridgeRemainingSeconds, 1)
  lyric.currentPlayTime = 13
  component.watch.currentPlayTime.call(lyric, 13)
  frames.step()
  assert.deepEqual(lyric.bridgeParticles, localParticles)
  lyric.cancelSeek()
  assert.deepEqual(lyric.bridgeParticles, externalParticles)
  lyric.previewTime = null
  component.watch.previewTime.call(lyric, null)
  assert.equal(lyric.internalPlayTime, 13)
  assert.equal(lyric.bridgeMotion.elapsed, 10)
  assert.equal(lyric.bridgeRemainingSeconds, 27)
  assert.notDeepEqual(lyric.bridgeParticles, externalParticles)
  assert.equal(lyric.isPlaying, false, 'a paused preview must stay paused')
  assert.deepEqual(emitted, [])
})

test('bridge choreography contracts before lyric entry and handles opening and short KRC bridge boundaries', t => {
  const { lyric } = createLyric(t)
  for (const scenario of [
    { lines: [{ time: 25, text: 'first' }, { time: 30, text: 'second' }], start: 0, end: 25 },
    { lines: [{ time: 0, text: 'completed' }, { time: 40, text: 'next' }], start: 3, end: 40 },
    { lines: [{ time: 0, text: 'long', words: [{ word: 'long', startTime: 0, endTime: 29 }] }, { time: 30, text: 'next' }], start: 29, end: 30 }
  ]) {
    lyric.parsedLyrics = scenario.lines
    lyric.syncPlaybackTime(scenario.start, true)
    assert.equal(lyric.isBridgeActive, true)
    assert.equal(lyric.bridgeMotion.elapsed, 0)
    assert.equal(lyric.bridgeMotion.unfold, 0)
    assert.equal(lyric.bridgeRemainingSeconds, scenario.end - scenario.start)
    lyric.syncPlaybackTime((scenario.start + scenario.end) / 2, true)
    const expanded = lyric.bridgeMotion.unfold
    assert.ok(expanded > 0)
    lyric.syncPlaybackTime(scenario.end - 0.01, true)
    assert.ok(lyric.bridgeMotion.unfold < expanded)
    assert.equal(lyric.bridgeRemainingSeconds, 1, 'the visible countdown must not reach zero before the next lyric')
    assert.ok(Object.values(lyric.bridgeMotion).every(Number.isFinite))
    assert.ok(lyric.bridgeParticles.every(particle => !/NaN|Infinity/.test(particle.transform) && Number.isFinite(Number(particle.opacity))))
    lyric.syncPlaybackTime(scenario.end, true)
    assert.equal(lyric.isBridgeActive, false)
    assert.equal(lyric.bridgeInfo, null)
    assert.equal(lyric.bridgeRemainingSeconds, 0)
  }
})

test('manual lyric browsing moves the bridge anchor without changing the playback choreography', t => {
  const { lyric, emitted } = createLyric(t)
  lyric.parsedLyrics = [{ time: 0, text: 'completed' }, { time: 40, text: 'next' }, { time: 45, text: 'last' }]
  lyric.syncPlaybackTime(20)
  const motion = lyric.bridgeMotion
  const particles = lyric.bridgeParticles
  const transform = lyric.bridgeIndicatorStyle.transform
  lyric.beginLyricBrowsing()
  assert.equal(lyric.bridgeIndicatorStyle.transform, transform, 'entering browsing must not jump the bridge')
  lyric.setBrowsePosition(lyric.browsePosition + 0.5)
  assert.notEqual(lyric.bridgeIndicatorStyle.transform, transform)
  assert.deepEqual(lyric.bridgeMotion, motion)
  assert.deepEqual(lyric.bridgeParticles, particles)
  assert.equal(lyric.bridgeRemainingSeconds, 20)
  assert.deepEqual(emitted, [])
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

test('changing quality during startup keeps the original resume position and pause intent', async t => {
  for (const readiness of ['url', 'media']) {
    const firstUrl = deferred()
    const store = qualityStore()
    const { component, player, audio } = createPlayer(t, {
      useSettingsStore: () => store,
      getSongUrl: (hash, album, id, quality) => quality === '128' && readiness === 'url' ? firstUrl.promise
        : Promise.resolve({ status: 1, url: `https://example.test/${hash}-${quality}`, extname: 'mp3', bitrate: 320000 })
    })
    qualityAudio(audio, player, { manualReady: readiness === 'media' })
    player.playlist = [song('A')]
    player.initialPlaybackState = { songHash: 'A', currentTime: 72, isPlaying: false }
    component.watch.song.handler.call(player, player.playlist[0])
    await flush()
    player.changeQuality('320')
    await flush()
    if (readiness === 'media') {
      audio.readyState = 4
      audio.emit('canplay')
    }
    await flush()
    assert.equal(player.currentSong.hash, 'A', readiness)
    assert.equal(audio.currentTime, 72, readiness)
    assert.equal(audio.paused, true, readiness)
    assert.equal(audio.playCount, 0, readiness)
    assert.equal(player.loadedQualityPreference, '320', readiness)
    assert.equal(player.loadingSongOptions, null, readiness)
  }
})

test('quality changes preserve failed-navigation continuation and the requested transition', async t => {
  const waitingB = deferred()
  const store = qualityStore()
  const requests = []
  const { player, audio } = createPlayer(t, {
    useSettingsStore: () => store,
    getSongUrl: (hash, album, id, quality) => {
      requests.push(`${hash}:${quality}`)
      return hash === 'B' ? quality === '128' ? waitingB.promise : Promise.resolve({ status: 0 })
        : Promise.resolve({ status: 1, url: `https://example.test/${hash}-${quality}`, extname: 'mp3', bitrate: 320000 })
    }
  })
  qualityAudio(audio, player)
  player.playlist = [song('A'), song('B'), song('C')]
  await player.requestSong(player.playlist[0])
  player.queueNavigation(1, 'next')
  await flush()
  player.changeQuality('320')
  await flush()
  assert.deepEqual(requests, ['A:128', 'B:128', 'B:320', 'C:320'])
  assert.equal(player.currentSong.hash, 'C')
  assert.equal(player.trackTransition, 'next')
})

test('quality switching retains the latest time and pause intent without changing lyrics or track motion', async t => {
  for (const paused of [false, true]) {
    const url = deferred()
    const store = qualityStore()
    const requests = []
    const { player, audio, emitted } = createPlayer(t, {
      useSettingsStore: () => store,
      getSongUrl: async (hash, album, id, quality) => {
        requests.push({ hash, quality })
        return quality === '320' ? url.promise : { status: 1, url: `https://example.test/${hash}.mp3`, extname: 'mp3', bitrate: 128000 }
      }
    })
    qualityAudio(audio, player)
    player.playlist = [song('A')]
    await player.requestSong(player.playlist[0], 'previous')
    await flush()
    audio.currentTime = 34
    player.duration = 180
    player.currentLyrics = 'keep lyrics'
    player.seekPreviewTime = 95
    player.isDragging = true
    const lyricRequestId = player.lyricRequestId
    const emittedBefore = emitted.length
    const changing = player.changeQuality('320')
    assert.equal(player.seekPreviewTime, null)
    audio.currentTime = 47
    if (paused) audio.pause()
    const playsBefore = audio.playCount
    url.resolve({ status: 1, url: 'https://example.test/A-320.mp3', extname: 'mp3', bitrate: 320000 })
    assert.equal(await changing, true)
    assert.equal(audio.currentTime, 47)
    assert.equal(player.currentTime, 47)
    assert.equal(audio.paused, paused)
    assert.equal(audio.playCount, playsBefore + (paused ? 0 : 1))
    assert.equal(player.currentQuality.label, '320 kbps')
    assert.equal(store.settings.playback.quality, '320')
    assert.equal(player.currentLyrics, 'keep lyrics')
    assert.equal(player.lyricRequestId, lyricRequestId)
    assert.equal(player.trackTransition, 'previous')
    assert.equal(emitted.length, emittedBefore)
    assert.equal(requests.at(-1).quality, '320')
  }
})

test('a selected lossless preference reports the actual downgraded response rather than claiming lossless', async t => {
  const store = qualityStore()
  const { player, audio } = createPlayer(t, {
    useSettingsStore: () => store,
    getSongUrl: async () => ({ status: 1, url: 'https://example.test/A.mp3', extname: 'mp3', bitrate: 128000 })
  })
  qualityAudio(audio, player)
  await player.requestSong(song('A'))
  await player.changeQuality('flac')
  assert.equal(player.qualityPreference, 'flac')
  assert.equal(player.currentQuality.label, '128 kbps')
  assert.equal(player.loadedQualityPreference, 'flac')
})

test('VIP URL rejection and media failure retain the committed quality, source and position with readable feedback', async t => {
  for (const failure of ['permission', 'play', 'decode']) {
    const store = qualityStore()
    const { player, audio } = createPlayer(t, {
      useSettingsStore: () => store,
      getSongUrl: async (hash, album, id, quality) => quality === 'flac' && failure === 'permission'
        ? { status: 0, error_code: 30020, error_msg: '当前账号无该音质播放权限' }
        : { status: 1, url: `https://example.test/A-${quality}.mp3`, extname: 'mp3', bitrate: 128000 }
    })
    qualityAudio(audio, player, { manualReady: failure === 'decode' })
    await player.requestSong(song('A'))
    audio.currentTime = 62
    const previousSource = audio.src
    const previousQuality = player.currentQuality
    const basePlay = audio.play.bind(audio)
    audio.play = async () => {
      if (failure === 'play' && audio.src.includes('flac')) throw new Error('Unsupported audio format')
      return basePlay()
    }
    const changing = player.changeQuality('flac')
    if (failure === 'decode') { await flush(); audio.emit('error') }
    assert.equal(await changing, false)
    assert.equal(audio.src, previousSource)
    assert.equal(audio.currentTime, 62)
    assert.equal(audio.paused, false)
    assert.equal(player.currentQuality, previousQuality)
    assert.equal(player.loadedQualityPreference, '128')
    assert.match(player.qualityMessage, /音质切换失败/)
    if (failure === 'permission') assert.match(player.qualityMessage, /当前账号无该音质播放权限/)
  }
})

test('rapid quality selections roll back an uncommitted source before loading only the latest preference', async t => {
  const store = qualityStore()
  const playing320 = deferred()
  const requests = []
  const { player, audio } = createPlayer(t, {
    useSettingsStore: () => store,
    getSongUrl: async (hash, album, id, quality) => {
      requests.push(quality)
      return { status: 1, url: `https://example.test/A-${quality}`, extname: quality === 'high' ? 'flac' : 'mp3', bitrate: 128000 }
    }
  })
  qualityAudio(audio, player)
  await player.requestSong(song('A'))
  audio.currentTime = 73
  const basePlay = audio.play.bind(audio)
  audio.play = () => audio.src.endsWith('-320') ? playing320.promise.then(() => basePlay()) : basePlay()
  const changing = player.changeQuality('320')
  await flush()
  player.changeQuality('flac')
  player.changeQuality('high')
  playing320.resolve()
  await changing
  await flush()
  assert.deepEqual(requests, ['128', '320', 'high'])
  assert.equal(audio.src, 'https://example.test/A-high')
  assert.equal(audio.currentTime, 73)
  assert.equal(player.loadedQualityPreference, 'high')
  assert.equal(player.currentQuality.label, '无损 FLAC')
  assert.equal(player.currentSong.hash, 'A')
})

test('quality changes while the next song loads preserve that target and its transition', async t => {
  const firstB = deferred()
  const store = qualityStore()
  const requests = []
  const { player, audio } = createPlayer(t, {
    useSettingsStore: () => store,
    getSongUrl: async (hash, album, id, quality) => {
      requests.push(`${hash}:${quality}`)
      return hash === 'B' && quality === '128' ? firstB.promise
        : { status: 1, url: `https://example.test/${hash}-${quality}`, extname: 'mp3', bitrate: 320000 }
    }
  })
  qualityAudio(audio, player)
  await player.requestSong(song('A'))
  const next = player.requestSong(song('B'), 'next')
  player.changeQuality('320')
  firstB.resolve({ status: 1, url: 'https://example.test/stale-B' })
  await next
  await flush()
  assert.equal(player.currentSong.hash, 'B')
  assert.equal(player.trackTransition, 'next')
  assert.equal(player.loadedQualityPreference, '320')
  assert.deepEqual(requests, ['A:128', 'B:128', 'B:320'])
  await player.requestSong(song('C'))
  assert.equal(requests.at(-1), 'C:320')
})

test('a newer song supersedes a waiting quality source and keeps the old committed source when it fails', async t => {
  const store = qualityStore()
  const { player, audio } = createPlayer(t, {
    useSettingsStore: () => store,
    getSongUrl: async (hash, album, id, quality) => hash === 'B' ? { status: 0 }
      : { status: 1, url: `https://example.test/${hash}-${quality}`, extname: 'mp3', bitrate: 128000 }
  })
  const listeners = qualityAudio(audio, player, { manualReady: true })
  await player.requestSong(song('A'))
  audio.currentTime = 29
  const changing = player.changeQuality('flac')
  await flush()
  player.requestSong(song('B'))
  await changing
  await flush()
  assert.equal(player.currentSong.hash, 'A')
  assert.equal(audio.src, 'https://example.test/A-128')
  assert.equal(audio.currentTime, 29)
  assert.equal(player.loadedQualityPreference, '128')
  assert.equal(listeners.get('canplay').size, 0)
  assert.equal(listeners.get('error').size, 0)
})

test('stop and unmount cancel quality readiness and cannot resurrect the previous source', async t => {
  for (const action of ['stop', 'unmount']) {
    const store = qualityStore()
    const { player, audio, component } = createPlayer(t, { useSettingsStore: () => store })
    const listeners = qualityAudio(audio, player, { manualReady: true })
    await player.requestSong(song('A'))
    const changing = player.changeQuality('320')
    await flush()
    if (action === 'stop') player.stopPlayback()
    else component.beforeUnmount.call(player)
    audio.emit('canplay')
    await changing
    assert.equal(audio.src, '')
    assert.equal(audio.paused, true)
    assert.equal(player.loadedSongHash, null)
    assert.equal(player.pendingTimers.size, 0)
    assert.equal(listeners.get('canplay').size, 0)
    assert.equal(listeners.get('error').size, 0)
  }
})

test('quality replacement ignores seeks until ready and save-failure retry remembers the attempted quality', async t => {
  const store = qualityStore()
  let saves = 0
  const saved = store.updateSettings.bind(store)
  store.updateSettings = async patch => {
    if (++saves === 1) throw new Error('disk full')
    return saved(patch)
  }
  const { player, audio } = createPlayer(t, { useSettingsStore: () => store })
  qualityAudio(audio, player, { manualReady: true })
  await player.requestSong(song('A'))
  player.duration = 180
  audio.currentTime = 38
  const changing = player.changeQuality('320')
  await flush()
  player.handleSeek(90)
  player.handleProgressDrag({ target: { value: '92' } })
  player.togglePlay()
  audio.emit('canplay')
  await changing
  assert.equal(audio.currentTime, 38)
  assert.equal(player.seekPreviewTime, null)
  assert.match(player.qualitySaveMessage, /保存失败/)
  assert.equal(player.qualityPreference, '128')
  const retry = player.retryQualityChange()
  await flush()
  audio.emit('canplay')
  await retry
  assert.equal(player.qualityPreference, '320')
  assert.equal(player.qualitySaveMessage, '')
})

test('temporary quality sources cannot reset displayed, desktop lyric or system media time before readiness', async t => {
  const store = qualityStore()
  const url = deferred()
  const { player, audio, sandbox } = createPlayer(t, {
    useSettingsStore: () => store,
    getSongUrl: async (hash, album, id, quality) => quality === '320' ? url.promise
      : { status: 1, url: 'https://example.test/A-128', extname: 'mp3', bitrate: 128000 }
  })
  qualityAudio(audio, player, { manualReady: true })
  const desktopTimes = []
  const mediaTimes = []
  sandbox.window.electronAPI = { updatePlaybackTime: time => desktopTimes.push(time) }
  sandbox.navigator.mediaSession.setPositionState = state => mediaTimes.push(state.position)
  player.$el = {}
  await player.requestSong(song('A'))
  audio.currentTime = 62
  player.handleTimeUpdate()
  const changing = player.changeQuality('320')
  audio.currentTime = 64
  player.handleTimeUpdate()
  player.updateTimeLoop()
  assert.equal(player.currentTime, 64)
  url.resolve({ status: 1, url: 'https://example.test/A-320', extname: 'mp3', bitrate: 320000 })
  await flush()
  const desktopBefore = desktopTimes.length
  const mediaBefore = mediaTimes.length
  assert.equal(audio.currentTime, 0)
  player.handleTimeUpdate()
  player.updateTimeLoop()
  player.handleLoadedMetadata()
  player.updatePositionState()
  assert.equal(player.currentTime, 64)
  assert.equal(desktopTimes.length, desktopBefore)
  assert.equal(mediaTimes.length, mediaBefore)
  audio.emit('canplay')
  await changing
  assert.equal(player.currentTime, 64)
  assert.equal(desktopTimes.at(-1), 64000)
  assert.equal(mediaTimes.at(-1), 64)
})

function cachedSource(hash, quality = '128') {
  return { status: 1, url: `bk-cache://media/${hash}-${quality}`, leaseId: `${hash}-${quality}`,
    requestedQuality: quality, extname: 'mp3', bitrate: Number(quality) * 1000,
    detail: { hash, album_audio_id: 72, singerinfo: [{ id: 9, name: '缓存歌手' }] } }
}

test('reselecting the loaded cached preference retries online and retains cache fallback on network failure', async t => {
  for (const offline of [false, true]) {
    const requests = []
    const cacheReads = []
    const store = qualityStore()
    store.settings.playback.quality = 'flac'
    const { player, audio, sandbox } = createPlayer(t, {
      useSettingsStore: () => store,
      getSongUrl: async (hash, album, id, quality) => {
        requests.push(quality)
        if (offline) throw Object.assign(new Error('offline'), { code: 'ERR_NETWORK' })
        return { status: 1, url: 'https://example.test/A.flac', extname: 'flac' }
      }
    })
    qualityAudio(audio, player)
    sandbox.window.electronAPI = { playlistCache: {
      getSource: async options => {
        cacheReads.push(options)
        return { ...cachedSource('A', 'flac'), bitrate: 128000 }
      }, releaseSource: async () => true
    } }
    await player.requestSong(song('A'))
    assert.equal(player.currentQuality.label, '128 kbps')
    audio.currentTime = 62
    audio.pause()
    assert.equal(await player.changeQuality('flac'), true)
    assert.deepEqual(requests, ['flac'])
    assert.equal(audio.currentTime, 62)
    assert.equal(audio.paused, true)
    assert.equal(cacheReads.length, offline ? 2 : 1)
    if (offline) assert.equal(cacheReads[1].allowFallback, true)
    assert.equal(player.currentQuality.label, offline ? '128 kbps' : '无损 FLAC')
  }
})

test('changing to a different cached quality still works immediately without an online lookup', async t => {
  const store = qualityStore()
  let onlineRequests = 0
  const { player, audio, sandbox } = createPlayer(t, {
    useSettingsStore: () => store,
    getSongUrl: async () => { onlineRequests++; throw new Error('should use the cache') }
  })
  qualityAudio(audio, player)
  sandbox.window.electronAPI = { playlistCache: {
    getSource: async ({ quality }) => cachedSource('A', quality), releaseSource: async () => true
  } }
  await player.requestSong(song('A'))
  audio.currentTime = 38
  audio.pause()
  assert.equal(await player.changeQuality('320'), true)
  assert.equal(onlineRequests, 0)
  assert.equal(audio.currentTime, 38)
  assert.equal(audio.paused, true)
  assert.equal(player.currentQuality.label, '320 kbps')
})

test('changing quality for a pending song never refreshes it using the previous cached song preference', async t => {
  const store = qualityStore()
  store.settings.playback.quality = 'high'
  const pendingB = deferred()
  const reads = []
  let onlineRequests = 0
  const { player, audio, sandbox } = createPlayer(t, {
    useSettingsStore: () => store,
    getSongUrl: async () => { onlineRequests++; throw new Error('should use the new song cache') }
  })
  qualityAudio(audio, player)
  sandbox.window.electronAPI = { playlistCache: {
    getSource: async ({ hash, quality }) => {
      reads.push(`${hash}:${quality}`)
      if (hash === 'B' && reads.filter(value => value === 'B:high').length === 1) return pendingB.promise
      return { ...cachedSource(hash, quality), extname: 'flac', bitrate: 900000 }
    }, releaseSource: async () => true
  } }
  await player.requestSong(song('A'))
  player.requestSong(song('B'))
  await flush()
  player.changeQuality('high')
  await flush()
  assert.equal(player.currentSong.hash, 'B')
  assert.equal(onlineRequests, 0)
  assert.deepEqual(reads, ['A:high', 'B:high', 'B:high'])
})

test('reselecting quality while an interrupted online song moves to cache preserves that fallback request', async t => {
  const store = qualityStore()
  const reads = []
  let onlineRequests = 0
  const { player, audio, sandbox } = createPlayer(t, {
    useSettingsStore: () => store,
    getSongUrl: async () => {
      onlineRequests++
      return { status: 1, url: 'https://example.test/A.mp3', extname: 'mp3', bitrate: 128000 }
    }
  })
  qualityAudio(audio, player, { manualReady: true })
  sandbox.window.electronAPI = { playlistCache: {
    getSource: async ({ allowFallback }) => { reads.push(allowFallback); return allowFallback ? cachedSource('A') : null },
    releaseSource: async () => true
  } }
  await player.requestSong(song('A'))
  audio.currentTime = 54
  audio.error = { code: 2 }
  player.handleAudioError()
  await flush()
  assert.equal(player.cacheSourceLeaseId, 'A-128')
  player.changeQuality('128')
  await flush()
  audio.readyState = 4
  audio.emit('canplay')
  await flush()
  assert.equal(player.qualityMessage, '')
  assert.equal(audio.src, 'bk-cache://media/A-128')
  assert.equal(audio.currentTime, 54)
  assert.equal(onlineRequests, 1)
  assert.deepEqual(reads, [false, true, true])
})

test('a cached source skips online detail and URL requests and preserves cached lyrics and translations', async t => {
  const releases = []
  const queued = []
  const lyric = { status: 1, decodeContent: '[00:00.00]离线原文', language: 'translation-payload' }
  let online = 0
  let lyricWrites = 0
  const { player, audio, sandbox } = createPlayer(t, {
    getSongDetail: async () => { online++; throw new Error('must remain offline') },
    getSongUrl: async () => { online++; throw new Error('must remain offline') },
    getLyric: async () => { online++; throw new Error('must remain offline') }
  })
  sandbox.window.electronAPI = { playlistCache: {
    getSource: async request => { assert.equal(request.allowFallback, false); assert.equal(queued.length, 0); return cachedSource(request.hash) },
    releaseSource: async leaseId => releases.push(leaseId),
    readLyrics: async () => lyric,
    putLyrics: async () => { lyricWrites++ },
    cacheSong: async entry => queued.push(entry)
  } }
  const desktop = []
  player.sendLyricsToDesktop = (text, data) => desktop.push({ text, data })
  await player.requestSong({ hash: 'A', name: '离线曲目' })
  await flush()
  assert.equal(online, 0)
  assert.equal(audio.src, 'bk-cache://media/A-128')
  assert.equal(player.currentQuality.label, '128 kbps')
  assert.equal(player.currentLyricData, lyric)
  assert.equal(desktop.at(-1).data.language, 'translation-payload')
  assert.equal(lyricWrites, 0)
  assert.equal(queued.length, 1)
  assert.equal(queued[0].song.album_audio_id, 72)
  assert.equal(queued[0].song.singerinfo[0].id, 9)
  assert.equal(releases.length, 0)
  player.stopPlayback()
  await flush()
  assert.deepEqual(releases, ['A-128'])
})

test('paused startup does not cache audio or lyrics until actual playback and never prefetches the queue', async t => {
  const queued = []
  const lyrics = []
  const { player, audio, sandbox } = createPlayer(t)
  qualityAudio(audio, player)
  sandbox.window.electronAPI = { playlistCache: {
    getSource: async () => null,
    readLyrics: async () => null,
    cacheSong: async entry => queued.push(entry),
    putLyrics: async entry => lyrics.push(entry)
  } }
  player.playlist = [song('A'), song('B')]
  await player.requestSong(player.playlist[0], 'select', {
    restoreState: { songHash: 'A', currentTime: 42, isPlaying: false }
  })
  await flush()
  assert.equal(audio.currentTime, 42)
  assert.equal(audio.paused, true)
  assert.equal(queued.length, 0)
  assert.equal(lyrics.length, 0)
  await audio.play()
  await flush()
  assert.deepEqual(queued.map(entry => entry.song.hash), ['A'])
  assert.deepEqual(lyrics.map(entry => entry.hash), ['A'])
  audio.pause()
  await audio.play()
  await flush()
  assert.equal(queued.length, 2)
  assert.equal(lyrics.length, 2)
})

test('only network failures may use a different cached quality and the actual quality stays truthful', async t => {
  const queries = []
  const { player, audio, sandbox } = createPlayer(t, {
    getSongUrl: async () => { const error = new Error('offline'); error.code = 'ERR_NETWORK'; throw error }
  })
  sandbox.window.electronAPI = { playlistCache: {
    getSource: async request => { queries.push(request); return request.allowFallback ? cachedSource(request.hash) : null },
    releaseSource: async () => {}, readLyrics: async () => null
  } }
  assert.equal(await player.requestSong(song('A'), 'select', { quality: 'flac' }), true)
  assert.deepEqual(queries.map(query => query.allowFallback), [false, true])
  assert.equal(player.currentQuality.label, '128 kbps')
  assert.equal(player.loadedQualityPreference, '128')
  assert.equal(audio.src, 'bk-cache://media/A-128')
  for (const error of [Object.assign(new Error('permission denied'), { response: { status: 502, data: { error_code: 20010 } } }),
    Object.assign(new Error('expired'), { code: 'KUGOU_AUTH_EXPIRED' })]) {
    assert.equal(player.isPlaybackNetworkFailure(error), false)
  }
})

test('cached candidate failure restores the old lease and successful replacement releases it only after confirmation', async t => {
  const releases = []
  const { player, audio, sandbox } = createPlayer(t)
  sandbox.window.electronAPI = { playlistCache: {
    getSource: async request => cachedSource(request.hash),
    releaseSource: async leaseId => releases.push(leaseId),
    readLyrics: async () => null
  } }
  await player.requestSong(song('A'))
  audio.currentTime = 37
  const originalPlay = audio.play.bind(audio)
  const candidate = deferred()
  audio.play = () => audio.src.includes('/B-') ? candidate.promise : originalPlay()
  const selecting = player.requestSong(song('B'))
  await flush()
  assert.equal(audio.src, 'bk-cache://media/B-128')
  assert.equal(releases.length, 0)
  candidate.reject(new Error('decode failed'))
  assert.equal(await selecting, false)
  await flush()
  assert.equal(audio.src, 'bk-cache://media/A-128')
  assert.equal(audio.currentTime, 37)
  assert.equal(player.cacheSourceLeaseId, 'A-128')
  assert.deepEqual(releases, ['B-128'])
  assert.equal(await player.requestSong(song('C')), true)
  await flush()
  assert.deepEqual(releases, ['B-128', 'A-128'])
  assert.equal(player.cacheSourceLeaseId, 'C-128')
})

test('stop, unmount and account changes return late cache leases without playing or caching them', async t => {
  for (const action of ['stop', 'unmount', 'account']) {
    let version = 0
    const pending = deferred()
    const releases = []
    const queued = []
    const { player, audio, sandbox, component } = createPlayer(t, {
      getPlaylistCacheSessionVersion: () => version
    })
    sandbox.window.electronAPI = { playlistCache: {
      getSource: async () => pending.promise,
      releaseSource: async leaseId => releases.push(leaseId),
      cacheSong: async entry => queued.push(entry)
    } }
    const selected = player.requestSong(song('A'))
    await flush()
    if (action === 'stop') player.stopPlayback()
    else if (action === 'unmount') component.beforeUnmount.call(player)
    else { version++; player.stopPlayback() }
    await selected
    pending.resolve(cachedSource('A'))
    await flush()
    assert.deepEqual(releases, ['A-128'])
    assert.equal(audio.src, '')
    assert.equal(queued.length, 0)
    assert.equal(player.cacheSourceLeases.size, 0)
  }
})

test('cache failures cannot block successful online playback or the existing lyric display', async t => {
  const { player, audio, sandbox } = createPlayer(t)
  const fail = async () => { throw new Error('local disk unavailable') }
  sandbox.window.electronAPI = { playlistCache: {
    getSource: fail, readLyrics: fail, cacheSong: fail, putLyrics: fail
  } }
  assert.equal(await player.requestSong(song('A')), true)
  await flush()
  assert.equal(audio.src, 'https://example.test/A.mp3')
  assert.equal(player.currentLyrics, '[00:00.00]A')
  assert.equal(player.isLyricPlaceholder, false)
  assert.equal(player.queuedCacheSongs.size, 0)
})

test('a failed or superseded playback does not queue its audio or late lyrics for offline use', async t => {
  const queued = []
  const savedLyrics = []
  const failedPlay = deferred()
  const lyricA = deferred()
  const { player, audio, sandbox } = createPlayer(t, {
    getLyric: hash => hash === 'A' ? lyricA.promise : Promise.resolve({ status: 1, decodeContent: `[00:00.00]${hash}` })
  })
  sandbox.window.electronAPI = { playlistCache: {
    getSource: async () => null, readLyrics: async () => null,
    cacheSong: async entry => queued.push(entry.song.hash),
    putLyrics: async entry => savedLyrics.push(entry.hash)
  } }
  const originalPlay = audio.play.bind(audio)
  audio.play = () => audio.src.endsWith('/A.mp3') ? failedPlay.promise : originalPlay()
  const selecting = player.requestSong(song('A'))
  await flush()
  player.requestSong(song('B'))
  failedPlay.resolve()
  await selecting
  lyricA.resolve({ status: 1, decodeContent: '[00:00.00]A' })
  await flush()
  assert.deepEqual(queued, ['B'])
  assert.deepEqual(savedLyrics, ['B'])
  assert.equal(player.currentSong.hash, 'B')
})

test('a CDN play network rejection falls back locally while abort and decoder failures keep their original failure', async t => {
  for (const code of ['ERR_NETWORK', 'AbortError', 'NotSupportedError']) {
    const queries = []
    const { player, audio, sandbox } = createPlayer(t)
    sandbox.window.electronAPI = { playlistCache: {
      getSource: async request => { queries.push(request.allowFallback); return request.allowFallback ? cachedSource('A') : null },
      releaseSource: async () => {}, readLyrics: async () => null
    } }
    const originalPlay = audio.play.bind(audio)
    audio.play = async () => {
      if (audio.src.startsWith('https:')) {
        const error = new Error('CDN playback failed')
        if (code === 'ERR_NETWORK') error.code = code
        else error.name = code
        throw error
      }
      return originalPlay()
    }
    assert.equal(await player.requestSong(song('A')), code === 'ERR_NETWORK')
    assert.deepEqual(queries, code === 'ERR_NETWORK' ? [false, true] : [false])
    assert.equal(audio.src, code === 'ERR_NETWORK' ? 'bk-cache://media/A-128' : '')
  }
})

test('a media network error during an unsettled play releases listeners and confirms the cached replacement', async t => {
  const pending = deferred()
  const { player, audio, sandbox } = createPlayer(t)
  const listeners = qualityAudio(audio, player)
  sandbox.window.electronAPI = { playlistCache: {
    getSource: async request => request.allowFallback ? cachedSource('A') : null,
    releaseSource: async () => {}, readLyrics: async () => null
  } }
  const originalPlay = audio.play.bind(audio)
  audio.play = () => audio.src.startsWith('https:') ? pending.promise : originalPlay()
  const selected = player.requestSong(song('A'))
  await flush()
  audio.error = { code: 2 }
  audio.emit('error')
  assert.equal(await selected, true)
  assert.equal(audio.src, 'bk-cache://media/A-128')
  assert.equal(player.currentSong.hash, 'A')
  assert.equal(listeners.get('error').size, 0)
  pending.resolve()
  await flush()
  assert.equal(audio.src, 'bk-cache://media/A-128')
})

test('a confirmed online track handles a later CDN network error at the same position without refetching its URL', async t => {
  let onlineRequests = 0
  const queries = []
  const { player, audio, sandbox } = createPlayer(t, {
    getSongUrl: async () => { onlineRequests++; return { status: 1, url: 'https://example.test/A.mp3', extname: 'mp3', bitrate: 128000 } }
  })
  qualityAudio(audio, player)
  sandbox.window.electronAPI = { playlistCache: {
    getSource: async request => { queries.push(request.allowFallback); return request.allowFallback ? cachedSource('A') : null },
    releaseSource: async () => {}, readLyrics: async () => null
  } }
  await player.requestSong(song('A'), 'next')
  await flush()
  const lyric = player.currentLyrics
  audio.currentTime = 49
  audio.error = { code: 3 }
  player.handleAudioError()
  assert.equal(player.isLoadingSong, false)
  audio.error = { code: 2 }
  player.handleAudioError()
  await flush()
  assert.equal(onlineRequests, 1)
  assert.deepEqual(queries, [false, true])
  assert.equal(audio.src, 'bk-cache://media/A-128')
  assert.equal(audio.currentTime, 49)
  assert.equal(audio.paused, false)
  assert.equal(player.currentLyrics, lyric)
  assert.equal(player.trackTransition, 'next')
})

test('a superseded cache lookup cannot replace or release the newer committed lease', async t => {
  const pending = deferred()
  const releases = []
  const { player, audio, sandbox } = createPlayer(t)
  sandbox.window.electronAPI = { playlistCache: {
    getSource: async request => request.hash === 'B' ? pending.promise : cachedSource(request.hash),
    releaseSource: async leaseId => releases.push(leaseId), readLyrics: async () => null
  } }
  await player.requestSong(song('A'))
  const selectedB = player.requestSong(song('B'))
  await flush()
  player.requestSong(song('C'))
  await selectedB
  await flush()
  assert.equal(audio.src, 'bk-cache://media/C-128')
  assert.equal(player.cacheSourceLeaseId, 'C-128')
  pending.resolve(cachedSource('B'))
  await flush()
  assert.deepEqual(releases, ['A-128', 'B-128'])
  assert.equal(player.cacheSourceLeases.size, 1)
  assert.equal(player.cacheSourceLeases.has('C-128'), true)
})

test('late lyrics for an actually played previous track are never stored as the current track lyrics', async t => {
  const pending = deferred()
  const writes = []
  const { player, sandbox } = createPlayer(t, {
    getLyric: hash => hash === 'A' ? pending.promise : Promise.resolve({ status: 1, decodeContent: '[00:00.00]B', language: 'B-translation' })
  })
  sandbox.window.electronAPI = { playlistCache: {
    getSource: async () => null, readLyrics: async () => null,
    cacheSong: async () => {}, putLyrics: async entry => writes.push(entry)
  } }
  await player.requestSong(song('A'))
  await flush()
  await player.requestSong(song('B'))
  await flush()
  pending.resolve({ status: 1, decodeContent: '[00:00.00]A', language: 'A-translation' })
  await flush()
  assert.deepEqual(writes.map(entry => entry.hash), ['B'])
  assert.equal(writes[0].data.language, 'B-translation')
  assert.equal(player.currentLyricData.language, 'B-translation')
})

test('enabling caching or clearing it allows the same loaded song and lyrics to accumulate on the next real play', async t => {
  let enabled = false
  const audioRequests = [], lyricRequests = [], storedSongs = new Set(), storedLyrics = new Set()
  const { player, audio, sandbox } = createPlayer(t)
  sandbox.window.electronAPI = { playlistCache: {
    getSource: async () => null, readLyrics: async () => null,
    cacheSong: async entry => { audioRequests.push(entry.song.hash); if (enabled) storedSongs.add(entry.song.hash); return { enabled } },
    putLyrics: async entry => { lyricRequests.push(entry.hash); if (enabled) storedLyrics.add(entry.hash); return enabled ? entry.data : null }
  } }
  await player.requestSong(song('A'))
  await flush()
  assert.equal(storedSongs.size, 0)
  assert.equal(storedLyrics.size, 0)
  enabled = true
  audio.pause()
  await audio.play()
  await flush()
  assert.deepEqual([...storedSongs], ['A'])
  assert.deepEqual([...storedLyrics], ['A'])
  storedSongs.clear(); storedLyrics.clear()
  audio.pause()
  await audio.play()
  await flush()
  assert.deepEqual([...storedSongs], ['A'])
  assert.deepEqual([...storedLyrics], ['A'])
  assert.deepEqual(audioRequests, ['A', 'A', 'A'])
  assert.deepEqual(lyricRequests, ['A', 'A', 'A'])
})

test('resuming a track originally loaded offline can repopulate its retained lyrics after clear', async t => {
  const data = { status: 1, decodeContent: '[00:00.00]Cached lyrics', language: 'retained-translation' }
  const writes = []
  const { player, audio, sandbox } = createPlayer(t)
  sandbox.window.electronAPI = { playlistCache: {
    getSource: async () => cachedSource('A'), releaseSource: async () => {},
    readLyrics: async () => data, cacheSong: async () => ({}), putLyrics: async entry => writes.push(entry)
  } }
  await player.requestSong(song('A'))
  await flush()
  assert.equal(writes.length, 0)
  assert.equal(player.currentLyricsFromCache, true)
  audio.pause()
  await audio.play()
  await flush()
  assert.equal(writes.length, 1)
  assert.equal(writes[0].hash, 'A')
  assert.equal(writes[0].data.language, 'retained-translation')
})

test('song and lyric bridge payloads remove nested Vue proxies before Electron structured cloning', async t => {
  const track = reactive({ ...song('A'), singerinfo: [{ id: 3, name: 'Reactive artist' }], albuminfo: { name: 'Reactive album' } })
  const lyric = reactive({ status: 1, decodeContent: '[00:00.00]Reactive lyrics', translationData: { lines: ['Translated line'] } })
  const songs = [], lyrics = []
  const { player, sandbox } = createPlayer(t, { getLyric: async () => lyric })
  sandbox.window.electronAPI = { playlistCache: {
    getSource: async () => null, readLyrics: async () => null,
    cacheSong: async payload => songs.push(structuredClone(payload)),
    putLyrics: async payload => lyrics.push(structuredClone(payload))
  } }
  await player.requestSong(track)
  await flush()
  assert.equal(songs.length, 1)
  assert.equal(lyrics.length, 1)
  assert.equal(songs[0].song.singerinfo[0].name, 'Reactive artist')
  assert.equal(songs[0].song.albuminfo.name, 'Reactive album')
  assert.equal(lyrics[0].data.translationData.lines[0], 'Translated line')
})

test('desktop seeks, pause and resume bypass continuous-time throttling and retain confirmed identity', async t => {
  let now = 10000
  const { player, audio, sandbox } = createPlayer(t, { Date: { now: () => now } })
  const times = []
  sandbox.window.electronAPI = { updatePlaybackTime: (time, meta) => times.push({ time, ...meta }) }
  await player.requestSong(song('A'))
  await flush()
  times.length = 0
  now += 200
  audio.currentTime = 1
  player.handleTimeUpdate()
  now += 10
  audio.currentTime = 1.01
  player.handleTimeUpdate()
  assert.equal(times.length, 1)
  audio.pause()
  assert.equal(times.at(-1).time, 1010)
  player.handleSeek(60)
  assert.equal(times.at(-1).time, 60000)
  audio.currentTime = 90
  player.handleSeeked()
  assert.deepEqual(times.at(-1), { time: 90000, trackId: 'A', duration: 180000 })
  await audio.play()
  assert.equal(times.at(-1).time, 90000)
})

test('desktop publishes confirmed song identities and translations, then clears snapshots on stop and unmount', async t => {
  const pending = deferred()
  const { component, player, audio, sandbox } = createPlayer(t, {
    getSongUrl: async hash => hash === 'B' ? pending.promise : { status: 1, url: `https://example.test/${hash}.mp3` },
    getLyric: async () => ({ status: 1, decodeContent: '[1000,2000]<0,2000,0>Hello',
      language: Buffer.from(JSON.stringify({ content: [{ type: 1, lyricContent: [['你好']] }] })).toString('base64') })
  })
  const messages = []
  sandbox.window.electronAPI = {
    updateTrack: track => messages.push(['track', track]),
    updateLyrics: (lyrics, trackId) => messages.push(['lyrics', lyrics, trackId]),
    updatePlaybackTime: (time, meta) => messages.push(['time', time, meta])
  }
  player.sendLyricsToDesktop = component.methods.sendLyricsToDesktop.bind(player)
  const a = { ...song('A'), name: 'Artist - Same title', singerinfo: [{ id: 1, name: 'Artist' }] }
  const b = { ...a, hash: 'B' }
  await player.requestSong(a)
  await flush()
  assert.deepEqual(plainDesktop(messages.find(message => message[0] === 'track')[1]), {
    trackId: 'A', title: 'Same title', artist: 'Artist', cover: null
  })
  const lyricMessage = messages.find(message => message[0] === 'lyrics')
  assert.equal(lyricMessage[2], 'A')
  assert.equal(lyricMessage[1][0].translation, '你好')
  const switching = player.requestSong(b)
  await flush()
  assert.equal(messages.filter(message => message[0] === 'track').at(-1)[1].trackId, 'A')
  pending.resolve({ status: 1, url: 'https://example.test/B.mp3' })
  await switching
  await flush()
  assert.equal(messages.filter(message => message[0] === 'track').at(-1)[1].trackId, 'B')
  const confirmedB = messages.findIndex(message => message[0] === 'track' && message[1]?.trackId === 'B')
  assert.ok(messages.every((message, index) =>
    (message[0] === 'lyrics' ? message[2] : message[0] === 'time' ? message[2]?.trackId : null) !== 'B' || index > confirmedB))
  player.stopPlayback()
  assert.deepEqual(messages.at(-1), ['track', null])
  await player.requestSong(a)
  await flush()
  component.beforeUnmount.call(player)
  audio.currentTime = 120
  player.handleTimeUpdate()
  assert.deepEqual(messages.at(-1), ['track', null])
})

test('desktop paused startup and same-song restart send their exact positions without awaiting another timeupdate', async t => {
  const { component, player, audio, sandbox } = createPlayer(t)
  qualityAudio(audio, player)
  const times = []
  sandbox.window.electronAPI = { updatePlaybackTime: (time, meta) => times.push({ time, ...meta }) }
  player.initialPlaybackState = { songHash: 'A', currentTime: 42, isPlaying: false }
  component.watch.song.handler.call(player, song('A'))
  await flush()
  assert.equal(audio.paused, true)
  assert.deepEqual(times.at(-1), { time: 42000, trackId: 'A', duration: 180000 })
  player.playlist = [song('A')]
  audio.currentTime = 175
  player.currentTime = 175
  await player.playPrevious()
  assert.equal(times.at(-1).time, 0)
  assert.equal(times.at(-1).trackId, 'A')
})

function plainDesktop(value) { return JSON.parse(JSON.stringify(value)) }

test('base64-only lyric responses preserve UTF-8 text before desktop parsing', async t => {
  const text = '[00:01.00] 你好 😀 < B  '
  const { component, player, sandbox } = createPlayer(t, {
    getLyric: async () => ({ status: 1, content: Buffer.from(text, 'utf8').toString('base64') })
  })
  const lyrics = []
  sandbox.window.electronAPI = { updateLyrics: lines => lyrics.push(lines) }
  player.sendLyricsToDesktop = component.methods.sendLyricsToDesktop.bind(player)
  await player.requestSong(song('A'))
  await flush()
  assert.equal(player.currentLyrics, text)
  assert.equal(lyrics.at(-1)[0].text, ' 你好 😀 < B  ')
})
