// 引入 Electron 模块
const { app, BrowserWindow, ipcMain, dialog, globalShortcut, shell, Tray, Menu, nativeImage, clipboard, protocol, screen } = require('electron')
const logger = require('./logger')
// 解决 Windows 控制台中文/emoji 乱码: 尝试切换到 UTF-8 代码页 (仅开发态且是 win32)
if (process.platform === 'win32' && !process.env.BK_SKIP_CHCP && !app.isPackaged) {
  try {
    const { execSync } = require('child_process')
    execSync('chcp 65001 >NUL')
    process.env.BK_CONSOLE_UTF8 = '1'
  } catch (error) {
    // 控制台编码失败不影响客户端启动，诊断只在 Trace 模式输出。
    logger.trace('main', '切换控制台编码失败', { code: error.code })
  }
}
const path = require('path')
const { pathToFileURL } = require('url')
const { createBackendService } = require('./services/backendService')
const { createUpdateService } = require('./services/updateService')
const { createPlaylistCacheService } = require('./services/playlistCacheService')
const {
  initSettingsStore,
  getSettings,
  setSettings,
  getDefaultSettings,
  getDefaultPaths,
  onSettingsChange,
  exportSettings,
  importSettings,
  ensureCacheDirectory
} = require('./settingsStore')

// 检查是否在开发环境中（手动检测，避免 ESM 依赖问题）
const isDev = !app.isPackaged

// 音频协议在 ready 前注册，开发页面和打包页面共用受限的流式资源入口。
protocol?.registerSchemesAsPrivileged([{
  scheme: 'bk-cache', privileges: { standard: true, secure: true, stream: true, corsEnabled: true }
}])

// 禁用 GPU 缓存以避免权限错误
app.commandLine.appendSwitch('disable-http-cache')
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache')

// 禁用硬件加速（可选，如果仍有 GPU 相关错误）
// app.disableHardwareAcceleration()

let mainWindow
let loadingWindow = null
let desktopLyricWindow = null
let tray = null
// 应用退出状态标志，防止重复清理
let isQuitting = false
let cleanupPromise = null
let cleanupComplete = false
let mainWindowReady = false
let unsubscribeSettings = null
let updateService = null
let playlistCacheService = null
let installRequest = null
let installQuitService = null
let installPreparation = null
// 用户主动退出标志，用于区分托盘驻留和真正退出
let userRequestedQuit = false
// 当前播放信息(由渲染进程通过 IPC 推送)
let currentTrack = {
  title: '暂无播放',
  cover: null // 可以是文件路径或 dataURL/base64
}
let isPlaying = false
let taskbarIcons = null
let currentDesktopLyrics = []
let currentDesktopTime = 0
let currentDesktopDuration = 0
let currentDesktopPlaybackRate = 1
let desktopAppearanceGeneration = 0
const desktopWindowStates = new WeakMap()
let desktopBoundsTimer = null
let pendingDesktopBounds = null
let lastDesktopBounds = null
let desktopBoundsSave = Promise.resolve(true)
let desktopCommittedBoundsKey
let desktopCommittedBounds = null
let activeDesktopBoundsWrite = null
let desktopBoundsRevision = 0
// 桌面歌词与灵动岛歌词
let desktopLyricEnabled = false
let islandLyricEnabled = false
// 若窗口尚未准备好, 暂存需要发送的播放器控制指令
const pendingPlayerControls = []

const backendService = createBackendService({
  isDev,
  developmentRoot: path.join(__dirname, '..'),
  resourcesPath: process.resourcesPath,
  onProgress: (progress, message, type) => updateLoadingProgress(progress, message, type),
  onStatus: (payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('backend-status', payload)
    }
  },
  isQuitting: () => isQuitting
})

function broadcastPlayerControl(action) {
  if (installPreparation) return
  const wins = BrowserWindow.getAllWindows().filter(w => !w.isDestroyed())
  if (!mainWindowReady || wins.length === 0) {
    pendingPlayerControls.push(action)
    logger.trace('main', '🕒 窗口未就绪, 已缓存控制指令:', action)
    return
  }
  logger.trace('main', '📤 广播播放器控制指令:', action)
  wins.forEach(w => w.webContents.send('player:control', action))
}

/** 将任务栏预览按钮接入现有播放器；回调读取实时状态，不激活或还原主窗口。 */
function updateTaskbarButtons() {
  if (process.platform !== 'win32' || !mainWindow || mainWindow.isDestroyed()) return
  const window = mainWindow
  try {
    if (!taskbarIcons) {
      const directory = path.join(__dirname, isDev ? '../public/taskbar' : '../dist/taskbar')
      const icons = Object.fromEntries(['previous', 'play', 'pause', 'next'].map(name => {
        const icon = nativeImage.createFromPath(path.join(directory, `${name}.png`))
        if (icon.isEmpty()) throw new Error(`任务栏图标加载失败: ${name}`)
        return [name, icon]
      }))
      taskbarIcons = icons
    }
    const canControl = () => mainWindow === window && !window.isDestroyed() &&
      mainWindowReady && !isQuitting && !installPreparation
    // Electron 32 的原生实现以空 flags 表示启用，不接受文档中的 'enabled'。
    const flags = canControl() ? [] : ['disabled']
    const send = action => {
      if (canControl()) broadcastPlayerControl(action)
    }
    const added = window.setThumbarButtons([
      { tooltip: '上一首', icon: taskbarIcons.previous, flags, click: () => send('prev') },
      { tooltip: isPlaying ? '暂停' : '播放', icon: isPlaying ? taskbarIcons.pause : taskbarIcons.play,
        flags, click: () => send(isPlaying ? 'pause' : 'play') },
      { tooltip: '下一首', icon: taskbarIcons.next, flags, click: () => send('next') }
    ])
    if (!added) logger.warn('main', 'Windows 未能更新任务栏播放按钮')
  } catch (error) {
    // 任务栏暂不可用时保留播放器运行，后续显示窗口或播放状态变化时再尝试。
    logger.warn('main', '更新任务栏播放按钮失败', error)
  }
}

function resolveIcon(p) {
  if (!p) return null
  try {
    if (p.startsWith('data:')) {
      return nativeImage.createFromDataURL(p)
    }
    return nativeImage.createFromPath(p)
  } catch (error) {
    logger.trace('main', '解析托盘封面失败，使用默认图标', { name: error.name })
    return null
  }
}

function getAppTrayIcon() {
  const bundledIcon = isDev
    ? path.join(__dirname, '../public/logo.png')
    : path.join(__dirname, '../dist/logo.png')
  const candidates = [
    bundledIcon,
    path.join(process.resourcesPath, 'logo.png'),
    path.join(process.resourcesPath, 'assets/logo.png')
  ]
  for (const c of candidates) {
    if (require('fs').existsSync(c)) return c
  }
  return bundledIcon
}

function updateTrayMenu() {
  if (!tray) return
  const coverImg = resolveIcon(currentTrack.cover) || nativeImage.createFromPath(getAppTrayIcon())
  // 缩小封面
  const albumImg = coverImg.isEmpty() ? null : coverImg.resize({ width: 16, height: 16 })
  const playPauseLabel = isPlaying ? '暂停' : '播放'
  const desktopLyricLabel = `${desktopLyricEnabled ? '禁用' : '启用'}桌面歌词`
  const islandLyricLabel = `${islandLyricEnabled ? '禁用' : '启用'}灵动岛歌词`

  const contextMenu = Menu.buildFromTemplate([
    { label: currentTrack.title, icon: albumImg, enabled: false, tooltip: currentTrack.title },
    { type: 'separator' },
    { label: playPauseLabel, click: () => {
        broadcastPlayerControl(isPlaying ? 'pause' : 'play')
      }
    },
    { label: '上一首', click: () => { broadcastPlayerControl('prev') } },
    { label: '下一首', click: () => { broadcastPlayerControl('next') } },
    { type: 'separator' },
    { label: desktopLyricLabel, click: () => { void toggleDesktopLyricWindow() } },
    { label: '解锁桌面歌词', enabled: desktopLyricEnabled, click: () => { void runDesktopTrayAction(() => saveDesktopPreference({ desktopLyrics: { locked: false } }), '解锁桌面歌词失败，请重试。') } },
    { label: '找回桌面歌词', click: () => { void runDesktopTrayAction(resetDesktopLyricPosition, '找回桌面歌词失败，请重试。') } },
    { label: islandLyricLabel, click: () => {
        islandLyricEnabled = !islandLyricEnabled
        updateTrayMenu()
      }
    },
    { type: 'separator' },
    { label: '显示主界面', click: () => {
        if (!mainWindow) {
          createWindow()
        } else {
          if (mainWindow.isMinimized()) mainWindow.restore()
          mainWindow.show(); mainWindow.focus()
        }
      }
    },
    { label: '退出应用', click: async () => {
        logger.trace('main', '👆 用户点击托盘退出应用')
        // 设置用户主动退出标志
        userRequestedQuit = true
        // 执行完整的清理流程，然后退出应用
        await performApplicationCleanup()
        app.quit()
      }
    }
  ])
  tray.setContextMenu(contextMenu)
  tray.setToolTip(`BetterKugou\n${currentTrack.title}${isPlaying ? '' : ' (已暂停)'}`)
}

