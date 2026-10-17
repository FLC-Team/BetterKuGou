const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const vue = require('vue')
const { compile } = require('@vue/compiler-dom')

const directory = path.join(__dirname, '..', 'src', 'components', 'player')
const source = fs.readFileSync(path.join(directory, 'LyricView.js'), 'utf8')
  .replace(/^import[^\n]*\n/gm, '').replace('export default {', 'globalThis.component = {')
const template = fs.readFileSync(path.join(directory, 'LyricView.vue'), 'utf8').match(/^<template>([\s\S]*)<\/template>\s*<script/m)[1]
const words = Array.from({ length: 50 }, (_, index) => {
  const seconds = index * 5
  return `[${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}.00]line ${index} with spaces`
}).join('\n')

function clock() {
  let now = 0
  let nextId = 0
  const timers = new Map()
  return {
    timers,
    setTimeout(callback, duration) { const id = ++nextId; timers.set(id, { at: now + duration, callback }); return id },
    clearTimeout(id) { timers.delete(id) },
    advance(duration) {
      const end = now + duration
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!next) break
        now = next[1].at
        timers.delete(next[0])
        next[1].callback()
      }
      now = end
    }
  }
}

function environment(options = {}) {
  const time = clock()
  const listeners = new Map()
  const frames = new Map()
  let frameId = 0
  const warnings = []
  const clipboard = []
  const window = {
    innerWidth: 1200, innerHeight: 800,
    addEventListener(name, callback) {
      if (!listeners.has(name)) listeners.set(name, new Set())
      listeners.get(name).add(callback)
    },
    removeEventListener(name, callback) { listeners.get(name)?.delete(callback) },
    dispatch(name, event) { [...(listeners.get(name) || [])].forEach(callback => callback(event)) },
    electronAPI: options.browser ? undefined : { writeClipboardText: async text => { clipboard.push(text); return true } }
  }
  const menuManager = {
    activeMenuCloser: null,
    registerMenu(callback) {
      if (this.activeMenuCloser && this.activeMenuCloser !== callback) this.activeMenuCloser()
      this.activeMenuCloser = callback
    },
    unregisterMenu(callback) { if (this.activeMenuCloser === callback) this.activeMenuCloser = null },
    closeActiveMenu() { this.activeMenuCloser?.(); this.activeMenuCloser = null }
  }
  const settingsStore = { settings: { playback: { showTranslation: true } }, async updateSettings() {} }
  const document = { body: { style: { overflow: 'auto' } }, activeElement: null }
  const sandbox = {
    window, document, navigator: options.browser ? { clipboard: { writeText: async text => clipboard.push(text) } } : {},
    process: { env: { NODE_ENV: 'test' } }, performance, ContextMenu: { render: () => null }, ArtistLinks: { render: () => null }, contextMenuManager: menuManager,
    useSettingsStore: () => settingsStore, repeatAllIcon: '', repeatOneIcon: '', shuffleIcon: '',
    logger: Object.fromEntries(['trace', 'debug', 'info', 'error', 'warn'].map(level => [level, (...args) => {
      if (level === 'warn') warnings.push(args)
    }])),
    setTimeout: time.setTimeout, clearTimeout: time.clearTimeout,
    requestAnimationFrame(callback) { const id = ++frameId; frames.set(id, callback); return id },
    cancelAnimationFrame(id) { frames.delete(id) },
    atob: value => Buffer.from(value, 'base64').toString('utf8')
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'LyricView.js' })
  return { ...sandbox, time, frames, listeners, warnings, clipboard, menuManager, settingsStore, component: sandbox.component }
}

function fixture(t, options = {}) {
  const env = environment(options)
  const { component } = env
  const emitted = []
  const defaults = Object.fromEntries(Object.entries(component.props).map(([name, definition]) => [name,
    typeof definition.default === 'function' ? definition.default() : definition.default]))
  const lyric = {
    ...defaults, ...component.data(), visible: true, song: { hash: 'A', name: 'A' }, lyricsInteractive: true,
    lyrics: words, duration: 300, settingsStore: env.settingsStore,
    $nextTick: callback => Promise.resolve().then(() => callback?.()),
    $emit: (name, value) => emitted.push({ name, value }),
    $refs: { lyricsContainer: { clientHeight: 500, querySelectorAll: () => [] }, closeButton: { focus() {} } }
  }
  for (const [name, method] of Object.entries(component.methods)) lyric[name] = method.bind(lyric)
  for (const [name, getter] of Object.entries(component.computed)) Object.defineProperty(lyric, name, { get: () => getter.call(lyric) })
  lyric.parseLyrics(lyric.lyrics)
  lyric.syncPlaybackTime(0)
  t.after(() => component.beforeUnmount.call(lyric))
  return { ...env, lyric, emitted }
}

