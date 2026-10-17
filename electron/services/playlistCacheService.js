const { Worker: NodeWorker } = require('node:worker_threads')
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
  let state = { revision: 0, generation: 0, userId: null, enabled: true, usedBytes: 0, limitBytes: 2 * 1024 ** 3, playlists: [] }
  const pending = new Map()
  const resources = new Map()

  function getState() { return copy(state) }
  function publish(snapshot) {
    if (stopped || snapshot?.generation !== generation || String(snapshot?.userId ?? '') !== String(session?.userId ?? '')) return getState()
    state = { ...copy(snapshot), revision: state.revision + 1 }
    try { onState(getState()) } catch (error) {
      logger.warn('playlistCacheService', '离线缓存状态通知失败', { name: error?.name, code: error?.code })
    }
    return getState()
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

  function rpc(action, payload, taskGeneration = generation) {
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
    publish({ ...state, generation, userId: next?.userId ?? null, playlists: [], error: null })
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
    if (streaming) item.active++
    let finished = false
    const finish = () => {
      if (finished || !streaming) return
      finished = true
      item.active--
      if (item.releasing && item.active === 0) releaseSource(leaseId).catch(() => {})
    }
    try {
      const response = createMediaResponse(request, item.resource, finish)
      if (response.status >= 400) finish()
      return response
    } catch { finish(); return new Response(null, { status: 500 }) }
  }

  /** Cancel network IO before allowing the application lifecycle to release the Worker. */
  function stop() {
    if (stopPromise) return stopPromise
    const instance = worker
    if (!instance) { stopped = true; stopPromise = Promise.resolve(); return stopPromise }
    stopPromise = new Promise(resolve => {
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
    return stopPromise
  }

  return {
    configure, setSession, getState, stop, handleRequest, releaseSource,
    readPlaylist: id => call('readPlaylist', { id }), putPlaylist: value => call('putPlaylist', value),
    cacheSong: value => call('cacheSong', value), getSource: value => acquire('getSource', value),
    readLyrics: hash => call('readLyrics', { hash }), putLyrics: value => call('putLyrics', value),
    getArtwork: url => acquire('getArtwork', { url }), cacheArtwork: url => call('cacheArtwork', { url }),
    pause: id => call('pause', { id }), resume: id => call('resume', { id }),
    retry: id => call('retry', { id }), retryNetwork: () => call('retryNetwork'), clear: () => call('clear')
  }
}

module.exports = { createPlaylistCacheService }
