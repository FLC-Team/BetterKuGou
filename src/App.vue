<script setup>
import { logger } from './utils/logger.js'

import { ref, computed, h, defineAsyncComponent, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import { TitleBar, Sidebar, MusicPlayer } from './components/index.js'
import HomeView from './views/HomeView.vue'
import PageLoadingView from './views/PageLoadingView.vue'
import { clearLoginInfo, getLoginInfo, isLoggedIn } from './api/auth.js'
import { getUserPlaylists, KUGOU_AUTH_EXPIRED_EVENT } from './api/music.js'
import { useSettingsStore } from './stores/settingsStore.js'
import { cloneDeep } from './utils/objectUtils.js'
import { getSongSearchKeyword } from './utils/songMetadata.js'
import { initializePlaylistCacheSession, getPlaylistCacheAPI, callPlaylistCache } from './utils/playlistCache.js'
import ThemeRecovery from './components/common/ThemeRecovery.vue'

/** 非首页界面首次使用时加载，保留原组件名供 KeepAlive 缓存。 */
function createLazyView(name, loader, options = {}) {
  return defineAsyncComponent({
    loader,
    loadingComponent: options.floating
      ? { name: 'FloatingPageLoadingView', render: () => h(PageLoadingView, { floating: true }) }
      : PageLoadingView,
    delay: 120,
    onError(error, _retry, fail) {
      logger.error('App', `加载${name}界面失败`, error)
      fail()
    }
  })
}

const LoginView = createLazyView('登录', () => import('./views/LoginView.vue'))
const FavoriteView = createLazyView('收藏与歌单', () => import('./views/FavoriteView.vue'))
const SettingsView = createLazyView('设置', () => import('./views/SettingsView.vue'))
const PersonalFMView = createLazyView('私人 FM', () => import('./views/PersonalFMView.vue'))
const DailyRecommendView = createLazyView('每日推荐', () => import('./views/DailyRecommendView.vue'))
const RankDetailView = createLazyView('排行榜', () => import('./views/RankDetailView.vue'))
const SearchView = createLazyView('搜索', () => import('./views/SearchView.vue'))
const ArtistView = createLazyView('歌手', () => import('./views/ArtistView.vue'))
const AlbumDetailView = createLazyView('专辑', () => import('./views/AlbumDetailView.vue'))
const ThemeStudio = createLazyView('外观编辑器', () => import('./components/common/ThemeStudio.vue'), { floating: true })

const themeStudioOpen = ref(false)
const settingsViewRef = ref(null)
const preparingInstall = ref(false)
let installPreparationRequestId = null
let unsubscribeInstallPreparation = null
const installBlockedEvents = ['pointerdown', 'click', 'keydown', 'input', 'change', 'submit']

function blockInputDuringInstall(event) {
  if (!preparingInstall.value) return
  event.preventDefault()
  event.stopImmediatePropagation()
}

function setInstallPreparation(active) {
  if (active && !preparingInstall.value) {
    navigationVersion++
    navigationPending.value = false
  }
  preparingInstall.value = active
  for (const name of installBlockedEvents) {
    if (active) document.addEventListener(name, blockInputDuringInstall, true)
    else document.removeEventListener(name, blockInputDuringInstall, true)
  }
}

/** 安装器明确请求后，等草稿和最终会话落盘才确认；取消使迟到的保存结果失效。 */
async function handleInstallPreparation(message) {
  const api = window.electronAPI?.updates
  if (!message || typeof message.requestId !== 'string') return
  if (message.phase === 'canceled') {
    if (installPreparationRequestId !== message.requestId) return
    installPreparationRequestId = null
    setInstallPreparation(false)
    resetAutoLyricTimer()
    queueSessionPersist()
    return
  }
  if (message.phase !== 'prepare' || installPreparationRequestId || !api?.completePrepareForInstall) return
  const requestId = message.requestId
  installPreparationRequestId = requestId
  setInstallPreparation(true)
  clearAutoLyricTimer()
  if (sessionPersistTimer) clearTimeout(sessionPersistTimer)
  sessionPersistTimer = null
  const isCurrent = () => installPreparationRequestId === requestId && !isAppUnmounting
  try {
    await nextTick()
    if (!isCurrent()) return
    if (!settingsReady.value) throw new Error('设置尚未就绪，无法准备更新')
    if (settingsViewRef.value && !await settingsViewRef.value.flushEditableSettings()) {
      throw new Error('设置草稿保存失败')
    }
    if (!isCurrent()) return
    await nextTick()
    // MediaSession、已开始的异步选歌及自然续播不经过 DOM。写入期间若它们
    // 改变歌曲、队列或跳转位置，重新保存，不能确认一个已过期的快照。
    while (isCurrent()) {
      const snapshot = collectSessionSnapshot()
      if (hasPlayer.value && shouldPersistSession() && !Object.keys(snapshot).length) {
        throw new Error('歌曲尚未加载完成，无法确认最终播放会话')
      }
      const capturedAt = Date.now()
      if (Object.keys(snapshot).length) await saveSessionSnapshot(snapshot)
      if (!isCurrent()) return
      await flushPendingSettings()
      await nextTick()
      if (!isCurrent()) return
      if (sameInstallSession(snapshot, collectSessionSnapshot(), capturedAt)) break
    }
    if (!isCurrent()) return
    const result = await api.completePrepareForInstall(requestId, { success: true })
    if (isCurrent() && (result?.success === false || result?.accepted === false)) {
      installPreparationRequestId = null
      setInstallPreparation(false)
      resetAutoLyricTimer()
    }
  } catch (error) {
    if (!isCurrent()) return
    logger.error('App', '安装前保存状态失败', error)
    try {
      await api.completePrepareForInstall(requestId, { success: false, errorCode: 'SAVE_FAILED' })
    } catch (reportError) {
      logger.error('App', '报告安装准备失败时通信异常', reportError)
    } finally {
      if (isCurrent()) {
        installPreparationRequestId = null
        setInstallPreparation(false)
        resetAutoLyricTimer()
      }
    }
  }
}

/** 自然播放时间允许前进，选歌、暂停、音量、队列和实际跳转必须重新保存。 */
function sameInstallSession(saved, current, capturedAt) {
  const withoutClock = value => {
    const copy = { ...value }
    if (copy.playbackState) {
      copy.playbackState = { ...copy.playbackState }
      delete copy.playbackState.currentTime
      delete copy.playbackState.duration
    }
    return copy
  }
  if (JSON.stringify(withoutClock(saved)) !== JSON.stringify(withoutClock(current))) return false
  if (!saved.playbackState || !current.playbackState) return true
  const elapsed = saved.playbackState.isPlaying ? Math.max(0, Date.now() - capturedAt) / 1000 : 0
  const savedTime = Number(saved.playbackState.currentTime)
  const currentTime = Number(current.playbackState.currentTime)
  if (saved.playbackState.isPlaying) {
    // 缓冲中 isPlaying 仍可能为 true；停留原位置也是有效的自然播放状态。
    return currentTime >= savedTime - .05 && currentTime <= savedTime + elapsed + 1
  }
  return Math.abs(currentTime - savedTime) <= .05
}

async function prepareThemeRecovery(base) {
  return settingsViewRef.value?.prepareThemeRecovery(base)
}

logger.trace('App', 'App.vue loaded')

// 全局错误处理
const handleGlobalError = (error, info) => {
  logger.error('App', '全局错误:', error, info)
  // 这里可以添加错误报告或用户提示
}

// 控制显示登录界面
const showLogin = ref(false)

// 控制显示设置界面
const showSettings = ref(false)

// 用户登录状态
const userLoggedIn = ref(false)
const userInfo = ref(null)

// 当前视图
const currentView = ref('home')

// 排行榜数据（用于传递给RankDetailView）
const rankData = ref(null)
// 歌手页面数据
const artistData = ref(null)
// 专辑页面数据
const albumData = ref(null)

// 搜索数据
const searchQuery = ref('')
const searchDraft = ref('')
const searchResults = ref(null)

// 用户歌单列表（TODO: 从API获取）
const userPlaylists = ref([
  // 示例数据，后续需要从API获取
  // { id: 1, name: '我喜欢的音乐' },
  // { id: 2, name: '每日推荐' },
])
const selectedPlaylistId = ref(null)
const selectedPlaylistData = ref(null)
const userPlaylistsLoaded = ref(false)
const playlistCacheState = ref(null)
let playlistCacheTask = Promise.resolve(null)
let unsubscribePlaylistCache = null
let unsubscribePlaylistCacheAuth = null
let playlistCacheInitialization = 0
let playlistCacheReady = false
const pageSessionVersion = ref(0)
const favoritesRevision = ref(0)
const cachedPageNames = ['HomeView', 'FavoriteView', 'RankDetailView', 'AlbumDetailView', 'ArtistView', 'SearchView', 'DailyRecommendView']
const pageSessionKey = computed(() => `${userLoggedIn.value ? userInfo.value?.userid || 'user' : 'guest'}:${pageSessionVersion.value}`)
const pageScrollPositions = new WeakMap()
const navigationHistory = ref([])
const navigationPending = ref(false)
const canGoBack = computed(() => !navigationPending.value && !preparingInstall.value && (showLogin.value || navigationHistory.value.length > 0))
let navigationVersion = 0
let playlistDirectoryRequestId = 0
let playlistDirectoryTask = null
let onlineUserPlaylists = []

/** 账户改变后释放私有页面缓存；仅打开登录页面不影响已有页面。 */
const resetPageSession = () => {
  navigationVersion++
  navigationPending.value = false
  navigationHistory.value = []
  pageSessionVersion.value++
  playlistDirectoryRequestId++
  playlistDirectoryTask = null
  userPlaylistsLoaded.value = false
  userPlaylists.value = []
  onlineUserPlaylists = []
  selectedPlaylistId.value = null
  selectedPlaylistData.value = null
  playlistCacheState.value = null
  playlistCacheReady = false
}

/** 保留当前账号最近打开歌单的离线入口，在线目录仍提供最新名称和顺序。 */
function mergeCachedPlaylistDirectory(lists) {
  const result = [...lists]
  const known = new Set(result.map(item => String(item.id)))
  for (const item of playlistCacheState.value?.playlists || []) {
    if (item?.id == null || known.has(String(item.id))) continue
    known.add(String(item.id))
    result.push({ id: item.id, name: item.name || '歌单', count: item.total || 0 })
  }
  return result
}

/** 缓存广播与页面使用同一账号身份；旧快照不能恢复上一账号的侧栏。 */
function applyPlaylistCacheState(state) {
  const userId = localStorage.getItem('kugou_userid')
  if (!playlistCacheReady || !state || !userLoggedIn.value || !userId || String(state.userId) !== String(userId)) return
  const previous = playlistCacheState.value
  if (previous && (Number(state.generation) < Number(previous.generation) ||
      (state.generation === previous.generation && Number(state.revision) < Number(previous.revision)))) return
  if (state.authExpired === true || state.error?.code === 'KUGOU_AUTH_EXPIRED') {
    handleAuthExpired()
    return
  }
  playlistCacheState.value = state
  userPlaylists.value = mergeCachedPlaylistDirectory(onlineUserPlaylists)
}

/** 先初始化桌面账号并恢复目录，后续网络请求和播放器共享这次初始化。 */
function initializeAccountPlaylistCache() {
  const initialization = ++playlistCacheInitialization
  playlistCacheReady = false
  if (!window.electronAPI?.playlistCache) return Promise.resolve(null)
  const identity = userLoggedIn.value ? {
    userId: localStorage.getItem('kugou_userid'), token: localStorage.getItem('kugou_token')
  } : null
  playlistCacheTask = initializePlaylistCacheSession(identity).then(async state => {
    if (initialization !== playlistCacheInitialization) return null
    if (identity && !state) state = await getPlaylistCacheAPI()?.getState?.()
    if (initialization !== playlistCacheInitialization) return null
    playlistCacheReady = Boolean(identity)
    applyPlaylistCacheState(state)
    return state
  }).catch(error => {
    logger.warn('App', '初始化歌单缓存失败', { name: error?.name, message: error?.message })
    return null
  })
  return playlistCacheTask
}

if (window.electronAPI?.playlistCache?.onState) {
  unsubscribePlaylistCache = window.electronAPI.playlistCache.onState(applyPlaylistCacheState)
}
if (window.electronAPI?.playlistCache?.onAuthExpired) {
  unsubscribePlaylistCacheAuth = window.electronAPI.playlistCache.onAuthExpired(event => {
    const state = playlistCacheState.value
    if (playlistCacheReady && state && String(event?.userId) === String(state.userId) &&
        event?.generation === state.generation) handleAuthExpired()
  })
}

/** 恢复网络只重试网络失败的既有任务；暂停、清理与权限状态由服务保留。 */
function handlePlaylistCacheOnline() {
  if (!userLoggedIn.value || isAppUnmounting || !window.electronAPI?.playlistCache) return
  callPlaylistCache('retryNetwork').catch(error => {
    logger.warn('App', '恢复离线缓存网络任务失败', { name: error?.name })
  })
}

/** 独立滚动容器随页面缓存，并在脱离文档前保存真实滚动位置。 */
const rememberPageScroll = (element) => {
  pageScrollPositions.set(element, element.scrollTop)
  element.inert = true
}
const restorePageScroll = (element) => {
  element.inert = false
  const scrollTop = pageScrollPositions.get(element) || 0
  nextTick(() => {
    if (element.isConnected) element.scrollTop = scrollTop
  })
}

// 播放器状态
const currentSong = ref(null)
const playlist = ref([])
const playlistIndex = ref(0)
const hasPlayer = computed(() => Boolean(currentSong.value && typeof currentSong.value === 'object' &&
  Array.isArray(playlist.value) && playlist.value.length > 0))

// 检查登录状态
const checkLoginStatus = () => {
  if (isLoggedIn()) {
    const loginInfo = getLoginInfo()
    if (loginInfo) {
      userLoggedIn.value = true
      userInfo.value = loginInfo.userInfo
      logger.trace('App', '已恢复登录状态')
      initializeAccountPlaylistCache()
      // 登录后获取用户歌单
      fetchUserPlaylists()
      return
    }
  }
  initializeAccountPlaylistCache()
}

// 获取用户歌单
const fetchUserPlaylists = () => {
  if (playlistDirectoryTask) return playlistDirectoryTask
  const requestId = ++playlistDirectoryRequestId
  const token = localStorage.getItem('kugou_token')
  const userId = localStorage.getItem('kugou_userid')
  const isCurrentRequest = () => requestId === playlistDirectoryRequestId && userLoggedIn.value &&
    localStorage.getItem('kugou_token') === token && localStorage.getItem('kugou_userid') === userId
  userPlaylistsLoaded.value = false
  const task = Promise.resolve().then(async () => {
    try {
      if (window.electronAPI?.playlistCache) await playlistCacheTask
      if (!isCurrentRequest()) return
      const response = await getUserPlaylists(1, 100)
      if (!isCurrentRequest()) return
      if (response.status !== 1 || !response.data) throw new Error('获取用户歌单失败')
      const lists = response.data.info || response.data.lists || response.data.list || []
      onlineUserPlaylists = (Array.isArray(lists) ? lists : []).map(item => ({
        ...item,
        id: item.global_collection_id ?? item.globalCollectionId ?? item.listid ?? item.list_id ?? item.id,
        name: item.name || '',
        count: item.count || 0
      })).filter(item => item.id != null)
      userPlaylists.value = mergeCachedPlaylistDirectory(onlineUserPlaylists)
    } catch (error) {
      if (isCurrentRequest()) logger.error('App', '获取用户歌单失败:', error)
    } finally {
      if (isCurrentRequest()) userPlaylistsLoaded.value = true
      if (playlistDirectoryTask === task) playlistDirectoryTask = null
    }
  })
  playlistDirectoryTask = task
  return task
}

// 首次渲染前确定账号，避免先挂载访客首页再重复请求登录首页。
checkLoginStatus()

// 显示登录界面
const handleShowLogin = () => {
  if (showLogin.value) return false
  return runPageNavigation(() => { showLogin.value = true; return true })
}

// 显示设置界面
const handleShowSettings = () => {
  logger.trace('App', '打开设置界面')
  return handleNavigate('settings')
}

// 关闭设置界面
const handleCloseSettings = () => {
  logger.trace('App', '关闭设置界面')
  return navigationHistory.value.length ? handleGoBack() : handleNavigate('home')
}

// 设置改变处理
const handleSettingsChanged = () => {
  logger.trace('App', '设置已更新')
  // TODO: 根据设置更新应用状态
}

// 返回主界面
const handleBackToMain = () => {
  return handleGoBack()
}

// 登录成功处理
const handleLoginSuccess = (data) => {
  logger.trace('App', '登录成功')
  resetPageSession()
  userLoggedIn.value = true
  userInfo.value = {
    userid: data.userid,
    username: data.username || data.nickname || '',
    avatar: data.pic || data.avatar || '',
    vip_type: data.vip_type || 0
  }
  showLogin.value = false
  initializeAccountPlaylistCache()
  // 登录后获取用户歌单
  fetchUserPlaylists()
}

// 退出登录处理
const handleLogout = () => {
  logger.trace('App', '退出登录')
  // 清除本地存储
  clearLoginInfo()
  resetPageSession()

  // 重置状态
  userLoggedIn.value = false
  userInfo.value = null
  initializeAccountPlaylistCache()
  userPlaylists.value = []
  currentView.value = 'home'

  // 显示登录界面
  showLogin.value = true
}

// API token 可能已过期，不能只根据本地是否存在 token 维持假登录状态。
const handleAuthExpired = () => {
  clearLoginInfo()
  resetPageSession()
  userLoggedIn.value = false
  userInfo.value = null
  initializeAccountPlaylistCache()
  userPlaylists.value = []
  currentView.value = 'home'
  showLogin.value = true
}

/** 资源身份同时用于历史去重与缓存 key，避免数字 ID、空 ID 和名称回退串页。 */
function getPageKey(view, data = null, query = '') {
  if (view === 'search') return `search:${query}`
  if (!['playlist', 'rank', 'artist', 'album'].includes(view)) return view
  const rawId = view === 'rank' ? data?.rankid ?? data?.id : data?.id
  const id = rawId == null ? '' : String(rawId).trim()
  return `${view}:${id && id !== '0' ? `id:${id}` : `name:${data?.name || ''}`}`
}

/** 历史只持有路由参数与搜索草稿；曲目、筛选和滚动仍由原缓存实例维护。 */
function captureNavigationPage() {
  const view = currentView.value
  const data = view === 'rank' ? rankData.value
    : view === 'artist' ? artistData.value
      : view === 'album' ? albumData.value
        : view === 'playlist' ? selectedPlaylistData.value : null
  return { view, data: cloneDeep(data), searchQuery: searchQuery.value, searchDraft: searchDraft.value }
}

/** 恢复来源页参数以重新激活对应缓存，播放器和曲目队列不参与路由恢复。 */
function restoreNavigationPage(page) {
  if (page.view === 'rank') rankData.value = cloneDeep(page.data)
  if (page.view === 'artist') artistData.value = cloneDeep(page.data)
  if (page.view === 'album') albumData.value = cloneDeep(page.data)
  if (page.view === 'playlist') {
    selectedPlaylistId.value = page.data?.id ?? null
    selectedPlaylistData.value = cloneDeep(page.data)
  }
  searchQuery.value = page.searchQuery
  searchDraft.value = page.searchDraft
  currentView.value = page.view
  showSettings.value = page.view === 'settings'
  showLogin.value = false
}

/** 设置页离场须先落盘；失败保留草稿，重复操作及账号变更后的迟到结果不提交。 */
function runPageNavigation(commit) {
  if (navigationPending.value || preparingInstall.value || isAppUnmounting) return false
  if (showLogin.value || currentView.value !== 'settings' || !settingsViewRef.value) return commit()
  const version = ++navigationVersion
  const view = settingsViewRef.value
  navigationPending.value = true
  return Promise.resolve().then(() => version === navigationVersion && !isAppUnmounting ? view.flushEditableSettings() : false).then(saved => {
    if (!saved || version !== navigationVersion || preparingInstall.value || isAppUnmounting) return false
    return commit()
  }).catch(error => {
    logger.error('App', '离开设置前保存失败', error)
    return false
  }).finally(() => {
    if (version === navigationVersion) navigationPending.value = false
  })
}

/** 只为不同目标压入来源页；恢复历史使用独立出口，返回不会重新生成历史。 */
function navigateToPage(target, afterNavigation) {
  return runPageNavigation(() => {
    const current = captureNavigationPage()
    const page = { ...current, ...target }
    if (getPageKey(current.view, current.data, current.searchQuery) !== getPageKey(page.view, page.data, page.searchQuery)) {
      navigationHistory.value.push(current)
    }
    restoreNavigationPage(page)
    afterNavigation?.()
    return true
  })
}

/** 登录覆盖层先关闭；普通返回仅弹出来源页，不把离开的页面再次压栈。 */
const handleGoBack = () => {
  return runPageNavigation(() => {
    // 登录只覆盖当前内容页，关闭它不能消耗内容页的历史。
    if (showLogin.value) { showLogin.value = false; return true }
    const page = navigationHistory.value.pop()
    if (!page) return false
    restoreNavigationPage(page)
    return true
  })
}

const handleNavigate = (view, data) => {
  const pageViews = ['home', 'favorite', 'playlist', 'personal-fm', 'daily-recommend', 'rank', 'search', 'artist', 'album', 'settings']
  if (!pageViews.includes(view)) return false
  if (['rank', 'artist', 'album', 'playlist'].includes(view) && (!data || typeof data !== 'object')) return false
  logger.trace('App', 'Navigate to:', view, data)
  return navigateToPage({ view, data: cloneDeep(data || null) })
}

// 处理创建歌单
const handleCreatePlaylist = () => {
  logger.trace('App', 'Create new playlist')
  // TODO: 显示创建歌单对话框
}

// 处理播放歌曲
const handlePlay = (song) => {
  restoredPlaybackState.value = null
  logger.trace('App', '🎵 [App.vue] handlePlay 调用:', song.name || song.filename)
  logger.trace('App', '🎵 [App.vue] 歌曲 hash:', song.hash)
  logger.trace('App', '🎵 [App.vue] 旧 currentSong:', currentSong.value?.name)
  logger.trace('App', 'App.vue - userLoggedIn:', userLoggedIn.value)
  currentSong.value = song
  logger.trace('App', '🎵 [App.vue] 新 currentSong:', currentSong.value?.name)
  // 如果是单曲播放，只有当前歌曲
  if (!playlist.value.find(s => s.hash === song.hash)) {
    playlist.value = [song]
    playlistIndex.value = 0
  } else {
    playlistIndex.value = playlist.value.findIndex(s => s.hash === song.hash)
  }
}

// 处理播放所有歌曲
const handlePlayAll = async (songs) => {
  if (process.env.NODE_ENV === 'development') {
    logger.trace('App', 'Play all songs:', songs)
  }

  if (!songs || !Array.isArray(songs) || songs.length === 0) {
    logger.warn('App', '无效的歌曲列表:', songs)
    return
  }

  try {
    // 一次发布完整队列，避免 nextTick 微任务分批反复渲染和覆盖后续选歌。
    restoredPlaybackState.value = null
    playlist.value = [...songs]
    playlistIndex.value = 0
    currentSong.value = songs[0]
    await nextTick()

    if (process.env.NODE_ENV === 'development') {
      logger.trace('App', '已添加', songs.length, '首歌曲到播放列表')
    }
  } catch (error) {
    logger.error('App', '处理播放所有歌曲时出错:', error)
  }
}

// 处理下一首播放
const handlePlayNext = (song) => {
  logger.trace('App', '下一首播放:', song)
  // 通过ref访问MusicPlayer组件的方法
  if (musicPlayerRef.value) {
    musicPlayerRef.value.addToPlayNextQueue(song)
  }
}

// 处理从播放列表移除
const handleRemoveFromPlaylist = (song) => {
  logger.trace('App', '从播放列表移除:', song)
  if (musicPlayerRef.value) {
    musicPlayerRef.value.removeFromPlaylist(song)
  }
}

/** All song-title entry points share title-only metadata normalization. */
const handleSearch = (song) => {
  const keyword = getSongSearchKeyword(song)
  if (!keyword) {
    logger.warn('App', '无法构造搜索关键词，歌曲信息不完整')
    return
  }
  return handleSearchRequest(keyword)
}

/** Keep drafts separate from submitted cache keys; navigation never changes playback. */
const handleSearchRequest = (keywords) => {
  const keyword = typeof keywords === 'string' ? keywords.trim() : ''
  if (!keyword) return
  return navigateToPage({ view: 'search', data: null, searchQuery: keyword, searchDraft: keyword }, () => {
    musicPlayerRef.value?.closeLyrics?.()
    if (musicPlayerRef.value) musicPlayerRef.value.showPlaylist = false
  })
}

// 处理清空播放列表
const handleClearPlaylist = () => {
  logger.trace('App', '清空播放列表')
  restoredPlaybackState.value = null

  playlist.value = []
  playlistIndex.value = 0
  currentSong.value = null
}

// 播放器通过事件更新父级队列，按当前歌曲重新定位索引。
const handlePlaylistUpdated = (songs) => {
  if (!Array.isArray(songs)) return
  playlist.value = songs
  if (songs.length === 0) {
    restoredPlaybackState.value = null
    playlistIndex.value = 0
    currentSong.value = null
    return
  }
  const index = songs.findIndex(song => song.hash === currentSong.value?.hash)
  playlistIndex.value = index >= 0 ? index : 0
}

// MusicPlayer组件的ref
const musicPlayerRef = ref(null)

const {
  settings,
  ready: settingsReady,
  saveSessionSnapshot,
  flushPendingSettings,
  getSessionSnapshot,
  defaults: getSettingsDefaults
} = useSettingsStore()

const defaultSessionTemplate = cloneDeep(getSettingsDefaults().session)
const hasAppliedDefaultPage = ref(false)
const hasRestoredSession = ref(false)
const restoredPlaybackState = ref(null)
let sessionPersistTimer = null
let sessionCheckpointTimer = null
let isRestoringSession = false
const SESSION_CHECKPOINT_INTERVAL = 5000

// 歌词界面显示状态
const isLyricViewVisible = ref(false)

// 自动全屏歌词相关状态
const autoLyricTimer = ref(null)
const lastUserActivity = ref(Date.now())
const AUTO_LYRIC_DELAY = 60 * 1000 // 60秒

// 处理歌词界面显示状态变化
const handleLyricViewChanged = (isVisible) => {
  logger.trace('App', '🎵 [App.vue] handleLyricViewChanged - 歌词界面状态变化:', isVisible)
  isLyricViewVisible.value = isVisible
  window.electronAPI?.islandLyric?.setLyricViewOpen?.(Boolean(isVisible))

  // 如果用户手动切换歌词界面，重置自动全屏计时器
  if (!isVisible && settings.playback?.fullscreenLyrics && currentSong.value) {
    logger.trace('App', '🎵 [App.vue] 用户关闭歌词界面，重置自动全屏计时器')
    resetAutoLyricTimer()
  } else if (isVisible) {
    // 如果用户进入歌词界面，暂停自动全屏计时器
    clearAutoLyricTimer()
  }
}

// 清空队列会直接卸载播放器，仍需复原标题栏并取消歌词状态。
watch(hasPlayer, (visible) => {
  if (!visible) handleLyricViewChanged(false)
})

// 播放上一曲（由 MusicPlayer 组件内部处理）
const handlePrevious = () => {
  // MusicPlayer 组件已经处理了播放逻辑
  logger.trace('App', '上一曲事件')
}

// 播放下一曲（由 MusicPlayer 组件内部处理）
const handleNext = () => {
  // MusicPlayer 组件已经处理了播放逻辑
  logger.trace('App', '下一曲事件')
}

// 处理歌曲切换事件
const handleSongChanged = (song) => {
  logger.trace('App', '🎵 [App.vue] handleSongChanged - 歌曲已切换:', song.name || song.filename)
  logger.trace('App', '🎵 [App.vue] 歌曲 hash:', song.hash)
  restoredPlaybackState.value = null
  // 避免对相同歌曲重复赋值，减少不必要的触发
  if (!currentSong.value || currentSong.value.hash !== song.hash) {
    currentSong.value = song
  }
  // 同时更新播放列表索引
  const index = playlist.value.findIndex(s => s.hash === song.hash)
  if (index !== -1) {
    playlistIndex.value = index
  }
  void queueSessionPersist({ immediate: true })

  // 🔧 新的智能自动全屏逻辑：
  // - 如果用户已经在歌词界面，保持在歌词界面
  // - 如果用户没在歌词界面且开启了自动全屏，重置60秒计时器
  if (!isLyricViewVisible.value && settings.playback?.fullscreenLyrics) {
    resetAutoLyricTimer()
  }

  if (process.env.NODE_ENV === 'development') {
    logger.trace('App', '🎵 [App.vue] 切歌完成，歌词界面策略:', {
      isLyricViewVisible: isLyricViewVisible.value,
      fullscreenLyricsEnabled: settings.playback?.fullscreenLyrics,
      action: isLyricViewVisible.value ? '保持显示' : '启动自动全屏计时器'
    })
  }
}

// 更新用户活动时间戳并重置计时器
const updateUserActivity = () => {
  lastUserActivity.value = Date.now()

  // 如果开启了自动全屏且有歌曲播放，重置计时器
  if (settings.playback?.fullscreenLyrics && currentSong.value && !isLyricViewVisible.value) {
    resetAutoLyricTimer()
  }
}

// 自动全屏计时器管理
const startAutoLyricTimer = () => {
  clearAutoLyricTimer()

  logger.trace('App', '🎵 [App.vue] 启动自动全屏计时器，60秒后进入全屏歌词')
  autoLyricTimer.value = setTimeout(() => {
    // 检查是否满足自动全屏条件
    if (settings.playback?.fullscreenLyrics &&
        currentSong.value &&
        !isLyricViewVisible.value &&
        musicPlayerRef.value?.isPlaying) {

      logger.trace('App', '🎵 [App.vue] 60秒无操作，自动进入全屏歌词')
      musicPlayerRef.value?.showLyrics()
    }
  }, AUTO_LYRIC_DELAY)
}

const clearAutoLyricTimer = () => {
  if (autoLyricTimer.value) {
    logger.trace('App', '🎵 [App.vue] 清除自动全屏计时器')
    clearTimeout(autoLyricTimer.value)
    autoLyricTimer.value = null
  }
}

const resetAutoLyricTimer = () => {
  // 只在满足条件时才重置计时器
  if (settings.playback?.fullscreenLyrics &&
      currentSong.value &&
      !isLyricViewVisible.value) {

    logger.trace('App', '🎵 [App.vue] 重置自动全屏计时器')
    startAutoLyricTimer()
  } else {
    clearAutoLyricTimer()
  }
}

// 切换播放列表显示
const handleTogglePlaylist = () => {
  logger.trace('App', 'Toggle playlist')
  // TODO: 显示播放列表侧边栏
}

// 切换收藏状态
const handleToggleFavorite = (song) => {
  logger.trace('App', 'Toggle favorite:', song)
  // TODO: 添加/移除收藏
}

const handleFavoritesChanged = () => {
  favoritesRevision.value++
  musicPlayerRef.value?.checkFavoriteStatus?.()
}

// 快捷键处理
const handleKeyDown = (event) => {
  if (preparingInstall.value) return
  // 如果正在输入,忽略快捷键
  const target = event.target
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
    return
  }
  // 保留聚焦按钮/链接的原生激活行为，避免 Space 收藏变成播放快捷键。
  if ([' ', 'Enter'].includes(event.key) && target.closest?.('button, [role="button"], a[href]')) return

  // 如果正在编辑快捷键,不触发任何快捷键
  if (window.__editingShortcut) {
    return
  }

  if (!settings.shortcuts) return

  const keys = []
  if (event.ctrlKey || event.metaKey) keys.push('Control')
  if (event.altKey) keys.push('Alt')
  if (event.shiftKey) keys.push('Shift')

  let mainKey = event.key
  const keyMap = {
    'ArrowUp': 'Up',
    'ArrowDown': 'Down',
    'ArrowLeft': 'Left',
    'ArrowRight': 'Right',
    ' ': 'Space'
  }
  mainKey = keyMap[mainKey] || mainKey

  if (['Control', 'Alt', 'Shift', 'Meta'].includes(mainKey)) {
    return
  }

  keys.push(mainKey)
  const pressedKey = keys.join('+')

  const shortcuts = settings.shortcuts.keys
  if (!shortcuts) return

  // 匹配快捷键并执行对应操作
  let handled = false

  if (pressedKey === shortcuts.playPause && shortcuts.playPause !== 'Escape') {
    event.preventDefault()
    musicPlayerRef.value?.togglePlay()
    handled = true
  } else if (pressedKey === shortcuts.nextTrack && shortcuts.nextTrack !== 'Escape') {
    event.preventDefault()
    musicPlayerRef.value?.playNext()
    handled = true
  } else if (pressedKey === shortcuts.prevTrack && shortcuts.prevTrack !== 'Escape') {
    event.preventDefault()
    musicPlayerRef.value?.playPrevious()
    handled = true
  } else if (pressedKey === shortcuts.volumeUp && shortcuts.volumeUp !== 'Escape') {
    event.preventDefault()
    if (musicPlayerRef.value) {
      musicPlayerRef.value.handleVolumeChange(Math.min(100, musicPlayerRef.value.volume + 5))
    }
    handled = true
  } else if (pressedKey === shortcuts.volumeDown && shortcuts.volumeDown !== 'Escape') {
    event.preventDefault()
    if (musicPlayerRef.value) {
      musicPlayerRef.value.handleVolumeChange(Math.max(0, musicPlayerRef.value.volume - 5))
    }
    handled = true
  } else if (pressedKey === shortcuts.toggleLyrics && shortcuts.toggleLyrics !== 'Escape') {
    event.preventDefault()
    musicPlayerRef.value?.toggleLyrics()
    handled = true
  } else if (pressedKey === shortcuts.toggleFullscreen && shortcuts.toggleFullscreen !== 'Escape') {
    event.preventDefault()
    if (window.electronAPI?.toggleFullscreen) {
      window.electronAPI.toggleFullscreen()
    }
    handled = true
  } else if (pressedKey === shortcuts.bossKey && shortcuts.bossKey !== 'Escape') {
    event.preventDefault()
    if (window.electronAPI?.hide) {
      window.electronAPI.hide()
    }
    handled = true
  }

  if (handled) {
    logger.trace('App', '🎹 快捷键触发:', pressedKey)
  }
}

