const { Worker: NodeWorker } = require('node:worker_threads')
const path = require('node:path')
const { createMediaResponse } = require('./playlistCacheMedia')
const defaultLogger = require('../logger')

function copy(value) { return value == null ? value : JSON.parse(JSON.stringify(value)) }

/** Keep credentials and private file descriptors behind a generation-bound Worker bridge. */
function createPlaylistCacheService({ workerPath, cacheRoot, onState = () => {}, onAuthExpired = () => {}, logger = defaultLogger, Worker = NodeWorker }) {
  let worker = null
  let session = null
  let generation = 0
  let nextId = 0
  let settings = {}
  let stopped = false
  let stopPromise = null
  let closing = false
  let migrationTask = null
  let migrationGate = null
  let migrationStatus = null
  let migrationError = null
  let migrationWarning = null
  let cleanupRoot = null
  let cleanupTask = null
  const streams = new Set()
  cacheRoot = path.resolve(cacheRoot)
  let state = { revision: 0, generation: 0, userId: null, enabled: true, usedBytes: 0, limitBytes: 2 * 1024 ** 3, playlists: [], cacheDirectory: cacheRoot, migration: null }
  const pending = new Map()
  const resources = new Map()

  function getState() { return copy(state) }
  function emitState(snapshot = state) {
    state = { ...copy(snapshot), revision: state.revision + 1, cacheDirectory: cacheRoot,
      migration: copy(migrationStatus), migrationError: copy(migrationError), migrationWarning: copy(migrationWarning) }
    try { onState(getState()) } catch (error) {
      logger.warn('playlistCacheService', '离线缓存状态通知失败', { name: error?.name, code: error?.code })
    }
    return getState()
  }
  function publish(snapshot) {
    if (migrationGate && snapshot?.migration) migrationStatus = copy(snapshot.migration)
    if (stopped || snapshot?.generation !== generation || String(snapshot?.userId ?? '') !== String(session?.userId ?? '')) return getState()
    if (snapshot.migrationWarning) migrationWarning = copy(snapshot.migrationWarning)
    return emitState(snapshot)
  }

  function failWorker(instance) {
    if (instance !== worker) return
    worker = null
    for (const task of pending.values()) task.reject(Object.assign(new Error('缓存服务暂时不可用，请重试'), { code: 'CACHE_WORKER_FAILED' }))
    pending.clear()
    publish({ ...state, error: { code: 'CACHE_WORKER_FAILED', message: '缓存服务暂时不可用，请重试' } })
  }

  function ensureWorker() {
    if (worker) return worker
    const instance = new Worker(workerPath, { workerData: { cacheRoot, protectedFiles: [...resources.values()].map(item => item.resource) } })
    worker = instance
    instance.on('message', message => {
      if (instance !== worker || stopped) return
      if (message.type === 'state') { publish(message.state); return }
      if (message.type === 'authExpired') {
        if (message.generation === generation && message.userId === session?.userId) {
          try { onAuthExpired({ generation, userId: session.userId }) } catch (error) {
            logger.warn('playlistCacheService', '认证失效通知失败', { name: error?.name, code: error?.code })
          }
        }
        return
      }
      const task = pending.get(message.id)
      if (!task) return
      pending.delete(message.id)
      if (message.type === 'error') {
        task.reject(Object.assign(new Error(message.error?.message || '缓存操作失败'), { code: message.error?.code || 'CACHE_FAILED' }))
      } else if (message.type === 'result') task.resolve(message.result)
    })
    instance.on('error', error => {
      if (instance !== worker || stopped) return
      logger.error('playlistCacheService', '离线缓存线程异常', error)
      failWorker(instance)
      Promise.resolve(instance.terminate()).catch(() => logger.warn('playlistCacheService', '结束异常缓存线程失败'))
    })
    instance.on('exit', code => {
      if (stopped || instance !== worker) return
      logger.warn('playlistCacheService', '离线缓存线程意外退出', { exitCode: code })
      failWorker(instance)
    })
    // A replacement Worker inherits leases granted by its predecessor, including logged-out audio.
    instance.postMessage({ id: 0, action: 'bootstrap', generation, payload: { settings, session, leases: [...resources.values()].map(item => item.resource) } })
    return instance
  }

  function sendRpc(action, payload, taskGeneration = generation) {
    if (stopped) return Promise.reject(Object.assign(new Error('缓存服务已停止'), { code: 'CACHE_STOPPED' }))
    return new Promise((resolve, reject) => {
      const id = ++nextId
      pending.set(id, { resolve, reject })
      try { ensureWorker().postMessage({ id, action, generation: taskGeneration, payload }) } catch (error) {
        pending.delete(id)
        reject(error)
      }
    })
  }

  function rpc(action, payload, taskGeneration = generation) {
    if (closing) return Promise.reject(Object.assign(new Error('缓存服务已停止'), { code: 'CACHE_STOPPED' }))
    return migrationGate ? migrationGate.then(() => sendRpc(action, payload, taskGeneration)) : sendRpc(action, payload, taskGeneration)
  }

  function inside(root, file) {
    const relative = path.relative(root, file)
    return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
  }

  /** 新读流已使用新目录，只有迁移前打开的文件句柄需要延迟回收。 */
  function finishMigrationCleanup() {
    if (!cleanupRoot || cleanupTask || stopped || [...streams].some(stream => inside(cleanupRoot, stream.path))) return cleanupTask
    cleanupTask = sendRpc('finalizeMigration').then(result => {
      if (result?.migrationWarning) migrationWarning = copy(result.migrationWarning)
    }).catch(error => {
      migrationWarning = { code: 'CACHE_MIGRATION_CLEANUP', message: '缓存已迁移，旧目录的部分文件暂未清理，可在文件释放后重新更改位置重试。' }
      logger.warn('playlistCacheService', '迁移后清理旧缓存失败', { name: error?.name, code: error?.code })
    }).finally(() => {
      cleanupRoot = null
      cleanupTask = null
      migrationStatus = null
      if (!stopped) emitState()
    })
    return cleanupTask
  }

  /** 复制并校验→原子保存路径→切换租约；提交后异常只重建服务，绝不删除新缓存。 */
  function changeDirectory(targetRoot, persistDirectory) {
    if (closing || stopped) return Promise.reject(Object.assign(new Error('缓存服务已停止'), { code: 'CACHE_STOPPED' }))
    if (migrationGate || cleanupRoot) return Promise.reject(Object.assign(new Error('缓存目录正在迁移或等待旧文件释放，请稍候。'), { code: 'CACHE_MIGRATION_BUSY' }))
    if (typeof targetRoot !== 'string' || !path.isAbsolute(targetRoot) || targetRoot.includes('\0') || typeof persistDirectory !== 'function') {
      return Promise.reject(Object.assign(new Error('请选择有效的缓存文件夹。'), { code: 'CACHE_MIGRATION_PATH' }))
    }
    if (path.resolve(targetRoot) === cacheRoot) return Promise.resolve(getState())
    let unlock
    migrationGate = new Promise(resolve => { unlock = resolve })
    migrationStatus = { phase: 'copying', copiedBytes: 0, totalBytes: 0 }
    migrationError = null
    migrationWarning = null
    emitState()
    const sourceRoot = cacheRoot
    migrationTask = (async () => {
      let saved = false
      try {
        const prepared = await sendRpc('prepareMigration', { targetRoot })
        const destination = prepared.targetRoot
        if (!destination || !path.isAbsolute(destination)) throw new Error('缓存迁移未返回有效目录')
        migrationStatus = { ...migrationStatus, phase: 'committing' }
        emitState()
        await persistDirectory(destination)
        saved = true
        cacheRoot = destination
        for (const item of resources.values()) {
          if (inside(sourceRoot, item.resource.path)) item.resource.path = path.join(destination, path.relative(sourceRoot, item.resource.path))
        }
        try {
          publish(await sendRpc('commitMigration'))
          cleanupRoot = sourceRoot
          migrationStatus = { ...migrationStatus, phase: 'cleanup' }
          emitState()
          await finishMigrationCleanup()
        } catch (error) {
          // 磁盘路径已提交，目标完整；丢失 commit 回执时以目标重建并保留源副本。
          const failed = worker
          if (failed) {
            failWorker(failed)
            await failed.terminate().catch(() => {})
          }
          migrationWarning = { code: 'CACHE_MIGRATION_RECOVERED', message: '新缓存位置已保存；缓存服务已恢复，旧目录保留了一份副本。' }
          migrationStatus = null
          emitState({ ...state, error: null })
          publish(await sendRpc('getState'))
        }
        return getState()
      } catch (error) {
        if (!saved) {
          try { await sendRpc('rollbackMigration') } catch (rollbackError) {
            logger.warn('playlistCacheService', '恢复原缓存目录失败', { name: rollbackError?.name, code: rollbackError?.code })
          }
          migrationStatus = null
          migrationError = { code: error?.code?.startsWith('CACHE_MIGRATION_') ? error.code : 'CACHE_MIGRATION_FAILED',
            message: error?.code?.startsWith('CACHE_MIGRATION_') ? error.message : '迁移失败，原缓存位置和文件已保留，请检查空间及目录权限后重试。' }
          emitState()
          throw Object.assign(new Error(migrationError.message), { code: migrationError.code, cause: error })
        }
        migrationStatus = null
        migrationWarning = { code: 'CACHE_MIGRATION_RECOVERED', message: '新缓存位置已保存，缓存服务暂时不可用，请重试或重启应用；旧目录仍保留副本。' }
        return emitState()
      } finally {
        migrationGate = null
        migrationTask = null
        unlock()
      }
    })()
    return migrationTask
  }

  async function call(action, payload) {
    const identity = generation
    const result = await rpc(action, payload, identity)
    if (identity === generation && !stopped) return result
    // A source could have been acquired immediately before the account changed.
    if (result?.leaseId) rpc('releaseSource', { leaseId: result.leaseId }).catch(() => {})
    return null
  }

  function configure(value = {}) {
    settings = copy(value)
    return rpc('configure', settings).then(result => { publish(result); return getState() }).catch(() => {
      publish({ ...state, error: { code: 'CACHE_CONFIGURE_FAILED', message: '缓存设置暂时无法应用，请重试' } })
      return getState()
    })
  }

  async function setSession(value) {
    const next = value?.userId && value?.token ? { userId: String(value.userId), token: String(value.token) } : null
    if (next?.userId === session?.userId && next?.token === session?.token) return call('getState')
    session = next
    generation++
    publish({ ...state, generation, userId: next?.userId ?? null, playlists: [], cachedSongCount: 0, error: null })
    const result = await rpc('setSession', next)
    publish(result)
    return getState()
  }

  async function acquire(action, payload) {
    const result = await call(action, payload)
    if (!result?.leaseId || !result.path) return null
    resources.set(result.leaseId, { resource: result, active: 0, releasing: false })
    const { path, account, file, ...publicResult } = result
    return { ...publicResult, url: `bk-cache://media/${result.leaseId}` }
  }

  async function releaseSource(leaseId) {
    const item = resources.get(leaseId)
    if (!item) return false
    item.releasing = true
    if (item.active) return true
    resources.delete(leaseId)
    await rpc('releaseSource', { leaseId }).catch(() => {})
    return true
  }

  async function handleRequest(request) {
    let url
    try { url = new URL(request.url) } catch { return new Response(null, { status: 400 }) }
    if (url.protocol !== 'bk-cache:' || url.hostname !== 'media' || url.search || url.hash || !/^\/[a-f\d]{48}$/.test(url.pathname)) return new Response(null, { status: 404 })
    const leaseId = url.pathname.slice(1)
    const item = resources.get(leaseId)
    if (!item || item.releasing || stopped) return new Response(null, { status: 404 })
    const streaming = (request.method || 'GET') === 'GET'
    const stream = { path: item.resource.path }
    if (streaming) streams.add(stream)
    if (streaming) item.active++
    let finished = false
    const finish = () => {
      if (finished || !streaming) return
      finished = true
      item.active--
      streams.delete(stream)
      if (item.releasing && item.active === 0) releaseSource(leaseId).catch(() => {})
      finishMigrationCleanup()
    }
    try {
      const response = createMediaResponse(request, { ...item.resource, path: stream.path }, finish)
      if (response.status >= 400) finish()
      return response
    } catch { finish(); return new Response(null, { status: 500 }) }
  }

  /** Cancel network IO before allowing the application lifecycle to release the Worker. */
  function stop() {
    if (stopPromise) return stopPromise
    closing = true
    if (migrationTask || cleanupTask) {
      stopPromise = Promise.allSettled([migrationTask, cleanupTask].filter(Boolean)).then(stopWorker)
    } else stopPromise = stopWorker()
    return stopPromise
  }

  function stopWorker() {
    const instance = worker
    if (!instance) { stopped = true; return Promise.resolve() }
    const completion = new Promise(resolve => {
      let timer
      let done = false
      const finish = () => {
        if (done) return
        done = true
        clearTimeout(timer)
        worker = null
        resources.clear()
        for (const task of pending.values()) task.reject(Object.assign(new Error('缓存服务已停止'), { code: 'CACHE_STOPPED' }))
        pending.clear()
        resolve()
      }
      instance.once('exit', finish)
      timer = setTimeout(() => { Promise.resolve(instance.terminate()).then(finish, finish) }, 2000)
      try { instance.postMessage({ id: ++nextId, action: 'stop', generation }) } catch { Promise.resolve(instance.terminate()).then(finish, finish) }
    })
    stopped = true
    return completion
  }

  return {
    configure, setSession, getState, stop, handleRequest, releaseSource, changeDirectory,
    readPlaylist: id => call('readPlaylist', { id }), putPlaylist: value => call('putPlaylist', value),
    cacheSong: value => call('cacheSong', value), getSource: value => acquire('getSource', value),
    readLyrics: hash => call('readLyrics', { hash }), putLyrics: value => call('putLyrics', value),
    getArtwork: url => acquire('getArtwork', { url }), cacheArtwork: url => call('cacheArtwork', { url }),
    pause: id => call('pause', { id }), resume: id => call('resume', { id }),
    retry: id => call('retry', { id }), retryNetwork: () => call('retryNetwork'), clear: () => call('clear')
  }
}

module.exports = { createPlaylistCacheService }
