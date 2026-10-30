const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const html = fs.readFileSync(path.join(__dirname, '../electron/desktopLyric.html'), 'utf8')
const source = html.match(/<script>([\s\S]*?)<\/script>/)[1]

/** Run the real window script with measured DOM nodes and controlled IPC/animation frames. */
function rendererFixture({ reducedMotion = false, actions = {} } = {}) {
  class Element {
    constructor(name = 'div') {
      this.name = name
      this.children = []
      this.dataset = {}
      this.attributes = new Map()
      this.listeners = new Map()
      this.className = ''
      this._text = ''
      this.clientWidth = 740
      this.disabled = false
      this.inert = false
      this.captured = new Set()
      this.style = { setProperty(name, value) { this[name] = value }, removeProperty(name) { delete this[name] } }
      this.classList = {
        add: (...names) => { this.className = [...new Set(this.className.split(/\s+/).filter(Boolean).concat(names))].join(' ') },
        remove: (...names) => { this.className = this.className.split(/\s+/).filter(name => !names.includes(name)).join(' ') },
        contains: name => this.className.split(/\s+/).includes(name),
        toggle: (name, force) => { const enabled = force ?? !this.classList.contains(name); this.classList[enabled ? 'add' : 'remove'](name); return enabled }
      }
    }
    get textContent() { return this.children.length ? this.children.map(child => child.textContent).join('') : this._text }
    set textContent(value) { this._text = String(value); this.children = [] }
    get scrollWidth() { return this.measuredWidth ?? Array.from(this.textContent).length * 20 }
    getBoundingClientRect() { return this.id === 'nextViewport' ? { top: 80, height: 24 } : { top: 40, height: 36 } }
    appendChild(child) {
      this._text = ''
      if (child.name === 'fragment') this.children.push(...child.children)
      else this.children.push(child)
      return child
    }
    replaceChildren(...children) { this.children = []; this._text = ''; children.forEach(child => this.appendChild(child)) }
    setAttribute(name, value) { this.attributes.set(name, String(value)) }
    getAttribute(name) { return this.attributes.get(name) ?? null }
    addEventListener(name, callback) { this.listeners.set(name, callback) }
    removeEventListener(name, callback) { if (this.listeners.get(name) === callback) this.listeners.delete(name) }
    dispatch(name, event = {}) { return this.listeners.get(name)?.({ preventDefault() {}, ...event }) }
    click() { return !this.disabled && !this.inert ? this.dispatch('click') : undefined }
    setPointerCapture(id) { this.captured.add(id) }
    hasPointerCapture(id) { return this.captured.has(id) }
    releasePointerCapture(id) { this.captured.delete(id) }
    animate(keyframes, options) { const animation = { element: this, keyframes, options, cancelled: false, cancel() { this.cancelled = true } }; animations.push(animation); return animation }
  }
  const animations = []
  const nodes = new Map()
  for (const match of html.matchAll(/<([a-z-]+)[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const element = new Element(match[1])
    element.id = match[2]
    element.className = match[0].match(/class="([^"]*)"/)?.[1] || ''
    nodes.set(element.id, element)
  }
  const document = {
    body: new Element('body'), documentElement: new Element('html'), head: new Element('head'), listeners: new Map(),
    getElementById: id => nodes.get(id) || null,
    createElement: name => new Element(name), createDocumentFragment: () => new Element('fragment'),
    addEventListener(name, callback) { this.listeners.set(name, callback) }
  }
  const subscriptions = new Map()
  const calls = []
  const api = {}
  for (const name of ['onSongUpdate', 'onLyricUpdate', 'onTimeUpdate', 'onSettingsUpdate', 'onPlaybackUpdate', 'onLockChanged', 'onError']) {
    api[name] = callback => { subscriptions.set(name, callback); return () => subscriptions.delete(name) }
  }
  for (const name of ['changeSize', 'changeTheme', 'setTranslation', 'setLocked', 'control', 'beginResize', 'resizeBy']) {
    api[name] = (...args) => { calls.push({ name, args }); return actions[name] ? actions[name](...args) : Promise.resolve({ success: true }) }
  }
  for (const name of ['close', 'resize', 'endResize']) api[name] = (...args) => calls.push({ name, args })
  const media = new Element('media')
  media.matches = reducedMotion
  const window = new Element('window')
  window.desktopLyricAPI = api
  window.matchMedia = () => media
  const frames = new Map()
  const timers = new Map()
  let nextId = 0
  let now = 0
  let resizeCallback
  let resizeDisconnected = false
  const warnings = []
  const context = vm.createContext({
    window, document, Intl, performance: { now: () => now }, console: { warn: (...args) => warnings.push(args) },
    requestAnimationFrame(callback) { const id = ++nextId; frames.set(id, callback); return id },
    cancelAnimationFrame(id) { frames.delete(id) },
    setTimeout(callback) { const id = ++nextId; timers.set(id, callback); return id }, clearTimeout(id) { timers.delete(id) },
    ResizeObserver: class { constructor(callback) { resizeCallback = callback } observe() {} disconnect() { resizeDisconnected = true } }
  })
  vm.runInContext(source, context, { filename: 'desktopLyric.html' })
  document.listeners.get('DOMContentLoaded')()
  return {
    nodes, calls, animations, media, window, subscriptions, frames, timers, warnings,
    node: id => nodes.get(id),
    emit(name, ...args) { subscriptions.get(name)?.(...args) },
    flush(elapsed = 0) { now += elapsed; const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(now)) },
    resize() { resizeCallback() },
    dispose() { window.dispatch('beforeunload') },
    get resizeDisconnected() { return resizeDisconnected },
    classes() { return nodes.get('currentLyric').children.map(element => element.className) },
    fills() { return nodes.get('currentLyric').children.map(element => element.style['--fill-progress']) }
  }
}

