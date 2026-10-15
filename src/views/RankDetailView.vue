<template>
  <div class="rank-detail-view">
    <div class="header">
      <button class="back-btn" @click="handleBack">
        <svg viewBox="0 0 1024 1024" width="20" height="20" fill="currentColor">
          <path d="M724 218.3V141c0-6.7-7.7-10.4-12.9-6.3L260.3 486.8a31.86 31.86 0 000 50.3l450.8 352.1c5.3 4.1 12.9.4 12.9-6.3v-77.3c0-4.9-2.3-9.6-6.1-12.6l-360-281 360-281.1c3.8-3 6.1-7.7 6.1-12.6z"/>
        </svg>
        返回
      </button>
      <h1 class="page-title">{{ rankInfo?.rankname || '排行榜' }}</h1>
      <button v-if="!loading && songs.length > 0" class="play-all-btn" @click="handlePlayAll">
        <svg viewBox="0 0 1024 1024" width="18" height="18" fill="currentColor">
          <path d="M512 64C264.6 64 64 264.6 64 512s200.6 448 448 448 448-200.6 448-448S759.4 64 512 64zm0 820c-205.4 0-372-166.6-372-372s166.6-372 372-372 372 166.6 372 372-166.6 372-372 372z"/>
          <path d="M719.4 499.1l-296.1-215A15.9 15.9 0 00398 297v430c0 13.1 14.8 20.5 25.3 12.9l296.1-215a15.9 15.9 0 000-25.8zm-257.6 134V390.9L628.5 512 461.8 633.1z"/>
        </svg>
        播放全部
      </button>
    </div>

    <div v-if="loading" class="loading-container">
      <span class="loading-spinner" role="status" aria-label="加载中"></span>
      <p>加载中...</p>
    </div>

    <div v-else-if="error" class="error">
      <svg viewBox="0 0 1024 1024" width="64" height="64" fill="currentColor" opacity="0.3">
        <path d="M512 64C264.6 64 64 264.6 64 512s200.6 448 448 448 448-200.6 448-448S759.4 64 512 64zm0 820c-205.4 0-372-166.6-372-372s166.6-372 372-372 372 166.6 372 372-166.6 372-372 372z"/>
        <path d="M464 688a48 48 0 1096 0 48 48 0 10-96 0zm8-336h48c4.4 0 8 3.6 8 8v272c0 4.4-3.6 8-8 8h-48c-4.4 0-8-3.6-8-8V360c0-4.4 3.6-8 8-8z"/>
      </svg>
      <p>{{ error }}</p>
      <button class="retry-btn" @click="loadData">重试</button>
    </div>

    <div v-else-if="songs.length === 0" class="empty">
      <svg viewBox="0 0 1024 1024" width="64" height="64" fill="currentColor" opacity="0.3">
        <path d="M923 283.6a260.04 260.04 0 00-56.9-82.8 264.4 264.4 0 00-84-55.5A265.34 265.34 0 00679.7 125c-49.3 0-97.4 13.5-139.2 39-10 6.1-19.5 12.8-28.5 20.1-9-7.3-18.5-14-28.5-20.1-41.8-25.5-89.9-39-139.2-39-35.5 0-69.9 6.8-102.4 20.3-31.4 13-59.7 31.7-84 55.5a258.44 258.44 0 00-56.9 82.8c-13.9 32.3-21 66.6-21 101.9 0 33.3 6.8 68 20.3 103.3 11.3 29.5 27.5 60.1 48.2 91 32.8 48.9 77.9 99.9 133.9 151.6 92.8 85.7 184.7 144.9 188.6 147.3l23.7 15.2c10.5 6.7 24 6.7 34.5 0l23.7-15.2c3.9-2.5 95.7-61.6 188.6-147.3 56-51.7 101.1-102.7 133.9-151.6 20.7-30.9 37-61.5 48.2-91 13.5-35.3 20.3-70 20.3-103.3.1-35.3-7-69.6-20.9-101.9z"/>
      </svg>
      <p>暂无榜单内容</p>
    </div>

    <div v-else class="song-list">
      <div class="list-header">
        <div class="col-index">#</div>
        <div class="col-title">歌曲</div>
        <div class="col-artist">歌手</div>
        <div class="col-album">专辑</div>
        <div class="col-duration">时长</div>
      </div>

      <div 
        v-for="(song, index) in songs" 
        :key="song.hash"
        class="song-item"
        :class="{ 'top-three': index < 3 }"
        @dblclick="handlePlay(song)"
      >
        <div class="col-index">
          <span class="index-number" :class="{ 'gold': index === 0, 'silver': index === 1, 'bronze': index === 2 }">
            {{ index + 1 }}
          </span>
        </div>

        <div class="col-title">
          <img v-if="song.imgurl" :src="fixImgUrl(song.imgurl || song.album_img)" class="song-cover" :alt="song.songname" />
          <div class="song-info">
            <div class="song-name">{{ song.songname || song.filename }}</div>
          </div>
        </div>

        <div class="col-artist">
          <span class="artist-link" @click.stop="goArtist(song)">{{ song.author_name || song.singername || '未知歌手' }}</span>
        </div>
        <div class="col-album">
          <span class="album-link" @click.stop="goAlbum(song)">{{ song.album_name || song.remark || '-' }}</span>
        </div>
        <div class="col-duration">
          {{ formatDuration(song.duration) }}
          <div class="action-buttons">
            <button class="icon-btn play-btn-inline" @click.stop="handlePlay(song)" title="播放">
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
import { logger } from '../utils/logger.js'

