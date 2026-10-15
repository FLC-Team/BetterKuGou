
import { logger } from '../../utils/logger.js'
import { useSettingsStore } from '../../stores/settingsStore.js'
import repeatAllIcon from '../../assets/icons/repeat_all.svg'
import repeatOneIcon from '../../assets/icons/repeat_one.svg'
import shuffleIcon from '../../assets/icons/shuffle.svg'

export default {
  name: 'LyricView',
  props: {
    visible: {
      type: Boolean,
      default: false
    },
    song: {
      type: Object,
      default: null
    },
    lyrics: {
      type: String,
      default: ''
    },
    lyricData: {
      type: Object,
      default: null
    },
    currentPlayTime: {
      type: Number,
      default: 0
    },
    previewTime: {
      type: Number,
      default: null
    },
    duration: {
      type: Number,
      default: 0
    },
    isPlaying: {
      type: Boolean,
      default: false
    },
    playMode: {
      type: String,
      default: 'loop'
    },
    isFavorite: {
      type: Boolean,
      default: false
    },
    pauseUpdates: {
      type: Boolean,
      default: false
    }
  },
  setup() {
    const settingsStore = useSettingsStore()
    return {
      settingsStore
    }
  },
  data() {
    return {
      parsedLyrics: [],
      currentLyricIndex: 0,
      currentCharIndex: 0,
      lyricLineRefs: {},
      handleWindowResize: null,
      previousBodyOverflow: null,
      previousFocus: null,
      seekPreviewTime: null,
      lastPlaybackTime: null,
      lineTransitionDuration: 0,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      coverFailed: false,
      isDisposed: false,
      scrollingLyricElement: null,
      // 性能监控
      lastUpdateTime: null,
      frameCount: 0,
      // 高性能卡拉OK缓存
      styleCache: new Map(),
      lastProgressValues: new Map(),
      rafId: null,
      // RAF 驱动的更新循环
      updateLoopRafId: null,
      internalPlayTime: 0, // 内部时间，用于 RAF 更新
      // 桥段进度条
      bridgeInfo: null, // { startTime, duration, startLyricIndex } - 当前桥段信息
      isBridgeActive: false, // 是否正在显示桥段进度条
      bridgeProgress: 0, // 桥段进度 0-100
      // 翻译相关
      hasTranslation: false, // 是否有翻译
      translationData: null, // 翻译数据
      showTranslation: false, // 是否显示翻译（会根据设置和检测结果动态设置）
      isNonChinese: false // 是否为非中文歌曲
    }
  },
  computed: {
    coverUrl() {
      const cover = this.song?.cover || this.song?.album_img
      return !this.coverFailed && typeof cover === 'string' ? cover.replace('{size}', '400') : ''
    },
    displayPlayTime() {
      const time = this.seekPreviewTime ?? this.previewTime ?? this.currentPlayTime
      return Number.isFinite(time) ? Math.max(0, Math.min(time, this.duration || 0)) : 0
    },
    progressPercentage() {
      if (!Number.isFinite(this.duration) || this.duration <= 0) return 0
      return this.displayPlayTime / this.duration * 100
    },
    playModeIcon() {
      return this.playMode === 'single' ? repeatOneIcon : this.playMode === 'shuffle' ? shuffleIcon : repeatAllIcon
    },
    playModeIconStyle() {
      return { '--mode-icon': `url("${this.playModeIcon}")` }
    },
    playModeText() {
      switch (this.playMode) {
        case 'loop': return '列表循环'
        case 'single': return '单曲循环' 
        case 'shuffle': return '随机播放'
        default: return '列表循环'
      }
    },
    lyricLineHeight() {
      let height = Math.min(80, Math.max(48, this.viewportHeight * 0.08))
      if (this.showTranslation && this.parsedLyrics.some(line => line.translation)) {
        height = Math.min(140, Math.max(84, this.viewportHeight * 0.12))
      }
      if (this.viewportWidth < 900 || this.viewportHeight < 600) height *= 0.7
      return height
    },
    // 检测所有桥段（句子间隔>10秒）
    bridges() {
      const bridges = []
      const BRIDGE_THRESHOLD = 20 // 20秒阈值，避免误检测短间隔
      const LYRIC_FINISH_OFFSET = 3 // 假设每句歌词在下一句前3秒唱完
      
      if (!this.parsedLyrics || this.parsedLyrics.length === 0) return bridges
      
      // 检查开头是否是桥段（第一句之前>10秒）
      if (this.parsedLyrics[0] && this.parsedLyrics[0].time > BRIDGE_THRESHOLD) {
        bridges.push({
          startTime: 0,
          endTime: this.parsedLyrics[0].time,
          duration: this.parsedLyrics[0].time,
          startLyricIndex: -1, // 开头前
          endLyricIndex: 0
        })
        if (process.env.NODE_ENV === 'development') {
          logger.trace('LyricView', '检测到开头桥段:', bridges[bridges.length - 1])
        }
      }
      
      // 检查句子之间的间隔
      for (let i = 0; i < this.parsedLyrics.length - 1; i++) {
        const currentLine = this.parsedLyrics[i]
        const nextLine = this.parsedLyrics[i + 1]
        const gap = nextLine.time - currentLine.time
        
        // 过滤创作信息行（作词、作曲等）
        const isInfoLine = /^(作词|作曲|编曲|演唱|歌手)[:：]/.test(currentLine.text) || 
                          /^(作词|作曲|编曲|演唱|歌手)[:：]/.test(nextLine.text)
        
        if (gap > BRIDGE_THRESHOLD && !isInfoLine) {
          // 计算当前句的实际结束时间
          let currentLineEndTime = currentLine.time + LYRIC_FINISH_OFFSET // 默认估算
          
          // 如果有 KRC 逐字信息，使用精确的结束时间
          if (currentLine.words && currentLine.words.length > 0) {
            const lastWord = currentLine.words[currentLine.words.length - 1]
            // 最后一个字的结束时间 = 行开始时间 + 字的相对结束时间
            currentLineEndTime = currentLine.time + lastWord.endTime
            
            if (process.env.NODE_ENV === 'development') {
              logger.trace('LyricView', `使用KRC精确时间 [行${i}]:`, {
                lineStart: currentLine.time.toFixed(2) + 's',
                lastWordEndTime: lastWord.endTime.toFixed(2) + 's',
                lineEndTime: currentLineEndTime.toFixed(2) + 's',
                text: currentLine.text.substring(0, 20)
              })
            }
          }
          
          // 桥段从当前句唱完后开始
          const bridgeStartTime = currentLineEndTime
          const bridgeDuration = nextLine.time - bridgeStartTime
          
          // 确保桥段时长合理（至少1秒）
          if (bridgeDuration >= 1) {
            bridges.push({
              startTime: bridgeStartTime,
              endTime: nextLine.time,
              duration: bridgeDuration,
              startLyricIndex: i,
              endLyricIndex: i + 1
            })
            if (process.env.NODE_ENV === 'development') {
              logger.trace('LyricView', `检测到桥段 [${i} -> ${i+1}]:`, {
                currentLineTime: currentLine.time.toFixed(2) + 's',
                currentLineEndTime: currentLineEndTime.toFixed(2) + 's',
                nextLineTime: nextLine.time.toFixed(2) + 's',
                gap: gap.toFixed(2) + 's',
                bridgeStart: bridgeStartTime.toFixed(2) + 's',
                bridgeDuration: bridgeDuration.toFixed(2) + 's',
                from: currentLine.text.substring(0, 20),
                to: nextLine.text.substring(0, 20)
              })
            }
          }
        }
      }
      
      // 注意：结尾不视为桥段
      
      if (process.env.NODE_ENV === 'development' && bridges.length > 0) {
        logger.debug('LyricView', '总共检测到', bridges.length, '个桥段')
      }
      return bridges
    },


  },
  watch: {
    'settingsStore.settings.playback.showTranslation'(value) {
      this.showTranslation = value ?? true
      this.styleCache.clear()
      this.handleLongLyric()
    },
    visible(newVal) {
      if (newVal) {
        this.startUpdateLoop() // 启动RAF循环
        this.lockBodyScroll()
      } else {
        this.cancelSeek()
        this.stopUpdateLoop() // 立即停止RAF循环，释放资源
        this.restoreBodyScroll()
        // 清理缓存，避免内存泄漏
        this.styleCache.clear()
        this.lastProgressValues.clear()
      }
    },
    lyrics: {
      immediate: true,
      handler(newLyrics) {
        this.parseLyrics(newLyrics, this.lyricData)
      }
    },
    lyricData: {
      immediate: true,
      handler(newData) {
        // 当歌词数据变化时重新解析
        if (this.lyrics) {
          this.parseLyrics(this.lyrics, newData)
        }
      }
    },
    song() {
      this.coverFailed = false
      this.cancelSeek()
      this.lastPlaybackTime = null
    },
    currentPlayTime() {
      if (this.visible && !this.pauseUpdates && !this.isDisposed) this.syncDisplayedTime()
    },
    previewTime() {
      if (this.visible && !this.pauseUpdates && !this.isDisposed) this.syncDisplayedTime(true)
    },
    pauseUpdates(newVal) {
      if (newVal) {
        this.cancelSeek()
        // 暂停更新时立即停止RAF循环
        this.stopUpdateLoop()
        if (process.env.NODE_ENV === 'development') {
          logger.debug('LyricView', '🔄 歌词更新已暂停 - 切歌进行中')
        }
      } else {
        // 恢复更新时重新启动RAF循环
        this.startUpdateLoop()
        if (process.env.NODE_ENV === 'development') {
          logger.debug('LyricView', '✅ 歌词更新已恢复 - 切歌完成')
        }
      }
    }
  },
  beforeUnmount() {
    this.isDisposed = true
    this.seekPreviewTime = null
    if (process.env.NODE_ENV === 'development') {
      logger.debug('LyricView', '🔄 LyricView 组件即将卸载，清理所有资源')
    }
    this.stopUpdateLoop()
    if (this.rafId) {
      cancelAnimationFrame(this.rafId)
    }
    
    // 移除窗口大小变化监听器
    if (this.handleWindowResize) {
      window.removeEventListener('resize', this.handleWindowResize)
      this.handleWindowResize.cancel()
    }
    
    // 清理所有缓存
    this.styleCache.clear()
    this.lastProgressValues.clear()
    this.lyricLineRefs = {}
    this.restoreBodyScroll()
    if (this.$el?.contains(document.activeElement) && this.previousFocus?.isConnected) {
      this.previousFocus.focus({ preventScroll: true })
    }
  },
  mounted() {
    if (process.env.NODE_ENV === 'development') {
      logger.debug('LyricView', '🎵 LyricView 组件已挂载')
    }
    // 启动持续的 RAF 更新循环
    this.startUpdateLoop()
    // v-if 首次挂载时 visible 已为 true，普通 watcher 不会触发初始化。
    if (this.visible) {
      this.lockBodyScroll()
      this.previousFocus = document.activeElement
      this.$nextTick(() => {
        if (!this.isDisposed) this.$refs.closeButton?.focus({ preventScroll: true })
      })
    }
    
    // 监听窗口大小变化
    this.handleWindowResize = this.debounce(this.onWindowResize, 100)
    window.addEventListener('resize', this.handleWindowResize)
    
    // 初始化窗口尺寸适配
    this.onWindowResize()
  },
  methods: {
    lockBodyScroll() {
      if (this.previousBodyOverflow === null) this.previousBodyOverflow = document.body.style.overflow
      document.body.style.overflow = 'hidden'
    },

    restoreBodyScroll() {
      if (this.previousBodyOverflow !== null) {
        document.body.style.overflow = this.previousBodyOverflow
        this.previousBodyOverflow = null
      }
    },

    /** 拖动预览优先驱动歌词，真实播放时间的回传不能覆盖尚未提交的位置。 */
    syncDisplayedTime(isSeek = false) {
      const time = this.seekPreviewTime ?? this.previewTime ?? this.currentPlayTime
      this.syncPlaybackTime(time, isSeek || this.seekPreviewTime != null || this.previewTime != null)
    },

    /** 时间和高亮立即同步；跳转用较短的位移过渡追随最新目标，首次定位不从首句滚入。 */
    syncPlaybackTime(time, isSeek = false) {
      if (this.isDisposed || !Number.isFinite(time)) return
      const nextTime = Math.max(0, time)
      const isInitialPosition = this.lastPlaybackTime == null
      const delta = this.lastPlaybackTime == null ? 0 : nextTime - this.lastPlaybackTime
      const previousIndex = this.currentLyricIndex
      const previousBridgeActive = this.isBridgeActive
      const previousBridgeAnchor = this.bridgeInfo?.startLyricIndex
      this.lastPlaybackTime = nextTime
      this.internalPlayTime = nextTime
      this.updateBridgeProgress()
      this.updateKaraokeStylesDirectly()
      const layoutChanged = previousIndex !== this.currentLyricIndex || previousBridgeActive !== this.isBridgeActive ||
        previousBridgeAnchor !== this.bridgeInfo?.startLyricIndex
      // 同目标的 prop 回传与 RAF 只同步高亮，保留已经启动的 seek 位移时长。
      if (isInitialPosition && !isSeek) this.lineTransitionDuration = 0
      else if (isSeek || delta < -0.25 || delta > 1) this.lineTransitionDuration = 0.24
      else if (layoutChanged) this.lineTransitionDuration = 0.45
      this.syncLongLyric()
    },
    // RAF 驱动的持续更新循环（60fps）
    updateLoop() {
      // 检查组件是否仍然可见，如果不可见或者被暂停则完全停止循环
      if (this.isDisposed || !this.visible || this.pauseUpdates) {
        if (process.env.NODE_ENV === 'development') {
          logger.debug('LyricView', '🛑 歌词更新循环已暂停 - visible:', this.visible, 'pauseUpdates:', this.pauseUpdates, 'rafId:', this.updateLoopRafId)
        }
        // 关键修复：确保当前RAF ID被清除，避免重复调用
        this.updateLoopRafId = null
        return
      }
      
      // 同步父组件传入的时间
      this.syncDisplayedTime()
      
      // 性能监控
      if (process.env.NODE_ENV === 'development') {
        if (!this.lastUpdateTime) {
          this.lastUpdateTime = performance.now()
          this.frameCount = 0
        } else {
          this.frameCount++
          const now = performance.now()
          if (now - this.lastUpdateTime >= 1000) {
            logger.debug('LyricView', `歌词更新帧率: ${this.frameCount} FPS`)
            this.lastUpdateTime = now
            this.frameCount = 0
          }
        }
      }
      
      // 持续循环
      this.updateLoopRafId = requestAnimationFrame(this.updateLoop)
      
      // 额外的性能监控：RAF调用计数
      if (process.env.NODE_ENV === 'development') {
        if (!window._lyricRafCount) {
          window._lyricRafCount = 0
        }
        window._lyricRafCount++
      }
    },
    
    // 启动更新循环
    startUpdateLoop() {
      // 首先停止任何现有的循环，避免重复
      this.stopUpdateLoop()
      
      if (!this.isDisposed && this.visible && !this.pauseUpdates) {
        if (process.env.NODE_ENV === 'development') {
          logger.debug('LyricView', '✅ 启动歌词更新循环 - visible:', this.visible, 'pauseUpdates:', this.pauseUpdates)
        }
        this.updateLoopRafId = requestAnimationFrame(this.updateLoop)
      } else {
        if (process.env.NODE_ENV === 'development') {
          logger.debug('LyricView', '⏸️ 跳过启动歌词更新循环 - visible:', this.visible, 'pauseUpdates:', this.pauseUpdates)
        }
      }
    },
    
    // 停止更新循环
    stopUpdateLoop() {
      if (this.updateLoopRafId) {
        if (process.env.NODE_ENV === 'development') {
          logger.debug('LyricView', '🛑 停止歌词更新循环 - rafId:', this.updateLoopRafId)
        }
        cancelAnimationFrame(this.updateLoopRafId)
        this.updateLoopRafId = null
      }
    },
    
    /** 桥段状态直接由播放时间确定，前后跳转无需等待旧歌词索引追上。 */
    updateBridgeProgress() {
      const wasActive = this.isBridgeActive
      const bridge = this.bridges.find(item => this.internalPlayTime >= item.startTime && this.internalPlayTime < item.endTime)
      this.isBridgeActive = !!bridge
      this.bridgeInfo = bridge || null
      this.bridgeProgress = bridge ? Math.max(0, Math.min(100, (this.internalPlayTime - bridge.startTime) / bridge.duration * 100)) : 0
      if (bridge && !wasActive) {
        const chars = this.$refs.lyricsContainer?.querySelectorAll('[data-line-index="' + Math.max(0, bridge.startLyricIndex) + '"]') || []
        chars.forEach(char => {
          char.style.color = 'var(--lyric-line)'
          char.style.fontWeight = '500'
          char.style.textShadow = ''
          char.style.transform = ''
        })
      }
    },

    /** 用主题颜色插值桥段进度，保留既有播放时间与比例计算。 */
    getBridgeProgressColor() {
      const progress = this.bridgeProgress
      
      if (progress > 50) {
        // 50% 以上沿用既有黄绿混合比例。
        const ratio = (100 - progress) / 50 // 1 -> 0
        return `color-mix(in srgb, var(--lyric-bridge-yellow) ${(1 - ratio) * 100}%, var(--lyric-bridge-green))`
      } else {
        // 50% 以下沿用既有黄红混合比例。
        const ratio = progress / 50 // 1 -> 0
        return `color-mix(in srgb, var(--lyric-bridge-yellow) ${ratio * 100}%, var(--lyric-bridge-red))`
      }
    },

    /** 桥段占用中心的一行，已唱完的前句留在其上方；屏外行保留位置以承接跨行跳转。 */
    getLyricLineStyle(index) {
      let relativeIndex = index - this.currentLyricIndex
      if (this.isBridgeActive && this.bridgeInfo) {
        relativeIndex = index - this.bridgeInfo.startLyricIndex
        if (index <= this.bridgeInfo.startLyricIndex) relativeIndex -= 1
      }
      const distance = Math.abs(relativeIndex)
      const maxVisibleDistance = 8 // 最大可见距离
      const viewportWidth = this.viewportWidth
      const translateY = Math.max(-maxVisibleDistance - 1, Math.min(maxVisibleDistance + 1, relativeIndex)) * this.lyricLineHeight
      const isCurrent = relativeIndex === 0

      // 计算视觉效果
      let opacity = 1
      let blur = 0
      let scale = 1
      let fontWeight = 400
      
      if (isCurrent) {
        fontWeight = 600
      } else if (relativeIndex < 0) {
        // 已播放 - 从近到远模糊
        const relativeDistance = -relativeIndex
        if (relativeDistance === 1) {
          opacity = 0.9
          blur = Math.min(2, viewportWidth / 600) // 根据屏幕大小调整模糊度
          scale = 0.95
        } else {
          opacity = Math.max(0.05, 1 - (relativeDistance * 0.2))
          blur = Math.min(5, relativeDistance * 1.5 * Math.min(1, viewportWidth / 800))
          scale = Math.max(0.8, 1 - (relativeDistance * 0.1))
        }
      } else {
        // 未播放 - 从近到远模糊
        const relativeDistance = relativeIndex
        opacity = Math.max(0.1, 1 - (relativeDistance * 0.15))
        blur = Math.min(3, relativeDistance * 0.8 * Math.min(1, viewportWidth / 800))
        scale = Math.max(0.85, 1 - (relativeDistance * 0.08))
      }

      return {
        position: 'absolute',
        top: '50%',
        left: '50%',
        width: '100%',
        transform: `translate(-50%, -50%) translateY(${translateY}px) scale(${scale})`,
        opacity: distance > maxVisibleDistance ? 0 : opacity,
        visibility: distance > maxVisibleDistance ? 'hidden' : 'visible',
        filter: `blur(${blur}px)`,
        fontSize: isCurrent ? 'var(--current-font-size)' : 'var(--base-font-size)',
        fontWeight: fontWeight,
        zIndex: isCurrent ? 10 : 1,
        transition: this.lineTransitionDuration > 0
          ? `transform ${this.lineTransitionDuration}s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.3s ease, filter 0.3s ease` : 'none',
        pointerEvents: isCurrent ? 'auto' : 'none'
      }
    },
    
    // 获取歌曲名称
    getSongName(song) {
      if (!song) return '未知歌曲'
      // 取可用的原始标题
      const raw = (song.name || song.songname || song.audio_name || song.filename || '').toString()

      if (!raw) return '未知歌曲'

      // 常见格式："歌手 - 歌名"，也可能使用不同的破折号
      // 如果包含分隔符，则优先取最后一段作为歌名，避免将歌手名带入标题
      const parts = raw.split(/\s[-—–]\s/)
      let title = parts.length >= 2 ? parts[parts.length - 1].trim() : raw.trim()

      // 去掉常见音频扩展名
      title = title.replace(/\.(mp3|flac|wav|m4a|aac)$/i, '')

      // 兜底
      return title || '未知歌曲'
    },
    
    // 获取歌手名称
    getSingerNames(song) {
      if (!song) return '未知歌手'
      
      // 尝试不同的字段
      if (song.singername) return song.singername
      if (song.artist) return song.artist
      
      // 处理歌手信息数组
      if (song.singerinfo && Array.isArray(song.singerinfo) && song.singerinfo.length > 0) {
        const names = song.singerinfo.map(singer => {
          if (typeof singer === 'object' && singer !== null) {
            return singer.name || singer.singer_name || singer.singername || singer.author_name
          }
          return String(singer)
        }).filter(name => name && name.trim() && name !== '[object Object]')
        
        if (names.length > 0) {
          return names.join(' / ')
        }
      }
      
      if (song.authors && Array.isArray(song.authors)) {
        return song.authors.map(author => author.author_name).filter(Boolean).join(' / ')
      }
      
      // 从 name 字段提取(格式: "歌手 - 歌名")
      if (song.name) {
        // 兼容不同破折号：半角/全角/短横/长横
        const match = song.name.split(/\s[-—–]\s/)
        if (match.length >= 2) {
          return match[0].trim()
        }
      }
      
      return '未知歌手'
    },

    // 时间格式化
    formatTime(seconds) {
      if (!seconds || seconds < 0) return '00:00'
      const mins = Math.floor(seconds / 60)
      const secs = Math.floor(seconds % 60)
      return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
    },

    // 开始时间时钟
    // 解析翻译数据（从language字段）
    parseTranslationData(languageField) {
      try {
        logger.trace('LyricView', '开始解析翻译数据:', languageField)
        
        if (!languageField) {
          logger.trace('LyricView', '没有language字段')
          return null
        }

        // 解码Base64字符串
        let decodedData
        try {
          decodedData = atob(languageField)
          logger.trace('LyricView', 'Base64解码成功:', decodedData.substring(0, 200))
        } catch (e) {
          logger.trace('LyricView', 'Base64解码失败，尝试直接解析JSON:', e)
          decodedData = languageField
        }

        // 解析JSON
        const translationObj = JSON.parse(decodedData)
        logger.trace('LyricView', '翻译数据解析成功:', translationObj)

        if (!translationObj.content || !Array.isArray(translationObj.content)) {
          logger.trace('LyricView', '翻译数据格式不正确')
          return null
        }

        // 提取原文和翻译
        let originalContent = null
        let translationContent = null

        translationObj.content.forEach(item => {
          if (item.type === 0) {
            // 原文（发音）
            originalContent = item.lyricContent
          } else if (item.type === 1) {
            // 翻译
            translationContent = item.lyricContent
          }
        })

        logger.trace('LyricView', '原文内容:', originalContent)
        logger.trace('LyricView', '翻译内容:', translationContent)
        
        // 输出翻译内容的前几行用于调试
        if (translationContent && Array.isArray(translationContent)) {
          logger.trace('LyricView', '=== 翻译数据详细信息 ===')
          logger.trace('LyricView', `翻译总行数: ${translationContent.length}`)
          translationContent.slice(0, 5).forEach((item, index) => {
            logger.trace('LyricView', `翻译第${index + 1}行:`, item)
          })
          logger.trace('LyricView', '=======================')
        }

        return {
          original: originalContent,
          translation: translationContent,
          version: translationObj.version
        }
      } catch (error) {
        logger.error('LyricView', '解析翻译数据失败:', error)
        return null
      }
    },

    // 检测歌曲是否为非中文
    detectNonChineseSong(songData, lyricsData) {
      try {
        // 方法1：检查歌曲信息中的语言标识
        if (songData) {
          const songName = this.getSongName(songData)
          const artistName = this.getSingerNames(songData)
          
          // 检查歌名和歌手名是否包含非中文字符
          const hasChinese = /[\u4e00-\u9fff]/.test(songName + artistName)
          const hasJapanese = /[\u3040-\u309f\u30a0-\u30ff]/.test(songName + artistName)
          const hasKorean = /[\uac00-\ud7af]/.test(songName + artistName)
          const hasEnglish = /[a-zA-Z]/.test(songName + artistName)
          
          logger.trace('LyricView', '语言检测结果:', { 
            songName, 
            artistName, 
            hasChinese, 
            hasJapanese, 
            hasKorean, 
            hasEnglish 
          })
          
          // 如果有日文、韩文，或者英文但没有中文，认为是非中文歌曲
          if (hasJapanese || hasKorean || (hasEnglish && !hasChinese)) {
            return true
          }
        }

        // 方法2：检查歌词内容
        if (lyricsData && typeof lyricsData === 'string') {
          const lyricsText = lyricsData.substring(0, 1000) // 取前1000字符检测
          const chineseCharCount = (lyricsText.match(/[\u4e00-\u9fff]/g) || []).length
          const totalCharCount = lyricsText.replace(/[^\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7afa-zA-Z]/g, '').length
          
          if (totalCharCount > 0) {
            const chineseRatio = chineseCharCount / totalCharCount
            logger.trace('LyricView', '歌词中文比例:', chineseRatio, '中文字符:', chineseCharCount, '总字符:', totalCharCount)
            
            // 如果中文字符比例小于30%，认为是非中文歌曲
            return chineseRatio < 0.3
          }
        }

        return false
      } catch (error) {
        logger.error('LyricView', '检测歌曲语言失败:', error)
        return false
      }
    },

    // 解析歌词
    parseLyrics(lrcContent, rawLyricData = null) {
      logger.trace('LyricView', '解析歌词，内容长度:', lrcContent?.length)
      logger.trace('LyricView', '歌词内容预览:', lrcContent?.substring(0, 200))
      logger.trace('LyricView', '原始歌词数据:', rawLyricData)
      
      // 重置翻译相关状态
      this.hasTranslation = false
      this.translationData = null
      this.isNonChinese = false
      this.showTranslation = false

      // 检测是否为非中文歌曲
      this.isNonChinese = this.detectNonChineseSong(this.song, lrcContent)
      logger.trace('LyricView', '是否为非中文歌曲:', this.isNonChinese)

      // 详细检查原始歌词数据结构
      logger.trace('LyricView', '🔍 检查原始歌词数据结构:')
      logger.trace('LyricView', '  rawLyricData 是否存在:', !!rawLyricData)
      logger.trace('LyricView', '  rawLyricData 类型:', typeof rawLyricData)
      if (rawLyricData) {
        logger.trace('LyricView', '  rawLyricData 所有键:', Object.keys(rawLyricData))
        logger.trace('LyricView', '  rawLyricData.language 是否存在:', 'language' in rawLyricData)
        logger.trace('LyricView', '  rawLyricData 完整内容:', rawLyricData)
        
        // 检查是否有其他可能包含翻译的字段
        const possibleFields = ['trans', 'translation', 'lang', 'multilang', 'lyric_translation', 'lyricTranslation', 'translationData']
        possibleFields.forEach(field => {
          if (rawLyricData[field]) {
            logger.trace('LyricView', `  🔍 发现可能的翻译字段 ${field}:`, rawLyricData[field])
          }
        })
      }

      // 尝试解析翻译数据 - 检查多个可能的数据源
      let languageField = null
      
      // 方法1：直接从rawLyricData.language获取
      if (rawLyricData && rawLyricData.language) {
        languageField = rawLyricData.language
        logger.trace('LyricView', '✅ 从rawLyricData.language获取到翻译数据')
      }
      
      // 方法2：从decodeContent中的[language:...]标签提取
      if (!languageField && lrcContent) {
        const languageMatch = lrcContent.match(/\[language:(.*?)\]/s)
        if (languageMatch && languageMatch[1]) {
          languageField = languageMatch[1]
          logger.trace('LyricView', '✅ 从歌词内容的[language:...]标签中提取到翻译数据')
        }
      }
      
      // 开始解析翻译数据
      if (languageField) {
        logger.trace('LyricView', '🔍 开始解析翻译数据，数据长度:', languageField.length)
        this.translationData = this.parseTranslationData(languageField)
        if (this.translationData) {
          this.hasTranslation = true
          // 根据用户设置和歌曲类型决定是否显示翻译
          const userSetting = this.settingsStore.settings?.playback?.showTranslation ?? true // 默认显示翻译
          // 临时强制显示翻译用于测试
          this.showTranslation = userSetting // 暂时不考虑语言检测，直接显示翻译
          logger.trace('LyricView', '✅ 成功解析翻译数据')
          logger.trace('LyricView', '  - 翻译版本:', this.translationData.version)
          logger.trace('LyricView', '  - 是否为非中文歌曲:', this.isNonChinese)
          logger.trace('LyricView', '  - 用户设置显示翻译:', userSetting)
          logger.trace('LyricView', '  - 最终显示翻译:', this.showTranslation)
        } else {
          logger.trace('LyricView', '❌ 翻译数据存在但解析失败')
        }
      } else {
        logger.trace('LyricView', '❌ 没有找到翻译数据')
      }
      
      if (!lrcContent) {
        this.parsedLyrics = [{ time: 0, text: '暂无歌词' }]
        logger.trace('LyricView', '歌词内容为空')
        return
      }

      // 清理BOM和多余的空白字符
      let cleanContent = lrcContent.replace(/^\ufeff/, '') // 移除BOM
      cleanContent = cleanContent.trim()
      
      logger.trace('LyricView', '清理后内容预览:', cleanContent?.substring(0, 200))

      // 处理不同的换行符（\r\n, \n, \r）
      const lines = cleanContent.split(/\r\n|\n|\r/).filter(line => line.trim())
      const result = []
      
      logger.trace('LyricView', '歌词总行数:', lines.length)
      logger.trace('LyricView', '前5行原始内容:', lines.slice(0, 5))
      
      for (let line of lines) {
        logger.trace('LyricView', '处理行:', line)
        
        // KRC格式：[时间,持续时间]<字符时间信息>歌词内容
        const krcMatch = line.match(/^\[(\d+),(\d+)\](.*)$/)
        if (krcMatch) {
          const startTime = parseInt(krcMatch[1]) / 1000  // 毫秒转秒
          const duration = parseInt(krcMatch[2]) / 1000   // 毫秒转秒
          const text = krcMatch[3].trim()
          
          logger.trace('LyricView', 'KRC行匹配:', { startTime, duration, text: text.substring(0, 50) })
          
          if (text) {
            // 解析KRC格式的逐字时间信息
            const words = this.parseKrcWords(text)
            const lineText = words.map(w => w.word).join('')
            
            logger.trace('LyricView', 'KRC 解析结果 - words数量:', words.length)
            logger.trace('LyricView', 'KRC 解析结果 - lineText:', lineText)
            logger.trace('LyricView', 'KRC 解析结果 - 是否有空格:', lineText.includes(' '))
            
            if (lineText.trim()) {
              result.push({ 
                time: startTime, 
                text: lineText, 
                words: words // 保存逐字信息
              })
              logger.trace('LyricView', '添加KRC歌词行:', lineText)
            }
          }
        } else {
          // 普通LRC格式：[mm:ss.xx]歌词内容
          const lrcMatch = line.match(/^\[(\d{2}):(\d{2})(?:\.(\d{2,3}))?\](.*)$/)
          if (lrcMatch) {
            const minutes = parseInt(lrcMatch[1])
            const seconds = parseInt(lrcMatch[2])
            const milliseconds = lrcMatch[3] ? parseInt(lrcMatch[3].padEnd(3, '0')) : 0
            const time = minutes * 60 + seconds + milliseconds / 1000
            const text = lrcMatch[4].trim()
            
            logger.trace('LyricView', 'LRC行匹配:', { time, text })
            
            if (text) {
              result.push({ time, text })
              logger.trace('LyricView', '添加LRC歌词行:', text)
            }
          } else {
            // 跳过元信息行（如[ar:], [ti:]等）
            if (!line.match(/^\[[a-z]+:/)) {
              logger.trace('LyricView', '无法匹配的行:', line)
            }
          }
        }
      }
      
      // 按时间排序
      result.sort((a, b) => a.time - b.time)
      this.parsedLyrics = result.length > 0 ? result : [{ time: 0, text: '暂无歌词' }]
      
      // 检查是否有空格
      const hasSpaces = result.some(line => line.text.includes(' '))
      logger.trace('LyricView', '🔍 歌词是否包含空格:', hasSpaces)
      if (hasSpaces) {
        const linesWithSpaces = result.filter(line => line.text.includes(' '))
        logger.trace('LyricView', '包含空格的行数:', linesWithSpaces.length)
        logger.trace('LyricView', '第一行带空格的歌词:', linesWithSpaces[0]?.text)
        logger.trace('LyricView', '空格数量:', (linesWithSpaces[0]?.text.match(/ /g) || []).length)
      }
      
      logger.trace('LyricView', '歌词解析完成，共', this.parsedLyrics.length, '行')
      logger.trace('LyricView', '前3行歌词:', this.parsedLyrics.slice(0, 3))

      // 处理翻译映射
      if (this.hasTranslation && this.translationData) {
        this.mapTranslationToLyrics()
      }
    },

    // 将翻译数据映射到歌词行
    mapTranslationToLyrics() {
      try {
        const { translation } = this.translationData
        if (!translation || !Array.isArray(translation)) {
          logger.trace('LyricView', '翻译数据格式不正确')
          return
        }

        logger.trace('LyricView', '开始映射翻译到歌词行，翻译行数:', translation.length, '歌词行数:', this.parsedLyrics.length)

        // 为每行歌词添加翻译
        this.parsedLyrics.forEach((lyricLine, index) => {
          if (index < translation.length && translation[index] && translation[index][0]) {
            lyricLine.translation = translation[index][0].trim()
            logger.trace('LyricView', `第${index}行添加翻译:`, lyricLine.text, '->', lyricLine.translation)
          }
        })

        logger.trace('LyricView', '翻译映射完成')
        
        // 输出前五句歌词的翻译用于调试
        logger.trace('LyricView', '=== 前五句歌词翻译预览 ===')
        this.parsedLyrics.slice(0, 5).forEach((line, index) => {
          logger.trace('LyricView', `第${index + 1}句:`)
          logger.trace('LyricView', `  原文: ${line.text}`)
          logger.trace('LyricView', `  翻译: ${line.translation || '(无翻译)'}`)
          logger.trace('LyricView', `  时间: ${line.time.toFixed(2)}s`)
          logger.trace('LyricView', '---')
        })
        logger.trace('LyricView', '=========================')
        
        // 检查当前翻译显示状态
        logger.trace('LyricView', '🔍 当前翻译显示状态:')
        logger.trace('LyricView', '  - hasTranslation:', this.hasTranslation)
        logger.trace('LyricView', '  - showTranslation:', this.showTranslation)
        logger.trace('LyricView', '  - 有翻译的歌词行数:', this.parsedLyrics.filter(line => line.translation).length)
        
      } catch (error) {
        logger.error('LyricView', '翻译映射失败:', error)
      }
    },

    // 解析KRC格式的逐字时间信息
    parseKrcWords(text) {
      const words = []
      logger.trace('LyricView', '解析逐字信息:', text)
      
      // KRC格式：<startTime,duration>word<startTime,duration>word...
      // 注意：时间是相对于行开始的毫秒数
      const krcPattern = /<(\d+),(\d+),(\d+)>([^<]*)/g
      let match
      
      while ((match = krcPattern.exec(text)) !== null) {
        const startTime = parseInt(match[1]) / 1000 // 毫秒转秒，相对于行开始
        const duration = parseInt(match[2]) / 1000  // 毫秒转秒
        const word = match[4] // 注意这里是match[4]，因为有3个数字参数
        
        logger.trace('LyricView', '找到字符:', { word, startTime, duration })
        
        if (word) {
          words.push({
            word: word,
            startTime: startTime,
            endTime: startTime + duration
          })
        }
      }
      
      // 如果没有找到3参数格式，尝试2参数格式
      if (words.length === 0) {
        const krcPattern2 = /<(\d+),(\d+)>([^<]*)/g
        while ((match = krcPattern2.exec(text)) !== null) {
          const startTime = parseInt(match[1]) / 1000 // 毫秒转秒
          const duration = parseInt(match[2]) / 1000  // 毫秒转秒
          const word = match[3]
          
          logger.trace('LyricView', '找到字符(2参数):', { word, startTime, duration })
          
          if (word) {
            words.push({
              word: word,
              startTime: startTime,
              endTime: startTime + duration
            })
          }
        }
      }
      
      // 如果还是没有找到KRC格式，则按字符平分时间
      if (words.length === 0 && text) {
        // 移除所有<>标签，获取纯文本
        const cleanText = text.replace(/<[^>]*>/g, '')
        if (cleanText) {
          const chars = cleanText.split('')
          const charDuration = 3 / chars.length // 假设每行3秒
          
          chars.forEach((char, index) => {
            words.push({
              word: char,
              startTime: index * charDuration,
              endTime: (index + 1) * charDuration
            })
          })
          logger.trace('LyricView', '使用平分时间，字符数:', chars.length)
        }
      }
      
      logger.trace('LyricView', '解析完成，共', words.length, '个字符')
      return words
    },

    // 判断字符是否应该高亮（基于KRC逐字时间）
    isWordHighlighted(word, lineStartTime) {
      // 计算字符的绝对时间
      const wordAbsoluteStartTime = lineStartTime + word.startTime
      const wordAbsoluteEndTime = lineStartTime + word.endTime
      
      // 判断当前播放时间是否在字符时间范围内
      return this.currentPlayTime >= wordAbsoluteStartTime && this.currentPlayTime <= wordAbsoluteEndTime
    },

    // 获取卡拉OK样式（逐字填充效果） - 高性能缓存版本
    getKaraokeStyle(word, lineStartTime, lineIndex) {
      // 生成唯一缓存key
      const cacheKey = `${lineIndex}-${word.startTime}-${word.endTime}`
      
      const wordAbsoluteStartTime = lineStartTime + word.startTime
      const wordAbsoluteEndTime = lineStartTime + word.endTime
      
      // 当前行
      if (lineIndex === this.currentLyricIndex) {
        if (this.currentPlayTime < wordAbsoluteStartTime) {
          // 还没开始唱
          return { color: 'var(--lyric-pending)' }
        } else if (this.currentPlayTime >= wordAbsoluteEndTime) {
          // 已唱完，但还在当前行，保持高亮
          return {
            color: 'var(--lyric-accent)',
            textShadow: '0 0 8px color-mix(in srgb, var(--lyric-accent) 50%, transparent)'
          }
        } else {
          // 正在唱，填充效果（降低精度到5%提升性能）
          const progress = (this.currentPlayTime - wordAbsoluteStartTime) / (wordAbsoluteEndTime - wordAbsoluteStartTime)
          const fillPercentage = Math.floor(progress * 20) * 5 // 5%精度，平衡性能和流畅度
          
          // 检查缓存
          const lastProgress = this.lastProgressValues.get(cacheKey)
          if (lastProgress === fillPercentage && this.styleCache.has(cacheKey)) {
            return this.styleCache.get(cacheKey)
          }
          
          const style = {
            background: `linear-gradient(90deg, var(--lyric-accent) 0%, var(--lyric-accent) ${fillPercentage}%, var(--lyric-pending) ${fillPercentage}%, var(--lyric-pending) 100%)`,
            WebkitBackgroundClip: 'text',
            backgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            textShadow: '0 0 6px color-mix(in srgb, var(--lyric-accent) 30%, transparent)'
          }
          
          // 更新缓存
          this.styleCache.set(cacheKey, style)
          this.lastProgressValues.set(cacheKey, fillPercentage)
          return style
        }
      }
      // 非当前行，全部恢复白色
      else {
        return { color: 'var(--lyric-line)' }
      }
    },

    // 获取普通字符的卡拉OK样式（当没有逐字信息时） - 高性能版本
    getCharKaraokeStyle(charIndex, line, lineIndex) {
      // 只有当前行才有特殊效果
      if (lineIndex !== this.currentLyricIndex) {
        return { color: 'var(--lyric-line)' }
      }

      // 当前行的字符效果
      if (charIndex < this.currentCharIndex) {
        // 已唱完的字符，保持高亮
        return {
          color: 'var(--lyric-accent)',
          textShadow: '0 0 6px color-mix(in srgb, var(--lyric-accent) 40%, transparent)'
        }
      } else if (charIndex === this.currentCharIndex) {
        // 正在唱的字符，填充效果（优化缓存）
        const cacheKey = `char-${lineIndex}-${charIndex}`
        const progress = this.getCharProgress(line)
        const fillPercentage = Math.floor(progress * 10) * 10 // 10%精度，减少计算频率
        
        // 检查缓存
        const lastProgress = this.lastProgressValues.get(cacheKey)
        if (lastProgress === fillPercentage && this.styleCache.has(cacheKey)) {
          return this.styleCache.get(cacheKey)
        }
        
        const style = {
          background: `linear-gradient(90deg, var(--lyric-accent) 0%, var(--lyric-accent) ${fillPercentage}%, var(--lyric-pending) ${fillPercentage}%, var(--lyric-pending) 100%)`,
          WebkitBackgroundClip: 'text',
          backgroundClip: 'text',
          WebkitTextFillColor: 'transparent'
        }
        
        // 更新缓存
        this.styleCache.set(cacheKey, style)
        this.lastProgressValues.set(cacheKey, fillPercentage)
        return style
      } else {
        // 还没开始唱的字符
        return { color: 'var(--lyric-pending)' }
      }
    },

    // 获取字符进度（用于没有逐字信息的情况）
    getCharProgress(line) {
      if (this.currentLyricIndex >= this.parsedLyrics.length - 1) {
        return 0
      }
      
      const currentLine = this.parsedLyrics[this.currentLyricIndex]
      const nextLine = this.parsedLyrics[this.currentLyricIndex + 1]
      const lineProgress = (this.currentPlayTime - currentLine.time) / (nextLine.time - currentLine.time)
      const charProgress = (lineProgress * currentLine.text.length) - this.currentCharIndex
      
      return Math.max(0, Math.min(1, charProgress))
    },

    /** 只更新当前行的逐字状态；颜色使用 CSS 变量，切换主题无需重读样式或重置播放。 */
    updateKaraokeStylesDirectly() {
      if (!this.parsedLyrics.length) return
      
      const container = this.$refs.lyricsContainer
      if (!container) return

      // 使用内部时间而不是 prop（避免 Vue 响应式）
      const currentTime = this.internalPlayTime

      // 找到当前歌词行（考虑桥段的影响）
      let newIndex = 0
      for (let i = 0; i < this.parsedLyrics.length; i++) {
        if (currentTime >= this.parsedLyrics[i].time) {
          newIndex = i
        } else {
          break
        }
      }
      
      // 如果正在桥段中，保持在上一句不动，直到桥段结束
      if (this.isBridgeActive && this.bridgeInfo) {
        // 保持在桥段起始行（上一句）
        if (this.bridgeInfo.startLyricIndex === -1) {
          // 开头桥段，还没有第一句，保持在第一句之前
          newIndex = 0
        } else {
          // 句间桥段，保持在上一句
          newIndex = this.bridgeInfo.startLyricIndex
        }
      }

      const lineChanged = newIndex !== this.currentLyricIndex

      // 如果行改变，清理旧行样式并恢复位置
      if (lineChanged && this.currentLyricIndex >= 0) {
        const oldLineChars = container.querySelectorAll(`[data-line-index="${this.currentLyricIndex}"]`)
        oldLineChars.forEach(char => {
          char.style.color = 'var(--lyric-line)'
          char.style.fontWeight = '500'
          char.style.textShadow = ''
          char.style.transform = '' // 恢复位置
          char.style.transition = 'all 0.3s ease-out' // 平滑恢复
        })
      }

      // 更新索引
      if (lineChanged) {
        this.currentLyricIndex = newIndex
        this.scrollToCurrentLyric()
        this.handleLongLyric() // 处理长歌词滚动
      }

      // 只更新当前行的字符（关键优化！）
      const currentLineChars = container.querySelectorAll(`[data-line-index="${this.currentLyricIndex}"]`)
      
      // 如果正在桥段中，不更新字符样式（保持恢复后的状态）
      if (this.isBridgeActive) {
        return
      }
      
      currentLineChars.forEach(char => {
        // 跳过空格字符的样式更新
        if (char.classList.contains('is-space')) {
          return
        }
        
        if (char.dataset.start !== undefined) {
          // KRC模式 - 逐字时间
          const lineStart = parseFloat(char.dataset.lineStart)
          const wordStart = lineStart + parseFloat(char.dataset.start)
          const wordEnd = lineStart + parseFloat(char.dataset.end)
          
          if (currentTime < wordStart) {
            // 未开始
            char.style.color = 'var(--lyric-pending)'
            char.style.fontWeight = '500'
            char.style.textShadow = ''
            char.style.transform = ''
            char.style.transition = 'transform 0.15s ease-out'
          } else if (currentTime >= wordEnd) {
            // 已完成 - 保持高亮和悬浮
            char.style.color = 'var(--lyric-accent)'
            char.style.fontWeight = '600'
            char.style.textShadow = '0 0 12px color-mix(in srgb, var(--lyric-accent) 60%, transparent), var(--shadow-slider)'
            char.style.transform = 'translateY(-3px)'
            char.style.transition = 'transform 0.15s ease-out'
          } else {
            // 进行中 - 使用双色文字而非渐变（保持字体粗细）
            const progress = (currentTime - wordStart) / (wordEnd - wordStart)
            const fillPercentage = Math.floor(progress * 20) * 5
            
            // 使用 text-shadow 叠加实现渐变效果，保持字体清晰
            const highlightIntensity = progress
            char.style.color = `color-mix(in srgb, var(--lyric-accent) ${highlightIntensity * 100}%, var(--lyric-text))`
            char.style.fontWeight = '600'
            char.style.textShadow = `0 0 ${8 * progress}px color-mix(in srgb, var(--lyric-accent) ${50 * progress}%, transparent)`
            char.style.transform = 'translateY(-3px)'
            char.style.transition = 'transform 0.15s ease-out'
          }
        } else {
          // LRC模式 - 按字符索引
          const charIndex = parseInt(char.dataset.charIndex)
          const currentLine = this.parsedLyrics[this.currentLyricIndex]
          
          const nextTime = this.parsedLyrics[this.currentLyricIndex + 1]?.time ?? this.duration
          if (nextTime > currentLine.time) {
            const lineProgress = Math.max(0, Math.min(1, (currentTime - currentLine.time) / (nextTime - currentLine.time)))
            const currentCharIndex = Math.floor(lineProgress * currentLine.text.length)
            
            if (charIndex < currentCharIndex) {
              // 已完成 - 保持高亮和悬浮
              char.style.color = 'var(--lyric-accent)'
              char.style.fontWeight = '600'
              char.style.textShadow = '0 0 12px color-mix(in srgb, var(--lyric-accent) 60%, transparent), var(--shadow-slider)'
              char.style.transform = 'translateY(-5px)'
              char.style.transition = 'transform 0.15s ease-out'
            } else if (charIndex === currentCharIndex) {
              // 进行中
              const charProgress = (lineProgress * currentLine.text.length) - currentCharIndex
              const highlightIntensity = charProgress
              char.style.color = `color-mix(in srgb, var(--lyric-accent) ${highlightIntensity * 100}%, var(--lyric-text))`
              char.style.fontWeight = '600'
              char.style.textShadow = `0 0 ${10 * charProgress}px color-mix(in srgb, var(--lyric-accent) ${50 * charProgress}%, transparent)`
              char.style.transform = 'translateY(-5px)'
              char.style.transition = 'transform 0.15s ease-out'
            } else {
              // 未开始
              char.style.color = 'var(--lyric-pending)'
              char.style.fontWeight = '500'
              char.style.textShadow = ''
              char.style.transform = ''
              char.style.transition = 'transform 0.15s ease-out'
            }
          }
        }
      })
    },

    // 优化的歌词位置更新方法
    updateLyricPositionOptimized() {
      if (!this.parsedLyrics.length) return

      // 找到当前应该显示的歌词行
      let newIndex = 0
      for (let i = 0; i < this.parsedLyrics.length; i++) {
        if (this.currentPlayTime >= this.parsedLyrics[i].time) {
          newIndex = i
        } else {
          break
        }
      }

      if (newIndex !== this.currentLyricIndex) {
        this.currentLyricIndex = newIndex
        this.scrollToCurrentLyric()
        this.currentCharIndex = 0
        // 清除缓存，新的行需要重新计算
        this.styleCache.clear()
        this.lastProgressValues.clear()
      }

      // 计算当前字符高亮位置
      if (this.currentLyricIndex < this.parsedLyrics.length - 1) {
        const currentLine = this.parsedLyrics[this.currentLyricIndex]
        const nextLine = this.parsedLyrics[this.currentLyricIndex + 1]
        const lineProgress = (this.currentPlayTime - currentLine.time) / (nextLine.time - currentLine.time)
        this.currentCharIndex = Math.floor(lineProgress * currentLine.text.length)
      }
    },

    // 兼容旧方法
    updateLyricPosition() {
      this.updateLyricPositionOptimized()
    },

    // 滚动到当前歌词 - 在绝对定位布局中，这个方法主要用于触发其他效果
    scrollToCurrentLyric() {
      // 在绝对定位的歌词布局中，"滚动"实际上是通过transform实现的
      // 这个方法保持为空，因为位置控制已经在 getLyricLineStyle 中处理
      // 但保留这个方法调用，以便将来可能需要的其他滚动相关效果
      if (process.env.NODE_ENV === 'development') {
        logger.debug('LyricView', '触发歌词"滚动"效果，当前歌词索引:', this.currentLyricIndex)
      }
    },

    /** 横向位移只作用于内层文本，按当前播放位置计算，暂停和跳转保持同步。 */
    syncLongLyric() {
      const lineElement = this.lyricLineRefs[this.currentLyricIndex]
      const text = lineElement?.querySelector('.lyric-text')
      if (this.scrollingLyricElement && this.scrollingLyricElement !== text) {
        this.scrollingLyricElement.style.transform = ''
      }
      this.scrollingLyricElement = text || null
      const viewport = lineElement?.querySelector('.main-lyric')
      const line = this.parsedLyrics[this.currentLyricIndex]
      if (!text || !viewport || !line) return
      const overflow = Math.max(0, text.scrollWidth - viewport.clientWidth)
      const nextTime = this.parsedLyrics[this.currentLyricIndex + 1]?.time ?? this.duration
      const lastWord = line.words?.[line.words.length - 1]
      const endTime = lastWord?.endTime > 0 ? Math.min(nextTime, line.time + lastWord.endTime) : nextTime
      const lineDuration = endTime - line.time
      const progress = lineDuration > 0 ? Math.max(0, Math.min(1, (this.internalPlayTime - line.time) / lineDuration)) : 0
      text.style.transform = 'translateX(' + (-overflow * progress) + 'px)'
    },
    handleLongLyric() {
      this.$nextTick(() => {
        if (!this.isDisposed && this.visible) this.syncLongLyric()
      })
    },

    // 关闭歌词视图
    closeLyricView() {
      this.$emit('close')
    },

    // 播放控制方法
    togglePlayPause() {
      this.$emit('toggle-play')
    },

    playPrevious() {
      this.$emit('previous')
    },

    playNext() {
      this.$emit('next')
    },

    togglePlayMode() {
      this.$emit('toggle-play-mode')
    },

    toggleFavorite() {
      this.$emit('toggle-favorite')
    },

    // 只提交翻译开关字段，异步持久化失败保留异常上下文。
    async toggleTranslation() {
      if (!this.hasTranslation || this.isDisposed) return
      this.showTranslation = !this.showTranslation
      this.handleLongLyric()
      try {
        await this.settingsStore?.updateSettings?.({ playback: { showTranslation: this.showTranslation } })
      } catch (error) {
        logger.warn('LyricView', '更新翻译设置失败', error)
      }
    },

    /** 每次拖动立即预览歌词位置与逐字状态，音频只在确认后跳转一次。 */
    previewSeek(event) {
      const time = Number(event.target.value)
      if (!Number.isFinite(time) || !Number.isFinite(this.duration) || this.duration <= 0 || this.isDisposed || this.pauseUpdates) return
      this.seekPreviewTime = Math.max(0, Math.min(this.duration, time))
      this.syncDisplayedTime(true)
    },
    commitSeek() {
      const time = this.seekPreviewTime
      this.seekPreviewTime = null
      if (time != null) this.seekTo(time)
    },
    cancelSeek() {
      const hadPreview = this.seekPreviewTime != null
      this.seekPreviewTime = null
      if (hadPreview && !this.isDisposed) this.syncDisplayedTime(true)
    },
    handleProgressEscape() {
      if (this.seekPreviewTime != null) this.cancelSeek()
      else this.closeLyricView()
    },
    seekTo(time) {
      if (this.isDisposed || this.pauseUpdates || !Number.isFinite(time) || !Number.isFinite(this.duration) || this.duration <= 0) return
      const target = Math.max(0, Math.min(this.duration, time))
      this.$emit('seek', target)
      this.syncPlaybackTime(target, true)
    },

    onWindowResize() {
      if (this.isDisposed) return
      this.viewportWidth = window.innerWidth
      this.viewportHeight = window.innerHeight
      this.styleCache.clear()
      this.lastProgressValues.clear()
      this.handleLongLyric()
    },

    // 防抖函数
    debounce(func, wait) {
      let timeout
      const executedFunction = function (...args) {
        const later = () => {
          clearTimeout(timeout)
          func.apply(this, args)
        }
        clearTimeout(timeout)
        timeout = setTimeout(later, wait)
      }
      executedFunction.cancel = () => {
        clearTimeout(timeout)
        timeout = null
      }
      return executedFunction
    }
  }
}
