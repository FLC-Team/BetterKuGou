import { reactive, computed } from 'vue'
import { cloneDeep, mergeDeep, replaceReactive } from '../utils/objectUtils.js'
import { applyTheme } from '../utils/themeManager.js'
import { logger } from '../utils/logger.js'

const LOCAL_STORAGE_KEY = 'betterkugou_settings'
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

const baseDefaultSettings = Object.freeze({
  schemaVersion: CURRENT_SCHEMA_VERSION,
  playback: {
    fullscreenLyrics: true,
    enqueueFullPlaylist: true,
    restartOnPreviousNearEnd: false,
    showTranslation: true, // 默认显示翻译
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
    downloadPath: '',
    cachePath: '',
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
  shortcuts: {
    enableGlobal: false,
    keys: {
      playPause: 'Space',
      nextTrack: 'Control+Right',
      prevTrack: 'Control+Left',
      volumeUp: 'Control+Up',
      volumeDown: 'Control+Down',
      toggleLyrics: 'L',
      toggleFullscreen: 'F',
      bossKey: 'Control+Alt+H'
    }
  },
  software: {
    autoLaunch: false,
    updates: { autoCheck: true, autoDownload: false, channel: 'stable' },
    minimizeToTray: false,
    restorePlaylist: true,
    restorePlaybackState: true,
    defaultPage: 'home'
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
})

const state = reactive({
  settings: reactive(cloneDeep(baseDefaultSettings)),
  ready: false,
  loading: false,
  error: null,
  revision: 0
})

const bridge = typeof window !== 'undefined' ? window.settingsAPI : null

let initPromise = null
let defaultSnapshot = cloneDeep(baseDefaultSettings)
let unsubscribeExternalListener = null
let committedSnapshot = cloneDeep(baseDefaultSettings)
let persistQueue = Promise.resolve()
let mutationVersion = 0
let persistedVersion = -1
let pendingMutations = []
let writeInFlight = false
let bufferedExternalSettings = null

async function fetchDefaultPaths() {
  if (bridge?.getDefaultPaths) {
    try {
      return (await bridge.getDefaultPaths()) ?? null
    } catch (err) {
      logger.warn('settingsStore', '获取默认路径失败', err)
    }
  }
  // 浏览器预览无法确定本机目录，保留空值；桌面端由主进程提供路径。
  return null
}

async function resolvePathDefaults(settings, paths) {
  const resolved = cloneDeep(settings)
  const defaults = paths === undefined ? await fetchDefaultPaths() : paths
  if (defaults?.downloadPath) {
    resolved.download.downloadPath = defaults.downloadPath
  }
  if (defaults?.cachePath) {
    resolved.download.cachePath = defaults.cachePath
  }
  return resolved
}

function applySettings(newSettings, { notify = true } = {}) {
  replaceReactive(state.settings, newSettings)
  applyTheme(state.settings)
  if (notify) {
    state.revision += 1
  }
}

async function fetchDefaultSettings() {
  if (!bridge?.getDefaults) return cloneDeep(baseDefaultSettings)
  try {
    const defaults = await bridge.getDefaults()
    if (defaults && typeof defaults === 'object') {
      return mergeDeep(cloneDeep(baseDefaultSettings), defaults)
    }
  } catch (err) {
    logger.warn('settingsStore', '获取主进程默认设置失败', err)
  }
  return cloneDeep(baseDefaultSettings)
}

async function loadFromBridge() {
  if (!bridge?.get) return null
  try {
    const remoteSettings = await bridge.get()
    if (remoteSettings && typeof remoteSettings === 'object') {
      return remoteSettings
    }
  } catch (err) {
    logger.warn('settingsStore', '读取主进程设置失败', err)
  }
  return null
}

function loadFromLocalStorage() {
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') {
      return parsed
    }
  } catch (err) {
    logger.warn('settingsStore', '解析本地设置失败', err)
  }
  return null
}

/** 将未提交的编辑重放到主进程快照，避免广播或失败回滚覆盖后续修改。 */
function applyCommittedSettings(snapshot) {
  committedSnapshot = cloneDeep(snapshot)
  let next = cloneDeep(snapshot)
  for (const mutation of pendingMutations) {
    next = mutation.merge ? mergeDeep(next, mutation.patch) : cloneDeep(mutation.patch)
  }
  applySettings(next)
}