// 全局快捷键注册
const registeredGlobalShortcuts = ref(new Set())
let shortcutUpdateQueue = Promise.resolve()
let shortcutGeneration = 0
let isAppUnmounting = false
let unsubscribeGlobalShortcut = null
let unsubscribeMemoryCleanup = null

// 串行更新快捷键；IPC 注册结果异步返回，过期任务不能继续注册。
function registerGlobalShortcuts() {
  if (!window.electronAPI?.registerGlobalShortcut) {
    logger.warn('App', '⚠️ Electron API 不可用,无法注册全局快捷键')
    return
  }

  const generation = ++shortcutGeneration
  const enabled = Boolean(settings.shortcuts?.enableGlobal)
  const shortcuts = cloneDeep(settings.shortcuts?.keys || {})
  shortcutUpdateQueue = shortcutUpdateQueue.then(async () => {
    await unregisterAllGlobalShortcuts()
    if (isAppUnmounting || generation !== shortcutGeneration || !enabled) return

    for (const [action, key] of Object.entries(shortcuts)) {
      if (isAppUnmounting || generation !== shortcutGeneration) break
      if (!key || key === 'Escape') continue
      try {
        const success = await window.electronAPI.registerGlobalShortcut(key, action)
        if (success) {
          registeredGlobalShortcuts.value.add(key)
          logger.trace('App', '全局快捷键注册成功:', key, action)
        } else {
          logger.warn('App', '全局快捷键注册失败:', key)
        }
      } catch (err) {
        logger.error('App', '全局快捷键注册错误:', key, err)
      }
    }
  }).catch(err => {
    logger.error('App', '更新全局快捷键失败:', err)
  })
  return shortcutUpdateQueue
}

