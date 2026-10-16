<template>
  <div class="daily-recommend-view list-page" :aria-busy="loading">
    <div class="list-content">
      <button type="button" class="back-btn" @click="handleBack">← 返回发现</button>
      <header class="collection-hero">
        <ArtworkCover :src="collectionCover" class="collection-art" mark="♪" />
        <div class="collection-copy">
          <p class="eyebrow">DAILY MIX / 每日精选</p>
          <h1 class="page-title">每日推荐</h1>
          <p class="collection-description">每天都有新的旋律，陪你发现不期而遇的喜欢。</p>
          <div class="collection-meta"><span>{{ songs.length }} 首歌曲</span><span>{{ lastLoadedDate ? new Date(lastLoadedDate).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' }) : '每日更新' }}</span></div>
          <div class="collection-actions"><button type="button" class="play-all-btn" :disabled="songs.length === 0" @click="handlePlayAll"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>播放全部</button></div>
        </div>
      </header>
      <div class="section-heading"><h2>曲目</h2><span>今天，也让音乐陪你</span></div>

      <div v-if="error && songs.length > 0" class="refresh-error" role="alert"><span>{{ error }}</span><button type="button" class="retry-btn" @click="loadData">重试</button></div>
      <div v-if="loading && songs.length === 0" class="loading-container">
        <span class="loading-spinner" role="status" aria-label="加载中"></span>
        <p>加载中...</p>
      </div>

      <div v-else-if="error && songs.length === 0" class="error" role="alert">
        <svg viewBox="0 0 1024 1024" width="64" height="64" fill="currentColor" opacity="0.3">
          <path d="M512 64C264.6 64 64 264.6 64 512s200.6 448 448 448 448-200.6 448-448S759.4 64 512 64zm0 820c-205.4 0-372-166.6-372-372s166.6-372 372-372 372 166.6 372 372-166.6 372-372 372z"/>
          <path d="M464 688a48 48 0 1096 0 48 48 0 10-96 0zm8-336h48c4.4 0 8 3.6 8 8v272c0 4.4-3.6 8-8 8h-48c-4.4 0-8-3.6-8-8V360c0-4.4 3.6-8 8-8z"/>
        </svg>
        <p>{{ error }}</p>
        <button type="button" class="retry-btn" @click="loadData">重试</button>
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
              <button type="button" class="artist-link mobile-artist" @click.stop="goArtist(song)" @dblclick.stop>{{ song.author_name || song.singername || '未知歌手' }}</button>
            </div>
          </div>

    <div class="col-artist"><button type="button" class="artist-link" @click.stop="goArtist(song)" @dblclick.stop>{{ song.author_name || song.singername || '未知歌手' }}</button></div>
    <div class="col-album"><button type="button" class="album-link" @click.stop="goAlbum(song)" @dblclick.stop>{{ song.album_name || song.remark || '-' }}</button></div>
          <div class="col-duration">{{ formatDuration(song.duration || song.time_length) }}</div>
            <div class="action-buttons">
              <button type="button" class="icon-btn play-btn-inline" @click.stop="handlePlay(song)" title="播放" @dblclick.stop>
                <svg viewBox="0 0 1024 1024" width="16" height="16" fill="currentColor">
                  <path d="M719.4 499.1l-296.1-215A15.9 15.9 0 00398 297v430c0 13.1 14.8 20.5 25.3 12.9l296.1-215a15.9 15.9 0 000-25.8z"/>
                </svg>
              </button>
            </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import ArtworkCover from '../components/common/ArtworkCover.vue'
import SongBadges from '../components/common/SongBadges.vue'
import { logger } from '../utils/logger.js'

import { getEverydayRecommend } from '../api/music.js'
import { useSettingsStore } from '../stores/settingsStore.js'

function getAccountIdentity() {
  return JSON.stringify([
    localStorage.getItem('kugou_userid'),
    localStorage.getItem('kugou_token')
  ])
}

export default {
  components: { ArtworkCover, SongBadges },
  name: 'DailyRecommendView',
  emits: ['navigate', 'play', 'play-all', 'search'],
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
      refreshPending: false
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
    if (this.lastLoadedDate && this.lastLoadedDate !== new Date().toDateString()) {
      this.loadData()
    }
  },
  beforeUnmount() {
    this.isDisposed = true
  },
  methods: {
    isCurrentDailyRequest() {
      return !this.isDisposed && this.requestIdentity === getAccountIdentity()
    },
    // 同一天重用缓存；跨日激活刷新，旧日请求未结束时合并为一次后续刷新。
    async loadData() {
      if (!this.isCurrentDailyRequest()) return
      const today = new Date().toDateString()
      if (this.loading) {
        if (this.lastLoadedDate !== today) this.refreshPending = true
        return
      }
      try {
        this.loading = true
        this.error = null
        this.lastLoadedDate = today
        const response = await getEverydayRecommend()
        if (!this.isCurrentDailyRequest()) return
        logger.trace('DailyRecommendView', '每日推荐响应:', response)
        
        if (response.status === 1 && response.data) {
          this.songs = response.data.song_list || []
        } else {
          this.error = '加载失败'
        }
      } catch (error) {
        if (!this.isCurrentDailyRequest()) return
        logger.error('DailyRecommendView', '加载每日推荐失败:', error)
        this.error = '加载失败，请重试'
      } finally {
        if (this.isCurrentDailyRequest()) {
          this.loading = false
          if (this.refreshPending) {
            this.refreshPending = false
            if (this.lastLoadedDate !== new Date().toDateString()) this.loadData()
          }
        }
      }
    },
    goArtist(song) {
      const id = song.AuthorId || song.author_id || song.SingerId || song.singerid || null
      const name = song.author_name || song.singername || null
      if (id || name) this.$emit('navigate', 'artist', { id, name })
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
        timelen: song.duration || song.time_length || song.timelen
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
            timelen: s.duration || s.time_length || s.timelen
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
            timelen: s.duration || s.time_length || s.timelen
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
        timelen: song.duration || song.time_length || song.timelen
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