function createTray() {
  if (tray) return tray
  const iconPath = getAppTrayIcon()
  tray = new Tray(iconPath)
  tray.on('click', () => {
    // 左键单击显示/隐藏窗口
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.hide()
      } else {
        if (mainWindow.isMinimized()) mainWindow.restore()
        mainWindow.show(); mainWindow.focus()
      }
    } else {
      createWindow()
    }
  })
  updateTrayMenu()
  return tray
}

/** 坐标使用 Electron DIP；显示器移除或缩放改变时把整个窗口放回可见工作区。 */
function getDesktopLyricBounds(saved) {
  const valid = saved && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(saved[key]))
  const fallback = { x: 0, y: 0, width: 1920, height: 1080 }
  const area = (valid ? screen?.getDisplayMatching?.(saved) : screen?.getPrimaryDisplay?.())?.workArea || fallback
  const width = Math.min(area.width, Math.max(420, Math.round(valid ? saved.width : 800)))
  const height = Math.min(area.height, Math.max(180, Math.round(valid ? saved.height : 200)))
  const x = valid ? saved.x : area.x + (area.width - width) / 2
  const y = valid ? saved.y : area.y + area.height - height - 48
  return { x: Math.round(Math.max(area.x, Math.min(area.x + area.width - width, x))),
    y: Math.round(Math.max(area.y, Math.min(area.y + area.height - height, y))), width, height }
}

/** 仅最后移动结果落盘；关闭与退出等待同一队列，失败保留本次位置供重试。 */
function flushDesktopLyricBounds() {
  clearTimeout(desktopBoundsTimer)
  desktopBoundsTimer = null
  if (!pendingDesktopBounds) return desktopBoundsSave
  const bounds = pendingDesktopBounds
  const revision = desktopBoundsRevision
  pendingDesktopBounds = null
  desktopBoundsSave = desktopBoundsSave.then(async () => {
    // 导入/恢复设置优先于尚未开始写入的旧移动结果。
    if (revision !== desktopBoundsRevision) return true
    let writeBounds = bounds
    let writeRevision = revision
    try {
      while (true) {
        activeDesktopBoundsWrite = { bounds: writeBounds, revision: writeRevision }
        await setSettings({ desktopLyrics: { bounds: writeBounds } })
        if (writeRevision === desktopBoundsRevision) return true
        // 事务可能已排在导入后面；落盘后补回最新已接受的位置，窗口关闭时同样有效。
        writeBounds = desktopCommittedBounds
        writeRevision = desktopBoundsRevision
      }
    }
    finally { activeDesktopBoundsWrite = null }
  }).catch(error => {
    if (!pendingDesktopBounds) pendingDesktopBounds = lastDesktopBounds || getDesktopLyricBounds(desktopCommittedBounds)
    logger.error('main', '保存桌面歌词窗口位置失败', error)
    sendDesktopLyric('desktop-lyric:error', '窗口位置保存失败，移动或关闭窗口时将重试。')
    return false
  })
  return desktopBoundsSave
}

function rememberDesktopLyricBounds(win) {
  if (!win || win.isDestroyed() || !win.getBounds) return
  lastDesktopBounds = win.getBounds()
  pendingDesktopBounds = lastDesktopBounds
  clearTimeout(desktopBoundsTimer)
  desktopBoundsTimer = setTimeout(() => { void flushDesktopLyricBounds() }, 300)
  desktopBoundsTimer.unref?.()
}

function sendDesktopLyric(channel, ...payload) {
  const win = desktopLyricWindow
  if (win && !win.isDestroyed() && desktopWindowStates.get(win)?.loaded) win.webContents.send(channel, ...payload)
}

function desktopPlaybackSnapshot() {
  return { playing: isPlaying, time: currentDesktopTime, duration: currentDesktopDuration,
    available: mainWindowReady && currentTrack.title !== '暂无播放' && !isQuitting && !installPreparation }
}

/** 每次就绪或重开均重放完整状态，暂停状态同样立即定位。 */
function replayDesktopLyrics() {
  syncDesktopLyricSettings()
  sendDesktopLyric('desktop-lyric:song-update', currentTrack.title === '暂无播放' ? null : currentTrack)
  sendDesktopLyric('desktop-lyric:lyric-update', currentDesktopLyrics)
  // 缓存只用于首帧定位；新的真实音频采样到达前，旧时间不得授权继续插值。
  const timing = { duration: currentDesktopDuration, playbackRate: currentDesktopPlaybackRate,
    advancing: false, discontinuity: true }
  sendDesktopLyric('desktop-lyric:time-update', currentDesktopTime, timing)
  sendDesktopLyric('desktop-lyric:playback-update', { ...desktopPlaybackSnapshot(), ...timing })
}

/** 就绪与关闭回调绑定创建时窗口；旧窗口不能清除或重新显示新窗口。 */
function createDesktopLyricWindow() {
  if (isQuitting) return null
  if (desktopLyricWindow && !desktopLyricWindow.isDestroyed()) return desktopLyricWindow
  let saved = lastDesktopBounds
  if (!saved) {
    try { saved = getSettings().desktopLyrics?.bounds } catch (error) {
      logger.trace('main', '桌面歌词使用初始位置，等待设置就绪', error)
    }
  }
  const win = new BrowserWindow({
    ...getDesktopLyricBounds(saved), minWidth: 420, minHeight: 180,
    frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true,
    // 透明窗口使用界面缩放手柄，避免平台原生 resize 破坏透明背景。
    resizable: false, movable: true, minimizable: false, maximizable: false,
    closable: true, focusable: true, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), nodeIntegration: false,
      contextIsolation: true, backgroundThrottling: false }
  })
  desktopLyricWindow = win
  const state = { loaded: false, closing: false, resize: null, resolve: null, timeout: null }
  state.ready = new Promise(resolve => { state.resolve = resolve })
  desktopWindowStates.set(win, state)
  const finish = (success) => { clearTimeout(state.timeout); state.resolve(success) }
  const fail = (error) => {
    if (state.closing) return
    logger.error('main', '桌面歌词窗口加载失败', error)
    finish(false)
    state.closing = true
    if (desktopLyricWindow === win) { desktopLyricWindow = null; desktopLyricEnabled = false; updateTrayMenu() }
    if (!win.isDestroyed()) win.destroy()
  }
  const fitDisplay = () => {
    if (win !== desktopLyricWindow || win.isDestroyed() || state.closing) return
    win.setBounds(getDesktopLyricBounds(win.getBounds()))
    rememberDesktopLyricBounds(win)
  }
  for (const event of ['display-removed', 'display-metrics-changed']) screen?.on?.(event, fitDisplay)
  win.on('move', () => { if (state.loaded && !state.closing) rememberDesktopLyricBounds(win) })
  win.on('resize', () => { if (state.loaded && !state.closing) rememberDesktopLyricBounds(win) })
  win.on('close', () => {
    if (state.loaded) rememberDesktopLyricBounds(win)
    state.closing = true
    finish(false)
    void flushDesktopLyricBounds()
  })
  win.on('closed', () => {
    state.closing = true
    finish(false)
    for (const event of ['display-removed', 'display-metrics-changed']) screen?.removeListener?.(event, fitDisplay)
    if (desktopLyricWindow === win) { desktopLyricWindow = null; desktopLyricEnabled = false; updateTrayMenu() }
  })
  win.on('ready-to-show', () => {
    if (isQuitting || state.closing || win !== desktopLyricWindow || win.isDestroyed()) { finish(false); return }
    state.loaded = true
    replayDesktopLyrics()
    if (win.showInactive) win.showInactive()
    else win.show()
    finish(true)
  })
  win.webContents.on?.('render-process-gone', (_event, details) => fail(new Error(`桌面歌词渲染退出: ${details?.reason || 'unknown'}`)))
  state.timeout = setTimeout(() => fail(new Error('桌面歌词加载超时')), 10000)
  state.timeout.unref?.()
  win.loadFile(path.join(__dirname, 'desktopLyric.html')).catch(fail)
  desktopLyricEnabled = true
  updateTrayMenu()
  return win
}

