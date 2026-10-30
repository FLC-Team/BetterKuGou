const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')

function loadBridge() {
  const exposed = {}
  const ipc = new EventEmitter()
  const sent = []
  const invoked = []
  ipc.send = (...args) => sent.push(args)
  ipc.invoke = async (...args) => { invoked.push(args); return true }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../electron/preload.js'), 'utf8'), {
    require: () => ({ ipcRenderer: ipc, contextBridge: { exposeInMainWorld: (name, value) => { exposed[name] = value } } }),
    window: {}, console
  })
  return { exposed, ipc, sent, invoked }
}

test('window and auxiliary subscriptions hide Electron events and release only their own listener', () => {
  const { exposed, ipc } = loadBridge()
  let calls = 0
  const other = () => {}
  ipc.on('window-is-maximized', other)
  const unsubscribe = exposed.electronAPI.onMaximized((...args) => {
    assert.equal(args.length, 0)
    calls += 1
  })
  ipc.emit('window-is-maximized', { sender: 'privileged object' })
  unsubscribe()
  unsubscribe()
  ipc.emit('window-is-maximized', {})
  assert.equal(calls, 1)
  assert.equal(ipc.listenerCount('window-is-maximized'), 1)
  let received
  const dispose = exposed.desktopLyricAPI.onTimeUpdate(time => { received = time })
  ipc.emit('desktop-lyric:time-update', { sender: 'privileged object' }, 1200)
  assert.equal(received, 1200)
  dispose()
  assert.equal(ipc.listenerCount('desktop-lyric:time-update'), 0)
  assert.equal(exposed.desktopLyricAPI.send, undefined)
})

test('playback time bridge rejects non-finite and negative values', () => {
  const { exposed, sent } = loadBridge()
  for (const value of [NaN, Infinity, -1, '1']) {
    exposed.electronAPI.updateCurrentTime(value)
    exposed.electronAPI.updatePlaybackTime(value)
  }
  assert.equal(sent.length, 0)
  exposed.electronAPI.updateCurrentTime(1.2)
  assert.equal(sent[0][0], 'player:time-update')
  assert.equal(sent[0][1], 1200)
})

test('desktop bridge preserves track identity, explicit clearing and millisecond playback metadata', () => {
  const { exposed, sent } = loadBridge()
  exposed.electronAPI.updateTrack({ trackId: 'hash-a', title: 'Same title', artist: 'Artist' })
  exposed.electronAPI.updateLyrics([{ time: 0, text: 'Lyric' }], 'hash-a')
  exposed.electronAPI.updatePlaybackTime(1250, {
    trackId: 'hash-a', duration: 20000, advancing: true, playbackRate: 1.5, discontinuity: true, extra: 'ignored'
  })
  exposed.electronAPI.updateTrack(null)
  assert.equal(sent[0][1].trackId, 'hash-a')
  assert.equal(sent[1][2], 'hash-a')
  assert.equal(sent[2][1], 1250)
  assert.deepEqual(JSON.parse(JSON.stringify(sent[2][2])), {
    trackId: 'hash-a', duration: 20000, advancing: true, playbackRate: 1.5, discontinuity: true
  })
  assert.deepEqual(sent[3], ['player:track-update', null])
})

test('desktop timing metadata defaults to a frozen normal-rate sample unless explicitly authorized', () => {
  const { exposed, sent, ipc } = loadBridge()
  for (const playbackRate of [-1, 0, NaN, Infinity, '2']) {
    exposed.electronAPI.updatePlaybackTime(2500, { advancing: 'true', playbackRate, discontinuity: 'true', duration: -1 })
    assert.deepEqual(JSON.parse(JSON.stringify(sent.at(-1)[2])), { advancing: false, playbackRate: 1, discontinuity: false })
  }
  exposed.electronAPI.updatePlaybackTime(3000)
  assert.deepEqual(JSON.parse(JSON.stringify(sent.at(-1)[2])), { advancing: false, playbackRate: 1, discontinuity: false })
  const timing = { duration: 20000, advancing: true, playbackRate: 1.5, discontinuity: false }
  let received
  const unsubscribe = exposed.desktopLyricAPI.onTimeUpdate((...args) => { received = args })
  ipc.emit('desktop-lyric:time-update', { sender: 'privileged' }, 3500, timing)
  assert.deepEqual(received, [3500, timing])
  unsubscribe()
})