async function unregisterAllGlobalShortcuts() {
  if (!window.electronAPI?.unregisterGlobalShortcut) return

  for (const key of [...registeredGlobalShortcuts.value]) {
    try {
      await window.electronAPI.unregisterGlobalShortcut(key)
      registeredGlobalShortcuts.value.delete(key)
      logger.trace('App', '🔓 全局快捷键已注销:', key)
    } catch (err) {
      logger.error('App', '注销全局快捷键错误:', key, err)
    }
  }
}

// 监听全局快捷键设置变化
watch(
  () => [settings.shortcuts?.enableGlobal, settings.shortcuts?.keys],
  () => {
    if (settingsReady.value) {
      registerGlobalShortcuts()
    }
  },
  { deep: true }
)

// 监听来自主进程的全局快捷键触发
onMounted(() => {
  if (window.electronAPI?.onGlobalShortcut) {
    unsubscribeGlobalShortcut = window.electronAPI.onGlobalShortcut((action) => {
      if (preparingInstall.value) return
      logger.trace('App', '🌐 全局快捷键触发:', action)

      // 执行对应的操作
      switch (action) {
        case 'playPause':
          musicPlayerRef.value?.togglePlay()
          break
        case 'nextTrack':
          musicPlayerRef.value?.playNext()
          break
        case 'prevTrack':
          musicPlayerRef.value?.playPrevious()
          break
        case 'volumeUp':
          if (musicPlayerRef.value) {
            musicPlayerRef.value.handleVolumeChange(Math.min(100, musicPlayerRef.value.volume + 5))
          }
          break
        case 'volumeDown':
          if (musicPlayerRef.value) {
            musicPlayerRef.value.handleVolumeChange(Math.max(0, musicPlayerRef.value.volume - 5))
          }
          break
        case 'toggleLyrics':
          musicPlayerRef.value?.toggleLyrics()
          break
        case 'toggleFullscreen':
          if (window.electronAPI?.toggleFullscreen) {
            window.electronAPI.toggleFullscreen()
          }
          break
        case 'bossKey':
          if (window.electronAPI?.hide) {
            window.electronAPI.hide()
          }
          break
      }
    })
  }
})

