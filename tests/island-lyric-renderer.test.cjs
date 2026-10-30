const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const html = fs.readFileSync(path.join(__dirname, '../electron/islandLyric.html'), 'utf8')
const source = html.match(/<script>([\s\S]*?)<\/script>/)[1]

/** Execute the production renderer with controlled IPC, measured text, image loads and browser events. */
function rendererFixture({ reducedMotion = false, actions = {} } = {}) {
  const animations = []
  const images = []
  class Element {
    constructor(name = 'div') {
      this.name = name
      this.children = []
      this.dataset = {}
      this.attributes = new Map()
      this.listeners = new Map()
      this.className = ''
      this._text = ''
      this.clientWidth = 260
      this.disabled = false
      this.inert = false
      this.hidden = false
      this.captured = new Set()
      this.style = { setProperty(name, value) { this[name] = value } }
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
    appendChild(child) {
      this._text = ''
      if (child.name === 'fragment') child.children.forEach(item => this.appendChild(item))
      else { child.parentElement = this; this.children.push(child) }
      return child
    }
    replaceChildren(...children) { this.children = []; this._text = ''; children.forEach(child => this.appendChild(child)) }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this) }
    setAttribute(name, value) { this.attributes.set(name, String(value)) }
    getAttribute(name) { return this.attributes.get(name) ?? null }
    removeAttribute(name) { this.attributes.delete(name); if (name === 'src') this.src = '' }
    addEventListener(name, callback) { this.listeners.set(name, callback) }
    removeEventListener(name, callback) { if (this.listeners.get(name) === callback) this.listeners.delete(name) }
    dispatch(name, event = {}) { return this.listeners.get(name)?.({ preventDefault() {}, target: this, currentTarget: this, ...event }) }
    click() { return !this.disabled && !this.inert ? this.dispatch('click') : undefined }
    focus() { document.activeElement = this; nodes.get('island').dispatch('focusin') }
    blur() { if (document.activeElement === this) document.activeElement = document.body; nodes.get('island').dispatch('focusout') }
    contains(element) { return element === this || Boolean(element && this.containsParent(element.parentElement)) }
    containsParent(element) { return Boolean(element && (element === this || this.containsParent(element.parentElement))) }
    closest(name) { return this.name === name ? this : this.parentElement?.closest(name) || null }
    setPointerCapture(id) { this.captured.add(id) }
    hasPointerCapture(id) { return this.captured.has(id) }
    releasePointerCapture(id) { this.captured.delete(id) }
    getBoundingClientRect() {
      const root = nodes.get('island')
      const scale = Number(document.body.style.transform?.match(/scale\(([^)]+)\)/)?.[1]) || 1
      const width = Math.min(380 * scale, window.innerWidth)
      const height = parseFloat(root.style[root.classList.contains('expanded') ? '--expanded-height' : '--compact-height']) || (root.classList.contains('expanded') ? 132 : 50)
      const rect = { left: (window.innerWidth - width) / 2, top: root.classList.contains('floating') ? 8 * scale : 0, width, height: height * scale }
      return this.id === 'details' ? { left: rect.left + 12 * scale, top: rect.top + 24 * scale, width: rect.width - 24 * scale, height: rect.height - 24 * scale } : rect
    }
    animate() { const animation = { cancelled: false, cancel() { this.cancelled = true } }; animations.push(animation); return animation }
  }
  const nodes = new Map()
  for (const match of html.matchAll(/<([a-z-]+)[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const element = new Element(match[1])
    element.id = match[2]
    element.className = match[0].match(/class="([^"]*)"/)?.[1] || ''
    element.inert = /\binert\b/.test(match[0])
    element.hidden = /\bhidden\b/.test(match[0])
    nodes.set(element.id, element)
  }
  const document = {
    body: new Element('body'), listeners: new Map(),
    getElementById: id => nodes.get(id),
    createElement(name) { const element = new Element(name); if (name === 'img') images.push(element); return element },
    createDocumentFragment: () => new Element('fragment'),
    addEventListener(name, callback) { this.listeners.set(name, callback) }
  }
  document.activeElement = document.body
  nodes.forEach(node => { if (node.id !== 'island') node.parentElement = nodes.get('island') })
  for (const id of ['previousBtn', 'playBtn', 'nextBtn', 'translationBtn', 'closeBtn', 'feedback']) nodes.get(id).parentElement = nodes.get('details')
  for (const id of ['currentViewport', 'nextViewport', 'leftSlot', 'rightSlot']) nodes.get(id).parentElement = nodes.get('notchToggle')
  const subscriptions = new Map()
  const calls = []
  const api = {}
  for (const name of ['onSongUpdate', 'onLyricUpdate', 'onTimeUpdate', 'onSettingsUpdate', 'onPlaybackUpdate', 'onError', 'onPointerUpdate']) {
    api[name] = callback => { subscriptions.set(name, callback); return () => subscriptions.delete(name) }
  }
  for (const name of ['setTranslation', 'control', 'close', 'beginDrag', 'endDrag']) {
    api[name] = (...args) => { calls.push({ name, args }); return actions[name] ? actions[name](...args) : Promise.resolve({ success: true }) }
  }
  api.setInteractive = value => calls.push({ name: 'setInteractive', args: [value] })
  api.drag = () => calls.push({ name: 'drag', args: [] })
  const media = new Element('media')
  media.matches = reducedMotion
  const window = new Element('window')
  window.innerWidth = 560
  window.innerHeight = 160
  window.islandLyricAPI = api
  window.matchMedia = () => media
  const frames = new Map()
  const timers = new Map()
  let nextId = 0
  let resizeCallback
  let resizeDisconnected = false
  const warnings = []
  const context = vm.createContext({
    window, document, Intl, console: { warn: (...args) => warnings.push(args) },
    requestAnimationFrame(callback) { const id = ++nextId; frames.set(id, callback); return id },
    cancelAnimationFrame(id) { frames.delete(id) },
    setTimeout(callback, delay) { const id = ++nextId; timers.set(id, { callback, delay }); return id }, clearTimeout(id) { timers.delete(id) },
    ResizeObserver: class { constructor(callback) { resizeCallback = callback } observe() {} disconnect() { resizeDisconnected = true } }
  })
  vm.runInContext(source, context, { filename: 'islandLyric.html' })
  document.listeners.get('DOMContentLoaded')()
  return {
    calls, animations, media, window, document, subscriptions, frames, timers, warnings, images,
    node: id => nodes.get(id),
    emit(name, ...args) { subscriptions.get(name)?.(...args) },
    flush() { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback()) },
    expire(delay) { for (const [id, timer] of [...timers]) if (timer.delay === delay) { timers.delete(id); timer.callback() } },
    resize() { resizeCallback() },
    dispose() { window.dispatch('beforeunload') },
    get resizeDisconnected() { return resizeDisconnected },
    fills() { return nodes.get('currentLyric').children.map(element => element.style['--fill-progress']) }
  }
}

