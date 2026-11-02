const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const html = fs.readFileSync(path.join(__dirname, '../electron/taskbarLyric.html'), 'utf8')
const source = html.match(/<script>([\s\S]*?)<\/script>/)[1]

/** Run the actual renderer against controlled IPC, frame time, DOM measurements and image loading. */
function fixture({ reducedMotion = false, control } = {}) {
  const images = []
  const animations = []
  class Element {
    constructor(name = 'div') {
      this.name = name
      this.children = []
      this.dataset = {}
      this.listeners = new Map()
      this.attributes = new Map()
      this.className = ''
      this._text = ''
      this.clientWidth = 200
      this.hidden = false
      this.disabled = false
      this.style = { setProperty(key, value) { this[key] = value } }
      this.classList = {
        contains: name => this.className.split(/\s+/).includes(name),
        toggle: (name, enabled) => {
          const values = this.className.split(/\s+/).filter(value => value && value !== name)
          if (enabled) values.push(name)
          this.className = values.join(' ')
        }
      }
    }
    get textContent() { return this.children.length ? this.children.map(child => child.textContent).join('') : this._text }
    set textContent(value) { this._text = String(value); this.children = [] }
    get scrollWidth() { return this.measuredWidth ?? Array.from(this.textContent).length * 15 }
    appendChild(child) {
      this._text = ''
      if (child.name === 'fragment') child.children.forEach(value => this.appendChild(value))
      else this.children.push(child)
      return child
    }
    replaceChildren(...children) { this._text = ''; this.children = []; children.forEach(child => this.appendChild(child)) }
    setAttribute(name, value) { this.attributes.set(name, String(value)) }
    getAttribute(name) { return this.attributes.get(name) ?? null }
    removeAttribute(name) { this.attributes.delete(name); if (name === 'src') this.src = '' }
    addEventListener(name, handler) { this.listeners.set(name, handler) }
    removeEventListener(name, handler) { if (this.listeners.get(name) === handler) this.listeners.delete(name) }
    dispatch(name, value = {}) { return this.listeners.get(name)?.({ target: this, preventDefault() {}, ...value }) }
    click() { if (!this.disabled) return this.dispatch('click') }
    animate() { const animation = { cancelled: false, cancel() { this.cancelled = true } }; animations.push(animation); return animation }
  }
  const nodes = new Map()
  for (const match of html.matchAll(/<([a-z-]+)[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const node = new Element(match[1])
    node.className = match[0].match(/class="([^"]*)"/)?.[1] || ''
    node.hidden = /\bhidden\b/.test(match[0])
    nodes.set(match[2], node)
  }
  const document = {
    listeners: new Map(), getElementById: id => nodes.get(id),
    addEventListener(name, callback) { this.listeners.set(name, callback) },
    createDocumentFragment: () => new Element('fragment'),
    createElement(name) { const element = new Element(name); if (name === 'img') images.push(element); return element }
  }
  const subscriptions = new Map()
  const calls = []
  const api = {}
  for (const name of ['onSongUpdate', 'onLyricUpdate', 'onTimeUpdate', 'onPlaybackUpdate', 'onSettingsUpdate', 'onRuntimeState', 'onState', 'onError']) {
    api[name] = callback => { subscriptions.set(name, callback); return () => subscriptions.delete(name) }
  }
  api.control = (...args) => { calls.push({ name: 'control', args }); return control ? control(...args) : Promise.resolve({ success: true }) }
  api.ready = () => calls.push({ name: 'ready', subscriptions: subscriptions.size })
  api.resize = value => calls.push({ name: 'resize', value: JSON.parse(JSON.stringify(value)) })
  const media = new Element('media')
  media.matches = reducedMotion
  const window = new Element('window')
  window.innerWidth = 360
  window.innerHeight = 48
  window.taskbarLyricAPI = api
  window.matchMedia = () => media
  const frames = new Map()
  let nextId = 0
  let now = 0
  let resizeDisconnected = false
  let onResize
  const warnings = []
  const context = vm.createContext({
    window, document, Intl, performance: { now: () => now }, console: { warn: (...args) => warnings.push(args) },
    requestAnimationFrame(callback) { const id = ++nextId; frames.set(id, callback); return id },
    cancelAnimationFrame(id) { frames.delete(id) },
    ResizeObserver: class { constructor(callback) { onResize = callback } observe() {} disconnect() { resizeDisconnected = true } }
  })
  vm.runInContext(source, context, { filename: 'taskbarLyric.html' })
  document.listeners.get('DOMContentLoaded')()
  const view = {
    images, animations, nodes, media, window, calls, frames, subscriptions, warnings,
    node: id => nodes.get(id),
    emit(name, ...args) { subscriptions.get(name)?.(...args) },
    flush(at = now) { now = at; const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(now)) },
    advance(at) { now = at },
    resize() { onResize() },
    dispose() { window.dispatch('beforeunload') },
    get resizeDisconnected() { return resizeDisconnected },
    fills() { return nodes.get('currentLyric').children.map(element => element.style['--fill-progress']) }
  }
  view.flush()
  return view
}

