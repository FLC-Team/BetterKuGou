const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { parse } = require('@vue/compiler-sfc')

const root = path.resolve(__dirname, '..')
const logger = { trace() {}, info() {}, warn() {}, error() {} }

function component(file, globals = {}) {
  let source = fs.readFileSync(path.join(root, file), 'utf8')
  if (file.endsWith('.vue')) source = parse(source).descriptor.script.content
  source = source.replace(/^import\b[\s\S]*?from\s+['"][^'"]+['"]\s*;?\s*$/gm, '')
    .replace('export default', 'globalThis.component =')
  const context = vm.createContext({ logger, ArtworkCover: {}, SongBadges: {}, ArtistLinks: {}, ...globals })
  vm.runInContext(source, context)
  const definition = context.component
  const instance = { ...definition.data.call({ artistId: 7 }), $nextTick: callback => Promise.resolve().then(() => callback?.()) }
  for (const [name, method] of Object.entries(definition.methods)) instance[name] = method.bind(instance)
  return instance
}

test('artist follow serializes requests and exposes rejected API responses without changing state', async () => {
  let finish
  let requests = 0
  const artist = component('src/views/logic/ArtistView.js', {
    followArtist: () => { requests++; return new Promise(resolve => { finish = resolve }) },
    unfollowArtist: async () => ({ status: 1 })
  })
  const pending = artist.toggleFollow()
  assert.equal(artist.followPending, true)
  await artist.toggleFollow()
  assert.equal(requests, 1)
  finish({ status: 0 })
  await pending
  assert.equal(artist.followPending, false)
  assert.equal(artist.followed, false)
  assert.equal(artist.followError, true)
  assert.match(artist.followMessage, /失败/)
  const retry = artist.toggleFollow()
  finish({ status: 1 })
  await retry
  assert.equal(artist.followed, true)
  assert.equal(artist.followError, false)
  assert.match(artist.followMessage, /已关注/)
})

test('login pending feedback rejects duplicate calls and successful authentication persists immediately', async () => {
  let finish
  let requests = 0
  const events = []
  const login = component('src/views/LoginView.vue', {
    loginByPhone: () => { requests++; return new Promise(resolve => { finish = resolve }) },
    saveLoginInfo: data => events.push(['save', data.token])
  })
  login.$emit = (...args) => events.push(args)
  login.phoneForm = { phone: '13800000000', captcha: '123456' }
  const pending = login.handlePhoneLogin()
  assert.equal(login.phoneLoading, true)
  assert.match(login.loginFeedback.text, /正在验证/)
  await login.handlePhoneLogin()
  assert.equal(requests, 1)
  finish({ status: 0, error: '验证码已失效' })
  await pending
  assert.equal(login.phoneLoading, false)
  assert.equal(login.loginFeedback.kind, 'error')
  assert.equal(login.loginFeedback.text, '验证码已失效')
  const complete = login.completeLogin({ token: 'fixture-placeholder' })
  assert.deepEqual(events, [['save', 'fixture-placeholder']], 'Persistence must not wait for an animation timer')
  assert.equal(login.loginFeedback.kind, 'success')
  await complete
  assert.deepEqual(events.map(event => event[0]), ['save', 'loginSuccess', 'back'])
})

function motionFixture(count = 1000, reduced = false) {
  let geometryReads = 0
  let observer
  const animations = []
  const ghosts = []
  const listeners = new Map()
  const viewport = { top: 0, bottom: 600, height: 600 }
  const scroller = {
    getBoundingClientRect: () => { geometryReads++; return viewport },
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: name => listeners.delete(name)
  }
  const makeAnimation = () => {
    const animation = { finished: Promise.resolve(), canceled: false, cancel() { this.canceled = true } }
    animations.push(animation)
    return animation
  }
  const makeRow = index => ({
    dataset: { motionKey: `song-${index}` }, isConnected: true, style: {}, attributes: {},
    index, getBoundingClientRect() { geometryReads++; return { top: this.index * 75, left: 0, width: 700, height: 75, bottom: this.index * 75 + 75 } },
    cloneNode() { return makeRow(this.index) }, querySelectorAll: () => [],
    removeAttribute(name) { delete this.attributes[name] },
    setAttribute(name, value) { this.attributes[name] = value },
    remove() { this.removed = true }, animate: makeAnimation
  })
  let rows = Array.from({ length: count }, (_, index) => makeRow(index))
  const element = {
    closest: selector => selector === '.list-page' ? scroller : null,
    querySelectorAll: () => rows,
    getBoundingClientRect: () => { geometryReads++; return { top: 0, left: 0 } },
    append: ghost => ghosts.push(ghost)
  }
  const media = { matches: reduced, addEventListener() {}, removeEventListener() {} }
  const context = vm.createContext({
    window: { matchMedia: () => media }, performance: { now: () => 0 },
    IntersectionObserver: class {
      constructor(callback) { this.callback = callback; observer = this; this.disconnected = false }
      observe() {} unobserve() {} disconnect() { this.disconnected = true }
    }
  })
  const source = fs.readFileSync(path.join(root, 'src/views/logic/listMotion.js'), 'utf8').replace(/^export /gm, '')
  vm.runInContext(`${source}\nglobalThis.motion = {listMotion,setListMotionActive}`, context)
  context.motion.listMotion.mounted(element)
  return {
    ...context.motion, element, rows, animations, ghosts, media, listeners,
    observer: () => observer,
    show: visible => observer.callback(visible.map(target => ({ isIntersecting: true, target }))),
    updateRows: next => { rows = next }, reads: () => geometryReads
  }
}

test('thousand-song animation measures only visible rows and makes removed clones inert', async () => {
  const fixture = motionFixture()
  const { element, listMotion, rows } = fixture
  fixture.show(rows.slice(0, 8))
  listMotion.beforeUpdate(element, { oldValue: rows, value: rows.slice(1) })
  fixture.updateRows(rows.slice(1))
  rows.slice(1).forEach(row => { row.index-- })
  listMotion.updated(element, { oldValue: rows, value: rows.slice(1) })
  assert.ok(fixture.reads() < 25, `Only visible row geometry should be read, got ${fixture.reads()}`)
  assert.equal(fixture.ghosts.length, 1)
  assert.equal(fixture.ghosts[0].attributes['aria-hidden'], 'true')
  assert.equal(fixture.ghosts[0].attributes.inert, '')
  assert.equal(fixture.ghosts[0].style.pointerEvents, 'none')
  fixture.setListMotionActive(element, false)
  assert.equal(fixture.observer().disconnected, true)
  assert.equal(fixture.ghosts[0].removed, true)
  assert.ok(fixture.animations.every(animation => animation.canceled))
  listMotion.beforeUnmount(element)
  assert.equal(fixture.listeners.size, 0)
})

test('reduced motion does not sample or animate song geometry', () => {
  const fixture = motionFixture(1000, true)
  fixture.show(fixture.rows.slice(0, 8))
  fixture.listMotion.beforeUpdate(fixture.element, { oldValue: [], value: fixture.rows })
  fixture.listMotion.updated(fixture.element, { oldValue: [], value: fixture.rows })
  assert.equal(fixture.reads(), 0)
  assert.equal(fixture.animations.length, 0)
  fixture.listMotion.beforeUnmount(fixture.element)
})