function krc(time = 0, texts = ['甲', '乙', '丙']) {
  return { time, duration: texts.length * 1000, text: texts.join(''), isKrc: true, words: texts.map((word, i) => ({ word, startTime: i * 1000, duration: 1000 })) }
}
function song(view, trackId = 'controlled', cover = null) {
  view.emit('onSongUpdate', { trackId, title: 'Controlled track', artist: 'Placeholder', cover })
}

test('paused reopen, forward/backward seeks and repeated lines calculate glyphs from absolute playback time', () => {
  const view = rendererFixture()
  song(view)
  view.emit('onLyricUpdate', [krc(), krc(5000)])
  view.emit('onPlaybackUpdate', { playing: false, time: 7500, duration: 12000, available: true })
  view.flush()
  assert.deepEqual(view.fills(), ['100%', '100%', '50%'])
  assert.equal(view.node('playBtn').getAttribute('aria-label'), '播放')
  assert.equal(view.node('island').classList.contains('playing'), false)
  assert.equal(view.node('progressFill').style.transform, 'scaleX(0.625)')
  view.emit('onTimeUpdate', 50)
  view.flush()
  assert.deepEqual(view.fills(), ['5%', '0%', '0%'])
  view.emit('onTimeUpdate', 5100)
  view.flush()
  assert.deepEqual(view.fills(), ['10%', '0%', '0%'])
  assert.equal(view.frames.size, 0)
  view.dispose()
})

test('coalesced updates keep the last valid paused position and never create a playback clock', () => {
  const view = rendererFixture()
  song(view)
  view.emit('onLyricUpdate', [{ time: 0, text: 'first' }, { time: 10000, text: 'second' }])
  view.emit('onTimeUpdate', 2000)
  view.emit('onTimeUpdate', 12000)
  view.emit('onTimeUpdate', NaN)
  view.emit('onTimeUpdate', -1)
  assert.equal(view.frames.size, 1)
  view.flush()
  assert.equal(view.node('currentLyric').textContent, 'second')
  assert.equal(view.frames.size, 0)
  assert.equal(view.timers.size, 0)
  view.dispose()
})

