const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const html = fs.readFileSync(path.join(__dirname, '../electron/desktopLyric.html'), 'utf8')
const source = html.match(/<script>([\s\S]*?)<\/script>/)[1]

/** Execute the real isolated renderer with a deterministic clock and controlled cover loads. */
function fixture({ reduced = false, unlock = async () => ({ success: true }) } = {}) {
  const nodes = new Map(), subscriptions = new Map(), animations = [], images = [], calls = []
  const frames = new Map(), timers = new Map()
  let now = 0, nextId = 0, draws = 0
  class Element {
    constructor() {
      this.children = []; this.text = ''; this.dataset = {}; this.className = ''; this.events = new Map(); this.attributes = {}
      this.clientWidth = 400; this.hidden = false; this.disabled = false
      this.style = { setProperty(name, value) { this[name] = value }, removeProperty(name) { delete this[name] } }
      this.classList = {
        contains: name => this.className.split(' ').includes(name),
        add: (...names) => { this.className = [...new Set(this.className.split(' ').concat(names))].join(' ') },
        remove: (...names) => { this.className = this.className.split(' ').filter(name => !names.includes(name)).join(' ') },
        toggle: (name, enabled) => this.classList[enabled ? 'add' : 'remove'](name)
      }
    }
    get textContent() { return this.children.length ? this.children.map(child => child.textContent).join('') : this.text }
    set textContent(value) { this.text = String(value); this.children = [] }
    get scrollWidth() { return this.measuredWidth ?? this.textContent.length * 20 }
    getBoundingClientRect() { return this.id === 'nextViewport' ? { top: 80, height: 24 } : { top: 40, height: 36 } }
    appendChild(element) { this.children.push(...(element.fragment ? element.children : [element])); return element }
    replaceChildren() { this.text = ''; this.children = [] }
    setAttribute(name, value) { this.attributes[name] = String(value) }
    addEventListener(name, callback) { this.events.set(name, callback) }
    removeEventListener(name) { this.events.delete(name) }
    animate(keyframes, options) {
      const animation = { element: this.id, keyframes, options, cancelled: false, cancel() { this.cancelled = true } }
      animations.push(animation); return animation
    }
    click() { return !this.disabled && !this.hidden ? this.events.get('click')?.() : undefined }
  }
  for (const match of html.matchAll(/<([\w-]+)[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const element = new Element(); element.id = match[2]
    element.className = match[0].match(/class="([^"]*)"/)?.[1] || ''
    element.hidden = /\bhidden\b/.test(match[0]); nodes.set(element.id, element)
  }
  const document = new Element()
  document.body = new Element(); document.documentElement = new Element(); document.head = new Element()
  document.getElementById = id => nodes.get(id)
  document.createDocumentFragment = () => Object.assign(new Element(), { fragment: true })
  document.createElement = name => {
    const element = new Element()
    if (name === 'canvas') element.getContext = () => {
      let image
      return { drawImage(value) { image = value; draws++ }, getImageData() {
        if (image.tainted) throw new Error('Controlled cross-origin pixels')
        return { data: Uint8ClampedArray.from(image.pixels || [200, 80, 40, 255, 200, 80, 40, 255, 2, 4, 6, 255]) }
      } }
    }
    return element
  }
  const window = new Element(), media = new Element()
  media.matches = reduced; window.matchMedia = () => media
  const api = {}
  for (const name of ['SongUpdate', 'LyricUpdate', 'TimeUpdate', 'PlaybackUpdate', 'SettingsUpdate', 'LockChanged', 'RuntimeState', 'Error']) {
    api['on' + name] = callback => { subscriptions.set(name, callback); return () => subscriptions.delete(name) }
  }
  api.setLocked = async value => { calls.push(['setLocked', value]); return unlock(value) }
  window.desktopLyricAPI = api
  const context = vm.createContext({ window, document, Intl, console: { warn() {} }, performance: { now: () => now },
    Image: class { constructor() { images.push(this) } },
    requestAnimationFrame(callback) { const id = ++nextId; frames.set(id, callback); return id }, cancelAnimationFrame: id => frames.delete(id),
    setTimeout(callback, delay) { const id = ++nextId; timers.set(id, { callback, due: now + delay }); return id }, clearTimeout: id => timers.delete(id)
  })
  vm.runInContext(source, context, { filename: 'desktopLyric.html' })
  document.events.get('DOMContentLoaded')()
  return {
    nodes, animations, images, calls, frames, timers, media,
    node: id => nodes.get(id), emit: (name, ...args) => subscriptions.get(name)?.(...args),
    advance(ms = 0) {
      now += ms
      for (const [id, timer] of [...timers]) if (timer.due <= now) { timers.delete(id); timer.callback() }
      const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(now))
    },
    get draws() { return draws },
    dispose() { window.events.get('beforeunload')() }
  }
}