test('desktop commands are validated fixed invocations and playback/error subscriptions release independently', async () => {
  const { exposed, invoked, ipc } = loadBridge()
  const desktop = exposed.desktopLyricAPI
  for (const result of await Promise.all([
    desktop.changeSize('huge'), desktop.changeTheme('unknown'), desktop.setLocked('true'),
    desktop.setTranslation(1), desktop.control('delete')
  ])) assert.equal(result.success, false)
  assert.equal(invoked.length, 0)
  await desktop.control('toggle')
  await desktop.setLocked(false)
  await desktop.setTranslation(true)
  await exposed.electronAPI.desktopLyric.resetPosition()
  assert.deepEqual(invoked.map(args => args[0]), ['desktop-lyric:control', 'desktop-lyric:set-locked', 'desktop-lyric:set-translation', 'desktop-lyric:reset-position'])
  const received = []
  const other = () => {}
  ipc.on('desktop-lyric:playback-update', other)
  const releasePlayback = desktop.onPlaybackUpdate((...args) => received.push(args))
  const releaseError = desktop.onError((...args) => received.push(args))
  const playback = { playing: false, time: 1250, available: true }
  ipc.emit('desktop-lyric:playback-update', { sender: 'privileged' }, playback)
  ipc.emit('desktop-lyric:error', { sender: 'privileged' }, '保存失败')
  assert.deepEqual(received, [[playback], ['保存失败']])
  releasePlayback(); releaseError()
  assert.equal(ipc.listenerCount('desktop-lyric:playback-update'), 1)
  assert.equal(ipc.listenerCount('desktop-lyric:error'), 0)
})

test('startup bridge exposes only fixed backend and renderer readiness channels', async () => {
  const { exposed, invoked, sent } = loadBridge()
  await exposed.electronAPI.waitForBackend()
  exposed.electronAPI.notifyReady()
  assert.equal(invoked[0][0], 'backend:ready')
  assert.equal(sent[0][0], 'renderer:ready')
  assert.equal(exposed.electronAPI.send, undefined)
})

test('updates expose fixed operations and release state subscriptions without leaking Electron events', async () => {
  const { exposed, ipc, invoked } = loadBridge()
  const updates = exposed.electronAPI.updates
  await updates.getState()
  await updates.check()
  await updates.download(123)
  await updates.cancel()
  await updates.revealDownloadedFile()
  await updates.requestInstall()
  assert.deepEqual(invoked.map(args => Array.from(args)), [
    ['updates:get-state'], ['updates:check'], ['updates:download', 123],
    ['updates:cancel'], ['updates:reveal'], ['updates:install']
  ])
  const received = []
  const dispose = updates.onState((...args) => received.push(args))
  const state = { revision: 3, status: 'downloaded' }
  ipc.emit('updates:state', { sender: 'privileged' }, state)
  assert.deepEqual(received, [[state]])
  dispose()
  dispose()
  ipc.emit('updates:state', {}, state)
  assert.equal(received.length, 1)
  assert.equal(ipc.listenerCount('updates:state'), 0)
  assert.equal(updates.send, undefined)
})

test('installer preparation uses fixed channels, hides IPC objects and releases its subscription', async () => {
  const { exposed, ipc, invoked } = loadBridge()
  const updates = exposed.electronAPI.updates
  const received = []
  const dispose = updates.onPrepareForInstall(payload => received.push(payload))
  const prepare = { requestId: 'current', phase: 'prepare' }
  const canceled = { requestId: 'current', phase: 'canceled', errorCode: 'TIMEOUT' }
  ipc.emit('updates:prepare-install', { sender: 'privileged' }, prepare)
  ipc.emit('updates:prepare-install', { sender: 'privileged' }, canceled)
  assert.deepEqual(received, [prepare, canceled])
  await updates.completePrepareForInstall('current', { success: true })
  assert.deepEqual(Array.from(invoked[0]), ['updates:prepare-install-complete', 'current', { success: true }])
  dispose()
  assert.equal(ipc.listenerCount('updates:prepare-install'), 0)
})
