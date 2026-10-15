// 引入 Electron 模块
const { app, BrowserWindow, ipcMain, dialog, globalShortcut, shell, Tray, Menu, nativeImage } = require('electron')
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
let startupWindowTimer = null
let showWindowTimer = null
let unsubscribeSettings = null
// 用户主动退出标志，用于区分托盘驻留和真正退出
let userRequestedQuit = false
// 当前播放信息(由渲染进程通过 IPC 推送)
let currentTrack = {
  title: '暂无播放',
  cover: null // 可以是文件路径或 dataURL/base64
}
let isPlaying = false
let currentDesktopLyrics = []
let currentDesktopTime = 0
let desktopAppearanceGeneration = 0
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
  const wins = BrowserWindow.getAllWindows().filter(w => !w.isDestroyed())
  if (wins.length === 0) {
    pendingPlayerControls.push(action)
    logger.trace('main', '🕒 窗口未就绪, 已缓存控制指令:', action)
    return
  }
  logger.trace('main', '📤 广播播放器控制指令:', action)
  wins.forEach(w => w.webContents.send('player:control', action))
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
    { label: desktopLyricLabel, click: () => {
        logger.trace('main', '🎵 托盘菜单：桌面歌词切换')
        if (desktopLyricEnabled && desktopLyricWindow && !desktopLyricWindow.isDestroyed()) {
          logger.trace('main', '🎵 关闭桌面歌词窗口')
          desktopLyricWindow.close()
          desktopLyricEnabled = false
        } else {
          logger.trace('main', '🎵 打开桌面歌词窗口')
          createDesktopLyricWindow()
          desktopLyricEnabled = true
        }
        updateTrayMenu()
      }
    },
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

// 创建桌面歌词窗口
function createDesktopLyricWindow() {
  if (desktopLyricWindow && !desktopLyricWindow.isDestroyed()) {
    return desktopLyricWindow
  }

  logger.trace('main', '🎵 创建桌面歌词窗口...')

  desktopLyricWindow = new BrowserWindow({
    width: 800,
    height: 200,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    movable: true,
    minimizable: false,
    maximizable: false,
    closable: true,
    focusable: false, // 防止抢夺焦点
    show: false, // 创建时先不显示
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  })

  // 加载桌面歌词HTML文件
  const desktopLyricPath = path.join(__dirname, 'desktopLyric.html')
  desktopLyricWindow.loadFile(desktopLyricPath).catch(error => {
    logger.error('main', '加载桌面歌词窗口失败', error)
  })

  // 窗口事件处理
  desktopLyricWindow.on('closed', () => {
    logger.trace('main', '🎵 桌面歌词窗口已关闭')
    desktopLyricWindow = null
    desktopLyricEnabled = false
    updateTrayMenu()
  })

  desktopLyricWindow.on('ready-to-show', () => {
    logger.trace('main', '🎵 桌面歌词窗口准备就绪')
    desktopLyricWindow.show()
    syncDesktopLyricSettings()
    // 发送当前歌曲信息和歌词数据
    if (currentTrack.title !== '暂无播放') {
      desktopLyricWindow.webContents.send('desktop-lyric:song-update', currentTrack)
    }
    desktopLyricWindow.webContents.send('desktop-lyric:lyric-update', currentDesktopLyrics)
    desktopLyricWindow.webContents.send('desktop-lyric:time-update', currentDesktopTime)
  })

  // 开发环境下打开调试工具
  if (isDev) {
    desktopLyricWindow.webContents.openDevTools()
  }

  desktopLyricEnabled = true
  updateTrayMenu()

  return desktopLyricWindow
}

