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
  normalized.desktopLyrics = {
    fontSize: ['small', 'medium', 'large'].includes(desktop.fontSize) ? desktop.fontSize : 'medium',
    theme: ['classic', 'gradient', 'minimal'].includes(desktop.theme) ? desktop.theme : 'classic',
    locked: typeof desktop.locked === 'boolean' ? desktop.locked : false
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
      showTranslation: true
    },
    desktopLyrics: {
      fontSize: 'medium',
      theme: 'classic',
      locked: false
    },
    download: {
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
  initSettingsStore,
  getSettings,
  setSettings,
  overwriteSettings,
  onSettingsChange,
  getSettingsFilePath,
  getDefaultSettings,
  getDefaultPaths,
  exportSettings,
  importSettings,
  ensureCacheDirectory
}
