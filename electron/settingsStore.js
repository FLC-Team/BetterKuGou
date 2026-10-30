const fs = require('fs')
const fsp = fs.promises
const path = require('path')
const logger = require('./logger')

const {
  isAutoLaunchSupported,
  getAutoLaunchEnabled,
  setAutoLaunchEnabled
} = require('./autoLaunch')

const CURRENT_SCHEMA_VERSION = 1

const desktopLyricDefaults = Object.freeze({
  fontSize: 'medium', theme: 'classic', locked: false, bounds: null,
  doubleLine: true, efficientMode: false, transitionEnabled: true, transitionBlur: true,
  hideTranslation: false, songInfoOnly: false, karaokeEnabled: true,
  autoHidePaused: false, hideOnFullscreen: false, hideOnLyricView: true,
  hoverFade: false, hoverOpacity: 20, opacity: 100, strokeWidth: 100,
  alignment: 'center', fontFamily: '', activeColor: '', textColor: '', translationColor: '',
  shadowEnabled: false, shadowColorMode: 'cover', shadowColor: '#000000',
  shadowDepth: 5, shadowDirection: 315, shadowOpacity: 50, shadowRadius: 10,
  alwaysOnTop: true, hideUnlockButton: false
})

/** Normalize persisted desktop preferences; only known visual fields can reach the independent window. */
function normalizeDesktopLyrics(raw) {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const result = { ...desktopLyricDefaults }
  for (const [key, fallback] of Object.entries(desktopLyricDefaults)) {
    if (typeof fallback === 'boolean') result[key] = typeof value[key] === 'boolean' ? value[key] : fallback
  }
  const choices = { fontSize: ['small', 'medium', 'large'], theme: ['classic', 'gradient', 'minimal'],
    alignment: ['left', 'center', 'right'], shadowColorMode: ['cover', 'custom'] }
  for (const [key, options] of Object.entries(choices)) {
    if (options.includes(value[key])) result[key] = value[key]
  }
  const ranges = { hoverOpacity: 100, opacity: 100, strokeWidth: 200,
    shadowDepth: 30, shadowDirection: 360, shadowOpacity: 100, shadowRadius: 40 }
  for (const [key, max] of Object.entries(ranges)) {
    if (Number.isFinite(value[key])) result[key] = Math.round(Math.max(0, Math.min(max, value[key])))
  }
  for (const key of ['activeColor', 'textColor', 'translationColor', 'shadowColor']) {
    if (typeof value[key] === 'string' && /^#[0-9a-f]{6}$/i.test(value[key])) result[key] = value[key].toLowerCase()
  }
  if (typeof value.fontFamily === 'string' && value.fontFamily.length <= 128 && !/[\u0000-\u001f\u007f<>]/.test(value.fontFamily)) {
    result.fontFamily = value.fontFamily.trim()
  }
  const bounds = value.bounds
  if (bounds && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(bounds[key]))) {
    result.bounds = {
      x: Math.round(Math.max(-100000, Math.min(100000, bounds.x))), y: Math.round(Math.max(-100000, Math.min(100000, bounds.y))),
      width: Math.round(Math.max(420, Math.min(8192, bounds.width))), height: Math.round(Math.max(180, Math.min(4096, bounds.height)))
    }
  }
  return result
}

const listeners = new Set()

let settingsFilePath = null
let defaultsCache = null
let settingsCache = null
let appRef = null
let initPromise = null
let commitQueue = Promise.resolve()

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/** 拒绝能改变对象原型的字段，先完整检查再执行合并，避免部分更新。 */
function assertSafeKeys(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return
  seen.add(value)
  Object.keys(value).forEach((key) => {
    if (UNSAFE_KEYS.has(key)) {
      throw new TypeError(`Unsafe settings key: ${key}`)
    }
    assertSafeKeys(value[key], seen)
  })
}

function isPlainObject(value) {
  return Object.prototype.toString.call(value) === '[object Object]'
}

function cloneDeep(value) {
  if (value === undefined) return undefined
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value)
    } catch (err) {
      // fall through
    }
  }
  return JSON.parse(JSON.stringify(value))
}