// 应用启动时检查登录状态
onMounted(() => {

  unsubscribeInstallPreparation = window.electronAPI?.updates?.onPrepareForInstall?.(handleInstallPreparation)

  // 添加快捷键监听
  document.addEventListener('keydown', handleKeyDown)

  // 添加用户活动检测监听器
  const activityEvents = ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart']
  activityEvents.forEach(eventType => {
    document.addEventListener(eventType, updateUserActivity, { passive: true })
  })

  // 注册全局快捷键
  if (settingsReady.value) {
    registerGlobalShortcuts()
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', handleBeforeUnload)
    window.addEventListener(KUGOU_AUTH_EXPIRED_EVENT, handleAuthExpired)
    window.addEventListener('online', handlePlaylistCacheOnline)
  }
  startSessionCheckpoint()

  // 监听内存清理事件
  if (window.electronAPI && window.electronAPI.onMemoryCleanup) {
    unsubscribeMemoryCleanup = window.electronAPI.onMemoryCleanup(() => {
      performMemoryCleanup()
    })
  }
})

onBeforeUnmount(() => {
  isAppUnmounting = true
  navigationVersion++
  navigationPending.value = false
  installPreparationRequestId = null
  setInstallPreparation(false)
  unsubscribeInstallPreparation?.()
  unsubscribePlaylistCache?.()
  unsubscribePlaylistCacheAuth?.()
  playlistCacheInitialization++
  playlistCacheReady = false
  playlistDirectoryRequestId++
  playlistDirectoryTask = null
  shortcutGeneration += 1
  unsubscribeGlobalShortcut?.()
  unsubscribeMemoryCleanup?.()
  stopSessionCheckpoint()
  // 移除快捷键监听
  document.removeEventListener('keydown', handleKeyDown)

  // 移除用户活动检测监听器
  const activityEvents = ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart']
  activityEvents.forEach(eventType => {
    document.removeEventListener(eventType, updateUserActivity, { passive: true })
  })

  // 清除自动全屏计时器
  clearAutoLyricTimer()

  // 注销所有全局快捷键
  shortcutUpdateQueue = shortcutUpdateQueue.then(unregisterAllGlobalShortcuts).catch(err => {
    logger.error('App', '退出时注销全局快捷键失败:', err)
  })

  if (sessionPersistTimer) {
    clearTimeout(sessionPersistTimer)
    sessionPersistTimer = null
  }
  if (typeof window !== 'undefined') {
    window.removeEventListener('beforeunload', handleBeforeUnload)
    window.removeEventListener(KUGOU_AUTH_EXPIRED_EVENT, handleAuthExpired)
    window.removeEventListener('online', handlePlaylistCacheOnline)
  }
})

