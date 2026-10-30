/** 独立灵动岛窗口；播放器快照与持久化仍由主入口管理，不创建第二个播放时钟。 */
function createIslandLyricService({ BrowserWindow, screen, preload, page, logger, platform, isQuitting, onReady, onFailure, onCloseRequest, onPosition }) {
  let current = null
  let preferences = {}
  let hasTrack = false
  let playing = false
  let externalFullscreen = null
  let lyricViewDisplay = null

  function selectedDisplay() {
    return screen.getAllDisplays?.().find(display => String(display.id) === preferences.displayId) || screen.getPrimaryDisplay()
  }

  function bounds() {
    // 贴住显示器上沿；工作区可能被顶部任务栏下移，不能用它定位凹口。
    const display = selectedDisplay()
    const floating = preferences.mode === 'floating'
    const area = floating ? display.workArea : display.bounds || display.workArea
    const scale = preferences.scale || 1
    const width = Math.min(Math.round(560 * scale), area.width)
    const height = Math.min(Math.round(160 * scale), area.height)
    const position = floating ? preferences.position : null
    return { x: Math.round(position ? Math.max(area.x, Math.min(area.x + area.width - width, position.x)) : area.x + (area.width - width) / 2),
      y: Math.round(floating ? Math.max(area.y, Math.min(area.y + area.height - height, position?.y ?? area.y + 80)) : area.y),
      width: Math.round(width), height: Math.round(height) }
  }

  function overlaps(first, second) {
    return first && second && first.x < second.x + second.width && first.x + first.width > second.x &&
      first.y < second.y + second.height && first.y + first.height > second.y
  }

  /** 原生隐藏不保证派发 mouseleave；显隐后同步真实光标并重置渲染端交互缓存。 */
  function syncPointer(state) {
    if (state !== current || !state.loaded || state.window.isDestroyed()) return
    let clientX = -1
    let clientY = -1
    if (state.visible && screen.getCursorScreenPoint) {
      const point = screen.getCursorScreenPoint()
      const rect = state.window.getBounds()
      clientX = point.x - rect.x
      clientY = point.y - rect.y
    }
    state.window.webContents.send('island-lyric:pointer-update', { clientX, clientY, resetInteractive: true })
  }

  /** 隐藏策略只改变辅助窗口可见性，暂停、全屏避让均不改播放或启用偏好。 */
  function updateVisibility() {
    const state = current
    if (!state?.loaded || state.initializing || state.window.isDestroyed()) return
    const display = screen.getDisplayMatching?.(state.window.getBounds()) || selectedDisplay()
    const displayBounds = display.bounds || display.workArea
    const hiddenByFullscreen = preferences.hideOnFullscreen && overlaps(displayBounds, externalFullscreen)
    const hiddenByLyrics = preferences.hideOnLyricView && overlaps(displayBounds, lyricViewDisplay)
    const visible = !hiddenByFullscreen && !hiddenByLyrics &&
      (state.previewing || !preferences.autoHide || (hasTrack && playing))
    if (state.visible === visible) return
    state.visible = visible
    if (visible) state.window.showInactive()
    else { state.window.hide(); state.dragging = null; setInteractive(false) }
    syncPointer(state)
  }

  function configure(value = {}) {
    const geometryChanged = ['mode', 'displayId', 'position', 'scale'].some(key => JSON.stringify(preferences[key]) !== JSON.stringify(value[key]))
    const leavingFloating = preferences.mode === 'floating' && value.mode !== 'floating'
    preferences = { ...value }
    if (current && !current.window.isDestroyed()) {
      if (geometryChanged) { current.dragging = null; current.window.setBounds(bounds()) }
      if (platform !== 'linux') current.window.setOpacity?.(preferences.opacity ?? 1)
      if (leavingFloating) current.window.blur?.()
      if (platform !== 'linux') current.window.setFocusable?.(preferences.mode === 'floating')
    }
    updateVisibility()
  }

  function preview() {
    if (!current || current.window.isDestroyed()) return
    const state = current
    clearTimeout(state.previewTimer)
    state.previewing = true
    updateVisibility()
    state.previewTimer = setTimeout(() => {
      state.previewing = false
      if (state === current) updateVisibility()
    }, 3000)
    state.previewTimer.unref?.()
  }

  function setExternalFullscreen(value) { externalFullscreen = value?.fullscreen ? value.bounds : null; updateVisibility() }
  function setLyricView(visible, displayBounds) { lyricViewDisplay = visible ? displayBounds : null; updateVisibility() }

  function send(channel, ...payload) {
    if (current?.loaded && !current.window.isDestroyed()) current.window.webContents.send(channel, ...payload)
    if (channel === 'island-lyric:song-update') hasTrack = Boolean(payload[0])
    if (channel === 'island-lyric:playback-update') playing = payload[0]?.playing === true && payload[0]?.available !== false
    if (channel === 'island-lyric:song-update' || channel === 'island-lyric:playback-update') updateVisibility()
    if (channel === 'island-lyric:settings-update' && current?.visible) syncPointer(current)
  }

  function isSender(event) {
    const win = current?.window
    return Boolean(!isQuitting() && win && !current.closing && !win.isDestroyed() &&
      event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame)
  }

  /** 固定窗口内的透明区域穿透鼠标，胶囊内部恢复交互；重复位置不触发原生调用。 */
  function setInteractive(value) {
    if (!current || current.closing || current.interactive === value || current.window.isDestroyed()) return
    current.interactive = value
    current.window.setIgnoreMouseEvents(!value, { forward: true })
  }

  function beginDrag() {
    if (!current?.loaded || current.savingPosition || preferences.mode !== 'floating' || !screen.getCursorScreenPoint || current.window.isDestroyed()) return { success: false }
    current.dragging = { point: screen.getCursorScreenPoint(), bounds: current.window.getBounds() }
    return { success: true }
  }

  function drag() {
    const state = current
    if (!state?.dragging || state.window.isDestroyed()) return
    const point = screen.getCursorScreenPoint()
    const start = state.dragging
    state.window.setPosition(Math.round(start.bounds.x + point.x - start.point.x), Math.round(start.bounds.y + point.y - start.point.y))
  }

  /** 拖动只信任主进程鼠标坐标；落点在屏幕顶部时切换贴顶模式，保存失败恢复原位置。 */
  async function endDrag() {
    const state = current
    if (!state?.dragging || state.window.isDestroyed()) return { success: false }
    drag()
    state.dragging = null
    const rect = state.window.getBounds()
    const display = screen.getDisplayMatching?.(rect) || selectedDisplay()
    const area = display.bounds || display.workArea
    const snapped = rect.y <= area.y + 20
    const workArea = display.workArea || area
    const position = { x: Math.round(Math.max(workArea.x, Math.min(workArea.x + workArea.width - rect.width, rect.x))),
      y: Math.round(Math.max(workArea.y, Math.min(workArea.y + workArea.height - rect.height, rect.y))) }
    state.savingPosition = true
    try {
      const result = await onPosition({ displayId: String(display.id), mode: snapped ? 'mainland' : 'floating', position })
      if (!result?.success && current === state && !state.window.isDestroyed()) { state.window.setBounds(bounds()); syncPointer(state) }
      return result
    } catch (error) {
      logger.error('island-lyrics', '保存灵动岛位置失败', error)
      if (current === state && !state.window.isDestroyed()) { state.window.setBounds(bounds()); syncPointer(state) }
      return { success: false, error: '位置保存失败，请重试。' }
    } finally { state.savingPosition = false }
  }

  function close() {
    const state = current
    if (!state) return
    current = null
    state.closing = true
    state.release()
    state.finish(false)
    if (!state.window.isDestroyed()) state.window.destroy()
  }

  /** 并发打开共用 ready；失败/关闭/超时都解除等待，迟到回调不能复活旧窗口。 */
  async function show() {
    if (isQuitting()) return false
    if (current && !current.window.isDestroyed()) {
      const state = current
      const alreadyLoaded = state.loaded
      if (!await state.ready || current !== state || isQuitting()) return false
      if (alreadyLoaded) {
        state.window.setBounds(bounds())
        onReady()
        updateVisibility()
      }
      return true
    }
    const win = new BrowserWindow({
      ...bounds(), frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true,
      resizable: false, movable: false, minimizable: false, maximizable: false,
      focusable: platform === 'linux' || preferences.mode === 'floating', show: false, hasShadow: false,
      webPreferences: { preload, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false }
    })
    const state = { window: win, loaded: false, closing: false, interactive: false, visible: false }
    current = state
    let resolveReady
    state.ready = new Promise(resolve => { resolveReady = resolve })
    state.finish = result => { clearTimeout(state.timeout); resolveReady(result) }
    const fit = () => {
      if (current === state && !state.closing && !win.isDestroyed()) { win.setBounds(bounds()); updateVisibility(); syncPointer(state) }
    }
    const displayEvents = ['display-added', 'display-removed', 'display-metrics-changed']
    state.release = () => {
      clearInterval(state.pointerTimer)
      clearTimeout(state.previewTimer)
      for (const event of displayEvents) screen.removeListener(event, fit)
    }
    for (const event of displayEvents) screen.on(event, fit)
    const fail = error => {
      if (state.closing || current !== state) return
      logger.error('island-lyrics', '灵动岛窗口加载失败', error)
      close()
      onFailure()
    }
    win.setIgnoreMouseEvents(true, { forward: true })
    if (platform !== 'linux') win.setOpacity?.(preferences.opacity ?? 1)
    win.on('close', event => {
      if (state.closing || isQuitting()) return
      event.preventDefault()
      onCloseRequest()
    })
    win.on('closed', () => {
      state.closing = true
      state.release()
      state.finish(false)
      if (current === state) current = null
    })
    win.on('ready-to-show', () => {
      if (current !== state || state.closing || isQuitting() || win.isDestroyed()) return
      state.loaded = true
      state.initializing = true
      onReady()
      state.initializing = false
      updateVisibility()
      // Linux 不支持穿透时转发鼠标移动；由主进程只提供坐标，圆角命中仍使用实时 DOM。
      if (platform === 'linux' && !state.pointerTimer) {
        state.pointerTimer = setInterval(() => {
          if (current !== state || state.closing || !state.visible || win.isDestroyed()) return
          const cursor = screen.getCursorScreenPoint()
          const rect = win.getBounds()
          send('island-lyric:pointer-update', { clientX: cursor.x - rect.x, clientY: cursor.y - rect.y })
        }, 80)
        state.pointerTimer.unref?.()
      }
      state.finish(true)
    })
    win.webContents.on('render-process-gone', (_event, details) => fail(new Error(`渲染进程退出: ${details?.reason || 'unknown'}`)))
    win.webContents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      if (isMainFrame !== false && code !== -3) fail(new Error(`页面加载失败 (${code}): ${description}`))
    })
    state.timeout = setTimeout(() => fail(new Error('灵动岛加载超时')), 10000)
    state.timeout.unref?.()
    try { void win.loadFile(page).catch(fail) } catch (error) { fail(error) }
    return state.ready
  }

  return { show, close, send, isSender, setInteractive, configure, preview, beginDrag, drag, endDrag, setExternalFullscreen, setLyricView }
}

module.exports = { createIslandLyricService }