test('Unicode graphemes, spaces, original and translated markup remain plain text', () => {
  const view = rendererFixture()
  song(view)
  const words = ['こ', 'ん', '  ', '👨‍👩‍👧‍👦', 'e\u0301', '<img src=x>']
  view.emit('onLyricUpdate', [{ ...krc(0, words), translation: '  <b>翻译</b>  ' }])
  assert.equal(view.node('currentLyric').textContent, words.join(''))
  const spans = view.node('currentLyric').children
  assert.equal(spans.filter(span => span.textContent === '👨‍👩‍👧‍👦').length, 1)
  assert.equal(spans.filter(span => span.textContent === 'e\u0301').length, 1)
  assert.ok(spans.every(span => span.name === 'span'))
  assert.equal(view.node('nextLyric').textContent, '  <b>翻译</b>  ')
  assert.equal(view.node('nextLyric').children.length, 0)
  view.emit('onTimeUpdate', 3500)
  view.flush()
  assert.equal(spans.find(span => span.textContent === '👨‍👩‍👧‍👦').style['--fill-progress'], '50%')
  view.dispose()
})

test('intro, translation preference and the next line remain synchronized across settings changes', () => {
  const view = rendererFixture()
  song(view)
  view.emit('onLyricUpdate', [{ time: 1000, text: '  First line  ', translation: '  第一行  ' }, { time: 4000, text: 'Second line' }])
  assert.equal(view.node('currentLyric').textContent, '♪ 前奏')
  assert.equal(view.node('nextLyric').textContent, '  First line  ')
  view.emit('onTimeUpdate', 1000)
  view.flush()
  assert.equal(view.node('nextLyric').textContent, '  第一行  ')
  view.emit('onSettingsUpdate', { showTranslation: false })
  assert.equal(view.node('nextLyric').textContent, 'Second line')
  view.emit('onSettingsUpdate', { showTranslation: true })
  assert.equal(view.node('nextLyric').textContent, '  第一行  ')
  view.dispose()
})

test('romanization and translation share the secondary row and obey the island annotation preference', () => {
  const view = rendererFixture()
  song(view)
  view.emit('onSettingsUpdate', { alwaysTwoLines: true })
  view.emit('onLyricUpdate', [{ time: 0, text: '原句', romanization: '<b>fu shui</b> 😀', translation: 'Translation' }, { time: 10000, text: '下一句' }])
  assert.equal(view.node('nextLyric').textContent, '<b>fu shui</b> 😀 · Translation')
  assert.equal(view.node('nextLyric').children.length, 0)
  assert.equal(view.node('nextLyric').dataset.kind, 'romanization')
  view.emit('onSettingsUpdate', { showTranslation: false })
  assert.equal(view.node('nextLyric').textContent, '<b>fu shui</b> 😀')
  view.emit('onSettingsUpdate', { hideTranslation: true })
  assert.equal(view.node('nextLyric').textContent, '下一句')
  view.emit('onSettingsUpdate', { hideTranslation: false, songInfoOnly: true })
  assert.equal(view.node('nextLyric').textContent, 'Placeholder')
  view.emit('onSettingsUpdate', { songInfoOnly: false, alwaysTwoLines: false })
  assert.equal(view.node('island').classList.contains('two-lines'), false)
  view.emit('onLyricUpdate', [{ time: 0, text: '原句', romanization: { invalid: true } }, { time: 10000, text: '下一句' }])
  assert.equal(view.node('nextLyric').textContent, '下一句')
  view.dispose()
})

test('long lines follow paused position and remeasure when the island expands', () => {
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
  view.node('currentViewport').clientWidth = 800
  view.resize()
  view.flush()
  assert.equal(view.node('currentLyric').style.transform, 'translateX(-100px)')
  assert.equal(view.frames.size, 0)
  assert.equal(view.animations.length, 0)
  view.dispose()
})

test('track identity, metadata updates and stopping clear all stale content and progress', () => {
  const view = rendererFixture()
  song(view, 'first')
  view.emit('onLyricUpdate', [krc()])
  view.emit('onTimeUpdate', 2500, { duration: 10000 })
  view.flush()
  song(view, 'different')
  assert.equal(view.node('currentLyric').textContent, 'Controlled track')
  assert.equal(view.node('nextLyric').textContent, '暂无歌词 · 享受此刻的音乐')
  assert.equal(view.node('progressFill').style.transform, 'scaleX(0)')
  view.emit('onSongUpdate', { trackId: 'different', title: 'Updated metadata', artist: 'Singer' })
  assert.equal(view.node('currentLyric').textContent, 'Updated metadata')
  view.emit('onSongUpdate', null)
  assert.equal(view.node('currentLyric').textContent, '等待播放音乐')
  assert.equal(view.node('nextLyric').textContent, '')
  assert.equal(view.node('playBtn').disabled, true)
  view.dispose()
})

