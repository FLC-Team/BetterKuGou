const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { spawn } = require('node:child_process')
const { createTaskbarLyricService, taskbarLayout } = require('../electron/services/taskbarLyricService')
const { createWindowsTaskbarBridge } = require('../electron/services/windowsTaskbar')

const display = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1032 } }
const bar = { handle: '123', edge: 'bottom', visible: true, reliable: true, monitor: display.bounds,
  bounds: { x: 0, y: 1032, width: 1920, height: 48 }, occupied: [
    { x: 700, y: 1032, width: 500, height: 48 }, { x: 1700, y: 1032, width: 220, height: 48 }
  ] }
const hiddenBar = { ...bar, hidden: true, reliable: false, bounds: { ...bar.bounds, y: 1078 }, occupied: [] }
async function settle() { for (let i = 0; i < 32; i++) await Promise.resolve() }

test('embedding uses measured free space without covering task buttons or notification controls', () => {
  const first = taskbarLayout({ display, bar, preferences: { embed: true, region: 'start', windowAlignment: 'end', marginStart: 12, marginEnd: 20, maxWidth: 360 }, contentSize: { width: 600, height: 42 } })
  assert.equal(first.embedded, true)
  assert.equal(first.bounds.width, 360)
  assert.ok(first.bounds.x >= 20)
  assert.ok(first.bounds.x + first.bounds.width <= 694)
  const last = taskbarLayout({ display, bar, preferences: { embed: true, region: 'end', windowAlignment: 'start' } })
  assert.equal(last.bounds.x, 1206)
  assert.ok(last.bounds.x + last.bounds.width < 1700)
  assert.ok(last.bounds.y >= 1032 && last.bounds.y + last.bounds.height <= 1080)
})

test('disabling embedding floats inside verified free taskbar space without covering system controls', () => {
  const preferences = { region: 'end', windowAlignment: 'center', maxWidth: 360, marginStart: 10, marginEnd: 20 }
  const floating = taskbarLayout({ display, bar, preferences: { ...preferences, embed: false }, contentSize: { width: 480, height: 42 } })
  const embedded = taskbarLayout({ display, bar, preferences: { ...preferences, embed: true }, contentSize: { width: 480, height: 42 } })
  assert.equal(floating.embedded, false)
  assert.deepEqual(floating.bounds, embedded.bounds)
  assert.ok(floating.bounds.y >= bar.bounds.y)
  assert.ok(floating.bounds.y + floating.bounds.height <= bar.bounds.y + bar.bounds.height)
  for (const occupied of bar.occupied) {
    assert.ok(floating.bounds.x + floating.bounds.width <= occupied.x || floating.bounds.x >= occupied.x + occupied.width)
  }
})

test('unverified, crowded and vertical taskbars fall back inside the selected work area', () => {
  for (const value of [null, { ...bar, reliable: false }, { ...bar, occupied: [bar.bounds] }, { ...bar, edge: 'left' }]) {
    const layout = taskbarLayout({ display, bar: value, preferences: { embed: true, verticalOffset: 200, marginStart: 2000, marginEnd: 2000 } })
    assert.equal(layout.embedded, false)
    assert.ok(layout.bounds.x >= display.workArea.x)
    assert.ok(layout.bounds.x + layout.bounds.width <= display.workArea.width)
    assert.ok(layout.bounds.y + layout.bounds.height <= display.workArea.height)
    assert.ok(layout.warning)
  }
})

test('a confirmed hidden taskbar has no lyric placement in either mode', () => {
  const fullWorkArea = { ...display, workArea: display.bounds }
  for (const embed of [true, false]) {
    for (const edge of ['bottom', 'top', 'left', 'right']) {
      const layout = taskbarLayout({ display: fullWorkArea, bar: { ...hiddenBar, edge }, preferences: { embed } })
      assert.equal(layout.hidden, true)
      assert.equal(layout.embedded, false)
      assert.equal(layout.bounds, undefined)
      assert.equal(layout.warning, '')
    }
  }
})

