<script setup>
import { logger } from './utils/logger.js'

import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import { TitleBar, Sidebar, MusicPlayer } from './components/index.js'
import {
  LoginView,
  HomeView,
  FavoriteView,
  SettingsView,
  PersonalFMView,
  DailyRecommendView,
  RankDetailView,
  SearchView,
  ArtistView,
  AlbumDetailView
} from './views/index.js'
import { clearLoginInfo, getLoginInfo, isLoggedIn } from './api/auth.js'
import { getUserPlaylists, KUGOU_AUTH_EXPIRED_EVENT } from './api/music.js'
import { useSettingsStore } from './stores/settingsStore.js'
import { cloneDeep } from './utils/objectUtils.js'

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
const pageSessionVersion = ref(0)
const favoritesRevision = ref(0)
const cachedPageNames = ['HomeView', 'FavoriteView', 'RankDetailView', 'AlbumDetailView', 'ArtistView', 'SearchView', 'DailyRecommendView']
const pageSessionKey = computed(() => `${userLoggedIn.value ? userInfo.value?.userid || 'user' : 'guest'}:${pageSessionVersion.value}`)
const pageScrollPositions = new WeakMap()
let playlistDirectoryRequestId = 0
let playlistDirectoryTask = null

/** 账户改变后释放私有页面缓存；仅打开登录页面不影响已有页面。 */
const resetPageSession = () => {
  pageSessionVersion.value++
  playlistDirectoryRequestId++
  playlistDirectoryTask = null
  userPlaylistsLoaded.value = false
  userPlaylists.value = []
  selectedPlaylistId.value = null
  selectedPlaylistData.value = null
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
      // 登录后获取用户歌单
      fetchUserPlaylists()
    }
  }
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
      const response = await getUserPlaylists(1, 100)
      if (!isCurrentRequest()) return
      if (response.status !== 1 || !response.data) throw new Error('获取用户歌单失败')
      const lists = response.data.info || response.data.lists || response.data.list || []
      userPlaylists.value = (Array.isArray(lists) ? lists : []).map(item => ({
        ...item,
        id: item.global_collection_id ?? item.globalCollectionId ?? item.listid ?? item.list_id ?? item.id,
        name: item.name || '',
        count: item.count || 0
      })).filter(item => item.id != null)
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
  showLogin.value = true
}

// 显示设置界面
const handleShowSettings = () => {
  logger.trace('App', '打开设置界面')
  showLogin.value = false
  currentView.value = 'settings'
  showSettings.value = true
}

// 关闭设置界面
const handleCloseSettings = () => {
  logger.trace('App', '关闭设置界面')
  currentView.value = 'home'
  showSettings.value = false
}

// 设置改变处理
const handleSettingsChanged = () => {
  logger.trace('App', '设置已更新')
  // TODO: 根据设置更新应用状态
}

// 返回主界面
const handleBackToMain = () => {
  showLogin.value = false
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
  userPlaylists.value = []
  currentView.value = 'home'
  showLogin.value = true
}

// 处理侧边栏导航
const handleNavigate = (view, data) => {
  logger.trace('App', 'Navigate to:', view, data)
  showLogin.value = false
  currentView.value = view
  if (view === 'playlist') {
    selectedPlaylistId.value = data?.id ?? null
    selectedPlaylistData.value = data || null
  }
  // 如果是排行榜详情，保存排行榜数据
  if (view === 'rank' && data) {
    rankData.value = data
  } else if (view === 'artist' && data) {
    // data 结构 { id?, name? }
    artistData.value = data
  } else if (view === 'album' && data) {
    albumData.value = data
  }
}

// 处理创建歌单
const handleCreatePlaylist = () => {
  logger.trace('App', 'Create new playlist')
  // TODO: 显示创建歌单对话框
}