function song(view, trackId = 'first', cover = null) {
  view.emit('onSongUpdate', { trackId, title: '测试歌曲', artist: '测试歌手', cover })
}
function krc(time = 0, words = ['甲', '乙', '丙']) {
  return { time, duration: words.length * 1000, text: words.join(''), isKrc: true, words: words.map((word, i) => ({ word, startTime: i * 1000, duration: 1000 })) }
}

test('subscriptions precede ready and paused replay, repeated lines and seeks use absolute time', () => {
  const view = fixture()
  assert.deepEqual(view.calls[0], { name: 'ready', subscriptions: 8 })
  song(view)
  view.emit('onLyricUpdate', [krc(), krc(5000)])
  view.emit('onPlaybackUpdate', { playing: false, available: true, time: 7500, duration: 10000 })
  view.flush()
  assert.deepEqual(view.fills(), ['100%', '100%', '50%'])
  assert.equal(view.node('playBtn').getAttribute('aria-label'), '播放')
  view.emit('onTimeUpdate', 50, { discontinuity: true })
  view.flush()
  assert.deepEqual(view.fills(), ['5%', '0%', '0%'])
  view.emit('onTimeUpdate', 5100, { discontinuity: true })
  view.flush()
  assert.deepEqual(view.fills(), ['10%', '0%', '0%'])
  assert.equal(view.frames.size, 0)
  view.dispose()
})

test('interpolation is bounded, repeated samples do not extend it and buffering or pause freezes immediately', () => {
  const view = fixture()
  song(view)
  view.emit('onLyricUpdate', [krc()])
  view.emit('onPlaybackUpdate', { playing: true, available: true })
  view.emit('onTimeUpdate', 100, { advancing: true, playbackRate: 2 })
  view.flush(100)
  assert.deepEqual(view.fills(), ['30%', '0%', '0%'])
  view.emit('onTimeUpdate', 100, { advancing: true, playbackRate: 2 })
  view.flush(300)
  assert.deepEqual(view.fills(), ['70%', '0%', '0%'])
  assert.equal(view.frames.size, 0)
  view.emit('onTimeUpdate', 700, { advancing: false })
  view.flush(1000)
  assert.deepEqual(view.fills(), ['70%', '0%', '0%'])
  view.emit('onTimeUpdate', 1100, { advancing: true })
  view.flush(1100)
  view.emit('onPlaybackUpdate', { playing: false, time: 1200 })
  view.flush(1500)
  assert.deepEqual(view.fills(), ['100%', '20%', '0%'])
  assert.equal(view.frames.size, 0)
  view.dispose()
})