function krc(time = 0, texts = ['甲', '乙', '丙']) {
  return { time, duration: texts.length * 1000, text: texts.join(''), isKrc: true, words: texts.map((word, i) => ({ word, startTime: i * 1000, endTime: (i + 1) * 1000, duration: 1000 })) }
}
function song(fixture, trackId = 'controlled') { fixture.emit('onSongUpdate', { trackId, title: 'Controlled track', artist: 'Placeholder' }) }


test('paused reopen renders the first frame at the correct line and grapheme progress', () => {
  const view = rendererFixture()
  song(view)
  view.emit('onLyricUpdate', [krc(), krc(5000)])
  view.emit('onPlaybackUpdate', { playing: false, time: 7500, duration: 12000, available: true })
  view.flush()
  assert.deepEqual(view.classes(), ['karaoke-char sung', 'karaoke-char sung', 'karaoke-char singing'])
  assert.deepEqual(view.fills(), ['100%', '100%', '50%'])
  assert.equal(view.node('playBtn').getAttribute('aria-label'), '播放')
  view.dispose()
})

test('forward/backward seeks and adjacent repeated lyrics recompute all characters', () => {
  const view = rendererFixture()
  song(view)
  view.emit('onLyricUpdate', [krc(), krc(4000)])
  view.emit('onTimeUpdate', 2500)
  view.flush()
  assert.deepEqual(view.fills(), ['100%', '100%', '50%'])
  view.emit('onTimeUpdate', 50)
  view.flush()
  assert.deepEqual(view.fills(), ['5%', '0%', '0%'])
  assert.deepEqual(view.classes(), ['karaoke-char singing', 'karaoke-char', 'karaoke-char'])
  view.emit('onTimeUpdate', 4100)
  view.flush()
  assert.deepEqual(view.fills(), ['10%', '0%', '0%'])
  view.dispose()
})

test('coalesced updates preserve the final paused seek and reject invalid positions', () => {
  const view = rendererFixture()
  song(view)
  view.emit('onLyricUpdate', [{ time: 0, text: 'first' }, { time: 10000, text: 'second' }])
  view.emit('onTimeUpdate', 1000)
  view.flush()
  view.emit('onTimeUpdate', 2000)
  view.emit('onTimeUpdate', 12000)
  view.emit('onTimeUpdate', NaN)
  view.emit('onTimeUpdate', -1)
  assert.equal(view.frames.size, 1)
  view.flush()
  assert.equal(view.node('currentLyric').textContent, 'second')
  view.dispose()
})

