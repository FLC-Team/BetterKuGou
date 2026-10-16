// preload.js
const { contextBridge, ipcRenderer } = require('electron')

/** 仅订阅白名单频道，隐藏 Electron event 并返回成对的解绑函数。 */
function subscribe(channel, callback) {
  if (typeof callback !== 'function') return () => {}
  const listener = (_event, ...args) => callback(...args)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const electronAPI = {
  waitForBackend: () => ipcRenderer.invoke('backend:ready'),
  notifyReady: () => ipcRenderer.send('renderer:ready'),
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  unmaximize: () => ipcRenderer.send('window-unmaximize'),
  close: () => ipcRenderer.send('window-close'),
  onMaximized: (cb) => subscribe('window-is-maximized', cb),
  onUnmaximized: (cb) => subscribe('window-is-unmaximized', cb),

  // 外部链接打开 API
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  // 更新任务只接受已检查出的资产 ID；安装始终经过主窗口确认。
  updates: {
    getState: () => ipcRenderer.invoke('updates:get-state'),
    check: () => ipcRenderer.invoke('updates:check'),
    download: (assetId) => ipcRenderer.invoke('updates:download', assetId),
    cancel: () => ipcRenderer.invoke('updates:cancel'),
    revealDownloadedFile: () => ipcRenderer.invoke('updates:reveal'),
    requestInstall: () => ipcRenderer.invoke('updates:install'),
    onState: (callback) => subscribe('updates:state', callback),
    onPrepareForInstall: (callback) => subscribe('updates:prepare-install', callback),
    completePrepareForInstall: (requestId, result) => ipcRenderer.invoke('updates:prepare-install-complete', requestId, result)
  },

  // 全局快捷键 API
  registerGlobalShortcut: (accelerator, action) =>
    ipcRenderer.invoke('shortcut:register', accelerator, action),
  unregisterGlobalShortcut: (accelerator) =>
    ipcRenderer.invoke('shortcut:unregister', accelerator),
  testGlobalShortcut: (accelerator) =>
    ipcRenderer.invoke('shortcut:test', accelerator),
  onGlobalShortcut: (callback) => {
    if (typeof callback !== 'function') return () => {}
    const listener = (_event, action) => callback(action)
    ipcRenderer.on('shortcut:triggered', listener)
    return () => ipcRenderer.removeListener('shortcut:triggered', listener)
  },

  // 内存清理 API
  onMemoryCleanup: (callback) => {
    if (typeof callback !== 'function') return () => {}
    const listener = () => callback()
    ipcRenderer.on('memory-cleanup', listener)
    return () => ipcRenderer.removeListener('memory-cleanup', listener)
  },

  // 播放器相关: 向主进程汇报当前歌曲/状态
  updateTrack: (track) => {
    if (!track || typeof track !== 'object') return
    ipcRenderer.send('player:track-update', {
      title: track.title || track.name || '未知歌曲',
      cover: track.cover || track.pic || track.image || null,
      artist: track.artist || track.singername || '未知歌手'
    })
  },
  updatePlaybackState: (isPlaying) => {
    ipcRenderer.send('player:playback-state', isPlaying ? 'playing' : 'paused')
  },
  updateLyrics: (lyrics) => {
    if (Array.isArray(lyrics)) {
      ipcRenderer.send('player:lyric-update', lyrics)
    } else {
      console.warn('preload', '歌词必须是数组')
    }
  },
  updateCurrentTime: (time) => {
    if (Number.isFinite(time) && time >= 0) {
      ipcRenderer.send('player:time-update', time * 1000) // 转换为毫秒
    }
  },
  updatePlaybackTime: (time) => {
    if (Number.isFinite(time) && time >= 0) {
      ipcRenderer.send('player:time-update', time)
    }
  },
  onPlayerControl: (callback) => {
    if (typeof callback !== 'function') return () => {}
    const listener = (_e, action) => callback(action)
    ipcRenderer.on('player:control', listener)
    return () => ipcRenderer.removeListener('player:control', listener)
  },

  // 桌面歌词相关API
  desktopLyric: {
    toggle: () => ipcRenderer.invoke('desktop-lyric:toggle'),
    show: () => ipcRenderer.invoke('desktop-lyric:show'),
    hide: () => ipcRenderer.invoke('desktop-lyric:hide')
  },

  // 日志 API
  initLogger: () => ipcRenderer.invoke('logger:init'),
  writeLog: (level, message, data) => {
    // 支持多种调用方式
    if (typeof level === 'object' && level !== null) {
      // writeLog({ level, message, data })
      return ipcRenderer.invoke('logger:write', level)
    } else if (typeof level === 'string' && typeof message === 'string') {
      // writeLog('info', 'message', data)
      return ipcRenderer.invoke('logger:write', { level, message, data })
    } else {
      // writeLog('message only')
      return ipcRenderer.invoke('logger:write', { message: level })
    }
  },

  // 配置 API
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (config) => ipcRenderer.invoke('config:set', config),

  // 主题管理 API
  loadThemesConfig: () => ipcRenderer.invoke('theme:load-config'),
  getAvailableThemes: () => ipcRenderer.invoke('theme:get-available'),
  setActiveTheme: (themeName) => ipcRenderer.invoke('theme:set-active', themeName),
  onThemeChange: (callback) => {
    if (typeof callback !== 'function') return () => {}
    const listener = (_event, theme) => callback(theme)
    ipcRenderer.on('theme:changed', listener)
    return () => ipcRenderer.removeListener('theme:changed', listener)
  }
}

const settingsAPI = {
  get: () => ipcRenderer.invoke('settings:get'),
  getDefaults: () => ipcRenderer.invoke('settings:get-defaults'),
  getDefaultPaths: () => ipcRenderer.invoke('settings:get-default-paths'),
  set: (payload) => ipcRenderer.invoke('settings:set', payload),
  export: (targetPath) => ipcRenderer.invoke('settings:export', targetPath),
  import: () => ipcRenderer.invoke('settings:import'),
  chooseDirectory: (options) => ipcRenderer.invoke('settings:choose-directory', options),
  onUpdate: (callback) => {
    if (typeof callback !== 'function') return () => {}
    const listener = (_event, settings) => callback(settings)
    ipcRenderer.on('settings:updated', listener)
    return () => ipcRenderer.removeListener('settings:updated', listener)
  }
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI)
contextBridge.exposeInMainWorld('settingsAPI', settingsAPI)

contextBridge.exposeInMainWorld('loadingAPI', {
  onProgress: (callback) => subscribe('loading-progress', callback)
})

contextBridge.exposeInMainWorld('desktopLyricAPI', {
  onSongUpdate: (callback) => subscribe('desktop-lyric:song-update', callback),
  onLyricUpdate: (callback) => subscribe('desktop-lyric:lyric-update', callback),
  onTimeUpdate: (callback) => subscribe('desktop-lyric:time-update', callback),
  onSettingsUpdate: (callback) => subscribe('desktop-lyric:settings-update', callback),
  onLockChanged: (callback) => subscribe('desktop-lyric:lock-changed', callback),
  changeSize: (size) => {
    if (['small', 'medium', 'large'].includes(size)) ipcRenderer.send('desktop-lyric:size-changed', size)
  },
  changeTheme: (theme) => {
    if (['classic', 'gradient', 'minimal'].includes(theme)) ipcRenderer.send('desktop-lyric:theme-changed', theme)
  },
  close: () => ipcRenderer.send('desktop-lyric:close')
})

// 为了防止 undefined 错误，暴露一个 API 检查函数
contextBridge.exposeInMainWorld('checkElectronAPI', () => {
  return {
    electronAPI: typeof window.electronAPI !== 'undefined' ? 'available' : 'undefined',
    settingsAPI: typeof window.settingsAPI !== 'undefined' ? 'available' : 'undefined'
  }
})