test('late artwork loads cannot reappear after switching, clearing or unloading', () => {
  const view = rendererFixture()
  song(view, 'one', 'https://example.test/one.jpg')
  const first = view.images[1]
  song(view, 'two', 'https://example.test/two.jpg')
  const second = view.images[3]
  first.onload()
  assert.equal(view.node('rightCover').children.length, 0)
  second.onload()
  assert.equal(view.node('rightCover').children[0], second)
  song(view, 'three', 'javascript:alert(1)')
  assert.equal(view.node('rightCover').children.length, 0)
  assert.equal(view.images.length, 4)
  song(view, 'four', 'https://example.test/four.jpg')
  view.dispose()
  view.images[5].onload()
  assert.equal(view.node('rightCover').children.length, 0)
})

test('floating controls open only on click, context menu or keyboard activation, never on hover or focus', () => {
  const view = rendererFixture()
  view.emit('onSettingsUpdate', { mode: 'floating' })
  const island = view.node('island')
  const toggle = view.node('notchToggle')
  assert.equal(view.node('details').inert, true)
  view.window.dispatch('mousemove', { clientX: 200, clientY: 40 })
  assert.equal(island.classList.contains('expanded'), false)
  toggle.focus()
  assert.equal(island.classList.contains('expanded'), false)
  toggle.click()
  assert.equal(island.classList.contains('expanded'), true)
  assert.equal(view.node('details').inert, false)
  island.dispatch('mouseleave')
  view.expire(220)
  assert.equal(island.classList.contains('expanded'), false)
  island.dispatch('keydown', { key: 'Enter', target: toggle })
  assert.equal(island.classList.contains('expanded'), true)
  island.dispatch('keydown', { key: 'Escape' })
  assert.equal(island.classList.contains('expanded'), false)
  assert.equal(view.node('details').inert, true)
  assert.equal(view.document.activeElement, toggle)
  island.dispatch('keydown', { key: ' ', target: toggle })
  assert.equal(island.classList.contains('expanded'), true)
  view.window.dispatch('blur')
  view.expire(220)
  assert.equal(island.classList.contains('expanded'), false)
  toggle.dispatch('contextmenu')
  assert.equal(island.classList.contains('expanded'), true)
  view.dispose()
})

test('only the rounded visible island receives mouse input; transparent margins and stale positions stay pass-through', () => {
  const view = rendererFixture()
  view.emit('onSettingsUpdate', { mode: 'floating' })
  view.window.dispatch('mousemove', { clientX: 200, clientY: 40 })
  assert.deepEqual(view.calls.at(-1), { name: 'setInteractive', args: [true] })
  view.window.dispatch('mousemove', { clientX: 10, clientY: 10 })
  assert.deepEqual(view.calls.at(-1), { name: 'setInteractive', args: [false] })
  view.window.dispatch('mousemove', { clientX: 200, clientY: 40 })
  view.window.dispatch('mouseleave')
  const count = view.calls.length
  view.emit('onTimeUpdate', 50)
  view.flush()
  assert.equal(view.calls.length, count)
  assert.deepEqual(view.calls.at(-1), { name: 'setInteractive', args: [false] })
  view.dispose()
})

test('external pointer polling enables floating input without auto-expanding and does not reset the collapse timer', () => {
  const view = rendererFixture()
  view.emit('onSettingsUpdate', { mode: 'floating' })
  const island = view.node('island')
  view.emit('onPointerUpdate', { clientX: 71, clientY: 9 })
  assert.equal(island.classList.contains('expanded'), false)
  assert.equal(view.calls.length, 0)
  view.emit('onPointerUpdate', { clientX: 200, clientY: 40 })
  assert.equal(island.classList.contains('expanded'), false)
  assert.deepEqual(view.calls.at(-1), { name: 'setInteractive', args: [true] })
  view.node('notchToggle').click()
  assert.equal(island.classList.contains('expanded'), true)
  island.dispatch('keydown', { key: 'Escape' })
  assert.equal(island.classList.contains('expanded'), false)
  view.flush()
  view.emit('onPointerUpdate', { clientX: 200, clientY: 40 })
  view.emit('onPointerUpdate', { clientX: 200, clientY: 40 })
  assert.equal(island.classList.contains('expanded'), false)
  view.emit('onPointerUpdate', { clientX: -20, clientY: 40 })
  assert.deepEqual(view.calls.at(-1), { name: 'setInteractive', args: [false] })
  view.emit('onPointerUpdate', { clientX: 200, clientY: 40 })
  assert.equal(island.classList.contains('expanded'), false)
  view.node('notchToggle').click()
  assert.equal(island.classList.contains('expanded'), true)
  view.emit('onPointerUpdate', { clientX: 600, clientY: 40 })
  const timerIds = [...view.timers.keys()]
  view.emit('onPointerUpdate', { clientX: 600, clientY: 40 })
  view.emit('onPointerUpdate', { clientX: 600, clientY: 40 })
  assert.deepEqual([...view.timers.keys()], timerIds)
  view.expire(220)
  assert.equal(island.classList.contains('expanded'), false)
  const count = view.calls.length
  view.emit('onPointerUpdate', { clientX: Infinity, clientY: 40 })
  view.emit('onPointerUpdate', { clientX: 200, clientY: NaN })
  view.emit('onPointerUpdate', null)
  assert.equal(view.calls.length, count)
  assert.equal(island.classList.contains('expanded'), false)
  view.dispose()
  assert.equal(view.subscriptions.has('onPointerUpdate'), false)
  view.emit('onPointerUpdate', { clientX: 200, clientY: 40 })
  assert.equal(island.classList.contains('expanded'), false)
})