// 处理播放歌曲
const handlePlay = (song) => {
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
    // 使用批量更新策略，避免频繁的响应式更新
    const batch = async () => {
      // 分批添加歌曲，避免一次性处理大量数据导致UI卡顿
      const batchSize = 100
      const batches = []
      for (let i = 0; i < songs.length; i += batchSize) {
        batches.push(songs.slice(i, i + batchSize))
      }

      // 先添加第一批歌曲并开始播放（避免先清空导致播放器重置）
      if (batches.length > 0) {
        // 直接设置第一批歌曲，不先清空
        playlist.value = [...batches[0]]
        playlistIndex.value = 0
        currentSong.value = songs[0]

        // 等待第一首歌曲开始加载
        await nextTick()

        // 异步添加剩余批次
        if (batches.length > 1) {
          for (let i = 1; i < batches.length; i++) {
            await nextTick() // 每批之间给UI更新的机会
            playlist.value = [...playlist.value, ...batches[i]]
          }
        }
      }
    }

    await batch()

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

// 处理搜索歌曲
const handleSearch = (song) => {
  logger.trace('App', '搜索歌曲:', song)

  // 构造搜索关键词：优先使用歌曲名，如果没有则使用文件名
  const songName = song.name || song.filename || song.audio_name || song.songname
  const artistName = song.singername || (song.singerinfo && song.singerinfo.length > 0 ? song.singerinfo[0].singername : '')

  // 构造搜索词：歌曲名 + 歌手名
  let searchKeyword = songName
  if (artistName) {
    searchKeyword += ` ${artistName}`
  }

  if (searchKeyword.trim()) {
    // 调用搜索请求处理函数
    handleSearchRequest(searchKeyword.trim())
  } else {
    logger.warn('App', '无法构造搜索关键词，歌曲信息不完整')
    alert('无法搜索：歌曲信息不完整')
  }
}

// 处理搜索请求
const handleSearchRequest = async (keywords) => {
  logger.trace('App', '执行搜索:', keywords)
  try {
    searchQuery.value = keywords
    currentView.value = 'search'
    // 这里暂时不直接调用搜索API，而是在SearchView组件中处理
  } catch (error) {
    logger.error('App', '搜索失败:', error)
    alert('搜索失败，请稍后重试')
  }
}

// 处理清空播放列表
const handleClearPlaylist = () => {
  logger.trace('App', '清空播放列表')

  playlist.value = []
  playlistIndex.value = 0
  currentSong.value = null
}

// 播放器通过事件更新父级队列，按当前歌曲重新定位索引。
const handlePlaylistUpdated = (songs) => {
  if (!Array.isArray(songs)) return
  playlist.value = songs
  if (songs.length === 0) {
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
  getSessionSnapshot,
  defaults: getSettingsDefaults
} = useSettingsStore()

const defaultSessionTemplate = cloneDeep(getSettingsDefaults().session)
const hasAppliedDefaultPage = ref(false)
const hasRestoredSession = ref(false)
let sessionPersistTimer = null
let isRestoringSession = false
let cleanupPlaybackSessionRestore = null

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
  // 避免对相同歌曲重复赋值，减少不必要的触发
  if (!currentSong.value || currentSong.value.hash !== song.hash) {
    currentSong.value = song
  }
  // 同时更新播放列表索引
  const index = playlist.value.findIndex(s => s.hash === song.hash)
  if (index !== -1) {
    playlistIndex.value = index
  }

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
      musicPlayerRef.value.volume = Math.min(100, musicPlayerRef.value.volume + 5)
    }
    handled = true
  } else if (pressedKey === shortcuts.volumeDown && shortcuts.volumeDown !== 'Escape') {
    event.preventDefault()
    if (musicPlayerRef.value) {
      musicPlayerRef.value.volume = Math.max(0, musicPlayerRef.value.volume - 5)
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
            musicPlayerRef.value.volume = Math.min(100, musicPlayerRef.value.volume + 5)
          }
          break
        case 'volumeDown':
          if (musicPlayerRef.value) {
            musicPlayerRef.value.volume = Math.max(0, musicPlayerRef.value.volume - 5)
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
  }

  // 监听内存清理事件
  if (window.electronAPI && window.electronAPI.onMemoryCleanup) {
    unsubscribeMemoryCleanup = window.electronAPI.onMemoryCleanup(() => {
      performMemoryCleanup()
    })
  }
})