test('graphemes, whitespace, Japanese syllables and markup-looking text remain literal', () => {
  const view = rendererFixture()
  song(view)
  const words = ['こ', 'ん', 'に', 'ちは', '  ', '👨‍👩‍👧‍👦', 'e\u0301', '<img src=x>']
  view.emit('onLyricUpdate', [krc(0, words)])
  assert.equal(view.node('currentLyric').textContent, words.join(''))
  const spans = view.node('currentLyric').children
  assert.equal(spans.filter(span => span.textContent === '👨‍👩‍👧‍👦').length, 1)
  assert.equal(spans.filter(span => span.textContent === 'e\u0301').length, 1)
  assert.ok(spans.every(span => span.name === 'span'))
  view.emit('onTimeUpdate', 5500)
  view.flush()
  assert.equal(spans.find(span => span.textContent === '👨‍👩‍👧‍👦').style['--fill-progress'], '50%')
  view.dispose()
})

test('intro previews the first line and translation toggles never hide the available next line', () => {
  const view = rendererFixture()
  song(view)
  view.emit('onLyricUpdate', [{ time: 1000, text: '  First line  ', translation: '  第一行  ' }, { time: 4000, text: 'Second line' }])
  assert.equal(view.node('currentLyric').textContent, '♪ 前奏')
  assert.equal(view.node('nextLyric').textContent, '  First line  ')
  assert.equal(view.node('nextLyric').dataset.kind, 'intro')
  view.emit('onTimeUpdate', 1000)
  view.flush()
  assert.equal(view.node('nextLyric').textContent, '  第一行  ')
  assert.equal(view.node('nextLyric').dataset.kind, 'translation')
  view.emit('onSettingsUpdate', { showTranslation: false })
  assert.equal(view.node('nextLyric').textContent, 'Second line')
  view.emit('onSettingsUpdate', { showTranslation: true })
  assert.equal(view.node('nextLyric').textContent, '  第一行  ')
  view.emit('onTimeUpdate', 5000)
  view.flush()
  assert.equal(view.node('currentLyric').textContent, 'Second line')
  assert.equal(view.node('nextLyric').textContent, '')
  view.dispose()
})

test('long original and translation follow time, paused resize and font changes without an independent clock', () => {
  const view = rendererFixture({ reducedMotion: true })
  song(view)
  view.node('currentLyric').measuredWidth = 1000
  view.node('nextLyric').measuredWidth = 800
  view.node('currentViewport').clientWidth = 400
  view.node('nextViewport').clientWidth = 400
  view.emit('onLyricUpdate', [{ time: 0, text: 'long original', translation: 'long translation' }, { time: 10000, text: 'next' }])
  view.emit('onPlaybackUpdate', { playing: false, time: 5000, duration: 20000 })
  view.flush()
  assert.equal(view.node('currentLyric').style.transform, 'translateX(-300px)')
  assert.equal(view.node('nextLyric').style.transform, 'translateX(-200px)')
  assert.equal(view.frames.size, 0)
  assert.equal(view.animations.length, 0)
  view.node('currentViewport').clientWidth = 800
  view.resize()
  view.flush()
  assert.equal(view.node('currentLyric').style.transform, 'translateX(-100px)')
  view.node('currentLyric').measuredWidth = 1200
  view.emit('onSettingsUpdate', { fontSize: 'large' })
  assert.equal(view.node('currentLyric').style.transform, 'translateX(-200px)')
  view.emit('onTimeUpdate', 0)
  view.flush()
  assert.equal(view.node('currentLyric').style.transform, 'translateX(0px)')
  view.dispose()
})

test('track identity and clear events discard old lyrics even for identical titles', () => {
  const view = rendererFixture()
  song(view, 'first-hash')
  view.emit('onLyricUpdate', [krc()])
  view.emit('onTimeUpdate', 2500)
  view.flush()
  song(view, 'different-hash')
  assert.equal(view.node('currentLyric').textContent, '暂无歌词')
  assert.equal(view.node('nextLyric').textContent, '')
  view.emit('onLyricUpdate', [{ time: 0, text: 'LRC replacement' }])
  assert.equal(view.node('currentLyric').textContent, 'LRC replacement')
  assert.equal(view.node('currentLyric').children.length, 0)
  view.emit('onSongUpdate', null)
  assert.equal(view.node('currentLyric').textContent, '请播放音乐以显示歌词')
  assert.equal(view.node('playBtn').disabled, true)
  view.dispose()
})

