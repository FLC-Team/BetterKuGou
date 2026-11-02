const path = require('node:path')
const { createWindowsTaskbarBridge } = require('./windowsTaskbar')

const validRect = value => value && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(value[key])) && value.width > 0 && value.height > 0
const clamp = (value, min, max) => Math.max(min, Math.min(max, value))
const same = (first, second) => JSON.stringify(first) === JSON.stringify(second)

/** Use only verified free horizontal taskbar space. Unknown layouts float above the bar. */
function taskbarLayout({ display, bar, preferences = {}, contentSize = {} }) {
  const area = display.bounds || display.workArea
  const work = display.workArea || area
  const edge = bar?.edge || (work.y > area.y ? 'top' : work.x > area.x ? 'left' : work.width < area.width ? 'right' : 'bottom')
  const desired = preferences.adaptive === false ? 480 : clamp(contentSize.width || 420, 120, 8192)
  const maximum = preferences.maxWidth > 0 ? preferences.maxWidth : 8192
  const requestedHeight = clamp(contentSize.height || (preferences.doubleLine === false ? 32 : 42), 24, 120)
  const startMargin = Math.max(0, Number(preferences.marginStart) || 0)
  const endMargin = Math.max(0, Number(preferences.marginEnd) || 0)
  let interval = null
  if (bar?.reliable && validRect(bar.bounds) && ['top', 'bottom'].includes(edge)) {
    const begin = Math.max(area.x, bar.bounds.x) + 8 + startMargin
    const end = Math.min(area.x + area.width, bar.bounds.x + bar.bounds.width) - 8 - endMargin
    const occupied = (bar.occupied || []).filter(validRect).filter(rect => rect.y < bar.bounds.y + bar.bounds.height && rect.y + rect.height > bar.bounds.y)
      .map(rect => [Math.max(begin, rect.x - 6), Math.min(end, rect.x + rect.width + 6)]).filter(([left, right]) => right > left).sort((a, b) => a[0] - b[0])
    const free = []
    let cursor = begin
    for (const [left, right] of occupied) { if (left > cursor) free.push([cursor, left]); cursor = Math.max(cursor, right) }
    if (end > cursor) free.push([cursor, end])
    const usable = free.filter(([left, right]) => right - left >= 120)
    interval = preferences.region === 'start' ? usable[0] : preferences.region === 'end' ? usable.at(-1) : usable.sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]))[0]
  }
  const taskbarVisible = bar?.visible !== false && validRect(bar?.bounds) &&
    bar.bounds.y >= area.y && bar.bounds.y + bar.bounds.height <= area.y + area.height
  const inTaskbar = Boolean(interval) && taskbarVisible
  const embedded = preferences.embed !== false && inTaskbar
  let width, height, x, y
  const align = preferences.windowAlignment || 'auto'
  if (inTaskbar) {
    width = Math.round(Math.min(desired, maximum, interval[1] - interval[0]))
    height = Math.round(Math.min(requestedHeight, bar.bounds.height))
    x = align === 'end' ? interval[1] - width : align === 'center' || align === 'auto' ? interval[0] + (interval[1] - interval[0] - width) / 2 : interval[0]
    y = clamp(bar.bounds.y + (bar.bounds.height - height) / 2 + (Number(preferences.verticalOffset) || 0), bar.bounds.y, bar.bounds.y + bar.bounds.height - height)
  } else {
    width = Math.round(Math.min(desired, maximum, Math.max(1, work.width - Math.min(startMargin + endMargin, work.width - 120))))
    height = Math.round(Math.min(requestedHeight, work.height))
    const left = Math.min(work.x + startMargin, work.x + work.width - width)
    const right = Math.max(left, work.x + work.width - endMargin - width)
    x = align === 'start' || (align === 'auto' && preferences.region === 'start') ? left : align === 'end' || (align === 'auto' && preferences.region === 'end') ? right : (left + right) / 2
    const autoHiddenInset = work.height >= area.height - 4 ? Math.min(bar?.bounds?.height || 48, 120) : 0
    y = edge === 'top' ? work.y + autoHiddenInset + 4 : work.y + work.height - height - autoHiddenInset - 4
    y = clamp(y + (Number(preferences.verticalOffset) || 0), work.y, work.y + work.height - height)
  }
  return { bounds: { x: Math.round(x), y: Math.round(y), width, height }, embedded, edge,
    availableWidth: interval ? Math.floor(interval[1] - interval[0]) : work.width,
    warning: !bar ? '未检测到任务栏，已使用悬浮模式。' : !['top', 'bottom'].includes(edge) ? '竖向任务栏使用悬浮模式。' : !taskbarVisible ? '任务栏已隐藏或正在移动，暂时使用悬浮模式。' : !interval ? '任务栏没有足够的可用空间，已使用悬浮模式。' : '' }
}