function fixture(t, { platform = 'win32', request, stop } = {}) {
  const windows = [], bridges = [], messages = [], placements = [], requests = []
  const screen = Object.assign(new EventEmitter(), { getAllDisplays: () => [display], getPrimaryDisplay: () => display,
    dipToScreenRect: (_win, rect) => rect, screenToDipRect: (_win, rect) => rect })
  class Window extends EventEmitter {
    constructor(options) { super(); this.options = options; this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height }; this.destroyed = false; this.webContents = Object.assign(new EventEmitter(), { mainFrame: {}, send: (...args) => messages.push(args) }); windows.push(this) }
    getBounds() { return this.bounds }
    setBounds(rect) { assert.equal(this.destroyed, false); this.bounds = rect; this.boundsWrites = (this.boundsWrites || 0) + 1 }
    getNativeWindowHandle() { return Buffer.from([1, 0, 0, 0, 0, 0, 0, 0]) }
    setIgnoreMouseEvents(value) { this.ignoresMouse = value }
    showInactive() { assert.equal(this.destroyed, false); this.visible = true; this.showCalls = (this.showCalls || 0) + 1 }
    hide() { this.visible = false }
    isDestroyed() { return this.destroyed }
    destroy() { this.destroyed = true; this.emit('closed') }
    loadFile() { return Promise.resolve() }
  }
  const service = createTaskbarLyricService({ BrowserWindow: Window, screen, platform, preload: '/preload', page: '/taskbar',
    createBridge(options) {
      const bridge = { options, stops: 0, start: async () => {},
        request: async (command, value) => {
          requests.push({ command, value })
          if (request) { const custom = request(command, value); if (custom) return custom }
          if (command === 'sample') return { bars: [bar], dark: false }
          if (command === 'detach' || command === 'hide') return { ok: true }
          placements.push(value)
          return { embedded: value.embed }
        }, stop: async options => { bridge.stops++; if (stop) await stop(options) } }
      bridges.push(bridge); return bridge
    } })
  t.after(async () => { await service.close() })
  return { service, windows, bridges, messages, screen, placements, requests,
    async show() { const promise = service.show(); await settle(); windows.at(-1).emit('ready-to-show'); const ready = await promise; await settle(); return ready } }
}

test('startup and preview keep lyrics hidden while the first taskbar sample is pending or confirms hiding', async t => {
  let resolveSample
  const sample = new Promise(resolve => { resolveSample = resolve })
  const f = fixture(t, { request(command) { if (command === 'sample') return sample } })
  f.service.configure({ embed: true })
  const showing = f.service.show()
  await settle()
  const win = f.windows[0]
  win.emit('ready-to-show')
  f.service.send('taskbar-lyric:song-update', { hash: 'sample' })
  f.service.send('taskbar-lyric:playback-update', { playing: true })
  f.service.preview()
  await settle()
  assert.ok(f.requests.some(item => item.command === 'sample'))
  assert.equal(win.showCalls || 0, 0)
  assert.equal(win.boundsWrites || 0, 0)
  assert.equal(f.service.getState().visible, false)

  resolveSample({ bars: [hiddenBar], dark: false })
  assert.equal(await showing, true)
  await settle()
  assert.equal(f.service.getState().status, 'taskbar-hidden')
  assert.equal(f.service.getState().visible, false)
  assert.equal(win.showCalls || 0, 0)
  assert.equal(win.boundsWrites || 0, 0)
  assert.equal(f.placements.length, 0)
})