/** 创建合并副本；输入的原型字段由事务入口和 Schema 验证统一拒绝。 */
function mergeDeep(target, source) {
  if (!isPlainObject(target) && !Array.isArray(target)) {
    return cloneDeep(source)
  }
  const output = Array.isArray(target) ? target.slice() : { ...target }
  Object.keys(source || {}).forEach((key) => {
    const sourceValue = source[key]
    if (Array.isArray(sourceValue)) {
      output[key] = sourceValue.slice()
      return
    }
    if (isPlainObject(sourceValue)) {
      output[key] = mergeDeep(output[key], sourceValue)
      return
    }
    output[key] = sourceValue
  })
  return output
}

/** 补全灵动岛偏好并过滤非法导入值；窗口位置使用 DIP，视觉参数不接收字符串数值。 */
function normalizeIslandLyrics(value) {
  const island = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const bool = (key, fallback) => typeof island[key] === 'boolean' ? island[key] : fallback
  const number = (key, fallback, minimum, maximum) => Number.isFinite(island[key])
    ? Math.max(minimum, Math.min(maximum, island[key])) : fallback
  const colors = island.colors && typeof island.colors === 'object' && !Array.isArray(island.colors) ? island.colors : {}
  const color = (key, fallback) => typeof colors[key] === 'string' && /^#[0-9a-f]{6}$/i.test(colors[key]) ? colors[key].toLowerCase() : fallback
  const plainText = value => typeof value === 'string' && value.length <= 100 && !/[\x00-\x1f\x7f-\x9f]/.test(value)
  const position = island.position && ['x', 'y'].every(key => Number.isFinite(island.position[key]))
    ? Object.fromEntries(['x', 'y'].map(key => [key, Math.round(Math.max(-100000, Math.min(100000, island.position[key])))])) : null
  return {
    enabled: bool('enabled', false),
    showLogo: bool('showLogo', true),
    mode: ['mainland', 'floating'].includes(island.mode) ? island.mode : 'mainland',
    displayId: plainText(island.displayId) && island.displayId.trim() ? island.displayId.trim() : 'primary',
    position,
    alwaysTwoLines: bool('alwaysTwoLines', false),
    hideTranslation: bool('hideTranslation', false),
    songInfoOnly: bool('songInfoOnly', false),
    boldText: bool('boldText', false),
    fontFamily: plainText(island.fontFamily) ? island.fontFamily.trim() : '',
    fontSize: Math.round(number('fontSize', 22, 14, 40)),
    karaokeEnabled: bool('karaokeEnabled', true),
    autoHide: bool('autoHide', true),
    hideOnFullscreen: bool('hideOnFullscreen', false),
    hideOnLyricView: bool('hideOnLyricView', true),
    opacity: number('opacity', 1, .2, 1),
    backgroundOpacity: number('backgroundOpacity', 1, 0, 1),
    colors: { text: color('text', '#ffffff'), inactive: color('inactive', '#656565'), background: color('background', '#000000') },
    scale: number('scale', 1, .5, 2),
    leftContent: ['none', 'logo', 'cover'].includes(island.leftContent) ? island.leftContent : 'logo',
    rightContent: ['none', 'logo', 'cover'].includes(island.rightContent) ? island.rightContent : 'cover'
  }
}