test('native visibility resets restore floating input even when the last pointer remains inside', () => {
  const view = rendererFixture()
  view.emit('onSettingsUpdate', { mode: 'floating' })
  view.emit('onPointerUpdate', { clientX: 200, clientY: 40 })
  assert.deepEqual(view.calls.at(-1), { name: 'setInteractive', args: [true] })
  const count = view.calls.length
  view.emit('onPointerUpdate', { clientX: 200, clientY: 40 })
  assert.equal(view.calls.length, count)
  view.emit('onPointerUpdate', { clientX: 200, clientY: 40, resetInteractive: true })
  assert.equal(view.calls.length, count + 1)
  assert.deepEqual(view.calls.at(-1), { name: 'setInteractive', args: [true] })
  assert.equal(view.node('island').classList.contains('expanded'), false)
  view.emit('onPointerUpdate', { clientX: -20, clientY: 40, resetInteractive: true })
  assert.deepEqual(view.calls.at(-1), { name: 'setInteractive', args: [false] })
  const resetCount = view.calls.length
  view.emit('onPointerUpdate', { clientX: Infinity, clientY: 40, resetInteractive: true })
  view.emit('onPointerUpdate', { clientX: -20, clientY: 40 })
  assert.equal(view.calls.length, resetCount)
  view.dispose()
})

test('controls reflect actual playback, wait for acknowledgement and preserve visible retryable errors', async () => {
  let rejectClose = true
  const view = rendererFixture({ actions: { close: async () => ({ success: !rejectClose, error: '设置保存失败，请重试。' }) } })
  view.emit('onSettingsUpdate', { mode: 'floating' })
  assert.equal(view.node('playBtn').disabled, true)
  song(view)
  view.emit('onPlaybackUpdate', { playing: true, available: true })
  assert.equal(view.node('island').classList.contains('playing'), true)
  assert.equal(view.node('playBtn').getAttribute('aria-label'), '暂停')
  await view.node('playBtn').click()
  await view.node('previousBtn').click()
  await view.node('nextBtn').click()
  assert.deepEqual(view.calls.filter(call => call.name === 'control').map(call => call.args[0]), ['toggle', 'prev', 'next'])
  assert.equal(view.node('playBtn').getAttribute('aria-label'), '暂停')
  view.emit('onPlaybackUpdate', { playing: false, available: false })
  assert.equal(view.node('playBtn').disabled, true)
  assert.equal(view.node('island').classList.contains('playing'), false)
  await view.node('closeBtn').click()
  assert.equal(view.node('feedback').textContent, '设置保存失败，请重试。')
  assert.equal(view.node('closeBtn').disabled, false)
  view.expire(220)
  assert.equal(view.node('island').classList.contains('expanded'), true)
  rejectClose = false
  await view.node('closeBtn').click()
  assert.equal(view.node('feedback').textContent, '')
  view.dispose()
})

test('translation settings remain authoritative over delayed acknowledgements and failed saves', async () => {
  let finish
  const view = rendererFixture({ actions: { setTranslation: () => new Promise(resolve => { finish = resolve }) } })
  song(view)
  view.emit('onLyricUpdate', [{ time: 0, text: 'original', translation: 'translation' }, { time: 4000, text: 'next' }])
  const request = view.node('translationBtn').click()
  assert.equal(view.node('translationBtn').getAttribute('aria-busy'), 'true')
  view.emit('onSettingsUpdate', { showTranslation: true })
  finish({ success: true })
  await request
  assert.equal(view.node('nextLyric').textContent, 'translation')
  assert.equal(view.node('translationBtn').getAttribute('aria-pressed'), 'true')
  const failed = view.node('translationBtn').click()
  finish({ success: false, error: 'Controlled failure' })
  await failed
  assert.equal(view.node('nextLyric').textContent, 'translation')
  assert.equal(view.node('translationBtn').disabled, false)
  view.dispose()
})