/** 串行持久化并在执行时取最新快照；较早的自身广播不能回退乐观状态。 */
function persistSettings() {
  const requestedVersion = mutationVersion
  const task = persistQueue.then(async () => {
    if (requestedVersion <= persistedVersion) return
    const sentVersion = mutationVersion
    const payload = cloneDeep(state.settings)
    writeInFlight = true
    bufferedExternalSettings = null
    state.error = null
    try {
      let result
      if (bridge?.set) {
        result = await bridge.set(payload)
      } else {
        localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(payload))
      }
      const remote = bufferedExternalSettings || (result && typeof result === 'object' ? result : payload)
      pendingMutations = pendingMutations.filter(mutation => mutation.version > sentVersion)
      persistedVersion = sentVersion
      applyCommittedSettings(migrateSettings(remote, defaultSnapshot))
    } catch (err) {
      logger.warn('settingsStore', '持久化设置失败', err)
      state.error = {
        source: 'persist',
        code: err?.code || 'UNKNOWN',
        message: err?.message || '保存设置失败'
      }
      let latest = committedSnapshot
      if (bridge?.get) {
        try {
          const remote = await bridge.get()
          if (remote && typeof remote === 'object') latest = migrateSettings(remote, defaultSnapshot)
        } catch (fetchErr) {
          logger.warn('settingsStore', '读取回滚快照失败，使用最近提交的设置', fetchErr)
          latest = committedSnapshot
        }
      }
      // 失败只撤销本次调用及其之前的编辑，后续调用仍会排队保存。
      pendingMutations = pendingMutations.filter(mutation => mutation.version > requestedVersion)
      applyCommittedSettings(bufferedExternalSettings || latest)
      throw err
    } finally {
      writeInFlight = false
      bufferedExternalSettings = null
    }
  })
  // 本次调用者仍可捕获失败，后续提交不会因前一次失败停止。
  persistQueue = task.catch(() => {})
  return task
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

function migrateSettings(rawSettings, defaults) {
  if (!rawSettings || typeof rawSettings !== 'object') {
    return cloneDeep(defaults)
  }
  const version = rawSettings.schemaVersion ?? 0
  let migrated = cloneDeep(rawSettings)

  if (version < 1) {
    migrated.schemaVersion = CURRENT_SCHEMA_VERSION
    migrated = mergeDeep(cloneDeep(defaults), migrated)
  }

  const normalized = mergeDeep(cloneDeep(defaults), migrated)
  const desktop = normalized.desktopLyrics || {}
  if (!normalized.playback || typeof normalized.playback !== 'object' || Array.isArray(normalized.playback)) normalized.playback = cloneDeep(defaults.playback)
  normalized.playback.showTranslation = typeof normalized.playback.showTranslation === 'boolean' ? normalized.playback.showTranslation : true
  normalized.playback.restartOnPreviousNearEnd = normalized.playback.restartOnPreviousNearEnd === true
  const library = normalized.playback.lyricLibrary && typeof normalized.playback.lyricLibrary === 'object' && !Array.isArray(normalized.playback.lyricLibrary) ? normalized.playback.lyricLibrary : {}
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
  if (!normalized.download || typeof normalized.download !== 'object' || Array.isArray(normalized.download)) normalized.download = cloneDeep(defaults.download)
  normalized.download.offlinePlaylistCacheEnabled = typeof normalized.download.offlinePlaylistCacheEnabled === 'boolean' ? normalized.download.offlinePlaylistCacheEnabled : true
  normalized.download.cacheSizeIndex = Number.isInteger(normalized.download.cacheSizeIndex) && normalized.download.cacheSizeIndex >= 0 && normalized.download.cacheSizeIndex <= 5 ? normalized.download.cacheSizeIndex : 0
  normalized.download.concurrentDownloads = Number.isInteger(normalized.download.concurrentDownloads) ? Math.min(10, Math.max(1, normalized.download.concurrentDownloads)) : 3
  normalized.desktopLyrics = normalizeDesktopLyrics(desktop)
  normalized.islandLyrics = normalizeIslandLyrics(normalized.islandLyrics)
  if (!normalized.software || typeof normalized.software !== 'object' || Array.isArray(normalized.software)) normalized.software = cloneDeep(defaults.software)
  const updates = normalized.software.updates && typeof normalized.software.updates === 'object' && !Array.isArray(normalized.software.updates) ? normalized.software.updates : {}
  normalized.software.updates = {
    autoCheck: typeof updates.autoCheck === 'boolean' ? updates.autoCheck : true,
    autoDownload: typeof updates.autoDownload === 'boolean' ? updates.autoDownload : false,
    channel: ['stable', 'beta'].includes(updates.channel) ? updates.channel : 'stable'
  }
  return normalized
}