/** Owns one auxiliary window and one bounded native helper; playback stays in the main player. */
function createTaskbarLyricService({ BrowserWindow, screen, preload, page, scriptPath = path.join(__dirname, 'windowsTaskbar.ps1'), logger,
  platform = process.platform, isQuitting = () => false, onReady = () => {}, onFailure = () => {}, onCloseRequest = () => {}, onState = () => {},
  createBridge = createWindowsTaskbarBridge }) {
  let current = null
  let preferences = {}
  let hasTrack = false
  let playing = false
  let contentSize = {}
  let closing = Promise.resolve()
  let closingActive = false
  const retiring = new Set()
  let snapshot = { supported: platform === 'win32', visible: false, embedded: false, status: 'closed', warning: '', edge: 'bottom', availableWidth: 0 }
  const selectedDisplay = () => screen.getAllDisplays().find(display => String(display.id) === preferences.displayId) || screen.getPrimaryDisplay()
  function getDisplays() {
    const primary = screen.getPrimaryDisplay()
    return screen.getAllDisplays().map((display, index) => ({ id: String(display.id), label: display.label || `屏幕 ${index + 1}`, primary: display.id === primary.id, bounds: display.bounds, workArea: display.workArea }))
  }
  function publish(value) {
    const next = { ...snapshot, ...value }
    if (same(next, snapshot)) return
    snapshot = next
    if (current?.loaded && !current.window.isDestroyed()) {
      current.window.webContents.send('taskbar-lyric:state', snapshot)
      current.window.webContents.send('taskbar-lyric:runtime-state', { hidden: !snapshot.visible })
    }
    onState(snapshot)
  }
  function findBar(state, display) {
    const area = display.bounds || display.workArea
    const center = { x: area.x + area.width / 2, y: area.y + area.height / 2 }
    return state.bars.find(bar => validRect(bar.monitor) && center.x >= bar.monitor.x && center.x < bar.monitor.x + bar.monitor.width && center.y >= bar.monitor.y && center.y < bar.monitor.y + bar.monitor.height)
  }
  const visible = state => state.loaded && (state.previewing || !preferences.autoHide || (hasTrack && playing))

  /** Serialize layout and native parenting; newer settings are coalesced after an in-flight request. */
  async function fit(state) {
    if (current !== state || state.closing || state.nativeRecovering || !state.loaded) return
    if (state.fitting) { state.refit = true; return }
    state.fitting = true
    try {
      do {
        state.refit = false
        if (current !== state || state.closing || state.nativeRecovering || state.window.isDestroyed()) break
        const display = selectedDisplay()
        const bar = findBar(state, display)
        let layout = taskbarLayout({ display, bar, preferences: state.nativeFailed ? { ...preferences, embed: false } : preferences, contentSize })
        const shouldShow = visible(state)
        if (state.nativeReady && !state.nativeFailed) {
          if (layout.embedded) {
            const physical = screen.dipToScreenRect ? screen.dipToScreenRect(null, layout.bounds) : layout.bounds
            const command = { parent: bar.handle, embed: true, ...physical, visible: shouldShow }
            if (!same(command, state.lastPlacement)) {
              state.nativeDetached = false
              state.needsFloatingBounds = true
              const result = await state.bridge.request('apply', command)
              if (current !== state || state.closing || state.nativeRecovering) break
              if (!result.embedded) {
                layout = taskbarLayout({ display, bar, preferences: { ...preferences, embed: false }, contentSize })
                layout.warning = result.warning === 'dpi-mismatch' ? '任务栏与窗口的缩放模式不同，已安全切换到悬浮模式。' : '系统未允许嵌入任务栏，已切换到悬浮模式。'
                // Preserve the refusal so unchanged polls do not repeatedly call SetParent.
                state.refusedLayout = layout
              } else state.refusedLayout = null
              state.lastPlacement = command
            }
            if (state.refusedLayout) layout = state.refusedLayout
          } else {
            state.lastPlacement = null
            state.refusedLayout = null
          }
          if (!layout.embedded && !state.nativeDetached) {
            await state.bridge.request('detach')
            if (current !== state || state.closing || state.nativeRecovering) break
            state.nativeDetached = true
          }
        } else {
          layout = taskbarLayout({ display, preferences: { ...preferences, embed: false }, contentSize })
        }
        if (!layout.embedded) {
          // Frameless Electron owns its non-client sizing. Raw SetWindowPos can remove
          // the hidden caption height, so floating placement only runs after detach.
          if (state.needsFloatingBounds || !same(state.window.getBounds(), layout.bounds)) state.window.setBounds(layout.bounds)
          state.needsFloatingBounds = false
          if (shouldShow) state.window.showInactive(); else state.window.hide()
        }
        if (current !== state || state.closing || state.nativeRecovering) break
        publish({ visible: shouldShow, embedded: layout.embedded, status: layout.embedded ? 'embedded' : 'floating', edge: layout.edge,
          availableWidth: layout.availableWidth, warning: state.nativeFailed ? '任务栏检测不可用，已使用悬浮模式；关闭后重新启用可重试。' : layout.warning })
      } while (state.refit)
    } catch (error) { nativeFailure(state, error) } finally { state.fitting = false }
  }

  async function nativeFailure(state, error) {
    if (current !== state || state.closing || state.nativeFailed) return
    state.nativeFailed = true
    state.nativeRecovering = true
    clearInterval(state.poll)
    logger?.warn?.('taskbar-lyrics', '任务栏原生能力不可用，回退悬浮窗口', error)
    try { await state.bridge?.stop() } catch (stopError) {
      logger?.error?.('taskbar-lyrics', '任务栏检测清理失败', stopError)
      // A failed detach cannot safely use Electron's top-level coordinates. Destroy only
      // our own HWND, retain the helper for close retries and surface the failure.
      if (current === state && !state.closing) { state.window.destroy(); onFailure() }
      return
    }
    state.nativeDetached = true
    state.nativeRecovering = false
    if (current === state && !state.closing) void fit(state)
  }

  async function sample(state) {
    if (current !== state || state.closing || state.sampling || state.nativeFailed) return
    state.sampling = true
    try {
      const result = await state.bridge.request('sample')
      if (current !== state || state.closing) return
      const convert = rect => screen.screenToDipRect ? screen.screenToDipRect(null, rect) : rect
      state.bars = (Array.isArray(result.bars) ? result.bars : []).filter(bar => /^\d+$/.test(bar?.handle) && validRect(bar.bounds) && validRect(bar.monitor)).map(bar => ({
        handle: bar.handle, edge: ['top', 'bottom', 'left', 'right'].includes(bar.edge) ? bar.edge : 'bottom', visible: bar.visible === true, reliable: bar.reliable === true,
        bounds: convert(bar.bounds), monitor: convert(bar.monitor), occupied: (Array.isArray(bar.occupied) ? bar.occupied : []).filter(validRect).map(convert)
      }))
      publish({ dark: result.dark !== false })
      await fit(state)
    } catch (error) { await nativeFailure(state, error) } finally { state.sampling = false }
  }

  function polling(state) {
    clearInterval(state.poll)
    if (state.nativeFailed || !state.nativeReady) return
    state.poll = setInterval(() => { void sample(state) }, { low: 1500, medium: 700, high: 250 }[preferences.pollingRate] || 700)
    state.poll.unref?.()
  }

  function configure(value = {}) {
    const rateChanged = preferences.pollingRate !== value.pollingRate
    preferences = { ...value }
    if (current) { if (rateChanged) polling(current); void fit(current) }
  }
  function send(channel, ...payload) {
    if (current?.loaded && !current.window.isDestroyed()) current.window.webContents.send(channel, ...payload)
    if (channel === 'taskbar-lyric:song-update') hasTrack = Boolean(payload[0])
    if (channel === 'taskbar-lyric:playback-update') playing = payload[0]?.playing === true && payload[0]?.available !== false
    if (current && ['taskbar-lyric:song-update', 'taskbar-lyric:playback-update'].includes(channel)) void fit(current)
  }
  function preview() {
    const state = current
    if (!state) return
    state.previewing = true
    clearTimeout(state.previewTimer)
    void fit(state)
    state.previewTimer = setTimeout(() => { state.previewing = false; if (current === state) void fit(state) }, 3000)
    state.previewTimer.unref?.()
  }
  function setContentSize(value) {
    if (!Number.isFinite(value?.width) || !Number.isFinite(value?.height)) return
    const next = { width: Math.round(clamp(value.width, 120, 8192)), height: Math.round(clamp(value.height, 24, 120)) }
    if (!same(next, contentSize)) { contentSize = next; if (current) void fit(current) }
  }
  function setInteractive(value) {
    if (current && !current.window.isDestroyed() && current.interactive !== (value === true)) {
      current.interactive = value === true
      current.window.setIgnoreMouseEvents(!current.interactive, { forward: true })
    }
  }
  function isSender(event) {
    return Boolean(!isQuitting() && current && !current.closing && !current.window.isDestroyed() &&
      event.sender === current.window.webContents && event.senderFrame === current.window.webContents.mainFrame)
  }

  function close() {
    const state = current
    if (state) {
      current = null
      state.closing = true
      state.release()
      state.finish(false)
      retiring.add(state)
      publish({ visible: false, embedded: false, status: 'closed', warning: '' })
    }
    if (closingActive || !retiring.size) return closing
    closingActive = true
    closing = Promise.allSettled([...retiring].map(async item => {
      try { await item.bridge?.stop({ ownerDestroyed: item.window.isDestroyed() }); retiring.delete(item) } finally { if (!item.window.isDestroyed()) item.window.destroy() }
    })).then(results => {
      const failures = results.filter(result => result.status === 'rejected').map(result => result.reason)
      if (failures.length) throw new AggregateError(failures, '任务栏歌词清理失败')
    }).finally(() => { closingActive = false })
    return closing
  }

  async function show() {
    if (platform !== 'win32' || isQuitting()) return false
    if (retiring.size) await close(); else await closing
    if (isQuitting()) return false
    if (current && !current.window.isDestroyed()) { const state = current; const result = await state.ready; if (result && current === state) { onReady(); void fit(state) }; return result }
    const initial = taskbarLayout({ display: selectedDisplay(), preferences: { ...preferences, embed: false }, contentSize })
    const win = new BrowserWindow({ ...initial.bounds, frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true,
      resizable: false, movable: false, minimizable: false, maximizable: false, focusable: false, show: false, hasShadow: false,
      webPreferences: { preload, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false } })
    const state = { window: win, loaded: false, closing: false, bars: [], nativeReady: false, nativeFailed: false, nativeDetached: true, interactive: false }
    current = state
    let resolveReady
    state.ready = new Promise(resolve => { resolveReady = resolve })
    state.finish = value => { clearTimeout(state.timeout); resolveReady(value) }
    const displayChanged = () => { if (current === state) { state.lastPlacement = null; void fit(state); if (state.nativeReady) void sample(state) } }
    const displayEvents = ['display-added', 'display-removed', 'display-metrics-changed']
    for (const event of displayEvents) screen.on(event, displayChanged)
    state.release = () => { clearInterval(state.poll); clearTimeout(state.previewTimer); for (const event of displayEvents) screen.removeListener(event, displayChanged) }
    const fail = error => {
      if (current !== state || state.closing) return
      logger?.error?.('taskbar-lyrics', '任务栏歌词窗口加载失败', error)
      void close().catch(cleanupError => logger?.error?.('taskbar-lyrics', '关闭任务栏歌词失败', cleanupError))
      onFailure()
    }
    // The entire fitted rectangle is our lyric UI; controls must receive real clicks.
    state.interactive = true
    win.setIgnoreMouseEvents(false, { forward: true })
    win.on('close', event => { if (!state.closing && !isQuitting()) { event.preventDefault(); onCloseRequest() } })
    win.on('closed', () => {
      state.release(); state.finish(false)
      if (current === state) {
        current = null
        state.closing = true
        retiring.add(state)
        publish({ visible: false, embedded: false, status: 'closed' })
        void close().catch(error => logger?.error?.('taskbar-lyrics', '任务栏窗口关闭后清理失败', error))
      }
    })
    win.on('ready-to-show', () => {
      if (current !== state || state.closing || isQuitting()) return
      state.loaded = true
      onReady()
      void fit(state)
      state.finish(true)
      state.bridge = createBridge({ scriptPath, handle: win.getNativeWindowHandle(), onError: error => { void nativeFailure(state, error) } })
      void state.bridge.start().then(() => {
        if (current !== state || state.closing) return
        state.nativeReady = true
        polling(state)
        void sample(state)
      }).catch(error => nativeFailure(state, error))
    })
    win.webContents.on('render-process-gone', (_event, details) => fail(new Error(`渲染进程退出: ${details?.reason || 'unknown'}`)))
    win.webContents.on('did-fail-load', (_event, code, description, _url, mainFrame) => { if (mainFrame !== false && code !== -3) fail(new Error(`加载失败 (${code}): ${description}`)) })
    state.timeout = setTimeout(() => fail(new Error('任务栏歌词加载超时')), 10000)
    state.timeout.unref?.()
    try { void win.loadFile(page).catch(fail) } catch (error) { fail(error) }
    return state.ready
  }
  function resetPosition() { if (current) { current.lastPlacement = null; void fit(current); preview() }; return { success: true } }
  return { show, close, send, isSender, configure, preview, setContentSize, setInteractive, resetPosition,
    getState: () => ({ ...snapshot }), getDisplays, getCapabilities: () => ({ supported: platform === 'win32', embedding: platform === 'win32' }) }
}

module.exports = { createTaskbarLyricService, taskbarLayout }
