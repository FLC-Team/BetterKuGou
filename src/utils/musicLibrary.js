/**
 * App 拥有的账号音乐库控制器。只发布服务端确认的收藏；页面与播放器共享实例，
 * 凭证只用于请求身份检查，不进入展示状态、快照或日志。
 */
export function createMusicLibrary({ api, getDirectory, getIdentity, isOnline = () => true,
  onFavorites = () => {}, onPlaylistChanged = () => {}, getFavoriteBinding = () => null,
  saveFavoriteBinding = () => {}, reactive = value => value }) {
  const state = reactive({ favorites: [], resource: null, loaded: false, loading: false,
    offlineSnapshot: false, error: '', pending: {}, revision: 0, playlistRevisions: {}, favoriteCandidates: [] })
  let generation = 0
  let controller = new AbortController()
  let refreshTask = null
  let favoriteQueue = Promise.resolve()
  let confirmedFavorites = false
  const operations = new Map()
  const hashOf = song => String(song?.hash || song?.FileHash || '').toLowerCase()
  const identity = () => {
    const value = getIdentity() || {}
    return { userId: String(value.userId || value.userid || ''), token: value.token || '' }
  }
  const capture = () => ({ ...identity(), generation, signal: controller.signal })
  const current = scope => scope.generation === generation && !scope.signal.aborted &&
    scope.userId === identity().userId && scope.token === identity().token
  const requireCurrent = scope => {
    if (!current(scope)) throw Object.assign(new Error('账号状态已改变，请重试'), { code: 'STALE_ACCOUNT' })
  }
  function requireWrite() {
    const account = identity()
    if (!account.userId || !account.token) throw new Error('请先登录酷狗账号')
    if (!isOnline()) throw new Error('当前离线，联网后才能修改云端收藏和歌单')
    return capture()
  }
  function changed(resource) {
    const key = String(resource.id ?? resource.globalCollectionId ?? resource.listId)
    state.playlistRevisions[key] = (state.playlistRevisions[key] || 0) + 1
    onPlaylistChanged(resource)
  }
  function publish(songs, resource, scope) {
    requireCurrent(scope)
    state.favorites = songs
    state.resource = resource
    state.loaded = true
    state.offlineSnapshot = false
    confirmedFavorites = true
    state.error = ''
    state.revision++
    onFavorites(songs, resource)
  }
  async function readFavorites(scope) {
    const resources = await getDirectory({ signal: scope.signal })
    requireCurrent(scope)
    const explicit = resources.filter(item => item.isFavorite === true && item.listId != null)
    const binding = getFavoriteBinding(scope.userId)
    const bound = binding == null ? [] : resources.filter(item => item.listId != null && String(item.listId) === String(binding))
    const favorites = explicit.length === 1 ? explicit : bound
    state.favoriteCandidates = resources.filter(item => item.listId != null && (item.isFavorite || item.favoriteCandidate))
    if (favorites.length !== 1) throw new Error('请在“我喜欢”页面确认账号的收藏歌单，再进行云端修改')
    const resource = { ...favorites[0], isFavorite: true }
    const songs = await api.getAllPlaylistTracks(resource, { signal: scope.signal })
    requireCurrent(scope)
    publish(songs, resource, scope)
    return songs
  }
  function refreshFavorites() {
    if (refreshTask) return refreshTask
    const scope = capture()
    if (!scope.userId || !scope.token) return Promise.resolve([])
    state.loading = true
    state.error = ''
    // Reads share the mutation queue: a slow UI refresh must never publish a pre-write snapshot.
    const task = serializeFavorites(() => { requireCurrent(scope); return readFavorites(scope) }).catch(error => {
      if (current(scope)) {
        state.loaded = false
        state.error = error.message || '收藏读取失败，请重试'
      }
      throw error
    }).finally(() => {
      if (current(scope)) state.loading = false
      if (refreshTask === task) refreshTask = null
    })
    refreshTask = task
    return task
  }
  /** 同一资源防重入；旧账号的完成回调不能解除新账号的等待状态。 */
  function singleFlight(key, run) {
    if (operations.has(key)) return operations.get(key)
    let scope
    try { scope = requireWrite() } catch (error) { return Promise.reject(error) }
    state.pending[key] = true
    const task = Promise.resolve().then(() => run(scope)).catch(error => {
      if (current(scope)) state.error = error.message || '云端操作失败，请重试'
      throw error
    }).finally(() => {
      if (operations.get(key) === task) operations.delete(key)
      if (current(scope)) delete state.pending[key]
    })
    operations.set(key, task)
    return task
  }
  function serializeFavorites(run) {
    const task = favoriteQueue.then(run)
    favoriteQueue = task.catch(() => {}) // 失败不阻塞后续用户主动操作，错误仍交给原调用方。
    return task
  }
  async function verifyAfterFailure(scope, resource, expected, originalError) {
    requireCurrent(scope)
    try {
      const songs = await readFavorites(scope)
      if (expected(songs)) { changed(resource); return songs }
    } catch (error) {
      requireCurrent(scope)
      // 结果未知时保留最后确认状态，下次修改前必须重新读取。
      state.loaded = false
    }
    throw originalError
  }
  function toggleFavorite(song) {
    const hash = hashOf(song)
    if (!hash) return Promise.reject(new Error('歌曲缺少有效标识'))
    return singleFlight(`favorite:${hash}`, scope => serializeFavorites(async () => {
      requireCurrent(scope)
      if (!state.loaded) await readFavorites(scope)
      requireCurrent(scope)
      const matches = state.favorites.filter(item => hashOf(item) === hash)
      const removing = matches.length > 0
      const resource = state.resource
      const expected = songs => songs.some(item => hashOf(item) === hash) !== removing
      if (removing && matches.some(item => item.fileid == null || String(item.fileid) === '')) {
        throw new Error('云端未提供歌曲条目标识，无法安全取消收藏，请刷新后重试')
      }
      try {
        if (removing) await api.removePlaylistSongs(resource.listId, matches.map(item => item.fileid), { signal: scope.signal })
        else await api.addPlaylistSongs(resource.listId, [song], { signal: scope.signal })
      } catch (error) {
        return verifyAfterFailure(scope, resource, expected, error)
      }
      requireCurrent(scope)
      // 写入确认后先发布可用状态，随后读回获得新条目的 fileid。
      publish(removing ? state.favorites.filter(item => hashOf(item) !== hash) : [...state.favorites, { ...song }], resource, scope)
      changed(resource)
      try { await readFavorites(scope) } catch (error) {
        requireCurrent(scope)
        state.loaded = false
        state.error = '云端修改已成功，最新列表读取失败，请刷新后继续操作'
      }
    }))
  }
  function editSongs(resource, songs, remove = false) {
    const id = resource?.listId
    if (id == null || !(resource.isOwned || resource.isFavorite)) return Promise.reject(new Error('此歌单不可编辑，请选择本人歌单'))
    const boundId = getFavoriteBinding(identity().userId)
    const favoriteTarget = resource.isFavorite ||
      (state.resource?.listId != null && String(state.resource.listId) === String(id)) ||
      (boundId != null && String(boundId) === String(id))
    const edit = async scope => {
      requireCurrent(scope)
      if (resource.ownerId != null && String(resource.ownerId) !== scope.userId) {
        throw new Error('歌单不属于当前账号，请刷新后重试')
      }
      if (!Array.isArray(songs) || !songs.length) throw new Error('请先选择歌曲')
      if (remove && songs.some(song => song.fileid == null || String(song.fileid) === '')) {
        throw new Error('部分歌曲缺少云端条目标识，无法安全移除，请刷新后重试')
      }
      let completed = 0
      try {
        for (let start = 0; start < songs.length; start += 1000) {
          requireCurrent(scope)
          const batch = songs.slice(start, start + 1000)
          if (remove) await api.removePlaylistSongs(id, batch.map(song => song.fileid), { signal: scope.signal })
          else await api.addPlaylistSongs(id, batch, { signal: scope.signal })
          completed += batch.length
        }
      } catch (error) {
        requireCurrent(scope)
        changed(resource)
        if (favoriteTarget) {
          try { await readFavorites(scope) } catch {
            requireCurrent(scope)
            state.loaded = false
          }
        }
        if (completed) throw new Error(`已处理 ${completed} 首，其余操作未确认完成，请刷新后检查再重试`)
        throw error
      }
      requireCurrent(scope)
      changed(resource)
      if (favoriteTarget) {
        try { await readFavorites(scope) } catch (error) {
          requireCurrent(scope)
          state.loaded = false
          throw new Error('云端修改已成功，最新列表读取失败，请刷新后继续操作')
        }
      }
      return true
    }
    return singleFlight(`playlist:${id}`, scope => favoriteTarget
      ? serializeFavorites(() => edit(scope)) : edit(scope))
  }
  return {
    state,
    get canWrite() { const account = identity(); return !!(account.userId && account.token && isOnline()) },
    isFavorite: song => state.favorites.some(item => hashOf(item) === hashOf(song)),
    isFavoritePending: song => !!state.pending[`favorite:${hashOf(song)}`],
    refreshFavorites, toggleFavorite,
    /** Hydrate only an explicitly account-owned read snapshot; it never authorizes or triggers a write. */
    hydrateFavorites(songs, _resource, { userId } = {}) {
      const account = identity()
      if (confirmedFavorites || !account.userId || !account.token || userId == null ||
          String(userId) !== account.userId || !Array.isArray(songs)) return false
      state.favorites = songs.filter(song => song && typeof song === 'object' && hashOf(song)).map(song => ({ ...song }))
      state.loaded = false
      state.offlineSnapshot = true
      state.revision++
      return true
    },
    /** 仅绑定完整账号目录中用户明确确认的候选，不发起任何云端写入。 */
    bindFavorites(resource) {
      return singleFlight('favorite:binding', scope => serializeFavorites(async () => {
        requireCurrent(scope)
        const resources = await getDirectory({ signal: scope.signal })
        requireCurrent(scope)
        const candidate = resources.find(item => item.listId != null && String(item.listId) === String(resource?.listId) &&
          (item.isFavorite || item.favoriteCandidate))
        if (!candidate) throw new Error('收藏候选已改变，请刷新后重新选择')
        saveFavoriteBinding(scope.userId, candidate.listId)
        state.loaded = false
        return readFavorites(scope)
      }))
    },
    addSongs: (resource, songs) => editSongs(resource, songs),
    removeSongs: (resource, songs) => editSongs(resource, songs, true),
    /** 清空只提交明确的云端条目；由调用方先展示数量并取得确认。 */
    clearFavorites: () => singleFlight('favorite:clear', scope => serializeFavorites(async () => {
      requireCurrent(scope)
      await readFavorites(scope)
      requireCurrent(scope)
      const songs = [...state.favorites]
      if (!songs.length) return
      if (songs.some(song => song.fileid == null || String(song.fileid) === '')) throw new Error('部分歌曲缺少云端条目标识，无法安全清空')
      const resource = state.resource
      let writeError = null
      try {
        for (let start = 0; start < songs.length; start += 1000) {
          requireCurrent(scope)
          await api.removePlaylistSongs(resource.listId, songs.slice(start, start + 1000).map(song => song.fileid), { signal: scope.signal })
        }
      } catch (error) { writeError = error }
      requireCurrent(scope)
      changed(resource)
      let remaining
      try { remaining = await readFavorites(scope) } catch (error) {
        requireCurrent(scope)
        state.loaded = false
        throw writeError || new Error('云端清空已成功，最新列表读取失败，请刷新后继续操作')
      }
      if (writeError && remaining.length) throw writeError
    })),
    reset() {
      generation++
      controller.abort()
      controller = new AbortController()
      refreshTask = null
      favoriteQueue = Promise.resolve()
      confirmedFavorites = false
      operations.clear()
      Object.assign(state, { favorites: [], resource: null, loaded: false, loading: false, offlineSnapshot: false, error: '', pending: {}, playlistRevisions: {}, favoriteCandidates: [], revision: state.revision + 1 })
    }
  }
}