function ensureSchema(settings) {
  assertSafeKeys(settings)
  let normalized = cloneDeep(settings)
  if (!isPlainObject(normalized)) {
    normalized = {}
  }
  if (normalized.schemaVersion == null) {
    normalized.schemaVersion = CURRENT_SCHEMA_VERSION
  }
  if (normalized.schemaVersion < CURRENT_SCHEMA_VERSION) {
    normalized.schemaVersion = CURRENT_SCHEMA_VERSION
    normalized = mergeDeep(defaultsCache, normalized)
  } else {
    normalized = mergeDeep(defaultsCache, normalized)
  }
  const desktop = isPlainObject(normalized.desktopLyrics) ? normalized.desktopLyrics : {}
  if (!isPlainObject(normalized.playback)) normalized.playback = cloneDeep(defaultsCache.playback)
  normalized.playback.showTranslation = typeof normalized.playback.showTranslation === 'boolean' ? normalized.playback.showTranslation : true
  normalized.playback.restartOnPreviousNearEnd = normalized.playback.restartOnPreviousNearEnd === true
  const library = isPlainObject(normalized.playback.lyricLibrary) ? normalized.playback.lyricLibrary : {}
  normalized.playback.lyricLibrary = {
    enabled: typeof library.enabled === 'boolean' ? library.enabled : true,
    autoSave: typeof library.autoSave === 'boolean' ? library.autoSave : true,
    minMatch: ['exact', 'high', 'medium', 'any'].includes(library.minMatch) ? library.minMatch : 'high',
    autoUpdate: typeof library.autoUpdate === 'boolean' ? library.autoUpdate : true
  }
  normalized.playback.romanization = ['off', 'on'].includes(normalized.playback.romanization) ? normalized.playback.romanization : 'off'
  for (const [key, fallback] of Object.entries({ preferSimplifiedChinese: true, segmentLyrics: false, showProfanity: false })) {
    normalized.playback[key] = typeof normalized.playback[key] === 'boolean' ? normalized.playback[key] : fallback
  }
  normalized.playback.quality = ['128', '320', 'flac', 'high'].includes(normalized.playback.quality) ? normalized.playback.quality : '128'
  if (!isPlainObject(normalized.download)) normalized.download = cloneDeep(defaultsCache.download)
  normalized.download.offlinePlaylistCacheEnabled = typeof normalized.download.offlinePlaylistCacheEnabled === 'boolean' ? normalized.download.offlinePlaylistCacheEnabled : true
  normalized.download.cacheSizeIndex = Number.isInteger(normalized.download.cacheSizeIndex) && normalized.download.cacheSizeIndex >= 0 && normalized.download.cacheSizeIndex <= 5 ? normalized.download.cacheSizeIndex : 0
  normalized.download.concurrentDownloads = Number.isInteger(normalized.download.concurrentDownloads) ? Math.min(10, Math.max(1, normalized.download.concurrentDownloads)) : 3
  const offlineCachePath = normalized.download.offlineCachePath
  normalized.download.offlineCachePath = typeof offlineCachePath === 'string' && path.isAbsolute(offlineCachePath) && !offlineCachePath.includes('\0') ? path.resolve(offlineCachePath) : ''
  normalized.desktopLyrics = normalizeDesktopLyrics(desktop)
  normalized.islandLyrics = normalizeIslandLyrics(normalized.islandLyrics)
  if (!isPlainObject(normalized.software)) normalized.software = cloneDeep(defaultsCache.software)
  const updates = isPlainObject(normalized.software.updates) ? normalized.software.updates : {}
  normalized.software.updates = {
    autoCheck: typeof updates.autoCheck === 'boolean' ? updates.autoCheck : true,
    autoDownload: typeof updates.autoDownload === 'boolean' ? updates.autoDownload : false,
    channel: ['stable', 'beta'].includes(updates.channel) ? updates.channel : 'stable'
  }
  return normalized
}

function notifyListeners() {
  const snapshot = cloneDeep(settingsCache)
  listeners.forEach((listener) => {
    try {
      listener(snapshot)
    } catch (err) {
      logger.error('settingsStore', 'listener error', err)
    }
  })
}

async function readSettingsFromDisk() {
  try {
    const raw = await fsp.readFile(settingsFilePath, 'utf8')
    return JSON.parse(raw)
  } catch (err) {
    if (err.code !== 'ENOENT') {
      logger.warn('settingsStore', '读取设置文件失败，将使用默认值', err)
      if (err instanceof SyntaxError) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
        const backupPath = settingsFilePath.replace(/\.json$/i, `.corrupt-${timestamp}.json`)
        try {
          await fsp.rename(settingsFilePath, backupPath)
          logger.warn('settingsStore', `损坏的设置已备份到 ${backupPath}`)
        } catch (backupError) {
          logger.warn('settingsStore', '备份损坏设置失败', backupError)
        }
      }
    }
    return null
  }
}

/** 临时文件原子替换正式设置；失败时清理本次临时文件并保留原文件。 */
async function writeSettingsToDisk(settings) {
  const data = JSON.stringify(settings, null, 2)
  const temporaryPath = `${settingsFilePath}.${process.pid}.tmp`
  try {
    await fsp.writeFile(temporaryPath, data, 'utf8')
    await fsp.rename(temporaryPath, settingsFilePath)
  } catch (error) {
    try {
      await fsp.unlink(temporaryPath)
    } catch (cleanupError) {
      if (cleanupError.code !== 'ENOENT') {
        logger.warn('settingsStore', '清理设置临时文件失败', cleanupError)
      }
    }
    throw error
  }
}