function applyDefaultPage(page) {
  logger.trace('App', '[App] applyDefaultPage 调用:', {
    page,
    userLoggedIn: userLoggedIn.value,
    currentView: currentView.value,
    hasAppliedDefaultPage: hasAppliedDefaultPage.value
  })

  // 计算期望的页面
  const desired = page === 'favorites' && !userLoggedIn.value ? 'home' : page
  const normalizedDesired = desired === 'favorites' ? 'favorite' : desired

  logger.trace('App', '[App] 计算结果:', { desired, normalizedDesired })

  // 首次应用：直接设置
  if (!hasAppliedDefaultPage.value) {
    if (normalizedDesired && normalizedDesired !== currentView.value) {
      currentView.value = normalizedDesired
      logger.trace('App', '[App] 首次应用，已切换到:', normalizedDesired)
    }
    hasAppliedDefaultPage.value = true
    return
  }

  // 已应用过，但如果当前在 home 页面，且期望页面是 favorite，且用户刚登录
  // 则允许切换到 favorite（这是为了处理登录状态延迟的情况）
  if (normalizedDesired === 'favorite' &&
      currentView.value === 'home' &&
      userLoggedIn.value) {
    currentView.value = normalizedDesired
    logger.trace('App', '[App] 登录后切换到收藏页:', normalizedDesired)
  }
}

