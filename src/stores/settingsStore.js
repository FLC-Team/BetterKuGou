import { reactive, computed } from 'vue'
import { cloneDeep, mergeDeep, replaceReactive } from '../utils/objectUtils.js'
import { applyTheme } from '../utils/themeManager.js'
import { logger } from '../utils/logger.js'

const LOCAL_STORAGE_KEY = 'betterkugou_settings'
const CURRENT_SCHEMA_VERSION = 1

const baseDefaultSettings = Object.freeze({
  schemaVersion: CURRENT_SCHEMA_VERSION,
  playback: {
    fullscreenLyrics: true,
    enqueueFullPlaylist: true,
    showTranslation: true, // 默认显示翻译
    quality: '128'
  },
  desktopLyrics: {
    fontSize: 'medium',
    theme: 'classic',
    locked: false
  },
  download: {
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
  normalized.playback.quality = ['128', '320', 'flac', 'high'].includes(normalized.playback.quality) ? normalized.playback.quality : '128'
  normalized.desktopLyrics = {
    fontSize: ['small', 'medium', 'large'].includes(desktop.fontSize) ? desktop.fontSize : 'medium',
    theme: ['classic', 'gradient', 'minimal'].includes(desktop.theme) ? desktop.theme : 'classic',
    locked: typeof desktop.locked === 'boolean' ? desktop.locked : false
  }
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