onBeforeUnmount(() => {
  isAppUnmounting = true
  playlistDirectoryRequestId++
  playlistDirectoryTask = null
  shortcutGeneration += 1
  unsubscribeGlobalShortcut?.()
  unsubscribeMemoryCleanup?.()
  cleanupPlaybackSessionRestore?.()
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
  const snapshot = {}
  if (settings.software?.restorePlaylist) {
    snapshot.playlist = cloneDeep(playlist.value)
    snapshot.playlistIndex = playlistIndex.value
    snapshot.currentSong = cloneDeep(currentSong.value)
  }

  if (settings.software?.restorePlaybackState) {
    const player = musicPlayerRef.value
    const audio = player?.$refs?.audioPlayer
    snapshot.playbackState = {
      isPlaying: player?.isPlaying ?? false,
      currentTime: audio?.currentTime ?? 0,
      duration: audio?.duration ?? 0,
      volume: player?.volume ?? 80,
      playMode: player?.playMode ?? 'loop'
    }
  }

  return snapshot
}

function queueSessionPersist({ immediate = false } = {}) {
  if (!settingsReady.value) return

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
    void persist()
    return
  }

  if (sessionPersistTimer) {
    clearTimeout(sessionPersistTimer)
  }
  sessionPersistTimer = setTimeout(() => {
    sessionPersistTimer = null
    void persist()
  }, 300)
}

async function applyPlaybackSession(state) {
  if (!state) return
  const player = musicPlayerRef.value
  const audio = player?.$refs?.audioPlayer
  if (!player || !audio) return
  cleanupPlaybackSessionRestore?.()
  const songHash = currentSong.value?.hash

  const applyState = () => {
    if (isAppUnmounting || currentSong.value?.hash !== songHash) return
    if (state.playMode) {
      player.playMode = state.playMode
    }
    if (typeof state.volume === 'number') {
      player.volume = state.volume
      audio.volume = Math.min(1, Math.max(0, state.volume / 100))
    }
    if (typeof state.currentTime === 'number') {
      const targetTime = Math.max(0, state.currentTime)
      audio.currentTime = Number.isFinite(targetTime) ? targetTime : 0
      player.currentTime = audio.currentTime
    }
    if (typeof state.duration === 'number') {
      player.duration = state.duration
    }
    if (state.isPlaying) {
      audio.play().then(() => {
        if (!isAppUnmounting && currentSong.value?.hash === songHash) player.isPlaying = !audio.paused
      }).catch(error => {
        if (isAppUnmounting || currentSong.value?.hash !== songHash) return
        player.isPlaying = false
        logger.warn('App', '恢复播放失败:', error)
      })
    } else {
      audio.pause()
      player.isPlaying = false
    }
  }

  if (audio.readyState >= 1) {
    applyState()
    return
  }

  const handleLoaded = () => {
    cleanupPlaybackSessionRestore?.()
    applyState()
  }

  cleanupPlaybackSessionRestore = () => {
    audio.removeEventListener('loadedmetadata', handleLoaded)
    audio.removeEventListener('loadeddata', handleLoaded)
    cleanupPlaybackSessionRestore = null
  }

  audio.addEventListener('loadedmetadata', handleLoaded)
  audio.addEventListener('loadeddata', handleLoaded)
}

async function restoreSessionIfNeeded() {
  if (hasRestoredSession.value || !settingsReady.value) return
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
    }

    await nextTick()

    if (shouldRestorePlayback) {
      await applyPlaybackSession(session.playbackState)
    }

    hasRestoredSession.value = true
  } finally {
    isRestoringSession = false
  }
}