watch(
  [settingsReady, () => settings.software?.defaultPage, userLoggedIn],
  ([ready, page, loggedIn]) => {
    logger.trace('App', '[App] watch 触发:', { ready, page, loggedIn, hasApplied: hasAppliedDefaultPage.value })
    if (!ready) return
    applyDefaultPage(page)
  },
  { immediate: true }
)

function shouldPersistSession() {
  return Boolean(settings.software?.restorePlaylist || settings.software?.restorePlaybackState)
}

function collectSessionSnapshot() {
  const player = musicPlayerRef.value
  const confirmed = hasPlayer.value ? player?.getPlaybackSnapshot?.() : null
  // 父级 currentSong 也承载待选目标。首曲尚未确认或新队列尚未接管音源时，
  // 保留磁盘上的有效会话，不能把新歌身份与旧音源进度拼在一起。
  if (hasPlayer.value && (!confirmed || !playlist.value.some(song => song.hash === confirmed.currentSong.hash))) return {}
  const snapshot = {}
  if (settings.software?.restorePlaylist) {
    snapshot.playlist = cloneDeep(playlist.value)
    snapshot.currentSong = cloneDeep(confirmed?.currentSong || null)
    snapshot.playlistIndex = confirmed ? playlist.value.findIndex(song => song.hash === confirmed.currentSong.hash) : 0
  }

  if (settings.software?.restorePlaybackState) {
    snapshot.playbackState = cloneDeep(confirmed?.playbackState || defaultSessionTemplate.playbackState)
  }

  return snapshot
}