test('hidden taskbar keeps the newest snapshots without paint work and resumes at the latest time', () => {
  const view = fixture()
  song(view)
  view.emit('onLyricUpdate', [krc(), krc(5000)])
  view.emit('onPlaybackUpdate', { playing: true, available: true })
  view.emit('onTimeUpdate', 100, { advancing: true })
  view.flush(100)
  view.emit('onRuntimeState', { hidden: true })
  assert.equal(view.frames.size, 0)
  view.emit('onTimeUpdate', 5500, { advancing: true })
  view.emit('onSettingsUpdate', { contentAlignment: 'right' })
  assert.equal(view.frames.size, 0)
  view.emit('onState', { visible: true, embedded: true })
  view.flush(200)
  assert.deepEqual(view.fills(), ['60%', '0%', '0%'])
  assert.equal(view.node('taskbar').classList.contains('embedded'), true)
  view.dispose()
})

test('Unicode graphemes, whitespace and untrusted lyric markup remain text with correct per-word timing', () => {
  const view = fixture()
  song(view)
  const words = ['  ', '👨‍👩‍👧‍👦', 'e\u0301', '<img src=x>']
  view.emit('onLyricUpdate', [{ ...krc(0, words), translation: '  <b>翻译</b>  ', romanization: 'romaji' }])
  view.emit('onTimeUpdate', 1500)
  view.flush()
  const children = view.node('currentLyric').children
  assert.equal(view.node('currentLyric').textContent, words.join(''))
  assert.equal(children.filter(node => node.textContent === '👨‍👩‍👧‍👦').length, 1)
  assert.equal(children.find(node => node.textContent === '👨‍👩‍👧‍👦').style['--fill-progress'], '50%')
  assert.equal(children.filter(node => node.textContent === 'e\u0301').length, 1)
  assert.ok(children.every(node => node.name === 'span'))
  assert.equal(view.node('secondaryLyric').textContent, 'romaji ·   <b>翻译</b>  ')
  assert.equal(view.node('secondaryLyric').children.length, 0)
  view.dispose()
})

test('translation, next-line preview, original position, single line, metadata and karaoke settings affect the visible content', () => {
  const view = fixture()
  song(view)
  view.emit('onLyricUpdate', [{ ...krc(), translation: '译文', romanization: '音译' }, { time: 5000, text: '下一句' }])
  view.emit('onSettingsUpdate', { hideTranslation: true, originalPosition: 'bottom' })
  view.flush()
  assert.equal(view.node('secondaryLyric').textContent, '下一句')
  assert.equal(view.node('lyrics').classList.contains('reversed'), true)
  view.emit('onSettingsUpdate', { hideTranslation: false, showTranslation: false, karaoke: false })
  view.flush()
  assert.equal(view.node('currentLyric').textContent, '甲乙丙')
  assert.equal(view.node('currentLyric').children.length, 0)
  assert.equal(view.node('secondaryLyric').textContent, '音译')
  view.emit('onSettingsUpdate', { showTranslation: true, songInfoOnly: true })
  view.flush()
  assert.equal(view.node('currentLyric').textContent, '测试歌曲')
  assert.equal(view.node('secondaryLyric').textContent, '测试歌手')
  view.emit('onSettingsUpdate', { doubleLine: false })
  view.flush()
  assert.equal(view.node('currentLyric').textContent, '测试歌曲 · 测试歌手')
  assert.equal(view.node('secondaryViewport').hidden, true)
  view.dispose()
})

