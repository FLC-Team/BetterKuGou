<template>
  <div class="personal-fm-view">
    <div class="header">
      <button class="back-btn" @click="handleBack">
        <svg viewBox="0 0 1024 1024" width="20" height="20" fill="currentColor">
          <path d="M724 218.3V141c0-6.7-7.7-10.4-12.9-6.3L260.3 486.8a31.86 31.86 0 000 50.3l450.8 352.1c5.3 4.1 12.9.4 12.9-6.3v-77.3c0-4.9-2.3-9.6-6.1-12.6l-360-281 360-281.1c3.8-3 6.1-7.7 6.1-12.6z"/>
        </svg>
        返回
      </button>
      <h1 class="page-title">私人 FM</h1>
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
      <p>暂无推荐内容</p>
    </div>

    <div v-else class="song-list">
      <div 
        v-for="song in songs" 
        :key="song.hash"
        class="song-item"
        @click="handlePlay(song)"
      >
        <div class="song-cover">
          <img v-if="song.imgurl" :src="fixImgUrl(song.imgurl || song.album_img)" :alt="song.songname" />
          <div class="play-icon">
            <svg viewBox="0 0 1024 1024" width="32" height="32" fill="white">
              <path d="M719.4 499.1l-296.1-215A15.9 15.9 0 00398 297v430c0 13.1 14.8 20.5 25.3 12.9l296.1-215a15.9 15.9 0 000-25.8z"/>
            </svg>
          </div>
        </div>
        <div class="song-info">
          <h4 class="song-name">{{ song.songname || song.filename }}</h4>
          <p class="song-artist"><span class="artist-link" @click.stop="goArtist(song)">{{ song.singername || song.author_name || '未知歌手' }}</span></p>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import { logger } from '../utils/logger.js'

import { getPersonalFM } from '../api/music.js'
import { useSettingsStore } from '../stores/settingsStore.js'

export default {
  name: 'PersonalFMView',
  emits: ['navigate', 'play'],
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
      songs: []
    }
  },
  mounted() {
    this.loadData()
  },
  methods: {
    async loadData() {
      try {
        this.loading = true
        this.error = null
        const response = await getPersonalFM()
        logger.trace('PersonalFMView', '私人FM响应:', response)
        
        if (response.status === 1 && response.data) {
          this.songs = response.data.list || []
        } else {
          this.error = '加载失败'
        }
      } catch (error) {
        logger.error('PersonalFMView', '加载私人FM失败:', error)
        this.error = '加载失败，请重试'
      } finally {
        this.loading = false
      }
    },
    goArtist(song) {
      const id = song.SingerId || song.singerid || song.AuthorId || song.author_id || null
      const name = song.singername || song.author_name || null
      if (id || name) this.$emit('navigate', 'artist', { id, name })
    },
    
    handleBack() {
      this.$emit('navigate', 'home')
    },
    
    handlePlay(song) {
      logger.trace('PersonalFMView', '[PersonalFM] handlePlay调用:', song)
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
      this.$emit('play', normalizedSong)
    },
    
    fixImgUrl(url) {
      if (!url) return ''
      return url.replace('{size}', '150')
    }
  }
}
</script>

<style scoped>
.personal-fm-view {
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
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: var(--spacing-lg);
}

.song-item {
  cursor: pointer;
  transition: all var(--transition-base);
}

.song-item:hover {
  transform: translateY(-4px);
}

.song-cover {
  position: relative;
  width: 100%;
  padding-bottom: 100%;
  border-radius: var(--radius-md);
  overflow: hidden;
  background: var(--color-background-lighter);
  margin-bottom: var(--spacing-sm);
}

.song-cover img {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.play-icon {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-overlay);
  opacity: 0;
  transition: opacity var(--transition-fast);
}

.song-item:hover .play-icon {
  opacity: 1;
}

.song-info {
  padding: 0 var(--spacing-xs);
}

.song-name {
  font-size: var(--font-size-base);
  font-weight: 500;
  color: var(--color-text);
  margin-bottom: var(--spacing-xs);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.song-artist {
  font-size: var(--font-size-sm);
  color: var(--color-text-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.artist-link { cursor: pointer; }
.artist-link:hover { color: var(--color-primary); text-decoration: underline; }
</style>