import { getRankInfo } from '../api/music.js'
import { useSettingsStore } from '../stores/settingsStore.js'

export default {
  name: 'RankDetailView',
  props: {
    rankData: {
      type: Object,
      required: true
    },
    currentSong: {
      type: Object,
      default: null
    }
  },
  emits: ['navigate', 'play', 'play-all'],
  setup() {
    const { settings } = useSettingsStore()
    return { settings }
  },
  data() {
    return {
      loading: false,
      error: null,
      songs: [],
      rankInfo: null
    }
  },
  mounted() {
    this.rankInfo = this.rankData
    this.loadData()
  },
  methods: {
    async loadData() {
      try {
        this.loading = true
        this.error = null
        const response = await getRankInfo(this.rankData.rankid, 1, 100)
        logger.trace('RankDetailView', '排行榜详情响应:', response)
        
        if (response.status === 1 && response.data) {
          this.songs = response.data.songs?.list || response.data.info || []
        } else {
          this.error = '加载失败'
        }
      } catch (error) {
        logger.error('RankDetailView', '加载排行榜详情失败:', error)
        this.error = '加载失败，请重试'
      } finally {
        this.loading = false
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
      logger.trace('RankDetailView', '[RankDetail] handlePlay调用:', song)
      logger.trace('RankDetailView', '[RankDetail] 设置 - enqueueFullPlaylist:', this.settings?.playback?.enqueueFullPlaylist)
      
      // 规范化歌曲数据字段
      const normalizedSong = {
        ...song,
        name: song.songname || song.filename || song.name,
        singername: song.author_name || song.singername,
        author_name: song.author_name || song.singername,
        cover: song.imgurl || song.album_img,
        album_name: song.album_name || song.remark,
        timelen: song.duration || song.time_length || song.timelen
      }
      
      // 检查是否开启了"自动将全部歌单歌曲加入播放列表"功能
      if (this.settings?.playback?.enqueueFullPlaylist && this.songs.length > 0) {
        logger.trace('RankDetailView', '[RankDetail] 自动加入全部歌曲到播放列表')
        const songIndex = this.songs.findIndex(s => s.hash === song.hash)
        
        if (songIndex !== -1) {
          const normalizedSongs = this.songs.map(s => ({
            ...s,
            name: s.songname || s.filename || s.name,
            singername: s.author_name || s.singername,
            author_name: s.author_name || s.singername,
            cover: s.imgurl || s.album_img,
            album_name: s.album_name || s.remark,
            timelen: s.duration || s.time_length || s.timelen
          }))
          
          const reorderedList = [
            normalizedSongs[songIndex],
            ...normalizedSongs.slice(0, songIndex),
            ...normalizedSongs.slice(songIndex + 1)
          ]
          this.$emit('play-all', reorderedList)
        } else {
          const normalizedSongs = this.songs.map(s => ({
            ...s,
            name: s.songname || s.filename || s.name,
            singername: s.author_name || s.singername,
            author_name: s.author_name || s.singername,
            cover: s.imgurl || s.album_img,
            album_name: s.album_name || s.remark,
            timelen: s.duration || s.time_length || s.timelen
          }))
          this.$emit('play-all', normalizedSongs)
        }
      } else {
        this.$emit('play', normalizedSong)
      }
    },
    
    handlePlayAll() {
      logger.trace('RankDetailView', '[RankDetail] 播放全部')
      const normalizedSongs = this.songs.map(song => ({
        ...song,
        name: song.songname || song.filename || song.name,
        singername: song.author_name || song.singername,
        author_name: song.author_name || song.singername,
        cover: song.imgurl || song.album_img,
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

<style scoped>
.rank-detail-view {
  padding: var(--spacing-xl);
  max-width: 1400px;
  margin: 0 auto;
}

.header {
  display: flex;
  align-items: center;
  gap: var(--spacing-lg);
  margin-bottom: var(--spacing-xl);
}

.back-btn {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
  padding: var(--spacing-sm) var(--spacing-md);
  background: var(--color-background-light);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  color: var(--color-text);
  font-size: var(--font-size-sm);
  cursor: pointer;
  transition: all var(--transition-fast);
}

.back-btn:hover {
  border-color: var(--color-primary);
  color: var(--color-primary);
}

.page-title {
  flex: 1;
  font-size: var(--font-size-2xl);
  font-weight: 600;
  color: var(--color-text);
  margin: 0;
}

.play-all-btn {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  padding: var(--spacing-md) var(--spacing-lg);
  background: var(--gradient-primary);
  color: var(--color-on-primary);
  border: none;
  border-radius: var(--radius-md);
  font-size: var(--font-size-base);
  font-weight: 500;
  cursor: pointer;
  transition: all var(--transition-fast);
  box-shadow: var(--shadow-button);
}

.play-all-btn:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-button-hover);
}

.loading-container {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: var(--spacing-xl) 0;
  color: var(--color-text-secondary);
}

.loading-gif {
  width: 60px;
  height: 60px;
  margin-bottom: var(--spacing-md);
}

.error,
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: var(--spacing-xl) 0;
  color: var(--color-text-secondary);
  text-align: center;
}

.error svg,
.empty svg {
  margin-bottom: var(--spacing-md);
}

.retry-btn {
  margin-top: var(--spacing-lg);
  padding: var(--spacing-sm) var(--spacing-lg);
  background: var(--color-background-light);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  color: var(--color-text);
  font-size: var(--font-size-sm);
  cursor: pointer;
  transition: all var(--transition-fast);
}

.retry-btn:hover {
  border-color: var(--color-primary);
  color: var(--color-primary);
}

.song-list {
  background: var(--color-background-light);
  border-radius: var(--radius-lg);
  overflow: hidden;
}

.list-header,
.song-item {
  display: grid;
  grid-template-columns: 60px 1fr 200px 200px 120px;
  gap: var(--spacing-md);
  align-items: center;
  padding: var(--spacing-md) var(--spacing-lg);
}

.list-header {
  font-size: var(--font-size-sm);
  color: var(--color-text-tertiary);
  border-bottom: 1px solid var(--color-border);
  font-weight: 500;
}

.song-item {
  border-bottom: 1px solid var(--color-border);
  transition: background var(--transition-fast);
  cursor: pointer;
}

.song-item:last-child {
  border-bottom: none;
}

.song-item:hover {
  background: var(--color-background);
}

.song-item.top-three {
  background: var(--bg-focus-light);
}

.col-index {
  display: flex;
  align-items: center;
  justify-content: center;
}

.index-number {
  color: var(--color-text-tertiary);
  font-size: var(--font-size-sm);
  font-weight: 600;
}

.index-number.gold {
  color: var(--rank-gold);
  font-size: var(--font-size-lg);
}

.index-number.silver {
  color: var(--rank-silver);
  font-size: var(--font-size-lg);
}

.index-number.bronze {
  color: var(--rank-bronze);
  font-size: var(--font-size-lg);
}

.col-title {
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
  min-width: 0;
}

.song-cover {
  width: 40px;
  height: 40px;
  border-radius: var(--radius-sm);
  object-fit: cover;
  flex-shrink: 0;
}

.song-info {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  min-width: 0;
  flex: 1;
}

.song-name {
  color: var(--color-text);
  font-size: var(--font-size-sm);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.col-artist,
.col-album {
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.col-duration {
  color: var(--color-text-tertiary);
  font-size: var(--font-size-sm);
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.artist-link { cursor: pointer; }
.artist-link:hover { color: var(--color-primary); text-decoration: underline; }
.album-link { cursor: pointer; }
.album-link:hover { color: var(--color-primary); text-decoration: underline; }

.action-buttons {
  display: flex;
  gap: var(--spacing-sm);
  opacity: 0;
  transition: opacity var(--transition-fast);
}

.song-item:hover .action-buttons {
  opacity: 1;
}

.icon-btn {
  width: 32px;
  height: 32px;
  border: none;
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: all var(--transition-fast);
  border-radius: var(--radius-sm);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
}

.icon-btn:hover {
  background: var(--color-background);
  color: var(--color-text);
}

.play-btn-inline {
  color: var(--color-text);
}

.play-btn-inline:hover {
  color: var(--color-primary);
  transform: scale(1.1);
}
</style>
