
import { logger } from '../../utils/logger.js'
import { useSettingsStore } from '../../stores/settingsStore.js'
import { readLyricRomanization } from '../../utils/lyricProcessing.js'
import { parseDesktopLyrics } from '../../utils/desktopLyrics.js'
import ContextMenu from '../common/ContextMenu.vue'
import ArtistLinks from '../common/ArtistLinks.vue'
import ArtworkCover from '../common/ArtworkCover.vue'
import VolumeControl from './VolumeControl.vue'
import contextMenuManager from '../../utils/contextMenuManager.js'
import repeatAllIcon from '../../assets/icons/repeat_all.svg'
import repeatOneIcon from '../../assets/icons/repeat_one.svg'
import shuffleIcon from '../../assets/icons/shuffle.svg'

// DOM 与帧缓存不进入 Vue 响应式依赖，避免桥段每帧重建整首歌词的虚拟节点。
const bridgeAnimationFrames = new WeakMap()
const lyricAnimationFrames = new WeakMap()
const lyricCharacters = new WeakMap()
const lyricSegmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null

export default {
  name: 'LyricView',
  components: { ContextMenu, ArtistLinks, ArtworkCover, VolumeControl },
  props: {
    volume: { type: Number, default: 80 },
    isMuted: { type: Boolean, default: false },
    visible: {
      type: Boolean,
      default: false
    },
    song: {
      type: Object,
      default: null
    },
    trackTransition: {
      type: String,
      default: 'select'
    },
    lyrics: {
      type: String,
      default: ''
    },
    lyricData: {
      type: Object,
      default: null
    },
    lyricsInteractive: {
      type: Boolean,
      default: false
    },
    currentPlayTime: {
      type: Number,
      default: 0
    },
    readPlaybackTime: {
      type: Function,
      default: null
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
    },
    qualityOptions: {
      type: Array,
      default: () => []
    },
    qualityPreference: {
      type: String,
      default: '128'
    },
    qualityStatus: {
      type: String,
      default: ''
    },
    qualityMessage: {
      type: String,
      default: ''
    },
    qualitySwitching: {
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
      qualityMenuOpen: false,
      qualityMenuPosition: { x: 0, y: 0 },
      translationMessage: '',
      translationSaveVersion: 0,
      translationPreferenceDraft: null,
      hasTimedLyrics: false,
      browsePosition: null,
      browseBridgeAnchor: null,
      browseReturnTimer: null,
      lyricPointer: null,
      suppressLyricClick: false,
      lyricMenuVisible: false,
      lyricMenuPosition: { x: 0, y: 0 },
      lyricMenuSnapshot: null,
      copyFeedback: '',
      copyRequestId: 0,
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
      // 桥段动效与播放时间共用同一进度源
      bridgeInfo: null, // { startTime, duration, startLyricIndex } - 当前桥段信息
      isBridgeActive: false, // 是否正在显示桥段
      bridgeProgress: 0, // 桥段进度 0-100
      // 翻译相关
      hasTranslation: false, // 是否有翻译
      translationData: null, // 翻译数据
      showTranslation: false, // 是否显示翻译（会根据设置和检测结果动态设置）
      isNonChinese: false // 是否为非中文歌曲
    }
  },
  computed: {
    selectedQuality() {
      return this.qualityOptions.find(option => option.value === this.qualityPreference) ||
        { label: '标准 128 kbps', shortLabel: '128K' }
    },
    canBrowseLyrics() {
      return this.lyricsInteractive && this.hasTimedLyrics && this.visible && !this.pauseUpdates && !this.isDisposed &&
        this.seekPreviewTime == null && this.previewTime == null
    },
    lyricMenuItems() {
      const snapshot = this.lyricMenuSnapshot
      if (!snapshot) return []
      const items = [
        { label: '复制本句', action: () => this.copyLyricText(snapshot.line) },
        { label: '复制全部歌词', action: () => this.copyLyricText(snapshot.all) }
      ]
      if (snapshot.translation) {
        items.push({ label: '复制本句及翻译', action: () => this.copyLyricText(snapshot.line + '\n' + snapshot.translation) })
      }
      return items
    },
    bridgeIndicatorStyle() {
      let offset = 0
      if (this.browsePosition != null && this.bridgeInfo) {
        const anchor = this.bridgeInfo.startLyricIndex
        const position = anchor === this.browseBridgeAnchor ? anchor + 1
          : anchor < 0 ? 0 : this.getBrowseLinePosition(anchor) + 0.5
        offset = (position - this.browsePosition) * this.lyricLineHeight
      }
      return {
        transform: `translate(-50%, -50%) translateY(${offset}px)`,
        '--bridge-height': `${Math.min(44, this.lyricLineHeight * 0.72)}px`,
        '--bridge-scale': Math.min(1, this.lyricLineHeight * 0.72 / 44)
      }
    },
    /** 只用歌词时间编排展开、呼吸和收拢，暂停与进度预览不会产生独立时钟漂移。 */
    bridgeMotion() {
      return this.getBridgeMotion(this.internalPlayTime)
    },
    bridgeRemainingSeconds() {
      return Math.ceil(this.bridgeMotion.remaining)
    },
    /** 三组光点展开为流动波形，结束前回收到三个核心；不模拟真实音频频谱。 */
    bridgeParticles() {
      return this.getBridgeParticles(this.bridgeMotion)
    },
    trackTransitionName() {
      const type = ['previous', 'next', 'auto', 'select', 'shuffle'].includes(this.trackTransition)
        ? this.trackTransition : 'select'
      return `track-${type}`
    },
    lyricContentKey() {
      return `${this.song?.hash || 'empty'}:${this.lyrics ? 'ready' : 'loading'}`
    },
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
      if (this.romanizationLines.size) height += 26
      if (this.viewportWidth < 900 || this.viewportHeight < 600) height *= 0.7
      return height
    },
    romanizationLines() {
      if (this.settingsStore?.settings?.playback?.romanization !== 'on') return new Map()
      return new Map(readLyricRomanization(this.lyrics, this.lyricData).map(line => [line.time / 1000, line.text]))
    },
    // 检测所有桥段（句子间隔>20秒）
    bridges() {
      const bridges = []
      const BRIDGE_THRESHOLD = 20 // 20秒阈值，避免误检测短间隔
      const LYRIC_FINISH_OFFSET = 3 // 假设每句歌词在下一句前3秒唱完
      
      if (!this.parsedLyrics || this.parsedLyrics.length === 0) return bridges
      
      // 检查开头是否是桥段（第一句之前>20秒）
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
    parsedLyrics() {
      // 同一首歌的 ready 层可能复用 DOM；等 Vue 补齐新字节点后再缓存。
      this.$nextTick(() => {
        if (this.isDisposed) return
        this.clearLyricAnimationFrame()
        if (this.visible && !this.pauseUpdates) this.syncDisplayedTime()
      })
    },
    'settingsStore.settings.playback.showTranslation'(value) {
      if (this.translationPreferenceDraft != null) return
      this.showTranslation = value ?? true
      this.styleCache.clear()
      this.handleLongLyric()
    },
    visible(newVal) {
      if (newVal) {
        this.startUpdateLoop() // 启动RAF循环
        this.lockBodyScroll()
      } else {
        this.closeQualityMenu()
        this.resetLyricInteractions()
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
      this.closeQualityMenu()
      this.coverFailed = false
      this.resetLyricInteractions()
      this.cancelSeek()
      this.lastPlaybackTime = null
    },
    lyricContentKey() {
      this.resetTrackLyrics()
    },
    currentPlayTime() {
      if (this.visible && !this.pauseUpdates && !this.isDisposed) this.syncDisplayedTime()
    },
    previewTime() {
      if (this.previewTime != null) this.resetLyricInteractions()
      if (this.visible && !this.pauseUpdates && !this.isDisposed) this.syncDisplayedTime(true)
    },
    lyricsInteractive(value) {
      if (!value) this.resetLyricInteractions()
    },
    pauseUpdates(newVal) {
      if (newVal) {
        this.resetLyricInteractions()
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
    this.closeQualityMenu()
    this.resetLyricInteractions()
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
    window.removeEventListener('blur', this.cancelLyricInteractions)
    window.removeEventListener('keydown', this.handleInteractionKeydown)
    window.removeEventListener('pointerdown', this.dismissQualityMenu)
    
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
    window.addEventListener('blur', this.cancelLyricInteractions)
    window.addEventListener('keydown', this.handleInteractionKeydown)
    window.addEventListener('pointerdown', this.dismissQualityMenu)
    
    // 初始化窗口尺寸适配
    this.onWindowResize()
  },
  methods: {
    /** 菜单只修改音质偏好；勾选项与当前有效音源状态独立呈现。 */
    openQualityMenu() {
      if (this.isDisposed) return
      contextMenuManager.registerMenu(this.closeQualityMenu)
      this.qualityMenuPosition = { x: 0, y: 0 }
      this.qualityMenuOpen = true
      this.$nextTick(() => {
        if (this.qualityMenuOpen && !this.isDisposed) {
          this.positionQualityMenu()
          this.$refs.qualityControl?.querySelector('[aria-checked="true"]')?.focus()
        }
      })
    },
    toggleQualityMenu() {
      if (this.qualityMenuOpen) this.closeQualityMenu()
      else this.openQualityMenu()
    },
    closeQualityMenu(restoreFocus = false) {
      this.qualityMenuOpen = false
      contextMenuManager.unregisterMenu(this.closeQualityMenu)
      if (restoreFocus) this.$refs.qualityTrigger?.focus({ preventScroll: true })
    },
    /** 展开方向由布局决定，再夹紧实际边界，兼容窄矮窗口和多行歌曲信息。 */
    positionQualityMenu() {
      const bounds = this.$refs.qualityMenu?.getBoundingClientRect?.()
      if (!bounds) return
      this.qualityMenuPosition = {
        x: Math.max(12 - bounds.left, Math.min(0, window.innerWidth - 12 - bounds.right)),
        y: Math.max(12 - bounds.top, Math.min(0, window.innerHeight - 12 - bounds.bottom))
      }
    },
    dismissQualityMenu(event) {
      if (this.qualityMenuOpen && !this.$refs.qualityControl?.contains(event.target)) this.closeQualityMenu()
    },
    handleQualityFocusout(event) {
      if (!this.$refs.qualityControl?.contains(event.relatedTarget)) this.closeQualityMenu()
    },
    handleQualityMenuKeydown(event) {
      if (event.key === 'Escape') {
        event.preventDefault()
        this.closeQualityMenu(true)
        return
      }
      const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End']
      if (!keys.includes(event.key)) return
      event.preventDefault()
      const options = [...(this.$refs.qualityControl?.querySelectorAll('[role="menuitemradio"]') || [])]
      const index = options.indexOf(event.target)
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length
      options[next]?.focus()
    },
    selectQuality(value) {
      this.closeQualityMenu(true)
      this.$emit('change-quality', value)
    },
    /** 手动浏览冻结布局锚点，播放索引和逐字高亮继续按真实时间推进。 */
    getBrowseLinePosition(index) {
      return index + (this.browseBridgeAnchor != null && index > this.browseBridgeAnchor ? 1 : 0)
    },
    getLyricRelativePosition(index) {
      if (this.browsePosition != null) return this.getBrowseLinePosition(index) - this.browsePosition
      if (this.isBridgeActive && this.bridgeInfo) {
        const anchor = this.bridgeInfo.startLyricIndex
        return index - anchor - (index <= anchor ? 1 : 0)
      }
      return index - this.currentLyricIndex
    },
    isCurrentLyricEvent(event, key = this.lyricContentKey) {
      return key === this.lyricContentKey && !event?.target?.closest?.('[inert]')
    },
    isLyricLineInteractive(index) {
      const line = this.parsedLyrics[index]
      return this.canBrowseLyrics && !!line && Number.isFinite(line.time) && line.time >= 0 &&
        typeof line.text === 'string' && line.text.trim().length > 0
    },
    beginLyricBrowsing() {
      if (this.browsePosition != null) return
      this.browseBridgeAnchor = this.isBridgeActive ? this.bridgeInfo?.startLyricIndex ?? null : null
      this.browsePosition = this.browseBridgeAnchor != null ? this.browseBridgeAnchor + 1 : this.currentLyricIndex
    },
    setBrowsePosition(position) {
      const last = this.getBrowseLinePosition(this.parsedLyrics.length - 1)
      this.browsePosition = Math.max(0, Math.min(last, position))
    },
    pauseBrowseReturn() {
      if (this.browseReturnTimer != null) clearTimeout(this.browseReturnTimer)
      this.browseReturnTimer = null
    },
    scheduleBrowseReturn() {
      this.pauseBrowseReturn()
      if (this.browsePosition == null || this.lyricPointer || this.lyricMenuVisible || !this.canBrowseLyrics) return
      this.browseReturnTimer = setTimeout(() => {
        this.browseReturnTimer = null
        this.returnToCurrentLyric()
      }, 5000)
    },
    /** 只在超过 6px 后捕获指针，普通单击仍由实际歌词行接收。 */
    startLyricPointer(event, key) {
      if (!this.canBrowseLyrics || !this.isCurrentLyricEvent(event, key) ||
          event.button !== 0 || event.isPrimary === false || this.lyricPointer) return
      this.closeLyricMenu()
      this.pauseBrowseReturn()
      this.suppressLyricClick = false
      this.lyricPointer = {
        id: event.pointerId, x: event.clientX, y: event.clientY,
        host: event.currentTarget, dragging: false, position: null, lineHeight: this.lyricLineHeight
      }
      window.addEventListener('pointermove', this.moveLyricPointer, { passive: false })
      window.addEventListener('pointerup', this.endLyricPointer)
      window.addEventListener('pointercancel', this.cancelLyricPointer)
    },
    moveLyricPointer(event) {
      const pointer = this.lyricPointer
      if (!pointer || pointer.id !== event.pointerId) return
      if (!this.canBrowseLyrics) {
        this.cancelLyricInteractions()
        return
      }
      if (!pointer.dragging) {
        if (Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) <= 6) return
        this.beginLyricBrowsing()
        pointer.position = this.browsePosition
        pointer.dragging = true
        this.suppressLyricClick = true
        pointer.host?.setPointerCapture?.(pointer.id)
      }
      event.preventDefault()
      this.setBrowsePosition(pointer.position - (event.clientY - pointer.y) / pointer.lineHeight)
    },
    releaseLyricPointer() {
      const pointer = this.lyricPointer
      this.lyricPointer = null
      window.removeEventListener('pointermove', this.moveLyricPointer)
      window.removeEventListener('pointerup', this.endLyricPointer)
      window.removeEventListener('pointercancel', this.cancelLyricPointer)
      if (pointer?.host?.hasPointerCapture?.(pointer.id)) pointer.host.releasePointerCapture(pointer.id)
    },
    endLyricPointer(event) {
      if (!this.lyricPointer || this.lyricPointer.id !== event.pointerId) return
      this.releaseLyricPointer()
      this.scheduleBrowseReturn()
    },
    cancelLyricPointer(event) {
      if (!this.lyricPointer || (event && this.lyricPointer.id !== event.pointerId)) return
      this.returnToCurrentLyric()
      this.suppressLyricClick = true
    },
    handleLyricWheel(event, key) {
      if (!this.canBrowseLyrics || !this.isCurrentLyricEvent(event, key) || this.lyricPointer || event.ctrlKey) return
      if (!Number.isFinite(event.deltaY) || event.deltaY === 0) return
      event.preventDefault()
      this.closeLyricMenu()
      this.beginLyricBrowsing()
      const unit = event.deltaMode === 1 ? this.lyricLineHeight
        : event.deltaMode === 2 ? this.$refs.lyricsContainer?.clientHeight || this.viewportHeight : 1
      this.setBrowsePosition(this.browsePosition + event.deltaY * unit / this.lyricLineHeight)
      this.lineTransitionDuration = 0.12
      this.scheduleBrowseReturn()
    },
    returnToCurrentLyric() {
      const restoreLyricFocus = this.$refs.lyricsContainer?.contains?.(document.activeElement)
      this.returnToCurrentLyricWithoutSync()
      if (!this.isDisposed) {
        this.syncDisplayedTime(true)
        if (restoreLyricFocus) this.$nextTick(() => {
          if (!this.isDisposed && this.browsePosition == null) this.lyricLineRefs[this.currentLyricIndex]?.focus({ preventScroll: true })
        })
      }
    },
    /** 切歌、关闭、暂停更新或卸载使拖动、菜单和迟到的复制反馈一并失效。 */
    resetLyricInteractions() {
      this.returnToCurrentLyricWithoutSync()
      this.suppressLyricClick = false
      this.copyRequestId += 1
      this.copyFeedback = ''
    },
    returnToCurrentLyricWithoutSync() {
      this.lyricMenuVisible = false
      this.lyricMenuSnapshot = null
      contextMenuManager.unregisterMenu(this.closeLyricMenu)
      this.pauseBrowseReturn()
      this.releaseLyricPointer()
      this.browsePosition = null
      this.browseBridgeAnchor = null
    },
    cancelLyricInteractions() {
      this.closeQualityMenu()
      this.resetLyricInteractions()
      if (!this.isDisposed && this.visible && !this.pauseUpdates) this.syncDisplayedTime(true)
    },
    handleLyricEscape() {
      if (this.qualityMenuOpen) this.closeQualityMenu(true)
      else if (this.lyricMenuVisible) this.closeLyricMenu()
      else if (this.lyricPointer || this.browsePosition != null) this.cancelLyricInteractions()
      else this.closeLyricView()
    },
    handleInteractionKeydown(event) {
      if (event.key === 'Escape' && (this.lyricPointer || this.lyricMenuVisible)) {
        event.preventDefault()
        event.stopPropagation()
        this.handleLyricEscape()
      }
    },
    activateLyricLine(index, event, key) {
      if (!this.isLyricLineInteractive(index) || !this.isCurrentLyricEvent(event, key)) return
      if (this.suppressLyricClick && event?.type !== 'keydown') {
        this.suppressLyricClick = false
        event?.preventDefault?.()
        return
      }
      this.seekTo(this.parsedLyrics[index].time)
    },
    focusLyricLine(index, key) {
      if (this.lyricPointer || key !== this.lyricContentKey || !this.isLyricLineInteractive(index)) return
      if (index === this.currentLyricIndex && this.browsePosition == null) return
      this.beginLyricBrowsing()
      this.setBrowsePosition(this.getBrowseLinePosition(index))
      this.lineTransitionDuration = 0.24
      this.scheduleBrowseReturn()
    },
    /** 菜单保存纯文本快照，空格和翻译不经过逐字 DOM 或后续歌曲状态。 */
    showLyricMenu(event, index, key) {
      if (!this.isLyricLineInteractive(index) || !this.isCurrentLyricEvent(event, key)) return
      contextMenuManager.closeActiveMenu()
      this.releaseLyricPointer()
      this.beginLyricBrowsing()
      this.pauseBrowseReturn()
      const line = this.parsedLyrics[index]
      this.lyricMenuSnapshot = {
        line: line.text,
        all: this.parsedLyrics.map(item => item.text).join('\n'),
        translation: typeof line.translation === 'string' ? line.translation : ''
      }
      this.lyricMenuPosition = { x: event.clientX, y: event.clientY }
      this.lyricMenuVisible = true
      this.copyFeedback = ''
      contextMenuManager.registerMenu(this.closeLyricMenu)
    },
    closeLyricMenu() {
      this.lyricMenuVisible = false
      this.lyricMenuSnapshot = null
      contextMenuManager.unregisterMenu(this.closeLyricMenu)
      this.scheduleBrowseReturn()
    },
    async copyLyricText(text) {
      if (this.isDisposed || !this.visible || typeof text !== 'string' || !text) return
      const requestId = ++this.copyRequestId
      this.copyFeedback = '正在复制…'
      try {
        if (window.electronAPI?.writeClipboardText) await window.electronAPI.writeClipboardText(text)
        else if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text)
        else throw new Error('Clipboard unavailable')
        if (!this.isDisposed && requestId === this.copyRequestId) this.copyFeedback = '已复制歌词'
      } catch (error) {
        if (!this.isDisposed && requestId === this.copyRequestId) {
          this.copyFeedback = '复制失败，请重试'
          logger.warn('LyricView', '复制歌词失败', { errorType: error?.name || 'Error' })
        }
      }
    },
    searchSong(event) {
      if (!this.isDisposed && this.song && this.isCurrentLyricEvent(event)) this.$emit('search', this.song)
    },
    /** 旧层只保留退场画面，不再参与辅助阅读或交互。 */
    retireTrackLayer(element) {
      element.setAttribute('aria-hidden', 'true')
      element.inert = true
    },

    handleCoverError(event) {
      if (event.target.isConnected === false || event.target.closest?.('.track-cover')?.inert) return
      if (event.target.dataset.trackKey === this.song?.hash &&
          (event.target.getAttribute('data-artwork-original') || event.target.getAttribute('src')) === this.coverUrl) this.coverFailed = true
    },

    /** 按歌词代次持有行引用，旧层退场的 ref 清理不能删除新层引用。 */
    createLyricLineRef(index, key) {
      let previousElement
      return element => {
        if (this.isDisposed || key !== this.lyricContentKey) return
        if (element) {
          previousElement = element
          this.lyricLineRefs[index] = element
        } else if (this.lyricLineRefs[index] === previousElement) {
          delete this.lyricLineRefs[index]
        }
      }
    },

    /** 新歌及其异步歌词各自定位；不继承上一首的桥段、高亮或长句位移。 */
    resetTrackLyrics() {
      bridgeAnimationFrames.delete(this)
      this.clearLyricAnimationFrame()
      this.resetLyricInteractions()
      this.lyricLineRefs = {}
      this.scrollingLyricElement = null
      this.currentLyricIndex = 0
      this.currentCharIndex = 0
      this.lastPlaybackTime = null
      this.lineTransitionDuration = 0
      this.bridgeInfo = null
      this.isBridgeActive = false
      this.bridgeProgress = 0
      this.styleCache.clear()
      this.lastProgressValues.clear()
      this.$nextTick(() => {
        if (!this.isDisposed && this.visible && !this.pauseUpdates) this.syncDisplayedTime()
      })
    },

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
      if (this.browsePosition != null && (isSeek || delta < -0.25 || delta > 1)) this.resetLyricInteractions()
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
      this.updateBridgeAnimation()
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
      
      // 公共时间只负责布局状态；逐帧采样真实音频，只写当前行 DOM，不重建整首歌词。
      const displayedTime = this.seekPreviewTime ?? this.previewTime ?? this.currentPlayTime
      if (displayedTime !== this.lastPlaybackTime) this.syncDisplayedTime()
      const sampledTime = this.seekPreviewTime ?? this.previewTime ?? this.readPlaybackTime?.() ?? this.currentPlayTime
      const time = Number.isFinite(sampledTime) ? sampledTime : displayedTime
      this.updateKaraokeStylesDirectly(time)
      this.syncLongLyric(time)
      this.updateBridgeAnimation()
      
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
      bridgeAnimationFrames.delete(this)
      this.clearLyricAnimationFrame()
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
      if (bridge && !wasActive) this.resetKaraokeCharacters()
    },

    /** 从同一音频位置计算编舞；只读动画采样不写回整页响应式时间。 */
    getBridgeMotion(time) {
      if (!this.bridgeInfo) return { elapsed: 0, remaining: 0, unfold: 0, pulse: 0 }
      const { startTime, endTime, duration } = this.bridgeInfo
      const elapsed = Math.max(0, Math.min(duration, time - startTime))
      const remaining = Math.max(0, endTime - time)
      const smooth = value => {
        const clamped = Math.max(0, Math.min(1, value))
        return clamped * clamped * (3 - 2 * clamped)
      }
      const unfold = smooth(elapsed / Math.min(0.8, duration * 0.25)) *
        smooth(remaining / Math.min(2.4, duration * 0.3))
      return { elapsed, remaining, unfold, pulse: (Math.sin(elapsed * 2.4) + 1) / 2 }
    },

    /** 21 点共用确定的播放时间，保持展开、波形流动与收拢在跳转前后一致。 */
    getBridgeParticles({ elapsed, unfold }) {
      return Array.from({ length: 21 }, (_, index) => {
        const group = Math.floor(index / 7) - 1
        const isCore = index % 7 === 3
        const envelope = Math.sin((index + 1) / 22 * Math.PI)
        const wave = (Math.sin(elapsed * 3.2 - index * 0.55) + 1) / 2
        const drift = Math.sin(elapsed * 2.4 - group * 0.8)
        const x = group * 18 * (1 - unfold) + (index - 10) * 7 * unfold
        const y = drift * (1 - unfold) * 2
        const scale = 1 + unfold * envelope * (1 + wave * 3.5)
        const opacity = isCore ? 0.72 + wave * 0.28 : unfold * (0.3 + wave * 0.6)
        return {
          transform: `translate3d(${x.toFixed(3)}px, ${y.toFixed(3)}px, 0) scaleY(${scale.toFixed(3)})`,
          opacity: opacity.toFixed(3)
        }
      })
    },

    /** 复用歌词 RAF，仅更新桥段 DOM；Vue 管理布局/显隐，不重写这些逐帧样式。 */
    updateBridgeAnimation(element = this.$refs.bridgeIndicator) {
      if (!element || !this.isBridgeActive || !this.bridgeInfo || this.isDisposed || !this.visible || this.pauseUpdates) return
      let frame = bridgeAnimationFrames.get(this)
      if (frame?.element !== element) {
        frame = { element, particles: element.querySelectorAll('.bridge-particle'), aura: element.querySelector('.bridge-aura'),
          media: window.matchMedia?.('(prefers-reduced-motion: reduce)'), time: null, reduced: null }
        bridgeAnimationFrames.set(this, frame)
      }
      // matchMedia.matches 会跟随系统偏好变化，无需额外监听或动画时钟。
      if (frame.media?.matches) {
        if (!frame.reduced) element.style.setProperty('--bridge-color', 'var(--lyric-text)')
        frame.reduced = true
        frame.time = null
        return
      }
      frame.reduced = false
      const sampledTime = this.seekPreviewTime ?? this.previewTime ?? this.readPlaybackTime?.() ?? this.currentPlayTime
      const time = Number.isFinite(sampledTime) ? sampledTime : this.currentPlayTime
      if (frame.time === time && frame.bridge === this.bridgeInfo) return
      frame.time = time
      frame.bridge = this.bridgeInfo
      const motion = this.getBridgeMotion(time)
      const particles = this.getBridgeParticles(motion)
      frame.particles.forEach((particle, index) => {
        particle.style.transform = particles[index].transform
        particle.style.opacity = particles[index].opacity
      })
      if (frame.aura) {
        frame.aura.style.opacity = String(0.1 + motion.pulse * 0.08)
        frame.aura.style.transform = `scale(${0.8 + motion.pulse * 0.2})`
      }
      const progress = motion.elapsed / this.bridgeInfo.duration * 100
      element.style.setProperty('--bridge-color', `color-mix(in srgb, var(--lyric-text) 88%, ${this.getBridgeProgressColor(progress)})`)
    },

    /** 连续插值既有桥段主题色，作为光点的轻微染色，避免中点跳色。 */
    getBridgeProgressColor(value = this.bridgeProgress) {
      const progress = Math.max(0, Math.min(100, value))
      return progress <= 50
        ? `color-mix(in srgb, var(--lyric-bridge-green) ${100 - progress * 2}%, var(--lyric-bridge-yellow))`
        : `color-mix(in srgb, var(--lyric-bridge-yellow) ${200 - progress * 2}%, var(--lyric-bridge-red))`
    },

    /** 桥段占用中心的一行，已唱完的前句留在其上方；屏外行保留位置以承接跨行跳转。 */
    getLyricLineStyle(index) {
      const relativeIndex = this.getLyricRelativePosition(index)
      const distance = Math.abs(relativeIndex)
      const maxVisibleDistance = 8 // 最大可见距离
      const viewportWidth = this.viewportWidth
      const translateY = Math.max(-maxVisibleDistance - 1, Math.min(maxVisibleDistance + 1, relativeIndex)) * this.lyricLineHeight
      const isCurrent = !this.isBridgeActive && index === this.currentLyricIndex

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
        transition: this.lyricPointer?.dragging ? 'none' : this.lineTransitionDuration > 0
          ? `transform ${this.lineTransitionDuration}s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.3s ease, filter 0.3s ease` : 'none',
        pointerEvents: distance <= maxVisibleDistance && this.isLyricLineInteractive(index) ? 'auto' : 'none'
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
          const bytes = Uint8Array.from(atob(languageField), character => character.charCodeAt(0))
          decodedData = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
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

    /** 全屏与桌面共用时间轴；译文/发音按源行绑定后再排序，保留 offset 与重复时间标签。 */
    parseLyrics(lrcContent, rawLyricData = null) {
      this.resetLyricInteractions()
      this.translationData = null
      this.isNonChinese = this.detectNonChineseSong(this.song, lrcContent)
      const lines = parseDesktopLyrics(lrcContent, rawLyricData).filter(line => line.text.trim())
      this.parsedLyrics = lines.map(line => ({
        ...line,
        time: line.time / 1000,
        ...(line.duration != null ? { duration: line.duration / 1000 } : {}),
        ...(line.words ? { words: line.words.map(word => ({
          ...word, startTime: word.startTime / 1000, endTime: word.endTime / 1000, duration: word.duration / 1000
        })) } : {})
      }))
      this.hasTimedLyrics = this.parsedLyrics.length > 0
      if (!this.hasTimedLyrics) this.parsedLyrics = [{ time: 0, text: '暂无歌词' }]
      this.hasTranslation = this.parsedLyrics.some(line => Boolean(line.translation))
      this.showTranslation = this.translationPreferenceDraft ?? this.settingsStore?.settings?.playback?.showTranslation ?? true
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
          const text = translation[index]?.[0]
          if (typeof text === 'string' && text.trim()) {
            lyricLine.translation = text.trim()
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
          const chars = lyricSegmenter ? Array.from(lyricSegmenter.segment(cleanText), part => part.segment) : Array.from(cleanText)
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

    /** 按字素分配 KRC 词内时间；保留组合字符、emoji 和原始空格。 */
    getLyricCharacters(line) {
      if (lyricCharacters.has(line)) return lyricCharacters.get(line)
      const split = text => lyricSegmenter ? Array.from(lyricSegmenter.segment(text), part => part.segment) : Array.from(text)
      const characters = line.words?.length ? line.words.flatMap(word => {
        const letters = split(word.word)
        const duration = Math.max(0, word.endTime - word.startTime)
        return letters.map((text, index) => ({ text,
          start: word.startTime + duration * index / letters.length,
          end: word.startTime + duration * (index + 1) / letters.length }))
      }) : split(line.text).map(text => ({ text }))
      lyricCharacters.set(line, characters)
      return characters
    },

    /** DOM/尺寸缓存留在响应式状态外；换行、字体及窗口尺寸变化才重新测量。 */
    getLyricAnimationFrame() {
      let frame = lyricAnimationFrames.get(this)
      if (!frame) {
        frame = { entries: [], index: -1, line: null, container: null, text: null, layoutDirty: true, observer: null }
        lyricAnimationFrames.set(this, frame)
      }
      return frame
    },
    resetKaraokeCharacters() {
      const frame = lyricAnimationFrames.get(this)
      frame?.entries.forEach(entry => {
        entry.element.style.color = 'var(--lyric-line)'
        entry.element.dataset.fillState = ''
        entry.progress = null
      })
    },
    clearLyricAnimationFrame() {
      this.resetKaraokeCharacters()
      lyricAnimationFrames.get(this)?.observer?.disconnect()
      lyricAnimationFrames.delete(this)
    },

    /** 真实音频时间只更新当前行的填充边界；暂停/倒退立即重算，不改变字重或字形位置。 */
    updateKaraokeStylesDirectly(time = this.internalPlayTime) {
      const container = this.$refs.lyricsContainer
      if (!this.parsedLyrics.length || !container || !Number.isFinite(time)) return
      let low = 0
      let high = this.parsedLyrics.length
      while (low < high) {
        const middle = (low + high) >>> 1
        // 行和桥段共同沿公共位置切换，逐帧视觉采样不能提前改变行过渡状态。
        if (this.parsedLyrics[middle].time <= this.internalPlayTime) low = middle + 1
        else high = middle
      }
      const newIndex = this.isBridgeActive && this.bridgeInfo
        ? Math.max(0, this.bridgeInfo.startLyricIndex) : Math.max(0, low - 1)
      const frame = this.getLyricAnimationFrame()
      const line = this.parsedLyrics[newIndex]
      if (frame.index !== newIndex || frame.line !== line || frame.container !== container || !frame.entries.length) {
        this.resetKaraokeCharacters()
        frame.index = newIndex
        frame.line = line
        frame.container = container
        frame.entries = Array.from(container.querySelectorAll(`[data-line-index="${newIndex}"]`), element => ({ element, progress: null }))
      }
      if (newIndex !== this.currentLyricIndex) this.currentLyricIndex = newIndex
      if (this.isBridgeActive) return
      const nextTime = this.parsedLyrics[newIndex + 1]?.time ?? this.duration
      const count = this.getLyricCharacters(line).length
      const charDuration = count ? Math.max(0, nextTime - line.time) / count : 0
      frame.entries.forEach((entry, index) => {
        const { element } = entry
        const timed = element.dataset.start !== undefined
        const start = line.time + (timed ? Number(element.dataset.start) : index * charDuration)
        const end = timed ? line.time + Number(element.dataset.end) : start + charDuration
        const progress = time < start || (!timed && charDuration <= 0) ? 0
          : end > start ? Math.max(0, Math.min(1, (time - start) / (end - start))) : 1
        const fill = Math.round(progress * 1000) / 10
        const state = progress > 0 && progress < 1 ? 'singing' : ''
        if (entry.progress === fill && entry.state === state) return
        element.dataset.fillState = state
        element.style.color = progress >= 1 ? 'var(--lyric-accent)' : 'var(--lyric-pending)'
        element.style.setProperty('--fill-progress', `${fill}%`)
        entry.progress = fill
        entry.state = state
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

    /** 横移与逐字高亮共用真实播放时间，只在当前行或尺寸变化时读取布局。 */
    syncLongLyric(time = this.internalPlayTime) {
      const lineElement = this.lyricLineRefs[this.currentLyricIndex]
      const frame = this.getLyricAnimationFrame()
      if (frame.lineElement !== lineElement) {
        if (frame.text) frame.text.style.transform = ''
        frame.observer?.disconnect()
        frame.lineElement = lineElement
        frame.text = lineElement?.querySelector('.lyric-text')
        frame.viewport = lineElement?.querySelector('.main-lyric')
        frame.layoutDirty = true
        if (typeof ResizeObserver === 'function' && frame.text && frame.viewport) {
          frame.observer = new ResizeObserver(() => { frame.layoutDirty = true })
          frame.observer.observe(frame.text)
          frame.observer.observe(frame.viewport)
        }
      }
      const { text, viewport } = frame
      this.scrollingLyricElement = text || null
      const line = this.parsedLyrics[this.currentLyricIndex]
      if (!text || !viewport || !line) return
      if (frame.layoutDirty) {
        frame.overflow = Math.max(0, text.scrollWidth - viewport.clientWidth)
        frame.layoutDirty = false
      }
      const nextTime = this.parsedLyrics[this.currentLyricIndex + 1]?.time ?? this.duration
      const lastWord = line.words?.[line.words.length - 1]
      const endTime = lastWord?.endTime > 0 ? Math.min(nextTime, line.time + lastWord.endTime) : nextTime
      const lineDuration = endTime - line.time
      const progress = lineDuration > 0 ? Math.max(0, Math.min(1, (time - line.time) / lineDuration)) : 0
      const transform = 'translateX(' + (-frame.overflow * progress) + 'px)'
      if (text.style.transform !== transform) text.style.transform = transform
    },
    handleLongLyric() {
      this.getLyricAnimationFrame().layoutDirty = true
      this.$nextTick(() => {
        if (!this.isDisposed && this.visible) this.syncLongLyric()
      })
    },

    // 关闭歌词视图
    closeLyricView() {
      this.closeQualityMenu()
      this.resetLyricInteractions()
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
      await this.saveTranslationPreference()
    },
    /** 保存失败保留当前翻译显示并提供重试；旧请求不能覆盖新操作的反馈。 */
    async saveTranslationPreference() {
      const version = ++this.translationSaveVersion
      const desired = this.showTranslation
      this.translationPreferenceDraft = desired
      this.translationMessage = ''
      try {
        await this.settingsStore?.updateSettings?.({ playback: { showTranslation: desired } })
        if (!this.isDisposed && version === this.translationSaveVersion) this.translationPreferenceDraft = null
      } catch (error) {
        if (this.isDisposed || version !== this.translationSaveVersion) return
        this.translationMessage = '翻译偏好保存失败，请重试。'
        logger.warn('LyricView', '更新翻译设置失败', error)
      }
    },

    /** 每次拖动立即预览歌词位置与逐字状态，音频只在确认后跳转一次。 */
    previewSeek(event) {
      const time = Number(event.target.value)
      if (!Number.isFinite(time) || !Number.isFinite(this.duration) || this.duration <= 0 || this.isDisposed || this.pauseUpdates) return
      this.resetLyricInteractions()
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
      this.resetLyricInteractions()
      this.$emit('seek', target)
      this.syncPlaybackTime(target, true)
    },

    onWindowResize() {
      if (this.isDisposed) return
      this.closeQualityMenu()
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
