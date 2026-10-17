const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

/** Run the actual isolated-window script with bridge callbacks and animation lifetimes controlled. */
function windowFixture(name, reduced = false) {
  const elements = new Map(), callbacks = new Map(), windowListeners = new Map(), motionListeners = new Map(), timers = new Map(), animations = [], subscriptions = []
  let nextTimer = 0, unsubscribed = 0
  const media = { matches: reduced, addEventListener: (name, callback) => motionListeners.set(name, callback), removeEventListener: name => motionListeners.delete(name) }
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      textContent: id === 'statusText' ? '正在启动...' : id === 'songInfo' ? '暂无播放' : '', className: '', style: { setProperty(name, value) { this[name] = value }, removeProperty(name) { delete this[name] } }, dataset: {}, attributes: {}, scrollWidth: 100, clientWidth: 100,
      setAttribute(name, value) { this.attributes[name] = String(value) }, getAttribute(name) { return this.attributes[name] ?? null }, removeAttribute(name) { delete this.attributes[name] }, replaceChildren() { this.textContent = '' },
      classList: { add() {}, remove() {}, toggle() {} }, addEventListener(name, callback) { this[name] = callback },
      animate(keyframes, options) { const result = { elementId: id, keyframes, options, cancelled: false, cancel() { this.cancelled = true } }; animations.push(result); return result }
    })
    return elements.get(id)
  }
  const bridge = new Proxy({}, { get(_target, key) {
    return key.startsWith('on') ? callback => {
      callbacks.set(key, callback)
      const subscription = { event: key, releases: 0 }
      subscriptions.push(subscription)
      return () => { subscription.releases++; unsubscribed++ }
    } : async () => ({ success: true })
  } })
  const document = { getElementById: element, documentElement: element('root'), body: element('body'), addEventListener(name, callback) { callbacks.set(name, callback) } }
  const window = { desktopLyricAPI: bridge, loadingAPI: bridge, location: { search: '' }, matchMedia: () => media,
    addEventListener(name, callback) { windowListeners.set(name, callback) }, removeEventListener(name) { windowListeners.delete(name) } }
  const sandbox = vm.createContext({ document, window, URLSearchParams, console,
    setTimeout(callback) { timers.set(++nextTimer, callback); return nextTimer }, clearTimeout(id) { timers.delete(id) },
    requestAnimationFrame() { return 1 }, cancelAnimationFrame() {}, performance: { now: () => 0 } })
  const source = fs.readFileSync(path.join(__dirname, '../electron', name), 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1]
  vm.runInContext(source, sandbox)
  callbacks.get('DOMContentLoaded')?.()
  return { element, callbacks, animations, timers, media, motionListeners, windowListeners, subscriptions, get unsubscribed() { return unsubscribed } }
}

/** Each acquired bridge subscription must be released exactly once, including future channels. */
function assertSubscriptionsReleased(fixture) {
  assert.ok(fixture.subscriptions.length > 0)
  for (const subscription of fixture.subscriptions) assert.equal(subscription.releases, 1, subscription.event + ' releases exactly once')
  assert.equal(fixture.unsubscribed, fixture.subscriptions.length)
}

test('startup phase updates keep real progress and cancel obsolete phase motion', () => {
  const fixture = windowFixture('loading.html')
  const update = fixture.callbacks.get('onProgress')
  update({ progress: 38, status: '加载模块' })
  assert.equal(fixture.element('progressFill').style.width, '38%')
  assert.equal(fixture.element('statusText').textContent, '加载模块')
  assert.equal(fixture.animations.length, 1)
  update({ progress: 45, status: '加载模块' })
  assert.equal(fixture.animations.length, 1, 'repeated phase leaves the active transition alone')
  update({ progress: 70, status: '准备界面' })
  assert.equal(fixture.animations[0].cancelled, true)
  assert.equal(fixture.element('statusText').textContent, '准备界面')
  fixture.media.matches = true
  fixture.motionListeners.get('change')()
  assert.equal(fixture.animations[1].cancelled, true)
  update({ progress: 100, status: '启动完成' })
  assert.equal(fixture.animations.length, 2, 'reduced motion switches text immediately')
  fixture.windowListeners.get('beforeunload')()
  assertSubscriptionsReleased(fixture)
  assert.equal(fixture.motionListeners.size, 0)
})

test('desktop metadata and control result motion preserve the latest update and release all resources', async () => {
  const fixture = windowFixture('desktopLyric.html')
  const update = fixture.callbacks.get('onSongUpdate')
  update({ title: '歌曲 A', artist: '歌手 A' })
  update({ title: '歌曲 B', artist: '歌手 B' })
  assert.equal(fixture.element('songInfo').textContent, '歌曲 B - 歌手 B')
  const metadataAnimations = () => fixture.animations.filter(animation => animation.elementId === 'songInfo')
  assert.equal(metadataAnimations()[0].cancelled, true)
  assert.equal(metadataAnimations().length, 2)
  update({ title: '歌曲 B', artist: '歌手 B' })
  assert.equal(metadataAnimations().length, 2, 'same metadata does not restart the entrance')
  await fixture.element('sizeBtn').click()
  assert.match(fixture.element('controlFeedback').textContent, /字号/)
  await fixture.element('themeBtn').click()
  assert.match(fixture.element('controlFeedback').textContent, /样式/)
  assert.equal(fixture.timers.size, 1, 'rapid controls replace the previous dismiss timer')
  const beforeReduced = fixture.animations.length
  fixture.media.matches = true
  fixture.motionListeners.get('change')()
  assert(fixture.animations.every(animation => animation.cancelled))
  update({ title: '歌曲 C' })
  assert.equal(fixture.element('songInfo').textContent, '歌曲 C - 未知歌手')
  assert.equal(fixture.animations.length, beforeReduced)
  fixture.windowListeners.get('beforeunload')()
  assert.equal(fixture.timers.size, 0)
  assert.equal(fixture.motionListeners.size, 0)
  assertSubscriptionsReleased(fixture)
})

for (const name of ['loading.html', 'desktopLyric.html']) test(name + ' respects reduced motion on first update', () => {
  const fixture = windowFixture(name, true)
  if (name === 'loading.html') fixture.callbacks.get('onProgress')({ progress: 55, status: '正在准备' })
  else fixture.callbacks.get('onSongUpdate')({ title: '歌曲' })
  assert.equal(fixture.animations.length, 0)
})

test('reducing motion during desktop result dismissal settles the empty status immediately', async () => {
  const fixture = windowFixture('desktopLyric.html')
  await fixture.element('sizeBtn').click()
  assert.match(fixture.element('controlFeedback').textContent, /字号/)
  const [timerId, dismiss] = fixture.timers.entries().next().value
  fixture.timers.delete(timerId)
  dismiss()
  const leaving = fixture.animations.at(-1)
  assert.equal(leaving.elementId, 'controlFeedback')
  assert.equal(leaving.cancelled, false)
  fixture.media.matches = true
  fixture.motionListeners.get('change')()
  assert.equal(leaving.cancelled, true)
  assert.equal(fixture.element('controlFeedback').textContent, '')
  assert.equal(fixture.timers.size, 0)
  fixture.windowListeners.get('beforeunload')()
})
