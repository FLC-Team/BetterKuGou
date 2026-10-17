const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

/** Run the production sender check and clipboard handler against isolated Electron boundaries. */
function clipboardHandler() {
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.js'), 'utf8')
  const start = source.indexOf('function isMainWindowSender(event)')
  const end = source.indexOf('/** 每次准备只绑定', start)
  const writes = []
  const handlers = new Map()
  const mainWindow = { destroyed: false, isDestroyed() { return this.destroyed }, webContents: { mainFrame: {} } }
  let failure = null
  vm.runInNewContext(source.slice(start, end), {
    mainWindow, Buffer,
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    clipboard: { writeText(text) { if (failure) throw failure; writes.push(text) } }
  })
  return {
    handle: handlers.get('clipboard:write-text'), writes, mainWindow,
    event: { sender: mainWindow.webContents, senderFrame: mainWindow.webContents.mainFrame },
    fail: error => { failure = error }
  }
}

test('clipboard writes accept only the main window top frame and expose no read operation', () => {
  const { handle, event, mainWindow, writes } = clipboardHandler()
  assert.equal(handle(event, '第一句\nSecond line'), true)
  assert.deepEqual(writes, ['第一句\nSecond line'])
  for (const invalid of [
    { sender: {}, senderFrame: event.senderFrame },
    { sender: event.sender, senderFrame: {} },
    { sender: event.sender }
  ]) assert.throws(() => handle(invalid, 'private lyric'), /不允许/)
  mainWindow.destroyed = true
  assert.throws(() => handle(event, 'private lyric'), /不允许/)
  assert.equal(writes.length, 1)
})

test('clipboard input is strict text and limited to one MiB of UTF-8 data', () => {
  const { handle, event, writes } = clipboardHandler()
  for (const value of [null, undefined, 1, true, {}, ['lyric']]) assert.throws(() => handle(event, value), /格式或长度/)
  assert.throws(() => handle(event, 'a'.repeat(1024 * 1024 + 1)), /格式或长度/)
  assert.throws(() => handle(event, '词'.repeat(Math.floor(1024 * 1024 / 3) + 1)), /格式或长度/)
  assert.equal(handle(event, 'a'.repeat(1024 * 1024)), true)
  assert.equal(writes.length, 1)
})

test('clipboard platform failures propagate without copying the lyric into an error', () => {
  const fixture = clipboardHandler()
  fixture.fail(new Error('Clipboard unavailable'))
  assert.throws(() => fixture.handle(fixture.event, 'private lyric'), /Clipboard unavailable/)
  assert.equal(fixture.writes.length, 0)
})

test('preload exposes only a fixed clipboard write bridge', async () => {
  const exposed = {}
  const calls = []
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../electron/preload.js'), 'utf8'), {
    require: () => ({
      ipcRenderer: { invoke: async (...args) => { calls.push(args); return true } },
      contextBridge: { exposeInMainWorld: (name, api) => { exposed[name] = api } }
    }),
    window: {}, console
  })
  assert.equal(await exposed.electronAPI.writeClipboardText('第一句'), true)
  assert.deepEqual(calls, [['clipboard:write-text', '第一句']])
  assert.equal(exposed.electronAPI.readClipboardText, undefined)
  assert.equal(exposed.electronAPI.clipboard, undefined)
})
