
import { logger } from '../../utils/logger.js'
import { computed } from 'vue'
import { createPlaybackTransition, waitForPlaybackOperation, waitForPlaybackReady, selectPlaybackCandidate } from '../../utils/playbackTransition.js'
import { createTrailingSilenceAnalyzer } from '../../utils/trailingSilence.js'
import { createAudioEffectsEngine } from '../../utils/audioEffectsEngine.js'
import { getSongUrl, getLyric, getSongDetail } from '../../api/music.js'
import { getCloudSongUrl, uploadPlayHistory } from '../../api/library.js'
import { createListeningHistory } from '../../utils/listeningHistory.js'
import { librarySongKey } from '../../utils/libraryMetadata.js'
import PlaylistDrawer from './PlaylistDrawer.vue'
import ContextMenu from '../common/ContextMenu.vue'
import AnimatedSelect from '../common/AnimatedSelect.vue'
import ArtworkCover from '../common/ArtworkCover.vue'
import ArtistLinks from '../common/ArtistLinks.vue'
import LibraryActions from '../common/LibraryActions.vue'
import LyricView from './LyricView.vue'
import VolumeControl from './VolumeControl.vue'
import contextMenuManager from '../../utils/contextMenuManager.js'
import { useSettingsStore } from '../../stores/settingsStore.js'
import { PLAYBACK_QUALITY_OPTIONS, normalizePlaybackQuality, readPlaybackQuality } from '../../utils/playbackQuality.js'
import { getPlaylistCacheAPI, waitForPlaylistCacheSession, getPlaylistCacheSessionVersion } from '../../utils/playlistCache.js'
import { cloneDeep } from '../../utils/objectUtils.js'
import { parseDesktopLyrics } from '../../utils/desktopLyrics.js'
import { processLyricContent, readLyricRomanization } from '../../utils/lyricProcessing.js'
import { getSongArtists, getSongSearchKeyword } from '../../utils/songMetadata.js'

// 动态导入 SVG 图标
import playlistIcon from '../../assets/icons/playlist.svg'
import repeatAllIcon from '../../assets/icons/repeat_all.svg'
import repeatOneIcon from '../../assets/icons/repeat_one.svg'
import shuffleIcon from '../../assets/icons/shuffle.svg'