test('dynamic reduced motion cancels running replacements and unload releases all events, frames and timers', () => {
  const view = rendererFixture()
  song(view)
  view.emit('onLyricUpdate', [krc()])
  assert.ok(view.animations.length > 0)
  view.media.matches = true
  view.media.dispatch('change')
  assert.ok(view.animations.every(animation => animation.cancelled))
  const count = view.animations.length
  song(view, 'changed')
  assert.equal(view.animations.length, count)
  view.emit('onError', '<controlled-error>')
  assert.equal(view.node('feedback').textContent, '<controlled-error>')
  assert.equal(view.node('feedback').children.length, 0)
  view.dispose()
  assert.equal(view.frames.size, 0)
  assert.equal(view.timers.size, 0)
  assert.equal(view.subscriptions.size, 0)
  assert.equal(view.window.listeners.size, 0)
  assert.equal(view.node('island').listeners.size, 0)
  assert.equal(view.media.listeners.size, 0)
  assert.equal(view.resizeDisconnected, true)
})

test('late action results cannot change an unloaded window', async () => {
  let finish
  const view = rendererFixture({ actions: { setTranslation: () => new Promise(resolve => { finish = resolve }) } })
  song(view)
  view.emit('onLyricUpdate', [{ time: 0, text: 'original', translation: 'translation' }])
  const request = view.node('translationBtn').click()
  view.dispose()
  finish({ success: true })
  await request
  assert.equal(view.node('translationBtn').getAttribute('aria-pressed'), 'true')
  assert.equal(view.timers.size, 0)
  assert.equal(view.frames.size, 0)
})

test('mainland keeps its inverse-corner hitbox while fading and never captures mouse input or opens controls', () => {
  const view = rendererFixture()
  const island = view.node('island')
  view.emit('onPointerUpdate', { clientX: 91, clientY: 6 })
  assert.equal(island.classList.contains('avoiding'), false)
  view.emit('onPointerUpdate', { clientX: 91, clientY: 0 })
  assert.equal(island.classList.contains('avoiding'), true)
  view.emit('onPointerUpdate', { clientX: 200, clientY: 25 })
  assert.equal(island.classList.contains('avoiding'), true)
  island.dispatch('mouseleave')
  view.window.dispatch('blur')
  view.emit('onTimeUpdate', 1000)
  view.flush()
  assert.equal(island.classList.contains('avoiding'), true)
  view.node('notchToggle').click()
  view.node('notchToggle').dispatch('contextmenu')
  island.dispatch('keydown', { key: 'Enter', target: view.node('notchToggle') })
  assert.equal(island.classList.contains('expanded'), false)
  assert.equal(view.node('details').inert, true)
  assert.equal(view.calls.some(call => call.name === 'setInteractive' && call.args[0]), false)
  view.emit('onPointerUpdate', { clientX: 115, clientY: 49 })
  assert.equal(island.classList.contains('avoiding'), false)
  view.emit('onPointerUpdate', { clientX: 200, clientY: 25 })
  view.emit('onSettingsUpdate', { mode: 'floating' })
  assert.equal(island.classList.contains('avoiding'), false)
  assert.deepEqual(view.calls.at(-1), { name: 'setInteractive', args: [true] })
  view.node('notchToggle').click()
  assert.equal(island.classList.contains('expanded'), true)
  view.emit('onSettingsUpdate', { mode: 'mainland' })
  assert.equal(island.classList.contains('expanded'), false)
  assert.deepEqual(view.calls.at(-1), { name: 'setInteractive', args: [false] })
  view.dispose()
})

test('left/right content choices use the bundled Logo and reclaim hidden slots without placeholder symbols', () => {
  const view = rendererFixture()
  view.emit('onSettingsUpdate', { logoUrl: 'file:///application/public/logo.png', showLogo: true })
  assert.equal(view.node('leftLogo').src, 'file:///application/public/logo.png')
  assert.equal(view.node('rightLogo').src, 'file:///application/public/logo.png')
  assert.equal(view.node('leftSlot').hidden, false)
  assert.equal(view.node('leftLogo').hidden, false)
  assert.equal(view.node('rightCover').hidden, false)
  assert.equal(view.node('currentViewport').style.gridColumn, '2')
  view.emit('onSettingsUpdate', { showLogo: false })
  assert.equal(view.node('leftSlot').hidden, true)
  assert.equal(view.node('currentViewport').style.gridColumn, '1')
  assert.equal(view.node('notchToggle').style.gridTemplateColumns, 'minmax(0, 1fr) 30px')
  view.emit('onSettingsUpdate', { leftContent: 'cover', rightContent: 'logo' })
  assert.equal(view.node('leftCover').hidden, false)
  assert.equal(view.node('rightSlot').hidden, true)
  view.emit('onSettingsUpdate', { showLogo: true })
  assert.equal(view.node('rightSlot').hidden, false)
  assert.equal(view.node('rightLogo').hidden, false)
  view.emit('onSettingsUpdate', { leftContent: 'none', rightContent: 'none' })
  assert.equal(view.node('leftSlot').hidden, true)
  assert.equal(view.node('rightSlot').hidden, true)
  assert.equal(view.node('notchToggle').style.gridTemplateColumns, 'minmax(0, 1fr)')
  view.emit('onSettingsUpdate', { leftContent: 'logo', logoUrl: 'https://example.test/not-the-app-logo.png' })
  assert.equal(view.node('leftSlot').hidden, true)
  assert.equal(view.node('leftLogo').src, '')
  view.dispose()
})