function pointer(overrides = {}) {
  const captured = new Set()
  return {
    type: 'pointerdown', pointerId: 1, clientX: 20, clientY: 100, button: 0, isPrimary: true,
    target: { closest: () => null },
    currentTarget: {
      setPointerCapture: id => captured.add(id), hasPointerCapture: id => captured.has(id),
      releasePointerCapture: id => captured.delete(id)
    },
    prevented: false,
    preventDefault() { this.prevented = true }, stopPropagation() {},
    ...overrides
  }
}

function wheel(lyric, deltaY, overrides = {}) {
  const event = pointer({ type: 'wheel', deltaY, deltaMode: 0, ...overrides })
  lyric.handleLyricWheel(event, lyric.lyricContentKey)
  return event
}

test('dragging starts only beyond six pixels, never seeks and suppresses only the following pointer click', t => {
  const { lyric, window, emitted, listeners } = fixture(t)
  lyric.currentPlayTime = 10
  lyric.syncPlaybackTime(10)
  lyric.startLyricPointer(pointer(), lyric.lyricContentKey)
  window.dispatch('pointermove', pointer({ clientY: 105 }))
  assert.equal(lyric.browsePosition, null)
  window.dispatch('pointermove', pointer({ clientY: 106 }))
  assert.equal(lyric.browsePosition, null)
  window.dispatch('pointermove', pointer({ clientY: 107 }))
  assert.ok(lyric.browsePosition < 2)
  assert.equal(lyric.currentLyricIndex, 2)
  assert.equal(lyric.getLyricLineStyle(2).transition, 'none')
  window.dispatch('pointerup', pointer({ clientY: 107 }))
  lyric.activateLyricLine(3, pointer({ type: 'click' }), lyric.lyricContentKey)
  assert.deepEqual(emitted, [])
  assert.equal(listeners.get('pointermove').size, 0)
  lyric.startLyricPointer(pointer(), lyric.lyricContentKey)
  window.dispatch('pointerup', pointer())
  lyric.activateLyricLine(3, pointer({ type: 'click' }), lyric.lyricContentKey)
  assert.deepEqual(emitted, [{ name: 'seek', value: 15 }])
  assert.equal(lyric.browsePosition, null)
})

test('wheel browsing reaches previously hidden distant lyrics without changing audio time or highlighting', t => {
  const { lyric, emitted, component } = fixture(t)
  assert.equal(lyric.getLyricLineStyle(35).visibility, 'hidden')
  assert.equal(wheel(lyric, 35 * lyric.lyricLineHeight).prevented, true)
  assert.equal(lyric.browsePosition, 35)
  assert.equal(lyric.getLyricLineStyle(35).visibility, 'visible')
  assert.match(lyric.getLyricLineStyle(35).transform, /translateY\(0px\)/)
  lyric.currentPlayTime = 0.25
  component.watch.currentPlayTime.call(lyric)
  assert.equal(lyric.internalPlayTime, 0.25)
  assert.equal(lyric.currentLyricIndex, 0)
  assert.equal(lyric.browsePosition, 35)
  assert.equal(lyric.getLyricLineStyle(35).pointerEvents, 'auto')
  assert.deepEqual(emitted, [])
  wheel(lyric, 100000)
  assert.equal(lyric.browsePosition, 49)
  wheel(lyric, -100000)
  assert.equal(lyric.browsePosition, 0)
})

test('wheel line and page units are supported while zoom and invalid wheel input remain untouched', t => {
  const { lyric } = fixture(t)
  wheel(lyric, 3, { deltaMode: 1 })
  assert.equal(lyric.browsePosition, 3)
  wheel(lyric, 1, { deltaMode: 2 })
  assert.equal(lyric.browsePosition, 3 + 500 / lyric.lyricLineHeight)
  const position = lyric.browsePosition
  for (const event of [wheel(lyric, 100, { ctrlKey: true }), wheel(lyric, NaN), wheel(lyric, 0)]) {
    assert.equal(event.prevented, false)
  }
  assert.equal(lyric.browsePosition, position)
})