function closeDesktopLyricWindow() {
  const win = desktopLyricWindow
  desktopLyricWindow = null
  desktopLyricEnabled = false
  if (win && !win.isDestroyed()) {
    const state = desktopWindowStates.get(win)
    if (state) state.closing = true
    win.close()
  }
  updateTrayMenu()
}

async function showDesktopLyricWindow() {
  try {
    const win = createDesktopLyricWindow()
    if (!win || !await desktopWindowStates.get(win).ready || isQuitting || win !== desktopLyricWindow || win.isDestroyed()) return false
    replayDesktopLyrics()
    if (win.showInactive) win.showInactive()
    else win.show()
    return true
  } catch (error) {
    logger.error('main', '打开桌面歌词失败', error)
    return false
  }
}

async function toggleDesktopLyricWindow() {
  if (isQuitting) return false
  if (desktopLyricEnabled) { closeDesktopLyricWindow(); return false }
  return showDesktopLyricWindow()
}

async function resetDesktopLyricPosition() {
  if (isQuitting) return false
  const result = await saveDesktopPreference({ desktopLyrics: { locked: false } })
  if (!result.success) return false
  lastDesktopBounds = getDesktopLyricBounds(null)
  if (!await showDesktopLyricWindow()) return false
  desktopLyricWindow.setBounds(lastDesktopBounds)
  rememberDesktopLyricBounds(desktopLyricWindow)
  return flushDesktopLyricBounds()
}

/** 锁定时歌词窗口不能接收点击，托盘操作失败通过原生对话框提供反馈。 */
async function runDesktopTrayAction(action, message) {
  try {
    const result = await action()
    if (result === true || result?.success === true) return
    await dialog.showMessageBox({ type: 'error', title: '桌面歌词', message: result?.error || message, buttons: ['知道了'] })
  } catch (error) {
    logger.error('main', message, error)
  }
}

/** 窗口按钮只确认已经落盘的偏好，写入失败时重新同步原值并返回可见错误。 */
async function saveDesktopPreference(patch) {
  try {
    const settings = await setSettings(patch)
    syncDesktopLyricSettings(settings)
    return { success: true }
  } catch (error) {
    logger.error('main', '保存桌面歌词偏好失败', error)
    syncDesktopLyricSettings()
    return { success: false, error: '设置保存失败，请重试。' }
  }
}

/** 桌面歌词只接收已提交的白名单显示偏好，创建和重新打开时应用同一快照。 */
function syncDesktopLyricSettings(settings) {
  const generation = ++desktopAppearanceGeneration
  if (!settings) {
    try { settings = getSettings() } catch (error) {
      // 托盘可能在初始化完成前打开歌词，先显示默认值，初始化后再由订阅同步。
      logger.trace('main', '桌面歌词等待设置初始化', error)
    }
  }
  const value = settings?.desktopLyrics || {}
  if (settings) {
    const boundsKey = JSON.stringify(value.bounds || null)
    const ownWrite = activeDesktopBoundsWrite && boundsKey === JSON.stringify(activeDesktopBoundsWrite.bounds)
    const obsoleteWrite = ownWrite && activeDesktopBoundsWrite.revision !== desktopBoundsRevision
    if (!obsoleteWrite && boundsKey !== desktopCommittedBoundsKey) {
      desktopCommittedBoundsKey = boundsKey
      desktopCommittedBounds = value.bounds || null
      // 本地落盘广播只确认写入，不能把正在拖动的窗口拉回旧位置。
      if (!ownWrite) {
        desktopBoundsRevision++
        lastDesktopBounds = value.bounds ? getDesktopLyricBounds(value.bounds) : null
        pendingDesktopBounds = null
        clearTimeout(desktopBoundsTimer)
        desktopBoundsTimer = null
        if (desktopLyricWindow && !desktopLyricWindow.isDestroyed()) {
          const bounds = getDesktopLyricBounds(lastDesktopBounds)
          if (JSON.stringify(desktopLyricWindow.getBounds?.()) !== JSON.stringify(bounds)) desktopLyricWindow.setBounds(bounds)
        }
      }
    }
  }
  if (!desktopLyricWindow || desktopLyricWindow.isDestroyed()) return
  const preferences = {
    fontSize: ['small', 'medium', 'large'].includes(value.fontSize) ? value.fontSize : 'medium',
    theme: ['classic', 'gradient', 'minimal'].includes(value.theme) ? value.theme : 'classic',
    locked: typeof value.locked === 'boolean' ? value.locked : false,
    showTranslation: settings?.playback?.showTranslation !== false
  }
  const windowState = desktopWindowStates.get(desktopLyricWindow)
  if (windowState) { windowState.locked = preferences.locked; if (preferences.locked) windowState.resize = null }
  desktopLyricWindow.setIgnoreMouseEvents?.(preferences.locked, { forward: true })
  desktopLyricWindow.setMovable?.(!preferences.locked)
  desktopLyricWindow.setFocusable?.(!preferences.locked)
  const custom = settings?.custom
  const hasDesktopStyles = Array.isArray(custom?.themePackages) && custom.themePackages.some(theme => theme?.id === custom.theme && theme.desktopCss)
  // Ordinary preference/session broadcasts must not briefly remove an active appearance sheet.
  if (custom && !hasDesktopStyles) preferences.appearance = null
  desktopLyricWindow.webContents.send('desktop-lyric:settings-update', preferences)
  // Builtins retain the independent classic/gradient/minimal appearance. A selected package may add desktop rules.
  if (!hasDesktopStyles) return
  const win = desktopLyricWindow
  loadThemeCatalog().then(catalog => {
    if (generation !== desktopAppearanceGeneration || win !== desktopLyricWindow || win.isDestroyed()) return
    const theme = catalog.getThemePackage(custom.theme, custom)
    const appearance = theme?.desktopCss ? { tokens: theme.tokens, css: catalog.compileThemeCss(theme.desktopCss, 'desktop') } : null
    win.webContents.send('desktop-lyric:settings-update', { ...preferences, appearance })
  }).catch(error => {
    logger.warn('main', '桌面歌词主题应用失败，保留默认外观', error)
    if (generation === desktopAppearanceGeneration && win === desktopLyricWindow && !win.isDestroyed()) win.webContents.send('desktop-lyric:settings-update', { ...preferences, appearance: null })
  })
}

/** 广播成功落盘的设置，并同步现有桌面歌词窗口。 */
function subscribeToSettingsUpdates() {
  unsubscribeSettings?.()
  unsubscribeSettings = onSettingsChange((nextSettings) => {
    BrowserWindow.getAllWindows().forEach((win) => {
      if (!win.isDestroyed()) win.webContents.send('settings:updated', nextSettings)
    })
    syncDesktopLyricSettings(nextSettings)
    updateService?.configure(nextSettings.software.updates)
    playlistCacheService?.configure(nextSettings)
  })
}

/** 更新网络、文件和校验在 Worker 中执行，窗口启动无需等待。 */
function initializeUpdateService() {
  updateService = createUpdateService({
    workerPath: app.isPackaged
      ? path.join(process.resourcesPath, 'updater', 'updateWorker.cjs')
      : path.join(app.getAppPath(), 'electron', 'services', 'updateWorker.cjs'),
    downloadRoot: path.join(app.getPath('userData'), 'updates'),
    currentVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    logger,
    onState: (state) => {
      if (!isQuitting && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('updates:state', state)
      }
    }
  })
  updateService.configure(getSettings().software.updates)
}