const lines = [
  { time: 0, duration: 1000, text: '甲乙', translation: 'First translation', isKrc: true, words: [{ word: '甲乙', startTime: 0, duration: 1000 }] },
  { time: 1000, duration: 1000, text: '丙丁', isKrc: true, words: [{ word: '丙丁', startTime: 0, duration: 1000 }] }
]
function load(view) {
  view.emit('SongUpdate', { trackId: 'first', title: 'Song', artist: 'Artist' })
  view.emit('LyricUpdate', lines)
}

test('single line, local translation, info-only and karaoke switches preserve their independent preferences', () => {
  const view = fixture(); load(view)
  view.emit('TimeUpdate', 250); view.advance()
  assert.equal(view.node('currentLyric').children[0].style['--fill-progress'], '50%')
  assert.equal(view.node('nextLyric').textContent, 'First translation')
  view.emit('SettingsUpdate', { hideTranslation: true })
  assert.equal(view.node('nextLyric').textContent, '丙丁')
  view.emit('SettingsUpdate', { doubleLine: false })
  assert.equal(view.node('nextViewport').hidden, true)
  view.emit('SettingsUpdate', { songInfoOnly: true })
  assert.equal(view.node('currentViewport').hidden, true)
  assert.equal(view.node('songInfo').textContent, 'Song - Artist')
  view.emit('SettingsUpdate', { songInfoOnly: false, karaokeEnabled: false })
  assert.equal(view.node('currentViewport').hidden, false)
  assert.equal(view.node('nextViewport').hidden, true)
  assert.equal(view.node('currentLyric').children.length, 0)
  assert.equal(view.node('currentLyric').textContent, '甲乙')
  view.emit('SettingsUpdate', { karaokeEnabled: true, doubleLine: true, hideTranslation: false })
  assert.equal(view.node('currentLyric').children[0].style['--fill-progress'], '50%')
  assert.equal(view.node('nextLyric').textContent, 'First translation')
  view.emit('SettingsUpdate', { showTranslation: false })
  assert.equal(view.node('nextLyric').textContent, '丙丁')
  view.dispose()
})

test('alignment, safe font, text colors, stroke and custom shadow apply immediately and clear to inheritance', () => {
  const view = fixture(); load(view)
  const container = view.node('lyricContainer')
  view.emit('SettingsUpdate', { alignment: 'right', fontFamily: 'Family "Quoted"', activeColor: '#123456', textColor: '#abcdef', translationColor: '#445566',
    strokeWidth: 200, shadowEnabled: true, shadowColorMode: 'custom', shadowColor: '#336699', shadowDepth: 8, shadowDirection: 90, shadowRadius: 12, shadowOpacity: 25 })
  assert.ok(container.classList.contains('align-right'))
  assert.equal(container.style['--desktop-font'], '"Family \\"Quoted\\""')
  assert.equal(container.style['--desktop-accent'], '#123456')
  assert.equal(container.style['--desktop-text'], '#abcdef')
  assert.equal(container.style['--desktop-translation'], '#445566')
  assert.equal(container.style['--desktop-stroke-width'], '2px')
  assert.equal(container.style['--desktop-lyric-shadow'], 'drop-shadow(0px 8px 12px rgba(51,102,153,0.25))')
  view.emit('SettingsUpdate', { alignment: 'left', fontFamily: '', activeColor: '', textColor: '', translationColor: '', strokeWidth: 0, shadowEnabled: false })
  assert.ok(container.classList.contains('align-left'))
  assert.equal(container.style['--desktop-font'], undefined)
  assert.equal(container.style['--desktop-accent'], undefined)
  assert.equal(container.style['--desktop-stroke-width'], '0px')
  assert.equal(container.style['--desktop-lyric-shadow'], 'none')
  view.dispose()
})

