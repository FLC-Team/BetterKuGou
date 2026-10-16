const { Worker: NodeWorker } = require('node:worker_threads')
const defaultLogger = require('../logger')

const INITIAL_CHECK_DELAY = 10_000
const CHECK_INTERVAL = 24 * 60 * 60 * 1000
const STOP_TIMEOUT = 2000

function copy(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value))
}

function updateError(error, fallback = 'UPDATE_FAILED') {
  return { code: error?.code || fallback, message: error?.message || '更新操作失败，请重试。' }
}

/** Only presentation metadata crosses the renderer bridge; URLs and local paths stay private. */
function publicRelease(release) {
  if (!release) return null
  return {
    id: release.id,
    version: release.version,
    tag: release.tag,
    name: release.name,
    notes: release.notes,
    publishedAt: release.publishedAt,
    defaultAssetId: release.defaultAssetId ?? null,
    assets: (release.assets || []).map(asset => ({
      id: asset.id, name: asset.name, size: asset.size, format: asset.format
    }))
  }
}

/** Own one background worker and committed update preferences without performing installation. */
function createUpdateService({
  workerPath,
  downloadRoot,
  currentVersion,
  platform = process.platform,
  arch = process.arch,
  onState = () => {},
  logger = defaultLogger,
  Worker = NodeWorker
}) {
  let preferences = { autoCheck: true, autoDownload: false, channel: 'stable' }
  let configured = false
  let worker = null
  let task = null
  let nextId = 0
  let checkTimer = null
  let stopped = false
  let stopPromise = null
  let candidate = null
  let downloadedFile = null
  const cancelledVersions = new Set()
  let state = {
    revision: 0,
    status: 'idle',
    currentVersion,
    channel: 'stable',
    release: null,
    selectedAssetId: null,
    progress: null,
    downloaded: null,
    source: null,
    checkedAt: null,
    error: null,
    message: '尚未检查更新'
  }

  function getState() { return copy(state) }

  function publish(patch) {
    if (stopped) return getState()
    state = { ...state, ...patch, revision: state.revision + 1 }
    try { onState(getState()) } catch (error) {
      logger.error('updateService', '更新状态通知失败', error)
    }
    return getState()
  }

  function clearCheckTimer() {
    if (checkTimer) clearTimeout(checkTimer)
    checkTimer = null
  }

  function scheduleCheck(delay) {
    clearCheckTimer()
    if (!preferences.autoCheck || stopped) return
    checkTimer = setTimeout(() => {
      checkTimer = null
      if (stopped || !preferences.autoCheck) return
      startCheck('automatic')
      scheduleCheck(CHECK_INTERVAL)
    }, delay)
    checkTimer.unref?.()
  }

  function failTask(error, fallback) {
    const previous = task
    task = null
    const normalized = updateError(error, fallback)
    if (previous?.action === 'verify') downloadedFile = null
    publish({
      status: 'error', progress: null, error: normalized,
      downloaded: downloadedFile ? state.downloaded : null,
      message: normalized.message
    })
    previous?.reject?.(Object.assign(new Error(normalized.message), { code: normalized.code }))
    logger.warn('updateService', '更新任务失败', { action: previous?.action, ...normalized })
  }

  /** Worker identity checks isolate late errors or messages from a subsequently rebuilt worker. */
  function ensureWorker() {
    if (worker) return worker
    const instance = new Worker(workerPath, { workerData: { downloadRoot } })
    worker = instance
    instance.on('message', message => {
      if (worker === instance && !stopped) handleMessage(message)
    })
    instance.on('error', error => {
      if (worker !== instance || stopped) return
      worker = null
      failTask(error, 'UPDATE_WORKER_FAILED')
      try {
        Promise.resolve(instance.terminate()).catch(terminationError => {
          logger.warn('updateService', '结束异常更新线程失败', terminationError)
        })
      } catch (terminationError) {
        logger.warn('updateService', '结束异常更新线程失败', terminationError)
      }
    })
    instance.on('exit', code => {
      if (worker !== instance || stopped) return
      worker = null
      failTask({ code: 'UPDATE_WORKER_EXIT', message: `更新线程已退出（${code}），请重试。` })
    })
    return instance
  }

  function sendTask(action, payload, origin, callbacks = {}) {
    const pending = { id: ++nextId, action, origin, ...callbacks }
    task = pending
    try {
      ensureWorker().postMessage({ id: pending.id, action, ...payload })
    } catch (error) {
      failTask(error, 'UPDATE_WORKER_FAILED')
    }
    return pending
  }

  /** Invalidate immediately; the worker serializes the next command after cancelled IO closes. */
  function invalidateTask() {
    const previous = task
    task = null
    if (!previous) return
    previous.reject?.(Object.assign(new Error('更新操作已取消'), { code: 'CANCELLED' }))
    if (worker) {
      try { worker.postMessage({ id: ++nextId, action: 'cancel', targetId: previous.id }) } catch (error) {
        logger.warn('updateService', '取消更新任务失败', error)
      }
    }
  }

  function canAutoDownload() {
    return preferences.autoDownload && candidate?.defaultAssetId != null
      && !cancelledVersions.has(candidate.version) && !downloadedFile && !task && !stopped
  }

  function handleMessage(message) {
    if (!message || !task || message.id !== task.id) return
    if (message.type === 'progress' && task.action === 'download') {
      const progress = message.progress || {}
      publish({
        progress: {
          received: Number.isFinite(progress.received) ? progress.received : 0,
          total: Number.isFinite(progress.total) ? progress.total : 0,
          percent: Number.isFinite(progress.percent) ? Math.max(0, Math.min(100, progress.percent)) : null,
          source: progress.source === 'github' ? 'github' : 'proxy'
        },
        source: progress.source === 'github' ? 'github' : 'proxy'
      })
      return
    }
    if (message.type === 'error') {
      failTask(message.error)
      return
    }
    if (message.type !== 'result') return
    const completed = task
    task = null
    const result = message.result || {}
    if (completed.action === 'check') {
      const previousVersion = downloadedFile?.version
      candidate = result.release || null
      if (!candidate || previousVersion !== candidate.version) downloadedFile = null
      let selectedAssetId = candidate?.defaultAssetId ?? null
      if (downloadedFile && candidate.assets?.some(asset => asset.id === downloadedFile.assetId)) {
        selectedAssetId = downloadedFile.assetId
      } else if (downloadedFile) {
        downloadedFile = null
      }
      publish({
        status: downloadedFile ? 'downloaded' : candidate ? 'available' : 'upToDate',
        release: publicRelease(candidate), selectedAssetId, progress: null,
        downloaded: downloadedFile ? { name: downloadedFile.assetName, version: downloadedFile.version, format: downloadedFile.format } : null,
        source: result.source || null, checkedAt: result.checkedAt || null, error: null,
        message: downloadedFile ? '更新包已下载，请手动安装。'
          : candidate ? selectedAssetId == null ? `发现新版本 ${candidate.version}，暂无适合当前系统的安装包。` : `发现新版本 ${candidate.version}`
            : result.hasReleases ? '当前已是所选渠道的最新版本。' : '所选渠道暂无已发布版本。'
      })
      if (canAutoDownload()) startDownload(candidate.defaultAssetId, 'automatic')
    } else if (completed.action === 'download') {
      downloadedFile = copy(result)
      publish({
        status: 'downloaded', selectedAssetId: result.assetId, progress: null,
        downloaded: { name: result.assetName, version: result.version, format: result.format },
        source: result.source || state.source, error: null,
        message: '更新包已下载，请手动安装。'
      })
    } else if (completed.action === 'verify') {
      downloadedFile = copy(result)
      publish({ status: 'downloaded', error: null, message: '更新包已验证，请手动安装。' })
      completed.resolve(copy(downloadedFile))
    }
  }

  function startCheck(origin) {
    if (stopped || task) return getState()
    publish({ status: 'checking', progress: null, error: null, message: '正在检查更新…' })
    sendTask('check', { currentVersion, channel: preferences.channel, platform, arch }, origin)
    return getState()
  }

  function startDownload(assetId, origin) {
    if (stopped || task) return getState()
    const chosenId = assetId ?? state.selectedAssetId ?? candidate?.defaultAssetId
    const asset = (typeof chosenId === 'string' || typeof chosenId === 'number')
      ? candidate?.assets?.find(item => String(item.id) === String(chosenId)) : null
    if (!candidate || !asset) {
      return publish({
        status: 'error', error: { code: 'UPDATE_NO_ASSET', message: '请选择当前系统可用的更新包。' },
        message: '请选择当前系统可用的更新包。'
      })
    }
    if (downloadedFile?.version === candidate.version && downloadedFile.assetId === asset.id) return getState()
    downloadedFile = null
    publish({
      status: 'downloading', selectedAssetId: asset.id, downloaded: null,
      progress: { received: 0, total: asset.size || 0, percent: 0, source: 'proxy' },
      error: null, message: '正在下载更新包…'
    })
    sendTask('download', { release: copy(candidate), asset: copy(asset) }, origin)
    return getState()
  }

  /** Apply only persisted preferences; unrelated settings broadcasts keep the existing schedule. */
  function configure(options = {}) {
    if (stopped) return getState()
    const next = {
      autoCheck: typeof options.autoCheck === 'boolean' ? options.autoCheck : true,
      autoDownload: typeof options.autoDownload === 'boolean' ? options.autoDownload : false,
      channel: options.channel === 'beta' ? 'beta' : 'stable'
    }
    const first = !configured
    const channelChanged = preferences.channel !== next.channel
    const autoCheckChanged = preferences.autoCheck !== next.autoCheck
    const disabledAutoDownload = preferences.autoDownload && !next.autoDownload
    const enabledAutoDownload = !preferences.autoDownload && next.autoDownload
    preferences = next
    configured = true
    if (channelChanged) {
      invalidateTask()
      candidate = null
      downloadedFile = null
      publish({
        status: 'idle', channel: next.channel, release: null, selectedAssetId: null,
        downloaded: null, progress: null, error: null, source: null, checkedAt: null,
        message: '已切换更新渠道'
      })
      if (!first) startCheck('configuration')
      scheduleCheck(first ? INITIAL_CHECK_DELAY : CHECK_INTERVAL)
    } else {
      if (autoCheckChanged && !next.autoCheck && task?.action === 'check' && task.origin === 'automatic') {
        invalidateTask()
        publish({
          status: downloadedFile ? 'downloaded' : candidate ? 'available' : 'idle',
          progress: null, error: null, message: '已关闭自动检查，可手动检查更新。'
        })
      }
      if (disabledAutoDownload && task?.action === 'download' && task.origin === 'automatic') {
        invalidateTask()
        publish({ status: 'available', progress: null, error: null, message: '已关闭自动下载，可手动下载更新包。' })
      }
      if (first || autoCheckChanged) scheduleCheck(INITIAL_CHECK_DELAY)
      if (enabledAutoDownload && canAutoDownload()) startDownload(candidate.defaultAssetId, 'automatic')
    }
    return getState()
  }

  function cancel() {
    if (stopped || !task) return getState()
    if (task.action === 'download' && candidate) cancelledVersions.add(candidate.version)
    invalidateTask()
    return publish({
      status: downloadedFile ? 'downloaded' : candidate ? 'available' : 'idle',
      progress: null, error: null, message: '已取消更新操作，可稍后手动重试。'
    })
  }

  /** Revalidate the private file in the worker before main opens or reveals it. */
  function getDownloadedFile() {
    if (stopped) return Promise.reject(Object.assign(new Error('更新服务已停止'), { code: 'UPDATE_STOPPED' }))
    if (!downloadedFile) return Promise.reject(Object.assign(new Error('请先下载更新包。'), { code: 'UPDATE_NOT_DOWNLOADED' }))
    if (task?.action === 'verify') return task.promise
    if (task?.action === 'download') return Promise.reject(Object.assign(new Error('更新包正在下载。'), { code: 'UPDATE_BUSY' }))
    if (task) invalidateTask()
    let resolveFile
    let rejectFile
    const promise = new Promise((resolve, reject) => { resolveFile = resolve; rejectFile = reject })
    sendTask('verify', { file: copy(downloadedFile) }, 'manual', { resolve: resolveFile, reject: rejectFile, promise })
    return promise
  }

  /** Cancel work and wait briefly for IO cleanup; unresponsive workers are terminated. */
  function stop() {
    if (stopPromise) return stopPromise
    stopped = true
    clearCheckTimer()
    const previous = task
    task = null
    previous?.reject?.(Object.assign(new Error('更新服务已停止'), { code: 'UPDATE_STOPPED' }))
    const instance = worker
    if (!instance) {
      stopPromise = Promise.resolve()
      return stopPromise
    }
    stopPromise = new Promise(resolve => {
      let timeout
      let finished = false
      const finish = () => {
        if (finished) return
        finished = true
        if (timeout) clearTimeout(timeout)
        instance.removeListener('exit', finish)
        if (worker === instance) worker = null
        resolve()
      }
      const terminate = () => {
        try {
          Promise.resolve(instance.terminate()).then(finish, error => {
            logger.warn('updateService', '强制结束更新线程失败', error)
            finish()
          })
        } catch (error) {
          logger.warn('updateService', '强制结束更新线程失败', error)
          finish()
        }
      }
      instance.once('exit', finish)
      timeout = setTimeout(terminate, STOP_TIMEOUT)
      try { instance.postMessage({ id: ++nextId, action: 'stop' }) } catch (error) {
        logger.warn('updateService', '通知更新线程停止失败', error)
        terminate()
      }
    })
    return stopPromise
  }

  return {
    configure, getState, check: () => startCheck('manual'),
    download: assetId => startDownload(assetId, 'manual'), cancel, getDownloadedFile, stop
  }
}

module.exports = { createUpdateService, INITIAL_CHECK_DELAY, CHECK_INTERVAL, STOP_TIMEOUT }