/** 持久化与缓存下载在独立 Worker 执行，初始化不等待外网。 */
function initializePlaylistCacheService() {
  playlistCacheService = createPlaylistCacheService({
    workerPath: app.isPackaged
      ? path.join(process.resourcesPath, 'playlist-cache', 'playlistCacheWorker.cjs')
      : path.join(app.getAppPath(), 'electron', 'services', 'playlistCacheWorker.cjs'),
    cacheRoot: path.join(app.getPath('userData'), 'offline-playlists'),
    logger,
    onState: (state) => {
      if (!isQuitting && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('playlist-cache:state', state)
    },
    onAuthExpired: (identity) => {
      if (!isQuitting && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('playlist-cache:auth-expired', identity)
    }
  })
  playlistCacheService.configure(getSettings())
  protocol?.handle('bk-cache', request => playlistCacheService.handleRequest(request))
}

/** 离线资源 IPC 只允许主窗口顶层，不接受调用方指定的文件路径。 */
function getPlaylistCacheForSender(event) {
  if (isQuitting || !isMainWindowSender(event)) throw new Error('离线缓存操作只能从应用主窗口发起。')
  if (!playlistCacheService) throw new Error('离线缓存尚未就绪，请稍后重试。')
  return playlistCacheService
}

for (const [channel, method] of Object.entries({
  'set-session': 'setSession', 'get-state': 'getState', 'read-playlist': 'readPlaylist',
  'put-playlist': 'putPlaylist', 'cache-song': 'cacheSong', 'get-source': 'getSource',
  'release-source': 'releaseSource', 'read-lyrics': 'readLyrics', 'put-lyrics': 'putLyrics',
  'get-artwork': 'getArtwork', 'cache-artwork': 'cacheArtwork', pause: 'pause', resume: 'resume',
  retry: 'retry', 'retry-network': 'retryNetwork', clear: 'clear'
})) {
  ipcMain.handle(`playlist-cache:${channel}`, (event, argument) => getPlaylistCacheForSender(event)[method](argument))
}

/** 更新桥接仅允许主窗口的顶层页面，路径与下载地址不接收渲染输入。 */
function getUpdatesForSender(event) {
  if (isQuitting || !mainWindow || mainWindow.isDestroyed() ||
      event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) {
    throw new Error('更新操作只能从应用主窗口发起。')
  }
  if (!updateService) throw new Error('更新服务尚未就绪，请稍后重试。')
  return updateService
}

ipcMain.handle('updates:get-state', (event) => getUpdatesForSender(event).getState())
ipcMain.handle('updates:check', (event) => getUpdatesForSender(event).check())
ipcMain.handle('updates:download', (event, assetId) => getUpdatesForSender(event).download(assetId))
ipcMain.handle('updates:cancel', (event) => getUpdatesForSender(event).cancel())
ipcMain.handle('updates:reveal', async (event) => {
  try {
    const updates = getUpdatesForSender(event)
    const file = await updates.getDownloadedFile()
    getUpdatesForSender(event)
    shell.showItemInFolder(file.path)
    return { success: true }
  } catch (error) {
    logger.error('updates', '定位更新安装包失败', error)
    return { success: false, error: error.message }
  }
})

/** 只有用户主动点击并在原生对话框确认后才打开已校验的包，不退出或安排安装。 */
ipcMain.handle('updates:install', async (event) => {
  let updates
  try {
    updates = getUpdatesForSender(event)
  } catch (error) {
    return { success: false, error: error.message }
  }
  if (installRequest) return { canceled: true }
  installRequest = Promise.resolve().then(async () => {
    const file = await updates.getDownloadedFile()
    if (!['exe', 'dmg', 'deb', 'rpm'].includes(file.format)) {
      throw new Error('请打开所在文件夹，自行处理此更新包。')
    }
    getUpdatesForSender(event)
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      title: '手动安装更新',
      message: `打开 ${file.assetName}？`,
      detail: '将打开已下载的安装包，后续安装由你确认。BetterKuGou 将保持运行。',
      buttons: ['取消', '打开安装包'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    })
    if (response !== 1) return { canceled: true }
    getUpdatesForSender(event)
    const confirmed = await updates.getDownloadedFile()
    if (confirmed.path !== file.path || confirmed.assetId !== file.assetId || confirmed.version !== file.version) {
      throw new Error('更新包已改变，请重新确认安装。')
    }
    getUpdatesForSender(event)
    const errorMessage = await shell.openPath(confirmed.path)
    if (errorMessage) throw new Error(errorMessage)
    return { success: true }
  }).catch(error => {
    logger.error('updates', '用户手动打开更新包失败', error)
    return { success: false, error: error.message }
  }).finally(() => { installRequest = null })
  return installRequest
})
// 存储已注册的全局快捷键映射: accelerator -> action
const registeredShortcuts = new Map()
// 内存清理定时器
let memoryCleanupTimer = null
let memoryReportTimer = null

// 创建加载窗口
function createLoadingWindow() {
  loadingWindow = new BrowserWindow({
    width: 400,
    height: 300,
    frame: false,
    transparent: false,
    resizable: false,
    center: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  })

  loadingWindow.loadFile(path.join(__dirname, 'loading.html'), {
    query: { logo: pathToFileURL(getAppTrayIcon()).href }
  }).catch(error => {
    // 启动中退出会主动中止导航，不将其记为启动失败。
    if (!isQuitting) logger.error('main', '加载启动窗口失败', error)
  })

  loadingWindow.on('closed', () => {
    loadingWindow = null
  })

  return loadingWindow
}

// 更新加载进度
function updateLoadingProgress(progress, status, step) {
  if (loadingWindow && !loadingWindow.isDestroyed()) {
    loadingWindow.webContents.send('loading-progress', {
      progress,
      status,
      step
    })
  }
}

// 关闭加载窗口
function closeLoadingWindow() {
  if (loadingWindow && !loadingWindow.isDestroyed()) {
    loadingWindow.close()
    loadingWindow = null
  }
}

// 内存清理函数
function performMemoryCleanup() {
  logger.trace('main', '🧹 执行内存清理...')

  try {
    // 获取清理前的内存使用情况
    const beforeMemory = process.memoryUsage()
    logger.trace('main', '清理前内存使用:', {
      rss: `${(beforeMemory.rss / 1024 / 1024).toFixed(2)} MB`,
      heapUsed: `${(beforeMemory.heapUsed / 1024 / 1024).toFixed(2)} MB`,
      heapTotal: `${(beforeMemory.heapTotal / 1024 / 1024).toFixed(2)} MB`,
      external: `${(beforeMemory.external / 1024 / 1024).toFixed(2)} MB`
    })

    // 主进程垃圾回收
    if (global.gc) {
      global.gc()
      logger.trace('main', '✅ 主进程 GC 已执行')
    } else {
      logger.trace('main', '⚠️ 主进程 GC 不可用 (需要使用 --expose-gc 标志启动)')
    }

    // 清理所有窗口的渲染进程内存
    const allWindows = BrowserWindow.getAllWindows()
    allWindows.forEach((window, index) => {
      if (!window.isDestroyed()) {
        // 清理磁盘缓存失败不影响其余窗口；它不等同于渲染进程垃圾回收。
        window.webContents.session.clearCache().catch(error => {
          logger.warn('main', '清理窗口缓存失败', error)
        })

        // 通知渲染进程执行内存清理
        window.webContents.send('memory-cleanup')

        logger.trace('main', `✅ 窗口 ${index + 1} 内存清理已触发`)
      }
    })

    // 获取清理后的内存使用情况
    if (memoryReportTimer) clearTimeout(memoryReportTimer)
    memoryReportTimer = setTimeout(() => {
      memoryReportTimer = null
      if (isQuitting) return
      const afterMemory = process.memoryUsage()
      const savedMemory = (beforeMemory.heapUsed - afterMemory.heapUsed) / 1024 / 1024

      logger.trace('main', '清理后内存使用:', {
        rss: `${(afterMemory.rss / 1024 / 1024).toFixed(2)} MB`,
        heapUsed: `${(afterMemory.heapUsed / 1024 / 1024).toFixed(2)} MB`,
        heapTotal: `${(afterMemory.heapTotal / 1024 / 1024).toFixed(2)} MB`,
        external: `${(afterMemory.external / 1024 / 1024).toFixed(2)} MB`
      })

      if (savedMemory > 0) {
        logger.trace('main', `💾 释放了约 ${savedMemory.toFixed(2)} MB 内存`)
      }
    }, 1000)

  } catch (error) {
    logger.error('main', '❌ 内存清理失败:', error)
  }
}

// 启动内存清理定时器
function startMemoryCleanup() {
  // 每30分钟执行一次内存清理
  const CLEANUP_INTERVAL = 30 * 60 * 1000 // 30分钟

  logger.trace('main', '🔧 启动内存自动清理功能 (每30分钟)')

  // 清除已存在的定时器
  if (memoryCleanupTimer) {
    clearInterval(memoryCleanupTimer)
  }

  // 设置新的定时器
  memoryCleanupTimer = setInterval(() => {
    performMemoryCleanup()
  }, CLEANUP_INTERVAL)

}

// 停止内存清理定时器
function stopMemoryCleanup() {
  if (memoryReportTimer) clearTimeout(memoryReportTimer)
  memoryReportTimer = null
  if (memoryCleanupTimer) {
    clearInterval(memoryCleanupTimer)
    memoryCleanupTimer = null
    logger.trace('main', '🛑 内存自动清理已停止')
  }
}

/** 复用同一清理任务；完成后才允许 Electron 退出，防止并发退出提前放行。 */
function performApplicationCleanup() {
  if (cleanupPromise) return cleanupPromise
  isQuitting = true
  updateTaskbarButtons()
  cleanupPromise = Promise.resolve().then(cleanupApplicationResources).finally(() => {
    cleanupComplete = true
  })
  return cleanupPromise
}

async function cleanupApplicationResources() {
  unsubscribeSettings?.()
  unsubscribeSettings = null
  logger.trace('main', '🗑️ 开始应用退出清理流程...')

  try {
    // 1. 停止所有定时器和后台任务
    logger.trace('main', '🛑 停止内存清理定时器...')
    stopMemoryCleanup()

    try {
      if (installQuitService) await installQuitService.stop()
    } catch (error) {
      logger.error('installer', '关闭安装退出协作管道失败', error)
    }
    releaseInstallPreparation()

    try {
      if (playlistCacheService) await playlistCacheService.stop()
    } catch (error) {
      logger.error('playlist-cache', '停止离线缓存任务失败', error)
    }

    try {
      if (updateService) await updateService.stop()
    } catch (error) {
      logger.error('updates', '停止更新任务失败', error)
    }

    // 2. 注销所有全局快捷键
    logger.trace('main', '⌨️ 注销全局快捷键...')
    try {
      globalShortcut.unregisterAll()
      registeredShortcuts.clear()
      logger.trace('main', '✅ 全局快捷键已清理')
    } catch (error) {
      logger.error('main', '❌ 清理全局快捷键失败:', error)
    }

    // 3. 关闭桌面歌词窗口
    logger.trace('main', '🎵 关闭桌面歌词窗口...')
    try {
      closeDesktopLyricWindow()
      await flushDesktopLyricBounds()
      logger.trace('main', '✅ 桌面歌词窗口已关闭')
    } catch (error) {
      logger.error('main', '❌ 关闭桌面歌词窗口失败:', error)
    }

    // 4. 关闭加载窗口
    logger.trace('main', '📱 关闭加载窗口...')
    try {
      if (loadingWindow && !loadingWindow.isDestroyed()) {
        loadingWindow.close()
        loadingWindow = null
      }
      logger.trace('main', '✅ 加载窗口已关闭')
    } catch (error) {
      logger.error('main', '❌ 关闭加载窗口失败:', error)
    }

    // 5. 停止后端服务器 (等待完成)
    logger.trace('main', '🌐 停止后端服务器...')
    try {
      await backendService.stop()
      logger.trace('main', '✅ 后端服务器已停止')
    } catch (error) {
      logger.error('main', '❌ 停止后端服务器失败:', error)
    }

    // 6. 销毁系统托盘
    logger.trace('main', '📍 销毁系统托盘...')
    try {
      if (tray) {
        tray.destroy()
        tray = null
      }
      logger.trace('main', '✅ 系统托盘已销毁')
    } catch (error) {
      logger.error('main', '❌ 销毁系统托盘失败:', error)
    }

    // 7. 执行最后的内存清理
    logger.trace('main', '🧹 执行最后的内存清理...')
    try {
      if (global.gc) {
        global.gc()
      }
      logger.trace('main', '✅ 内存清理完成')
    } catch (error) {
      logger.error('main', '❌ 内存清理失败:', error)
    }

    logger.trace('main', '✅ 应用退出清理流程完成')
  } catch (error) {
    logger.error('main', '❌ 应用清理过程中出现错误:', error)
  }
}

// 创建浏览器窗口
function createWindow() {
  if (isQuitting || (mainWindow && !mainWindow.isDestroyed())) return
  mainWindowReady = false
  updateLoadingProgress(75, '正在加载前端界面...', 'frontend')

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    minWidth: 1024,
    minHeight: 480,
    frame: false,
    show: false, // 先不显示,等加载完成后再显示
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      // 禁用开发者工具中的某些功能以减少警告
      devTools: isDev
    }
  })

  mainWindow.on('ready-to-show', updateTaskbarButtons)
  mainWindow.on('show', updateTaskbarButtons)
  const window = mainWindow
  const resetTaskbarPlayback = () => {
    if (mainWindow !== window) return
    mainWindowReady = false
    isPlaying = false
    updateTaskbarButtons()
    sendDesktopLyric('desktop-lyric:playback-update', desktopPlaybackSnapshot())
  }
  mainWindow.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) resetTaskbarPlayback()
  })
  mainWindow.webContents.on('render-process-gone', resetTaskbarPlayback)

  // 监听窗口最大化/还原事件，通知渲染进程
  mainWindow.on('maximize', () => {
    mainWindow.webContents.send('window-is-maximized')
  })
  mainWindow.on('unmaximize', () => {
    mainWindow.webContents.send('window-is-unmaximized')
  })

  // 加载应用的URL或本地文件
  const urlLocation = isDev
    ? (process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173')
    : pathToFileURL(path.join(__dirname, '../dist/index.html')).href

  mainWindow.loadURL(urlLocation).catch(error => {
    if (!isQuitting) logger.error('main', '加载主窗口失败', error)
  })

  // 页面加载完成后的处理
  mainWindow.webContents.on('did-finish-load', () => {
    if (isQuitting) return
    updateLoadingProgress(90, '准备就绪', 'login')
  })

  // 在开发环境中打开开发者工具
  if (isDev) {
    mainWindow.webContents.openDevTools()
  }

  // 窗口关闭时的处理
  mainWindow.on('close', (event) => {
    if (isQuitting || userRequestedQuit) return
    // 检查设置，决定是隐藏到托盘还是真正关闭
    const settings = getSettings()
    if (settings.software?.minimizeToTray) {
      // 阻止默认关闭行为
      event.preventDefault()
      // 隐藏窗口到托盘
      mainWindow.hide()
      logger.trace('main', '🔽 应用已最小化到系统托盘')
    }
    // 如果设置为false，则允许正常关闭
  })

  mainWindow.on('closed', () => {
    mainWindow = null
    mainWindowReady = false
    isPlaying = false
    sendDesktopLyric('desktop-lyric:playback-update', desktopPlaybackSnapshot())
  })
}