test('controls use actual playback state, persist settings and remain retryable after failure', async () => {
  let rejectSize = true
  const view = rendererFixture({ actions: { changeSize: async () => ({ success: !rejectSize, error: rejectSize ? 'Controlled failure' : undefined }) } })
  assert.equal(view.node('playBtn').disabled, true)
  song(view)
  view.emit('onPlaybackUpdate', { playing: true, available: true })
  assert.equal(view.node('playBtn').getAttribute('aria-label'), '暂停')
  await view.node('playBtn').click()
  await view.node('previousBtn').click()
  await view.node('nextBtn').click()
  assert.deepEqual(view.calls.filter(call => call.name === 'control').map(call => call.args[0]), ['toggle', 'prev', 'next'])
  await view.node('sizeBtn').click()
  assert.ok(view.node('lyricContainer').classList.contains('size-medium'))
  assert.equal(view.node('controlFeedback').dataset.error, 'true')
  assert.equal(view.node('sizeBtn').disabled, false)
  rejectSize = false
  await view.node('sizeBtn').click()
  assert.ok(view.node('lyricContainer').classList.contains('size-large'))
  await view.node('themeBtn').click()
  assert.ok(view.node('lyricContainer').classList.contains('theme-gradient'))
  view.emit('onLyricUpdate', [{ time: 0, text: 'original', translation: 'translation' }, { time: 4000, text: 'next' }])
  await view.node('translationBtn').click()
  assert.equal(view.node('nextLyric').textContent, 'next')
  assert.equal(view.node('translationBtn').getAttribute('aria-pressed'), 'false')
  await view.node('lockBtn').click()
  assert.equal(view.node('controlMenu').inert, true)
  assert.equal(view.node('resizeHandle').disabled, true)
  view.emit('onSettingsUpdate', { locked: false })
  assert.equal(view.node('controlMenu').inert, false)
  view.emit('onPlaybackUpdate', { available: false })
  assert.equal(view.node('nextBtn').disabled, true)
  view.dispose()
})

test('delayed settings acknowledgements do not overwrite a newer authoritative snapshot', async () => {
  let complete
  const view = rendererFixture({ actions: { changeSize: () => new Promise(resolve => { complete = resolve }) } })
  const request = view.node('sizeBtn').click()
  assert.equal(view.node('sizeBtn').getAttribute('aria-busy'), 'true')
  view.emit('onSettingsUpdate', { fontSize: 'small' })
  complete({ success: true })
  await request
  assert.ok(view.node('lyricContainer').classList.contains('size-small'))
  assert.equal(view.node('sizeBtn').disabled, false)
  view.dispose()
})

test('main-process failures are visible as plain status text and unsubscribe on unload', () => {
  const view = rendererFixture()
  view.emit('onError', '窗口位置未能保存，请重试。')
  assert.equal(view.node('controlFeedback').textContent, '窗口位置未能保存，请重试。')
  assert.equal(view.node('controlFeedback').dataset.error, 'true')
  view.emit('onError', '<controlled-error>')
  assert.equal(view.node('controlFeedback').textContent, '<controlled-error>')
  assert.equal(view.node('controlFeedback').children.length, 0)
  view.dispose()
  assert.equal(view.subscriptions.has('onError'), false)
  assert.equal(view.timers.size, 0)
  view.emit('onError', 'late failure')
  assert.notEqual(view.node('controlFeedback').textContent, 'late failure')
})

