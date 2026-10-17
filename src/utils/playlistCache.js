let sessionVersion = 0
let sessionIdentity = null
let sessionTask = Promise.resolve(null)
let sessionQueue = Promise.resolve()

/** 浏览器预览没有桌面缓存桥接，调用方继续沿用在线路径。 */
export function getPlaylistCacheAPI() {
  return typeof window === 'undefined' ? null : window.electronAPI?.playlistCache || null
}

export function getPlaylistCacheSessionVersion() {
  return sessionVersion
}

/** 串行切换账号；立即推进本地代次，阻止旧页面继续读写新账号。 */
export function initializePlaylistCacheSession(identity) {
  const version = ++sessionVersion
  sessionIdentity = identity?.userId && identity?.token
    ? { userId: String(identity.userId), token: String(identity.token) } : null
  const nextIdentity = sessionIdentity
  const api = getPlaylistCacheAPI()
  const task = sessionQueue.catch(() => {}).then(async () => {
    if (!api?.setSession) return null
    const state = await api.setSession(nextIdentity)
    return version === sessionVersion ? state : null
  })
  sessionTask = task
  sessionQueue = task.catch(() => {})
  return task
}

/** 等待最新账号初始化，失败或退出后返回 null，不阻断在线播放。 */
export async function waitForPlaylistCacheSession() {
  let pending
  do {
    pending = sessionTask
    try { await pending } catch { if (pending === sessionTask) return null }
  } while (pending !== sessionTask)
  return sessionIdentity ? getPlaylistCacheAPI() : null
}

/** 可选缓存操作统一等待会话，并丢弃切换账号期间的迟到结果。 */
export async function callPlaylistCache(method, ...args) {
  const version = sessionVersion
  const api = await waitForPlaylistCacheSession()
  if (!api || version !== sessionVersion || typeof api[method] !== 'function') return null
  const result = await api[method](...args)
  if (version === sessionVersion) return result
  // 图片/音频的迟到能力不交给新账号，同时释放主进程已分配的租约。
  if (result?.leaseId && api.releaseSource) {
    try { await api.releaseSource(result.leaseId) } catch { /* 退出清理仍会释放该会话租约。 */ }
  }
  return null
}