// 应用准备就绪时创建窗口
app.whenReady().then(async () => {
  // 首先创建加载窗口
  createLoadingWindow()
  updateLoadingProgress(5, '正在初始化...', 'backend')
  // 创建系统托盘
  createTray()

  try {
    await initSettingsStore(app)
    await ensureCacheDirectory()
    updateLoadingProgress(15, '配置加载完成', 'backend')
  } catch (err) {
    logger.error('main', '❌ 初始化设置存储失败:', err)
    dialog.showErrorBox('启动失败', '无法读取或保存设置，请检查目录权限后重新启动。')
    userRequestedQuit = true
    app.quit()
    return
  }

  subscribeToSettingsUpdates()
  syncDesktopLyricSettings(getSettings())
  try {
    initializeUpdateService()
  } catch (error) {
    // 更新服务失败不能影响正常启动和播放。
    logger.error('updates', '初始化更新服务失败', error)
  }
  try {
    initializePlaylistCacheService()
  } catch (error) {
    logger.error('playlist-cache', '初始化离线缓存失败', error)
  }

  // 启动后端服务器
  backendService.start()

  // 与后端并行加载界面；渲染入口只在首批请求前等待实际服务就绪。
  createWindow()
  initializeInstallQuitService()

  // 在 macOS 上，当点击 dock 图标且没有其他窗口打开时，通常会重新创建一个窗口
  app.on('activate', () => {
    if (!isQuitting && BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
}).catch(error => {
  logger.error('main', '应用初始化失败', error)
  userRequestedQuit = true
  app.quit()
})

/** 首屏挂载后才显示窗口，避免依赖固定延时或文档 load 事件猜测 Vue 就绪。 */
ipcMain.on('renderer:ready', (event) => {
  if (isQuitting || mainWindowReady || !isMainWindowSender(event)) return
  mainWindowReady = true
  mainWindow.show()
  updateTaskbarButtons()
  sendDesktopLyric('desktop-lyric:playback-update', desktopPlaybackSnapshot())
  mainWindow.focus()
  closeLoadingWindow()
  pendingPlayerControls.splice(0).forEach(action => mainWindow.webContents.send('player:control', action))
  startMemoryCleanup()
})

function isMainWindowSender(event) {
  return Boolean(mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents &&
    event.senderFrame === mainWindow.webContents.mainFrame)
}

/** 仅主窗口顶层可写入有限长度的纯文本，不提供读取剪贴板的能力。 */
ipcMain.handle('clipboard:write-text', (event, text) => {
  if (!isMainWindowSender(event)) throw new Error('不允许此窗口写入剪贴板')
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 1024 * 1024) {
    throw new Error('剪贴板文本格式或长度不符合要求')
  }
  clipboard.writeText(text)
  return true
})

/** 每次准备只绑定当时的主窗口和顶层 frame，导航与销毁立即失效旧保存请求。 */
function releaseInstallPreparation() {
  if (!installPreparation) return
  for (const [emitter, name, listener] of installPreparation.listeners) {
    emitter.removeListener(name, listener)
  }
  installPreparation = null
  updateTaskbarButtons()
  sendDesktopLyric('desktop-lyric:playback-update', desktopPlaybackSnapshot())
}

function notifyInstallPreparation(payload) {
  if (payload.phase === 'canceled') {
    const preparation = installPreparation
    if (!preparation || preparation.requestId !== payload.requestId) return
    releaseInstallPreparation()
    if (!preparation.window.isDestroyed() && !preparation.contents.isDestroyed?.()) {
      preparation.contents.send('updates:prepare-install', payload)
    }
    return
  }
  if (isQuitting || !mainWindowReady || !mainWindow || mainWindow.isDestroyed()) return false
  releaseInstallPreparation()
  const window = mainWindow
  const contents = window.webContents
  const requestId = payload.requestId
  const cancel = () => installQuitService?.cancel('RENDERER_CHANGED', requestId)
  const navigation = (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) cancel()
  }
  const listeners = [
    [contents, 'did-start-navigation', navigation],
    [contents, 'render-process-gone', cancel],
    [contents, 'destroyed', cancel],
    [window, 'closed', cancel]
  ]
  installPreparation = { requestId, window, contents, frame: contents.mainFrame, listeners }
  updateTaskbarButtons()
  sendDesktopLyric('desktop-lyric:playback-update', desktopPlaybackSnapshot())
  listeners.forEach(([emitter, name, listener]) => emitter.on(name, listener))
  contents.send('updates:prepare-install', payload)
  return true
}

/** Windows 打包版才开放每 PID 管道；失败不得阻塞窗口、后端或播放器启动。 */
function initializeInstallQuitService() {
  if (process.platform !== 'win32' || !app.isPackaged || isQuitting || installQuitService) return
  try {
    const { createInstallQuitService } = require('./services/installQuitService')
    installQuitService = createInstallQuitService({
      logger,
      onPrepare: notifyInstallPreparation,
      onQuit() {
        releaseInstallPreparation()
        userRequestedQuit = true
        app.quit()
      }
    })
    void installQuitService.start().catch(error => {
      logger.error('installer', '启动安装退出协作管道失败，应用继续启动', error)
    })
  } catch (error) {
    logger.error('installer', '初始化安装退出协作服务失败，应用继续启动', error)
  }
}

ipcMain.handle('updates:prepare-install-complete', (event, requestId, result) => {
  const preparation = installPreparation
  if (isQuitting || !isMainWindowSender(event) || !preparation || preparation.requestId !== requestId ||
    event.sender !== preparation.contents || event.senderFrame !== preparation.frame) return { success: false }
  return { success: installQuitService?.complete(requestId, result) === true }
})

ipcMain.handle('backend:ready', (event) => isMainWindowSender(event) ? backendService.waitUntilReady() : false)

// 窗口控制相关 ipcMain 事件
ipcMain.on('window-minimize', () => {
  const win = BrowserWindow.getFocusedWindow()
  if (win) win.minimize()
})
ipcMain.on('window-maximize', () => {
  const win = BrowserWindow.getFocusedWindow()
  if (win && !win.isMaximized()) win.maximize()
})
ipcMain.on('window-unmaximize', () => {
  const win = BrowserWindow.getFocusedWindow()
  if (win && win.isMaximized()) win.unmaximize()
})
ipcMain.on('window-close', () => {
  const win = BrowserWindow.getFocusedWindow()
  if (win) {
    // 检查设置，决定是隐藏到托盘还是真正关闭
    const settings = getSettings()
    if (settings.software?.minimizeToTray) {
      // 隐藏窗口到托盘
      win.hide()
      logger.trace('main', '🔽 应用已最小化到系统托盘')
    } else {
      // 正常关闭
      win.close()
    }
  }
})

// 设置相关 IPC 事件
ipcMain.handle('settings:get', async () => {
  return getSettings()
})

ipcMain.handle('settings:get-defaults', async () => {
  return getDefaultSettings()
})

ipcMain.handle('settings:get-default-paths', async () => {
  return getDefaultPaths()
})

ipcMain.handle('settings:set', async (_event, payload) => {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Invalid settings payload')
  }
  const updated = await setSettings(payload, { merge: false })
  await ensureCacheDirectory()
  return updated
})