watch(
  [settingsReady, () => settings.session, () => settings.software?.restorePlaylist, () => settings.software?.restorePlaybackState],
  () => {
    void restoreSessionIfNeeded().catch(error => {
      logger.error('App', '恢复播放会话失败:', error)
    })
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
  cleanupPlaybackSessionRestore?.()
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
  () => musicPlayerRef.value?.isPlaying,
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
  <div class="app-container" :class="{ 'has-player': hasPlayer, 'has-floating-player': hasPlayer && settings.custom?.playerStyle === 'netease' }">
    <TitleBar
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
                v-else-if="currentView === 'settings'" key="settings" class="page-view view-settings"
                @close="handleCloseSettings" @settings-changed="handleSettingsChanged"
              />
              <HomeView
                v-else-if="currentView === 'home'" key="home" class="page-view view-home"
                :favorites-revision="favoritesRevision"
                @navigate="handleNavigate" @play="handlePlay"
              />
              <FavoriteView
                v-else-if="userLoggedIn && (currentView === 'favorite' || currentView === 'playlist')"
                :key="currentView === 'favorite' ? 'favorite' : 'playlist:' + selectedPlaylistId"
                class="page-view view-favorite"
                :current-song="currentSong"
                :playlist-id="currentView === 'playlist' ? selectedPlaylistId : null"
                :playlist-name="selectedPlaylistData?.name || '歌单'"
                :user-playlists="userPlaylists" :playlists-loaded="userPlaylistsLoaded"
                @favorites-changed="handleFavoritesChanged"
                @navigate="handleNavigate" @play="handlePlay" @play-all="handlePlayAll"
                @play-next="handlePlayNext" @remove-from-playlist="handleRemoveFromPlaylist" @search="handleSearch"
              />
              <PersonalFMView
                v-else-if="currentView === 'personal-fm'" key="personal-fm" class="page-view view-personal-fm"
                :current-song="currentSong"
                @navigate="handleNavigate" @play="handlePlay"
              />
              <DailyRecommendView
                v-else-if="currentView === 'daily-recommend'" key="daily-recommend" class="page-view view-daily-recommend"
                :current-song="currentSong"
                @navigate="handleNavigate" @play="handlePlay" @play-all="handlePlayAll"
              />
              <RankDetailView
                v-else-if="currentView === 'rank' && rankData"
                :key="'rank:' + (rankData.rankid ?? rankData.id)" class="page-view view-rank-detail"
                :rank-data="rankData" :current-song="currentSong"
                @navigate="handleNavigate" @play="handlePlay" @play-all="handlePlayAll"
              />
              <SearchView
                v-else-if="currentView === 'search'" :key="'search:' + searchQuery" class="page-view view-search"
                :search-keyword="searchQuery" :current-song="currentSong"
                @navigate="handleNavigate" @play="handlePlay" @play-all="handlePlayAll" @play-next="handlePlayNext"
              />
              <ArtistView
                v-else-if="currentView === 'artist' && artistData"
                :key="'artist:' + (artistData.id ?? artistData.name)" class="page-view view-artist"
                :artist-id="artistData.id" :artist-name="artistData.name"
                :current-song="currentSong"
                @navigate="handleNavigate" @play="handlePlay"
              />
              <AlbumDetailView
                v-else-if="currentView === 'album' && albumData"
                :key="'album:' + (albumData.id ?? albumData.name)" class="page-view view-album"
                :album-id="albumData.id" :album-name="albumData.name"
                :current-song="currentSong"
                @navigate="handleNavigate" @play="handlePlay"
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
        @previous="handlePrevious"
        @next="handleNext"
        @song-changed="handleSongChanged"
        @toggle-playlist="handleTogglePlaylist"
        @toggle-favorite="handleToggleFavorite"
        @clear-playlist="handleClearPlaylist"
        @playlist-updated="handlePlaylistUpdated"
        @lyric-view-changed="handleLyricViewChanged"
      />
    </Transition>
  </div>
</template>

<style src="./App.css" scoped></style>