test('returning after five seconds pauses throughout dragging and an open context menu', t => {
  const { lyric, time, window, emitted } = fixture(t)
  wheel(lyric, lyric.lyricLineHeight * 10)
  time.advance(4999)
  assert.equal(lyric.browsePosition, 10)
  lyric.startLyricPointer(pointer(), lyric.lyricContentKey)
  time.advance(10000)
  assert.equal(lyric.browsePosition, 10)
  window.dispatch('pointerup', pointer())
  time.advance(4999)
  assert.equal(lyric.browsePosition, 10)
  lyric.showLyricMenu(pointer(), 10, lyric.lyricContentKey)
  time.advance(10000)
  assert.equal(lyric.lyricMenuVisible, true)
  assert.equal(lyric.browsePosition, 10)
  lyric.closeLyricMenu()
  time.advance(4999)
  assert.equal(lyric.browsePosition, 10)
  time.advance(1)
  assert.equal(lyric.browsePosition, null)
  assert.deepEqual(emitted, [])
  assert.equal(time.timers.size, 0)
})

test('bridge layout is continuous when browsing begins and the real bridge can end without moving the browsed lyrics', t => {
  const { lyric } = fixture(t)
  lyric.lyrics = '[00:00.00]first\n[00:50.00]next\n[00:55.00]last'
  lyric.parseLyrics(lyric.lyrics)
  lyric.currentPlayTime = 49.5
  lyric.syncPlaybackTime(49.5)
  assert.equal(lyric.isBridgeActive, true)
  assert.equal(lyric.getLyricRelativePosition(0), -1)
  lyric.startLyricPointer(pointer(), lyric.lyricContentKey)
  lyric.moveLyricPointer(pointer({ clientY: 107 }))
  assert.equal(lyric.getLyricRelativePosition(0), -1 + 7 / lyric.lyricLineHeight)
  lyric.endLyricPointer(pointer())
  const position = lyric.getLyricRelativePosition(1)
  lyric.currentPlayTime = 50.1
  lyric.syncPlaybackTime(50.1)
  assert.equal(lyric.isBridgeActive, false)
  assert.equal(lyric.currentLyricIndex, 1)
  assert.equal(lyric.getLyricRelativePosition(1), position)
})

test('line activation and keyboard activation use timestamps and preserve the current pause state', t => {
  const { lyric, emitted } = fixture(t)
  lyric.isPlaying = false
  wheel(lyric, 30 * lyric.lyricLineHeight)
  lyric.activateLyricLine(30, pointer({ type: 'click' }), lyric.lyricContentKey)
  assert.deepEqual(emitted, [{ name: 'seek', value: 150 }])
  assert.equal(lyric.isPlaying, false)
  assert.equal(lyric.browsePosition, null)
  lyric.suppressLyricClick = true
  lyric.activateLyricLine(1, pointer({ type: 'keydown' }), lyric.lyricContentKey)
  assert.deepEqual(emitted.at(-1), { name: 'seek', value: 5 })
  lyric.focusLyricLine(40, lyric.lyricContentKey)
  assert.equal(lyric.browsePosition, 40)
})

test('automatic return moves lyric keyboard focus to the current row instead of leaving it hidden', async t => {
  const { lyric, document, time } = fixture(t)
  let focused = 0
  document.activeElement = {}
  lyric.$refs.lyricsContainer.contains = element => element === document.activeElement
  lyric.lyricLineRefs[0] = { querySelector: () => null, focus() { focused++ } }
  wheel(lyric, lyric.lyricLineHeight * 30)
  time.advance(5000)
  await Promise.resolve()
  assert.equal(lyric.browsePosition, null)
  assert.equal(focused, 1)
})

test('only real active lyric layers browse, copy or seek; placeholders, inert layers and stale keys cannot', t => {
  const { lyric, emitted, clipboard } = fixture(t)
  for (const reason of ['source', 'placeholder', 'inert', 'stale', 'switching']) {
    lyric.lyricsInteractive = reason !== 'source'
    lyric.pauseUpdates = reason === 'switching'
    lyric.hasTimedLyrics = reason !== 'placeholder'
    const event = pointer({ target: { closest: () => reason === 'inert' ? {} : null } })
    const key = reason === 'stale' ? 'old:ready' : lyric.lyricContentKey
    lyric.handleLyricWheel({ ...event, deltaY: 100 }, key)
    lyric.startLyricPointer(event, key)
    lyric.activateLyricLine(1, event, key)
    lyric.showLyricMenu(event, 1, key)
    assert.equal(lyric.browsePosition, null, reason)
    assert.equal(lyric.lyricPointer, null, reason)
    assert.equal(lyric.lyricMenuVisible, false, reason)
  }
  assert.deepEqual(emitted, [])
  assert.deepEqual(clipboard, [])
})