ipcMain.handle('settings:export', async (_event, targetPath) => {
  if (!targetPath) {
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: '导出设置',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      defaultPath: 'BetterKugouSettings.json'
    })
    if (canceled || !filePath) {
      return { canceled: true }
    }
    await exportSettings(filePath)
    return { canceled: false, path: filePath }
  }
  await exportSettings(targetPath)
  return { canceled: false, path: targetPath }
})

ipcMain.handle('settings:import', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: '导入设置',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile']
  })
  if (canceled || !filePaths || filePaths.length === 0) {
    return { canceled: true }
  }
  const imported = await importSettings(filePaths[0])
  await ensureCacheDirectory()
  return { canceled: false, settings: imported }
})

ipcMain.handle('settings:choose-directory', async (_event, options = {}) => {
  const dialogOptions = {
    title: options.title || '选择文件夹',
    defaultPath: options.defaultPath || undefined,
    properties: ['openDirectory', 'createDirectory', 'promptToCreate']
  }
  if (options.message) {
    dialogOptions.message = options.message
  }
  if (options.buttonLabel) {
    dialogOptions.buttonLabel = options.buttonLabel
  }

  const result = await dialog.showOpenDialog(dialogOptions)
  if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
    return { canceled: true }
  }
  return { canceled: false, path: result.filePaths[0] }
})

