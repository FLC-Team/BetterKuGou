const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')

const mainSource = fs.readFileSync(path.join(__dirname, '../electron/main.js'), 'utf8')

/** Exercise the production notice boundary with current, hidden and stale Electron documents. */
function fixture() {
  function window() {
    const win = { destroyed: false, visible: true, minimized: false, sent: [], showCalls: 0, focusCalls: 0,
      isDestroyed() { return this.destroyed }, isVisible() { return this.visible }, isMinimized() { return this.minimized },
      show() { this.visible = true; this.showCalls++ }, showInactive() { this.visible = true; this.showCalls++ },
      restore() { this.minimized = false }, focus() { this.focusCalls++ } }
    win.webContents = { mainFrame: {}, send: (...args) => win.sent.push(args) }
    return win
  }
  const main = window(), desktop = window(), island = window(), taskbar = window()
  const event = win => ({ sender: win.webContents, senderFrame: win.webContents.mainFrame })
  const accepts = win => value => !win.destroyed && value.sender === win.webContents && value.senderFrame === win.webContents.mainFrame
  const handlers = new Map()
  const ipcMain = Object.assign(new EventEmitter(), { handle: (name, callback) => handlers.set(name, callback) })
  const context = vm.createContext({
    mainWindow: main, desktopLyricWindow: desktop, mainWindowReady: true, isQuitting: false,
    startupFailure: null, startupFailureTimer: null, userRequestedQuit: false,
    islandLyricService: { isSender: accepts(island) }, taskbarLyricService: { isSender: accepts(taskbar) },
    ipcMain, logger: { error() {} }, app: { quit() {} }, createWindow() { throw new Error('unexpected window creation') },
    setTimeout, clearTimeout
  })
  for (const name of ['isMainWindowSender', 'isDesktopLyricSender']) {
    const start = mainSource.indexOf(`function ${name}(event)`)
    vm.runInContext(mainSource.slice(start, mainSource.indexOf('\n}', start) + 2), context)
  }
  vm.runInContext(mainSource.slice(mainSource.indexOf('const pendingAppNotices = []'), mainSource.indexOf('const backendService =')), context)
  const api = vm.runInContext('({ showAppNotice, normalizeAppNotice, pendingAppNotices })', context)
  return { ...api, main, desktop, island, taskbar, ipcMain, handlers, context, event }
}

test('only current top-level lyric windows may report a bounded plain-text notice', () => {
  const f = fixture()
  const payload = { title: '歌词', message: '<text-only>', type: 'error' }
  for (const win of [f.desktop, f.island, f.taskbar]) f.ipcMain.emit('app:report-notice', f.event(win), payload)
  assert.equal(f.main.sent.length, 3)
  assert.deepEqual(JSON.parse(JSON.stringify(f.main.sent[0])), ['app:notice', payload])
  for (const event of [f.event(f.main), { sender: {}, senderFrame: {} }, { sender: f.desktop.webContents, senderFrame: {} }]) {
    f.ipcMain.emit('app:report-notice', event, payload)
  }
  f.desktop.destroyed = true
  f.ipcMain.emit('app:report-notice', f.event(f.desktop), payload)
  f.context.isQuitting = true
  f.ipcMain.emit('app:report-notice', f.event(f.island), payload)
  assert.equal(f.main.sent.length, 3)
})

test('notice payloads reject invalid types, oversized fields and executable or extra properties', () => {
  const f = fixture()
  const invalid = [null, [], 'text', {}, { message: '' }, { message: '   ' }, { message: 42 },
    { message: 'x'.repeat(2001) }, { message: 'x', title: 'x'.repeat(121) }, { message: 'x', title: [] },
    { message: 'x', id: '' }, { message: 'x', id: 3 }, { message: 'x', id: 'x'.repeat(81) },
    { message: 'x', type: 'danger' }, { message: 'x', action: () => {} }, { message: 'x', html: '<b>x</b>' }]
  for (const payload of invalid) f.ipcMain.emit('app:report-notice', f.event(f.desktop), payload)
  assert.equal(f.main.sent.length, 0)
  assert.equal(f.showAppNotice({ message: 'x'.repeat(2000), title: 'x'.repeat(120), id: 'x'.repeat(80), type: 'warning' }), true)
  assert.equal(f.main.sent.length, 1)
})

test('early notices have bounded FIFO buffering with keyed replacement', () => {
  const f = fixture()
  f.context.mainWindowReady = false
  for (let i = 0; i < 25; i++) f.showAppNotice({ id: `notice-${i}`, message: `${i}` })
  assert.equal(f.main.sent.length, 0)
  assert.equal(f.pendingAppNotices.length, 20)
  assert.equal(f.pendingAppNotices[0].message, '5')
  f.showAppNotice({ id: 'notice-10', message: 'latest' })
  assert.equal(f.pendingAppNotices.length, 20)
  assert.equal(f.pendingAppNotices.at(-1).message, 'latest')
  assert.equal(f.pendingAppNotices.filter(notice => notice.id === 'notice-10').length, 1)
})

test('errors reveal a hidden or minimized main window without focusing a visible window', () => {
  const f = fixture()
  f.main.visible = false
  f.ipcMain.emit('app:report-notice', f.event(f.desktop), { message: 'saved', type: 'success' })
  assert.equal(f.main.visible, false)
  f.ipcMain.emit('app:report-notice', f.event(f.desktop), { message: 'failed', type: 'error' })
  assert.equal(f.main.visible, true)
  assert.equal(f.main.showCalls, 1)
  f.ipcMain.emit('app:report-notice', f.event(f.desktop), { message: 'failed again', type: 'error' })
  assert.equal(f.main.showCalls, 1)
  assert.equal(f.main.focusCalls, 0)
  f.main.minimized = true
  f.ipcMain.emit('app:report-notice', f.event(f.desktop), { message: 'failed minimized', type: 'warning' })
  assert.equal(f.main.minimized, false)
})

test('preload exposes fixed notice channels, hides event objects and releases subscriptions', async () => {
  const exposed = {}, sends = [], invokes = [], listeners = new Map()
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../electron/preload.js'), 'utf8'), {
    require: () => ({ contextBridge: { exposeInMainWorld: (name, api) => { exposed[name] = api } }, ipcRenderer: {
      on: (name, callback) => listeners.set(name, callback), removeListener: (name, callback) => { if (listeners.get(name) === callback) listeners.delete(name) },
      send: (...args) => sends.push(args), invoke: async (...args) => { invokes.push(args) }
    } }), window: {}, console
  })
  const notices = []
  const release = exposed.electronAPI.onAppNotice(value => notices.push(value))
  const payload = { title: '提示', message: '已完成', type: 'success' }
  listeners.get('app:notice')({ privateEvent: true }, payload)
  assert.deepEqual(notices, [payload])
  release()
  assert.equal(listeners.has('app:notice'), false)
  for (const name of ['desktopLyricAPI', 'islandLyricAPI', 'taskbarLyricAPI']) exposed[name].reportNotice(payload)
  assert.deepEqual(sends, Array.from({ length: 3 }, () => ['app:report-notice', payload]))
  await exposed.electronAPI.getStartupFailure()
  await exposed.electronAPI.quitAfterStartupFailure()
  assert.deepEqual(invokes, [['app:get-startup-failure'], ['app:quit-after-startup-failure']])
})