test('long current lyrics scroll with audio while the next-line preview stays at its beginning', () => {
  const view = fixture()
  song(view)
  view.node('currentLyric').measuredWidth = 600
  view.node('secondaryLyric').measuredWidth = 500
  view.emit('onLyricUpdate', [{ time: 0, duration: 10000, text: 'long current line' }, { time: 10000, text: 'long next line' }])
  view.emit('onTimeUpdate', 5000)
  view.flush()
  assert.equal(view.node('currentLyric').style.transform, 'translateX(-200px)')
  assert.equal(view.node('secondaryLyric').style.transform, 'translateX(0px)')
  view.emit('onLyricUpdate', [{ time: 0, duration: 10000, text: 'long current line', translation: 'translation' }])
  view.flush()
  assert.equal(view.node('secondaryLyric').style.transform, 'translateX(-150px)')
  view.emit('onTimeUpdate', 0, { discontinuity: true })
  view.flush()
  assert.equal(view.node('currentLyric').style.transform, 'translateX(0px)')
  view.dispose()
})

test('same-identity metadata preserves lyrics while a new track or stop clears old state and stale artwork', () => {
  const view = fixture()
  song(view, 'one', 'https://example.test/one.png')
  view.emit('onLyricUpdate', [krc()])
  view.flush()
  const first = view.images[0]
  const lateLoad = first.onload
  view.emit('onSongUpdate', { trackId: 'one', title: 'changed metadata', artist: 'same' })
  view.flush()
  assert.equal(view.node('currentLyric').textContent, '甲乙丙')
  song(view, 'two', 'https://example.test/two.png')
  view.flush()
  assert.equal(view.node('currentLyric').textContent, '测试歌曲')
  assert.equal(view.node('playBtn').disabled, true)
  lateLoad()
  assert.equal(view.node('artwork').children.length, 0)
  view.images.at(-1).onload()
  assert.equal(view.node('artwork').children[0].src, 'https://example.test/two.png')
  view.emit('onSongUpdate', null)
  view.flush()
  assert.equal(view.node('currentLyric').textContent, '等待播放音乐')
  assert.equal(view.node('artwork').children.length, 0)
  assert.equal(view.node('secondaryLyric').textContent, '')
  view.dispose()
})

test('size recommendations reclaim hidden slots, are deduplicated and respect fixed sizing preference', () => {
  const view = fixture()
  song(view)
  view.node('currentLyric').measuredWidth = 400
  view.emit('onSettingsUpdate', { adaptive: true, showLogo: true, logoUrl: 'file:///application/logo.png', albumAlignment: 'right', contentAlignment: 'center' })
  view.flush()
  const width = view.calls.filter(call => call.name === 'resize').at(-1).value.width
  assert.equal(view.node('artwork').style.order, '2')
  assert.equal(view.node('logo').hidden, false)
  const count = view.calls.length
  view.resize()
  view.flush()
  assert.equal(view.calls.length, count)
  view.emit('onSettingsUpdate', { showLogo: false, showAlbum: false, showControls: false })
  view.flush()
  assert.ok(view.calls.filter(call => call.name === 'resize').at(-1).value.width < width)
  assert.equal(view.node('controls').hidden, true)
  view.emit('onSettingsUpdate', { adaptive: false })
  view.flush()
  assert.equal(view.calls.filter(call => call.name === 'resize').at(-1).value.width, 480)
  view.emit('onSettingsUpdate', { showLogo: true, logoUrl: 'https://example.test/invalid-logo' })
  assert.equal(view.node('logo').hidden, true)
  assert.equal(view.node('logo').src, '')
  view.dispose()
})

test('native height padding never feeds back into content height recommendations', () => {
  const view = fixture()
  const initial = view.calls.filter(call => call.name === 'resize').at(-1).value.height
  view.emit('onSettingsUpdate', { doubleLine: true, fontScale: 1.5, lineGap: 4 })
  view.flush()
  const suggested = view.calls.filter(call => call.name === 'resize').at(-1).value.height
  assert.ok(suggested > initial)
  view.window.innerHeight = suggested + 8
  view.window.dispatch('resize')
  view.flush()
  assert.equal(view.calls.filter(call => call.name === 'resize').at(-1).value.height, suggested)
  view.window.innerHeight = suggested + 16
  view.window.dispatch('resize')
  view.flush()
  assert.equal(view.calls.filter(call => call.name === 'resize').at(-1).value.height, suggested)
  view.dispose()
})