// 全局快捷键相关 IPC 事件
ipcMain.handle('shortcut:register', async (_event, accelerator, action) => {
  try {
    logger.trace('main', `🎹 注册全局快捷键: ${accelerator} -> ${action}`)

    // 检查快捷键格式是否有效
    if (!accelerator || typeof accelerator !== 'string') {
      logger.error('main', '❌ 无效的快捷键格式:', accelerator)
      return { success: false, error: 'Invalid accelerator format' }
    }

    // 如果快捷键已经注册,先注销
    if (registeredShortcuts.has(accelerator)) {
      globalShortcut.unregister(accelerator)
      logger.trace('main', `🔄 已注销旧的快捷键: ${accelerator}`)
    }

    // 尝试注册全局快捷键
    const success = globalShortcut.register(accelerator, () => {
      logger.trace('main', `⚡ 全局快捷键触发: ${accelerator} -> ${action}`)
      // 向渲染进程发送快捷键触发事件
      const allWindows = BrowserWindow.getAllWindows()
      allWindows.forEach(win => {
        win.webContents.send('shortcut:triggered', action)
      })
    })

    if (success) {
      registeredShortcuts.set(accelerator, action)
      logger.trace('main', `✅ 全局快捷键注册成功: ${accelerator}`)
      return { success: true }
    } else {
      logger.error('main', `❌ 全局快捷键注册失败: ${accelerator}`)
      return { success: false, error: 'Failed to register shortcut' }
    }
  } catch (err) {
    logger.error('main', `❌ 注册快捷键异常: ${accelerator}`, err)
    return { success: false, error: err.message }
  }
})

ipcMain.handle('shortcut:unregister', async (_event, accelerator) => {
  try {
    logger.trace('main', `🗑️  注销全局快捷键: ${accelerator}`)

    if (registeredShortcuts.has(accelerator)) {
      globalShortcut.unregister(accelerator)
      registeredShortcuts.delete(accelerator)
      logger.trace('main', `✅ 快捷键注销成功: ${accelerator}`)
      return { success: true }
    } else {
      logger.trace('main', `⚠️  快捷键未注册: ${accelerator}`)
      return { success: true, warning: 'Shortcut was not registered' }
    }
  } catch (err) {
    logger.error('main', `❌ 注销快捷键异常: ${accelerator}`, err)
    return { success: false, error: err.message }
  }
})

ipcMain.handle('shortcut:test', async (_event, accelerator) => {
  try {
    // 测试快捷键是否可以注册(不实际注册)
    logger.trace('main', `🧪 测试快捷键: ${accelerator}`)

    if (!accelerator || typeof accelerator !== 'string') {
      return { canRegister: false, error: 'Invalid accelerator format' }
    }

    // 检查是否已被其他应用占用
    const isRegistered = globalShortcut.isRegistered(accelerator)

    if (isRegistered && !registeredShortcuts.has(accelerator)) {
      // 被其他应用占用
      logger.trace('main', `⚠️  快捷键已被占用: ${accelerator}`)
      return { canRegister: false, error: 'Shortcut is already registered by another application' }
    }

    logger.trace('main', `✅ 快捷键可用: ${accelerator}`)
    return { canRegister: true }
  } catch (err) {
    logger.error('main', `❌ 测试快捷键异常: ${accelerator}`, err)
    return { canRegister: false, error: err.message }
  }
})

// 外部链接打开处理器
ipcMain.handle('open-external', async (_event, url) => {
  try {
    logger.trace('main', `🌐 打开外部链接: ${url}`)
    await shell.openExternal(url)
    return { success: true }
  } catch (error) {
    logger.error('main', '❌ 打开外部链接失败:', error)
    return { success: false, error: error.message }
  }
})

// 桌面歌词相关 IPC 事件处理
ipcMain.handle('desktop-lyric:toggle', event => isMainWindowSender(event) ? toggleDesktopLyricWindow() : false)
ipcMain.handle('desktop-lyric:show', event => isMainWindowSender(event) ? showDesktopLyricWindow() : false)
ipcMain.handle('desktop-lyric:hide', event => {
  if (isQuitting || !isMainWindowSender(event)) return false
  closeDesktopLyricWindow()
  return true
})
ipcMain.handle('desktop-lyric:reset-position', event => isMainWindowSender(event) ? resetDesktopLyricPosition() : false)

// 日志 API 处理
ipcMain.handle('logger:init', async () => {
  try {
    logger.trace('main', '📝 日志系统初始化')
    return {
      success: true,
      logLevel: logger.logLevel
    }
  } catch (error) {
    logger.error('main', '❌ 日志初始化失败:', error)
    return { success: false, error: error.message }
  }
})

ipcMain.handle('logger:write', async (_event, payload) => {
  try {
    // 处理不同的参数形式
    let level = 'info'
    let message = ''
    let data = null
    let moduleName = 'renderer'

    if (typeof payload === 'string') {
      // 如果直接传递字符串，视为 message
      message = payload
    } else if (payload && typeof payload === 'object') {
      // 如果是对象，提取各个字段
      level = payload.level || payload.type || 'info'
      message = payload.message || ''
      moduleName = payload.module || moduleName
      data = payload.data ?? (payload.error ? { error: payload.error, stack: payload.stack } : null)
    }

    // 确保 level 是字符串
    const levels = ['trace', 'debug', 'info', 'warn', 'error']
    const method = levels.includes(level) ? level : 'info'
    logger[method](moduleName, message, ...(data == null ? [] : [data]))
    return { success: true }
  } catch (error) {
    logger.error('main', '❌ 写入日志失败:', error)
    return { success: false, error: error.message }
  }
})

// 配置 API 处理
ipcMain.handle('config:get', async () => {
  try {
    const config = getSettings()
    return { success: true, config }
  } catch (error) {
    logger.error('main', '❌ 获取配置失败:', error)
    return { success: false, error: error.message }
  }
})

ipcMain.handle('config:set', async (_event, config) => {
  try {
    if (config && typeof config === 'object') {
      await setSettings(config)
      return { success: true }
    }
    return { success: false, error: '配置格式错误' }
  } catch (error) {
    logger.error('main', '❌ 设置配置失败:', error)
    return { success: false, error: error.message }
  }
})

// 主题 API 处理
let themeCatalogPromise

/** 主题 IPC 与渲染入口共用校验目录，不把损坏包列为可激活主题。 */
function loadThemeCatalog() {
  if (!themeCatalogPromise) {
    themeCatalogPromise = import('../src/themes/themeCatalog.mjs').then(({ createThemeCatalog }) => createThemeCatalog(
      require('../src/themes/default-dark.json'), require('../src/themes/default-light.json')
    ))
  }
  return themeCatalogPromise
}

ipcMain.handle('theme:load-config', async () => {
  try {
    const settings = getSettings()
    const catalog = await loadThemeCatalog()
    return {
      success: true,
      theme: settings?.custom?.theme || 'dark',
      customTheme: settings?.custom?.customTheme || {},
      themePackages: catalog.listThemePackages(settings?.custom).filter(theme => !['dark', 'light'].includes(theme.id))
    }
  } catch (error) {
    logger.error('main', '❌ 加载主题配置失败:', error)
    return { success: false, error: error.message }
  }
})

ipcMain.handle('theme:get-available', async () => {
  try {
    const catalog = await loadThemeCatalog()
    const themes = catalog.listThemePackages(getSettings()?.custom).map(theme => theme.id)
    return {
      success: true,
      themes: [...themes, 'system', 'custom']
    }
  } catch (error) {
    logger.error('main', '❌ 获取可用主题失败:', error)
    return { success: false, error: error.message }
  }
})

ipcMain.handle('theme:set-active', async (_event, themeName) => {
  try {
    const settings = getSettings()
    const selected = themeName === 'auto' ? 'system' : themeName
    const catalog = await loadThemeCatalog()
    const isInstalled = catalog.getThemePackage(selected, settings?.custom)
    if (!['dark', 'light', 'system', 'custom'].includes(selected) && !isInstalled) {
      return { success: false, error: '主题不存在或不可用' }
    }
    await setSettings({ custom: { theme: selected } })
    // 广播主题变更
    const wins = BrowserWindow.getAllWindows().filter(w => !w.isDestroyed())
    wins.forEach(w => w.webContents.send('theme:changed', selected))
    return { success: true }
  } catch (error) {
    logger.error('main', '❌ 设置主题失败:', error)
    return { success: false, error: error.message }
  }
})