for (const embed of [true, false]) {
  test(`${embed ? 'embedded' : 'floating'} lyrics hide and restore with the taskbar`, async t => {
    let poll, barSample = bar
    t.mock.method(global, 'setInterval', callback => { poll = callback; return { unref() {} } })
    t.mock.method(global, 'clearInterval', () => { poll = null })
    const f = fixture(t, { request(command) { if (command === 'sample') return Promise.resolve({ bars: [barSample], dark: false }) } })
    f.service.configure({ embed, autoHide: true })
    f.service.send('taskbar-lyric:song-update', { hash: 'sample' })
    f.service.send('taskbar-lyric:playback-update', { playing: true })
    await f.show()
    const win = f.windows[0]
    assert.equal(f.service.getState().visible, true)
    assert.equal(f.service.getState().embedded, embed)
    const showCalls = win.showCalls || 0
    const boundsWrites = win.boundsWrites || 0
    const requestStart = f.requests.length

    barSample = hiddenBar
    poll()
    await settle()
    f.service.send('taskbar-lyric:playback-update', { playing: false })
    f.service.setContentSize({ width: 320, height: 34 })
    f.service.preview()
    poll()
    await settle()
    assert.equal(f.service.getState().status, 'taskbar-hidden')
    assert.equal(f.service.getState().visible, false)
    assert.equal(win.showCalls || 0, showCalls)
    assert.equal(win.boundsWrites || 0, boundsWrites)
    if (!embed) assert.equal(win.visible, false)
    assert.deepEqual(f.requests.slice(requestStart).filter(item => item.command !== 'sample').map(item => item.command), embed ? ['hide'] : [])
    assert.deepEqual(f.messages.filter(([channel]) => channel === 'taskbar-lyric:runtime-state').at(-1)?.[1], { hidden: true })

    barSample = bar
    poll()
    await settle()
    assert.equal(f.service.getState().visible, true)
    assert.equal(f.service.getState().embedded, embed)
    if (embed) assert.equal(f.placements.at(-1)?.visible, true)
    else assert.equal(win.visible, true)
    assert.deepEqual(f.messages.filter(([channel]) => channel === 'taskbar-lyric:runtime-state').at(-1)?.[1], { hidden: false })
  })
}

test('losing the selected display hides the embedded lyric when the new taskbar is already hidden', async t => {
  const secondary = { ...display, id: 2, bounds: { ...display.bounds, x: 1920 }, workArea: { ...display.workArea, x: 1920 } }
  const secondaryBar = { ...hiddenBar, handle: '456', bounds: { ...hiddenBar.bounds, x: 1920 }, monitor: secondary.bounds }
  let primary = display
  const f = fixture(t, { request(command) {
    if (command === 'sample') return Promise.resolve({ bars: primary === display ? [bar, secondaryBar] : [secondaryBar] })
  } })
  f.screen.getAllDisplays = () => primary === display ? [display, secondary] : [secondary]
  f.screen.getPrimaryDisplay = () => primary
  f.service.configure({ embed: true, displayId: String(display.id) })
  await f.show()
  assert.equal(f.service.getState().visible, true)
  assert.equal(f.service.getState().embedded, true)
  const requestStart = f.requests.length

  primary = secondary
  f.screen.emit('display-removed')
  await settle()
  assert.equal(f.service.getState().status, 'taskbar-hidden')
  assert.equal(f.service.getState().visible, false)
  assert.deepEqual(f.requests.slice(requestStart).filter(item => item.command !== 'sample').map(item => item.command), ['hide'])
})

test('window service replays visibility, restores display fallback and rejects stale IPC senders', async t => {
  const f = fixture(t)
  f.service.configure({ embed: true, autoHide: true, displayId: 'missing' })
  const first = f.service.show(), second = f.service.show()
  await settle()
  assert.equal(f.windows.length, 1)
  f.windows[0].emit('ready-to-show')
  assert.equal(await first, true); assert.equal(await second, true)
  await settle()
  assert.equal(f.service.getState().visible, false)
  f.service.send('taskbar-lyric:song-update', { hash: 'sample' })
  f.service.send('taskbar-lyric:playback-update', { playing: true, available: true })
  await settle()
  assert.equal(f.service.getState().visible, true)
  assert.equal(f.service.getState().embedded, true)
  assert.equal(f.service.getState().dark, false)
  f.service.send('taskbar-lyric:playback-update', { playing: false, available: true })
  await settle()
  assert.equal(f.service.getState().visible, false)
  assert.ok(f.messages.some(([channel, value]) => channel === 'taskbar-lyric:runtime-state' && value.hidden === true))
  const webContents = f.windows[0].webContents
  assert.equal(f.service.isSender({ sender: webContents, senderFrame: webContents.mainFrame }), true)
  assert.equal(f.service.isSender({ sender: webContents, senderFrame: {} }), false)
  await f.service.close()
  assert.equal(f.service.isSender({ sender: webContents, senderFrame: webContents.mainFrame }), false)
  assert.equal(f.screen.listenerCount('display-removed'), 0)
  assert.equal(f.bridges[0].stops, 1)
})