function createDefaults(app) {
  const downloadsDir = app.getPath('downloads')
  const userDataDir = app.getPath('userData')
  const cacheDir = path.join(userDataDir, 'Cache')

  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    playback: {
      fullscreenLyrics: true,
      enqueueFullPlaylist: true,
      restartOnPreviousNearEnd: false,
      showTranslation: true,
      lyricLibrary: { enabled: true, autoSave: true, minMatch: 'high', autoUpdate: true },
      romanization: 'off',
      preferSimplifiedChinese: true,
      segmentLyrics: false,
      showProfanity: false,
      quality: '128'
    },
    desktopLyrics: { ...desktopLyricDefaults },
    islandLyrics: normalizeIslandLyrics(),
    download: {
      offlinePlaylistCacheEnabled: true,
      offlineCachePath: '',
      downloadPath: path.join(downloadsDir, 'BetterKugou'),
      cachePath: cacheDir,
      cacheSizeIndex: 0,
      concurrentDownloads: 3
    },
    custom: {
      playerStyle: 'default',
      theme: 'dark',
      themePackages: [],
      customTheme: {
        primary: '#667eea',
        hover: '#764ba2',
        background: '#1f1f1f'
      }
    },
    software: {
      autoLaunch: false,
      updates: { autoCheck: true, autoDownload: false, channel: 'stable' },
      restorePlaylist: true,
      restorePlaybackState: true,
      defaultPage: 'home',
      minimizeToTray: false
    },
    session: {
      playlist: [],
      playlistIndex: 0,
      currentSong: null,
      playbackState: {
        isPlaying: false,
        currentTime: 0,
        duration: 0,
        volume: 80,
        playMode: 'loop'
      }
    }
  }
}

async function initSettingsStore(app) {
  if (initPromise) return initPromise
  initPromise = (async () => {
    appRef = app
    const userDataDir = app.getPath('userData')
    settingsFilePath = path.join(userDataDir, 'settings.json')
    defaultsCache = createDefaults(app)

    let stored = await readSettingsFromDisk()
    if (!stored) {
      stored = cloneDeep(defaultsCache)
      await writeSettingsToDisk(stored)
    }

    const initialized = ensureSchema(stored)

    if (!initialized.software) {
      initialized.software = {}
    }

    if (isAutoLaunchSupported()) {
      try {
        const applied = setAutoLaunchEnabled(app, Boolean(initialized.software.autoLaunch))
        initialized.software.autoLaunch = applied
      } catch (err) {
        logger.warn('settingsStore', '初始化自启设置失败，将以系统实际状态为准', err)
        try {
          const actual = getAutoLaunchEnabled(app)
          initialized.software.autoLaunch = actual
        } catch (readErr) {
          logger.warn('settingsStore', '读取系统自启状态失败，默认关闭', readErr)
          initialized.software.autoLaunch = false
        }
      }
    } else {
      initialized.software.autoLaunch = false
    }

    // 如果 ensureSchema 增补了字段或修正了自启状态，写回磁盘
    await writeSettingsToDisk(initialized)
    settingsCache = initialized

    return settingsCache
  })()
  return initPromise
}

function getSettings() {
  if (!settingsCache) {
    throw new Error('Settings store not initialized')
  }
  return cloneDeep(settingsCache)
}

/** 按调用顺序执行整个设置事务，成功落盘后才发布缓存和通知。 */
async function setSettings(nextSettings, { merge = true } = {}) {
  if (!settingsCache) {
    throw new Error('Settings store not initialized')
  }
  if (!isPlainObject(nextSettings)) {
    throw new TypeError('Settings payload must be an object')
  }
  assertSafeKeys(nextSettings)
  const payload = cloneDeep(nextSettings)
  const task = commitQueue.then(() => commitSettings(payload, merge))
  // 调用者仍能收到本次失败，后续事务继续使用最后一次成功的缓存。
  commitQueue = task.catch(() => {})
  return task
}