test('pointer/keyboard resizing ends on cancellation, blur, lock and unload', async () => {
  const view = rendererFixture()
  const handle = view.node('resizeHandle')
  await handle.dispatch('pointerdown', { button: 0, pointerId: 7 })
  handle.dispatch('pointermove', { pointerId: 7 })
  assert.equal(view.calls.filter(call => call.name === 'resize').length, 2)
  handle.dispatch('pointercancel', { pointerId: 7 })
  assert.equal(handle.hasPointerCapture(7), false)
  assert.equal(view.calls.filter(call => call.name === 'endResize').length, 1)
  await handle.dispatch('keydown', { key: 'ArrowRight' })
  assert.deepEqual(JSON.parse(JSON.stringify(view.calls.find(call => call.name === 'resizeBy').args)), [{ width: 40, height: 0 }])
  await handle.dispatch('pointerdown', { button: 0, pointerId: 8 })
  view.window.dispatch('blur')
  await handle.dispatch('pointerdown', { button: 0, pointerId: 9 })
  view.emit('onSettingsUpdate', { locked: true })
  assert.equal(view.calls.filter(call => call.name === 'endResize').length, 3)
  view.emit('onSettingsUpdate', { locked: false })
  await handle.dispatch('pointerdown', { button: 0, pointerId: 10 })
  view.emit('onTimeUpdate', 1000)
  view.dispose()
  assert.equal(view.calls.filter(call => call.name === 'endResize').length, 4)
  assert.equal(view.frames.size, 0)
  assert.equal(view.timers.size, 0)
  assert.equal(view.subscriptions.size, 0)
  assert.equal(view.resizeDisconnected, true)
})

test('late resize acknowledgements and action results cannot revive an unloaded window', async () => {
  let finishResize
  let finishTheme
  const view = rendererFixture({ actions: { beginResize: () => new Promise(resolve => { finishResize = resolve }), changeTheme: () => new Promise(resolve => { finishTheme = resolve }) } })
  const resize = view.node('resizeHandle').dispatch('pointerdown', { button: 0, pointerId: 4 })
  view.node('resizeHandle').dispatch('pointerup', { pointerId: 4 })
  finishResize({ success: true })
  await resize
  assert.equal(view.calls.filter(call => call.name === 'resize').length, 0)
  const theme = view.node('themeBtn').click()
  view.dispose()
  finishTheme({ success: true })
  await theme
  assert.ok(view.node('lyricContainer').classList.contains('theme-classic'))
  assert.equal(view.timers.size, 0)
})

test('authoritative audio samples interpolate every frame with rate and a bounded horizon', () => {
  const view = rendererFixture()
  song(view)
  view.emit('onLyricUpdate', [krc()])
  view.emit('onPlaybackUpdate', { playing: true })
  view.emit('onTimeUpdate', 100, { advancing: true, playbackRate: 1 })
  view.flush()
  assert.equal(view.fills()[0], '10%')
  for (let frame = 1; frame <= 6; frame++) {
    view.flush(16)
    assert.equal(view.fills()[0], `${10 + frame * 1.6}%`)
  }
  view.flush(204)
  assert.equal(view.fills()[0], '40%')
  assert.equal(view.frames.size, 0, 'stale samples cannot run a second playback clock')
  view.emit('onTimeUpdate', 500, { advancing: true, playbackRate: 2 })
  view.flush(100)
  assert.equal(view.fills()[0], '70%')
  view.dispose()
  assert.equal(view.frames.size, 0)
})

test('pause, buffering, seek and track changes stop or reset interpolation immediately', () => {
  const view = rendererFixture()
  song(view)
  view.emit('onLyricUpdate', [krc()])
  view.emit('onPlaybackUpdate', { playing: true })
  view.emit('onTimeUpdate', 100, { advancing: true })
  view.flush(100)
  assert.equal(view.fills()[0], '20%')
  view.emit('onTimeUpdate', 210, { advancing: false })
  view.flush(100)
  assert.equal(view.fills()[0], '21%')
  assert.equal(view.frames.size, 0)
  view.emit('onTimeUpdate', 220, { advancing: true })
  view.flush(50)
  view.emit('onPlaybackUpdate', { playing: false, time: 280 })
  view.flush(100)
  assert.equal(view.fills()[0], '28%')
  assert.equal(view.frames.size, 0)
  view.emit('onTimeUpdate', 1400, { advancing: false, discontinuity: true })
  view.flush()
  assert.deepEqual(view.fills(), ['100%', '40%', '0%'])
  view.emit('onPlaybackUpdate', { playing: true })
  view.emit('onTimeUpdate', 100, { advancing: true, discontinuity: true })
  view.flush(20)
  assert.deepEqual(view.fills(), ['12%', '0%', '0%'])
  song(view, 'replacement')
  view.flush(400)
  assert.equal(view.frames.size, 0)
  assert.equal(view.node('currentLyric').textContent, '暂无歌词')
  view.dispose()
})