async function initSettings() {
  if (initPromise) return initPromise
  initPromise = (async () => {
    state.loading = true
    try {
      // 三个只读 IPC 互不依赖，避免首屏挂载前串行等待主进程往返。
      const [defaults, paths, remote] = await Promise.all([
        fetchDefaultSettings(),
        fetchDefaultPaths(),
        loadFromBridge()
      ])
      const defaultResolved = await resolvePathDefaults(defaults, paths)
      defaultSnapshot = cloneDeep(defaultResolved)

      const local = !remote ? loadFromLocalStorage() : null
      const base = remote ?? local ?? defaultResolved

      const migrated = migrateSettings(base, defaultResolved)
      committedSnapshot = cloneDeep(migrated)
      applySettings(migrated)

      if (!remote) {
        await persistSettings()
      }

      if (bridge?.onUpdate && !unsubscribeExternalListener) {
        unsubscribeExternalListener = bridge.onUpdate((payload) => {
          if (!payload || typeof payload !== 'object') return
          try {
            const migrated = migrateSettings(payload, defaultSnapshot)
            committedSnapshot = cloneDeep(migrated)
            if (writeInFlight) {
              bufferedExternalSettings = migrated
            } else {
              applyCommittedSettings(migrated)
            }
          } catch (error) {
            logger.warn('settingsStore', '应用外部设置更新失败', error)
          }
        })
      }
    } catch (err) {
      logger.error('settingsStore', '初始化失败', err)
      state.error = err
      const fallback = await resolvePathDefaults(baseDefaultSettings)
      applySettings(fallback, { persist: false })
    } finally {
      state.loading = false
      state.ready = true
    }
  })()
  return initPromise
}

async function updateSettings(patch, { merge = true, persist = true } = {}) {
  if (!patch || typeof patch !== 'object') return
  const cloned = cloneDeep(patch)
  if (merge) {
    mergeDeep(state.settings, cloned)
  } else {
    replaceReactive(state.settings, cloned)
  }
  mutationVersion += 1
  pendingMutations.push({ version: mutationVersion, patch: cloned, merge })
  applyTheme(state.settings)
  state.revision += 1
  if (persist) {
    await persistSettings()
  }
}

async function overwriteSettings(newSettings, options = {}) {
  await updateSettings(newSettings, { ...options, merge: false })
}

async function resetSettings() {
  const defaults = await resolvePathDefaults(baseDefaultSettings)
  await overwriteSettings(defaults)
}

async function exportSettingsToFile(targetPath) {
  if (!bridge?.export) {
    logger.warn('settingsStore', '当前环境不支持导出设置')
    return { canceled: true, reason: 'unsupported' }
  }
  try {
    return await bridge.export(targetPath)
  } catch (err) {
    logger.error('settingsStore', '导出设置失败', err)
    return { canceled: true, error: err }
  }
}

async function importSettingsFromFile() {
  if (!bridge?.import) {
    logger.warn('settingsStore', '当前环境不支持导入设置')
    return { canceled: true, reason: 'unsupported' }
  }
  try {
    const result = await bridge.import()
    if (result?.canceled) return result
    if (result?.settings) {
      await overwriteSettings(result.settings, { persist: true })
    }
    return result
  } catch (err) {
    logger.error('settingsStore', '导入设置失败', err)
    return { canceled: true, error: err }
  }
}

async function chooseDirectory(options = {}) {
  if (!bridge?.chooseDirectory) {
    logger.warn('settingsStore', '当前环境不支持目录选择')
    return { canceled: true, reason: 'unsupported' }
  }
  try {
    return await bridge.chooseDirectory(options)
  } catch (err) {
    logger.error('settingsStore', '选择目录失败', err)
    return { canceled: true, error: err }
  }
}

function getSessionSnapshot() {
  return cloneDeep(state.settings.session || baseDefaultSettings.session)
}

async function saveSessionSnapshot(partial) {
  if (!partial || typeof partial !== 'object') return
  const current = cloneDeep(state.settings.session || baseDefaultSettings.session)
  mergeDeep(current, partial)
  await updateSettings({ session: current })
}

async function resetSessionSnapshot() {
  await updateSettings({ session: cloneDeep(baseDefaultSettings.session) })
}

/** 等待所有已排队的设置写入；保存失败不能被队列的恢复分支隐藏。 */
async function flushPendingSettings() {
  let pending
  do {
    pending = persistQueue
    await pending
  } while (pending !== persistQueue)
  if (state.error?.source === 'persist') {
    const error = new Error(state.error.message)
    error.code = state.error.code
    throw error
  }
  if (pendingMutations.length) await persistSettings()
}

export function useSettingsStore() {
  return {
    settings: state.settings,
    ready: computed(() => state.ready),
    loading: computed(() => state.loading),
    error: computed(() => state.error),
    revision: computed(() => state.revision),
    defaults: () => cloneDeep(defaultSnapshot),
    initSettings,
    updateSettings,
    overwriteSettings,
    resetSettings,
    exportSettings: exportSettingsToFile,
    importSettings: importSettingsFromFile,
    chooseDirectory,
    getSessionSnapshot,
    saveSessionSnapshot,
    resetSessionSnapshot,
    flushPendingSettings
  }
}

export function getCurrentSettings() {
  return state.settings
}

export { initSettings }