test('two-line, translation, song-information and karaoke preferences affect the real lyric renderer', () => {
  const view = rendererFixture()
  song(view)
  view.emit('onLyricUpdate', [{ ...krc(), translation: 'translation' }, { time: 5000, text: 'next' }])
  view.emit('onSettingsUpdate', { alwaysTwoLines: true, hideTranslation: true })
  assert.equal(view.node('island').classList.contains('two-lines'), true)
  assert.equal(view.node('nextLyric').textContent, 'next')
  assert.equal(view.node('translationBtn').disabled, true)
  view.emit('onSettingsUpdate', { hideTranslation: false, showTranslation: false })
  assert.equal(view.node('nextLyric').textContent, 'next')
  view.emit('onSettingsUpdate', { showTranslation: true })
  assert.equal(view.node('nextLyric').textContent, 'translation')
  view.emit('onSettingsUpdate', { karaokeEnabled: false })
  assert.equal(view.node('currentLyric').children.length, 0)
  assert.equal(view.node('currentLyric').textContent, '甲乙丙')
  view.emit('onSettingsUpdate', { karaokeEnabled: true })
  assert.equal(view.node('currentLyric').children.length, 3)
  view.emit('onSettingsUpdate', { songInfoOnly: true })
  assert.equal(view.node('currentLyric').textContent, 'Controlled track')
  assert.equal(view.node('nextLyric').textContent, 'Placeholder')
  assert.equal(view.node('translationBtn').disabled, true)
  view.emit('onSongUpdate', { trackId: 'controlled', title: 'Updated title', artist: 'Updated artist' })
  assert.equal(view.node('currentLyric').textContent, 'Updated title')
  view.emit('onSettingsUpdate', { alwaysTwoLines: false })
  assert.equal(view.node('currentLyric').textContent, 'Updated title · Updated artist')
  view.emit('onSettingsUpdate', { songInfoOnly: false })
  assert.equal(view.node('currentLyric').textContent, '甲乙丙')
  view.dispose()
})

test('font, colors, background opacity and scale are applied once while maximum-size content fits the window', () => {
  const view = rendererFixture()
  view.window.innerWidth = 1120
  view.window.innerHeight = 320
  view.emit('onSettingsUpdate', {
    mode: 'floating', scale: 2, fontSize: 40, boldText: true, fontFamily: 'Example Sans',
    alwaysTwoLines: true, opacity: .5, backgroundOpacity: .4,
    colors: { text: '#aaccee', inactive: '#223344', background: '#112233' }
  })
  const island = view.node('island')
  assert.equal(island.classList.contains('bold-text'), true)
  assert.equal(view.node('currentLyric').style.fontFamily, 'Example Sans')
  assert.equal(island.style['--lyric-font-size'], '40px')
  assert.equal(island.style['--lyric-text'], '#aaccee')
  assert.equal(island.style['--lyric-inactive'], '#223344')
  assert.equal(island.style['--panel-background'], 'rgba(17,34,51,0.4)')
  assert.equal(view.node('notchShape').style.fillOpacity, '0.4')
  assert.equal(view.document.body.style.transform, 'scale(2)')
  assert.equal(view.document.body.style.width, '560px')
  assert.equal(view.document.body.style.opacity, '1')
  assert.equal(island.style.opacity, undefined)
  assert.ok(parseFloat(island.style['--compact-height']) <= 90)
  assert.ok(parseFloat(island.style['--expanded-height']) + 8 <= 160)
  view.emit('onPointerUpdate', { clientX: 560, clientY: 66 })
  assert.deepEqual(view.calls.at(-1), { name: 'setInteractive', args: [true] })
  view.emit('onSettingsUpdate', { colors: { text: 'url(https://example.test/invalid)' }, fontSize: 999, scale: 999 })
  assert.equal(island.style['--lyric-text'], '#aaccee')
  assert.equal(island.style['--lyric-font-size'], '40px')
  assert.equal(view.document.body.style.transform, 'scale(2)')
  view.dispose()
})