test('state broadcasts and replay cannot advance stale cached audio positions', () => {
  const view = rendererFixture()
  song(view)
  view.emit('onLyricUpdate', [krc()])
  view.emit('onTimeUpdate', 500, { advancing: false, discontinuity: true })
  view.emit('onPlaybackUpdate', { playing: true, time: 500, advancing: false, discontinuity: true })
  view.flush(1000)
  assert.equal(view.fills()[0], '50%')
  assert.equal(view.frames.size, 0)
  view.emit('onTimeUpdate', 600, { advancing: true })
  view.flush(20)
  view.emit('onPlaybackUpdate', { playing: true, time: 500, available: true })
  view.flush(20)
  assert.equal(view.fills()[0], '64%')
  view.dispose()
})

test('next preview keeps its beginning and rises into the current row only during consecutive playback', () => {
  const view = rendererFixture()
  song(view)
  view.node('currentLyric').measuredWidth = 1000
  view.node('nextLyric').measuredWidth = 1200
  view.node('currentViewport').clientWidth = 400
  view.node('nextViewport').clientWidth = 400
  view.emit('onLyricUpdate', [krc(), krc(3000, ['下', '一', '句']), krc(6000)])
  view.emit('onPlaybackUpdate', { playing: true })
  view.emit('onTimeUpdate', 2800, { advancing: true })
  view.flush()
  assert.equal(view.node('currentLyric').style.transform, 'translateX(-600px)')
  assert.equal(view.node('nextLyric').style.transform, 'translateX(0px)')
  view.flush(220)
  assert.equal(view.node('currentLyric').textContent, '下一句')
  const promotion = view.animations.find(animation => animation.element.id === 'currentViewport')
  assert.ok(promotion)
  assert.equal(promotion.keyframes[0].translate, '0 34px')
  assert.equal(promotion.keyframes[1].translate, '0 0')
  const count = view.animations.length
  view.emit('onTimeUpdate', 6000, { advancing: true, discontinuity: true })
  view.flush()
  assert.equal(promotion.cancelled, true)
  assert.equal(view.animations.length, count, 'a seek must not pretend the skipped preview became the current line')
  view.dispose()
})

test('reduced motion preserves smooth progress but skips preview promotion', () => {
  const view = rendererFixture({ reducedMotion: true })
  song(view)
  view.emit('onLyricUpdate', [krc(), krc(3000)])
  view.emit('onPlaybackUpdate', { playing: true })
  view.emit('onTimeUpdate', 2900, { advancing: true })
  view.flush(200)
  assert.equal(view.fills()[0], '10%')
  assert.equal(view.animations.length, 0)
  view.dispose()
})

test('delivery jitter at a line boundary cannot undo promotion and duplicate samples cannot extend the horizon', () => {
  const view = rendererFixture()
  song(view)
  view.emit('onLyricUpdate', [krc(), krc(3000, ['下', '一', '句'])])
  view.emit('onPlaybackUpdate', { playing: true })
  view.emit('onTimeUpdate', 2900, { advancing: true })
  view.flush(110)
  const firstCharacter = view.node('currentLyric').children[0]
  assert.equal(view.node('currentLyric').textContent, '下一句')
  view.emit('onTimeUpdate', 2995, { advancing: true })
  view.flush()
  assert.equal(view.node('currentLyric').children[0], firstCharacter)
  assert.equal(view.fills()[0], '1%')
  view.flush(100)
  view.emit('onTimeUpdate', 2995, { advancing: true })
  view.flush(200)
  assert.equal(view.fills()[0], '29.5%')
  assert.equal(view.frames.size, 0)
  view.dispose()
})