/** 队列内读取已提交状态，协调系统自启设置与磁盘提交，失败时保留旧缓存。 */
async function commitSettings(nextSettings, merge) {
  let updated
  if (merge) {
    updated = mergeDeep(settingsCache, nextSettings)
  } else {
    updated = cloneDeep(nextSettings)
  }
  updated = ensureSchema(updated)
  // 路径只能在迁移已校验后提交；旧草稿、重置和导入不能绕过文件迁移。
  updated.download.offlineCachePath = settingsCache.download.offlineCachePath
  if (!updated.software) {
    updated.software = {}
  }

  const requestedAutoLaunch = Boolean(updated.software.autoLaunch)
  let autoLaunchError = null

  if (!isAutoLaunchSupported()) {
    if (requestedAutoLaunch) {
      updated.software.autoLaunch = false
      autoLaunchError = new Error('AUTO_LAUNCH_UNSUPPORTED')
      autoLaunchError.code = 'AUTO_LAUNCH_UNSUPPORTED'
    }
  } else if (appRef) {
    try {
      const applied = setAutoLaunchEnabled(appRef, requestedAutoLaunch)
      updated.software.autoLaunch = applied
    } catch (err) {
      autoLaunchError = err
      try {
        const actual = getAutoLaunchEnabled(appRef)
        updated.software.autoLaunch = actual
      } catch (readErr) {
        updated.software.autoLaunch = false
        if (!autoLaunchError.code) {
          autoLaunchError.code = 'AUTO_LAUNCH_WRITE_FAILED'
        }
        autoLaunchError.cause = autoLaunchError.cause || readErr
        autoLaunchError.details = { readError: readErr }
      }
    }
  }

  try {
    await writeSettingsToDisk(updated)
  } catch (error) {
    if (isAutoLaunchSupported() && appRef && updated.software.autoLaunch !== settingsCache.software.autoLaunch) {
      try {
        setAutoLaunchEnabled(appRef, Boolean(settingsCache.software.autoLaunch))
      } catch (rollbackError) {
        logger.warn('settingsStore', '设置写入失败后恢复系统自启状态失败', rollbackError)
      }
    }
    throw error
  }
  settingsCache = updated
  notifyListeners()

  if (autoLaunchError) {
    throw autoLaunchError
  }

  return getSettings()
}

function onSettingsChange(listener) {
  if (typeof listener !== 'function') return () => {}
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** 迁移专用事务：只提交已验证的缓存目录，避免自启等无关系统副作用。 */
function setOfflineCacheDirectory(directory) {
  if (!settingsCache) return Promise.reject(new Error('Settings store not initialized'))
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || directory.includes('\0')) {
    return Promise.reject(new TypeError('缓存目录必须是绝对路径'))
  }
  const task = commitQueue.then(async () => {
    const updated = cloneDeep(settingsCache)
    updated.download.offlineCachePath = path.resolve(directory)
    // Windows 索引或扫描可能短暂占用设置文件；保持原子替换并只重试占用错误。
    for (let attempt = 0; ; attempt++) {
      try { await writeSettingsToDisk(updated); break } catch (error) {
        if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 4) throw error
        await new Promise(resolve => setTimeout(resolve, 50 * 2 ** attempt))
      }
    }
    settingsCache = updated
    notifyListeners()
    return getSettings()
  })
  commitQueue = task.catch(() => {})
  return task
}

function getSettingsFilePath() {
  return settingsFilePath
}

function getDefaultSettings() {
  if (!defaultsCache) {
    throw new Error('Settings store not initialized')
  }
  return cloneDeep(defaultsCache)
}

function getDefaultPaths() {
  if (!defaultsCache) {
    throw new Error('Settings store not initialized')
  }
  return {
    downloadPath: defaultsCache.download.downloadPath,
    cachePath: defaultsCache.download.cachePath
  }
}

async function overwriteSettings(newSettings) {
  return setSettings(newSettings, { merge: false })
}

async function exportSettings(targetPath) {
  if (!targetPath) {
    throw new Error('targetPath is required for export')
  }
  const data = JSON.stringify(getSettings(), null, 2)
  await fsp.writeFile(targetPath, data, 'utf8')
  return targetPath
}

async function importSettings(sourcePath) {
  const raw = await fsp.readFile(sourcePath, 'utf8')
  const parsed = JSON.parse(raw)
  await overwriteSettings(parsed)
  return getSettings()
}

async function ensureCacheDirectory() {
  if (!settingsCache) return
  const cacheDir = settingsCache.download?.cachePath
  if (!cacheDir) return
  try {
    await fsp.mkdir(cacheDir, { recursive: true })
  } catch (err) {
    logger.warn('settingsStore', '创建缓存目录失败', err)
  }
}

module.exports = {
  CURRENT_SCHEMA_VERSION,
  normalizeDesktopLyrics,
  initSettingsStore,
  getSettings,
  setSettings,
  setOfflineCacheDirectory,
  overwriteSettings,
  onSettingsChange,
  getSettingsFilePath,
  getDefaultSettings,
  getDefaultPaths,
  exportSettings,
  importSettings,
  ensureCacheDirectory
}
