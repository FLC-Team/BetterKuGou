
import { logger } from '../../utils/logger.js'
import { computed } from 'vue'
import { getSongUrl, getLyric, getSongDetail } from '../../api/music.js'
import PlaylistDrawer from './PlaylistDrawer.vue'
import ContextMenu from '../common/ContextMenu.vue'
import ArtworkCover from '../common/ArtworkCover.vue'
import LyricView from './LyricView.vue'
import contextMenuManager from '../../utils/contextMenuManager.js'
import { useSettingsStore } from '../../stores/settingsStore.js'
import { PLAYBACK_QUALITY_OPTIONS, normalizePlaybackQuality, readPlaybackQuality } from '../../utils/playbackQuality.js'

// 动态导入 SVG 图标
import playlistIcon from '../../assets/icons/playlist.svg'
import repeatAllIcon from '../../assets/icons/repeat_all.svg'
import repeatOneIcon from '../../assets/icons/repeat_one.svg'
import shuffleIcon from '../../assets/icons/shuffle.svg'
import sound0Icon from '../../assets/icons/sound_0.svg'
import sound1Icon from '../../assets/icons/sound_1.svg'
import sound2Icon from '../../assets/icons/sound_2.svg'
import sound3Icon from '../../assets/icons/sound_3.svg'