test('unchanged preference broadcasts do not replay the current line transition', () => {
  const view = rendererFixture()
  song(view)
  view.emit('onLyricUpdate', [krc()])
  view.emit('onSettingsUpdate', { mode: 'mainland', showLogo: true, karaokeEnabled: true })
  const count = view.animations.length
  view.emit('onSettingsUpdate', { mode: 'mainland', showLogo: true, karaokeEnabled: true })
  view.flush()
  assert.equal(view.animations.length, count)
  view.dispose()
})

test('renderer opacity only applies when the main process selects the Linux fallback', () => {
  const view = rendererFixture()
  view.emit('onSettingsUpdate', { opacity: .4, opacityInRenderer: true })
  assert.equal(view.document.body.style.opacity, '0.4')
  view.emit('onPointerUpdate', { clientX: 200, clientY: 25 })
  assert.equal(view.node('island').classList.contains('avoiding'), true)
  assert.equal(view.node('island').style.opacity, undefined)
  view.emit('onSettingsUpdate', { opacity: .4, opacityInRenderer: false })
  assert.equal(view.document.body.style.opacity, '1')
  view.emit('onSettingsUpdate', { opacity: 0, opacityInRenderer: true })
  assert.equal(view.document.body.style.opacity, '0.2')
  view.dispose()
})

test('floating dragging starts only beyond six pixels, sends no coordinates and suppresses the resulting click', async () => {
  const view = rendererFixture()
  const island = view.node('island')
  const target = view.node('notchToggle')
  island.dispatch('pointerdown', { button: 0, pointerId: 1, clientX: 200, clientY: 25, target })
  assert.equal(view.calls.some(call => call.name === 'beginDrag'), false)
  view.emit('onSettingsUpdate', { mode: 'floating' })
  island.dispatch('pointerdown', { button: 0, pointerId: 2, clientX: 200, clientY: 25, target: view.node('playBtn') })
  assert.equal(island.hasPointerCapture(2), false)
  island.dispatch('pointerdown', { button: 0, pointerId: 3, clientX: 200, clientY: 25, target })
  await island.dispatch('pointermove', { pointerId: 3, clientX: 206, clientY: 25 })
  assert.equal(view.calls.some(call => call.name === 'beginDrag'), false)
  await island.dispatch('pointermove', { pointerId: 3, clientX: 207, clientY: 25 })
  assert.equal(view.calls.filter(call => call.name === 'beginDrag').length, 1)
  assert.deepEqual(view.calls.find(call => call.name === 'beginDrag').args, [])
  assert.deepEqual(view.calls.find(call => call.name === 'drag').args, [])
  view.window.dispatch('mouseleave')
  assert.equal(view.calls.filter(call => call.name === 'setInteractive').at(-1).args[0], true)
  await island.dispatch('pointerup', { pointerId: 3 })
  assert.equal(island.hasPointerCapture(3), false)
  assert.equal(view.calls.filter(call => call.name === 'endDrag').length, 1)
  assert.deepEqual(view.calls.at(-1), { name: 'setInteractive', args: [false] })
  target.click()
  assert.equal(island.classList.contains('expanded'), false)
  island.dispatch('pointerdown', { button: 0, pointerId: 4, clientX: 200, clientY: 25, target })
  island.dispatch('pointerup', { pointerId: 4 })
  target.click()
  assert.equal(island.classList.contains('expanded'), true)
  view.dispose()
})

test('drag cancellation during begin, failed position saving and unload finish the native gesture exactly once', async () => {
  let start
  const view = rendererFixture({ actions: {
    beginDrag: () => new Promise(resolve => { start = resolve }),
    endDrag: async () => ({ success: false, error: '位置保存失败，请重试。' })
  } })
  view.emit('onSettingsUpdate', { mode: 'floating' })
  const island = view.node('island')
  island.dispatch('pointerdown', { button: 0, pointerId: 7, clientX: 200, clientY: 25 })
  const moving = island.dispatch('pointermove', { pointerId: 7, clientX: 220, clientY: 25 })
  island.dispatch('pointercancel', { pointerId: 7 })
  start({ success: true })
  await moving
  assert.equal(view.calls.filter(call => call.name === 'drag').length, 0)
  assert.equal(view.calls.filter(call => call.name === 'endDrag').length, 1)
  assert.equal(view.node('feedback').textContent, '位置保存失败，请重试。')
  assert.equal(island.classList.contains('expanded'), true)
  island.dispatch('pointerdown', { button: 0, pointerId: 8, clientX: 200, clientY: 25 })
  const unloading = island.dispatch('pointermove', { pointerId: 8, clientX: 220, clientY: 25 })
  view.dispose()
  start({ success: true })
  await unloading
  assert.equal(view.calls.filter(call => call.name === 'endDrag').length, 2)
  assert.equal(view.timers.size, 0)
  assert.equal(view.frames.size, 0)
})