/** 桌面歌词只接收已提交的白名单显示偏好，创建和重新打开时应用同一快照。 */
function syncDesktopLyricSettings(settings) {
  const generation = ++desktopAppearanceGeneration
  if (!desktopLyricWindow || desktopLyricWindow.isDestroyed()) return
  if (!settings) {
    try { settings = getSettings() } catch (error) {
      // 托盘可能在初始化完成前打开歌词，先显示默认值，初始化后再由订阅同步。
      logger.trace('main', '桌面歌词等待设置初始化', error)
    }
  }
  const value = settings?.desktopLyrics || {}
  const preferences = {
    fontSize: ['small', 'medium', 'large'].includes(value.fontSize) ? value.fontSize : 'medium',
    theme: ['classic', 'gradient', 'minimal'].includes(value.theme) ? value.theme : 'classic',
    locked: typeof value.locked === 'boolean' ? value.locked : false
  }
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
  })
}
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
    logger.error('main', '加载启动窗口失败', error)
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
  cleanupPromise = Promise.resolve().then(cleanupApplicationResources).finally(() => {
    cleanupComplete = true
  })
  return cleanupPromise
}

async function cleanupApplicationResources() {
  if (startupWindowTimer) clearTimeout(startupWindowTimer)
  if (showWindowTimer) clearTimeout(showWindowTimer)
  startupWindowTimer = null
  showWindowTimer = null
  unsubscribeSettings?.()
  unsubscribeSettings = null
  logger.trace('main', '🗑️ 开始应用退出清理流程...')

  try {
    // 1. 停止所有定时器和后台任务
    logger.trace('main', '🛑 停止内存清理定时器...')
    stopMemoryCleanup()

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
      if (desktopLyricWindow && !desktopLyricWindow.isDestroyed()) {
        desktopLyricWindow.close()
        desktopLyricWindow = null
        desktopLyricEnabled = false
      }
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
    logger.error('main', '加载主窗口失败', error)
  })

  // 页面加载完成后的处理
  mainWindow.webContents.on('did-finish-load', () => {
    if (isQuitting) return
    updateLoadingProgress(90, '准备就绪', 'login')
    // 冲刷之前缓存的播放器控制指令
    if (pendingPlayerControls.length) {
      logger.trace('main', '🚀 发送缓存的播放器控制指令: ', pendingPlayerControls)
      pendingPlayerControls.splice(0).forEach(action => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('player:control', action)
        }
      })
    }

    // 立即显示主窗口并关闭加载窗口
    if (showWindowTimer) clearTimeout(showWindowTimer)
    showWindowTimer = setTimeout(() => {
      showWindowTimer = null
      if (isQuitting) return
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show()
        mainWindow.focus()
      }
      closeLoadingWindow()

      // 启动内存自动清理
      startMemoryCleanup()
    }, 300)
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

  // 启动后端服务器
  backendService.start()

  // 立即创建主窗口(不等待后端完全启动)
  startupWindowTimer = setTimeout(() => {
    startupWindowTimer = null
    if (isQuitting) return
    createWindow()
  }, 1500)

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
ipcMain.handle('desktop-lyric:toggle', async () => {
  try {
    logger.trace('main', '🎵 桌面歌词切换操作...')
    if (desktopLyricEnabled && desktopLyricWindow && !desktopLyricWindow.isDestroyed()) {
      logger.trace('main', '🎵 关闭桌面歌词窗口')
      desktopLyricWindow.close()
      desktopLyricEnabled = false
    } else {
      logger.trace('main', '🎵 打开桌面歌词窗口')
      createDesktopLyricWindow()
      desktopLyricEnabled = true
    }
    updateTrayMenu()
    return desktopLyricEnabled
  } catch (error) {
    logger.error('main', '❌ 桌面歌词切换失败:', error)
    return false
  }
})

ipcMain.handle('desktop-lyric:show', async () => {
  try {
    logger.trace('main', '🎵 显示桌面歌词')
    if (!desktopLyricWindow || desktopLyricWindow.isDestroyed()) {
      createDesktopLyricWindow()
    } else {
      desktopLyricWindow.show()
    }
    desktopLyricEnabled = true
    updateTrayMenu()
    return true
  } catch (error) {
    logger.error('main', '❌ 显示桌面歌词失败:', error)
    return false
  }
})