test('local annotation hiding also suppresses real romanization without changing its source preference', () => {
  const view = fixture(); load(view)
  view.emit('LyricUpdate', [{ ...lines[0], romanization: 'jia yi' }, lines[1]])
  assert.equal(view.node('nextLyric').textContent, 'jia yi · First translation')
  view.emit('SettingsUpdate', { hideTranslation: true })
  assert.equal(view.node('nextLyric').textContent, '丙丁')
  view.emit('SettingsUpdate', { hideTranslation: false, showTranslation: false })
  assert.equal(view.node('nextLyric').textContent, 'jia yi')
  view.dispose()
})

test('cover shadow samples once on demand, rejects late results and falls back when pixels are inaccessible', () => {
  const view = fixture(); load(view)
  view.emit('SongUpdate', { trackId: 'first', title: 'Song', cover: 'https://example.test/first.png' })
  assert.equal(view.images.length, 0)
  view.emit('SettingsUpdate', { shadowEnabled: true, shadowColorMode: 'cover', shadowColor: '#112233' })
  const first = view.images[0], lateFirst = first.onload
  view.emit('SongUpdate', { trackId: 'second', title: 'Song', cover: 'https://example.test/second.png' })
  lateFirst()
  assert.equal(view.draws, 0)
  const second = view.images[1]
  second.onload()
  assert.match(view.node('lyricContainer').style['--desktop-lyric-shadow'], /rgba\(200,80,40,0.5\)/)
  view.emit('SettingsUpdate', { shadowDepth: 20 })
  assert.equal(view.images.length, 2)
  view.emit('SongUpdate', { trackId: 'third', title: 'Song', cover: 'https://example.test/third.png' })
  view.images[2].tainted = true; view.images[2].onload()
  assert.match(view.node('lyricContainer').style['--desktop-lyric-shadow'], /rgba\(17,34,51,0.5\)/)
  view.emit('SongUpdate', { trackId: 'fourth', title: 'Song', cover: 'https://example.test/fourth.png' })
  const late = view.images[3].onload
  view.dispose(); late()
  assert.equal(view.draws, 2)
})

test('transition and blur switches cancel active decorations and reduced motion remains authoritative', () => {
  const view = fixture(); load(view)
  view.emit('SettingsUpdate', { hideTranslation: true, transitionBlur: true })
  view.emit('PlaybackUpdate', { playing: true })
  view.emit('TimeUpdate', 900, { advancing: true }); view.advance(); view.advance(150)
  const promotion = view.animations.find(animation => animation.element === 'currentViewport')
  assert.ok(promotion.keyframes[0].filter.includes('blur'))
  view.emit('SettingsUpdate', { transitionEnabled: false })
  assert.equal(promotion.cancelled, true)
  view.emit('TimeUpdate', 100, { advancing: true, discontinuity: true }); view.advance()
  const count = view.animations.length
  view.emit('TimeUpdate', 900, { advancing: true }); view.advance(); view.advance(150)
  assert.equal(view.animations.length, count)
  view.emit('SettingsUpdate', { transitionEnabled: true, transitionBlur: false })
  view.emit('TimeUpdate', 100, { advancing: true, discontinuity: true }); view.advance()
  view.emit('TimeUpdate', 900, { advancing: true }); view.advance(); view.advance(150)
  assert.equal(view.animations.filter(animation => animation.element === 'currentViewport').at(-1).keyframes[0].filter, undefined)
  view.media.matches = true; view.media.events.get('change')()
  assert.ok(view.animations.at(-1).cancelled)
  view.dispose()
})

