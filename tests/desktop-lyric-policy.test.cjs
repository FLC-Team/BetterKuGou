const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { evaluateDesktopLyricPolicy, sameMonitorBounds } = require('../electron/services/desktopLyricPolicy')
const { createWindowsForegroundMonitor } = require('../electron/services/windowsForeground')

test('desktop hiding combines paused, same-display lyric overlay and foreground fullscreen without changing preferences', () => {
  const preferences = { autoHidePaused: true, hideOnLyricView: true, hideOnFullscreen: true }
  assert.equal(evaluateDesktopLyricPolicy({ preferences, playing: true }).hidden, false)
  assert.equal(evaluateDesktopLyricPolicy({ preferences }).hidden, true)
  const lyric = { preferences, playing: true, mainVisible: true, lyricViewVisible: true, sameDisplay: true }
  assert.equal(evaluateDesktopLyricPolicy(lyric).hidden, true)
  assert.equal(evaluateDesktopLyricPolicy({ ...lyric, mainVisible: false }).hidden, false)
  assert.equal(evaluateDesktopLyricPolicy({ ...lyric, sameDisplay: false }).hidden, false)
  assert.equal(evaluateDesktopLyricPolicy({ preferences, playing: true, fullscreenOnDisplay: true }).hidden, true)
  assert.equal(evaluateDesktopLyricPolicy({ ...lyric, playing: false, fullscreenOnDisplay: true, forceVisible: true }).hidden, false)
  assert.deepEqual(preferences, { autoHidePaused: true, hideOnLyricView: true, hideOnFullscreen: true })
})

test('locked click-through is relaxed only within the fixed unlock rectangle, including negative monitor coordinates', () => {
  const bounds = { x: -800, y: 300, width: 700, height: 200 }
  const preferences = { locked: true }
  const calculate = cursor => evaluateDesktopLyricPolicy({ preferences, bounds, cursor })
  assert.equal(calculate({ x: -152, y: 308 }).ignoreMouse, false)
  assert.equal(calculate({ x: -109, y: 343 }).ignoreMouse, false)
  for (const cursor of [{ x: -153, y: 308 }, { x: -108, y: 308 }, { x: -120, y: 307 }, { x: -120, y: 344 }]) {
    assert.equal(calculate(cursor).ignoreMouse, true)
  }
  assert.equal(evaluateDesktopLyricPolicy({ preferences: { ...preferences, hideUnlockButton: true }, bounds, cursor: { x: -120, y: 320 } }).ignoreMouse, true)
  assert.equal(evaluateDesktopLyricPolicy({ preferences: { locked: false }, bounds, cursor: { x: -600, y: 400 } }).ignoreMouse, false)
})

test('hover fading applies only while locked, never raises base opacity and preserves the unlock recovery target', () => {
  const bounds = { x: 0, y: 0, width: 800, height: 200 }
  const preferences = { locked: true, hoverFade: true, hoverOpacity: 20, opacity: 80, alwaysOnTop: false }
  assert.equal(evaluateDesktopLyricPolicy({ preferences, bounds, cursor: { x: 100, y: 100 } }).opacity, 0.2)
  assert.equal(evaluateDesktopLyricPolicy({ preferences, bounds, cursor: { x: 900, y: 100 } }).opacity, 0.8)
  assert.equal(evaluateDesktopLyricPolicy({ preferences: { ...preferences, locked: false }, bounds, cursor: { x: 100, y: 100 } }).opacity, 0.8)
  assert.equal(evaluateDesktopLyricPolicy({ preferences: { ...preferences, opacity: 10 }, bounds, cursor: { x: 100, y: 100 } }).opacity, 0.1)
  const faded = { preferences: { ...preferences, opacity: 0, hoverOpacity: 0 }, bounds, cursor: { x: 770, y: 20 } }
  assert.equal(evaluateDesktopLyricPolicy(faded).opacity, 0.2)
  assert.equal(evaluateDesktopLyricPolicy(faded).ignoreMouse, false)
  assert.equal(evaluateDesktopLyricPolicy(faded).alwaysOnTop, false)
  assert.equal(evaluateDesktopLyricPolicy({ preferences: { locked: true, hideUnlockButton: true } }).monitorPointer, false)
})

test('monitor matching requires finite geometry and tolerates only DIP rounding differences', () => {
  const monitor = { x: -1280, y: 0, width: 1280, height: 720 }
  assert.equal(sameMonitorBounds(monitor, { x: -1280, y: 0, width: 1281, height: 720 }), true)
  assert.equal(sameMonitorBounds(monitor, { ...monitor, x: 0 }), false)
  assert.equal(sameMonitorBounds(monitor, { ...monitor, width: NaN }), false)
  assert.equal(sameMonitorBounds(monitor, null), false)
})