export default {
  name: 'MusicPlayer',
  components: {
    PlaylistDrawer,
    ContextMenu,
    ArtworkCover,
    LyricView
  },
  props: {
    song: {
      type: Object,
      default: null
    },
    playlist: {
      type: Array,
      default: () => []
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
      sound0Icon,
      sound1Icon,
      sound2Icon,
      sound3Icon,
      // 状态
      currentSong: null,
      trackTransition: 'select',
      isPlaying: false,
      currentTime: 0,
      duration: 0,
      isDragging: false, // 是否正在拖动进度条
      seekPreviewTime: null,
      volume: 80,
      isMuted: false,
      playMode: 'loop', // loop: 列表循环, single: 单曲循环, shuffle: 随机播放
      isFavorite: false,
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
      currentLyricData: null, // 完整的歌词数据（包含翻译等信息）
      // MediaSession 相关
      lastPositionUpdate: null, // 上次位置更新的时间（秒）
      lastDesktopTimeUpdate: null, // 上次桌面歌词时间更新的时间戳（毫秒）
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
      qualityMessage: '',
      qualitySaveMessage: '',
      qualityRequestVersion: 0,
      qualityRetryValue: '128',
      loadingQualityChange: false,
      isReplacingQualitySource: false,
      pendingSongOptions: null,
      loadingSongTarget: null,
      loadingSongTransition: 'select',
      metadataWaitCancel: null,
      audioSourceVersion: 0,
      songRequestId: 0,
      lyricRequestId: 0,
      lyricViewRequestId: 0,
      pendingLyricView: false,
      pendingTimers: new Map()
    }
  },
  computed: {
    qualityPreference() {
      return normalizePlaybackQuality(this.settingsStore?.settings?.playback?.quality)
    },
    qualityStatus() {
      if (this.loadingQualityChange || this.pendingSongOptions?.qualityChange) return '正在切换…'
      return `当前 ${this.currentQuality?.label || '待确认'}`
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
    song: {
      handler(newSong) {
        if (!newSong || this.isDisposed) return
        if (this.currentSong?.hash === newSong.hash && this.loadedSongHash === newSong.hash &&
            this.$refs.audioPlayer?.getAttribute('src') && !this.pendingSong &&
            !this.isLoadingSong && !this.isSwitchingSong) return
        this.requestSong(newSong)
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
            if (this.$refs.audioPlayer) {
              this.$refs.audioPlayer.pause()
              this.$refs.audioPlayer.currentTime = 0
            }
            this.isPlaying = false
            this.currentTime = 0
            this.duration = 0
            if (process.env.NODE_ENV === 'development') {
              logger.trace('MusicPlayer', '播放列表已清空，重置状态')
            }
            return
          }
          
          const songIndex = newPlaylist.findIndex(song => song?.hash === this.currentSong?.hash)
          if (songIndex !== -1) this.currentIndex = songIndex
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
    },
    // 监听当前歌曲变化，同步到系统托盘
    currentSong: {
      handler(newSong) {
        if (newSong && window.electronAPI && window.electronAPI.updateTrack) {
          const trackInfo = {
            title: newSong.name || newSong.filename || '未知歌曲',
            cover: newSong.cover ? newSong.cover.replace('{size}', '400') : null
          }
          window.electronAPI.updateTrack(trackInfo)
        }
      },
      immediate: true
    }
  },
  mounted() {
    if (process.env.NODE_ENV === 'development') {
      logger.trace('MusicPlayer', '🎵 [MusicPlayer] 组件已挂载')
      logger.trace('MusicPlayer', '🎵 [MusicPlayer] audioPlayer ref 状态:', !!this.$refs.audioPlayer)
    }
    
    // 添加全局错误处理
    this.$nextTick(() => {
      if (this.isDisposed) return
      if (process.env.NODE_ENV === 'development') {
        logger.trace('MusicPlayer', '🎵 [MusicPlayer] nextTick 后 audioPlayer ref 状态:', !!this.$refs.audioPlayer)
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
        if (this.$refs.audioPlayer) {
          this.$refs.audioPlayer.volume = this.volume / 100
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
    this.isDisposed = true
    this.seekPreviewTime = null
    this.isDragging = false
    this.isComponentReady = false
    this.pendingSong = null
    this.pendingSongOptions = null
    this.pendingSongTransition = 'select'
    this.pendingLyricView = false
    this.songRequestId++
    this.qualityRequestVersion++
    this.metadataWaitCancel?.()
    this.audioSourceVersion++
    this.lyricRequestId++
    this.lyricViewRequestId++
    this.clearPendingTimers()
    this.isPlaying = false
    this.loadedSongHash = null
    // 组件销毁前停止 RAF 循环
    this.stopTimeUpdate()
    
    // 清理音频元素
    if (this.$refs.audioPlayer) {
      this.$refs.audioPlayer.pause()
      this.$refs.audioPlayer.removeAttribute('src')
      this.$refs.audioPlayer.load()
    }
    
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
    /** 将选歌及动效来源一起排队，并使尚未完成的歌曲及歌词响应失效。 */
    requestSong(song, transition = 'select', options = {}) {
      if (!song?.hash || this.isDisposed) return Promise.resolve(false)
      this.cancelProgressDrag()
      this.pendingSong = song
      this.pendingSongTransition = transition
      this.pendingSongOptions = options
      this.songRequestId++
      if (!options.qualityChange) this.lyricRequestId++
      this.metadataWaitCancel?.()
      return this.drainPendingSong()
    },

    /** 在挂载及切歌完成后顺序加载最新请求，避免忙时丢失选歌。 */
    async drainPendingSong() {
      if (this.isDisposed || !this.isComponentReady || !this.$refs.audioPlayer ||
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

    /** 播放成功后提交歌曲；失败或过期时先恢复已提交音源，再处理最新选歌。 */
    async loadSong(song, transition = 'select', options = {}) {
      const audioEl = this.$refs.audioPlayer
      if (!song?.hash || this.isDisposed || !audioEl || this.isLoadingSong) return false
      this.cancelProgressDrag()

      const qualityChange = Boolean(options.qualityChange && this.currentSong?.hash === song.hash &&
        this.loadedSongHash === song.hash && audioEl.getAttribute('src'))
      const requestedQuality = normalizePlaybackQuality(options.quality ?? this.qualityPreference)
      const replaying = !qualityChange && this.currentSong?.hash === song.hash &&
        this.loadedSongHash === song.hash && audioEl.getAttribute('src')
      this.isLoadingSong = true
      this.loadingSongHash = song.hash
      this.loadingSongTarget = song
      this.loadingSongTransition = transition
      this.loadingQualityChange = qualityChange
      if (qualityChange) this.qualityMessage = ''
      const requestId = ++this.songRequestId
      let sourceVersion = this.audioSourceVersion
      const ownsSource = () => !this.isDisposed && this.$refs.audioPlayer === audioEl &&
        this.audioSourceVersion === sourceVersion
      let previousPlayback = null
      let committed = false
      let playAttempted = false
      let failed = false

      try {
        if (replaying) {
          const shouldReplay = audioEl.ended || audioEl.paused
          if (audioEl.ended) audioEl.currentTime = 0
          if (shouldReplay) {
            playAttempted = true
            await audioEl.play()
          }
          if (!this.isCurrentSongRequest(requestId) || !ownsSource()) return false
          const songIndex = this.playlist.findIndex(item => item?.hash === song.hash)
          if (songIndex !== -1) this.currentIndex = songIndex
          return true
        }

        if (!qualityChange) this.lyricRequestId++
        let audioDetail = song
        if (!song.album_audio_id) {
          const detailResponse = await getSongDetail(song.hash)
          if (!this.isCurrentSongRequest(requestId)) return false
          if (detailResponse?.status === 1 && detailResponse.data?.length > 0) {
            audioDetail = { ...song, ...detailResponse.data[0] }
          }
        }

        const urlResponse = await getSongUrl(
          audioDetail.hash, audioDetail.album_id || 0, audioDetail.album_audio_id || 0, requestedQuality
        )
        if (!this.isCurrentSongRequest(requestId)) return false
        if (urlResponse?.status !== 1) throw new Error(this.getPlayErrorMessage(urlResponse))
        let playUrl = Array.isArray(urlResponse.url) ? urlResponse.url[0] : urlResponse.url
        if (typeof playUrl !== 'string' || !playUrl) throw new Error(this.getPlayErrorMessage(urlResponse))
        if (playUrl.startsWith('http://')) playUrl = playUrl.replace('http://', 'https://')

        // 地址请求期间旧歌仍会播放，在替换前保存其最新位置和播放状态。
        previousPlayback = {
          source: this.loadedSongHash === this.currentSong?.hash ? audioEl.getAttribute('src') : null,
          hash: this.loadedSongHash,
          time: audioEl.currentTime,
          duration: this.duration,
          playing: !audioEl.paused
        }
        this.isReplacingQualitySource = qualityChange
        if (qualityChange) this.currentTime = previousPlayback.time
        sourceVersion = ++this.audioSourceVersion
        audioEl.src = playUrl
        if (qualityChange) {
          audioEl.pause()
          const ready = await this.waitForAudioReady(audioEl, () => this.isCurrentSongRequest(requestId) && ownsSource())
          if (!ready || !this.isCurrentSongRequest(requestId) || !ownsSource()) return false
          const duration = Number.isFinite(audioEl.duration) && audioEl.duration > 0 ? audioEl.duration : previousPlayback.duration
          audioEl.currentTime = Math.max(0, Math.min(previousPlayback.time, duration || previousPlayback.time))
        }
        if (!qualityChange || previousPlayback.playing) {
          playAttempted = true
          await audioEl.play()
        }
        if (!this.isCurrentSongRequest(requestId) || !ownsSource()) return false

        committed = true
        this.loadedSongHash = song.hash
        this.loadedQualityPreference = requestedQuality
        this.currentQuality = readPlaybackQuality(urlResponse)
        this.qualityMessage = ''
        if (qualityChange) {
          this.currentTime = audioEl.currentTime
          this.duration = Number.isFinite(audioEl.duration) && audioEl.duration > 0 ? audioEl.duration : previousPlayback.duration
          return true
        }
        this.trackTransition = transition
        this.currentSong = song
        const songIndex = this.playlist.findIndex(item => item?.hash === song.hash)
        if (songIndex !== -1) this.currentIndex = songIndex
        this.currentLyrics = ''
        this.currentLyricData = null
        this.currentTime = audioEl.currentTime
        this.updateMediaSession(audioDetail)
        this.checkFavoriteStatus()
        if (this.playMode === 'shuffle' && !this.playedHistory.includes(this.currentIndex)) {
          this.playedHistory.push(this.currentIndex)
        }
        this.loadLyric(audioDetail)
        this.$emit('song-changed', this.currentSong)
        return true
      } catch (error) {
        if (!this.isCurrentSongRequest(requestId)) return false
        failed = true
        logger.error('MusicPlayer', '加载歌曲失败:', error)
        const message = error.response?.data?.error_msg || error.response?.data?.msg || error.message
        if (qualityChange) this.qualityMessage = `音质切换失败：${message}。已保留原音源。`
        else this.showError(`加载歌曲失败: ${message}`)
        return false
      } finally {
        // 请求代次只决定是否提交；音源代次保证停止/卸载后旧任务不能恢复播放。
        if (!committed && previousPlayback && ownsSource()) {
          audioEl.pause()
          sourceVersion = ++this.audioSourceVersion
          if (previousPlayback.source) {
            audioEl.src = previousPlayback.source
            this.loadedSongHash = previousPlayback.hash
            this.currentTime = previousPlayback.time
            this.duration = previousPlayback.duration
            try {
              audioEl.currentTime = previousPlayback.time
              if (previousPlayback.playing) await audioEl.play()
            } catch (restoreError) {
              if (ownsSource()) {
                audioEl.pause()
                if (qualityChange) this.qualityMessage = '音质切换失败，原音源恢复播放也失败，请重试或重新选歌。'
                logger.error('MusicPlayer', '恢复上一首歌曲失败:', restoreError)
              }
            }
          } else {
            audioEl.removeAttribute('src')
            this.loadedSongHash = null
            audioEl.load()
            this.currentTime = 0
            this.duration = 0
          }
        }
        if (playAttempted && !ownsSource() && !audioEl.getAttribute('src')) audioEl.pause()
        // App 用 song 同时传递选歌与保存会话，最终失败后回写实际保留的歌曲。
        if (failed && !committed && this.isCurrentSongRequest(requestId) && !this.pendingSong &&
            this.currentSong && this.song?.hash === song.hash && this.currentSong.hash !== song.hash) {
          this.$emit('song-changed', this.currentSong)
        }
        if (!committed && ownsSource() && this.isCurrentSongRequest(requestId) && !this.pendingSong &&
            this.currentSong && this.loadedSongHash === this.currentSong.hash && !this.currentLyrics) {
          this.loadLyric(this.currentSong)
        }
        this.isLoadingSong = false
        this.loadingQualityChange = false
        this.isReplacingQualitySource = false
        if (qualityChange && ownsSource()) {
          this.updatePositionState()
          window.electronAPI?.updatePlaybackTime?.(this.currentTime * 1000)
        }
        this.loadingSongHash = null
        this.loadingSongTarget = null
        if (!this.isDisposed) this.$nextTick(() => this.drainPendingSong())
      }
    },

    /** 切换偏好与当前音源；最后一次选择优先，正在选中的下一首不会被旧歌覆盖。 */
    changeQuality(value) {
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
      const transition = this.pendingSong ? this.pendingSongTransition
        : this.loadingSongTarget ? this.loadingSongTransition : this.trackTransition
      return this.requestSong(target, transition, { quality,
        qualityChange: target.hash === this.currentSong?.hash && this.loadedSongHash === target.hash })
    },

    retryQualityChange() {
      return this.changeQuality(this.qualityRetryValue)
    },

    /** 等待音频能够播放；暂停换质不调用 play，并可被新请求/停止/卸载取消。 */
    waitForAudioReady(audioEl, isCurrent) {
      if (audioEl.readyState >= 3) return Promise.resolve(isCurrent())
      return new Promise((resolve, reject) => {
        let settled = false
        const finish = (ready, error) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          this.pendingTimers.delete(timer)
          audioEl.removeEventListener('canplay', onReady)
          audioEl.removeEventListener('error', onError)
          if (this.metadataWaitCancel === cancel) this.metadataWaitCancel = null
          if (error) reject(error)
          else resolve(ready && isCurrent())
        }
        const onReady = () => finish(true)
        const onError = () => finish(false, new Error('该音质音频无法加载，可能不受支持或没有播放权限'))
        const cancel = () => finish(false)
        const timer = setTimeout(() => finish(false, new Error('音质加载超时')), 15000)
        this.pendingTimers.set(timer, cancel)
        this.metadataWaitCancel = cancel
        audioEl.addEventListener('canplay', onReady)
        audioEl.addEventListener('error', onError)
        try {
          audioEl.load()
        } catch (error) {
          finish(false, error)
        }
      })
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
      this.cancelProgressDrag()
      this.songRequestId++
      this.metadataWaitCancel?.()
      this.audioSourceVersion++
      this.lyricRequestId++
      this.lyricViewRequestId++
      this.pendingSong = null
      this.pendingSongOptions = null
      this.pendingSongTransition = 'select'
      this.trackTransition = 'select'
      this.pendingLyricView = false
      const audioEl = this.$refs.audioPlayer
      if (audioEl) {
        audioEl.pause()
        audioEl.removeAttribute('src')
        audioEl.load()
      }
      this.isPlaying = false
      this.currentSong = null
      this.loadedSongHash = null
      this.currentQuality = null
      this.loadedQualityPreference = null
      this.qualityMessage = ''
      this.currentTime = 0
      this.duration = 0
      this.currentLyrics = ''
      this.currentLyricData = null
      this.playNextQueue = []
      this.playedHistory = []
      this.shuffledPlaylist = []
      this.playOrderHistory = []
      this.historyPointer = -1
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
    
    // 加载歌词
    async loadLyric(song) {
      if (!song?.hash || this.isDisposed) return
      const requestId = ++this.lyricRequestId
      const isCurrentRequest = () => !this.isDisposed && requestId === this.lyricRequestId &&
        this.currentSong?.hash === song.hash
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
          getLyric(song.hash, song.album_audio_id || 0),
          new Promise((_, reject) => {
            timeoutId = setTimeout(() => reject(new Error('歌词加载超时')), 10000)
            this.pendingTimers.set(timeoutId, null)
          })
        ])
        if (!isCurrentRequest()) return
        
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
          if (lyricResponse.decodeContent) {
            this.currentLyrics = lyricResponse.decodeContent
            if (process.env.NODE_ENV === 'development') {
              logger.trace('MusicPlayer', '歌词加载成功（已解码），内容长度:', lyricResponse.decodeContent.length)
              logger.trace('MusicPlayer', '设置的歌词内容预览:', this.currentLyrics.substring(0, 200))
            }
            // 发送歌词到桌面歌词窗口
            this.sendLyricsToDesktop(this.currentLyrics, lyricResponse)
          } else if (lyricResponse.content) {
            // 如果没有解码内容，尝试使用原始content（可能是base64编码）
            try {
              // 尝试base64解码
              const decoded = atob(lyricResponse.content)
              this.currentLyrics = decoded
              if (process.env.NODE_ENV === 'development') {
                logger.trace('MusicPlayer', '歌词base64解码成功，内容长度:', decoded.length)
              }
              // 发送歌词到桌面歌词窗口
              this.sendLyricsToDesktop(this.currentLyrics, lyricResponse)
            } catch (e) {
              // 如果解码失败，直接使用原始内容
              this.currentLyrics = lyricResponse.content
              if (process.env.NODE_ENV === 'development') {
                logger.trace('MusicPlayer', '使用原始歌词内容，长度:', lyricResponse.content.length)
              }
              // 发送歌词到桌面歌词窗口
              this.sendLyricsToDesktop(this.currentLyrics, lyricResponse)
            }
          } else if (lyricResponse.data && lyricResponse.data.content) {
            // 尝试从data.content获取
            this.currentLyrics = lyricResponse.data.content
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
      const songName = this.getSongName(song.name || song.songname || song.audio_name)
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
          window.electronAPI.updateLyrics([])
          return
        }

        // 解析歌词内容，转换为桌面歌词所需的格式
        const parsedLyrics = this.parseLyricsForDesktop(lrcContent, rawLyricData)
        
        logger.trace('MusicPlayer', '🎵 解析完成，发送', parsedLyrics.length, '行歌词到桌面')
        logger.trace('MusicPlayer', '🎵 前3行歌词预览:', parsedLyrics.slice(0, 3))
        window.electronAPI.updateLyrics(parsedLyrics)
      } catch (error) {
        logger.error('MusicPlayer', '❌ 发送歌词到桌面歌词窗口失败:', error)
      }
    },

    // 解析歌词内容为桌面歌词格式
    parseLyricsForDesktop(lrcContent, rawLyricData = null) {
      if (!lrcContent) return []

      // 清理BOM和多余的空白字符
      let cleanContent = lrcContent.replace(/^\ufeff/, '') // 移除BOM
      cleanContent = cleanContent.trim()
      
      // 处理不同的换行符
      const lines = cleanContent.split(/\r\n|\n|\r/).filter(line => line.trim())
      const result = []
      
      logger.trace('MusicPlayer', '🎵 桌面歌词解析 - 总行数:', lines.length)
      logger.trace('MusicPlayer', '🎵 桌面歌词解析 - 前5行:', lines.slice(0, 5))
      
      // 检测歌词格式
      const hasKrcFormat = lines.some(line => /^\[\d+,\d+\]/.test(line.trim()))
      const hasLrcFormat = lines.some(line => /^\[\d{1,2}:\d{2}/.test(line.trim()))
      
      logger.trace('MusicPlayer', '🎵 歌词格式检测 - KRC格式:', hasKrcFormat, 'LRC格式:', hasLrcFormat)
      
      if (hasKrcFormat) {
        // 解析KRC格式歌词
        return this.parseKrcLyrics(lines)
      } else if (hasLrcFormat) {
        // 解析LRC格式歌词
        return this.parseLrcLyrics(lines)
      } else {
        logger.trace('MusicPlayer', '🎵 未识别的歌词格式')
        return []
      }
    },

    // 解析KRC格式歌词（支持卡拉OK逐字效果）
    parseKrcLyrics(lines) {
      const result = []
      
      for (let i = 0; i < lines.length; i++) {
        const trimmedLine = lines[i].trim()
        if (!trimmedLine) continue
        
        // 跳过元数据行
        if (trimmedLine.match(/^\[(?:ar|ti|al|by|offset|id|length|re|ve|language)[:]/i)) {
          logger.trace('MusicPlayer', '🎵 跳过KRC元数据行:', trimmedLine.substring(0, 50))
          continue
        }
        
        // KRC格式: [开始时间,持续时间]<字时间信息>歌词内容
        const krcMatch = trimmedLine.match(/^\[(\d+),(\d+)\](.*)/)
        if (!krcMatch) {
          logger.trace('MusicPlayer', '🎵 跳过非KRC格式行:', trimmedLine.substring(0, 50))
          continue
        }
        
        const lineStartTime = parseInt(krcMatch[1]) // 行开始时间（毫秒）
        const lineDuration = parseInt(krcMatch[2])   // 行持续时间（毫秒）
        const content = krcMatch[3]              // 歌词内容部分
        
        logger.trace('MusicPlayer', '🎵 处理KRC行:', {
          lineStartTime: lineStartTime + 'ms',
          lineDuration: lineDuration + 'ms',
          content: content.substring(0, 50)
        })
        
        // 解析逐字时间信息和文本
        const wordData = this.parseKrcWordTimings(content, lineStartTime)
        
        if (wordData.words.length > 0) {
          const lyricObj = {
            time: lineStartTime,
            text: wordData.fullText,
            words: wordData.words, // 逐字时间信息
            duration: lineDuration,
            isKrc: true // 标记为KRC格式，支持卡拉OK效果
          }
          
          result.push(lyricObj)
          logger.trace('MusicPlayer', '🎵 KRC解析结果:', {
            time: lineStartTime,
            text: wordData.fullText,
            wordsCount: wordData.words.length
          })
        }
      }
      
      // 按时间排序
      result.sort((a, b) => a.time - b.time)
      
      logger.trace('MusicPlayer', '🎵 KRC桌面歌词解析结果:', {
        totalLines: result.length,
        firstFew: result.slice(0, 3),
        lastFew: result.slice(-3)
      })
      
      return result
    },

    // 解析KRC逐字时间信息
    parseKrcWordTimings(content, lineStartTime) {
      const words = []
      let fullText = ''
      
      // 正则表达式匹配 <时间偏移,持续时间,类型>文字 的模式
      const wordPattern = /<(\d+),(\d+)(?:,\d+)?>(.*?)(?=<|\s*$)/g
      let match
      
      while ((match = wordPattern.exec(content)) !== null) {
        const timeOffset = parseInt(match[1])     // 时间偏移（毫秒）
        const duration = parseInt(match[2])       // 持续时间（毫秒）
        let text = match[3]                       // 文字内容（保留原始空格）
        
        if (text) {
          const wordObj = {
            word: text, // 保持与全屏歌词一致的字段名
            startTime: timeOffset, // 相对时间偏移
            endTime: timeOffset + duration, // 相对结束时间
            duration: duration
          }
          
          words.push(wordObj)
          fullText += text
        }
      }
      
      // 如果没有匹配到逐字信息，尝试提取纯文本
      if (words.length === 0) {
        const plainText = content
          .replace(/<\d+,\d+(?:,\d+)?>/g, '') // 移除时间标签
          .replace(/<\/?\w+>/g, '')           // 移除其他HTML标签
          .trim()
        
        if (plainText) {
          fullText = plainText
          // 创建一个整行的word对象
          words.push({
            word: plainText,
            startTime: 0,
            endTime: 0,
            duration: 0
          })
        }
      }
      
      return {
        words: words,
        fullText: fullText
      }
    },

    // 解析LRC格式歌词
    parseLrcLyrics(lines) {
      const result = []
      const timeRegex = /\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]/g
      
      for (let i = 0; i < lines.length; i++) {
        const trimmedLine = lines[i].trim()
        if (!trimmedLine) continue
        
        // 跳过元数据行
        if (trimmedLine.match(/^\[(?:ar|ti|al|by|offset|id|length|re|ve|language)[:]/i)) {
          logger.trace('MusicPlayer', '🎵 跳过LRC元数据行:', trimmedLine.substring(0, 50))
          continue
        }
        
        // 检查是否包含时间标签
        const hasTimeTag = /\[\d{1,2}:\d{2}/.test(trimmedLine)
        if (!hasTimeTag) {
          logger.trace('MusicPlayer', '🎵 跳过无时间标签的LRC行:', trimmedLine.substring(0, 50))
          continue
        }
        
        logger.trace('MusicPlayer', '🎵 处理LRC歌词行:', trimmedLine.substring(0, 100))
        
        const timeMatches = []
        
        // 重置正则表达式的lastIndex
        timeRegex.lastIndex = 0
        let match
        
        // 找到所有时间标签
        while ((match = timeRegex.exec(trimmedLine)) !== null) {
          const minutes = parseInt(match[1])
          const seconds = parseInt(match[2])
          const millisecondsStr = match[3] || '0'
          const milliseconds = parseInt(millisecondsStr.padEnd(3, '0'))
          const timeInMs = minutes * 60000 + seconds * 1000 + milliseconds
          timeMatches.push(timeInMs)
        }
        
        // 移除时间标签，获取纯歌词文本
        const text = trimmedLine.replace(/\[\d{1,2}:\d{2}(?:\.\d{1,3})?\]/g, '').trim()
        
        // 为每个时间标签创建歌词对象
        for (const timeInMs of timeMatches) {
          const lyricObj = {
            time: timeInMs,
            text: text || '♪'
          }
          result.push(lyricObj)
        }
      }
      
      // 按时间排序
      result.sort((a, b) => a.time - b.time)
      
      logger.trace('MusicPlayer', '🎵 LRC桌面歌词解析结果:', {
        totalLines: result.length,
        firstFew: result.slice(0, 3)
      })
      
      return result
    },
    
    // 播放/暂停
    togglePlay() {
      const audioEl = this.$refs.audioPlayer
      if (this.isReplacingQualitySource) return
      if (this.isDisposed || !audioEl || !audioEl.getAttribute('src')) {
        logger.warn('MusicPlayer', '没有设置音频源')
        return
      }
      
      if (this.isPlaying) {
        audioEl.pause()
      } else {
        audioEl.play().catch(error => {
          logger.error('MusicPlayer', '播放失败:', error)
        })
      }
    },
    
    // 上一曲
    async playPrevious() {
      if (this.playlist.length === 0) return
      
      // 防止并发切歌，使用更短的锁定时间
      if (this.isSwitchingSong) {
        if (process.env.NODE_ENV === 'development') {
          logger.warn('MusicPlayer', '正在切歌中，忽略本次请求')
        }
        return
      }
      
      // 设置切歌锁，使用更轻量的锁机制
      this.isSwitchingSong = true
      
      if (process.env.NODE_ENV === 'development') {
        logger.trace('MusicPlayer', '🎵 开始切歌（上一曲）- isSwitchingSong:', this.isSwitchingSong, 'showLyricView:', this.showLyricView)
        // 性能监控：记录RAF调用计数
        if (window._lyricRafCount) {
          logger.trace('MusicPlayer', '🔄 切歌前RAF调用总数:', window._lyricRafCount)
          window._switchStartRafCount = window._lyricRafCount
        }
      }
      
      const originalIndex = this.currentIndex
      let attempts = 0
      const maxAttempts = Math.min(5, this.playlist.length) // 最多尝试5首歌，避免无限循环
      
      this.isNavigatingHistory = true // 设置导航标志
      
      try {
        while (attempts < maxAttempts && !this.isDisposed && !this.pendingSong) {
          let prevIndex = -1
          if (this.playMode === 'shuffle') {
            // 使用预先打乱的播放列表
            if (this.shuffledPlaylist.length > 0) {
              // 在已打乱的列表中找到当前位置
              const shuffledIndex = this.shuffledPlaylist.findIndex(song => song.hash === this.currentSong?.hash)
              if (shuffledIndex !== -1) {
                // 从当前位置开始，寻找上一首有效歌曲
                for (let i = 1; i < this.shuffledPlaylist.length; i++) {
                  const candidateIndex = (shuffledIndex - i + this.shuffledPlaylist.length) % this.shuffledPlaylist.length
                  const candidateSong = this.shuffledPlaylist[candidateIndex]
                  if (candidateSong && candidateSong.hash) {
                    prevIndex = this.playlist.findIndex(song => song.hash === candidateSong.hash)
                    if (prevIndex !== -1) {
                      logger.trace('MusicPlayer', '随机模式上一首:', candidateSong.name, '原始索引:', prevIndex)
                      break
                    }
                  }
                }
              }
              
              // 如果还没找到有效歌曲，在整个随机列表中逆序寻找
              if (prevIndex === -1) {
                for (let i = this.shuffledPlaylist.length - 1; i >= 0; i--) {
                  const candidateSong = this.shuffledPlaylist[i]
                  if (candidateSong && candidateSong.hash) {
                    prevIndex = this.playlist.findIndex(song => song.hash === candidateSong.hash)
                    if (prevIndex !== -1) {
                      logger.trace('MusicPlayer', '随机列表中找到有效歌曲:', candidateSong.name, '原始索引:', prevIndex)
                      break
                    }
                  }
                }
              }
            }
            
            // 最后的备选方案：在原始播放列表中逆序寻找有效歌曲
            if (prevIndex === -1) {
              for (let i = 0; i < this.playlist.length; i++) {
                const candidateIndex = (this.currentIndex - i - 1 + this.playlist.length) % this.playlist.length
                const candidateSong = this.playlist[candidateIndex]
                if (candidateSong && candidateSong.hash) {
                  prevIndex = candidateIndex
                  logger.trace('MusicPlayer', '原始列表中找到有效歌曲:', candidateSong.name, '索引:', prevIndex)
                  break
                }
              }
            }
          } else {
            // 列表循环 - 寻找上一首有效歌曲
            for (let i = 1; i <= this.playlist.length; i++) {
              const candidateIndex = (this.currentIndex - i + this.playlist.length) % this.playlist.length
              const candidateSong = this.playlist[candidateIndex]
              if (candidateSong && candidateSong.hash) {
                prevIndex = candidateIndex
                logger.trace('MusicPlayer', '循环模式上一首:', candidateSong.name, '索引:', prevIndex)
                break
              }
            }
          }
          
          // 如果没有找到任何有效歌曲，直接退出
          if (prevIndex === -1) {
            logger.error('MusicPlayer', '播放列表中没有有效歌曲（含有hash字段）')
            break
          }
          
          this.currentIndex = prevIndex
          const nextSong = this.playlist[this.currentIndex]
          logger.trace('MusicPlayer', `尝试播放上一曲 (${attempts + 1}/${maxAttempts}):`, nextSong.name || nextSong.filename, '索引:', this.currentIndex)
          
          // 双重检查：验证歌曲是否有效
          if (!nextSong || !nextSong.hash) {
            logger.warn('MusicPlayer', '选中的歌曲无效，跳过:', nextSong)
            attempts++
            await this.waitForDelay(300)
            continue
          }
          
          const success = await this.loadSong(nextSong, 'previous')
          if (this.isDisposed || this.pendingSong) return
          if (success) {
            logger.trace('MusicPlayer', '上一曲加载成功:', nextSong.name)
            return
          }
          
          logger.warn('MusicPlayer', '上一曲加载失败，尝试下一首...')
          // 添加短暂延迟，避免过快切换
          await this.waitForDelay(500)
          attempts++
        }
        
        // 所有歌曲都尝试失败
        if (this.isDisposed || this.pendingSong) return
        logger.error('MusicPlayer', '所有歌曲都无法播放')
        this.currentIndex = originalIndex
        this.showError('播放列表中没有可播放的歌曲')
      } finally {
        this.isNavigatingHistory = false // 重置导航标志
        // 立即解除切歌锁，不使用延迟
        this.isSwitchingSong = false
        
        if (process.env.NODE_ENV === 'development') {
          logger.trace('MusicPlayer', '✅ 上一曲切歌完成，已解锁 - isSwitchingSong:', this.isSwitchingSong)
          // 性能监控：计算切歌期间的RAF调用增量
          if (window._switchStartRafCount && window._lyricRafCount) {
            const rafIncrease = window._lyricRafCount - window._switchStartRafCount
            logger.trace('MusicPlayer', '🔄 上一曲切歌期间RAF调用增量:', rafIncrease, '总计:', window._lyricRafCount)
          }
        }
      }
    },
    
    // 下一曲
    async playNext(source = 'next') {
      if (this.playlist.length === 0) return
      // 按钮事件与系统控制都归入手动下一首；自动续播保留独立过渡。
      const transition = source === 'auto' ? 'auto' : 'next'
      
      // 防止并发切歌，使用更短的锁定时间
      if (this.isSwitchingSong) {
        if (process.env.NODE_ENV === 'development') {
          logger.warn('MusicPlayer', '正在切歌中，忽略本次请求')
        }
        return
      }
      
      // 设置切歌锁，使用更轻量的锁机制
      this.isSwitchingSong = true
      
      if (process.env.NODE_ENV === 'development') {
        logger.trace('MusicPlayer', '🎵 开始切歌（下一曲）- isSwitchingSong:', this.isSwitchingSong, 'showLyricView:', this.showLyricView)
        // 性能监控：记录RAF调用计数
        if (window._lyricRafCount) {
          logger.trace('MusicPlayer', '🔄 切歌前RAF调用总数:', window._lyricRafCount)
          window._switchStartRafCount = window._lyricRafCount
        }
      }
      
      try {
        const originalIndex = this.currentIndex
        let attempts = 0
        const maxAttempts = Math.min(5, this.playlist.length) // 最多尝试5首歌，避免无限循环
      
      while (attempts < maxAttempts && !this.isDisposed && !this.pendingSong) {
        // 先检查"下一首播放"队列
        if (this.playNextQueue.length > 0) {
          const nextSong = this.playNextQueue.shift() // 取出队列第一首
          let songIndex = this.playlist.findIndex(s => s.hash === nextSong.hash)
          
          // 如果歌曲不在播放列表中，添加它
          if (songIndex === -1) {
            const updatedPlaylist = [...this.playlist, nextSong]
            this.$emit('playlist-updated', updatedPlaylist)
            await this.$nextTick()
            if (this.isDisposed || this.pendingSong) return
            songIndex = updatedPlaylist.length - 1
            logger.trace('MusicPlayer', '🎵 队列歌曲不在播放列表中，已添加:', nextSong.name)
            
            // 如果是随机模式，重新生成随机播放列表
            if (this.playMode === 'shuffle') {
              this.generateShuffledPlaylist()
              logger.trace('MusicPlayer', '🔀 重新生成随机播放列表以包含队列歌曲')
            }
          }
          
          this.currentIndex = songIndex
          logger.trace('MusicPlayer', '播放"下一首播放"队列中的歌曲:', nextSong.name, '索引:', this.currentIndex)
          
          const success = await this.loadSong(nextSong, transition)
          if (this.isDisposed || this.pendingSong) return
          if (success) {
            logger.trace('MusicPlayer', '下一首播放成功:', nextSong.name)
            return
          }
          logger.warn('MusicPlayer', '下一首播放失败，继续尝试队列中的下一首或正常播放...')
          attempts++
          continue // 继续尝试下一首
        }
        
        // 正常播放逻辑
        let nextIndex = -1
        if (this.playMode === 'shuffle') {
          // 使用预先打乱的播放列表
          if (this.shuffledPlaylist.length > 0) {
            // 在已打乱的列表中找到当前位置
            const shuffledIndex = this.shuffledPlaylist.findIndex(song => song.hash === this.currentSong?.hash)
            if (shuffledIndex !== -1) {
              // 从当前位置开始，寻找下一首有效歌曲
              for (let i = 1; i < this.shuffledPlaylist.length; i++) {
                const candidateIndex = (shuffledIndex + i) % this.shuffledPlaylist.length
                const candidateSong = this.shuffledPlaylist[candidateIndex]
                if (candidateSong && candidateSong.hash) {
                  nextIndex = this.playlist.findIndex(song => song.hash === candidateSong.hash)
                  if (nextIndex !== -1) {
                    logger.trace('MusicPlayer', '随机模式下一首:', candidateSong.name, '原始索引:', nextIndex)
                    break
                  }
                }
              }
            }
            
            // 如果还没找到有效歌曲，在整个随机列表中寻找
            if (nextIndex === -1) {
              for (let i = 0; i < this.shuffledPlaylist.length; i++) {
                const candidateSong = this.shuffledPlaylist[i]
                if (candidateSong && candidateSong.hash) {
                  nextIndex = this.playlist.findIndex(song => song.hash === candidateSong.hash)
                  if (nextIndex !== -1) {
                    logger.trace('MusicPlayer', '随机列表中找到有效歌曲:', candidateSong.name, '原始索引:', nextIndex)
                    break
                  }
                }
              }
            }
          }
          
          // 最后的备选方案：在原始播放列表中寻找有效歌曲
          if (nextIndex === -1) {
            for (let i = 0; i < this.playlist.length; i++) {
              const candidateIndex = (this.currentIndex + i + 1) % this.playlist.length
              const candidateSong = this.playlist[candidateIndex]
              if (candidateSong && candidateSong.hash) {
                nextIndex = candidateIndex
                logger.trace('MusicPlayer', '原始列表中找到有效歌曲:', candidateSong.name, '索引:', nextIndex)
                break
              }
            }
          }
        } else {
          // 列表循环 - 寻找下一首有效歌曲
          for (let i = 1; i <= this.playlist.length; i++) {
            const candidateIndex = (this.currentIndex + i) % this.playlist.length
            const candidateSong = this.playlist[candidateIndex]
            if (candidateSong && candidateSong.hash) {
              nextIndex = candidateIndex
              logger.trace('MusicPlayer', '循环模式下一首:', candidateSong.name, '索引:', nextIndex)
              break
            }
          }
        }
        
        // 如果没有找到任何有效歌曲，直接退出
        if (nextIndex === -1) {
          logger.error('MusicPlayer', '播放列表中没有有效歌曲（含有hash字段）')
          break
        }
        
        this.currentIndex = nextIndex
        const nextSong = this.playlist[this.currentIndex]
        logger.trace('MusicPlayer', `尝试播放下一曲 (${attempts + 1}/${maxAttempts}):`, nextSong.name || nextSong.filename, '索引:', this.currentIndex)
        
        // 双重检查：验证歌曲是否有效
        if (!nextSong || !nextSong.hash) {
          logger.warn('MusicPlayer', '选中的歌曲无效，跳过:', nextSong)
          attempts++
          await this.waitForDelay(300)
          continue
        }
        
        const success = await this.loadSong(nextSong,
          transition === 'next' && this.playMode === 'shuffle' ? 'shuffle' : transition)
          if (this.isDisposed || this.pendingSong) return
        if (success) {
          logger.trace('MusicPlayer', '下一曲加载成功:', nextSong.name)
          // 更新随机播放的已播放历史
          if (this.playMode === 'shuffle' && !this.playedHistory.includes(this.currentIndex)) {
            this.playedHistory.push(this.currentIndex)
          }
          return
        }
        
        logger.warn('MusicPlayer', '下一曲加载失败，尝试下一首...')
        // 添加短暂延迟，避免过快切换
        await this.waitForDelay(500)
        attempts++
      }
      
      // 所有歌曲都尝试失败
      if (this.isDisposed || this.pendingSong) return
      logger.error('MusicPlayer', '所有歌曲都无法播放')
      this.currentIndex = originalIndex
      this.showError('播放列表中没有可播放的歌曲')
      } finally {
        // 立即解除切歌锁，不使用延迟
        this.isSwitchingSong = false
        
        if (process.env.NODE_ENV === 'development') {
          logger.trace('MusicPlayer', '✅ 下一曲切歌完成，已解锁 - isSwitchingSong:', this.isSwitchingSong)
          // 性能监控：计算切歌期间的RAF调用增量
          if (window._switchStartRafCount && window._lyricRafCount) {
            const rafIncrease = window._lyricRafCount - window._switchStartRafCount
            logger.trace('MusicPlayer', '🔄 下一曲切歌期间RAF调用增量:', rafIncrease, '总计:', window._lyricRafCount)
          }
        }
      }
    },
    
    // RAF 驱动的高频时间更新（60fps）
    updateTimeLoop() {
      try {
        // 检查组件是否已卸载
        if (!this.$el || !this.$refs.audioPlayer) {
          return
        }
        
        const audioEl = this.$refs.audioPlayer
        if (!this.isReplacingQualitySource && audioEl && !isNaN(audioEl.currentTime)) {
          // 只在时间有明显变化时更新，减少不必要的响应式更新
          const newTime = audioEl.currentTime
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
      if (this.isDisposed || this.isReplacingQualitySource || !this.$refs.audioPlayer) return
      const duration = this.$refs.audioPlayer.duration
      this.duration = Number.isFinite(duration) && duration > 0 ? duration : 0
      // 初始化 MediaSession 位置状态
      this.updatePositionState()
    },
    
    // 播放结束
    handleEnded() {
      if (this.playMode === 'single') {
        this.$refs.audioPlayer.currentTime = 0
        this.$refs.audioPlayer.play().catch(error => {
          logger.error('MusicPlayer', '单曲循环重播失败:', error)
        })
      } else {
        this.playNext('auto')
      }
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
      const audio = this.$refs.audioPlayer
      if (hadPreview && audio && Number.isFinite(audio.currentTime)) this.currentTime = audio.currentTime
    },
    
    // 音量调节
    handleVolumeChange() {
      const audioEl = this.$refs.audioPlayer
      if (!audioEl || this.isDisposed) return
      this.volume = Math.max(0, Math.min(100, Number(this.volume) || 0))
      audioEl.volume = this.volume / 100
      this.isMuted = this.volume === 0
      audioEl.muted = this.isMuted
      
      // 保存音量设置到 localStorage
      localStorage.setItem('player_volume', this.volume)
    },
    
    // 静音切换
    toggleMute() {
      const audioEl = this.$refs.audioPlayer
      if (!audioEl || this.isDisposed) return
      this.isMuted = !this.isMuted
      audioEl.muted = this.isMuted
    },
    
    // 音频播放事件
    handlePlay() {
      if (this.isDisposed) return
      this.isPlaying = true
      // 更新 MediaSession 播放状态
      if ('mediaSession' in navigator) {
        navigator.mediaSession.playbackState = 'playing'
        this.updatePositionState()
      }
      // 同步播放状态到系统托盘
      if (window.electronAPI && window.electronAPI.updatePlaybackState) {
        window.electronAPI.updatePlaybackState(true)
      }
    },
    
    // 音频暂停事件
    handlePause() {
      if (this.isDisposed) return
      this.isPlaying = false
      // 更新 MediaSession 播放状态
      if ('mediaSession' in navigator) {
        navigator.mediaSession.playbackState = 'paused'
        this.updatePositionState()
      }
      // 同步播放状态到系统托盘
      if (window.electronAPI && window.electronAPI.updatePlaybackState) {
        window.electronAPI.updatePlaybackState(false)
      }
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
      this.isFavorite = !this.isFavorite
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
      if (!this.showLyricView && !this.isDisposed) this.$emit('lyric-view-changed', false)
    },

    // 处理歌词界面的进度跳转
    handleSeek(time) {
      const audioEl = this.$refs.audioPlayer
      if (this.isReplacingQualitySource) return
      if (!audioEl?.src || this.isDisposed || !Number.isFinite(time) || !Number.isFinite(this.duration) || this.duration <= 0) return
      const target = Math.max(0, Math.min(this.duration, time))
      this.cancelProgressDrag()
      audioEl.currentTime = target
      this.currentTime = target
      this.updatePositionState()
      logger.trace('MusicPlayer', '跳转歌曲进度', { time: target })
    },

    
    // 检查收藏状态
    checkFavoriteStatus() {
      if (!this.currentSong) {
        this.isFavorite = false
        return
      }
      
      try {
        const userId = localStorage.getItem('kugou_userid')
        if (!userId || localStorage.getItem('favorite_songs_userid') !== userId) {
          this.isFavorite = false
          return
        }
        const favorites = localStorage.getItem('favorite_songs')
        if (favorites) {
          const favoriteList = JSON.parse(favorites)
          this.isFavorite = Array.isArray(favoriteList) && favoriteList.some(song => song?.hash === this.currentSong.hash)
        } else {
          this.isFavorite = false
        }
      } catch (e) {
        logger.error('MusicPlayer', '检查收藏状态失败:', e)
        this.isFavorite = false
      }
    },
    
    // 显示/隐藏播放列表
    togglePlaylist() {
      this.showPlaylist = !this.showPlaylist
    },
    
    // 播放列表中的歌曲
    async handlePlaylistPlay(song) {
      if (this.playlist.some(item => item?.hash === song?.hash)) {
        return this.requestSong(song)
      }
      return false
    },

    /** 发出新队列交由父组件保存，并移除被删歌曲的待播记录。 */
    async handleRemoveSong(index) {
      if (this.isDisposed || !Number.isInteger(index) || index < 0 || index >= this.playlist.length) return
      const removedSong = this.playlist[index]
      const wasCurrentSong = removedSong?.hash === this.currentSong?.hash
      const updatedPlaylist = this.playlist.filter((_, songIndex) => songIndex !== index)
      this.playNextQueue = this.playNextQueue.filter(song => song?.hash !== removedSong?.hash)
      if (this.pendingSong?.hash === removedSong?.hash) this.pendingSong = null
      if (this.loadingSongHash === removedSong?.hash) {
        this.songRequestId++
        this.lyricRequestId++
        if (!wasCurrentSong && this.currentSong) this.pendingSong = this.currentSong
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
        const currentIndex = updatedPlaylist.findIndex(song => song?.hash === this.currentSong?.hash)
        if (currentIndex !== -1) this.currentIndex = currentIndex
      }
    },

    /** 清空时先停止播放和异步请求，再通知父组件移除队列。 */
    handleClearPlaylist() {
      this.showPlaylist = false
      this.stopPlayback()
      this.$emit('clear-playlist')
    },

    /** 下一首队列按歌曲 hash 去重，播放列表使用事件交由父组件替换。 */
    addToPlayNextQueue(song) {
      if (!song?.hash || this.isDisposed) return
      if (!this.playNextQueue.some(item => item?.hash === song.hash)) {
        this.playNextQueue.push(song)
        if (!this.playlist.some(item => item?.hash === song.hash)) {
          this.$emit('playlist-updated', [...this.playlist, song])
        }
      }
    },

    removeFromPlaylist(song) {
      if (!song?.hash) return
      const index = this.playlist.findIndex(item => item?.hash === song.hash)
      if (index !== -1) return this.handleRemoveSong(index)
      this.playNextQueue = this.playNextQueue.filter(item => item?.hash !== song.hash)
    },

    // 格式化时间
    formatTime(seconds) {
      if (!seconds || isNaN(seconds)) return '0:00'
      const mins = Math.floor(seconds / 60)
      const secs = Math.floor(seconds % 60)
      return `${mins}:${secs.toString().padStart(2, '0')}`
    },
    
    // 提取歌曲名称
    getSongName(fullName) {
      if (!fullName) return '未知歌曲'
      const parts = fullName.split(' - ')
      if (parts.length > 1) {
        return parts.slice(1).join(' - ')
      }
      return fullName
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
      if ('mediaSession' in navigator) {
        try {
          // 提取歌名（去除歌手前缀）
          const songTitle = this.getSongName(song.filename || song.songname || song.audio_name || '未知歌曲')
          
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
      // 同首换源暂时从零加载，歌词和系统进度保留最后确认位置，提交后统一同步。
      if (this.isDisposed || this.isReplacingQualitySource) return
      const audioEl = this.$refs.audioPlayer
      if (audioEl && !isNaN(audioEl.currentTime)) {
        this.currentTime = audioEl.currentTime
        this.duration = audioEl.duration || 0
        
        // 节流发送播放时间到桌面歌词窗口（每150ms最多发送一次，减少闪烁）
        if (window.electronAPI && window.electronAPI.updatePlaybackTime) {
          const now = Date.now()
          if (!this.lastDesktopTimeUpdate || now - this.lastDesktopTimeUpdate >= 150) {
            this.lastDesktopTimeUpdate = now
            // 转换为毫秒并发送
            window.electronAPI.updatePlaybackTime(audioEl.currentTime * 1000)
          }
        }
        
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
    
    // 更新 MediaSession 位置状态
    updatePositionState() {
      if (this.isReplacingQualitySource) return
      if ('mediaSession' in navigator && 'setPositionState' in navigator.mediaSession) {
        try {
          const audioEl = this.$refs.audioPlayer
          if (audioEl && !isNaN(audioEl.duration) && audioEl.duration > 0) {
            navigator.mediaSession.setPositionState({
              duration: audioEl.duration,
              playbackRate: audioEl.playbackRate || 1.0,
              position: audioEl.currentTime || 0
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
            const audioEl = this.$refs.audioPlayer
            if (this.isDisposed || this.isReplacingQualitySource || !audioEl) return
            audioEl.currentTime = Math.max(0, audioEl.currentTime - (details.seekOffset || 10))
          })
          
          navigator.mediaSession.setActionHandler('seekforward', (details) => {
            const audioEl = this.$refs.audioPlayer
            if (this.isDisposed || this.isReplacingQualitySource || !audioEl || !Number.isFinite(audioEl.duration)) return
            audioEl.currentTime = Math.min(audioEl.duration, audioEl.currentTime + (details.seekOffset || 10))
          })
          
          // 进度跳转
          navigator.mediaSession.setActionHandler('seekto', (details) => {
            const audioEl = this.$refs.audioPlayer
            if (this.isDisposed || this.isReplacingQualitySource || !audioEl) return
            if (details.seekTime !== undefined) {
              audioEl.currentTime = details.seekTime
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
