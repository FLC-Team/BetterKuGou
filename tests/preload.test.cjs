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