// 当所有窗口都关闭时退出应用
app.on('window-all-closed', async () => {
  logger.trace('main', '🪟 所有窗口已关闭')
  if (isQuitting) return
  if (process.platform === 'darwin' && !userRequestedQuit && !isQuitting) return

  // 如果用户主动要求退出，忽略托盘设置直接退出
  if (userRequestedQuit) {
    logger.trace('main', '🚪 用户主动退出，忽略托盘设置')
    await performApplicationCleanup()
    if (process.platform !== 'darwin') {
      app.quit()
    }
    return
  }

  // 检查是否有托盘设置
  const settings = getSettings()
  if (!settings.software?.minimizeToTray) {
    logger.trace('main', '� 未启用托盘模式，执行完整退出流程')
    await performApplicationCleanup()
    if (process.platform !== 'darwin') {
      app.quit()
    }
  } else {
    logger.trace('main', '📍 托盘模式已启用，保持应用运行')
  }
})

// 应用退出前的清理
app.on('before-quit', async (event) => {
  logger.trace('main', '� 应用准备退出，检查清理状态...')

  if (!cleanupComplete) {
    logger.trace('main', '� 阻止默认退出，先执行清理流程')
    event.preventDefault()
    const wasCleaning = Boolean(cleanupPromise)
    await performApplicationCleanup()
    if (!wasCleaning) app.quit()
  } else {
    logger.trace('main', '✅ 清理已完成，允许应用退出')
  }
})

// 应用失去焦点时的处理(可选,用于调试)
app.on('browser-window-blur', () => {
  logger.trace('main', '📴 应用失去焦点 (全局快捷键仍然有效)')
})

app.on('browser-window-focus', () => {
  logger.trace('main', '📳 应用获得焦点')
})

// ============ 播放器相关 IPC (供渲染进程调用) ============
// 歌曲身份独立于标题；显式空歌曲清除所有重开缓存，同歌元数据更新保留进度。
ipcMain.on('player:track-update', (event, payload) => {
  if (isQuitting || !isMainWindowSender(event) || (payload !== null && (typeof payload !== 'object' || !payload))) return
  const next = payload === null ? { title: '暂无播放', artist: '', cover: null, trackId: null } : {
    title: typeof payload.title === 'string' ? payload.title || '未知歌曲' : currentTrack.title,
    artist: typeof payload.artist === 'string' ? payload.artist : currentTrack.artist || '未知歌手',
    cover: typeof payload.cover === 'string' ? payload.cover : null,
    trackId: typeof payload.trackId === 'string' ? payload.trackId : null
  }
  const trackChanged = payload === null || (next.trackId || currentTrack.trackId
    ? next.trackId !== currentTrack.trackId
    : next.title !== currentTrack.title || next.artist !== currentTrack.artist)
  if (trackChanged) { currentDesktopLyrics = []; currentDesktopTime = 0; currentDesktopDuration = 0; currentDesktopPlaybackRate = 1 }
  if (payload === null) isPlaying = false
  currentTrack = next
  updateTrayMenu()
  updateTaskbarButtons()
  sendDesktopLyric('desktop-lyric:song-update', payload === null ? null : currentTrack)
  if (trackChanged) {
    sendDesktopLyric('desktop-lyric:lyric-update', [])
    sendDesktopLyric('desktop-lyric:time-update', 0, { duration: 0, playbackRate: 1, advancing: false, discontinuity: true })
  }
  sendDesktopLyric('desktop-lyric:playback-update', desktopPlaybackSnapshot())
})

// 更新播放状态: playing | paused
ipcMain.on('player:playback-state', (event, state) => {
  if (isQuitting || !isMainWindowSender(event) || !['playing', 'paused'].includes(state)) return
  isPlaying = state === 'playing'
  updateTrayMenu()
  updateTaskbarButtons()
  sendDesktopLyric('desktop-lyric:playback-update', desktopPlaybackSnapshot())
})

// 接收并转发歌词数据
ipcMain.on('player:lyric-update', (event, lyrics, trackId) => {
  if (isQuitting || !isMainWindowSender(event) || !Array.isArray(lyrics) ||
      (trackId !== undefined && trackId !== currentTrack.trackId)) return
  currentDesktopLyrics = lyrics
  sendDesktopLyric('desktop-lyric:lyric-update', lyrics)
})

// 只转发当前音源的音频时间与动画授权；主进程不推算播放位置。
ipcMain.on('player:time-update', (event, time, meta) => {
  if (isQuitting || !isMainWindowSender(event) || !Number.isFinite(time) || time < 0 ||
      (meta?.trackId !== undefined && meta.trackId !== currentTrack.trackId)) return
  currentDesktopTime = time
  if (Number.isFinite(meta?.duration) && meta.duration >= 0) currentDesktopDuration = meta.duration
  currentDesktopPlaybackRate = Number.isFinite(meta?.playbackRate) && meta.playbackRate > 0 ? meta.playbackRate : 1
  sendDesktopLyric('desktop-lyric:time-update', time, { duration: currentDesktopDuration,
    playbackRate: currentDesktopPlaybackRate, advancing: meta?.advancing === true, discontinuity: meta?.discontinuity === true })
})

// 桌面歌词窗口内部事件处理
function isDesktopLyricSender(event) {
  return Boolean(!isQuitting && desktopLyricWindow && !desktopLyricWindow.isDestroyed() &&
    event.sender === desktopLyricWindow.webContents && event.senderFrame === desktopLyricWindow.webContents.mainFrame)
}

ipcMain.on('desktop-lyric:close', event => { if (isDesktopLyricSender(event)) closeDesktopLyricWindow() })
for (const [channel, field, values] of [
  ['size-changed', 'fontSize', ['small', 'medium', 'large']],
  ['theme-changed', 'theme', ['classic', 'gradient', 'minimal']],
  ['set-locked', 'locked', [true, false]]
]) {
  ipcMain.handle(`desktop-lyric:${channel}`, (event, value) => {
    if (!isDesktopLyricSender(event) || !values.includes(value)) return { success: false, error: '无效的歌词设置操作。' }
    return saveDesktopPreference({ desktopLyrics: { [field]: value } })
  })
}
ipcMain.handle('desktop-lyric:set-translation', (event, value) => {
  if (!isDesktopLyricSender(event) || typeof value !== 'boolean') return { success: false, error: '无效的翻译设置。' }
  return saveDesktopPreference({ playback: { showTranslation: value } })
})
ipcMain.handle('desktop-lyric:control', (event, action) => {
  if (!isDesktopLyricSender(event) || !desktopPlaybackSnapshot().available || !['prev', 'toggle', 'next'].includes(action)) {
    return { success: false, error: '播放器尚未就绪，请先播放歌曲。' }
  }
  broadcastPlayerControl(action === 'toggle' ? (isPlaying ? 'pause' : 'play') : action)
  return { success: true }
})

/** 自定义缩放只使用主进程的真实鼠标坐标，锁定与窗口更换会取消操作。 */
ipcMain.handle('desktop-lyric:begin-resize', event => {
  if (!isDesktopLyricSender(event)) return { success: false }
  const state = desktopWindowStates.get(desktopLyricWindow)
  if (state.locked || !screen?.getCursorScreenPoint) return { success: false }
  state.resize = { point: screen.getCursorScreenPoint(), bounds: desktopLyricWindow.getBounds() }
  return { success: true }
})
ipcMain.on('desktop-lyric:resize', event => {
  if (!isDesktopLyricSender(event)) return
  const state = desktopWindowStates.get(desktopLyricWindow)
  if (state.locked || !state.resize) return
  const { point, bounds } = state.resize
  const cursor = screen.getCursorScreenPoint()
  desktopLyricWindow.setBounds(getDesktopLyricBounds({ ...bounds,
    width: bounds.width + cursor.x - point.x, height: bounds.height + cursor.y - point.y }))
})
ipcMain.on('desktop-lyric:end-resize', event => {
  if (!isDesktopLyricSender(event)) return
  desktopWindowStates.get(desktopLyricWindow).resize = null
  rememberDesktopLyricBounds(desktopLyricWindow)
})
ipcMain.handle('desktop-lyric:resize-by', (event, delta) => {
  if (!isDesktopLyricSender(event) || desktopWindowStates.get(desktopLyricWindow).locked ||
      !delta || !['width', 'height'].every(key => Number.isFinite(delta[key]) && Math.abs(delta[key]) <= 100)) return { success: false }
  const bounds = desktopLyricWindow.getBounds()
  desktopLyricWindow.setBounds(getDesktopLyricBounds({ ...bounds, width: bounds.width + delta.width, height: bounds.height + delta.height }))
  rememberDesktopLyricBounds(desktopLyricWindow)
  return { success: true }
})