function queueSessionPersist({ immediate = false } = {}) {
  if (!settingsReady.value || !hasRestoredSession.value || isRestoringSession || isAppUnmounting || preparingInstall.value) return

  if (!shouldPersistSession()) {
    return
  }

  const persist = async () => {
    const snapshot = collectSessionSnapshot()
    const hasPlaylistData = Object.prototype.hasOwnProperty.call(snapshot, 'playlist')
    const hasPlaybackState = Object.prototype.hasOwnProperty.call(snapshot, 'playbackState')
    if (!hasPlaylistData && !hasPlaybackState) return
    try {
      await saveSessionSnapshot(snapshot)
    } catch (err) {
      logger.error('App', '[App] 保存播放会话失败:', err)
    }
  }

  if (immediate) {
    if (sessionPersistTimer) clearTimeout(sessionPersistTimer)
    sessionPersistTimer = null
    return persist()
  }

  if (sessionPersistTimer) {
    clearTimeout(sessionPersistTimer)
  }
  sessionPersistTimer = setTimeout(() => {
    sessionPersistTimer = null
    void persist()
  }, 300)
}

/** 持续播放也定期落盘；等待本次保存后再计时，慢磁盘不会累积检查点任务。 */
function startSessionCheckpoint() {
  stopSessionCheckpoint()
  sessionCheckpointTimer = setTimeout(async () => {
    sessionCheckpointTimer = null
    await queueSessionPersist({ immediate: true })
    if (!isAppUnmounting) startSessionCheckpoint()
  }, SESSION_CHECKPOINT_INTERVAL)
}

function stopSessionCheckpoint() {
  if (sessionCheckpointTimer) clearTimeout(sessionCheckpointTimer)
  sessionCheckpointTimer = null
}

function restoreSessionIfNeeded() {
  if (hasRestoredSession.value || isRestoringSession || !settingsReady.value) return
  const session = getSessionSnapshot()
  const shouldRestorePlaylist = Boolean(settings.software?.restorePlaylist && Array.isArray(session.playlist) && session.playlist.length > 0)
  const shouldRestorePlayback = Boolean(settings.software?.restorePlaybackState && session.playbackState)

  if (!shouldRestorePlaylist && !shouldRestorePlayback) {
    hasRestoredSession.value = true
    return
  }

  isRestoringSession = true
  try {
    if (shouldRestorePlaylist) {
      playlist.value = cloneDeep(session.playlist)
      const playlistLength = playlist.value.length
      const targetIndex = Math.min(Math.max(session.playlistIndex ?? 0, 0), Math.max(playlistLength - 1, 0))
      playlistIndex.value = playlistLength > 0 ? targetIndex : 0
      const fallbackSong = playlistLength > 0 ? (session.playlist?.[targetIndex] || session.playlist?.[0] || null) : null
      currentSong.value = cloneDeep(session.currentSong || fallbackSong)
      const actualIndex = playlist.value.findIndex(song => song.hash === currentSong.value?.hash)
      if (actualIndex !== -1) playlistIndex.value = actualIndex
      restoredPlaybackState.value = shouldRestorePlayback && currentSong.value?.hash
        ? { ...cloneDeep(session.playbackState), songHash: currentSong.value.hash } : null
    }

    hasRestoredSession.value = true
  } finally {
    isRestoringSession = false
  }
}

watch(
  [settingsReady, () => settings.session, () => settings.software?.restorePlaylist, () => settings.software?.restorePlaybackState],
  () => {
    try {
      restoreSessionIfNeeded()
    } catch (error) {
      logger.error('App', '恢复播放会话失败:', error)
    }
  },
  { immediate: true }
)

watch(
  () => settings.playback?.fullscreenLyrics,
  (enabled) => {
    if (!enabled && isLyricViewVisible.value && musicPlayerRef.value?.closeLyrics) {
      musicPlayerRef.value.closeLyrics()
    }
  }
)

watch(playlist, () => {
  if (isRestoringSession) return
  queueSessionPersist()
}, { deep: true })

watch(currentSong, () => {
  if (currentSong.value?.hash !== restoredPlaybackState.value?.songHash) restoredPlaybackState.value = null
  if (isRestoringSession) return
  queueSessionPersist({ immediate: true })
})

watch(playlistIndex, () => {
  if (isRestoringSession) return
  queueSessionPersist({ immediate: true })
})

// 添加调试：监控 currentSong 变化
watch(currentSong, (newVal, oldVal) => {
  logger.trace('App', '🎵 [App.vue] currentSong 响应式变化:', {
    old: oldVal?.hash,
    new: newVal?.hash,
    oldName: oldVal?.name,
    newName: newVal?.name
  })
}, { deep: true })

watch(
  [() => musicPlayerRef.value?.isPlaying, () => musicPlayerRef.value?.volume, () => musicPlayerRef.value?.playMode],
  () => {
    if (isRestoringSession) return
    queueSessionPersist({ immediate: true })
  }
)

watch(
  () => settings.software?.restorePlaylist,
  (enabled) => {
    if (!settingsReady.value) return
    if (!enabled) {
      void saveSessionSnapshot({
        playlist: [],
        playlistIndex: 0,
        currentSong: null
      }).catch(error => {
        logger.error('App', '清除播放队列快照失败:', error)
      })
    } else {
      queueSessionPersist({ immediate: true })
    }
  },
  { immediate: true }
)

watch(
  () => settings.software?.restorePlaybackState,
  (enabled) => {
    if (!settingsReady.value) return
    if (!enabled) {
      void saveSessionSnapshot({
        playbackState: cloneDeep(defaultSessionTemplate.playbackState)
      }).catch(error => {
        logger.error('App', '清除播放状态快照失败:', error)
      })
    } else {
      queueSessionPersist({ immediate: true })
    }
  },
  { immediate: true }
)

function handleBeforeUnload() {
  queueSessionPersist({ immediate: true })
}

// 渲染进程内存清理
function performMemoryCleanup() {
  logger.trace('App', '🧹 [渲染进程] 执行内存清理...')

  try {
    // 当前音频资源由播放器管理，暂停时仍需保留地址和播放进度。

    // 图片及音频的生命周期由对应组件管理，避免清理后无法恢复可见内容。

    // 3. 触发垃圾回收（如果可用）
    if (window.gc) {
      window.gc()
      logger.trace('App', '✅ 渲染进程 GC 已执行')
    }

    // 4. 清理大型数组和对象缓存
    // 保留最近的播放历史，清理较旧的
    // if (playlist.value.length > 100) {
    //   console.log(`清理播放列表，保留最近100首歌曲 (原有 ${playlist.value.length} 首)`)
    //   // 保留当前播放的歌曲和前后的歌曲
    //   const currentIndex = playlistIndex.value
    //   const start = Math.max(0, currentIndex - 50)
    //   const end = Math.min(playlist.value.length, currentIndex + 50)
    //   playlist.value = playlist.value.slice(start, end)
    //   playlistIndex.value = currentIndex - start
    // }

    logger.trace('App', '✅ [渲染进程] 内存清理完成')
  } catch (error) {
    logger.error('App', '❌ [渲染进程] 内存清理失败:', error)
  }
}
</script>

