<template>
  <div class="daily-recommend-view list-page" :aria-busy="loading">
    <div class="list-content">
      <button type="button" class="back-btn" @click="handleBack">← 返回发现</button>
      <header class="collection-hero">
        <ArtworkCover :src="collectionCover" class="collection-art" mark="♪" />
        <div class="collection-copy">
          <p class="eyebrow">DAILY MIX / 每日精选</p>
          <h1 class="page-title">{{ selectedHistory ? '往期推荐' : '每日推荐' }}</h1>
          <p class="collection-description">每天都有新的旋律，陪你发现不期而遇的喜欢。</p>
          <div class="collection-meta"><span>{{ songs.length }} 首歌曲</span><span>{{ selectedHistory ? historyDates.find(item => historyKey(item) === selectedHistory)?.date : lastLoadedDate ? new Date(lastLoadedDate).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' }) : '每日更新' }}</span></div>
          <div class="collection-actions"><button type="button" class="play-all-btn" :disabled="songs.length === 0" @click="handlePlayAll"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>播放全部</button></div>
        </div>
      </header>
      <div class="history-toolbar"><button type="button" class="action-btn" @click="openHistory">{{ historyLoading ? '正在读取往期…' : '往期推荐' }}</button><label v-if="historyOpen">推荐日期 <select v-model="selectedHistory" @change="changeHistory"><option value="">今天</option><option v-for="item in historyDates" :key="historyKey(item)" :value="historyKey(item)">{{ item.date || item.history_name }}</option></select></label><span v-if="historyOpen && !historyLoading && !historyDates.length && !historyError">暂无可查看的往期</span><AppNotice :message="historyError" title="往期推荐加载失败" type="error" :actions="[{ label: '重试', run: loadHistoryDates, disabled: historyLoading }]" /></div>
      <div class="section-heading"><h2>曲目</h2><span>{{ selectedHistory ? '让好音乐再次相遇' : '今天，也让音乐陪你' }}</span></div>

      <AppNotice :message="error" title="曲目加载失败" type="error" :actions="[{ label: '重试', run: loadData, disabled: loading }]" />
      <Transition name="ui-fade" mode="out-in" @before-leave="$event.setAttribute('inert', '')" @before-enter="$event.removeAttribute('inert')" @leave-cancelled="$event.removeAttribute('inert')">
      <div v-if="loading && songs.length === 0" class="loading-container">
        <span class="loading-spinner" role="status" aria-label="加载中"></span>
        <p>加载中...</p>
      </div>

      <div v-else-if="error && songs.length === 0" class="empty-state">
        <button type="button" class="retry-btn" @click="loadData">重新加载</button>
      </div>

      <div v-else-if="songs.length === 0" class="empty">
        <svg viewBox="0 0 1024 1024" width="64" height="64" fill="currentColor" opacity="0.3">
          <path d="M923 283.6a260.04 260.04 0 00-56.9-82.8 264.4 264.4 0 00-84-55.5A265.34 265.34 0 00679.7 125c-49.3 0-97.4 13.5-139.2 39-10 6.1-19.5 12.8-28.5 20.1-9-7.3-18.5-14-28.5-20.1-41.8-25.5-89.9-39-139.2-39-35.5 0-69.9 6.8-102.4 20.3-31.4 13-59.7 31.7-84 55.5a258.44 258.44 0 00-56.9 82.8c-13.9 32.3-21 66.6-21 101.9 0 33.3 6.8 68 20.3 103.3 11.3 29.5 27.5 60.1 48.2 91 32.8 48.9 77.9 99.9 133.9 151.6 92.8 85.7 184.7 144.9 188.6 147.3l23.7 15.2c10.5 6.7 24 6.7 34.5 0l23.7-15.2c3.9-2.5 95.7-61.6 188.6-147.3 56-51.7 101.1-102.7 133.9-151.6 20.7-30.9 37-61.5 48.2-91 13.5-35.3 20.3-70 20.3-103.3.1-35.3-7-69.6-20.9-101.9z"/>
        </svg>
        <p>暂无推荐内容</p>
      </div>

      <div v-else class="song-list">
        <div class="list-header">
          <div class="col-index">#</div>
          <div class="col-title">歌曲</div>
          <div class="col-artist">歌手</div>
          <div class="col-album">专辑</div>
          <div class="col-duration">时长</div>
          <div class="col-actions-label"><span class="visually-hidden">操作</span></div>
        </div>

        <div
          v-for="(song, index) in songs"
          :key="song.hash"
          class="song-item"
          :class="{ playing: !!song.hash && currentSong?.hash === song.hash }" :aria-current="song.hash && currentSong?.hash === song.hash ? 'true' : undefined"
          @dblclick="handlePlay(song)"
        >
          <div class="col-index">
            <span class="index-number">{{ String(index + 1).padStart(2, '0') }}</span>
          </div>

          <div class="col-title">
            <ArtworkCover :src="song.sizable_cover || song.imgurl || song.album_img || ''" class="song-cover" />
            <div class="song-info">
              <div class="song-title-line">
                <button type="button" class="song-name" @click.stop="$emit('search', song)" @dblclick.stop :title="song.songname || song.filename || '未知歌曲'">{{ song.songname || song.filename }}</button>
                <SongBadges :song="song" />
              </div>
              <ArtistLinks class="artist-link mobile-artist" :song="song" @select="$emit('navigate', 'artist', $event)" />
            </div>
          </div>

    <div class="col-artist"><ArtistLinks class="artist-link" :song="song" @select="$emit('navigate', 'artist', $event)" /></div>
    <div class="col-album"><button type="button" class="album-link" @click.stop="goAlbum(song)" @dblclick.stop>{{ song.album_name || song.remark || '-' }}</button></div>
          <div class="col-duration">{{ formatDuration(song.duration || song.time_length) }}</div>
            <div class="action-buttons">
              <button type="button" class="icon-btn play-btn-inline" @click.stop="handlePlay(song)" title="播放" @dblclick.stop>
                <svg viewBox="0 0 1024 1024" width="16" height="16" fill="currentColor">
                  <path d="M719.4 499.1l-296.1-215A15.9 15.9 0 00398 297v430c0 13.1 14.8 20.5 25.3 12.9l296.1-215a15.9 15.9 0 000-25.8z"/>
                </svg>
              </button>
              <LibraryActions :song="song" />
            </div>
        </div>
      </div>
      </Transition>
    </div>
  </div>
</template>

<script>
import ArtworkCover from '../components/common/ArtworkCover.vue'
import SongBadges from '../components/common/SongBadges.vue'
import ArtistLinks from '../components/common/ArtistLinks.vue'
import LibraryActions from '../components/common/LibraryActions.vue'
import { logger } from '../utils/logger.js'

import { getEverydayRecommend } from '../api/music.js'
import { getEverydayHistory } from '../api/library.js'
import { extractLibraryList } from '../utils/libraryMetadata.js'
import { useSettingsStore } from '../stores/settingsStore.js'

function getAccountIdentity() {
  return JSON.stringify([
    localStorage.getItem('kugou_userid'),
    localStorage.getItem('kugou_token')
  ])
}

export default {
  components: { ArtworkCover, SongBadges, ArtistLinks, LibraryActions },
  name: 'DailyRecommendView',
  inject: { library: { from: 'musicLibrary', default: null } },
  emits: ['navigate', 'play', 'play-all', 'search', 'play-next', 'toggle-favorite', 'add-to-playlist', 'download', 'share', 'show-details'],
  props: {
    currentSong: {
      type: Object,
      default: null
    }
  },
  setup() {
    const { settings } = useSettingsStore()
    return { settings }
  },
  data() {
    return {
      loading: false,
      error: null,
      songs: [],
      isDisposed: false,
      requestIdentity: getAccountIdentity(),
      lastLoadedDate: '',
      refreshPending: false,
      selectedHistory: '', historyOpen: false, historyDates: [], historyLoading: false, historyError: '', historyLoaded: false, historyCache: {}, dailyRequestId: 0, historyController: null
    }
  },
  computed: {
    collectionCover() {
      const song = this.songs.find(item => item.sizable_cover || item.imgurl || item.album_img)
      return song?.sizable_cover || song?.imgurl || song?.album_img || ''
    }
  },
  mounted() {
    this.loadData()
  },
  activated() {
    if (!this.selectedHistory && this.lastLoadedDate && this.lastLoadedDate !== new Date().toDateString()) {
      this.loadData()
    }
  },
  beforeUnmount() {
    this.isDisposed = true
    this.dailyRequestId++; this.historyController?.abort()
  },
  methods: {
    isCurrentDailyRequest() {
      return !this.isDisposed && this.requestIdentity === getAccountIdentity()
    },
    // 同一天重用缓存；跨日激活刷新，旧日请求未结束时合并为一次后续刷新。
    async loadData() {
      if (!this.isCurrentDailyRequest()) return
      if (this.selectedHistory) return this.loadHistoricalData()
      const today = new Date().toDateString()
      if (this.loading) {
        if (this.lastLoadedDate !== today) this.refreshPending = true
        return
      }
      const requestId = ++this.dailyRequestId
      try {
        this.loading = true
        this.error = null
        this.lastLoadedDate = today
        const response = await getEverydayRecommend()
        if (!this.isCurrentDailyRequest() || requestId !== this.dailyRequestId) return
        logger.trace('DailyRecommendView', '每日推荐响应:', response)
        
        if (response.status === 1 && response.data) {
          this.songs = response.data.song_list || []
          this.historyCache.today = { date: today, songs: this.songs }
        } else {
          this.error = '加载失败'
        }
      } catch (error) {
        if (!this.isCurrentDailyRequest() || requestId !== this.dailyRequestId) return
        logger.error('DailyRecommendView', '加载每日推荐失败:', error)
        this.error = '加载失败，请重试'
      } finally {
        if (this.isCurrentDailyRequest() && requestId === this.dailyRequestId) {
          this.loading = false
          if (this.refreshPending) {
            this.refreshPending = false
            if (this.lastLoadedDate !== new Date().toDateString()) this.loadData()
          }
        }
      }
    },
    historyKey(item) { return `${item.date || ''}:${item.history_name || ''}` },
    openHistory() { this.historyOpen = !this.historyOpen; if (this.historyOpen && !this.historyLoaded) this.loadHistoryDates() },
    async loadHistoryDates() {
      if (this.historyLoading || !this.isCurrentDailyRequest()) return
      this.historyLoading = true; this.historyError = ''
      try {
        const response = await getEverydayHistory({ mode: 'list' })
        if (!this.isCurrentDailyRequest()) return
        this.historyDates = extractLibraryList(response, ['history_list', 'history']).filter(item => item.date && item.history_name)
        this.historyLoaded = true
      } catch (error) { if (this.isCurrentDailyRequest()) { this.historyError = error?.message || '往期推荐加载失败'; logger.error('DailyRecommendView', '读取推荐历史失败', error) } }
      finally { if (this.isCurrentDailyRequest()) this.historyLoading = false }
    },
    changeHistory() {
      this.dailyRequestId++; this.historyController?.abort(); this.loading = false; this.error = null
      const cached = this.selectedHistory ? this.historyCache[this.selectedHistory] : this.historyCache.today?.date === new Date().toDateString() ? this.historyCache.today.songs : null
      this.songs = cached || []
      if (!cached) this.loadData()
    },
    /** Historical requests are isolated by the server-issued date/name pair. */
    async loadHistoricalData() {
      const item = this.historyDates.find(entry => this.historyKey(entry) === this.selectedHistory)
      if (!item || this.loading || !this.isCurrentDailyRequest()) return
      const requestId = ++this.dailyRequestId; const controller = this.historyController = new AbortController()
      this.loading = true; this.error = null
      try {
        const response = await getEverydayHistory({ mode: 'song', history_name: item.history_name, date: item.date }, { signal: controller.signal })
        if (!this.isCurrentDailyRequest() || requestId !== this.dailyRequestId) return
        const groups = extractLibraryList(response)
        const group = groups.find(entry => entry.date === item.date && entry.history_name === item.history_name) || groups[0]
        this.songs = Array.isArray(group?.song_list) ? group.song_list : groups
        this.historyCache[this.selectedHistory] = this.songs
      } catch (error) { if (this.isCurrentDailyRequest() && requestId === this.dailyRequestId && !controller.signal.aborted) { this.error = error?.message || '往期推荐加载失败，请重试'; logger.error('DailyRecommendView', '读取往期曲目失败', error) } }
      finally { if (this.isCurrentDailyRequest() && requestId === this.dailyRequestId) this.loading = false }
    },
    goAlbum(song) {
      const id =
        song.album_id ||
        song.albumid ||
        song.AlbumID ||
        song.base?.album_id ||
        song.album?.id ||
        song.album_info?.album_id ||
        song.album_info?.id ||
        null
      const name = song.album_name || song.remark || song.album_info?.album_name || null
      if (id || name) this.$emit('navigate', 'album', { id, name })
    },
    
    handleBack() {
      this.$emit('navigate', 'home')
    },
    
    handlePlay(song) {
      logger.trace('DailyRecommendView', '[DailyRecommend] handlePlay调用:', song)
      logger.trace('DailyRecommendView', '[DailyRecommend] 设置 - enqueueFullPlaylist:', this.settings?.playback?.enqueueFullPlaylist)
      
      // 规范化歌曲数据字段
      const normalizedSong = {
        ...song,
        name: song.songname || song.filename || song.name,
        singername: song.author_name || song.singername,
        author_name: song.author_name || song.singername,
        cover: song.sizable_cover || song.imgurl || song.album_img,
        album_name: song.album_name || song.remark,
        timelen: Number(song.timelen) || Number(song.duration || song.time_length || 0) * 1000
      }
      
      // 检查是否开启了"自动将全部歌单歌曲加入播放列表"功能
      if (this.settings?.playback?.enqueueFullPlaylist && this.songs.length > 0) {
        logger.trace('DailyRecommendView', '[DailyRecommend] 自动加入全部歌曲到播放列表')
        // 找到当前歌曲在列表中的索引
        const songIndex = this.songs.findIndex(s => s.hash === song.hash)
        
        if (songIndex !== -1) {
          // 规范化所有歌曲数据
          const normalizedSongs = this.songs.map(s => ({
            ...s,
            name: s.songname || s.filename || s.name,
            singername: s.author_name || s.singername,
            author_name: s.author_name || s.singername,
            cover: s.sizable_cover || s.imgurl || s.album_img,
            album_name: s.album_name || s.remark,
            timelen: Number(s.timelen) || Number(s.duration || s.time_length || 0) * 1000
          }))
          
          // 重新排列歌单,让当前歌曲排在第一位
          const reorderedList = [
            normalizedSongs[songIndex],
            ...normalizedSongs.slice(0, songIndex),
            ...normalizedSongs.slice(songIndex + 1)
          ]
          this.$emit('play-all', reorderedList)
        } else {
          // 如果找不到,就正常播放全部
          const normalizedSongs = this.songs.map(s => ({
            ...s,
            name: s.songname || s.filename || s.name,
            singername: s.author_name || s.singername,
            author_name: s.author_name || s.singername,
            cover: s.sizable_cover || s.imgurl || s.album_img,
            album_name: s.album_name || s.remark,
            timelen: Number(s.timelen) || Number(s.duration || s.time_length || 0) * 1000
          }))
          this.$emit('play-all', normalizedSongs)
        }
      } else {
        // 只播放单曲
        this.$emit('play', normalizedSong)
      }
    },
    
    handlePlayAll() {
      logger.trace('DailyRecommendView', '[DailyRecommend] 播放全部')
      // 规范化所有歌曲数据字段
      const normalizedSongs = this.songs.map(song => ({
        ...song,
        name: song.songname || song.filename || song.name,
        singername: song.author_name || song.singername,
        author_name: song.author_name || song.singername,
        cover: song.sizable_cover || song.imgurl || song.album_img,
        album_name: song.album_name || song.remark,
        timelen: Number(song.timelen) || Number(song.duration || song.time_length || 0) * 1000
      }))
      this.$emit('play-all', normalizedSongs)
    },
    
    formatDuration(seconds) {
      if (!seconds) return '--:--'
      const minutes = Math.floor(seconds / 60)
      const secs = Math.floor(seconds % 60)
      return `${minutes}:${secs.toString().padStart(2, '0')}`
    },
    
    fixImgUrl(url) {
      if (!url) return ''
      return url.replace('{size}', '150')
    }
  }
}
</script>

<style src="./styles/ListPage.css" scoped></style>
<style scoped>
.history-toolbar{display:flex;flex-wrap:wrap;gap:14px;align-items:center;margin:20px 0;font-size:13px;color:var(--color-text-secondary)}.history-toolbar select{background:var(--color-background);color:var(--color-text);border:1px solid var(--color-border);padding:8px;border-radius:8px;margin-left:8px}
</style>