test('native refusal is reported as floating and does not repeatedly attempt the same parenting', async t => {
  let attempts = 0
  const f = fixture(t, { request(command, value) { if (command === 'apply' && value.embed) { attempts++; return Promise.resolve({ embedded: false, warning: 'dpi-mismatch' }) } } })
  f.service.configure({ embed: true })
  await f.show()
  assert.equal(f.service.getState().embedded, false)
  assert.match(f.service.getState().warning, /缩放模式/)
  f.service.send('taskbar-lyric:playback-update', { playing: true })
  await settle()
  assert.equal(attempts, 1)
  assert.equal(f.placements.length, 0)
})

test('sampling timeout detaches into floating mode without stopping the helper and a fresh sample restores embedding', async t => {
  let poll, result = { bars: [bar], dark: false }
  t.mock.method(global, 'setInterval', callback => { poll = callback; return { unref() {} } })
  t.mock.method(global, 'clearInterval', () => { poll = null })
  const f = fixture(t, { request(command) { if (command === 'sample') return Promise.resolve(result) } })
  f.service.configure({ embed: true })
  await f.show()
  assert.equal(f.service.getState().embedded, true)
  assert.equal(f.service.getState().warning, '')
  const initialRequests = f.requests.length
  result = { bars: [], dark: false, warning: 'sampling-timeout' }
  poll()
  await settle()
  assert.ok(f.requests.slice(initialRequests).some(item => item.command === 'detach'))
  assert.equal(f.service.getState().embedded, false)
  assert.equal(f.service.getState().status, 'floating')
  assert.match(f.service.getState().warning, /响应较慢/)
  assert.ok(f.windows[0].getBounds().y + f.windows[0].getBounds().height <= display.workArea.height)
  assert.equal(f.bridges[0].stops, 0)
  const fallbackRequests = f.requests.length
  result = { bars: [bar], dark: false }
  poll()
  await settle()
  assert.ok(f.requests.slice(fallbackRequests).some(item => item.command === 'apply' && item.value.embed))
  assert.equal(f.service.getState().embedded, true)
  assert.equal(f.service.getState().warning, '')
  assert.equal(f.bridges[0].stops, 0)
})

test('floating layout uses Electron sizing and never sends raw native placement', async t => {
  const f = fixture(t)
  f.service.configure({ embed: false })
  await f.show()
  f.service.setContentSize({ width: 320, height: 34 })
  await settle()
  assert.equal(f.placements.length, 0)
  assert.equal(f.windows[0].getBounds().height, 34)
  assert.equal(f.windows[0].getBounds().width, 320)
  assert.ok(f.windows[0].getBounds().y >= bar.bounds.y)
})

test('switching from embedded to floating waits for confirmed detach before Electron sizing', async t => {
  let finishDetach
  const detached = new Promise(resolve => { finishDetach = resolve })
  const f = fixture(t, { request(command) { if (command === 'detach') return detached } })
  f.service.configure({ embed: true })
  await f.show()
  assert.equal(f.service.getState().embedded, true)
  const writes = f.windows[0].boundsWrites || 0
  f.service.configure({ embed: false })
  f.service.setContentSize({ width: 320, height: 34 })
  await settle()
  assert.equal(f.windows[0].boundsWrites || 0, writes)
  finishDetach({ ok: true })
  await settle()
  assert.equal(f.service.getState().embedded, false)
  assert.equal(f.windows[0].getBounds().height, 34)
  assert.equal(f.windows[0].getBounds().width, 320)
  assert.ok(f.placements.every(value => value.embed === true))
})