test('context menu copies text snapshots with original spaces, complete original lyrics and optional translation', async t => {
  const { lyric, clipboard, menuManager } = fixture(t)
  lyric.parsedLyrics[1].translation = '对应翻译'
  lyric.showTranslation = false
  lyric.showLyricMenu(pointer({ clientX: 1190, clientY: 790 }), 1, lyric.lyricContentKey)
  assert.equal(menuManager.activeMenuCloser, lyric.closeLyricMenu)
  const items = lyric.lyricMenuItems
  const originalAll = lyric.parsedLyrics.map(line => line.text).join('\n')
  lyric.parsedLyrics[1].text = 'changed while menu open'
  lyric.parsedLyrics[1].translation = 'changed translation'
  await items[0].action()
  await items[1].action()
  await items[2].action()
  assert.deepEqual(clipboard, ['line 1 with spaces', originalAll, 'line 1 with spaces\n对应翻译'])
  assert.equal(lyric.copyFeedback, '已复制歌词')
  assert.equal(clipboard.some(text => text.includes('\u200b')), false)
  lyric.closeLyricMenu()
  assert.equal(menuManager.activeMenuCloser, null)
  lyric.showLyricMenu(pointer(), 0, lyric.lyricContentKey)
  assert.equal(lyric.lyricMenuItems.length, 2)
})

test('clipboard falls back in a browser and failures provide visible feedback without logging text', async t => {
  const browser = fixture(t, { browser: true })
  await browser.lyric.copyLyricText('browser lyrics')
  assert.deepEqual(browser.clipboard, ['browser lyrics'])
  const desktop = fixture(t)
  desktop.window.electronAPI.writeClipboardText = async () => { throw new Error('private lyric content') }
  await desktop.lyric.copyLyricText('private lyric content')
  assert.equal(desktop.lyric.copyFeedback, '复制失败，请重试')
  assert.equal(JSON.stringify(desktop.warnings).includes('private lyric content'), false)
})

test('late clipboard completion cannot update feedback after a new song or unmount', async t => {
  const { lyric, window, component } = fixture(t)
  let resolve
  window.electronAPI.writeClipboardText = () => new Promise(done => { resolve = done })
  const copying = lyric.copyLyricText('old text')
  component.watch.song.call(lyric)
  resolve(true)
  await copying
  assert.equal(lyric.copyFeedback, '')
  const copyingAgain = lyric.copyLyricText('old text')
  component.beforeUnmount.call(lyric)
  resolve(true)
  await copyingAgain
  assert.equal(lyric.copyFeedback, '')
})

test('Escape, pointer cancellation, blur and lifecycle resets release browsing resources and never seek', t => {
  for (const mode of ['escape', 'cancel', 'blur', 'song', 'hidden', 'pause', 'placeholder', 'lyrics', 'unmount']) {
    const { lyric, window, component, listeners, time, emitted, menuManager, frames } = fixture(t)
    component.mounted.call(lyric)
    wheel(lyric, lyric.lyricLineHeight * 8)
    lyric.showLyricMenu(pointer(), 8, lyric.lyricContentKey)
    lyric.startLyricPointer(pointer(), lyric.lyricContentKey)
    lyric.moveLyricPointer(pointer({ clientY: 120 }))
    if (mode === 'escape') lyric.handleLyricEscape()
    if (mode === 'cancel') window.dispatch('pointercancel', pointer())
    if (mode === 'blur') window.dispatch('blur', {})
    if (mode === 'song') component.watch.song.call(lyric)
    if (mode === 'hidden') { lyric.visible = false; component.watch.visible.call(lyric, false) }
    if (mode === 'pause') { lyric.pauseUpdates = true; component.watch.pauseUpdates.call(lyric, true) }
    if (mode === 'placeholder') { lyric.lyricsInteractive = false; component.watch.lyricsInteractive.call(lyric, false) }
    if (mode === 'lyrics') lyric.parseLyrics('[00:00.00]replacement')
    if (mode === 'unmount') component.beforeUnmount.call(lyric)
    assert.equal(lyric.browsePosition, null, mode)
    assert.equal(lyric.lyricPointer, null, mode)
    assert.equal(lyric.lyricMenuVisible, false, mode)
    assert.equal(menuManager.activeMenuCloser, null, mode)
    assert.equal(listeners.get('pointermove').size, 0, mode)
    assert.equal(listeners.get('pointerup').size, 0, mode)
    assert.equal(listeners.get('pointercancel').size, 0, mode)
    assert.equal(time.timers.size, 0, mode)
    assert.equal(emitted.some(event => event.name === 'seek'), false, mode)
    if (mode === 'unmount') {
      assert.equal(frames.size, 0)
      assert.equal(listeners.get('blur').size, 0)
      assert.equal(listeners.get('keydown').size, 0)
      assert.equal(listeners.get('resize').size, 0)
    }
  }
})