test('taskbar theme follows native state while explicit colors override it and large fonts fit native height', () => {
  const view = fixture()
  view.emit('onState', { dark: false })
  assert.equal(view.node('taskbar').classList.contains('light'), true)
  view.emit('onSettingsUpdate', { dark: true })
  assert.equal(view.node('taskbar').classList.contains('light'), true, 'native taskbar theme wins over the application theme fallback')
  view.emit('onSettingsUpdate', { colorMode: 'dark', fontScale: 2, fontFamily: 'Name"\\Sans', lineGap: 20 })
  assert.equal(view.node('taskbar').classList.contains('light'), false)
  const style = view.node('taskbar').style
  assert.ok(parseFloat(style['--line-height']) + parseFloat(style['--secondary-height']) + parseFloat(style['--line-gap']) <= 44)
  assert.equal(view.node('currentLyric').style.fontFamily, '"Name\\"\\\\Sans"')
  view.emit('onSettingsUpdate', { colorMode: 'light' })
  view.emit('onState', { dark: true })
  assert.equal(view.node('taskbar').classList.contains('light'), true)
  view.dispose()
})

test('controls use real playback acknowledgements, suppress duplicate clicks and offer visible retry after failure', async () => {
  let finish
  const view = fixture({ control: () => new Promise(resolve => { finish = resolve }) })
  assert.equal(view.node('playBtn').disabled, true)
  song(view)
  view.emit('onPlaybackUpdate', { playing: true, available: true })
  const request = view.node('playBtn').click()
  view.node('playBtn').click()
  assert.equal(view.calls.filter(call => call.name === 'control').length, 1)
  assert.equal(view.node('playBtn').getAttribute('aria-label'), '暂停')
  assert.equal(view.node('playBtn').getAttribute('aria-busy'), 'true')
  finish({ success: false, error: 'Controlled failure' })
  await request
  assert.equal(view.node('feedback').hidden, false)
  assert.equal(view.node('feedback').textContent, 'Controlled failure')
  view.node('feedback').click()
  assert.equal(view.node('feedback').hidden, true)
  const retry = view.node('playBtn').click()
  finish({ success: true })
  await retry
  assert.equal(view.node('playBtn').getAttribute('aria-label'), '暂停')
  view.emit('onPlaybackUpdate', { playing: false, available: false })
  assert.equal(view.node('playBtn').getAttribute('aria-label'), '播放')
  assert.equal(view.node('playBtn').disabled, true)
  view.dispose()
})

test('motion changes and unload release frames, observers, listeners, image callbacks and late actions', async () => {
  let finish
  const view = fixture({ control: () => new Promise(resolve => { finish = resolve }) })
  song(view, 'one', 'https://example.test/image.png')
  view.emit('onLyricUpdate', [krc()])
  view.emit('onPlaybackUpdate', { playing: true, available: true })
  view.emit('onTimeUpdate', 0, { advancing: true })
  view.flush()
  assert.ok(view.animations.length > 0)
  view.media.matches = true
  view.media.dispatch('change')
  assert.ok(view.animations.every(animation => animation.cancelled))
  const count = view.animations.length
  song(view, 'two')
  view.flush()
  assert.equal(view.animations.length, count)
  view.emit('onPlaybackUpdate', { playing: true, available: true })
  const action = view.node('nextBtn').click()
  view.dispose()
  finish({ success: false, error: 'late failure' })
  await action
  assert.equal(view.frames.size, 0)
  assert.equal(view.subscriptions.size, 0)
  assert.equal(view.window.listeners.size, 0)
  assert.equal(view.media.listeners.size, 0)
  assert.equal(view.resizeDisconnected, true)
  assert.equal(view.images[0].onload, null)
  assert.equal(view.node('feedback').textContent, '')
})