test('close waits for helper cleanup and late apply cannot reopen an old window', async t => {
  let resolveApply, releaseStop
  const apply = new Promise(resolve => { resolveApply = resolve })
  const stop = new Promise(resolve => { releaseStop = resolve })
  const f = fixture(t, { request(command) { if (command === 'apply') return apply }, stop: () => stop })
  f.service.configure({ embed: true })
  await f.show()
  const closed = f.service.close()
  assert.equal(f.service.close(), closed)
  assert.equal(f.windows[0].destroyed, false)
  const reopened = f.service.show()
  await settle()
  assert.equal(f.windows.length, 1)
  resolveApply({ embedded: true })
  releaseStop()
  await closed
  await settle()
  assert.equal(f.windows[0].destroyed, true)
  assert.equal(f.windows.length, 2)
  f.windows[1].emit('ready-to-show')
  assert.equal(await reopened, true)
  await settle()
  assert.equal(f.service.getState().status, 'embedded')
  assert.equal(f.service.getState().visible, true)
})

test('unsupported systems expose the limit and create no native window/helper', async t => {
  const f = fixture(t, { platform: 'linux' })
  assert.equal(f.service.getCapabilities().supported, false)
  assert.equal(await f.service.show(), false)
  assert.equal(f.windows.length, 0)
  assert.equal(f.bridges.length, 0)
})

test('failed helper cleanup destroys only its own window and remains retryable', async t => {
  let failStop = true
  const f = fixture(t, { stop: async () => { if (failStop) throw new Error('owned helper still running') } })
  await f.show()
  await assert.rejects(f.service.close(), /清理失败/)
  assert.equal(f.windows[0].destroyed, true)
  assert.equal(f.bridges[0].stops, 1)
  failStop = false
  await f.service.close()
  assert.equal(f.bridges[0].stops, 2)
  await f.show()
  assert.equal(f.windows.length, 2)
})

test('native failure freezes all Electron placement until asynchronous detach completes', async t => {
  let releaseStop
  const stopped = new Promise(resolve => { releaseStop = resolve })
  const f = fixture(t, { stop: () => stopped })
  f.service.configure({ embed: true })
  await f.show()
  const win = f.windows[0]
  const writes = win.boundsWrites || 0
  f.bridges[0].options.onError(new Error('controlled native failure'))
  f.service.configure({ embed: false, verticalOffset: -20 })
  f.service.setContentSize({ width: 500, height: 32 })
  f.service.preview()
  f.service.send('taskbar-lyric:playback-update', { playing: true })
  await settle()
  assert.equal(win.boundsWrites || 0, writes)
  releaseStop()
  await settle()
  assert.ok(win.boundsWrites > writes)
  assert.equal(f.service.getState().embedded, false)
})

test('uncertain detach destroys its owned window and never applies top-level fallback coordinates', async t => {
  const f = fixture(t, { stop: async options => { if (!options?.ownerDestroyed) throw new Error('forced exit: detach unconfirmed') } })
  f.service.configure({ embed: true })
  await f.show()
  const win = f.windows[0]
  const writes = win.boundsWrites || 0
  f.bridges[0].options.onError(new Error('controlled native timeout'))
  await settle()
  assert.equal(win.destroyed, true)
  assert.equal(win.boundsWrites || 0, writes)
  assert.equal(f.service.getState().status, 'closed')
  await f.service.close()
})

function bridgeFixture({ script = '# controlled fixture', handle = Buffer.alloc(8), ownerProcessId = 24680, write } = {}) {
  const timers = new Map()
  const writes = [], ends = [], spawns = [], errors = []
  let timerId = 0
  const child = Object.assign(new EventEmitter(), { pid: 12345, stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: new EventEmitter(), kills: 0 })
  child.stdin.write = value => { writes.push(value); return write ? write(value, child) : true }
  child.stdin.end = value => { ends.push(value) }
  child.kill = () => { child.kills++; queueMicrotask(() => child.emit('exit', 0)); return true }
  const bridge = createWindowsTaskbarBridge({ handle, ownerProcessId, readScript: () => script, onError: error => errors.push(error),
    spawnProcess: (executable, args, options) => { spawns.push({ executable, args, options }); return child }, timers: {
      setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id },
      clearTimeout(id) { timers.delete(id) }
    } })
  return { bridge, child, timers, writes, ends, spawns, errors,
    fire(delay) { for (const [id, timer] of [...timers]) { if (timer.delay === delay) { timers.delete(id); timer.callback() } } },
    async start() { const ready = bridge.start(); child.stdout.emit('data', '{"ready":true}\n'); await ready } }
}