test('efficient mode schedules at most 30 paints per second and pauses while native policy hides the window', () => {
  const view = fixture(); load(view)
  view.emit('SettingsUpdate', { efficientMode: true })
  view.emit('PlaybackUpdate', { playing: true })
  view.emit('TimeUpdate', 0, { advancing: true }); view.advance()
  const initial = view.node('currentLyric').children[0].style['--fill-progress']
  assert.equal(view.frames.size, 0)
  assert.equal(view.timers.size, 1)
  view.advance(16)
  assert.equal(view.node('currentLyric').children[0].style['--fill-progress'], initial)
  view.advance(18)
  assert.equal(view.node('currentLyric').children[0].style['--fill-progress'], '6.8%')
  view.emit('RuntimeState', { hidden: true })
  assert.equal(view.frames.size, 0); assert.equal(view.timers.size, 0)
  view.emit('TimeUpdate', 200, { advancing: true }); view.advance(100)
  assert.equal(view.node('currentLyric').children[0].style['--fill-progress'], '6.8%')
  view.emit('RuntimeState', { hidden: false }); view.advance()
  assert.equal(view.node('currentLyric').children[0].style['--fill-progress'], '60%')
  view.emit('PlaybackUpdate', { playing: false, time: 310 }); view.advance()
  assert.equal(view.node('currentLyric').children[0].style['--fill-progress'], '62%')
  assert.equal(view.timers.size, 0)
  view.emit('SettingsUpdate', { efficientMode: false })
  view.emit('RuntimeState', { hidden: true })
  const animationCount = view.animations.length
  view.emit('SongUpdate', { trackId: 'next', title: 'Hidden replacement', artist: 'Artist' })
  view.emit('Error', 'Controlled hidden feedback')
  assert.equal(view.animations.length, animationCount, 'hidden song and feedback updates cannot start new decorations')
  assert.equal(view.frames.size, 0)
  view.dispose()
})

test('promotion blur retains the configured shadow in both keyframes without combining none with blur', () => {
  const view = fixture(); load(view)
  view.emit('SettingsUpdate', { hideTranslation: true, transitionBlur: true, shadowEnabled: true,
    shadowColorMode: 'custom', shadowColor: '#336699', shadowDepth: 8, shadowDirection: 90, shadowRadius: 12, shadowOpacity: 25 })
  view.emit('PlaybackUpdate', { playing: true })
  view.emit('TimeUpdate', 900, { advancing: true }); view.advance(); view.advance(150)
  const promotion = view.animations.filter(animation => animation.element === 'currentViewport').at(-1)
  assert.equal(promotion.keyframes[0].filter, 'drop-shadow(0px 8px 12px rgba(51,102,153,0.25)) blur(3px)')
  assert.equal(promotion.keyframes[1].filter, 'drop-shadow(0px 8px 12px rgba(51,102,153,0.25)) blur(0px)')
  view.emit('SettingsUpdate', { shadowEnabled: false })
  view.emit('TimeUpdate', 100, { advancing: true, discontinuity: true }); view.advance()
  view.emit('TimeUpdate', 900, { advancing: true }); view.advance(); view.advance(150)
  const unshadowed = view.animations.filter(animation => animation.element === 'currentViewport').at(-1)
  assert.equal(unshadowed.keyframes[0].filter, 'blur(3px)')
  assert.equal(unshadowed.keyframes[1].filter, 'blur(0px)')
  view.dispose()
})

test('the isolated unlock button is present only while allowed and retains retry on persistence failure', async () => {
  let success = false
  const view = fixture({ unlock: async () => ({ success }) }); load(view)
  const button = view.node('unlockBtn')
  assert.equal(button.hidden, true)
  view.emit('SettingsUpdate', { locked: true })
  assert.equal(button.hidden, false)
  assert.equal(button.style.display, 'block')
  assert.equal(view.node('controlMenu').inert, true)
  await button.click()
  assert.equal(button.hidden, false)
  assert.equal(button.disabled, false)
  assert.equal(view.node('controlFeedback').dataset.error, 'true')
  success = true; await button.click()
  assert.equal(button.hidden, true)
  assert.equal(button.style.display, 'none')
  assert.equal(view.node('controlMenu').inert, false)
  assert.deepEqual(view.calls, [['setLocked', false], ['setLocked', false]])
  view.emit('SettingsUpdate', { locked: true, hideUnlockButton: true })
  assert.equal(button.hidden, true)
  assert.match(html, /\.unlock-btn\s*\{[^}]*top: 8px; right: 8px; width: 44px; height: 36px;/)
  assert.match(html, /id="unlockBtn" style="position:fixed!important;/)
  view.dispose()
})