<template>
  <Teleport to="body">
    <Transition name="ui-fade" @before-leave="$event.setAttribute('inert', '')" @before-enter="$event.removeAttribute('inert')" @leave-cancelled="$event.removeAttribute('inert')"><div v-if="preparingInstall" class="install-preparation" role="status" aria-live="polite">
      <div class="install-preparation-message">
        <span class="loading-spinner" aria-hidden="true"></span>
        <p>正在保存，准备更新</p>
        <span>保存完成后将关闭 BetterKuGou，请稍候。</span>
      </div>
    </div></Transition>
  </Teleport>
  <div class="app-container" :class="{ 'has-player': hasPlayer, 'has-floating-player': hasPlayer && settings.custom?.playerStyle === 'netease' }">
    <TitleBar
      v-model="searchDraft"
      :can-go-back="canGoBack"
      @back="handleGoBack"
      @show-login="handleShowLogin"
      @logout="handleLogout"
      @open-settings="handleShowSettings"
      @search="handleSearchRequest"
      :userLoggedIn="userLoggedIn"
      :userInfo="userInfo"
      :isLyricViewVisible="isLyricViewVisible"
    />

    <div class="content">
      <!-- 主界面布局 -->
      <div class="main-layout">
        <!-- 侧边栏（始终显示）-->
        <Sidebar
          :playlists="userPlaylists"
          :currentView="showLogin ? 'login' : currentView"
          :userLoggedIn="userLoggedIn"
          :userInfo="userInfo"
          :selectedPlaylistId="selectedPlaylistId"
          @navigate="handleNavigate"
          @create-playlist="handleCreatePlaylist"
          @show-login="handleShowLogin"
          @open-settings="handleShowSettings"
          @logout="handleLogout"
        />

        <!-- 页面组件独立缓存与滚动，登录和设置仍按原生命周期卸载。 -->
        <div class="main-content">
          <Transition name="page-switch" @before-leave="rememberPageScroll" @before-enter="restorePageScroll">
            <KeepAlive :key="pageSessionKey" :include="cachedPageNames" :max="12">
              <LoginView
                v-if="showLogin" key="login" class="page-view"
                @back="handleBackToMain" @loginSuccess="handleLoginSuccess"
              />
              <SettingsView
                ref="settingsViewRef"
                v-else-if="currentView === 'settings'" key="settings" class="page-view view-settings"
                @close="handleCloseSettings" @settings-changed="handleSettingsChanged"
                @open-theme-studio="themeStudioOpen = true"
              />
              <HomeView
                v-else-if="currentView === 'home'" key="home" class="page-view view-home"
                :favorites-revision="favoritesRevision"
                @navigate="handleNavigate" @play="handlePlay" @search="handleSearch"
              />
              <FavoriteView
                v-else-if="userLoggedIn && (currentView === 'favorite' || currentView === 'playlist')"
                :key="getPageKey(currentView, selectedPlaylistData)"
                class="page-view view-favorite"
                :current-song="currentSong"
                :playlist-id="currentView === 'playlist' ? selectedPlaylistId : null"
                :playlist-name="selectedPlaylistData?.name || '歌单'"
                :user-playlists="userPlaylists" :playlists-loaded="userPlaylistsLoaded"
                :playlist-cache-state="playlistCacheState"
                @favorites-changed="handleFavoritesChanged"
                @navigate="handleNavigate" @play="handlePlay" @play-all="handlePlayAll"
                @play-next="handlePlayNext" @remove-from-playlist="handleRemoveFromPlaylist" @search="handleSearch"
              />
              <PersonalFMView
                v-else-if="currentView === 'personal-fm'" key="personal-fm" class="page-view view-personal-fm"
                :current-song="currentSong"
                @navigate="handleNavigate" @play="handlePlay" @search="handleSearch"
              />
              <DailyRecommendView
                v-else-if="currentView === 'daily-recommend'" key="daily-recommend" class="page-view view-daily-recommend"
                :current-song="currentSong"
                @navigate="handleNavigate" @play="handlePlay" @play-all="handlePlayAll" @search="handleSearch"
              />
              <RankDetailView
                v-else-if="currentView === 'rank' && rankData"
                :key="getPageKey('rank', rankData)" class="page-view view-rank-detail"
                :rank-data="rankData" :current-song="currentSong"
                @navigate="handleNavigate" @play="handlePlay" @play-all="handlePlayAll" @search="handleSearch"
              />
              <SearchView
                v-else-if="currentView === 'search'" :key="getPageKey('search', null, searchQuery)" class="page-view view-search"
                :search-keyword="searchQuery" :current-song="currentSong"
                @navigate="handleNavigate" @play="handlePlay" @play-all="handlePlayAll" @play-next="handlePlayNext" @search="handleSearch"
              />
              <ArtistView
                v-else-if="currentView === 'artist' && artistData"
                :key="getPageKey('artist', artistData)" class="page-view view-artist"
                :artist-id="artistData.id" :artist-name="artistData.name"
                :current-song="currentSong"
                @navigate="handleNavigate" @play="handlePlay" @search="handleSearch"
              />
              <AlbumDetailView
                v-else-if="currentView === 'album' && albumData"
                :key="getPageKey('album', albumData)" class="page-view view-album"
                :album-id="albumData.id" :album-name="albumData.name"
                :current-song="currentSong"
                @navigate="handleNavigate" @play="handlePlay" @search="handleSearch"
              />
              <div v-else-if="!userLoggedIn && currentView !== 'home'" class="page-view login-required" key="login-required">
                <svg viewBox="0 0 1024 1024" width="80" height="80" fill="currentColor" opacity="0.3">
                  <path d="M858.5 763.6a374 374 0 00-80.6-119.5 375.63 375.63 0 00-119.5-80.6c-.4-.2-.8-.3-1.2-.5C719.5 518 760 444.7 760 362c0-137-111-248-248-248S264 225 264 362c0 82.7 40.5 156 102.8 201.1-.4.2-.8.3-1.2.5-44.8 18.9-85 46-119.5 80.6a375.63 375.63 0 00-80.6 119.5A371.7 371.7 0 00136 901.8a8 8 0 008 8.2h60c4.4 0 7.9-3.5 8-7.8 2-77.2 33-149.5 87.8-204.3 56.7-56.7 132-87.9 212.2-87.9s155.5 31.2 212.2 87.9C779 752.7 810 825 812 902.2c.1 4.4 3.6 7.8 8 7.8h60a8 8 0 008-8.2c-1-47.8-10.9-94.3-29.5-138.2zM512 534c-45.9 0-89.1-17.9-121.6-50.4S340 407.9 340 362c0-45.9 17.9-89.1 50.4-121.6S466.1 190 512 190s89.1 17.9 121.6 50.4S684 316.1 684 362c0 45.9-17.9 89.1-50.4 121.6S557.9 534 512 534z"/>
                </svg>
                <h2>需要登录</h2>
                <p>请先登录以访问此页面</p>
                <button class="primary-btn" @click="handleShowLogin">
                  立即登录
                </button>
              </div>
            </KeepAlive>
          </Transition>
        </div>
      </div>
    </div>

    <!-- 全局音乐播放器 -->
    <Transition name="player-slide">
      <MusicPlayer
        v-if="hasPlayer"
        ref="musicPlayerRef"
        :song="currentSong"
        :playlist="playlist"
        :initial-playback-state="restoredPlaybackState"
        @previous="handlePrevious"
        @next="handleNext"
        @song-changed="handleSongChanged"
        @playback-state-changed="queueSessionPersist({ immediate: true })"
        @toggle-playlist="handleTogglePlaylist"
        @toggle-favorite="handleToggleFavorite"
        @clear-playlist="handleClearPlaylist"
        @playlist-updated="handlePlaylistUpdated"
        @lyric-view-changed="handleLyricViewChanged"
        @search="handleSearch"
        @navigate="handleNavigate"
      />
    </Transition>
  </div>
  <ThemeStudio v-if="themeStudioOpen" @close="themeStudioOpen = false" />
  <ThemeRecovery :prepare-restore="prepareThemeRecovery" />
</template>

<style src="./App.css" scoped></style>