test('native bridge keeps argv short and constant while transferring large Unicode scripts over stdin', async () => {
  const script = `# ${'任务栏 🎵 café\n# '.repeat(12000)}`
  const handle = Buffer.alloc(8)
  handle.writeBigUInt64LE(0x100000002n)
  const large = bridgeFixture({ script, handle }), small = bridgeFixture()
  await large.start()
  await small.start()
  assert.deepEqual(large.spawns[0].args, small.spawns[0].args)
  assert.ok(large.spawns[0].args.join(' ').length < 4096)
  assert.equal(large.spawns[0].options.windowsHide, true)
  assert.deepEqual(large.spawns[0].options.stdio, ['pipe', 'pipe', 'pipe'])
  assert.equal(large.writes.length, 1)
  assert.match(large.writes[0], /^[A-Za-z0-9+/=]+\n$/)
  assert.ok(large.writes[0].length > 32767)
  assert.equal(Buffer.from(large.writes[0].trim(), 'base64').toString('utf8'),
    `& {\n${script}\n} -OwnerWindow 4294967298 -OwnerProcessId 24680`)
  for (const f of [large, small]) {
    const stopped = f.bridge.stop()
    f.child.emit('exit', 0)
    await stopped
    assert.equal(f.timers.size, 0)
  }
})

test('native bridge rejects oversized source before spawning a helper', async () => {
  const f = bridgeFixture({ script: '#'.repeat(1048576) })
  await assert.rejects(f.bridge.start(), /脚本超过启动大小限制/)
  assert.equal(f.spawns.length, 0)
  assert.equal(f.writes.length, 0)
  assert.equal(f.timers.size, 0)
  await f.bridge.stop()
})

test('native bridge installs failure handlers and deadlines before writing startup source', async () => {
  for (const synchronous of [true, false]) {
    const error = new Error(synchronous ? 'source write threw' : 'source pipe failed')
    let f
    f = bridgeFixture({ write(_value, child) {
      assert.equal(child.stdin.listenerCount('error'), 1)
      assert.equal(child.stdout.listenerCount('data'), 1)
      assert.ok([...f.timers.values()].some(timer => timer.delay === 10000))
      if (synchronous) throw error
      queueMicrotask(() => child.stdin.emit('error', error))
      return true
    } })
    await assert.rejects(f.bridge.start(), error)
    assert.equal(f.errors[0], error)
    assert.deepEqual(f.ends, ['EXIT\n'])
    assert.equal([...f.timers.values()].some(timer => timer.delay === 10000), false)
    f.child.emit('exit', 0)
    await f.bridge.stop()
    assert.equal(f.timers.size, 0)
  }
})

test('native bridge shares stdin for startup, JSON requests and EXIT and preserves split UTF-8 replies', async () => {
  const f = bridgeFixture()
  const ready = f.bridge.start()
  assert.equal(f.bridge.start(), ready)
  assert.equal(f.writes.length, 1)
  f.child.stdout.emit('data', Buffer.from('{"ready":true}\n'))
  await ready
  assert.equal(f.timers.size, 0)
  const pending = f.bridge.request('sample')
  await settle()
  assert.deepEqual(JSON.parse(f.writes[1]), { command: 'sample', id: 1 })
  assert.ok([...f.timers.values()].some(timer => timer.delay === 3000))
  const reply = { id: 1, ok: true, bars: [], dark: false, warning: '任务栏 🎵 café' }
  const bytes = Buffer.from(`${JSON.stringify(reply)}\n`, 'utf8')
  const split = bytes.indexOf(Buffer.from('任')) + 1
  f.child.stdout.emit('data', bytes.subarray(0, split))
  f.child.stdout.emit('data', bytes.subarray(split))
  assert.deepEqual(await pending, reply)
  assert.equal(f.timers.size, 0)
  const stopped = f.bridge.stop()
  assert.deepEqual(f.ends, ['EXIT\n'])
  f.child.emit('exit', 0)
  await stopped
  assert.equal(f.child.kills, 0)
  assert.equal(f.timers.size, 0)
})

