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
  ipc.send = (...args) => sent.push(args)
  ipc.invoke = async () => true
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../electron/preload.js'), 'utf8'), {
    require: () => ({ ipcRenderer: ipc, contextBridge: { exposeInMainWorld: (name, value) => { exposed[name] = value } } }),
    window: {}, console
  })
  return { exposed, ipc, sent }
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