test('progress previews and external seeks restore automatic following while manual browsing never replaces preview time', t => {
  const { lyric, component } = fixture(t)
  wheel(lyric, lyric.lyricLineHeight * 20)
  lyric.previewSeek({ target: { value: '32' } })
  assert.equal(lyric.browsePosition, null)
  assert.equal(lyric.internalPlayTime, 32)
  lyric.cancelSeek()
  wheel(lyric, lyric.lyricLineHeight * 20)
  lyric.previewTime = 40
  component.watch.previewTime.call(lyric)
  assert.equal(lyric.browsePosition, null)
  assert.equal(lyric.internalPlayTime, 40)
  lyric.previewTime = null
  lyric.syncPlaybackTime(0)
  wheel(lyric, lyric.lyricLineHeight * 20)
  lyric.syncPlaybackTime(90)
  assert.equal(lyric.browsePosition, null)
})

test('song-title search emits the original song without seeking or changing playback', t => {
  const { lyric, emitted } = fixture(t)
  lyric.searchSong(pointer({ type: 'click' }))
  assert.deepEqual(emitted, [{ name: 'search', value: lyric.song }])
  lyric.searchSong(pointer({ target: { closest: () => ({ inert: true }) } }))
  assert.equal(emitted.length, 1)
})

test('the production template exposes keyboard seek, the return button, copy feedback and song search', async t => {
  const env = environment()
  const transition = { setup(_props, { slots }) { return () => slots.default?.() } }
  const render = new Function('Vue', compile(template, { mode: 'function' }).code)({ ...vue, Transition: transition })
  function node(type, text = '') {
    return { type, text, parent: null, children: [], props: {}, style: {}, clientHeight: 500,
      focus() {}, contains: () => false, querySelector: () => null, querySelectorAll: () => [],
      setAttribute(name, value) { this.props[name] = value }
    }
  }
  const renderer = vue.createRenderer({
    createElement: node, createText: text => node('text', text), createComment: () => node('comment'),
    setText: (element, text) => { element.text = text },
    setElementText: (element, text) => { element.text = text; element.children = [] },
    patchProp: (element, key, _old, value) => { element.props[key] = value },
    insert(element, parent, anchor) {
      if (element.parent) element.parent.children.splice(element.parent.children.indexOf(element), 1)
      element.parent = parent
      const position = anchor ? parent.children.indexOf(anchor) : -1
      if (position < 0) parent.children.push(element)
      else parent.children.splice(position, 0, element)
    },
    remove(element) { element.parent?.children.splice(element.parent.children.indexOf(element), 1); element.parent = null },
    parentNode: element => element.parent,
    nextSibling: element => element.parent?.children[element.parent.children.indexOf(element) + 1] || null
  })
  const seeks = []
  const searches = []
  const container = node('root')
  const app = renderer.createApp({ ...env.component, render }, {
    visible: true, lyricsInteractive: true, lyrics: '[00:00.00]first\n[00:10.00]second', duration: 20,
    song: { hash: 'A', name: 'song A' }, onSeek: value => seeks.push(value), onSearch: value => searches.push(value)
  })
  app.config.warnHandler = () => {}
  const lyric = app.mount(container)
  t.after(() => app.unmount())
  await vue.nextTick()
  const all = () => {
    const visit = element => [element, ...element.children.flatMap(visit)]
    return visit(container)
  }
  const line = all().find(element => element.props['aria-label'] === '跳转至 00:10，second')
  assert.equal(line.props.role, 'button')
  assert.equal(line.props.tabindex, 0)
  line.props.onKeydown[1](pointer({ type: 'keydown', key: ' ', code: 'Space' }))
  assert.deepEqual(seeks, [10])
  wheel(lyric, lyric.lyricLineHeight)
  await vue.nextTick()
  const back = all().find(element => element.props.class === 'return-current-lyric')
  assert.equal(back.text, '回到当前歌词')
  back.props.onClick()
  assert.equal(lyric.browsePosition, null)
  const title = all().find(element => element.props.class === 'song-title-search')
  title.props.onClick(pointer({ type: 'click' }))
  assert.equal(searches[0].hash, 'A')
  await lyric.copyLyricText('first')
  await vue.nextTick()
  assert.equal(all().find(element => element.props.class === 'lyric-copy-feedback').text, '已复制歌词')
})