test('native bridge rejects forced termination even when the killed process reports exit code zero', async () => {
  const f = bridgeFixture()
  await f.start()
  const stop = f.bridge.stop()
  const rejected = assert.rejects(stop, /无法确认已解除嵌入/)
  f.fire(1500)
  await rejected
  assert.equal(f.child.kills, 1)
  assert.equal(f.timers.size, 0)
  await assert.rejects(f.bridge.stop(), /无法确认已解除嵌入/)
  await f.bridge.stop({ ownerDestroyed: true })
})

test('native bridge rejects an unexpected exit and a failing graceful exit before owner destruction', async () => {
  for (const unexpected of [true, false]) {
    const f = bridgeFixture()
    await f.start()
    let stop
    if (!unexpected) stop = f.bridge.stop()
    f.child.emit('exit', unexpected ? 0 : 1)
    await assert.rejects(stop || f.bridge.stop(), /无法确认已解除嵌入/)
    await f.bridge.stop({ ownerDestroyed: true })
    assert.equal(f.timers.size, 0)
  }
})

test('native bridge accepts zero exit after EXIT without forcing the helper', async () => {
  const f = bridgeFixture()
  await f.start()
  const stop = f.bridge.stop()
  f.child.emit('exit', 0)
  await stop
  await f.bridge.stop()
  assert.equal(f.child.kills, 0)
  assert.equal(f.timers.size, 0)
})

test('real Windows bootstrap executes a large Unicode script and retains stdin for JSON and EXIT', { skip: process.platform !== 'win32', timeout: 15000 }, async t => {
  const source = `param([long]$OwnerWindow, [int]$OwnerProcessId)
$ProgressPreference = 'SilentlyContinue'
# ${'large bundled source '.repeat(2500)}
[Console]::Out.WriteLine('{"ready":true}')
[Console]::Out.Flush()
while (($line = [Console]::ReadLine()) -ne $null) {
  if ($line -eq 'EXIT') { break }
  $request = $line | ConvertFrom-Json
  $response = @{ id=$request.id; ok=$true; text='任务栏 🎵 café'; owner=$OwnerWindow.ToString(); pid=$OwnerProcessId }
  [Console]::Out.WriteLine(($response | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
}`
  const bridge = createWindowsTaskbarBridge({ handle: Buffer.from([2, 0, 0, 0, 1, 0, 0, 0]), ownerProcessId: 24680, readScript: () => source,
    spawnProcess(...args) { const child = spawn(...args); child.stderr.on('data', bytes => t.diagnostic(String(bytes))); return child } })
  t.after(() => bridge.stop())
  await bridge.start()
  const result = await bridge.request('sample')
  assert.equal(result.ok, true)
  assert.equal(result.text, '任务栏 🎵 café')
  assert.equal(result.owner, '4294967298')
  assert.equal(result.pid, 24680)
  await bridge.stop()
})

test('real Windows read-only taskbar probe completes ready/sample/exit without an owned window', { skip: process.platform !== 'win32', timeout: 15000 }, async t => {
  const bridge = createWindowsTaskbarBridge({ scriptPath: path.join(__dirname, '../electron/services/windowsTaskbar.ps1'), handle: Buffer.alloc(8) })
  t.after(() => bridge.stop())
  await bridge.start()
  const result = await bridge.request('sample')
  assert.equal(result.ok, true)
  assert.ok(Array.isArray(result.bars))
  assert.equal(typeof result.dark, 'boolean')
  for (const item of result.bars) {
    assert.match(item.handle, /^\d+$/)
    assert.ok(item.bounds.width > 0 && item.bounds.height > 0)
  }
  await bridge.stop()
})
