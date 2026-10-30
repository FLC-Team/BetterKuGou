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
  writeClipboardText: (text) => ipcRenderer.invoke('clipboard:write-text', text),

  // 私有离线资源只通过固定操作访问，不暴露文件路径或通用下载能力。
  playlistCache: {
    setSession: (session) => ipcRenderer.invoke('playlist-cache:set-session', session),
    getState: () => ipcRenderer.invoke('playlist-cache:get-state'),
    chooseDirectory: () => ipcRenderer.invoke('playlist-cache:choose-directory'),
    readPlaylist: (id = null) => ipcRenderer.invoke('playlist-cache:read-playlist', id),
    putPlaylist: (snapshot) => ipcRenderer.invoke('playlist-cache:put-playlist', snapshot),
    cacheSong: (request) => ipcRenderer.invoke('playlist-cache:cache-song', request),
    getSource: (request) => ipcRenderer.invoke('playlist-cache:get-source', request),
    releaseSource: (leaseId) => ipcRenderer.invoke('playlist-cache:release-source', leaseId),
    readLyrics: (hash) => ipcRenderer.invoke('playlist-cache:read-lyrics', hash),
    putLyrics: (request) => ipcRenderer.invoke('playlist-cache:put-lyrics', request),
    getArtwork: (url) => ipcRenderer.invoke('playlist-cache:get-artwork', url),
    cacheArtwork: (url) => ipcRenderer.invoke('playlist-cache:cache-artwork', url),
    pause: (id = null) => ipcRenderer.invoke('playlist-cache:pause', id),
    resume: (id = null) => ipcRenderer.invoke('playlist-cache:resume', id),
    retry: (id = null) => ipcRenderer.invoke('playlist-cache:retry', id),
    retryNetwork: () => ipcRenderer.invoke('playlist-cache:retry-network'),
    clear: () => ipcRenderer.invoke('playlist-cache:clear'),
    onState: (callback) => subscribe('playlist-cache:state', callback),
    onAuthExpired: (callback) => subscribe('playlist-cache:auth-expired', callback)
  },

  // 歌词版本仅按歌曲标识读写，不提供文件路径或通用文件系统能力。
  lyricLibrary: {
    list: () => ipcRenderer.invoke('lyric-library:list'),
    read: (hash) => ipcRenderer.invoke('lyric-library:read', hash),
    saveOnline: (request) => ipcRenderer.invoke('lyric-library:save-online', request),
    saveEdit: (request) => ipcRenderer.invoke('lyric-library:save-edit', request),
    select: (request) => ipcRenderer.invoke('lyric-library:select', request),
    onChanged: (callback) => subscribe('lyric-library:changed', callback)
  },

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
    if (track === null) { ipcRenderer.send('player:track-update', null); return }
    if (!track || typeof track !== 'object') return
    ipcRenderer.send('player:track-update', {
      trackId: typeof track.trackId === 'string' ? track.trackId : null,
      title: track.title || track.name || '未知歌曲',
      cover: track.cover || track.pic || track.image || null,
      artist: track.artist || track.singername || '未知歌手'
    })
  },
  updatePlaybackState: (isPlaying) => {
    ipcRenderer.send('player:playback-state', isPlaying ? 'playing' : 'paused')
  },
  setLyricViewVisible: (visible) => {
    if (typeof visible === 'boolean') ipcRenderer.send('player:lyric-view-visible', visible)
  },
  updateLyrics: (lyrics, trackId) => {
    if (Array.isArray(lyrics)) {
      ipcRenderer.send('player:lyric-update', lyrics, typeof trackId === 'string' ? trackId : undefined)
    } else {
      console.warn('preload', '歌词必须是数组')
    }
  },
  updateCurrentTime: (time) => {
    if (Number.isFinite(time) && time >= 0) {
      ipcRenderer.send('player:time-update', time * 1000) // 转换为毫秒
    }
  },
  updatePlaybackTime: (time, meta) => {
    if (Number.isFinite(time) && time >= 0) {
      ipcRenderer.send('player:time-update', time, {
        trackId: typeof meta?.trackId === 'string' ? meta.trackId : undefined,
        duration: Number.isFinite(meta?.duration) && meta.duration >= 0 ? meta.duration : undefined,
        advancing: meta?.advancing === true,
        playbackRate: Number.isFinite(meta?.playbackRate) && meta.playbackRate > 0 ? meta.playbackRate : 1,
        discontinuity: meta?.discontinuity === true
      })
    }
  },
  onPlayerControl: (callback) => {
    if (typeof callback !== 'function') return () => {}
    const listener = (_e, action) => callback(action)
    ipcRenderer.on('player:control', listener)
    return () => ipcRenderer.removeListener('player:control', listener)
  },

  // 桌面歌词相关API
  islandLyric: {
    show: () => ipcRenderer.invoke('island-lyric:show'),
    getDisplays: () => ipcRenderer.invoke('island-lyric:get-displays'),
    getCapabilities: () => ipcRenderer.invoke('island-lyric:get-capabilities'),
    onDisplaysChanged: callback => subscribe('island-lyric:displays-changed', callback),
    setLyricViewOpen: visible => { if (typeof visible === 'boolean') ipcRenderer.send('island-lyric:main-lyrics', visible) }
  },
  desktopLyric: {
    toggle: () => ipcRenderer.invoke('desktop-lyric:toggle'),
    show: () => ipcRenderer.invoke('desktop-lyric:show'),
    hide: () => ipcRenderer.invoke('desktop-lyric:hide'),
    resetPosition: () => ipcRenderer.invoke('desktop-lyric:reset-position')
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
  onPlaybackUpdate: (callback) => subscribe('desktop-lyric:playback-update', callback),
  onRuntimeState: (callback) => subscribe('desktop-lyric:runtime-state', callback),
  onError: (callback) => subscribe('desktop-lyric:error', callback),
  onSettingsUpdate: (callback) => subscribe('desktop-lyric:settings-update', callback),
  onLockChanged: (callback) => subscribe('desktop-lyric:lock-changed', callback),
  changeSize: (size) => {
    return ['small', 'medium', 'large'].includes(size)
      ? ipcRenderer.invoke('desktop-lyric:size-changed', size)
      : Promise.resolve({ success: false, error: '无效的歌词字号' })
  },
  changeTheme: (theme) => {
    return ['classic', 'gradient', 'minimal'].includes(theme)
      ? ipcRenderer.invoke('desktop-lyric:theme-changed', theme)
      : Promise.resolve({ success: false, error: '无效的歌词样式' })
  },
  setLocked: (locked) => typeof locked === 'boolean'
    ? ipcRenderer.invoke('desktop-lyric:set-locked', locked)
    : Promise.resolve({ success: false, error: '无效的锁定状态' }),
  setTranslation: (show) => typeof show === 'boolean'
    ? ipcRenderer.invoke('desktop-lyric:set-translation', show)
    : Promise.resolve({ success: false, error: '无效的翻译状态' }),
  control: (action) => ['prev', 'toggle', 'next'].includes(action)
    ? ipcRenderer.invoke('desktop-lyric:control', action)
    : Promise.resolve({ success: false, error: '无效的播放操作' }),
  beginResize: () => ipcRenderer.invoke('desktop-lyric:begin-resize'),
  resize: () => ipcRenderer.send('desktop-lyric:resize'),
  endResize: () => ipcRenderer.send('desktop-lyric:end-resize'),
  resizeBy: (delta) => ipcRenderer.invoke('desktop-lyric:resize-by', {
    width: delta?.width, height: delta?.height
  }),
  close: () => ipcRenderer.send('desktop-lyric:close')
})