ipcMain.handle('desktop-lyric:hide', async () => {
  try {
    logger.trace('main', '🎵 隐藏桌面歌词')
    if (desktopLyricWindow && !desktopLyricWindow.isDestroyed()) {
      desktopLyricWindow.close()
    }
    desktopLyricEnabled = false
    updateTrayMenu()
    return true
  } catch (error) {
    logger.error('main', '❌ 隐藏桌面歌词失败:', error)
    return false
  }
})

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
// 更新当前歌曲信息: { title, cover }
ipcMain.on('player:track-update', (_event, payload) => {
  if (payload && typeof payload === 'object') {
    const trackChanged = (typeof payload.title === 'string' && payload.title !== currentTrack.title) ||
      (typeof payload.artist === 'string' && payload.artist !== currentTrack.artist)
    if (trackChanged) {
      currentDesktopLyrics = []
      currentDesktopTime = 0
    }
    if (typeof payload.title === 'string') currentTrack.title = payload.title || '未知歌曲'
    if (payload.cover) currentTrack.cover = payload.cover
    if (typeof payload.artist === 'string') currentTrack.artist = payload.artist
    updateTrayMenu()

    // 转发歌曲信息到桌面歌词窗口
    if (desktopLyricWindow && !desktopLyricWindow.isDestroyed()) {
      logger.trace('main', '🎵 转发歌曲信息到桌面歌词:', payload)
      desktopLyricWindow.webContents.send('desktop-lyric:song-update', payload)
      if (trackChanged) {
        desktopLyricWindow.webContents.send('desktop-lyric:lyric-update', [])
        desktopLyricWindow.webContents.send('desktop-lyric:time-update', 0)
      }
    }
  }
})

// 更新播放状态: playing | paused
ipcMain.on('player:playback-state', (_event, state) => {
  isPlaying = state === 'playing'
  updateTrayMenu()
})

// 接收并转发歌词数据
ipcMain.on('player:lyric-update', (_event, lyrics) => {
  if (!Array.isArray(lyrics)) return
  currentDesktopLyrics = lyrics
  logger.trace('main', '📡 主进程接收到歌词数据:', lyrics ? lyrics.length : 0, '行')
  if (desktopLyricWindow && !desktopLyricWindow.isDestroyed()) {
    logger.trace('main', '🎵 转发歌词数据到桌面歌词窗口')
    desktopLyricWindow.webContents.send('desktop-lyric:lyric-update', lyrics)
  }
})

// 接收并转发播放时间
ipcMain.on('player:time-update', (_event, time) => {
  if (!Number.isFinite(time) || time < 0) return
  currentDesktopTime = time
  if (desktopLyricWindow && !desktopLyricWindow.isDestroyed()) {
    // 减少日志频率，避免刷屏
    if (typeof time === 'number' && Math.floor(time / 1000) % 5 === 0) {
      logger.trace('main', '⏱️ 转发播放时间到桌面歌词:', Math.floor(time / 1000) + 's')
    }
    desktopLyricWindow.webContents.send('desktop-lyric:time-update', time)
  }
})

// 桌面歌词窗口内部事件处理
ipcMain.on('desktop-lyric:close', () => {
  logger.trace('main', '🎵 桌面歌词请求关闭')
  if (desktopLyricWindow && !desktopLyricWindow.isDestroyed()) {
    desktopLyricWindow.close()
  }
})

ipcMain.on('desktop-lyric:size-changed', (event, size) => {
  if (event.sender !== desktopLyricWindow?.webContents || !['small', 'medium', 'large'].includes(size)) return
  void setSettings({ desktopLyrics: { fontSize: size } }).catch(error => {
    logger.error('main', '保存桌面歌词大小失败', error)
    syncDesktopLyricSettings()
  })
})

ipcMain.on('desktop-lyric:theme-changed', (event, theme) => {
  if (event.sender !== desktopLyricWindow?.webContents || !['classic', 'gradient', 'minimal'].includes(theme)) return
  void setSettings({ desktopLyrics: { theme } }).catch(error => {
    logger.error('main', '保存桌面歌词样式失败', error)
    syncDesktopLyricSettings()
  })
})