export default {
  name: 'MusicPlayer',
  inject: { musicLibrary: { default: null } },
  components: {
    PlaylistDrawer,
    ContextMenu,
    AnimatedSelect,
    ArtworkCover,
    ArtistLinks,
    LibraryActions,
    LyricView,
    VolumeControl
  },
  props: {
    song: {
      type: Object,
      default: null
    },
    playlist: {
      type: Array,
      default: () => []
    },
    initialPlaybackState: {
      type: Object,
      default: null
    }
  },
  setup() {
    const settingsStore = useSettingsStore()
    const { settings } = settingsStore
    const playerStyle = computed(() => {
      const style = settings.custom?.playerStyle || 'default'
      logger.trace('MusicPlayer', '当前播放器样式:', style)
      return style
    })
    return {
      playerStyle,
      settingsStore
    }
  },
  data() {
    return {
      // SVG 图标
      playlistIcon,
      repeatAllIcon,
      repeatOneIcon,
      shuffleIcon,
      // 状态
      activeAudioSlot: 0,
      candidateAudioSlot: null,
      deckVersions: [0, 0],
      deckLeases: [null, null],
      deckMediaLeases: [null, null],
      mediaSourceLeases: new Set(),
      audioEffectsEngine: null,
      audioEffectsInit: null,
      audioEffectsInitializing: false,
      audioEffectsUnsubscribe: null,
      audioEffectsStatus: null,
      audioEffectsError: '',
      audioEffectsWet: false,
      audioEffectsTrack: null,
      audioEffectsDeck: null,
      presentedPlaybackSnapshots: new Map(),
      presentedPlaybackSnapshot: null,
      naturalLoopSeek: null,
      audioTransition: null,
      preparedNext: null,
      preloadRevision: 0,
      playbackIntentVersion: 0,
      desiredPlaying: false,
      automaticAdvanceVersion: null,
      tailAnalysis: null,
      tailAnalyzer: null,
      tailAnalysisVersion: 0,
      cacheReadyUnsubscribe: null,
      playbackLifecycleListener: null,
      playbackPollTimer: null,
      lastNaturalPosition: null,
      naturalAdvanceSinceSeek: 0,
      currentSong: null,
      songLoadStage: '',
      songLoadError: '',
      failedSong: null,
      failedSongOptions: null,
      hasRequestedInitialSong: false,
      replacingPlaybackSnapshot: null,
      trackTransition: 'select',
      isPlaying: false,
      currentTime: 0,
      duration: 0,
      isDragging: false, // 是否正在拖动进度条
      seekPreviewTime: null,
      volume: 80,
      lastAudibleVolume: 80,
      isMuted: false,
      playMode: 'loop', // loop: 列表循环, single: 单曲循环, shuffle: 随机播放
      currentIndex: 0, // 当前播放索引
      showPlaylist: false, // 是否显示播放列表
      playedHistory: [], // 已播放历史（用于随机播放）
      shuffledPlaylist: [], // 随机播放列表（预先打乱的播放顺序）
      playOrderHistory: [], // 播放顺序历史（用于上一首功能）
      historyPointer: -1, // 播放历史指针，-1表示在最新位置
      isNavigatingHistory: false, // 是否正在历史记录中导航
      playNextQueue: [], // 下一首播放队列
      playModeMenuVisible: false, // 播放模式菜单显示状态
      playModeMenuPosition: { x: 0, y: 0 }, // 播放模式菜单位置
      // 歌词相关
      showLyricView: false, // 是否显示歌词界面
      currentLyrics: '', // 当前歌词内容
      isLyricPlaceholder: true,
      currentLyricData: null, // 完整的歌词数据（包含翻译等信息）
      lyricLibraryUnsubscribe: null,
      // MediaSession 相关
      lastPositionUpdate: null, // 上次位置更新的时间（秒）
      lastDesktopTimeUpdate: null, // 上次桌面歌词时间更新的时间戳（毫秒）
      desktopAudioWaiting: false,
      listeningHistory: null,
      playbackInstanceId: 0,
      listeningHistoryInstanceId: null,
      // 切歌控制
      isSwitchingSong: false, // 是否正在切歌（防止并发）
      isLoadingSong: false, // 是否正在加载歌曲（防止重复加载）
      isComponentReady: false, // 组件是否完全准备就绪
      switchSongDebounceTimer: null, // 切歌防抖定时器
      // RAF 循环
      rafId: null, // requestAnimationFrame ID
      // 系统托盘控制
      trayControlUnsubscribe: null, // 系统托盘控制监听器取消订阅函数
      isDisposed: false,
      pendingSong: null,
      pendingSongTransition: 'select',
      loadingSongHash: null,
      loadedSongHash: null,
      qualityOptions: PLAYBACK_QUALITY_OPTIONS,
      currentQuality: null,
      loadedQualityPreference: null,
      cacheSourceLeaseId: null,
      cacheSourceLeases: new Set(),
      loadedSongDetail: null,
      loadedCacheSessionVersion: null,
      playedCacheSongs: new Set(),
      queuedCacheSongs: new Set(),
      cachedLyricData: null,
      currentLyricsFromCache: false,
      currentLyricsFromLibrary: false,
      qualityMessage: '',
      qualitySaveMessage: '',
      qualityRequestVersion: 0,
      qualityRetryValue: '128',
      loadingQualityChange: false,
      isReplacingQualitySource: false,
      pendingSongOptions: null,
      loadingSongTarget: null,
      loadingSongOptions: null,
      loadingSongTransition: 'select',
      songAbortController: null,
      audioSourceVersion: 0,
      playbackStopVersion: 0,
      songRequestId: 0,
      lyricRequestId: 0,
      lyricViewRequestId: 0,
      pendingLyricView: false,
      pendingTimers: new Map()
    }
  },
  computed: {
    audioEffectsAvailable() { return Boolean(window.electronAPI?.audioEffects) && this.audioEffectsStatus?.supported !== false },
    isFavorite() { return this.musicLibrary?.isFavorite(this.currentSong) || false },
    favoritePending() { return this.musicLibrary?.isFavoritePending(this.currentSong) || false },
    cloudCurrentSource() { return this.currentSong?.source === 'cloud' },
    qualitySwitchAvailable() { return (this.pendingSong || this.loadingSongTarget || this.currentSong || this.song)?.source !== 'cloud' },
    presentedSong() { return this.presentedPlaybackSnapshot?.song || this.currentSong },
    presentedDuration() { return this.presentedPlaybackSnapshot?.duration ?? this.duration },
    presentedTime() {
      // Low-frequency UI dependency; animation/IPC callers use the uncached reader.
      void this.currentTime
      return this.readPresentedTime()
    },
    presentedTrackTransition() { return this.presentedPlaybackSnapshot?.transition || this.trackTransition },
    presentedLyricPlaceholder() { return this.presentedPlaybackSnapshot?.placeholder ?? this.isLyricPlaceholder },
    displayLyric() {
      const snapshot = this.presentedPlaybackSnapshot
      return processLyricContent(snapshot?.lyrics ?? this.currentLyrics, snapshot?.lyricData ?? this.currentLyricData,
        this.settingsStore?.settings?.playback || {})
    },
    qualityDropdownOptions() {
      return this.qualityOptions.map(option => ({ ...option, label: option.name || option.label, description: option.detail }))
    },
    // 底栏预览最新选择；会话、歌词和音源身份仍只读取已确认的 currentSong。
    barSong() {
      return this.pendingSong || this.loadingSongTarget || this.currentSong || this.failedSong
    },
    isSongPending() {
      return Boolean(this.pendingSong || this.loadingSongTarget)
    },
    barSongIsUnconfirmed() {
      return !this.samePlaybackSource(this.barSong, this.currentSong)
    },
    barTrackTransition() {
      return this.pendingSong ? this.pendingSongTransition
        : this.loadingSongTarget ? this.loadingSongTransition : this.trackTransition
    },
    songLoadingText() {
      if (this.pendingSong) return '正在加载歌曲…'
      if (this.loadingQualityChange) return '正在切换音质…'
      return this.songLoadStage || '正在加载歌曲…'
    },
    qualityPreference() {
      return normalizePlaybackQuality(this.settingsStore?.settings?.playback?.quality)
    },
    qualityStatus() {
      if (this.loadingQualityChange || this.pendingSongOptions?.qualityChange) return '正在切换…'
      if (this.barSongIsUnconfirmed) return this.isSongPending ? '音源加载中…' : '音源未加载'
      if (this.cloudCurrentSource) return this.currentQuality?.confirmed ? `云盘原文件 · ${this.currentQuality.label}` : '云盘原文件'
      return this.currentQuality?.confirmed ? `实际音质 · ${this.currentQuality.label}` : '音源未提供音质信息'
    },
    qualityFeedback() {
      return [this.qualityMessage, this.qualitySaveMessage].filter(Boolean).join(' ')
    },
    displayPlayTime() {
      return this.seekPreviewTime ?? this.currentTime
    },
    progressPercent() {
      if (this.duration === 0) return 0
      return (this.displayPlayTime / this.duration) * 100
    },
    playModeText() {
      const modeMap = {
        loop: '列表循环',
        single: '单曲循环',
        shuffle: '随机播放'
      }
      return modeMap[this.playMode]
    },
    playModeMenuItems() {
      return [
        {
          label: '单曲循环',
          icon: this.repeatOneIcon,
          action: () => this.setPlayMode('single')
        },
        {
          label: '列表循环',
          icon: this.repeatAllIcon,
          action: () => this.setPlayMode('loop')
        },
        {
          label: '随机播放',
          icon: this.shuffleIcon,
          action: () => this.setPlayMode('shuffle')
        }
      ]
    }
  },
  watch: {
    'settingsStore.settings.playback.preloadNextTrack'() { this.invalidateNextPreparation() },
    'settingsStore.settings.playback.quality'() { this.invalidateNextPreparation() },
    'settingsStore.settings.playback.skipTrailingSilence'() { this.requestTailAnalysis() },
    'settingsStore.settings.playback.smoothTrackSwitch'(enabled) { if (!enabled) this.audioTransition?.settle() },
    playNextQueue: { deep: true, handler() { this.$nextTick(() => this.refreshNextPreparation()) } },
    shuffledPlaylist() { this.$nextTick(() => this.refreshNextPreparation()) },
    playMode() { this.$nextTick(() => this.refreshNextPreparation()) },
    'settingsStore.settings.playback.syncPlayHistory'() {
      this.listeningHistory?.syncEnabled()
      this.sampleListeningHistory()
    },
    displayLyric() {
      if (!this.isDisposed && this.currentSong?.hash === this.loadedSongHash) this.sendLyricsToDesktop(this.currentLyrics, this.currentLyricData)
    },
    'settingsStore.settings.playback.lyricLibrary.enabled'() {
      if (this.currentSong?.hash && !this.isDisposed) this.loadLyric(this.currentSong)
    },
    'settingsStore.settings.playback.romanization'() {
      if (!this.isDisposed && this.currentSong?.hash === this.loadedSongHash) this.sendLyricsToDesktop(this.currentLyrics, this.currentLyricData)
    },
    song: {
      handler(newSong) {
        if (!newSong || this.isDisposed) return
        if (this.samePlaybackSource(this.currentSong, newSong) && this.loadedSongHash === newSong.hash &&
            this.getActiveAudio()?.getAttribute('src') && !this.pendingSong &&
            !this.isLoadingSong && !this.isSwitchingSong) return
        const restoreState = !this.hasRequestedInitialSong && this.initialPlaybackState?.songHash === newSong.hash
          ? this.initialPlaybackState : null
        this.hasRequestedInitialSong = true
        this.requestSong(newSong, 'select', restoreState ? { restoreState } : {})
      },
      immediate: true
    },
    isSwitchingSong(isSwitching) {
      if (!isSwitching && !this.isDisposed) {
        this.drainPendingSong()
        if (this.pendingLyricView) this.showLyrics()
      }
    },
    // 监听播放列表变化
    playlist: {
      handler(newPlaylist, oldPlaylist) {
        try {
          if (!Array.isArray(newPlaylist)) {
            logger.error('MusicPlayer', '播放列表不是数组:', newPlaylist)
            return
          }
          
          // 只在开发环境输出详细日志
          if (process.env.NODE_ENV === 'development') {
            logger.trace('MusicPlayer', '播放列表更新:', newPlaylist.length, '首歌曲')
          }
          
          // 如果播放列表被完全清空，重置相关状态
          if (newPlaylist.length === 0) {
            this.stopPlayback()
            this.currentIndex = 0
            this.playedHistory = []
            this.shuffledPlaylist = []
            // 安全地停止当前播放并清理音频状态
            if (this.getActiveAudio()) {
              this.getActiveAudio().pause()
              this.getActiveAudio().currentTime = 0
            }
            this.isPlaying = false
            this.currentTime = 0
            this.duration = 0
            if (process.env.NODE_ENV === 'development') {
              logger.trace('MusicPlayer', '播放列表已清空，重置状态')
            }
            return
          }
          
          const songIndex = newPlaylist.findIndex(song => this.samePlaybackSource(song, this.currentSong))
          if (songIndex !== -1) this.currentIndex = songIndex
          this.$nextTick(() => this.refreshNextPreparation())
          // 同长度替换也可能改变歌曲顺序，随机队列需同步更新。
          const oldLength = oldPlaylist ? oldPlaylist.length : 0
          if (oldLength !== newPlaylist.length || oldPlaylist !== newPlaylist) {
            // 播放列表变化时不重置历史记录,只确保 currentIndex 在有效范围内
            if (this.currentIndex >= newPlaylist.length) {
              this.currentIndex = Math.max(0, newPlaylist.length - 1)
              if (process.env.NODE_ENV === 'development') {
                logger.trace('MusicPlayer', '调整 currentIndex 到有效范围:', this.currentIndex)
              }
            }
            
            // 如果在随机播放模式下，重新生成随机播放列表
            if (this.playMode === 'shuffle' && newPlaylist.length > 0) {
              // 使用 nextTick 异步处理，避免阻塞UI
              this.$nextTick(() => {
                if (this.isDisposed) return
                this.generateShuffledPlaylist()
                if (process.env.NODE_ENV === 'development') {
                  logger.trace('MusicPlayer', '播放列表变化，重新生成随机播放列表')
                }
              })
            }
          }
        } catch (error) {
          logger.error('MusicPlayer', '处理播放列表变化时出错:', error)
        }
      },
      deep: false // 改为浅比较，提高性能
    },
    // 监听当前播放索引变化，记录播放顺序
    currentIndex: {
      handler(newIndex, oldIndex) {
        if (newIndex !== -1 && oldIndex !== newIndex && !this.isNavigatingHistory && !this.isSwitchingSong) {
          // 如果我们在历史中间，需要截断后面的历史
          if (this.historyPointer !== -1) {
            this.playOrderHistory = this.playOrderHistory.slice(0, this.historyPointer + 1)
          }
          
          // 只有真正切换歌曲时才记录（避免重复记录）
          const lastRecordedIndex = this.playOrderHistory[this.playOrderHistory.length - 1]
          if (lastRecordedIndex !== newIndex) {
            this.playOrderHistory.push(newIndex)
            // 限制历史记录长度为200,避免内存占用过多
            // 注意:这不会影响播放列表本身,只是限制"上一曲"功能的历史深度
            if (this.playOrderHistory.length > 200) {
              this.playOrderHistory.shift()
            }
            logger.trace('MusicPlayer', '记录播放顺序历史:', newIndex, '历史长度:', this.playOrderHistory.length)
          }
          
          // 重置指针到最新位置
          this.historyPointer = -1
        }
        
        // 注意：不在这里通知父组件，避免与 loadSong 中的通知重复触发
        // 父组件同步由 loadSong 成功后统一通过 'song-changed' 事件进行
      }
    }
  },
  mounted() {
    this.playbackLifecycleListener = () => this.checkPlaybackLifecycle()
    window.addEventListener('focus', this.playbackLifecycleListener)
    document.addEventListener('visibilitychange', this.playbackLifecycleListener)
    this.playbackPollTimer = setInterval(this.playbackLifecycleListener, 100)
    this.cacheReadyUnsubscribe = getPlaylistCacheAPI()?.onSourceReady?.(event => {
      if (event?.hash?.toLowerCase() === this.currentSong?.hash?.toLowerCase() &&
          event.quality === this.loadedQualityPreference &&
          (event.source === 'cloud') === (this.currentSong?.source === 'cloud') &&
          (event.source !== 'cloud' || String(event.sourceUserId) === String(this.currentSong.sourceUserId))) this.requestTailAnalysis()
    }) || null
    this.lyricLibraryUnsubscribe = window.electronAPI?.lyricLibrary?.onChanged?.(event => {
      if (event?.reason !== 'online' && event?.hash?.toLowerCase() === this.currentSong?.hash?.toLowerCase() && !this.isDisposed) {
        this.loadLyric(this.currentSong, { refresh: false })
      }
    }) || null
    if (process.env.NODE_ENV === 'development') {
      logger.trace('MusicPlayer', '🎵 [MusicPlayer] 组件已挂载')
      logger.trace('MusicPlayer', '🎵 [MusicPlayer] audioPlayer ref 状态:', !!this.getActiveAudio())
    }
    
    // 添加全局错误处理
    this.$nextTick(() => {
      if (this.isDisposed) return
      if (process.env.NODE_ENV === 'development') {
        logger.trace('MusicPlayer', '🎵 [MusicPlayer] nextTick 后 audioPlayer ref 状态:', !!this.getActiveAudio())
      }
      
      // 标记组件为已准备就绪
      this.isComponentReady = true
      if (process.env.NODE_ENV === 'development') {
        logger.trace('MusicPlayer', '🎵 [MusicPlayer] 组件已准备就绪')
      }
      try {
        // 从 localStorage 恢复音量和播放模式
        const savedVolume = localStorage.getItem('player_volume')
        if (savedVolume !== null && Number.isFinite(Number(savedVolume))) {
          this.volume = Math.max(0, Math.min(100, Number(savedVolume)))
        }
        if (this.getActiveAudio()) {
          this.getActiveAudio().volume = this.volume / 100
        }
        
        const savedMode = localStorage.getItem('player_mode')
        if (savedMode && ['loop', 'single', 'shuffle'].includes(savedMode)) {
          this.playMode = savedMode
        }
        if (this.playMode === 'shuffle') this.generateShuffledPlaylist()
        
        // 初始化系统媒体控制
        this.initMediaSessionHandlers()
        
        // 监听来自系统托盘的播放器控制事件
        this.initTrayPlayerControlListener()
        
        // 启动 RAF 循环进行高频时间更新
        this.startTimeUpdate()
      } catch (error) {
        logger.error('MusicPlayer', 'MusicPlayer mounted 初始化错误:', error)
      } finally {
        this.drainPendingSong()
      }
    })
  },
  beforeUnmount() {
    this.listeningHistory?.dispose()
    this.listeningHistory = null
    window.electronAPI?.setLyricViewVisible?.(false)
    this.lyricLibraryUnsubscribe?.()
    this.lyricLibraryUnsubscribe = null
    this.clearDesktopPlayback()
    this.isDisposed = true
    clearInterval(this.playbackPollTimer)
    window.removeEventListener?.('focus', this.playbackLifecycleListener)
    document.removeEventListener?.('visibilitychange', this.playbackLifecycleListener)
    this.cacheReadyUnsubscribe?.()
    this.tailAnalyzer?.dispose()
    this.cancelNextPreparation()
    this.audioTransition?.settle()
    this.playbackStopVersion++
    this.seekPreviewTime = null
    this.isDragging = false
    this.isComponentReady = false
    this.pendingSong = null
    this.pendingSongOptions = null
    this.replacingPlaybackSnapshot = null
    this.loadingSongOptions = null
    this.pendingSongTransition = 'select'
    this.pendingLyricView = false
    this.songRequestId++
    this.songAbortController?.abort()
    this.qualityRequestVersion++
    this.audioSourceVersion++
    this.lyricRequestId++
    this.lyricViewRequestId++
    this.clearPendingTimers()
    this.isPlaying = false
    this.loadedSongHash = null
    // 组件销毁前停止 RAF 循环
    this.stopTimeUpdate()
    
    // 清理音频元素
    for (const slot of [0, 1]) if (this.getAudioDeck(slot)) this.releaseAudioDeck(this.getAudioDeck(slot))
    this.releaseAllCacheSources()
    for (const lease of this.mediaSourceLeases) this.releaseMediaSource(lease)
    this.audioEffectsUnsubscribe?.()
    this.audioEffectsUnsubscribe = null
    this.audioEffectsEngine?.dispose().catch(error => logger.warn('MusicPlayer', '释放音频效果引擎失败', { name: error?.name, code: error?.code }))
    
    // 清理定时器
    if (this.switchSongDebounceTimer) {
      clearTimeout(this.switchSongDebounceTimer)
    }
    
    // 清理系统托盘控制监听器
    if (this.trayControlUnsubscribe) {
      this.trayControlUnsubscribe()
      this.trayControlUnsubscribe = null
    }
    this.clearMediaSessionHandlers()
    if (window.electronAPI?.updatePlaybackState) window.electronAPI.updatePlaybackState(false)
    contextMenuManager.unregisterMenu(this.closePlayModeMenu)
  },
  methods: {
    /** One graph serves both media decks; unavailable native capabilities preserve ordinary playback. */
    ensureAudioEffects() {
      const api = window.electronAPI?.audioEffects
      if (!api?.getStatus || !api?.connectAudio || !api?.acquireMedia || this.isDisposed) return Promise.resolve(null)
      if (this.audioEffectsInit) return this.audioEffectsInit
      this.audioEffectsInitializing = true
      this.audioEffectsInit = (async () => {
        if (!this.audioEffectsUnsubscribe) this.audioEffectsUnsubscribe = api.onStatus?.(state => this.acceptAudioEffectsStatus(state)) || null
        this.acceptAudioEffectsStatus(await api.getStatus())
        if (this.isDisposed || this.audioEffectsStatus?.supported === false) return null
        const engine = this.audioEffectsEngine || createAudioEffectsEngine({ api,
          onStatus: state => {
            if (!this.isDisposed && state.error) this.audioEffectsError = typeof state.error === 'string'
              ? state.error : state.error.message || '音频效果暂不可用，已恢复原声。'
            else if (!this.isDisposed && state.ready === true) this.audioEffectsError = ''
          },
          onPresentation: () => { if (!this.isDisposed) this.refreshPresentedPlayback() }
        })
        // Retain the pending engine so unmount can abort its port handshake immediately.
        this.audioEffectsEngine = engine
        await engine.init()
        if (this.isDisposed) return null
        engine.setMaster(this.volume / 100, this.isMuted)
        for (const slot of [0, 1]) {
          const audio = this.getAudioDeck(slot)
          if (!audio) continue
          audio.crossOrigin = 'anonymous'
          await engine.attach(audio)
          if (this.isDisposed) return null
        }
        this.applyDeckVolume()
        this.applyAudioEffectsStatus()
        this.syncAudioEffectsTrack()
        if (engine.ready !== false) this.audioEffectsError = ''
        return engine
      })().catch(error => {
        if (!this.isDisposed) {
          if (this.audioEffectsEngine?.graphReady) {
            this.applyDeckVolume()
            this.syncAudioEffectsTrack()
          }
          this.audioEffectsError = error?.message || '音频效果初始化失败，继续播放原声。'
          logger.warn('MusicPlayer', '音频效果初始化失败，保留原声', { name: error?.name, code: error?.code })
        }
        return this.audioEffectsEngine
      }).finally(() => { this.audioEffectsInitializing = false })
      return this.audioEffectsInit
    },
    acceptAudioEffectsStatus(state) {
      if (this.isDisposed || !state || !Number.isInteger(state.revision) || state.revision < (this.audioEffectsStatus?.revision ?? -1)) return
      const previous = this.audioEffectsStatus
      this.audioEffectsStatus = state
      this.applyAudioEffectsStatus()
      if (this.audioEffectsInit && !this.audioEffectsInitializing && !this.audioEffectsEngine?.graphReady &&
          state.running && !previous?.running) {
        this.audioEffectsInit = null
        this.ensureAudioEffects()
      }
    },
    applyAudioEffectsStatus() {
      const engine = this.audioEffectsEngine
      const state = this.audioEffectsStatus
      if (!engine || !state) return
      const enabled = state.appliedEnabled ?? state.enabled
      const chain = state.appliedChain ?? state.chain
      const wet = enabled === true && chain?.some(item => !item.bypassed && !item.missing) === true
      if (wet !== this.audioEffectsWet) { this.audioEffectsWet = wet; engine.setEnabled(wet) }
      if (state.tempo?.trackId === this.audioEffectsTrack) engine.setTempo({ bpm: state.tempo.bpm, automatic: state.tempo.manualBpm == null })
    },
    audioEffectsIdentity(song = this.currentSong) {
      return `${localStorage.getItem('kugou_userid') || 'guest'}:${librarySongKey(song)}`
    },
    /** Publish only the committed audible deck; a speculative candidate never becomes the BPM source. */
    syncAudioEffectsTrack() {
      const audio = this.getActiveAudio()
      const engine = this.audioEffectsEngine
      if (!engine || !audio || !this.currentSong || this.loadedSongHash !== this.currentSong.hash || !audio.getAttribute('src')) return
      const trackId = this.audioEffectsIdentity()
      if (this.audioEffectsDeck !== audio || this.audioEffectsTrack !== trackId) {
        // A paused startup must not be mistaken for a song that has actually played.
        if (audio.paused) {
          engine.clearActiveTrack()
          this.audioEffectsDeck = null
          this.audioEffectsTrack = null
          return
        }
        if (engine.setActiveTrack({ audio, trackId, position: audio.currentTime, playing: !this.desktopAudioWaiting }) === false) return
        this.audioEffectsDeck = audio
        this.audioEffectsTrack = trackId
        this.applyAudioEffectsStatus()
      } else this.syncAudioEffectsTransport()
    },
    syncAudioEffectsTransport(seeking = false) {
      const audio = this.getActiveAudio()
      if (!audio || this.audioEffectsDeck !== audio) return
      this.audioEffectsEngine?.transport({ position: audio.currentTime,
        playing: !audio.paused && !audio.ended && !audio.seeking && !this.desktopAudioWaiting,
        ended: audio.ended === true, seeking })
    },
    presentationTime(audio = this.getActiveAudio()) {
      const raw = Number.isFinite(audio?.currentTime) ? Math.max(0, audio.currentTime) : this.currentTime
      return this.audioEffectsEngine?.getPresentationTime(audio, raw) ?? raw
    },
    readPresentedTime() {
      const snapshot = this.presentedPlaybackSnapshot
      const presentation = this.audioEffectsEngine?.getPresentedPlayback?.()
      return snapshot && presentation?.token === snapshot.token
        ? Math.max(0, Math.min(snapshot.duration || Infinity, presentation.position)) : this.currentTime
    },
    /** Keep audible metadata separately while the shared effect bus still contains an earlier input. */
    capturePresentedPlayback() {
      const engine = this.audioEffectsEngine
      const token = engine?.activePresentationToken
      if (!this.audioEffectsWet || !engine?.graphReady || !Number.isSafeInteger(token) || !this.currentSong) return
      const snapshot = { token, song: this.currentSong, detail: this.loadedSongDetail,
        lyrics: this.currentLyrics, lyricData: this.currentLyricData, placeholder: this.isLyricPlaceholder,
        duration: this.duration, transition: this.trackTransition, playbackInstanceId: this.playbackInstanceId }
      this.presentedPlaybackSnapshots.set(token, snapshot)
      if (!this.presentedPlaybackSnapshot) this.presentedPlaybackSnapshot = snapshot
    },
    refreshPresentedPlayback() {
      if (this.isDisposed) return
      const engine = this.audioEffectsEngine
      const presentation = engine?.getPresentedPlayback?.()
      const previous = this.presentedPlaybackSnapshot
      const snapshot = presentation && presentation.token !== engine.activePresentationToken
        ? this.presentedPlaybackSnapshots.get(presentation.token) || null : null
      this.presentedPlaybackSnapshot = snapshot
      for (const token of this.presentedPlaybackSnapshots.keys()) {
        if (!presentation || token < presentation.token || presentation.token === engine.activePresentationToken) this.presentedPlaybackSnapshots.delete(token)
      }
      if (previous?.token !== snapshot?.token) {
        this.cancelProgressDrag()
        this.beginListeningHistory()
        this.syncDesktopTrack()
        this.sendLyricsToDesktop(this.currentLyrics, this.currentLyricData)
        if (this.presentedSong) this.updateMediaSession(this.presentedSong)
        this.$emit('playback-state-changed')
      }
      this.syncDesktopTime()
    },
    clearPresentedPlayback() {
      this.presentedPlaybackSnapshot = null
      this.presentedPlaybackSnapshots.clear()
    },
    setDeckGain(audio, amount) {
      if (!audio) return
      if (this.audioEffectsEngine?.setDeckGain(audio, amount)) return
      audio.volume = Math.max(0, Math.min(1, this.volume / 100 * amount))
      audio.muted = this.isMuted
    },
    releaseMediaSource(leaseId) {
      if (!leaseId || !this.mediaSourceLeases.delete(leaseId)) return
      Promise.resolve().then(() => window.electronAPI?.audioEffects?.releaseMedia(leaseId)).catch(error => {
        logger.warn('MusicPlayer', '释放音频流租约失败', { name: error?.name, code: error?.code })
      })
    },
    openAudioEffects() {
      if (!this.audioEffectsAvailable || this.isDisposed) return
      this.showLyricView = false
      this.showPlaylist = false
      this.$emit('openAudioEffects')
    },
    getAudioDeck(slot) { return slot === 1 ? this.$refs.audioStandby : this.$refs.audioPlayer },
    getActiveAudio() { return this.getAudioDeck(this.activeAudioSlot) },
    isActiveMediaEvent(event) { return !event?.target || event.target === this.getActiveAudio() },
    handleDeckEvent(event) {
      if (!this.isActiveMediaEvent(event) || this.isDisposed ||
          this.candidateAudioSlot === this.activeAudioSlot) return
      const handlers = { loadedmetadata: 'handleLoadedMetadata', ended: 'handleEnded', play: 'handlePlay',
        pause: 'handlePause', timeupdate: 'handleTimeUpdate', waiting: 'handleDesktopClockChange',
        playing: 'handleDesktopClockChange', seeking: 'handleDesktopClockChange', ratechange: 'handleDesktopClockChange',
        seeked: 'handleSeeked', error: 'handleAudioError' }
      if (event.type === 'seeking') {
        if (this.naturalLoopSeek?.audio === event.target && this.naturalLoopSeek.version === this.audioSourceVersion) return
        this.getAudioTransition().settle()
        this.resetAutomaticAdvance()
      }
      this[handlers[event.type]]?.(event)
    },
    /** The outgoing deck owns its cache lease until its final audible sample has been retired. */
    releaseAudioDeck(audio) {
      const slot = audio === this.getAudioDeck(1) ? 1 : 0
      this.deckVersions[slot]++
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
      this.setDeckGain(audio, 0)
      const mediaLease = this.deckMediaLeases[slot]
      this.deckMediaLeases[slot] = null
      this.releaseMediaSource(mediaLease)
      const lease = this.deckLeases[slot]
      this.deckLeases[slot] = null
      if (lease && lease !== this.cacheSourceLeaseId) this.releaseCacheSource(lease)
    },
    getAudioTransition() {
      if (!this.audioTransition) this.audioTransition = createPlaybackTransition({
        getVolume: () => this.volume / 100, getMuted: () => this.isMuted,
        setGain: (audio, amount) => this.setDeckGain(audio, amount),
        release: audio => this.releaseAudioDeck(audio),
        finished: () => this.$nextTick(() => this.refreshNextPreparation())
      })
      return this.audioTransition
    },
    applyDeckVolume() {
      this.audioEffectsEngine?.setMaster(this.volume / 100, this.isMuted)
      this.getAudioTransition().volumeChanged(this.getActiveAudio(),
        this.candidateAudioSlot === null ? this.preparedNext && this.getAudioDeck(this.preparedNext.slot)
          : this.getAudioDeck(this.candidateAudioSlot))
    },
    preparationKey(song, quality) {
      return `${librarySongKey(song)}:${quality}:${getPlaylistCacheSessionVersion()}:${this.preloadRevision}`
    },
    isPreparationValid(preparation) {
      return !this.isDisposed && !preparation.controller.signal.aborted &&
        preparation.sessionVersion === getPlaylistCacheSessionVersion() &&
        this.deckVersions[preparation.slot] === preparation.deckVersion
    },
    /** Share cache/URL/readiness work between immediate selection and one speculative next song. */
    createSongPreparation(song, quality, slot, options = {}, controller = new AbortController()) {
      const audio = this.getAudioDeck(slot)
      const preparation = { song, quality, slot, controller, key: this.preparationKey(song, quality),
        sessionVersion: getPlaylistCacheSessionVersion(), deckVersion: ++this.deckVersions[slot],
        leaseId: null, mediaLeaseId: null, ready: false, detail: song, committed: false }
      const valid = () => this.isPreparationValid(preparation)
      const wait = operation => waitForPlaybackOperation(operation, { signal: controller.signal })
      const readCache = async allowFallback => {
        let lookupActive = true
        try {
          return await wait(this.readCachedSource(song, quality, allowFallback, () => lookupActive && valid(),
            lease => { preparation.leaseId = lease }))
        } catch (error) {
          if (controller.signal.aborted) throw error
          logger.trace('MusicPlayer', '本地音源查询未完成，继续在线加载', { name: error?.name, code: error?.code })
          return null
        } finally { lookupActive = false }
      }
      preparation.promise = (async () => {
        let response = getPlaylistCacheAPI()?.getSource && !options.refreshCachedSource
          ? await readCache(Boolean(options.cachedNetworkFallback)) : null
        if (!valid()) throw Object.assign(new Error('歌曲加载已取消'), { name: 'AbortError' })
        if (!response && options.cachedNetworkFallback) throw new Error('在线音源连接中断，尚无可用离线缓存')
        if (!response) {
          try {
            if (song.source !== 'cloud' && !song.album_audio_id) {
              const detail = await wait(getSongDetail(song.hash, { signal: controller.signal }))
              if (detail?.status === 1 && detail.data?.length) preparation.detail = { ...song, ...detail.data[0] }
            }
            const detail = preparation.detail
            response = await wait(song.source === 'cloud' ? getCloudSongUrl(detail, { signal: controller.signal })
              : getSongUrl(detail.hash, detail.album_id || 0, detail.album_audio_id || 0, quality, { signal: controller.signal }))
          } catch (error) {
            if (!valid() || !this.isPlaybackNetworkFailure(error)) throw error
            response = await readCache(true)
            if (!response) throw error
          }
        }
        const install = async value => {
          if (!valid()) throw Object.assign(new Error('歌曲加载已取消'), { name: 'AbortError' })
          if (value?.status !== 1) throw new Error(this.getPlayErrorMessage(value))
          let url = Array.isArray(value.url) ? value.url[0] : value.url
          if (typeof url !== 'string' || !url) throw new Error(this.getPlayErrorMessage(value))
          url = url.replace(/^http:\/\//, 'https://')
          preparation.response = value
          preparation.detail = { ...preparation.detail, ...value.detail, hash: song.hash }
          const effectsAPI = window.electronAPI?.audioEffects
          if (effectsAPI?.acquireMedia) {
            await wait(this.ensureAudioEffects())
            if (!valid()) throw Object.assign(new Error('歌曲加载已取消'), { name: 'AbortError' })
            audio.crossOrigin = 'anonymous'
            if (/^https?:\/\//i.test(url)) {
              let acquisitionActive = true
              try {
                const acquisition = Promise.resolve(effectsAPI.acquireMedia({ url, identity: this.audioEffectsIdentity(song) })).then(source => {
                  if (source?.leaseId) this.mediaSourceLeases.add(source.leaseId)
                  if (!acquisitionActive || !valid()) { this.releaseMediaSource(source?.leaseId); return null }
                  if (preparation.mediaLeaseId) this.releaseMediaSource(preparation.mediaLeaseId)
                  preparation.mediaLeaseId = source?.leaseId || null
                  return source
                })
                const source = await wait(acquisition)
                if (!valid()) throw Object.assign(new Error('歌曲加载已取消'), { name: 'AbortError' })
                if (!source?.leaseId || typeof source.url !== 'string' || !source.url.startsWith('bk-audio://media/')) throw new Error('音频流连接失败，请重试。')
                url = source.url
              } finally { acquisitionActive = false }
            } else if (preparation.mediaLeaseId) {
              this.releaseMediaSource(preparation.mediaLeaseId)
              preparation.mediaLeaseId = null
            }
          }
          audio.pause()
          this.setDeckGain(audio, 0)
          this.deckLeases[slot] = preparation.leaseId
          const oldMediaLease = this.deckMediaLeases[slot]
          this.deckMediaLeases[slot] = preparation.mediaLeaseId
          if (oldMediaLease !== preparation.mediaLeaseId) this.releaseMediaSource(oldMediaLease)
          audio.src = url
          audio.currentTime = 0
          const ready = waitForPlaybackReady(audio, controller.signal)
          try { audio.load() } catch (error) {
            controller.abort()
            await ready.catch(() => {})
            throw error
          }
          await ready
        }
        try { await install(response) }
        catch (error) {
          if (preparation.leaseId || !valid() || !this.isPlaybackNetworkFailure(error)) throw error
          response = await readCache(true)
          if (!response) throw error
          await install(response)
        }
        preparation.ready = valid()
        return preparation
      })()
      // Preparation is speculative until adopted; callers own visible errors and navigation retries.
      preparation.promise.catch(() => {})
      return preparation
    },
    releasePreparation(preparation) {
      if (!preparation || preparation.committed) return
      preparation.controller.abort()
      if (this.deckVersions[preparation.slot] === preparation.deckVersion) this.releaseAudioDeck(this.getAudioDeck(preparation.slot))
      this.releaseCacheSource(preparation.leaseId)
      this.releaseMediaSource(preparation.mediaLeaseId)
    },
    cancelNextPreparation() {
      const preparation = this.preparedNext
      this.preparedNext = null
      this.releasePreparation(preparation)
    },
    peekNavigation(direction = 1, target = this.currentSong, attempted = []) {
      return selectPlaybackCandidate({ playlist: this.playlist, shuffledPlaylist: this.shuffledPlaylist,
        playMode: this.playMode, priority: this.playNextQueue, target, direction, attempted, key: librarySongKey })
    },
    /** Never consume the priority queue or publish/cache a song while preparing the next source. */
    refreshNextPreparation() {
      if (this.isDisposed || this.isLoadingSong || this.isSwitchingSong || this.pendingSong || this.audioTransition?.active) return
      const enabled = this.settingsStore?.settings?.playback?.preloadNextTrack !== false
      const audio = this.getActiveAudio()
      const candidate = enabled && this.currentSong && this.loadedCacheSessionVersion === getPlaylistCacheSessionVersion() &&
        audio?.getAttribute('src') && !audio.paused
        ? this.peekNavigation()?.song : null
      if (!candidate || this.samePlaybackSource(candidate, this.currentSong)) { this.cancelNextPreparation(); return }
      const quality = candidate.source === 'cloud' ? 'original' : this.qualityPreference
      const key = this.preparationKey(candidate, quality)
      if (this.preparedNext?.key === key) return
      this.cancelNextPreparation()
      const preparation = this.createSongPreparation(candidate, quality, 1 - this.activeAudioSlot)
      this.preparedNext = preparation
      preparation.promise.catch(error => {
        if (this.preparedNext?.deckVersion !== preparation.deckVersion || this.preparedNext?.slot !== preparation.slot) return
        // Keep a failed marker until the target/context changes, avoiding high-frequency background retries.
        preparation.failed = true
        this.releasePreparation(preparation)
        if (error?.name !== 'AbortError') logger.trace('MusicPlayer', '下一首预缓冲未完成', { name: error?.name, code: error?.code })
      })
    },
    invalidateNextPreparation() {
      this.preloadRevision++
      this.cancelNextPreparation()
      this.$nextTick(() => this.refreshNextPreparation())
    },
    publishActivePlayback() {
      const audio = this.getActiveAudio()
      this.isPlaying = !!audio && !audio.paused
      this.syncAudioEffectsTrack()
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = this.isPlaying ? 'playing' : 'paused'
      window.electronAPI?.updatePlaybackState?.(this.isPlaying)
      this.updatePositionState()
      this.syncDesktopTime(true)
    },
    resetAutomaticAdvance() {
      this.automaticAdvanceVersion = null
      this.lastNaturalPosition = null
      this.naturalAdvanceSinceSeek = 0
    },
    /** Tail trim, natural crossfade and ended share one cancellable automatic transition per active source. */
    maybeAdvanceAutomatically(ended = false) {
      const audio = this.getActiveAudio()
      if (this.isDisposed || !audio || !this.currentSong || this.isLoadingSong || this.isSwitchingSong || this.pendingSong ||
          this.isDragging || this.seekPreviewTime !== null || audio.seeking || this.automaticAdvanceVersion === this.audioSourceVersion) return
      if (!ended && (audio.paused || audio.readyState < 3 || this.desktopAudioWaiting)) return
      const position = audio.currentTime
      if (Number.isFinite(position) && this.lastNaturalPosition !== null) {
        const delta = position - this.lastNaturalPosition
        if (delta > 0 && delta < 1) this.naturalAdvanceSinceSeek += delta
        else if (delta < 0 || delta >= 1) this.naturalAdvanceSinceSeek = 0
      }
      this.lastNaturalPosition = position
      const silent = this.settingsStore?.settings?.playback?.skipTrailingSilence !== false &&
        this.tailAnalysis && this.naturalAdvanceSinceSeek >= 0.25 && position >= this.tailAnalysis.skipAt
      const next = this.peekNavigation()?.song
      const ready = next && this.preparedNext?.ready && !this.preparedNext.controller.signal.aborted &&
        this.preparedNext.key === this.preparationKey(next, next.source === 'cloud' ? 'original' : this.qualityPreference)
      const remaining = audio.duration - position
      const naturalFade = this.playMode !== 'single' && this.settingsStore?.settings?.playback?.smoothTrackSwitch !== false &&
        ready && remaining > 0 && remaining <= 0.6 && !this.samePlaybackSource(next, this.currentSong)
      if (!ended && !silent && !naturalFade) return
      this.automaticAdvanceVersion = this.audioSourceVersion
      if (this.playMode === 'single' || this.samePlaybackSource(next, this.currentSong)) {
        this.getAudioTransition().settle()
        this.capturePresentedPlayback()
        this.naturalLoopSeek = { audio, version: this.audioSourceVersion }
        audio.currentTime = 0
        // A natural repeat is another input segment, not a user seek: retain
        // queued effect samples and let its new zero-point reach the output.
        this.audioEffectsEngine?.setActiveTrack({ audio, trackId: this.audioEffectsIdentity(), position: 0,
          playing: true, continuous: true })
        this.currentTime = this.presentationTime(audio)
        this.resetAutomaticAdvance()
        this.playbackInstanceId++
        this.beginListeningHistory()
        audio.play().catch(error => logger.error('MusicPlayer', '单曲循环重播失败:', error))
        this.refreshPresentedPlayback()
        this.syncDesktopTime(true, { discontinuity: true })
      } else this.playNext('auto')
    },
    requestTailAnalysis() {
      const version = ++this.tailAnalysisVersion
      this.tailAnalysis = null
      this.tailAnalyzer?.cancel()
      const audio = this.getActiveAudio()
      const api = getPlaylistCacheAPI()
      if (this.isDisposed || this.settingsStore?.settings?.playback?.skipTrailingSilence === false ||
          !this.currentSong || !audio || !api?.getSource || !api?.releaseSource ||
          this.loadedCacheSessionVersion !== getPlaylistCacheSessionVersion()) return
      if (!this.tailAnalyzer) this.tailAnalyzer = createTrailingSilenceAnalyzer({
        getSource: request => this.readTailAnalysisSource(request),
        releaseSource: lease => getPlaylistCacheAPI()?.releaseSource(lease),
        onError: error => logger.trace('MusicPlayer', '尾静音分析不可用', { name: error?.name, code: error?.code })
      })
      const sourceVersion = this.audioSourceVersion
      const sessionVersion = getPlaylistCacheSessionVersion()
      this.tailAnalyzer.request(this.currentSong, this.loadedQualityPreference, audio.duration, sessionVersion).then(result => {
        if (!this.isDisposed && version === this.tailAnalysisVersion && sourceVersion === this.audioSourceVersion &&
            sessionVersion === getPlaylistCacheSessionVersion()) this.tailAnalysis = result
      }).catch(error => logger.trace('MusicPlayer', '尾静音分析未完成', { name: error?.name }))
    },
    /** Analysis must describe this actual format/bitrate, not merely the saved quality preference. */
    async readTailAnalysisSource(request) {
      const sessionVersion = getPlaylistCacheSessionVersion()
      const version = this.tailAnalysisVersion
      const quality = this.currentQuality
      if (!quality?.format || !quality.confirmed) return null
      const lossless = ['flac', 'wav', 'ape', 'alac'].includes(quality.format)
      if (!lossless && !quality.bitrate) return null
      const api = await waitForPlaylistCacheSession()
      if (this.isDisposed || version !== this.tailAnalysisVersion || sessionVersion !== getPlaylistCacheSessionVersion()) return null
      const source = await api?.getSource?.(request)
      const actual = readPlaybackQuality(source)
      if (this.isDisposed || version !== this.tailAnalysisVersion || sessionVersion !== getPlaylistCacheSessionVersion() ||
          actual.format !== quality.format || (!lossless && actual.bitrate !== quality.bitrate) ||
          (actual.bitrate && quality.bitrate && actual.bitrate !== quality.bitrate)) {
        if (source?.leaseId) await api.releaseSource(source.leaseId)
        return null
      }
      return source
    },
    /** Lifecycle polling is sparse; only an active 150/600ms envelope has a 16ms timer. */
    checkPlaybackLifecycle() {
      if (this.isDisposed) return
      this.audioTransition?.refresh()
      if (this.preparedNext && this.preparedNext.sessionVersion !== getPlaylistCacheSessionVersion()) this.invalidateNextPreparation()
      if (this.loadedCacheSessionVersion !== getPlaylistCacheSessionVersion()) {
        this.tailAnalysis = null
        this.tailAnalyzer?.cancel()
      }
      this.maybeAdvanceAutomatically()
      this.refreshNextPreparation()
    },
    samePlaybackSource(left, right) {
      const key = librarySongKey(left)
      return !!key && key === librarySongKey(right)
    },
    /** A new confirmed play starts listening credit; replacements retain the existing play instance. */
    beginListeningHistory(preserve = false) {
      if (this.isDisposed) return
      const snapshot = this.presentedPlaybackSnapshot
      const instanceId = snapshot?.playbackInstanceId ?? this.playbackInstanceId
      if (!preserve && this.listeningHistory && this.listeningHistoryInstanceId === instanceId) return
      if (!this.listeningHistory) this.listeningHistory = createListeningHistory({
        getIdentity: () => ({ userId: localStorage.getItem('kugou_userid'), token: localStorage.getItem('kugou_token') }),
        isEnabled: () => this.settingsStore?.settings?.playback?.syncPlayHistory !== false,
        upload: uploadPlayHistory,
        onFailure: details => logger.warn('MusicPlayer', '听歌历史同步失败', details),
      })
      this.listeningHistory.begin(snapshot?.detail || snapshot?.song || this.loadedSongDetail || this.currentSong, { preserve })
      this.listeningHistoryInstanceId = instanceId
    },
    sampleListeningHistory() {
      if (this.isDisposed || !this.listeningHistory) return
      const audio = this.getActiveAudio()
      const confirmed = !!audio && !!this.currentSong && this.loadedSongHash === this.currentSong.hash &&
        !this.isReplacingQualitySource && !this.replacingPlaybackSnapshot
      const presentation = this.audioEffectsWet && this.audioEffectsEngine?.getPresentedPlayback?.()
      this.listeningHistory.sample({ position: presentation ? presentation.position : audio?.currentTime,
        duration: presentation ? this.presentedDuration : audio?.duration,
        playing: confirmed && (presentation ? presentation.advancing && (!audio.paused || audio.ended) : !audio.paused && !audio.ended),
        ready: confirmed && (presentation ? true : audio.readyState >= 3),
        seeking: !!audio?.seeking && !this.naturalLoopSeek,
        waiting: presentation ? false : this.desktopAudioWaiting, rate: audio?.playbackRate || 1 })
    },
    /** 租约独立于账号会话释放；旧音源在成功换源或停止之前始终保持可读。 */
    releaseCacheSource(leaseId) {
      if (!leaseId || !this.cacheSourceLeases.delete(leaseId)) return
      try {
        Promise.resolve(getPlaylistCacheAPI()?.releaseSource?.(leaseId)).catch(error => {
          logger.warn('MusicPlayer', '释放本地音源失败', { name: error?.name, code: error?.code })
        })
      } catch (error) {
        logger.warn('MusicPlayer', '释放本地音源失败', { name: error?.name, code: error?.code })
      }
    },

    releaseAllCacheSources() {
      this.cacheSourceLeaseId = null
      for (const leaseId of this.cacheSourceLeases) this.releaseCacheSource(leaseId)
    },

    /** 迟到、取消或换账号的查询必须归还租约，不能把候选文件留成正在播放。 */
    async readCachedSource(song, quality, allowFallback, isCurrent, onLease) {
      try {
        const api = await waitForPlaylistCacheSession()
        if (!api?.getSource || !isCurrent()) return null
        const source = await api.getSource({ hash: song.hash, quality, allowFallback,
          ...(song.source === 'cloud' ? { source: 'cloud', sourceUserId: song.sourceUserId } : {}) })
        if (source?.leaseId) this.cacheSourceLeases.add(source.leaseId)
        if (!isCurrent() || source?.status !== 1 || typeof source.url !== 'string' || !source.url) {
          this.releaseCacheSource(source?.leaseId)
          return null
        }
        onLease(source.leaseId || null)
        return source
      } catch (error) {
        logger.warn('MusicPlayer', '读取本地音源失败', { name: error?.name, code: error?.code })
        return null
      }
    },

    isPlaybackNetworkFailure(error) {
      if (error?.code === 'KUGOU_AUTH_EXPIRED') return false
      const data = error?.response?.data
      if (data?.priv_status === 0 || data?.error_code || data?.data?.error_code) return false
      return ['ERR_NETWORK', 'ECONNABORTED', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'EAI_AGAIN'].includes(error?.code) ||
        [502, 503, 504].includes(error?.response?.status)
    },

    createPlaybackMediaError(audio, message) {
      const error = new Error(message)
      if (audio?.error?.code === 2) error.code = 'ERR_NETWORK'
      return error
    },

    /** 已提交在线音源发生明确网络错误时，以原进度和播放意图换成本地源。 */
    handleAudioError() {
      const audio = this.getActiveAudio()
      if (this.isDisposed || this.isLoadingSong || this.pendingSong || !audio || audio.error?.code !== 2 ||
          this.cacheSourceLeaseId || this.loadedSongHash !== this.currentSong?.hash ||
          !getPlaylistCacheAPI()?.getSource) return
      this.requestSong(this.currentSong, this.trackTransition, {
        quality: this.loadedQualityPreference || this.qualityPreference,
        qualityChange: true,
        cachedNetworkFallback: true,
        restoreState: { songHash: this.currentSong.hash, currentTime: audio.currentTime, isPlaying: this.isPlaying }
      })
    },

    /** 只在已确认音源实际播放后入队；暂停恢复和待选歌曲都不能触发下载。 */
    cachePlayedSong(recacheLyrics = false) {
      const audio = this.getActiveAudio()
      if (this.isDisposed || !audio || audio.paused || !this.currentSong?.hash ||
          this.loadedSongHash !== this.currentSong.hash || this.isLoadingSong ||
          this.loadedCacheSessionVersion !== getPlaylistCacheSessionVersion()) return
      const song = this.loadedSongDetail || this.currentSong
      const version = this.loadedCacheSessionVersion
      const quality = song.source === 'cloud' ? 'original' : this.loadedQualityPreference || this.qualityPreference
      const songKey = `${version}:${song.hash}`
      this.playedCacheSongs.add(songKey)
      const key = `${songKey}:${quality}`
      if (!this.queuedCacheSongs.has(key)) {
        this.queuedCacheSongs.add(key)
        Promise.resolve().then(async () => {
          const api = await waitForPlaylistCacheSession()
          if (this.isDisposed || version !== getPlaylistCacheSessionVersion() || !api?.cacheSong) {
            this.queuedCacheSongs.delete(key)
            return
          }
          await api.cacheSong({ song: cloneDeep(song), quality })
        }).catch(error => {
          logger.warn('MusicPlayer', '保存已播放歌曲缓存失败', { name: error?.name, code: error?.code })
        }).finally(() => this.queuedCacheSongs.delete(key))
      }
      if (recacheLyrics) this.currentLyricsFromCache = false
      this.cachePlayedLyrics()
    },

    /** 原歌词响应包含翻译；仅持久化当前已播放歌曲的真实歌词。 */
    cachePlayedLyrics() {
      const data = this.currentLyricData
      const hash = this.currentSong?.hash
      const version = this.loadedCacheSessionVersion
      if (!hash || !data || this.isLyricPlaceholder || this.currentLyricsFromCache || this.currentLyricsFromLibrary || this.cachedLyricData === data ||
          this.loadedSongHash !== hash || version !== getPlaylistCacheSessionVersion() ||
          !this.playedCacheSongs.has(`${version}:${hash}`)) return
      this.cachedLyricData = data
      Promise.resolve().then(async () => {
        const api = await waitForPlaylistCacheSession()
        if (this.isDisposed || version !== getPlaylistCacheSessionVersion() || !api?.putLyrics) {
          if (this.cachedLyricData === data) this.cachedLyricData = null
          return
        }
        await api.putLyrics({ hash, data: cloneDeep(data) })
      }).catch(error => {
        logger.warn('MusicPlayer', '保存已播放歌词缓存失败', { name: error?.name, code: error?.code })
      }).finally(() => { if (this.cachedLyricData === data) this.cachedLyricData = null })
    },

    /** 只读动画时钟绕过界面进度节流；换源和回滚期间不泄漏临时音源的零时间。 */
    getAnimationPlaybackTime() {
      const audio = this.getActiveAudio()
      if (this.isDisposed || this.isReplacingQualitySource || this.replacingPlaybackSnapshot ||
          !audio || !Number.isFinite(audio.currentTime)) return this.currentTime
      return this.presentedPlaybackSnapshot ? this.readPresentedTime() : this.presentationTime(audio)
    },

    /** Expose the audible mix to the full-screen animation without starting an audio graph or timer. */
    readBackgroundBeat() {
      return this.audioEffectsEngine?.readBackgroundBeat() ?? 0
    },
    stopBackgroundBeat() {
      this.audioEffectsEngine?.stopBackgroundBeat()
    },

    /** 仅采集已确认歌曲；替换音源期间沿用替换前的状态，避免临时零值污染会话。 */
    getPlaybackSnapshot() {
      const audio = this.getActiveAudio()
      if (this.isDisposed || !audio || !this.currentSong || this.loadedSongHash !== this.currentSong.hash) return null
      const previous = this.replacingPlaybackSnapshot
      const playback = previous?.hash === this.currentSong.hash ? previous : {
        time: this.presentationTime(audio), duration: audio.duration, playing: !audio.paused
      }
      return {
        currentSong: this.presentedSong,
        playbackState: {
          isPlaying: playback.playing,
          currentTime: Number.isFinite(this.presentedPlaybackSnapshot ? this.readPresentedTime() : playback.time)
            ? Math.max(0, this.presentedPlaybackSnapshot ? this.readPresentedTime() : playback.time) : 0,
          duration: Number.isFinite(this.presentedDuration) ? Math.max(0, this.presentedDuration) : 0,
          volume: this.volume,
          playMode: this.playMode
        }
      }
    },

    /** 将选歌及动效来源一起排队，并使尚未完成的歌曲及歌词响应失效。 */
    requestSong(song, transition = 'select', options = {}) {
      if (!song?.hash || this.isDisposed) return Promise.resolve(false)
      // Retry navigation is still the user's original action: a later pause must survive unavailable tracks.
      if (!options.preservePlaybackIntent) {
        this.playbackIntentVersion++
        this.desiredPlaying = options.restoreState ? options.restoreState.isPlaying === true
          : options.qualityChange ? !this.getActiveAudio()?.paused : true
      }
      options = { ...options, playbackIntentVersion: this.playbackIntentVersion }
      this.songLoadError = ''
      this.failedSong = null
      this.failedSongOptions = null
      this.cancelProgressDrag()
      this.pendingSong = song
      this.pendingSongTransition = transition
      this.pendingSongOptions = options
      this.songRequestId++
      this.songAbortController?.abort()
      return this.drainPendingSong()
    },

    /** 在挂载及切歌完成后顺序加载最新请求，避免忙时丢失选歌。 */
    async drainPendingSong() {
      if (this.isDisposed || !this.isComponentReady || !this.getActiveAudio() ||
          this.isLoadingSong || this.isSwitchingSong || !this.pendingSong) return false
      const song = this.pendingSong
      const transition = this.pendingSongTransition
      const options = this.pendingSongOptions || {}
      this.pendingSong = null
      this.pendingSongOptions = null
      this.pendingSongTransition = 'select'
      return this.loadSong(song, transition, options)
    },

    isCurrentSongRequest(requestId) {
      return !this.isDisposed && requestId === this.songRequestId
    },

    /** Prepare a separate deck, then atomically publish it; cancellation leaves the playing source intact. */
    async loadSong(song, transition = 'select', options = {}) {
      const previousAudio = this.getActiveAudio()
      if (!song?.hash || this.isDisposed || !previousAudio || this.isLoadingSong) return false
      this.cancelProgressDrag()
      this.naturalLoopSeek = null
      this.getAudioTransition().settle()
      const qualityChange = Boolean(options.qualityChange && this.samePlaybackSource(this.currentSong, song) &&
        this.loadedSongHash === song.hash && previousAudio.getAttribute('src'))
      const requestedQuality = song.source === 'cloud' ? 'original' : normalizePlaybackQuality(options.quality ?? this.qualityPreference)
      const restoreState = options.restoreState?.songHash === song.hash ? options.restoreState : null
      const replaying = !qualityChange && this.samePlaybackSource(this.currentSong, song) &&
        this.loadedSongHash === song.hash && previousAudio.getAttribute('src')
      this.isLoadingSong = true
      this.loadingSongHash = song.hash
      this.loadingSongTarget = song
      this.loadingSongOptions = options
      this.loadingSongTransition = transition
      this.loadingQualityChange = qualityChange
      this.songLoadStage = '正在获取音源…'
      this.songLoadError = ''
      this.failedSong = null
      this.failedSongOptions = null
      if (qualityChange) this.qualityMessage = ''
      const requestId = ++this.songRequestId
      const intentVersion = options.playbackIntentVersion ?? this.playbackIntentVersion
      if (options.playbackIntentVersion === undefined) {
        this.desiredPlaying = restoreState ? restoreState.isPlaying === true : qualityChange ? !previousAudio.paused : true
      }
      let preparation = null
      let committed = false
      let failed = false
      let controller = new AbortController()
      this.songAbortController = controller
      try {
        if (restoreState) {
          if (Number.isFinite(restoreState.volume)) {
            this.volume = Math.max(0, Math.min(100, restoreState.volume))
            this.isMuted = this.volume === 0
            this.applyDeckVolume()
          }
          if (['loop', 'single', 'shuffle'].includes(restoreState.playMode)) {
            this.playMode = restoreState.playMode
            if (this.playMode === 'shuffle') this.generateShuffledPlaylist()
          }
        }
        if (replaying) {
          this.cancelNextPreparation()
          const restarting = previousAudio.ended || options.restartFromBeginning
          if (restarting) {
            previousAudio.currentTime = 0
            this.currentTime = 0
            this.resetAutomaticAdvance()
            this.updatePositionState()
          }
          if (this.desiredPlaying && (previousAudio.paused || previousAudio.ended)) {
            await waitForPlaybackOperation(previousAudio.play(), { signal: controller.signal, audio: previousAudio })
          }
          if (!this.isCurrentSongRequest(requestId)) return false
          if (restarting) { this.playbackInstanceId++; this.beginListeningHistory() }
          const index = this.playlist.findIndex(item => this.samePlaybackSource(item, song))
          if (index !== -1) this.currentIndex = index
          if (options.navigation && !this.samePlaybackSource(this.song, song)) this.$emit('song-changed', this.currentSong)
          committed = true
          return true
        }
        const prepared = this.preparedNext
        if (!options.refreshCachedSource && !options.cachedNetworkFallback && prepared &&
            prepared.key === this.preparationKey(song, requestedQuality) && !prepared.controller.signal.aborted) {
          preparation = prepared
          this.preparedNext = null
          preparation.adopted = true
          controller = preparation.controller
          this.songAbortController = controller
        } else {
          this.cancelNextPreparation()
          const slot = this.currentSong && previousAudio.getAttribute('src') ? 1 - this.activeAudioSlot : this.activeAudioSlot
          preparation = this.createSongPreparation(song, requestedQuality, slot, options, controller)
        }
        this.candidateAudioSlot = preparation.slot
        await preparation.promise
        if (!this.isCurrentSongRequest(requestId) || !this.isPreparationValid(preparation)) return false
        const incoming = this.getAudioDeck(preparation.slot)
        this.songLoadStage = '正在缓冲音频…'
        // Sample the old deck after preparation: seeks and pause changes remain authoritative throughout loading.
        const targetTime = restoreState ? restoreState.currentTime : qualityChange ? previousAudio.currentTime : 0
        if (Number.isFinite(targetTime)) incoming.currentTime = Math.max(0,
          Number.isFinite(incoming.duration) ? Math.min(targetTime, incoming.duration) : targetTime)
        this.setDeckGain(incoming, 0)
        if (this.desiredPlaying) {
          try {
            await waitForPlaybackOperation(incoming.play(), { signal: controller.signal, audio: incoming })
          } catch (error) {
            // An explicit pause while play was pending cancels autoplay, not the selected song.
            if (!controller.signal.aborted && this.playbackIntentVersion !== intentVersion && !this.desiredPlaying &&
                error?.name === 'AbortError' && !incoming.error) incoming.pause()
            else if (!preparation.leaseId && this.isPlaybackNetworkFailure(error) && this.isCurrentSongRequest(requestId)) {
              const slot = preparation.slot
              this.releasePreparation(preparation)
              controller = new AbortController()
              this.songAbortController = controller
              preparation = this.createSongPreparation(song, requestedQuality, slot, { cachedNetworkFallback: true }, controller)
              await preparation.promise
              if (!this.isCurrentSongRequest(requestId)) return false
              const resumeTime = restoreState ? restoreState.currentTime : qualityChange ? previousAudio.currentTime : 0
              incoming.currentTime = Math.max(0, Number.isFinite(resumeTime) ? resumeTime : 0)
              if (this.desiredPlaying) await waitForPlaybackOperation(incoming.play(), { signal: controller.signal, audio: incoming })
            } else throw error
          }
        }
        if (!this.isCurrentSongRequest(requestId) || !this.isPreparationValid(preparation)) return false
        if (!this.desiredPlaying) incoming.pause()
        const previousLease = this.cacheSourceLeaseId
        const outgoing = this.currentSong && previousAudio !== incoming ? previousAudio : null
        this.capturePresentedPlayback()
        this.activeAudioSlot = preparation.slot
        this.candidateAudioSlot = null
        this.audioSourceVersion++
        this.loadedSongHash = song.hash
        this.loadedQualityPreference = song.source === 'cloud' ? 'original'
          : preparation.leaseId ? normalizePlaybackQuality(preparation.response.requestedQuality || requestedQuality) : requestedQuality
        this.loadedSongDetail = preparation.detail
        this.loadedCacheSessionVersion = preparation.sessionVersion
        this.cacheSourceLeaseId = preparation.leaseId
        this.currentQuality = readPlaybackQuality(preparation.response)
        this.qualityMessage = ''
        this.desktopAudioWaiting = incoming.readyState < 3
        this.isPlaying = !incoming.paused
        this.currentTime = incoming.currentTime
        this.duration = Number.isFinite(incoming.duration) && incoming.duration > 0 ? incoming.duration : 0
        committed = true
        preparation.committed = true
        this.resetAutomaticAdvance()
        if (qualityChange) this.listeningHistory?.discontinuity()
        else {
          this.trackTransition = transition
          this.currentSong = song
          const index = this.playlist.findIndex(item => this.samePlaybackSource(item, song))
          if (index !== -1) this.currentIndex = index
          this.currentLyrics = ''
          this.isLyricPlaceholder = true
          this.currentLyricData = null
          this.cachedLyricData = null
          this.currentLyricsFromCache = false
          this.playbackInstanceId++
          this.beginListeningHistory()
          this.syncDesktopTrack(preparation.detail)
          this.updateMediaSession(preparation.detail)
          this.checkFavoriteStatus()
          if (this.playMode === 'shuffle' && !this.playedHistory.includes(this.currentIndex)) this.playedHistory.push(this.currentIndex)
          this.loadLyric(preparation.detail)
          this.$emit('song-changed', this.currentSong)
        }
        const smooth = this.settingsStore?.settings?.playback?.smoothTrackSwitch !== false
        const duration = smooth && !qualityChange ? transition === 'auto' ? 600 : 150 : 0
        this.getAudioTransition().start(incoming, outgoing, duration)
        if (!outgoing && previousLease !== preparation.leaseId) this.releaseCacheSource(previousLease)
        this.publishActivePlayback()
        this.refreshPresentedPlayback()
        this.requestTailAnalysis()
        return true
      } catch (error) {
        if (!this.isCurrentSongRequest(requestId) || controller.signal.aborted) return false
        failed = true
        logger.error('MusicPlayer', '加载歌曲失败:', error)
        const message = error.response?.data?.error_msg || error.response?.data?.msg || error.message
        if (qualityChange) this.qualityMessage = `音质切换失败：${message}。已保留原音源。`
        else {
          this.failedSong = song
          this.failedSongOptions = { quality: requestedQuality, ...(restoreState ? { restoreState } : {}) }
          this.songLoadError = `“${getSongSearchKeyword(song) || '所选歌曲'}”加载失败：${message}`
          this.showError(this.songLoadError)
        }
        return false
      } finally {
        if (!committed && preparation) this.releasePreparation(preparation)
        if (this.songAbortController === controller) this.songAbortController = null
        controller.abort()
        this.candidateAudioSlot = null
        this.isLoadingSong = false
        this.loadingQualityChange = false
        this.isReplacingQualitySource = false
        this.replacingPlaybackSnapshot = null
        this.loadingSongHash = null
        this.loadingSongTarget = null
        this.loadingSongOptions = null
        this.songLoadStage = ''
        if (failed && !this.pendingSong && this.currentSong && this.samePlaybackSource(this.song, song) &&
            !this.samePlaybackSource(this.currentSong, song)) this.$emit('song-changed', this.currentSong)
        if (!this.isDisposed) {
          this.syncDesktopTime(true)
          if (committed) {
            this.cachePlayedSong()
            if (options.restartFromBeginning) this.$emit('playback-state-changed')
            this.$nextTick(() => this.refreshNextPreparation())
          }
          if (failed && options.navigation && !this.pendingSong &&
              options.navigation.stopVersion === this.playbackStopVersion &&
              options.navigation.attemptedSongs.length < Math.min(5, this.playlist.length)) {
            if (this.isCurrentSongRequest(requestId)) return await this.queueNavigation(options.navigation.direction,
              options.navigation.transition, { ...options.navigation, target: song })
          }
          this.$nextTick(() => this.drainPendingSong())
        }
      }
    },

    /** 切换偏好与当前音源；最后一次选择优先，正在选中的下一首不会被旧歌覆盖。 */
    changeQuality(value) {
      if (!this.qualitySwitchAvailable) return Promise.resolve(false)
      const quality = normalizePlaybackQuality(value)
      if (this.isDisposed || quality !== value) return Promise.resolve(false)
      const version = ++this.qualityRequestVersion
      this.qualityRetryValue = quality
      this.qualitySaveMessage = ''
      const settingsStore = this.settingsStore || useSettingsStore()
      Promise.resolve(settingsStore.updateSettings({ playback: { quality } })).catch(error => {
        if (this.isDisposed || version !== this.qualityRequestVersion) return
        this.qualitySaveMessage = '音质偏好保存失败，请重新选择重试。'
        logger.error('MusicPlayer', '保存音质偏好失败:', error)
      })
      const target = this.pendingSong || this.loadingSongTarget || this.currentSong || this.song
      if (!target?.hash) return Promise.resolve(false)
      const targetOptions = this.pendingSong ? this.pendingSongOptions
        : this.loadingSongTarget ? this.loadingSongOptions : null
      const transition = this.pendingSong ? this.pendingSongTransition
        : this.loadingSongTarget ? this.loadingSongTransition : this.trackTransition
      // 再选正在使用的缓存档位时允许联网重试，避免服务降级的缓存永久占据该偏好。
      const confirmedLease = this.replacingPlaybackSnapshot ? this.replacingPlaybackSnapshot.leaseId : this.cacheSourceLeaseId
      const refreshCachedSource = Boolean(this.samePlaybackSource(target, this.currentSong) && this.loadedSongHash === target.hash &&
        confirmedLease && this.loadedQualityPreference === quality && !targetOptions?.cachedNetworkFallback)
      return this.requestSong(target, transition, { ...targetOptions, quality, refreshCachedSource,
        qualityChange: this.samePlaybackSource(target, this.currentSong) && this.loadedSongHash === target.hash })
    },

    retryQualityChange() {
      return this.changeQuality(this.qualityRetryValue)
    },

    /** 记录切歌重试等待，使组件卸载时能够释放定时器和等待者。 */
    waitForDelay(milliseconds) {
      if (this.isDisposed) return Promise.resolve(false)
      return new Promise(resolve => {
        const timer = setTimeout(() => {
          this.pendingTimers.delete(timer)
          resolve(true)
        }, milliseconds)
        this.pendingTimers.set(timer, resolve)
      })
    },

    clearPendingTimers() {
      for (const [timer, resolve] of this.pendingTimers) {
        clearTimeout(timer)
        if (resolve) resolve(false)
      }
      this.pendingTimers.clear()
    },

    /** 清空队列时立即使异步加载失效并释放当前音源。 */
    stopPlayback() {
      this.naturalLoopSeek = null
      this.clearPresentedPlayback()
      this.audioEffectsEngine?.clearActiveTrack()
      this.audioEffectsTrack = null
      this.audioEffectsDeck = null
      this.listeningHistory?.reset()
      this.listeningHistoryInstanceId = null
      this.cancelProgressDrag()
      this.playbackStopVersion++
      this.songRequestId++
      this.songAbortController?.abort()
      this.clearPendingTimers()
      this.audioSourceVersion++
      this.playbackIntentVersion++
      this.desiredPlaying = false
      this.cancelNextPreparation()
      this.audioTransition?.settle()
      this.tailAnalysisVersion++
      this.tailAnalysis = null
      this.tailAnalyzer?.cancel()
      this.resetAutomaticAdvance()
      this.lyricRequestId++
      this.lyricViewRequestId++
      this.pendingSong = null
      this.pendingSongOptions = null
      this.loadingSongOptions = null
      this.loadingSongTarget = null
      this.songLoadStage = ''
      this.songLoadError = ''
      this.failedSong = null
      this.failedSongOptions = null
      this.replacingPlaybackSnapshot = null
      this.pendingSongTransition = 'select'
      this.trackTransition = 'select'
      this.pendingLyricView = false
      for (const slot of [0, 1]) if (this.getAudioDeck(slot)) this.releaseAudioDeck(this.getAudioDeck(slot))
      this.releaseAllCacheSources()
      for (const lease of this.mediaSourceLeases) this.releaseMediaSource(lease)
      this.isPlaying = false
      this.currentSong = null
      this.loadedSongHash = null
      this.currentQuality = null
      this.loadedQualityPreference = null
      this.loadedSongDetail = null
      this.loadedCacheSessionVersion = null
      this.qualityMessage = ''
      this.currentTime = 0
      this.duration = 0
      this.currentLyrics = ''
      this.isLyricPlaceholder = true
      this.currentLyricData = null
      this.cachedLyricData = null
      this.currentLyricsFromCache = false
      this.playNextQueue = []
      this.playedHistory = []
      this.shuffledPlaylist = []
      this.playOrderHistory = []
      this.historyPointer = -1
      this.clearDesktopPlayback()
    },

    /** 重试最后失败的选择，继续复用请求代次、取消与音源回滚流程。 */
    retrySongLoad() {
      if (this.failedSong && !this.isSongPending) return this.requestSong(this.failedSong, 'select', this.failedSongOptions || {})
    },

    // 显示错误提示（非弹窗）
    showError(message) {
      logger.warn('MusicPlayer', '', message)
      // TODO: 可以在这里添加一个非阻塞的提示组件
      // 例如 Toast 提示
    },
    
    // 获取播放错误信息
    getPlayErrorMessage(response) {
      if (!response) {
        return '获取播放地址失败，请检查网络连接'
      }
      
      if (response.error_msg) return response.error_msg
      // 检查版权和VIP限制
      if (response.priv_status === 0) {
        return '该歌曲需要VIP权限或存在版权限制'
      }
      if (response.status !== 1 && response.msg) return response.msg
      
      if (response.error_code) {
        return `播放失败: ${response.error_msg || response.error_code}`
      }
      
      if (response.fail_process && response.fail_process.length > 0) {
        return '该歌曲暂时无法播放，可能是版权限制'
      }
      
      return '无法获取歌曲播放地址，请稍后重试'
    },
    
    /** 先读用户所选版本，再回退离线/在线歌词；后台更新沿歌曲和账号代次隔离，不阻塞已有正文。 */
    async loadLyric(song, { refresh = true } = {}) {
      if (!song?.hash || this.isDisposed) return
      this.isLyricPlaceholder = true
      const requestId = ++this.lyricRequestId
      const isCurrentRequest = () => !this.isDisposed && requestId === this.lyricRequestId &&
        this.currentSong?.hash === song.hash
      const sessionVersion = getPlaylistCacheSessionVersion()
      let lyricsFromCache = false
      let libraryRecord = null
      const library = window.electronAPI?.lyricLibrary
      const libraryEnabled = () => this.settingsStore?.settings?.playback?.lyricLibrary?.enabled !== false
      const fetchOnline = () => getLyric(song.hash, song.album_audio_id || 0, '', { song })
      const fetchLyrics = async () => {
        if (library?.read && libraryEnabled()) {
          try {
            libraryRecord = await library.read(song.hash)
            if (!isCurrentRequest()) return null
            const selected = libraryRecord?.versions?.find(version => version.id === libraryRecord.selectedVersionId)
            if (selected?.data && libraryEnabled()) return selected.data
            libraryRecord = null
          } catch (error) {
            logger.warn('MusicPlayer', '读取歌词库失败，继续加载歌词', { name: error?.name, message: error?.message })
          }
        }
        if (!getPlaylistCacheAPI()?.readLyrics) return fetchOnline()
        try {
          const api = await waitForPlaylistCacheSession()
          if (!isCurrentRequest()) return null
          if (api?.readLyrics && sessionVersion === getPlaylistCacheSessionVersion()) {
            const cached = await api.readLyrics(song.hash)
            if (!isCurrentRequest() || sessionVersion !== getPlaylistCacheSessionVersion()) return null
            if (cached && [1, 200].includes(cached.status) &&
                [cached.decodeContent, cached.content, cached.data?.content].some(value => typeof value === 'string' && value.trim())) {
              lyricsFromCache = true
              return cached
            }
          }
        } catch (error) {
          logger.warn('MusicPlayer', '读取本地歌词失败，继续在线加载', { name: error?.name, code: error?.code })
        }
        if (!isCurrentRequest() || sessionVersion !== getPlaylistCacheSessionVersion()) return null
        return fetchOnline()
      }
      let timeoutId = null
      try {
        if (process.env.NODE_ENV === 'development') {
          logger.trace('MusicPlayer', '开始加载歌词，歌曲信息:', {
            hash: song.hash,
            album_audio_id: song.album_audio_id
          })
        }
        
        // 设置超时和重试机制
        const lyricResponse = await Promise.race([
          fetchLyrics(),
          new Promise((_, reject) => {
            timeoutId = setTimeout(() => reject(new Error('歌词加载超时')), 10000)
            this.pendingTimers.set(timeoutId, null)
          })
        ])
        if (!isCurrentRequest()) return
        if (sessionVersion !== getPlaylistCacheSessionVersion()) return
        this.currentLyricsFromCache = lyricsFromCache
        this.currentLyricsFromLibrary = Boolean(libraryRecord)
        
        if (process.env.NODE_ENV === 'development') {
          logger.trace('MusicPlayer', '歌词API响应:', lyricResponse)
        }
        
        // 检查API响应状态 (可能是status: 200 或 status: 1)
        if (lyricResponse && (lyricResponse.status === 200 || lyricResponse.status === 1)) {
          // 保存完整的歌词数据（包含翻译信息）
          this.currentLyricData = lyricResponse
          
          if (process.env.NODE_ENV === 'development') {
            logger.trace('MusicPlayer', '🎵 歌词API完整响应:')
            logger.trace('MusicPlayer', '  - 响应状态:', lyricResponse.status)
            logger.trace('MusicPlayer', '  - 所有字段:', Object.keys(lyricResponse))
            logger.trace('MusicPlayer', '  - language字段存在:', 'language' in lyricResponse)
            logger.trace('MusicPlayer', '  - decodeContent存在:', 'decodeContent' in lyricResponse)
            if (lyricResponse.language) {
              logger.trace('MusicPlayer', '  - language字段内容:', lyricResponse.language.substring(0, 200))
            }
          }
          
          // 优先使用解码后的内容
          if (typeof lyricResponse.decodeContent === 'string' && lyricResponse.decodeContent.trim()) {
            this.currentLyrics = lyricResponse.decodeContent
            this.isLyricPlaceholder = false
            if (process.env.NODE_ENV === 'development') {
              logger.trace('MusicPlayer', '歌词加载成功（已解码），内容长度:', lyricResponse.decodeContent.length)
              logger.trace('MusicPlayer', '设置的歌词内容预览:', this.currentLyrics.substring(0, 200))
            }
            // 发送歌词到桌面歌词窗口
            this.sendLyricsToDesktop(this.currentLyrics, lyricResponse)
          } else if (typeof lyricResponse.content === 'string' && lyricResponse.content.trim()) {
            // 如果没有解码内容，尝试使用原始content（可能是base64编码）
            try {
              // 尝试base64解码
              const bytes = Uint8Array.from(atob(lyricResponse.content), character => character.charCodeAt(0))
              const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
              this.currentLyrics = decoded
              this.isLyricPlaceholder = !decoded.trim()
              if (process.env.NODE_ENV === 'development') {
                logger.trace('MusicPlayer', '歌词base64解码成功，内容长度:', decoded.length)
              }
              // 发送歌词到桌面歌词窗口
              this.sendLyricsToDesktop(this.currentLyrics, lyricResponse)
            } catch (e) {
              // 如果解码失败，直接使用原始内容
              this.currentLyrics = lyricResponse.content
              this.isLyricPlaceholder = false
              if (process.env.NODE_ENV === 'development') {
                logger.trace('MusicPlayer', '使用原始歌词内容，长度:', lyricResponse.content.length)
              }
              // 发送歌词到桌面歌词窗口
              this.sendLyricsToDesktop(this.currentLyrics, lyricResponse)
            }
          } else if (typeof lyricResponse.data?.content === 'string' && lyricResponse.data.content.trim()) {
            // 尝试从data.content获取
            this.currentLyrics = lyricResponse.data.content
            this.isLyricPlaceholder = false
            if (process.env.NODE_ENV === 'development') {
              logger.trace('MusicPlayer', '从data.content获取歌词成功')
            }
            // 发送歌词到桌面歌词窗口
            this.sendLyricsToDesktop(this.currentLyrics, lyricResponse)
          } else {
            // 打印完整响应以便调试
            if (process.env.NODE_ENV === 'development') {
              logger.trace('MusicPlayer', '完整歌词API响应:', JSON.stringify(lyricResponse, null, 2))
              logger.trace('MusicPlayer', '歌词内容为空，使用默认歌词')
            }
            this.setDefaultLyrics(song)
          }
          // 手动版本独立于离线缓存，避免关闭歌词库后仍从缓存读回编辑内容。
          if (!libraryRecord) this.cachePlayedLyrics()
          if (!this.isLyricPlaceholder && library?.saveOnline && libraryEnabled()) {
            const payload = data => ({
              hash: song.hash, title: getSongSearchKeyword(song),
              artist: getSongArtists(song).map(artist => artist.name).join('、'),
              sourceId: data.lyricSource?.id || '', matchLevel: data.lyricSource?.matchLevel || 'any', data
            })
            if (libraryRecord && refresh && this.settingsStore?.settings?.playback?.lyricLibrary?.autoUpdate !== false &&
                libraryRecord.versions.some(version => version.source === 'online')) {
              // 先显示已选版本；后台失败保留歌词，切歌/关闭管理/手动选择会使旧结果失效。
              void (async () => {
                try {
                  const response = await fetchOnline()
                  if (!isCurrentRequest() || !libraryEnabled() || sessionVersion !== getPlaylistCacheSessionVersion()) return
                  const updated = await library.saveOnline({ ...payload(response), mode: 'autoUpdate' })
                  if (!isCurrentRequest() || !libraryEnabled()) return
                  if (updated && updated.selectedVersionId !== libraryRecord.selectedVersionId) {
                    await this.loadLyric(song, { refresh: false })
                  }
                } catch (error) {
                  logger.warn('MusicPlayer', '后台更新歌词失败，保留已保存版本', { name: error?.name, message: error?.message })
                }
              })()
            } else if (!libraryRecord && lyricsFromCache && this.settingsStore?.settings?.playback?.lyricLibrary?.autoSave !== false) {
              // 历史缓存没有候选匹配信息；后台核实在线来源后才纳入歌词库。
              void (async () => {
                try {
                  const response = await fetchOnline()
                  if (!isCurrentRequest() || !libraryEnabled() || sessionVersion !== getPlaylistCacheSessionVersion()) return
                  const saved = await library.saveOnline({ ...payload(response), mode: 'autoSave' })
                  if (saved && isCurrentRequest() && libraryEnabled()) await this.loadLyric(song, { refresh: false })
                } catch (error) {
                  logger.warn('MusicPlayer', '补存在线歌词失败，保留离线歌词', { name: error?.name, message: error?.message })
                }
              })()
            } else if (!libraryRecord && !lyricsFromCache && isCurrentRequest()) {
              void library.saveOnline({ ...payload(lyricResponse), mode: 'autoSave' }).catch(error => {
                logger.warn('MusicPlayer', '自动保存歌词失败', { name: error?.name, message: error?.message })
              })
            }
          }
        } else {
          if (process.env.NODE_ENV === 'development') {
            logger.trace('MusicPlayer', '完整响应:', JSON.stringify(lyricResponse, null, 2))
            logger.trace('MusicPlayer', '歌词获取失败，状态:', lyricResponse?.status)
          }
          this.currentLyricData = null
          this.setDefaultLyrics(song)
        }
      } catch (error) {
        if (!isCurrentRequest()) return
        logger.error('MusicPlayer', '加载歌词失败:', error)
        
        // 根据错误类型提供不同的处理
        if (error.code === 'ERR_BAD_RESPONSE' || error.response?.status === 502) {
          logger.trace('MusicPlayer', 'API服务暂时不可用，使用默认歌词')
          this.setDefaultLyrics(song)
        } else {
          this.isLyricPlaceholder = true
          this.currentLyrics = '[00:00.00]歌词服务暂时不可用'
          this.currentLyricData = null
          // 也要发送默认歌词到桌面
          this.sendLyricsToDesktop(this.currentLyrics)
        }
      } finally {
        if (timeoutId !== null) {
          clearTimeout(timeoutId)
          this.pendingTimers.delete(timeoutId)
        }
      }
    },

    // 设置默认歌词
    setDefaultLyrics(song) {
      this.isLyricPlaceholder = true
      const songName = this.getSongName(song)
      const artistName = this.getSingerNames(song.singerinfo || song.singername)
      
      this.currentLyrics = `[00:00.00] 正在播放: ${songName}
[00:02.00] 作曲: ${artistName}
[00:04.00]
[00:06.00] 无法获取歌词
[00:08.00] 请欣赏
[00:10.00]
[00:30.00] 享受音乐带来的美好时光`
      this.currentLyricData = null
      
      // 发送默认歌词到桌面歌词窗口
      this.sendLyricsToDesktop(this.currentLyrics)
    },

    // 发送歌词到桌面歌词窗口
    sendLyricsToDesktop(lrcContent, rawLyricData = null) {
      const snapshot = this.presentedPlaybackSnapshot
      if (snapshot) { lrcContent = snapshot.lyrics; rawLyricData = snapshot.lyricData }
      if (!window.electronAPI || !window.electronAPI.updateLyrics) {
        logger.trace('MusicPlayer', '❌ electronAPI.updateLyrics 不可用')
        return
      }

      try {
        logger.trace('MusicPlayer', '🎵 开始解析歌词发送到桌面歌词窗口')
        logger.trace('MusicPlayer', '歌词内容长度:', lrcContent?.length)
        logger.trace('MusicPlayer', '歌词内容预览:', lrcContent?.substring(0, 300))
        
        if (!lrcContent) {
          logger.trace('MusicPlayer', '歌词内容为空，发送空数组')
          window.electronAPI.updateLyrics([], this.presentedSong?.hash || this.loadedSongHash)
          return
        }

        // 解析歌词内容，转换为桌面歌词所需的格式
        const parsedLyrics = this.parseLyricsForDesktop(lrcContent, rawLyricData)
        
        logger.trace('MusicPlayer', '🎵 解析完成，发送', parsedLyrics.length, '行歌词到桌面')
        logger.trace('MusicPlayer', '🎵 前3行歌词预览:', parsedLyrics.slice(0, 3))
        window.electronAPI.updateLyrics(parsedLyrics, this.presentedSong?.hash || this.loadedSongHash)
        this.syncDesktopTime(true)
      } catch (error) {
        logger.error('MusicPlayer', '❌ 发送歌词到桌面歌词窗口失败:', error)
      }
    },

    // 桌面窗口使用毫秒时间轴，原始译文与文本由纯解析器统一保留。
    parseLyricsForDesktop(lrcContent, rawLyricData = null) {
      const processed = processLyricContent(lrcContent, rawLyricData, this.settingsStore?.settings?.playback || {})
      const lines = parseDesktopLyrics(processed.content, processed.rawData)
      if (this.settingsStore?.settings?.playback?.romanization === 'on') {
        const readings = new Map(readLyricRomanization(processed.content, processed.rawData).map(line => [line.time, line.text]))
        // 桌面沿用其副行与翻译开关，未开启翻译时仍可独立显示发音。
        for (const line of lines) if (readings.has(line.time)) line.romanization = readings.get(line.time)
      }
      return lines
    },

    /** Only confirmed songs publish identity; metadata updates keep their existing timeline. */
    syncDesktopTrack(detail = this.currentSong) {
      if (!this.currentSong?.hash || this.loadedSongHash !== this.currentSong.hash) return
      const snapshot = this.presentedPlaybackSnapshot
      const song = snapshot ? { ...snapshot.song, ...snapshot.detail } : { ...this.currentSong, ...detail }
      const cover = song.cover || song.img || song.album_cover || null
      window.electronAPI?.updateTrack?.({
        trackId: song.hash,
        title: getSongSearchKeyword(song) || '未知歌曲',
        artist: getSongArtists(song).map(artist => artist.name).join('、') || '未知歌手',
        cover: typeof cover === 'string' ? cover.replace('{size}', '400') : null
      })
    },

    /** Continuous playback is throttled; seeks, pauses and source commits always send their final position. */
    syncDesktopTime(force = false, { discontinuity = false, freeze = false } = {}) {
      const audio = this.getActiveAudio()
      if (this.isDisposed || this.isReplacingQualitySource || this.replacingPlaybackSnapshot ||
          !this.loadedSongHash || this.loadedSongHash !== this.currentSong?.hash || !audio?.getAttribute('src') ||
          !Number.isFinite(audio.currentTime)) return
      const now = Date.now()
      if (!force && this.lastDesktopTimeUpdate != null && now - this.lastDesktopTimeUpdate < 150) return
      this.lastDesktopTimeUpdate = now
      const duration = this.presentedDuration
      const presentation = this.presentedPlaybackSnapshot && this.audioEffectsEngine?.getPresentedPlayback?.()
      window.electronAPI?.updatePlaybackTime?.((this.presentedPlaybackSnapshot ? this.readPresentedTime() : this.presentationTime(audio)) * 1000, {
        trackId: this.presentedSong?.hash || this.loadedSongHash,
        duration: Number.isFinite(duration) && duration > 0 ? duration * 1000 : 0,
        advancing: !freeze && (presentation ? presentation.advancing === true && !audio.paused
          : !this.desktopAudioWaiting && !audio.paused && !audio.seeking && !audio.ended && audio.readyState >= 3),
        playbackRate: Number.isFinite(audio.playbackRate) && audio.playbackRate > 0 ? audio.playbackRate : 1,
        discontinuity
      })
    },

    /** Buffering and seeking stop desktop interpolation immediately; only actual media readiness resumes it. */
    handleDesktopClockChange(event) {
      if (this.isDisposed) return
      if (event?.type === 'waiting') this.desktopAudioWaiting = true
      else if (event?.type === 'playing') this.desktopAudioWaiting = false
      this.listeningHistory?.discontinuity()
      if (event?.type === 'playing') this.sampleListeningHistory()
      this.syncAudioEffectsTransport(event?.type === 'seeking')
      this.syncDesktopTime(true, { discontinuity: event?.type === 'seeking', freeze: event?.type === 'seeking' })
    },

    /** A null track clears the main-process snapshot and any open or subsequently reopened desktop lyrics. */
    clearDesktopPlayback() {
      this.lastDesktopTimeUpdate = null
      this.desktopAudioWaiting = false
      window.electronAPI?.updateTrack?.(null)
    },

    // 播放/暂停
    togglePlay() {
      const audioEl = this.getActiveAudio()
      if (this.isDisposed || !audioEl || (!audioEl.getAttribute('src') && !this.isLoadingSong)) {
        logger.warn('MusicPlayer', '没有设置音频源')
        return
      }
      this.playbackIntentVersion++
      this.desiredPlaying = this.isLoadingSong ? !this.desiredPlaying : audioEl.paused
      this.getAudioTransition().settle()
      if (!this.desiredPlaying) {
        audioEl.pause()
        if (this.candidateAudioSlot !== null) this.getAudioDeck(this.candidateAudioSlot)?.pause()
        this.cancelNextPreparation()
      } else {
        if (!this.currentSong && this.isLoadingSong) return
        audioEl.play().catch(error => {
          logger.error('MusicPlayer', '播放失败:', error)
        })
      }
    },
    
    /** Navigation alone consumes a priority entry; preparation uses the same read-only selector. */
    queueNavigation(direction, transition = 'next', navigation = null) {
      const target = navigation?.target || this.pendingSong || this.loadingSongTarget || this.currentSong || this.song
      const attemptedSongs = new Set(navigation?.attemptedSongs || [])
      const selection = this.peekNavigation(direction, target, [...attemptedSongs])
      if (this.isDisposed || !selection) return Promise.resolve(false)
      const nextSong = selection.song
      if (selection.priority) {
        const index = this.playNextQueue.findIndex(item => this.samePlaybackSource(item, nextSong))
        this.playNextQueue.splice(0, index + 1)
        if (!this.playlist.some(item => this.samePlaybackSource(item, nextSong))) this.$emit('playlist-updated', [...this.playlist, nextSong])
      } else if (direction > 0 && this.playMode === 'shuffle' && transition !== 'auto') transition = 'shuffle'
      attemptedSongs.add(librarySongKey(nextSong))
      return this.requestSong(nextSong, direction < 0 ? 'previous' : transition, {
        preservePlaybackIntent: Boolean(navigation),
        navigation: { direction, transition, attemptedSongs: [...attemptedSongs], stopVersion: this.playbackStopVersion }
      })
    },

    /** Preserve the optional near-end previous/restart behavior against confirmed media time. */
    playPrevious() {
      if (this.isDisposed || this.playlist.length === 0) return Promise.resolve(false)
      const audio = this.getActiveAudio()
      if (!this.isLoadingSong && !this.pendingSong &&
          this.settingsStore.settings.playback.restartOnPreviousNearEnd === true &&
          this.currentSong?.hash === this.loadedSongHash && audio?.getAttribute('src') &&
          Number.isFinite(audio.duration) && audio.duration > 0 &&
          Number.isFinite(audio.currentTime) && audio.currentTime >= 0 &&
          audio.duration - audio.currentTime >= 0 && audio.duration - audio.currentTime <= 10) {
        return this.loadSong(this.currentSong, this.trackTransition, { restartFromBeginning: true })
      }
      return this.queueNavigation(-1)
    },
    playNext(source = 'next') {
      if (this.isDisposed || this.playlist.length === 0) return Promise.resolve(false)
      return this.queueNavigation(1, source === 'auto' ? 'auto' : 'next')
    },

    // RAF 驱动的高频时间更新（60fps）
    updateTimeLoop() {
      try {
        // 检查组件是否已卸载
        if (!this.$el || !this.getActiveAudio()) {
          return
        }
        
        const audioEl = this.getActiveAudio()
        if (!this.isReplacingQualitySource && audioEl && !isNaN(audioEl.currentTime)) {
          // 只在时间有明显变化时更新，减少不必要的响应式更新
          const newTime = this.presentationTime(audioEl)
          if (Math.abs(newTime - this.currentTime) > 0.1) {
            this.currentTime = newTime
          }
        }
        
        // 持续循环
        this.rafId = requestAnimationFrame(this.updateTimeLoop)
      } catch (error) {
        logger.error('MusicPlayer', '时间更新循环错误:', error)
        // 停止循环以防止连续错误
        this.stopTimeUpdate()
      }
    },
    
    // 启动时间更新循环
    startTimeUpdate() {
      if (!this.rafId) {
        this.rafId = requestAnimationFrame(this.updateTimeLoop)
      }
    },
    
    // 停止时间更新循环
    stopTimeUpdate() {
      if (this.rafId) {
        cancelAnimationFrame(this.rafId)
        this.rafId = null
      }
    },
    
    // 元数据加载完成
    handleLoadedMetadata() {
      if (this.isDisposed || this.isReplacingQualitySource || !this.getActiveAudio()) return
      const duration = this.getActiveAudio().duration
      this.duration = Number.isFinite(duration) && duration > 0 ? duration : 0
      // 初始化 MediaSession 位置状态
      this.updatePositionState()
    },
    
    // Only the actual active ended event can enter the shared automatic advance path.
    handleEnded(event) {
      const audio = this.getActiveAudio()
      if (!this.isActiveMediaEvent(event) || this.isDisposed || !audio?.ended || audio.seeking) return
      this.syncAudioEffectsTransport()
      this.maybeAdvanceAutomatically(true)
    },

    /** 两种布局共用拖动预览，歌词跟随显示时间，音源时间独立推进。 */
    handleProgressDrag(e) {
      const time = Number(e.target.value)
      if (this.isDisposed || this.isSwitchingSong || this.isLoadingSong || !Number.isFinite(time) ||
          !Number.isFinite(this.duration) || this.duration <= 0) return
      this.isDragging = true
      this.seekPreviewTime = Math.max(0, Math.min(this.duration, time))
    },
    
    // 进度条更改完成（释放鼠标时更改播放位置）
    handleProgressChange() {
      const time = this.seekPreviewTime
      this.seekPreviewTime = null
      this.isDragging = false
      if (time != null) this.handleSeek(time)
    },

    /** 取消后回到最新音频时间；没有待提交预览时忽略迟到的 change。 */
    cancelProgressDrag() {
      const hadPreview = this.isDragging || this.seekPreviewTime != null
      this.seekPreviewTime = null
      this.isDragging = false
      const audio = this.getActiveAudio()
      if (hadPreview && audio && Number.isFinite(audio.currentTime)) this.currentTime = this.presentationTime(audio)
    },
    
    /** 底栏、歌词与快捷键共用真实音量入口，并同步静音和持久化。 */
    handleVolumeChange(value = this.volume) {
      const audioEl = this.getActiveAudio()
      if (!audioEl || this.isDisposed) return
      if (value == null || String(value).trim() === '' || !Number.isFinite(Number(value))) return
      if (this.volume > 0) this.lastAudibleVolume = this.volume
      this.volume = Math.max(0, Math.min(100, Number(value)))
      if (this.volume > 0) this.lastAudibleVolume = this.volume
      this.isMuted = this.volume === 0
      this.applyDeckVolume()
      
      // 保存音量设置到 localStorage
      try {
        localStorage.setItem('player_volume', this.volume)
      } catch (error) {
        logger.warn('MusicPlayer', '保存音量失败', error)
      }
      this.$emit('playback-state-changed')
    },
    
    // 静音切换
    toggleMute() {
      const audioEl = this.getActiveAudio()
      if (!audioEl || this.isDisposed) return
      if (this.volume === 0) {
        this.handleVolumeChange(this.lastAudibleVolume)
        return
      }
      this.isMuted = !this.isMuted
      this.applyDeckVolume()
    },
    
    // 音频播放事件
    handlePlay() {
      if (this.isDisposed) return
      this.listeningHistory?.discontinuity()
      this.isPlaying = true
      this.syncAudioEffectsTrack()
      this.cachePlayedSong(true)
      // 更新 MediaSession 播放状态
      if ('mediaSession' in navigator) {
        navigator.mediaSession.playbackState = 'playing'
        this.updatePositionState()
      }
      // 同步播放状态到系统托盘
      if (window.electronAPI && window.electronAPI.updatePlaybackState) {
        window.electronAPI.updatePlaybackState(true)
      }
      this.syncDesktopTime(true)
      this.$nextTick(() => this.refreshNextPreparation())
    },
    
    // 音频暂停事件
    handlePause() {
      if (this.isDisposed) return
      if (this.isLoadingSong && this.currentSong && !this.getActiveAudio()?.ended) {
        this.playbackIntentVersion++
        this.desiredPlaying = false
      }
      this.listeningHistory?.discontinuity()
      this.isPlaying = false
      this.syncAudioEffectsTransport()
      // 更新 MediaSession 播放状态
      if ('mediaSession' in navigator) {
        navigator.mediaSession.playbackState = 'paused'
        this.updatePositionState()
      }
      // 同步播放状态到系统托盘
      if (window.electronAPI && window.electronAPI.updatePlaybackState) {
        window.electronAPI.updatePlaybackState(false)
      }
      this.syncDesktopTime(true)
    },
    
    // 播放模式切换
    togglePlayMode() {
      const modes = ['loop', 'single', 'shuffle']
      const currentIndex = modes.indexOf(this.playMode)
      const nextMode = modes[(currentIndex + 1) % modes.length]
      
      // 使用 setPlayMode 方法来设置新模式（统一处理逻辑）
      this.setPlayMode(nextMode)
      
      logger.trace('MusicPlayer', '切换播放模式:', this.playModeText)
    },
    
    // 设置播放模式（从右键菜单调用）
    setPlayMode(mode) {
      logger.trace('MusicPlayer', '设置播放模式:', mode)
      this.playMode = mode
      
      // 如果切换到随机播放模式，预先打乱播放列表
      if (mode === 'shuffle') {
        this.generateShuffledPlaylist()
        // 初始化播放历史
        this.playedHistory = [this.currentIndex]
        this.playOrderHistory = [this.currentIndex]
        this.historyPointer = -1
        logger.trace('MusicPlayer', '设置为随机播放模式，已生成随机播放列表')
      } else {
        // 切换到其他模式，清空随机播放列表和历史
        this.shuffledPlaylist = []
        this.playedHistory = []
        this.playOrderHistory = [this.currentIndex]
        this.historyPointer = -1
      }
      
      // 保存播放模式到 localStorage
      localStorage.setItem('player_mode', mode)
      
      logger.trace('MusicPlayer', '播放模式已设置为:', this.playModeText)
    },
    
    // 生成随机播放列表
    generateShuffledPlaylist() {
      if (this.playlist.length === 0) {
        this.shuffledPlaylist = []
        return
      }
      
      // 创建播放列表的副本
      this.shuffledPlaylist = [...this.playlist]
      
      // 使用 Fisher-Yates 洗牌算法打乱列表
      for (let i = this.shuffledPlaylist.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [this.shuffledPlaylist[i], this.shuffledPlaylist[j]] = [this.shuffledPlaylist[j], this.shuffledPlaylist[i]]
      }
      
      logger.trace('MusicPlayer', '✅ 生成随机播放列表，共', this.shuffledPlaylist.length, '首歌曲')
    },
    
    // 显示播放模式菜单
    showPlayModeMenu(event) {
      // 先关闭所有其他菜单
      contextMenuManager.closeActiveMenu()
      
      // 然后关闭自己的旧菜单，防止瞬移
      this.playModeMenuVisible = false
      
      // 使用 nextTick 确保旧菜单完全关闭后再打开新菜单
      this.$nextTick(() => {
        if (this.isDisposed) return
        this.playModeMenuPosition = {
          x: event.clientX,
          y: event.clientY
        }
        this.playModeMenuVisible = true
        
        // 注册到全局管理器
        contextMenuManager.registerMenu(this.closePlayModeMenu)
      })
    },

    closePlayModeMenu() {
      this.playModeMenuVisible = false
    },

    // 循环切换播放模式
    cyclePlayMode() {
      const modes = ['loop', 'single', 'shuffle']
      const currentIndex = modes.indexOf(this.playMode)
      const nextIndex = (currentIndex + 1) % modes.length
      this.setPlayMode(modes[nextIndex])
    },
    
    // 收藏切换
    toggleFavorite() {
      if (this.favoritePending) return
      this.$emit('toggle-favorite', this.currentSong)
    },

    // 显示歌词界面
    async showLyrics() {
      if (!this.currentSong || this.isDisposed) return
      
      // 如果正在切歌中，延迟显示歌词，避免资源竞争
      if (this.isSwitchingSong) {
        this.pendingLyricView = true
        return
      }
      this.pendingLyricView = false
      const requestId = ++this.lyricViewRequestId
      const songHash = this.currentSong.hash
      
      // 如果没有歌词，尝试加载
      if (!this.currentLyrics) {
        await this.loadLyric(this.currentSong)
      }
      if (this.isDisposed || requestId !== this.lyricViewRequestId ||
          this.currentSong?.hash !== songHash) return
      
      this.showLyricView = true
      window.electronAPI?.setLyricViewVisible?.(true)
      this.$emit('lyric-view-changed', true)
    },

    /** 取消待显示请求并向下收起；标题栏透明状态保留到离场完成。 */
    closeLyrics() {
      this.cancelProgressDrag()
      this.pendingLyricView = false
      this.lyricViewRequestId++
      this.showLyricView = false
    },

    /** 快速重新打开时，旧离场回调不能复原标题栏。 */
    handleLyricsHidden() {
      if (!this.showLyricView && !this.isDisposed) {
        window.electronAPI?.setLyricViewVisible?.(false)
        this.$emit('lyric-view-changed', false)
      }
    },

    /** 所有播放器中的歌名搜索共用出口，收起覆盖层后保留当前音频与播放队列。 */
    searchSong(song = this.currentSong) {
      if (this.isDisposed || !song || typeof song !== 'object') return
      this.closeLyrics()
      this.showPlaylist = false
      this.$emit('search', song)
    },

    /** 歌手导航只收起覆盖层，不切换歌曲或修改播放会话。 */
    openArtist(artist) {
      if (this.isDisposed || !artist?.name) return
      this.closeLyrics()
      this.showPlaylist = false
      this.$emit('navigate', 'artist', artist)
    },

    /** 退场标题不再参与键盘和辅助技术导航，避免动画期间点击旧歌曲。 */
    setSongTitleInteractivity(element, interactive) {
      element.inert = !interactive
      if (interactive) {
        element.removeAttribute('aria-hidden')
        element.removeAttribute('tabindex')
      } else {
        element.setAttribute('aria-hidden', 'true')
        element.tabIndex = -1
      }
    },

    // 处理歌词界面的进度跳转
    handleSeek(time) {
      const audioEl = this.getActiveAudio()
      if (this.isReplacingQualitySource) return
      if (!audioEl?.src || this.isDisposed || !Number.isFinite(time) || !Number.isFinite(this.duration) || this.duration <= 0) return
      this.naturalLoopSeek = null
      const hadDelayedPresentation = Boolean(this.presentedPlaybackSnapshot)
      this.clearPresentedPlayback()
      if (hadDelayedPresentation) {
        this.beginListeningHistory()
        this.syncDesktopTrack(this.loadedSongDetail)
        this.sendLyricsToDesktop(this.currentLyrics, this.currentLyricData)
        this.updateMediaSession(this.currentSong)
      }
      this.getAudioTransition().settle()
      this.resetAutomaticAdvance()
      const target = Math.max(0, Math.min(this.duration, time))
      this.cancelProgressDrag()
      audioEl.currentTime = target
      this.syncAudioEffectsTransport(true)
      this.currentTime = target
      this.updatePositionState()
      this.syncDesktopTime(true, { discontinuity: true })
      logger.trace('MusicPlayer', '跳转歌曲进度', { time: target })
    },

    
    // 检查收藏状态
    checkFavoriteStatus() {
      return this.musicLibrary?.isFavorite(this.currentSong) || false
    },
    
    // 显示/隐藏播放列表
    togglePlaylist() {
      this.showPlaylist = !this.showPlaylist
    },
    
    // 播放列表中的歌曲
    async handlePlaylistPlay(song) {
      if (this.playlist.some(item => this.samePlaybackSource(item, song))) {
        return this.requestSong(song)
      }
      return false
    },

    /** 发出新队列交由父组件保存，并移除被删歌曲的待播记录。 */
    async handleRemoveSong(index) {
      if (this.isDisposed || !Number.isInteger(index) || index < 0 || index >= this.playlist.length) return
      const removedSong = this.playlist[index]
      const wasCurrentSong = this.samePlaybackSource(removedSong, this.currentSong) ||
        (!this.currentSong && this.samePlaybackSource(removedSong, this.loadingSongTarget))
      const updatedPlaylist = this.playlist.filter((_, songIndex) => songIndex !== index)
      this.playNextQueue = this.playNextQueue.filter(song => !this.samePlaybackSource(song, removedSong))
      if (this.samePlaybackSource(this.pendingSong, removedSong)) {
        this.pendingSong = null
        this.pendingSongOptions = null
      }
      if (this.samePlaybackSource(this.loadingSongTarget, removedSong)) {
        this.songRequestId++
        this.lyricRequestId++
        this.songAbortController?.abort()
        if (!wasCurrentSong && this.currentSong && !this.pendingSong) {
          this.pendingSong = this.currentSong
          this.pendingSongOptions = { preservePlaybackIntent: true, playbackIntentVersion: this.playbackIntentVersion }
        }
      }
      if (updatedPlaylist.length === 0) this.stopPlayback()
      this.$emit('playlist-updated', updatedPlaylist)
      await this.$nextTick()
      if (this.isDisposed || updatedPlaylist.length === 0) return

      if (wasCurrentSong) {
        const nextIndex = index < updatedPlaylist.length ? index : 0
        this.currentIndex = nextIndex
        await this.requestSong(updatedPlaylist[nextIndex], 'next')
      } else {
        const currentIndex = updatedPlaylist.findIndex(song => this.samePlaybackSource(song, this.currentSong))
        if (currentIndex !== -1) this.currentIndex = currentIndex
      }
    },

    /** 清空时先停止播放和异步请求，再通知父组件移除队列。 */
    handleClearPlaylist() {
      this.showPlaylist = false
      this.stopPlayback()
      this.$emit('clear-playlist')
    },

    /** 下一首队列按歌曲来源、账号和 hash 去重，播放列表使用事件交由父组件替换。 */
    addToPlayNextQueue(song) {
      if (!song?.hash || this.isDisposed) return
      if (!this.playNextQueue.some(item => this.samePlaybackSource(item, song))) {
        this.playNextQueue.push(song)
        if (!this.playlist.some(item => this.samePlaybackSource(item, song))) {
          // Parent props update on Vue's next tick; retain all entries queued
          // during this tick instead of rebuilding from the stale prop alone.
          const additions = this.playNextQueue.filter(item => !this.playlist.some(queued => this.samePlaybackSource(queued, item)))
          this.$emit('playlist-updated', [...this.playlist, ...additions])
        }
      }
    },

    removeFromPlaylist(song) {
      if (!song?.hash) return
      const index = this.playlist.findIndex(item => this.samePlaybackSource(item, song))
      if (index !== -1) return this.handleRemoveSong(index)
      this.playNextQueue = this.playNextQueue.filter(item => !this.samePlaybackSource(item, song))
    },

    // 格式化时间
    formatTime(seconds) {
      if (!seconds || isNaN(seconds)) return '0:00'
      const mins = Math.floor(seconds / 60)
      const secs = Math.floor(seconds % 60)
      return `${mins}:${secs.toString().padStart(2, '0')}`
    },
    
    // 提取歌曲名称
    getSongName(song) {
      return getSongSearchKeyword(typeof song === 'string' ? { songname: song } : song) || '未知歌曲'
    },
    
    // 获取歌手名称
    getSingerNames(singerinfo) {
      // 如果是数组格式 (标准的 singerinfo)
      if (Array.isArray(singerinfo) && singerinfo.length > 0) {
        const names = singerinfo.map(s => {
          // 处理对象格式的歌手信息
          if (typeof s === 'object' && s !== null) {
            return s.name || s.singer_name || s.singername || s.author_name || String(s)
          }
          // 处理字符串格式
          return String(s)
        }).filter(name => name && name.trim() && name !== '[object Object]')
        
        // 如果过滤后有有效的名字,返回拼接结果
        if (names.length > 0) {
          return names.join('、')
        }
      }
      // 如果是字符串格式
      if (typeof singerinfo === 'string' && singerinfo.trim()) {
        return singerinfo
      }
      return null // 返回 null 而不是 '未知歌手',让调用方处理备选方案
    },
    
    // 更新系统媒体会话信息 (SMTC - System Media Transport Controls)
    updateMediaSession(song) {
      song = this.presentedPlaybackSnapshot?.detail || this.presentedPlaybackSnapshot?.song || song
      if ('mediaSession' in navigator) {
        try {
          // 提取歌名（去除歌手前缀）
          const songTitle = this.getSongName(song)
          
          // 尝试多种方式获取歌手名称
          let artistName = this.getSingerNames(song.singerinfo) 
            || song.singername 
            || song.author_name 
            || song.singer_name
            || (song.name && song.name.includes(' - ') ? song.name.split(' - ')[0] : null)
            || (song.filename && song.filename.includes(' - ') ? song.filename.split(' - ')[0] : null)
            || '未知歌手'
          
          logger.trace('MusicPlayer', '🎤 歌手信息调试:', {
            'song.singerinfo': song.singerinfo,
            'singerinfo[0]': song.singerinfo && song.singerinfo[0] ? song.singerinfo[0] : null,
            'singerinfo详细内容': song.singerinfo ? JSON.stringify(song.singerinfo) : null,
            'song.singername': song.singername,
            'song.author_name': song.author_name,
            'song.singer_name': song.singer_name,
            'song.filename': song.filename,
            'song.name': song.name,
            '最终使用的歌手名': artistName
          })
          
          // 获取封面图片 URL
          let coverUrl = song.img || song.album_cover || song.cover || ''
          
          // 调试日志：检查歌曲对象的所有图片相关字段
          logger.trace('MusicPlayer', '🖼️ 封面图片调试信息:', {
            'song.img': song.img,
            'song.album_cover': song.album_cover,
            'song.cover': song.cover,
            'song.imgUrl': song.imgUrl,
            'song.pic': song.pic,
            '最终使用的URL': coverUrl
          })
          
          // 如果没有封面，使用占位图
          if (!coverUrl) {
            coverUrl = 'https://p1.music.126.net/6y-UleORITEDbvrOLV0Q8A==/5639395138885805.jpg'
            logger.warn('MusicPlayer', '⚠️ 未找到封面图片，使用默认占位图')
          }
          
          // 替换封面URL中的 {size} 占位符（酷狗API返回的URL格式）
          // 使用更高分辨率（1000）以获得更清晰的封面显示
          if (coverUrl.includes('{size}')) {
            coverUrl = coverUrl.replace('{size}', '1000')
            logger.trace('MusicPlayer', '🔧 替换封面URL占位符（高清）:', coverUrl)
          }
          
          // 确保 URL 使用 HTTPS（避免混合内容问题）
          if (coverUrl.startsWith('http://')) {
            coverUrl = coverUrl.replace('http://', 'https://')
            logger.trace('MusicPlayer', '将封面 URL 转换为 HTTPS:', coverUrl)
          }
          
          // 设置媒体元数据
          // Windows SMTC 
          navigator.mediaSession.metadata = new MediaMetadata({
            title: songTitle,
            artist: artistName,
            album: song.album_name || '',
            artwork: [
              {
                src: coverUrl,
                sizes: '512x512',
                type: 'image/jpeg'
              },
              {
                src: coverUrl,
                sizes: '1000x1000',
                type: 'image/jpeg'
              }
            ]
          })
          
          logger.trace('MusicPlayer', '元数据已更新:', {
            title: songTitle,
            artist: artistName,
            album: song.album_name || '',
            artwork: coverUrl
          })
        } catch (error) {
          logger.error('MusicPlayer', '❌ 更新 MediaSession 失败:', error)
          logger.error('MusicPlayer', '错误详情:', error.message)
          logger.error('MusicPlayer', '歌曲对象:', song)
        }
      } else {
        logger.warn('MusicPlayer', '⚠️ 浏览器不支持 MediaSession API')
      }
    },
    
    // 音频时间更新事件
    handleTimeUpdate() {
      this.sampleListeningHistory()
      this.maybeAdvanceAutomatically()
      // 同首换源暂时从零加载，歌词和系统进度保留最后确认位置，提交后统一同步。
      if (this.isDisposed || this.isReplacingQualitySource) return
      const audioEl = this.getActiveAudio()
      if (audioEl && !isNaN(audioEl.currentTime)) {
        this.currentTime = this.presentationTime(audioEl)
        this.duration = audioEl.duration || 0
        
        this.syncDesktopTime(audioEl.paused || audioEl.seeking)
        
        // 定期更新 MediaSession 位置状态（每秒更新一次，避免过于频繁）
        if ('mediaSession' in navigator && this.isPlaying) {
          const now = Math.floor(audioEl.currentTime)
          if (!this.lastPositionUpdate || now !== this.lastPositionUpdate) {
            this.lastPositionUpdate = now
            this.updatePositionState()
          }
        }
      }
    },

    /** 原生 seeked 同时覆盖歌词、进度条及系统媒体跳转，恢复/换源期间不采集中间值。 */
    handleSeeked() {
      this.listeningHistory?.discontinuity()
      if (this.isDisposed) return
      if (this.naturalLoopSeek?.audio === this.getActiveAudio() && this.naturalLoopSeek.version === this.audioSourceVersion) this.naturalLoopSeek = null
      this.resetAutomaticAdvance()
      this.desktopAudioWaiting = this.getActiveAudio()?.readyState < 3
      this.syncAudioEffectsTransport()
      this.handleTimeUpdate()
      this.syncDesktopTime(true, { discontinuity: true })
      this.$emit('playback-state-changed')
    },
    
    // 更新 MediaSession 位置状态
    updatePositionState() {
      if (this.isReplacingQualitySource) return
      if ('mediaSession' in navigator && 'setPositionState' in navigator.mediaSession) {
        try {
          const audioEl = this.getActiveAudio()
          if (audioEl && !isNaN(audioEl.duration) && audioEl.duration > 0) {
            navigator.mediaSession.setPositionState({
              duration: this.presentedDuration,
              playbackRate: audioEl.playbackRate || 1.0,
              position: this.presentedPlaybackSnapshot ? this.readPresentedTime() : this.presentationTime(audioEl)
            })
          }
        } catch (error) {
          // 某些浏览器可能不支持 setPositionState
          logger.debug('MusicPlayer', '设置 MediaSession 位置状态失败:', error)
        }
      }
    },
    
    // 初始化媒体控制处理器
    initMediaSessionHandlers() {
      if ('mediaSession' in navigator) {
        try {
          // 播放/暂停
          navigator.mediaSession.setActionHandler('play', () => {
            if (!this.isPlaying) this.togglePlay()
          })
          
          navigator.mediaSession.setActionHandler('pause', () => {
            if (this.isPlaying) this.togglePlay()
          })
          
          // 上一曲/下一曲
          navigator.mediaSession.setActionHandler('previoustrack', () => {
            this.playPrevious()
          })
          
          navigator.mediaSession.setActionHandler('nexttrack', () => {
            this.playNext()
          })
          
          // 快进/快退 (可选)
          navigator.mediaSession.setActionHandler('seekbackward', (details) => {
            const audioEl = this.getActiveAudio()
            if (this.isDisposed || this.isReplacingQualitySource || !audioEl) return
            this.handleSeek(Math.max(0, audioEl.currentTime - (details.seekOffset || 10)))
          })
          
          navigator.mediaSession.setActionHandler('seekforward', (details) => {
            const audioEl = this.getActiveAudio()
            if (this.isDisposed || this.isReplacingQualitySource || !audioEl || !Number.isFinite(audioEl.duration)) return
            this.handleSeek(Math.min(audioEl.duration, audioEl.currentTime + (details.seekOffset || 10)))
          })
          
          // 进度跳转
          navigator.mediaSession.setActionHandler('seekto', (details) => {
            const audioEl = this.getActiveAudio()
            if (this.isDisposed || this.isReplacingQualitySource || !audioEl) return
            if (details.seekTime !== undefined) {
              this.handleSeek(details.seekTime)
            }
          })
          
          logger.trace('MusicPlayer', '✅ MediaSession 控制处理器已初始化')
        } catch (error) {
          logger.error('MusicPlayer', '❌ 初始化 MediaSession 处理器失败:', error)
        }
      }
    },

    /** 卸载时移除系统媒体回调，避免回调持有已经销毁的播放器。 */
    clearMediaSessionHandlers() {
      if (!('mediaSession' in navigator)) return
      for (const action of ['play', 'pause', 'previoustrack', 'nexttrack', 'seekbackward', 'seekforward', 'seekto']) {
        try {
          navigator.mediaSession.setActionHandler(action, null)
        } catch (error) {
          logger.debug('MusicPlayer', '移除媒体控制处理器失败:', action, error)
        }
      }
      navigator.mediaSession.metadata = null
      navigator.mediaSession.playbackState = 'none'
    },
    
    // 初始化系统托盘播放器控制监听器
    initTrayPlayerControlListener() {
      if (window.electronAPI && window.electronAPI.onPlayerControl) {
        try {
          this.trayControlUnsubscribe = window.electronAPI.onPlayerControl((action) => {
            logger.trace('MusicPlayer', '🎵 [MusicPlayer] 收到系统托盘控制事件:', action)
            
            switch (action) {
              case 'play':
                if (!this.isPlaying) {
                  this.togglePlay()
                }
                break
              case 'pause':
                if (this.isPlaying) {
                  this.togglePlay()
                }
                break
              case 'prev':
                this.playPrevious()
                break
              case 'next':
                this.playNext()
                break
              default:
                logger.warn('MusicPlayer', '🎵 [MusicPlayer] 未知的托盘控制动作:', action)
            }
          })
          
          logger.trace('MusicPlayer', '✅ 系统托盘播放器控制监听器已初始化')
        } catch (error) {
          logger.error('MusicPlayer', '❌ 初始化系统托盘播放器控制监听器失败:', error)
        }
      } else {
        logger.warn('MusicPlayer', '⚠️ ElectronAPI 不可用，跳过系统托盘控制监听器初始化')
      }
    }
  }
}