contextBridge.exposeInMainWorld('islandLyricAPI', {
  beginDrag: () => ipcRenderer.invoke('island-lyric:begin-drag'),
  drag: () => ipcRenderer.send('island-lyric:drag'),
  endDrag: () => ipcRenderer.invoke('island-lyric:end-drag'),
  onPointerUpdate: callback => subscribe('island-lyric:pointer-update', callback),
  onSongUpdate: callback => subscribe('island-lyric:song-update', callback),
  onLyricUpdate: callback => subscribe('island-lyric:lyric-update', callback),
  onTimeUpdate: callback => subscribe('island-lyric:time-update', callback),
  onPlaybackUpdate: callback => subscribe('island-lyric:playback-update', callback),
  onSettingsUpdate: callback => subscribe('island-lyric:settings-update', callback),
  onError: callback => subscribe('island-lyric:error', callback),
  control: action => ['prev', 'toggle', 'next'].includes(action)
    ? ipcRenderer.invoke('island-lyric:control', action)
    : Promise.resolve({ success: false, error: '无效的播放操作' }),
  setTranslation: show => typeof show === 'boolean'
    ? ipcRenderer.invoke('island-lyric:set-translation', show)
    : Promise.resolve({ success: false, error: '无效的翻译状态' }),
  setInteractive: interactive => {
    if (typeof interactive === 'boolean') ipcRenderer.send('island-lyric:set-interactive', interactive)
  },
  close: () => ipcRenderer.invoke('island-lyric:close')
})

// 为了防止 undefined 错误，暴露一个 API 检查函数
contextBridge.exposeInMainWorld('checkElectronAPI', () => {
  return {
    electronAPI: typeof window.electronAPI !== 'undefined' ? 'available' : 'undefined',
    settingsAPI: typeof window.settingsAPI !== 'undefined' ? 'available' : 'undefined'
  }
})