function monitorFixture(platform = 'win32') {
  let nextTimer = 0
  const timeouts = new Map()
  const intervals = new Map()
  const children = []
  const errors = []
  const snapshots = []
  const options = []
  const timers = {
    setTimeout(callback, delay) { const id = ++nextTimer; timeouts.set(id, { callback, delay }); return id },
    clearTimeout(id) { timeouts.delete(id) },
    setInterval(callback, delay) { const id = ++nextTimer; intervals.set(id, { callback, delay }); return id },
    clearInterval(id) { intervals.delete(id) }
  }
  const monitor = createWindowsForegroundMonitor({ platform, scriptPath: '/bundle/windowsForeground.ps1', ownerProcessId: 42,
    readScript: file => { assert.equal(file, '/bundle/windowsForeground.ps1'); return 'param([int]$OwnerProcessId)' },
    spawnProcess(executable, args, config) {
      options.push({ executable, args, config })
      const child = new EventEmitter()
      child.pid = 100 + children.length
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.stdin = Object.assign(new EventEmitter(), { writes: [], write(value) { this.writes.push(value) },
        end(value) { this.writes.push(value); child.endRequested = true } })
      child.kill = () => { child.killCalls = (child.killCalls || 0) + 1; child.emit('exit', null) }
      children.push(child)
      return child
    }, onChange: value => snapshots.push(value), onError: error => errors.push(error), timers })
  return { monitor, children, errors, snapshots, options, timeouts, intervals,
    output(value, child = children.at(-1)) { child.stdout.emit('data', Buffer.from(JSON.stringify(value) + '\n')) },
    tick() { for (const { callback } of [...intervals.values()]) callback() },
    expire(delay) { for (const [id, timer] of [...timeouts]) if (timer.delay === delay) { timeouts.delete(id); timer.callback() } }
  }
}

test('foreground helper is opt-in, hidden, serially sampled and adjusts cadence without respawning', async () => {
  const f = monitorFixture()
  await f.monitor.configure({ enabled: false })
  assert.equal(f.children.length, 0)
  await f.monitor.configure({ enabled: true })
  assert.equal(f.children.length, 1)
  assert.equal(f.options[0].config.windowsHide, true)
  assert.ok(!f.options[0].args.includes('-WindowStyle'), 'GUI parents use windowsHide alone to avoid PowerShell console initialization blocking')
  assert.match(Buffer.from(f.options[0].args.at(-1), 'base64').toString('utf16le'), /OwnerProcessId 42/)
  f.output({ ready: true })
  assert.deepEqual(f.children[0].stdin.writes, ['SAMPLE\n'])
  f.tick()
  assert.equal(f.children[0].stdin.writes.length, 1, 'an outstanding sample is never duplicated')
  f.output({ fullscreen: true, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, title: 'ignored' })
  assert.deepEqual(f.monitor.getSnapshot(), { fullscreen: true, bounds: { x: 0, y: 0, width: 1920, height: 1080 } })
  await f.monitor.configure({ enabled: true, efficientMode: true })
  assert.equal(f.children.length, 1)
  assert.equal([...f.intervals.values()][0].delay, 300)
  f.output({ fullscreen: false })
  const stopped = f.monitor.stop()
  assert.equal(f.children[0].endRequested, true)
  assert.equal(f.intervals.size, 0)
  f.children[0].emit('exit', 0)
  await stopped
  assert.equal(f.timeouts.size, 0)
  assert.deepEqual(f.monitor.getSnapshot(), { fullscreen: false })
})

test('unsupported platforms never spawn and helper failures fail open until the setting is retried', async () => {
  const unsupported = monitorFixture('linux')
  await unsupported.monitor.configure({ enabled: true })
  assert.equal(unsupported.children.length, 0)
  const f = monitorFixture()
  await f.monitor.configure({ enabled: true })
  f.output({ ready: true })
  f.output({ fullscreen: true, bounds: { x: 0, y: 0, width: 1920, height: 1080 } })
  f.tick()
  f.expire(2000)
  assert.equal(f.errors.length, 1)
  assert.deepEqual(f.monitor.getSnapshot(), { fullscreen: false })
  await f.monitor.configure({ enabled: true })
  assert.equal(f.children.length, 1)
  f.expire(1500)
  assert.equal(f.children[0].killCalls, 1, 'forced cleanup targets only the owned helper')
  await f.monitor.configure({ enabled: false })
  await f.monitor.configure({ enabled: true })
  assert.equal(f.children.length, 2)
  f.output({ ready: true })
  f.output({ fullscreen: false })
  // Late bytes from a retired helper cannot hide the new window.
  f.output({ fullscreen: true, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }, f.children[0])
  assert.deepEqual(f.monitor.getSnapshot(), { fullscreen: false })
  const stopped = f.monitor.stop()
  f.children[1].emit('exit', 0)
  await stopped
})

test('a helper that does not exit rejects bounded cleanup, retains its owned handle and can be stopped again', async () => {
  const f = monitorFixture()
  await f.monitor.configure({ enabled: true })
  f.output({ ready: true })
  f.output({ fullscreen: false })
  const child = f.children[0]
  child.kill = () => { child.emit('error', new Error('Cannot signal owned helper')); return false }
  const failed = assert.rejects(f.monitor.stop(), /清理失败/)
  f.expire(1500)
  f.expire(3000)
  await failed
  assert.equal(f.errors.length, 1)
  assert.equal(f.timeouts.size, 0)
  let retriedKill = 0
  child.kill = () => { retriedKill++; child.emit('exit', null); return true }
  const retried = f.monitor.stop()
  f.expire(1500)
  await retried
  assert.equal(retriedKill, 1, 'a signal error did not falsely mark the child as exited')
  assert.equal(f.timeouts.size, 0)
})

test('rapid disable and reenable waits for the retired helper before creating its replacement', async () => {
  const f = monitorFixture()
  await f.monitor.configure({ enabled: true })
  const disabled = f.monitor.configure({ enabled: false })
  await f.monitor.configure({ enabled: true })
  assert.equal(f.children.length, 1)
  f.children[0].emit('exit', 0)
  await disabled
  assert.equal(f.children.length, 2)
  const stopped = f.monitor.stop()
  f.children[1].emit('exit', 0)
  await stopped
})
